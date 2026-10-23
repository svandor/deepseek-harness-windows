<#
.SYNOPSIS
  Kiveszi az utemezesbol az Intel SUR 3 orankent felugro konzolablakanak forrasat.

.DESCRIPTION
  A kiváltó: C:\Program Files\Intel\SUR\QUEENCREEK\x64\task.xml -> a
  "USER_ESRV_SVC_QUEENCREEK" feladat (SYSTEM, LogonTrigger +4 perc kesleltetes,
  PT3H ismétlés) művelete:
      powershell -Command "Start-Process -WindowStyle Hidden task.bat"
  A Task Scheduler LATHATO konzolablakot ad ennek a powershell.exe-nek, ezert
  villan fel 3 orankent (01:10:52, 04:10:52, 07:10:52, 10:10:52 ...).

  A szkript NEM nev, hanem MŰVELET alapjan keres (a név Intel-verziónként
  eltérhet): minden feladatot kiszed, amelynek argumentuma 'task.bat', vagy
  amelynek munkakonyvtara az Intel\SUR mappa alatt van.

  Futtatas: RENDSZERGAZDAI PowerShell-ablakban (a feladat SYSTEM-kezelt).
    Win+X -> "Terminal (rendszergazda)"

.PARAMETER Disable
  Nem torol, csak letilt (visszafordithato).

.PARAMETER DryRun
  Csak listaz, nem modosit.

.EXAMPLE
  .\tools\remove-intel-sur-task.ps1 -DryRun
  .\tools\remove-intel-sur-task.ps1
  .\tools\remove-intel-sur-task.ps1 -Disable
#>
[CmdletBinding()]
param(
  [switch]$Disable,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# --- 0) rendszergazdai token? ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'RENDSZERGAZDAI ablak kell: a feladat SYSTEM-kezelt.' -ForegroundColor Yellow
  Write-Host '  Win+X -> "Terminal (rendszergazda)", majd futtasd ujra ezt a fajlt.'
  Write-Host '  (Vagy a mostani ablakbol: Start-Process powershell -Verb RunAs ...)'
  exit 1
}

if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
  Write-Host 'A ScheduledTasks modul nem erheto el ebben a folyamatban.' -ForegroundColor Yellow
  exit 2
}

# --- 1) kereses muvelet alapjan ---
try {
  $all = Get-ScheduledTask -ErrorAction Stop
} catch {
  Write-Host 'A Get-ScheduledTask nem megy (CIM-hozzaferes megtagadva).' -ForegroundColor Yellow
  Write-Host "  ok: $($_.Exception.Message)"
  exit 2
}

$hits = foreach ($t in $all) {
  foreach ($a in $t.Actions) {
    if ($a.Arguments -like '*task.bat*' -or $a.WorkingDirectory -like '*Intel\SUR*') {
      [pscustomobject]@{
        TaskPath         = $t.TaskPath
        TaskName         = $t.TaskName
        State            = $t.State
        Execute          = $a.Execute
        Arguments        = $a.Arguments
        WorkingDirectory = $a.WorkingDirectory
      }
    }
  }
}
$hits = @($hits | Sort-Object TaskPath, TaskName -Unique)

if ($hits.Count -eq 0) {
  Write-Host 'Nincs ilyen feladat az utemezesben - nincs mit torolni.' -ForegroundColor Green
  exit 0
}

Write-Host ("Talalt feladat(ok): {0}" -f $hits.Count) -ForegroundColor Cyan
$hits | Format-List

if ($DryRun) {
  Write-Host 'DryRun: csak listaztam, nem modositottam.' -ForegroundColor Cyan
  exit 0
}

# --- 2) torles / letiltas ---
foreach ($h in $hits) {
  if ($Disable) {
    Disable-ScheduledTask -TaskName $h.TaskName -TaskPath $h.TaskPath | Out-Null
    Write-Host ("LETILTVA: {0}{1}" -f $h.TaskPath, $h.TaskName) -ForegroundColor Green
  } else {
    Unregister-ScheduledTask -TaskName $h.TaskName -TaskPath $h.TaskPath -Confirm:$false
    Write-Host ("TOROLVE:  {0}{1}" -f $h.TaskPath, $h.TaskName) -ForegroundColor Green
  }
}

# --- 3) ellenorzes ---
$left = @(Get-ScheduledTask | Where-Object { $_.Actions.Arguments -like '*task.bat*' })
if ($left.Count -gt 0) {
  Write-Host 'FIGYELEM: maradt task.bat-os feladat:' -ForegroundColor Yellow
  $left | Select-Object TaskPath, TaskName, State | Format-Table -AutoSize
  exit 3
}

Write-Host 'OK: nincs tobb task.bat-os feladat az utemezesben.' -ForegroundColor Green

# --- 4) emlekezteto ---
$upd = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'IntelSURQC*' })
if ($upd.Count -gt 0) {
  Write-Host ''
  Write-Host 'Megjegyzes: az Intel SUR frissito feladatai megvannak (ezek nem villannak):' -ForegroundColor DarkGray
  $upd | Select-Object TaskPath, TaskName, State | Format-Table -AutoSize
  Write-Host '  Egy SUR-frissites ujra letrehozhatja a torolt task.xml feladatot -> futtasd ujra ezt a szkriptet.' -ForegroundColor DarkGray
}
