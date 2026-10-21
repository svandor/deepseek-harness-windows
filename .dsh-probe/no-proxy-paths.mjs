// Prove the two default paths work with NO proxy: DeepSeek direct (main) and OpenRouter free (children).
import { readFileSync } from 'node:fs';
const c = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const ref = (n) => { for (const l of c.split(/\r?\n/)) { const m = l.match(new RegExp(`^\\s{2}${n}:\\s*(\\S+)\\s*$`)); if (m) return m[1]; } return null; };
const TOOL = { type: 'function', function: { name: 'report_number', description: 'Report a number', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } };

async function probe(label, url, key, model, extra = {}) {
  const t0 = Date.now();
  const r = await fetch(`${url}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra },
    body: JSON.stringify({ model, max_tokens: 120, messages: [{ role: 'user', content: 'Report the number 777 with the tool.' }], tools: [TOOL] }),
    signal: AbortSignal.timeout(90000),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.length ?? 0;
  console.log(`${label.padEnd(34)} HTTP ${r.status} ${String(Date.now() - t0).padStart(5)}ms tool_calls=${tc}`);
}

await probe('fo szal: deepseek-flash', 'https://api.deepseek.com/v1', ref('DEEPSEEK_API_KEY'), 'deepseek-flash');
await probe('gyerek: openrouter qwen3.8-27b', 'https://openrouter.ai/api/v1', ref('OPENROUTER_API_KEY'), 'qwen/qwen3.8-27b', { 'HTTP-Referer': 'http://127.0.0.1:3080', 'X-Title': 'DSH' });
