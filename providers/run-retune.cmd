@echo off
REM ============================================================================
REM  FIGYELEM - NE tedd be ezt a .cmd-t utemezett feladat muveletekent!
REM
REM  2026-10-28 MERT HIBA: a Task Scheduler a .cmd-hez LATHATO konzolablakot hoz
REM  letre (fekete cmd.exe), ez a shim pedig egy MASODIK, kek powershell.exe-t
REM  inditott -> ket ablak vette el a fokuszt 09:00:01-kor.
REM
REM  HELYES (utemezett feladat muvelete):
REM     wscript.exe //nologo "<providers>\run-retune-hidden.vbs" apply
REM  Regisztralas: providers\register-hidden-retune.ps1
REM  Szabaly: ..\AGENTS.md 1. fejezet.
REM
REM  Ez a fajl KIZAROLAG kezi, eloterbeli hasznalatra marad.
REM  %~dp0 a sajat mappa (trailing backslash), ezert a mappa mozgathato.
REM ============================================================================

set MODE=%~1
if "%MODE%"=="" set MODE=report

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0run-retune.ps1" -Mode %MODE%
exit /b %ERRORLEVEL%
