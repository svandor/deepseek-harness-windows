<#
.SYNOPSIS
  Házirobot telepítő — ütemezett jobok + webhook-panel indítás.

.DESCRIPTION
  Normál PowerShell-ablakból futtatandó (a DSH sandboxa nem regisztrálhat
  ütemezett feladatot, és nem indíthat tartós folyamatot).

  Amit beállít:
    1) Ütemezett feladat: "HáziRobot due" — 15 percenként futtatja az esedékes jobokat
    2) Startup parancsikon: "HáziRobot panel" — bejelentkezéskor indul a webhook-fogadó
    3) bot\secrets.json a mintából (ha még nincs)
    4) Ellenőrzés: job-definíciók, panel, avatar

.EXAMPLE
  .\install-hazi-robot.ps1
  .\install-hazi-robot.ps1 -DryRun
  .\install-hazi-robot.ps1 -Remove
#>
[CmdletBinding()]
param(
  [int]$Port = 4180,
  [switch]$DryRun,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$bot = $PSScriptRoot
$taskName = 'HáziRobot due'
$lnkName = 'HáziRobot panel.lnk'
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup $lnkName

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

if ($Remove) {
  Write-Step 'Eltávolítás'
  if ($DryRun) {
    Write-Host "  (dry-run) Unregister-ScheduledTask -TaskName `"$taskName`""
    Write-Host "  (dry-run) törlés: $lnkPath"
  } else {
    $ErrorActionPreference = 'Continue'
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch { }
    if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force -ErrorAction SilentlyContinue }
    Write-Host '  Kész: az ütemezett feladat és a parancsikon törölve.'
  }
  exit 0
}

Write-Step "Házirobot telepítés — bot: $bot"

# --- 0) előfeltételek ---------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'A node nincs a PATH-on.' }

# A node:sqlite "experimental" figyelmeztetése a stderr-re megy, amit a PowerShell
# $ErrorActionPreference='Stop' mellett hibának lát — ezért --no-warnings, és a
# natív hívásoknál a visszatérési kódot nézzük, nem a stderr-t.
$node = 'node'
$nodeArgs = @('--no-warnings')
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

Write-Step 'Job-definíciók ellenőrzése'
& $node @nodeArgs (Join-Path $bot 'run-job.mjs') check
if ($LASTEXITCODE -ne 0) {
  $ErrorActionPreference = $prevEap
  throw 'A job-definíciók hibásak — javítsd őket a telepítés előtt.'
}
$ErrorActionPreference = $prevEap

# --- 1) titkok ---------------------------------------------------------------
$secrets = Join-Path $bot 'secrets.json'
$example = Join-Path $bot 'secrets.example.json'
if (-not (Test-Path $secrets)) {
  if ($DryRun) {
    Write-Host "  (dry-run) másolás: $example -> $secrets"
  } else {
    Copy-Item $example $secrets
    Write-Host "  Létrehozva: $secrets  (TÖLTSD KI a titkokat!)" -ForegroundColor Yellow
  }
} else {
  Write-Host "  Már van secrets.json: $secrets"
}

# --- 2) ütemezett feladat -----------------------------------------------------
# A `due` parancs 15 percenként lefut; a cron-kifejezés dönti el, melyik job esedékes.
# FONTOS: a `schtasks /TR` elhasal, ha az útvonal szóközt tartalmaz (ez mért hiba
# volt: 'Invalid argument/option - C:\Szerver\Deepseek'). Ezért a ScheduledTasks
# modult használjuk, ami az argumentumokat rendesen átadja.
Write-Step "Ütemezett feladat: $taskName (15 percenként)"
$psExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $psExe) { $psExe = 'powershell.exe' }
$taskArg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bot\run-job.ps1`" due"
if ($DryRun) {
  Write-Host "  (dry-run) Register-ScheduledTask -TaskName `"$taskName`" -Execute `"$psExe`" -Argument $taskArg -Every 15 min"
} else {
  $ErrorActionPreference = 'Continue'
  try {
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $taskArg -WorkingDirectory $bot
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes 15)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host '  Kész.'
  } catch {
    Write-Host "  FIGYELEM: az utemezett feladatot nem sikerult letrehozni: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '  Futtasd ugyanezt a szkriptet rendszergazdakent.' -ForegroundColor Yellow
  }
  $ErrorActionPreference = $prevEap
}

# --- 3) startup parancsikon a panelhez ---------------------------------------
# FONTOS: az ORFOLYAMOT indítjuk, nem a csupasz panelt.
# A csupasz panel (webhook-server.mjs) önmagát nem javítja: ha elhal, a
# böngésző `Failed to fetch`-et ír, és semmi nem indítja újra. Az orfolyam
# (watchdog-hazi-robot.ps1) 60 s-enként figyeli, és újraindítja — ezért a
# bejelentkezéskori elemnek ezt kell indítania. Ugyanezt teszi a tálca is
# (`tray/dsh-tray.ps1` → `Invoke-RobotEnsure`), így a lánc:
#   tálca / Startup parancsikon  ->  orfolyam  ->  panel
Write-Step "Startup parancsikon: $lnkName (orfolyam)"
$panelArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bot\start-robot-watchdog.ps1`" -Port $Port"
if ($DryRun) {
  Write-Host "  (dry-run) $lnkPath -> $psExe $panelArgs"
} else {
  $ErrorActionPreference = 'Continue'
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $psExe
    $lnk.Arguments = $panelArgs
    $lnk.WorkingDirectory = $bot
    $lnk.Description = 'Házirobot orfolyam: panel + watchdog'
    $lnk.Save()
    Write-Host "  Kész: $lnkPath"
  } catch {
    Write-Host "  FIGYELEM: a parancsikont nem sikerult letrehozni: $($_.Exception.Message)" -ForegroundColor Yellow
  }
  $ErrorActionPreference = $prevEap
}

# --- 4) ellenőrzés ------------------------------------------------------------
if (-not $DryRun) {
  Write-Step 'Ellenőrzés: a panel elindítása és lekérdezése'
  $ErrorActionPreference = 'Continue'
  Start-Process -FilePath $psExe -ArgumentList $panelArgs -WorkingDirectory $bot -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  try {
    $panel = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8
    $avatar = Invoke-WebRequest "http://127.0.0.1:$Port/avatar.svg" -UseBasicParsing -TimeoutSec 8
    Write-Host ("  Panel: HTTP {0} ({1} byte) — avatar: {2} byte" -f $panel.StatusCode, $panel.Content.Length, $avatar.Content.Length) -ForegroundColor Green
  } catch {
    Write-Host "  FIGYELEM: a panel nem válaszol: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  Write-Step 'Ütemezett jobok próbafuttatása'
  & $node @nodeArgs (Join-Path $bot 'run-job.mjs') due
  $ErrorActionPreference = $prevEap
}

Write-Host ''
if ($DryRun) {
  Write-Host 'Ez DRY-RUN volt — semmi nem valtozott. A telepitheshez: .\install-hazi-robot.ps1' -ForegroundColor Yellow
} else {
  Write-Host 'Házirobot telepítve.' -ForegroundColor Green
  Write-Host "  Panel:      http://127.0.0.1:$Port/"
  Write-Host "  Webhook:    POST http://127.0.0.1:$Port/<a modul utvonala>   (X-Bot-Token fejlec)"
  Write-Host '  Amit még neked kell: secrets.json kitöltése (SMTP + callback titok + panel-token).'
  Write-Host '  Eltávolítás: .\install-hazi-robot.ps1 -Remove'
}
