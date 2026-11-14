/**
 * Egységtesztek a `dsh-session-auto-continue` döntési logikájára.
 *
 * MIÉRT: a plugin élesben csak BOOTKOR fut, a viselkedését tehát nem lehet
 * „próbálgatással" hitelesíteni — minden hiba egy harness-újraindításba
 * kerülne. A teszt ezért mock `ctx`-szel dolgozik: ellenőrzi a prompt-belépő
 * feloldását, a megszakadt kör felismerését, az élő kör kihagyását és a jelölő
 * (dupla küldés elleni) védelmét.
 *
 * FUTTATÁS: node --test plugins\dsh-session-auto-continue\test\plugin.test.mjs
 *
 * MEGJEGYZÉS: a plugin 8 s késleltetéssel indít, ezért egy-egy teszt ~9 s.
 * A teszt a `state\auto-continue.json` jelölőt használja és a végén üríti.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATE_DIR = join(PLUGIN_ROOT, "..", "..", "state");
const MARKER_PATH = join(STATE_DIR, "auto-continue.json");
const WAIT_MS = 9000;

// IZOLÁCIÓ: a plugin a lemezről is olvasná a VALÓDI session-naplókat, azokban
// pedig ott a most futó beszélgetés nyitott köre — a teszt ettől hamis
// találatot kapna. Ezért üres temp mappára állítjuk a napló-gyökeret.
process.env.DSH_AUTO_CONTINUE_SESSIONS_ROOT = mkdtempSync(join(tmpdir(), "dsh-autocontinue-"));

/** @param {string} id @param {object[]} events */
function fakeSession(id, events) {
  return { id, snapshotEvents: () => events };
}

function turnStart(seq, time) {
  return { type: "turn/start", seq, time, data: { turn: "t1" } };
}

function turnEnd(seq, time, reasonKind) {
  return { type: "turn/end", seq, time, data: { turn: "t1", reason: { kind: reasonKind } } };
}

/** A plugin modul betöltése (a `?v=` a friss példányhoz kell, mert a `sentOnce` modul-szintű). */
function loadPlugin(tag) {
  return import(`${new URL("../lib/index.js", import.meta.url).href}?v=${tag}`);
}

/** Mock ctx: a `prompt` hívást naplózza. */
function fakeCtx(sessions, sent) {
  return {
    sessions: {
      list: () => sessions,
      prompt: async (request) => {
        sent.push(request);
        return { accepted: true };
      }
    }
  };
}

afterEach(() => {
  try { writeFileSync(MARKER_PATH, "{}", "utf8"); } catch { /* ignore */ }
});

test("megszakadt kör: folytatás elküldve", async () => {
  const plugin = await loadPlugin("interrupted");
  const now = Date.now();
  const sent = [];
  const sessions = [fakeSession("session-1", [turnStart(1, now - 1000), turnEnd(2, now - 500, "interrupted")])];
  plugin.apply(fakeCtx(sessions, sent));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  assert.equal(sent.length, 1, "egy folytatást küldött");
  assert.equal(sent[0].sessionId, "session-1");
  assert.match(sent[0].content[0].text, /Automatikus folytatás/u);
});

test("befejezett kör: nincs folytatás", async () => {
  const plugin = await loadPlugin("completed");
  const now = Date.now();
  const sent = [];
  const sessions = [fakeSession("session-2", [turnStart(1, now - 1000), turnEnd(2, now - 500, "completed")])];
  plugin.apply(fakeCtx(sessions, sent));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  assert.equal(sent.length, 0, "nem küld semmit");
});

test("nyitott turn (nyers crash-állapot): folytatás megkísérelve", async () => {
  const plugin = await loadPlugin("open");
  const now = Date.now();
  const sent = [];
  const sessions = [fakeSession("session-3", [turnStart(1, now - 1000)])];
  plugin.apply(fakeCtx(sessions, sent));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  // A crash-javítás nem fut le bootkor, ezért a nyitott kör a NYERS jel — a
  // promptot meg kell kísérelni; ha a kör éppen fut, az `agent-busy` véd.
  assert.equal(sent.length, 1, "a nyitott kört is folytatni próbálja");
});

test("jelölő: ugyanaz a kör nem küldődik kétszer", async () => {
  const now = Date.now();
  const sessions = [fakeSession("session-4", [turnStart(1, now - 1000), turnEnd(2, now - 500, "interrupted")])];
  const sent = [];
  const first = await loadPlugin("marker-1");
  first.apply(fakeCtx(sessions, sent));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  const afterFirst = sent.length;
  const second = await loadPlugin("marker-2");
  second.apply(fakeCtx(sessions, sent));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  assert.equal(afterFirst, 1, "az első futás küld");
  assert.equal(sent.length, 1, "a második futás nem küld újra");
});
