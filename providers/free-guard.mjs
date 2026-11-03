// FREE-GUARD: a delegálási láncokban NEM lehet fizetős cél, a lánc tagjai élnek-e,
// és az Alibaba-számlán megjelent-e bármi (a "szingapúri ingyenes keret" nem véd).
//
// Kilépés: 0 = minden rendben, 1 = szabálysértés / halott tag / Alibaba-költés.
//
// Használat:
//   node providers/free-guard.mjs              # szabály + élő mérés + BSS-ellenőrzés
//   node providers/free-guard.mjs --apply      # a megbukott tagokat a lánc VÉGÉRE sorolja (config.json)
//   node providers/free-guard.mjs --no-probe   # csak szabály + BSS (gyors)
//
// Bekötve: providers/run-retune.ps1 (a napi/heti felülbírálat része).
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const NO_PROBE = process.argv.includes("--no-probe");
const APPLY = process.argv.includes("--apply");

/** Ingyenesnek elfogadott providerek. google = AI Studio ingyenes szint (számlázás nélkül). */
const FREE_PROVIDERS = new Set(["openrouter", "groq", "ollama", "nvidia", "google"]);
/** Ezeken a route-okon fizetős cél NEM lehet: ezek a delegálás útjai. */
const FREE_ROUTES = ["worker", "free-quota", "vision-worker", "local-only", "deepseek-chat", "fast-chat"];

const pricing = CONFIG.pricing ?? {};
const providerOf = (label) => String(label).split("/")[0];
const isFree = (label) => {
  const p = providerOf(label);
  if (!FREE_PROVIDERS.has(p)) return false;
  if (p === "openrouter") return label.endsWith(":free");
  return true;
};
const routeTargets = (name) => {
  const r = CONFIG.routes?.[name];
  return Array.isArray(r) ? r : (r?.targets ?? []);
};

/**
 * Kiszolgálta-e a jelölt az ELMÚLT 24 órában valódi forgalmat?
 * 2026-11-03: MÉRT HIBA — a lightning:free-t a 12K-s próba "halottnak" látta,
 * miközben a proxy naplója szerint 79 valódi kérést szolgált ki. Demotálás
 * előtt ezért a valós forgalom a döntő, nem a szintetikus próba.
 */
function servedRecently(label, hours = 24) {
  const logPath = join(HERE, "proxy.out.log");
  if (!existsSync(logPath)) return false;
  let text;
  try { text = readFileSync(logPath, "utf8"); } catch { return false; }
  const since = Date.now() - hours * 3600 * 1000;
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(" HIT ");
    if (i === -1) continue;
    if (line.slice(i + 5).trim() !== label) continue;
    const m = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    if (m && Date.parse(m[1]) >= since) return true;
  }
  return false;
}

let bad = 0;
let ruleViolations = 0;

// ── 1. SZABÁLY: fizetős cél a delegálási láncon? ───────────────────────────
console.log("=== 1. SZABALY: fizetos cel a delegalasi lancban? ===");
for (const name of FREE_ROUTES) {
  for (const t of routeTargets(name)) {
    if (!isFree(t)) {
      bad += 1;
      ruleViolations += 1;
      const meta = pricing[t];
      const price = meta ? `${meta.miss ?? "?"}/${meta.hit ?? "?"}/${meta.out ?? "?"} USD/M` : "nincs ar a tablaban";
      console.log(`  SZABALYSERTES  ${name}: ${t}  (${price})`);
    }
  }
}
if (bad === 0) console.log("  OK — nincs fizetos cel a delegalasi route-okban.");

