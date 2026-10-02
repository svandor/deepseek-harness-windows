#!/usr/bin/env node
/**
 * chain-doctor — a fallback-lanc napi behangolasa.
 *
 * A retune.mjs csak azt nezi, hogy a beallitott modell-id-k LETEZNEK-e. Ez a
 * scripts azt nezi, amit az igazi behangolashoz kell: MELYIK CEL VALASZOL
 * TENYLEGESEN. Minden celra kuld egy tool-hivast igenylo probat, es javasolja
 * a lanc ujrasorolasat.
 *
 * Mit tesz:
 *   1. Beolvassa a providers/config.json route-jait.
 *   2. Minden celra probat kuld (rovid, tool-hivast igenylo keres).
 *   3. Eredmeny: OK / LASSÚ / HALOTT (timeout, 429, 404, 5xx).
 *   4. Javaslat: a halottakat a lanc vegere, a mukodo sorrend valtozatlan.
 *   5. --apply: atirja a config.json-t (mentessel), csak a targets sorrendet.
 *   6. Riportot ir a providers/reports/ mappaba.
 *
 * Hasznalat:
 *   node chain-doctor.mjs                 # csak riport
 *   node chain-doctor.mjs --apply         # atirja a lancokat
 *   node chain-doctor.mjs --verbose
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'config.json');
const REPORT_DIR = path.join(HERE, 'reports');
const CREDS = path.join(homedir(), '.dsh', '.credentials.yaml');

const PROBE_TIMEOUT_MS = Number(process.env.CHAIN_PROBE_TIMEOUT_MS ?? 20000);
// A helyi Ollama cold startja 15-70 s (mert ertek), ezert kulon, hosszabb
// idokorlat kell neki — kulonben minden helyi cel "halottnak" tunik.
const LOCAL_PROBE_TIMEOUT_MS = Number(process.env.CHAIN_LOCAL_TIMEOUT_MS ?? 120000);
const SLOW_MS = Number(process.env.CHAIN_SLOW_MS ?? 5000);

function isLocal(baseURL) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(String(baseURL ?? ''));
}

// ── segédek ────────────────────────────────────────────────────────────────
function log(...a) { process.stdout.write(a.join(' ') + '\n'); }
function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readRefs() {
  if (!existsSync(CREDS)) return {};
  const refs = {};
  let inRefs = false;
  for (const line of readFileSync(CREDS, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\S+)\s*$/);
    if (m) refs[m[1]] = m[2];
  }
  return refs;
}

/** Csak az ELSO perjelen hasitunk: a modell-id tartalmazhat perjelet. */
function splitTarget(entry, providerHint) {
  if (entry && typeof entry === 'object') {
    if (providerHint) return [providerHint, entry.model];
    const i = String(entry.model ?? '').indexOf('/');
    return i === -1 ? [String(entry.model), undefined] : [entry.model.slice(0, i), entry.model.slice(i + 1)];
  }
  const i = String(entry).indexOf('/');
  return i === -1 ? [String(entry), undefined] : [String(entry).slice(0, i), String(entry).slice(i + 1)];
}

