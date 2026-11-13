/**
 * ledger.js — perzisztens folyamat-ledger ki- és beolvasása.
 *
 * WHY: a DSH job-nyilvántartása (`dsh-jobs-local/lib/index.js:105`
 * `store = new Map()`) tisztán memóriabeli, ezért az összeomlás/újraindítás
 * után a gyerekfolyamatok nyoma is elvész — az elárvult dev szerver tovább fut,
 * de a felület nem látja és nem tudja leállítani (mért eset: 1,6 GB-os Vite,
 * 49 990 handle, 2026-11-12 08:11 óta).
 *
 * WHAT: append-only JSONL, workspaconként egy fájl:
 *   ~/.dsh/process-ledger/<sha256(realpath(workspace))>.jsonl
 * A workspace-kulcs `realpath`-szal kanonizált, mert a session-tároló és a
 * job-owner nyers `cwd`-t használ — a `C:\Szerver` → `D:\Szerver` junction
 * miatt ugyanarra a könyvtárra két különböző kulcs keletkezik.
 *
 * Sorfajták (`t`): `spawn` (rekord), `identity` (PID + indítási idő
 * megerősítése), `exit` (tombstone). A visszajátszás az utolsó sort tekinti
 * érvényesnek adott `pid`-re.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @returns {string} a ledger-gyökér (a DSH home alatt, a session-tároló mellett). */
export function ledgerRoot() {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(dshHome, 'process-ledger');
}

/**
 * Kanonizált workspace-kulcs: `realpath`, kis-nagybetű egységesítve.
 * Ha a `realpath` nem megy (törölt/áthelyezett könyvtár), a nyers útra esik
 * vissza — a ledger írása soha nem bukhat el emiatt.
 * @param {string} workspace
 * @returns {string}
 */
export function canonicalWorkspace(workspace) {
  const raw = workspace || process.cwd();
  try {
    return realpathSync.native(raw);
  } catch {
    return raw;
  }
}

/** @param {string} canonical @returns {string} sha256 hex. */
export function workspaceKey(canonical) {
  return createHash('sha256').update(canonical).digest('hex');
}

/** @param {string} canonical @returns {string} egy workspace ledger-fájlja. */
export function ledgerFileFor(canonical) {
  return join(ledgerRoot(), `${workspaceKey(canonical)}.jsonl`);
}

/**
 * Egy rekord hozzáfűzése. Szándékosan szinkron és hiba-elnyelő: a ledger
 * írása soha nem állíthatja meg a spawn-t vagy a leállítást.
 * @param {string} file
 * @param {object} record
 * @returns {boolean} sikerült-e kiírni.
 */
export function appendRecord(file, record) {
  try {
    mkdirSync(ledgerRoot(), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * A ledger visszajátszása: PID-enként az utolsó érvényes rekord.
 * A `spawn` és `identity` sorok összeolvadnak, az `exit` sorból tombstone lesz.
 * @param {string} file
 * @returns {Map<number, object>} pid -> összevont rekord
 */
export function replayLedger(file) {
  /** @type {Map<number, object>} */
  const byPid = new Map();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return byPid;
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // félig írt sor — kihagyjuk, nem bukunk el rajta
    }
    const pid = record?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (record.t === 'exit') {
      byPid.set(pid, { ...(byPid.get(pid) ?? {}), t: 'exit' });
      continue;
    }
    const previous = byPid.get(pid);
    if (previous?.t === 'exit') continue; // újrahasznosított PID új spawn-ja külön rekord lesz
    byPid.set(pid, { ...previous, ...record });
  }
  return byPid;
}

/**
 * Az összes ismert workspace ledgerje.
 * @returns {Array<{file: string, records: Map<number, object>}>}
 */
export function readAllLedgers() {
  const root = ledgerRoot();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // még nincs ledger — ez a normál első indulás
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = join(root, entry.name);
    const records = replayLedger(file);
    if (records.size > 0) out.push({ file, records });
  }
  return out;
}

/**
 * A PID nélkül rögzített („untracked") spawn-rekordok.
 *
 * MIÉRT: a mag `spawn()` handle-je nem ad PID-et (mért: `stdin, stdout, stderr,
 * collected, done, terminate, terminateForHostExit, waitForExit`), ezért a
 * hosszú életű folyamat csak a parancssora és az időpontja alapján azonosítható.
 * Ezeket a rekordokat induláskor párosítja a plugin a futó folyamatokhoz.
 * @param {number} [maxAgeMs] ennél régebbi rekordot eldobunk (alapból 7 nap)
 * @returns {Array<{file: string, record: object}>}
 */
export function readUntracked(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const root = ledgerRoot();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    if (entry.name === '_diag.jsonl') continue;
    const file = join(root, entry.name);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.t !== 'untracked') continue;
      if (!Number.isFinite(record.at) || now - record.at > maxAgeMs) continue;
      out.push({ file, record });
    }
  }
  return out;
}

/**
 * Egy ledger-fájl tömörítése: a régi `untracked` sorok (ezek csak a párosításhoz
 * kellettek) és a félig írt sorok kiesnek, minden más marad. Atomikusan cserél
 * (temp + rename), hogy egy megszakadt írás ne hagyjon csonka fájlt.
 * @param {string} file
 * @param {number} keepUntrackedMs ennyi ideig marad meg egy PID nélküli rekord
 *   párosítási esélye. MÉRT OK (2026-11-13): 1 óra túl rövid volt a valós
 *   helyreállítási helyzetre (a felhasználó később indítja újra a harness-t),
 *   ezért 24 óra; a rekordok ~200 B/hívás méretűek.
 * @returns {{kept: number, removed: number}}
 */
export function compactLedger(file, keepUntrackedMs = 24 * 60 * 60 * 1000) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { kept: 0, removed: 0 };
  }
  const now = Date.now();
  const kept = [];
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      removed += 1; // félig írt sor
      continue;
    }
    if (record?.t === 'untracked' && Number.isFinite(record.at) && now - record.at > keepUntrackedMs) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return { kept: kept.length, removed: 0 };
  const temporary = `${file}.compact-tmp`;
  writeFileSync(temporary, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8');
  renameSync(temporary, file);
  return { kept: kept.length, removed };
}

/**
 * A diagnosztikai napló forgatása: felső korlát felett csak az utolsó 200 sor
 * marad. Enélkül a `_diag.jsonl` minden indulással és minden PID nélküli
 * spawn-nal nőne.
 * @param {string} file
 * @param {number} maxBytes
 * @returns {{removed: number}}
 */
function compactDiag(file, maxBytes = 262_144) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return { removed: 0 };
  }
  if (size <= maxBytes) return { removed: 0 };
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
  const keptLines = lines.slice(-200);
  const temporary = `${file}.compact-tmp`;
  writeFileSync(temporary, keptLines.length === 0 ? '' : `${keptLines.join('\n')}\n`, 'utf8');
  renameSync(temporary, file);
  return { removed: lines.length - keptLines.length };
}

/**
 * Az összes ledger (és a diagnosztika) tömörítése. Induláskor hívjuk, egyszer.
 * @param {number} [keepUntrackedMs]
 * @returns {{files: number, removed: number}}
 */
export function compactAll(keepUntrackedMs = 24 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = readdirSync(ledgerRoot(), { withFileTypes: true });
  } catch {
    return { files: 0, removed: 0 };
  }
  const summary = { files: 0, removed: 0 };
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = join(ledgerRoot(), entry.name);
    const result = entry.name === '_diag.jsonl' ? compactDiag(file) : compactLedger(file, keepUntrackedMs);
    summary.files += 1;
    summary.removed += result.removed;
  }
  return summary;
}

