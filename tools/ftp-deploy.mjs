#!/usr/bin/env node
/**
 * FTP deploy — parancssori belépő (a panel és a gyorsgomb UGYANEZT a motort hívja).
 *
 * Miért van rá szükség: ha a felület nem elérhető (vagy a harness nem fut),
 * ugyanaz a művelet elvégezhető legyen kézzel is — és a két út között ne
 * legyen „két igazság" (AGENTS: a UI a host végpontot, a host ezt a motort hívja).
 *
 * Használat (a repo gyökeréből):
 *   node tools\ftp-deploy.mjs ping
 *   node tools\ftp-deploy.mjs profiles
 *   node tools\ftp-deploy.mjs preview --profile TGYO-L12
 *   node tools\ftp-deploy.mjs baseline --profile TGYO-L12
 *   node tools\ftp-deploy.mjs test --profile TGYO-L12
 *   node tools\ftp-deploy.mjs push --profile TGYO-L12 --confirm [--force-large]
 *   node tools\ftp-deploy.mjs push-extra --profile TGYO-L12 --confirm
 *   node tools\ftp-deploy.mjs remote --profile TGYO-L12 [--path /web/laravel12]
 *   node tools\ftp-deploy.mjs backup --profile TGYO-L12 [--mode full|code] [--dest mappa]
 *   node tools\ftp-deploy.mjs set-password --profile TGYO-L12      (jelszó: stdin)
 *   node tools\ftp-deploy.mjs log [--lines 40]
 *
 * Kimenet: JSON a stdout-on (`{ ok: true, ... }` vagy `{ ok: false, error }`),
 * a jelszó SOHA nem jelenik meg.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createDeploy } from "../plugins/dsh-ftp-deploy/lib/engine/deploy.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function argValue(name) {
  const args = process.argv;
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}
const hasFlag = (name) => process.argv.includes(name);

function progressLine(progress) {
  const parts = [progress.phase ?? "?"];
  if (progress.total) parts.push(`${progress.done ?? 0}/${progress.total}`);
  if (progress.current) parts.push(String(progress.current).slice(-60));
  process.stderr.write(`  ${parts.join(" ")}\r`);
}

async function main() {
  const deploy = createDeploy({ repoRoot });
  const cmd = process.argv[2] ?? "help";
  const profileId = argValue("--profile") ?? argValue("-p") ?? "";
  const requireProfile = () => {
    if (!profileId) throw new Error("Add meg: --profile <id>");
    return profileId;
  };

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      return {
        ok: true,
        usage: [
          "ping | profiles",
          "preview --profile <id>",
          "preview-extra --profile <id>",
          "baseline --profile <id>",
          "test --profile <id>",
          "push --profile <id> --confirm [--force-large]",
          "push-extra --profile <id> --confirm [--force-large]",
          "remote --profile <id> [--path /]",
          "backup --profile <id> [--mode full|code] [--dest <mappa>]",
          "set-password --profile <id>   (jelszó a stdin-en)",
          "log [--lines 40]",
        ],
        profiles: deploy.profiles.list().map((p) => ({ id: p.id, host: p.host, port: p.port })),
      };
    case "ping":
      return {
        ok: true,
        repoRoot,
        stateDir: deploy.paths.stateDir,
        profiles: deploy.profiles.list().length,
        node: process.version,
      };
    case "profiles":
      return { ok: true, profiles: deploy.profiles.list() };
    case "preview":
      return await deploy.preview(requireProfile());
    case "preview-extra":
      return await deploy.previewExtra(requireProfile());
    case "baseline":
      return await deploy.baseline(requireProfile());
    case "test":
      return await deploy.test(requireProfile());
    case "remote":
      return await deploy.listRemote(requireProfile(), argValue("--path") ?? "/");
    case "push":
      return await deploy.push({
        profileId: requireProfile(),
        confirm: hasFlag("--confirm"),
        forceLarge: hasFlag("--force-large"),
        onProgress: progressLine,
      });
    case "push-extra":
      return await deploy.pushExtra({
        profileId: requireProfile(),
        confirm: hasFlag("--confirm"),
        forceLarge: hasFlag("--force-large"),
        onProgress: progressLine,
      });
    case "backup":
      return await deploy.backup({
        profileId: requireProfile(),
        destDir: argValue("--dest") ?? "",
        mode: (argValue("--mode") ?? "full").toLowerCase() === "code" ? "code" : "full",
        onProgress: progressLine,
      });
    case "set-password": {
      const id = requireProfile();
      const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
      if (!password) throw new Error("A jelszó a stdin-en jön (pl. `echo jelszo | node tools\\ftp-deploy.mjs set-password --profile X`).");
      const result = await deploy.savePassword(id, password);
      return { ok: true, profileId: id, saved: result.saved };
    }
    case "log": {
      const lines = Number(argValue("--lines") ?? 40);
      try {
        const text = readFileSync(deploy.paths.logFile, "utf8");
        const all = text.split(/\r?\n/).filter((line) => line.trim() !== "");
        return { ok: true, lines: all.slice(-Math.max(1, lines)) };
      } catch {
        return { ok: true, lines: [] };
      }
    }
    default:
      throw new Error(`Ismeretlen parancs: ${cmd} (lásd: help)`);
  }
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: String(error?.message ?? error), code: error?.code ?? "" }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
