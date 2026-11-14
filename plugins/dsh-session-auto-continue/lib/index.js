/**
 * dsh-session-auto-continue — a MEGSZAKADT beszélgetés folytatása boot után.
 *
 * MIÉRT: a harness leállásakor a session naplója félkörben marad. A mag ezt
 * betöltéskor JAVÍTJA (`interruptedTurnClosers`, `dsh-session/lib/index.js`
 * ~593–710): szintetikus `turn/end` eseményt fűz be
 * `data.reason.kind === "interrupted"` jelöléssel. A session tehát nem marad
 * nyitva — de nem is FOLYTATÓDIK: a felhasználónak kellett eddig kézzel
 * továbbindítania. Ez a plugin ezt a kört magától újraindítja.
 *
 * HOGYAN: a `sessionController.prompt()` a mag hivatalos belépője (ugyanaz,
 * amit a böngésző használ): `dsh-api-session-controller/lib/index.js:736`
 * (`async prompt`), a szolgáltatás neve `sessionController`
 * (`:2726` `super(ctx, "sessionController", ...)`). A metódus a
 * `resolveAgent(sessionId)` után `agent.followup(message)`-t hív (`:773–774`),
 * vagyis pontosan egy felhasználói üzenetet ad be.
 *
 * MIKOR INDUL: boot után 8 s-mal (a webes felület reconnectja), és CSAK arra a
 * sessionre, aminek az utolsó kör-határa egy `interrupted` `turn/end`.
 *
 * KORLÁTOK (ezek nélkül ez egy végtelen hurok és pénzégetés lenne):
 *  - legfeljebb 2 session bootonként,
 *  - a megszakadás legfeljebb 6 órás lehet (régi sessiont nem támasztunk fel),
 *  - session + szekvencia szerinti jelölő a `state\auto-continue.json`-ban:
 *    ugyanaz a megszakadt kör NEM folytatódik kétszer,
 *  - kikapcsolás: `state\no-auto-continue` jelölő vagy `DSH_NO_AUTO_CONTINUE=1`,
 *  - a prompt szövege kimondja, hogy ellenőrizze az állapotot, ne ismételjen
 *    vakon — a félbemaradt lépés mellékhatásai így nem duplázódnak.
 *
 * NAPLÓ: `state\auto-continue.log` (minden döntés és hiba oda megy).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

/** A plugin neve a boot gráfban. */
export const name = "dsh-session-auto-continue";

/**
 * Deklarált szolgáltatások: `sessions` (SessionStore, `dsh-session/lib/index.js:1311`)
 * és a PROMPT-belépő `sessionController`
 * (`dsh-api-session-controller/lib/index.js:2726`). A cordis CSAK a deklarált
 * szolgáltatást engedi olvasni (`cannot get property … without inject`, mért
 * hiba 2026-11-14 04:05), ezért kell itt deklarálni. Ha a `sessionController`
 * nincs a kompozícióban, az `apply` nem fut le — ezt a boot-napló hiánya mutatja.
 */
export const inject = ["sessions", "sessionController"];

