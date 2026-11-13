/**
 * dsh-process-guard — perzisztens folyamat-ledger és induláskori reconciláció.
 *
 * WHY (mért eset, 2026-11-12): a DSH-ból indított Vite dev szerver
 * (node.exe PID 46484, 1,6 GB, 49 990 handle) a DSH összeomlása után tovább
 * futott, de a felületen nem jelent meg és nem volt leállítható. A gyökér ok a
 * magban van: `dsh-jobs-local/lib/index.js:105` `store = new Map()` (csak
 * memória), és `cancelForTeardown()` (435–452) csak warnol („work may be
 * orphaned"), nem keres OS-szintű folyamatot.
 *
 * WHAT: ez a plugin a mag megváltoztatása nélkül pótolja a hiányzó réteget:
 *   1. minden `ctx.subprocess.spawn()` / `spawnTerminal()` után ledger-rekordot
 *      ír (PID + indítási idő + cmdline + cwd + workspace),
 *   2. induláskor visszajátssza a ledgert, a halott PID-eket eldobja, az élőket
 *      `recovered` jobként bejegyzi a jobs-registrybe (owner nélkül, ezért
 *      minden munkamenet listája látja),
 *   3. a `job_kill` egy ilyen jobon PID **+ indítási idő** egyezés után
 *      `taskkill /T /F` — PID-újrahasznosításnál nem öl idegen folyamatot.
 *
 * HOW IT STAYS SAFE: a plugin soha nem blokkolhatja a bootot. A mag minden
 * belső felületét (`jobs.store`, `subprocess.spawn`) védetten éri el, hiba
 * esetén csak logol (`warn`), és minden hívás try/catch-ben fut. Ha a mag
 * felülete változik, a plugin néma: a DSH ugyanúgy indul, csak ledger nélkül.
 *
 * TELEPÍTÉS: `plugins\dsh-process-guard\install.ps1` (junction + patch-entry +
 * újraindítás). Kikapcsolás: ugyanaz `-Remove`-mal.
 */
import { appendRecord, canonicalWorkspace, compactAll, ledgerFileFor, ledgerRoot, readAllLedgers, readUntracked } from './ledger.js';
import { matchUntracked, processIdentity, processSnapshot, terminateVerified } from './identity.js';
import { join } from 'node:path';

/** A plugin neve a boot gráfban. */
const name = 'dsh-process-guard';

/** A mag szolgáltatásai, amelyekre szükség van. */
const inject = ['jobs', 'subprocess'];

/** Recovered job id-prefix — így a listában egyértelmű, honnan jött. */
const RECOVERED_PREFIX = 'recovered';

/** A PID nélküli handle-ök diagnosztikáját ennyiszer rögzítjük (ne hízzon a napló). */
let noPidDiagnostics = 0;

/**
 * A plugin betöltésének ideje. Az ennél KÉSŐBB keletkezett `untracked` rekord a
 * MOSTANI futásból való, tehát nem elárvult (a harness még életben tartja), és
 * nem szabad „recovered" jobként beregisztrálni. Csak a korábbi futás rekordjai
 * párosíthatók — különben egy rövid életű tool-folyamat rekordja egy később
 * indult, azonos nevű folyamathoz tapadna (mért hiba 2026-11-13: három rekord
 * ugyanarra a PID-re).
 */
const PLUGIN_BOOT_MS = Date.now();

/**
 * Biztonságos logger: a plugin soha nem eshet el azon, hogy a log-interfész
 * éppen más.
 * @param {object} ctx
 * @param {'info'|'warn'} level
 * @param {string} message
 */
function logLine(ctx, level, message) {
  try {
    ctx?.logger?.[level]?.(`[${name}] ${message}`);
  } catch {
    /* a log nem kritikus */
  }
}

/**
 * Diagnosztika FÁJLBA. A harness plugin-naplója nem hagy nyomot a
 * `state\harness.log`-ban (mért: csak a token-sor van benne), ezért a plugin
 * magáról ide ír — így a működése naplókutatás nélkül ellenőrizhető.
 * @param {string} kind
 * @param {object} data
 */
function diag(kind, data) {
  appendRecord(join(ledgerRoot(), '_diag.jsonl'), { at: new Date().toISOString(), pid: process.pid, kind, data });
}

