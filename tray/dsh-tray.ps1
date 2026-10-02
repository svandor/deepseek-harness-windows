<#
.SYNOPSIS
  DeepSeek Harness tálcaikon Windows 11-hez - indítás, leállítás, natív ablak.

.DESCRIPTION
  A tálcaikon a teljes vezérlőpult:
    * automatikusan megtalálja a dsh CLI-t (dsh 0.1.5+ formátumú hitelesítési
      fájllal dolgozik: version: 1),
    * a "Megnyitás" elindítja a háttér-GUI-t (ha még nem fut), majd megnyitja
      a natív WebView2 ablakot (bin\DshWindow.exe) - nem kell terminál,
    * a háttérfolyamat az ablak bezárása után is fut, így legközelebb azonnal
      nyílik,
    * a tálca ikonja kék, ha a GUI fut, szürke, ha áll.

.NOTES
  A szkript PowerShell 5.1-en fut (ez van a gépen), a natív ablakhoz a
  bin\DshWindow.exe és mellé a WebView2 futásidejű DLL-ek kellenek
  (a build.ps1 állítja elő őket).
#>
#requires -Version 5.1
[CmdletBinding()]
param(
  # Csak a beállítások kiírása és kilépés (hibakereséshez).
  [switch]$DumpConfig,

  # Tálcáról/asztali ikonról indítva: ha már fut a tálcaikon, ne hibaüzenetet
  # adjon, hanem jelezze neki, hogy nyissa meg az ablakot.
  [switch]$OpenWindow,

  # Induláskor ne nyissa meg automatikusan az ablakot (háttérben marad).
  [switch]$NoWindow
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

# --- helyek -------------------------------------------------------------------
$script:Root      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script:TrayDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:StateDir  = Join-Path $script:Root 'state'
$script:ConfigFile = Join-Path $script:StateDir 'tray-config.json'
$script:WindowExe = Join-Path $script:Root 'bin\DshWindow.exe'
$script:IconOnFile  = Join-Path $script:Root 'assets\dsh.ico'
$script:IconOffFile = Join-Path $script:Root 'assets\dsh-off.ico'
$script:HarnessPidFile = Join-Path $script:StateDir 'harness.pid'
$script:HarnessUrlFile = Join-Path $script:StateDir 'harness.url'
$script:HarnessLog = Join-Path $script:StateDir 'harness.log'
$script:HarnessErrLog = Join-Path $script:StateDir 'harness.err.log'
$script:WindowLog  = Join-Path $script:StateDir 'window.log'
$script:TrayLog    = Join-Path $script:StateDir 'tray.log'

# A tálca életjele és a KÜLSŐ újraindítási kérés.
#
# MIÉRT: a tálca az egyetlen folyamat, amely a DSH folyamatfáján KÍVÜL fut, ezért
# egy újraindítás csak innen nem szakadhat félbe. A DSH termináljából (vagy a
# Web UI-ból) indított újraindítás megöli a saját ősét, és a DSH
# `taskkill /F /T`-je a teljes fát viszi — mért hiba (2026-10-02): a szkript a
# régi szervert leállította, újat indított, de a friss tokent már nem tudta
# kiírni, ezért a `state\harness.url` a RÉGI tokent tartotta, a tálca
# "token=False"-t látott, és önjavítással újraindította a szervert.
#
# A megoldás: minden külső kérés egy fájlba kerül, a tálca dolgozza fel.
$script:TrayHeartbeatFile  = Join-Path $script:StateDir 'tray.heartbeat'
$script:RestartRequestFile = Join-Path $script:StateDir 'restart-request'
# A tálca PID-je: a mutex önmagában nem ad folyamat-azonosítót, a
# tools\restart-tray.ps1 viszont ebből tudja, melyik folyamatot kell leállítania.
$script:TrayPidFile        = Join-Path $script:StateDir 'tray.pid'

# A Windows tálcán való csoportosításhoz és a kitűzött gyorsparancshoz.
$script:AppUserModelId = 'Wutongdaozhi.DeepSeekHarness'

New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null

# --- alapértelmezett beállítások ---------------------------------------------
$script:Defaults = [ordered]@{
  port       = 3080
  dshBin     = ''      # üres = automatikus keresés
  width      = 1280
  height     = 840
  panes      = 2       # egymás melletti panelek száma (1 = klasszikus egyablakos)
  robotPane  = $false  # a robot panel külön felületként (a panelek UTÁN)
  robotOnly  = $false  # CSAK a robot: egyetlen, teljes szélességű felület
  robotUrl   = 'http://127.0.0.1:4180/'   # a robot állapotpanelje (webhook-szerver)
  autostart  = $false  # csak tájékoztatás; a valódi állapot a Startup mappa
  logLevel   = 'info'
}

# --- win32 segédfüggvények ----------------------------------------------------
# A tálca csoportosításához és az ablak előtérbe hozásához.
$script:Win32Ready = $false
function Initialize-Win32 {
  if ($script:Win32Ready) { return }
  $sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string AppID);
'@
  Add-Type -MemberDefinition $sig -Name DshWin32 -Namespace DshTray -PassThru | Out-Null
  $script:Win32Ready = $true
}

function Set-AppUserModelId {
  Initialize-Win32
  try { [DshTray.DshWin32]::SetCurrentProcessExplicitAppUserModelID($script:AppUserModelId) | Out-Null } catch { }
}

function Set-WindowForeground {
  param([IntPtr]$Handle)
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  try {
    if ([DshTray.DshWin32]::IsIconic($Handle)) { [DshTray.DshWin32]::ShowWindow($Handle, 9) | Out-Null }  # SW_RESTORE
    [DshTray.DshWin32]::ShowWindow($Handle, 5) | Out-Null                                                  # SW_SHOW
    return [DshTray.DshWin32]::SetForegroundWindow($Handle)
  } catch {
    return $false
  }
}

# --- jelzés a futó tálcának ---------------------------------------------------
# Ha a tálcaikon már fut, a második indítás nem nyit új példányt és nem hibázik,
# hanem ezen az eseményen keresztül kéri meg a futó tálcát az ablak megnyitására.
$script:TrayMutexName  = 'DshHarnessTrayIcon'
$script:TraySignalName = 'DshHarnessShowWindow'

function Test-TrayRunning {
  try {
    $mutex = [System.Threading.Mutex]::OpenExisting($script:TrayMutexName)
    $mutex.Dispose()
    return $true
  } catch {
    return $false
  }
}

function Send-OpenWindowSignal {
  try {
    $event = [System.Threading.EventWaitHandle]::OpenExisting($script:TraySignalName)
    # Előbb töröljük az esetleges korábbi jelzést, hogy a tálca biztosan
    # egyszer dolgozza fel a mostani kérést.
    $event.Reset() | Out-Null
    $event.Set() | Out-Null
    $event.Dispose()
    return $true
  } catch {
    return $false
  }
}

function Get-OpenWindowSignal {
  try {
    $event = [System.Threading.EventWaitHandle]::OpenExisting($script:TraySignalName)
    $signalled = $event.WaitOne(0)
    if ($signalled) { $event.Reset() | Out-Null }
    $event.Dispose()
    return $signalled
  } catch {
    return $false
  }
}

# --- életjel: "fut a tálca?" --------------------------------------------------
# Minden más komponens (a Web UI restart-helperje, a tools\restart-harness.ps1,
# a deploy szkriptek) ebből tudja meg, hogy rábízhatja-e az újraindítást a
# tálcára. Az írás atomikus (tmp + Move-Item), hogy egy megszakadt írás soha ne
# hagyjon csonka életjelet — pont az a hiba, ami a tokennél már megtörtént.
function Update-TrayHeartbeat {
  try {
    $tmp = "$($script:TrayHeartbeatFile).tmp"
    Set-Content -Path $tmp -Value "$PID`t$(Get-Date -Format 'o')" -Encoding ASCII
    Move-Item -Path $tmp -Destination $script:TrayHeartbeatFile -Force
    $script:LastHeartbeatAt = Get-Date
  } catch { }
}

# A külső kérés feldolgozása. A fájl törlése maga a "átvettem" nyugta; az 5 percnél
# régebbi kérést elavultnak vesszük (a tálca órákig állhatott).
function Get-RestartRequest {
  if (-not (Test-Path $script:RestartRequestFile)) { return $false }
  $raw = $null
  try { $raw = Get-Content $script:RestartRequestFile -Raw -ErrorAction SilentlyContinue } catch { }
  Remove-Item $script:RestartRequestFile -Force -ErrorAction SilentlyContinue
  if (-not $raw) { return $true }
  try {
    $parsed = $raw.Trim() | ConvertFrom-Json
    if ($parsed -and $parsed.kereAt) {
      $when = [datetime]::Parse($parsed.kereAt)
      if (((Get-Date) - $when).TotalSeconds -gt 300) {
        Write-TrayLog "restart keres: elavult ($($parsed.kereAt)) - kihagyva"
        return $false
      }
    }
  } catch { }
  return $true
}

