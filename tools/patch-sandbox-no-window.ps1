#Requires -Version 7.0
<#
.SYNOPSIS
    A DSH mag sandbox-indításának foltja: a gyermekek REJTETT konzolt kapjanak.

.DESCRIPTION
    MÉRT HIBA (2026-11-16 12:57–13:12): a Harness ablaktalan folyamat, a
    `@deepseek-ai/dsh-win32-process` viszont a sandbox gyermekeit
    `creationFlags = 0`-val hozta létre (`CreateProcessAsUserW`), ezért minden
    eszközhívás gyermeke — a `dsh-sandbox-windows-acl` runner `node.exe`-e —
    SAJÁT, LÁTHATÓ konzolablakot kapott (a felhasználó „folyamatosan jövő
    node.exe ablakokat" látott).

    ELSŐ PRÓBÁLKOZÁS (2026-11-16 13:00, HIBÁS): `CREATE_NO_WINDOW` a
    létrehozási jelzőkbe. A Harness újraindult, a folt betöltődött, MÉGIS
    megjelentek az ablakok (13:12:23, 13:12:30). Ok: a `CREATE_NO_WINDOW`
    gyermeknek EGYÁLTALÁN NINCS konzolja, ezért amikor ő indít egy konzolos
    programot (`node`, `git`, `powershell`), a Windows ÚJ, LÁTHATÓ konzolt
    hoz neki — a nagyapa ablaktalansága nem öröklődik, a rejtett konzol igen.

    HELYES MÓDSZER (ezt alkalmazza ez a szkript) — ugyanaz, amit a Node
    `windowsHide: true` is tesz (libuv): a `STARTUPINFOW`-ban
    `dwFlags = 256 | 1` (`STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW`) és
    `wShowWindow = 0` (`SW_HIDE`), a létrehozási jelzők pedig maradnak az
    eredetiek (`0`, `4`, `1028`). Így a gyermek KAP konzolt, csak rejtve, és
    azt a saját gyermekei ÖRÖKLIK → nem jön létre több látható ablak.

    MIVEL a `node_modules` a DSH telepítés része, a folt a DSH következő
    verziójánál ELVÉSZ — ez a szkript idempotensen újra alkalmazza, és a
    korábbi (hibás) `CREATE_NO_WINDOW` foltot is visszafordítja.

.PARAMETER Check
    Csak jelenti, hogy a folt megvan-e (nem ír).

.EXAMPLE
    .\tools\patch-sandbox-no-window.ps1            # alkalmazás + jelentés
    .\tools\patch-sandbox-no-window.ps1 -Check     # csak ellenőrzés
#>
[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = 'Stop'
# A folt jelenlétének jelölője (a konstans neve, nem egy 9 jegyű szám).
$MARKER = 'HIDDEN_CONSOLE_FLAGS'
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

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

function Remove-LegacyPatch {
    param([string]$Path)
    # A korábbi (hibás) folt: egy /** ... */ blokk + `const CREATE_NO_WINDOW = <szam>;`
    # sor, valamint a létrehozási jelzőkbe írt `| CREATE_NO_WINDOW`.
    $lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $Path -Encoding UTF8)
    $declIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*const\s+CREATE_NO_WINDOW\s*=\s*\d+\s*;\s*$') { $declIdx = $i; break }
    }
    if ($declIdx -ge 0) {
        $removeFrom = $declIdx
        for ($j = $declIdx - 1; $j -ge 0; $j--) {
            $t = $lines[$j].Trim()
            if ($t -eq '*/' -or $t.StartsWith('*') -or $t.StartsWith('/**') -or $t.StartsWith('/*')) {
                $removeFrom = $j
                if ($t.StartsWith('/**') -or $t.StartsWith('/*')) { break }
                continue
            }
            break
        }
        $lines.RemoveRange($removeFrom, $declIdx - $removeFrom + 1)
    }
    $text = $lines -join "`n"
    $text = $text.Replace('4 | CREATE_NO_WINDOW, startupInfo', '4, startupInfo')
    $text = $text.Replace('1028 | CREATE_NO_WINDOW, environment', '1028, environment')
    $text = $text.Replace('CREATE_NO_WINDOW, startupInfo, processInfo', '0, startupInfo, processInfo')
    return $text
}

