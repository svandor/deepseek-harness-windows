// A pro modell felvetele a gyermek-valaszthato modellek koze (ESZKALACIO).
// A flash igy kepes felfele eszkalalni: tomor brief-fel (~$0,02) a pro-hoz,
// szemben a teljes kontextus atvitelevel (~$0,21, cache-vesztes).
//   node providers/apply-escalation-model.mjs [--apply]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const FILE = join(homedir(), ".dsh", "settings.yaml");
if (!existsSync(FILE)) { console.error("nincs settings.yaml"); process.exit(1); }

const raw = readFileSync(FILE, "utf8");
const EOL = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

if (lines.some((l) => l.includes("model: deepseek-v4-pro"))) {
  console.log("a deepseek-v4-pro mar szerepel az allowedModels listaban — nincs teendo.");
  process.exit(0);
}
const aIdx = lines.findIndex((l) => l === "  allowedModels:");
if (aIdx === -1) { console.error("nem talalom az '  allowedModels:' anchort"); process.exit(1); }

const block = [
  "    # 2026-10-14: ESZKALACIO (felfele). A flash gyermek-t a nehez dontesi",
  "    # pontra pro modellre lehet kuldeni TOMOR BRIEF-FEL: ~$0,02 belepes,",
  "    # szemben a teljes beszelgetes atvitelevel (~$0,21, mert a modellvaltas",
  "    # a cache-t is elviszi). Merve: egy flash-lepes ~$0,001-0,002, tehat a",
  "    # brief-eszkalacio ~21 elrontott lepes utan megtérul; a teljes kontextus",
  "    # atvitele csak ~220 utan. Ezert a FELADATOT eszkalaljuk, nem a beszelgetest.",
  "    - provider: deepseek-official",
  "      model: deepseek-v4-pro",
];
const next = [...lines.slice(0, aIdx + 1), ...block, ...lines.slice(aIdx + 1)];
console.log(`beillesztes a ${aIdx + 2}. sorba (${block.length} sor)`);
if (!APPLY) { console.log("\n(dry-run — add hozza a --apply kapcsolot)"); process.exit(0); }

copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-escalation`);
writeFileSync(FILE, next.join(EOL), "utf8");
console.log("IRAS KESZ (backup keszult).");
