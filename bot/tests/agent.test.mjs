/**
 * A robot-konzol ügynökének tesztjei (node:test).
 *
 * Futtatás: node --test --test-isolation=none bot/tests/agent.test.mjs
 *
 * A `parseModelReply` tiszta függvény, ezért determinisztikusan tesztelhető; a
 * modell-hívás maga a helyi proxy ingyenes láncán megy, azt külön, élő
 * füstpróbával ellenőrizzük (nem a unit-teszttel).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelReply, ACTIONS } from '../lib/agent.mjs';

test('a modell akció-kérése felismerhető', () => {
  const r = parseModelReply('AKCIÓ: {"action": "allapot", "params": {}}');
  assert.equal(r.kind, 'action');
  assert.equal(r.action, 'allapot');
});

test('az akció paraméterei átjönnek', () => {
  const r = parseModelReply('AKCIÓ: {"action": "futtat_job", "params": {"job": "konkurencia-figyelo"}}');
  assert.equal(r.kind, 'action');
  assert.deepEqual(r.params, { job: 'konkurencia-figyelo' });
});

test('a végső válasz felismerhető', () => {
  const r = parseModelReply('VÁLASZ: Minden rendben, 2 job futott ma.');
  assert.equal(r.kind, 'answer');
  assert.equal(r.text, 'Minden rendben, 2 job futott ma.');
});

test('a formázatlan válasz is válasznak számít (nem veszik el)', () => {
  const r = parseModelReply('Nincs változás egyik oldalon sem.');
  assert.equal(r.kind, 'answer');
  assert.match(r.text, /Nincs változás/);
});

test('a hibás akció-JSON nem töri el a futtatást', () => {
  const r = parseModelReply('AKCIÓ: {"action": "allapot", "params":');
  assert.equal(r.kind, 'answer');
  assert.ok(r.parseError, 'jelezni kell a parse-hibát');
});

test('az akció-katalógus tartalmazza a kockázatos műveletet', () => {
  assert.equal(ACTIONS.email_teszt.risky, true);
  assert.equal(ACTIONS.allapot.risky, false);
  assert.ok(ACTIONS.futtat_job.params.includes('job'));
});

test('a napló és a naplózott akciók mind definiáltak', () => {
  for (const [name, def] of Object.entries(ACTIONS)) {
    assert.ok(typeof def.leiras === 'string' && def.leiras.length > 0, `${name}: kell leírás`);
    assert.ok(Array.isArray(def.params), `${name}: kell params lista`);
  }
});
