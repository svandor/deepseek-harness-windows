<#
.SYNOPSIS
    A subagent fallback proxy indítása háttérben, a provider-kulcsokkal.

.DESCRIPTION
    A proxy a valódi provider-kulcsokat a ~/.dsh/.credentials.yaml-ból olvassa,
    ezért azokat nem kell máshol tárolni. Ez a szkript:
      1. kiolvassa a kulcsokat a credential store-ból,
      2. elindítja a proxy.mjs-t háttérben, PID fájllal,
      3. ellenőrzi, hogy a /healthz válaszol-e.

    Ezt hívja a run-proxy.cmd, amit a bejelentkezéskori feladat futtat.

.PARAMETER Stop
    Leállítja a futó proxyt.

.EXAMPLE
    .\run-proxy-service.ps1
    .\run-proxy-service.ps1 -Stop
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    # A watchdog a saját portját adja át, hogy a kettő ne csúszhasson szét.
    [int]$Port = 4123
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$proxy = Join-Path $root 'proxy.mjs'
$pidFile = Join-Path $root 'proxy.pid'
$outLog = Join-Path $root 'proxy.out.log'
$errLog = Join-Path $root 'proxy.err.log'
$creds = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$port = $Port

if ($Stop) {
    if (Test-Path $pidFile) {
        $procId = (Get-Content $pidFile -Raw).Trim()
        try { Stop-Process -Id ([int]$procId) -Force -ErrorAction Stop; Write-Host "Proxy leállítva (PID $procId)." }
        catch { Write-Host "A folyamat (PID $procId) már nem fut." }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    } else { Write-Host "Nincs PID fájl — a proxy nem fut." }
    return
}

# Már fut?
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $existing) {
    # A Get-NetTCPConnection admin nélkül üres lehet, ezért HTTP-próbával is ellenőrzünk.
    try {
        Invoke-WebRequest "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 3 | Out-Null
        Write-Host "A proxy már fut a $port porton."
        return
    } catch { }
}

# Kulcsok a credential store-ból
if (Test-Path $creds) {
    $text = Get-Content $creds -Raw
    foreach ($name in @('GROQ_API_KEY', 'NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_LOCAL_API_KEY')) {
        if ($text -match "(?m)^\s{2}${name}:\s*(\S+)\s*$") {
            Set-Item -Path "env:$name" -Value $Matches[1]
        }
    }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "HIBA: a node nincs a PATH-on."; exit 1 }
if (-not (Test-Path $proxy)) { Write-Host "HIBA: nem találom a proxy.mjs-t: $proxy"; exit 1 }

$proc = Start-Process -FilePath $node -ArgumentList @("`"$proxy`"", '--port', "$port") `
    -WorkingDirectory $root -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
    -PassThru -WindowStyle Hidden

Start-Sleep -Milliseconds 1500

if ($proc.HasExited) {
    Write-Host "HIBA: a proxy azonnal leállt. Napló:"
    if (Test-Path $errLog) { Get-Content $errLog | Select-Object -Last 12 }
    exit 1
}

$proc.Id | Set-Content $pidFile -Encoding ascii

# Életképesség-ellenőrzés
try {
    $h = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 8
    Write-Host "Proxy fut (PID $($proc.Id)): http://127.0.0.1:$port"
    foreach ($r in $h.routes.PSObject.Properties) {
        Write-Host ("  route {0}: {1}" -f $r.Name, ($r.Value -join ' -> '))
    }

    # ── A lánc ÉRTÉKELÉSE, nem csak a folyamat létezése ───────────────────
    # MEGMÉRT HIBA: ha a kulcsok nem oldódtak fel, a proxy elindult és
    # "működött", de a worker lánc egyetlen elemre csúszott (helyi Ollama,
    # 117 s, tool-hívás helyett content). Ez csendben használhatatlanná tette
    # a delegálást. Ezért itt HANGOSAN jelzünk és 2-vel kilépünk.
    $workerChain = @()
    if ($h.routes -and $h.routes.worker) { $workerChain = @($h.routes.worker) }
    $cloud = @($workerChain | Where-Object { $_ -notmatch '^ollama/' })

    if ($cloud.Count -eq 0) {
        Write-Host ""
        Write-Host "FIGYELEM: a worker lancban NINCS felhos cel:" -ForegroundColor Yellow
        $workerChain | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
        if ($h.missingKeys) {
            foreach ($m in $h.missingKeys.PSObject.Properties) {
                Write-Host ("  hianyzo kotelezo kulcs a(z) {0} route-hoz: {1}" -f $m.Name, ($m.Value -join ', ')) -ForegroundColor Yellow
            }
        }
        Write-Host "  Ilyenkor a delegalas 1-2 percig csendben fut, es nem hiv toolt." -ForegroundColor Yellow
        Write-Host "  Ok: a kulcsok nem oldodtak fel a ~/.dsh/.credentials.yaml-bol." -ForegroundColor Yellow
        exit 2
    }
} catch {
    Write-Host "FIGYELEM: a proxy elindult (PID $($proc.Id)), de a /healthz nem válaszolt: $($_.Exception.Message)"
    Write-Host "Napló: $outLog"
}
