// AUTOTUNE — automatikus újramérés es optimalizalas (2026-10-14).
//
// CIKLUS:
//   1. MERES   — a valos session-naplokbol: keresmeretek, cache-arany,
//                kimenet/keres, lepesek, porgo-munka aranya, celonkenti koltseg.
//   2. KALIBRALAS — a szelektor hangolasi parametereinek ujraszamolasa a MERT
//                ertekekbol (assumedCachedShare, assumedOutputTokens,
//                assumedRemainingSteps), korlatokkal.
//   3. ELLENORZES — minden provider /models katalogusa: el-e meg minden
//                jelolt/route-cel; latencia-meres; hibajelzes nem zero exit.
//   4. ARFIGYELES — a gyari arlista ujraolvasasa (pricing-parser.mjs) es diff a
//                config `pricing` tabljahoz. Arat CSAK --apply-prices ir.
//   5. ALKALMAZAS  — --apply eseten a hangolasi ertekek beirasa a config.json-ba
//                (backup + csak a valtozott kulcsok), a proxy hot-reloadolja.
//   6. JELENTES    — providers/reports/autotune-<ido>.json + trend az elozo
//                futashoz kepest.
//
// Futtatas: node providers/autotune.mjs [--days 30] [--apply] [--apply-prices]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const REPORTS = join(HERE, "reports");
const SESSIONS = join(homedir(), ".dsh", "sessions");
const CREDS = join(homedir(), ".dsh", ".credentials.yaml");

const argv = process.argv.slice(2);
const DAYS = Number(argv[argv.indexOf("--days") + 1]) || 30;
const APPLY = argv.includes("--apply");
const APPLY_PRICES = argv.includes("--apply-prices");
const SINCE = Date.now() - DAYS * 24 * 3600 * 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

// ── 1. MERES ──────────────────────────────────────────────────────────────
async function frame(b) {
  return new Promise((res) => {
    const s = createZstdDecompress(); const c = [];
    s.on("data", (x) => c.push(x));
    s.on("end", () => res({ text: Buffer.concat(c).toString("utf8"), consumed: s.bytesWritten }));
    s.on("error", () => res({ text: "", consumed: b.length }));
    s.end(b);
  });
}
async function readLog(p) {
  const buf = readFileSync(p); let off = 0; let out = "";
  while (off < buf.length) { const f = await frame(buf.subarray(off)); if (f.consumed <= 0) break; off += f.consumed; out += f.text; }
  return out;
}
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".jsonl.zstd") && statSync(p).size > 0) acc.push(p);
  }
  return acc;
}

