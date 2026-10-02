@echo off
REM ============================================================================
REM  A DeepSeek Harness rendszertalca-ikonjanak ujrainditasa (frissites utan).
REM
REM  MIERT .cmd: ezen a gepen a .ps1 nincs tarsitva semmihez, ezert a dupla
REM  kattintas az "Alkalmazas kivalasztasa" ablakot nyitja. A .cmd-hez a Windows
REM  a cmd.exe-t tarsitja, ezert valoban lefut.
REM
REM  MIT TESZ: leallitja a talca programjat, es elinditja az ujat a frissitett
REM  tray\dsh-tray.ps1-bol. AZ ABLAK ES A HATTER-GUI FUTVA MARAD - csak a talca
REM  programja cserelodik. Ugyanezt teszi a talca menujenek
REM  "A talca ujrainditasa" pontja (az mar a frissitett kodban van).
REM
REM  Ezt NORMAL ablakbol erdemes futtatni (a WMI-inditas ott mindig elerheto).
REM ============================================================================

setlocal
set TOOLS=%~dp0
set ROOT=%TOOLS%..

echo A rendszertalca-ikon ujrainditasa...
echo.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%TOOLS%restart-tray.ps1" %*
set CODE=%ERRORLEVEL%

echo.
if not "%CODE%"=="0" (
  echo HIBA: a talca ujrainditasa nem sikerult ^(exit %CODE%^).
  echo Nezd meg: %ROOT%\state\tray.log
) else (
  echo Kesz. Az ablak es a hatter-GUI valtozatlanul fut.
)

pause
endlocal
