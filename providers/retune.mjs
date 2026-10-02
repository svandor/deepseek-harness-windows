#!/usr/bin/env node
/**
 * Havi modell-újrahangoló a DeepSeek Harness-hez.
 *
 * Mit csinál:
 *   1. Beolvassa a ~/.dsh/settings.yaml llm-pi-ai szekcióját.
 *   2. Lekérdezi minden provider ÉLŐ modell-listáját.
 *   3. Megkeresi az elhalt modell-id-ket (amik már nem léteznek), és minden
 *      elhalt id helyére egy élő, azonos családból származó jelöltet javasol.
 *   4. Riportot ír a providers/reports/ mappába (mi változott, mi halt meg).
 *   5. --apply esetén biztonsági mentés után átírja a settings.yaml-t.
 *
 * Használat:
 *   node retune.mjs                 # csak riport (nem ír semmit)
 *   node retune.mjs --apply         # mentés + javítás
 *   node retune.mjs --verbose       # a teljes élő listák is a riportba
 *
 * Biztonsági elvek:
 *   - Az `agent-default-model` szekciót SOHA nem módosítja.
 *   - Az `apiKeyEnv`, `baseURL`, `api`, `displayName` mezőket nem bántja.
 *   - Minden írás előtt `<fajl>.bak-<idobelyeg>` mentés készül.
 *   - Ha egy elhalt id-re nincs jó jelölt, azt jelöli (nem töröl csendben).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const DRY = !APPLY;

function argVal(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

// fileURLToPath: a url.pathname %20-nel kódolná a szóközt a mappanévben.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
// A --settings felülírás teszteléshez és más profilokhoz.
const SETTINGS = path.resolve(argVal('settings') ?? path.join(DSH_HOME, 'settings.yaml'));
const CREDS = path.join(DSH_HOME, '.credentials.yaml');
const REPORT_DIR = path.join(HERE, 'reports');

// ── ismert végpontok: kulcs nélkül is listázhatók ──────────────────────────
// A baseURL: null azt jelenti, hogy a modell-lista a katalógusból jön, de
// a provider élő listája egy fix végponton kérdezhető le.
const ENDPOINTS = {
  groq:       { list: 'https://api.groq.com/openai/v1/models',       auth: 'bearer' },
  openrouter: { list: 'https://openrouter.ai/api/v1/models',         auth: 'bearer' },
  nvidia:     { list: 'https://integrate.api.nvidia.com/v1/models',  auth: 'bearer' },
  cerebras:   { list: 'https://api.cerebras.ai/v1/models',           auth: 'bearer' },
  google:     { list: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'x-goog-api-key', strip: /^models\// },
  deepseek:   { list: 'https://api.deepseek.com/models',             auth: 'bearer' },
  mistral:    { list: 'https://api.mistral.ai/v1/models',            auth: 'bearer' },
  together:   { list: 'https://api.together.xyz/v1/models',          auth: 'bearer' },
  xai:        { list: 'https://api.x.ai/v1/models',                  auth: 'bearer' },
  zai:        { list: 'https://api.z.ai/api/paas/v4/models',         auth: 'bearer' },
  moonshotai: { list: 'https://api.moonshot.ai/v1/models',           auth: 'bearer' },
  minimax:    { list: 'https://api.minimax.io/v1/models',            auth: 'bearer' },
  baseten:    { list: 'https://inference.baseten.co/v1/models',      auth: 'bearer' },
  fireworks:  { list: 'https://api.fireworks.ai/inference/v1/models',auth: 'bearer' },
};

// Nem chat-modellek kiszűrése a helyettesítő-javaslathoz.
const NOT_CHAT = /embed|whisper|tts|rerank|moderation|guard|prompt-guard|lyria|image|vision-only|safety|cosmos|parse|reward|audio|orpheus/i;

// ── segédek ────────────────────────────────────────────────────────────────
function log(...a) { process.stdout.write(a.join(' ') + '\n'); }
function nowStamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

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

/**
 * A llm-pi-ai szekció providerjeinek kiolvasása a settings.yaml-ból.
 * A modell-sorokra megjegyzi a fájlbeli pozíciót is, hogy a javítás
 * célzottan tudjon írni.
 */
