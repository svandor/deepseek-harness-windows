/**
 * Session-napló -> mérésre kész rekord.
 *
 * A napló eseményei (a DSH `dsh-session` szerződése szerint):
 *   `turn/start`      {turn}
 *   `turn/end`        {turn, reason:{kind}}
 *   `step/start`      {turn, step}
 *   `step/end`        {turn, step}
 *   `user/message`    UserMessage  (a kör első emberi promptja)
 *   `assistant/message` {turn, step, message, usage, stream}
 *   `tool/call` / `tool/result`
 * Minden esemény `{type, seq, time, data}`, ahol `time` = Unix epoch ms.
 *
 * Ebből a modulból csak a MÉRÉSHEZ kellő adat lesz: kör-intervallumok és
 * számosságok. A tartalom (üzenetszöveg) szándékosan nem kerül tovább — a
 * mérés nem olvas bele a beszélgetésbe.
 */

/** Egy kör-intervallum: a mérés alapegysége. */
export const TURN_FIELDS = ["turn", "start", "end", "steps", "tools", "assistantMessages"];

/**
 * A naplóból kinyert session-rekord.
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   createdAt: number,
 *   delegationDepth: number,
 *   version: number,
 *   firstEventAt: number,
 *   lastEventAt: number,
 *   turns: Array<{turn: number, start: number, end: number|null, steps: number, tools: number, assistantMessages: number}>,
 *   openTurns: number,
 *   frames: number,
 *   truncated: boolean,
 *   badLines: number
 * }} SessionRecord
 */

function numberOf(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Származtatás a már beolvasott naplóból (a gyorsítótár ezt a függvényt hívja).
 * @returns {SessionRecord|null} null, ha a fájl nem session-napló
 */
export function deriveSession(parsed) {
  const { header, events } = parsed;
  if (!header) return null;
  const headerId = typeof header.id === "string" ? header.id : "";
  if (headerId.length === 0) return null;

  /** @type {Map<number, {turn: number, start: number, end: number|null, steps: number, tools: number, assistantMessages: number}>} */
  const byTurn = new Map();
  const order = [];
  let firstEventAt = 0;
  let lastEventAt = 0;

  const ensure = (turn, at) => {
    let entry = byTurn.get(turn);
    if (entry === undefined) {
      entry = { turn, start: at, end: null, steps: 0, tools: 0, assistantMessages: 0 };
      byTurn.set(turn, entry);
      order.push(turn);
    }
    return entry;
  };

  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    const type = typeof event.type === "string" ? event.type : "";
    const at = numberOf(event.time, 0);
    if (at > 0) {
      if (firstEventAt === 0 || at < firstEventAt) firstEventAt = at;
      if (at > lastEventAt) lastEventAt = at;
    }
    const data = event.data !== undefined && event.data !== null && typeof event.data === "object" ? event.data : {};
    switch (type) {
      case "turn/start": {
        const turn = numberOf(data.turn, order.length + 1);
        // Újrapróbált határ: a meglévő bejegyzés kezdetét NEM írjuk át (a valódi
        // kezdet a fontos), de ha még nincs, létrehozzuk.
        const entry = byTurn.get(turn);
        if (entry === undefined) ensure(turn, at);
        break;
      }
      case "turn/end": {
        const turn = numberOf(data.turn, order.length);
        const entry = ensure(turn, at);
        entry.end = at;
        break;
      }
      case "step/end": {
        const turn = numberOf(data.turn, order.length);
        ensure(turn, at).steps += 1;
        break;
      }
      case "tool/result": {
        const turn = numberOf(data.turn, order.length);
        ensure(turn, at).tools += 1;
        break;
      }
      case "assistant/message": {
        const turn = numberOf(data.turn, order.length);
        ensure(turn, at).assistantMessages += 1;
        break;
      }
      default:
        break;
    }
  }

  // A kör kezdete az ELSŐ hozzá tartozó esemény ideje: ha a `turn/start` hiányzik
  // (csonka napló eleje), a legkorábbi esemény a legjobb becslés.
  const turns = order.map((turn) => byTurn.get(turn)).filter((entry) => entry !== undefined && entry.start >= 0);

  return {
    id: headerId,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    createdAt: numberOf(header.createdAt, firstEventAt),
    delegationDepth: numberOf(header.delegationDepth, 0),
    version: numberOf(header.version, 0),
    firstEventAt,
    lastEventAt,
    turns,
    openTurns: turns.filter((entry) => entry.end === null).length,
    frames: numberOf(parsed.frames, 0),
    truncated: parsed.truncated === true,
    badLines: numberOf(parsed.badLines, 0),
  };
}
