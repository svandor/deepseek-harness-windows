<#
.SYNOPSIS
    Őrködő ciklus a Házirobot panelhez (webhook-server.mjs, 4180).

.DESCRIPTION
    MIÉRT KELL: a panelnek — a fallback proxytól eltérően — nem volt őrfolyama.
    A mért tünet (2026-10-01): a panel szervere elhalt, a böngésző `Failed to
    fetch`-et írt, és mert a `bot.log` csak a saját eseményeit rögzíti, a halál
    NAPLÓBEJEGYZÉS NÉLKÜL történt — összeomlásnak látszott, holott a folyamatot
    kívülről állították le (a `panel.err.log` üres maradt).

    MIT ELLENŐRIZ MINDEN KÖRBEN:
      1. válaszol-e a panel (`GET /status.json`). Ha nem -> újraindítás.
      2. válaszol-e a fallback proxy (4123). A panel parancsai proxy nélkül is
         működnek, de a BESZÉLGETÉS nem — ezt hangosan jelezni kell, mert
         máskülönben „nem válaszol a robot" tünetként jelenik meg.

    A naplóba CSAK a rendellenes események kerülnek, így nem hízik.

.PARAMETER IntervalSeconds
    Két ellenőrzés közti idő. Alapértelmezés: 60.

.PARAMETER Port
    A panel portja. Alapértelmezés: 4180.

.PARAMETER Quiet
    Ne írjon a konzolra (a leválasztott futás így hívja).

.PARAMETER Once
    Egyetlen ellenőrzés, majd kilépés (telepítés utáni azonnali próbához).

.EXAMPLE
    .\watchdog-hazi-robot.ps1 -Once
    .\watchdog-hazi-robot.ps1 -IntervalSeconds 30
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 60,
    [int]$Port = 4180,
    [int]$ProxyPort = 4123,
    [switch]$Quiet,
    [switch]$Once
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root 'panel\server.mjs'
$stateDir = Join-Path $root 'state'
$logFile = Join-Path $stateDir 'robot-watchdog.log'
$pidFile = Join-Path $stateDir 'robot-watchdog.pid'

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
# -Once módban NEM írjuk ki: az egyszeri ellenőrzés nem ciklus, és halott PID-et
# hagyna maga után (a start-robot-watchdog.ps1 élő folyamatot keres benne).
if (-not $Once) { Set-Content -Path $pidFile -Value $PID -Encoding ascii }

function Say([string]$text, [string]$color = 'Gray') {
    if (-not $Quiet) { Write-Host $text -ForegroundColor $color }
}

function Write-Log([string]$text) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $text
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

# A panel életben van-e. A /status.json-t kérdezzük, mert az a lap tényleges
# adatforrása: egy „nyitott port" önmagában nem jelentené, hogy a panel jó.
function Get-PanelHealth {
    try { return Invoke-RestMethod "http://127.0.0.1:$Port/status.json" -TimeoutSec 5 }
    catch { return $null }
}

function Test-Proxy {
    try { Invoke-RestMethod "http://127.0.0.1:$ProxyPort/healthz" -TimeoutSec 5 | Out-Null; return $true }
    catch { return $false }
}

# A panel indítása LEVÁLASZTVA, a kimenet megőrzésével. A stderr kiírása azért
# kell, mert enélkül egy valódi összeomlás nyom nélkül tűnik el (mért hiba).
function Start-Panel {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Write-Log 'HIBA: a node nincs a PATH-on — a panel nem indithato'; return $null }
    if (-not (Test-Path $server)) { Write-Log "HIBA: nem talalom: $server"; return $null }
    try {
        $proc = Start-Process -FilePath $node `
            -ArgumentList @('--no-warnings', "`"$server`"", "--port=$Port") `
            -WorkingDirectory $root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $stateDir 'panel.out.log') `
            -RedirectStandardError  (Join-Path $stateDir 'panel.err.log')
        return $proc
    } catch {
        Write-Log "HIBA: a panel inditasa elhalt: $($_.Exception.Message)"
        return $null
    }
}

$restarts = 0
$proxyWarned = $false

while ($true) {
    $health = Get-PanelHealth

    if (-not $health) {
        $restarts++
        Write-Log "KIESES (#$restarts): a panel nem valaszol a $Port porton — ujrainditas"
        Say "[$(Get-Date -Format 'HH:mm:ss')] A panel nem válaszol — újraindítás..." 'Yellow'

        $proc = Start-Panel
        Start-Sleep -Seconds 3
        $health = Get-PanelHealth

        if (-not $health) {
            Write-Log "SIKERTELEN ujrainditas (#$restarts) — panel.err.log:"
            if (Test-Path (Join-Path $stateDir 'panel.err.log')) {
                Get-Content (Join-Path $stateDir 'panel.err.log') -Tail 8 |
                    ForEach-Object { Write-Log "  $_" }
            }
            Say 'SIKERTELEN: a panel az újraindítás után sem válaszol.' 'Red'
            # Ne pörögjön: egy sikertelen kör után hosszabb szünet.
            if (-not $Once) { Start-Sleep -Seconds ([Math]::Max($IntervalSeconds, 30)) }
        } else {
            $pidText = if ($proc) { " (PID $($proc.Id))" } else { '' }
            Write-Log "HELYREALLITVA (#$restarts): a panel ujra valaszol$pidText"
            Say "Rendben, a panel újra fut$pidText." 'Green'
        }
    }

    # A panel él, de a proxy nem: a parancsok mennek, a beszélgetés nem.
    # Ez pontosan „nem válaszol a robot" tünetet ad, ezért jelezzük.
    if ($health) {
        if (-not (Test-Proxy)) {
            if (-not $proxyWarned) {
                $proxyWarned = $true
                Write-Log "FIGYELMEZTETES: a panel el, de a fallback proxy ($ProxyPort) nem valaszol — a beszelgetes nem fog menni"
                Say "FIGYELEM: a panel él, de a fallback proxy ($ProxyPort) nem válaszol." 'Yellow'
                Say '  A /parancsok működnek, a beszélgetés nem. Indítás: providers\run-proxy-service.ps1' 'Yellow'
            }
        } elseif ($proxyWarned) {
            $proxyWarned = $false
            Write-Log "HELYREALLITVA: a fallback proxy ($ProxyPort) ujra valaszol"
            Say 'A fallback proxy újra válaszol.' 'Green'
        }
    }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}

if ($Once) {
    if (Get-PanelHealth) { exit 0 }
    exit 1
}
