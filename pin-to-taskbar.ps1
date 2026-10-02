<#
.SYNOPSIS
  DeepSeek Harness bejegyzes a Start menube - innen a tálcára tűzés működik.

.DESCRIPTION
  A Windows 11 szandekosan eltavolitotta a "Kitűzés a tálcára" műveletet a
  parancsikonokról (ezert nem működik az asztali ikon tálcára húzása). A
  tamogatott út az, hogy az alkalmazás szerepel a Start menuben, ott jobb
  klikk -> Kitűzés a tálcára.

  Ez a szkript letrehozza a Start menü bejegyzést, majd megmondja a további
  két kattintast. Nem nyul a registryhez és nem indit ujra explorert.

.EXAMPLE
  .\pin-to-taskbar.ps1
  .\pin-to-taskbar.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$trayCmd = Join-Path $root 'tray\dsh-tray.cmd'
$icon = Join-Path $root 'assets\dsh.ico'
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$link = Join-Path $programs 'DeepSeek Harness.lnk'

if ($Remove) {
  if (Test-Path $link) {
    Remove-Item $link -Force
    Write-Host "Start menü bejegyzés törölve: $link"
    Write-Host "(A már kitűzött tálcaikont a tálcán jobb klikkel tudod unpin-olni.)"
  } else {
    Write-Host "Nem volt Start menü bejegyzés."
  }
  return
}

if (-not (Test-Path $trayCmd)) { throw "Nem találom az indítót: $trayCmd" }
if (-not (Test-Path $programs)) { throw "Nem találom a Start menü mappát: $programs" }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $trayCmd
$sc.WorkingDirectory = $root
if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
$sc.Description = 'DeepSeek Harness indítása (ablak + rendszertálca-ikon)'
$sc.Save()

if (-not (Test-Path $link)) {
  throw "A Start menü bejegyzés nem jött létre (jogosultság?): $link"
}

Write-Host "Start menü bejegyzés létrehozva:"
Write-Host "  $link"
Write-Host ""
Write-Host "Kitűzés a tálcára (2 kattintás):"
Write-Host "  1) Nyisd meg a Start menüt, és írd be: DeepSeek Harness"
Write-Host "  2) Jobb klikk a találatra -> Kitűzés a tálcára"
Write-Host ""
Write-Host "Utána a tálcaikon ugyanígy viselkedik: ha már fut, az ablakot nyitja meg."
