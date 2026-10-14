// Az "auto" modellvalaszto viselkedesenek ellenorzese a proxy /v1/chat/completions
// vegpontjan. A tenyleges cel kivalasztasat a proxy AUTO ... naplósora igazolja.
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:4123";
function out(n, ok, d) { console.log(`[${ok ? "OK  " : "FAIL"}] ${n} :: ${d}`); }
const png = readFileSync(new URL("./vision-test.png", import.meta.url)).toString("base64");

async function call(label, body, expect) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer proxy" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const raw = await res.text();
  let j = null;
  try { j = JSON.parse(raw); } catch {}
  const msg = j?.choices?.[0]?.message;
  const text = msg?.content ?? "";
  const call = msg?.tool_calls?.[0];
  const seen = expect === "tool" ? !!call : expect.test(text);
  out(label, res.ok && seen, `HTTP ${res.status}, ${Date.now() - t0} ms, modell=${j?.model ?? "-"}, ${call ? "tool=" + call.function.name + "(" + call.function.arguments + ")" : "text=" + JSON.stringify(String(text).slice(0, 70))}`);
  return j;
}

const TOOLS = [{ type: "function", function: { name: "get_weather", description: "weather",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];

// 1-4: az atmeneti auto-test route szabalyai (kep / tool / nagy kontextus / alap)
await call("1 auto-test: alap (nincs szabaly) -> deepseek", { model: "auto-test", max_tokens: 24, messages: [{ role: "user", content: "Reply with exactly: ALAP" }] }, /ALAP/i);
await call("2 auto-test: kep szabaly -> SG qwen3.8-flash", { model: "auto-test", max_tokens: 64, messages: [{ role: "user", content: [ { type: "text", text: "Reply with exactly: KEP" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } } ] }] }, /KEP/i);
await call("3 auto-test: tool szabaly -> SG qwen3.7-flash", { model: "auto-test", max_tokens: 128, tools: TOOLS, messages: [{ role: "user", content: "What is the weather in Budapest? Use the tool." }] }, "tool");
await call("4 auto-test: nagy kontextus -> EU qwen3.8-flash", { model: "auto-test", max_tokens: 24, messages: [{ role: "user", content: "Reference: " + "alfa beta gamma delta ".repeat(900) + "\nReply with exactly: NAGY" }] }, /NAGY/i);
// 5: ora-szabaly (utc [4,6) ablak, most 04:xx UTC)
await call("5 auto-utc: idoablak szabaly -> EU qwen3.8-flash", { model: "auto-utc", max_tokens: 24, messages: [{ role: "user", content: "Reply with exactly: IDO" }] }, /IDO/i);
// 6-7: az ELES auto route
await call("6 auto: alap -> deepseek (csucson kivul)", { model: "auto", max_tokens: 24, messages: [{ role: "user", content: "Reply with exactly: ELES" }] }, /ELES/i);
await call("7 auto: kep -> SG lató modell", { model: "auto", max_tokens: 64, messages: [{ role: "user", content: [ { type: "text", text: "Reply with exactly: AUTOKEP" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } } ] }] }, /AUTOKEP/i);
// 8: stream + tool az ELES auto route-on (a DSH igy hasznalja)
{
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer proxy" },
    body: JSON.stringify({ model: "auto", stream: true, max_tokens: 200, tools: TOOLS,
      messages: [{ role: "user", content: "What is the weather in Budapest? Use the tool." }] }),
    signal: AbortSignal.timeout(120000) });
  const raw = await res.text();
  let tc = 0, finish = null;
  for (const line of raw.split("\n")) { if (!line.startsWith("data: ")) continue; try { const j = JSON.parse(line.slice(6)); if (j.choices?.[0]?.delta?.tool_calls?.length) tc++; if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason; } catch {} }
  out("8 auto: stream + tool", res.ok && tc > 0, `HTTP ${res.status}, ${Date.now() - t0} ms, tool_deltas=${tc}, finish=${finish}`);
}