/**
 * Egy subprocess handle leírása: milyen mezők érhetők el rajta. Azért kell,
 * mert a PID kinyerése best-effort (a nyilvános típus nem írja elő), és a
 * mezők a mag verziójával változhatnak.
 * @param {any} handle
 * @returns {{keys: string[], numeric: Record<string, number|string>}}
 */
function describeHandle(handle) {
  if (handle === null || typeof handle !== 'object') return { keys: [], numeric: {} };
  const keys = [];
  let object = handle;
  let depth = 0;
  while (object && object !== Object.prototype && depth < 3) {
    keys.push(...Object.getOwnPropertyNames(object));
    object = Object.getPrototypeOf(object);
    depth += 1;
  }
  /** @type {Record<string, number|string>} */
  const numeric = {};
  for (const key of ['pid', 'processId', 'execPid', 'id']) {
    if (Number.isSafeInteger(handle[key])) numeric[key] = handle[key];
  }
  for (const key of ['child', 'process', 'root', 'rootIdentity', 'spawned', 'handle']) {
    const value = handle[key];
    if (value !== null && typeof value === 'object') {
      for (const inner of ['pid', 'id', 'started']) {
        if (Number.isSafeInteger(value[inner])) numeric[`${key}.${inner}`] = value[inner];
        else if (typeof value[inner] === 'string') numeric[`${key}.${inner}`] = value[inner];
      }
    }
  }
  return { keys: [...new Set(keys)].slice(0, 40), numeric };
}

/**
 * PID kinyerése egy subprocess handle-ből, a lehetséges belső mezők szerint.
 * A nyilvános `SubprocessHandle` típus nem írja elő a PID-et, ezért ez
 * best-effort: ha nincs, a rekord PID nélkül marad (nem reconcilálható).
 * @param {any} handle
 * @returns {number|null}
 */
function handlePid(handle) {
  const candidates = [handle?.pid, handle?.child?.pid, handle?.process?.pid, handle?.rootIdentity?.pid, handle?.root?.pid];
  for (const candidate of candidates) {
    if (Number.isSafeInteger(candidate) && candidate > 0) return candidate;
  }
  return null;
}

/**
 * Az első szó egy spawn spec-ből (naplózáshoz és címkéhez).
 * @param {any} spec
 * @returns {string}
 */
function specLabel(spec) {
  const argv = spec?.argv ?? spec?.command ?? spec?.file ?? spec?.program;
  if (Array.isArray(argv)) return argv.slice(0, 3).join(' ');
  if (typeof argv === 'string' && argv.length > 0) return argv;
  return 'process';
}

/**
 * Egy spawn rekord felvétele: előbb a `spawn` sor (PID-del, hogy összeomlás
 * esetén is legyen nyom), majd aszinkron az `identity` sor a hiteles
 * indítási idővel, végül a kilépésnél `exit` tombstone.
 * @param {object} ctx
 * @param {any} handle
 * @param {any} spec
 * @param {string} kind
 */
