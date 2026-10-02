<#
.SYNOPSIS
  A rendszertálca-ikon programjának újraindítása (frissítés után).

.DESCRIPTION
  A tálca a `state\tray.pid` fájlba írja a saját folyamat-azonosítóját. Ez a
  szkript:
    1) megkeresi a tálca folyamatát — előbb a PID-fájlból, ha az nincs (régi
       tálca), akkor a `state\tray.log` utolsó „tálca elindult" sorához
       legközelebb indult `powershell.exe`-ből,
    2) leállítja (és megvárja, hogy a `DshHarnessTrayIcon` mutex felszabaduljon),
    3) elindítja az újat (`bin\DshLauncher.exe --tray-only`) — WMI-vel, hogy a
       hívó folyamatfájának kilövése ne vigye magával; ha a WMI nem elérhető,
       `Start-Process`-szel.

  Az ablak és a háttér-GUI FUTVA MARAD: csak a tálca programja cserélődik.

  MIÉRT KELL: a tálca a saját kódját a folyamat indulásakor tölti be, ezért egy
  javított `tray\dsh-tray.ps1` csak újraindítással lép életbe — a tálca
  menüjének „A tálca újraindítása" pontja ugyanezt teszi, de az csak a már
  frissített kódban van benne.

.EXAMPLE
  .\tools\restart-tray.ps1            # leállítja és újraindítja a tálcát
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
$trayCmd = Join-Path $root 'tray\dsh-tray.cmd'
$mutexName = 'DshHarnessTrayIcon'

function Get-TrayProcess {
  # 1) A PID-fájl (a frissített tálca írja).
  if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue)
    if ($raw -and $raw.Trim() -match '^\d+$') {
      $proc = Get-Process -Id ([int]$raw.Trim()) -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -match 'powershell|pwsh') { return $proc }
    }
  }
  # 2) Régi tálca: a tray.log „tálca elindult" sorához legközelebbi powershell.
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

$proc = Get-TrayProcess
if (-not $proc) {
  Write-Host 'Nem találom a futó tálcát (nincs PID-fájl és a napló sem segít) — csak elindítom.'
} else {
  Write-Host "A tálca leállítása (pid $($proc.Id), indult: $($proc.StartTime))…"
  if (-not $DryRun) {
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
  Write-Host "  $launcher --tray-only"
  return
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
  } else {
    Start-Process -FilePath $trayCmd -WindowStyle Hidden | Out-Null
  }
  Write-Host 'Új tálca elindítva (Start-Process).'
}

# Visszaigazolás: az új tálca kiírja a PID-fájlt és az életjelet.
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  if (Test-Path $pidFile) {
    $newPid = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($newPid -match '^\d+$' -and (-not $proc -or $newPid -ne "$($proc.Id)")) {
      Write-Host "Kész: az új tálca fut (pid $newPid). Az ablak és a háttér-GUI érintetlen."
      return
    }
  }
}
Write-Host 'FIGYELEM: az új tálca nem erősítette meg magát 25 másodpercen belül.'
Write-Host "  Nézd meg: $trayLog"
if (Test-Path $heartbeatFile) { Write-Host "  (életjel létezik: $((Get-Item $heartbeatFile).LastWriteTime))" }
