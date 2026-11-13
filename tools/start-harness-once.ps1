<#
.SYNOPSIS
  A harness indítása EGYSZERRE — a dupla indítás kizárásával.

.DESCRIPTION
  MIÉRT: 2026-11-13-án három egymást követő indítás futott (pid 6988, 16956,
  14412), mert a tálca ~20 mp-enként újraindította a harness-t, amíg nem jelent
  meg a token-URL; később pedig a `restart-harness.ps1 -Force` ÉS a tálca is
  indított egy-egy példányt ugyanarra a portra (24504 nyert, 35424 elhalt).
  Egy portra két szerver nem fér el: a vesztes folyamat elszáll, a naplók
  összekeverednek, és a plugin reconcilációja rossz példányban futhat le.

  EZ A SZKRIPT egyetlen belépési pont a repó oldaláról, és három védelmet ad:
    1) NEVES MUTEX (`Global\DshHarnessStart-<port>`): két indító nem futhat
       egyszerre; a második azonnal visszalép,
    2) ELŐZETES ELLENŐRZÉS: ha a `state\harness.pid` él, vagy a port már
       figyel, nem indítunk másodikat,
    3) „ÉPPEN INDUL" ABLAK: ha a pid-fájl 25 mp-en belül íródott, kivárunk,
       nem indítunk újabb példányt.

  A tálca (natív `DshTray.exe`, C#) nem ezen a szkripten keresztül indít, ezért
  azt innen nem lehet korlátozni — ezt a dokumentum rögzíti, és a végleges
  megoldás a mag/tálca oldalán van (upstream).

.EXAMPLE
  .\tools\start-harness-once.ps1              # indítás, ha még nem fut
  .\tools\start-harness-once.ps1 -Force       # a tálcát kihagyva (WMI-leválasztott út)
  .\tools\start-harness-once.ps1 -Check       # csak megmondja, mit tenne
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$DshHome,
  [switch]$Force,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$pidFile = Join-Path $repoRoot 'state\harness.pid'
$startWindowSeconds = 25

function Write-Step($text) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text) }

function Get-HarnessPid {
  try {
    $value = 0
    if ([int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$value)) { return $value }
  } catch { }
  return 0
}

# --- 1) neves mutex -----------------------------------------------------------
$mutexName = "Global\DshHarnessStart-$Port"
$mutex = $null
$acquired = $false
try {
  $createdNew = $false
  $mutex = [System.Threading.Mutex]::new($false, $mutexName, [ref]$createdNew)
  # 0 ms várakozás: ha más tartja, NEM várunk rá — egyszerűen nem indítunk.
  $acquired = $mutex.WaitOne(0)
} catch {
  # A Global\ névtér jogosultságot kérhet; essünk vissza Local\-ra.
  try {
    $mutex = [System.Threading.Mutex]::new($false, "Local\DshHarnessStart-$Port")
    $acquired = $mutex.WaitOne(0)
  } catch {
    Write-Step "a mutex nem hozható létre ($($_.Exception.Message)) — a többi ellenőrzés dönt"
  }
}

try {
  if ($mutex -ne $null -and -not $acquired) {
    Write-Step 'egy másik indító éppen fut (mutex) — NEM indítok másodikat'
    exit 4
  }

  # --- 2) előzetes ellenőrzés ------------------------------------------------
  $existing = Get-HarnessPid
  if ($existing -ne 0 -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
    Write-Step "a harness már fut (pid $existing) — nincs teendő"
    exit 0
  }

  $portOpen = $false
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $portOpen = $connect.AsyncWaitHandle.WaitOne(400) -and $client.Connected
    $client.Close()
  } catch {
    $portOpen = $false
  }
  if ($portOpen) {
    Write-Step "a $Port port már figyel (a pid-fájl elavult lehet) — NEM indítok másodikat"
    exit 0
  }

  # --- 3) „éppen indul" ablak -----------------------------------------------
  if (Test-Path $pidFile) {
    $ageSeconds = [int](((Get-Date) - (Get-Item $pidFile).LastWriteTime).TotalSeconds)
    if ($ageSeconds -ge 0 -and $ageSeconds -lt $startWindowSeconds) {
      Write-Step ("a pid-fájl {0} mp-e íródott — a harness éppen indul, NEM indítok másodikat" -f $ageSeconds)
      exit 0
    }
  }

  if ($Check) {
    Write-Step "indítható: nincs futó harness, a port szabad, nincs friss pid-fájl"
    exit 0
  }

  # --- 4) indítás ------------------------------------------------------------
  $restart = Join-Path $repoRoot 'tools\restart-harness.ps1'
  if (-not (Test-Path $restart)) { throw "Nem találom: $restart" }
  $arguments = @{ Port = $Port; DshHome = $DshHome; NoWait = $true }
  if ($Force) { $arguments['Force'] = $true }
  Write-Step ("indítás: restart-harness.ps1 {0}" -f (($arguments.GetEnumerator() | ForEach-Object { "-$($_.Key) $($_.Value)" }) -join ' '))
  & $restart @arguments | Out-Host
  Write-Step 'az indítási kérés leadva (nem várunk rá; a boot a tálcáé/leválasztott példányé)'
  exit 0
} finally {
  if ($mutex -ne $null) {
    if ($acquired) { try { $mutex.ReleaseMutex() } catch { } }
    $mutex.Dispose()
  }
}
