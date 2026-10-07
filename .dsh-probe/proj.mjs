// Projcache JSON szerkezet feltarasa + osszesites.
// Futtatas: node proj.mjs <fajl> [dump]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const dump = process.argv[3] === 'dump';
const o = JSON.parse(readFileSync(file, 'utf8'));

function summarize(obj, prefix = '', depth = 0) {
  if (depth > 3) return;
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? prefix + '.' + k : k;
    if (Array.isArray(v)) console.log(`  ${p}: Array(${v.length})` + (v.length ? ' | pl. ' + JSON.stringify(v[0]).slice(0, 160) : ''));
    else if (v && typeof v === 'object') { console.log(`  ${p}: Object`); summarize(v, p, depth + 1); }
    else console.log(`  ${p}: ${JSON.stringify(v).slice(0, 120)}`);
  }
}
console.log('fajl:', file, '| bytes:', readFileSync(file).length);
console.log('top szint:', Object.keys(o).join(', '));
summarize(o);
if (dump) {
  const txt = JSON.stringify(o);
  console.log('\n--- kulcsszavak ---');
  for (const k of ['subagent', 'before it finished', 'was stopped', 'assistant', 'toolCall', 'tool', 'error', 'model', 'provider', 'usage', 'prompt']) {
    const n = (txt.match(new RegExp(k, 'gi')) || []).length;
    if (n) console.log(`  ${k}: ${n}`);
  }
}
