/**
 * HOST oldal: FTP deploy végpontok a DSH web-szerverén.
 *
 * Minden művelet a host folyamatában fut (nincs gyerekfolyamat, nincs
 * konzolablak — AGENTS §1), a titkok (FTP-jelszó) csak itt, DPAPI-val tárolva
 * élnek, a böngésző csak állapotot és számokat lát.
 *
 * Végpontok:
 *   GET  /ftp/ping            — életjel + verziók (telepítés-ellenőrzéshez)
 *   GET  /ftp/profiles        — profilok (jelszó nélkül, `hasPassword` jelzővel)
 *   POST /ftp/profile         — profil mentése (JSON test, a `deny.js` őrjeivel)
 *   DEL  /ftp/profile?id=     — profil törlése (+ a hozzá tartozó jelszó)
 *   POST /ftp/secret          — jelszó mentése (JSON: {id, password}), DPAPI
 *   DEL  /ftp/secret?id=      — jelszó törlése
 *   GET  /ftp/test?id=        — kapcsolat + PWD (csak olvas)
 *   GET  /ftp/preview?id=     — git-diff előnézet (feltöltés/törlés/kizárt)
 *   GET  /ftp/preview-extra?id= — gitignore-olt (extra) fák előnézete
 *   POST /ftp/baseline?id=    — „a mostani HEAD = már fent van”
 *   POST /ftp/push?id=&confirm=1&forceLarge=0   — deploy indítása (202)
 *   POST /ftp/push-extra?id=&confirm=1         — extra deploy indítása (202)
 *   POST /ftp/backup?id=&mode=full|code&dest=  — ZIP-mentés indítása (202)
 *   GET  /ftp/status          — a futás állapota + napló-tail
 *   GET  /ftp/remote?id=&path=/ — távoli mappák listája
 *   GET  /ftp/log?lines=40    — a napló vége
 */
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeploy } from "./engine/deploy.js";
import { deletePassword } from "./engine/secrets.js";
import { createRunner } from "./runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
/**
 * A plugin a `~\.dsh\profiles\node_modules` junctionján át töltődik; a junction
 * feloldásával kapjuk a valódi repó-útvonalat (különben a `state\` a profilok
 * alá kerülne).
 */
let PACKAGE_ROOT;
try {
  PACKAGE_ROOT = realpathSync(resolve(here, ".."));
} catch {
  PACKAGE_ROOT = resolve(here, "..");
}
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const STATE_DIR = join(REPO_ROOT, "state");
const LOG_FILE = join(STATE_DIR, "ftp-deploy.log");

/** A plugin verziója (a package.json-ből; import attribute nélkül, hogy a loader ne számítson). */
function pluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    return String(parsed.version ?? "");
  } catch {
    return "";
  }
}

const deploy = createDeploy({ repoRoot: REPO_ROOT });
const runner = createRunner({ statusFile: deploy.paths.statusFile });

function logRoute(line) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* a napló hibája nem állíthatja meg a plugint */
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function ok(res, body) {
  sendJson(res, 200, { ok: true, ...body });
}

/** Hiba: a motor kódjait (`NEED_CONFIRM`, `FTP_PUSH_FAILED`, …) is átadjuk. */
function fail(res, error) {
  const message = String(error?.message ?? error);
  const code = error?.code ?? "";
  const isClientError =
    code === "NEED_CONFIRM" ||
    code === "NEED_FORCE_LARGE" ||
    code === "FTP_BUSY" ||
    /nincs|nincs ilyen|érvénytelen|kötelező|legalább/i.test(message);
  sendJson(res, isClientError ? 400 : 500, {
    ok: false,
    error: message,
    code,
    preview: error?.preview ?? undefined,
  });
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("túl nagy kérés"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolveBody({});
      try {
        const parsed = JSON.parse(raw);
        resolveBody(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        reject(new Error("érvénytelen JSON"));
      }
    });
    req.on("error", reject);
  });
}

function logTail(lines) {
  try {
    const file = deploy.paths.logFile;
    if (!existsSync(file)) return "";
    const text = readFileSync(file, "utf8");
    const all = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    return all.slice(-Math.max(1, Math.min(400, lines ?? 40))).join("\n");
  } catch {
    return "";
  }
}

