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
    [ValidateSet('status', 'start', 'stop', 'restart', 'logs', 'list', 'service', 'php-install', 'php-available', 'php-ini')]
    [string]$Action = 'status',
    [string]$Project = '',
    [string]$SitesRoot = 'D:\Herd',
    [int]$HttpsPort = 0,
    [int]$Tail = 25,
    [switch]$NoTrust,
    # service muvelet: melyik szolgaltatas (caddy | php:<domain> | all)
    [string]$Service = '',
    [ValidateSet('start', 'stop', 'restart', 'status')]
    [string]$ServiceAction = 'status',
    # php-install: a telepítendo verzio (pl. 8.4.27 vagy 8.4 = a legfrissebb 8.4.x)
    [string]$PhpVersion = '',
    # php-install: a 'current' junction is erre alljon at
    [switch]$MakeCurrent
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

# Hiteles valasz arra, hogy MI tudunk-e bindolni a portra (a "foglalt-e"
# kerdesnel pontosabb: a lecsengo socket nem akadaly, a tenyleges bind igen).
function Test-PortBindable {
    param([int]$Port)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Wait-PortBindable {
    param([int]$Port, [int]$Tries = 16, [int]$DelayMs = 250)
    for ($i = 0; $i -lt $Tries; $i++) {
        if (Test-PortBindable -Port $Port) { return $true }
        Start-Sleep -Milliseconds $DelayMs
    }
    return $false
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

function Test-TcpPort {
    param([string]$HostName, [int]$Port, [int]$TimeoutMs = 800)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        if (-not $task.Wait($TimeoutMs)) { return $false }
        return $client.Connected
    } catch { return $false } finally { $client.Dispose() }
}

# DBngin (es minden mas helyi MySQL) ellenorzese: a Laravel .env DB_HOST /
# DB_PORT / DB_DATABASE sorait olvassuk, es TCP-vel megnezzuk, elerheto-e.
# Nem irunk semmit: ha nem elerheto, kimondjuk a teendot (dev_start -FixEnv
# kesobbi szakasz).
function Get-DatabaseStatus {
    param([string]$Root)
    $envFile = Join-Path $Root '.env'
    if (-not (Test-Path $envFile)) { return $null }
    $cfg = @{}
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*(DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE)\s*=\s*(.*)$') {
            $cfg[$Matches[1]] = $Matches[2].Trim().Trim('"')
        }
    }
    if (-not $cfg.ContainsKey('DB_CONNECTION')) { return $null }
    $conn = $cfg['DB_CONNECTION']
    $dbHost = if ($cfg.ContainsKey('DB_HOST')) { $cfg['DB_HOST'] } else { '127.0.0.1' }
    $dbPort = if ($cfg.ContainsKey('DB_PORT')) { [int]$cfg['DB_PORT'] } else { 3306 }
    $reachable = $false
    if ($conn -eq 'sqlite') { $reachable = $true } else { $reachable = Test-TcpPort -HostName $dbHost -Port $dbPort }
    return [pscustomobject]@{
        connection = $conn
        host       = $dbHost
        port       = $dbPort
        database   = $(if ($cfg.ContainsKey('DB_DATABASE')) { $cfg['DB_DATABASE'] } else { '' })
        reachable  = $reachable
    }
}

