/**
 * dsh-browser/scope — a böngésző CÉLTERÜLET-ellenőrzése (tiszta, tesztelhető).
 *
 * MIÉRT: a böngésző a HOST processzben fut, tehát a DSH sandboxa rá nem
 * érvényes. A célterület ezért itt, a toolban dől el — három fokozatban:
 *
 *   loopback  → 127.0.0.1, ::1, localhost (csak a saját felület)
 *   lan       → a fenti + magánhálózati címek (10/8, 172.16/12, 192.168/16,
 *               169.254/16, *.local, *.lan, *.internal) + a konfigurált kivételek
 *   any       → bármely http/https URL (a nyilvános internet is)
 *
 * Mindhárom fokozat elérhető (a felhasználó döntése, 2026-11-26); a `file:`,
 * `javascript:`, `data:` és minden nem http(s) séma MINDIG tilos, mert azok
 * a helyi fájlrendszerre vagy a böngésző saját kontextusára nyitnak utat.
 */

/** A loopback hosztnevek (kisbetűsítve, zárójel nélkül). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "0.0.0.0", "localhost"]);

/** A helyi hálózat tipikus belső végződései. */
const LAN_SUFFIXES = [".local", ".lan", ".internal", ".home", ".intranet"];

/** @typedef {"loopback"|"lan"|"any"} Scope */

/** Az elfogadott hatókör-értékek. */
export const SCOPES = Object.freeze(["loopback", "lan", "any"]);

/**
 * IPv4 magáncím?
 * @param {string} host
 * @returns {boolean}
 */
function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

/**
 * Egy hoszt besorolása.
 * @param {string} rawHost a `URL.hostname` (IPv6-nál zárójelek nélkül is jó)
 * @returns {"loopback"|"lan"|"public"|"invalid"}
 */
export function classifyHost(rawHost) {
  if (typeof rawHost !== "string" || rawHost === "") return "invalid";
  const host = rawHost.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  if (LOOPBACK_HOSTS.has(host)) return "loopback";
  if (host.endsWith(".localhost")) return "loopback";
  if (isPrivateIPv4(host)) return "lan";
  if (host.includes(":")) {
    // IPv6: fc00::/7 (unique local) és fe80::/10 (link-local) → helyi hálózat.
    if (/^f[cd][0-9a-f]{2}:/u.test(host)) return "lan";
    if (/^fe[89ab][0-9a-f]:/u.test(host)) return "lan";
    return "public";
  }
  if (LAN_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "lan";
  if (!host.includes(".")) return "lan"; // „gépnév" (DNS nélküli) → helyi
  return "public";
}

/**
 * Egy URL elemzése és besorolása.
 * @param {string} raw
 * @returns {{ok: true, url: string, host: string, scheme: string, kind: "loopback"|"lan"|"public"} | {ok: false, error: string}}
 */
export function parseTarget(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "üres cél-URL" };
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: `érvénytelen URL: ${raw}` };
  }
  const scheme = url.protocol.replace(/:$/u, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return { ok: false, error: `nem támogatott séma: ${scheme} (csak http/https)` };
  }
  const kind = classifyHost(url.hostname);
  if (kind === "invalid") return { ok: false, error: `érvénytelen hoszt: ${url.hostname}` };
  return { ok: true, url: url.href, host: url.hostname, scheme, kind };
}

/**
 * A hatókör döntés egy célra.
 * @param {Scope} scope
 * @param {string} raw
 * @param {{allowHosts?: readonly string[]}} [options]
 * @returns {{allowed: boolean, kind: string, url?: string, host?: string, reason?: string}}
 */
export function checkScope(scope, raw, options = {}) {
  const target = parseTarget(raw);
  if (target.ok !== true) return { allowed: false, kind: "invalid", reason: target.error };
  const effective = SCOPES.includes(scope) ? scope : "any";
  const allowHosts = (options.allowHosts ?? []).map((h) => String(h).toLowerCase().replace(/^\[/u, "").replace(/\]$/u, ""));
  const host = target.host.toLowerCase();
  if (allowHosts.includes(host)) {
    return { allowed: true, kind: target.kind, url: target.url, host: target.host, reason: "kivétellista" };
  }
  if (effective === "any") return { allowed: true, kind: target.kind, url: target.url, host: target.host };
  if (target.kind === "loopback") return { allowed: true, kind: target.kind, url: target.url, host: target.host };
  if (effective === "lan" && target.kind === "lan") {
    return { allowed: true, kind: target.kind, url: target.url, host: target.host };
  }
  return {
    allowed: false,
    kind: target.kind,
    host: target.host,
    reason: `a(z) "${target.host}" kívül esik a(z) "${effective}" hatókörön (a célterület a hívás "scope" mezőjével vagy a state\\browser-config.json "defaultScope" kulcsával bővíthető)`
  };
}

/**
 * A konfiguráció betöltése (opcionális fájl; hiba esetén a biztonságos alap).
 * @param {() => unknown} readJson a hívó adja (a plugin a fájlrendszert injektálja)
 * @returns {{defaultScope: Scope, allowHosts: string[], width: number, height: number, idleMs: number}}
 */
export function normalizeConfig(readJson) {
  const fallback = { defaultScope: "any", allowHosts: [], width: 1440, height: 900, idleMs: 180000 };
  let raw;
  try {
    raw = readJson();
  } catch {
    return fallback;
  }
  if (raw === null || typeof raw !== "object") return fallback;
  const scope = raw.defaultScope;
  const width = Number(raw.width);
  const height = Number(raw.height);
  const idleMs = Number(raw.idleMs);
  return {
    defaultScope: SCOPES.includes(scope) ? scope : fallback.defaultScope,
    allowHosts: Array.isArray(raw.allowHosts) ? raw.allowHosts.filter((h) => typeof h === "string" && h !== "") : [],
    width: Number.isFinite(width) && width >= 320 && width <= 3840 ? Math.floor(width) : fallback.width,
    height: Number.isFinite(height) && height >= 240 && height <= 2160 ? Math.floor(height) : fallback.height,
    idleMs: Number.isFinite(idleMs) && idleMs >= 15000 && idleMs <= 1800000 ? Math.floor(idleMs) : fallback.idleMs
  };
}
