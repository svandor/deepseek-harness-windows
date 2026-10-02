#!/usr/bin/env node
/**
 * check-plugin.mjs — syntax + language-pack consistency check for dsh-ui-extras.
 *
 * Run from anywhere:  node tools/check-plugin.mjs
 *
 * Checks:
 *   1. both bundles parse (new Function catches syntax errors in the payload),
 *   2. every key in a Hungarian language-pack dictionary exists in the built-in
 *      English dictionary dumped by tools/extract-i18n.ps1 — a typo there would
 *      silently fall back to English and look like a missing translation,
 *   3. the plugin's own `hu` and `en` dictionaries carry the same key set, so a
 *      key added to one cannot be forgotten in the other.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'plugins', 'dsh-ui-extras', 'lib', 'client.js');
const indexPath = join(root, 'plugins', 'dsh-ui-extras', 'lib', 'index.js');

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

/* --- 1) syntax ------------------------------------------------------------ */
const sources = { 'client.js': clientPath, 'index.js': indexPath };
for (const [name, path] of Object.entries(sources)) {
  const text = readFileSync(path, 'utf8');
  try {
    if (/^\s*(?:import|export)\s/m.test(text)) {
      // ESM payload: a bare `import`/`export` is only legal at module top level,
      // and `new Function` wraps its body in a function — so the module-only
      // keywords are neutralised first. The result is parsed, never executed,
      // which is all a syntax check needs.
      const neutral = text
        .replace(/^\s*import\s[^;\n]*;?/gm, '')
        .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '')
        .replace(/^\s*export\s+default\s+/gm, 'var __default = ')
        .replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '')
        .replace(/import\.meta\.url/g, 'process.cwd()');
      new Function(neutral);
    } else {
      // Parsing only: never executed, the harness host is required at runtime.
      new Function(text);
    }
    ok(`${name} parses (${text.length} chars)`);
  } catch (error) {
    fail(`${name} does not parse: ${error.message}`);
  }
}

/* --- 2) language-pack keys against the built-in English ------------------- */
const clientText = readFileSync(clientPath, 'utf8');

/** Read a `var <name> = { "key": "value", ... };` block out of the bundle. */
function readDict(source, varName) {
  const start = source.indexOf(`var ${varName} = {`);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0, inStr = false, quote = '', esc = false, i = open;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  const block = source.slice(open, i + 1);
  const dict = {};
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(block))) dict[m[1]] ??= m[2];
  return dict;
}

const commonHu = readDict(clientText, 'commonHu');
if (!commonHu) fail('commonHu dictionary not found in client.js');
else ok(`commonHu found (${Object.keys(commonHu).length} keys)`);

/** Read the nested `var packHu = { "ns": { "key": "value" } };` block. */
function readPack(source) {
  const start = source.indexOf('var packHu = {');
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0, inStr = false, quote = '', esc = false, i = open;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  return source.slice(open, i + 1);
}

/**
 * Split a `{ "ns": { … }, "ns2": { … } }` block into one flat dictionary per
 * namespace. Each namespace is sliced to its own closing brace first: a single
 * regex spanning the whole block would swallow the following namespaces into the
 * preceding one, which hides a typo instead of reporting it.
 */
function splitNamespaces(block) {
  /** Index just past the `{` that opens at or after `from`. */
  function openBrace(from) { return block.indexOf('{', from); }
  /** Index of the `}` matching the `{` at `open`. */
  function closeBrace(open) {
    let depth = 0, inStr = false, quote = '', esc = false;
    for (let i = open; i < block.length; i++) {
      const c = block[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i;
    }
    return block.length - 1;
  }

  const out = {};
  const re = /"([A-Za-z0-9_.-]+)"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(block))) {
    const open = openBrace(m.index + m[0].length - 1);
    if (open < 0) break;
    const close = closeBrace(open);
    const body = block.slice(open, close + 1);
    const dict = {};
    const kv = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let p;
    while ((p = kv.exec(body))) dict[p[1]] ??= p[2];
    out[m[1]] = dict;
    re.lastIndex = close + 1;
  }
  return out;
}

