<#
.SYNOPSIS
  A DeepSeek Harness ujrainditasa - minden hivohelyrol biztonsagosan.

.DESCRIPTION
  MIERT NEM MAGA CSINALJA MINDIG: a DSH termináljából (vagy a DSH bármely
  folyamatából) indítva ez a szkript a saját ősét állítja le. A DSH a leálláskor
  `taskkill /F /T`-vel a TELJES folyamatfát viszi, ezért a szkript félbemarad:
  a régi szervert leállítja, újat indít, de a friss tokent már nem tudja kiírni.
  Mért hiba (2026-10-02): a `state\harness.url` a RÉGI tokent tartotta, a tálca
  "token=False"-t látott, önjavítással újraindította a szervert, és közben
  elveszett az ablak robot felülete.

  EZÉRT a munka a TÁLCÁRA megy át: a tálcaikon az egyetlen folyamat, amely a DSH
  folyamatfáján kívül fut (a bejelentkezéskor indul, a saját mutexével), ezért az
  újraindítás ott soha nem szakadhat félbe.

  A szkript útjai, ebben a sorrendben:
    1) ha a tálca fut (életjel-fájl)  -> kérés a tálcának, majd várakozás a friss tokenre
    2) ha nem fut, de elindítható     -> a tálcát elindítja, majd az 1) pont
    3) ha a tálca nem indítható       -> WMI-vel indított leválasztott másolat
                                         (a WMI-szolgáltatás gyermeke, ezért a
                                         hívó folyamatfájának kilövése nem éri el)
    4) `-Force`                       -> a tálcát kihagyva, a 3) pont

  A `-Detached` belső kapcsoló: ezt a leválasztott másolat használja, ilyenkor
  fut a tényleges munka (figyelők leállítása, friss szerver, token kiírása).

  Az új belépési URL a `state\harness.url` fájlba kerül, ATOMIKUSAN (temp + csere),
  mert egy megszakadt írás csonka fájlt hagyott (74 byte helyett 3 byte), és
  utána minden olvasó a régi tokent látta.

.EXAMPLE
  .\tools\restart-harness.ps1                 # a tálca végzi el (ajánlott)
  .\tools\restart-harness.ps1 -NoWait         # csak a kérést adja le, nem vár
  .\tools\restart-harness.ps1 -Force          # a tálcát kihagyva, WMI-vel
  .\tools\restart-harness.ps1 -Port 3081 -DshHome "...\.test-dsh-home"
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'web',
  [string]$DshBin = '',
  # Belső: a leválasztott másolat futtatja a tényleges munkát.
  [switch]$Detached,
  # Ne várjon a friss tokenre (a kérést leadja és visszatér).
  [switch]$NoWait,
  # A tálcát kihagyva, mindig a saját (WMI-s) út.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$stateDir = Join-Path $root 'state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$heartbeatFile = Join-Path $stateDir 'tray.heartbeat'
$trayPidFile = Join-Path $stateDir 'tray.pid'
$requestFile = Join-Path $stateDir 'restart-request'
$urlFile = Join-Path $stateDir 'harness.url'
$pidFile = Join-Path $stateDir 'harness.pid'
$logFile = Join-Path $stateDir 'harness.log'
$errFile = Join-Path $stateDir 'harness.err.log'

function Write-HarnessToken {
  param([string]$Url)
  if (-not $Url) { return }
  $tmp = "$urlFile.tmp"
  Set-Content -Path $tmp -Value $Url -Encoding ASCII
  Move-Item -Path $tmp -Destination $urlFile -Force
}

