// Pontos delegacios statisztika: csak az authoritative esemenyek.
//  - inditas: tool/result, benne "started subagent <id>"
//  - kimenetel: agent/inbox/spliced ertesitesek (finished / failed / stopped / no closing message)
// Futtatas: node delegation-stats.mjs [napok]
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

const RE_START = /started subagent\s+[0-9a-f]{8}-[0-9a-f-]+/gi;
const RE_FIN = /Background subagent\s+[0-9a-f]{8}-[0-9a-f-]+\s+finished/gi;
const RE_FAIL = /Background subagent\s+[0-9a-f]{8}-[0-9a-f-]+\s+failed before it finished/gi;
const RE_STOP = /Background subagent\s+[0-9a-f]{8}-[0-9a-f-]+\s+was stopped before it finished/gi;
const RE_NOREP = /no closing message/gi;

const perDay = new Map();
const ids = { started: new Set(), finished: new Set(), failed: new Set(), stopped: new Set() };
const failList = [];
for (const { f, m } of files) {
  const day = m.toISOString().slice(0, 10);
  const st = perDay.get(day) || { started: 0, finished: 0, failed: 0, stopped: 0, norep: 0 };
  for (const ev of eventsOf(framesText(f))) {
    const js = JSON.stringify(ev);
    if (ev.type === 'tool/result') {
      for (const mm of js.matchAll(RE_START)) { st.started++; ids.started.add(mm[0]); }
    } else if (ev.type === 'agent/inbox/spliced') {
      for (const mm of js.matchAll(RE_FIN)) { st.finished++; ids.finished.add(mm[0].replace(/finished/i, '').trim()); }
      for (const mm of js.matchAll(RE_FAIL)) { st.failed++; ids.failed.add(mm[0].replace(/failed before it finished/i, '').trim()); if (failList.length < 6) failList.push({ day, id: mm[0].trim() }); }
      for (const mm of js.matchAll(RE_STOP)) { st.stopped++; ids.stopped.add(mm[0].replace(/was stopped before it finished/i, '').trim()); }
      for (const mm of js.matchAll(RE_NOREP)) st.norep++;
    }
  }
  perDay.set(day, st);
}
console.log('nap         inditas  befejezett  hiba  leallitott  no-report');
let T = { started: 0, finished: 0, failed: 0, stopped: 0, norep: 0 };
for (const [day, s] of [...perDay].sort((a, b) => b[0].localeCompare(a[0]))) {
  console.log(`${day}  ${String(s.started).padStart(7)}  ${String(s.finished).padStart(11)}  ${String(s.failed).padStart(4)}  ${String(s.stopped).padStart(10)}  ${String(s.norep).padStart(9)}`);
  for (const k of Object.keys(T)) T[k] += s[k];
}
const rate = T.started ? ((T.finished / T.started) * 100).toFixed(0) : '0';
console.log(`\nOSSZESEN: inditas=${T.started} befejezett=${T.finished} hiba=${T.failed} leallitott=${T.stopped} no-report=${T.norep}  -> sikerarany=${rate}%`);
console.log('\negyedi azonosítok (dedup):', JSON.stringify({ started: ids.started.size, finished: ids.finished.size, failed: ids.failed.size, stopped: ids.stopped.size }));
console.log('\n--- a "failed before it finished" gyermekek (elso 6) ---');
for (const x of failList) console.log(`  [${x.day}] ${x.id}`);
