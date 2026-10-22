<#
.SYNOPSIS
  A "HáziRobot due" ütemezett feladat újraregisztrálása REJTETT indítóval.

.DESCRIPTION
  MÉRT HIBA (2026-10-22 23:31:01): a feladat művelete közvetlenül a
  powershell.exe volt (`-WindowStyle Hidden -File ...\run-job.ps1 due`), és a
  konzolablak láthatóan létrejött, elvette a fókuszta (a foreground a
  powershell ConsoleWindowClass ablaka lett), majd a PowerShell elrejtette —
  15 percenként egy fél másodperces villanás. A `-WindowStyle Hidden` csak a
  létrehozás UTÁN hívja a ShowWindow(SW_HIDE)-ot.

  Ez a szkript ugyanazt az ütemezést (15 percenként) ugyanarra a szkriptre
  állítja, de `wscript.exe //nologo run-job-hidden.vbs`-en keresztül: a wscript
  `Run(cmd, 0, True)` egyáltalán nem hoz létre konzolablakot.

  Normál PowerShell-ablakból futtasd: a DSH sandboxa nem ér el CIM-et, ezért
  a ScheduledTasks modul ott nem működik.

.EXAMPLE
  .\register-hidden-task.ps1
  .\register-hidden-task.ps1 -DryRun
  .\register-hidden-task.ps1 -TaskName 'HáziRobot due' -EveryMinutes 15
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'HáziRobot due',
  [int]$EveryMinutes = 15,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$bot = $PSScriptRoot
$vbs = Join-Path $bot 'run-job-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

if (-not (Test-Path $vbs)) { throw "Hiányzik a rejtett indító: $vbs" }
if (-not (Test-Path $wscript)) { throw "Nem találom: $wscript" }

if ($DryRun) {
  Write-Host '(dry-run) Ezt regisztralnam:'
  Write-Host "  TaskName:   $TaskName"
  Write-Host "  Execute:    $wscript"
  Write-Host "  Arguments:  //nologo `"$vbs`" due"
  Write-Host "  Ismetles:   $EveryMinutes perc"
  return
}

$action = New-ScheduledTaskAction -Execute $wscript -Argument "//nologo `"$vbs`" due" -WorkingDirectory $bot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "'$TaskName' újraregisztrálva rejtett indítóval ($EveryMinutes percenként)." -ForegroundColor Green
$current = Get-ScheduledTask -TaskName $TaskName
Write-Host ("  Execute:   " + $current.Actions.Execute)
Write-Host ("  Arguments: " + $current.Actions.Arguments)
Write-Host '  Ellenőrzés: a következő futásnál nem jelenhet meg konzolablak.'