# A friss token URL beolvasása a naplóból (a Start-Harness és a külső kérések
# utáni ellenőrzés is ezt használja).
function Wait-HarnessTokenUrl {
  param([int]$Port, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $url = Read-HarnessTokenUrl -Port $Port -TimeoutSeconds 2
    if ($url) { return $url }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Write-TrayLog {
  param([string]$Message)
  try {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $script:TrayLog -Value $line -Encoding UTF8
    $info = Get-Item $script:TrayLog -ErrorAction SilentlyContinue
    if ($info -and $info.Length -gt 256KB) {
      Move-Item $script:TrayLog "$script:TrayLog.1" -Force
    }
  } catch { }
}

function Get-Config {
  $cfg = @{}
  foreach ($k in $script:Defaults.Keys) { $cfg[$k] = $script:Defaults[$k] }
  if (Test-Path $script:ConfigFile) {
    try {
      $saved = Get-Content $script:ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($p in $saved.PSObject.Properties) {
        if ($cfg.ContainsKey($p.Name)) { $cfg[$p.Name] = $p.Value }
      }
    } catch {
      Write-TrayLog "config olvasási hiba: $($_.Exception.Message)"
    }
  }
  return $cfg
}

function Save-Config {
  param([hashtable]$Config)
  $obj = [ordered]@{}
  foreach ($k in $script:Defaults.Keys) {
    if ($Config.ContainsKey($k)) { $obj[$k] = $Config[$k] } else { $obj[$k] = $script:Defaults[$k] }
  }
  $obj | ConvertTo-Json | Set-Content -Path $script:ConfigFile -Encoding UTF8
}

# --- dsh CLI megkeresése ------------------------------------------------------
function Test-DshCandidate {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return (Test-Path -LiteralPath $Path -PathType Leaf)
}

function Get-DshCandidates {
  param([string]$Configured)

  $list = New-Object System.Collections.Generic.List[string]
  if ($Configured) { $list.Add($Configured) }

  # 1) a workspace saját telepítése
  $list.Add((Join-Path $script:Root 'node_modules\@deepseek-ai\dsh\lib\bin.js'))

  # 2) globális npm gyökér
  try {
    $root = (& npm root -g 2>$null | Select-Object -Last 1)
    if ($root) { $list.Add((Join-Path $root.Trim() '@deepseek-ai\dsh\lib\bin.js')) }
  } catch { }

  # 3) npx cache (innen fut a felhasználó jelenlegi példánya is)
  try {
    $cache = (& npm config get cache 2>$null | Select-Object -Last 1)
    if ($cache) {
      $npx = Join-Path $cache.Trim() '_npx'
      if (Test-Path $npx) {
        Get-ChildItem $npx -Directory -ErrorAction SilentlyContinue | ForEach-Object {
          $list.Add((Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'))
        }
      }
    }
  } catch { }

  # 4) PATH-on lévő dsh
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) {
    $shim = Split-Path -Parent $cmd.Source
    $list.Add((Join-Path $shim '..\@deepseek-ai\dsh\lib\bin.js'))
    $list.Add((Join-Path $shim 'node_modules\@deepseek-ai\dsh\lib\bin.js'))
    $list.Add((Join-Path $shim '..\node_modules\@deepseek-ai\dsh\lib\bin.js'))
  }

  return $list
}

# A 0.1.5+ dsh számot vár a .credentials.yaml version mezőjében; a régebbi
# buildek (pl. a dsh-harness-control csomaghoz csomagolt 0.1.0-rc.8) viszont
# stringet. A futó verzióhoz igazítjuk, hogy a következő indítás ne hasaljon el.
function Repair-CredentialsFormat {
  param([string]$DshBin)

  $home_ = $env:DSH_HOME
  if (-not $home_) { $home_ = Join-Path $env:USERPROFILE '.dsh' }
  $cred = Join-Path $home_ '.credentials.yaml'
  if (-not (Test-Path $cred)) { return }

  try {
    $raw = Get-Content $cred -Raw -Encoding UTF8
    if ($raw -notmatch '(?m)^version:') { return }

    # Melyik formátum kell? A dsh lib melletti csomagból olvassuk ki a jelzést.
    $dshRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $DshBin))
    $credPkg = Join-Path $dshRoot 'dsh-credentials-local\lib\index.js'
    $numeric = $true
    if (Test-Path $credPkg) {
      $src = Get-Content $credPkg -Raw -Encoding UTF8
      if ($src -match 'the value for "version"[^\r\n]*must be a string') { $numeric = $false }
    }

    $fixed = $raw
    if ($numeric) {
      $fixed = [regex]::Replace($raw, '(?m)^version:\s*"(\d+)"\s*$', 'version: $1')
    } else {
      $fixed = [regex]::Replace($raw, '(?m)^version:\s*(\d+)\s*$', 'version: "$1"')
    }

    if ($fixed -ne $raw) {
      Copy-Item $cred "$cred.bak" -Force
      Set-Content -Path $cred -Value $fixed -Encoding UTF8 -NoNewline
      Write-TrayLog "credentials formátum javítva (numeric=$numeric): $cred"
    }
  } catch {
    Write-TrayLog "credentials javítás kihagyva: $($_.Exception.Message)"
  }
}

function Resolve-DshBin {
  param([hashtable]$Config)
  $candidates = Get-DshCandidates -Configured $Config['dshBin']
  foreach ($c in $candidates) {
    if (Test-DshCandidate -Path $c) {
      $full = [System.IO.Path]::GetFullPath($c)
      # A legfrissebb verziót részesítjük előnyben, ha több is van.
      return $full
    }
  }
  return $null
}

# Több jelölt esetén a legnagyobb verziószámút választjuk (0.1.5-rc.3 > 0.1.0-rc.8).
function Resolve-BestDshBin {
  param([hashtable]$Config)
  $found = @()
  foreach ($c in (Get-DshCandidates -Configured $Config['dshBin'])) {
    if (Test-DshCandidate -Path $c) {
      $full = [System.IO.Path]::GetFullPath($c)
      if ($found -notcontains $full) { $found += $full }
    }
  }
  if ($found.Count -eq 0) { return $null }

  $scored = foreach ($f in $found) {
    $version = '0.0.0'
    try {
      $pkg = Join-Path (Split-Path -Parent (Split-Path -Parent $f)) 'package.json'
      if (Test-Path $pkg) {
        $version = (Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version
      }
    } catch { }
    $numeric = ($version -replace '[^0-9.]', '').Split('.') | ForEach-Object { [int]($_ + '0' -replace '(\d+).*', '$1') }
    while ($numeric.Count -lt 3) { $numeric += 0 }
    [pscustomobject]@{
      Path    = $f
      Version = $version
      Major   = $numeric[0]
      Minor   = $numeric[1]
      Patch   = $numeric[2]
      Pre     = if ($version -match '-') { 0 } else { 1 }
    }
  }

  $best = $scored | Sort-Object Major, Minor, Patch, Pre -Descending | Select-Object -First 1
  Write-TrayLog "dsh jelöltek: $($found.Count); választva: $($best.Path) ($($best.Version))"
  return $best.Path
}

# --- állapot ------------------------------------------------------------------
function Test-PortListening {
  param([int]$Port)
  try {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach ($ep in $listeners) { if ($ep.Port -eq $Port) { return $true } }
  } catch { }
  return $false
}

function Get-HarnessPid {
  if (-not (Test-Path $script:HarnessPidFile)) { return $null }
  $raw = (Get-Content $script:HarnessPidFile -Raw -ErrorAction SilentlyContinue)
  if ($raw -and $raw.Trim() -match '^\d+$') { return [int]$raw.Trim() }
  return $null
}

# A portot foglo folyamat azonositoja, tobb uton.
#
# MIÉRT KELL A TOBB UT: a Stop-Harness eddig kizarolag a Get-NetTCPConnection-re
# epult, ami WMI-n megy. MERT HIBA (2026-09-29): ezen a gepen a hivas
# "Access denied" hibaval elhal (a DSH sandboxa es szukitett tokenek miatt), igy
# a fuggveny ures listat adott, a Stop-Harness pedig NEM TALALT MIT LEALLITANI.
# A "Háttér-GUI leállítása" es a "Kilépés" ettol hatastalanna valt.
#
# A netstat -ano nem WMI: szoveges kimenet, ezert megbizhatobb, de a sorszamot
# a vegso oszlopbol olvassuk (a helyi cim maga is tartalmazhat tizedespontot).
function Get-PortOwnerPid {
  param([int]$Port)
  $pids = @(Get-PortListenerPids -Port $Port)
  if ($pids.Count -gt 0) { return [int]$pids[0] }
  return $null
}

# A portot figyelo ÖSSZES folyamat azonositoja.
#
# MIÉRT KELL AZ ÖSSZES: a MERT HIBA (2026-10-02) az volt, hogy a tálca
# újraindító útja (`Restart-HarnessProcess`) kizárólag a `Get-NetTCPConnection`-re
# épült. Azon a gépen az a hívás "Access denied"-del elhal, ezért ÜRES listát
# adott: a régi harness a porton maradt, az új példány EADDRINUSE-szal elhalt,
# friss token nem született — a `restart-harness.ps1` pedig 150 másodpercig
# várt, majd azt írta, hogy „a tálca nem fejezte be". A netstat -ano nem WMI,
# ezért akkor is működik, amikor a CIM tiltott.
function Get-PortListenerPids {
  param([int]$Port)
  $found = @()

  # 1) CIM-en at (ha elerheto es nem tiltott) — pontos, de nem az egyetlen ut.
  try {
    $conns = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    foreach ($conn in $conns) {
      if ($conn -and $conn.OwningProcess) { $found += [int]$conn.OwningProcess }
    }
  } catch { }

  # 2) netstat -ano: LISTENING sor, a port a helyi vegpont vegen, a PID az utolso
  #    oszlopban (a helyi cim maga is tartalmazhat tizedespontot).
  try {
    $lines = & netstat.exe -ano -p TCP 2>$null
    foreach ($line in @($lines)) {
      $t = "$line".Trim()
      if ($t -notmatch 'LISTENING') { continue }
      if ($t -notmatch "[:.]$Port\s") { continue }
      $cols = $t -split '\s+'
      $last = $cols[$cols.Count - 1]
      if ($last -match '^\d+$') { $found += [int]$last }
    }
  } catch { }

  # 3) Az IPGlobalProperties csak a port allapotat adja meg, a PID-et nem —
  #    ezert itt nem probalkozunk vele.
  return @($found | Select-Object -Unique)
}

function Get-WindowProcesses {
  return @(Get-Process DshWindow -ErrorAction SilentlyContinue)
}

function Test-HarnessRunning {
  param([int]$Port)
  if (Test-PortListening -Port $Port) { return $true }
  $pid_ = Get-HarnessPid
  if ($pid_ -and (Get-Process -Id $pid_ -ErrorAction SilentlyContinue)) { return $true }
  return $false
}

# --- egeszseg-ellenorzes es ongyogyitas ---------------------------------------
# A "Reconnecting..." akkor jelentkezik, ha a felulet olyan harness-hez probal
# csatlakozni, amely mar nem valaszol (felig meghalt peldany), vagy ha tul
# surun indul ujra. Ezert: periodikusan ellenorizzuk, hogy a token-nelkuli index
# valaszol-e (401 = el), es csak akkor inditunk ujra, ha tobbszor egymas utan
# nem valaszolt - igy nem lesz ujrainditasi hullam.
$script:HealthFailures = 0
$script:LastHealAt = [datetime]::MinValue
# A Hazirobot orfolyamanak ellenorzese (lasd Invoke-RobotEnsure): a talca mar
# magatol fut, ezert nem kell kulon utemezett feladat (az regisztralas
# Windows-jogosultsag hianyaban elhal ezen a gepen).
$script:LastRobotEnsureAt = [datetime]::MinValue

function Test-HarnessHealthy {
  param([int]$Port)
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/")
    $req.Method = 'GET'
    $req.Timeout = 5000
    $req.AllowAutoRedirect = $false
    try {
      $resp = $req.GetResponse()
      $code = [int]$resp.StatusCode
      $resp.Close()
      # 401 (auth fence) es 200 egyarant azt jelentik, hogy a szerver el.
      return ($code -eq 401 -or $code -eq 200 -or $code -eq 303)
    } catch [System.Net.WebException] {
      if ($_.Exception.Response) { return $true }   # HTTP valasz erkezett: figyel
      return $false
    }
  } catch {
    return $false
  }
}

# A szerver lehet "epp valaszol", mikozben a felulet megis orokre
# "Reconnecting"-be ragad: ilyenkor a tarolt belepesi token mar nem érvényes
# (a harness azota ujraindult, vagy mas peldany adja a portot). Ezt kulon
# ellenorizzuk, mert a gyoker-végpont 401-e onmagaban ezt nem mutatja meg.
function Test-StoredTokenValid {
  param([int]$Port)
  $stored = Get-StoredTokenUrl
  if (-not $stored) { return $false }
  if ($stored -notmatch "127\.0\.0\.1:$Port/") { return $false }
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  try {
    Invoke-WebRequest $stored -UseBasicParsing -WebSession $session -TimeoutSec 8 | Out-Null
    # A token-csere 303-mal atiranyit; a vegso oldal 200.
    return $true
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      if ($code -eq 200 -or $code -eq 303) { return $true }
    }
    return $false
  }
}

