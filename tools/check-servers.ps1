<#
.SYNOPSIS
  A DeepSeek Harness gyors allapot-ellenorzese (harness, robot panel, talca).

.DESCRIPTION
  Ezt hivja a tools\restart-harness.cmd es a tools\restart-tray.cmd a vegen, de
  onalloan is futtathato. Nem valtoztat semmit, csak kiirja:

    * a harness szerver (alap: 3080) valaszol-e (401/200/303 = el),
    * a robot panel (alap: 4180) valaszol-e,
    * a rendszertalca eletjele friss-e (state\tray.heartbeat),
    * a mentett belepesi token (state\harness.url) megvan-e.

.EXAMPLE
  .\tools\check-servers.ps1
  .\tools\check-servers.ps1 -Port 3081 -RobotUrl http://127.0.0.1:4181/
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$RobotUrl = 'http://127.0.0.1:4180/'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$stateDir = Join-Path $root 'state'
$urlFile = Join-Path $stateDir 'harness.url'
$heartbeatFile = Join-Path $stateDir 'tray.heartbeat'

function Test-HarnessAlive {
  param([int]$CheckPort)
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$CheckPort/")
    $req.Method = 'GET'
    $req.Timeout = 6000
    $req.AllowAutoRedirect = $false
    try {
      $resp = $req.GetResponse()
      $code = [int]$resp.StatusCode
      $resp.Close()
      return "HTTP $code"
    } catch [System.Net.WebException] {
      if ($_.Exception.Response) { return "HTTP $([int]$_.Exception.Response.StatusCode)" }
      return "nem valaszol"
    }
  } catch {
    return "nem valaszol"
  }
}

function Test-RobotAlive {
  param([string]$Url)
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url.TrimEnd('/') + '/status.json')
    $req.Method = 'GET'
    $req.Timeout = 6000
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return "HTTP $code"
  } catch {
    return "nem valaszol"
  }
}

$harness = Test-HarnessAlive -CheckPort $Port
$robot = Test-RobotAlive -Url $RobotUrl

$trayAlive = 'nincs eletjel'
if (Test-Path $heartbeatFile) {
  $age = [int]((Get-Date) - (Get-Item $heartbeatFile).LastWriteTime).TotalSeconds
  if ($age -le 30) { $trayAlive = "fut (eletjel ${age} masodperccel ezelott)" }
  else { $trayAlive = "elavult eletjel (${age} masodperc)" }
}

$trayPidFile = Join-Path $stateDir 'tray.pid'
$trayPid = 'nincs PID-fajl (regi talu: futtasd a tools\restart-tray.cmd-t)'
if (Test-Path $trayPidFile) {
  $raw = (Get-Content $trayPidFile -Raw -ErrorAction SilentlyContinue)
  if ($raw -and $raw.Trim() -match '^\d+$') {
    $p = Get-Process -Id ([int]$raw.Trim()) -ErrorAction SilentlyContinue
    $trayPid = if ($p) { "$($raw.Trim()) (el)" } else { "$($raw.Trim()) (mar nem el - elavult fajl)" }
  }
}

$requestFile = Join-Path $stateDir 'restart-request'
$request = 'nincs'
if (Test-Path $requestFile) {
  $age = [int]((Get-Date) - (Get-Item $requestFile).LastWriteTime).TotalSeconds
  $request = "BERAGADT keres (${age} masodperccel ezelott) - a talca nem dolgozta fel"
}

$token = 'nincs mentett token'
if (Test-Path $urlFile) {
  $raw = (Get-Content $urlFile -Raw -ErrorAction SilentlyContinue)
  if ($raw -and $raw.Trim() -match '^http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+$') {
    $value = $raw.Trim()
    if ($value.Length -gt 46) { $value = $value.Substring(0, 46) + '...' }
    $token = $value
  } else {
    $token = 'ERVENYTELEN (csonka fajl) - futtasd: tools\restart-harness.cmd'
  }
}

Write-Host ''
Write-Host 'Allapot:'
Write-Host ("  harness $Port   : {0}" -f $harness)
Write-Host ("  robot panel    : {0}  {1}" -f $robot, $RobotUrl)
Write-Host ("  rendszertalca  : {0}" -f $trayAlive)
Write-Host ("  talca PID      : {0}" -f $trayPid)
Write-Host ("  restart-keres  : {0}" -f $request)
Write-Host ("  belepesi token : {0}" -f $token)
Write-Host ''

$tipp = @()
if ($harness -eq 'nem valaszol') { $tipp += '  a harness nem valaszol -> tools\restart-harness.cmd' }
if ($robot -eq 'nem valaszol') { $tipp += '  a robot panel nem valaszol -> bot\start-robot-watchdog.cmd' }
if ($trayAlive -like 'nincs*' -or $trayAlive -like 'elavult*') { $tipp += '  a talca nem ad eletjelet -> tools\restart-tray.cmd (a harness-restart utana a talcan at megy)' }
if ($request -ne 'nincs') { $tipp += '  beragadt restart-keres -> a talca nem fut vagy regi kodot futtat; torold: state\restart-request' }
if ($tipp.Count -gt 0) { Write-Host 'Tipp:'; $tipp | ForEach-Object { Write-Host $_ } }
