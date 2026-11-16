import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteProfile,
  getProfile,
  listProfiles,
  loadStore,
  normalizeProfile,
  setLastDeploySha,
  upsertProfile,
} from "../lib/engine/profiles.js";

function makePaths() {
  const dir = mkdtempSync(join(tmpdir(), "ftp-profiles-"));
  return { dir, profilesPath: join(dir, "ftp-profiles.json") };
}

const base = {
  id: "proba",
  name: "Próba",
  host: "fw.example.hu",
  port: 2141,
  user: "web1",
  localRoot: "C:\\Herd\\proba",
  remoteRoot: "/web/proba",
  include: ["app"],
};

test("normalizeProfile: a remoteRoot /web tiltott, ha nem csak átirányító", () => {
  assert.throws(() => normalizeProfile({ ...base, remoteRoot: "/web" }), /nem lehet \/web/);
  const redirect = normalizeProfile({
    ...base,
    remoteRoot: "/web",
    include: [".htaccess", "index.php"],
  });
  assert.equal(redirect.remoteRoot, "/web");
});

test("normalizeProfile: kötelező mezők és a per-jelölés", () => {
  assert.throws(() => normalizeProfile({ ...base, id: "" }), /id kötelező/);
  assert.throws(() => normalizeProfile({ ...base, host: "" }), /host kötelező/);
  assert.throws(() => normalizeProfile({ ...base, include: [] }), /include mappa/);
  const p = normalizeProfile({ ...base, include: ["app\\sub\\"], extraUpload: ["storage\\x\\"] });
  assert.deepEqual(p.include, ["app/sub"]);
  assert.deepEqual(p.extraUpload, ["storage/x"]);
  assert.equal(p.port, 2141);
  assert.equal(p.passive, true);
  assert.equal(p.tls, false);
});

test("tár: upsert, olvasás, törlés (ideiglenes fájlon)", () => {
  const { dir, profilesPath } = makePaths();
  try {
    assert.deepEqual(listProfiles(profilesPath), []);
    upsertProfile(profilesPath, base);
    upsertProfile(profilesPath, { ...base, id: "masodik" });
    assert.deepEqual(listProfiles(profilesPath).map((p) => p.id), ["proba", "masodik"]);
    upsertProfile(profilesPath, { ...base, name: "Átnevezve" });
    assert.equal(getProfile(profilesPath, "proba").name, "Átnevezve");
    assert.equal(getProfile(profilesPath, "proba").lastDeploySha, null);
    setLastDeploySha(profilesPath, "proba", "abc123");
    assert.equal(getProfile(profilesPath, "proba").lastDeploySha, "abc123");
    assert.equal(deleteProfile(profilesPath, "masodik"), true);
    assert.equal(deleteProfile(profilesPath, "nincs-ilyen"), false);
    assert.deepEqual(listProfiles(profilesPath).map((p) => p.id), ["proba"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tár: a PowerShell BOM-ját elviseli", () => {
  const { dir, profilesPath } = makePaths();
  try {
    writeFileSync(profilesPath, `\uFEFF${JSON.stringify({ profiles: [base] })}`, "utf8");
    assert.equal(loadStore(profilesPath).profiles.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tár: sérült JSON nem dob, üres tárat ad", () => {
  const { dir, profilesPath } = makePaths();
  try {
    writeFileSync(profilesPath, "{ ez nem json", "utf8");
    assert.deepEqual(listProfiles(profilesPath), []);
    assert.equal(existsSync(profilesPath), true, "a fájlt nem törli");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