// ── 2. MÉRÉS: a lánc tagjai valódi (12K token + tool) kéréssel ────────────
const failed = new Map(); // route -> [label]
if (!NO_PROBE) {
  console.log("\n=== 2. MERES: a lanc tagjai valodi (12K token + tool) keressel ===");
  const cred = (n) => {
    const m = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8").match(new RegExp(`^\\s+${n}:\\s*(\\S+)\\s*$`, "m"));
    return m ? m[1] : undefined;
  };
  const endpoints = {
    openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", key: () => cred("OPENROUTER_API_KEY") },
    groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: () => cred("GROQ_API_KEY") },
    google: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: () => cred("GOOGLE_API_KEY") },
    ollama: { url: "http://127.0.0.1:11434/v1/chat/completions", key: () => cred("OLLAMA_LOCAL_API_KEY") ?? "ollama" },
  };
  const tools = [{ type: "function", function: { name: "noop", description: "no-op", parameters: { type: "object", properties: {} } } }];
  const filler = "Kitolto szoveg a kontextus meresehez. ".repeat(700);
  const probe = async (label) => {
    const provider = providerOf(label);
    const ep = endpoints[provider];
    if (!ep) return { label, ok: false, why: "nincs vegpont" };
    const model = label.slice(provider.length + 1);
    // 2026-11-03: HELYI MODELL — NINCS BEMÉRŐ KÉRÉS.
    // A 12K tokenes próba a gemma4-12b-128k-t (13 GB VRAM) betöltötte minden
    // nap, az AGENTS.md 2. pontja ellenére. A helyi tagot a /api/show-val
    // ellenőrizzük: létezik-e, és tud-e tool-t. Ez nem tölt be modellt.
    if (provider === 'ollama') {
      try {
        const sr = await fetch('http://127.0.0.1:11434/api/show', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(15000),
        });
        if (!sr.ok) return { label, ok: false, why: `tag nem letezik (HTTP ${sr.status}) — nincs betoltes` };
        const sj = await sr.json();
        const caps = Array.isArray(sj.capabilities) ? sj.capabilities : null;
        const tools = caps ? caps.includes('tools') : null;
        return {
          label,
          ok: tools !== false,
          why: `tag letezik, tools kepesseg: ${tools === null ? '?' : tools ? 'igen' : 'NEM'} (nincs betoltes, VRAM-kimelo)`,
        };
      } catch (e) {
        return { label, ok: false, why: `ollama /api/show hiba: ${String(e?.message ?? e).slice(0, 60)}` };
      }
    }
    const t0 = Date.now();
    try {
      const r = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ep.key()}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: `${filler}\n\nHivd a noop toolt.` }], tools, tool_choice: "auto", max_tokens: 256 }),
        signal: AbortSignal.timeout(120000),
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch {}
      const msg = j?.choices?.[0]?.message;
      const tc = msg?.tool_calls?.length ?? 0;
      const content = String(msg?.content ?? "").trim();
      // 2026-11-03: MÉRÉSI ARTEFAKT-JAVÍTÁS. A "200, de 0 tool_call" NEM halott
      // cél (a lightning:free 79 valódi kérést szolgált ki, miközben ezért
      // naponta demotálták), és a 413 sem az (a Groq TPM 8000-je miatt a 12K
      // próba mindig 413 — a végpont ÉL). A tool-képességet reprezentatívan a
      // chain-doctor 400-tokenes próbája méri, ezért itt csak KIÍRJUK.
      // ÉLŐ, ha a válasz valódi completion (van choices), akár hívott toolt,
      // akár nem; vagy ha 413-mal utasította el a próba méretét.
      const answered = r.status === 200 && Boolean(j?.choices?.[0]);
      const tooLarge = r.status === 413;
      const ok = answered || tooLarge;
      let why;
      if (r.status === 200) {
        why = `HTTP 200, ${tc} tool_call${tc === 0 ? " (tool nelkul, de valaszol)" : ""}, ${Date.now() - t0} ms`;
      } else if (tooLarge) {
        why = `HTTP 413 (a cel EL, a probe nagy neki: TPM), ${Date.now() - t0} ms`;
      } else {
        why = `HTTP ${r.status}: ${txt.slice(0, 100).replace(/\s+/g, " ")}`;
      }
      return { label, ok, why };
    } catch (e) {
      return { label, ok: false, why: String(e?.message ?? e).slice(0, 90) };
    }
  };
  const seen = new Set();
  const probeRetry = async (label) => {
    const a = await probe(label);
    if (a.ok) return a;
    // 2026-11-03: 429-re NINCS újrapróba. A Google free tier 5 RPM — a retry
    // maga generál újabb 429-et, és a végén hamis "halott" lesz belőle.
    if (/HTTP 429/.test(a.why)) return a;
    // Egy átmeneti hiba (timeout/5xx) ne demotáljon egy egyébként jó célt: 1 újrapróba.
    await new Promise((r) => setTimeout(r, 3000));
    const b = await probe(label);
    return b.ok ? b : { ...b, why: `${a.why} | ujra: ${b.why}` };
  };
  for (const name of FREE_ROUTES) {
    for (const t of routeTargets(name)) {
      if (seen.has(t)) continue;
      seen.add(t);
      const r = await probeRetry(t);
      if (!r.ok) { bad += 1; if (!failed.has(name)) failed.set(name, []); failed.get(name).push(t); }
      console.log(`  ${r.ok ? "OK    " : "HALOTT"}  ${r.label.padEnd(48)} ${r.why}`);
    }
  }
}

