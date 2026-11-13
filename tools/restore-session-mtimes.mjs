#!/usr/bin/env node
/**
 * restore-session-mtimes.mjs — a munkamenet-fájlok eredeti időbélyegének
 * visszaállítása a biztonsági mentésből.
 *
 * WHY (mért hiba, 2026-11-13): a fejléc-átírás (`canonicalize-session-store.mjs`)
 * újratömörítette az első frame-et, és a fájl írása **frissítette a módosítási
 * időt**. A munkamenet-lista viszont ebből rendez, ezért az áthelyezett
 * munkamenetek mind „most" időponttal jelentek meg — a sorrend felborult
 * (mért: 1108 fájl mtime-ja 12:20:21 lett az eredeti 2026-10 helyett).
 *
 * A mentés (`sessions-before-canonicalize-*`) megőrizte az eredeti mtime-okat,
 * ezért innen állítjuk vissza: munkamenet-nevenként párosítunk, és minden
 * egyező fájlra ráírjuk a mentésbeli időt. A könyvtárak időbélyegét NEM
 * bántjuk (az áthelyezés amúgy is megőrizte).
 *
 * FUTTATÁS:
 *   node tools/restore-session-mtimes.mjs --backup <mentés-mappa>           # száraz
 *   node tools/restore-session-mtimes.mjs --backup <mentés-mappa> --apply
 */
import { readdirSync, statSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const backupIndex = args.indexOf('--backup');
if (backupIndex < 0 || args[backupIndex + 1] === undefined) {
  console.error('hiányzó --backup <mentés-mappa>');
  process.exit(2);
}
const backupRoot = args[backupIndex + 1];
const rootIndex = args.indexOf('--root');
const sessionsRoot = rootIndex >= 0 ? args[rootIndex + 1] : join(homedir(), '.dsh', 'sessions');

/** munkamenet-név → {fájlnév → mtime} a mentésből. */
const backupMtimes = new Map();
for (const project of readdirSync(backupRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  const projectPath = join(backupRoot, project.name);
  for (const session of readdirSync(projectPath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const sessionPath = join(projectPath, session.name);
    const files = new Map();
    for (const name of readdirSync(sessionPath)) {
      try {
        files.set(name, statSync(join(sessionPath, name)).mtimeMs);
      } catch {
        /* eltűnt */
      }
    }
    // Ha egy név több projektben is szerepel, az elsőt tartjuk (a nevek egyediek).
    if (!backupMtimes.has(session.name)) backupMtimes.set(session.name, files);
  }
}

console.log(`mentés: ${backupRoot}  ·  ismert munkamenet: ${backupMtimes.size}`);
console.log(apply ? 'MÓD: ALKALMAZÁS' : 'MÓD: száraz próba');

let scanned = 0;
let restored = 0;
let filesRestored = 0;
let unknown = 0;
const changedExamples = [];

for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  const projectPath = join(sessionsRoot, project.name);
  for (const session of readdirSync(projectPath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    scanned += 1;
    const known = backupMtimes.get(session.name);
    if (known === undefined) {
      unknown += 1;
      continue;
    }
    const sessionPath = join(projectPath, session.name);
    let touched = 0;
    for (const name of readdirSync(sessionPath)) {
      const mtimeMs = known.get(name);
      if (mtimeMs === undefined) continue;
      const file = join(sessionPath, name);
      let current;
      try {
        current = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // 2 mp tolerancia: ne írjunk olyanra, ami már jó
      if (Math.abs(current - mtimeMs) < 2000) continue;
      if (changedExamples.length < 5) {
        changedExamples.push(`${session.name}/${name}: ${new Date(current).toISOString()} -> ${new Date(mtimeMs).toISOString()}`);
      }
      if (apply) {
        try {
          const atime = statSync(file).atimeMs / 1000;
          utimesSync(file, atime, mtimeMs / 1000);
        } catch {
          continue;
        }
      }
      touched += 1;
    }
    if (touched > 0) {
      restored += 1;
      filesRestored += touched;
    }
  }
}

console.log('');
for (const example of changedExamples) console.log(`  pl. ${example}`);
console.log('');
console.log(`átvizsgált munkamenet: ${scanned} · érintett: ${restored} · fájl: ${filesRestored} · mentésben ismeretlen (kihagyva): ${unknown}`);
if (!apply) console.log('Száraz próba — semmit nem írtam.');
process.exit(0);
