#!/usr/bin/env node
/**
 * check-delegation-route.mjs — melyik úton futottak a delegált (subagent)
 * gyermekek, és mennyibe kerültek.
 *
 * A KÉRDÉS, amit megválaszol: „történt-e ma ingyenes delegálás?" A statisztika
 * 30 napos összesítője ezt nem mondja meg napi bontásban, a session-naplókból
 * viszont pontosan látszik minden gyermek route-ja (`source.model`).
 *
 * Az „ingyenes" azt jelenti, hogy a modell a hivatalos ártábla NULLA árú sorára
 * esik (`isFreeModel`): a helyi fallback proxy `worker` route-ja és a lánc tagjai.
 * Minden más modell fizetős.
 *
 * Használat:
 *   node providers/check-delegation-route.mjs              # utolsó 24 óra
 *   node providers/check-delegation-route.mjs --hours 72
 *   node providers/check-delegation-route.mjs --all        # minden gyermek
 *
 * Kilépési kód: 0 = rendben, 1 = nem volt egyetlen gyermek sem a ablakban.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isFreeModel, requestCost } from '../plugins/dsh-ui-extras/lib/index.js';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const HOURS = Number(valueOf('--hours', '24'));
const ALL = argv.includes('--all');
const since = ALL ? 0 : Date.now() - HOURS * 60 * 60 * 1000;
const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');

function readFrame(buffer) {
  return new Promise((resolve) => {
    const stream = createZstdDecompress();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), consumed: stream.bytesWritten }));
    stream.on('error', () => resolve({ text: '', consumed: buffer.length }));
    stream.end(buffer);
  });
}

async function decompress(buffer) {
  let offset = 0;
  let text = '';
  let frames = 0;
  while (offset < buffer.length && frames < 200000) {
    const frame = await readFrame(buffer.subarray(offset));
    if (frame.consumed <= 0) break;
    offset += frame.consumed;
    frames += 1;
    text += frame.text;
  }
  return text;
}

const children = [];
for (const workspace of readdirSync(root, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue;
  const workspacePath = join(root, workspace.name);
  for (const entry of readdirSync(workspacePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(workspacePath, entry.name, 'session.v3.jsonl.zstd');
    if (!existsSync(file)) continue;
    let text = '';
    try { text = await decompress(readFileSync(file)); } catch { continue; }
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    let header = null;
    try { header = JSON.parse(lines[0]); } catch { continue; }
    if (header?.origin !== 'subagent' && (header?.delegationDepth ?? 0) === 0) continue;
    const models = new Map();
    let requests = 0;
    let costUsd = 0;
    let last = 0;
    let first = 0;
    for (const line of lines) {
      if (!line.includes('"assistant/message"')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'assistant/message') continue;
      const usage = event.data?.usage;
      if (!usage) continue;
      if (typeof event.time === 'number' && event.time < since) continue;
      const source = event.data?.message?.source ?? event.data?.source ?? {};
      const model = typeof source.model === 'string' ? source.model : '?';
      const cost = requestCost(usage, model, event.time);
      requests += 1;
      costUsd += cost;
      if (typeof event.time === 'number') {
        if (!first || event.time < first) first = event.time;
        if (event.time > last) last = event.time;
      }
      const bucket = models.get(model) ?? { model, requests: 0, costUsd: 0, free: isFreeModel(model) };
      bucket.requests += 1;
      bucket.costUsd += cost;
      models.set(model, bucket);
    }
    if (requests === 0) continue;
    children.push({ id: header.id, parent: header.parentSession ?? '-', workspace: workspace.name, first, last, requests, costUsd, models: [...models.values()] });
  }
}

children.sort((a, b) => b.last - a.last);
const freeChildren = children.filter((child) => child.models.every((model) => model.free));
const paidChildren = children.filter((child) => child.models.some((model) => !model.free));

console.log('');
console.log(`Delegált gyermekek — ${ALL ? 'minden idő' : `utolsó ${HOURS} óra`}`);
console.log('='.repeat(44));
console.log(`Host: ${root}`);
if (children.length === 0) {
  console.log('');
  console.log('Nem volt egyetlen kérés sem delegált gyermekben ebben az ablakban.');
  console.log('(Az ingyenes lánc csak akkor számol, ha valaki tényleg delegál —');
  console.log(' a proxy önmagában nem indít munkát.)');
  process.exit(1);
}

for (const child of children) {
  const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '?');
  const kind = child.models.every((model) => model.free) ? 'INGYENES' : 'FIZETOS ';
  console.log('');
  console.log(`[${kind}] ${when(child.first)} .. ${when(child.last)}  ${child.requests} kérés  $${child.costUsd.toFixed(5)}`);
  console.log(`   gyermek: ${child.id}`);
  console.log(`   szulo:   ${child.parent}   [${child.workspace}]`);
  for (const model of child.models) {
    console.log(`   ${model.free ? 'ingyenes' : 'fizetős '} ${model.model}: ${model.requests} kérés, $${model.costUsd.toFixed(5)}`);
  }
}

console.log('');
console.log('Összegzés');
console.log('---------');
console.log(`  ingyenes gyermek: ${freeChildren.length}  (${freeChildren.reduce((sum, child) => sum + child.requests, 0)} kérés)`);
console.log(`  fizetős gyermek:  ${paidChildren.length}  (${paidChildren.reduce((sum, child) => sum + child.requests, 0)} kérés, $${paidChildren.reduce((sum, child) => sum + child.costUsd, 0).toFixed(5)})`);
const lastFree = freeChildren[0];
console.log(`  utolsó ingyenes delegálás: ${lastFree ? new Date(lastFree.last).toISOString().replace('T', ' ').slice(0, 19) : 'nincs ilyen az ablakban'}`);
process.exit(0);