// ── 3. JAVÍTÁS (--apply): csak 2 egymást követő napon bukott tag a lánc végére ──
// A mai mérés tanulsága: az ingyenes célok NAPON BELÜL is fluktuálnak (503/429/timeout),
// ezért egyetlen rossz mérés nem demotálhat egy jó célt.
if (APPLY) {
  const statePath = join(HERE, "reports", "free-guard-state.json");
  let state = { fail: {} };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const sameDay = state.at?.slice(0, 10) === today; // napi egyszer számolunk
  const failures = new Map();
  if (!NO_PROBE) {
    for (const name of FREE_ROUTES) for (const t of routeTargets(name)) {
      if (!failures.has(t)) failures.set(t, false);
    }
    for (const [label] of failures) {
      const bad = failed.size > 0 && [...failed.values()].some((l) => l.includes(label));
      if (bad) failures.set(label, true);
    }
  }
  const demote = [];
  for (const [label, bad] of failures) {
    const prev = Number(state.fail?.[label] ?? 0);
    const count = bad ? (sameDay ? Math.max(prev, 1) : prev + 1) : 0;
    state.fail = { ...(state.fail ?? {}), [label]: count };
    if (count >= 2) {
      // 24 órán belüli valódi forgalom = a cél él, függetlenül a szintetikus próbától.
      if (servedRecently(label)) {
        console.log(`  NEM DEMOTALOM: ${label} — 24 oran belul kiszolgalta a forgalmat (HIT a proxy naploban)`);
        state.fail = { ...(state.fail ?? {}), [label]: 0 };
        continue;
      }
      demote.push(label);
    }
  }
  state.at = new Date().toISOString();
  try { writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8"); } catch {}

  if (demote.length > 0) {
    console.log("\n=== 3. JAVITAS: 2 napja bukott tagok a lanc vegere ===");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${stamp}-free-guard`);
    let touched = 0;
    for (const name of FREE_ROUTES) {
      const list = routeTargets(name);
      const hit = list.filter((t) => demote.includes(t));
      if (hit.length === 0) continue;
      CONFIG.routes[name].targets = [...list.filter((t) => !demote.includes(t)), ...hit];
      console.log(`  ${name}: ${hit.join(", ")} -> a lanc vegere`);
      touched += 1;
    }
    if (touched > 0) {
      writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2) + "\n", "utf8");
      console.log("  config.json mentve (a proxy hot-reloadolja).");
      for (const t of demote) state.fail[t] = 0;
      try { writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8"); } catch {}
    }
  } else if (!NO_PROBE) {
    console.log("\n=== 3. JAVITAS: nincs 2 napja bukott tag (nincs demotalas) ===");
  }
}

// ── 4. ALIBABA-SZÁMLA: jött-e be bármi fizetős? ──────────────────────────
console.log("\n=== 4. ALIBABA-SZAMLA (a 'szingapuri ingyenes keret' valodi merceje) ===");
try {
  const { getAlibabaBilling } = await import("./bss-client.mjs");
  const cycle = new Date().toISOString().slice(0, 7);
  const b = await getAlibabaBilling(cycle);
  if (!b.ok) {
    console.log(`  a BSS nem valaszolt: ${b.error}`);
  } else {
    console.log(`  ciklus ${b.cycle}: netto ${b.totalUsd.toFixed(4)} USD, brutto(27%) ${(b.totalUsd * 1.27).toFixed(4)} USD`);
    console.log(`  workspace: ${b.byWorkspace.map((w) => `${w.workspace}=${w.usd.toFixed(4)}`).join("  ") || "nincs tetel"}`);
    console.log(`  modellek:  ${b.byModel.slice(0, 4).map((m) => `${m.model}=${m.usd.toFixed(4)}`).join("  ") || "nincs tetel"}`);
    const sg = b.byWorkspace.find((w) => /7pa8b93c9tnmgi1w/.test(w.workspace));
    if (b.totalUsd > 0.001) {
      console.log(`  FIGYELEM: a ciklusban MAR van Alibaba-koltes. A szingapuri ingyenes keret (1M token/modell) nem ved — a proxy becslese szerint a qwen3.7-flash SG-n mar 12,27M tokent hasznaltunk (quota-used.json).`);
      if (sg && sg.usd > 0.001) console.log(`  SG munkaterulet: ${sg.usd.toFixed(4)} USD -> a kvota NEM ervenyesult, ezert van kivéve a delegalasbol.`);
    } else {
      console.log("  OK — ebben a ciklusban nincs Alibaba-koltes.");
    }
  }
} catch (e) {
  console.log(`  BSS-hiba: ${String(e?.message ?? e).slice(0, 120)}`);
}

// ── 5. MAI Alibaba-költés: ez a döntő szám (a havi összeg a régi forgalmat is tartalmazza) ──
// 2026-10-26 12:05 UTC-ig az Alibaba még a delegálási láncokon volt, ezért a korábbi
// napokra a költés NORMÁLIS. Az éles riasztás 2026-10-27-től érvényes.
const REGRESSION_FROM = "2026-10-27";
const todayIso = new Date().toISOString().slice(0, 10);
let todayUsd = null;
try {
  const { bssCall } = await import("./bss-client.mjs");
  const cycle = new Date().toISOString().slice(0, 7);
  const today = todayIso;
  const d = await bssCall("DescribeInstanceBill", "2017-12-14", { BillingCycle: cycle, BillingDate: today, Granularity: "DAILY", MaxResults: "300" });
  const rows = d?.Data?.Items?.Item ?? d?.Data?.Items ?? [];
  todayUsd = (Array.isArray(rows) ? rows : []).reduce((a, r) => a + Number(r?.PretaxAmount ?? 0), 0);
  console.log(`\n=== 5. MAI ALIBABA-KOLTES (${today}) ===`);
  console.log(`  ${todayUsd.toFixed(4)} USD netto`);
  if (today < REGRESSION_FROM) {
    console.log(`  (a ${REGRESSION_FROM} elotti napokra a költés normális: az Alibaba akkor még a láncon volt. Az éles riasztás ${REGRESSION_FROM}-től.)`);
  } else if (todayUsd > 0.05) {
    console.log("  SULYOS: a delegalas nem mehet Alibabara — valaki visszatette a lancra, vagy az 'auto' route esett at ra.");
  } else {
    console.log("  OK — a mai napon nincs erdemi Alibaba-koltes.");
  }
} catch (e) {
  console.log(`  mai koltes nem lekerdezheto: ${String(e?.message ?? e).slice(0, 100)}`);
}

// Kilépési kód: csak a SÚLYOS eset (fizetős cél a láncon / mai Alibaba-költés) ad hibát.
// A napi fluktuáció (429/503/timeout) normális az ingyenes szinten, az nem hiba.
const severeNow = ruleViolations > 0 || (todayUsd !== null && todayUsd > 0.05 && todayIso >= REGRESSION_FROM);
console.log(
  bad === 0
    ? "\nVERDIKT: a delegalasi lancok ingyenesek (nincs fizetos cel)."
    : `\nVERDIKT: ${bad} tag bukott a mai meresen — demotalas csak 2 egymast koveto nap utan (reports/free-guard-state.json).`,
);
process.exitCode = severeNow ? 1 : 0;
