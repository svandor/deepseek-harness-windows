// Check which DeepSeek ids actually answer on the Alibaba EU / SG workspaces.
import { readFileSync } from 'node:fs';
const c = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const ref = (n) => { for (const l of c.split(/\r?\n/)) { const m = l.match(new RegExp(`^\\s{2}${n}:\\s*(\\S+)\\s*$`)); if (m) return m[1]; } return null; };
const SG = ref('ALIBABA_SG_BASE_URL'), SGK = ref('DASHSCOPE_API_KEY');
const EU = ref('ALIBABA_EU_BASE_URL'), EUK = ref('ALIBABA_API_KEY');

const tests = [
  ['EU', EU, EUK, 'deepseek-v4.1-flash'],
  ['EU', EU, EUK, 'deepseek-v4-flash-0731'],
  ['EU', EU, EUK, 'deepseek-v4-pro'],
  ['SG', SG, SGK, 'deepseek-v4.1-flash'],
  ['SG', SG, SGK, 'deepseek-v4-flash-0731'],
  ['SG', SG, SGK, 'deepseek-v4-pro'],
];
for (const [region, url, key, model] of tests) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    console.log(`${region} ${model.padEnd(24)} HTTP ${r.status} ${Date.now() - t0}ms ${t.slice(0, 160).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`${region} ${model.padEnd(24)} ERR ${e.message}`); }
}
