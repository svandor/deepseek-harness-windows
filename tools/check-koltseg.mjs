#!/usr/bin/env node
/**
 * check-koltseg.mjs — a költségelszámolás motorjának ellenőrzése VALÓDI naplókon.
 *
 * Miért kell külön eszköz: a motor két olyan dologra épül, amit csak a valós
 * adaton lehet hitelesen ellenőrizni:
 *
 *   1. a session-naplók TÖBB frame-es zstd streamek (egy frame = egy append) —
 *      egy naiv olvasó csak a fejlécet látná, és „nincs adat”-ot mondana;
 *   2. a kör-intervallumok a `turn/start` és `turn/end` eseményekből jönnek,
 *      a `time` mező pedig epoch ms — a számok helyességét a valós deployment
 *      naplóján kell látni, nem szintetikus adaton.
 *
 * Amit kiír: a saját munkaterület utolsó 30 napjának mérése (agent / olvasás /
 * gépelés / aktív idő), valamint a tiszta függvények invariánsai.
 *
 * FUTTATÁS:
 *   node tools/check-koltseg.mjs                 # ez a munkaterület, 30 nap
 *   node tools/check-koltseg.mjs --days 7
 *   node tools/check-koltseg.mjs --workspace "D:\Szerver\Masik"
 *   node tools/check-koltseg.mjs --json           # gép által olvasható
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measure, workspaceList } from "../plugins/dsh-koltseg/lib/engine/calc.js";
import { defaultConfig, normalizeConfig, profileOf, resolveRate } from "../plugins/dsh-koltseg/lib/engine/config.js";
import { billableTime, presetProfile } from "../plugins/dsh-koltseg/lib/engine/profile.js";
import { decompressSessionLog, parseSessionText, sessionLogFiles, sessionsRoot } from "../plugins/dsh-koltseg/lib/engine/scan.js";
import { dayStart, daysAgoStart, nextDayStart } from "../plugins/dsh-koltseg/lib/engine/time.js";
import { deriveSession } from "../plugins/dsh-koltseg/lib/engine/turns.js";
import { scanUsage } from "../plugins/dsh-ui-extras/lib/index.js";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const stateDir = join(repoRoot, "state");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const json = process.argv.includes("--json");
const days = Number.parseInt(arg("days", "30"), 10) || 30;
const workspace = arg("workspace", repoRoot);

let failures = 0;
function fail(message) {
  failures += 1;
  if (!json) console.error("  FAIL " + message);
}
function ok(message) {
  if (!json) console.log("  ok   " + message);
}

// ── 1) a napló-olvasó a valós fájlokon ─────────────────────────────────────
const root = sessionsRoot();
const files = sessionLogFiles(root);
if (!json) {
  console.log(`naplók : ${files.length} fájl a ${root} alatt`);
}
if (files.length === 0) fail("nincs session-napló — a mérés nem ellenőrizhető");
else ok("van session-napló");

const newest = files.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
if (newest !== undefined) {
  // A legfrissebb napló lehet egy FUTÓ session (nyitott körrel) — olyanon nincs
  // lezárt kör, ezért a legfrissebb 5 fájl közül az elsőt használjuk, amiben van.
  let checkedRecord = null;
  let checkedFrames = 0;
  let checkedEvents = 0;
  for (const candidate of files.slice(0, 5)) {
    const raw = readFileSync(candidate.file);
    const decoded = await decompressSessionLog(raw);
    const parsed = parseSessionText(decoded.text);
    const record = parsed.header === null ? null : deriveSession(parsed);
    if (record === null) continue;
    checkedFrames = decoded.frames;
    checkedEvents = parsed.events.length;
    checkedRecord = record;
    if (record.turns.some((turn) => turn.end !== null)) break;
  }
  if (checkedFrames === 0) fail("a legfrissebb naplók nem olvashatók frame-ekre");
  else if (checkedFrames > 1) ok(`több frame-es napló olvasva (${checkedFrames} frame, ${checkedEvents} esemény)`);
  else ok(`egy frame-es napló olvasva (${checkedEvents} esemény)`);
  if (checkedRecord === null) fail("a legfrissebb naplókból nem lett session-rekord");
  else if (checkedRecord.turns.length === 0) fail("a legfrissebb naplókban nincs kör");
  else {
    const closed = checkedRecord.turns.filter((turn) => turn.end !== null);
    const total = closed.reduce((sum, turn) => sum + (turn.end - turn.start), 0);
    if (closed.length === 0) ok("csak nyitott kör van a legfrissebb naplóban (futó session)");
    else if (total <= 0) fail("a lezárt körök ideje 0 (rossz időbélyeg-értelmezés?)");
    else ok(`kör-idő számolható (${closed.length} lezárt kör, ${(total / 60000).toFixed(1)} perc)`);
  }
}

// ── 2) magyar naphatárok (DST) ────────────────────────────────────────────
const dstStart = dayStart("2026-03-29");
const dstEnd = nextDayStart(dstStart);
if (dstStart === null || (dstEnd - dstStart) !== 23 * 3600000) fail("a nyári időszámítás napja nem 23 óra");
else ok("nyári időszámítás napja 23 óra");
const autumn = dayStart("2026-10-25");
if (autumn === null || (nextDayStart(autumn) - autumn) !== 25 * 3600000) fail("a téli időszámítás napja nem 25 óra");
else ok("téli időszámítás napja 25 óra");

// ── 3) profil-matematika ──────────────────────────────────────────────────
const components = { agentMs: 3600000, jobsMs: 0, readMs: 1800000, typeMs: 1800000, wallMs: 4 * 3600000 };
const alap = billableTime(components, presetProfile("alap"));
if (alap.minutes !== 120) fail(`az alap profil 120 percet kell adjon, adott ${alap.minutes}`);
else ok("alap profil: 1 óra agent + 1 óra emberi = 120 perc");
const gepido = billableTime(components, presetProfile("gepido"));
if (gepido.minutes !== 60) fail(`a gépidő profil 60 percet kell adjon, adott ${gepido.minutes}`);
else ok("gépidő profil: 60 perc (emberi idő nélkül)");

const custom = normalizeConfig({ defaultProfile: "ugyfel", profiles: [{ id: "ugyfel", name: "Ügyfél", weights: { agent: 0.5, humanRead: 1, humanType: 1 } }] });
if (profileOf(custom.config, "ugyfel").weights.agent !== 0.5) fail("az egyedi profil nem töltődött be");
else ok("egyedi (súlyozott) profil betölthető");

const rateCheck = resolveRate(normalizeConfig({ defaultRate: 12500, workspaces: { [workspace]: { rate: 20000 } } }).config, workspace);
if (rateCheck.rate !== 20000 || rateCheck.rateSource !== "workspace") fail("a repó-szintű óradíj nem érvényesül");
else ok("repó-szintű óradíj felülírja a globálist");

// ── 4) a valódi mérés (ez a lényeg) ───────────────────────────────────────
const now = Date.now();
const from = daysAgoStart(days, now);
const config = defaultConfig();
const result = await measure({ scope: "workspace", workspace, from, to: now, config, stateDir });

if (!result.ok) fail("a mérés nem adott eredményt");
else {
  const hours = (ms) => (ms / 3600000).toFixed(2) + " h";
  if (!json) {
    console.log("");
    console.log(`mérés  : ${workspace}`);
    console.log(`időszak: ${result.fromDay} — ${result.toDay} (${days} nap)`);
    console.log(`session: ${result.sessions.length} munkafolyamat, ${result.sessions.reduce((sum, s) => sum + s.turns, 0)} kör`);
    console.log(`  agent (szerver oldali munka) : ${hours(result.components.agentMs)}`);
    console.log(`  olvasás (emberi)             : ${hours(result.components.readMs)}`);
    console.log(`  gépelés (emberi)             : ${hours(result.components.typeMs)}`);
    console.log(`    ebből szövegből becsült    : ${hours(result.components.typeEstimatedMs || 0)}`);
    console.log(`  háttérmunka                  : ${hours(result.components.jobsMs)}`);
    console.log(`  valós aktív idő (unió)       : ${hours(result.components.wallMs)}`);
    console.log(`  elszámolható                 : ${result.minutes.toFixed(1)} perc`);
    console.log(`  óradíj                       : ${result.rate} Ft/óra (${result.rateSource})`);
    console.log(`  összeg                       : ${result.amount.net.toLocaleString("hu-HU")} Ft`);
    console.log(`  humán idő forrása            : ${result.humanSource}`);
  }
  if (result.components.agentMs <= 0) fail("az agent-idő 0 — a naplókból nem jött idő");
  else ok(`agent-idő: ${hours(result.components.agentMs)}`);
  if (result.components.wallMs > 0 && result.components.wallMs < result.components.agentMs) {
    fail("az aktív idő kisebb az agent-időnél (az unió hibás — a körök benne kell legyenek)");
  } else if (result.components.wallMs > 0) {
    ok(`aktív idő (${hours(result.components.wallMs)}) tartalmazza az agent-időt`);
  }
  if (result.humanSource === "none" && result.sessions.length > 0) {
    fail("van session, de nincs emberi idő (a kör-párosítás hibás)");
  } else ok(`humán idő forrása: ${result.humanSource}`);
  if (result.amount.net < 0) fail("negatív összeg");
  if (result.vatPercent === 0) ok("ÁFA alapból kikapcsolva (a felhasználó döntése)");

  const workspaces = await workspaceList();
  if (!json) console.log(`munkaterületek a naplókban: ${workspaces.length}`);
  if (!workspaces.some((entry) => entry.path.toLowerCase() === workspace.toLowerCase())) {
    fail("a saját munkaterület nem szerepel a naplókból készült listában");
  } else ok("a munkaterület megtalálható a listában");

  // ── 4b) gépelés a beírt szövegből (2026-11-17) ─────────────────────────
  const typed = Number.isFinite(result.components.typeEstimatedMs) ? result.components.typeEstimatedMs : null;
  if (typed === null) fail("a válaszból hiányzik a typeEstimatedMs (a becslés nem futott)");
  else if (typed > 0) ok(`gépelés-becslés a beírt szövegből: ${hours(typed)}`);
  else ok("gépelés-becslés: nincs becsülhető szöveg ebben az időszakban");
  if (typed !== null && typed > 0 && result.components.typeMs + 1 < typed) {
    fail("a becsült gépelés nagyobb, mint a teljes gépelés komponens");
  }

  // ── 4c) a token-sor munkaterület-szűrése és a cache-kedvezmény ─────────
  // MÉRT HIBA (2026-11-17): a panel a TELJES deployment 30 napos költségét
  // mutatta (2 session-höz $133.76 a $0.62 helyett). Itt ellenőrizzük, hogy a
  // szűrt szám kisebb a globálisnál, és hogy a cache-kedvezmény ki van mondva.
  const scoped = await scanUsage(days, null, workspace);
  const global = await scanUsage(days, null, "");
  if (scoped.totals.costUsd > global.totals.costUsd + 1e-9) {
    fail("a munkaterület-szűrt token-költség nagyobb a globálisnál");
  } else {
    ok(`token-költség a munkaterületre: $${scoped.totals.costUsd.toFixed(4)} (globális: $${global.totals.costUsd.toFixed(4)})`);
  }
  // A panel a FIZETENDŐ (bruttó) árat mutatja: 27% magyar áfa, a DeepSeeknél
  // +6% DSH-pótdíj (×1,3462), Alibaba/OpenRouter ×1,27. A nettó érték a
  // számla-egyeztetéshez marad (lásd AGENTS 2026-11-20-i bejegyzés).
  const grossRates = scoped.pricing && scoped.pricing.gross ? scoped.pricing.gross.rates : null;
  if (grossRates === null) {
    fail("a válaszból hiányzik a pricing.gross blokk (a felület nem tudná kimondani a szorzókat)");
  } else if (scoped.totals.netCostUsd > 0
    && scoped.totals.costUsd >= scoped.totals.netCostUsd * 1.27 - 1e-9
    && scoped.totals.costUsd <= scoped.totals.netCostUsd * 1.3462 + 1e-9) {
    ok(`a token-sor BRUTTÓ: nettó $${scoped.totals.netCostUsd.toFixed(4)} -> bruttó $${scoped.totals.costUsd.toFixed(4)} (DSH ×${grossRates.dsh}, Alibaba/OpenRouter ×${grossRates.alibaba})`);
  } else {
    fail(`a bruttó költség $${scoped.totals.costUsd} nem a nettó $${scoped.totals.netCostUsd} 1,27–1,3462-szerese`);
  }
  if (scoped.cache.hitTokens > 0 && scoped.cache.discountPercent < 50) {
    fail(`a cache-kedvezmény nem érvényesül (${scoped.cache.discountPercent}%)`);
  } else if (scoped.cache.hitTokens > 0) {
    ok(`cache-kedvezmény érvényesül: ${scoped.cache.discountPercent}% (megtakarítás $${scoped.cache.savedUsd.toFixed(4)})`);
  }
  if (!json) {
    console.log(`  token: ${scoped.totals.requests} kérés, cache-találat ${(scoped.cache.hitTokens / 1e6).toFixed(1)} M token`);
  }
}

// ── összegzés ─────────────────────────────────────────────────────────────
if (json) {
  console.log(JSON.stringify({ failures, result }, null, 2));
  process.exit(failures === 0 ? 0 : 1);
}
console.log("");
if (failures === 0) {
  console.log("EREDMÉNY: rendben");
  process.exit(0);
}
console.log(`EREDMÉNY: ${failures} hiba`);
process.exit(1);
