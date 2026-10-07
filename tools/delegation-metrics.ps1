<#
.SYNOPSIS
    Folyamatos delegálási mérőszámok: idősor + aktuális státusz.
.DESCRIPTION
    Óránként fut (DSH delegation metrics ütemezett feladat), és két forrásból mér:
      1) providers\proxy.out.log  -> a proxy szintje: HIT / FALLBACK / FAIL,
         és ezen belül hány FAIL volt TARTALOM szerinti (a 2026-10-07-i
         detektor: sérült harmony-stream, pszeudo tool-hívás, üres stream).
      2) DSH session-tár          -> a delegálás szintje: indítás / befejezett /
         hiba / leállított, gyerek-azonosítóra dedupolva (ez a valós sikerarány).
    Kimenet:
      providers\reports\delegation-timeseries.csv  (növekményes idősor)
      providers\reports\delegation-status.md       (utolsó órák táblázata)
.NOTES
    Alap (2026-10-07): 46 delegálás, 19 kész, 21 hiba, 6 leállított = 41%.
#>
[CmdletBinding()]
param(
    [int]$Days = 2,
    [int]$StatusRows = 24
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tools = Join-Path $root 'tools\delegation'
$reportDir = Join-Path $root 'providers\reports'
if (-not (Test-Path $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
$csv = Join-Path $reportDir 'delegation-timeseries.csv'
$status = Join-Path $reportDir 'delegation-status.md'

# ── 1) proxy szint ────────────────────────────────────────────────────────
$proxyJson = & node (Join-Path $tools 'proxy-stats.mjs') --json 2>&1 | Out-String
$p = $null
try { $p = $proxyJson.Trim() | ConvertFrom-Json } catch { }

# ── 2) delegálás szint ────────────────────────────────────────────────────
$stats = & node (Join-Path $tools 'delegation-stats.mjs') $Days 2>&1 | Out-String
$d = $null
$dedupLine = ($stats -split "`n" | Where-Object { $_ -match 'dedup' } | Select-Object -First 1)
if ($dedupLine -and $dedupLine -match '\{.*\}') { try { $d = $Matches[0] | ConvertFrom-Json } catch { } }

$rate = ''
if ($d -and $d.started -gt 0) { $rate = [math]::Round(100 * $d.finished / $d.started) }

$row = [pscustomobject]@{
    timestamp          = (Get-Date -Format 'yyyy-MM-dd HH:mm')
    proxy_hit          = if ($p) { $p.events.HIT } else { '' }
    proxy_fallback     = if ($p) { $p.events.FALLBACK } else { '' }
    proxy_fail         = if ($p) { $p.events.FAIL } else { '' }
    content_rejects    = if ($p) { $p.contentRejects } else { '' }
    sub_started        = if ($d) { $d.started } else { '' }
    sub_finished       = if ($d) { $d.finished } else { '' }
    sub_failed         = if ($d) { $d.failed } else { '' }
    sub_stopped        = if ($d) { $d.stopped } else { '' }
    success_pct        = $rate
}
if (-not (Test-Path $csv)) {
    $row | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8
} else {
    $row | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8 -Append
}

# ── 3) státusz-táblázat ───────────────────────────────────────────────────
$all = @(Import-Csv $csv)
$tail = $all | Select-Object -Last $StatusRows
$md = @()
$md += "# Delegálási hatékonyság — aktuális állapot"
$md += ""
$md += "Frissítve: $(Get-Date -Format 'yyyy-MM-dd HH:mm') (óránkénti mérés)"
$md += ""
if ($rate -ne '') { $md += "- **Delegálási sikerarány (utolsó $Days nap, dedup): $rate%** — indítás $($d.started), kész $($d.finished), hiba $($d.failed), leállított $($d.stopped)" }
if ($p) { $md += "- **Proxy (aktuális naplóablak): HIT $($p.events.HIT), FALLBACK $($p.events.FALLBACK), FAIL $($p.events.FAIL); tartalom alapján elutasítva: $($p.contentRejects)**" }
$md += ""
$md += '| idő | proxy HIT | FALLBACK | FAIL | tartalom-hiba | indítás | kész | hiba | leállított | siker% |'
$md += '|---|---|---|---|---|---|---|---|---|---|'
foreach ($r in $tail) {
    $md += "| $($r.timestamp) | $($r.proxy_hit) | $($r.proxy_fallback) | $($r.proxy_fail) | $($r.content_rejects) | $($r.sub_started) | $($r.sub_finished) | $($r.sub_failed) | $($r.sub_stopped) | $($r.success_pct) |"
}
$md += ""
$md += "_Alap (2026-10-07, a javítások előtt): 41%. A proxy-napló ablaka az utolsó"
$md += "proxy-indítás óta tart, ezért a HIT/FAIL számok nem napra bontottak._"
$md | Set-Content -Path $status -Encoding UTF8

Write-Host "idősor: $csv"
Write-Host "státusz: $status"
if ($d) { Write-Host "delegálás (dedup): indítás=$($d.started) kész=$($d.finished) hiba=$($d.failed) leállított=$($d.stopped) siker=$rate%" }
if ($p) { Write-Host "proxy: HIT=$($p.events.HIT) FALLBACK=$($p.events.FALLBACK) FAIL=$($p.events.FAIL) tartalom-hiba=$($p.contentRejects)" }
