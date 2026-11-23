/**
 * A dsh-heap-guard tesztjei.
 *
 * A mérés a MÉRT esetből indul ki (2026-11-23 18:15:35: 3 285,6 MB használt
 * heap / 4 288 MB plafon → V8 heap OOM), ezért a tesztek ugyanezekkel a
 * számokkal bizonyítják, hogy a szint és a trend helyesen számol.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRITICAL_RATIO,
  HIGH_RATIO,
  LOG_MAX_BYTES,
  PEAK_STEP_MB,
  describeSample,
  estimateTrend,
  heapSample,
  isNewPeak,
  levelWorsened,
  memoryLevel
} from '../lib/memory.js';
import { appendSample, apply } from '../lib/index.js';

const MB = 1048576;

/** A mért OOM-pillanat (3 285,6 MB / 4 288 MB). */
const OOM_USAGE = { rss: 3800 * MB, heapUsed: 3285.6 * MB, heapTotal: 3485 * MB, external: 120 * MB, arrayBuffers: 100 * MB };
const OOM_STATS = { heap_size_limit: 4288 * MB };

test('a mért OOM-pillanat mintája: 76,6% — high szint', () => {
  const sample = heapSample(OOM_USAGE, OOM_STATS, 46 * 3600, 1_700_000_000_000);
  assert.equal(sample.heapLimitMB, 4288);
  assert.equal(sample.heapUsedMB, 3285.6);
  assert.equal(sample.heapUsedPercent, 76.6);
  assert.equal(sample.level, 'high');
  assert.equal(sample.uptimeSeconds, 165600);
  assert.match(describeSample(sample), /heap 3285\.6 MB \/ 4288 MB \(76\.6%, high\)/u);
});

test('a szintek a plafonhoz viszonyítanak, nem abszolút MB-hoz', () => {
  assert.equal(memoryLevel(10), 'ok');
  assert.equal(memoryLevel(HIGH_RATIO * 100 - 0.1), 'ok');
  assert.equal(memoryLevel(HIGH_RATIO * 100), 'high');
  assert.equal(memoryLevel(CRITICAL_RATIO * 100 - 0.1), 'high');
  assert.equal(memoryLevel(CRITICAL_RATIO * 100), 'critical');
  assert.equal(memoryLevel(Number.NaN), 'ok');

  // Ugyanaz a 3 GB használat 8 GB plafon mellett MÁR nem vészjelzés (a tálca
  // `--max-old-space-size=8192` flagje pontosan ezt éri el).
  const raised = heapSample(OOM_USAGE, { heap_size_limit: 8192 * MB }, 3600, 1);
  assert.equal(raised.heapUsedPercent, 40.1);
  assert.equal(raised.level, 'ok');
});

test('csak a romlásra figyelmeztetünk (ok→high→critical), a javulásra nem', () => {
  assert.equal(levelWorsened(undefined, 'ok'), false);
  assert.equal(levelWorsened(undefined, 'high'), true);
  assert.equal(levelWorsened('ok', 'high'), true);
  assert.equal(levelWorsened('high', 'critical'), true);
  assert.equal(levelWorsened('high', 'high'), false);
  assert.equal(levelWorsened('critical', 'high'), false);
  assert.equal(levelWorsened('critical', 'ok'), false);
  assert.equal(levelWorsened('ok', 'ismeretlen'), false);
});

test('a trend a mérésekből számol (MB/óra és hátralévő óra)', () => {
  const hour = 3600000;
  const now = 1_700_000_000_000;
  const samples = [
    { at: now, heapUsedMB: 800 },
    { at: now + hour, heapUsedMB: 900 },
    { at: now + 2 * hour, heapUsedMB: 1000 }
  ];
  const trend = estimateTrend(samples, 4288);
  assert.equal(trend.perHourMB, 100);
  // kritikus = 90% * 4288 = 3859,2 MB; hátra 2859,2 MB → 28,6 óra
  assert.equal(trend.hoursToCritical, 28.6);

  assert.deepEqual(estimateTrend([{ at: now, heapUsedMB: 900 }, { at: now + hour, heapUsedMB: 800 }], 4288), { perHourMB: -100 });
  assert.equal(estimateTrend([{ at: now, heapUsedMB: 900 }], 4288), undefined);
  assert.equal(estimateTrend([], 4288), undefined);

  // A mért valóság (46 óra alatt 430 → 3285 MB) is kijön.
  const real = estimateTrend([{ at: now, heapUsedMB: 430 }, { at: now + 46 * hour, heapUsedMB: 3285.6 }], 4288);
  assert.equal(real.perHourMB, 62.1);
  assert.ok(real.hoursToCritical > 9 && real.hoursToCritical < 10, `várt ~9,2 óra, kapott ${real.hoursToCritical}`);
});

test('a csúcsfigyelő csak REKORDNÁL ír (a hirtelen foglalás is nyomot hagy)', () => {
  assert.equal(PEAK_STEP_MB, 64);
  assert.equal(isNewPeak(Number.NaN, 300), true, 'az első minta mindig csúcs');
  assert.equal(isNewPeak(300, 320), false, 'kis ingadozás nem ír');
  assert.equal(isNewPeak(300, 363.9), false);
  assert.equal(isNewPeak(300, 364), true, '+64 MB már rekord');
  assert.equal(isNewPeak(Number.NaN, Number.NaN), false);
  assert.equal(isNewPeak(300, Number.NaN), false);
  // A mért eset: a 3 285,6 MB-os csúcs egy 5 perces mintában is látszik.
  assert.equal(isNewPeak(800, 3285.6), true);
});

test('a napló írása működik, és méretkorlátnál újraindul', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-heap-guard-'));
  const file = join(dir, 'harness-memory.jsonl');
  assert.equal(appendSample(file, { kind: 'boot', heapUsedMB: 136 }), true);
  const line = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.equal(line.kind, 'boot');
  assert.equal(line.heapUsedMB, 136);

  // A korlát feletti fájl NEM hízik tovább: a következő írás előtt nullázódik.
  writeFileSync(file, 'x'.repeat(LOG_MAX_BYTES + 10), 'utf8');
  assert.equal(appendSample(file, { kind: 'sample', heapUsedMB: 200 }), true);
  const rest = readFileSync(file, 'utf8').trim();
  assert.equal(rest.split('\n').length, 1);
  assert.equal(JSON.parse(rest).kind, 'sample');
});

test('a plugin induláskor rögzít egy mintát, és a plafont kimondja', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-heap-guard-'));
  const file = join(dir, 'harness-memory.jsonl');
  const messages = [];
  let dispose;
  const ctx = {
    logger: {
      info(message) {
        messages.push(`info: ${message}`);
      },
      warn(message) {
        messages.push(`warn: ${message}`);
      }
    },
    on(event, callback) {
      assert.equal(event, 'dispose');
      dispose = callback;
    }
  };
  apply(ctx, { file, intervalMs: 10_000 });

  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 1, 'induláskor egy boot-minta');
  assert.equal(lines[0].kind, 'boot');
  assert.equal(lines[0].pid, process.pid);
  assert.ok(lines[0].heapLimitMB > 0, 'a V8 plafon rögzítve van');
  assert.ok(messages.some((message) => message.startsWith('info:') && message.includes('memória-plafon')));
  assert.ok(messages.some((message) => message.startsWith('info:') && message.includes('csúcsfigyelés')));

  dispose?.();
});
