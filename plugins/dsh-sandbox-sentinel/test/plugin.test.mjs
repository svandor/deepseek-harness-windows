/**
 * A plugin viselkedése hamis `ctx`-szel (nincs harness): a post-execute jegyzet
 * és a session-súgó tényleg a helyére kerül-e.
 *
 * Futtatás: `node plugins/dsh-sandbox-sentinel/test/plugin.test.mjs`
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apply } from "../lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-sentinel-"));
const logPath = join(dir, "sandbox-sentinel.log");
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Hamis ctx: elkapja a regisztrált esemény-figyelőket. */
function setUp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  /** @type {Array<object>} */
  const injected = [];
  const ctx = {
    on(event, fn) {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
    logger: { info() {}, warn() {} },
    get: () => undefined
  };
  apply(ctx, { logPath });
  return { handlers, injected };
}

const PIPE_ERROR = {
  content: [
    {
      type: "text",
      text: "ResourceUnavailable: Program 'pwsh.exe' failed to run: Access to the path '\\\\.\\pipe\\LOCAL\\dotnet_e1d6' is denied.\n[exit code: 1]"
    }
  ]
};

test("a two hook beregisztrál (post-execute + session-start)", () => {
  const { handlers } = setUp();
  assert.equal(typeof handlers.get("tools/post-execute"), "function");
  assert.equal(typeof handlers.get("agent/session-start"), "function");
});

test("a named-pipe hibás kimenet HIBAKÉNT jön vissza (a DSH eddig sikeresként adta)", async () => {
  const { handlers } = setUp();
  const post = handlers.get("tools/post-execute");
  let nextCalled = false;
  const decision = await post({ name: "pwsh", callId: "c1" }, PIPE_ERROR, () => {
    nextCalled = true;
    return { kind: "accept" };
  });
  assert.equal(nextCalled, false, "nem engedte tovább (van jegyzet)");
  assert.equal(decision.kind, "block", "a bukott hívás isError lesz");
  assert.equal(decision.feedback.length, 2, "az eredeti kimenet megmarad");
  assert.match(String(decision.feedback[0].text), /\\pipe\\/u);
  const note = String(decision.feedback[1].text);
  assert.match(note, /\[sandbox-sentinel\]/u);
  assert.match(note, /cmd \/c/u);
  assert.match(note, /NEM eszkaláció/u);
});

test("a már hibás eredményt nem minősíti át (nincs dupla jelölés)", async () => {
  const { handlers } = setUp();
  const decision = await handlers.get("tools/post-execute")(
    { name: "pwsh" },
    { isError: true, content: PIPE_ERROR.content },
    () => ({ kind: "accept" })
  );
  assert.equal(decision.kind, "accept");
});

test("a találat naplózódik (JSONL, a hibaosztály nevével)", async () => {
  const { handlers } = setUp();
  await handlers.get("tools/post-execute")({ name: "pwsh", callId: "c2" }, PIPE_ERROR, () => ({ kind: "accept" }));
  assert.equal(existsSync(logPath), true);
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const last = lines.at(-1);
  assert.equal(last.kind, "block", "a biztos bukás blokkként van naplózva");
  assert.equal(last.class, "pipe-capture");
  assert.equal(last.tool, "pwsh");
});

test("a bizonytalan esetekben NEM minősít át (csak jegyzetet fűz)", async () => {
  const { handlers } = setUp();
  // A magyar üzenet lehet ártalmatlan is (pl. egy védett fájl olvasása).
  const decision = await handlers.get("tools/post-execute")(
    { name: "pwsh" },
    { content: [{ type: "text", text: "Get-Content : A hozzáférés megtagadva." }] },
    () => ({ kind: "accept" })
  );
  assert.equal(decision.kind, "accept");
  assert.equal(decision.content.length, 2);
  assert.match(String(decision.content[1].text), /sandbox-sentinel/u);
});

test("a normál kimenet változatlanul megy tovább", async () => {
  const { handlers } = setUp();
  const passthrough = { kind: "accept", content: [{ type: "text", text: "Everything up-to-date" }] };
  let nextCalled = false;
  const decision = await handlers.get("tools/post-execute")(
    { name: "pwsh" },
    { content: [{ type: "text", text: "Everything up-to-date" }] },
    () => {
      nextCalled = true;
      return passthrough;
    }
  );
  assert.equal(nextCalled, true);
  assert.equal(decision, passthrough, "a next() eredménye változatlanul megy vissza");
});

test("fájl-toolnál nem szól bele (nincs zaj a write/edit kimenetén)", async () => {
  const { handlers } = setUp();
  let nextCalled = false;
  await handlers.get("tools/post-execute")(
    { name: "write" },
    { content: [{ type: "text", text: "Program 'x.exe' failed to run: Access to the path '\\\\.\\pipe\\LOCAL\\dotnet_1' is denied" }] },
    () => {
      nextCalled = true;
      return { kind: "accept" };
    }
  );
  assert.equal(nextCalled, true);
});

test("a session-súgó beinjektálódik (jelölővel, hogy ne legyen felhasználói feladat)", async () => {
  const { handlers } = setUp();
  /** @type {Array<object>} */
  const messages = [];
  const sessionStart = handlers.get("agent/session-start");
  sessionStart({ agent: { inject: (message) => messages.push(message) } });
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "plugin");
  assert.equal(message.source.plugin, "dsh-sandbox-sentinel");
  assert.match(String(message.content[0].text), /NEM felhasználói üzenet/u);
  assert.match(String(message.content[0].text), /GIT_SSH/u);
});

test("agent nélkül nem omlik össze a session-start", () => {
  const { handlers } = setUp();
  assert.doesNotThrow(() => handlers.get("agent/session-start")({}));
});
