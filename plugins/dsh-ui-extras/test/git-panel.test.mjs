/**
 * A `dsh-ui-extras` **Git panel** füsttesztje böngésző nélkül.
 *
 * MIÉRT: ez a panel kétszer szállt el egy-egy szerkesztés után
 * (`action.status` null-on, illetve `ftpProfile is not defined`), és a hiba csak
 * a felhasználónál, a felületen derült ki. A bundle-t stubolt `react`-tel,
 * `jsx-runtime`-tal és `fetch`-csel betöltve a panel renderelése itt fut le —
 * így az ilyen scope-/null-hibák a betöltés előtt kiderülnek.
 *
 * A teszt NEM helyettesíti a böngészőt: a hálózatot (fetch) nem hívja, csak
 * annyit ellenőriz, hogy a renderelés nem dob kivételt, és a várt elemek
 * (Git fejléc, akciósor, FTP blokk) előállnak.
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

/** `react/jsx-runtime` stub: a `jsx`/`jsxs` ugyanazt adja, mint a createElement. */
function makeJsxRuntime(react) {
  const build = (type, props) => {
    const { children, ...rest } = props ?? {};
    return { type, props: rest, children: children === undefined ? [] : [].concat(children) };
  };
  return { jsx: build, jsxs: build, Fragment: "Fragment" };
}

function loadBundle() {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let definition = null;
  const react = makeReact();
  const jsx = makeJsxRuntime(react);
  const fakeWindow = {
    __ModuleLoader__: { load(def) { definition = def; } },
    location: { pathname: "/", reload() {}, search: "" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  const fakeRequire = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react-dom") return { createRoot: () => ({ render() {}, unmount() {} }), render() {} };
    throw new Error(`ismeretlen require: ${name}`);
  };
  // A bundle a `window`-ra és a `fetch`-re támaszkodik: a valódi globálisokat
  // ideiglenesen kicseréljük, majd visszaállítjuk.
  const saved = { window: globalThis.window, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  globalThis.window = fakeWindow;
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
    globalThis.fetch = saved.fetch;
    globalThis.localStorage = saved.localStorage;
  }
}

/** A render közben összegyűlt szövegből kikereshető, hogy mely elemek vannak meg. */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out; }
  if (typeof node === "object") {
    if (node.props && node.props.children) collectText(node.props.children, out);
    for (const child of node.children ?? []) collectText(child, out);
  }
  return out;
}

test("ui-extras: a Git panel renderel (nincs referencia-hiba)", () => {
  const { exported, react } = loadBundle();
  assert.equal(typeof exported.GitPanel, "function", "a GitPanel exportálva van a teszthez");

  const t = (key, values) => (values ? String(key) + JSON.stringify(values) : String(key));
  react.__reset();
  const tree = exported.GitPanel({ t, root: "D:\\Herd\\termeszetgyogyaszoktatas-L12" });
  assert.ok(tree, "a panel ad fát");
  const text = collectText(tree).join(" | ");
  // Betöltés közben a panel fejléce és a GitHub szekció látszik. Az FTP BLOKK
  // viszont a render törzsében, minden állapotban kiértékelődik — ezért a
  // scope-hiba (`ftpProfile is not defined`) itt már elbukna.
  assert.match(text, /gitTitle/, "a panel fejléce megjelenik");
});

test("ui-extras: a Git panel renderel profil nélküli munkaterületre is", () => {
  const { exported, react } = loadBundle();
  const t = (key) => String(key);
  react.__reset();
  const tree = exported.GitPanel({ t, root: "" });
  assert.ok(tree, "üres gyökérrel is renderel (nincs kivétel)");
});
