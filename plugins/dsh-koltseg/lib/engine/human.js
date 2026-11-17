/**
 * Emberi idő — olvasás és a következő prompt beírása.
 *
 * KÉT SZINT (a felhasználó döntése, 2026-11-16):
 *   A) napló-alapú tartalék: `min(következő kör kezdete − kör vége, idleCap)`;
 *      ez mindig működik, kliens nélkül is, de nem bontja olvasásra/gépelésre;
 *   B) kliens-mérés: a webes felület 5 s-os aktivitás-vödröket küld
 *      (`POST /koltseg/activity`), amiből a host meg tudja mondani, MIKOR
 *      kezdett el gépelni a felhasználó — így az olvasás és a gépelés külön
 *      komponens lesz.
 *
 * A kliens NEM küld szöveget, csak időbélyegeket: a mérés nem olvas bele a
 * beszélgetésbe.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { cappedLength, clip, overlapMs, subtract } from "./intervals.js";

/** Az aktivitás-napló neve (napi bontás nélkül; 5 MB fölött rotál). */
export const ACTIVITY_FILE = "activity.jsonl";

/** Rotálási küszöb: ennyi fölött `activity.<időbélyeg>.jsonl` lesz. */
const ROTATE_BYTES = 5 * 1024 * 1024;

/** Elfogadott aktivitás-fajták. A `hidden`/`visible` a lap láthatósága. */
const KINDS = new Set(["key", "pointer", "scroll", "hidden", "visible"]);

/** Az aktivitás-napló útvonala. */
export function activityPath(stateDir) {
  return join(stateDir, "koltseg", ACTIVITY_FILE);
}

/**
 * Egy aktivitás-vödör normalizálása.
 * @returns {object|null} null, ha használhatatlan
 */
export function normalizeItem(item, workspaceFallback) {
  if (item === null || typeof item !== "object") return null;
  const kind = typeof item.kind === "string" ? item.kind : "";
  if (!KINDS.has(kind)) return null;
  const from = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : null;
  if (from === null) return null;
  const to = typeof item.to === "number" && Number.isFinite(item.to) ? item.to : from;
  if (to < from) return null;
  // Értelmetlen (jövőbeli / ősi) bélyeg kiszűrése: a mérés amúgy is időablakos.
  const now = Date.now();
  if (from > now + 60000 || from < now - 400 * 24 * 3600000) return null;
  const session = typeof item.session === "string" ? item.session : "";
  const workspace = typeof item.workspace === "string" && item.workspace.length > 0 ? item.workspace : workspaceFallback;
  return {
    at: from,
    to: Math.min(to, from + 600000),
    kind,
    session,
    workspace: typeof workspace === "string" ? workspace : "",
  };
}

/**
 * Aktivitás-vödrök hozzáfűzése. A napló append-only; a méret-plafon fölött
 * rotálunk (a rotált fájl megmarad, nem törlődik — „elrejtés nem törlés”).
 * @param {string} stateDir
 * @param {unknown[]} items
 * @returns {{written: number, dropped: number, path: string}}
 */
export function appendActivity(stateDir, items, workspaceFallback) {
  const list = Array.isArray(items) ? items : [];
  const rows = [];
  let dropped = 0;
  for (const item of list) {
    const normalized = normalizeItem(item, workspaceFallback);
    if (normalized === null) {
      dropped += 1;
      continue;
    }
    rows.push(normalized);
  }
  const path = activityPath(stateDir);
  if (rows.length === 0) return { written: 0, dropped, path };
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (existsSync(path) && statSync(path).size > ROTATE_BYTES) {
      renameSync(path, join(dirname(path), `activity.${Date.now()}.jsonl`));
    }
  } catch {
    /* a rotálás hibája nem állíthatja meg a mérést */
  }
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  appendFileSync(path, text, "utf8");
  return { written: rows.length, dropped, path };
}

/**
 * Az aktivitás-napló beolvasása.
 *
 * @param {string} stateDir
 * @param {number} since epoch ms — ennél régebbi rekord nem kell
 * @returns {{bySession: Map<string, {keys: object[], hidden: object[], firstAt: number, lastAt: number, any: number}>, total: number, bad: number}}
 */
export function readActivity(stateDir, since) {
  const bySession = new Map();
  const path = activityPath(stateDir);
  if (!existsSync(path)) return { bySession, total: 0, bad: 0 };
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { bySession, total: 0, bad: 0 };
  }
  let total = 0;
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (row === null || typeof row !== "object") continue;
    if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue;
    const session = typeof row.session === "string" ? row.session : "";
    if (session.length === 0) continue;
    let bucket = bySession.get(session);
    if (bucket === undefined) {
      bucket = { keys: [], hidden: [], firstAt: 0, lastAt: 0, any: 0 };
      bySession.set(session, bucket);
    }
    bucket.any += 1;
    if (bucket.firstAt === 0 || row.at < bucket.firstAt) bucket.firstAt = row.at;
    if (row.at > bucket.lastAt) bucket.lastAt = row.at;
    if (row.at < since) continue;
    const interval = { start: row.at, end: Number.isFinite(row.to) ? row.to : row.at };
    if (row.kind === "key") bucket.keys.push(interval);
    else if (row.kind === "hidden") bucket.hidden.push(interval);
    total += 1;
  }
  return { bySession, total, bad };
}

