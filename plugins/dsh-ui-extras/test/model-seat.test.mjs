/**
 * A `dsh-ui-extras` **composer modellfészkének** (szolgáltató → modell) tesztje
 * böngésző nélkül.
 *
 * MIÉRT: a felhasználó 2026-11-19-én jelezte, hogy a gyári választó egyetlen
 * listába ömleszti minden szolgáltató modelljeit („nem lehet eligazodni”), és
 * kérte a kétszintű választást. A sorokat a `seatPaneRows` TISZTA függvény
 * állítja elő, ezért a viselkedés React nélkül ellenőrizhető — a stubolt
 * `react`-tel pedig azt is látjuk, hogy a zárt fészek a jelenlegi modellt írja.
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
    memo(component) { return component; },
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
}

function makeJsxRuntime() {
  const build = (type, props) => {
    const { children, ...rest } = props ?? {};
    return { type, props: rest, children: children === undefined ? [] : [].concat(children) };
  };
  return { jsx: build, jsxs: build, Fragment: "Fragment" };
}

function fakeDocument() {
  const node = { closest() { return null; }, getAttribute() { return null; } };
  return {
    querySelector() { return node; },
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
    innerWidth: 1280,
    innerHeight: 800,
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

/** Szövegek összegyűjtése (a walk() szándékosan csak objektum-csomópontokat lát). */
function collectText(node, out) {
  if (node === null || node === undefined || node === false) return;
  if (typeof node === "string") { out.push(node); return; }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return; }
  if (typeof node !== "object") return;
  if (node.props && node.props.children) collectText(node.props.children, out);
  if (node.children) collectText(node.children, out);
}

const reasoning = { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], defaultEffort: "medium" };

function state() {
  return {
    groups: [
      { id: "groq", name: "Groq", models: [{ id: "openai/gpt-oss-120b", name: "GPT OSS 120B" }] },
      {
        id: "openrouter",
        name: "OpenRouter",
        models: [
          { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5", reasoning },
          { id: "baidu/ernie-5.5-flash-preview:free", name: "Baidu: ERNIE-5.5-Flash-Preview (free)" },
        ],
      },
    ],
    current: { provider: "openrouter", model: "anthropic/claude-haiku-5.5" },
  };
}

function view() {
  const snapshot = state();
  const groups = [{ ...snapshot.groups[0] }, { ...snapshot.groups[1] }];
  return {
    groups,
    current: snapshot.current,
    reasoning,
    effort: undefined,
    effortLabel: undefined,
    modelLabel: "Anthropic: Claude Haiku 5.5",
  };
}

test("modellfészek: a szolgáltatók normalizálva, üres csoport nélkül", () => {
  const { exported } = loadBundle();
  const groups = exported.seatGroups({
    groups: [
      { id: "a", name: "A", models: [{ id: "m1", name: "M1" }] },
      { id: "empty", name: "Empty", models: [] },
      { id: "b", models: [{ id: "m2" }] },
    ],
  });
  assert.deepEqual(groups.map((g) => g.id), ["a", "b"]);
  assert.equal(groups[1].name, "b", "név nélkül az id lesz a cím");
  assert.equal(groups[1].models[0].name, "m2", "modellnév nélkül az id lesz a név");
});

test("modellfészek: a jelenlegi modell megkeresése", () => {
  const { exported } = loadBundle();
  const groups = exported.seatGroups(state());
  const hit = exported.seatCurrent(groups, state().current);
  assert.ok(hit);
  assert.equal(hit.group.id, "openrouter");
  assert.equal(hit.model.id, "anthropic/claude-haiku-5.5");
  assert.equal(exported.seatCurrent(groups, { provider: "openrouter", model: "nincs-ilyen" }), undefined);
  assert.equal(exported.seatCurrent(groups, undefined), undefined);
});

test("modellfészek: a gyökér a „Modell” sorral indul, nem a teljes listával", () => {
  const { exported } = loadBundle();
  const rows = exported.seatPaneRows("root", view());
  const kinds = rows.map((row) => row.kind);
  assert.deepEqual(kinds, ["link", "link", "note"], "Modell + Gondolkodás + súgó");
  assert.equal(rows[0].label, "Modell");
  assert.equal(rows[0].target, "providers", "a Modell sor a szolgáltató-választóra visz");
  assert.equal(rows[1].label, "Gondolkodás");
  assert.equal(rows[1].target, "effort");
  assert.ok(!rows.some((row) => row.kind === "choice"), "a gyökérben NINCS modell-sor (nincs ömlesztés)");
});

test("modellfészek: a szolgáltató-választó csak szolgáltatókat sorol, darabszámmal", () => {
  const { exported } = loadBundle();
  const rows = exported.seatPaneRows("providers", view());
  assert.equal(rows[0].kind, "back");
  const groups = rows.filter((row) => row.kind === "link");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "Groq");
  assert.equal(groups[0].value, "1 modell");
  assert.equal(groups[1].label, "OpenRouter •", "a jelenlegi szolgáltató jelölve");
  assert.equal(groups[1].value, "2 modell");
  assert.equal(groups[1].target, "provider:openrouter");
});

