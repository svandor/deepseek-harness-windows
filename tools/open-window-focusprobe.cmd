@echo off
rem Diagnosztikai inditas: a javitott DSH ablak reszletes fokusz-naplozassal.
rem 1) zarj be minden DSH ablakot (talca -> Bezaras)
rem 2) futtasd ezt a fajlt (dupla kattintas)
rem 3) reprodukald: irj a 2. panelbe, Alt+Tab, vissza
rem A naplo: state\focus-probe\probe-*.log  es  state\window.log
setlocal
set "ROOT=%~dp0.."
set "EXE=%ROOT%\bin\DshWindow.exe"
if not exist "%EXE%" (
  echo Nincs meg a bin\DshWindow.exe
  pause
  exit /b 1
)
set "TOKEN="
for /f "usebackq delims=" %%t in (`powershell.exe -NoProfile -Command "try{(Get-Content -Raw '%ROOT%\state\harness.url').Trim()}catch{''}"`) do set "TOKEN=%%t"
if "%TOKEN%"=="" (
  start "" "%EXE%" --port 3080 --panes 3 --width 1400 --height 900 --x 40 --y 40 --focus-probe --log "%ROOT%\state\focus-probe\window.log" --icon "%ROOT%\assets\dsh.ico" --pane-url 3=http://127.0.0.1:4180/
) else (
  start "" "%EXE%" --port 3080 --panes 3 --width 1400 --height 900 --x 40 --y 40 --focus-probe --log "%ROOT%\state\focus-probe\window.log" --icon "%ROOT%\assets\dsh.ico" --url "%TOKEN%" --pane-url 3=http://127.0.0.1:4180/
)
echo Elindult a diagnosztikai ablak. Reprodukald a hibat, majd jelezd.