function readProviders(text) {
  const lines = text.split(/\r?\n/);
  const providers = [];
  let inPiAi = false, cur = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^llm-pi-ai:\s*$/.test(raw)) { inPiAi = true; continue; }
    if (!inPiAi) continue;

    let m;
    // provider blokk kezdete: pontosan 4 szóköz behúzás, nem a `providers:` kulcs
    if ((m = raw.match(/^ {4}([A-Za-z0-9._-]+):\s*$/)) && m[1] !== 'providers') {
      cur = { name: m[1], apiKeyEnv: null, baseURL: null, models: [], startLine: i };
      providers.push(cur);
      continue;
    }
    // az llm-pi-ai szekció vége: egy új top-level kulcs
    if (cur && /^\S/.test(raw) && !/^llm-pi-ai:/.test(raw)) { cur = null; inPiAi = false; continue; }
    if (!cur) continue;

    if ((m = raw.match(/^\s+apiKeyEnv:\s*(\S+)/))) { cur.apiKeyEnv = m[1]; continue; }
    if ((m = raw.match(/^\s+baseURL:\s*(\S+)/))) { cur.baseURL = m[1]; continue; }
    // Modell-bejegyzés: legalább 6 szóköz behúzás (a provider 4-en van).
    // A GUI 10, a kézzel írt fájl 8 szóközt használ — mindkettőt elfogadjuk.
    if ((m = raw.match(/^ {6,}- id:\s*(.+?)\s*$/))) {
      cur.models.push({ id: m[1], line: i });
      continue;
    }
  }
  return providers;
}

