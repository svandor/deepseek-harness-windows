@echo off
REM ============================================================================
REM  Egyszeri atallitas: a retune feladat NAPI utemrol HETI utemre.
REM
REM  Ezt a "DSH retune cadence weekly" nevu, egyszer futo feladat hivja meg
REM  7 nappal a napi utem beallitasa utan, majd torli magat (/Z).
REM
REM  A PowerShell -ExecutionPolicy Bypass kell, kulonben a .ps1 nem fut le
REM  felugyelet nelkul.
REM ============================================================================

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0schedule-retune.ps1" -Cadence Weekly
exit /b %ERRORLEVEL%
