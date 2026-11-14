/**
 * Egységtesztek a `dsh-session-auto-continue` döntési és KÉZBESÍTÉSI logikájára.
 *
 * MIÉRT: a plugin élesben csak BOOTKOR fut, a viselkedését tehát nem lehet
 * „próbálgatással" hitelesíteni — minden hiba egy harness-újraindításba
 * kerülne. A teszt ezért:
 *   - mock `ctx`-szel adja a sessionöket,
 *   - egy VALÓDI helyi HTTP-szervert indít, ami a `/api/session/prompt` RPC-t
 *     utánozza (token → süti, majd `{result:{ok:true,value:{accepted:true}}}`),
 *   - a `state\` és a session-naplók helyét temp mappára állítja.
 *
 * Így a teszt az ÉLES kódrészletet futtatja: a döntést (megszakadt kör
 * felismerése) ÉS a kézbesítést (HTTP RPC boríték) is.
 *
 * FUTTATÁS: node --test plugins\dsh-session-auto-continue\test\plugin.test.mjs
 * Egy teszt ~9 s (a plugin 8 s-os késleltetéssel indít).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

// IZOLÁCIÓ (a konstansok és a modulbetöltés ELŐTT!)
process.env.DSH_AUTO_CONTINUE_STATE_DIR = mkdtempSync(join(tmpdir(), "dsh-autocontinue-state-"));
process.env.DSH_AUTO_CONTINUE_SESSIONS_ROOT = mkdtempSync(join(tmpdir(), "dsh-autocontinue-"));

const STATE_DIR = process.env.DSH_AUTO_CONTINUE_STATE_DIR;
const MARKER_PATH = join(STATE_DIR, "auto-continue.json");
const WAIT_MS = 9000;

/**
 * A `/api/session/prompt` RPC-t utánzó szerver.
 * @returns {Promise<{url: string, calls: object[], close: () => Promise<void>}>}
 */
async function fakeRpcServer() {
  const calls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "set-cookie": "dsh-auth-test=1; Path=/" });
      response.end("<html>ok</html>");
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/session/prompt") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        calls.push(parsed);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          type: "server-response",
          rpcId: parsed?.rpcId ?? "test",
          result: { ok: true, value: { accepted: true } }
        }));
      });
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/?token=test`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

/** @param {string} id @param {object[]} events */
function fakeSession(id, events) {
  return { id, snapshotEvents: () => events };
}

function turnStart(seq, time) {
  return { type: "turn/start", seq, time, data: { turn: "t1" } };
}

function turnEnd(seq, time, reasonKind) {
  return { type: "turn/end", seq, time, data: { turn: "t1", reason: { kind: reasonKind } } };
}

/** A plugin friss példánya (a `sentOnce` modul-szintű). */
function loadPlugin(tag) {
  return import(`${new URL("../lib/index.js", import.meta.url).href}?v=${tag}`);
}

/** Mock ctx: csak a `sessions.list()` kell. */
function fakeCtx(sessions) {
  return { sessions: { list: () => sessions } };
}

afterEach(() => {
  try { writeFileSync(MARKER_PATH, "{}", "utf8"); } catch { /* ignore */ }
});

test("megszakadt kör: a folytatás átmegy a HTTP RPC-n", async () => {
  const rpc = await fakeRpcServer();
  process.env.DSH_AUTO_CONTINUE_BASE_URL = rpc.url;
  const plugin = await loadPlugin("interrupted");
  const now = Date.now();
  const sessions = [fakeSession("session-1", [turnStart(1, now - 600000), turnEnd(2, now - 599000, "interrupted")])];
  plugin.apply(fakeCtx(sessions));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  await rpc.close();
  assert.equal(rpc.calls.length, 1, "egy RPC-hívás történt");
  const envelope = rpc.calls[0];
  assert.equal(envelope.type, "client-request");
  assert.equal(envelope.method, "session/prompt");
  const request = envelope?.payload?.args?.request;
  assert.equal(request?.sessionId, "session-1");
  assert.equal(request?.mode, "queue", "a mode KÖTELEZŐ a sémában");
  assert.equal(request?.content?.[0]?.type, "text");
  assert.match(request?.content?.[0]?.text ?? "", /Automatikus folytatás/u);
});

test("befejezett kör: nincs RPC-hívás", async () => {
  const rpc = await fakeRpcServer();
  process.env.DSH_AUTO_CONTINUE_BASE_URL = rpc.url;
  const plugin = await loadPlugin("completed");
  const now = Date.now();
  const sessions = [fakeSession("session-2", [turnStart(1, now - 600000), turnEnd(2, now - 599000, "completed")])];
  plugin.apply(fakeCtx(sessions));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  await rpc.close();
  assert.equal(rpc.calls.length, 0, "nem küld semmit");
});

test("nyitott turn (nyers crash-állapot): RPC-hívás történik", async () => {
  const rpc = await fakeRpcServer();
  process.env.DSH_AUTO_CONTINUE_BASE_URL = rpc.url;
  const plugin = await loadPlugin("open");
  const now = Date.now();
  const sessions = [fakeSession("session-3", [turnStart(1, now - 600000)])];
  plugin.apply(fakeCtx(sessions));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  await rpc.close();
  assert.equal(rpc.calls.length, 1, "a nyitott kört is folytatni próbálja");
});

test("ÉLŐ session (a boot UTÁNI körhatár): nincs RPC-hívás", async () => {
  const rpc = await fakeRpcServer();
  process.env.DSH_AUTO_CONTINUE_BASE_URL = rpc.url;
  const plugin = await loadPlugin("live");
  const now = Date.now();
  // A kör-határ a MOSTANI boot után van: a session dolgozik, nem szakadt meg.
  // Mért hiba (2026-11-14 06:56): enélkül a plugin sorba állított egy
  // „Automatikus folytatás" üzenetet egy élő beszélgetésben.
  const sessions = [fakeSession("session-live", [turnStart(1, now - 1000)])];
  plugin.apply(fakeCtx(sessions));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  await rpc.close();
  assert.equal(rpc.calls.length, 0, "élő sessionbe nem szabad beleírni");
});

test("jelölő: ugyanaz a kör nem küldődik kétszer", async () => {
  const rpc = await fakeRpcServer();
  process.env.DSH_AUTO_CONTINUE_BASE_URL = rpc.url;
  const now = Date.now();
  const sessions = [fakeSession("session-4", [turnStart(1, now - 600000), turnEnd(2, now - 599000, "interrupted")])];
  const first = await loadPlugin("marker-1");
  first.apply(fakeCtx(sessions));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  const afterFirst = rpc.calls.length;
  const second = await loadPlugin("marker-2");
  second.apply(fakeCtx(sessions));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  await rpc.close();
  assert.equal(afterFirst, 1, "az első futás küld");
  assert.equal(rpc.calls.length, 1, "a második futás nem küld újra");
});
