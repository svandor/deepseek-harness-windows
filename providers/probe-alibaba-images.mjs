// Képtámogatás élő próba: /chat/completions (image_url) és /responses (input_image).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EU_BASE = "https://{EU-WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1";
const key = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8").match(/^\s*ALIBABA_API_KEY:\s*(\S+)\s*$/m)[1];
const H = { "content-type": "application/json", authorization: `Bearer ${key}` };
const png = readFileSync(new URL("./vision-test.png", import.meta.url)).toString("base64");
const dataUrl = `data:image/png;base64,${png}`;
const Q = "What 3-digit number is shown in the image? Reply with only the digits.";

function out(name, ok, detail) { console.log(`[${ok ? "OK  " : "FAIL"}] ${name} :: ${detail}`); }

// 1. /chat/completions + image_url, több modell
const chatModels = ["qwen3.8-flash", "qwen3.8-max", "qwen3.7-plus", "qwen3-vl-plus", "qwen3-vl-flash", "qwen3.5-flash", "qwen-vl-ocr", "kimi-k3", "deepseek-v4-flash"];
for (const m of chatModels) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(90000), body: JSON.stringify({
      model: m, max_tokens: 256,
      messages: [{ role: "user", content: [ { type: "text", text: Q }, { type: "image_url", image_url: { url: dataUrl } } ] }] }) });
    const txt = await res.text();
    const ms = Date.now() - t0;
    let content = null, err = null;
    try { const j = JSON.parse(txt); content = j.choices?.[0]?.message?.content ?? j.output?.text ?? null; if (!res.ok) err = j.error?.message || j.code || txt.slice(0, 120); } catch { err = txt.slice(0, 120); }
    const seen = content && /\b777\b/.test(content);
    out(`chat image ${m}`, res.ok && seen, `HTTP ${res.status}, ${ms} ms, answer=${JSON.stringify((content || err || "").slice(0, 60))}`);
  } catch (e) { out(`chat image ${m}`, false, String(e).slice(0, 120)); }
}

// 2. /responses + input_image (az DSH `api: openai-responses` módját szimulálva)
for (const m of ["qwen3.8-flash", "qwen3-vl-plus"]) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${EU_BASE}/responses`, { method: "POST", headers: H, signal: AbortSignal.timeout(90000), body: JSON.stringify({
      model: m, max_output_tokens: 256,
      input: [{ role: "user", content: [ { type: "input_text", text: Q }, { type: "input_image", image_url: dataUrl } ] }] }) });
    const txt = await res.text(); const ms = Date.now() - t0;
    let j = null; try { j = JSON.parse(txt); } catch {}
    const texts = [];
    for (const item of (j?.output || [])) { if (item.type === "message") for (const c of (item.content || [])) if (c.text) texts.push(c.text); }
    const joined = texts.join("");
    out(`responses image ${m}`, res.ok && /\b777\b/.test(joined), `HTTP ${res.status}, ${ms} ms, status=${j?.status}, text=${JSON.stringify(joined.slice(0, 60) || (j?.error?.message || txt).slice(0, 140))}`);
  } catch (e) { out(`responses image ${m}`, false, String(e).slice(0, 120)); }
}

// 3. /responses + stream + tools — nyers SSE fej (a korábbi B bukáshoz)
{
  const body = { model: "qwen3.8-flash", stream: true, max_output_tokens: 256,
    input: "What is 2+2? Use the calculator tool.",
    tools: [{ type: "function", function: { name: "calculator", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } } }] };
  const t0 = Date.now();
  const res = await fetch(`${EU_BASE}/responses`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const raw = await res.text(); const ms = Date.now() - t0;
  out("responses stream+tools RAW", res.ok, `HTTP ${res.status}, ${ms} ms, ct=${res.headers.get("content-type")}, head=${JSON.stringify(raw.slice(0, 400))}`);
}
