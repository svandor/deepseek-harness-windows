<#
.SYNOPSIS
  Előállítja az ablak- és tálcaikonokat a frontend favicon.svg-jéből (WPF-fel).

.DESCRIPTION
  A dsh csomagokhoz adott .ico fájlok PNG-tömörített frame-eket tartalmaznak,
  amiket a .NET/GDI+ hibásan olvas be, ezért az SVG útvonalából közvetlenül
  raszterizálunk WPF-fel (nincs szükség böngészőre vagy külső eszközre), majd
  több méretű .ico-t építünk:
    assets\dsh.ico      - fehér bálna (sötét címsoron és tálcán jól látszik)
    assets\dsh-off.ico  - szürke bálna (a GUI áll)
#>
[CmdletBinding()]
param(
  [string]$SvgPath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase, System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$assets = Join-Path $root 'assets'
$tmp = Join-Path $root '.tmp-icons'
New-Item -ItemType Directory -Force -Path $assets, $tmp | Out-Null

if (-not $SvgPath) {
  $candidates = @(
    '$env:LOCALAPPDATA\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\dsh-web-frontend\dist\favicon.svg',
    (Join-Path $root 'node_modules\@deepseek-ai\dsh-web-frontend\dist\favicon.svg')
  )
  $SvgPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $SvgPath -or -not (Test-Path $SvgPath)) { throw 'Nem találom a favicon.svg-t. Add meg a -SvgPath kapcsolóval.' }

[xml]$svg = Get-Content $SvgPath -Raw -Encoding UTF8
$pathNode = $svg.svg.path
if (-not $pathNode) { throw "Az SVG nem tartalmaz <path> elemet: $SvgPath" }
$data = $pathNode.d
if (-not $data) { throw "Az SVG <path> elemében nincs d attribútum: $SvgPath" }

# A viewBox adja a léptéket (a fájlban 0 0 50 50).
$viewBox = @(0, 0, 50, 50)
if ($svg.svg.viewBox) {
  $parts = $svg.svg.viewBox -split '[ ,]+' | Where-Object { $_ -ne '' } | ForEach-Object { [double]$_ }
  if ($parts.Count -eq 4) { $viewBox = $parts }
}
$vbW = $viewBox[2]
$vbH = $viewBox[3]

function New-Raster {
  param([string]$Fill, [int]$Size, [string]$OutPng)

  $geometry = [System.Windows.Media.Geometry]::Parse($data)
  if ($geometry.IsEmpty()) { throw 'A <path> adat nem értelmezhető geometriaként.' }

  $visual = New-Object System.Windows.Media.DrawingVisual
  $dc = $visual.RenderOpen()
  $scale = $Size / $vbW
  $transform = New-Object System.Windows.Media.ScaleTransform($scale, $scale)
  $brush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($Fill))
  $dc.PushTransform($transform)
  $dc.DrawGeometry($brush, $null, $geometry)
  $dc.Pop()
  $dc.Close()

  $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap($Size, $Size, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
  $rtb.Render($visual)

  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
  $stream = [System.IO.File]::Create($OutPng)
  try { $encoder.Save($stream) } finally { $stream.Close() }
}

function New-Ico {
  param([string]$SourcePng, [int[]]$Sizes, [string]$OutIco)

  $images = @()
  foreach ($size in $Sizes) {
    $resized = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($resized)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $src = [System.Drawing.Image]::FromFile($SourcePng)
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose(); $src.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += , @{ Size = $size; Bytes = $ms.ToArray() }
    $ms.Dispose(); $resized.Dispose()
  }

  $stream = [System.IO.File]::Create($OutIco)
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([uint16]0)                  # reserved
  $writer.Write([uint16]1)                  # type: icon
  $writer.Write([uint16]$images.Count)
  $offset = 6 + (16 * $images.Count)
  foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $writer.Write([byte]$dim)               # width (0 = 256)
    $writer.Write([byte]$dim)               # height
    $writer.Write([byte]0)                  # palette count
    $writer.Write([byte]0)                  # reserved
    $writer.Write([uint16]1)                # color planes
    $writer.Write([uint16]32)               # bits per pixel
    $writer.Write([uint32]$img.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $img.Bytes.Length
  }
  foreach ($img in $images) { $writer.Write($img.Bytes) }
  $writer.Flush(); $writer.Close(); $stream.Close()
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$whitePng = Join-Path $tmp 'whale-white-256.png'
$greyPng = Join-Path $tmp 'whale-grey-256.png'
New-Raster -Fill '#ffffff' -Size 256 -OutPng $whitePng
New-Raster -Fill '#9aa0a6' -Size 256 -OutPng $greyPng

New-Ico -SourcePng $whitePng -Sizes $sizes -OutIco (Join-Path $assets 'dsh.ico')
New-Ico -SourcePng $greyPng -Sizes $sizes -OutIco (Join-Path $assets 'dsh-off.ico')

foreach ($f in @('dsh.ico', 'dsh-off.ico')) {
  $p = Join-Path $assets $f
  Write-Output ("{0}: {1:N0} byte" -f $p, (Get-Item $p).Length)
}

# Előnézet sötét háttéren, hogy szemmel is ellenőrizhető legyen.
$preview = New-Object System.Drawing.Bitmap(280, 280)
$g = [System.Drawing.Graphics]::FromImage($preview)
$g.Clear([System.Drawing.Color]::FromArgb(21, 21, 23))
$src = [System.Drawing.Image]::FromFile($whitePng)
$g.DrawImage($src, 12, 12, 256, 256)
$g.Dispose(); $src.Dispose()
$previewPath = Join-Path $tmp 'preview.png'
$preview.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()
Write-Output "előnézet: $previewPath"
