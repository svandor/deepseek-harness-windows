/**
 * HOST oldal: a fejlesztési költségelszámolás végpontjai a DSH web-szerverén.
 *
 * Minden számítás a host folyamatában fut (nincs gyerekfolyamat, nincs
 * konzolablak — AGENTS §1). A böngésző csak számokat lát; a mérés a tartós
 * session-naplókból és a kliens-oldali aktivitás-vödrökből készül.
 *
 * Végpontok:
 *   GET  /koltseg/ping                  — életjel + verzió + útvonalak
 *   GET  /koltseg/config                — óradíj, profilok, repó-felülírások
 *   POST /koltseg/config                — konfiguráció mentése (validálva)
 *   GET  /koltseg/workspaces            — munkaterületek (registry vagy naplók)
 *   GET  /koltseg/sessions?workspace=   — munkafolyamat-lista a választóhoz
 *   GET  /koltseg/measure?scope=…       — a mérés (session / workspace / időszak)
 *   GET  /koltseg/export?scope=…&format=csv — ugyanaz CSV-ben
 *   POST /koltseg/activity              — kliens aktivitás-vödrök
 *   GET  /koltseg/ledger                — rögzített elszámolások (+ CSV)
 *   POST /koltseg/ledger                — elszámolás rögzítése
 *   DEL  /koltseg/ledger?id=            — rögzítés törlése
 */
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findSession, measure, sessionList, workspaceList } from "./engine/calc.js";
import { configPath, loadConfig, profileOf, profilesOf, resolveRate, saveConfig } from "./engine/config.js";
import { appendActivity } from "./engine/human.js";
import { appendLedger, ledgerCsv, readLedger, removeLedger } from "./engine/ledger.js";
import { dayStart, daysAgoStart, dayOf, nextDayStart, today } from "./engine/time.js";

const here = fileURLToPath(new URL(".", import.meta.url));
/**
 * A plugin a `~\.dsh\profiles\node_modules` junctionján át töltődik; a junction
 * feloldásával kapjuk a valódi repó-útvonalat (különben a `state\` a profilok
 * alá kerülne) — ugyanaz a minta, mint a `dsh-ftp-deploy`-ban.
 */
let PACKAGE_ROOT;
try {
  PACKAGE_ROOT = realpathSync(resolve(here, ".."));
} catch {
  PACKAGE_ROOT = resolve(here, "..");
}
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
/**
 * Az állapotkönyvtár: alapból a repó `state`-je, de a `DSH_KOLTSEG_STATE_DIR`
 * felülírhatja — a tesztek így NEM írnak a valódi állapotfájlokba (a
 * `harness.log`-ba és a `koltseg.log`-ba írás korábban mérési zajt okozott).
 */
const STATE_DIR = typeof process.env.DSH_KOLTSEG_STATE_DIR === "string" && process.env.DSH_KOLTSEG_STATE_DIR.trim().length > 0
  ? resolve(process.env.DSH_KOLTSEG_STATE_DIR.trim())
  : join(REPO_ROOT, "state");
const LOG_FILE = join(STATE_DIR, "koltseg.log");

function pluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    return String(parsed.version ?? "");
  } catch {
    return "";
  }
}

function logRoute(line) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* a napló hibája nem állíthatja meg a plugint */
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendCsv(res, filename, text) {
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function ok(res, body) {
  sendJson(res, 200, { ok: true, ...body });
}

function fail(res, error) {
  const message = String(error?.message ?? error);
  const code = error?.code ?? "";
  const isClientError = code === "BAD_REQUEST" || /hiányzó|érvénytelen|nem található|nincs ilyen/i.test(message);
  sendJson(res, isClientError ? 400 : 500, { ok: false, error: message, code });
}

function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("túl nagy kérés"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return resolveBody({});
      try {
        const parsed = JSON.parse(raw);
        resolveBody(parsed !== null && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("érvénytelen JSON"));
      }
      return;
    });
    req.on("error", reject);
  });
}

function urlOf(req) {
  return new URL(req.url ?? "/", "http://dsh.invalid");
}

