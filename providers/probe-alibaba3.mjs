// 3. kör: (1) /responses javított tool-alakú stream-próba, (2) seluruh katalógus serving-próba,
// (3) látásszondor a esélyes modelleken. Kiszolgálja a settings.yaml input:/contextWindow-javítást.
import { euBase, sgBase } from "./alibaba-endpoints.mjs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EU_BASE = "euBase()";
const key = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8").match(/^\s*ALIBABA_API_KEY:\s*(\S+)\s*$/m)[1];
const H = { "content-type": "application/json", authorization: `Bearer ${key}` };
const png = readFileSync(new URL("./vision-test.png", import.meta.url)).toString("base64");
const dataUrl = `data:image/png;base64,${png}`;
const Q = "Reply with only the 3-digit number in the image.";
function out(n, ok, d) { console.log(`[${ok ? "OK  " : "FAIL"}] ${n} :: ${d}`); }

// --- 1. /responses stream + tools, LAPID tool object (OpenAI Responses formátum) ---
{
  const body = { model: "qwen3.8-flash", stream: true, max_output_tokens: 512,
    input: "What is 2+2? Use the calculator tool.",
    tools: [{ type: "function", name: "calculator", description: "Add two integers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }] };
  const t0 = Date.now();
  const res = await fetch(`${EU_BASE}/responses`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const raw = await res.text(); const ms = Date.now() - t0;
  const events = [...raw.matchAll(/event: ([a-z_.]+)/g)].map(m => m[1]);
  const failed = /event: response\.failed/.test(raw);
  let args = null; try { args = raw.match(/"arguments"\s*:\s*"?\{[^}]*\}/)?.[0] || (JSON.parse(raw.match(/data: (\{.*response\.completed.*\}|)\{/) || "{}")); } catch {}
  const fc = /function_call/.test(raw) && (/"arguments"/.test(raw));
  out("1 /responses stream+tools FLAT shape", fc && !failed, `HTTP ${res.status}, ${ms} ms, events=${events.slice(-6).join("|")}, args_snippet=${JSON.stringify((args || "").slice ? String(args).slice(0, 80) : args)}`);
  if (failed) out("1f failure detail", false, raw.match(/"error"\s*:\s*\{[^}]*\}/)?.[0]?.slice(0, 200) || raw.slice(0, 300));
}

// --- 2. Serving-mátrix: minden katalógus-id-ra egy minimális chat kérés ---
const res1 = await fetch(`${EU_BASE}/models`, { headers: H, signal: AbortSignal.timeout(30000) });
const ids = (await res1.json()).data.map(m => m.id);
const chat = new Map(), vision = new Map();
const CHAT_PROBE = ids.filter(id => !/-image-|^qwen-image|ocr|mt-|character|drillrun/.test(id)); // generatív/irreleváns kihagyva? — az OCR-t külön látjuk, mt/character/contextus-kizár
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; results[k] = await fn(items[k], k); } }));
  return results;
}
await mapLimit(CHAT_PROBE, 8, async (id) => {
  try {
    const r = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(45000), body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) });
    const t = await r.text();
    chat.set(id, { status: r.status, err: r.ok ? null : (JSON.parse(t)?.error?.message || t.slice(0, 90)) });
  } catch (e) { chat.set(id, { status: 0, err: String(e).slice(0, 90) }); }
});
const served = [...chat].filter(([, v]) => v.status === 200).map(([k]) => k);
const dead = [...chat].filter(([, v]) => v.status !== 200);
out("2 serving-matrix", true, `${ids.length} katalógus-id, ebből ${CHAT_PROBE.length} chat-próba, ÉLŐ=${served.length}, HALOTT=${dead.length}`);
for (const [id, v] of dead) out(`2d ${id}`, false, `HTTP ${v.status} ${v.err}`);

// --- 3. Látásszondor: minden ÉLŐ modellre kép+kérés; "777"-t várunk ---
const VISION_CANDIDATES = served; // végigmegyünk az összes élőn, kis képpel
await mapLimit(VISION_CANDIDATES, 6, async (id) => {
  try {
    const r = await fetch(`${EU_BASE}/chat/completions`, { method: "POST", headers: H, signal: AbortSignal.timeout(90000), body: JSON.stringify({
      model: id, max_tokens: 200, messages: [{ role: "user", content: [ { type: "text", text: Q }, { type: "image_url", image_url: { url: dataUrl } } ] }] }) });
    const t = await r.text();
    let txt = null, err = null;
    try { const j = JSON.parse(t); txt = j.choices?.[0]?.message?.content ?? null; if (!r.ok) err = j.error?.message; } catch { err = t.slice(0, 90); }
    vision.set(id, { ok: r.ok, seen: !!txt && /777/.test(txt), note: err || (txt || "").slice(0, 40) });
  } catch (e) { vision.set(id, { ok: false, seen: false, note: String(e).slice(0, 60) }); }
});
const vYes = [...vision].filter(([, v]) => v.seen).map(([k]) => k);
const vNo = [...vision].filter(([, v]) => !v.seen);
out("3 vision-yes", true, `${vYes.length}/${vision.size} élő modell lát: ${vYes.join(", ")}`);
for (const [id, v] of vNo) out(`3n ${id}`, false, v.note);

console.log("\n=== GÉPÍTHETŐ LISTA (settings.yaml input: [text,image]) ===");
console.log(JSON.stringify(vYes));
