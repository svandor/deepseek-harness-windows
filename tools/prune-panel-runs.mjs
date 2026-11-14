#!/usr/bin/env node
/**
 * prune-panel-runs.mjs — a panel-layout halott terminál-csempéinek törlése.
 *
 * MIÉRT: a `state\panel-layout.json` munkaterületenként `height:run-N` és
 * `active: run-N` kulcsokat őriz, és a panel MINDEGYIKHEZ külön terminál-csempét
 * rajzol. Mivel minden harness-indítás új `run-N` azonosítókat oszt (a régi
 * rekordok pedig a `state\runs.json`-ból eltűnnek, amikor a folyamat meghal),
 * a csempék GYŰLNEK — mért eset (2026-11-14): egy munkaterületen hét
 * `height:run-*` kulcs, miközben csak egy futás élt. A felhasználó ezt úgy
 * látja, hogy „szaporodnak az üres terminálablakok".
 *
 * MIT TESZ: lekéri a futó azonosítókat a panel API-jából
 * (`/ui-extras/cmd?action=runs`), majd a layoutból törli azokat a
 * `height:run-N` / `active: run-N` kulcsokat, amelyekhez nem tartozik futás.
 * A `terminalWanted`, a `search`, a `zoom`, a `repo` és a többi kulcs
 * ÉRINTETLEN marad.
 *
 * HASZNÁLAT (a repó gyökeréből):
 *   node tools\prune-panel-runs.mjs             # száraz próba
 *   node tools\prune-panel-runs.mjs --apply     # végrehajtás mentéssel
 *   node tools\prune-panel-runs.mjs --port 3080 --state <mappa>
 *
 * Kilépés: 0 = rendben (akár volt változás, akár nem), 1 = hiba.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const portIndex = argv.indexOf("--port");
const stateIndex = argv.indexOf("--state");
const PORT = portIndex >= 0 && argv[portIndex + 1] !== undefined ? Number(argv[portIndex + 1]) : 3080;
const REPO_ROOT = resolve(import.meta.dirname, "..");
const STATE_DIR = stateIndex >= 0 && argv[stateIndex + 1] !== undefined ? resolve(argv[stateIndex + 1]) : join(REPO_ROOT, "state");
const LAYOUT_PATH = join(STATE_DIR, "panel-layout.json");

/** A futó azonosítók a panel API-jából. */
async function liveRunIds() {
  const response = await fetch(`http://127.0.0.1:${PORT}/ui-extras/cmd?action=runs`);
  if (response.ok !== true) throw new Error(`a panel API ${response.status} kóddal válaszolt`);
  const body = await response.json();
  const runs = Array.isArray(body?.runs) ? body.runs : [];
  return new Set(runs.map((run) => String(run.id)));
}

const live = await liveRunIds();
console.log(`futó azonosítók (${live.size}): ${[...live].join(", ") || "(nincs)"}`);

const layout = JSON.parse(readFileSync(LAYOUT_PATH, "utf8"));
let removed = 0;
let fixedActive = 0;
for (const [workspace, entry] of Object.entries(layout)) {
  if (entry === null || typeof entry !== "object") continue;
  for (const key of Object.keys(entry)) {
    const match = /^height:(run-\d+)$/u.exec(key);
    if (match === null) continue;
    if (live.has(match[1])) continue;
    delete entry[key];
    removed += 1;
  }
  const active = entry.active;
  if (typeof active === "string" && /^run-\d+$/u.test(active) && live.has(active) !== true) {
    delete entry.active;
    fixedActive += 1;
  }
  console.log(`  ${workspace}: ${removed} csempe-kulcs törölve eddig, active=${String(entry.active ?? "(nincs)")}`);
}

if (removed === 0 && fixedActive === 0) {
  console.log("nincs változás");
  process.exit(0);
}
if (APPLY !== true) {
  console.log(`SZÁRAZ PRÓBA: ${removed} height-kulcs és ${fixedActive} active törlődne (--apply a végrehajtáshoz)`);
  process.exit(0);
}
const backup = `${LAYOUT_PATH}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
copyFileSync(LAYOUT_PATH, backup);
writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2), "utf8");
console.log(`kiírva: ${removed} height-kulcs, ${fixedActive} active törölve (mentés: ${backup.split("\\").pop()})`);
