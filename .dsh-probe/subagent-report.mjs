// Delegacios sikeresseg: a subagent tool-hivasok es eredmenyeik parosítasa.
// Futtatas: node subagent-report.mjs sample | stats [napok]
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\info\\.dsh\\sessions';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p);
  }
  return out;
}
function framesText(file) {
  const buf = readFileSync(file);
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 1); }
  let out = '';
  for (let n = 0; n < starts.length; n++) {
    const from = starts[n];
    const to = n + 1 < starts.length ? starts[n + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'); } catch {}
  }
  return out;
}
function eventsOf(text) {
  const events = [];
  for (const l of text.split(/\r?\n/)) { const s = l.trim(); if (!s) continue; try { events.push(JSON.parse(s)); } catch {} }
  return events;
}

const mode = process.argv[2] || 'stats';
const days = Number(process.argv[3] || 7);
const cutoff = Date.now() - days * 86400000;
const files = walk(ROOT).map((f) => ({ f, m: statSync(f).mtime })).filter((x) => x.m.getTime() >= cutoff).sort((a, b) => a.m - b.m);
console.log(`vizsgált session-fájl: ${files.length} (utolsó ${days} nap)`);

if (mode === 'sample') {
  for (const { f } of files.slice(-6)) {
    const events = eventsOf(framesText(f));
    const sub = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('subagent'));
    if (sub) { console.log('--- ' + f.replace(ROOT, '')); console.log(JSON.stringify(sub).slice(0, 900)); break; }
  }
} else {
  const perDay = new Map();
  const failures = [];
  let totalSub = 0, completed = 0, failed = 0, stopped = 0, unknown = 0;
  for (const { f, m } of files) {
    const day = m.toISOString().slice(0, 10);
    const st = perDay.get(day) || { sub: 0, done: 0, fail: 0, stop: 0, unk: 0 };
    const events = eventsOf(framesText(f));
    const calls = new Map();
    for (const ev of events) if (ev.type === 'tool/call' && ev.data?.callId) calls.set(ev.data.callId, ev.data.name);
    for (const ev of events) {
      if (ev.type !== 'tool/result') continue;
      const name = calls.get(ev.data?.callId);
      if (name !== 'subagent' && name !== 'subagent_fork') continue;
      const txt = JSON.stringify(ev);
      totalSub++; st.sub++;
      if (/failed before it finished/i.test(txt)) { failed++; st.fail++; if (failures.length < 8) failures.push({ day, file: f.replace(ROOT, ''), kind: 'FAILED', snip: txt.slice(0, 260) }); }
      else if (/was stopped before it finished/i.test(txt)) { stopped++; st.stop++; if (failures.length < 8) failures.push({ day, file: f.replace(ROOT, ''), kind: 'STOPPED', snip: txt.slice(0, 260) }); }
      else if (/"isError":\s*true/.test(txt)) { failed++; st.fail++; if (failures.length < 8) failures.push({ day, file: f.replace(ROOT, ''), kind: 'TOOL-ERROR', snip: txt.slice(0, 260) }); }
      else if (txt.length > 400) { completed++; st.done++; }
      else { unknown++; st.unk++; }
    }
    perDay.set(day, st);
  }
  console.log('\nnap         subagent  kesz  hiba  leallitott  egyeb');
  for (const [day, s] of [...perDay].sort((a, b) => b[0].localeCompare(a[0]))) {
    console.log(`${day}  ${String(s.sub).padStart(8)}  ${String(s.done).padStart(4)}  ${String(s.fail).padStart(4)}  ${String(s.stop).padStart(10)}  ${String(s.unk).padStart(5)}`);
  }
  const rate = totalSub ? ((completed / totalSub) * 100).toFixed(1) : '0';
  console.log(`\nOSSZESEN: ${totalSub} delegálás | kész: ${completed} | hiba: ${failed} | leállított: ${stopped} | egyéb: ${unknown} | sikerarány: ${rate}%`);
  console.log('\n--- hibamintak ---');
  for (const x of failures) console.log(`[${x.day}] ${x.kind} ${x.file}\n   ${x.snip.replace(/\s+/g, ' ')}\n`);
}
