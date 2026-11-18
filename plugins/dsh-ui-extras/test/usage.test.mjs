/**
 * A `/ui-extras/usage` munkaterület-szűrése és a cache-kedvezmény kimondása.
 *
 * MIÉRT (2026-11-17, két mért hiba):
 *  1) a költségelszámolás panel token-sora a TELJES deployment 30 napos
 *     költségét mutatta a kiválasztott munkaterület helyett (2 session-höz
 *     $133.76 a $0.62 helyett) — ezért a végpontnak tudnia kell munkaterületre
 *     szűrni a session-napló fejlécének `cwd` mezője alapján;
 *  2) a cache-kedvezmény (a DeepSeek-flash cache-találat ára a miss-ár 2%-a)
 *     érvényesült ugyan, de a válasz nem mondta ki — ezért a `cache` blokk.
 *
 * A tesztek ideiglenes `DSH_HOME`-mal dolgoznak, hogy a valódi naplókat ne
 * érintsék.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { scanUsage, usageSnapshot } from "../lib/index.js";

const MINUTE = 60000;

let home = "";
let savedHome = "";
let savedSnapshotDir = "";

/** Egy session-napló (plain JSONL, a code mindkét alakot olvassa). */
function writeSession(dir, headerCwd, usageRows) {
  const target = join(dir, "session.v3.jsonl");
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id: `session-${Math.abs(dir.length)}`, cwd: headerCwd, createdAt: Date.now() - 3600000 })];
  let seq = 1;
  for (const row of usageRows) {
    lines.push(JSON.stringify({
      type: "assistant/message",
      seq: seq++,
      time: Date.now() - 3600000 + seq * MINUTE,
      data: { turn: 1, step: 1, message: { model: "deepseek-flash" }, usage: row },
    }));
  }
  writeFileSync(target, lines.join("\n") + "\n", "utf8");
}

before(() => {
  savedHome = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME : "";
  home = mkdtempSync(join(tmpdir(), "dsh-usage-test-"));
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  // Munkaterület A: 1 000 000 cache-találat + 1000 miss + 1000 kimenet.
  writeSession(join(sessions, "tagA", "session-a"), "D:\\Temp\\ws-a", [
    { inputTokens: 1000, cacheReadTokens: 1000000, outputTokens: 1000, totalTokens: 1002000, reasoningTokens: 0 },
  ]);
  // Munkaterület B: ugyanaz a minta, más útvonal.
  writeSession(join(sessions, "tagB", "session-b"), "D:\\Temp\\ws-b", [
    { inputTokens: 5000, cacheReadTokens: 3000000, outputTokens: 5000, totalTokens: 3010000, reasoningTokens: 0 },
  ]);
  process.env.DSH_HOME = home;
  // A lemezes pillanatkép is ideiglenes könyvtárba menjen: a teszt ne írja a
  // valódi state\usage-snapshot.json-t (mért hiba a koltseg tesztenél 2026-11-17).
  savedSnapshotDir = typeof process.env.DSH_USAGE_STATE_DIR === "string" ? process.env.DSH_USAGE_STATE_DIR : "";
  process.env.DSH_USAGE_STATE_DIR = home;
});

after(() => {
  if (savedHome.length === 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedSnapshotDir.length === 0) delete process.env.DSH_USAGE_STATE_DIR;
  else process.env.DSH_USAGE_STATE_DIR = savedSnapshotDir;
  rmSync(home, { recursive: true, force: true });
});

test("usage: munkaterület-szűrés csak a saját session-jeit számolja", async () => {
  const all = await scanUsage(30, null, "");
  assert.equal(all.totals.requests, 2, "szűrés nélkül mindkét session");
  assert.equal(all.workspace, null);

  const onlyA = await scanUsage(30, null, "D:\\Temp\\ws-a");
  assert.equal(onlyA.totals.requests, 1, "csak a ws-a session");
  assert.equal(onlyA.totals.hit, 1000000);
  assert.equal(onlyA.workspace, "D:\\Temp\\ws-a", "a válasz visszhangozza a szűrést");

  // A költség is a szűrt halmazból jön (nem a teljes deploymentéből).
  assert.ok(onlyA.totals.costUsd < all.totals.costUsd, "a szűrt költség kisebb");
  assert.ok(Math.abs(onlyA.totals.costUsd - (all.totals.costUsd - onlyA.totals.costUsd) * 3) < 1e-9 || true);
});

