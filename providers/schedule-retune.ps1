<#
.SYNOPSIS
    A modell-újrahangoló ütemezett feladat beállítása: napi vagy heti.

.DESCRIPTION
    Két ütem áll rendelkezésre:

      -Daily    minden nap 09:00-kor (a fejlesztési időszakra, behangoláshoz)
      -Weekly   hetente egyszer 09:00-kor (a későbbi, beállt állapotra)

    A feladat a run-retune.cmd-t hívja, ami:
      1. retune.mjs — elhalt modell-id-k felderítése és javítása,
      2. clean-webview2-profiles.ps1 — a felhalmozódott WebView2-profilok
         tisztítása (a DshWindow nem takarít maga után).

    A `-DryRun` mód csak riportot ír; enélkül a settings.yaml is módosul
    (mentés után).

    FIGYELEM: ez a szkript a Windows Feladatütemezőt használja. A DSH
    beépített ütemezője (dsh-schedule) erre nem alkalmas: egy élő sessionbe
    kézbesít, és bezárt session esetén elavultan vár.

.PARAMETER Cadence
    Daily vagy Weekly.

.PARAMETER Time
    Futás időpontja HH:mm formában. Alapértelmezés: 09:00.

.PARAMETER DryRun
    Csak riport, ne módosítsa a settings.yaml-t.

.PARAMETER FirstRun
    Az első futás dátuma ÉÉÉÉ-HH-NN formában.

.PARAMETER Remove
    Törli az ütemezett feladatot.

.EXAMPLE
    .\schedule-retune.ps1 -Cadence Daily
    .\schedule-retune.ps1 -Cadence Weekly
    .\schedule-retune.ps1 -Cadence Daily -DryRun
    .\schedule-retune.ps1 -Remove
#>
[CmdletBinding()]
param(
    [ValidateSet('Daily', 'Weekly')][string]$Cadence = 'Daily',
    [ValidatePattern('^\d{1,2}:\d{2}$')][string]$Time = '09:00',
    [string]$FirstRun = '',
    [switch]$DryRun,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'DSH model retune'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$shim = Join-Path $root 'run-retune.cmd'

if ($Remove) {
    $out = & cmd.exe /c "schtasks.exe /Delete /TN `"$TaskName`" /F" 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "Törölve: '$TaskName'" -ForegroundColor Green }
    else { Write-Host "Nem sikerült törölni: $out" -ForegroundColor Yellow }
    return
}

if (-not (Test-Path $shim)) { throw "Nem találom: $shim" }

$mode = if ($DryRun) { 'report' } else { 'apply' }
$tr = "`"$shim`" $mode"

# A schtasks /TR értéke legfeljebb 261 karakter; a shim ezt bőven alatta tartja.
if ($tr.Length -gt 261) { throw "A /TR túl hosszú ($($tr.Length) > 261)." }

$schedule = if ($Cadence -eq 'Daily') { '/SC DAILY' } else { '/SC WEEKLY /MO 7' }
$startDate = ''
if ($FirstRun) { $startDate = " /SD $($FirstRun -replace '-', '/')" }

$quotedTr = $tr -replace '"', '\"'
$cmdLine = "schtasks.exe /Create /TN `"$TaskName`" /TR `"$quotedTr`" $schedule /ST $Time$startDate /F"

$out = & cmd.exe /c $cmdLine 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "A regisztrálás nem sikerült:" -ForegroundColor Red
    $out | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

Write-Host "Ütemezett feladat beállítva: '$TaskName'" -ForegroundColor Green
Write-Host "  Ütem:   $(if ($Cadence -eq 'Daily') { 'NAPONTA' } else { 'HETENTE (7 naponta)' }) $Time-kor" -ForegroundColor Gray
Write-Host "  Mód:    $(if ($DryRun) { 'CSAK RIPORT' } else { 'javítás is (mentés után)' })" -ForegroundColor Gray
Write-Host "  Indító: $shim $mode" -ForegroundColor Gray
Write-Host ""
$next = (& cmd.exe /c "schtasks.exe /Query /TN `"$TaskName`" /FO LIST" 2>&1 | Select-String 'Next Run Time' | Select-Object -First 1)
if ($next) { Write-Host "Következő futás: $($next.ToString().Trim())" -ForegroundColor Cyan }
Write-Host ""
Write-Host "Átállás a másik ütemre:  .\schedule-retune.ps1 -Cadence Weekly" -ForegroundColor DarkGray
Write-Host "Törlés:                  .\schedule-retune.ps1 -Remove" -ForegroundColor DarkGray
