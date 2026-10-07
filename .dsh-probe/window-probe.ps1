# Konzol-ablak figyelo: minden 300 ms-ban felderiti a klasszikus konzol- es a
# Windows Terminal ablakokat, es jelzi, ha uj megjelenik / eltunik / valtozik az
# allapota (lathato, minimalizalt). Cel: kideriteni, MELYIK folyamat nyitja a
# nehany percenkent felbukkano ablakot.
$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinProbe {
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
      if (c != "ConsoleWindowClass" && c != "CASCADIA_HOSTING_WINDOW_CLASS" && c != "PseudoConsoleWindow") return true;
      var txt = new StringBuilder(512); GetWindowText(h, txt, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}", h, pid, c, IsWindowVisible(h), IsIconic(h), txt.ToString()));
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

function Describe([string]$pidStr, [string]$hStr) {
  $out = ""
  try {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$pidStr" -ErrorAction Stop
    $par = $null
    if ($cim) { $par = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cim.ParentProcessId) -ErrorAction SilentlyContinue }
    $out = "proc=$($cim.Name) ppid=$($cim.ParentProcessId) parent=$(if($par){$par.Name}else{'?'})"
    $out += "`n        CMD: $($cim.CommandLine)"
    if ($par) { $out += "`n        PARENTCMD: $($par.CommandLine)" }
  } catch {
    try { $p = Get-Process -Id ([int]$pidStr) -ErrorAction Stop; $out = "proc=$($p.ProcessName) (CIM nelkul)" } catch { $out = "proc=ISMERETLEN (pid $pidStr)" }
  }
  return $out
}

$prev = @{}
$end = (Get-Date).AddMinutes(12)
Write-Output ("PROBE START {0}" -f (Get-Date -Format 'HH:mm:ss'))
while ((Get-Date) -lt $end) {
  $snap = [WinProbe]::Snapshot()
  $cur = @{}
  foreach ($row in $snap) {
    $f = $row -split '\|'
    $key = $f[0]
    $state = "$($f[3])/$($f[4])"
    $cur[$key] = $state
    if (-not $prev.ContainsKey($key)) {
      Write-Output ("{0} APPEAR hwnd={1} state(visible/iconic)={2} class={3} title='{4}'" -f (Get-Date -Format 'HH:mm:ss.fff'), $key, $state, $f[2], $f[5])
      Write-Output ("        " + (Describe $f[1] $key))
    } elseif ($prev[$key] -ne $state) {
      Write-Output ("{0} STATE  hwnd={1} {2} -> {3} title='{4}'" -f (Get-Date -Format 'HH:mm:ss.fff'), $key, $prev[$key], $state, $f[5])
      Write-Output ("        " + (Describe $f[1] $key))
    }
  }
  foreach ($k in $prev.Keys) {
    if (-not $cur.ContainsKey($k)) { Write-Output ("{0} GONE   hwnd={1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $k) }
  }
  $prev = $cur
  Start-Sleep -Milliseconds 300
}
Write-Output ("PROBE END {0}" -f (Get-Date -Format 'HH:mm:ss'))
