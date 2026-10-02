/**
 * Házirobot — állapot-tár karbantartás.
 *
 * A fejlesztés közben keletkezett próbafutásokat törli a `runs`/`kv` táblából,
 * hogy a robot állapot-összefoglalója ne a teszteket mutassa. A `far_ledger`
 * (audit) érintetlen marad — azt soha nem töröljük.
 *
 * Használat:  node bot/tools/db-cleanup.mjs [--db=state/bot.db] [--apply]
 * Alapból csak riportál.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const dbArg = process.argv.find((a) => a.startsWith('--db='))?.slice(5) ?? 'state/bot.db';
const dbPath = isAbsolute(dbArg) ? dbArg : join(BOT, dbArg);
const apply = process.argv.includes('--apply');

/** Ezeket a job-azonosító mintákat tekintjük próbafutásnak. */
const TEST_PATTERNS = ['konkurencia-teszt%', 'teszt%'];

if (!existsSync(dbPath)) {
  console.error(`Nincs ilyen állapot-tár: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

let totalRuns = 0;
let totalKv = 0;
for (const pattern of TEST_PATTERNS) {
  const runs = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE job_id LIKE ?').get(pattern).c;
  const kv = db.prepare('SELECT COUNT(*) AS c FROM kv WHERE ns LIKE ?').get(pattern).c;
  totalRuns += runs;
  totalKv += kv;
  console.log(`${pattern}: ${runs} futás, ${kv} hash`);
  if (apply && (runs || kv)) {
    db.prepare('DELETE FROM runs WHERE job_id LIKE ?').run(pattern);
    db.prepare('DELETE FROM kv WHERE ns LIKE ?').run(pattern);
  }
}

const remaining = db.prepare('SELECT job_id, status, started_at FROM runs ORDER BY id DESC LIMIT 8').all();
console.log(
  apply
    ? `Törölve: ${totalRuns} futás, ${totalKv} hash.`
    : `(száraz futás — törléshez: --apply) Törlendő: ${totalRuns} futás, ${totalKv} hash.`,
);
console.log('Megmaradt futások:');
for (const row of remaining) {
  console.log(`  ${String(row.started_at).slice(0, 16).replace('T', ' ')}  ${row.job_id}  ${row.status}`);
}
