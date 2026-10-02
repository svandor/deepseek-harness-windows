<#
.SYNOPSIS
  DeepSeek Harness helyreallitas: a sajat plugin-bejegyzes eltavolitasa.

.DESCRIPTION
  Ha egy sajat UI-plugin megbuktatja a boot-ot ("Failed to load plugins"), ez a
  szkript:
    1) kiuriti a profil cordis.patch.yml fajljat (minden sajat bejegyzes nelkul),
    2) atadja a folyamatkezelest a restart-harness.ps1 szkriptnek, ami
       ujrainditja a harness-t es kiirja az uj tokenezett URL-t.

  A ket felelosseg szetvalasztasa szukseges: a deploy-plugin.ps1 ugyanezt a
  restart szkriptet hivja ujrainditashoz, tehat a frissen beirt plugin-bejegyzes
  nem veszhet el (ez korabban megtortent).

  Nem nyul az npm cache-hez es nem telepit ujra semmit.

.EXAMPLE
  .\tools\recover-harness.ps1
  .\tools\recover-harness.ps1 -Port 3081 -DshHome "C:\Szerver\Deepseek Harness\.test-dsh-home"
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'web',
  [string]$DshBin = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# --- 1) sajat plugin-bejegyzesek eltavolitasa ---------------------------------
$patch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
if (Test-Path $patch) {
  $backup = "$patch.recover-backup"
  Copy-Item $patch $backup -Force
  $empty = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
'@
  Set-Content -Path $patch -Value $empty -Encoding UTF8
  Write-Host "Profil patch kiuritve (mentes: $backup)"
} else {
  Write-Host "Nincs patch fajl: $patch"
}

# --- 2) ujrainditas atadasa ---------------------------------------------------
& (Join-Path $root 'tools\restart-harness.ps1') -Port $Port -DshHome $DshHome -Profile $Profile -DshBin $DshBin
