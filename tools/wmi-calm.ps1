#Requires -Version 7.0
<#
.SYNOPSIS
    WMI Provider Host (wmiprvse) CPU-terhelésének csillapítása — mérve, visszafordíthatóan.

.DESCRIPTION
    A `wmiprvse.exe` önmagában semmit nem csinál: más programok WMI-kéréseit
    szolgálja ki, ezért a CPU-ja mindig MÁSOK munkája. Ezen a gépen a mért
    ügyfelek (2026-11-16, `Microsoft-Windows-WMI-Activity/Operational` 5858):

      * MSI „Sensor dev service" (`Sendevsvc.exe`, MSI NBFoundation) — root\WMI:
        MSI_CPU / MSI_VGA / MSI_AP / SMBIOS / Win32_PowerPlan érzékelő-pollozás;
      * `MSI_TraceFPS.exe` FPS-overlay (mért 7,7% önmagában);
      * a Windows `DoSvc` (Kézbesítés optimalizálása) 2 s-onként ismételt,
        MINDIG hibázó adapter-statisztika lekérdezése.

    Ez a szkript a fenti MSI-összetevőket leállítja (és alapból `Manual`
    indítási típusra állítja, hogy boot után ne jöjjenek vissza), a DoSvc
    hibás ciklusát is leállítja, és **megméri a wmiprvse CPU-ját előtte/utána**,
    hogy a hatás ne hit kérdése legyen.

    FONTOS: a szolgáltatások SYSTEM fiókkal futnak, ezért **emelt PowerShell
    kell**. Ha nem emelt, a szkript `-SelfElevate`-tel újraindítja magát
    (UAC-kérdés) — ezt a FELHASZNÁLÓ indítja, nem automatizmus.

.PARAMETER Report
    Csak mér és kiírja a tervet; semmit nem állít le (emelt jog nélkül is fut).

.PARAMETER StopOnly
    Csak leállítja a szolgáltatásokat, az indítási típust NEM írja át (a
    következő bootnál minden visszatér).

.PARAMETER SkipDosvc
    A Kézbesítés optimalizálását (DoSvc) hagyja békén.

.PARAMETER IncludeIntel
    Az Intel Collector / Telemetry szolgáltatásokat is leállítja (nagyobb falat).

.PARAMETER Samples
    Ennyi 1 s-os mintát vesz a wmiprvse CPU-jából (alapból 8).

.EXAMPLE
    .\tools\wmi-calm.cmd                 # dupla kattintás: UAC, majd végrehajtás
    .\tools\wmi-calm.ps1 -Report         # csak mérés (emelt jog nélkül is)
    .\tools\wmi-calm.ps1 -StopOnly       # csak most, tartós változtatás nélkül
#>
[CmdletBinding()]
param(
    [switch]$Report,
    [switch]$StopOnly,
    [switch]$SkipDosvc,
    [switch]$IncludeIntel,
    [switch]$SelfElevate,
    [int]$Samples = 8
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'state'))) { $root = 'D:\Szerver\Deepseek Harness' }
$stateDir = Join-Path $root 'state'
$logFile = Join-Path $stateDir 'wmi-calm.log'

function Write-Log([string]$text) {
    try {
        if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
        Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text) -Encoding utf8
    } catch { }
}
function Write-Head([string]$text) {
    Write-Host ''
    Write-Host ('=' * 74) -ForegroundColor DarkGray
    Write-Host $text -ForegroundColor Cyan
    Write-Host ('=' * 74) -ForegroundColor DarkGray
}

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (@($id.Groups | Where-Object { $_.Value -eq 'S-1-16-12288' }).Count -gt 0)
}

# ---------------------------------------------------------------- mérés ------
function Get-WmiCpuCounterPath {
    $setName = @((Get-Counter -ListSet * -ErrorAction SilentlyContinue).CounterSetName) |
        Where-Object { $_ -match '^(Folyamat|Process)$' } | Select-Object -First 1
    if (-not $setName) { return $null }
    $set = Get-Counter -ListSet $setName -ErrorAction SilentlyContinue
    return @($set.PathsWithInstances | Where-Object { $_ -match '\(WmiPrvSE\)' -and $_ -match '%' }) | Select-Object -First 1
}

