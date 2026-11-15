#!/usr/bin/env node
/**
 * A DSH mag kliens-bundle-jeinek MAGYAR cimke-foltja.
 *
 * MIÉRT KELL: a mag `ctx.locale.register(ns, …)` **eldobja** a már létező nyelvet
 * ("locale namespace … already has locale …" — mért viselkedés a
 * dsh-client-locale 1256–1264. sorában), ezért a mag címeit pluginból NEM lehet
 * felülírni. A magyar címke pótlása csak a telepített bundle szótárának
 * bővítésével megy — ugyanúgy, ahogy a `patch-session-order.mjs` a
 * session-sorrenddel.
 *
 * A FOLT ALAKJA (mért): a bundle-nek nincs `hu` szótára, ezért a `hu` csomagot
 * az `en` csomagból SZÁRMAZTATJUK (`{ ...en, … }`), így minden kulcs megmarad
 * (a nem fordítottak angolul jelennek meg, ahogy eddig is), és csak a kért
 * címkék lesznek magyarok. A `register` hívás argumentumlistájába bekerül a
 * `hu` is.
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

const CORE = "C:\\Users\\info\\AppData\\Local\\npm-cache\\_npx\\b86ed90107c62dab\\node_modules\\@deepseek-ai";

/**
 * Egy folt: a KERESETT szövegrész és a helyére írandó rész.
 * A `find` a bundle pontos, mért szövege (behúzással együtt).
 */
const PATCHES = [
  {
    name: "agent-preset: Standard mode -> Alap",
    file: join(CORE, "dsh-client-ui-agent-preset", "lib", "client.js"),
    find: `			ctx.effect(() => ctx.locale.register("settings.agentPreset", {
				zh,
				en
			}), "ui-agent-preset: settings row dictionaries");`,
    replace: `			const hu = { ...en,
				presetStandardName: "Alap",
				presetStandardDescription: "Teljes kodolo ugynok: fajlszerkesztes, shell, fajl- es webkereses, skillek, tervezes, celok, alugynokok, workflow-k."
			};
			ctx.effect(() => ctx.locale.register("settings.agentPreset", {
				zh,
				en,
				hu
			}), "ui-agent-preset: settings row dictionaries");`,
  },
];

function backupPath(file) {
  return `${file}.bak-labels`;
}

function state(patch) {
  if (!existsSync(patch.file)) return "missing-file";
  const text = readFileSync(patch.file, "utf8");
  if (text.includes(patch.replace.trim().slice(0, 60))) return "patched";
  if (!text.includes(patch.find)) return "anchor-missing";
  return "unpatched";
}

const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--revert") ? "revert" : "check";
console.log(`=== mag-cimke foltok (${mode}) ===`);
let problems = 0;
for (const patch of PATCHES) {
  const current = state(patch);
  if (mode === "check") {
    console.log(`  ${patch.name.padEnd(38)} ${current}`);
    if (current !== "patched") problems++;
    continue;
  }
  if (mode === "revert") {
    const backup = backupPath(patch.file);
    if (!existsSync(backup)) {
      console.log(`  ${patch.name}: nincs mentes (${backup})`);
      continue;
    }
    copyFileSync(backup, patch.file);
    console.log(`  ${patch.name}: visszaallitva`);
    continue;
  }
  // apply
  if (current === "patched") {
    console.log(`  ${patch.name}: mar foltozva`);
    continue;
  }
  if (current !== "unpatched") {
    console.log(`  ${patch.name}: NEM ALKALMAZHATO (${current}) - a bundle valtozott, a foltot frissiteni kell`);
    problems++;
    continue;
  }
  const text = readFileSync(patch.file, "utf8");
  copyFileSync(patch.file, backupPath(patch.file));
  writeFileSync(patch.file, text.replace(patch.find, patch.replace), "utf8");
  console.log(`  ${patch.name}: foltozva (mentes: ${backupPath(patch.file)})`);
}
if (mode === "check") {
  console.log("");
  console.log(problems === 0 ? "EREDMENY: minden folt a helyen" : `EREDMENY: ${problems} folt nem a helyen`);
  process.exit(problems === 0 ? 0 : 1);
}
