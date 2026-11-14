/**
 * A panel-futás kimenetének lemezes tükre — teszt (harness NÉLKÜL).
 *
 * MIÉRT: a felhasználó jelezte (2026-11-14), hogy a harness újraindítása után
 * az `npm run dev` terminál újra megnyílt, de a TARTALMA elveszett. A javítás
 * az, hogy minden kimenet a `state\runs\<id>-<időbélyeg>.log` fájlba is megy,
 * és a visszatöltés onnan olvassa a termimál eddigi tartalmát.
 *
 * Ez a teszt a primitíveket méri: az útvonal alakját, a hozzáfűzést (memória +
 * lemez), a 200 kB-os memória-korlátot, és a farok-olvasást (a lemezről).
 *
 * Futtatás: node --test plugins/dsh-ui-extras/test/run-log.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLogPath, appendToRunOutput, tailRunLog } from "../lib/index.js";

test("a napló útvonala a state\\runs alá mutat, az id-t és az időbélyeget hordozva", () => {
  const path = runLogPath("run-7", "2026-11-14T21:14:08.000Z");
  assert.match(path, /state[\\/]runs[\\/]run-7-20261114211408\.log$/u);
  // két különböző indulás azonos run-id mellett sem írja felül egymást
  const other = runLogPath("run-7", "2026-11-15T09:00:00.000Z");
  assert.notEqual(path, other);
});

test("a hozzáfűzés a memóriába ÉS a lemezre kerül, a farok-olvasás visszaadja", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-log-"));
  const file = join(dir, "run-1-20261114211408.log");
  const run = { output: "", logFile: file };
  appendToRunOutput(run, "elso sor\r\n");
  appendToRunOutput(run, "masodik sor\r\n");

  assert.equal(run.output, "elso sor\r\nmasodik sor\r\n", "a memóriabeli puffer él");
  assert.ok(existsSync(file), "a lemezes napló létrejött");
  assert.equal(readFileSync(file, "utf8"), "elso sor\r\nmasodik sor\r\n");
  assert.equal(tailRunLog(file), "elso sor\r\nmasodik sor\r\n", "a visszatöltés a fájlból olvas");

  rmSync(dir, { recursive: true, force: true });
});

test("a memóriabeli puffer 200 kB-nál vág, a naplófájl NEM (a tartalom megmarad)", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-log-"));
  const file = join(dir, "run-2.log");
  const run = { output: "", logFile: file };
  const chunk = "x".repeat(10000);
  for (let index = 0; index < 25; index++) appendToRunOutput(run, chunk);

  assert.ok(run.output.length <= 200000, `memória-korlát: ${run.output.length}`);
  assert.equal(readFileSync(file, "utf8").length, 250000, "a lemezre minden darab bekerült");

  rmSync(dir, { recursive: true, force: true });
});

test("a farok-olvasás hiányzó fájlra üres, létezőre a végét adja", () => {
  assert.equal(tailRunLog(""), "");
  assert.equal(tailRunLog(join(tmpdir(), "nincs-ilyen-devadmin-log.log")), "");

  const dir = mkdtempSync(join(tmpdir(), "run-log-"));
  const file = join(dir, "long.log");
  const run = { output: "", logFile: file };
  for (let index = 1; index <= 100; index++) appendToRunOutput(run, `sor-${index}\n`);
  const tail = tailRunLog(file, 50);
  assert.ok(tail.length <= 50, "a limit érvényes");
  assert.ok(tail.endsWith("\n"), "a fájl végéről olvas");

  rmSync(dir, { recursive: true, force: true });
});
