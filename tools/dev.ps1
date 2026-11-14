<#
.SYNOPSIS
    DSH dev-környezet: projektprofil és állapot (a Herd-kiváltás első szelete).

.DESCRIPTION
    A `docs\DSH-HERD-KIVALTAS.md` terv 4. pontjának 2. lépése: **kockázatmentes
    állapotfelmérés**. Semmit nem indít és nem ír — csak a projektprofilt, a
    portokat, a hosts-sort és a futó folyamatokat mutatja, hogy a `dev_start`
    bevezetése mérhető alapról induljon.

    A profil a projekt gyökerében: `.dsh\dev.yaml` (kulcs: érték sorok). Ha nincs,
    a szkript az alapértelmezésekkel dolgozik, és ezt kimondja.

.PARAMETER Project
    A projekt gyökere. Alapértelmezés: D:\Herd\termeszetgyogyaszoktatas-L12.

.PARAMETER Action
    status (alapértelmezés) — állapotfelmérés.
    start | stop | logs — még NEM megvalósított; a szkript a tervezett lépést írja ki.

.EXAMPLE
    pwsh -NoProfile -File tools\dev.ps1
    pwsh -NoProfile -File tools\dev.ps1 -Project 'D:\Herd\termeszetgyogyaszoktatas-L12'
#>
[CmdletBinding()]
param(
    [string]$Project = 'D:\Herd\termeszetgyogyaszoktatas-L12',
    [ValidateSet('status', 'start', 'stop', 'logs')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

function Read-DevProfile {
    param([string]$Root)
    $path = Join-Path $Root '.dsh\dev.yaml'
    $profile = [ordered]@{
        domain  = ''
        docroot = 'public'
        php     = '8.4'
        server  = 'caddy'
        vite    = 'true'
        port    = '8443'
        hosts   = 'true'
        source  = 'alapértelmezés'
    }
    if (Test-Path $path) {
        $profile.source = $path
        foreach ($line in Get-Content $path) {
            if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
            if ($line -match '^\s*([A-Za-z_]+)\s*:\s*(.*)$') {
                $key = $Matches[1]
                $value = ($Matches[2] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
                if ($profile.Contains($key)) { $profile[$key] = $value }
            }
        }
    }
    return [pscustomobject]$profile
}

function Get-ListenerInfo {
    param([int]$Port)
    $lines = & netstat -ano 2>$null | Select-String -Pattern (":{0}\s" -f $Port)
    $pids = @()
    foreach ($line in $lines) {
        $parts = ($line.Line -split '\s+') | Where-Object { $_ -ne '' }
        if ($parts.Length -ge 5 -and $parts[-1] -match '^\d+$' -and [int]$parts[-1] -gt 0) { $pids += [int]$parts[-1] }
    }
    return @($pids | Sort-Object -Unique)
}

function Get-ProcessName {
    param([int]$ProcessId)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($p) { return $p.ProcessName } else { return '?' }
}

$profile = Read-DevProfile -Root $Project

Write-Host "=== DSH dev-környezet (Herd-kiváltás) ==="
Write-Host ("projekt      : {0}  (létezik: {1})" -f $Project, (Test-Path $Project))
Write-Host ("profil       : {0}" -f $profile.source)
Write-Host ("domain       : {0}" -f $profile.domain)
Write-Host ("docroot      : {0}  (létezik: {1})" -f $profile.docroot, (Test-Path (Join-Path $Project $profile.docroot)))
Write-Host ("server mód   : {0}   vite: {1}   kért port: {2}" -f $profile.server, $profile.vite, $profile.port)
Write-Host ("php (PATH)   : {0}" -f ((Get-Command php -ErrorAction SilentlyContinue).Source))
if (Get-Command php -ErrorAction SilentlyContinue) {
    $phpVersion = (& php -r 'echo PHP_VERSION;' 2>$null)
    Write-Host ("php verzió   : {0}" -f $phpVersion)
}

if ($Action -ne 'status') {
    Write-Host ''
    Write-Host ("A(z) '{0}' még NEM megvalósított. A terv szerinti következő lépés:" -f $Action)
    Write-Host '  docs\DSH-HERD-KIVALTAS.md 4. pont: artisan-serve indulás, majd Caddy + mkcert a 8443-on.'
    exit 0
}

Write-Host ''
Write-Host "--- portok ---"
foreach ($port in @(80, 443, [int]$profile.port, 5173, 8000, 3306)) {
    $pids = Get-ListenerInfo -Port $port
    if ($pids.Count -eq 0) {
        Write-Host ("  {0,-5} szabad" -f $port)
    } else {
        $names = ($pids | ForEach-Object { "{0}({1})" -f $_, (Get-ProcessName -ProcessId $_) }) -join ', '
        Write-Host ("  {0,-5} FOGLALT: {1}" -f $port, $names)
    }
}

Write-Host ''
Write-Host "--- hosts ---"
$hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
if ($profile.domain -ne '' -and (Test-Path $hostsPath)) {
    $hit = Select-String -Path $hostsPath -Pattern ([regex]::Escape($profile.domain)) -ErrorAction SilentlyContinue
    if ($hit) { Write-Host ("  {0} -> SZEREPEL ({1} sor)" -f $profile.domain, $hit.Count) }
    else { Write-Host ("  {0} -> nincs a hosts fájlban" -f $profile.domain) }
} else {
    Write-Host '  nincs domain a profilban (vagy nincs hosts fájl)'
}
$journal = Join-Path $Project '.dsh\hosts-added.json'
Write-Host ("  DSH-nyilvántartás ({0}): {1}" -f $journal, (Test-Path $journal))

Write-Host ''
Write-Host "--- futó folyamatok (Herd és dev-jelöltek) ---"
$interesting = @('Herd', 'HerdHelper', 'nginx', 'php-cgi', 'caddy', 'vite')
$rows = Get-Process -ErrorAction SilentlyContinue | Where-Object { $interesting -contains $_.ProcessName }
if ($rows) {
    $rows | Group-Object ProcessName | Sort-Object Name | ForEach-Object {
        Write-Host ("  {0,-12} {1} példány" -f $_.Name, $_.Count)
    }
} else {
    Write-Host '  nincs Herd/dev folyamat'
}

Write-Host ''
Write-Host "Következő lépés: dev_start (artisan-serve), majd Caddy + mkcert a 8443-on."
