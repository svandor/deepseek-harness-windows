<#
.SYNOPSIS
    A subagent fallback proxy tartós, önjavító üzemének telepítése.

.DESCRIPTION
    MEGMÉRT HIBA, amit ez a telepítő megszüntet:

      A proxy a Startup mappából indult (parancsikon -> run-proxy.cmd ->
      powershell -> node). A naplója szerint 2026-09-27 18:19:31-én minden
      hibaüzenet nélkül elhalt, és nem indult újra. Onnantól a `subagent-worker`
      route nem válaszolt: a delegált gyermek-session minden hívása elhalt
      (a szülő nem). Ez a "használat után behalt" tünet.

    A Startup mechanizmus egyszer fut, és nem próbálkozik újra. A megoldás egy
    ÖNJAVÍTÓ őrködő ciklus, két szinten:

      1. ELSŐDLEGES: Windows Feladatütemező — 5 percenként + bejelentkezéskor
         futtatja a watchdogot (watchdog-subagent-proxy.ps1). Ez gépszintű,
         ezért ezt próbáljuk először. Ha a regisztrálás jogosultság miatt nem
         megy (mért eredmény ezen a gépen: "A hozzáférés megtagadva"), a
         telepítő ezt jelzi, de NEM áll meg — jön a 2. szint.
      2. FALLBACK: leválasztott, látható ablak nélküli őrködő ciklus
         (start-watchdog.ps1) + Startup parancsikon, ami bejelentkezéskor
         elindítja. A ciklus maga is újraindítja a proxyt kieséskor, ezért
         akkor is működik, ha a feladatütemező nem elérhető.

    A watchdog csak AKTÓL indít proxyt, ha a /healthz nem válaszol — nincs
    dupla példány. A naplóba csak a rendellenes események kerülnek
    (reports\proxy-watchdog.log).

.PARAMETER IntervalSeconds
    Az őrködő ciklus ellenőrzési gyakorisága. Alapértelmezés: 60.

.PARAMETER NoTask
    Ne próbálja regisztrálni az ütemezett feladatot (csak a leválasztott
    ciklus + Startup parancsikon).

.PARAMETER NoTerminalFix
    Ne állítsa át az alapértelmezett terminált Windows konzol gazdagépre. Csak
    akkor használd, ha kifejezetten a Windows Terminálban akarod futtatni a
    kézzel indított konzolokat — ekkor viszont a rejtett konzolok ablakot
    villanthatnak és elvehetik a fókuszta (lásd a [0/3] lépés mért hibáját).

.PARAMETER Remove
    Leállítja az őrködő ciklust, törli az ütemezett feladatot és a Startup
    parancsikont.

.EXAMPLE
    .\install-subagent-proxy.ps1
    .\install-subagent-proxy.ps1 -NoTask
    .\install-subagent-proxy.ps1 -IntervalSeconds 30
    .\install-subagent-proxy.ps1 -Remove

.NOTES
    A Feladatütemező írása a DSH sandboxból tiltott; a szkriptet szokásos
    PowerShell-ablakból futtasd (a saját feladataidhoz rendszergazda nem kell,
    de ha a házirend tiltja, a 2. szint ettől függetlenül működik).
#>
[CmdletBinding()]
param(
    [ValidateRange(15, 3600)][int]$IntervalSeconds = 60,
    [string]$TaskName = 'DSH subagent proxy watchdog',
    [switch]$NoTask,
    # Ne nyúljon az alapértelmezett terminál beállításához (lásd a [0/3] lépést).
    [switch]$NoTerminalFix,
    [switch]$Remove
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $root 'watchdog-subagent-proxy.ps1'
$starter = Join-Path $root 'start-watchdog.ps1'
$vbsLauncher = Join-Path $root 'start-watchdog-hidden.vbs'
$reportDir = Join-Path $root 'reports'
$pidFile = Join-Path $reportDir 'proxy-watchdog.pid'
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$lnkPath = Join-Path $startupDir 'DSH subagent proxy watchdog.lnk'
$oldLnk = Join-Path $startupDir 'DSH subagent proxy.lnk'
$logonTaskName = "$TaskName (logon)"

if (-not (Test-Path $watchdog)) { throw "Nem találom: $watchdog" }
if (-not (Test-Path $starter)) { throw "Nem találom: $starter" }
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }

