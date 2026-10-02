/**
 * Házirobot — állapot- és nyilvántartás-tár (beépített node:sqlite, külső függőség nélkül).
 *
 * Három dolgot tart nyilván:
 *  - `runs`:      minden job-futás (állapot, költség, riport)
 *  - `kv`:        kis kulcs-érték tár (pl. oldal-hashek a konkurencia-figyelőhöz)
 *  - `far_ledger`: a külső rendszerbe küldött tételek naplója (audit, idempotencia)
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  report_path TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  llm_used INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_job_idx ON runs(job_id, started_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, k)
);

CREATE TABLE IF NOT EXISTS far_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  jelentkezes_id TEXT,
  far_nive_id TEXT,
  tipus TEXT,
  fazis TEXT,
  result_id INTEGER,
  sigma_before INTEGER,
  sigma_after INTEGER,
  status TEXT NOT NULL,
  detail TEXT,
  payload_hash TEXT,
  run_dir TEXT
);
CREATE INDEX IF NOT EXISTS far_ledger_key_idx ON far_ledger(jelentkezes_id, far_nive_id, tipus);
`;

let db;

export function openState(dbPath) {
  if (db) return db;
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function startRun(jobId) {
  const info = db
    .prepare('INSERT INTO runs (job_id, started_at, status) VALUES (?, ?, ?)')
    .run(jobId, new Date().toISOString(), 'fut');
  return Number(info.lastInsertRowid);
}

export function finishRun(id, { status, detail, reportPath, tokensIn = 0, tokensOut = 0, costUsd = 0, llmUsed = false }) {
  db.prepare(
    `UPDATE runs SET finished_at = ?, status = ?, detail = ?, report_path = ?,
       tokens_in = ?, tokens_out = ?, cost_usd = ?, llm_used = ? WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    status,
    detail ?? null,
    reportPath ?? null,
    tokensIn,
    tokensOut,
    costUsd,
    llmUsed ? 1 : 0,
    id,
  );
}

export function recentRuns(limit = 20) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
}

export function runsForDay(day) {
  return db.prepare("SELECT * FROM runs WHERE started_at LIKE ? ORDER BY id DESC").all(`${day}%`);
}

export function kvGet(ns, key) {
  const row = db.prepare('SELECT v FROM kv WHERE ns = ? AND k = ?').get(ns, key);
  return row ? row.v : undefined;
}

export function kvSet(ns, key, value) {
  db.prepare(
    `INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  ).run(ns, key, String(value), new Date().toISOString());
}

export function farLedgerAdd(entry) {
  db.prepare(
    `INSERT INTO far_ledger
      (ts, jelentkezes_id, far_nive_id, tipus, fazis, result_id, sigma_before, sigma_after, status, detail, payload_hash, run_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.jelentkezesId ?? null,
    entry.farNiveId ?? null,
    entry.tipus ?? null,
    entry.fazis ?? null,
    entry.resultId ?? null,
    entry.sigmaBefore ?? null,
    entry.sigmaAfter ?? null,
    entry.status,
    entry.detail ?? null,
    entry.payloadHash ?? null,
    entry.runDir ?? null,
  );
}

export function farLedgerLast(jelentkezesId, farNiveId, tipus) {
  return db
    .prepare(
      `SELECT * FROM far_ledger WHERE jelentkezes_id = ? AND far_nive_id = ? AND tipus = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(jelentkezesId, farNiveId, tipus);
}

export function farLedgerRecent(limit = 50) {
  return db.prepare('SELECT * FROM far_ledger ORDER BY id DESC LIMIT ?').all(limit);
}
