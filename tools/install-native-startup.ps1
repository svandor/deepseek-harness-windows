<#
.SYNOPSIS
  A natív DSH-tálca (bin\DshTray.exe) bekapcsolása a bejelentkezéskori indításhoz.

.DESCRIPTION
  MIÉRT KELL EZT EGYSZER KÉZZEL FUTTATNI:
    A DSH-t futtató ágens sandboxa nem írhat a registry Run kulcsára és a
    shell:startup mappába, ezért az autostart átállítását nem tudta elvégezni.
    Ez a szkript pontosan azt teszi, amit a telepítésnek kell:

      1. bejegyzi a HKCU\...\Run kulcsra a bin\DshTray.exe-t (NEM .cmd-t, NEM
         PowerShellt: a tálca így közvetlenül, konzol nélkül indul);
      2. a régi PowerShell-alapú indítókat (shell:startup .lnk-ek) a
         state\disabled-startup mappába helyezi — nem törli, csak kikapcsolja;
      3. kikapcsolja az Ollama automatikus indítását (a helyi modell on-demand
         cél: mérés szerint 0 kérést szolgált ki, miközben 6,6 GB VRAM-ot tartott).

  A szkript idempotens: többször futtatva sem dupláz.

.EXAMPLE
  .\tools\install-native-startup.ps1
  .\tools\install-native-startup.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tray = Join-Path $root 'bin\DshTray.exe'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$disabled = Join-Path $root 'state\disabled-startup'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'DeepSeek Harness'
$legacy = @('DSH subagent proxy watchdog.lnk', 'Ollama.lnk', 'HáziRobot panel.lnk')

if (-not (Test-Path $tray)) {
  throw "Nem találom: $tray — futtasd előbb: .\build.ps1"
}

if ($Remove) {
  if (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $runName -Force
    Write-Host "Autostart kikapcsolva ($runName)." -ForegroundColor Yellow
  } else {
    Write-Host "Nem volt autostart bejegyzés." -ForegroundColor Gray
  }
  return
}

# --- 1) Run kulcs a natív tálcára -----------------------------------------
Set-ItemProperty -Path $runKey -Name $runName -Value "`"$tray`"" -Force
Write-Host "Autostart bejegyezve: $runName = $tray" -ForegroundColor Green

# --- 2) régi PowerShell-indítók kikapcsolása ------------------------------
New-Item -ItemType Directory -Force -Path $disabled | Out-Null
foreach ($name in $legacy) {
  $src = Join-Path $startup $name
  if (Test-Path $src) {
    Move-Item $src (Join-Path $disabled $name) -Force
    Write-Host "Kikapcsolva: $name" -ForegroundColor Green
  }
}

# --- 2b) a Task Managerben maradó „szellem-sorok" törlése -----------------
# A Windows a StartupApproved kulcsban megőrzi a startup-bejegyzések
# jóváhagyási állapotát akkor is, ha a .lnk már nincs a mappában. Ezért a
# Beállítások/Task Manager továbbra is kilistázza őket (pl. „Windows
# PowerShell" = a régi HáziRobot panel.lnk), pedig semmit nem indítanak.
# A bejegyzések törlése csak a listát tisztítja — futó folyamatot nem érint.
$approvedFolders = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
)
$staleNames = @('DSH subagent proxy watchdog.lnk', 'Ollama.lnk', 'HáziRobot panel.lnk')
foreach ($key in $approvedFolders) {
  if (-not (Test-Path $key)) { continue }
  foreach ($name in $staleNames) {
    if (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue) {
      try {
        Remove-ItemProperty -Path $key -Name $name -Force -ErrorAction Stop
        Write-Host "Szellem-sor törölve: $name" -ForegroundColor Green
      } catch {
        Write-Host "A szellem-sor nem törölhető (jogosultság): $name" -ForegroundColor Yellow
      }
    }
  }
}

# --- 3) a natív tálca azonnali elindítása, ha még nem fut ----------------
if (-not (Get-Process DshTray -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $tray -WorkingDirectory $root -WindowStyle Hidden
  Write-Host "A natív tálca elindult (DshTray.exe)." -ForegroundColor Green
} else {
  Write-Host "A natív tálca már fut." -ForegroundColor Gray
}

Write-Host ''
Write-Host 'Kész. A következő bejelentkezéskor már csak a DshTray.exe indul:' -ForegroundColor Cyan
Write-Host '  - nincs PowerShell, nincs .cmd, nincs konzolablak;' -ForegroundColor DarkGray
Write-Host '  - a tálca tartja életben a harness-t, a proxyt és az ablakot;' -ForegroundColor DarkGray
Write-Host '  - naponta 09:00-kor lefuttatja a retune + chain-doctor karbantartást.' -ForegroundColor DarkGray
