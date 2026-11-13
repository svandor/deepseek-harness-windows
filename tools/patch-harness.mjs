#!/usr/bin/env node
/**
 * patch-harness.mjs — újraalkalmazható javításréteg a DSH magjára.
 *
 * WHY: a DSH magja nem ebben a repóban van, hanem kiadott npm-csomagokként
 * (`%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\...`). A
 * futó kódot nem lehet „a repóból telepíteni", ezért a mag-javításokat itt
 * tartjuk nyilván, és ez a szkript alkalmazza őket a telepített csomagokra —
 * verzióhoz kötött, pontos szövegellenőrzéssel.
 *
 * MIÉRT VERZIÓHOZ KÖTÖTT: a mag `lib/index.js`-ei olvasható, de fordított
 * JS-ek. Egy „vakon" ráhúzott csere egy frissítés után csendben elronthatja a
 * bootot. Ezért minden patch megadja a keresett pontos szöveget: ha az nem
 * található meg 1:1-ben, a patch **nem alkalmazódik**, hanem jelzi, hogy a mag
 * változott. Alkalmazás előtt `.process-guard-orig` mentés készül, és a
 * beszúrt kód jelölést kap (idempotencia).
 *
 * FONTOS TANULSÁG (2026-11-13): az első változat egy külön horgonyra szúrta be
 * a segédfüggvényt, de az a class testén BELÜL volt, ezért a fájl
 * szintaktikailag érvénytelen lett (`node --check` elkapta, a boot előtt).
 * Ezért minden patch **egyetlen összefüggő cserét** végez, és alkalmazás után
 * kötelező a `node --check`.
 *
 * HASZNÁLAT:
 *   node tools/patch-harness.mjs --list
 *   node tools/patch-harness.mjs --check
 *   node tools/patch-harness.mjs --apply                # csak 'ready' patchek
 *   node tools/patch-harness.mjs --apply --include-staged
 *   node tools/patch-harness.mjs --revert
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A patch jelölője a befecskendezett kódban (idempotencia + visszakeresés). */
const MARKER = '/* dsh-process-guard-patch';

/**
 * A nyilvántartott patchek.
 *
 * `status`: 'ready' = alkalmazható, 'staged' = további mérés kell előtte.
 */
