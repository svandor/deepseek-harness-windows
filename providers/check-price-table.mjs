// Az uj MODEL_PRICES illesztes ellenorzese a plugin fajljabol kinyerve
// (a plugint nem futtatjuk: csak a tabla + a ket fuggveny kerul ki).
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../plugins/dsh-ui-extras/lib/index.js", import.meta.url), "utf8");
const table = src.match(/const MODEL_PRICES = \{[\s\S]*?\n\};/);
const fnMatch = src.match(/function modelPrices\(model\) \{[\s\S]*?\n\}/);
const freeMatch = src.match(/function isFreeModel\(model\) \{[\s\S]*?\n\}/);
if (!table || !fnMatch || !freeMatch) { console.error("nem sikerult kinyerni a tablat/fuggvenyeket"); process.exit(1); }

const scope = new Function(`${table[0]}\n${fnMatch[0]}\n${freeMatch[0]}\nreturn { modelPrices, isFreeModel, MODEL_PRICES };`)();
const { modelPrices, isFreeModel } = scope;

// A session-log source.provider + model osszefuzese utan ilyen stringek jonnek:
const cases = [
  ["alibaba/qwen3.8-flash", false, 0.113, 0.382],
  ["alibaba/qwen3.8-max", false, 1.65, 4.951],
  ["alibaba/qwen3.7-plus", false, 0.276, 1.101],
  ["alibaba/qwen3.7-flash", false, 0.028, 0.11],
  ["alibaba/qwen3-coder-flash", false, 0.144, 0.574],
  ["alibaba/kimi-k3", false, 0.113, 0.382],          // ismeretlen alibaba -> flash ar
  ["alibaba-intl/qwen3.8-flash", false, 0.15, 0.47],  // SZINGAPUR (International)
  ["alibaba-intl/qwen3.7-flash", false, 0.03, 0.13],
  ["alibaba-intl/qwen3-coder-flash", false, 0.3, 1.5],
  ["alibaba-intl/qwen3.8-omni-flash", false, 0.15, 0.47], // ismeretlen SG -> SG flash ar
  ["subagent-worker/worker", true, 0, 0],
  ["subagent-worker/local-only", true, 0, 0],
  ["subagent-worker/vision-worker", true, 0, 0],
  ["openrouter/qwen/qwen3.8-27b:free", true, 0, 0],
  ["groq/qwen/qwen3.8-27b", true, 0, 0],
  ["nvidia/nvidia/nemotron-3-super-120b-a12b", true, 0, 0],
  ["nvidia/moonshotai/kimi-k3", true, 0, 0],
  ["deepseek-official/deepseek-flash", false, 0.3, 1.2],
  ["deepseek-official/deepseek-v4-pro", false, 1.32, 3.96],
];

let bad = 0;
for (const [model, expectFree, miss, out] of cases) {
  const p = modelPrices(model);
  const free = isFreeModel(model);
  const ok = free === expectFree && Math.abs(p.missPeak - miss) < 1e-9 && Math.abs(p.outPeak - out) < 1e-9;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} ${model.padEnd(42)} ingyenes=${String(free).padEnd(5)} miss=${p.missPeak} out=${p.outPeak} (vart: ${expectFree}, ${miss}, ${out}) [kulcs: ${p.key}]`);
}
console.log(`\n${cases.length - bad}/${cases.length} eset rendben`);
process.exit(bad === 0 ? 0 : 1);
