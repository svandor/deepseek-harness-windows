<#
.SYNOPSIS
  Builds the native DSH window launcher (bin\DshWindow.exe).

.DESCRIPTION
  This machine has no .NET SDK and no network access, so the launcher is
  compiled straight with the Roslyn csc.exe that ships inside Visual Studio
  Build Tools, against the .NET Framework 4.8 assemblies and the WebView2
  managed assemblies that VS also ships. Nothing is downloaded.

  The WebView2 runtime itself is a normal Windows 11 component (present here
  as 153.0.4234.48), so the produced exe only needs bin\WebView2Loader.dll
  next to it.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Clean
#>
[CmdletBinding()]
param(
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src     = Join-Path $Root 'src\DshWindow.cs'
$LauncherSrc = Join-Path $Root 'src\DshLauncher.cs'
$OutDir  = Join-Path $Root 'bin'
$LibDir  = Join-Path $Root 'lib'
$Exe     = Join-Path $OutDir 'DshWindow.exe'
$LauncherExe = Join-Path $OutDir 'DshLauncher.exe'
$Icon    = Join-Path $Root 'assets\dsh.ico'

if ($Clean) {
  foreach ($dir in @($OutDir, $LibDir, (Join-Path $Root 'obj'))) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  }
}

# --- locate the Roslyn compiler ----------------------------------------------
$cscCandidates = @(
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
  'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe',
  'C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe',
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'Nem található C# fordító (Roslyn csc.exe). Telepítsd a VS Build Tools "MSBuild" komponensét.' }

# --- locate the WebView2 assemblies (shipped by VS) --------------------------
$vsRoots = @(
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools',
  'C:\Program Files\Microsoft Visual Studio\2022\BuildTools',
  'C:\Program Files (x86)\Microsoft Visual Studio\2022\Community',
  'C:\Program Files\Microsoft Visual Studio\2022\Community'
)

