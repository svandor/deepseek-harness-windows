#!/usr/bin/env node
/**
 * A delegált (subagent) gyermek-session-ök besorolása a szülő munkaterületére.
 *
 * A JELENSÉG, amit javít:
 *
 *   A bal oldali sáv "Csoportosítatlan" (Ungrouped) csoportja azokat a
 *   session-öket mutatja, amelyeket egyetlen munkaterület sem jegyez fel. A
 *   subagent-gyermekek pont ilyenek:
 *
 *     - a fejlécükben ott a cwd (a szülő munkakönyvtára) ÉS a parentSession,
 *     - a munkaterület-nyilvántartás (storages/workspace.json) viszont csak a
 *       felhasználó által indított session-öket tartalmazza, a gyermekeket nem.
 *
 *   Ezért minden delegálás egy új, gazdátlan sorral szaporítja a
 *   "Csoportosítatlan" csoportot. A tünet nem a delegálás hibája — a
 *   delegálás hibája a proxy kiesése volt —, hanem a DSH oldali besorolás
 *   mellékhatása.
 *
 * MIT TESZ EZ A SZKRIPT:
 *
 *   A gyermek-session-öket hozzáírja a SZÜLŐ munkaterületének sessionIds
 *   listájához (a lista végére, mert a rendezést a felület a saját,
 *   felhasználónkénti sorrendjéből adja). A "Csoportosítatlan" csoport ezután
 *   csak akkor jelenik meg, ha valóban van gazdátlan, NEM gyermek session.
 *
 *   - csak hozzáad, soha nem töröl és nem ír át meglévő besorolást,
 *   - a sessions mappában lévő fejlécekből dolgozik (nem a gyorsítótárból),
 *   - a szülőt a fejléc parentSession mezője alapján keresi, rekurzívan is,
 *   - a workspace.json-ról időbélyeges másolatot készít minden írás előtt.
 *
 * FONTOS: a DSH a workspace.json-t INDULÁSKOR olvassa be, ezért a változás
 * csak a DSH újraindítása után látszik a sávon.
 *
 * Használat:
 *   node classify-subagent-sessions.mjs                        # csak riport (nem ír)
 *   node classify-subagent-sessions.mjs --apply                # végrehajtja
 *   node classify-subagent-sessions.mjs --apply --adopt-parents
 *   node classify-subagent-sessions.mjs --apply --json
 *
 * A --adopt-parents a GAZDÁTLAN SZÜLŐKET is besorolja. Erre azért lehet
 * szükség, mert a mért adat szerint a 2026-09-27 esti delegálások szülői maguk
 * sem szerepelnek a nyilvántartásban: a gyermeket önmagában besorolni nem
 * szünteti meg a gazdátlan sort, mert a szülő is az. Enélkül a kapcsoló nélkül
 * a szkript a felhasználó saját session-jeihez nem nyúl.
 *
 * Kilépési kód: 0 = rendben (van vagy nem volt mit tenni), 1 = hiba.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const AS_JSON = process.argv.includes('--json');

const DSH_HOME = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');
const WORKSPACE_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');

if (!existsSync(WORKSPACE_FILE)) {
  console.error(`Nincs munkaterület-nyilvántartás: ${WORKSPACE_FILE}`);
  process.exit(1);
}
if (!existsSync(SESSIONS_DIR)) {
  console.error(`Nincs sessions mappa: ${SESSIONS_DIR}`);
  process.exit(1);
}

// ── a session-fejlécek beolvasása ──────────────────────────────────────────
/**
 * A session tár könyvtáranként egy `session.v3.jsonl.zstd` fájlt tart, benne
 * egyetlen `type: "session"` fejléccel. A fejléc az egyetlen megbízható forrás:
 * a cwd, a parentSession és az origin mind itt van.
 */
function readHeader(file) {
  try {
    const buf = readFileSync(file);
    let text;
    try { text = zstdDecompressSync(buf).toString('utf8'); }
    catch { text = buf.toString('utf8'); }
    const first = text.split('\n').find((l) => l.trim().length > 0);
    if (!first) return null;
    const rec = JSON.parse(first);
    return rec?.type === 'session' ? rec : null;
  } catch {
    return null;
  }
}

