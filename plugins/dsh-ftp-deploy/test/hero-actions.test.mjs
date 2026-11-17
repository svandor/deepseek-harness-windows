/**
 * A `dsh-ftp-deploy` **hero gombjának** füsttesztje böngésző nélkül.
 *
 * MIÉRT: a felhasználó 2026-11-17-én jelezte, hogy az új beszélgetés felületén
 * hiányzik az FTP gomb. A fejléc `hero` fázisban rejtve van, ezért a gomb a
 * `conversation.input.dock` slotba kerül — az viszont függőleges lista, ezért a
 * gomb a `dsh-ui-extras` hero gombsorába PORTOL (a slot-bejegyzés `null`).
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

test("ftp: a gomb a hero-gombsorba portol", () => {
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
    effect(fn) { return typeof fn === "function" ? fn() : undefined; },
    sidebarRight: null,
    sidebarRightTabs: null,
    locale: {
      register() {},
      bind() { return (key) => String(key); },
    },
    slots: {
      inject(name, factory) { registrations.push({ slot: name, registration: factory() }); },
      register(meta, component) { return { meta, component }; },
    },
  };
  exported.apply(ctx);

  const hero = registrations.find((entry) => entry.slot === "conversation.input.dock" && entry.registration.meta.id === "ftp-deploy-hero");
  assert.ok(hero, "az FTP hero-regisztráció létrejön");
  assert.equal(hero.registration.meta.order, 62, "a fejléc-sorrenddel azonos order");

  const header = registrations.find((entry) => entry.slot === "conversation.session.header.utilities");
  assert.equal(header.registration.meta.id, "ftp-deploy-header");

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
  };
  try {
    react.__reset();
    const props = hero.registration.meta.inject ? hero.registration.meta.inject() : {};
    const tree = hero.registration.component({ ...props });
    assert.ok(tree, "a hero-bejegyzés renderel");
    assert.equal(tree.__portal, true, "a gomb portálban jelenik meg");
    assert.equal(tree.container, HERO_HOST, "a portál célja a hero gombsor");
    assert.equal(tree.children.type, "span");
    assert.equal(tree.children.props.style.order, 62);
    // A portált elem az FTP gomb komponense; lefuttatva valódi `button` lesz.
    const buttonElement = tree.children.children[0];
    assert.equal(typeof buttonElement.type, "function", "a portált elem az FTP gomb komponense");
    const rendered = buttonElement.type(buttonElement.props);
    assert.equal(rendered.type, "button", "a komponens valódi gombot ad");
  } finally {
    globalThis.document = savedDocument;
  }
});
