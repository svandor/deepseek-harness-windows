<#
.SYNOPSIS
  A sajat DSH UI-plugin (dsh-ui-extras) be- vagy kikapcsolasa az eles profilban.

.DESCRIPTION
  A profil cordis.patch.yml fajljanak egyetlen bejegyzeset kezeli, majd
  ujrainditja a harness-t. Minden lepes mentessel es ellenorzessel megy:

    1) mentes keszul a jelenlegi patch-rol,
    2) a bejegyzes beirasa vagy eltavolitasa,
    3) a regi harness leallitasa (a portot figyelo folyamat),
    4) friss harness inditasa a meglevo dsh telepitesbol,
    5) annak ellenorzese, hogy a boot oldal betolt-e (nincs "Failed to load
       plugins"), es hogy a plugin bundle szerepel-e a boot grafban,
    6) az uj belepesi URL kiirasa.

  Ha barmi elromlik, ugyanez a szkript -Disable kapcsoloval azonnal visszaallit.

.EXAMPLE
  .\tools\deploy-plugin.ps1              # bekapcsolas + ujrainditas
  .\tools\deploy-plugin.ps1 -Disable     # kikapcsolas + ujrainditas
  .\tools\deploy-plugin.ps1 -NoRestart   # csak a patch modositasa
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'web',
  [switch]$Disable,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$patch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"

if (-not (Test-Path $patch)) { throw "Nem talalom a profil patchet: $patch" }

# --- 1) mentes ----------------------------------------------------------------
$backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $patch $backup -Force
Write-Host "Mentes: $backup"

# --- 2) bejegyzes be/ki -------------------------------------------------------
$header = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
'@

if ($Disable) {
  Set-Content -Path $patch -Value ($header + "`n[]`n") -Encoding UTF8
  Write-Host 'Plugin bejegyzes eltavolitva a profil patch-bol.'
} else {
  $entry = @'
#
# DeepSeek Harness UI-bovitesek (dsh-ui-extras): sajat statisztika panel.
# Forras: C:\Szerver\Deepseek Harness\plugins\dsh-ui-extras
# Kikapcsolas: .\tools\deploy-plugin.ps1 -Disable
- insert:
    - id: ui-extras
      name: dsh-ui-extras
'@
  Set-Content -Path $patch -Value ($header + "`n" + $entry) -Encoding UTF8
  Write-Host 'Plugin bejegyzes beirva a profil patch-ba.'
}

if ($NoRestart) { Write-Host '(-NoRestart: a harness nem indul ujra)'; return }

# --- 3-6) ujrainditas + ellenorzes -------------------------------------------
# FONTOS: a restart-harness.ps1 szkriptet hivjuk (nem a recover-t), mert az
# nem nyul a profil patch-hoz - igy a frissen beirt bejegyzes megmarad.
& (Join-Path $root 'tools\restart-harness.ps1') -Port $Port -DshHome $DshHome -Profile $Profile

Write-Host ''
Write-Host 'Ellenorzes...'
Start-Sleep -Seconds 3

$url = $null
foreach ($candidate in @(
    (Join-Path $DshHome 'dsh-web\harness.log'),
    (Join-Path $root 'state\harness.log')
  )) {
  if (Test-Path $candidate) {
    $match = ((Get-Content $candidate -Raw) | Select-String -Pattern "http://127\.0\.0\.1:$Port/\?token=[A-Za-z0-9_\-]+" -AllMatches).Matches.Value | Select-Object -First 1
    if ($match) { $url = $match; break }
  }
}

if (-not $url) {
  Write-Host 'FIGYELEM: nem talaltam token URL-t. Ha a felulet nem tolt be, futtasd:'
  Write-Host "  $root\tools\recover-harness.ps1"
  return
}

$token = ($url -split 'token=')[1]
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try { Invoke-WebRequest "http://127.0.0.1:$Port/?token=$token" -UseBasicParsing -WebSession $session -TimeoutSec 10 | Out-Null } catch { }
$html = $null
try { $html = (Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -WebSession $session -TimeoutSec 10).Content } catch { }

if ($html) {
  if ($html -match 'Failed to load plugins') {
    Write-Host '*** BOOT HIBA: a felulet nem tolt be. Visszaallitas:'
    Write-Host "  $root\tools\deploy-plugin.ps1 -Disable"
  } else {
    Write-Host 'BOOT OK (nincs "Failed to load plugins")'
    if ($html -match 'dsh-ui-extras/client\.js') { Write-Host 'A plugin bundle szerepel a boot grafban.' }
  }
}

# --- 7) nyelvi csomag ellenorzese ---------------------------------------------
# A nyelvi szotarak a bongeszoben regisztralodnak, ezert a kliens egy proba-URL
# hatasara elkuldi a jelenteset a /ui-extras/i18n vegpontra; itt csak lekerdezzuk.
if ($html -and $token) {
  Write-Host ''
  Write-Host 'Nyelvi csomag ellenorzese...'
  try {
    Invoke-WebRequest "http://127.0.0.1:$Port/?token=$token&dsh-ui-extras-probe=1" -UseBasicParsing -WebSession $session -TimeoutSec 15 | Out-Null
  } catch { }
  $report = $null
  for ($i = 0; $i -lt 10 -and -not $report; $i++) {
    Start-Sleep -Milliseconds 700
    try {
      $raw = (Invoke-WebRequest "http://127.0.0.1:$Port/ui-extras/i18n" -UseBasicParsing -WebSession $session -TimeoutSec 10).Content
      $parsed = $raw | ConvertFrom-Json
      if ($parsed.ok) { $report = $parsed }
    } catch { }
  }
  if (-not $report) {
    Write-Host 'FIGYELEM: nem erkezett nyelvi jelentes (a felulet kliens-oldali betoltese nem futott le).'
  } else {
    Write-Host ("  aktiv nyelv: {0}   valaszthato: {1}" -f $report.active, ($report.locales -join ', '))
    $report.namespaces.PSObject.Properties | ForEach-Object {
      $value = $_.Value
      if ($value -is [string] -and $value -like 'FAILED*') {
        Write-Host ("  {0}: {1}" -f $_.Name, $value) -ForegroundColor Yellow
      } else {
        Write-Host ("  {0}: {1} kulcs" -f $_.Name, $value)
      }
    }
  }
}

Write-Host ''
Write-Host 'Nyisd meg ezt a cimet a bongeszoben (friss token):'
Write-Host "  $url"
