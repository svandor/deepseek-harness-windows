// Delegacios esemenyek pontos felderitese + napi statisztika.
// Futtatas: node notices.mjs [napok]
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\info\\.dsh\\sessions';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl.zstd')) out.push(p);
  }
  return out;
}
function framesText(file) {
  const buf = readFileSync(file);
  const starts = []; let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 1); }
  let out = '';
  for (let n = 0; n < starts.length; n++) {
    const from = starts[n], to = n + 1 < starts.length ? starts[n + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'); } catch {}
  }
  return out;
}
function eventsOf(text) { const r = []; for (const l of text.split(/\r?\n/)) { const s = l.trim(); if (!s) continue; try { r.push(JSON.parse(s)); } catch {} } return r; }

const days = Number(process.argv[2] || 8);
const cutoff = Date.now() - days * 86400000;
const files = walk(ROOT).map((f) => ({ f, m: statSync(f).mtime })).filter((x) => x.m.getTime() >= cutoff).sort((a, b) => a.m - b.m);
console.log(`fájlok: ${files.length}`);

const RE = /started subagent|before it finished|closing message|Background subagent|no closing message/i;
const byType = new Map();
const samples = [];
const perDay = new Map();
let totalStarted = 0;

for (const { f, m } of files) {
  const day = m.toISOString().slice(0, 10);
  const st = perDay.get(day) || { started: 0, finished: 0, failed: 0, stopped: 0, noreport: 0, other: 0 };
  for (const ev of eventsOf(framesText(f))) {
    const js = JSON.stringify(ev);
    if (!RE.test(js)) continue;
    const t = ev.type || '?';
    byType.set(t, (byType.get(t) || 0) + 1);
    // a sajat asszisztens-szovegemet kizarjuk
    if (t === 'assistant/message') continue;
    // csak a tool/result "started subagent <id>" szamit delegalasnak
    const started = /started subagent\s+[0-9a-f-]{8}/i.test(js);
    const failed = /failed before it finished/i.test(js);
    const stopped = /was stopped before it finished/i.test(js);
    const norep = /no closing message/i.test(js);
    const finished = /closing message/i.test(js) && !norep;
    if (started) { st.started++; totalStarted++; }
    if (failed) st.failed++;
    if (stopped) st.stopped++;
    if (norep) st.noreport++;
    if (finished) st.finished++;
    if (!started && !failed && !stopped && !norep && !finished) st.other++;
    if (samples.length < 10 && (failed || norep || finished)) {
      const idx = js.search(/failed before it finished|no closing message|closing message/i);
      samples.push({ day, type: t, snip: js.slice(Math.max(0, idx - 200), idx + 200).replace(/\s+/g, ' ') });
    }
  }
  perDay.set(day, st);
}
console.log('\neseménytipusok, amikben a minták előfordulnak:', JSON.stringify([...byType]));
console.log('\nnap         started  finished  failed  stopped  no-report  other');
for (const [day, s] of [...perDay].sort((a, b) => b[0].localeCompare(a[0]))) {
  console.log(`${day}  ${String(s.started).padStart(7)}  ${String(s.finished).padStart(8)}  ${String(s.failed).padStart(6)}  ${String(s.stopped).padStart(7)}  ${String(s.noreport).padStart(9)}  ${String(s.other).padStart(6)}`);
}
console.log('\n--- mintak ---');
for (const s of samples) console.log(`[${s.day}] ${s.type}\n   ...${s.snip}...\n`);
