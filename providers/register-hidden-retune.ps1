<#
.SYNOPSIS
  A 'DSH model retune' ütemezett feladat újraregisztrálása REJTETT indítóval.

.DESCRIPTION
  MÉRT HIBA (2026-10-28 09:00:01): a feladat művelete a `run-retune.cmd` shimre
  mutatott. A Task Scheduler a .cmd-hez KONZOLT hoz létre (fekete cmd.exe), a
  shim pedig egy második, látható powershell.exe-t indított (kék ablak). Két
  ablak vette el a fókuszt, és 09:00:01-től 09:09-ig látszott.

  A `-WindowStyle Hidden` önmagában NEM elég: csak a létrehozás UTÁN hívja a
  ShowWindow(SW_HIDE)-ot, addig a konzol látható és fókuszra tesz szert.

  Ez a szkript ugyanazt az ütemezést (napi 09:00) ugyanarra a szkriptre állítja,
  de `wscript.exe //nologo run-retune-hidden.vbs <mode>`-on keresztül: a wscript
  `Run(cmd, 0, True)` egyáltalán nem hoz létre konzolablakot.

  Szabály és a kötelező minta: ..\AGENTS.md 1. fejezet.

  Normál PowerShell-ablakból futtasd: a DSH sandboxa nem ér el CIM-et, ezért a
  ScheduledTasks modul ott nem működik.

.EXAMPLE
  .\register-hidden-retune.ps1
  .\register-hidden-retune.ps1 -DryRun
  .\register-hidden-retune.ps1 -Verify
  .\register-hidden-retune.ps1 -Cadence Weekly
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'DSH model retune',
  [ValidateSet('Daily', 'Weekly')][string]$Cadence = 'Daily',
  [ValidatePattern('^\d{1,2}:\d{2}$')][string]$Time = '09:00',
  [ValidateSet('apply', 'report')][string]$Mode = 'apply',
  [string]$FirstRun = '',
  [switch]$Verify,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root    = $PSScriptRoot
$vbs     = Join-Path $root 'run-retune-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if ($Verify) {
  $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $current) { Write-Host "Nincs ilyen feladat: '$TaskName'" -ForegroundColor Yellow; exit 1 }
  $exec = [string]$current.Actions.Execute
  $args = [string]$current.Actions.Arguments
  Write-Host "Feladat:    $TaskName"
  Write-Host "  Execute:   $exec"
  Write-Host "  Arguments: $args"
  if ($exec -match '(?i)powershell|cmd(\.exe)?$|\.cmd|\.bat') {
    Write-Host '  ALLAPOT:   HELYTELEN — a muvelet konzolablakot hoz letre. Futtasd a register-hidden-retune.ps1-t.' -ForegroundColor Red
    exit 2
  }
  if ($exec -match '(?i)wscript') {
    Write-Host '  ALLAPOT:   HELYES — wscript + rejtett VBS indito (nem hoz letre konzolt).' -ForegroundColor Green
    exit 0
  }
  Write-Host '  ALLAPOT:   ELLENORIZENDO — nem ismert indito tipus.' -ForegroundColor Yellow
  exit 3
}

if (-not (Test-Path $vbs))     { throw "Hiányzik a rejtett indító: $vbs" }
if (-not (Test-Path $wscript)) { throw "Nem találom: $wscript" }

$at = if ($FirstRun) {
  [datetime]::ParseExact($FirstRun, 'yyyy-MM-dd', $null).Date.Add([timespan]::Parse($Time))
} else {
  (Get-Date).Date.Add([timespan]::Parse($Time))
}
if ($at -lt (Get-Date)) { $at = $at.AddDays(1) }

if ($DryRun) {
  Write-Host '(dry-run) Ezt regisztralnam:'
  Write-Host "  TaskName:   $TaskName"
  Write-Host "  Execute:    $wscript"
  Write-Host "  Arguments:  //nologo `"$vbs`" $Mode"
  Write-Host "  Utem:       $Cadence, $Time"
  Write-Host "  Elso futas: $at"
  return
}

$action = New-ScheduledTaskAction -Execute $wscript -Argument "//nologo `"$vbs`" $Mode" -WorkingDirectory $root

$trigger = if ($Cadence -eq 'Daily') {
  New-ScheduledTaskTrigger -Daily -At $at
} else {
  New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek $at.DayOfWeek -At $at
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null

$current = Get-ScheduledTask -TaskName $TaskName
if ([string]$current.Actions.Execute -notmatch '(?i)wscript') {
  throw "A regisztracio nem a rejtett inditot allitotta be: $($current.Actions.Execute)"
}

Write-Host "'$TaskName' újraregisztrálva rejtett indítóval ($Cadence $Time)." -ForegroundColor Green
Write-Host ("  Execute:   " + $current.Actions.Execute)
Write-Host ("  Arguments: " + $current.Actions.Arguments)
Write-Host '  Ellenőrzés: a következő futásnál nem jelenhet meg konzolablak.'

$info = $current | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
if ($info) { Write-Host ("  Következő futás: " + $info.NextRunTime) -ForegroundColor Cyan }
