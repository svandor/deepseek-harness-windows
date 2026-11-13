#!/usr/bin/env node
/**
 * A dsh-process-guard plugin önálló tesztje — a DSH nélkül.
 *
 * WHY: a plugin a boot gráfban fut, ezért egy hiba ott a teljes felületet
 * viszi el. Ez a teszt hamis `ctx`-szel hívja meg az `apply()`-t, és ellenőrzi
 * a ledger körjáratot (írás → visszajátszás → reconciláció), valamint azt,
 * hogy a plugin SOSEM dob kivételt (a bootot nem állíthatja meg).
 *
 * FUTTATÁS:  node plugins/dsh-process-guard/test/plugin.test.mjs
 * Kilépés: 0 = minden állítás teljesült, 1 = hiba.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
/** @param {boolean} condition @param {string} label */
function check(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures += 1;
  }
}

// A ledger helyét a DSH home-ból számolja — teszt alatt ideiglenes mappára állítjuk.
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-guard-test-'));
process.env.DSH_HOME = fakeHome;

const ledger = await import('../lib/ledger.js');
const plugin = await import('../lib/index.js');

console.log(`[1] ledger körjárat (${fakeHome})`);
const workspace = ledger.canonicalWorkspace(process.cwd());
check(typeof workspace === 'string' && workspace.length > 0, 'a canonicalWorkspace ad utat');
check(ledger.workspaceKey(workspace).length === 64, 'a workspace-kulcs sha256 hex (64)');
check(ledger.workspaceKey(workspace) === ledger.workspaceKey(workspace), 'a kulcs determinisztikus');
check(ledger.workspaceKey(workspace) !== ledger.workspaceKey('/some/other/place'), 'külön workspace = külön kulcs');

const file = ledger.ledgerFileFor(workspace);
check(file.startsWith(join(fakeHome, 'process-ledger')), 'a ledger a DSH home alatt van');

// Élő folyamat: maga a teszt-Node (a saját PID-ünk biztosan él).
const livePid = process.pid;
ledger.appendRecord(file, { t: 'spawn', pid: livePid, at: Date.now(), cmdline: 'node plugin.test.mjs', cwd: process.cwd(), workspaceRealpath: workspace, kind: 'spawn' });
ledger.appendRecord(file, { t: 'spawn', pid: 999_999, at: Date.now(), cmdline: 'halott folyamat', cwd: process.cwd(), workspaceRealpath: workspace, kind: 'spawn' });
ledger.appendRecord(file, { t: 'exit', pid: 999_998, at: Date.now(), reason: 'exited' });

const replayed = ledger.replayLedger(file);
check(replayed.get(livePid)?.t === 'spawn', 'a spawn rekord visszajátszható');
check(replayed.get(999_999)?.cmdline === 'halott folyamat', 'a rekord mezői megmaradnak');
check(replayed.get(999_998)?.t === 'exit', 'a tombstone megmarad');

const all = ledger.readAllLedgers();
check(all.length === 1 && all[0].records.size === 3, 'readAllLedgers a fájlt rekordokkal adja vissza');

console.log('[2] apply() hamis ctx-szel (boot-biztonság)');
const settled = [];
const store = new Map();
const fakeCtx = {
  logger: { info: () => {}, warn: () => {} },
  on: () => {},
  subprocess: {
    spawn: () => ({ done: Promise.resolve({ status: 'completed' }) }),
    spawnTerminal: async () => ({ pid: livePid, done: Promise.resolve({ status: 'completed' }) }),
  },
  jobs: {
    store,
    notifyChanged: () => {},
    settle: (job, outcome) => {
      job.status = outcome.status;
      job.detail = outcome.detail;
      settled.push(job.id);
    },
  },
};

let threw = false;
try {
  plugin.apply(fakeCtx, { reconcileDelayMs: 5 });
} catch {
  threw = true;
}
check(!threw, 'az apply() nem dob');
check(Array.isArray(plugin.inject) && plugin.inject.includes('jobs'), 'inject tartalmazza a jobs szolgáltatást');
check(typeof plugin.apply === 'function', 'az apply exportált');

// A spawn befogása: a ledgernek rekordot kell kapnia a spawn hívás után.
const before = ledger.replayLedger(file).size;
fakeCtx.subprocess.spawn({ argv: ['node', '-v'], cwd: process.cwd() });
check(ledger.replayLedger(file).size >= before, 'a spawn hívás után a ledger íródik');

// Hiányos ctx: nem szabad dobni (a bootot nem akaszthatja meg).
let threwBroken = false;
try {
  plugin.apply({ logger: {}, subprocess: undefined, jobs: undefined }, { reconcileDelayMs: 1 });
} catch {
  threwBroken = true;
}
check(!threwBroken, 'hiányos ctx mellett sem dob');

