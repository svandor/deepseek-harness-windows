#!/usr/bin/env node
/**
 * A HELYI OLLAMA kivétele a DSH beállításaiból (2026-11-11).
 *
 * MIÉRT: Windows alatt a helyi Ollama (llama-server) és a DSH együtt nem fér el
 * a memóriában. Mért tünet: ~22 GB használt RAM környékén a Windows újraindítja
 * a DSH-t, és a folyamatban lévő munkamenetek megszakadnak. Ezért Windows alatt
 * a DSH nem hívhat helyi Ollamát — sem a delegálási láncban (azt a proxy kapuja
 * és a providers/config.json tiltja), sem közvetlenül (ezt a fájlt kezeli ez az
 * eszköz: a settings.yaml `ollama-local` providerét és a `local-only` modellt).
 *
 * A szerkesztés SZÖVEGES (a kommentek megmaradnak), de a döntés STRUKTURÁLIS:
 * a YAML-t a DSH saját `yaml` csomagjával parse-oljuk, és a struktúrát nézzük,
 * nem a szöveget. Így a "benne van-e még" kérdésre nem lehet hamis választ adni.
 *
 * Használat:
 *   node tools/local-ollama-settings.mjs            # --check (alap): csak jelent
 *   node tools/local-ollama-settings.mjs --apply    # kiveszi, mentés + validálás
 *   node tools/local-ollama-settings.mjs --dry-run  # mint az --apply, de nem ír
 *
 * Kilépés: 0 = rendben (check: nincs helyi hivatkozás), 1 = talált hivatkozás
 * / hiba, 2 = nem található a settings.yaml vagy a yaml parser.
 *
 * VISSZAÁLLÍTÁS LINUXON: a kivett blokkok tartalma a
 * `providers/settings.ollama-local-disabled.yaml` fájlban van, a teendőket az
 * AGENTS.md 2.1 pontja írja.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SETTINGS = join(homedir(), ".dsh", "settings.yaml");
const CHECKOUT_PKG = "C:/Users/info/AppData/Local/npm-cache/_npx/b86ed90107c62dab/package.json";

const APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry-run");

if (!existsSync(SETTINGS)) {
  console.error(`Nem talalom: ${SETTINGS}`);
  process.exit(2);
}

/** A DSH sajat yaml csomagja (a checkoutbol), hogy ugyanaz parse-olja, mint a harness. */
function loadYaml() {
  try {
    const req = createRequire(CHECKOUT_PKG);
    return req("yaml");
  } catch (e) {
    console.error(`Nem erem el a yaml csomagot (${CHECKOUT_PKG}): ${e?.message ?? e}`);
    process.exit(2);
  }
}
const YAML = loadYaml();

/** Helyi Ollama-hivatkozások STRUKTURÁLIS keresése a parse-olt beállításban. */
function findLocalOllama(cfg) {
  const found = [];
  const providers = cfg?.["llm-pi-ai"]?.providers ?? {};
  for (const [id, def] of Object.entries(providers)) {
    const base = String(def?.baseURL ?? "");
    if (/ollama/i.test(id) || /:11434|localhost:11434|127\.0\.0\.1:11434/.test(base)) {
      found.push(`llm-pi-ai.providers.${id} (baseURL: ${base || "?"})`);
    }
    for (const m of Array.isArray(def?.models) ? def.models : []) {
      if (String(m?.id ?? "") === "local-only") found.push(`llm-pi-ai.providers.${id}.models -> local-only`);
    }
  }
  const allowed = cfg?.["subagent-model-selection"]?.allowedModels;
  if (Array.isArray(allowed)) {
    allowed.forEach((r, i) => {
      const prov = String(r?.provider ?? "");
      const model = String(r?.model ?? "");
      if (/ollama/i.test(prov) || model === "local-only" || /ollama/i.test(model)) {
        found.push(`subagent-model-selection.allowedModels[${i}] = ${prov}/${model}`);
      }
    });
  }
  return found;
}

