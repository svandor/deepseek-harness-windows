// Élő ellenőrzés az Alibaba (Qwen) EU végpontra a ALIBABA-QWEN-TERV.md 7. szakasz szerint.
// Soha nem írja ki a kulcsot. Futtatás: node providers\probe-alibaba.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EU_BASE = "https://{EU-WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1";
const INTL_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

function getKey() {
  const yaml = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  const m = yaml.match(/^\s*ALIBABA_API_KEY:\s*(\S+)\s*$/m);
  if (!m) throw new Error("ALIBABA_API_KEY not found in .credentials.yaml refs");
  return m[1];
}

const key = getKey();
const H = { "content-type": "application/json", authorization: `Bearer ${key}` };
const results = [];

function log(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? "OK  " : "FAIL"}] ${name} :: ${detail}`);
}

async function req(label, url, body, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: H,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    return { status: res.status, text, ms };
  } catch (e) {
    return { status: 0, text: String(e && e.cause || e), ms: Date.now() - t0 };
  }
}

// 1. Kulcs + régió: GET /models
{
  const r = await req("models", `${EU_BASE}/models`);
  const ids = (() => { try { return (JSON.parse(r.text).data || []).map(m => m.id); } catch { return null; } })();
  log("1 GET /models (EU)", r.status === 200, `HTTP ${r.status}, ${r.ms} ms, ${ids ? ids.length + " model ids" : r.text.slice(0, 200)}`);
  if (ids) {
    const wanted = ["qwen3.8-flash", "qwen3.8-max", "qwen3-coder-flash", "deepseek-v4-flash"];
    log("1b catalogue has key ids", wanted.every(w => ids.includes(w)), `wanted=${wanted.filter(w => ids.includes(w)).join(",")} missing=${wanted.filter(w => !ids.includes(w)).join(",")}`);
  }
}

// 2. Nem-stream chat: alap működéssel a context window bekötéséhez mért válasz
{
  const r = await req("chat", `${EU_BASE}/chat/completions`, {
    model: "qwen3.8-flash",
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    max_tokens: 8, stream: false,
  });
  let content = null, usage = null;
  try { const j = JSON.parse(r.text); content = j.choices?.[0]?.message?.content; usage = j.usage; } catch {}
  log("2 chat non-stream", r.status === 200 && !!content, `HTTP ${r.status}, ${r.ms} ms, content=${JSON.stringify(content)} usage=${usage ? `${usage.prompt_tokens}in/${usage.completion_tokens}out` : r.text.slice(0, 200)}`);
}

// 3. stream + tools — a döntő próba (TERV 6.1)
{
  const body = {
    model: "qwen3.8-flash",
    messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
    tools: [{ type: "function", function: { name: "calculator", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } } }],
    stream: true, max_tokens: 128,
  };
  const t0 = Date.now();
  try {
    const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const raw = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) { log("3 stream+tools", false, `HTTP ${res.status}, ${ms} ms, ${raw.slice(0, 300)}`); }
    else {
      let tc = 0, contentLen = 0, finish = null, sawReasoning = false;
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const p = line.slice(6).trim(); if (p === "[DONE]") continue;
        try {
          const j = JSON.parse(p);
          const d = j.choices?.[0]?.delta;
          if (d?.tool_calls?.length) tc++;
          if (d?.content) contentLen += d.content.length;
          if (d?.reasoning_content) sawReasoning = true;
          if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
        } catch {}
      }
      log("3 stream+tools", tc > 0, `HTTP ${res.status}, ${ms} ms, tool_call_deltas=${tc}, content_len=${contentLen}, finish=${finish}`);
    }
  } catch (e) { log("3 stream+tools", false, `error ${e}`); }
}

// 4. reasoning: enable_thinking + reasoning_content a streamben
{
  const body = { model: "qwen3.8-flash", messages: [{ role: "user", content: "A jar has 3 apples. I eat one. How many are left? Think step by step." }], stream: true, max_tokens: 512, enable_thinking: true };
  try {
    const res = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const raw = await res.text();
    let sawReasoning = false, usage = null, firstDelta = null;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const p = line.slice(6).trim(); if (p === "[DONE]") continue;
      try {
        const j = JSON.parse(p);
        const d = j.choices?.[0]?.delta;
        if (d && d.reasoning_content) { sawReasoning = true; if (!firstDelta) firstDelta = d.reasoning_content.slice(0, 40); }
        if (j.usage) usage = j.usage;
      } catch {}
    }
    log("4 enable_thinking stream", res.ok, `HTTP ${res.status}, reasoning_content_seen=${sawReasoning}${firstDelta ? ` sample=${JSON.stringify(firstDelta)}` : ""}${usage ? ` usage=${JSON.stringify(usage)}` : ""}`);
  } catch (e) { log("4 enable_thinking stream", false, `error ${e}`); }
}

// 5. /responses végpont létezik-e (a settings.yaml api: openai-responses-t használ!)
{
  const r = await req("responses", `${EU_BASE}/responses`, { model: "qwen3.8-flash", input: "Reply with exactly: PONG", max_output_tokens: 8 }, { timeoutMs: 30000 });
  log("5 POST /responses", r.status === 200, `HTTP ${r.status}, ${r.ms} ms, ${r.text.slice(0, 240)}`);
}

// 6. Nyitott kérdés: a régi dashscope-intl kulcsot fogadja-e
{
  const r = await req("intl", `${INTL_BASE}/models`, null, { timeoutMs: 20000 });
  log("6 dashscope-intl /models", r.status === 200, `HTTP ${r.status}, ${r.ms} ms, ${r.text.slice(0, 160)}`);
}

console.log("\n--- SUMMARY ---");
for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}`);
