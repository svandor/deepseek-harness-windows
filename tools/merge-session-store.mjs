#!/usr/bin/env node
/**
 * merge-session-store.mjs — a párhuzamos session-tárolók összevonása.
 *
 * WHY: a session-tároló helyét a `projectKey(cwd)` adja, ami a `cwd` NYERS
 * szövegének lossy kódolása (`dsh-session-persistence-jsonl/lib/index.js:874`).
 * Mivel a `C:` egy junction a `D:`-re, ugyanarra a könyvtárra két tároló
 * keletkezett (mért: `--C-Szerver-Deepseek~0020Harness--` ÉS
 * `--D-Szerver-Deepseek~0020Harness--`, 1184 artefaktum, ~575 MB).
 *
 * A KÖNYVTÁRNÉVRE HAGYATKOZNI TILOS: a kódolás lossy (a `~0020` szóköz, a
 * kis/nagybetű megmarad, a levágás 251 karakternél), és a nevek el is térnek
 * egymástól: `--C-Szerver-Vector--`, `--D-Server-Vector--`, `--D-Szerver-Vector--`.
 * Ezért a valódi forrást minden munkamenet FEJLÉCE adja (`cwd`), és a kanonikus
 * kulcs `projectKey(realpath(cwd))`.
 *
 * Mi a teendő vele: a nem kanonikus könyvtárban ülő munkameneteket át kell
 * mozgatni a kanonikus könyvtárba. Ez NEM töröl semmit: ütközésnél kihagy, és
 * minden lépést kiír.
 *
 * FUTTATÁS (alapból SZÁRAZ PRÓBA, semmit nem mozgat):
 *   node tools/merge-session-store.mjs --dry-run
 *   node tools/merge-session-store.mjs --apply
 *   node tools/merge-session-store.mjs --root <mappa> --apply
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const args = process.argv.slice(2);

// ============================================================================
//  BLOKKOLVA — 2026-11-13, HELYESBÍTÁS
// ============================================================================
//  Ez az eszköz MÁR EGYSZER TÖNKRE TETTE A HARNESS INDULÁSÁT (mért eset).
//  A feltevése hibás volt: a session-tároló helye a FEJLÉCBEN TÁROLT `cwd`
//  LITERÁLIS szövegéből számol (`projectKey(meta.cwd)`), NEM a `realpath`-ból.
//  A mag ellenőrzi is ezt:
//    dsh-session-persistence-jsonl/lib/index.js:3251
//      expectedPath = generationLogPath(this.root, meta.cwd, ...)
//    :3255  if (path !== expectedPath && !sameFile(...))
//             throw "corrupt session log ... header id and cwd identify ..."
//  Vagyis egy `C:\…` fejlécű munkamenetet a `--D-…--` mappába mozgatva a napló
//  „corrupt"-tá válik, és a boot elhal — pontosan ez történt (1093 napló).
//
//  Ezért az `--apply` NEM mozgat. Az eszköz csak ELLENŐRIZ (riportot ad arról,
//  hogy a fizikai hely megfelel-e a fejléc szerinti kulcsnak). A helyes irány a
//  „fix forward": a régi, C:-fejlécű munkamenetek maradnak, az újakat a mag már
//  kanonikus (realpath-olt) cwd-vel hozza létre.
const applyRequested = args.includes('--apply');
const apply = false;
if (applyRequested) {
  console.error('ELUTASÍTVA: ez az eszköz nem mozgat munkamenetet.');
  console.error('A tároló kulcsa a FEJLÉC `cwd` mezőjének literális értéke, ezért egy');
  console.error('realpath-alapú áthelyezés „corrupt session log"-gá teszi a naplót és');
  console.error('a harness nem indul el (mért eset: 2026-11-13).');
  console.error('Használd `--check` módot: az csak riportál, nem nyúl semmihez.');
  process.exit(3);
}

const rootIndex = args.indexOf('--root');
const sessionsRoot = rootIndex >= 0 ? args[rootIndex + 1] : join(homedir(), '.dsh', 'sessions');
// Élő munkamenethez nem nyúlunk: a futó harness alatt zárt/aktív állapot
// megkülönböztetése nehéz, ezért a "nemrég írt" könyvtárakat kihagyjuk.
const recentIndex = args.indexOf('--skip-recent');
const skipRecentMinutes = recentIndex >= 0 ? Number(args[recentIndex + 1]) || 30 : 30;
const skipRecentMs = skipRecentMinutes * 60 * 1000;

/**
 * A session-könyvtár legutóbbi írásának ideje (a legfrissebb fájlé).
 * @param {string} dir
 * @returns {number}
 */
function latestWriteMs(dir) {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    try {
      const stat = statSync(join(dir, name));
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch {
      /* eltűnt fájl — nem gond */
    }
  }
  return latest;
}

