@echo off
REM ============================================================================
REM  A "HaziRobot due" utemezett feladat atallitasa REJTETT (VBS) inditora.
REM
REM  Miert .cmd es nem .ps1: ezen a gepen a .ps1-hez nincs fajltarsitas, ezert
REM  dupla kattintasra csak a Windows "Alkalmazas kivalasztasa" ablaka jon fel.
REM  Ez a .cmd PowerShell alatt futtatja a szkriptet, es a vegén nyitva tartja
REM  az ablakot, hogy latod az eredmenyt.
REM
REM  Hasznalat:  kattints duplan erre a fajlra
REM              (vagy: Win+R -> cmd /c "C:\Szerver\Deepseek Harness\bot\register-hidden-task.cmd")
REM
REM  Ha "Access is denied" jon: jobb klikk -> "Futtatas rendszergazdakent".
REM ============================================================================
setlocal
set "PS1=%~dp0register-hidden-task.ps1"

if not exist "%PS1%" (
  echo HIBA: nem talalom: %PS1%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  echo Kesz. A feladat mostantol wscript.exe-vel indul, ami NEM hoz letre konzolablakot.
  echo A kovetkezo 15 perces futasnal mar nem ugorhat fel ablak.
) else (
  echo HIBA ^(exit %CODE%^).
  echo Ha "Access is denied" volt: jobb klikk a .cmd-re - "Futtatas rendszergazdakent".
  echo Ha CIM-hiba volt: ezt a .cmd-t NORMAl PowerShell-bol kell futtatni, nem a DSH
  echo terminaljabol ^(a DSH sandboxa nem eri el a Task Schedulert^).
)
echo.
pause
exit /b %CODE%
