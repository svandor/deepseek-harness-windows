#!/usr/bin/env node
/**
 * Helyi OpenAI-kompatibilis fallback proxy a DeepSeek Harness-hez.
 *
 * Miért: a DSH 0.1.5 magja nem vált át automatikusan másik providerre, ha egy
 * route hibára fut (a `retryPolicy` ugyanazon a route-on próbálkozik újra).
 * Ez a proxy egyetlen OpenAI-kompatibilis végpontot ad a DSH-nak, és a
 * beállított lánc szerint próbálkozik: ha az első provider 429/5xx/5xx-szerű
 * hibát ad, megy a következőre — még az első token előtt.
 *
 * Nulla függőség: csak a Node beépített moduljait használja (Node >= 18,
 * a fetch és a ReadableStream miatt). Node 25-tel tesztelve.
 *
 * Végpontok:
 *   POST /v1/chat/completions   stream és nem-stream is
 *   GET  /v1/models             a route-ok egyesített listája (DSH discovery)
 *   GET  /healthz               állapot + lánc
 *
 * Használat:
 *   node proxy.mjs
 *   node proxy.mjs --config masik-config.json --port 4123
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── argumentumok ───────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CONFIG_PATH = path.resolve(HERE, arg('config', 'config.json'));
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const PORT = Number(arg('port', process.env.PROXY_PORT ?? CONFIG.port ?? 4123));
const HOST = arg('host', CONFIG.host ?? '127.0.0.1');
const LOG_PREFIX = '[fallback-proxy]';

// ── segédek ────────────────────────────────────────────────────────────────
function log(...args) {
  process.stdout.write(`${LOG_PREFIX} ${new Date().toISOString()} ${args.join(' ')}\n`);
}

/**
 * Az OpenAI-kompatibilis végpont URL-je.
 * Kezeli azt is, ha a baseURL-t `/v1`-gyel (vagy anélkül) adták meg:
 * így a `https://openrouter.ai/api/v1` és a `https://api.groq.com/openai/v1`
 * ugyanúgy helyes végpontot ad, nem duplázódik a `/v1`.
 */
