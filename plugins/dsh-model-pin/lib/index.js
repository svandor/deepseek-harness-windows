/**
 * dsh-model-pin — az új munkamenet alapértelmezett modellje MINDIG a rögzített
 * modell (alapból DeepSeek V4.1 Flash), függetlenül attól, hogy az előző
 * beszélgetésben melyik modellt választotta a felhasználó.
 *
 * MIÉRT KELL (mért ok, 2026-11-23): a felhasználó jelezte, hogy új munkamenet
 * indításakor a modellválasztó a LEGUTÓBB választott modellt ajánlja fel. A
 * lánc: `dsh-api-session-controller` `selectModel()` → `agentDefaultModel
 * .saveSelection()` → a `settings.yaml` `agent-default-model` szekciója
 * felülíródik; az új munkamenet `agentOptions`-a és a kliens választójának
 * alapértéke ugyanezt olvassa. A felhasználó kérése: ez az alapértelmezés
 * SOHA ne drifteljen.
 *
 * MIT TESZ:
 *   1) induláskor helyreállítja az alapértelmezést (a settings user layer a
 *      kompozíciós alap fölé íródhatott a legutóbbi modellváltáskor),
 *   2) figyeli a `settings/updated` eseményt, és minden driftet
 *      VISSZAÁLLÍT a rögzítésre — a `settings.yaml` marad az igazság forrása,
 *      a beszélgetés saját modellválasztását NEM érinti (az session-lokális),
 *   3) a `pin.json` (a plugin mellett, hot-reload mtime szerint) a rögzítés
 *      egyetlen helye; `enabled: false` kikapcsolja.
 *
 * BIZTONSÁG: a plugin SOHA nem állíthatja meg a bootot, és nem indíthat
 * lavinát: minden hívás try/catch-ben fut, a javítások száma időablakos
 * fékre megy (AGENTS.md 1.7), és a napló mindent kimond (JSONL).
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PIN,
  NAMESPACE,
  createCircuitBreaker,
  describeSelection,
  isPinned,
  parsePinText,
  pinTarget,
  planCorrection
} from './pin.js';

/** A plugin neve a boot gráfban. */
const name = 'dsh-model-pin';

/** Nincs kötelező szolgáltatás: a settings-et `ctx.inject`-tel várjuk meg. */
const inject = [];

/** A rögzítés a plugin mellett él (verziózott, a repóban; hot-reload). */
const PIN_FILE = fileURLToPath(new URL('../pin.json', import.meta.url));

/** Napló felső korlát: ennyi után a fájl újraindul (ne hízzon). */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** Hányszor próbáljuk újra, ha a settings-namespace még nem regisztrált. */
const MISSING_RETRIES = 3;

/** Két próba között ennyit várunk (ms). */
const MISSING_RETRY_DELAY_MS = 1000;

/** A napló alapértelmezett helye: a DSH home (a harness processze írhatja). */
function defaultLogPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'model-pin.log');
}

/** Biztonságos naplózás a harness loggerébe (a plugin nem eshet el rajta). */
function logLine(ctx, level, message) {
  try {
    ctx?.logger?.[level]?.(`[${name}] ${message}`);
  } catch {
    /* a log nem kritikus */
  }
}

/** Egy JSONL sor a bizonyíték-naplóba (hiba esetén sem blokkol). */
function appendLog(file, entry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_MAX_BYTES) truncateSync(file, 0);
    } catch {
      /* még nincs fájl */
    }
    appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* a naplózás hibája nem blokkolhat */
  }
}

/**
 * A `pin.json` hot-reload olvasója (mtime szerint). Hibás/hiányzó fájl esetén a
 * beépített rögzítés él — a szándék ugyanaz, csak a forrás nem a fájl.
 * @param {string} file
 * @returns {() => {pin: ReturnType<typeof import('./pin.js').parsePin>, source: 'file' | 'fallback', error?: string, file: string}}
 */
function createPinLoader(file) {
  /** @type {{mtimeMs: number, result: {pin: any, source: 'file' | 'fallback', error?: string, file: string}}} */
  let last = {
    mtimeMs: Number.NaN,
    result: { pin: DEFAULT_PIN, source: 'fallback', error: `a pin.json nem található: ${file}`, file }
  };
  return function load() {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = -1;
    }
    if (mtimeMs === last.mtimeMs) return last.result;
    /** @type {{pin: any, source: 'file' | 'fallback', error?: string, file: string}} */
    let result;
    if (mtimeMs < 0) {
      result = { pin: last.result.pin, source: 'fallback', error: `a pin.json nem található: ${file}`, file };
    } else {
      try {
        result = { pin: parsePinText(readFileSync(file, 'utf8')), source: 'file', file };
      } catch (error) {
        // A hibás fájl NEM eshet vissza csendben egy másik modellre: a korábbi
        // jó rögzítés (vagy a beépített Flash) marad, és a hiba a naplóba megy.
        result = {
          pin: last.result.pin,
          source: 'fallback',
          error: `${String(error && error.message ? error.message : error)} (${file})`,
          file
        };
      }
    }
    last = { mtimeMs, result };
    return result;
  };
}

/**
 * Plugin belépési pont.
 * @param {object} ctx - cordis context.
 * @param {{pinPath?: string, logPath?: string}} [config] - opcionális felülírás.
 */
