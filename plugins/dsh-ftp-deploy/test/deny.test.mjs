import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertLocalRoot,
  assertRemoteRoot,
  completeLaravelInclude,
  isDenied,
  isRedirectOnlyInclude,
  isSafeRelPath,
  matchesInclude,
  toAllowRegexes,
} from "../lib/engine/deny.js";

test("deny: a titok- és generált fájlok nem mennek fel", () => {
  for (const p of [
    ".env",
    ".env.production",
    "storage/app/x.txt",
    "vendor/autoload.php",
    "node_modules/a/b.js",
    ".git/config",
    "bootstrap/cache/config.php",
    "public/hot",
    "public/.user.ini",
    "phpinfo.php",
    "rr.exe",
  ]) {
    assert.equal(isDenied(p), true, `${p} tiltva kell legyen`);
  }
});

test("deny: normál kód-fájlok mennek", () => {
  for (const p of ["app/Models/User.php", "resources/views/a.blade.php", "routes/web.php", "config/app.php"]) {
    assert.equal(isDenied(p), false, `${p} nem lehet tiltva`);
  }
});

test("allow: a profil-szintű kivétel felülírja a storage tiltást", () => {
  const allow = toAllowRegexes(["storage/app/private/registry"]);
  assert.equal(isDenied("storage/app/private/registry/a.json", allow), false);
  assert.equal(isDenied("storage/app/private/registryX/a.json", allow), true, "prefix nem illeszkedhet fél szóra");
  assert.equal(isDenied("storage/app/other/a.json", allow), true);
});

test("allow: a beépített Laravel-kivételek is működnek", () => {
  assert.equal(isDenied("storage/app/public/media-library/a.jpg"), false);
  assert.equal(isDenied("storage/framework/cache/x"), true);
});

test("include: prefix-egyezés mappára és fájlra", () => {
  const include = ["app", "database/migrations"];
  assert.equal(matchesInclude("app/Models/User.php", include), true);
  assert.equal(matchesInclude("app", include), true);
  assert.equal(matchesInclude("database/migrations/2020_01_01_x.php", include), true);
  assert.equal(matchesInclude("database/seeds/DatabaseSeeder.php", include), false);
  assert.equal(matchesInclude("app2/x.php", include), false);
});

test("laravel include: az app mellé bootstrap és lang kell", () => {
  assert.deepEqual(completeLaravelInclude(["app"]), ["app", "bootstrap", "lang"]);
  assert.deepEqual(completeLaravelInclude(["resources"]), ["resources"]);
  assert.deepEqual(completeLaravelInclude(["app", "lang"]), ["app", "lang", "bootstrap"]);
});

test("remoteRoot: /web csak tiszta átirányító profilnál engedett", () => {
  assert.equal(isRedirectOnlyInclude([".htaccess", "index.php"]), true);
  assert.equal(isRedirectOnlyInclude(["app"]), false);
  assert.equal(assertRemoteRoot("/web", [".htaccess", "index.php"]), "/web");
  assert.throws(() => assertRemoteRoot("/web", ["app"]), /nem lehet \/web/);
  assert.throws(() => assertRemoteRoot("/", ["app"]), /nem lehet üres/);
  assert.throws(() => assertRemoteRoot("", ["app"]), /nem lehet üres/);
  assert.equal(assertRemoteRoot("/web/laravel12/", ["app"]), "/web/laravel12");
});

test("remoteRoot: tiltott távoli szegmens", () => {
  assert.throws(() => assertRemoteRoot("/web/elearning", ["app"]), /Tiltott remote szegmens/);
  assert.throws(() => assertRemoteRoot("/web/magazin", ["app"]), /Tiltott remote szegmens/);
  assert.equal(assertRemoteRoot("/web/weboldal", ["app"]), "/web/weboldal");
});

test("localRoot: kötelező, trim-elve", () => {
  assert.equal(assertLocalRoot("  C:\\Herd\\x  "), "C:\\Herd\\x");
  assert.throws(() => assertLocalRoot("   "), /kötelező/);
});

test("biztonságos relatív útvonal", () => {
  assert.equal(isSafeRelPath("app/x.php"), true);
  assert.equal(isSafeRelPath("../x.php"), false);
  assert.equal(isSafeRelPath("a/../../x"), false);
  assert.equal(isSafeRelPath("/abs/x"), false);
  assert.equal(isSafeRelPath("\\abs\\x"), false);
  assert.equal(isSafeRelPath("C:/abs/x"), false);
  assert.equal(isSafeRelPath(""), false);
});
