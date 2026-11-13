<#
.SYNOPSIS
  Elfogadási próba: a DSH durva leállítása után látszik és leállítható-e az
  elárvult folyamat (a dsh-process-guard plugin révén).

.DESCRIPTION
  MIÉRT: ez az átadási dokumentum 1. elfogadási kritériuma. A mért kiindulás az
  volt, hogy egy DSH-ból indított dev szerver a DSH összeomlása után tovább fut,
  de a felületen nem jelenik meg és nem állítható le.

  A próba menete:
    1) megjegyzi az indulás előtti ledger-állapotot,
    2) DURVÁN leállítja a harness folyamatát (Stop-Process -Force = kill -9),
    3) újraindítja a repó saját, WMI-leválasztott útján (restart-harness.ps1 -Force),
    4) megvárja a bootot, majd a plugin induláskori reconcilációját,
    5) kiolvassa a ledgerből az `adopted` sorokat (a párosított elárvult folyamatok),
    6) riportot ír: state\orphan-test.json.

  FONTOS: a szkript SZÁNDÉKOSAN leválasztva fut (wscript + run-hidden.vbs), mert
  a harness leállítását nem éli túl, ha a harness folyamatfájában fut.

.EXAMPLE
  # rejtve, 120 s késleltetéssel (hogy a folyamatban lévő munka kiérjen):
  wscript.exe //nologo tools\run-hidden.vbs "powershell.exe" -NoProfile `
    -ExecutionPolicy Bypass -File "D:\Szerver\Deepseek Harness\tools\test-orphan-recovery.ps1" -DelaySeconds 120
#>
[CmdletBinding()]
param(
  [int]$DelaySeconds = 120,
  [int]$Port = 3080,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$ReportFile,
  # Száraz mód: mindent megtesz, KIVÉVE a durva leállítást és az újraindítást.
  # Azért kell, mert a próba leállítja a harness-t, tehát futás közben nem lehet
  # hibát keresni benne — a hibakeresés így nem a felhasználó munkameneteit viszi.
  [switch]$DryRun,
  # Az adoptált elárvult folyamatokat ne állítsa le a végén (alapból leállítja).
  [switch]$KeepOrphans
)

$ErrorActionPreference = 'Stop'

# MÉRT HIBA (2026-11-13): a `$PSScriptRoot` a `param()` ALAPÉRTÉKEIBEN üres
# Windows PowerShell 5.1 alatt (a `-File` ezt futtatja), ezért a szkript már a
# paraméter-feldolgozásnál elhalt — rejtett indításnál csendben. Ezért itt, a
# törzsben számoljuk.
if (-not $ReportFile) { $ReportFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'state\orphan-test.json' }
# A száraz próba NE írja felül az éles riportot: külön fájlba megy, hogy a
# `state\orphan-test.json` mindig a valódi (durva leállításos) futásé legyen.
if ($DryRun -and $ReportFile -like '*.json') { $ReportFile = $ReportFile -replace '\.json$', '.dryrun.json' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$ledgerDir = Join-Path $DshHome 'process-ledger'
$pidFile = Join-Path $repoRoot 'state\harness.pid'
$report = [ordered]@{ startedAt = (Get-Date).ToString('o'); steps = @() }

function Note($text) {
  Write-Host $text
  $report.steps += ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $text)
}

function Read-HarnessPid {
  try {
    $value = 0
    if ([int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$value)) { return $value }
  } catch { }
  return 0
}

# --- 1) kiindulás -------------------------------------------------------------
if ($DelaySeconds -gt 0) {
  Note ("várakozás {0} s (a folyamatban lévő munka kiéréséhez)" -f $DelaySeconds)
  Start-Sleep -Seconds $DelaySeconds
}

$oldPid = Read-HarnessPid
$report.oldHarnessPid = $oldPid
$untrackedBefore = 0
if (Test-Path $ledgerDir) {
  foreach ($file in Get-ChildItem $ledgerDir -Filter '*.jsonl' | Where-Object { $_.Name -ne '_diag.jsonl' }) {
    $untrackedBefore += (Select-String -Path $file.FullName -Pattern '"t":"untracked"' -SimpleMatch:$false | Measure-Object).Count
  }
}
$report.untrackedRecordsBefore = $untrackedBefore
Note ("induló harness pid: {0} · untracked rekord: {1}" -f $oldPid, $untrackedBefore)

