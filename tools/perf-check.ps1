#Requires -Version 7.0
<#
.SYNOPSIS
    Futásidejű teljesítmény-mérés: ki zabál, és mekkora a devadmin poll-vihar?

.DESCRIPTION
    A "minden lassú / egy perc fölötti asztalváltás" tünetének mérőeszköze.
    Négy, egymástól független jelet olvas, és kimondja a verdiktet:

    1. CPU-forgalom: két mintavétel között eltelt processzor-idő, processzenként
       (az ÖSSZES folyamatra, nem csak a mieinkre). Ez mutatja meg, MI zabál.
    2. Panel-rendererek: a `msedgewebview2 --type=renderer` folyamatok CPU-ja
       WebView2-profil szerint csoportosítva (`pane-N`, `pane-N-d2`,
       `pane-N-<pid>-<időbélyeg>`), hogy látszódjon, MELYIK panel melegszik.
       A profilnévhez parancssor kell (CIM); ha az nem érhető el, a bontás
       kimarad, a renderer-összeg marad.
    3. Devadmin poll-vihar: a fejlesztői oldalak Caddy access-logjából a
       `User-Agent: dsh-devadmin` próbák száma és időtartama. A `/devadmin/state`
       végpont minden hívásnál HTTP-próbát indít a dev oldalakra, ezért a
       próbák rátája a host-terhelés legjobb külső jele (a harness belső
       eseményciklusa a sandboxból nem kérdezhető le).
    4. Napló-növekedés: az access-log mérete (a vihar másodlagos tünete; mért
       eset: 13 MB).

    Csak OLVAS. Nem indít, nem állít le és nem ír semmit.

.PARAMETER Seconds
    A CPU-minta ablaka másodpercben (alapból 6).

.PARAMETER Top
    Hány processzt soroljon fel (alapból 12).

.PARAMETER WindowSeconds
    A poll-ráta számítási ablaka (alapból 60).

.EXAMPLE
    .\tools\perf-check.ps1
    .\tools\perf-check.ps1 -Seconds 10 -Top 20
#>
[CmdletBinding()]
param(
    [int]$Seconds = 6,
    [int]$Top = 12,
    [int]$WindowSeconds = 60
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'state'))) { $root = 'D:\Szerver\Deepseek Harness' }
$stateDir = Join-Path $root 'state'
$logDir = Join-Path $stateDir 'dev\logs'

function Write-Head([string]$text) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host $text -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkGray
}

# ------------------------------------------------------------------ 1. CPU ---
Write-Head "1) CPU-forgalom ($Seconds s minta, processzenként)"
$before = @{}
foreach ($p in Get-Process) {
    $before[$p.Id] = @{ Name = $p.ProcessName; Cpu = $p.CPU }
}
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$sw.Stop()
$elapsed = [Math]::Max(0.001, $sw.Elapsed.TotalSeconds)

$rows = foreach ($p in Get-Process) {
    $b = $before[$p.Id]
    if (-not $b) { continue }
    $delta = $p.CPU - $b.Cpu
    if ($null -eq $delta -or $delta -le 0.05) { continue }
    [pscustomobject]@{
        Pid    = $p.Id
        Name   = $p.ProcessName
        CpuPct = [Math]::Round(100.0 * $delta / $elapsed, 1)
        TotalS = [Math]::Round($p.CPU, 0)
        WsMb   = [Math]::Round($p.WorkingSet64 / 1MB, 0)
    }
}
$rows = @($rows | Sort-Object CpuPct -Descending)
$totalPct = ($rows | Measure-Object CpuPct -Sum).Sum
Write-Host ("Összes CPU: {0:N1}%  (a lista a legnagyobb {1} fogyasztó)" -f $totalPct, $Top) -ForegroundColor Yellow
$rows | Select-Object -First $Top | Format-Table -AutoSize

$harnessPid = 0
$pidFile = Join-Path $stateDir 'harness.pid'
if (Test-Path $pidFile) { [int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$harnessPid) | Out-Null }
$harnessRow = $rows | Where-Object { $_.Pid -eq $harnessPid } | Select-Object -First 1
if ($harnessRow) {
    Write-Host ("Harness (pid {0}): {1:N1}% CPU, {2} MB" -f $harnessPid, $harnessRow.CpuPct, $harnessRow.WsMb) -ForegroundColor Yellow
}

