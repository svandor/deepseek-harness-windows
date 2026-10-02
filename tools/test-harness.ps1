$root = 'C:\Szerver\Deepseek Harness'
$test = Join-Path $root '.test-dsh-home'
$port = 3081
$bin = '$env:LOCALAPPDATA\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai\dsh\lib\bin.js'
$log = Join-Path $test 'test-harness.log'
$err = Join-Path $test 'test-harness.err.log'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NetTab2 {
  [DllImport("iphlpapi.dll", SetLastError = true)]
  public static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int cls, int reserved);
  [StructLayout(LayoutKind.Sequential)]
  public struct ROW { public uint State; public uint LocalAddr; public uint LocalPort; public uint RemoteAddr; public uint RemotePort; public uint Pid; }
}
"@
function Get-ListenerPid {
  param([int]$Port)
  $size = 0
  [NetTab2]::GetExtendedTcpTable([IntPtr]::Zero, [ref]$size, $false, 2, 3, 0) | Out-Null
  if ($size -le 0) { return 0 }
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    if ([NetTab2]::GetExtendedTcpTable($buf, [ref]$size, $false, 2, 3, 0) -ne 0) { return 0 }
    $count = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf)
    $rowSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][NetTab2+ROW])
    $want = (($Port -band 0xFF) -shl 8) -bor (($Port -shr 8) -band 0xFF)
    for ($i = 0; $i -lt $count; $i++) {
      $ptr = [IntPtr]($buf.ToInt64() + 4 + ($i * $rowSize))
      $row = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][NetTab2+ROW])
      if ($row.LocalPort -eq $want) { return [int]$row.Pid }
    }
  } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
  return 0
}

$existing = Get-ListenerPid -Port $port
if ($existing -gt 0) { Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }

Remove-Item $log, $err -Force -ErrorAction SilentlyContinue
$env:DSH_HOME = $test
$p = Start-Process -FilePath 'node' -ArgumentList @("`"$bin`"", 'web', '--host', '127.0.0.1', '--port', "$port", '--no-open') `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError $err

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if ((Get-ListenerPid -Port $port) -gt 0) { break }
}
$pid_ = Get-ListenerPid -Port $port
Write-Output "teszt harness a ${port}-on: pid $pid_"

Write-Output '=== test harness log ==='
Get-Content $log -Raw -ErrorAction SilentlyContinue | ForEach-Object { $_ -replace 'token=[A-Za-z0-9_\-]+', 'token=***' }
Write-Output '=== test harness stderr (elso 8) ==='
Get-Content $err -ErrorAction SilentlyContinue | Select-Object -First 8

# Boot oldal ellenorzese: token csere, majd a HTML vizsgalata.
$url = (Get-Content $log -Raw -ErrorAction SilentlyContinue | Select-String -Pattern 'http://127\.0\.0\.1:3081/\?token=[A-Za-z0-9_\-]+' -AllMatches).Matches.Value | Select-Object -First 1
if (-not $url) { Write-Output 'NINCS token URL a teszt naploban'; exit 0 }

$token = ($url -split 'token=')[1]
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try { Invoke-WebRequest "http://127.0.0.1:3081/?token=$token" -UseBasicParsing -WebSession $session -TimeoutSec 10 | Out-Null } catch { }
$html = $null
try { $html = (Invoke-WebRequest "http://127.0.0.1:3081/" -UseBasicParsing -WebSession $session -TimeoutSec 10).Content } catch { Write-Output "index hiba: $($_.Exception.Message)" }
if ($html) {
  Write-Output ("index hossz: {0}" -f $html.Length)
  if ($html -match 'Failed to load plugins') {
    Write-Output '*** BOOT HIBA ***'
    $m = [regex]::Match($html, 'Failed to load plugins.{0,400}', 'Singleline')
    Write-Output $m.Value
  } else {
    Write-Output 'BOOT OK (nincs "Failed to load plugins")'
  }
  if ($html -match 'dsh-ui-extras') { Write-Output 'dsh-ui-extras BENNE VAN az indexben' }
}
