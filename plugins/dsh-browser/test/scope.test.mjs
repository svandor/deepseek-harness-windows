/**
 * A célterület-ellenőrzés tesztjei (tiszta függvények, hálózat nélkül).
 *
 * Futtatás: `node --test plugins/dsh-browser/test/`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPES, checkScope, classifyHost, normalizeConfig, parseTarget } from "../lib/scope.js";

test("a loopback hosztok felismerése", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "app.localhost", "0.0.0.0"]) {
    assert.equal(classifyHost(host), "loopback", host);
  }
});

test("a magánhálózati címtartományok helyi hálózatnak számítanak", () => {
  for (const host of ["192.168.1.8", "192.168.1.252", "10.0.0.5", "172.16.4.4", "172.31.255.1", "169.254.10.10", "nas.local", "server.lan", "gép"]) {
    assert.equal(classifyHost(host), "lan", host);
  }
});

test("a nyilvános hosztok nem helyiek", () => {
  for (const host of ["github.com", "example.com", "8.8.8.8", "172.32.0.1"]) {
    assert.equal(classifyHost(host), "public", host);
  }
});

test("csak http/https séma fogadható el", () => {
  assert.equal(parseTarget("file:///C:/Windows/win.ini").ok, false);
  assert.equal(parseTarget("javascript:alert(1)").ok, false);
  assert.equal(parseTarget("data:text/html,<h1>x</h1>").ok, false);
  assert.equal(parseTarget("http://127.0.0.1:3080/").ok, true);
  assert.equal(parseTarget("github.com").ok, true, "séma nélkül https lesz");
});

test("a loopback hatókör csak a saját felületet engedi", () => {
  assert.equal(checkScope("loopback", "http://127.0.0.1:3080/").allowed, true);
  assert.equal(checkScope("loopback", "https://github.com/").allowed, false);
  assert.equal(checkScope("loopback", "http://192.168.1.8/").allowed, false);
});

test("a lan hatókör a helyi gépeket is engedi, a nyilvánost nem", () => {
  assert.equal(checkScope("lan", "http://192.168.1.252/").allowed, true);
  assert.equal(checkScope("lan", "http://127.0.0.1:3080/").allowed, true);
  assert.equal(checkScope("lan", "https://github.com/").allowed, false);
});

test("az any hatókör mindent enged (a felhasználó döntése: külső kattintás is)", () => {
  assert.equal(checkScope("any", "https://github.com/svandor/LineageOS").allowed, true);
  assert.equal(checkScope("any", "http://192.168.1.8/").allowed, true);
  assert.equal(checkScope("any", "http://127.0.0.1:3080/").allowed, true);
});

test("a kivétellista minden hatókörben enged", () => {
  assert.equal(checkScope("loopback", "https://firmware.example.com/x", { allowHosts: ["firmware.example.com"] }).allowed, true);
  assert.equal(checkScope("loopback", "https://other.example.com/x", { allowHosts: ["firmware.example.com"] }).allowed, false);
});

test("az ismeretlen hatókör-érték az 'any' biztonságos alapra esik vissza", () => {
  const verdict = checkScope("valami", "https://github.com/");
  assert.equal(verdict.allowed, true);
  const config = normalizeConfig(() => ({ defaultScope: "valami" }));
  assert.equal(config.defaultScope, "any");
});

test("a néma konfiguráció az alapértékeket adja", () => {
  const config = normalizeConfig(() => {
    throw new Error("nincs fájl");
  });
  assert.equal(config.defaultScope, "any");
  assert.equal(config.width, 1440);
  assert.equal(config.height, 900);
  assert.equal(config.idleMs, 180000);
  assert.deepEqual(config.allowHosts, []);
});

test("a hatóköz-vocabulum három fokozat", () => {
  assert.deepEqual([...SCOPES], ["loopback", "lan", "any"]);
});
