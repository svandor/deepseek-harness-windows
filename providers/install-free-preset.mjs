#!/usr/bin/env node
/**
 * install-free-preset.mjs — a `standard-free` agent-preset telepítése.
 *
 * MIÉRT KELL:
 *
 *   A web profilban a `tool-subagent` sor a **presetből** jön: a
 *   `@deepseek-ai/dsh-web-app` a host-plane sorát letiltja
 *   (`- id: tool-subagent / disabled: true`), és a standard preset adja az
 *   agentnek a delegáló eszközt. A preset sora viszont **nem** tartalmaz
 *   `agentOptions`-t, ezért a gyermek a szülő route-ját örökli — a GUI-ból
 *   indított delegálás így mindig a fizetős `deepseek-official/deepseek-flash`
 *   úton fut. A `~/.dsh/profiles/web/cordis.patch.yml`-ban lévő
 *   `tool-subagent` felülírás egy LETILTOTT sorra mutat, ezért hatástalan
 *   (mért bizonyíték: egy GUI-ból indított gyermek 2026-09-30-án
 *   `deepseek-flash`-en futott).
 *
 * MIT TESZ EZ A SZKRIPT:
 *
 *   1) A telepített DSH-ból kimásolja a `standard` presetet a felhasználói
 *      preset-gyökérbe (`<DSH_HOME>/.agent-presets/standard-free`), a
 *      `tool-subagent` sor configjába pedig beírja az `agentOptions` blokkot:
 *      a gyermek a `subagent-worker/worker` (ingyenes fallback lánc) route-on
 *      indul, a fő szál a fizetős route-on marad.
 *   2) `--default` esetén a `settings.yaml`-ba beírja
 *      `agent-presets: default: standard-free`-et (mentéssel).
 *
 *   A másolat új id-t kap, mert a beépített (shipped) gyökér nyeri a duplikált
 *   id-t — a `standard`-t nem lehet felülírni, csak másolni.
 *
 * Használat:
 *   node providers/install-free-preset.mjs                  # riport (nem ír)
 *   node providers/install-free-preset.mjs --apply          # preset telepítése
 *   node providers/install-free-preset.mjs --apply --default  # + alapértelmezett
 *   node providers/install-free-preset.mjs --apply --force  # meglévő másolat cseréje
 *
 * Kilépési kód: 0 = rendben, 1 = hiba.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const APPLY = has('--apply');
const FORCE = has('--force');
const SET_DEFAULT = has('--default') || has('--set-default');
const ID = valueOf('--id', 'standard-free');
const SOURCE_ID = valueOf('--source', 'standard');
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const USER_ROOT = join(DSH_HOME, '.agent-presets');
const TARGET = join(USER_ROOT, ID);
const SETTINGS_FILE = join(DSH_HOME, 'settings.yaml');

if (!/^[a-z0-9][a-z0-9-]*$/.test(ID)) {
  console.error(`Ervenytelen preset id: '${ID}' (csak [a-z0-9-], betuvel vagy szammal kezdodve)`);
  process.exit(1);
}

/**
 * A telepített preset-gyökerek, legfrissebb npx-telepítés előre.
 *
 * Szándékosan `child_process` NÉLKÜL: a DSH sandboxában egy gyermekfolyamat
 * kimenetének elkapcsolása névvel ellátott csövön át nem megy (EPERM), ezért az
 * `npm root -g` / `npm config get cache` nem hívható. A jól ismert Windows-os
 * helyeket nézzük meg közvetlenül; kézzel a `--presets-root` adható meg.
 */
