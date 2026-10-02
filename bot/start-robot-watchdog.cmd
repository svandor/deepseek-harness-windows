@echo off
REM ============================================================================
REM  Hazirobot panel - ORFOLYAM inditasa. Dupla kattintassal is lefut.
REM
REM  MIERT .cmd ES NEM .ps1:
REM  ezen a gepen a .ps1 nincs tarsitva semmilyen alkalmazashoz, ezert a dupla
REM  kattintas az "Alkalmazas kivalasztasa" ablakot nyitja a futtatas helyett.
REM  A .cmd-t a Windows a cmd.exe-hez tarsitja, ezert valoban lefut.
REM  Ugyanezert van a providers mappaban run-proxy.cmd / run-retune.cmd is.
REM
REM  MIT INDIT: az orfolyamot (watchdog-hazi-robot.ps1), ami az elso korben
REM  elinditja a panelt is, ha az nem fut, majd 60 masodpercenkent figyeli.
REM  Ezert ezzel a fajllal a panel ES az orfolyam is elindul.
REM
REM  Ezt NORMAAL (nem DSH-sandbox) ablakbol kell futtatni: a sandboxbol inditott
REM  folyamat a hivas vegen meghal.
REM ============================================================================

set BOTDIR=%~dp0
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%BOTDIR%start-robot-watchdog.ps1"
set CODE=%ERRORLEVEL%

echo.
if "%CODE%"=="0" (
  echo Az orfolyam fut. A robot panelje: http://127.0.0.1:4180/
) else (
  echo HIBA: az inditas nem sikerult ^(exit %CODE%^).
  echo Nezd meg: %BOTDIR%state\robot-watchdog.log
)
echo.
pause