function num(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Az időablak feloldása: `from`/`to` napok, vagy `days` (utolsó N nap).
 * A naphatárok magyar idő szerintiek, és a `to` napja BELESZÁMÍT (a nap vége).
 */
function resolveWindow(searchParams, now = Date.now()) {
  const days = Math.max(1, Math.min(400, num(searchParams.get("days"), 30)));
  const fromText = searchParams.get("from") ?? "";
  const toText = searchParams.get("to") ?? "";
  const parsedFrom = dayStart(fromText);
  const from = parsedFrom === null ? daysAgoStart(days, now) : parsedFrom;
  const toStart = dayStart(toText);
  const to = toStart === null ? now : Math.min(now, nextDayStart(toStart));
  if (!(to > from)) return { from: daysAgoStart(1, now), to: now };
  return { from, to };
}

/** A munkaterület feloldása: kérés -> session-napló `cwd` -> host cwd. */
async function resolveWorkspace(searchParams) {
  const explicit = searchParams.get("workspace") ?? "";
  if (explicit.trim().length > 0) return explicit.trim();
  // MÉRT HIBA (2026-11-17): a kliens nem mindig tudja a munkaterületet (a slot
  // nem ad `sessions` szolgáltatást), ezért a host a saját munkakönyvtárára
  // esett vissza (`…\@deepseek-ai\dsh\lib`) — a mérés így 0 session-t talált.
  // A session-napló fejlécében ott a `cwd`, abból pontos a feloldás.
  const sessionId = searchParams.get("session") ?? searchParams.get("id") ?? "";
  if (sessionId.length > 0) {
    try {
      const record = await findSession(sessionId, { since: Date.now() - 400 * 24 * 3600000 });
      if (record !== null && typeof record.cwd === "string" && record.cwd.length > 0) return record.cwd;
    } catch {
      /* marad a következő fokozat */
    }
  }
  return process.cwd();
}

/** A mérés eredményének gyorsítótára (a panel megnyitása ne várjon). */
const measureCache = new Map();
const MEASURE_CACHE_MILLISECONDS = 90000;
const MEASURE_CACHE_LIMIT = 60;

/**
 * A gyorsítótár kulcsa a KÉRÉS paramétereiből épül (nem a feloldott
 * időpontokból): a `days=3` két hívása között eltelik néhány ms, ezért a
 * feloldott `from`/`to` mindig más lenne, és a gyorsítótár soha nem találna.
 */
function cacheKeyOf(scope, id, workspace, fromText, toText, days, profile) {
  return [scope, String(id ?? ""), String(workspace ?? ""), String(fromText ?? ""), String(toText ?? ""), String(days ?? ""), String(profile ?? "")].join("|");
}

function cacheGet(key) {
  const hit = measureCache.get(key);
  if (hit === undefined) return null;
  if (Date.now() - hit.at > MEASURE_CACHE_MILLISECONDS) {
    measureCache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, value) {
  if (measureCache.size >= MEASURE_CACHE_LIMIT) {
    const oldest = measureCache.keys().next();
    if (!oldest.done) measureCache.delete(oldest.value);
  }
  measureCache.set(key, { at: Date.now(), value });
}

const routes = [
  // ---------------------------------------------------------------- életjel
  ["/koltseg/ping", (req, res) => {
    ok(res, {
      version: pluginVersion(),
      pluginRoot: PACKAGE_ROOT,
      repoRoot: REPO_ROOT,
      stateDir: STATE_DIR,
      configPath: configPath(STATE_DIR),
      node: process.version,
      today: today(),
    });
  }],

  // ------------------------------------------------------------ konfiguráció
  ["/koltseg/config", async (req, res) => {
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const saved = saveConfig(STATE_DIR, body);
      // Az óradíj/profil/ÁFA változása érvényteleníti a mérés-gyorsítótárat.
      measureCache.clear();
      logRoute(`config mentve (${saved.errors.length} normalizálás)`);
      return ok(res, { config: saved.config, errors: saved.errors, path: saved.path, profiles: profilesOf(saved.config) });
    }
    const loaded = loadConfig(STATE_DIR);
    const workspace = await resolveWorkspace(urlOf(req).searchParams);
    const resolved = resolveRate(loaded.config, workspace);
    return ok(res, {
      config: loaded.config,
      source: loaded.source,
      error: loaded.error,
      path: loaded.path,
      profiles: profilesOf(loaded.config),
      resolved: {
        workspace,
        rate: resolved.rate,
        rateSource: resolved.rateSource,
        profileId: resolved.profileId,
        profile: profileOf(loaded.config, resolved.profileId),
      },
    });
  }],

  // ---------------------------------------------------------- munkaterületek
  ["/koltseg/workspaces", async (req, res) => {
    const registered = registryWorkspaces();
    if (registered.length > 0) {
      return ok(res, { workspaces: registered, source: "registry" });
    }
    const fromLogs = await workspaceList();
    return ok(res, { workspaces: fromLogs, source: "logs" });
  }],

  // ------------------------------------------------------------ munkafolyamat
  ["/koltseg/sessions", async (req, res) => {
    const url = urlOf(req);
    const workspace = await resolveWorkspace(url.searchParams);
    const window = resolveWindow(url.searchParams);
    const since = window.from - 7 * 24 * 3600000;
    const sessions = await sessionList({ workspace, since });
    return ok(res, { workspace, sessions });
  }],

  // ------------------------------------------------------------------- mérés
  ["/koltseg/measure", async (req, res) => {
    const url = urlOf(req);
    const scope = url.searchParams.get("scope") === "session" ? "session" : "workspace";
    if (scope === "session" && (url.searchParams.get("id") ?? "").length === 0) {
      return fail(res, Object.assign(new Error("hiányzó id a munkafolyamat-hatókörhöz"), { code: "BAD_REQUEST" }));
    }
    const loaded = loadConfig(STATE_DIR);
    const window = resolveWindow(url.searchParams);
    const workspace = await resolveWorkspace(url.searchParams);
    const profileId = url.searchParams.get("profile") ?? "";
    const sessionId = url.searchParams.get("id") ?? "";

    // Gyorsítótár: a panel megnyitása/újranyitása ne számoljon újra.
    // `fresh=1` megkerüli (a „Frissítés" gomb és a CSV).
    const fresh = url.searchParams.get("fresh") === "1";
    const key = cacheKeyOf(
      scope,
      sessionId,
      workspace,
      url.searchParams.get("from") ?? "",
      url.searchParams.get("to") ?? "",
      url.searchParams.get("days") ?? "",
      profileId,
    );
    if (!fresh) {
      const hit = cacheGet(key);
      if (hit !== null) return ok(res, { ...hit.value, cached: true, cachedAt: hit.at });
    }

    const result = await measure({
      scope,
      sessionId,
      workspace,
      from: window.from,
      to: window.to,
      config: loaded.config,
      profileId,
      stateDir: STATE_DIR,
    });
    cacheSet(key, result);
    logRoute(`meres: ${scope} ${workspace} ${result.minutes.toFixed(1)} perc ${result.amount.net} Ft`);
    return ok(res, result);
  }],

  ["/koltseg/export", async (req, res) => {
    const url = urlOf(req);
    const scope = url.searchParams.get("scope") === "session" ? "session" : "workspace";
    const loaded = loadConfig(STATE_DIR);
    const window = resolveWindow(url.searchParams);
    const workspace = await resolveWorkspace(url.searchParams);
    const result = await measure({
      scope,
      sessionId: url.searchParams.get("id") ?? "",
      workspace,
      from: window.from,
      to: window.to,
      config: loaded.config,
      profileId: url.searchParams.get("profile") ?? "",
      stateDir: STATE_DIR,
    });
    const csv = measureCsv(result);
    return sendCsv(res, `koltseg-${result.workspaceLabel || "munkaterulet"}-${result.fromDay}-${result.toDay}.csv`, csv);
  }],

  // -------------------------------------------------------------- aktivitás
  ["/koltseg/activity", async (req, res) => {
    const body = await readJsonBody(req, 128 * 1024);
    const items = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
    const workspace = typeof body.workspace === "string" ? body.workspace : "";
    const written = appendActivity(STATE_DIR, items, workspace);
    return ok(res, { written: written.written, dropped: written.dropped });
  }],

  // ------------------------------------------------------------------ ledger
  ["/koltseg/log", async (req, res) => {
    // Kliens-oldali diagnosztika. MIÉRT: a böngésző `console.warn`-ja nem jut el
    // a hostig, ezért a „nem látszik a gomb” típusú hibát csak így lehet mérni
    // (melyik slot regisztrálódott, mountolt-e a komponens, mekkora a doboza).
    const body = await readJsonBody(req, 32 * 1024);
    const text = typeof body.text === "string" ? body.text.slice(0, 400) : "";
    if (text.length > 0) {
      const file = join(STATE_DIR, "koltseg", "client.log");
      try {
        appendFileSync(file, `${new Date().toISOString()} ${text}\n`, "utf8");
      } catch {
        /* a diagnosztika hibája nem állíthatja meg a felületet */
      }
    }
    return ok(res, { logged: text.length > 0 });
  }],

  ["/koltseg/ledger", async (req, res) => {
    const url = urlOf(req);
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const saved = appendLedger(STATE_DIR, body);
      if (!saved.ok) return fail(res, Object.assign(new Error(saved.error), { code: "BAD_REQUEST" }));
      logRoute(`ledger rögzítés: ${saved.entry.id} ${saved.entry.net} Ft`);
      return ok(res, { entry: saved.entry });
    }
    if (req.method === "DELETE") {
      const removed = removeLedger(STATE_DIR, url.searchParams.get("id") ?? "");
      if (!removed.ok) return fail(res, Object.assign(new Error(removed.error), { code: "BAD_REQUEST" }));
      return ok(res, { removed: removed.removed });
    }
    if ((url.searchParams.get("format") ?? "") === "csv") {
      const { entries } = readLedger(STATE_DIR);
      return sendCsv(res, "koltseg-elszamolasok.csv", ledgerCsv(entries));
    }
    const { entries, bad, path } = readLedger(STATE_DIR);
    const totals = entries.reduce((acc, entry) => ({
      net: acc.net + (Number(entry.net) || 0),
      gross: acc.gross + (Number(entry.gross) || 0),
      minutes: acc.minutes + (Number(entry.minutes) || 0),
    }), { net: 0, gross: 0, minutes: 0 });
    return ok(res, { entries, totals, bad, path });
  }],
];

