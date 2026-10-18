<#
.SYNOPSIS
  A repó git hookjainak bekapcsolása (commit-üzenet nyelvének ellenőrzése).

.DESCRIPTION
  A repo nyilvános, ezért a commit-üzenetek angolul íródnak. A szabályt egy
  `commit-msg` hook kényszeríti ki, amely a `tools/check-commit-msg.mjs`-t hívja.
  A hookok a repóban, verziózva élnek (`tools/hooks/`), ezért a `core.hooksPath`
  beállítására van szükség — a `.git/hooks` mappa nem követett, így klónozás után
  elveszne.

  Az installer idempotens: többszöri futtatás után is ugyanaz az állapot.

.PARAMETER Uninstall
  A hookok kikapcsolása (a `core.hooksPath` törlése).

.EXAMPLE
  .\tools\install-hooks.ps1
  .\tools\install-hooks.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$hooks = Join-Path $root 'tools\hooks'

if ($Uninstall) {
  git -C $root config --unset core.hooksPath
  if ($LASTEXITCODE -ne 0) { Write-Host 'Nem volt beállítva core.hooksPath.' }
  else { Write-Host 'Hookok kikapcsolva (core.hooksPath törölve).' }
  return
}

if (-not (Test-Path (Join-Path $hooks 'commit-msg'))) {
  throw "Nem találom a hookot: $hooks\commit-msg"
}

git -C $root config core.hooksPath 'tools/hooks'
if ($LASTEXITCODE -ne 0) { throw 'A core.hooksPath beállítása nem sikerült.' }

Write-Host 'Hookok bekapcsolva: core.hooksPath = tools/hooks'
Write-Host '  commit-msg: magyar commit-üzenetet elutasít (a repó nyilvános).'
Write-Host '  Kikapcsolás: .\tools\install-hooks.ps1 -Uninstall'
Write-Host '  Megkerülés: git commit --no-verify, vagy "commit-lang: any" sor az üzenetben.'

# --- önellenőrzés: a két irány egyidejű próbája -----------------------------
# A magyar üzenet elutasítása VÁRT hiba (1-es kilépés, stderr-üzenet): a
# hibakezelést itt átmenetileg kikapcsoljuk, különben a szkript megállna rajta.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$checker = Join-Path $root 'tools\check-commit-msg.mjs'
$hu = Join-Path $env:TEMP ('dsh-commit-hu-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$en = Join-Path $env:TEMP ('dsh-commit-en-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
Set-Content -Path $hu -Value 'Labléc: a DeepSeek-oldal a feltoltott egyenleget mutatja' -Encoding UTF8
Set-Content -Path $en -Value 'Footer: the DeepSeek side shows the topped-up balance' -Encoding UTF8
node $checker $en 2>$null
$englishOk = $LASTEXITCODE -eq 0
node $checker $hu 2>$null
$hungarianRejected = $LASTEXITCODE -eq 1
$ErrorActionPreference = $previous
Remove-Item $hu, $en -Force -ErrorAction SilentlyContinue

if ($englishOk -and $hungarianRejected) {
  Write-Host 'Önellenőrzés: OK (az angol üzenet átmegy, a magyar elutasítva).'
} else {
  throw ("Önellenőrzés HIBA: angol átmegy={0}, magyar elutasítva={1}" -f $englishOk, $hungarianRejected)
}