// Aszinkron (spawnTerminal) útvonal: a wrapper NEM törheti el a handle-t, és a
// rekord a feloldás után kerül a ledgerbe (mért hiba volt: Promise ment át).
const terminalHandle = await fakeCtx.subprocess.spawnTerminal({ argv: ['node', '-v'], cwd: process.cwd() });
check(terminalHandle?.pid === livePid, 'a spawnTerminal a handle-t adja vissza (a wrapper nem töri el)');
check(ledger.replayLedger(file).has(livePid), 'a terminál (pid-del) bekerül a ledgerbe');

console.log('[3] reconciláció (késleltetett)');
// Az identitás-feloldás lassú lehet (a repóban nincs node_modules, ezért itt a
// WMI-ág fut), ezért kitartással várunk, nem fix alvással.
for (let waited = 0; waited < 5000 && !store.has(`recovered-${livePid}`); waited += 50) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
check(store.has(`recovered-${livePid}`), 'az élő PID recovered jobként megjelenik');
check(store.has('recovered-999999') === false, 'a halott PID nem lesz recovered job');

const job = store.get(`recovered-${livePid}`);
check(job !== undefined && job.owner === undefined, 'a recovered job owner nélküli (mindenki látja)');
check(typeof job?.readOutput === 'function' && typeof job.readOutput() === 'string', 'readOutput szöveget ad');
check(typeof job?.cancel === 'function', 'cancel hívható (job_kill)');

if (job !== undefined) {
  // A saját PID-ünket NEM szabad megölni: az identitás hiányzik/egyezik, de a
  // teszt kedvéért a rekord szándékosan rossz indítási időt kap → pid-reused.
  await new Promise((resolve) => {
    job.cancel('test');
    setTimeout(resolve, 300);
  });
  check(store.get(`recovered-${livePid}`) !== undefined, 'a cancel nem törli a rekordot');
  check(settled.length === 0 || existsSync(file), 'a cancel nem ölte meg a teszt-folyamatot');
}

console.log('[4] untracked párosítás (PID nélküli spawn → folyamatlista)');
const { matchUntracked } = await import('../lib/identity.js');
const base = Date.parse('2026-11-13T07:00:00Z');
const snapshot = [
  { pid: 100, parentPid: 1, startedMs: base + 500, cmdline: 'C:\\Program Files\\nodejs\\node.exe ...\\bin.js web --port 3080' },
  { pid: 200, parentPid: 1, startedMs: base + 400, cmdline: 'C:\\Apps\\vite.exe --serve' },
];
// A rekord a valóságban `exe` mezőt is hordoz (a plugin írja), ezért a
// párosítás a végrehajtható nevet hasonlítja, nem a parancssor részstringjét.
check(matchUntracked({ at: base, exe: 'C:\\Apps\\vite.exe', cmdline: 'vite --serve' }, snapshot)?.pid === 200, 'egyező exe → párosít');
check(matchUntracked({ at: base + 60_000, exe: 'C:\\Program Files\\nodejs\\node.exe', cmdline: 'node ...\\bin.js' }, snapshot) === null, 'időben távoli folyamat → nincs párosítás');
check(matchUntracked({ at: base, exe: 'C:\\Program Files\\nodejs\\node.exe', cmdline: 'node' }, [snapshot[0], { ...snapshot[0], pid: 101, startedMs: base + 200 }]) === null, 'két azonos exe (kétértelmű) → nem tippelünk');
check(matchUntracked({ at: base, exe: 'C:\\x\\rg.exe', cmdline: 'rg --json' }, snapshot) === null, 'túl rövid exe-név (rg) → kihagyva');
check(matchUntracked({ at: base, exe: 'C:\\x\\nincsilyen.exe', cmdline: 'nincsilyen --x' }, snapshot) === null, 'nincs találat → null');
check(matchUntracked({ at: base, exe: 'C:\\Program Files\\nodejs\\node.exe', cmdline: 'node ...' }, [{ ...snapshot[0], pid: process.pid }]) === null, 'a saját folyamatot kizárja');

