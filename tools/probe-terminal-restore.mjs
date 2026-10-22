/**
 * probe-terminal-restore.mjs — prove that the terminal tab comes back after a
 * NEW WORKFLOW (a new / switched session) in the RUNNING Harness.
 *
 * Why this exists: the right sidebar's tab set is PER SESSION (the framework mints
 * one store per session, and a session starts collapsed with no tabs), so a new
 * session can never "keep" the terminal — the only honest behaviour is to re-open
 * it. That is a browser-side fact with no host log line, and every earlier attempt
 * to fix it was "verified" from a log that could not see the failure.
 *
 * The probe drives a real headless Edge against the running server and asserts:
 *   1. the terminal tab opens from the corner control;
 *   2. a session switch closes it (that is the framework, and it is expected);
 *   3. it is re-opened by itself, and the layout document records the intent;
 *   4. closing it by hand inside ONE session keeps it closed (no fighting the
 *      reader);
 *   5. the whole run adds only a handful of log lines, i.e. the old
 *      mutation-watcher spin (thousands of lines a minute) is gone.
 *
 * Usage: node tools/probe-terminal-restore.mjs [port]
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] && /^\d+$/u.test(process.argv[2]) ? process.argv[2] : "3080";
const debugPort = 9335;
const logFile = join(root, "state", "ui-extras-client.log");

const tokenFile = join(root, "state", "harness.url");
if (!existsSync(tokenFile)) {
  console.error("Nincs state\\harness.url — fut a harness?");
  process.exit(2);
}
const token = (readFileSync(tokenFile, "utf8").match(/token=([A-Za-z0-9_-]+)/u) ?? [])[1];
if (!token) {
  console.error("Nincs token a state\\harness.url fajlban.");
  process.exit(2);
}

const edge = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].find((p) => existsSync(p));
if (!edge) {
  console.error("Nincs Microsoft Edge.");
  process.exit(2);
}

const logLines = () => {
  try {
    return readFileSync(logFile, "utf8").split(/\r?\n/u).filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
};
const logLinesAtStart = logLines();

const profile = mkdtempSync(join(tmpdir(), "dsh-term-restore-"));
const url = `http://127.0.0.1:${port}/?token=${token}&dsh-ui-extras-debug=1`;
const browser = spawn(edge, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  // A first-run profile otherwise opens Edge's sync-confirmation page instead of
  // the Harness; the target lookup would then drive a settings dialog.
  "--disable-sync",
  "--disable-features=SyncConfirmationDialog,msEdgeSyncConfirmation",
  "--window-size=1800,1000",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  url
], { windowsHide: true, stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((entry) => entry.type === "page" &&
        typeof entry.webSocketDebuggerUrl === "string" &&
        String(entry.url || "").includes(`127.0.0.1:${port}`));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* the debugger port is not up yet */
    }
    await sleep(500);
  }
  throw new Error("a DevTools vegpont nem indult el");
}

const wsUrl = await target();
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "?").slice(0, 400));
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    const text = (message.params.args ?? []).map((a) => String(a.value ?? a.description ?? a.type)).join(" ");
    if (!text.includes("dsh-ui-extras")) return;
    consoleErrors.push(text.slice(0, 400));
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});

function send(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params: params ?? {} }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluate failed").slice(0, 400));
  }
  return result.result.value;
}

const failures = [];
const step = (text) => console.log(`  ---- ${new Date().toISOString()} ${text}`);
const check = (condition, message, detail) => {
  if (condition) console.log("  ok   " + message + (detail === undefined ? "" : ` (${detail})`));
  else {
    console.log("  FAIL " + message + (detail === undefined ? "" : ` (${detail})`));
    failures.push(message);
  }
};

/** What the page knows: current session, the sessions' working directories. */
const SESSIONS = `(() => {
  const debug = window.__dshUiExtrasDebug;
  if (!debug) return { error: "nincs debug fogantyú" };
  try {
    const snap = debug.context.sessions.list.getSnapshot();
    const rows = Object.keys(snap.byId).map((id) => ({ id, cwd: snap.byId[id].cwd || null }));
    return { current: snap.current ?? null, rows };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
})()`;

/** The terminal tab's own body: mounted exactly while the tab is open. */
const PANEL = `(() => {
  const debug = window.__dshUiExtrasDebug;
  const panel = document.querySelector('[data-dsh-ui-extras="terminals"]');
  let active = null;
  let expanded = null;
  try {
    const tab = debug.context.sidebarRight.active();
    active = tab ? { kind: tab.kind, title: tab.title ?? null } : null;
    expanded = debug.context.sidebarRight.isExpanded();
  } catch (error) { }
  return { present: panel !== null, active, expanded };
})()`;

/** The persisted intent of the current session's workspace. */
const INTENT = `(async () => {
  const debug = window.__dshUiExtrasDebug;
  try {
    const snap = debug.context.sessions.list.getSnapshot();
    const row = snap.byId[snap.current];
    const cwd = row && row.cwd ? row.cwd : null;
    if (!cwd) return { error: "nincs cwd" };
    const response = await fetch("/ui-extras/layout?workspace=" + encodeURIComponent(cwd), { headers: { Accept: "application/json" } });
    const body = await response.json();
    return { cwd, layout: body && body.layout ? body.layout : {} };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
})()`;

