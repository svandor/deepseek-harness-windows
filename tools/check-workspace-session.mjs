#!/usr/bin/env node
/**
 * check-workspace-session.mjs — a session-csatorna host route-ja.
 *
 * A route az EGYETLEN hely, amely a FUTÓ host workspace-registry-ét írja
 * (archiválás, visszahozás, csatorna-munkaterület regisztrálása). A hibái ezért
 * nem kozmetikaiak: a sáv rossz sessiont rejthet el, vagy a registry
 * konzisztenciáját ronthatja. Ez a szkript ezért valódi kérésekkel, de **hamis
 * registry-vel** hajtja végig az ágakat — a host folyamat érintése nélkül.
 *
 *   node tools/check-workspace-session.mjs
 *
 * Kilépési kód: 0 = minden ellenőrzés zöld, 1 = hiba.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleWorkspaceSession, unarchiveSession, isFreeModel } from '../plugins/dsh-ui-extras/lib/index.js';

let failures = 0;
const fail = (message) => { failures += 1; console.error('  FAIL ' + message); };
const ok = (message) => console.log('  ok   ' + message);

/* ── hamis host-környezet ─────────────────────────────────────────────────── */
function makeRegistry(existingPath = null) {
  const calls = { archive: [], setState: [], create: [], resolve: [] };
  const registry = {
    archivedSessionIds: ['mar-archivalt'],
    calls,
    list: () => [{ id: 'w1', path: 'C:\\projekt', title: 'Projekt', sessionIds: ['s1', 's2'] }],
    async archiveSession(sessionId) {
      calls.archive.push(sessionId);
      if (sessionId === 'ismeretlen') throw new Error(`cannot archive session '${sessionId}'`);
      if (!registry.archivedSessionIds.includes(sessionId)) {
        registry.archivedSessionIds = [...registry.archivedSessionIds, sessionId];
      }
    },
    async setState(state) {
      calls.setState.push(state);
      registry.archivedSessionIds = [...state.archivedSessionIds];
    },
    async resolveByPath(path) {
      calls.resolve.push(path);
      if (existingPath !== null && path === existingPath) return { id: 'w2', path, title: 'Letezo' };
      return undefined;
    },
    async create(path, title) {
      calls.create.push({ path, title });
      return { id: 'w3', path, title: title ?? 'uj' };
    }
  };
  return registry;
}

function makeRequest(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = '/ui-extras/workspace-session';
  if (body !== undefined) {
    // A body a valodi streamhez hasonloan a kovetkezo tickben erkezik.
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
      req.emit('end');
    });
  }
  return req;
}

function makeResponse() {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const res = {
    status: 0,
    headers: null,
    payload: null,
    done,
    writeHead(status, headers) { res.status = status; res.headers = headers; return res; },
    end(text) {
      res.payload = text === undefined ? null : JSON.parse(text);
      settle();
    }
  };
  return res;
}

/** Egy kérés végigvitele a route-on, a válasszal. */
async function call(registry, method, body) {
  const res = makeResponse();
  // A POST-ag a testet callbackben olvassa, ezert a valaszra varni kell; a GET
  // szinkron valaszol, ott a done mar a hivas elott teljesult.
  await handleWorkspaceSession(makeRequest(method, body), res, new URL('http://dsh.invalid/ui-extras/workspace-session'), {
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined)
  });
  await res.done;
  if (res.payload === null) throw new Error('a route nem adott JSON valaszt');
  return res.payload;
}

/* ── 1) nincs registry (mas profil) ───────────────────────────────────────── */
{
  const res = makeResponse();
  await handleWorkspaceSession(makeRequest('GET'), res, new URL('http://dsh.invalid/ui-extras/workspace-session'), { get: () => undefined });
  if (res.payload?.ok === false) ok('a hianyzo workspace-registry hibaval ter vissza (nem hal el a plugin)');
  else fail('a hianyzo registry nem adott ertelmezheto hibát');
}

/* ── 2) GET: az archivalt halmaz es a munkateruletek ──────────────────────── */
{
  const registry = makeRegistry();
  const answer = await call(registry, 'GET');
  if (answer.ok === true && answer.archivedSessionIds.length === 1) ok('a GET kiadja az archivalt session-oket');
  else fail('a GET nem adta vissza az archivalt halmazt');
  if (answer.workspaces?.[0]?.sessions === 2) ok('a GET a munkaterulet session-szamat is jelenti');
  else fail('a GET munkaterulet-osszesitese hianyos');
}

/* ── 3) archive: tobb id, reszleges hiba ──────────────────────────────────── */
{
  const registry = makeRegistry();
  const answer = await call(registry, 'POST', { action: 'archive', sessions: ['s1', 'ismeretlen', 's2'] });
  if (registry.calls.archive.join(',') === 's1,ismeretlen,s2') ok('az archiválás minden megadott sessionre lefut');
  else fail('az archiválás nem minden id-re futott le');
  if (answer.ok === false && answer.failed.length === 1 && answer.changed.length === 2) ok('a reszleges hiba nem viszi el a tobbi muveletet');
  else fail('a reszleges hiba kezelese hibas');
  if (answer.archivedSessionIds.includes('s1') && answer.archivedSessionIds.includes('s2')) ok('a valasz a vegso archivalt halmazt adja');
  else fail('a valasz nem a vegso archivalt halmazt adja');
}

