@echo off
REM ============================================================================
REM  A helyi fallback proxy (127.0.0.1:4123) ujrainditasa - kattinthato.
REM
REM  Miert .cmd: ezen a gepen a .ps1-hez nincs fajltarsitas, ezert dupla
REM  kattintasra csak az "Alkalmazas kivalasztasa" ablak jon fel.
REM
REM  Mire kell: a proxy a sajat kodjat csak indulasnal tolti be. A 2026-10-22-i
REM  javitas (nincs tobb globális settings.yaml cimke; a session-jelentes
REM  perzisztalasa a reports\session-targets.json-ba) csak ujrainditas utan
REM  lep eletbe.
REM ============================================================================
setlocal
set "PROV=%~dp0"
set "PS1=%PROV%run-proxy-service.ps1"

if not exist "%PS1%" (
  echo HIBA: nem talalom: %PS1%
  pause
  exit /b 1
)

echo 1/2  Proxy leallitasa...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Stop
ping -n 2 127.0.0.1 >nul

echo.
echo 2/2  Proxy inditasa (a friss proxy.mjs-sel)...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  echo Kesz: a proxy ujraindult a friss koddal.
) else if "%CODE%"=="2" (
  echo A proxy ELINDULT, de a worker-lancban nincs felhos cel.
  echo Ez a delegalast erinti, a panelenkenti Auto-cimket nem - ellenorizd a kulcsokat.
) else (
  echo HIBA ^(exit %CODE%^). Naplok: %PROV%proxy.out.log / %PROV%proxy.err.log
)
echo.
pause
exit /b %CODE%