/** Click the corner control that opens the terminal tab. */
const OPEN_FROM_UI = `(() => {
  const buttons = Array.from(document.querySelectorAll('[data-dsh-ui-extras="corner-controls"] button'));
  const button = buttons.find((node) => /terminal/i.test(String(node.getAttribute("title") || "")) ||
    /termin/i.test(String(node.getAttribute("title") || "")));
  if (!button) return { clicked: false, titles: buttons.map((node) => node.getAttribute("title")) };
  button.click();
  return { clicked: true, title: button.getAttribute("title") };
})()`;

/** Close the terminal tab the framework way: the reader's own × on the chip. */
const CLOSE_TAB = `(() => {
  const debug = window.__dshUiExtrasDebug;
  try {
    const tab = debug.context.sidebarRight.active();
    if (!tab) return { closed: false, reason: "nincs aktiv ful" };
    debug.context.sidebarRight.close(tab.id);
    return { closed: true, kind: tab.kind };
  } catch (error) {
    return { closed: false, reason: String(error && error.message ? error.message : error) };
  }
})()`;

async function waitForPanel(deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const panel = await evaluate(PANEL);
    if (panel && panel.present) return { present: true, waitedMs: Date.now() - started, panel };
    await sleep(200);
  }
  return { present: false, waitedMs: Date.now() - started, panel: await evaluate(PANEL) };
}

async function waitForNoPanel(deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const panel = await evaluate(PANEL);
    if (panel && panel.present === false) return { absent: true, waitedMs: Date.now() - started };
    await sleep(200);
  }
  return { absent: false, waitedMs: Date.now() - started };
}

