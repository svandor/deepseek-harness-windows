@echo off
REM ============================================================================
REM  Teljes frissites: rendszertalca + DeepSeek Harness ujrainditasa.
REM
REM  MIERT VAN EZ: ket lepes kell a friss kodhoz, es a sorrend szamit.
REM    1) a TALCA a sajat kodjat a folyamat indulasakor tolti be, ezert a
REM       javitott tray\dsh-tray.ps1 csak ujrainditassal lep eletbe;
REM    2) a HARNESS a host-oldali utvonalakat (pl. theme-sync / robot-theme)
REM       szinten csak indulaskor tolti be.
REM  Ha a sorrend forditott, a regi talca veszi at a kereset - ezert elobb
REM  mindig a talca ujul meg.
REM
REM  Ezt NORMAL ablakbol futtasd (a talca WMI-inditasa ott mindig elerheto).
REM  A DSH terminaljabol is mukodik, de ott a harness ujraindulasa megszakithatja
REM  ezt az ablakot - a munka ilyenkor is a talcan at fejezodik be.
REM
REM  AZ ABLAK ES A HATTER-GUI A TALCA-LEPESBEN FUTVA MARAD; csak a harness
REM  lepes general uj belepesi tokent.
REM ============================================================================

setlocal
set TOOLS=%~dp0
set ROOT=%TOOLS%..

echo ============================================================
echo  1/2  A rendszertalca ujrainditasa (friss kod)
echo ============================================================
call "%TOOLS%restart-tray.cmd"
set TRAYCODE=%ERRORLEVEL%

echo.
echo ============================================================
echo  2/2  A DeepSeek Harness ujrainditasa
echo ============================================================
call "%TOOLS%restart-harness.cmd"
set HCODE=%ERRORLEVEL%

echo.
echo ============================================================
echo  Osszegzes
echo ============================================================
if "%TRAYCODE%"=="0" (echo   talca  : OK) else (echo   talca  : HIBA ^(exit %TRAYCODE%^))
if "%HCODE%"=="0" (echo   harness: OK) else (echo   harness: HIBA ^(exit %HCODE%^))
echo.
if not "%TRAYCODE%"=="0" echo Nezd meg: %ROOT%\state\tray.log
if not "%HCODE%"=="0" echo Nezd meg: %ROOT%\state\harness.err.log

pause
endlocal
