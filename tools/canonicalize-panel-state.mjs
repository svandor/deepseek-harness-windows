#!/usr/bin/env node
/**
 * canonicalize-panel-state.mjs — a DSH panel `state\*.json` fájljainak
 * munkaterület-kulcsait a valódi (realpath) alakra hozza.
 *
 * MIÉRT: a `C:\Szerver` junction a `D:\Szerver`-re mutat, ezért ugyanaz a projekt
 * KÉT kulccsal élt egyszerre a panel állapotfájljaiban. Mért eset (2026-11-13):
 * a `state\panel-layout.json`-ban **14 kulcs** volt, miközben a mögötte lévő
 * valódi projekt **9**. A panel ezért duplán kínálta ugyanazokat a
 * munkaterületeket, és a beállítások (nyitott terminál, aktív fül, szűrő)
 * kétfelé szóródtak. A session-tároló már realpath-kulcsot használ, a panel
 * viszont a kliens által küldött literális útvonalat mentette.
 *
 * MIT KEZEL:
 *   - `state\panel-layout.json` — kulcs = munkaterület; a duplikátumok
 *     ÖSSZEVONÓDNAK (a bővebb/utóbbi bejegyzés nyer mezőnként).
 *   - `state\runnables.json` — kulcs = munkaterület; a gyorsparancs-listák
 *     egyesülnek `id` szerint, duplikátum nélkül.
 *   - `state\runs.json` — a rekordok `workspace` MEZŐJE íródik át; a rekordok
 *     nem vonódnak össze (két futás két rekord).
 *
 * A `state\` mappa a repó gyökere alatt van; ide írni a DSH sandboxából
 * engedélyezett, de a szkript a biztonság kedvéért minden érintett fájlról
 * `<fájl>.bak-<időbélyeg>` mentést készít az `--apply` előtt.
 *
 * HASZNÁLAT (a repó gyökeréből):
 *   node tools\canonicalize-panel-state.mjs            # száraz próba, csak kiírja
 *   node tools\canonicalize-panel-state.mjs --apply     # végrehajtás mentéssel
 *   node tools\canonicalize-panel-state.mjs --state <mappa>   # másik state mappa
 *
 * KILÉPÉSI KÓD: 0 = rendben (akár volt változás, akár nem), 1 = hiba.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const stateIndex = argv.indexOf("--state");
const REPO_ROOT = resolve(import.meta.dirname, "..");
const STATE_DIR = stateIndex >= 0 && argv[stateIndex + 1] !== undefined
  ? resolve(argv[stateIndex + 1])
  : join(REPO_ROOT, "state");

/** Egy útvonal valódi alakja; ha nem oldható fel, a bemenet marad. */
function canonical(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/** @param {string} name @returns {any|null} */
function readJson(name) {
  const path = join(STATE_DIR, name);
  if (existsSync(path) !== true) {
    console.log(`  ${name}: nincs ilyen fájl`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.log(`  ${name}: ÉRVÉNYTELEN JSON — ${String(error?.message ?? error)}`);
    return null;
  }
}

/** @param {string} name @param {any} data @param {boolean} mergeable */
function planWrite(name, data, mergeable) {
  const path = join(STATE_DIR, name);
  const before = readFileSync(path, "utf8");
  const after = JSON.stringify(data, null, 2);
  if (before === after) {
    console.log(`  ${name}: nincs változás`);
    return;
  }
  if (APPLY !== true) {
    console.log(`  ${name}: VÁLTOZNA (száraz próba)`);
    return;
  }
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  copyFileSync(path, backup);
  writeFileSync(path, after, "utf8");
  console.log(`  ${name}: kiírva (mentés: ${backup.split("\\").pop()})`);
  void mergeable;
}

console.log(`state mappa: ${STATE_DIR}`);
console.log(APPLY ? "MÓD: --apply (írás)" : "MÓD: száraz próba (csak kiírás)");

// ── panel-layout.json ─────────────────────────────────────────────────────
const layout = readJson("panel-layout.json");
if (layout !== null && typeof layout === "object") {
  /** @type {Record<string, any>} */
  const merged = {};
  let changed = 0;
  for (const [key, value] of Object.entries(layout)) {
    const target = canonical(key);
    if (target !== key) changed++;
    const previous = merged[target];
    merged[target] = previous === undefined ? value : { ...previous, ...value };
  }
  console.log(`panel-layout: ${Object.keys(layout).length} kulcs → ${Object.keys(merged).length}, átírt: ${changed}`);
  planWrite("panel-layout.json", merged, true);
}

// ── runnables.json ────────────────────────────────────────────────────────
const runnables = readJson("runnables.json");
if (runnables !== null && typeof runnables === "object") {
  /** @type {Record<string, any[]>} */
  const merged = {};
  let changed = 0;
  for (const [key, value] of Object.entries(runnables)) {
    const target = canonical(key);
    if (target !== key) changed++;
    const bucket = Array.isArray(merged[target]) ? merged[target] : [];
    const ids = new Set(bucket.map((entry) => entry?.id));
    for (const entry of Array.isArray(value) ? value : []) {
      if (ids.has(entry?.id) !== true) bucket.push(entry);
    }
    merged[target] = bucket;
  }
  console.log(`runnables: ${Object.keys(runnables).length} kulcs → ${Object.keys(merged).length}, átírt: ${changed}`);
  planWrite("runnables.json", merged, true);
}

// ── runs.json ─────────────────────────────────────────────────────────────
const runs = readJson("runs.json");
if (Array.isArray(runs)) {
  let changed = 0;
  for (const row of runs) {
    if (typeof row?.workspace !== "string") continue;
    const target = canonical(row.workspace);
    if (target !== row.workspace) {
      row.workspace = target;
      changed++;
    }
  }
  console.log(`runs: ${runs.length} rekord, átírt workspace: ${changed}`);
  planWrite("runs.json", runs, false);
}

process.exit(0);