async function fetchLive(name, apiKeyEnv, refs, baseURL) {
  const ep = ENDPOINTS[name];
  let url = ep?.list;
  if (baseURL && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseURL)) {
    url = `${baseURL.replace(/\/+$/, '')}/models`;
  }
  if (!url) return { ok: false, reason: 'nincs ismert listázó végpont' };

  const key = apiKeyEnv ? refs[apiKeyEnv] : undefined;
  const headers = { accept: 'application/json' };
  if (ep?.auth === 'x-goog-api-key' && key) headers['x-goog-api-key'] = key;
  else if (key) headers.authorization = `Bearer ${key}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 45000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 140).replace(/\s+/g, ' ')}` };
    const json = JSON.parse(text);
    const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const ids = [];
    for (const e of arr) {
      let id = String(e.id ?? e.name ?? '');
      if (ep?.strip) id = id.replace(ep.strip, '');
      if (id) ids.push(id);
    }
    return { ok: true, ids, raw: arr };
  } catch (err) {
    return { ok: false, reason: `hálózat: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Hasonlósági pontszám: ugyanaz a család, hasonló méret előny. */
function score(deadId, candidate) {
  const fam = (s) => String(s).toLowerCase().replace(/[-_.:]/g, ' ').split(/\s+/).filter(Boolean);
  const a = new Set(fam(deadId).filter((t) => !/^(v)?\d+(\.\d+)?$/.test(t)));
  const b = new Set(fam(candidate).filter((t) => !/^(v)?\d+(\.\d+)?$/.test(t)));
  let s = 0;
  for (const t of a) if (b.has(t)) s += 10;
  // verzió-szám egyezés
  const av = deadId.match(/\d+(\.\d+)?/g) ?? [];
  const bv = candidate.match(/\d+(\.\d+)?/g) ?? [];
  for (const v of av) if (bv.includes(v)) s += 3;
  return s;
}

function pickReplacements(deadId, liveIds) {
  return liveIds
    .filter((id) => !NOT_CHAT.test(id))
    .map((id) => ({ id, s: score(deadId, id) }))
    .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
    .slice(0, 3);
}

// ── fő ─────────────────────────────────────────────────────────────────────
if (!existsSync(SETTINGS)) { log(`Nem található: ${SETTINGS}`); process.exit(2); }
let settingsText;
try { settingsText = readFileSync(SETTINGS, 'utf8'); } catch (e) { log(`Nem olvasható: ${e.message}`); process.exit(2); }

const refs = existsSync(CREDS) ? readRefs(readFileSync(CREDS, 'utf8')) : {};
const providers = readProviders(settingsText);
if (providers.length === 0) { log('Nincs llm-pi-ai provider a settings.yaml-ban.'); process.exit(2); }

const started = new Date();
log(`retune — ${started.toISOString()}${DRY ? '  (CSAK RIPORT)' : '  (APPLY)'}`);
log(`settings: ${SETTINGS}`);
log('');

const results = [];
for (const p of providers) {
  const live = await fetchLive(p.name, p.apiKeyEnv, refs, p.baseURL);
  const entry = { provider: p, live, dead: [], suggestions: {} };

  if (!live.ok) {
    log(`── ${p.name}: a lista nem kérdezhető le (${live.reason})`);
    results.push(entry);
    continue;
  }

  const liveSet = new Set(live.ids);
  for (const m of p.models) {
    if (!liveSet.has(m.id)) {
      const sug = pickReplacements(m.id, live.ids);
      entry.dead.push(m.id);
      entry.suggestions[m.id] = sug;
    }
  }

  const aliveCount = p.models.length - entry.dead.length;
  log(`── ${p.name}: ${aliveCount}/${p.models.length} él  (${live.ids.length} modell a végponton)`);
  for (const d of entry.dead) {
    const sug = entry.suggestions[d];
    log(`   ✗ ${d}`);
    if (sug.length) log(`     → javaslat: ${sug.map((s) => s.id).join(', ')}`);
    else log(`     → nincs jelölt: kézzel kell pótolni`);
  }
  results.push(entry);
}

const totalDead = results.reduce((n, r) => n + r.dead.length, 0);
log('');
log('='.repeat(64));
log(totalDead === 0 ? 'Nincs elhalt modell-id — nincs teendő.' : `${totalDead} elhalt modell-id ${results.filter((r) => r.dead.length).length} providerben.`);

// ── javítás ────────────────────────────────────────────────────────────────
let applied = [];
let removed = [];
let unfixable = [];
if (APPLY && totalDead > 0) {
  const lines = settingsText.split(/\r?\n/);
  const replacements = [];
  const removals = [];

  for (const r of results) {
    for (const d of r.dead) {
      const sug = r.suggestions[d];
      const lineIdx = r.provider.models.find((m) => m.id === d).line;
      // Csak akkor cserélünk, ha a jelölt ugyanabból a családból való
      // (score >= 10). Enélkül a csere találgatás lenne.
      if (sug.length > 0 && sug[0].s >= 10) {
        replacements.push({ lineIdx, from: d, to: sug[0].id, provider: r.provider.name });
      } else {
        // Nincs jó jelölt: az elhalt id-t EL KELL távolítani, mert így
        // legalább nem hívható modell marad a konfigban. A szülő `id:` sort
        // és a hozzá tartozó (mélyebben behúzott) mezőket is eldobjuk.
        removals.push({ lineIdx, id: d, provider: r.provider.name });
      }
    }
  }

  // Előbb a cserék (hátulról előre, hogy a pozíciók ne csússzanak)
  for (const rep of [...replacements].sort((a, b) => b.lineIdx - a.lineIdx)) {
    lines[rep.lineIdx] = lines[rep.lineIdx].replace(
      new RegExp(`- id:\\s*${rep.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`),
      `- id: ${rep.to}`,
    );
    applied.push(`${rep.provider}: ${rep.from}  →  ${rep.to}`);
  }

  // Aztán a törlések (szintén hátulról előre)
  for (const rem of [...removals].sort((a, b) => b.lineIdx - a.lineIdx)) {
    const indent = lines[rem.lineIdx].match(/^(\s*)/)[1].length;
    let end = rem.lineIdx + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() === '') break;
      if (l.match(/^(\s*)/)[1].length <= indent) break;
      end++;
    }
    lines.splice(rem.lineIdx, end - rem.lineIdx);
    removed.push(`${rem.provider}: ${rem.id}`);
  }
  unfixable = [...removals];

  const newText = lines.join('\n');
  const backup = `${SETTINGS}.bak-${nowStamp()}`;
  copyFileSync(SETTINGS, backup);
  writeFileSync(SETTINGS, newText, 'utf8');

  log('');
  log(`Mentés: ${backup}`);
  if (applied.length) { log(''); log('Cserélve:'); for (const a of applied) log(`   ${a}`); }
  if (removed.length) { log(''); log('Törölve (nem volt jó jelölt):'); for (const r of removed) log(`   ${r}`); }
  log('');
  log(`${applied.length} csere, ${removed.length} törlés.`);
}

// ── riport ─────────────────────────────────────────────────────────────────
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const rfile = path.join(REPORT_DIR, `retune-${nowStamp()}.md`);
const md = [];
md.push(`# Modell-újrahangolás — ${started.toISOString()}`);
md.push('');
md.push(`- Mód: **${DRY ? 'csak riport' : 'apply'}**`);
md.push(`- Settings: \`${SETTINGS}\``);
md.push(`- Elhalt modell-id: **${totalDead}**`);
md.push('');
md.push('| Provider | Él / összes | Élő modellek a végponton | Elhalt id-k |');
md.push('|---|---|---|---|');
for (const r of results) {
  const total = r.provider.models.length;
  const alive = total - r.dead.length;
  const liveN = r.live.ok ? r.live.ids.length : '—';
  md.push(`| ${r.provider.name} | ${r.live.ok ? `${alive} / ${total}` : '?'} | ${liveN} | ${r.dead.length ? r.dead.map((d) => `\`${d}\``).join(', ') : '—'} |`);
}
md.push('');
if (totalDead > 0) {
  md.push('## Javasolt cserék');
  md.push('');
  for (const r of results) {
    for (const d of r.dead) {
      const sug = r.suggestions[d];
      md.push(`- **${r.provider.name}** \`${d}\``);
      if (sug.length) md.push(`  - jelöltek: ${sug.map((s) => `\`${s.id}\` (${s.s})`).join(', ')}`);
      else md.push('  - nincs jelölt, kézzel pótolni');
    }
  }
  md.push('');
}
if (applied.length) { md.push('## Alkalmazott cserék'); md.push(''); for (const a of applied) md.push(`- ${a}`); md.push(''); }
if (removed.length) { md.push('## Törölt elhalt id-k (nem volt családi jelölt)'); md.push(''); for (const r of removed) md.push(`- ${r}`); md.push(''); md.push('> Ezeket kézzel érdemes pótolni a GUI *Fetch available models* gombjával.'); md.push(''); }
if (unfixable.length && !APPLY) { md.push('## Kézzel pótlandó (apply nélkül)'); md.push(''); for (const u of unfixable) md.push(`- ${u.provider}: \`${u.id}\``); md.push(''); }
if (VERBOSE) {
  md.push('## Élő modell-listák');
  md.push('');
  for (const r of results) {
    if (!r.live.ok) continue;
    md.push(`### ${r.provider.name} (${r.live.ids.length})`);
    md.push('');
    md.push('```');
    md.push(r.live.ids.join('\n'));
    md.push('```');
    md.push('');
  }
}
writeFileSync(rfile, md.join('\n'), 'utf8');
log(`Riport: ${rfile}`);
