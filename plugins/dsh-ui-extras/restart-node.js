/**
 * Restart helper spawned by the host route when the user presses the restart or
 * deploy button. It runs OUTSIDE the Harness process, so killing the listener
 * does not take the helper down with it.
 *
 * Steps:
 *   1) wait `delayMs` so the HTTP response that asked for the restart reaches the
 *      browser before the socket dies (without this, the request hangs forever
 *      and the interface is left on "Reconnecting"),
 *   2) kill every listener on the port,
 *   3) wait until the port is actually free,
 *   4) start a fresh `dsh web` server (detached, output redirected to a log),
 *   5) parse the fresh token URL out of that log and write it to the workspace
 *      state file, so both the desktop window and the language-pack probe can
 *      read it — the GUI reloads onto the new URL.
 *
 * Usage: node restart-node.js <port> <dsh-bin> [dshHome] [delayMs]
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, openSync, statSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATE_DIR = join(PACKAGE_ROOT, "..", "..", "state");
const LOG_FILE = join(STATE_DIR, "restart.log");
const SERVER_LOG = join(STATE_DIR, "restart-harness.log");
const SERVER_ERR = join(STATE_DIR, "restart-harness.err.log");
const URL_FILE = join(STATE_DIR, "harness.url");
// A tálca életjele és a külső újraindítási kérés. A tálca a DSH folyamatfáján
// KÍVÜL fut, ezért az újraindítást rá bízni a legbiztonságosabb út: a DSH
// `taskkill /F /T`-je nem éri el.
const TRAY_HEARTBEAT = join(STATE_DIR, "tray.heartbeat");
const TRAY_PID = join(STATE_DIR, "tray.pid");
const RESTART_REQUEST = join(STATE_DIR, "restart-request");

const [, , portArg, dshBin, dshHome, delayArg] = process.argv;
const port = Number(portArg) || 3080;
// Long enough for the response to leave the server socket, short enough that
// the interface does not look stuck.
const delayMs = Number.isFinite(Number(delayArg)) ? Math.max(0, Number(delayArg)) : 1500;

function log(message) {
  try {
    const stamp = new Date().toISOString();
    writeFileSync(LOG_FILE, `[${stamp}] ${message}\n`, { flag: "a" });
  } catch {
    // Nothing to do: the log is best-effort.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listeners() {
  // `netstat -ano` és NEM `Get-NetTCPConnection`: a cmdlet a WMI/CIM-en megy át,
  // ami elérhetetlen lehet (álló szolgáltatás, korlátozott munkamenet) — és akkor
  // CSENDBEN üres listát ad, ezért a port szabadnak látszana, a friss szerver
  // pedig EADDRINUSE-szal elhalna. A netstat sima program, mindig válaszol.
  return new Promise((resolve) => {
    const ns = spawn("netstat", ["-ano", "-p", "TCP"], { windowsHide: true });
    let out = "";
    ns.stdout.on("data", (chunk) => { out += chunk; });
    ns.stderr.on("data", () => { });
    ns.on("error", () => resolve([]));
    ns.on("close", () => {
      const pids = [];
      for (const line of out.split(/\r?\n/u)) {
        const match = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$/u);
        if (!match) continue;
        const local = match[1];
        const colon = local.lastIndexOf(":");
        if (colon < 0) continue;
        if (Number(local.slice(colon + 1)) !== port) continue;
        pids.push(Number(match[3]));
      }
      resolve([...new Set(pids)]);
    });
  });
}

function killPids(pids) {
  return new Promise((resolve) => {
    if (pids.length === 0) { resolve(); return; }
    const ps = spawn("powershell.exe", [
      "-NoProfile", "-Command",
      `${pids.map((pid) => `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`).join("; ")}`
    ], { windowsHide: true });
    ps.on("close", () => resolve());
  });
}

async function waitPortFree(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listeners()).length === 0) return true;
    await sleep(1000);
  }
  return false;
}

function startServer() {
  // The child's output MUST land in a file: the fresh token URL is printed on
  // startup, and both the desktop window and the probe read it back from
  // state/harness.url. `stdio: "ignore"` (the earlier shape) silently lost it.
  let outFd = "ignore";
  let errFd = "ignore";
  try {
    outFd = openSync(SERVER_LOG, "a");
    errFd = openSync(SERVER_ERR, "a");
  } catch {
    outFd = "ignore";
    errFd = "ignore";
  }
  const child = spawn("node", [dshBin, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"], {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    env: { ...process.env, DSH_HOME: dshHome }
  });
  child.unref();
  log(`started new harness pid ${child.pid}`);
  return child.pid;
}

/** Read the token URL the fresh server printed, and persist it. */
async function publishTokenUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9_\\-]+`, "u");
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      if (!existsSync(SERVER_LOG)) continue;
      const text = readFileSync(SERVER_LOG, "utf8");
      const matches = text.match(new RegExp(pattern, "gu"));
      if (!matches || matches.length === 0) continue;
      const url = matches[matches.length - 1];
      // Atomikus írás: a csonka `harness.url` (74 byte helyett 3 byte) után
      // minden olvasó a régi tokent látta, és a felület "Reconnecting"-be ragadt.
      const tmp = URL_FILE + ".tmp";
      writeFileSync(tmp, url, "ascii");
      renameSync(tmp, URL_FILE);
      log(`new token URL saved: ${url}`);
      return url;
    } catch (error) {
      log(`token read failed: ${String(error?.message ?? error)}`);
    }
  }
  log("ERROR: no token URL appeared in the server log");
  return null;
}

/**
 * Fut-e a tálca? KÉT független jel, mert az életjel-fájl önmagában félrevezet:
 * ha a tálca nem a menüből lép ki (összeomlik, kilövik), a fájl FRISS marad, és
 * a kérés egy halott folyamathoz kerülne — mért hiba (2026-10-02): így várt a
 * `restart-harness.ps1` 150 másodpercig, miközben a harness leállva maradt.
 */
function trayPidAlive() {
  try {
    if (!existsSync(TRAY_PID)) return false;
    const raw = readFileSync(TRAY_PID, "ascii").trim();
    if (!/^\d+$/u.test(raw)) return false;
    process.kill(Number(raw), 0); // dob, ha nincs ilyen folyamat
    return true;
  } catch {
    return false;
  }
}

function trayAlive(maxAgeMs = 30000) {
  if (!trayPidAlive()) return false;
  try {
    if (!existsSync(TRAY_HEARTBEAT)) return false;
    return (Date.now() - statSync(TRAY_HEARTBEAT).mtimeMs) <= maxAgeMs;
  } catch {
    return false;
  }
}

/** Az újraindítás átadása a tálcának (atomikus kérés-írás). */
function requestTrayRestart() {
  const body = JSON.stringify({ kereAt: new Date().toISOString(), port, forras: "restart-node.js" });
  const tmp = RESTART_REQUEST + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, RESTART_REQUEST);
}

/** Megvárja, hogy a token-fájl frissüljön (a tálca írja ki). */
async function waitForFreshToken(timeoutMs) {
  let before = 0;
  try { if (existsSync(URL_FILE)) before = statSync(URL_FILE).mtimeMs; } catch { }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      if (!existsSync(URL_FILE)) continue;
      if (statSync(URL_FILE).mtimeMs <= before) continue;
      const raw = readFileSync(URL_FILE, "utf8").trim();
      if (/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+$/u.test(raw)) return raw;
    } catch { }
  }
  return null;
}

async function main() {
  log(`restart requested on port ${port} (delay ${delayMs}ms)`);
  // Let the response that triggered this restart reach the browser first.
  if (delayMs > 0) await sleep(delayMs);

  // 1) Ha a tálca fut, ő végzi el: az egyetlen folyamat, amely a DSH
  //    folyamatfáján kívül fut, ezért ott az újraindítás nem szakadhat félbe
  //    (a DSH `taskkill /F /T`-je nem éri el).
  if (trayAlive()) {
    log("a talca fut - az ujrainditas atadva neki");
    try {
      requestTrayRestart();
      const url = await waitForFreshToken(90000);
      if (url) {
        log(`a talca befejezte (${url})`);
        process.exit(0);
      }
      log("a talca 90 masodperc alatt nem adott friss tokent - sajat ut");
    } catch (error) {
      log(`az atadas nem sikerult: ${String(error?.message ?? error)} - sajat ut`);
    }
    // Nem hagyjuk magunk utan a kérést: különben egy később induló tálca
    // (300 másodpercen belül) még egyszer újraindítaná a friss szervert.
    try { rmSync(RESTART_REQUEST, { force: true }); } catch { }
  }

  for (let i = 0; i < 6; i++) {
    const pids = await listeners();
    if (pids.length === 0) break;
    log(`killing listeners: ${pids.join(", ")}`);
    await killPids(pids);
    await sleep(2000);
  }
  if (!(await waitPortFree(30000))) {
    log("ERROR: the port did not become free");
    process.exit(1);
  }

  const pid = startServer();
  const url = await publishTokenUrl(45000);
  log(url ? `restart complete (pid ${pid})` : `restart finished without a token URL (pid ${pid})`);
  process.exit(url ? 0 : 1);
}

main();
