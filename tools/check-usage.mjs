#!/usr/bin/env node
/**
 * check-usage.mjs — the cost engine behind the statistics row.
 *
 * Run from anywhere:  node tools/check-usage.mjs
 *
 * The row shows a cost, so the two things it is made of must be right:
 *
 *   1. the RATE — DeepSeek bills input cache hits, input cache misses and output
 *      separately, and every rate doubles in the peak windows (weekdays
 *      01:00-04:00 and 06:00-10:00 UTC). A remembered price table without the
 *      peak/off-peak split is off by up to 2x on every request, which is what
 *      the earlier build showed;
 *   2. the SCAN — the durable session logs are append-only zstd streams, one
 *      frame per append. A single-frame reader silently returns only the
 *      session header, so a wrong reader answers "no usage at all" instead of
 *      failing loudly. This script runs the real scan over the real logs.
 */
import { holidaysCovered, isFreeModel, isPeakInstant, modelPrices, requestCost, scanUsage, sessionsRoot } from '../plugins/dsh-ui-extras/lib/index.js';

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

const utc = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min);

/* --- 1) the peak windows --------------------------------------------------- */
// 2026-09-23 is a Wednesday; 2026-09-26 a Saturday. Chinese public holidays
// (State Council notice for 2026) are off-peak even on a weekday: 2026-10-01
// (National Day, Thursday) and 2026-02-16 (Spring Festival, Monday) below.
const cases = [
  [utc(2026, 9, 23, 2), true, 'weekday 02:00 UTC is peak'],
  [utc(2026, 9, 23, 5), false, 'weekday 05:00 UTC is off-peak (between the windows)'],
  [utc(2026, 9, 23, 7), true, 'weekday 07:00 UTC is peak'],
  [utc(2026, 9, 23, 10), false, 'weekday 10:00 UTC is off-peak (the window is half-open)'],
  [utc(2026, 9, 23, 12), false, 'weekday noon is off-peak'],
  [utc(2026, 9, 23, 0), false, 'weekday midnight UTC is off-peak'],
  [utc(2026, 9, 26, 2), false, 'Saturday 02:00 UTC is off-peak'],
  [utc(2026, 9, 27, 7), false, 'Sunday 07:00 UTC is off-peak'],
  [utc(2026, 10, 1, 2), false, 'National Day (Thursday) is off-peak — a holiday never peaks'],
  [utc(2026, 10, 1, 7), false, 'National Day afternoon is off-peak too'],
  [utc(2026, 10, 7, 2), false, 'the last National Day holiday day is off-peak'],
  [utc(2026, 10, 8, 2), true, 'the working day after National Day is peak again'],
  [utc(2026, 2, 16, 7), false, 'Spring Festival (Monday) is off-peak'],
  [utc(2026, 2, 24, 2), true, 'the Tuesday after Spring Festival is peak again']
];
for (const [time, expected, label] of cases) {
  if (isPeakInstant(time) === expected) ok(label);
  else fail(`${label} (got ${isPeakInstant(time)})`);
}
if (holidaysCovered().includes('2026')) ok('the holiday table covers 2026');
else fail('the holiday table does not cover 2026');

/* --- 2) the rates --------------------------------------------------------- */
const peak = utc(2026, 9, 23, 2);
const offPeak = utc(2026, 9, 23, 12);
const million = { inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000 };
const flashPeak = requestCost(million, 'deepseek-flash', peak);
const flashOff = requestCost(million, 'deepseek-flash', offPeak);
if (Math.abs(flashPeak - 1.506) < 1e-6) ok('1M of each Flash token at peak costs $1.506 (0.30 + 0.006 + 1.20)');
else fail(`Flash peak cost is $${flashPeak}, expected $1.506`);
if (Math.abs(flashOff * 2 - flashPeak) < 1e-6) ok('off-peak is exactly half the peak rate');
else fail(`off-peak $${flashOff} is not half of $${flashPeak}`);
const proPeak = requestCost(million, 'deepseek-v4-pro', peak);
if (Math.abs(proPeak - 5.324) < 1e-6) ok('1M of each Pro token at peak costs $5.324 (1.32 + 0.044 + 3.96)');
else fail(`Pro peak cost is $${proPeak}, expected $5.324`);
if (Math.abs(requestCost(million, 'deepseek-v4-flash-vision-exp', peak) - flashPeak) < 1e-6) ok('the retired Flash names are billed at the Flash rate');
else fail('a retired Flash name is not billed at the Flash rate');
if (modelPrices('something-unknown').key === 'deepseek-flash') ok('an unknown model falls back to the Flash price row');
else fail('an unknown model did not fall back');