function completionsUrl(baseURL) {
  const base = String(baseURL).replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/chat/completions`;
}

/**
 * Egy route-bejegyzés feloldása `provider/model` névre.
 * CSAK AZ ELSŐ perjelen hasítunk, mert a modell-id tartalmazhat perjelet
 * (pl. `openrouter/deepseek/deepseek-chat-v3.1:free`) és kettőspontot
 * (pl. `ollama/qwen2.5:7b-instruct`).
 */
function splitTarget(entry, providerIdHint) {
  if (entry && typeof entry === 'object') {
    const model = entry.model;
    if (providerIdHint) return [providerIdHint, model];
    const idx = String(model ?? '').indexOf('/');
    return idx === -1 ? [String(model ?? ''), undefined] : [model.slice(0, idx), model.slice(idx + 1)];
  }
  const idx = String(entry).indexOf('/');
  return idx === -1 ? [String(entry), undefined] : [String(entry).slice(0, idx), String(entry).slice(idx + 1)];
}

function envValue(name) {
  if (!name) return undefined;
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** A config.json providers szekciója + a kornyezeti valtozok feloldasa. */
function resolveProviders() {
  const providers = {};
  for (const [id, def] of Object.entries(CONFIG.providers ?? {})) {
    const apiKey = envValue(def.apiKeyEnv) ?? def.apiKey;
    providers[id] = {
      id,
      label: def.label ?? id,
      baseURL: def.baseURL,
      apiKey,
      apiKeyEnv: def.apiKeyEnv,
      // Helyi szerver (Ollama) placeholder kulccsal is megy.
      optionalKey: def.optionalKey === true,
      models: def.models ?? [],
    };
  }
  return providers;
}

const PROVIDERS = resolveProviders();

// ── kötelező kulcsok a route-okhoz ─────────────────────────────────────────
/**
 * MEGMÉRT HIBA, amit ez a szakasz megszüntet:
 *
 * Ha a folyamat környezetéből hiányoztak a provider-kulcsok (mert a
 * `run-proxy-service.ps1` nélkül indult), akkor a `routeChain()` CSENDBEN
 * kihagyta a felhős providereket, és a `worker` lánc egyetlen elemre
 * csúszott: `ollama/qwen2.5-coder:14b`. A proxy ettől még "működött":
 *
 *   - a kérés 117 másodpercig futott (mért érték),
 *   - a válasz `content`-be csomagolt pszeudo-tool-hívás volt
 *     (`{"name": "get_weather", ...}`), nem valódi `tool_calls`,
 *   - a DSH-nak ez használhatatlan: a delegálás "behal", hibaüzenet nélkül.
 *
 * A helyes viselkedés a HANGOS hiba: amelyik route felhős célt deklarál, az
 * nem eshet vissza a helyi Ollamára. A `requiredAnyEnv` a config.json-ból
 * jön; ha egyetlen felsorolt kulcs sincs meg, a route INDÍTÁSKOR hibát jelez,
 * és a kérése 503-at ad — nem 2 perc csendet.
 *
 * A `local-only` route szándékosan helyi: ott ez a szabály nem érvényes.
 */
const REQUIRED_ENV = CONFIG.requiredAnyEnv ?? {};
const LEGACY_LOCAL_ONLY = new Set(['local-only']);

function requiredEnvFor(routeName) {
  if (LEGACY_LOCAL_ONLY.has(routeName)) return [];
  const list = REQUIRED_ENV[routeName];
  return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n.length > 0) : [];
}

/** Melyik kötelező kulcs hiányzik ehhez a route-hoz? (üres tömb = rendben) */
function missingRequiredEnv(routeName) {
  return requiredEnvFor(routeName).filter((name) => !envValue(name));
}

/**
 * A route kiszolgálhatósága: `ok`, vagy `missing-key` a hiányzó kulcsokkal.
 * Ez a proxy egyetlen "nem tudok dolgozni" állapota — minden más átmeneti.
 */
function routeAvailability(routeName) {
  const missing = missingRequiredEnv(routeName);
  return missing.length === 0 ? { ok: true } : { ok: false, reason: 'missing-key', missing };
}

// ── napi felulbiralat ──────────────────────────────────────────────────────
/**
 * A `dailyOverrides` a `routes` neveit irja felul datum szerint:
 *
 *   "dailyOverrides": {
 *     "2026-09-28": { "worker": ["ollama/qwen2.5-coder:14b"] },
 *     "2026-09-29": { "worker": ["groq/openai/gpt-oss-120b"] }
 *   }
 *
 * Ervenyesites: ha a mai datum (helyi ido) szerepel a szekcioban, az ott
 * megadott route-ok lecserelik az alap lancot. Minden mas a `routes`-bol jon.
 * Ez restarthoz nem nyul: a fajl mentese utan a KOVETKEZO keresre hat.
 *
 * A datum YYYY-MM-DD formaban, helyi idoben ertendo — igy "ma" az, amit a
 * naptar mutat, nem UTC szerinti.
 */
function localDateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function effectiveRoute(routeName) {
  const today = localDateKey();
  const override = CONFIG.dailyOverrides?.[today]?.[routeName];
  if (Array.isArray(override) && override.length > 0) return override;
  // Egy route lehet tomb (celok) vagy objektum (celok + metaadatok).
  const base = (CONFIG.routes ?? {})[routeName] ?? (CONFIG.routes ?? {})[CONFIG.defaultRoute];
  return Array.isArray(base) ? base : base?.targets;
}

/** A napi felulbiralat allapota (a /healthz es a napló szamara). */
function overrideState() {
  const today = localDateKey();
  const day = CONFIG.dailyOverrides?.[today];
  return { date: today, active: day !== undefined, routes: day ? Object.keys(day) : [] };
}

/** Egy route → a probálandó providerek sorrendben (napi felulbirálattal). */
function routeChain(routeName) {
  // Hiányzó kötelező kulcs esetén NINCS lánc: nem esünk vissza a helyire.
  // A hívó (handleChat) 503-at ad, a watchdog pedig hangosan jelez.
  if (!routeAvailability(routeName).ok) return [];

  const targets = effectiveRoute(routeName);
  if (!Array.isArray(targets) || targets.length === 0) return [];

  const chain = [];
  for (const t of targets) {
    const [providerId, model] = splitTarget(t, typeof t === 'object' ? t.provider : undefined);
    const provider = PROVIDERS[providerId];
    if (!provider) {
      log(`WARN ismeretlen provider a lancban: ${providerId}`);
      continue;
    }
    if (!provider.apiKey && !provider.optionalKey) {
      log(`SKIP ${providerId} (nincs kulcs: ${provider.apiKeyEnv ?? '?'})`);
      continue;
    }
    if (!model) {
      log(`WARN nincs modell megadva: ${providerId}`);
      continue;
    }
    chain.push({ provider, model });
  }
  return chain;
}

function routeNames() {
  return Object.keys(CONFIG.routes ?? {});
}

function routeMeta(name) {
  const route = (CONFIG.routes ?? {})[name];
  const targets = effectiveRoute(name) ?? [];
  return {
    targets,
    contextWindow: (Array.isArray(route) ? undefined : route?.contextWindow) ?? 131072,
    maxTokens: (Array.isArray(route) ? undefined : route?.maxTokens) ?? 8192,
  };
}

// ── HTTP válasz segédek ────────────────────────────────────────────────────
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, status, message, type = 'proxy_error') {
  sendJson(res, status, { error: { message, type, code: status } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const limit = (CONFIG.maxRequestBytes ?? 32 * 1024 * 1024);
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`kérés törzs túl nagy (> ${limit} byte)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── upstream hívás ─────────────────────────────────────────────────────────
/**
 * Egy upstream próba. Visszaad: { ok, status, kind, body|stream, abort }.
 * kind: 'json' ha nem-stream, 'stream' ha SSE, 'error' ha hiba.
 */
async function attempt(target, bodyObj, { stream }) {
  const { provider, model } = target;
  const url = completionsUrl(provider.baseURL);
  const controller = new AbortController();
  // KÉT KÜLÖN IDŐKORLÁT:
  //  - connectTimeoutMs: mennyi ideig várunk a válasz FEJLÉCÉRE (halott vagy
  //    nem válaszoló végpont kiszűrése). Ez dönti el a fallbacket.
  //  - stallTimeoutMs: stream közben mennyi csend után adjuk fel (beragadt
  //    generáció). Nem a teljes generálási idő, mert az indokoltan hosszú.
  const connectTimeoutMs = provider.connectTimeoutMs ?? CONFIG.connectTimeoutMs ?? 120000;
  const timer = setTimeout(() => controller.abort(new Error('connect timeout')), connectTimeoutMs);

  const payload = { ...bodyObj, model };
  const headers = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  if (provider.headers) Object.assign(headers, provider.headers);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      // A kulcsot visszük magunkkal: egy upstream átirányítás másik hosztra
      // vinné a provider-kulcsot (és a kérést belső végpontra fordíthatná).
      redirect: 'manual',
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, kind: 'error', reason: `hálózat: ${err?.message ?? err}`, abort: controller };
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    clearTimeout(timer);
    return {
      ok: false,
      kind: 'error',
      status: upstream.status,
      reason: `HTTP ${upstream.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
      abort: controller,
    };
  }

  if (!stream) {
    const text = await upstream.text().catch(() => '');
    clearTimeout(timer);
    return { ok: true, kind: 'json', status: upstream.status, text, abort: controller };
  }

  // Stream: a connect-timer lejárt, a body olvasása közben csend-figyelő veszi át.
  clearTimeout(timer);
  return { ok: true, kind: 'stream', upstream, abort: controller };
}

/** Csend-figyelő: ha a stream N ms-ig nem ad byte-ot, megszakítjuk. */
function makeStallWatcher(target, res, label) {
  const stallTimeoutMs =
    target.provider.stallTimeoutMs ?? CONFIG.stallTimeoutMs ?? 180000;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      log(`STALL ${label}: ${stallTimeoutMs} ms csend, megszakítás`);
      target.controller.abort(new Error('stream stall'));
    }, stallTimeoutMs);
  };
  const disarm = () => clearTimeout(timer);
  arm();
  return { arm, disarm };
}

/** A próba után eldöntjük: van-e értelme a következő providerre váltani? */
function retriable(result) {
  if (result.kind === 'error') return true;
  return false;
}

// ── a kérés kiszolgálása ───────────────────────────────────────────────────
async function handleChat(req, res, bodyObj) {
  const requested = typeof bodyObj.model === 'string' ? bodyObj.model : CONFIG.defaultRoute;
  const chain = routeChain(requested);

  if (chain.length === 0) {
    // Fontos sorrend: a hiányzó kulcs a leggyakoribb ok, és a DSH-nak ezt
    // kell látnia — nem egy 2 perces csendet, majd egy használhatatlan
    // választ. A hibaüzenet megmondja, mit kell telepíteni/elindítani.
    const avail = routeAvailability(requested);
    if (!avail.ok && avail.reason === 'missing-key') {
      const msg =
        `A(z) "${requested}" route nem használható: hiányzik a kötelező kulcs ` +
        `(${avail.missing.join(', ')}). A proxy szándékosan NEM esik vissza a helyi ` +
        `Ollamára, mert az lassú és nem hív toolt. Indítsd a proxyt a kulcsokkal: ` +
        `providers\\run-proxy-service.ps1 (vagy futtasd a watchdogot).`;
      log(`NOKEY ${requested}: ${avail.missing.join(', ')}`);
      sendError(res, 503, msg, 'missing_provider_key');
      return;
    }
    sendError(
      res,
      400,
      `Nincs használható cél a(z) "${requested}" route-hoz. Ellenőrizd a config.json routes/providers szekcióját és a környezeti változókat.`,
      'no_route',
    );
    return;
  }

  const stream = bodyObj.stream === true;
  const tried = [];

  for (let i = 0; i < chain.length; i++) {
    const target = chain[i];
    const label = `${target.provider.id}/${target.model}`;
    const result = await attempt(target, bodyObj, { stream });

    if (retriable(result)) {
      tried.push(`${label} (${result.reason})`);
      log(`FAIL ${label} -> ${result.reason}`);
      continue;
    }

    log(`${i === 0 ? 'HIT ' : 'FALLBACK '}${label}`);

    if (result.kind === 'json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(result.text);
      return;
    }

    // ── SSE átvezetés ──
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();

    const watcher = makeStallWatcher({ provider: target.provider, controller: result.abort }, res, label);

    const onClientClose = () => {
      watcher.disarm();
      result.abort.abort(new Error('kliens lecsatlakozott'));
    };
    res.on('close', onClientClose);

    let sawBytes = false;
    try {
      for await (const chunk of result.upstream.body) {
        sawBytes = true;
        watcher.arm();
        res.write(chunk);
      }
    } catch (err) {
      // A stream már elindult: visszatekerni nem lehet, a hibát jelezzük.
      log(`STREAM-MEGSZAKADT ${label}: ${err?.message ?? err}`);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: `upstream stream hiba: ${err?.message ?? err}`, type: 'upstream_stream_error' } })}\n\n`);
      }
    } finally {
      watcher.disarm();
      res.off('close', onClientClose);
      if (!res.writableEnded) res.end();
    }
    if (!sawBytes) log(`WARN ${label}: a stream nulla byte-tal zarult`);
    return;
  }

  sendError(res, 502, `Minden cél hibára futott a(z) "${requested}" route-on:\n- ${tried.join('\n- ')}`, 'all_targets_failed');
}