function Invoke-HarnessAutoHeal {
  param([hashtable]$Config)
  $port = [int]$Config['port']
  if (-not (Test-PortListening -Port $port)) {
    $script:HealthFailures = 0
    return
  }

  # Ket fuggetlen feltetel: a szerver valaszol-e, es a felulet altal hasznalt
  # token meg ervenyes-e. Barmelyik bukik, az "Reconnecting"-hez vezet.
  $serverOk = Test-HarnessHealthy -Port $port
  $tokenOk = $true
  if ($serverOk) { $tokenOk = Test-StoredTokenValid -Port $port }

  if ($serverOk -and $tokenOk) {
    $script:HealthFailures = 0
    return
  }

  $script:HealthFailures++
  Write-TrayLog ("egeszseg-ellenorzes: szerver=$serverOk token=$tokenOk ($script:HealthFailures. egymas utani)")
  # Ket egymas utani sikeruletlen ellenorzes (kb. 40 masodperc) utan javitunk,
  # hogy a felulet "Reconnecting" allapota magatol megoldodjon.
  if ($script:HealthFailures -lt 2) { return }
  if (((Get-Date) - $script:LastHealAt).TotalSeconds -lt 45) { return }   # cooldown

  Write-TrayLog "automatikus onjavitas: ujrainditas (szerver=$serverOk token=$tokenOk)"
  $script:LastHealAt = Get-Date
  $script:HealthFailures = 0
  Restart-HarnessProcess -Config $Config
  if ($script:OpenWindowOnStart -or (Get-WindowProcesses).Count -gt 0) {
    Open-HarnessWindow
  }
}

# ── Hazirobot: az orfolyam elettartasa ────────────────────────────────────
# MIERT ITT: a robot panelje (127.0.0.1:4180) es annak orfolyama eddig csak egy
# bejelentkezeskori parancsikonra tamaszkodott. Ha az orfolyam elhalt, semmi
# nem indította ujra: a feladat-utemezobe regisztralas ezen a gepen
# Windows-jogosultsag hianyaban elhal (HRESULT 0x80070005), es a panelnek
# maganak nincs ongyogyitasa. A talca viszont MAR fut, magatol indul, es 20
# masodpercenkent ellenoriz — ezert itt a helye.
#
# MIERT AZ ORFOLYAMOT ES NEM A PANELT: az orfolyam mar maga is figyeli a panelt
# (60 s ciklus), es a fallback proxyt is jelzi. Igy a lanc:
#   talca -> orfolyam -> panel.
#
# A PID-fajl alapjan dontunk, nem a portra probalgatva: ha az orfolyam el, a
# panel lehet eppen ep (a ciklus kozott), es akkor is kell az orfolyam.
function Get-RobotWatchdogPid {
  $pidFile = Join-Path $script:Root 'bot\state\robot-watchdog.pid'
  if (-not (Test-Path $pidFile)) { return $null }
  $value = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
  if ($null -eq $value) { return $null }
  $value = $value.Trim()
  if ($value -notmatch '^\d+$') { return $null }
  $proc = Get-Process -Id ([int]$value) -ErrorAction SilentlyContinue
  # Csak akkor fogadjuk el elonek, ha tenylegesen a mi ciklusunk (powershell).
  # Egy ujrahasznositott PID mas folyamatra mutatna.
  if ($proc -and $proc.ProcessName -match 'powershell|pwsh') { return [int]$value }
  return $null
}

function Start-RobotWatchdog {
  $starter = Join-Path $script:Root 'bot\start-robot-watchdog.ps1'
  if (-not (Test-Path $starter)) { return $false }
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', "`"$starter`"", '-Port', '4180', '-Force'
    ) -WorkingDirectory (Join-Path $script:Root 'bot') -WindowStyle Hidden | Out-Null
    return $true
  } catch {
    Write-TrayLog "hazirobot: az orfolyam inditasa elhalt: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-RobotEnsure {
  # Cooldown: a tick 1,5 masodpercenkent fut, egy sikertelen inditas ne porogjön.
  if (((Get-Date) - $script:LastRobotEnsureAt).TotalSeconds -lt 60) { return }
  $script:LastRobotEnsureAt = Get-Date
  if (Get-RobotWatchdogPid) { return }

  Write-TrayLog 'hazirobot: nincs orfolyam — inditas'
  [void](Start-RobotWatchdog)
}

# ── A robot panel újraindítása (panel + őrfolyam) ──────────────────────────
#
# MIÉRT KELL: a tálca "Újraindítás" menüje eddig CSAK a harness-t indította újra.
# A robot panel (4180) külön folyamat az őrfolyamával, ezért a régit futtatta
# tovább — így egy javított `webhook-server.mjs` nem lépett életbe (mért hiba:
# „a tálcán az újraindítás nem indítja újra a robotot").
#
# MIÉRT AZ ŐRFOLYAMOT IS: az őrfolyam 60 másodpercenként figyel, ezért a panel
# puszta kilövése akár egy percig is állva hagyná a felületet. Az őrfolyamot is
# lecseréljük: az új ciklus ELSŐ köre azonnal elindítja a friss panelt.
#
# A hívó nem vár örökké: ha a panel nem válaszol a megadott időn belül, a
# függvény $false-t ad, és a hívó ezt kiírja (nem hazudunk sikert).
function Restart-RobotPanel {
  param([int]$PanelPort = 4180, [int]$TimeoutSeconds = 30)

  # A port a beállított robot URL-ből (ha van), különben a 4180.
  try {
    $robotUrl = [string]$script:Config['robotUrl']
    if ($robotUrl -match ':(\d{2,5})') { $PanelPort = [int]$Matches[1] }
  } catch { }

  $panelPids = @(Get-PortListenerPids -Port $PanelPort)
  foreach ($panelPid in $panelPids) {
    Write-TrayLog "robot panel leallitasa (pid $panelPid, port $PanelPort)"
    Stop-Process -Id $panelPid -Force -ErrorAction SilentlyContinue
  }

  $watchdogPid = Get-RobotWatchdogPid
  if ($watchdogPid) {
    Write-TrayLog "robot orfolyam leallitasa (pid $watchdogPid)"
    Stop-Process -Id $watchdogPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item (Join-Path $script:Root 'bot\state\robot-watchdog.pid') -Force -ErrorAction SilentlyContinue

  # Megvarjuk, hogy a port tenyleg felszabaduljon, mert a friss panel
  # EADDRINUSE-szal halna el, ha a regi meg a porton maradt.
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-PortListenerPids -Port $PanelPort).Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }

  if (-not (Start-RobotWatchdog)) {
    Write-TrayLog 'robot panel: az orfolyamot nem sikerult elinditani'
    return $false
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    try {
      Invoke-RestMethod "http://127.0.0.1:$PanelPort/status.json" -TimeoutSec 3 | Out-Null
      Write-TrayLog "robot panel ujraindult (port $PanelPort)"
      return $true
    } catch { }
  }
  Write-TrayLog "robot panel: nem valaszolt ${TimeoutSeconds} masodpercen belul"
  return $false
}

