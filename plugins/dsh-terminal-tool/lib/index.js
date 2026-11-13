/**
 * dsh-terminal-tool — agent-oldali `terminal` tool a DSH beépített
 * terminál-paneljéhez.
 *
 * MIÉRT KÜLÖN PLUGIN: az ágens tool-listája nem a host-kompozícióból jön, hanem
 * az **agent-plane presetből** (`~/.dsh/.agent-presets/<preset>/agent.cordis.yml`).
 * A `dsh-ui-extras` a host-síkon töltődik, ezért az ott regisztrált tool nem
 * kerül a modell eszközei közé (mért eset, 2026-11-13). Ezt a pluginot a preset
 * kompozíciójába kell felvenni.
 *
 * MIÉRT FÁJL-POSTAFIÓK: a panel `RUNS` állapota a HOST-síkon él, ez a tool az
 * AGENT-síkon fut; a két sík között nincs közös szolgáltatás (a preset `isolate`
 * realmjei miatt), a HTTP pedig tokent kérne. A `state\terminal-request.json` /
 * `state\terminal-response.json` pár determinisztikus és síkfüggetlen.
 *
 * TELEPÍTÉS: `plugins\dsh-terminal-tool\install.ps1` (junction + preset-bejegyzés
 * + újraindítás).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A plugin gyökere (a repó `plugins\dsh-terminal-tool` mappája). */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A repó `state\` mappája — ugyanaz, amit a host-oldali panel használ. */
const STATE_DIR = join(PACKAGE_ROOT, "..", "..", "state");
const REQUEST_PATH = join(STATE_DIR, "terminal-request.json");
const RESPONSE_PATH = join(STATE_DIR, "terminal-response.json");

/** A tool a `tools` szolgáltatásra épül. */
const inject = ["tools"];

/** @param {string} line */
function diag(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, "terminal-tool.log"), `${new Date().toISOString()} ${line}\n`, { encoding: "utf8", flag: "a" });
  } catch {
    /* a diagnosztika nem hathat a bootra */
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A leírás: egy helyen, mert a modell ezt látja. */
const DESCRIPTION = "Use the DSH built-in terminal panel (the one the user sees). "
  + "action=run: start or reuse a terminal in the workspace, type the command, wait, and return its output. "
  + "action=insert: type the command into the panel WITHOUT pressing Enter, so the user can start it themselves — "
  + "use this whenever you want to run something together with the user. "
  + "action=input: send a line to the running shell. action=output: read recent output. "
  + "action=stop: stop the run and its process tree. action=list: list live runs.";

/**
 * A `defineTool` feloldása.
 *
 * MIÉRT KELL TÖBB JELÖLT: a plugin a `~\.dsh\profiles\node_modules\dsh-terminal-tool`
 * junctionon át töltődik, a Node viszont a junction VALÓDI útjáról (a repó
 * `plugins\...` mappájából) oldja fel a további importokat, ott pedig nincs
 * `node_modules` — mért eset 2026-11-13, a `D:\Szerver\Deepseek Harness\node_modules`
 * nem létezik. Ezért a harness belépési pontja és a profilok `node_modules`-a is
 * jelölt.
 *
 * @returns {Promise<{defineTool: ((definition: object) => object) | null, from: string | null}>}
 */
async function loadDefineTool() {
  /** @type {string[]} */
  const bases = [];
  /** @param {string} value */
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) bases.push(value);
  };
  push(fileURLToPath(import.meta.url));
  push(join(process.cwd(), "noop.mjs"));
  push(process.argv[1] ?? "");
  const dshHome = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  push(join(dshHome, "profiles", "noop.mjs"));
  push(join(dshHome, "noop.mjs"));

  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve("@deepseek-ai/dsh-tools");
      const module = await import(pathToFileURL(resolved).href);
      if (typeof module.defineTool === "function") return { defineTool: module.defineTool, from: resolved };
    } catch {
      /* következő jelölt */
    }
  }
  return { defineTool: null, from: null };
}

/**
 * Egy kérés kiküldése a postafiókon és a válasz bevárása.
 * @param {object} request
 * @param {number} timeoutMs
 * @returns {Promise<object>} a host válasza
 */
async function sendRequest(request, timeoutMs) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REQUEST_PATH, JSON.stringify(request), "utf8");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(120);
    let response;
    try {
      response = JSON.parse(readFileSync(RESPONSE_PATH, "utf8"));
    } catch {
      continue; // még nincs válasz
    }
    if (response?.id === request.id) return response;
  }
  return { id: request.id, ok: false, error: "a terminál-panel nem válaszolt (a postafiókot a dsh-ui-extras figyeli)" };
}

/**
 * A `terminal` tool végrehajtása.
 * @param {object} args
 * @returns {Promise<{text: string}>}
 */
async function executeTerminal(args) {
  const action = String(args?.action ?? "output").toLowerCase();
  const command = typeof args?.command === "string" ? args.command : "";
  const workspace = typeof args?.workspace === "string" ? args.workspace : "";
  const waitMs = Math.min(Math.max(Number(args?.wait_ms ?? 3000), 200), 30000);

  const request = {
    id: randomUUID(),
    action,
    command,
    workspace,
    waitMs
  };
  diag(`kérés: ${action} id=${request.id}`);
  // Várakozás: az insert/output/stop azonnal válaszol, a run a kért ideig fut.
  const timeout = action === "run" ? waitMs + 8000 : 6000;
  const response = await sendRequest(request, timeout);
  // A kérésfájl TÖRLÉSE a válasz után. A host `handledMailboxIds` halmaza
  // memóriabeli, ezért a lemezen maradt kérés a harness következő bootjánál
  // újra végrehajtódna (mért eset 2026-11-13: egy `insert` a boot után még
  // egyszer beíródott). `run` esetén ez minden bootnál lefuttatna egy parancsot.
  try {
    rmSync(REQUEST_PATH, { force: true });
  } catch {
    /* a takarítás nem kritikus; a host oldal 30 s után amúgy is eldobja */
  }

  if (response?.ok !== true) {
    return { text: `terminal ${action}: ${response?.error ?? "ismeretlen hiba"}` };
  }
  if (action === "list") {
    const runs = Array.isArray(response.runs) ? response.runs : [];
    const lines = runs.map((run) => `${run.id}  ${run.workspace}  ${run.done ? `kész (${run.code})` : "fut"}  ${run.label}`);
    return { text: lines.length > 0 ? lines.join("\n") : "nincs terminál-futás" };
  }
  const header = [
    response.runId === undefined ? null : `run: ${response.runId}`,
    response.workspace === undefined ? null : `workspace: ${response.workspace}`,
    command.length > 0 ? `> ${command}` : null
  ].filter((line) => line !== null).join("\n");
  return { text: `${header}\n\n${response.output ?? ""}`.trim() };
}

/**
 * A `terminal` tool regisztrálása.
 * @param {object} ctx
 */
async function apply(ctx) {
  try {
    if (ctx?.tools === undefined) {
      diag("apply: nincs tools szolgáltatás — a tool nem regisztrálható");
      return;
    }
    const loaded = await loadDefineTool();

    // A defineTool MEGKÖVETELI az output-deklarációt, és az `output.schema`
    // egy SZIGORÚ value-DSL: sem a `required: true`, sem a tömbös `required`
    // nem támogatott benne (mért hiba 2026-11-13, mindkét formára). Ezért itt
    // csak a tulajdonságok típusát adjuk meg. Az `execute` adatot ad vissza,
    // a szöveget a `render` állítja elő.
    const output = {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" }
        }
      },
      render: (_args, data) => [{ type: "text", text: String(data?.text ?? "") }]
    };

    /** @type {object} */
    let definition;
    if (loaded.defineTool !== null) {
      definition = loaded.defineTool({
        name: "terminal",
        description: DESCRIPTION,
        parameters: {
          action: { type: "string", required: true, description: "run | insert | input | output | stop | list" },
          command: { type: "string", description: "Command (or text) to send. Omit for output/stop/list." },
          workspace: { type: "string", description: "Workspace root; defaults to the panel's last workspace." },
          wait_ms: { type: "number", description: "action=run: how long to wait for output (200..30000 ms, default 3000)." }
        },
        output,
        execute: executeTerminal
      });
      diag(`apply: defineTool feloldva (${loaded.from})`);
    } else {
      // Tartalék: a tool regisztrálható közvetlenül is (a `register` csak az
      // `output.schema`-t ellenőrzi), de a paramétereket itt már JSON-Schema
      // alakban kell megadni. A `required` tömböt a harness séma-részhalmaza
      // nem támogatja, ezért a kötelező `action` a leírásban szerepel.
      definition = {
        name: "terminal",
        description: DESCRIPTION,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", description: "run | insert | input | output | stop | list (kötelező)" },
            command: { type: "string", description: "Command (or text) to send. Omit for output/stop/list." },
            workspace: { type: "string", description: "Workspace root; defaults to the panel's last workspace." },
            wait_ms: { type: "number", description: "action=run: how long to wait for output (200..30000 ms, default 3000)." }
          }
        },
        output,
        execute: executeTerminal
      };
      diag("apply: FIGYELEM defineTool nem oldható fel — nyers definíció (JSON-Schema paraméterek)");
    }

    ctx.tools.register(definition);
    diag("apply: a terminal tool beregisztrálva");
  } catch (error) {
    diag(`apply: hiba ${String(error?.message ?? error)}`);
    try {
      ctx?.logger?.warn?.(`[terminal-tool] ${String(error)}`);
    } catch {
      /* a log nem kritikus */
    }
  }
}

export { apply, inject };
