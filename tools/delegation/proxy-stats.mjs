// A helyi fallback proxy hatékonyságának mérése a naplójából.
// Futtatás: node proxy-stats.mjs [--json]
// A proxy naplója soronként: "<ISO idő> <esemény> <cél> [-> ok]".
// Az új (2026-10-07) tartalom-vizsgáló a "FAIL ... -> <ok>" sorokban jelenik meg
// olyan okokkal, mint "sérült harmony-token a streamben" vagy
// "tool-hívás content-szövegként (nincs valódi tool_calls)".
import { readFileSync, existsSync } from 'node:fs';

const LOG = process.argv.includes('--log')
  ? process.argv[process.argv.indexOf('--log') + 1]
  : 'C:\\Szerver\\Deepseek Harness\\providers\\proxy.out.log';
const asJson = process.argv.includes('--json');

if (!existsSync(LOG)) {
  console.log(asJson ? JSON.stringify({ error: 'nincs napló', log: LOG }) : `nincs napló: ${LOG}`);
  process.exit(0);
}
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => l.includes('[fallback-proxy]'));
const ev = { HIT: 0, FALLBACK: 0, FAIL: 0, 'STREAM-MEGSZAKADT': 0, STALL: 0, WARN: 0 };
const failByTarget = {};
const failByReason = {};
let first = null, last = null;
for (const l of lines) {
  const m = l.match(/^\[fallback-proxy\]\s+(\S+)\s+(\S+)\s*(.*)$/);
  if (!m) continue;
  const [, ts, verb, rest] = m;
  if (!first) first = ts;
  last = ts;
  if (verb in ev) ev[verb]++;
  if (verb === 'FAIL') {
    const parts = rest.split(/\s*->\s*/);
    const target = (parts[0] || '').trim();
    const reason = (parts[1] || '').trim();
    failByTarget[target] = (failByTarget[target] || 0) + 1;
    let kind = 'egyéb';
    if (/harmony/i.test(reason)) kind = 'sérült harmony-stream';
    else if (/content-szövegként/i.test(reason)) kind = 'pszeudo tool-hívás';
    else if (/finish_reason=error/i.test(reason)) kind = 'finish_reason=error';
    else if (/üres stream/i.test(reason)) kind = 'üres stream';
    else if (/hálózat|fetch failed|ECONN|ETIMEDOUT/i.test(reason)) kind = 'hálózat';
    else if (/^HTTP \d/.test(reason)) kind = 'HTTP státusz';
    failByReason[kind] = (failByReason[kind] || 0) + 1;
  }
}
const total = ev.HIT + ev.FALLBACK + ev.FAIL;
const contentRejects = Object.entries(failByReason)
  .filter(([k]) => k !== 'hálózat' && k !== 'HTTP státusz')
  .reduce((a, [, n]) => a + n, 0);
const out = {
  log: LOG,
  window: { first, last, lines: lines.length },
  events: ev,
  successRatePct: total ? Math.round((100 * ev.HIT) / total) : null,
  failByTarget,
  failByReason,
  contentRejects,
};
if (asJson) { console.log(JSON.stringify(out)); }
else {
  console.log(`napló: ${LOG}`);
  console.log(`ablak: ${first} .. ${last} (${lines.length} sor)`);
  console.log(`HIT=${ev.HIT} FALLBACK=${ev.FALLBACK} FAIL=${ev.FAIL} STREAM-MEGSZAKADT=${ev['STREAM-MEGSZAKADT']} STALL=${ev.STALL}`);
  console.log(`sikerarány (HIT/${total}): ${out.successRatePct}%`);
  console.log(`tartalom alapján elutasított válasz: ${contentRejects}`);
  console.log('hiba okok:', JSON.stringify(failByReason));
  console.log('hiba célok:', JSON.stringify(failByTarget));
}
