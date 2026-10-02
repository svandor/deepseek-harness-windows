@echo off
REM ============================================================================
REM  DeepSeek Harness - telepites a kicsomagolt (portable) csomagbol.
REM
REM  MIT TESZ: parancsikonokat keszit az asztalra es a Start menube, hogy az
REM  indito ugy viselkedjen, mint egy normalis alkalmazas (es a t?lc?ra is
REM  kit?zhet? legyen). A fajlokat NEM masolja: a program a sajat helyerol fut.
REM
REM  Ha a DeepSeek-Harness-Setup-*.exe-t futtattad, ez a lepes mar megtortent.
REM
REM  Kapcsolok:
REM    install.cmd                 asztali + Start menu ikon
REM    install.cmd -AutoStart      + bejelentkezeskori inditas
REM    install.cmd -RemoveAutoStart
REM    install.cmd -NoShortcut     csak a bejelentkezeskori beallitas
REM
REM  Eltavolitas: torold a mappat es a ket parancsikont (asztal, Start menu).
REM ============================================================================

setlocal
set ROOT=%~dp0

where node >NUL 2>NUL
if errorlevel 1 (
  echo FIGYELEM: a Node.js nem talalhato a PATH-on.
  echo           A hatter-GUI nem indul el nelkule. Telepites: https://nodejs.org/
  echo.
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%install.ps1" -PinToTaskbar %*
set CODE=%ERRORLEVEL%

echo.
if not "%CODE%"=="0" (
  echo HIBA: a telepites nem sikerult ^(exit %CODE%^).
) else (
  echo Kesz. Inditas: az asztali "DeepSeek Harness" ikon.
  echo A t?lc?ra tuzes: jobb klikk az ikonra -^> Megjelenites tovabbi beallitasok
  echo                    -^> Kit?zes a talcara.
)
echo.
pause
endlocal
