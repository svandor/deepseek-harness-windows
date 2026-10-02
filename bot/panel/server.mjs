#!/usr/bin/env node
/**
 * Házirobot — webhook-fogadó és állapotpanel.
 *
 * Ez váltja ki a Grok Bot "local-exec hídját": a weboldal (Laravel) ide küldi a
 * bejövő kérést, a bot pedig elindítja a hozzá tartozó integrációs modult.
 *
 * Végpontok:
 *   POST <a leíróban megadott útvonal>   integrációs webhook (token kell)
 *   GET  /                robot-konzol (beszélgetés + parancssáv + állapot)
 *   GET  /status.json     gépi állapot
 *   GET  /avatar.svg      a robot avatarja
 *   POST /run?job=<id>    job indítása a panelról
 *   POST /command         determinisztikus parancs (0 token)
 *   POST /ask             beszélgetés a robottal (ingyenes lánc)
 *   GET  /settings        beállítások (POST: mentés)
 *   GET  /log             a napló utolsó sorai
 *
 * Használat: node bot/panel/server.mjs [--port=4180]
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { logger } from '../lib/log.mjs';
import { openState, recentRuns, farLedgerRecent } from '../lib/state.mjs';
import { runAgent } from '../lib/agent.mjs';
import { sendMail } from '../lib/mail.mjs';
import { avatarPayload, readAvatarSvg, setAvatarState } from '../lib/avatar.mjs';
import { loadExtensions, hasWatcher, extensionFile, label as extLabel } from '../lib/extensions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT = resolve(join(HERE, '..'));
const cfg = loadConfig();
openState(cfg.paths.state);
const log = logger('webhook');

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? cfg.panel.port);
const HOST = cfg.panel.host;
const TOKEN = cfg.panel.token;
const INBOX = join(cfg.paths.state, '..', 'inbox');
mkdirSync(INBOX, { recursive: true });

/**
 * Telepítésenkénti integrációs modulok.
 *
 * MIÉRT: a panel ÁLTALÁNOS (konzol, jobok, avatarok, napló, beállítások), a
 * konkrét bekötések viszont gépenkéntiek és privátak. Ezért a panel nem tud
 * feladatneveket: a `bot/extensions.json` (gitignore-olt) mondja meg, mi van
 * telepítve, és a felület abból épül. Modul nélkül egyetlen feladatnév sem
 * szerepel a kódban vagy a felületen.
 */
const EXTENSIONS = loadExtensions(BOT);
const WATCHER = hasWatcher(EXTENSIONS);
/** Az első webhookot fogadó integráció (a fejléc-jelvényhez). */
const WEBHOOK_EXT = EXTENSIONS.find((e) => typeof e.webhook === 'string' && e.webhook.length > 0) ?? null;

/**
 * A panel témája (világos/sötét).
 *
 * MIÉRT A SZERVEREN: a robot panel a 4180-as porton, külön originen fut, ezért
 * nem látja a DSH panel témabeállítását (az a 3080 localStorage-ában van). A
 * DSH `dsh-ui-extras` panelje a témaváltáskor a HOSTON át értesíti ezt a
 * szervert (`POST /theme`), így minden felület egyszerre vált.
 */