/* ── 4) archive: ures lista ───────────────────────────────────────────────── */
{
  const registry = makeRegistry();
  const answer = await call(registry, 'POST', { action: 'archive', sessions: [] });
  if (answer.ok === false && registry.calls.archive.length === 0) ok('ures id-lista eseten nem tortenik semmi');
  else fail('ures id-lista eseten is irt a registrybe');
}

/* ── 5) unarchive: csak kivesz, a sorrendhez nem nyul ─────────────────────── */
{
  const registry = makeRegistry();
  registry.archivedSessionIds = ['a', 'mar-archivalt', 'b'];
  const answer = await call(registry, 'POST', { action: 'unarchive', sessions: ['mar-archivalt'] });
  if (answer.ok === true && registry.archivedSessionIds.join(',') === 'a,b') ok('a visszahozas kiveszi az id-t az archivalt halmazbol');
  else fail('a visszahozas nem a vart halmazt adta');
  const state = registry.calls.setState.at(-1);
  if (state?.initialized === true && state.workspaceIds.join(',') === 'w1') ok('a visszahozas megtartja a munkaterulet-sorrendet');
  else fail('a visszahozas nem tartotta meg a sorrendet');
  if (state?.archivedSessionIds.join(',') === 'a,b') ok('a mentett allapot pontosan az archivalt halmazt tartalmazza');
  else fail('a mentett allapot hibas');
}

/* ── 6) unarchive: ismeretlen id nem ir ───────────────────────────────────── */
{
  const registry = makeRegistry();
  const before = registry.calls.setState.length;
  await call(registry, 'POST', { action: 'unarchive', sessions: ['nincs-ilyen'] });
  if (registry.calls.setState.length === before) ok('a nem archivált id nem valt ki irast');
  else fail('a nem archivált id is irast valtott ki');
}

/* ── 7) unarchive: registry setState nelkul ───────────────────────────────── */
{
  const bare = { archivedSessionIds: ['x'], list: () => [], archiveSession: async () => {} };
  let threw = false;
  try { await unarchiveSession(bare, 'x'); } catch { threw = true; }
  if (threw) ok('a setState nelkuli registry ertelmezheto hibát ad (nem csendben tesz semmit)');
  else fail('a setState nelkuli registry csendben elnyelte a kerest');
}

/* ── 8) workspace: meglevo, uj, es hianyzo path ───────────────────────────── */
{
  // Valodi konyvtar a temp alatt: a route `mkdirSync`-et hiv, ezert a teszt nem
  // nyulhat a rendszer gyokerehez (a sandbox egyebkent sem engedne).
  const root = mkdtempSync(join(tmpdir(), 'dsh-channel-'));
  const existingPath = join(root, 'letezo');
  const freshPath = join(root, 'uj-csatorna');
  try {
    mkdirSync(existingPath, { recursive: true });
    const registry = makeRegistry(existingPath);
    const existing = await call(registry, 'POST', { action: 'workspace', path: existingPath });
    if (existing.ok === true && existing.created === false && existing.workspace.id === 'w2') ok('meglevo utvonalat nem regisztral ujra');
    else fail(`a meglevo utvonal kezelese hibas: ${JSON.stringify(existing)}`);

    const fresh = await call(registry, 'POST', { action: 'workspace', path: freshPath, title: 'Automatizált futások' });
    if (fresh.ok === true && fresh.created === true && registry.calls.create[0]?.title === 'Automatizált futások') ok('uj utvonalat letrehoz, a megadott cimkevel');
    else fail(`az uj utvonal regisztracioja hibas: ${JSON.stringify(fresh)}`);

    const missing = await call(registry, 'POST', { action: 'workspace' });
    if (missing.ok === false) ok('hianyzo path eseten hibaval ter vissza');
    else fail('hianyzo path eseten nem jelzett hibát');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ── 9) ismeretlen action ─────────────────────────────────────────────────── */
{
  const registry = makeRegistry();
  const answer = await call(registry, 'POST', { action: 'barmi' });
  if (answer.ok === false && String(answer.error).includes('barmi')) ok('az ismeretlen action nevesített hibat ad');
  else fail('az ismeretlen action kezeletlen');
}

/* ── 10) a csatorna-konyvtar letrejon (valodi fajlrendszer) ───────────────── */
{
  const registry = makeRegistry();
  const root = mkdtempSync(join(tmpdir(), 'dsh-channel-'));
  const target = join(root, 'uj', 'mely', 'csatorna');
  try {
    const answer = await call(registry, 'POST', { action: 'workspace', path: target, title: 'Csatorna' });
    if (answer.ok === true && registry.calls.create.length === 1) ok('a hianyzo csatorna-konyvtarat letrehozza es regisztralja');
    else fail('a csatorna-konyvtar letrehozasa nem sikerult');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ── 11) az ingyenes/ fizetos dontes a route-on kivul is stimmel ──────────── */
{
  if (isFreeModel('worker') === true && isFreeModel('deepseek-flash') === false) ok('a free/paid dontes az artablabol jon');
  else fail('a free/paid dontes hibas');
}

console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
