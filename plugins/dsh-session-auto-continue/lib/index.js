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

/** Boot utáni próbák (ms): a sessionök csak akkor kerülnek a store-ba, amikor a felület megnyitja őket. */
const DELAYS_MS = [8000, 20000, 45000];

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
  const open = boundary.type === "turn/start";
  if (open !== true && boundary.data?.reason?.kind !== "interrupted") return null;
  const lastAt = Number(boundary.time ?? Number.NaN);
  if (Number.isFinite(lastAt) !== true) return null;
  const key = `${String(session.id)}:${String(boundary.seq)}:${open ? "open" : "interrupted"}`;
  return { session, key, seq: boundary.seq, lastAt, open };
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
    const sessionId = candidate.session.id;
    try {
      // A kontroller resume() a session-attach útvonala: ha van, előbb ezt
      // hívjuk, hogy a crash-javítás (interruptedTurnClosers) lefusson, és az
      // agent élő legyen a prompt előtt.
      for (const holder of [ctx.sessionController, ctx.sessions]) {
        if (holder !== null && holder !== undefined && typeof holder.resume === "function") {
          try {
            await holder.resume(sessionId);
            log(`resume: ${String(sessionId)}`);
          } catch (error) {
            log(`resume hiba (${String(sessionId)}): ${String(error?.message ?? error)}`);
          }
          break;
        }
      }
      await entry.prompt({
        sessionId,
        content: [{ type: "text", text: CONTINUE_TEXT }],
        requestId
      });
      markers[candidate.key] = true;
      writeMarkers(markers);
      sentOnce = true;
      log(`folytatás elküldve (${entry.via}): ${String(sessionId)} (seq ${String(candidate.seq)}, open=${String(candidate.open === true)}, requestId ${requestId})`);
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
