/**
 * replay-rule-guard.mjs — valós DSH session-naplók újrajátszása a
 * dsh-rule-guard szabálymotorja ellen.
 *
 * MIÉRT: a szabályok szigorítása után látni kell, hogy a kapu a MEGTÖRTÉNT
 * szabálysértéseket megfogja-e, és mennyi téves riasztást okoz. A session-napló
 * tömörített (`session.v3.jsonl.zstd`, több zstd frame), ezért itt egy
 * frame-bontó dekóder van (a DSH maga is frame-enként dekódol).
 *
 * Használat:
 *   node tools/replay-rule-guard.mjs "<session.v3.jsonl.zstd>" [további fájlok…]
 *   node tools/replay-rule-guard.mjs --verbose "<fájl>"   # minden blokk sora
 *
 * Kilépés: 0 = lefutott (a blokkok száma nem hiba), 1 = hiba.
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluatePre, loadPolicy } from '../plugins/dsh-rule-guard/lib/policy.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const POLICY = join(REPO, 'plugins', 'dsh-rule-guard', 'policy.json');

const ZSTD_MAGIC = 0xfd2fb528;

/** A concatenated zstd frame-ek határai (fejléc + blokkok + opcionális checksum). */
export function zstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`érvénytelen zstd frame magic a ${offset}. bájtnál`);
    const start = offset;
    offset += 4;
    const descriptor = buffer[offset++];
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1;
    const dictionaryFlag = descriptor & 3;
    if (!singleSegment) offset += 1;
    offset += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4;
    offset += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
    for (;;) {
      const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
      offset += 3;
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      offset += type === 0 ? size : type === 1 ? 1 : type === 2 ? size : (() => { throw new Error('reserved zstd block'); })();
      if (last) break;
    }
    if (checksum) offset += 4;
    frames.push([start, offset]);
  }
  return frames;
}

/** Egy session-log teljes szövege (minden frame dekódolva). */
export function decodeSessionLog(file) {
  const buffer = readFileSync(file);
  return zstdFrames(buffer).map(([start, end]) => zstdDecompressSync(buffer.subarray(start, end))).join('');
}

/**
 * Egy session-napló újrajátszása.
 * @returns {{cwd: string, calls: number, denials: Array<object>}}
 */
export function replay(policy, file, { verbose = false } = {}) {
  const lines = decodeSessionLog(file).split('\n').filter(Boolean);
  let cwd = '';
  let calls = 0;
  const denials = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'session') { cwd = event.cwd ?? ''; continue; }
    if (event.type !== 'tool/call') continue;
    let args = event.data?.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    calls += 1;
    const decision = evaluatePre(policy, { name: event.data?.name, arguments: args, agent: { session: { header: { cwd } } } });
    if (decision === undefined) continue;
    const reason = decision.reason;
    denials.push({
      time: new Date(event.time).toISOString(),
      tool: event.data?.name,
      rule: decision.rule,
      workspace: decision.workspace,
      file: args?.file_path ?? '',
      line: (reason.split('Érintett sor:')[1] ?? '').split('\n\n')[0]?.trim().slice(0, 200) ?? ''
    });
    if (verbose) console.log(`  [${new Date(event.time).toISOString()}] ${event.data?.name} → ${decision.rule} (${decision.workspace})`);
  }
  return { cwd, calls, denials };
}

// --- CLI -----------------------------------------------------------------------
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const verbose = process.argv.includes('--verbose');
  if (files.length === 0) {
    console.error('használat: node tools/replay-rule-guard.mjs [--verbose] <session.v3.jsonl.zstd> […]');
    process.exit(1);
  }
  const policy = loadPolicy(POLICY);
  if (policy === undefined) {
    console.error(`HIBA: a policy nem tölthető be: ${POLICY}`);
    process.exit(1);
  }
  let totalCalls = 0;
  let totalDenials = 0;
  for (const file of files) {
    try {
      const result = replay(policy, file, { verbose });
      totalCalls += result.calls;
      totalDenials += result.denials.length;
      console.log(`\n${file}\n  cwd=${result.cwd || '?'}  hívás=${result.calls}  blokk=${result.denials.length}`);
      for (const denial of result.denials) {
        console.log(`  - ${denial.time}  ${denial.tool}  ${denial.rule}  ${denial.file || denial.line}`);
      }
    } catch (error) {
      console.error(`HIBA (${file}): ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nÖSSZESEN: ${totalCalls} tool-hívás, ${totalDenials} blokk (${POLICY})`);
}
