<#
.SYNOPSIS
  A fokusz-diagnosztika naplojanak osszegyujtese egy fajlba.

.DESCRIPTION
  A javitott DshWindow (--focus-probe) a state\focus-probe mappaba irja a
  fokusz-tortenetet. Ez a szkript a legfrissebb probe-*.log-ot es a
  state\window.log fokusz-sorait egyetlen atadhato fajlba masolja.

.EXAMPLE
  .\tools\collect-focus-log.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$probeDir = Join-Path $root 'state\focus-probe'
$out = Join-Path $probeDir 'focus-report.txt'

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# DSH fokusz-diagnosztika / focus diagnostics")
$lines.Add("# keszult: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$lines.Add('')

$probes = @(Get-ChildItem $probeDir -Filter 'probe-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
if ($probes.Count -eq 0) {
  $lines.Add('NINCS probe log. Az ablakot a javitott exe-vel es --focus-probe kapcsoloval kell megnyitni.')
} else {
  foreach ($p in $probes) {
    $lines.Add('===== ' + $p.Name + ' (' + $p.Length + ' byte, ' + $p.LastWriteTime + ') =====')
    $lines.AddRange([string[]](Get-Content $p.FullName -Encoding UTF8))
    $lines.Add('')
  }
}

$windowLog = Join-Path $root 'state\window.log'
if (Test-Path $windowLog) {
  $hits = @(Select-String -Path $windowLog -Pattern 'focus keeper|focus restore|focus hook|focus-probe' -Encoding UTF8 |
    Select-Object -Last 200)
  $lines.Add('===== state\window.log (fokusz-sorok, utolso 200) =====')
  foreach ($h in $hits) { $lines.Add($h.Line) }
}

Set-Content -Path $out -Value $lines -Encoding UTF8
Write-Host "Riport: $out" -ForegroundColor Green
Write-Host ("Sorok: {0}" -f $lines.Count)