# --- 1) a tálca átveszi-e? ----------------------------------------------------
# HÁROM független jel, mert bármelyik önmagában félrevezethet:
#   * a MUTEX a biztos jel (a tálca egyetlen példánya birtokolja),
#   * a PID-fájl élő powershell folyamatra mutasson,
#   * az életjel-fájl friss legyen.
# Mért hiba (2026-10-02): a felhasználó kilépett (minden leállt), majd 5
# másodperccel később futtatta a restartot. Az életjel-fájl a kilépéskor NEM
# törlődött, ezért frissnek látszott — a szkript a halott tálcára bízta a
# kérést, az beragadt, és a harness nem indult újra.
function Test-TrayAlive {
  param([int]$MaxAgeSeconds = 30)

  $mutexOk = $false
  try {
    $mutex = [System.Threading.Mutex]::OpenExisting('DshHarnessTrayIcon')
    $mutex.Dispose()
    $mutexOk = $true
  } catch { }
  if (-not $mutexOk) { return $false }

  if (Test-Path $trayPidFile) {
    try {
      $raw = (Get-Content $trayPidFile -Raw).Trim()
      if ($raw -match '^\d+$') {
        $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
        if (-not $proc) { return $false }
        if ($proc.ProcessName -notmatch 'powershell|pwsh') { return $false }
      }
    } catch { }
  } else {
    return $false   # PID-fájl nélkül nem tudjuk, hogy a mutexet melyik folyamat birtokolja
  }

  if (-not (Test-Path $heartbeatFile)) { return $false }
  try {
    return (((Get-Date) - (Get-Item $heartbeatFile).LastWriteTime).TotalSeconds -le $MaxAgeSeconds)
  } catch {
    return $false
  }
}

function Request-TrayRestart {
  $body = @{
    kereAt = (Get-Date).ToString('o')
    port   = $Port
    forras = 'restart-harness.ps1'
  } | ConvertTo-Json -Compress
  $tmp = "$requestFile.tmp"
  Set-Content -Path $tmp -Value $body -Encoding UTF8
  Move-Item -Path $tmp -Destination $requestFile -Force
}

