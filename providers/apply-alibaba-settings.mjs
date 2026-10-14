// Alibaba settings.yaml konszolidalas (2026-10-14).
// MIT CSINAL: a ~/.dsh/settings.yaml `alibaba:` blokkjat kicsereli ket rutra:
//   alibaba         -> openai-responses, CSAK a harom flagship (merve mukodik)
//   alibaba-compat  -> openai-completions, a tobbi 33 ELŐ modell (+ VL/OCR)
// A 36 halott/nem szolgalo id-t elhagyja, a latast mert modellekre
// `input: [ text, image ]`-t tesz, es minden modellhez contextWindow/maxTokens-t.
// Emellett a subagent-model-selection.allowedModels listaba felveszi a
// vision-worker route-ot es az alibaba-compat/qwen3.7-flash gyermek-modellt.
// Futas: node providers/apply-alibaba-settings.mjs            (dry-run)
//        node providers/apply-alibaba-settings.mjs --apply    (ir + backup)
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const FILE = join(homedir(), ".dsh", "settings.yaml");
if (!existsSync(FILE)) { console.error("nincs settings.yaml:", FILE); process.exit(1); }

const raw = readFileSync(FILE, "utf8");
const EOL = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

// [id, contextWindow, maxTokens, latE?] — a latast MERES igazolja (3-jegyu szam
// beolvasasa), a "nem lat" modellekhez szandekosan nincs input mezо.
const RESPONSES = [
  ["qwen3.8-flash", 1000000, 65536, true],
  ["qwen3.8-max", 1000000, 131072, true],
  ["qwen3.8-max-0902", 1000000, 131072, true],
];
const COMPAT = [
  ["qwen3.7-plus", 1000000, 65536, true],
  ["qwen3.7-plus-2026-05-26", 1000000, 65536, true],
  ["qwen3.7-flash", 1000000, 32768, true],
  ["qwen3.7-flash-2026-07-15", 1000000, 32768, true],
  ["qwen3.7-max", 1000000, 65536, false],          // [M] kepet ELUTASIT
  ["qwen3.7-max-2026-05-20", 1000000, 65536, false], // [M] kepet ELUTASIT
  ["qwen3.7-max-2026-06-08", 1000000, 65536, true],
  ["qwen3.6-plus", 1000000, 32768, true],
  ["qwen3.6-plus-2026-04-02", 1000000, 32768, true],
  ["qwen3.6-flash", 1000000, 32768, true],
  ["qwen3.6-flash-2026-04-16", 1000000, 32768, true],
  ["qwen3.6-35b-a3b", 262144, 16384, true],
  ["qwen3.5-plus", 1000000, 32768, true],
  ["qwen3.5-plus-2026-02-15", 1000000, 32768, true],
  ["qwen3.5-flash", 1000000, 32768, true],
  ["qwen3.5-flash-2026-02-23", 1000000, 32768, true],
  ["qwen3.5-27b", 262144, 16384, true],
  ["qwen3.5-122b-a10b", 262144, 16384, true],
  ["qwen3.5-397b-a17b", 262144, 16384, true],
  ["qwen3-vl-plus", 262144, 32768, true],
  ["qwen-vl-ocr", 262144, 8192, true],
  ["qwen3-coder-flash", 1000000, 32768, false],     // [M] szovegesen tagadja a kepet
  ["qwen3-coder-flash-2025-07-28", 1000000, 32768, false],
  ["qwen-flash", 262144, 16384, false],             // [M] kepre HALLUCINAL ("123")
  ["qwen-flash-2025-07-28", 262144, 16384, false],  // [M] kepre HALLUCINAL
  ["qwen-plus", 262144, 16384, false],
  ["qwen-plus-2025-12-01", 262144, 16384, false],
  ["glm-5.1", 262144, 32768, false],
  ["glm-5.2", 262144, 32768, false],
  ["kimi-k2.5", 262144, 32768, true],
  ["kimi-k2.7-code", 262144, 32768, true],
  ["kimi-k3", 262144, 32768, true],
  ["deepseek-v4-flash-0731", 262144, 65536, false],
  ["deepseek-v4-pro", 262144, 65536, false],
];