$constBlock = @'
/**
 * STARTF_USESHOWWINDOW - HELYI FOLTAS (tools\patch-sandbox-no-window.ps1).
 * A Harness ablaktalan, ezert a sandbox gyermekeit REJTETT konzollal kell
 * inditani: dwFlags 256|1 + wShowWindow 0 (ugyanaz, amit a Node windowsHide
 * tesz). A csak "nincs konzol" (CREATE_NO_WINDOW) nem eleg: a gyermek sajat
 * gyermeke (node, git) MAR nem orokli a semmit, ezert uj LATHATO ablakot kap
 * (MERT HIBA 2026-11-16 13:12). Igy a rejtett konzolt a gyermekek oroklik.
 */
const HIDDEN_CONSOLE_FLAGS = 1;
'@

$patched = 0
$already = 0
$failed = 0
foreach ($file in $candidates) {
    $path = $file.FullName
    $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    $hasLegacy = $text -match 'const\s+CREATE_NO_WINDOW\s*=\s*\d+\s*;'
    if ($text.Contains($MARKER) -and -not $hasLegacy) {
        $already++
        if ($Check) { Write-Host ("OK      {0}" -f $path) -ForegroundColor Green }
        continue
    }
    if ($Check) {
        Write-Host ("NINCS   {0}{1}" -f $path, $(if ($hasLegacy) { ' (regi, hibas folt)' } else { '' })) -ForegroundColor Red
        continue
    }

    if ($hasLegacy) { $text = Remove-LegacyPatch -Path $path }

    # 1) a konstans a createRestrictedProcess elott
    if (-not $text.Contains($MARKER)) {
        $anchor = 'function createRestrictedProcess(api, options, commandLine, creationFlags, startupInfo, processInfo) {'
        if (-not $text.Contains($anchor)) {
            Write-Host ("HIBA    a folt nem illeszkedett (nincs horgony): {0}" -f $path) -ForegroundColor Red
            $failed++
            continue
        }
        $text = $text.Replace($anchor, $constBlock + "`n" + $anchor)
    }

    # 2) a STARTUPINFO minden epitkezese kapja meg a rejtett konzol jelzot
    $infoBefore = ([regex]::Matches($text, 'dwFlags:\s*256,')).Count
    if ($infoBefore -gt 0) {
        $text = [regex]::Replace(
            $text,
            'dwFlags:\s*256,(\r?\n)(\s*)hStdInput:',
            'dwFlags: 256 | HIDDEN_CONSOLE_FLAGS,$1$2wShowWindow: 0,$1$2hStdInput:')
    }
    # 3) a letrehozasi jelzok maradnak az eredetiek (a korabbi folt visszaforditva)
    $text = $text.Replace('4 | CREATE_NO_WINDOW, startupInfo', '4, startupInfo')
    $text = $text.Replace('1028 | CREATE_NO_WINDOW, environment', '1028, environment')
    $text = $text.Replace('CREATE_NO_WINDOW, startupInfo, processInfo', '0, startupInfo, processInfo')

    # Csak a KÓDBELI használatot vizsgáljuk (a konstans kommentje említi a régi nevet).
    if (-not $text.Contains($MARKER) -or ($text -match '(?m)^\s*const\s+CREATE_NO_WINDOW|CREATE_NO_WINDOW\s*,\s*(startupInfo|environment)')) {
        Write-Host ("HIBA    a folt nem illeszkedett: {0}" -f $path) -ForegroundColor Red
        $failed++
        continue
    }
    if (-not (Test-Path ($path + '.bak-sandboxwindow'))) {
        Copy-Item -LiteralPath $path ($path + '.bak-sandboxwindow') -Force
    }
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
    $patched++
    Write-Host ("FOLTOZVA {0} ({1} STARTUPINFO hely)" -f $path, $infoBefore) -ForegroundColor Green
}

Write-Host ''
Write-Host ("Folt alkalmazva: {0} fajl; mar foltozott: {1}; hiba: {2}; ellenorzes: {3}" -f $patched, $already, $failed, [bool]$Check)
if ($patched -gt 0) { Write-Host 'Ervenybe lepes: a Harness kovetkezo indulasa (a modul boot-kor toltodik).' -ForegroundColor Yellow }
if ($failed -gt 0) { exit 1 }
