/**
 * Intervallum-matematika — a „valós idő" és a párhuzamos session-ök kezelése.
 *
 * Miért kell: két párhuzamosan futó beszélgetés ugyanabban az órában két
 * gép-munka (összeadódik), de UGYANAZ az emberi óra (unió). A nyers
 * session-élettartam pedig napokat ölel át, ezért csak tétlenség-plafonnal és
 * uniózva értelmezhető.
 */

/** @typedef {{start: number, end: number}} Interval */

const valid = (interval) => interval !== null && typeof interval === "object"
  && Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start;

/**
 * Egymást átfedő vagy érintkező intervallumok összevonása.
 * @param {Interval[]} intervals
 * @returns {Interval[]} időrendben, nem átfedő
 */
export function union(intervals) {
  const list = intervals.filter(valid).map((interval) => ({ start: interval.start, end: interval.end }));
  list.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of list) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

/**
 * Unió, de a `slackMs`-nél rövidebb réseket is áthidalja.
 *
 * Ez adja az „aktív naptári időt”: a körök közötti pár perces szünet még
 * ugyanaz a munkamenet, a félórás ebédszünet már nem.
 * @param {Interval[]} intervals
 * @param {number} slackMs
 */
export function unionWithSlack(intervals, slackMs) {
  const slack = Number.isFinite(slackMs) && slackMs > 0 ? slackMs : 0;
  const list = intervals.filter(valid).map((interval) => ({ start: interval.start, end: interval.end }));
  list.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of list) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start - last.end <= slack) {
      if (interval.end > last.end) last.end = interval.end;
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

/** Összhossz (ms) — az uniót feltételezve, de átfedést is helyesen kezel. */
export function totalMs(intervals) {
  return union(intervals).reduce((sum, interval) => sum + (interval.end - interval.start), 0);
}

/** Nyers összeg (ms) — átfedések benne maradnak (erőforrás-számításhoz). */
export function sumMs(intervals) {
  return intervals.filter(valid).reduce((sum, interval) => sum + (interval.end - interval.start), 0);
}

/**
 * Intervallumok levágása egy ablakra.
 * @param {Interval[]} intervals
 * @param {number} from epoch ms (befelé)
 * @param {number} to epoch ms (befelé)
 * @returns {Interval[]}
 */
export function clip(intervals, from, to) {
  const lo = Number.isFinite(from) ? from : Number.NEGATIVE_INFINITY;
  const hi = Number.isFinite(to) ? to : Number.POSITIVE_INFINITY;
  const out = [];
  for (const interval of union(intervals)) {
    const start = Math.max(interval.start, lo);
    const end = Math.min(interval.end, hi);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/**
 * Egy intervallum hossza `capMs`-re vágva.
 * @param {number} start
 * @param {number} end
 * @param {number} capMs
 */
export function cappedLength(start, end, capMs) {
  if (!(end > start)) return 0;
  const length = end - start;
  if (!Number.isFinite(capMs) || capMs <= 0) return length;
  return Math.min(length, capMs);
}

/** Az intervallumok metszet-hossza egy [from, to) ablakkal. */
export function overlapMs(intervals, from, to) {
  if (!(to > from)) return 0;
  return clip(intervals, from, to).reduce((sum, interval) => sum + (interval.end - interval.start), 0);
}

/** Az intervallumok kivonása: `base` mínusz `remove`. */
export function subtract(base, remove) {
  const holes = union(remove);
  const out = [];
  for (const interval of union(base)) {
    let start = interval.start;
    for (const hole of holes) {
      if (hole.end <= start) continue;
      if (hole.start >= interval.end) break;
      if (hole.start > start) out.push({ start, end: Math.min(hole.start, interval.end) });
      start = Math.max(start, hole.end);
      if (start >= interval.end) break;
    }
    if (start < interval.end) out.push({ start, end: interval.end });
  }
  return out;
}
