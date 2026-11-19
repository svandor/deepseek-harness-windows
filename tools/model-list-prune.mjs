#!/usr/bin/env node
/**
 * Elavult modell-bejegyzések kiszűrése a `~/.dsh/settings.yaml` llm-pi-ai
 * blokkjából: minden olyan `- id:` sor (a hozzá tartozó mezőkkel és a fölötte
 * álló kommenttel együtt) törlődik, amit az adott provider ÉLŐ `/models`
 * végpontja nem szolgál.
 *
 * MIÉRT: a GUI „Add model / Fetch” útja a BEÉPÍTETT pi-ai katalógusból dolgozik,
 * ami elavulhat (2026-11-19: 373 OpenRouter-bejegyzésből 102 nem létezett a
 * valódi OpenRouteren — claude-3-haiku, gpt-3.5-turbo, `:batch` változatok, már
 * kivezetett modellek). Az ilyen bejegyzés kiválasztható, de a kérés 404/400.
 *
 * Használat:
 *   node tools/model-list-prune.mjs            # száraz próba (kiírja, mit venne ki)
 *   node tools/model-list-prune.mjs --apply    # írás időbélyeges mentéssel
 *   node tools/model-list-prune.mjs --provider openrouter
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/yaml');

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const CREDS = path.join(DSH_HOME, '.credentials.yaml');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const only = argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : undefined;

const CATALOG = {
  groq: { list: 'https://api.groq.com/openai/v1/models', auth: 'bearer', idPath: 'id' },
  openrouter: { list: 'https://openrouter.ai/api/v1/models', auth: 'bearer', idPath: 'id' },
  nvidia: { list: 'https://integrate.api.nvidia.com/v1/models', auth: 'bearer', idPath: 'id' },
  google: { list: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'query', idPath: 'name' },
};

function readRefs(text) {
  const refs = {};
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\S+)\s*$/);
    if (m) refs[m[1]] = m[2];
  }
  return refs;
}

const refs = readRefs(readFileSync(CREDS, 'utf8'));
const text = readFileSync(SETTINGS, 'utf8');
const doc = YAML.parse(text);
const routes = doc?.['llm-pi-ai']?.providers ?? {};

function endpointFor(name, route) {
  const cat = CATALOG[name];
  if (route?.baseURL) return { url: `${String(route.baseURL).replace(/\/+$/, '')}/models`, auth: cat?.auth ?? 'bearer', idPath: cat?.idPath ?? 'id' };
  if (cat) return { url: cat.list, auth: cat.auth, idPath: cat.idPath };
  return undefined;
}

const keyFor = (route) => refs[route?.apiKeyEnv ?? ''] ?? undefined;

async function liveIds(name, route) {
  const ep = endpointFor(name, route);
  if (!ep) return { skip: 'nincs listázó végpont' };
  const headers = { accept: 'application/json' };
  let url = ep.url;
  const key = keyFor(route);
  if (ep.auth === 'query') url = `${url}?key=${encodeURIComponent(key ?? '')}`;
  else if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return { skip: `HTTP ${res.status}` };
  const json = await res.json();
  const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  const ids = new Set(arr.map((e) => {
    let id = String(e?.[ep.idPath] ?? '');
    if (name === 'google') id = id.replace(/^models\//, '');
    return id;
  }));
  return { ids };
}

/** A fájl sorai; a modell-blokkok (a fölötte álló kommenttel) eltávolíthatók. */
const lines = text.split(/\r?\n/);
const indentOf = (l) => (l.match(/^(\s*)/) ?? [''])[1].length;

