#!/usr/bin/env node
/**
 * Google modell-teszt: a /v1/models listában SZEREPLŐ modellek közül melyik
 * hívható meg ténylegesen? A lista létezése nem jelenti, hogy a modell
 * elérhető az adott kulccsal (pl. "no longer available to new users").
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const creds = readFileSync(path.join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
const key = creds.match(/^\s{2}GOOGLE_API_KEY:\s*(\S+)\s*$/m)[1];
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

const MODELS = [
  'deep-research-max-preview-04-2026', 'deep-research-preview-04-2026',
  'gemini-2.5-computer-use-preview-10-2025', 'gemini-2.5-flash',
  'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3-flash-preview',
  'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-lite-preview', 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools', 'gemini-3.5-flash',
  'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash',
  'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest',
  'gemma-4-26b-a4b-it', 'gemma-4-31b-it',
];

const TASK = 'What is 2+2? Answer with just the number.';

async function probe(model, withTools) {
  const body = {
    model,
    messages: [{ role: 'user', content: TASK }],
    max_tokens: 512,
  };
  if (withTools) {
    body.tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }];
  }
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, detail: t.replace(/\s+/g, ' ').slice(0, 110) };
  let j;
  try { j = JSON.parse(t); } catch { return { ok: false, detail: 'nem JSON valasz' }; }
  const msg = j.choices?.[0]?.message;
  const content = msg?.content ?? '';
  const toolCalls = msg?.tool_calls?.length ?? 0;
  return {
    ok: true,
    content: String(content).replace(/\s+/g, ' ').slice(0, 60),
    hasThought: /<\/?thought>/i.test(String(content)),
    toolCalls,
    finish: j.choices?.[0]?.finish_reason,
  };
}

console.log('modell'.padEnd(40), 'chat', '  tool', '  megjegyzes');
console.log('-'.repeat(100));
const usable = [];
for (const m of MODELS) {
  const r = await probe(m, false);
  if (!r.ok) {
    console.log(m.padEnd(40), '✗   ', '     ', r.detail);
    continue;
  }
  const notes = [];
  if (r.hasThought) notes.push('NYERS <thought> a content-ben');
  if (!r.content) notes.push('URES content');
  if (r.finish) notes.push(`finish=${r.finish}`);
  console.log(m.padEnd(40), '✓   ', '     ', notes.join('; ') || `"${r.content}"`);
  usable.push(m);
}

console.log(`\nHivhato modellek: ${usable.length}/${MODELS.length}`);

// tool-calling ellenorzes a hivhato modelleken
console.log('\n=== tool-calling teszt a hivhato modelleken ===');
for (const m of usable) {
  try {
    const r = await probe(m, true);
    const verdict = !r.ok ? `✗ ${r.detail}` : r.toolCalls > 0 ? `✓ tool_calls=${r.toolCalls}` : `— nem hivott toolt (finish=${r.finish})`;
    console.log(m.padEnd(40), verdict);
  } catch (e) {
    console.log(m.padEnd(40), 'halozat hiba: ' + e.message);
  }
}
