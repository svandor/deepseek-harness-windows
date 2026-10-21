// Which FREE provider models actually work and return real tool_calls?
// (OpenRouter :free ids + NVIDIA NIM free tier). Small bodies, no cost.
import { readFileSync } from 'node:fs';

const c = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const ref = (n) => { for (const l of c.split(/\r?\n/)) { const m = l.match(new RegExp(`^\\s{2}${n}:\\s*(\\S+)\\s*$`)); if (m) return m[1]; } return null; };
const OR = ref('OPENROUTER_API_KEY');
const NV = ref('NVIDIA_API_KEY');
const GROQ = ref('GROQ_API_KEY');

const TOOL = { type: 'function', function: { name: 'report_number', description: 'Report a number', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } };

const targets = [
  ['openrouter', OR, 'https://openrouter.ai/api/v1', 'nvidia/nemotron-3-super-120b-a12b:free', { 'HTTP-Referer': 'http://127.0.0.1:3080', 'X-Title': 'DSH probe' }],
  ['openrouter', OR, 'https://openrouter.ai/api/v1', 'thinkingmachines/inkling:free', { 'HTTP-Referer': 'http://127.0.0.1:3080', 'X-Title': 'DSH probe' }],
  ['openrouter', OR, 'https://openrouter.ai/api/v1', 'nvidia/nemotron-3.5-lightning:free', { 'HTTP-Referer': 'http://127.0.0.1:3080', 'X-Title': 'DSH probe' }],
  ['openrouter', OR, 'https://openrouter.ai/api/v1', 'inclusionai/ling-3.0-flash', { 'HTTP-Referer': 'http://127.0.0.1:3080', 'X-Title': 'DSH probe' }],
  ['openrouter', OR, 'https://openrouter.ai/api/v1', 'qwen/qwen3.8-27b', { 'HTTP-Referer': 'http://127.0.0.1:3080', 'X-Title': 'DSH probe' }],
  ['nvidia', NV, 'https://integrate.api.nvidia.com/v1', 'nvidia/nemotron-3-super-120b-a12b', {}],
  ['nvidia', NV, 'https://integrate.api.nvidia.com/v1', 'nvidia/nemotron-3.5-lightning-30b-a3b', {}],
  ['groq', GROQ, 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', {}],
];

for (const [prov, key, url, model, extraH] of targets) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraH },
      body: JSON.stringify({ model, max_tokens: 120, messages: [{ role: 'user', content: 'Report the number 777 with the tool.' }], tools: [TOOL] }),
      signal: AbortSignal.timeout(90000),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    const msg = j?.choices?.[0]?.message;
    const tc = msg?.tool_calls?.length ?? 0;
    const preview = (msg?.content ?? j?.error?.message ?? t).toString().replace(/\s+/g, ' ').slice(0, 70);
    console.log(`${prov.padEnd(11)} ${model.padEnd(46)} HTTP ${r.status} ${String(Date.now() - t0).padStart(5)}ms tool_calls=${tc} ${preview}`);
  } catch (e) {
    console.log(`${prov.padEnd(11)} ${model.padEnd(46)} ERR ${e.message}`);
  }
}
