// Which concrete target does the `auto` route pick now, for text and image requests?
const base = 'http://127.0.0.1:4123/v1/chat/completions';
const H = { 'content-type': 'application/json', authorization: 'Bearer worker' };

async function call(label, body) {
  const t0 = Date.now();
  const r = await fetch(base, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const t = await r.text();
  const first = t.slice(0, 160).replace(/\s+/g, ' ');
  console.log(`${label.padEnd(22)} HTTP ${r.status} ${Date.now() - t0}ms  ${t.includes('"error"') ? first : 'ok'}`);
}

const msgs = [{ role: 'user', content: 'Reply with the single word: OK' }];
await call('auto text', { model: 'auto', stream: false, max_tokens: 16, messages: msgs });

// image request: 1x1 red PNG
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
await call('auto + image', {
  model: 'auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'What color is this pixel?' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
  ] }],
});
