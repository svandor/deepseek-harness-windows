<#
.SYNOPSIS
    Autostart-duplikátumok keresése (Run kulcsok + Startup mappa).

.DESCRIPTION
    MIÉRT: a Local AI Bridge 2026-11-13-án **kétszer** indult, mert ugyanaz a
    parancs két csatornán szerepelt: a Startup mappában egy `.lnk`, és a
    `HKCU\...\Run` kulcsban ugyanaz a `wscript.exe … tray-launch.vbs` hívás.
    A „javítás” egy átnevezés volt (`…lnk.disabled-2026-11-13`), amit a Windows
    NEM ismer: a Startup mappa minden fájlját megnyitja, ezért bejelentkezéskor
    „Alkalmazás kiválasztása” ablak jött. Ez a szkript ezt a hibaosztályt
    detektálja, mielőtt kárt okoz.

    MIT VIZSGÁL:
      - `HKCU` és `HKLM` `Run` / `RunOnce` értékei,
      - a felhasználói Startup mappa `.lnk` fájljai (cél + argumentum),
      - a Startup mappában maradt `*.disabled*` / `*.off` / `*.bak` fájlok
        (ezeket a Windows MEGNYITJA — ez maga a hiba),
      - a futó folyamatok között ugyanaz a szkript kétszer.

.PARAMETER Json
    Gépi feldolgozásra alkalmas kimenet.

.EXAMPLE
    pwsh -NoProfile -File tools\check-autostart-duplicates.ps1
#>
[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'

function Get-RunEntries {
    param([string]$Hive)
    $result = @()
    foreach ($path in @("$Hive`:\Software\Microsoft\Windows\CurrentVersion\Run", "$Hive`:\Software\Microsoft\Windows\CurrentVersion\RunOnce")) {
        if (-not (Test-Path $path)) { continue }
        try {
            $item = Get-ItemProperty $path
            foreach ($prop in $item.PSObject.Properties) {
                if ($prop.Name -like 'PS*') { continue }
                $result += [pscustomobject]@{
                    source   = $path
                    name     = $prop.Name
                    command  = [string]$prop.Value
                }
            }
        } catch {
            # egy olvashatatlan kulcs nem állíthatja meg a vizsgálatot
        }
    }
    return $result
}

function Get-ShortcutTarget {
    param([string]$Path)
    try {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($Path)
        return [pscustomobject]@{ target = $lnk.TargetPath; arguments = $lnk.Arguments; workdir = $lnk.WorkingDirectory }
    } catch {
        return [pscustomobject]@{ target = ''; arguments = ''; workdir = '' }
    }
}

function Get-Signature {
    param([string]$Command)
    if ([string]::IsNullOrWhiteSpace($Command)) { return '' }
    $expanded = [Environment]::ExpandEnvironmentVariables($Command).Trim()
    # a `wscript.exe //nologo "..."` és a `"C:\...\app.exe" --arg` alakokat
    # egyetlen összehasonlítható alakra hozzuk
    $normalized = $expanded -replace '\s+', ' '
    return $normalized.ToLowerInvariant()
}

$entries = @()
$entries += Get-RunEntries -Hive 'HKCU'
$entries += Get-RunEntries -Hive 'HKLM'

$startup = [Environment]::GetFolderPath('Startup')
$strayFiles = @()
$shortcutProblems = @()
if (Test-Path $startup) {
    foreach ($file in Get-ChildItem $startup -Force -File) {
        if ($file.Name -eq 'desktop.ini') { continue }
        if ($file.Extension -ieq '.lnk') {
            $info = Get-ShortcutTarget -Path $file.FullName
            if ([string]::IsNullOrWhiteSpace($info.target)) {
                $shortcutProblems += $file.Name
                continue
            }
            $command = '"' + $info.target + '"'
            if (-not [string]::IsNullOrWhiteSpace($info.arguments)) { $command += ' ' + $info.arguments }
            $entries += [pscustomobject]@{
                source  = "Startup: $($file.Name)"
                name    = $file.BaseName
                command = $command
            }
        } else {
            # NEM .lnk fájl a Startup mappában: a Windows megpróbálja megnyitni
            $strayFiles += $file.Name
        }
    }
}

# --- duplikátumok: azonos parancs két csatornán ---
$bySignature = @{}
foreach ($entry in $entries) {
    $sig = Get-Signature -Command $entry.command
    if ($sig -eq '') { continue }
    if (-not $bySignature.ContainsKey($sig)) { $bySignature[$sig] = @() }
    $bySignature[$sig] += $entry
}
$duplicates = @()
foreach ($sig in $bySignature.Keys) {
    if ($bySignature[$sig].Count -gt 1) {
        $duplicates += [pscustomobject]@{
            command = $sig
            sources = @($bySignature[$sig] | ForEach-Object { "$($_.source) [$($_.name)]" })
        }
    }
}

# --- futó duplikátumok: ugyanaz a LAUNCHER-SZKRIPT többször ---
# Csak szkriptet nézünk (.vbs/.mjs/.cjs/.js): a .exe-t kihagyjuk, mert a
# nginx/php-cgi/thunderbird/Herd/NVIDIA-hoz hasonló alkalmazások SZÁNDÉKOSAN
# futnak több példányban (munkások/segédfolyamatok), és a jelzésük hamis zaj.
$runningDuplicates = @()
$bridgeInstalls = @()
try {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -ne $null }
    $byScript = @{}
    foreach ($proc in $procs) {
        # Csak a LAUNCHERT nézzük: a parancssor első tokenje a futtató, illetve
        # node/wscript/cscript esetén az első .mjs/.cjs/.js argumentum. A többi
        # argumentumban (pl. DshWindow --dsh-bin) szereplő útvonal NEM példány.
        $tokens = @([regex]::Matches($proc.CommandLine, '"[^"]+"|\S+') | ForEach-Object { $_.Value.Trim('"') })
        if ($tokens.Count -eq 0) { continue }
        $script = $null
        $first = $tokens[0]
        if ($first -match '\.(?:vbs|mjs|cjs|js)$') {
            $script = $first
        } elseif ($first -match '(?:^|\\)(?:node|wscript|cscript)\.exe$') {
            foreach ($token in $tokens[1..($tokens.Count - 1)]) {
                if ($token -match '\.(?:vbs|mjs|cjs|js)$') { $script = $token; break }
            }
        }
        if (-not $script) { continue }
        $script = $script.ToLowerInvariant()
        if ($script -like '*windows*' -or $script -like '*microsoft*' -or $script -like '*googleupdater*') { continue }
        if (-not $byScript.ContainsKey($script)) { $byScript[$script] = @() }
        $byScript[$script] += $proc.ProcessId
        # ugyanarra a célra két KÜLÖNBÖZŐ telepítés (ez volt a dupla bridge)
        if ($script -like '*bridge*' -and $script -like '*cli.mjs') {
            $install = Split-Path (Split-Path $script -Parent) -Parent
            $bridgeInstalls += [pscustomobject]@{ install = $install; pid = $proc.ProcessId }
        }
    }
    foreach ($script in $byScript.Keys) {
        if ($byScript[$script].Count -gt 1) {
            $runningDuplicates += [pscustomobject]@{ script = $script; pids = $byScript[$script] }
        }
    }
} catch {
    # a folyamatlista hibája nem állíthatja meg a jelentést
}
$bridgeInstalls = @($bridgeInstalls | Sort-Object install, pid)
$bridgeSplit = @($bridgeInstalls | Select-Object -ExpandProperty install -Unique).Count -gt 1

