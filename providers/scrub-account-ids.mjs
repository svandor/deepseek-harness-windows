// FIÓKSPECIFIKUS ADATOK KISZERVEZÉSE a nyilvános repóból (2026-10-15).
//
// A workspace-azonosítók (és a rájuk épülő végpont-címek) nem kerülhetnek a
// nyilvános repóba: a KÓD és a METÓDUS marad, az értékek a credential-store-ba
// (ALIBABA_EU_BASE_URL / ALIBABA_SG_BASE_URL) vagy környezeti változóba mennek.
//
// FONTOS: ez a szkript SZÁNDÉKOSAN nem tartalmaz azonosítót — a címeket a
// credential-store-ból oldja fel, különben a saját szövege visszahozná őket.
//
// Amit tesz:
//   1. providers/alibaba-endpoints.mjs létrehozása (a címek feloldása),
//   2. a probe-/apply szkriptekben a beégetett cím -> euBase()/sgBase(),
//   3. config.json: baseURL -> baseURLEnv (a proxy oldja fel),
//   4. autotune.mjs: a workspace->régió térkép a címekből származik,
//   5. ALIBABA-MERES.md: az azonosítók helyőrzőre cserélése.
//
// Futtatás: node providers/scrub-account-ids.mjs [--apply]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const APPLY = process.argv.includes("--apply");

/** A címek a credential-store-ból (env vagy ~/.dsh/.credentials.yaml). */
function endpoint(name) {
  if (process.env[name]) return process.env[name];
  const file = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh"), ".credentials.yaml");
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, "utf8").match(new RegExp(`^\\s{2}${name}:\\s*(\\S+)\\s*$`, "m"));
  return m ? m[1] : undefined;
}
const idOf = (url) => (/^https:\/\/([a-z0-9-]+)\./i.exec(url ?? "") ?? [])[1];
const EU_URL = endpoint("ALIBABA_EU_BASE_URL");
const SG_URL = endpoint("ALIBABA_SG_BASE_URL");
const EU_ID = idOf(EU_URL);
const SG_ID = idOf(SG_URL);
if (!EU_ID || !SG_ID) {
  console.error("nincs ALIBABA_EU_BASE_URL / ALIBABA_SG_BASE_URL a credential-store-ban — nincs mit scrubbolni.");
  process.exit(1);
}

const changes = [];
function rewrite(rel, transform) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) return;
  changes.push({ file: rel, bytes: after.length - before.length });
  if (APPLY) {
    copyFileSync(path, `${path}.bak-scrub`);
    writeFileSync(path, after, "utf8");
  }
}

const IMPORT_LINE = 'import { euBase, sgBase } from "./alibaba-endpoints.mjs";';
for (const rel of [
  "providers/probe-alibaba.mjs",
  "providers/probe-alibaba2.mjs",
  "providers/probe-alibaba3.mjs",
  "providers/probe-alibaba-images.mjs",
  "providers/probe-singapore.mjs",
  "providers/apply-alibaba-settings.mjs"
]) {
  rewrite(rel, (text) => {
    let out = text.split(EU_URL).join("euBase()").split(SG_URL).join("sgBase()");
    out = out.replace(/"\$\{?euBase\(\)\}?"/g, "euBase()").replace(/"\$\{?sgBase\(\)\}?"/g, "sgBase()");
    if (out !== text && !out.includes("alibaba-endpoints.mjs")) {
      const lines = out.split("\n");
      const firstImport = lines.findIndex((l) => l.startsWith("import "));
      lines.splice(firstImport === -1 ? 0 : firstImport, 0, IMPORT_LINE);
      out = lines.join("\n");
    }
    return out;
  });
}

rewrite("providers/config.json", (text) => text
  .split(`"baseURL": "${EU_URL}"`).join('"baseURLEnv": "ALIBABA_EU_BASE_URL"')
  .split(`"baseURL": "${SG_URL}"`).join('"baseURLEnv": "ALIBABA_SG_BASE_URL"')
  .split(EU_ID).join("{EU-WorkspaceId}")
  .split(SG_ID).join("{SG-WorkspaceId}"));

rewrite("providers/autotune.mjs", (text) => {
  if (!text.includes(EU_ID)) return text;
  const replacement = `// A workspace-azonositok a credential-store-bol (env) szarmaznak, nem a repobol.
const WORKSPACE_REGION = {};
{
  const eu = (/([a-z0-9-]+)\\.eu-central-1\\./i.exec(process.env.ALIBABA_EU_BASE_URL ?? credKey("ALIBABA_EU_BASE_URL") ?? "") ?? [])[1];
  const sg = (/([a-z0-9-]+)\\.ap-southeast-1\\./i.exec(process.env.ALIBABA_SG_BASE_URL ?? credKey("ALIBABA_SG_BASE_URL") ?? "") ?? [])[1];
  if (eu) WORKSPACE_REGION[eu] = "EU";
  if (sg) WORKSPACE_REGION[sg] = "SG";
}`;
  return text.replace(/const WORKSPACE_REGION = \{[^}]*\};/s, replacement);
});

rewrite("providers/ALIBABA-MERES.md", (text) => text
  .split(EU_ID).join("{EU-WorkspaceId}")
  .split(SG_ID).join("{SG-WorkspaceId}"));

console.log(`=== SCRUB ${APPLY ? "(ALKALMAZVA)" : "(dry-run)"} ===`);
if (changes.length === 0) console.log("  nincs valtozas");
for (const c of changes) console.log(`  ${c.file}`);
if (!APPLY) console.log("\n(add hozza a --apply kapcsolat)");
