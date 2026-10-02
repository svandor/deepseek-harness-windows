/**
 * browser-probe.mjs — load the running Harness in headless Edge and report what
 * the page says: console messages, uncaught errors, and whether the plugin's
 * language pack registered.
 *
 * Why: the host cannot see the browser. A broken client bundle shows up as a
 * blank page or a frozen interface with nothing in the server log, so the only
 * way to verify a client change without a human is to drive a real browser.
 * The page is opened with `?dsh-ui-extras-probe=1`, which makes the plugin POST
 * its language-pack report to /ui-extras/i18n — so a successful run also proves
 * the client half boots.
 *
 * Usage: node tools/browser-probe.mjs [port] [--json]
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] && /^\d+$/u.test(process.argv[2]) ? process.argv[2] : "3080";
const asJson = process.argv.includes("--json");

/** Read the token the running server was started with. */
function readToken() {
  const file = join(root, "state", "harness.url");
  if (!existsSync(file)) return null;
  const match = readFileSync(file, "utf8").match(/token=([A-Za-z0-9_-]+)/u);
  return match ? match[1] : null;
}

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error("Nem talalom a Microsoft Edge-et; add meg kezzel a futtathato fajlt.");
  process.exit(2);
}

const token = readToken();
if (!token) {
  console.error("Nincs token a state\\harness.url fajlban — fut a harness?");
  process.exit(2);
}

// A fresh profile each run: a cached service worker or an old localStorage must
// not mask the current bundle.
const profileDir = mkdtempSync(join(tmpdir(), "dsh-probe-"));
const url = `http://127.0.0.1:${port}/?token=${token}&dsh-ui-extras-probe=1`;

const child = spawn(edge, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=" + profileDir,
  "--virtual-time-budget=15000",
  "--enable-logging=stderr",
  "--v=0",
  url
], { windowsHide: true });

let output = "";
child.stdout.on("data", (c) => { output += c; });
child.stderr.on("data", (c) => { output += c; });

const killer = setTimeout(() => {
  try { child.kill(); } catch { /* already gone */ }
}, 90000);

child.on("close", () => {
  clearTimeout(killer);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }

  const lines = output.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter((l) =>
    /dsh-ui-extras|Uncaught|SyntaxError|TypeError|ReferenceError|Failed to load|ERROR:/iu.test(l)
  );
  const errors = interesting.filter((l) => /Uncaught|SyntaxError|TypeError|ReferenceError|Failed to load/iu.test(l));
  const pack = interesting.filter((l) => /language pack/iu.test(l));

  if (asJson) {
    console.log(JSON.stringify({ url, errors, pack, interesting }, null, 2));
  } else {
    console.log(`Megnyitva: ${url}`);
    console.log(`Konzol sorok: ${lines.length}, erdekes: ${interesting.length}`);
    if (pack.length) {
      for (const line of pack) console.log("  CSOMAG  " + line);
    } else {
      console.log("  CSOMAG  nincs nyoma a nyelvi csomag jelentesnek a konzolon");
    }
    if (errors.length) {
      console.log("HIBAK:");
      for (const line of errors) console.log("  " + line);
    } else {
      console.log("Nincs uncaught hiba a konzolon.");
    }
    if (process.env.DSH_PROBE_VERBOSE === "1") {
      console.log("--- teljes konzol ---");
      for (const line of lines) console.log(line);
    }
  }
  process.exit(errors.length ? 1 : 0);
});
