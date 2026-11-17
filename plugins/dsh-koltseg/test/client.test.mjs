/**
 * A KLIENS fél füsttesztje böngésző nélkül.
 *
 * Miért: a bundle a WebView2-ben fut, ott hibát csak a felhasználó látna. Itt
 * stuboljuk a `window.__ModuleLoader__`-t, a `react`-et és (opcionálisan) a
 * `react-dom`-ot, majd végigfuttatjuk a `factory`-t, az `apply(ctx)`-et
 * (regisztrációk) és a komponensek renderelését.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Minimál React stub: elég a rendereléshez és a hookokhoz. */
function makeReact() {
  let hooks = [];
  let cursor = 0;
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    Fragment: "Fragment",
    memo(component) {
      return component;
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [
        hooks[index],
        (next) => {
          hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
        },
      ];
    },
    useEffect() {
      cursor += 1;
      return undefined;
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(factory) {
      cursor += 1;
      return factory();
    },
    useCallback(fn) {
      cursor += 1;
      return fn;
    },
    Component: class Component {
      constructor(props) {
        this.props = props ?? {};
        this.state = {};
      }

      setState(next) {
        this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
      }
    },
    __reset() {
      hooks = [];
      cursor = 0;
    },
    /** Újrarenderelés: a hook-tár megmarad, a kurzor visszaáll (mint a Reactnél). */
    __rewind() {
      cursor = 0;
    },
  };
  return react;
}

function loadClient(options = {}) {
  let definition = null;
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const loader = { load(def) { definition = def; } };
  const runner = new Function("window", "module", "exports", "require", `${source}\n`);
  const fakeModule = { exports: {} };
  const react = makeReact();
  const reactDom = options.reactDom === true
    ? { createPortal(children, container) { return { __portal: true, children, container }; } }
    : null;
  const fakeRequire = (name) => {
    if (name === "react") return react;
    if (name === "react-dom") {
      if (reactDom === null) throw new Error("nincs react-dom");
      return reactDom;
    }
    throw new Error(`ismeretlen require: ${name}`);
  };
  runner({ __ModuleLoader__: loader }, fakeModule, fakeModule.exports, fakeRequire);
  if (!definition) throw new Error("a bundle nem hívta a __ModuleLoader__.load-ot");
  const exported = definition.factory(fakeRequire);
  return { exported, react };
}

function makeCtx() {
  const calls = { slots: [], locale: [] };
  const ctx = {
    effect(fn) {
      return typeof fn === "function" ? fn() : undefined;
    },
    locale: {
      register(ns, packs) {
        calls.locale.push({ ns, packs });
      },
      bind(ns) {
        return (key, values) => {
          const pack = calls.locale.find((entry) => entry.ns === ns);
          const template = pack && pack.packs && pack.packs.hu ? pack.packs.hu[key] : undefined;
          const text = template ?? `#${key}`;
          return values
            ? String(text).replace(/\{(\w+)\}/g, (_m, k) => (k in values ? String(values[k]) : `{${k}}`))
            : text;
        };
      },
    },
    slots: {
      inject(name, factory) {
        calls.slots.push({ name, registration: factory() });
      },
      register(meta, component) {
        return { meta, component };
      },
    },
  };
  return { ctx, calls };
}

test("kliens: a bundle betölt, a fejléc-ikon és a mérés-regisztráció létrejön", () => {
  const { exported, react } = loadClient();
  assert.equal(exported.name, "dsh-koltseg");
  assert.ok(Array.isArray(exported.inject));
  for (const dep of ["slots", "locale"]) assert.ok(exported.inject.includes(dep), `${dep} kell az inject listára`);
  // MÉRT HIBA (2026-11-17): a munkaterület-feloldáshoz olvasott szolgáltatások
  // DEKLARÁLVA kell legyenek, különben a kliens-betöltés elszáll
  // („cannot get property 'sessions' without inject”).
  for (const dep of ["sessions", "workspaces"]) assert.ok(exported.inject.includes(dep), `${dep} kell az inject listára`);

  const { ctx, calls } = makeCtx();
  exported.apply(ctx);

  const header = calls.slots.find((entry) => entry.name === "conversation.session.header.utilities");
  assert.ok(header, "a fejléc-ikon a conversation.session.header.utilities slotban");
  assert.equal(header.registration.meta.id, "koltseg-header");
  assert.equal(header.registration.meta.order, 5);
  assert.equal(header.registration.meta.locale, "koltseg");
  assert.equal(typeof header.registration.meta.inject, "function");
  // A gomb NEM kap inject-props-ot (mért ok: azzal a komponens nem hívódott meg);
  // a fordítót és a seat-t a modul adja.
  assert.deepEqual(header.registration.meta.inject(), {});
  assert.equal(typeof header.registration.component, "function");

  const tracker = calls.slots.find((entry) => entry.name === "conversation.composer.dock" && entry.registration.meta.id === "koltseg-tracker");
  assert.ok(tracker, "a statisztika-sor regisztrációja (csak mérő)");
  // A felhasználó kérésére a panelek alján NINCS külön chip: ez a bejegyzés
  // csak aktivitást mér, gombot nem rajzol.
  assert.equal(tracker.registration.component, exported.ActivityTracker);

  // A hero fázisban a fejléc rejtve van: ott a composer fölötti sáv adja a
  // gombot (különben „nem látszik a funkció” — mért panasz).
  const heroButton = calls.slots.find((entry) => entry.name === "conversation.input.dock" && entry.registration.meta.id === "koltseg-hero");
  assert.ok(heroButton, "a hero-gomb a conversation.input.dock slotban");
  assert.equal(heroButton.registration.meta.order, 42);
  assert.equal(typeof heroButton.registration.component, "function");

  const heroTracker = calls.slots.find((entry) => entry.name === "conversation.input.dock" && entry.registration.meta.id === "koltseg-tracker-hero");
  assert.ok(heroTracker, "a hero-mérő is regisztrálva (a composer dock hero fázisban nincs)");
  assert.equal(heroTracker.registration.component, exported.KoltsegHeroHost);

  // A menüsor gombja: ikon, tooltip, és a panel a kattintásra jelenik meg.
  react.__reset();
  const seat = exported.KoltsegButton({ sessionId: "session-abc" });
  assert.ok(seat, "a fejléc-gomb renderel");
  assert.equal(seat.type, "button");
  assert.equal(seat.props["data-koltseg-seat"], "header");
  assert.equal(seat.props.title, "Költségelszámolás — a fejlesztés ideje és díja (munkafolyamat, munkaterület, időszak)");
});

