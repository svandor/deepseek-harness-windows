#!/usr/bin/env node
/**
 * Provider-ellenőrző: a ~/.dsh/settings.yaml-ban felvett llm-pi-ai providereket
 * ellenőrzi a valódi kulcsokkal, és megmondja, hogy a felvett modell-id-k
 * léteznek-e a provider /v1/models végpontján.
 *
 * Ez az a lépés, amit a GUI "Fetch available models" gombja nem mond meg:
 * hogy a MÁR elmentett modellek közül melyik él és melyik tűnt el.
 *
 * Használat:
 *   node check-providers.mjs
 *   node check-providers.mjs --verbose      # a provider teljes modell-listája
 *
 * A kulcsok soha nem kerülnek ki a kimenetre (csak maszkolva).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const VERBOSE = process.argv.includes('--verbose');
const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const CREDS = path.join(DSH_HOME, '.credentials.yaml');

// ── kulcsok kiolvasása a refs szekcióból ───────────────────────────────────
function readRefs(text) {
  const refs = {};
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) { inRefs = false; }          // új top-level kulcs
    if (!inRefs) continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\S+)\s*$/);
    if (m) refs[m[1]] = m[2];
  }
  return refs;
}

// ── a settings.yaml llm-pi-ai szekciójának minimál olvasása ────────────────
// (szándékosan nem YAML-parser: csak a provider-neveket, apiKeyEnv-et,
//  baseURL-t és a modell-id-ket kell kiolvasni)
function readProviders(text) {
  const lines = text.split(/\r?\n/);
  const providers = {};
  let inPiAi = false, cur = null, inModels = false;

  for (const raw of lines) {
    if (/^llm-pi-ai:\s*$/.test(raw)) { inPiAi = true; continue; }
    if (inPiAi && /^\S/.test(raw)) { inPiAi = false; cur = null; }
    if (!inPiAi) continue;

    let m;
    if ((m = raw.match(/^  providers:\s*$/))) continue;
    if ((m = raw.match(/^    ([a-zA-Z0-9._-]+):\s*$/))) {
      cur = { name: m[1], apiKeyEnv: null, baseURL: null, api: null, models: [] };
      providers[cur.name] = cur;
      inModels = false;
      continue;
    }
    if (!cur) continue;
    if ((m = raw.match(/^\s+apiKeyEnv:\s*(\S+)/))) { cur.apiKeyEnv = m[1]; continue; }
    if ((m = raw.match(/^\s+baseURL:\s*(\S+)/))) { cur.baseURL = m[1]; continue; }
    if ((m = raw.match(/^\s+api:\s*(\S+)/))) { cur.api = m[1]; continue; }
    if (/^\s+models:\s*$/.test(raw)) { inModels = true; continue; }
    if (inModels && (m = raw.match(/^\s+-\s+id:\s*(\S+)/))) { cur.models.push(m[1]); continue; }
    if (inModels && /^\s{6}[a-zA-Z]+:/.test(raw)) continue;       // modell mezői
    if (inModels && !/^\s{8}/.test(raw)) inModels = false;
  }
  return providers;
}

// ── a katalógusból ismert, kulcs nélkül elérhető végpontok ─────────────────
const CATALOG = {
  groq:        { list: 'https://api.groq.com/openai/v1/models',  auth: 'bearer', idPath: 'id' },
  openrouter:  { list: 'https://openrouter.ai/api/v1/models',    auth: 'bearer', idPath: 'id' },
  nvidia:      { list: 'https://integrate.api.nvidia.com/v1/models', auth: 'bearer', idPath: 'id' },
  google:      { list: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'query', idPath: 'name' },
  cerebras:    { list: 'https://api.cerebras.ai/v1/models',      auth: 'bearer', idPath: 'id' },
};

function mask(key) {
  if (!key) return '(nincs)';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} kar.)`;
}

function normalizeId(raw, providerName) {
  let id = String(raw ?? '');
  if (providerName === 'google') id = id.replace(/^models\//, '');
  return id;
}

async function probe(providerName, def, key) {
  const cat = CATALOG[providerName];
  const base = def.baseURL
    ? `${def.baseURL.replace(/\/+$/, '')}${/\/v1$/.test(def.baseURL) ? '' : ''}/models`
    : cat?.list;

  if (!base) {
    return { ok: false, reason: 'nincs ismert listázó végpont ehhez a providerhez' };
  }

  const headers = { accept: 'application/json' };
  let url = base;
  if (cat?.auth === 'query' || (!cat && providerName === 'google')) {
    url = `${base}?key=${encodeURIComponent(key ?? '')}`;
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 30000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, reason: text.slice(0, 200) };
    }
    const json = JSON.parse(text);
    const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const ids = new Set(arr.map((e) => normalizeId(e[cat?.idPath ?? 'id'], providerName)));
    return { ok: true, ids, count: arr.length };
  } catch (err) {
    return { ok: false, reason: `hálózat: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── fő ─────────────────────────────────────────────────────────────────────
let settingsText, credsText;
try { settingsText = readFileSync(SETTINGS, 'utf8'); }
catch { console.error(`Nem olvasható: ${SETTINGS}`); process.exit(2); }
try { credsText = readFileSync(CREDS, 'utf8'); }
catch { console.error(`Nem olvasható: ${CREDS}`); process.exit(2); }

const providers = readProviders(settingsText);
const refs = readRefs(credsText);
const names = Object.keys(providers);

if (names.length === 0) { console.error('Nincs llm-pi-ai provider a settings.yaml-ban.'); process.exit(2); }

console.log(`DSH_HOME: ${DSH_HOME}`);
console.log(`Providerek: ${names.join(', ')}\n`);

let problems = 0;
let checked = 0;

for (const name of names) {
  const def = providers[name];
  const key = def.apiKeyEnv ? refs[def.apiKeyEnv] : null;
  const isLocal = /^(localhost|127\.0\.0\.1)/.test(def.baseURL ?? '');

  console.log(`── ${name} ${isLocal ? '(helyi)' : ''}`);
  console.log(`   végpont : ${def.baseURL ?? '(katalógus)'}`);
  console.log(`   kulcs   : ${def.apiKeyEnv ?? '(nincs)'} = ${mask(key)}`);
  console.log(`   modellek: ${def.models.length} felvéve`);

  if (!isLocal && def.apiKeyEnv && !key) {
    console.log(`   ⚠ HIÁNYZÓ KULCS — a ${def.apiKeyEnv} nincs a credential store-ban\n`);
    problems++;
    continue;
  }

  const result = await probe(name, def, key);
  if (!result.ok) {
    console.log(`   ✗ a lista nem kérdezhető le: ${result.reason}`);
    console.log(`     (ez nem feltétlenül hiba: lehet, hogy a provider nem ad /models végpontot)`);
    console.log('');
    continue;
  }

  checked++;
  const missing = def.models.filter((id) => !result.ids.has(id));
  const alive = def.models.length - missing.length;
  console.log(`   ✓ ${result.count} modell a végponton; a felvettekből ${alive}/${def.models.length} létezik`);

  if (missing.length > 0) {
    console.log(`   ✗ NEM LÉTEZIK (${missing.length}):`);
    for (const id of missing) console.log(`       - ${id}`);
  }
  if (VERBOSE) {
    console.log(`   teljes lista: ${[...result.ids].join(', ')}`);
  }
  console.log('');
  problems += missing.length;
}

console.log('─'.repeat(60));
if (checked === 0) {
  console.log('Egyetlen provider listája sem volt lekérdezhető.');
} else if (problems === 0) {
  console.log(`Minden rendben: ${checked} provider ellenőrizve, hibás modell-id nincs.`);
} else {
  console.log(`${problems} probléma: hiányzó kulcs vagy nem létező modell-id (lásd fent).`);
}
