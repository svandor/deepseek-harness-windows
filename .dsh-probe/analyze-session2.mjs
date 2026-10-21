// Relate step latency to input tokens and reasoning volume in a decoded DSH session log.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean);
const entries = [];
for (const l of lines) { try { entries.push(JSON.parse(l)); } catch {} }

const starts = new Map(), ends = new Map(), asst = new Map();
const key = (e) => `${e.data?.turn ?? '?'}/${e.data?.step ?? '?'}`;
for (const e of entries) {
  const k = key(e);
  if (e.type === 'step/start') starts.set(k, e.time);
  if (e.type === 'step/end') ends.set(k, e.time);
  if (e.type === 'assistant/message') asst.set(k, e);
}

const rows = [];
for (const [k, a] of asst) {
  const s = starts.get(k);
  const content = a.data?.message?.content ?? [];
  const r = content.filter((c) => c.type === 'reasoning').map((c) => c.text).join('');
  rows.push({
    k, t: a.time, ms: s ? a.time - s : null,
    inTok: a.data?.usage?.inputTokens ?? null,
    outTok: a.data?.usage?.outputTokens ?? null,
    reasonChars: r.length,
  });
}
rows.sort((x, y) => x.t - y.t);

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
const sum = (a) => a.reduce((x, y) => x + y, 0);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

console.log(`steps=${rows.length} inTok: min=${Math.min(...rows.map(r => r.inTok ?? 0))} median=${pct(rows.map(r => r.inTok ?? 0), 50)} p90=${pct(rows.map(r => r.inTok ?? 0), 90)} max=${Math.max(...rows.map(r => r.inTok ?? 0))}`);
console.log(`sum input tokens billed = ${sum(rows.map(r => r.inTok ?? 0)).toLocaleString()}`);
console.log(`median latency=${fmt(pct(rows.map(r => r.ms ?? 0), 50))}  sum=${fmt(sum(rows.map(r => r.ms ?? 0)))}`);

const buckets = [[0, 20000], [20000, 50000], [50000, 100000], [100000, 200000], [200000, 1000000000]];
console.log('\nlatency by input-token bucket:');
for (const [lo, hi] of buckets) {
  const sel = rows.filter((r) => r.inTok != null && r.inTok >= lo && r.inTok < hi);
  if (!sel.length) continue;
  const ms = sel.map((r) => r.ms ?? 0);
  console.log(`  ${String(lo).padStart(7)}-${String(hi === 1e9 ? 'inf' : hi).padEnd(9)} n=${String(sel.length).padStart(3)}  median=${fmt(pct(ms, 50)).padStart(7)}  mean=${fmt(sum(ms) / ms.length).padStart(7)}  p90=${fmt(pct(ms, 90)).padStart(7)}`);
}

// correlation latency ~ input tokens
const xs = rows.filter((r) => r.inTok != null && r.ms != null);
const mx = sum(xs.map((r) => r.inTok)) / xs.length, my = sum(xs.map((r) => r.ms)) / xs.length;
let num = 0, dx = 0, dy = 0;
for (const r of xs) { num += (r.inTok - mx) * (r.ms - my); dx += (r.inTok - mx) ** 2; dy += (r.ms - my) ** 2; }
console.log(`\ncorr(inputTokens, latency) = ${(num / Math.sqrt(dx * dy)).toFixed(3)}`);

// first 5 steps of each turn with latency + input
console.log('\nfirst steps of each turn:');
const seen = new Set();
for (const r of rows) { const t = r.k.split('/')[0]; if (seen.has(t)) continue; seen.add(t); console.log(`  ${r.k.padEnd(6)} in=${String(r.inTok).padStart(7)} lat=${fmt(r.ms ?? 0).padStart(7)} reasonChars=${r.reasonChars}`); }

// total output tokens & reasoning share
const outTok = sum(rows.map((r) => r.outTok ?? 0));
const reasonTokEst = Math.round(sum(rows.map((r) => r.reasonChars)) / 4);
console.log(`\ntotal outputTokens=${outTok.toLocaleString()}  est. reasoning tokens (chars/4)=${reasonTokEst.toLocaleString()} (${(100 * reasonTokEst / Math.max(1, outTok)).toFixed(0)}%)`);

// steps with no reasoning but long latency
const noRe = rows.filter((r) => r.reasonChars === 0 && (r.ms ?? 0) > 8000);
console.log(`steps >8s with ZERO reasoning: ${noRe.length} (sum ${fmt(sum(noRe.map(r => r.ms)))}), median input=${pct(noRe.map(r => r.inTok ?? 0), 50)}`);
