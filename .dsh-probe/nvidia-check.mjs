// Are the currently configured free chain targets still alive and tool-calling?
import { readFileSync } from 'node:fs';
const c = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const ref = (n) => { for (const l of c.split(/\r?\n/)) { const m = l.match(new RegExp(`^\\s{2}${n}:\\s*(\\S+)\\s*$`)); if (m) return m[1]; } return null; };
const NV = ref('NVIDIA_API_KEY');
const TOOL = { type: 'function', function: { name: 'report_number', description: 'Report a number', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } };

for (const model of ['nvidia/openai/gpt-oss-20b', 'moonshotai/kimi-k2.6', 'openai/gpt-oss-20b', 'deepseek-ai/deepseek-v4.1-flash', 'nvidia/nemotron-3-super-120b-a12b']) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${NV}` },
      body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: 'Report the number 777 with the tool.' }], tools: [TOOL] }),
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    const tc = j?.choices?.[0]?.message?.tool_calls?.length ?? 0;
    console.log(`nvidia ${model.padEnd(42)} HTTP ${r.status} ${String(Date.now() - t0).padStart(5)}ms tool_calls=${tc} ${(j?.detail ?? j?.error?.message ?? '').toString().slice(0, 60)}`);
  } catch (e) { console.log(`nvidia ${model.padEnd(42)} ERR ${e.message}`); }
}
