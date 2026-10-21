import { readFileSync } from 'node:fs';
const log = readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const re = /^\[fallback-proxy\] (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.*)$/;
const rows = [];
for (const l of log) { const m = l.match(re); if (m) rows.push({ ts: Date.parse(m[1]), msg: m[2] }); }

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
const sum = (a) => a.reduce((x, y) => x + y, 0);
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

const pairs = [];
let i = 0;
while (i < rows.length) {
  if (rows[i].msg.startsWith('AUTO auto:')) {
    let j = i + 1;
    while (j < rows.length && !rows[j].msg.startsWith('HIT ') && !rows[j].msg.startsWith('AUTO auto:')) j++;
    const hit = rows[j] && rows[j].msg.startsWith('HIT ') ? rows[j] : null;
    pairs.push({ t: rows[i].ts, msg: rows[i].msg, hit: hit ? hit.msg.slice(4) : null, ms: hit ? hit.ts - rows[i].ts : null });
    i = hit ? j + 1 : j;
  } else i++;
}
console.log(`AUTO lines paired: ${pairs.length}, with HIT: ${pairs.filter(p => p.hit).length}, without: ${pairs.filter(p => !p.hit).length}`);
const byT = {};
for (const p of pairs.filter(p => p.hit)) (byT[p.hit] ??= []).push(p.ms);
console.log('\nAUTO -> HIT (upstream request, proxy-observed):');
for (const [k, v] of Object.entries(byT).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k.padEnd(34)} n=${String(v.length).padStart(4)} median=${fmt(pct(v, 50)).padStart(7)} mean=${fmt(sum(v) / v.length).padStart(7)} p90=${fmt(pct(v, 90)).padStart(7)} max=${fmt(Math.max(...v))}`);
}
const byHour = {};
for (const p of pairs) {
  const h = new Date(p.t).toISOString().slice(0, 13);
  (byHour[h] ??= []).push(p);
}
console.log('\nby hour (UTC): count / median AUTO->HIT / no-hit');
for (const [h, v] of Object.entries(byHour).sort()) {
  const withHit = v.filter(p => p.ms != null).map(p => p.ms);
  console.log(`  ${h}: n=${String(v.length).padStart(4)} median=${fmt(pct(withHit, 50)).padStart(7)} nohit=${v.filter(p => p.ms == null).length}`);
}
const slow = [...pairs].filter(p => p.ms != null).sort((a, b) => b.ms - a.ms).slice(0, 8);
console.log('\nslowest AUTO->HIT:');
for (const p of slow) console.log(`  ${new Date(p.t).toISOString()} ${fmt(p.ms).padStart(7)} ${p.hit} :: ${p.msg.slice(0, 120)}`);