/** A mérő kliens élt-e a kérdéses időszak körül (12 órás tűrés). */
const ACTIVITY_TRUST_MILLISECONDS = 12 * 3600000;

/**
 * A mérés eldöntése: a kliens-adat használható-e erre a szünetre?
 *
 * Ha a naplóban egyáltalán nincs bejegyzés (a plugin kliens fele nem futott,
 * másik kliensből jött a munka, terminálból indult session), akkor a napló-alapú
 * tartalék lép be. Ha VAN bejegyzés a környéken, akkor a „nincs gépelés” valós
 * információ (a felhasználó máshol volt), és nem szabad felbecsülni.
 */
function activityTrusted(activity, gapEnd) {
  if (activity === undefined || activity === null || activity.any === 0) return false;
  return activity.lastAt >= gapEnd - ACTIVITY_TRUST_MILLISECONDS;
}

/**
 * Egy session kör-párjainak emberi ideje.
 *
 * A pár: `kör(n)` vége → `kör(n+1)` kezdete. Ez az az intervallum, amiben a
 * felhasználó elolvassa a választ és beírja a következő promptot.
 *
 * @param {object} session SessionRecord
 * @param {{keys: object[], hidden: object[], any: number}|undefined} activity
 * @param {object} profile normalizált profil (idleCapMinutes, readCapMinutes)
 * @param {{from: number, to: number}} window
 * @returns {{items: object[], readMs: number, typeMs: number, gapMs: number, source: "client"|"fallback"|"mixed"}}
 */
export function humanTime(session, activity, profile, window) {
  const idleCap = Math.max(0, Number(profile?.idleCapMinutes ?? 15)) * 60000;
  const readCap = Math.max(0, Number(profile?.readCapMinutes ?? 20)) * 60000;
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  const items = [];
  let readMs = 0;
  let typeMs = 0;
  let gapMs = 0;
  let clientUsed = 0;
  let fallbackUsed = 0;

  // Csak a LEZÁRT körök párosíthatók: a nyitott kör után még nincs „következő".
  for (let i = 0; i < turns.length - 1; i += 1) {
    const current = turns[i];
    const next = turns[i + 1];
    if (current === null || next === null) continue;
    if (current.end === null || current.end === undefined) continue;
    const gapStart = Math.max(current.end, window?.from ?? 0);
    const gapEnd = Math.min(next.start, window?.to ?? Number.POSITIVE_INFINITY);
    if (!(gapEnd > gapStart)) continue;
    const length = gapEnd - gapStart;
    gapMs += length;

    const hasActivity = activityTrusted(activity, gapEnd);
    if (!hasActivity) {
      fallbackUsed += 1;
      // A tétlenség-plafonnál HOSSZABB szünet nem munkaidő (ebéd, másik munka):
      // 0, nem pedig a plafonig felbecsült érték. Ez a konzervatív irány, és a
      // felhasználó szabálya is („a hosszabb szünet nem számít”).
      const counted = idleCap > 0 && length > idleCap ? 0 : length;
      readMs += counted;
      items.push({ turn: current.turn, gapMs: length, readMs: counted, typeMs: 0, source: counted > 0 ? "fallback" : "away" });
      continue;
    }

    // A rejtett (nem nézett) idő nem munkaidő: kivonjuk.
    const hidden = clip(activity.hidden, gapStart, gapEnd);
    const visible = subtract([{ start: gapStart, end: gapEnd }], hidden);
    const visibleMs = visible.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
    const keys = clip(activity.keys, gapStart, gapEnd);

    if (keys.length === 0) {
      // Van aktivitás-mérés, de ebben a szünetben semmi: a felhasználó nem itt
      // volt. Ez NEM becsülhető felülről — 0, „távol” jelöléssel.
      items.push({ turn: current.turn, gapMs: length, readMs: 0, typeMs: 0, source: "away" });
      continue;
    }

    clientUsed += 1;
    const typeStart = keys[0].start;
    const read = Math.min(cappedLength(gapStart, typeStart, readCap), visibleMs);
    // A gépelés a gépelés kezdetétől a következő körig tart, rejtett idő nélkül,
    // a tétlenség-plafonnal vágva (hosszú gondolkodás nem gépelés).
    const typingWindow = subtract([{ start: typeStart, end: gapEnd }], hidden);
    const typingVisible = typingWindow.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
    const typing = cappedLength(typeStart, typeStart + typingVisible, idleCap);
    readMs += read;
    typeMs += typing;
    items.push({ turn: current.turn, gapMs: length, readMs: read, typeMs: typing, source: "client" });
  }

  const source = clientUsed > 0 && fallbackUsed > 0 ? "mixed" : (clientUsed > 0 ? "client" : "fallback");
  return { items, readMs, typeMs, gapMs, source };
}

/** Az aktivitás-mérés elérhető-e egyáltalán ebben az ablakban. */
export function activityPresence(activity) {
  return activity !== undefined && activity !== null && activity.any > 0;
}
