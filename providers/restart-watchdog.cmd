@echo off
REM ============================================================================
REM  WATCHDOG UJRINDITAS  (2026-10-21)
REM ============================================================================
REM  Miert kell: a Run kulcsban levo indító (start-watchdog.cmd -> wscript ->
REM  start-watchdog-hidden.vbs) rejtett PowerShell-ciklust indit, ami 60 s-enkent
REM  figyeli a proxy /healthz-jet, es kieses eseten ujrainditja a
REM  run-proxy-service.ps1-gyel. A ciklus azonban BERAGADHAT: a log utolso
REM  bejegyzese 2026-10-21T12:50:40 "SIKERTELEN ujrainditas (#2)", es azota
REM  nincs uj proba — vagyis a watchdog el, de nem csinal semmit.
REM
REM  Ez a fajl: 1) leallitja a pidfajlban rogzitett regi ciklust,
REM             2) elindit egy ujat rejtve (a vbs "mar fut?" ellenorzese miatt
REM                a pidfajlt elotte torolni kell).
REM
REM  Hasznalat: kattints ra, vagy:  providers\restart-watchdog.cmd
REM  Ellenorzes: providers\reports\proxy-watchdog.log  es  reports\proxy-watchdog.pid
REM ============================================================================
setlocal
set "ROOT=%~dp0"
set "PIDFILE=%ROOT%reports\proxy-watchdog.pid"

if exist "%PIDFILE%" (
  for /f "usebackq delims=" %%p in ("%PIDFILE%") do (
    echo Regi watchdog PID: %%p
    taskkill /PID %%p /F >nul 2>&1
  )
  del "%PIDFILE%" >nul 2>&1
) else (
  echo Nem volt pidfajl — tiszta inditas.
)

start "" wscript.exe "%ROOT%start-watchdog-hidden.vbs"
echo.
echo Watchdog ujraindítva (rejtve). A proxy a 4123 porton marad, amíg él.
echo Naplo: %ROOT%reports\proxy-watchdog.log
timeout /t 4 >nul
