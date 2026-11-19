#!/usr/bin/env node
/**
 * Egy modell felvétele a ~/.dsh/settings.yaml-ba, élő katalógusból:
 *   - a provider `models:` listájába (név, kontextus, kimenet, modalitás),
 *   - opcionálisan a `subagent-model-selection.allowedModels` listába
 *     (ez ENGEDÉLYEZI az eszkalációt arra a route-ra).
 *
 * A fizetős modellt a szkript KIÍRJA (ár a katalógusból), hogy senki ne
 * feltételezze, hogy ingyenes.
 *
 * Használat:
 *   node tools/model-list-add.mjs --provider openrouter --model anthropic/claude-haiku-5.5 --allow-escalation
 *   node tools/model-list-add.mjs ... --apply        # írás (előbb mentés)
 *   node tools/model-list-add.mjs ... --force        # akkor is, ha már benne van
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SETTINGS = path.join(DSH_HOME, 'settings.yaml');
const CREDS = path.join(DSH_HOME, '.credentials.yaml');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const provider = arg('provider');
const modelId = arg('model');
const allowEscalation = flag('allow-escalation');
const apply = flag('apply');
const force = flag('force');

if (!provider || !modelId) {
  console.error('Használat: node tools/model-list-add.mjs --provider <p> --model <id> [--allow-escalation] [--apply] [--force]');
  process.exit(2);
}

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

// ── élő katalógus (OpenRouter) ─────────────────────────────────────────────
const CATALOG = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', key: 'OPENROUTER_API_KEY' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', key: 'NVIDIA_API_KEY' },
  groq: { url: 'https://api.groq.com/openai/v1/models', key: 'GROQ_API_KEY' },
};
const cat = CATALOG[provider];
if (!cat) {
  console.error(`Ehhez a providerhez nincs katalógus-lekérdezés: ${provider} (ismert: ${Object.keys(CATALOG).join(', ')})`);
  process.exit(2);
}
const res = await fetch(cat.url, { headers: { accept: 'application/json', authorization: `Bearer ${refs[cat.key]}` } });
if (!res.ok) { console.error(`katalógus hiba: HTTP ${res.status}`); process.exit(2); }
const entries = (await res.json()).data ?? [];
const entry = entries.find((e) => e.id === modelId);
if (!entry) {
  console.error(`A(z) ${modelId} NEM szerepel az élő ${provider} katalógusban — nem veszem fel.`);
  process.exit(2);
}

const price = (v) => Number(v ?? 0) * 1e6; // USD / 1M token
const promptPrice = price(entry.pricing?.prompt);
const completionPrice = price(entry.pricing?.completion);
const paid = promptPrice > 0 || completionPrice > 0;
const ctx = Number(entry.context_length) || 131072;
const maxOut = Number(entry.top_provider?.max_completion_tokens) || 32768;
const modalities = entry.architecture?.input_modalities ?? ['text'];
const input = ['text', ...(modalities.includes('image') ? ['image'] : [])];
const name = `${String(entry.name ?? entry.id).replace(/\s+/g, ' ').trim()}${paid ? ` ($${promptPrice.toFixed(2)}/$${completionPrice.toFixed(2)} per M)` : ' (free)'}`;

// ── settings.yaml ──────────────────────────────────────────────────────────
const lines = readFileSync(SETTINGS, 'utf8').split(/\r?\n/);
const indentOf = (l) => (l.match(/^(\s*)/) ?? [''])[1].length;
const isBlank = (l) => /^\s*$/.test(l);
const isComment = (l) => /^\s*#/.test(l);
const isKey = (l) => /^\s*[A-Za-z0-9_.-]+\s*:(\s|$)/.test(l) && !isComment(l);

function providerModelsRange(name) {
  const header = lines.findIndex((l) => new RegExp(`^ {4}${name}:\\s*$`).test(l));
  if (header < 0) throw new Error(`nincs ${name} provider blokk`);
  let models = -1;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^ {6}models:\s*$/.test(lines[i])) { models = i; break; }
    if (indentOf(lines[i]) <= 4 && !isBlank(lines[i]) && !isComment(lines[i])) break;
  }
  if (models < 0) throw new Error(`${name}: nincs models: sor`);
  let end = lines.length;
  for (let i = models + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= 6 && !isComment(lines[i])) { end = i; break; }
  }
  return { models, end };
}

function allowedModelsRange() {
  const sel = lines.findIndex((l) => /^subagent-model-selection:\s*$/.test(l));
  if (sel < 0) throw new Error('nincs subagent-model-selection blokk');
  let am = -1;
  for (let i = sel + 1; i < lines.length; i++) {
    if (/^\s+allowedModels:\s*$/.test(lines[i])) { am = i; break; }
    if (indentOf(lines[i]) === 0 && !isBlank(lines[i])) break;
  }
  if (am < 0) throw new Error('nincs allowedModels lista');
  let end = lines.length;
  for (let i = am + 1; i < lines.length; i++) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    if (indentOf(lines[i]) <= 2) { end = i; break; }
  }
  // az utolsó nem üres sorig húzzuk vissza (a záró üres sorok ne számítsanak)
  while (end > am + 1 && isBlank(lines[end - 1])) end--;
  return { am, end };
}

const out = [...lines];
const added = [];

// 1) provider models
{
  const { models, end } = providerModelsRange(provider);
  const body = out.slice(models + 1, end);
  const already = body.some((l) => new RegExp(`^ {8}- id:\\s*${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  if (already && !force) {
    console.log(`${provider}/${modelId}: már a listán van — nem veszem fel újra.`);
  } else if (!already) {
    const entryLines = [
      ...(paid
        ? [`        # 2026-11-19: FIZETŐS modell ($${promptPrice.toFixed(2)}/M be, $${completionPrice.toFixed(2)}/M ki).`,
           '        # Az eszkalációs cél tudatos kivétele; a lista többi tagja ingyenes.']
        : ['        # 2026-11-19: élő katalógusból (ingyenes).']),
      `        - id: ${modelId}`,
      `          name: ${JSON.stringify(name)}`,
      `          contextWindow: ${ctx}`,
      `          maxTokens: ${Math.min(maxOut, ctx)}`,
      ...(input.length > 1 ? [`          input: [ ${input.join(', ')} ]`] : []),
    ];
    out.splice(models + 1, 0, ...entryLines);
    added.push(`models: ${modelId}`);
  }
}

// 2) allowedModels (eszkaláció engedélyezése)
if (allowEscalation) {
  const { am, end } = allowedModelsRange();
  const has = out.slice(am + 1, end).some((l, i, arr) => {
    if (!new RegExp(`^\\s+-\\s+provider:\\s*${provider}\\s*$`).test(l)) return false;
    return arr[i + 1] && new RegExp(`^\\s+model:\\s*${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(arr[i + 1]);
  });
  if (has) {
    console.log(`allowedModels: ${provider}/${modelId} már engedélyezve.`);
  } else {
    const ins = [
      paid
        ? `    # 2026-11-19: FIZETŐS eszkalációs cél ($${promptPrice.toFixed(2)}/M be, $${completionPrice.toFixed(2)}/M ki) — tudatos kivétel.`
        : '    # 2026-11-19: eszkalációs cél (ingyenes).',
      `    - provider: ${provider}`,
      `      model: ${modelId}`,
    ];
    out.splice(end, 0, ...ins);
    added.push(`allowedModels: ${provider}/${modelId}`);
  }
}

const text = out.join('\n');
if (!added.length) {
  console.log('Nincs mit írni — minden kérés már teljesült.');
  process.exit(0);
}
console.log(`Modell: ${provider}/${modelId}`);
console.log(`  név: ${name}`);
console.log(`  kontextus: ${ctx}, max kimenet: ${Math.min(maxOut, ctx)}, input: ${input.join('+')}`);
console.log(`  ár: ${paid ? `FIZETŐS — $${promptPrice.toFixed(2)}/M be, $${completionPrice.toFixed(2)}/M ki` : 'ingyenes (0 USD)'}`);
console.log(`  változás: ${added.join(' | ')}`);

if (apply) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${SETTINGS}.bak-${stamp}-modell-felvetel`;
  copyFileSync(SETTINGS, backup);
  writeFileSync(SETTINGS, text, 'utf8');
  console.log(`\nALKALMAZVA. Biztonsági másolat: ${backup}`);
} else {
  console.log('\nSzimuláció (nem írtam a settings.yaml-ba). Alkalmazás: --apply');
}
