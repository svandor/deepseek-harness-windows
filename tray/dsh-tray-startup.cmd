@echo off
rem DeepSeek Harness - rendszertalcai icon inditasa ablak nelkul.
rem Ezt erdemes a bejelentkezeskori inditashoz (shell:startup) hasznalni.
setlocal
set "HERE=%~dp0"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%HERE%dsh-tray.ps1" -NoWindow
endlocal
