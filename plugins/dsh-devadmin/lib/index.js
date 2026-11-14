/**
 * Host half of the DSH dev-admin plugin.
 *
 * This is the "admin felulet" backend: everything the local dev environment
 * (Caddy + php-cgi, PHP versions, ports, hosts, autostart, logs) can be read
 * and driven from the browser, without the user remembering PowerShell.
 *
 * Routes (server-side, so the browser needs no credential of its own):
 *
 *   GET /devadmin/state
 *     One JSON document: the dev server state (`state\dev\state.json`), the
 *     projects recognised under the sites root, PHP versions and the current
 *     selection, who owns the interesting ports, and the autostart entries.
 *
 *   GET /devadmin/action?action=start | stop | restart
 *     Starts or stops the dev server through `tools\dev-hidden.vbs` (wscript,
 *     no console window, returns immediately - AGENTS.md 1.2).
 *
 *   GET /devadmin/action?action=php-use&version=8.4
 *     Switches `D:\Tools\php\current` to the given version
 *     (`tools\php-version.ps1 -Use`), then reports the new target.
 *
 *   GET /devadmin/action?action=check-hosts
 *     Compares the sites with the hosts file and says which names are missing.
 *
 *   GET /devadmin/logs?site=<domain>&tail=<n>
 *     Tail of the Caddy log, the site's php-cgi log and its access log.
 *
 * Decision (deliberate): this plugin does NOT reimplement the dev server. It
 * calls the same `tools\dev.ps1` a human uses, so there is exactly one code
 * path and the measured, working behaviour cannot drift between CLI and UI.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { connect } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** A workspace repo gyokere (`plugins/dsh-devadmin` ket szinttel feljebb). */
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "tools");
const STATE_DIR = join(REPO_ROOT, "state", "dev");
const STATE_FILE = join(STATE_DIR, "state.json");
const LOG_DIR = join(STATE_DIR, "logs");
const DEV_PS1 = join(TOOLS_DIR, "dev.ps1");
const DEV_HIDDEN_VBS = join(TOOLS_DIR, "dev-hidden.vbs");
const PHP_VERSION_PS1 = join(TOOLS_DIR, "php-version.ps1");
const PHP_ROOT = "D:\\Tools\\php";
const SITES_ROOT = "D:\\Herd";
const HOSTS_FILE = join(process.env.WINDIR ?? "C:\\Windows", "System32", "drivers", "etc", "hosts");
const INTERESTING_PORTS = [80, 443, 8080, 8443, 3306, 5173, 2019];

const inject = ["webServer"];

// ----------------------------------------------------------------- helpers ---

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readTextFile(path, fallback = "") {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A folyamat el-e? `EPERM` = letezik, csak nem a mienk. */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function runFile(file, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: stdout ?? "", stderr: stderr ?? "", error: error?.message ?? "" });
    });
  });
}

