<#
.SYNOPSIS
    A subagent-konfiguráció ellenőrzése: melyik célmodell képes agent-loopra?

.DESCRIPTION
    A subagent egy teljes agent-loopot futtat toolokkal. Ha a célmodell nem tud
    tool-callingot, a delegálás csendben elromlik — a modell válaszol, de nem
    hív eszközt, vagy hibás argumentumokat ad.

    Ez a szkript:
      1. kiolvassa a subagent célmodelljeit a settings.yaml-ból
         (subagent-model-selection.allowedModels, valamint a preset
         tool-subagent sor agentOptions blokkja, ha megvan),
      2. minden célmodellhez megkeresi a "tools" képességet:
         - helyi Ollama modell: /api/show capabilities,
         - katalógus/felhős modell: élő próba egy tool-hívást igénylő kéréssel,
      3. jelenti, melyik célmodell NEM alkalmas delegálásra.

.PARAMETER NoProbe
    Ne indítson hálózati próbát a felhős modellekhez (csak a helyieket nézi).

.EXAMPLE
    .\check-subagent.ps1
    .\check-subagent.ps1 -NoProbe
#>
[CmdletBinding()]
param(
    [switch]$NoProbe
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$settings = Join-Path $env:USERPROFILE '.dsh\settings.yaml'
$creds = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'

if (-not (Test-Path $settings)) { Write-Host "Nincs settings.yaml: $settings" -ForegroundColor Red; return }

$lines = Get-Content $settings

# ── 1) subagent-model-selection.allowedModels ─────────────────────────────
$inSection = $false
$inAllowed = $false
$routes = @()
$curProvider = $null

foreach ($l in $lines) {
    if ($l -match '^subagent-model-selection:\s*$') { $inSection = $true; continue }
    if ($inSection -and $l -match '^\S') { $inSection = $false }

    if ($inSection -and $l -match '^\s+allowedModels:\s*$') { $inAllowed = $true; continue }
    if ($inAllowed -and $l -match '^\s+-\s+provider:\s*(\S+)') { $curProvider = $Matches[1]; continue }
    if ($inAllowed -and $l -match '^\s+model:\s*(\S+)') {
        if ($curProvider) { $routes += [pscustomobject]@{ Provider = $curProvider; Model = $Matches[1]; Source = 'settings' } }
        $curProvider = $null
        continue
    }
    if ($inAllowed -and $l -match '^\s{0,4}\S') { $inAllowed = $false }
}

# ── 2) preset-beli agentOptions ───────────────────────────────────────────
$presetDirs = @(Join-Path $env:USERPROFILE '.dsh\.agent-presets')
$presetDirs += @(Get-ChildItem '$env:LOCALAPPDATA\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai\dsh-agent-presets\presets' -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
foreach ($pd in $presetDirs) {
    if (-not (Test-Path $pd)) { continue }
    Get-ChildItem $pd -Recurse -Filter 'agent.cordis.yml' -ErrorAction SilentlyContinue | ForEach-Object {
        $c = Get-Content $_.FullName -Raw
        if ($c -match '(?ms)toolName:\s*subagent\b.*?agentOptions:\s*\r?\n\s+provider:\s*(\S+)\r?\n\s+model:\s*(\S+)') {
            $routes += [pscustomobject]@{ Provider = $Matches[1]; Model = $Matches[2]; Source = "preset: $($_.Directory.Name)" }
        }
    }
}

if ($routes.Count -eq 0) {
    Write-Host "Nincs subagent célmodell beállítva." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Ez azt jelenti: a subagent a SZÜLŐ route-ját örökli (jelenleg az agent-default-model)." -ForegroundColor Gray
    Write-Host "Ha az fizetős, minden delegált munka is fizetős marad." -ForegroundColor Gray
    Write-Host ""
    Write-Host "Beállítás: Settings -> Plugins -> subagent-model-selection," -ForegroundColor Gray
    Write-Host "vagy a preset tool-subagent sorának agentOptions blokkja." -ForegroundColor Gray
    return
}

Write-Host "Subagent célmodellek: $($routes.Count)" -ForegroundColor Cyan
Write-Host ""

# ── 3) képesség-ellenőrzés ────────────────────────────────────────────────
function Test-OllamaTool($model) {
    try {
        $r = Invoke-RestMethod 'http://127.0.0.1:11434/api/show' -Method Post -ContentType 'application/json' `
            -Body (@{ model = $model } | ConvertTo-Json) -TimeoutSec 20
        return ($r.capabilities -contains 'tools')
    } catch { return $null }
}

function Test-CloudTool($provider, $model, $apiKey) {
    # Egy tool-hívást igénylő kérést küldünk; a tool_calls megléte a bizonyíték.
    $endpoints = @{
        'groq'       = 'https://api.groq.com/openai/v1'
        'openrouter' = 'https://openrouter.ai/api/v1'
        'nvidia'     = 'https://integrate.api.nvidia.com/v1'
    }
    $base = $endpoints[$provider]
    if (-not $base) { return $null }

    $body = @{
        model = $model
        messages = @(@{ role = 'user'; content = 'What is the weather in Budapest? Use the get_weather tool.' })
        max_tokens = 300
        tools = @(@{
            type = 'function'
            function = @{
                name = 'get_weather'
                description = 'Get weather for a city'
                parameters = @{ type = 'object'; properties = @{ city = @{ type = 'string' } }; required = @('city') }
            }
        })
    } | ConvertTo-Json -Depth 10

    try {
        $r = Invoke-RestMethod "$base/chat/completions" -Method Post -ContentType 'application/json' `
            -Headers @{ authorization = "Bearer $apiKey" } -Body $body -TimeoutSec 90
        $tc = $r.choices[0].message.tool_calls
        if ($tc -and $tc.Count -gt 0) { return $true }
        return $false
    } catch { return $null }
}

# kulcsok
$keyMap = @{}
if (Test-Path $creds) {
    foreach ($l in Get-Content $creds) {
        if ($l -match '^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$') { $keyMap[$Matches[1]] = $Matches[2] }
    }
}

$envOf = @{
    'groq' = 'GROQ_API_KEY'; 'openrouter' = 'OPENROUTER_API_KEY'; 'nvidia' = 'NVIDIA_API_KEY'
    'google' = 'GOOGLE_API_KEY'; 'ollama-local' = 'OLLAMA_LOCAL_API_KEY'
}

$results = @()
foreach ($r in $routes) {
    $verdict = '?'
    $note = ''

    if ($r.Provider -eq 'ollama-local') {
        $t = Test-OllamaTool $r.Model
        if ($t -eq $true) { $verdict = 'OK'; $note = 'tools képesség megvan' }
        elseif ($t -eq $false) { $verdict = 'NEM ALKALMAS'; $note = 'nincs tools képesség' }
        else { $verdict = '?'; $note = 'az Ollama nem válaszolt' }
    } elseif ($NoProbe) {
        $verdict = '?'; $note = 'próba kihagyva (-NoProbe)'
    } else {
        $envName = $envOf[$r.Provider]
        $key = if ($envName) { $keyMap[$envName] } else { $null }
        if (-not $key) { $verdict = '?'; $note = "nincs kulcs ($envName)" }
        else {
            $t = Test-CloudTool $r.Provider $r.Model $key
            if ($t -eq $true) { $verdict = 'OK'; $note = 'tool_calls megjött' }
            elseif ($t -eq $false) { $verdict = 'GYANUS'; $note = 'nem hívott toolt — lehet, hogy a prompt a hibás' }
            else { $verdict = '?'; $note = 'a hívás hibára futott' }
        }
    }

    $results += [pscustomobject]@{ Provider = $r.Provider; Model = $r.Model; Eredmeny = $verdict; Megjegyzes = $note; Forras = $r.Source }
}

$results | Format-Table -AutoSize

$bad = @($results | Where-Object { $_.Eredmeny -eq 'NEM ALKALMAS' })
if ($bad.Count -gt 0) {
    Write-Host "$($bad.Count) célmodell NEM alkalmas delegálásra:" -ForegroundColor Red
    $bad | ForEach-Object { Write-Host "  $($_.Provider)/$($_.Model)" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Javaslat: cseréld olyan modellre, amelyik bizonyítottan hív toolt (pl. groq/openai/gpt-oss-120b)." -ForegroundColor Yellow
} else {
    Write-Host "Nincs bizonyítottan alkalmatlan célmodell." -ForegroundColor Green
}
