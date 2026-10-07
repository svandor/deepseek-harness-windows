// Mely elemzes: session-fajlok (zstd JSONL) -> delegacios sikeresseg.
// Futtatas: node subagent-deep.mjs
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\info\\.dsh\\sessions';
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.includes('.jsonl')) out.push(p);
  }
  return out;
}
function readSession(file) {
  const buf = readFileSync(file);
  let text;
  if (file.endsWith('.zstd')) {
    try { text = zlib.zstdDecompressSync(buf).toString('utf8'); }
    catch (e) { return { error: 'zstd: ' + e.message, events: [], text: '' }; }
  } else text = buf.toString('utf8');
  const events = [];
  for (const line of text.split(/\r?\n/)) { const s = line.trim(); if (!s) continue; try { events.push(JSON.parse(s)); } catch {} }
  return { events, text };
}

const files = walk(ROOT).map((f) => ({ f, m: statSync(f).mtime })).sort((a, b) => a.m - b.m);
const rows = [];
const noticeSamples = [];
for (const { f, m } of files) {
  const { events, text, error } = readSession(f);
  if (error) { rows.push({ day: m.toISOString().slice(0, 10), file: f.replace(ROOT, ''), err: error }); continue; }
  const kinds = {};
  for (const ev of events) { const k = ev.type || '?'; kinds[k] = (kinds[k] || 0) + 1; }
  const header = events.find((e) => e.type === 'session') || {};
  const count = (re) => (text.match(re) || []).length;
  const r = {
    day: m.toISOString().slice(0, 10),
    file: f.replace(ROOT, ''),
    events: events.length,
    depth: header.delegationDepth ?? '',
    preset: header.agentPreset ?? '',
    kinds,
    failed: count(/failed before it finished/gi),
    stopped: count(/was stopped before it finished/gi),
    noreport: count(/no closing message/gi),
    toolErr: count(/"(isError|is_error)":\s*true/gi),
  };
  rows.push(r);
  if (r.failed || r.stopped || r.noreport) {
    const idx = text.search(/failed before it finished|was stopped before it finished|no closing message/i);
    if (idx >= 0 && noticeSamples.length < 6) {
      noticeSamples.push({ file: r.file, day: r.day, snippet: text.slice(Math.max(0, idx - 260), idx + 160).replace(/\s+/g, ' ') });
    }
  }
}

const byDay = new Map();
for (const r of rows) {
  if (r.err) continue;
  const d = byDay.get(r.day) || { sessions: 0, child: 0, childWithEvents: 0, failed: 0, stopped: 0, noreport: 0, toolErr: 0 };
  d.sessions++;
  if (Number(r.depth) >= 1) { d.child++; if (r.events > 1) d.childWithEvents++; }
  d.failed += r.failed; d.stopped += r.stopped; d.noreport += r.noreport; d.toolErr += r.toolErr;
  byDay.set(r.day, d);
}
console.log('nap         session  gyerek(depth>=1)  gyerek+esemeny  failed-notice  stopped-notice  tool-hiba');
for (const [day, d] of [...byDay].sort((a, b) => b[0].localeCompare(a[0]))) {
  console.log(`${day}  ${String(d.sessions).padStart(7)}  ${String(d.child).padStart(15)}  ${String(d.childWithEvents).padStart(14)}  ${String(d.failed).padStart(13)}  ${String(d.stopped).padStart(14)}  ${String(d.toolErr).padStart(9)}`);
}
console.log('\n--- gyerek-sessionok reszletei (depth>=1), utolso 40 ---');
console.log('nap         depth  events  preset          tipusok');
for (const r of rows.filter((x) => Number(x.depth) >= 1).slice(-40)) {
  const k = Object.entries(r.kinds).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, b]) => `${a}:${b}`).join(' ');
  console.log(`${r.day}  ${String(r.depth).padStart(5)}  ${String(r.events).padStart(6)}  ${(r.preset || '').padEnd(15)} ${k}`);
}
console.log('\n--- ures (csak fejlec) gyerek-sessionok szama:', rows.filter((x) => Number(x.depth) >= 1 && x.events <= 1).length);
console.log('\n--- ertesites-mintak (a szulo naplojabol) ---');
for (const s of noticeSamples) console.log(`[${s.day}] ${s.file}\n   ...${s.snippet}...\n`);
if (rows.some((r) => r.err)) { console.log('\n--- zstd hibak ---'); for (const r of rows.filter((x) => x.err).slice(0, 5)) console.log(' ', r.file, r.err); }
