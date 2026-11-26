/**
 * dsh-browser — agent-oldali `browser` tool: headless Edge a HOST processzben.
 *
 * MIÉRT KÜLÖN PLUGIN (és miért agent-sík): a Chromium a DSH sandboxában
 * szerkezetileg nem indul el (mojo + crashpad named pipe), a fájl-sandbox
 * pedig a hálózatot nem korlátozza — a böngészőt ezért a harness saját,
 * NEM sandboxolt processzében kell futtatni, és a modell elé tool-ként kell
 * tenni. Az agent tool-listája a preset-kompozícióból jön, ezért ez a plugin
 * a presetbe kerül (mint a `dsh-terminal-tool`).
 *
 * A FELHASZNÁLÓ DÖNTÉSEI (2026-11-26):
 *  - mindhárom célterület elérhető (loopback / helyi hálózat / bármely URL),
 *    külső oldalakon is lehet kattintani és gépelni;
 *  - az eldobható profil az alap, de egyes feladatokra TARTÓS profil hozható
 *    létre (`profile: "lineageos"`), hogy ne kelljen újra bejelentkezni;
 *  - a LETÖLTÉS jóváhagyáshoz kötött (egyszeri engedély, `ctx.approval`).
 *
 * BIZTONSÁGI KERET: csak headless (`--headless=new`, AGENTS.md 1. pont: nincs
 * látható ablak, nincs fókuszlopás); a nem http(s) sémák tiltottak; minden
 * navigáció és letöltés a `state\browser.log`-ba kerül.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCdpClient, createPage } from "./cdp.js";
import { findBrowser, freePort, gracefulClose, launch, stop, waitForEndpoint } from "./edge.js";
import { listProfiles, pruneEphemeral, removeEphemeral, resolveProfile, trashProfile } from "./profiles.js";
import { SCOPES, checkScope, normalizeConfig } from "./scope.js";

/** A plugin gyökere. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A repó gyökere (a `plugins\dsh-browser` két szinttel lejjebb). */
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

/** Az állapot-könyvtár. */
const STATE_DIR = join(REPO_ROOT, "state");

/** A tartós profilok helye. */
const PROFILE_ROOT = join(STATE_DIR, "browser-profiles");

/** A letöltések helye (jóváhagyás után). */
const DOWNLOAD_ROOT = join(STATE_DIR, "browser-downloads");

/** A képernyőképek alapértelmezett helye. */
const SHOT_ROOT = join(STATE_DIR, "browser-shots");

/** A napló. */
const LOG_PATH = join(STATE_DIR, "browser.log");

/** Az opcionális konfiguráció. */
const CONFIG_PATH = join(STATE_DIR, "browser-config.json");

/** A `ctx` a tool-végrehajtáshoz (a `ctx.get("approval")` miatt). */
let pluginCtx = null;

/** Az aktuális böngésző-session (egyszerre egy). */
const session = {
  child: null,
  client: null,
  page: null,
  profile: null,
  scope: null,
  width: 1440,
  height: 900,
  idleTimer: null,
  lastUrl: null
};

/** Diagnosztika a `state\browser.log`-ba (best-effort). */
function log(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* a napló nem hathat a működésre */
  }
}

/** A konfiguráció betöltése. */
function loadConfig() {
  return normalizeConfig(() => JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}

/** Az aktuális időpont (a tesztek injektálhatják). */
const now = () => new Date();

/**
 * Az idle-időzítő újraindítása: a böngésző nem marad örökre futva.
 * @param {number} idleMs
 */
function armIdle(idleMs) {
  if (session.idleTimer !== null) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void closeBrowser("idle");
  }, idleMs);
  // Ne tartsa életben a processzt, ha a host leáll.
  if (typeof session.idleTimer?.unref === "function") session.idleTimer.unref();
}

/**
 * A böngésző lezárása (gyermekfolyamat-fával együtt).
 * @param {string} reason
 */
async function closeBrowser(reason) {
  if (session.idleTimer !== null) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  const child = session.child;
  const client = session.client;
  const profile = session.profile;
  session.child = null;
  session.client = null;
  session.page = null;
  session.profile = null;
  session.scope = null;
  if (client !== null) {
    // Előbb szabályos zárás (a profil kiírása), aztán a maradék fa levitele.
    await gracefulClose(child, client);
    try {
      await client.close();
    } catch {
      /* már zárt */
    }
  } else {
    await stop(child);
  }
  if (profile !== null && profile.ephemeral) removeEphemeral(profile.dir);
  log(`close (${reason})` + (profile === null ? "" : ` profil=${profile.mode}${profile.name === null ? "" : `:${profile.name}`}`));
}

