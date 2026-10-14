// AZ INTELLIGENS SZELEKTOR donteseinek ellenorzese — a /healthz
// intelligent.decisions bejegyzesere allitva (a valasz `model` mezoje csak az
// upstream modellnevet adja vissza, provider nelkul, ezert arra nem lehet
// allitani: az EU es a szingapúri qwen3.7-flash id-je ugyanaz).
const BASE = "http://127.0.0.1:4123";
const filler = (n) => "alfa beta gamma delta echo foxtrot golf hotel ".repeat(n);
let passed = 0, failed = 0;

async function decisions() {
  const h = await (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(10000) })).json();
  return h.intelligent?.decisions ?? [];
}
async function expectChoice(label, systemText, firstUser, extra, expectLabel) {
  const messages = [{ role: "system", content: systemText }, { role: "user", content: firstUser }];
  for (const e of extra) messages.push({ role: "user", content: e });
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer proxy" },
    body: JSON.stringify({ model: "auto", max_tokens: 16, messages }), signal: AbortSignal.timeout(180000) });
  await res.text();
  const list = await decisions();
  const last = list[list.length - 1] ?? {};
  const ok = res.ok && String(last.label) === expectLabel;
  if (ok) passed++; else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}\n      valasztott=${last.label} (vart: ${expectLabel})${last.cost !== undefined && last.cost !== null ? ` · becsult ~$${Number(last.cost).toFixed(5)}/lepes` : ""}\n      indok: ${String(last.reason ?? "").slice(0, 130)}`);
}

// A) ~293K token, cache-elt (6 uzenet) -> a Qwen top-savja (0,165/0,0165) miatt a DeepSeek nyer
await expectChoice("A) ~293K cache-elt -> deepseek-flash", "You are a test agent.", "TASK-OMEGA: nagy elemzes.",
  [filler(8000), filler(8000), filler(8000), filler(6000)], "deepseek/deepseek-flash");
// B) ~98K token, cache-elt -> a Qwen 32-256K sávja olcsóbb
await expectChoice("B) ~98K cache-elt -> alibaba/qwen3.7-flash", "You are a test agent.", "TASK-SIGMA: kozepes elemzes.",
  [filler(2000), filler(2000), filler(2000), filler(2000), filler(700)], "alibaba/qwen3.7-flash");
// C) ~2K token, friss -> a legolcsobb (EU Qwen, 5x a DeepSeek alatt)
await expectChoice("C) ~2K friss -> alibaba/qwen3.7-flash", "You are a test agent.", "TASK-DELTA: rovid valasz.",
  [filler(60)], "alibaba/qwen3.7-flash");

console.log(`\n${passed}/${passed + failed} eset rendben`);
