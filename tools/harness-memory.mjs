#!/usr/bin/env node
/**
 * harness-memory.mjs — a futó harness memóriatrendje (dsh-heap-guard napló).
 *
 * MIÉRT: 2026-11-23 18:15:35-kor a 46 órája futó harness V8 heap OOM-mal
 * leállt (3 285,6 MB / 4 288 MB plafon, `state\harness.err.log`), a tálca
 * 11 s múlva újraindította. A növekedést azóta a `dsh-heap-guard` méri
 * (`state\harness-memory.jsonl`, 5 percenként).
 *
 * MIT MUTAT: a jelenlegi folyamat heap-plafonja (a tálca `--max-old-space-size`
 * flagje érvényes-e!), a használat %-a, a mért növekedés MB/órában és a
 * becsült hátralévő idő a kritikus szintig.
 *
 * Használat: node tools/harness-memory.mjs [--json]
 * Kilépés: 0 = ok, 1 = high/critical (a következő nyugodt pillanatban
 *          érdemes újraindítani), 2 = nincs mérés.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITICAL_RATIO, HIGH_RATIO, estimateTrend } from '../plugins/dsh-heap-guard/lib/memory.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(REPO, 'state', 'harness-memory.jsonl');
const PID_FILE = join(REPO, 'state', 'harness.pid');
const asJson = process.argv.includes('--json');

/** @returns {Array<object>} */
function readSamples() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((entry) => entry !== undefined && typeof entry.at === 'number');
}

const samples = readSamples();
if (samples.length === 0) {
  console.log(`Nincs mérés: ${FILE}`);
  console.log('A dsh-heap-guard a telepítés után néhány másodperccel kezd mérni (a profil-patch a futó processzbe is betöltődik), és 5 percenként ír egy sort.');
  process.exit(2);
}

const livePid = existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8').trim()) : NaN;
const forPid = samples.filter((sample) => Number.isFinite(livePid) ? sample.pid === livePid : true);
const current = (forPid.length > 0 ? forPid : samples).at(-1);
const trend = estimateTrend(forPid.length > 0 ? forPid : samples, current.heapLimitMB);
const limitRaised = current.heapLimitMB > 4400;

const summary = {
  file: FILE,
  pid: current.pid,
  livePid: Number.isFinite(livePid) ? livePid : undefined,
  samples: (forPid.length > 0 ? forPid : samples).length,
  limitMB: current.heapLimitMB,
  limitRaised,
  heapUsedMB: current.heapUsedMB,
  heapUsedPercent: current.heapUsedPercent,
  level: current.level,
  rssMB: current.rssMB,
  uptimeHours: Math.round((current.uptimeSeconds / 3600) * 10) / 10,
  lastAt: new Date(current.at).toISOString(),
  trend,
  action:
    current.level === 'critical'
      ? 'a leállás közeli: indítsd újra a harness-t a tálca menüjéből, amikor éppen nincs futó munka'
      : current.level === 'high'
        ? 'figyeld: a következő nyugodt pillanatban érdemes újraindítani'
        : 'nincs teendő'
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('==> Harness memória (dsh-heap-guard)');
  console.log(`  pid:            ${summary.pid}${summary.livePid !== undefined && summary.livePid !== summary.pid ? ` (a state\\harness.pid szerint: ${summary.livePid})` : ''}`);
  console.log(`  heap:           ${summary.heapUsedMB} MB / ${summary.limitMB} MB (${summary.heapUsedPercent}%, ${summary.level})`);
  console.log(`  rss / uptime:   ${summary.rssMB} MB / ${summary.uptimeHours} óra`);
  console.log(`  minták:         ${summary.samples} (utolsó: ${summary.lastAt})`);
  if (summary.trend !== undefined) {
    console.log(`  trend:          ${summary.trend.perHourMB} MB/óra${summary.trend.hoursToCritical === undefined ? '' : `, a kritikus (${Math.round(CRITICAL_RATIO * 100)}%) szintig ~${summary.trend.hoursToCritical} óra`}`);
  } else {
    console.log('  trend:          még nincs elég minta (2 minta kell)');
  }
  console.log(`  plafon:         ${limitRaised ? 'emelt (a tálca --max-old-space-size flagje érvényes)' : 'ALAP (4 288 MB) — a tálca új verziója a következő tálca-indításnál lép életbe'}`);
  console.log(`  teendő:         ${summary.action}`);
}

process.exit(current.level === 'ok' ? 0 : 1);
