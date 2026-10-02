#!/usr/bin/env node
/**
 * session-channel.mjs — az automatizált futások „csatornája" és a sáv takarítása.
 *
 * A JELENSÉG, amit kezel:
 *
 *   A DSH headless futása mindig létrehoz egy sessiont a munkakönyvtárában.
 *   Ha az a projekt könyvtára, a session a projekt sávjában jelenik meg — a
 *   2026-09-27-i delegálás-tesztek 8 ilyen sessiont szórtak a „Deepseek Harness"
 *   listájára (a sávon „Delegate … via subagent" címekkel).
 *
 * KÉT ESZKÖZ:
 *
 *   1) CSATORNA (`--channel`): a `.automation` könyvtárat külön munkaterületként
 *      regisztrálja a futó hoston. Az `providers\run-headless-task.ps1` innen
 *      indítja a headless futásokat, így azok külön csoportba kerülnek.
 *
 *   2) TAKARÍTÁS (`--hide` / `--unhide`): a már keletkezett, automatizálásból
 *      származó session-öket kiveszi a sávból. Az archiválás NEM törlés: a napló
 *      a helyén marad, ezért a 30 napos statisztika továbbra is számol vele.
 *      Az archiválás a FUTÓ host registry-ében történik (`POST
 *      /ui-extras/workspace-session`), mert a `storages/workspace.json`-t a DSH
 *      csak induláskor olvassa — kézi fájlszerkesztést a host felülírna.
 *
 * Használat:
 *   node providers/session-channel.mjs                     # riport (nem ír)
 *   node providers/session-channel.mjs --channel           # csatorna regisztrálása
 *   node providers/session-channel.mjs --hide --channel    # takarítás + csatorna
 *   node providers/session-channel.mjs --hide --ids a,b    # csak ezeket
 *   node providers/session-channel.mjs --unhide --ids a,b
 *   node providers/session-channel.mjs --match "sajat minta" --hide
 *
 * Kapcsolók:
 *   --port <n>     a harness portja (alap: 3080)
 *   --keep <id>    soha ne rejtse el ezt a sessiont (többször is megadható)
 *   --force        friss (5 percen belül írt) naplót is elrejtsen
 *   --json         gépi kimenet
 *
 * Kilépési kód: 0 = rendben, 1 = hiba (a host nem válaszolt, vagy nem sikerült
 * minden művelet).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A repo gyokere (a szkript a providers mappaban van) — a csatorna ide kerul. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ── kapcsolók ────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const valuesOf = (flag) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
};

const PORT = Number(valueOf('--port', '3080'));
const REGISTER_CHANNEL = has('--channel');
const HIDE = has('--hide');
const UNHIDE = has('--unhide');
const FORCE = has('--force');
const AS_JSON = has('--json');
const EXPLICIT_IDS = valuesOf('--ids').flatMap((value) => value.split(',')).map((id) => id.trim()).filter(Boolean);
const KEEP = new Set(valuesOf('--keep'));

/**
 * A minták, amelyek egy sessiont AUTOMATIZÁLÁSNAK jelölnek. A DSH a session
 * címét az első emberi üzenetből készíti, ezért a gépi tesztek feliratai
 * ismétlődnek — a felhasználó saját kérései nem illeszkednek ezekre.
 */
const DEFAULT_MATCHERS = [
  /exactly once to delegate/i,
  /use the subagent tool exactly once/i,
  /this is a connectivity probe/i,
  /deleg[aá]l[aá]s teszt/i
];
const MATCHERS = valuesOf('--match').length > 0
  ? valuesOf('--match').map((pattern) => new RegExp(pattern, 'i'))
  : DEFAULT_MATCHERS;

/** Ennyinél frissebb naplót nem rejtünk el (az lehet az éppen futó session). */
const FRESH_MILLISECONDS = 5 * 60 * 1000;

/* ── a session-naplók olvasása ────────────────────────────────────────────── */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROUTE = `${BASE_URL}/ui-extras/workspace-session`;

if (!existsSync(SESSIONS_DIR)) {
  console.error(`Nincs sessions mappa: ${SESSIONS_DIR}`);
  process.exit(1);
}

/** Egy zstd frame kicsomagolása, a felhasznált bájtokkal (a napló több frame). */
function readFrame(buffer) {
  return new Promise((resolve) => {
    const stream = createZstdDecompress();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), consumed: stream.bytesWritten }));
    stream.on('error', () => resolve({ text: '', consumed: buffer.length }));
    stream.end(buffer);
  });
}

async function decompress(buffer) {
  let offset = 0;
  let text = '';
  let frames = 0;
  while (offset < buffer.length && frames < 200000) {
    const frame = await readFrame(buffer.subarray(offset));
    if (frame.consumed <= 0) break;
    offset += frame.consumed;
    frames += 1;
    text += frame.text;
  }
  return text;
}

/** Az első emberi üzenet szövege egy session-naplóból. */
function firstUserText(text) {
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.indexOf('"user/message"') === -1) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== 'user/message') continue;
      const parts = event.data?.message?.content ?? event.data?.content ?? [];
      const texts = Array.isArray(parts)
        ? parts.filter((part) => part?.type === 'text').map((part) => part.text)
        : [];
      if (texts.length > 0) return texts.join(' ').replace(/\s+/g, ' ').trim();
    } catch { /* serult sor: a kovetkezo jelolt */ }
  }
  return '';
}

