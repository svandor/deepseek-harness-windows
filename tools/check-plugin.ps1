$root = 'C:\Szerver\Deepseek Harness'
$base = 'http://127.0.0.1:3080'

$url = (Get-Content (Join-Path $root 'state\harness.url') -Raw -ErrorAction SilentlyContinue)
if (-not $url) { Write-Output 'NINCS harness.url'; exit 1 }
$url = $url.Trim()
$token = ($url -split 'token=')[1].Trim()

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try { Invoke-WebRequest "$base/?token=$token" -UseBasicParsing -WebSession $session -TimeoutSec 10 | Out-Null }
catch { Write-Output "token csere hiba: $($_.Exception.Message)" }
$auth = $session.Cookies.GetCookies($base) | Where-Object { $_.Name -like 'dsh-auth-*' } | Select-Object -First 1
if (-not $auth) { Write-Output 'NINCS auth suti'; exit 1 }

$html = $null
try { $r = Invoke-WebRequest "$base/" -UseBasicParsing -WebSession $session -TimeoutSec 10; $html = $r.Content }
catch { Write-Output "index hiba: $($_.Exception.Message)" }

if ($html) {
  Write-Output ("index hossz: {0}" -f $html.Length)
  if ($html -match 'dsh-ui-extras') { Write-Output '*** dsh-ui-extras BENNE VAN az indexben ***' } else { Write-Output 'dsh-ui-extras nincs az indexben' }
  if ($html -match 'Failed to load plugins') { Write-Output '*** BOOT HIBA az indexben ***' }
  $scripts = [regex]::Matches($html, '(?:src|href)="([^"]*plugins[^"]*)"') | ForEach-Object { $_.Groups[1].Value }
  if ($scripts) { Write-Output 'plugin URL-ek az indexben:'; $scripts | Select-Object -First 12 | ForEach-Object { "  $_" } }
  else { Write-Output 'nincs plugins URL az indexben' }
  $m = [regex]::Match($html, '__ModuleLoader__|__DSH_BOOT__')
  Write-Output ("boot jel: {0}" -f $(if ($m.Success) { $m.Value } else { 'nincs' }))
}
