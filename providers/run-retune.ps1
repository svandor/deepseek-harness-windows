<#
.SYNOPSIS
    A havi ütemezett feladat belépési pontja. Ezt hívja a run-retune.cmd.

.DESCRIPTION
    Lefuttatja a retune.mjs-t, és mindent a reports mappába naplóz.
    Azért külön fájl, mert a schtasks /TR értéke legfeljebb 261 karakter lehet,
    így a teljes parancs nem férne be közvetlenül.

.PARAMETER Mode
    'report' = csak riport (alapértelmezés, biztonságos),
    'apply'  = mentés után javítja a settings.yaml-t is.

.DESCRIPTION
    Két dolgot végez:
      1. retune.mjs — elhalt modell-id-k felderítése és javítása,
      2. WebView2-profilgenerációk tisztítása (a DshWindow nem takarít maga
         után; mért eset: 61 generáció, 2,2 GB).
#>
[CmdletBinding()]
param(
    [ValidateSet('report', 'apply')][string]$Mode = 'report'
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$retune = Join-Path $root 'retune.mjs'
$reportDir = Join-Path $root 'reports'
$logFile = Join-Path $reportDir 'retune-scheduled.log'

if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }

# UTF-8 BOM nélkül: a PS 5.1 `*>>` operátora UTF-16-ot ír, amit a jegyzettömb
# és a legtöbb eszköz olvashatatlannak lát. Az Add-Content -Encoding UTF8
# a 5.1-ben BOM-ot tesz, ezért .NET-tel írunk.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$newline = [string][char]10
function Write-Log([string]$text) {
    [System.IO.File]::AppendAllText($logFile, $text + $newline, $utf8NoBom)
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Log ''
Write-Log "===== $stamp  (mod: $Mode) ====="

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Log 'HIBA: a node nincs a PATH-on.'
    exit 1
}

$argv = @($retune)
if ($Mode -eq 'apply') { $argv += '--apply' }

try {
    $output = & $node @argv 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    foreach ($line in $output) { Write-Log $line }
} catch {
    Write-Log "KIVETEL: $($_.Exception.Message)"
    $code = 1
}

Write-Log "kilepesi kod: $code"

# ── Fallback-lancok behangolasa (chain-doctor) ─────────────────────────────
# A retune csak azt nezi, hogy a modell-id-k LETEZNEK-e. A chain-doctor azt,
# hogy MELYIK CEL VALASZOL TENYLEGESEN: minden celra kuld egy tool-hivast
# igenylo probat, es a halottakat a lanc vegere sorolja.
#
# Report modban csak riportot ir; apply modban atirja a config.json-t
# (mentessel). Ez a napi "behangolas" valodi tartalma.
$doctor = Join-Path $root 'chain-doctor.mjs'
if (Test-Path $doctor) {
    Write-Log ''
    Write-Log '--- Fallback-lancok behangolasa (chain-doctor) ---'
    $doctorArgs = @($doctor)
    if ($Mode -eq 'apply') { $doctorArgs += '--apply' }
    try {
        $dOut = & $node @doctorArgs 2>&1 | ForEach-Object { $_.ToString() }
        foreach ($line in $dOut) { Write-Log $line }
    } catch {
        Write-Log "KIVETEL a behangolasnal: $($_.Exception.Message)"
    }
}

# ── WebView2-profilgenerációk tisztítása ───────────────────────────────────
# A DshWindow.exe minden ablakindításkor új profilt hoz létre és a régit nem
# törli. A pane-* mappákat a tisztító nem érinti, és csak a 14 napnál régebbi,
# a 2 legfrissebbet meghagyó generációkat törli.
$cleaner = Join-Path $root 'clean-webview2-profiles.ps1'
if (Test-Path $cleaner) {
    Write-Log ''
    Write-Log '--- WebView2 profilok tisztítása ---'
    try {
        # A hívott szkript a saját Write-Host kimenetét a gazda konzoljára írja,
        # ezért itt a visszaadott objektumokat naplózzuk; a Write-Host sorok
        # elfogása nem megbízható. A lényeg a méretváltozás.
        $wv2 = Join-Path (Split-Path -Parent $root) 'state\webview2'
        $sizeBefore = 0
        if (Test-Path $wv2) {
            $sizeBefore = (Get-ChildItem $wv2 -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        }
        $null = & $cleaner
        $sizeAfter = 0
        if (Test-Path $wv2) {
            $sizeAfter = (Get-ChildItem $wv2 -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        }
        Write-Log ("WebView2 mappa: {0:N1} MB -> {1:N1} MB (felszabadult {2:N0} MB)" -f ($sizeBefore / 1MB), ($sizeAfter / 1MB), (($sizeBefore - $sizeAfter) / 1MB))
    } catch {
        Write-Log "KIVETEL a tisztitasnal: $($_.Exception.Message)"
    }
}

Write-Log "vege"
# Nem hívunk `exit`-et: az `exit` a hívó (esetleg interaktív) shellt is
# bezárná, amikor a szkriptet kézzel futtatják. A hívó a $LASTEXITCODE-ból
# olvassa az eredményt, ezért azt állítjuk be.
$global:LASTEXITCODE = $code
