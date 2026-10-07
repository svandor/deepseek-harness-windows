// Elhalt/leallitott gyerek-sessionok boncolasa: mi a hiba oka?
// Futtatas: node child-forensics.mjs [napok]
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\info\\.dsh\\sessions';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function walk(dir, out = [], dirs = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { dirs.push(p); walk(p, out, dirs); } else if (e.name.endsWith('.jsonl.zstd')) out.push(p);
  }
  return { files: out, dirs };
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
const { files } = walk(ROOT);
const days = Number(process.argv[2] || 2);
const cutoff = Date.now() - days * 86400000;
const recent = files.map((f) => ({ f, m: statSync(f).mtime })).filter((x) => x.m.getTime() >= cutoff).sort((a, b) => a.m - b.m);

const RE_FAIL = /Background subagent\s+([0-9a-f]{8}-[0-9a-f-]+)\s+failed before it finished/gi;
const RE_STOP = /Background subagent\s+([0-9a-f]{8}-[0-9a-f-]+)\s+was stopped before it finished/gi;
const RE_FIN = /Background subagent\s+([0-9a-f]{8}-[0-9a-f-]+)\s+finished/gi;
const bad = new Map(), good = new Map();
for (const { f } of recent) {
  for (const ev of framesText(f).split(/\r?\n/)) {
    if (!ev.includes('agent/inbox/spliced')) continue;
    for (const re of [RE_FAIL, RE_STOP]) for (const mm of ev.matchAll(re)) bad.set(mm[1], re === RE_FAIL ? 'FAILED' : 'STOPPED');
    for (const mm of ev.matchAll(RE_FIN)) if (!bad.has(mm[1])) good.set(mm[1], 'FINISHED');
  }
}
console.log(`utolso ${days} nap: elhalt/leallitott gyerek = ${bad.size}, befejezett = ${good.size}`);
console.log('elhaltak:', [...bad].slice(0, 12).map(([id, k]) => `${id.slice(0, 8)}(${k})`).join(', '));

const targets = [...bad.keys()].slice(0, 3).concat([...good.keys()].slice(0, 2));
for (const id of targets) {
  const hits = walk(ROOT).dirs.filter((d) => d.endsWith(id));
  if (!hits.length) { console.log(`\n### ${id}: nincs session-mappa`); continue; }
  const file = join(hits[0], 'session.v3.jsonl.zstd');
  if (!readFileSync || !statSync(file).isFile()) { console.log(`\n### ${id}: nincs session.v3.jsonl.zstd`); continue; }
  const txt = framesText(file);
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const kinds = {};
  for (const l of lines) { try { const o = JSON.parse(l); kinds[o.type] = (kinds[o.type] || 0) + 1; } catch {} }
  const counts = {};
  for (const k of ['429', '413', 'rate limit', 'quota', 'timeout', 'ETIMEDOUT', 'fetch failed', 'no tool', 'tool_calls', 'isError":true', 'error', 'upstream', 'llmRetry', 'stall']) {
    const n = (txt.match(new RegExp(k, 'gi')) || []).length;
    if (n) counts[k] = n;
  }
  console.log(`\n### ${id} [${bad.get(id) || good.get(id) || '?'}] fájl=${statSync(file).size}B dekomprimált=${txt.length}B események=${lines.length}`);
  console.log('   tipusok:', JSON.stringify(kinds));
  console.log('   kulcsszavak:', JSON.stringify(counts));
  const tail = txt.slice(-500).replace(/\s+/g, ' ');
  console.log('   napló vége:', tail.slice(-420));
}
