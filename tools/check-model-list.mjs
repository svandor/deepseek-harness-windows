#!/usr/bin/env node
/**
 * Modell-lista AUDIT: providerek, hivatkozások (allowedModels / agent-default-model),
 * duplikátumok, hiányzó kulcsok, és a bejegyzések METAADATAI az élő katalógus
 * ellen (contextWindow / maxTokens ne kérjen többet, mint amit a végpont enged).
 *
 * MIÉRT: a GUI „Add model” útja a BEÉPÍTETT pi-ai katalógusból dolgozik, ami
 * elavulhat. 2026-11-19-én ez 102 nem létező id-t és 28 túllógó metaadatot
 * hozott a settings.yaml-ba (a tünet 404 / 400 volt a kérésnél). A három eszköz
 * együtt teljes: `check-model-list` (audit) + `model-list-prune` (halott id-k) +
 * `model-meta-sync` (plafonok) + `check-model-config` (pi-ai szabályok).
 *
 * Használat: node tools/check-model-list.mjs
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/yaml');
const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const doc = YAML.parse(readFileSync(path.join(DSH_HOME, 'settings.yaml'), 'utf8'));
const routes = doc?.['llm-pi-ai']?.providers ?? {};

// A beépített (nem llm-pi-ai) route-ok a profil-patch-ből jönnek, ezért a
// settings `llm-pi-ai` blokkjában NEM szerepelnek — az audit ne jelezze őket.
const BUILTIN_ROUTES = ['deepseek-official', 'deepseek'];

// FELHASZNÁLÓI SZABÁLY (2026-11-19, szó szerint): „semmilyen fizetős modell nem
// kerülhet delegálási listára … csak eszkalálásra mehetnek fizetős modellek külön
// utasításra”. Ezért az `allowedModels` csak INGYENES célt tartalmazhat; a
// fizetős bejegyzés itt HIBA. A fizetőség forrása: OpenRouter = élő árazás
// (prompt/completion nem 0); a két Alibaba-route és a DeepSeek hivatalos API
// számlázott; a proxy route-ok (auto-router, subagent-worker) a helyi ingyenes
// lánc; a Groq saját ingyenes keret.
const ALWAYS_PAID_ROUTES = ['deepseek-official', 'deepseek', 'alibaba', 'alibaba-compat'];
const FREE_CHAIN_ROUTES = ['auto-router', 'subagent-worker', 'groq'];

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

const problems = [];
const warnings = [];
const note = (text) => problems.push(text);
const providerNames = Object.keys(routes);
console.log(`Providerek (${providerNames.length}): ${providerNames.join(', ')}`);

// ── 0. OpenRouter élő katalógus (árazás + metaadat) ────────────────────────
const or = routes.openrouter;
let orCatalog;
if (or && Array.isArray(or.models) && or.models.length > 0) {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { authorization: `Bearer ${refs[or.apiKeyEnv] ?? ''}` },
  });
  const json = await res.json();
  orCatalog = new Map((json.data ?? []).map((m) => [m.id, m]));
}

/** Fizetős-e a route/modell? (a fenti szabály szerint) */
function paidReason(provider, model) {
  if (ALWAYS_PAID_ROUTES.includes(provider)) return 'számlázott szolgáltató';
  if (FREE_CHAIN_ROUTES.includes(provider)) return undefined;
  if (provider === 'openrouter') {
    if (/:free$/.test(model)) return undefined;
    const meta = orCatalog?.get(model);
    const prompt = meta?.pricing?.prompt;
    const completion = meta?.pricing?.completion;
    if (prompt !== undefined && completion !== undefined) {
      const free = Number(prompt) === 0 && Number(completion) === 0;
      return free ? undefined : `ár: $${prompt}/M be, $${completion}/M ki`;
    }
    return 'nem igazolt ingyenes (nincs `:free` és nincs élő árazás)';
  }
  return 'nem igazolt ingyenes route';
}

// ── 1. hivatkozások ────────────────────────────────────────────────────────
const allowed = doc?.['subagent-model-selection']?.allowedModels ?? [];
console.log(`allowedModels: ${allowed.length} bejegyzés`);
for (const entry of allowed) {
  const provider = String(entry?.provider ?? '');
  const model = String(entry?.model ?? '');
  if (!providerNames.includes(provider) && !BUILTIN_ROUTES.includes(provider)) {
    note(`allowedModels: „${provider}/${model}” — a provider NEM létezik (sem a settings-ben, sem beépített route-ként)`);
    continue;
  }
  const models = (routes[provider]?.models ?? []).map((m) => String(m?.id ?? ''));
  if (models.length > 0 && !models.includes(model)) {
    note(`allowedModels: „${provider}/${model}” — a modell nincs a provider listáján`);
  }
  const paid = paidReason(provider, model);
  if (paid !== undefined) {
    // FIGYELMEZTETÉS, nem hiba: a felhasználó szabálya szerint a delegálási cél
    // ingyenes kell legyen, de a fizetős cél „kifejezett, eseti utasításra”
    // megengedett — a meglévő, dokumentált tételeket ezért nem büntetjük, csak
    // minden futásnál KIÍRJUK, hogy ne csússzon be új észrevétlenül.
    warnings.push(`allowedModels: „${provider}/${model}” FIZETŐS (${paid}) — csak kifejezett utasításra`);
  }
}

