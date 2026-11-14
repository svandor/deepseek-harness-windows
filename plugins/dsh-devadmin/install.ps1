<#
.SYNOPSIS
    A `dsh-devadmin` HOST-síkos plugin telepítése / ellenőrzése / visszavonása.

.DESCRIPTION
    A plugin a DSH web-szerverére regisztrálja az admin felületet:

        GET /devadmin/         — az admin oldal (önálló HTML, nincs build)
        GET /devadmin/state    — JSON állapot (dev szerver, projektek, PHP, portok, autostart)
        GET /devadmin/action   — start | stop | restart | php-use | check-hosts
        GET /devadmin/logs     — a Caddy és a php-cgi naplók vége

    Két dolgot végez el, ismételhetően:
      1. junction a `%USERPROFILE%\.dsh\profiles\node_modules\dsh-devadmin`
         -> `<repó>\plugins\dsh-devadmin`
      2. `- insert:` bejegyzés a `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`-be

    FONTOS: a host-kompozíció boot-időben töltődik, ezért a bejegyzés csak a
    harness újraindítása után él. Ez a szkript NEM indít újra semmit.

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
$junctionPath = Join-Path $dshHome 'profiles\node_modules\dsh-devadmin'
$patchPath = Join-Path $dshHome 'profiles\web\cordis.patch.yml'
$entryName = 'dsh-devadmin'
$entryId = 'devadmin'

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
    } else {
        Write-Host 'node     : nincs a PATH-ban'
        $problems++
    }
    if (Test-Path (Join-Path $pluginRoot 'web\index.html')) {
        Write-Host 'oldal    : web\index.html megvan'
    } else {
        Write-Host 'oldal    : HIÁNYZIK (web\index.html)'
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
            [IO.File]::WriteAllLines($patchPath, $kept, (New-Object System.Text.UTF8Encoding($false)))
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
        '# ── dev-környezet admin felület (2026-11-14) ─────────────────────────────',
        '# /devadmin/ — Caddy + php-cgi, PHP-verziók, portok, autostart, naplók.',
        '# A host a tools\dev.ps1-et hívja, tehát egy kódút van (CLI = UI).',
        "- insert:",
        "    - id: $entryId",
        "      name: $entryName"
    )
    Add-Content -Path $patchPath -Value $addition -Encoding UTF8
    Write-Host 'patch    : bejegyzés hozzáadva'
}

Write-Host ''
Write-Host 'KÉSZ. A plugin a következő harness-indításnál lép életbe (host-kompozíció).'
Write-Host "Ellenőrzés: pwsh -NoProfile -File $PSCommandPath -Check"
