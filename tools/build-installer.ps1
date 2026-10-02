<#
.SYNOPSIS
  Nyilvános kiadási csomagok készítése: portable ZIP és önálló telepítő EXE.

.DESCRIPTION
  Két csomag készül a dist\ mappába:

    * DeepSeek-Harness-<verzió>-portable.zip
        A teljes munkaterület. Bárhová kicsomagolható (a program a saját helyéhez
        képest keresi az állapotfájljait), majd az install.cmd / install.ps1
        elhelyezi a parancsikonokat.

    * DeepSeek-Harness-Setup-<verzió>.exe
        Önálló telepítő: a ZIP-et beágyazva viszi, kibontja a célmappába
        (alapból %LOCALAPPDATA%\DeepSeekHarness), ellenőrzi a Node.js és a
        WebView2 meglétét, és lefuttatja az install.ps1-ét. Nem kell hozzá
        Inno Setup vagy NSIS: a projekt saját Roslyn csc.exe-je fordítja
        (src\Setup.cs).

  CSAK a git által követett fájlok kerülnek a csomagba: a state\, a node_modules,
  a .git és minden .gitignore-olt maradvány kimarad. Ezért a csomag nem
  szivárogtathat fejlesztői állapotot vagy titkot.

.PARAMETER OutDir
  A kimeneti mappa. Alapértelmezés: dist.

.PARAMETER NoExe
  Csak a portable ZIP készüljön el.

.PARAMETER NoZip
  Csak a telepítő EXE készüljön el.

.EXAMPLE
  .\tools\build-installer.ps1
  .\tools\build-installer.ps1 -OutDir C:\temp\kiadas
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'dist',
  [switch]$NoExe,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$version = (Get-Content (Join-Path $root 'VERSION') -Raw -ErrorAction SilentlyContinue)
if (-not $version) { $version = '0.0.0' }
$version = $version.Trim()

$outPath = Join-Path $root $OutDir
$stage = Join-Path $outPath 'stage'
$zipName = "DeepSeek-Harness-$version-portable.zip"
$exeName = "DeepSeek-Harness-Setup-$version.exe"
$zipPath = Join-Path $outPath $zipName
$exePath = Join-Path $outPath $exeName

Write-Host "DeepSeek Harness csomagolas (verzio $version)"
Write-Host "Kimenet: $outPath"
Write-Host ''

# A korábbi kiadások csomagjai ne maradjanak a kimeneti mappában: a kiadás
# feltöltő lépése verzió szerint szűr, de a félrevezető maradvány így sem jó.
Get-ChildItem $outPath -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'DeepSeek-Harness-*.zip' -or $_.Name -like 'DeepSeek-Harness-Setup-*.exe' } |
  Remove-Item -Force -ErrorAction SilentlyContinue

# --- 1) stagelés: csak a KÖVETETT fájlok --------------------------------------
# MIÉRT git ls-files: ez a .gitignore-t is tiszteletben tartja, ezért a state\,
# a node_modules, a naplók és a titkok soha nem kerülnek a csomagba.
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$tracked = & git -C $root ls-files
if ($LASTEXITCODE -ne 0 -or -not $tracked) { throw 'A git ls-files nem adott fajllistat.' }

$copied = 0
foreach ($rel in $tracked) {
  $src = Join-Path $root $rel
  if (-not (Test-Path $src -PathType Leaf)) { continue }
  $dst = Join-Path $stage $rel
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
  Copy-Item -LiteralPath $src -Destination $dst -Force
  $copied++
}
Write-Host "[1/3] Stagelve: $copied fajl (a git altal kovetett halmaz)."

# A VERSION és a LICENSE mindenkepp legyen benne, akkor is, ha meg nincs commitolva.
foreach ($extra in @('VERSION', 'LICENSE', 'README.md', 'README.en.md', 'install.ps1', 'install.cmd')) {
  $src = Join-Path $root $extra
  if ((Test-Path $src) -and -not (Test-Path (Join-Path $stage $extra))) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $stage $extra) -Force
    Write-Host "      kiegeszitve: $extra"
  }
}

# --- 2) portable ZIP ----------------------------------------------------------
if (-not $NoZip) {
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
  $zipInfo = Get-Item $zipPath
  Write-Host ("[2/3] Portable ZIP: {0} ({1:N1} MB)" -f $zipName, ($zipInfo.Length / 1MB))
}
else {
  Write-Host '[2/3] Portable ZIP: kihagyva (-NoZip).'
}

# --- 3) telepítő EXE ----------------------------------------------------------
if (-not $NoExe) {
  $cscCandidates = @(
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
    'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe',
    'C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe',
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  )
  $csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $csc) { throw 'Nem talalhato C# fordito (Roslyn csc.exe). Telepitsd a VS Build Tools "MSBuild" komponenset.' }

  $srcFile = Join-Path $root 'src\Setup.cs'
  if (-not (Test-Path $srcFile)) { throw "Hianyzik: $srcFile" }

  # A beágyazott csomag: a stagelt fa ZIP-je. A Setup.cs ezt a `payload.zip`
  # nevű erőforrást keresi, ezért a nevet pontosan így adjuk át.
  $payload = Join-Path $outPath 'payload.zip'
  if (Test-Path $payload) { Remove-Item $payload -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $payload -CompressionLevel Optimal

  $icon = Join-Path $root 'assets\dsh.ico'
  $cscArgs = @(
    '-nologo', '-noconfig', '-target:exe', '-platform:anycpu', '-langversion:7.3',
    "-out:$exePath",
    "-resource:$payload,payload.zip",
    '-r:System.dll', '-r:System.Core.dll', '-r:System.Windows.Forms.dll',
    '-r:System.IO.Compression.dll', '-r:System.IO.Compression.FileSystem.dll',
    $srcFile
  )
  if (Test-Path $icon) { $cscArgs = @('-win32icon:' + $icon) + $cscArgs }

  Write-Host "[3/3] Fordito: $csc"
  $output = & $csc @cscArgs 2>&1
  $output | Where-Object { $_ } | ForEach-Object { Write-Host "      $_" }
  if (-not (Test-Path $exePath)) { throw "A telepito nem keszult el: $exePath" }

  Remove-Item $payload -Force -ErrorAction SilentlyContinue
  $exeInfo = Get-Item $exePath
  Write-Host ("      Telepito EXE: {0} ({1:N1} MB)" -f $exeName, ($exeInfo.Length / 1MB))
}
else {
  Write-Host '[3/3] Telepito EXE: kihagyva (-NoExe).'
}

# --- összegzés ----------------------------------------------------------------
Write-Host ''
Write-Host 'Kesz. A csomagok:'
if (Test-Path $zipPath) {
  Write-Host ("  {0}  ({1:N1} MB)" -f $zipPath, ((Get-Item $zipPath).Length / 1MB))
  Write-Host '     Kicsomagolas utan: install.cmd   (parancsikonok)'
}
if (Test-Path $exePath) {
  Write-Host ("  {0}  ({1:N1} MB)" -f $exePath, ((Get-Item $exePath).Length / 1MB))
  Write-Host '     Dupla kattintas: telepit.  /? a kapcsolokhoz, /uninstall az eltavolitashoz.'
}
Write-Host ''
Write-Host "A staging mappa meghagyva ellenorzeshez: $stage"