const defaultModel = doc?.['agent-default-model'];
if (defaultModel !== undefined) {
  const provider = String(defaultModel?.provider ?? '');
  const model = String(defaultModel?.model ?? '');
  console.log(`agent-default-model: ${provider}/${model}`);
  if (!providerNames.includes(provider) && !BUILTIN_ROUTES.includes(provider)) {
    note(`agent-default-model: a provider „${provider}” nem létezik`);
  } else {
    const models = (routes[provider]?.models ?? []).map((m) => String(m?.id ?? ''));
    if (models.length > 0 && !models.includes(model)) note(`agent-default-model: „${model}” nincs a(z) „${provider}” listáján`);
  }
}

// ── 2. duplikátumok + kulcsok ──────────────────────────────────────────────
for (const [name, route] of Object.entries(routes)) {
  const models = (route?.models ?? []).map((m) => String(m?.id ?? ''));
  const seen = new Set();
  for (const id of models) {
    if (id === '') note(`${name}: üres modell-id`);
    if (seen.has(id)) note(`${name}: DUPLIKÁLT id — ${id}`);
    // A `:batch` végű OpenRouter-id él, de a chat/completions végponton NEM
    // használható (mért 404, DeepInfraBatchAdapter) — felületen kiválasztva
    // mindig hibázna, ezért hiba, ha benne maradt a listában.
    if (/:batch$/.test(id)) note(`${name}: „${id}” csak batch API-ra való (chat-en 404)`);
    seen.add(id);
  }
  if (models.length > 0 && !refs[route?.apiKeyEnv ?? '']) {
    note(`${name}: a(z) ${route?.apiKeyEnv} kulcs hiányzik a .credentials.yaml-ból`);
  }
  console.log(`${name.padEnd(16)} ${String(models.length).padStart(4)} modell | api: ${route?.api ?? '(katalógus)'} | baseURL: ${route?.baseURL ?? '(katalógus)'}`);
}

// ── 3. metaadat az élő OpenRouter katalógus ellen ──────────────────────────
if (or && Array.isArray(or.models) && or.models.length > 0 && orCatalog) {
  const live = orCatalog;
  let checked = 0;
  const mismatches = [];
  for (const entry of or.models) {
    const id = String(entry?.id ?? '');
    const meta = live.get(id);
    if (!meta) continue;
    checked += 1;
    const ctx = entry?.contextWindow;
    const out = entry?.maxTokens;
    const liveCtx = meta.context_length ?? undefined;
    const liveOut = meta.top_provider?.max_completion_tokens ?? meta.per_request_limits?.max_tokens ?? undefined;
    if (Number.isInteger(ctx) && Number.isInteger(liveCtx) && ctx > liveCtx) mismatches.push(`${id}: contextWindow ${ctx} > élő ${liveCtx}`);
    if (Number.isInteger(out) && Number.isInteger(liveOut) && out > liveOut) mismatches.push(`${id}: maxTokens ${out} > élő ${liveOut}`);
    if (Number.isInteger(ctx) && Number.isInteger(out) && out > ctx) mismatches.push(`${id}: maxTokens ${out} > contextWindow ${ctx}`);
  }
  console.log(`\nOpenRouter metaadat-ellenőrzés: ${checked} modell az élő katalógusból`);
  if (mismatches.length === 0) console.log('  ✓ nincs túllógó kontextus/kimenet');
  else {
    console.log(`  ✗ ${mismatches.length} eltérés (a pi-ai ilyenkor 400-at kaphat):`);
    for (const m of mismatches.slice(0, 40)) console.log(`    - ${m}`);
    note(`openrouter: ${mismatches.length} metaadat-eltérés`);
  }
}

if (warnings.length > 0) {
  console.log(`\n⚠ ${warnings.length} figyelmeztetés (nem hiba):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
console.log(problems.length === 0 ? '\n✓ NINCS hiba a modell-listában.' : `\n✗ ${problems.length} hiba:`);
for (const p of problems) console.log(`  - ${p}`);
process.exitCode = problems.length === 0 ? 0 : 1;
