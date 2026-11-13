<#
.SYNOPSIS
  Teljes DSH-állapot biztonsági mentése (session-előzmény, beállítások, profil).

.DESCRIPTION
  MIÉRT: a session-előzmény nem veszhet el. A munkamenetek a
  `~\.dsh\sessions` alatt, workspaconkénti project-könyvtárakban élnek
  (`--C-Szerver-Deepseek~0020Harness--` stílusú kulcsokkal), és egy tisztítás,
  migráció vagy hibás patch elviheti őket. Ez a szkript teljes, ellenőrzött
  másolatot készít, manifesttel (méret + sha256), hogy a mentés
  visszaellenőrizhető legyen.

  MIT MÁSOL:
    sessions\            a teljes session-tár (minden artefakt, változatlanul)
    config\              settings.yaml, .credentials.yaml, a profil patch- és
                         bundle-leírói (cordis.patch.yml, cordis.yml, package.json)
    installed\           a telepített @deepseek-ai mag-csomagok VERZIÓJA és a
                         érintett lib/index.js fájlok sha256-ja (kiindulási alap
                         a későbbi patch-ekhez)
    manifest.csv         minden mentett fájl: relatív út, byte, sha256
    summary.json         darabszám, összméret, időbélyeg, forrás

  Az ellenőrzés a végén összeveti a forrás és a mentés fájlszámát és
  összméretét; eltérés esetén nem-nulla kilépési kóddal áll le.

.PARAMETER OutRoot
  A mentések gyökere. Alapértelmezés: D:\Szerver\DSH-backup

.PARAMETER Label
  Az alkönyvtár neve. Alapértelmezés: yyyy-MM-dd-HHmm

.PARAMETER NoSessions
  A (nagy) session-tár kihagyása — csak a konfiguráció és a manifest készül.

.EXAMPLE
  .\tools\backup-dsh-state.ps1
  .\tools\backup-dsh-state.ps1 -Label elotte-migracio
  .\tools\backup-dsh-state.ps1 -NoSessions   # gyors config-mentés
#>
[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$OutRoot = 'D:\Szerver\DSH-backup',
  [string]$Label = (Get-Date -Format 'yyyy-MM-dd-HHmm'),
  [switch]$NoSessions
)

$ErrorActionPreference = 'Stop'
function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

if (-not (Test-Path $DshHome)) { throw "Nem találom a DSH home-ot: $DshHome" }
$target = Join-Path $OutRoot $Label
if (Test-Path $target) { throw "A cél már létezik (nem írom felül): $target" }
New-Item -ItemType Directory -Force -Path $target | Out-Null

