// Alibaba Cloud RAM AccessKey felvetele a DSH credential-store-ba (BSS szamla-
// lekerdezeshez). A kulcsokat NEM irja ki. Idobelyeges backup keszul.
//   node providers/add-alibaba-cloud-keys.mjs <AccessKeyId> <AccessKeySecret> [--apply]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");
const [id, secret] = argv;
if (!id || !secret) { console.error("hasznalat: node add-alibaba-cloud-keys.mjs <id> <secret> [--apply]"); process.exit(1); }

const FILE = join(homedir(), ".dsh", ".credentials.yaml");
if (!existsSync(FILE)) { console.error("nincs credential-store:", FILE); process.exit(1); }
const raw = readFileSync(FILE, "utf8");
const EOL = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);
const refsIdx = lines.findIndex((l) => l === "refs:");
if (refsIdx === -1) { console.error("nincs 'refs:' szekcio"); process.exit(1); }

const put = (name, value) => {
  const i = lines.findIndex((l, k) => k > refsIdx && new RegExp(`^\\s{2}${name}:\\s*`).test(l));
  if (i === -1) lines.splice(refsIdx + 1, 0, `  ${name}: ${value}`);
  else lines[i] = `  ${name}: ${value}`;
  return i === -1 ? "beszurva" : "csere";
};
const a = put("ALIBABA_CLOUD_ACCESS_KEY_ID", id);
const b = put("ALIBABA_CLOUD_ACCESS_KEY_SECRET", secret);
console.log(`ALIBABA_CLOUD_ACCESS_KEY_ID:     ${a} (${id.slice(0, 6)}…, hossz ${id.length})`);
console.log(`ALIBABA_CLOUD_ACCESS_KEY_SECRET: ${b} (hossz ${secret.length})`);
if (!APPLY) { console.log("\n(dry-run — add hozza a --apply kapcsolot)"); process.exit(0); }

copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-bss`);
writeFileSync(FILE, lines.join(EOL), "utf8");
const check = readFileSync(FILE, "utf8");
const okId = check.includes(`ALIBABA_CLOUD_ACCESS_KEY_ID: ${id}`);
const okSecret = check.includes(`ALIBABA_CLOUD_ACCESS_KEY_SECRET: ${secret}`);
console.log(okId && okSecret ? "IRAS OK — mindket kulcs rogzitve." : "FIGYELEM: az ellenorzes nem talalta mindket kulcsot!");
