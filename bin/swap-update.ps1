$src = 'C:\Szerver\Deepseek Harness\bin\DshWindow.exe.new'
$dst = 'C:\Szerver\Deepseek Harness\bin\DshWindow.exe'
for ($n = 0; $n -lt 2020; $n++) {
  try {
    if (Test-Path $src) {
      Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
      exit 0
    }
    exit 0
  } catch {
    Start-Sleep -Milliseconds 1500
  }
}
$log = Join-Path (Split-Path -Parent $src) 'swap-failed.log'
"build: could not replace DshWindow.exe after 50 minutes; source still at $src" | Set-Content -LiteralPath $log -Encoding UTF8
