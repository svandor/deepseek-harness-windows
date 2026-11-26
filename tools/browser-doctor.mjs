/**
 * browser-doctor.mjs — a böngésző-motor VALÓDI ellenőrzése (headless Edge + CDP).
 *
 * MIÉRT KELL: a böngésző a HOST processzben fut, ezért a sandboxból nézve
 * „láthatatlan" — ha a motor elromlik (Edge-frissítés, CDP-változás, profil-,
 * letöltés- vagy hatókör-hiba), az csak akkor derül ki, amikor egy ágens
 * élesben használja. Ez a szkript egy paranccsal végigméri a teljes utat.
 *
 * FONTOS: a `pwsh` toolból futtatva a szkript a SANDBOXON BELÜL fut, ahol a
 * Chromium nem tud elindulni (mojo/crashpad → „a hozzáférés megtagadva").
 * Ezért vagy eszkalációval futtasd (a felhasználó jóváhagyásával), vagy a
 * DSH terminál-paneljéből — a plugin maga viszont MINDIG a host processzben
 * fut, tehát neki nem kell eszkaláció.
 *
 * Használat:
 *   node tools/browser-doctor.mjs [--json] [--allow-download] [--keep-profile]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCdpClient, createPage } from "../plugins/dsh-browser/lib/cdp.js";
import { findBrowser, freePort, gracefulClose, launch, waitForEndpoint } from "../plugins/dsh-browser/lib/edge.js";
import { listProfiles, pruneEphemeral, removeEphemeral, resolveProfile } from "../plugins/dsh-browser/lib/profiles.js";
import { checkScope } from "../plugins/dsh-browser/lib/scope.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const stateDir = join(root, "state");
const shotDir = join(stateDir, "browser-shots");
const profileRoot = join(stateDir, "browser-profiles");
const downloadRoot = join(stateDir, "browser-downloads");
const asJson = process.argv.includes("--json");
const allowDownload = process.argv.includes("--allow-download");
const keepProfile = process.argv.includes("--keep-profile");

/** @type {Array<{name: string, status: "ok"|"fail"|"skip", detail: string}>} */
const results = [];

/** @param {string} name @param {"ok"|"fail"|"skip"} status @param {string} detail */
function record(name, status, detail) {
  results.push({ name, status, detail });
}

/** A futtató böngésző egy profillal; a végén MINDIG lezár. */
async function withBrowser(profileDir, run) {
  const exe = findBrowser();
  if (exe === null) throw new Error("nincs Edge/Chrome a szokásos helyeken");
  const port = await freePort();
  const child = launch({ exe, profileDir, port });
  let client = null;
  try {
    const endpoint = await waitForEndpoint(port, { timeoutMs: 30000 });
    client = createCdpClient(endpoint.wsUrl);
    await client.ready;
    const page = createPage(client);
    await page.enable();
    await page.setViewport(1440, 900);
    return await run({ client, page, port, exe });
  } finally {
    // Előbb szabályos zárás (a profil kiírása), aztán a maradék fa levitele.
    await gracefulClose(child, client);
    if (client !== null) {
      try {
        await client.close();
      } catch {
        /* zárt */
      }
    }
  }
}