/** A plugin gyökere (a repó `plugins\dsh-session-auto-continue` mappája). */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A repó `state\` mappája. */



/** A DSH home és a session-tároló gyökere (`<home>\sessions\<projekt>\<id>\session.v3.jsonl.zstd`). */
const DSH_HOME = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : join(homedir(), ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const SESSION_LOG_NAME = "session.v3.jsonl.zstd";
const SESSION_LOG_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * A naplók gyökere — TESZTBŐL felülbírálható.
 *
 * MIÉRT: az egységteszt (2026-11-14) e nélkül a VALÓDI session-naplóimat
 * olvasta, megtalálta a nyitott kört, és a „nem küld" esetek is küldtek —
 * 2/4 teszt elhasalt. A `DSH_AUTO_CONTINUE_SESSIONS_ROOT` egy üres temp
 * mappára állítva izolálja a tesztet.
 * @returns {string}
 */
function sessionsRoot() {
  const override = process.env.DSH_AUTO_CONTINUE_SESSIONS_ROOT;
  if (typeof override === "string" && override.length > 0) return override;
  return join(typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"), "sessions");
}
/**
 * A plugin állapot-mappája — TESZTBŐL felülbírálható.
 *
 * MIÉRT: az egységteszt a VALÓDI `state\` mappát használta, ahol a
 * `no-auto-continue` jelölő (2026-11-14, a hibás prompt-út miatt) minden
 * tesztesetet kikapcsolt — 3/4 teszt elhasalt. A
 * `DSH_AUTO_CONTINUE_STATE_DIR` egy temp mappára állítva izolál.
 * @returns {string}
 */
function stateDir() {
  const override = process.env.DSH_AUTO_CONTINUE_STATE_DIR;
  if (typeof override === "string" && override.length > 0) return override;
  return join(PACKAGE_ROOT, "..", "..", "state");
}

/** @returns {string} a jelölőfájl (dupla küldés ellen). */
function markerPath() {
  return join(stateDir(), "auto-continue.json");
}

/** @returns {string} a naplófájl. */
function logPath() {
  return join(stateDir(), "auto-continue.log");
}

/** @returns {string} a kikapcsoló jelölő. */
function offPath() {
  return join(stateDir(), "no-auto-continue");
}

/** Legfeljebb ennyi session folytatódik egy booton. */
const MAX_SESSIONS = 2;

/** Ennél régebbi megszakadást nem folytatunk (6 óra). */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A folytatás beadása a HOST HTTP RPC-n — ez a MŰKÖDŐ út.
 *
 * MIÉRT NEM a szolgáltatás közvetlen hívása: a `sessionController.prompt()`
 * folyamaton belüli hívása `Cannot read properties of undefined (reading
 * 'throwIfAborted')` hibát ad (mért 2026-11-14 05:06), mert a typert réteg a
 * híváshoz `signal`-t (cancellation) ad, a `resume()` pedig nem is létezik a
 * szolgáltatáson. A böngésző viszont ugyanezt a metódust a `/api` transzporton
 * keresztül éri el, ahol a kontextus megvan.
 *
 * A protokoll (mért, 2026-11-14 06:4x):
 *   1. GET `state\harness.url` (token) -> `dsh-auth-…` süti,
 *   2. POST `<origin>/api/session/prompt`,
 *      `{ type:"client-request", rpcId, method:"session/prompt",
 *         payload:{ args:{ request:{ sessionId, requestId, mode:"queue",
 *                                   content:[{type:"text", text}] } } } }`,
 *   3. a válasz `{ result:{ ok:true, value:{ accepted:true } } }`.
 * A `mode` KÖTELEZŐ (`queue` | `steer`), a `requestId`/`sessionId` string.
 * @param {string} sessionId
 * @returns {Promise<string|null>} hibaüzenet vagy null siker esetén.
 */
async function promptViaHttp(sessionId) {
  // A token-forrás: `state\harness.url`, és ha az sérült/üres, akkor a
  // `state\harness.log` (amit a harness maga ír). Mért eset (2026-11-14): a
  // restart-szkript egy hibája miatt a `harness.url` egyetlen KARAKTER volt
  // („M", majd „I"), és a folytatás emiatt hasalt el — a naplóból viszont
  // mindig kinyerhető az érvényes URL.
  const urlPattern = /^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+$/u;
  const readUrlSource = () => {
    const candidates = [];
    if (process.env.DSH_AUTO_CONTINUE_BASE_URL) candidates.push(process.env.DSH_AUTO_CONTINUE_BASE_URL);
    try { candidates.push(readFileSync(join(stateDir(), "harness.url"), "utf8").trim()); } catch { /* nincs fájl */ }
    try {
      const log = readFileSync(join(stateDir(), "harness.log"), "utf8");
      const found = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u);
      if (found !== null) candidates.push(found[0]);
    } catch { /* nincs napló */ }
    return candidates.find((value) => urlPattern.test(value)) ?? null;
  };
  const base = readUrlSource();
  if (base === null) return "a harness.url és a harness.log sem tartalmaz érvényes token-URL-t";
  const origin = new URL(base).origin;
  // 1) token -> süti
  let cookie = "";
  try {
    const login = await fetch(base, { redirect: "manual" });
    const raw = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
    cookie = raw.map((value) => value.split(";", 1)[0]).join("; ");
    if (cookie.length === 0) return `a token-csere nem adott sütit (HTTP ${login.status})`;
  } catch (error) {
    return `a token-csere nem sikerült: ${String(error?.message ?? error)}`;
  }
  // 2) a prompt RPC
  const envelope = {
    type: "client-request",
    rpcId: randomUUID(),
    method: "session/prompt",
    payload: {
      args: {
        request: {
          sessionId,
          requestId: randomUUID(),
          mode: "queue",
          content: [{ type: "text", text: CONTINUE_TEXT }]
        }
      }
    }
  };
  try {
    const response = await fetch(`${origin}/api/session/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(envelope)
    });
    const body = await response.json();
    const result = body?.result;
    if (result?.ok === true && result?.value?.accepted === true) return null;
    return result?.error?.message ?? `HTTP ${response.status}`;
  } catch (error) {
    return `a prompt RPC nem sikerült: ${String(error?.message ?? error)}`;
  }
}