/** Szöveges cserék: mindegyik PONTOSAN egyszer fordulhat elő (vagy már kész). */
const EDITS = [
  {
    name: "allowedModels: local-only cél kivétele",
    find:
      "    # Helyi, VRAM-kimelo gyermek-cel a PROXYN at (keep_alive 2m): mert 2026-10-07,\n" +
      "    # qwen2.5:7b-instruct — valodi tool_calls 3-4 s alatt, 6,14 GB VRAM a hivas alatt.\n" +
      "    - provider: subagent-worker\n" +
      "      model: local-only\n",
    replace:
      "    # 2026-11-11: a HELYI (local-only) gyermek-cel KIVÉVE. Windows alatt a helyi\n" +
      "    # Ollama betöltése ~22 GB RAM-nál újraindítja a DSH-t (megszakadt\n" +
      "    # munkamenetek), ezért a DSH nem hívhat helyi modellt — sem a proxy láncában,\n" +
      "    # sem közvetlenül. AGENTS.md 2.1; Linuxra átállás után visszatehető:\n" +
      "    # providers/settings.ollama-local-disabled.yaml\n",
  },
  {
    name: "subagent-worker.models: local-only modell kivétele",
    find:
      "        # Helyi, VRAM-kimelo lanc (qwen2.5:7b-instruct, keep_alive 2m).\n" +
      "        - id: local-only\n" +
      "          name: Helyi Ollama (VRAM-kimelo, utolso tartalek)\n" +
      "          contextWindow: 131072\n" +
      "          maxTokens: 16384\n",
    replace:
      "        # 2026-11-11: a `local-only` modell KIVÉVE (helyi Ollama tilos, AGENTS.md 2.1).\n" +
      '        # A proxy route neve megmaradt, de ures lanccal 503-at ad: "local_ollama_disabled".\n',
  },
  {
    name: "worker modell megjelenített neve (Ollama említés)",
    find: "          name: Worker (Groq -> OpenRouter -> Ollama -> Alibaba)\n",
    replace: "          name: Worker (NVIDIA -> Groq -> Google -> OpenRouter)\n",
  },
  {
    name: "a subagent-worker provider fejléce (lánc leírás)",
    find:
      "    # Ez egy HELYI proxyra mutat (providers\\proxy.mjs), ami a `worker`\n" +
      "    # route-ot szolgalja ki:\n" +
      "    #   NVIDIA kimi-k2.6 -> Groq gpt-oss-120b -> OpenRouter qwen3.8-27b:free\n" +
      "    #   -> helyi Ollama qwen2.5-coder:14b\n",
    replace:
      "    # Ez egy HELYI proxyra mutat (providers\\proxy.mjs), ami a `worker`\n" +
      "    # route-ot szolgalja ki (a helyi Ollama záró szakasz NÉLKÜL):\n" +
      "    #   NVIDIA nemotron-3.5-lightning:free -> nemotron-3.5-super-vl:free\n" +
      "    #   -> Groq gpt-oss-120b -> Google gemini-3.1-flash-lite / gemini-3-flash\n" +
      "    # 2026-11-11: a helyi Ollama Windows alatt TILOS (AGENTS.md 2.1) — a\n" +
      "    # korábbi záró szakasz a providers/settings.ollama-local-disabled.yaml-ban van.\n",
  },
];

/** Az `ollama-local:` provider blokk kivétele (sor-alapú, indentáció szerint). */
function stripOllamaProvider(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^ {4}ollama-local:\s*$/.test(l));
  if (start === -1) return { text, removed: 0 };
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === "") { end += 1; continue; }
    // A blokk gyerekei 4-nél mélyebben vannak behúzva; a szomszéd provider 4-en.
    if (/^ {5,}/.test(l)) { end += 1; continue; }
    break;
  }
  const note = [
    "    # 2026-11-11: az `ollama-local` PROVIDER ELTÁVOLÍTVA (helyi Ollama tilos Windows",
    "    # alatt, AGENTS.md 2.1). A teljes blokk és a modellek listája:",
    "    # providers/settings.ollama-local-disabled.yaml — Linuxon onnan állítható vissza,",
    "    # a proxy config.json localOllama.enabled kapcsolójával együtt.",
  ];
  return { text: [...lines.slice(0, start), ...note, ...lines.slice(end)].join("\n"), removed: end - start };
}

// ── 1. jelenlegi állapot ───────────────────────────────────────────────────
const before = readFileSync(SETTINGS, "utf8");
let parsed;
try {
  parsed = YAML.parse(before);
} catch (e) {
  console.error(`A settings.yaml NEM érvényes YAML — nem nyúlok hozzá: ${e?.message ?? e}`);
  process.exit(2);
}
const findingsBefore = findLocalOllama(parsed);