function completionsUrl(baseURL) {
  const base = String(baseURL).replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/chat/completions`;
}

// ── a celok osszegyujtese a config-bol ─────────────────────────────────────
if (!existsSync(CONFIG_PATH)) { log(`Nem találom: ${CONFIG_PATH}`); process.exit(2); }
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const REFS = readRefs();

const providers = {};
for (const [id, def] of Object.entries(CONFIG.providers ?? {})) {
  const apiKey = (def.apiKeyEnv && REFS[def.apiKeyEnv]) || def.apiKey;
  providers[id] = { id, baseURL: def.baseURL, apiKey, optionalKey: def.optionalKey === true, headers: def.headers };
}

// A celok unioја: minden route-bol, ismetlodes nelkul.
const allTargets = new Map();
for (const [routeName, route] of Object.entries(CONFIG.routes ?? {})) {
  const targets = Array.isArray(route) ? route : route?.targets ?? [];
  for (const t of targets) {
    const [pid, model] = splitTarget(t);
    const key = `${pid}/${model}`;
    if (!allTargets.has(key)) allTargets.set(key, { key, pid, model, routes: [] });
    allTargets.get(key).routes.push(routeName);
  }
}

log(`chain-doctor — ${new Date().toISOString()}${APPLY ? '  (APPLY)' : '  (csak riport)'}`);
log(`célok: ${allTargets.size}, route-ok: ${Object.keys(CONFIG.routes ?? {}).length}`);
log('');

// ── proba ──────────────────────────────────────────────────────────────────
async function probe(target) {
  const p = providers[target.pid];
  if (!p) return { verdict: 'HALOTT', ms: 0, note: `ismeretlen provider: ${target.pid}` };
  if (!p.apiKey && !p.optionalKey) return { verdict: 'HALOTT', ms: 0, note: `nincs kulcs (${p.apiKeyEnv ?? '?'})` };

  const timeoutMs = isLocal(p.baseURL) ? LOCAL_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const t0 = Date.now();
  try {
    const headers = { 'content-type': 'application/json', ...(p.headers ?? {}) };
    if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
    const res = await fetch(completionsUrl(p.baseURL), {
      method: 'POST',
      headers,
      signal: ac.signal,
      body: JSON.stringify({
        model: target.model,
        max_tokens: 400,
        messages: [{ role: 'user', content: 'What is the weather in Budapest? Use the get_weather tool.' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        }],
      }),
    });
    const ms = Date.now() - t0;
    const txt = await res.text();
    if (!res.ok) {
      const short = (() => { try { return JSON.parse(txt).error?.message ?? txt; } catch { return txt; } })().replace(/\s+/g, ' ').slice(0, 90);
      return { verdict: 'HALOTT', ms, note: `HTTP ${res.status}: ${short}` };
    }
    let toolOk = false;
    let content = '';
    try {
      const j = JSON.parse(txt);
      const m = j.choices?.[0]?.message;
      toolOk = (m?.tool_calls?.length ?? 0) > 0;
      content = String(m?.content ?? '').replace(/\s+/g, ' ').slice(0, 50);
    } catch { }
    const verdict = ms > SLOW_MS ? 'LASSU' : 'OK';
    const note = toolOk ? 'tool-hivas OK' : `nincs tool-hivas (content="${content}")`;
    return { verdict, ms, note: `${ms} ms, ${note}` };
  } catch (err) {
    return { verdict: 'HALOTT', ms: Date.now() - t0, note: err?.message === 'timeout' ? `timeout (${timeoutMs} ms)` : `halozat: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
}

const results = new Map();
for (const target of allTargets.values()) {
  const r = await probe(target);
  results.set(target.key, r);
  const mark = r.verdict === 'OK' ? 'OK   ' : r.verdict === 'LASSU' ? 'LASSU' : 'HALOTT';
  log(`  ${mark} ${target.key.padEnd(52)} ${r.note}`);
}

// ── javaslat: a halottakat a lanc vegere ───────────────────────────────────
const RANK = { OK: 0, LASSU: 1, HALOTT: 2 };
const proposed = {};
let changes = 0;

for (const [routeName, route] of Object.entries(CONFIG.routes ?? {})) {
  const targets = Array.isArray(route) ? route : route?.targets ?? [];
  const keyed = targets.map((t, idx) => {
    const [pid, model] = splitTarget(t);
    const r = results.get(`${pid}/${model}`) ?? { verdict: 'HALOTT', ms: 0, note: 'nem probalt' };
    return { t, idx, rank: RANK[r.verdict] ?? 2, ms: r.ms };
  });
  // Stabil rendezes: eloszor a rank, azon belul a rovid valaszido, vegul az eredeti sorrend.
  const sorted = [...keyed].sort((a, b) => a.rank - b.rank || a.ms - b.ms || a.idx - b.idx);
  const changedOrder = sorted.some((x, i) => x.idx !== keyed[i].idx);
  if (changedOrder) {
    changes++;
    log('');
    log(`JAVASLAT ${routeName}:`);
    log(`  most:   ${targets.map((t) => (typeof t === 'string' ? t : t.model)).join(' -> ')}`);
    log(`  javasolt: ${sorted.map((x) => (typeof x.t === 'string' ? x.t : x.t.model)).join(' -> ')}`);
    const dead = sorted.filter((x) => x.rank === 2);
    if (dead.length) log(`  HALOTT a lancban: ${dead.map((x) => (typeof x.t === 'string' ? x.t : x.t.model)).join(', ')}`);
  }
  proposed[routeName] = sorted.map((x) => x.t);
}

