/**
 * A KLIENS fél füsttesztje böngésző nélkül.
 *
 * Miért: a bundle a WebView2-ben fut, ott hibát csak a felhasználó látna. Itt
 * stuboljuk a `window.__ModuleLoader__`-t és a `react`-et, majd végigfuttatjuk a
 * `factory`-t, az `apply(ctx)`-et (regisztrációk) és a panel renderelését — így a
 * tipikus hibák (hiányzó konstans, elírt slot-név, üres props) még a panel
 * újratöltése ELŐTT kiderülnek.
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
    memo(component) {
      return component;
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) {
        hooks[index] = typeof initial === "function" ? initial() : initial;
      }
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
    /** A render előtt nullázza a hook-tárat (mint egy friss render). */
    __reset() {
      hooks = [];
      cursor = 0;
    },
  };
  return react;
}

function loadClient() {
  let definition = null;
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // A bundle a `window.__ModuleLoader__.load({...})` hívásra épül.
  const loader = { load(def) { definition = def; } };
  const runner = new Function("window", "module", "exports", "require", `${source}\n`);
  const fakeModule = { exports: {} };
  const react = makeReact();
  const fakeRequire = (name) => {
    if (name === "react") return react;
    throw new Error(`ismeretlen require: ${name}`);
  };
  runner({ __ModuleLoader__: loader }, fakeModule, fakeModule.exports, fakeRequire);
  if (!definition) throw new Error("a bundle nem hívta a __ModuleLoader__.load-ot");
  const exported = definition.factory(fakeRequire);
  return { exported, react };
}

function makeCtx() {
  const calls = { tabs: [], slots: [], locale: [] };
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
          const template = pack && pack.packs && pack.packs.hu && pack.packs.hu[key];
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
    sidebarRightTabs: {
      register(meta) {
        calls.tabs.push(meta);
        return () => {};
      },
    },
    sidebarRight: { openTab(kind) { calls.tabs.push({ opened: kind }); } },
  };
  return { ctx, calls };
}

test("kliens: a bundle betölt, a fül/fejléc/panel regisztrálódik", () => {
  const { exported } = loadClient();
  assert.equal(exported.name, "dsh-ftp-deploy");
  assert.ok(Array.isArray(exported.inject));
  for (const dep of ["slots", "locale", "sidebarRightTabs", "sidebarRight"]) {
    assert.ok(exported.inject.includes(dep), `${dep} kell az inject listára`);
  }

  const { ctx, calls } = makeCtx();
  exported.apply(ctx);

  const tab = calls.tabs.find((entry) => entry && entry.kind === "ftp");
  assert.ok(tab, "a tab típus regisztrálva (kind: ftp)");
  assert.equal(tab.id, "dsh-ftp-deploy/ftp");
  assert.equal(typeof tab.title, "function");
  assert.equal(tab.title(), "FTP deploy");

  const body = calls.slots.find((entry) => entry.name === "sidebar.right.pane.tab");
  assert.ok(body, "a tab törzs a sidebar.right.pane.tab slotban");
  assert.equal(body.registration.meta.key, "dsh-ftp-deploy/ftp");
  assert.equal(typeof body.registration.component, "function");

  const header = calls.slots.find((entry) => entry.name === "conversation.session.header.utilities");
  assert.ok(header, "a fejléc-ikon a conversation.session.header.utilities slotban");
  assert.equal(header.registration.meta.id, "ftp-deploy-header");
  assert.equal(header.registration.meta.order, 62);
  assert.equal(typeof header.registration.meta.inject, "function");
});

test("kliens: a szótár hu és en kulcsai egyeznek", () => {
  const { exported } = loadClient();
  const { ctx, calls } = makeCtx();
  exported.apply(ctx);
  const pack = calls.locale[0];
  assert.equal(pack.ns, "ftp");
  const hu = Object.keys(pack.packs.hu).sort();
  const en = Object.keys(pack.packs.en).sort();
  assert.deepEqual(en, hu, "a két nyelv kulcshalmaza azonos");
  assert.ok(hu.length > 50, "van elég szöveg");
});

test("kliens: a panel renderel profile nélkül és profillal (nincs kivétel)", () => {
  const { exported, react } = loadClient();
  const { ctx, calls } = makeCtx();
  exported.apply(ctx);
  const body = calls.slots.find((entry) => entry.name === "sidebar.right.pane.tab");
  const Panel = body.registration.component;
  const t = ctx.locale.bind("ftp");

  react.__reset();
  const emptyTree = Panel({ t });
  assert.ok(emptyTree, "üres állapotban is van mit renderelni (nem null)");

  react.__reset();
  const withProfile = Panel({
    t,
    profile: {
      id: "proba",
      name: "Próba",
      host: "h",
      port: 21,
      user: "u",
      localRoot: "C:\\x",
      remoteRoot: "/web/x",
      include: ["app"],
      extraUpload: [],
      allow: [],
      hasPassword: true,
    },
  });
  assert.ok(withProfile, "profillal is renderel");
});

test("kliens: a fejléc-gomb kattintása megnyitja a fület", () => {
  const { exported } = loadClient();
  const { ctx, calls } = makeCtx();
  exported.apply(ctx);
  const header = calls.slots.find((entry) => entry.name === "conversation.session.header.utilities");
  const opened = [];
  ctx.sidebarRight.openTab = (kind) => opened.push(kind);
  const props = header.registration.meta.inject();
  assert.equal(typeof props.openTab, "function");
  props.openTab();
  assert.deepEqual(opened, ["ftp"]);
});
