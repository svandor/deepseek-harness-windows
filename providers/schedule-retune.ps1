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

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$hidden = Join-Path $root 'register-hidden-retune.ps1'
$vbs    = Join-Path $root 'run-retune-hidden.vbs'

if ($Remove) {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Törölve: '$TaskName'" -ForegroundColor Green
    } catch {
        $out = & cmd.exe /c "schtasks.exe /Delete /TN `"$TaskName`" /F" 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Host "Törölve: '$TaskName'" -ForegroundColor Green }
        else { Write-Host "Nem sikerült törölni: $out" -ForegroundColor Yellow }
    }
    return
}

if (-not (Test-Path $hidden)) { throw "Nem találom: $hidden" }
if (-not (Test-Path $vbs))    { throw "Nem találom: $vbs" }

# ===========================================================================
# 2026-10-28 JAVÍTÁS — A FÓKUSZLOPÁS MEGSZÜNTETVE
#
# KORÁBBAN: a feladat művelete `"<root>\run-retune.cmd" <mode>` volt. A Task
# Scheduler a .cmd-hez konzolt hoz létre (fekete cmd.exe), a shim pedig egy
# második, látható powershell.exe-t indított (kék ablak) — 2026-10-28 09:00:01-kor
# két ablak vette el a fókuszt, és 09:09-ig látszott.
#
# MOST: a regisztráció a `wscript.exe //nologo run-retune-hidden.vbs <mode>`
# indítóra áll, ami egyáltalán nem hoz létre konzolablakot. A .cmd shimre tehát
# NEM mutat többé feladat, és a jövőbeli újraregisztrálás is ezt használja.
# Kötelező minta és indoklás: ..\AGENTS.md 1. fejezet.
# ===========================================================================
$mode = if ($DryRun) { 'report' } else { 'apply' }

$registerArgs = @{
    TaskName = $TaskName
    Cadence  = $Cadence
    Time     = $Time
    Mode     = $mode
}
if ($FirstRun) { $registerArgs.FirstRun = $FirstRun }

& $hidden @registerArgs
exit $LASTEXITCODE
