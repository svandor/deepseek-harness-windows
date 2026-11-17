/**
 * Elszámolási profilok — „több verzió + egyedileg súlyozott beállítás”.
 *
 * A mérés négy komponenst ad (agent, jobs, olvasás, gépelés, valós idő), a
 * profil mondja meg, melyik mennyit ér. A számítás szándékosan egy helyen van,
 * hogy a felület és a teszt ugyanazt a matekot lássa.
 */

/** A komponensek nevei (a súlyok kulcsai). */
export const COMPONENTS = ["agent", "jobs", "humanRead", "humanType", "wall"];

/** Súly-plafon: 0 fölött bármi, de 3 fölött már biztosan elírás. */
const MAX_WEIGHT = 3;

/** `machineToHuman` tartománya: 0,05 (20 óra gép = 1 óra ember) .. 1,0 (1:1). */
const MIN_MACHINE_FACTOR = 0.05;
const MAX_MACHINE_FACTOR = 1;

/**
 * Az előre definiált profilok. A `minute` mezők szándékosan itt élnek, nem
 * konstansként a kódban: a felület ugyanezeket a mezőket szerkeszti.
 */
export const PRESET_PROFILES = [
  {
    id: "alap",
    name: "Általános",
    description: "Gépidő + emberi idő (olvasás és gépelés) egy tarifával.",
    weights: { agent: 1, jobs: 0, humanRead: 1, humanType: 1, wall: 0 },
    machineToHuman: 1,
    idleCapMinutes: 15,
    readCapMinutes: 20,
    roundToMinutes: 0,
    minimumMinutes: 0,
    combine: "union",
  },
  {
    id: "gepido",
    name: "Gépidő-alapú",
    description: "A gép munkája: a körök ideje és a háttérmunkák, emberi idő nélkül.",
    weights: { agent: 1, jobs: 0.25, humanRead: 0, humanType: 0, wall: 0 },
    machineToHuman: 1,
    idleCapMinutes: 15,
    readCapMinutes: 20,
    roundToMinutes: 0,
    minimumMinutes: 0,
    combine: "union",
  },
  {
    id: "emberi",
    name: "Emberi munkaidő",
    description: "Klasszikus óradíjas elszámolás: csak az olvasás és a gépelés.",
    weights: { agent: 0, jobs: 0, humanRead: 1, humanType: 1, wall: 0 },
    machineToHuman: 1,
    idleCapMinutes: 15,
    readCapMinutes: 20,
    roundToMinutes: 0,
    minimumMinutes: 0,
    combine: "union",
  },
  {
    id: "brutto",
    name: "Aktív naptári idő",
    description: "Napidíj-jellegű elszámolás: a gépnél töltött aktív idő uniózva.",
    weights: { agent: 0, jobs: 0, humanRead: 0, humanType: 0, wall: 1 },
    machineToHuman: 1,
    idleCapMinutes: 15,
    readCapMinutes: 20,
    roundToMinutes: 0,
    minimumMinutes: 0,
    combine: "union",
  },
];

/** Az alapértelmezett profil azonosítója. */
export const DEFAULT_PROFILE_ID = "alap";

