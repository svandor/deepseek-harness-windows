/**
 * A HOST fél füsttesztje a web-szerver nélkül.
 *
 * Miért: a végpontok a harness következő indításakor élnek, ezért a telepítés
 * pillanatában senki nem látná, ha egy útvonal elírva vagy a handler hibára fut.
 * Itt stuboljuk a `webServer`-t, regisztráljuk az útvonalakat, majd a valódi
 * handlereket hívjuk meg (`/koltseg/ping`, `/koltseg/config`, `/koltseg/measure`)
 * — a mérés a VALÓDI naplókon fut.
 *
 * FONTOS: az állapotkönyvtár ideiglenes (`DSH_KOLTSEG_STATE_DIR`), különben a
 * teszt a valódi `state\koltseg.log`-ba írna, és a napló alapján nem lehetne
 * megkülönböztetni a tesztet egy éles host-indulástól (ez pontosan megtévesztette
 * a 2026-11-17-i vizsgálatot).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(join(tmpdir(), "koltseg-host-"));
process.env.DSH_KOLTSEG_STATE_DIR = stateDir;
const host = await import("../lib/index.js");

function makeCtx() {
  const routes = new Map();
  const ctx = {
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } },
    effect(fn) { return typeof fn === "function" ? fn() : undefined; },
    get(name) { return name === "workspaceRegistry" ? undefined : undefined; },
  };
  return { ctx, routes };
}

/** Egy kérés, ami GET (nincs test) — a handlerek a `req.url`-t olvassák. */
function makeReq(url, method = "GET") {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.destroy = () => {};
  return req;
}

/** Egy válasz, ami összegyűjti a státuszt és a testet. */
function makeRes() {
  let finish = () => {};
  const done = new Promise((resolve) => { finish = resolve; });
  const res = {
    status: 0,
    headers: {},
    body: "",
    done,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(text) {
      this.body = typeof text === "string" ? text : String(text ?? "");
      finish();
    },
  };
  return res;
}

async function call(routes, url, method = "GET") {
  const handler = routes.get(url.split("?")[0]);
  assert.ok(handler, `van route: ${url}`);
  const res = makeRes();
  await handler(makeReq(url, method), res);
  // A host a handlert ígérettel futtatja: a válasz aszinkron is íródhat.
  await Promise.race([res.done, new Promise((resolve) => setTimeout(resolve, 20000))]);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { res, json };
}

test("host: a deklarált inject lista és a fallback-ek", () => {
  assert.deepEqual(host.inject, ["webServer"]);
  assert.equal(typeof host.apply, "function");
  assert.equal(host.STATE_DIR, stateDir, "a teszt az ideiglenes állapotkönyvtárat használja");
  assert.ok(host.REPO_ROOT.length > 0);
});

test("host: minden végpont regisztrálódik (a web-szerver jelenlétében)", () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  for (const path of [
    "/koltseg/ping",
    "/koltseg/config",
    "/koltseg/workspaces",
    "/koltseg/sessions",
    "/koltseg/measure",
    "/koltseg/export",
    "/koltseg/activity",
    "/koltseg/log",
    "/koltseg/ledger",
  ]) {
    assert.equal(typeof routes.get(path), "function", `${path} regisztrálva`);
  }
});

test("host: web-szerver nélkül nem regisztrál (nincs kivétel)", () => {
  assert.equal(host.apply({}), undefined);
  assert.equal(host.apply({ webServer: undefined, effect() {} }), undefined);
});

test("host: a /koltseg/ping életjelet ad", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const { res, json } = await call(routes, "/koltseg/ping");
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.version.length > 0, true);
  assert.match(json.configPath, /koltseg[\\/]config\.json$/u);
  assert.match(json.today, /^\d{4}-\d{2}-\d{2}$/u);
});

test("host: a /koltseg/config a 12 500 Ft-os alapot és a 4 profilt adja", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const { json } = await call(routes, "/koltseg/config");
  assert.equal(json.ok, true);
  assert.equal(json.config.defaultRate, 12500);
  assert.equal(json.config.defaultProfile, "alap");
  assert.equal(json.profiles.length, 4);
  assert.ok(json.profiles.some((profile) => profile.id === "alap"));
  assert.equal(json.resolved.rate, 12500);
});

test("host: a /koltseg/measure valódi naplókon számol", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const { res, json } = await call(routes, "/koltseg/measure?scope=workspace&days=1");
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.scope, "workspace");
  assert.equal(json.rate, 12500);
  assert.equal(typeof json.components.agentMs, "number");
  assert.ok(json.components.agentMs >= 0);
  assert.ok(json.minutes >= 0);
  assert.ok(json.amount.net >= 0);
  assert.equal(Array.isArray(json.sessions), true);
  assert.equal(Array.isArray(json.notes), true);
  assert.ok(json.profile.id.length > 0);
  // A host a saját motorjának build-jelét is kiadja (2026-11-17): a panel ebből
  // látja, hogy a futó harness még a régi motort futtatja-e.
  assert.equal(typeof json.engine, "string");
  assert.match(json.engine, /^\d{4}-\d{2}-\d{2}\.\d+$/u);
});

