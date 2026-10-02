#!/usr/bin/env node
/**
 * A DELEGÁLÁSI LÁNC végponttól végpontig ellenőrzése.
 *
 * Mit ellenőriz és miért pont azt:
 *
 *   1. FUT-E A PROXY?  A `subagent-worker` provider egy helyi proxyra mutat
 *      (127.0.0.1:4123). Ha a proxy nem fut, a gyermek-session MINDEN hívása
 *      elhal — a szülő nem. Ez a mért hiba: a proxy 2026-09-27 18:19:31-én
 *      minden hibaüzenet nélkül elhalt, és nem indult újra.
 *
 *   2. VAN-E FELHŐS CÉL A `worker` LÁNCBAN?  Ha a kulcsok nem oldódtak fel,
 *      a lánc csendben a helyi Ollamára csúszott: 117 s, és a válasz
 *      content-be csomagolt pszeudo-tool-hívás (nem `tool_calls`). A DSH-nak
 *      ez használhatatlan, és pontosan "behalt delegálásnak" látszik.
 *
 *   3. VALÓDI TOOL-HÍVÁS?  Nem elég, hogy a modell válaszol: a subagent teljes
 *      agent-loopot futtat, ezért a `tool_calls` megléte a bizonyíték. A
 *      tartalom-alapú pszeudo-hívást NEM fogadjuk el.
 *
 *   4. A DSH OLDALI BEÁLLÍTÁS  (settings.yaml + cordis.patch.yml) a helyén
 *      van-e. Ha a patch nem érvényesül, a gyermek a szülő (fizetős) route-ját
 *      örökli — az nem hiba, de nem az, amit beállítottunk.
 *
 * Használat:
 *   node verify-subagent-chain.mjs
 *   node verify-subagent-chain.mjs --json        # gépi feldolgozásra
 *   node verify-subagent-chain.mjs --timeout 30000
 *
 * Kilépési kód: 0 = minden rendben, 1 = hiba, 2 = figyelmeztetés.
 *
 * A kulcsok soha nem kerülnek a kimenetre.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const AS_JSON = process.argv.includes('--json');
const tIdx = process.argv.indexOf('--timeout');
const TIMEOUT_MS = tIdx !== -1 ? Number(process.argv[tIdx + 1]) || 20000 : 20000;

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 4123);
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;
const SLOW_MS = 5000;

const results = [];
let exitCode = 0;

function report(name, level, detail) {
  results.push({ name, level, detail });
  if (level === 'FAIL') exitCode = 1;
  else if (level === 'WARN' && exitCode === 0) exitCode = 2;
}

// ── 1) proxy él-e ──────────────────────────────────────────────────────────
async function checkProxy() {
  let health;
  try {
    const res = await fetch(`${PROXY_BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
    health = await res.json();
  } catch (err) {
    report('proxy fut', 'FAIL',
      `a proxy nem válaszol a ${PROXY_BASE} címen (${err?.message ?? err}). ` +
      `Indítás: providers\\run-proxy-service.ps1, vagy telepítsd a watchdogot: ` +
      `providers\\install-subagent-proxy.ps1`);
    return null;
  }
  report('proxy fut', 'OK', `${PROXY_BASE} válaszol`);
  return health;
}

// ── 2) a worker lánc értékelése ────────────────────────────────────────────
function checkChain(health) {
  const chain = health.routes?.worker ?? [];
  if (chain.length === 0) {
    report('worker lánc', 'FAIL', 'üres — nincs használható cél (hiányzó kulcs?)');
    return false;
  }
  const cloud = chain.filter((t) => !t.startsWith('ollama/'));
  if (cloud.length === 0) {
    report('worker lánc', 'FAIL',
      `nincs felhős cél, csak helyi: ${chain.join(' -> ')}. ` +
      `Ilyenkor a delegálás ~2 percig csendben fut és nem hív toolt. ` +
      `Hiányzó kulcsok: ${JSON.stringify(health.missingKeys ?? {})}`);
    return false;
  }
  const level = chain[0].startsWith('ollama/') ? 'WARN' : 'OK';
  report('worker lánc', level, chain.join(' -> '));
  return true;
}

// ── 3) valódi tool-hívás a worker route-on ─────────────────────────────────
async function checkToolCall() {
  const body = {
    model: 'worker',
    messages: [{ role: 'user', content: 'What is the weather in Budapest? Use the get_weather tool.' }],
    max_tokens: 300,
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
  };

  const started = Date.now();
  let json;
  try {
    const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer verify' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      report('tool-hívás', 'FAIL', `HTTP ${res.status}: ${text.slice(0, 400)}`);
      return;
    }
    json = JSON.parse(text);
  } catch (err) {
    report('tool-hívás', 'FAIL', `a kérés nem futott le (${TIMEOUT_MS} ms): ${err?.message ?? err}`);
    return;
  }

  const elapsed = Date.now() - started;
  const msg = json?.choices?.[0]?.message ?? {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  if (calls.length === 0) {
    const preview = typeof msg.content === 'string' ? msg.content.slice(0, 160) : '';
    const pseudo = typeof msg.content === 'string' && /"name"\s*:/.test(msg.content);
    report('tool-hívás', 'FAIL',
      `nem jött valódi tool_calls (${elapsed} ms, modell: ${json.model}). ` +
      (pseudo
        ? `A válasz content-be csomagolt pszeudo-hívás — ez a helyi Ollama tünete. `
        : '') +
      `content="${preview}"`);
    return;
  }

  const name = calls[0]?.function?.name ?? '?';
  report('tool-hívás', elapsed > SLOW_MS ? 'WARN' : 'OK',
    `${elapsed} ms, ${json.model}, tool=${name}` +
    (elapsed > SLOW_MS ? ` (lassú: > ${SLOW_MS} ms — valószínűleg helyi modell)` : ''));
}

// ── 4) a DSH oldali beállítás ──────────────────────────────────────────────
function checkDshConfig() {
  const settingsPath = path.join(DSH_HOME, 'settings.yaml');
  const patchPath = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');

  if (!existsSync(settingsPath)) {
    report('settings.yaml', 'WARN', `nincs ilyen fájl: ${settingsPath}`);
  } else {
    const text = readFileSync(settingsPath, 'utf8');
    const hasSelection = /^subagent-model-selection:\s*$/m.test(text);
    const hasProvider = /^\s{4}subagent-worker:\s*$/m.test(text);
    if (hasSelection && hasProvider) report('settings.yaml', 'OK', 'subagent-model-selection + subagent-worker provider megvan');
    else report('settings.yaml', 'WARN',
      `hiányzik: ${[!hasSelection && 'subagent-model-selection', !hasProvider && 'llm-pi-ai.providers.subagent-worker'].filter(Boolean).join(', ')}`);
  }

  if (!existsSync(patchPath)) {
    report('cordis.patch.yml', 'WARN', `nincs ilyen fájl: ${patchPath}`);
  } else {
    const text = readFileSync(patchPath, 'utf8');
    const pinsWorker = /- id:\s*tool-subagent[\s\S]*?agentOptions:[\s\S]*?provider:\s*subagent-worker/.test(text);
    if (pinsWorker) report('cordis.patch.yml', 'OK', 'a tool-subagent a subagent-worker/worker route-ra van kötve');
    else report('cordis.patch.yml', 'WARN',
      'a tool-subagent nincs a subagent-worker route-ra kötve — a gyermek a szülő route-ját örökli');
  }
}

// ── futás ──────────────────────────────────────────────────────────────────
const health = await checkProxy();
if (health) {
  const chainOk = checkChain(health);
  if (chainOk) await checkToolCall();
}
checkDshConfig();

if (AS_JSON) {
  console.log(JSON.stringify({ exitCode, results }, null, 2));
} else {
  const mark = { OK: '[OK]  ', WARN: '[FIGY]', FAIL: '[HIBA]' };
  console.log('');
  console.log('Delegálási lánc ellenőrzése');
  console.log('===========================');
  for (const r of results) console.log(`${mark[r.level] ?? '[?]   '} ${r.name}: ${r.detail}`);
  console.log('');
  console.log(exitCode === 0 ? 'Minden rendben — a delegálás mehet.'
    : exitCode === 1 ? 'HIBA: a delegálás így nem működik (lásd fent).'
    : 'FIGYELMEZTETÉS: működik, de nem az elvárt úton.');
}

process.exit(exitCode);
