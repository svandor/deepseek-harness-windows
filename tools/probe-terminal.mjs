/**
 * probe-terminal.mjs — drive the RUNNING Harness in headless Edge through the
 * DevTools protocol and verify what the terminal panel actually does.
 *
 * Why: the terminal panel resolved its working directory from the wrong source,
 * so "npm run dev" was executed in the Harness's own directory and the saved
 * commands of the project on screen were never listed. Both are browser-side
 * facts: no host log can show them.
 *
 * The probe follows the path a user takes —
 *   1. open a Session whose `cwd` is a chosen project directory,
 *   2. open the right sidebar's terminal tab,
 *   3. read the panel's own DOM —
 * and asserts that the directory the panel COMMITS to run in is that Session's
 * directory, that the project's saved commands are on screen, and that an
 * interactive terminal started by itself.
 *
 * Usage: node tools/probe-terminal.mjs [port] [projectDir]
 *        port defaults to 3080, the project to the first Session cwd found.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] && /^\d+$/u.test(process.argv[2]) ? process.argv[2] : "3080";
const wanted = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
const debugPort = 9334;

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

const profile = mkdtempSync(join(tmpdir(), "dsh-term-"));
const url = `http://127.0.0.1:${port}/?token=${token}&dsh-ui-extras-debug=1`;
const child = spawn(edge, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
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
      const page = list.find((entry) => entry.type === "page" && typeof entry.webSocketDebuggerUrl === "string");
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
const consoleLines = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Runtime.exceptionThrown") {
    consoleLines.push(`exception: ${String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "?").slice(0, 600)}`);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    const text = (message.params.args ?? []).map((a) => String(a.value ?? a.description ?? a.type)).join(" ");
    consoleLines.push(`console.error: ${text.slice(0, 600)}`);
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

/** The sessions the page knows, with their working directories. */
const SESSIONS = `(() => {
  if (!window.__dshUiExtrasDebug) return { error: "nincs debug fogantyú" };
  try {
    const snap = window.__dshUiExtrasDebug.context.sessions.list.getSnapshot();
    const rows = Object.keys(snap.byId).map((id) => ({
      id,
      cwd: snap.byId[id].cwd || null,
      title: snap.byId[id].displayTitle || null
    }));
    return { current: snap.current, rows };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
})()`;

/** The terminal panel's own DOM: the directory it commits to, its commands, its terminals. */
const PANEL = `(() => {
  const panel = document.querySelector('[data-dsh-ui-extras="cmd-panel"]');
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  return {
    panelPresent: panel !== null,
    workspaceText: (function () {
      const node = document.querySelector('[data-dsh-ui-extras="cmd-workspace"]');
      return node ? String(node.textContent || "") : null;
    })(),
    workspaceTitle: (function () {
      const node = document.querySelector('[data-dsh-ui-extras="cmd-workspace"]');
      return node ? node.getAttribute("title") : null;
    })(),
    quickCommands: all('[data-dsh-ui-extras="cmd-panel"] button')
      .map((button) => String(button.textContent || "").trim())
      .filter((text) => /^(npm|php|composer|yarn|pnpm)/u.test(text)),
    terminalCards: all('[data-dsh-ui-extras="terminal"]').length,
    terminalHeader: all('[data-dsh-ui-extras="terminal"] code').map((node) => String(node.textContent || "")),
    terminalDir: all('[data-dsh-ui-extras="terminal-dir"]').map((node) => String(node.textContent || "")),
    // The input line must be a PASSWORD field unless the reader revealed it: a
    // sudo/ssh prompt goes through this very field.
    inputTypes: all('[data-dsh-ui-extras="terminal"] input[type]').map((input) => input.getAttribute("type")),
    echoButton: (function () {
      const button = document.querySelector('[data-dsh-ui-extras="cmd-echo"]');
      return button ? { text: String(button.textContent || "").trim(), title: button.getAttribute("title") } : null;
    })(),
    // The header carries the title and the line count; the directory line must
    // stay clean (no "Fut…", no "N sor" next to the path).
    terminalHeaderText: all('[data-dsh-ui-extras="terminal"] header').map((node) => String(node.textContent || "")),
    terminalDirText: all('[data-dsh-ui-extras="terminal-dir"]').map((node) => String(node.textContent || "")),
    sendButtons: all('[data-dsh-ui-extras="terminal"] input[type=text]').map((input) => {
      const row = input.parentElement;
      if (!row) return null;
      const button = Array.from(row.querySelectorAll("button"))[0];
      return button ? { text: String(button.textContent || "").trim(), title: button.getAttribute("title") } : null;
    }),
    terminalOutput: all('[data-dsh-ui-extras="cmd-output"]').map((node) => String(node.textContent || "").slice(0, 300)),
    // The three facts the panel has to get right about its own output view: it
    // shows the END of the log, it is scrolled to the bottom, and it is set in a
    // monospace face.
    scroll: all('[data-dsh-ui-extras="cmd-output"]').map((node) => ({
      top: Math.round(node.scrollTop),
      height: Math.round(node.scrollHeight),
      client: Math.round(node.clientHeight),
      atEnd: node.scrollHeight - node.scrollTop - node.clientHeight <= 4,
      lastLine: String(node.textContent || "").split("\\n").slice(-2).join(" | ").slice(0, 120)
    })),
    font: all('[data-dsh-ui-extras="cmd-output"]').map((node) => getComputedStyle(node).fontFamily),
    followButton: all('[data-dsh-ui-extras="terminal"] button').map((b) => String(b.textContent || "").trim()).filter((text) => text === "⤓"),
    stdinInputs: all('[data-dsh-ui-extras="terminal"] input[type]').length
  };
})()`;