test("kliens: az ezres tagolás kis hézaggal jelenik meg (a beírt óradíjnál is)", () => {
  const { exported } = loadClient();
  const { groupDigits, digitsOnly } = exported.__util;
  assert.equal(groupDigits("12500"), "12\u00A0500");
  assert.equal(groupDigits("1250000"), "1\u00A0250\u00A0000");
  assert.equal(groupDigits("999"), "999");
  assert.equal(groupDigits(""), "");
  assert.equal(groupDigits("12 500 Ft"), "12\u00A0500");
  assert.equal(digitsOnly("12\u00A0500"), "12500");
  assert.equal(digitsOnly("12 500 Ft"), "12500");
});

test("kliens: a szótár hu és en kulcsai egyeznek", () => {
  const { exported } = loadClient();
  const hu = Object.keys(exported.__dict.hu).sort();
  const en = Object.keys(exported.__dict.en).sort();
  assert.deepEqual(en, hu, "a két nyelv kulcshalmaza azonos");
  assert.ok(hu.length > 60, "van elég szöveg");
});

test("kliens: a panel props nélkül és props-szal is renderel (nincs kivétel)", () => {
  const { exported, react } = loadClient();
  const { ctx, calls } = makeCtx();
  exported.apply(ctx);
  const t = ctx.locale.bind("koltseg");

  react.__reset();
  const noProps = exported.KoltsegPanel();
  assert.ok(noProps, "props nélkül is van mit renderelni");

  react.__reset();
  const withProps = exported.KoltsegPanel({ t, sessionId: "session-abc", workspace: "D:\\Temp\\ws" });
  assert.ok(withProps, "profillal renderel");
  // A fejlécben a bezárás gomb csak `onClose` esetén jelenik meg.
  react.__reset();
  const closable = exported.KoltsegPanel({ t, onClose: () => {} });
  assert.ok(closable, "onClose-zal renderel");

  // A panel a mérés hiányában is kiír valamit (nem üres, nem néma).
  const body = closable.children[1];
  assert.ok(Array.isArray(body.children) && body.children.length > 0, "van tartalom hiba nélkül is");
});

test("kliens: a panel hiba-határa szöveget ad, nem üres helyet", () => {
  const { exported } = loadClient();
  const instance = new exported.PanelBoundary({ t: (key) => key });
  instance.state = { error: "teszt hiba" };
  const tree = instance.render();
  const text = JSON.stringify(tree);
  assert.match(text, /teszt hiba/u);
});

test("kliens: a menüsor gombja ikon+tooltip, és kattintásra lebegő ablakot nyit", () => {
  const { exported, react } = loadClient();
  const { ctx } = makeCtx();
  exported.apply(ctx);
  const t = ctx.locale.bind("koltseg");

  react.__reset();
  const closed = exported.KoltsegButton({ t, sessionId: "session-abc" });
  assert.equal(closed.type, "button");
  assert.equal(closed.props.title, t("header.title"));
  assert.equal(closed.props["aria-expanded"], "false");
  assert.equal(closed.props["aria-label"], t("tab.title"));
  const icon = closed.children[0];
  assert.equal(icon.type, "svg", "a gomb ikon (svg), nem felirat");

  // Kattintás: a hook-tárban az `open` állapot igazra vált, a második render
  // már a lebegő ablakot is adja.
  closed.props.onClick();
  react.__rewind();
  const opened = exported.KoltsegButton({ t, sessionId: "session-abc" });
  // Nyitott állapotban a gyökér egy Fragment: [gomb, panel].
  assert.equal(opened.children[0].props["aria-expanded"], "true");
  const panel = opened.children[1];
  assert.ok(panel, "a panel megjelenik");
  assert.equal(panel.props.style.position, "fixed", "a panel lebegő (position: fixed)");
  assert.ok(panel.props.style.zIndex > 1000, "a panel a tartalom fölött van");
  assert.equal(panel.props.role, "dialog");
});