// A gyakorlatban mért eset (2026-11-13, éles próba): három azonos nevű `pwsh`
// indult 11 s alatt, ezért a token + időablak kétértelmű lett és nem volt
// párosítás. A spawn-kori gazda (spawnerPid) lánca egyértelművé teszi.
console.log('  -- spawnerPid lánc --');
const spawner = 9000;
const tree = [
  { pid: 8001, parentPid: spawner, startedMs: base, cmdline: 'C:\\...\\runner.js --workspace' },
  { pid: 8002, parentPid: 8001, startedMs: base + 300, cmdline: 'C:\\...\\pwsh.exe -NoLogo -NoProfile' },
  { pid: 8003, parentPid: 1234, startedMs: base + 100, cmdline: 'C:\\...\\pwsh.exe -NoLogo -NoProfile' },
];
check(matchUntracked({ at: base, cmdline: 'pwsh.exe -NoLogo', spawnerPid: spawner }, tree, 3000, 5555)?.pid === 8002, 'a spawner leszármazottját választja (nagyapa-lánc)');
check(matchUntracked({ at: base, cmdline: 'pwsh.exe -NoLogo', spawnerPid: 7777 }, tree, 3000, 5555) === null, 'idegen gazdához nem párosít');
const twoDescendants = [...tree, { pid: 8004, parentPid: spawner, startedMs: base + 200, cmdline: 'C:\\...\\pwsh.exe -NoLogo -NoProfile' }];
check(matchUntracked({ at: base, cmdline: 'pwsh.exe -NoLogo', spawnerPid: spawner }, twoDescendants, 3000, 5555) === null, 'két leszármazott → kétértelmű, nem tippel');

// MÉRT TÉVES TALÁLAT (2026-11-13, éles futás): a `C:\Program Files\…` rekordból
// a régi kinyerés `program` tokent csinált, ami BÁRMELY `C:\Program Files\…`
// parancssorra illeszkedett — két Chrome folyamatot is „adoptált", holott a
// ledgerben egyetlen chrome spawn-rekord sincs. Ha ez visszajönne, a `job_kill`
// idegen (felhasználói) folyamatot ölne.
console.log('  -- generikus token (mért téves találat) --');
const chromeTree = [
  { pid: 9001, parentPid: 1, startedMs: base + 1000, cmdline: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe --type=renderer' },
  { pid: 9002, parentPid: 1, startedMs: base + 500, cmdline: 'C:\\Program Files\\nodejs\\node.exe C:\\x\\bin.js' },
];
check(matchUntracked({ at: base, cmdline: 'C:\\Program Files\\nodejs\\node.exe C:\\x\\bin.js' }, chromeTree, 3000, 5555)?.pid === 9002, 'szóközös útvonalú node rekord a node-hoz párosul (nem a chrome-hoz)');
check(matchUntracked({ at: base + 1000, cmdline: 'C:\\Program Files\\ismeretlen\\ok.exe' }, chromeTree, 3000, 5555) === null, 'generikus/ismerttelen token nem párosít idegen folyamatra');
check(matchUntracked({ at: base, exe: 'C:\\Program Files\\nodejs\\node.exe', cmdline: 'node x' }, chromeTree, 3000, 5555)?.pid === 9002, 'az `exe` mező pontosít (szóközös útvonal mellett is)');

console.log('[5] tömörítés (régi untracked sorok kiesnek, a többi marad)');
const { compactAll, replayLedger } = ledger;
const compactTarget = ledger.ledgerFileFor(workspace);
// 30 órás rekord: a megőrzési ablak 24 óra, tehát ez már tömöríthető.
const STALE_MS = 30 * 60 * 60 * 1000;
ledger.appendRecord(compactTarget, { t: 'untracked', at: Date.now() - STALE_MS, cmdline: 'rg.exe régi', cwd: process.cwd(), workspaceRealpath: workspace, kind: 'spawn' });
ledger.appendRecord(compactTarget, { t: 'untracked', at: Date.now() - 2 * 60 * 60 * 1000, cmdline: 'rg.exe 2 oras (megmarad)', cwd: process.cwd(), workspaceRealpath: workspace, kind: 'spawn' });
ledger.appendRecord(compactTarget, { t: 'untracked', at: Date.now(), cmdline: 'rg.exe friss', cwd: process.cwd(), workspaceRealpath: workspace, kind: 'spawn' });
const beforeCompact = (await import('node:fs')).readFileSync(compactTarget, 'utf8').split('\n').filter(Boolean).length;
const compacted = compactAll();
const afterText = (await import('node:fs')).readFileSync(compactTarget, 'utf8');
check(compacted.removed >= 1, 'a régi untracked sor tömörítve lett');
check(afterText.includes('rg.exe 2 oras (megmarad)'), 'a 24 órán belüli untracked sor megmarad');
check(afterText.includes('rg.exe friss'), 'a friss untracked sor megmaradt');
check(afterText.includes('"t":"spawn"'), 'a spawn rekord megmaradt');
check(replayLedger(compactTarget).has(livePid), 'a tömörítés után a spawn visszajátszható');
check(afterText.split('\n').filter(Boolean).length < beforeCompact, 'a fájl rövidebb lett');

rmSync(fakeHome, { recursive: true, force: true });
console.log(failures === 0 ? '\nMINDEN TESZT OK' : `\n${failures} teszt HIBA`);
process.exit(failures === 0 ? 0 : 1);
