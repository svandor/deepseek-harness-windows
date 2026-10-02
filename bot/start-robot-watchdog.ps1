<#
.SYNOPSIS
    A Házirobot panel őrködő ciklusának elindítása LEVÁLASZTVA, láthatatlanul.

.DESCRIPTION
    Ugyanaz a minta, mint a `providers/start-watchdog.ps1`-nél, és ugyanazért:
    a folyamatfa bármely tagjának lezárása magával viszi a többit. Ezért az
    őrködő ciklus FÜGGETLEN, saját konzol nélküli folyamatként fut, és maga
    javítja a panel kiesését.

    MIÉRT NEM ELÉG A STARTUP PARANCSIKON: a `HáziRobot panel.lnk` csak
    bejelentkezéskor indít. Ha a panel menet közben elhal (mért eset:
    2026-10-01), semmi nem indítja újra — a böngésző pedig `Failed to fetch`-et
    ír. Ez a ciklus 60 másodpercen belül helyreállítja.

    FONTOS: ezt a szkriptet NORMÁL PowerShell-ablakból futtasd, ne a DSH
    sandboxából. A sandboxból indított folyamat a hívás végén meghal (mért
    hiba), így az őrködés is megszűnik.

.PARAMETER IntervalSeconds
    Az őrködés gyakorisága. Alapértelmezés: 60.

.PARAMETER Port
    A panel portja. Alapértelmezés: 4180.

.PARAMETER Force
    Akkor is indít, ha a PID-fájl élő folyamatra mutat.

.EXAMPLE
    .\start-robot-watchdog.ps1
    .\start-robot-watchdog.ps1 -Force
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 60,
    [int]$Port = 4180,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $root 'watchdog-hazi-robot.ps1'
$stateDir = Join-Path $root 'state'
$pidFile = Join-Path $stateDir 'robot-watchdog.pid'
$logFile = Join-Path $stateDir 'robot-watchdog.log'

if (-not (Test-Path $watchdog)) { throw "Nem találom: $watchdog" }
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }

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
    '-Port', "$Port"
    '-Quiet'
)

$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $wdArgs `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 2

if ($proc.HasExited) {
    Write-Host "Az őrködő ciklus azonnal leállt (kilépési kód: $($proc.ExitCode))." -ForegroundColor Red
    if (Test-Path $logFile) {
        Write-Host 'Napló (utolsó sorok):' -ForegroundColor DarkGray
        Get-Content $logFile -Tail 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
    exit 1
}

Write-Host "Őrködő ciklus elindítva (PID $($proc.Id), $IntervalSeconds s)." -ForegroundColor Green
Write-Host "  Napló: $logFile" -ForegroundColor Gray
Write-Host "  Leállítás: Stop-Process -Id $($proc.Id)" -ForegroundColor DarkGray
exit 0
