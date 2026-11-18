/**
 * A `dsh-ui-extras` **munkamenet-emlékezetének** tesztje böngésző nélkül.
 *
 * MIÉRT: 2026-11-18-án a felhasználó jelezte, hogy a DSH leállítása és indítása
 * után MINDEN panel üres beszélgetésre ("Az ismeretlenbe") esett, egyik sem
 * pozícionált vissza a munkamenetére. A kliensben nincs rá perzisztencia (a
 * `dsh-client-ui-workspace` bootja a `recentWorkspace()`-re esik és üres
 * sessiont nyit), ezért a plugin panelekent megjegyzi az utolsó valódi
 * beszélgetést (localStorage, panelekent külön WebView2-profil) és
 * oldalbetöltésenként egyszer visszaállítja.
 *
 * A teszt a valódi bundlet tölti be stubolt `window`/`react` mellett, és a
 * visszaállítás SZABÁLYAIT ellenőrzi: valódi session mentése, egyszeri
 * visszaállítás, üres session soha nem lesz emlékezet, archívumot nem nyitunk,
 * és a próbák száma kötött (§1.7).
 *
 * Futtatás (a sandbox miatt NEM `node --test`, mert az gyermekfolyamatot indít
 * pipával): `node plugins\dsh-ui-extras\test\session-memory.test.mjs`
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
    __reset() { hooks = []; cursor = 0; }
  };
}

function makeJsxRuntime() {
  const build = (type, props) => {
    const { children, ...rest } = props ?? {};
    return { type, props: rest, children: children === undefined ? [] : [].concat(children) };
  };
  return { jsx: build, jsxs: build, Fragment: "Fragment" };
}

function makeStorage(seed) {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); }
  };
}

/** Betölti a valódi bundlet a stubolt környezetben. */
function loadBundle(seed, timers) {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let definition = null;
  const storage = makeStorage(seed);
  const fakeWindow = {
    __ModuleLoader__: { load(loaded) { definition = loaded; } },
    location: { pathname: "/", reload() {}, search: "" },
    localStorage: storage,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  };
  const reactDom = {
    createPortal(children, container) { return { __portal: true, children, container }; },
    createRoot: () => ({ render() {}, unmount() {} }),
    render() {}
  };
  const fakeRequire = (name) => {
    if (name === "react") return makeReact();
    if (name === "react/jsx-runtime") return makeJsxRuntime();
    if (name === "react-dom") return reactDom;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return {};
    throw new Error(`ismeretlen require: ${name}`);
  };
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage
  };
  globalThis.window = fakeWindow;
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { hasAttribute: () => false, appendChild() {} },
    documentElement: { lang: "hu" },
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, style: {}, appendChild() {}, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.localStorage = storage;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const runner = new Function("window", "module", "exports", "require", "fetch", `${source}\n`);
    const fakeModule = { exports: {} };
    runner(fakeWindow, fakeModule, fakeModule.exports, fakeRequire, globalThis.fetch);
    if (!definition) throw new Error("a bundle nem hívta a __ModuleLoader__.load-ot");
    return { exported: definition.factory(fakeRequire), storage };
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.fetch = saved.fetch;
    globalThis.localStorage = saved.localStorage;
  }
}

/** Egy fake store a `sessions.list` / `workspaces.list` alakjában. */
function makeStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    }
  };
}

/** A session-szolgáltatás (a `ctx.sessions`) minimális alakja. */
function makeSessionService(snapshot) {
  return { list: makeStore(snapshot) };
}

/** A workspace-szolgáltatás (a `ctx.workspaces`) minimális alakja. */
function makeWorkspaceService(archivedSessionIds) {
  return { list: makeStore({ phase: "ready", items: [], archivedSessionIds: archivedSessionIds ?? [] }) };
}

function makeContext({ sessions, workspaces, opened, settle }) {
  return {
    sessions,
    workspaces,
    uiWorkspace: {
      openSession(id) {
        opened.push(id);
        // A valódi kliensben a megnyitás beállítja a `current`-et, ezért a
        // további próbák már lezárnak. A fake store-ban ezt itt utánozzuk.
        if (typeof settle === "function") settle(id);
      }
    },
    effect(callback) { return callback(); }
  };
}

