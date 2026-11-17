<#
.SYNOPSIS
    A `dsh-koltseg` plugin (fejlesztési költségelszámolás) telepítése.

.DESCRIPTION
    A plugin két oldalból áll:
      * HOST (lib/index.js): `/koltseg/*` végpontok — mérés, konfiguráció,
        aktivitás, elszámolás-rögzítés, CSV. A számítás a host folyamatában fut,
        tehát NEM nyílik konzolablak (AGENTS §1).
      * KLIENS (lib/client.js): ikon+tooltip gomb a menüsorban, ami LEBEGŐ
        ABLAKOT nyit; plusz egy láthatatlan aktivitás-mérő komponens.

    Két dolgot végez el, ismételhetően:
      1. junction a `%USERPROFILE%\.dsh\profiles\node_modules\dsh-koltseg`
         -> `<repó>\plugins\dsh-koltseg`
      2. `- insert:` bejegyzés a `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`-be

    FONTOS: a host-kompozíció boot-időben töltődik, ezért a bejegyzés csak a
    harness KÖVETKEZŐ indítása után él. Ez a szkript NEM indít újra semmit
    (AGENTS §1.5: futó munka közben tilos).

.PARAMETER Check
    Csak ellenőriz (junction + patch bejegyzés + node oldali betölthetőség).

.PARAMETER Remove
    Visszavonja a telepítést (bejegyzés + junction). A plugint nem törli.
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$pluginRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $pluginRoot)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$junctionPath = Join-Path $dshHome 'profiles\node_modules\dsh-koltseg'
$patchPath = Join-Path $dshHome 'profiles\web\cordis.patch.yml'
$entryName = 'dsh-koltseg'
$entryId = 'koltseg'

function Get-JunctionState {
    if (-not (Test-Path $junctionPath)) { return 'missing' }
    $item = Get-Item $junctionPath -Force
    if ($item.LinkType -ne 'Junction') { return "nem-junction:$($item.LinkType)" }
    $target = ($item.Target | Select-Object -First 1)
    if ((Resolve-Path $target).Path -eq (Resolve-Path $pluginRoot).Path) { return 'ok' }
    return "mas-cel:$target"
}

