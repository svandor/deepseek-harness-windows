/**
 * A költségelszámolás konfigurációja — óradíj, profilok, repó-felülírások.
 *
 * A döntés (2026-11-16, felhasználó): a repó-szintű óradíj a KÖZPONTI
 * `state\koltseg\config.json`-ban él, a felületről írva. A repókba semmi nem
 * kerül (nincs git-zaj, nincs véletlen commit).
 *
 * Minden bejövő érték validálódik és a tartományára vágódik: a rossz beállítás
 * nem dob hibát a felületen, hanem a legközelebbi értelmes értékre áll, és a
 * válasz kimondja, mit módosított a normalizálás.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_PROFILE_ID, PRESET_PROFILES, normalizeProfile, presetProfile } from "./profile.js";

/** A konfiguráció fájlneve a plugin állapotkönyvtárában. */
export const CONFIG_FILE = "config.json";

/** A magyarországi ÁFA, amit a felület egy kapcsolóval kérhet. */
export const DEFAULT_VAT_PERCENT = 27;

/** Gyári alapállapot (a felhasználó által megadott 12 500 Ft óradíjjal). */
export function defaultConfig() {
  return {
    version: 1,
    currency: "HUF",
    defaultRate: 12500,
    defaultProfile: DEFAULT_PROFILE_ID,
    vatPercent: DEFAULT_VAT_PERCENT,
    vatEnabled: false,
    materialCost: false,
    profiles: [],
    workspaces: {},
    updatedAt: 0,
  };
}

/**
 * Kanonikus munkaterület-kulcs: a junction feloldása után.
 *
 * Ugyanaz a szabály, mint a paneleknél (`dsh-ui-extras` `canonicalWorkspace`):
 * a `D:\...` és a junction-elt `C:\...` alak ne legyen két külön kulcs.
 */
