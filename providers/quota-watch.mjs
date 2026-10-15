// INGYENES KERET FIGYELŐ — automatikus, rendszeres ellenőrzés.
//
// A MERCE A SZAMLA: amig egy szingapuri modell az ingyenes keretbol megy, NEM
// szerepel a havi szamlan; amint a keret kifogy, onnantol fizetoskent bekerul.
// Ez API-val elerheto (a console-hitelesitesu `bl usage free` helyett), ezert
// ez a jel automatizalhato. A sajat becslesunk (reports/quota-used.json) csak
// elorejelez: 80% felett figyelmeztet.
//
//   node providers/quota-watch.mjs            (riport)
//   node providers/quota-watch.mjs --apply    (a kifogyottakat fizetosre allitja)
//
// Kilepesi kod: 1, ha barmelyik keret kifogyott (a heti feladat jelzi).
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const APPLY = process.argv.includes("--apply");
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const STATE = join(HERE, "reports", "quota-used.json");

let used = {};
try { used = JSON.parse(readFileSync(STATE, "utf8")).used ?? {}; } catch { used = {}; }

const { getAlibabaBilling } = await import(`file://${join(HERE, "bss-client.mjs").replace(/\\/g, "/")}`);
const billing = await getAlibabaBilling();
const billedModels = new Set((billing?.byModel ?? []).map((m) => m.model));
// FONTOS: a szamla byModel bontasa nem kulonbozteti meg az EU es a szingapuri
// AZONOS NEVU modelleket. Ezert csak akkor jelentunk kifogyast, ha a szingapuri
// regio EGYALTALAN szamlaz ebben a ciklusban (kulonben egy EU-s tetel tevesen
// kifogyottnak jelolne az SG-keretet).
function sgWorkspaceId() {
  try {
    const url = process.env.ALIBABA_SG_BASE_URL
      ?? (readFileSync(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh"), ".credentials.yaml"), "utf8")
        .match(/^\s{2}ALIBABA_SG_BASE_URL:\s*(\S+)\s*$/m) ?? [])[1];
    return (/^https:\/\/([a-z0-9-]+)\./i.exec(url ?? "") ?? [])[1] ?? null;
  } catch { return null; }
}
const sgWorkspace = sgWorkspaceId();
const sgBilled = Number((billing?.byWorkspace ?? []).find((w) => w.workspace === sgWorkspace)?.usd ?? 0);
const sgIsBilling = sgWorkspace !== null && sgBilled > 0;
if (!sgIsBilling) console.log(`  (SZINGAPUR nem szamlaz ebben a ciklusban${sgWorkspace ? `, workspace ${sgWorkspace.slice(0, 6)}…` : ""} -> keret-kifogyast NEM jelzunk)`);

const rows = [];
for (const [label, meta] of Object.entries(CONFIG.pricing ?? {})) {
  if (label.startsWith("_") || !Number.isFinite(meta.freeQuotaTokens) || meta.freeQuotaTokens <= 0) continue;
  const model = label.replace(/^alibaba(-intl)?\//, "");
  const estimatedUsed = Number(used[label] ?? 0);
  rows.push({
    label,
    model,
    estimatedUsed,
    usedShare: Math.min(1, estimatedUsed / meta.freeQuotaTokens),
    billed: sgIsBilling && billedModels.has(model),
  });
}

console.log(`=== INGYENES KERET FIGYELŐ — ciklus ${billing?.cycle ?? "?"} (a számla a mérce) ===`);
if (rows.length === 0) console.log("  nincs aktiv ingyenes-keretu cel a configban");
for (const r of rows) {
  const state = r.billed
    ? "KIFOGYOTT — a szamlan mar fizetoskent szerepel"
    : `${(r.usedShare * 100).toFixed(1)}% becsult fogyas`;
  console.log(`  ${r.label.padEnd(32)} ${state}${r.billed ? "" : `  (${Math.round(r.estimatedUsed).toLocaleString("hu-HU")} token)`}`);
}
const exhausted = rows.filter((r) => r.billed);
const nearLimit = rows.filter((r) => !r.billed && r.usedShare >= 0.8);
if (nearLimit.length > 0) {
  console.log(`\nFIGYELEM: 80% felett jar: ${nearLimit.map((r) => `${r.label} (${(r.usedShare * 100).toFixed(0)}%)`).join(", ")}`);
  console.log("  -> ha kifogy, a szamlan megjelenik, es ez a szkript fizetosre allitja.");
}
if (exhausted.length === 0) {
  console.log("\nMinden figyelt keret meg aktiv (a szamlan nem szerepelnek).");
  process.exitCode = 0;
} else {
  console.log(`\nKIFOGYOTT keretek: ${exhausted.map((r) => r.label).join(", ")}`);
  if (APPLY) {
    const next = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    let changed = 0;
    for (const r of exhausted) {
      const meta = next.pricing?.[r.label];
      if (meta && meta.freeQuotaTokens > 0) { meta.freeQuotaTokens = 0; changed += 1; }
    }
    if (changed > 0) {
      copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-quota`);
      writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
      console.log(`  -> ${changed} cel allitva fizetosre a config.json-ban (a proxy hot-reloadolja)`);
    } else {
      console.log("  -> mar mind fizetosre volt allitva");
    }
  } else {
    console.log("  -> futtasd --apply kapcsoloval a fizetosre allitashoz");
  }
  process.exitCode = 1;
}