const packBlock = readPack(clientText);
if (!packBlock) fail('packHu block not found in client.js');
const packs = packBlock ? splitNamespaces(packBlock) : {};
if (packBlock) {
  const counts = Object.entries(packs).map(([ns, d]) => `${ns}:${Object.keys(d).length}`).join(' ');
  ok(`packHu namespaces (${Object.keys(packs).length}): ${counts}`);
}

const tsv = join(root, 'state', 'i18n-en.tsv');
if (existsSync(tsv)) {
  const builtin = new Map();
  // The extraction script writes UTF-8 with a BOM, which would otherwise glue a
  // zero-width character to the FIRST namespace name and make it unfindable.
  const text = readFileSync(tsv, 'utf8').replace(/^\uFEFF/u, '');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ns, key] = line.split('\t');
    if (!ns || !key) continue;
    if (!builtin.has(ns)) builtin.set(ns, new Set());
    builtin.get(ns).add(key);
  }

  // Every key of every pack must exist in the corresponding built-in namespace,
  // otherwise the Hungarian string is never shown and the key silently falls
  // back to English — which looks like a missing translation, not a typo.
  const all = { ...(commonHu ? { common: commonHu } : {}), ...packs };
  let unknownTotal = 0;
  let covered = 0;
  let total = 0;
  for (const [ns, dict] of Object.entries(all)) {
    const known = builtin.get(ns);
    if (!known) { fail(`language-pack namespace "${ns}" is not a built-in namespace`); continue; }
    const unknown = Object.keys(dict).filter((k) => !known.has(k));
    if (unknown.length) {
      unknownTotal += unknown.length;
      fail(`${ns}: keys not in the built-in namespace: ${unknown.join(', ')}`);
    }
    covered += Object.keys(dict).length;
    total += known.size;
  }
  if (!unknownTotal) ok('every language-pack key exists in its built-in namespace');
  console.log(`  info Hungarian coverage: ${covered}/${total} keys across ${Object.keys(all).length} namespaces`);
} else {
  console.log('  info state/i18n-en.tsv missing — run tools/extract-i18n.ps1 to enable key checks');
}

/* --- 3) the plugin's own hu/en pair --------------------------------------- */
const hu = readDict(clientText, 'hu');
const en = readDict(clientText, 'en');
if (!hu || !en) fail('could not read the plugin hu/en dictionaries');
else {
  const onlyHu = Object.keys(hu).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in hu));
  if (onlyHu.length) fail(`keys only in hu: ${onlyHu.join(', ')}`);
  if (onlyEn.length) fail(`keys only in en: ${onlyEn.join(', ')}`);
  if (!onlyHu.length && !onlyEn.length) ok(`plugin dictionaries balanced (${Object.keys(hu).length} keys each)`);
}

/* --- 4) the locale readers against the real getLocale() shape -------------- */

/**
 * The client plugin's exported helpers, loaded from the real bundle in a fake
 * module host.
 *
 * Why here: `ctx.locale.getLocale()` answers an immutable SNAPSHOT
 * (`{ active, locales, revision }`), and reading it as a plain id is what made
 * the language button start as "EN" while Hungarian was on screen — a runtime
 * bug no static check can see. The bundle registers itself with
 * `window.__ModuleLoader__.load`, so a fake loader captures the factory and the
 * exports can be exercised against the exact snapshot shape the service
 * returns.
 */
