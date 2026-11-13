#!/usr/bin/env node
/**
 * canonicalize-session-store.mjs — a párhuzamos session-tárolók ÖSSZEVONÁSA
 * a fejléc átírásával (nem vak mozgatással).
 *
 * WHY: a tároló helyét a mag a fejlécben tárolt `cwd` LITERÁLIS szövegéből
 * számolja, és ellenőrzi is:
 *   dsh-session-persistence-jsonl/lib/index.js:3251
 *     expectedPath = generationLogPath(this.root, meta.cwd, …)
 *   :3255  if (path !== expectedPath && !sameFile(…)) throw "corrupt session log …"
 * Ezért pusztán MOZGATNI tilos (ezt 2026-11-13-án egyszer már elrontottam: a
 * boot elhalt). A helyes művelet a kettő EGYÜTT:
 *   1) a fejléc `cwd` mezőjének átírása a kanonikus (realpath) útra,
 *   2) a munkamenet-könyvtár áthelyezése a kanonikus kulcs alá.
 *
 * A fejléc-frame az első zstd frame, és PONTOSAN egy JSON-sort tartalmaz
 * (`assertZstdHeaderFrame`). Ezért csak az első frame-et fejtjük ki és
 * tömörítjük újra — a többi frame bájtra változatlan marad.
 *
 * FUTTATÁS:
 *   node tools/canonicalize-session-store.mjs                 # száraz próba
 *   node tools/canonicalize-session-store.mjs --apply --limit 3   # pilot
 *   node tools/canonicalize-session-store.mjs --apply          # összes
 *   --skip-recent <perc>   (alapból 30: az aktív munkamenethez nem nyúlunk)
 */
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZSTD_MAGIC = 0xFD2FB528;
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitIndex = args.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) || 0 : 0;
const recentIndex = args.indexOf('--skip-recent');
const skipRecentMinutes = recentIndex >= 0 ? Number(args[recentIndex + 1]) || 30 : 30;
const skipRecentMs = skipRecentMinutes * 60 * 1000;
const rootIndex = args.indexOf('--root');
const sessionsRoot = rootIndex >= 0 ? args[rootIndex + 1] : join(homedir(), '.dsh', 'sessions');

/** A mag `projectKey()` pontos másolata (`:874`). */
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

/** Az első zstd frame vége (a mag `scanZstdFrames` szerkezete). */
function firstFrameEnd(buffer) {
  let offset = 0;
  if (buffer.length < 4) return -1;
  if (buffer.readUInt32LE(0) !== ZSTD_MAGIC) return -1;
  offset = 4;
  if (offset >= buffer.length) return -1;
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  for (;;) {
    if (offset + 3 > buffer.length) return -1;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    offset += blockType === 1 ? 1 : blockSize;
    if (offset > buffer.length) return -1;
    if (lastBlock) break;
  }
  if (checksum) offset += 4;
  return offset <= buffer.length ? offset : -1;
}

/** Egy zstd artefakt fejléc-sora és a cwd-je. */
function readHeaderCwd(file) {
  const buffer = readFileSync(file);
  const end = firstFrameEnd(buffer);
  if (end < 0) return null;
  let text;
  try {
    text = zstdDecompressSync(buffer.subarray(0, end)).toString('utf8');
  } catch {
    return null;
  }
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    return null;
  }
  return typeof parsed?.cwd === 'string' ? { cwd: parsed.cwd, text, end, buffer, file } : null;
}

/** A fejléc átírása: csak az első frame cseréljük, a többi bájt marad. */
function rewriteHeaderCwd(entry, newCwd) {
  const oldJson = JSON.stringify(entry.cwd);
  const newJson = JSON.stringify(newCwd);
  const line = entry.text.slice(0, -1);
  const index = line.indexOf(oldJson);
  if (index < 0) return { ok: false, reason: 'a cwd szövegesen nem található a fejlécben' };
  const rewritten = `${line.slice(0, index)}${newJson}${line.slice(index + oldJson.length)}\n`;
  const frame = zstdCompressSync(Buffer.from(rewritten, 'utf8'), CHECKSUM_OPTIONS);
  const next = Buffer.concat([frame, entry.buffer.subarray(entry.end)]);
  writeFileSync(entry.file, next);
  return { ok: true };
}

/** Kanonikus út: realpath, ha a könyvtár megvan; különben az eredeti. */
function canonicalCwd(cwd) {
  try {
    return realpathSync.native(cwd);
  } catch {
    return null;
  }
}

function latestWriteMs(dir) {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    try {
      const info = statSync(join(dir, name));
      if (info.mtimeMs > latest) latest = info.mtimeMs;
    } catch {
      /* eltűnt fájl */
    }
  }
  return latest;
}

