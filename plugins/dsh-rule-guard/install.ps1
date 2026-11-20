<#
.SYNOPSIS
  A dsh-rule-guard telepítése a DSH web profiljába (junction + patch bejegyzés).

.DESCRIPTION
  A plugin a tool-hívás ELŐTT blokkolja a projekt-szabályt sértő műveleteket:
  lomtár nélküli törlés (Video/Raider), admin listából kimaradó cron (L12),
  név szerinti folyamatölés (globális). A szabályok: plugins\dsh-rule-guard\policy.json.

  A telepítés ugyanaz a bizonyított út, mint a dsh-process-guard-nál:
    1) junction:  ~\.dsh\profiles\node_modules\dsh-rule-guard -> ez a mappa
    2) patch:     egy `- insert:` bejegyzés a ~\.dsh\profiles\web\cordis.patch.yml-be
    3) ellenőrzés (YAML + bejegyzés)

  FONTOS: a patch BOOT-időben töltődik, ezért a plugin a KÖVETKEZŐ indításnál
  lép életbe. A futó Harness-t tilos újraindítani (AGENTS.md 1.5) — a
  felhasználó indítja újra a tálcáról (Kilépés -> ikon), amikor nem fut munka.

  A ~\.dsh a DSH sandboxján kívül van, ezért NORMÁL PowerShell-ablakból futtasd.

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
$pluginName = 'dsh-rule-guard'
$modulesDir = Join-Path $DshHome 'profiles\node_modules'
$junction = Join-Path $modulesDir $pluginName
$patch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
$profilePackage = Join-Path $DshHome "profiles\$Profile\package.json"
$checker = Join-Path $pluginDir 'lib\check-patch.mjs'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

# --- száraz ellenőrzés --------------------------------------------------------
if ($Check) {
  Step 'Ellenőrzés (nem ír semmit)'
  Write-Host ("  plugin mappa:      {0} [{1}]" -f $pluginDir, (Test-Path $pluginDir))
  Write-Host ("  policy.json:       {0}" -f (Test-Path (Join-Path $pluginDir 'policy.json')))
  Write-Host ("  lib/index.js:      {0}" -f (Test-Path (Join-Path $pluginDir 'lib\index.js')))
  Write-Host ("  junction:          {0} [{1}]" -f $junction, (Test-Path $junction))
  Write-Host ("  profil patch:      {0} [{1}]" -f $patch, (Test-Path $patch))
  if (Test-Path $patch) {
    $has = (Get-Content $patch -Raw) -match 'dsh-rule-guard'
    Write-Host ("  patch-bejegyzés:   {0}" -f $has)
    if (Test-Path $profilePackage) {
      & node $checker $patch $profilePackage
      Write-Host ("  patch YAML:        exit {0}" -f $LASTEXITCODE)
    }
  }
  if (Test-Path (Join-Path $DshHome 'rule-guard.log')) {
    $lines = (Get-Content (Join-Path $DshHome 'rule-guard.log') -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
    Write-Host ("  döntés-napló:      {0} sor" -f $lines)
  }
  return
}

if (-not (Test-Path $patch)) { throw "Nem találom a profil patchet: $patch" }

# --- eltávolítás ---------------------------------------------------------------
if ($Remove) {
  Step 'Eltávolítás'
  if (Test-Path $junction) {
    # junction: a célmappát NEM törli, csak a linket
    [System.IO.Directory]::Delete($junction, $false)
    Write-Host "  junction törölve: $junction"
  }
  $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patch $backup -Force
  $kept = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in (Get-Content $patch)) {
    if ($line -match 'PROJEKT-SZABÁLY ŐR') { $skip = $true; continue }
    if ($skip) {
      if ($line -match '^\s*-\s+insert:') { continue }
      if ($line -match '^\s*-\s+id:\s*rule-guard') { continue }
      if ($line -match '^\s+name:\s*dsh-rule-guard') { $skip = $false; continue }
    }
    $kept.Add($line)
  }
  Set-Content -Path $patch -Value $kept -Encoding UTF8
  Write-Host "  patch frissítve (mentés: $backup)"
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
if ($current -match 'dsh-rule-guard') {
  Write-Host '  a bejegyzés már benne van'
} else {
  $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $patch $backup -Force
  Write-Host "  mentés: $backup"
  $entry = @'

# ============================================================================
#  PROJEKT-SZABÁLY ŐR  (dsh-rule-guard)
# ============================================================================
#  A tool-hívás ELŐTT blokkolja a projekt-szabályt sértő műveleteket:
#    - Video/Raider: törlés csak 60 napos lomtárba (rm/os.unlink/rmtree tilos),
#    - L12: új cron csak a config/app_schedules.php-ba (admin Szinkron lista),
#    - globális: folyamatot név szerint leállítani tilos (AGENTS.md 1.6).
#  Szabályok: plugins\dsh-rule-guard\policy.json (hot-reload, újraindítás nélkül).
#  Kikapcsolás: .\plugins\dsh-rule-guard\install.ps1 -Remove
# ============================================================================
- insert:
    - id: rule-guard
      name: dsh-rule-guard
'@
  Add-Content -Path $patch -Value $entry -Encoding UTF8
  Write-Host '  bejegyzés hozzáfűzve'
}

# --- 3) ellenőrzés -------------------------------------------------------------
Step 'Ellenőrzés'
$ok = $true
if (-not (Test-Path $junction)) { Write-Host '  HIBA: nincs junction' -ForegroundColor Red; $ok = $false }
if (-not (Test-Path (Join-Path $junction 'lib\index.js'))) { Write-Host '  HIBA: a junction nem a plugint látja' -ForegroundColor Red; $ok = $false }
if ((Test-Path $checker) -and (Test-Path $profilePackage)) {
  & node $checker $patch $profilePackage
  if ($LASTEXITCODE -ne 0) { Write-Host '  HIBA: a patch YAML vagy a bejegyzés nem jó' -ForegroundColor Red; $ok = $false }
} else {
  Write-Host '  (a YAML-ellenőrző nem futtatható: node vagy profil package.json hiányzik)'
}

# --- 4) aktiválás --------------------------------------------------------------
Write-Host ''
if ($ok) {
  Write-Host 'Kész. A plugin a KÖVETKEZŐ Harness-indításnál lép életbe.' -ForegroundColor Green
} else {
  Write-Host 'A telepítés hiányos — javítsd a fenti hibákat.' -ForegroundColor Red
}
Write-Host 'Aktiválás (a felhasználó kattintása, AGENTS.md 1.5): tálca -> Kilépés -> ikon.'
Write-Host ("Állapot: {0}" -f (Join-Path $DshHome 'rule-guard.log'))
