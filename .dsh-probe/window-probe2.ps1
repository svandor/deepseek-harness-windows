# CELZOTT FIGYELO:
#  1) minden olyan konzol/Terminal ablak, ami LATHATO vagy cmd.exe cimu (a zajos
#     OpenSSH/PseudoConsole sorok kihagyva)
#  2) minden uj folyamat, aminek a command line-jaban yorgameizer szerepel
$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinProbe2 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Snapshot() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      string c = cls.ToString();
      if (c != "ConsoleWindowClass" && c != "CASCADIA_HOSTING_WINDOW_CLASS") return true;
      var txt = new StringBuilder(512); GetWindowText(h, txt, 512);
      string t = txt.ToString();
      bool vis = IsWindowVisible(h);
      if (t.IndexOf("OpenSSH", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      if (!vis && t.Length == 0) return true;
      res.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}", h, GetWinPid(h), c, vis, IsIconic(h), t));
      return true;
    }, IntPtr.Zero);
    return res;
  }
  static uint GetWinPid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
}
'@

function Describe([string]$pidStr) {
  try {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$pidStr" -ErrorAction Stop
    if (-not $cim) { return "proc=ISMERETLEN (pid $pidStr)" }
    $par = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cim.ParentProcessId) -ErrorAction SilentlyContinue
    $s = "proc=$($cim.Name) ppid=$($cim.ParentProcessId) parent=$(if($par){$par.Name}else{'?'})`n        CMD: $($cim.CommandLine)"
    if ($par) { $s += "`n        PARENTCMD: $($par.CommandLine)" }
    return $s
  } catch {
    return "proc=ISMERETLEN (pid $pidStr) - $($_.Exception.Message)"
  }
}

$prev = @{}
$seenYorg = @{}
$end = (Get-Date).AddMinutes(12)
Write-Output ("PROBE2 START {0}" -f (Get-Date -Format 'HH:mm:ss'))
while ((Get-Date) -lt $end) {
  $snap = [WinProbe2]::Snapshot()
  $cur = @{}
  foreach ($row in $snap) {
    $f = $row -split '\|'
    $key = $f[0]
    $state = "$($f[3])/$($f[4])"
    $cur[$key] = $state
    if (-not $prev.ContainsKey($key)) {
      Write-Output ("{0} APPEAR state={1} class={2} title='{3}'" -f (Get-Date -Format 'HH:mm:ss.fff'), $state, $f[2], $f[5])
      Write-Output ("        " + (Describe $f[1]))
    } elseif ($prev[$key] -ne $state) {
      Write-Output ("{0} STATE  {1} -> {2} title='{3}'" -f (Get-Date -Format 'HH:mm:ss.fff'), $prev[$key], $state, $f[5])
    }
  }
  foreach ($k in $prev.Keys) { if (-not $cur.ContainsKey($k)) { Write-Output ("{0} GONE   hwnd={1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $k) } }
  $prev = $cur

  foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'yorgame' })) {
    if (-not $seenYorg.ContainsKey([int]$p.ProcessId)) {
      $seenYorg[[int]$p.ProcessId] = $true
      Write-Output ("{0} YORG-PROC pid={1} {2} ppid={3} start={4}`n        CMD: {5}" -f (Get-Date -Format 'HH:mm:ss'), $p.ProcessId, $p.Name, $p.ParentProcessId, $p.CreationDate, $p.CommandLine)
    }
  }
  Start-Sleep -Milliseconds 400
}
Write-Output ("PROBE2 END {0}" -f (Get-Date -Format 'HH:mm:ss'))
