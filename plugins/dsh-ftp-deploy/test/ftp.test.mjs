import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUSH_ATTEMPTS,
  PUSH_RETRY_DELAY_MS,
  errorText,
  formatStamp,
  isRetryable,
  uniqueZipPath,
} from "../lib/engine/ftp.js";

test("újrapróbálkozás: csak az átmeneti hibák", () => {
  for (const message of [
    "ECONNRESET",
    "socket hang up",
    "connection reset by peer",
    "ETIMEDOUT",
    "421 Service not available",
    "425 can't open data connection",
  ]) {
    assert.equal(isRetryable(new Error(message)), true, `${message} legyen újrapróbálható`);
  }
  for (const message of [
    "530 Login incorrect",
    "550 Can't create directory",
    "552 Quota exceeded",
    "553 File name not allowed",
  ]) {
    assert.equal(isRetryable(new Error(message)), false, `${message} NEM próbálható újra`);
  }
});

test("újrapróbálkozás: 4xx kódú hiba újrapróbálható, 5xx nem", () => {
  assert.equal(isRetryable(Object.assign(new Error("valami"), { code: 451 })), true);
  assert.equal(isRetryable(Object.assign(new Error("valami"), { code: 550 })), false);
});

test("újrapróbálkozás: a korlát kötött (AGENTS §1.7)", () => {
  assert.equal(PUSH_ATTEMPTS, 3);
  assert.equal(PUSH_RETRY_DELAY_MS.length, 2);
  assert.ok(PUSH_RETRY_DELAY_MS[1] > PUSH_RETRY_DELAY_MS[0], "növekvő várakozás");
});

test("errorText: minden bemenetre szöveget ad", () => {
  assert.equal(errorText(new Error("x")), "x");
  assert.equal(errorText("szoveg"), "szoveg");
  assert.equal(errorText(null), "ismeretlen hiba");
  assert.equal(errorText(undefined), "ismeretlen hiba");
});

test("formatStamp: olvasható, rendezhető időbélyeg", () => {
  assert.equal(formatStamp(new Date(2026, 10, 16, 9, 5, 7)), "20261116_090507");
  assert.equal(formatStamp(new Date(2026, 0, 2, 23, 59, 1)), "20260102_235901");
});

test("uniqueZipPath: soha nem ír felül meglévő fájlt", () => {
  const dir = mkdtempSync(join(tmpdir(), "ftp-zip-"));
  try {
    const first = uniqueZipPath(dir, "proba");
    assert.equal(first, join(dir, "proba.zip"));
    writeFileSync(first, "x");
    const second = uniqueZipPath(dir, "proba");
    assert.equal(second, join(dir, "proba-2.zip"));
    writeFileSync(second, "x");
    assert.equal(uniqueZipPath(dir, "proba"), join(dir, "proba-3.zip"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
