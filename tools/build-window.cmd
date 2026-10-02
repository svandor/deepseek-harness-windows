@echo off
REM ============================================================================
REM  A DSH ablak (bin\DshWindow.exe) ujraforditasa futo ablak mellett.
REM
REM  A futo exe fajlt a Windows nem engedi felulirni, de ATNEVEZNI igen. Ezert a
REM  szkript atnevezi a futot, lefuttatja a build.ps1-et, es az uj exe a
REM  KOVETKEZO ablaknyitaskor lep eletbe. Forditasi hiba eseten visszaallitja a
REM  regit, hogy a talca tovabb mukodjon.
REM
REM  Az uj exe hasznalatahoz: talcaikon -> Ablak bezarasa, majd Megnyitas (ablak).
REM ============================================================================

setlocal
set TOOLS=%~dp0
set ROOT=%TOOLS%..

echo A DSH ablak ujraforditasa...
echo.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%TOOLS%build-window.ps1" %*
set CODE=%ERRORLEVEL%

echo.
if not "%CODE%"=="0" (
  echo HIBA: a forditas nem sikerult ^(exit %CODE%^). Az eredeti exe visszaallitva.
) else (
  echo Kesz. Az uj exe a KOVETKEZO ablaknyitaskor lep eletbe:
  echo   talcaikon: Ablak bezarasa, majd Megnyitas (ablak).
)

pause
endlocal
