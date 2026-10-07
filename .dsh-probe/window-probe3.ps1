# MINDEN lathato felso szintu ablak + eloter-valtas figyelese.
# Cel: a "nehanyszor percenkent felugro ablak" pillanatnyi tulajdonosanak
# (folyamat + command line) azonosítasa akkor is, ha nem konzol-osztalyu.
$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinProbe3 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Visible() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var txt = new StringBuilder(512); GetWindowText(h, txt, 512);
      string t = txt.ToString();
      if (t.Length == 0) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      string c = cls.ToString();
      if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman" || c == "WorkerW") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(string.Format("{0}|{1}|{2}|{3}|{4}", h, pid, c, IsIconic(h), t));
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static string Foreground() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "|0|||";
    var txt = new StringBuilder(512); GetWindowText(h, txt, 512);
    var cls = new StringBuilder(256); GetClassName(h, cls, 256);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return string.Format("{0}|{1}|{2}|false|{3}", h, pid, cls.ToString(), txt.ToString());
  }
}
'@

function Owner([string]$pidStr) {
  try {
    $c = Get-CimInstance Win32_Process -Filter "ProcessId=$pidStr" -ErrorAction Stop
    if (-not $c) { return "pid=$pidStr (mar nem el)" }
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.ParentProcessId) -ErrorAction SilentlyContinue
    return "pid=$pidStr $($c.Name) ppid=$($c.ParentProcessId) parent=$(if($p){$p.Name}else{'?'})`n            CMD: $($c.CommandLine)"
  } catch { return "pid=$pidStr (nem olvashato)" }
}

$prev = @{}
$prevFg = ""
$end = (Get-Date).AddMinutes(20)
Write-Output ("PROBE3 START {0}  (minden lathato ablak + eloter)" -f (Get-Date -Format 'HH:mm:ss'))
while ((Get-Date) -lt $end) {
  $cur = @{}
  foreach ($row in [WinProbe3]::Visible()) {
    $f = $row -split '\|'
    $cur[$f[0]] = "$($f[3])"
    if (-not $prev.ContainsKey($f[0])) {
      Write-Output ("{0} UJ-ABLAK class={1} iconic={2} title='{3}'" -f (Get-Date -Format 'HH:mm:ss.fff'), $f[2], $f[3], $f[4])
      Write-Output ("            " + (Owner $f[1]))
    }
  }
  foreach ($k in $prev.Keys) { if (-not $cur.ContainsKey($k)) { Write-Output ("{0} ELTUNT hwnd={1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $k) } }
  $prev = $cur
  $fg = [WinProbe3]::Foreground()
  if ($fg -ne $prevFg) {
    $prevFg = $fg
    $f = $fg -split '\|'
    Write-Output ("{0} ELOTER class={1} title='{2}'" -f (Get-Date -Format 'HH:mm:ss.fff'), $f[2], $f[4])
  }
  Start-Sleep -Milliseconds 250
}
Write-Output ("PROBE3 END {0}" -f (Get-Date -Format 'HH:mm:ss'))
