/**
 * A mérés összeállítása: session-naplók + aktivitás + profil -> számok.
 *
 * Három hatókör (a felhasználó kérése szerint):
 *   session   — egy kiválasztott munkafolyamat, körönkénti bontással;
 *   workspace — a munkaterület összes munkafolyamata;
 *   + dátum intervallum, ami mindkettőt a magyar naptár szerint vágja.
 *
 * A mérés szándékosan NEM olvassa a beszélgetések tartalmát: csak időbélyegeket
 * és számosságokat használ.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalWorkspace, profileOf, resolveRate } from "./config.js";
import { activityPresence, humanTime, readActivity } from "./human.js";
import { clip, sumMs, totalMs, union, unionWithSlack } from "./intervals.js";
import { amountHuf, billableTime, grossHuf } from "./profile.js";
import { loadSession, loadSessionHeader, sessionLogFiles, sessionsRoot } from "./scan.js";
import { deriveSession } from "./turns.js";
import { dayOf, today } from "./time.js";

const isWindows = process.platform === "win32";

/** Két útvonal ugyanaz-e (kanonikus alak, Windows alatt kis/nagybetű-független). */
export function samePath(left, right) {
  const a = canonicalWorkspace(left);
  const b = canonicalWorkspace(right);
  if (a.length === 0 || b.length === 0) return false;
  const norm = (value) => (isWindows ? value.replace(/\//gu, "\\").toLowerCase() : value);
  return norm(a) === norm(b);
}

/** A munkaterület megjelenített neve (az utolsó útvonal-szegmens). */
export function workspaceLabel(workspace) {
  const trimmed = String(workspace ?? "").replace(/[\\/]+$/u, "");
  if (trimmed.length === 0) return "";
  const parts = trimmed.split(/[\\/]/u);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * Az összes session-rekord betöltése (root + delegált), a `since` utáni
 * fájlokból. A gyorsítótár miatt a második hívás gyors.
 *
 * @param {{root?: string, since: number, workspace?: string}} options
 * @returns {Promise<{records: object[], scanned: number, skipped: number}>}
 */
export async function loadSessions(options) {
  const root = options.root ?? sessionsRoot();
  const since = Number.isFinite(options.since) ? options.since : Date.now() - 30 * 24 * 3600000;
  const wanted = typeof options.workspace === "string" && options.workspace.length > 0 ? options.workspace : "";
  const files = sessionLogFiles(root);
  const records = [];
  let scanned = 0;
  let skipped = 0;
  for (const entry of files) {
    if (entry.mtimeMs < since) {
      skipped += 1;
      continue;
    }
    // Előszűrés a FEJLÉCBŐL (egyetlen zstd frame): a több száz megás,
    // más munkaterülethez tartozó naplókat így ki sem kell bontani.
    if (wanted.length > 0) {
      const header = await loadSessionHeader(entry.file, entry);
      if (header === null) {
        skipped += 1;
        continue;
      }
      if (!samePath(header.cwd, wanted)) {
        skipped += 1;
        continue;
      }
    }
    const record = await loadSession(entry.file, entry, deriveSession);
    scanned += 1;
    if (record === null || record === undefined) continue;
    if (record.lastEventAt < since) continue;
    if (wanted.length > 0 && !samePath(record.cwd, wanted)) continue;
    records.push(record);
  }
  return { records, scanned, skipped };
}

/**
 * A session hatókörű méréshez szükséges egy rekord kiválasztása.
 *
 * MIÉRT NEM `loadSessions` + szűrés: az összes napló teljes kibontása több perc
 * is lehet (több száz fájl, több MB-os frame-ekkel). Ezért előbb a FÁJLNÉVBEN
 * keressük az azonosítót (a session mappája/naplója hordozza: `session-<id>`),
 * és csak ha az nem talál, akkor nézzük a fejléceket — korlátozott számban.
 */
export async function findSession(sessionId, options) {
  const wanted = String(sessionId ?? "");
  if (wanted.length === 0) return null;
  const files = sessionLogFiles(options.root ?? sessionsRoot());

  // 1) fájlnév-egyezés (a leggyakoribb és legolcsóbb út)
  for (const entry of files) {
    if (!entry.file.includes(wanted)) continue;
    const record = await loadSession(entry.file, entry, deriveSession);
    if (record !== null && record !== undefined && record.id === wanted) return record;
  }

  // 2) korlátozott fejléc-bejárás (a legfrissebb 150 napló)
  const recent = [...files].sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 150);
  for (const entry of recent) {
    const header = await loadSessionHeader(entry.file, entry);
    if (header === null || header.id !== wanted) continue;
    return loadSession(entry.file, entry, deriveSession);
  }
  return null;
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/u, "").trim();
    if (text.length === 0) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Háttérmunkák (terminál-futások) ideje a `state\runs.json` alapján.
 *
 * PONTOSSÁG: a rekord csak az INDULÁST tárolja (a befejezéskor a rekord törlődik),
 * ezért a futás végét a jelenlegi idővel becsüljük, és a válasz `approximate`
 * jelzést ad. A súlya alapból 0 (a felhasználó szerint a relevanciája csekély),
 * tehát ez a bizonytalanság nem kerül a számlába.
 */
export function jobsTime(stateDir, workspace, window) {
  const rows = readJsonFile(join(stateDir, "runs.json"));
  const list = Array.isArray(rows) ? rows : [];
  let totalMs = 0;
  let count = 0;
  const items = [];
  const now = Date.now();
  for (const row of list) {
    if (row === null || typeof row !== "object") continue;
    if (!samePath(row.workspace, workspace)) continue;
    const startedAt = Date.parse(String(row.startedAt ?? ""));
    if (!Number.isFinite(startedAt)) continue;
    const start = Math.max(startedAt, window.from);
    const end = Math.min(now, window.to);
    if (!(end > start)) continue;
    totalMs += end - start;
    count += 1;
    items.push({ id: String(row.id ?? ""), label: String(row.label ?? ""), start, end, approximate: true });
  }
  return { jobsMs: totalMs, count, items, approximate: true };
}

/**
 * Kör-intervallumok egy session-ből, az ablakra vágva.
 */
export function turnIntervals(session, window) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  const intervals = [];
  for (const turn of turns) {
    if (turn === null || typeof turn !== "object") continue;
    if (turn.end === null || turn.end === undefined) continue;
    const start = Math.max(turn.start, window.from);
    const end = Math.min(turn.end, window.to);
    if (end > start) intervals.push({ start, end });
  }
  return intervals;
}

/**
 * A nyitott kör lezárása a MÉRÉSHEZ.
 *
 * MÉRT TANULSÁG (2026-11-17): ha a futó kört a „mostani idővel” zárjuk, egy
 * órákig nyitva hagyott (vagy a felhasználóra váró) kör AHHOZ képest mérődik —
 * a panel így felfújt agent-időt mutat. Ezért a nyitott kör vége az **utolsó
 * naplózott esemény** ideje: dolgozó körnél ez friss, elhagyottnál ott áll meg,
 * ahol a szerver tényleg abbahagyta.
 */
export function closeOpenTurns(session, now) {
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  const last = Number.isFinite(session?.lastEventAt) && session.lastEventAt > 0 ? session.lastEventAt : now;
  return turns.map((turn) => {
    if (turn.end !== null && turn.end !== undefined) return turn;
    return { ...turn, end: Math.max(turn.start, Math.min(now, last)), open: true };
  });
}

/**
 * A mérés fő belépője.
 *
 * @param {{
 *   scope: "session"|"workspace",
 *   sessionId?: string,
 *   workspace: string,
 *   from: number,
 *   to: number,
 *   config: object,
 *   profileId?: string,
 *   stateDir: string,
 *   root?: string,
 *   now?: number
 * }} options
 */
export async function measure(options) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const window = { from: options.from, to: Math.min(options.to ?? now, now) };
  const config = options.config;
  const workspace = options.workspace;
  const scope = options.scope === "session" ? "session" : "workspace";

  const resolved = resolveRate(config, workspace, options.profileId);
  const profile = profileOf(config, resolved.profileId);

  // A naplókat az ablaknál korábbra is be kell tölteni: egy session, ami az
  // ablak előtt indult, benne van az ablakban. 7 nap ráhagyás.
  const since = window.from - 7 * 24 * 3600000;
  const { records } = await loadSessions({ root: options.root, since, workspace });

  const inWorkspace = records.filter((record) => samePath(record.cwd, workspace));
  const roots = inWorkspace.filter((record) => record.delegationDepth === 0);
  const delegated = inWorkspace.filter((record) => record.delegationDepth > 0);

  const selected = scope === "session"
    ? roots.find((record) => record.id === String(options.sessionId ?? ""))
      ?? inWorkspace.find((record) => record.id === String(options.sessionId ?? ""))
      ?? null
    : null;

  const activity = readActivity(options.stateDir, Math.min(since, window.from));
  const notes = [];
  const sessions = [];
  const turnRows = [];
  let agentMs = 0;
  let readMs = 0;
  let typeMs = 0;
  let typeEstimatedMs = 0;
  let firstPromptMs = 0;
  let grossMs = 0;
  let openTurns = 0;
  const wallIntervals = [];
  const humanSources = new Set();

  const list = scope === "session" ? (selected === null ? [] : [selected]) : roots;
  if (scope === "session" && selected === null) {
    notes.push("A kiválasztott munkafolyamat nem található ebben a munkaterületen.");
  }

  for (const record of list) {
    const closed = closeOpenTurns(record, now);
    openTurns += closed.filter((turn) => turn.open === true).length;
    const recordWithClosed = { ...record, turns: closed };
    const intervals = clip(turnIntervals(recordWithClosed, window), window.from, window.to);
    const recordAgent = sumMs(intervals);
    const recordGross = (() => {
      const start = Math.max(record.firstEventAt, window.from);
      const end = Math.min(record.lastEventAt, window.to);
      return end > start ? end - start : 0;
    })();
    const bucket = activity.bySession.get(record.id);
    const human = humanTime(recordWithClosed, bucket, profile, window);
    typeEstimatedMs += Number.isFinite(human.estimatedTypeMs) ? human.estimatedTypeMs : 0;
    firstPromptMs += Number.isFinite(human.firstPromptMs) ? human.firstPromptMs : 0;
    humanSources.add(human.source);

    agentMs += recordAgent;
    readMs += human.readMs;
    typeMs += human.typeMs;
    grossMs += recordGross;
    for (const interval of intervals) wallIntervals.push(interval);

    sessions.push({
      id: record.id,
      label: record.id.replace(/^session-/u, "").slice(0, 8),
      firstAt: record.firstEventAt,
      lastAt: record.lastEventAt,
      turns: closed.length,
      openTurns: closed.filter((turn) => turn.open === true).length,
      agentMs: recordAgent,
      readMs: human.readMs,
      typeMs: human.typeMs,
      typeEstimatedMs: human.estimatedTypeMs,
      grossMs: recordGross,
      humanSource: human.source,
      activityMeasured: activityPresence(bucket),
      delegationDepth: record.delegationDepth,
    });

    if (scope === "session") {
      // A humanTime KÉT tételt adhat ugyanarra a körre: az olvasást a válasz
      // köré, a gépelést a beírt prompt köré teszi (2026-11-17) — ezért körönként
      // ÖSSZEVONJUK, nem soronként pusholunk.
      const rowsByTurn = new Map();
      const rowFor = (turn) => {
        let row = rowsByTurn.get(turn.turn);
        if (row === undefined) {
          row = {
            turn: turn.turn,
            start: turn.start,
            end: turn.end,
            open: turn.open === true,
            agentMs: Math.max(0, Math.min(turn.end, window.to) - Math.max(turn.start, window.from)),
            readMs: 0,
            typeMs: 0,
            estimated: false,
            gapMs: 0,
            humanSource: "none",
          };
          rowsByTurn.set(turn.turn, row);
        }
        return row;
      };
      for (const item of human.items) {
        const turn = closed.find((entry) => entry.turn === item.turn);
        if (turn === undefined) continue;
        const row = rowFor(turn);
        row.readMs += item.readMs;
        row.typeMs += item.typeMs;
        row.gapMs += item.gapMs;
        if (item.estimated === true) row.estimated = true;
        // A „prompt” a valós gépelést írja le (a felhasználó írta be) — ezt
        // megtartjuk, mert ez a beszédesebb forrás a sorban.
        if (row.humanSource === "none" || item.source === "prompt") row.humanSource = item.source;
      }
      for (const row of rowsByTurn.values()) turnRows.push(row);
      // A legutolsó körnek nincs párja (nincs „következő prompt”), ezért külön sor.
      const last = closed[closed.length - 1];
      if (last !== undefined && !turnRows.some((row) => row.turn === last.turn)) {
        turnRows.push({
          turn: last.turn,
          start: last.start,
          end: last.end,
          open: last.open === true,
          agentMs: Math.max(0, Math.min(last.end, window.to) - Math.max(last.start, window.from)),
          readMs: 0,
          typeMs: 0,
          gapMs: 0,
          humanSource: "edge",
        });
      }
      turnRows.sort((left, right) => left.turn - right.turn);
    }
  }

  const jobs = jobsTime(options.stateDir, workspace, window);
  const idleCapMs = Math.max(0, Number(profile.idleCapMinutes ?? 15)) * 60000;
  const wallMs = totalMs(unionWithSlack(wallIntervals, idleCapMs));

  const delegatedAgentMs = delegated.reduce((sum, record) => {
    const closed = closeOpenTurns(record, now);
    return sum + sumMs(turnIntervals({ ...record, turns: closed }, window));
  }, 0);

  const components = {
    agentMs,
    jobsMs: jobs.jobsMs,
    readMs,
    typeMs,
    // A gépelés azon része, ami a BEÍRT SZÖVEGBŐL becsült (nem kliens-mérés).
    typeEstimatedMs,
    wallMs,
    grossMs,
  };
  const billable = billableTime(components, profile);
  const netHuf = amountHuf(billable.billableMs, resolved.rate);
  const vatPercent = config?.vatEnabled === true ? Number(config?.vatPercent ?? 0) : 0;
  const money = grossHuf(netHuf, vatPercent);

  // Megjegyzések: minden olyan tény, ami a számot befolyásolja vagy éppen nem.
  notes.push(`A mérés ${list.length} session tartós naplójából készült.`);
  if (humanSources.has("fallback") && !humanSources.has("client")) {
    notes.push("Olvasás/gépelés bontás nélkül: ehhez az időszakhoz nincs kliens-oldali aktivitás-adat (napló-alapú tartalék).");
  } else if (humanSources.has("client") || humanSources.has("mixed")) {
    notes.push("Az olvasás/gépelés bontás a webes felület aktivitás-méréséből jön; a rejtett (nem nézett) idő kimarad.");
  }
  if (openTurns > 0) notes.push(`${openTurns} nyitott kör az utolsó naplózott esemény idejével lezárva.`);
  if (delegated.length > 0) {
    notes.push(`${delegated.length} alügynök-session (${Math.round(delegatedAgentMs / 60000)} perc) a szülő köridejében van, ezért nem duplázzuk.`);
  }
  if (jobs.count > 0) notes.push(`Háttérmunka: ${jobs.count} futás, becsült idő (a befejezés nincs naplózva).`);
  if (typeEstimatedMs > 0) {
    const cpm = Number.isFinite(profile.typingCharsPerMinute) && profile.typingCharsPerMinute > 0
      ? profile.typingCharsPerMinute
      : 150;
    const firstPart = firstPromptMs > 0
      ? ` — ebből ${Math.round(firstPromptMs / 60000)} perc a munkafolyamatok első promptjából`
      : "";
    notes.push(`A gépelés ${Math.round(typeEstimatedMs / 60000)} perce a beírt promptok hosszából becsülve (${cpm} leütés/perc)${firstPart}.`);
  }
  if (profile.roundToMinutes === 0) notes.push("Kerekítés: percre pontos (nincs felfelé kerekítés).");
  if (billable.billableMs !== billable.rawMs) {
    notes.push(`Kerekítés/minimum: ${Math.round(billable.rawMs / 60000)} perc -> ${Math.round(billable.billableMs / 60000)} perc.`);
  }

  return {
    ok: true,
    scope,
    workspace,
    workspaceLabel: workspaceLabel(workspace),
    from: window.from,
    to: window.to,
    fromDay: dayOf(window.from),
    toDay: dayOf(window.to),
    // FIGYELEM: a kulcs NEM `today` — a `toDay`-jel együtt a PowerShell
    // `ConvertFrom-Json` (kis/nagybetű-érzéketlen) ütközne, és a válasz
    // olvashatatlan lenne a CLI-eszközöknek (mért hiba).
    currentDay: today(now),
    now,
    rate: resolved.rate,
    rateSource: resolved.rateSource,
    profileSource: resolved.profileSource,
    profile: {
      id: profile.id,
      name: profile.name,
      weights: profile.weights,
      machineToHuman: profile.machineToHuman,
      idleCapMinutes: profile.idleCapMinutes,
      readCapMinutes: profile.readCapMinutes,
      typingCharsPerMinute: profile.typingCharsPerMinute,
      roundToMinutes: profile.roundToMinutes,
      minimumMinutes: profile.minimumMinutes,
      combine: profile.combine,
    },
    components,
    contributions: billable.contributions,
    rawMs: billable.rawMs,
    billableMs: billable.billableMs,
    minutes: billable.minutes,
    currency: config?.currency ?? "HUF",
    amount: money,
    vatPercent,
    humanSource: humanSources.size === 0 ? "none" : (humanSources.has("mixed") ? "mixed" : (humanSources.has("client") ? "client" : "fallback")),
    sessions,
    turns: turnRows,
    delegated: { sessions: delegated.length, agentMs: delegatedAgentMs },
    jobs: { count: jobs.count, items: jobs.items, approximate: true },
    activity: { records: activity.total, sessions: activity.bySession.size, bad: activity.bad },
    notes,
  };
}

