import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteDirIndex, joinRemote, normalizeRemote, remoteDirOf } from "../lib/engine/remoteDirs.js";

test("normalizeRemote: per-jel, dupla per és záró per nélkül", () => {
  assert.equal(normalizeRemote("web//laravel12///"), "/web/laravel12");
  assert.equal(normalizeRemote("\\web\\laravel12"), "/web/laravel12");
  assert.equal(normalizeRemote(""), "/");
  assert.equal(normalizeRemote("/"), "/");
  assert.equal(normalizeRemote("/web/laravel12/"), "/web/laravel12");
});

test("joinRemote és remoteDirOf", () => {
  assert.equal(joinRemote("/", "web"), "/web");
  assert.equal(joinRemote("/web", "laravel12"), "/web/laravel12");
  assert.equal(remoteDirOf("/web/laravel12/resources/views/a.blade.php"), "/web/laravel12/resources/views");
  assert.equal(remoteDirOf("/a.txt"), "/");
});

/** Egyszerű hamis FTP kliens: a megadott mappák léteznek, minden más MKD-t kap. */
function fakeClient({ existing = [], mkdCode = 257, listFails = false } = {}) {
  const created = [];
  const calls = [];
  const tree = new Set(existing);
  return {
    calls,
    created,
    async list(path) {
      calls.push(`LIST ${path}`);
      if (listFails) throw new Error("list hiba");
      const base = normalizeRemote(path);
      const children = new Set();
      for (const entry of tree) {
        if (entry === base) continue;
        if (base === "/" && entry.split("/").filter(Boolean).length === 1) children.add(entry.slice(1));
        else if (entry.startsWith(`${base}/`)) children.add(entry.slice(base.length + 1).split("/")[0]);
      }
      // A teszt-törzsből nem derül ki, hogy fájl-e; mappaként adjuk vissza, mert
      // a RemoteDirIndex csak a mappákat használja a gyorsításhoz.
      return [...children].map((name) => ({ name, isDirectory: true, isFile: false }));
    },
    async cd() {
      return {};
    },
    async sendIgnoringError(command) {
      calls.push(command);
      const name = command.replace(/^MKD\s+/, "");
      if (mkdCode === 257) {
        created.push(name);
        return { code: 257, message: "created" };
      }
      return { code: mkdCode, message: "hiba" };
    },
  };
}

test("RemoteDirIndex: meglévő mappákra nem küld MKD-t", async () => {
  const client = fakeClient({ existing: ["/web", "/web/laravel12", "/web/laravel12/resources"] });
  const index = new RemoteDirIndex(client);
  await index.ensure("/web/laravel12/resources/views");
  assert.deepEqual(client.created, ["views"], "csak a hiányzó szintre menjen MKD");
  assert.equal(index.stats.created, 1);
});

test("RemoteDirIndex: az 550 (versenyhelyzet) nem hiba", async () => {
  const client = fakeClient({ existing: ["/web"], mkdCode: 550 });
  const index = new RemoteDirIndex(client);
  await index.ensure("/web/laravel12");
  assert.equal(index.stats.created, 0);
});

test("RemoteDirIndex: a tartós MKD-hiba megáll", async () => {
  const client = fakeClient({ existing: ["/web"], mkdCode: 552 });
  const index = new RemoteDirIndex(client);
  await assert.rejects(() => index.ensure("/web/laravel12"), /nem hozható létre/);
});

test("RemoteDirIndex: ismételt ensure nem kérdez újra", async () => {
  const client = fakeClient({ existing: ["/web", "/web/laravel12"] });
  const index = new RemoteDirIndex(client);
  await index.ensure("/web/laravel12");
  const callsAfterFirst = client.calls.length;
  await index.ensure("/web/laravel12");
  assert.equal(client.calls.length, callsAfterFirst, "a gyorsítótár miatt nincs új LIST/MKD");
});

test("RemoteDirIndex: listázási hiba után is megpróbálja az MKD-t", async () => {
  const client = fakeClient({ existing: [], listFails: true, mkdCode: 257 });
  const index = new RemoteDirIndex(client);
  await index.ensure("/web");
  assert.deepEqual(client.created, ["web"]);
});
