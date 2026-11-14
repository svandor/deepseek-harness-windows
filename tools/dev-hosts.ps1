<#
.SYNOPSIS
    Hosts-fajl segéd a DSH dev-környezethez: ellenőrzés, hozzáadás, eltávolítás.

.DESCRIPTION
    A Herd a saját telepítésekor maga írta a `.test` sorokat a hosts fájlba. A
    Herd-kiváltás után ez a szkript teszi ugyanezt, de **nyilvántartással**:
    minden hozzáadott sor bekerül a projekt `.dsh\hosts-added.json` fájljába
    (domain, sor, időbélyeg), és az eltávolítás KIZÁRÓLAG a nyilvántartott
    sorokat törli. Idegen (kézzel vagy Herd által írt) sorhoz nem nyúl.

    A hosts fájl írása emelt hatalmat (UAC) igényel. Ha a szkript nem emelt,
    ezt kimondja, és kiírja a futtatandó parancsot a kért művelettel — nem
    nyit magától felugró ablakot (AGENTS.md 1. pont).

.PARAMETER Action
    check (alapértelmezés) — mely domainek vannak/ hiányoznak, mi a nyilvántartás.
    add     — a projekt domainjének hozzáadása (127.0.0.1), nyilvántartással.
    remove  — a nyilvántartott sorok eltávolítása.

.PARAMETER Project
    A projekt gyökere (ahol a .dsh\dev.yaml van). Kötelező az add/remove-hoz.

.PARAMETER SitesRoot
    A parkolt gyökér (alapértelmezés: D:\Herd), a check végigmegy rajta.

.PARAMETER DryRun
    Csak kiírja, mit tenne — nem ír.

.EXAMPLE
    pwsh -NoProfile -File tools\dev-hosts.ps1
    pwsh -NoProfile -File tools\dev-hosts.ps1 -Action add -Project D:\Herd\termeszetgyogyaszoktatas-L12
#>
[CmdletBinding()]
param(
    [ValidateSet('check', 'add', 'remove')]
    [string]$Action = 'check',
    [string]$Project = '',
    [string]$SitesRoot = 'D:\Herd',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$HostsFile = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
$Marker = '# DSH dev (dev-hosts.ps1)'

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-DevProfile {
    param([string]$Root)
    $result = @{ domain = ''; project = $Root }
    $path = Join-Path $Root '.dsh\dev.yaml'
    if (Test-Path $path) {
        foreach ($line in Get-Content $path) {
            if ($line -match '^\s*domain\s*:\s*(.*)$') {
                $result.domain = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
            }
        }
    }
    if (-not $result.domain) { $result.domain = ((Split-Path $Root -Leaf).ToLowerInvariant() + '.test') }
    return $result
}

function Get-HostNames {
    $names = @{}
    if (-not (Test-Path $HostsFile)) { return $names }
    foreach ($line in Get-Content $HostsFile) {
        $clean = ($line -replace '#.*$', '').Trim()
        if (-not $clean) { continue }
        $parts = $clean -split '\s+'
        if ($parts.Count -lt 2) { continue }
        foreach ($name in $parts[1..($parts.Count - 1)]) { $names[$name.ToLowerInvariant()] = $true }
    }
    return $names
}

function Get-JournalPath {
    param([string]$Root)
    return (Join-Path $Root '.dsh\hosts-added.json')
}

function Read-Journal {
    param([string]$Root)
    $path = Get-JournalPath -Root $Root
    if (-not (Test-Path $path)) { return @() }
    try { return @(Get-Content $path -Raw | ConvertFrom-Json) } catch { return @() }
}

function Write-Journal {
    param([string]$Root, $Entries)
    $path = Get-JournalPath -Root $Root
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    @($Entries) | ConvertTo-Json -Depth 4 | Set-Content $path -Encoding UTF8
}

function Get-Projects {
    if ($Project) { return @($Project) }
    if (-not (Test-Path $SitesRoot)) { return @() }
    return @(Get-ChildItem $SitesRoot -Directory | ForEach-Object { $_.FullName })
}

$elevated = Test-Elevated
Write-Host ("=== hosts segéd ({0}) ===" -f $(if ($elevated) { 'emelt' } else { 'NEM emelt' }))
Write-Host ("hosts fájl: {0}" -f $HostsFile)

if ($Action -eq 'check') {
    $names = Get-HostNames
    foreach ($root in (Get-Projects)) {
        $profile = Read-DevProfile -Root $root
        $journal = Read-Journal -Root $root
        $present = $names.ContainsKey($profile.domain)
        Write-Host ("  {0,-40} {1}   nyilvántartva: {2}" -f $profile.domain, $(if ($present) { 'SZEREPEL' } else { 'HIÁNYZIK' }), $(if ($journal.Count) { "$($journal.Count) sor" } else { 'nincs' }))
    }
    exit 0
}

if (-not $Project) { throw 'Az add/remove művelethez kell a -Project.' }
$projectProfile = Read-DevProfile -Root $Project
$journal = Read-Journal -Root $Project
$names = Get-HostNames

if ($Action -eq 'add') {
    if ($names.ContainsKey($projectProfile.domain)) {
        Write-Host ("  {0} már szerepel a hosts fájlban — nincs teendő" -f $projectProfile.domain)
        exit 0
    }
    $line = "127.0.0.1`t{0}`t{1}" -f $projectProfile.domain, $Marker
    Write-Host ("  hozzáadandó sor: {0}" -f $line)
    if ($DryRun) { Write-Host '  (DryRun: nem ír)'; exit 0 }
    if (-not $elevated) {
        Write-Host ''
        Write-Host 'EMELT HATALOM KELL a hosts fájl írásához. Futtasd emelt PowerShell-ben:'
        Write-Host ("  pwsh -NoProfile -File `"{0}`" -Action add -Project `"{1}`"" -f $PSCommandPath, $Project)
        exit 2
    }
    Add-Content -Path $HostsFile -Value $line -Encoding ASCII
    $journal = @($journal) + @([pscustomobject]@{ domain = $projectProfile.domain; line = $line; addedAt = (Get-Date).ToString('s') })
    Write-Journal -Root $Project -Entries $journal
    Write-Host ("  hozzáadva; nyilvántartás: {0}" -f (Get-JournalPath -Root $Project))
    exit 0
}

if ($Action -eq 'remove') {
    if (-not $journal -or @($journal).Count -eq 0) { Write-Host '  nincs nyilvántartott sor — nincs mit törölni'; exit 0 }
    Write-Host ("  eltávolítandó {0} nyilvántartott sor" -f @($journal).Count)
    if ($DryRun) { Write-Host '  (DryRun: nem ír)'; exit 0 }
    if (-not $elevated) {
        Write-Host ''
        Write-Host 'EMELT HATALOM KELL a hosts fájl írásához. Futtasd emelt PowerShell-ben:'
        Write-Host ("  pwsh -NoProfile -File `"{0}`" -Action remove -Project `"{1}`"" -f $PSCommandPath, $Project)
        exit 2
    }
    $keep = @()
    foreach ($entry in @($journal)) {
        $expected = $entry.line
        foreach ($existing in (Get-Content $HostsFile)) {
            if ($existing.Trim() -ne $expected.Trim()) { $keep += $existing }
        }
    }
    Set-Content -Path $HostsFile -Value $keep -Encoding ASCII
    Write-Journal -Root $Project -Entries @()
    Write-Host '  a nyilvántartott sorok törölve; a nyilvántartás üres'
    exit 0
}
