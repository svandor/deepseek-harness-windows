/**
 * Házirobot — job-definíciók betöltése, ellenőrzése és cron-ütemezése.
 *
 * Egy job egy JSON fájl a `bot/jobs/` mappában. A runner ezt hajtja végre:
 * determinisztikus előlépés -> (csak ha változás van) egy modellhívás -> riport -> e-mail.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = ['id', 'leiras'];

export function listJobs(jobsDir) {
  let files = [];
  try {
    files = readdirSync(jobsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const path = join(jobsDir, f);
      try {
        // A PowerShell/Notepad UTF-8 BOM-ot írhat — azt le kell vágni, különben
        // a JSON.parse elhasal, és a job "hibás definícióként" tűnik el.
        const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
        return { ...JSON.parse(text), _file: path };
      } catch (err) {
        return { id: f.replace(/\.json$/, ''), _file: path, _error: err.message };
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadJob(jobsDir, id) {
  // A jobot az `id` mező VAGY a fájlnév azonosítja (a kettő eltérhet, ezért
  // mindkettőre keresünk — így a `node run-job.mjs <job>` akkor is
  // működik, ha a fájl neve más).
  const job = listJobs(jobsDir).find((j) => j.id === id || j._file?.replace(/.*[\\/]/, '').replace(/\.json$/, '') === id);
  if (!job) throw new Error(`Nincs ilyen job: ${id}`);
  const missing = REQUIRED.filter((k) => !job[k]);
  if (missing.length) throw new Error(`A job (${id}) hianyzó mezői: ${missing.join(', ')}`);
  return job;
}

export function validateJobs(jobsDir) {
  const jobs = listJobs(jobsDir);
  const problems = [];
  for (const job of jobs) {
    if (job._error) problems.push(`${job.id}: ervenytelen JSON (${job._error})`);
    for (const key of REQUIRED) if (!job[key]) problems.push(`${job.id}: hianyzik a "${key}"`);
    if (job.schedule?.kifejezes && !isValidCron(job.schedule.kifejezes)) {
      problems.push(`${job.id}: ervenytelen cron: "${job.schedule.kifejezes}"`);
    }
    if (job.schedule?.kifejezes && !job.eloSzkript && !job.prompt) {
      problems.push(`${job.id}: nincs sem eloSzkript, sem prompt`);
    }
  }
  return { jobs, problems };
}

/* ------------------------------- cron (5 mező) ------------------------------ */

function parseField(field, min, max) {
  const values = new Set();
  for (const part of String(field).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo;
    let hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(range);
      hi = Number(range);
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || step < 1) throw new Error(`erventelen mezo: ${field}`);
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) values.add(v);
  }
  return values;
}

export function isValidCron(expr) {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('a cron 5 mezos legyen: perc ora nap honap napja');
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
  };
}

export function cronMatches(expr, date = new Date()) {
  const c = parseCron(expr);
  return (
    c.minute.has(date.getMinutes()) &&
    c.hour.has(date.getHours()) &&
    c.month.has(date.getMonth() + 1) &&
    (c.dom.has(date.getDate()) || c.dow.has(date.getDay()))
  );
}

/** Melyik jobok esedékesek most, és melyek futottak már ebben a percben? */
export function dueJobs(jobs, now = new Date(), recentlyRunIds = new Set()) {
  return jobs.filter((job) => {
    const expr = job.schedule?.kifejezes;
    if (!expr || job.schedule?.tipus === 'webhook') return false;
    if (recentlyRunIds.has(job.id)) return false;
    try {
      return cronMatches(expr, now);
    } catch {
      return false;
    }
  });
}
