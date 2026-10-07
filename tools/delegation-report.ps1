<#
.SYNOPSIS
    Delegálási sikeresség napi riportja (a DSH session-tárból).
.DESCRIPTION
    MÉRÉS ALAP (2026-10-07): 8 nap alatt 46 delegálás -> 19 kész (41%),
    21 "failed before it finished", 6 leállított. A fő ok a szabad gpt-oss
    végpontok sérült harmony-streamje volt (PI_AI_ERROR), amit a proxy azóta
    tartalom szerint szűr (providers\proxy.mjs), és a helyi Ollama a tartalék.
    Ez a szkript ugyanazt a mérést futtatja, hogy a javítás hatása látszódjon.
.OUTPUTS
    providers\reports\delegation-YYYYMMDD.md  (napi riport)
    providers\reports\delegation-history.md    (egy soros növekmény)
#>
[CmdletBinding()]
param(
    [int]$Days = 8,
    [int]$ForensicDays = 3
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tools = Join-Path $root 'tools\delegation'
$reportDir = Join-Path $root 'providers\reports'
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd'
$outFile = Join-Path $reportDir "delegation-$stamp.md"

$stats = & node (Join-Path $tools 'delegation-stats.mjs') $Days 2>&1 | Out-String
$forensics = & node (Join-Path $tools 'child-forensics.mjs') $ForensicDays 2>&1 | Out-String

$summary = ($stats -split "`n" | Where-Object { $_ -match 'OSSZESEN' } | Select-Object -First 1)
if (-not $summary) { $summary = '(nincs OSSZESEN sor)' }
# A VALOS sikerarany a gyerek-azonositora dedupolt szamokbol jon: a nyers
# "OSSZESEN" sor az ertesiteseket ketszer szamolja (agent/inbox + user/message).
$rate = ''
$dedupLine = ($stats -split "`n" | Where-Object { $_ -match 'dedup' } | Select-Object -First 1)
if ($dedupLine -and $dedupLine -match '\{.*\}') {
    $d = $Matches[0] | ConvertFrom-Json
    if ($d.started -gt 0) {
        $pct = [math]::Round(100 * $d.finished / $d.started)
        $rate = "dedup: inditas=$($d.started) kesz=$($d.finished) hiba=$($d.failed) leallitott=$($d.stopped) -> sikerarany=$pct%"
    }
}

$md = @()
$md += "# Delegációs sikeresség — $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$md += ""
$md += "- Futtatta: tools\delegation-report.ps1 (napi ütemezés)"
$md += "- Összesítés (dedup): $rate"
$md += "- Nyers számláló: $($summary.Trim())"
$md += ""
$md += '## Napi bontás (utolsó ' + $Days + ' nap)'
$md += '```'
$md += $stats.Trim()
$md += '```'
$md += ""
$md += '## Elhalt/leállított gyerekek boncolása (utolsó ' + $ForensicDays + ' nap)'
$md += '```'
$md += $forensics.Trim()
$md += '```'
$md | Set-Content -Path $outFile -Encoding UTF8
"$(Get-Date -Format 'yyyy-MM-dd HH:mm')`t$rate" | Add-Content -Path (Join-Path $reportDir 'delegation-history.md') -Encoding UTF8
Write-Host "Riport: $outFile"
Write-Host $rate