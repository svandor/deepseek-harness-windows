// Which non-Qwen Alibaba models exist on the EU/SG workspaces, do they call tools,
// how fast are they, and do they think by default? Small bodies, cheap calls.
import { readFileSync } from 'node:fs';

const c = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const ref = (n) => { for (const l of c.split(/\r?\n/)) { const m = l.match(new RegExp(`^\\s{2}${n}:\\s*(\\S+)\\s*$`)); if (m) return m[1]; } return null; };
const EU = ref('ALIBABA_EU_BASE_URL'), EUK = ref('ALIBABA_API_KEY');
const SG = ref('ALIBABA_SG_BASE_URL'), SGK = ref('DASHSCOPE_API_KEY') || EUK;

const PAT = /glm|kimi|qwen3\.8-max|qwen3\.7-plus|qwen3-coder-flash|qwen3-coder-plus/;

async function listModels(label, url, key) {
  try {
    const r = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(40000) });
    const j = await r.json();
    const ids = (j.data ?? []).map((m) => m.id).filter((id) => PAT.test(id)).sort();
    console.log(`\n${label} (${ids.length} találat):`);
    console.log('  ' + ids.join('\n  '));
  } catch (e) { console.log(`\n${label} /models ERR ${e.message}`); }
}

const TOOL = {
  type: 'function',
  function: {
    name: 'report_number',
    description: 'Report a number',
    parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  },
};

async function probe(label, url, key, model) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, stream: true, max_tokens: 200,
        messages: [{ role: 'user', content: 'Report the number 777 with the tool.' }],
        tools: [TOOL],
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) { const t = await r.text(); console.log(`[FAIL ${r.status}] ${label.padEnd(26)} ${model.padEnd(22)} ${Date.now() - t0}ms ${t.replace(/\s+/g, ' ').slice(0, 120)}`); return; }
    let ttft = null, usage = null, toolCalls = 0, reasoningChars = 0, contentChars = 0, finish = null;
    const dec = new TextDecoder(); let buf = '';
    for await (const ch of r.body) {
      if (ttft === null) ttft = Date.now() - t0;
      buf += dec.decode(ch, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim(); if (!s.startsWith('data:')) continue;
        const p = s.slice(5).trim(); if (p === '[DONE]') continue;
        let j; try { j = JSON.parse(p); } catch { continue; }
        if (j.error) { console.log(`[ERREV] ${label} ${model} :: ${String(j.error.message || j.error).slice(0, 140)}`); return; }
        if (j.usage) usage = j.usage;
        const ch0 = j.choices?.[0];
        if (ch0?.finish_reason) finish = ch0.finish_reason;
        const d = ch0?.delta ?? {};
        if (d.tool_calls) toolCalls += d.tool_calls.length;
        if (d.reasoning_content) reasoningChars += d.reasoning_content.length;
        if (typeof d.content === 'string') contentChars += d.content.length;
      }
    }
    const u = usage || {};
    console.log(`[OK] ${label.padEnd(26)} ${model.padEnd(22)} ${String(Date.now() - t0).padStart(6)}ms ttft=${String(ttft).padStart(5)} out=${String(u.completion_tokens ?? '?').padStart(4)} reason_tok=${u.completion_tokens_details?.reasoning_tokens ?? '?'} toolDeltas=${toolCalls} finish=${finish}`);
  } catch (e) { console.log(`[THROW] ${label} ${model} :: ${e.message}`); }
}

await listModels('EU', EU, EUK);
await listModels('SG', SG, SGK);

console.log('\n--- próbák (EU) ---');
const eu = ['glm-5.1', 'glm-5.2', 'glm-5.3', 'kimi-k2.5', 'kimi-k2.7-code', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3-coder-flash'];
for (const m of eu) await probe('EU', EU, EUK, m);

console.log('\n--- próbák (SG) ---');
for (const m of ['glm-5.2', 'kimi-k2.7-code', 'qwen3.8-max']) await probe('SG', SG, SGK, m);