try {
  await send("Runtime.enable");
  await send("Page.enable");

  // 0. the debug handle -------------------------------------------------------
  // The shell cleans the address bar before the plugin bundle runs, so the
  // `?dsh-ui-extras-debug=1` in the launch URL usually does not survive. The
  // bundle's documented fallback is a localStorage key, which does — so the probe
  // sets it and reloads once, exactly as the harness's other probes do.
  //
  // The console hook goes in BEFORE that reload (addScriptToEvaluateOnNewDocument)
  // so the plugin's own reports and this script's steps end up on ONE timeline:
  // "something re-opened the tab" is only answerable with exact ordering.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const key = "__probeLog";
      window[key] = [];
      const original = console.error;
      console.error = function (...args) {
        try { window[key].push({ t: Date.now(), text: args.map((a) => String(a)).join(" ") }); } catch (error) { }
        return original.apply(console, args);
      };
    })();`
  });
  await sleep(1500);
  try {
    await evaluate(`window.localStorage.setItem("dsh-ui-extras.debug", "1")`);
    await send("Page.reload", { ignoreCache: true });
  } catch (error) {
    console.log("  info a debug kapcsolo beallitasa nem sikerult: " + String(error && error.message ? error.message : error));
  }

  // 1. boot ------------------------------------------------------------------
  let booted = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    await sleep(500);
    try {
      booted = await evaluate("!!window.__dshUiExtrasDebug");
    } catch {
      booted = false;
    }
    if (booted) break;
  }
  check(booted, "a lap elindult es a plugin debug fogantyuja elerheto");
  if (!booted) throw new Error("a plugin nem toltodott be");

  let sessions = await evaluate(SESSIONS);
  if (!sessions || sessions.error || !Array.isArray(sessions.rows) || sessions.rows.length === 0) {
    // The session list can arrive after the plugin; wait for it.
    for (let attempt = 0; attempt < 40 && (!sessions || !sessions.rows || sessions.rows.length === 0); attempt++) {
      await sleep(500);
      sessions = await evaluate(SESSIONS);
    }
  }
  check(sessions && !sessions.error && Array.isArray(sessions.rows) && sessions.rows.length > 0,
    "van legalabb egy Session", sessions && sessions.error ? sessions.error : `${sessions?.rows?.length ?? 0} session`);

  if (!sessions.current) {
    const first = sessions.rows[0];
    await evaluate(`window.__dshUiExtrasDebug.context.sessions.open(${JSON.stringify(first.id)})`);
    await sleep(1500);
    sessions = await evaluate(SESSIONS);
  }
  check(!!sessions.current, "van kivalasztott Session", String(sessions.current));

  const startSession = sessions.current;
  const startRow = sessions.rows.find((row) => row.id === startSession);
  const startCwd = startRow ? startRow.cwd : null;
  console.log(`  info kezdo session=${startSession} cwd=${startCwd}`);

  // 2. the reader opens the terminal from the corner control -----------------
  step("open from the corner control");
  const opened = await evaluate(OPEN_FROM_UI);
  check(opened && opened.clicked === true, "a sarok-gomb megnyitja a terminalt",
    opened && opened.clicked === true ? opened.title : JSON.stringify(opened && opened.titles));

  const first = await waitForPanel(6000);
  check(first.present, "a terminal ful megjelent", `${first.waitedMs}ms`);

  const intentAfterOpen = await evaluate(INTENT);
  check(intentAfterOpen && intentAfterOpen.layout && Number(intentAfterOpen.layout.terminalWanted || 0) === 1,
    "a szandek rogzitve a layout dokumentumban (terminalWanted=1)",
    intentAfterOpen && intentAfterOpen.layout ? `terminalWanted=${intentAfterOpen.layout.terminalWanted}` : JSON.stringify(intentAfterOpen));

  // 3. a session switch: the new session's column starts empty --------------
  const otherSameCwd = sessions.rows.find((row) => row.id !== startSession && row.cwd === startCwd);
  const other = otherSameCwd || sessions.rows.find((row) => row.id !== startSession);
  check(!!other, "van masik Session a valtaskashoz", other ? `${other.id}${other.cwd === startCwd ? " (azonos cwd)" : ""}` : "nincs");

  if (other) {
    step("switch session");
    await evaluate(`window.__dshUiExtrasDebug.context.sessions.open(${JSON.stringify(other.id)})`);
    // The framework gives the new session an empty column, so the tab goes away.
    const gone = await waitForNoPanel(4000);
    check(gone.absent, "a valtaskas utan a framework ures kolonnat ad (a ful eltunik)", `${gone.waitedMs}ms`);

    const back = await waitForPanel(8000);
    check(back.present, "a terminal ful magatol ujra megnyilt", `${back.waitedMs}ms`);

    const intentAfterSwitch = await evaluate(INTENT);
    check(intentAfterSwitch && intentAfterSwitch.layout && Number(intentAfterSwitch.layout.terminalWanted || 0) === 1,
      "a szandek valtaskas utan is megvan");
  }

  // 4. closing the tab by hand inside one session keeps it closed ------------
  //
  // The restore is given time to SETTLE first: closing the tab 200 ms after a
  // switch would race the very re-open being tested, which proves nothing about
  // the reader's own close.
  await sleep(2000);
  const settled = await evaluate(PANEL);
  check(settled && settled.present === true, "az ujranyitas utan a panel stabilan ott van");
  const beforeClose = await evaluate(SESSIONS);

  step("close the tab by hand");
  const closed = await evaluate(CLOSE_TAB);
  check(closed && closed.closed === true, "a ful bezarhato", JSON.stringify(closed));
  const closedGone = await waitForNoPanel(3000);
  check(closedGone.absent, "bezaras utan eltunik a panel", `${closedGone.waitedMs}ms`);
  await sleep(6000);
  const stillClosed = await evaluate(PANEL);
  const afterClose = await evaluate(SESSIONS);
  check(beforeClose.current === afterClose.current, "kozben nem valtottunk Sessiont",
    String(afterClose.current));
  check(stillClosed && stillClosed.present === false, "ugyanabban a sessionben NEM nyilik ujra magatol");

  step("page-side timeline (last 24 console lines)");
  try {
    const raw = await evaluate("JSON.stringify((window.__probeLog || []).slice(-24))");
    for (const entry of JSON.parse(raw)) {
      console.log(`       ${new Date(entry.t).toISOString().slice(11, 23)} ${String(entry.text).replace(/\s+/gu, " ").slice(0, 190)}`);
    }
  } catch (error) {
    console.log("       (nincs oldal-oldali naplo: " + String(error && error.message ? error.message : error) + ")");
  }

  // 5. log volume: the mutation-watcher spin must be gone --------------------
  //
  // Measured on THIS PAGE's own reports (`__probeLog`, installed before the
  // reload): the host log is shared with every open page, so a window that still
  // runs the old bundle would drown the measurement. The old loop wrote hundreds
  // of lines a minute per page; a whole run must cost a handful.
  let pageReports = -1;
  try {
    pageReports = await evaluate("(window.__probeLog || []).length");
  } catch {
    pageReports = -1;
  }
  if (pageReports < 0) console.log("  info az oldal-oldali naplo nem erheto el, a volumen nem merheto");
  else check(pageReports < 60, "a futas keves naplosort irt (nincs hurka)", `${pageReports} sor`);
  const hostAdded = logLines() - logLinesAtStart;
  console.log(`  info a host naplo valtozasa: ${hostAdded >= 0 ? "+" : ""}${hostAdded} sor (mas lapok is irnak bele)`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot && shot.data) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "state", "probe-terminal-restore.png"), Buffer.from(shot.data, "base64"));
    console.log("  info kep: state\\probe-terminal-restore.png");
  }

  if (consoleErrors.length > 0) {
    console.log("  info konzol hibak:");
    consoleErrors.slice(-24).forEach((line) => console.log("       " + line.replace(/\s+/gu, " ").slice(0, 220)));
  }

  console.log(failures.length === 0
    ? "\nMINDEN ELLENORZES RENDBEN."
    : `\n${failures.length} ELLENORZES BUKOTT: ${failures.join("; ")}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error("a proba osszeomlott:", error);
  process.exitCode = 1;
} finally {
  try { socket.close(); } catch { }
  try { browser.kill(); } catch { }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { }
}
