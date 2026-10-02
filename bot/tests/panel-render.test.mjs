/**
 * Füst-teszt a DSH-oldali robot panelhez (plugins/dsh-hazi-robot/lib/client.js).
 *
 * MIÉRT: a panel a DSH felületén belül renderelődik, ezért egy futásidejű hiba
 * (pl. hiányzó `props.theme`, `undefined` lista) nem csak a panelt viszi el,
 * hanem a fogadó felületet is. Az itteni hamis React végigfut a valódi
 * renderúton: minden hook egy értéket ad, a `createElement` pedig fát épít, így
 * a hibák (TypeError, `undefined.map`) még a restart ELŐTT kiderülnek.
 *
 * Futtatás:  node bot/tests/panel-render.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLIENT = join(ROOT, 'plugins', 'dsh-hazi-robot', 'lib', 'client.js');
const UI_EXTRAS = join(ROOT, 'plugins', 'dsh-ui-extras', 'lib', 'client.js');

/**
 * Betölti a bővítményt egy hamis `window.__ModuleLoader__`-rel, és visszaadja a
 * valódi exportokat. A `document` a böngésző globálisát helyettesíti, mert a
 * bundle arra a példányra zár be, amellyel kiértékelték.
 */
function loadPlugin(path, documentStub) {
  const source = readFileSync(path, 'utf8');
  let definition = null;
  const windowStub = { __ModuleLoader__: { load: (d) => { definition = d; } } };
  const fn = new Function('window', 'document', 'MutationObserver', 'matchMedia', 'setInterval', 'clearInterval', source);
  fn(windowStub, documentStub, class { observe() { } disconnect() { } }, () => ({ matches: true }), () => 1, () => { });
  assert.ok(definition, 'a bundle nem regisztrált __ModuleLoader__.load-dal');

  const componentStub = class { constructor(props) { this.props = props || {}; } setState() { } render() { return null; } };
  const reactStub = {
    Fragment: 'Fragment',
    Component: componentStub,
    PureComponent: componentStub,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    cloneElement: (element, props) => ({ type: element.type, props: props || {}, children: [] }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => { }],
    useEffect: () => { },
    useLayoutEffect: () => { },
    useRef: (initial) => ({ current: initial }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useReducer: (reducer, initial) => [initial, () => { }],
    createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', _value: value }),
    memo: (fn) => fn,
    forwardRef: (fn) => fn,
    createRef: () => ({ current: null }),
  };
  return definition.factory((name) => {
    if (name === 'react') return reactStub;
    // A ui-extras bundle a jsx runtime-ot is kéri (a robot panel nem).
    if (name === 'react/jsx-runtime') {
      return {
        Fragment: 'Fragment',
        jsx: (type, props) => ({ type, props: props || {}, children: props && props.children ? props.children : [] }),
        jsxs: (type, props) => ({ type, props: props || {}, children: props && props.children ? props.children : [] }),
      };
    }
    throw new Error('nem várt modul: ' + name);
  });
}

function documentStub(lang = 'hu', dark = true) {
  // A DSH a feloldott témát a <body data-ds-dark-theme> jelöléssel adja meg:
  // világos módban az attribútum NINCS rajta. A panel ezt olvassa elsőként.
  const body = { hasAttribute: (name) => name === 'data-ds-dark-theme' && dark, classList: { toggle() { } } };
  return {
    documentElement: { lang },
    body,
    title: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

test('a robot panel renderel magyarul, sötét témában', () => {
  const plugin = loadPlugin(CLIENT, documentStub('hu'));
  const locale = { getLocale: () => ({ active: 'hu' }), subscribe: () => () => { } };
  const theme = { getTheme: () => ({ preference: 'dark' }) };
  const button = plugin.RobotButton({ locale, theme, heroVariant: false });
  assert.ok(button, 'a gomb nem renderelődött (a fázis-kapu elnyelte)');
  const panel = plugin.RobotPanel({ onClose: () => { }, locale, theme });
  assert.equal(panel.props['data-theme'], 'dark');
  const texts = JSON.stringify(panel);
  assert.ok(texts.includes('Állapot'), 'a magyar fülfelirat hiányzik');
  assert.ok(texts.includes('Házirobot'), 'a magyar cím hiányzik');
});

test('a robot panel renderel angolul, világos témában', () => {
  const plugin = loadPlugin(CLIENT, documentStub('en', false));
  const locale = { getLocale: () => ({ active: 'en' }), subscribe: () => () => { } };
  const theme = { getTheme: () => ({ preference: 'light' }) };
  const panel = plugin.RobotPanel({ onClose: () => { }, locale, theme });
  assert.equal(panel.props['data-theme'], 'light');
  const texts = JSON.stringify(panel);
  assert.ok(texts.includes('Status'), 'az angol fülfelirat hiányzik');
  assert.ok(texts.includes('House robot'), 'az angol cím hiányzik');
  assert.ok(!texts.includes('Állapot'), 'magyar felirat maradt az angol felületen');
  // A téma tényleg átszínezi a felületet: világos módban nem maradhat sötét
  // háttér (ez volt a bejelentett hiba: fekete téglalap a fehér felületen).
  assert.ok(texts.includes('#ffffff'), 'a világos panelháttér hiányzik');
  assert.ok(!texts.includes('#151a21'), 'sötét háttér maradt világos módban');
  assert.ok(!texts.includes('#0f1216'), 'sötét mély háttér maradt világos módban');
});

test('a téma a szolgáltatásból is feloldható (system/light)', () => {
  // Ha a body-jelölés nem olvasható (pl. a panel még a boot előtt renderel),
  // a szolgáltatás snapshotja a tartalék — a `system` értéket is feloldva.
  const plugin = loadPlugin(CLIENT, { documentElement: { lang: 'hu' }, title: '', querySelector: () => null, querySelectorAll: () => [] });
  assert.equal(plugin.readDark({ getTheme: () => ({ preference: 'light' }) }), false);
  assert.equal(plugin.readDark({ getTheme: () => ({ preference: 'dark' }) }), true);
  assert.equal(plugin.readDark({ getTheme: () => ({ preference: 'system' }) }), true, 'system + sötét rendszer = sötét');
  assert.equal(plugin.readDark(undefined), true, 'szolgáltatás nélkül a sötét a biztonságos alap');
});

test('hiányzó locale/theme szolgáltatás nem töri el a panelt', () => {
  const plugin = loadPlugin(CLIENT, documentStub('en'));
  const panel = plugin.RobotPanel({ onClose: () => { } });
  assert.ok(panel, 'a panel nem renderelődött szolgáltatások nélkül');
});

test('a szótár két nyelve azonos kulcshalmaz', () => {
  const plugin = loadPlugin(CLIENT, documentStub('hu'));
  const hu = Object.keys(plugin.I18N.hu);
  const en = Object.keys(plugin.I18N.en);
  assert.deepEqual(en, hu, 'a hu/en kulcsok eltérnek');
  for (const key of hu) {
    assert.ok(String(plugin.I18N.hu[key]).trim().length > 0, 'üres magyar érték: ' + key);
    assert.ok(String(plugin.I18N.en[key]).trim().length > 0, 'üres angol érték: ' + key);
  }
});

test('a ui-extras kliens is betölthető és regisztrál (nincs backtick-hiba)', () => {
  const plugin = loadPlugin(UI_EXTRAS, documentStub('hu'));
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject), 'az inject lista nem tömb');
  assert.ok(plugin.inject.includes('theme'), 'a theme injektálás hiányzik (a témaszinkronhoz kell)');
});