/** Kivulrol inditott (nem a mi gyerekfolyamatunk) dev muvelet. */
function launchHidden(action) {
  return new Promise((resolve) => {
    const child = spawn("cscript", ["//nologo", DEV_HIDDEN_VBS, action], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("spawn", () => {
      child.unref();
      resolve({ ok: true, action });
    });
  });
}

function tailFile(path, lines) {
  const text = readTextFile(path);
  if (!text) return "";
  const all = text.split(/\r?\n/u).filter((line) => line !== "");
  return all.slice(-Math.max(1, Math.min(500, lines))).join("\n");
}

function portOwner(port) {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const pattern = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTEN\\w*\\s+(\\d+)`, "u");
      for (const line of (stdout ?? "").split(/\r?\n/u)) {
        if (!line.includes("LISTEN")) continue;
        const match = pattern.exec(line);
        if (match) return resolve(Number(match[1]));
      }
      resolve(null);
    });
  });
}

function pidName(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve("");
    execFile(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { windowsHide: true },
      (error, stdout) => {
        if (error) return resolve("");
        const first = (stdout ?? "").split(/\r?\n/u)[0] ?? "";
        const cells = first.split('","').map((cell) => cell.replace(/^"|"$/gu, ""));
        resolve(cells[0] ?? "");
      },
    );
  });
}

/** TCP elerheto-e a host:port (DBngin / MySQL ellenorzes). */
function testTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Egy site valaszat merjuk a sajat domainjen (a hosts bejegyzes miatt 127.0.0.1). */
function probeUrl(domain, httpsPort, path = "/") {
  return new Promise((resolve) => {
    const secure = httpsPort !== 0;
    const port = secure ? httpsPort : 80;
    const options = {
      host: domain,
      port,
      path,
      method: "GET",
      rejectUnauthorized: false,
      timeout: 8000,
      headers: { "user-agent": "dsh-devadmin" },
    };
    const requester = secure ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = requester(options, (response) => {
      response.resume();
      finish({ status: response.statusCode ?? 0, location: response.headers.location ?? "" });
    });
    req.on("timeout", () => {
      req.destroy();
      finish({ status: 0, error: "idotullepes" });
    });
    req.on("error", (error) => finish({ status: 0, error: error.code ?? error.message }));
    req.end();
  });
}

// -------------------------------------------------------------- dev profil ---

/** `.dsh\dev.yaml` minimalis olvasoja (ugyanaz a szemantika, mint a dev.ps1-ben). */
function readDevProfile(root) {
  const profile = { domain: "", docroot: "", php: "current", aliases: "", source: "alapertelmezes" };
  const path = join(root, ".dsh", "dev.yaml");
  if (!existsSync(path)) return profile;
  profile.source = path;
  for (const line of readTextFile(path).split(/\r?\n/u)) {
    if (/^\s*#/u.test(line) || /^\s*$/u.test(line)) continue;
    const match = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/\s+#.*$/u, "").trim().replace(/^["']|["']$/gu, "");
    if (Object.hasOwn(profile, key)) profile[key] = value;
  }
  return profile;
}

function discoverSites() {
  if (!isDir(SITES_ROOT)) return [];
  const sites = [];
  for (const entry of readdirSync(SITES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = join(SITES_ROOT, entry.name);
    const profile = readDevProfile(project);
    const docroot = profile.docroot && profile.docroot !== "." ? join(project, profile.docroot) : project;
    if (!existsSync(join(docroot, "index.php"))) continue;
    sites.push({
      project,
      name: entry.name,
      domain: (profile.domain || `${entry.name.toLowerCase()}.test`).toLowerCase(),
      aliases: profile.aliases,
      docroot,
      php: profile.php,
      profileSource: profile.source,
    });
  }
  return sites;
}

function phpVersions() {
  if (!isDir(PHP_ROOT)) return { root: PHP_ROOT, versions: [], current: null };
  const versions = readdirSync(PHP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  let current = null;
  try {
    const link = join(PHP_ROOT, "current");
    const resolved = statSync(link);
    if (resolved.isDirectory()) {
      // A junction celja: a php.exe verzioja a hiteles valasz.
      const out = execFileSync(join(link, "php.exe"), ["-r", "echo PHP_VERSION;"], {
        windowsHide: true,
        encoding: "utf8",
      });
      current = (out ?? "").trim() || null;
    }
  } catch {
    current = null;
  }
  return { root: PHP_ROOT, versions, current };
}

function databaseStatus(project) {
  const envPath = join(project, ".env");
  if (!existsSync(envPath)) return null;
  const cfg = {};
  for (const line of readTextFile(envPath).split(/\r?\n/u)) {
    const match = /^\s*(DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE)\s*=\s*(.*)$/u.exec(line);
    if (match) cfg[match[1]] = match[2].trim().replace(/^["']|["']$/gu, "");
  }
  if (!cfg.DB_CONNECTION) return null;
  return {
    connection: cfg.DB_CONNECTION,
    host: cfg.DB_HOST || "127.0.0.1",
    port: Number(cfg.DB_PORT || 3306),
    database: cfg.DB_DATABASE || "",
    reachable: null, // kitoltve a hivoban (async)
  };
}

function hostsEntries() {
  const text = readTextFile(HOSTS_FILE);
  const map = new Set();
  for (const line of text.split(/\r?\n/u)) {
    const clean = line.replace(/#.*$/u, "").trim();
    if (!clean) continue;
    for (const part of clean.split(/\s+/u).slice(1)) map.add(part.toLowerCase());
  }
  return map;
}

async function autostartEntries() {
  const entries = [];
  for (const hive of ["HKCU", "HKLM"]) {
    for (const key of ["Run", "RunOnce"]) {
      const path = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\${key}`;
      const result = await runFile("reg", ["query", path], 8000);
      if (!result.ok) continue;
      for (const line of result.stdout.split(/\r?\n/u)) {
        const match = /^\s{4}(\S.*?)\s{4}REG_SZ\s{4}(.*)$/u.exec(line);
        if (!match) continue;
        entries.push({ source: `${hive}:${key}`, name: match[1], command: match[2] });
      }
    }
  }
  const startup = join(homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  if (isDir(startup)) {
    for (const name of readdirSync(startup)) {
      if (name.toLowerCase() === "desktop.ini") continue;
      entries.push({ source: "Startup", name, command: join(startup, name) });
    }
  }
  return entries;
}

