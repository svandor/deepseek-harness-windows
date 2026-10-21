// End-to-end check through the local proxy: does it inject thinking_budget on Alibaba targets?
import { readFileSync } from 'node:fs';

const filler = (t) => ('The quick brown fox jumps over the lazy dog while the cat watches. ').repeat(Math.max(1, Math.round(t / 15)));
const body = (tokens) => ({
  model: 'probe-alibaba',
  stream: true,
  max_tokens: 300,
  messages: [
    { role: 'system', content: 'You are a terse assistant.' },
    { role: 'user', content: `Count how many times the word "cat" appears in this text. Answer with the number only.\n\n${filler(tokens)}` },
  ],
});

async function call(label, tokens) {
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:4123/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer worker' },
    body: JSON.stringify(body(tokens)), signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) { console.log(`${label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); return; }
  let usage = null, ttft = null;
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    if (ttft === null) ttft = Date.now() - t0;
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim(); if (!s.startsWith('data:')) continue;
      const p = s.slice(5).trim(); if (p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      if (j.usage) usage = j.usage;
    }
  }
  const u = usage || {};
  console.log(`${label.padEnd(28)} total=${Date.now() - t0}ms ttft=${ttft}ms in=${u.prompt_tokens} out=${u.completion_tokens} reason=${u.completion_tokens_details?.reasoning_tokens}`);
}

await call('proxy probe-alibaba 600 tok', 600);
await call('proxy probe-alibaba 20k tok', 20000);
