import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean);
const entries = [];
for (const l of lines) { try { entries.push(JSON.parse(l)); } catch {} }
const starts = new Map(), asst = new Map();
const key = (e) => `${e.data?.turn ?? '?'}/${e.data?.step ?? '?'}`;
for (const e of entries) {
  const k = key(e);
  if (e.type === 'step/start') starts.set(k, e.time);
  if (e.type === 'assistant/message') asst.set(k, e);
}
const rows = [];
for (const [k, a] of asst) {
  const s = starts.get(k);
  const c = a.data?.message?.content ?? [];
  const r = c.filter((x) => x.type === 'reasoning').map((x) => x.text).join('');
  rows.push({ k, ms: s ? a.time - s : null, inTok: a.data?.usage?.inputTokens ?? 0, outTok: a.data?.usage?.outputTokens ?? 0, rc: r.length, tc: c.filter((x) => x.type === 'text').map((x) => x.text).join('').length });
}
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
const sum = (a) => a.reduce((x, y) => x + y, 0);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const corr = (f, g) => { const xs = rows; const mx = sum(xs.map(f)) / xs.length, my = sum(xs.map(g)) / xs.length; let n = 0, a = 0, b = 0; for (const r of xs) { n += (f(r) - mx) * (g(r) - my); a += (f(r) - mx) ** 2; b += (g(r) - my) ** 2; } return n / Math.sqrt(a * b); };

console.log(`corr(ms, reasoningChars)=${corr((r) => r.ms ?? 0, (r) => r.rc).toFixed(3)}  corr(ms, outTok)=${corr((r) => r.ms ?? 0, (r) => r.outTok).toFixed(3)}  corr(ms, inTok)=${corr((r) => r.ms ?? 0, (r) => r.inTok).toFixed(3)}`);

const bands = [[0, 100], [100, 500], [500, 2000], [2000, 8000], [8000, 1e9]];
console.log('\nlatency by reasoning volume (chars):');
for (const [lo, hi] of bands) {
  const sel = rows.filter((r) => r.rc >= lo && r.rc < hi);
  if (!sel.length) continue;
  const ms = sel.map((r) => r.ms ?? 0);
  const out = sel.map((r) => r.outTok);
  console.log(`  reason ${String(lo).padStart(5)}-${String(hi === 1e9 ? 'inf' : hi).padEnd(5)} n=${String(sel.length).padStart(3)}  median=${fmt(pct(ms, 50)).padStart(7)}  mean=${fmt(sum(ms) / ms.length).padStart(7)}  median outTok=${pct(out, 50)}  median inTok=${pct(sel.map(r => r.inTok), 50)}`);
}

const lowThink = rows.filter((r) => r.rc < 100);
console.log(`\nsteps with <100 reasoning chars: n=${lowThink.length} median latency=${fmt(pct(lowThink.map(r => r.ms ?? 0), 50))} (this is the fixed per-step overhead)`);
const lowIn = rows.filter((r) => r.inTok < 3000 && r.rc < 100);
console.log(`steps with <3000 in and <100 reason: n=${lowIn.length} median latency=${fmt(pct(lowIn.map(r => r.ms ?? 0), 50))}`);

const tokensPerSec = rows.filter((r) => r.outTok > 200 && r.ms > 2000).map((r) => (r.outTok / (r.ms / 1000)));
console.log(`\nimplied output speed on steps >200 outTok: median=${pct(tokensPerSec(), 50).toFixed(1)} tok/s  p90=${pct(tokensPerSec(), 90).toFixed(1)} tok/s`);

const tps2 = rows.filter((r) => r.rc > 2000 && r.ms > 5000).map((r) => (r.outTok / (r.ms / 1000)));
console.log(`on steps with big reasoning: median=${pct(tps2, 50)?.toFixed(1)} tok/s (n=${tps2.length})`);
