import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPreviewFiles,
  currentHead,
  localPrefixFromGitRoot,
  parseNameStatus,
  parseUntracked,
  resolveGitRoot,
  runGit,
} from "../lib/engine/gitdiff.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ftp-gitdiff-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "resources"), { recursive: true });
  writeFileSync(join(dir, "app", "a.php"), "<?php echo 1;\n");
  writeFileSync(join(dir, "app", "old.php"), "<?php // torlendo\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

test("resolveGitRoot: a repo gyökerét adja vissza almappából is", () => {
  const dir = makeRepo();
  try {
    assert.equal(join(resolveGitRoot(join(dir, "app"))), join(dir));
    assert.equal(localPrefixFromGitRoot(dir, join(dir, "app")), "app");
    assert.equal(localPrefixFromGitRoot(dir, dir), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseNameStatus / parseUntracked", () => {
  assert.deepEqual(parseNameStatus("M\tapp/a.php\nD\tapp/old.php\nA\tdocs/x.md\n"), [
    { path: "app/a.php", deleted: false },
    { path: "app/old.php", deleted: true },
    { path: "docs/x.md", deleted: false },
  ]);
  assert.deepEqual(parseUntracked("?? resources/new.txt\n M app/a.php\n"), [
    { path: "resources/new.txt", deleted: false },
  ]);
});

test("collectPreviewFiles: baseline nélkül jelzi, hogy be kell állítani", async () => {
  const dir = makeRepo();
  try {
    const result = await collectPreviewFiles(dir, ["app"], null);
    assert.equal(result.needsBaseline, true);
    assert.deepEqual(result.files, []);
    assert.ok(result.headSha, "a HEAD-et ilyenkor is megadja");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectPreviewFiles: módosítás, törlés és untracked fájl a baseline óta", async () => {
  const dir = makeRepo();
  try {
    const baseline = await currentHead(dir);
    assert.ok(baseline && baseline.length === 40);

    writeFileSync(join(dir, "app", "a.php"), "<?php echo 2;\n");
    git(dir, ["rm", "-q", "app/old.php"]);
    git(dir, ["commit", "-qam", "valtozas"]);
    // nem követett fájl, ami mehet (include alatt van)
    writeFileSync(join(dir, "resources", "new.txt"), "hello\n");
    // nem követett fájl, ami TILTOTT (a `blocked` listára kerül)
    writeFileSync(join(dir, "app", ".env.local"), "X=1\n");

    const result = await collectPreviewFiles(dir, ["app", "resources"], baseline);
    assert.equal(result.needsBaseline, false);
    const uploads = result.files.filter((f) => f.action === "upload").map((f) => f.path).sort();
    const deletes = result.files.filter((f) => f.action === "delete").map((f) => f.path).sort();
    assert.deepEqual(uploads, ["app/a.php", "resources/new.txt"]);
    assert.deepEqual(deletes, ["app/old.php"]);
    assert.ok(result.files.every((f) => f.size >= 0), "a méret szám");
    assert.ok(
      !result.files.some((f) => f.path.includes(".env")),
      "a .env soha nem kerül a feltöltendők közé",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectPreviewFiles: include-on kívüli fájl kimarad", async () => {
  const dir = makeRepo();
  try {
    const baseline = await currentHead(dir);
    writeFileSync(join(dir, "app", "a.php"), "<?php echo 3;\n");
    writeFileSync(join(dir, "docs.md"), "# docs\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "docs"]);
    const result = await collectPreviewFiles(dir, ["app"], baseline);
    assert.deepEqual(result.files.map((f) => f.path), ["app/a.php"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGit: hibás parancs nem dob, hanem ok=false", async () => {
  const dir = makeRepo();
  try {
    const res = await runGit(["revparse", "HEAD"], dir);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /revparse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
