<#
.SYNOPSIS
    DSH dev-kornyezet: Caddy + php-cgi + hosts (a Herd kivaltasa).

.DESCRIPTION
    Egy folyamatban tartja a helyi fejleszto kornyezetet:

        D:\Tools\caddy\caddy.exe      HTTPS (sajat CA, "tls internal")
        D:\Tools\php\<ver>\php-cgi.exe FastCGI munkasok (Laravel)
        %WINDIR%\...\etc\hosts         <mappa>.test -> 127.0.0.1

    A "faek egyszeru" elv szerint NINCS Kulcs-Ertek adatbazis, nincs kulon
    daemon: ez a szkript inditja es allitja le a ket processzt, es a
    Caddyfile-t minden startnal ujrairja a projektprofilokbol.

    Projektprofil: <projekt>\.dsh\dev.yaml (kulcs: ertek sorok)
        domain  : termeszetgyogyaszoktatas-l12.test   (alapb.| <mappa>.test)
        docroot : public                              (alapb.| public ha van)
        php     : 8.4                                 (alapb.| current)
        aliases : www.<domain>,*.<domain>             (opcionalis)

    Allapot: state\dev\state.json, Caddyfile: state\dev\Caddyfile,
             naplok: state\dev\logs\.

.PARAMETER Action
    status  - allapot (alapértelmezett): portok, processzek, HTTP valasz.
    start   - elinditja (ujraindithato; a mar futot nem inditja ujra).
    stop    - leallitja a Caddy-t es a php-cgi munkasokat.
    restart - stop + start.
    logs    - az utolso naplosorok (Caddy + php).
    list    - a felismert projektek es profiljaik.

.PARAMETER Project
    Egyetlen projekt gyokere (opcionalis). Ha nincs, a SitesRoot alatti
    osszes projekt jon szoba.

.PARAMETER SitesRoot
    A Herd-szeru "parkolt" gyoker. Alapertelmezes: D:\Herd.

.PARAMETER HttpsPort
    A HTTPS port. 0 = automatikus: 443, ha szabad es nincs Herd; kulonben 8443.

.PARAMETER NoTrust
    Ne futtassa a "caddy trust"-ot (a tanusitvany nem lesz megbizhato).

.EXAMPLE
    pwsh -NoProfile -File tools\dev.ps1 list
    pwsh -NoProfile -File tools\dev.ps1 start
    pwsh -NoProfile -File tools\dev.ps1 status
    pwsh -NoProfile -File tools\dev.ps1 logs -Tail 40
#>
[CmdletBinding()]
param(
    [ValidateSet('status', 'start', 'stop', 'restart', 'logs', 'list')]
    [string]$Action = 'status',
    [string]$Project = '',
    [string]$SitesRoot = 'D:\Herd',
    [int]$HttpsPort = 0,
    [int]$Tail = 25,
    [switch]$NoTrust
)

$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path $PSScriptRoot -Parent
$StateDir = Join-Path $WorkspaceRoot 'state\dev'
$LogDir = Join-Path $StateDir 'logs'
$StateFile = Join-Path $StateDir 'state.json'
$CaddyFile = Join-Path $StateDir 'Caddyfile'
$CaddyExe = 'D:\Tools\caddy\caddy.exe'
$PhpRoot = 'D:\Tools\php'
$DefaultPhp = Join-Path $PhpRoot 'current'

New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null

# ---------------------------------------------------------------- segitok ---

