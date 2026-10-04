<#
.SYNOPSIS
  A javitott DSH ablak kiprobalasa futo ablak mellett (diagnosztika + csere).

.DESCRIPTION
  1) BIZTONSAGI MENTES: a jelenlegi bin\DshWindow.exe-t atmasolja
     state\focus-probe\DshWindow.exe.bak nevre, hogy barmikor vissza lehessen
     allni.
  2) CSERE: a frissen forditott bin\DshWindow.exe.new helyere lep.
     A MAR FUTÓ ablak a regi kodot futtatja tovabb (a Windows a megnyitott
     peldanyt nem erinti), tehat a munka nem szakad meg.
  3) A kovetkezo ablaknyitas (talcairon: Megnyitas, vagy a felosztas
     valtasa) mar a javitott kodot inditja.

  A javitas ertesitese a state\window.log-ba kerul:
    - "focus keeper installed (pane N)"  -> a lapoldali figyelo elindult
    - "focus keeper (pane N): {...}"     -> a lap jelentese (blur/focus/restore)
    - "focus restore (window activated)" -> a natív oldal visszaadta a fokuszt

.EXAMPLE
  .\tools\deploy-window-focus.ps1
  .\tools\deploy-window-focus.ps1 -Rollback
#>
[CmdletBinding()]
param(
  [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bin = Join-Path $root 'bin'
$exe = Join-Path $bin 'DshWindow.exe'
$new = Join-Path $bin 'DshWindow.exe.new'
$backupDir = Join-Path $root 'state\focus-probe'
$backup = Join-Path $backupDir 'DshWindow.exe.bak'

$running = @(Get-Process DshWindow -ErrorAction SilentlyContinue)

if ($Rollback) {
  if (-not (Test-Path $backup)) { throw "Nincs mentes: $backup" }
  if ($running.Count -gt 0) {
    Write-Host "Futo ablak: pid $($running[0].Id). A visszaallitas utan uj ablakot kell nyitni." -ForegroundColor Yellow
  }
  Copy-Item $backup $exe -Force
  Write-Host "Visszaallitva: $exe" -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $new)) {
  throw "Nincs kesz uj valtozat ($new). Futtasd elobb: .\build.ps1"
}

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
if (Test-Path $exe) { Copy-Item $exe $backup -Force }
Write-Host "Mentes kesz: $backup" -ForegroundColor Green

# A futo peldany foglalja a fajlt, ezert a cseret tobbszor probaljuk: a tartalmat
# felulirni nem lehet, de a fajlnevet atnevezni igen — igy a futo ablak a
# tovabbiakban is a regi kodot futtatja, a fajl viszont az uj lesz.
$swapped = $false
for ($attempt = 1; $attempt -le 5 -and -not $swapped; $attempt++) {
  try {
    if (Test-Path $exe) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Move-Item $exe (Join-Path $bin "DshWindow.exe.old-$stamp") -Force
    }
    Move-Item $new $exe -Force
    $swapped = $true
  } catch {
    Start-Sleep -Milliseconds 700
  }
}
if (-not $swapped) { throw "A csere nem sikerult (futo peldany foglalja a fajlt). Csukd be a regi ablakot, majd futtasd ujra." }
$info = Get-Item $exe
Write-Host ("Csere kesz: {0} ({1:N0} byte, {2})" -f $info.FullName, $info.Length, $info.LastWriteTime) -ForegroundColor Green

if ($running.Count -gt 0) {
  Write-Host ''
  Write-Host "A jelenleg futo ablak (pid $($running[0].Id)) meg a REGI kodot futtatja." -ForegroundColor Yellow
  Write-Host 'Nyisd meg az uj ablakot a talcai ikon "Megnyitas" pontjaval (vagy a felosztas' -ForegroundColor Yellow
  Write-Host 'szamanak valtasaval), es abban probald ki a kurzort.' -ForegroundColor Yellow
} else {
  Write-Host 'Nem fut ablak: a kovetkezo inditas mar a javitott kodot futtatja.' -ForegroundColor Green
}
