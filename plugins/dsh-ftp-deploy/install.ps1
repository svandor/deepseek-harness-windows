<#
.SYNOPSIS
    A `dsh-ftp-deploy` plugin telepítése / ellenőrzése / visszavonása.

.DESCRIPTION
    A plugin két oldalból áll:
      * HOST (lib/index.js): `/ftp/*` végpontok — profilok, előnézet, deploy,
        állapot, távoli mappa, ZIP-mentés, napló. A feltöltés a host
        folyamatában fut, tehát NEM nyílik konzolablak (AGENTS §1).
      * KLIENS (lib/client.js): az „FTP" fül a jobb oldalsávban + a Git panel
        „FTP deploy" gyorsgombja (a dsh-ui-extras kliensében).

    Két dolgot végez el, ismételhetően:
      1. junction a `%USERPROFILE%\.dsh\profiles\node_modules\dsh-ftp-deploy`
         -> `<repó>\plugins\dsh-ftp-deploy`
      2. `- insert:` bejegyzés a `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`-be

    FONTOS: a host-kompozíció boot-időben töltődik, ezért a bejegyzés csak a
    harness újraindítása után él. Ez a szkript NEM indít újra semmit.

    A függőségek (basic-ftp, yazl, buffer-crc32 — mind MIT) a `vendor\`
    mappában utaznak a repóval, ezért nincs `npm install` a felhasználónál.

.PARAMETER Check
    Csak ellenőriz (junction + patch bejegyzés + node oldali betölthetőség +
    a beágyazott függőségek megléte).

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
$junctionPath = Join-Path $dshHome 'profiles\node_modules\dsh-ftp-deploy'
$patchPath = Join-Path $dshHome 'profiles\web\cordis.patch.yml'
$entryName = 'dsh-ftp-deploy'
$entryId = 'ftp'

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

$vendorFiles = @(
    'vendor\node_modules\basic-ftp\dist\index.js',
    'vendor\node_modules\yazl\index.js',
    'vendor\node_modules\buffer-crc32\dist\index.cjs'
)

function Test-Vendor {
    $missing = @()
    foreach ($rel in $vendorFiles) {
        if (-not (Test-Path (Join-Path $pluginRoot $rel))) { $missing += $rel }
    }
    return $missing
}

if ($Check) {
    $problems = 0
    $junction = Get-JunctionState
    Write-Host ("junction : {0} -> {1}" -f $junction, $junctionPath)
    if ($junction -ne 'ok') { $problems++ }
    $patch = Get-PatchState
    Write-Host ("patch    : {0} ({1})" -f $patch, $patchPath)
    if ($patch -ne 'present') { $problems++ }
    $missing = Test-Vendor
    if ($missing.Count -eq 0) {
        Write-Host 'vendor   : basic-ftp + yazl + buffer-crc32 megvan'
    } else {
        Write-Host ("vendor   : HIÁNYZIK: {0}" -f ($missing -join ', ')) -ForegroundColor Red
        $problems++
    }
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $url = 'file:///' + ($junctionPath -replace '\\', '/' -replace ' ', '%20') + '/lib/index.js'
        $probe = "const m = await import('$url'); console.log(m.inject ? m.inject.join(',') : 'NINCS-INJECT');"
        $out = & node --input-type=module -e $probe 2>&1 | Out-String
        Write-Host ("node     : {0}" -f ($out.Trim()))
        if ($out -notmatch 'webServer') { $problems++ }
        # a motor betölthetősége (a beágyazott függőségekkel együtt)
        $url2 = 'file:///' + ($junctionPath -replace '\\', '/' -replace ' ', '%20') + '/lib/engine/vendor.js'
        $probe2 = "const v = await import('$url2'); console.log('Client=' + typeof v.Client + ' ZipFile=' + typeof v.ZipFile);"
        $out2 = & node --input-type=module -e $probe2 2>&1 | Out-String
        Write-Host ("motor    : {0}" -f ($out2.Trim()))
        if ($out2 -notmatch 'Client=function') { $problems++ }
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

$missing = Test-Vendor
if ($missing.Count -gt 0) {
    throw "A beágyazott függőségek hiányoznak: $($missing -join ', ')"
}
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
        '# ── FTP deploy (2026-11-16) ────────────────────────────────────────────────',
        '# /ftp/* — profilok, előnézet, git-diff alapú feltöltés, állapot, ZIP-mentés.',
        '# A motor a Felpuffantó 0.1.5-ből portolt (basic-ftp + yazl beágyazva).',
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
