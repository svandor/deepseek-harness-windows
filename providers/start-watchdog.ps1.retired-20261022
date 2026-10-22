<#
.SYNOPSIS
    A subagent proxy őrködő ciklusának elindítása LEVÁLASZTVA, láthatatlanul.

.DESCRIPTION
    MIÉRT LEVÁLASZTVA: a mért hiba szerint a proxy egy folyamatfa részeként
    indult (parancsikon -> cmd -> powershell -> node), és a fa bármely tagjának
    lezárása magával vitte — minden hibaüzenet nélkül. A megoldás nem az, hogy
    ugyanígy indítunk egy másik folyamatot, hanem hogy az őrködő ciklus
    FÜGGETLEN, saját konzol nélküli folyamatként fusson, és maga javítsa a
    proxy kiesését.

    A szkript ezért:
      1. megnézi, fut-e már őrködő ciklus (reports\proxy-watchdog.pid + élő PID),
         és ha igen, nem indít másodikat,
      2. elindítja a watchdog-subagent-proxy.ps1-et -WindowStyle Hidden -Quiet
         kapcsolókkal (nem villan fel ablak),
      3. rövid várakozás után ellenőrzi, hogy a folyamat tényleg fut-e.

    A watchdog maga is figyeli az őrködő PID-fájlt, ezért a dupla indítás
    nem okoz dupla ellenőrzést.

.PARAMETER IntervalSeconds
    Az őrködés gyakorisága. Alapértelmezés: 60.

.PARAMETER Force
    Akkor is indít, ha a PID-fájl élő folyamatra mutat.

.EXAMPLE
    .\start-watchdog.ps1
    .\start-watchdog.ps1 -Force
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 60,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $root 'watchdog-subagent-proxy.ps1'
$reportDir = Join-Path $root 'reports'
$pidFile = Join-Path $reportDir 'proxy-watchdog.pid'
$logFile = Join-Path $reportDir 'proxy-watchdog.log'

if (-not (Test-Path $watchdog)) { throw "Nem találom: $watchdog" }
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }

# ── már fut? ──────────────────────────────────────────────────────────────
if ((Test-Path $pidFile) -and -not $Force) {
    $existing = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($existing -match '^\d+$') {
        $proc = Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match 'powershell|pwsh') {
            Write-Host "Az őrködő ciklus már fut (PID $existing). Nincs teendő." -ForegroundColor Green
            exit 0
        }
    }
    Write-Host "A PID-fájl ($existing) már nem élő folyamatra mutat — új ciklus indul." -ForegroundColor Yellow
}

# ── indítás leválasztva ───────────────────────────────────────────────────
$wdArgs = @(
    '-NoProfile'
    '-NonInteractive'
    '-ExecutionPolicy', 'Bypass'
    '-WindowStyle', 'Hidden'
    '-File', "`"$watchdog`""
    '-IntervalSeconds', "$IntervalSeconds"
    '-Quiet'
)

$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $wdArgs `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 2

if ($proc.HasExited) {
    Write-Host "Az őrködő ciklus azonnal leállt (kilépési kód: $($proc.ExitCode))." -ForegroundColor Red
    if (Test-Path $logFile) {
        Write-Host "Napló (utolsó sorok):" -ForegroundColor DarkGray
        Get-Content $logFile -Tail 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
    exit 1
}

Write-Host "Őrködő ciklus elindítva (PID $($proc.Id), $IntervalSeconds s)." -ForegroundColor Green
Write-Host "  Napló: $logFile" -ForegroundColor Gray
Write-Host "  Leállítás: Stop-Process -Id $($proc.Id)" -ForegroundColor DarkGray
exit 0
