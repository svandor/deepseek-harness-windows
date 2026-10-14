// Node ESM module to parse model pricing data
// Expected to be run on Windows with Node v18+ (ESM support)

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MODEL_IDS = [
  'qwen3.7-flash',
  'qwen3.8-flash',
  'qwen3.8-max',
  'qwen3.7-plus',
  'qwen3-coder-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash-0731',
];

const ALLOWED_SCOPES = [
  'Global',
  'International',
  'EU',
  'US (Virginia)',
  'China (Beijing)',
  'Japan (Tokyo)',
];

/**
 * Strip HTML and convert to | delimited text as per spec.
 * @param {string} html
 * @returns {string}
 */
function cleanHtml(html) {
  // Remove script and style tags
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                 .replace(/<style[\s\S]*?<\/style>/gi, '');
  // Replace all HTML tags with |
  text = text.replace(/<[^>]+>/g, '|');
  // Collapse multiple |
  text = text.replace(/\|+/g, '|');
  // Collapse whitespace to single space
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

/**
 * Parse the content of the pricing text file.
 * @param {string} text
 * @returns {object}
 */
export function parsePrices(text) {
  const cleaned = cleanHtml(text);
  const lines = cleaned.split(/\r?\n/).filter(Boolean);
  const results = {};

  // Helper to set up result structure
  function ensureScope(model, scope) {
    if (!results[model]) results[model] = {};
    if (!results[model][scope]) results[model][scope] = { tiers: [] };
    return results[model][scope];
  }

  for (const line of lines) {
    const cells = line.split('|').map(s => s.trim());
    if (cells.length < 5) continue;
    const modelRaw = cells[0];
    const model = MODEL_IDS.find(id => modelRaw.startsWith(id));
    if (!model) continue;
    const scope = cells[4];
    if (!ALLOWED_SCOPES.includes(scope)) continue;
    const scopeObj = ensureScope(model, scope);

    // Start parsing after scope cell (index 5)
    let idx = 5;

    // Check if next cell contains a tier marker like 'Token≤...' or just price
    const firstCell = cells[idx];
    if (!firstCell.includes('Token≤')) {
      // Flat row for whole range
      const missCell = firstCell;
      const outCell = cells[idx + 1];
      const tier = parseTierRow(null, missCell, outCell);
      if (tier) scopeObj.tiers.push(tier);
      continue;
    }
    // loop tiers
    while (idx < cells.length) {
      const tierCell = cells[idx];
      const match = /Token≤([0-9]+K?)/.exec(tierCell);
      if (!match) break;
      let upTo = parseInt(match[1].replace('K', ''), 10);
      if (tierCell.includes('K')) upTo *= 1000;
      const missCell = cells[idx + 1] ?? '';
      const outCell = cells[idx + 2] ?? '';
      const tier = parseTierRow(upTo, missCell, outCell);
      if (tier) scopeObj.tiers.push(tier);
      idx += 3;
    }
  }

  // If a base id has no rows, try to find a dated variant
  const final = {};
  for (const model of MODEL_IDS) {
    if (results[model]) {
      final[model] = results[model];
    } else {
      const variant = Object.keys(results).find(k => k.startsWith(model + '-'));
      if (variant) final[variant] = results[variant];
    }
  }
  return final;
}

function parseTierRow(upTo, missCell, outCell) {
  function extractPrices(cell) {
    if (!cell) return {};
    const parts = cell.split('|').map(p => p.trim());
    if (parts.length === 2 && parts[0].toLowerCase().startsWith('busy hours')) {
      const busy = parseFloat(parts[0].replace(/[^0-9.]/g, ''));
      const idle = parseFloat(parts[1].replace(/[^0-9.]/g, ''));
      return { busy, idle };
    }
    const num = parseFloat(cell.replace(/[^0-9.]/g, ''));
    return { plain: num };
  }
  const miss = extractPrices(missCell);
  const out = extractPrices(outCell);
  if (!('plain' in miss) && ('busy' in miss) === false) return undefined;
  const tier = { upTo: upTo ?? null };
  if ('plain' in miss) tier.miss = miss.plain;
  if ('plain' in out) tier.out = out.plain;
  if ('busy' in miss) tier.busyMiss = miss.busy;
  if ('idle' in miss) tier.idleMiss = miss.idle;
  if ('busy' in out) tier.busyOut = out.busy;
  if ('idle' in out) tier.idleOut = out.idle;
  return tier;
}

// Self-test, de CSAK kozvetlen futtataskor (node pricing-parser.mjs).
// MERVE 2026-10-14: az `import.meta.url.endsWith(...)` feltetel MINDIG igaz,
// ezert az autotune importja lefuttatta az ontesztet, es annak process.exit(1)-je
// megolte az autotune folyamatot. Az entry pointot kell osszevetni.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('pricing-parser.mjs')) {
  const fp = resolve('providers/model-pricing.txt');
  if (!existsSync(fp)) {
    console.error('Pricing file not found:', fp);
    process.exit(1);
  }
  const txt = readFileSync(fp, 'utf8');
  const data = parsePrices(txt);

  console.log('Parsed pricing table (compact):');
  for (const model of MODEL_IDS) {
    const scopes = data[model];
    if (!scopes) continue;
    console.log(`\n${model}:`);
    for (const scope of Object.keys(scopes)) {
      console.log(`  ${scope}:`);
      for (const t of scopes[scope].tiers) {
        console.log('    ', t);
      }
    }
  }

  const assert = (cond, msg) => {
    if (!cond) {
      console.error('FAIL', msg);
      failed = true;
    } else {
      console.log('OK', msg);
    }
  };
  let failed = false;

  const chk = (model, scope, idx, miss, out) => {
    const tier = data[model]?.[scope]?.tiers?.[idx];
    if (!tier) return assert(false, `Missing tier ${idx} for ${model}/${scope}`);
    assert(Math.abs(tier.miss - miss) < 1e-6, `${model}/${scope} miss ${tier.miss} ≈ ${miss}`);
    assert(Math.abs(tier.out - out) < 1e-6, `${model}/${scope} out ${tier.out} ≈ ${out}`);
  };

  chk('qwen3.8-flash', 'Global', 0, 0.113, 0.382);
  chk('qwen3.8-flash', 'International', 0, 0.15, 0.47);
  chk('qwen3.7-flash', 'Global', 0, 0.028, 0.11);
  chk('qwen3.7-flash', 'Global', 1, 0.083, 0.33);
  chk('qwen3.7-flash', 'Global', 2, 0.165, 0.66);
  chk('qwen3-coder-flash', 'Global', 0, 0.144, 0.574);

  const d1 = data['deepseek-v4.1-flash']?.['Global']?.tiers?.[0];
  if (d1) {
    assert(Math.abs((d1.busyMiss ?? 0) - 0.283) < 1e-6, 'deepseek-v4.1-flash busyMiss');
    assert(Math.abs((d1.idleMiss ?? 0) - 0.141) < 1e-6, 'deepseek-v4.1-flash idleMiss');
    assert(Math.abs((d1.busyOut ?? 0) - 1.131) < 1e-6, 'deepseek-v4.1-flash busyOut');
    assert(Math.abs((d1.idleOut ?? 0) - 0.565) < 1e-6, 'deepseek-v4.1-flash idleOut');
  } else assert(false, 'deepseek-v4.1-flash missing');

  const d2 = data['deepseek-v4-pro']?.['Global']?.tiers?.[0];
  if (d2) {
    assert(Math.abs(d2.miss - 1.65) < 1e-6, 'deepseek-v4-pro miss');
    assert(Math.abs(d2.out - 3.301) < 1e-6 || Math.abs(d2.out - 3.3) < 1e-6, 'deepseek-v4-pro out');
  } else assert(false, 'deepseek-v4-pro missing');

  const d3 = data['deepseek-v4-pro-0813']?.['Global']?.tiers?.[0];
  if (d3) {
    assert(Math.abs((d3.busyMiss ?? 0) - 1.272) < 1e-6, 'deepseek-v4-pro-0813 busyMiss');
    assert(Math.abs((d3.idleMiss ?? 0) - 0.636) < 1e-6, 'deepseek-v4-pro-0813 idleMiss');
    assert(Math.abs((d3.busyOut ?? 0) - 3.816) < 1e-6, 'deepseek-v4-pro-0813 busyOut');
    assert(Math.abs((d3.idleOut ?? 0) - 1.908) < 1e-6, 'deepseek-v4-pro-0813 idleOut');
  } else assert(false, 'deepseek-v4-pro-0813 missing');

  if (failed) {
    process.exit(1);
  }
  console.log('All assertions passed.');
}
