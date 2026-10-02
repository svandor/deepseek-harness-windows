<#
.SYNOPSIS
    Automatizált (headless) DSH-futás a saját csatornájában.

.DESCRIPTION
    A DSH headless futása MINDIG létrehoz egy sessiont a munkakönyvtárában, a
    DSH pedig induláskor minden olyan könyvtárat külön munkaterületként
    csoportosít, amelyben session-napló van. Ha a futás a projekt könyvtárából
    indul, a szemét a projekt sávjában landol — pontosan ez történt
    2026-09-27-én, amikor a delegálás-tesztek 8 sessiont szórtak a
    „Deepseek Harness" listájára.

    Ez a szkript ezért:
      1) a dedikált csatorna-könyvtárból indítja a futást (alap: `.automation`),
      2) előtte regisztrálja azt külön munkaterületként a futó hoston
         (`POST /ui-extras/workspace-session`, `action: workspace`), így a bal
         sávon azonnal külön csoportként jelenik meg — nem a projekt listájában,
      3) opcionálisan fájlba írja a futás jelentését (`-ReportDirectory`),
      4) a headless futás kilépési kódjával tér vissza.

    A statisztika továbbra is látja ezeket a session-öket: a 30 napos összesítő
    a teljes `sessions` fát olvassa, nem a sáv listáját.

.PARAMETER Task
    A headless feladat szövege (a DSH-nak átadott egyetlen pozíciós argumentum).

.PARAMETER ChannelPath
    A csatorna könyvtára. Alap: `<repo>\.automation`.

.PARAMETER Patch
    Egy vagy több további patch-réteg (`--patch`), például a headless profil
    ingyenes láncához: `providers\test-subagent-worker.patch.yml`.
    Többször is megadható.

.PARAMETER ReportDirectory
    Ha meg van adva, a futás stdout+stderr jelentése ide kerül
    (`automation-<idobelyeg>.md`), így a jelentés fájlban is megmarad.

.PARAMETER DryRun
    Csak előkészít (könyvtár + regisztráció) és kiírja a pontos parancsot.

.EXAMPLE
    .\providers\run-headless-task.ps1 "Report the current date using the pwsh tool."

.EXAMPLE
    .\providers\run-headless-task.ps1 -Task "List the files here." `
        -Patch ".\providers\test-subagent-worker.patch.yml" `
        -ReportDirectory ".\providers\reports"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Task,
    [string]$ChannelPath,
    [string]$ChannelTitle = 'Automatizált futások',
    [int]$Port = 3080,
    [string]$Profile = 'headless',
    [string[]]$Patch = @(),
    [string]$ReportDirectory,
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$DshBin = '',
    [switch]$NoRegister,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $ChannelPath) { $ChannelPath = Join-Path $root '.automation' }
$ChannelPath = [System.IO.Path]::GetFullPath($ChannelPath)

# --- 1) csatorna-konyvtar -----------------------------------------------------
New-Item -ItemType Directory -Force -Path $ChannelPath | Out-Null
Write-Host "Csatorna: $ChannelPath"

# --- 2) regisztracio a futo hoston -------------------------------------------
if (-not $NoRegister) {
    $body = @{ action = 'workspace'; path = $ChannelPath; title = $ChannelTitle } | ConvertTo-Json -Compress
    try {
        $answer = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/ui-extras/workspace-session" `
            -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10
        if ($answer.ok) {
            $state = if ($answer.created) { 'uj munkaterulet' } else { 'mar regisztralva' }
            Write-Host "Csatorna regisztralva ($state): $($answer.workspace.title)"
        } else {
            Write-Warning "A csatorna regisztralasa nem sikerult: $($answer.error)"
        }
    } catch {
        # A regi host fel meg nem ismeri ezt a vegpontot, es a harness sem biztos,
        # hogy fut. A futas attol meg megy — a csoport a kovetkezo indulasnal
        # amugy is letrejon a DSH sajat bootstrap-jabol.
        Write-Warning "A host nem valaszolt a csatorna-regisztraciora ($($_.Exception.Message)). A futas ettol fuggetlenul megy."
    }
}

# --- 3) dsh CLI megkeresese ---------------------------------------------------
if (-not $DshBin) {
    $candidates = @()
    try {
        $g = (& npm root -g 2>$null | Select-Object -Last 1)
        if ($g) { $candidates += (Join-Path $g.Trim() '@deepseek-ai\dsh\lib\bin.js') }
    } catch { }
    try {
        $cache = (& npm config get cache 2>$null | Select-Object -Last 1)
        if ($cache) {
            Get-ChildItem (Join-Path $cache.Trim() '_npx') -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | ForEach-Object {
                    $candidates += (Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js')
                }
        }
    } catch { }
    $DshBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $DshBin) { throw 'Nem talalom a dsh CLI-t. Add meg a -DshBin kapcsoloval.' }

$arguments = @($DshBin, '--profile', $Profile)
foreach ($layer in $Patch) { $arguments += @('--patch', $layer) }
$arguments += $Task

Write-Host "dsh: $DshBin  (profil: $Profile)"
if ($DryRun) {
    Write-Host 'DRY RUN — a futtatando parancs:'
    Write-Host ("  cd `"$ChannelPath`"; node `"$DshBin`" --profile $Profile" +
        (($Patch | ForEach-Object { " --patch `"$_`"" }) -join '') + " `"$Task`"")
    return
}

# --- 4) futas a csatorna-konyvtarbol -----------------------------------------
$env:DSH_HOME = $DshHome
$started = Get-Date
Push-Location $ChannelPath
try {
    $output = & node @arguments 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
$output | ForEach-Object { Write-Host $_ }

# --- 5) jelentes fajlba (csak ha kerted) --------------------------------------
if ($ReportDirectory) {
    New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $file = Join-Path $ReportDirectory "automation-$stamp.md"
    $header = @(
        "# Automatizált headless futás",
        '',
        "- kezdés: $($started.ToString('yyyy-MM-dd HH:mm:ss'))",
        "- csatorna: ``$ChannelPath``",
        "- profil: ``$Profile``",
        ($(if ($Patch.Count -gt 0) { "- patch: $($Patch -join ', ')" } else { "- patch: (nincs)" })),
        "- kilépési kód: $code",
        '',
        '## Feladat',
        '',
        '```text',
        $Task,
        '```',
        '',
        '## Kimenet',
        '',
        '```text'
    )
    $body = @($header + $output + @('```', ''))
    Set-Content -Path $file -Value $body -Encoding UTF8
    Write-Host "Jelentes: $file"
}

exit $code
