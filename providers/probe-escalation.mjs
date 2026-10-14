// AZ ESZKALACIOS DETEKTOR ellenorzese a proxy auto route-jan.
// 1) hosszu beszelgetes + ismetlodo tool-hivas  -> pro (eszkalacio)
// 2) ugyanaz rovid beszelgetesben              -> flash (nincs eszkalacio)
// 3) tiszta hosszu beszelgetes                 -> flash (nincs porgo-jel)
const BASE = "http://127.0.0.1:4123";
const TOOLS = [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
function out(n, ok, d) { console.log(`[${ok ? "OK  " : "FAIL"}] ${n} :: ${d}`); }

function history(turns, repeatArgs) {
  const msgs = [{ role: "system", content: "You are a coding agent." }];
  for (let i = 0; i < turns; i++) {
    const args = repeatArgs !== null && i >= turns - 3 ? JSON.stringify({ path: repeatArgs }) : JSON.stringify({ path: `/tmp/file-${i}.txt` });
    msgs.push({ role: "assistant", content: `Lepes ${i}`, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: args } }] });
    msgs.push({ role: "tool", tool_call_id: `call_${i}`, content: `tartalom ${i}` });
  }
  msgs.push({ role: "user", content: "Folytasd: mit tegyek most? Valaszolj egy szoval." });
  return msgs;
}

async function call(label, messages, expect) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer proxy" },
    body: JSON.stringify({ model: "auto", max_tokens: 32, tools: TOOLS, messages }), signal: AbortSignal.timeout(120000) });
  const j = await res.json().catch(() => ({}));
  const model = j.model ?? "-";
  const ok = res.ok && (expect === null || model.includes(expect));
  out(label, ok, `HTTP ${res.status}, ${Date.now() - t0} ms, upstream=${model}${res.ok ? "" : " :: " + JSON.stringify(j.error ?? {}).slice(0, 120)}`);
}

await call("1 porgo: 25 kor + 3x ugyanaz a hivas -> pro", history(25, "/etc/hosts"), "pro");
await call("2 ugyanaz rovid beszelgetesben (5 kor) -> flash", history(5, "/etc/hosts"), "flash");
await call("3 tiszta hosszu beszelgetes (25 kor, mind mas) -> flash", history(25, null), "flash");
