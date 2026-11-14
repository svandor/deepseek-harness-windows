#!/usr/bin/env node
/**
 * patch-session-order.mjs — a session-lista rendezésének javítása a TELEPÍTETT
 * magban (verzióhoz kötött, visszafordítható overlay).
 *
 * A HIBA: a `dsh-api-session-controller` a sessionöket
 * `updatedAt = Math.max(header.createdAt, metadata.lastPromptAt)` szerint
 * rendezi, ahol a `lastPromptAt` **csak a felhasználói üzenetek** idejét követi
 * (`:1751`). Ha az ágens a felhasználó utolsó üzenete UTÁN dolgozott tovább, a
 * session a régi időponttal szerepel a listában — a felhasználó ezt „nem
 * időrendben vannak a munkamenetek"ként látja.
 *
 * A JAVÍTÁS: a fold minden esemény idejét figyelembe veszi (a mező neve marad,
 * a jelentése „legutóbbi aktivitás"), így a lista a valódi aktivitás szerint
 * rendeződik.
 *
 * HASZNÁLAT:
 *   node tools\patch-session-order.mjs            # száraz próba
 *   node tools\patch-session-order.mjs --apply    # patch + mentés
 *   node tools\patch-session-order.mjs --revert   # visszaállítás a mentésből
 *   node tools\patch-session-order.mjs --check    # csak állapot
 *
 * FONTOS: a patch a `node_modules` telepített példányát módosítja; egy
 * újratelepítés/`npx` frissítés felülírja. A mentés `<fájl>.bak-session-order`
 * néven marad, a `--revert` abból állít vissza.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NPX_ROOT = "C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules";
const TARGET = join(NPX_ROOT, "@deepseek-ai/dsh-api-session-controller/lib/index.js");
const TYPES_TARGET = join(NPX_ROOT, "@deepseek-ai/dsh-api-session-controller/lib/types/list.js");
const BACKUP = `${TARGET}.bak-session-order`;
const TYPES_BACKUP = `${TYPES_TARGET}.bak-session-order`;

const OLD_LINE = '\tconst lastPromptAt = event.type === "user/message" && event.data.source.kind === "user" ? event.time : state.lastPromptAt;';
const NEW_LINE = [
  "\t// PATCH (session-order, 2026-11-14): a lista a LEGUTOBBI AKTIVITAS szerint",
  "\t// rendezodjon, ne csak a felhasznaloi uzenet szerint — kulonben a session",
  "\t// lecsuszik, ha az agens dolgozott tovabb. A mezo neve marad.",
  "\tconst lastPromptAt = Number.isFinite(event.time) ? Math.max(state.lastPromptAt ?? 0, event.time) : state.lastPromptAt;"
].join("\n");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const REVERT = argv.includes("--revert");
const CHECK = argv.includes("--check");

if (existsSync(TARGET) !== true) {
  console.error(`HIBA: nem találom a célt: ${TARGET}`);
  process.exit(1);
}

if (CHECK) {
  const text = readFileSync(TARGET, "utf8");
  console.log(`cél: ${TARGET}`);
  console.log(`patch alkalmazva: ${text.includes("PATCH (session-order") === true ? "IGEN" : "nem"}`);
  console.log(`mentés létezik: ${existsSync(BACKUP) === true ? "IGEN" : "nem"}`);
  process.exit(0);
}

if (REVERT) {
  if (existsSync(BACKUP) !== true) {
    console.error(`HIBA: nincs mentés (${BACKUP}) — nem tudom visszaállítani`);
    process.exit(1);
  }
  copyFileSync(BACKUP, TARGET);
  if (existsSync(TYPES_BACKUP)) copyFileSync(TYPES_BACKUP, TYPES_TARGET);
  console.log("VISSZAÁLLÍTVA a mentésből. Újraindítás kell hozzá.");
  process.exit(0);
}

const text = readFileSync(TARGET, "utf8");
if (text.includes("PATCH (session-order") === true) {
  console.log("a patch már alkalmazva van — nincs teendő");
  process.exit(0);
}
if (text.includes(OLD_LINE) !== true) {
  console.error("HIBA: a várt sor nem található (a csomag verziója eltérhet):");
  console.error(`  ${OLD_LINE}`);
  process.exit(2);
}
const patched = text.replace(OLD_LINE, NEW_LINE);

// A `types/list.js` ugyanezt a foldot tartalmazza (a típus-alcsomag példánya);
// ha ott is megvan a sor, ott is javítjuk — különben a két példány eltér.
let patchedTypes = null;
if (existsSync(TYPES_TARGET)) {
  const typesText = readFileSync(TYPES_TARGET, "utf8");
  const typesOld = "const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'";
  if (typesText.includes(typesOld)) patchedTypes = typesText;
}

if (APPLY !== true) {
  console.log("SZÁRAZ PRÓBA: a patch alkalmazható (a várt sor megvan).");
  console.log(`  csere: 1 sor -> 4 sor`);
  console.log(`  mentés: ${BACKUP}`);
  process.exit(0);
}

copyFileSync(TARGET, BACKUP);
writeFileSync(TARGET, patched, "utf8");
console.log(`PATCH ALKALMAZVA: ${TARGET}`);
console.log(`mentés: ${BACKUP}`);
if (patchedTypes !== null) {
  console.log(`MEGJEGYZÉS: a ${TYPES_TARGET} külön fold-példányt tartalmaz; azt NEM írtam át (a futásidő az index.js-t használja).`);
}
console.log("Újraindítás kell hozzá, hogy a boot a javított kódot töltse.");