const headers = new Map(); // id -> header
for (const wsDir of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
  if (!wsDir.isDirectory()) continue;
  const wsPath = path.join(SESSIONS_DIR, wsDir.name);
  let entries;
  try { entries = readdirSync(wsPath, { withFileTypes: true }); } catch { continue; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(wsPath, entry.name, 'session.v3.jsonl.zstd');
    if (!existsSync(file)) continue;
    const header = readHeader(file);
    if (header?.id) headers.set(header.id, header);
  }
}

// ── a nyilvántartás beolvasása ─────────────────────────────────────────────
const store = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'));
const table = store?.tables?.workspaces ?? {};

// sessionId -> workspaceId (a jelenlegi besorolás)
const ownerOf = new Map();
for (const [workspaceId, record] of Object.entries(table)) {
  for (const sessionId of record.sessionIds ?? []) ownerOf.set(sessionId, workspaceId);
}

// A munkakönyvtár -> munkaterület térkép a cwd szerinti feloldáshoz.
// Erre azért kell, mert a MÉRT adat szerint vannak olyan szülők, amelyek
// maguk sem szerepelnek a nyilvántartásban (a 2026-09-27 esti delegálások
// szülő-session-jei ilyenek): a lánc a parentSession mezőn nem oldható fel.
// A fejléc cwd mezője viszont megvan, és egyértelműen egy munkaterülethez tartozik.
const workspaceByPath = new Map();
for (const [workspaceId, record] of Object.entries(table)) {
  if (typeof record.path === 'string') workspaceByPath.set(record.path.toLowerCase(), workspaceId);
}

/**
 * A cwd-lánc feloldása: a session-től felfelé haladva az első olyan ős, amelynek
 * van cwd-je, és az a cwd egy létező munkaterületre mutat.
 */
function resolveOwnerByCwd(sessionId, seen = new Set()) {
  if (seen.has(sessionId)) return null;
  seen.add(sessionId);
  const header = headers.get(sessionId);
  if (header && typeof header.cwd === 'string') {
    const id = workspaceByPath.get(header.cwd.toLowerCase());
    if (id !== undefined) return id;
  }
  const parent = header?.parentSession;
  if (typeof parent !== 'string' || parent.length === 0) return null;
  return resolveOwnerByCwd(parent, seen);
}

// Gyermek -> szülő lánc feloldása a nyilvántartott ősig.
function resolveOwner(sessionId, seen = new Set()) {
  if (seen.has(sessionId)) return null; // ciklikus lánc: nem nyúlunk hozzá
  seen.add(sessionId);
  const direct = ownerOf.get(sessionId);
  if (direct !== undefined) return direct;
  const header = headers.get(sessionId);
  const parent = header?.parentSession;
  if (typeof parent !== 'string' || parent.length === 0) return null;
  const viaChain = resolveOwner(parent, seen);
  if (viaChain !== null) return viaChain;
  return resolveOwnerByCwd(sessionId);
}

// ── a gyermeklánc feloldása ÉS a hiányzó felmenők begyűjtése ───────────────
// Ha egy szülő maga sem besorolt, a gyermek hozzákapcsolása önmagában nem
// tünteti el a gazdátlan sort, mert a szülő is az. Ezért ilyenkor a felmenőket
// is begyűjtjük — de CSAK akkor, ha a --adopt-parents kapcsoló megvan, hogy a
// felhasználó saját session-jeihez véletlenül se nyúljunk.
const ADOPT_PARENTS = process.argv.includes('--adopt-parents');

function ancestorsMissing(sessionId, out = [], seen = new Set()) {
  const header = headers.get(sessionId);
  const parent = header?.parentSession;
  if (typeof parent !== 'string' || parent.length === 0) return out;
  if (seen.has(parent)) return out;
  seen.add(parent);
  if (!ownerOf.has(parent) && headers.has(parent)) out.push(parent);
  return ancestorsMissing(parent, out, seen);
}

// ── a jelöltek összegyűjtése ───────────────────────────────────────────────
const additions = new Map(); // workspaceId -> Set(sessionId)
const skipped = [];
const adopted = [];