/** Mély fagyasztás — a mag `freezeMessage`-ének a mintája. */
function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Felhasználói üzenet építése a MAG mintája szerint.
 *
 * A `@deepseek-ai/dsh-llm` `createUserMessage` ennyi: `createMessage({...input,
 * role: "user"})` → `{ ...input, role: "user", id: randomUUID() }`, majd
 * `deepFreeze(structuredClone(message))`. Ezt itt helyben megismételjük, mert a
 * plugin a repóból töltődik (nincs `node_modules`), a csomag importja pedig a
 * junction valódi útvonala miatt bukna — ugyanaz a buktató, mint a
 * `dsh-terminal-tool`-nál.
 * @param {string} requestId
 * @returns {object} fagyasztott user-üzenet.
 */
function buildUserMessage(requestId) {
  const message = {
    role: "user",
    content: [{ type: "text", text: CONTINUE_TEXT }],
    source: { kind: "user", rpcId: requestId },
    id: randomUUID()
  };
  return deepFreeze(structuredClone(message));
}

/**
 * Boot utáni próbák (ms). MIÉRT NEM ELÉG HÁROM: a sessionök a memóriabeli
 * store-ban élnek, és csak akkor kerülnek bele, amikor a felület MEGNYITJA
 * őket — mért eset (2026-11-14 04:47): a boot után 8/20/45 s-mal a store még
 * nem tartalmazta ezt a beszélgetést (`nincs megszakadt kör (3 session)`),
 * holott a naplója nyitott `turn/start#5972`-vel végződött és a farok
 * `tool/call, approval/asked, approval/decided` volt. Ezért ~3 percig
 * figyelünk, 10 s-onként; a jelölő és a `sentOnce` zárja ki az ismétlést.
 */
const DELAYS_MS = [8000, 20000, 45000, ...Array.from({ length: 15 }, (_value, index) => 60000 + index * 10000)];

/** Ebben a bootban már küldtünk-e folytatást (a további próbák kilépnek). */
let sentOnce = false;

/** A beadott üzenet — szándékosan elővigyázatos. */
const CONTINUE_TEXT = "Automatikus folytatás: a harness újraindult, miközben a kör futott. "
  + "Folytasd ott, ahol abbamaradt, és fejezd be a folyamatban lévő munkát. "
  + "Ha egy lépés félbemaradt, előbb ellenőrizd a valós állapotát (fájl, folyamat, kimenet), "
  + "és csak utána ismételd — ne hajts végre mellékhatásos műveletet vakon.";

