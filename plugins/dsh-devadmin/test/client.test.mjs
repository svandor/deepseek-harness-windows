/**
 * A `dsh-devadmin` KLIENS bundle tesztje — bongeszo es harness NELKUL.
 *
 * A bundle nem ES-modul: a `window.__ModuleLoader__.load({id, factory})` hivast
 * varja. A teszt eloallit egy minimalis `window`-t, elkapja a definition-t,
 * lefuttatja a factory-t egy kamu `require`-rel, majd az `apply`-t egy kamu
 * kliens-kontextussal — igy a regisztraciok szama es neve ellenorizheto.
 *
 * Futtatas: node --test plugins/dsh-devadmin/test/client.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CLIENT_PATH = join(process.cwd(), "plugins", "dsh-devadmin", "lib", "client.js");
const source = readFileSync(CLIENT_PATH, "utf8");

/** A felso menusor rekesze, ahova az ikonnak kerulnie kell. */
const HEADER_SLOT = "conversation.session.header.utilities";

/** Minimalis React: csak azt adja, amit a bundle a betolteskor hasznal. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: "Fragment",
};

function fakeRequire(specifier) {
  if (specifier === "react") return fakeReact;
  if (specifier === "react/jsx-runtime") return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement };
  throw new Error(`varatlan require: ${specifier}`);
}

async function loadFactory() {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  };
  await import(`${pathToFileURL(CLIENT_PATH).href}?t=${Date.now()}`);
  assert.ok(captured, "a bundle nem hivta a window.__ModuleLoader__.load-ot");
  return captured;
}

test("a bundle a sajat id-jével regisztral a modul-loaderbe", async () => {
  const definition = await loadFactory();
  assert.equal(definition.id, "dsh-devadmin");
  assert.equal(typeof definition.factory, "function");
});

test("a factory a szukseges exportokat adja vissza", async () => {
  const definition = await loadFactory();
  const exported = definition.factory(fakeRequire);
  assert.equal(typeof exported.apply, "function");
  assert.ok(Array.isArray(exported.inject));
  for (const service of ["slots", "sidebarRightTabs", "sidebarRight"]) {
    assert.ok(exported.inject.includes(service), `hianyzik az inject: ${service}`);
  }
  assert.equal(exported.TAB_KIND, "devadmin");
  assert.equal(exported.HEADER_SLOT, HEADER_SLOT);
  assert.equal(typeof exported.DevAdminPanel, "function");
  assert.equal(typeof exported.AdminHeaderButton, "function");
});

test("az apply regisztralja a tab tipust, a tab testet es a fejlec-ikont", async () => {
  const definition = await loadFactory();
  const exported = definition.factory(fakeRequire);

  const registered = [];
  const injections = [];
  const opened = [];
  const ctx = {
    effect(fn) {
      return fn();
    },
    slots: {
      inject(name, callback) {
        injections.push(name);
        return callback();
      },
      register(definition2, component) {
        registered.push({ name: definition2.name, key: definition2.key, id: definition2.id, component });
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(tabDefinition) {
        registered.push({ tab: tabDefinition });
        return () => {};
      },
    },
    sidebarRight: {
      openTab(kind) {
        opened.push(kind);
      },
    },
  };

  exported.apply(ctx);

  const tabTypes = registered.filter((entry) => entry.tab);
  assert.equal(tabTypes.length, 1, "egy tab tipus kell");
  assert.equal(tabTypes[0].tab.kind, "devadmin");
  assert.equal(tabTypes[0].tab.priority, "extension");

  const bodies = registered.filter((entry) => !entry.tab);
  // A munkaasztal-ikonok feltetelesen (host valasz utan) regisztralodnak, ezert
  // a szinkron regisztraciok szama 2; a harmadik kulon ellenorzes.
  assert.equal(bodies.length, 2, "tab test + fejlec-ikon (a munkaasztal-valto async)");
  assert.ok(bodies.some((entry) => entry.key === "dsh-devadmin/admin"), "a tab test kulcsa az id");

  const header = bodies.find((entry) => entry.id === "devadmin-header");
  assert.ok(header, "a fejlec-ikon regisztralva van");
  assert.equal(header.name, HEADER_SLOT, "az ikon a felso menusor rekeszebe kerul");
  assert.ok(
    !bodies.some((entry) => entry.name === "conversation.input.dock" || entry.name === "conversation.composer.dock"),
    "a cset felett NEM jelenik meg semmi",
  );

  assert.ok(source.includes("devadmin-desktop"), "a munkaasztal-valto forrasban ott van (async regisztracio)");
  assert.equal(injections.filter((name) => name === HEADER_SLOT).length, 1, "egy szinkron fejlec-regisztracio (a valto async)");
  assert.deepEqual([...new Set(injections)].sort(), [HEADER_SLOT, "sidebar.right.pane.tab"].sort());
  assert.equal(opened.length, 0, "az apply magatol nem nyit tabot");

  // az ikon megnyitja a tabot
  const rendered = header.component({ openTab: () => opened.push("devadmin") });
  assert.equal(rendered.type, "button");
  assert.equal(rendered.props["aria-label"], "PHP admin");
  rendered.props.onClick();
  assert.deepEqual(opened, ["devadmin"]);

  // es van benne ikon (svg), de NINCS felirat — a menüsor gombjai ikonok
  const kids = (rendered.children || []).filter(Boolean);
  assert.ok(kids.some((child) => child && child.type === "svg"), "van SVG ikon");
  assert.equal(kids.length, 1, "csak az ikon: nincs PHP felirat, a nev a tooltipben van");
  assert.match(rendered.props.title, /PHP admin/u, "a tooltip nevezi meg a gombot");
});
