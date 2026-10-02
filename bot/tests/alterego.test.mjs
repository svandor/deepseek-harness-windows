/**
 * Alteregó avatarok — szerződés- és konzisztencia-teszt.
 *
 * Futtatás:  node --test --test-isolation=none bot/tests/alterego.test.mjs
 *
 * Ez a teszt CSAK OLVAS: a katalógust, az SVG-ket és a `config.json`
 * avatar-blokkját ellenőrzi, de nem ír semmit. A `bot/lib/avatar.mjs`
 * `setAvatarState` függvényét szándékosan nem hívja (az a valódi
 * beállításokat írná).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  AUTO_CHOICES,
  AUTO_MAX,
  avatarFile,
  avatarList,
  avatarPayload,
  getAvatarState,
  isValidId,
  loadKatalog,
  normalizeAuto,
  readAvatarSvg,
} from '../lib/avatar.mjs';

/** A közös, minden fájlban BETŰRE ugyanilyen animációs blokk. */
const KOZOS_CSS = [
  '.lebeg { animation: lebeg 3.4s ease-in-out infinite; }',
  '@keyframes lebeg { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }',
  '.szem { transform-box: fill-box; transform-origin: center; animation: pislog 5.2s ease-in-out infinite; }',
  '@keyframes pislog { 0%,92%,100% { transform: scaleY(1); } 95% { transform: scaleY(0.08); } }',
];

const katalog = loadKatalog();
const svgFajlok = katalog.lista.map((item) => ({ ...item, path: avatarFile(item.id) }));
const svgTartalom = new Map(
  svgFajlok.filter((item) => existsSync(item.path)).map((item) => [item.id, readFileSync(item.path, 'utf8')]),
);