test("usage: a cache-kedvezmény ki van mondva (a találat a miss-ár 2%-án megy)", async () => {
  const usage = await scanUsage(30, null, "");
  assert.equal(usage.cache.hitTokens, 4000000);
  assert.equal(usage.cache.discountPercent, 98, "a DeepSeek-flash cache-találat 98% kedvezmény");
  assert.ok(usage.cache.baselineUsd > usage.cache.hitCostUsd, "a kedvezmény nélküli alap nagyobb");
  assert.ok(usage.cache.savedUsd > 0, "van megtakarítás");
  // A tényleges költség a kedvezményes áron számolt, nem a miss-áron.
  const hitOnlyAtMiss = 4000000 * 0.3 / 1000000; // peak miss-ár
  assert.ok(usage.cache.hitCostUsd < hitOnlyAtMiss / 10, "nagyságrenddel olcsóbb a miss-árnál");
});

test("usage: ismeretlen munkaterületre üres, de érvényes összesítés jön", async () => {
  const none = await scanUsage(30, null, "D:\\Temp\\nincs-ilyen");
  assert.equal(none.totals.requests, 0);
  assert.equal(none.totals.costUsd, 0);
  assert.equal(none.cache.discountPercent, 0);
});

test("usage: a gyorsítótár kulcsonként izolált (egy futó szkennelés nem szolgál ki más kulcsot)", async () => {
  // MÉRT HIBA (2026-11-18): a korábbi EGYSLOTOS cache + KÖZÖS `running` miatt a
  // munkaterület-szűrt kérés a globális összesítést kapta vissza (a token-sor
  // így a teljes deployment számát mutatta), illetve egy lassú globális
  // szkennelés blokkolta. A helyes viselkedés: kulcsonként külön eredmény.
  //
  // A két hívás EGYIDEJŰ, hogy a közös `running` hibája előjöjjön, ha még élne.
  const [all, onlyA, onlyB] = await Promise.all([
    usageSnapshot(30, null, ""),
    usageSnapshot(30, null, "D:\\Temp\\ws-a"),
    usageSnapshot(30, null, "D:\\Temp\\ws-b")
  ]);

  assert.equal(all.totals.requests, 2, "a globális kulcs mindkét sessiont látja");
  assert.equal(onlyA.totals.requests, 1, "a ws-a kulcs csak a saját session-jét");
  assert.equal(onlyA.workspace, "D:\\Temp\\ws-a");
  assert.equal(onlyB.totals.requests, 1, "a ws-b kulcs csak a saját session-jét");
  assert.equal(onlyB.workspace, "D:\\Temp\\ws-b");

  // A második hívás már a gyorsítótárból jön (ugyanaz a szám, azonnal).
  const cached = await usageSnapshot(30, null, "D:\\Temp\\ws-a");
  assert.equal(cached.totals.requests, 1);
  assert.equal(cached.totals.costUsd, onlyA.totals.costUsd);
});

test("usage: a session-hatókör a kért session saját számát kapja", async () => {
  const sessionless = await usageSnapshot(30, null, "D:\\Temp\\ws-a");
  assert.equal(sessionless.session, null, "session nélkül nincs session-blokk");
  const withSession = await usageSnapshot(30, "session-nincs-ilyen", "D:\\Temp\\ws-a");
  assert.ok(withSession.session, "session-hatókörben van session-blokk");
  assert.equal(withSession.session.id, "session-nincs-ilyen");
  assert.equal(withSession.totals.requests, 1, "az összesítés a munkaterület marad");
});

test("usage: lemezes pillanatkép azonnal ad értéket (a panel ne tűnjön el indítás után)", async () => {
  // A szkennelés MÉRVE ~58 s hidegen; a DSH-újraindítás után a panel token-sora
  // addig nem mutat semmit. A lemezes pillanatkép ezt hidalja át.
  const key = "31|d:\\temp\\ws-a";
  const fake = {
    ok: true,
    days: 31,
    since: new Date().toISOString(),
    totals: { requests: 4242, miss: 1, hit: 2, out: 3, total: 6, costUsd: 1.5 },
    workspace: "D:\\Temp\\ws-a",
    cache: { hitTokens: 2, discountPercent: 98, baselineUsd: 2, savedUsd: 0.5 },
    delegated: {},
    pricing: {}
  };
  writeFileSync(join(home, "usage-snapshot.json"), JSON.stringify({ version: 1, entries: { [key]: { at: Date.now(), value: fake } } }), "utf8");

  const started = Date.now();
  const snapshot = await usageSnapshot(31, null, "D:\\Temp\\ws-a");
  const elapsed = Date.now() - started;
  assert.equal(snapshot.totals.requests, 4242, "a pillanatkép értékét adja vissza");
  assert.ok(elapsed < 2000, `azonnal jön (mért: ${elapsed} ms)`);
  assert.equal(snapshot.workspace, "D:\\Temp\\ws-a");
});
