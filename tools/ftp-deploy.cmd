@echo off
rem FTP deploy CLI — a panel es a gyorsgomb ugyanezt a motort hivja (CLI = UI).
rem Hasznalat: tools\ftp-deploy.cmd profiles
rem             tools\ftp-deploy.cmd preview --profile TGYO-L12
rem             tools\ftp-deploy.cmd push --profile TGYO-L12 --confirm
setlocal
set "ROOT=%~dp0.."
node "%ROOT%\tools\ftp-deploy.mjs" %*
exit /b %ERRORLEVEL%
