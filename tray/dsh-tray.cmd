@echo off
rem DeepSeek Harness - asztali / talcara kituzheto indito.
rem Ha a rendszertalcai icon mar fut, az ablakot nyitja meg (nem ad hibat);
rem ha meg nem fut, elinditja a talcat es megnyitja az ablakot.
setlocal
set "HERE=%~dp0"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%HERE%dsh-tray.ps1" -OpenWindow
endlocal
