#!/usr/bin/env node
/**
 * MODELL-HASZNÁLHATÓSÁG: minden OpenRouter-bejegyzés megpróbálása a
 * `chat/completions` végponton (1 kimeneti token), és a BIZONYÍTOTTAN
 * használhatatlanok törlése a settings.yaml-ból.
 *
 * Mi számít használhatatlannak (csak bizonyíték alapján törlünk):
 *   - a katalógus szerint nem ad szöveget (kép/hang/videó generátor, embedding);
 *   - `:batch` utótag (mért: 404, DeepInfraBatchAdapter);
 *   - a próbahívás 400/403/404 + a válasz szövege egyértelmű indokot mond
 *     („cannot be used”, „no endpoints”, „not a valid model”, „not available”);
 * NEM törlünk 429 / 5xx / timeout esetén — az átmeneti vagy rate limit.
 *
 * Használat:
 *   node tools/model-usability-scan.mjs            # száraz próba (próbahívásokkal)
 *   node tools/model-usability-scan.mjs --apply    # törlés + mentés
 *   node tools/model-usability-scan.mjs --no-probe # csak katalógus-metadata
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/yaml');

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const probe = !argv.includes('--no-probe');
const CONCURRENCY = 6;
const TIMEOUT_MS = 25000;

const refs = {};
{
  const text = readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8');
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inside = true; continue; }
    if (inside && /^\S/.test(line)) inside = false;
    if (!inside) continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\S+)\s*$/);
    if (m) refs[m[1]] = m[2];
  }
}

const text = readFileSync(SETTINGS, 'utf8');
const doc = YAML.parse(text);
const route = doc?.['llm-pi-ai']?.providers?.openrouter;
if (!route) {
  console.error('nincs openrouter route a settings-ben');
  process.exit(1);
}
const key = refs[route.apiKeyEnv ?? ''] ?? '';
const base = String(route.baseURL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const ids = (route.models ?? []).map((m) => String(m?.id ?? '')).filter((id) => id !== '');

// ── 1. katalógus-metadata: melyik modell ad szöveget? ──────────────────────
const metaRes = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
const metaJson = await metaRes.json();
const meta = new Map((metaJson.data ?? []).map((m) => [m.id, m]));

function catalogVerdict(id) {
  if (/:batch$/.test(id)) return 'batch-only (chat-en 404)';
  const m = meta.get(id);
  if (!m) return undefined; // nem a katalógusban — a próbahívás dönt
  const outputs = m.architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.length > 0 && !outputs.includes('text')) {
    return `nem ad szöveget (output: ${outputs.join('/')})`;
  }
  const inputs = m.architecture?.input_modalities;
  if (Array.isArray(inputs) && inputs.length > 0 && !inputs.includes('text')) {
    return `nem fogad szöveget (input: ${inputs.join('/')})`;
  }
  return undefined;
}

// ── 2. próbahívás ──────────────────────────────────────────────────────────
async function probeOne(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      // 16 token: elég ahhoz, hogy a router-nehéz modellek (pl. openrouter/fusion
      // panel) ne a „max_tokens too small” miatt bukjanak el.
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
      signal: controller.signal,
    });
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 400);
    if (res.ok) return { verdict: 'ok', status: res.status };
    if (res.status === 429 || res.status >= 500) return { verdict: 'unknown', status: res.status, note: body.slice(0, 140), retryable: true };
    // A használhatatlanság JELEI a válasz szövegében (mind MÉRT eset):
    //   - „cannot be used with the chat/completions endpoint” (batch adapter)
    //   - „Invalid model: …” (a szolgáltató kivezette)
    //   - „reached the end of its life” (amazon nova premier)
    //   - „requires that either input or output is audio” (audio-modell)
    //   - „is not available in your region” (régió-tiltás)
    //   - „no endpoints found” / „not a valid model” / „no available model”
    const unusableHint = /cannot be used|no endpoints|not a valid model|invalid model|not available|does not exist|unsupported|adapter|no available model|end of its life|reached the end|requires that either|not available in your region/i.test(body);
    if (unusableHint) return { verdict: 'unusable', status: res.status, note: body.slice(0, 200) };
    return { verdict: 'unknown', status: res.status, note: body.slice(0, 180) };
  } catch (error) {
    return { verdict: 'unknown', status: 0, note: `hálózat: ${error?.message ?? error}`, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** A 429/5xx/hálózati hibát EGYSZER újrapróbálja (kötött várakozás, §1.7). */