// ------------------------------------------------------------------ routes ---

async function handleState(_req, res) {
  const state = readJsonFile(STATE_FILE, null);
  const caddyPid = state?.caddy?.pid ?? null;
  const caddyAlive = pidAlive(caddyPid);
  const httpsPort = state?.caddy?.httpsPort ?? (state ? 443 : 0);
  const httpPort = state?.caddy?.httpPort ?? 80;

  const discovered = discoverSites();
  const byDomain = new Map();
  for (const site of discovered) byDomain.set(site.domain, { ...site, phpCgiPid: null, phpCgiPort: null });

  for (const site of state?.sites ?? []) {
    const known = byDomain.get(site.domain) ?? { ...site };
    known.phpCgiPid = site.phpCgiPid;
    known.phpCgiPort = site.phpCgiPort;
    known.phpLog = site.phpLog;
    byDomain.set(site.domain, known);
  }

  const hosts = hostsEntries();
  const sites = [];
  for (const site of byDomain.values()) {
    const alive = pidAlive(site.phpCgiPid);
    const db = databaseStatus(site.project);
    if (db && db.connection !== "sqlite") db.reachable = await testTcp(db.host, db.port);
    const probe = caddyAlive && site.phpCgiPort
      ? await probeUrl(site.domain, httpsPort)
      : { status: 0, error: "a dev szerver nem fut" };
    sites.push({
      ...site,
      url: `https://${site.domain}${httpsPort && httpsPort !== 443 ? `:${httpsPort}` : ""}/`,
      phpCgiAlive: alive,
      inHosts: hosts.has(site.domain),
      db,
      probe,
    });
  }

  const ports = [];
  for (const port of INTERESTING_PORTS) {
    const pid = await portOwner(port);
    ports.push({ port, pid, name: pid ? await pidName(pid) : "" });
  }

  json(res, 200, {
    devServer: {
      running: caddyAlive,
      caddyPid,
      httpsPort,
      httpPort,
      stateFile: STATE_FILE,
      configFile: join(STATE_DIR, "Caddyfile"),
      logDir: LOG_DIR,
      stateMissing: state === null,
    },
    sites,
    php: phpVersions(),
    ports,
    autostart: await autostartEntries(),
    paths: { repo: REPO_ROOT, tools: TOOLS_DIR, sitesRoot: SITES_ROOT, hosts: HOSTS_FILE },
    checkedAt: new Date().toISOString(),
  });
}

async function handleAction(url, res) {
  const action = url.searchParams.get("action") ?? "";
  if (action === "start" || action === "stop" || action === "restart") {
    const result = await launchHidden(action);
    return json(res, result.ok ? 200 : 500, { ok: result.ok, action, error: result.error ?? "" });
  }
  if (action === "php-use") {
    const version = url.searchParams.get("version") ?? "";
    if (!/^\d+\.\d+(\.\d+)?$/u.test(version)) return json(res, 400, { ok: false, error: "ervenytelen verzio" });
    const result = await runFile("pwsh", ["-NoProfile", "-NonInteractive", "-File", PHP_VERSION_PS1, "-Use", version]);
    return json(res, result.ok ? 200 : 500, {
      ok: result.ok,
      version,
      output: (result.stdout || result.stderr || result.error).trim(),
    });
  }
  if (action === "check-hosts") {
    const hosts = hostsEntries();
    const missing = discoverSites().filter((site) => !hosts.has(site.domain)).map((site) => site.domain);
    return json(res, 200, { ok: true, missing, hostsFile: HOSTS_FILE });
  }
  return json(res, 400, { ok: false, error: `ismeretlen action: ${action}` });
}

