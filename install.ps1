<#
.SYNOPSIS
  Asztali indító ikon létrehozása a DeepSeek Harnesshez (tálcára kitűzhető).

.DESCRIPTION
  Létrehozza a "DeepSeek Harness" ikont az asztalra. Az ikon ugyanúgy viselkedik,
  mint egy normál alkalmazás indítója:
    * ha a rendszertálcai ikon még nem fut -> elindítja, és megnyitja az ablakot,
    * ha már fut                        -> megnyitja (előtérbe hozza) az ablakot.
  A tálcára a Windows szokásos módján tűzhető ki:
  jobb klikk az ikonra -> Megjelenítés további beállítások -> Kitűzés a tálcára.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -AutoStart
  .\install.ps1 -RemoveAutoStart
#>
[CmdletBinding()]
param(
  # Asztali ikon létrehozása (alapértelmezés: igen).
  [switch]$NoShortcut,

  # Bejelentkezéskori indítás bekapcsolása (tálcaikon, ablak nélkül).
  [switch]$AutoStart,

  # Bejelentkezéskori indítás kikapcsolása.
  [switch]$RemoveAutoStart,

  # Start menü bejegyzés is készüljön (innen működik a tálcára tűzés).
  [switch]$PinToTaskbar,

  # Ne kérdezzen rá a bejelentkezéskori indításra.
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$trayCmd = Join-Path $root 'tray\dsh-tray.cmd'
$launcherExe = Join-Path $root 'bin\DshLauncher.exe'
$startupCmd = Join-Path $root 'tray\dsh-tray-startup.cmd'
$icon = Join-Path $root 'assets\dsh.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')

if (-not (Test-Path $trayCmd)) { throw "Nem találom az indítót: $trayCmd" }
# A Windows 11 csak valódi .exe célú parancsikont tűz ki a tálcára, ezért a
# látható ikonok a bin\DshLauncher.exe-re mutatnak.
$shortcutTarget = if (Test-Path $launcherExe) { $launcherExe } else { $trayCmd }

# --- asztali ikon -------------------------------------------------------------
if (-not $NoShortcut) {
  $link = Join-Path $desktop 'DeepSeek Harness.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($link)
  $sc.TargetPath = $shortcutTarget
  $sc.WorkingDirectory = $root
  if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
  $sc.Description = 'DeepSeek Harness indítása (ablak + rendszertálca-ikon)'
  $sc.Save()
  Write-Host "Asztali ikon: $link  ->  $shortcutTarget"
}

# --- Start menü bejegyzés (a tálcára tűzéshez) --------------------------------
# A Windows 11 csak valódi .exe célú parancsikont tűz ki a tálcára (a .cmd/.ps1
# célúakon nincs is "Kitűzés a tálcára" művelet), ezért a Start menü bejegyzés
# is a bin\DshLauncher.exe-re mutat.
if ($PinToTaskbar) {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $startLink = Join-Path $programs 'DeepSeek Harness.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($startLink)
  $sc.TargetPath = $shortcutTarget
  $sc.WorkingDirectory = $root
  if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
  $sc.Description = 'DeepSeek Harness indítása (ablak + rendszertálca-ikon)'
  $sc.Save()
  Write-Host "Start menü bejegyzés: $startLink"
}

# --- bejelentkezéskori indítás ------------------------------------------------
$autostartLink = Join-Path $startup 'DeepSeek Harness (tálca).lnk'

if ($RemoveAutoStart) {
  if (Test-Path $autostartLink) { Remove-Item $autostartLink -Force }
  Write-Host "Bejelentkezéskori indítás kikapcsolva."
  return
}

if ($AutoStart) {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($autostartLink)
  $sc.TargetPath = $startupCmd
  $sc.WorkingDirectory = $root
  if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
  $sc.Description = 'DeepSeek Harness rendszertálca-ikon indítása bejelentkezéskor'
  $sc.Save()
  Write-Host "Bejelentkezéskori indítás bekapcsolva: $autostartLink"
  Write-Host "(Ez a tálcaikont indítja el ablak nélkül; az ablakot az asztali ikon nyitja.)"
}
