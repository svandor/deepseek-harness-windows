<#
.SYNOPSIS
  A harness induláskori memóriacsúcsának mérése.

.DESCRIPTION
  MIÉRT: az átadási dokumentum 3. elfogadási kritériuma az, hogy az induláskori
  csúcs 1 GB alatt legyen (a mért kiindulás 6,7 GB volt). A csúcsot csak a
  futás közben lehet megfogni, ezért ez a szkript a harness folyamatát mintavételezi
  (alapból 250 ms-onként), és rögzíti a working set / private commit maximumát.

  A mérés akkor érvényes, ha a szkript az újraindítás ELŐTT indul, és átfogja a
  boot teljes idejét. A `restart-later.vbs` erre nem képes, ezért külön kell
  indítani — rejtve:

    wscript.exe //nologo tools\run-hidden.vbs \
      "powershell.exe" -NoProfile -ExecutionPolicy Bypass -File \
      "D:\Szerver\Deepseek Harness\tools\sample-startup-memory.ps1" -Seconds 90

.PARAMETER Seconds
  Mintavétel hossza másodpercben (alapból 90).

.PARAMETER IntervalMs
  Mintavételi sűrűség (alapból 250 ms).

.PARAMETER OutFile
  Eredmény JSON (alapból state\startup-memory.json).

.EXAMPLE
  .\tools\sample-startup-memory.ps1 -Seconds 60
#>
[CmdletBinding()]
param(
  [int]$Seconds = 90,
  [int]$IntervalMs = 250,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'

# MÉRT HIBA (2026-11-13): a `$PSScriptRoot` a `param()` alapértékeiben üres
# Windows PowerShell 5.1 alatt, ezért a törzsben számoljuk (lásd
# test-orphan-recovery.ps1).
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $repoRoot 'state\startup-memory.json' }
$statePath = Join-Path $repoRoot 'state\harness.pid'

function Read-HarnessPid {
  try {
    $raw = (Get-Content $statePath -Raw -ErrorAction Stop).Trim()
    $value = 0
    if ([int]::TryParse($raw, [ref]$value)) { return $value }
  } catch {
    # még nincs pid-fájl
  }
  return 0
}

$samples = New-Object System.Collections.Generic.List[object]
$startedAt = Get-Date
$deadline = $startedAt.AddSeconds($Seconds)
$pid0 = 0
$maxWorkingSet = 0
$maxPrivate = 0

Write-Host ("Mintavétel indul: {0} s, {1} ms" -f $Seconds, $IntervalMs)

while ((Get-Date) -lt $deadline) {
  if ($pid0 -eq 0) { $pid0 = Read-HarnessPid }
  if ($pid0 -ne 0) {
    $process = Get-Process -Id $pid0 -ErrorAction SilentlyContinue
    if ($process -ne $null) {
      $workingSet = [int64]$process.WorkingSet64
      $private = [int64]$process.PrivateMemorySize64
      if ($workingSet -gt $maxWorkingSet) { $maxWorkingSet = $workingSet }
      if ($private -gt $maxPrivate) { $maxPrivate = $private }
      $samples.Add([pscustomobject]@{
          t      = [int]((Get-Date) - $startedAt).TotalMilliseconds
          pid    = $pid0
          wsMB   = [int]($workingSet / 1MB)
          privMB = [int]($private / 1MB)
        })
    } else {
      # A folyamat még nem indult el (vagy már leállt) — a pid-fájl frissülhet.
      $pid0 = 0
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}

$result = [ordered]@{
  startedAt       = $startedAt.ToString('o')
  durationSeconds = $Seconds
  intervalMs      = $IntervalMs
  harnessPid      = $pid0
  samples         = $samples.Count
  maxWorkingSetMB = [math]::Round($maxWorkingSet / 1MB, 1)
  maxPrivateMB    = [math]::Round($maxPrivate / 1MB, 1)
  series          = $samples
}

$target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
$result | ConvertTo-Json -Depth 4 | Set-Content $target -Encoding UTF8

Write-Host ("Kész: csúcs working set {0} MB · csúcs private {1} MB · minta {2}" -f $result.maxWorkingSetMB, $result.maxPrivateMB, $result.samples)
Write-Host ("Eredmény: {0}" -f $target)
