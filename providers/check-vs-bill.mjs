// SZAMLA-ELLENORZES: mit szamol a modell az Alibaba-szamlaval szemben?
// A DSH session-naplokbol osszegzi az Alibaba-koltseget (EU + Szingapur) egy
// adott naptari honapra — ez hasonlithato a Model Studio konzol szamlajahoz.
//
// FONTOS korlat: a naplok csak a DSH-n ATMENT kereseket latjak. A kozvetlen
// (DSH-n kivuli) API-probak — pl. a merő szkriptek — NEM szerepelnek benne,
// tehat a konzol szamlaja ennyivel tobb lehet.
//
// Futtatas: node providers/check-vs-bill.mjs [YYYY-MM]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"));
const MONTH = process.argv[2] ?? new Date().toISOString().slice(0, 7);

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
function cost(label, miss, hit, out) {
  const table = CONFIG.pricing ?? {};
  const meta = table[label] ?? table["deepseek/deepseek-flash"];
  const size = miss + hit;
  const tier = Array.isArray(meta?.tiers) ? (meta.tiers.find((t) => size <= t.upTo) ?? meta.tiers[meta.tiers.length - 1]) : meta;
  const mr = tier?.miss ?? 0, hr = tier?.hit ?? mr * 0.1, or = tier?.out ?? 0;
  return (miss * mr + hit * hr + out * or) / 1e6;
}

const per = new Map();
let requests = 0;
for (const file of walk(join(homedir(), ".dsh", "sessions"))) {
  let text; try { text = await readLog(file); } catch { continue; }
  for (const line of text.split("\n")) {
    if (line.indexOf('"assistant/message"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.time !== "number") continue;
    if (new Date(e.time).toISOString().slice(0, 7) !== MONTH) continue;
    const u = e.data?.usage; if (!u) continue;
    const src = e.data?.message?.source ?? e.data?.source ?? {};
    const label = src.provider ? `${src.provider}/${src.model}` : String(src.model ?? "");
    if (!/^alibaba(-intl)?\//.test(label)) continue;
    const c = cost(label, u.inputTokens || 0, u.cacheReadTokens || 0, u.outputTokens || 0);
    const b = per.get(label) ?? { label, requests: 0, miss: 0, hit: 0, out: 0, costUsd: 0 };
    b.requests += 1; b.miss += u.inputTokens || 0; b.hit += u.cacheReadTokens || 0; b.out += u.outputTokens || 0; b.costUsd += c;
    per.set(label, b);
    requests += 1;
  }
}
const total = [...per.values()].reduce((a, b) => a + b.costUsd, 0);
const usd = (n) => "$" + n.toFixed(4);
console.log(`=== ALIBABA-KOLTSEG A NAPLOKBOL — ${MONTH} ===`);
for (const b of [...per.values()].sort((x, y) => y.costUsd - x.costUsd)) {
  console.log(`  ${b.label.padEnd(32)} ${usd(b.costUsd).padStart(10)}  keres=${String(b.requests).padStart(5)}  in=${(b.miss + b.hit).toLocaleString("hu-HU").padStart(12)} out=${b.out.toLocaleString("hu-HU").padStart(8)}`);
}
console.log(`  ${"OSSZESEN (DSH-naplobol)".padEnd(32)} ${usd(total).padStart(10)}  keres=${String(requests).padStart(5)}`);
console.log("\nA konzol szamlaja ennel tobb lehet: a DSH-n KIVULI (kozvetlen) API-hivasok nincsenek a naplokban.");
