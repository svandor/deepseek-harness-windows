// DOCTOR — a 2026-10-15-i hibahármas automatikus ellenőrzése.
//
// Egy paranccsal megmondja, MIÉRT nem szolgál ki az auto modell / miért régi a
// felület. Csak HTTP-próbákat és fájlidőket használ (nincs child_process), így
// sandboxban is fut.
//
//   node providers/doctor.mjs
//
// Kilépési kód: 0 = minden rendben, 1 = talált problémát.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROXY = "http://127.0.0.1:4123";
const HARNESS = "http://127.0.0.1:3080";
const problems = [];
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m, fix) => { console.log(`  HIBA  ${m}${fix ? `\n        -> ${fix}` : ""}`); problems.push(m); };

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    return { status: res.status, text };
  } catch (error) {
    return { status: 0, text: String(error?.message ?? error) };
  }
}
const age = (ms) => `${Math.round((Date.now() - ms) / 60000)} perc`;
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : null);

console.log("=== PROXY (a subagent- és auto-route motorja) ===");
const health = await probe(`${PROXY}/healthz`);
if (health.status === 200) {
  try {
    const h = JSON.parse(health.text);
    ok(`healthz ok=${h.ok} usable=${h.usable} kulcsok: ${JSON.stringify(h.missingKeys ?? {})}`);
    if (h.usable === false) bad("a proxy nem használható (hiányzó kulcs)", "run-proxy-service.ps1 újraindítás");
    const cooling = Object.keys(h.cooldowns ?? {});
    if (cooling.length > 0) console.log(`  INFO  cooldownban: ${cooling.join(", ")}`);
  } catch { bad("a healthz válasza nem JSON"); }
} else {
  bad(`a proxy nem válaszol (${health.status || health.text})`, "providers\\run-proxy.cmd  (vagy a watchdog)");
}

console.log("\n=== HARNESS ÉS A FUTÓ PLUGIN-VERZIÓ ===");
const balance = await probe(`${HARNESS}/ui-extras/balance`);
const alibaba = await probe(`${HARNESS}/ui-extras/alibaba`);
balance.status === 200 ? ok("a plugin host-fél betöltve (/ui-extras/balance)")
  : bad(`a plugin nem válaszol (${balance.status})`, "a harness nem fut, vagy a plugin hibás");
if (alibaba.status === 200) {
  try {
    const b = JSON.parse(alibaba.text);
    ok(`Alibaba-számla lekérdezhető: ${b.cycle} = ${b.pretaxAmount} ${b.currency} (${b.lineItems} tétel)`);
  } catch { bad("az alibaba route nem JSON-t ad"); }
} else {
  bad(`az /ui-extras/alibaba NEM érhető el (${alibaba.status}) — a futó harness RÉGEBBI, mint a plugin`,
    "egy harness-újraindítás kell a plugin saját helperével (providers\\restart-harness.cmd)");
}
const pluginHost = mtime(join(ROOT, "plugins", "dsh-ui-extras", "lib", "index.js"));
const restartLog = join(ROOT, "state", "restart.log");
if (pluginHost) console.log(`  INFO  plugin index.js módosítva: ${age(pluginHost)}`);
restartLog && existsSync(restartLog)
  ? console.log(`  INFO  utolsó harness-restart napló: ${age(statSync(restartLog).mtimeMs)}`)
  : console.log("  INFO  state\\restart.log nincs -> a restart helper még nem futott (a felület-újratöltés nem indít szervert)");

console.log("\n=== PLUGIN-PÉLDÁNYOK (a staging lehet régebbi!) ===");
for (const rel of ["plugins/dsh-ui-extras/lib/index.js", "dist/stage/plugins/dsh-ui-extras/lib/index.js"]) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const hasRoute = readFileSync(p, "utf8").includes("ui-extras/alibaba");
  console.log(`  ${hasRoute ? "OK   " : "RÉGI "} ${rel} (${age(statSync(p).mtimeMs)}${hasRoute ? "" : ", nincs benne az alibaba route"})`);
  if (rel.startsWith("dist/") && !hasRoute) console.log("        (telepítési staging — ne ebből diagnosztizálj)");
}

console.log("\n=== WATCHDOG (proxy-őrfolyam) ===");
const wdLog = join(HERE, "reports", "proxy-watchdog.log");
if (existsSync(wdLog)) {
  const freshness = Date.now() - statSync(wdLog).mtimeMs;
  freshness < 10 * 60 * 1000 ? ok(`a watchdog aktív (utolsó bejegyzés: ${age(statSync(wdLog).mtimeMs)})`)
    : bad(`a watchdog nem ír (utolsó: ${age(statSync(wdLog).mtimeMs)})`, "providers\\start-watchdog.cmd indítása");
} else {
  bad("nincs watchdog-napló — a proxy halála észrevétlen marad", "providers\\start-watchdog.cmd indítása");
}

console.log("\n=== NYILVÁNOS REPO (fiókadat-szivárgás ellenőrzése) ===");
const files = [];
// A .gitignore biztonsági szempontból fontos sorai (a doctor nem hív git-et):
// ezek a helyek NEM részei a nyilvános repónak.
const IGNORED_DIRS = new Set([".git", "node_modules", "obj", "dist", "state", "reports", ".test-dsh-home", ".automation", ".vs"]);
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(e.name) || e.name.startsWith(".tmp-")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
};
walk(ROOT);
const leak = /ws-[a-z0-9]{12,}|LTAI[0-9A-Za-z]{10,}@?|RRhOZoM6/;
// A gitignore-olt biztonsági mentések nem részei a nyilvános repónak, ezért
// külön soroljuk fel őket (törölhetők), és csak a valódi fájlokat jelezzük.
const isBackup = (p) => /\.bak(-|$)|\.pre-strip$|\.old-/.test(p.split(/[\\/]/).pop());
const hasId = (f) => { try { return statSync(f).size < 2e6 && leak.test(readFileSync(f, "utf8")); } catch { return false; } };
const hits = files.filter(hasId);
const tracked = hits.filter((f) => !isBackup(f));
const backups = hits.filter(isBackup);
tracked.length === 0 ? ok("nincs fiókazonosító a követett fájlokban")
  : bad(`${tracked.length} követett fájl tartalmaz fiókazonosítót`, tracked.slice(0, 5).join(", "));
if (backups.length > 0) console.log(`  INFO  ${backups.length} gitignore-olt biztonsági mentés tartalmaz azonosítót (nem nyilvános; törölhető)`);

console.log(`\n=== ÖSSZEGZÉS: ${problems.length === 0 ? "minden rendben" : problems.length + " probléma"} ===`);
process.exitCode = problems.length === 0 ? 0 : 1;
