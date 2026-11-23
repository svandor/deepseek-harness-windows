/**
 * A dsh-model-pin tesztjei.
 *
 * A tesztek a MÉRT okot állítják elő: a harness `selectModel()` →
 * `saveSelection()` útján a `settings` `agent-default-model` szekciója a
 * legutóbb választott modellre vált. A plugin ezt állítja vissza — ezt itt
 * valódi (fake) settings-szolgáltatással, írás-számlálással bizonyítjuk, hogy
 * a javítás (a) megtörténik, (b) NEM indít végtelen hurkot, (c) lavina esetén
 * leáll (AGENTS.md 1.7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PIN,
  NAMESPACE,
  createCircuitBreaker,
  describeSelection,
  isPinned,
  parsePin,
  parsePinText,
  pinTarget,
  planCorrection
} from '../lib/pin.js';
import { apply } from '../lib/index.js';

/** A rögzített (elvárt) alapértelmezés. */
const FLASH = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };

/** A drift: amit a legutóbbi modellváltás írt a settings-be. */
const DRIFT = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' };

/** Ideiglenes mappa a pin.json-nak és a naplónak. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-model-pin-'));
}

/** Megvárja, hogy a plugin aszinkron javítás-lánca lefutjon. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Fake harness: settings-szolgáltatás a valódi szemantikával (user layer,
 * `update` merge, `mutate` path-op) + `settings/updated` esemény.
 * @param {{initial: object, rogue?: boolean}} options
 */
function mountPlugin({ initial = DRIFT, pin = FLASH, pinText, rogue = false } = {}) {
  const dir = tempDir();
  const pinPath = join(dir, 'pin.json');
  const logPath = join(dir, 'model-pin.log');
  writeFileSync(pinPath, pinText ?? JSON.stringify(pin), 'utf8');

  const state = {
    dir,
    pinPath,
    logPath,
    /** @type {object} a user layer (a settings.yaml szekciója) */
    user: { ...initial },
    /** @type {Array<{mode: string, payload: object}>} */
    writes: [],
    /** @type {Array<string>} */
    messages: [],
    /** @type {Array<Function>} */
    listeners: []
  };

  function resolved() {
    return { ...state.user };
  }

  function emit() {
    const next = resolved();
    for (const listener of state.listeners) listener(NAMESPACE, next, undefined, 'update');
  }

  const settings = {
    get(ns) {
      return ns === NAMESPACE ? resolved() : undefined;
    },
    async update(ns, patch) {
      assert.equal(ns, NAMESPACE);
      state.writes.push({ mode: 'update', payload: { ...patch } });
      state.user = { ...state.user, ...patch };
      if (rogue) {
        // A „gaz" író: minden javítás után azonnal visszaírja a driftet, hogy
        // a lavina-védelmet (fuse) bizonyítani lehessen.
        state.user = { ...DRIFT };
      }
      emit();
    },
    async mutate(ns, ops) {
      assert.equal(ns, NAMESPACE);
      state.writes.push({ mode: 'mutate', payload: ops });
      let next = { ...state.user };
      for (const op of ops) {
        if (op.path.length !== 1) continue;
        if (op.op === 'set') next[op.path[0]] = op.value;
        else delete next[op.path[0]];
      }
      state.user = next;
      if (rogue) state.user = { ...DRIFT };
      emit();
    }
  };

  const ctx = {
    logger: {
      info(message) {
        state.messages.push(`info: ${message}`);
      },
      warn(message) {
        state.messages.push(`warn: ${message}`);
      }
    },
    inject(deps, callback) {
      assert.deepEqual([...deps], ['settings']);
      const scoped = {
        settings,
        on(event, listener) {
          assert.equal(event, 'settings/updated');
          state.listeners.push(listener);
        }
      };
      callback(scoped);
    }
  };

  apply(ctx, { pinPath, logPath });
  return state;
}

