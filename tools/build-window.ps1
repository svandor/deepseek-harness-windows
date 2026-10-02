<#
.SYNOPSIS
  A DSH ablak (bin\DshWindow.exe) biztonságos újrafordítása futó ablak mellett.

.DESCRIPTION
  A futó DshWindow.exe fájlt a Windows nem engedi felülírni, de ÁTNEVEZNI igen.
  Ez a szkript ezért:

    1) átnevezi a futó exe-t  DshWindow.exe.old-<időbélyeg>  névre,
    2) lefuttatja a build.ps1-et (új bin\DshWindow.exe),
    3) siker esetén a régi példányt meghagyja (a futó ablak azt használja),
    4) hiba esetén VISSZAÁLLÍTJA az eredeti exe-t, hogy a tálca tovább működjön.

  A futó ablak a régi kódot futtatja tovább; az új exe a KÖVETKEZŐ ablaknyitáskor
  lép életbe (tálca: Megnyitás / felosztás váltása).

.EXAMPLE
  .\tools\build-window.ps1
  .\tools\build-window.ps1 -KeepOld
#>
[CmdletBinding()]
param(
  [switch]$KeepOld
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bin = Join-Path $root 'bin'
$exe = Join-Path $bin 'DshWindow.exe'

$running = @(Get-Process DshWindow -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) { Write-Host "Futó ablak: pid $($running[0].Id) — a régi példány fut tovább, az új exe a következő nyitáskor lép életbe." -ForegroundColor Yellow }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $bin "DshWindow.exe.old-$stamp"
$moved = $false

if (Test-Path $exe) {
  Move-Item $exe $backup -Force
  $moved = $true
  Write-Host "Régi exe átnevezve: $(Split-Path $backup -Leaf)"
}

$ok = $false
try {
  Push-Location $root
  try { & (Join-Path $root 'build.ps1') } finally { Pop-Location }
  $ok = Test-Path $exe
} catch {
  Write-Host "Fordítási hiba: $($_.Exception.Message)" -ForegroundColor Red
}

if (-not $ok) {
  if ($moved) {
    Move-Item $backup $exe -Force
    Write-Host 'A fordítás nem sikerült — az eredeti exe visszaállítva.' -ForegroundColor Red
  }
  exit 1
}

$info = Get-Item $exe
Write-Host ("Fordítás OK: {0} byte, {1}" -f $info.Length, $info.LastWriteTime) -ForegroundColor Green

if (-not $KeepOld -and $moved) {
  # A régi példányt csak akkor töröljük, ha nem fut belőle semmi (különben zárolt).
  if ($running.Count -eq 0) {
    Remove-Item $backup -Force -ErrorAction SilentlyContinue
    Write-Host 'A régi exe törölve.'
  } else {
    Write-Host "A régi exe meghagyva (a futó ablak használja): $(Split-Path $backup -Leaf)"
  }
}
exit 0
