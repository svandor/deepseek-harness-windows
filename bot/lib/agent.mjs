/**
 * Házirobot — mini-ügynök a konzolhoz.
 *
 * Nem indít DSH-sessiont: a robot **saját** eszközeit (jobok, állapot, napló,
 * beállítás, e-mail) adja a modellnek egy szűk akció-protokollon keresztül, és
 * a hívást a helyi proxy ingyenes láncán teszi. Így:
 *   - nulla plusz költség (a proxy lánca ingyenes),
 *   - a végrehajtás determinisztikus és naplózott (a modell csak kér),
 *   - a kockázatos művelethez jóváhagyás kell.
 *
 * A protokoll szándékosan egyszerű (soronkénti), mert a kis modellek a JSON-t
 * gyakran elrontják:
 *     AKCIÓ: {"action": "...", "params": {...}}
 *     VÁLASZ: <szöveg>
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadExtensions, extensionFile } from './extensions.mjs';
import { join } from 'node:path';
import { askLLM } from './llm.mjs';

/** Az akciók definíciója: melyik kockázatos, és mit vár paraméterként. */
export const ACTIONS = {
  allapot: { risky: false, params: [], leiras: 'a jobok, futások és az integrációs napló összegzése' },
  futtat_job: { risky: false, params: ['job'], leiras: 'egy job azonnali futtatása' },
  naplo: { risky: false, params: ['sor'], leiras: 'a napló utolsó sorai (alap 20)' },
  oldal_hozzaadas: { risky: false, params: ['nev', 'url'], leiras: 'figyelt oldal felvétele' },
  oldalak_listaja: { risky: false, params: [], leiras: 'a figyelt oldalak listája' },
  integracio_naplo: { risky: false, params: [], leiras: 'az integrációs napló (beküldések) állapota' },
  email_teszt: { risky: true, params: ['cimzett'], leiras: 'teszt e-mail küldése (jóváhagyással)' },
};

const ACTION_LINE_RE = /AKCIÓ:\s*([\s\S]*)$/im;
const ANSWER_RE = /VÁLASZ:\s*([\s\S]*)$/im;

/** A modell válaszából akció vagy végső válasz kiolvasása. */
export function parseModelReply(text) {
  const raw = String(text ?? '').trim();

  const actionLine = ACTION_LINE_RE.exec(raw);
  if (actionLine) {
    const tail = actionLine[1].trim();
    const first = tail.indexOf('{');
    const last = tail.lastIndexOf('}');
    if (first < 0 || last <= first) {
      return { kind: 'answer', text: raw, parseError: 'az AKCIÓ sorban nincs érvényes JSON' };
    }
    try {
      const parsed = JSON.parse(tail.slice(first, last + 1));
      if (parsed && typeof parsed.action === 'string') {
        return { kind: 'action', action: parsed.action, params: parsed.params ?? {} };
      }
      return { kind: 'answer', text: raw, parseError: 'az AKCIÓ-ból hiányzik az "action" mező' };
    } catch (err) {
      return { kind: 'answer', text: raw, parseError: `az AKCIÓ nem érvényes JSON (${err.message})` };
    }
  }

  const answerMatch = ANSWER_RE.exec(raw);
  if (answerMatch) return { kind: 'answer', text: answerMatch[1].trim() };
  return { kind: 'answer', text: raw };
}

/**
 * A robot személyisége: a nyilvános `agent.md` + a telepített integrációs
 * modulok kiegészítései.
 *
 * MIÉRT ÍGY: a `bot/agent.md` általános (a keretrendszer része, nyilvános), a
 * telepítés-specifikus tudnivalók viszont privátak — a beállított feladatokra
 * vonatkozó szabályok nem tartoznak a nyilvános repóra. A `bot/extensions.json`
 * (gitignore-olt) `szemelyiseg` mezője mondja meg, melyik fájlt kell a végére
 * fűzni; modul nélkül csak az általános rész marad.
 */
function readPersona(rootDir) {
  const path = join(rootDir, 'agent.md');
  const base = existsSync(path)
    ? readFileSync(path, 'utf8')
    : 'Te a Házirobot vagy. Magyarul, röviden válaszolj.';

  const parts = [];
  for (const extension of loadExtensions(rootDir)) {
    const extra = extensionFile(rootDir, extension, 'szemelyiseg');
    if (!extra) continue;
    try {
      parts.push(readFileSync(extra, 'utf8'));
    } catch {
      // Olvashatatlan kiegészítés nem állítja meg a beszélgetést.
    }
  }
  return parts.length === 0 ? base : `${base}\n\n---\n\n${parts.join('\n\n---\n\n')}`;
}

