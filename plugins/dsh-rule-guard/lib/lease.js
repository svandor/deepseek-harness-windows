/**
 * dsh-rule-guard/lease — GÉP-SZINTŰ ERŐFORRÁS-ZÁR ágensek között (cross-session lease).
 *
 * MIÉRT: a DSH egyetlen host-processzben futtat MINDEN munkamenetet, és nincs
 * köztük semmilyen koordináció. Ha két ágens ugyanazt a gép-állapotot írja
 * (kijelző mód, szolgáltatás, deploy), a második felülírja az első
 * MÉRÉSÉT — az első pedig nem tudja, mi történt.
 *
 * MÉRT ESET (2026-11-27): a Vector-ágens (`session-765b76d2`) a kijelző 240 Hz-re
 * visszaállását vizsgálta. 10:36:22-kor egy MÁSIK munkamenet (a DSH-repó ágense)
 * lefuttatta a `display-guard.exe --apply` parancsot, ami 240 → 120 Hz-re
 * váltott. A Vector-ágens naplója szerint ezután:
 *   - 15. lépés: „WM_DISPLAYCHANGE occurred at … 10:36:22-24" → elkezdte kutatni;
 *   - 16. lépés: „Hmm — maybe the user locked and unlocked the screen at 10:36?";
 *   - 9. lépés: „Maybe the user is interacting with the display settings right now".
 * Vagyis **3 lépést a rossz nyomon** töltött, mert a DSH nem mondta meg neki,
 * hogy a gépen egy másik ágens dolgozik.
 *
 * MIT TESZ: a `pre-execute` kapuban a policy `leases.resources` listája alapján
 * felismeri a GÉP-ÁLLAPOTOT MÓDOSÍTÓ parancsot, és
 *   - ha az erőforrás szabad → lease-t ad (memóriában; mérési napló a fájlban),
 *   - ha MÁS, ÉLŐ ágens birtokolja → `deny`, indoklással (olvasás vs. írás),
 *   - a session indulásakor a plugin kiírja, hogy „nem vagy egyedül", és listázza
 *     az aktív lease-eket.
 *
 * A modul TISZTA (nincs FS/hálózat): a bemenet a parancs + a birtokos, a kimenet
 * döntés. Az időt is bemenetként kapja, hogy tesztelhető legyen.
 */

/** @typedef {{id: string, what: string, match: string[]}} LeaseResource */
/** @typedef {{resource: string, agent: object, label: string, tool: string, command: string, startedAt: number, expiresAt: number}} LeaseHolder */

/**
 * A lease-nyilvántartó (a plugin egy példányában él, a host-processz élettartamára).
 * @returns {{leases: Map<string, LeaseHolder>}}
 */
export function createRegistry() {
  return { leases: new Map() };
}

/**
 * Melyik erőforrást módosítja ez a parancs?
 * @param {LeaseResource[]} resources
 * @param {string} command a tool-hívás nyers szövege (command / file tartalom / URL)
 * @returns {LeaseResource|undefined}
 */
export function resourceFor(resources, command) {
  if (!Array.isArray(resources) || typeof command !== "string" || command === "") return undefined;
  for (const resource of resources) {
    if (resource === null || typeof resource !== "object") continue;
    const patterns = Array.isArray(resource.match) ? resource.match : [];
    for (const pattern of patterns) {
      let hit = false;
      try {
        hit = new RegExp(pattern, "i").test(command);
      } catch {
        hit = false; // rossz regex nem dönthet
      }
      if (hit) return resource;
    }
  }
  return undefined;
}

/**
 * Egy birtokos emberi olvasású címkéje (session-azonosító nélkül is használható).
 * @param {object} exec
 * @returns {string}
 */
export function holderLabel(exec) {
  const header = exec?.agent?.session?.header ?? {};
  const id = header.id ?? exec?.agent?.session?.id ?? "";
  const cwd = typeof header.cwd === "string" ? header.cwd : "";
  const short = typeof id === "string" && id !== "" ? String(id).slice(0, 8) : "ismeretlen-session";
  const where = cwd !== "" ? cwd.split(/[\\/]/u).pop() ?? "" : "";
  return where !== "" ? `${short} (${where})` : short;
}

