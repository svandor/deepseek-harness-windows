<#
.SYNOPSIS
  A "HáziRobot due" ütemezett feladat újraregisztrálása REJTETT indítóval.

.DESCRIPTION
  KÉT külön hiba van ebben a feladatban, mindkettő mért:

  1) LÁTHATÓ KONZOL (2026-10-22 23:31:01): a művelet közvetlenül a
     powershell.exe volt, ezért a konzol láthatóan létrejött, elvette a
     fókuszta, majd a PowerShell elrejtette. A `-WindowStyle Hidden` csak a
     létrehozás UTÁN hív ShowWindow(SW_HIDE)-ot.
     MEGOLDÁS: `wscript.exe //nologo run-job-hidden.vbs` — a wscript
     `Run(cmd, 0, True)` egyáltalán nem hoz létre konzolt.

  2) HALOTT ÜTEMEZŐ: a bot naplójában 2026-10-02 és 2026-10-28 között EGYETLEN
     `job:` sor sincs, és a hétfői (10-26) 07:00-s esedékes job sem futott le.
     A feladat tehát nem tüzelt. A régi triggert a
     `New-ScheduledTaskTrigger -Once -At ... -RepetitionInterval 15min` állította
     elő, `StopAtDurationEnd=true` értékkel. Az új regisztráció ezt
     `StopAtDurationEnd=false`-ra állítja, és a schtasks nem tesz Duration-t a
     repetícióba -> az ismétlés végtelen.
     MEGOLDÁS: `schtasks /SC MINUTE /MO 15`.

  FONTOS TANULSÁG (2026-10-28, saját hiba): a task XML-ben a `<Duration>`
  MÁSHOL is szerepel — a `<Settings><IdleSettings><Duration>PT10M</Duration>`
  a Task Scheduler ALAPÉRTELMEZETT idle-durationje, semmi köze a repetícióhoz.
  A dokumentum-szintű regex ezért félrevezet. Mindig a
  `<Triggers> -> <TimeTrigger> -> <Repetition>` blokkon belül kell olvasni.

  Normál PowerShell-ablakból futtasd: a DSH sandboxa nem ér el CIM-et, ezért a
  ScheduledTasks modul ott nem működik.

.EXAMPLE
  .\register-hidden-task.ps1
  .\register-hidden-task.ps1 -Verify
  .\register-hidden-task.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'HáziRobot due',
  [int]$EveryMinutes = 15,
  [switch]$DryRun,
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$bot = $PSScriptRoot
$vbs = Join-Path $bot 'run-job-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$taskFile = Join-Path $env:SystemRoot "System32\Tasks\$TaskName"
$taskArgs = 'due'

function Get-RepetitionInfo([string]$Xml) {
  # CSAK a <Triggers> -> <Repetition> blokkon belül olvasunk (lásd a fenti
  # tanulságot: az IdleSettings.Duration PT10M álpozitív).
  $triggers = [regex]::Match($Xml, '(?s)<Triggers>(.*?)</Triggers>').Groups[1].Value
  $rep = [regex]::Match($triggers, '(?s)<Repetition>(.*?)</Repetition>').Groups[1].Value
  $read = {
    param($name)
    $m = [regex]::Match($rep, "(?s)<$name>(.*?)</$name>")
    if ($m.Success) { $m.Groups[1].Value.Trim() } else { '' }
  }
  [pscustomobject]@{
    HasRepetition = [bool]$rep
    Interval      = & $read 'Interval'
    Duration      = & $read 'Duration'
    StopAtEnd     = & $read 'StopAtDurationEnd'
  }
}

function Get-SettingsInfo([string]$Xml) {
  $s = [regex]::Match($Xml, '(?s)<Settings>(.*?)</Settings>').Groups[1].Value
  $read = {
    param($name)
    $m = [regex]::Match($s, "(?s)<$name>(.*?)</$name>")
    if ($m.Success) { $m.Groups[1].Value.Trim() } else { '' }
  }
  [pscustomobject]@{
    DisallowBattery    = & $read 'DisallowStartIfOnBatteries'
    StopOnBattery      = & $read 'StopIfGoingOnBatteries'
    StartWhenAvailable = & $read 'StartWhenAvailable'
    Enabled            = & $read 'Enabled'
  }
}

