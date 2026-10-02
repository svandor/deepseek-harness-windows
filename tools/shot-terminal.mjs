/**
 * shot-terminal.mjs — open the terminal panel in the running Harness and save a
 * screenshot of it, so the card's layout can be inspected visually.
 * Usage: node tools/shot-terminal.mjs [port] [projectDir] [outfile]
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] ?? "3080";
const wantedDir = process.argv[3] ?? "C:\\Herd\\termeszetgyogyaszoktatas-L12";
const out = process.argv[4] ?? join(root, "state", "shot-terminal.png");
const debugPort = 9340;

const token = (readFileSync(join(root, "state", "harness.url"), "utf8").match(/token=([A-Za-z0-9_-]+)/u) ?? [])[1];
const edge = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
const profile = mkdtempSync(join(tmpdir(), "dsh-shot-"));
const child = spawn(edge, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--window-size=1900,1000", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  `http://127.0.0.1:${port}/?token=${token}&dsh-ui-extras-debug=1`
], { windowsHide: true, stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    wsUrl = list.find((e) => e.type === "page")?.webSocketDebuggerUrl ?? null;
  } catch { }
}
const socket = new WebSocket(wsUrl);
await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
let id = 0;
const pending = new Map();
socket.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
const send = (method, params) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); socket.send(JSON.stringify({ id: i, method, params: params ?? {} })); });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
};

try {
  await send("Runtime.enable");
  await send("Page.enable");
  // The debug handle is gated on localStorage and published during boot; the page
  // is reloaded once the gate is set and then polled until the handle exists.
  await evaluate("localStorage.setItem('dsh-ui-extras.debug','1')");
  let ready = false;
  for (let i = 0; i < 6 && !ready; i++) {
    await send("Page.reload", { ignoreCache: true });
    for (let attempt = 0; attempt < 25 && !ready; attempt++) {
      await sleep(1000);
      try {
        ready = await evaluate("typeof window.__dshUiExtrasDebug !== 'undefined' && !!window.__dshUiExtrasDebug");
      } catch {
        ready = false;
      }
    }
    console.log(`  boot proba ${i + 1}: debug handle=${ready}`);
  }
  if (!ready) {
    const diag = await evaluate(`({
      readyState: document.readyState,
      href: location.href.slice(0, 80),
      title: document.title,
      bodyLength: document.body ? document.body.innerHTML.length : -1,
      slotNodes: document.querySelectorAll('[data-slot]').length,
      plugins: Array.from(document.querySelectorAll('script[src]')).map((s) => s.src).filter((s) => /plugins|assets/u.test(s)).length,
      bootError: document.body ? String(document.body.textContent || '').slice(0, 200) : null
    })`).catch((error) => ({ evaluateError: String(error?.message ?? error) }));
    console.log("diagnosztika:", JSON.stringify(diag));
    throw new Error("a debug fogantyú nem jött létre (a lap nem bootolt)");
  }

  const session = await evaluate(`(() => {
    const snap = window.__dshUiExtrasDebug.context.sessions.list.getSnapshot();
    const row = Object.keys(snap.byId).map((id) => snap.byId[id]).find((r) => String(r.cwd).toLowerCase() === ${JSON.stringify(wantedDir.toLowerCase())});
    if (!row) return null;
    window.__dshUiExtrasDebug.context.sessions.open(row.id);
    return row.id;
  })()`);
  console.log("session:", session);
  await sleep(4000);

  // Open the terminal tab through the panel's own corner control, retrying until
  // the panel body is really in the DOM: one click can land while the sidebar's
  // seat is still mounting, which silently does nothing.
  let attempts = 0;
  let panelPresent = false;
  while (attempts < 6 && !panelPresent) {
    attempts += 1;
    await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const hit = buttons.find((b) => /terminal|terminál/iu.test(String(b.getAttribute("title") || "") + String(b.getAttribute("aria-label") || "")) && b.getBoundingClientRect().width < 80);
      if (hit) { hit.click(); return "clicked"; }
      return "not found";
    })()`);
    await sleep(3000);
    panelPresent = await evaluate("!!document.querySelector('[data-dsh-ui-extras=\"cmd-panel\"]')");
    console.log(`  proba ${attempts}: panel=${panelPresent}`);
  }
  // The tab can exist while the column is collapsed to its rail, in which case
  // nothing of the panel is on screen: expand it (that is what the framework's own
  // expand control does) before the screenshot.
  const expanded = await evaluate(`(() => {
    const s = window.__dshUiExtrasDebug.context.sidebarRight;
    try {
      if (s && typeof s.isExpanded === "function" && s.isExpanded() === false && typeof s.toggleExpanded === "function") {
        s.toggleExpanded();
        return "expanded";
      }
      return s && typeof s.isExpanded === "function" ? String(s.isExpanded()) : "no service";
    } catch (error) { return "throw: " + String(error && error.message ? error.message : error); }
  })()`);
  console.log("rightbar:", expanded);
  await sleep(3000);

  // Give the panel time to resolve, list and start its shell, then run something
  // chatty so the output view has real content to show.
  await sleep(6000);
  await evaluate(`(async () => {
    const runs = await (await fetch("/ui-extras/cmd?action=runs")).json();
    const mine = (runs.runs || []).filter((r) => String(r.workspace).toLowerCase() === ${JSON.stringify(wantedDir.toLowerCase())});
    if (mine.length === 0) return "no run";
    await fetch("/ui-extras/cmd?action=stdin&id=" + encodeURIComponent(mine[0].id) + "&data=" + encodeURIComponent("1..40 | ForEach-Object { Write-Host ('sor ' + $_) }\\n"));
    return "sent";
  })()`);
  await sleep(4000);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("screenshot:", out);
} catch (error) {
  console.error("shot failed:", String(error?.message ?? error));
  process.exitCode = 1;
} finally {
  try { socket.close(); } catch { }
  try { child.kill(); } catch { }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { }
}
