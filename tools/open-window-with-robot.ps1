<#
.SYNOPSIS
  A DSH ablak megnyitása a robottal mint 4. felülettel (tálca nélkül).

.DESCRIPTION
  A tálca a menüjét a szkript betöltésekor építi, ezért a „4. felület: robot
  panel" pont csak a tálca ÚJRAINDÍTÁSA után jelenik meg. Ez a szkript addig is
  (és utána is) használható: bezárja a futó ablakot, és a robottal együtt nyitja
  újra.

  Amit összeállít:
    --panes <munkaterületek + 1>          (alapból 4 = 3 munkaterület + robot)
    --pane-url <utolsó>=<robot URL>       (a robot felület a saját paneljét tölti)
    --url <mentett token URL>             (azonnal hitelesítve nyílik)
    --width/--height                      (a legutolsó ablakgeometria)

  Indítás után ellenőrzi a state\window.log-ot: megjelent-e a „panes: 4" és a
  „pane 4: URL override" sor.

.EXAMPLE
  .\tools\open-window-with-robot.ps1                 # 3 munkaterület + robot
  .\tools\open-window-with-robot.ps1 -Workspaces 2   # 2 munkaterület + robot
  .\tools\open-window-with-robot.ps1 -NoRobot        # csak munkaterületek
  .\tools\open-window-with-robot.ps1 -DryRun         # csak kiírja, mit tenne
  .\tools\open-window-with-robot.ps1 -Save           # a tálca beállítását is frissíti