console.log(`settings.yaml: ${SETTINGS}`);
console.log(`helyi Ollama-hivatkozás: ${findingsBefore.length}`);
for (const f of findingsBefore) console.log(`  - ${f}`);

if (!APPLY && !DRY) {
  console.log(findingsBefore.length === 0 ? "\nVERDIKT: tiszta (nincs helyi Ollama a beállításban)." : "\nVERDIKT: van helyi hivatkozás — futtasd: --apply");
  process.exit(findingsBefore.length === 0 ? 0 : 1);
}

// ── 2. cserék ──────────────────────────────────────────────────────────────
let text = before;
let changed = 0;
for (const e of EDITS) {
  const n = text.split(e.find).length - 1;
  if (n === 1) {
    text = text.replace(e.find, e.replace);
    changed += 1;
    console.log(`  csere: ${e.name}`);
  } else if (n === 0) {
    console.log(`  kihagyva (már kész vagy más szöveg): ${e.name}`);
  } else {
    console.error(`  HIBA: a(z) "${e.name}" mintája ${n}x szerepel — nem egyértelmű, leállok.`);
    process.exit(1);
  }
}
const prov = stripOllamaProvider(text);
if (prov.removed > 0) {
  text = prov.text;
  changed += 1;
  console.log(`  csere: ollama-local provider blokk kivétele (${prov.removed} sor)`);
} else {
  console.log("  kihagyva (már kész): ollama-local provider blokk");
}

if (changed === 0) {
  console.log("\nNincs mit tenni — a fájl már a kívánt állapotban van.");
  process.exit(findingsBefore.length === 0 ? 0 : 1);
}

// ── 3. validálás ÍRÁS ELŐTT (a DSH élő beállításfájlja: hibás YAML-t nem írunk ki) ──
let after;
try {
  after = YAML.parse(text);
} catch (e) {
  console.error(`\nHIBA: a módosított szöveg nem érvényes YAML — NEM írom ki: ${e?.message ?? e}`);
  process.exit(1);
}
const findingsAfter = findLocalOllama(after);
if (findingsAfter.length > 0) {
  console.error(`\nHIBA: a struktúrában még maradt helyi hivatkozás — NEM írom ki:`);
  for (const f of findingsAfter) console.error(`  - ${f}`);
  process.exit(1);
}
// Sanity: ne veszítsünk el mást, csak a kivett blokkot. Elvárt különbség:
//   -1 provider (ollama-local) és -9 modell (az ollama-local 8 modellje +
//   a subagent-worker alól kivett `local-only` bejegyzés).
const provBefore = Object.keys(parsed?.["llm-pi-ai"]?.providers ?? {}).length;
const provAfter = Object.keys(after?.["llm-pi-ai"]?.providers ?? {}).length;
const modelsBefore = Object.values(parsed?.["llm-pi-ai"]?.providers ?? {}).reduce((a, p) => a + (Array.isArray(p?.models) ? p.models.length : 0), 0);
const modelsAfter = Object.values(after?.["llm-pi-ai"]?.providers ?? {}).reduce((a, p) => a + (Array.isArray(p?.models) ? p.models.length : 0), 0);
if (provBefore - provAfter !== 1 || modelsBefore - modelsAfter !== 9) {
  console.error(`\nHIBA: váratlan különbség (provider ${provBefore}->${provAfter}, modell ${modelsBefore}->${modelsAfter}; várt: -1 provider, -9 modell). NEM írom ki.`);
  process.exit(1);
}
console.log(`\nElőnézet: provider ${provBefore} -> ${provAfter}, modell ${modelsBefore} -> ${modelsAfter}`);

if (DRY) {
  console.log("--dry-run: nem írtam semmit.");
  process.exit(0);
}

// ── 4. mentés + kiírás ────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${SETTINGS}.bak-${stamp}-ollama-off`;
copyFileSync(SETTINGS, backup);
writeFileSync(SETTINGS, text, "utf8");
console.log(`\nMentés: ${backup}`);
console.log(`Kiírva: ${SETTINGS}`);
console.log("A DSH a settings.yaml-t hot-reload-olja (újraindítás nem kell).");
process.exit(0);
