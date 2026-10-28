<#
.SYNOPSIS
    Heti automatikus újramérés és optimalizálás ütemezett Windows-feladatként.

.DESCRIPTION
    Létrehoz egy heti feladatot, ami a run-autotune.cmd shim-en keresztül
    lefuttatja az autotune.mjs-t (--apply):
      - újramér a valós session-naplókból,
      - újraszámolja és beírja a szelektor hangolási paramétereit,
      - ellenőrzi az élő provider-katalógusokat,
      - összeveti a gyári árlistát (árat nem ír),
      - riportot és trendet készít.

    Miért Windows Feladatütemező: a DSH-tól függetlenül fut, és a proxy
    config-hot-reloadja miatt a hangolás restart nélkül életbe lép.

.PARAMETER Time
    Futás időpontja HH:mm formában. Alapértelmezés: 04:30.

.PARAMETER Day
    A hét napja (MON..SUN). Alapértelmezés: SUN.

.PARAMETER Remove
    Törli az ütemezett feladatot.

.EXAMPLE
    .\register-weekly-autotune.ps1
    .\register-weekly-autotune.ps1 -Time 05:15 -Day SAT
    .\register-weekly-autotune.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$Time = '04:30',
    [ValidateSet('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')]
    [string]$Day = 'SUN',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'DSH-AutoTune'
$shim = Join-Path $root 'run-autotune.cmd'
$vbs  = Join-Path $root 'run-autotune-hidden.vbs'

if ($Remove) {
    $out = & schtasks.exe /Delete /TN $TaskName /F 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Host "Törölve: $TaskName" -ForegroundColor Green }
    else { Write-Host "Nem sikerült törölni (talán nem is létezett):" -ForegroundColor Yellow; $out | ForEach-Object { Write-Host "  $_" } }
    return
}

if (-not (Test-Path $shim)) { throw "Hiányzik a shim: $shim" }
if (-not (Test-Path $vbs))  { throw "Hiányzik a rejtett indító: $vbs" }

# 2026-10-28 JAVÍTÁS — A FÓKUSZLOPÁS MEGSZÜNTETVE.
# KORÁBBAN: a /TR közvetlenül a run-autotune.cmd shimre mutatott -> a Task
# Scheduler LÁTHATÓ fekete cmd konzolt hozott létre minden futáskor.
# MOST: a művelet a wscript + run-autotune-hidden.vbs rejtett indítóra mutat,
# ami egyáltalán nem hoz létre konzolablakot (a .cmd logikája változatlan).
# Szabály: ..\AGENTS.md 1. fejezet.
$tr = "wscript.exe //nologo `"$vbs`""
if ($tr.Length -gt 261) { throw "A /TR túl hosszú ($($tr.Length) > 261)." }
$quotedTr = $tr -replace '"', '\"'
$cmdLine = "schtasks.exe /Create /TN `"$TaskName`" /TR `"$quotedTr`" /SC WEEKLY /D $Day /ST $Time /F"
$out = & cmd.exe /c $cmdLine 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "A regisztrálás nem sikerült:" -ForegroundColor Red
    $out | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "`nTipp: futtasd a szkriptet rendszergazdaként, vagy kézzel:" -ForegroundColor Yellow
    Write-Host "  schtasks /Create /TN $TaskName /TR `"wscript.exe //nologo \`"$vbs\`"`" /SC WEEKLY /D $Day /ST $Time /F" -ForegroundColor DarkGray
    exit 1
}

Write-Host "Ütemezett feladat létrehozva: '$TaskName'" -ForegroundColor Green
Write-Host "  Mikor:  minden hét $Day napján, $Time" -ForegroundColor Gray
Write-Host "  Mit:    $vbs -> $shim (autotune.mjs --days 30 --apply)" -ForegroundColor Gray
$next = (& schtasks.exe /Query /TN $TaskName /FO LIST 2>&1 | Select-String 'Next Run Time' | Select-Object -First 1)
if ($next) { Write-Host "  $($next.ToString().Trim())" -ForegroundColor Gray }
Write-Host "`nAzonnali próba: schtasks /Run /TN `"$TaskName`"" -ForegroundColor DarkGray
Write-Host "Kimenet:        providers\autotune.out.log és providers\reports\autotune-*.json" -ForegroundColor DarkGray