function Write-DatabaseStatus {
    param($Db, [string]$Indent = '      ')
    if (-not $Db) { return }
    if ($Db.connection -eq 'sqlite') {
        Write-Host ("{0}db     : sqlite ({1})" -f $Indent, $Db.database)
        return
    }
    $state = if ($Db.reachable) { 'ELERHETO' } else { 'NEM ELERHETO' }
    Write-Host ("{0}db     : {1} {2}:{3}/{4}  -> {5}" -f $Indent, $Db.connection, $Db.host, $Db.port, $Db.database, $state)
    if (-not $Db.reachable) {
        Write-Host ("{0}         Inditsd el a DBngint (vagy a mysqld-t), illetve ellenorizd a .env DB_HOST/DB_PORT sorait." -f $Indent)
    }
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
    # A kanonikus URL a 443 (Herd nelkul ez a termeszetes). Ezert ha a 443
    # szabad, mindig azt vesszuk - meg akkor is, ha a korabbi allapot 8443-at
    # jegyzett (Herd meg futott). Csak foglalt 443 eseten esunk vissza.
    if (Test-PortFree -Port 443) { return 443 }
    if ($State -and $State.caddy -and $State.caddy.httpsPort) {
        $recorded = [int]$State.caddy.httpsPort
        if ($recorded -ne 443) { return $recorded }
    }
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
        Write-DatabaseStatus -Db (Get-DatabaseStatus -Root $site.project) -Indent '      '
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
            Write-DatabaseStatus -Db (Get-DatabaseStatus -Root $site.project) -Indent '      '
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
    # A taskkill utan a regi processz socketje par ms-ig meg el, ezert a
    # 443/80-at a TENYLEGES bind-dal probaljuk (nem a "van-e listener" késsel).
    # Merve: a listener-alapu vizsgalat 443-at foglaltnak latta, es a start a
    # 8443-on maradt, illetve a HTTP port 8080 lett a 80 helyett.
    $httpsReady = Wait-PortBindable -Port 443
    $httpReady = Wait-PortBindable -Port 80
    $httpsPort = if ($httpsReady) { 443 } else { Get-EffectiveHttpsPort -State $state }
    if ($HttpsPort -gt 0) { $httpsPort = $HttpsPort }
    $httpPort = if ($httpReady) { 80 } else { 8080 }
    if (-not $httpReady) {
        Write-Host 'FIGYELEM: a 80-as port nem szabadult fel; a HTTP atiranyitas a 8080-on megy.'
    }

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
        $db = Get-DatabaseStatus -Root $site.project
        if ($db -and -not $db.reachable) {
            Write-Host ("  FIGYELEM: {0} adatbazisa nem elerheto ({1}:{2}). Inditsd el a DBngint!" -f $site.domain, $db.host, $db.port)
        }
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

<#
    EGYETLEN szolgaltatas inditasa/leallitasa/ujrainditasa a mar futo
    allapot alapjan. Igy a felulet (admin) nem indithat dupla processzt: a
    portok es a pidek a `state.json`-bol jonnek, es a muvelet utan oda irjuk
    vissza az uj pidet.
#>
function Invoke-Service {
    param([string]$Name, [string]$Verb)

    $state = Read-State
    if (-not $state) { throw 'a dev szerver nem fut (nincs state\dev\state.json) - elobb start kell' }

    $caddyOut = Join-Path $LogDir 'caddy.log'
    $caddyErr = Join-Path $LogDir 'caddy.err.log'

    function Start-CaddyNow {
        $argLine = 'run --config "{0}" --adapter caddyfile' -f $CaddyFile
        $proc = Start-Process -FilePath $CaddyExe -ArgumentList $argLine -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $caddyOut -RedirectStandardError $caddyErr
        Start-Sleep -Seconds 2
        if ($proc.HasExited) { throw ('a Caddy azonnal kilepett: ' + (Get-Content $caddyErr -Raw -ErrorAction SilentlyContinue)) }
        return $proc.Id
    }

    function Start-PhpCgiNow {
        param($Site)
        $phpExe = Join-Path $Site.phpDir 'php-cgi.exe'
        if (-not (Test-Path $phpExe)) { throw "nincs php-cgi: $phpExe" }
        $ini = Join-Path $Site.phpDir 'php.ini'
        $args = @('-b', "127.0.0.1:$($Site.phpCgiPort)")
        if (Test-Path $ini) { $args += @('-c', $ini) }
        $env:PHP_FCGI_CHILDREN = '6'
        $env:PHP_FCGI_MAX_REQUESTS = '500'
        $out = Join-Path $LogDir ("php-" + $Site.domain + ".log")
        $err = Join-Path $LogDir ("php-" + $Site.domain + ".err.log")
        $proc = Start-Process -FilePath $phpExe -ArgumentList $args -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err
        Remove-Item Env:\PHP_FCGI_CHILDREN, Env:\PHP_FCGI_MAX_REQUESTS -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
        if ($proc.HasExited) { throw ("a php-cgi azonnal kilepett ({0}): {1}" -f $Site.domain, (Get-Content $err -Raw -ErrorAction SilentlyContinue)) }
        return $proc.Id
    }

    $names = if ($Name -eq 'all') { @('caddy') + @($state.sites | ForEach-Object { "php:$($_.domain)" }) } else { @($Name) }
    $done = @()

    foreach ($target in $names) {
        if ($target -eq 'caddy') {
            if ($Verb -in @('stop', 'restart')) {
                $pidNow = $state.caddy.pid
                $proc = if ($pidNow) { Get-Process -Id $pidNow -ErrorAction SilentlyContinue } else { $null }
                if ($proc -and $proc.ProcessName -eq 'caddy') { & taskkill /PID $pidNow /T /F 2>&1 | Out-Null }
                for ($i = 0; $i -lt 20; $i++) { if (Test-PortBindable -Port ([int]$state.caddy.httpsPort)) { break }; Start-Sleep -Milliseconds 200 }
                $state.caddy.pid = 0
                $done += 'caddy: leallitva'
            }
            if ($Verb -in @('start', 'restart')) {
                $state.caddy.pid = Start-CaddyNow
                $done += ("caddy: fut (pid {0})" -f $state.caddy.pid)
            }
            if ($Verb -eq 'status') { $done += ("caddy: pid {0}" -f $state.caddy.pid) }
            continue
        }

        if ($target -like 'php:*') {
            $domain = $target -replace '^php:', ''
            $site = $state.sites | Where-Object { $_.domain -eq $domain } | Select-Object -First 1
            if (-not $site) { throw "nincs ilyen site a futasban: $domain" }
            if ($Verb -in @('stop', 'restart')) {
                $proc = if ($site.phpCgiPid) { Get-Process -Id $site.phpCgiPid -ErrorAction SilentlyContinue } else { $null }
                if ($proc -and $proc.ProcessName -eq 'php-cgi') { & taskkill /PID $site.phpCgiPid /T /F 2>&1 | Out-Null }
                for ($i = 0; $i -lt 20; $i++) { if (Test-PortBindable -Port ([int]$site.phpCgiPort)) { break }; Start-Sleep -Milliseconds 200 }
                $site.phpCgiPid = 0
                $done += ("{0}: leallitva" -f $domain)
            }
            if ($Verb -in @('start', 'restart')) {
                $site.phpCgiPid = Start-PhpCgiNow -Site $site
                $done += ("{0}: fut (pid {1}, port {2})" -f $domain, $site.phpCgiPid, $site.phpCgiPort)
            }
            if ($Verb -eq 'status') { $done += ("{0}: pid {1}, port {2}" -f $domain, $site.phpCgiPid, $site.phpCgiPort) }
            continue
        }

        throw "ismeretlen szolgaltatas: $target (caddy | php:<domain> | all)"
    }

    Save-State $state
    foreach ($line in $done) { Write-Host $line }
}

<#
    php.ini generalasa egy telepitett PHP-hoz, a tenyleges `ext` tartalomhoz.
    Csak akkor ir, ha a fajl nem letezik, vagy a MI fejlecuenket tartalmazza
    (tehat nem ir fel kezzel testreszabottat).
#>
function New-PhpIni {
    param([string]$PhpDir)
    $iniPath = Join-Path $PhpDir 'php.ini'
    $ours = $false
    if (Test-Path $iniPath) {
        $first = (Get-Content $iniPath -TotalCount 1) -join ''
        $ours = $first -match 'DSH dev PHP'
        if (-not $ours) { return @("php.ini mar letezik es nem a mienk: $iniPath (nem irom felul)") }
    }
    $extDir = Join-Path $PhpDir 'ext'
    $wanted = @('curl', 'fileinfo', 'gd', 'intl', 'mbstring', 'openssl', 'pdo_mysql', 'pdo_sqlite', 'sqlite3', 'exif', 'sodium', 'zip', 'mysqli')
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('; DSH dev PHP — faek egyszeru Laravel fejlesztokornyezet (Herd kivaltas)')
    $lines.Add('[PHP]')
    $lines.Add(('extension_dir = "{0}"' -f $extDir))
    $lines.Add('memory_limit = 512M')
    $lines.Add('error_reporting = E_ALL')
    $lines.Add('display_errors = On')
    $lines.Add('display_startup_errors = On')
    $lines.Add('log_errors = On')
    $lines.Add('error_log = "D:\Tools\php\logs\php_errors.log"')
    $lines.Add('date.timezone = Europe/Budapest')
    $lines.Add('default_charset = "UTF-8"')
    $lines.Add('max_execution_time = 0')
    $lines.Add('max_input_time = -1')
    $lines.Add('upload_max_filesize = 64M')
    $lines.Add('post_max_size = 64M')
    $lines.Add('max_input_vars = 5000')
    $lines.Add('allow_url_fopen = On')
    $lines.Add('cgi.fix_pathinfo = 1')
    $lines.Add('realpath_cache_size = 4096k')
    $lines.Add('realpath_cache_ttl = 600')
    $lines.Add('')
    $enabled = @()
    foreach ($name in $wanted) {
        if (Test-Path (Join-Path $extDir ("php_{0}.dll" -f $name))) {
            $lines.Add(('extension={0}' -f $name))
            $enabled += $name
        }
    }
    $lines.Add('')
    $lines.Add('[opcache]')
    if (Test-Path (Join-Path $extDir 'php_opcache.dll')) {
        $lines.Add('zend_extension=opcache')
        $enabled += 'opcache(kulso DLL)'
    } else {
        # 8.5+: az OPcache beepitett, kulon sor nem kell (sot: hiba lenne)
        $lines.Add('; az OPcache ebben a verzioban BEEPITETT, nincs kulon zend_extension')
        $enabled += 'opcache(beepitett)'
    }
    $lines.Add('opcache.enable=1')
    $lines.Add('opcache.enable_cli=0')
    $lines.Add('opcache.validate_timestamps=1')
    $lines.Add('opcache.revalidate_freq=0')
    $lines.Add('')
    $lines.Add('[Session]')
    $lines.Add('session.save_path = "D:\Tools\php\logs"')
    [IO.File]::WriteAllLines($iniPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
    return @(("php.ini megirva: {0}  [{1}]" -f $iniPath, ($enabled -join ', ')))
}

<#
    PHP-verzio telepito (a valto csak akkor tud valtani, ha van mibol).
    A hivatalos windows.php.net "releases.json"-bol valasztja a kert verziohoz
    tartozo NTS x64 ZIP-et, kicsomagolja D:\Tools\php\<verzio> ala, es a
    faek-egyszeru php.ini-t is megirja. Nem indit ujra semmit.
#>
function Invoke-PhpInstall {
    param([string]$Version, [switch]$MakeCurrent)

    if ([string]::IsNullOrWhiteSpace($Version)) { throw 'php-install: kell a -PhpVersion (pl. 8.4.27 vagy 8.4)' }
    $rels = Invoke-RestMethod 'https://windows.php.net/downloads/releases/releases.json' -TimeoutSec 60
    $all = @($rels.PSObject.Properties.Name | Where-Object { $_ -match '^\d+\.\d+' })

    $wanted = if ($Version -match '^\d+\.\d+$') {
        # a releases.json kulcsa legtobbszor pontosan "8.5" (patch nelkul), neha "8.4.27":
        $all | Where-Object { $_ -eq $Version -or $_ -like "$Version.*" } | Sort-Object { [version]$_ } -Descending | Select-Object -First 1
    } else {
        $all | Where-Object { $_ -eq $Version } | Select-Object -First 1
    }
    if (-not $wanted) { throw ("nincs ilyen kiadas a windows.php.net listaban: {0} (elerheto: {1})" -f $Version, (($all | Sort-Object -Descending | Select-Object -First 8) -join ', ')) }

    $entry = $rels.$wanted
    $node = if ($entry.'nts-vs17-x64') { $entry.'nts-vs17-x64' } elseif ($entry.'nts-vs16-x64') { $entry.'nts-vs16-x64' } else { $null }
    if (-not $node -or -not $node.zip) { throw ("a(z) {0} kiadasnak nincs NTS x64 ZIP-je" -f $wanted) }
    $zipName = [string]$node.zip.path
    if ([string]::IsNullOrWhiteSpace($zipName)) { throw 'a releases.json nem adott ZIP-fajlnevet' }

    # A releases.json kulcsa foallapot (8.4), a ZIP neve pontos verzio (8.4.27):
    # a telepitesi konyvtar a PONTOS verzio legyen, mert a projektprofil is ezt keri.
    $patchMatch = [regex]::Match($zipName, 'php-(\d+\.\d+\.\d+)-')
    $target = if ($patchMatch.Success) { $patchMatch.Groups[1].Value } else { $wanted }
    $dest = Join-Path $PhpRoot $target
    if (Test-Path (Join-Path $dest 'php.exe')) {
        Write-Host ("mar telepitve: {0} ({1})" -f $target, $dest)
    } else {
        New-Item -ItemType Directory -Force -Path $PhpRoot, (Join-Path $PhpRoot '_dl'), $dest | Out-Null
        $zip = Join-Path (Join-Path $PhpRoot '_dl') $zipName
        if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 10MB) {
            $ProgressPreference = 'SilentlyContinue'
            Write-Host ("letoltes: {0}" -f $zipName)
            Invoke-WebRequest ("https://windows.php.net/downloads/releases/" + $zipName) -OutFile $zip -TimeoutSec 600
        }
        Write-Host ("kicsomagolas: {0} -> {1}" -f $zipName, $dest)
        Expand-Archive -Path $zip -DestinationPath $dest -Force
        if (-not (Test-Path (Join-Path $dest 'php.exe'))) { throw ("a kicsomagolas utan sincs php.exe itt: {0}" -f $dest) }

        # A php.ini VERZIOFUGGO: ami eppen letezik az `ext` konyvtarban, azt
        # kapcsoljuk be. MERVE (2026-11-14): a 8.5-ben az OPcache BEEPITETT
        # (nincs php_opcache.dll), a 8.4-ben kulon DLL - egy fix sablon ezert
        # vagy hianyzo extension-t jelzett, vagy nem volt opcache.
        New-PhpIni -PhpDir $dest | ForEach-Object { Write-Host $_ }
    }

    $version = (& (Join-Path $dest 'php.exe') -r 'echo PHP_VERSION;' 2>$null) -join ''
    Write-Host ("telepitve: {0} -> {1}  (php {2})" -f $target, $dest, $version)

    if ($MakeCurrent) {
        & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'php-version.ps1') -Use $target | ForEach-Object { Write-Host $_ }
    } else {
        Write-Host ("a 'current' atallitasahoz: tools\php-version.ps1 -Use {0}" -f $target)
    }
}