function modelBlocks(providerName) {
  const header = lines.findIndex((l) => new RegExp(`^ {4}${providerName}:\\s*$`).test(l));
  if (header < 0) return [];
  let models = -1;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^ {6}models:\s*$/.test(lines[i])) { models = i; break; }
    if (indentOf(lines[i]) <= 4 && !/^\s*$/.test(lines[i]) && !/^\s*#/.test(lines[i])) break;
  }
  if (models < 0) return [];
  const entryIndent = indentOf(lines[models]) + 2;
  const blocks = [];
  let i = models + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i += 1; continue; }
    if (indentOf(line) <= entryIndent - 2 && !/^\s*#/.test(line)) break; // a lista vége
    const m = line.match(/^\s*-\s+id:\s*(\S+)\s*$/);
    if (!m || indentOf(line) !== entryIndent) { i += 1; continue; }
    // a bejegyzés fölötti kommentek (azonos vagy mélyebb behúzás)
    let start = i;
    while (start - 1 > models && /^\s*#/.test(lines[start - 1]) && indentOf(lines[start - 1]) >= entryIndent) start -= 1;
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (/^\s*$/.test(next)) break;
      if (/^\s*-\s+id:/.test(next) && indentOf(next) === entryIndent) break;
      if (indentOf(next) < entryIndent) break;
      end += 1;
    }
    blocks.push({ id: m[1], start, end });
    i = end;
  }
  return blocks;
}

const removals = [];
const summary = [];
for (const [name, route] of Object.entries(routes)) {
  if (only !== undefined && name !== only) continue;
  if (!Array.isArray(route?.models) || route.models.length === 0) {
    summary.push({ name, skipped: 'nincs models lista' });
    continue;
  }
  const live = await liveIds(name, route);
  if (live.skip !== undefined) {
    summary.push({ name, skipped: live.skip });
    continue;
  }
  // Két kizárási ok:
  //  1) az id-t az élő /models NEM szolgálja (elavult bejegyzés);
  //  2) az id `:batch` végű — él, de a chat/completions végponton NEM
  //     használható. MÉRVE (2026-11-19): `moonshotai/kimi-k3:batch` →
  //     404 „cannot be used with the chat/completions endpoint (adapter
  //     DeepInfraBatchAdapter)” — a felületen kiválasztva tehát mindig hibázna.
  const ids = route.models.map((m) => String(m?.id ?? '')).filter((id) => id !== '');
  const missing = ids.filter((id) => !live.ids.has(id));
  const batchOnly = ids.filter((id) => live.ids.has(id) && /:batch$/.test(id));
  const dead = [...missing, ...batchOnly];
  summary.push({ name, listed: route.models.length, live: live.ids.size, dead: dead.length, missing: missing.length, batchOnly: batchOnly.length });
  if (dead.length === 0) continue;
  const deadSet = new Set(dead);
  for (const block of modelBlocks(name)) {
    if (deadSet.has(block.id)) removals.push({ provider: name, ...block });
  }
}

console.log(`settings: ${SETTINGS}`);
for (const s of summary) {
  if (s.skipped) console.log(`${s.name.padEnd(16)} kihagyva: ${s.skipped}`);
  else console.log(`${s.name.padEnd(16)} ${String(s.listed).padStart(4)} bejegyzés | élő katalógus ${String(s.live).padStart(4)} | TÖRLENDŐ: ${s.dead} (hiányzó ${s.missing}, csak-batch ${s.batchOnly})`);
}
if (removals.length === 0) {
  console.log('\nNincs eltávolítandó bejegyzés — minden id létezik az élő végponton.');
  process.exit(0);
}
console.log(`\n${removals.length} bejegyzés törlődik (a fölötte álló kommenttel együtt). Példák:`);
for (const r of removals.slice(0, 15)) console.log(`  - ${r.provider}/${r.id}`);

if (!apply) {
  console.log('\nSzáraz próba — írás: --apply');
  process.exit(0);
}

// hátulról törlünk, hogy a sorindexek ne csússzanak el
const drop = new Set();
for (const r of removals) for (let i = r.start; i < r.end; i++) drop.add(i);
const kept = lines.filter((_, index) => !drop.has(index));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `${SETTINGS}.bak-${stamp}-elavult-modell`;
copyFileSync(SETTINGS, backup);
writeFileSync(SETTINGS, kept.join('\n'), 'utf8');
console.log(`\nALKALMAZVA: ${removals.length} bejegyzés törölve (${lines.length} → ${kept.length} sor).`);
console.log(`Mentés: ${backup}`);