function presetRoots() {
  const roots = [];
  const explicit = valueOf('--presets-root', process.env.DSH_PRESETS_ROOT ?? '');
  if (explicit) roots.push(explicit);
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const appData = process.env.APPDATA ?? '';
  if (appData) roots.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'));
  if (localAppData) {
    const npx = join(localAppData, 'npm-cache', '_npx');
    try {
      const dirs = readdirSync(npx, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ path: join(npx, entry.name), at: statSync(join(npx, entry.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      for (const dir of dirs) roots.push(join(dir.path, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'));
    } catch { /* nincs npx cache ezen a helyen */ }
  }
  return roots;
}

const sourceDir = presetRoots()
  .map((root) => join(root, SOURCE_ID))
  .find((dir) => existsSync(join(dir, 'agent.cordis.yml')));
if (sourceDir === undefined) {
  console.error(`Nem talalom a(z) '${SOURCE_ID}' presetet a telepített DSH-ban.`);
  process.exit(1);
}

/**
 * Az `agentOptions` beszúrása a `tool-subagent` sor configjába.
 *
 * Szöveges, de SZIGORÚAN blokkra szűkített beszúrás: a horgony a sor saját
 * blokkjában van (`backgroundMode: continuable`), és a beszúrás előtt
 * ellenőrizzük, hogy a blokk valóban a `subagent` toolt nevezi meg. Ha bármely
 * feltétel nem teljesül, hibát dob — nem ír félkonfigurált presetet.
 */
function patchComposition(text) {
  const lines = text.split('\n');
  const idIndex = lines.findIndex((line) => /^\s*- id: tool-subagent\s*$/.test(line));
  if (idIndex === -1) throw new Error('nincs `- id: tool-subagent` sor a forras-presetben');
  const indent = lines[idIndex].match(/^\s*/)[0];
  let end = lines.length;
  for (let i = idIndex + 1; i < lines.length; i += 1) {
    if (/^\s*- /.test(lines[i]) && lines[i].match(/^\s*/)[0].length <= indent.length) { end = i; break; }
  }
  const block = lines.slice(idIndex, end);
  if (!block.some((line) => /^\s*toolName: subagent\s*$/.test(line))) {
    throw new Error('a tool-subagent blokk nem a subagent toolt nevezi meg');
  }
  if (block.some((line) => /^\s*agentOptions:\s*$/.test(line))) return { text, changed: false };
  const anchor = block.findIndex((line) => /^\s*backgroundMode: continuable\s*$/.test(line));
  if (anchor === -1) throw new Error('nincs `backgroundMode: continuable` horgony a tool-subagent blokkban');
  const inserted = [
    '        # A gyermek alapértelmezett route-ja: az INGYENES fallback lánc',
    '        # (helyi proxy -> NVIDIA / Groq / OpenRouter / Ollama). Enélkül a',
    '        # gyermek a szülő route-ját örökli, azaz fizetős deepseek-flash-en fut.',
    '        # Ha a proxy áll, a gyermek hívása elhal (nem esik vissza fizetősre).',
    '        agentOptions:',
    '          provider: subagent-worker',
    '          model: worker',
    '          maxTokens: 32768'
  ];
  lines.splice(idIndex + anchor + 1, 0, ...inserted);
  return { text: lines.join('\n'), changed: true };
}

/** A telepített preset fájljainak ellenőrzése (a másolás után). */
function verifyComposition(text) {
  const lines = text.split('\n');
  const idIndex = lines.findIndex((line) => /^\s*- id: tool-subagent\s*$/.test(line));
  const optionLines = lines.filter((line) => /^\s*agentOptions:\s*$/.test(line));
  const provider = lines.some((line) => /^\s*provider: subagent-worker\s*$/.test(line));
  const model = lines.some((line) => /^\s*model: worker\s*$/.test(line));
  return {
    ok: idIndex !== -1 && optionLines.length === 1 && provider && model,
    detail: `tool-subagent sor: ${idIndex !== -1 ? 'megvan' : 'HIANYZIK'}, agentOptions: ${optionLines.length} db, subagent-worker: ${provider}, worker: ${model}`
  };
}

const sourceComposition = readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8');
const patched = patchComposition(sourceComposition);
const verification = verifyComposition(patched.text);

console.log('');
console.log(`Ingyenes delegálású preset: ${ID}`);
console.log('=======================================');
console.log(`Forras:  ${sourceDir}`);
console.log(`Cel:     ${TARGET}`);
console.log(`Modositas: ${patched.changed ? 'agentOptions beszurva' : 'mar tartalmazza (nem irjuk ujra)'}`);
console.log(`Ellenorzes: ${verification.ok ? 'OK' : 'HIBA'} — ${verification.detail}`);
if (!verification.ok) {
  console.error('A patchelt kompozicio nem megy át az ellenőrzésen, nem írok semmit.');
  process.exit(1);
}

// `--verbose`: a beszúrt blokk kiírása, hogy a változás szemmel is ellenőrizhető
// legyen (a preset-fájl kommentjei miatt a diff amúgy is nagy zajos lenne).
if (has('--verbose')) {
  const lines = patched.text.split('\n');
  const at = lines.findIndex((line) => /^\s*- id: tool-subagent\s*$/.test(line));
  console.log('');
  console.log('--- a tool-subagent blokk a patchelt kompozicioban ---');
  for (const line of lines.slice(at, at + 16)) console.log(line);
  console.log('-----------------------------------------------------');
}

/** A forrás-preset teljes másolása (a kompozíciót a patchelt szöveg adja). */
function copyPreset() {
  mkdirSync(TARGET, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = join(sourceDir, entry.name);
    const to = join(TARGET, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const inner of readdirSync(from, { withFileTypes: true })) {
        if (inner.isFile()) copyFileSync(join(from, inner.name), join(to, inner.name));
      }
      continue;
    }
    if (entry.name === 'agent.cordis.yml') continue;
    copyFileSync(from, to);
  }
  writeFileSync(join(TARGET, 'agent.cordis.yml'), patched.text, 'utf8');
  writeFileSync(join(TARGET, 'preset.yml'), [
    'name: Standard (ingyenes delegálás)',
    'description: A standard preset másolata; a gyermekek a subagent-worker (ingyenes fallback lánc) route-on indulnak, a fő szál a fizetős route-on marad.',
    ''
  ].join('\n'), 'utf8');
}

/** Az `agent-presets.default` beírása a settings.yaml-ba (mentéssel). */
function setSettingsDefault() {
  const text = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : '';
  const backup = `${SETTINGS_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const block = /^agent-presets:\s*$/m;
  let next;
  if (block.test(text)) {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => /^agent-presets:\s*$/.test(line));
    let replaced = false;
    for (let i = at + 1; i < lines.length; i += 1) {
      if (/^\S/.test(lines[i])) break;
      if (/^\s+default:/.test(lines[i])) { lines[i] = `  default: ${ID}`; replaced = true; break; }
    }
    if (!replaced) lines.splice(at + 1, 0, `  default: ${ID}`);
    next = lines.join('\n');
  } else {
    next = `${text.trimEnd()}\n\n# Az uj beszelgetesek presetenek alapértelmezettje: a gyermekek\n# az ingyenes fallback lancon indulnak (standard masolat).\nagent-presets:\n  default: ${ID}\n`;
  }
  writeFileSync(backup, text, 'utf8');
  writeFileSync(SETTINGS_FILE, next, 'utf8');
  return backup;
}

if (!existsSync(TARGET) || FORCE) {
  if (!APPLY) {
    console.log('');
    console.log('Csak riport — semmi nem változott. Telepítés: --apply  (+ --default)');
    if (existsSync(TARGET) && !FORCE) console.log('FIGYELEM: a celpreset mar letezik; csere csak --force-szal.');
    process.exit(0);
  }
  copyPreset();
  console.log(`Preset kiirva: ${TARGET}`);
} else {
  console.log('');
  console.log(`A celpreset mar letezik (${TARGET}) — nem irom felul (--force a csere).`);
  if (!APPLY) {
    console.log('Csak riport — semmi nem változott.');
    process.exit(0);
  }
}

const installed = readFileSync(join(TARGET, 'agent.cordis.yml'), 'utf8');
const installedCheck = verifyComposition(installed);
if (!installedCheck.ok) {
  console.error(`A telepített kompozicio ellenőrzése megbukott: ${installedCheck.detail}`);
  process.exit(1);
}
console.log(`Telepített kompozicio ellenőrizve: ${installedCheck.detail}`);

if (SET_DEFAULT) {
  const backup = setSettingsDefault();
  console.log(`Alapértelmezett preset beirva: agent-presets.default = ${ID}`);
  console.log(`Mentes a beiras elott: ${backup}`);
} else {
  console.log('');
  console.log('Az alapértelmezethez add meg a --default kapcsolot, vagy a felületen:');
  console.log('  Settings -> Agent presets -> a preset kártyáján „make default".');
}

console.log('');
console.log('Ellenőrzés (új beszélgetésben): a gyermek session naplójában a modell');
console.log('  worker / subagent-worker  -> ingyenes lánc;');
console.log('  deepseek-flash            -> még mindig a szülő route-ja.');
