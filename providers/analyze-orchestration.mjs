// ORCHESTRACIO-ELEMZES: a valos session-naplokbol meri, mi lenne a
// "pro orchestrator + flash gyermekek" politika hatasa a MOSTANI forgalmon.
//
// Meria: keresek/tokenek/koltseg modellekent, main vs delegalalt bontasban,
// cache-aranyt, lepes/turn es tool/lepes mutatokat, majd kiszamolja ugyanezt
// PRO aron a main route-ra (es fizetos flash aron a gyermekekre).
//
// Futtatas: node providers/analyze-orchestration.mjs [nap]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const DAYS = Number(process.argv[2] ?? 30);
const ROOT = join(homedir(), ".dsh", "sessions");
const SINCE = Date.now() - DAYS * 24 * 3600 * 1000;

// A host artablaja (USD / 1M token). off/peak a DeepSeek-nel valik el.
const P = {
  "deepseek-flash": { missOff: 0.15, missPeak: 0.3, hitOff: 0.003, hitPeak: 0.006, outOff: 0.6, outPeak: 1.2 },
  "deepseek-v4-pro": { missOff: 0.66, missPeak: 1.32, hitOff: 0.022, hitPeak: 0.044, outOff: 1.98, outPeak: 3.96 },
  "alibaba-intl/qwen3.8-flash": { missOff: 0.15, missPeak: 0.15, hitOff: 0.015, hitPeak: 0.015, outOff: 0.47, outPeak: 0.47 },
  "alibaba/qwen3.8-flash": { missOff: 0.113, missPeak: 0.113, hitOff: 0.0113, hitPeak: 0.0113, outOff: 0.382, outPeak: 0.382 },
  free: { missOff: 0, missPeak: 0, hitOff: 0, hitPeak: 0, outOff: 0, outPeak: 0 }
};
const FREE = P.free;

function priceOf(model) {
  const m = String(model ?? "").toLowerCase();
  for (const key of Object.keys(P)) if (key !== "free" && m.includes(key)) return P[key];
  if (/worker|nemotron|gpt-oss|qwen3\.8-27b|gemini|gemma|kimi|llama|mistral/.test(m)) return FREE;
  return P["deepseek-flash"]; // ismeretlen -> flash (ahogy a host)
}
function isPeak(time) {
  const d = new Date(time);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
function costOf(usage, model, time) {
  const p = priceOf(model);
  const peak = isPeak(time);
  const miss = usage.inputTokens || 0;
  const hit = usage.cacheReadTokens || 0;
  const out = usage.outputTokens || 0;
  return (miss * (peak ? p.missPeak : p.missOff) + hit * (peak ? p.hitPeak : p.hitOff) + out * (peak ? p.outPeak : p.outOff)) / 1e6;
}

async function frame(b) {
  return new Promise((res) => {
    const s = createZstdDecompress(); const c = [];
    s.on("data", (x) => c.push(x));
    s.on("end", () => res({ text: Buffer.concat(c).toString("utf8"), consumed: s.bytesWritten }));
    s.on("error", () => res({ text: "", consumed: b.length }));
    s.end(b);
  });
}
async function readLog(path) {
  const buf = readFileSync(path);
  let off = 0; let out = "";
  while (off < buf.length) {
    const f = await frame(buf.subarray(off));
    if (f.consumed <= 0) break;
    off += f.consumed; out += f.text;
  }
  return out;
}
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".jsonl.zstd") && statSync(p).size > 0) acc.push(p);
  }
  return acc;
}