/** A workspace-registry, ha a profilban elérhető (a boot sorrend miatt lehet, hogy nem). */
let registryRef = null;

function registryWorkspaces() {
  try {
    const registry = registryRef;
    if (registry === undefined || registry === null || typeof registry.list !== "function") return [];
    return registry.list().map((workspace) => ({
      id: String(workspace.id ?? ""),
      path: String(workspace.path ?? ""),
      label: String(workspace.title ?? ""),
      sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
    }));
  } catch {
    return [];
  }
}

/** Mérés -> CSV. Session-hatókörben körönként, munkaterület-hatókörben session-önként. */
function measureCsv(result) {
  const lines = [];
  if (result.scope === "session") {
    lines.push("kor;kezdes;vege;agent_perc;olvasas_perc;gepeles_perc;forras");
    for (const row of result.turns) {
      lines.push([
        String(row.turn),
        new Date(row.start).toISOString(),
        new Date(row.end).toISOString(),
        (row.agentMs / 60000).toFixed(2).replace(".", ","),
        (row.readMs / 60000).toFixed(2).replace(".", ","),
        (row.typeMs / 60000).toFixed(2).replace(".", ","),
        row.humanSource,
      ].join(";"));
    }
  } else {
    lines.push("session;elso;utolso;korok;agent_perc;olvasas_perc;gepeles_perc;brutto_perc;forras");
    for (const row of result.sessions) {
      lines.push([
        row.id,
        new Date(row.firstAt).toISOString(),
        new Date(row.lastAt).toISOString(),
        String(row.turns),
        (row.agentMs / 60000).toFixed(2).replace(".", ","),
        (row.readMs / 60000).toFixed(2).replace(".", ","),
        (row.typeMs / 60000).toFixed(2).replace(".", ","),
        (row.grossMs / 60000).toFixed(2).replace(".", ","),
        row.humanSource,
      ].join(";"));
    }
  }
  lines.push("");
  lines.push(`# munkaterulet;${result.workspaceLabel || result.workspace}`);
  lines.push(`# idoszak;${result.fromDay};${result.toDay}`);
  lines.push(`# profil;${result.profile.name} (${result.profile.id})`);
  lines.push(`# oradij;${result.rate}`);
  lines.push(`# elszamolhato_perc;${result.minutes.toFixed(2).replace(".", ",")}`);
  lines.push(`# netto;${result.amount.net}`);
  if (result.vatPercent > 0) {
    lines.push(`# afa;${result.amount.vat}`);
    lines.push(`# brutto;${result.amount.gross}`);
  }
  return `${lines.join("\n")}\n`;
}

export const inject = ["webServer"];

export function apply(ctx) {
  if (ctx.webServer === undefined) return;
  // A workspace-registry szolgáltatás neve verziófüggő: ha nincs, a naplókból
  // dolgozunk (a lista akkor is működik).
  try {
    if (typeof ctx.get === "function") {
      const registry = ctx.get("workspaceRegistry");
      if (registry !== undefined && registry !== null) registryRef = registry;
    }
  } catch {
    registryRef = null;
  }

  for (const [path, handler] of routes) {
    ctx.effect(() => {
      try {
        const dispose = ctx.webServer.register({
          path,
          handler: (req, res) => {
            Promise.resolve(handler(req, res)).catch((error) => {
              logRoute(`route ${path}: hiba: ${error?.message ?? error}`);
              fail(res, error);
            });
          },
        });
        logRoute(`route ${path}: ok`);
        return dispose;
      } catch (error) {
        logRoute(`route ${path}: hiba: ${error?.message ?? error}`);
        return () => {};
      }
    }, `koltseg: ${path}`);
  }
}

export { REPO_ROOT, STATE_DIR, PACKAGE_ROOT, dayOf, dayStart };

