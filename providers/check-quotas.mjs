// ALIBABA KORLAT-LEKERDEZES (RPM/TPM) — amit az API-kulcs VALÓBAN tud.
//
// MERVE 2026-10-14:
//   - a workspace-domain (/api/v1/quotas) 404-el valaszol (EU es SG is),
//   - a REGI internacionalis hoston (dashscope-intl.aliyuncs.com) a szingapúri
//     kulccsal 200-at ad (177 modell),
//   - az EU-kulcs ott 401 (regiohoz kotott), tehat EU-ra ez az ut nem jarhato.
//
// Egyenleg/ingyenes keret: az API-kulccsal NEM kerdezheto (a `bl usage free`
// console-hitelesitesu, a szamla-egyenleg RAM AccessKey-t ker).
//
// Futtatas: node providers/check-quotas.mjs [modell,modell,...]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WANTED = (process.argv[2] ?? "qwen3.8-flash,qwen3.7-flash,qwen3.8-max,qwen3-coder-flash,deepseek-v4.1-flash,glm-5.3,kimi-k3").split(",");
const cred = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const key = cred.match(/^\s*DASHSCOPE_API_KEY:\s*(\S+)\s*$/m)?.[1];
if (!key) { console.error("nincs DASHSCOPE_API_KEY a credential-store-ban"); process.exit(1); }

const BASE = "https://dashscope-intl.aliyuncs.com";
// A szerver korlatozza a lapmeretet: page_size=500-ra URES lapot ad (merve),
// ezert 100-as lapokban kerdezzuk le az egesz listat.
const rows = [];
let total = null;
for (let page = 1; page <= 8; page++) {
  const res = await fetch(`${BASE}/api/v1/quotas?page_no=${page}&page_size=100`, {
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1); }
  const body = await res.json();
  const batch = body?.output?.quotas ?? [];
  if (total === null) total = body?.output?.total ?? batch.length;
  rows.push(...batch);
  if (batch.length === 0 || rows.length >= total) break;
}
console.log(`=== ALIBABA (SZINGAPÚR) MODELL-KORLÁTOK — ${rows.length}/${total} modell, ${BASE} ===`);
const fmtLimit = (l) => {
  if (!l) return "nincs beallitas";
  const rpm = l.request_limit_period === 60 ? `${l.request_limit} RPM` : `${l.request_limit} / ${l.request_limit_period}s`;
  const tpm = l.usage_limit === null || l.usage_limit === undefined
    ? "TPM korlat nelkul"
    : `${l.usage_limit.toLocaleString("hu-HU")} ${l.usage_limit_field ?? "token"} / ${l.usage_limit_period}s`;
  return `${rpm} · ${tpm}`;
};
const found = new Map(rows.map((r) => [r.model, r]));
for (const model of WANTED) {
  const row = found.get(model);
  const acct = row ? fmtLimit(row.model_limit) : "nincs adat";
  const ws = row?.workspace_limit ? fmtLimit(row.workspace_limit) : "nincs workspace-szintu korlat";
  console.log(`  ${model.padEnd(28)} account: ${acct.padEnd(52)} | workspace: ${ws}`);
}
const missing = WANTED.filter((m) => !found.has(m));
if (missing.length > 0) console.log(`\n  (nincs a listaban: ${missing.join(", ")})`);