function Start-TrayProcess {
  $launcher = Join-Path $root 'bin\DshLauncher.exe'
  $trayScript = Join-Path $root 'tray\dsh-tray.ps1'
  if (-not (Test-Path $launcher) -and -not (Test-Path $trayScript)) {
    Write-Host 'A tálca indítója nem található (bin\DshLauncher.exe / tray\dsh-tray.ps1).'
    return $false
  }
  if (Test-Path $launcher) {
    $file = $launcher
    $inner = @('--tray-only')
  } else {
    $file = 'powershell.exe'
    $inner = @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', "`"$trayScript`"", '-NoWindow'
    )
  }
  # A hívó folyamatfáján KÍVÜL indítjuk (WMI): a tálca az egyetlen folyamat, amely
  # túl kell élje a DSH leállítását, ezért nem maradhat a hívó gyermeke — egy
  # DSH-terminálból indítva különben a harness leállásakor magával rántaná.
  $started = $false
  try {
    $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
    $startup.ShowWindow = 0
    $commandLine = "`"$file`" " + ($inner -join ' ')
    $result = ([wmiclass]'Win32_Process').Create($commandLine, $root, $startup)
    if ($result -and $result.ReturnValue -eq 0) { $started = $true }
  } catch {
    Write-Host "A WMI-indítás nem elérhető ($($_.Exception.Message)) - Start-Process."
  }
  if (-not $started) {
    try {
      Start-Process -FilePath $file -ArgumentList $inner -WorkingDirectory $root -WindowStyle Hidden | Out-Null
      Write-Host 'FIGYELEM: a tálca a hívó folyamatfájában indult (WMI nem volt elérhető).'
    } catch {
      Write-Host "A tálca indítása nem sikerült: $($_.Exception.Message)"
      return $false
    }
  }
  # Várunk az életjelre (a tálca az első tickben kiírja).
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-TrayAlive -MaxAgeSeconds 120) { return $true }
  }
  return $false
}

# --- 2) a friss token megvárása ----------------------------------------------
# A harness él-e (401/200/303 = él)? A token-várakozás utáni döntéshez kell.
function Test-HarnessUp {
  param([int]$CheckPort)
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$CheckPort/")
    $req.Method = 'GET'
    $req.Timeout = 5000
    $req.AllowAutoRedirect = $false
    try {
      $resp = $req.GetResponse()
      $resp.Close()
      return $true
    } catch [System.Net.WebException] {
      return ($null -ne $_.Exception.Response)
    }
  } catch {
    return $false
  }
}

function Wait-FreshToken {
  param([int]$TimeoutSeconds = 150)
  $before = [datetime]::MinValue
  if (Test-Path $urlFile) {
    try { $before = (Get-Item $urlFile).LastWriteTime } catch { }
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $start = Get-Date
  $lastNote = $start
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    # Visszajelzés a várakozás alatt: enélkül a hívó úgy látja, hogy a szkript
    # megállt (a tálca 5-15 másodpercig dolgozik, és addig nincs kimenet).
    if (((Get-Date) - $lastNote).TotalSeconds -ge 10) {
      $lastNote = Get-Date
      Write-Host ("  … a tálca dolgozik, várom a friss tokent ({0} mp)" -f [int]((Get-Date) - $start).TotalSeconds)
    }
    if (-not (Test-Path $urlFile)) { continue }
    try {
      $info = Get-Item $urlFile
      if ($info.LastWriteTime -le $before) { continue }
      $raw = Get-Content $urlFile -Raw -ErrorAction SilentlyContinue
      if ($raw -and $raw.Trim() -match '^http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+$') { return $raw.Trim() }
    } catch { }
  }
  return $null
}

# --- 3) leválasztott másolat (a hívó folyamatfáján KÍVÜL) ----------------------
# A WMI a folyamatot a Win32_Process szolgáltatás gyermekeként indítja, ezért a
# hívó `taskkill /F /T`-je nem éri el. A sima Start-Process gyermeke a hívó fájában
# marad, és egy DSH-terminálból indítva meghalna.
function Start-DetachedSelf {
  $inner = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', "`"$PSCommandPath`"", '-Detached', '-Port', "$Port",
    '-DshHome', "`"$DshHome`"", '-Profile', "`"$Profile`""
  )
  if ($DshBin) { $inner += @('-DshBin', "`"$DshBin`"") }
  $commandLine = 'powershell.exe ' + ($inner -join ' ')

  try {
    $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
    $startup.ShowWindow = 0
    $result = ([wmiclass]'Win32_Process').Create($commandLine, $null, $startup)
    if ($result -and $result.ReturnValue -eq 0) {
      Write-Host "Leválasztott újraindító elindítva (pid $($result.ProcessId))."
      return $true
    }
    Write-Host "A WMI-indítás visszatért: $($result.ReturnValue) - próba Start-Process-szel."
  } catch {
    Write-Host "A WMI-indítás nem elérhető ($($_.Exception.Message)) - próba Start-Process-szel."
  }

  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $inner -WindowStyle Hidden | Out-Null
    return $true
  } catch {
    Write-Host "A leválasztott indítás sem sikerült: $($_.Exception.Message)"
    return $false
  }
}

# ============================================================================
#  A) nem-Detached: a kérést a tálcára bízzuk (vagy leválasztott másolatra)
# ============================================================================
if (-not $Detached) {
  Write-Host "DeepSeek Harness újraindítása (port $Port)…"

  $tray = Test-TrayAlive
  if (-not $tray -and -not $Force) {
    Write-Host 'A tálca nem fut — elindítom, hogy ő végezze el (a DSH folyamatfáján kívül).'
    $tray = Start-TrayProcess
  }

  if ($tray -and -not $Force) {
    Write-Host 'A tálca átveszi az újraindítást (friss token, félbemaradás nélkül).'
    Write-Host '  A tálca leállítja és újraindítja a szervert — ez általában 5–15 másodperc.'
    Request-TrayRestart
    if ($NoWait) { Write-Host 'A kérés leadva; az új token a state\harness.url fájlba kerül.'; return }
    $url = Wait-FreshToken
    if ($url) {
      Write-Host ''
      Write-Host 'Kész. Új belépési URL:'
      Write-Host "  $url"
    } else {
      Write-Host 'FIGYELEM: nem érkezett friss token 150 másodpercen belül.'
      if (-not (Test-HarnessUp -CheckPort $Port)) {
        # A tálca nem fejezte be, ÉS a szerver sem válaszol: ilyenkor nem
        # hagyjuk leállva, hanem a saját (leválasztott) úttal helyreállítjuk.
        Write-Host '  A harness NEM válaszol — a saját (leválasztott) úttal helyreállítom.'
        if (Start-DetachedSelf) {
          $url2 = Wait-FreshToken -TimeoutSeconds 150
          if ($url2) {
            Write-Host ''
            Write-Host 'Kész. Új belépési URL:'
            Write-Host "  $url2"
          } else {
            Write-Host '  A saját út sem adott friss tokent.'
            Write-Host "  Nézd meg: $errFile"
          }
        } else {
          Write-Host '  A saját utat sem sikerült elindítani.'
          Write-Host '  Indítsd újra a tálcát, majd: .\tools\restart-harness.ps1 -Force'
        }
      } else {
        Write-Host "  Nézd meg a tálca naplóját: $(Join-Path $stateDir 'tray.log')"
        Write-Host '  Ha a tálca nem fejezte be, próbáld a saját (WMI-s) úttal:'
        Write-Host '    .\tools\restart-harness.ps1 -Force'
      }
    }
    return
  }

  if (-not $Force) {
    # A tálca nem adott életjelet. Két eset van, és mindkettőt meg kell
    # különböztetni, mert a teendő más.
    $trayRunning = $false
    try {
      $mutex = [System.Threading.Mutex]::OpenExisting('DshHarnessTrayIcon')
      $mutex.Dispose()
      $trayRunning = $true
    } catch { }

    if ($trayRunning) {
      Write-Host ''
      Write-Host 'HIBA: a tálca FUT, de RÉGI verziót futtat (nincs életjel-fájlja).'
      Write-Host '  A régi tálca még nem ismeri az újraindítási kérést, ezért nem tudja'
      Write-Host '  átvenni a munkát — és a saját utat sem indítom el (lásd lent).'
      Write-Host ''
      Write-Host '  Először frissítsd a tálcát (az ablak és a háttér-GUI futva marad):'
      Write-Host '    .\tools\restart-tray.cmd'
      Write-Host '  Utána:'
      Write-Host '    .\tools\restart-harness.cmd'
      exit 3
    }

    # A tálca nem fut. Ilyenkor NEM próbálkozunk a saját úttal.
    #
    # MIÉRT: a saját út (WMI vagy leválasztott másolat) a HÍVÓ folyamatfájában
    # marad, ha a hívó maga is sandboxolt (DSH-agent) vagy a DSH folyamatából
    # indult. Az első dolga a régi szerver leállítása — ha utána a hívó fájával
    # együtt meghal, a harness LEÁLLVA MARAD, és nem indul újra. Ez rosszabb,
    # mint a félbemaradt token. Ezért inkább nem nyúlunk hozzá.
    Write-Host ''
    Write-Host 'HIBA: nincs futó rendszertálca, ezért az újraindítást nem indítom el.'
    Write-Host '  A tálca az egyetlen folyamat a DSH folyamatfáján kívül. A saját út'
    Write-Host '  (leválasztott másolat) egy DSH-folyamatból futtatva félbemaradhat, és'
    Write-Host '  a harness-t leállítva hagyhatja — ezért ezt nem kockáztatjuk.'
    Write-Host ''
    Write-Host '  Megoldás, ebben a sorrendben:'
    Write-Host '    1) indítsd el a tálcát:   bin\DshLauncher.exe --tray-only   (vagy az asztali ikon)'
    Write-Host '    2) majd újra:             .\tools\restart-harness.cmd'
    Write-Host '  Ha nincs mód a tálcára, vállalt kockázattal:'
    Write-Host '    .\tools\restart-harness.ps1 -Force      (normál ablakból futtasd!)'
    exit 3
  }

  # -Force: a saját (leválasztott) út, tudatos kockázatvállalással.
  Write-Host 'FIGYELEM: -Force — a tálcát kihagyva, leválasztott másolattal indítom.'
  Write-Host '         Normál ablakból biztonságos; DSH-folyamatból félbemaradhat.'
  if (-not (Start-DetachedSelf)) { throw 'Az újraindítást nem sikerült elindítani.' }
  if ($NoWait) { Write-Host 'A kérés leadva; az új token a state\harness.url fájlba kerül.'; return }
  $url = Wait-FreshToken
  if ($url) {
    Write-Host ''
    Write-Host 'Kész. Új belépési URL:'
    Write-Host "  $url"
  } else {
    Write-Host 'FIGYELEM: nem érkezett friss token 150 másodpercen belül.'
    Write-Host "  Nézd meg: $errFile"
  }
  return
}

# ============================================================================
#  B) Detached: a tényleges munka
# ============================================================================
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RestartNet {
  [DllImport("iphlpapi.dll", SetLastError = true)]
  public static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int cls, int reserved);
  [StructLayout(LayoutKind.Sequential)]
  public struct ROW { public uint State; public uint LocalAddr; public uint LocalPort; public uint RemoteAddr; public uint RemotePort; public uint Pid; }
}
"@

function Get-ListenerPids {
  param([int]$CheckPort)
  $result = @()
  $size = 0
  [RestartNet]::GetExtendedTcpTable([IntPtr]::Zero, [ref]$size, $false, 2, 3, 0) | Out-Null
  if ($size -le 0) { return $result }
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    if ([RestartNet]::GetExtendedTcpTable($buf, [ref]$size, $false, 2, 3, 0) -ne 0) { return $result }
    $count = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf)
    $rowSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][RestartNet+ROW])
    $want = (($CheckPort -band 0xFF) -shl 8) -bor (($CheckPort -shr 8) -band 0xFF)
    for ($i = 0; $i -lt $count; $i++) {
      $ptr = [IntPtr]($buf.ToInt64() + 4 + ($i * $rowSize))
      $row = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][RestartNet+ROW])
      if ($row.LocalPort -eq $want) { $result += [int]$row.Pid }
    }
  } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
  return ($result | Select-Object -Unique)
}

# --- 1) minden figyelo folyamat leallitasa -----------------------------------
$attempt = 0
while ($attempt -lt 6) {
  $attempt++
  $listeners = @(Get-ListenerPids -CheckPort $Port)
  if ($listeners.Count -eq 0) { break }
  foreach ($listener in $listeners) {
    Write-Host "Figyelo folyamat leallitasa (pid $listener, $attempt. proba)"
    Stop-Process -Id $listener -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3
}
$remaining = @(Get-ListenerPids -CheckPort $Port)
if ($remaining.Count -gt 0) {
  Write-Host "HIBA: a $Port portot nem sikerult felszabaditani (pid: $($remaining -join ', '))."
  exit 1
}
Write-Host "A $Port port szabad."

# --- 2) dsh CLI megkeresese ---------------------------------------------------
if (-not $DshBin) {
  $candidates = @()
  try {
    $g = (& npm root -g 2>$null | Select-Object -Last 1)
    if ($g) { $candidates += (Join-Path $g.Trim() '@deepseek-ai\dsh\lib\bin.js') }
  } catch { }
  try {
    $cache = (& npm config get cache 2>$null | Select-Object -Last 1)
    if ($cache) {
      Get-ChildItem (Join-Path $cache.Trim() '_npx') -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | ForEach-Object {
          $candidates += (Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js')
        }
    }
  } catch { }
  $DshBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $DshBin) { Write-Host 'HIBA: nem talalom a dsh CLI-t.'; exit 1 }
Write-Host "dsh: $DshBin"

# --- 3) friss harness ---------------------------------------------------------
# A napló UGYANAZ, amit a tálca is olvas (state\harness.log): így egy napló van,
# és a token-olvasás minden komponensnek ugyanabból a fájlból megy.
Remove-Item $logFile, $errFile -Force -ErrorAction SilentlyContinue

$env:DSH_HOME = $DshHome
Start-Process -FilePath 'node' `
  -ArgumentList @("`"$DshBin`"", 'web', '--host', '127.0.0.1', '--port', "$Port", '--no-open') `
  -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errFile | Out-Null

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (@(Get-ListenerPids -CheckPort $Port).Count -gt 0) { break }
}
$actual = @(Get-ListenerPids -CheckPort $Port) -join ', '
Write-Host "Harness fut a ${Port}-on (pid $actual)"

# --- 4) token URL mentese (atomikusan) ---------------------------------------
$url = $null
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $logFile) {
    $match = ((Get-Content $logFile -Raw) | Select-String -Pattern "http://127\.0\.0\.1:$Port/\?token=[A-Za-z0-9_\-]+" -AllMatches).Matches.Value
    if ($match -and $match.Count -gt 0) { $url = $match[-1]; break }
  }
  Start-Sleep -Seconds 2
}
if ($url) {
  Write-HarnessToken -Url $url
  Set-Content -Path $pidFile -Value ($actual -split ', ')[0] -Encoding ASCII
  Write-Host "Token elmentve: $urlFile"
  Write-Host ''
  Write-Host 'Uj belepesi URL:'
  Write-Host "  $url"
} else {
  Write-Host "Nem talaltam token URL-t a naploban - nezd meg: $logFile"
  Write-Host 'A state\harness.url valtozatlan maradt; az ablak a regit fogja hasznalni.'
  exit 1
}
