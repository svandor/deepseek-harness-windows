#!/usr/bin/env node
/**
 * check-commit-msg.mjs — reject commit messages that are not written in English.
 *
 * WHY: this repository is public (`svandor/deepseek-harness-windows`). The Git
 * panel's HU/EN switch only covers the message IT generates; a hand-written
 * message — typed in the panel or passed to `git commit` by a script or an agent
 * session — ignored that setting, and the public history filled up with Hungarian
 * subjects. A convention nobody enforces is not a convention, so the rule is a
 * git hook.
 *
 * WHAT IT CHECKS: the subject and body of the message. Two signals mark a message
 * as Hungarian:
 *   1. Hungarian accented letters (á é í ó ö ő ú ü ű) anywhere — English commit
 *      messages do not need them,
 *   2. distinctive Hungarian words (hogy, nem, miatt, szerint, keret, javítás,
 *      ellenőrzés, …) as whole words. The list is deliberately narrow: a false
 *      positive blocks a legitimate commit, so ambiguous words ("a", "az", "es",
 *      "van") are not on it.
 *
 * ESCAPE HATCH: a message that must quote Hungarian text may opt out with a
 * trailer line `commit-lang: any` (and `git commit --no-verify` always works).
 *
 * USAGE: called by the `commit-msg` hook (tools/hooks/commit-msg) with the path
 * of the message file; also runnable by hand:
 *   node tools/check-commit-msg.mjs .git/COMMIT_EDITMSG
 *
 * Exit codes: 0 = English (or opted out), 1 = rejected.
 */
import { readFileSync } from 'node:fs';

const ACCENTED = /[\u00e1\u00e9\u00ed\u00f3\u00f6\u0151\u00fa\u00fc\u0171\u00c1\u00c9\u00cd\u00d3\u00d6\u0150\u00da\u00dc\u0170]/u;

/**
 * Whole-word Hungarian markers. Keep this list to words that do not occur in
 * English prose; every addition trades a false negative for a false positive.
 * Matching is case-insensitive, so "Keret-figyelo" is caught too. Words that
 * double as English ("old", "panel", "shim", "gas", "minta") are deliberately
 * ABSENT — they would reject legitimate messages.
 */
const WORDS = [
  // general
  'hogy', 'nem', 'miatt', 'szerint', 'utan', 'utani', 'csak', 'legyen', 'nincs',
  'kovetkezo', 'valtozas', 'mukodik', 'uzenet', 'mentes', 'beallit', 'beallitas',
  // this project's commit vocabulary
  'keret', 'kerete', 'keret-figyelo', 'figyelo', 'figyelő', 'szamla', 'merce',
  'heti', 'feladat', 'resze', 'szamlazas', 'vedelem', 'allitas', 'dontes',
  'emberi', 'ingyenes', 'elfogyott', 'fizetos', 'fogyas', 'becslese',
  'perzisztalva', 'javitas', 'hiba', 'hibak', 'ellenorzes', 'ellenorzesere',
  'kihagyasa', 'takaritas', 'proba', 'maradvanyok', 'eltavolitasa', 'szigoritas',
  'fiokadat', 'kiszervezes', 'vegpontok', 'modszertan', 'feloldasa', 'kotelezo',
  'uzem', 'azonositok', 'indito', 'ongyogyitasahoz', 'hibalanc', 'szivar',
  'toredek', 'alakzat', 'gyari', 'arlista', 'kizarasa', 'fajlszintu',
  'figyelembevetele', 'oldal', 'feltoltott', 'egyenleget', 'mutatja', 'teljes',
  'jovairt', 'bontas', 'dokumentacio', 'kiadas', 'frissites', 'frissit',
  'munkaterulet', 'bevezetes'
];
const WORD_PATTERN = new RegExp('\\b(?:' + WORDS.join('|') + ')\\b', 'iu');

/** Trailer that opts a message out of the check. */
const OPT_OUT = /^commit-lang:\s*any\s*$/imu;

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node tools/check-commit-msg.mjs <path-to-commit-message-file>');
  process.exit(2);
}

let raw;
try {
  // A leading BOM is an editor artefact, not part of the message.
  raw = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
} catch (error) {
  console.error('could not read the commit message file: ' + String(error?.message ?? error));
  process.exit(2);
}

// Comment lines are stripped by git before the commit, and the opt-out trailer
// makes the decision on its own.
if (OPT_OUT.test(raw)) process.exit(0);

const lines = raw
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0 && !line.startsWith('#'));

if (lines.length === 0) {
  // An empty message is git's own error, not a language problem.
  process.exit(0);
}

const text = lines.join('\n');
const accented = text.match(ACCENTED);
const word = text.match(WORD_PATTERN);

if (accented === null && word === null) process.exit(0);

const reason = accented !== null
  ? `Hungarian accented letter "${accented[0]}"`
  : `Hungarian word "${word[0]}"`;

console.error('');
console.error('*** COMMIT REJECTED: the message does not look English (' + reason + '). ***');
console.error('    Subject: ' + lines[0]);
console.error('');
console.error('This repository is public, so commit messages are written in English.');
console.error('Rewrite the message in English and commit again. Examples:');
console.error('  Update docs/UZEMELTETES.md (2026-10-19)');
console.error('  Cleanup: remove probe leftovers from the repo and tighten .gitignore');
console.error('');
console.error('If the message must quote Hungarian text, add this trailer line:');
console.error('  commit-lang: any');
console.error('(and `git commit --no-verify` always bypasses this hook)');
console.error('');
process.exit(1);