const failures = [];
const check = (condition, message) => {
  if (condition) console.log("  ok   " + message);
  else {
    console.log("  FAIL " + message);
    failures.push(message);
  }
};

try {
  await send("Runtime.enable");
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500);
    const ready = await evaluate("document.readyState === 'complete' && !!document.querySelector('[data-conversation-scroll], [data-slot], main')");
    if (ready) break;
  }
  await sleep(6000);

  // The debug handle is flag-gated; the shell may clean the address bar, so the
  // localStorage gate is set and the page reloaded once, exactly like the other
  // probes do.
  await evaluate("localStorage.setItem('dsh-ui-extras.debug','1')");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });

  // The shell boots asynchronously, so the debug handle is polled for instead of
  // assumed: a fixed wait made this probe fail whenever the machine was busy.
  let sessions = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(1000);
    try {
      sessions = await evaluate(SESSIONS);
    } catch (error) {
      sessions = { error: String(error?.message ?? error) };
    }
    if (sessions && !sessions.error) break;
    if (attempt === 12) {
      // One more reload: the localStorage gate is definitely set by now.
      await send("Page.reload", { ignoreCache: true });
    }
  }
  console.log("sessionok:", JSON.stringify(sessions).slice(0, 900));
  if (!sessions || sessions.error) {
    failures.push("a session-lista nem olvashato: " + String(sessions?.error));
    throw new Error(String(sessions?.error ?? "nincs session-lista"));
  }

  const chosen = wanted
    ? sessions.rows.find((row) => row.cwd && row.cwd.toLowerCase() === wanted.toLowerCase())
    : sessions.rows.find((row) => row.cwd && row.cwd !== root);
  const fallback = chosen ?? sessions.rows.find((row) => row.cwd);
  if (!fallback || !fallback.cwd) {
    failures.push("egyetlen session sem hozott cwd-t");
    throw new Error("nincs cwd-vel rendelkezo session");
  }
  console.log(`kivalasztott session: ${fallback.id}  cwd=${fallback.cwd}`);

  if (sessions.current !== fallback.id) {
    // Switch through the sessions service rather than by clicking a sidebar row:
    // a row is found by matching text, which can land on a wrapper element and
    // silently do nothing (which is exactly what made an earlier run of this probe
    // measure the wrong project). `open(id)` is the documented selection call.
    const switched = await evaluate(`(() => {
      try {
        window.__dshUiExtrasDebug.context.sessions.open(${JSON.stringify(fallback.id)});
        return "ok";
      } catch (error) {
        return "throw: " + String(error && error.message ? error.message : error);
      }
    })()`);
    console.log("session valtas:", JSON.stringify(switched));
    // The panel follows the selection on its own: give it its poll cycle.
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(1000);
      const now = await evaluate(`(() => {
        const node = document.querySelector('[data-dsh-ui-extras="cmd-workspace"]');
        return node ? node.getAttribute("title") : null;
      })()`);
      if (now === String(fallback.cwd)) break;
    }
  } else {
    console.log("mar a kivalasztott session volt az aktiv");
  }

  const opened = await evaluate(`(() => {
    const label = (node) => String(node.getAttribute("title") || "") + " | " + String(node.getAttribute("aria-label") || "");
    const candidates = Array.from(document.querySelectorAll("button")).map((node) => {
      const rect = node.getBoundingClientRect();
      return { node, text: label(node), visible: rect.width > 0 && rect.height > 0, width: Math.round(rect.width) };
    });
    const visibleButtons = candidates.filter((entry) => entry.visible);
    // The corner control's tooltip is the terminal opener ("Terminal and run
    // commands" / "Terminál és futtatható parancsok"); the tab chip has the same
    // word, so the size discriminator keeps the narrow rail button.
    const hit = visibleButtons.find((entry) => /terminal|terminál/iu.test(entry.text) &&
      /command|parancs|futtat|run/iu.test(entry.text)) ||
      visibleButtons.find((entry) => /terminal|terminál/iu.test(entry.text) && entry.width < 80);
    if (!hit) {
      return { clicked: null, visible: visibleButtons.map((entry) => entry.text).slice(0, 40) };
    }
    hit.node.click();
    return { clicked: hit.text, width: hit.width };
  })()`);
  console.log("terminal gomb:", JSON.stringify(opened).slice(0, 1200));

  // Diagnostic: does the panel REMOUNT while it is simply sitting there? A body
  // component recreated on every render (a new function identity) looks like a
  // different component type to React, so the panel would unmount and remount —
  // and a per-mount "start one shell" guard would then start one shell per pass.
  const mounts = await evaluate(`(() => {
    const panel = document.querySelector('[data-dsh-ui-extras="cmd-panel"]');
    if (!panel) return { error: "nincs panel" };
    let count = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.getAttribute && node.getAttribute("data-dsh-ui-extras") === "cmd-panel") count += 1;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return new Promise((resolve) => {
      setTimeout(() => { observer.disconnect(); resolve({ remounts: count }); }, 8000);
    });
  })()`);
  console.log("panel ujramountolasa 8 masodperc alatt:", JSON.stringify(mounts));

  // The panel mounts, resolves its workspace, lists the runnables and starts its
  // own shell; polling beats a fixed wait because a shell start is not instant.
  let panel = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(1000);
    panel = await evaluate(PANEL);
    if (panel.panelPresent && panel.terminalCards > 0) break;
  }
  console.log("panel allapot:", JSON.stringify(panel).slice(0, 1200));

  // Measured BEFORE any drag test runs, so it is the panel's own default.
  if ((panel.scroll || []).length > 0) {
    check(panel.scroll[0].client <= 320,
      `a terminál ablaka alapból nem foglalja el a panelt (${panel.scroll[0].client}px magas)`);
  }

  check(panel.panelPresent, "a terminál panel megnyílt");
  const expected = String(fallback.cwd);
  check(panel.workspaceTitle === expected,
    `a panel a session munkakönyvtárát írja ki (várt: ${expected}, kapott: ${JSON.stringify(panel.workspaceTitle)})`);
  check(panel.workspaceTitle !== root,
    `a panel NEM a harness saját könyvtárába indít (${root})`);
  check(panel.terminalCards > 0, "magától elindult egy terminál (nem üres panel)");
  if (panel.terminalDir.length > 0) {
    check(panel.terminalDir.some((text) => text.includes(expected)),
      "a terminál kártya a munkakönyvtárat a kimenet FELETT, mindig láthatóan mutatja");
    check(panel.terminalDirText.every((text) => !/(fut|kilépett|running|exited)/iu.test(text) && !/\d+\s*(sor|lines)/iu.test(text)),
      "a könyvtár sorában NINCS állapot-szöveg és sorszám (a pötty és a fejléc mutatja)");
    check(panel.terminalHeaderText.some((text) => /\d/u.test(text)),
      "a sorszám a fejlécben van");
  }
  // The send control is an icon with a tooltip, not a word.
  const sendControl = (panel.sendButtons || []).filter(Boolean)[0];
  if (sendControl) {
    check(sendControl.text.length <= 2 && typeof sendControl.title === "string" && sendControl.title.length > 10,
      `a küldés gomb ikon + tooltip (${JSON.stringify(sendControl.text)} / ${JSON.stringify(String(sendControl.title).slice(0, 40))})`);
  }
  check((panel.followButton || []).length > 0 || panel.terminalCards === 0,
    "a követés ikon a kártya fejlécében van (nincs külön sor)");
  check(panel.stdinInputs > 0 || panel.terminalCards === 0,
    "futó terminálhoz tartozik bemeneti mező");

  // The output view must show the END of the log and stay there.
  const scrolled = panel.scroll || [];
  if (scrolled.length > 0) {
    const first = scrolled[0];
    check(first.atEnd === true,
      `a kimenet a végén áll (scrollTop=${first.top}, height=${first.height}, client=${first.client})`);
    check(first.height <= first.client + 8 || first.atEnd === true,
      "hosszú kimenetnél sem a tetején marad");
  }
  if (panel.font && panel.font.length > 0) {
    check(/mono/iu.test(panel.font[0]),
      `a terminál betűtípusa monospace (${panel.font[0]})`);
  } else {
    console.log("  info nincs kimenet-elem, a betűtípus nem ellenőrizhető");
  }

  /**
   * The output window is resizable with the mouse: the bar under the output is a
   * real pointer drag, so this drives one (CDP input events, not a DOM click) and
   * checks the height followed, plus that a double click puts the default back.
   */
  const resize = await evaluate(`(async () => {
    const handle = document.querySelector('[data-dsh-ui-extras="cmd-resize"]');
    const output = handle ? handle.previousElementSibling : null;
    if (!handle || !output) return { skipped: "nincs átméretező sáv" };
    // A smaller-than-viewport window first, so a downward drag has room to grow.
    await fetch("/ui-extras/cmd?action=runs");
    const startHeight = Math.round(output.getBoundingClientRect().height);
    const box = handle.getBoundingClientRect();
    return { handleX: Math.round(box.left + box.width / 2), handleY: Math.round(box.top + box.height / 2), startHeight,
      pointerId: 1, outputFound: true };
  })()`);
  console.log("átméretezés előkészítés:", JSON.stringify(resize));
  if (!resize.skipped) {
    const heightOf = () => evaluate(`(() => {
      const handle = document.querySelector('[data-dsh-ui-extras="cmd-resize"]');
      const output = handle ? handle.previousElementSibling : null;
      return output ? Math.round(output.getBoundingClientRect().height) : null;
    })()`);
    // A double click on the bar: two press/release pairs on the pointer stream,
    // which is what the panel's own detector counts.
    const doubleClickBar = async () => {
      const box = await evaluate(`(() => {
        const handle = document.querySelector('[data-dsh-ui-extras="cmd-resize"]');
        const r = handle.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      for (const count of [1, 2]) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: count, pointerType: "mouse" });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: count, pointerType: "mouse" });
        await sleep(80);
      }
      await sleep(800);
      return heightOf();
    };

    // The stored height survives reloads, so the measurement starts from a known
    // state: reset first, then drag, then reset again. Both steps are then
    // deterministic whatever a previous run left behind.
    const defaultHeight = await doubleClickBar();
    console.log(`alapmagasság (dupla kattintás után): ${defaultHeight}px`);

    const bar = await evaluate(`(() => {
      const handle = document.querySelector('[data-dsh-ui-extras="cmd-resize"]');
      const r = handle.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    // Drag the bar DOWN by 90 px with real pointer events.
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: bar.x, y: bar.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
    for (let step = 1; step <= 6; step++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bar.x, y: bar.y + step * 15, button: "left", buttons: 1, pointerType: "mouse" });
      await sleep(80);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bar.x, y: bar.y + 90, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await sleep(700);
    const afterDrag = await heightOf();
    console.log(`magasság: drag előtt ${defaultHeight}px, utána ${afterDrag}px`);
    check(afterDrag !== null && afterDrag >= defaultHeight + 60,
      `az egérrel húzás megnövelte a terminál ablak magasságát (${defaultHeight} -> ${afterDrag}px)`);

    const afterReset = await doubleClickBar();
    console.log(`magasság dupla kattintás után: ${afterReset}px`);
    check(afterReset !== null && Math.abs(afterReset - defaultHeight) < 40,
      `a dupla kattintás visszaállítja az alapméretet (${afterDrag} -> ${afterReset}px)`);
  }

  /**
   * The output must not show escape sequences, and a carriage return must
   * REWRITE its line instead of printing it again. Both are provoked with real
   * output from the panel's own shell: a Vite-style coloured line, and a
   * progress-style line rewritten twice.
   */
  const ansi = await evaluate(`(async () => {
    const newRun = await (await fetch("/ui-extras/cmd?action=run&workspace=" + encodeURIComponent(${JSON.stringify(expected)}))).json();
    if (!newRun || newRun.ok !== true) return { skipped: "nem indult terminál" };
    const id = newRun.id;
    const send = (data) => fetch("/ui-extras/cmd?action=stdin&id=" + encodeURIComponent(id) + "&data=" + encodeURIComponent(data));
    await new Promise((r) => setTimeout(r, 1500));
    // Vite's own shape: an ESC[2m timestamp, ESC[36m tag, ESC[32m message and resets.
    await send("Write-Host ([char]27 + '[2m12:00:00' + [char]27 + '[22m ' + [char]27 + '[32mVITE' + [char]27 + '[39m ready in 228 ms')\\n");
    // A progress line rewritten in place: three writes, one carriage return
    // between them. The CR is a [char]13, because a PowerShell escape backtick
    // inside this injected script would close the template it lives in.
    await send("Write-Host -NoNewline ('step 1/3' + [char]13); Write-Host -NoNewline ('step 2/3' + [char]13); Write-Host 'step 3/3'\\n");
    await new Promise((r) => setTimeout(r, 4500));
    const card = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal"]'))
      .find((node) => String(node.textContent || "").includes("ready in 228 ms"));
    const text = card ? String(card.querySelector('[data-dsh-ui-extras="cmd-output"]').textContent || "") : null;
    const lines = text === null ? [] : text.split("\\n");
    await fetch("/ui-extras/cmd?action=forget&id=" + encodeURIComponent(id));
    return {
      found: card !== null,
      hasEsc: text === null ? null : text.indexOf(String.fromCharCode(27)) !== -1,
      hasBracketCode: text === null ? null : /\\[\\d{1,2}m/u.test(text),
      viteLine: lines.filter((line) => line.includes("ready in 228 ms")).slice(-1)[0] ?? null,
      progressLines: lines.filter((line) => line.includes("step ")),
      progressCount: lines.filter((line) => line.includes("step 1/3")).length
    };
  })()`);
  console.log("ANSI/CR vizsgálat:", JSON.stringify(ansi).slice(0, 700));
  if (ansi.skipped) {
    console.log("  info ANSI-ellenőrzés kihagyva: " + ansi.skipped);
  } else {
    check(ansi.found === true, "a színes kimenet megjelent a panelen");
    check(ansi.hasEsc === false && ansi.hasBracketCode === false,
      "a kimenetben NINCS escape-szekvencia (nincsenek négyzetek)");
    check(typeof ansi.viteLine === "string" && ansi.viteLine.includes("VITE") && ansi.viteLine.includes("ready in 228 ms"),
      `a színes sor olvasható szövegként jelenik meg (${JSON.stringify(ansi.viteLine)})`);
    check(ansi.progressCount === 0 && ansi.progressLines.length === 1 && ansi.progressLines[0].includes("step 3/3"),
      `a carriage return FELÜLÍRJA a sort, nem ismétli (${JSON.stringify(ansi.progressLines)})`);
  }

  /** The face and the size of the terminal text can be chosen with two buttons. */
  const fontBefore = await evaluate(`(() => {
    const output = document.querySelector('[data-dsh-ui-extras="cmd-output"]');
    if (!output) return null;
    const style = getComputedStyle(output);
    return { family: style.fontFamily, size: style.fontSize };
  })()`);
  const fontButtons = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal"] header button'));
    return buttons.map((b) => String(b.textContent || "").trim()).filter((text) => text === "Aa" || text === "A±");
  })()`);
  console.log("betűtípus gombok:", JSON.stringify(fontButtons), "elotte:", JSON.stringify(fontBefore));
  check((fontButtons || []).length >= 2, "van betűtípus- és betűméret-választó gomb a fejlécben");
  if ((fontButtons || []).length >= 2) {
    await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal"] header button'));
      const face = buttons.find((b) => String(b.textContent || "").trim() === "Aa");
      if (face) face.click();
      return true;
    })()`);
    await sleep(400);
    await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal"] header button'));
      const size = buttons.find((b) => String(b.textContent || "").trim() === "A±");
      if (size) size.click();
      return true;
    })()`);
    await sleep(400);
    const fontAfter = await evaluate(`(() => {
      const output = document.querySelector('[data-dsh-ui-extras="cmd-output"]');
      if (!output) return null;
      const style = getComputedStyle(output);
      const buttons = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal"] header button'));
      const size = buttons.find((b) => String(b.textContent || "").trim() === "A±");
      return { family: style.fontFamily, size: style.fontSize, tooltip: size ? size.getAttribute("title") : null };
    })()`);
    console.log("betűtípus valtas utan:", JSON.stringify(fontAfter));
    check(fontAfter !== null && fontBefore !== null && (fontAfter.family !== fontBefore.family || fontAfter.size !== fontBefore.size),
      `a választó megváltoztatta a kimenet betűtípusát/méretét (${JSON.stringify(fontBefore)} -> ${JSON.stringify(fontAfter)})`);
    check(fontAfter !== null && /mono|Consolas|Courier/iu.test(fontAfter.family),
      "a választott betűtípus is monospace marad");
    check(fontAfter !== null && typeof fontAfter.tooltip === "string" && fontAfter.tooltip.length > 5,
      `a választó tooltipje az aktuális értéket mutatja (${JSON.stringify(fontAfter && fontAfter.tooltip)})`);
    // Back to the default face, so a repeated run starts from the same place.
    await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal"] header button'));
      const face = buttons.find((b) => String(b.textContent || "").trim() === "Aa");
      const size = buttons.find((b) => String(b.textContent || "").trim() === "A±");
      for (let i = 0; i < 3; i++) { if (face) face.click(); }
      for (let i = 0; i < 8; i++) { if (size) size.click(); }
      return true;
    })()`);
    await sleep(400);
  }

  /**
   * The input line must not echo secrets, and the terminal window must not start
   * out so tall that two of them cannot be seen together.
   */
  check((panel.inputTypes || []).length === 0 || panel.inputTypes.every((type) => type === "password"),
    `a bemeneti mező alapból rejt (type=${JSON.stringify(panel.inputTypes)})`);
  check(panel.echoButton !== null && /🙈|👁/u.test(panel.echoButton.text) && String(panel.echoButton.title).length > 10,
    `van szem gomb a bemutatáshoz, tooltippel (${JSON.stringify(panel.echoButton)})`);

  /**
   * The panel shows ONE workspace: the host's run list may contain another
   * project's terminal, and it must not be drawn here (it used to be, which made
   * the other project's dev server look like it ran in this directory).
   */
  const isolation = await evaluate(`(async () => {
    const mine = ${JSON.stringify(expected.toLowerCase())};
    const runs = await (await fetch("/ui-extras/cmd?action=runs")).json();
    const foreign = (runs.runs || []).filter((run) => String(run.workspace).toLowerCase() !== mine && run.done !== true);
    const cards = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal-dir"]'))
      .map((node) => String(node.textContent || ""));
    return {
      foreignRunning: foreign.length,
      foreignWorkspaces: foreign.map((run) => run.workspace).slice(0, 3),
      cardDirs: cards,
      foreignDrawn: cards.filter((text) => text.toLowerCase().indexOf(mine) === -1).length
    };
  })()`);
  console.log("munkaterület-izoláció:", JSON.stringify(isolation));
  check(isolation.foreignDrawn === 0,
    `idegen munkaterület terminálja nincs a panelen (fut máshol: ${isolation.foreignRunning})`);

  /**
   * The interrupt path, end to end.
   *
   * The probe starts its OWN terminal for this (the panel's ✚) and tags it with a
   * marker command, then finds the card in the DOM BY THAT MARKER. An earlier
   * version picked "the first running terminal of this project", which was
   * somebody's `npm run dev` — a probe must never stop a process it did not
   * start. Ctrl+C is then pressed in that card's input line and the process must
   * be gone: either the interrupt worked, or the panel took the whole tree.
   */
  const interrupt = await evaluate(`(async () => {
    const marker = "PROBE-TERMINAL-" + Date.now();
    const newRun = await (await fetch("/ui-extras/cmd?action=run&workspace=" + encodeURIComponent(${JSON.stringify(expected)}))).json();
    if (!newRun || newRun.ok !== true) return { skipped: "nem indult terminál: " + JSON.stringify(newRun) };
    const id = newRun.id;
    const send = (data) => fetch("/ui-extras/cmd?action=stdin&id=" + encodeURIComponent(id) + "&data=" + encodeURIComponent(data));
    await new Promise((r) => setTimeout(r, 1500));
    await send("Write-Host " + marker + "\\n");
    // A command that keeps producing output, then blocks for a long time.
    await send("1..12 | ForEach-Object { Write-Host ('tick ' + $_) }\\n");
    await new Promise((r) => setTimeout(r, 4000));

    const cardOf = () => {
      const nodes = Array.from(document.querySelectorAll('[data-dsh-ui-extras="terminal"]'));
      return nodes.find((node) => String(node.textContent || "").includes(marker)) || null;
    };
    let card = cardOf();
    if (!card) return { skipped: "nem talaltam a sajat terminal kartyat a DOM-ban", id: id };
    // The field is a password input (masked by default), so it is selected by
    // its type attribute rather than by type=text.
    const input = card.querySelector('input[type]');
    if (!input) return { skipped: "nincs bemeneti mező", id: id };

    const outputOf = (node) => node ? String(node.querySelector('[data-dsh-ui-extras="cmd-output"]').textContent || "") : "";
    const before = outputOf(card).trim().split("\\n").slice(-1)[0];
    const lengthBefore = outputOf(card).length;

    // A blocking command: 600 seconds of sleep, which nothing but a real stop ends.
    await send("Start-Sleep -Seconds 600\\n");
    await new Promise((r) => setTimeout(r, 3000));

    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));

    // The panel waits 1.5 s for the interrupt and then takes the tree; give the
    // poll a few more cycles after that.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const runs = await (await fetch("/ui-extras/cmd?action=runs")).json();
      const same = (runs.runs || []).find((run) => run.id === id);
      if (same && same.done === true) break;
    }
    const runs = await (await fetch("/ui-extras/cmd?action=runs")).json();
    const same = (runs.runs || []).find((run) => run.id === id);
    card = cardOf();
    const after = outputOf(card);
    // Clean up after ourselves: the probe's own terminal is closed for good, so a
    // repeated run does not pile shells up in the project.
    await fetch("/ui-extras/cmd?action=forget&id=" + encodeURIComponent(id));
    return {
      id: id,
      done: same ? same.done : null,
      code: same ? same.code : null,
      forced: /folyamatfa|process tree/iu.test(after),
      tail: after.trim().split("\\n").slice(-1)[0],
      lastBefore: before,
      lengthBefore: lengthBefore,
      lengthAfter: after.length
    };
  })()`);
  console.log("Ctrl+C vizsgálat:", JSON.stringify(interrupt).slice(0, 900));
  if (interrupt.skipped) {
    console.log("  info Ctrl+C ellenőrzés kihagyva: " + interrupt.skipped);
  } else {
    check(interrupt.done === true,
      "a Ctrl+C után a saját teszt-terminál lezárult (a folyamat megállt)");
    check(interrupt.forced === true,
      "a panel a teljes folyamatfát leállította, és ezt ki is írja");
  }

  // The saved commands belong to the selected project: state/runnables.json is
  // keyed by workspace root, so the project on screen must bring its own row.
  const runnables = existsSync(join(root, "state", "runnables.json"))
    ? JSON.parse(readFileSync(join(root, "state", "runnables.json"), "utf8"))
    : {};
  const savedForProject = (runnables[expected] ?? []).map((entry) => entry.command);
  console.log(`mentett parancsok ehhez a projekthez (${expected}):`, JSON.stringify(savedForProject));
  if (savedForProject.length > 0) {
    for (const command of savedForProject) {
      check(panel.quickCommands.some((text) => text.includes(command) || command.includes(text)),
        `a mentett parancs latszik: ${command}`);
    }
  } else {
    console.log("  info ehhez a projekthez nincs mentett parancs a state\\runnables.json-ban");
  }

  try {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "state", "probe-terminal.png"), Buffer.from(shot.data, "base64"));
    console.log("kepernyokep: state\\probe-terminal.png");
  } catch (error) {
    console.log("kepernyokep nem sikerult:", String(error?.message ?? error));
  }

  if (consoleLines.length > 0) {
    console.log("--- konzol ---");
    for (const line of consoleLines.slice(-20)) console.log("  " + line);
  }
  console.log(failures.length === 0 ? "TERMINAL PROBA RENDBEN" : "HIBAK:\n  " + failures.join("\n  "));
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error("proba hiba:", String(error?.message ?? error));
  process.exitCode = 2;
} finally {
  try { socket.close(); } catch { /* already closed */ }
  try { child.kill(); } catch { /* already gone */ }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