function Find-VsFile {
  param([string]$Name)
  foreach ($root in $vsRoots) {
    if (-not (Test-Path $root)) { continue }
    $hit = Get-ChildItem $root -Recurse -Filter $Name -File -ErrorAction SilentlyContinue |
      Sort-Object Length -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$wv2Core = Find-VsFile 'Microsoft.Web.WebView2.Core.dll'
$wv2Load = Find-VsFile 'WebView2Loader.dll'
if (-not $wv2Core -or -not $wv2Load) {
  throw "A WebView2 assembly-k nem találhatók a Visual Studio alatt (Core: $wv2Core, Loader: $wv2Load)."
}

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'

# WPF assemblies live in the GAC on this machine (and PresentationCore only in
# GAC_64), not in the framework directory, so probe every GAC root.
$gacRoot = Join-Path $env:WINDIR 'Microsoft.NET\assembly'
$gacRoots = @(
  (Join-Path $gacRoot 'GAC_MSIL'),
  (Join-Path $gacRoot 'GAC_64'),
  (Join-Path $gacRoot 'GAC_32')
) | Where-Object { Test-Path $_ }

function Resolve-FrameworkAssembly {
  param([string]$Name)
  $direct = Join-Path $fw $Name
  if (Test-Path $direct) { return $direct }
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($Name)
  foreach ($root in $gacRoots) {
    $hit = Get-ChildItem (Join-Path $root $stem) -Recurse -Filter $Name -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $direct
}

# --- vendor the runtime dependencies into lib\ and bin\ ----------------------
# Only Core is needed: the launcher drives WebView2 through the Core API on the
# window's own HWND, so the WPF wrapper assembly is not referenced.
New-Item -ItemType Directory -Force -Path $OutDir, $LibDir | Out-Null
$vendored = 0
$locked = @()
foreach ($pair in @(
    @{ From = $wv2Core; To = (Join-Path $LibDir 'Microsoft.Web.WebView2.Core.dll') },
    @{ From = $wv2Core; To = (Join-Path $OutDir 'Microsoft.Web.WebView2.Core.dll') },
    @{ From = $wv2Load; To = (Join-Path $OutDir 'WebView2Loader.dll') },
    @{ From = $wv2Load; To = (Join-Path $LibDir 'WebView2Loader.dll') }
  )) {
  try {
    Copy-Item $pair.From $pair.To -Force
    $vendored++
  }
  catch {
    # A running window keeps the native DLLs open. That is not a build failure:
    # the copy only has to succeed once, and the compile below needs the file to
    # EXIST, not to be freshly written.
    if (Test-Path $pair.To) { $locked += (Split-Path -Leaf $pair.To) }
    else { throw "Nem sikerult a fuggoseget masolni es nem is letezik: $($pair.To)" }
  }
}
if ($locked.Count -gt 0) {
  Write-Host ("Megjegyzes: ezek a fajlok foglaltak voltak (futo ablak), a meglevo peldanyt hasznalom: " + (($locked | Select-Object -Unique) -join ', '))
}

# --- compile -----------------------------------------------------------------
# -noconfig: no implicit csc.rsp; mscorlib is still resolved from the framework
# directory because the compiler is the .NET Framework flavour.
$refs = @(
  (Resolve-FrameworkAssembly 'mscorlib.dll'),
  (Resolve-FrameworkAssembly 'System.dll'),
  (Resolve-FrameworkAssembly 'System.Core.dll'),
  (Resolve-FrameworkAssembly 'System.Xml.dll'),
  (Resolve-FrameworkAssembly 'System.Drawing.dll'),
  (Resolve-FrameworkAssembly 'System.Windows.Forms.dll'),
  (Resolve-FrameworkAssembly 'WindowsBase.dll'),
  (Resolve-FrameworkAssembly 'PresentationCore.dll'),
  (Resolve-FrameworkAssembly 'PresentationFramework.dll'),
  (Resolve-FrameworkAssembly 'System.Xaml.dll'),
  (Join-Path $LibDir 'Microsoft.Web.WebView2.Core.dll')
)

$missing = $refs | Where-Object { -not (Test-Path $_) }
if ($missing) { throw "Hiányzó referencia assembly: `n$($missing -join "`n")" }

# A running window locks its own exe, and rebuilding must not require closing the
# window the user is working in. When bin\DshWindow.exe cannot be written, the
# build lands next to it as DshWindow.exe.new and says so.
$ExeLocked = $false
if (Test-Path $Exe) {
  try {
    $probe = [System.IO.File]::Open($Exe, 'Open', 'ReadWrite', 'None')
    $probe.Close()
  }
  catch {
    $ExeLocked = $true
  }
}
$CompileTarget = if ($ExeLocked) { "$Exe.new" } else { $Exe }

$cscArgs = @(
  '-nologo', '-noconfig', '-target:winexe', '-platform:anycpu',
  '-langversion:7.3', '-optimize+', '-utf8output',
  "-out:$CompileTarget"
)
if (Test-Path $Icon) { $cscArgs += "-win32icon:$Icon" }
else { Write-Host "FIGYELEM: nincs $Icon, az ablak alapértelmezett ikonnal indul." }
$cscArgs += ($refs | ForEach-Object { "-r:$_" })
$cscArgs += $Src

Write-Host "Fordító : $csc"
Write-Host "WebView2: $wv2Core"
Write-Host "Kimenet : $CompileTarget"

& $csc @cscArgs 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { throw "A fordítás sikertelen (exit $LASTEXITCODE)." }

if (-not (Test-Path $CompileTarget)) { throw "A fordítás lefutott, de nem készült el: $CompileTarget" }

$info = Get-Item $CompileTarget
Write-Host ("KÉSZ    : {0} ({1:N0} byte)" -f $info.FullName, $info.Length)
if ($ExeLocked) {
  Write-Host ''
  Write-Host 'FIGYELEM: a futo ablak foglalja a bin\DshWindow.exe fajlt, ezert az uj valtozat'
  Write-Host "          ide kerult: $CompileTarget"
  Write-Host '          A hasznalathoz csukd be az ablakot, majd futtasd:'
  Write-Host '            Move-Item bin\DshWindow.exe.new bin\DshWindow.exe -Force'
}

# --- launcher exe ------------------------------------------------------------
# A Windows 11 csak valódi .exe célú parancsikont tűz ki a tálcára, ezért a
# tálcára szánt ikonok erre a kis indítóra mutatnak (nem a .cmd-re).
if (-not (Test-Path $LauncherSrc)) { throw "Hiányzó forrás: $LauncherSrc" }

$launcherRefs = @(
  (Resolve-FrameworkAssembly 'mscorlib.dll'),
  (Resolve-FrameworkAssembly 'System.dll'),
  (Resolve-FrameworkAssembly 'System.Core.dll'),
  (Resolve-FrameworkAssembly 'System.Windows.Forms.dll')
)

# Ugyanaz a zárolás-kezelés, mint a DshWindow.exe-nél: a launchert a tálcára
# tűzött ikon indítja, ezért előfordulhat, hogy épp fut a fordítás pillanatában.
$LauncherLocked = $false
if (Test-Path $LauncherExe) {
  try {
    $probe = [System.IO.File]::Open($LauncherExe, 'Open', 'ReadWrite', 'None')
    $probe.Close()
  }
  catch {
    $LauncherLocked = $true
  }
}
$LauncherTarget = if ($LauncherLocked) { "$LauncherExe.new" } else { $LauncherExe }

$launcherArgs = @(
  '-nologo', '-noconfig', '-target:winexe', '-platform:anycpu',
  '-langversion:7.3', '-optimize+', '-utf8output',
  "-out:$LauncherTarget"
)
if (Test-Path $Icon) { $launcherArgs += "-win32icon:$Icon" }
$launcherArgs += ($launcherRefs | ForEach-Object { "-r:$_" })
$launcherArgs += $LauncherSrc

& $csc @launcherArgs
if ($LASTEXITCODE -ne 0) { throw "Az indító fordítása sikertelen (exit $LASTEXITCODE)." }
if (-not (Test-Path $LauncherTarget)) { throw "Az indító nem készült el: $LauncherTarget" }

$linfo = Get-Item $LauncherTarget
Write-Host ("KÉSZ    : {0} ({1:N0} byte)" -f $linfo.FullName, $linfo.Length)
if ($LauncherLocked) {
  Write-Host ''
  Write-Host 'FIGYELEM: a futo indito foglalja a bin\DshLauncher.exe fajlt, ezert az uj valtozat'
  Write-Host "          ide kerult: $LauncherTarget"
  Write-Host '          A hasznalathoz csukd be az indítót, majd futtasd:'
  Write-Host '            Move-Item bin\DshLauncher.exe.new bin\DshLauncher.exe -Force'
}