/**
 * @param {string} line
 */
function log(line) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* a napló hibája nem hathat a bootra */
  }
}

/** @returns {Record<string, boolean>} */
function readMarkers() {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, boolean>} markers
 */
function writeMarkers(markers) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify(markers, null, 2), "utf8");
  } catch {
    /* nem kritikus */
  }
}

/** A kikapcsolás bármely módja. */
function disabled() {
  if (process.env.DSH_NO_AUTO_CONTINUE === "1") return "kikapcsolva (DSH_NO_AUTO_CONTINUE=1)";
  if (existsSync(offPath())) return `kikapcsolva (${offPath()})`;
  return null;
}

/**
 * A megszakadt kör keresése. KÉT jel számít:
 *  (a) az utolsó kör-határ egy `interrupted` `turn/end` — ezt a mag
 *      crash-javítása fűzi be (`interruptedTurnClosers`), de MÉRÉS szerint
 *      (2026-11-14) NEM fut automatikusan bootkor, csak restore/resume útvonalon;
 *  (b) NYITOTT kör: az utolsó kör-határ `turn/start` `turn/end` nélkül — ez a
 *      nyers crash-állapot, amit a javítás még nem zárt le.
 * @param session
 * @returns {object|null} a jelölt (session, key, seq, lastAt) vagy null.
 */
function interruptedCandidate(session) {
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return null;
  }
  if (Array.isArray(events) !== true || events.length === 0) return null;
  let boundary = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]?.type;
    if (type === "turn/start" || type === "turn/end") {
      boundary = events[index];
      break;
    }
  }
  if (boundary === null) return null;
  // KÉT JEL, mert a crash-javítás NEM fut le automatikusan bootkor (mért:
  // 2026-11-14 04:41, `nincs megszakadt kör (3 session vizsgálva)`, pedig a kör
  // nyitva maradt):
  //  (a) `interrupted` `turn/end` — a javított napló;
  //  (b) NYITOTT `turn/start` `turn/end` nélkül — a nyers crash-állapot.
  // A (b) nem lő bele élő körbe: ha a kör TÉNYLEG fut, a prompt `agent-busy`
  // hibát ad (dsh-api-session-controller:785), amit a hívó „később újra"-ként
  // kezel — a jelölőt ilyenkor NEM írjuk be.
  const open = boundary.type === "turn/start";
  if (open !== true && boundary.data?.reason?.kind !== "interrupted") return null;
  const lastAt = Number(boundary.time ?? Number.NaN);
  if (Number.isFinite(lastAt) !== true) return null;
  const key = `${String(session.id)}:${String(boundary.seq)}:${open ? "open" : "interrupted"}`;
  return { session, key, seq: boundary.seq, lastAt, open };
}

/**
 * A legfrissebb session-naplók a lemezen (session-attach nélkül).
 *
 * MIÉRT KELL: a `ctx.sessions` store csak a MEGNYITOTT sessionöket tartalmazza,
 * a boot után tehát üres lehet — mért eset (2026-11-14 04:58): 18 próba alatt
 * mindig `nincs megszakadt kör (3 session)`, pedig ennek a beszélgetésnek a
 * naplója nyitott `turn/start#5972`-vel végződött, mert a WebView2 ablak nem
 * csatlakozott. A napló viszont ott van a lemezen:
 * `<DSH_HOME>\sessions\<projekt>\<id>\session.v3.jsonl.zstd`.
 * @param {number} limit
 * @returns {{id: string, file: string, mtime: number}[]} a legfrissebbek elöl.
 */