async function handleModels(res) {
  // A route-okból építünk listát; így a DSH "Fetch available models"
  // gombja pontosan a választható virtuális modelleket látja.
  const created = Math.floor(Date.now() / 1000);
  const data = routeNames().map((name) => ({
    id: name,
    object: 'model',
    created,
    owned_by: 'fallback-proxy',
  }));
  sendJson(res, 200, { object: 'list', data });
}

function handleHealth(res) {
  const routes = {};
  for (const name of routeNames()) {
    routes[name] = routeChain(name).map((t) => `${t.provider.id}/${t.model}`);
  }
  // A "tud-e dolgozni" kérdésre a válasz: van-e MINDEN route-nak kötelező
  // kulcsa. A worker a subagent célroute-ja, ezért külön is jelezzük.
  const missingKeys = {};
  let allAvailable = true;
  for (const name of routeNames()) {
    const avail = routeAvailability(name);
    if (!avail.ok) {
      missingKeys[name] = avail.missing;
      allAvailable = false;
    }
  }
  sendJson(res, 200, {
    ok: true,
    usable: allAvailable,
    missingKeys,
    workerUsable: routeAvailability('worker').ok && routes.worker.length > 0,
    requiredAnyEnv: REQUIRED_ENV,
    port: PORT,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      baseURL: p.baseURL,
      key: p.apiKey ? 'configured' : p.optionalKey ? 'optional' : 'MISSING',
    })),
    // A napi felulbiralat allapota: ha aktiv, a routes a mai lancot mutatja.
    dailyOverride: overrideState(),
    routes,
  });
}

