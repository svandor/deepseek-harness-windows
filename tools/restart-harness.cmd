@echo off
REM ============================================================================
REM  DeepSeek Harness ujrainditasa - kattinthato belepesi pont.
REM
REM  MIERT .cmd ES NEM .ps1:
REM  ezen a gepen a .ps1 nincs tarsitva semmilyen alkalmazashoz, ezert a dupla
REM  kattintas az "Alkalmazas kivalasztasa" ablakot nyitja a futtatas helyett.
REM  A .cmd-t a Windows a cmd.exe-hez tarsitja, ezert valoban lefut.
REM
REM  BARHONNAN FUTTATHATO - a DSH terminaljabol is.
REM  A szkript NEM maga inditja ujra a szervert: a kerest atadja a
REM  rendszertalca ikonnak, amely az egyetlen folyamat a DSH folyamatfajan
REM  kivul. Ha a talca nem fut, elinditja; ha az sem megy, WMI-vel indit egy
REM  levalasztott masolatot (a Win32_Process szolgaltatas gyermeke, ezert a
REM  hivo folyamatafanak kilovese sem eri el).
REM
REM  FIGYELEM: az ujrainditas MEGSZAKITJA a futo DSH-munkamenetet, es UJ tokent
REM  general. Az uj URL a futtatas vegen kiirva, es a state\harness.url
REM  fajlban lesz. Az ablak magatol az uj tokenre valt.
REM
REM  A robot panel (4180) FUGGETLEN ettol. Ha megis el:
REM    bot\start-robot-watchdog.cmd
REM
REM  Csak a keres leadasa (nem var):   restart-harness.cmd -NoWait
REM  A talcat kihagyva (WMI-vel):      restart-harness.cmd -Force
REM ============================================================================

setlocal
set TOOLS=%~dp0
set ROOT=%TOOLS%..

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%TOOLS%restart-harness.ps1" %*
set CODE=%ERRORLEVEL%

echo.
if not "%CODE%"=="0" (
  echo HIBA: az ujrainditas nem sikerult ^(exit %CODE%^).
  echo Naplok: %ROOT%\state\tray.log  es  %ROOT%\state\harness.err.log
  echo.
  pause
  endlocal
  exit /b %CODE%
)

set HURL=
if exist "%ROOT%\state\harness.url" for /f "usebackq delims=" %%u in ("%ROOT%\state\harness.url") do set HURL=%%u

echo Uj belepesi URL:
if "%HURL%"=="" (
  echo   FIGYELEM: nincs state\harness.url - a restart nem fejezodott be.
  echo   Nezd meg a talca naplojat: %ROOT%\state\tray.log
) else (
  echo   %HURL%
)

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%TOOLS%check-servers.ps1"

pause
endlocal
