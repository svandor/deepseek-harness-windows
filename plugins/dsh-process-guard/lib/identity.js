/**
 * identity.js — PID-újrahasznosítás elleni folyamat-azonosítás.
 *
 * WHY: a puszta PID nem azonosít folyamatot. Ha a DSH összeomlott és a
 * rendszer újrahasznosította a PID-et, egy „recovered" job leállítása idegen
 * folyamatot ölne meg. Ezért az azonosító a PID **és** az indítási idő
 * (Win32 `GetProcessTimes` creation FILETIME; POSIX `/proc/<pid>/stat`
 * starttime) párosa.
 *
 * A DSH magja ezt már számolja (`dsh-subprocess-local`: `rootIdentity`,
 * `inspector.snapshot()`), de csak memóriában tartja, és nem adja ki a
 * handle-en. Ezért itt két forrásból dolgozunk, csökkenő megbízhatósággal:
 *
 *   1. a mag belső inspectora, ha importálható (`runner-launch-*.js` —
 *      a fájlnév hash-t tartalmaz, ezért futásidőben keressük),
 *   2. Windows-on `Get-CimInstance Win32_Process` (CreationDate + CommandLine),
 *      POSIX-on `/proc`.
 *
 * Ha egyik sem elérhető, az identitás `started: null` marad: az ilyen rekord
 * élő folyamatnál is **nem ölhető** automatikusan (lásd index.js), csak jelzi.
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';

/** @type {Promise<object|null>|null} a mag inspectora, egyszer feloldva. */
let coreInspectorPromise = null;

/**
 * A mag belső inspectora, ha a kiadott csomagban megtalálható.
 * A `runner-launch-<hash>.js` név megváltozhat, ezért mappát olvasunk.
 * @returns {Promise<object|null>}
 */
export function coreInspector() {
  coreInspectorPromise ??= (async () => {
    try {
      const entry = import.meta.resolve?.('@deepseek-ai/dsh-subprocess-local');
      if (!entry) return null;
      const libDir = dirname(fileURLToPath(entry));
      const bundle = readdirSync(libDir).find((name) => /^runner-launch-.*\.js$/u.test(name));
      if (bundle === undefined) return null;
      const module = await import(new URL(`./${bundle}`, entry).href);
      const create = module.createProcessInspector ?? module.O;
      if (typeof create !== 'function') return null;
      return create();
    } catch {
      return null; // a mag belső felülete változott — a CIM-ág veszi át
    }
  })();
  return coreInspectorPromise;
}

/**
 * Windows: egy folyamat indítási ideje és parancssora WMI-ból.
 * @param {number} pid
 * @returns {Promise<{started: string|null, cmdline: string|null}|null>}
 */
