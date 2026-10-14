// A szingapúri (ap-southeast-1) workspace-kulcs felvetele a DSH
// credential-store-ba DASHSCOPE_API_KEY neven. A CSV-bol olvas, a kulcsot
// NEM irja ki. Idobelyeges backup keszul.
//   node providers/add-sg-key.mjs "<csv path>"            (dry-run)
//   node providers/add-sg-key.mjs "<csv path>" --apply
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const csvPath = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!csvPath || !existsSync(csvPath)) { console.error("hasznalat: node add-sg-key.mjs <csv> [--apply]"); process.exit(1); }

const csv = readFileSync(csvPath, "utf8");
const key = csv.split(/\r?\n/).find((l) => l.startsWith("apiKey,"))?.slice("apiKey,".length).trim();
const workspace = csv.split(/\r?\n/).find((l) => l.startsWith("workspaceId,"))?.slice("workspaceId,".length).trim();
if (!key) { console.error("nincs apiKey a CSV-ben"); process.exit(1); }

const FILE = join(homedir(), ".dsh", ".credentials.yaml");
const raw = readFileSync(FILE, "utf8");
const EOL = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);
const refsIdx = lines.findIndex((l) => l === "refs:");
if (refsIdx === -1) { console.error("nincs 'refs:' a credential-store-ban"); process.exit(1); }
const existing = lines.findIndex((l, i) => i > refsIdx && /^\s{2}DASHSCOPE_API_KEY:\s*/.test(l));

console.log(`kulcs: ${key.slice(0, 6)}… (hossz ${key.length}) | workspace: ${workspace}`);
console.log(existing === -1 ? "DASHSCOPE_API_KEY: MEG NINCS -> beszurás a refs alá" : `DASHSCOPE_API_KEY: mar letezik (${existing + 1}. sor) -> csere`);
if (!APPLY) { console.log("\n(dry-run — add hozza a --apply kapcsolot)"); process.exit(0); }

copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-sg`);
if (existing === -1) lines.splice(refsIdx + 1, 0, `  DASHSCOPE_API_KEY: ${key}`);
else lines[existing] = `  DASHSCOPE_API_KEY: ${key}`;
writeFileSync(FILE, lines.join(EOL), "utf8");

const check = readFileSync(FILE, "utf8");
const ok = new RegExp(`^\\s{2}DASHSCOPE_API_KEY:\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(check);
console.log(ok ? "IRAS OK — DASHSCOPE_API_KEY rogzitve." : "FIGYELEM: az ellenorzes nem talalta a kulcsot!");