function actionCatalogue() {
  return Object.entries(ACTIONS)
    .map(([name, def]) => `- ${name}${def.params.length ? ` (${def.params.join(', ')})` : ''}: ${def.leiras}${def.risky ? ' [JÓVÁHAGYÁS KELL]' : ''}`)
    .join('\n');
}

/**
 * Egy beszélgetési kör lefuttatása.
 *
 * @param {object} opts
 *   cfg        – a betöltött konfiguráció (proxy, llm)
 *   rootDir    – a bot mappa (agent.md)
 *   text       – a felhasználó üzenete
 *   history    – korábbi üzenetek [{role, content}]
 *   ctxSummary – rövid állapot-összefoglaló, amit minden körben megadunk
 *   execute    – async (action, params, {approved}) => { ok, text, needsApproval? }
 *   approved   – a felhasználó már jóváhagyta-e a kockázatos műveletet
 *   log        – naplófüggvény
 */
export async function runAgent({ cfg, rootDir, text, history = [], ctxSummary = '', execute, approved = false, dryRun = false, log = () => {}, maxRounds = 4 }) {
  const system = [
    readPersona(rootDir),
    '',
    '## Elérhető akciók',
    actionCatalogue(),
    '',
    '## A robot jelenlegi állapota',
    ctxSummary || '(nincs összefoglaló)',
    '',
    'Válaszformátum: vagy `AKCIÓ: {"action": "...", "params": {...}}`, vagy `VÁLASZ: <szöveg>`.',
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
    { role: 'user', content: String(text ?? '') },
  ];

  const steps = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let round = 0; round < maxRounds; round++) {
    const res = await askLLM(cfg, { messages, maxTokens: 900, temperature: 0.2, dryRun, log });
    if (!res.ok) {
      const fallback = steps.length
        ? `A modell nem válaszolt (${res.error ?? 'ismeretlen hiba'}), de a kért műveleteket elvégeztem:\n${steps.map((s) => `- ${s}`).join('\n')}`
        : 'A modell most nem érhető el (a helyi proxy nem válaszol), és önálló műveletet nem kértél. Próbáld újra, vagy használd a parancssávot.';
      return { ok: false, reply: fallback, steps, tokensIn, tokensOut, error: res.error ?? 'LLM_HIBA' };
    }
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;

    const parsed = parseModelReply(res.text);
    log(`kör ${round + 1}: ${parsed.kind === 'action' ? `akció: ${parsed.action}` : 'végső válasz'}`);

    if (parsed.kind === 'answer') {
      const reply = parsed.parseError ? `${parsed.text}\n\n(Megjegyzés: ${parsed.parseError})` : parsed.text;
      return { ok: true, reply, steps, tokensIn, tokensOut };
    }

    const def = ACTIONS[parsed.action];
    if (!def) {
      messages.push({ role: 'assistant', content: res.text });
      messages.push({ role: 'user', content: `Nincs ilyen akció: ${parsed.action}. Válassz a listából, vagy adj VÁLASZ-t.` });
      continue;
    }
    if (def.risky && !approved) {
      return {
        ok: true,
        reply: `Ehhez a művelethez jóváhagyás kell: **${parsed.action}** (${def.leiras}).`,
        steps,
        tokensIn,
        tokensOut,
        needsApproval: { action: parsed.action, params: parsed.params },
      };
    }

    const result = await execute(parsed.action, parsed.params ?? {}, { approved });
    steps.push(`${parsed.action}: ${result.ok ? 'ok' : 'hiba'} — ${String(result.text ?? '').slice(0, 160)}`);
    log(`akció eredménye (${parsed.action}): ${result.ok ? 'ok' : 'hiba'}`);
    messages.push({ role: 'assistant', content: res.text });
    messages.push({
      role: 'user',
      content: `Az akció eredménye:\n${String(result.text ?? '').slice(0, 4000)}\n\nHa kész vagy, adj VÁLASZ-t. Ha kell még valami, kérj újabb AKCIÓ-t.`,
    });
  }

  return {
    ok: true,
    reply: `Több körben sem jutottam végső válaszra. Amit elvégeztem:\n${steps.map((s) => `- ${s}`).join('\n') || '(semmit)'}`,
    steps,
    tokensIn,
    tokensOut,
  };
}
