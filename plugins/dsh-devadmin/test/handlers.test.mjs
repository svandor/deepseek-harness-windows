/**
 * A `dsh-devadmin` host-oldal tesztjei — harness NÉLKÜL.
 *
 * A végpontok `(req, res)` párost kapnak, ezért a valódi szerver helyett egy
 * kézi `res` puffert adunk be: így a JSON alakja és a mellékhatás nélküli
 * olvasás ellenőrizhető anélkül, hogy a DSH-t újra kellene indítani.
 *
 * Futtatás: node --test plugins/dsh-devadmin/test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverSites,
  phpVersions,
  testTcp,
  tailFile,
  handleState,
  handleLogs,
} from "../lib/index.js";

function fakeResponse() {
  const chunks = [];
  return {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers ?? {});
    },
    end(payload) {
      if (payload !== undefined) chunks.push(Buffer.from(payload));
      this.body = Buffer.concat(chunks).toString("utf8");
    },
  };
}

test("a parkolt gyoker projektjei felismerhetok a .dsh/dev.yaml profilbol", () => {
  const sites = discoverSites();
  assert.ok(Array.isArray(sites));
  assert.ok(sites.length >= 1, "legalabb egy projekt kell a D:\\Herd alatt");
  for (const site of sites) {
    assert.match(site.domain, /\.test$/u, `domain forma: ${site.domain}`);
    assert.ok(site.project.length > 0);
    assert.ok(site.docroot.length > 0);
    assert.ok(site.php.length > 0);
  }
  const domains = sites.map((site) => site.domain);
  assert.equal(new Set(domains).size, domains.length, "nincs ket azonos domain");
});

test("a PHP valaszto a valodi telepitest latja", () => {
  const php = phpVersions();
  assert.equal(php.root, "D:\\Tools\\php");
  assert.ok(php.versions.length >= 1, "legalabb egy verzio kell");
  for (const version of php.versions) assert.match(version, /^\d+\.\d+/u);
  assert.ok(php.versions.includes(php.current), `a current (${php.current}) telepített verzio legyen`);
});

test("a TCP vizsgalat valaszol (DBngin 3306)", async () => {
  assert.equal(await testTcp("127.0.0.1", 3306), true, "a helyi MySQL elerheto kell legyen");
  assert.equal(await testTcp("127.0.0.1", 65533, 300), false, "nem hallgatott port = false");
});

test("a tailFile az utolso N sort adja", () => {
  const dir = mkdtempSync(join(tmpdir(), "devadmin-"));
  const path = join(dir, "sample.log");
  writeFileSync(path, ["a", "b", "c", "d", "e"].join("\n"), "utf8");
  assert.equal(tailFile(path, 2), "d\ne");
  assert.equal(tailFile(join(dir, "nincs.log"), 2), "");
});

test("a /devadmin/state valasz a felulet altal vart mezoket adja", async () => {
  const res = fakeResponse();
  await handleState({}, res);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/json/u);
  const body = JSON.parse(res.body);

  assert.ok(body.devServer, "devServer blokk kell");
  assert.equal(typeof body.devServer.running, "boolean");
  assert.ok([80, 443, 8080, 8443].includes(body.devServer.httpPort) || body.devServer.httpPort > 0);
  assert.ok(body.devServer.httpsPort > 0);

  assert.ok(Array.isArray(body.sites));
  for (const site of body.sites) {
    assert.ok(site.domain && site.url.startsWith("https://"));
    assert.equal(typeof site.phpCgiAlive, "boolean");
    assert.equal(typeof site.inHosts, "boolean");
    assert.ok(site.probe && typeof site.probe.status === "number");
  }

  assert.ok(body.php && Array.isArray(body.php.versions));
  assert.ok(Array.isArray(body.ports));
  assert.ok(body.ports.some((entry) => entry.port === 443));
  assert.ok(Array.isArray(body.autostart));
  assert.ok(body.paths && body.paths.hosts.endsWith("hosts"));
});

test("a /devadmin/logs a kert site naplojat adja", () => {
  const res = fakeResponse();
  const url = new URL("http://dsh.invalid/devadmin/logs?site=termeszetgyogyaszoktatas-l12.test&tail=5");
  handleLogs(url, res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  for (const key of ["caddyError", "caddyStdout", "php", "access"]) {
    assert.ok(key in body, `hianyzik: ${key}`);
  }
  assert.equal(typeof body.php, "string");
});