function num(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const routes = [
  // ---------------------------------------------------------------- életjel
  ["/ftp/ping", (req, res) => {
    ok(res, {
      version: pluginVersion(),
      pluginRoot: PACKAGE_ROOT,
      repoRoot: REPO_ROOT,
      stateDir: STATE_DIR,
      profiles: deploy.profiles.list().length,
      busy: runner.busy(),
      node: process.version,
    });
  }],

  // ---------------------------------------------------------------- profilok
  ["/ftp/profiles", (req, res) => {
    ok(res, { profiles: deploy.profiles.list() });
  }],

  ["/ftp/profile", async (req, res) => {
    if (req.method === "DELETE") {
      const url = new URL(req.url ?? "/", "http://dsh.invalid");
      const id = url.searchParams.get("id") ?? "";
      if (!id) return fail(res, new Error("hiányzik az id"));
      const removed = deploy.profiles.remove(id);
      return ok(res, { removed });
    }
    const body = await readJsonBody(req);
    const saved = deploy.profiles.upsert(body);
    ok(res, { profile: deploy.profiles.list().find((p) => p.id === saved.id) ?? saved });
  }],

  ["/ftp/secret", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id") ?? "";
      // A jelszó törlése a DPAPI-tárból; a válaszban jelszó nem szerepel.
      deletePassword(deploy.paths.secretPath(id));
      return ok(res, { deleted: true });
    }
    const body = await readJsonBody(req);
    const id = String(body.id ?? "");
    if (!id) return fail(res, new Error("hiányzik az id"));
    const result = await deploy.savePassword(id, body.password);
    ok(res, { saved: result.saved });
  }],

  // ---------------------------------------------------------------- olvasás
  ["/ftp/test", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    ok(res, await deploy.test(url.searchParams.get("id") ?? ""));
  }],

  ["/ftp/preview", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    ok(res, await deploy.preview(url.searchParams.get("id") ?? ""));
  }],

  ["/ftp/preview-extra", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    ok(res, await deploy.previewExtra(url.searchParams.get("id") ?? ""));
  }],

  ["/ftp/remote", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const id = url.searchParams.get("id") ?? "";
    const path = url.searchParams.get("path") || "/";
    ok(res, await deploy.listRemote(id, path));
  }],

  ["/ftp/status", (req, res) => {
    ok(res, { ...runner.snapshot(), logTail: logTail(6) });
  }],

  ["/ftp/log", (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    ok(res, { log: logTail(num(url.searchParams.get("lines"), 40)) });
  }],

  // ---------------------------------------------------------------- írás
  ["/ftp/baseline", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    ok(res, await deploy.baseline(url.searchParams.get("id") ?? ""));
  }],

  ["/ftp/push", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const id = url.searchParams.get("id") ?? "";
    const confirm = url.searchParams.get("confirm") === "1";
    const forceLarge = url.searchParams.get("forceLarge") === "1";
    // A művelet a háttérben fut; a válasz azonnal jön, az állapotot a /ftp/status adja.
    void runner
      .start("push", id, (onProgress) => deploy.push({ profileId: id, confirm, forceLarge, onProgress }))
      .catch(() => {
        /* a hiba a státuszfájlba kerül */
      });
    ok(res, { started: true, kind: "push", profileId: id });
  }],

  ["/ftp/push-extra", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const id = url.searchParams.get("id") ?? "";
    const confirm = url.searchParams.get("confirm") === "1";
    const forceLarge = url.searchParams.get("forceLarge") === "1";
    void runner
      .start("push-extra", id, (onProgress) => deploy.pushExtra({ profileId: id, confirm, forceLarge, onProgress }))
      .catch(() => {});
    ok(res, { started: true, kind: "push-extra", profileId: id });
  }],

  ["/ftp/backup", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const id = url.searchParams.get("id") ?? "";
    const mode = url.searchParams.get("mode") === "code" ? "code" : "full";
    const dest = url.searchParams.get("dest") ?? "";
    void runner
      .start("backup", id, (onProgress) => deploy.backup({ profileId: id, destDir: dest, mode, onProgress }))
      .catch(() => {});
    ok(res, { started: true, kind: "backup", profileId: id, mode });
  }],
];

export const inject = ["webServer"];

export function apply(ctx) {
  if (ctx.webServer === undefined) return;
  for (const [path, handler] of routes) {
    ctx.effect(() => {
      try {
        const dispose = ctx.webServer.register({
          path,
          handler: (req, res) => {
            Promise.resolve(handler(req, res)).catch((error) => fail(res, error));
          },
        });
        logRoute(`route ${path}: ok`);
        return dispose;
      } catch (error) {
        logRoute(`route ${path}: hiba: ${error?.message ?? error}`);
        return () => {};
      }
    }, `ftp-deploy: ${path}`);
  }
}

export { deploy, runner, REPO_ROOT, PACKAGE_ROOT, STATE_DIR };