if (!existsSync(sessionsRoot)) {
  console.error(`nincs session-tár: ${sessionsRoot}`);
  process.exit(2);
}

console.log(`session-tár: ${sessionsRoot}`);
console.log(apply ? `MÓD: ALKALMAZÁS${limit > 0 ? ` (limit ${limit})` : ''}` : 'MÓD: száraz próba');

let planned = 0;
let applied = 0;
let skippedActive = 0;
let skippedUnresolvable = 0;
let collisions = 0;
const failures = [];
const perTarget = new Map();

for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue;
  const projectPath = join(sessionsRoot, project.name);
  for (const session of readdirSync(projectPath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const sessionPath = join(projectPath, session.name);
    const artifacts = readdirSync(sessionPath).filter((name) => name.endsWith('.zstd'));
    const header = artifacts.length > 0 ? readHeaderCwd(join(sessionPath, artifacts[0])) : null;
    if (header === null) {
      skippedUnresolvable += 1;
      continue;
    }
    const canonical = canonicalCwd(header.cwd);
    if (canonical === null) {
      skippedUnresolvable += 1;
      continue;
    }
    const targetKey = projectKey(canonical);
    if (targetKey === project.name) continue; // már kanonikus
    if (Date.now() - latestWriteMs(sessionPath) < skipRecentMs) {
      skippedActive += 1;
      continue;
    }
    if (limit > 0 && planned >= limit) break;

    planned += 1;
    perTarget.set(targetKey, (perTarget.get(targetKey) ?? 0) + 1);
    const targetDir = join(sessionsRoot, targetKey);
    const target = join(targetDir, session.name);
    if (existsSync(target)) {
      collisions += 1;
      failures.push({ session: session.name, reason: 'ütközés: a cél már létezik' });
      continue;
    }

    if (!apply) continue;

    // MÉRT HIBA (2026-11-13): az első változat ELŐBB írta át a fejlécet, és csak
    // utána nevezte át a mappát. Ha az átnevezés EPERM-mel bukott (a futó
    // harness nyitva tartja a munkamenetet), a fejléc már `D:\…` volt, a mappa
    // viszont `--C-…--` alatt maradt → inkonzisztens, „corrupt log". Négy
    // munkamenetet érintett. Most: előbb a fejléc-átírást VÉGREHAJTJUK, de
    // elmentjük az eredeti bájtokat, és áthelyezési hiba esetén VISSZAÁLLÍTJUK.
    const originals = [];
    let rewriteError = null;
    for (const name of artifacts) {
      const file = join(sessionPath, name);
      const entry = readHeaderCwd(file);
      if (entry === null) continue;
      originals.push({ file, buffer: entry.buffer });
      const result = rewriteHeaderCwd(entry, canonical);
      if (!result.ok) rewriteError = `${name}: ${result.reason}`;
    }
    if (rewriteError !== null) {
      for (const saved of originals) writeFileSync(saved.file, saved.buffer);
      failures.push({ session: session.name, reason: rewriteError });
      continue;
    }

    // 2) áthelyezés a kanonikus kulcs alá
    try {
      mkdirSync(targetDir, { recursive: true });
      renameSync(sessionPath, target);
    } catch (error) {
      // Visszaállítás: a fejléc maradjon a régi (C: alakú), különben a napló
      // „corrupt"-tá válik és a harness nem indul el.
      for (const saved of originals) {
        try {
          writeFileSync(saved.file, saved.buffer);
        } catch {
          /* ha ez sem megy, a mentésből lehet helyreállítani */
        }
      }
      failures.push({ session: session.name, reason: `áthelyezés: ${error.message} (fejléc visszaállítva)` });
      continue;
    }

    // 3) önellenőrzés: a fejlécből számolt kulcs == a tényleges mappa
    const check = readHeaderCwd(join(target, artifacts[0]));
    if (check === null || projectKey(check.cwd) !== targetKey) {
      failures.push({ session: session.name, reason: 'önellenőrzés: a fejléc és a hely nem egyezik' });
      continue;
    }
    applied += 1;
  }
}

console.log('');
for (const [key, count] of perTarget) console.log(`  → ${key}: ${count} munkamenet`);
console.log('');
console.log(`tervezett: ${planned} · alkalmazott: ${applied} · aktív (kihagyva): ${skippedActive} · feloldhatatlan: ${skippedUnresolvable} · ütközés: ${collisions}`);
if (failures.length > 0) {
  console.log(`hibák (${failures.length}):`);
  for (const failure of failures.slice(0, 10)) console.log(`  ${failure.session}: ${failure.reason}`);
}
if (!apply) console.log('Száraz próba — semmit nem írtam és nem mozgattam.');
process.exit(failures.length > 0 ? 1 : 0);
