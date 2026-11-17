/**
 * A `dsh-devadmin` **hero gombjainak** füsttesztje böngésző nélkül.
 *
 * MIÉRT: a felhasználó 2026-11-17-én jelezte, hogy az új beszélgetés
 * felületén „hiányzik a php és az 1/2 gomb”. A fejléc rejtve van `hero`
 * fázisban, ezért a két ikon a `conversation.input.dock` slotba kerül — de az
 * függőleges lista, tehát a gomb külön sorba esett. A javítás: a slot-bejegyzés
 * `null`-t rajzol, a gomb pedig a `dsh-ui-extras` hero gombsorába PORTOL.
 *
 * A teszt betölti a valódi bundlet stubolt `react` / `react-dom` mellett,
 * lefuttatja az `apply(ctx)`-et, és ellenőrzi a regisztrációkat + a portált.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function makeReact() {
  let hooks = [];
  let cursor = 0;
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    Fragment: "Fragment",
    memo: (component) => component,
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [
        hooks[index],
        (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; },
      ];
    },
    useEffect() { cursor += 1; return undefined; },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(factory) { cursor += 1; return factory(); },
    useCallback(fn) { cursor += 1; return fn; },
    useLayoutEffect() { cursor += 1; return undefined; },
    Component: class { constructor(props) { this.props = props ?? {}; this.state = {}; } setState(next) { this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) }; } },
    __reset() { hooks = []; cursor = 0; },
  };
}

const HERO_HOST = { __marker: "hero-host" };

function fakeDocument() {
  return {
    querySelector(selector) {
      if (selector === "[data-dsh-hero-actions]") return HERO_HOST;
      if (selector === "[data-conversation-scroll]") {
        return { closest: (s) => (s === "[data-phase]" ? { getAttribute: () => "hero" } : null) };
      }
      return null;
    },
    querySelectorAll() { return []; },
    body: { hasAttribute: () => true },
  };
}

function loadBundle() {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let definition = null;
  const react = makeReact();
  const reactDom = { createPortal(children, container) { return { __portal: true, children, container }; } };
  const fakeRequire = (name) => {
    if (name === "react") return react;
    if (name === "react-dom") return reactDom;
    throw new Error(`ismeretlen require: ${name}`);
  };
  new Function("window", "module", "exports", "require", source)(
    { __ModuleLoader__: { load(def) { definition = def; } } },
    { exports: {} },
    {},
    fakeRequire,
  );
  if (!definition) throw new Error("a bundle nem hívta a __ModuleLoader__.load-ot");
  return { exported: definition.factory(fakeRequire), react };
}

function applyBundle(exported) {
  const registrations = [];
  const ctx = {
    effect(fn) { return typeof fn === "function" ? fn() : undefined; },
    sidebarRight: null,
    sidebarRightTabs: null,
    slots: {
      inject(name, factory) { registrations.push({ slot: name, registration: factory() }); },
      register(meta, component) { return { meta, component }; },
    },
  };
  exported.apply(ctx);
  return registrations;
}

test("devadmin: a PHP és az 1/2 gomb a hero-gombsorba portol (nem külön sorba)", () => {
  const { exported, react } = loadBundle();
  const registrations = applyBundle(exported);

  const heroPhp = registrations.find((entry) => entry.slot === "conversation.input.dock" && entry.registration.meta.id === "devadmin-hero-php");
  const heroDesktop = registrations.find((entry) => entry.slot === "conversation.input.dock" && entry.registration.meta.id === "devadmin-hero-desktop");
  assert.ok(heroPhp, "a PHP ikon hero-regisztrációja létrejön");
  assert.ok(heroDesktop, "az 1/2 ikon hero-regisztrációja létrejön");
  assert.equal(heroPhp.registration.meta.order, 60, "a fejléc-sorrenddel azonos order (PHP 60)");
  assert.equal(heroDesktop.registration.meta.order, 61, "a fejléc-sorrenddel azonos order (1/2 61)");

  const savedDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    react.__reset();
    const phpTree = heroPhp.registration.component({});
    assert.ok(phpTree, "a hero-bejegyzés renderel");
    assert.equal(phpTree.__portal, true, "a gomb PORTÁLBAN jelenik meg, nem a függőleges listában");
    assert.equal(phpTree.container, HERO_HOST, "a portál célja a hero gombsor");
    assert.equal(phpTree.children.type, "span");
    assert.equal(phpTree.children.props.style.order, 60, "a portált gomb sorrendje a fejléc-sorrend");

    react.__reset();
    const desktopTree = heroDesktop.registration.component({});
    assert.equal(desktopTree.__portal, true);
    assert.equal(desktopTree.children.props.style.order, 61);
  } finally {
    globalThis.document = savedDocument;
  }
});

test("devadmin: a fejléc-regisztrációk változatlanok", () => {
  const { exported } = loadBundle();
  const registrations = applyBundle(exported);
  const header = registrations.filter((entry) => entry.slot === "conversation.session.header.utilities");
  assert.deepEqual(header.map((entry) => entry.registration.meta.id), ["devadmin-header", "devadmin-desktop"]);
  assert.deepEqual(header.map((entry) => entry.registration.meta.order), [60, 61]);
});
