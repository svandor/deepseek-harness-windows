@echo off
rem ---------------------------------------------------------------------------
rem  WMI Provider Host (wmiprvse) CPU-csillapito - INDITO.
rem  Dupla kattintas: a PowerShell szkript magat emeli (UAC-kerdes), mer,
rem  leallitja az MSI/DoSvc WMI-fogyasztokat, majd ujra mer.
rem  Reszletek: tools\wmi-calm.ps1 fejlece. Csak olvaso mod: wmi-calm.ps1 -Report
rem ---------------------------------------------------------------------------
setlocal
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
    start "" pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0wmi-calm.ps1" -SelfElevate
) else (
    start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0wmi-calm.ps1" -SelfElevate
)
exit /b 0