<#
    A windows.php.net kinalatanak listaja (mi telepitheto). Csak az NTS x64
    ZIP-pel rendelkezo kiadasok, a mar telepitettek jelolve.
#>
function Invoke-PhpAvailable {
    $rels = Invoke-RestMethod 'https://windows.php.net/downloads/releases/releases.json' -TimeoutSec 60
    $installed = @()
    if (Test-Path $PhpRoot) {
        $installed = @(Get-ChildItem $PhpRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+\.\d+' } | ForEach-Object { $_.Name })
    }
    $rows = @()
    foreach ($name in @($rels.PSObject.Properties.Name | Where-Object { $_ -match '^\d+\.\d+' } | Sort-Object { [version]$_ } -Descending)) {
        $node = $rels.$name.'nts-vs17-x64'
        if (-not $node -or -not $node.zip) { continue }
        $rows += [pscustomobject]@{
            version   = $name
            zip       = [string]$node.zip.path
            installed = (@($installed | Where-Object { $_ -eq $name -or $_ -like "$name.*" }).Count -gt 0)
        }
    }
    $rows | ConvertTo-Json -Depth 3
}

switch ($Action) {
    'list' { Invoke-List }
    'status' { Invoke-Status }
    'start' { Invoke-Start }
    'stop' { Invoke-Stop }
    'restart' { Invoke-Stop; Start-Sleep -Milliseconds 500; Invoke-Start }
    'logs' { Invoke-Logs }
    'service' { Invoke-Service -Name $Service -Verb $ServiceAction }
    'php-available' { Invoke-PhpAvailable }
    'php-ini' { New-PhpIni -PhpDir (Resolve-PhpDir -Wanted $PhpVersion) | ForEach-Object { Write-Host $_ } }
    'php-install' { Invoke-PhpInstall -Version $PhpVersion -MakeCurrent:$MakeCurrent }
}

