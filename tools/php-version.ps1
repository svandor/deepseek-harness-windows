<#
.SYNOPSIS
    PHP-verzióválasztó a DSH dev-környezethez (Herd nélkül).

.DESCRIPTION
    A Herd-kiváltás előfeltétele, hogy a projekt a SAJÁT PHP-ját kapja, ne a
    Herd `bin` könyvtárát. Ez a szkript a verziókönyvtárakat kezeli:

        D:\Tools\php\<verzió>\        (pl. 8.4.27)
        D:\Tools\php\current\         -> junction a kiválasztott verzióra

    A `-Use <verzió>` átállítja a `current` junctiont. A projekt
    `.dsh\dev.yaml`-jában a `php:` kulcs a főverziót kéri (pl. "8.4"), a
    `tools\dev.ps1` pedig a `current`-öt használja — így a projekt PHP-ja
    független a Herdtől, és a verzióváltás egy paranccsal megy.

.PARAMETER List
    A telepített verziók felsorolása és a jelenlegi kiválasztás.

.PARAMETER Use
    A kiválasztandó verzió (könyvtárnév vagy főverzió, pl. 8.4 vagy 8.4.27).

.EXAMPLE
    pwsh -NoProfile -File tools\php-version.ps1 -List
    pwsh -NoProfile -File tools\php-version.ps1 -Use 8.4
#>
[CmdletBinding()]
param(
    [switch]$List,
    [string]$Use,
    [string]$Root = 'D:\Tools\php'
)

$ErrorActionPreference = 'Stop'

function Get-Versions {
    if (-not (Test-Path $Root)) { return @() }
    return @(Get-ChildItem $Root -Directory | Where-Object { $_.Name -match '^\d+\.\d+' } | Sort-Object Name)
}

function Get-CurrentTarget {
    $current = Join-Path $Root 'current'
    if (-not (Test-Path $current)) { return $null }
    $item = Get-Item $current -Force
    if ($item.LinkType -ne 'Junction') { return "NEM junction: $($item.FullName)" }
    return ($item.Target | Select-Object -First 1)
}

$versions = Get-Versions
$current = Get-CurrentTarget

if ($Use) {
    if (-not (Test-Path $Root)) {
        throw "A PHP gyökér nem létezik: $Root. Hozd létre, és tedd alá a verziókönyvtárakat (pl. 8.4.27)."
    }
    $match = $versions | Where-Object { $_.Name -eq $Use } | Select-Object -First 1
    if (-not $match) {
        # főverzió szerinti egyezés (8.4 -> 8.4.27), a legnagyobb verzió nyer
        $match = $versions | Where-Object { $_.Name -like "$Use.*" } | Sort-Object Name -Descending | Select-Object -First 1
    }
    if (-not $match) {
        $available = ($versions | ForEach-Object { $_.Name }) -join ', '
        throw "Nincs ilyen verzió: $Use. Telepített verziók: $($(if ($available) { $available } else { 'egy sem' }))"
    }
    $phpExe = Join-Path $match.FullName 'php.exe'
    if (-not (Test-Path $phpExe)) {
        throw "A kiválasztott verzióban nincs php.exe: $phpExe"
    }
    $currentPath = Join-Path $Root 'current'
    if (Test-Path $currentPath) {
        $item = Get-Item $currentPath -Force
        if ($item.LinkType -eq 'Junction') {
            # junction törlése a cél érintése nélkül
            [IO.Directory]::Delete($currentPath)
        } else {
            throw "A 'current' létezik, de nem junction: $currentPath (kézzel kell megnézni)"
        }
    }
    New-Item -ItemType Junction -Path $currentPath -Target $match.FullName | Out-Null
    $version = ((& $phpExe -r 'echo PHP_VERSION;' 2>$null) -join '').Trim()
    Write-Host ("beállítva: {0} -> {1}  (php {2})" -f $currentPath, $match.FullName, $version)
    Write-Host "A PATH-ban a D:\Tools\php\current legyen elöl, hogy a 'php' ezt lássa."
    exit 0
}

Write-Host "=== PHP verziók ($Root) ==="
if ($versions.Count -eq 0) {
    Write-Host '  (nincs telepített verzió)'
} else {
    foreach ($v in $versions) {
        $mark = ''
        if ($current -and ((Resolve-Path $current -ErrorAction SilentlyContinue).Path -eq (Resolve-Path $v.FullName).Path)) { $mark = '  <- aktuális' }
        Write-Host ("  {0}{1}" -f $v.Name, $mark)
    }
}
Write-Host ("aktuális: {0}" -f $(if ($current) { $current } else { '(nincs beállítva)' }))
$phpCmd = Get-Command php -ErrorAction SilentlyContinue
if ($phpCmd) { Write-Host ("a PATH-ban lévő php: {0}" -f $phpCmd.Source) }
