#!/usr/bin/env node
/**
 * check-model-pin.mjs — a rögzített alapértelmezett modell ELLENŐRZÉSE.
 *
 * MIT ELLENŐRIZ:
 *   1) a rögzítés (`plugins\dsh-model-pin\pin.json`) érvényes és mire szól,
 *   2) a `~\.dsh\settings.yaml` `agent-default-model` szekciója a rögzítés-e
 *      (ha nem: a legutóbbi modellváltás átírta — a plugin a következő
 *      eseményre visszaállítja, de a fájl most nem az igazság),
 *   3) a plugin TELEPÍTVE van-e: junction a profil `node_modules`-ában,
 *   4) a profil-patch tartalmazza-e a `model-pin` bejegyzést (és érvényes-e a
 *      YAML, ha a profilból a `js-yaml` elérhető),
 *   5) a javítás-napló utolsó bejegyzései (boot / corrected / fuse / error).
 *
 * MIÉRT: a felhasználói kérés (2026-11-23) szerint az új munkamenet
 * alapértelmezett modellje MINDIG a DeepSeek V4.1 Flash. A drift a harness
 * `selectModel()` → `saveSelection()` útján jön, ezért ezt nem elég
 * beállítani egyszer: ellenőrizhetőnek kell lennie.
 *
 * Használat: node tools/check-model-pin.mjs
 * Kilépés: 0 = minden rendben, 1 = eltérés/hiba.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMESPACE, describeSelection, isPinned, parsePinText, pinTarget, planCorrection } from '../plugins/dsh-model-pin/lib/pin.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = join(REPO, 'plugins', 'dsh-model-pin');
const PIN_FILE = join(PLUGIN_DIR, 'pin.json');
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const SETTINGS = join(DSH_HOME, 'settings.yaml');
const PROFILE_PATCH = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
const PROFILE_PACKAGE = join(DSH_HOME, 'profiles', 'web', 'package.json');
const JUNCTION = join(DSH_HOME, 'profiles', 'node_modules', 'dsh-model-pin');
const LOG = join(DSH_HOME, 'model-pin.log');

/** @type {string[]} */
const problems = [];
const fail = (message) => problems.push(message);
const ok = (message) => console.log(`  OK   ${message}`);
const bad = (message) => console.log(`  HIBA ${message}`);

/**
 * A settings.yaml `agent-default-model` szekciója (lapos kulcs-érték pár).
 *
 * Miért nem YAML parser: a `js-yaml` a DSH profiljából jön, a szekció viszont
 * lapos és egyszerű; így az ellenőrzés akkor is működik, ha a profil éppen
 * nem elérhető. A YAML érvényességét a 4) pont külön ellenőrzi.
 * @param {string} text
 * @returns {Record<string, string> | undefined}
 */
