#!/usr/bin/env node
/**
 * Modell-leltár: a providerek ÉLŐ /models végpontjait kérdezi le a
 * ~/.dsh/.credentials.yaml kulcsaival, elmenti a nyers válaszokat a
 * state/model-catalog/ alá, és összeveti a ~/.dsh/settings.yaml-ban
 * felvett llm-pi-ai modell-listákkal.
 *
 * Csak OLVAS: a settings.yaml-hoz nem nyúl.
 *
 * Használat:
 *   node tools/model-inventory.mjs            # összegzés + eltérések
 *   node tools/model-inventory.mjs --json     # gépileg olvasható eltérés-lista
 *
 * A kulcsok soha nem kerülnek ki a kimenetre.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const CREDS = path.join(DSH_HOME, '.credentials.yaml');
const OUT_DIR = path.join(process.cwd(), 'state', 'model-catalog');
const AS_JSON = process.argv.includes('--json');

// ── credential refs ────────────────────────────────────────────────────────
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

// ── settings.yaml llm-pi-ai olvasása (provider -> modellek) ─────────────────
function readProviders(text) {
  const providers = {};
  let inPiAi = false, cur = null, inModels = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^llm-pi-ai:\s*$/.test(raw)) { inPiAi = true; continue; }
    if (inPiAi && /^\S/.test(raw)) { inPiAi = false; cur = null; }
    if (!inPiAi) continue;
    let m;
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
    if (inModels && /^\s{6}[a-zA-Z]+:/.test(raw)) continue;
    if (inModels && !/^\s{8}/.test(raw)) inModels = false;
  }
  return providers;
}

const refs = readRefs(readFileSync(CREDS, 'utf8'));
const providers = readProviders(readFileSync(SETTINGS, 'utf8'));

const CATALOG = {
  groq: { url: 'https://api.groq.com/openai/v1/models', key: 'GROQ_API_KEY', auth: 'bearer', idPath: 'id' },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', key: 'OPENROUTER_API_KEY', auth: 'bearer', idPath: 'id' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', key: 'NVIDIA_API_KEY', auth: 'bearer', idPath: 'id' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/models', key: 'GOOGLE_API_KEY', auth: 'query', idPath: 'name' },
  deepseek: { url: 'https://api.deepseek.com/models', key: 'DEEPSEEK_API_KEY', auth: 'bearer', idPath: 'id' },
  'deepseek-v1': { url: 'https://api.deepseek.com/v1/models', key: 'DEEPSEEK_API_KEY', auth: 'bearer', idPath: 'id' },
};

function liveBase(def) {
  if (!def.baseURL) return null;
  const u = def.baseURL.replace(/\/+$/, '');
  return `${u}/models`;
}

async function fetchJson(url, headers, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: `hálózat: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(OUT_DIR, { recursive: true });

const results = {};
const targets = [];
for (const [name, def] of Object.entries(providers)) {
  if (def.baseURL && /^(localhost|127\.0\.0\.1)/.test(def.baseURL)) continue; // helyi: nincs értelme
  const cat = CATALOG[name];
  const url = liveBase(def) ?? cat?.url;
  if (!url) continue;
  const auth = cat?.auth ?? 'bearer';
  const keyRef = def.apiKeyEnv ?? cat?.key;
  targets.push({ name, url, auth, keyRef, idPath: cat?.idPath ?? 'id', baseURL: def.baseURL ?? null });
}
// a DeepSeek hivatalos végpontot külön is lekérjük (a provider nem a settings.yaml-ban él)
targets.push({ name: 'deepseek-official', url: CATALOG['deepseek'].url, auth: 'bearer', keyRef: 'DEEPSEEK_API_KEY', idPath: 'id', baseURL: null });

for (const t of targets) {
  const key = refs[t.keyRef];
  let url = t.url;
  const headers = { accept: 'application/json' };
  if (t.auth === 'query') url += `?key=${encodeURIComponent(key ?? '')}`;
  else if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetchJson(url, headers);
  let ids = null, entries = null, error = null;
  if (res.status === 200) {
    try {
      const json = JSON.parse(res.text);
      const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
      entries = arr;
      ids = arr.map((e) => {
        let id = String(e[t.idPath] ?? '');
        if (t.name.startsWith('google')) id = id.replace(/^models\//, '');
        return id;
      });
    } catch (err) {
      error = `JSON: ${err.message}`;
    }
  } else {
    error = `HTTP ${res.status}: ${res.text.slice(0, 160)}`;
  }

  results[t.name] = { url, ok: !!ids, ids, error, entries };
  if (ids) {
    writeFileSync(path.join(OUT_DIR, `${t.name}-${stamp}.json`), JSON.stringify(entries, null, 2) + '\n', 'utf8');
  }
  if (!AS_JSON) {
    console.log(`── ${t.name}: ${ids ? `${ids.length} modell a végponton` : `✗ ${error}`}`);
  }
}

// ── összevetés ─────────────────────────────────────────────────────────────
const report = {};
for (const [name, def] of Object.entries(providers)) {
  const live = results[name]?.ids;
  if (!live) continue;
  const liveSet = new Set(live);
  const saved = def.models;
  const dupes = [...new Set(saved.filter((id, i) => saved.indexOf(id) !== i))];
  const missing = saved.filter((id) => !liveSet.has(id));
  const extra = live.filter((id) => !saved.includes(id));
  report[name] = { saved: saved.length, live: live.length, missing, dupes, extraCount: extra.length, extra };
  if (!AS_JSON) {
    console.log(`\n${name}: felvéve ${saved.length} / élő ${live.length}`);
    if (missing.length) console.log(`  ✗ nem elérhető (${missing.length}): ${missing.join(', ')}`);
    if (dupes.length) console.log(`  ⚠ duplikált id (${dupes.length}): ${dupes.join(', ')}`);
    console.log(`  + új upstream modell (${extra.length}), ebből free: ${extra.filter((e) => e.endsWith(':free')).length}`);
  }
}

const ds = results['deepseek-official'];
if (ds) {
  report['deepseek-official'] = { live: ds.ids, error: ds.error };
  if (!AS_JSON) {
    console.log(`\ndeepseek-official: ${ds.ids ? ds.ids.join(', ') : `✗ ${ds.error}`}`);
  }
}

if (AS_JSON) {
  writeFileSync(path.join(OUT_DIR, `report-${stamp}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
} else {
  writeFileSync(path.join(OUT_DIR, `report-${stamp}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nNyers katalógusok: ${OUT_DIR}`);
}

// OpenRouter ingyenesek + DeepSeek család kiemelése
const or = results['openrouter'];
if (or?.entries) {
  const free = or.entries.filter((e) => {
    const p = e.pricing ?? {};
    return String(p.prompt) === '0' && String(p.completion) === '0';
  });
  const ds = or.entries.filter((e) => String(e.id).startsWith('deepseek/'));
  if (!AS_JSON) {
    console.log(`\nOpenRouter ingyenes modellek (${free.length}):`);
    for (const e of free) console.log(`  ${e.id}  ctx=${e.context_length}  created=${e.created}`);
    console.log(`\nOpenRouter DeepSeek modellek (${ds.length}):`);
    for (const e of ds.sort((a, b) => b.created - a.created)) {
      console.log(`  ${e.id}  created=${new Date(e.created * 1000).toISOString().slice(0, 10)}  ctx=${e.context_length}  $${e.pricing?.prompt}/${e.pricing?.completion}`);
    }
  }
  writeFileSync(path.join(OUT_DIR, `openrouter-free-${stamp}.json`), JSON.stringify(free, null, 2) + '\n', 'utf8');
}
