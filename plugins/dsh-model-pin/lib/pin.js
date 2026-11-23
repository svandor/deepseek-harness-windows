/**
 * dsh-model-pin — a rögzített alapértelmezett modell TISZTA szabálya.
 *
 * MIÉRT KÜLÖN MODUL: ez a döntés (kell-e javítani, mit kell írni, mikor álljon
 * le a javítás) FS, hálózat és cordis nélkül tesztelhető kell legyen — a
 * hurokvédelem és a „nem írunk feleslegesen" szabály a legkönnyebben
 * elrontható rész, azt tesztek fedik.
 *
 * A harness oldala (MÉRVE, 2026-11-23):
 *   - `dsh-api-session-controller` `selectModel()` minden modellváltás után
 *     `agentDefaultModel.saveSelection(selected)`-et hív,
 *   - az `dsh-agent-default-model` ezt a `settings.yaml`
 *     `agent-default-model` szekciójába írja (user layer),
 *   - az új munkamenet `agentOptions`-a és a kliens modellválasztójának
 *     alapértéke (`catalog.default`) is ezt olvassa,
 *   ezért a legutóbb választott modell lett a következő munkamenet
 *   alapértelmezése. A rögzítés ezt a driftet állítja vissza.
 *
 * @module dsh-model-pin/lib/pin
 */

/** A settings-namespace, amit rögzítünk (a mag `dsh-agent-default-model`-é). */
export const NAMESPACE = 'agent-default-model';

/**
 * A gyári rögzítés: DeepSeek V4.1 Flash, `high` gondolkodással.
 * Ez akkor él, ha a `pin.json` hiányzik vagy olvashatatlan — a szándék akkor is
 * ez, ezért a tartalék NEM „nincs rögzítés", hanem ugyanez az érték.
 */
export const DEFAULT_PIN = Object.freeze({
  enabled: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'high'
});

/** Hibás `pin.json` — a hívó naplózza és a tartalékra esik vissza. */
export class PinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PinError';
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} field @returns {string} */
function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PinError(`a "${field}" kötelező, nem üres szöveg kell legyen`);
  }
  return value.trim();
}

/**
 * Egy nyers `pin.json` érték normalizálása.
 * @param {unknown} value - a beolvasott JSON.
 * @returns {{enabled: boolean, provider: string, model: string, reasoningEffort?: string}}
 * @throws {PinError} ha a szabály alakja hibás.
 */
export function parsePin(value) {
  if (!isPlainObject(value)) throw new PinError('a pin.json gyökere objektum kell legyen');
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== 'boolean') throw new PinError('az "enabled" logikai érték (true/false) kell legyen');
  const provider = requiredText(value.provider, 'provider');
  const model = requiredText(value.model, 'model');
  /** @type {{enabled: boolean, provider: string, model: string, reasoningEffort?: string}} */
  const pin = { enabled, provider, model };
  const effort = value.reasoningEffort;
  if (effort !== undefined && effort !== null) {
    pin.reasoningEffort = requiredText(effort, 'reasoningEffort');
  }
  return pin;
}

/**
 * Egy `pin.json` szöveg beolvasása.
 * @param {string} text
 * @returns {ReturnType<typeof parsePin>}
 * @throws {PinError} ha a JSON vagy a szabály hibás.
 */
export function parsePinText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PinError(`a pin.json nem érvényes JSON: ${String(error && error.message ? error.message : error)}`);
  }
  return parsePin(value);
}

/**
 * A rögzítés cél-értéke (a settings user layer elvárt tartalma).
 * @param {ReturnType<typeof parsePin>} pin
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
export function pinTarget(pin) {
  return {
    provider: pin.provider,
    model: pin.model,
    ...(pin.reasoningEffort === undefined ? {} : { reasoningEffort: pin.reasoningEffort })
  };
}

/**
 * Illeszkedik-e a jelenlegi alapértelmezés a rögzítéshez.
 *
 * Ha a rögzítés NEM ad meg `reasoningEffort`-ot, akkor a gondolkodás szintje
 * szabad (a szolgáltató dönt) — csak a szolgáltató és a modell számít.
 * @param {{provider?: unknown, model?: unknown, reasoningEffort?: unknown}} current
 * @param {ReturnType<typeof parsePin>} pin
 * @returns {boolean}
 */
