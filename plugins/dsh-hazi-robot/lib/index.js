/**
 * Házirobot — DSH host oldali bővítmény.
 *
 * A panel adatait és a beállítás-űrlap mentését szolgálja ki. Nem indít
 * folyamatot a webhookhoz: az a `bot/panel/server.mjs` dolga (külön
 * porton, token mögött). Ez a plugin a bot FÁJLJAIT és az SQLite állapotát
 * olvassa/írja, ezért a panel akkor is működik, ha a webhook-szerver áll.
 *
 * Végpontok:
 *   GET  /hazi-robot/status          futások, FAR-napló, jobok
 *   GET  /hazi-robot/settings        a jelenlegi beállítások (titkok nélkül)
 *   POST /hazi-robot/settings        beállítások mentése
 *   GET  /hazi-robot/avatar.svg      a robot avatarja
 *   POST /hazi-robot/run?job=<id>    egy job azonnali futtatása
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A bot mappája (felülbírálható a HAZIROBOT_DIR környezeti változóval). */
const BOT = resolve(process.env.HAZIROBOT_DIR ?? 'C:\\Szerver\\Deepseek Harness\\bot');

/* ------------------------------ segédfüggvények ---------------------------- */

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/** Írás előtt mentés (a bot saját fájljaihoz nem nyúlunk véletlenül). */
function writeJson(path, data) {
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      copyFileSync(path, `${path}.bak-${stamp}`);
    } catch {
      /* a mentés nem kötelező */
    }
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new Error('túl nagy kérés'));
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const configured = (value) => Boolean(value) && !/^IDE-KERUL/i.test(String(value).trim());

/* ---------------------------------- állapot -------------------------------- */

async function readState() {
  const dbPath = join(BOT, 'state', 'bot.db');
  if (!existsSync(dbPath)) return { runs: [], far: [], error: 'nincs még állapot-adatbázis (futtattál már jobot?)' };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 15').all();
    const far = db.prepare('SELECT * FROM far_ledger ORDER BY id DESC LIMIT 15').all();
    db.close();
    return { runs, far };
  } catch (err) {
    return { runs: [], far: [], error: err.message };
  }
}

function listJobs() {
  const dir = join(BOT, 'jobs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const job = readJson(join(dir, f), null);
      return job ? { id: job.id ?? f.replace(/\.json$/, ''), leiras: job.leiras ?? '', schedule: job.schedule ?? {}, modell: job.modell ?? {} } : null;
    })
    .filter(Boolean);
}

async function handleStatus(_req, res) {
  const state = await readState();
  const cfg = readJson(join(BOT, 'config.json'), {});
  sendJson(res, 200, {
    ok: true,
    bot: {
      dir: BOT,
      exists: existsSync(BOT),
      emailDryRun: cfg.email?.dryRun !== false,
      emailTo: cfg.email?.to ?? [],
      panelPort: cfg.panel?.port ?? 4180,
    },
    jobs: listJobs(),
    runs: state.runs,
    far: state.far,
    stateError: state.error ?? null,
  });
}

/* -------------------------------- beállítások ------------------------------ */

function currentSettings() {
  const cfg = readJson(join(BOT, 'config.json'), {});
  const secrets = readJson(join(BOT, 'secrets.json'), {});
  const job = readJson(join(BOT, 'jobs', 'konkurencia-figyelo.json'), {});
  return {
    ok: true,
    settings: {
      email: {
        from: cfg.email?.from ?? '',
        to: (cfg.email?.to ?? []).join(', '),
        dryRun: cfg.email?.dryRun !== false,
        smtp: {
          host: cfg.email?.smtp?.host ?? '',
          port: cfg.email?.smtp?.port ?? 587,
          secure: String(cfg.email?.smtp?.secure ?? 'false'),
          user: cfg.email?.smtp?.user ?? '',
        },
      },
      far: {
        callbackUrl: cfg.far?.callbackUrl ?? '',
        ertesitesTo: (cfg.far?.ertesitesTo ?? []).join(', '),
      },
      oldalak: (job.oldalak ?? []).map((p) => ({ nev: p.nev ?? '', url: p.url ?? '' })),
      jobSchedule: job.schedule?.kifejezes ?? '0 7 * * 1',
    },
    // A titkokat SOSEM küldjük vissza — csak azt, hogy be vannak-e állítva.
    secretsSet: {
      smtpPassword: configured(secrets.smtpPassword),
      farCallbackSecret: configured(secrets.farCallbackSecret),
      panelToken: configured(secrets.panelToken),
    },
    paths: { bot: BOT, config: join(BOT, 'config.json'), secrets: join(BOT, 'secrets.json') },
  };
}

