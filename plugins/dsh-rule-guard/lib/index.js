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

/** A plugin neve a boot gráfban. */
const name = 'dsh-rule-guard';

/** Nincs kötelező szolgáltatás: a `tools/pre-execute` esemény mindig él. */
const inject = [];

/** A szabályfájl a plugin mellett (verziózott, a repóban). */
const POLICY_FILE = fileURLToPath(new URL('../policy.json', import.meta.url));

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
 * Plugin belépési pont.
 * @param {object} ctx
 * @param {{policyPath?: string, logPath?: string}} [config]
 */
function apply(ctx, config = {}) {
  const policyFile = config.policyPath ?? POLICY_FILE;
  const logFile = config.logPath ?? defaultLogPath();
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
        if (policy === undefined) return;
        const cwd = agent?.session?.header?.cwd;
        const match = workspaceForCwd(policy, cwd);
        const lines = match?.workspace?.sessionRules;
        if (!Array.isArray(lines) || lines.length === 0) return;
        const text = lines.join('\n\n');
        if (typeof agent?.inject === 'function') agent.inject(pluginMessage(text));
      } catch (error) {
        logLine(ctx, 'warn', `session-szabály injektálás hiba: ${String(error)}`);
      }
    });
  } catch (error) {
    logLine(ctx, 'warn', `a session-start figyelő nem regisztrálható: ${String(error)}`);
  }
}

export { apply, inject, name };