function Measure-WmiCpu([int]$count, [string]$path) {
    $vals = @()
    for ($i = 0; $i -lt $count; $i++) {
        $v = $null
        try { $v = (Get-Counter -Counter $path -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue } catch { }
        if ($null -ne $v) { $vals += [math]::Round($v, 1) }
        Start-Sleep -Seconds 1
    }
    if ($vals.Count -eq 0) { return $null }
    return [pscustomobject]@{
        Avg  = [math]::Round((($vals | Measure-Object -Average).Average), 1)
        Max  = ($vals | Measure-Object -Maximum).Maximum
        Text = ($vals -join ', ')
    }
}

# -------------------------------------------------------------- célpontok ----
$msiServices = @('MSI Sendevsvc', 'MSI_Center_Service', 'MSI_Companion_Service', 'MSI Foundation Service')
$intelServices = @('IntelCollectorService', 'IntelTelemetryAgent')
$msiProcessNames = @('MSI_TraceFPS', 'MSI.CentralServer', 'MSI.TerminalServer', 'MSI_GamebarTool', 'MSIService')

function Get-MsiProcessTargets {
    $found = @()
    $wanted = $msiProcessNames
    foreach ($name in $wanted) {
        foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $path = $null
            try { $path = $p.Path } catch { }
            if (-not $path) {
                # SYSTEM/emelt folyamatnál a Path nem olvasható — CIM-mel pótoljuk.
                try {
                    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction Stop
                    $path = $cim.ExecutablePath
                } catch { }
            }
            # BIZTONSÁG: csak ellenőrzött, MSI-telepítésű útvonalat állítunk le.
            if ($path -and $path -match '\\MSI\\') {
                $found += [pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName; Path = $path }
            }
        }
    }
    return $found
}

# -------------------------------------------------------------- futtatás -----
$elevated = Test-Elevated

if ($SelfElevate -and -not $elevated -and -not $Report) {
    Write-Host 'Emelt PowerShell kell — újraindítom magamat (a Windows UAC-kérdést tesz fel).' -ForegroundColor Yellow
    $exe = (Get-Process -Id $PID).Path
    if (-not $exe) { $exe = 'pwsh.exe' }
    Start-Process -FilePath $exe -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', $PSCommandPath
    ) | Out-Null
    return
}

$counterPath = Get-WmiCpuCounterPath
if (-not $counterPath) {
    Write-Host 'Nem találom a wmiprvse PDH-számlálóját — a mérés kimarad.' -ForegroundColor Red
}

Write-Head 'WMI Provider Host terhelés — jelenlegi állapot'
$before = if ($counterPath) { Measure-WmiCpu $Samples $counterPath } else { $null }
if ($before) {
    Write-Host ("wmiprvse CPU: átlag {0:N1}%, csúcs {1:N1}%  ({2})" -f $before.Avg, $before.Max, $before.Text) -ForegroundColor Yellow
    Write-Log ("meres elotte: atlag {0}% csucs {1}%" -f $before.Avg, $before.Max)
}

$svcTargets = @($msiServices | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
if ($IncludeIntel) { $svcTargets += @($intelServices | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue }) }
if (-not $SkipDosvc) { if (Get-Service -Name 'DoSvc' -ErrorAction SilentlyContinue) { $svcTargets += 'DoSvc' } }
$procTargets = Get-MsiProcessTargets

Write-Head 'Terv'
Write-Host ('Leállítandó szolgáltatások ({0}):' -f $svcTargets.Count)
foreach ($s in $svcTargets) {
    $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
    Write-Host ("  {0,-26} {1}" -f $s, $(if ($svc) { $svc.Status } else { '?' }))
}
Write-Host ('Leállítandó MSI-folyamatok ({0}):' -f $procTargets.Count)
foreach ($p in $procTargets) { Write-Host ("  {0,-24} pid={1}  {2}" -f $p.Name, $p.Id, $p.Path) }
if (-not $StopOnly) { Write-Host 'Az érintett szolgáltatások indítási típusa: Manual (boot után nem jönnek vissza).' -ForegroundColor DarkGray }

if ($Report) {
    Write-Head 'Csak mérés (-Report) — semmit nem állítottam le'
    Write-Host 'Végrehajtás: dupla kattintás a tools\wmi-calm.cmd-ra (UAC), vagy emelt PowerShellben a szkript.'
    return
}