const THEME_FILE = join(BOT, 'state', 'panel-theme.txt');
function readPanelTheme() {
  try {
    return readFileSync(THEME_FILE, 'utf8').trim() === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
function savePanelTheme(value) {
  try {
    mkdirSync(dirname(THEME_FILE), { recursive: true });
    writeFileSync(THEME_FILE, value === 'light' ? 'light' : 'dark', 'ascii');
  } catch {
    /* az írás nem kötelező */
  }
}
let panelTheme = readPanelTheme();

function authorized(req, url) {
  if (!TOKEN) return true; // token nélkül csak helyi használatra; élesben kötelező beállítani
  const header = req.headers['x-bot-token'];
  return header === TOKEN || url.searchParams.get('token') === TOKEN;
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) reject(new Error('tul nagy payload'));
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Egy integrációs modul folyamatának indítása külön folyamatban.
 *
 * A webhook azonnal válaszol, a feldolgozás a háttérben fut. A modul útvonalát a
 * `bot/extensions.json` adja meg (`orchestrator`), a bot mappához képest.
 */
function startExtensionJob(extension, payloadPath) {
  const script = extensionFile(BOT, extension, 'orchestrator');
  if (!script) return null;
  const child = spawn(process.execPath, [script, `--payload=${payloadPath}`], {
    detached: true,
    stdio: 'ignore',
    cwd: BOT,
  });
  child.unref();
  return child.pid;
}

function startSimpleJob(jobId) {
  const child = spawn(process.execPath, [join(BOT, 'run-job.mjs'), jobId], { detached: true, stdio: 'ignore', cwd: BOT });
  child.unref();
  return child.pid;
}

/* --------------------------------- panel ---------------------------------- */

/**
 * A beállítások olvasása/írása a DSH panel logikájával (közös forrás).
 *
 * A `plugins/dsh-hazi-robot/lib/index.js` exportálja ezt a két függvényt, és
 * ugyanazt a bot-mappát használja (HAZIROBOT_DIR vagy az alapértelmezés), ezért
 * nem duplikáljuk a szabályokat. Ha a plugin nincs meg, a panel csak olvasható.
 */
let settingsModuleCache;
async function loadSettingsModule() {
  if (settingsModuleCache !== undefined) return settingsModuleCache;
  try {
    const mod = await import(pathToFileURL(join(BOT, '..', 'plugins', 'dsh-hazi-robot', 'lib', 'index.js')).href);
    settingsModuleCache = mod;
  } catch (err) {
    log.warn(`a beállítás-modul nem tölthető be (${err.message}) — a panel csak olvasható`);
    settingsModuleCache = null;
  }
  return settingsModuleCache;
}

/* ------------------------------ robot-konzol ------------------------------- */

/** A job-definíciók listája (a panel és a konzol is ezt használja). */
function jobsList() {
  if (!existsSync(cfg.paths.jobs)) return [];
  return readdirSync(cfg.paths.jobs)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const job = JSON.parse(readFileSync(join(cfg.paths.jobs, f), 'utf8').replace(/^\uFEFF/, ''));
        return {
          id: job.id ?? f.replace(/\.json$/, ''),
          leiras: job.leiras ?? '',
          schedule: job.schedule ?? {},
          oldalak: Array.isArray(job.oldalak) ? job.oldalak.length : undefined,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Rövid állapot-összefoglaló a modellnek (és a konzolnak). */
function contextSummary() {
  const jobs = jobsList();
  const runs = recentRuns(5);
  const far = farLedgerRecent(5);
  return [
    `Jobok (${jobs.length}): ${jobs.map((j) => `${j.id} [${j.schedule.kifejezes ?? j.schedule.tipus ?? '-'}]`).join(', ') || 'nincs'}`,
    `Utolsó futások: ${runs.map((r) => `${r.job_id}=${r.status} (${String(r.started_at).slice(0, 16).replace('T', ' ')})`).join('; ') || 'nincs'}`,
    `Integrációs napló: ${far.length} friss sor; utolsó: ${far[0] ? `${far[0].fazis}/${far[0].status} (${String(far[0].ts).slice(0, 16).replace('T', ' ')})` : 'nincs'}`,
    `E-mail: ${cfg.email.dryRun ? 'száraz futás (nem küld)' : 'éles küldés'}; címzettek: ${(cfg.email.to ?? []).join(', ') || 'nincs beállítva'}`,
  ].join('\n');
}

/**
 * Melyik job tartja nyilván a figyelt oldalakat?
 *
 * MIÉRT NEM BEÉGETVE: a konkrét job neve telepítésenkénti adat, nem tartozik a
 * nyilvános kódra. A `bot/extensions.json` `figyeloJob` mezője mondja meg; ha
 * nincs ilyen, az oldal-funkciók egyszerűen nem használhatók.
 */
function watcherJobId() {
  const ext = EXTENSIONS.find((e) => typeof e.figyeloJob === 'string' && e.figyeloJob.length > 0);
  return ext ? ext.figyeloJob : null;
}

/** Az integrációs modulok saját parancsai (a leíró chip.parancs mezőjéből, / nélkül). */
function extCommands() {
  return EXTENSIONS
    .map((e) => (e.chip && e.chip.parancs ? String(e.chip.parancs).replace(/^\//, '') : null))
    .filter(Boolean);
}
function watchedPages() {
  const id = watcherJobId();
  if (!id) return [];
  try {
    const job = JSON.parse(readFileSync(join(cfg.paths.jobs, `${id}.json`), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(job.oldalak) ? job.oldalak : [];
  } catch {
    return [];
  }
}

function addWatchedPage(nev, url) {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, text: 'érvénytelen URL (http/https kell)' };
  const id = watcherJobId();
  if (!id) return { ok: false, text: 'ezen a telepítésen nincs oldalfigyelő modul' };
  const path = join(cfg.paths.jobs, `${id}.json`);
  const job = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  job.oldalak = Array.isArray(job.oldalak) ? job.oldalak : [];
  if (job.oldalak.some((p) => p.url === url)) return { ok: false, text: 'ez az oldal már figyelve van' };
  copyFileSync(path, `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  job.oldalak.push({ nev: nev || url, url });
  writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  log.info(`figyelt oldal felvéve: ${nev || url} -> ${url}`);
  return { ok: true, text: `felvéve: ${nev || url} (${url}); most ${job.oldalak.length} oldal van figyelve` };
}

function logTail(n = 20) {
  const path = join(BOT, 'state', 'bot.log');
  if (!existsSync(path)) return '(nincs még napló)';
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .slice(-Math.max(1, Math.min(200, n)))
    .map((line) => {
      try {
        const e = JSON.parse(line);
        return `${String(e.ts).slice(11, 19)} [${e.level}] ${e.scope}: ${e.message}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function statusText() {
  const runs = recentRuns(5);
  const far = farLedgerRecent(5);
  return [
    contextSummary(),
    '',
    'Futások:',
    ...runs.map((r) => `  ${String(r.started_at).slice(0, 16).replace('T', ' ')}  ${r.job_id}  ${r.status}  ${(r.detail ?? '').slice(0, 60)}`),
    '',
    'Integrációs napló:',
    ...far.map((l) => `  ${String(l.ts).slice(0, 16).replace('T', ' ')}  ${l.jelentkezes_id ?? '-'}  ${l.fazis ?? '-'}  ${l.status}`),
  ].join('\n');
}

/** Egy akció végrehajtása (a modell kérésére vagy parancsból). */
async function executeAction(action, params = {}, { approved = false } = {}) {
  switch (action) {
    case 'allapot':
      return { ok: true, text: statusText() };
    case 'integracio_naplo': {
      const far = farLedgerRecent(10);
      return {
        ok: true,
        text: far.length
          ? far.map((l) => `${String(l.ts).slice(0, 16).replace('T', ' ')} ${l.jelentkezes_id ?? '-'} ${l.fazis ?? '-'} ${l.status} Σ ${l.sigma_before ?? '?'}→${l.sigma_after ?? '?'}`).join('\n')
          : 'Az integrációs napló üres (még nem futott beküldés).',
      };
    }
    case 'futtat_job': {
      const job = String(params.job ?? '').trim();
      if (!jobsList().some((j) => j.id === job)) {
        return { ok: false, text: `nincs ilyen job: ${job || '(üres)'}. Elérhető: ${jobsList().map((j) => j.id).join(', ')}` };
      }
      const pid = startSimpleJob(job);
      return { ok: true, text: `${job} elindítva (pid ${pid}); az eredmény a következő frissítésnél látszik` };
    }
    case 'naplo':
      return { ok: true, text: logTail(Number(params.sor ?? params.n ?? 20) || 20) };
    case 'oldalak_listaja': {
      const pages = watchedPages();
      return { ok: true, text: pages.length ? pages.map((p, i) => `${i + 1}. ${p.nev} — ${p.url}`).join('\n') : 'Nincs figyelt oldal.' };
    }
    case 'oldal_hozzaadas':
      return addWatchedPage(String(params.nev ?? '').trim(), String(params.url ?? '').trim());
    case 'email_teszt': {
      const cimzett = String(params.cimzett ?? '').trim() || (cfg.email.to ?? [])[0];
      if (!cimzett) return { ok: false, text: 'nincs címzett (sem a kérésben, sem a beállításokban)' };
      const res = await sendMail(
        { ...cfg.email.smtp },
        {
          from: cfg.email.from,
          to: [cimzett],
          subject: '[Házirobot] teszt e-mail',
          text: `Ez egy teszt üzenet a Házirobottól.\n\nIdőpont: ${new Date().toLocaleString('hu-HU')}\nÁllapot:\n${contextSummary()}`,
          kind: 'teszt',
        },
        { dryRun: cfg.email.dryRun, outboxDir: cfg.paths.outbox, log: (m) => log.info(m) },
      );
      return {
        ok: true,
        text: res.dryRun
          ? `száraz futás: a levél nem ment ki, csak fájlba került (${res.path}). Élesítés: a Beállítások fülön kapcsold ki a száraz futást.`
          : `teszt e-mail elküldve: ${cimzett}`,
      };
    }
    default:
      return { ok: false, text: `ismeretlen akció: ${action}` };
  }
}

/** Parancs-normalizálás: kisbetű + ékezetek lehántása (a `/segít` = `/segit`). */
function normCommand(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Determinisztikus parancssáv: `/állapot`, `/futtat <job>`, `/oldal <név> <url>`… */
async function handleCommand(body) {
  const raw = String(body.text ?? '').trim();
  const line = raw.replace(/^\//, '');
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  // Ékezetfüggetlen összehasonlítás: a `segít`, `segit` és `segÃt` is ugyanaz.
  const c = normCommand(cmd);

  if (!c) return { ok: false, reply: 'Üres parancs. Írd be: `/segít` a listához.' };
  if (['segít', 'segit', 'help', '?'].includes(c)) {
    return {
      ok: true,
      reply: [
        'Elérhető parancsok:',
        '  /állapot — a robot állapota (jobok, futások, FAR)',
        '  /futtat <job> — egy job azonnali futtatása',
        '  /napló [sor] — a napló utolsó sorai',
        '  /oldal <név> <url> — figyelt oldal felvétele',
        '  /oldalak — a figyelt oldalak listája',
        ...extCommands().map((k) => '  /' + k + ' — integrációs napló'),
        '  /email <cím> — teszt e-mail (jóváhagyással)',
        '',
        'Ha nem perjellel kezded, a robottal beszélgetsz (ingyenes modell-lánc).',
      ].join('\n'),
    };
  }
  if (['állapot', 'allapot', 'status'].includes(c)) return { ok: true, reply: statusText() };
  if (extCommands().includes(c)) return executeAction('integracio_naplo').then((r) => ({ ...r, reply: r.text }));
  if (['napló', 'naplo', 'log'].includes(c)) {
    const n = Number(arg) || 20;
    return { ok: true, reply: logTail(n) };
  }
  if (['oldalak', 'pages'].includes(c)) return executeAction('oldalak_listaja').then((r) => ({ ...r, reply: r.text }));
  if (['oldal', 'page'].includes(c)) {
    const parts = arg.split(/\s+/);
    const url = parts.find((p) => /^https?:\/\//i.test(p)) ?? '';
    const nev = parts.filter((p) => p !== url).join(' ');
    const r = addWatchedPage(nev, url);
    return { ...r, reply: r.text };
  }
  if (['futtat', 'run'].includes(c)) {
    const r = await executeAction('futtat_job', { job: arg.trim() });
    return { ...r, reply: r.text };
  }
  if (['email', 'mail'].includes(c)) {
    return {
      ok: true,
      reply: `Az e-mail küldés kockázatos művelet — jóváhagyást kérek.`,
      needsApproval: { action: 'email_teszt', params: { cimzett: arg.trim() } },
    };
  }
  return { ok: false, reply: `Ismeretlen parancs: /${cmd}. Írd be: \`/segít\`.` };
}

/** A konzol beszélgetése: a modell kérhet akciót, mi végrehajtjuk. */
async function handleAsk(body) {
  // Jóváhagyott művelet közvetlen végrehajtása.
  if (body.approve && typeof body.approve.action === 'string') {
    const r = await executeAction(body.approve.action, body.approve.params ?? {}, { approved: true });
    return { ok: r.ok, reply: r.text, approved: true };
  }

  const text = String(body.text ?? '').trim();
  if (!text) return { ok: false, reply: 'Üres üzenet.' };

  const res = await runAgent({
    cfg,
    rootDir: BOT,
    text,
    history: Array.isArray(body.history) ? body.history : [],
    ctxSummary: contextSummary(),
    log: (m) => log.info(m),
    execute: (action, params, opts) => executeAction(action, params, opts),
  });

  return {
    ok: res.ok !== false,
    reply: res.reply,
    steps: res.steps ?? [],
    needsApproval: res.needsApproval,
    tokens: { in: res.tokensIn ?? 0, out: res.tokensOut ?? 0 },
  };
}

/**
 * HTML-escape a SZERVER-oldali sablon-kifejezésekhez.
 *
 * MIÉRT KÜLÖN: a panel HTML-je sablon-stringben készül, és a benne lévő
 * ` + "" + `esc()` + "" + ` a KLIENS szkriptjében él — a szerver-oldali ` + "" + `` + "" + ` kifejezésekből
 * nem érhető el. A kettőt nem szabad összekeverni: ez a függvény a szerveren fut.
 */
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function panelHtml() {
  const jobs = existsSync(cfg.paths.jobs)
    ? readdirSync(cfg.paths.jobs).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [];
  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><title>Házirobot</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; --bg:#0f1216; --panel:#151a21; --border:#2a3541; --text:#e7ecf1; --dim:#8b98a8; }
  /* Világos téma: ugyanazok a változók, más értékekkel. A váltás a
     <body class="light">-tal történik, és localStorage-ban marad meg. */
  body.light { color-scheme: light; --bg:#f2f5f9; --panel:#ffffff; --border:#d3dae3; --text:#1b2430; --dim:#5b6878; }
  body.light header { background:linear-gradient(180deg,#ffffff,#eaeff5); }
  body.light th, body.light td { border-bottom-color:#e4e9ef; }
  body.light button.act { background:#e8eef5; border-color:#c8d3df; }
  body.light button.act:hover { background:#dde5ef; }
  body.light .bubble.user { background:#dbeafe; border-color:#bfdbfe; }
  body.light .bubble.robot { background:#f8fafc; }
  body.light .approval { background:#fef7e0; }
  body.light .avcard:hover { background:#eef2f7; }
  /* A fix állapotszínek világos háttéren halványak lennének: sötétebb párjuk. */
  body.light .ok { color:#15803d; }
  body.light .warn { color:#b45309; }
  body.light .err { color:#b91c1c; }
  body.light select option { background:#ffffff; color:#1b2430; }
  body.light .iconbtn:hover { border-color:#8fa3b8; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,Segoe UI,sans-serif; background:var(--bg); color:var(--text); }
  header { display:flex; gap:18px; align-items:center; padding:16px 20px; background:linear-gradient(180deg,#171d25,#12171d); border-bottom:1px solid var(--border); }
  header h1 { margin:0 0 2px; font-size:20px; }
  .sub { color:var(--dim); font-size:12px; }
  .badge { display:inline-block; padding:1px 7px; border:1px solid var(--border); border-radius:10px; font-size:11px; color:var(--dim); }
  nav { display:flex; gap:6px; padding:10px 20px 0; }
  nav button { background:transparent; color:var(--dim); border:1px solid transparent; border-bottom:none; border-radius:8px 8px 0 0; padding:6px 14px; cursor:pointer; font-size:13px; }
  nav button.active { color:var(--text); background:var(--panel); border-color:var(--border); }
  main { padding:16px 20px 28px; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); align-items:start; }
  section { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  section h3 { margin:0 0 10px; font-size:14px; color:var(--text); }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { text-align:left; padding:5px 8px; border-bottom:1px solid #1e2530; }
  th { color:var(--dim); font-weight:600; }
  .ok { color:#4ade80; } .warn { color:#fbbf24; } .err { color:#f87171; } .dim { color:var(--dim); }
  button.act { background:#22303f; color:var(--text); border:1px solid #33475c; border-radius:6px; padding:4px 10px; cursor:pointer; font-size:12px; }
  button.act:hover { background:#2b3c4e; }
  button.primary { background:#2b6cb0; color:#fff; border:none; border-radius:6px; padding:7px 16px; cursor:pointer; font-size:13px; }
  label { display:block; color:var(--dim); font-size:11.5px; margin:10px 0 3px; }
  input[type=text], input[type=password], input[type=number] { width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 9px; font-size:12.5px; }
  .row { display:flex; gap:8px; }
  .note { color:var(--dim); font-size:11.5px; margin-top:8px; }
  .msg { font-size:12px; margin-left:10px; }
  .hidden { display:none; }
  .console { display:flex; flex-direction:column; gap:10px; height:calc(100vh - 235px); min-height:340px; }
  .chat { flex:1 1 auto; overflow-y:auto; background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .bubble { max-width:90%; padding:8px 11px; border-radius:10px; white-space:pre-wrap; word-break:break-word; font-size:12.5px; }
  .bubble.user { align-self:flex-end; background:#22303f; border:1px solid #33475c; }
  .bubble.robot { align-self:flex-start; background:#12171d; border:1px solid var(--border); }
  .bubble.sys { align-self:center; color:var(--dim); font-size:11.5px; background:transparent; border:none; }
  .bubble .who { display:block; font-size:10px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .inputrow { display:flex; gap:8px; }
  .inputrow input { flex:1; }
  .approval { background:#1d2530; border:1px solid #8a6d1f; border-radius:10px; padding:10px 12px; display:flex; gap:10px; align-items:center; font-size:12.5px; }
  select { background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:3px 6px; font-size:12px; }
  .avatarbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  .avatarbar label { margin:0; display:inline-flex; gap:5px; align-items:center; }
  #avatar-panel { padding:12px 20px 0; }
  .avgrid { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(116px,1fr)); }
  .avcard { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:8px 6px; cursor:pointer; color:var(--text); text-align:center; font:inherit; display:flex; flex-direction:column; align-items:center; gap:3px; }
  .avcard:hover { border-color:#3f5568; background:#1b2530; }
  .avcard.active { border-color:#4ade80; box-shadow:inset 0 0 0 1px #4ade80; }
  .avcard img { display:block; height:88px; width:auto; }
  .avcard .n { font-size:11.5px; font-weight:600; }
  .avcard .s { font-size:10px; color:var(--dim); line-height:1.25; }
  .avcard .m { font-size:9.5px; color:var(--dim); opacity:.75; }
  /* Eszközsáv a fejlécben: frissítés, újraindítás, téma, nyelv — ugyanaz a
     minta, mint a többi panelen (ikon + tooltip). */
  .tools { display:flex; gap:6px; align-items:flex-start; }
  .iconbtn { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:7px; padding:5px 9px; cursor:pointer; font-size:14px; line-height:1; }
  .iconbtn:hover { border-color:#3f5568; }
  .iconbtn:disabled { opacity:.45; cursor:not-allowed; }
</style></head>
<body>
<header>
  <img id="avatar" src="/avatar.svg" width="96" height="120" alt="Házirobot">
  <div style="flex:1">
    <h1><span data-i18n="appName">Házirobot</span> <span class="badge" id="avatar-nev">…</span></h1>
    <div class="sub"><span data-i18n="subtitle">helyi ügynök · önálló felület</span> · <span id="clock">${new Date().toLocaleString('hu-HU')}</span></div>
    <div style="margin-top:6px">
      <span class="badge" id="badge-webhook"${WEBHOOK_EXT
        ? ' data-badge-hu="' + escHtml(extLabel(WEBHOOK_EXT.badge, 'hu')) + '" data-badge-en="' + escHtml(extLabel(WEBHOOK_EXT.badge, 'en')) + '"'
        : ' data-i18n="badgeNoModule"'}>${WEBHOOK_EXT ? escHtml(extLabel(WEBHOOK_EXT.badge, 'hu')) : 'webhook: nincs privát modul'}</span>
      <span class="badge" id="badge-mail">e-mail: —</span>
      <span class="badge" id="badge-dry">—</span>
    </div>
    <div class="avatarbar">
      <button class="act" id="avatar-open" data-i18n="avatarSwitch" onclick="toggleAvatarGrid()">🎭 Alteregó váltás</button>
      <label class="dim"><span data-i18n="autoSwitch">Automatikus váltogatás</span>:
        <select id="avatar-auto" onchange="setAuto(this.value)"></select>
      </label>
    </div>
  </div>
  <div class="tools">
    <button class="iconbtn" id="btn-refresh" data-i18n-title="tipRefresh" onclick="doRefresh()">⟳</button>
    <button class="iconbtn" id="btn-restart" data-i18n-title="tipRestart" onclick="doRestart()">⭯</button>
    <button class="iconbtn" id="btn-theme" data-i18n-title="tipTheme" onclick="toggleTheme()">🌙</button>
    <button class="iconbtn" id="btn-lang" data-i18n-title="tipLangToEn" onclick="toggleLang()">HU</button>
  </div>
</header>
<div id="avatar-panel" class="hidden"><div class="avgrid" id="avatar-grid"></div></div>
<nav>
  <button id="tab-konzol" class="active" data-i18n="tabConsole" onclick="showTab('konzol')">Konzol</button>
  <button id="tab-status" data-i18n="tabStatus" onclick="showTab('status')">Állapot</button>
  <button id="tab-settings" data-i18n="tabSettings" onclick="showTab('settings')">Beállítások</button>
  <button id="tab-log" data-i18n="tabLog" onclick="showTab('log')">Napló</button>
</nav>
<main>
  <div id="view-konzol">
    <div class="console">
      <div id="chat" class="chat"></div>
      <div id="approval"></div>
      <div class="chips">
        <button class="act" data-i18n="chipStatus" onclick="chip('/állapot')">Állapot</button>
        <button class="act" data-i18n="chipLog30" onclick="chip('/napló 30')">Napló 30</button>
        <button class="act" data-i18n="chipPages" onclick="chip('/oldalak')">Figyelt oldalak</button>${EXTENSIONS.filter((e) => e.chip && e.chip.parancs).map((e) =>
          '<button class="act ext-chip" data-hu="' + escHtml(extLabel(e.chip, 'hu')) + '" data-en="' + escHtml(extLabel(e.chip, 'en'))
          + '" onclick="chip(\'' + escHtml(e.chip.parancs) + '\')">' + escHtml(extLabel(e.chip, 'hu')) + '</button>').join('')}
        <button class="act" data-i18n="chipHelp" onclick="chip('/segít')">Segít</button>
      </div>
      <div class="inputrow">
        <input id="msg" type="text" data-i18n-placeholder="inputPlaceholder" placeholder="Írj a robotnak, vagy adj parancsot (/állapot, /futtat <job>, /oldal <név> <url>)…"
               onkeydown="if (event.key === 'Enter') send()">
        <button class="primary" id="send" data-i18n="send" onclick="send()">Küld</button>
      </div>
      <div class="note" id="hint" data-i18n="consoleHint">A perjellel kezdett sor parancs (nincs modellhívás); minden más beszélgetés a robottal, ingyenes modell-láncon.</div>
    </div>
  </div>

  <div id="view-status" class="hidden">
    <div class="grid">
      <section>
        <h3 data-i18n="jobsTitle">Jobok</h3>
        <div id="jobs"></div>
      </section>
      <section>
        <h3 data-i18n="runsTitle">Utolsó futások</h3>
        <table><thead><tr><th data-i18n="thJob">job</th><th data-i18n="thStarted">kezdés</th><th data-i18n="thStatus">állapot</th><th data-i18n="thDetail">részlet</th></tr></thead><tbody id="runs"></tbody></table>
      </section>
      <section style="grid-column:1/-1">
        <h3 data-i18n="farTitle">Integrációs napló (audit)</h3>
        <table><thead><tr><th data-i18n="thTime">idő</th><th data-i18n="thApplicant">jelentkezés</th><th data-i18n="thCourse">képzés</th><th data-i18n="thType">típus</th><th data-i18n="thPhase">fázis</th><th>Σ</th><th data-i18n="thStatus">állapot</th><th data-i18n="thDetail">részlet</th></tr></thead><tbody id="far"></tbody></table>
      </section>
    </div>
  </div>

  <div id="view-settings" class="hidden">
    <div class="grid">
      <section>
        <h3 data-i18n="setEmailTitle">E-mail (a riportok kimenete)</h3>
        <label data-i18n="setFrom">Feladó cím</label><input type="text" id="s-from">
        <label data-i18n="setTo">Címzettek (vesszővel)</label><input type="text" id="s-to">
        <div class="row">
          <div style="flex:1"><label>SMTP host</label><input type="text" id="s-host"></div>
          <div style="width:90px"><label>Port</label><input type="text" id="s-port"></div>
          <div style="width:110px"><label data-i18n="setTls">TLS (false/true)</label><input type="text" id="s-secure"></div>
        </div>
        <label data-i18n="setSmtpUser">SMTP felhasználó</label><input type="text" id="s-user">
        <label id="lbl-smtp-pass" data-i18n="setSmtpPass">SMTP jelszó</label><input type="password" id="s-pass" data-i18n-placeholder="setSecretPlaceholder" placeholder="(üresen hagyva nem változik)">
        <label style="display:flex;align-items:center;gap:6px;margin-top:12px;color:var(--text)">
          <input type="checkbox" id="s-dry" style="width:auto"> <span data-i18n="setDryRun">Száraz futás (nem küld e-mailt)</span>
        </label>
      </section>
      <section>
        <h3 data-i18n="setWebhookTitle">Webhook</h3>
        <label id="lbl-panel-token" data-i18n="setPanelToken">Webhook panel-token</label><input type="password" id="s-panel-token" data-i18n-placeholder="setSecretPlaceholder" placeholder="(üresen hagyva nem változik)">
        <div class="note" data-i18n="setSecretsNote">A titkok a bot/secrets.json fájlba kerülnek (a .gitignore-ban), és soha nem kerülnek vissza a böngészőbe.</div>
      </section>
      ${EXTENSIONS.map(function (e) {
        var mezok = Array.isArray(e.beallitasok) ? e.beallitasok : [];
        var titkok = Array.isArray(e.titkok) ? e.titkok : [];
        if (mezok.length === 0 && titkok.length === 0) return '';
        return '<section><h3>' + escHtml(extLabel(e.nev, 'hu')) + '</h3>'
          + mezok.map(function (f) {
              return '<label class="ext-label" data-hu="' + escHtml(f.cimkeHu || f.utvonal) + '" data-en="' + escHtml(f.cimkeEn || f.cimkeHu || f.utvonal) + '">'
                + escHtml(f.cimkeHu || f.utvonal) + '</label><input type="text" data-ext="' + escHtml(f.utvonal) + '">';
            }).join('')
          + titkok.map(function (s) {
              return '<label class="ext-label" data-hu="' + escHtml(s.cimkeHu || s.kulcs) + '" data-en="' + escHtml(s.cimkeEn || s.cimkeHu || s.kulcs) + '">'
                + escHtml(s.cimkeHu || s.kulcs) + '</label><input type="password" data-ext-secret="' + escHtml(s.kulcs)
                + '" data-i18n-placeholder="setSecretPlaceholder" placeholder="(üresen hagyva nem változik)">';
            }).join('')
          + '</section>';
      }).join('')}
      ${WATCHER ? '<section>'
          + '<h3 data-i18n="setWatchTitle">Figyelt oldalak</h3>'
          + '<div id="pages"></div>'
          + '<label data-i18n="setCron">Ütemezés (cron: perc óra nap hónap hét-napja)</label><input type="text" id="s-cron">'
          + '</section>' : ''}
    </div>
    <div style="margin-top:16px">
      <button class="primary" onclick="saveSettings()" data-i18n="saveSettings">Beállítások mentése</button>
      <span class="msg" id="save-msg"></span>
    </div>
  </div>

  <div id="view-log" class="hidden">
    <section><h3 data-i18n="logTitle">Napló (utolsó 80 sor)</h3><pre id="log" class="dim" style="white-space:pre-wrap;font-size:12px;margin:0"></pre></section>
  </div>
</main>
<script>
/* ------------------------------ nyelv és téma ------------------------------ */
/* A panel minden szövege innen jön. A HTML statikus szövegeit a data-i18n,
   data-i18n-title és data-i18n-placeholder attribútumok jelölik; a dinamikus
   részek a t() függvényt hívják. A választás localStorage-ban marad meg. */
var I18N = {
  hu: {
    appName: 'Házirobot',
    subtitle: 'helyi ügynök · önálló felület',
    avatarSwitch: '🎭 Alteregó váltás',
    autoSwitch: 'Automatikus váltogatás',
    tipRefresh: 'A panel újratöltése (az adatok frissülnek)',
    tipRestart: 'A Harness újraindítása (friss belépési token; a rendszertálca ikon végzi el, ezért nem szakad félbe)',
    tipThemeToLight: 'Világos mód',
    tipThemeToDark: 'Sötét mód',
    tipLang: 'Nyelv váltása (magyar / angol)',
    tipLangToEn: 'Váltás angolra',
    tipLangToHu: 'Váltás magyarra',
    tabConsole: 'Konzol',
    tabStatus: 'Állapot',
    tabSettings: 'Beállítások',
    tabLog: 'Napló',
    chipStatus: 'Állapot',
    chipLog30: 'Napló 30',
    chipPages: 'Figyelt oldalak',
    chipHelp: 'Segít',
    inputPlaceholder: 'Írj a robotnak, vagy adj parancsot (/állapot, /futtat <job>, /oldal <név> <url>)…',
    send: 'Küld',
    consoleHint: 'A perjellel kezdett sor parancs (nincs modellhívás); minden más beszélgetés a robottal, ingyenes modell-láncon.',
    jobsTitle: 'Jobok',
    runsTitle: 'Utolsó futások',
    farTitle: 'Integrációs napló (audit)',
    thJob: 'job',
    thStarted: 'kezdés',
    thStatus: 'állapot',
    thDetail: 'részlet',
    thTime: 'idő',
    thApplicant: 'jelentkezés',
    thCourse: 'képzés',
    thType: 'típus',
    thPhase: 'fázis',
    setEmailTitle: 'E-mail (a riportok kimenete)',
    setFrom: 'Feladó cím',
    setTo: 'Címzettek (vesszővel)',
    setTls: 'TLS (false/true)',
    setSmtpUser: 'SMTP felhasználó',
    setSmtpPass: 'SMTP jelszó',
    setSecretPlaceholder: '(üresen hagyva nem változik)',
    setDryRun: 'Száraz futás (nem küld e-mailt)',
    setPanelToken: 'Webhook panel-token',
    setSecretsNote: 'A titkok a bot/secrets.json fájlba kerülnek (a .gitignore-ban), és soha nem kerülnek vissza a böngészőbe.',
    setWebhookTitle: 'Webhook',
    badgeNoModule: 'webhook: nincs privát modul',
    setWatchTitle: 'Konkurencia-figyelo',
    setCron: 'Ütemezés (cron: perc óra nap hónap hét-napja)',
    saveSettings: 'Beállítások mentése',
    logTitle: 'Napló (utolsó 80 sor)',
    badgeMail: 'e-mail',
    badgeNoRecipient: 'nincs címzett',
    badgeDryRun: 'száraz futás',
    badgeLive: 'éles küldés',
    welcome: 'Szia, itt a Házirobot. Írj bátran, vagy adj parancsot — a /segít parancs felsorolja, mit tudok.',
    chatYou: 'te',
    chatRobot: 'Házirobot',
    noJobs: 'nincs job',
    runBtn: 'futtat',
    runStarted: 'elindítva',
    autoOff: 'kikapcsolva',
    unitSec: 'mp',
    unitMin: 'perc',
    unitHour: 'óra',
    secretSet: 'beállítva, üresen hagyva nem változik',
    secretUnset: 'még nincs beállítva',
    saved: 'Elmentve.',
    secretUpdated: 'Titok frissítve: ',
    noSecretTyped: ' (Titkot nem írtál be.)',
    saveFailed: 'Mentés sikertelen: ',
    confirmRestart: 'Újraindítom a Harness szervert? Minden panel újratöltődik; a munkamenetek megmaradnak.',
    restartStarted: 'A Harness újraindítása elindult. A panel néhány másodperc múlva újratöltődik.',
    restartFailed: 'Az újraindítás nem indult el',
    errorPrefix: 'Hiba: ',
    approvalNeeded: 'Jóváhagyás kell:',
    approve: 'Elfogadom',
    reject: 'Mégsem',
    approvedPrefix: '(jóváhagyva: ',
    noReply: '(nincs válasz)'
  },
  en: {
    appName: 'Home Robot',
    subtitle: 'local agent · standalone surface',
    avatarSwitch: '🎭 Switch alter ego',
    autoSwitch: 'Automatic rotation',
    tipRefresh: 'Reload the panel (data is refreshed)',
    tipRestart: 'Restart the Harness (fresh sign-in token; the tray icon does it, so it cannot be cut short)',
    tipThemeToLight: 'Light mode',
    tipThemeToDark: 'Dark mode',
    tipLang: 'Switch language (Hungarian / English)',
    tipLangToEn: 'Switch to English',
    tipLangToHu: 'Switch to Hungarian',
    tabConsole: 'Console',
    tabStatus: 'Status',
    tabSettings: 'Settings',
    tabLog: 'Log',
    chipStatus: 'Status',
    chipLog30: 'Log 30',
    chipPages: 'Watched pages',
    chipHelp: 'Help',
    inputPlaceholder: 'Write to the robot, or give a command (/állapot, /futtat <job>, /oldal <name> <url>)…',
    send: 'Send',
    consoleHint: 'A line starting with a slash is a command (no model call); anything else is a conversation on the free model chain.',
    jobsTitle: 'Jobs',
    runsTitle: 'Recent runs',
    farTitle: 'Integration log (audit)',
    thJob: 'job',
    thStarted: 'started',
    thStatus: 'status',
    thDetail: 'detail',
    thTime: 'time',
    thApplicant: 'applicant',
    thCourse: 'course',
    thType: 'type',
    thPhase: 'phase',
    setEmailTitle: 'E-mail (report output)',
    setFrom: 'From address',
    setTo: 'Recipients (comma separated)',
    setTls: 'TLS (false/true)',
    setSmtpUser: 'SMTP user',
    setSmtpPass: 'SMTP password',
    setSecretPlaceholder: '(leave empty to keep the current one)',
    setDryRun: 'Dry run (does not send e-mail)',
    setPanelToken: 'Webhook panel token',
    setSecretsNote: 'Secrets go to bot/secrets.json (git-ignored) and are never sent back to the browser.',
    setWebhookTitle: 'Webhook',
    badgeNoModule: 'webhook: no private module',
    setWatchTitle: 'Competitor watcher',
    setCron: 'Schedule (cron: minute hour day month weekday)',
    saveSettings: 'Save settings',
    logTitle: 'Log (last 80 lines)',
    badgeMail: 'e-mail',
    badgeNoRecipient: 'no recipient',
    badgeDryRun: 'dry run',
    badgeLive: 'live send',
    welcome: 'Hi, this is the Home Robot. Write freely, or give a command — /segít lists what I can do.',
    chatYou: 'you',
    chatRobot: 'Home Robot',
    noJobs: 'no jobs',
    runBtn: 'run',
    runStarted: 'started',
    autoOff: 'off',
    unitSec: 'sec',
    unitMin: 'min',
    unitHour: 'hour',
    secretSet: 'set; leaving it empty keeps it',
    secretUnset: 'not set yet',
    saved: 'Saved.',
    secretUpdated: 'Secret updated: ',
    noSecretTyped: ' (No secret was typed.)',
    saveFailed: 'Save failed: ',
    confirmRestart: 'Restart the Harness server? Every panel reloads; the sessions are kept.',
    restartStarted: 'The Harness restart has started. The panel reloads in a few seconds.',
    restartFailed: 'The restart did not start',
    errorPrefix: 'Error: ',
    approvalNeeded: 'Approval needed:',
    approve: 'Approve',
    reject: 'Cancel',
    approvedPrefix: '(approved: ',
    noReply: '(no reply)'
  }
};
var LANG = 'hu';
try { var storedLang = localStorage.getItem('hazi-robot-lang'); if (storedLang === 'hu' || storedLang === 'en') LANG = storedLang; } catch (e) { }
// A téma a SZERVERRŐL jön (a DSH panel és ez a panel egyszerre vált): a
// localStorage itt nem használható, mert ez a panel külön originen fut.
var THEME = '${panelTheme}';
// A ?lang=hu|en és ?theme=light|dark felülírja a mentett választást: így egy
// adott nyelvű/témájú panel linkelhető (és a mentett beállítás megmarad).
try {
  var query = new URLSearchParams(location.search);
  var queryLang = query.get('lang');
  if (queryLang === 'hu' || queryLang === 'en') LANG = queryLang;
  var queryTheme = query.get('theme');
  if (queryTheme === 'light' || queryTheme === 'dark') THEME = queryTheme;
} catch (e) { }

function t(key) {
  var table = I18N[LANG] || I18N.hu;
  return (table && table[key]) || I18N.hu[key] || key;
}

function updateThemeButton() {
  var themeBtn = document.getElementById('btn-theme');
  if (!themeBtn) return;
  themeBtn.textContent = THEME === 'light' ? '☀' : '🌙';
  themeBtn.title = THEME === 'light' ? t('tipThemeToDark') : t('tipThemeToLight');
}

function applyTheme() {
  try { localStorage.setItem('hazi-robot-theme', THEME); } catch (e) { }
  document.body.classList.toggle('light', THEME === 'light');
  updateThemeButton();
}

function applyLang() {
  try { localStorage.setItem('hazi-robot-lang', LANG); } catch (e) { }
  document.documentElement.lang = LANG;
  document.title = t('appName');
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) { nodes[i].textContent = t(nodes[i].getAttribute('data-i18n')); }
  var titles = document.querySelectorAll('[data-i18n-title]');
  for (var j = 0; j < titles.length; j++) { titles[j].title = t(titles[j].getAttribute('data-i18n-title')); }
  var placeholders = document.querySelectorAll('[data-i18n-placeholder]');
  for (var k = 0; k < placeholders.length; k++) { placeholders[k].placeholder = t(placeholders[k].getAttribute('data-i18n-placeholder')); }
  // Az integrációs modulok feliratai (jelvény, chip, beállítás-címkék) nem a
  // szótárból jönnek, hanem a modul leírójából, ezért két nyelven utaznak.
  var badges = document.querySelectorAll('[data-badge-hu]');
  for (var b = 0; b < badges.length; b++) {
    badges[b].textContent = LANG === 'hu' ? badges[b].getAttribute('data-badge-hu') : badges[b].getAttribute('data-badge-en');
  }
  var extTexts = document.querySelectorAll('.ext-chip, .ext-label');
  for (var x = 0; x < extTexts.length; x++) {
    extTexts[x].textContent = LANG === 'hu' ? extTexts[x].getAttribute('data-hu') : extTexts[x].getAttribute('data-en');
  }
  var langBtn = document.getElementById('btn-lang');
  if (langBtn) {
    // Ugyanaz a minta, mint a dsh-ui-extras panelen: a gomb az AKTÍV nyelvet
    // mutatja (HU/EN), a tooltip pedig a váltás célját. Az ellenkezője (a
    // célnyelv a feliraton) fordítva hatott.
    langBtn.textContent = LANG === 'hu' ? 'HU' : 'EN';
    langBtn.title = LANG === 'hu' ? t('tipLangToEn') : t('tipLangToHu');
  }
  updateThemeButton();
  // A dinamikus részek újrarajzolása, hogy a nyelvváltás azonnal látszódjon.
  renderAvatarSelector();
  renderChat();
  loadStatus();
  loadSettings();
}

function toggleTheme() {
  THEME = THEME === 'light' ? 'dark' : 'light';
  applyTheme();
  applyLang();
  // A szervernek is jelezzük: így a következő betöltéskor is ez a téma jön, és
  // a DSH panel (amely a hoston át ugyanezt a végpontot használja) is látja.
  fetch('/theme', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: THEME })
  }).catch(function () { /* a helyi váltás így is megtörtént */ });
}
function toggleLang() { LANG = LANG === 'hu' ? 'en' : 'hu'; applyLang(); }
function doRefresh() { location.reload(); }

async function doRestart() {
  if (!confirm(t('confirmRestart'))) return;
  var btn = document.getElementById('btn-restart');
  if (btn) btn.disabled = true;
  try {
    var response = await q('/restart', { method: 'POST' });
    var body = await response.json();
    alert(body.message || (body.ok ? t('restartStarted') : (body.error || t('restartFailed'))));
  } catch (error) {
    alert(t('restartFailed') + ': ' + error.message);
  }
  if (btn) btn.disabled = false;
}

const TOKEN = new URLSearchParams(location.search).get('token') || '';
function q(url, opts) {
  if (TOKEN) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  return fetch(url, opts);
}
function esc(v) { return String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function shortTime(v) { return String(v ?? '').slice(0, 16).replace('T', ' '); }
function cls(s) {
  if (['ok','hitelesitve','nincs-valtozas'].includes(s)) return 'ok';
  if (['hiba','IMPORT_HIBA','RECONCILE_FAIL'].includes(s)) return 'err';
  return 'warn';
}

let JOBS = [];
async function loadStatus() {
  const d = await (await q('/status.json')).json();
  document.getElementById('clock').textContent = new Date().toLocaleString('hu-HU');
  if (d.bot) {
    document.getElementById('badge-mail').textContent = t('badgeMail') + ': ' + ((d.bot.emailTo || []).join(', ') || t('badgeNoRecipient'));
    document.getElementById('badge-dry').textContent = d.bot.emailDryRun ? t('badgeDryRun') : t('badgeLive');
  }
  JOBS = d.jobs || [];
  document.getElementById('jobs').innerHTML = JOBS.map(j =>
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #1e2530">' +
    '<div><div>' + esc(j.id) + '</div><div class="dim" style="font-size:11.5px">' + esc(j.leiras) + ' · ' + esc(j.schedule?.kifejezes || j.schedule?.tipus || '-') + '</div></div>' +
    '<button class="act" onclick="runJob(\\'' + esc(j.id) + '\\')">' + t('runBtn') + '</button></div>').join('') || '<div class="dim">' + t('noJobs') + '</div>';
  document.getElementById('runs').innerHTML = (d.runs || []).map(r =>
    '<tr><td>' + esc(r.job_id) + '</td><td>' + esc(shortTime(r.started_at)) + '</td><td class="' + cls(r.status) + '">' + esc(r.status) + '</td><td class="dim">' + esc((r.detail || '').slice(0, 60)) + '</td></tr>').join('');
  document.getElementById('far').innerHTML = (d.far || []).map(l =>
    '<tr><td>' + esc(shortTime(l.ts)) + '</td><td>' + esc(l.jelentkezes_id) + '</td><td>' + esc(l.far_nive_id) + '</td><td>' + esc(l.tipus) + '</td><td>' + esc(l.fazis) + '</td><td>' + esc((l.sigma_before ?? '?') + '→' + (l.sigma_after ?? '?')) + '</td><td class="' + cls(l.status) + '">' + esc(l.status) + '</td><td class="dim">' + esc((l.detail || '').slice(0, 50)) + '</td></tr>').join('');
}

async function runJob(id) {
  const r = await (await q('/run?job=' + encodeURIComponent(id), { method: 'POST' })).json();
  alert(r.message || (r.ok ? t('runStarted') : r.error));
  setTimeout(loadStatus, 1500);
}

async function loadSettings() {
  const d = await (await q('/settings')).json();
  if (!d.ok) { document.getElementById('save-msg').textContent = t('errorPrefix') + d.error; return; }
  const s = d.settings;
  document.getElementById('s-from').value = s.email.from || '';
  document.getElementById('s-to').value = s.email.to || '';
  document.getElementById('s-host').value = s.email.smtp.host || '';
  document.getElementById('s-port').value = s.email.smtp.port || 587;
  document.getElementById('s-secure').value = s.email.smtp.secure || 'false';
  document.getElementById('s-user').value = s.email.smtp.user || '';
  document.getElementById('s-dry').checked = s.email.dryRun === true;
  // Az integrációs modulok mezői: az útvonalat a bot/extensions.json adja meg
  // (pl. "sajat.callbackUrl"), ezért a kód nem tud feladatneveket.
  document.querySelectorAll('[data-ext]').forEach(function (el) {
    el.value = dotGet(s, el.getAttribute('data-ext')) || '';
  });
  document.querySelectorAll('[data-ext-secret]').forEach(function (el) {
    const kulcs = el.getAttribute('data-ext-secret');
    const cimke = el.previousElementSibling;
    if (cimke) cimke.textContent = cimke.getAttribute('data-hu') + ' — ' + (d.secretsSet[kulcs] ? t('secretSet') : t('secretUnset'));
  });
  setIfPresent('s-cron', s.jobSchedule || '');
  document.getElementById('lbl-smtp-pass').textContent = t('setSmtpPass') + ' — ' + (d.secretsSet.smtpPassword ? t('secretSet') : t('secretUnset'));
  document.getElementById('lbl-panel-token').textContent = t('setPanelToken') + ' — ' + (d.secretsSet.panelToken ? t('secretSet') : t('secretUnset'));
  if (document.getElementById('pages')) renderPages(s.oldalak || []);
}

/** Pontozott útvonal beolvasása egy objektumból ("sajat.callbackUrl"). */
function dotGet(obj, path) {
  return String(path).split('.').reduce(function (o, k) { return (o === null || o === undefined) ? undefined : o[k]; }, obj);
}

/** Pontozott útvonal írása egy objektumba, a hiányzó szinteket létrehozva. */
function dotSet(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/** Érték beírása, ha a mező létezik (a privát modul nélkül nincs a lapon). */
function setIfPresent(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

/** Érték kiolvasása; ha a mező nincs a lapon, üres string. */
function valueOf(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

/** Címke frissítése, ha a mező létezik. */
function setLabelIfPresent(id, label, isSet) {
  const el = document.getElementById(id);
  if (el) el.textContent = label + ' — ' + (isSet ? t('secretSet') : t('secretUnset'));
}

function renderPages(list) {
  const rows = list.concat([{ nev: '', url: '' }, { nev: '', url: '' }, { nev: '', url: '' }]).slice(0, Math.max(3, list.length + 1));
  document.getElementById('pages').innerHTML = rows.map((p, i) =>
    '<div class="row" style="margin-bottom:4px">' +
    '<input type="text" style="width:38%" data-page-nev="' + i + '" placeholder="Név" value="' + esc(p.nev) + '">' +
    '<input type="text" data-page-url="' + i + '" placeholder="https://…" value="' + esc(p.url) + '"></div>').join('');
}

async function saveSettings() {
  const pages = [];
  document.querySelectorAll('[data-page-url]').forEach(el => {
    const i = el.getAttribute('data-page-url');
    const nev = document.querySelector('[data-page-nev="' + i + '"]');
    if (el.value.trim()) pages.push({ nev: nev ? nev.value : '', url: el.value });
  });
  const body = {
    email: {
      from: document.getElementById('s-from').value,
      to: document.getElementById('s-to').value,
      dryRun: document.getElementById('s-dry').checked,
      smtp: {
        host: document.getElementById('s-host').value,
        port: document.getElementById('s-port').value,
        secure: document.getElementById('s-secure').value,
        user: document.getElementById('s-user').value,
      },
    },
    oldalak: pages,
    jobSchedule: valueOf('s-cron'),
  };
  // Az integrációs modulok mezői a leíróban megadott útvonalra kerülnek, a
  // titkok pedig a secrets.json-ba (a mezőnév = a titok kulcsa).
  document.querySelectorAll('[data-ext]').forEach(function (el) {
    dotSet(body, el.getAttribute('data-ext'), el.value);
  });
  body.secrets = { smtpPassword: document.getElementById('s-pass').value, panelToken: document.getElementById('s-panel-token').value };
  document.querySelectorAll('[data-ext-secret]').forEach(function (el) {
    body.secrets[el.getAttribute('data-ext-secret')] = el.value;
  });
  const r = await (await q('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const msg = document.getElementById('save-msg');
  msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
  msg.textContent = r.ok
    ? (t('saved') + ((r.savedSecrets || []).length ? ' ' + t('secretUpdated') + r.savedSecrets.join(', ') + '.' : t('noSecretTyped')))
    : (t('saveFailed') + r.error);
  ['s-pass','s-panel-token'].forEach(id => setIfPresent(id, ''));
  document.querySelectorAll('[data-ext-secret]').forEach(function (el) { el.value = ''; });
  if (r.ok) { loadSettings(); loadStatus(); }
}

async function loadLog() {
  const d = await (await q('/log?lines=80')).json();
  if (d.ok) document.getElementById('log').textContent = (d.lines || []).join('\\n');
}

function showTab(name) {
  ['konzol', 'status', 'settings', 'log'].forEach(t => {
    document.getElementById('view-' + t).classList.toggle('hidden', t !== name);
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
  });
  if (name === 'settings') loadSettings();
  if (name === 'log') loadLog();
  if (name === 'status') loadStatus();
}

/* ------------------------------- alteregók -------------------------------- */

var AV = { aktiv: '', auto: 0, lista: [], valasztek: [0, 10, 30, 60, 300] };
var avTimer = null;

async function loadAlteregok() {
  try {
    var d = await (await q('/alteregok')).json();
    if (!d.ok) return;
    AV.aktiv = d.aktiv;
    AV.auto = d.auto;
    AV.lista = d.lista || [];
    AV.valasztek = d.autoValasztak || AV.valasztek;
    renderAvatarSelector();
    applyAvatar();
    scheduleAuto();
  } catch (err) { /* a panel ilyenkor a régi avatart mutatja */ }
}

function autoLabel(seconds) {
  if (seconds === 0) return t('autoOff');
  if (seconds < 60) return seconds + ' ' + t('unitSec');
  if (seconds < 3600) return (seconds / 60) + ' ' + t('unitMin');
  return (seconds / 3600) + ' ' + t('unitHour');
}

function renderAvatarSelector() {
  var sel = document.getElementById('avatar-auto');
  if (!sel) return;
  sel.innerHTML = AV.valasztek.map(function (s) {
    return '<option value="' + s + '"' + (s === AV.auto ? ' selected' : '') + '>' + autoLabel(s) + '</option>';
  }).join('');
  document.getElementById('avatar-grid').innerHTML = AV.lista.map(function (a) {
    return '<button class="avcard' + (a.id === AV.aktiv ? ' active' : '') + '" data-id="' + esc(a.id) + '"' +
      ' title="' + esc(a.ihlet) + '" onclick="pickAvatar(this.dataset.id)">' +
      '<img src="/avatar.svg?alterego=' + encodeURIComponent(a.id) + '" width="66" height="88" alt="' + esc(a.nev) + '">' +
      '<span class="n">' + esc(a.nev) + '</span>' +
      '<span class="s">' + esc(a.alcim) + '</span>' +
      '<span class="m">' + esc(a.mozgas) + '</span>' +
      '</button>';
  }).join('');
  var aktiv = AV.lista.filter(function (a) { return a.id === AV.aktiv; })[0];
  document.getElementById('avatar-nev').textContent = aktiv ? aktiv.nev : AV.aktiv;
  // A kiválasztott időköz maga a legördülő értéke, ezért nincs külön "vált X
  // percenként" sor — az csak megkettőzte volna ugyanazt az információt.
}

function applyAvatar() {
  document.getElementById('avatar').src = '/avatar.svg?alterego=' + encodeURIComponent(AV.aktiv);
  var cards = document.querySelectorAll('.avcard');
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.toggle('active', cards[i].getAttribute('data-id') === AV.aktiv);
  }
}

function toggleAvatarGrid() {
  document.getElementById('avatar-panel').classList.toggle('hidden');
}

async function pickAvatar(id) {
  AV.aktiv = id;
  renderAvatarSelector();
  applyAvatar();
  scheduleAuto();
  try {
    await q('/alterego', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aktiv: id }) });
  } catch (err) { /* a helyi váltás így is megtörtént */ }
}

async function setAuto(sec) {
  AV.auto = Number(sec) || 0;
  renderAvatarSelector();
  scheduleAuto();
  try {
    await q('/alterego', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto: AV.auto }) });
  } catch (err) { /* a helyi beállítás így is megtörtént */ }
}

function scheduleAuto() {
  if (avTimer) { clearInterval(avTimer); avTimer = null; }
  if (AV.auto > 0 && AV.lista.length > 1) avTimer = setInterval(nextAvatar, AV.auto * 1000);
}

function nextAvatar() {
  var i = -1;
  for (var k = 0; k < AV.lista.length; k++) if (AV.lista[k].id === AV.aktiv) i = k;
  var next = AV.lista[(i + 1) % AV.lista.length];
  if (!next) return;
  AV.aktiv = next.id;
  renderAvatarSelector();
  applyAvatar();
}

/* ------------------------------- robot-konzol ------------------------------ */

var HISTORY = [];

function pushMsg(role, text) {
  HISTORY.push({ role: role, content: String(text ?? '') });
  renderChat();
}

function renderChat() {
  var box = document.getElementById('chat');
  box.innerHTML = HISTORY.map(function (m) {
    var cls = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'robot' : 'sys');
    var who = m.role === 'user' ? t('chatYou') : (m.role === 'assistant' ? t('chatRobot') : '');
    return '<div class="bubble ' + cls + '">' + (who ? '<span class="who">' + who + '</span>' : '') + esc(m.content) + '</div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function chip(text) {
  document.getElementById('msg').value = text;
  send();
}

function renderApproval(req) {
  var box = document.getElementById('approval');
  if (!req) { box.innerHTML = ''; return; }
  box.innerHTML =
    '<div class="approval"><div style="flex:1">' + t('approvalNeeded') + ' <b>' + esc(req.action) + '</b> ' +
    esc(JSON.stringify(req.params || {})) + '</div>' +
    '<button class="act" onclick="approve()">' + t('approve') + '</button>' +
    '<button class="act" onclick="renderApproval(null)">' + t('reject') + '</button></div>';
  box.dataset.action = JSON.stringify(req);
}

async function approve() {
  var box = document.getElementById('approval');
  var req = JSON.parse(box.dataset.action || '{}');
  renderApproval(null);
  pushMsg('user', t('approvedPrefix') + req.action + ')');
  try {
    var res = await (await q('/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approve: req }),
    })).json();
    pushMsg('assistant', res.reply || t('noReply'));
  } catch (err) {
    pushMsg('sys', t('errorPrefix') + err.message);
  }
  loadStatus();
}

async function send() {
  var el = document.getElementById('msg');
  var text = (el.value || '').trim();
  if (!text) return;
  el.value = '';
  pushMsg('user', text);
  var btn = document.getElementById('send');
  btn.disabled = true;
  btn.textContent = '…';
  var isCmd = text.charAt(0) === '/';
  try {
    var res = await (await q(isCmd ? '/command' : '/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(isCmd ? { text: text } : { text: text, history: HISTORY.slice(-9, -1) }),
    })).json();
    pushMsg('assistant', res.reply || t('noReply'));
    if (res.steps && res.steps.length) pushMsg('sys', res.steps.join(' · '));
    if (res.needsApproval) renderApproval(res.needsApproval);
    if (!isCmd && res.tokens) {
      document.getElementById('hint').textContent =
        'tokenek: ' + res.tokens.in + ' be / ' + res.tokens.out + ' ki — ingyenes lánc';
    }
    loadStatus();
  } catch (err) {
    pushMsg('sys', t('errorPrefix') + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = t('send');
  }
}

// A DSH panel témagombja a hoston át POST-ol a /theme vegpontra. Az itt MAR
// betöltött lap viszont csak betöltéskor olvasta a témát, ezért a váltás nem
// látszott azonnal — a felhasználó ezt „nem terjed át a többi panelre"ként
// látta. Ezért rövid időközönként lekérdezzük a szerver témáját, és ha eltér,
// élőben átváltunk. (A ?theme= felülírás szándékos: olyankor nem követjük.)
var THEME_PINNED = false;
try {
  var pinnedQuery = new URLSearchParams(location.search).get('theme');
  THEME_PINNED = pinnedQuery === 'light' || pinnedQuery === 'dark';
} catch (e) { }
function followServerTheme() {
  if (THEME_PINNED) return;
  if (document.visibilityState === 'hidden') return;
  q('/theme', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || (d.theme !== 'light' && d.theme !== 'dark')) return;
      if (d.theme === THEME) return;
      THEME = d.theme;
      applyTheme();
    })
    .catch(function () { /* a szerver lehet, hogy épp indul */ });
}

applyTheme();
applyLang();
// 2 másodperc: a DSH oldal ugyanilyen sűrűn kérdez vissza, így a két irány
// együtt mozog, és a váltás nem tűnik „csak az egyik panelt érinti" hibának.
setInterval(followServerTheme, 2000);
// A választékot a szerverről kell betölteni: az applyLang csak újrarajzol, és
// a lista addig az alapértéken maradna — ezért nem látszottak a hosszabb
// időközök (15 perc … 2 óra) a legördülőben.
// FIGYELEM: a panelHtml() egy TEMPLATE STRING, ezért a benne lévő JS-ben
// soha ne használj backticket (még kommentben sem) — az lezárná a stringet.
loadAlteregok();
pushMsg('assistant', t('welcome'));
setInterval(loadStatus, 20000);
setInterval(() => { if (!document.getElementById('view-log').classList.contains('hidden')) loadLog(); }, 10000);
</script>
</body></html>`;
}

/* --------------------------------- szerver -------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(panelHtml());
    }

    if (req.method === 'GET' && url.pathname === '/avatar.svg') {
      const svg = readAvatarSvg(url.searchParams.get('alterego') ?? '');
      if (!svg) return json(res, 404, { error: 'nincs avatar' });
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(svg);
    }

    // Alteregó avatarok: a lista és az aktív váltás (a panel és a DSH panel közös).
    if (req.method === 'GET' && url.pathname === '/alteregok') {
      return json(res, 200, avatarPayload());
    }

    if (req.method === 'POST' && url.pathname === '/alterego') {
      if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      try {
        const body = JSON.parse(await readBody(req));
        const saved = setAvatarState(body);
        if (!saved.ok) return json(res, 400, saved);
        log.info(`alterego: ${saved.aktiv}${saved.auto ? ` (auto ${saved.auto}s)` : ''}`);
        return json(res, 200, avatarPayload());
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/status.json') {
      const jobs = existsSync(cfg.paths.jobs)
        ? readdirSync(cfg.paths.jobs)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
              try {
                const job = JSON.parse(readFileSync(join(cfg.paths.jobs, f), 'utf8').replace(/^\uFEFF/, ''));
                return { id: job.id ?? f.replace(/\.json$/, ''), leiras: job.leiras ?? '', schedule: job.schedule ?? {} };
              } catch {
                return null;
              }
            })
            .filter(Boolean)
        : [];
      return json(res, 200, {
        ok: true,
        bot: {
          emailDryRun: cfg.email.dryRun,
          emailTo: cfg.email.to,
          panelPort: PORT,
        },
        jobs,
        runs: recentRuns(20),
        far: farLedgerRecent(20),
      });
    }

    // Robot-konzol: determinisztikus parancs és beszélgetés.
    if (req.method === 'POST' && url.pathname === '/command') {
      if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      try {
        const body = JSON.parse(await readBody(req));
        return json(res, 200, await handleCommand(body));
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/ask') {
      if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      try {
        const body = JSON.parse(await readBody(req));
        return json(res, 200, await handleAsk(body));
      } catch (err) {
        log.error(`konzol hiba: ${err.message}`);
        return json(res, 500, { ok: false, reply: `Hiba: ${err.message}` });
      }
    }

    // Beállítások: ugyanaz a logika, mint a DSH panelon (közös modul).
    if (url.pathname === '/settings') {
      if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      const mod = await loadSettingsModule();
      if (!mod) {
        return json(res, 503, {
          ok: false,
          error: 'a beállítás-modul nem érhető el (plugins/dsh-hazi-robot/lib/index.js) — a panel csak olvasható',
        });
      }
      if (req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req));
          return json(res, 200, mod.applySettings(body));
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }
      return json(res, 200, mod.currentSettings());
    }

    if (req.method === 'GET' && url.pathname === '/log') {
      const logPath = join(BOT, 'state', 'bot.log');
      if (!existsSync(logPath)) return json(res, 200, { ok: true, lines: [] });
      const limit = Math.min(Number(url.searchParams.get('lines') ?? 80) || 80, 500);
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').slice(-limit).reverse();
      return json(res, 200, { ok: true, lines });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      const job = url.searchParams.get('job');
      if (!job || !/^[a-z0-9-]{1,60}$/i.test(job)) return json(res, 400, { ok: false, error: 'MISSING_OR_INVALID_JOB' });
      const pid = startSimpleJob(job);
      log.info(`panelrol inditva: ${job} (pid ${pid})`);
      return json(res, 202, { ok: true, message: `${job} elindítva (pid ${pid})` });
    }

    // A panel témája: GET = a jelenlegi, POST = beállítás. A DSH panel
    // (dsh-ui-extras) a témaváltáskor a hoston át POST-ol ide, ezért a robot
    // panel és a DSH panelek egyszerre váltanak témát.
    if (url.pathname === '/theme') {
      if (req.method === 'POST') {
        if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        try {
          const body = JSON.parse(await readBody(req));
          panelTheme = body.theme === 'light' ? 'light' : 'dark';
          savePanelTheme(panelTheme);
          log.info(`panel tema: ${panelTheme}`);
          return json(res, 200, { ok: true, theme: panelTheme });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      }
      return json(res, 200, { ok: true, theme: panelTheme });
    }

    // A panel ⭯ gombja: a Harness újraindítása. A munkát a tools\restart-harness.ps1
    // végzi, ami a rendszertálcára bízza (az egyetlen folyamat a DSH folyamatfáján
    // kívül), ezért ez nem szakadhat félbe. A `-NoWait` miatt a kérés azonnal
    // visszatér: a panel nem várná meg a saját szerverének elhalását.
    //
    // A válasz szándékosan NEM tartalmaz felhasználói szöveget: a panel a saját
    // nyelvén írja ki (`t('restartStarted')`), különben az angol felületen magyar
    // üzenet jelenne meg.
    if (req.method === 'POST' && url.pathname === '/restart') {
      if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      const script = join(BOT, '..', 'tools', 'restart-harness.ps1');
      if (!existsSync(script)) return json(res, 500, { ok: false, error: 'nincs tools/restart-harness.ps1' });
      try {
        const child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-File', script, '-NoWait'
        ], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        log.info('panelrol inditott harness ujrainditas (restart-harness.ps1)');
        return json(res, 202, { ok: true });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    // Integrációs webhookok: a `bot/extensions.json` `webhook` mezője mondja meg,
    // melyik útvonal melyik modulhoz tartozik. A panel nem tud feladatneveket.
    const webhookExt = EXTENSIONS.find((e) => e.webhook === url.pathname);
    if (req.method === 'POST' && webhookExt) {
      if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return json(res, 400, { ok: false, error: 'INVALID_JSON' });
      }
      // A nyugta azonosítója a payloadból, ha van ilyen — a hívó a saját
      // mezőnevét használja, ezért a szokásos neveket vesszük sorra.
      const azonosito = payload.jelentkezes_id ?? payload.id ?? payload.azonosito ?? 'x';
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${azonosito}.json`;
      const path = join(INBOX, name);
      writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
      const pid = startExtensionJob(webhookExt, path);
      if (pid === null) {
        // A leíró hivatkozik egy nem létező modulra: ez beállítási hiba, és meg
        // is mondjuk, melyik fájl hiányzik.
        return json(res, 500, {
          ok: false,
          error: 'MODUL_HIANYZIK',
          message: `A(z) "${webhookExt.id}" integráció orchestrator fájlja nem található.`,
        });
      }
      log.info(`webhook bejott: ${payload.type ?? webhookExt.id} azonosito=${azonosito} (pid ${pid})`);
      // A hívó csak azt várja, hogy a kérés megérkezett; a folyamat aszinkron.
      return json(res, 202, { ok: true, fogadva: true, azonosito, pid });
    }

    return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (err) {
    log.error(`szerver hiba: ${err.message}`);
    // Ha a válasz fejlécei már kimentek, nem küldhetünk újabb hibát — az
    // ERR_HTTP_HEADERS_SENT kivétel korábban az EGÉSZ szervert megölte.
    if (res.headersSent) {
      try { res.end(); } catch { /* már lezárult */ }
      return undefined;
    }
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.on('error', (err) => {
  // Két példány (pl. a bejelentkezéskori parancsikon ÉS az ütemezett feladat)
  // ugyanarra a portra próbál kötni: a második csendben kilép, nem hiba.
  if (err && err.code === 'EADDRINUSE') {
    log.warn(`a panel már fut a ${HOST}:${PORT} címen — ez a példány kilép`);
    process.exit(0);
  }
  log.error(`szerver hiba: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log.ok(`Házirobot webhook-fogado fut: http://${HOST}:${PORT}  (panel: /)`);
  if (!TOKEN) log.warn('nincs BOT_WEBHOOK_TOKEN / panel.token beallitva — csak helyi hasznalatra biztonsagos');
});