function isPeak(t) {
  const d = new Date(t); const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
// A MERESHEZ a config arablaja (a proxy ugyanezt hasznalja).
function costOf(label, miss, hit, out, time) {
  const table = CONFIG.pricing ?? {};
  const meta = table[label] ?? table["deepseek/deepseek-flash"] ?? { miss: 0.15, hit: 0.003, out: 0.6 };
  const size = miss + hit;
  const tier = Array.isArray(meta.tiers) ? (meta.tiers.find((t) => size <= t.upTo) ?? meta.tiers[meta.tiers.length - 1]) : meta;
  const peak = isPeak(time);
  const mr = (peak && tier.peakMiss) || tier.miss || 0;
  const hr = (peak && tier.peakHit) || tier.hit || mr * 0.1;
  const or = (peak && tier.peakOut) || tier.out || 0;
  return (miss * mr + hit * hr + out * or) / 1e6;
}

const sessions = [];
for (const file of walk(SESSIONS)) {
  let text; try { text = await readLog(file); } catch { continue; }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) continue;
  let header = null; try { header = JSON.parse(lines[0]); } catch {}
  const deleg = (header?.delegationDepth ?? 0) > 0 || header?.origin === "subagent";
  const s = { deleg, requests: 0, miss: 0, hit: 0, out: 0, steps: 0, costUsd: 0, outs: [], maxRepeat: 0, firstLoopAt: null, labels: new Map() };
  const calls = new Map();
  for (const line of lines) {
    if (line.indexOf('"assistant/message"') === -1 && line.indexOf('"tool/call"') === -1 && line.indexOf('"step/start"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.time === "number" && e.time < SINCE) continue;
    if (e.type === "step/start") { s.steps += 1; continue; }
    if (e.type === "tool/call") {
      const key = `${e.data?.name ?? "?"}|${String(e.data?.arguments ?? "").slice(0, 400)}`;
      const n = (calls.get(key) ?? 0) + 1; calls.set(key, n);
      if (n > s.maxRepeat) s.maxRepeat = n;
      if (n >= 3 && s.firstLoopAt === null) s.firstLoopAt = e.time ?? null;
      continue;
    }
    if (e.type !== "assistant/message") continue;
    const u = e.data?.usage; if (!u) continue;
    const src = e.data?.message?.source ?? e.data?.source ?? {};
    const label = src.provider ? `${src.provider}/${src.model}` : String(src.model ?? "");
    s.requests += 1; s.miss += u.inputTokens || 0; s.hit += u.cacheReadTokens || 0; s.out += u.outputTokens || 0;
    s.outs.push(u.outputTokens || 0);
    s.costUsd += costOf(label, u.inputTokens || 0, u.cacheReadTokens || 0, u.outputTokens || 0, e.time ?? Date.now());
    s.labels.set(label, (s.labels.get(label) ?? 0) + 1);
  }
  if (s.requests > 0) sessions.push(s);
}

const all = sessions;
const sums = all.reduce((a, s) => ({ requests: a.requests + s.requests, miss: a.miss + s.miss, hit: a.hit + s.hit, out: a.out + s.out, costUsd: a.costUsd + s.costUsd }), { requests: 0, miss: 0, hit: 0, out: 0, costUsd: 0 });
const median = (arr) => { if (arr.length === 0) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const cacheShare = sums.miss + sums.hit > 0 ? sums.hit / (sums.miss + sums.hit) : 0;
const outPerRequest = median(all.flatMap((s) => s.outs));
const stepsPerSession = median(all.map((s) => s.steps));
const loopSessions = all.filter((s) => s.maxRepeat >= 3);
const loopShare = all.length > 0 ? loopSessions.length / all.length : 0;

const measured = {
  days: DAYS,
  sessions: all.length,
  mainSessions: all.filter((s) => !s.deleg).length,
  requests: sums.requests,
  missTokens: sums.miss,
  cacheTokens: sums.hit,
  outTokens: sums.out,
  cacheShare: Number(cacheShare.toFixed(4)),
  outPerRequest: Math.round(outPerRequest),
  stepsPerSession: Math.round(stepsPerSession),
  loopShares: Number(loopShare.toFixed(4)),
  loopSessions: loopSessions.length,
  costUsd: Number(sums.costUsd.toFixed(4)),
  costPerRequest: Number((sums.costUsd / Math.max(1, sums.requests)).toFixed(6)),
};

// ── 2. KALIBRALAS ─────────────────────────────────────────────────────────
const proposed = {
  assumedCachedShare: Number(clamp(cacheShare * 0.98, 0.6, 0.95).toFixed(3)),
  assumedOutputTokens: Math.round(clamp(outPerRequest, 200, 4000)),
  assumedRemainingSteps: Math.round(clamp(stepsPerSession / 8, 4, 16)),
};
const warnings = [];
if (cacheShare < 0.4 && measured.requests > 200) warnings.push(`a mert cache-arany nagyon alacsony (${(cacheShare * 100).toFixed(1)}%) — a hangolas ovatos marad`);

// ── 3. ELLEENORZES: elo katalogusok es latencia ───────────────────────────
function credKey(name) {
  if (!existsSync(CREDS)) return undefined;
  const m = readFileSync(CREDS, "utf8").match(new RegExp(`^\\s{2}${name}:\\s*(\\S+)\\s*$`, "m"));
  return m ? m[1] : undefined;
}
async function checkProvider(id, def) {
  const key = process.env[def.apiKeyEnv] ?? credKey(def.apiKeyEnv) ?? def.apiKey;
  if (!key && !def.optionalKey) return { id, ok: false, reason: `nincs kulcs (${def.apiKeyEnv})` };
  // A fiókspecifikus cím a credential-store-ból/env-ből (baseURLEnv), nem a repóból.
  const rawBase = (def.baseURLEnv ? (process.env[def.baseURLEnv] ?? credKey(def.baseURLEnv)) : undefined) ?? def.baseURL;
  if (!rawBase) return { id, ok: false, reason: `nincs baseURL (${def.baseURLEnv ?? "baseURL"})` };
  const base = String(rawBase).replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    const ms = Date.now() - t0;
    const j = await res.json().catch(() => null);
    const ids = (j?.data ?? j?.models ?? []).map((m) => m.id ?? m.name);
    return { id, ok: res.ok, status: res.status, ms, count: ids.length, ids };
  } catch (e) {
    return { id, ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}
const providerChecks = [];
const catalogs = new Map();
for (const [id, def] of Object.entries(CONFIG.providers ?? {})) {
  const r = await checkProvider(id, def);
  providerChecks.push({ id: r.id, ok: r.ok, status: r.status ?? null, ms: r.ms ?? null, models: r.count ?? null, reason: r.reason ?? null });
  if (r.ids) catalogs.set(id, new Set(r.ids));
}
// El-e meg minden jelolt es route-cel?
const missingTargets = [];
for (const [routeName, route] of Object.entries(CONFIG.routes ?? {})) {
  const list = [...(route?.targets ?? []), ...(route?.candidates ?? [])];
  for (const t of list) {
    const [pid, ...rest] = String(t).split("/");
    const model = rest.join("/");
    const cat = catalogs.get(pid);
    if (!cat) continue;                       // nincs katalogus (pl. helyi ollama) -> nem ítélünk
    if (cat.has(model)) continue;
    // Az OpenRouter a ":free" variánst nem feltétlenül listázza: ha a bázis-id
    // megvan, a cél él (a variáns ugyanannak a modellnek a csomagja).
    const base = model.replace(/:free$/, "");
    if (base !== model && cat.has(base)) continue;
    // Számozott/dátumozott utótag: a bázis-id megléte elég.
    const undated = base.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{4}$/, "");
    if (undated !== base && cat.has(undated)) continue;
    missingTargets.push({ route: routeName, target: t });
  }
}
if (missingTargets.length > 0) warnings.push(`${missingTargets.length} cel mar nem szerepel a szolgaltato katalogusaban`);

// ── 3b. Alibaba keret-korlatok (amit az API-kulcs VALOBAN tud) ────────────
// MERVE: a workspace-domain /api/v1/quotas 404; a REGI internacionalis hoston
// (dashscope-intl) a szingapuri kulccsal 200. Egyenleget/ingyenes keretet az
// API-kulcs nem ad (az console-hitelesitesu), de a VALODI RPM/TPM korlatokat
// igen — ez a kapacitas-tervezeshez kell (a Groq 8000 TPM-jehez kepest).
let quotaSnapshot = null;
try {
  const sgKey = process.env.DASHSCOPE_API_KEY ?? credKey("DASHSCOPE_API_KEY");
  if (sgKey) {
    const wanted = ["qwen3.8-flash", "qwen3.7-flash", "qwen3.8-max", "qwen3-coder-flash", "deepseek-v4.1-flash"];
    const rows = [];
    let total = null;
    for (let page = 1; page <= 8; page++) {
      const res = await fetch(`https://dashscope-intl.aliyuncs.com/api/v1/quotas?page_no=${page}&page_size=100`, {
        headers: { authorization: `Bearer ${sgKey}` }, signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) break;
      const body = await res.json().catch(() => null);
      const batch = body?.output?.quotas ?? [];
      if (total === null) total = body?.output?.total ?? batch.length;
      rows.push(...batch);
      if (batch.length === 0 || rows.length >= total) break;
    }
    quotaSnapshot = {
      host: "dashscope-intl.aliyuncs.com",
      total,
      models: rows.filter((r) => wanted.includes(r.model)).map((r) => ({ model: r.model, limit: r.model_limit })),
    };
  }
} catch (e) {
  warnings.push(`keret-lekerdezes hiba: ${String(e?.message ?? e).slice(0, 90)}`);
}

// ── 3c. SZAMLA-EGYEZTETES (BSS) ───────────────────────────────────────────
// A gyari szamla (modell- es workspace-szintu tételes bontassal) vs a
// naplobol becsult koltseg. A ket szam kulonbozik, mert a naplo csak a DSH-n
// ATMENT hivasokat latja — ezert a parositas EGYUTT ertelmes: a szamla a
// ground truth, a naplo mutatja, mennyi jutott a DSH-ra.
async function scanAlibabaCycle(cycle) {
  const perModel = new Map();
  const perRegion = new Map();
  for (const file of walk(SESSIONS)) {
    let text; try { text = await readLog(file); } catch { continue; }
    for (const line of text.split("\n")) {
      if (line.indexOf('"assistant/message"') === -1) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (typeof e.time !== "number" || new Date(e.time).toISOString().slice(0, 7) !== cycle) continue;
      const u = e.data?.usage; if (!u) continue;
      const src = e.data?.message?.source ?? e.data?.source ?? {};
      const label = src.provider ? `${src.provider}/${src.model}` : String(src.model ?? "");
      if (!/^alibaba(-intl)?\//.test(label)) continue;
      const c = costOf(label, u.inputTokens || 0, u.cacheReadTokens || 0, u.outputTokens || 0, e.time);
      const model = label.replace(/^alibaba(-intl)?\//, "");
      perModel.set(model, (perModel.get(model) ?? 0) + c);
      const region = label.startsWith("alibaba-intl/") ? "SG" : "EU";
      perRegion.set(region, (perRegion.get(region) ?? 0) + c);
    }
  }
  return {
    perModel: [...perModel.entries()].map(([model, usd]) => ({ model, usd })).sort((a, b) => b.usd - a.usd),
    perRegion: Object.fromEntries(perRegion),
    totalUsd: [...perModel.values()].reduce((a, b) => a + b, 0),
  };
}

// A workspace-azonositok a credential-store-bol (env) szarmaznak, nem a repobol.
const WORKSPACE_REGION = {};
{
  const eu = (/([a-z0-9-]+)\.eu-central-1\./i.exec(process.env.ALIBABA_EU_BASE_URL ?? credKey("ALIBABA_EU_BASE_URL") ?? "") ?? [])[1];
  const sg = (/([a-z0-9-]+)\.ap-southeast-1\./i.exec(process.env.ALIBABA_SG_BASE_URL ?? credKey("ALIBABA_SG_BASE_URL") ?? "") ?? [])[1];
  if (eu) WORKSPACE_REGION[eu] = "EU";
  if (sg) WORKSPACE_REGION[sg] = "SG";
}
let invoice = null;
try {
  const bss = await import(`file://${join(HERE, "bss-client.mjs").replace(/\\/g, "/")}`);
  const billing = await bss.getAlibabaBilling();
  if (billing && billing.ok) {
    const logged = await scanAlibabaCycle(billing.cycle);
    const byRegion = {};
    for (const w of billing.byWorkspace) {
      const region = WORKSPACE_REGION[w.workspace] ?? w.workspace;
      byRegion[region] = (byRegion[region] ?? 0) + w.usd;
    }
    invoice = {
      cycle: billing.cycle,
      closingDate: billing.closingDate,
      currency: billing.currency,
      totalUsd: billing.totalUsd,
      grossUsd: billing.grossUsd,
      availableUsd: billing.availableUsd,
      lineItems: billing.lineItems,
      byRegion,
      byModel: billing.byModel.slice(0, 12),
      logged,
      deltaUsd: Number((billing.totalUsd - logged.totalUsd).toFixed(6)),
    };
  } else if (billing) {
    warnings.push(`szamla-lekerdezes nem sikerult: ${billing.error}`);
  }
} catch (e) {
  warnings.push(`szamla-lekerdezes hiba: ${String(e?.message ?? e).slice(0, 90)}`);
}

// ── 4. ARFIGYELES (opcionalis parser) ─────────────────────────────────────
let priceDiff = null;
const parserPath = join(HERE, "pricing-parser.mjs");
if (existsSync(parserPath)) {
  try {
    const { parsePrices } = await import(`file://${parserPath.replace(/\\/g, "/")}`);
    const txtPath = join(HERE, "model-pricing.txt");
    if (existsSync(txtPath)) {
      const parsed = parsePrices(readFileSync(txtPath, "utf8"));
      const rows = [];
      for (const [label, meta] of Object.entries(CONFIG.pricing ?? {})) {
        if (label.startsWith("_")) continue;
        const [pid, ...rest] = label.split("/");
        const model = rest.join("/");
        const scope = pid === "alibaba-intl" ? "International" : "Global";
        const found = parsed?.[model]?.[scope];
        const tier = Array.isArray(found?.tiers) ? found.tiers[0] : null;
        if (!tier) continue;
        const cur = Array.isArray(meta.tiers) ? meta.tiers[0] : meta;
        const newMiss = tier.idleMiss ?? tier.miss;
        const newOut = tier.idleOut ?? tier.out;
        if (Math.abs((cur.miss ?? 0) - newMiss) > 1e-9 || Math.abs((cur.out ?? 0) - newOut) > 1e-9) {
          rows.push({ label, scope, currentMiss: cur.miss, currentOut: cur.out, parsedMiss: newMiss, parsedOut: newOut });
        }
      }
      priceDiff = { checked: Object.keys(CONFIG.pricing).filter((k) => !k.startsWith("_")).length, changes: rows };
      if (rows.length > 0) warnings.push(`${rows.length} ar-sor elter a gyari arlistatol (--apply-prices irja be)`);
    }
  } catch (e) {
    warnings.push(`ar-parser hiba: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}

// ── 5. ALKALMAZAS ─────────────────────────────────────────────────────────
const applied = { tuning: {}, prices: [] };
if (APPLY) {
  const next = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  let changed = false;
  for (const [k, v] of Object.entries(proposed)) {
    if (next[k] !== v) { next[k] = v; applied.tuning[k] = v; changed = true; }
  }
  if (APPLY_PRICES && priceDiff) {
    for (const row of priceDiff.changes) {
      const meta = next.pricing[row.label];
      if (!meta) continue;
      const tiers = Array.isArray(meta.tiers) ? meta.tiers : [meta];
      tiers[0].miss = row.parsedMiss;
      tiers[0].out = row.parsedOut;
      if (!Array.isArray(meta.tiers)) { meta.miss = row.parsedMiss; meta.out = row.parsedOut; }
      applied.prices.push(row.label);
      changed = true;
    }
  }
  if (changed) {
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-autotune`);
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  }
}

// ── 6. JELENTES + TREND ───────────────────────────────────────────────────
if (!existsSync(REPORTS)) mkdirSync(REPORTS, { recursive: true });
const files = existsSync(REPORTS) ? readdirSync(REPORTS).filter((f) => f.startsWith("autotune-")).sort() : [];
let previous = null;
if (files.length > 0) {
  try { previous = JSON.parse(readFileSync(join(REPORTS, files[files.length - 1]), "utf8")); } catch {}
}
const trend = previous ? {
  costPerRequest: Number((measured.costPerRequest - previous.measured.costPerRequest).toFixed(6)),
  cacheShare: Number((measured.cacheShare - previous.measured.cacheShare).toFixed(4)),
  loopShares: Number((measured.loopShares - previous.measured.loopShares).toFixed(4)),
  requests: measured.requests - previous.measured.requests,
} : null;

const report = {
  ranAt: new Date().toISOString(),
  days: DAYS,
  applied: APPLY ? applied : null,
  measured,
  proposed,
  providerChecks,
  quotaSnapshot,
  invoice,
  missingTargets,
  priceDiff,
  warnings,
  trend,
};
const reportPath = join(REPORTS, `autotune-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

const usd = (n) => "$" + n.toFixed(4);
console.log(`=== AUTOTUNE (${DAYS} nap, ${measured.sessions} session, ${measured.requests.toLocaleString("hu-HU")} keres) ===`);
console.log(`  koltseg: ${usd(measured.costUsd)} | keresenkent: ${usd(measured.costPerRequest)}`);
console.log(`  cache-arany: ${(measured.cacheShare * 100).toFixed(2)}% | kimenet/keres (median): ${measured.outPerRequest} token | lepes/session (median): ${measured.stepsPerSession}`);
console.log(`  porgo sessionok (max ismetles >= 3): ${measured.loopSessions} (${(measured.loopShares * 100).toFixed(1)}%)`);
console.log("\n=== JAVASOLT HANGOLAS ===");
for (const [k, v] of Object.entries(proposed)) {
  const cur = CONFIG[k];
  console.log(`  ${k}: ${cur} -> ${v}${APPLY && applied.tuning[k] !== undefined ? "  [ALKALMAZVA]" : ""}`);
}
console.log("\n=== PROVIDEREK ===");
for (const p of providerChecks) console.log(`  ${p.id.padEnd(16)} ${p.ok ? "OK" : "HIBA"} ${p.status ?? ""} ${p.ms ? p.ms + " ms" : ""} ${p.models ? p.models + " modell" : ""} ${p.reason ?? ""}`);
if (quotaSnapshot && quotaSnapshot.models.length > 0) {
  const fmt = (l) => {
    if (!l) return "nincs";
    const req = l.request_limit_period === 60 ? `${l.request_limit} RPM` : `${l.request_limit}/${l.request_limit_period}s`;
    const tpm = l.usage_limit == null ? "TPM nelkul" : `${Number(l.usage_limit).toLocaleString("hu-HU")} tok/${l.usage_limit_period}s`;
    return `${req} · ${tpm}`;
  };
  console.log(`\n=== ALIBABA KERET-KORLATOK (${quotaSnapshot.host}, ${quotaSnapshot.total} modell) ===`);
  for (const m of quotaSnapshot.models) console.log(`  ${m.model.padEnd(24)} ${fmt(m.limit)}`);
}
if (invoice) {
  const u = (n) => "$" + Number(n).toFixed(6);
  console.log(`\n=== SZAMLA-EGYEZTETES (${invoice.cycle}, cikluszaras ${invoice.closingDate}) ===`);
  console.log(`  Alibaba szamla:  ${u(invoice.totalUsd)} ${invoice.currency} (${invoice.lineItems} tetel) · elerheto egyenleg ${u(invoice.availableUsd)}`);
  console.log(`  Naplobol (DSH):  ${u(invoice.logged.totalUsd)}  -> elteres ${u(invoice.deltaUsd)} (a DSH-n kivuli hivasok)`);
  for (const region of Object.keys(invoice.byRegion)) {
    console.log(`  ${region}: szamla ${u(invoice.byRegion[region])} | naplo ${u((invoice.logged.perRegion ?? {})[region] ?? 0)}`);
  }
  // Ingyenes keret visszafejtese: a naploban van hasznalat, a szamlan nincs
  // tetel -> az a token a szingapuri ingyenes keretbol ment.
  const billed = new Set(invoice.byModel.map((m) => m.model));
  const freeish = invoice.logged.perModel.filter((m) => !billed.has(m.model) && m.usd > 0);
  if (freeish.length > 0) {
    console.log(`  Keretbol (naploban van, szamlan nincs): ${freeish.map((m) => `${m.model} ${u(m.usd)}`).join(", ")}`);
  }
  console.log("  TOP modellek (szamla | naplo):");
  for (const m of invoice.byModel.slice(0, 6)) {
    const logRow = invoice.logged.perModel.find((x) => x.model === m.model);
    console.log(`    ${m.model.padEnd(24)} ${u(m.usd).padStart(12)} | ${u(logRow?.usd ?? 0).padStart(12)}`);
  }
}
if (missingTargets.length > 0) {
  console.log("\n=== HIANYZO CELEK (katalogusban nincsenek) ===");
  for (const m of missingTargets) console.log(`  ${m.route}: ${m.target}`);
}
if (priceDiff) {
  console.log(`\n=== ARFIGYELES (${priceDiff.checked} sor ellenorizve) ===`);
  if (priceDiff.changes.length === 0) console.log("  nincs elteres a gyari arlistahoz kepest");
  for (const c of priceDiff.changes) console.log(`  ${c.label} (${c.scope}): most ${c.currentMiss}/${c.currentOut} -> gyari ${c.parsedMiss}/${c.parsedOut}${APPLY_PRICES ? "  [IRVA]" : ""}`);
}
if (trend) console.log(`\n=== TREND (elozo futas) ===\n  keresenkenti koltseg: ${trend.costPerRequest >= 0 ? "+" : ""}${trend.costPerRequest} | cache-arany: ${trend.cacheShare >= 0 ? "+" : ""}${trend.cacheShare} | porgo-arany: ${trend.loopShares >= 0 ? "+" : ""}${trend.loopShares}`);
for (const w of warnings) console.log(`FIGYELEM: ${w}`);
console.log(`\njelentes: ${reportPath}`);
if (!APPLY) console.log("(dry-run — a hangolas alkalmazasahoz add hozzá a --apply kapcsolot)");

// Nem nulla kilepes, ha baj van (a watchdog/utemezo jelezni tud).
process.exitCode = warnings.length > 0 ? 1 : 0;
