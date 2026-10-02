@echo off
REM ============================================================================
REM  Hazirobot - allapot ellenorzese egy kattintassal (nem indit semmit).
REM
REM  Ez a "nem valaszol a robot" tunet diagnosztikaja: megmondja, hogy a panel,
REM  a fallback proxy es az orfolyam fut-e. Ha mindharom rendben, a robot
REM  valaszol; ha a proxy all, a /parancsok mennek, de a beszelgetes nem.
REM
REM  .cmd, nem .ps1 - mert ezen a gepen a .ps1 nincs tarsitva alkalmazashoz,
REM  ezert a dupla kattintas nem futtatna le.
REM
REM  ASCII-only es CRLF sorvegek: a cmd.exe igy ertelmezi biztosan.
REM ============================================================================

setlocal
set BOTDIR=%~dp0

echo === Hazirobot allapot ===
echo.

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $s = Invoke-RestMethod 'http://127.0.0.1:4180/status.json' -TimeoutSec 5; Write-Host ('panel  (4180): OK   e-mail cimzett: ' + ((($s.bot.emailTo) -join ',') -replace '^$','nincs') + '   szaraz futas: ' + $s.bot.emailDryRun) -ForegroundColor Green } catch { Write-Host 'panel  (4180): NEM VALASZOL - a robot nem fog valaszolni' -ForegroundColor Red }"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod 'http://127.0.0.1:4123/healthz' -TimeoutSec 5 | Out-Null; Write-Host 'proxy  (4123): OK   a beszelgetes megy' -ForegroundColor Green } catch { Write-Host 'proxy  (4123): NEM VALASZOL - a /parancsok mennek, a beszelgetes nem' -ForegroundColor Yellow }"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$f = '%BOTDIR%state\robot-watchdog.pid'; if (Test-Path $f) { $wd = (Get-Content $f -Raw).Trim(); if (Get-Process -Id $wd -ErrorAction SilentlyContinue) { Write-Host ('orfolyam       : OK   (PID ' + $wd + ')') -ForegroundColor Green } else { Write-Host ('orfolyam       : NEM EL - a PID fajl (' + $wd + ') elavult. Futtasd: start-robot-watchdog.cmd') -ForegroundColor Yellow } } else { Write-Host 'orfolyam       : nincs. Futtasd: start-robot-watchdog.cmd' -ForegroundColor Yellow }"

echo.
echo Panel a bongeszoben: http://127.0.0.1:4180/
echo.
pause