/** A kötött időzített próbák lefuttatása, növekvő sorrendben. */
function flushTimers(timers) {
  const pending = [...timers].sort((left, right) => left.ms - right.ms);
  timers.length = 0;
  for (const entry of pending) entry.fn();
}

const OLD = "session-old-0001";
const BLANK = "session-blank-0001";
const NOW = "session-now-0001";

function bootSnapshot(current, byId) {
  return { phase: "ready", current, byId };
}

test("session memory: a boot üres sessionje helyett a mentett beszélgetést nyitja meg", () => {
  const timers = [];
  const { exported, storage } = loadBundle(
    { "dsh-ui-extras.last-session": JSON.stringify({ id: OLD, cwd: "D:\\Szerver\\Antikolt", at: 1 }) },
    timers
  );
  const memory = exported.__sessionMemory;
  assert.equal(typeof memory.install, "function", "a bundle exportálja a munkamenet-emlékezetet");

  const opened = [];
  const summaries = {
    [BLANK]: { id: BLANK, blank: true, cwd: "D:\\Szerver\\Antikolt" },
    [OLD]: { id: OLD, blank: false, cwd: "D:\\Szerver\\Antikolt" }
  };
  const sessions = makeSessionService(bootSnapshot(BLANK, summaries));

  memory.install(makeContext({
    sessions,
    workspaces: makeWorkspaceService(),
    opened,
    settle(id) { sessions.list.set(bootSnapshot(id, summaries)); }
  }));
  assert.equal(timers.length, memory.delays.length, "annyi időzített próba van, amennyi a kötött lista");
  flushTimers(timers);

  assert.deepEqual(opened, [OLD], "a mentett sessiont megnyitja az üres helyett");
  assert.equal(memory.read().id, OLD, "az emlékezet a mentett beszélgetés marad");
  assert.equal(JSON.parse(storage.getItem(memory.key)).id, OLD);
});

test("session memory: valódi beszélgetésnél ment, és nem navigál", () => {
  const timers = [];
  const { exported } = loadBundle({ "dsh-ui-extras.last-session": JSON.stringify({ id: OLD, cwd: "", at: 1 }) }, timers);
  const memory = exported.__sessionMemory;

  const opened = [];
  const sessions = makeSessionService(bootSnapshot(NOW, {
    [OLD]: { id: OLD, blank: false, cwd: "D:\\Szerver\\Antikolt" },
    [NOW]: { id: NOW, blank: false, cwd: "D:\\Szerver\\Video" }
  }));

  memory.install(makeContext({ sessions, workspaces: makeWorkspaceService(), opened }));
  flushTimers(timers);

  assert.deepEqual(opened, [], "a megnyitott valódi beszélgetéshez nem nyúl");
  assert.equal(memory.read().id, NOW, "az új session lesz az emlékezet");
  assert.equal(memory.read().cwd, "D:\\Szerver\\Video", "a munkaterület is vele megy");
});

test("session memory: üres sessiont SOHA nem ment el", () => {
  const timers = [];
  const { exported } = loadBundle({}, timers);
  const memory = exported.__sessionMemory;

  const opened = [];
  const sessions = makeSessionService(bootSnapshot(BLANK, {
    [BLANK]: { id: BLANK, blank: true, cwd: "D:\\Szerver\\Antikolt" }
  }));

  memory.install(makeContext({ sessions, workspaces: makeWorkspaceService(), opened }));
  flushTimers(timers);

  assert.deepEqual(opened, []);
  assert.equal(memory.read(), null, "az üres session nem lesz visszatérési hely");
});

test("session memory: archívált sessiont nem nyit meg", () => {
  const timers = [];
  const { exported } = loadBundle({ "dsh-ui-extras.last-session": JSON.stringify({ id: OLD, cwd: "", at: 1 }) }, timers);
  const memory = exported.__sessionMemory;

  const opened = [];
  const sessions = makeSessionService(bootSnapshot(BLANK, {
    [BLANK]: { id: BLANK, blank: true, cwd: "D:\\Szerver\\Antikolt" },
    [OLD]: { id: OLD, blank: false, cwd: "D:\\Szerver\\Antikolt" }
  }));

  memory.install(makeContext({ sessions, workspaces: makeWorkspaceService([OLD]), opened }));
  flushTimers(timers);
  assert.deepEqual(opened, [], "az archivált sessiont nem nyitja meg");
});

