@echo off
rem DeepSeek Harness - az ablak megnyitasa (a rendszertalcai ikon bekapcsolasaval).
rem Ugyanaz, mint az asztali indito: ha mar fut a talca, csak az ablak nyilik.
setlocal
set "HERE=%~dp0"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%HERE%dsh-tray.ps1" -OpenWindow
endlocal
