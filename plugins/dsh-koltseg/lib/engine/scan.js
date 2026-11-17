/**
 * Session-naplók bejárása — a mérés egyetlen adatforrása.
 *
 * MIÉRT SAJÁT BEJÁRÓ: a DSH a session-naplót **több frame-es zstd** streamként
 * írja (egy frame = egy append). A Node `zstdDecompressSync` csak az ELSŐ frame-et
 * adja vissza, tehát egy naiv olvasó a session fejlécén kívül semmit nem látna,
 * és „nincs adat" választ adna a valóság helyett. Ez a modul ezért frame-enként
 * dekompresszál. (Ugyanez a hiba és ugyanez a megoldás van a `dsh-ui-extras`
 * usage-szkennereben — a minta onnan származik.)
 *
 * A fájlok append-only-ok, ezért a származtatott adat (nem a nyers szöveg!)
 * gyorsítótárazható fájl+mtime+méret kulccsal: egy mérés a legtöbb session-nél
 * csak stat-ol.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";

/** A DSH saját könyvtára (a deployment `DSH_HOME`-ot is használhat). */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  return fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}

/** A session-naplók gyökere ebben a deploymentben. */
export function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/**
 * Az összes session-napló fájl a gyökér alatt.
 * @returns {{file: string, dir: string, mtimeMs: number, size: number}[]}
 */
export function sessionLogFiles(root = sessionsRoot()) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".jsonl.zstd") && !entry.name.endsWith(".jsonl")) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      found.push({ file: full, dir, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };
  walk(root, 0);
  return found;
}

/** Egy zstd frame kibontása; `consumed` a frame valódi hossza a pufferben. */
function readZstdFrame(buffer) {
  return new Promise((resolve) => {
    const stream = createZstdDecompress();
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), consumed: stream.bytesWritten }));
    stream.on("error", () => resolve({ text: "", consumed: buffer.length }));
    stream.end(buffer);
  });
}

/**
 * A teljes napló szövege, frame-enként.
 *
 * Kétszeresen korlátos (frame-szám és kimeneti méret), hogy egy kóros fájl se
 * kösse le a hostot: a csonka olvasás is használható (részleges) összesítést ad,
 * nem hibát.
 * @returns {Promise<{text: string, frames: number, truncated: boolean}>}
 */
export async function decompressSessionLog(buffer) {
  let offset = 0;
  let text = "";
  let frames = 0;
  let truncated = false;
  while (offset < buffer.length) {
    if (frames >= 200000 || text.length >= 200 * 1024 * 1024) {
      truncated = true;
      break;
    }
    const frame = await readZstdFrame(buffer.subarray(offset));
    if (frame.consumed <= 0) break;
    offset += frame.consumed;
    frames += 1;
    text += frame.text;
  }
  return { text, frames, truncated };
}

/**
 * Egy naplófájl eseményei, soronként.
 *
 * A napló JSONL: soronként egy esemény `{type, seq, time, data}` alakban, ahol
 * `time` Unix epoch milliszekundum. A fájl vége írás közben csonka lehet (a
 * futó session éppen appendel) — az ilyen sor kimarad, nem hiba.
 * @returns {{header: object|null, events: object[], frames: number, truncated: boolean, badLines: number}}
 */
export function parseSessionText(text) {
  const events = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") events.push(parsed);
    } catch {
      badLines += 1;
    }
  }
  const header = events.length > 0 && events[0].type === "session" ? events[0] : null;
  return { header, events, badLines };
}

/** Származtatott session-adatok gyorsítótára: fájl+mtime+méret -> rekord. */
const cache = new Map();
const CACHE_LIMIT = 400;

/** Fejléc-gyorsítótár (a munkaterület-szűréshez elég az első frame). */
const headerCache = new Map();
const HEADER_CACHE_LIMIT = 2000;

/**
 * Csak a session FEJLÉC (az első esemény) egy naplóból.
 *
 * MIÉRT: egy munkaterület szűrése a teljes napló kibontása nélkül akar történni.
 * A fejléc az első zstd frame-ben van, tehát elég egy frame-et kibontani — a
 * több száz megás naplók így nem lassítják a felület megnyitását.
 *
 * @returns {{id: string, cwd: string, delegationDepth: number, createdAt: number}|null}
 */
export async function loadSessionHeader(file, stat) {
  let mtimeMs = stat?.mtimeMs ?? 0;
  let size = stat?.size ?? 0;
  if (mtimeMs === 0 || size === 0) {
    try {
      const fresh = statSync(file);
      mtimeMs = fresh.mtimeMs;
      size = fresh.size;
    } catch {
      return null;
    }
  }
  const key = `${file}|${Math.round(mtimeMs)}|${size}`;
  if (headerCache.has(key)) return headerCache.get(key);

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return null;
  }
  let text = "";
  if (file.endsWith(".zstd")) {
    const frame = await readZstdFrame(buffer);
    text = frame.text;
  } else {
    text = buffer.toString("utf8");
  }
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  let header = null;
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed !== null && typeof parsed === "object" && parsed.type === "session" && typeof parsed.id === "string") {
      header = {
        id: parsed.id,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
        delegationDepth: typeof parsed.delegationDepth === "number" ? parsed.delegationDepth : 0,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      };
    }
  } catch {
    header = null;
  }
  if (headerCache.size >= HEADER_CACHE_LIMIT) {
    const oldest = headerCache.keys().next();
    if (!oldest.done) headerCache.delete(oldest.value);
  }
  headerCache.set(key, header);
  return header;
}

/**
 * Egy napló betöltése és feldolgozása, gyorsítótárral.
 *
 * @param {string} file abszolút útvonal
 * @param {{mtimeMs?: number, size?: number}} [stat] előre kiolvasott stat
 * @param {(parsed: {header: object|null, events: object[]}) => object} derive származtatás
 * @returns {Promise<object>} a `derive` eredménye
 */
export async function loadSession(file, stat, derive) {
  let mtimeMs = stat?.mtimeMs ?? 0;
  let size = stat?.size ?? 0;
  if (mtimeMs === 0 || size === 0) {
    try {
      const fresh = statSync(file);
      mtimeMs = fresh.mtimeMs;
      size = fresh.size;
    } catch {
      return derive({ header: null, events: [] });
    }
  }
  const key = `${file}|${Math.round(mtimeMs)}|${size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return derive({ header: null, events: [] });
  }
  const isZstd = file.endsWith(".zstd");
  const decompressed = isZstd ? await decompressSessionLog(buffer) : { text: buffer.toString("utf8"), frames: 0, truncated: false };
  const parsed = parseSessionText(decompressed.text);
  const value = derive({ ...parsed, frames: decompressed.frames, truncated: decompressed.truncated });

  if (cache.size >= CACHE_LIMIT) {
    // Egyszerű, determinisztikus kilakoltatás: a legrégebben beszúrt elem.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

/** A gyorsítótár ürítése (tesztekhez és kézi ellenőrzéshez). */
export function clearCache() {
  cache.clear();
  headerCache.clear();
}

/** A gyorsítótár mérete (diagnosztikához). */
export function cacheSize() {
  return cache.size;
}
