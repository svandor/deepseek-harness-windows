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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A plugin neve a boot gráfban. */
export const name = "dsh-session-auto-continue";

/**
 * A mag szolgáltatása: a session-lista (`ctx.sessions` = SessionStore,
 * `dsh-session/lib/index.js:1311` `super(ctx, "sessions")`). A prompt-belépőt
 * NEM injektáljuk, mert a telepítés szerint más néven él (`sessionController`)
 * — a futáskor keressük, és ha nincs, a napló kimondja.
 */
export const inject = ["sessions"];

/** A plugin gyökere (a repó `plugins\dsh-session-auto-continue` mappája). */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A repó `state\` mappája. */
const STATE_DIR = join(PACKAGE_ROOT, "..", "..", "state");
const MARKER_PATH = join(STATE_DIR, "auto-continue.json");
const LOG_PATH = join(STATE_DIR, "auto-continue.log");
const OFF_PATH = join(STATE_DIR, "no-auto-continue");

/** Legfeljebb ennyi session folytatódik egy booton. */
const MAX_SESSIONS = 2;

/** Ennél régebbi megszakadást nem folytatunk (6 óra). */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Boot utáni várakozás: a webes felület előbb reconnectáljon. */
const DELAY_MS = 8000;

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
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* a napló hibája nem hathat a bootra */
  }
}

/** @returns {Record<string, boolean>} */
function readMarkers() {
  try {
    const parsed = JSON.parse(readFileSync(MARKER_PATH, "utf8"));
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
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MARKER_PATH, JSON.stringify(markers, null, 2), "utf8");
  } catch {
    /* nem kritikus */
  }
}

/** A kikapcsolás bármely módja. */
function disabled() {
  if (process.env.DSH_NO_AUTO_CONTINUE === "1") return "kikapcsolva (DSH_NO_AUTO_CONTINUE=1)";
  if (existsSync(OFF_PATH)) return `kikapcsolva (${OFF_PATH})`;
  return null;
}

/**
 * A megszakadt kör keresése: az utolsó kör-határ egy `interrupted` `turn/end`.
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
  if (boundary?.type !== "turn/end") return null;
  if (boundary.data?.reason?.kind !== "interrupted") return null;
  const lastAt = Number(boundary.time ?? Number.NaN);
  if (Number.isFinite(lastAt) !== true) return null;
  const key = `${String(session.id)}:${String(boundary.seq)}`;
  return { session, key, seq: boundary.seq, lastAt };
}

/**
 * A prompt-belépő feloldása. A magban a `SessionCommandController.prompt`
 * (`dsh-api-session-controller/lib/index.js:736`) a megvalósítás, amely a
 * host-síkon `sessionController` néven regisztrálódik (`:2726`), de a
 * szolgáltatás neve verziófüggő lehet — ezért több helyen is megnézzük, és a
 * napló kimondja, melyiket használtuk.
 * @param {object} ctx
 * @returns {{prompt: Function, via: string}|null}
 */
function resolvePrompt(ctx) {
  for (const [via, holder] of [
    ["sessionController", ctx.sessionController],
    ["sessionCommands", ctx.sessionCommands],
    ["sessions", ctx.sessions]
  ]) {
    if (holder !== null && holder !== undefined && typeof holder.prompt === "function") {
      return { prompt: holder.prompt.bind(holder), via };
    }
  }
  return null;
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
  const entry = resolvePrompt(ctx);
  if (entry === null) {
    log("nincs prompt-belépő (sessionController/sessionCommands/sessions.prompt) — a folytatás nem indítható");
    return;
  }
  const markers = readMarkers();
  const now = Date.now();
  /** @type {object[]} */
  const candidates = [];
  let sessions = [];
  try {
    sessions = ctx.sessions.list();
  } catch (error) {
    log(`a session-lista nem olvasható: ${String(error?.message ?? error)}`);
    return;
  }
  for (const session of sessions) {
    const candidate = interruptedCandidate(session);
    if (candidate === null) continue;
    if (now - candidate.lastAt > MAX_AGE_MS) continue;
    if (markers[candidate.key] === true) continue;
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    log(`nincs megszakadt kör (${sessions.length} session vizsgálva)`);
    return;
  }
  candidates.sort((left, right) => right.lastAt - left.lastAt);
  const chosen = candidates.slice(0, MAX_SESSIONS);
  for (const candidate of chosen) {
    const requestId = `auto-continue-${randomUUID()}`;
    try {
      await entry.prompt({
        sessionId: candidate.session.id,
        content: [{ type: "text", text: CONTINUE_TEXT }],
        requestId
      });
      markers[candidate.key] = true;
      writeMarkers(markers);
      log(`folytatás elküldve (${entry.via}): ${String(candidate.session.id)} (seq ${String(candidate.seq)}, requestId ${requestId})`);
    } catch (error) {
      log(`a folytatás nem sikerült (${String(candidate.session.id)}): ${String(error?.message ?? error)}`);
    }
  }
}

/**
 * @param {object} ctx
 */
export function apply(ctx) {
  try {
    const timer = setTimeout(() => {
      void runOnce(ctx).catch((error) => log(`hiba: ${String(error?.message ?? error)}`));
    }, DELAY_MS);
    timer.unref?.();
    log(`boot: folytatás-figyelő indul (${DELAY_MS} ms múlva)`);
  } catch (error) {
    log(`apply hiba: ${String(error?.message ?? error)}`);
  }
}