function handleSettings(_req, res) {
  if (!existsSync(BOT)) return sendJson(res, 500, { ok: false, error: `nincs ilyen mappa: ${BOT}` });
  sendJson(res, 200, currentSettings());
}

function applySettings(body) {
  const cfgPath = join(BOT, 'config.json');
  const secretsPath = join(BOT, 'secrets.json');
  const jobPath = join(BOT, 'jobs', 'konkurencia-figyelo.json');

  const cfg = readJson(cfgPath, {});
  const secrets = readJson(secretsPath, {});
  const job = readJson(jobPath, null);

  const list = (value) =>
    String(value ?? '')
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

  if (body.email) {
    cfg.email = cfg.email ?? {};
    cfg.email.from = body.email.from ?? cfg.email.from ?? '';
    cfg.email.to = list(body.email.to);
    cfg.email.dryRun = body.email.dryRun !== false;
    cfg.email.smtp = {
      ...(cfg.email.smtp ?? {}),
      host: body.email.smtp?.host ?? cfg.email.smtp?.host ?? '',
      port: Number(body.email.smtp?.port ?? cfg.email.smtp?.port ?? 587),
      secure: String(body.email.smtp?.secure ?? cfg.email.smtp?.secure ?? 'false'),
      user: body.email.smtp?.user ?? cfg.email.smtp?.user ?? '',
    };
  }
  if (body.far) {
    cfg.far = cfg.far ?? {};
    if (body.far.callbackUrl) cfg.far.callbackUrl = body.far.callbackUrl;
    cfg.far.ertesitesTo = list(body.far.ertesitesTo);
  }
  writeJson(cfgPath, cfg);

  // Titkok: csak a NEM üres mezőket írjuk felül (így a "beállítva" érték nem
  // tűnik el, ha a felhasználó üresen hagyja a mezőt).
  const secretChanges = [];
  for (const [key, label] of [
    ['smtpPassword', 'SMTP jelszó'],
    ['farCallbackSecret', 'FAR callback titok'],
    ['panelToken', 'panel-token'],
  ]) {
    const value = body.secrets?.[key];
    if (typeof value === 'string' && value.trim() !== '') {
      secrets[key] = value.trim();
      secretChanges.push(label);
    }
  }
  if (secretChanges.length) writeJson(secretsPath, secrets);

  if (job && Array.isArray(body.oldalak)) {
    job.oldalak = body.oldalak
      .map((p) => ({ nev: String(p?.nev ?? '').trim(), url: String(p?.url ?? '').trim() }))
      .filter((p) => p.url);
    if (typeof body.jobSchedule === 'string' && body.jobSchedule.trim()) {
      job.schedule = { ...(job.schedule ?? {}), tipus: 'cron', kifejezes: body.jobSchedule.trim() };
    }
    writeJson(jobPath, job);
  }

  return { ok: true, savedSecrets: secretChanges, settings: currentSettings().settings };
}

async function handleSettingsPost(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    sendJson(res, 200, applySettings(body));
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
}

/* --------------------------------- egyebek --------------------------------- */

/**
 * Az alteregó-logika a botban él (`bot/lib/avatar.mjs`), hogy a robot-panel
 * (4180) és ez a DSH panel pontosan ugyanazt lássa. Lustán, dinamikusan
 * importáljuk, mert a bot mappa lehet, hogy épp nincs a helyén.
 */