function listRecentSessionFiles(limit) {
  const found = [];
  let projects = [];
  try {
    projects = readdirSync(sessionsRoot());
  } catch {
    return found;
  }
  for (const project of projects) {
    const projectPath = join(sessionsRoot(), project);
    let ids = [];
    try {
      ids = readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = join(projectPath, id, SESSION_LOG_NAME);
      if (existsSync(file) !== true) continue;
      try {
        found.push({ id, file, mtime: statSync(file).mtimeMs });
      } catch {
        /* a fájl eltűnt: kihagyjuk */
      }
    }
  }
  found.sort((left, right) => right.mtime - left.mtime);
  return found.slice(0, limit);
}

/**
 * A naplófájl UTOLSÓ kör-határa.
 *
 * A fájl egymás után fűzött zstd-frame-ekből áll; a `zstdDecompressSync` csak az
 * ELSŐ frame-et adja vissza (mért viselkedés, 2026-11-14: 1 esemény 5999
 * helyett), ezért a frame-varázsszámnál (`28 B5 2F FD`) vágunk, és az utolsó
 * néhány frame-et bontjuk ki — a kör-határ mindig a farokban van.
 * @param {string} file
 * @returns {{type: string, seq: number, time: number, reason: string}|null}
 */
function lastBoundaryFromDisk(file) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return null;
  }
  const offsets = [];
  let index = buffer.indexOf(SESSION_LOG_MAGIC, 0);
  while (index >= 0) {
    offsets.push(index);
    index = buffer.indexOf(SESSION_LOG_MAGIC, index + 4);
  }
  if (offsets.length === 0) return null;
  // HÁTULRÓL, frame-enként: a naplóban frame-enként ~1 esemény van (mért:
  // 3408 frame / 5999 esemény), ezért az utolsó 6 frame NEM tartalmazza a
  // kör-határt (mért eredmény: `null`, miközben a valódi határ `turn/start#6048`).
  // A hátulról induló keresés az első talált határnál megáll — az a legfrissebb.
  const stopAt = Math.max(0, offsets.length - 600);
  for (let position = offsets.length - 1; position >= stopAt; position -= 1) {
    const start = offsets[position];
    const end = position + 1 < offsets.length ? offsets[position + 1] : buffer.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    } catch {
      continue;
    }
    let local = null;
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const type = event?.type;
      if (type !== "turn/start" && type !== "turn/end") continue;
      local = {
        type,
        seq: Number(event.seq ?? -1),
        time: Number(event.time ?? 0),
        reason: String(event?.data?.reason?.kind ?? "")
      };
    }
    if (local !== null) return local;
  }
  return null;
}

/**
 * Szolgáltatás olvasása DEFENZÍVEN.
 *
 * MIÉRT: a cordis nem engedi olvasni a nem-injektált szolgáltatást —
 * `cannot get property "sessionController" without inject` (mért hiba
 * 2026-11-14 04:05). Mivel a prompt-belépő helye verziófüggő, a `sessions` az
 * egyetlen deklarált szolgáltatás, a többit csak MEGNÉZZÜK, hibatűrően.
 * @param {object} ctx
 * @param {string} name
 * @returns {any|null}
 */