function Test-TaskAction([string]$Cmd, [string]$Arg) {
  $problems = @()
  if ($Cmd -notmatch '(?i)wscript\.exe$') {
    $problems += "a muvelet NEM wscript.exe (""$Cmd"") -> konzolablak johet letre"
  }
  if ($Arg -notmatch '(?i)-hidden\.vbs') {
    $problems += "az argumentumban nincs *-hidden.vbs (`"$Arg`") -> nem garantalt a rejtett inditas"
  }
  $problems
}

if ($Verify) {
  if (-not (Test-Path $taskFile)) {
    Write-Host "Nincs ilyen feladat: '$TaskName' ($taskFile)" -ForegroundColor Yellow
    exit 1
  }
  $xml = Get-Content $taskFile -Raw
  $cmd = [regex]::Match($xml, '<Command>(.*?)</Command>').Groups[1].Value.Trim()
  $arg = [regex]::Match($xml, '<Arguments>(.*?)</Arguments>').Groups[1].Value.Trim()
  $rep = Get-RepetitionInfo $xml

  Write-Host "Feladat:    $TaskName"
  Write-Host "  Command:    $cmd"
  Write-Host "  Arguments:  $arg"
  Write-Host "  Repetíció:  $(if ($rep.HasRepetition) { 'van' } else { 'NINCS' })"
  Write-Host "  Interval:   $($rep.Interval)"
  Write-Host "  Duration:   $(if ($rep.Duration) { $rep.Duration } else { '(nincs = vegtelen ismetles)' })"
  Write-Host "  StopAtEnd:  $(if ($rep.StopAtEnd) { $rep.StopAtEnd } else { '(nincs)' })"

  $st = Get-SettingsInfo $xml
  Write-Host "  Akksi-tiltás: $(if ($st.DisallowBattery) { $st.DisallowBattery } else { '(nincs)' })  StopOnBattery: $(if ($st.StopOnBattery) { $st.StopOnBattery } else { '(nincs)' })  StartWhenAvailable: $(if ($st.StartWhenAvailable) { $st.StartWhenAvailable } else { '(nincs)' })  Enabled: $($st.Enabled)"

  $problems = @(Test-TaskAction $cmd $arg)
  if ($st.DisallowBattery -match '(?i)true') {
    $problems += 'DisallowStartIfOnBatteries=true — LAPTOPON akkumulátorról a feladat soha nem indul (ez a schtasks alapértelmezése)'
  }
  if ($st.StopOnBattery -match '(?i)true') {
    $problems += 'StopIfGoingOnBatteries=true — ha lecsatlakozik a töltő, a futás leáll'
  }
  if ($st.StartWhenAvailable -match '(?i)false' -or -not $st.StartWhenAvailable) {
    $problems += 'StartWhenAvailable nincs bekapcsolva — a kihagyott futás nem pótlódik'
  }
  if ($st.Enabled -match '(?i)false') {
    $problems += 'a feladat le van tiltva (Settings/Enabled=false)'
  }
  if (-not $rep.HasRepetition -or -not $rep.Interval) {
    $problems += 'nincs repetício/interval -> a feladat csak egyszer fut'
  }
  if ($rep.Duration) {
    $problems += "van Duration ($($rep.Duration)) a repetícióban -> az ismétlés a duration végén megállhat (a schtasks megoldásnál nincs ilyen)"
  }
  if ($rep.StopAtEnd -match '(?i)true' -and -not $rep.Duration) {
    $problems += 'StopAtDurationEnd=true Duration nélkül — ez volt a 2026-10-22..10-28 közti néma leállás állapota'
  }

  if ($problems.Count -eq 0) {
    Write-Host '  ALLAPOT: HELYES — rejtett indító, vegtelen ismetles.' -ForegroundColor Green
    exit 0
  }
  foreach ($p in $problems) { Write-Host "  HIBA: $p" -ForegroundColor Red }
  Write-Host '  ALLAPOT: JAVITANDO — futtasd: .\register-hidden-task.ps1' -ForegroundColor Red
  exit 2
}

if (-not (Test-Path $vbs)) { throw "Hiányzik a rejtett indító: $vbs" }
if (-not (Test-Path $wscript)) { throw "Nem találom: $wscript" }

$tr = "$wscript //nologo `"$vbs`" $taskArgs"
if ($tr.Length -gt 261) { throw "A /TR túl hosszú ($($tr.Length) > 261)." }
$quotedTr = $tr -replace '"', '\"'

if ($DryRun) {
  Write-Host '(dry-run) Ezt regisztralnam (schtasks, nincs Duration a repetícióban -> vegtelen):'
  Write-Host "  schtasks /Create /TN `"$TaskName`" /TR `"$quotedTr`" /SC MINUTE /MO $EveryMinutes /F"
  return
}

# A PowerShell 5.1 szétdarabolja az idézőjeleket, ezért cmd.exe-n keresztül hívjuk.
$cmdLine = "schtasks.exe /Create /TN `"$TaskName`" /TR `"$quotedTr`" /SC MINUTE /MO $EveryMinutes /F"
$out = & cmd.exe /c $cmdLine 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host 'A regisztrálás nem sikerült:' -ForegroundColor Red
  $out | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Write-Host '  Tipp: futtasd rendszergazdaként.' -ForegroundColor Yellow
  exit 1
}

Write-Host "'$TaskName' újraregisztrálva (schtasks /SC MINUTE /MO $EveryMinutes, rejtett indító)." -ForegroundColor Green
Write-Host "  Művelet:   $tr"

# ---------------------------------------------------------------------------
# 3) ÜTEMEZÉSI FELTÉTELEK — a schtasks ezt RONTJA EL
# A `schtasks /Create` a task XML-be `<DisallowStartIfOnBatteries>true</...>`-t
# és `<StartWhenAvailable>false</...>`-t tesz. LAPTOPON ez azt jelenti, hogy
# akkumulátorról a feladat SOHA nem indul — pontosan ez a különbség a működő
# `DSH model retune` (false/false/true) és a halott `HáziRobot due` között.
# ---------------------------------------------------------------------------
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $s = $task.Settings
  $s.DisallowStartIfOnBatteries = $false
  $s.StopIfGoingOnBatteries = $false
  $s.StartWhenAvailable = $true
  Set-ScheduledTask -TaskName $TaskName -Settings $s | Out-Null
  Write-Host '  Feltételek: akksi-tiltás kikapcsolva, StartWhenAvailable bekapcsolva.' -ForegroundColor Green
} catch {
  Write-Host "  FIGYELEM: a feltételeket nem tudtam javítani: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '  Futtasd ezt normál PowerShell-ablakból (rendszergazdaként):' -ForegroundColor Yellow
  Write-Host "    `$s = (Get-ScheduledTask -TaskName '$TaskName').Settings" -ForegroundColor DarkGray
  Write-Host '    $s.DisallowStartIfOnBatteries = $false; $s.StopIfGoingOnBatteries = $false; $s.StartWhenAvailable = $true' -ForegroundColor DarkGray
  Write-Host "    Set-ScheduledTask -TaskName '$TaskName' -Settings `$s" -ForegroundColor DarkGray
}

# Azonnali ellenőrzés a task XML-ből — csak a <Repetition> blokkra.
if (Test-Path $taskFile) {
  $rep = Get-RepetitionInfo (Get-Content $taskFile -Raw)
  Write-Host "  Ellenőrzés: Interval=$($rep.Interval), Duration=$(if ($rep.Duration) { $rep.Duration } else { '(nincs)' }), StopAtEnd=$(if ($rep.StopAtEnd) { $rep.StopAtEnd } else { '(nincs)' })"
  if ($rep.Duration) {
    Write-Host '  FIGYELEM: a repetícióban mégis van Duration — az ismétlés megállhat!' -ForegroundColor Yellow
  } elseif ($rep.StopAtEnd -match '(?i)true') {
    Write-Host '  FIGYELEM: StopAtDurationEnd=true — ez volt a néma leállás állapota!' -ForegroundColor Yellow
  } else {
    Write-Host '  Rendben: nincs Duration, StopAtEnd=false -> az ismétlés végtelen.' -ForegroundColor Green
  }
}
