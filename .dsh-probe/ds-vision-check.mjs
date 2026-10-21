// Does DeepSeek direct accept images (vision)? Cheap check with a tiny PNG.
import { readFileSync } from 'node:fs';
const c = readFileSync(`${process.env.USERPROFILE}\\.dsh\\.credentials.yaml`, 'utf8');
const ref = (n) => { for (const l of c.split(/\r?\n/)) { const m = l.match(new RegExp(`^\\s{2}${n}:\\s*(\\S+)\\s*$`)); if (m) return m[1]; } return null; };
const K = ref('DEEPSEEK_API_KEY');
const png = readFileSync('C:\\Szerver\\Deepseek Harness\\providers\\vision-test.png').toString('base64');
for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${K}` },
      body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: [
        { type: 'text', text: 'What number is on the image?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
      ] }] }),
      signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    console.log(`${model} HTTP ${r.status}: ${t.replace(/\s+/g, ' ').slice(0, 220)}`);
  } catch (e) { console.log(`${model} ERR ${e.message}`); }
}