test("host: a munkafolyamat-hatókör azonosító nélkül 400-at ad", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const { res, json } = await call(routes, "/koltseg/measure?scope=session");
  assert.equal(res.status, 400);
  assert.equal(json.ok, false);
  assert.match(json.error, /hiányzó id/u);
});

test("host: ismeretlen munkafolyamat azonosítóra üres, de érvényes mérés jön", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const { json } = await call(routes, "/koltseg/measure?scope=session&id=session-nincs-ilyen&days=2");
  assert.equal(json.ok, true);
  assert.equal(json.sessions.length, 0);
  assert.equal(json.amount.net, 0);
  assert.ok(json.notes.some((note) => note.includes("nem található")));
});

test("host: az ismételt mérés gyorsítótárból jön (a panel nem számol újra)", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const url = "/koltseg/measure?scope=workspace&days=3";
  const first = await call(routes, url);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.cached === true, false, "az első hívás még számol");
  const second = await call(routes, url);
  assert.equal(second.json.ok, true);
  assert.equal(second.json.cached, true, "a második hívás a gyorsítótárból jön");
  assert.equal(typeof second.json.cachedAt, "number");
  // `fresh=1` megkerüli (a „Frissítés” gomb útja).
  const fresh = await call(routes, url + "&fresh=1");
  assert.equal(fresh.json.ok, true);
  assert.equal(fresh.json.cached === true, false, "a fresh=1 újraszámol");
});

test("host: a munkaterületet a session naplófejlécéből oldja fel (nem a host cwd-jéből)", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);

  // 1) egy létező munkaterület és session a valódi naplókból
  const workspaces = await call(routes, "/koltseg/workspaces");
  assert.equal(workspaces.json.ok, true);
  const first = workspaces.json.workspaces[0];
  assert.ok(first && typeof first.path === "string" && first.path.length > 0, "van munkaterület a naplókban");

  const sessions = await call(routes, "/koltseg/sessions?workspace=" + encodeURIComponent(first.path));
  assert.equal(sessions.json.ok, true);
  const session = sessions.json.sessions[0];
  assert.ok(session && typeof session.id === "string", "van session a munkaterületen");

  // 2) CSAK a session-azonosítót adjuk át: a munkaterületet a host oldja fel
  const measured = await call(routes, "/koltseg/measure?scope=session&id=" + encodeURIComponent(session.id));
  assert.equal(measured.json.ok, true);
  // Windows alatt az útvonal kis/nagybetűre érzéketlen: a pontos sztring-
  // egyezés párhuzamos futásnál ingatag volt (mért), a lényeg a mappa.
  assert.equal(measured.json.workspace.toLowerCase(), first.path.toLowerCase(), "a feloldott munkaterület a session cwd-je");
  assert.ok(!/[\\/]@deepseek-ai[\\/]/u.test(measured.json.workspace), "NEM a harness saját lib mappája");
  assert.equal(measured.json.sessions.length, 1);
});

test("host: az aktivitás-végpont fogadja a vödröket, a rosszat eldobja", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const handler = routes.get("/koltseg/activity");
  const res = makeRes();
  const req = new EventEmitter();
  req.url = "/koltseg/activity";
  req.method = "POST";
  req.destroy = () => {};
  const promise = handler(req, res);
  req.emit("data", Buffer.from(JSON.stringify({
    workspace: "D:\\Temp\\ws",
    items: [
      { kind: "key", at: Date.now() - 1000, to: Date.now() - 500, session: "session-a" },
      { kind: "nincs-ilyen", at: Date.now(), session: "session-a" },
    ],
  }), "utf8"));
  req.emit("end");
  await promise;
  await res.done;
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.equal(json.written, 1);
  assert.equal(json.dropped, 1);
});

test("host: a kliens-diagnosztika végpont naplót ír (és a hibásat eldobja)", async () => {
  const { ctx, routes } = makeCtx();
  host.apply(ctx);
  const handler = routes.get("/koltseg/log");

  async function post(payload) {
    const res = makeRes();
    const req = new EventEmitter();
    req.url = "/koltseg/log";
    req.method = "POST";
    req.destroy = () => {};
    const promise = handler(req, res);
    req.emit("data", Buffer.from(JSON.stringify(payload), "utf8"));
    req.emit("end");
    await promise;
    await res.done;
    return JSON.parse(res.body);
  }

  const good = await post({ text: "mount variant=header phase=active box=10,20 26x26 vw=1200" });
  assert.equal(good.ok, true);
  assert.equal(good.logged, true);
  const empty = await post({ text: 42 });
  assert.equal(empty.logged, false);

  const file = join(stateDir, "koltseg", "client.log");
  const text = readFileSync(file, "utf8");
  assert.match(text, /mount variant=header/u);
});