if (-not $elevated) {
    Write-Head 'NINCS EMELT JOG'
    Write-Host 'A szolgáltatások SYSTEM fiókkal futnak, leállításukhoz emelt PowerShell kell.' -ForegroundColor Red
    Write-Host 'Indítás: dupla kattintás a tools\wmi-calm.cmd-ra (az UAC-kérdést a felhasználó hagyja jóvá),' -ForegroundColor Yellow
    Write-Host 'vagy: Start-Process pwsh -Verb RunAs' -ForegroundColor Yellow
    return
}

Write-Head 'Végrehajtás'
$failed = @()
foreach ($s in $svcTargets) {
    try {
        $svc = Get-Service -Name $s -ErrorAction Stop
        if ($svc.Status -ne 'Stopped') {
            Stop-Service -Name $s -Force -ErrorAction Stop
            Write-Host ("  leállítva: {0}" -f $s) -ForegroundColor Green
            Write-Log "szolgaltatas leallitva: $s"
        } else {
            Write-Host ("  már állt: {0}" -f $s) -ForegroundColor DarkGray
        }
        if (-not $StopOnly -and $svc.StartType -ne 'Manual') {
            Set-Service -Name $s -StartupType Manual -ErrorAction Stop
            Write-Log "szolgaltatas Manual: $s"
        }
    } catch {
        $failed += "$s : $($_.Exception.Message)"
        Write-Host ("  HIBA: {0} — {1}" -f $s, $_.Exception.Message) -ForegroundColor Red
    }
}
foreach ($p in $procTargets) {
    try {
        $live = Get-Process -Id $p.Id -ErrorAction Stop
        if ($live.ProcessName -ne $p.Name) { throw "pid $($p.Id) már más folyamat ($($live.ProcessName))" }
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        Write-Host ("  leállítva: {0} (pid {1})" -f $p.Name, $p.Id) -ForegroundColor Green
        Write-Log "folyamat leallitva: $($p.Name) pid=$($p.Id)"
    } catch {
        Write-Host ("  kihagyva: {0} (pid {1}) — {2}" -f $p.Name, $p.Id, $_.Exception.Message) -ForegroundColor DarkYellow
    }
}

Write-Host ''
Write-Host '5 másodperc, hogy a WMI-gazda lecsengjen…' -ForegroundColor DarkGray
Start-Sleep -Seconds 5

Write-Head 'Eredmény'
$after = if ($counterPath) { Measure-WmiCpu $Samples $counterPath } else { $null }
if ($after -and $before) {
    Write-Host ("wmiprvse CPU: {0:N1}%  ->  {1:N1}%   (csúcs {2:N1}% -> {3:N1}%)" -f $before.Avg, $after.Avg, $before.Max, $after.Max) -ForegroundColor Green
    Write-Log ("meres utana: atlag {0}% csucs {1}%" -f $after.Avg, $after.Max)
    if ($after.Avg -lt ($before.Avg * 0.5)) {
        Write-Host 'A terhelés a felére vagy jobbra esett — a leállított ügyfelek voltak a fő fogyasztók.' -ForegroundColor Green
    } elseif ($after.Avg -gt ($before.Avg * 0.8)) {
        Write-Host 'Alig változott: a fő WMI-fogyasztó NEM ezek között van. Küldd el ezt a kimenetet, és tovább szűkítem' -ForegroundColor Yellow
        Write-Host '(következő jelöltek: NahimicService, Intel(R) Collector/Telemetry, Defender, illetve egy harmadik féltől származó monitorozó).' -ForegroundColor Yellow
    }
} else {
    Write-Host 'A mérés nem sikerült, a leállítás viszont megtörtént.' -ForegroundColor Yellow
}

Write-Head 'Visszaállítás (ha kell)'
foreach ($s in $svcTargets) {
    if ($s -eq 'DoSvc') {
        Write-Host ("  Set-Service -Name '{0}' -StartupType Automatic; Start-Service '{0}'" -f $s) -ForegroundColor Gray
    } else {
        Write-Host ("  Set-Service -Name '{0}' -StartupType Automatic; Start-Service '{0}'" -f $s) -ForegroundColor Gray
    }
}
Write-Host '  (Az MSI Center ezután a Start-menüből indítva ismét felveszi a szolgáltatásokat.)' -ForegroundColor Gray
Write-Host ''
Write-Host ("Napló: {0}" -f $logFile) -ForegroundColor DarkGray
if ($failed.Count) {
    Write-Host ''
    Write-Host 'Nem sikerült:' -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
}
