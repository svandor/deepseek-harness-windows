#!/usr/bin/env node
/**
 * A tömörítés küszöbének javítása a telepitett DSH csomagban.
 *
 * MIÉRT: MÉRVE (2026-11-17, `~/.dsh/compaction-diag.log`) a profil
 * `cordis.patch.yml` `- id: compaction-basic` + `config: {thresholdRatio: …}`
 * felülírása NEM érvényesül: a futó plugin a gyári 0.8-cal számol
 * (`threshold=800000`), ami a valódi üzenet-plafon (792 576 = 1 048 576 −
 * 256 000 maxTokens) FÖLÖTT van, ezért a szelíd tömörítés SOHA nem fut le —
 * csak a 400-as válasz utáni vész-út. A javítás ezért a gyári defaultot állítja.
 *
 * Használat:
 *   node tools\patch-compaction-threshold.mjs --check    (alap: 0.35)
 *   node tools\patch-compaction-threshold.mjs --apply
 *   node tools\patch-compaction-threshold.mjs --revert
 *
 * Érvénybe lépés: a harness következő indulásakor (§1.5). DSH-frissítés után
 * újra futtatandó (a csomag felülíródik).
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RATIO = Number(process.argv[3] ?? 0.35);
const TARGET = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'npm-cache', '_npx', 'b86ed90107c62dab', 'node_modules', '@deepseek-ai',
  'dsh-compaction-basic', 'lib', 'index.js',
);
const ANCHOR = 'const DEFAULT_THRESHOLD_RATIO = .8;';

function read() {
  if (!existsSync(TARGET)) {
    console.error(`HIBA: nincs ilyen fájl: ${TARGET}`);
    process.exit(2);
  }
  return readFileSync(TARGET, 'utf8');
}

const arg = process.argv[2] ?? '--check';
const text = read();
const current = /const DEFAULT_THRESHOLD_RATIO = ([\d.]+);/.exec(text)?.[1];

if (arg === '--check') {
  console.log(`cél: ${TARGET}`);
  console.log(`  DEFAULT_THRESHOLD_RATIO = ${current ?? '?'}  (kívánt: ${RATIO})`);
  const bak = `${TARGET}.threshold-bak`;
  console.log(`  mentés: ${existsSync(bak) ? 'van' : 'nincs'}`);
  process.exit(current === String(RATIO) ? 0 : 1);
}

if (arg === '--revert') {
  const bak = `${TARGET}.threshold-bak`;
  if (!existsSync(bak)) { console.error(`HIBA: nincs mentés (${bak})`); process.exit(4); }
  copyFileSync(bak, TARGET);
  console.log(`visszaállítva: ${TARGET}`);
  process.exit(0);
}

if (arg === '--apply') {
  if (!Number.isFinite(RATIO) || RATIO <= 0 || RATIO >= 1) {
    console.error('HIBA: az arány 0 és 1 közé essen (pl. 0.35)');
    process.exit(3);
  }
  if (current === String(RATIO)) { console.log(`már ${RATIO} — nincs teendő`); process.exit(0); }
  copyFileSync(TARGET, `${TARGET}.threshold-bak`);
  writeFileSync(TARGET, text.replace(/const DEFAULT_THRESHOLD_RATIO = [\d.]+;/, `const DEFAULT_THRESHOLD_RATIO = ${RATIO};`));
  const after = /const DEFAULT_THRESHOLD_RATIO = ([\d.]+);/.exec(read())?.[1];
  console.log(`DEFAULT_THRESHOLD_RATIO: ${current} -> ${after}`);
  console.log(`küszöb ${RATIO} × 1 000 000 = ${Math.floor(RATIO * 1000000)} token (a plafon 792 576)`);
  console.log('érvénybe lépés: a harness következő indulásakor; ellenőrzés: ~/.dsh/compaction-diag.log');
  process.exit(0);
}

console.error('használat: node tools\\patch-compaction-threshold.mjs [--check|--apply|--revert] [arany]');
process.exit(2);
