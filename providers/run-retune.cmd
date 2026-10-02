@echo off
REM Entry point for the monthly scheduled task (schtasks /TR calls this).
REM
REM Why a .cmd shim: the schtasks /TR value is limited to 261 characters and
REM the install path contains a space, which breaks quote escaping. A shim
REM solves both and stays readable in Task Scheduler.
REM
REM %~dp0 is this file's own directory (with trailing backslash), so the
REM correct path is used even if the folder is moved.

set MODE=%~1
if "%MODE%"=="" set MODE=report

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0run-retune.ps1" -Mode %MODE%
exit /b %ERRORLEVEL%
