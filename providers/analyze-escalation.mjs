// ESZKALACIO-ELEMZES: mennyibe kerul a "porgo" (thrashing) munka, es mikor
// eri meg a flash -> pro ESZKALACIO?
//
// Meria sessiononkent: lepesek, koltseg, ismetlodo (ugyanaz a tool+argumentum)
// hivasok aranya, hibaet tartalmazó tool-eredmenyek aranya, majd kiszamolja:
//  - a thrashing sessionok reszesedeset a koltsegbol,
//  - a pro-eszkalacio BELÉPESI koltseget (a context cache-vesztese miatt
//    cache-MISS aron szamolva!) es a tovabbi lepesek arat,
//  - a fedezeti pontot: hany elrontott flash-lepes utan olcsobb a pro.
//
// Futtatas: node providers/analyze-escalation.mjs [nap]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const DAYS = Number(process.argv[2] ?? 30);
const ROOT = join(homedir(), ".dsh", "sessions");
const SINCE = Date.now() - DAYS * 24 * 3600 * 1000;

const FLASH = { missOff: 0.15, missPeak: 0.3, hitOff: 0.003, hitPeak: 0.006, outOff: 0.6, outPeak: 1.2 };
const PRO = { missOff: 0.66, missPeak: 1.32, hitOff: 0.022, hitPeak: 0.044, outOff: 1.98, outPeak: 3.96 };
function isPeak(t) {
  const d = new Date(t); const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
function cost(usage, p, t) {
  const peak = isPeak(t);
  return ((usage.inputTokens || 0) * (peak ? p.missPeak : p.missOff)
    + (usage.cacheReadTokens || 0) * (peak ? p.hitPeak : p.hitOff)
    + (usage.outputTokens || 0) * (peak ? p.outPeak : p.outOff)) / 1e6;
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
  const buf = readFileSync(path); let off = 0; let out = "";
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
const ERROR_RE = /error|failed|failure|exception|traceback|exit code [1-9]|not found|nem találhat|hiba|elutasít|denied|timeout|timed out/i;

const sessions = [];
for (const file of walk(ROOT)) {
  let text; try { text = await readLog(file); } catch { continue; }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) continue;
  let header = null; try { header = JSON.parse(lines[0]); } catch {}
  const isDeleg = (header?.delegationDepth ?? 0) > 0 || header?.origin === "subagent";
  if (isDeleg) continue;                       // csak a FO sessionok erdekesek
  const s = {
    id: header?.id ?? file, steps: 0, turns: 0, requests: 0, costUsd: 0,
    miss: 0, hit: 0, out: 0, calls: 0, repeats: 0, results: 0, errorResults: 0,
    firstAt: null, lastAt: null, ctxSamples: []
  };
  const seen = new Map();
  for (const line of lines) {
    if (line.indexOf('"assistant/message"') === -1 && line.indexOf('"tool/') === -1 && line.indexOf('"step/start"') === -1 && line.indexOf('"turn/start"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.time === "number" && e.time < SINCE) continue;
    if (typeof e.time === "number") { if (s.firstAt === null) s.firstAt = e.time; s.lastAt = e.time; }
    if (e.type === "step/start") { s.steps += 1; continue; }
    if (e.type === "turn/start") { s.turns += 1; continue; }
    if (e.type === "tool/call") {
      s.calls += 1;
      const key = `${e.data?.name ?? "?"}|${String(e.data?.arguments ?? "").slice(0, 400)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) s.repeats += 1;
      continue;
    }
    if (e.type === "tool/result") {
      s.results += 1;
      const blob = JSON.stringify(e.data ?? {}).slice(0, 4000);
      if (ERROR_RE.test(blob)) s.errorResults += 1;
      continue;
    }
    if (e.type === "assistant/message") {
      const u = e.data?.usage; if (!u) continue;
      s.requests += 1;
      s.costUsd += cost(u, FLASH, e.time ?? s.lastAt ?? Date.now());
      s.miss += u.inputTokens || 0; s.hit += u.cacheReadTokens || 0; s.out += u.outputTokens || 0;
      s.ctxSamples.push((u.inputTokens || 0) + (u.cacheReadTokens || 0));
    }
  }
  if (s.requests > 0) sessions.push(s);
}

const totalCost = sessions.reduce((a, s) => a + s.costUsd, 0);
const totalSteps = sessions.reduce((a, s) => a + s.steps, 0);
const thrash = sessions.filter((s) => s.steps >= 80 || (s.calls >= 10 && s.repeats / Math.max(1, s.calls) >= 0.15) || (s.results >= 10 && s.errorResults / Math.max(1, s.results) >= 0.25));
const thrashCost = thrash.reduce((a, s) => a + s.costUsd, 0);
const clean = sessions.filter((s) => !thrash.includes(s));
const med = (arr) => { if (arr.length === 0) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const avgCtx = med(sessions.flatMap((s) => s.ctxSamples.length ? [s.ctxSamples[s.ctxSamples.length - 1]] : []));
const usd = (n) => "$" + n.toFixed(4);

console.log(`=== FO SESSIONOK (utolso ${DAYS} nap) ===`);
console.log(`  sessionok: ${sessions.length} | lepes: ${totalSteps.toLocaleString("hu-HU")} | koltseg: ${usd(totalCost)}`);
console.log(`  atlagos koltseg/session: ${usd(totalCost / Math.max(1, sessions.length))} | lepes/session: ${(totalSteps / Math.max(1, sessions.length)).toFixed(1)}`);
console.log(`  tipikus (median) session-vegi kontextus: ${avgCtx.toLocaleString("hu-HU")} token`);

console.log(`\n=== PORGO (thrashing) SESSIONOK ===`);
console.log(`  definicio: >=80 lepes VAGY >=15% ismetlodo tool-hivas VAGY >=25% hibaet tartalmazo tool-eredmeny`);
console.log(`  erintett session: ${thrash.length} / ${sessions.length} (${((thrash.length / Math.max(1, sessions.length)) * 100).toFixed(1)}%)`);
console.log(`  ezek koltsege: ${usd(thrashCost)} — az osszes ${((thrashCost / Math.max(1e-9, totalCost)) * 100).toFixed(1)}%-a`);
console.log(`  atlag: porgo ${usd(thrashCost / Math.max(1, thrash.length))} vs tiszta ${usd((totalCost - thrashCost) / Math.max(1, clean.length))}`);

console.log(`\n=== A LEGDAGABB 8 SESSION (koltseg szerint) ===`);
for (const s of [...sessions].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8)) {
  const rep = s.calls > 0 ? (s.repeats / s.calls) * 100 : 0;
  const err = s.results > 0 ? (s.errorResults / s.results) * 100 : 0;
  console.log(`  ${usd(s.costUsd).padStart(9)} | lepes=${String(s.steps).padStart(4)} | hivas=${String(s.calls).padStart(4)} ismetles=${rep.toFixed(0).padStart(3)}% | eredmeny=${String(s.results).padStart(4)} hiba=${err.toFixed(0).padStart(3)}%`);
}

// ── Az eszkalacio ara ─────────────────────────────────────────────────────
const estCtx = avgCtx || 300000;
const flashStepHit = (estCtx * FLASH.hitOff) / 1e6;
const flashStepPeak = (estCtx * FLASH.hitPeak) / 1e6;
const proEntryMiss = (estCtx * PRO.missOff) / 1e6;      // modellvaltas -> cache-vesztes
const proStepHit = (estCtx * PRO.hitOff) / 1e6;
const proStepPeak = (estCtx * PRO.hitPeak) / 1e6;
const briefCost = (30000 * PRO.missOff) / 1e6;          // 30K tokenes tomor brief, friss context

console.log(`\n=== ESZKALACIO ARA (${estCtx.toLocaleString("hu-HU")} tokenes kontextuson) ===`);
console.log(`  flash lepes (cache-talalat, volgy):  ${usd(flashStepHit)}   csucson: ${usd(flashStepPeak)}`);
console.log(`  pro BELÉPÉS (cache-vesztes, miss):   ${usd(proEntryMiss)}   <-- a modellvaltas a cache-t is elviszi`);
console.log(`  pro tovabbi lepes (cache-talalat):   ${usd(proStepHit)}   csucson: ${usd(proStepPeak)}`);
console.log(`  pro TOMOR BRIEF-fel (30K, friss):    ${usd(briefCost)}   <-- a "feladatot eszkalaljuk, nem a beszelgetest"`);
console.log(`\n  Fedezeti pont (a teljes kontextus atvitele eseten): ${Math.ceil(proEntryMiss / Math.max(1e-9, flashStepHit))} elrontott flash-lepes`);
console.log(`  Fedezeti pont (tomor brief eseten):                ${Math.ceil(briefCost / Math.max(1e-9, flashStepHit))} elrontott flash-lepes`);
console.log(`\n  Ha a porgo sessionok felet egy korai eszkalacio megsporolja: varhato nyereseg ~${usd(thrashCost / 2)} (30 nap)`);
