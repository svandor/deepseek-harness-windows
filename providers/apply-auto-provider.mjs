// Az "Auto" modell felvetele a DSH model-valasztoba (settings.yaml).
// Egy kulon provider blokkot szur be a proxyra mutatva, igy a GUI
// /model listajaban megjelenik az intelligens valaszto.
//   node providers/apply-auto-provider.mjs            (dry-run)
//   node providers/apply-auto-provider.mjs --apply
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const FILE = join(homedir(), ".dsh", "settings.yaml");
if (!existsSync(FILE)) { console.error("nincs settings.yaml"); process.exit(1); }

const raw = readFileSync(FILE, "utf8");
const EOL = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

if (lines.some((l) => l === "    auto-router:")) {
  console.log("az auto-router provider mar letezik — nincs teendo.");
  process.exit(0);
}
const anchor = lines.findIndex((l) => l === "    groq:");
if (anchor === -1) { console.error("nem talalom a '    groq:' anchort"); process.exit(1); }

const block = [
  "    # 2026-10-14: INTELLIGENS MODELLVALASZTO a helyi proxy `auto` route-jan.",
  "    # A proxy a keres TARTALMA (kep, becsult token) es az IDO (DeepSeek",
  "    # csucsablak 01-04/06-10 UTC) szerint valt celpontot: deepseek-flash ->",
  "    # szingapúri/frankfurti qwen3.8-flash. Meres: a csucsablakban 2,65x/3,14x",
  "    # olcsobb; kep eseten lató modell; beragadt cel cooldownnal a lanc vegere",
  "    # kerul. A route-ok a providers/config.json-ban szerkeszthetok.",
  "    auto-router:",
  "      displayName: Auto (proxy, intelligens valaszto)",
  "      apiKeyEnv: SUBAGENT_WORKER_API_KEY",
  "      api: openai-completions",
  "      baseURL: http://127.0.0.1:4123/v1",
  "      defaultContextWindow: 1000000",
  "      defaultMaxTokens: 65536",
  "      models:",
  "        - id: auto",
  "          name: Auto (kep / csucs / hosszu kontextus szerint)",
  "          contextWindow: 1000000",
  "          maxTokens: 65536",
  "        - id: vision-worker",
  "          name: Vision worker (kep-delegalas, proxy)",
  "          contextWindow: 1000000",
  "          maxTokens: 32768",
  "",
];
const next = [...lines.slice(0, anchor), ...block, ...lines.slice(anchor)];

// allowedModels: az Auto gyermek-modellkent is valaszthato legyen
const aIdx = next.findIndex((l) => l === "  allowedModels:");
let addedAllowed = false;
if (aIdx !== -1) {
  next.splice(aIdx + 1, 0, "    - provider: auto-router", "      model: auto");
  addedAllowed = true;
}

console.log(`provider blokk beszurva a ${anchor + 1}. sor ele (${block.length} sor)`);
console.log(`allowedModels kiegeszites: ${addedAllowed ? "igen" : "nem (nincs anchor)"}`);
if (!APPLY) { console.log("\n(dry-run — add hozza a --apply kapcsolot)"); process.exit(0); }

copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-auto`);
writeFileSync(FILE, next.join(EOL), "utf8");
console.log("IRAS KESZ (backup keszult).");