# ── eltávolítás ───────────────────────────────────────────────────────────
if ($Remove) {
    if (Test-Path $pidFile) {
        $existing = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($existing -match '^\d+$') {
            Stop-Process -Id ([int]$existing) -Force -ErrorAction SilentlyContinue
            Write-Host "Őrködő ciklus leállítva (PID $existing)." -ForegroundColor Green
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    foreach ($tn in @($TaskName, $logonTaskName)) {
        $out = & schtasks.exe /Delete /TN $tn /F 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Host "Ütemezett feladat törölve: '$tn'" -ForegroundColor Green }
    }
    foreach ($l in @($lnkPath, $oldLnk)) {
        if (Test-Path $l) { Remove-Item $l -Force -ErrorAction SilentlyContinue; Write-Host "Parancsikon törölve: $(Split-Path $l -Leaf)" -ForegroundColor Green }
    }
    return
}

Write-Host "Subagent proxy — önjavító üzem telepítése" -ForegroundColor Cyan
Write-Host ""

# ── 0. szint: a rejtett konzolok legyenek VALÓBAN rejtettek ───────────────
# MÉRT HIBA (2026-10-07): ezen a gépen a Windows Terminál volt az
# alapértelmezett terminál (HKCU:\Console\%%Startup → DelegationConsole /
# DelegationTerminal a WT GUID-jaira állítva). Emiatt a `-WindowStyle Hidden`
# és a CREATE_NO_WINDOW ellenére MINDEN rejtett konzolra megjelent egy WT-ablak,
# majd a tálcára minimalizálódott, és elvette a fókuszta (a watchdog 5 percenként,
# a robot 15 percenként, a tálca-őr pedig percenként indít ilyet). Conhost-
# delegálással ugyanazok az indítások 50 ms-os mintavétellel mérve SEM ablakot,
# SEM fókuszváltást nem okoztak.
# Visszaállítás, ha valaki mégis WT-t akar:
#   Set-ItemProperty 'HKCU:\Console\%%Startup' -Name DelegationConsole  -Value '{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}'
#   Set-ItemProperty 'HKCU:\Console\%%Startup' -Name DelegationTerminal -Value '{E12CFF52-A866-4C77-9A90-F570A7AA2C6B}'
$conhostClsid = '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}'
if (-not $NoTerminalFix) {
    try {
        $dlgKey = 'HKCU:\Console\%%Startup'
        if (-not (Test-Path $dlgKey)) { New-Item -Path $dlgKey -Force | Out-Null }
        $curC = (Get-ItemProperty $dlgKey -Name DelegationConsole -ErrorAction SilentlyContinue).DelegationConsole
        $curT = (Get-ItemProperty $dlgKey -Name DelegationTerminal -ErrorAction SilentlyContinue).DelegationTerminal
        if ($curC -eq $conhostClsid -and $curT -eq $conhostClsid) {
            Write-Host "[0/3] Alapértelmezett terminál: Windows konzol gazdagép — rendben." -ForegroundColor Green
        } else {
            Set-ItemProperty -Path $dlgKey -Name DelegationConsole -Value $conhostClsid
            Set-ItemProperty -Path $dlgKey -Name DelegationTerminal -Value $conhostClsid
            Write-Host "[0/3] Alapértelmezett terminál átállítva Windows konzol gazdagépre (rejtett konzol = valóban rejtett)." -ForegroundColor Green
            Write-Host "      Előző értékek: Console=$curC  Terminal=$curT" -ForegroundColor DarkGray
            Write-Host "      A már futó konzolokra nem hat, csak az új indításokra." -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "[0/3] A terminál-beállítást nem sikerült átállítani: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "      Kézzel: Gépház → Rendszer → Fejlesztőknek → Terminál → Windows konzol gazdagép" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[0/3] Terminál-beállítás kihagyva (-NoTerminalFix)." -ForegroundColor DarkGray
}

# ── 1. szint: ütemezett feladat ───────────────────────────────────────────
$taskOk = $false
if (-not $NoTask) {
    # A PowerShell 5.1 szétdarabolja az idézőjeles natív argumentumokat, ezért a
    # schtasks-et cmd.exe-n keresztül hívjuk (mint a register-monthly-retune.ps1).
    #
    # MÉRT HIBA (2026-10-07): a közvetlen `powershell.exe … -WindowStyle Hidden`
    # indításra a Windows Terminál (ha az az alapértelmezett terminál) ablakot
    # nyitott, majd a tálcára minimalizálta, és elvette a fókuszta. Ezért a
    # feladat a rejtett VBS-burkolót indítja, ami `WshShell.Run …, 0, False`-szal
    # indít, és maga ellenőrzi, hogy fut-e már ciklus (a wscript azonnal kilép,
    # ezért az IgnoreNew nem védene a párhuzamos ciklusoktól).
    if (Test-Path $vbsLauncher) {
        $inner = "wscript.exe //nologo `"$vbsLauncher`""
    } else {
        Write-Host "[1/3] FIGYELEM: hiányzik a $(Split-Path $vbsLauncher -Leaf) — a task a régi (ablakot nyitó) módon regisztrálódik." -ForegroundColor Yellow
        $inner = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`" -Once"
    }
    $tr = $inner -replace '"', '\"'

    $cmdLine = "schtasks.exe /Create /TN `"$TaskName`" /TR `"$tr`" /SC MINUTE /MO 5 /F"
    $out = & cmd.exe /c $cmdLine 2>&1
    $taskOk = ($LASTEXITCODE -eq 0)

    if ($taskOk) {
        Write-Host "[1/3] Ütemezett feladat regisztrálva: '$TaskName' (5 percenként)" -ForegroundColor Green
        $logon = & cmd.exe /c "schtasks.exe /Create /TN `"$logonTaskName`" /TR `"$tr`" /SC ONLOGON /F" 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Host "      + bejelentkezéskori indítás regisztrálva" -ForegroundColor Green }
    } else {
        Write-Host "[1/3] Az ütemezett feladat NEM regisztrálható (jogosultság)." -ForegroundColor Yellow
        $out | Select-Object -First 3 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkYellow }
        Write-Host "      Ez nem végzetes: a 2. szint (őrködő ciklus) ettől függetlenül működik." -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[1/3] Ütemezett feladat kihagyva (-NoTask)." -ForegroundColor DarkGray
}

# ── 2. szint: leválasztott őrködő ciklus ──────────────────────────────────
Write-Host "[2/3] Őrködő ciklus indítása..." -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $starter -IntervalSeconds $IntervalSeconds
$watchdogRunning = ($LASTEXITCODE -eq 0)

# A régi, egyszer futó Startup parancsikon eltávolítása: két versengő indító
# zavaró, és a régi nem ellenőriz, ezért dupla példányt is indíthatna.
if (Test-Path $oldLnk) {
    Copy-Item $oldLnk (Join-Path $root 'DISABLED-startup-DSH-subagent-proxy.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item $oldLnk -Force -ErrorAction SilentlyContinue
    Write-Host "      Régi Startup parancsikon eltávolítva (mentés: DISABLED-startup-...lnk)" -ForegroundColor Gray
}

# Startup parancsikon az őrködő ciklushoz — bejelentkezéskor ez indítja, ha az
# ütemezett feladat nem elérhető.
try {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($lnkPath)
    # Ugyanaz a rejtett burkoló, mint a feladatnál: a parancsikon csak a
    # gyakoriságot adja át (a -Quiet kapcsolót a VBS teszi be, és az is
    # ellenőrzi, hogy ne induljon második ciklus).
    if (Test-Path $vbsLauncher) {
        $lnk.TargetPath = 'wscript.exe'
        $lnk.Arguments = "//nologo `"$vbsLauncher`" $IntervalSeconds"
    } else {
        $lnk.TargetPath = 'powershell.exe'
        $lnk.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`" -Quiet -IntervalSeconds $IntervalSeconds"
    }
    $lnk.WorkingDirectory = $root
    $lnk.WindowStyle = 7
    $lnk.Description = 'DSH subagent fallback proxy orokodes (onjavito ciklus)'
    $lnk.Save()
    Write-Host "      Startup parancsikon kész: $(Split-Path $lnkPath -Leaf)" -ForegroundColor Green
} catch {
    Write-Host "      A Startup parancsikont nem tudtam létrehozni: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── 3. szint: azonnali ellenőrzés ─────────────────────────────────────────
Write-Host "[3/3] Azonnali ellenőrzés..." -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watchdog -Once
$probe = $LASTEXITCODE

# ── összefoglaló ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Telepítés kész." -ForegroundColor Green
Write-Host "  Ütemezett feladat: $(if ($taskOk) { 'regisztrálva (5 percenként + bejelentkezéskor)' } else { 'nem elérhető — a ciklus és a Startup parancsikon viszi' })" -ForegroundColor Gray
Write-Host "  Őrködő ciklus:     $(if ($watchdogRunning) { 'fut' } else { 'NEM fut — nézd meg a naplót' })" -ForegroundColor Gray
Write-Host "  Őrködő napló:      $(Join-Path $reportDir 'proxy-watchdog.log')" -ForegroundColor Gray
Write-Host ""
Write-Host "Ellenőrzés:  node verify-subagent-chain.mjs" -ForegroundColor DarkGray
Write-Host "Állapot:     Get-Content `"$(Join-Path $reportDir 'proxy-watchdog.pid')`"" -ForegroundColor DarkGray
Write-Host "Törlés:      .\install-subagent-proxy.ps1 -Remove" -ForegroundColor DarkGray
Write-Host ""

if ($probe -eq 2) {
    Write-Host "FIGYELEM: a proxy fut, de a worker láncban nincs felhős cél." -ForegroundColor Yellow
    Write-Host "Indítsd kézzel a kulcsokkal: .\run-proxy-service.ps1" -ForegroundColor Yellow
    exit 2
}
if ($probe -eq 1) {
    Write-Host "HIBA: a proxy nem indult el. Nézd meg: proxy.out.log / proxy.err.log" -ForegroundColor Red
    exit 1
}
exit 0
