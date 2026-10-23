<#
.SYNOPSIS
  Figyeli a LÁTHATÓ konzolablakok megjelenését, és naplózza a parancssorral együtt.

.DESCRIPTION
  MÉRT HIBA háttere: a `powershell.exe -WindowStyle Hidden -File x.ps1` alakú
  ütemezett feladat-művelet LÁTHATÓ konzolablakot hoz létre, és csak utána
  hívja a ShowWindow(SW_HIDE)-ot -> fél másodperces villanás. Ugyanígy villan
  minden `powershell.exe -Command Start-Process -WindowStyle Hidden ...` külön
  folyamatként indított példánya, mert a -WindowStyle csak a Gyereket rejti el.

  Ez a szkript 200 ms-onként végigolvassa a top-level ablakokat, és minden
  ÚJONNAN megjelenő konzolablakot (ConsoleWindowClass) kínasol a naplóba:
  időpont, PID, exe, ablakcím. Emellett a 'Windows PowerShell' eseménynapló
  400-as eseményeit is figyeli (HostApplication = a teljes parancssor), így a
  villanás és a parancssor összerendelhető.

  Futtatás (a DSH sandboxából is megy, csak olvas):
    pwsh -NoProfile -File .\tools\watch-visible-consoles.ps1
    pwsh -NoProfile -File .\tools\watch-visible-consoles.ps1 -Minutes 30
#>
[CmdletBinding()]
param(
  [int]$IntervalMs = 200,
  [int]$Minutes = 0,                                  # 0 = végtelen
  [string]$LogPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'state\visible-console-watch.log')
)

$ErrorActionPreference = 'Continue'

if (-not ('WndSpy' -as [type])) {
  Add-Type -Namespace WndSpy -Name Api -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
public static IntPtr GetForeground() { return GetForegroundWindow(); }
'@ -UsingNamespace System.Text -ErrorAction Stop
}

function Write-Line([string]$text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $text
  [System.IO.File]::AppendAllText($script:LogPath, $line + "`r`n")
}

function Get-Consoles {
  $script:found = @{}
  $cb = [WndSpy.Api+EnumProc]{
    param([IntPtr]$h, [IntPtr]$l)
    $sb = New-Object System.Text.StringBuilder 256
    [void][WndSpy.Api]::GetClassName($h, $sb, 256)
    $cls = $sb.ToString()
    if ($cls -eq 'ConsoleWindowClass' -or $cls -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
      $t = New-Object System.Text.StringBuilder 512
      [void][WndSpy.Api]::GetWindowText($h, $t, 512)
      [uint32]$procId = 0
      [void][WndSpy.Api]::GetWindowThreadProcessId($h, [ref]$procId)
      $script:found["$($h.ToInt64())"] = [pscustomobject]@{
        Hwnd    = $h
        Pid     = [int]$procId
        Class   = $cls
        Title   = $t.ToString()
        Visible = [WndSpy.Api]::IsWindowVisible($h)
      }
    }
    return $true
  }
  [void][WndSpy.Api]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

# eseménynapló-figyelő állapot
$psSeen = New-Object System.Collections.Generic.HashSet[string]
$psLast = (Get-Date).AddMinutes(-1)

$started = Get-Date
Write-Line "=== watcher indult (interval=${IntervalMs}ms, minutes=$Minutes) ==="
"WATCHER STARTED -> $LogPath"

$seen = @{}
$primed = $false
while ($true) {
  if ($Minutes -gt 0 -and ((Get-Date) - $started).TotalMinutes -ge $Minutes) { break }

  try {
    $now = Get-Consoles
    foreach ($k in $now.Keys) {
      if (-not $seen.ContainsKey($k)) {
        $seen[$k] = $true
        if (-not $primed) { continue }   # az induláskori meglévő ablakok nem érdekesek
        $c = $now[$k]
        $exe = ''
        $st = ''
        $age = 9999
        try { $p = Get-Process -Id $c.Pid -ErrorAction Stop; $exe = $p.ProcessName; $st = $p.StartTime.ToString('HH:mm:ss.fff'); $age = [int]((Get-Date) - $p.StartTime).TotalSeconds } catch { }
        if (-not $c.Visible -and $age -gt 5) { continue }   # régóta futó, rejtett konzol: nem villanás
        $fg = if ([WndSpy.Api]::GetForeground() -eq $c.Hwnd) { 'FOREGROUND' } else { '' }
        $vis = if ($c.Visible) { 'visible' } else { 'hidden' }
        Write-Line ("WINDOW hwnd=0x{0:X} pid={1} exe={2} start={3} age={4}s {5} {6} title=""{7}""" -f $c.Hwnd.ToInt64(), $c.Pid, $exe, $st, $age, $vis, $fg, $c.Title)
      }
    }
    $primed = $true
    # eltűnt ablakok
    foreach ($k in @($seen.Keys)) { if (-not $now.ContainsKey($k)) { $seen.Remove($k) } }
  } catch { }

  if (((Get-Date) - $psLast).TotalSeconds -ge 2) {
    $psLast = Get-Date
    try {
      $ev = Get-WinEvent -FilterHashtable @{LogName='Windows PowerShell'; Id=400; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction Stop
      foreach ($e in $ev | Sort-Object TimeCreated) {
        $key = $e.TimeCreated.Ticks.ToString() + '|' + ($e.Message -replace '\s+',' ')
        if ($psSeen.Add($key)) {
          $ha = ($e.Message -split "`r?`n" | Where-Object { $_ -match '^\s*HostApplication=' }) -replace '^\s*HostApplication=',''
          Write-Line ("PSSTART {0} {1}" -f $e.TimeCreated.ToString('HH:mm:ss'), $ha.Trim())
        }
      }
    } catch { }
  }

  Start-Sleep -Milliseconds $IntervalMs
}
Write-Line '=== watcher leallt ==='