const factories = [];
const fakeWindow = { __ModuleLoader__: { load: (definition) => factories.push(definition) } };
// The bundle closes over the `document` it was evaluated with, exactly as it
// closes over the browser's global in production — so the fake document is a
// parameter here rather than a global on `globalThis`.
const fakeDocument = { documentElement: { lang: '' } };
const stubRequire = (name) => {
  // The factory only DECLARES components, so the stubs need no behaviour — but
  // `class X extends react.Component` and `react.memo(...)` ARE evaluated at
  // load time, so those two must exist as callables.
  if (name === 'react') {
    return {
      Component: class { constructor(props) { this.props = props; } },
      memo: (component) => component,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial })
    };
  }
  if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button: () => null };
  throw new Error(`unexpected require("${name}")`);
};
try {
  // `window` is a parameter so the bundle's own registration lands in the fake.
  new Function('window', 'document', clientText)(fakeWindow, fakeDocument);
  const definition = factories.find((entry) => entry.id === 'dsh-ui-extras');
  if (definition === undefined) fail('the bundle registered no dsh-ui-extras factory');
  else {
    ok(`the bundle registers through __ModuleLoader__ (${factories.length} factory)`);
    // The factory resolves to the module's `exports` object itself.
    const plugin = definition.factory(stubRequire);
    const snapshot = { active: 'hu', locales: [{ id: 'hu' }, { id: 'en' }], revision: 3 };

    // The regression: the snapshot is an object, and the reader must still
    // answer the id — `String(snapshot)` is "[object Object]".
    if (String(snapshot) === 'hu') fail('the snapshot is unexpectedly string-like; the regression test is void');
    const id = plugin.activeLocaleId({ getLocale: () => snapshot });
    if (id === 'hu') ok('the active locale id is read from the snapshot object (no "[object Object]")');
    else fail(`activeLocaleId returned ${JSON.stringify(id)} for a Hungarian snapshot`);
    if (plugin.isHungarianLocaleId(id) === true) ok('the Hungarian id selects the "HU" button branch');
    else fail('isHungarianLocaleId said a Hungarian snapshot is not Hungarian');
    if (plugin.isHungarianLocaleId('en') === false) ok('an English id stays on the "EN" branch');
    else fail('isHungarianLocaleId matched an English id');

    // A plain id string is still accepted, and the document language is the
    // fallback when the service cannot answer at all.
    if (plugin.activeLocaleId({ getLocale: () => 'en' }) === 'en') ok('a plain id string is accepted too');
    else fail('activeLocaleId rejected a plain id string');
    fakeDocument.documentElement.lang = 'en';
    const fromDocument = plugin.activeLocaleId({ getLocale: () => { throw new Error('no locale service'); } });
    fakeDocument.documentElement.lang = '';
    if (fromDocument === 'en') ok('the document language is the fallback when the service throws');
    else fail(`activeLocaleId fell back to ${JSON.stringify(fromDocument)} instead of the document language`);

    // --- the workspace resolution ------------------------------------------
    //
    // The terminal panel resolves the directory its commands run in from three
    // sources. Getting the ORDER wrong is exactly what made "npm run dev" execute
    // in `C:\Szerver\Deepseek Harness` while another project's conversation was on
    // screen: the panel preferred the host's own cwd over the selected Session's
    // `cwd`, so the saved commands of the real project were never listed and every
    // command ran in the wrong directory. The order is a rule, so it is pinned
    // here against fake snapshots — and the tab body's late-arriving host answer
    // (a captured null) is pinned with it.
    const sessionState = (rows, selection) => ({
      list: { getSnapshot: () => ({ ids: Object.keys(rows), byId: rows, ...selection }) }
    });
    const workspaceService = (list, selected) => ({ getSnapshot: () => ({ list, selected }) });

    const laravel = { id: 's1', cwd: 'C:\\Herd\\termeszetgyogyaszoktatas-L12' };
    const sessionCase = sessionState({ s1: laravel }, { current: 's1', selected: 's1' });
    const hostDir = 'C:\\Szerver\\Deepseek Harness';

    const fromCurrent = plugin.resolveWorkspace(sessionCase, null, workspaceService([], null), hostDir);
    if (fromCurrent === laravel.cwd) ok('a panel takes the workspace from the selected Session cwd, not the host directory');
    else fail(`resolveWorkspace returned ${JSON.stringify(fromCurrent)} instead of the Session cwd`);

    const picked = plugin.pickSessionWorkspace(sessionState({ s1: laravel }, { current: 's1' }));
    if (picked === laravel.cwd) ok('the current Session cwd is readable straight off the list snapshot');
    else fail(`pickSessionWorkspace returned ${JSON.stringify(picked)} for a current Session with a cwd`);

    // The older selection spellings must still answer, and a Session without a
    // cwd must NOT be invented: the next source in line has to take over.
    const legacy = plugin.pickSessionWorkspace(sessionState({ s1: laravel }, { selectedId: 's1' }));
    if (legacy === laravel.cwd) ok('an older snapshot spelling (selectedId) resolves the same Session');
    else fail(`pickSessionWorkspace returned ${JSON.stringify(legacy)} for a selectedId snapshot`);

    const cwdless = plugin.pickSessionWorkspace(sessionState({ s1: { id: 's1' } }, { current: 's1' }));
    if (cwdless === null) ok('a Session without a cwd yields null instead of a guessed directory');
    else fail(`pickSessionWorkspace invented ${JSON.stringify(cwdless)} for a Session with no cwd`);

    const noSession = plugin.resolveWorkspace(sessionState({}, {}), null, workspaceService([], null), hostDir);
    if (noSession === hostDir) ok('with no Session and no workspace the host directory is the last resort');
    else fail(`resolveWorkspace returned ${JSON.stringify(noSession)} instead of the host fallback`);

    // --- the conversation phase readers ------------------------------------
    //
    // The corner controls and the statistics row are registered TWICE: once in
    // their regular seat, once in `conversation.input.dock` for the blank/hero
    // phase, where the framework renders neither the header nor the composer
    // dock. The phase decides which copy lives, so reading it must be exact —
    // including the trap that the composer carries a `data-phase` attribute of
    // its own with a different vocabulary ("inert", …).
    const node = (value) => ({ getAttribute: () => value });
    const anchorIn = (value) => ({ closest: () => node(value) });
    const candidatesOf = (...values) => values.map((value) => node(value));

    fakeDocument.querySelector = () => anchorIn('hero');
    fakeDocument.querySelectorAll = () => [];
    if (plugin.readConversationPhase() === 'hero') ok('the conversation phase is read from the root above the scroll body');
    else fail(`readConversationPhase returned ${JSON.stringify(plugin.readConversationPhase())} for a hero root`);

    // Without the anchor, only the conversation's own vocabulary is accepted:
    // the composer's "inert" must be skipped, never returned.
    fakeDocument.querySelector = () => null;
    fakeDocument.querySelectorAll = () => candidatesOf('inert', 'active');
    if (plugin.readConversationPhase() === 'active') ok('the composer\'s own "inert" phase is never mistaken for the conversation phase');
    else fail(`readConversationPhase returned ${JSON.stringify(plugin.readConversationPhase())} instead of "active"`);
    fakeDocument.querySelectorAll = () => candidatesOf('inert');
    if (plugin.readConversationPhase() === null) ok('an unknown phase answers null (never "hero")');
    else fail(`readConversationPhase returned ${JSON.stringify(plugin.readConversationPhase())} for an unknown phase`);

    const phaseCases = [
      [true, 'hero', true], [true, 'active', false], [true, 'settling', false], [true, null, false],
      [false, 'hero', false], [false, 'active', true], [false, 'settling', true], [false, null, true]
    ];
    const wrong = phaseCases.filter(([hero, phase, expected]) => plugin.phaseServesView(hero, phase) !== expected);
    if (wrong.length === 0) ok('exactly one copy of each view serves each phase (hero copy only in "hero")');
    else fail(`phaseServesView mismatches: ${JSON.stringify(wrong)}`);

    // --- the holiday calendar, against the host's own copy -------------------
    //
    // The peak/off-peak pill is decided in the browser, so this table is
    // duplicated from the host half (which owns the pricing). Two copies of one
    // rule must be checked against each other, or they drift and the row starts
    // claiming "peak" while the cost engine prices off-peak.
    const host = await import('../plugins/dsh-ui-extras/lib/index.js');
    const clientDays = Object.keys(plugin.CHINESE_HOLIDAYS).sort();
    const hostDays = [...host.CHINESE_HOLIDAYS].sort();
    if (clientDays.length === 0) fail('the client holiday calendar is empty');
    else if (clientDays.join(',') === hostDays.join(',')) ok(`the client and host holiday calendars match (${clientDays.length} days, ${host.holidaysCovered().join('/')})`);
    else {
      const onlyClient = clientDays.filter((day) => !hostDays.includes(day));
      const onlyHost = hostDays.filter((day) => !clientDays.includes(day));
      fail(`the holiday calendars drifted — client only: ${onlyClient.join(',') || '-'} ; host only: ${onlyHost.join(',') || '-'}`);
    }

    // The peak predicate itself must agree on both sides for a sample of
    // instants, including a Chinese holiday that falls on a weekday.
    const peakCases = [
      Date.UTC(2026, 8, 23, 2), Date.UTC(2026, 8, 23, 12), Date.UTC(2026, 8, 26, 7),
      Date.UTC(2026, 9, 1, 2), Date.UTC(2026, 9, 8, 2), Date.UTC(2026, 1, 16, 7)
    ];
    const peakDrift = peakCases.filter((time) => plugin.isPeakRate(new Date(time)) !== host.isPeakInstant(time));
    if (peakDrift.length === 0) ok('the client and host peak predicates agree on every sampled instant');
    else fail(`the peak predicates disagree at ${peakDrift.map((time) => new Date(time).toISOString()).join(', ')}`);

    // --- the next peak/off-peak switch --------------------------------------
    //
    // The row's "váltás …" value is the next flip. It used to step minute by
    // minute and give up after THREE days — shorter than a Chinese holiday
    // block. During National Day (10/01-10/07) the scan therefore found nothing
    // and the footer printed "váltás ?" for a week. These cases pin the flip to
    // the exact window edge, and the sweep proves no instant of the year is left
    // without an answer inside the horizon.
    const flipCases = [
      // National Day 2026 is off-peak through 10/07; the first window edge of
      // the working day after it is Thursday 10/08 01:00 UTC.
      [Date.UTC(2026, 9, 1, 12), Date.UTC(2026, 9, 8, 1), 'across the whole National Day block'],
      [Date.UTC(2026, 9, 7, 12), Date.UTC(2026, 9, 8, 1), 'on the last holiday day'],
      // Inside the first window the flip is that window's end; between the
      // windows it is the start of the next one.
      [Date.UTC(2026, 8, 23, 2), Date.UTC(2026, 8, 23, 4), 'at the end of the first window'],
      [Date.UTC(2026, 8, 23, 5), Date.UTC(2026, 8, 23, 6), 'at the start of the second window'],
      [Date.UTC(2026, 8, 23, 12), Date.UTC(2026, 8, 24, 1), 'after the last window, on the next day'],
      // Friday noon: the weekend (and the Mid-Autumn holiday before it) is
      // off-peak, so the flip is Monday's first window edge.
      [Date.UTC(2026, 8, 25, 12), Date.UTC(2026, 8, 28, 1), 'across the weekend']
    ];
    const wrongFlips = flipCases.filter(([from, expected]) => {
      const next = plugin.nextSwitch(new Date(from));
      return next === null || next.getTime() !== expected;
    });
    if (wrongFlips.length === 0) ok('the next switch lands on the exact window edge, including across a holiday block');
    else fail(`nextSwitch is wrong for ${wrongFlips.map(([from]) => new Date(from).toISOString()).join(', ')}`);

    // A flip is only a flip if the state really differs there, and it must
    // never be in the past. The original minute-by-minute scan is kept here as
    // the reference for the instants it could still reach.
    const bruteSwitch = (date, horizonDays) => {
      const start = !plugin.isPeakRate(date);
      const probe = new Date(date.getTime());
      probe.setUTCSeconds(0, 0);
      for (let i = 1; i <= 1440 * horizonDays; i += 1) {
        probe.setUTCMinutes(probe.getUTCMinutes() + 1);
        if ((!plugin.isPeakRate(probe)) !== start) return probe;
      }
      return null;
    };
    const samples = [];
    for (let day = 20; day <= 39; day += 1) samples.push(new Date(Date.UTC(2026, 8, day, 3, 17)));
    const brokenFlips = samples.filter((sample) => {
      const fast = plugin.nextSwitch(sample);
      if (fast === null || fast.getTime() <= sample.getTime()) return true;
      if (plugin.isPeakRate(fast) === plugin.isPeakRate(sample)) return true;
      const slow = bruteSwitch(sample, 8);
      return slow !== null && slow.getTime() !== fast.getTime();
    });
    if (brokenFlips.length === 0) ok(`every sampled instant has a real, future switch (${samples.length} samples, minute-scan reference agrees)`);
    else fail(`nextSwitch returned a wrong instant for ${brokenFlips.map((d) => d.toISOString()).join(', ')}`);

    let missingSwitch = 0;
    for (let time = Date.UTC(2026, 0, 1, 7); time < Date.UTC(2027, 0, 1); time += 24 * 3600000) {
      if (plugin.nextSwitch(new Date(time)) === null) missingSwitch += 1;
    }
    if (missingSwitch === 0) ok('no instant of 2026 is left without a switch inside the horizon');
    else fail(`${missingSwitch} instant(s) of 2026 have no switch inside the horizon`);
  }
} catch (error) {
  fail(`the client bundle could not be loaded in a fake module host: ${error.message}`);
}

