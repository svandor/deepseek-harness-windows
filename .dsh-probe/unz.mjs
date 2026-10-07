// Teljes session-naplo kiolvasasa (tobb egymas utan fuzott zstd-frame).
// Futtatas: node unz.mjs <fajl> [kiirando karakterek]
import { createReadStream, readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const show = Number(process.argv[3] || 0);

function streamDecompress(file) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const factory = zlib.createZstdDecompress || (() => new zlib.ZstdDecompress());
    let zs;
    try { zs = factory(); } catch (e) { return reject(e); }
    const rs = createReadStream(file);
    rs.on('error', reject);
    zs.on('error', reject);
    zs.on('data', (c) => chunks.push(c));
    zs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    rs.pipe(zs);
  });
}

try {
  const txt = await streamDecompress(file);
  console.log('dekomprimált hossz (stream, minden frame):', txt.length);
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  console.log('sorok:', lines.length);
  const kinds = {};
  for (const l of lines) { try { const o = JSON.parse(l); const k = o.type || '?'; kinds[k] = (kinds[k] || 0) + 1; } catch { kinds['<tort sor>'] = (kinds['<tort sor>'] || 0) + 1; } }
  console.log('esemenytipusok:', JSON.stringify(kinds));
  for (const k of ['subagent', 'before it finished', 'was stopped', 'isError', 'assistant', 'tool_call', 'error']) {
    const n = (txt.match(new RegExp(k, 'gi')) || []).length;
    if (n) console.log(`  ${k}: ${n}`);
  }
  if (show > 0) { console.log('\n--- utolso ' + show + ' karakter ---'); console.log(txt.slice(-show)); }
} catch (e) {
  console.log('HIBA:', e.message);
  // fallback: elso frame
  try { const t = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8'); console.log('elso frame hossza:', t.length); } catch (e2) { console.log('fallback hiba:', e2.message); }
}
