<#
.SYNOPSIS
    A DshWindow WebView2-profilgenerációinak tisztítása.

.DESCRIPTION
    A DshWindow.exe minden ablakindításkor ÚJ WebView2-profilt hoz létre a
    state\webview2\gen-<időbélyeg> mappában, és a régit nem törli. Ezért a
    mappa folyamatosan nő: mért eset 61 generáció, 2,2 GB, 15 635 fájl.

    A futó ablak a state\webview2\pane-1 és pane-2 profilt használja
    (többpaneles módban), ezeket SOHA nem érintjük.

    Biztonsági szabályok:
      - csak a `gen-*` mintát érinti (a pane-* mappákat nem),
      - a megadottnál fiatalabb generációt nem töröl (alapból 14 nap),
      - a legfrissebb N generációt megtartja (alapból 2),
      - -WhatIf esetén csak kilistázza, mit tenne.

.PARAMETER OlderThanDays
    Ennél fiatalabb generációhoz nem nyúl. Alapértelmezés: 14.

.PARAMETER KeepNewest
    Ennyi legfrissebb generációt megtart. Alapértelmezés: 2.

.PARAMETER WhatIf
    Csak kilistázza a törlendőket, nem töröl.

.EXAMPLE
    .\clean-webview2-profiles.ps1 -WhatIf
    .\clean-webview2-profiles.ps1
    .\clean-webview2-profiles.ps1 -OlderThanDays 30 -KeepNewest 3
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 3650)][int]$OlderThanDays = 14,
    [ValidateRange(0, 50)][int]$KeepNewest = 2,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$wv2 = Join-Path (Split-Path -Parent $root) 'state\webview2'

if (-not (Test-Path $wv2)) {
    Write-Host "Nincs WebView2 mappa: $wv2" -ForegroundColor Yellow
    return
}

function Get-DirSize($path) {
    (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
}

$before = Get-DirSize $wv2

# Csak a gen-* mappák; a pane-* az élő ablak profilja.
$gens = Get-ChildItem $wv2 -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'gen-*' } |
    Sort-Object CreationTime -Descending

if ($gens.Count -eq 0) {
    Write-Host "Nincs tisztítanivaló generáció. ($([math]::Round($before/1MB,1)) MB)" -ForegroundColor Green
    return
}

$cutoff = (Get-Date).AddDays(-$OlderThanDays)
$keep = $gens | Select-Object -First $KeepNewest
$candidates = $gens | Select-Object -Skip $KeepNewest | Where-Object { $_.CreationTime -lt $cutoff }

Write-Host "WebView2 mappa: $wv2"
Write-Host ("Jelenlegi méret: {0:N1} MB, generációk: {1}" -f ($before/1MB), $gens.Count) -ForegroundColor Gray
Write-Host ("Megtartva: {0}" -f (($keep | ForEach-Object Name) -join ', ')) -ForegroundColor Gray
Write-Host ("Törlendő: {0} generáció ({1} napnál régebbi)" -f $candidates.Count, $OlderThanDays) -ForegroundColor Gray
Write-Host ""

if ($candidates.Count -eq 0) {
    Write-Host "Nincs elég régi generáció a törléshez." -ForegroundColor Green
    return
}

$freed = 0
$ok = 0
$fail = 0
foreach ($g in $candidates) {
    $size = Get-DirSize $g.FullName
    if ($WhatIf) {
        Write-Host ("  [WhatIf] {0}  {1:N1} MB" -f $g.Name, ($size/1MB)) -ForegroundColor DarkGray
        $freed += $size
        continue
    }
    try {
        Remove-Item $g.FullName -Recurse -Force -ErrorAction Stop
        $ok++
        $freed += $size
    } catch {
        $fail++
        Write-Host ("  ! {0}: {1}" -f $g.Name, $_.Exception.Message) -ForegroundColor Yellow
    }
}

$after = Get-DirSize $wv2
Write-Host ""
if ($WhatIf) {
    Write-Host ("[WhatIf] Felszabadítható: {0:N0} MB" -f ($freed/1MB)) -ForegroundColor Cyan
} else {
    Write-Host ("Törölve: {0}, sikertelen: {1}" -f $ok, $fail) -ForegroundColor Green
    Write-Host ("Méret: {0:N1} MB -> {1:N1} MB  (felszabadult {2:N0} MB)" -f ($before/1MB), ($after/1MB), (($before-$after)/1MB)) -ForegroundColor Green
}