if ($Json) {
    [pscustomobject]@{
        entries           = $entries
        duplicates        = $duplicates
        strayFiles        = $strayFiles
        shortcutProblems  = $shortcutProblems
        runningDuplicates = $runningDuplicates
        bridgeInstalls    = $bridgeInstalls
        bridgeSplit       = $bridgeSplit
    } | ConvertTo-Json -Depth 6
    exit 0
}

Write-Host "=== Autostart-bejegyzések ($($entries.Count)) ==="
foreach ($entry in ($entries | Sort-Object source)) {
    Write-Host ("  [{0}] {1}" -f $entry.source, $entry.command)
}

Write-Host ''
if ($duplicates.Count -eq 0) {
    Write-Host 'Duplikált autostart: nincs'
} else {
    Write-Host "DUPLIKALT AUTOSTART: $($duplicates.Count) eset"
    foreach ($dup in $duplicates) {
        Write-Host ("  {0}" -f $dup.command)
        foreach ($source in $dup.sources) { Write-Host ("    <- {0}" -f $source) }
    }
    Write-Host '  JAVÍTÁS: egy csatorna maradjon (Run kulcs VAGY Startup .lnk), a másikat törölni kell.'
}

if ($strayFiles.Count -gt 0) {
    Write-Host ''
    Write-Host "FIGYELEM: nem-.lnk fájl a Startup mappában (a Windows MEGNYITJA): $($strayFiles -join ', ')"
    Write-Host '  Az átnevezés (pl. *.disabled-*) NEM kapcsolja ki — ki kell venni a mappából.'
}

if ($shortcutProblems.Count -gt 0) {
    Write-Host ''
    Write-Host "FIGYELEM: feloldhatatlan parancsikon: $($shortcutProblems -join ', ')"
}

if ($runningDuplicates.Count -gt 0) {
    Write-Host ''
    Write-Host "Futó duplikátumok (ugyanaz a launcher-szkript többször):"
    foreach ($dup in $runningDuplicates) {
        Write-Host ("  {0}  -> pid {1}" -f $dup.script, ($dup.pids -join ', '))
    }
}

if ($bridgeInstalls.Count -gt 0) {
    Write-Host ''
    Write-Host "Hídszolgáltatás (bridge) példányai: $($bridgeInstalls.Count)"
    foreach ($item in $bridgeInstalls) {
        Write-Host ("  [{0}] {1}" -f $item.pid, $item.install)
    }
    if ($bridgeSplit) {
        Write-Host 'DUPLA BRIDGE: ugyanarra a célra KÉT különböző telepítés fut egyszerre.'
        Write-Host '  JAVÍTÁS: a régi telepítés autostartját (Run kulcs / Startup .lnk) ki kell venni,'
        Write-Host '  a futó régi folyamatot leállítani. Egy cél = egy bridge = egy autostart.'
    } else {
        Write-Host '  Egy telepítés fut, dupla bridge nincs.'
    }
}
