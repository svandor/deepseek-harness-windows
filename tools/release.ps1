<#
.SYNOPSIS
  Kiadás: verzióemelés + commit + tag + push + GitHub Release.

.DESCRIPTION
  Ez a projekt TELEPÍTHETŐ verzió (a bin\DshWindow.exe és a bin\DshLauncher.exe
  benne van a repóban), ezért minden kiadásnál a verzió, a git tag és a GitHub
  Release együtt mozog. A folyamat:

    1) a jelenlegi verzió a VERSION fájlból (a gyökérben),
    2) az új verzió kiszámítása (`-Bump patch|minor|major`, vagy `-Version x.y.z`),
    3) a VERSION és a pluginok package.json `version` mezőjének frissítése,
    4) `git add -A` + commit ("Release vX.Y.Z"),
    5) annotált tag (`git tag -a vX.Y.Z`),
    6) `git push` + a tag pusholása,
    7) `gh release create vX.Y.Z --generate-notes` (a commitokból generált jegyzetekkel).

  A `VERSION` fájl az igazság forrása: a pluginok `package.json`-ja innen kapja a
  verziót, így nem csúsznak el egymástól.

  MIÉRT SZKRIPT: a kiadás négy külső eszközt (git, gh) és több fájlt érint; kézzel
  könnyű kihagyni a taget vagy a Release-t. A `dsh-ui-extras` Git paneljének
  "Kiadás" gombja ugyanezt a szkriptet hívja, ezért a parancssori és a felületi
  út pontosan ugyanaz.

.EXAMPLE
  .\tools\release.ps1 -DryRun          # csak kiírja, mit tenne
  .\tools\release.ps1                  # patch kiadás (0.1.0 -> 0.1.1), kérdez
  .\tools\release.ps1 -Bump minor -Yes # 0.1.0 -> 0.2.0, kérés nélkül
  .\tools\release.ps1 -Version 1.0.0 -Yes
  .\tools\release.ps1 -NoPush          # commit + tag, de nincs push/Release
#>
[CmdletBinding()]
param(
  # Mennyit emeljen, ha nincs -Version.
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',

  # Kézzel megadott verzió (x.y.z). Felülírja a -Bump-ot.
  [string]$Version = '',

  # A commit/tag/Release üzenetének kiegészítése.
  [string]$Message = '',

  # Ne pusholjon és ne készítsen GitHub Release-t.
  [switch]$NoPush,

  # Ne kérdezzen rá a kiadásra.
  [switch]$Yes,

  # Csak kiírja, mit tenne — semmit nem módosít.
  [switch]$DryRun,

  # Ne készüljön/kerüljön fel a telepítő EXE és a portable ZIP.
  [switch]$NoAssets,

  # A titok-audit kihagyása (csak akkor, ha tudod, mit teszel).
  [switch]$SkipAudit
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$versionFile = Join-Path $root 'VERSION'
$pluginRoot = Join-Path $root 'plugins'

function Fail([string]$text) { Write-Host "HIBA: $text" -ForegroundColor Red; exit 1 }
function Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'nincs git a PATH-on' }
if (-not (Test-Path (Join-Path $root '.git'))) { Fail "nem git repó: $root" }

# --- 1) jelenlegi verzió -------------------------------------------------------
$current = ''
if (Test-Path $versionFile) { $current = (Get-Content $versionFile -Raw).Trim() }
if ($current -notmatch '^\d+\.\d+\.\d+$') {
  # Visszaesés a legutóbbi tagra, hogy egy hiányzó VERSION ne törje el a kiadást.
  $lastTag = (git -C $root tag -l 'v*' | Sort-Object { [version]($_ -replace '^v', '') } | Select-Object -Last 1)
  if ($lastTag -and $lastTag -match '^v(\d+\.\d+\.\d+)$') { $current = $Matches[1] }
  else { $current = '0.0.0' }
}

# --- 2) új verzió --------------------------------------------------------------
if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "érvénytelen verzió: $Version (x.y.z kell)" }
  $next = $Version
} else {
  $parts = $current.Split('.')
  $major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
  switch ($Bump) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    default { $patch++ }
  }
  $next = "$major.$minor.$patch"
}
$tag = "v$next"

