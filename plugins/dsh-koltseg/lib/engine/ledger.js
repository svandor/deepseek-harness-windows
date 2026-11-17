/**
 * Rögzített elszámolások (ledger).
 *
 * MIÉRT KELL: az óradíj és a profil változhat. Ha a múltat minden lekérdezés
 * újraszámolná, egy díjemelés visszamenőleg átírná a korábbi kimutatásokat.
 * A rögzítés ezért PILLANATKÉPET ment: az akkori díjjal, profillal és
 * percekkel — a későbbi változás azt már nem érinti.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** A ledger fájl neve. */
export const LEDGER_FILE = "ledger.jsonl";

/** Rotálási küszöb (a rekordok megmaradnak, csak külön fájlba kerülnek). */
const ROTATE_BYTES = 5 * 1024 * 1024;

/** A ledger útvonala. */
export function ledgerPath(stateDir) {
  return join(stateDir, "koltseg", LEDGER_FILE);
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Egy rögzítendő elszámolás normalizálása.
 * @returns {{entry: object|null, error: string}}
 */
export function normalizeEntry(input, now = Date.now()) {
  if (input === null || typeof input !== "object") return { entry: null, error: "hiányzó elszámolás" };
  const workspace = typeof input.workspace === "string" ? input.workspace : "";
  if (workspace.length === 0) return { entry: null, error: "hiányzó munkaterület" };
  const minutes = numberOr(input.minutes, Number.NaN);
  if (!Number.isFinite(minutes) || minutes < 0) return { entry: null, error: "érvénytelen percérték" };
  const rate = numberOr(input.rate, Number.NaN);
  if (!Number.isFinite(rate) || rate <= 0) return { entry: null, error: "érvénytelen óradíj" };
  const net = numberOr(input.net, Math.round((minutes / 60) * rate));
  const vat = numberOr(input.vat, 0);
  const gross = numberOr(input.gross, net + vat);
  const id = typeof input.id === "string" && input.id.length > 0
    ? input.id
    : `k-${now}-${Math.floor(Math.random() * 10000)}`;
  return {
    error: "",
    entry: {
      id,
      at: now,
      scope: input.scope === "session" ? "session" : "workspace",
      workspace,
      workspaceLabel: typeof input.workspaceLabel === "string" ? input.workspaceLabel : "",
      from: numberOr(input.from, 0),
      to: numberOr(input.to, now),
      fromDay: typeof input.fromDay === "string" ? input.fromDay : "",
      toDay: typeof input.toDay === "string" ? input.toDay : "",
      profileId: typeof input.profileId === "string" ? input.profileId : "",
      profileName: typeof input.profileName === "string" ? input.profileName : "",
      rate,
      minutes: Math.round(minutes * 100) / 100,
      net,
      vat,
      gross,
      vatPercent: numberOr(input.vatPercent, 0),
      sessions: numberOr(input.sessions, 0),
      turns: numberOr(input.turns, 0),
      note: typeof input.note === "string" ? input.note.slice(0, 500) : "",
    },
  };
}

/**
 * Elszámolás rögzítése (append-only; 5 MB fölött rotál).
 */
export function appendLedger(stateDir, input, now = Date.now()) {
  const { entry, error } = normalizeEntry(input, now);
  if (entry === null) return { ok: false, error };
  const path = ledgerPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (existsSync(path) && statSync(path).size > ROTATE_BYTES) {
      renameSync(path, join(dirname(path), `ledger.${now}.jsonl`));
    }
  } catch {
    /* a rotálás hibája nem állíthatja meg a rögzítést */
  }
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  return { ok: true, entry, path };
}

/** Az összes rögzített elszámolás, legújabb elöl. */
export function readLedger(stateDir) {
  const path = ledgerPath(stateDir);
  if (!existsSync(path)) return { entries: [], bad: 0, path };
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries: [], bad: 0, path };
  }
  const entries = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.id === "string") entries.push(parsed);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  entries.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  return { entries, bad, path };
}

/** Egy rögzítés törlése (a fájl újraírása atomikusan, temp + rename). */
export function removeLedger(stateDir, id) {
  const path = ledgerPath(stateDir);
  const { entries } = readLedger(stateDir);
  const wanted = String(id ?? "");
  if (wanted.length === 0) return { ok: false, error: "hiányzó azonosító", removed: 0 };
  const kept = entries.filter((entry) => entry.id !== wanted);
  const removed = entries.length - kept.length;
  if (removed === 0) return { ok: false, error: "nincs ilyen rögzítés", removed: 0 };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
  renameSync(temp, path);
  return { ok: true, removed, path };
}

/**
 * CSV a rögzítésekből (magyar formátum: pontosvessző, vesszős tizedes).
 */
export function ledgerCsv(entries) {
  const header = ["id", "rogzites", "munkaterulet", "tol", "ig", "profil", "oradij", "perc", "netto", "afa", "brutto"];
  const rows = [header.join(";")];
  for (const entry of entries) {
    const cells = [
      entry.id,
      new Date(entry.at ?? 0).toISOString(),
      entry.workspaceLabel || entry.workspace,
      entry.fromDay,
      entry.toDay,
      entry.profileName || entry.profileId,
      String(entry.rate ?? 0),
      String(entry.minutes ?? 0).replace(".", ","),
      String(entry.net ?? 0),
      String(entry.vat ?? 0),
      String(entry.gross ?? 0),
    ];
    rows.push(cells.map((cell) => String(cell).replace(/;/gu, ",")).join(";"));
  }
  return `${rows.join("\n")}\n`;
}