const entry = ([id, ctx, max, img], indent) => [
  `${indent}- id: ${id}`,
  `${indent}  name: ${id}`,
  ...(img ? [`${indent}  input: [ text, image ]`] : []),
  `${indent}  contextWindow: ${ctx}`,
  `${indent}  maxTokens: ${max}`,
];

const BASE = "https://{EU-WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1";
const block = [
  "    # 2026-10-14: MERES alapjan ujraszervezve. A /responses uton csak a",
  "    # mainline Qwen csalad megy (a qwen3-vl-* 400 'Unsupported model'), a",
  "    # tobbi modell az alibaba-compat (openai-completions) ruton el erheto el.",
  "    # A meg nem szolgalt (404) es a nem chat modellek id-i torolve.",
  "    alibaba:",
  "      displayName: Alibaba Cloud (EU, responses)",
  "      apiKeyEnv: ALIBABA_API_KEY",
  "      api: openai-responses",
  `      baseURL: ${BASE}`,
  "      defaultContextWindow: 1000000",
  "      defaultMaxTokens: 65536",
  "      models:",
  ...RESPONSES.flatMap((m) => entry(m, "        ")),
  "    alibaba-compat:",
  "      displayName: Alibaba Cloud (EU, completions + VL/OCR)",
  "      apiKeyEnv: ALIBABA_API_KEY",
  "      api: openai-completions",
  `      baseURL: ${BASE}`,
  "      # A qwen thinking ezen a protokollon enable_thinking kapcsolot kap;",
  "      # nelkule a reasoning tartalom elveszne a forditasban.",
  "      compat:",
  "        thinkingFormat: qwen",
  "      defaultContextWindow: 262144",
  "      defaultMaxTokens: 32768",
  "      models:",
  ...COMPAT.flatMap((m) => entry(m, "        ")),
  "",
];

// ── 1. az alibaba blokk kicserelese ────────────────────────────────────────
const start = lines.findIndex((l) => l === "    alibaba:");
if (start === -1) { console.error("nem talalom a '    alibaba:' sort"); process.exit(1); }
let end = start + 1;
while (end < lines.length && !/^[^\s]/.test(lines[end])) end++;
const oldBlock = lines.slice(start, end);
const next = [...lines.slice(0, start), ...block, ...lines.slice(end)];

// ── 2. allowedModels kiegeszitese ──────────────────────────────────────────
const aIdx = next.findIndex((l) => l === "  allowedModels:");
if (aIdx !== -1) {
  const add = [
    "    # 2026-10-14: kep-feladat delegálása — a gyermek az Alibaba EU",
    "    # lató modelljeit hasznalja (a proxy vision-worker route-ja),",
    "    # a qwen3.7-flash kozvetlenul is valaszthato lató gyermek.",
    "    - provider: subagent-worker",
    "      model: vision-worker",
    "    - provider: alibaba-compat",
    "      model: qwen3.7-flash",
  ];
  next.splice(aIdx + 1, 0, ...add);
} else {
  console.error("FIGYELEM: '  allowedModels:' nem talalhato — a gyermek-lista valtozatlan");
}

console.log(`alibaba blokk: ${oldBlock.length} sor -> ${block.length} sor`);
console.log(`modellek: responses=${RESPONSES.length}, compat=${COMPAT.length} (osszesen ${RESPONSES.length + COMPAT.length})`);
console.log(`lató modell: ${[...RESPONSES, ...COMPAT].filter((m) => m[3]).length}`);
console.log(`allowedModels kiegeszites: ${aIdx === -1 ? "NEM" : "igen"}`);

if (!APPLY) { console.log("\n(dry-run — add hozza a --apply kapcsolot az irashoz)"); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const bak = `${FILE}.bak-${stamp}-alibaba`;
copyFileSync(FILE, bak);
writeFileSync(FILE, next.join(EOL), "utf8");
console.log(`\nIRAS KESZ. Backup: ${bak}`);
