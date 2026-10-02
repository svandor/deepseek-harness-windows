Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CapWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
$p = Get-Process DshWindow -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NO_WINDOW'; exit 1 }

[CapWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[CapWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900

$cr = New-Object CapWin+RECT
[CapWin]::GetClientRect($p.MainWindowHandle, [ref]$cr) | Out-Null
$origin = New-Object CapWin+POINT
$origin.X = 0; $origin.Y = 0
[CapWin]::ClientToScreen($p.MainWindowHandle, [ref]$origin) | Out-Null
$cw = $cr.Right - $cr.Left
$ch = $cr.Bottom - $cr.Top
Write-Output "kliens terulet: ${cw}x${ch}  kezdet: $($origin.X),$($origin.Y)"

# Also levo 120 pixel kimentese
$stripH = [Math]::Min(120, $ch)
$bmp = New-Object System.Drawing.Bitmap($cw, $stripH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($origin.X, ($origin.Y + $ch - $stripH), 0, 0, (New-Object System.Drawing.Size($cw, $stripH)))
$g.Dispose()
$out = $args[0]
if (-not $out) { $out = Join-Path $env:TEMP 'dsh-bottom-strip.png' }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

# Pixelmintak: a sav kozepenek szine minden 12. sorban
Write-Output 'pixelmintak (y a sav tetejetol, kozepso x):'
for ($y = 0; $y -lt $stripH; $y += 12) {
  $c = $bmp.GetPixel([int]($cw / 2), $y)
  Write-Output ("  y={0,3}  RGB({1},{2},{3})" -f $y, $c.R, $c.G, $c.B)
}
$bmp.Dispose()
Write-Output "KEP: $out"