/** Egy előre definiált profil másolata (a hívó ne módosítsa a konstanst). */
export function presetProfile(id = DEFAULT_PROFILE_ID) {
  const found = PRESET_PROFILES.find((profile) => profile.id === id) ?? PRESET_PROFILES[0];
  return {
    ...found,
    weights: { ...found.weights },
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Profil validálása és normalizálása.
 *
 * A cél, hogy a felületről bármi bejöhessen: a hibás érték nem dob, hanem a
 * legközelebbi értelmes értékre áll, és a hibaüzenet megmondja, mit módosított.
 * @param {unknown} input
 * @returns {{profile: object, errors: string[]}}
 */
export function normalizeProfile(input) {
  const source = input !== null && typeof input === "object" ? input : {};
  const errors = [];
  const rawWeights = source.weights !== null && typeof source.weights === "object" ? source.weights : {};
  const weights = {};
  for (const key of COMPONENTS) {
    const value = rawWeights[key];
    const fallback = key === "agent" || key === "humanRead" || key === "humanType" ? 1 : 0;
    const clamped = clampNumber(value, 0, MAX_WEIGHT, fallback);
    if (value !== undefined && clamped !== Number(value)) errors.push(`súly "${key}": ${value} -> ${clamped}`);
    weights[key] = clamped;
  }

  const combine = source.combine === "sum" || source.combine === "union" ? source.combine : "union";
  if (source.combine !== undefined && source.combine !== combine) errors.push(`combine: ${source.combine} -> ${combine}`);

  const id = typeof source.id === "string" && source.id.trim().length > 0 ? source.id.trim() : "egyedi";
  const name = typeof source.name === "string" && source.name.trim().length > 0 ? source.name.trim() : "Egyedi";

  return {
    errors,
    profile: {
      id,
      name,
      description: typeof source.description === "string" ? source.description : "",
      weights,
      machineToHuman: clampNumber(source.machineToHuman, MIN_MACHINE_FACTOR, MAX_MACHINE_FACTOR, 1),
      idleCapMinutes: clampNumber(source.idleCapMinutes, 0, 240, 15),
      readCapMinutes: clampNumber(source.readCapMinutes, 0, 240, 20),
      roundToMinutes: clampNumber(source.roundToMinutes, 0, 240, 0),
      minimumMinutes: clampNumber(source.minimumMinutes, 0, 2400, 0),
      combine,
    },
  };
}

/**
 * Elszámolható idő (ms) a komponensekből és a súlyokból.
 *
 * Lépések: súlyozott összeg -> gépidő-átszámítás (csak az agent komponensre)
 * -> kerekítés -> minimum. A kerekítés `roundToMinutes = 0` esetén **percre
 * pontos** (a legközelebbi egész percre), nem felfelé.
 * @param {{agentMs?: number, jobsMs?: number, readMs?: number, typeMs?: number, wallMs?: number}} components
 * @param {object} profile normalizált profil
 * @returns {{billableMs: number, minutes: number, rawMs: number, contributions: object}}
 */
export function billableTime(components, profile) {
  const weights = profile?.weights ?? {};
  const factor = Number.isFinite(profile?.machineToHuman) ? profile.machineToHuman : 1;
  const contributions = {
    agent: (components.agentMs || 0) * (weights.agent || 0) * factor,
    jobs: (components.jobsMs || 0) * (weights.jobs || 0),
    humanRead: (components.readMs || 0) * (weights.humanRead || 0),
    humanType: (components.typeMs || 0) * (weights.humanType || 0),
    wall: (components.wallMs || 0) * (weights.wall || 0),
  };
  const rawMs = Object.values(contributions).reduce((sum, value) => sum + value, 0);

  const roundTo = Number.isFinite(profile?.roundToMinutes) ? profile.roundToMinutes : 0;
  const minute = 60000;
  let roundedMs;
  if (rawMs <= 0) {
    roundedMs = 0;
  } else if (roundTo > 0) {
    roundedMs = Math.ceil(rawMs / (roundTo * minute)) * roundTo * minute;
  } else {
    roundedMs = Math.round(rawMs / minute) * minute;
  }
  const minimum = Math.max(0, Number.isFinite(profile?.minimumMinutes) ? profile.minimumMinutes : 0) * minute;
  const billableMs = Math.max(roundedMs, rawMs > 0 ? minimum : 0);

  return {
    rawMs,
    billableMs,
    minutes: billableMs / minute,
    contributions,
  };
}

/**
 * Összeg (Ft) az elszámolható időből és az óradíjból.
 * @param {number} billableMs
 * @param {number} rateHuf óradíj
 * @returns {number} egész forint
 */
export function amountHuf(billableMs, rateHuf) {
  const rate = Number.isFinite(rateHuf) && rateHuf > 0 ? rateHuf : 0;
  if (!(billableMs > 0) || rate === 0) return 0;
  return Math.round((billableMs / 3600000) * rate);
}

/**
 * Bruttó összeg ÁFÁ-val.
 * @param {number} netHuf
 * @param {number} vatPercent 0 = nincs ÁFA
 */
export function grossHuf(netHuf, vatPercent) {
  const vat = Number.isFinite(vatPercent) && vatPercent > 0 ? vatPercent : 0;
  const net = Number.isFinite(netHuf) ? netHuf : 0;
  return { net, vat: Math.round(net * (vat / 100)), gross: Math.round(net * (1 + vat / 100)) };
}