if (git -C $root tag -l $tag) { Fail "$tag már létezik — válassz nagyobb verziót" }

$subject = "Release $tag"
if ($Message) { $subject = "$subject — $Message" }

Write-Host ''
Write-Host "Projekt : $root"
Write-Host "Verzió  : $current  ->  $next  (tag: $tag)"
Write-Host "Üzenet  : $subject"
Write-Host "Push    : $(if ($NoPush) { 'nem' } else { 'igen' })"
Write-Host "Release : $(if ($NoPush) { 'nem' } else { 'igen (gh release create)' })"
Write-Host ''

# --- a working tree állapota ---------------------------------------------------
$dirty = (git -C $root status --porcelain)
if ($dirty) {
  $count = @($dirty -split "`r?`n" | Where-Object { $_ }).Count
  Write-Host "Commitolatlan változás: $count fájl (a kiadás része lesz)." -ForegroundColor Yellow
} else {
  Write-Host 'Nincs commitolatlan változás — csak a verzió és a tag készül.'
}

# --- gh ellenőrzés -------------------------------------------------------------
if (-not $NoPush) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) { Fail 'nincs gh a PATH-on (a GitHub Release-hez kell); használd a -NoPush kapcsolót' }
  try { gh auth status 2>&1 | Out-Null } catch { Fail 'a gh nincs bejelentkezve (gh auth login)' }
}

