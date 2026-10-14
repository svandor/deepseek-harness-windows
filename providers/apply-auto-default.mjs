// Az "Auto" modell a valasztolista ELEJERE es alapertelmezett modellne.
//   node providers/apply-auto-default.mjs [--apply]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const FILE = join(homedir(), ".dsh", "settings.yaml");
if (!existsSync(FILE)) { console.error("nincs settings.yaml"); process.exit(1); }

const raw = readFileSync(FILE, "utf8");
const EOL = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

// 1. az auto-router blokk kiemelese
const start = lines.findIndex((l) => l === "    auto-router:");
if (start === -1) { console.error("nem talalom a '    auto-router:' blokkot"); process.exit(1); }
let end = start + 1;
while (end < lines.length && !/^    [a-z0-9-]+:\s*$/.test(lines[end])) end++;
const block = lines.slice(start, end);
lines.splice(start, end - start);

// 2. beszurasa a providers: ELEJERE (a valaszto ezt a sorrendet koveti)
const pIdx = lines.findIndex((l) => l === "  providers:");
if (pIdx === -1) { console.error("nem talalom a '  providers:' sort"); process.exit(1); }
lines.splice(pIdx + 1, 0, ...block);

// 3. alapertelmezett modell = auto-router/auto (uj beszelgetes Auto-n indul)
const dIdx = lines.findIndex((l) => l === "agent-default-model:");
if (dIdx === -1) { console.error("nem talalom az 'agent-default-model:' sort"); process.exit(1); }
const before = { provider: lines[dIdx + 1], model: lines[dIdx + 2] };
lines[dIdx + 1] = "  provider: auto-router";
lines[dIdx + 2] = "  model: auto";

console.log(`auto-router blokk: ${block.length} sor athelyezve a providers ELEJERE`);
console.log(`alapertelmezett modell: ${before.provider?.trim()} / ${before.model?.trim()}  ->  provider: auto-router / model: auto`);
if (!APPLY) { console.log("\n(dry-run — add hozza a --apply kapcsolot)"); process.exit(0); }

copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-autodefault`);
writeFileSync(FILE, lines.join(EOL), "utf8");
console.log("IRAS KESZ (backup keszult).");