/** A saját felület tokenezett URL-je (ha fut a harness). */
function harnessUrl() {
  try {
    const text = readFileSync(join(stateDir, "harness.url"), "utf8").trim();
    return text.includes("token=") ? text : null;
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(shotDir, { recursive: true });
  mkdirSync(profileRoot, { recursive: true });
  // A korábbi futásokból maradt eldobható profilok kitakarítása.
  const pruned = pruneEphemeral(profileRoot, 3600000);
  if (pruned > 0) record("prune-tmp", "ok", `${pruned} régi eldobható profil kitakarítva`);

  // 1) A böngésző megtalálható?
  const exe = findBrowser();
  record("browser-exe", exe === null ? "fail" : "ok", exe ?? "nincs Edge/Chrome a szokásos helyeken");

  // 2) A hatókör-szabály (tiszta, böngésző nélkül).
  const scopeChecks = [
    ["loopback", "http://127.0.0.1:3080/", true],
    ["loopback", "https://github.com/", false],
    ["lan", "http://192.168.1.252/", true],
    ["any", "https://github.com/", true],
    ["any", "file:///C:/Windows/win.ini", false]
  ];
  const badScope = scopeChecks.filter(([scope, url, expected]) => checkScope(scope, url).allowed !== expected);
  record("scope-policy", badScope.length === 0 ? "ok" : "fail", `${scopeChecks.length - badScope.length}/${scopeChecks.length} eset helyes`);

  if (exe === null) {
    finish();
    return;
  }

  // 3) Loopback: a saját felület megnyitása + képernyőkép.
  const profile = resolveProfile({ rootDir: profileRoot, mode: "ephemeral" });
  try {
    const url = harnessUrl();
    if (url === null) {
      record("loopback-ui", "skip", "nincs state\\harness.url (nem fut a harness?)");
    } else {
      const info = await withBrowser(profile.dir, async ({ page }) => {
        const nav = await page.navigate(url, { timeoutMs: 25000 });
        const shot = await page.screenshot({ fullPage: false });
        const file = join(shotDir, `doctor-ui-${Date.now()}.png`);
        writeFileSync(file, Buffer.from(shot.base64, "base64"));
        return { ...nav, file, bytes: statSync(file).size };
      });
      record("loopback-ui", info.ready && info.title !== "" ? "ok" : "fail", `cím="${info.title}" kész=${info.ready} kép=${info.bytes} B (${info.file.split("\\").pop()})`);
    }
  } catch (error) {
    record("loopback-ui", "fail", String(error?.message ?? error));
  }

  // 4) Külső oldal olvasása.
  //    MÉRT TANULSÁG (2026-11-26): a example.com ma NEM tartalmaz `<h1>`-et
  //    (a törzsszöveg egy bekezdés) — ezért a szerkezetre (h1) épített
  //    ellenőrzés hamis hibát ad. A helyes mérés: cím + nem üres törzsszöveg.
  const external = resolveProfile({ rootDir: profileRoot, mode: "ephemeral" });
  try {
    const info = await withBrowser(external.dir, async ({ page }) => {
      const nav = await page.navigate("https://example.com/", { timeoutMs: 25000 });
      const body = await page.evaluate("document.body === null ? '' : document.body.innerText");
      const shot = await page.screenshot({ fullPage: true });
      const file = join(shotDir, `doctor-external-${Date.now()}.png`);
      writeFileSync(file, Buffer.from(shot.base64, "base64"));
      return { ...nav, body: String(body ?? "").trim(), file, bytes: statSync(file).size };
    });
    const ok = info.ready && /example domain/iu.test(info.title) && info.body.length > 20;
    record("external-read", ok ? "ok" : "fail", `cím="${info.title}" törzsszöveg=${info.body.length} karakter kép=${info.bytes} B`);
  } catch (error) {
    record("external-read", "fail", String(error?.message ?? error));
  } finally {
    removeEphemeral(external.dir);
  }

  // 5) Külső KATTINTÁS (a felhasználó kérése: külső oldalon is kell).
  const clickProfile = resolveProfile({ rootDir: profileRoot, mode: "ephemeral" });
  try {
    const info = await withBrowser(clickProfile.dir, async ({ page }) => {
      await page.navigate("https://example.com/", { timeoutMs: 25000 });
      const before = await page.evaluate("location.href");
      await page.click("a");
      const ready = await page.waitReady(20000);
      const after = await page.evaluate("({ url: location.href, title: document.title })");
      return { before: String(before ?? ""), after: String(after?.url ?? ""), title: String(after?.title ?? ""), ready };
    });
    const navigated = info.after !== info.before && info.after !== "";
    record("external-click", navigated ? "ok" : "fail", `${info.before} → ${info.after} "${info.title}" (kész=${info.ready})`);
  } catch (error) {
    record("external-click", "fail", String(error?.message ?? error));
  } finally {
    removeEphemeral(clickProfile.dir);
  }

  // 6) Tartós profil: zárás után is megvan a tartalma (nem kell újra bejelentkezni).
  try {
    const persistent = resolveProfile({ rootDir: profileRoot, mode: "persistent", name: "doctor" });
    const before = countFiles(persistent.dir);
    await withBrowser(persistent.dir, async ({ page }) => {
      await page.navigate("https://example.com/", { timeoutMs: 25000 });
    });
    const afterFirst = countFiles(persistent.dir);
    let cookieSurvives = false;
    await withBrowser(persistent.dir, async ({ page }) => {
      await page.navigate("https://example.com/", { timeoutMs: 25000 });
      await page.evaluate("document.cookie = 'dsh_doctor=1; path=/; max-age=3600'");
    });
    await withBrowser(persistent.dir, async ({ page }) => {
      await page.navigate("https://example.com/", { timeoutMs: 25000 });
      const value = await page.evaluate("document.cookie");
      cookieSurvives = String(value ?? "").includes("dsh_doctor=1");
    });
    const grown = afterFirst > 0 && afterFirst >= before;
    record(
      "persistent-profile",
      grown && cookieSurvives ? "ok" : "fail",
      `fájlok: ${before} → ${afterFirst} · süti túlélte az újraindítást: ${cookieSurvives ? "igen" : "nem"} · hely: ${persistent.dir}`
    );
  } catch (error) {
    record("persistent-profile", "fail", String(error?.message ?? error));
  }

  // 7) Letöltés (a toolban jóváhagyáshoz kötve; itt explicit kapcsoló).
  if (!allowDownload) {
    record("download", "skip", "a --allow-download kapcsoló nélkül kihagyva (a toolban ezt a felhasználó jóváhagyása váltja ki)");
  } else {
    const downloadProfile = resolveProfile({ rootDir: profileRoot, mode: "ephemeral" });
    const dir = join(downloadRoot, `doctor-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const info = await withBrowser(downloadProfile.dir, async ({ client, page }) => {
        await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
        await page.navigate("https://example.com/", { timeoutMs: 25000 });
        // Determinisztikus, hálózatfüggetlen letöltés: blob-URL + `a[download]`.
        await page.evaluate(`(() => {
          const blob = new Blob(["dsh-browser doctor\\n"], { type: "text/plain" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "doctor.txt";
          document.body.appendChild(a);
          a.click();
          URL.revokeObjectURL(url);
          return true;
        })()`);
        const deadline = Date.now() + 20000;
        let files = [];
        while (Date.now() < deadline && files.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          files = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && !entry.name.endsWith(".crdownload"))
            .map((entry) => ({ name: entry.name, bytes: statSync(join(dir, entry.name)).size }));
        }
        return { files };
      });
      const ok = info.files.length > 0;
      record("download", ok ? "ok" : "fail", ok ? `${info.files.map((file) => `${file.name} (${file.bytes} B)`).join(", ")} → ${dir}` : `nincs fájl a ${dir} mappában`);
    } catch (error) {
      record("download", "fail", String(error?.message ?? error));
    } finally {
      removeEphemeral(downloadProfile.dir);
    }
  }

  removeEphemeral(profile.dir);
  if (!keepProfile) {
    // A "doctor" profilt meghagyjuk: ez a tartós profil létezésének bizonyítéka.
    for (const entry of listProfiles(profileRoot)) {
      if (entry.name !== "doctor" && existsSync(entry.dir)) {
        // Nem töröljük az idegen profilokat — csak jelezzük.
        record("profiles-present", "ok", `meglévő tartós profil: ${entry.name}`);
      }
    }
  }
  finish();
}

/**
 * Fájlok száma egy könyvtárban (rekurzívan, best-effort).
 * @param {string} dir
 * @param {number} [limit]
 * @returns {number}
 */
function countFiles(dir, limit = 5000) {
  let count = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (count >= limit) break;
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name), limit - count);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

/** Az eredmény kiírása és a kilépési kód. */
function finish() {
  const failed = results.filter((entry) => entry.status === "fail").length;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, results }, null, 2)}\n`);
  } else {
    for (const entry of results) {
      const mark = entry.status === "ok" ? "OK  " : entry.status === "fail" ? "HIBA" : "KIHAGY";
      process.stdout.write(`${mark} ${entry.name.padEnd(18)} ${entry.detail}\n`);
    }
    process.stdout.write(`\n${results.length} lépés · ${results.filter((entry) => entry.status === "ok").length} ok · ${failed} hiba\n`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

await main();
