# Házirobot — referencia-kép beszerzése a forrásvideóból.
#
# A YouTube a közvetlen videóletöltést 403-mal blokkolja (PO-token nélkül),
# ezért több kliens-változatot próbálunk sorban. Ha egyik sem megy, marad a
# storyboard (160x90) — azt a extract_storyboard.mjs állítja elő.
#
# Használat:  pwsh -File get_reference.ps1 -Url <youtube-url> [-Seconds 370,400]
param(
  [string]$Url = 'https://www.youtube.com/watch?v=0uU-R_fmt14',
  [int[]]$Seconds = @(370, 385, 400)
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$clients = @('web_safari', 'tv', 'ios', 'mweb', 'web_embedded', 'android_vr', 'web')

$videoFile = $null
foreach ($client in $clients) {
  $dir = Join-Path $root "dl-$client"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Output "--- proba: $client ---"
  & yt-dlp -f '18/worst[ext=mp4]' --no-warnings --no-playlist `
    --extractor-args "youtube:player_client=$client" `
    -o "$dir\v.%(ext)s" $Url 2>&1 | Select-Object -Last 2
  $f = Get-ChildItem "$dir\v.*" -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 100000 -and $_.Extension -ne '.part' } | Select-Object -First 1
  if ($f) {
    Write-Output "SIKER ($client): $($f.FullName) $([math]::Round($f.Length / 1MB, 1)) MB"
    $videoFile = $f.FullName
    break
  }
  Write-Output "nem sikerult: $client"
}

if (-not $videoFile) {
  Write-Output 'NINCS VIDEO — marad a storyboard (160x90).'
  exit 2
}

$frames = Join-Path $root 'frames'
python (Join-Path $root 'extract_frames.py') $videoFile $frames 2>&1 | Select-Object -First 20
Get-ChildItem $frames -Filter '*.png' | ForEach-Object { "kepkocka: $($_.FullName)" }
exit 0
