/**
 * A böngésző-profilok tesztjei (valódi temp könyvtáron, hálózat nélkül).
 *
 * Futtatás: `node --test plugins/dsh-browser/test/`
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listProfiles, pruneEphemeral, removeEphemeral, resolveProfile, trashProfile, validateProfileName } from "../lib/profiles.js";

const root = mkdtempSync(join(tmpdir(), "dsh-browser-profiles-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a profil neve kötelező és biztonságos alakú", () => {
  assert.equal(validateProfileName("lineageos").ok, true);
  assert.equal(validateProfileName("lineageOS").name, "lineageos", "kisbetűsít");
  assert.equal(validateProfileName("").ok, false);
  assert.equal(validateProfileName("../etc").ok, false, "útvonal-injektálás tiltva");
  assert.equal(validateProfileName("a b").ok, false, "szóköz nem mehet");
  assert.equal(validateProfileName("-kezdo").ok, false);
  assert.equal(validateProfileName("x".repeat(42)).ok, false);
});

test("az eldobható profil futásonként új könyvtár, tmp- előtaggal", () => {
  const a = resolveProfile({ rootDir: root, mode: "ephemeral" });
  const b = resolveProfile({ rootDir: root, mode: "ephemeral" });
  assert.equal(a.ephemeral, true);
  assert.equal(a.mode, "ephemeral");
  assert.equal(b.dir === a.dir, false, "két futás nem oszthat könyvtárat");
  assert.equal(a.dir.split(/[\\/]/u).pop().startsWith("tmp-"), true);
  assert.equal(existsSync(a.dir), true);
});

test("a tartós profil megmarad és metaadatot kap", () => {
  const profile = resolveProfile({ rootDir: root, mode: "persistent", name: "lineageos", now: () => new Date("2026-11-26T05:00:00Z") });
  assert.equal(profile.mode, "persistent");
  assert.equal(profile.name, "lineageos");
  assert.equal(existsSync(profile.dir), true);
  const meta = JSON.parse(readFileSync(join(profile.dir, "dsh-profile.json"), "utf8"));
  assert.equal(meta.createdAt, "2026-11-26T05:00:00.000Z");
  // A tartós profil nem tűnik el egy "zárás" után.
  assert.equal(existsSync(profile.dir), true);
});

test("a tartós profil neve nélkül hiba van (nem csendes eldobható)", () => {
  assert.throws(() => resolveProfile({ rootDir: root, mode: "persistent", name: "" }), /kötelező/u);
});

test("a lista a tartós profilokat mutatja, a temp és lomtár mappákat nem", () => {
  resolveProfile({ rootDir: root, mode: "persistent", name: "masodik" });
  writeFileSync(join(root, "lineageos", "Cookies"), "suti", "utf8");
  const names = listProfiles(root).map((entry) => entry.name);
  assert.deepEqual(names, ["lineageos", "masodik"]);
  assert.equal(listProfiles(root).every((entry) => !entry.name.startsWith("tmp-")), true);
  assert.equal(listProfiles(root)[0].bytes > 0, true);
});

test("a törlés LOMTÁRBA megy (visszaállítható), nem töröl", () => {
  const before = listProfiles(root).length;
  const result = trashProfile(root, "masodik", () => new Date("2026-11-26T05:10:00Z"));
  assert.equal(result.ok, true);
  assert.equal(existsSync(result.movedTo), true, "a lomtár-mappa létezik");
  assert.equal(listProfiles(root).length, before - 1);
  assert.equal(readdirSync(root).some((name) => name.startsWith(".trash-")), true);
  assert.equal(trashProfile(root, "nincs-ilyen").ok, false);
});

test("az eldobható takarítás csak a tmp- mappákhoz nyúl", () => {
  const persistent = resolveProfile({ rootDir: root, mode: "persistent", name: "megmarad" });
  removeEphemeral(persistent.dir);
  assert.equal(existsSync(persistent.dir), true, "a tartós profilt nem törölheti");
  const ephemeral = resolveProfile({ rootDir: root, mode: "ephemeral" });
  removeEphemeral(ephemeral.dir);
  assert.equal(existsSync(ephemeral.dir), false);
});

test("a RÉGI eldobható profilok kisöprése, a friss megmarad", () => {
  const fresh = resolveProfile({ rootDir: root, mode: "ephemeral" });
  const stale = join(root, "tmp-regi-futas");
  mkdirSync(stale);
  const past = new Date(Date.now() - 7200000);
  utimesSync(stale, past, past);
  const removed = pruneEphemeral(root, 3600000);
  assert.equal(existsSync(stale), false, "a régi mappa kitakarítva");
  assert.equal(removed >= 1, true);
  assert.equal(existsSync(fresh.dir), true, "a friss temp profil megmarad");
  removeEphemeral(fresh.dir);
});