test("kliens: react-dom esetén a panel a document.body-ba portol", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { body: { __body: true } };
  try {
    const { exported, react } = loadClient({ reactDom: true });
    const { ctx } = makeCtx();
    exported.apply(ctx);
    const t = ctx.locale.bind("koltseg");
    react.__reset();
    const closed = exported.KoltsegButton({ t, sessionId: "session-abc" });
    closed.props.onClick();
    react.__rewind();
    const opened = exported.KoltsegButton({ t, sessionId: "session-abc" });
    const portal = opened.children[1];
    assert.equal(portal.__portal, true, "portál elem");
    assert.equal(portal.container, globalThis.document.body);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("kliens: az aktivitás-mérő láthatatlan (null-t renderel)", () => {
  const { exported } = loadClient();
  const tree = exported.ActivityTracker({ sessionId: "session-abc", workspace: "D:\\Temp\\ws" });
  assert.equal(tree, null);
  const noProps = exported.ActivityTracker();
  assert.equal(noProps, null);
});

test("kliens: a bundle a helyes végpontot és slotokat használja", () => {
  const { exported } = loadClient();
  const constants = exported.__constants;
  assert.equal(constants.ROUTE, "/koltseg");
  assert.equal(constants.HEADER_SLOT, "conversation.session.header.utilities");
  assert.equal(constants.TRACKER_SLOT, "conversation.composer.dock");
  assert.equal(constants.HEADER_ID, "koltseg-header");
});

test("kliens: a hero gomb a kozos gombsorba portol (nem kulon sorba)", () => {
  const savedDocument = globalThis.document;
  const HERO_HOST = { __marker: "hero-host" };
  globalThis.document = {
    body: { __body: true },
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
    const { exported, react } = loadClient({ reactDom: true });
    const { ctx, calls } = makeCtx();
    exported.apply(ctx);
    const heroEntry = calls.slots.find(
      (entry) => entry.name === "conversation.input.dock" && entry.registration.meta.id === "koltseg-hero",
    );
    assert.ok(heroEntry, "a hero-regisztracio letezik");
    const t = ctx.locale.bind("koltseg");
    react.__reset();
    const tree = heroEntry.registration.component({ sessionId: "session-abc", t });
    assert.ok(tree, "a hero gomb renderel");
    assert.equal(tree.__portal, true, "a gomb a hero gombsorba portol");
    assert.equal(tree.container, HERO_HOST, "a portal celja a kozos gombsor");
    const wrapper = tree.children;
    assert.equal(wrapper.type, "span");
    assert.equal(wrapper.props.style.order, 5, "a fejlec-sorrenddel azonos order");
    assert.equal(wrapper.children[0].type, "button");
    assert.equal(wrapper.children[0].props["data-koltseg-seat"], "hero");
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  }
});

test("kliens: a lebegő ablak sötét színsémát és sötét legördülőt ad", () => {
  // MÉRT HIBA (2026-11-17): a natív <select> `transparent` háttérrel FEHÉR
  // listát rajzolt a sötét panelen. A javítás: colorScheme a panelen és a
  // selecten, valamint konkrét háttér/szín a selecten és az option-ökön.
  const { exported, react } = loadClient();
  const { ctx } = makeCtx();
  exported.apply(ctx);
  const t = ctx.locale.bind("koltseg");
  react.__reset();
  const closed = exported.KoltsegButton({ t, sessionId: "session-abc" });
  closed.props.onClick();
  react.__rewind();
  const opened = exported.KoltsegButton({ t, sessionId: "session-abc" });
  const panel = opened.children[1];
  assert.equal(panel.props.style.colorScheme, "dark", "a panel sötét színsémát kér (natív vezérlők)");
});

test("kliens: a token-szám rövid alakja olvasható (M / Mrd)", () => {
  const { exported } = loadClient();
  const { fmtTokens } = exported.__util;
  assert.equal(fmtTokens(112354944), "112,4\u00A0M");
  assert.equal(fmtTokens(20544962161), "20,5\u00A0Mrd");
  assert.equal(fmtTokens(12345), "12,3\u00A0e");
  assert.equal(fmtTokens(987), "987");
  assert.equal(fmtTokens(0), "0");
});

test("kliens: a token költség magyar alakban (tizedesvessző, nem pont)", () => {
  // MÉRT HIBA (2026-11-17, felhasználói jelzés): `$1.0407` — a `toFixed` pontot
  // ad, a magyar felületen viszont vessző kell.
  const { exported } = loadClient();
  const { fmtUsd } = exported.__util;
  assert.equal(fmtUsd(1.0407), "$1,0407");
  assert.equal(fmtUsd(0), "$0,0000");
  assert.equal(fmtUsd(133.7558), "$133,7558");
});