const PATCHES = [
  {
    id: 'zstd-header-single-read',
    package: '@deepseek-ai/dsh-session-persistence-jsonl',
    file: 'lib/index.js',
    title: 'Session-header: egy olvasás + egy összefűzés a 8 KiB-onkénti újramásolás helyett',
    why:
      'A readFirstZstdLine() 8 KiB-onként olvas, és MINDEN iterációban Buffer.concat-tal újramásolja a ' +
      'teljes eddigi tartalmat, majd újra végigscaneli. Ez O(n²): mért adat (tools/measure-header-read.mjs), ' +
      'a 3 legnagyobb session-log 17 594,7 MB-ot másolt a régi úton, 28,5 MB helyett (617×), 2571 ms helyett ' +
      '3,9 ms egy 11 MB-os fájlra. Ez adja a mért 1,2 → 3,0 → 6,7 GB-os commit-csúcsot és a ' +
      'ZSTD_error_memory_allocation-t, amit a 3150. sor tévesen "corrupt log"-ként címkéz. A csere ' +
      'bájtazonos scan-bemenetet állít elő (mérve: bytesMatch=true), ezért az eredmény ugyanaz.',
    status: 'ready',
    find: `\tasync readFirstZstdLine(path, signal) {
\t\tsignal?.throwIfAborted();
\t\tconst handle = await open(path, "r");
\t\ttry {
\t\t\tsignal?.throwIfAborted();
\t\t\tlet content = Buffer.alloc(0);
\t\t\tconst chunk = Buffer.alloc(8192);
\t\t\tfor (;;) {
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tconst { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tif (bytesRead === 0) return void 0;
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tcontent = Buffer.concat([content, chunk.subarray(0, bytesRead)]);
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tconst first = scanZstdFrames(content, 1).frames[0];
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tif (first === void 0) continue;
\t\t\t\tlet plaintext;
\t\t\t\ttry {
\t\t\t\t\tsignal?.throwIfAborted();
\t\t\t\t\tplaintext = await decompressZstdFrame(content.subarray(first.start, first.end));
\t\t\t\t} catch (error) {
\t\t\t\t\t/* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
\t\t\t\t\tif (signal?.aborted) signal.throwIfAborted();
\t\t\t\t\tthrow new Error("corrupt Zstandard session log: header frame failed validation", { cause: error });
\t\t\t\t}
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tassertZstdHeaderFrame(plaintext);
\t\t\t\treturn plaintext.subarray(0, -1).toString("utf8");
\t\t\t}
\t\t} finally {
\t\t\tawait handle.close();
\t\t}
\t}`,
    replace: `\tasync readFirstZstdLine(path, signal) {
\t\tsignal?.throwIfAborted();
\t\tconst handle = await open(path, "r");
\t\t/* dsh-process-guard-patch: zstd-header-single-read
\t\t * A scan bemenetét egyetlen olvasással állítjuk elő: a mért session-logok
\t\t * (max ~11,5 MB) így egy allokációból jönnek létre, a korábbi út 8 KiB-onként
\t\t * újramásolta a teljes eddigi tartalmat (O(n²), mért 617× több másolás).
\t\t * Kirívóan nagy fájlra (>64 MiB) az eredeti, darabolt út marad. */
\t\tasync function readHeaderBytes(file, size, innerSignal) {
\t\t\tconst SINGLE_READ_MAX = 67108864;
\t\t\tif (!(size > 0 && size <= SINGLE_READ_MAX)) {
\t\t\t\tlet content = Buffer.alloc(0);
\t\t\t\tconst chunk = Buffer.alloc(8192);
\t\t\t\tfor (;;) {
\t\t\t\t\tinnerSignal?.throwIfAborted();
\t\t\t\t\tconst { bytesRead } = await file.read(chunk, 0, chunk.length, null);
\t\t\t\t\tinnerSignal?.throwIfAborted();
\t\t\t\t\tif (bytesRead === 0) return content.length === 0 ? void 0 : content;
\t\t\t\t\tcontent = Buffer.concat([content, chunk.subarray(0, bytesRead)]);
\t\t\t\t\tinnerSignal?.throwIfAborted();
\t\t\t\t\tif (scanZstdFrames(content, 1).frames[0] !== void 0) return content;
\t\t\t\t}
\t\t\t}
\t\t\tconst content = Buffer.allocUnsafe(size);
\t\t\tlet read = 0;
\t\t\twhile (read < size) {
\t\t\t\tinnerSignal?.throwIfAborted();
\t\t\t\tconst { bytesRead } = await file.read(content, read, size - read, null);
\t\t\t\tinnerSignal?.throwIfAborted();
\t\t\t\tif (bytesRead === 0) break;
\t\t\t\tread += bytesRead;
\t\t\t}
\t\t\tif (read === 0) return void 0;
\t\t\treturn read === size ? content : content.subarray(0, read);
\t\t}
\t\ttry {
\t\t\tsignal?.throwIfAborted();
\t\t\tconst { size } = await handle.stat();
\t\t\tconst content = await readHeaderBytes(handle, size, signal);
\t\t\tsignal?.throwIfAborted();
\t\t\tif (content === void 0) return void 0;
\t\t\tconst first = scanZstdFrames(content, 1).frames[0];
\t\t\tsignal?.throwIfAborted();
\t\t\tif (first === void 0) return void 0;
\t\t\tlet plaintext;
\t\t\ttry {
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tplaintext = await decompressZstdFrame(content.subarray(first.start, first.end));
\t\t\t} catch (error) {
\t\t\t\tif (signal?.aborted) signal.throwIfAborted();
\t\t\t\tconst message = String(error?.message ?? error);
\t\t\t\tif (/memory_allocation|ENOMEM|out of memory/iu.test(message)) {
\t\t\t\t\tthrow new Error(\`session header read ran out of memory (not a corrupt log): \${message}\`, { cause: error });
\t\t\t\t}
\t\t\t\tthrow new Error("corrupt Zstandard session log: header frame failed validation", { cause: error });
\t\t\t}
\t\t\tsignal?.throwIfAborted();
\t\t\tassertZstdHeaderFrame(plaintext);
\t\t\treturn plaintext.subarray(0, -1).toString("utf8");
\t\t} finally {
\t\t\tawait handle.close();
\t\t}
\t}`,
  },
];

