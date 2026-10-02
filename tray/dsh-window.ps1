<#
.SYNOPSIS
  Megnyitja a DeepSeek Harness natív ablakát (a tálcaikon nélkül is működik).

.DESCRIPTION
  Ha a háttér-GUI még nem fut, a bin\DshWindow.exe maga indítja el, befogja a
  dsh által kiírt tokenes URL-t, és megnyitja a WebView2 ablakot.
#>
#requires -Version 5.1
[CmdletBinding()]
param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'bin\DshWindow.exe'
$stateDir = Join-Path $root 'state'
$configFile = Join-Path $stateDir 'tray-config.json'

if ($Port -le 0) {
  $Port = 3080
  if (Test-Path $configFile) {
    try {
      $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.port -is [int] -and $cfg.port -ge 1 -and $cfg.port -le 65535) { $Port = [int]$cfg.port }
    } catch { }
  }
}

if (-not (Test-Path $exe)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "A natív ablak programja hiányzik:`n$exe`n`nFuttasd egyszer a build.ps1-et.",
    'DeepSeek Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  exit 1
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

# A launcher maga keresi meg a dsh CLI-t is, de a tálca beállítását átadjuk,
# ha van (kézzel megadott útvonal, illetve a panelos felosztás száma).
#
# A ROBOT FELÜLETET is innen adjuk át: enélkül ez a belépési pont (a tálcaikon
# megkerülésével) elveszítené a robot panelt — pont az a hiba, amit a tálcánál
# már javítottunk. A számítás ugyanaz, mint az Open-Window-ban.
$dshBin = ''
$panes = 2
$robotPane = $false
$robotOnly = $false
$robotUrl = 'http://127.0.0.1:4180/'
if (Test-Path $configFile) {
  try {
    $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.dshBin) { $dshBin = $cfg.dshBin }
    if ($cfg.panes -is [int] -and $cfg.panes -ge 1 -and $cfg.panes -le 4) { $panes = [int]$cfg.panes }
    if ($cfg.robotPane) { $robotPane = [bool]$cfg.robotPane }
    if ($cfg.robotOnly) { $robotOnly = [bool]$cfg.robotOnly }
    if ($cfg.robotUrl) { $robotUrl = [string]$cfg.robotUrl }
  } catch { }
}

$windowPanes = $panes
if ($robotOnly) {
  $robotPane = $true
  $windowPanes = 1
} elseif ($robotPane) {
  $windowPanes = [Math]::Min(4, $panes + 1)
}

# A tálca által elmentett tokenezett URL-lel az ablak azonnal hitelesítve nyílik.
# Ha nincs ilyen (a harness máshonnan indult), az ablak 401 esetén maga indítja
# újra a szervert, és megszerzi a friss tokent.
$tokenUrl = ''
$tokenFile = Join-Path $stateDir 'harness.url'
if (Test-Path $tokenFile) {
  $raw = (Get-Content $tokenFile -Raw -Encoding ASCII -ErrorAction SilentlyContinue)
  if ($raw -and $raw.Trim() -match '^http://127\.0\.0\.1:\d+/\?token=') { $tokenUrl = $raw.Trim() }
}

$argList = @(
  '--port', "$Port",
  '--panes', "$windowPanes",
  '--log', "`"$(Join-Path $stateDir 'window.log')`"",
  '--icon', "`"$(Join-Path $root 'assets\dsh.ico')`""
)
if ($dshBin) { $argList += @('--dsh-bin', "`"$dshBin`"") }
if ($tokenUrl) { $argList += @('--url', "`"$tokenUrl`"") }
else { $argList += @('--restart-if-stale') }
if ($robotPane -and $windowPanes -ge 1) { $argList += @('--pane-url', "$windowPanes=`"$robotUrl`"") }

Start-Process -FilePath $exe -ArgumentList $argList | Out-Null