function add(workspaceId, sessionId) {
  if (!additions.has(workspaceId)) additions.set(workspaceId, new Set());
  additions.get(workspaceId).add(sessionId);
}

for (const [sessionId, header] of headers) {
  if (ownerOf.has(sessionId)) continue;                 // már besorolt
  if (header.origin !== 'subagent') continue;           // nem delegált gyermek
  if (typeof header.parentSession !== 'string') continue;

  const workspaceId = resolveOwner(sessionId);
  if (workspaceId === undefined || workspaceId === null) {
    skipped.push({ sessionId, reason: 'sem a szulo, sem a cwd nem oldhato fel' });
    continue;
  }
  add(workspaceId, sessionId);

  if (ADOPT_PARENTS) {
    for (const ancestor of ancestorsMissing(sessionId)) {
      add(workspaceId, ancestor);
      adopted.push(ancestor);
    }
  }
}

// A beszúrási sorrend: a nyilvántartás a legújabbat teszi előre, ezért a
// gyermekeket is kor szerint csökkenő sorrendben fűzzük a lista végére.
function createdAt(id) {
  const t = headers.get(id)?.createdAt;
  return typeof t === 'number' ? t : 0;
}

const summary = [];
for (const [workspaceId, idSet] of additions) {
  const ids = [...idSet].sort((a, b) => createdAt(b) - createdAt(a));
  summary.push({
    workspaceId,
    title: table[workspaceId]?.title ?? '(nincs cim)',
    path: table[workspaceId]?.path ?? '',
    count: ids.length,
    sessionIds: ids,
  });
}

// ── írás ───────────────────────────────────────────────────────────────────
let backupPath = null;
if (APPLY && summary.length > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backupPath = `${WORKSPACE_FILE}.bak-${stamp}`;
  copyFileSync(WORKSPACE_FILE, backupPath);

  for (const group of summary) {
    const record = table[group.workspaceId];
    const existing = new Set(record.sessionIds ?? []);
    for (const id of group.sessionIds) {
      if (!existing.has(id)) {
        record.sessionIds = [...(record.sessionIds ?? []), id];
        existing.add(id);
      }
    }
    record.updatedAt = new Date().toISOString();
  }
  writeFileSync(WORKSPACE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// ── kimenet ────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ apply: APPLY, backupPath, groups: summary, skipped }, null, 2));
} else {
  const total = summary.reduce((n, g) => n + g.count, 0);
  console.log('');
  console.log('Delegált gyermek-session-ök besorolása');
  console.log('=====================================');
  console.log(`Fejlécek: ${headers.size}   Nyilvántartott session: ${ownerOf.size}`);

  if (total === 0) {
    console.log('Nincs besorolatlan subagent-gyermek — nincs teendő.');
  } else {
    for (const g of summary) {
      console.log(`\n  ${g.title}  (${g.path})`);
      console.log(`    + ${g.count} session`);
      for (const id of g.sessionIds) {
        const h = headers.get(id);
        const when = h?.createdAt ? new Date(h.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
        const kind = h?.origin === 'subagent' ? 'delegált' : 'szülő (gazdátlan volt)';
        console.log(`      ${id}  [${kind}]  (szülő: ${h?.parentSession ?? '—'}, ${when})`);
      }
    }
    if (adopted.length > 0) {
      console.log(`\n  Gazdátlan szülők is besorolva: ${adopted.length} (--adopt-parents)`);
    }
    if (skipped.length > 0) {
      console.log(`\n  Kihagyva (${skipped.length}):`);
      for (const s of skipped) console.log(`      ${s.sessionId} — ${s.reason}`);
    }
    console.log('');
    if (APPLY) {
      console.log(`Végrehajtva. Mentés: ${backupPath}`);
      console.log('A sávon a változás a DSH ÚJRAINDÍTÁSA után látszik (a nyilvántartást induláskor olvassa).');
    } else {
      console.log('Csak riport — semmi nem változott. Végrehajtás: --apply');
    }
  }
  console.log('');
}

process.exit(0);
