// MODELLVALASZTAS-ELEMZES: ugyanazokra a VALOS keresekre mennyibe kerulnenek
// a kulonbozo modellek (DeepSeek kozvetlen vs Alibaba EU/SG, Qwen + DeepSeek),
// es mennyit hoz egy MERET-FUGGO politikа (kis keres -> olcso Qwen,
// nagy/cache-elt -> DeepSeek).
//
// Arforrasok [D 2026-10-13]: alibabacloud.com model-pricing (Global = EU,
// International = Szingapur) + a repo DeepSeek listaarai. Cache-talalat:
// DeepSeek = az input 2%-a, Alibaba = 10%.
//
// Futtatas: node providers/analyze-model-choice.mjs [nap]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const DAYS = Number(process.argv[2] ?? 30);
const ROOT = join(homedir(), ".dsh", "sessions");
const SINCE = Date.now() - DAYS * 24 * 3600 * 1000;
const K = 1000;

function isPeak(t) {
  const d = new Date(t); const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
// tiers: [{ upTo, in, out }] — az egesz keres arra a savra szamolodik, amelybe esik
const MODELS = {
  "deepseek-flash (kozvetlen)": { hit: 0.02, tiers: [{ upTo: Infinity, busyIn: 0.3, idleIn: 0.15, busyOut: 1.2, idleOut: 0.6 }] },
  "deepseek-v4.1-flash (Ali EU)": { hit: 0.1, tiers: [{ upTo: Infinity, busyIn: 0.283, idleIn: 0.141, busyOut: 1.131, idleOut: 0.565 }] },
  "deepseek-v4.1-flash (Ali SG)": { hit: 0.1, tiers: [{ upTo: Infinity, busyIn: 0.3, idleIn: 0.15, busyOut: 1.2, idleOut: 0.6 }] },
  "qwen3.7-flash (Ali EU)": { hit: 0.1, tiers: [{ upTo: 32 * K, busyIn: 0.028, idleIn: 0.028, busyOut: 0.11, idleOut: 0.11 }, { upTo: 256 * K, busyIn: 0.083, idleIn: 0.083, busyOut: 0.33, idleOut: 0.33 }, { upTo: Infinity, busyIn: 0.165, idleIn: 0.165, busyOut: 0.66, idleOut: 0.66 }] },
  "qwen3.7-flash (Ali SG)": { hit: 0.1, tiers: [{ upTo: 32 * K, busyIn: 0.03, idleIn: 0.03, busyOut: 0.13, idleOut: 0.13 }, { upTo: 256 * K, busyIn: 0.1, idleIn: 0.1, busyOut: 0.4, idleOut: 0.4 }, { upTo: Infinity, busyIn: 0.2, idleIn: 0.2, busyOut: 0.8, idleOut: 0.8 }] },
  "qwen3.5-flash (Ali EU)": { hit: 0.1, tiers: [{ upTo: 128 * K, busyIn: 0.029, idleIn: 0.029, busyOut: 0.287, idleOut: 0.287 }, { upTo: 256 * K, busyIn: 0.115, idleIn: 0.115, busyOut: 1.147, idleOut: 1.147 }, { upTo: Infinity, busyIn: 0.172, idleIn: 0.172, busyOut: 1.72, idleOut: 1.72 }] },
  "qwen3.8-flash (Ali EU)": { hit: 0.1, tiers: [{ upTo: Infinity, busyIn: 0.113, idleIn: 0.113, busyOut: 0.382, idleOut: 0.382 }] },
  "qwen3.8-flash (Ali SG)": { hit: 0.1, tiers: [{ upTo: Infinity, busyIn: 0.15, idleIn: 0.15, busyOut: 0.47, idleOut: 0.47 }] },
  "deepseek-v4-pro (kozvetlen)": { hit: 0.02, tiers: [{ upTo: Infinity, busyIn: 1.32, idleIn: 0.66, busyOut: 3.96, idleOut: 1.98 }] },
  "deepseek-v4-pro-0813 (Ali EU)": { hit: 0.1, tiers: [{ upTo: Infinity, busyIn: 1.272, idleIn: 0.636, busyOut: 3.816, idleOut: 1.908 }] },
};

function costOf(m, miss, hit, out, time) {
  const peak = isPeak(time);
  const size = miss + hit;
  const tier = m.tiers.find((t) => size <= t.upTo) ?? m.tiers[m.tiers.length - 1];
  const inRate = peak ? tier.busyIn : tier.idleIn;
  const outRate = peak ? tier.busyOut : tier.idleOut;
  return (miss * inRate + hit * inRate * m.hit + out * outRate) / 1e6;
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
async function readLog(p) {
  const buf = readFileSync(p); let off = 0; let out = "";
  while (off < buf.length) { const f = await frame(buf.subarray(off)); if (f.consumed <= 0) break; off += f.consumed; out += f.text; }
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

// Csak a FO sessionok (a gyermekek mas kerdes), es csak a main route keresek.
const reqs = [];
for (const file of walk(ROOT)) {
  let text; try { text = await readLog(file); } catch { continue; }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) continue;
  let header = null; try { header = JSON.parse(lines[0]); } catch {}
  if ((header?.delegationDepth ?? 0) > 0 || header?.origin === "subagent") continue;
  for (const line of lines) {
    if (line.indexOf('"assistant/message"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.time !== "number" || e.time < SINCE) continue;
    const u = e.data?.usage; if (!u) continue;
    const src = e.data?.message?.source ?? e.data?.source ?? {};
    const provider = String(src.provider ?? "");
    if (provider && provider !== "deepseek-official") continue;   // a main route keresoi
    reqs.push({ miss: u.inputTokens || 0, hit: u.cacheReadTokens || 0, out: u.outputTokens || 0, time: e.time });
  }
}

const names = Object.keys(MODELS);
const totals = Object.fromEntries(names.map((n) => [n, 0]));
const perReq = [];
for (const r of reqs) {
  const row = {};
  for (const n of names) { const c = costOf(MODELS[n], r.miss, r.hit, r.out, r.time); totals[n] += c; row[n] = c; }
  perReq.push({ ...r, row });
}
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const usd = (n) => "$" + n.toFixed(2);
const base = totals["deepseek-flash (kozvetlen)"];

console.log(`=== FO ROUTE KERESEK (${DAYS} nap, ${reqs.length.toLocaleString("hu-HU")} keres) ===`);
console.log(`  osszes token: miss ${sum(reqs.map(r=>r.miss)).toLocaleString("hu-HU")} / cache ${sum(reqs.map(r=>r.hit)).toLocaleString("hu-HU")} / out ${sum(reqs.map(r=>r.out)).toLocaleString("hu-HU")}`);
const sizes = reqs.map((r) => r.miss + r.hit).sort((a, b) => a - b);
const pct = (p) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];
console.log(`  keresmeret: median ${pct(0.5).toLocaleString("hu-HU")} | 25% ${pct(0.25).toLocaleString("hu-HU")} | 75% ${pct(0.75).toLocaleString("hu-HU")} | 95% ${pct(0.95).toLocaleString("hu-HU")}`);
console.log(`  arany: <=32K ${((sizes.filter(s=>s<=32*K).length/sizes.length)*100).toFixed(1)}% | <=128K ${((sizes.filter(s=>s<=128*K).length/sizes.length)*100).toFixed(1)}% | >256K ${((sizes.filter(s=>s>256*K).length/sizes.length)*100).toFixed(1)}%`);

console.log(`\n=== UGYANEZEK A KERESEK MAS MODELLEKEN ===`);
for (const n of names.sort((a, b) => totals[a] - totals[b])) {
  const t = totals[n];
  console.log(`  ${n.padEnd(32)} ${usd(t).padStart(10)}   ${(t / base).toFixed(2)}x a deepseek-flash-hoz`);
}

// Meret-fuggo politika: kis keres -> qwen3.7-flash (EU), egyebkent deepseek-flash
console.log(`\n=== MERET-FUggO POLITIKA (auto modell) ===`);
for (const limit of [8 * K, 16 * K, 32 * K, 64 * K, 128 * K]) {
  let c = 0, small = 0;
  for (const r of perReq) {
    const size = r.miss + r.hit;
    if (size <= limit) { c += r.row["qwen3.7-flash (Ali EU)"]; small += 1; }
    else c += r.row["deepseek-flash (kozvetlen)"];
  }
  console.log(`  <${(limit / K)}K -> qwen3.7-flash, egyebkent deepseek-flash: ${usd(c)} (a keresek ${((small / perReq.length) * 100).toFixed(1)}%-a megy Qwenre) -> megtakaritas ${usd(base - c)} (${(((base - c) / base) * 100).toFixed(1)}%)`);
}
// Teljes also korlat: keresenkenti optimum
let best = 0;
for (const r of perReq) best += Math.min(...Object.values(r.row));
console.log(`  Elmeleti also korlat (keresenkenti legjobb valasztas): ${usd(best)} -> megtakaritas ${usd(base - best)} (${(((base - best) / base) * 100).toFixed(1)}%)`);
