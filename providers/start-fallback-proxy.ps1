# PowerShell indító a helyi fallback proxyhoz.
#
# Használat:
#   .\start-fallback-proxy.ps1                 # előtérben, Ctrl+C-vel áll le
#   .\start-fallback-proxy.ps1 -Port 4124      # más port
#   .\start-fallback-proxy.ps1 -Background     # háttérfolyamat, PID fájllal
#   .\start-fallback-proxy.ps1 -Stop           # a háttérfolyamat leállítása
#
# A kulcsokat környezeti változóként olvassa. Ha nincsenek beállítva, a proxy
# elindul, de a hiányzó kulcsú providereket kihagyja a láncból.

[CmdletBinding()]
param(
    [int]$Port = 4123,
    [string]$Config,
    [switch]$Background,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$proxy = Join-Path $root 'proxy.mjs'
$pidFile = Join-Path $root 'proxy.pid'
$outLog = Join-Path $root 'proxy.out.log'
$errLog = Join-Path $root 'proxy.err.log'

if ($Stop) {
    if (Test-Path $pidFile) {
        $procId = (Get-Content $pidFile -Raw).Trim()
        try {
            Stop-Process -Id ([int]$procId) -Force -ErrorAction Stop
            Write-Host "Leállítva (PID $procId)." -ForegroundColor Green
        } catch {
            Write-Host "A folyamat (PID $procId) már nem fut." -ForegroundColor Yellow
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "Nincs PID fájl ($pidFile) - nem indult háttérben." -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $proxy)) { throw "Nem találom: $proxy" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "A 'node' nincs a PATH-on. Telepítsd a Node.js-t (>= 18)." }

# --- kulcs ellenőrzés (csak jelzés, nem hiba) ---
$expected = @('GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY')
$missing = @($expected | Where-Object { -not [Environment]::GetEnvironmentVariable($_, 'Process') })
if ($missing.Count -gt 0) {
    Write-Host "Figyelem: ezek a kulcsok nincsenek beállítva -> kimaradnak a láncból:" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  - $_" }
    Write-Host "  Beállítás (aktuális sessionre):  `$env:GROQ_API_KEY = 'gsk_...'" -ForegroundColor DarkGray
    Write-Host "  Tartósan (felhasználói szinten): [Environment]::SetEnvironmentVariable('GROQ_API_KEY','gsk_...','User')" -ForegroundColor DarkGray
    Write-Host ""
}

$proxyArgs = @($proxy, '--port', "$Port")
if ($Config) { $proxyArgs += @('--config', $Config) }

if ($Background) {
    $proc = Start-Process -FilePath $node -ArgumentList $proxyArgs -WorkingDirectory $root `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 900
    if ($proc.HasExited) {
        Write-Host "A proxy azonnal leállt. Napló:" -ForegroundColor Red
        if (Test-Path $errLog) { Get-Content $errLog | Select-Object -Last 20 }
        exit 1
    }
    $proc.Id | Set-Content $pidFile -Encoding ascii
    Write-Host "Proxy fut a háttérben (PID $($proc.Id)): http://127.0.0.1:$Port/v1" -ForegroundColor Green
    Write-Host "Napló: $outLog" -ForegroundColor DarkGray
    Write-Host "Leállítás: .\start-fallback-proxy.ps1 -Stop" -ForegroundColor DarkGray
} else {
    Write-Host "Proxy indítása előtérben: http://127.0.0.1:$Port/v1  (Ctrl+C = leállítás)" -ForegroundColor Green
    & $node @proxyArgs
}