/* --- 5) the stop really takes the process tree ----------------------------- */

/**
 * "Stop" must end the command the shell started, not only the shell.
 *
 * Measured: `child.kill()` on a piped powershell.exe ends the shell and leaves
 * `npm run dev` (or any other native child) running and holding its port — the
 * exact "stuck process I cannot stop" a terminal panel must not produce. This
 * test spawns a shell exactly like the host does, starts a blocking command in
 * it, calls the host's own `killRun`, and then checks the CHILD process:
 * a marker process that writes a file when it survives long enough is the
 * cheapest witness that works without a debugger.
 */
const hostModule = await import('../plugins/dsh-ui-extras/lib/index.js');
if (typeof hostModule.killRun !== 'function') {
  fail('the host does not export killRun, so the process-tree stop cannot be verified');
} else {
  const { spawn: spawnChild, spawnSync: spawnSyncHost } = await import('node:child_process');
  const { mkdtempSync: mkTmp, readFileSync: readF, writeFileSync: writeF, rmSync: rmT, existsSync: existsT } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');

  const dir = mkTmp(joinPath(tmp(), 'dsh-kill-test-'));
  const marker = joinPath(dir, 'survived.txt');
  const scriptFile = joinPath(dir, 'child.ps1');
  const launchFile = joinPath(dir, 'launch.txt');
  // A separate script file, because the command travels through a pipe into
  // powershell.exe: nested quoting on one line is where the first version of this
  // check failed (the child never started, so the check proved nothing).
  writeF(scriptFile, [
    '$path = ' + JSON.stringify(marker),
    '$first = ' + JSON.stringify(joinPath(dir, 'started.txt')),
    'Set-Content -Path $first -Value "started"',
    '1..60 | ForEach-Object {',
    '  Set-Content -Path $path -Value ("alive " + $_)',
    '  Start-Sleep -Milliseconds 400',
    '}'
  ].join('\n'), 'utf8');

  // The launch line itself lives in a file and travels in the environment, so no
  // layer of quoting can mangle the path. `-ArgumentList` takes an ARRAY: a single
  // string with embedded quotes is where the previous version failed with
  // "PositionalParameterNotFound".
  writeF(launchFile,
    'Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ' +
    "@('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File'," + JSON.stringify(scriptFile) + ')' + '\n',
    'utf8');

  const shell = spawnChild('powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', '-'],
    {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      // The launch line travels in the environment: no pipe, no `Invoke-Expression`
      // (which reads the REST of the shell's stdin, and swallowed the command in the
      // first two versions of this check).
      env: { ...process.env, DSH_KILL_TEST_LAUNCH: readF(launchFile, 'utf8').trim() }
    });
  let closed = false;
  let shellOutput = '';
  shell.stdout.on('data', (chunk) => { shellOutput += String(chunk); });
  shell.stderr.on('data', (chunk) => { shellOutput += String(chunk); });
  shell.on('close', () => { closed = true; });

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(1500);
  // A NATIVE grandchild: a second powershell launched BY the shell, which is the
  // shape of `npm run dev` (a native process under the interactive shell). A
  // PowerShell script block inside the shell itself would not prove the tree walk.
  shell.stdin.write('Invoke-Expression $env:DSH_KILL_TEST_LAUNCH\n');
  // The grandchild writes `started.txt` first and the marker right after.
  await wait(3000);

  const markerState = () => (existsT(marker) ? readF(marker, 'utf8') : null);
  const ran = existsT(joinPath(dir, 'started.txt'));
  // The grandchild's own pid, read from the process list by its command line.
  const grandchild = (() => {
    const result = spawnSyncHost('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.CommandLine -like "*child.ps1*" } | ForEach-Object { $_.ProcessId }'],
      { encoding: 'utf8', windowsHide: true });
    const pid = Number(String(result.stdout ?? '').trim().split(/\r?\n/u)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  })();

  const run = { id: 'test', child: shell, detached: process.platform !== 'win32' };
  const failure = hostModule.killRun(run);
  const evidence = run.evidence;
  await wait(4000);

  let grewAfterStop = false;
  const afterStop = markerState();
  if (afterStop !== null) {
    await wait(1500);
    grewAfterStop = markerState() !== afterStop;
  }
  const grandchildAlive = grandchild !== null && (() => {
    try { process.kill(grandchild, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
  })();

  if (!ran) fail(`the test child never started; the kill check is void (shell said: ${JSON.stringify(shellOutput.replace(/\s+/gu, ' ').slice(-300))})`);
  else if (failure !== null) fail(`killRun reported a failure: ${failure}`);
  else if (grewAfterStop || grandchildAlive) {
    fail(`the native grandchild SURVIVED the stop (kept writing=${String(grewAfterStop)}, alive=${String(grandchildAlive)}) — the tree is not being killed`);
  } else {
    ok(`the stop ends the native grandchild too (shell closed=${String(closed)}, grandchild pid=${String(grandchild)} gone)`);
  }
  console.log(`  info killRun evidence: ${JSON.stringify(evidence ?? null)}`);

  // Never leave the witness behind, whatever happened above.
  if (grandchildAlive && grandchild !== null) {
    spawnSyncHost('taskkill', ['/F', '/PID', String(grandchild)], { encoding: 'utf8', windowsHide: true });
  }
  try { rmT(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* --- 6) undefined function references ------------------------------------- */

/**
 * Flag a call to a function this bundle never defines.
 *
 * A missing helper is the one client bug the syntax check cannot see: it parses
 * perfectly and only throws when the panel that uses it renders, taking the whole
 * corner-control tree down with it (exactly what a call to a never-defined
 * `readPanelLayout` did). This is a heuristic, so it reports only names that are
 * neither declared anywhere in the file nor a known browser or library global.
 */
const KNOWN_GLOBALS = new Set([
  "function", "if", "for", "while", "switch", "catch", "return", "typeof", "new",
  "Number", "String", "Boolean", "Array", "Object", "JSON", "Math", "Date", "RegExp",
  "Map", "Set", "Promise", "Error", "Symbol", "BigInt", "Intl", "isNaN", "isFinite",
  "parseInt", "parseFloat", "decodeURIComponent", "encodeURIComponent", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone",
  "AbortController", "URLSearchParams", "URL", "Blob", "File", "FormData",
  "requestAnimationFrame", "cancelAnimationFrame", "fetch", "console", "window",
  "document", "location", "history", "localStorage", "sessionStorage", "navigator",
  "performance", "alert", "atob", "btoa", "ResizeObserver", "MutationObserver",
  "IntersectionObserver", "TextEncoder", "TextDecoder", "CustomEvent", "Event",
  "getComputedStyle", "matchMedia", "require", "module", "exports", "super", "this",
  "arguments", "process", "globalThis",
  // CSS value functions: they appear as text inside style objects, not as calls.
  "rgba", "rgb", "hsl", "hsla", "min", "max", "clamp", "calc", "repeat", "minmax",
  "url", "var", "translate", "translateY", "translateX", "scale", "rotate", "cubic-bezier"
]);

const declared = new Set();
for (const m of clientText.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/gu)) declared.add(m[1]);
for (const m of clientText.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gu)) declared.add(m[1]);
for (const m of clientText.matchAll(/\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:function|\()/gu)) declared.add(m[1]);
for (const m of clientText.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/gu)) declared.add(m[1]);
// Parameter names of every function form, so a call through a callback argument
// (`function (body, after) { … after(body) }`) is not flagged.
function collectParams(pattern) {
  for (const m of clientText.matchAll(pattern)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[\s=:]/u)[0];
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) declared.add(name);
    }
  }
}
collectParams(/\bfunction\s*\(([^)]*)\)/gu);
collectParams(/\(([^)]*)\)\s*=>/gu);
collectParams(/([A-Za-z_$][\w$]*)\s*=>/gu);