if ($oldPid -eq 0) {
  Note 'NINCS harness.pid — a próba nem értelmezhető.'
  $report.verdict = 'inconclusive'
  $report | ConvertTo-Json -Depth 4 | Set-Content $ReportFile -Encoding UTF8
  exit 2
}

if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
  # MÉRT HIBA (2026-11-13): a harness.pid elavult lehet (a helyreállítás más úton
  # indult), ilyenkor a „leállítás" egy halott PID-re mutat, a próba pedig
  # értelmezhetetlen ítéletet adna.
  Note ("ELAVULT harness.pid: {0} nem él — a próba leáll (nem ölünk vakon)" -f $oldPid)
  $report.verdict = 'stale-pid'
  $report | ConvertTo-Json -Depth 4 | Set-Content $ReportFile -Encoding UTF8
  exit 2
}

# Előzetes ellenőrzés: a session-tár konzisztenciája a fejléc szerinti kulccsal.
# MÉRT OK (2026-11-13): egy inkonzisztens tároló miatt a boot elhalt, ezért a
# durva leállítás előtt ezt ki kell zárni — különben a próba maga viszi le a
# rendszert.
$checker = Join-Path $repoRoot 'tools\merge-session-store.mjs'
if ((Test-Path $checker) -and (Get-Command node -ErrorAction SilentlyContinue)) {
  try {
    $checkOutput = & node $checker --check 2>&1 | Out-String
    $mismatch = [regex]::Match($checkOutput, 'áthelyezendő\s+(\d+)')
    if ($mismatch.Success -and [int]$mismatch.Groups[1].Value -gt 0) {
      Note ("ELUTASÍTVA: a session-tár inkonzisztens ({0} napló rossz mappában) — előbb azt kell rendbe tenni." -f $mismatch.Groups[1].Value)
      $report.verdict = 'store-inconsistent'
      $report | ConvertTo-Json -Depth 4 | Set-Content $ReportFile -Encoding UTF8
      exit 3
    }
    Note 'előzetes ellenőrzés: a session-tár konzisztens'
  } catch {
    Note ("  az előzetes ellenőrzés nem futott le: " + $_.Exception.Message)
  }
}

# --- 2) durva leállítás -------------------------------------------------------
$killAt = Get-Date
if ($DryRun) {
  Note 'SZÁRAZ MÓD: a durva leállítás és az újraindítás KIMARAD'
} else {
  Note ("DURVA leállítás: pid {0}" -f $oldPid)
  try { Stop-Process -Id $oldPid -Force -ErrorAction Stop } catch { Note ("  a leállítás nem sikerült: " + $_.Exception.Message) }
  Start-Sleep -Seconds 3
}

$stillAlive = [bool](Get-Process -Id $oldPid -ErrorAction SilentlyContinue)
$report.killedHard = (-not $stillAlive) -and (-not $DryRun)
Note ("régi folyamat él-e: {0}" -f $stillAlive)

# --- 3) újraindítás -----------------------------------------------------------
if ($DryRun) {
  Note 'SZÁRAZ MÓD: restart kihagyva'
} else {
  # MÉRT HIBA (2026-11-13): a `restart-harness.ps1` közvetlen, VÁRAKOZÓ hívása
  # elakadt (a gyermeke 0 CPU-val várt), ezért a próba riport nélkül maradt.
  # Ezért az egyszeres indító megy át rajta: az `-NoWait`-tel adja le a kérést,
  # és a mutex/pre-flight védelmek miatt nem indul dupla példány.
  Note 'újraindítás (start-harness-once.ps1 → restart -NoWait)'
  $starter = Join-Path $repoRoot 'tools\start-harness-once.ps1'
  try { & $starter -Port $Port -Force | Out-Host } catch { Note ("  restart hiba: " + $_.Exception.Message) }
}

