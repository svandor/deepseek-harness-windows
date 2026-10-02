@echo off
REM ============================================================================
REM  Kiadas: verzio + commit + tag + push + GitHub Release.
REM
REM  A .cmd azert kell, mert ezen a gepen a .ps1 nincs tarsitva semmihez: a dupla
REM  kattintas az "Alkalmazas kivalasztasa" ablakot nyitna a futtatas helyett.
REM
REM  Hasznalat:
REM    release.cmd                  patch kiadas (0.1.0 -> 0.1.1), kerdez
REM    release.cmd -Bump minor      kisebb verzio (0.1.0 -> 0.2.0)
REM    release.cmd -Version 1.0.0   kezzel megadott verzio
REM    release.cmd -DryRun          csak kiirja, mit tenne
REM    release.cmd -NoPush          commit + tag, push es Release nelkul
REM    release.cmd -Message "..."   a commit/tag/Release uzenetenek kiegeszitese
REM
REM  FIGYELEM: a szkript a git panelekhez hasonloan a TELJES repot commitolja
REM  (git add -A), ezert futtasd atnezett allapotban.
REM
REM  A szkript NEM -NonInteractive: a kiadas elott rakerdez (a -Yes kapcsoloval
REM  kerdes nelkul fut, ezt hasznalja a felulet gombja is).
REM ============================================================================

setlocal
set TOOLS=%~dp0

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOLS%release.ps1" %*
set CODE=%ERRORLEVEL%

echo.
if not "%CODE%"=="0" (
  echo HIBA: a kiadas nem sikerult ^(exit %CODE%^).
  echo A tag es a commit mar letrejohetett - ellenorizd: git log --oneline -3
) else (
  echo Kesz.
)

pause
endlocal