test("modellfészek: a szolgáltatón belül CSAK annak modelljei látszanak", () => {
  const { exported } = loadBundle();
  const rows = exported.seatPaneRows("provider:openrouter", view());
  assert.equal(rows[0].kind, "back");
  assert.equal(rows[0].target, "providers");
  assert.equal(rows[1].kind, "title");
  assert.equal(rows[1].text, "OpenRouter");
  const models = rows.filter((row) => row.kind === "choice");
  assert.deepEqual(models.map((row) => row.label), [
    "Anthropic: Claude Haiku 5.5",
    "Baidu: ERNIE-5.5-Flash-Preview (free)",
  ]);
  assert.ok(!models.some((row) => /GPT OSS/.test(row.label)), "a másik szolgáltató modellje NEM szivárog be");
  assert.equal(models[0].selected, true, "a jelenlegi modell pipálva");
  assert.deepEqual(models[1].selection, { provider: "openrouter", model: "baidu/ernie-5.5-flash-preview:free" });

  const groq = exported.seatPaneRows("provider:groq", view());
  const groqModels = groq.filter((row) => row.kind === "choice");
  assert.deepEqual(groqModels.map((row) => row.label), ["GPT OSS 120B"]);
});

test("modellfészek: az effort lista a kiválasztott modell szintjeit adja", () => {
  const exported = loadBundle().exported;
  const rows = exported.seatPaneRows("effort", view());
  assert.equal(rows[0].kind, "back");
  const choices = rows.filter((row) => row.kind === "choice");
  assert.deepEqual(choices.map((row) => row.label), ["Low", "High"]);
  assert.equal(choices[0].selection.reasoningEffort, "low");
});

test("modellfészek: hiba esetén LÁTSZÓ tartalék marad (nem tűnik el a választó)", () => {
  const { exported, react } = loadBundle();
  const savedDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    react.__reset();
    const broken = {
      available: true,
      directory: {
        getSnapshot() { throw new Error("szándékos hiba a tesztben"); },
        subscribe() { return () => {}; },
      },
      load() {},
      select: () => Promise.resolve(true),
    };
    let tree;
    assert.doesNotThrow(() => {
      tree = exported.ModelSeat(broken);
    }, "a fészek NEM dobhat kivételt (különben eltűnik a compose-ból)");
    // A tartalék SZÁNDÉKOSAN külön komponens (hook-ütközés miatt) — a stubolt
    // React nem rendereli a komponenseket, ezért itt hívjuk meg.
    const rendered = tree && typeof tree.type === "function" ? tree.type(tree.props) : tree;
    const texts = [];
    collectText(rendered, texts);
    assert.ok(texts.length > 0 && texts.some((text) => text.length > 0), `a tartalék felirat látszik: ${texts.join(" | ")}`);
    assert.ok(!texts.some((text) => /Anthropic|Claude/i.test(text)), "hibánál nincs modellnév, csak tartalék felirat");
  } finally {
    globalThis.document = savedDocument;
  }
});

test("modellfészek: a zárt fészek a jelenlegi modellt írja, alügynök-sessionben nincs", () => {
  const { exported, react } = loadBundle();
  const savedDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    react.__reset();
    const store = { getSnapshot: () => state(), subscribe: () => () => {} };
    const tree = exported.ModelSeat({
      available: true,
      directory: store,
      load() {},
      select: () => Promise.resolve(true),
      t: (key) => String(key),
    });
    const texts = [];
    walk(tree, (node) => {
      if (typeof node === "string") texts.push(node);
      if (node && node.children) {
        for (const child of node.children) if (typeof child === "string") texts.push(child);
      }
    });
    const flat = texts.join(" | ");
    assert.ok(/Anthropic: Claude Haiku 5.5/.test(flat), `a fészek a jelenlegi modellt írja: ${flat}`);

    react.__reset();
    const hidden = exported.ModelSeat({ available: false, directory: store, load() {}, select: () => Promise.resolve(true) });
    assert.equal(hidden, null, "alügynök-sessionben a fészek nem renderel (mint a gyári)");
  } finally {
    globalThis.document = savedDocument;
  }
});
