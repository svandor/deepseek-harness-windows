// KÖZÖS BSS-KLIENS (Alibaba Cloud számlázás) — ACS3-HMAC-SHA256, SDK nélkül.
//
// MERVE 2026-10-14: a nemzetkozi vegpont mukodik (business.ap-southeast-1),
// a kínai business.aliyuncs.com nem. RAM AccessKey kell
// (`AliyunBSSReadOnlyAccess`), a kulcsok a DSH credential-store-bol vagy
// kornyezeti valtozobol jonnek.
//
// Hasznalat:
//   import { getAlibabaBilling, closingDate } from "./bss-client.mjs";
//   const b = await getAlibabaBilling();   // { ok, cycle, totalUsd, byWorkspace, byModel, ... }
import { readFileSync, existsSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const BSS_HOST = "business.ap-southeast-1.aliyuncs.com";

/** Kulcs a kornyezetbol vagy a DSH credential-store `refs:` szakaszabol. */
export function credential(name) {
  if (process.env[name]) return process.env[name];
  const file = join(homedir(), ".dsh", ".credentials.yaml");
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, "utf8").match(new RegExp(`^\\s{2}${name}:\\s*(\\S+)\\s*$`, "m"));
  return m ? m[1] : undefined;
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hmacHex = (k, s) => createHmac("sha256", k).update(s).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** ACS3-HMAC-SHA256 alairt BSS RPC hivas (ures torzs, query parameterek). */
export async function bssCall(action, version, params = {}) {
  const keyId = credential("ALIBABA_CLOUD_ACCESS_KEY_ID");
  const keySecret = credential("ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  if (!keyId || !keySecret) throw new Error("nincs ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET");
  const query = { Action: action, Version: version, Format: "JSON", ...params };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join("&");
  const hashedPayload = sha256hex("");
  const headers = {
    host: BSS_HOST,
    "x-acs-action": action,
    "x-acs-version": version,
    "x-acs-date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": randomUUID(),
    "x-acs-content-sha256": hashedPayload,
  };
  const token = credential("ALIBABA_CLOUD_SECURITY_TOKEN");
  if (token) headers["x-acs-security-token"] = token;
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${String(headers[k]).trim()}\n`).join("");
  const canonicalRequest = ["POST", "/", canonicalQuery, canonicalHeaders, signedHeaders, hashedPayload].join("\n");
  const signature = hmacHex(keySecret, `ACS3-HMAC-SHA256\n${sha256hex(canonicalRequest)}`);
  const res = await fetch(`https://${BSS_HOST}/?${canonicalQuery}`, {
    method: "POST",
    headers: { ...headers, authorization: `ACS3-HMAC-SHA256 Credential=${keyId},SignedHeaders=${signedHeaders},Signature=${signature}` },
    signal: AbortSignal.timeout(25000),
  });
  return await res.json().catch(() => null);
}

/** A ciklus (naptari honap) zarasa ISO datummal. */
export function closingDate(cycle) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(cycle ?? ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]), 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A havi szamla + egyenleg + tételes bontas (modell es workspace szerint).
 * A DescribeInstanceBill InstanceID formatuma: "<pip>;<workspace>;<model>;<token_tipus>;<n>".
 */
export async function getAlibabaBilling(cycle = new Date().toISOString().slice(0, 7)) {
  const [bill, balance, instances] = await Promise.all([
    bssCall("QueryAccountBill", "2017-12-14", { BillingCycle: cycle, Granularity: "MONTHLY" }).catch(() => null),
    bssCall("QueryAccountBalance", "2017-12-14", {}).catch(() => null),
    bssCall("DescribeInstanceBill", "2017-12-14", { BillingCycle: cycle, Granularity: "MONTHLY", MaxResults: "300" }).catch(() => null),
  ]);
  const raw = instances?.Data?.Items?.Item ?? instances?.Data?.Items ?? [];
  const list = Array.isArray(raw) ? raw : [];
  const byModel = new Map();
  const byWorkspace = new Map();
  for (const row of list) {
    const parts = String(row?.InstanceID ?? "").split(";");
    const workspace = parts[1] ?? "(ismeretlen)";
    const model = parts[2] ?? "(ismeretlen)";
    const amount = Number(row?.PretaxAmount ?? 0);
    byModel.set(model, (byModel.get(model) ?? 0) + amount);
    byWorkspace.set(workspace, (byWorkspace.get(workspace) ?? 0) + amount);
  }
  const item = bill?.Data?.Items?.Item?.[0] ?? null;
  return {
    ok: bill?.Success === true,
    cycle,
    closingDate: closingDate(cycle),
    currency: item?.Currency ?? "USD",
    totalUsd: Number(item?.PretaxAmount ?? 0),
    grossUsd: Number(item?.PretaxGrossAmount ?? 0),
    availableUsd: Number(balance?.Data?.AvailableAmount ?? 0),
    accountId: bill?.Data?.AccountID ?? null,
    lineItems: list.length,
    byModel: [...byModel.entries()].map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
    byWorkspace: [...byWorkspace.entries()].map(([workspace, usd]) => ({ workspace, usd })).sort((a, b) => b.usd - a.usd),
    error: bill?.Success === true ? null : (bill?.Message ?? "a BSS valasz nem ertelmezheto"),
  };
}