function recordSpawn(ctx, handle, spec, kind) {
  const pid = handlePid(handle);
  if (pid === null) {
    // A mag `spawn()` handle-je NEM adja ki a PID-et (mért felület: stdin,
    // stdout, stderr, collected, done, terminate, terminateForHostExit,
    // waitForExit). Ezért a rekord „untracked": parancssor + időpont, PID
    // nélkül. Induláskor a folyamatlistából párosítjuk (matchUntracked), és
    // csak egyetlen jelölt esetén fogadjuk el.
    const untrackedCwd = typeof spec?.cwd === 'string' && spec.cwd.length > 0 ? spec.cwd : process.cwd();
    const untrackedCanonical = canonicalWorkspace(untrackedCwd);
    appendRecord(ledgerFileFor(untrackedCanonical), {
      t: 'untracked',
      at: Date.now(),
      cmdline: specLabel(spec),
      cwd: untrackedCwd,
      workspaceRealpath: untrackedCanonical,
      kind,
      // A spawn-kor futó harness PID-je. Ez a párosítás erős jele: a folyamat
      // leszármazottja ennek (a token + időablak önmagában kétértelmű volt —
      // mért eset: három azonos nevű `pwsh` 11 s alatt).
      spawnerPid: process.pid,
    });
    if (noPidDiagnostics < 5) {
      noPidDiagnostics += 1;
      diag('handle-no-pid', { kind, spec: specLabel(spec), ...describeHandle(handle) });
    }
    return;
  }

  const cwd = typeof spec?.cwd === 'string' && spec.cwd.length > 0 ? spec.cwd : undefined;
  const canonical = canonicalWorkspace(cwd ?? process.cwd());
  const file = ledgerFileFor(canonical);
  const base = {
    pid,
    at: Date.now(),
    cmdline: specLabel(spec),
    cwd: cwd ?? process.cwd(),
    workspaceRealpath: canonical,
    sessionId: spec?.owner?.id ?? spec?.sessionId ?? null,
    jobId: spec?.jobId ?? null,
    kind,
  };

  if (!appendRecord(file, { t: 'spawn', ...base })) {
    logLine(ctx, 'warn', `a ledger nem írható: ${file}`);
    return;
  }

  // A hiteles indítási idő aszinkron kerül a ledgerbe (WMI hívás — nem a spawn útjában).
  void processIdentity(pid)
    .then((identity) => {
      if (identity.alive && identity.started !== null) {
        appendRecord(file, { t: 'identity', pid, started: identity.started, cmdline: identity.cmdline ?? base.cmdline });
      }
    })
    .catch(() => {});

  // Tombstone: a folyamat kilépésekor a rekord lezárul.
  const done = handle?.done ?? handle?.exited;
  if (done && typeof done.then === 'function') {
    done.then(
      () => appendRecord(file, { t: 'exit', pid, at: Date.now(), reason: 'exited' }),
      () => appendRecord(file, { t: 'exit', pid, at: Date.now(), reason: 'failed' }),
    );
  }
}

/**
 * Egy szolgáltatás-metódus befogása. Idempotens (`patchReload: live` miatt
 * kétszer is lefuthat), és a wrappert jelöli, hogy ne csomagoljuk duplán.
 * @param {object} ctx
 * @param {object} service
 * @param {string} method
 * @param {string} kind
 * @returns {boolean}
 */
function instrument(ctx, service, method, kind) {
  const original = service?.[method];
  if (typeof original !== 'function') return false;
  if (original.__dshProcessGuard === true) return true;
  const wrapped = function wrappedSpawn(...args) {
    const result = original.apply(this, args);
    try {
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        // Aszinkron (pl. spawnTerminal): a handle csak feloldás után létezik,
        // ezért a rekord felvétele is a feloldásra vár. MÉRT HIBA (2026-11-13):
        // az első változat a Promise-t adta át, így a terminálok (amelyek
        // egyébként KIADJÁK a pid-et) kimaradtak a ledgerből.
        return result.then((handle) => {
          try {
            recordSpawn(ctx, handle, args[0], kind);
          } catch (error) {
            logLine(ctx, 'warn', `${method}: a ledger-rekord elmaradt: ${String(error)}`);
          }
          return handle;
        });
      }
      recordSpawn(ctx, result, args[0], kind);
    } catch (error) {
      logLine(ctx, 'warn', `${method}: a ledger-rekord elmaradt: ${String(error)}`);
    }
    return result;
  };
  wrapped.__dshProcessGuard = true;
  try {
    service[method] = wrapped;
    return true;
  } catch {
    return false; // fagyasztott/proxyzott szolgáltatás — nem erőltetjük
  }
}

/**
 * Induláskori reconciláció: a ledgerek visszajátszása és a recovered jobok
 * beregisztrálása. Egyszer fut, hibatűrően.
 * @param {object} ctx
 */