function Get-RelativePath([string]$base, [string]$path) {
  $baseFull = (Resolve-Path $base).Path.TrimEnd('\')
  return $path.Substring($baseFull.Length).TrimStart('\')
}

# --- 1) session-tár -----------------------------------------------------------
$sessionSource = Join-Path $DshHome 'sessions'
$sessionCopies = 0
if (-not $NoSessions -and (Test-Path $sessionSource)) {
  Step 'Session-tár másolása'
  $destination = Join-Path $target 'sessions'
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  # A jed és minden más másolható tartalom megy; a struktúra változatlan marad.
  Copy-Item -Path (Join-Path $sessionSource '*') -Destination $destination -Recurse -Force
  $sessionCopies = (Get-ChildItem $destination -Recurse -File).Count
  Write-Host ("  {0} fájl" -f $sessionCopies)
} else {
  Write-Host '  (session-tár kihagyva)'
}

# --- 2) konfiguráció ----------------------------------------------------------
Step 'Konfiguráció másolása'
$configDestination = Join-Path $target 'config'
New-Item -ItemType Directory -Force -Path $configDestination | Out-Null
$configFiles = @(
  'settings.yaml',
  '.credentials.yaml',
  '.anonymous-user-id'
)
$copied = 0
foreach ($relative in $configFiles) {
  $source = Join-Path $DshHome $relative
  if (-not (Test-Path $source)) { continue }
  # A profil-mappa nem másolható nyersen (junction-ök) — csak a leíró fájlok.
  Copy-Item $source -Destination (Join-Path $configDestination ([IO.Path]::GetFileName($relative))) -Force
  $copied += 1
}
foreach ($relative in @('profiles\web\cordis.patch.yml', 'profiles\web\cordis.yml', 'profiles\web\package.json', 'profiles\web\pnpm-workspace.yaml')) {
  $source = Join-Path $DshHome $relative
  if (-not (Test-Path $source)) { continue }
  $flattened = ($relative -replace '[\\/]', '__')
  Copy-Item $source -Destination (Join-Path $configDestination $flattened) -Force
  $copied += 1
}
Write-Host ("  {0} konfigurációs fájl" -f $copied)

# --- 3) telepített mag-pakettek kiindulási állapota ---------------------------
Step 'Telepített mag-csomagok rögzítése'
$installed = [ordered]@{}
$npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
$candidates = @()
if (Test-Path $npxRoot) {
  foreach ($entry in Get-ChildItem $npxRoot -Directory -ErrorAction SilentlyContinue) {
    if (Test-Path (Join-Path $entry.FullName 'node_modules\@deepseek-ai\dsh')) {
      $candidates += $entry
    }
  }
}
if ($candidates.Count -gt 0) {
  $newest = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $packagesRoot = Join-Path $newest.FullName 'node_modules\@deepseek-ai'
  $installed['packagesRoot'] = $packagesRoot
  $packages = [ordered]@{}
  foreach ($name in @('dsh', 'dsh-jobs-local', 'dsh-subprocess-local', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-win32-process')) {
    $packageJson = Join-Path $packagesRoot "$name\package.json"
    $entry = [ordered]@{}
    if (Test-Path $packageJson) {
      $entry['version'] = (Get-Content $packageJson -Raw | ConvertFrom-Json).version
      $lib = Join-Path $packagesRoot "$name\lib\index.js"
      if (Test-Path $lib) { $entry['libIndexSha256'] = (Get-FileHash $lib -Algorithm SHA256).Hash }
    } else {
      $entry['version'] = $null
    }
    $packages[$name] = $entry
  }
  $installed['packages'] = $packages
}
$installedPath = Join-Path $target 'installed'
New-Item -ItemType Directory -Force -Path $installedPath | Out-Null
$installed | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $installedPath 'packages.json') -Encoding UTF8
Write-Host "  $installedPath\packages.json"

# --- 4) manifest --------------------------------------------------------------
Step 'Manifest készítése (méret + sha256)'
$rows = New-Object System.Collections.Generic.List[object]
foreach ($file in Get-ChildItem $target -Recurse -File) {
  if ([IO.Path]::GetFileName($file.FullName) -eq 'manifest.csv') { continue }
  $rows.Add([pscustomobject]@{
      Path   = Get-RelativePath $target $file.FullName
      Bytes  = $file.Length
      Sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
    })
}
$rows | Sort-Object Path | Export-Csv -Path (Join-Path $target 'manifest.csv') -NoTypeInformation -Encoding UTF8

# --- 5) összegzés + ellenőrzés -------------------------------------------------
$totalBytes = ($rows | Measure-Object Bytes -Sum).Sum
$summary = [ordered]@{
  createdAt        = (Get-Date).ToString('o')
  source           = $DshHome
  target           = $target
  sessionsIncluded = (-not $NoSessions)
  files            = $rows.Count
  totalBytes       = $totalBytes
  totalMB          = [math]::Round($totalBytes / 1MB, 1)
}
$summary | ConvertTo-Json | Set-Content (Join-Path $target 'summary.json') -Encoding UTF8

Step 'Ellenőrzés (forrás vs. mentés)'
$failures = 0
if (-not $NoSessions -and (Test-Path $sessionSource)) {
  $sourceFiles = Get-ChildItem $sessionSource -Recurse -File
  $sourceBytes = ($sourceFiles | Measure-Object Length -Sum).Sum
  $backupFiles = Get-ChildItem (Join-Path $target 'sessions') -Recurse -File
  $backupBytes = ($backupFiles | Measure-Object Length -Sum).Sum
  Write-Host ("  session: forrás {0} fájl / {1:N1} MB · mentés {2} fájl / {3:N1} MB" -f $sourceFiles.Count, ($sourceBytes / 1MB), $backupFiles.Count, ($backupBytes / 1MB))
  if ($sourceFiles.Count -ne $backupFiles.Count) { Write-Host '  HIBA: fájlszám eltér!' -ForegroundColor Red; $failures += 1 }
  if ($sourceBytes -ne $backupBytes) { Write-Host '  HIBA: összméret eltér!' -ForegroundColor Red; $failures += 1 }
}
if ($failures -eq 0) { Write-Host '  OK: a mentés a forrással egyezik.' -ForegroundColor Green }

Write-Host ''
$summaryLine = "Kész: {0}  ({1} fájl, {2:N1} MB)" -f $target, ($rows.Count + 1), ($totalBytes / 1MB)
Write-Host $summaryLine
Write-Host 'Visszaállítás: a sessions\ tartalmát a ~\.dsh\sessions alá kell visszamásolni.'
if ($failures -gt 0) { exit 1 }
exit 0