function Read-DevProfile {
    param([string]$Root)
    $path = Join-Path $Root '.dsh\dev.yaml'
    $profile = [ordered]@{
        domain  = ''
        docroot = ''
        php     = 'current'
        aliases = ''
        source  = 'alapertelmezes'
    }
    if (Test-Path $path) {
        $profile.source = $path
        foreach ($line in Get-Content $path) {
            if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
            if ($line -match '^\s*([A-Za-z_]+)\s*:\s*(.*)$') {
                $key = $Matches[1]
                $value = ($Matches[2] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
                if ($profile.Contains($key)) { $profile[$key] = $value }
            }
        }
    }
    return [pscustomobject]$profile
}

function Get-DocRoot {
    param([string]$Root, [string]$Wanted)
    if ($Wanted -ne '') {
        $p = Join-Path $Root $Wanted
        if (Test-Path $p) { return (Resolve-Path $p).Path }
        return $null
    }
    foreach ($candidate in @('public', 'web', '')) {
        $p = if ($candidate -eq '') { $Root } else { Join-Path $Root $candidate }
        if (Test-Path (Join-Path $p 'index.php')) { return (Resolve-Path $p).Path }
    }
    return (Resolve-Path $Root).Path
}

function Get-Domain {
    param([string]$Root, [string]$Wanted)
    if ($Wanted -ne '') { return $Wanted.ToLowerInvariant() }
    return ((Split-Path $Root -Leaf).ToLowerInvariant() + '.test')
}

function Resolve-PhpDir {
    param([string]$Wanted)
    if ($Wanted -eq '' -or $Wanted -eq 'current') {
        if (Test-Path (Join-Path $DefaultPhp 'php-cgi.exe')) { return (Resolve-Path $DefaultPhp).Path }
        throw "Nincs PHP a $DefaultPhp alatt. Telepitsd: tools\php-version.ps1 -Use <verzio> (elotte D:\Tools\php\<verzio>)."
    }
    $dirs = @(Get-ChildItem $PhpRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+' })
    $hit = $dirs | Where-Object { $_.Name -eq $Wanted } | Select-Object -First 1
    if (-not $hit) { $hit = $dirs | Where-Object { $_.Name -like "$Wanted.*" } | Sort-Object Name -Descending | Select-Object -First 1 }
    if (-not $hit) { throw "Nincs ilyen PHP verzio: $Wanted (telepitve: $((@($dirs | ForEach-Object Name)) -join ', '))" }
    if (-not (Test-Path (Join-Path $hit.FullName 'php-cgi.exe'))) { throw "A $($hit.FullName) alatt nincs php-cgi.exe" }
    return $hit.FullName
}

function Test-PortFree {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return (-not $conn)
}

function Get-PortOwner {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return '' }
    $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($p) { return ("{0}({1})" -f $conn.OwningProcess, $p.ProcessName) }
    return ("{0}(?)" -f $conn.OwningProcess)
}

function Get-DevSites {
    $sites = @()
    if ($Project -ne '') {
        $roots = @($Project)
    } else {
        if (-not (Test-Path $SitesRoot)) { throw "A sites gyoker nem letezik: $SitesRoot" }
        $roots = @(Get-ChildItem $SitesRoot -Directory | ForEach-Object { $_.FullName })
    }
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $profile = Read-DevProfile -Root $root
        $docroot = Get-DocRoot -Root $root -Wanted $profile.docroot
        if (-not $docroot) { continue }
        if (-not (Test-Path (Join-Path $docroot 'index.php'))) { continue }
        $sites += [pscustomobject]@{
            project = (Resolve-Path $root).Path
            name    = (Split-Path $root -Leaf)
            domain  = (Get-Domain -Root $root -Wanted $profile.domain)
            aliases = $profile.aliases
            docroot = $docroot
            php     = $profile.php
            source  = $profile.source
        }
    }
    return $sites
}