/* ── jelöltek összegyűjtése ───────────────────────────────────────────────── */
const all = [];
for (const workspaceDir of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
  if (!workspaceDir.isDirectory()) continue;
  const workspacePath = join(SESSIONS_DIR, workspaceDir.name);
  for (const entry of readdirSync(workspacePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(workspacePath, entry.name, 'session.v3.jsonl.zstd');
    if (!existsSync(file)) continue;
    let header = null;
    let text = '';
    let modifiedAt = 0;
    try {
      modifiedAt = statSync(file).mtimeMs;
      text = await decompress(readFileSync(file));
      const first = text.split('\n').find((line) => line.trim().length > 0);
      header = JSON.parse(first);
    } catch {
      continue;
    }
    if (header?.type !== 'session') continue;
    all.push({
      id: header.id,
      workspace: workspaceDir.name,
      origin: header.origin ?? '',
      depth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
      cwd: header.cwd ?? '',
      createdAt: header.createdAt ?? 0,
      modifiedAt,
      first: firstUserText(text)
    });
  }
}

const candidates = all.filter((session) => {
  if (session.origin === 'subagent' || session.depth > 0) return false; // a sáv eleve rejti
  if (KEEP.has(session.id)) return false;
  if (EXPLICIT_IDS.length > 0) return EXPLICIT_IDS.includes(session.id);
  if (Date.now() - session.modifiedAt < FRESH_MILLISECONDS && !FORCE) return false;
  return MATCHERS.some((matcher) => matcher.test(session.first));
});

/* ── a host válasza ───────────────────────────────────────────────────────── */
async function hostState() {
  const response = await fetch(ROUTE, { headers: { accept: 'application/json' } });
  if (response.status === 404) {
    throw new Error('a host fel meg a REGI verzio: nincs /ui-extras/workspace-session vegpont (ujrainditas kell)');
  }
  const body = await response.json();
  if (!body?.ok) throw new Error(body?.error ?? 'a host nem adott hasznalhato valaszt');
  return body;
}

async function hostAction(action, payload) {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  if (response.status === 404) {
    return { ok: false, error: 'a host fel meg a REGI verzio (nincs /ui-extras/workspace-session vegpont)' };
  }
  return await response.json();
}

/* ── riport ───────────────────────────────────────────────────────────────── */
let state = null;
let stateError = null;
try {
  state = await hostState();
} catch (error) {
  stateError = String(error?.message ?? error);
}

const archived = new Set(state?.archivedSessionIds ?? []);

if (AS_JSON) {
  console.log(JSON.stringify({
    port: PORT,
    hostReachable: state !== null,
    hostError: stateError,
    archivedSessionIds: [...archived],
    workspaces: state?.workspaces ?? [],
    candidates: candidates.map((session) => ({ ...session, archived: archived.has(session.id) }))
  }, null, 2));
} else {
  console.log('');
  console.log('Automatizált session-ök csatornája');
  console.log('==================================');
  console.log(`Host: ${ROUTE}`);
  if (state === null) {
    console.log(`  FIGYELEM: a host nem valaszolt (${stateError}).`);
    console.log('  Az archiváláshoz fusson a harness, és legyen benne az uj host fel (/ui-extras/workspace-session).');
  } else {
    console.log(`  archivált session: ${archived.size}`);
    for (const workspace of state.workspaces) {
      console.log(`  munkaterulet: ${workspace.title}  (${workspace.path})  — ${workspace.sessions} session`);
    }
  }
  console.log('');
  if (candidates.length === 0) {
    console.log('Nincs automatizálásból származó, listán látszó session — nincs teendő.');
  } else {
    console.log(`Jelöltek (${candidates.length}) — ezek a gépi futások session-jei:`);
    for (const session of candidates) {
      const when = session.createdAt ? new Date(session.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
      const flag = archived.has(session.id) ? ' [mar rejtve]' : '';
      console.log(`  ${session.id}  ${when}  ${basename(session.cwd || '-')}${flag}`);
      console.log(`      ${session.first.slice(0, 110)}`);
    }
    console.log('');
    console.log('Elrejtés:  --hide     Visszahozás:  --unhide --ids <id,...>');
  }
  console.log('');
}

/* ── műveletek ────────────────────────────────────────────────────────────── */
let failures = 0;

if (REGISTER_CHANNEL) {
  const channelPath = join(REPO_ROOT, '.automation');
  if (state === null) {
    console.error('A csatorna regisztralasahoz futnia kell a harnessnek (es az uj host fel kell).');
    failures += 1;
  } else {
    const answer = await hostAction('workspace', { path: channelPath, title: 'Automatizált futások' });
    if (answer.ok) console.log(`Csatorna: ${answer.created ? 'uj' : 'mar regisztralt'} munkaterulet — ${answer.workspace.path}`);
    else { console.error(`Csatorna-regisztracio hiba: ${answer.error}`); failures += 1; }
  }
}

if (HIDE || UNHIDE) {
  const action = HIDE ? 'archive' : 'unarchive';
  const ids = candidates.map((session) => session.id);
  if (ids.length === 0) {
    console.log('Nincs mit tenni (nincs jelölt).');
  } else if (state === null) {
    console.error('A host nem elerheto, ezert nem tortent valtozas.');
    failures += 1;
  } else {
    const answer = await hostAction(action, { sessions: ids });
    for (const id of answer.changed ?? []) console.log(`  ${action === 'archive' ? 'elrejtve' : 'visszahozva'}: ${id}`);
    for (const failure of answer.failed ?? []) {
      console.error(`  HIBA ${failure.sessionId}: ${failure.error}`);
      failures += 1;
    }
    console.log(`Archivált session-ök most: ${(answer.archivedSessionIds ?? []).length}`);
  }
}

process.exit(failures > 0 ? 1 : 0);
