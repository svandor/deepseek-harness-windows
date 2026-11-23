/**
 * dsh-heap-guard — a futó harness memóriájának telemetriája.
 *
 * MIÉRT (mért eset, 2026-11-23 18:15:35): a 46 órája futó harness pid 26332
 * leállt V8 heap OOM-mal (`state\harness.err.log`: „FATAL ERROR: Ineffective
 * mark-compacts near heap limit … JavaScript heap out of memory”, 3 285,6 MB
 * használt heap, 4 288 MB alap plafon). A tálca 11 s múlva újraindította, de a
 * megszakadt kör elveszett — eddig SEMMI nem mérte a növekedést, ezért a
 * leállás váratlan volt.
 *
 * MIT TESZ: 5 percenként egy JSONL sor a `state\harness-memory.jsonl`-be
 * (heap/limit %, rss, external, uptime, V8 plafon), és a plafon 75% / 90%-a
 * fölött WARN a harness naplójába — a trend innen kiolvasható
 * (`node tools\harness-memory.mjs`), így a munkamenetek NYUGODT pillanatban
 * indíthatók újra (AGENTS.md 1.5: a felhasználó dönt).
 *
 * BIZTONSÁG: a plugin soha nem állíthatja meg a bootot (minden hívás
 * try/catch), a napló 512 KB-nál újraindul, az időzítő `unref`-elt, a plugin
 * leállásakor törlődik.
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import {
  DEFAULT_INTERVAL_MS,
  LOG_MAX_BYTES,
  PEAK_INTERVAL_MS,
  describeSample,
  estimateTrend,
  heapSample,
  isNewPeak,
  levelWorsened
} from './memory.js';

/** A plugin neve a boot gráfban. */
const name = 'dsh-heap-guard';

/** Nincs kötelező szolgáltatás. */
const inject = [];

/** A napló a repó `state\` mappájában (a plugin a repóban él). */
const MEMORY_FILE = fileURLToPath(new URL('../../../state/harness-memory.jsonl', import.meta.url));

/** Biztonságos naplózás a harness loggerébe. */
function logLine(ctx, level, message) {
  try {
    ctx?.logger?.[level]?.(`[${name}] ${message}`);
  } catch {
    /* a log nem kritikus */
  }
}

/**
 * Egy sor hozzáfűzése a telemetria-fájlhoz (méretkorláttal, hibaelnyeléssel).
 * @param {string} file
 * @param {object} record
 * @returns {boolean}
 */
export function appendSample(file, record) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_MAX_BYTES) truncateSync(file, 0);
    } catch {
      /* még nincs fájl */
    }
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Plugin belépési pont.
 * @param {object} ctx
 * @param {{file?: string, intervalMs?: number}} [config]
 */
function apply(ctx, config = {}) {
  const file = config.file ?? MEMORY_FILE;
  const intervalMs = Math.max(10_000, Number(config.intervalMs) || DEFAULT_INTERVAL_MS);
  /** @type {Array<{at: number, heapUsedMB: number}>} */
  const recent = [];
  let previousLevel;
  /** Az eddigi legnagyobb mért heap (MB) — a hirtelen csúcsök kimutatásához. */
  let peakMB = Number.NaN;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let peakTimer;

  /**
   * @param {string} kind
   * @param {boolean} [force] - csúcsnál is írunk, ha az érték rekord.
   */
  function sampleOnce(kind, force = false) {
    try {
      const usage = process.memoryUsage();
      const stats = getHeapStatistics();
      const sample = heapSample(usage, stats, process.uptime());
      const peak = isNewPeak(peakMB, sample.heapUsedMB);
      if (!force && kind === 'peak' && !peak) return undefined;
      if (peak) peakMB = sample.heapUsedMB;
      recent.push({ at: sample.at, heapUsedMB: sample.heapUsedMB });
      if (recent.length > 48) recent.shift();
      const written = appendSample(file, { kind, pid: process.pid, ...sample });

      if (kind === 'boot') {
        logLine(ctx, 'info', `memória-plafon: ${sample.heapLimitMB} MB (indulás: ${describeSample(sample)})`);
      }
      if (levelWorsened(previousLevel, sample.level)) {
        const trend = estimateTrend(recent, sample.heapLimitMB);
        const eta =
          trend !== undefined && trend.hoursToCritical !== undefined
            ? `, a kritikus szintig ~${trend.hoursToCritical} óra a mért ${trend.perHourMB} MB/óra mellett`
            : '';
        const advice =
          sample.level === 'critical'
            ? ' — a leállás KÖZELI: a következő nyugodt pillanatban indítsd újra a harness-t (tálca menü), különben a folyamat heap OOM-mal leáll'
            : ' — figyeld: a harness hosszú futás után heap OOM-mal leállhat (mért: 2026-11-23)';
        logLine(ctx, 'warn', `${describeSample(sample)}${eta}${advice}`);
      }
      previousLevel = sample.level;
      return { sample, written };
    } catch (error) {
      logLine(ctx, 'warn', `minta hiba: ${String(error)}`);
      return undefined;
    }
  }

  try {
    sampleOnce('boot', true);
    timer = setInterval(() => sampleOnce('sample', true), intervalMs);
    timer.unref?.();
    // Csúcsfigyelő: 10 másodpercenként nézzük, de csak REKORD esetén írunk sort —
    // így az 5 perces minták közé eső hirtelen foglalás is nyomot hagy.
    peakTimer = setInterval(() => sampleOnce('peak'), PEAK_INTERVAL_MS);
    peakTimer.unref?.();
    ctx.on?.('dispose', () => {
      if (timer !== undefined) clearInterval(timer);
      if (peakTimer !== undefined) clearInterval(peakTimer);
      timer = undefined;
      peakTimer = undefined;
    });
    logLine(ctx, 'info', `aktív — ${Math.round(intervalMs / 1000)} s-onként a ${file} fájlba, és 10 s-onként csúcsfigyelés`);
  } catch (error) {
    logLine(ctx, 'warn', `a telemetria nem indul el: ${String(error)}`);
  }
}

export { apply, inject, name };
