<#
.SYNOPSIS
    A `dsh-terminal-tool` agent-síkos plugin telepítése a DSH-ba.

.DESCRIPTION
    Két dolgot végez el, ismételhetően (idempotens):

      1. junction a profilok `node_modules`-ába:
         `%USERPROFILE%\.dsh\profiles\node_modules\dsh-terminal-tool`
         -> `<repó>\plugins\dsh-terminal-tool`
      2. bejegyzés az agent-síkos preset kompozíciójába:
         `%USERPROFILE%\.dsh\.agent-presets\standard-free\agent.cordis.yml`

    A host-oldali felet (a terminál-postafiók figyelése) a `dsh-ui-extras`
    adja; az már telepítve van, itt nincs teendő.

    FONTOS: az agent-síkos preset kompozíciója a **session létrehozásakor**
    töltődik, ezért a bejegyzés csak új sessionben (vagy a harness
    újraindítása után) jelenik meg. Ez a szkript NEM indít újra semmit.

.PARAMETER Check
    Csak ellenőriz (junction + preset bejegyzés + node oldali betölthetőség).

.PARAMETER Remove
    Visszavonja a telepítést (bejegyzés + junction). A plugint nem törli.

.PARAMETER Preset
    A preset neve a `~\.dsh\.agent-presets` alatt. Alapértelmezés: standard-free.

.EXAMPLE
    pwsh -NoProfile -File plugins\dsh-terminal-tool\install.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Remove,
    [string]$Preset = 'standard-free'
)

$ErrorActionPreference = 'Stop'

# A `$PSScriptRoot` a `param()` alapértékeiben üres lehet (Windows PowerShell
# 5.1, mért eset), ezért a származtatás a törzsben történik.
$pluginRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $pluginRoot)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$junctionPath = Join-Path $dshHome 'profiles\node_modules\dsh-terminal-tool'
$presetPath = Join-Path $dshHome ".agent-presets\$Preset\agent.cordis.yml"
$entryName = 'dsh-terminal-tool'
$entryId = 'tool-terminal'

function Get-PresetState {
    if (-not (Test-Path $presetPath)) { return 'missing-preset' }
    $text = Get-Content $presetPath -Raw
    if ($text -match "(?m)^\s*name:\s*'?$([regex]::Escape($entryName))'?\s*$") { return 'present' }
    return 'absent'
}

function Get-JunctionState {
    if (-not (Test-Path $junctionPath)) { return 'missing' }
    $item = Get-Item $junctionPath -Force
    if ($item.LinkType -ne 'Junction') { return "nem-junction:$($item.LinkType)" }
    $target = ($item.Target | Select-Object -First 1)
    if ((Resolve-Path $target).Path -ne (Resolve-Path $pluginRoot).Path) { return "mas-cél:$target" }
    return 'ok'
}

# ── ellenőrzés ────────────────────────────────────────────────────────────
if ($Check) {
    $problems = 0
    $junction = Get-JunctionState
    Write-Host ("junction : {0} -> {1}" -f $junction, $junctionPath)
    if ($junction -ne 'ok') { $problems++ }
    $preset = Get-PresetState
    Write-Host ("preset   : {0} ({1})" -f $preset, $presetPath)
    if ($preset -ne 'present') { $problems++ }

    if (Get-Command node -ErrorAction SilentlyContinue) {
        $probe = "const m = await import('file:///" + ($junctionPath -replace '\\', '/' -replace ' ', '%20') + "/lib/index.js');"
        $probe += " let d = null; await m.apply({ tools: { register: (x) => { d = x; } }, logger: { warn() {} } });"
        $probe += " const okParams = d?.parameters?.type === 'object';"
        $probe += " console.log(okParams ? 'PARAMS-OK' : 'PARAMS-RAW');"
        $out = & node --input-type=module -e $probe 2>&1 | Out-String
        Write-Host ("node     : {0}" -f ($out.Trim()))
        if ($out -notmatch 'PARAMS-OK') { $problems++ }
    } else {
        Write-Host 'node     : nincs a PATH-ban, a betölthetőség nem ellenőrizhető'
        $problems++
    }

    Write-Host ''
    if ($problems -eq 0) { Write-Host 'EREDMÉNY: rendben (a tool új sessionben jelenik meg)'; exit 0 }
    Write-Host "EREDMÉNY: $problems probléma"; exit 1
}

# ── visszavonás ───────────────────────────────────────────────────────────
if ($Remove) {
    if (Test-Path $presetPath) {
        $lines = Get-Content $presetPath
        $kept = New-Object System.Collections.Generic.List[string]
        $skipNext = $false
        foreach ($line in $lines) {
            if ($line -match "^\s*-\s*id:\s*$([regex]::Escape($entryId))\s*$") { $skipNext = $true; continue }
            if ($skipNext -and $line -match "^\s*name:\s*'?$([regex]::Escape($entryName))'?\s*$") { $skipNext = $false; continue }
            $skipNext = $false
            $kept.Add($line)
        }
        if ($kept.Count -ne $lines.Count) {
            $backup = "$presetPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Copy-Item $presetPath $backup
            [IO.File]::WriteAllLines($presetPath, $kept, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "preset   : bejegyzés törölve (mentés: $backup)"
        } else {
            Write-Host 'preset   : nem volt bejegyzés'
        }
    }
    if (Test-Path $junctionPath) {
        $item = Get-Item $junctionPath -Force
        if ($item.LinkType -eq 'Junction') {
            # A junction törlése a CÉLT nem érinti; Remove-Item -Recurse nem jó (beszívja a cél tartalmát).
            [IO.Directory]::Delete($junctionPath)
            Write-Host 'junction : törölve'
        } else {
            Write-Host "junction : NEM junction ($($item.LinkType)) — kézzel kell megnézni: $junctionPath"
        }
    }
    Write-Host 'KÉSZ. A visszavonás új sessionben (vagy újraindítás után) lép életbe.'
    exit 0
}

# ── telepítés ─────────────────────────────────────────────────────────────
Write-Host "repó     : $repoRoot"
Write-Host "plugin   : $pluginRoot"
Write-Host "DSH home : $dshHome"

if (-not (Test-Path (Split-Path $junctionPath -Parent))) {
    throw "A profilok node_modules-a nem létezik: $(Split-Path $junctionPath -Parent)"
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

$preset = Get-PresetState
if ($preset -eq 'present') {
    Write-Host 'preset   : már tartalmazza a bejegyzést'
} elseif ($preset -eq 'absent') {
    $backup = "$presetPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $presetPath $backup
    Write-Host "preset   : mentés -> $backup"
    $addition = @(
        '',
        '# ── ágens-terminál tool (2026-11-13) ──────────────────────────────────────',
        '# A beépített terminál-panel (dsh-ui-extras) állapotát fájl-postafiókon éri el.',
        "- id: $entryId",
        "  name: $entryName"
    )
    Add-Content -Path $presetPath -Value $addition -Encoding UTF8
    Write-Host 'preset   : bejegyzés hozzáadva'
} else {
    throw "A preset kompozíció nem található: $presetPath"
}

Write-Host ''
Write-Host 'KÉSZ. A tool a következő session-létrehozáskor (új beszélgetés vagy'
Write-Host 'harness-újraindítás) kerül a modell eszközei közé, mert az agent-síkos'
Write-Host 'preset kompozíciója session-indításkor töltődik.'
Write-Host "Ellenőrzés: pwsh -NoProfile -File $PSCommandPath -Check"
