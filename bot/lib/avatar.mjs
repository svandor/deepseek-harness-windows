/**
 * Házirobot — alteregó avatarok (közös modul).
 *
 * Az avatarok a `bot/avatar/alteregok/<id>.svg` fájlok; a katalógus a
 * `bot/avatar/alteregok.json`. Az aktív alteregó és az automatikus váltogatás
 * a `bot/config.json` `avatarAlterego` blokkjában él, hogy a DSH panel és a
 * robot-panel (4180) ugyanazt mutassa, és újraindítás után is megmaradjon.
 *
 * A modult a `bot/panel/server.mjs` ÉS a `plugins/dsh-hazi-robot` host
 * fele is használja — ezért nincs benne semmi, ami a DSH-tól függene.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ROOT } from './config.mjs';

export const AVATAR_DIR = join(BOT_ROOT, 'avatar', 'alteregok');
export const KATALOG_PATH = join(BOT_ROOT, 'avatar', 'alteregok.json');
export const CONFIG_PATH = join(BOT_ROOT, 'config.json');
export const AVATAR_DEFAULT = 'gyuszi';

/**
 * Az automatikus váltogatás felkínált értékei másodpercben (0 = kikapcsolva).
 * A hosszabb értékek is kellenek, mert a robot panel gyakran órákig nyitva van:
 * a percenkénti váltás zavaró, a félórás viszont észrevehető.
 */
export const AUTO_CHOICES = [0, 10, 30, 60, 300, 900, 1800, 3600, 7200];
export const AUTO_MAX = 86400;

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/** Írás előtt mentés — ugyanaz a minta, mint a plugin `writeJson`-ja. */
function writeJsonSafe(path, data) {
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      copyFileSync(path, `${path}.bak-${stamp}`);
    } catch {
      /* a mentés nem kötelező */
    }
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/** Az id szűrése: fájlnév-be nem kerülhet semmi váratlan. */
export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(id);
}

/**
 * A katalógus betöltése. Ha a fájl hiányzik vagy hibás, egy minimális, beépített
 * listával tér vissza (a panel így sem hal meg, csak szegényebb lesz).
 */
export function loadKatalog() {
  const raw = readJson(KATALOG_PATH, null);
  const fallback = {
    alap: AVATAR_DEFAULT,
    autoAlap: 0,
    lista: [{ id: AVATAR_DEFAULT, nev: 'Gyuszi (a valódi)', alcim: '', fajl: 'alteregok/gyuszi.svg', mozgas: '', ihlet: '', szin: '#f0b429' }],
  };
  if (!raw || !Array.isArray(raw.lista) || raw.lista.length === 0) return fallback;

  const lista = raw.lista
    .filter((item) => item && isValidId(item.id))
    .map((item) => ({
      id: item.id,
      nev: String(item.nev ?? item.id),
      alcim: String(item.alcim ?? ''),
      fajl: String(item.fajl ?? `alteregok/${item.id}.svg`),
      mozgas: String(item.mozgas ?? ''),
      ihlet: String(item.ihlet ?? ''),
      szin: /^#[0-9a-f]{3,8}$/i.test(String(item.szin ?? '')) ? String(item.szin) : '#9fb3c8',
    }));
  if (lista.length === 0) return fallback;

  const alap = lista.some((item) => item.id === raw.alap) ? raw.alap : lista[0].id;
  return { alap, autoAlap: normalizeAuto(raw.autoAlap), lista };
}

/** A másodperc érvényes tartományba szorítása (0 = ki). */
export function normalizeAuto(value) {
  const sec = Math.round(Number(value));
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.min(Math.max(sec, 3), AUTO_MAX);
}

/** Az alteregó SVG abszolút útja (akkor is, ha a fájl nem létezik). */
export function avatarFile(id) {
  const katalog = loadKatalog();
  const item = katalog.lista.find((entry) => entry.id === id);
  const relative = item ? item.fajl : `alteregok/${AVATAR_DEFAULT}.svg`;
  return join(BOT_ROOT, 'avatar', relative.replace(/^avatar[\\/]/, ''));
}

/** Az alteregó SVG tartalma, vagy null. */
export function readAvatarSvg(id) {
  const file = avatarFile(id);
  if (!existsSync(file)) return null;
  return readFileSync(file);
}

/** A katalógus a fájl meglétével kiegészítve (ezt kapja a kliens). */
export function avatarList() {
  const katalog = loadKatalog();
  return katalog.lista.map((item) => ({
    ...item,
    van: existsSync(avatarFile(item.id)),
  }));
}

/** Az aktuális állapot a config.json-ból, a katalógussal összevetve. */
export function getAvatarState() {
  const katalog = loadKatalog();
  const cfg = readJson(CONFIG_PATH, {});
  const stored = cfg.avatarAlterego ?? {};
  const ismert = katalog.lista.some((item) => item.id === stored.aktiv);
  const aktiv = ismert ? stored.aktiv : katalog.alap;
  const item = katalog.lista.find((entry) => entry.id === aktiv);
  return {
    aktiv,
    aktivNev: item ? item.nev : aktiv,
    auto: normalizeAuto(stored.auto ?? katalog.autoAlap),
  };
}

/**
 * Az aktív alteregó és/vagy az automatikus váltogatás mentése.
 * Csak a `avatarAlterego` kulcshoz nyúlunk, minden más beállítás marad.
 */
export function setAvatarState(patch) {
  const katalog = loadKatalog();
  const cfg = readJson(CONFIG_PATH, {});
  const current = getAvatarState();

  let aktiv = current.aktiv;
  if (patch && patch.aktiv !== undefined) {
    if (!isValidId(patch.aktiv) || !katalog.lista.some((item) => item.id === patch.aktiv)) {
      return { ok: false, error: `ismeretlen alteregó: ${patch?.aktiv}` };
    }
    aktiv = patch.aktiv;
  }

  let auto = current.auto;
  if (patch && patch.auto !== undefined) auto = normalizeAuto(patch.auto);

  cfg.avatarAlterego = { aktiv, auto };
  writeJsonSafe(CONFIG_PATH, cfg);
  return { ok: true, ...getAvatarState() };
}

/**
 * A katalógus és az aktív állapot együtt — pontosan ez megy ki a kliensnek a
 * `/alteregok` route-on.
 */
export function avatarPayload() {
  const katalog = loadKatalog();
  const state = getAvatarState();
  return {
    ok: true,
    alap: katalog.alap,
    aktiv: state.aktiv,
    aktivNev: state.aktivNev,
    auto: state.auto,
    autoValasztak: AUTO_CHOICES,
    autoMax: AUTO_MAX,
    lista: avatarList(),
    hianyzo: avatarList().filter((item) => !item.van).map((item) => item.id),
  };
}

/** Hány alteregó SVG van ténylegesen a lemezen (tesztekhez, állapothoz). */
export function avatarFileCount() {
  if (!existsSync(AVATAR_DIR)) return 0;
  return readdirSync(AVATAR_DIR).filter((f) => f.endsWith('.svg')).length;
}
