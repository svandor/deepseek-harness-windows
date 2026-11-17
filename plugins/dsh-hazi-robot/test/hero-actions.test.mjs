/**
 * A `dsh-hazi-robot` **robot gomb hero-példányának** füsttesztje böngésző nélkül.
 *
 * MIÉRT: a felhasználó 2026-11-17-én jelezte, hogy az új beszélgetés felületén a
 * robot gomb „más helyre van bedobva, nem a gombsorba” — mert a
 * `conversation.input.dock` függőleges lista, és a robot hero-bejegyzése külön
 * sorba került. A javítás: a gomb a `dsh-ui-extras` hero gombsorába PORTOL, a
 * panel a saját helyén marad.
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

test("robot: a hero gomb a gombsorba portol, a panel a helyén marad", () => {
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
  const exported = definition.factory(fakeRequire);

  const registrations = [];
  const ctx = {
    slots: {
      inject(name, factory) { registrations.push({ slot: name, registration: factory() }); },
      register(meta, component) { return { meta, component }; },
    },
    locale: { getLocale: () => "hu", subscribe: () => () => {} },
    theme: { getTheme: () => ({ preference: "dark" }) },
  };
  exported.apply(ctx);

  const hero = registrations.find((entry) => entry.slot === "conversation.input.dock" && entry.registration.meta.id === "hazi-robot-hero");
  assert.ok(hero, "a robot hero-regisztráció létrejön");
  const props = hero.registration.meta.inject();
  assert.equal(props.heroVariant, true);

  const savedDocument = globalThis.document;
  globalThis.document = {
    querySelector(selector) {
      if (selector === "[data-dsh-hero-actions]") return HERO_HOST;
      if (selector === "[data-conversation-scroll]") {
        return { closest: (s) => (s === "[data-phase]" ? { getAttribute: () => "hero" } : null) };
      }
      return null;
    },
    querySelectorAll() { return []; },
    body: { hasAttribute: () => false },
  };
  try {
    react.__reset();
    const tree = hero.registration.component(props);
    assert.ok(tree, "a robot hero-példány renderel");
    const portal = tree.children[0];
    assert.equal(portal.__portal, true, "a robot gomb portálban jelenik meg");
    assert.equal(portal.container, HERO_HOST, "a portál célja a hero gombsor");
    const span = portal.children;
    assert.equal(span.type, "span");
    assert.equal(span.children[0].type, "button", "a portált elem a robot gomb");
    assert.equal(span.children[0].children[0], "🤖");
  } finally {
    globalThis.document = savedDocument;
  }
});
