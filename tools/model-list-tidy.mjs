#!/usr/bin/env node
/**
 * Modell-lista rendező: a ~/.dsh/settings.yaml `llm-pi-ai` blokkjának
 * modell-listáit igazítja az ÉLŐ provider-katalógusokhoz.
 *
 * Mit tesz:
 *  1) OPENROUTER: a teljes lista újragenerálása az élő
 *     https://openrouter.ai/api/v1/models katalógusból. Csak az INGYENES
 *     (pricing.prompt === "0" ÉS pricing.completion === "0") chat-modellek
 *     kerülnek be — a lista és a delegálási lánc (providers/config.json)
 *     szándékosan ingyenes; a fizetős modellek nincsenek a listán.
 *     A kép/hang generáló lyria-* kimarad (nem chat-modell). Ezzel a
 *     korábbi duplikátumok (cohere/north-mini-code:free ×3 rossz névvel,
 *     :free nélküli Inkling) és az eltűnt id-k is eltűnnek.
 *  2) Minden NEM HELYI provider: az élő /models listán már nem szereplő
 *     id-k törlése (= nem elérhető modell), az azonos id-jű duplikátumok
 *     összevonása, és a kézzel ismert névhibák javítása.
 *  3) Helyi (127.0.0.1) providerek: csak akkor nyúl hozzá, ha a proxy
 *     válaszol; ilyenkor a route-neveket ellenőrzi.
 *
 * Használat:
 *   node tools/model-list-tidy.mjs              # csak tervezet (dry-run)
 *   node tools/model-list-tidy.mjs --apply      # írás a settings.yaml-ba
 *
 * A dry-run a state/model-catalog/settings.proposed.yaml fájlba írja az
 * eredményt, és kiírja az eltéréseket. Az --apply előbb időbélyeges
 * biztonsági másolatot készít (~/.dsh/settings.yaml.bak-<ts>-modell-lista).
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const CREDS = path.join(DSH_HOME, '.credentials.yaml');
const OUT_DIR = path.join(process.cwd(), 'state', 'model-catalog');
const APPLY = process.argv.includes('--apply');

// ── kulcsok ────────────────────────────────────────────────────────────────
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

// ── élő katalógusok ────────────────────────────────────────────────────────
const CATALOG = {
  groq: { url: 'https://api.groq.com/openai/v1/models', key: 'GROQ_API_KEY', idPath: 'id' },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', key: 'OPENROUTER_API_KEY', idPath: 'id' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', key: 'NVIDIA_API_KEY', idPath: 'id' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/models', key: 'GOOGLE_API_KEY', idPath: 'name', google: true },
  alibaba: { url: null, key: 'ALIBABA_API_KEY', idPath: 'id' }, // baseURL a settings.yaml-ból
};

async function getJson(url, key, { google = false, timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const headers = { accept: 'application/json' };
  let target = url;
  if (google) target += `?key=${encodeURIComponent(key ?? '')}`;
  else if (key) headers.authorization = `Bearer ${key}`;
  try {
    const res = await fetch(target, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    const json = JSON.parse(text);
    const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return { ok: true, entries: arr };
  } catch (err) {
    return { ok: false, error: `hálózat: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── settings.yaml sor-szintű feldolgozása ──────────────────────────────────
const lines = readFileSync(SETTINGS, 'utf8').split(/\r?\n/);

const indentOf = (l) => (l.match(/^(\s*)/) ?? [''])[1].length;
const isComment = (l) => /^\s*#/.test(l);
const isBlank = (l) => /^\s*$/.test(l);
const isKey = (l) => /^\s*[A-Za-z0-9_.-]+\s*:(\s|$)/.test(l) && !isComment(l);

function findPiAiRange() {
  const start = lines.findIndex((l) => /^llm-pi-ai:\s*$/.test(l));
  if (start < 0) throw new Error('nincs llm-pi-ai blokk a settings.yaml-ban');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!isBlank(lines[i]) && indentOf(lines[i]) === 0 && !isComment(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function providerBlocks(start, end) {
  const out = [];
  let cur = null;
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^ {4}([A-Za-z0-9._-]+):\s*$/);
    if (m) { cur = { name: m[1], header: i, bodyStart: i + 1, bodyEnd: end, modelsLine: -1, entries: [] }; out.push(cur); continue; }
    if (cur && cur.modelsLine < 0 && /^ {6}models:\s*$/.test(lines[i])) cur.modelsLine = i;
  }
  for (let k = 0; k < out.length; k++) {
    const blocks = out;
    if (k + 1 < blocks.length) blocks[k].bodyEnd = blocks[k + 1].header;
  }
  for (const p of out) {
    if (p.modelsLine < 0) continue;
    let curEntry = null;
    for (let i = p.modelsLine + 1; i < p.bodyEnd; i++) {
      const m = lines[i].match(/^ {8}- id:\s*(\S+)\s*$/);
      if (m) {
        if (curEntry) curEntry.end = i;
        curEntry = { id: m[1], start: i, end: p.bodyEnd, lines: [] };
        p.entries.push(curEntry);
        continue;
      }
      const ind = indentOf(lines[i]);
      if (curEntry && !isBlank(lines[i]) && !isComment(lines[i]) && ind <= 6 && isKey(lines[i])) {
        curEntry.end = i;
        curEntry = null;
        break; // a lista véget ért
      }
    }
    for (let e = 0; e < p.entries.length; e++) {
      p.entries[e].end = e + 1 < p.entries.length ? p.entries[e + 1].start : (p.entries[e].end === p.bodyEnd ? p.bodyEnd : p.entries[e].end);
    }
  }
  return out;
}

function readProviderField(p, field) {
  for (let i = p.header + 1; i < p.bodyEnd; i++) {
    const m = lines[i].match(new RegExp(`^\\s{6}${field}:\\s*(\\S+)`));
    if (m) return m[1];
  }
  return null;
}

const { start, end } = findPiAiRange();
const providers = providerBlocks(start, end);

// ── élő listák lekérése ────────────────────────────────────────────────────
const live = {};
for (const p of providers) {
  const baseURL = readProviderField(p, 'baseURL');
  const apiKeyEnv = readProviderField(p, 'apiKeyEnv');
  const keyRef = apiKeyEnv ?? CATALOG[p.name]?.key;
  const key = keyRef ? refs[keyRef] : undefined;
  const isLocal = baseURL ? /^(localhost|127\.0\.0\.1)/.test(baseURL) : false;

  let url = null, google = false;
  if (isLocal) url = baseURL.replace(/\/+$/, '') + '/models';
  else if (baseURL) url = baseURL.replace(/\/+$/, '') + '/models';
  else if (CATALOG[p.name]) { url = CATALOG[p.name].url; google = CATALOG[p.name].google === true; }

  if (!url) { live[p.name] = { ok: false, error: 'nincs listázó végpont' }; continue; }

  const res = await getJson(url, key, { google });
  if (!res.ok) { live[p.name] = res; continue; }
  const ids = res.entries.map((e) => {
    let id = String(e[CATALOG[p.name]?.idPath ?? 'id'] ?? '');
    if (google) id = id.replace(/^models\//, '');
    return id;
  });
  live[p.name] = { ok: true, ids, entries: res.entries };
  if (p.name === 'openrouter') writeFileSync(path.join(OUT_DIR, `openrouter-live-${Date.now()}.json`), JSON.stringify(res.entries, null, 2) + '\n', 'utf8');
}

mkdirSync(OUT_DIR, { recursive: true });

// ── OpenRouter: teljes újragenerálás (ingyenes chat-modellek) ──────────────
const OR_ROUTER = 'openrouter/free';
function openrouterBlock() {
  const or = live.openrouter;
  if (!or?.ok) throw new Error(`az OpenRouter katalógus nem kérdezhető le: ${or?.error}`);
  const free = or.entries
    .filter((e) => {
      const pr = e.pricing ?? {};
      return String(pr.prompt) === '0' && String(pr.completion) === '0';
    })
    // kép/hang generáló modellek kivéve (nem chat)
    .filter((e) => !/^google\/lyria-/.test(e.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const rows = [];
  for (const e of free) {
    if (e.id === OR_ROUTER) continue;
    const ctx = Number(e.context_length) || 131072;
    const maxOut = Number(e.top_provider?.max_completion_tokens) || 32768;
    const mods = e.architecture?.input_modalities ?? [];
    const input = ['text'];
    if (mods.includes('image')) input.push('image');
    const name = String(e.name ?? e.id).replace(/\s+/g, ' ').trim();
    rows.push(
      `        - id: ${e.id}\n` +
      `          name: ${JSON.stringify(name)}\n` +
      `          contextWindow: ${ctx}\n` +
      `          maxTokens: ${Math.min(maxOut, ctx)}\n` +
      (input.length > 1 ? `          input: [ ${input.join(', ')} ]\n` : ''),
    );
  }
  const routerRow =
    `        # Ingyenes modellek routere (a szolgáltató választ helyettünk).\n` +
    `        - id: ${OR_ROUTER}\n` +
    `          name: "Free Models Router"\n` +
    `          contextWindow: 200000\n` +
    `          maxTokens: 4096\n`;

  const total = or.ids.length;
  const freeAll = or.entries.filter((e) => String(e.pricing?.prompt) === '0' && String(e.pricing?.completion) === '0').length;
  const paid = total - freeAll;
  const header =
    `    # 2026-11-19: ÉLŐ katalógusból újragenerálva (GET https://openrouter.ai/api/v1/models,\n` +
    `    # ${total} modell a végponton). Ebből ${freeAll} ingyenes (pricing.prompt=0 ÉS\n` +
    `    # pricing.completion=0), és ${free.length} chat-modell került a listára: a\n` +
    `    # delegálási lánc (providers/config.json) ingyenes célokat használ, ezért a ${paid}\n` +
    `    # FIZETŐS modell szándékosan NINCS a listán. A 2 lyria-* kép/hang generáló (nem\n` +
    `    # chat), ezért kimaradt. A korábbi duplikátumok (cohere/north-mini-code:free ×3\n` +
    `    # rossz névvel, :free nélküli thinkingmachines/inkling-small) törölve; a név, a\n` +
    `    # kontextus és a kimeneti keret a katalógusból jön.\n`;
  return `${header}    openrouter:\n      displayName: OpenRouter\n      apiKeyEnv: OPENROUTER_API_KEY\n      models:\n${rows.join('')}${routerRow}`;
}

// ── törlendő / átnevezendő tételek (nem elérhető, duplikált, téves név) ────
const DROP = new Set([
  // NVIDIA: a végponton már nem szolgált (2026-11-19)
  'nvidia:meta/llama-3.2-90b-vision-instruct',
]);
// duplikált id: a MÁSODIK (rossz nevű) előfordulást dobjuk
const DROP_DUPLICATE = new Set([
  'nvidia:nvidia/nemotron-3-ultra-550b-a55b#1', // első: "Llama 3.1 Nemotron Ultra 253B" (rossz név)
  'nvidia:nvidia/riva-translate-4b-instruct-v2#1',
  'nvidia:nvidia/riva-translate-4b-instruct-v2#2',
]);
const RENAME = new Map([
  ['nvidia:nvidia/riva-translate-4b-instruct-v2', 'NVIDIA Riva Translate 4B Instruct v2'],
  ['nvidia:nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra 550B A55B'],
  ['nvidia:minimaxai/minimax-m3.1-flash', 'MiniMax M3.1 Flash'],
]);

// ── új fájl összeállítása ─────────────────────────────────────────────────
const dropsByProvider = new Map(); // provider -> Set(lineIndex)
const removed = [];                // [provider, id]
const renamed = [];                // [provider, id, old, new]
const duplicateSee = new Map();    // provider|id -> count
for (const p of providers) {
  for (const e of p.entries) {
    const key = `${p.name}|${e.id}`;
    duplicateSee.set(key, (duplicateSee.get(key) ?? 0) + 1);
  }
}
for (const p of providers) {
  const seen = new Set();
  for (const e of p.entries) {
    const tag = `${p.name}:${e.id}`;
    const occurrence = (() => {
      let n = 0;
      for (const q of p.entries) { if (q.id === e.id) n++; if (q === e) break; }
      return n;
    })();
    const dupKey = `${tag}#${occurrence}`;
    if (DROP.has(tag) || DROP_DUPLICATE.has(dupKey)) {
      const set = dropsByProvider.get(p.name) ?? new Set();
      for (let i = e.start; i < e.end; i++) set.add(i);
      dropsByProvider.set(p.name, set);
      removed.push([p.name, e.id]);
      continue;
    }
    if (seen.has(e.id)) {
      const set = dropsByProvider.get(p.name) ?? new Set();
      for (let i = e.start; i < e.end; i++) set.add(i);
      dropsByProvider.set(p.name, set);
      removed.push([p.name, e.id + ' (duplikátum)']);
      continue;
    }
    seen.add(e.id);
    const newName = RENAME.get(tag);
    if (newName) {
      for (let i = e.start; i < e.end; i++) {
        const m = lines[i].match(/^(\s{10}name:\s*)(.*)$/);
        if (m) {
          renamed.push([p.name, e.id, m[2].trim(), JSON.stringify(newName)]);
          lines[i] = `${m[1]}${JSON.stringify(newName)}`;
          break;
        }
      }
    }
  }
}

// nem elérhető id-k törlése (az OpenRouter kivétel: ott teljes regenerálás)
const dead = new Map(); // provider -> Set(id)
for (const p of providers) {
  if (p.name === 'openrouter') continue;
  const l = live[p.name];
  if (!l?.ok) continue;
  const liveSet = new Set(l.ids);
  for (const e of p.entries) {
    if (liveSet.has(e.id)) continue;
    const set = dropsByProvider.get(p.name) ?? new Set();
    for (let i = e.start; i < e.end; i++) set.add(i);
    dropsByProvider.set(p.name, set);
    removed.push([p.name, e.id + ' (nem elérhető)']);
    if (!dead.has(p.name)) dead.set(p.name, new Set());
    dead.get(p.name).add(e.id);
  }
}

// sorok törlése
const keep = [];
for (let i = 0; i < lines.length; i++) {
  let drop = false;
  for (const set of dropsByProvider.values()) if (set.has(i)) { drop = true; break; }
  if (!drop) keep.push(lines[i]);
}

// ── hiányzó proxy route felvétele (dangling allowedModels hivatkozás) ──────
let addedVisionWorker = false;
const proxyLive = live['subagent-worker'];
if (proxyLive?.ok && proxyLive.ids.includes('vision-worker')) {
  const swStart = keep.findIndex((l) => /^ {4}subagent-worker:\s*$/.test(l));
  if (swStart >= 0) {
    let swEnd = keep.length;
    for (let i = swStart + 1; i < keep.length; i++) {
      if (indentOf(keep[i]) === 4 && !isBlank(keep[i]) && !isComment(keep[i]) && isKey(keep[i])) { swEnd = i; break; }
      if (!isBlank(keep[i]) && indentOf(keep[i]) === 0 && !isComment(keep[i])) { swEnd = i; break; }
    }
    const hasVision = keep.slice(swStart, swEnd).some((l) => /^ {8}- id:\s*vision-worker\s*$/.test(l));
    if (!hasVision) {
      let lastEntry = -1;
      for (let i = swStart; i < swEnd; i++) if (/^ {8}- id:/.test(keep[i])) lastEntry = i;
      let insertAt = lastEntry + 1;
      while (insertAt < swEnd && indentOf(keep[insertAt]) >= 10) insertAt++;
      const ins = [
        '        # 2026-11-19: a `vision-worker` route a proxyban LÉTEZIK (GET',
        '        # http://127.0.0.1:4123/v1/models), és a subagent-model-selection',
        '        # allowedModels erre a providerre hivatkozik — a lista korábban',
        '        # hiányolta, ezért a kép-delegálás metaadat nélkül ment volna.',
        '        - id: vision-worker',
        '          name: Vision worker (kep-delegalas, proxy)',
        '          contextWindow: 1000000',
        '          maxTokens: 32768',
        '          input: [ text, image ]',
      ];
      keep.splice(insertAt, 0, ...ins);
      addedVisionWorker = true;
    }
  }
}

// OpenRouter blokk cseréje
const orStart = keep.findIndex((l) => /^ {4}openrouter:\s*$/.test(l));
if (orStart < 0) throw new Error('az openrouter provider blokk nem található');
let orEnd = keep.length;
for (let i = orStart + 1; i < keep.length; i++) {
  if (indentOf(keep[i]) === 4 && !isBlank(keep[i]) && !isComment(keep[i]) && isKey(keep[i])) { orEnd = i; break; }
  if (!isBlank(keep[i]) && indentOf(keep[i]) === 0 && !isComment(keep[i])) { orEnd = i; break; }
}
const newBlock = openrouterBlock().replace(/\n$/, '').split('\n');
// a blokk fölé szakadt, elavult "eltávolítva — FIZETŐS" megjegyzés kivétele
let orHead = orStart;
while (orHead > 0 && /^ {4}#\s*2026-11-03: eltavolitva/.test(keep[orHead - 1])) orHead--;
const out = [...keep.slice(0, orHead), ...newBlock, ...keep.slice(orEnd)];

const text = out.join('\n');

// ── riport ────────────────────────────────────────────────────────────────
const removedSorted = removed.filter(([p]) => p !== 'openrouter');
writeFileSync(path.join(OUT_DIR, 'settings.proposed.yaml'), text, 'utf8');

const byProvider = new Map();
for (const [p, id] of removedSorted) {
  if (!byProvider.has(p)) byProvider.set(p, []);
  byProvider.get(p).push(id);
}
console.log(`OpenRouter: ${live.openrouter?.ids?.length ?? '?'} élő modell, ebből ingyenes chat: ${openrouterBlock().split('\n').filter((l) => /^ {8}- id:/.test(l)).length}`);
console.log(`Eltávolítva / nem elérhető (OpenRouter nélkül): ${removedSorted.length}`);
for (const [p, ids] of byProvider) console.log(`  ${p}: ${ids.length} → ${ids.join(', ')}`);
const orBefore = providers.find((p) => p.name === 'openrouter')?.entries.map((e) => e.id) ?? [];
const orAfter = newBlock.filter((l) => /^ {8}- id:/.test(l)).map((l) => l.match(/- id:\s*(\S+)/)[1]);
console.log(`OpenRouter: előtte ${orBefore.length} bejegyzés, utána ${orAfter.length}`);
console.log(`  kivett: ${orBefore.filter((i) => !orAfter.includes(i)).join(', ') || '-'}`);
console.log(`  új:     ${orAfter.filter((i) => !orBefore.includes(i)).join(', ') || '-'}`);
if (renamed.length) console.log(`Átnevezve: ${renamed.map(([p, id]) => `${p}/${id}`).join(', ')}`);
if (addedVisionWorker) console.log('Felvéve: subagent-worker/vision-worker (a proxy route-ja; a dangling allowedModels hivatkozás javítása)');
console.log(`Tervezet: ${path.join(OUT_DIR, 'settings.proposed.yaml')}`);

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${SETTINGS}.bak-${stamp}-modell-lista`;
  copyFileSync(SETTINGS, backup);
  writeFileSync(SETTINGS, text, 'utf8');
  console.log(`\nALKALMAZVA. Biztonsági másolat: ${backup}`);
} else {
  console.log('\nSzimuláció kész (nem írtam a settings.yaml-ba). Alkalmazás: --apply');
}