/**
 * A böngésző elindítása (ha már fut és a profil/hatókör egyezik, újrahasználja).
 * @param {{scope: string, profileName: string|null, width: number, height: number}} request
 */
async function ensureBrowser(request) {
  const wantPersistent = request.profileName !== null;
  if (session.child !== null && session.profile !== null) {
    const sameProfile = (session.profile.name ?? "") === (request.profileName ?? "");
    const sameScope = session.scope === request.scope;
    if (sameProfile && sameScope) {
      session.width = request.width;
      session.height = request.height;
      await session.page.setViewport(request.width, request.height);
      return session;
    }
    if (sameProfile && !sameScope) {
      session.scope = request.scope;
      return session;
    }
    await closeBrowser("profil- vagy hatókör-váltás");
  }

  const exe = findBrowser();
  if (exe === null) throw new Error("nem találom a Microsoft Edge-et (vagy Chrome-ot) a szokásos helyeken");
  // A korábbi futásokból maradt temp profilok kisöprése (a lezárt fájlok miatt
  // a záráskori törlés néha csendben elbukik).
  const pruned = pruneEphemeral(PROFILE_ROOT, 3600000);
  if (pruned > 0) log(`prune: ${pruned} eldobható profil kitakarítva`);
  const profile = resolveProfile({ rootDir: PROFILE_ROOT, mode: wantPersistent ? "persistent" : "ephemeral", name: request.profileName ?? "", now });
  const port = await freePort();
  const child = launch({ exe, profileDir: profile.dir, port });
  let client = null;
  try {
    const endpoint = await waitForEndpoint(port, { timeoutMs: 30000 });
    client = createCdpClient(endpoint.wsUrl);
    await client.ready;
    const page = createPage(client);
    await page.enable();
    await page.setViewport(request.width, request.height);
    session.child = child;
    session.client = client;
    session.page = page;
    session.profile = profile;
    session.scope = request.scope;
    session.width = request.width;
    session.height = request.height;
    log(`open exe=${exe.split("\\").pop()} port=${port} profil=${profile.mode}${profile.name === null ? "" : `:${profile.name}`} scope=${request.scope}`);
    return session;
  } catch (error) {
    if (client !== null) {
      await gracefulClose(child, client);
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    } else {
      await stop(child);
    }
    if (profile.ephemeral) removeEphemeral(profile.dir);
    throw error;
  }
}

/**
 * Jóváhagyás kérése (egyszeri engedély) a `ctx.approval`-on.
 * @param {object|null} exec
 * @param {string} reason
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function requestApproval(exec, reason) {
  const approval = pluginCtx?.get?.("approval");
  if (approval === undefined || approval === null) {
    return { ok: false, error: "nincs jóváhagyási csatorna a kompozícióban (dsh-user-approval), ezért a letöltés nem engedhető" };
  }
  if (exec?.agent === undefined || exec?.agent === null) {
    return { ok: false, error: "a hívásnak nincs agentje, ezért nincs kitől jóváhagyást kérni" };
  }
  let outcome;
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: "browser",
      callId: exec.callId,
      reason,
      signal: exec.signal
    });
  } catch (error) {
    return { ok: false, error: `a jóváhagyás nem kérdezhető meg: ${String(error?.message ?? error)}` };
  }
  switch (outcome) {
    case "allowed-once":
      log(`jóváhagyás: allowed-once (${reason})`);
      return { ok: true };
    case "rejected":
      log(`jóváhagyás: rejected (${reason})`);
      return { ok: false, error: "a felhasználó elutasította a letöltést" };
    case "cancelled":
      return { ok: false, error: "a jóváhagyás megszakadt" };
    case "unavailable":
      return { ok: false, error: "nincs elérhető jóváhagyási csatorna (a kérés nem jutott el a felhasználóhoz)" };
    default:
      return { ok: false, error: `ismeretlen jóváhagyási eredmény: ${String(outcome)}` };
  }
}

/** Egy egyszerű, fájlrendszer-barát slug. */
function slug(text, max = 40) {
  return String(text).replace(/^https?:\/\//u, "").replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, max) || "oldal";
}

/** Időbélyeg a fájlnevekhez (helyi idő, másodperc). */
function stamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-").replace("T", "_").slice(0, 19);
}

