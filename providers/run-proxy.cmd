@echo off
REM ============================================================================
REM  A subagent fallback proxy inditasa (bejelentkezeskor).
REM
REM  Miert kell: az automatikus subagent-uzem a proxyra mutat. Ha a proxy nem
REM  fut, a gyermek MINDEN hivasa elhal (a szulo nem). Ezert gondoskodni kell
REM  rola, hogy a proxy a bejelentkezes utan elinduljon.
REM
REM  A valodi provider-kulcsokat a ~/.dsh/.credentials.yaml-bol olvassa,
REM  ezert nem kell oket sehol mashol tarolni.
REM ============================================================================

set PROXYDIR=%~dp0
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0run-proxy-service.ps1"