/** A napló JSONL sorai. */
function logEntries(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// --- a tiszta szabály ---------------------------------------------------------

test('a pin.json érvényes, és a DeepSeek V4.1 Flash-t rögzíti', () => {
  const pin = parsePinText(readFileSync(new URL('../pin.json', import.meta.url), 'utf8'));
  assert.deepEqual(pin, DEFAULT_PIN);
  assert.equal(pin.provider, 'deepseek-official');
  assert.equal(pin.model, 'deepseek-flash');
  assert.equal(pin.reasoningEffort, 'high');
});

test('a hibás pin.json érthető hibát ad (nem csendben más modellre esik)', () => {
  assert.throws(() => parsePinText('{ nem json'), /nem érvényes JSON/);
  assert.throws(() => parsePin({ provider: 'deepseek-official' }), /model/);
  assert.throws(() => parsePin({ provider: '', model: 'deepseek-flash' }), /provider/);
  assert.throws(() => parsePin({ provider: 'a', model: 'b', enabled: 'igen' }), /enabled/);
});

test('az illeszkedés csak a szolgáltatóra és a modellre néz, ha nincs megadott effort', () => {
  const pin = parsePin({ provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.equal(isPinned({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }, pin), true);
  assert.equal(isPinned({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, pin), false);
  assert.equal(isPinned(undefined, pin), false);
});

test('a javítás terve: update efforttal, mutate kivét nélkül', () => {
  const withEffort = parsePin(FLASH);
  assert.deepEqual(planCorrection(DRIFT, withEffort), {
    mode: 'update',
    patch: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }
  });
  assert.equal(planCorrection(FLASH, withEffort), undefined, 'rögzített értékre nincs írás');

  const withoutEffort = parsePin({ provider: 'deepseek-official', model: 'deepseek-flash' });
  const plan = planCorrection(DRIFT, withoutEffort);
  assert.equal(plan.mode, 'mutate');
  assert.deepEqual(plan.ops, [
    { op: 'set', path: ['provider'], value: 'deepseek-official' },
    { op: 'set', path: ['model'], value: 'deepseek-flash' },
    { op: 'unset', path: ['reasoningEffort'] }
  ]);

  assert.equal(planCorrection(DRIFT, parsePin({ ...FLASH, enabled: false })), undefined, 'kikapcsolva nincs írás');
});

test('a címke naplózható alakja', () => {
  assert.equal(describeSelection(FLASH), 'deepseek-official/deepseek-flash:high');
  assert.equal(describeSelection({ provider: 'a', model: 'b' }), 'a/b');
  assert.equal(describeSelection(undefined), '(nincs beállítva)');
});

test('az áramköri fék időablakos és korlátozott', () => {
  const breaker = createCircuitBreaker({ limit: 3, windowMs: 1000 });
  assert.equal(breaker.tryPass(0), true);
  assert.equal(breaker.tryPass(10), true);
  assert.equal(breaker.tryPass(20), true);
  assert.equal(breaker.tryPass(30), false, 'a negyedik próba az ablakon belül nem mehet');
  assert.equal(breaker.tryPass(1500), true, 'az ablak után újra szabad');
});

// --- a plugin viselkedése (fake settings-szolgáltatással) ---------------------

test('induláskor helyreállítja a driftet, és a napló kimondja', async () => {
  const state = mountPlugin({ initial: DRIFT });
  await settle();
  assert.deepEqual(state.writes, [{ mode: 'update', payload: FLASH }]);
  assert.deepEqual(state.user, FLASH);
  const entries = logEntries(state.logPath);
  assert.equal(entries[0].kind, 'boot');
  assert.equal(entries[0].pin, 'deepseek-official/deepseek-flash:high');
  assert.equal(entries.at(-1).kind, 'corrected');
  assert.equal(entries.at(-1).from, 'deepseek-official/deepseek-v4-pro:high');
  assert.equal(entries.at(-1).to, 'deepseek-official/deepseek-flash:high');
});

test('rögzített értéknél NEM ír (nincs felesleges settings-írás)', async () => {
  const state = mountPlugin({ initial: FLASH });
  await settle();
  assert.deepEqual(state.writes, []);
  assert.deepEqual(logEntries(state.logPath).map((entry) => entry.kind), ['boot']);
});

test('a beszélgetésbeli modellváltás után visszaáll, és nem indít hurkot', async () => {
  const state = mountPlugin({ initial: FLASH });
  await settle();
  assert.equal(state.writes.length, 0);

  // A harness `saveSelection` útja: a user layer a választott modellre vált.
  state.user = { ...DRIFT };
  state.listeners[0](NAMESPACE, { ...DRIFT }, FLASH, 'update');
  await settle();

  assert.equal(state.writes.length, 1, 'egy javítás');
  assert.deepEqual(state.user, FLASH);

  // A saját javításunk által kiváltott esemény nem indít újabb írást.
  state.listeners[0](NAMESPACE, { ...FLASH }, DRIFT, 'update');
  await settle();
  assert.equal(state.writes.length, 1, 'nincs hurok: a rögzített értékre nincs írás');
  const corrected = logEntries(state.logPath).filter((entry) => entry.kind === 'corrected');
  assert.equal(corrected.length, 1);
});

test('más namespace eseményére nem reagál', async () => {
  const state = mountPlugin({ initial: FLASH });
  await settle();
  state.listeners[0]('ui-theme', { preference: 'dark' }, undefined, 'update');
  await settle();
  assert.equal(state.writes.length, 0);
});

test('ha a pin.json effort nélküli: a visszamaradt effort-öt KIVESZI', async () => {
  const state = mountPlugin({
    initial: { provider: 'alibaba-compat', model: 'qwen3.7-flash', reasoningEffort: 'none' },
    pinText: JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-flash' })
  });
  await settle();
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].mode, 'mutate');
  assert.deepEqual(state.user, { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('kikapcsolva (enabled=false) nem ír', async () => {
  const state = mountPlugin({ initial: DRIFT, pin: { ...FLASH, enabled: false } });
  await settle();
  assert.deepEqual(state.writes, []);
  assert.equal(logEntries(state.logPath).at(-1).kind, 'disabled');
});

test('hibás pin.json esetén a beépített rögzítés él, és a hiba látszik', async () => {
  const state = mountPlugin({ initial: DRIFT, pinText: '{ ez nem json' });
  await settle();
  assert.deepEqual(state.writes, [{ mode: 'update', payload: FLASH }]);
  assert.equal(logEntries(state.logPath)[0].pinSource, 'fallback');
  assert.ok(state.messages.some((line) => line.startsWith('warn:') && line.includes('pin.json')));
});

test('ha valami folyamatosan visszaírja a driftet, a fék leállítja (nincs lavina)', async () => {
  const state = mountPlugin({ initial: FLASH, rogue: true });
  await settle();
  assert.equal(state.writes.length, 0, 'rögzített állapotban nincs írás');

  // A „gaz" író minden javítás után visszaállítja a driftet; a fék 6/60 s.
  state.user = { ...DRIFT };
  for (let i = 0; i < 10; i += 1) {
    state.listeners[0](NAMESPACE, { ...DRIFT }, FLASH, 'update');
    await settle(3);
  }
  const entries = logEntries(state.logPath);
  assert.ok(entries.some((entry) => entry.kind === 'fuse'), 'a fék naplózva van');
  assert.equal(state.writes.length, 6, `a javítások száma a féken megáll (volt: ${state.writes.length})`);
  assert.ok(state.messages.some((line) => line.startsWith('warn:') && line.includes('túl sok drift')));
});

test('a napló a rögzítés forrását is hordozza', async () => {
  const state = mountPlugin({ initial: FLASH });
  await settle();
  const boot = logEntries(state.logPath)[0];
  assert.equal(boot.pinSource, 'file');
  assert.equal(boot.pin, 'deepseek-official/deepseek-flash:high');
  assert.deepEqual(pinTarget(DEFAULT_PIN), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
});
