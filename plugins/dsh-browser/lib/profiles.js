/**
 * dsh-browser/profiles — eldobható és TARTÓS böngésző-profilok.
 *
 * MIÉRT: a felhasználó kérése (2026-11-26): „oké az eldobható profil, de tudj
 * tartósabbat is létrehozni egyes feladatokra (pl. hogy ne kelljen minden
 * próbálkozásnál bejelentkeznem)". Ezért két mód van:
 *
 *   ephemeral (alap)  → futásonként új temp könyvtár, a zárás után törölve
 *   persistent        → `state\browser-profiles\<név>`, megmarad a sütikkel
 *                       és a bejelentkezésekkel együtt
 *
 * A tartós profil KÉNYELMI, nem biztonsági határ: a benne lévő bejelentkezés
 * bárkié, aki a gépet használja. Ezért (a) a nevet explicit kell megadni
 * (`profile: "lineageos"`), (b) a tool a válaszban kimondja, hogy tartós
 * profilt használ, (c) a törlés lomtárba megy (visszaállítható), nem `rm`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A profil-név megengedett alakja. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,40}$/u;

/**
 * A név ellenőrzése (útvonal-injektálás ellen).
 * @param {string} name
 * @returns {{ok: true, name: string} | {ok: false, error: string}}
 */
export function validateProfileName(name) {
  if (typeof name !== "string" || name === "") return { ok: false, error: "a profil neve kötelező (pl. \"lineageos\")" };
  const normalized = name.trim().toLowerCase();
  if (!NAME_PATTERN.test(normalized)) {
    return { ok: false, error: `a profil neve csak kisbetűt, számot és . _ - jelet tartalmazhat (max 41): "${name}"` };
  }
  return { ok: true, name: normalized };
}

/**
 * Profil feloldása.
 * @param {{ rootDir: string, mode: "ephemeral"|"persistent", name?: string, now?: () => Date }} options
 * @returns {{ dir: string, mode: "ephemeral"|"persistent", name: string|null, ephemeral: boolean }}
 */
export function resolveProfile(options) {
  const { rootDir, mode } = options;
  mkdirSync(rootDir, { recursive: true });
  if (mode !== "persistent") {
    const dir = mkdtempSync(join(rootDir, "tmp-"));
    return { dir, mode: "ephemeral", name: null, ephemeral: true };
  }
  const checked = validateProfileName(options.name ?? "");
  if (checked.ok !== true) throw new Error(checked.error);
  const dir = join(rootDir, checked.name);
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  if (fresh) {
    const at = (options.now?.() ?? new Date()).toISOString();
    try {
      writeFileSync(join(dir, "dsh-profile.json"), JSON.stringify({ name: checked.name, createdAt: at, purpose: "tartós böngésző-profil (dsh-browser)" }, null, 2), "utf8");
    } catch {
      /* a metaadat nem kritikus */
    }
  }
  return { dir, mode: "persistent", name: checked.name, ephemeral: false };
}

/**
 * A meglévő tartós profilok listája.
 * @param {string} rootDir
 * @returns {Array<{name: string, dir: string, createdAt: string|null, bytes: number}>}
 */
export function listProfiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const entries = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("tmp-") || entry.name.startsWith(".trash-")) continue;
    const dir = join(rootDir, entry.name);
    let createdAt = null;
    try {
      const meta = JSON.parse(readFileSync(join(dir, "dsh-profile.json"), "utf8"));
      createdAt = typeof meta.createdAt === "string" ? meta.createdAt : null;
    } catch {
      /* nincs metaadat */
    }
    entries.push({ name: entry.name, dir, createdAt, bytes: directorySize(dir) });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tartós profil törlése LOMTÁRBA (visszaállítható; nem `rm`).
 * @param {string} rootDir
 * @param {string} name
 * @param {() => Date} [now]
 * @returns {{ok: boolean, movedTo?: string, error?: string}}
 */
export function trashProfile(rootDir, name, now) {
  const checked = validateProfileName(name);
  if (checked.ok !== true) return { ok: false, error: checked.error };
  const dir = join(rootDir, checked.name);
  if (!existsSync(dir)) return { ok: false, error: `nincs ilyen profil: ${checked.name}` };
  const stamp = (now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  const target = join(rootDir, `.trash-${stamp}-${checked.name}`);
  try {
    renameSync(dir, target);
    return { ok: true, movedTo: target };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Eldobható profil törlése (csak a `tmp-` előtagúakat hajlandó).
 * @param {string} dir
 */
export function removeEphemeral(dir) {
  if (typeof dir !== "string" || dir === "") return;
  const base = dir.split(/[\\/]/u).pop() ?? "";
  if (!base.startsWith("tmp-")) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch {
    /* a maradék temp könyvtár ártalmatlan */
  }
}

/**
 * A régi eldobható profilok kisöprése.
 *
 * MIÉRT: ha a böngésző zárásakor egy renderelő még fogja a fájlokat, a
 * `rmSync` csendben elbukik, és a `tmp-*` mappa a lemezen marad (mért eset:
 * három mappa egy mérés után). Ezért induláskor kisöpörjük a régieket.
 * @param {string} rootDir
 * @param {number} [maxAgeMs] ennél régebbi mappák törlődnek (alap: 1 óra)
 * @returns {number} a kitakarított mappák száma
 */
export function pruneEphemeral(rootDir, maxAgeMs = 3600000) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("tmp-")) continue;
    const dir = join(rootDir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > cutoff) continue;
    removeEphemeral(dir);
    removed += 1;
  }
  return removed;
}

/**
 * Rekurzív méret (gyors, best-effort; hibánál a részösszeget adja).
 * @param {string} dir
 * @returns {number}
 */
function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(full);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += statSync(full).size;
    } catch {
      /* zárolt vagy eltűnt fájl */
    }
  }
  return total;
}
