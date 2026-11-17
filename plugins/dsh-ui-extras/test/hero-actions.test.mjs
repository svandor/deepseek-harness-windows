/**
 * A `dsh-ui-extras` **hero gombsor** füsttesztje böngésző nélkül.
 *
 * MIÉRT: a felhasználó 2026-11-17-én jelezte, hogy az új beszélgetés felületén
 * „másként és össze-vissza” jelennek meg a gombok: a gombsorban nem volt meg
 * minden gomb (a többi plugin hero-példánya külön sorba került, mert a
 * `conversation.input.dock` függőleges lista).
 *
 * A teszt a valódi bundlet stubolt `react`-tel / `react-dom`-mal tölti be, és
 * ellenőrzi, hogy a hero-változat hordozza a portál-befogadót
 * (`data-dsh-hero-actions`), a fejléc-változat pedig nem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function makeReact() {
  let hooks = [];
  let cursor = 0;
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    memo(component) {
      return component;
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useEffect() { cursor += 1; return undefined; },
    useLayoutEffect() { cursor += 1; return undefined; },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(factory) { cursor += 1; return factory(); },
    useCallback(fn) { cursor += 1; return fn; },
    startTransition(fn) { fn(); },
    Component: class Component {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
      setState(next) { this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) }; }
    },
    __reset() { hooks = []; cursor = 0; },
  };
  return react;
}

function makeJsxRuntime() {
  const build = (type, props) => {
    const { children, ...rest } = props ?? {};
    return { type, props: rest, children: children === undefined ? [] : [].concat(children) };
  };
  return { jsx: build, jsxs: build, Fragment: "Fragment" };
}

/** A hero-gombsor befogadója, amit a többi plugin megtalál. */
const HERO_HOST = { __marker: "hero-host" };

function fakeDocument() {
  const phaseNode = {
    closest(selector) {
      return selector === "[data-phase]" ? { getAttribute: () => "hero" } : null;
    },
  };
  return {
    querySelector(selector) {
      if (selector === "[data-conversation-scroll]") return phaseNode;
      return null;
    },
    querySelectorAll() { return []; },
    body: { hasAttribute: () => true, appendChild() {} },
    documentElement: { lang: "hu" },
    head: { appendChild() {} },
    createElement() { return { setAttribute() {}, style: {}, appendChild() {}, addEventListener() {} }; },
    addEventListener() {},
    removeEventListener() {},
  };
}

function loadBundle() {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let definition = null;
  const react = makeReact();
  const jsx = makeJsxRuntime();
  const fakeWindow = {
    __ModuleLoader__: { load(def) { definition = def; } },
    location: { pathname: "/", reload() {}, search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const reactDom = {
    createPortal(children, container) { return { __portal: true, children, container }; },
    createRoot: () => ({ render() {}, unmount() {} }),
    render() {},
  };
  const fakeRequire = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react-dom") return reactDom;
    throw new Error(`ismeretlen require: ${name}`);
  };
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
  };
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument();
  globalThis.localStorage = fakeWindow.localStorage;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const runner = new Function("window", "module", "exports", "require", "fetch", `${source}\n`);
    const fakeModule = { exports: {} };
    runner(fakeWindow, fakeModule, fakeModule.exports, fakeRequire, globalThis.fetch);
    if (!definition) throw new Error("a bundle nem hívta a __ModuleLoader__.load-ot");
    return { exported: definition.factory(fakeRequire), react };
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.fetch = saved.fetch;
    globalThis.localStorage = saved.localStorage;
  }
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (typeof node !== "object") return;
  visit(node);
  if (node.props && node.props.children) walk(node.props.children, visit);
  for (const child of node.children ?? []) walk(child, visit);
}

function findNodes(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

test("ui-extras: a hero-változat hordozza a gombsor-befogadót, a fejléc nem", () => {
  const { exported, react } = loadBundle();
  assert.equal(typeof exported.CornerControls, "function");

  const locale = {
    getLocale: () => ({ active: "hu" }),
    subscribe: () => () => {},
    setLocale() {},
    bind: () => (key) => String(key),
  };
  const theme = {
    getTheme: () => ({ preference: "dark" }),
    setTheme() {},
    setPreference() {},
    subscribe: () => () => {},
  };
  const props = {
    t: (key) => String(key),
    locale,
    theme,
    sessions: null,
    workspaces: null,
    sidebarRight: null,
  };

  // A fázist a beszélgetés-gyökér `data-phase` attribútuma adja: a renderhez
  // tehát a dokumentumot is stubolni kell (a bundle a `document`-et olvassa).
  const savedDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    react.__reset();
    const hero = exported.CornerControls({ ...props, heroVariant: true });
    assert.ok(hero, "a hero-változat renderel");
    const hosts = findNodes(hero, (node) => node.props && node.props["data-dsh-hero-actions"] === "1");
    assert.equal(hosts.length, 1, "a hero gombsor EGY befogadót ad a többi plugin gombjainak");

    react.__reset();
    const header = exported.CornerControls({ ...props, heroVariant: false });
    const headerHosts = findNodes(header, (node) => node.props && node.props["data-dsh-hero-actions"] === "1");
    assert.equal(headerHosts.length, 0, "a fejléc-változat nem hordoz befogadót");
  } finally {
    globalThis.document = savedDocument;
  }
});