export function isPinned(current, pin) {
  if (!isPlainObject(current)) return false;
  if (current.provider !== pin.provider) return false;
  if (current.model !== pin.model) return false;
  if (pin.reasoningEffort === undefined) return true;
  return current.reasoningEffort === pin.reasoningEffort;
}

/**
 * A javításhoz szükséges írás terve — `undefined`, ha nincs teendő.
 *
 * Két út van, mert a settings API merge-el: ha a rögzítés ad gondolkodási
 * szintet, egy `update` elég; ha NEM ad, a korábbi írásból visszamaradt szintet
 * KI KELL VENNI (különben egy másik modellhez tartozó effort ragadna a Flash-re,
 * és a kérés-összeállítás elutasíthatja). Arra a `mutate` az egyetlen helyes út.
 * @param {{provider?: unknown, model?: unknown, reasoningEffort?: unknown}} current
 * @param {ReturnType<typeof parsePin>} pin
 * @returns {undefined | {mode: 'update', patch: object} | {mode: 'mutate', ops: object[]}}
 */
export function planCorrection(current, pin) {
  if (!pin.enabled) return undefined;
  if (isPinned(current, pin)) return undefined;
  if (pin.reasoningEffort !== undefined) {
    return { mode: 'update', patch: pinTarget(pin) };
  }
  return {
    mode: 'mutate',
    ops: [
      { op: 'set', path: ['provider'], value: pin.provider },
      { op: 'set', path: ['model'], value: pin.model },
      { op: 'unset', path: ['reasoningEffort'] }
    ]
  };
}

/**
 * Embernek olvasható címke egy kiválasztáshoz (naplóhoz, riportokhoz).
 * @param {{provider?: unknown, model?: unknown, reasoningEffort?: unknown} | undefined} selection
 * @returns {string}
 */
export function describeSelection(selection) {
  if (!isPlainObject(selection)) return '(nincs beállítva)';
  const provider = typeof selection.provider === 'string' ? selection.provider : '?';
  const model = typeof selection.model === 'string' ? selection.model : '?';
  const effort = typeof selection.reasoningEffort === 'string' ? `:${selection.reasoningEffort}` : '';
  return `${provider}/${model}${effort}`;
}

/**
 * Korlátozott újrapróbálkozás (AGENTS.md 1.7): időablakon belül legfeljebb
 * `limit` javítás. Ha egy másik komponens folyamatosan visszaírja a driftet,
 * a plugin NEM indít lavinát, hanem leáll és naplózza.
 * @param {{limit?: number, windowMs?: number}} [options]
 */
export function createCircuitBreaker(options = {}) {
  const limit = options.limit ?? 6;
  const windowMs = options.windowMs ?? 60_000;
  /** @type {number[]} */
  let hits = [];
  return {
    /**
     * @param {number} now - `Date.now()`.
     * @returns {boolean} true = szabad a javítás.
     */
    tryPass(now) {
      hits = hits.filter((at) => now - at < windowMs);
      if (hits.length >= limit) return false;
      hits.push(now);
      return true;
    },
    /** A számláló nullázása (pl. sikeres javítás után nem kell, de teszthez kell). */
    reset() {
      hits = [];
    },
    /** @returns {number} az ablakon belüli próbák száma. */
    count() {
      return hits.length;
    },
    /** @returns {number} a plafon. */
    limit() {
      return limit;
    },
    /** @returns {number} az ablak hossza ms-ban. */
    windowMs() {
      return windowMs;
    }
  };
}
