// Egy session-pillanatkep szerkezetenek feltarasa.
// Futtatas: node peek.mjs <fajl>
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const buf = readFileSync(file);
const txt = file.endsWith('.zstd') ? zlib.zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
const lines = txt.split(/\r?\n/).filter((l) => l.trim());
console.log('fajl:', file);
console.log('bytes:', buf.length, '| dekomprimált hossz:', txt.length, '| nem ures sorok:', lines.length);
for (const k of ['subagent', 'before it finished', 'was stopped', 'toolName', 'tool_call', 'assistant', 'error', 'route', 'provider', 'model', 'delegationDepth', 'isError']) {
  const n = (txt.match(new RegExp(k, 'gi')) || []).length;
  if (n) console.log(`  ${k}: ${n}`);
}
try {
  const o = JSON.parse(lines[0]);
  console.log('\nJSON kulcsok:', Object.keys(o).join(', '));
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) console.log(`  ${k}: Array(${v.length})` + (v.length ? ' pl. ' + JSON.stringify(v[0]).slice(0, 200) : ''));
    else if (v && typeof v === 'object') console.log(`  ${k}: Object{ ${Object.keys(v).slice(0, 12).join(', ')} }`);
    else console.log(`  ${k}: ${JSON.stringify(v).slice(0, 120)}`);
  }
} catch (e) { console.log('JSON parse hiba:', e.message); }