#>
[CmdletBinding()]
param(
  [int]$Workspaces = 3,
  [string]$RobotUrl = 'http://127.0.0.1:4180/',
  [int]$Port = 3080,
  [switch]$NoRobot,
  [switch]$DryRun,
  [switch]$KeepWindow,
  # A tálca tartós beállítását (state\tray-config.json) is frissíti. Enélkül ez a
  # szkript csak EGYSZERI ablaknyitás: a tálca legközelebb a saját beállításával
  # indítana, és az elrendezés „visszaugrana".
  [switch]$Save
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'bin\DshWindow.exe'
$stateDir = Join-Path $root 'state'
$logFile = Join-Path $stateDir 'window.log'
$icon = Join-Path $root 'assets\dsh.ico'
$geometryFile = Join-Path $stateDir 'window-geometry.txt'
$urlFile = Join-Path $stateDir 'harness.url'

if (-not (Test-Path $exe)) { throw "Nincs meg az ablak: $exe" }

# --- token URL ----------------------------------------------------------------
$tokenUrl = $null
if (Test-Path $urlFile) { $tokenUrl = (Get-Content $urlFile -Raw).Trim() }
if (-not $tokenUrl) {
  $log = Join-Path $stateDir 'harness.log'
  if (Test-Path $log) {
    $tokenUrl = ((Get-Content $log -Raw) | Select-String -Pattern "http://127\.0\.0\.1:$Port/\?token=[A-Za-z0-9_\-]+" -AllMatches).Matches.Value | Select-Object -Last 1
  }
}
if (-not $tokenUrl) { Write-Host 'FIGYELEM: nincs mentett token URL — az ablak token nélkül nyílik (401 lehet).' -ForegroundColor Yellow }

# --- geometria ----------------------------------------------------------------
$width = 1280; $height = 840
if (Test-Path $geometryFile) {
  foreach ($line in Get-Content $geometryFile) {
    if ($line -match '^width=(\d+)') { $width = [int]$Matches[1] }
    if ($line -match '^height=(\d+)') { $height = [int]$Matches[1] }
  }
}

# --- argumentumok --------------------------------------------------------------
$panes = [Math]::Min(4, [Math]::Max(1, $Workspaces + $(if ($NoRobot) { 0 } else { 1 })))
$argList = @(
  '--port', "$Port",
  '--panes', "$panes",
  '--no-boot',
  '--width', "$width",
  '--height', "$height",
  '--log', "`"$logFile`"",
  '--icon', "`"$icon`"",
  '--restart-if-stale'
)
if ($env:DSH_HOME) { $argList += @('--dsh-home', "`"$env:DSH_HOME`"") }
if ($tokenUrl) { $argList += @('--url', "`"$tokenUrl`"") }
if (-not $NoRobot -and $panes -ge 2) { $argList += @('--pane-url', "$panes=`"$RobotUrl`"") }

Write-Host "Ablak: $exe"
Write-Host "  felületek : $panes $(if (-not $NoRobot) { "(ebből az utolsó a robot: $RobotUrl)" } else { '(csak munkaterületek)' })"
Write-Host "  geometria : ${width}x${height}"
Write-Host "  token URL : $(if ($tokenUrl) { 'mentett (azonnal hitelesítve)' } else { 'nincs' })"

# A tálca TARTÓS beállítása külön él (state\tray-config.json), és a tálca a saját
# példányát a memóriában tartja. Ezért ez a szkript alapból csak egyszeri
# ablaknyitás: -Save nélkül a következő tálca-indítás a saját elrendezését adná,
# és a felhasználó „visszaugró" ablakot látna. -Save-dzsal a fájlt is frissítjük
# (a futó tálca azt a következő indításakor veszi figyelembe).
$configFile = Join-Path $stateDir 'tray-config.json'
if ($Save -and -not $DryRun) {
  try {
    if (Test-Path $configFile) {
      $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $cfg.panes = [Math]::Min(3, [Math]::Max(1, $Workspaces))
      $cfg.robotPane = (-not $NoRobot)
      if ($NoRobot) { $cfg.robotOnly = $false }
      if ($cfg.robotUrl) { $cfg.robotUrl = $RobotUrl }
      $cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $configFile -Encoding UTF8
      Write-Host "  tálca-beállítás: frissítve (panes=$($cfg.panes), robotPane=$($cfg.robotPane))"
      Write-Host '    (a futó tálca a következő indításakor veszi figyelembe)'
    } else {
      Write-Host "  tálca-beállítás: nincs $configFile — a tálca először induljon el"
    }
  } catch {
    Write-Host "  FIGYELEM: a tálca beállítását nem sikerült frissíteni: $($_.Exception.Message)" -ForegroundColor Yellow
  }
} elseif (-not $DryRun) {
  Write-Host '  tálca-beállítás: változatlan (tartós beállításhoz: -Save, vagy tálcaikon → Ablak felosztása)'
}

if ($DryRun) {
  Write-Host ''
  Write-Host "Parancs (dry-run):"
  Write-Host "  $exe $($argList -join ' ')"
  exit 0
}

# --- a futó ablak bezárása ------------------------------------------------------
if (-not $KeepWindow) {
  $windows = @(Get-Process DshWindow -ErrorAction SilentlyContinue)
  if ($windows.Count -gt 0) {
    Write-Host "Futó ablak bezárása (pid $($windows[0].Id))…"
    foreach ($w in $windows) { try { $w.CloseMainWindow() | Out-Null } catch { } }
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and @(Get-Process DshWindow -ErrorAction SilentlyContinue).Count -gt 0) {
      Start-Sleep -Milliseconds 250
    }
    if (@(Get-Process DshWindow -ErrorAction SilentlyContinue).Count -gt 0) {
      Write-Host 'Nem zárt be szabályosan — kényszerű leállítás.' -ForegroundColor Yellow
      Get-Process DshWindow -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    }
  }
}

# --- indítás -------------------------------------------------------------------
$before = if (Test-Path $logFile) { (Get-Item $logFile).Length } else { 0 }
Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory (Split-Path $exe -Parent)
Write-Host 'Indítás…'
Start-Sleep -Seconds 10

# --- ellenőrzés ----------------------------------------------------------------
$newLines = @()
if (Test-Path $logFile) {
  $all = Get-Content $logFile
  $start = 0
  for ($i = $all.Count - 1; $i -ge 0; $i--) { if ($all[$i] -match 'launcher start') { $start = $i; break } }
  $newLines = $all[$start..($all.Count - 1)]
}
$panesOk = ($newLines | Select-String -Pattern "panes: $panes " -Quiet)
$overrideOk = if ($NoRobot) { $true } else { ($newLines | Select-String -Pattern 'URL override' -Quiet) }
$running = @(Get-Process DshWindow -ErrorAction SilentlyContinue).Count -gt 0

Write-Host ''
if ($running -and $panesOk -and $overrideOk) {
  Write-Host "KÉSZ: az ablak $panes felülettel fut$(if (-not $NoRobot) { ", a(z) $panes. a robot" })." -ForegroundColor Green
} else {
  Write-Host 'FIGYELEM: az ellenőrzés nem teljes:' -ForegroundColor Yellow
  Write-Host "  ablak fut: $running | panes=$panes megvan: $panesOk | robot override: $overrideOk"
  Write-Host "  (nézd meg: $logFile)"
}
