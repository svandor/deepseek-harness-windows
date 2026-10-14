// A helyi fallback proxy ELLENŐRZÉSE: (1) healthz, (2) vision-worker útvonal
// kép + tool kéréssel — a proxy a body-t változatlanul adja át, ezért a
// kép-út akkor igazolt, ha a válasz valódi tool_calls-t tartalmaz.
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:4123";
function out(n, ok, d) { console.log(`[${ok ? "OK  " : "FAIL"}] ${n} :: ${d}`); }

const h = await (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(10000) })).json();
out("healthz", h.ok === true, `ok=${h.ok} usable=${h.usable} missingKeys=${JSON.stringify(h.missingKeys)}`);
out("provider alibaba", h.providers?.some(p => p.id === "alibaba" && p.key === "configured"),
  (h.providers || []).map(p => `${p.id}:${p.key}`).join(", "));
for (const [name, chain] of Object.entries(h.routes || {})) out(`route ${name}`, true, [].concat(chain).join(" -> "));

const png = readFileSync(new URL("./vision-test.png", import.meta.url)).toString("base64");
const body = {
  model: "vision-worker",
  max_tokens: 256,
  messages: [{ role: "user", content: [
    { type: "text", text: "Read the number in the image, then report it with the report_number tool." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } } ] }],
  tools: [{ type: "function", function: { name: "report_number", description: "Report the number you see",
    parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } }],
};
const t0 = Date.now();
const res = await fetch(`${BASE}/v1/chat/completions`, { method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer proxy" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
const raw = await res.text();
const ms = Date.now() - t0;
let call = null, content = null, err = null;
try { const j = JSON.parse(raw); call = j.choices?.[0]?.message?.tool_calls?.[0]; content = j.choices?.[0]?.message?.content; if (!res.ok) err = j.error?.message; } catch { err = raw.slice(0, 200); }
out("vision-worker kép+tool", res.ok && call?.function?.name === "report_number",
  `HTTP ${res.status}, ${ms} ms, call=${call ? call.function.name + "(" + call.function.arguments + ")" : "-"} content=${JSON.stringify((content || err || "").slice(0, 80))}`);
