/**
 * A GÉP-ÁLLAPOT-ZÁR tesztjei (cross-session lease) — tiszta modul + bekötés.
 *
 * Futtatás: `node plugins/dsh-rule-guard/test/lease.test.mjs`
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { apply } from '../lib/index.js';
import { createRegistry, describeActive, prune, releaseAll, requestLease, resourceFor } from '../lib/lease.js';

const RESOURCES = [
  {
    id: 'display-mode',
    what: 'kijelző mód',
    match: ['display-guard\\.exe[^\\n]*--(apply|watch)', 'display-mode\\.ps1[^\\n]*-(Set|Apply)\\b']
  }
];

/** @param {string} label */
function fakeAgent(label) {
  return { session: { header: { cwd: 'D:\\Szerver\\Vector', id: `${label}-abcdef12` } } };
}

/** @param {object} agent @param {string} command */
function fakeExec(agent, command) {
  return { name: 'pwsh', callId: `c-${Math.random()}`, agent, arguments: { command } };
}

/** Óra: kézzel léptethető. */
let clock = Date.parse('2026-11-27T10:36:22Z');
const now = () => clock;

test('a módosító parancsot felismeri, az olvasót NEM', () => {
  assert.equal(resourceFor(RESOURCES, 'D:\\Szerver\\Vector\\tools\\bin\\display-guard.exe --apply --hz 120')?.id, 'display-mode');
  assert.equal(resourceFor(RESOURCES, 'display-guard.exe --watch 30')?.id, 'display-mode');
  assert.equal(resourceFor(RESOURCES, 'pwsh -File display-mode.ps1 -Set 120')?.id, 'display-mode');
  assert.equal(resourceFor(RESOURCES, 'pwsh -File display-mode.ps1 -Status'), undefined, 'az olvasás nem ütközik');
  assert.equal(resourceFor(RESOURCES, 'nvidia-smi --query-gpu=name'), undefined);
  assert.equal(resourceFor(RESOURCES, ''), undefined);
});

test('a hibás regex nem dönt és nem dob', () => {
  assert.equal(resourceFor([{ id: 'x', match: ['([nem-regex'] }], 'bármi'), undefined);
  assert.equal(resourceFor([], 'display-guard.exe --apply'), undefined);
  assert.equal(resourceFor(undefined, 'display-guard.exe --apply'), undefined);
});

test('az első igénylés zárat ad, a MÁSODIK ágens indoklással elutasítva', () => {
  const registry = createRegistry();
  const first = fakeAgent('vector');
  const second = fakeAgent('dsh');
  const granted = requestLease(registry, RESOURCES[0], fakeExec(first, 'display-guard.exe --apply --hz 120'), { now: now() });
  assert.equal(granted.granted, true);
  const denied = requestLease(registry, RESOURCES[0], fakeExec(second, 'display-guard.exe --apply --hz 60'), { now: now() });
  assert.equal(denied.granted, false);
  assert.match(denied.reason, /MÁSIK ÁGENS/u);
  assert.match(denied.reason, /display-mode/u);
  assert.match(denied.reason, /vector/u, 'a birtokos azonosítható');
  assert.match(denied.reason, /OLVASÁSSAL/u, 'van kiút: olvasás');
  assert.match(denied.reason, /2026-11-27/u, 'a mért esetre hivatkozik');
});

test('ugyanaz az ágens újra igényelhet (nem zárja ki magát)', () => {
  const registry = createRegistry();
  const agent = fakeAgent('vector');
  const first = requestLease(registry, RESOURCES[0], fakeExec(agent, 'display-guard.exe --apply'), { now: now() });
  clock += 60000;
  const second = requestLease(registry, RESOURCES[0], fakeExec(agent, 'display-guard.exe --apply'), { now: now() });
  assert.equal(second.granted, true);
  assert.equal(second.holder.startedAt, first.holder.startedAt, 'a kezdés nem csúszik el');
  assert.ok(second.holder.expiresAt > first.holder.expiresAt, 'a lejárat hosszabbodik');
});

test('a lejárt zár nem blokkol (a TTL a menekülőút)', () => {
  const registry = createRegistry();
  const first = fakeAgent('vector');
  requestLease(registry, RESOURCES[0], fakeExec(first, 'display-guard.exe --apply'), { now: now(), ttlMinutes: 20 });
  clock += 21 * 60000;
  const other = requestLease(registry, RESOURCES[0], fakeExec(fakeAgent('dsh'), 'display-guard.exe --apply'), { now: now() });
  assert.equal(other.granted, true);
});

