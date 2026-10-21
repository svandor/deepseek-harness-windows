// Analyze a decoded DSH session log: per-step model latency, tool time, reasoning volume.
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean);
const entries = [];
for (const l of lines) { try { entries.push(JSON.parse(l)); } catch {} }

const starts = new Map();   // step key -> time
const ends = new Map();
const asst = new Map();
const key = (e) => `${e.data?.turn ?? '?'}/${e.data?.step ?? '?'}`;

for (const e of entries) {
  const k = key(e);
  if (e.type === 'step/start') starts.set(k, e.time);
  if (e.type === 'step/end') ends.set(k, e.time);
  if (e.type === 'assistant/message') asst.set(k, e);
}

const rows = [];
for (const [k, a] of asst) {
  const s = starts.get(k), en = ends.get(k);
  const content = a.data?.message?.content ?? [];
  const reasoning = content.filter((c) => c.type === 'reasoning').map((c) => c.text).join('');
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const tools = content.filter((c) => c.type === 'tool_use' || c.type === 'tool_call');
  rows.push({
    key: k, t: a.time,
    model: a.data?.message?.model ?? a.data?.model ?? null,
    usage: a.data?.usage ?? a.data?.message?.usage ?? null,
    modelMs: s ? a.time - s : null,
    toolMs: en ? en - a.time : null,
    reasoningChars: reasoning.length,
    textChars: text.length,
    tools: tools.length,
  });
}
rows.sort((x, y) => x.t - y.t);

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(1) + 's');

const modelMs = rows.map((r) => r.modelMs).filter((x) => x != null);
const toolMs = rows.map((r) => r.toolMs).filter((x) => x != null);
const sum = (a) => a.reduce((x, y) => x + y, 0);

console.log(`steps=${rows.length}  first=${new Date(rows[0].t).toISOString()}  last=${new Date(rows[rows.length - 1].t).toISOString()}`);
console.log(`wall=${fmt(rows[rows.length - 1].t - rows[0].t)}  modelTime=${fmt(sum(modelMs))}  toolTime=${fmt(sum(toolMs))}`);
console.log(`model step ms: median=${fmt(pct(modelMs, 50))} mean=${fmt(sum(modelMs) / modelMs.length)} p90=${fmt(pct(modelMs, 90))} max=${fmt(Math.max(...modelMs))}`);
console.log(`reasoning chars: total=${sum(rows.map((r) => r.reasoningChars))} median/step=${pct(rows.map((r) => r.reasoningChars), 50)} max=${Math.max(...rows.map((r) => r.reasoningChars))}`);

const models = {};
for (const r of rows) models[r.model ?? 'null'] = (models[r.model ?? 'null'] ?? 0) + 1;
console.log('models:', JSON.stringify(models));

console.log('\nTop 12 slowest model steps:');
for (const r of [...rows].filter((x) => x.modelMs != null).sort((a, b) => b.modelMs - a.modelMs).slice(0, 12)) {
  console.log(`  ${r.key.padEnd(8)} ${new Date(r.t).toISOString()} model=${String(r.model)} modelMs=${fmt(r.modelMs).padStart(7)} toolMs=${fmt(r.toolMs).padStart(7)} reasonChars=${String(r.reasoningChars).padStart(6)} tools=${r.tools}`);
}

console.log('\nPer turn:');
const byTurn = {};
for (const r of rows) { const t = r.key.split('/')[0]; (byTurn[t] ??= []).push(r); }
for (const [t, rs] of Object.entries(byTurn)) {
  const mm = rs.map((r) => r.modelMs).filter((x) => x != null);
  console.log(`  turn ${t}: steps=${rs.length} span=${fmt(rs[rs.length - 1].t - rs[0].t)} modelTime=${fmt(sum(mm))} median=${fmt(pct(mm, 50))} reasonChars=${sum(rs.map((r) => r.reasoningChars))}`);
}

console.log('\nSample usage object:', JSON.stringify(rows.find((r) => r.usage)?.usage ?? null));
console.log('Sample row keys:', Object.keys(rows[0]).join(','));
