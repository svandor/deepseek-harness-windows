#!/usr/bin/env node
/**
 * A ~/.dsh/settings.yaml `llm-pi-ai` blokkjának HELYI ellenőrzése a valódi
 * pi-ai katalógus ellen — ugyanazokat a szabályokat és hibaüzeneteket adva,
 * amiket a DSH `llm-pi-ai` adapter a mentéskor (`assertServiceable`) használ.
 *
 * Miért kell: a GUI csak a mentés pillanatában jelzi a hibát (pl. „needs an
 * api”); így a fájl szerkesztése előtt/után azonnal látszik, hogy a settings
 * érvényes-e, és MELYIK modell miatt nem.
 *
 * Szabályok (a dsh-llm-pi-ai `resolveRouteModels` szerint):
 *  - egy model id csak egyszer szerepelhet a route listáján;
 *  - a modell drótprotokollja: route.api → katalógusbeli modell api-ja →
 *    a route közös api-ja (csak ha a katalógus egyetlen api-t használ);
 *    ha így sem jön ki, a route-nak `api:`-t kell adnia;
 *  - baseURL: route.baseURL → katalógus baseUrl → provider baseUrl;
 *  - contextWindow/maxTokens pozitív egész (route default vagy katalógus).
 *
 * Használat:
 *   node tools/check-model-config.mjs            # emberi összegzés
 *   node tools/check-model-config.mjs --json     # gépileg olvasható
 *   node tools/check-model-config.mjs --file <settings.yaml>
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const PI_AI = process.env.PI_AI_DIR
  ?? 'C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/@earendil-works/pi-ai/dist';
const require = createRequire(import.meta.url);
const YAML = require('C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/yaml');

const argv = process.argv.slice(2);
const fileArg = argv.indexOf('--file') >= 0 ? argv[argv.indexOf('--file') + 1] : undefined;
const asJson = argv.includes('--json');
const SETTINGS = fileArg ?? path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'settings.yaml');

const { builtinProviders, getBuiltinModels } = await import(
  new URL(`file:///${PI_AI.replace(/\\/g, '/')}/providers/all.js`).href
);

// a `getBuiltinProviders()` id-ket ad, a `builtinProviders()` a provider-objektumokat
const providers = new Map(builtinProviders().map((p) => [p.id, p]));
const catalogOf = (id) => {
  const map = new Map();
  for (const model of getBuiltinModels(id) ?? []) {
    map.set(model.id, { api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow, maxTokens: model.maxTokens });
  }
  return map;
};

const doc = YAML.parse(readFileSync(SETTINGS, 'utf8'));
const routes = doc?.['llm-pi-ai']?.providers ?? {};
const problems = [];
const rows = [];

const fail = (provider, message) => problems.push(`llm-pi-ai: provider "${provider}" ${message}`);

for (const [name, route] of Object.entries(routes)) {
  const defaults = catalogOf(name);
  const configured = route.models ?? [];
  const providerBaseUrl = providers.get(name)?.baseUrl;
  const sharedApis = new Set([...defaults.values()].map((m) => m.api).filter(Boolean));
  const routeApi = sharedApis.size === 1 ? [...sharedApis][0] : undefined;
  const entries = configured.length > 0 ? configured : [...defaults.values()].map((m) => ({ id: m.id }));
  const seen = new Set();
  const unknown = [];
  let errors = 0;
  const err = (message) => { fail(name, message); errors++; };

  if (entries.length === 0) err('resolves no models; the installed catalog does not describe this route, so its models must be listed in configuration');
  for (const entry of entries) {
    const id = String(entry.id ?? '');
    if (id.length === 0) err('has a model with an empty id');
    if (seen.has(id)) err(`lists model "${id}" more than once`);
    seen.add(id);
    const base = defaults.get(id);
    if (!base) unknown.push(id);
    const api = route.api ?? base?.api ?? routeApi;
    if (api === undefined) err(`model "${id}" needs an api; the installed catalog does not describe it, so set the route's api to the wire protocol its endpoint speaks`);
    const baseUrl = route.baseURL ?? base?.baseUrl ?? providerBaseUrl;
    if (baseUrl === undefined) err(`model "${id}" needs a baseURL; the installed catalog does not describe this route`);
    const cw = entry.contextWindow ?? base?.contextWindow ?? route.defaultContextWindow;
    if (!Number.isInteger(cw) || cw <= 0) err(`model "${id}" contextWindow must be a positive integer`);
    const mt = entry.maxTokens ?? base?.maxTokens ?? route.defaultMaxTokens;
    if (!Number.isInteger(mt) || mt <= 0) err(`model "${id}" maxTokens must be a positive integer`);
  }
  rows.push({ provider: name, models: entries.length, catalog: [...seen].filter((id) => defaults.has(id)).length, unknown, errors, api: route.api ?? routeApi ?? '(nincs)' });
}

if (asJson) {
  console.log(JSON.stringify({ file: SETTINGS, rows, problems }, null, 2));
} else {
  console.log(`settings: ${SETTINGS}`);
  for (const r of rows) {
    console.log(`${r.provider.padEnd(16)} ${String(r.models).padStart(3)} modell | katalógusban ${String(r.catalog).padStart(3)} | api: ${r.api}${r.errors ? `  ✗ ${r.errors} hiba` : ''}`);
    if (r.unknown.length) console.log(`                 katalóguson kívül: ${r.unknown.join(', ')}`);
  }
  if (problems.length) {
    console.log(`\n${problems.length} hiba:`);
    for (const p of problems) console.log(`  ✗ ${p}`);
  } else {
    console.log('\nMinden route érvényes (a pi-ai adapter elfogadja a mentést).');
  }
}
process.exitCode = problems.length ? 1 : 0;
