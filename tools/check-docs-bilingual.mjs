#!/usr/bin/env node
/**
 * check-docs-bilingual.mjs — every document has an English mirror.
 *
 * WHY: the repository is public, and the interface/commit history was switched to
 * English for that reason — the documentation has to follow. The requested
 * convention is the one README already uses: `X.md` (Hungarian) next to
 * `X.en.md` (English), each linking to the other.
 *
 * WHAT IT REPORTS: every Hungarian `*.md` under the scanned directories that has
 * no `*.en.md` sibling, plus a summary line per directory. Exit code 1 when any
 * mirror is missing, so the check can gate a release or a goal round.
 *
 * USAGE:  node tools/check-docs-bilingual.mjs [--list]
 *   --list  print the missing mirrors one per line (no headers)
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose documents are part of the public face of the project. */
const DIRECTORIES = ['docs', 'providers'];

/**
 * Files that are exempt from the mirror rule. Empty today: every Hungarian
 * document under the scanned directories has (or must get) an English mirror,
 * and the mirrors themselves are skipped by the `*.en.md` rule below.
 */
const EXEMPT = new Set();

/**
 * The mirror of `X.md` is `X.en.md`. A file that IS a mirror (`*.en.md`) needs
 * its Hungarian source to exist, which is checked from the other direction.
 */
function mirrorName(file) {
  return basename(file, '.md') + '.en.md';
}

function markdownFiles(directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

const listOnly = process.argv.includes('--list');
const missing = [];
const orphans = [];
let mirrored = 0;

for (const directory of DIRECTORIES) {
  const files = markdownFiles(directory);
  const names = new Set(files);
  for (const file of files) {
    if (file.endsWith('.en.md')) continue; // handled below
    if (EXEMPT.has(file)) continue;
    if (names.has(mirrorName(file))) {
      mirrored++;
    } else {
      missing.push(join(directory, file));
    }
  }
  // An English mirror without its Hungarian source would mean a deleted document.
  for (const file of files) {
    if (!file.endsWith('.en.md')) continue;
    const source = basename(file, '.en.md') + '.md';
    if (!names.has(source)) orphans.push(join(directory, file));
  }
}

if (listOnly) {
  for (const file of missing) console.log(file);
  process.exit(missing.length === 0 && orphans.length === 0 ? 0 : 1);
}

console.log(`Magyar dokumentum: ${mirrored + missing.length} · angol tükörrel: ${mirrored} · hiányzó tükör: ${missing.length}`);
if (missing.length > 0) {
  console.log('');
  console.log('Hiányzó angol tükör / missing English mirror:');
  for (const file of missing) {
    console.log('  ' + file + '  ->  ' + file.replace(/\.md$/u, '.en.md'));
  }
}
if (orphans.length > 0) {
  console.log('');
  console.log('Angol tükör magyar forrás nélkül / mirror without its Hungarian source:');
  for (const file of orphans) console.log('  ' + file);
}
process.exit(missing.length === 0 && orphans.length === 0 ? 0 : 1);
