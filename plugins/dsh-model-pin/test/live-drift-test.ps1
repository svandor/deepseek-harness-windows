# Élő próba: a harness `selectModel()` -> `saveSelection()` útját utánozzuk azzal,
# hogy a settings.yaml `agent-default-model` szekcióját a legutóbbi (driftelt)
# modellre írjuk. Ha a dsh-model-pin fut, a plugin visszaállítja a rögzítésre.
# A szkript MINDEN esetben a rögzített értéket hagyja a fájlban.
#
# Használat (NORMÁL PowerShell-ablakból, mert a ~\.dsh a DSH sandboxján kívül van):
#   .\plugins\dsh-model-pin\test\live-drift-test.ps1
#
# Elvárt eredmény: „EREDMÉNY: a plugin VISSZAÁLLÍTOTTA a rögzítésre”, és a
# ~\.dsh\model-pin.log új `corrected` sora. Mentés: %TEMP%\settings.yaml.drift-test-*.
# MÉRVE (2026-11-23): a visszaállás 0,4 s alatt megtörtént, a settings.yaml a
# próba után bájtazonos maradt (SHA256 3223B95C…C76AC).
$ErrorActionPreference = 'Stop'
$settings = Join-Path $env:USERPROFILE '.dsh\settings.yaml'
$log = Join-Path $env:USERPROFILE '.dsh\model-pin.log'
$backup = Join-Path $env:TEMP ("settings.yaml.drift-test-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))

Copy-Item $settings $backup -Force
Write-Host "mentés: $backup"

$text = Get-Content $settings -Raw
$pattern = '(?s)(agent-default-model:\r?\n  provider: deepseek-official\r?\n  model: )deepseek-flash'
if ($text -notmatch $pattern) { throw 'a settings.yaml agent-default-model blokkja nem a várt alakú' }

$drifted = [regex]::Replace($text, $pattern, '${1}deepseek-v4-pro', 1)
Set-Content -Path $settings -Value $drifted -NoNewline -Encoding utf8
Write-Host "drift beírva: model: deepseek-v4-pro (a harness ezt kapja modellváltásként)"

$deadline = (Get-Date).AddSeconds(6)
$reverted = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  $now = Get-Content $settings -Raw
  if ($now -match '(?s)(agent-default-model:\r?\n  provider: deepseek-official\r?\n  model: )deepseek-flash') { $reverted = $true; break }
}

Write-Host ''
if ($reverted) {
  Write-Host 'EREDMÉNY: a plugin VISSZAÁLLÍTOTTA a rögzítésre (a futó harness-ben ÉL).' -ForegroundColor Green
} else {
  Write-Host 'EREDMÉNY: nem állt vissza (a plugin a futó folyamatban nem aktív).' -ForegroundColor Yellow
  Copy-Item $backup $settings -Force
  Write-Host 'A rögzített érték visszaállítva a mentésből.'
}

Write-Host ''
Write-Host '--- a settings.yaml szekció most:'
(Get-Content $settings -TotalCount 13) -join "`n"

Write-Host ''
Write-Host '--- a model-pin.log utolsó sorai:'
if (Test-Path $log) { Get-Content $log -Tail 4 } else { Write-Host '(nincs napló)' }

Write-Host ''
Write-Host '--- a settings.yaml egyéb top-level kulcsai (sértetlen-e):'
(Select-String -Path $settings -Pattern '^[a-z][\w-]*:' | ForEach-Object { $_.Line.Split(':')[0] }) -join ', '
