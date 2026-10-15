@echo off
REM ============================================================================
REM  AUTOTUNE - automatikus ujrameres es optimalizalas (heti).
REM
REM  Mit tesz (providers\autotune.mjs --apply):
REM    1. a valos session-naplokbol ujramer (keresmeret, cache-arany, kimenet,
REM       lepesek, porgo-munka aranya, celonkenti koltseg),
REM    2. a MERT ertekekbol ujraszamolja a szelektor hangolasi parametereit es
REM       alkalmazza a config.json-ban,
REM    3. ellenorzi az elo provider-katalogusokat (el-e minden cel),
REM    4. osszeveti a gyari arlistat a config pricing tabljaval (arat NEM ir),
REM    5. riportot es trendet ir a providers\reports mappaba.
REM
REM  A proxy a config.json valtozasat HOT-RELOADDAL veszi at - restart nem kell.
REM  Arat csak kezzel: node autotune.mjs --apply-prices (ellenorzes utan).
REM
REM  FONTOS: ez a fajl SZANDEKOSAN csak ASCII - a cmd.exe a sajat kodlapjan
REM  olvassa a .cmd-t, es az UTF-8 ekzetekbol parancs-toredekeket csinal.
REM ============================================================================

set PROXYDIR=%~dp0
node "%PROXYDIR%autotune.mjs" --days 30 --apply >> "%PROXYDIR%autotune.out.log" 2>&1
set AUTOTUNE_RC=%ERRORLEVEL%
REM Ingyenes keret figyeles: a szamla a merce. FLAG-ONLY (nincs --apply):
REM a szamla byModel bontasa nem kulonbozteti meg az EU/SG azonos nevu modelleket,
REM ezert a fizetosre allitas EMBERI dontes (a gyari email a mervado).
node "%PROXYDIR%quota-watch.mjs" >> "%PROXYDIR%quota-watch.out.log" 2>&1
set QUOTA_RC=%ERRORLEVEL%
if not "%QUOTA_RC%"=="0" exit /b %QUOTA_RC%
exit /b %AUTOTUNE_RC%
