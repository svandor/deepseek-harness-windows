#!/usr/bin/env node
/**
 * live-match.mjs — az `untracked → PID` párosítás ellenőrzése VALÓS adatokon.
 *
 * WHY: a párosítás a legkockázatosabb pont (itt lehetne idegen folyamatot
 * beregisztrálni). Ez a szkript a futó harness ledgeréből veszi a PID nélküli
 * rekordokat, lekéri a valódi folyamatlistát, és kiírja, melyik rekordhoz talált
 * egyértelmű párt. Nem módosít semmit.
 *
 * FUTTATÁS:  node plugins/dsh-process-guard/test/live-match.mjs [--last N]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUntracked } from '../lib/ledger.js';
import { matchUntracked, processSnapshot } from '../lib/identity.js';

const lastIndex = process.argv.indexOf('--last');
const last = lastIndex >= 0 ? Number(process.argv[lastIndex + 1]) || 10 : 10;

// A párosítás a HARNESS gyermekeit keresi, ezért a harness PID-jét kell
// használni — nem a sajátunkat (a szkript külön folyamat).
function harnessPid() {
  for (const candidate of [join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-web', 'harness.pid'), join(process.cwd(), 'state', 'harness.pid'), 'D:\\Szerver\\Deepseek Harness\\state\\harness.pid']) {
    try {
      const pid = Number(readFileSync(candidate, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0) return { pid, source: candidate };
    } catch {
      /* próbáljuk a következőt */
    }
  }
  return { pid: process.pid, source: '(nem található — a saját pid)' };
}

const harness = harnessPid();
const records = readUntracked();
const snapshot = await processSnapshot();

console.log(`untracked rekord: ${records.length} · folyamat a pillanatképben: ${snapshot.length}`);
console.log(`harness pid: ${harness.pid}  (${harness.source})`);
console.log('');

const selected = records.slice(-last);
let matched = 0;
const seenPids = new Set();
for (const { record } of selected) {
  const match = matchUntracked(record, snapshot, 3_000, harness.pid);
  const ageSeconds = Math.round((Date.now() - record.at) / 1000);
  const duplicate = match !== null && seenPids.has(match.pid);
  const verdict = match === null ? 'nincs / kétértelmű' : `${duplicate ? 'ISMÉTLŐDŐ' : 'EGYEZIK'} → pid ${match.pid}`;
  console.log(`${String(ageSeconds).padStart(6)}s  ${verdict.padEnd(26)}  ${record.cmdline.slice(0, 66)}`);
  if (match !== null) {
    matched += 1;
    seenPids.add(match.pid);
  }
}

console.log('');
console.log(`párosítva: ${matched} / ${selected.length}  ·  különböző PID: ${seenPids.size}`);
const childCount = snapshot.filter((row) => row.parentPid === harness.pid).length;
console.log(`a harness közvetlen gyermekei a pillanatképben: ${childCount}`);
process.exit(0);