export function readSettingsSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^agent-default-model:\s*(#.*)?$/.test(line));
  if (start < 0) return undefined;
  /** @type {Record<string, string>} */
  const section = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    const match = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const raw = match[2].replace(/\s+#.*$/, '').trim();
    if (raw === '') continue;
    section[match[1]] = raw.replace(/^["'](.*)["']$/, '$1');
  }
  return section;
}

console.log('==> Rögzített alapértelmezett modell (dsh-model-pin)');

// --- 1) a rögzítés ------------------------------------------------------------
/** @type {ReturnType<typeof parsePinText> | undefined} */
let pin;
try {
  pin = parsePinText(readFileSync(PIN_FILE, 'utf8'));
  ok(`rögzítés: ${describeSelection(pinTarget(pin))}${pin.enabled ? '' : ' (KIKAPCSOLVA: enabled=false)'} — ${PIN_FILE}`);
} catch (error) {
  bad(`a pin.json nem olvasható/érvénytelen: ${String(error && error.message ? error.message : error)}`);
  fail('pin.json');
}

// --- 2) a settings.yaml szekciója ---------------------------------------------
if (pin !== undefined) {
  if (!existsSync(SETTINGS)) {
    bad(`nincs settings.yaml: ${SETTINGS}`);
    fail('settings.yaml');
  } else {
    const section = readSettingsSection(readFileSync(SETTINGS, 'utf8'));
    if (section === undefined) {
      bad(`a settings.yaml-ban nincs "${NAMESPACE}" szekció (a kompozíciós alap él: deepseek-flash)`);
    } else if (isPinned(section, pin)) {
      ok(`settings.yaml: ${describeSelection(section)} — rögzítve`);
    } else {
      const plan = planCorrection(section, pin);
      bad(`settings.yaml: ${describeSelection(section)} — ELTÉR a rögzítéstől (${describeSelection(pinTarget(pin))})`);
      console.log(`       teendő a pluginban: ${plan === undefined ? 'nincs' : plan.mode === 'update' ? 'update' : 'mutate'}`);
      if (pin.enabled) fail('settings drift');
    }
  }
}

// --- 3) telepítés: junction ---------------------------------------------------
try {
  if (!existsSync(JUNCTION)) {
    bad(`nincs junction: ${JUNCTION}`);
    fail('junction');
  } else {
    const stat = lstatSync(JUNCTION);
    const target = stat.isSymbolicLink() ? realpathSync(JUNCTION) : JUNCTION;
    const expected = realpathSync(PLUGIN_DIR);
    if (target.toLowerCase() === expected.toLowerCase()) ok(`junction: ${JUNCTION} → ${target}`);
    else {
      bad(`a junction máshova mutat: ${target} (várt: ${expected})`);
      fail('junction target');
    }
  }
} catch (error) {
  bad(`a junction nem ellenőrizhető: ${String(error)}`);
  fail('junction');
}

// --- 4) profil-patch ----------------------------------------------------------
if (!existsSync(PROFILE_PATCH)) {
  bad(`nincs profil-patch: ${PROFILE_PATCH}`);
  fail('profil-patch');
} else {
  const text = readFileSync(PROFILE_PATCH, 'utf8');
  const listed = /name:\s*dsh-model-pin/.test(text) || /dsh-model-pin/.test(text);
  if (listed) ok(`profil-patch: benne van a dsh-model-pin bejegyzés (${PROFILE_PATCH})`);
  else {
    bad(`a profil-patch NEM tartalmazza a dsh-model-pin bejegyzést: ${PROFILE_PATCH}`);
    fail('profil-patch bejegyzés');
  }
  if (existsSync(PROFILE_PACKAGE)) {
    try {
      const require = createRequire(PROFILE_PACKAGE);
      const yaml = require('js-yaml');
      yaml.load(text);
      ok('profil-patch: érvényes YAML');
    } catch (error) {
      bad(`a profil-patch YAML nem érvényes: ${String(error && error.message ? error.message : error)}`);
      fail('profil-patch YAML');
    }
  } else {
    console.log('  INFO a profil package.json nincs meg — a YAML-ellenőrzés kimaradt');
  }
}

// --- 5) a javítás-napló -------------------------------------------------------
if (existsSync(LOG)) {
  const entries = readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry !== undefined);
  const corrected = entries.filter((entry) => entry.kind === 'corrected');
  const fused = entries.filter((entry) => entry.kind === 'fuse');
  const boot = entries.filter((entry) => entry.kind === 'boot').at(-1);
  ok(`napló: ${entries.length} bejegyzés, ${corrected.length} javítás, ${fused.length} fék`);
  if (boot !== undefined) console.log(`       utolsó indulás: ${boot.at} → ${boot.pin} (${boot.pinSource})`);
  const last = corrected.at(-1);
  if (last !== undefined) console.log(`       utolsó javítás: ${last.at} ${last.from} → ${last.to} (${last.reason})`);
} else {
  console.log(`  INFO nincs még javítás-napló (${LOG}) — a plugin a következő indításnál lép életbe`);
}

console.log('');
if (problems.length === 0) {
  const target = pin === undefined ? '(ismeretlen)' : describeSelection(pinTarget(pin));
  console.log(`MINDEN RENDBEN — az alapértelmezett modell rögzítve: ${target}`);
} else {
  console.log(`ELTÉRÉS (${problems.length}): ${problems.join(', ')}`);
}
process.exit(problems.length === 0 ? 0 : 1);