// Prose and string data are not code: comments would otherwise contribute words
// like "way (" from an English sentence, and CSS values would look like calls.
//
// Strings are stripped LINE BY LINE on purpose. A regex literal may contain a
// quote (the `cd` parser's `/(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|…)/` does), and a
// whole-file pass lets that one quote flip the pairing for every line after it:
// the leftovers then look like code and the rest of the file is effectively
// unchecked. Per line, the damage cannot leave the line it started on — a JS
// string literal never spans lines (the bundle uses no template literals).
const codeOnly = clientText
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ")
  .split("\n")
  .map((line) => line
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/`(?:[^`\\]|\\.)*`/gu, "``"))
  .join("\n");

const called = new Map();
for (const m of codeOnly.matchAll(/(^|[^.\w$])([a-z_$][\w$]*)\s*\(/gu)) {
  const name = m[2];
  if (!called.has(name)) called.set(name, codeOnly.slice(0, m.index).split("\n").length);
}

// Object-literal and class method definitions (`name(args) {`) and property keys
// (`name: function`, `"name": (…) =>`), which are definitions rather than calls.
for (const m of clientText.matchAll(/\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu)) declared.add(m[1]);
for (const m of clientText.matchAll(/(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/gmu)) declared.add(m[1]);
for (const m of clientText.matchAll(/["']?([A-Za-z_$][\w$]*)["']?\s*:\s*(?:function\b|\()/gu)) declared.add(m[1]);

const undefinedCalls = [...called.entries()]
  .filter(([name]) => !declared.has(name) && !KNOWN_GLOBALS.has(name))
  // A name that ALSO appears anywhere as a bare identifier is reached some other
  // way (a parameter, an object key, a property), so only a name used purely as
  // a call is worth reporting. This keeps the check quiet on callbacks while
  // still catching a forgotten helper.
  .filter(([name]) => !new RegExp(`(^|[^\\w$.])${name}(?![\\w$]*\\s*\\()`, "u").test(codeOnly))
  .map(([name, line]) => `${name} (line ${line})`);
if (undefinedCalls.length) fail(`client.js calls functions it never defines: ${undefinedCalls.join(", ")}`);
else ok(`every called function is defined or a known global (${called.size} call sites checked)`);

console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
