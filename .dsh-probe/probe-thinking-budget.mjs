// Probe 3: is thinking_budget honoured? (cap reasoning instead of disabling it)
import { readFileSync } from 'node:fs';
const creds = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const ref = (n) => { for (const line of creds.split(/\r?\n/)) { const m = line.match(new RegExp(`^\\s{2}${n}:\\s*(\\S+)\\s*$`)); if (m) return m[1]; } return null; };
const EU = ref('ALIBABA_EU_BASE_URL'), SG = ref('ALIBABA_SG_BASE_URL'), ALK = ref('ALIBABA_API_KEY'), SGK = ref('DASHSCOPE_API_KEY') || ALK;

const para = 'The quick brown fox jumps over the lazy dog while the cat watches from the windowsill. ';
const filler = (t) => `Context passage follows. ${para}`.repeat(Math.max(1, Math.round(t / 16)));

async function call(label, url, key, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(240000),
    });
    if (!res.ok) { console.log(`[FAIL ${res.status}] ${label} :: ${(await res.text().catch(() => '')).slice(0, 160)}`); return; }
    let usage = null, finish = null, ttft = null;
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      if (ttft === null) ttft = Date.now() - t0;
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) { const s = line.trim(); if (!s.startsWith('data:')) continue; const p = s.slice(5).trim(); if (p === '[DONE]') continue; let j; try { j = JSON.parse(p); } catch { continue; } if (j.error) { console.log(`[ERREV] ${label} :: ${String(j.error.message || j.error).slice(0, 160)}`); return; } if (j.usage) usage = j.usage; if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason; }
    }
    const u = usage || {};
    console.log(`[OK] ${label.padEnd(44)} total=${String(Date.now() - t0).padStart(6)}ms ttft=${String(ttft).padStart(5)}ms in=${u.prompt_tokens} cached=${u.prompt_tokens_details?.cached_tokens ?? 0} out=${u.completion_tokens} reason=${u.completion_tokens_details?.reasoning_tokens} finish=${finish}`);
  } catch (e) { console.log(`[THROW] ${label} :: ${e && e.message || e}`); }
}

const msg = (t) => [{ role: 'system', content: 'You are a terse assistant. Answer in one short sentence.' }, { role: 'user', content: `Count the occurrences of the word "cat" in the passage below.\n\n${filler(t)}` }];

console.log('baseline (no params), medium 40k:');
await call('EU no-params medium', EU, ALK, { model: 'qwen3.8-flash', max_tokens: 256, messages: msg(40000) });
console.log('thinking_budget caps:');
await call('EU thinking_budget=512 medium', EU, ALK, { model: 'qwen3.8-flash', max_tokens: 256, messages: msg(40000), thinking_budget: 512 });
await call('SG thinking_budget=512 medium', SG, SGK, { model: 'qwen3.8-flash', max_tokens: 256, messages: msg(40000), thinking_budget: 512 });
await call('EU thinking_budget=512 small', EU, ALK, { model: 'qwen3.8-flash', max_tokens: 256, messages: msg(600), thinking_budget: 512 });
console.log('enable_thinking true + effort low:');
await call('EU enable_thinking=true, reasoning_effort=low medium', EU, ALK, { model: 'qwen3.8-flash', max_tokens: 256, messages: msg(40000), enable_thinking: true, reasoning_effort: 'low' });
