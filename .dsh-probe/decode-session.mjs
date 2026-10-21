// Decode a DSH session log: a sequence of concatenated zstd frames.
// Usage: node decode-session.mjs <in.zstd> <out.jsonl>
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const [, , inp, outp] = process.argv;
const b = readFileSync(inp);
const magic = [0x28, 0xb5, 0x2f, 0xfd];
const starts = [];
for (let i = 0; i + 4 <= b.length; i++) {
  if (b[i] === magic[0] && b[i + 1] === magic[1] && b[i + 2] === magic[2] && b[i + 3] === magic[3]) starts.push(i);
}
starts.push(b.length);
const parts = [];
let okFrames = 0, badFrames = 0;
for (let k = 0; k + 1 < starts.length; k++) {
  const slice = b.subarray(starts[k], starts[k + 1]);
  try { parts.push(zstdDecompressSync(slice)); okFrames++; }
  catch (e) { badFrames++; if (badFrames < 3) console.error(`frame ${k} @${starts[k]}: ${e.message}`); }
}
const out = Buffer.concat(parts);
writeFileSync(outp, out);
console.log(`frames=${starts.length - 1} ok=${okFrames} bad=${badFrames} outBytes=${out.length}`);

// quick shape summary
const lines = out.toString('utf8').split(/\r?\n/).filter(Boolean);
const types = {};
for (const l of lines) { try { const j = JSON.parse(l); types[j.type ?? '?'] = (types[j.type ?? '?'] ?? 0) + 1; } catch { types['<unparsed>'] = (types['<unparsed>'] ?? 0) + 1; } }
console.log('lines=', lines.length, JSON.stringify(types));