async function probeWithRetry(id) {
  const first = await probeOne(id);
  if (first.retryable !== true) return first;
  await new Promise((resolve) => setTimeout(resolve, 20000));
  return probeOne(id);
}

const catalogUnusable = [];
const toProbe = [];
for (const id of ids) {
  const verdict = catalogVerdict(id);
  if (verdict !== undefined) catalogUnusable.push({ id, reason: verdict });
  else toProbe.push(id);
}

const probed = [];
if (probe) {
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < toProbe.length) {
      const index = cursor;
      cursor += 1;
      const id = toProbe[index];
      const result = await probeWithRetry(id);
      probed.push({ id, ...result });
      done += 1;
      if (done % 25 === 0) console.log(`  … ${done}/${toProbe.length} próbahívás kész`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toProbe.length) }, worker));
}

const unusable = [
  ...catalogUnusable,
  ...probed.filter((p) => p.verdict === 'unusable').map((p) => ({ id: p.id, reason: `${p.status}: ${p.note}` })),
];
const unknown = probed.filter((p) => p.verdict === 'unknown');
const ok = probed.filter((p) => p.verdict === 'ok');

console.log(`settings: ${SETTINGS}`);
console.log(`openrouter: ${ids.length} bejegyzés | katalógus szerint használhatatlan: ${catalogUnusable.length} | próbázott: ${toProbe.length} | OK: ${ok.length} | bizonytalan: ${unknown.length} | TÖRLENDŐ: ${unusable.length}`);
if (unknown.length > 0) {
  console.log(`  (bizonytalan — NEM törlöm: ${unknown.length})`);
  for (const u of unknown.slice(0, 10)) console.log(`    ? ${u.id} — ${u.status} ${u.note}`);
}
for (const u of unusable) console.log(`  ✗ ${u.id} — ${u.reason}`);

if (unusable.length === 0) {
  console.log('\nMinden bejegyzés használhatónak bizonyult.');
  process.exit(0);
}
if (!apply) {
  console.log('\nSzáraz próba — törlés: --apply');
  process.exit(0);
}

// ── 3. blokk-törlés a szövegből ────────────────────────────────────────────
const lines = text.split(/\r?\n/);
const indentOf = (l) => (l.match(/^(\s*)/) ?? [''])[1].length;
const drop = new Set();
const header = lines.findIndex((l) => /^ {4}openrouter:\s*$/.test(l));
let modelsLine = -1;
for (let i = header + 1; i < lines.length; i++) {
  if (/^ {6}models:\s*$/.test(lines[i])) { modelsLine = i; break; }
  if (indentOf(lines[i]) <= 4 && !/^\s*$/.test(lines[i]) && !/^\s*#/.test(lines[i])) break;
}
const entryIndent = indentOf(lines[modelsLine]) + 2;
const targets = new Set(unusable.map((u) => u.id));
let i = modelsLine + 1;
while (i < lines.length) {
  if (/^\s*$/.test(lines[i])) { i += 1; continue; }
  if (indentOf(lines[i]) <= entryIndent - 2 && !/^\s*#/.test(lines[i])) break;
  const m = lines[i].match(/^\s*-\s+id:\s*(\S+)\s*$/);
  if (!m || indentOf(lines[i]) !== entryIndent) { i += 1; continue; }
  let start = i;
  while (start - 1 > modelsLine && /^\s*#/.test(lines[start - 1]) && indentOf(lines[start - 1]) >= entryIndent) start -= 1;
  let end = i + 1;
  while (end < lines.length) {
    const next = lines[end];
    if (/^\s*$/.test(next)) break;
    if (/^\s*-\s+id:/.test(next) && indentOf(next) === entryIndent) break;
    if (indentOf(next) < entryIndent) break;
    end += 1;
  }
  if (targets.has(m[1])) for (let k = start; k < end; k++) drop.add(k);
  i = end;
}
const kept = lines.filter((_, index) => !drop.has(index));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `${SETTINGS}.bak-${stamp}-nem-hasznalhato`;
copyFileSync(SETTINGS, backup);
writeFileSync(SETTINGS, kept.join('\n'), 'utf8');
console.log(`\nALKALMAZVA: ${unusable.length} bejegyzés törölve (${lines.length} → ${kept.length} sor). Mentés: ${backup}`);
