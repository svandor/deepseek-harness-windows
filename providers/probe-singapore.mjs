// SZINGAPÚR (ap-southeast-1) élő próba a CSV-ből olvasott kulccsal.
// A kulcsot SOHA nem írjuk ki. Futtatás:
//   node providers/probe-singapore.mjs "C:\...\默认业务空间-apiKey-1306045.csv"
import { euBase, sgBase } from "./alibaba-endpoints.mjs";
import { readFileSync } from "node:fs";

const csvPath = process.argv[2];
const csv = readFileSync(csvPath, "utf8");
const val = (k) => csv.split(/\r?\n/).find((l) => l.startsWith(k + ","))?.slice(k.length + 1).trim();
const KEY = val("apiKey");
const BASE = val("openAiCompatible").replace(/\/+$/, "");
const EU_BASE = "euBase()";
const H = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
function out(n, ok, d) { console.log(`[${ok ? "OK  " : "FAIL"}] ${n} :: ${d}`); }
console.log(`kulcs: ${KEY.slice(0, 6)}… (hossz ${KEY.length}) | workspace: ${val("workspaceId")} | base: ${BASE}`);

// 1. Kulcs + katalógus
let sgIds = [];
{
  const res = await fetch(`${BASE}/models`, { headers: H, signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => null);
  sgIds = (j?.data ?? []).map((m) => m.id);
  out("1 GET /models (SG)", res.ok, `HTTP ${res.status}, ${sgIds.length} modell id${res.ok ? "" : " :: " + JSON.stringify(j).slice(0, 160)}`);
}

// 2. Katalógus-összevetés az EU-val
if (sgIds.length) {
  const eu = await (await fetch(`${EU_BASE}/models`, { headers: H, signal: AbortSignal.timeout(30000) })).json().catch(() => null);
  const euIds = (eu?.data ?? []).map((m) => m.id);
  const onlyEu = euIds.filter((x) => !sgIds.includes(x));
  const onlySg = sgIds.filter((x) => !euIds.includes(x));
  out("2 SG vs EU katalógus", true, `SG=${sgIds.length} EU(vagy 401)=${euIds.length} | csak SG: ${onlySg.slice(0, 12).join(", ") || "-"} | csak EU: ${onlyEu.slice(0, 6).join(", ") || "-"}`);
}

// 3. Chat + tools + stream
for (const model of ["qwen3.8-flash", "qwen3.7-flash", "qwen3-coder-flash"]) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(60000), body: JSON.stringify({
    model, stream: true, max_tokens: 128,
    messages: [{ role: "user", content: "What is 2+2? Use the tool." }],
    tools: [{ type: "function", function: { name: "add", description: "add", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } } }] }) });
  const raw = await res.text();
  let tc = 0, finish = null, err = null;
  for (const line of raw.split("\n")) { if (!line.startsWith("data: ")) continue; try { const j = JSON.parse(line.slice(6)); if (j.choices?.[0]?.delta?.tool_calls?.length) tc++; if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason; if (j.error) err = j.error.message; } catch {} }
  out(`3 stream+tools ${model}`, res.ok && tc > 0, `HTTP ${res.status}, ${Date.now() - t0} ms, tool_deltas=${tc}, finish=${finish}${err ? " :: " + err : ""}${res.ok ? "" : " :: " + raw.slice(0, 120)}`);
}

// 4. Kép + tool
{
  const png = readFileSync(new URL("./vision-test.png", import.meta.url)).toString("base64");
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(60000), body: JSON.stringify({
    model: "qwen3.8-flash", max_tokens: 200,
    messages: [{ role: "user", content: [ { type: "text", text: "Report the 3-digit number with the tool." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } } ] }],
    tools: [{ type: "function", function: { name: "report_number", description: "report", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } }] }) });
  const j = await res.json().catch(() => ({}));
  const call = j.choices?.[0]?.message?.tool_calls?.[0];
  out("4 kép + tool (qwen3.8-flash)", res.ok && call?.function?.name === "report_number", `HTTP ${res.status}, call=${call ? call.function.name + "(" + call.function.arguments + ")" : "-"} ${j.error?.message ?? ""}`);
}

// 5. Usage (ingyenes keret nyoma)
{
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(60000), body: JSON.stringify({ model: "qwen3.7-flash", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }) });
  const j = await res.json().catch(() => ({}));
  out("5 usage", res.ok, JSON.stringify(j.usage ?? j.error ?? {}).slice(0, 240));
}
