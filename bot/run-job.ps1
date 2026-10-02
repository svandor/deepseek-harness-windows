# Házirobot — PowerShell belépési pont a Feladatütemezőhöz.
#
# Használat (normál PowerShell-ablakból, mert a DSH sandboxa nem regisztrálhat
# ütemezett feladatot):
#   .\run-job.ps1 due                 # a most esedékes jobok
#   .\run-job.ps1 konkurencia-figyelo # egy job futtatása
#   .\run-job.ps1 list                # elérhető jobok
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$botRoot = $PSScriptRoot
$logDir = Join-Path $botRoot 'state'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$args = if ($Rest.Count -gt 0) { $Rest } else { @('due') }
Push-Location $botRoot
try {
  # A --no-warnings a node:sqlite "experimental" üzenetét nyeli el (különben a
  # stderr-t a PowerShell hibának látná az ütemezett futásban).
  & node --no-warnings (Join-Path $botRoot 'run-job.mjs') @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