const agg = {
  main: { requests: 0, miss: 0, hit: 0, out: 0, costUsd: 0, steps: 0, turns: 0, tools: 0 },
  deleg: { requests: 0, miss: 0, hit: 0, out: 0, costUsd: 0, steps: 0, turns: 0, tools: 0, sessions: 0, mainSessions: 0 }
};
const perModel = new Map();
for (const file of walk(ROOT)) {
  let text;
  try { text = await readLog(file); } catch { continue; }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) continue;
  let header = null;
  try { header = JSON.parse(lines[0]); } catch {}
  const depth = typeof header?.delegationDepth === "number" ? header.delegationDepth : 0;
  const isDeleg = depth > 0 || header?.origin === "subagent";
  const box = isDeleg ? agg.deleg : agg.main;
  if (isDeleg) agg.deleg.sessions += 1; else agg.deleg.mainSessions += 1;
  for (const line of lines) {
    if (line.indexOf('"assistant/message"') === -1 && line.indexOf('"step/start"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.time === "number" && e.time < SINCE) continue;
    if (e.type === "step/start") { box.steps += 1; continue; }
    if (e.type === "tool/call") { box.tools += 1; continue; }
    if (e.type !== "assistant/message") continue;
    const d = e.data ?? {};
    const u = d.usage;
    if (!u) continue;
    const src = d.message?.source ?? d.source ?? {};
    const model = typeof src.model === "string" ? src.model : "";
    const provider = typeof src.provider === "string" ? src.provider : "";
    const label = provider ? `${provider}/${model}` : model;
    const cost = costOf(u, label, e.time);
    box.requests += 1;
    box.miss += u.inputTokens || 0;
    box.hit += u.cacheReadTokens || 0;
    box.out += u.outputTokens || 0;
    box.costUsd += cost;
    const m = perModel.get(label) ?? { model: label, requests: 0, miss: 0, hit: 0, out: 0, costUsd: 0, deleg: isDeleg };
    m.requests += 1; m.miss += u.inputTokens || 0; m.hit += u.cacheReadTokens || 0; m.out += u.outputTokens || 0; m.costUsd += cost;
    perModel.set(label, m);
  }
}
// A turn-szam a turn/start esemenyekbol (kulon korben, hogy egyszer szamoljuk)
for (const file of walk(ROOT)) {
  let text; try { text = await readLog(file); } catch { continue; }
  const lines = text.split("\n").filter(Boolean);
  let header = null; try { header = JSON.parse(lines[0]); } catch {}
  const isDeleg = (header?.delegationDepth ?? 0) > 0 || header?.origin === "subagent";
  for (const line of lines) {
    if (line.indexOf('"turn/start"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.time === "number" && e.time < SINCE) continue;
    (isDeleg ? agg.deleg : agg.main).turns += 1;
  }
}

const fmt = (n) => n.toLocaleString("hu-HU");
const usd = (n) => "$" + n.toFixed(4);
const line = (b) => `keres=${fmt(b.requests)} miss=${fmt(b.miss)} hit=${fmt(b.hit)} out=${fmt(b.out)} | cache-arany=${b.miss + b.hit > 0 ? ((b.hit / (b.miss + b.hit)) * 100).toFixed(1) : "0.0"}% | koltseg=${usd(b.costUsd)} | lepes=${fmt(b.steps)} tool=${fmt(b.tools)} turn=${fmt(b.turns)}`;

console.log(`=== FORGALOM (utolso ${DAYS} nap, ${agg.deleg.sessions} gyermek + ${agg.deleg.mainSessions} fo session) ===`);
console.log(`FO (main):      ${line(agg.main)}`);
console.log(`GYERMEK (deleg):${line(agg.deleg)}`);
const totalCost = agg.main.costUsd + agg.deleg.costUsd;
console.log(`OSSZESEN: ${usd(totalCost)}  | main reszesedes: ${((agg.main.costUsd / (totalCost || 1)) * 100).toFixed(1)}%`);
console.log(`Atlagos keresenkenti koltseg: ${usd(totalCost / Math.max(1, agg.main.requests + agg.deleg.requests))}`);
console.log(`Atlagos main-keres contextusa (miss+hit): ${fmt(Math.round((agg.main.miss + agg.main.hit) / Math.max(1, agg.main.requests)))} token`);
console.log(`Atlagos gyermek-keres contextusa:         ${fmt(Math.round((agg.deleg.miss + agg.deleg.hit) / Math.max(1, agg.deleg.requests)))} token`);
console.log(`Lepes/turn: main ${(agg.main.steps / Math.max(1, agg.main.turns)).toFixed(1)}, gyermek ${(agg.deleg.steps / Math.max(1, agg.deleg.turns)).toFixed(1)}`);

console.log("\n=== MODELLENKENT (koltseg szerint) ===");
for (const m of [...perModel.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 12)) {
  console.log(`  ${(m.deleg ? "  " : "F ")}${m.model.padEnd(46)} ${usd(m.costUsd).padStart(10)}  keres=${fmt(m.requests).padStart(6)}  in=${fmt(m.miss + m.hit).padStart(12)} out=${fmt(m.out).padStart(9)}`);
}

// ── Forgatokonyvek a MAIN route-ra ────────────────────────────────────────
const pro = P["deepseek-v4-pro"];
const flash = P["deepseek-flash"];
const mainTokens = { miss: agg.main.miss, hit: agg.main.hit, out: agg.main.out };
const costAt = (p, t) => (t.miss * p.missOff + t.hit * p.hitOff + t.out * p.outOff) / 1e6;
const mainFlashOff = costAt(flash, mainTokens);
const mainProOff = costAt(pro, mainTokens);
const mainSg = costAt(P["alibaba-intl/qwen3.8-flash"], mainTokens);
const delegPaid = costAt(P["alibaba-intl/qwen3.8-flash"], { miss: agg.deleg.miss, hit: agg.deleg.hit, out: agg.deleg.out });

console.log("\n=== FORGATOKONYVEK (a MAIN tokenvolumen ujraarazva; a gyermekek a mostani ingyenes lancon) ===");
console.log(`  main flash (mostani, völgyar):   ${usd(mainFlashOff)}`);
console.log(`  main v4-pro (völgyar):           ${usd(mainProOff)}   (${(mainProOff / (mainFlashOff || 1)).toFixed(2)}x)`);
console.log(`  main qwen3.8-flash EU (lapos):   ${usd(mainSg)}   (${(mainSg / (mainFlashOff || 1)).toFixed(2)}x)`);
console.log(`  Ugyanez CSÚCSÁRON (main flash vs pro): ${usd(costAt(flash, mainTokens) * 2)} -> ${usd(costAt(pro, mainTokens) * 2)}`);
console.log(`\n  Ha a gyermekek NEM ingyenesek, hanem fizetos flash (qwen3.8-flash SG tarifa): +${usd(delegPaid)}`);
console.log(`  (A gyermekek jelenlegi ingyenes lancon mert koltsege: ${usd(agg.deleg.costUsd)})`);

// ── Milyen lepesszam-csokkenes kell a pro-hoz, hogy megérje? ──────────────
const ratio = mainProOff / (mainFlashOff || 1);
console.log("\n=== MENNYI LEPEST KELL MEGSPOROLNIA A PRO-NAK, HOGY KIFIZESSE MAGAT? ===");
console.log(`  A pro/flash ar (main tokenvolumen, völgyar): ${ratio.toFixed(2)}x`);
console.log(`  Ez akkor jar nullas egyenleggel, ha a pro ugyanazt a munkat ${(100 - (1 / ratio) * 100).toFixed(1)}%-kal kevesebb main-tokenbol elvegzi (kevesebb lepes/kisebb context).`);
console.log(`  Jelenlegi atlagos lepesszam/fordulo a main route-on: ${(agg.main.steps / Math.max(1, agg.main.turns)).toFixed(1)}`);
