#!/usr/bin/env node
/**
 * Diagnosztikai folt a DSH tömörítés (dsh-compaction-basic) mérésére.
 *
 * MIÉRT: mérve (40 session, 57 compaction esemény) a "szelíd" (küszöb-alapú)
 * tömörítés SOHA nem fut le — minden tömörítés a plafonnál (792 576 token,
 * CONTEXT_WINDOW_EXCEEDED) történik, akármi a thresholdRatio (0.30 / 0.45 /
 * 0.80).  A kód szerint a döntés a `compactIfNeeded()`-ben születik:
 *     measurement.totalTokens < spec.thresholdTokens  ->  return null
 * tehát vagy a MÉRÉS kicsi, vagy a hívás dob (a hibát a plugin csak
 * `logger.warn`-nal nyeli el, a harness stderr-je pedig nincs mentve).
 *
 * EZ A FOLT: minden lépésnél egy sort ír a `~/.dsh/compaction-diag.log`-ba
 * (mért token, küszöb, ablak, arány), és a kivétel szövegét is rögzíti.
 * A DSH viselkedését NEM változtatja — csak naplóz.
 *
 * Használat:
 *   node tools\patch-compaction-diag.mjs --check    # állapot (nem ír)
 *   node tools\patch-compaction-diag.mjs --apply    # folt + .bak mentés
 *   node tools\patch-compaction-diag.mjs --revert   # visszaállítás a .bak-ból
 *
 * Érvénybe lépés: a harness KÖVETKEZŐ indulásakor (§1.5: futó munka közben
 * tilos újraindítani).  DSH-frissítés után újra kell futtatni (a csomag
 * felülíródik) — ugyanaz a minta, mint a tools\patch-sandbox-no-window.ps1-nál.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TARGET = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'npm-cache', '_npx', 'b86ed90107c62dab', 'node_modules', '@deepseek-ai',
  'dsh-compaction-basic', 'lib', 'index.js',
);

const MARK = '/* dsh-compaction-diag:patch */';
const ANCHOR_IMPORT = 'import { CompactionEngine, CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";';

const DIAG_BLOCK = `${MARK}
let __diagLast = 0;
function __diag(line) {
	try {
		const now = Date.now();
		if (now - __diagLast < 900) return;
		__diagLast = now;
		appendFileSync(join(homedir(), ".dsh", "compaction-diag.log"), \`\${new Date(now).toISOString()} \${line}\\n\`);
	} catch {}
}`;

const ANCHOR_GATE = `\t\tconst spec = resolveCompactSpec(policy, context.contextWindow);
\t\tif (measurement.totalTokens < spec.thresholdTokens) return null;`;
const PATCHED_GATE = `\t\tconst spec = resolveCompactSpec(policy, context.contextWindow);
\t\t__diag(\`pressure measure=\${measurement.totalTokens} threshold=\${spec.thresholdTokens} window=\${context.contextWindow} ratio=\${spec.thresholdRatio} retain=\${spec.retainTokens} target=\${target.provider}/\${target.model}\`);
\t\tif (measurement.totalTokens < spec.thresholdTokens) return null;`;

const ANCHOR_CATCH = `\t\t\t\tconst message = error instanceof Error ? error.message : String(error);
\t\t\t\tctx.logger.warn(\`step compaction failed: \${message}; continuing the turn\`);`;
const PATCHED_CATCH = `\t\t\t\tconst message = error instanceof Error ? error.message : String(error);
\t\t\t\t__diag(\`pressure FAILED: \${message}\`);
\t\t\t\tctx.logger.warn(\`step compaction failed: \${message}; continuing the turn\`);`;

const ANCHOR_NO_TARGET = `\t\tconst target = routedTarget(agent.session);
\t\tif (target === void 0) return null;`;
const PATCHED_NO_TARGET = `\t\tconst target = routedTarget(agent.session);
\t\tif (target === void 0) {
\t\t\t__diag("pressure skipped: no routed target");
\t\t\treturn null;
\t\t}`;

function read() {
  if (!existsSync(TARGET)) {
    console.error(`HIBA: nincs ilyen fájl: ${TARGET}`);
    process.exit(2);
  }
  return readFileSync(TARGET, 'utf8');
}

function status(text) {
  const patched = text.includes(MARK);
  const gate = text.includes('__diag(`pressure measure=');
  const katch = text.includes('__diag(`pressure FAILED');
  const target = text.includes('__diag("pressure skipped: no routed target")');
  return { patched, gate, katch, target };
}

function apply() {
  let text = read();
  const st = status(text);
  if (st.patched) {
    console.log('már foltozott — nincs teendő');
    return;
  }
  for (const [name, anchor] of [['import', ANCHOR_IMPORT], ['gate', ANCHOR_GATE], ['catch', ANCHOR_CATCH], ['target', ANCHOR_NO_TARGET]]) {
    if (!text.includes(anchor)) {
      console.error(`HIBA: nem találom az illesztési pontot (${name}). A DSH verzió eltér — a folt nem alkalmazható.`);
      process.exit(3);
    }
  }
  copyFileSync(TARGET, `${TARGET}.diag-bak`);
  // 1) import + helper a fájl elejére (az első import után)
  text = text.replace(ANCHOR_IMPORT, `${ANCHOR_IMPORT}\nimport { appendFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { homedir } from "node:os";\n${DIAG_BLOCK}`);
  // 2) kapu-mérés
  text = text.replace(ANCHOR_GATE, PATCHED_GATE);
  // 3) hiba-rögzítés
  text = text.replace(ANCHOR_CATCH, PATCHED_CATCH);
  // 4) cél nélküli kihagyás
  text = text.replace(ANCHOR_NO_TARGET, PATCHED_NO_TARGET);
  writeFileSync(TARGET, text);
  const after = status(read());
  console.log(`folt alkalmazva: ${TARGET}`);
  console.log(`  helper=${after.patched} gate=${after.gate} catch=${after.katch}`);
  console.log(`  mentés: ${TARGET}.diag-bak`);
  console.log('  érvénybe lépés: a harness következő indulásakor; napló: ~/.dsh/compaction-diag.log');
}

function revert() {
  const bak = `${TARGET}.diag-bak`;
  if (!existsSync(bak)) {
    console.error(`HIBA: nincs mentés (${bak}) — a --apply még nem futott?`);
    process.exit(4);
  }
  copyFileSync(bak, TARGET);
  console.log(`visszaállítva a mentésből: ${TARGET}`);
}

function check() {
  const text = read();
  const st = status(text);
  console.log(`cél: ${TARGET}`);
  console.log(`  folt: ${st.patched ? 'IGEN' : 'nem'}  kapu-mérés: ${st.gate ? 'IGEN' : 'nem'}  hiba-napló: ${st.katch ? 'IGEN' : 'nem'}`);
  const log = join(homedir(), '.dsh', 'compaction-diag.log');
  console.log(`  napló: ${log} (${existsSync(log) ? `${(readFileSync(log).length / 1024).toFixed(1)} KB` : 'még nincs'})`);
  process.exit(st.patched && st.gate && st.katch ? 0 : 1);
}

const arg = process.argv[2] ?? '--check';
if (arg === '--apply') apply();
else if (arg === '--revert') revert();
else if (arg === '--check') check();
else {
  console.error('használat: node tools\\patch-compaction-diag.mjs [--check|--apply|--revert]');
  process.exit(2);
}