if ($DryRun) {
  Write-Host 'DRY-RUN — a lépések, amiket végrehajtanék:'
  if (-not $SkipAudit) { Write-Host '  0) node tools\audit-secrets.mjs  (a kiadás kapuja)' }
  if (-not $NoAssets) { Write-Host '  0b) tools\build-installer.ps1  (portable ZIP + telepítő EXE)' }
  Write-Host "  1) VERSION + plugins/*/package.json -> $next"
  Write-Host "  2) git add -A; git commit -m `"$subject`""
  Write-Host "  3) git tag -a $tag -m `"$subject`""
  if (-not $NoPush) {
    Write-Host ('  4) git push; git push origin ' + $tag)
    Write-Host "  5) gh release create $tag --title `"$tag`" --generate-notes"
    if (-not $NoAssets) { Write-Host "  6) gh release upload $tag dist\DeepSeek-Harness-*" }
  }
  exit 0
}

if (-not $Yes) {
  $answer = Read-Host "Kiadás: $tag. Folytatod? (i/n)"
  if ($answer -notmatch '^(i|I|y|Y|igen)$') { Write-Host 'Megszakítva.'; exit 0 }
}

# --- 2b) titok-audit: a kiadás KAPUJA -----------------------------------------
# MIÉRT ITT: egy nyilvános repóba került kulcs vagy személyes adat visszavonása
# csak a kulcs cseréjével lehetséges — a git-előzményből nem tűnik el. Ezért a
# kiadás nem megy tovább, ha a mostani fában találat van. (A git-előzmény
# találatait jelenti, de nem blokkol: azt csak történelem-átírással lehet
# eltüntetni, és a döntés a kiadóé.)
if (-not $SkipAudit) {
  $audit = Join-Path $root 'tools\audit-secrets.mjs'
  if (Test-Path $audit) {
    Step 'Titok- és személyesadat-audit'
    & node $audit
    if ($LASTEXITCODE -ne 0) {
      Fail 'a titok-audit találatot adott a mostani fában — a kiadás leáll. Javítsd, majd indítsd újra (vagy -SkipAudit, ha tudod, mit teszel).'
    }
  }
}

# --- 3) verzió írása -----------------------------------------------------------
# A VERZIÓ MINDEN MÁS ELŐTT: a csomagoló a VERSION fájlból nevezi el a
# telepítőt és a ZIP-et, ezért ha utána írnánk ki, a kiadás a RÉGI verziószámú
# fájlokat töltené fel (mért hiba, 2026-10-02: a v0.1.1 kiadásra 0.1.0 nevű
# csomag került).
Step "Verzió frissítése: $next"
Set-Content -Path $versionFile -Value "$next" -Encoding ASCII
Get-ChildItem $pluginRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $pkg = Join-Path $_.FullName 'package.json'
  if (-not (Test-Path $pkg)) { return }
  $raw = Get-Content $pkg -Raw
  $updated = [regex]::Replace($raw, '("version"\s*:\s*")[^"]*(")', "`${1}$next`${2}", 1)
  if ($updated -ne $raw) {
    # BOM nélkül írjuk: a PowerShell 5.1 `Set-Content -Encoding UTF8` BOM-ot tesz
    # a fájl elejére, ami a package.json-ban felesleges zaj (és minden diffet
    # elrontana).
    [System.IO.File]::WriteAllText($pkg, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  $($_.Name)/package.json -> $next"
  }
}

# --- 3b) kiadási csomagok ------------------------------------------------------
# A csomagok a COMMIT ELŐTT készülnek el, mert a build a git által követett
# halmazból dolgozik: így a csomag pontosan a kiadandó állapotot tartalmazza, és
# egy fordítási hiba nem hagy maga után feltöltött taget.
#
# CSAK AZ EHHEZ A VERZIÓHOZ tartozó fájlokat vesszük fel: a dist\-ben maradhat
# egy korábbi kiadás csomagja, és azt NEM szabad feltölteni.
$assets = @()
if (-not $NoAssets) {
  Step 'Kiadási csomagok (portable ZIP + telepítő EXE)'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build-installer.ps1')
  if ($LASTEXITCODE -ne 0) { Fail "a csomagolás nem sikerült (exit $LASTEXITCODE)" }
  $assets = @(Get-ChildItem (Join-Path $root 'dist') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.zip', '.exe' -and $_.BaseName -like "*$next*" } |
    Select-Object -ExpandProperty FullName)
  if (-not $assets.Count) { Fail "nem készült a $next verzióhoz tartozó csomag a dist\ mappába" }
  foreach ($a in $assets) { Write-Host "  $a" }
}

# --- 4) commit -----------------------------------------------------------------
Step 'Commit'
git -C $root add -A
# Ha csak a VERSION változott, ez is commitol; ha semmi, a commit kimarad.
$pending = (git -C $root status --porcelain)
if ($pending) {
  git -C $root commit -m $subject | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host '  nincs mit commitolni'
}

# --- 5) tag --------------------------------------------------------------------
Step "Tag: $tag"
git -C $root tag -a $tag -m $subject
Write-Host "  kész"

if ($NoPush) {
  Write-Host ''
  Write-Host 'Kész (push és Release nélkül). A pusholáshoz:'
  Write-Host "  git push; git push origin $tag"
  exit 0
}

# --- 6) push -------------------------------------------------------------------
Step 'Push'
git -C $root push | ForEach-Object { Write-Host "  $_" }
git -C $root push origin $tag | ForEach-Object { Write-Host "  $_" }

# --- 7) GitHub Release ---------------------------------------------------------
Step "GitHub Release: $tag"
$prevTag = (git -C $root tag -l 'v*' | Where-Object { $_ -ne $tag } | Sort-Object { [version]($_ -replace '^v', '') } | Select-Object -Last 1)
$ghArgs = @('release', 'create', $tag, '--title', $tag, '--generate-notes')
if ($prevTag) { $ghArgs += @('--notes-start-tag', $prevTag); Write-Host "  jegyzetek: $prevTag..$tag" }
if ($Message) { $ghArgs += @('--notes', $Message) }
& gh @ghArgs
if ($LASTEXITCODE -ne 0) { Fail "a gh release create nem sikerült (exit $LASTEXITCODE) — a tag és a push már fenn van" }

# --- 8) a csomagok feltöltése a Release-hez ------------------------------------
# EZÉRT KELL: a README a Release-ből linkeli a telepítőt — csatolt fájl nélkül a
# letöltési hivatkozás üres lenne.
if ($assets.Count -gt 0) {
  Step "Csomagok feltöltése ($($assets.Count) fájl)"
  & gh release upload $tag @assets --clobber
  if ($LASTEXITCODE -ne 0) { Fail "a csomagok feltöltése nem sikerült (exit $LASTEXITCODE) — a Release létezik, a fájlokat kézzel is felteheted" }
}

Write-Host ''
Write-Host "KÉSZ: $tag kiadva." -ForegroundColor Green
Write-Host "  https://github.com/svandor/deepseek-harness-windows/releases/tag/$tag"
