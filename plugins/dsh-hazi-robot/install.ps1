<#
.SYNOPSIS
  Házirobot panel telepítése a DSH profiljába (junction + patch + újraindítás).

.DESCRIPTION
  A `dsh-hazi-robot` csomagot beköti a web profilba:

    1) junction:  ~\.dsh\profiles\node_modules\dsh-hazi-robot -> ez a mappa
    2) patch:     egy `- insert:` bejegyzés a ~\.dsh\profiles\web\cordis.patch.yml-be
                  (a meglévő bejegyzéseket NEM bántja, csak hozzáfűz)
    3) ellenőrzés + a harness újraindítása
    4) boot-ellenőrzés: nincs "Failed to load plugins", és a bundle a boot gráfban van

  A `~\.dsh` a DSH sandboxján kívül van, ezért ezt NORMÁL PowerShell-ablakból kell
  futtatni (a DSH-ból `Access denied` lesz).

.EXAMPLE
  .\install.ps1              # telepítés + újraindítás
  .\install.ps1 -NoRestart   # csak a junction + patch
  .\install.ps1 -Remove      # eltávolítás
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'web',
  [switch]$Remove,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
$pluginName = 'dsh-hazi-robot'
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$junction = Join-Path $modulesDir $pluginName
$patch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
$repoRoot = Split-Path -Parent (Split-Path -Parent $pluginDir)

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

if (-not (Test-Path $patch)) { throw "Nem talalom a profil patchet: $patch" }

# --- eltávolítás ---------------------------------------------------------------
if ($Remove) {
  Step 'Eltávolítás'
  if (Test-Path $junction) { Remove-Item $junction -Force -Recurse; Write-Host "  junction törölve: $junction" }
  $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patch $backup -Force
  $lines = Get-Content $patch
  $kept = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in $lines) {
    if ($line -match 'Házirobot panel') { $skip = $true; continue }
    if ($skip) {
      if ($line -match '^\s*-\s+insert:') { continue }
      if ($line -match '^\s*-\s+id:\s*hazi-robot') { continue }
      if ($line -match '^\s+name:\s*dsh-hazi-robot') { $skip = $false; continue }
    }
    $kept.Add($line)
  }
  Set-Content -Path $patch -Value $kept -Encoding UTF8
  Write-Host "  patch frissítve (mentés: $backup)"
  if (-not $NoRestart) { & (Join-Path $repoRoot 'tools\restart-harness.ps1') -Port $Port -DshHome $DshHome -Profile $Profile }
  exit 0
}

# --- 1) junction --------------------------------------------------------------
Step "Junction: $junction"
if (-not (Test-Path $modulesDir)) { New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null }
if (Test-Path $junction) {
  Write-Host '  már létezik'
} else {
  New-Item -ItemType Junction -Path $junction -Target $pluginDir | Out-Null
  Write-Host '  létrehozva'
}

# --- 2) patch -----------------------------------------------------------------
Step 'Profil patch'
$backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $patch $backup -Force
Write-Host "  mentés: $backup"

$current = Get-Content $patch -Raw
if ($current -match 'dsh-hazi-robot') {
  Write-Host '  a bejegyzés már benne van'
} else {
  $entry = @'

# ============================================================================
#  HÁZIROBOT PANEL  (dsh-hazi-robot)
# ============================================================================
#  Gomb a beszélgetés eszközei közé: állapot, jobok, FAR-napló és a
#  beállítás-űrlap (SMTP, FAR callback, figyelt oldalak).
#  Forrás: C:\Szerver\Deepseek Harness\plugins\dsh-hazi-robot
#  Kikapcsolás: .\plugins\dsh-hazi-robot\install.ps1 -Remove
# ============================================================================
- insert:
    - id: hazi-robot
      name: dsh-hazi-robot
'@
  Add-Content -Path $patch -Value $entry -Encoding UTF8
  Write-Host '  bejegyzés hozzáfűzve'
}

# --- 3) újraindítás ------------------------------------------------------------
if ($NoRestart) { Write-Host '(-NoRestart: a harness nem indul újra)'; return }

Step 'Harness újraindítása'
& (Join-Path $repoRoot 'tools\restart-harness.ps1') -Port $Port -DshHome $DshHome -Profile $Profile

# --- 4) boot-ellenőrzés --------------------------------------------------------
Step 'Boot-ellenőrzés'
Start-Sleep -Seconds 3
$url = $null
foreach ($candidate in @(
    (Join-Path $DshHome 'dsh-web\harness.log'),
    (Join-Path $repoRoot 'state\harness.log')
  )) {
  if (Test-Path $candidate) {
    $match = ((Get-Content $candidate -Raw) | Select-String -Pattern "http://127\.0\.0\.1:$Port/\?token=[A-Za-z0-9_\-]+" -AllMatches).Matches.Value | Select-Object -First 1
    if ($match) { $url = $match; break }
  }
}

if (-not $url) {
  Write-Host 'FIGYELEM: nem talaltam token URL-t. Ha a felulet nem tolt be:'
  Write-Host "  $repoRoot\tools\recover-harness.ps1"
  return
}

$token = ($url -split 'token=')[1]
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try { Invoke-WebRequest "http://127.0.0.1:$Port/?token=$token" -UseBasicParsing -WebSession $session -TimeoutSec 10 | Out-Null } catch { }
$html = $null
try { $html = (Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -WebSession $session -TimeoutSec 10).Content } catch { }

if ($html) {
  if ($html -match 'Failed to load plugins') {
    Write-Host '*** BOOT HIBA! Visszaallitas:' -ForegroundColor Red
    Write-Host "  $pluginDir\install.ps1 -Remove"
  } else {
    Write-Host 'BOOT OK (nincs "Failed to load plugins")' -ForegroundColor Green
    if ($html -match 'dsh-hazi-robot/client\.js') { Write-Host 'A robot bundle szerepel a boot grafban.' -ForegroundColor Green }
    else { Write-Host 'FIGYELEM: a bundle nem latszik a boot grafban (nincs dsh.client deklaracio?).' -ForegroundColor Yellow }
  }
}

Write-Host ''
Write-Host 'Kész. Nyisd meg a felületet, és keresd a 🤖 Robot gombot a beszélgetés eszközei között:'
Write-Host "  $url"
