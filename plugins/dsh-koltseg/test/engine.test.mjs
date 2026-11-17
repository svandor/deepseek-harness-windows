/**
 * A költségelszámolás motorjának tesztjei — `node --test`, hálózat és valódi
 * naplók nélkül. A mérés szintetikus, de a VALÓDI sémát követő naplókon fut.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { measure, sessionList, samePath, turnIntervals, workspaceList } from "../lib/engine/calc.js";
import { canonicalWorkspace, defaultConfig, normalizeConfig, profileOf, resolveRate } from "../lib/engine/config.js";
import { appendActivity, humanTime, readActivity, typingEstimateMs } from "../lib/engine/human.js";
import { clip, sumMs, subtract, totalMs, union, unionWithSlack } from "../lib/engine/intervals.js";
import { appendLedger, ledgerCsv, readLedger, removeLedger } from "../lib/engine/ledger.js";
import { DEFAULT_PROFILE_ID, PRESET_PROFILES, billableTime, grossHuf, amountHuf, normalizeProfile, presetProfile } from "../lib/engine/profile.js";
import { decompressSessionLog, parseSessionText } from "../lib/engine/scan.js";
import { dayOf, dayStart, nextDayStart, today } from "../lib/engine/time.js";
import { deriveSession, promptCharacters } from "../lib/engine/turns.js";

const MINUTE = 60000;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ───────────────────────────────────────────────────────── intervallum-matematika

test("union összevonja az átfedő és érintkező intervallumokat", () => {
  const result = union([
    { start: 0, end: 10 },
    { start: 5, end: 15 },
    { start: 15, end: 20 },
    { start: 30, end: 40 },
    { start: 40, end: 40 },
  ]);
  assert.deepEqual(result, [{ start: 0, end: 20 }, { start: 30, end: 40 }]);
});

test("unionWithSlack áthidalja a rövid rést, a hosszút nem", () => {
  const merged = unionWithSlack([{ start: 0, end: 10 }, { start: 20, end: 30 }], 15);
  assert.equal(totalMs(merged), 30);
  const apart = unionWithSlack([{ start: 0, end: 10 }, { start: 40, end: 50 }], 15);
  assert.equal(totalMs(apart), 20);
});

test("sumMs átfedésben összead (erőforrás), totalMs unióz", () => {
  const intervals = [{ start: 0, end: 10 }, { start: 5, end: 15 }];
  assert.equal(sumMs(intervals), 20);
  assert.equal(totalMs(intervals), 15);
});

test("clip és subtract az ablakra vág, illetve lyukat vág", () => {
  assert.deepEqual(clip([{ start: 0, end: 100 }], 20, 50), [{ start: 20, end: 50 }]);
  assert.deepEqual(subtract([{ start: 0, end: 100 }], [{ start: 10, end: 20 }]), [
    { start: 0, end: 10 },
    { start: 20, end: 100 },
  ]);
});

// ───────────────────────────────────────────────────────────────── naptári idő

test("a naphatárok magyar idő szerintiek (nyári időszámítás előtt)", () => {
  // 2026-03-29 a nyári időszámítás kezdete Magyarországon: a nap 00:00-kor
  // még UTC+1, ezért 2026-03-28T23:00Z a nap kezdete, a vége pedig 23 óra múlva.
  const start = dayStart("2026-03-29");
  assert.equal(new Date(start).toISOString(), "2026-03-28T23:00:00.000Z");
  const end = nextDayStart(start);
  assert.equal(new Date(end).toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal((end - start) / 3600000, 23);
  assert.equal(dayOf(start), "2026-03-29");
});

test("a naphatárok a téli időszámítás végén is helyesek", () => {
  // 2026-10-25: a nap 25 órás, mert hajnalban visszaáll az óra.
  const start = dayStart("2026-10-25");
  const end = nextDayStart(start);
  assert.equal((end - start) / 3600000, 25);
  assert.equal(new Date(start).toISOString(), "2026-10-24T22:00:00.000Z");
});

test("érvénytelen dátumra null, a mai nap alakja helyes", () => {
  assert.equal(dayStart("2026-13-01"), null);
  assert.equal(dayStart("nem-datum"), null);
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/u);
});

// ──────────────────────────────────────────────────────────── napló és körök

/** Szintetikus napló a valódi eseménysémával. */
function sessionEvents(options) {
  const {
    id = "session-1",
    cwd = "D:\\Temp\\ws",
    createdAt = 1000,
    delegationDepth = 0,
    turns = [],
  } = options;
  // A napló időbélyegei a valóságban pozitívak; a fixtures 0-t is használhat.
  const events = [{
    type: "session",
    version: 3,
    id,
    createdAt,
    cwd,
    delegationDepth,
    agentPreset: "standard-free",
  }];
  let seq = 1;
  for (const turn of turns) {
    const start = turn.start;
    const end = turn.end;
    events.push({ type: "turn/start", seq: seq++, time: start, data: { turn: turn.turn } });
    // A beírt prompt: a valóságban ~30 ms-mal a `turn/start` UTÁN jön, és a
    // `source.kind === "user"` különbözteti meg a befecskendezett szövegektől.
    if (Number.isFinite(turn.promptChars) && turn.promptChars > 0) {
      events.push({
        type: "user/message",
        seq: seq++,
        time: start + 30,
        data: {
          role: "user",
          id: `msg-${seq}`,
          source: { kind: "user" },
          content: [{ type: "text", text: "x".repeat(turn.promptChars) }],
        },
      });
    }
    // Befecskendezett (NEM gépelt) szöveg: emlékeztető/alügynök-értesítő.
    if (Number.isFinite(turn.systemChars) && turn.systemChars > 0) {
      events.push({
        type: "user/message",
        seq: seq++,
        time: start + 40,
        data: {
          role: "user",
          id: `sys-${seq}`,
          source: { kind: "agent-instructions", form: "instructions" },
          content: [{ type: "text", text: "y".repeat(turn.systemChars) }],
        },
      });
    }
    events.push({ type: "step/start", seq: seq++, time: start + 1000, data: { turn: turn.turn, step: 1 } });
    if (end !== null && end !== undefined) {
      events.push({ type: "assistant/message", seq: seq++, time: end - 5000, data: { turn: turn.turn, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, reasoningTokens: 0 } } });
      events.push({ type: "step/end", seq: seq++, time: end - 1000, data: { turn: turn.turn, step: 1 } });
      events.push({ type: "turn/end", seq: seq++, time: end, data: { turn: turn.turn, reason: { kind: "completed" } } });
    }
  }
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function writeSession(root, workspaceTag, id, eventsText) {
  const dir = join(root, workspaceTag, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v3.jsonl"), eventsText, "utf8");
  return dir;
}

test("deriveSession kör-intervallumokat és számosságot ad", () => {
  const text = sessionEvents({
    turns: [
      { turn: 1, start: 0, end: 10 * MINUTE },
      { turn: 2, start: 15 * MINUTE, end: 20 * MINUTE },
      { turn: 3, start: 25 * MINUTE, end: null },
    ],
  });
  const parsed = parseSessionText(text);
  const record = deriveSession(parsed);
  assert.equal(record.id, "session-1");
  assert.equal(record.cwd, "D:\\Temp\\ws");
  assert.equal(record.turns.length, 3);
  assert.equal(record.turns[0].end - record.turns[0].start, 10 * MINUTE);
  assert.equal(record.turns[1].end - record.turns[1].start, 5 * MINUTE);
  assert.equal(record.turns[2].end, null);
  assert.equal(record.openTurns, 1);
  assert.equal(record.turns[0].steps, 1);
  assert.equal(record.turns[0].assistantMessages, 1);
});

test("a több frame-es zstd naplót teljesen kiolvassa (nem csak az első frame-et)", async () => {
  const frameOne = zstdCompressSync(Buffer.from('{"type":"session","id":"session-1","cwd":"D:\\\\ws","createdAt":1}\n', "utf8"));
  const frameTwo = zstdCompressSync(Buffer.from('{"type":"turn/start","time":1000,"seq":2,"data":{"turn":1}}\n', "utf8"));
  const buffer = Buffer.concat([frameOne, frameTwo]);
  const decoded = await decompressSessionLog(buffer);
  assert.equal(decoded.frames, 2);
  assert.match(decoded.text, /turn\/start/u);
  assert.match(decoded.text, /"type":"session"/u);
});

// ─────────────────────────────────────────────────────────────────── profilok

test("az alap profil a felhasználó döntése szerint gépidő + emberi idő, percre pontosan", () => {
  const profile = presetProfile(DEFAULT_PROFILE_ID);
  assert.equal(profile.weights.agent, 1);
  assert.equal(profile.weights.humanRead, 1);
  assert.equal(profile.weights.humanType, 1);
  assert.equal(profile.weights.jobs, 0);
  assert.equal(profile.weights.wall, 0);
  assert.equal(profile.roundToMinutes, 0);
  assert.equal(profile.minimumMinutes, 0);
  assert.equal(PRESET_PROFILES.length, 4);
});

test("billableTime: súlyozott összeg, gépidő-átszámítás, kerekítés, minimum", () => {
  const components = { agentMs: 60 * MINUTE, jobsMs: 60 * MINUTE, readMs: 30 * MINUTE, typeMs: 30 * MINUTE, wallMs: 240 * MINUTE };

  const alap = billableTime(components, presetProfile("alap"));
  assert.equal(alap.rawMs, 120 * MINUTE);
  assert.equal(alap.minutes, 120);

  const gepido = billableTime(components, presetProfile("gepido"));
  assert.equal(gepido.minutes, 75); // 60 agent + 0,25 * 60 háttér

  const brutto = billableTime(components, presetProfile("brutto"));
  assert.equal(brutto.minutes, 240);

  const fele = presetProfile("alap");
  fele.machineToHuman = 0.5;
  assert.equal(billableTime(components, fele).minutes, 90); // 30 + 30 + 30

  const kerekit = presetProfile("alap");
  kerekit.roundToMinutes = 15;
  assert.equal(billableTime({ agentMs: 10 * MINUTE }, kerekit).minutes, 15); // felfelé

  const minimum = presetProfile("alap");
  minimum.minimumMinutes = 30;
  assert.equal(billableTime({ agentMs: 4 * MINUTE }, minimum).minutes, 30);

  const semmi = billableTime({ agentMs: 0 }, presetProfile("alap"));
  assert.equal(semmi.minutes, 0); // üres mérésre nincs minimum
});

test("normalizeProfile a hibás súlyt a tartományra vágja és kimondja", () => {
  const { profile, errors } = normalizeProfile({ id: "x", weights: { agent: 99, jobs: -2 } });
  assert.equal(profile.weights.agent, 3);
  assert.equal(profile.weights.jobs, 0);
  assert.equal(profile.machineToHuman, 1);
  assert.equal(errors.length >= 2, true);
});

test("amountHuf és grossHuf (ÁFA) egész forintra számol", () => {
  assert.equal(amountHuf(0, 12500), 0);
  assert.equal(amountHuf(60 * MINUTE, 12500), 12500);
  assert.equal(amountHuf(30 * MINUTE, 12500), 6250);
  const gross = grossHuf(100000, 27);
  assert.deepEqual(gross, { net: 100000, vat: 27000, gross: 127000 });
  assert.deepEqual(grossHuf(100000, 0).gross, 100000);
});

// ──────────────────────────────────────────────────────────── konfiguráció

test("a gyári konfiguráció a megadott 12 500 Ft óradíjjal indul", () => {
  const config = defaultConfig();
  assert.equal(config.defaultRate, 12500);
  assert.equal(config.defaultProfile, DEFAULT_PROFILE_ID);
  assert.equal(config.vatPercent, 27);
  assert.equal(config.vatEnabled, false);
  assert.equal(config.materialCost, false);
});

test("a repó-szintű óradíj felülírja a globálist, a forrás kimondva", () => {
  const workspace = tempDir("koltseg-ws-");
  const { config } = normalizeConfig({
    defaultRate: 12500,
    workspaces: { [workspace]: { rate: 18000, profile: "gepido" } },
  });
  const resolved = resolveRate(config, workspace);
  assert.equal(resolved.rate, 18000);
  assert.equal(resolved.rateSource, "workspace");
  assert.equal(resolved.profileId, "gepido");
  assert.equal(resolved.profileSource, "workspace");

  const elsewhere = resolveRate(config, tempDir("koltseg-mas-"));
  assert.equal(elsewhere.rate, 12500);
  assert.equal(elsewhere.rateSource, "global");

  // A felületről választott profil erősebb a repó alapértelmezésénél.
  const override = resolveRate(config, workspace, "emberi");
  assert.equal(override.profileId, "emberi");
  assert.equal(override.profileSource, "request");
});

test("a kanonikus munkaterület-kulcs ugyanazt az útvonalat egy kulcs alá vonja", () => {
  const workspace = tempDir("koltseg-kanon-");
  const withSlash = `${workspace}\\`;
  assert.equal(canonicalWorkspace(withSlash), canonicalWorkspace(workspace));
  assert.equal(samePath(withSlash, workspace), true);
  assert.equal(samePath(workspace, join(workspace, "mas")), false);
  rmSync(workspace, { recursive: true, force: true });
});

test("ismeretlen profil nem kerül a konfigurációba", () => {
  const { config, errors } = normalizeConfig({ defaultProfile: "nincs-ilyen", workspaces: { "D:\\x": { profile: "nincs" } } });
  assert.equal(config.defaultProfile, DEFAULT_PROFILE_ID);
  assert.equal(errors.length >= 1, true);
  assert.equal(config.workspaces["D:\\x"], undefined);
});

test("az egyedi profil menthető, de az előre definiáltat nem írja felül", () => {
  const { config, errors } = normalizeConfig({
    profiles: [
      { id: "ugyfel-a", name: "Ügyfél A", weights: { agent: 0.4, humanRead: 1, humanType: 1 } },
      { id: "alap", name: "Hack", weights: { agent: 2 } },
    ],
  });
  assert.equal(config.profiles.length, 1);
  assert.equal(config.profiles[0].id, "ugyfel-a");
  assert.equal(config.profiles[0].weights.agent, 0.4);
  assert.equal(errors.some((message) => message.includes("alap")), true);
  assert.equal(profileOf(config, "ugyfel-a").name, "Ügyfél A");
});

// ──────────────────────────────────────────────────────────── emberi idő

test("kliens nélkül a napló-alapú tartalék számol, a tétlenség-plafon felett nem", () => {
  const base = Date.now() - 6 * 3600000;
  const text = sessionEvents({
    turns: [
      { turn: 1, start: base, end: base + 10 * MINUTE },
      { turn: 2, start: base + 20 * MINUTE, end: base + 30 * MINUTE },
      { turn: 3, start: base + 60 * MINUTE, end: base + 70 * MINUTE }, // 30 perces szünet
    ],
  });
  const record = deriveSession(parseSessionText(text));
  const window = { from: base - 3600000, to: base + 7 * 3600000 };
  const human = humanTime(record, undefined, presetProfile("alap"), window);
  assert.equal(human.source, "fallback");
  // 10 perces szünet beszámít; a 30 perces (a 15 perces plafon fölött) NEM.
  assert.equal(human.readMs, 10 * MINUTE);
  assert.equal(human.typeMs, 0);
  const away = human.items.find((item) => item.source === "away");
  assert.ok(away, "a hosszú szünet „távol”");
  assert.equal(away.turn, 2);
  assert.equal(away.readMs, 0);
});

test("kliens-adattal az olvasás és a gépelés szétválik, a rejtett idő kimarad", () => {
  const base = Date.now() - 6 * 3600000;
  const text = sessionEvents({
    turns: [
      { turn: 1, start: base, end: base + 10 * MINUTE },
      { turn: 2, start: base + 20 * MINUTE, end: base + 30 * MINUTE },
    ],
  });
  const record = deriveSession(parseSessionText(text));
  const activity = {
    keys: [{ start: base + 16 * MINUTE, end: base + 17 * MINUTE }],
    hidden: [],
    firstAt: base,
    lastAt: base + 30 * MINUTE,
    any: 4,
  };
  const window = { from: base - 3600000, to: base + 7 * 3600000 };
  const human = humanTime(record, activity, presetProfile("alap"), window);
  assert.equal(human.source, "client");
  assert.equal(human.readMs, 6 * MINUTE);
  assert.equal(human.typeMs, 4 * MINUTE);
});

test("ha van kliens-mérés, de a szünetben nincs aktivitás, az „távol” (nem becsülünk felülre)", () => {
  const base = Date.now() - 6 * 3600000;
  const text = sessionEvents({
    turns: [
      { turn: 1, start: base, end: base + 10 * MINUTE },
      { turn: 2, start: base + 40 * MINUTE, end: base + 50 * MINUTE },
    ],
  });
  const record = deriveSession(parseSessionText(text));
  const activity = { keys: [{ start: base + 50 * MINUTE, end: base + 51 * MINUTE }], hidden: [], firstAt: base, lastAt: base + 51 * MINUTE, any: 2 };
  const human = humanTime(record, activity, presetProfile("alap"), { from: base - 3600000, to: base + 7 * 3600000 });
  assert.equal(human.readMs, 0);
  assert.equal(human.typeMs, 0);
  assert.equal(human.items[0].source, "away");
});

// ────────────────────────────────────── gépelés a beírt szövegből (2026-11-17)

test("a beírt prompt hosszából visszamenőleg is becsül gépelést (kliens nélkül)", () => {
  const base = Date.now() - 6 * 3600000;
  const text = sessionEvents({
    turns: [
      { turn: 1, start: base, end: base + 10 * MINUTE, promptChars: 5000 },
      // 300 karakter a 150 leütés/perc tempóval = 2 perc gépelés
      { turn: 2, start: base + 20 * MINUTE, end: base + 30 * MINUTE, promptChars: 300 },
    ],
  });
  const record = deriveSession(parseSessionText(text));
  const window = { from: base - 3600000, to: base + 7 * 3600000 };
  const human = humanTime(record, undefined, presetProfile("alap"), window);
  assert.equal(human.source, "fallback");
  assert.equal(record.turns[1].promptChars, 300);
  // A szünetből 2 perc gépelés, 8 perc olvasás (nem duplázódik).
  assert.equal(human.readMs, 8 * MINUTE);
  // Ezen FELÜL az ELSŐ prompt beírása is számít: 5000 karakter = 33 perc, de a
  // tétlenség-plafon 15 percnél megállítja (2026-11-17, felhasználói kérés).
  assert.equal(human.firstPromptMs, 15 * MINUTE);
  assert.equal(human.typeMs, 17 * MINUTE);
  assert.equal(human.estimatedTypeMs, 17 * MINUTE);
  // A körönkénti bontásban a gépelés a BEÍRT PROMPT körénél van.
  const typingItems = human.items.filter((item) => item.typeMs > 0);
  assert.deepEqual(typingItems.map((item) => item.turn), [1, 2]);
  assert.equal(typingItems[0].firstPrompt, true);
  assert.equal(typingItems[1].estimated, true);
  // Az olvasás a VÁLASZ körénél marad.
  const readingItems = human.items.filter((item) => item.readMs > 0);
  assert.deepEqual(readingItems.map((item) => item.turn), [1]);
});

test("a befecskendezett szöveg (emlékeztető, alügynök) NEM gépelés", () => {
  const base = Date.now() - 6 * 3600000;
  const text = sessionEvents({
    turns: [
      { turn: 1, start: base, end: base + 10 * MINUTE },
      // 60 000 karakteres rendszer-emlékeztető: ha ezt számolnánk, 400 perc
      // gépelés jönne ki egy 10 perces szünetre.
      { turn: 2, start: base + 20 * MINUTE, end: base + 30 * MINUTE, systemChars: 60000 },
    ],
  });
  const record = deriveSession(parseSessionText(text));
  assert.equal(record.turns[1].promptChars, 0);
  const human = humanTime(record, undefined, presetProfile("alap"), { from: base - 3600000, to: base + 7 * 3600000 });
  assert.equal(human.typeMs, 0);
  assert.equal(human.readMs, 10 * MINUTE);
});

test("a becslés a szünetre és a tétlenség-plafonra is vágódik", () => {
  // 5 000 000 karakter 150 leütés/perc-cel 33 333 perc lenne — a szünet 10 perc.
  assert.equal(typingEstimateMs(300, 150, 10 * MINUTE), 2 * MINUTE);
  assert.equal(typingEstimateMs(5000000, 150, 10 * MINUTE), 10 * MINUTE);
  // Rövid prompt („ok”) alatt nincs becslés, a „folytasd” (8 karakter) már igen.
  assert.equal(typingEstimateMs(3, 150, 10 * MINUTE), 0);
  assert.ok(typingEstimateMs(8, 150, 10 * MINUTE) > 0);
  // Érvénytelen tempóra az alapérték lép.
  assert.equal(typingEstimateMs(300, 0, 10 * MINUTE), 2 * MINUTE);

  const base = Date.now() - 6 * 3600000;
  const text = sessionEvents({
    turns: [
      { turn: 1, start: base, end: base + 10 * MINUTE, promptChars: 10 },
      { turn: 2, start: base + 20 * MINUTE, end: base + 30 * MINUTE, promptChars: 5000000 },
    ],
  });
  const record = deriveSession(parseSessionText(text));
  const human = humanTime(record, undefined, presetProfile("alap"), { from: base - 3600000, to: base + 7 * 3600000 });
  // A profil plafonja 15 perc, a szünet 10: a becslés 10 percnél áll meg.
  assert.equal(human.typeMs, 10 * MINUTE);
  assert.equal(human.readMs, 0);
});

test("a beírt szöveg gépelést ad akkor is, ha a kliens szerint a felhasználó „távol” volt", () => {
  const base = Date.now() - 6 * 3600000;
  const text = sessionEvents({
    turns: [
      { turn: 1, start: base, end: base + 10 * MINUTE },
      { turn: 2, start: base + 40 * MINUTE, end: base + 50 * MINUTE, promptChars: 600 },
    ],
  });
  const record = deriveSession(parseSessionText(text));
  // Aktivitás-mérés van (a kliens élt), de ebben a szünetben nincs jelzés.
  const activity = { keys: [{ start: base + 50 * MINUTE, end: base + 51 * MINUTE }], hidden: [], firstAt: base, lastAt: base + 51 * MINUTE, any: 2 };
  const human = humanTime(record, activity, presetProfile("alap"), { from: base - 3600000, to: base + 7 * 3600000 });
  assert.equal(human.readMs, 0);
  assert.equal(human.typeMs, 4 * MINUTE); // 600 / 150 = 4 perc
  assert.equal(human.items[0].source, "away");
  // A gépelés a beírt prompt körénél jelenik meg, becsült jelöléssel.
  const typing = human.items.find((item) => item.typeMs > 0);
  assert.ok(typing, "van gépelés-tétel");
  assert.equal(typing.turn, 2);
  assert.equal(typing.estimated, true);
});

test("a promptCharacters csak a felhasználói szöveget számolja", () => {
  assert.equal(promptCharacters({ source: { kind: "user" }, content: [{ type: "text", text: "abcde" }] }), 5);
  assert.equal(promptCharacters({ content: [{ type: "text", text: "abcde" }] }), 5); // forrás nélkül: felhasználói
  assert.equal(promptCharacters({ source: { kind: "agent-instructions" }, content: [{ type: "text", text: "abcde" }] }), 0);
  assert.equal(promptCharacters({ source: { kind: "plugin", plugin: "x" }, content: [{ type: "text", text: "abcde" }] }), 0);
  // Nem szöveg-blokk nem számít (kép, csatolmány).
  assert.equal(promptCharacters({ source: { kind: "user" }, content: [{ type: "image", url: "x" }] }), 0);
  assert.equal(promptCharacters(null), 0);
});
test("az aktivitás-napló írható és visszaolvasható, a hibás vödör kimarad", () => {
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const result = appendActivity(stateDir, [
    { at: Date.now() - 1000, to: Date.now() - 500, kind: "key", session: "session-a", workspace },
    { at: Date.now() - 1000, kind: "ismeretlen", session: "session-a" },
    { at: "nem-szam", kind: "key", session: "session-a" },
  ], workspace);
  assert.equal(result.written, 1);
  assert.equal(result.dropped, 2);
  const read = readActivity(stateDir, 0);
  assert.equal(read.total, 1);
  assert.equal(read.bySession.get("session-a").keys.length, 1);
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────── végpontok nélkül: mérés

test("session-hatókör: agent + emberi idő, uniózott aktív idő, Ft", async () => {
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const now = Date.now();
  const start = now - 3 * 3600000;
  writeSession(root, "ws", "session-abc", sessionEvents({
    id: "session-abc",
    cwd: workspace,
    createdAt: start,
    turns: [
      { turn: 1, start, end: start + 10 * MINUTE },
      { turn: 2, start: start + 20 * MINUTE, end: start + 30 * MINUTE },
      { turn: 3, start: start + 40 * MINUTE, end: start + 50 * MINUTE },
    ],
  }));

  const result = await measure({
    scope: "session",
    sessionId: "session-abc",
    workspace,
    from: start - 3600000,
    to: now,
    config: defaultConfig(),
    stateDir,
    root,
  });

  assert.equal(result.ok, true);
  assert.equal(result.components.agentMs, 30 * MINUTE);
  assert.equal(result.components.readMs, 20 * MINUTE); // két 10 perces szünet
  assert.equal(result.components.typeMs, 0);
  assert.equal(result.components.wallMs, 50 * MINUTE); // unió, 10 perces résekkel
  assert.equal(result.minutes, 50);
  assert.equal(result.amount.net, Math.round((50 / 60) * 12500)); // 10417
  assert.equal(result.rate, 12500);
  assert.equal(result.rateSource, "global");
  assert.equal(result.turns.length, 3);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.notes.length > 0, true);

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("session-hatókör: a körönkénti tábla a gépelést a beírt prompt körénél mutatja", async () => {
  // MÉRT HIBA (2026-11-17): a gépelés a VÁLASZ körénél jelent meg (mint az
  // olvasás), ezért a felhasználó nem látta, hogy a saját promptjai beírása
  // benne van-e egyáltalán. Most az olvasás a válaszhoz, a gépelés a beírt
  // prompthoz tartozik, és az első prompt is számít.
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const now = Date.now();
  const start = now - 3 * 3600000;
  writeSession(root, "ws", "session-abc", sessionEvents({
    id: "session-abc",
    cwd: workspace,
    createdAt: start,
    turns: [
      // 450 karakter = 3 perc gépelés (150 leütés/perc)
      { turn: 1, start, end: start + 10 * MINUTE, promptChars: 450 },
      { turn: 2, start: start + 20 * MINUTE, end: start + 30 * MINUTE, promptChars: 300 },
    ],
  }));

  const result = await measure({
    scope: "session",
    sessionId: "session-abc",
    workspace,
    from: start - 3600000,
    to: now,
    config: defaultConfig(),
    stateDir,
    root,
  });

  assert.equal(result.components.typeEstimatedMs, result.components.typeMs, "minden gépelés becsült (nincs kliens-adat)");
  assert.equal(result.components.typeMs, 3 * MINUTE + 2 * MINUTE, "első prompt 3 perc + második prompt 2 perc");
  assert.equal(result.components.readMs, 8 * MINUTE, "a 10 perces szünet mínusz a 2 perc gépelés");
  // 1. kör: a saját promptjának beírása (első promptként, a napló előttről).
  assert.equal(result.turns[0].turn, 1);
  assert.equal(result.turns[0].typeMs, 3 * MINUTE);
  assert.equal(result.turns[0].estimated, true);
  // 2. kör: a 2. prompt beírása.
  assert.equal(result.turns[1].typeMs, 2 * MINUTE);
  // Az olvasás az 1. körnél van (a válasz elolvasása).
  assert.equal(result.turns[0].readMs, 8 * MINUTE);

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});
test("a delegált (alügynök) session nem duplázza az agent-időt", async () => {
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const now = Date.now();
  const start = now - 2 * 3600000;
  writeSession(root, "ws", "session-parent", sessionEvents({
    id: "session-parent",
    cwd: workspace,
    turns: [{ turn: 1, start, end: start + 10 * MINUTE }],
  }));
  writeSession(root, "ws", "session-child", sessionEvents({
    id: "session-child",
    cwd: workspace,
    delegationDepth: 1,
    turns: [{ turn: 1, start: start + 2 * MINUTE, end: start + 6 * MINUTE }],
  }));

  const result = await measure({
    scope: "workspace",
    workspace,
    from: start - 3600000,
    to: now,
    config: defaultConfig(),
    stateDir,
    root,
  });

  assert.equal(result.components.agentMs, 10 * MINUTE);
  assert.equal(result.delegated.sessions, 1);
  assert.equal(result.delegated.agentMs, 4 * MINUTE);
  assert.equal(result.sessions.length, 1); // csak a root session a listában

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("két párhuzamos session: az agent összeadódik, az aktív idő uniózódik", async () => {
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const now = Date.now();
  const start = now - 2 * 3600000;
  writeSession(root, "ws", "session-a", sessionEvents({
    id: "session-a", cwd: workspace, turns: [{ turn: 1, start, end: start + 20 * MINUTE }],
  }));
  writeSession(root, "ws", "session-b", sessionEvents({
    id: "session-b", cwd: workspace, turns: [{ turn: 1, start, end: start + 20 * MINUTE }],
  }));

  const result = await measure({
    scope: "workspace",
    workspace,
    from: start - 3600000,
    to: now,
    config: defaultConfig(),
    stateDir,
    root,
  });

  assert.equal(result.components.agentMs, 40 * MINUTE); // két gép-munka
  assert.equal(result.components.wallMs, 20 * MINUTE);  // egy naptári óra
  assert.equal(result.sessions.length, 2);

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("a másik munkaterület session-jei nem számítanak bele", async () => {
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const other = tempDir("koltseg-mas-");
  const now = Date.now();
  const start = now - 2 * 3600000;
  writeSession(root, "ws", "session-a", sessionEvents({
    id: "session-a", cwd: workspace, turns: [{ turn: 1, start, end: start + 10 * MINUTE }],
  }));
  writeSession(root, "mas", "session-b", sessionEvents({
    id: "session-b", cwd: other, turns: [{ turn: 1, start, end: start + 30 * MINUTE }],
  }));

  const result = await measure({
    scope: "workspace", workspace, from: start - 3600000, to: now,
    config: defaultConfig(), stateDir, root,
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.components.agentMs, 10 * MINUTE);

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test("a nyitott kört az utolsó naplózott eseménnyel zárja le (nem fújja fel a mostani időre)", async () => {
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const now = Date.now();
  const start = now - 30 * MINUTE;
  writeSession(root, "ws", "session-open", sessionEvents({
    id: "session-open", cwd: workspace, turns: [{ turn: 1, start, end: null }],
  }));

  const result = await measure({
    scope: "session", sessionId: "session-open", workspace, from: now - 3600000, to: now,
    config: defaultConfig(), stateDir, root,
  });
  assert.equal(result.sessions[0].openTurns, 1);
  // A fixture utolsó eseménye a kör kezdete + 1 s: NEM a 30 perces „mostani idő”.
  assert.equal(result.components.agentMs, 1000);
  assert.equal(result.notes.some((note) => note.includes("nyitott kör")), true);

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("dátum-intervallum: a kör csak a saját napjába számít, a magyar naphatárral", async () => {
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  // 2026-03-01 10:00 magyar idő = 09:00 UTC; a nap kezdete 2026-02-28T23:00Z.
  const start = dayStart("2026-03-01") + 10 * 3600000;
  writeSession(root, "ws", "session-day", sessionEvents({
    id: "session-day", cwd: workspace, turns: [{ turn: 1, start, end: start + 15 * MINUTE }],
  }));

  const inside = await measure({
    scope: "workspace", workspace, from: dayStart("2026-03-01"), to: nextDayStart(dayStart("2026-03-01")),
    config: defaultConfig(), stateDir, root, now: start + 3600000,
  });
  assert.equal(inside.components.agentMs, 15 * MINUTE);

  const outside = await measure({
    scope: "workspace", workspace, from: dayStart("2026-03-02"), to: nextDayStart(dayStart("2026-03-02")),
    config: defaultConfig(), stateDir, root, now: start + 48 * 3600000,
  });
  assert.equal(outside.components.agentMs, 0);

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("a választó listák a munkaterületre szűrnek", async () => {
  const root = tempDir("koltseg-root-");
  const workspace = tempDir("koltseg-ws-");
  const other = tempDir("koltseg-mas-");
  const now = Date.now();
  writeSession(root, "ws", "session-a", sessionEvents({
    id: "session-a", cwd: workspace, turns: [{ turn: 1, start: now - 3600000, end: now - 3500000 }],
  }));
  writeSession(root, "mas", "session-b", sessionEvents({
    id: "session-b", cwd: other, turns: [{ turn: 1, start: now - 3600000, end: now - 3500000 }],
  }));

  const sessions = await sessionList({ workspace, root });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "session-a");

  const workspaces = await workspaceList(root);
  assert.equal(workspaces.length >= 2, true);

  rmSync(root, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────── ledger

test("a rögzített elszámolás megmarad, listázható, törölhető és CSV-be megy", () => {
  const stateDir = tempDir("koltseg-ledger-");
  const saved = appendLedger(stateDir, {
    scope: "workspace",
    workspace: "D:\\Temp\\ws",
    workspaceLabel: "ws",
    fromDay: "2026-11-01",
    toDay: "2026-11-16",
    profileId: "alap",
    profileName: "Általános",
    rate: 12500,
    minutes: 47,
    net: 587500,
    vat: 158625,
    gross: 746125,
    vatPercent: 27,
    sessions: 12,
    turns: 351,
  });
  assert.equal(saved.ok, true);

  const list = readLedger(stateDir);
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].net, 587500);
  assert.equal(list.entries[0].minutes, 47);

  const csv = ledgerCsv(list.entries);
  assert.match(csv, /netto;afa;brutto/u);
  assert.match(csv, /587500/u);

  const removed = removeLedger(stateDir, list.entries[0].id);
  assert.equal(removed.ok, true);
  assert.equal(readLedger(stateDir).entries.length, 0);

  const invalid = appendLedger(stateDir, { workspace: "D:\\x", minutes: -1, rate: 12500 });
  assert.equal(invalid.ok, false);

  rmSync(stateDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────── kerekítés a mérésben

test("a profil kerekítése a végösszegen érvényesül (15 perces felfelé)", async () => {
  const root = tempDir("koltseg-root-");
  const stateDir = tempDir("koltseg-state-");
  const workspace = tempDir("koltseg-ws-");
  const now = Date.now();
  const start = now - 2 * 3600000;
  writeSession(root, "ws", "session-r", sessionEvents({
    id: "session-r", cwd: workspace, turns: [{ turn: 1, start, end: start + 7 * MINUTE }],
  }));

  const base = await measure({
    scope: "workspace", workspace, from: start - 3600000, to: now,
    config: defaultConfig(), stateDir, root,
  });
  assert.equal(base.minutes, 7); // percre pontos

  const { config } = normalizeConfig({
    defaultProfile: "kerekito",
    profiles: [{ id: "kerekito", name: "Kerekítő", roundToMinutes: 15, minimumMinutes: 60 }],
  });
  const rounded = await measure({
    scope: "workspace", workspace, from: start - 3600000, to: now,
    config, stateDir, root,
  });
  assert.equal(rounded.minutes, 60); // 15 percre felfelé -> 15, de a minimum 60
  assert.equal(rounded.amount.net, 12500); // 1 óra

  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});
