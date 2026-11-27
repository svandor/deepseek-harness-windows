/**
 * dsh-rule-guard — plugin belépési pont.
 *
 * MIÉRT: a projekt-szabályok eddig csak AGENTS.md szövegként éltek, ezért az
 * ágensek rendszeresen megsértették őket. Mért esetek:
 *   - 2026-11-20, Video: a `zene-fa-epites.py --sync` `os.unlink`-kal 7 291
 *     borítóképet törölt véglegesen, a 60 napos lomtár-szabály ellenére;
 *   - 2026-11-20, L12: új cron a `routes/console.php`-ba került, az admin
 *     „Szinkron státusz” lista (config/app_schedules.php) kihagyásával.
 *
 * MIT TESZ: a `tools/pre-execute` vízesésben a tool-hívás ELŐTT dönt, és
 * indoklással blokkol (`{kind:'deny', reason}`). A szabályok a `policy.json`-ban
 * élnek, hot-reloaddal (mtime). Session-indításkor a projekt kemény szabályait
 * rövid üzenetként befecskendezi, hogy tömörítés után is meglegyenek.
 *
 * BIZTONSÁG: a plugin SOHA nem állíthatja meg a bootot és nem törheti el a
 * tool-hívást: minden hívás try/catch-ben fut, szabályhiba/hiba esetén ENGED.
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callCwd, createPolicyLoader, evaluatePre, workspaceForCwd } from './policy.js';
import { createRegistry, describeActive, releaseAll, requestLease, resourceFor } from './lease.js';

/** A plugin neve a boot gráfban. */
const name = 'dsh-rule-guard';

/** Nincs kötelező szolgáltatás: a `tools/pre-execute` esemény mindig él. */
const inject = [];

/** A szabályfájl a plugin mellett (verziózott, a repóban). */
const POLICY_FILE = fileURLToPath(new URL('../policy.json', import.meta.url));

/**
 * GÉP-SZINTŰ ERŐFORRÁS-ZÁRAK. A DSH egyetlen host-processzben futtat minden
 * munkamenetet, ezért ez a nyilvántartó természeténél fogva KÖZÖS: két session
 * ugyanazt a Map-et látja. Ez pótolja a hiányzó cross-session koordinációt
 * (lásd `lib/lease.js` fejlécében a 2026-11-27-i mért esetet).
 */
const LEASES = createRegistry();

/** Napló felső korlát: ennyi után a fájl újraindul (ne hízzon). */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** A napló alapértelmezett helye: a DSH home (a harness processze írhatja). */
function defaultLogPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'rule-guard.log');
}

/** Biztonságos logger: a plugin soha nem eshet el a logon. */
function logLine(ctx, level, message) {
  try {
    ctx?.logger?.[level]?.(`[${name}] ${message}`);
  } catch {
    /* a log nem kritikus */
  }
}

/** Döntés naplózása fájlba (bizonyíték: miért blokkolt a hívás). */
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

/** Egy plugin-üzenet (a `createUserMessage` alakja, harness-import nélkül). */
function pluginMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name }
  };
}

/**
 * A tool-hívás szöveges tartalma (erre illeszkednek a lease-minták).
 * @param {object} exec
 * @returns {string}
 */
function commandText(exec) {
  const args = exec?.arguments ?? {};
  return [args.command, args.content, args.file_path, args.url, args.pattern, args.text]
    .filter((value) => typeof value === 'string' && value !== '')
    .join('\n');
}

/**
 * GÉP-ÁLLAPOT-ZÁR kapuja (a `tools/pre-execute` vízesésben, a szabályok ELŐTT).
 *
 * Ha a parancs a policy `leases.resources` listája szerint gép-állapotot módosít:
 *   - szabad (vagy a sajátunk) → lease-t adunk, ENGEDÜNK;
 *   - MÁS élő ágens birtokolja → INDOKLÁSSAL blokkolunk.
 * Hiba esetén ENGEDÜNK (a zár hibája ne akassza meg a munkát).
 * @param {object} policy
 * @param {object} exec
 * @param {string} logFile
 * @param {object} ctx
 * @returns {{kind: 'deny', reason: string}|undefined}
 */
function leaseGate(policy, exec, logFile, ctx, leases) {
  const config = policy?.leases;
  if (config === undefined || config === null || config.enabled === false) return undefined;
  const resource = resourceFor(Array.isArray(config.resources) ? config.resources : [], commandText(exec));
  if (resource === undefined) return undefined;
  const outcome = requestLease(leases, resource, exec, { ttlMinutes: config.ttlMinutes });
  if (!outcome.granted) {
    appendLog(logFile, {
      at: new Date().toISOString(),
      kind: 'lease-deny',
      resource: resource.id,
      holder: outcome.holder.label,
      tool: exec?.name,
      cwd: callCwd(exec)
    });
    logLine(ctx, 'info', `zár-ütközés: ${resource.id} (birtokos: ${outcome.holder.label}) — ${exec?.name}`);
    return { kind: 'deny', reason: outcome.reason };
  }
  appendLog(logFile, {
    at: new Date().toISOString(),
    kind: 'lease-acquire',
    resource: resource.id,
    holder: outcome.holder.label,
    tool: exec?.name,
    command: outcome.holder.command.slice(0, 200),
    cwd: callCwd(exec)
  });
  return undefined;
}

/**
 * Plugin belépési pont.
 * @param {object} ctx
 * @param {{policyPath?: string, logPath?: string}} [config]
 */
