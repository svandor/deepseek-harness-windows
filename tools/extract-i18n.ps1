#Requires -Version 5
<#
  extract-i18n.ps1 — kigyujti a beepitett DSH kliens-pluginok ANGOL szovegkulcsait.

  Miert kell: a HU nyelvi csomaghoz ismerni kell a pontos kulcs- és
  nevter-neveket. A bundle-okban `const zh = {...}` es `const en = {...}`
  blokkokban vannak a szotarak, a nevter pedig a `locale.register(NS, ...)`
  hivas elotti `const NS = "..."` deklaracioban.

  Kimenet:  state\i18n-en.json   (nevter -> { kulcs: angol ertek })
            state\i18n-en.tsv    (nevter<TAB>kulcs<TAB>ertek, rendezve)

  Hasznalat:
      .\tools\extract-i18n.ps1                 # alapertelmezett npx cache
      .\tools\extract-i18n.ps1 -Root <path>    # mas node_modules gyoker
#>
[CmdletBinding()]
param(
    [string]$Root,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ws   = Split-Path -Parent $here
if (-not $OutDir) { $OutDir = Join-Path $ws 'state' }

if (-not $Root) {
    # a legfrissebb npx cache alatt levo @deepseek-ai csomagok
    $cand = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node_modules\@deepseek-ai' } |
        Where-Object { Test-Path $_ }
    $cand = @($cand)
    if ($cand.Count -eq 0) { throw "Nem talalom a @deepseek-ai csomagokat. Add meg a -Root parametert." }
    $Root = $cand[0]
}
if (-not (Test-Path $Root)) { throw "A megadott gyoker nem letezik: $Root" }
Write-Host "Forras: $Root" -ForegroundColor Cyan

function Get-ObjectBlock {
    # A $text $startIdx-nal levo '{' -tol kezdve visszaadja a teljes, kiegyensulyozott
    # kapcsos blokkot. Figyelembe veszi a string-eket es a tombot is.
    param([string]$Text, [int]$StartIdx)
    $i = $StartIdx
    $depth = 0
    $inStr = $false
    $quote = ''
    $esc = $false
    while ($i -lt $Text.Length) {
        $c = $Text[$i]
        if ($inStr) {
            if ($esc) { $esc = $false }
            elseif ($c -eq '\') { $esc = $true }
            elseif ($c -eq $quote) { $inStr = $false }
        }
        else {
            if ($c -eq '"' -or $c -eq "'" -or $c -eq '`') { $inStr = $true; $quote = $c }
            elseif ($c -eq '{') { $depth++ }
            elseif ($c -eq '}') {
                $depth--
                if ($depth -eq 0) { return $Text.Substring($StartIdx, $i - $StartIdx + 1) }
            }
        }
        $i++
    }
    return $null
}

$result = [ordered]@{}

<#
  A szotarban a kulcs lehet idezojelben ("detail.aria") vagy a nelkul is
  (waiting). Az elso valtozat csak az idezojeles kulcsokat latta, ezert egyes
  nevterek (pl. az `approval`) tobb kulcsa hianyzott a kigyujtesbol — es a
  check-plugin.mjs ezt "ismeretlen kulcs"-nak jelentette volna a magyar
  csomagban. Mindket alakot olvassuk.
#>
$pairPattern = '(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*))\s*:\s*"((?:[^"\\]|\\.)*)"'

function Get-StringPairs {
    param([string]$Block)
    $dict = [ordered]@{}
    foreach ($pr in [regex]::Matches($Block, $pairPattern)) {
        $key = if ($pr.Groups[1].Success) { $pr.Groups[1].Value } else { $pr.Groups[2].Value }
        $value = $pr.Groups[3].Value
        if (-not $dict.Contains($key)) { $dict[$key] = $value }
    }
    return $dict
}

# A shell sajat szotarai (a `common` nevtér és a `settings.locale` sor) a
# dsh-client-locale csomagban vannak, nem a ui-* pluginokban.
$extra = @(
    @{ file = 'dsh-client-locale\lib\client.js'; ns = 'common' }
)
foreach ($e in $extra) {
    $p = Join-Path $Root $e.file
    if (-not (Test-Path $p)) { continue }
    $text = Get-Content $p -Raw
    # a common szotar a `const zh$1 = {` / `const en$1 = {` nevu valtozokban van;
    # ha nincs szamozas, akkor sima `const en = {`.
    $em = [regex]::Match($text, 'const\s+en\$\d*\s*=\s*\{')
    if (-not $em.Success) { $em = [regex]::Match($text, 'const\s+en\s*=\s*\{') }
    if ($em.Success) {
        $block = Get-ObjectBlock -Text $text -StartIdx ($em.Index + $em.Length - 1)
        if ($block) {
            $bucket = Get-StringPairs -Block $block
            if ($bucket.Count -gt 0) {
                $result[$e.ns] = [pscustomobject]@{ package = (Split-Path (Split-Path (Split-Path $p -Parent) -Parent) -Leaf); keys = $bucket }
            }
        }
    }
}

$files = Get-ChildItem (Join-Path $Root 'dsh-client-ui-*\lib\client.js') -ErrorAction SilentlyContinue
foreach ($f in $files) {
    $pkg = Split-Path (Split-Path $f.DirectoryName -Parent) -Leaf
    $text = Get-Content $f.FullName -Raw

    # nevter: const NS = "..."  (a bundle elejen, a locale.register elott)
    $ns = $null
    $nsm = [regex]::Match($text, 'const\s+NS\s*=\s*"([^"]+)"')
    if ($nsm.Success) { $ns = $nsm.Groups[1].Value }

    # angol szotar blokk
    $em = [regex]::Match($text, 'const\s+en\s*=\s*\{')
    if (-not $em.Success) { continue }
    $block = Get-ObjectBlock -Text $text -StartIdx ($em.Index + $em.Length - 1)
    if (-not $block) { continue }

    $pairs = Get-StringPairs -Block $block
    if ($pairs.Count -eq 0) { continue }

    $key = if ($ns) { $ns } else { $pkg }
    $i = 1
    while ($result.Contains($key)) { $i++; $key = "$ns#$i" }
    $result[$key] = [pscustomobject]@{ package = $pkg; keys = $pairs }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$json = Join-Path $OutDir 'i18n-en.json'
$result | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $json

$tsv = Join-Path $OutDir 'i18n-en.tsv'
$lines = foreach ($ns in $result.Keys) {
    foreach ($k in $result[$ns].keys.Keys) {
        "{0}`t{1}`t{2}" -f $ns, $k, $result[$ns].keys[$k]
    }
}
$lines | Sort-Object | Set-Content -Encoding UTF8 $tsv

$total = ($result.Values | ForEach-Object { $_.keys.Count } | Measure-Object -Sum).Sum
Write-Host ("Nevter: {0}   kulcs: {1}" -f $result.Count, $total) -ForegroundColor Green
Write-Host "  $json"
Write-Host "  $tsv"
