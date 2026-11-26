/**
 * A `browser` tool kapuinak tesztjei — BÖNGÉSZŐ INDÍTÁSA NÉLKÜL.
 *
 * Cél: azok az utak, amelyeknek MINDEN esetben el kell zárniuk a műveletet
 * (jóváhagyás nélküli letöltés, tiltott séma, hatókörön kívüli cél), valóban
 * elzárják — és ezt a böngésző elindítása előtt tegyék.
 *
 * Futtatás: `node plugins/dsh-browser/test/tool.test.mjs`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, executeBrowser } from "../lib/index.js";

// Olyan kompozíció, amiben NINCS approval szolgáltatás (ez a headless eset).
await apply({
  tools: { register() {} },
  get: () => undefined,
  on() {},
  logger: { warn() {} }
});

test("letöltés jóváhagyási csatorna nélkül nem indul el", async () => {
  const result = await executeBrowser({ action: "download", url: "https://example.com/fajl.zip" }, { agent: {}, callId: "c1" });
  assert.match(result.text, /NEM indult/u);
  assert.match(result.text, /jóváhagyási csatorna/u);
});

test("letöltés agent nélkül nem indul el (nincs kitől engedélyt kérni)", async () => {
  const result = await executeBrowser({ action: "download", url: "https://example.com/fajl.zip" }, null);
  assert.match(result.text, /NEM indult/u);
});

test("nem http(s) séma minden hatókörben tiltott", async () => {
  for (const url of ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,x"]) {
    const result = await executeBrowser({ action: "open", url }, null);
    assert.match(result.text, /nem engedélyezett|nem támogatott séma/u, url);
  }
});

test("loopback hatókörben a külső cél tiltott (a böngésző el sem indul)", async () => {
  const result = await executeBrowser({ action: "open", url: "https://example.com/", scope: "loopback" }, null);
  assert.match(result.text, /nem engedélyezett/u);
  assert.match(result.text, /kívül esik/u);
});

test("lan hatókörben a nyilvános cél tiltott", async () => {
  const result = await executeBrowser({ action: "open", url: "https://github.com/", scope: "lan" }, null);
  assert.match(result.text, /nem engedélyezett/u);
});

test("a status nem indít böngészőt, és kimondja az állapotot", async () => {
  const result = await executeBrowser({ action: "status" }, null);
  assert.match(result.text, /böngésző: nem fut/u);
  assert.match(result.text, /hatókör:/u);
});

test("az ismeretlen action felsorolja a lehetségeseket", async () => {
  const result = await executeBrowser({ action: "ez-nincs" }, null);
  assert.match(result.text, /ismeretlen action/u);
  assert.match(result.text, /open \| read \| click/u);
});

test("a shot/clik/type selector nélkül nem indít böngészőt", async () => {
  const click = await executeBrowser({ action: "click" }, null);
  assert.match(click.text, /CSS selector/u);
  const type = await executeBrowser({ action: "type" }, null);
  assert.match(type.text, /CSS selector/u);
  const evalResult = await executeBrowser({ action: "eval" }, null);
  assert.match(evalResult.text, /JS kifejezés/u);
});
