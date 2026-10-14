// Második kör: /responses teljes próba, nagy kontextus, katalógus-diff, TTFT.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EU_BASE = "https://{EU-WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1";
const key = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8").match(/^\s*ALIBABA_API_KEY:\s*(\S+)\s*$/m)[1];
const H = { "content-type": "application/json", authorization: `Bearer ${key}` };

function out(name, ok, detail) { console.log(`[${ok ? "OK  " : "FAIL"}] ${name} :: ${detail}`); }

// A. /responses nem-stream, szabályos paraméterekkel
{
  const res = await fetch(`${EU_BASE}/responses`, { method: "POST", headers: H, body: JSON.stringify({
    model: "qwen3.8-flash", input: "Reply with exactly: PONG", max_output_tokens: 16 }), signal: AbortSignal.timeout(60000) });
  const j = await res.text();
  let status, content = null;
  try { const p = JSON.parse(j); status = p.status; content = (p.output?.[1]?.content?.[0]?.text ?? p.output?.[0]?.content?.[0]?.text) ?? null; } catch {}
  out("A /responses non-stream", res.ok, `HTTP ${res.status} status=${status} content=${JSON.stringify(content)} body=${res.ok ? "" : j.slice(0, 300)}`);
}

// B. /responses stream + tools
{
  const body = { model: "qwen3.8-flash", stream: true, max_output_tokens: 128,
    input: "What is 2+2? Use the calculator tool.",
    tools: [{ type: "function", function: { name: "calculator", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } } }] };
  const t0 = Date.now();
  const res = await fetch(`${EU_BASE}/responses`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const raw = await res.text(); const ms = Date.now() - t0;
  let calls = 0; const evs = new Set();
  for (const line of raw.split("\n")) if (line.startsWith("event: ")) evs.add(line.slice(7).trim());
  try { for (const line of raw.split("\n")) if (line.startsWith("data: ")) { const p = line.slice(6).trim(); if (p.startsWith("{")) { const j = JSON.parse(p); if (j.type === "response.output_item.added" && (j.item?.type === "function_call" || j.type === "function_call")) calls++; } } } catch {}
  out("B /responses stream+tools", res.ok && (calls > 0 || evs.has("response.function_call_arguments.delta")), `HTTP ${res.status}, ${ms} ms, events=${[...evs].slice(0, 8).join("|")}`);
}

// C. Nagy kontextus (~60K token) + tool, mért TTFT — a Groq 8K-falalt kiváltandó próba
{
  const filler = "Alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu. ".repeat(40); // ~ 800 token
  const blob = filler.repeat(75); // ~60K token
  const t0 = Date.now();
  const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(180000), body: JSON.stringify({
    model: "qwen3.8-flash", max_tokens: 64, stream: true,
    messages: [{ role: "system", content: "You are a precise assistant. The long text below is a reference; answer only the question." },
               { role: "user", content: blob + "\n\nQUESTION: Reply with exactly: GOT_IT" }],
    tools: [{ type: "function", function: { name: "noop", description: "no-op", parameters: { type: "object", properties: {} } } }] }) });
  if (!res.ok) { const t = await res.text(); out("C large-context stream+tools", false, `HTTP ${res.status}: ${t.slice(0, 300)}`); }
  else {
    let ttft = null, finish = null, total = null;
    const dec = new TextDecoder(); const reader = res.body.getReader();
    let buf = "";
    while (true) { const { done, value } = await reader.read(); if (done) break;
      const s = dec.decode(value, { stream: true }); buf += s;
      if (ttft === null && buf.includes("data: ")) ttft = Date.now() - t0;
      for (const line of buf.split("\n")) { if (!line.startsWith("data: ")) continue; try { const j = JSON.parse(line.slice(6)); if (j.usage) total = j.usage; if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason; } catch {} }
      buf = buf.slice(-200);
    }
    out("C large-context stream+tools", ttft !== null, `HTTP ${res.status}, TTFT=${ttft} ms, total=${Date.now() - t0} ms, finish=${finish}, usage=${total ? total.prompt_tokens + "in/" + total.completion_tokens + "out" : "n/a"}`);
  }
}

// D. Katalógus-diff: settings.yaml alibaba.models vs élő /models
{
  const res = await fetch(`${EU_BASE}/models`, { headers: H, signal: AbortSignal.timeout(30000) });
  const live = new Set((await res.json()).data.map(m => m.id));
  const y = readFileSync(join(homedir(), ".dsh", "settings.yaml"), "utf8");
  const sec = y.slice(y.indexOf("    alibaba:"), y.indexOf("# Az uj beszelgetesek"));
  const cfg = new Set([...sec.matchAll(/- id: (\S+)/g)].map(m => m[1]));
  const onlyCfg = [...cfg].filter(x => !live.has(x));
  const onlyLive = [...live].filter(x => !cfg.has(x));
  out("D catalogue diff", onlyCfg.length === 0, `settings=${cfg.size} live=${live.size} onlyInSettings=${onlyCfg.join(",") || "-"} onlyInLive=${onlyLive.join(",") || "-"}`);
}

// E. Rate-limit/region headerök
{
  const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(60000), body: JSON.stringify({ model: "qwen3.8-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }) });
  const hdrs = [...res.headers.entries()].filter(([k]) => /rate|limit|region|request/i.test(k));
  out("E response headers", true, JSON.stringify(Object.fromEntries(hdrs)));
}

// F. qwen3-coder-flash: tool-hívó specialista, stream+tools + TTFT
{
  const body = { model: "qwen3-coder-flash", stream: true, max_tokens: 256,
    messages: [{ role: "user", content: "List the files in /etc using the run_shell tool, then say DONE." }],
    tools: [{ type: "function", function: { name: "run_shell", description: "Run a shell command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } } }] };
  const t0 = Date.now();
  const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const raw = await res.text(); const ms = Date.now() - t0;
  let tc = 0, contentLen = 0, finish = null;
  for (const line of raw.split("\n")) { if (!line.startsWith("data: ")) continue; try { const j = JSON.parse(line.slice(6)); const d = j.choices?.[0]?.delta; if (d?.tool_calls?.length) tc++; if (d?.content) contentLen += d.content.length; if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason; } catch {} }
  out("F qwen3-coder-flash stream+tools", res.ok && tc > 0, `HTTP ${res.status}, ${ms} ms, tool_deltas=${tc}, content=${contentLen}, finish=${finish}${res.ok ? "" : " :: " + raw.slice(0, 200)}`);
}