function windowsSnapshot(pid) {
  return new Promise((resolve) => {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.Write((@{ c = $p.CreationDate.ToUniversalTime().ToString('o'); l = $p.CommandLine } | ConvertTo-Json -Compress)) }`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string' || stdout.trim().length === 0) return resolve(null);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ started: parsed.c ?? null, cmdline: parsed.l ?? null });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * POSIX: `/proc/<pid>/stat` 22. mezője a starttime (órajel-egység).
 * @param {number} pid
 * @returns {Promise<{started: string|null, cmdline: string|null}|null>}
 */
async function posixSnapshot(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // A 2. mező (comm) szóközt és zárójelet tartalmazhat — a záró ')' után vágunk.
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const starttime = tail[19]; // 22. mező összesen
    let cmdline = null;
    try {
      cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ').trim() || null;
    } catch {
      /* a cmdline nem kötelező */
    }
    return { started: starttime ?? null, cmdline };
  } catch {
    return null;
  }
}

/**
 * Egy folyamat identitása: `{ pid, started, cmdline, alive }`.
 * @param {number} pid
 * @returns {Promise<{pid: number, started: string|null, cmdline: string|null, alive: boolean}>}
 */
export async function processIdentity(pid) {
  const alive = isAlive(pid);
  if (!alive) return { pid, started: null, cmdline: null, alive: false };

  const inspector = await coreInspector();
  if (inspector !== null) {
    try {
      const state = inspector.snapshot().tree(pid).find((member) => member.pid === pid);
      if (state !== undefined) {
        return { pid, started: String(state.started), cmdline: null, alive: true };
      }
    } catch {
      /* az inspector nem tudja — megyünk tovább */
    }
  }

  const snapshot = IS_WINDOWS ? await windowsSnapshot(pid) : await posixSnapshot(pid);
  if (snapshot === null) return { pid, started: null, cmdline: null, alive: true };
  return { pid, started: snapshot.started, cmdline: snapshot.cmdline, alive: true };
}

/**
 * Él-e a PID? `EPERM` esetén is él (csak nem a miénk) — ilyenkor NEM ölünk.
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Egy pillanatkép az összes folyamatról (egyetlen WMI-hívás).
 * Azért kell, mert a sima `spawn()` handle-je NEM adja ki a PID-et (mért:
 * `stdin, stdout, stderr, collected, done, terminate, waitForExit`), így a
 * hosszú életű, elárvult folyamatot csak a folyamatlistából lehet visszaszerezni.
 * @returns {Promise<Array<{pid: number, parentPid: number, startedMs: number|null, cmdline: string}>>}
 */
export async function processSnapshot() {
  if (!IS_WINDOWS) {
    // POSIX: /proc bejárás (a starttime órajel-egység, ezért csak sorrendre jó).
    const out = [];
    try {
      const { readdirSync } = await import('node:fs');
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/u.test(entry)) continue;
        const identity = await posixSnapshot(Number(entry));
        if (identity !== null) out.push({ pid: Number(entry), parentPid: 0, startedMs: null, cmdline: identity.cmdline ?? '' });
      }
    } catch {
      /* nincs /proc */
    }
    return out;
  }

  return new Promise((resolve) => {
    // MÉRT HIBA (2026-11-13): a PowerShell 5.1 a DateTime-et `/Date(1794…)/`
    // alakban szerializálja, amit a Date.parse nem értelmez → minden startedMs
    // null lett, ezért a párosítás soha nem talált. Ezért Unix-ms-et kérünk.
    const script =
      '$ErrorActionPreference="SilentlyContinue";' +
      '$epoch=[datetime]::SpecifyKind([datetime]"1970-01-01",[System.DateTimeKind]::Utc);' +
      'Get-CimInstance Win32_Process | ForEach-Object { ' +
      '$ms=[long](($_.CreationDate.ToUniversalTime()-$epoch).TotalMilliseconds);' +
      '[Console]::Out.WriteLine((@{ p = $_.ProcessId; pp = $_.ParentProcessId; m = $ms; l = $_.CommandLine } | ConvertTo-Json -Compress)) }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== 'string') return resolve([]);
        const out = [];
        for (const line of stdout.split('\n')) {
          const text = line.trim();
          if (text.length === 0) continue;
          try {
            const row = JSON.parse(text);
            const pid = Number(row.p);
            if (!Number.isSafeInteger(pid) || pid <= 0) continue;
            const startedMs = Number(row.m);
            out.push({
              pid,
              parentPid: Number(row.pp) || 0,
              startedMs: Number.isFinite(startedMs) && startedMs > 0 ? startedMs : null,
              cmdline: typeof row.l === 'string' ? row.l : '',
            });
          } catch {
            /* egy hibás sor nem viszi el a pillanatképet */
          }
        }
        resolve(out);
      },
    );
  });
}

/**
 * Olyan nevek, amelyek NEM azonosíthatnak egy folyamatot. MÉRT TÉVES TALÁLAT
 * oka (2026-11-13): a régi kinyerés a szóközön vágott először, ezért a
 * `C:\Program Files\…\node.exe …` rekordból `program` lett, ami BÁRMELY
 * `C:\Program Files\…` parancssorra illeszkedett — így két Chrome folyamatot is
 * „adoptált", holott a ledgerben egyetlen chrome spawn-rekord sincs.
 */
const GENERIC_EXECUTABLE_NAMES = new Set(['program', 'program files', 'windows', 'users', 'local', 'appdata', 'temp', 'roaming']);

/**
 * A rekord végrehajtható-neve, biztonságosan kinyerve.
 *
 * Sorrend: a rekord `exe` mezője (a plugin írja), különben a parancssor első
 * `*.exe` előfordulásának basename-je (a szóközös útvonal sem gond), végül az
 * első szó basename-je. Generikus név és 3 karakternél rövidebb név SOHA nem
 * azonosító — inkább nincs párosítás, mint téves.
 * @param {{exe?: string, cmdline?: string}} record
 * @returns {string|null}
 */
function executableToken(record) {
  const candidates = [];
  if (typeof record?.exe === 'string' && record.exe.length > 0) candidates.push(record.exe);
  if (typeof record?.cmdline === 'string' && record.cmdline.length > 0) candidates.push(record.cmdline);

  for (const raw of candidates) {
    const unquoted = raw.replaceAll('"', '');
    const exeMatch = /([^\\/\s]+\.exe)(?=\s|$)/iu.exec(unquoted);
    const name = exeMatch !== null ? exeMatch[1] : unquoted.split(/\s+/u)[0]?.split(/[\\/]/u).pop();
    if (typeof name !== 'string') continue;
    const token = name.toLowerCase().replace(/\.exe$/u, '');
    if (token.length < 3) continue;
    if (GENERIC_EXECUTABLE_NAMES.has(token)) continue;
    return token;
  }
  return null;
}

/**
 * Egy PID nélküli („untracked") ledger-rekord párosítása egy futó folyamathoz.
 *
 * MIÉRT ÍGY: a `spawn()` nem ad PID-et, ezért a rekord a parancssort, az
 * időpontot és a spawn-kori gazda PID-jét tudja. A párosítás akkor fogadja el,
 * ha
 *   - a folyamat indítási ideje ±3 s-ra egyezik a rekord idejével, ÉS
 *   - a folyamat a spawn-kori gazda leszármazottja (erős jel), vagy
 *     végső esetben a végrehajtható-neve egyezik,
 *   - és PONTOSAN EGY jelölt van. Több jelöltnél nem tippelünk (inkább
 *     kimarad, mint hogy idegen folyamatot regisztráljunk vagy öljünk).
 * @param {{at: number, cmdline: string}} record
 * @param {Array<{pid: number, startedMs: number|null, cmdline: string}>} snapshot
 * @param {number} [toleranceMs]
 * @param {number} [selfPid] a harness PID-je; a pluginben alapból `process.pid`,
 *   külön diagnosztikafolyamatból viszont EXPLICIT meg kell adni (mért hiba
 *   2026-11-13: a szkript a saját PID-jével hasonlított, ezért 0 találat lett).
 * @returns {{pid: number, started: string}|null}
 */
export function matchUntracked(record, snapshot, toleranceMs = 3_000, selfPid = process.pid) {
  const token = executableToken(record);
  if (token === null) return null;
  if (!Number.isFinite(record?.at)) return null;

  /** Időben szűkített jelöltek. */
  const inWindow = (row) => row.pid !== selfPid && row.startedMs !== null && Math.abs(row.startedMs - record.at) <= toleranceMs;

  // 1) ERŐS JEL — a spawn-kori gazda leszármazottja.
  //    MÉRT HIBA (2026-11-13, éles próba): a token + ±3 s NEM elég, ha a
  //    felhasználó/ágens ugyanabban a másodpercben több azonos nevű folyamatot
  //    indít (három `pwsh.exe` 11 s alatt) — a párosítás kétértelmű lett, ezért
  //    a próba `no-orphan-adopted` ítéletet adott. A gyökér folyamat lánca
  //    viszont egyértelmű: a spawn-kor futó harness PID-je.
  if (Number.isSafeInteger(record?.spawnerPid)) {
    const byPid = new Map(snapshot.map((row) => [row.pid, row]));
    const descendsFromSpawner = (row) => {
      let current = row;
      for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
        if (current.parentPid === record.spawnerPid) return true;
        current = byPid.get(current.parentPid);
      }
      return false;
    };
    const descendants = snapshot.filter((row) => inWindow(row) && row.cmdline.toLowerCase().includes(token) && descendsFromSpawner(row));
    if (descendants.length === 1) return { pid: descendants[0].pid, started: String(descendants[0].startedMs) };
    // MÉRT HIBA (2026-11-13): itt korábban `return null` állt, ezért a
    // kétértelmű lánc-ág MINDIG elnyelte a lehetőséget, és a legközelebbi-idő
    // ág soha nem futott le (a valós, elárvuló próba sem talált párt). Most a
    // lánc csak akkor dönt, ha egyértelmű — különben továbbengedünk.
  }

  // MÉRT HIBA (2026-11-13): a `cmdline.includes(token)` RÉSZSTRING volt, ezért
  // egy parancssor, amely több programot is megnevez (pl. `node.exe … pwsh.exe`),
  // KÉT különböző rekordhoz is illeszkedett, és ugyanazt a PID-et adta vissza.
  // Ezért a jelölt SAJÁT exe-nevét hasonlítjuk (ugyanazzal a kinyeréssel).
  const sameExecutable = (row) => executableToken({ cmdline: row.cmdline }) === token;

  // 2) TARTALÉK: a harness közvetlen gyermekei, exe-egyezéssel.
  const children = snapshot.filter((row) => inWindow(row) && row.parentPid === selfPid);
  let candidates = children.filter(sameExecutable);

  // Nincs egyező gyermek (pl. héj közbeiktatásával indult): exe-egyezés bárhol.
  if (candidates.length === 0) candidates = snapshot.filter((row) => inWindow(row) && sameExecutable(row));

  if (candidates.length === 1) return { pid: candidates[0].pid, started: String(candidates[0].startedMs) };

  // 3) MÉRT ESET (2026-11-13): a köztes sandbox-runner kilép, így a folyamat
  //    újraszülőül — a leszármazási lánc ELSZAKAD, és a fenti ágak sem
  //    egyértelműek. Ilyenkor a LEGKÖZELEBBI indítási idő dönt, szigorú
  //    feltételekkel: max. 5 s eltérés, és a második legközelebbi legalább
  //    1,5 s-mal messzebb legyen (különben kétértelmű → nem tippelünk).
  const sameName = snapshot.filter((row) => row.pid !== selfPid && row.startedMs !== null && sameExecutable(row));
  if (sameName.length === 0) return null;
  const ranked = sameName
    .map((row) => ({ row, distance: Math.abs(row.startedMs - record.at) }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  if (best.distance > 5_000) return null;
  if (ranked.length > 1 && ranked[1].distance - best.distance < 1_500) return null;
  return { pid: best.row.pid, started: String(best.row.startedMs) };
}

/**
 * Leállítás a folyamatfával együtt, de csak ha az identitás egyezik.
 * @param {{pid: number, started: string|null}} record a ledger-rekord
 * @returns {Promise<{killed: boolean, reason: string}>}
 */
export async function terminateVerified(record) {
  const pid = record?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { killed: false, reason: 'invalid-pid' };
  if (!isAlive(pid)) return { killed: false, reason: 'already-dead' };

  const current = await processIdentity(pid);
  if (record.started !== null && record.started !== undefined) {
    if (current.started === null) return { killed: false, reason: 'identity-unverifiable' };
    if (String(current.started) !== String(record.started)) {
      // A PID-et más folyamat kapta meg — ez NEM a mi gyerekünk.
      return { killed: false, reason: 'pid-reused' };
    }
  } else {
    return { killed: false, reason: 'identity-missing' };
  }

  return new Promise((resolve) => {
    const args = IS_WINDOWS
      ? ['/PID', String(pid), '/T', '/F']
      : ['-TERM', String(pid)];
    execFile(IS_WINDOWS ? 'taskkill.exe' : 'kill', args, { windowsHide: true, timeout: 15_000 }, (error) => {
      if (error && isAlive(pid)) return resolve({ killed: false, reason: `kill-failed: ${String(error.code ?? error.message)}` });
      resolve({ killed: true, reason: 'signalled' });
    });
  });
}
