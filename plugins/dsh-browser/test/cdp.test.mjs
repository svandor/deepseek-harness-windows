/**
 * A CDP kliens tesztjei hamis WebSocket-tel (nincs böngésző, nincs hálózat).
 *
 * Cél: a protokoll-réteg (id-egyeztetés, esemény-figyelés, hibaátadás,
 * időtúllépés) viselkedése akkor is helyes legyen, ha a böngésző nem indul.
 *
 * Futtatás: `node --test plugins/dsh-browser/test/`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCdpClient } from "../lib/cdp.js";

/**
 * Minimál WebSocket helyettesítő: a teszt irányítja az eseményeket.
 */
class FakeSocket {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** @type {Array<object>} */
    this.sent = [];
    FakeSocket.last = this;
  }

  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  /** @param {string} type @param {object} event */
  emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  /** @param {string} payload */
  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.emit("close");
  }

  /** @param {object} message */
  reply(message) {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

/** A kliens létrehozása egy fake socketre, nyitott állapotban. */
async function openClient() {
  const client = createCdpClient("ws://127.0.0.1:1/devtools/page/x", { WebSocketImpl: FakeSocket });
  FakeSocket.last.emit("open");
  await client.ready;
  return { client, socket: FakeSocket.last };
}

test("a hívás-azonosító és a válasz összeér", async () => {
  const { client, socket } = await openClient();
  const pending = client.send("Page.enable", { a: 1 });
  assert.deepEqual(socket.sent[0], { id: 1, method: "Page.enable", params: { a: 1 } });
  socket.reply({ id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
});

test("a CDP hiba a kivételbe kerül a metódus nevével", async () => {
  const { client, socket } = await openClient();
  const pending = client.send("Runtime.evaluate", { expression: "1" });
  socket.reply({ id: 1, error: { message: "Cannot find context" } });
  await assert.rejects(pending, /Runtime\.evaluate: Cannot find context/u);
});

test("az események figyelhetők és pufferelődnek", async () => {
  const { client, socket } = await openClient();
  const seen = [];
  const waiting = client.once("Page.loadEventFired", 5000);
  socket.reply({ method: "Page.loadEventFired", params: { timestamp: 42 } });
  socket.reply({ method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: "baj van" }] } });
  assert.deepEqual(await waiting, { timestamp: 42 });
  assert.equal(client.events.some((event) => event.method === "Runtime.consoleAPICalled"), true);
  seen.push(client.events.length);
  assert.equal(seen[0] >= 2, true);
});

test("a nem várt esemény nem zavarja a választ", async () => {
  const { client, socket } = await openClient();
  const pending = client.send("Page.navigate", { url: "https://example.com" });
  socket.reply({ method: "Page.frameNavigated", params: {} });
  socket.reply({ id: 1, result: { frameId: "F" } });
  assert.deepEqual(await pending, { frameId: "F" });
});

test("zárt kapcsolat után a hívás azonnal hibázik", async () => {
  const { client, socket } = await openClient();
  socket.close();
  await assert.rejects(client.send("Page.enable"), /lezárt|zárt/u);
});

test("a válasz nélküli hívás időtúllépéssel áll le, nem örökre", async () => {
  const client = createCdpClient("ws://127.0.0.1:1/devtools/page/x", { WebSocketImpl: FakeSocket, sendTimeoutMs: 60 });
  FakeSocket.last.emit("open");
  await client.ready;
  await assert.rejects(client.send("Page.enable"), /időtúllépés/u);
});
