/**
 * Profil-tár: `state\ftp-profiles.json` (gitignore-olt).
 *
 * A Felpuffantó `profiles.ts` portja, azzal a különbséggel, hogy a fájl a
 * munkaterület `state\` mappájában van, és a profil kap egy `allow` listát
 * (a tiltott `storage` alóli kivételek profil-szinten, nem kódba égetve).
 *
 * MÉRT BUKTATÓ, amit megtartunk: a PowerShell `Set-Content` UTF-8 BOM-ot ír, a
 * `JSON.parse` pedig elutasítja — ezért a beolvasás levágja a BOM-ot.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { assertLocalRoot, assertRemoteRoot } from "./deny.js";
import { posixRel as toPosix } from "./paths.js";

function emptyStore() {
  return { profiles: [] };
}

export function loadStore(profilesPath) {
  if (!existsSync(profilesPath)) return emptyStore();
  try {
    const text = readFileSync(profilesPath, "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.profiles)) return emptyStore();
    return raw;
  } catch {
    return emptyStore();
  }
}

export function saveStore(profilesPath, store) {
  writeFileSync(profilesPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

const normList = (list) =>
  (Array.isArray(list) ? list : [])
    .map((i) => toPosix(i).replace(/\/+$/, ""))
    .filter((i) => i.length > 0);

/** Profil normalizálása + ellenőrzése (a `deny.js` őrjeivel). */
export function normalizeProfile(input) {
  const include = normList(input.include);
  const profile = {
    id: String(input.id ?? "").trim(),
    name: String(input.name ?? "").trim(),
    host: String(input.host ?? "").trim(),
    port: Number(input.port) || 21,
    user: String(input.user ?? "").trim(),
    passive: input.passive !== false,
    tls: Boolean(input.tls),
    localRoot: assertLocalRoot(input.localRoot),
    remoteRoot: assertRemoteRoot(input.remoteRoot, include),
    include,
    allow: normList(input.allow),
    extraUpload: normList(input.extraUpload),
    lastDeploySha: input.lastDeploySha ?? null,
  };
  if (!profile.id) throw new Error("A profil id kötelező.");
  if (!profile.host) throw new Error("A host kötelező.");
  if (profile.include.length === 0) throw new Error("Legalább egy include mappa kell.");
  return profile;
}

export function listProfiles(profilesPath) {
  return loadStore(profilesPath).profiles;
}

export function getProfile(profilesPath, id) {
  const found = listProfiles(profilesPath).find((p) => p.id === id);
  if (!found) throw new Error(`Nincs ilyen profil: ${id}`);
  return found;
}

export function upsertProfile(profilesPath, input) {
  const profile = normalizeProfile(input);
  const store = loadStore(profilesPath);
  const idx = store.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) store.profiles[idx] = profile;
  else store.profiles.push(profile);
  saveStore(profilesPath, store);
  return profile;
}

export function deleteProfile(profilesPath, id) {
  const store = loadStore(profilesPath);
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  saveStore(profilesPath, store);
  return before !== store.profiles.length;
}

export function setLastDeploySha(profilesPath, id, sha) {
  const profile = getProfile(profilesPath, id);
  profile.lastDeploySha = sha;
  return upsertProfile(profilesPath, profile);
}