function serviceOrNull(ctx, name) {
  try {
    return ctx[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * A prompt-belépő feloldása. A magban a `SessionCommandController.prompt`
 * (`dsh-api-session-controller/lib/index.js:736`) a megvalósítás, amely a
 * host-síkon `sessionController` néven regisztrálódik (`:2726`) — de a
 * szolgáltatás neve verziófüggő lehet, ezért több helyen is megnézzük, és a
 * napló kimondja, melyiket használtuk.
 * @param {object} ctx
 * @returns {{prompt: Function, via: string}|null}
 */
function resolvePrompt(ctx) {
  for (const [via, holder] of [
    ["sessionController", serviceOrNull(ctx, "sessionController")],
    ["sessionCommands", serviceOrNull(ctx, "sessionCommands")],
    ["sessions", serviceOrNull(ctx, "sessions")]
  ]) {
    if (holder !== null && holder !== undefined && typeof holder.prompt === "function") {
      return { prompt: holder.prompt.bind(holder), via };
    }
  }
  return null;
}

/** A registry szolgáltatás-nevei (diagnosztika: ebből derül ki a helyes név). */
function listServiceNames(ctx) {
  try {
    const registry = ctx.registry;
    if (registry === null || registry === undefined || typeof registry.values !== "function") {
      return "(nincs registry)";
    }
    const names = [];
    for (const runtime of registry.values()) {
      const candidate = runtime?.name ?? runtime?.service?.name ?? runtime?.ctx?.name;
      if (typeof candidate === "string" && candidate.length > 0) names.push(candidate);
    }
    names.sort();
    return names.length > 0 ? names.join(",") : "(üres registry)";
  } catch (error) {
    return `(registry hiba: ${String(error?.message ?? error)})`;
  }
}

/** A naplóba írt diagnosztika arról, mi érhető el (egy sor, bootonként egyszer). */
function describeSurface(ctx) {
  const surface = (holder) => {
    if (holder === null || holder === undefined) return "nincs";
    return ["prompt", "resume", "list", "get", "followup"]
      .map((name) => `${name}:${typeof holder[name] === "function" ? "igen" : "nem"}`)
      .join(",");
  };
  return `sessions[${surface(serviceOrNull(ctx, "sessions"))}] `
    + `sessionController[${surface(serviceOrNull(ctx, "sessionController"))}]`;
}

/**
 * @param {object} ctx
 */
async function runOnce(ctx) {
  const off = disabled();
  if (off !== null) {
    log(off);
    return;
  }
  // A folytatás a HOST HTTP RPC-n megy (`/api/session/prompt`), ezért a
  // folyamaton belüli prompt-belépő NEM feltétel — csak diagnosztika.
  if (resolvePrompt(ctx) === null) {
    log(`megjegyzés: nincs folyamaton belüli prompt-belépő (${describeSurface(ctx)}) — a HTTP RPC-t használjuk | szolgáltatások: ${listServiceNames(ctx)}`);
  }
  const markers = readMarkers();
  const now = Date.now();
  // A MOSTANI harness indulása: ami ez UTÁN történt, az nem összeomlás.
  const harnessStart = now - Math.round(process.uptime() * 1000);
  /** @type {{sessionId: string, key: string, seq: number, lastAt: number, open: boolean, fromDisk: boolean}[]} */
  const candidates = [];
  let sessions = [];
  try {
    sessions = ctx.sessions.list();
  } catch (error) {
    log(`a session-lista nem olvasható: ${String(error?.message ?? error)}`);
    sessions = [];
  }
  /** @type {Set<string>} */
  const attached = new Set();
  for (const session of sessions) {
    const candidate = interruptedCandidate(session);
    if (candidate === null) continue;
    attached.add(String(session.id));
    if (now - candidate.lastAt > MAX_AGE_MS) continue;
    // ÉLŐ SESSION KIZÁRÁSA: ha a kör-határ a mostani boot UTÁN van, a session
    // dolgozik (a nyitott turn futó kört jelent, nem összeomlást).
    if (candidate.lastAt >= harnessStart) continue;
    if (markers[candidate.key] === true) continue;
    candidates.push({
      sessionId: String(session.id),
      key: candidate.key,
      seq: candidate.seq,
      lastAt: candidate.lastAt,
      open: candidate.open === true,
      fromDisk: false
    });
  }
  // A store csak a MEGNYITOTT sessionöket tartalmazza. Ha ott nincs jelölt,
  // a legfrissebb naplókat MAGUNK olvassuk ki a lemezről, és `resume()`-szal
  // csatoljuk őket — enélkül a boot utáni folytatás a felületre várna.
  if (candidates.length === 0) {
    for (const recent of listRecentSessionFiles(3)) {
      if (attached.has(recent.id)) continue;
      // ÉLŐ SESSION KIZÁRÁSA. Ha a napló a MOSTANI boot után íródott, akkor a
      // session dolgozik — a nyitott `turn/start` nem összeomlás, hanem futó
      // kör. Mért hiba (2026-11-14 06:56): enélkül a plugin egy ÉLŐ
      // beszélgetésbe tett be egy „Automatikus folytatás" üzenetet, ami a
      // `mode:"queue"` miatt nem hibázott, hanem SORBA ÁLLT — a felhasználó
      // „2 várakozó üzenet"-et látott.
      if (Number.isFinite(recent.mtime) && recent.mtime >= harnessStart) continue;
      const boundary = lastBoundaryFromDisk(recent.file);
      if (boundary === null) continue;
      const open = boundary.type === "turn/start";
      if (open !== true && boundary.reason !== "interrupted") continue;
      if (Number.isFinite(boundary.time) !== true || now - boundary.time > MAX_AGE_MS) continue;
      // Ugyanez a határ időben is: a kör-határ nem lehet a boot utáni.
      if (boundary.time >= harnessStart) continue;
      const key = `${recent.id}:${boundary.seq}:${open ? "open" : "interrupted"}`;
      if (markers[key] === true) continue;
      candidates.push({ sessionId: recent.id, key, seq: boundary.seq, lastAt: boundary.time, open, fromDisk: true });
    }
    if (candidates.length > 0) {
      log(`lemezről talált megszakadt kör: ${candidates.map((candidate) => `${candidate.sessionId}@${candidate.seq}${candidate.open ? "(open)" : "(interrupted)"}`).join(", ")}`);
    }
  }
  if (candidates.length === 0) {
    log(`nincs megszakadt kör (${sessions.length} session a store-ban, ${listRecentSessionFiles(3).length} friss napló a lemezen)`);
    return;
  }
  candidates.sort((left, right) => right.lastAt - left.lastAt);
  const chosen = candidates.slice(0, MAX_SESSIONS);
  for (const candidate of chosen) {
    const sessionId = candidate.sessionId;
    try {
      // A MŰKÖDŐ ÚT: host HTTP RPC (`/api/session/prompt`). A folyamaton belüli
      // `prompt()`/`followup()` nem járható (lásd `promptViaHttp` fejlécét).
      const failure = await promptViaHttp(sessionId);
      if (failure !== null) {
        if (String(failure).includes("agent-busy")) {
          log(`a kör éppen fut (agent-busy), később újra: ${String(sessionId)}`);
          continue;
        }
        log(`a folytatás nem sikerült (${String(sessionId)}): ${failure}`);
        continue;
      }
      markers[candidate.key] = true;
      writeMarkers(markers);
      sentOnce = true;
      log(`folytatás elküldve (HTTP RPC): ${String(sessionId)} (seq ${String(candidate.seq)}, open=${String(candidate.open)}, lemez=${String(candidate.fromDisk)})`);
    } catch (error) {
      log(`a folytatás nem sikerült (${String(sessionId)}): ${String(error?.message ?? error)}`);
    }
  }
}

/**
 * @param {object} ctx
 */
export function apply(ctx) {
  try {
    // HÁROM PRÓBA. A sessionök a memóriabeli store-ban élnek, és csak akkor
    // kerülnek bele, amikor a felület megnyitja őket — a boot utáni első
    // pillanatban tehát `0 session` a normális. Ezért 8 s / 20 s / 45 s-mal is
    // ránézünk; a jelölő és a `sentOnce` zárja ki az ismétlést.
    for (const [index, delay] of DELAYS_MS.entries()) {
      const timer = setTimeout(() => {
        if (sentOnce === true) return;
        void runOnce(ctx, index === DELAYS_MS.length - 1).catch((error) => log(`hiba: ${String(error?.message ?? error)}`));
      }, delay);
      timer.unref?.();
    }
    log(`boot: folytatás-figyelő indul (${DELAYS_MS.join("/")} ms)`);
  } catch (error) {
    log(`apply hiba: ${String(error?.message ?? error)}`);
  }
}