function Read-State {
    if (Test-Path $StateFile) {
        try { return (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
    }
    return $null
}

function Save-State {
    param($State)
    $State | ConvertTo-Json -Depth 6 | Set-Content $StateFile -Encoding UTF8
}

function Get-EffectiveHttpsPort {
    param($State)
    if ($HttpsPort -gt 0) { return $HttpsPort }
    if ($State -and $State.caddy -and $State.caddy.httpsPort) { return [int]$State.caddy.httpsPort }
    if (Test-PortFree -Port 443) { return 443 }
    return 8443
}

# --------------------------------------------------------------- parancsok ---

function Invoke-List {
    $sites = Get-DevSites
    Write-Host "=== Dev projektek ($(if ($Project) { $Project } else { $SitesRoot })) ==="
    if ($sites.Count -eq 0) { Write-Host '  (nincs felismert projekt: kell index.php, esetleg .dsh\dev.yaml)'; return }
    foreach ($site in $sites) {
        $phpDir = try { Resolve-PhpDir -Wanted $site.php } catch { '' }
        Write-Host ("  {0,-40} {1}" -f $site.domain, $site.project)
        Write-Host ("      docroot: {0}" -f $site.docroot)
        Write-Host ("      php    : {0}  ->  {1}" -f $site.php, $(if ($phpDir) { $phpDir } else { 'HIANYZIK' }))
        Write-Host ("      forras : {0}" -f $site.source)
    }
}

function Invoke-Status {
    $state = Read-State
    Write-Host '=== DSH dev-kornyezet allapot ==='
    if (-not $state) {
        Write-Host '  nincs allapotfajl (state\dev\state.json) - meg nem indult a dev_start'
    } else {
        $caddyAlive = $false
        if ($state.caddy -and $state.caddy.pid) {
            $caddyAlive = [bool](Get-Process -Id $state.caddy.pid -ErrorAction SilentlyContinue)
        }
        Write-Host ("caddy        : {0}  pid {1}  port {2}/{3}" -f $(if ($caddyAlive) { 'FUT' } else { 'ALL' }), $state.caddy.pid, $state.caddy.httpPort, $state.caddy.httpsPort)
        Write-Host ("caddfile     : {0}" -f $CaddyFile)
        foreach ($site in $state.sites) {
            $alive = [bool](Get-Process -Id $site.phpCgiPid -ErrorAction SilentlyContinue)
            Write-Host ("  {0,-40} php-cgi {1}  port {2}  pid {3}" -f $site.domain, $(if ($alive) { 'FUT' } else { 'ALL' }), $site.phpCgiPort, $site.phpCgiPid)
        }
    }
    Write-Host ''
    Write-Host '--- portok ---'
    $https = Get-EffectiveHttpsPort -State $state
    foreach ($port in (@(80, 443, $https, 8443, 3306) | Select-Object -Unique)) {
        $owner = Get-PortOwner -Port $port
        if ($owner -eq '') { Write-Host ("  {0,-5} szabad" -f $port) }
        else { Write-Host ("  {0,-5} FOGLALT: {1}" -f $port, $owner) }
    }
    Write-Host ''
    Write-Host '--- processzek ---'
    $rows = Get-Process -ErrorAction SilentlyContinue | Where-Object { @('Herd', 'HerdHelper', 'nginx', 'php-cgi', 'caddy', 'mysqld') -contains $_.ProcessName }
    if ($rows) {
        $rows | Group-Object ProcessName | Sort-Object Name | ForEach-Object { Write-Host ("  {0,-12} {1} peldany" -f $_.Name, $_.Count) }
    } else { Write-Host '  nincs erdekes folyamat' }
    Write-Host ''
    Write-Host '--- hosts ---'
    $hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
    if ($state) {
        foreach ($site in $state.sites) {
            $hit = Select-String -Path $hostsPath -Pattern ("\s" + [regex]::Escape($site.domain) + "\s*$") -ErrorAction SilentlyContinue
            Write-Host ("  {0,-40} {1}" -f $site.domain, $(if ($hit) { 'SZEREPEL' } else { 'HIANYZIK' }))
        }
    }
    if ($state -and $state.caddy.httpsPort -ne 443) {
        Write-Host ''
        Write-Host ("FIGYELEM: a HTTPS port {0} (a 443-at mas foglalja, pl. Herd). A bongeszoben a cim: https://<domain>:{0}/" -f $state.caddy.httpsPort)
    }
}

function Invoke-Start {
    if (-not (Test-Path $CaddyExe)) { throw "Nincs Caddy: $CaddyExe" }
    $sites = Get-DevSites
    if ($sites.Count -eq 0) { throw 'Nincs indithato projekt (index.php nelkul nincs ertelme).' }

    $state = Read-State
    $httpsPort = Get-EffectiveHttpsPort -State $state
    $httpPort = 8080
    if (Test-PortFree -Port 80) { $httpPort = 80 }

    # 1) meglevo munkasok lezarasa (a start idempotens: nem halmoz)
    Invoke-Stop -Quiet

    # 2) php-cgi munkasok (egy folyamat / projekt)
    $nextPort = 9101
    $running = @()
    $usedPorts = @()
    foreach ($site in $sites) {
        $phpDir = Resolve-PhpDir -Wanted $site.php
        $iniPath = Join-Path $phpDir 'php.ini'
        $cgiPort = $nextPort
        while (-not (Test-PortFree -Port $cgiPort)) { $cgiPort++; if ($cgiPort -gt 9199) { throw 'Nincs szabad FastCGI port a 9100-9199 tartomanyban.' } }
        $nextPort = $cgiPort + 1
        $usedPorts += $cgiPort

        $outLog = Join-Path $LogDir ("php-" + $site.domain + ".log")
        $errLog = Join-Path $LogDir ("php-" + $site.domain + ".err.log")
        $args = @('-b', "127.0.0.1:$cgiPort")
        if (Test-Path $iniPath) { $args += @('-c', $iniPath) }
        $env:PHP_FCGI_CHILDREN = '6'
        $env:PHP_FCGI_MAX_REQUESTS = '500'
        $proc = Start-Process -FilePath (Join-Path $phpDir 'php-cgi.exe') -ArgumentList $args -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        Remove-Item Env:\PHP_FCGI_CHILDREN, Env:\PHP_FCGI_MAX_REQUESTS -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 350
        if ($proc.HasExited) { throw ("A php-cgi azonnal kilépett ({0}): {1}" -f $site.domain, (Get-Content $errLog -Raw -ErrorAction SilentlyContinue)) }
        $running += [pscustomobject]@{
            project     = $site.project
            name        = $site.name
            domain      = $site.domain
            aliases     = $site.aliases
            docroot     = $site.docroot
            php         = $site.php
            phpDir      = $phpDir
            phpCgiPid   = $proc.Id
            phpCgiPort  = $cgiPort
            phpLog      = $errLog
        }
        Write-Host ("php-cgi  {0,-38} port {1}  pid {2}" -f $site.domain, $cgiPort, $proc.Id)
    }

    # 3) Caddyfile ujrairasa a teljes listabol
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('{')
    $lines.Add("`thttps_port $httpsPort")
    $lines.Add("`thttp_port $httpPort")
    $lines.Add('	local_certs')
    $lines.Add("`tadmin localhost:2019")
    $lines.Add('}')
    $lines.Add('')
    foreach ($site in $running) {
        $addresses = @($site.domain)
        if ($site.aliases -ne '') { $addresses += ($site.aliases -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }) }
        $lines.Add(($addresses -join ', ') + ' {')
        $lines.Add("`troot * `"" + ($site.docroot -replace '\\', '/') + '"')
        $lines.Add("`tphp_fastcgi 127.0.0.1:$($site.phpCgiPort)")
        $lines.Add("`tencode zstd gzip")
        $lines.Add("`tfile_server")
        $accessLog = (Join-Path $LogDir ("access-" + $site.domain + ".log")) -replace '\\', '/'
        $lines.Add("`tlog {")
        $lines.Add("`t`toutput file `"$accessLog`"")
        $lines.Add('	}')
        $lines.Add('}')
        $lines.Add('')
    }
    [IO.File]::WriteAllLines($CaddyFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("Caddyfile: {0}" -f $CaddyFile)

    # 4) Caddy inditasa
    $caddyOut = Join-Path $LogDir 'caddy.log'
    $caddyErr = Join-Path $LogDir 'caddy.err.log'
    $caddyArgs = @('run', '--config', $CaddyFile, '--adapter', 'caddyfile')
    # FIGYELEM: az -ArgumentList tomb KOTULTELES nelkul fuzi ossze, ezert a
    # szokozt tartalmazo utvonalat sajat idezojelezessel kell atadni.
    $caddyArgLine = 'run --config "{0}" --adapter caddyfile' -f $CaddyFile
    $caddy = Start-Process -FilePath $CaddyExe -ArgumentList $caddyArgLine -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $caddyOut -RedirectStandardError $caddyErr
    Start-Sleep -Seconds 3
    if ($caddy.HasExited) { throw ("A Caddy azonnal kilépett: " + (Get-Content $caddyErr -Raw -ErrorAction SilentlyContinue)) }
    Write-Host ("caddy    pid {0}  https {1}  http {2}" -f $caddy.Id, $httpsPort, $httpPort)

    # 4b) a sajat CA megbizhatova tetele. FONTOS: NEM a "caddy trust"-ot
    # hasznaljuk — az a Windows-on certutil-t indit, es MERVE megakadt
    # (90 s utan sem tert vissza, kozben a Caddy mar futott). Helyette a Caddy
    # altal generalt gyoker-tanusitvany kerul a FELHASZNALOI taroloba, ami
    # emelt hatalom (UAC) nelkul megy es nem blokkol.
    if (-not $NoTrust) {
        $rootCrt = Join-Path $env:APPDATA 'Caddy\pki\authorities\local\root.crt'
        if (Test-Path $rootCrt) {
            & certutil -addstore -user Root $rootCrt 2>&1 | Out-Null
            $trusted = @(Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*Caddy*' })
            Write-Host ("CA megbizhatosag: {0}  ({1})" -f $(if ($trusted.Count -gt 0) { 'OK' } else { 'NEM sikerult' }), $rootCrt)
        } else {
            Write-Host 'CA megbizhatosag: a Caddy meg nem generalt gyoker-tanusitvanyt (elso HTTPS keres után lesz)'
        }
    }

    Save-State ([pscustomobject]@{
            startedAt = (Get-Date).ToString('s')
            caddy     = [pscustomobject]@{ pid = $caddy.Id; httpsPort = $httpsPort; httpPort = $httpPort; config = $CaddyFile; log = $caddyErr }
            sites     = $running
        })

    # 5) ellenorzes: valaszol-e a HTTPS
    Write-Host ''
    Write-Host '--- elso keresesek ---'
    foreach ($site in $running) {
        $url = "https://$($site.domain)" + $(if ($httpsPort -ne 443) { ":$httpsPort" } else { '' }) + '/'
        try {
            $resp = Invoke-WebRequest -Uri $url -SkipCertificateCheck -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
            Write-Host ("  {0} -> HTTP {1}" -f $url, [int]$resp.StatusCode)
        } catch {
            $code = ''
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            Write-Host ("  {0} -> {1}" -f $url, $(if ($code) { "HTTP $code" } else { $_.Exception.Message }))
        }
    }
}

function Invoke-Stop {
    param([switch]$Quiet)
    $state = Read-State
    $did = 0
    if ($state -and $state.caddy -and $state.caddy.pid) {
        $p = Get-Process -Id $state.caddy.pid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'caddy') {
            & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
            if (-not $Quiet) { Write-Host ("caddy leallitva (pid {0})" -f $p.Id) }
            $did++
        } elseif (-not $Quiet) { Write-Host ("caddy mar nem fut (pid {0})" -f $state.caddy.pid) }
    }
    if ($state) {
        foreach ($site in $state.sites) {
            $p = Get-Process -Id $site.phpCgiPid -ErrorAction SilentlyContinue
            if ($p -and $p.ProcessName -eq 'php-cgi') {
                & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
                if (-not $Quiet) { Write-Host ("php-cgi leallitva ({0}, pid {1})" -f $site.domain, $p.Id) }
                $did++
            } elseif (-not $Quiet) { Write-Host ("php-cgi mar nem fut ({0})" -f $site.domain) }
        }
    }
    # Allapot nelkuli maradek (pl. megszakadt start): a MI FastCGI portjaink
    # (9101-9199) hallgatoi es a MI Caddyfile-unkkal futo caddy. A Herd sajat
    # php-cgi-ja 9000+ tartomanyban van (pl. 9084), ezert nem esik aldozatul.
    # FONTOS: EGYETLEN portlekerdezes az egesz tartomanyra - a portonkenti
    # Get-NetTCPConnection 799 hivas ~30 s volt (merve: a start elakadt).
    $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -ge 9101 -and $_.LocalPort -le 9199 }
    foreach ($conn in $listeners) {
        $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'php-cgi') {
            & taskkill /PID $p.Id /T /F 2>&1 | Out-Null
            if (-not $Quiet) { Write-Host ("arva php-cgi leallitva (port {0}, pid {1})" -f $conn.LocalPort, $p.Id) }
            $did++
        }
    }
    $caddies = Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$CaddyFile*" }
    foreach ($c in $caddies) {
        & taskkill /PID $c.ProcessId /T /F 2>&1 | Out-Null
        if (-not $Quiet) { Write-Host ("arva caddy leallitva (pid {0})" -f $c.ProcessId) }
        $did++
    }
    Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
    if (-not $Quiet) {
        Write-Host ("leallitva: {0} folyamat; allapot torolve" -f $did)
    }
}

function Invoke-Logs {
    $state = Read-State
    Write-Host "=== Caddy naplo (utolso $Tail sor) ==="
    $caddyErr = Join-Path $LogDir 'caddy.err.log'
    if (Test-Path $caddyErr) { Get-Content $caddyErr -Tail $Tail } else { Write-Host '  (nincs)' }
    if ($state) {
        foreach ($site in $state.sites) {
            Write-Host ''
            Write-Host ("=== {0} php naplo (utolso {1} sor) ===" -f $site.domain, $Tail)
            if ($site.phpLog -and (Test-Path $site.phpLog)) { Get-Content $site.phpLog -Tail $Tail } else { Write-Host '  (nincs)' }
            $access = Join-Path $LogDir ("access-" + $site.domain + ".log")
            if (Test-Path $access) {
                Write-Host ("--- {0} access (utolso 10) ---" -f $site.domain)
                Get-Content $access -Tail 10
            }
        }
    }
}

switch ($Action) {
    'list' { Invoke-List }
    'status' { Invoke-Status }
    'start' { Invoke-Start }
    'stop' { Invoke-Stop }
    'restart' { Invoke-Stop; Start-Sleep -Milliseconds 500; Invoke-Start }
    'logs' { Invoke-Logs }
}
