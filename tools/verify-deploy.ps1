<#
.SYNOPSIS
  A dsh-ui-extras plugin eles allapotanak ellenorzese ujrainditas NELKUL.

.DESCRIPTION
  A "deploy" gomb lenyege, hogy a szerver kicserelodik. Ez a szkript nem indit
  ujra semmit: a MÁR FUTÓ szervertol kerdez, ezert biztonsagosan, barmikor
  futtathato - pont ezert valo arra, hogy egy deploy utan igazolja az eredmenyt.

  Amit ellenoriz:
    1) a boot oldal betolt-e (nincs "Failed to load plugins"),
    2) a plugin bundle szerepel-e a boot grafban,
    3) minden host vegpont valaszol-e (a 404 azt jelenti, hogy a futo szerver
       meg a regi kodot tartja memoriaban -> ujrainditas kell),
    4) a state\harness.url friss-e (a restart helper ezt irja),
    5) a nyelvi csomag jelentes a /ui-extras/i18n vegponton,
    6) a legutobbi restart naploja.

  Kimenet: minden sor "ok"/"HIBA" elotaggal, es a vegen egy osszegzes.

.EXAMPLE
  .\tools\verify-deploy.ps1
  .\tools\verify-deploy.ps1 -Probe     # nyelvi jelentes bekuldese is (proba URL)
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$problems = 0
$url = "http://127.0.0.1:$Port"

function Ok($msg) { Write-Host "  ok    $msg" -ForegroundColor Green }
function Bad($msg) { $script:problems++; Write-Host "  HIBA  $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "  info  $msg" -ForegroundColor DarkGray }

# --- 1) boot oldal ------------------------------------------------------------
# A token nelkuli kereses 401-et ad, ezert a mentett tokent hasznaljuk; az
# "el" allapotot a 401 is bizonyitja (a szerver valaszol).
$token = $null
$urlFile = Join-Path $root 'state\harness.url'
if (Test-Path $urlFile) {
  $saved = (Get-Content $urlFile -Raw).Trim()
  if ($saved -match 'token=([A-Za-z0-9_\-]+)') { $token = $Matches[1] }
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$html = $null
if ($token) {
  try {
    $html = (Invoke-WebRequest "$url/?token=$token" -UseBasicParsing -WebSession $session -TimeoutSec 15).Content
  } catch {
    Bad "a boot oldal nem tolt be a mentett tokennel: $($_.Exception.Message)"
  }
} else {
  Bad "nincs token a state\harness.url fajlban"
}

if ($html) {
  Ok "boot oldal betolt ($($html.Length) karakter)"
  if ($html -match 'Failed to load plugins') { Bad "a boot oldal hibát jelez: 'Failed to load plugins'" }
  else { Ok "nincs 'Failed to load plugins' a boot oldalon" }
  if ($html -match 'dsh-ui-extras/client\.js') { Ok "a plugin bundle szerepel a boot grafban" }
  else { Bad "a plugin bundle NEM szerepel a boot grafban" }
}

# --- 2) host vegpontok --------------------------------------------------------
function Probe-Path($path) {
  try {
    $response = Invoke-WebRequest "$url$path" -UseBasicParsing -WebSession $session -TimeoutSec 15
    return @{ status = [int]$response.StatusCode; body = $response.Content }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    return @{ status = if ($code) { [int]$code } else { 0 }; body = $null }
  }
}

$routes = @(
  @{ path = '/ui-extras/balance'; what = 'egyenleg' },
  @{ path = '/ui-extras/git?root=' + [uri]::EscapeDataString($root); what = 'git' },
  @{ path = '/ui-extras/ssh'; what = 'ssh' },
  @{ path = '/ui-extras/cmd?action=list&workspace=' + [uri]::EscapeDataString($root); what = 'cmd' },
  @{ path = '/ui-extras/github?root=' + [uri]::EscapeDataString($root); what = 'github' },
  @{ path = '/ui-extras/i18n'; what = 'i18n jelentes' },
  @{ path = '/ui-extras/log'; what = 'kliens naplo' },
  @{ path = '/ui-extras/harness-url'; what = 'harness URL' }
)
foreach ($route in $routes) {
  $result = Probe-Path $route.path
  if ($result.status -eq 200) { Ok "$($route.what) vegpont: HTTP 200" }
  elseif ($result.status -eq 404) { Bad "$($route.what) vegpont: HTTP 404 - a futo szerver meg a regi kodot tartja (ujrainditas kell)" }
  else { Bad "$($route.what) vegpont: HTTP $($result.status)" }
}

# --- 3) harness.url frissesseg --------------------------------------------------
if (Test-Path $urlFile) {
  $age = [int]((Get-Date) - (Get-Item $urlFile).LastWriteTime).TotalSeconds
  if ($age -le 3600) { Ok "state\harness.url friss ($age masodperces)" }
  else { Bad "state\harness.url regi ($age masodperc) - a token lehet, hogy lejart" }
}

# --- 4) nyelvi csomag ----------------------------------------------------------
if ($Probe -and $token) {
  try { Invoke-WebRequest "$url/?token=$token&dsh-ui-extras-probe=1" -UseBasicParsing -WebSession $session -TimeoutSec 15 | Out-Null } catch { }
  Start-Sleep -Seconds 2
}
$report = Probe-Path '/ui-extras/i18n'
if ($report.status -eq 200 -and $report.body) {
  try {
    $parsed = $report.body | ConvertFrom-Json
    if ($parsed.ok) {
      Ok "nyelvi jelentes: aktiv=$($parsed.active) valaszthato=$($parsed.locales -join ',')"
      $parsed.namespaces.PSObject.Properties | ForEach-Object {
        $value = $_.Value
        if ($value -is [string] -and $value -like 'FAILED*') { Bad "nyelvi csomag $($_.Name): $value" }
        else { Ok "nyelvi csomag $($_.Name): $value kulcs" }
      }
    } else {
      Info "meg nincs nyelvi jelentes ($($parsed.reason)); futtasd -Probe kapcsoloval"
    }
  } catch {
    Bad "a nyelvi jelentes nem ertelmezheto JSON: $($_.Exception.Message)"
  }
}

# --- 5) kliens oldali hibanaplo ------------------------------------------------
$clientLog = Join-Path $root 'state\ui-extras-client.log'
if (Test-Path $clientLog) {
  $tail = Get-Content $clientLog -Tail 5
  Bad "a kliens hibakat jelentett (state\ui-extras-client.log):"
  foreach ($line in $tail) { Write-Host "        $line" -ForegroundColor DarkYellow }
} else {
  Ok "nincs kliens oldali hiba a naploban"
}

# --- 6) restart naplo -----------------------------------------------------------
foreach ($name in @('restart.log', 'restart-script.log')) {
  $log = Join-Path $root "state\$name"
  if (Test-Path $log) {
    $tail = (Get-Content $log -Tail 3) -join ' | '
    Info "${name}: $tail"
  }
}

Write-Host ''
if ($problems -eq 0) { Write-Host 'MINDEN RENDBEN' -ForegroundColor Green }
else { Write-Host "$problems problema" -ForegroundColor Red }
exit $problems