// ── riport ─────────────────────────────────────────────────────────────────
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const rfile = path.join(REPORT_DIR, `chain-doctor-${stamp()}.md`);
const md = [];
md.push(`# Lánc-behangolás — ${new Date().toISOString()}`);
md.push('');
md.push(`- Mód: **${APPLY ? 'apply' : 'csak riport'}**`);
md.push(`- Próba: tool-hívást igénylő kérés, időkorlát ${PROBE_TIMEOUT_MS} ms (helyi Ollama: ${LOCAL_PROBE_TIMEOUT_MS} ms), lassú > ${SLOW_MS} ms`);
md.push('');
md.push('| Cél | Eredmény | Részlet | Hol szerepel |');
md.push('|---|---|---|---|');
for (const target of allTargets.values()) {
  const r = results.get(target.key);
  md.push(`| \`${target.key}\` | ${r.verdict} | ${r.note.replace(/\|/g, '\\|')} | ${target.routes.join(', ')} |`);
}
md.push('');
if (changes === 0) {
  md.push('Nincs javasolt sorrend-változás: minden cél a helyén van, vagy mind egyformán jó.');
} else {
  md.push('## Javasolt sorrend-változások');
  md.push('');
  for (const [routeName, targets] of Object.entries(proposed)) {
    const orig = (Array.isArray(CONFIG.routes[routeName]) ? CONFIG.routes[routeName] : CONFIG.routes[routeName]?.targets) ?? [];
    const a = orig.map((t) => (typeof t === 'string' ? t : t.model)).join(' -> ');
    const b = targets.map((t) => (typeof t === 'string' ? t : t.model)).join(' -> ');
    if (a !== b) { md.push(`### ${routeName}`); md.push(''); md.push(`- most: \`${a}\``); md.push(`- javasolt: \`${b}\``); md.push(''); }
  }
}
writeFileSync(rfile, md.join('\n'), 'utf8');

// ── apply ──────────────────────────────────────────────────────────────────
if (APPLY && changes > 0) {
  const backup = `${CONFIG_PATH}.bak-${stamp()}`;
  copyFileSync(CONFIG_PATH, backup);
  const next = { ...CONFIG, routes: {} };
  for (const [routeName, route] of Object.entries(CONFIG.routes ?? {})) {
    next.routes[routeName] = Array.isArray(route) ? proposed[routeName] : { ...route, targets: proposed[routeName] };
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  log('');
  log(`Mentés: ${backup}`);
  log(`Alkalmazva: ${changes} route újrasorolva.`);
  // MEGMÉRT HIBA (2026-10-01): itt korábban az állt, hogy nem kell újraindítani.
  // Ez HAMIS: a proxy.mjs a config.json-t a betöltéskor olvassa be EGYSZER
  // (`const CONFIG = JSON.parse(readFileSync(...))` a modul tetején), és a
  // kérések ezt a memóriabeli példányt használják. A futó proxy ezért a RÉGI
  // sorrendet szolgálta ki két napon át, miközben a config.json már mást
  // tartalmazott — a helyi, tool-hívást nem adó coderrel a lánc élén.
  log('FIGYELEM: a proxy a config.json-t INDULASKOR olvassa be egyszer,');
  log('ezért a futó példány a RÉGI sorrendet szolgálja ki, amíg újra nem indítod:');
  log('  .\\run-proxy-service.ps1 -Stop   majd   .\\run-proxy-service.ps1');
  log('(a watchdog 60 s-en belül magától is újraindítja, ha a /healthz nem válaszol)');
} else if (APPLY) {
  log('');
  log('Nincs változás, a config.json érintetlen.');
}

const deadCount = [...results.values()].filter((r) => r.verdict === 'HALOTT').length;
log('');
log('='.repeat(70));
log(`${results.size} cél: ${[...results.values()].filter((r) => r.verdict === 'OK').length} OK, ${[...results.values()].filter((r) => r.verdict === 'LASSU').length} lassú, ${deadCount} halott`);
log(`Riport: ${rfile}`);
if (deadCount > 0) process.exitCode = 1;