function apply(ctx, config = {}) {
  const policyFile = config.policyPath ?? POLICY_FILE;
  const logFile = config.logPath ?? defaultLogPath();
  const leases = config.leaseRegistry ?? LEASES;
  const loadPolicy = createPolicyLoader(policyFile);

  try {
    const current = loadPolicy();
    const workspaceCount = current?.workspaces?.length ?? 0;
    const ruleCount = current === undefined ? 0 : Object.keys(current.rules ?? {}).length;
    logLine(ctx, 'info', `aktív (${workspaceCount} workspace, ${ruleCount} szabály, policy: ${policyFile})`);
    appendLog(logFile, {
      at: new Date().toISOString(),
      kind: 'boot',
      policy: policyFile,
      workspaces: workspaceCount,
      rules: ruleCount
    });
  } catch (error) {
    logLine(ctx, 'warn', `induláskori ellenőrzés hiba: ${String(error)}`);
  }

  // --- 1) Tool-hívás ELŐTTI kapu -------------------------------------------
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const policy = loadPolicy();
        if (policy !== undefined) {
          // --- 1a) GÉP-ÁLLAPOT-ZÁR: nem írhatja felül két ágens ugyanazt -----
          const leaseDecision = leaseGate(policy, exec, logFile, ctx, leases);
          if (leaseDecision !== undefined) return leaseDecision;

          const decision = evaluatePre(policy, exec);
          if (decision !== undefined) {
            appendLog(logFile, {
              at: new Date().toISOString(),
              kind: 'deny',
              tool: exec?.name,
              cwd: callCwd(exec),
              rule: decision.rule,
              workspace: decision.workspace,
              reason: decision.reason
            });
            logLine(ctx, 'info', `blokk: ${decision.rule} (${decision.workspace}) — ${exec?.name}`);
            return { kind: 'deny', reason: decision.reason };
          }
        }
      } catch (error) {
        // Hiba esetén ENGEDÜNK: a guard hibája ne akassza meg a munkát.
        logLine(ctx, 'warn', `döntési hiba (engedve): ${String(error)}`);
      }
      return next();
    });
  } catch (error) {
    logLine(ctx, 'warn', `a pre-execute kapu nem regisztrálható: ${String(error)}`);
  }

  // --- 2) Session-indítás: a projekt kemény szabályai ----------------------
  try {
    ctx.on('agent/session-start', ({ agent } = {}) => {
      try {
        const policy = loadPolicy();
        const cwd = agent?.session?.header?.cwd;
        const parts = [];
        // (a) „NEM vagy egyedül": a DSH egy host-processzben futtat minden
        // sessiont, és cross-session zár nélkül a másik ágens méréseit el lehet
        // rontani. Ezt a modellnek TUDNIA kell az első lépés előtt.
        if (policy?.leases?.enabled !== false) {
          const active = describeActive(leases);
          parts.push(
            'NEM vagy egyedül a gépen: több DSH-munkamenet futhat egyszerre, közös gépi állapottal. ' +
            'Gép-állapotot módosító művelet (kijelző mód, szolgáltatás, deploy) előtt a `tools/pre-execute` kapu ' +
            'erőforrás-zárat kér; ha más ágens birtokolja, a hívás INDOKLÁSSAL blokkol. ' +
            'Olvasás (pl. `-Status`) nem ütközik. ' +
            (active.length === 0 ? 'Jelenleg nincs aktív zár.' : `Aktív zár(ak): ${active.join('; ')}.`)
          );
        }
        // (b) a projekt kemény szabályai (ha vannak)
        const match = policy === undefined ? undefined : workspaceForCwd(policy, cwd);
        const lines = match?.workspace?.sessionRules;
        if (Array.isArray(lines) && lines.length > 0) parts.push(lines.join('\n\n'));
        if (parts.length === 0) return;
        // A szabály RENDSZER-kontextusként megy a modell elé. A harness
        // `agent.inject` csak user-role üzenetet fogad, ezért a szöveget explicit
        // jelölővel látjuk el, hogy a modell NE kezelje felhasználói feladatnak
        // vagy kérdésnek. MÉRT ESET (2026-11-23, Raider): a modell a "⛔ RAIDER:
        // törlési szabály"-ra rákérdezett ("milyen törlési szabály? ez hogy jön az
        // egérhez?"), mintha a felhasználó kérte volna — pedig csak injektált
        // kontextus volt. A tényleges kényszerítés a `tools/pre-execute` kapu;
        // ez az üzenet csak tömörítés-álló emlékeztető.
        const text =
          '[Rendszerszabály — állandó projekt-kontextus, NEM felhasználói üzenet; ' +
          'nincs belőle feladat, nem kell rá válaszolni vagy rákérdezni.]\n\n' +
          parts.join('\n\n');
        if (typeof agent?.inject === 'function') agent.inject(pluginMessage(text));
      } catch (error) {
        logLine(ctx, 'warn', `session-szabály injektálás hiba: ${String(error)}`);
      }
    });
  } catch (error) {
    logLine(ctx, 'warn', `a session-start figyelő nem regisztrálható: ${String(error)}`);
  }

  // --- 3) Session lezárása: a lease-ek elengedése --------------------------
  try {
    ctx.on('agent/disposed', ({ agent } = {}) => {
      try {
        const released = releaseAll(leases, agent);
        if (released > 0) {
          appendLog(logFile, { at: new Date().toISOString(), kind: 'lease-release', count: released });
          logLine(ctx, 'info', `${released} erőforrás-zár elengedve (session lezárult)`);
        }
      } catch {
        /* a lezárás nem hibázhat */
      }
    });
  } catch (error) {
    logLine(ctx, 'warn', `az agent/disposed figyelő nem regisztrálható: ${String(error)}`);
  }
}

export { apply, inject, name };
