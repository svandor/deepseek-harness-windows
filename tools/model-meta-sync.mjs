#!/usr/bin/env node
/**
 * A `~/.dsh/settings.yaml` llm-pi-ai modell-bejegyzéseinek METAADAT-szinkronja
 * az élő katalógus ellen: ha a bejegyzés `contextWindow`/`maxTokens` értéke
 * NAGYOBB, mint amit a végpont ténylegesen enged, a kérés 400-at kap
 * („max_tokens too large”, „context length exceeded”). Ilyenkor a bejegyzést a
 * mért plafonra szorítjuk (soha nem emeljük, mert a kisebb érték biztonságos).
 *
 * MIÉRT: a GUI „Add model” útja a BEÉPÍTETT pi-ai katalógusból dolgozik, ami
 * elavult lehet — 2026-11-19-én 28 OpenRouter-bejegyzés kért több kimenetet,
 * mint amit az OpenRouter enged (pl. `google/gemma-3-27b-it`: 117964 kért,
 * élő plafon 16384).
 *
 * Használat:
 *   node tools/model-meta-sync.mjs            # száraz próba
 *   node tools/model-meta-sync.mjs --apply    # írás időbélyeges mentéssel
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/yaml');

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const apply = process.argv.includes('--apply');

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
const routes = doc?.['llm-pi-ai']?.providers ?? {};
const lines = text.split(/\r?\n/);
const indentOf = (l) => (l.match(/^(\s*)/) ?? [''])[1].length;

/** A modell-bejegyzés sorai (a blokk kezdete és vége). */
function blocksOf(providerName) {
  const header = lines.findIndex((l) => new RegExp(`^ {4}${providerName}:\\s*$`).test(l));
  if (header < 0) return [];
  let models = -1;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^ {6}models:\s*$/.test(lines[i])) { models = i; break; }
    if (indentOf(lines[i]) <= 4 && !/^\s*$/.test(lines[i]) && !/^\s*#/.test(lines[i])) break;
  }
  if (models < 0) return [];
  const entryIndent = indentOf(lines[models]) + 2;
  const out = [];
  let i = models + 1;
  while (i < lines.length) {
    if (/^\s*$/.test(lines[i])) { i += 1; continue; }
    if (indentOf(lines[i]) <= entryIndent - 2 && !/^\s*#/.test(lines[i])) break;
    const m = lines[i].match(/^\s*-\s+id:\s*(\S+)\s*$/);
    if (!m || indentOf(lines[i]) !== entryIndent) { i += 1; continue; }
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (/^\s*$/.test(next)) break;
      if (/^\s*-\s+id:/.test(next) && indentOf(next) === entryIndent) break;
      if (indentOf(next) < entryIndent) break;
      end += 1;
    }
    out.push({ id: m[1], start: i, end });
    i = end;
  }
  return out;
}

const CATALOG = {
  openrouter: { list: 'https://openrouter.ai/api/v1/models', auth: 'bearer' },
  groq: { list: 'https://api.groq.com/openai/v1/models', auth: 'bearer' },
  nvidia: { list: 'https://integrate.api.nvidia.com/v1/models', auth: 'bearer' },
  google: { list: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'query' },
};

/** Élő plafonok: id → { context, output } (csak ahol a válasz tartalmazza). */
async function liveLimits(name, route) {
  const cat = CATALOG[name];
  const url = route?.baseURL ? `${String(route.baseURL).replace(/\/+$/, '')}/models` : cat?.list;
  if (!url) return undefined;
  const key = refs[route?.apiKeyEnv ?? ''] ?? '';
  const headers = { accept: 'application/json' };
  const target = cat?.auth === 'query' ? `${url}?key=${encodeURIComponent(key)}` : url;
  if (cat?.auth !== 'query' && key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(target, { headers });
  if (!res.ok) return undefined;
  const json = await res.json();
  const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  const map = new Map();
  for (const entry of arr) {
    let id = String(entry?.id ?? entry?.name ?? '');
    if (name === 'google') id = id.replace(/^models\//, '');
    const context = entry?.context_length ?? entry?.context_window ?? entry?.input_token_limit;
    const output = entry?.top_provider?.max_completion_tokens ?? entry?.max_completion_tokens ?? entry?.output_token_limit;
    if (Number.isInteger(context) || Number.isInteger(output)) map.set(id, { context, output });
  }
  return map;
}

const edits = [];
const report = [];
for (const [name, route] of Object.entries(routes)) {
  const models = route?.models ?? [];
  if (models.length === 0) continue;
  const live = await liveLimits(name, route);
  if (!live) { report.push(`${name}: nincs élő plafon-adat, kihagyva`); continue; }
  const blocks = blocksOf(name);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let changed = 0;
  for (const entry of models) {
    const id = String(entry?.id ?? '');
    const limits = live.get(id);
    if (!limits) continue;
    const block = byId.get(id);
    if (!block) continue;
    const ctx = entry?.contextWindow;
    const out = entry?.maxTokens;
    const nextCtx = Number.isInteger(ctx) && Number.isInteger(limits.context) && ctx > limits.context ? limits.context : ctx;
    const nextOut = Number.isInteger(out) && Number.isInteger(limits.output) && out > limits.output ? limits.output : out;
    if (nextCtx === ctx && nextOut === out) continue;
    changed += 1;
    for (let i = block.start; i < block.end; i++) {
      if (Number.isInteger(nextCtx) && nextCtx !== ctx) {
        const m = lines[i].match(/^(\s+contextWindow:\s*)(\d+)(\s*)$/);
        if (m && Number(m[2]) === ctx) edits.push({ index: i, text: `${m[1]}${nextCtx}${m[3]}`, note: `${id}: contextWindow ${ctx} → ${nextCtx}` });
      }
      if (Number.isInteger(nextOut) && nextOut !== out) {
        const m = lines[i].match(/^(\s+maxTokens:\s*)(\d+)(\s*)$/);
        if (m && Number(m[2]) === out) edits.push({ index: i, text: `${m[1]}${nextOut}${m[3]}`, note: `${id}: maxTokens ${out} → ${nextOut}` });
      }
    }
  }
  report.push(`${name}: ${models.length} modell, ${changed} bejegyzés szorítva`);
}

console.log(`settings: ${SETTINGS}`);
for (const line of report) console.log(`  ${line}`);
if (edits.length === 0) {
  console.log('\nNincs szinkronizálni való metaadat — minden érték az élő plafonon belül van.');
  process.exit(0);
}
console.log(`\n${edits.length} mező módosul:`);
for (const e of edits.slice(0, 40)) console.log(`  - ${e.note}`);

if (!apply) {
  console.log('\nSzáraz próba — írás: --apply');
  process.exit(0);
}
const next = lines.slice();
for (const e of edits) next[e.index] = e.text;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `${SETTINGS}.bak-${stamp}-metaadat`;
copyFileSync(SETTINGS, backup);
writeFileSync(SETTINGS, next.join('\n'), 'utf8');
console.log(`\nALKALMAZVA: ${edits.length} mező frissítve. Mentés: ${backup}`);
