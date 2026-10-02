#!/usr/bin/env node
/**
 * Melyik helyi Ollama modell tud tool-callingot?
 * Az Ollama /api/show végpontja megadja a capabilities listát. Ha nincs
 * "tools" a listában, a modell agent-loopban nem fog tudni eszközt hívni —
 * ez a legfontosabb szűrő a DSH-hoz.
 */
const BASE = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

const tags = await (await fetch(`${BASE}/api/tags`)).json();
const models = tags.models ?? [];
console.log(`Ollama: ${models.length} modell\n`);

const rows = [];
for (const m of models) {
  try {
    const show = await (await fetch(`${BASE}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: m.name }),
    })).json();
    const caps = show.capabilities ?? [];
    const sizeGB = (m.size / 1024 ** 3).toFixed(1);
    rows.push({
      name: m.name,
      tools: caps.includes('tools') ? 'IGEN' : '—',
      vision: caps.includes('vision') ? 'IGEN' : '—',
      thinking: caps.includes('thinking') ? 'IGEN' : '—',
      GB: sizeGB,
      ctx: show.model_info?.['general.context_length'] ?? show.model_info?.[`${show.details?.family}.context_length`] ?? '?',
    });
  } catch (e) {
    rows.push({ name: m.name, tools: 'HIBA', vision: '', thinking: '', GB: '?', ctx: '' });
  }
}

const any = (v) => v === 'IGEN';
rows.sort((a, b) => (any(b.tools) - any(a.tools)) || Number(a.GB) - Number(b.GB));

console.log('modell'.padEnd(30), 'tool'.padEnd(6), 'lat'.padEnd(6), 'gondolk'.padEnd(9), 'GB'.padEnd(6), 'ctx');
console.log('-'.repeat(78));
for (const r of rows) {
  console.log(r.name.padEnd(30), r.tools.padEnd(6), r.vision.padEnd(6), r.thinking.padEnd(9), String(r.GB).padEnd(6), r.ctx);
}

const usable = rows.filter((r) => any(r.tools));
console.log(`\nAgent-loopra használható (van "tools" képesség): ${usable.length}/${rows.length}`);
console.log(usable.map((r) => r.name).join(', '));
