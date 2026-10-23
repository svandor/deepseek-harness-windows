#!/usr/bin/env node
/**
 * check-terminal-echo.mjs — the terminal input line's echo rule, in one file.
 *
 * Why this exists: the panel's input line must behave like a terminal's. A
 * terminal echoes ordinary typing and hides only a secret. Two failures are
 * possible and both were real:
 *
 *   * a FALSE positive masks ordinary typing (the earlier build masked every
 *     keystroke), and
 *   * a false NEGATIVE shows a password in clear (the earlier build did exactly
 *     that once echoing was switched on).
 *
 * The decision is made by `SECRET_PROMPT_SHAPE` in the client bundle. The regex
 * is READ OUT OF THAT FILE here instead of being copied, so this check cannot
 * drift away from the code it guards.
 *
 * Run:  node tools\check-terminal-echo.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'plugins', 'dsh-ui-extras', 'lib', 'client.js');
const source = readFileSync(clientPath, 'utf8');

let failures = 0;
const fail = (message) => { failures++; console.error('  FAIL ' + message); };
const ok = (message) => console.log('  ok   ' + message);

/* --- the regex, taken from the bundle ------------------------------------- */
const match = /var SECRET_PROMPT_SHAPE = (\/.+?\/[a-z]*);/u.exec(source);
if (!match) {
  fail('SECRET_PROMPT_SHAPE not found in client.js — the check cannot run');
  process.exit(1);
}
let RE;
try {
  // The literal is the bundle's own: parsed, never hand-copied.
  RE = new Function('return ' + match[1])();
} catch (error) {
  fail('SECRET_PROMPT_SHAPE is not a parsable regex literal: ' + error.message);
  process.exit(1);
}
ok('SECRET_PROMPT_SHAPE read from the bundle: ' + match[1]);

/* --- prompts (mask) and log lines (do not mask) ---------------------------- */
const cases = [
  // Real prompts, both languages the panel ships.
  ["Password: ", true],
  ["password:", true],
  ["user@host's password: ", true],
  ["[sudo] password for sandor: ", true],
  ["Enter passphrase for key '/c/Users/x/.ssh/id_rsa':", true],
  ["Password for 'https://user@github.com':", true],
  ['Jelszo: ', true],
  ['Jelszó: ', true],
  ['PIN kód:', true],
  // Not prompts: log lines, plain prompts and yes/no questions.
  ["Write-Host -NoNewline 'Password: '", false],
  ['npm WARN token expired', false],
  ['token: abc123', false],
  ['Do you want to change your password (y/n)? ', false],
  ['Password?', false],
  ['PS C:\\Szerver\\Deepseek Harness>', false],
  ['Deploy secret done.', false],
  ['AAA', false],
  ['', false]
];

for (const [line, wanted] of cases) {
  const got = RE.test(String(line).trim());
  if (got === wanted) {
    console.log('  ok   ' + JSON.stringify(line) + ' -> ' + got);
  } else {
    fail(JSON.stringify(line) + ': want ' + wanted + ', got ' + got);
  }
}

/* --- the bundle keeps the two halves that make the rule work -------------- */
for (const [needle, why] of [
  ['type: hideTyped ? "password" : "text"', 'the input line echoes by default and masks at a secret'],
  ['function forgetOldEchoPref', 'the inverted old preference is dropped, not read']
]) {
  if (source.includes(needle)) ok('bundle: ' + why);
  else fail('bundle is missing ' + JSON.stringify(needle) + ' — ' + why);
}

if (source.includes('readEchoPref')) fail('the old reveal-everything preference is still read');
else ok('bundle: the old "reveal everything" preference is no longer read');

console.log(failures === 0 ? `\nALL OK (${cases.length} prompt cases)` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