test("session memory: a már nem létező sessionre nem navigál", () => {
  const timers = [];
  const { exported } = loadBundle({ "dsh-ui-extras.last-session": JSON.stringify({ id: "session-gone", cwd: "", at: 1 }) }, timers);
  const memory = exported.__sessionMemory;

  const opened = [];
  const sessions = makeSessionService(bootSnapshot(BLANK, {
    [BLANK]: { id: BLANK, blank: true, cwd: "D:\\Szerver\\Antikolt" }
  }));

  memory.install(makeContext({ sessions, workspaces: makeWorkspaceService(), opened }));
  flushTimers(timers);
  assert.deepEqual(opened, [], "a listában nem szereplő sessionre nincs nyitási kísérlet");
});

test("session memory: a nyitási próbák száma kötött (§1.7)", () => {
  const timers = [];
  const { exported } = loadBundle({ "dsh-ui-extras.last-session": JSON.stringify({ id: OLD, cwd: "", at: 1 }) }, timers);
  const memory = exported.__sessionMemory;

  const opened = [];
  const sessions = makeSessionService(bootSnapshot(BLANK, {
    [BLANK]: { id: BLANK, blank: true, cwd: "D:\\Szerver\\Antikolt" },
    [OLD]: { id: OLD, blank: false, cwd: "D:\\Szerver\\Antikolt" }
  }));

  memory.install(makeContext({ sessions, workspaces: makeWorkspaceService(), opened }));
  flushTimers(timers);

  assert.equal(opened.length, memory.maxOpen, "legfeljebb maxOpen próbálkozás történik");
  assert.ok(memory.maxOpen <= 3, "a plafon kicsi és kötött");
  assert.ok(memory.delays.length >= 2 && memory.delays.length <= 6, "néhány, növekvő várakozású próba");
  for (let index = 1; index < memory.delays.length; index++) {
    assert.ok(memory.delays[index] > memory.delays[index - 1], "a várakozás növekszik");
  }
});

test("session memory: uiWorkspace nélkül a sessions.open a tartalék", () => {
  const timers = [];
  const { exported } = loadBundle({ "dsh-ui-extras.last-session": JSON.stringify({ id: OLD, cwd: "", at: 1 }) }, timers);
  const memory = exported.__sessionMemory;

  const opened = [];
  const summaries = {
    [BLANK]: { id: BLANK, blank: true, cwd: "D:\\Szerver\\Antikolt" },
    [OLD]: { id: OLD, blank: false, cwd: "D:\\Szerver\\Antikolt" }
  };
  const sessions = makeSessionService(bootSnapshot(BLANK, summaries));
  sessions.open = (id) => {
    opened.push(id);
    sessions.list.set(bootSnapshot(id, summaries));
  };

  memory.install({ sessions, workspaces: makeWorkspaceService(), effect(callback) { return callback(); } });
  flushTimers(timers);

  assert.deepEqual(opened, [OLD], "a sessions.open út is működik");
});

test("session memory: a lista későbbi feltöltődése is visszaállít (boot-verseny)", () => {
  const timers = [];
  const { exported } = loadBundle({ "dsh-ui-extras.last-session": JSON.stringify({ id: OLD, cwd: "", at: 1 }) }, timers);
  const memory = exported.__sessionMemory;

  const opened = [];
  const sessions = makeSessionService({ phase: "loading", current: undefined, byId: {} });

  memory.install(makeContext({ sessions, workspaces: makeWorkspaceService(), opened }));
  flushTimers(timers);
  assert.deepEqual(opened, [], "amíg a lista nem kész, nem nyitunk");

  // A boot befejezi a listát, és üres sessiont állít be: a feliratkozás útján
  // ilyenkor is vissza kell állnia a mentett beszélgetésnek.
  sessions.list.set(bootSnapshot(BLANK, {
    [BLANK]: { id: BLANK, blank: true, cwd: "D:\\Szerver\\Antikolt" },
    [OLD]: { id: OLD, blank: false, cwd: "D:\\Szerver\\Antikolt" }
  }));

  assert.deepEqual(opened, [OLD], "a lista készenléte után visszaáll a mentett session");
});
