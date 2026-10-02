<#
.SYNOPSIS
    Őrködő ciklus: életben tartja a subagent fallback proxyt, és hangosan jelzi,
    ha a worker lánc használhatatlan.

.DESCRIPTION
    MIÉRT CIKLUS, ÉS MIÉRT NEM ÜTEMEZETT FELADAT:

    A proxy az automatikus subagent-üzlet egyetlen gyenge pontja. A mért hiba:
    2026-09-27 18:19:31-én a proxy minden hibaüzenet nélkül elhalt, és nem
    indult újra — onnantól a `subagent-worker` route nem válaszolt, a delegált
    gyermek-session minden hívása elhalt. Ez a "használat után behalt" tünet.

    A Windows Feladatütemező lenne a legjobb hely, de a regisztrálás ezen a
    gépen "A hozzáférés megtagadva" hibára fut (mért eredmény, emelt
    hozzáféréssel is), ezért ez a szkript NEM függ tőle: egy leválasztott,
    láthatatlan folyamatban futó ciklus (alapértelmezés: 60 s) maga javítja
    a kiesést. A leválasztást a start-watchdog.ps1 végzi.

    MIT ELLENŐRIZ MINDEN KÖRBEN:
      1. válaszol-e a /healthz (kiesés -> újraindítás a
         run-proxy-service.ps1-gyel, ami a kulcsokat is feloldja),
      2. van-e FELHŐS cél a `worker` láncban. Ez a lényeg: egy futó proxy,
         amelynek a láncában csak a helyi Ollama maradt, pontosan azt a
         tünetet adja (2 perc csend, tool-hívás helyett tartalom), amit
         delegáláskor "behalásnak" látni. Ezt NEM indítással kell javítani,
         hanem a kulcsokkal — ezért itt csak jelez.

    A naplóba CSAK a rendellenes események kerülnek (kiesés, újraindítás,
    lánc-hiba), így a fájl nem hízik.

.PARAMETER IntervalSeconds
    Két ellenőrzés közti idő. Alapértelmezés: 60.

.PARAMETER Port
    A proxy portja. Alapértelmezés: 4123.

.PARAMETER Quiet
    Ne írjon a konzolra (a leválasztott futás így hívja).

.PARAMETER Once
    Egyetlen ellenőrzés, majd kilépés. Ezt használja a telepítő az azonnali
    próbához.

.EXAMPLE
    .\watchdog-subagent-proxy.ps1 -Once
    .\watchdog-subagent-proxy.ps1 -IntervalSeconds 30
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 60,
    [int]$Port = 4123,
    [switch]$Quiet,
    [switch]$Once
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$service = Join-Path $root 'run-proxy-service.ps1'
$reportDir = Join-Path $root 'reports'
$logFile = Join-Path $reportDir 'proxy-watchdog.log'

# A leválasztott ciklus azonosítója: a launcher ebből látja, hogy fut-e már.
# -Once módban NEM írjuk ki: az egyszeri ellenőrzés nem ciklus, és egy halott
# PID-et hagyna maga után (a start-watchdog.ps1 élő folyamatot keres benne).
$beatFile = Join-Path $reportDir 'proxy-watchdog.pid'
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
if (-not $Once) { Set-Content -Path $beatFile -Value $PID -Encoding ascii }

function Say([string]$text, [string]$color = 'Gray') {
    if (-not $Quiet) { Write-Host $text -ForegroundColor $color }
}

function Write-Log([string]$text) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $text
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Get-ProxyHealth {
    try { return Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 5 }
    catch { return $null }
}

# A `worker` lánc felhős céljai. Üres = csak helyi (használhatatlan delegálás).
function Get-WorkerCloud {
    param($health)
    $chain = @()
    if ($health -and $health.routes -and $health.routes.worker) { $chain = @($health.routes.worker) }
    return @($chain | Where-Object { $_ -notmatch '^ollama/' })
}

$restarts = 0
$chainWarned = $false

while ($true) {
    $health = Get-ProxyHealth

    if (-not $health) {
        $restarts++
        Write-Log "KIESES (#$restarts): a proxy nem valaszol a $Port porton — ujrainditas"
        Say "[$(Get-Date -Format 'HH:mm:ss')] A proxy nem válaszol — újraindítás..." 'Yellow'

        if (Test-Path $service) {
            $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $service -Port $Port 2>&1
            $out | ForEach-Object { Say "  $_" 'DarkGray' }
        } else {
            Write-Log "HIBA: nem talalom a szolgaltatas-szkriptet: $service"
            Say "HIBA: nem találom: $service" 'Red'
        }

        Start-Sleep -Seconds 3
        $health = Get-ProxyHealth

        if (-not $health) {
            Write-Log "SIKERTELEN ujrainditas (#$restarts)"
            Say "SIKERTELEN: a proxy az újraindítás után sem válaszol." 'Red'
        } else {
            Write-Log "HELYREALLITVA (#$restarts): a proxy ujra valaszol"
            Say "Rendben, a proxy újra fut." 'Green'
        }
    }

    if ($health) {
        $cloud = Get-WorkerCloud $health
        if ($cloud.Count -eq 0) {
            if (-not $chainWarned) {
                $chainWarned = $true
                $chain = @($health.routes.worker)
                Write-Log "FIGYELMEZTETES: a worker lancban nincs felhos cel: $($chain -join ' -> ')"
                Say "FIGYELEM: a worker láncban nincs felhős cél (csak helyi Ollama)." 'Yellow'
                Say "  A delegálás 1-2 percig csendben fut, és nem hív toolt." 'Yellow'
                if ($health.missingKeys) {
                    foreach ($m in $health.missingKeys.PSObject.Properties) {
                        Say ("  hiányzó kötelező kulcs a(z) {0} route-hoz: {1}" -f $m.Name, ($m.Value -join ', ')) 'Yellow'
                    }
                }
                Say "  Javítás: indítsd a proxyt a kulcsokkal (run-proxy-service.ps1)." 'Yellow'
            }
        } elseif ($chainWarned) {
            $chainWarned = $false
            Write-Log "HELYREALLITVA: a worker lancban ujra van felhos cel: $($cloud -join ' -> ')"
            Say "A worker lánc újra rendben: $($cloud -join ' -> ')" 'Green'
        }
    }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}

if ($Once) {
    if ($health -and (Get-WorkerCloud $health).Count -gt 0) { exit 0 }
    if ($health) { exit 2 }
    exit 1
}
