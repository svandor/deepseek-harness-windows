<#
.SYNOPSIS
    Az automatizált futások csatornájának beállítása (egy paranccsal).

.DESCRIPTION
    Két dolgot végez el, ebben a sorrendben:

      1) ELLENŐRZI, hogy a futó host fél betöltötte-e az új
         `/ui-extras/workspace-session` vegpontot. Ha nem (mert a host fél csak
         szerver-újraindítással töltődik be), akkor -Restart nélkül csak jelzi,
         hogy a felület **⭯ újraindítás** gombjára (vagy a
         `tools\restart-harness.ps1` háttérben futtatott változatára) van
         szükség, és nem nyúl semmihez.
      2) Ha a vegpont él: regisztrálja a `.automation` könyvtárat külön
         munkaterületként, és elrejti (archiválja) a gépi futásokból származó,
         listán látszó session-öket. Az archiválás nem törlés: a naplók a
         helyükön maradnak, ezért a statisztika továbbra is számol velük.

    FONTOS: ha a `-Restart` kapcsolót használod, ezt a szkriptet **normál
    PowerShell-ablakból** indítsd (nem a harness terminálpaneljéből), különben
    a parancs félbemarad, mert éppen azt a szervert állítja le, amelyik
    kiszolgálja. A felület **⭯ újraindítás** gombja ugyanezt biztonságosan
    elvégzi — utána futtasd ezt a szkriptet `-Restart` nélkül.

.EXAMPLE
    .\providers\setup-automation-channel.ps1              # ellenőrzés + beállítás
    .\providers\setup-automation-channel.ps1 -DryRun      # csak riport
    .\providers\setup-automation-channel.ps1 -Restart     # újraindítással (normál ablakból)
#>
[CmdletBinding()]
param(
    [int]$Port = 3080,
    [switch]$DryRun,
    [switch]$Restart,
    [switch]$NoHide
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$channelScript = Join-Path $root 'providers\session-channel.mjs'

if ($Restart) {
    Write-Host 'Szerver ujrainditasa (hatterben)...'
    & (Join-Path $root 'tools\restart-harness.ps1') -Port $Port -Detached
    Write-Host 'Varakozas a friss host felemre...'
    $deadline = (Get-Date).AddSeconds(90)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/ui-extras/workspace-session" -TimeoutSec 5
            if ($probe.ok) { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) {
        Write-Warning 'A host fel 90 masodpercen belul nem valaszolt. Ellenorizd: state\harness.log / state\harness.err.log'
        exit 1
    }
    Write-Host 'A host fel el.'
}

# --- 1) a vegpont ellenorzese -------------------------------------------------
$alive = $false
try {
    $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/ui-extras/workspace-session" -TimeoutSec 5
    $alive = [bool]$probe.ok
} catch { $alive = $false }

if (-not $alive) {
    Write-Host ''
    Write-Host 'A /ui-extras/workspace-session vegpont meg nem el.' -ForegroundColor Yellow
    Write-Host 'A host fel csak szerver-ujrainditassal toltodik be. Ket lehetoseg:' -ForegroundColor Yellow
    Write-Host '  1) a feluleten:  ⭯ ujrainditas  (ajanlott), majd futtasd ujra ezt a szkriptet'
    Write-Host '  2) normal PowerShell-ablakbol:  .\providers\setup-automation-channel.ps1 -Restart'
    exit 1
}

if ($DryRun) {
    Write-Host 'DRY RUN — most jon a riport:'
    & node $channelScript
    exit $LASTEXITCODE
}

# --- 2) csatorna + takaritas --------------------------------------------------
$arguments = @($channelScript, '--channel')
if (-not $NoHide) { $arguments += '--hide' }
& node @arguments
exit $LASTEXITCODE
