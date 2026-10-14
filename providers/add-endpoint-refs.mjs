// A fiókspecifikus Alibaba-végpontok felvétele a credential-store-ba.
//   node providers/add-endpoint-refs.mjs "<EU base URL>" "<SG base URL>" [--apply]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APPLY = process.argv.includes("--apply");
const [eu, sg] = argv;
if (!eu || !sg) { console.error("hasznalat: node add-endpoint-refs.mjs <EU url> <SG url> [--apply]"); process.exit(1); }

const FILE = join(homedir(), ".dsh", ".credentials.yaml");
if (!existsSync(FILE)) { console.error("nincs credential-store"); process.exit(1); }
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
const a = put("ALIBABA_EU_BASE_URL", eu);
const b = put("ALIBABA_SG_BASE_URL", sg);
// A workspace-azonositot csak maszkolva irjuk ki.
const mask = (u) => String(u).replace(/(https:\/\/)([a-z0-9-]+)(\.)/i, (m, p1, p2, p3) => p1 + p2.slice(0, 6) + "…" + p3);
console.log(`ALIBABA_EU_BASE_URL: ${a} (${mask(eu)})`);
console.log(`ALIBABA_SG_BASE_URL: ${b} (${mask(sg)})`);
if (!APPLY) { console.log("\n(dry-run — add hozza a --apply kapcsolot)"); process.exit(0); }
copyFileSync(FILE, `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-endpoints`);
writeFileSync(FILE, lines.join(EOL), "utf8");
const check = readFileSync(FILE, "utf8");
console.log(check.includes(eu) && check.includes(sg) ? "IRAS OK — mindket vegpont rogzitve." : "FIGYELEM: ellenorzes nem talalta mindket erteket!");
