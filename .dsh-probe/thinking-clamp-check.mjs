// Regression: does a SMALL max_tokens request still work on an Alibaba target (thinking_budget clamp),
// and does a normal one stay capped?
const base = 'http://127.0.0.1:4123/v1/chat/completions';
const H = { 'content-type': 'application/json', authorization: 'Bearer worker' };

async function call(label, body) {
  const t0 = Date.now();
  const r = await fetch(base, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  const err = j?.error?.message ?? '';
  console.log(`${label.padEnd(30)} HTTP ${r.status} ${String(Date.now() - t0).padStart(6)}ms ${err ? 'ERR ' + err.slice(0, 90) : 'ok'}`);
}

// small max_tokens: this is what the harness uses for session titles
await call('free-quota max_tokens=64', { model: 'free-quota', stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'Say OK' }] });
await call('free-quota max_tokens=16', { model: 'free-quota', stream: false, max_tokens: 16, messages: [{ role: 'user', content: 'Say OK' }] });
await call('free-quota no max_tokens', { model: 'free-quota', stream: false, messages: [{ role: 'user', content: 'Say OK' }] });