# A dsh minden induláskor új tokent ad, és a böngészőt csak a tokenezett URL-lel
# szolgálja ki. A tokent a naplóból olvassuk ki, eltároljuk, és átadjuk az
# ablaknak - így az ablak mindig hitelesítve nyílik.
function Read-HarnessTokenUrl {
  param([int]$Port, [int]$TimeoutSeconds = 20)

  if (-not (Test-Path $script:HarnessLog)) { return $null }
  # A sor a LAN-URL-t is tartalmazhatja "(LAN: ...)" formában, ezért a minta
  # a whitespace-nél és a zárójelnél megáll.
  $pattern = "http://127\.0\.0\.1:$Port/\?token=[A-Za-z0-9_\-]+"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $content = Get-Content $script:HarnessLog -Raw -ErrorAction SilentlyContinue
      if ($content -match $pattern) {
        return $Matches[0]
      }
    } catch { }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Save-HarnessTokenUrl {
  param([string]$Url)
  if (-not $Url) { return }
  # Atomikus írás: előbb egy temp fájlba, majd csere. Enélkül egy megszakadt
  # írás csonka `harness.url`-t hagy (mért hiba: 74 byte helyett 3 byte lett,
  # ami után minden olvasó a régi tokent látta, és a felület "Reconnecting"-be
  # ragadt).
  try {
    $tmp = "$($script:HarnessUrlFile).tmp"
    Set-Content -Path $tmp -Value $Url -Encoding ASCII
    Move-Item -Path $tmp -Destination $script:HarnessUrlFile -Force
  } catch {
    Write-TrayLog "a token URL mentese nem sikerult: $($_.Exception.Message)"
  }
}

function Get-StoredTokenUrl {
  if (-not (Test-Path $script:HarnessUrlFile)) { return $null }
  $raw = (Get-Content $script:HarnessUrlFile -Raw -ErrorAction SilentlyContinue)
  if ($raw -and $raw.Trim() -match '^http://127\.0\.0\.1:\d+/\?token=') { return $raw.Trim() }
  return $null
}

# --- indítás / leállítás ------------------------------------------------------
function Start-Harness {
  param([hashtable]$Config, [switch]$ThenOpenWindow, [switch]$Quiet, [switch]$EnsureToken)

  $port = [int]$Config['port']
  if (Test-PortListening -Port $port) {
    # Idempotencia: ha a futó példány egészséges, nem indítjuk újra. Az
    # újraindítás (ami a felület "Reconnecting..." állapotát okozza) csak
    # akkor történik, ha a szerver tényleg nem válaszol, vagy ha a token
    # hiányzik és a hívó kérte a beszerzését.
    $healthy = Test-HarnessHealthy -Port $port
    if (-not $Quiet) {
      Write-TrayLog "harness már fut a $port porton (egészséges: $healthy)"
    }

    if (-not (Get-StoredTokenUrl)) {
      $url = Read-HarnessTokenUrl -Port $port -TimeoutSeconds 2
      if ($url) { Save-HarnessTokenUrl -Url $url; Write-TrayLog "token URL betöltve a naplóból" }
    }

    if ($EnsureToken -and -not (Get-StoredTokenUrl)) {
      # A futó szerver tokene ismeretlen, és enélkül az ablak nem tud
      # bejelentkezni: újraindítjuk, hogy friss tokent kapjunk.
      Write-TrayLog "nincs token a futó harness-hez; újraindítás a tokenért"
      Stop-Harness -Config $Config -Quiet
      Start-Sleep -Milliseconds 800
      return (Start-Harness -Config $Config -ThenOpenWindow:$ThenOpenWindow -Quiet:$Quiet)
    }

    if (-not $healthy) {
      Write-TrayLog "a futó harness nem valaszol; ujrainditas"
      Stop-Harness -Config $Config -Quiet
      Start-Sleep -Milliseconds 800
      return (Start-Harness -Config $Config -ThenOpenWindow:$ThenOpenWindow -Quiet:$Quiet)
    }

    if ($ThenOpenWindow) { Open-Window -Config $Config }
    return $true
  }

  $dshBin = Resolve-BestDshBin -Config $Config
  if (-not $dshBin) {
    [System.Windows.Forms.MessageBox]::Show(
      "Nem találom a dsh CLI-t.`n`nMegoldás: futtasd a workspace-ben:`n  npm install @deepseek-ai/dsh`nvagy add meg a helyét a tálca menüjében (dsh elérési út).",
      'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    return $false
  }
  Repair-CredentialsFormat -DshBin $dshBin

  $env:DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $args = @($dshBin, 'web', '--host', '127.0.0.1', '--port', "$port", '--no-open')

  Write-TrayLog "indítás: node $($args -join ' ')"
  try {
    $proc = Start-Process -FilePath 'node' -ArgumentList $args -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $script:HarnessLog -RedirectStandardError $script:HarnessErrLog
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "A háttér-GUI indítása nem sikerült:`n$($_.Exception.Message)",
      'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    return $false
  }

  Set-Content -Path $script:HarnessPidFile -Value $proc.Id -Encoding ASCII

  # Várunk, amíg hallgat, és közben a tokenes URL-t is kiolvassuk a naplóból.
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-PortListening -Port $port) { break }
    if ($proc.HasExited) {
      Write-TrayLog "a harness kilépett (code $($proc.ExitCode)); lásd $script:HarnessErrLog"
      [System.Windows.Forms.MessageBox]::Show(
        "A DeepSeek Harness elindult, de azonnal kilépett.`n`nRészletek:`n$script:HarnessErrLog",
        'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
      return $false
    }
  }

  if (-not (Test-PortListening -Port $port)) {
    Write-TrayLog "nem hallgat a $port porton 120s után"
    return $false
  }

  # A dsh a bind után írja ki a tokenezett URL-t; ezt átadjuk az ablaknak.
  $tokenUrl = Read-HarnessTokenUrl -Port $port
  if ($tokenUrl) {
    Save-HarnessTokenUrl -Url $tokenUrl
    Write-TrayLog "token URL elmentve"
  } else {
    Write-TrayLog "FIGYELEM: nem találtam token URL-t a naplóban"
  }

  Write-TrayLog "harness fut a $port porton (pid $($proc.Id))"
  if ($ThenOpenWindow) { Open-Window -Config $Config }
  return $true
}

function Stop-Harness {
  param([hashtable]$Config, [switch]$Quiet, [switch]$KeepStateFiles)

  $port = [int]$Config['port']
  $candidates = @()

  $pid_ = Get-HarnessPid
  if ($pid_) { $candidates += [int]$pid_ }

  $owner = Get-PortOwnerPid -Port $port
  if ($owner) { $candidates += [int]$owner }

  # Biztonsag: csak node folyamatot allitunk le. Ha a pid-fajl elavult es a
  # sorszam idokozben egy idegen folyamathoz kerult, ez a szuro fogja meg.
  $targets = @()
  foreach ($t in ($candidates | Select-Object -Unique)) {
    $proc = Get-Process -Id $t -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.ProcessName -notlike 'node*') {
      Write-TrayLog "leállítás kihagyva: pid $t ($($proc.ProcessName)) nem node folyamat"
      continue
    }
    $targets += $t
  }

  foreach ($t in $targets) {
    Write-TrayLog "leállítás: pid $t"
    Stop-Process -Id $t -Force -ErrorAction SilentlyContinue
  }
  if ($targets.Count -eq 0) {
    Write-TrayLog "leállítás: nem találtam futó harness folyamatot (port $port)"
  }

  if (-not $KeepStateFiles) {
    Remove-Item $script:HarnessPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $script:HarnessUrlFile -Force -ErrorAction SilentlyContinue
  }

  # Megvarjuk, hogy a port tenyleg felszabaduljon (max ~3 s). A hivo ezutan
  # biztonsagosan indithat ujra, nem kap EADDRINUSE-t a meg marado peldanytol.
  $deadline = (Get-Date).AddSeconds(3)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortListening -Port $port)) { break }
    Start-Sleep -Milliseconds 200
  }

  if (-not $Quiet) { Write-TrayLog "leállítva (port $port)" }
  return $targets
}

