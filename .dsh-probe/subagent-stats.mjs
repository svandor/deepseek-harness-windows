// Subagent-sikeresseg elemzo a DSH session-tarbol.
// A session-fajlok zstd-tomporitett JSONL-ek; a Node zlib zstd-t hasznaljuk.
// Hasznalat: node subagent-stats.mjs schema   -> egy session esemenytipusai + minta
//            node subagent-stats.mjs stats    -> napi bontas, delegalasok, kimenetelek
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const ROOT = 'C:\\Users\\info\\.dsh\\sessions';
const mode = process.argv[2] || 'schema';

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function readSession(file) {
  const buf = readFileSync(file);
  let text;
  if (file.endsWith('.zstd')) {
    try { text = zlib.zstdDecompressSync(buf).toString('utf8'); }
    catch (e) { return { error: 'zstd: ' + e.message, events: [] }; }
  } else text = buf.toString('utf8');
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { /* tolerate torn lines */ }
  }
  return { events };
}

// Egy esemeny "tipusa": a legvaloszinubb kulcsok alapjan.
function kindOf(ev) {
  return ev.type || ev.kind || ev.event || ev.t || Object.keys(ev).slice(0, 3).join('+');
}

const files = walk(ROOT).map((f) => ({ f, m: statSync(f).mtime }))
  .sort((a, b) => b.m - a.m);
console.log(`session-fajlok: ${files.length}`);

if (mode === 'schema') {
  const { f } = files[0];
  const { events, error } = readSession(f);
  console.log('minta:', f);
  if (error) console.log('HIBA:', error);
  const kinds = new Map();
  for (const ev of events) {
    const k = kindOf(ev);
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  console.log('esemenytipusok:');
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
  const sample = events.find((e) => JSON.stringify(e).length > 200);
  if (sample) {
    console.log('\n--- minta-esemeny (400 karakter) ---');
    console.log(JSON.stringify(sample).slice(0, 400));
  }
  const keys = new Set();
  for (const ev of events.slice(0, 400)) for (const k of Object.keys(ev)) keys.add(k);
  console.log('\nelso 400 esemeny kulcsai:', [...keys].join(', '));
} else {
  const perDay = new Map();
  let totalEvents = 0, sessions = 0, decompressErrors = 0;
  const hits = { subagentTool: 0, childSessions: 0, noReport: 0, stopped: 0, failed: 0, errorText: 0 };
  for (const { f, m } of files) {
    const day = m.toISOString().slice(0, 10);
    const { events, error } = readSession(f);
    if (error) { decompressErrors++; continue; }
    sessions++; totalEvents += events.length;
    const json = events.map((e) => JSON.stringify(e));
    const text = json.join('\n');
    const st = perDay.get(day) || { sessions: 0, events: 0, subagentCalls: 0, noReport: 0, stopped: 0, failed: 0, errors: 0 };
    st.sessions++; st.events += events.length;
    const toolCalls = (text.match(/"name":\s*"(subagent|subagent_fork)"/g) || []).length;
    const noReport = (text.match(/no closing message|before it finished/gi) || []).length;
    const stopped = (text.match(/was stopped before it finished/gi) || []).length;
    const failed = (text.match(/failed before it finished/gi) || []).length;
    const errs = (text.match(/"(error|errorText|failure)":/g) || []).length;
    st.subagentCalls += toolCalls; st.noReport += noReport; st.stopped += stopped; st.failed += failed; st.errors += errs;
    hits.subagentTool += toolCalls; hits.noReport += noReport; hits.stopped += stopped; hits.failed += failed; hits.errorText += errs;
    perDay.set(day, st);
  }
  console.log(`\nsession megnyitva: ${sessions}, zstd-hiba: ${decompressErrors}, esemenyek: ${totalEvents}`);
  console.log('\nnap        session  esemeny  subagent-hiv  no-report  stopped  failed  error-mezo');
  for (const [day, s] of [...perDay].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 8)) {
    console.log(`${day}  ${String(s.sessions).padStart(6)}  ${String(s.events).padStart(7)}  ${String(s.subagentCalls).padStart(12)}  ${String(s.noReport).padStart(9)}  ${String(s.stopped).padStart(7)}  ${String(s.failed).padStart(6)}  ${String(s.errors).padStart(10)}`);
  }
  console.log('\nosszesen:', JSON.stringify(hits));
}