# --- 4) boot megvárása --------------------------------------------------------
$deadline = (Get-Date).AddSeconds(120)
$newPid = 0
if ($DryRun) {
  $newPid = $oldPid
} else {
  # A boot megvárása MELLETT mintavételezzük a memóriát (3. elfogadási
  # kritérium: induláskori csúcs). 250 ms-onként, PID-enként külön csúccsal —
  # így a régi és az új példány adata nem keveredik.
  $bootWatch = @{}
  $bootDeadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $bootDeadline) {
    $samplePid = Read-HarnessPid
    if ($samplePid -eq 0) { $samplePid = $oldPid }
    $process = Get-Process -Id $samplePid -ErrorAction SilentlyContinue
    if ($process -ne $null) {
      $ws = [int64]$process.WorkingSet64
      $priv = [int64]$process.PrivateMemorySize64
      if ($bootWatch.ContainsKey($samplePid)) {
        if ($ws -gt $bootWatch[$samplePid].ws) { $bootWatch[$samplePid].ws = $ws }
        if ($priv -gt $bootWatch[$samplePid].priv) { $bootWatch[$samplePid].priv = $priv }
      } else {
        $bootWatch[$samplePid] = @{ ws = $ws; priv = $priv }
      }
      if ($samplePid -ne $oldPid) { $newPid = $samplePid }
    }
    Start-Sleep -Milliseconds 250
    if ($newPid -ne 0 -and (Get-Date) -gt ($bootDeadline.AddSeconds(-60))) { break }
  }
  $report.memoryByPid = @()
  foreach ($key in $bootWatch.Keys) {
    $report.memoryByPid += [pscustomobject]@{
      pid             = $key
      maxWorkingSetMB = [math]::Round($bootWatch[$key].ws / 1MB, 1)
      maxPrivateMB    = [math]::Round($bootWatch[$key].priv / 1MB, 1)
      isNewHarness    = ($key -ne $oldPid)
    }
  }
  $newSample = $report.memoryByPid | Where-Object { $_.isNewHarness -eq $true } | Select-Object -First 1
  if ($newSample -ne $null) { Note ("boot-memória (új pid {0}): working set csúcs {1} MB · private csúcs {2} MB" -f $newSample.pid, $newSample.maxWorkingSetMB, $newSample.maxPrivateMB) }
}
$report.newHarnessPid = $newPid
Note ("új harness pid: {0}" -f $newPid)

# A plugin a boot után ~2,5 s-mal reconcilál; adunk neki 25 s-ot.
if (-not $DryRun) { Start-Sleep -Seconds 25 }

# --- 5) az `adopted` sorok kiolvasása ----------------------------------------
$adopted = @()
if (Test-Path $ledgerDir) {
  foreach ($file in Get-ChildItem $ledgerDir -Filter '*.jsonl') {
    foreach ($line in (Select-String -Path $file.FullName -Pattern '"t":"adopted"').Line) {
      try { $adopted += ($line | ConvertFrom-Json) } catch { }
    }
  }
}
$report.adopted = $adopted
Note ("párosított (adopted) rekord: {0}" -f $adopted.Count)

# Az ítélet csak akkor `pass`, ha a párosított folyamat TÉNYLEG él és tényleg a
# régi futásból való (a PID a mostani folyamatlistában létezik). Enélkül a riport
# félrevezető lenne: egy már kilépett folyamatra mutató rekord nem bizonyíték.
$alive = @()
foreach ($entry in $adopted) {
  $isAlive = [bool](Get-Process -Id $entry.pid -ErrorAction SilentlyContinue)
  Note ("  pid {0}  indítási idő {1}  él: {2}" -f $entry.pid, $entry.started, $isAlive)
  if ($isAlive) { $alive += $entry.pid }
}
$report.adoptedAlive = $alive

# Takarítás: az adoptált elárvult folyamatokat leállítjuk, hogy ne maradjon szemét.
if (-not $DryRun -and -not $KeepOrphans -and $alive.Count -gt 0) {
  foreach ($processId in $alive) {
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Note ("  elárvult folyamat leállítva: pid {0}" -f $processId)
    } catch {
      Note ("  a takarítás nem sikerült (pid {0}): {1}" -f $processId, $_.Exception.Message)
    }
  }
  $report.cleanedUp = $true
}

# --- 6) ítélet ----------------------------------------------------------------
if ($newPid -eq 0) {
  $report.verdict = 'restart-failed'
} elseif ($alive.Count -gt 0) {
  $report.verdict = 'pass'
} elseif ($adopted.Count -gt 0) {
  $report.verdict = 'adopted-but-dead'
} else {
  $report.verdict = 'no-orphan-adopted'
}
$report.finishedAt = (Get-Date).ToString('o')
Note ("ÍTÉLET: {0}" -f $report.verdict)

$report | ConvertTo-Json -Depth 6 | Set-Content $ReportFile -Encoding UTF8
Write-Host ("Riport: {0}" -f $ReportFile)
