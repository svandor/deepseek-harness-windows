/**
 * Tiltó- és engedélyező-minták, valamint a profil-őrök.
 *
 * A lista a Felpuffantóból jön, ahol élesben bizonyított: ezek a fájlok NEM
 * mehetnek fel a tárhelyre (titok, generált tartalom, függőség). A Laravel-specifikus
 * engedélyező kivételek profil-szinten is bővíthetők (`profile.allow`).
 */
import { posixRel } from "./paths.js";

/** Ami SOHA nem megy fel (és a törlés-listára sem kerülhet). */
export const DENY_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)storage(\/|$)/i,
  /(^|\/)vendor(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)bootstrap\/cache(\/|$)/i,
  /(^|\/)public\/hot$/i,
  /(^|\/)public\/\.user\.ini$/i,
  /(^|\/)phpinfo\.php$/i,
  /(^|\/)rr(\.exe)?$/i,
];

/**
 * Laravel-alapú kivételek a `storage` tiltás alól (a Felpuffantó mért listája:
 * ezekre a helyekre a szerkesztő/import ír, és élesben kell lenniük).
 */
export const DEFAULT_ALLOW = [
  "storage/app/private/registry",
  "storage/app/private/media-library/documents",
  "storage/app/public/media-library",
  "storage/app/tpm-doc-previews",
  "storage/app/public/local-ai/checkpoint-previews",
  "storage/app/public/local-ai/adapter-previews",
  "storage/app/granit-sandbox",
  "storage/app/imports/outgoing-szamlazz",
];

/** Távoli szegmensek, amiket nem írunk felül (más ügyfél/korreábbi projekt). */
export const BANNED_REMOTE_SEGMENTS = new Set([
  "elearning",
  "elearning43",
  "elearning45",
  "magazin",
  "dok",
]);

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Prefix-lista -> `^prefix(/|$)` reguláris kifejezések (biztonságos escape). */
export function toAllowRegexes(prefixes) {
  const list = Array.isArray(prefixes) ? prefixes : [];
  return list
    .map((raw) => posixRel(raw).replace(/\/+$/, ""))
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => new RegExp(`^${escapeRe(prefix)}(/|$)`, "i"));
}

const DEFAULT_ALLOW_REGEXES = toAllowRegexes(DEFAULT_ALLOW);

export function isAllowedOverride(relPath, allowRegexes = DEFAULT_ALLOW_REGEXES) {
  const n = posixRel(relPath);
  return allowRegexes.some((re) => re.test(n));
}

export function isDenied(relPath, allowRegexes = DEFAULT_ALLOW_REGEXES) {
  const n = posixRel(relPath);
  if (isAllowedOverride(n, allowRegexes)) return false;
  return DENY_PATTERNS.some((re) => re.test(n));
}

/** Relatív útvonal, amit szabad élesre tenni / onnan törölni. */
export function isSafeRelPath(relPath) {
  const raw = String(relPath ?? "");
  // FONTOS: az abszolút alakot a NORMALIZÁLÁS ELŐTT kell elutasítani, mert a
  // `posixRel` leveszi a vezető `/`-t — különben a `/etc/passwd` alakú bemenet
  // átcsúszna (a Felpuffantóban ezt a git-forrás tette elérhetetlenné, itt
  // viszont profil-adatból is jöhet útvonal).
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw)) return false;
  const n = posixRel(raw);
  if (!n || n.split("/").includes("..")) return false;
  return true;
}

/**
 * Laravel-profil: az `app` mellé kell a `bootstrap` (cache továbbra is tiltott)
 * és a `lang`, különben a deploy hiányos lesz.
 */
export function completeLaravelInclude(include) {
  const list = Array.isArray(include) ? include : [];
  const has = (name) => list.some((i) => i === name || i.startsWith(`${name}/`));
  const out = [...list];
  if (has("app")) {
    if (!has("bootstrap")) out.push("bootstrap");
    if (!has("lang")) out.push("lang");
  }
  return out;
}

export function matchesInclude(relPath, include) {
  const n = posixRel(relPath);
  const list = Array.isArray(include) ? include : [];
  return list.some((raw) => {
    const prefix = posixRel(raw).replace(/\/+$/, "");
    return n === prefix || n.startsWith(`${prefix}/`);
  });
}

/** Csak `.htaccess` + `index.php` — ilyen profil teheti a remoteRootot `/web`-re. */
export function isRedirectOnlyInclude(include) {
  const list = Array.isArray(include) ? include : [];
  if (list.length === 0) return false;
  const allowed = new Set([".htaccess", "index.php"]);
  return list.every((raw) => allowed.has(posixRel(raw).replace(/\/+$/, "")));
}

/**
 * A távoli gyökér ellenőrzése. MÉRT OK: a Felpuffantóban ez akadályozta meg,
 * hogy egy elgépelt profil a `/web`-re (az egész tárhelyre) töltsön.
 */
export function assertRemoteRoot(remoteRoot, include = []) {
  const n = posixRel(remoteRoot).replace(/\/+$/, "");
  if (!n || n === "/") {
    throw new Error("A remoteRoot nem lehet üres vagy /.");
  }
  if (n === "web" || n === "/web") {
    if (!isRedirectOnlyInclude(include)) {
      throw new Error(
        "A remoteRoot nem lehet /web — csak a projektmappa (pl. /web/laravel12), kivéve tiszta átirányító profilt (.htaccess, index.php).",
      );
    }
    return "/web";
  }
  const parts = n.split("/").filter(Boolean);
  for (const part of parts) {
    if (BANNED_REMOTE_SEGMENTS.has(part.toLowerCase())) {
      throw new Error(`Tiltott remote szegmens: ${part}`);
    }
  }
  return `/${parts.join("/")}`;
}

export function assertLocalRoot(localRoot) {
  const trimmed = String(localRoot ?? "").trim();
  if (!trimmed) throw new Error("A localRoot kötelező.");
  return trimmed;
}
