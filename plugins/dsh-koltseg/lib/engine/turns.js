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
 * számosságok. A tartalom (üzenetszöveg) továbbra sem kerül tovább — a mérés
 * nem olvas bele a beszélgetésbe.
 *
 * KIVÉTEL (2026-11-17, a felhasználó kérése): a **felhasználó által beírt**
 * prompt HOSSZA (karakterszám) igen, mert abból visszamenőleg becsülhető a
 * gépelés ideje. Csak a hossz kerül tovább, a szöveg maga nem.
 */

/** Egy kör-intervallum: a mérés alapegysége. */
export const TURN_FIELDS = ["turn", "start", "end", "steps", "tools", "assistantMessages", "promptChars"];

/**
 * A `user/message` eseményből a FELHASZNÁLÓ által gépelt szöveg hossza.
 *
 * MIÉRT CSAK A HOSSZ: a mérés nem akar tartalmat látni; a gépelés idejéhez
 * (karakter / leütés-perc) a hossz elég.
 *
 * MIÉRT KELL SZŰRNI: a `user/message` eseménybe a DSH mindenféle befecskendezett
 * szöveget is tesz (AGENTS.md-emlékeztető, alügynök-értesítő, tömörített
 * összefoglaló, plugin-figyelmeztetés). Ezek forrása nem `user`, hosszuk viszont
 * 10–60 ezer karakter (MÉRVE: 61 348 karakteres AGENTS-emlékeztető) — ha ezeket
 * beleszámolnánk, a gépelés néhány perc helyett több nap lenne.
 */
export function promptCharacters(data) {
  const source = data?.source;
  if (source !== undefined && source !== null) {
    const kind = typeof source === "object" ? String(source.kind ?? "") : String(source);
    if (kind !== "user") return 0;
  }
  const content = data?.content;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
    }
  }
  return chars;
}

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
 *   turns: Array<{turn: number, start: number, end: number|null, steps: number, tools: number, assistantMessages: number, promptChars: number}>,
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

  /** @type {Map<number, {turn: number, start: number, end: number|null, steps: number, tools: number, assistantMessages: number, promptChars: number}>} */
  const byTurn = new Map();
  const order = [];
  /** A felhasználó által beírt promptok: `{at, chars}` (a körhöz utólag kötjük). */
  const typedPrompts = [];
  let firstEventAt = 0;
  let lastEventAt = 0;

  const ensure = (turn, at) => {
    let entry = byTurn.get(turn);
    if (entry === undefined) {
      entry = { turn, start: at, end: null, steps: 0, tools: 0, assistantMessages: 0, promptChars: 0 };
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
      case "user/message": {
        // Csak a FELHASZNÁLÓ gépelte szöveg hossza érdekel (a befecskendezett
        // emlékeztetőké nem) — a körhöz a ciklus után kötjük, mert a üzenet
        // néhány tíz ms-mal a `turn/start` UTÁN érkezik (MÉRVE 2026-11-17).
        const chars = promptCharacters(data);
        if (chars > 0) typedPrompts.push({ at, chars });
        break;
      }
      default:
        break;
    }
  }

  // A kör kezdete az ELSŐ hozzá tartozó esemény ideje: ha a `turn/start` hiányzik
  // (csonka napló eleje), a legkorábbi esemény a legjobb becslés.
  const turns = order.map((turn) => byTurn.get(turn)).filter((entry) => entry !== undefined && entry.start >= 0);

  // A beírt promptok hozzárendelése a KÖRhöz, amit kiváltottak: az utolsó olyan
  // kör, amelynek kezdete legfeljebb 5 másodperccel az üzenet ELŐTT van (a
  // `user/message` a `turn/start` után ~30 ms-mal jön); ha nincs ilyen, a
  // legközelebbi következő kör, végső esetben az utolsó kör.
  if (typedPrompts.length > 0 && turns.length > 0) {
    for (const item of typedPrompts) {
      let target = null;
      for (const turn of turns) {
        if (turn.start <= item.at + 5000) target = turn;
        else break;
      }
      if (target === null) {
        target = turns.find((turn) => turn.start >= item.at) ?? turns[turns.length - 1];
      }
      target.promptChars += item.chars;
    }
  }

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
