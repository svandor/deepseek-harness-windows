<#
.SYNOPSIS
  A rendszertálca-ikon programjának újraindítása (frissítés után).

.DESCRIPTION
  A tálca a `state\tray.pid` fájlba írja a saját folyamat-azonosítóját. Ez a
  szkript:
    1) megkeresi a futó tálcát — a PID-fájlból (ellenőrzött útvonallal), majd
       folyamatnév alapján (`DshTray`, a C# tálca) vagy a régi PowerShell-tálca
       naplója alapján,
    2) leállítja (ellenőrzött PID-del, NÉV szerint soha — AGENTS §1.6), és
       megvárja, hogy a `DshHarnessTrayIcon` mutex felszabaduljon,
    3) **kicseréli a `bin\DshTray.exe.new` fájlt** (`*.old-<időbélyeg>` mentéssel),
       majd elindítja az újat (`bin\DshLauncher.exe --tray-only`) — WMI-vel, hogy
       a hívó folyamatfájának kilövése ne vigye magával; ha a WMI nem elérhető,
       `Start-Process`-szel, rejtett ablakkal.

  Az ablak és a háttér-GUI FUTVA MARAD: csak a tálca programja cserélődik.

  MIÉRT KELL A CSERE ITT: a `PendingUpdate.Apply()` a tálca INDULÁSAKOR fut, de a
  saját (futó) exe-jét nem tudja lecserélni — ezért a `.new` → `.exe` csere a
  leállítás UTÁN, ebben a szkriptben történik. A `DshWindow.exe.new` csak akkor
  cserélhető, ha éppen nem fut ablak (különben a következő ablaknyitás intézi).

  MÉRT HIBA (2026-11-17): a korábbi változat csak `powershell.exe`-t keresett,
  ezért a C# tálcát (`DshTray.exe`) NEM találta meg, és „csak elindítom" ágon egy
  második példányt indított — a tálca így nem frissült. Ezt javítja ez a verzió.

.EXAMPLE
  .\tools\restart-tray.ps1            # leállítja, kicseréli és újraindítja a tálcát
  .\tools\restart-tray.ps1 -DryRun    # csak kiírja, mit tenne
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$stateDir = Join-Path $root 'state'
$pidFile = Join-Path $stateDir 'tray.pid'
$trayLog = Join-Path $stateDir 'tray.log'
$heartbeatFile = Join-Path $stateDir 'tray.heartbeat'
$launcher = Join-Path $root 'bin\DshLauncher.exe'
$trayExe = Join-Path $root 'bin\DshTray.exe'
$trayNew = Join-Path $root 'bin\DshTray.exe.new'
$windowExe = Join-Path $root 'bin\DshWindow.exe'
$windowNew = Join-Path $root 'bin\DshWindow.exe.new'
$trayCmd = Join-Path $root 'tray\dsh-tray.cmd'
$mutexName = 'DshHarnessTrayIcon'

<#
  A mellékelt C# (Roslyn) fordítás eredménye: a tálca indítási idejű
  PendingUpdate-je a SAJÁT exe-jét nem tudja lecserélni, ezért a cserét ez a
  szkript végzi, a leállítás után.
#>
function Get-NormalizedPath([string]$value) {
    if (-not $value) { return '' }
    # A repó ezen a gépen C:\ alatt is elérhető (junction); a meghajtóbetűt
    # levágjuk, hogy a C:\ és D:\ alak UGYANAZ legyen.
    return (($value -replace '^[A-Za-z]:', '') -replace '/', '\').ToLowerInvariant()
}

function Test-OurProcess {
    param($Process)
    if ($null -eq $Process) { return $false }
    try {
        $path = $Process.Path
        if ($path) {
            $np = Get-NormalizedPath $path
            $nr = Get-NormalizedPath $root
            if ($np.StartsWith($nr)) { return $true }
        }
    } catch { }
    return $false
}

function Get-TrayProcess {
    # 1) A PID-fájl (a C# és a frissített tálca is írja).
    if (Test-Path $pidFile) {
        $raw = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue)
        if ($raw -and $raw.Trim() -match '^\d+$') {
            $proc = Get-Process -Id ([int]$raw.Trim()) -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match 'DshTray|DshLauncher|powershell|pwsh' -and (Test-OurProcess $proc)) { return $proc }
        }
    }
    # 2) A C# tálca folyamatneve — ellenőrzött útvonallal.
    foreach ($candidate in (Get-Process -Name DshTray -ErrorAction SilentlyContinue)) {
        if (Test-OurProcess $candidate) { return $candidate }
    }
    # 3) Régi (PowerShell) tálca: a tray.log „tálca elindult" sora alapján.
    if (Test-Path $trayLog) {
        $hit = Get-Content $trayLog -Tail 400 -ErrorAction SilentlyContinue |
            Select-String 'tálca elindult' | Select-Object -Last 1
        if ($hit -and $hit.Line -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})') {
            $when = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', $null)
            $best = $null
            $bestDelta = [double]::MaxValue
            foreach ($candidate in (Get-Process powershell -ErrorAction SilentlyContinue)) {
                $delta = [Math]::Abs(($candidate.StartTime - $when).TotalSeconds)
                if ($delta -lt $bestDelta) { $bestDelta = $delta; $best = $candidate }
            }
            if ($best -and $bestDelta -le 120) { return $best }
        }
    }
    return $null
}