# --- teljes ujrainditas (az onjavito ut és a "Újraindítás" menü használja) -----
# A Stop-Harness csak egy figyelot allit le; itt MINDEN portot foglio folyamatot
# leallitunk, megvarjuk a port felszabadulasat, majd friss harness-t inditunk.
# Ez garantalja az uj, ervenyes tokent (a regi naplobol olvasott token nem
# megoldas, ha a regi peldany mar nem el).
function Restart-HarnessProcess {
  param([hashtable]$Config)

  $port = [int]$Config['port']
  for ($i = 0; $i -lt 6; $i++) {
    # Nem csak a CIM-en at (lasd Get-PortListenerPids): ha az tiltott, akkor is
    # meg kell talalni a regi figyelot, kulonben az uj peldany EADDRINUSE-t kap.
    $owners = @(Get-PortListenerPids -Port $port)
    if ($owners.Count -eq 0) { break }
    foreach ($owner in $owners) {
      Write-TrayLog "ujrainditas: figyelo leallitasa (pid $owner)"
      Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
  }
  $still = @(Get-PortListenerPids -Port $port)
  if ($still.Count -gt 0) {
    # Nem hazudunk sikert: ha a porton meg mindig figyelo van, az uj peldany
    # EADDRINUSE-szal elhalna, es a hivo hiaba varna friss tokent.
    Write-TrayLog "ujrainditas: HIBA - a $port portot nem sikerult felszabaditani (pid: $($still -join ', '))"
    return $false
  }
  Remove-Item $script:HarnessPidFile, $script:HarnessUrlFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  $started = Start-Harness -Config $Config -Quiet

  # A robot panel KÜLÖN folyamat az őrfolyamával: a harness újraindítása nem
  # érinti. Ezért itt indítjuk újra, hogy egy javított panel-kód is életbe
  # lépjen — enélkül a felhasználó joggal látta úgy, hogy „az újraindítás nem
  # indítja újra a robotot".
  [void](Restart-RobotPanel)

  return $started
}

# --- natív ablak --------------------------------------------------------------
function Open-Window {
  param([hashtable]$Config, [switch]$Force)

  $existing = Get-WindowProcesses
  if ($existing.Count -gt 0) {
    # Egy ablak elég; a meglévőt hozzuk előtérbe.
    $first = $existing | Select-Object -First 1
    try {
      $sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
      $type = Add-Type -MemberDefinition $sig -Name Win32Focus -Namespace DshTray -PassThru
      $type::SetForegroundWindow($first.MainWindowHandle) | Out-Null
      Write-TrayLog "ablak már fut (pid $($first.Id)), előtérbe hozva"
    } catch { }
    return
  }

  if (-not (Test-Path $script:WindowExe)) {
    [System.Windows.Forms.MessageBox]::Show(
      "A natív ablak programja hiányzik:`n$script:WindowExe`n`nFuttasd egyszer a build.ps1-et a workspace-ben.",
      'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    return
  }

  $dshBin = Resolve-BestDshBin -Config $Config
  $port = [int]$Config['port']

  # Panelos ablak: a DshWindow.exe a megadott számú, egymás melletti panelt
  # nyitja, mindegyik saját WebView2 profillal (pane-1, pane-2, ...). Mivel a
  # profil ÁLLANDÓ, minden panel megjegyzi a saját munkaterületét és sessionjét.
  # Ezért itt nem adunk ablaknyitásonként friss generációs mappát; ha egy korábbi
  # ablak kilövése miatt a profil zárolva maradt, az ablak maga tér át egy
  # időbélyeges testvérmappára.
  $panes = [int]$Config['panes']
  if ($panes -lt 1 -or $panes -gt 4) { $panes = 1 }

  # A robot KÜLÖN felület: a munkaterület-panelek UTÁN nyílik, ezért eggyel több
  # ablak-panel kell. A felső korlát 4 (DshWindow MaxPanes), ezért ha a
  # felhasználó 4 munkaterületet kért, a robot az utolsó panelt foglalja el.
  $robotPane = [bool]$Config['robotPane']
  $robotOnly = [bool]$Config['robotOnly']
  $robotUrl = [string]$Config['robotUrl']
  if ([string]::IsNullOrWhiteSpace($robotUrl)) { $robotUrl = [string]$script:Defaults['robotUrl'] }
  $windowPanes = $panes
  if ($robotOnly) {
    # „Csak robot" mód: egyetlen felület, teljes szélességben a robot.
    $robotPane = $true
    $windowPanes = 1
  } elseif ($robotPane) {
    $windowPanes = [Math]::Min(4, $panes + 1)
  }

  $argList = @(
    '--port', "$port",
    '--panes', "$windowPanes",
    '--no-boot',
    '--width', "$([int]$Config['width'])",
    '--height', "$([int]$Config['height'])",
    '--log', "`"$script:WindowLog`"",
    '--icon', "`"$script:IconOnFile`""
  )
  # A DSH_HOME-t csak akkor adjuk át, ha tényleg be van állítva; különben a
  # launcher a saját alapértelmezését használja (~\.dsh).
  if ($env:DSH_HOME) { $argList += @('--dsh-home', "`"$env:DSH_HOME`"") }
  if ($dshBin) { $argList += @('--dsh-bin', "`"$dshBin`"") }

  # A tokenezett URL-lel nyílik azonnal hitelesítve. A --restart-if-stale
  # mindig ott van: ha a tárolt token elavult (a harness azóta újraindult, vagy
  # egy másik példány adja a portot), az ablak 401 esetén maga indítja újra a
  # szervert, befogja a friss tokent, és elmenti a state\harness.url fájlba.
  $tokenUrl = Get-StoredTokenUrl
  if ($tokenUrl) {
    $argList += @('--url', "`"$tokenUrl`"")
  } else {
    Remove-Item $script:HarnessUrlFile -Force -ErrorAction SilentlyContinue
  }
  $argList += @('--restart-if-stale')

  # A robot felület URL-felülbírálata: ez a panel nem a harness klienst tölti,
  # hanem a robot saját állapotpaneljét (webhook-szerver, alapból a 4180-as port).
  if ($robotPane -and $windowPanes -ge 1) {
    $argList += @('--pane-url', "$windowPanes=`"$robotUrl`"")
    Write-TrayLog "robot felulet: a $windowPanes. panel tolti be ($robotUrl)$(if ($robotOnly) { ' [CSAK ROBOT MOD]' })"
  }

  Write-TrayLog "ablak indítás: $script:WindowExe $($argList -join ' ')"
  Start-Process -FilePath $script:WindowExe -ArgumentList $argList | Out-Null
  return
}

# --- ablak felosztása (több panel, több munkaterület) -------------------------
# A beállítás a következő ablaknyitásra érvényes. Ha épp nyitva van ablak, a
# felhasználó dönt: újraindítjuk-e most. A panelek saját WebView2 profillal
# futnak, ezért az újraindítás nem veszíti el a bennük kiválasztott
# munkaterületet/sessiont.
function Set-WindowPanes {
  param([hashtable]$Config, [int]$Panes)

  if ($Panes -lt 1 -or $Panes -gt 4) { return }

  $Config['panes'] = $Panes
  Save-Config -Config $Config
  foreach ($key in @($script:PaneMenuItems.Keys)) {
    try { $script:PaneMenuItems[$key].Checked = ([int]$key -eq $Panes) } catch { }
  }
  Write-TrayLog "ablak felosztasa: $Panes panel"

  if ((Get-WindowProcesses).Count -eq 0) { return }

  $answer = [System.Windows.Forms.MessageBox]::Show(
    "A felosztás a következő ablaknyitáskor lép életbe.`n`nÚjraindítsam most az ablakot $Panes panellel?`n(A panelek megjegyzik a saját munkaterületüket.)",
    'DSH Harness - ablak felosztása',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  Close-HarnessWindow
  Start-Sleep -Milliseconds 900
  Open-HarnessWindow
}

# „Csak robot" mód: az ablak egyetlen felülettel nyílik (teljes szélességben a
# robot-konzol). Bekapcsolva a munkaterület-paneleket is kikapcsolja, hogy ne
# legyen félreértés; kikapcsolva visszaáll a robot a munkaterületek mellé.
function Set-RobotOnly {
  param([hashtable]$Config, [bool]$Enabled)

  $Config['robotOnly'] = $Enabled
  if ($Enabled) { $Config['robotPane'] = $true }
  Save-Config -Config $Config

  try { if ($script:RobotOnlyMenuItem) { $script:RobotOnlyMenuItem.Checked = $Enabled } } catch { }
  try { if ($script:RobotMenuItem) { $script:RobotMenuItem.Checked = [bool]$Config['robotPane'] } } catch { }

  if ($Enabled) { Write-TrayLog 'csak robot mod: BE (1 felulet)' } else { Write-TrayLog 'csak robot mod: KI' }

  if ((Get-WindowProcesses).Count -eq 0) { return }

  $what = if ($Enabled) { 'az ablak egyetlen felülettel nyíljon meg (csak a robot-konzol)' }
          else { "az ablak $([int]$Config['panes'] + 1) felülettel nyíljon meg (munkaterületek + robot)" }
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "A beállítás a következő ablaknyitáskor lép életbe.`n`nÚjraindítsam most, hogy $what?",
    'DSH Harness - csak robot mód',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  Close-HarnessWindow
  Start-Sleep -Milliseconds 900
  Open-HarnessWindow
}
# munkaterület-panelek száma legfeljebb 3 lehet (3 munkaterület + robot = 4).
function Set-RobotPane {
  param([hashtable]$Config, [bool]$Enabled)

  $Config['robotPane'] = $Enabled
  if ($Enabled -and [int]$Config['panes'] -gt 3) { $Config['panes'] = 3 }
  Save-Config -Config $Config

  try { if ($script:RobotMenuItem) { $script:RobotMenuItem.Checked = $Enabled } } catch { }
  foreach ($key in @($script:PaneMenuItems.Keys)) {
    try { $script:PaneMenuItems[$key].Checked = ([int]$key -eq [int]$Config['panes']) } catch { }
  }

  if ($Enabled) {
    Write-TrayLog "robot felulet: BE (a $([int]$Config['panes'] + 1). panelen)"
  } else {
    Write-TrayLog 'robot felulet: KI'
  }

  if ((Get-WindowProcesses).Count -eq 0) { return }

  $allapot = if ($Enabled) { 'BE' } else { 'KI' }
  $what = if ($Enabled) {
    "az ablak $([int]$Config['panes'] + 1) felülettel nyíljon meg (az utolsó a robot panel: $robotUrl)"
  } else {
    "a robot felület kikerüljön az ablakból (az ablak $([int]$Config['panes']) panellel nyílik)"
  }
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "Robot felület: $allapot.`n`nA beállítás a következő ablaknyitáskor lép életbe.`n`nÚjraindítsam most, hogy $what?`n`n(A robot panel szervere és őrfolyama ettől függetlenül fut — azt a tálca tartja életben. Visszakapcsolás: Ablak felosztása → 4. felület: robot panel.)",
    'DSH Harness — robot felület',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  Close-HarnessWindow
  Start-Sleep -Milliseconds 900
  Open-HarnessWindow
}

# Az ablak bezárása a tálcáról; a háttér-GUI futva marad. Előbb szabályosan
# kérjük a bezárást, hogy a panel-arányok és az ablakgeometria mentődjenek.
function Close-HarnessWindow {
  foreach ($window in (Get-WindowProcesses)) {
    try { $window.CloseMainWindow() | Out-Null } catch { }
  }

  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    if ((Get-WindowProcesses).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }

  Write-TrayLog "az ablak nem zarodott be szabalyosan, kenyszeru leallitas"
  foreach ($window in (Get-WindowProcesses)) {
    try { Stop-Process -Id $window.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

# --- port beállítás -----------------------------------------------------------
function Set-Port {
  param([hashtable]$Config)

  $answer = [Microsoft.VisualBasic.Interaction]::InputBox(
    "Melyik porton figyeljen a háttér-GUI? (1-65535)", 'DSH Harness - port', "$($Config['port'])")
  if ([string]::IsNullOrWhiteSpace($answer)) { return }

  $num = 0
  if (-not [int]::TryParse($answer.Trim(), [ref]$num) -or $num -lt 1 -or $num -gt 65535) {
    [System.Windows.Forms.MessageBox]::Show("Érvénytelen port: $answer", 'DSH Harness',
      [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    return
  }

  $wasRunning = Test-HarnessRunning -Port ([int]$Config['port'])
  $Config['port'] = $num
  Save-Config -Config $Config

  if ($wasRunning) {
    $restart = [System.Windows.Forms.MessageBox]::Show(
      "A port mostantól $num.`nÚjraindítsam a futó GUI-t, hogy érvénybe lépjen?",
      'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($restart -eq [System.Windows.Forms.DialogResult]::Yes) {
      Stop-Harness -Config $Config -Quiet
      Start-Harness -Config $Config | Out-Null
    }
  } else {
    [System.Windows.Forms.MessageBox]::Show("A port mostantól $num.", 'DSH Harness',
      [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
  }
}

# --- dsh elérési út beállítása ------------------------------------------------
function Set-DshBin {
  param([hashtable]$Config)

  $found = Resolve-BestDshBin -Config $Config
  $current = if ($found) { $found } else { '' }
  $answer = [Microsoft.VisualBasic.Interaction]::InputBox(
    "A dsh CLI (lib\bin.js) útvonala.`nÜresen hagyva automatikus keresés.", 'DSH Harness - dsh útvonal', $current)
  if ($null -eq $answer) { return }

  $answer = $answer.Trim()
  if ($answer -ne '' -and -not (Test-Path -LiteralPath $answer)) {
    [System.Windows.Forms.MessageBox]::Show("Ez a fájl nem létezik:`n$answer", 'DSH Harness',
      [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    return
  }

  $Config['dshBin'] = $answer
  Save-Config -Config $Config
  $Config['resolvedDsh'] = if ($answer) { $answer } else { Resolve-BestDshBin -Config $Config }
}

# --- naplók -------------------------------------------------------------------
function Open-Logs {
  if (Test-Path $script:HarnessLog) { Start-Process notepad.exe $script:HarnessLog }
  elseif (Test-Path $script:HarnessErrLog) { Start-Process notepad.exe $script:HarnessErrLog }
  elseif (Test-Path $script:WindowLog) { Start-Process notepad.exe $script:WindowLog }
  else {
    [System.Windows.Forms.MessageBox]::Show('Még nincs napló - előbb indítsd el a GUI-t.',
      'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
  }
}

function Test-RobotPanelAlive {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url.TrimEnd('/') + '/status.json')
    $req.Method = 'GET'
    $req.Timeout = 3000
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return ($code -eq 200)
  } catch {
    return $false
  }
}

# A tálca saját újraindítása (frissítés után). A WMI-vel indított késleltető
# túléli a saját kilépésünket, és a mutex felszabadulása után elindítja az új
# példányt. Az ablak és a háttér-GUI közben futva marad.
function Restart-TraySelf {
  $launcher = Join-Path $script:Root 'bin\DshLauncher.exe'
  $trayScript = Join-Path $script:TrayDir 'dsh-tray.ps1'
  $starter = if (Test-Path $launcher) {
    "Start-Process -FilePath '$launcher' -ArgumentList '--tray-only'"
  } else {
    "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','$trayScript','-NoWindow') -WindowStyle Hidden"
  }
  $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"Start-Sleep -Seconds 3; $starter`""
  try {
    ([wmiclass]'Win32_Process').Create($cmd) | Out-Null
    Write-TrayLog 'a talca ujrainditasa: az uj peldany 3 masodperc mulva indul (az ablak es a hatter-GUI futva marad)'
  } catch {
    Write-TrayLog "a talca ujrainditasa nem sikerult: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show(
      "A tálca újraindítása nem sikerült:`n$($_.Exception.Message)`n`nIndítsd újra kézzel az asztali ikonról.",
      'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    return
  }
  [System.Windows.Forms.Application]::Exit()
}

function Show-Status {
  param([hashtable]$Config)

  $port = [int]$Config['port']
  $state = if (Test-HarnessRunning -Port $port) { 'FUT' } else { 'áll' }
  $windows = Get-WindowProcesses
  $dshBin = Resolve-BestDshBin -Config $Config
  $robotUrl = [string]$Config['robotUrl']
  if ([string]::IsNullOrWhiteSpace($robotUrl)) { $robotUrl = [string]$script:Defaults['robotUrl'] }
  $robotAlive = Test-RobotPanelAlive -Url $robotUrl
  $watchdogPid = Get-RobotWatchdogPid
  $tokenUrl = Get-StoredTokenUrl
  if ($tokenUrl -and $tokenUrl.Length -gt 46) { $tokenUrl = $tokenUrl.Substring(0, 46) + '…' }
  $lines = @(
    "Állapot        : $state (port $port)",
    "Ablak          : $(if ($windows.Count -gt 0) { "nyitva (pid $($windows[0].Id))" } else { 'zárva' })",
    "Felosztás      : $([int]$Config['panes']) panel",
    "Robot felület  : $(if ([bool]$Config['robotOnly']) { "CSAK ROBOT mód (1 felület: $robotUrl)" } elseif ([bool]$Config['robotPane']) { "be (a $([int]$Config['panes'] + 1). panelen: $robotUrl)" } else { 'ki (Ablak felosztása → 4. felület: robot panel)' })",
    "Robot panel    : $(if ($robotAlive) { 'ÉL' } else { 'nem válaszol' })  $robotUrl",
    "Robot őrfolyam : $(if ($watchdogPid) { "fut (pid $watchdogPid)" } else { 'nem fut — a tálca automatikusan elindítja' })",
    "Háttérfolyamat : $(if ($state -eq 'FUT') { "http://127.0.0.1:$port" } else { '-' })",
    "Belépési token : $(if ($tokenUrl) { $tokenUrl } else { 'nincs mentett token' })",
    "dsh CLI        : $(if ($dshBin) { $dshBin } else { 'nem található' })",
    "DSH_HOME       : $env:DSH_HOME",
    "Állapotkönyvtár: $script:StateDir"
  )
  [System.Windows.Forms.MessageBox]::Show(($lines -join "`r`n"), 'DSH Harness állapot',
    [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}

# --- hordozható indítás (asztali ikon / tálcára kitűzés) ----------------------
# Ez a belépési pont viselkedik úgy, mint egy normál alkalmazás ikonja:
#   * ha a tálcaikon már fut  -> az ablakot nyitja meg (előtérbe hozza),
#   * ha még nem fut         -> elindítja a tálcát, ami megnyitja az ablakot.
# Hibaüzenet csak akkor van, ha az ablakprogram hiányzik.
function Invoke-Launch {
  param([switch]$ShowWindow = $true, [switch]$Quiet)

  Initialize-Win32
  Set-AppUserModelId

  if (Test-TrayRunning) {
    $existingWindow = Get-WindowProcesses | Select-Object -First 1
    if ($existingWindow) {
      Write-TrayLog "indítás: a tálca fut, az ablak már nyitva - előtérbe hozva"
      Set-WindowForeground -Handle $existingWindow.MainWindowHandle | Out-Null
      return $true
    }

    Write-TrayLog "indítás: a tálca fut, ablak megnyitása jelzéssel"
    if (Send-OpenWindowSignal) {
      # Megvárjuk, amíg a tálca megnyitja az ablakot: a tálca időzítője
      # dolgozza fel a jelzést, ezért rövid várakozás kell.
      $deadline = (Get-Date).AddSeconds(15)
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $window = Get-WindowProcesses | Select-Object -First 1
        if ($window -and $window.MainWindowHandle -ne 0) {
          Initialize-Win32
          Set-WindowForeground -Handle $window.MainWindowHandle | Out-Null
          return $true
        }
      }
      Write-TrayLog "FIGYELEM: a tálca nem nyitotta meg az ablakot 15s alatt"
    } else {
      Write-TrayLog "FIGYELEM: a futó tálcának nem sikerült jelezni"
    }
    return $false
  }

  # Nincs futó tálca: elindítjuk úgy, hogy rögtön megnyissa az ablakot.
  Write-TrayLog "indítás: nincs futó tálca, új példány indul (ablak nyitásával)"
  $script:OpenWindowOnStart = [bool]$ShowWindow
  Show-Tray
  return $true
}

# --- asztali gyorsparancs -----------------------------------------------------
function New-Shortcut {
  param([switch]$Quiet)

  $desktop = [Environment]::GetFolderPath('Desktop')
  $link = Join-Path $desktop 'DeepSeek Harness.lnk'
  try {
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = Join-Path $script:TrayDir 'dsh-tray.cmd'
    $sc.WorkingDirectory = $script:Root
    $sc.IconLocation = "$script:IconOnFile,0"
    $sc.Description = 'DeepSeek Harness indítása (ablak + rendszertálca-ikon)'
    $sc.Save()

    if (-not $Quiet) {
      [System.Windows.Forms.MessageBox]::Show(
        "Asztali ikon létrehozva:`n$link`n`nA tálcára így tudod kitűzni:`n" +
        "jobb klikk az ikonra > Megjelenítés további beállítások > Kitűzés a tálcára.",
        'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    }
    Write-TrayLog "asztali ikon létrehozva: $link"
    return $true
  } catch {
    if (-not $Quiet) {
      [System.Windows.Forms.MessageBox]::Show("Az asztali ikon létrehozása nem sikerült:`n$($_.Exception.Message)",
        'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
    return $false
  }
}

# --- tálca --------------------------------------------------------------------
function Show-Tray {
  Set-AppUserModelId

  # Egyetlen példány. Ha már fut, nem hibaüzenetet adunk, hanem megnyitjuk az
  # ablakot (ezt az "Indítás" belépési pont kezeli, ide már nem jutunk el).
  $mutex = New-Object System.Threading.Mutex($false, $script:TrayMutexName)
  if (-not $mutex.WaitOne(0)) {
    Write-TrayLog "a tálca már fut - ablak megnyitása jelzéssel"
    Send-OpenWindowSignal | Out-Null
    return
  }

  # Ezen az eseményen kéri a második indítás az ablak megnyitását.
  $script:windowSignal = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::ManualReset, $script:TraySignalName)

  # A PID-fájl: ebből tudja a tools\restart-tray.ps1 (és bármely külső eszköz),
  # melyik folyamat a tálca. A mutex önmagában nem ad folyamat-azonosítót.
  try { Set-Content -Path $script:TrayPidFile -Value $PID -Encoding ASCII } catch { }
  Update-TrayHeartbeat

  $script:Config = Get-Config
  $script:Config['resolvedDsh'] = Resolve-BestDshBin -Config $script:Config

  $notify = New-Object System.Windows.Forms.NotifyIcon
  $iconOn = if (Test-Path $script:IconOnFile) { New-Object System.Drawing.Icon($script:IconOnFile) }
            else { [System.Drawing.SystemIcons]::Application }
  $iconOff = if (Test-Path $script:IconOffFile) { New-Object System.Drawing.Icon($script:IconOffFile) }
             else { $iconOn }
  $notify.Icon = $iconOff
  $notify.Text = 'DeepSeek Harness'
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip

  $miStatus  = New-Object System.Windows.Forms.ToolStripMenuItem('Állapot…')
  $miOpen    = New-Object System.Windows.Forms.ToolStripMenuItem('Megnyitás (ablak)')
  $miClose   = New-Object System.Windows.Forms.ToolStripMenuItem('Ablak bezárása')
  $miPanes   = New-Object System.Windows.Forms.ToolStripMenuItem('Ablak felosztása')
  $miStart   = New-Object System.Windows.Forms.ToolStripMenuItem('Háttér-GUI indítása')
  $miStop    = New-Object System.Windows.Forms.ToolStripMenuItem('Háttér-GUI leállítása')
  $miRestart = New-Object System.Windows.Forms.ToolStripMenuItem('Újraindítás')
  $sep1      = New-Object System.Windows.Forms.ToolStripSeparator
  $miPort    = New-Object System.Windows.Forms.ToolStripMenuItem('Port beállítása…')
  $miDsh     = New-Object System.Windows.Forms.ToolStripMenuItem('dsh elérési út…')
  $miLogs    = New-Object System.Windows.Forms.ToolStripMenuItem('Naplók megnyitása')
  $miShort   = New-Object System.Windows.Forms.ToolStripMenuItem('Asztali gyorsparancs…')
  $miRestartTray = New-Object System.Windows.Forms.ToolStripMenuItem('A tálca újraindítása')
  $miRestartRobot = New-Object System.Windows.Forms.ToolStripMenuItem('A robot panel újraindítása')
  $sep2      = New-Object System.Windows.Forms.ToolStripSeparator
  $miExit    = New-Object System.Windows.Forms.ToolStripMenuItem('Kilépés (minden leáll)')

  # Tooltipek: minden menüpont megmondja, mit tesz, és mi marad utána. Enélkül a
  # "leállítás" és az "ablak bezárása" könnyen összekeveredik.
  $miStatus.ToolTipText  = 'A harness, az ablak, a robot panel és az őrfolyam állapota egy ablakban'
  $miOpen.ToolTipText    = 'Megnyitja a DSH ablakot; ha már nyitva van, előtérbe hozza. A háttér-GUI-t is elindítja, ha nem fut'
  $miClose.ToolTipText   = 'Bezárja az ablakot. A háttér-GUI és a tálca futva marad, ezért legközelebb azonnal nyílik'
  $miPanes.ToolTipText   = 'Hány munkaterület-panel legyen egymás mellett (1–3), és külön a robot panel'
  $miStart.ToolTipText   = 'Elindítja a harness szervert a háttérben (ha már fut és egészséges, nem indít másodikat)'
  $miStop.ToolTipText    = 'Leállítja a harness szervert. Az ablak és a tálca megmarad, a munkamenetek nem vesznek el'
  $miRestart.ToolTipText = 'Leállítja, majd frissen újraindítja a harness szervert (új belépési tokent ad). Az ablak magától az új tokenre vált'
  $miPort.ToolTipText    = 'A harness portja (alapértelmezés: 3080). A többi komponens innen olvassa'
  $miDsh.ToolTipText     = 'A dsh CLI elérési útja; üresen hagyva automatikusan megkeresi (npm globális, majd npx cache)'
  $miLogs.ToolTipText    = 'Megnyitja a tálca, az ablak és a harness naplóit'
  $miShort.ToolTipText   = 'Asztali gyorsparancsot készít a tálcára kitűzhető indítóhoz (DshLauncher.exe)'
  $miRestartTray.ToolTipText = 'Újratölti a tálca programját (a frissített tray\dsh-tray.ps1 lép életbe). Az ablak és a háttér-GUI futva marad'
  $miRestartRobot.ToolTipText = 'Újraindítja a robot panelt (4180) az őrfolyamával együtt, hogy a friss panel-kód életbe lépjen. Az ablak és a harness futva marad'
  $miExit.ToolTipText    = 'MINDENT leállít: az ablakot, a háttér-GUI-t és a tálcát is. A robot panel őrfolyama külön folyamat, az futva marad'

  $miStatus.Add_Click({ Show-Status -Config $script:Config })
  $miOpen.Add_Click({ Open-HarnessWindow })
  $miClose.Add_Click({ Close-HarnessWindow })

  # Panelos felosztás: választógombok, a beállítás a tray-config.json-ba kerül.
  # A panelszámot a menüpont Tag-ja hordozza (nem closure), a kezelő pedig a
  # szkript session state-jét használja, mint a többi menüpont.
  $script:PaneMenuItems = @{}
  foreach ($count in 1, 2, 3) {
    $paneItem = New-Object System.Windows.Forms.ToolStripMenuItem("$count panel")
    $paneItem.Tag = $count
    $paneItem.Checked = ([int]$script:Config['panes'] -eq $count)
    $paneItem.ToolTipText = "$count munkaterület-panel egymás mellett (a robot panel ezen felül jön, ha be van kapcsolva)"
    $paneItem.add_Click({ param($sender, $e) Set-WindowPanes -Config $script:Config -Panes ([int]$sender.Tag) })
    $script:PaneMenuItems[$count] = $paneItem
    $miPanes.DropDownItems.Add($paneItem) | Out-Null
  }

  # A robot mint KÜLÖN felület: a munkaterület-panelek után jelenik meg, ezért
  # bekapcsoláskor a panelek száma legfeljebb 3 (3 munkaterület + robot = 4).
  $script:RobotMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('4. felület: robot panel')
  $script:RobotMenuItem.CheckOnClick = $true
  $script:RobotMenuItem.Checked = [bool]$script:Config['robotPane']
  $script:RobotMenuItem.ToolTipText = 'A robot állapotpanelje (http://127.0.0.1:4180/) külön felületként, a munkaterületek mellett. Bekapcsolva az ablak eggyel több panellel nyílik, és az utolsó a roboté'
  $script:RobotMenuItem.add_Click({ param($sender, $e) Set-RobotPane -Config $script:Config -Enabled ([bool]$sender.Checked) })
  $miPanes.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  $miPanes.DropDownItems.Add($script:RobotMenuItem) | Out-Null

  # „Csak robot" mód: egyetlen felület, teljes szélességben a robot-konzol.
  $script:RobotOnlyMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem('Csak robot mód (1 felület)')
  $script:RobotOnlyMenuItem.CheckOnClick = $true
  $script:RobotOnlyMenuItem.Checked = [bool]$script:Config['robotOnly']
  $script:RobotOnlyMenuItem.ToolTipText = 'Az ablak egyetlen felülettel nyílik: csak a robot-konzol, teljes szélességben. A munkaterület-panelek ilyenkor nem nyílnak meg'
  $script:RobotOnlyMenuItem.add_Click({ param($sender, $e) Set-RobotOnly -Config $script:Config -Enabled ([bool]$sender.Checked) })
  $miPanes.DropDownItems.Add($script:RobotOnlyMenuItem) | Out-Null
  $miStart.Add_Click({ Start-Harness -Config $script:Config -EnsureToken | Out-Null })
  $miStop.Add_Click({ Stop-Harness -Config $script:Config })
  # Az "Újraindítás" a TELJES hatteret ujrainditja: harness + robot panel.
  #
  # MIERT A PANEL IS: a robot panel (4180) kulon folyamat az orfolyamaval, ezert
  # a regi kodot futtatta tovabb egy javitas utan. A felhasznalo ezt ugy merte,
  # hogy „a talcan az ujrainditas nem inditja ujra a robotot".
  $miRestart.Add_Click({
    Stop-Harness -Config $script:Config -Quiet
    Start-Sleep -Milliseconds 600
    Start-Harness -Config $script:Config | Out-Null
    [void](Restart-RobotPanel)
  })
  $miPort.Add_Click({ Set-Port -Config $script:Config })
  $miDsh.Add_Click({
    Set-DshBin -Config $script:Config
    $script:Config['resolvedDsh'] = Resolve-BestDshBin -Config $script:Config
  })
  $miLogs.Add_Click({ Open-Logs })
  $miShort.Add_Click({ New-Shortcut -Quiet })
  $miRestartTray.Add_Click({ Restart-TraySelf })
  $miRestartRobot.Add_Click({
    Write-TrayLog 'menubol: robot panel ujrainditasa'
    if (-not (Restart-RobotPanel)) {
      [System.Windows.Forms.MessageBox]::Show(
        "A robot panel nem válaszolt az újraindítás után.`n`nNézd meg: bot\state\panel.err.log és bot\state\robot-watchdog.log",
        'DSH Harness', [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
  })
  # A "Kilépés" a TELJES leallast jelenti: ablak + hatter-GUI + talca.
  #
  # MERT HIBA: korabban ez a menupont csak a talcat bontotta le (a felirat is
  # "Kilépés (a GUI fut marad)" volt), a harness szerver pedig tovabb futott a porton. A felhasznalo ezert ugy erezte, hogy a Bezaras gomb hibas:
  # a talca eltunt, de a GUI es a szerver meg mindig allt, es a kovetkezo
  # inditasnal a REGI peldany szolgalta ki a feluletet (a regi, memoriabeli
  # nyilvantartassal). Most a Stop-Harness is lefut, tehat a kovetkezo inditas
  # biztos friss folyamatot es friss munkaterulet-nyilvantartast kap.
  $miExit.Add_Click({
    try {
      $answer = [System.Windows.Forms.MessageBox]::Show(
        "Leállítom a DeepSeek Harness-t?`n`nA bezárt ablakok és a háttér-GUI is leáll, a munkamenetek megmaradnak.",
        'Kilépés', [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question)
      if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

      try { $script:timer.Stop() } catch { }

      # 1) Az ablakok szabalyos bezarasa elobb, hogy a panel-aranyok es az
      #    ablakgeometria mentodjenek (a Stop-Process nem ad ra eselyt).
      try { Close-HarnessWindow } catch { }

      # 2) A hatter-GUI (node harness) leallitasa — ez volt a hianyzo lepes.
      try { Stop-Harness -Config $script:Config -Quiet } catch { Write-TrayLog "exit: Stop-Harness hiba: $($_.Exception.Message)" }

      # 3) A talca-ikon es a mutex elengedese.
      try { $notify.Visible = $false } catch { }
      # Az életjel- és PID-fájl törlése KILÉPÉSKOR: a tools\restart-harness.ps1
      # ezekből dönti el, hogy a tálca fut-e. Egy beragadt fájl egy HALOTT
      # tálcára bízta volna az újraindítási kérést (mért hiba, 2026-10-02: a
      # kilépés után 5 másodperccel indított restart így ragadt be).
      Remove-Item $script:TrayHeartbeatFile, $script:TrayPidFile -Force -ErrorAction SilentlyContinue
      try { $notify.Dispose() } catch { }
      try { $script:windowSignal.Close() } catch { }
      try { $mutex.ReleaseMutex() } catch { }
      Write-TrayLog "kilépés: ablak + háttér-GUI + tálca leállítva"
    } catch {
      Write-TrayLog "exit hiba: $($_.Exception.Message)"
    } finally {
      [System.Windows.Forms.Application]::Exit()
    }
  })

  $menu.Items.AddRange(@($miStatus, $miOpen, $miClose, $miPanes, $miStart, $miStop, $miRestart, $sep1,
    $miPort, $miDsh, $miLogs, $miShort, $miRestartTray, $miRestartRobot, $sep2, $miExit))
  $notify.ContextMenuStrip = $menu
  $notify.add_DoubleClick({ Open-HarnessWindow })

  # Állapotfrissítés: ikon kék = fut, szürke = áll. Emellett innen figyeljük a
  # "nyisd meg az ablakot" jelzést, amit egy második indítás küld, és itt fut az
  # egészség-ellenőrzés is (legalább 20 másodpercenként).
  $script:lastRunning = $null
  $script:lastHealthCheck = [datetime]::MinValue
  $script:LastHeartbeatAt = [datetime]::MinValue
  $script:timer = New-Object System.Windows.Forms.Timer
  $script:timer.Interval = 1500
  $script:timer.add_Tick({
    try {
      $running = Test-HarnessRunning -Port ([int]$script:Config['port'])
      if ($running -ne $script:lastRunning) {
        $notify.Icon = if ($running) { $iconOn } else { $iconOff }
        $script:lastRunning = $running
      }
      $windowCount = (Get-WindowProcesses).Count
      $tip = if ($running) { "DSH · fut · http://127.0.0.1:$($script:Config['port'])" } else { "DSH · áll" }
      if ($windowCount -gt 0) { $tip += ' · ablak nyitva' }
      if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
      if ($notify.Text -ne $tip) { $notify.Text = $tip }

      # Életjel: ebből tudja minden más komponens, hogy a tálca fut, és rábízhatja
      # az újraindítást.
      if (((Get-Date) - $script:LastHeartbeatAt).TotalSeconds -ge 15) { Update-TrayHeartbeat }

      # Külső újraindítási kérés (DSH terminál, Web UI gomb, tools\restart-harness.ps1).
      # A tálca a DSH folyamatfáján KÍVÜL fut, ezért ez az egyetlen út, ami nem
      # szakadhat félbe. Előbb dolgozzuk fel, mint az önjavítást, különben a kettő
      # ugyanazon a porton versenyezne.
      if (Get-RestartRequest) {
        Write-TrayLog 'restart keres: kulso keres atveve'
        try {
          Restart-HarnessProcess -Config $script:Config
          Write-TrayLog 'restart keres: kesz (friss token elmentve)'
        } catch {
          Write-TrayLog "restart keres: HIBA - $($_.Exception.Message)"
        }
        $script:HealthFailures = 0
      }

      if (((Get-Date) - $script:lastHealthCheck).TotalSeconds -ge 20) {
        $script:lastHealthCheck = Get-Date
        Invoke-HarnessAutoHeal -Config $script:Config
        Invoke-RobotEnsure
      }

      if (Get-OpenWindowSignal) {
        # Ha időközben már nyitva van egy ablak, nem nyitunk másodikat.
        if ((Get-WindowProcesses).Count -eq 0) {
          Write-TrayLog "ablak megnyitása jelzésre (második indítás)"
          Open-HarnessWindow
        } else {
          Write-TrayLog "ablak megnyitása jelzésre: már nyitva van, előtérbe hozva"
          $existing = Get-WindowProcesses | Select-Object -First 1
          Set-WindowForeground -Handle $existing.MainWindowHandle | Out-Null
        }
      }
    } catch {
      Write-TrayLog "tick hiba: $($_.Exception.Message)"
    }
  })
  $script:timer.Start()

  Write-TrayLog "tálca elindult (port $($script:Config['port']), dsh: $($script:Config['resolvedDsh']))"

  # Induláskor: a háttér-GUI-t mindig elindítjuk, az ablakot pedig csak akkor
  # nyitjuk meg, ha az indító ezt kérte (asztali ikon / tálcára kitűzés).
  $running = Test-HarnessRunning -Port ([int]$script:Config['port'])
  $script:lastRunning = $running
  $notify.Icon = if ($running) { $iconOn } else { $iconOff }

  if ($script:OpenWindowOnStart) {
    Start-Harness -Config $script:Config -ThenOpenWindow -EnsureToken | Out-Null
  } else {
    Start-Harness -Config $script:Config -EnsureToken | Out-Null
  }

  [System.Windows.Forms.Application]::Run()
}

# Az ablak megnyitása a tálcáról: a háttér-GUI is elindul, ha kell.
function Open-HarnessWindow {
  $existing = Get-WindowProcesses | Select-Object -First 1
  if ($existing) {
    Set-WindowForeground -Handle $existing.MainWindowHandle | Out-Null
    return
  }
  Start-Harness -Config $script:Config -ThenOpenWindow -EnsureToken | Out-Null
}

# --- belépési pont ------------------------------------------------------------
if ($DumpConfig) {
  $cfg = Get-Config
  $cfg['resolvedDsh'] = Resolve-BestDshBin -Config $cfg
  $cfg['windowExe'] = $script:WindowExe
  $cfg['stateDir'] = $script:StateDir
  $cfg | ConvertTo-Json
  return
}

# Alapból nem nyitunk ablakot (pl. bejelentkezéskori indításnál a tálca elég);
# az asztali/tálcás ikon -OpenWindow kapcsolóval kéri az ablak megnyitását.
$script:OpenWindowOnStart = [bool]$OpenWindow -and -not [bool]$NoWindow

if ($OpenWindow) {
  # Ez az "alkalmazás indítása" út: ha már fut a tálca, az ablakot nyitja meg.
  Invoke-Launch -ShowWindow:$script:OpenWindowOnStart | Out-Null
} else {
  Show-Tray
}
