import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePassword, getPassword, hasPassword, setPassword } from "../lib/engine/secrets.js";

test("DPAPI: a jelszó oda-vissza olvasható, majd törölhető", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ftp-secret-"));
  const file = join(dir, "proba.dpapi");
  try {
    assert.equal(hasPassword(file), false);
    assert.equal(await getPassword(file), null);

    await setPassword(file, "titok-Árvíztűrő-1234");
    assert.equal(hasPassword(file), true);
    assert.equal(await getPassword(file), "titok-Árvíztűrő-1234");

    deletePassword(file);
    assert.equal(hasPassword(file), false);
    assert.equal(await getPassword(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DPAPI: a titkosított fájl nem tartalmazza a jelszót nyílt szövegként", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ftp-secret-"));
  const file = join(dir, "proba.dpapi");
  try {
    await setPassword(file, "NYILT-JELSZO-ABCDEF");
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(file).toString("latin1");
    assert.equal(raw.includes("NYILT-JELSZO-ABCDEF"), false, "a fájl nem plain text");
    assert.ok(raw.length > 0, "van titkosított tartalom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