test('a session lezárása elengedi a zárat, más ágensét nem érinti', () => {
  const registry = createRegistry();
  const vector = fakeAgent('vector');
  const dsh = fakeAgent('dsh');
  requestLease(registry, RESOURCES[0], fakeExec(vector, 'display-guard.exe --apply'), { now: now() });
  const otherResource = { id: 'gpu-power', what: 'gpu', match: ['nvidia-smi[^\\n]*--power-limit'] };
  requestLease(registry, otherResource, fakeExec(dsh, 'nvidia-smi --power-limit 100'), { now: now() });
  assert.equal(releaseAll(registry, vector), 1);
  assert.equal(describeActive(registry, now()).length, 1, 'a másik zár megmarad');
  assert.match(describeActive(registry, now())[0], /gpu-power/u);
});

test('az aktív zár listája olvasható (session-súgóhoz)', () => {
  const registry = createRegistry();
  requestLease(registry, RESOURCES[0], fakeExec(fakeAgent('vector'), 'display-guard.exe --apply'), { now: now(), ttlMinutes: 20 });
  const lines = describeActive(registry, now());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /display-mode/u);
  assert.match(lines[0], /még ~20 perc/u);
});

test('a prune csak a lejártakat törli', () => {
  const registry = createRegistry();
  requestLease(registry, RESOURCES[0], fakeExec(fakeAgent('a'), 'display-guard.exe --apply'), { now: now(), ttlMinutes: 5 });
  clock += 6 * 60000;
  assert.equal(prune(registry, now()), 1);
  assert.equal(registry.leases.size, 0);
});

// ── Bekötés (valódi plugin, hamis ctx, ideiglenes policy) ───────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-lease-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** @param {object} agent */
function setUp() {
  const policyPath = join(dir, `policy-${Math.random()}.json`);
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      globalRules: [],
      workspaces: [{ id: 'w', label: 'w', match: ['D:\\Szerver\\Vector'], rules: [], sessionRules: [] }],
      leases: { enabled: true, ttlMinutes: 20, resources: RESOURCES },
      rules: {}
    }),
    'utf8'
  );
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const ctx = {
    on(event, fn) {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
    logger: { info() {}, warn() {} },
    get: () => undefined
  };
  apply(ctx, { policyPath, logPath: join(dir, 'guard.log'), leaseRegistry: createRegistry() });
  return handlers;
}

test('bekötve: a második session hívása BLOKKOL, az elsőé átmegy', async () => {
  const handlers = setUp();
  const gate = handlers.get('tools/pre-execute');
  assert.equal(typeof gate, 'function');
  const vector = fakeAgent('vector');
  const dsh = fakeAgent('dsh');
  const first = await gate(fakeExec(vector, 'display-guard.exe --apply --hz 120'), () => ({ kind: 'accept' }));
  assert.equal(first?.kind, 'accept', 'az első hívás továbbmegy');
  const second = await gate(fakeExec(dsh, 'display-guard.exe --apply --hz 60'), () => ({ kind: 'accept' }));
  assert.equal(second?.kind, 'deny');
  assert.match(second.reason, /MÁSIK ÁGENS/u);
});

test('bekötve: az olvasó parancsot a zár NEM blokkolja', async () => {
  const handlers = setUp();
  const gate = handlers.get('tools/pre-execute');
  const vector = fakeAgent('vector');
  const dsh = fakeAgent('dsh');
  await gate(fakeExec(vector, 'display-guard.exe --apply'), () => ({ kind: 'accept' }));
  const read = await gate(fakeExec(dsh, 'pwsh -File tools\\display-mode.ps1 -Status'), () => ({ kind: 'accept' }));
  assert.equal(read?.kind, 'accept', 'a -Status olvasás átmegy');
});

test('bekötve: a session indulásakor megkapja a „nem vagy egyedül" súgót', () => {
  const handlers = setUp();
  /** @type {Array<object>} */
  const messages = [];
  handlers.get('agent/session-start')({ agent: { session: { header: { cwd: 'D:\\Szerver\\Vector' } }, inject: (m) => messages.push(m) } });
  assert.equal(messages.length, 1);
  const text = String(messages[0].content[0].text);
  assert.match(text, /NEM vagy egyedül/u);
  assert.match(text, /erőforrás-zár/u);
  assert.match(text, /NEM felhasználói üzenet/u);
});
