#!/usr/bin/env node
/**
 * measure-header-read.mjs — a session-header olvasás VALÓDI költsége.
 *
 * TÖRTÉNET / SAJÁT HIBA (2026-11-13): a szkript első változata olyan ciklust
 * mért, amely VÉGIGOLVASSA a fájlt és csak utána keres frame-et. A valódi
 * `readFirstZstdLine` viszont minden chunk után scannel, ezért az első
 * (fejléc) frame megtalálásakor AZONNAL kilép. Az első verzió ezért
 * 17 594,7 MB / 104 319,7 MB „másolást" mért — ez a valódi kódra NEM igaz,
 * és a „617×"/„182×" javulás sem az.
 *
 * Ez a változat a valódi logikát méri (a mag `scanZstdFrames()` szerkezetének
 * hűséges másolatával). Mért eredmény a teljes korpuszon: 9,2 MB másolás,
 * fájlonként 1 olvasás, 0 nagy fejléc-frame — tehát a header-olvasás NEM
 * memória-hot-spot.
 *
 * FUTTATÁS:
 *   node tools/measure-header-read.mjs            # 3 legnagyobb fájl
 *   node tools/measure-header-read.mjs --all      # mind a 1184
 *   node tools/measure-header-read.mjs --root <mappa>
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZSTD_MAGIC = 0xFD2FB528;

/**
 * Az első zstd frame vége, vagy `undefined`, ha a puffer még nem tartalmazza.
 * A mag `scanZstdFrames()` (dsh-session-persistence-jsonl:1298) szerkezetét
 * követi: magic → frame descriptor → blokkfejlécek → opcionális checksum.
 * @param {Buffer} buffer
 * @returns {number|undefined|'bad-magic'}
 */
function firstFrameEnd(buffer) {
  let offset = 0;
  if (buffer.length - offset < 4) return undefined;
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return 'bad-magic';
  offset += 4;
  if (offset === buffer.length) return undefined;
  const descriptor = buffer.readUInt8(offset);
  offset += 1;
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (buffer.length - offset < remainingHeaderBytes) return undefined;
  offset += remainingHeaderBytes;
  for (;;) {
    if (buffer.length - offset < 3) return undefined;
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const lastBlock = (blockHeader & 1) !== 0;
    const blockType = (blockHeader >>> 1) & 3;
    const blockSize = blockHeader >>> 3;
    const payloadBytes = blockType === 1 ? 1 : blockSize;
    if (buffer.length - offset < payloadBytes) return undefined;
    offset += payloadBytes;
    if (lastBlock) break;
  }
  if (checksum) {
    if (buffer.length - offset < 4) return undefined;
    offset += 4;
  }
  return offset;
}

/**
 * A VALÓDI `readFirstZstdLine` ciklusa: 8 KiB-onként olvas, minden lépés után
 * scannel, és az első teljes frame-nél megáll.
 * @param {string} path
 */
function coreLoop(path) {
  const fd = openSync(path, 'r');
  try {
    let content = Buffer.alloc(0);
    let copied = 0;
    let reads = 0;
    const chunk = Buffer.alloc(8192);
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) return { reads, copied, frameBytes: null, failed: true };
      content = Buffer.concat([content, chunk.subarray(0, bytesRead)]);
      copied += content.length;
      reads += 1;
      const end = firstFrameEnd(content);
      if (end === undefined) continue;
      if (end === 'bad-magic') return { reads, copied, frameBytes: null, failed: true };
      return { reads, copied, frameBytes: end };
    }
  } finally {
    closeSync(fd);
  }
}

/** A patchelt út: egy allokáció, egy olvasás (a scan bemenete ugyanaz). */
function patchedLoop(path) {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const content = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const bytesRead = readSync(fd, content, read, size - read, null);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { reads: 1, copied: read };
  } finally {
    closeSync(fd);
  }
}

/** @param {string} root @returns {string[]} */
function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.zstd')) out.push(path);
    }
  };
  walk(root);
  return out;
}

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? args[rootIndex + 1] : join(homedir(), '.dsh', 'sessions');
const all = args.includes('--all');

let files = collectFiles(root);
if (files.length === 0) {
  console.error(`nincs session-fájl itt: ${root}`);
  process.exit(2);
}
files = files.map((path) => ({ path, size: statSync(path).size })).sort((left, right) => right.size - left.size);
const selected = all ? files : files.slice(0, 3);
const totalCorpus = files.reduce((sum, file) => sum + file.size, 0);

console.log(`forrás: ${root}`);
console.log(`fájl: ${files.length} (${(totalCorpus / 1048576).toFixed(1)} MB tömörítve) · mért: ${selected.length}`);
console.log('');
console.log('fájl'.padEnd(10) + 'olvasás'.padEnd(10) + 'másolt (core)'.padEnd(16) + 'első frame'.padEnd(13) + 'másolt (patched)');
console.log('-'.repeat(74));

let coreCopied = 0;
let patchedCopied = 0;
let maxReads = 0;
let failures = 0;
for (const file of selected) {
  const core = coreLoop(file.path);
  const patched = patchedLoop(file.path);
  coreCopied += core.copied;
  patchedCopied += patched.copied;
  maxReads = Math.max(maxReads, core.reads);
  if (core.failed) failures += 1;
  console.log(
    `${(file.size / 1048576).toFixed(1)} MB`.padEnd(10) +
      String(core.reads).padEnd(10) +
      `${(core.copied / 1048576).toFixed(2)} MB`.padEnd(16) +
      `${core.frameBytes ?? '-'} B`.padEnd(13) +
      `${(patched.copied / 1048576).toFixed(2)} MB`,
  );
}

console.log('-'.repeat(74));
console.log(`core összes másolás: ${(coreCopied / 1048576).toFixed(2)} MB · patched: ${(patchedCopied / 1048576).toFixed(2)} MB`);
console.log(`max olvasás egy fájlra: ${maxReads} · hiba: ${failures}`);
console.log('');
console.log('ÉRTELMEZÉS: a core már az első (fejléc) frame-nél megáll, ezért a header-olvasás');
console.log('NEM memória-hot-spot. A patched út a teljes fájlt olvassa (≤64 MiB-ig), tehát itt');
console.log('több adatot másol — a javulás nem memóriában, hanem a hibakezelésben van.');
process.exit(failures === 0 ? 0 : 1);