/** Minimális, de szigorú XML-tag-párosító (önzáró tagokat ismeri). */
function checkTags(svg) {
  const stripped = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '');
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = re.exec(stripped)) !== null) {
    const closing = match[1] === '/';
    const name = match[2];
    const selfClosing = match[4] === '/';
    if (closing) {
      const last = stack.pop();
      if (last !== name) return `záró tag hiba: </${name}> (várt: </${last}>)`;
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  return stack.length ? `lezárás nélküli tag: <${stack.join('>, <')}>` : null;
}

/* ------------------------------- katalógus -------------------------------- */

test('a katalógus legalább 10 alteregót sorol fel, egyedi id-kkel', () => {
  assert.ok(katalog.lista.length >= 10, `csak ${katalog.lista.length} alteregó van`);
  const idk = katalog.lista.map((item) => item.id);
  assert.equal(new Set(idk).size, idk.length, 'az id-k nem egyediek');
  assert.ok(idk.includes('gyuszi'), 'a Gyuszi (valódi) legyen a készletben');
  assert.ok(idk.includes('klasszikus'), 'a visszafelé kompatibilis Klasszikus legyen a készletben');
});

test('a katalógus minden bejegyzéséhez van SVG fájl és kitöltött név', () => {
  for (const item of avatarList()) {
    assert.ok(item.van, `hiányzó SVG: ${item.id} (${item.fajl})`);
    assert.ok(item.nev && item.nev.length > 1, `a ${item.id} neve üres`);
    assert.ok(item.alcim.length > 1, `a ${item.id} alcíme üres`);
    assert.ok(/^#[0-9a-f]{3,8}$/i.test(item.szin), `a ${item.id} színe érvénytelen: ${item.szin}`);
    assert.ok(item.ihlet.length > 4, `a ${item.id} ihletése üres`);
  }
  assert.deepEqual(avatarPayload().hianyzo, [], 'nem lehet hiányzó avatar');
});

test('az aktív alteregó mindig a katalógusból való', () => {
  const state = getAvatarState();
  assert.ok(katalog.lista.some((item) => item.id === state.aktiv), `ismeretlen aktív alteregó: ${state.aktiv}`);
  assert.ok(state.aktivNev.length > 0);
});

/* --------------------------------- SVG-k ---------------------------------- */

test('minden SVG önálló, animált dokumentum a szerződés szerint', () => {
  for (const [id, svg] of svgTartalom) {
    assert.ok(svg.length > 900, `${id}: gyanúsan kicsi SVG (${svg.length} byte)`);
    assert.ok(svg.length < 90_000, `${id}: gyanúsan nagy SVG (${svg.length} byte)`);
    assert.match(svg, /viewBox="0 0 240 320"/, `${id}: rossz viewBox`);
    assert.match(svg, /width="240"/, `${id}: rossz width`);
    assert.match(svg, /height="320"/, `${id}: rossz height`);
    assert.match(svg, /role="img"/, `${id}: hiányzó role="img"`);
    assert.match(svg, /aria-label="[^"]+"/, `${id}: hiányzó aria-label`);
    assert.equal(checkTags(svg), null, `${id}: ${checkTags(svg)}`);
  }
});

test('minden SVG tartalmazza a közös mozgás-nyelvet (lebeg + pislog)', () => {
  for (const [id, svg] of svgTartalom) {
    const css = (svg.replace(/\s+/g, ' ')).replace(/\s*([{};:,])\s*/g, '$1');
    for (const sor of KOZOS_CSS) {
      const kozos = sor.replace(/\s+/g, ' ').replace(/\s*([{};:,])\s*/g, '$1');
      assert.ok(css.includes(kozos), `${id}: hiányzik a közös blokk: ${sor}`);
    }
    assert.match(svg, /class="[^"]*\bszem\b[^"]*"/, `${id}: nincs .szem class-szal jelölt elem`);
    assert.match(svg, /<ellipse\b[^>]*fill="#000"/, `${id}: nincs talajárnyék`);
  }
});

test('az egyedi animációk nevei nem ütköznek a fájlok között', () => {
  const hol = new Map();
  for (const [id, svg] of svgTartalom) {
    for (const match of svg.matchAll(/@keyframes\s+([\w-]+)/g)) {
      const nev = match[1];
      if (nev === 'lebeg' || nev === 'pislog') continue;
      if (!hol.has(nev)) hol.set(nev, []);
      hol.get(nev).push(id);
    }
  }
  for (const [nev, holVan] of hol) {
    assert.equal(holVan.length, 1, `a(z) "${nev}" keyframes ${holVan.length} fájlban is szerepel: ${holVan.join(', ')} — a CSS felülírná egymást`);
  }
});

test('a fájlok nem tartalmaznak tiltott vagy külső hivatkozást', () => {
  const tiltott = [
    [/<script\b/i, '<script>'],
    [/<foreignObject\b/i, '<foreignObject>'],
    [/<image\b/i, '<image>'],
    [/<animate\b|<animateTransform\b|<set\b/i, 'SMIL animáció'],
    [/\son\w+\s*=/i, 'esemény-attribútum (onclick stb.)'],
    [/href\s*=\s*"https?:/i, 'külső hivatkozás'],
    [/url\(\s*['"]?https?:/i, 'külső url()'],
    [/@import\b/i, 'CSS @import'],
  ];
  for (const [id, svg] of svgTartalom) {
    for (const [minta, nev] of tiltott) {
      assert.ok(!minta.test(svg), `${id}: tiltott elem — ${nev}`);
    }
  }
});

test('az id-k egy fájlon belül egyediek', () => {
  for (const [id, svg] of svgTartalom) {
    const idk = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(idk).size, idk.length, `${id}: ismétlődő id — ${idk.filter((v, i) => idk.indexOf(v) !== i).join(', ')}`);
  }
});

/* ------------------------------ segédfüggvények --------------------------- */

test('az id-érvényesség szűri az útvonal-bejárást', () => {
  assert.equal(isValidId('gyuszi'), true);
  assert.equal(isValidId('ezust-gep-2'), true);
  assert.equal(isValidId('../config'), false);
  assert.equal(isValidId('Gyuszi'), false, 'csak kisbetű');
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('a/b'), false);
  assert.equal(isValidId(null), false);
});

test('az automatikus váltás másodperce korlátok közé esik', () => {
  assert.equal(normalizeAuto(0), 0);
  assert.equal(normalizeAuto(-5), 0);
  assert.equal(normalizeAuto(''), 0);
  assert.equal(normalizeAuto('30'), 30);
  assert.equal(normalizeAuto(1), 3, 'a legrövidebb értelmes váltás 3 mp');
  assert.equal(normalizeAuto(999999), AUTO_MAX);
  assert.deepEqual(AUTO_CHOICES, [0, 10, 30, 60, 300, 900, 1800, 3600, 7200]);
  assert.ok(AUTO_CHOICES.includes(normalizeAuto(30)));
  assert.ok(AUTO_CHOICES.includes(normalizeAuto(3600)), 'a hosszabb idokozok is valaszthatok');
});

test('a Gyuszi avatar valóban papírkosarat, kukát és flexicsövet ábrázol', () => {
  const svg = svgTartalom.get('gyuszi');
  assert.ok(svg, 'nincs gyuszi.svg');
  // papírkosár-rács, kukafedél és flexicső-gyűrűk (dasharray) mind jelen vannak
  assert.match(svg, /kosar/i, 'a papírkosár-réteg neve hiányzik');
  assert.match(svg, /fedel/i, 'a kukafedél-réteg neve hiányzik');
  assert.match(svg, /stroke-dasharray/, 'a flexicső gyűrűzése (dasharray) hiányzik');
  assert.match(svg, /gy-kar-bal/, 'a bal csőkar animációja hiányzik');
  assert.match(svg, /gy-kar-jobb/, 'a jobb csőkar animációja hiányzik');
});

test('a gyuszi és a klasszikus avatarja is olvasható a modulon át', () => {
  for (const id of ['gyuszi', 'klasszikus']) {
    const svg = readAvatarSvg(id);
    assert.ok(svg && svg.length > 900, `a ${id} SVG nem olvasható`);
  }
  // ismeretlen id esetén az alapértelmezett avatart adja, nem hibázik
  const alap = readAvatarSvg('nincs-ilyen-alterego');
  assert.ok(alap && alap.length > 900, 'ismeretlen id esetén az alap-avatart kell adni');
});