/**
 * Lease igénylése vagy elutasítás.
 * @param {{leases: Map<string, LeaseHolder>}} registry
 * @param {LeaseResource} resource
 * @param {object} exec a tool-hívás (agent + name + arguments)
 * @param {{now?: number, ttlMinutes?: number}} [options]
 * @returns {{granted: true, holder: LeaseHolder} | {granted: false, holder: LeaseHolder, reason: string}}
 */
export function requestLease(registry, resource, exec, options = {}) {
  const now = options.now ?? Date.now();
  const ttlMinutes = Number.isFinite(options.ttlMinutes) && options.ttlMinutes > 0 ? options.ttlMinutes : 20;
  prune(registry, now);
  const existing = registry.leases.get(resource.id);
  const agent = exec?.agent;
  if (existing !== undefined && existing.agent !== agent) {
    return {
      granted: false,
      holder: existing,
      reason: denyReason(resource, existing, now, ttlMinutes)
    };
  }
  const holder = {
    resource: resource.id,
    agent,
    label: holderLabel(exec),
    tool: String(exec?.name ?? ""),
    command: String(exec?.arguments?.command ?? exec?.arguments?.file_path ?? "").slice(0, 400),
    startedAt: existing?.startedAt ?? now,
    expiresAt: now + ttlMinutes * 60000
  };
  registry.leases.set(resource.id, holder);
  return { granted: true, holder };
}

/**
 * A lease elengedése (pl. a session lezárásakor).
 * @param {{leases: Map<string, LeaseHolder>}} registry
 * @param {object} agent
 * @returns {number} elengedett lease-ek száma
 */
export function releaseAll(registry, agent) {
  let count = 0;
  for (const [key, holder] of registry.leases) {
    if (holder.agent === agent) {
      registry.leases.delete(key);
      count += 1;
    }
  }
  return count;
}

/**
 * A lejárt lease-ek törlése.
 * @param {{leases: Map<string, LeaseHolder>}} registry
 * @param {number} now
 * @returns {number}
 */
export function prune(registry, now) {
  let removed = 0;
  for (const [key, holder] of registry.leases) {
    if (holder.expiresAt <= now) {
      registry.leases.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Az aktív lease-ek emberi olvasású listája (session-indító súgóhoz).
 * @param {{leases: Map<string, LeaseHolder>}} registry
 * @param {number} now
 * @returns {string[]}
 */
export function describeActive(registry, now = Date.now()) {
  prune(registry, now);
  const lines = [];
  for (const holder of registry.leases.values()) {
    const minutes = Math.max(0, Math.round((holder.expiresAt - now) / 60000));
    lines.push(`${holder.resource}: ${holder.label} (${holder.tool}, még ~${minutes} perc)`);
  }
  return lines;
}

/**
 * Az elutasítás szövege — a legfontosabb rész: a modell értse, MIÉRT nem szabad.
 * @param {LeaseResource} resource
 * @param {LeaseHolder} holder
 * @param {number} now
 * @param {number} ttlMinutes
 * @returns {string}
 */
function denyReason(resource, holder, now, ttlMinutes) {
  const started = new Date(holder.startedAt).toISOString().slice(11, 19);
  const remains = Math.max(0, Math.round((holder.expiresAt - now) / 60000));
  return (
    `⏳ EZT A MŰVELETET MÁR EGY MÁSIK ÁGENS VÉGZI — ne írd felül a munkáját.\n` +
    `Erőforrás: ${resource.id} — ${resource.what}\n` +
    `Birtokos: ${holder.label}, ekkor kezdte: ${started} UTC, a zár még ~${remains} percig él (max. ${ttlMinutes}).\n` +
    `MIÉRT számít: ha most felülírod, a másik ágens MÉRÉSEI érvénytelenné válnak, és nem fogja tudni, mi történt — ` +
    `ez MEGTÖRTÉNT 2026-11-27-én: egy párhuzamos munkamenet \`display-guard --apply\`-ja miatt a Vector-ágens ` +
    `3 lépést a rossz nyomon töltött („vajon a felhasználó állította át?").\n` +
    `TEENDŐ: (a) dolgozz OLVASÁSSAL (pl. \`-Status\`), az nem ütközik; ` +
    `(b) ha a felhasználó kifejezetten kérte a módosítást, kérdezd meg tőle, és ő dönt; ` +
    `(c) vagy várd meg a zár lejártát. A DSH-ban nincs cross-session zár, ezt a kapu pótolja.`
  );
}
