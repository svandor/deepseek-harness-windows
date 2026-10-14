// A BSS szamla-valaszok NYERS szerkezetenek feltarasa (egyszeri diagnosztika).
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
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hmacHex = (k, s) => createHmac("sha256", k).update(s).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function call(host, action, version, params = {}) {
  const query = { Action: action, Version: version, Format: "JSON", ...params };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join("&");
  const hashedPayload = sha256hex("");
  const headers = {
    host,
    "x-acs-action": action,
    "x-acs-version": version,
    "x-acs-date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": randomUUID(),
    "x-acs-content-sha256": hashedPayload,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k].trim()}\n`).join("");
  const canonicalRequest = ["POST", "/", canonicalQuery, canonicalHeaders, signedHeaders, hashedPayload].join("\n");
  const signature = hmacHex(AK_SECRET, `ACS3-HMAC-SHA256\n${sha256hex(canonicalRequest)}`);
  const res = await fetch(`https://${host}/?${canonicalQuery}`, {
    method: "POST",
    headers: { ...headers, authorization: `ACS3-HMAC-SHA256 Credential=${AK_ID},SignedHeaders=${signedHeaders},Signature=${signature}` },
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const HOST = "business.ap-southeast-1.aliyuncs.com";
const cycle = new Date().toISOString().slice(0, 7);
const bill = await call(HOST, "QueryAccountBill", "2017-12-14", { BillingCycle: cycle, Granularity: "MONTHLY" });
console.log("=== QueryAccountBill " + cycle + " — HTTP " + bill.status + " ===");
console.log(JSON.stringify(bill.json, null, 1).slice(0, 2200));
const inst = await call(HOST, "DescribeInstanceBill", "2017-12-14", { BillingCycle: cycle, Granularity: "MONTHLY", MaxResults: "5" });
console.log("\n=== DescribeInstanceBill (elso tetelek) ===");
const items = inst.json?.Data?.Items ?? inst.json?.Data?.Item ?? [];
const list = Array.isArray(items) ? items : (items?.Item ?? []);
for (const it of list.slice(0, 5)) {
  console.log("  " + JSON.stringify({
    ProductCode: it.ProductCode ?? it.ProductName,
    InstanceID: it.InstanceID,
    PretaxAmount: it.PretaxAmount,
    PaymentAmount: it.PaymentAmount,
    OutstandingAmount: it.OutstandingAmount,
    Currency: it.Currency,
    BillingDate: it.BillingDate,
  }));
}
