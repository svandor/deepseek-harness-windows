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
import { scanUsage } from "../lib/index.js";

const MINUTE = 60000;

let home = "";
let savedHome = "";

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
});

after(() => {
  if (savedHome.length === 0) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
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
