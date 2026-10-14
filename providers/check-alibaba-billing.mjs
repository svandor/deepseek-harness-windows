// ALIBABA SZAMLA-EGYENLEG lekerdezese RAM AccessKey-jel (BSS OpenAPI).
//
// MIERT KULON KULCS: a modell-API kulcs (sk-ws-...) szamlazast NEM tud
// olvasni — ahhoz RAM-felhasznalo kell `bss:DescribeBillingAccount` /
// `AliyunBSSReadOnlyAccess` joggal, es a hozza tartozo AccessKey ID + Secret.
//
// Hitelesites: ACS3-HMAC-SHA256 (V3), kulso SDK nelkul.
// Vegpontok/API-k, amiket sorban probal:
//   1. business.aliyuncs.com            + QueryAccountBalance (2017-12-14)
//   2. business.ap-southeast-1.aliyuncs.com + QueryAccountBalance (2017-12-14)
//   3. business.aliyuncs.com            + GetFundAccountAvailableAmount (2023-09-30)
//   4. business.ap-southeast-1.aliyuncs.com + GetFundAccountAvailableAmount (2023-09-30)
//
// Kulcsok: kornyezeti valtozo VAGY a DSH credential-store:
//   ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET
//   (+ ALIBABA_CLOUD_SECURITY_TOKEN, ha STS ideiglenes kulcs)
//
// Futtatas: node providers/check-alibaba-billing.mjs
import { readFileSync, existsSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

function cred(name) {
  if (process.env[name]) return process.env[name];
  const p = join(homedir(), ".dsh", ".credentials.yaml");
  if (!existsSync(p)) return undefined;
  const m = readFileSync(p, "utf8").match(new RegExp(`^\\s{2}${name}:\\s*(\\S+)\\s*$`, "m"));
  return m ? m[1] : undefined;
}

const AK_ID = cred("ALIBABA_CLOUD_ACCESS_KEY_ID");
const AK_SECRET = cred("ALIBABA_CLOUD_ACCESS_KEY_SECRET");
const STS = cred("ALIBABA_CLOUD_SECURITY_TOKEN");

if (!AK_ID || !AK_SECRET) {
  console.log("=== ALIBABA EGYENLEG — nincs beallitva ===");
  console.log("A modell-API kulcs (sk-ws-...) szamlazast NEM tud olvasni. Kell egy RAM-felhasznalo");
  console.log("`AliyunBSSReadOnlyAccess` (vagy bss:DescribeBillingAccount + bss:QueryAccountBalance)");
  console.log("joggal, es a ket ertek a credential-store-ba:");
  console.log("  ALIBABA_CLOUD_ACCESS_KEY_ID: <AccessKey ID>");
  console.log("  ALIBABA_CLOUD_ACCESS_KEY_SECRET: <AccessKey Secret>");
  process.exit(2);
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hmacHex = (key, s) => createHmac("sha256", key).update(s).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** ACS3-HMAC-SHA256 alairt RPC keres (POST, ures torzs, query paramok). */
async function call(host, action, version, params = {}) {
  const query = { Action: action, Version: version, Format: "JSON", ...params };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join("&");
  const body = "";
  const hashedPayload = sha256hex(body);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = randomUUID();
  const headers = {
    host,
    "x-acs-action": action,
    "x-acs-version": version,
    "x-acs-date": date,
    "x-acs-signature-nonce": nonce,
    "x-acs-content-sha256": hashedPayload,
  };
  if (STS) headers["x-acs-security-token"] = STS;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${String(headers[k]).trim()}\n`).join("");
  const canonicalRequest = ["POST", "/", canonicalQuery, canonicalHeaders, signedHeaders, hashedPayload].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256hex(canonicalRequest)}`;
  const signature = hmacHex(AK_SECRET, stringToSign);
  const authorization = `ACS3-HMAC-SHA256 Credential=${AK_ID},SignedHeaders=${signedHeaders},Signature=${signature}`;
  const res = await fetch(`https://${host}/?${canonicalQuery}`, {
    method: "POST",
    headers: { ...headers, authorization },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const tries = [
  ["business.aliyuncs.com", "QueryAccountBalance", "2017-12-14"],
  ["business.ap-southeast-1.aliyuncs.com", "QueryAccountBalance", "2017-12-14"],
  ["business.aliyuncs.com", "GetFundAccountAvailableAmount", "2023-09-30"],
  ["business.ap-southeast-1.aliyuncs.com", "GetFundAccountAvailableAmount", "2023-09-30"],
];

console.log(`=== ALIBABA EGYENLEG (AccessKey ${AK_ID.slice(0, 6)}…, ${STS ? "STS" : "hosszu tavu"}) ===`);
let ok = 0;
for (const [host, action, version] of tries) {
  try {
    const r = await call(host, action, version);
    const code = r.json?.Code ?? r.json?.code ?? "";
    const msg = r.json?.Message ?? r.json?.message ?? "";
    const data = r.json?.Data ?? r.json?.data ?? r.json ?? {};
    const interesting = {};
    for (const k of ["AvailableAmount", "AvailableCashAmount", "CashAmount", "CreditAmount", "MybankCreditAmount", "Currency", "QuotaLimit", "AvailableQuota", "FundAccountId", "AccountId"]) {
      if (data?.[k] !== undefined) interesting[k] = data[k];
    }
    const good = r.status === 200 && (r.json?.Success === true || Object.keys(interesting).length > 0);
    if (good) ok++;
    console.log(`  ${good ? "OK  " : "HIBA"} ${host.padEnd(38)} ${action} v${version} — HTTP ${r.status}${code ? `, ${code}: ${msg}` : ""}`);
    if (Object.keys(interesting).length > 0) console.log(`        ${JSON.stringify(interesting)}`);
    else if (!good) console.log(`        ${String(r.text).slice(0, 200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`  HIBA ${host.padEnd(38)} ${action} — ${String(e?.message ?? e).slice(0, 100)}`);
  }
}
console.log(ok > 0
  ? "\nVan mukodo hivas: az egyenleg bekoltheto a panelbe es az autotune-riportba."
  : "\nEgyik vegpont/API sem valaszolt erdemi adattal — lehet, hogy a nemzetkozi fiok mas API-t hasznal, vagy hianyzik a bss jogosultsag.");

// ── 2. SZAMLA (month-to-date fizetendo) — ez a valodi "negativ egyenleg" ──
const cycle = new Date().toISOString().slice(0, 10).slice(0, 7);
console.log(`\n=== ALIBABA SZAMLA (${cycle}) ===`);
const billTries = [
  ["business.ap-southeast-1.aliyuncs.com", "QueryAccountBill", "2017-12-14", { BillingCycle: cycle, Granularity: "MONTHLY" }],
  ["business.aliyuncs.com", "QueryAccountBill", "2017-12-14", { BillingCycle: cycle, Granularity: "MONTHLY" }],
  ["business.ap-southeast-1.aliyuncs.com", "DescribeInstanceBill", "2017-12-14", { BillingCycle: cycle, Granularity: "MONTHLY" }],
  ["business.ap-southeast-1.aliyuncs.com", "QueryAccountBalance", "2017-12-14", {}],
];
let billOk = 0;
for (const [host, action, version, params] of billTries) {
  try {
    const r = await call(host, action, version, params);
    const code = r.json?.Code ?? "";
    const msg = r.json?.Message ?? "";
    const data = r.json?.Data ?? r.json?.data ?? {};
    const interesting = {};
    const scan = (obj, prefix = "") => {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (/Amount|Payment|Pretax|Outstanding|Currency|BillAmount|Total/i.test(k) && (typeof v === "string" || typeof v === "number")) {
          interesting[prefix + k] = v;
        } else if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(interesting).length < 14) {
          scan(v, `${prefix}${k}.`);
        }
      }
    };
    scan(data);
    const good = r.status === 200 && (r.json?.Success === true || Object.keys(interesting).length > 0);
    if (good) billOk++;
    console.log(`  ${good ? "OK  " : "HIBA"} ${host.padEnd(38)} ${action} — HTTP ${r.status}${code ? `, ${code}: ${String(msg).slice(0, 70)}` : ""}`);
    if (Object.keys(interesting).length > 0) console.log(`        ${JSON.stringify(interesting).slice(0, 400)}`);
  } catch (e) {
    console.log(`  HIBA ${host.padEnd(38)} ${action} — ${String(e?.message ?? e).slice(0, 90)}`);
  }
}
if (billOk === 0) console.log("  (a szamla-API nem elerheto ezzel a kulccsal — a konzol osszege marad a viszonyitasi alap)");

