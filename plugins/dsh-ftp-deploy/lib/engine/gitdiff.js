/**
 * Előnézet: mi az, ami a legutóbbi FTP-deploy óta megváltozott.
 *
 * A logika a Felpuffantó `src\engine\gitdiff.ts` portja; a `simple-git`
 * függőséget kiváltja a `git` közvetlen hívása (`execFile`, `windowsHide`), így
 * nincs extra csomag, és a gyermekfolyamat sem nyit konzolablakot.
 *
 * Miért git-diff és nem teljes fa: a tárhelyre csak a változás megy fel, a
 * törölt fájlok törlődnek — így a deploy másodpercek alatt lefut, nem tölt fel
 * több ezer fájlt minden alkalommal.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  completeLaravelInclude,
  isDenied,
  isSafeRelPath,
  matchesInclude,
  toAllowRegexes,
} from "./deny.js";
import { posixRel } from "./paths.js";

const MAX_BUFFER = 64 * 1024 * 1024;

/** Egy git hívás; hiba esetén `ok: false` (a hívó dönt, hogy ez végzetes-e). */
export function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: error ? String(error.message ?? error) : "",
        });
      },
    );
  });
}

/** A localRoot vagy egy fölötte lévő könyvtár, ahol van `.git`. */
export function resolveGitRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Git-relatív prefix a localRoot-ig. Üres, ha a localRoot maga a repo gyökér. */
export function localPrefixFromGitRoot(gitRoot, localRoot) {
  const rel = posixRel(path.relative(path.resolve(gitRoot), path.resolve(localRoot)));
  if (!rel || rel === ".") return "";
  if (rel.startsWith("..") || rel.split("/").includes("..")) {
    throw new Error("A localRoot nincs a git-repo alatt.");
  }
  return rel;
}

function toLocalRel(gitRel, prefix) {
  const n = posixRel(gitRel);
  if (!prefix) return n;
  if (n === prefix) return null;
  if (n.startsWith(`${prefix}/`)) return n.slice(prefix.length + 1);
  return null;
}

export async function currentHead(localRoot) {
  const gitRoot = resolveGitRoot(localRoot);
  if (!gitRoot) return null;
  // FIGYELEM: a git parancs `rev-parse` (a Felpuffantóban a simple-git
  // `revparse()` API-ja ezt rejtette; a portban a nyers parancs kell).
  const res = await runGit(["rev-parse", "HEAD"], gitRoot);
  return res.ok ? res.stdout.trim() : null;
}

/**
 * A feltöltendő/törlendő fájlok listája.
 *
 * @param {string} localRoot a projekt gyökere (a profil `localRoot`-ja)
 * @param {string[]} include mely mappák mehetnek fel (pl. `app`, `resources`)
 * @param {string|null} lastDeploySha az utolsó sikeres deploy commitja (baseline)
 * @param {{allow?: string[]}} [options] profil-szintű engedélyező prefixek
 */
export async function collectPreviewFiles(localRoot, include, lastDeploySha, options = {}) {
  const gitRoot = resolveGitRoot(localRoot);
  const headSha = await currentHead(localRoot);
  if (!gitRoot) {
    throw new Error("A localRoot nincs git-repóban. Az előnézet csak git-diffből dolgozik.");
  }
  if (!lastDeploySha) {
    return { needsBaseline: true, headSha, files: [], blocked: [] };
  }

  const prefix = localPrefixFromGitRoot(gitRoot, localRoot);
  const effectiveInclude = completeLaravelInclude(include);
  const allowRegexes = toAllowRegexes(options.allow ?? []);

  const committed = parseNameStatus(
    (await runGit(["diff", "--name-status", "--no-renames", lastDeploySha, "HEAD"], gitRoot)).stdout,
  );
  const staged = parseNameStatus(
    (await runGit(["diff", "--name-status", "--no-renames", "--cached"], gitRoot)).stdout,
  );
  const unstaged = parseNameStatus(
    (await runGit(["diff", "--name-status", "--no-renames"], gitRoot)).stdout,
  );
  const statusOut = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], gitRoot)).stdout;
  const untracked = parseUntracked(statusOut);

  const metas = new Map();
  for (const row of committed) metas.set(row.path, { origin: "committed", deleted: row.deleted });
  for (const row of staged) metas.set(row.path, { origin: "unstaged", deleted: row.deleted });
  for (const row of unstaged) metas.set(row.path, { origin: "unstaged", deleted: row.deleted });
  for (const row of untracked) {
    if (row.path) metas.set(row.path, { origin: "untracked", deleted: false });
  }

  const files = [];
  const blocked = [];

  for (const [gitRel, meta] of metas) {
    const rel = toLocalRel(gitRel, prefix);
    if (rel == null || !isSafeRelPath(rel)) continue;
    if (!matchesInclude(rel, effectiveInclude)) continue;
    if (isDenied(rel, allowRegexes) || isDenied(gitRel, allowRegexes)) {
      blocked.push(rel);
      continue;
    }
    if (meta.deleted) {
      files.push({ path: rel, size: 0, reason: "törlés", action: "delete", origin: meta.origin });
      continue;
    }
    const abs = path.join(localRoot, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
    files.push({
      path: rel,
      size: statSync(abs).size,
      reason: "feltöltés",
      action: "upload",
      origin: meta.origin,
    });
  }

  files.sort((a, b) => {
    if (a.action !== b.action) return a.action === "delete" ? -1 : 1;
    return a.path.localeCompare(b.path, "hu");
  });
  return { needsBaseline: false, headSha, files, blocked };
}

export function parseNameStatus(raw) {
  const out = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const tab = trimmed.indexOf("\t");
    if (tab < 0) continue;
    const status = trimmed.slice(0, tab).trim();
    const rest = trimmed.slice(tab + 1);
    const filePath = posixRel((rest.split("\t")[0] || rest).trim());
    if (!filePath) continue;
    out.push({ path: filePath, deleted: status.startsWith("D") });
  }
  return out;
}

/** `git status --porcelain` `??` sorai (a nem követett fájlok). */
export function parseUntracked(raw) {
  const out = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (line.length < 4) continue;
    if (line.slice(0, 2) !== "??") continue;
    const filePath = posixRel(line.slice(3).trim());
    if (filePath) out.push({ path: filePath, deleted: false });
  }
  return out;
}
