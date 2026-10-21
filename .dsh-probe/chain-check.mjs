// End-to-end: does the free `worker` chain serve a tool call, and which target wins?
const TOOL = { type: 'function', function: { name: 'report_number', description: 'Report a number', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } } };

async function call(label, model, messages, tools) {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:4123/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer worker' },
    body: JSON.stringify({ model, stream: false, max_tokens: 200, messages, tools }),
    signal: AbortSignal.timeout(120000),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  const tc = j?.choices?.[0]?.message?.tool_calls?.length ?? 0;
  console.log(`${label.padEnd(26)} HTTP ${r.status} ${String(Date.now() - t0).padStart(6)}ms tool_calls=${tc} ${j?.error?.message?.slice(0, 80) ?? ''}`);
}

await call('worker + tool', 'worker', [{ role: 'user', content: 'Report the number 777 with the tool.' }], [TOOL]);
await call('free-quota + tool', 'free-quota', [{ role: 'user', content: 'Report the number 777 with the tool.' }], [TOOL]);