/** A munkaterületek listája a naplók FEJLÉCEIBŐL (a választóhoz, teljes kibontás nélkül). */
export async function workspaceList(root) {
  const files = sessionLogFiles(root ?? sessionsRoot());
  const map = new Map();
  for (const entry of files) {
    const header = await loadSessionHeader(entry.file, entry);
    if (header === null) continue;
    const key = canonicalWorkspace(header.cwd);
    if (key.length === 0) continue;
    const bucket = map.get(key) ?? { path: key, label: workspaceLabel(key), sessions: 0, lastAt: 0 };
    bucket.sessions += 1;
    bucket.lastAt = Math.max(bucket.lastAt, entry.mtimeMs);
    map.set(key, bucket);
  }
  return [...map.values()].sort((left, right) => right.lastAt - left.lastAt);
}

/** A hatókörhöz tartozó session-lista (a munkafolyamat-választóhoz). */
export async function sessionList(options) {
  const { records } = await loadSessions({
    root: options.root,
    since: options.since ?? 0,
    workspace: options.workspace ?? "",
  });
  const out = [];
  for (const record of records) {
    if (record.delegationDepth !== 0) continue;
    if (!samePath(record.cwd, options.workspace)) continue;
    out.push({
      id: record.id,
      label: record.id.replace(/^session-/u, "").slice(0, 8),
      createdAt: record.createdAt,
      firstAt: record.firstEventAt,
      lastAt: record.lastEventAt,
      turns: record.turns.length,
      openTurns: record.openTurns,
      day: dayOf(record.firstEventAt || record.createdAt),
    });
  }
  out.sort((left, right) => right.lastAt - left.lastAt);
  return out;
}

/** A `state` mappa egyszerű elérése a méréshez. */
export function stateDirOf(repoRoot) {
  return join(repoRoot, "state");
}

/** Az unió-összeg (a párhuzamos session-ök nem duplázódnak). */
export const unionOf = union;
