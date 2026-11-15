#!/usr/bin/env node
/**
 * A DSH mag kliens-bundle-jeinek MAGYAR cimke-foltja.
 *
 * MIÉRT KELL: a mag `ctx.locale.register(ns, …)` **eldobja** a már létező
 * nyelvet ("locale namespace … already has locale …" — mért viselkedés a
 * dsh-client-locale 1256–1264. sorában), ezért a mag címeit pluginból NEM
 * lehet felülírni. A magyar címke pótlása csak a telepített bundle
 * szótárának bővítésével megy — ugyanúgy, ahogy a `patch-session-order.mjs`
 * teszi a session-sorrenddel.
 *
 * Amit csinál:
 *   1. megkeresi a megadott bundle `hu: {` szótárának kezdetét,
 *   2. ha a kulcs még nincs benne, beszúrja a magyar értéket,
 *   3. `*.bak-labels` mentést készít, a `--revert` visszaállítja.
 *
 * Használat:
 *   node tools/patch-core-labels.mjs --check
 *   node tools/patch-core-labels.mjs --apply
 *   node tools/patch-core-labels.mjs --revert
 *
 * FONTOS: a DSH frissítése felülírja a mag bundle-t, ezért frissítés után
 * futtasd újra az `--apply`-t (a `--check` kimondja, kell-e).
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/** A mag bundle-jei (npx cache), ahol a címkék élnek. */
const CORE = "C:\\Users\\info\\AppData\\Local\\npm-cache\\_npx\\b86ed90107c62dab\\node_modules\\@deepseek-ai";

/**
 * Egy folt: melyik bundle-ben, melyik kulcsot, milyen magyar értékkel.
 *
 * A `namespace` csak dokumentáció (a szótár a fájlban van); a `key` a
 * locale-kulcs, az `value` a magyar szöveg.
 */
const PATCHES = [
  {
    file: join(CORE, "dsh-client-ui-agent-preset", "lib", "client.js"),
    key: "presetStandardName",
    value: "Alap",
    why: "a fejléc modellválasztója: 'Standard mode' -> 'Alap'",
  },
];

function backupPath(file) {
  return `${file}.bak-labels`;
}

/** A `hu: {` szótár kezdetének indexe a fájlban (vagy -1). */
function findHuDictionary(text) {
  const match = /(^|\n)(\s*)hu:\s*\{/u.exec(text);
  return match ? match.index + match[0].length : -1;
}

function checkPatch(patch) {
  if (!existsSync(patch.file)) return { state: "missing-file" };
  const text = readFileSync(patch.file, "utf8");
  const keyPattern = new RegExp(`${patch.key}\\s*:`, "u");
  const marker = `/* dsh-patch: ${patch.key} */`;
  const patched = text.includes(marker);
  return { state: patched ? "patched" : "unpatched", hasKey: keyPattern.test(text), text };
}

function applyPatch(patch) {
  const info = checkPatch(patch);
  if (info.state === "missing-file") return `HIÁNYZIK: ${patch.file}`;
  if (info.state === "patched") return `már foltozva: ${patch.key}`;
  const at = findHuDictionary(info.text);
  if (at < 0) return `nincs hu: szótár ebben: ${patch.file}`;
  copyFileSync(patch.file, backupPath(patch.file));
  const insertion = ` /* dsh-patch: ${patch.key} */ ${patch.key}: ${JSON.stringify(patch.value)},`;
  const patched = info.text.slice(0, at) + insertion + info.text.slice(at);
  writeFileSync(patch.file, patched, "utf8");
  return `foltozva: ${patch.key} = "${patch.value}" (mentés: ${backupPath(patch.file)})`;
}

function revertPatch(patch) {
  const backup = backupPath(patch.file);
  if (!existsSync(backup)) return `nincs mentés: ${backup}`;
  copyFileSync(backup, patch.file);
  return `visszaállítva: ${patch.file}`;
}

const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--revert") ? "revert" : "check";
console.log(`=== mag-címke foltok (${mode}) ===`);
let problems = 0;
for (const patch of PATCHES) {
  const info = checkPatch(patch);
  if (mode === "check") {
    console.log(`  ${patch.key.padEnd(22)} ${info.state.padEnd(12)} ${patch.why}`);
    if (info.state !== "patched") problems++;
  } else if (mode === "apply") {
    console.log("  " + applyPatch(patch));
  } else {
    console.log("  " + revertPatch(patch));
  }
}
if (mode === "check") {
  console.log("");
  console.log(problems === 0 ? "EREDMÉNY: minden folt a helyén" : `EREDMÉNY: ${problems} folt hiányzik (futtasd: --apply)`);
  process.exit(problems === 0 ? 0 : 1);
}