function apply(ctx, config = {}) {
  const pinFile = config.pinPath ?? PIN_FILE;
  const logFile = config.logPath ?? defaultLogPath();
  const load = createPinLoader(pinFile);

  /** Az utoljára KIMONDOTT rögzítés-állapot (ne ismételjük a naplót minden eventre). */
  let announced = undefined;

  try {
    const loaded = load();
    appendLog(logFile, {
      at: new Date().toISOString(),
      kind: 'boot',
      pin: describeSelection(pinTarget(loaded.pin)),
      pinSource: loaded.source,
      pinFile,
      logFile,
      ...(loaded.error === undefined ? {} : { pinError: loaded.error })
    });
    logLine(ctx, 'info', `aktív — rögzített alapértelmezés: ${describeSelection(pinTarget(loaded.pin))} (${loaded.source}: ${pinFile})`);
    if (loaded.error !== undefined) logLine(ctx, 'warn', loaded.error);
  } catch (error) {
    logLine(ctx, 'warn', `induláskori naplózás hiba: ${String(error)}`);
  }

  try {
    ctx.inject(['settings'], (sctx) => {
      const settings = sctx.settings;
      const breaker = createCircuitBreaker();
      /** @type {Promise<void>} */
      let chain = Promise.resolve();
      let missingRetries = MISSING_RETRIES;
      let fusedLogged = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let retryTimer;

      /** A rögzítés forrásának kimondása, csak amikor az állapot VÁLTOZOTT. */
      function announce(loaded) {
        const key = `${loaded.source}|${loaded.error ?? ''}|${describeSelection(loaded.pin)}`;
        if (key === announced) return;
        announced = key;
        if (loaded.source === 'file') {
          logLine(ctx, 'info', `rögzítés betöltve: ${describeSelection(pinTarget(loaded.pin))}`);
        } else {
          logLine(ctx, 'warn', `a pin.json nem használható, a beépített rögzítés él: ${describeSelection(pinTarget(loaded.pin))} — ${loaded.error}`);
        }
      }

      /** Egy javítási kör. */
      async function correct(reason) {
        const loaded = load();
        announce(loaded);
        const pin = loaded.pin;
        if (!pin.enabled) {
          appendLog(logFile, { at: new Date().toISOString(), kind: 'disabled', reason });
          logLine(ctx, 'info', `a rögzítés ki van kapcsolva (pin.json: enabled=false) — nincs javítás (${reason})`);
          return;
        }
        let current;
        try {
          current = settings.get(NAMESPACE);
        } catch (error) {
          logLine(ctx, 'warn', `a "${NAMESPACE}" nem olvasható: ${String(error)}`);
          return;
        }
        if (current === undefined) {
          // A mag pluginja még nem regisztrálta a namespacet (boot-sorrend):
          // korlátozott számú próba, hogy a javítás ne maradjon el némán.
          if (missingRetries <= 0) {
            logLine(ctx, 'warn', `a "${NAMESPACE}" nincs regisztrálva — a rögzítés most nem ellenőrizhető (${reason})`);
            return;
          }
          missingRetries -= 1;
          if (retryTimer === undefined) {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void enforce('retry-missing-namespace');
            }, MISSING_RETRY_DELAY_MS);
            try {
              retryTimer.unref?.();
            } catch {
              /* nem kritikus */
            }
          }
          return;
        }
        missingRetries = MISSING_RETRIES;
        if (isPinned(current, pin)) return;
        if (!breaker.tryPass(Date.now())) {
          if (!fusedLogged) {
            fusedLogged = true;
            appendLog(logFile, {
              at: new Date().toISOString(),
              kind: 'fuse',
              reason,
              limit: breaker.limit(),
              windowMs: breaker.windowMs(),
              from: describeSelection(current),
              to: describeSelection(pinTarget(pin))
            });
            logLine(ctx, 'warn', `túl sok drift (${breaker.limit()} / ${Math.round(breaker.windowMs() / 1000)} s) — a javítás leállt, amíg valami folyamatosan visszaírja`);
          }
          return;
        }
        const plan = planCorrection(current, pin);
        if (plan === undefined) return;
        const from = describeSelection(current);
        const to = describeSelection(pinTarget(pin));
        try {
          if (plan.mode === 'update') await settings.update(NAMESPACE, plan.patch);
          else await settings.mutate(NAMESPACE, plan.ops);
          fusedLogged = false;
          appendLog(logFile, {
            at: new Date().toISOString(),
            kind: 'corrected',
            reason,
            from,
            to,
            pinSource: loaded.source
          });
          logLine(ctx, 'info', `alapértelmezés visszaállítva: ${from} → ${to} (${reason})`);
        } catch (error) {
          appendLog(logFile, {
            at: new Date().toISOString(),
            kind: 'error',
            reason,
            from,
            to,
            error: String(error && error.message ? error.message : error)
          });
          logLine(ctx, 'warn', `a javítás nem sikerült (${from} → ${to}): ${String(error)}`);
        }
      }

      /**
       * A javítások EGYMÁS UTÁN futnak (a settings írásai is sorban mennek), így
       * két gyors modellváltás nem indít párhuzamos írásokat ugyanarra a szekcióra.
       * @param {string} reason
       * @returns {Promise<void>}
       */
      function enforce(reason) {
        chain = chain.then(() => correct(reason)).catch((error) => {
          logLine(ctx, 'warn', `váratlan javítás-hiba: ${String(error)}`);
        });
        return chain;
      }

      // 1) Induláskori helyreállítás: a settings.yaml driftje ne maradjon meg.
      void enforce('boot');

      // 2) Minden committed változás a namespacre: a beszélgetésbeli modellváltás
      //    `saveSelection`-je ide fut be, ezért itt áll vissza az alapértelmezés.
      try {
        sctx.on('settings/updated', (ns) => {
          if (ns !== NAMESPACE) return;
          void enforce('settings-updated');
        });
      } catch (error) {
        logLine(ctx, 'warn', `a settings/updated figyelő nem regisztrálható: ${String(error)}`);
      }
    });
  } catch (error) {
    logLine(ctx, 'warn', `a settings-szolgáltatás nem érhető el: ${String(error)}`);
  }
}

export { apply, inject, name };