function handleLogs(url, res) {
  const site = (url.searchParams.get("site") ?? "").toLowerCase();
  const tail = Number(url.searchParams.get("tail") ?? "80") || 80;
  const body = {
    caddyError: tailFile(join(LOG_DIR, "caddy.err.log"), tail),
    caddyStdout: tailFile(join(LOG_DIR, "caddy.log"), Math.min(tail, 30)),
    php: null,
    access: null,
  };
  if (site) {
    body.php = tailFile(join(LOG_DIR, `php-${site}.log`), tail);
    body.phpError = tailFile(join(LOG_DIR, `php-${site}.err.log`), tail);
    body.access = tailFile(join(LOG_DIR, `access-${site}.log`), tail);
  }
  return json(res, 200, body);
}

/** A route-regisztracio bizonyiteka (a boot-hiba kulonben nem lathato). */
function logRoute(path, result) {
  try {
    appendFileSync(
      join(STATE_DIR, "devadmin.log"),
      `${new Date().toISOString()} route ${path}: ${result}\n`,
      "utf8",
    );
  } catch {
    /* a naplo hibaja nem allithatja meg a plugint */
  }
}

function apply(ctx) {
  if (ctx.webServer === undefined) return;
  const pagePath = join(PACKAGE_ROOT, "web", "index.html");
  const routes = [
    ["/devadmin/state", (req, res) => handleState(req, res)],
    ["/devadmin/action", (req, res) => handleAction(new URL(req.url ?? "/", "http://dsh.invalid"), res)],
    ["/devadmin/logs", (req, res) => handleLogs(new URL(req.url ?? "/", "http://dsh.invalid"), res)],
    [
      "/devadmin/",
      (_req, res) => {
        // A felulet egyetlen onallo HTML (nincs build, nincs kliens-bundle):
        // igy a MERT, mukodo host-vegpontokat hasznalja, es nem fugg a
        // kliens-plugin betoltesi sorrendjetol.
        const html = readTextFile(pagePath, "");
        if (!html) return json(res, 500, { ok: false, error: `hianyzik: ${pagePath}` });
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(html),
        });
        res.end(html);
      },
    ],
    [
      "/devadmin",
      (_req, res) => {
        res.writeHead(302, { location: "/devadmin/" });
        res.end();
      },
    ],
  ];
  for (const [path, handler] of routes) {
    ctx.effect(() => {
      try {
        // FONTOS (mert viselkedes): a web szerver route-tablaja KET rekesz -
        // `exact` (pontos egyezes) es prefix (minden mas `kind`). A korabbi
        // valtozat `kind: "exact"`-tal regisztralt, es a szerver a
        // `/devadmin/state`-re 404-et adott ("not yet claimed"), mikozben a
        // `/devadmin/` oldal ment. Ezert - a ui-extras mintajara - KIND NELKUL
        // regisztralunk (prefix rekesz), es a leghosszabb prefix nyer.
        const dispose = ctx.webServer.register({
          path,
          handler: (req, res) => {
            Promise.resolve(handler(req, res)).catch((error) => {
              json(res, 500, { ok: false, error: `devadmin: ${error?.message ?? error}` });
            });
          },
        });
        logRoute(path, "ok");
        return dispose;
      } catch (error) {
        logRoute(path, `hiba: ${error?.message ?? error}`);
        return () => {};
      }
    }, `devadmin: ${path}`);
  }
}

export { apply, inject };
export { discoverSites, phpVersions, testTcp, tailFile, probeUrl, DEV_PS1, DEV_HIDDEN_VBS };
export { handleState, handleAction, handleLogs, databaseStatus, hostsEntries, autostartEntries };
