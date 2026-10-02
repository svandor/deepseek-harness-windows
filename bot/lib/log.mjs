/**
 * Házirobot — strukturált napló.
 *
 * Minden futás JSONL-t ír a `state/bot.log`-ba, és emberi sorokat a konzolra.
 * A napló a bot "emlékezete": a heti riport és a hibakeresés ebből dolgozik.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_FILE = join(ROOT, 'bot', 'state', 'bot.log');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function write(level, scope, message, extra) {
  const entry = { ts: new Date().toISOString(), level, scope, message, ...(extra ?? {}) };
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* a napló írása sosem buktathatja meg a futást */
  }
  const line = `${stamp()} [${level}] ${scope}: ${message}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  return entry;
}

/** Napló egy adott hatókörhöz (pl. job-azonosítóhoz) kötve. */
export function logger(scope) {
  return {
    info: (message, extra) => write('INFO', scope, message, extra),
    warn: (message, extra) => write('WARN', scope, message, extra),
    error: (message, extra) => write('ERROR', scope, message, extra),
    ok: (message, extra) => write('OK', scope, message, extra),
  };
}

export const LOG_PATH = LOG_FILE;