let avatarModulePromise = null;
function avatarModule() {
  if (avatarModulePromise === null) {
    const file = join(BOT, 'lib', 'avatar.mjs');
    if (!existsSync(file)) {
      avatarModulePromise = Promise.reject(new Error(`nincs avatar-modul: ${file}`));
    } else {
      avatarModulePromise = import(pathToFileURL(file).href).catch((err) => {
        avatarModulePromise = null; // egy következő kérés újra próbálkozhat
        throw err;
      });
    }
  }
  return avatarModulePromise;
}

async function handleAvatar(req, res, url) {
  try {
    const mod = await avatarModule();
    const svg = mod.readAvatarSvg(url.searchParams.get('alterego') ?? '');
    if (!svg) return sendJson(res, 404, { ok: false, error: 'nincs avatar' });
    res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache', 'content-length': svg.length });
    res.end(svg);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleAlteregok(_req, res) {
  try {
    const mod = await avatarModule();
    sendJson(res, 200, mod.avatarPayload());
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleAlteregoPost(req, res) {
  try {
    const mod = await avatarModule();
    const body = JSON.parse(await readBody(req));
    const saved = mod.setAvatarState(body);
    if (!saved.ok) return sendJson(res, 400, saved);
    sendJson(res, 200, mod.avatarPayload());
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
}

function handleRun(req, res, url) {
  const job = url.searchParams.get('job');
  if (!job || !/^[a-z0-9-]{1,60}$/i.test(job)) return sendJson(res, 400, { ok: false, error: 'MISSING_OR_INVALID_JOB' });
  if (!existsSync(join(BOT, 'run-job.mjs'))) return sendJson(res, 500, { ok: false, error: 'nincs run-job.mjs a bot mappában' });
  const child = spawn(process.execPath, ['--no-warnings', join(BOT, 'run-job.mjs'), job], {
    detached: true,
    stdio: 'ignore',
    cwd: BOT,
  });
  child.unref();
  sendJson(res, 202, { ok: true, message: `${job} elindítva (pid ${child.pid})`, pid: child.pid });
}

function handleLog(req, res, url) {
  const logPath = join(BOT, 'state', 'bot.log');
  if (!existsSync(logPath)) return sendJson(res, 200, { ok: true, lines: [] });
  const limit = Math.min(Number(url.searchParams.get('lines') ?? 40) || 40, 500);
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').slice(-limit).reverse();
  sendJson(res, 200, { ok: true, lines });
}

/* ---------------------------------- plugin --------------------------------- */

function apply(ctx) {
  if (ctx.webServer === undefined) return;

  const route = (path, handler, label) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler }),
      `hazi-robot: ${label}`,
    );

  route('/hazi-robot/status', (req, res) => handleStatus(req, res), 'status');
  route('/hazi-robot/settings', (req, res) =>
    req.method === 'POST' ? handleSettingsPost(req, res) : handleSettings(req, res), 'settings');
  route('/hazi-robot/avatar.svg', (req, res) => handleAvatar(req, res, new URL(req.url ?? '/', 'http://dsh.invalid')), 'avatar');
  route('/hazi-robot/alteregok', (req, res) => handleAlteregok(req, res), 'alteregok');
  route('/hazi-robot/alterego', (req, res) => handleAlteregoPost(req, res), 'alterego');
  route('/hazi-robot/run', (req, res) => handleRun(req, res, new URL(req.url ?? '/', 'http://dsh.invalid')), 'run');
  route('/hazi-robot/log', (req, res) => handleLog(req, res, new URL(req.url ?? '/', 'http://dsh.invalid')), 'log');

  ctx.logger?.info?.(`[hazi-robot] panel route-ok regisztralva (bot: ${BOT})`);
}

const inject = ['webServer'];

export { apply, inject };
export { applySettings, currentSettings, listJobs, BOT };