/* --- 2b) the free / paid line --------------------------------------------- */
// A delegated child that ran on the zero-priced fallback chain is the ONLY kind
// that saves money. A child that stayed on the paid route costs what the parent
// would have, so counting it as a saving would overstate the number.
if (isFreeModel('worker')) ok('the fallback chain model is free');
else fail('the fallback chain model is not priced as free');
if (isFreeModel('openai/gpt-oss-120b')) ok('a chain member id is free by its substring');
else fail('a chain member id is not free');
if (isFreeModel('deepseek-flash') === false) ok('the paid parent route is not free');
else fail('the paid parent route is priced as free');
if (isFreeModel('some-unknown-model') === false) ok('an unknown model is never free (it falls back to Flash)');
else fail('an unknown model is priced as free');

/* --- 3) the real scan over the real logs ---------------------------------- */
const root = sessionsRoot();
console.log(`  info session logs: ${root}`);
const started = Date.now();
const usage = await scanUsage(30, null);
const elapsed = Date.now() - started;
if (usage && usage.ok === true) ok(`the scan ran (${usage.scanned} log(s) read, ${usage.skipped} old one(s) skipped, ${elapsed} ms)`);
else fail('the scan did not return ok');

if (usage && usage.files > 0) {
  if (usage.totals.requests > 0) ok(`requests found in the window: ${usage.totals.requests}`);
  else fail('the scan found no requests although session logs exist (a single-frame zstd reader would do exactly this)');
  if (usage.totals.total > 0) ok(`tokens summed: ${usage.totals.total}`);
  else fail('the scan summed no tokens');
  if (usage.totals.costUsd > 0) ok(`cost summed: $${usage.totals.costUsd.toFixed(4)}`);
  else fail('the scan summed no cost');
  if (usage.perDay.length > 0) ok(`per-day buckets: ${usage.perDay.map((day) => day.day).join(', ')}`);
  else fail('no per-day buckets');
  if (usage.perModel.length > 0) ok(`models seen: ${usage.perModel.map((model) => model.model).join(', ')}`);
  else fail('no model breakdown');
  const daySum = usage.perDay.reduce((sum, day) => sum + day.costUsd, 0);
  if (Math.abs(daySum - usage.totals.costUsd) < 1e-6) ok('the per-day costs add up to the total');
  else fail(`per-day sum $${daySum} != total $${usage.totals.costUsd}`);
} else {
  console.log('  info no session logs in the window — the scan itself was still exercised');
}

/* --- 4) the delegated split over the real logs ---------------------------- */
if (usage && usage.delegated) {
  const delegated = usage.delegated;
  const pockets = ['free', 'paid'];
  for (const name of pockets) {
    if (delegated[name] === undefined) fail(`the delegated block has no '${name}' pocket`);
  }
  if (pockets.every((name) => delegated[name] !== undefined)) {
    const free = delegated.free;
    const paid = delegated.paid;
    if (free.requests + paid.requests === delegated.requests) ok('the free and paid request counts add up to every delegated request');
    else fail(`free ${free.requests} + paid ${paid.requests} != delegated ${delegated.requests}`);
    if (Math.abs((free.costUsd + paid.costUsd) - delegated.costUsd) < 1e-9) ok('the pocket costs add up to the delegated cost');
    else fail('the pocket costs do not add up');
    if (free.costUsd === 0) ok('the free chain costs nothing');
    else fail(`the free pocket cost $${free.costUsd} is not zero`);
    if (Math.abs(delegated.freeSavingsUsd - Math.max(0, free.baselineUsd - free.costUsd)) < 1e-9) ok('the free-chain saving is its own baseline minus its own cost');
    else fail('the free-chain saving is not derived from its own pocket');
    if (Math.abs((delegated.savedUsd || 0) - Math.max(0, delegated.baselineUsd - delegated.costUsd)) < 1e-9) ok('the blended saving stays the whole delegated baseline minus its cost');
    else fail('the blended saving is inconsistent with the delegated totals');
    if (delegated.lastAt === null || typeof delegated.lastAt === 'number') ok(`the last delegation instant is reported (${delegated.lastAt === null ? 'none' : new Date(delegated.lastAt).toISOString()})`);
    else fail('lastAt is neither null nor a number');
    const modelRequests = (delegated.models ?? []).reduce((sum, entry) => sum + entry.requests, 0);
    if (modelRequests === delegated.requests) ok('the per-model breakdown covers every delegated request');
    else fail(`the per-model breakdown covers ${modelRequests} of ${delegated.requests} requests`);
    for (const entry of delegated.models ?? []) {
      if (entry.free === isFreeModel(entry.model)) ok(`delegated model '${entry.model}' is tagged correctly`);
      else fail(`delegated model '${entry.model}' has the wrong free tag`);
    }
  }
} else {
  fail('the scan returned no delegated block');
}

console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
