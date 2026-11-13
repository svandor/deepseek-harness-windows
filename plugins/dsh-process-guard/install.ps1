<#
.SYNOPSIS
  A dsh-process-guard plugin telepítése a DSH web profiljába (junction + patch + újraindítás).

.DESCRIPTION
  A plugin perzisztens folyamat-ledgert és induláskori reconcilációt ad a
  DSH-hoz. A telepítés ugyanaz a bizonyított út, mint a `dsh-hazi-robot`-nál:

    1) junction:  ~\.dsh\profiles\node_modules\dsh-process-guard -> ez a mappa
    2) patch:     egy `- insert:` bejegyzés a ~\.dsh\profiles\web\cordis.patch.yml-be
                  (a meglévő bejegyzéseket NEM bántja, csak hozzáfűz)
    3) ellenőrzés + a harness újraindítása (a restart a meglévő, rejtett úton megy)

  A `~\.dsh` a DSH sandboxján kívül van, ezért ezt NORMÁL PowerShell-ablakból kell
  futtatni (a DSH-ból `Access denied` lesz).

.EXAMPLE
  .\install.ps1              # telepítés + újraindítás
  .\install.ps1 -NoRestart   # csak a junction + patch
  .\install.ps1 -Check       # száraz ellenőrzés, semmit nem ír
  .\install.ps1 -Remove      # eltávolítás
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'web',
  [switch]$Remove,
  [switch]$Check,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
$pluginName = 'dsh-process-guard'
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$junction = Join-Path $modulesDir $pluginName
$patch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
$repoRoot = Split-Path -Parent (Split-Path -Parent $pluginDir)
$ledgerDir = Join-Path $DshHome 'process-ledger'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# --- száraz ellenőrzés --------------------------------------------------------
if ($Check) {
  Step 'Ellenőrzés (nem ír semmit)'
  Write-Host ("  plugin mappa:      {0} [{1}]" -f $pluginDir, (Test-Path $pluginDir))
  Write-Host ("  lib/index.js:      {0}" -f (Test-Path (Join-Path $pluginDir 'lib\index.js')))
  Write-Host ("  junction:          {0} [{1}]" -f $junction, (Test-Path $junction))
  Write-Host ("  profil patch:      {0} [{1}]" -f $patch, (Test-Path $patch))
  if (Test-Path $patch) {
    $has = (Get-Content $patch -Raw) -match 'dsh-process-guard'
    Write-Host ("  patch-bejegyzés:   {0}" -f $has)
  }
  if (Test-Path $ledgerDir) {
    $files = Get-ChildItem $ledgerDir -Filter '*.jsonl' -ErrorAction SilentlyContinue
    $lines = 0
    foreach ($f in $files) { $lines += (Get-Content $f.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines }
    Write-Host ("  ledger:            {0} workspace-fájl, {1} sor" -f $files.Count, $lines)
  } else {
    Write-Host '  ledger:            még nincs (első indulás után keletkezik)'
  }
  return
}

if (-not (Test-Path $patch)) { throw "Nem találom a profil patchet: $patch" }

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
    if ($line -match 'FOLYAMAT-ŐR') { $skip = $true; continue }
    if ($skip) {
      if ($line -match '^\s*-\s+insert:') { continue }
      if ($line -match '^\s*-\s+id:\s*process-guard') { continue }
      if ($line -match '^\s+name:\s*dsh-process-guard') { $skip = $false; continue }
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
$current = Get-Content $patch -Raw
if ($current -match 'dsh-process-guard') {
  Write-Host '  a bejegyzés már benne van'
} else {
  $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patch $backup -Force
  Write-Host "  mentés: $backup"
  $entry = @'

# ============================================================================
#  FOLYAMAT-ŐR  (dsh-process-guard)
# ============================================================================
#  Perzisztens folyamat-ledger + induláskori reconciláció. A DSH összeomlása
#  után az elárvult gyerekfolyamatok recovered jobként megjelennek, és PID +
#  indítási idő ellenőrzése után leállíthatók (taskkill /T).
#  Forrás: <repo>\plugins\dsh-process-guard
#  Kikapcsolás: .\plugins\dsh-process-guard\install.ps1 -Remove
# ============================================================================
- insert:
    - id: process-guard
      name: dsh-process-guard
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
Start-Sleep -Seconds 4
$log = $null
foreach ($candidate in @(
    (Join-Path $DshHome 'dsh-web\harness.log'),
    (Join-Path $repoRoot 'state\harness.log')
  )) {
  if (Test-Path $candidate) { $log = $candidate; break }
}

if ($log) {
  $tail = Get-Content $log -Tail 200 -ErrorAction SilentlyContinue
  if ($tail -match 'Failed to load plugins') {
    Write-Host '*** BOOT HIBA! Visszaállítás:' -ForegroundColor Red
    Write-Host "  $pluginDir\install.ps1 -Remove"
  } elseif ($tail -match 'dsh-process-guard') {
    Write-Host 'BOOT OK: a process-guard a boot gráfban van.' -ForegroundColor Green
    ($tail | Select-String -Pattern '\[dsh-process-guard\]' | Select-Object -Last 3) | ForEach-Object { "  " + $_.Line }
  } else {
    Write-Host 'FIGYELEM: a naplóban nincs process-guard sor (lehet, hogy a boot még tart).' -ForegroundColor Yellow
  }
} else {
  Write-Host 'FIGYELEM: nem találtam harness naplót az ellenőrzéshez.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Kész. A ledger: ' -NoNewline
Write-Host $ledgerDir