export function canonicalWorkspace(value) {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  const trimmed = value.trim();
  try {
    return typeof realpathSync.native === "function" ? realpathSync.native(trimmed) : realpathSync(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * A munkaterület-kulcs normalizálása a konfigurációban: mindig kanonikus alak.
 * A meglévő bejegyzéseket is átírja, hogy a korábbi (literális) kulcsok ne
 * maradjanak két példányban.
 */
export function normalizeWorkspaceKeys(config) {
  const out = {};
  let merged = 0;
  const source = config?.workspaces !== null && typeof config?.workspaces === "object" ? config.workspaces : {};
  for (const [key, value] of Object.entries(source)) {
    const canonical = canonicalWorkspace(key);
    if (canonical.length === 0) continue;
    const entry = value !== null && typeof value === "object" ? value : {};
    if (out[canonical] !== undefined) merged += 1;
    out[canonical] = {
      ...(out[canonical] ?? {}),
      ...entry,
    };
  }
  return { workspaces: out, merged };
}

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Konfiguráció normalizálása + validálás.
 * @param {unknown} input
 * @returns {{config: object, errors: string[]}}
 */
export function normalizeConfig(input) {
  const base = defaultConfig();
  const source = input !== null && typeof input === "object" ? input : {};
  const errors = [];

  const defaultRate = clampNumber(source.defaultRate, 0, 1000000, base.defaultRate);
  if (source.defaultRate !== undefined && defaultRate !== Number(source.defaultRate)) {
    errors.push(`óradíj: ${source.defaultRate} -> ${defaultRate}`);
  }

  // A profil-lista: előre definíciók + egyedi profilok (azonos id felülír).
  const custom = [];
  if (Array.isArray(source.profiles)) {
    for (const entry of source.profiles) {
      if (entry === null || typeof entry !== "object") continue;
      const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
      if (rawId.length === 0) {
        errors.push("egyedi profil azonosító nélkül kimaradt");
        continue;
      }
      if (PRESET_PROFILES.some((preset) => preset.id === rawId)) {
        errors.push(`egyedi profil "${rawId}" nem írhatja felül az előre definiált profilt`);
        continue;
      }
      const normalized = normalizeProfile({ ...entry, id: rawId });
      for (const message of normalized.errors) errors.push(`${rawId}: ${message}`);
      custom.push(normalized.profile);
    }
  }

  const knownProfiles = new Set([...PRESET_PROFILES.map((preset) => preset.id), ...custom.map((profile) => profile.id)]);
  const defaultProfile = typeof source.defaultProfile === "string" && knownProfiles.has(source.defaultProfile)
    ? source.defaultProfile
    : base.defaultProfile;
  if (source.defaultProfile !== undefined && defaultProfile !== source.defaultProfile) {
    errors.push(`alap profil: "${source.defaultProfile}" ismeretlen -> "${defaultProfile}"`);
  }

  const workspaces = {};
  const rawWorkspaces = source.workspaces !== null && typeof source.workspaces === "object" ? source.workspaces : {};
  for (const [key, value] of Object.entries(rawWorkspaces)) {
    const canonical = canonicalWorkspace(key);
    if (canonical.length === 0) continue;
    const entry = value !== null && typeof value === "object" ? value : {};
    const next = {};
    if (entry.rate !== undefined && entry.rate !== null && entry.rate !== "") {
      const rate = clampNumber(entry.rate, 0, 1000000, defaultRate);
      if (rate !== Number(entry.rate)) errors.push(`${canonical}: óradíj ${entry.rate} -> ${rate}`);
      next.rate = rate;
    }
    if (typeof entry.profile === "string" && entry.profile.length > 0) {
      if (knownProfiles.has(entry.profile)) next.profile = entry.profile;
      else errors.push(`${canonical}: ismeretlen profil "${entry.profile}" kihagyva`);
    }
    if (Object.keys(next).length > 0) workspaces[canonical] = next;
  }

  return {
    errors,
    config: {
      version: 1,
      currency: "HUF",
      defaultRate,
      defaultProfile,
      vatPercent: clampNumber(source.vatPercent, 0, 99, base.vatPercent),
      vatEnabled: source.vatEnabled === true,
      materialCost: source.materialCost === true,
      profiles: custom,
      workspaces,
      updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : Date.now(),
    },
  };
}

/** A konfiguráció útvonala az állapotkönyvtárban. */
export function configPath(stateDir) {
  return join(stateDir, "koltseg", CONFIG_FILE);
}

/**
 * A konfiguráció betöltése. Hiányzó vagy sérült fájl esetén a gyári alap jön,
 * `source: "default"` jelzéssel (a felület ezt kiírja).
 * @param {string} stateDir
 * @returns {{config: object, source: "file"|"default"|"recovered", error: string, path: string}}
 */
export function loadConfig(stateDir) {
  const path = configPath(stateDir);
  if (!existsSync(path)) return { config: defaultConfig(), source: "default", error: "", path };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { config: defaultConfig(), source: "default", error: String(error?.message ?? error), path };
  }
  // BOM-védelem: a PowerShell `Set-Content -Encoding utf8` BOM-ot tesz, a
  // `JSON.parse` pedig elutasítja (MÉRT hiba a Kiadás gombnál, AGENTS 11. kör).
  const text = raw.replace(/^\uFEFF/u, "").trim();
  if (text.length === 0) return { config: defaultConfig(), source: "default", error: "", path };
  try {
    const parsed = JSON.parse(text);
    const { config, errors } = normalizeConfig(parsed);
    return { config, source: errors.length > 0 ? "recovered" : "file", error: errors.join("; "), path };
  } catch (error) {
    return { config: defaultConfig(), source: "default", error: `érvénytelen JSON: ${String(error?.message ?? error)}`, path };
  }
}

/**
 * A konfiguráció mentése atomikusan (temp + rename), BOM nélkül.
 * @param {string} stateDir
 * @param {unknown} input
 * @returns {{config: object, errors: string[], path: string}}
 */
export function saveConfig(stateDir, input) {
  const { config, errors } = normalizeConfig(input);
  const path = configPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = { ...config, updatedAt: Date.now() };
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return { config: payload, errors, path };
}

/** Az összes választható profil: előre definiáltak + egyediek. */
export function profilesOf(config) {
  const custom = Array.isArray(config?.profiles) ? config.profiles : [];
  const presetIds = new Set(PRESET_PROFILES.map((preset) => preset.id));
  return [
    ...PRESET_PROFILES.map((preset) => presetProfile(preset.id)),
    ...custom.filter((profile) => !presetIds.has(profile.id)),
  ];
}

/** Egy profil feloldása azonosító alapján (ismeretlen -> az alapértelmezett). */
export function profileOf(config, id) {
  const wanted = typeof id === "string" && id.length > 0 ? id : config?.defaultProfile ?? DEFAULT_PROFILE_ID;
  const found = profilesOf(config).find((profile) => profile.id === wanted);
  return found ?? presetProfile(DEFAULT_PROFILE_ID);
}

/**
 * Az érvényes óradíj és profil egy munkaterületre.
 *
 * Elsőbbség: munkaterület-felülírás > globális alap. A válasz kimondja a
 * forrást, mert a felületnek ezt meg kell jelenítenie („globális" / „repó").
 * @param {object} config
 * @param {string} workspace
 * @param {string} [profileOverride] a felületen éppen kiválasztott profil
 * @returns {{rate: number, rateSource: "workspace"|"global", profileId: string, profileSource: "request"|"workspace"|"global"}}
 */
export function resolveRate(config, workspace, profileOverride) {
  const key = canonicalWorkspace(workspace);
  const entry = key.length > 0 && config?.workspaces !== null && typeof config?.workspaces === "object"
    ? config.workspaces[key]
    : undefined;
  const workspaceRate = entry !== null && typeof entry === "object" ? entry.rate : undefined;
  const rate = Number.isFinite(workspaceRate) ? workspaceRate : (Number.isFinite(config?.defaultRate) ? config.defaultRate : 12500);
  const rateSource = Number.isFinite(workspaceRate) ? "workspace" : "global";

  if (typeof profileOverride === "string" && profileOverride.length > 0) {
    return { rate, rateSource, profileId: profileOverride, profileSource: "request" };
  }
  const workspaceProfile = entry !== null && typeof entry === "object" ? entry.profile : undefined;
  if (typeof workspaceProfile === "string" && workspaceProfile.length > 0) {
    return { rate, rateSource, profileId: workspaceProfile, profileSource: "workspace" };
  }
  return { rate, rateSource, profileId: config?.defaultProfile ?? DEFAULT_PROFILE_ID, profileSource: "global" };
}

/** Üres konfiguráció-útvonal a plugin állapotkönyvtárához (diagnosztikához). */
export function stateDirOf(repoRoot) {
  return join(repoRoot, "state");
}

/** A DSH home (a felület tájékoztatásához, ha kell). */
export function homeDir() {
  return typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : homedir();
}

/** Abszolút útvonal-e (a bemenet ellenőrzéséhez). */
export function isAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}
