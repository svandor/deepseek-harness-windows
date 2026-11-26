<#
.SYNOPSIS
    A `dsh-browser` agent-síkos plugin telepítése a DSH-ba.

.DESCRIPTION
    Két dolgot végez el, ismételhetően (idempotens):

      1. junction a profilok `node_modules`-ába:
         `%USERPROFILE%\.dsh\profiles\node_modules\dsh-browser`
         -> `<repó>\plugins\dsh-browser`
      2. bejegyzés az agent-síkos preset kompozíciójába:
         `%USERPROFILE%\.dsh\.agent-presets\standard-free\agent.cordis.yml`

    A plugin a HOST processzben indítja a böngészőt (headless Edge + CDP),
    ezért a DSH sandboxa nem érinti — de a tool-listába csak a preset
    kompozíciójából kerül be.

    FONTOS: az agent-síkos preset a **session létrehozásakor** töltődik, ezért
    a bejegyzés csak új sessionben jelenik meg. Ez a szkript NEM indít újra
    semmit (AGENTS.md 1.5).

.PARAMETER Check
    Csak ellenőriz (junction + preset bejegyzés + node oldali betölthetőség).

.PARAMETER Remove
    Visszavonja a telepítést (bejegyzés + junction). A plugint nem törli.

.PARAMETER Preset
    A preset neve a `~\.dsh\.agent-presets` alatt. Alapértelmezés: standard-free.

.EXAMPLE
    pwsh -NoProfile -File plugins\dsh-browser\install.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Remove,
    [string]$Preset = 'standard-free'
)

$ErrorActionPreference = 'Stop'

$pluginRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $pluginRoot)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$junctionPath = Join-Path $dshHome 'profiles\node_modules\dsh-browser'
$presetPath = Join-Path $dshHome ".agent-presets\$Preset\agent.cordis.yml"
$entryName = 'dsh-browser'
$entryId = 'tool-browser'

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
    if ((Resolve-Path $target).Path -ne (Resolve-Path $pluginRoot).Path) { return "mas-cel:$target" }
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
        # A `file:///` alak a junction VALÓDI útjára mutat, ezért a betöltés
        # ugyanazt a kódot ellenőrzi, amit a harness is betölt.
        $rel = ($junctionPath -replace '\\', '/' -replace ' ', '%20')
        $probe = @"
const m = await import('file:///$rel/lib/index.js');
let def = null;
const fake = {
  tools: { register: (d) => { def = d; } },
  get: () => undefined,
  on: () => {},
  logger: { warn() {} }
};
await m.apply(fake);
const name = def?.name ?? '(nincs)';
const params = def?.parameters?.type === 'object' ? 'JSON-SCHEMA' : (def?.parameters?.action ? 'DSL' : '?');
console.log('TOOL=' + name + ' PARAMS=' + params);
"@
        $out = & node --input-type=module -e $probe 2>&1 | Out-String
        Write-Host ("node     : {0}" -f ($out.Trim()))
        if ($out -notmatch 'TOOL=browser') { $problems++ }
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
            # A junction törlése a CÉLT nem érinti.
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
        '# ── böngésző tool (2026-11-26) ───────────────────────────────────────────',
        '# A Chromium a sandboxban nem indul (mojo/crashpad), ezért a HOST processz',
        '# indítja (headless Edge + CDP). Hatókör: loopback | lan | any.',
        "- id: $entryId",
        "  name: $entryName"
    )
    Add-Content -Path $presetPath -Value $addition -Encoding UTF8
    Write-Host 'preset   : bejegyzés hozzáadva'
} else {
    throw "A preset kompozíció nem található: $presetPath"
}

Write-Host ''
Write-Host 'KÉSZ. A tool a következő session-létrehozásakor (új beszélgetés vagy'
Write-Host 'harness-újraindítás) kerül a modell eszközei közé.'
Write-Host "Ellenőrzés: pwsh -NoProfile -File $PSCommandPath -Check"
