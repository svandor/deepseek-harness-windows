#Requires -Version 7.0
<#
.SYNOPSIS
    A DSH mag sandbox-indításának foltja: ne kapjon látható konzolablakot.

.DESCRIPTION
    MÉRT HIBA (2026-11-16 12:57): a Harness ablaktalan folyamat, a
    `@deepseek-ai/dsh-win32-process` viszont a sandbox gyermekeit
    `creationFlags = 0`-val hozta létre (`CreateProcessAsUserW`), ezért minden
    eszközhívás gyermeke — a `dsh-sandbox-windows-acl` runner `node.exe`-e —
    SAJÁT, LÁTHATÓ konzolablakot kapott. A felhasználó „folyamatosan jövő
    node.exe ablakokat" látott. A `CREATE_NO_WINDOW` (0x08000000) ezt megszünteti.

    MIVEL a `node_modules` a DSH telepítés része, a folt a DSH következő
    verziójánál ELVÉSZ — ez a szkript idempotensen újra alkalmazza.

.PARAMETER Check
    Csak jelenti, hogy a folt megvan-e (nem ír).

.EXAMPLE
    .\tools\patch-sandbox-no-window.ps1            # alkalmazás + jelentés
    .\tools\patch-sandbox-no-window.ps1 -Check     # csak ellenőrzés
#>
[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$MARKER = 'CREATE_NO_WINDOW = 134217728'
$ROOT = Split-Path -Parent $PSScriptRoot

# A DSH telepítés helyei: az npx-gyorsítótár és a profil node_modules.
$candidates = @()
foreach ($base in @(
        (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'),
        (Join-Path $env:USERPROFILE '.dsh\profiles\node_modules')
    )) {
    if (-not (Test-Path $base)) { continue }
    $candidates += @(Get-ChildItem -Path $base -Recurse -File -Filter 'index.js' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'dsh-win32-process[\\/]lib[\\/]index\.js$' })
}

if ($candidates.Count -eq 0) {
    Write-Host 'Nem talaltam a dsh-win32-process csomagot (npx / profil node_modules).' -ForegroundColor Yellow
    exit 0
}

$patched = 0
$already = 0
foreach ($file in $candidates) {
    $text = Get-Content $file.FullName -Raw
    if ($text.Contains($MARKER)) {
        $already++
        if ($Check) { Write-Host ("OK      {0}" -f $file.FullName) -ForegroundColor Green }
        continue
    }
    if ($Check) {
        Write-Host ("NINCS   {0}" -f $file.FullName) -ForegroundColor Red
        continue
    }

    $constBlock = @"
/**
 * CREATE_NO_WINDOW (0x08000000) - HELYI FOLTAS (tools\patch-sandbox-no-window.ps1).
 * A Harness ablaktalan, ezert a sandbox gyermekeit ablak nelkul kell inditani;
 * enelkul minden eszkozhivas lathato node.exe konzolablakot kapott (MERT HIBA
 * 2026-11-16). A DSH kovetkezo verziojanal ujra kell alkalmazni.
 */
const CREATE_NO_WINDOW = 134217728;
function createRestrictedProcess(api, options, commandLine, creationFlags, startupInfo, processInfo) {
"@
    $text = $text.Replace("function createRestrictedProcess(api, options, commandLine, creationFlags, startupInfo, processInfo) {", $constBlock.TrimEnd("`r", "`n"))
    $text = $text.Replace(
        ', 0, startupInfo, processInfo) === 0) throwWin32(api, "CreateProcessAsUserW"',
        ', CREATE_NO_WINDOW, startupInfo, processInfo) === 0) throwWin32(api, "CreateProcessAsUserW"')
    $text = $text.Replace(
        'commandLine, 4, startupInfo, processInfo)',
        'commandLine, 4 | CREATE_NO_WINDOW, startupInfo, processInfo)')
    $text = $text.Replace(
        '1, 1028, environment',
        '1, 1028 | CREATE_NO_WINDOW, environment')

    if (-not $text.Contains($MARKER)) {
        Write-Host ("HIBA    a folt nem illeszkedett: {0}" -f $file.FullName) -ForegroundColor Red
        continue
    }
    Copy-Item $file.FullName ($file.FullName + '.bak-sandboxwindow') -Force
    [IO.File]::WriteAllText($file.FullName, $text, (New-Object Text.UTF8Encoding($false)))
    $patched++
    Write-Host ("FOLTOZVA {0}" -f $file.FullName) -ForegroundColor Green
}

Write-Host ''
Write-Host ("Folt alkalmazva: {0} fajl; mar foltozott: {1}; ellenorzes: {2}" -f $patched, $already, [bool]$Check)
if ($patched -gt 0) { Write-Host 'Ervenybe lepes: a Harness kovetkezo indulasa (a modul boot-kor toltodik).' -ForegroundColor Yellow }