/**
 * A telepített harness `@deepseek-ai` gyökere.
 * @returns {string}
 */
function findPackagesRoot() {
  const explicit = process.env.DSH_PACKAGES_ROOT?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  const npx = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx');
  if (!existsSync(npx)) throw new Error(`nem találom az npx cache-t: ${npx}`);
  const candidates = [];
  for (const entry of readdirSync(npx, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = join(npx, entry.name, 'node_modules', '@deepseek-ai');
    if (!existsSync(join(root, 'dsh'))) continue;
    candidates.push({ root, at: statSync(join(npx, entry.name)).mtimeMs });
  }
  if (candidates.length === 0) throw new Error('egyetlen @deepseek-ai telepítés sincs az npx cache-ben');
  candidates.sort((left, right) => right.at - left.at);
  return candidates[0].root;
}

/** @param {string} path @returns {string} */
function shortHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

/** @param {object} patch @param {string} root @returns {string} */
function resolveTarget(patch, root) {
  return join(root, patch.package.replace('@deepseek-ai/', ''), patch.file.replaceAll('/', '\\'));
}

/**
 * @param {object} patch
 * @param {string} root
 * @returns {{state: string, target: string, text?: string}}
 */
function stateOf(patch, root) {
  const target = resolveTarget(patch, root);
  if (!existsSync(target)) return { state: 'missing', target };
  const text = readFileSync(target, 'utf8');
  if (text.includes(`${MARKER}: ${patch.id}`)) return { state: 'applied', target, text };
  if (text.includes(patch.find)) return { state: 'applicable', target, text };
  return { state: 'mismatch', target, text };
}

const args = process.argv.slice(2);
const mode = args.find((arg) => arg.startsWith('--') && arg !== '--include-staged') ?? '--check';
const includeStaged = args.includes('--include-staged');
const packagesRoot = findPackagesRoot();

if (mode === '--list') {
  console.log(`@deepseek-ai gyökér: ${packagesRoot}`);
  for (const patch of PATCHES) {
    const { state } = stateOf(patch, packagesRoot);
    console.log(`\n[${patch.status}] ${patch.id} — ${patch.title}\n  állapot: ${state}\n  miért: ${patch.why}`);
  }
  process.exit(0);
}

if (!['--check', '--apply', '--revert'].includes(mode)) {
  console.error(`ismeretlen mód: ${mode} (--list | --check | --apply | --revert)`);
  process.exit(2);
}

let failures = 0;
for (const patch of PATCHES) {
  const { state, target, text } = stateOf(patch, packagesRoot);
  console.log(`${patch.id}: ${state}`);

  if (mode === '--check') {
    if (state === 'mismatch') {
      console.log('  FIGYELEM: a mag szövege megváltozott — ez a patch nem alkalmazható (nem is fog).');
      failures += 1;
    }
    if (state === 'applicable' && patch.status === 'staged' && !includeStaged) {
      console.log('  STAGED: mérés kell az alkalmazás előtt (--include-staged a kényszerítéshez).');
    }
    continue;
  }

  if (mode === '--revert') {
    const backup = `${target}.process-guard-orig`;
    if (!existsSync(backup)) {
      console.log('  nincs mentés — nincs mit visszaállítani');
      continue;
    }
    copyFileSync(backup, target);
    console.log(`  visszaállítva: ${target} (${shortHash(target)})`);
    continue;
  }

  if (state === 'applied') {
    console.log('  már alkalmazott');
    continue;
  }
  if (state !== 'applicable') {
    console.log(`  NEM alkalmazható (${state}) — kihagyva`);
    failures += 1;
    continue;
  }
  if (patch.status === 'staged' && !includeStaged) {
    console.log('  STAGED: mérés kell az alkalmazás előtt — kihagyva');
    continue;
  }

  const backup = `${target}.process-guard-orig`;
  if (!existsSync(backup)) copyFileSync(target, backup);
  // Egyetlen, összefüggő csere: nincs külön beszúrási pont (lásd a fejlécet).
  const next = text.replace(patch.find, patch.replace);
  writeFileSync(target, next, 'utf8');
  console.log(`  alkalmazva: ${target}\n    mentés: ${backup}\n    új hash: ${shortHash(target)}`);
}

process.exit(failures > 0 ? 1 : 0);