function Get-ActiveWindowCount {
    $count = 0
    foreach ($candidate in (Get-Process -Name DshWindow -ErrorAction SilentlyContinue)) {
        if (Test-OurProcess $candidate) { $count += 1 }
    }
    return $count
}

$proc = Get-TrayProcess
if (-not $proc) {
    Write-Host 'Nem találom a futó tálcát (nincs PID-fájl, folyamatnév és a napló sem segít) — csak elindítom.'
} else {
    Write-Host "A tálca leállítása (pid $($proc.Id) $($proc.ProcessName), indult: $($proc.StartTime))…"
    if (-not $DryRun) {
        # §1.6: ellenőrzött PID-del állítunk le, nem név szerint — és a harness
        # pidje nem lehet ez a folyamat.
        $harnessPid = 0
        if (Test-Path (Join-Path $stateDir 'harness.pid')) {
            $raw = (Get-Content (Join-Path $stateDir 'harness.pid') -Raw -ErrorAction SilentlyContinue)
            if ($raw -and $raw.Trim() -match '^\d+$') { $harnessPid = [int]$raw.Trim() }
        }
        if ($proc.Id -eq $harnessPid) { throw "A PID-fájl a HARNESS-t jelöli — nem állítom le." }
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 400
            try {
                $mutex = [System.Threading.Mutex]::OpenExisting($mutexName)
                $mutex.Dispose()
            } catch {
                break   # a mutex eltűnt: az új példány indulhat
            }
        }
    }
}

if ($DryRun) {
    Write-Host ''
    Write-Host 'Parancs (dry-run):'
    if ((Test-Path $trayNew) -and ($null -ne $proc)) {
        Write-Host "  copy bin\DshTray.exe.new -> bin\DshTray.exe  (a leállítás után, mentéssel)"
    }
    if ((Test-Path $windowNew) -and ((Get-ActiveWindowCount) -eq 0)) {
        Write-Host "  copy bin\DshWindow.exe.new -> bin\DshWindow.exe  (nincs futó ablak)"
    }
    Write-Host "  $launcher --tray-only"
    return
}

# ── a várakozó bináris cseréje (a futó exe-t nem lehet felülírni, csak leállítva)
if (Test-Path $trayNew) {
    if ($null -ne $proc -and (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
        Write-Host "FIGYELEM: a tálca még fut (pid $($proc.Id)) — a $trayNew cseréje kimarad."
    } else {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        if (Test-Path $trayExe) {
            Copy-Item $trayExe "$trayExe.old-$stamp" -Force
            Write-Host "Mentés: $trayExe.old-$stamp"
        }
        # A Move-Item nem írja felül a létező célfájlt (PS 5.1) — ezért copy + delete.
        [IO.File]::Copy($trayNew, $trayExe, $true)
        Remove-Item $trayNew -Force
        Write-Host "Csere: bin\DshTray.exe.new -> bin\DshTray.exe"
    }
}

# A window bináris csak akkor cserélhető, ha éppen nem fut ablak.
if ((Test-Path $windowNew) -and ((Get-ActiveWindowCount) -eq 0)) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (Test-Path $windowExe) {
        Copy-Item $windowExe "$windowExe.old-$stamp" -Force
        Write-Host "Mentés: $windowExe.old-$stamp"
    }
    [IO.File]::Copy($windowNew, $windowExe, $true)
    Remove-Item $windowNew -Force
    Write-Host "Csere: bin\DshWindow.exe.new -> bin\DshWindow.exe"
} elseif ((Test-Path $windowNew) -and ((Get-ActiveWindowCount) -gt 0)) {
    Write-Host "A DshWindow.exe.new a következő ablaknyitásnál lép életbe (most fut ablak)."
}

# Indítás a hívó folyamatfáján KÍVÜL (WMI), hogy egy DSH-terminálból indítva se
# haljon meg a hívóval együtt.
$started = $false
try {
    $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
    $startup.ShowWindow = 0
    $result = ([wmiclass]'Win32_Process').Create("`"$launcher`" --tray-only", $null, $startup)
    if ($result -and $result.ReturnValue -eq 0) {
        $started = $true
        Write-Host "Új tálca elindítva (pid $($result.ProcessId))."
    }
} catch {
    Write-Host "A WMI-indítás nem elérhető ($($_.Exception.Message)) — Start-Process."
}
if (-not $started) {
    if (Test-Path $launcher) {
        Start-Process -FilePath $launcher -ArgumentList '--tray-only' -WindowStyle Hidden | Out-Null
    } elseif (Test-Path $trayExe) {
        Start-Process -FilePath $trayExe -WindowStyle Hidden | Out-Null
    } else {
        Start-Process -FilePath $trayCmd -WindowStyle Hidden | Out-Null
    }
    Write-Host 'Új tálca elindítva (Start-Process).'
}

# Visszaigazolás: az új tálca kiírja a PID-fájlt és az életjelet.
$oldPid = if ($null -ne $proc) { $proc.Id } else { 0 }
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    if (Test-Path $pidFile) {
        $newPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($newPid -match '^\d+$' -and ([int]$newPid -ne $oldPid)) {
            Write-Host "Kész: az új tálca fut (pid $newPid). Az ablak és a háttér-GUI érintetlen."
            return
        }
    }
}
Write-Host 'FIGYELEM: az új tálca nem erősítette meg magát 25 másodpercen belül.'
Write-Host "  Nézd meg: $trayLog"
if (Test-Path $heartbeatFile) { Write-Host "  (életjel létezik: $((Get-Item $heartbeatFile).LastWriteTime))" }
