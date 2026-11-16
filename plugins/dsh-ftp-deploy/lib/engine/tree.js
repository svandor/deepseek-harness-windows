/**
 * Gitignore-olt mappák (pl. `storage\app\imports\...`) bejárása az „extra"
 * feltöltéshez — a Felpuffantó `src\engine\tree.ts` portja.
 *
 * MÉRT OK a portban megtartva: a bejárás ASZINKRON és párhuzamos (32 szál),
 * mert a média-könyvtár több ezer fájlt tartalmaz; a szinkron `statSync`
 * változat percekig blokkolta az eseményhurkot.
 */
import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isDenied, toAllowRegexes } from "./deny.js";
import { posixRel } from "./paths.js";

const CONCURRENCY = 32;

async function mapLimit(items, limit, worker) {
  const out = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const r = await worker(items[i]);
      if (r !== null && r !== undefined) out.push(r);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Szélességi bejárás. Csak a TILTOTT fájlokra hív stat-ot; a többit a szülő
 * `withFileTypes` listája alapján sorolja be, így fájlonként nem kell stat.
 */
async function walk(rootAbs, rootRel, allowRegexes) {
  const files = [];
  const blocked = [];
  let level = [{ abs: rootAbs, rel: rootRel }];

  while (level.length > 0) {
    const scanned = await mapLimit(level, CONCURRENCY, async (dir) => {
      let entries;
      try {
        entries = await readdir(dir.abs, { withFileTypes: true });
      } catch {
        return null;
      }
      const subdirs = [];
      const found = [];
      const denied = [];

      for (const entry of entries) {
        const rel = posixRel(`${dir.rel}/${entry.name}`);
        if (entry.isDirectory()) {
          subdirs.push({ abs: path.join(dir.abs, entry.name), rel });
        } else if (entry.isFile()) {
          if (isDenied(rel, allowRegexes)) denied.push(rel);
          else found.push({ rel, abs: path.join(dir.abs, entry.name) });
        }
      }
      return { subdirs, found, denied };
    });

    const next = [];
    for (const s of scanned) {
      if (!s) continue;
      next.push(...s.subdirs);
      files.push(...s.found);
      blocked.push(...s.denied);
    }
    level = next;
  }

  return { files, blocked };
}

/** Fájlméretek párhuzamos lekérdezése. */
async function withSizes(items) {
  const files = [];
  let bytes = 0;
  const sizes = await mapLimit(items, CONCURRENCY, async (item) => {
    try {
      const st = await stat(item.abs);
      if (!st.isFile()) return null;
      return { rel: item.rel, size: st.size };
    } catch {
      return null; // eltűnt fájl — kihagyjuk
    }
  });
  for (const entry of sizes) {
    bytes += entry.size;
    files.push({
      path: entry.rel,
      size: entry.size,
      reason: "feltöltés",
      action: "upload",
      origin: "extra",
    });
  }
  return { files, bytes };
}

export async function collectTreeFiles(localRoot, relDir, options = {}) {
  const relRoot = posixRel(relDir).replace(/\/+$/, "");
  const absRoot = path.join(localRoot, ...relRoot.split("/"));
  const allowRegexes = toAllowRegexes(options.allow ?? []);

  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    throw new Error(`Nincs ilyen mappa: ${relRoot}`);
  }

  const walked = await walk(absRoot, relRoot, allowRegexes);
  const { files, bytes } = await withSizes(walked.files);
  files.sort((a, b) => a.path.localeCompare(b.path, "hu"));

  return { files, blocked: walked.blocked, bytes, total: files.length };
}