/**
 * Egy kimeneti útvonal feloldása: abszolút marad, relatív a session cwd-jéhez.
 * @param {object|null} exec
 * @param {string} target
 */
function resolveOutputPath(exec, target) {
  if (isAbsolute(target)) return target;
  const cwd = exec?.agent?.session?.header?.cwd;
  return resolve(typeof cwd === "string" && cwd !== "" ? cwd : REPO_ROOT, target);
}

/** A válasz rövidítése (a modell kontextusának védelme). */
function clip(text, max = 20000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [rövidítve: ${value.length} karakterből ${max}]`;
}

/**
 * A `browser` tool végrehajtása.
 * @param {object} args
 * @param {object|null} [exec]
 * @returns {Promise<{text: string}>}
 */
export async function executeBrowser(args, exec) {
  const action = String(args?.action ?? "status").toLowerCase();
  const config = loadConfig();
  const scope = SCOPES.includes(args?.scope) ? args.scope : config.defaultScope;
  const width = Number.isFinite(Number(args?.width)) ? Math.min(Math.max(Math.floor(Number(args.width)), 320), 3840) : config.width;
  const height = Number.isFinite(Number(args?.height)) ? Math.min(Math.max(Math.floor(Number(args.height)), 240), 2160) : config.height;
  const profileName = typeof args?.profile === "string" && args.profile.trim() !== "" ? args.profile.trim().toLowerCase() : null;

  try {
    switch (action) {
      case "status":
        return {
          text: [
            `böngésző: ${session.child === null ? "nem fut" : "fut"}`,
            `profil: ${session.profile === null ? "-" : `${session.profile.mode}${session.profile.name === null ? "" : `:${session.profile.name}`}`}`,
            `hatókör: ${session.scope ?? scope} (alap: ${config.defaultScope})`,
            `nézet: ${session.width}×${session.height}`,
            `utolsó URL: ${session.lastUrl ?? "-"}`,
            `tartós profilok: ${listProfiles(PROFILE_ROOT).map((entry) => entry.name).join(", ") || "(nincs)"}`
          ].join("\n")
        };

      case "profiles": {
        const profileAction = String(args?.profile_action ?? "list").toLowerCase();
        if (profileAction === "delete") {
          const result = trashProfile(PROFILE_ROOT, profileName ?? "", now);
          if (result.ok !== true) return { text: `profil törlése: ${result.error}` };
          return { text: `profil lomtárba: ${profileName} → ${result.movedTo}` };
        }
        const entries = listProfiles(PROFILE_ROOT);
        if (entries.length === 0) return { text: `nincs tartós profil (hely: ${PROFILE_ROOT})` };
        return { text: entries.map((entry) => `${entry.name}  ${(entry.bytes / 1048576).toFixed(1)} MB  ${entry.createdAt ?? "-"}`).join("\n") };
      }

      case "close":
        await closeBrowser("kérés");
        return { text: "böngésző lezárva" };

      case "open": {
        const target = typeof args?.url === "string" ? args.url : "";
        const verdict = checkScope(scope, target, { allowHosts: config.allowHosts });
        if (verdict.allowed !== true) {
          log(`open TILTVA scope=${scope} url=${target} ok=${verdict.reason}`);
          return { text: `a cél nem engedélyezett ebben a hatókörben (${scope}): ${verdict.reason}` };
        }
        const active = await ensureBrowser({ scope, profileName, width, height });
        const info = await active.page.navigate(verdict.url ?? target, { timeoutMs: Number(args?.wait_ms ?? 20000) });
        session.lastUrl = info.url;
        armIdle(config.idleMs);
        log(`open url=${info.url} title="${info.title}" kind=${verdict.kind} ready=${info.ready}`);
        return {
          text: [
            `megnyitva: ${info.url}`,
            `cím: ${info.title || "(üres)"}`,
            `kész: ${info.ready ? "igen" : "nem (időtúllépés — lehet, hogy még tölt)"}`,
            `profil: ${active.profile.mode}${active.profile.name === null ? "" : `:${active.profile.name}`} · hatókör: ${scope} (${verdict.kind})`
          ].join("\n")
        };
      }

      case "read": {
        await ensureRunning(scope, profileName, width, height, config);
        const selector = typeof args?.selector === "string" && args.selector !== "" ? args.selector : null;
        const format = String(args?.format ?? "text").toLowerCase();
        armIdle(config.idleMs);
        if (selector === null) {
          const body = await session.page.evaluate("document.body === null ? '' : document.body.innerText");
          return { text: clip(`cím: ${await session.page.evaluate("document.title")}\nURL: ${session.lastUrl ?? ""}\n\n${String(body ?? "")}`) };
        }
        const value = await session.page.readElement(selector, format === "html" ? "html" : format === "value" ? "value" : format === "attrs" ? "attrs" : "text");
        if (value === null) return { text: `nincs ilyen elem: ${selector}` };
        return { text: clip(typeof value === "string" ? value : JSON.stringify(value, null, 2)) };
      }

      case "click": {
        const selector = String(args?.selector ?? "");
        if (selector === "") return { text: "a click-hez kell egy CSS selector" };
        await ensureRunning(scope, profileName, width, height, config);
        const result = await session.page.click(selector);
        armIdle(config.idleMs);
        await session.page.waitReady(Number(args?.wait_ms ?? 8000));
        log(`click ${selector} (${result.method}) url=${session.lastUrl}`);
        const after = await session.page.evaluate("({ url: location.href, title: document.title })");
        return { text: `kattintva: ${result.clicked} (${result.method === "mouse" ? "valódi egér" : "programozott"})\nURL: ${String(after?.url ?? "")}\ncím: ${String(after?.title ?? "")}` };
      }

      case "type": {
        const selector = String(args?.selector ?? "");
        const text = String(args?.text ?? "");
        if (selector === "") return { text: "a type-hoz kell egy CSS selector" };
        await ensureRunning(scope, profileName, width, height, config);
        const result = await session.page.typeText(selector, text, { enter: args?.enter === true });
        armIdle(config.idleMs);
        await session.page.waitReady(Number(args?.wait_ms ?? 5000));
        log(`type ${selector} (${text.length} karakter, enter=${args?.enter === true})`);
        return { text: `beírva: ${result.typed.length} karakter ide: ${selector}${args?.enter === true ? " (+ Enter)" : ""}` };
      }

      case "eval": {
        const expression = String(args?.expression ?? "");
        if (expression === "") return { text: "az eval-hoz kell egy JS kifejezés" };
        await ensureRunning(scope, profileName, width, height, config);
        armIdle(config.idleMs);
        const value = await session.page.evaluate(expression);
        const after = await session.page.evaluate("location.href");
        session.lastUrl = String(after ?? session.lastUrl ?? "");
        log(`eval (${expression.length} karakter) url=${session.lastUrl}`);
        return { text: clip(`eredmény: ${JSON.stringify(value, null, 2)}\nURL: ${session.lastUrl}`) };
      }

      case "shot": {
        await ensureRunning(scope, profileName, width, height, config);
        const selector = typeof args?.selector === "string" && args.selector !== "" ? args.selector : undefined;
        const fullPage = args?.full_page === true;
        const shot = await session.page.screenshot({ fullPage, selector });
        const target = typeof args?.path === "string" && args.path !== ""
          ? resolveOutputPath(exec, args.path)
          : join(SHOT_ROOT, `${stamp()}-${slug(session.lastUrl ?? "oldal")}.png`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(shot.base64, "base64"));
        armIdle(config.idleMs);
        const bytes = statSync(target).size;
        log(`shot ${target} (${bytes} B)`);
        return { text: `képernyőkép: ${target}\n${shot.width}×${shot.height}px · ${bytes} bájt\n(A kép megnyitásához használd a read_image toolt ezzel az útvonallal.)` };
      }

      case "console": {
        await ensureRunning(scope, profileName, width, height, config);
        const lines = session.page.consoleLines(40);
        armIdle(config.idleMs);
        if (lines.length === 0) return { text: "nincs konzol-üzenet (vagy már kiürült a puffer)" };
        return { text: clip(lines.join("\n")) };
      }

      case "download": {
        const url = String(args?.url ?? "");
        if (url === "") return { text: "a download-hoz kell egy url (vagy egy selector a click-hez)" };
        const verdict = checkScope(scope, url, { allowHosts: config.allowHosts });
        if (verdict.allowed !== true) {
          return { text: `a letöltés célja nem engedélyezett ebben a hatókörben (${scope}): ${verdict.reason}` };
        }
        const approved = await requestApproval(exec, `böngésző-letöltés: ${verdict.url ?? url}`);
        if (approved.ok !== true) {
          return { text: `letöltés NEM indult: ${approved.error}\n(Kérd meg a felhasználót, és utána futtasd újra ugyanezt a hívást.)` };
        }
        const dir = join(DOWNLOAD_ROOT, `${stamp()}-${slug(args?.filename ?? url)}`);
        mkdirSync(dir, { recursive: true });
        const active = await ensureBrowser({ scope, profileName, width, height });
        try {
          await active.client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
        } catch {
          try {
            await active.client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
          } catch (error) {
            log(`download: a letöltési viselkedés nem állítható: ${String(error?.message ?? error)}`);
          }
        }
        const completed = new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), Number(args?.wait_ms ?? 120000));
          if (typeof active.client.once === "function") {
            active.client.once("Browser.downloadProgress", 120000).then((params) => {
              if (params?.state === "completed") {
                clearTimeout(timer);
                resolve(params);
              }
            }).catch(() => undefined);
          }
          timer.unref?.();
        });
        await active.page.navigate(verdict.url ?? url, { timeoutMs: 20000 }).catch(() => undefined);
        await completed;
        const files = await waitForFiles(dir, 30000);
        armIdle(config.idleMs);
        if (files.length === 0) {
          log(`download: nincs fájl (${dir})`);
          return { text: `a letöltés nem hozott fájlt (${dir}) — lehet, hogy a cél nem letöltés, vagy a böngésző máshova mentette` };
        }
        log(`download ${dir} (${files.map((f) => f.name).join(", ")})`);
        return { text: `letöltve: ${dir}\n${files.map((file) => `${file.name}  ${file.bytes} bájt`).join("\n")}` };
      }

      default:
        return { text: `ismeretlen action: ${action} (open | read | click | type | eval | shot | download | console | profiles | close | status)` };
    }
  } catch (error) {
    log(`hiba action=${action}: ${String(error?.message ?? error)}`);
    return { text: `browser ${action} hiba: ${String(error?.message ?? error)}` };
  }
}

/**
 * Biztosítja, hogy fusson a böngésző, és újraindítja az idle-időzítőt.
 * @param {string} scope
 * @param {string|null} profileName
 * @param {number} width
 * @param {number} height
 * @param {ReturnType<typeof loadConfig>} config
 */
async function ensureRunning(scope, profileName, width, height, config) {
  await ensureBrowser({ scope, profileName, width, height });
  armIdle(config.idleMs);
}

/**
 * Fájlok bevárása egy letöltési mappában (.crdownload nélkül).
 *
 * ASZINKRON: a host event loopját TILOS blokkolni (a `Atomics.wait` befagyasztaná
 * a teljes Harness-t) — ezért `setTimeout`-os lépésekben vár.
 * @param {string} dir
 * @param {number} timeoutMs
 * @returns {Promise<Array<{name: string, bytes: number}>>}
 */
async function waitForFiles(dir, timeoutMs) {
  const collect = () => {
    /** @type {Array<{name: string, bytes: number}>} */
    const files = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".crdownload")) continue;
      try {
        files.push({ name: entry.name, bytes: statSync(join(dir, entry.name)).size });
      } catch {
        /* zárolt fájl */
      }
    }
    return files;
  };
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 120000);
  let files = collect();
  while (files.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    files = collect();
  }
  return files;
}

/**
 * A plugin belépési pontja.
 * @param {object} ctx
 */
async function apply(ctx) {
  pluginCtx = ctx;
  try {
    if (ctx?.tools === undefined) {
      log("apply: nincs tools szolgáltatás — a tool nem regisztrálható");
      return;
    }
    const defineTool = await loadDefineTool();
    const output = {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } }
      },
      render: (_args, data) => [{ type: "text", text: String(data?.text ?? "") }]
    };

    /** @type {Record<string, object>} */
    const parameters = {
      action: { type: "string", required: true, description: "open | read | click | type | eval | shot | download | console | profiles | close | status" },
      url: { type: "string", description: "open/download: the target http(s) URL." },
      selector: { type: "string", description: "CSS selector for read/click/type/shot." },
      text: { type: "string", description: "type: the text to enter." },
      expression: { type: "string", description: "eval: a JavaScript expression evaluated in the page (returns JSON)." },
      path: { type: "string", description: "shot: output PNG path (absolute, or relative to the session workspace)." },
      profile: { type: "string", description: "Persistent profile name (e.g. \"lineageos\"). Omit for a disposable profile." },
      profile_action: { type: "string", description: "profiles: list | delete." },
      scope: { type: "string", enum: [...SCOPES], description: "Target scope: loopback | lan | any. Defaults to the configured default (any)." },
      format: { type: "string", description: "read: text | html | value | attrs." },
      full_page: { type: "boolean", description: "shot: capture the full page instead of the viewport." },
      enter: { type: "boolean", description: "type: press Enter after entering the text." },
      filename: { type: "string", description: "download: a hint for the download folder name." },
      width: { type: "number", description: "Viewport width (default 1440)." },
      height: { type: "number", description: "Viewport height (default 900)." },
      wait_ms: { type: "number", description: "Timeout for the action in milliseconds (default per action)." }
    };

    const description = "Drive a real headless browser from the harness host process (Chromium in the DSH sandbox cannot start, so this tool is the supported way to use a browser). "
      + "It runs headless only — it never opens a visible window. "
      + "Actions: open (navigate), read (page text or one element), click, type, eval (JS in the page), shot (PNG into the workspace, then use read_image to look at it), "
      + "download (requires a one-shot user approval), console (browser console lines), profiles (list/delete persistent profiles), close, status. "
      + "Profiles: omit `profile` for a disposable profile; pass a name to reuse a persistent profile that keeps cookies and logins between calls and sessions. "
      + "Scope: loopback (127.0.0.1/localhost), lan (local network), any (the public internet, the default) — all three are available, and clicking/typing works on external sites too. "
      + "Only http/https targets are accepted. Downloading is deliberately gated: call it, and if it reports that no approval is available, ask the user and retry.";

    const definition = defineTool !== null
      ? defineTool({ name: "browser", description, parameters, output, execute: executeBrowser })
      : { name: "browser", description, parameters: toJsonSchema(parameters), output, execute: executeBrowser };

    ctx.tools.register(definition);
    log(`apply: a browser tool beregisztrálva (defineTool=${defineTool !== null}, approval=${pluginCtx?.get?.("approval") !== undefined})`);
  } catch (error) {
    log(`apply: hiba ${String(error?.message ?? error)}`);
    try {
      ctx?.logger?.warn?.(`[dsh-browser] ${String(error)}`);
    } catch {
      /* a log nem kritikus */
    }
  }
  // A böngésző akkor se maradjon futva, ha a host leáll.
  try {
    ctx?.on?.("dispose", () => {
      void closeBrowser("host-dispose");
    });
  } catch {
    /* nem kritikus */
  }
}

/**
 * A paraméter-DSL átalakítása JSON-Schema alakra (a `defineTool` nélküli tartalék).
 * @param {Record<string, object>} parameters
 */
function toJsonSchema(parameters) {
  const properties = {};
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = { ...spec };
    delete properties[key].required;
  }
  return { type: "object", additionalProperties: false, properties };
}

/**
 * A `defineTool` feloldása a harness csomagjaiból (a junction miatt több jelölt).
 * @returns {Promise<((definition: object) => object) | null>}
 */
async function loadDefineTool() {
  const bases = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) bases.push(value);
  };
  push(fileURLToPath(import.meta.url));
  push(join(process.cwd(), "noop.mjs"));
  push(process.argv[1] ?? "");
  const dshHome = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
  push(join(dshHome, "profiles", "noop.mjs"));
  push(join(dshHome, "noop.mjs"));
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve("@deepseek-ai/dsh-tools");
      const module = await import(pathToFileURL(resolved).href);
      if (typeof module.defineTool === "function") return module.defineTool;
    } catch {
      /* következő jelölt */
    }
  }
  return null;
}

/** A tool a `tools` szolgáltatásra épül. */
const inject = ["tools"];

export { apply, inject };
