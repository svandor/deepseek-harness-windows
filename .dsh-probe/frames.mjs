// A .jsonl.zstd fajlok tobb zstd-frame-bol allnak: a magic (28 B5 2F FD) menten
// szetvagjuk, és frame-enkent dekomprimálunk.
// Futtatas: node frames.mjs <fajl> [dumpKarakter]
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const dump = Number(process.argv[3] || 0);
const buf = readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const starts = [];
let i = buf.indexOf(MAGIC, 0);
while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 1); }
console.log(`fajl: ${file}\nbytes: ${buf.length}, zstd-frame-ek: ${starts.length}`);

let out = '';
let ok = 0, bad = 0;
for (let n = 0; n < starts.length; n++) {
  const from = starts[n];
  const to = n + 1 < starts.length ? starts[n + 1] : buf.length;
  try { out += zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'); ok++; }
  catch { bad++; }
}
console.log(`frame: OK ${ok}, hibas ${bad} | dekomprimált hossz: ${out.length}`);
const lines = out.split(/\r?\n/).filter((l) => l.trim());
console.log('sorok:', lines.length);
const kinds = {};
for (const l of lines) { try { const o = JSON.parse(l); const k = o.type || '?'; kinds[k] = (kinds[k] || 0) + 1; } catch { kinds['<tort>'] = (kinds['<tort>'] || 0) + 1; } }
console.log('esemenytipusok:', JSON.stringify(kinds));
for (const k of ['before it finished', 'was stopped', 'isError', 'subagent', 'assistant', 'tool', 'model', 'provider', 'usage']) {
  const n = (out.match(new RegExp(k, 'gi')) || []).length;
  if (n) console.log(`  ${k}: ${n}`);
}
if (dump > 0) { console.log('\n--- utolso ' + dump + ' karakter ---'); console.log(out.slice(-dump)); }
