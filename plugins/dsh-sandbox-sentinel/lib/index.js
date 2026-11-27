/**
 * dsh-sandbox-sentinel — a sandbox NÉMA hibaosztályainak jelzőtáblája.
 *
 * MIÉRT: a 240Hz-vizsgálat (2026-11-27, Vector `765b76d2`) MEGMUTATTA a rést:
 * az ágens `& nvidia-smi … | Out-String` alakban hívott, a sandbox a névtelen
 * cső miatt elutasította, az ágens pedig ezt „blokkolt külső program"-ként
 * diagnosztizálta, majd VÁLASZ NÉLKÜL lezárta a kört. Ugyanaz a parancs
 * `cmd /c "… > fájl"` alakban azonnal működött.
 *
 * MIT TESZ:
 *   1) `tools/post-execute`: ha a tool-kimenet a hét mért hibaosztály valamelyike,
 *      a kimenet VÉGÉRE fűz egy konkrét, másolható teendőt (magyarul) — így a
 *      modell a következő lépésben már a helyes alakot látja.
 *   2) `agent/session-start`: rövid súgót injektál (tömörítés után is meglegyen).
 *   3) Minden találatot naplóz (`~\.dsh\sandbox-sentinel.log`) — ez adja a
 *      mérést arról, mennyit ér a javítás.
 *
 * BIZTONSÁG: a plugin SOHA nem rontja el a hívást: minden ág try/catch-ben fut,
 * hiba esetén egyszerűen továbbenged (`next()`), és a bootot nem állítja meg.
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PLAYBOOK, classify, noteFor } from "./classify.js";

/** A plugin neve a boot gráfban. */
const name = "dsh-sandbox-sentinel";

/** Nincs kötelező szolgáltatás: a `tools/post-execute` és az `agent/session-start` esemény mindig él. */
const inject = [];

/** Napló felső korlát: ennyi után a fájl újraindul (ne hízzon). */
const LOG_MAX_BYTES = 1024 * 1024;

/**
 * Azok a toolok, amelyeknél a sandbox-osztályozás értelmes (héj + terminál).
 * Ismeretlen toolnál is osztályozunk, hogy új héj-tool esetén se legyen néma.
 */
const SHELL_TOOLS = new Set(["pwsh", "powershell", "powershell7", "bash", "sh", "shell", "terminal", "cmd"]);

/**
 * A hibaosztályok, amelyeknél a hívás **biztosan bukott**, ezért a DSH-nak is
 * hibaként kell látnia (`kind:'block'` → `isError: true`).
 *
 * MIÉRT: a `pwsh` tool a sandbox-os elutasítást `isError: false`-szal adta vissza
 * (csak `[exit code: 1]` volt a szövegben) — a modell így „sikeres" lépésként
 * látta, és nem javította a formát. Mért eset: 2026-11-27, Vector `765b76d2`.
 *
 * A `sandbox-write` és az `access-denied-hu` SZÁNDÉKOSAN nincs itt: azokat a
 * harness már hibaként jelöli, illetve a magyar üzenet lehet ártalmatlan is —
 * ott csak jegyzetet fűzünk, nem minősítünk át.
 */
const ALWAYS_FATAL = new Set(["pipe-capture", "msys-sh", "node-spawn", "schannel-tls", "chromium-sandbox"]);

/** A napló alapértelmezett helye: a DSH home (a harness processze írhatja). */
function defaultLogPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "sandbox-sentinel.log");
}

/** Biztonságos logger: a plugin soha ne essen el a logon. */
function logLine(ctx, level, message) {
  try {
    ctx?.logger?.[level]?.(`[${name}] ${message}`);
  } catch {
    /* a log nem kritikus */
  }
}

/** Egy találat naplózása (bizonyíték + mérés). */
function appendLog(file, entry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_MAX_BYTES) truncateSync(file, 0);
    } catch {
      /* még nincs fájl */
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* a napló nem hathat a működésre */
  }
}

/**
 * A tool-kimenet szövege (a szöveges részek összefűzése).
 * @param {{content?: Array<{type?: string, text?: string}>}} result
 * @returns {string}
 */
function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((part) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** Egy plugin-üzenet (a `createUserMessage` alakja, harness-import nélkül). */
function pluginMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name }
  };
}

/**
 * Plugin belépési pont.
 * @param {object} ctx
 * @param {{logPath?: string, playbook?: boolean}} [config]
 */
function apply(ctx, config = {}) {
  const logFile = typeof config.logPath === "string" && config.logPath !== "" ? config.logPath : defaultLogPath();

  // --- 1) A tool-kimenet fordítása -----------------------------------------
  try {
    ctx.on("tools/post-execute", async (exec, result, next) => {
      try {
        const toolName = exec?.name;
        if (toolName !== undefined && !SHELL_TOOLS.has(String(toolName))) return next();
        const text = textOf(result);
        if (text.includes("[sandbox-sentinel]")) return next(); // már megkapta
        const hit = classify(text);
        if (hit === undefined) return next();
        const content = Array.isArray(result?.content) ? result.content : [];
        const withNote = [...content, { type: "text", text: noteFor(hit) }];
        appendLog(logFile, {
          at: new Date().toISOString(),
          kind: hit.escalate === false && ALWAYS_FATAL.has(hit.id) ? "block" : "hit",
          class: hit.id,
          tool: toolName,
          callId: exec?.callId,
          cwd: exec?.agent?.session?.header?.cwd
        });
        // A biztos bukásokat HIBAKÉNT adjuk vissza (a DSH eddig sikeresként adta
        // tovább őket) — a szöveg változatlan, csak a jegyzet kerül a végére.
        if (ALWAYS_FATAL.has(hit.id) && result?.isError !== true) {
          return { kind: "block", feedback: withNote };
        }
        return { kind: "accept", content: withNote };
      } catch (error) {
        logLine(ctx, "warn", `post-execute osztályozás hiba: ${String(error)}`);
        return next();
      }
    });
  } catch (error) {
    logLine(ctx, "warn", `a tools/post-execute figyelő nem regisztrálható: ${String(error)}`);
  }

  // --- 2) Session-indító súgó ----------------------------------------------
  if (config.playbook !== false) {
    try {
      ctx.on("agent/session-start", ({ agent } = {}) => {
        try {
          if (typeof agent?.inject === "function") agent.inject(pluginMessage(PLAYBOOK));
        } catch (error) {
          logLine(ctx, "warn", `súgó-injektálás hiba: ${String(error)}`);
        }
      });
    } catch (error) {
      logLine(ctx, "warn", `a session-start figyelő nem regisztrálható: ${String(error)}`);
    }
  }

  logLine(ctx, "info", `aktív (napló: ${logFile})`);
}

export { apply, inject, name };
