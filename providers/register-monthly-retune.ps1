<#
.SYNOPSIS
    Havi modell-újrahangolás ütemezett Windows-feladatként.

.DESCRIPTION
    Létrehoz egy havi feladatot, ami lefuttatja a retune.mjs-t:
      1. lekérdezi minden provider élő modell-listáját,
      2. megkeresi az elhalt modell-id-ket,
      3. mentés után javítja a ~/.dsh/settings.yaml-t,
      4. riportot ír a providers/reports mappába.

    A DSH beépített ütemezője (dsh-schedule) erre NEM alkalmas: az emlékeztetőket
    egy élő sessionbe kézbesíti, fix intervallummal, és bezárt session esetén
    elavultan vár. A havi karbantartáshoz a Windows Feladatütemező a helyes
    eszköz, mert a DSH futásától függetlenül lefut.

    A regisztrálás a schtasks.exe-t használja, mert a New-ScheduledTaskTrigger
    a Windows PowerShell 5.1-ben nem tud havi triggert (csak Daily/Weekly).

.PARAMETER Time
    A futás időpontja HH:mm formában. Alapértelmezés: 09:00.

.PARAMETER Day
    A hónap napja (1-28). Alapértelmezés: 1. 28-nál nem lehet nagyobb, hogy
    minden hónapban létezzen.

.PARAMETER FirstRun
    Az első futás dátuma ÉÉÉÉ-HH-NN formában. Ha megadod, a Feladatütemező
    nem indul előbb. Alapértelmezés: nincs megkötés (a következő esedékes nap).

.PARAMETER DryRun
    Ha megadod, a feladat csak riportot készít (nem írja a settings.yaml-t).
    Az első hónapokra ez a biztonságosabb.

.PARAMETER Remove
    Törli az ütemezett feladatot.

.EXAMPLE
    .\register-monthly-retune.ps1
    .\register-monthly-retune.ps1 -Time 08:30 -Day 15
    .\register-monthly-retune.ps1 -FirstRun 2026-11-01
    .\register-monthly-retune.ps1 -DryRun
    .\register-monthly-retune.ps1 -Remove

.NOTES
    A Feladatütemező műveleteihez a DSH sandbox workspace-write módja nem ad
    hozzáférést; a szkriptet a szokásos PowerShell-ablakból kell futtatni.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^\d{1,2}:\d{2}$')][string]$Time = '09:00',
    [ValidateRange(1, 28)][int]$Day = 1,
    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$FirstRun = '',
    [switch]$DryRun,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'DSH model retune'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$retune = Join-Path $root 'retune.mjs'
$runner = Join-Path $root 'run-retune.ps1'
$shim = Join-Path $root 'run-retune.cmd'
$reportDir = Join-Path $root 'reports'
$logFile = Join-Path $reportDir 'retune-scheduled.log'

if ($Remove) {
    $out = & schtasks.exe /Delete /TN $TaskName /F 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "Törölve: '$TaskName'" -ForegroundColor Green }
    else { Write-Host "Nem sikerült törölni: $out" -ForegroundColor Yellow }
    return
}

if (-not (Test-Path $retune)) { throw "Nem találom: $retune" }
if (-not (Test-Path $runner)) { throw "Nem találom: $runner" }
if (-not (Test-Path $shim)) { throw "Nem találom: $shim" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "A 'node' nincs a PATH-on. Telepítsd a Node.js-t." }

if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir | Out-Null }

$mode = if ($DryRun) { 'report' } else { 'apply' }

# A schtasks /TR értéke legfeljebb 261 karakter, és a path szóközt tartalmaz —
# ezért a .cmd shimre hivatkozunk, ami maga hívja a PowerShell wrappert.
$tr = "`"$shim`" $mode"

if ($tr.Length -gt 261) {
    throw "A /TR túl hosszú ($($tr.Length) > 261). Rövidítsd a telepítési útvonalat."
}

# A PowerShell 5.1 szétdarabolja az idézőjeles natív argumentumokat, ezért a
# schtasks-et cmd.exe-n keresztül hívjuk, ami pontosan átadja a /TR értékét.
$quotedTr = $tr -replace '"', '\"'
$extra = ''
if ($FirstRun) {
    # /SD = kezdődátum: a feladat nem indul előbb ennél.
    $extra = " /SD $($FirstRun -replace '-', '/')"
}
$cmdLine = "schtasks.exe /Create /TN `"$TaskName`" /TR `"$quotedTr`" /SC MONTHLY /D $Day /ST $Time$extra /F"
$out = & cmd.exe /c $cmdLine 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "A regisztrálás nem sikerült:" -ForegroundColor Red
    $out | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Tipp: ha a hiba a jogosultságra utal, futtasd a szkriptet rendszergazdaként." -ForegroundColor Yellow
    exit 1
}

Write-Host "Ütemezett feladat létrehozva: '$TaskName'" -ForegroundColor Green
Write-Host "  Mikor:  minden hónap $Day. napján, $Time$(if ($FirstRun) { "  (első futás: $FirstRun)" })" -ForegroundColor Gray
Write-Host "  Indító: $shim $mode" -ForegroundColor Gray
Write-Host "  Mód:    $(if ($DryRun) { 'CSAK RIPORT (DryRun)' } else { 'javítás is (--apply)' })" -ForegroundColor Gray
Write-Host "  Napló:  $logFile" -ForegroundColor Gray
Write-Host "  Riport: $reportDir" -ForegroundColor Gray
Write-Host ""
$next = (& schtasks.exe /Query /TN $TaskName /FO LIST 2>&1 | Select-String 'Next Run Time' | Select-Object -First 1)
if ($next) { Write-Host "Tényleges következő futás: $($next.ToString().Trim())" -ForegroundColor Cyan }
Write-Host ""
Write-Host "Ellenőrzés:        schtasks /Query /TN `"$TaskName`" /V /FO LIST" -ForegroundColor DarkGray
Write-Host "Azonnali próba:    schtasks /Run /TN `"$TaskName`"" -ForegroundColor DarkGray
Write-Host "Törlés:            .\register-monthly-retune.ps1 -Remove" -ForegroundColor DarkGray
