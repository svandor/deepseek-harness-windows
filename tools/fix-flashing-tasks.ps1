<#
.SYNOPSIS
  Kiszűri (és opcionálisan javítja) azokat az ütemezett feladatokat, amelyek
  minden futáskor LÁTHATÓ konzolablakkal jelennek meg.

.DESCRIPTION
  MÉRT HIBA (2026-10-22 23:31:01, bot\README.md): ha a feladat művelete
  közvetlenül egy konzolprogram (powershell.exe / pwsh.exe / cmd.exe), akkor a
  Task Scheduler ÚJ, LÁTHATÓ konzolablakot hoz létre, és a PowerShell csak
  utána rejti el -> fél másodperces villanás, fókuszlopás. A `-WindowStyle
  Hidden` az argumentumban NEM véd, mert a létrehozás után fut le.

  Ez a szkript végigolvassa az összes ütemezett feladatot, és kilistázza a
  "villanás-gyanús" műveleteket. Alapból CSAK JELENT (nem módosít). A -Apply
  kapcsolóval a $FixTaskMatch nevekre illeszkedő feladatok műveletét átírja a
  rejtett wscript-indítóra (tools\run-hidden.vbs).

  Fontos: a DSH sandboxában a Get-ScheduledTask CIM-hozzáférése megtagadott
  ("Az ügyfél nem fér hozzá CIM-erőforráshoz"), ezért ezt NORMÁL PowerShell-
  ablakból futtasd (a módosításhoz rendszergazdai ablak kell).

.EXAMPLE
  .\tools\fix-flashing-tasks.ps1

.EXAMPLE
  .\tools\fix-flashing-tasks.ps1 -Apply
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string[]]$FixTaskMatch = @('delegation-metrics', 'delegation metrics', 'DSH delegation'),
  [string]$Launcher = (Join-Path $PSScriptRoot 'run-hidden.vbs')
)

$ErrorActionPreference = 'Stop'

try {
  $tasks = Get-ScheduledTask -ErrorAction Stop
} catch {
  Write-Host 'NEM FUTOTT: a Get-ScheduledTask nem érhető el ebben a folyamatban.' -ForegroundColor Yellow
  Write-Host "  ok: $($_.Exception.Message)"
  Write-Host '  -> futtasd NORMÁL PowerShell-ablakból (a DSH sandboxából a CIM tiltott).'
  exit 2
}

# Konzolprogramok: ezeknél a Task Scheduler látható konzolablakot hoz létre.
$consoleExes = @('powershell.exe', 'pwsh.exe', 'cmd.exe', 'cscript.exe')

$rows = foreach ($t in $tasks) {
  foreach ($a in $t.Actions) {
    if (-not $a.Execute) { continue }
    $exe = $a.Execute.Trim('"')
    $leaf = try { Split-Path -Leaf $exe } catch { $exe }
    $suspect = $consoleExes -contains $leaf.ToLowerInvariant()
    [pscustomobject]@{
      Task     = "$($t.TaskPath)$($t.TaskName)"
      Suspect  = $suspect
      Execute  = $a.Execute
      Args     = $a.Arguments
      WorkDir  = $a.WorkingDirectory
      State    = $t.State
    }
  }
}

$bad = $rows | Where-Object Suspect
Write-Host ''
Write-Host ("Összes művelet: {0}   villanás-gyanús: {1}" -f $rows.Count, $bad.Count) -ForegroundColor Cyan
Write-Host ''
if ($bad.Count -eq 0) {
  Write-Host 'Nincs olyan ütemezett feladat, amely közvetlenül konzolprogramot indít.' -ForegroundColor Green
} else {
  $bad | Select-Object Task, State, Execute, Args, WorkDir | Format-Table -AutoSize -Wrap
}

# Ismert, NEM a miénk: Intel System Usage Report (SUR) -- a beszállító hibája,
# a task.xml-ben `powershell -Command "Start-Process -WindowStyle Hidden task.bat"`.
$intel = $bad | Where-Object { $_.Args -match 'task\.bat' }
if ($intel) {
  Write-Host ''
  Write-Host 'Intel SUR (System Usage Report) feladat — beszállítói hiba, nem a projekté:' -ForegroundColor Yellow
  $intel | Select-Object Task, Args | Format-Table -AutoSize -Wrap
  Write-Host '  Javítás: tiltsd le (rendszergazda):  schtasks /change /tn "<név>" /DISABLE'
  Write-Host '  vagy távolítsd el az Intel SUR komponenst (Vezérlőpult -> Programok).'
}

if (-not $Apply) {
  Write-Host ''
  Write-Host 'Csak jelentés készült (nem módosítottam). Javításhoz: -Apply' -ForegroundColor Cyan
  return
}

if (-not (Test-Path $Launcher)) { throw "Hiányzik a rejtett indító: $Launcher" }
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

foreach ($b in $bad) {
  $match = $false
  foreach ($m in $FixTaskMatch) { if ($b.Task -like "*$m*") { $match = $true } }
  if (-not $match) { Write-Host "KIHAGYVA (nem illeszkedik): $($b.Task)" -ForegroundColor DarkGray; continue }

  $name = Split-Path -Leaf $b.Task
  $inner = '//nologo "{0}" "{1}" {2}' -f $Launcher, $b.Execute, $b.Args
  $newAction = New-ScheduledTaskAction -Execute $wscript -Argument $inner -WorkingDirectory $b.WorkDir
  Set-ScheduledTask -TaskName $name -Action $newAction | Out-Null
  $check = (Get-ScheduledTask -TaskName $name).Actions[0]
  Write-Host "JAVÍTVA: $name" -ForegroundColor Green
  Write-Host ("  most: {0} {1}" -f $check.Execute, $check.Arguments)
}

Write-Host ''
Write-Host 'Kész. Ellenőrzés: futtasd a tools\watch-visible-consoles.ps1-et a következő esedékes futás előtt.' -ForegroundColor Green
