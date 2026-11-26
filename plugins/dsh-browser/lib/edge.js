/**
 * dsh-browser/edge — a böngésző indítása a HOST processzből.
 *
 * MIÉRT itt: a Chromium a DSH sandboxában szerkezetileg nem tud elindulni
 * (mojo platform channel + crashpad named pipe → „A hozzáférés megtagadva").
 * A tool ezért a harness saját processzében indítja a böngészőt, ugyanúgy,
 * ahogy a `dsh-ui-extras` panelei és a `probe-hero.mjs` is teszik.
 *
 * AGENTS.md 1. pont: LÁTHATÓ ablakot ez a modul soha nem hoz létre —
 * `--headless=new` + `windowsHide: true` + `stdio: "ignore"`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

/** A telepített böngészők jelölt helyei (Edge az elsődleges ezen a gépen). */
const CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

/**
 * Az első létező böngésző futtatható fájlja.
 * @returns {string|null}
 */
export function findBrowser() {
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

/**
 * Egy szabad TCP-port a 127.0.0.1-en (a DevTools végpontnak).
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("nem sikerült szabad portot találni"));
      });
    });
  });
}

/**
 * A böngésző indítása (headless, saját profil, saját DevTools port).
 * @param {{exe: string, profileDir: string, port: number, args?: readonly string[]}} options
 * @returns {import("node:child_process").ChildProcess}
 */
export function launch(options) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,OptimizationHints",
    `--remote-debugging-port=${options.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${options.profileDir}`,
    ...(options.args ?? []),
    "about:blank"
  ];
  return spawn(options.exe, args, { windowsHide: true, stdio: "ignore", detached: false });
}

/**
 * A DevTools WebSocket-végpont bevárása.
 * @param {number} port
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{wsUrl: string, targets: Array<object>}>}
 */
export async function waitForEndpoint(port, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  let lastError = null;
  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new Error("a böngésző indítása megszakítva");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      const targets = await response.json();
      const page = Array.isArray(targets)
        ? targets.find((entry) => entry?.type === "page" && typeof entry.webSocketDebuggerUrl === "string")
        : undefined;
      if (page !== undefined) return { wsUrl: page.webSocketDebuggerUrl, targets };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`a DevTools végpont (127.0.0.1:${port}) nem indult el${lastError === null ? "" : `: ${String(lastError?.message ?? lastError)}`}`);
}

/**
 * A böngésző lezárása ELŐBB szabályosan (`Browser.close`), csak utána kényszerrel.
 *
 * MIÉRT (mért hiba, 2026-11-26): a `taskkill /F /T` azonnal megöli a
 * folyamatot, ezért a Chrome nem tudja kiírni a profilját — a TARTÓS profilba
 * tett süti elveszett („süti túlélte az újraindítást: nem"). A szabályos zárás
 * kiírja a profilt, és csak a megmaradt fát visszük el `taskkill`-lel.
 * @param {import("node:child_process").ChildProcess | null} child
 * @param {{send: (method: string, params?: object) => Promise<any>, closed?: boolean} | null} client
 * @param {number} [graceMs]
 * @returns {Promise<void>}
 */
export async function gracefulClose(child, client, graceMs = 5000) {
  if (client !== null && client !== undefined && client.closed !== true) {
    try {
      await client.send("Browser.close", {});
    } catch {
      /* a böngésző már nem fogad parancsot */
    }
  }
  const deadline = Date.now() + graceMs;
  while (child !== null && child !== undefined && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop(child);
}

/**
 * A böngésző és a teljes gyermekfája leállítása — KIZÁRÓLAG a saját PID-del.
 *
 * AGENTS.md 1.6: név szerinti ölés tilos; itt a PID a saját, általunk indított
 * folyamaté. A `/T` a renderelőket is viszi, hogy ne maradjon árva folyamat.
 * @param {import("node:child_process").ChildProcess | null} child
 * @returns {Promise<void>}
 */
export async function stop(child) {
  if (child === null || child === undefined) return;
  const pid = child.pid;
  if (typeof pid !== "number") return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* már halott */
      }
      resolve();
    }, 6000);
    killer.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.once("error", () => {
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* már halott */
      }
      resolve();
    });
  });
}