async function reconcile(ctx) {
  const startedAt = Date.now();
  const registry = ctx?.jobs;
  const store = registry?.store;
  if (!(store instanceof Map)) {
    logLine(ctx, 'warn', 'a jobs registry belső store-ja nem érhető el — reconciláció kihagyva');
    return;
  }

  // Diagnosztika: az élő handle-ök felületének rögzítése. Ez adja meg, hogy a
  // PID melyik mezőn érhető el (a nyilvános típus nem írja elő).
  const live = ctx?.subprocess?.live;
  if (live instanceof Set) {
    let index = 0;
    for (const handle of live) {
      if (index >= 5) break;
      diag('live-handle', { index, ...describeHandle(handle) });
      index += 1;
    }
  }

  let records = 0;
  let recovered = 0;
  let dead = 0;
  let unverified = 0;

  /** @type {Array<{file: string, pid: number, record: object}>} */
  const tasks = [];
  for (const { file, records: byPid } of readAllLedgers()) {
    for (const [pid, record] of byPid) {
      if (record?.t === 'exit') {
        dead += 1;
        continue;
      }
      records += 1;
      tasks.push({ file, pid, record });
    }
  }

  // Az identitás-feloldás (a mag inspectora, vagy Windows-on WMI) hálózat/IO
  // kötött, ezért korlátozott párhuzamossággal megy: 50 elárvult folyamat
  // egymás utáni WMI-hívása több másodpercig tartaná a bootot.
  const CONCURRENCY = 4;
  for (let index = 0; index < tasks.length; index += CONCURRENCY) {
    const slice = tasks.slice(index, index + CONCURRENCY);
    const outcomes = await Promise.all(
      slice.map(async ({ file, pid, record }) => {
        const identity = await processIdentity(pid);
        if (!identity.alive) {
          appendRecord(file, { t: 'exit', pid, at: Date.now(), reason: 'reconciled-dead' });
          return { dead: true };
        }
        const verified =
          record.started !== null &&
          record.started !== undefined &&
          identity.started !== null &&
          String(record.started) === String(identity.started);
        return { verified, registered: registerRecovered(ctx, registry, store, pid, record, verified) };
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.dead === true) {
        dead += 1;
        continue;
      }
      if (outcome.verified !== true) unverified += 1;
      if (outcome.registered === true) recovered += 1;
    }
  }

  // PID nélküli (untracked) rekordok párosítása a futó folyamatokhoz.
  // Egyetlen WMI-lekérdezés az egész listára — nem spawnonként (az túl drága
  // lenne: az `rg.exe` és a sandbox runner minden tool-hívásnál elindul).
  let adopted = 0;
  // Csak a KORÁBBI futásból származó rekord lehet elárvult (lásd PLUGIN_BOOT_MS).
  const untracked = readUntracked().filter(({ record }) => Number.isFinite(record.at) && record.at < PLUGIN_BOOT_MS - 5000);
  if (untracked.length > 0) {
    const snapshot = await processSnapshot();
    for (const { file, record } of untracked) {
      const match = matchUntracked(record, snapshot);
      if (match === null) continue; // kilépett vagy nem egyértelmű — nem tippelünk
      // A cancel() a rekordból dolgozik, ezért a pid INNEN kerül bele.
      const candidate = { ...record, pid: match.pid, started: match.started };
      if (registerRecovered(ctx, registry, store, match.pid, candidate, true)) {
        adopted += 1;
        appendRecord(file, { t: 'adopted', at: Date.now(), pid: match.pid, started: match.started });
      }
    }
  }

  // Tömörítés: a régi `untracked` sorok (már nem párosíthatók) és a félig írt
  // sorok kiesnek; a spawn/identity/exit rekordok maradnak.
  const compaction = compactAll();

  logLine(
    ctx,
    'info',
    `reconciláció kész: ${records} élő rekord, ${recovered} recovered job, ${adopted} untracked-ból párosítva, ${dead} halott, ${unverified} ellenőrizetlen (nem ölhető), ${compaction.removed} sor tömörítve, ${Date.now() - startedAt} ms`,
  );
}

/**
 * Egy élő folyamat bejegyzése `recovered` jobként. A rekord pontosan azt a
 * mezőkészletet adja, amire a registry `snapshot()`/`kill()`/`read()` számít
 * (`dsh-jobs-local/lib/index.js:146–164`, `317–331`), plusz a settle-hidat.
 * @param {object} ctx
 * @param {any} registry
 * @param {Map<string, any>} store
 * @param {number} pid
 * @param {object} record
 * @param {boolean} verified
 * @returns {boolean} történt-e bejegyzés
 */
function registerRecovered(ctx, registry, store, pid, record, verified) {
  const id = `${RECOVERED_PREFIX}-${pid}`;
  if (store.has(id)) return false;

  let markSettled;
  const settled = new Promise((resolve) => {
    markSettled = resolve;
  });

  const label = `${record.cmdline ?? 'process'} (pid ${pid})`;
  const job = {
    id,
    kind: RECOVERED_PREFIX,
    label,
    owner: undefined, // owner nélkül minden munkamenet listája látja
    outputLimitBytes: undefined,
    status: 'running',
    detail: verified
      ? 'a DSH újraindult, a folyamat tovább fut (ledgerből helyreállítva)'
      : 'a DSH újraindult, a folyamat tovább fut, de az indítási idő nem ellenőrizhető — leállítás nem engedélyezett',
    output: undefined,
    startedAt: typeof record.at === 'number' ? record.at : Date.now(),
    finishedAt: undefined,
    reported: false,
    settled,
    markSettled,
    waiters: 0,
    waitResolvers: new Set(),
    /** A `job_output` ezt adja vissza — ismert kimenet nincs, csak magyarázat. */
    readOutput: () =>
      `[${name}] ez egy helyreállított folyamat, a kimenete nem maradt meg.\npid: ${pid}\ncwd: ${record.cwd ?? '?'}\nparancs: ${record.cmdline ?? '?'}\n`,
    /** A `job_kill` ezt hívja; sosem dob, hogy a teardown ne akadjon el. */
    cancel: (reason) => {
      void terminateVerified(record)
        .then((result) => {
          if (result.killed) {
            try {
              registry.settle(job, { status: 'killed', detail: `leállítva: ${reason ?? 'job_kill'} (pid ${pid}, ${result.reason})` });
            } catch (error) {
              logLine(ctx, 'warn', `${id}: settle hiba: ${String(error)}`);
            }
            return;
          }
          job.status = 'running'; // nem sikerült: ne tűnjön leállítottnak
          logLine(ctx, 'warn', `${id}: NEM lett leállítva (${result.reason})`);
        })
        .catch((error) => {
          job.status = 'running';
          logLine(ctx, 'warn', `${id}: leállítási hiba: ${String(error)}`);
        });
    },
  };

  try {
    store.set(id, job);
    registry.notifyChanged?.(undefined);
    return true;
  } catch (error) {
    logLine(ctx, 'warn', `${id}: bejegyzés nem sikerült: ${String(error)}`);
    return false;
  }
}

/**
 * Plugin belépési pont.
 * @param {object} ctx
 * @param {object} [config]
 */
function apply(ctx, config = {}) {
  try {
    const subprocess = ctx?.subprocess;
    const spawnInstrumented = instrument(ctx, subprocess, 'spawn', 'spawn');
    const terminalInstrumented = instrument(ctx, subprocess, 'spawnTerminal', 'terminal');
    if (!spawnInstrumented && !terminalInstrumented) {
      logLine(ctx, 'warn', 'a subprocess szolgáltatás nem befogható — a ledger nem gyűlik');
    }

    let ran = false;
    const runOnce = () => {
      if (ran) return;
      ran = true;
      void reconcile(ctx).catch((error) => logLine(ctx, 'warn', `reconciláció hiba: ${String(error)}`));
    };

    // A 'ready' a helyes pont; a késleltetett hívás csak biztosíték arra az
    // esetre, ha a boot gráfban nem jön el a ready esemény.
    try {
      ctx.on?.('ready', runOnce);
    } catch {
      /* nincs ready esemény */
    }
    const timer = setTimeout(runOnce, config.reconcileDelayMs ?? 2500);
    timer.unref?.();

    diag('boot', {
      version: '0.1.0',
      spawnInstrumented,
      terminalInstrumented,
      cwd: process.cwd(),
      ledger: ledgerFileFor(canonicalWorkspace(process.cwd())),
    });
    logLine(ctx, 'info', `aktív (ledger: ${ledgerFileFor(canonicalWorkspace(process.cwd()))})`);
  } catch (error) {
    // A bootot ez SOHA nem állíthatja meg.
    logLine(ctx, 'warn', `a plugin nem indult el: ${String(error)}`);
  }
}

export { apply, inject, name };