# --------------------------------------------- 1b. rendszerszintű top (PDH) ---
# A `Get-Process` a SYSTEM folyamatok CPU-ját NEM tudja kiolvasni (a WmiPrvSE
# 0,00-t ad, a StartTime üres), ezért a gép legnagyobb fogyasztója láthatatlan
# maradna — MÉRT eset: a WMI Provider Host 20–50%-on égett, a lista mégis a
# php/node sorokat mutatta. A PDH-számlálók ezt megkerülik (nem WMI, nem kér
# jogot); a számlálókészlet neve viszont nyelvenként más ("Folyamat" /
# "Process"), ezért futásidőben derítjük ki.
Write-Head "1b) Rendszerszintű top (PDH — a SYSTEM folyamatokkal együtt)"
try {
    $setName = @((Get-Counter -ListSet * -ErrorAction Stop).CounterSetName) |
        Where-Object { $_ -match '^(Folyamat|Process)$' } | Select-Object -First 1
    if (-not $setName) { throw "nincs Process/Folyamat számlálókészlet" }
    $set = Get-Counter -ListSet $setName -ErrorAction Stop
    # A `(*)`-os gyűjtőútvonal ezen a gépen ingatag (PDH 800007D2 /
    # "érvénytelen minta", ha közben processz születik vagy hal), ezért
    # példányonként kérjük le ugyanazt a számlálót — azok külön-külön
    # megbízhatóak —, és kötegekben hívjuk (egy PDH-gyűjtés).
    $cpuName = @(@($set.Counter | ForEach-Object { ($_ -split '\\')[-1] }) |
            Where-Object { $_ -match '%' -and $_ -notmatch 'felhasználói|user|védett|privileged' }) | Select-Object -First 1
    if (-not $cpuName) { throw "nincs CPU-számláló a '$setName' készletben" }
    $paths = @($set.PathsWithInstances | Where-Object { $_.EndsWith($cpuName) } |
            Where-Object { $_ -notmatch '\((Idle|idle|_total|_Total)\)' })
    if ($paths.Count -eq 0) { throw "nincsenek példány-útvonalak" }

    $avg = @{}
    for ($i = 0; $i -lt $paths.Count; $i += 40) {
        $batch = $paths[$i..([Math]::Min($i + 39, $paths.Count - 1))]
        try { $batchSamples = @((Get-Counter -Counter $batch -ErrorAction SilentlyContinue).CounterSamples) }
        catch { $batchSamples = @() }
        foreach ($s in $batchSamples) {
            try { $v = [double]$s.CookedValue } catch { continue }
            if ($null -eq $v -or [double]::IsNaN($v)) { continue }
            $n = ($s.InstanceName -replace '#\d+$', '')
            # FIGYELEM: az azonos nevű példányok (pl. 54 msedgewebview2) ÖSSZEGE
            # számít, nem az átlaga — az átlagolás MÉRTEN a gépet 8%-nak
            # mutatta, miközben az idő-alapú valóság ~30% volt.
            if ($avg.ContainsKey($n)) { $avg[$n] = $avg[$n] + $v } else { $avg[$n] = $v }
        }
    }
    if ($avg.Count -eq 0) { throw "nem jött érvényes minta" }
    $cores = [Environment]::ProcessorCount
    $busy = (($avg.GetEnumerator() | Measure-Object Value -Sum).Sum)
    Write-Host ("A PDH által kiolvasott folyamatok összege: {0:N0}% (1 mag = 100%). A PDH a közben változó példányokat" -f $busy) -ForegroundColor Yellow
    Write-Host "  kihagyja, ezért ez ALSÓ becslés — a gép tényleges terheltségét az alábbi, rendszerszintű sor mondja meg." -ForegroundColor DarkGray
    # A Task Manager a FREKVENCIA-SÚLYOZOTT értéket mutatja ("% Processor
    # Utility"), a legtöbb más eszköz (MSI Center, PDH 'Processzor' készlet) az
    # IDŐ-alapút ("% Processor Time"). MÉRT eset ugyanabban a percben:
    # 73% (Task Manager) vs 35% (MSI Center) — nem ellentmondás, két mutató.
    $piName = @((Get-Counter -ListSet * -ErrorAction SilentlyContinue).CounterSetName) |
        Where-Object { $_ -match '^(Processzorinformációk|Processor Information)$' } | Select-Object -First 1
    if ($piName) {
        $pi = Get-Counter -ListSet $piName -ErrorAction SilentlyContinue
        $totalPaths = @($pi.PathsWithInstances | Where-Object { $_ -match '\(_Total\)' -and $_ -match '%' })
        $idlePath = @($totalPaths | Where-Object { $_ -match 'Üresjárat|Idle' }) | Select-Object -First 1
        $busyTime = $null
        if ($idlePath) {
            try { $busyTime = 100 - (Get-Counter -Counter $idlePath -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue } catch { }
        }
        # A frekvencia-súlyozott érték definíció szerint nem kisebb az
        # idő-alapúnál, ezért a két "kihasználtság"-számláló maximuma az.
        $utility = $null
        foreach ($tp in @($totalPaths | Where-Object { $_ -match 'kihasználtság|Utility' -and $_ -notmatch 'Üresjárat|Idle|frekvencia|efficiency' })) {
            try {
                $v = (Get-Counter -Counter $tp -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
                if ($null -ne $v -and ($null -eq $utility -or $v -gt $utility)) { $utility = $v }
            } catch { }
        }
        if ($null -ne $busyTime) {
            Write-Host ("Mag-idő szerint (a legtöbb eszköz ezt mutatja): {0:N0}%   |   frekvencia-súlyozva (Task Manager): {1}" -f `
                    $busyTime, $(if ($null -ne $utility) { '{0:N0}%' -f $utility } else { '?' })) -ForegroundColor Yellow
        }
    }
    Write-Host ("  {0,-26} {1,7}" -f 'Folyamat', 'CPU%') -ForegroundColor DarkGray
    $avg.GetEnumerator() |
        ForEach-Object { [pscustomobject]@{ Process = $_.Key; CpuPct = [Math]::Round($_.Value, 1) } } |
        Sort-Object CpuPct -Descending | Select-Object -First $Top |
        ForEach-Object { Write-Host ("  {0,-26} {1,6:N1}%" -f $_.Process, $_.CpuPct) }
} catch {
    Write-Host "  (PDH nem érhető el: $($_.Exception.Message))" -ForegroundColor DarkYellow
}

# ------------------------------------------------------- 2. panel-rendererek ---
Write-Head "2) Panel-rendererek (msedgewebview2 --type=renderer)"
$rendererRows = @($rows | Where-Object { $_.Name -eq 'msedgewebview2' })
$rendererPct = ($rendererRows | Measure-Object CpuPct -Sum).Sum
Write-Host ("Renderer-összeg: {0:N1}% CPU, {1} folyamat (ebből {2} melegszik most)" -f $rendererPct, (@(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count), $rendererRows.Count) -ForegroundColor Yellow

$profileByPid = @{}
try {
    $wv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction Stop
    foreach ($w in $wv) {
        if ($w.CommandLine -match '--type=renderer' -and $w.CommandLine -match 'user-data-dir="[^"]*state\\webview2\\([^"\\]+)') {
            $profileByPid[[int]$w.ProcessId] = $Matches[1]
        }
    }
} catch {
    Write-Host "  (parancssor nem olvasható: CIM nem elérhető — a panel-bontás kimarad)" -ForegroundColor DarkYellow
}
if ($profileByPid.Count -gt 0) {
    $byPane = $rendererRows | ForEach-Object {
        [pscustomobject]@{
            Pane   = if ($profileByPid.ContainsKey($_.Pid)) { $profileByPid[$_.Pid] } else { '?' }
            Pid    = $_.Pid
            CpuPct = $_.CpuPct
            TotalS = $_.TotalS
            WsMb   = $_.WsMb
        }
    }
    $byPane | Sort-Object CpuPct -Descending | Format-Table -AutoSize
}

# ------------------------------------------------- 3. devadmin poll-vihar ---
Write-Head "3) Devadmin próbák a fejlesztői oldalakon (access-log)"
$probeRate = 0.0
$logBytes = 0
if (-not (Test-Path $logDir)) {
    Write-Host "Nincs access-log mappa: $logDir" -ForegroundColor DarkYellow
} else {
    foreach ($log in Get-ChildItem $logDir -Filter 'access-*.log' -File) {
        $logBytes += $log.Length
        $take = [Math]::Min($log.Length, [int64]400KB)
        $fs = [System.IO.File]::Open($log.FullName, 'Open', 'Read', 'ReadWrite')
        try {
            $null = $fs.Seek(-$take, 'End')
            $buf = New-Object byte[] $take
            $null = $fs.Read($buf, 0, $take)
        } finally { $fs.Close() }
        $lines = @(([Text.Encoding]::UTF8.GetString($buf) -split "`n") | Where-Object { $_ -match '"ts":' })
        if ($lines.Count -eq 0) { continue }
        $stamps = [double[]]@(foreach ($l in $lines) { if ($l -match '"ts":([0-9.]+)') { [double]$Matches[1] } })
        if ($stamps.Count -eq 0) { continue }
        $newest = ($stamps | Measure-Object -Maximum).Maximum
        $newestLocal = [DateTimeOffset]::FromUnixTimeMilliseconds([long]($newest * 1000)).ToLocalTime()
        $freshness = ([DateTimeOffset]::Now - $newestLocal).TotalSeconds

        $inWindow = @($lines | Where-Object {
                if ($_ -match '"ts":([0-9.]+)') { [double]$Matches[1] -gt ($newest - $WindowSeconds) } else { $false }
            })
        $probes = @($inWindow | Where-Object { $_ -match 'dsh-devadmin' })
        $rate = $probes.Count / [double]$WindowSeconds
        if ($rate -gt $probeRate) { $probeRate = $rate }
        $durations = [double[]]@(foreach ($l in $probes) { if ($l -match '"duration":([0-9.]+)') { [double]$Matches[1] } })
        $d = $durations | Measure-Object -Average -Minimum -Maximum

        Write-Host ("{0}" -f $log.Name) -ForegroundColor Gray
        Write-Host ("  legutóbbi bejegyzés: {0:HH:mm:ss}  ({1:N0} s ezelőtt)  fájl: {2:N1} MB" -f $newestLocal, $freshness, ($log.Length / 1MB))
        $colour = if ($rate -gt 0.5) { 'Red' } elseif ($rate -gt 0.05) { 'Yellow' } else { 'Green' }
        Write-Host ("  utolsó {0} s: {1} kérés, ebből dsh-devadmin próba: {2}  ->  {3:N2} próba/s" -f $WindowSeconds, $inWindow.Count, $probes.Count, $rate) -ForegroundColor $colour
        if ($durations.Count -gt 0) {
            Write-Host ("  próba-időtartam: átlag {0:N3} s, min {1:N3} s, max {2:N3} s" -f $d.Average, $d.Minimum, $d.Maximum)
        }
    }
    Write-Host ("Access-log összméret: {0:N1} MB" -f ($logBytes / 1MB))
}

# ------------------------------------------------------------ 4. verdikt -----
Write-Head "4) Verdikt"
$harnessPct = if ($harnessRow) { $harnessRow.CpuPct } else { 0 }
if ($probeRate -gt 0.5) {
    Write-Host ("POLL-VIHAR: {0:N2} próba/s a fejlesztői oldalakon. A régi kliens panelenként 2 s-onként kérdezi a /devadmin/state-et," -f $probeRate) -ForegroundColor Red
    Write-Host "ami minden hívásnál HTTP-próbát indít a dev oldalakra (Laravel-render) + port-tulajdonosokat kérdez." -ForegroundColor Red
    Write-Host "A javítás a kiszolgált kliens-csomagban már benne van: PANEL-FRISSÍTÉS (fogaskerék -> frissítés / ablak újranyitása) megszünteti." -ForegroundColor Red
} elseif ($probeRate -gt 0.05) {
    Write-Host ("Közepes próba-ráta: {0:N2}/s (a 15 s-os host-cache nem él, mert a harness a régi kódot futtatja)." -f $probeRate) -ForegroundColor Yellow
} else {
    Write-Host ("Nincs poll-vihar: {0:N2} próba/s. A ritkított kliens (vagy a 15 s-os host-cache) aktív." -f $probeRate) -ForegroundColor Green
}
if ($harnessPct -gt 50) {
    Write-Host ("A harness {0:N1}%-on fut — ha éppen ágens-kör fut (eszközhívások), ez a SAJÁT munkánk; a poll-vihart nem ez, hanem a fenti próba-ráta mutatja." -f $harnessPct) -ForegroundColor Yellow
}
$wmiPct = 0.0
if ($avg -and $avg.ContainsKey('wmiprvse')) { $wmiPct = [double]$avg['wmiprvse'] }
if ($wmiPct -gt 10) {
    Write-Host ("A WMI Provider Host (wmiprvse) {0:N1}%-on pörög: ez önmagában semmit nem csinál, csak MÁS programok WMI-kéréseit szolgálja ki." -f $wmiPct) -ForegroundColor Yellow
    Write-Host "  MÉRT ügyfelek ezen a gépen: MSI 'Sensor dev service' (Sendevsvc: MSI_CPU/MSI_VGA/MSI_AP), MSI_TraceFPS overlay," -ForegroundColor Yellow
    Write-Host "  valamint a Windows DoSvc (Kézbesítés optimalizálása) 2 s-onként ismételt, MINDIG HIBÁZÓ adapter-statisztika lekérdezése." -ForegroundColor Yellow
    Write-Host "  A DSH NEM WMI-fogyasztó: a pluginok CIM-hívása eseményhez kötött, a devadmin panel netstat/tasklist-et használ." -ForegroundColor Yellow
}
$hotPanes = @($rendererRows | Where-Object { $_.CpuPct -gt 50 })
if ($hotPanes.Count -gt 0) {
    Write-Host ("{0} panel-renderer ~1 magon pörög (összesen {1:N1}%). Ha a panelek élő sessiont streamelnek, ez várt; ha nem, a panel kliens-kódja a hibás." -f $hotPanes.Count, $rendererPct) -ForegroundColor Yellow
}
if ($logBytes -gt 20MB) {
    Write-Host ("Az access-log {0:N1} MB — érdemes rotálni (a vihar másodlagos tünete)." -f ($logBytes / 1MB)) -ForegroundColor Yellow
}
