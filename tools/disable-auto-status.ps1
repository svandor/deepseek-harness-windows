<#
.SYNOPSIS
  A chat mező fölötti „Auto → deepseek/..." állapotsáv kikapcsolása.

.DESCRIPTION
  MIÉRT: a modellválasztó gomb már kiírja a tényleges célt
  („Auto (deepseek/deepseek-flash)"), ezért a felette lévő külön állapotsáv
  ugyanazt ismétli — kétszer jelenik meg ugyanaz az információ.

  A sávot a `dsh-auto-status` kliens-plugin rajzolja. A plugin a
  `~/.dsh/profiles/web/cordis.patch.yml` fájlban van bejegyezve:

      - insert:
          - id: auto-status
            name: dsh-auto-status

  Ez a szkript ezt a három sort kikommenteli (a fájlról mentést készít).
  A patch csak boot-időben töltődik, ezért utána a harness-t újra kell
  indítani — ezt a rendszertálca menüjéből lehet: „Harness újraindítása".

.EXAMPLE
  & "C:\Szerver\Deepseek Harness\tools\disable-auto-status.ps1"
  & "C:\Szerver\Deepseek Harness\tools\disable-auto-status.ps1" -Restore
#>
[CmdletBinding()]
param(
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'

$profileFile = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (-not (Test-Path $profileFile)) {
  throw "Nem találom: $profileFile"
}

$backup = "$profileFile.bak-auto-status"
$lines = Get-Content $profileFile

if ($Restore) {
  if (-not (Test-Path $backup)) { throw "Nincs mentés: $backup" }
  Copy-Item $backup $profileFile -Force
  Write-Host "Visszaállítva a korábbi állapot." -ForegroundColor Green
  Write-Host "Indítsd újra a harness-t (tálca -> Harness újraindítása)." -ForegroundColor Cyan
  return
}

# Már ki van kapcsolva?
if ($lines | Where-Object { $_ -match '^\s*#\s*- id:\s*auto-status' }) {
  Write-Host "Az állapotsáv már ki van kapcsolva — nincs teendő." -ForegroundColor Gray
  return
}

$idIndex = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*-\s*id:\s*auto-status\s*$') { $idIndex = $i; break }
}
if ($idIndex -lt 0) {
  Write-Host "Nem találom az 'auto-status' bejegyzést — lehet, hogy már nincs benne." -ForegroundColor Yellow
  return
}
if ($idIndex -eq 0 -or $lines[$idIndex - 1] -notmatch '^\s*-\s*insert:\s*$') {
  throw "Váratlan szerkezet a(z) $idIndex. sor körül — kézi ellenőrzés kell."
}

if (-not (Test-Path $backup)) { Copy-Item $profileFile $backup -Force; Write-Host "Mentés: $backup" -ForegroundColor DarkGray }

# A három sor: "- insert:", "  - id: auto-status", "    name: dsh-auto-status"
$from = $idIndex - 1
$to = [Math]::Min($idIndex + 1, $lines.Count - 1)
for ($i = $from; $i -le $to; $i++) {
  $lines[$i] = '# ' + $lines[$i]
}

Set-Content -Path $profileFile -Value $lines -Encoding UTF8
Write-Host "Az állapotsáv kikapcsolva ($($to - $from + 1) sor kikommentelve)." -ForegroundColor Green
Write-Host ''
Write-Host 'Aktiválás: tálca (jobb klikk) -> "Harness újraindítása".' -ForegroundColor Cyan
Write-Host 'A panelek automatikusan újratöltődnek; az állapotsáv eltűnik,' -ForegroundColor Gray
Write-Host 'a modell továbbra is látszik a választó gombon: Auto (deepseek/deepseek-flash).' -ForegroundColor Gray
