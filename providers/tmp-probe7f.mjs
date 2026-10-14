import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const EU_BASE = "https://{EU-WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1";
const key = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8").match(/^\s*ALIBABA_API_KEY:\s*(\S+)\s*$/m)[1];
const H = { "content-type": "application/json", authorization: `Bearer ${key}` };
// 1. qwen3.7-flash: tools + stream (döntő: bekerülhet-e a worker-láncba)
{
  const body = { model: "qwen3.7-flash", stream: true, max_tokens: 256,
    messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
    tools: [{ type: "function", function: { name: "calculator", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a","b"] } } }] };
  const t0 = Date.now();
  const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const raw = await res.text(); const ms = Date.now() - t0;
  let tc = 0, finish = null;
  for (const line of raw.split("\n")) { if (!line.startsWith("data: ")) continue; try { const j = JSON.parse(line.slice(6)); if (j.choices?.[0]?.delta?.tool_calls?.length) tc++; if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason; } catch {} }
  console.log(`[tools qwen3.7-flash] HTTP ${res.status}, ${ms} ms, tool_deltas=${tc}, finish=${finish}${res.ok ? "" : " :: " + raw.slice(0,200)}`);
}
// 2. qwen3.7-flash + tool EGYEDÜL egy kérésben (agent-loop-höz kell)
{
  const png = readFileSync(new URL("./vision-test.png", import.meta.url)).toString("base64");
  const body = { model: "qwen3.7-flash", max_tokens: 256, messages: [{ role: "user", content: [
    { type: "text", text: "Read the number in the image, then report it via the report_number tool." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } } ] }],
    tools: [{ type: "function", function: { name: "report_number", description: "Report the number you see", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } }] };
  const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await res.json();
  const tc = j.choices?.[0]?.message?.tool_calls?.[0];
  console.log(`[image+tool qwen3.7-flash] HTTP ${res.status}, call=${tc?.function?.name}(${tc?.function?.arguments}) content=${JSON.stringify((j.choices?.[0]?.message?.content||"").slice(0,50))}`);
}
