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

const CLIENT_PATH = join(process.cwd(), "plugins", "dsh-devadmin", "lib", "client.js");

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
  assert.equal(typeof exported.DevAdminPanel, "function");
  assert.equal(typeof exported.AdminChip, "function");
});

test("az apply regisztralja a tab tipust, a tab testet es a dokk-chipet", async () => {
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
  assert.equal(bodies.length, 2, "tab test + dokk-chip");
  assert.ok(bodies.some((entry) => entry.key === "dsh-devadmin/admin"), "a tab test kulcsa az id");
  assert.ok(bodies.some((entry) => entry.id === "devadmin-admin"), "a dokk-chip id-ja");
  assert.deepEqual(injections.sort(), ["conversation.input.dock", "sidebar.right.pane.tab"]);
  assert.equal(opened.length, 0, "az apply magatol nem nyit tabot");

  // a chip megnyitja a tabot, ha rakerul a kliens
  const chip = bodies.find((entry) => entry.id === "devadmin-admin");
  const rendered = chip.component({});
  assert.equal(rendered.type, exported.AdminChip, "a chip a sajat komponenset rajzolja");
  assert.equal(typeof rendered.props.openTab, "function", "a chip megkapja a tab-nyitot");
  rendered.props.openTab();
  assert.deepEqual(opened, ["devadmin"]);
});
