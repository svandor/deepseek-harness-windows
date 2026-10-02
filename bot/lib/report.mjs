/**
 * Házirobot — riportírás és e-mail-törzs.
 *
 * A riport a `bot/reports/<dátum>/<job>-<idő>.md` fájlba kerül (ez a tartós
 * bizonyíték), az e-mail pedig rövid, emberi összefoglalót kap.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
    time: `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`,
    full: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`,
  };
}

export function writeReport({ reportsDir, job, status, summary, body, data, log }) {
  // A `log` lehet függvény vagy logger-objektum is — mindkettőt kezeljük.
  const emit = typeof log === 'function' ? log : (message) => log?.info?.(message);
  const s = stamp();
  const dir = join(reportsDir, s.day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${job.id}-${s.time}.md`);
  const lines = [
    `# ${job.leiras ?? job.id}`,
    '',
    `- **Job:** \`${job.id}\``,
    `- **Időpont:** ${s.full}`,
    `- **Állapot:** ${status}`,
    '',
    '## Összefoglaló',
    '',
    summary || '_(nincs összefoglaló)_',
    '',
  ];
  if (body) lines.push('## Részletek', '', body, '');
  if (data !== undefined) {
    lines.push('## Nyers adat', '', '```json', JSON.stringify(data, null, 2), '```', '');
  }
  writeFileSync(path, lines.join('\n'), 'utf8');
  emit(`riport: ${path}`);
  return path;
}

export function emailBody({ job, status, summary, reportPath, details = [] }) {
  const s = stamp();
  const subject = `[${job.leiras ?? job.id}] ${status} — ${s.day}`;
  const text = [
    `${job.leiras ?? job.id}`,
    `Időpont: ${s.full}`,
    `Állapot: ${status}`,
    '',
    summary || '(nincs összefoglaló)',
    '',
    ...details,
    '',
    `Riport: ${reportPath}`,
    '',
    '— Házirobot',
  ].join('\n');
  return { subject, text };
}

export { stamp };
