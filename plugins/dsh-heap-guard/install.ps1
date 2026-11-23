<#
.SYNOPSIS
  A dsh-heap-guard telepítése a DSH web profiljába (junction + patch bejegyzés).

.DESCRIPTION
  A plugin a futó harness SAJÁT memóriáját méri: 5 percenként egy sor a
  state\harness-memory.jsonl-be (heap / plafon %, rss, uptime), és a plafon
  75% / 90%-a fölött WARN. MÉRT OK (2026-11-23 18:15:35): a 46 órája futó
  harness V8 heap OOM-mal leállt (3 285,6 MB / 4 288 MB) — a növekedést eddig
  semmi nem mérte.

  Telepítés (mint a dsh-rule-guard): junction + `- insert:` bejegyzés.
  FONTOS: a patch BOOT-időben töltődik (a futó processzbe is, mért), a futó
  Harness-t tilos újraindítani (AGENTS.md 1.5).

.EXAMPLE
  .\install.ps1            # telepítés (nem indít újra semmit)
  .\install.ps1 -Check     # száraz ellenőrzés
  .\install.ps1 -Remove    # eltávolítás
#>
[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'web',
  [switch]$Remove,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
$pluginName = 'dsh-heap-guard'
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$junction = Join-Path $modulesDir $pluginName
$patch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
$profilePackage = Join-Path $DshHome "profiles\$Profile\package.json"
$checker = Join-Path $pluginDir 'lib\check-patch.mjs'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

if ($Check) {
  Step 'Ellenőrzés (nem ír semmit)'
  Write-Host ("  plugin mappa:      {0} [{1}]" -f $pluginDir, (Test-Path $pluginDir))
  Write-Host ("  lib/index.js:      {0}" -f (Test-Path (Join-Path $pluginDir 'lib\index.js')))
  Write-Host ("  junction:          {0} [{1}]" -f $junction, (Test-Path $junction))
  Write-Host ("  profil patch:      {0} [{1}]" -f $patch, (Test-Path $patch))
  if (Test-Path $patch) {
    $has = (Get-Content $patch -Raw) -match 'dsh-heap-guard'
    Write-Host ("  patch-bejegyzés:   {0}" -f $has)
    if ((Test-Path $profilePackage) -and (Test-Path $checker)) {
      & node $checker $patch $profilePackage | Out-Null
      Write-Host ("  patch YAML:        exit {0}" -f $LASTEXITCODE)
    }
  }
  return
}

if (-not (Test-Path $patch)) { throw "Nem találom a profil patchet: $patch" }

if ($Remove) {
  Step 'Eltávolítás'
  if (Test-Path $junction) {
    [System.IO.Directory]::Delete($junction, $false)
    Write-Host "  junction törölve: $junction"
  }
  $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patch $backup -Force
  $kept = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in (Get-Content $patch)) {
    if ($line -match 'MEMÓRIA-TELEMETRIA') { $skip = $true; continue }
    if ($skip) {
      if ($line -match '^\s*-\s+insert:') { continue }
      if ($line -match '^\s*-\s+id:\s*heap-guard') { continue }
      if ($line -match '^\s+name:\s*dsh-heap-guard') { $skip = $false; continue }
    }
    $kept.Add($line)
  }
  Set-Content -Path $patch -Value $kept -Encoding UTF8
  Write-Host "  patch frissítve (mentés: $backup)"
  exit 0
}

Step "Junction: $junction"
if (-not (Test-Path $modulesDir)) { New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null }
if (Test-Path $junction) {
  Write-Host '  már létezik'
} else {
  New-Item -ItemType Junction -Path $junction -Target $pluginDir | Out-Null
  Write-Host '  létrehozva'
}

Step 'Profil patch'
$current = Get-Content $patch -Raw
if ($current -match 'dsh-heap-guard') {
  Write-Host '  a bejegyzés már benne van'
} else {
  $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patch $backup -Force
  Write-Host "  mentés: $backup"
  $entry = @'

# ============================================================================
#  MEMÓRIA-TELEMETRIA  (dsh-heap-guard)
# ============================================================================
#  A futó harness SAJÁT memóriáját méri 5 percenként a
#  state\harness-memory.jsonl fájlba (heap / plafon %, rss, uptime), és a
#  plafon 75% / 90%-a fölött WARN a naplóba.
#  MÉRT OK (2026-11-23 18:15:35): a 46 órája futó harness V8 heap OOM-mal
#  leállt (3 285,6 MB használt heap / 4 288 MB alap plafon,
#  state\harness.err.log) — a növekedést eddig SEMMI nem mérte.
#  Riport: node tools\harness-memory.mjs
#  Kikapcsolás: .\plugins\dsh-heap-guard\install.ps1 -Remove
# ============================================================================
- insert:
    - id: heap-guard
      name: dsh-heap-guard
'@
  Add-Content -Path $patch -Value $entry -Encoding UTF8
  Write-Host '  bejegyzés hozzáfűzve'
}

Step 'Ellenőrzés'
$ok = $true
if (-not (Test-Path $junction)) { Write-Host '  HIBA: nincs junction' -ForegroundColor Red; $ok = $false }
if (-not (Test-Path (Join-Path $junction 'lib\index.js'))) { Write-Host '  HIBA: a junction nem a plugint látja' -ForegroundColor Red; $ok = $false }
if ($ok) {
  Write-Host 'Kész. A plugin a KÖVETKEZŐ Harness-indításnál (és a futó processzben is) lép életbe.' -ForegroundColor Green
} else {
  Write-Host 'A telepítés hiányos — javítsd a fenti hibákat.' -ForegroundColor Red
}