/**
 * A mag `projectKey()` pontos másolata (`dsh-session-persistence-jsonl:874`).
 * Ha ez eltérne a magétól, a migráció rossz helyre tenne — ezért egyeznie kell.
 * @param {string} cwd
 * @returns {string}
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`;
}

/** @param {string} cwd @returns {string} */
function canonicalCwd(cwd) {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd; // a könyvtár már nem létezik — a fejlécben tárolt úttal számolunk
  }
}

/**
 * Egy session-artefaktum fejléc-sora (az első zstd frame első JSON-sora).
 * @param {string} file
 * @returns {{id?: string, cwd?: string}|null}
 */
function readHeader(file) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return null;
  }
  let text;
  try {
    // A mért fájlok EGYETLEN frame-ből állnak, ezért a teljes dekompresszió a
    // legegyszerűbb; a header az első sor.
    text = zstdDecompressSync(buffer).toString('utf8');
  } catch {
    return null; // sérült vagy ismeretlen formátum — nem nyúlunk hozzá
  }
  const newline = text.indexOf('\n');
  const line = newline >= 0 ? text.slice(0, newline) : text;
  try {
    const parsed = JSON.parse(line);
    return { id: parsed?.id, cwd: parsed?.cwd };
  } catch {
    return null;
  }
}

if (!existsSync(sessionsRoot)) {
  console.error(`nincs session-tár: ${sessionsRoot}`);
  process.exit(2);
}

console.log(`session-tár: ${sessionsRoot}`);
console.log(apply ? 'MÓD: ALKALMAZÁS (mozgat)' : 'MÓD: száraz próba (nem mozgat)');
console.log('');

/** @type {Map<string, Array<{from: string, name: string, cwd: string}>>} */
const groups = new Map();
let unreadable = 0;
let sessionDirs = 0;

for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  const projectPath = join(sessionsRoot, project.name);
  for (const session of readdirSync(projectPath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    sessionDirs += 1;
    const sessionPath = join(projectPath, session.name);
    const artifacts = readdirSync(sessionPath).filter((name) => name.endsWith('.zstd'));
    if (artifacts.length === 0) {
      unreadable += 1;
      continue;
    }
    const header = readHeader(join(sessionPath, artifacts[0]));
    if (header?.cwd === undefined) {
      unreadable += 1;
      continue;
    }
    // LITERÁLIS kulcs: a mag is a fejléc `cwd` szövegéből számol
    // (`generationLogPath(this.root, meta.cwd, …)`, :3251). A `realpath`
    // használata volt a hiba — ezért ez itt szándékosan elmarad.
    const key = projectKey(header.cwd);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ from: sessionPath, name: session.name, cwd: header.cwd, currentProject: project.name, key, latestWrite: latestWriteMs(sessionPath) });
  }
}

console.log(`munkamenet-könyvtár: ${sessionDirs} · fejléc nélkül (kihagyva): ${unreadable}`);
console.log('');

let movable = 0;
let alreadyFine = 0;
let collisions = 0;
let skippedRecent = 0;

for (const [key, entries] of groups) {
  const misplaced = entries.filter((entry) => entry.currentProject !== key);
  if (misplaced.length === 0) {
    alreadyFine += entries.length;
    continue;
  }
  console.log(`cél: ${key}   (${entries.length} munkamenet, ebből áthelyezendő: ${misplaced.length})`);
  const targetDir = join(sessionsRoot, key);
  const fromProjects = new Map();
  for (const entry of misplaced) fromProjects.set(entry.currentProject, (fromProjects.get(entry.currentProject) ?? 0) + 1);
  for (const [project, count] of fromProjects) console.log(`   honnan: ${project}  (${count})`);

  for (const entry of misplaced) {
    const target = join(targetDir, entry.name);
    if (Date.now() - entry.latestWrite < skipRecentMs) {
      console.log(`   AKTÍV (kihagyva, ${Math.round((Date.now() - entry.latestWrite) / 60000)} perce íródott): ${entry.name}`);
      skippedRecent += 1;
      continue;
    }
    if (existsSync(target)) {
      console.log(`   ÜTKÖZÉS (kihagyva): ${entry.name} már létezik a célban`);
      collisions += 1;
      continue;
    }
    movable += 1;
    if (apply) {
      mkdirSync(targetDir, { recursive: true });
      try {
        renameSync(entry.from, target);
        console.log(`   áthelyezve: ${entry.name}`);
      } catch (error) {
        console.log(`   HIBA (${entry.name}): ${String(error.message)}`);
      }
    }
  }
  console.log('');
}

console.log(`összegzés: áthelyezendő ${movable} · helyén van ${alreadyFine} · ütközés ${collisions} · aktív (kihagyva) ${skippedRecent}`);
if (!apply) console.log(`Száraz próba — futtasd --apply-jal, ha a fenti kiírás rendben van (aktív küszöb: ${skipRecentMinutes} perc).`);
process.exit(0);
