/**
 * dsh-heap-guard — a harness SAJÁT memóriájának TISZTA mérője.
 *
 * MIÉRT: 2026-11-23 18:15:35-kor a 46 órája futó harness (pid 26332) leállt:
 * `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed -
 * JavaScript heap out of memory` (`state\harness.err.log`). A GC-sorok szerint
 * 3 285,6 MB használt heap mellett a V8 nem tudott tovább foglalni; a Node
 * alap plafonja ezen a gépen 4 288 MB. A tálca 11 s múlva újraindította, de a
 * megszakadt körök elvesztek — a folyamat NÖVEKEDÉSÉT eddig SEMMI nem mérte.
 *
 * Ez a modul csak számol (FS/cordis nélkül): a minta alakja, a szint
 * (ok/high/critical) és a trend-becslés tesztelhető.
 *
 * @module dsh-heap-guard/lib/memory
 */

/** A „magas" szint: a plafon ennyi %-a fölött figyelmeztetünk. */
export const HIGH_RATIO = 0.75;

/** A „kritikus" szint: ennyi % fölött a leállás közeli. */
export const CRITICAL_RATIO = 0.9;

/** Alap mintavételi idő: 5 perc (egy nap ~288 sor, ~45 KB). */
export const DEFAULT_INTERVAL_MS = 300_000;

/** A csúcsfigyelő (high-water mark) mintavétele: 10 s — ez fogja meg a hirtelen csúcsot. */
export const PEAK_INTERVAL_MS = 10_000;

/** Csak ennyi MB-os új csúcsnál írunk sort (ne hízzon a napló). */
export const PEAK_STEP_MB = 64;

/**
 * Új csúcs-e? A 10 másodperces figyelő CSAK akkor ír sort, ha a használt heap
 * legalább `stepMB`-tal meghaladja az eddigi legnagyobbat — így egy 5 perces
 * minta alatt lezajló hirtelen foglalás is nyomot hagy, naplóáradat nélkül.
 * @param {number} peakMB - az eddigi legnagyobb mért érték (MB), lehet -Infinity.
 * @param {number} currentMB
 * @param {number} [stepMB]
 * @returns {boolean}
 */
export function isNewPeak(peakMB, currentMB, stepMB = PEAK_STEP_MB) {
  if (!Number.isFinite(currentMB)) return false;
  if (!Number.isFinite(peakMB)) return true;
  return currentMB >= peakMB + stepMB;
}

/** A naplófájl felső korlátja (fölötte újraindul, hogy ne hízzon). */
export const LOG_MAX_BYTES = 512 * 1024;

/**
 * Szint egy százalékból.
 * @param {number} percent - a heap használata a plafon %-ában.
 * @returns {'ok'|'high'|'critical'}
 */
export function memoryLevel(percent) {
  if (!Number.isFinite(percent)) return 'ok';
  if (percent >= CRITICAL_RATIO * 100) return 'critical';
  if (percent >= HIGH_RATIO * 100) return 'high';
  return 'ok';
}

/**
 * Egy minta a `process.memoryUsage()` + `v8.getHeapStatistics()` alapján.
 * @param {{rss: number, heapUsed: number, heapTotal: number, external?: number, arrayBuffers?: number}} usage
 * @param {{heap_size_limit: number}} stats
 * @param {number} [uptimeSeconds]
 * @param {number} [at] - `Date.now()` (teszthez).
 * @returns {object} a naplózandó minta (MB-ban, 1 tizedesre kerekítve).
 */
export function heapSample(usage, stats, uptimeSeconds = 0, at = Date.now()) {
  const toMb = (bytes) => Math.round((Number(bytes) || 0) / 104857.6) / 10;
  const limitMb = toMb(stats?.heap_size_limit);
  const heapUsedMb = toMb(usage?.heapUsed);
  const percent = limitMb > 0 ? Math.round((heapUsedMb / limitMb) * 1000) / 10 : 0;
  return {
    at,
    uptimeSeconds: Math.round(Number(uptimeSeconds) || 0),
    rssMB: toMb(usage?.rss),
    heapUsedMB: heapUsedMb,
    heapTotalMB: toMb(usage?.heapTotal),
    externalMB: toMb(usage?.external),
    arrayBuffersMB: toMb(usage?.arrayBuffers),
    heapLimitMB: limitMb,
    heapUsedPercent: percent,
    level: memoryLevel(percent)
  };
}

/**
 * Rosszabb lett-e a szint (ok→high, →critical)? Csak a ROMLÁSRA figyelmeztetünk,
 * hogy egy hullámzó érték ne gyártson naplóáradatot.
 * @param {string|undefined} previous
 * @param {string} next
 * @returns {boolean}
 */
export function levelWorsened(previous, next) {
  const rank = { ok: 0, high: 1, critical: 2 };
  if (!(next in rank)) return false;
  if (previous === undefined) return next !== 'ok';
  if (!(previous in rank)) return next !== 'ok';
  return rank[next] > rank[previous];
}

/**
 * Trend-becslés: hány óra a kritikus szintig, ha a mért növekedés tart.
 * A minta első és utolsó eleme közötti lineáris ráta (MB/óra).
 * @param {Array<{at: number, heapUsedMB: number}>} samples
 * @param {number} limitMB
 * @returns {{perHourMB: number, hoursToCritical?: number} | undefined}
 */
export function estimateTrend(samples, limitMB) {
  const list = Array.isArray(samples)
    ? samples.filter((s) => s !== null && typeof s === 'object' && Number.isFinite(s.at) && Number.isFinite(s.heapUsedMB))
    : [];
  if (list.length < 2) return undefined;
  const first = list[0];
  const last = list[list.length - 1];
  const hours = (last.at - first.at) / 3600000;
  if (!(hours > 0)) return undefined;
  const perHourMB = Math.round(((last.heapUsedMB - first.heapUsedMB) / hours) * 10) / 10;
  if (!(perHourMB > 0) || !(limitMB > 0)) return { perHourMB };
  const target = limitMB * CRITICAL_RATIO;
  const remaining = target - last.heapUsedMB;
  if (remaining <= 0) return { perHourMB, hoursToCritical: 0 };
  return { perHourMB, hoursToCritical: Math.round((remaining / perHourMB) * 10) / 10 };
}

/**
 * Embernek olvasható sor egy mintáról (log/riport).
 * @param {object} sample
 * @returns {string}
 */
export function describeSample(sample) {
  return (
    `heap ${sample.heapUsedMB} MB / ${sample.heapLimitMB} MB (${sample.heapUsedPercent}%, ${sample.level})` +
    `, rss ${sample.rssMB} MB, external ${sample.externalMB} MB` +
    `, uptime ${Math.round(sample.uptimeSeconds / 60)} perc`
  );
}