function Get-PatchState {
    if (-not (Test-Path $patchPath)) { return 'missing-patch' }
    $text = Get-Content $patchPath -Raw
    if ($text -match "(?m)^\s*name:\s*'?$([regex]::Escape($entryName))'?\s*$") { return 'present' }
    return 'absent'
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($Check) {
    $problems = 0
    $junction = Get-JunctionState
    Write-Host ("junction : {0} -> {1}" -f $junction, $junctionPath)
    if ($junction -ne 'ok') { $problems++ }
    $patch = Get-PatchState
    Write-Host ("patch    : {0} ({1})" -f $patch, $patchPath)
    if ($patch -ne 'present') { $problems++ }

    if (Get-Command node -ErrorAction SilentlyContinue) {
        $url = 'file:///' + ($junctionPath -replace '\\', '/' -replace ' ', '%20') + '/lib/index.js'
        $probe = "const m = await import('$url'); console.log(m.inject ? m.inject.join(',') : 'NINCS-INJECT');"
        $out = & node --input-type=module -e $probe 2>&1 | Out-String
        Write-Host ("node     : {0}" -f ($out.Trim()))
        if ($out -notmatch 'webServer') { $problems++ }

        # a motor betölthetősége + a mérés belépőpontja
        $url2 = 'file:///' + ($junctionPath -replace '\\', '/' -replace ' ', '%20') + '/lib/engine/calc.js'
        $probe2 = "const m = await import('$url2'); console.log('measure=' + typeof m.measure + ' sessionList=' + typeof m.sessionList);"
        $out2 = & node --input-type=module -e $probe2 2>&1 | Out-String
        Write-Host ("motor    : {0}" -f ($out2.Trim()))
        if ($out2 -notmatch 'measure=function') { $problems++ }

        # a kliens bundle betölthetősége stubolt loaderrel (nem kell böngésző)
        $clientPath = Join-Path $pluginRoot 'lib\client.js'
        if (Test-Path $clientPath) {
            $probe3 = @"
import { readFileSync } from 'node:fs';
const src = readFileSync(String.raw``$clientPath``, 'utf8');
let def = null;
const win = { __ModuleLoader__: { load(d) { def = d; } } };
new Function('window', 'module', 'exports', 'require', src)(win, { exports: {} }, {}, () => { throw new Error('nincs modul'); });
console.log(def && def.id === 'dsh-koltseg' ? 'kliens=ok' : 'kliens=HIBA');
"@
            $out3 = & node --input-type=module -e $probe3 2>&1 | Out-String
            Write-Host ("kliens   : {0}" -f ($out3.Trim()))
            if ($out3 -notmatch 'kliens=ok') { $problems++ }
        }
    } else {
        Write-Host 'node     : nincs a PATH-ban'
        $problems++
    }
    Write-Host ''
    if ($problems -eq 0) { Write-Host 'EREDMÉNY: rendben (a következő harness-indításnál aktív)'; exit 0 }
    Write-Host "EREDMÉNY: $problems probléma"; exit 1
}

if ($Remove) {
    if (Test-Path $patchPath) {
        $lines = Get-Content $patchPath
        $kept = New-Object System.Collections.Generic.List[string]
        $skipNext = $false
        foreach ($line in $lines) {
            if ($line -match "^\s*-\s*id:\s*$([regex]::Escape($entryId))\s*$") { $skipNext = $true; continue }
            if ($skipNext -and $line -match "^\s*name:\s*'?$([regex]::Escape($entryName))'?\s*$") { $skipNext = $false; continue }
            $skipNext = $false
            $kept.Add($line)
        }
        if ($kept.Count -ne $lines.Count) {
            $backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Copy-Item $patchPath $backup
            [IO.File]::WriteAllLines($patchPath, $kept, $utf8NoBom)
            Write-Host "patch    : bejegyzés törölve (mentés: $backup)"
        } else {
            Write-Host 'patch    : nem volt bejegyzés'
        }
    }
    if (Test-Path $junctionPath) {
        $item = Get-Item $junctionPath -Force
        if ($item.LinkType -eq 'Junction') {
            [IO.Directory]::Delete($junctionPath)
            Write-Host 'junction : törölve'
        } else {
            Write-Host "junction : NEM junction: $junctionPath"
        }
    }
    Write-Host 'KÉSZ. A visszavonás a következő harness-indításnál él.'
    exit 0
}

Write-Host "repó     : $repoRoot"
Write-Host "plugin   : $pluginRoot"
Write-Host "DSH home : $dshHome"

if (-not (Test-Path (Split-Path $junctionPath -Parent))) {
    throw "A profilok node_modules-a nem létezik: $(Split-Path $junctionPath -Parent)"
}
if (-not (Test-Path $patchPath)) {
    throw "A profil-patch nem található: $patchPath"
}

$junction = Get-JunctionState
if ($junction -eq 'ok') {
    Write-Host 'junction : már rendben'
} elseif (Test-Path $junctionPath) {
    throw "A hely foglalt, de nem a várt junction ($junction): $junctionPath"
} else {
    New-Item -ItemType Junction -Path $junctionPath -Target $pluginRoot | Out-Null
    Write-Host "junction : létrehozva -> $pluginRoot"
}

$patch = Get-PatchState
if ($patch -eq 'present') {
    Write-Host 'patch    : már tartalmazza a bejegyzést'
} else {
    $backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $patchPath $backup
    Write-Host "patch    : mentés -> $backup"
    $addition = @(
        '',
        '',
        '# ── Fejlesztesi koltsegelszamolas (2026-11-16) ──────────────────────────────',
        '# /koltseg/* — a munkafolyamat / munkaterulet / idoszak ideje es dijja',
        '# (alap 12 500 Ft/ora, reponként felulirhato; profilok + sulyok).',
        '# A meres a tartos session-naplokbol keszul; a kliens aktivitas-vodrokbol',
        '# jon az olvasas/gepeles bontas. Kikapcsolas: .\plugins\dsh-koltseg\install.ps1 -Remove',
        "- insert:",
        "    - id: $entryId",
        "      name: $entryName"
    )
    [IO.File]::AppendAllText($patchPath, (($addition -join "`r`n") + "`r`n"), $utf8NoBom)
    Write-Host 'patch    : bejegyzés hozzáadva'
}

Write-Host ''
Write-Host 'KÉSZ. A plugin a következő harness-indításnál lép életbe (host-kompozíció).'
Write-Host "Ellenőrzés: pwsh -NoProfile -File $PSCommandPath -Check"