// ── szerver ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
    handleHealth(res);
    return;
  }

  if (req.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/v1/models') {
    handleModels(res);
    return;
  }

  if (req.method === 'POST' && url.pathname.replace(/\/+$/, '') === '/v1/chat/completions') {
    readBody(req)
      .then((raw) => {
        let bodyObj;
        try {
          // A vezető BOM-ot és whitespace-t eltávolítjuk: egyes kliensek
          // (Windows PowerShell, jegyzettömb) BOM-mal küldik a JSON-t.
          const cleaned = raw.replace(/^\uFEFF/, '').trim();
          bodyObj = JSON.parse(cleaned);
        } catch {
          sendError(res, 400, 'Érvénytelen JSON a kérés törzsében', 'invalid_json');
          return;
        }
        return handleChat(req, res, bodyObj);
      })
      .catch((err) => {
        if (!res.headersSent) sendError(res, 500, String(err?.message ?? err), 'proxy_internal');
      });
    return;
  }

  sendError(res, 404, `Ismeretlen végpont: ${req.method} ${url.pathname}`, 'not_found');
});

server.listen(PORT, HOST, () => {
  log(`figyel: http://${HOST}:${PORT}`);
  log(`config: ${CONFIG_PATH}`);
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const state = p.apiKey ? 'kulcs OK' : p.optionalKey ? 'kulcs opcionális' : `HIÁNYZIK (${p.apiKeyEnv})`;
    log(`  provider ${id}: ${p.baseURL} [${state}]`);
  }
  for (const name of routeNames()) {
    const chain = routeChain(name).map((t) => `${t.provider.id}/${t.model}`);
    const req = requiredEnvFor(name);
    const avail = routeAvailability(name);
    const note = req.length === 0
      ? ''
      : avail.ok
        ? ' [kotelezo kulcs OK]'
        : ` [HIANYZO KULCS: ${avail.missing.join(', ')}]`;
    log(`  route ${name}: ${chain.length ? chain.join(' -> ') : '(nincs használható cél)'}${note}`);
  }
  // A napi felulbiralat kiirasa: ha aktiv, ez FELULIRJA a fenti lancokat.
  const ov = overrideState();
  if (ov.active) {
    log(`  NAPI FELULBIRALAT AKTIV (${ov.date}): ${ov.routes.join(', ')}`);
    log('  -> a fenti route-ok helyett a dailyOverrides lancai ervenyesek a mai napon');
  } else {
    log(`  napi felulbiralat: nincs a mai napra (${ov.date})`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`HIBA: a ${PORT} port már foglalt. Indítsd másik porttal: node proxy.mjs --port 4124`);
  } else {
    log(`HIBA: ${err?.message ?? err}`);
  }
  process.exitCode = 1;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — leállítás`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
