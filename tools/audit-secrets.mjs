/**
 * Titok- és személyesadat-audit a nyilvános kiadás előtt.
 *
 * MIÉRT KELL: egy nyilvános repóba került kulcs vagy személyes adat visszavonása
 * csak a kulcs cseréjével lehetséges — a git-előzményből nem tűnik el. Ezért ez
 * a szkript a KIADÁS ELŐTT fut, és nem csak a fában, hanem a **git-előzményben**
 * is keres: egy később törölt fájl a történelemben továbbra is látható.
 *
 * MIT VIZSGÁL:
 *   1. ismert kulcsformák (OpenAI/DeepSeek `sk-…`, GitHub `ghp_…`/`github_pat_…`,
 *      AWS `AKIA…`, Slack `xox…`, JWT, privát kulcs fejléc),
 *   2. `kulcs = "érték"` párok (apiKey, password, secret, token, …),
 *   3. e-mail címek és magyar személyes adat minták (adószám, TAJ, telefonszám),
 *   4. a fejlesztői környezetre utaló abszolút útvonalak (`C:\Users\<név>`),
 *   5. a `.gitignore`-ban lévő, de a fenti mintákra illeszkedő fájlok figyelmeztetése.
 *
 * Kilépési kód: 0 = tiszta, 1 = találat (a kiadást meg kell állítani).
 *
 * Futtatás:
 *   node tools/audit-secrets.mjs            # a jelenlegi fa + a git-előzmény
 *   node tools/audit-secrets.mjs --no-history
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const NO_HISTORY = process.argv.includes("--no-history");

/** A vizsgált minták. A `leiras` a jelentésben jelenik meg. */
const PATTERNS = [
  { id: "openai/deepseek kulcs", re: /\bsk-[A-Za-z0-9_-]{16,}/u },
  { id: "github token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/u },
  { id: "github fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/u },
  { id: "aws access key", re: /\bAKIA[0-9A-Z]{16}\b/u },
  { id: "slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/u },
  { id: "privát kulcs fejléc", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { id: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
  { id: "kulcs-érték pár", re: /\b(api[_-]?key|apikey|password|passwd|jelszo|jelszó|secret|client[_-]?secret|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/iu },
  { id: "beágyazott hitelesítés URL-ben", re: /https?:\/\/[^/\s:@]+:[^/\s:@]+@/u },
  { id: "magyar adószám", re: /\b\d{8}-\d-\d{2}\b/u },
  // A TAJ 9 jegy, gyakran 3-3-3 bontásban. A "1 081 724 032" alakú
  // token-számok ne illeszkedjenek: ezért a minta előtt nem állhat szám
  // (szóközzel sem).
  { id: "TAJ-szám", re: /(?<!\d)(?<!\d )\d{3}[ -]?\d{3}[ -]?\d{3}(?![ -]?\d)/u },
  { id: "abszolút felhasználói útvonal", re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/u },
];

/** Ezekben a fájlokban a minta magyarázat nélkül is rendben van. */
const ALLOW = [
  // A minta-definíciók maguk (ez a fájl), a teszt-fixture-ök és a dokumentáció
  // példái. Új kivételt INDOKLÁSSAL vegyél fel.
  { path: /^tools\/audit-secrets\.mjs$/u, ids: ["*"] },
  { path: /^\.gitignore$/u, ids: ["*"] },
];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // A git hibái (pl. "path exists on disk, but not in HEAD") ne szemeteljék
    // tele a jelentést: a hívó a kivételből úgyis tudja, mi történt.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

const findings = [];
function add(where, line, patternId, text) {
  findings.push({ where, line, id: patternId, text: String(text).slice(0, 200) });
}

function allowed(path, id) {
  return ALLOW.some((rule) => rule.path.test(path) && (rule.ids.includes("*") || rule.ids.includes(id)));
}

/* --- 1) a jelenlegi fa (csak a követett fájlok) ---------------------------- */
// A MUNKAPÉLDÁNYT vizsgáljuk, nem a HEAD-et: a kiadás előtt az számít, ami
// commitolásra kerül, és egy javítás csak akkor tűnik el a jelentésből, ha a
// fájl tényleg tiszta (a HEAD-ből olvasva a javítás láthatatlan maradna).
const files = git(["ls-files"]).split(/\r?\n/u).filter(Boolean);
for (const file of files) {
  if (!existsSync(file)) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\u0000")) continue; // bináris
  const lines = content.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    for (const { id, re } of PATTERNS) {
      if (allowed(file, id)) continue;
      const match = lines[i].match(re);
      if (match) add(`${file}:${i + 1}`, i + 1, id, match[0]);
    }
  }
}

/* --- 2) a git-előzmény: később törölt tartalom is látható ------------------ */
if (!NO_HISTORY) {
  // MINDEN blob, ami valaha a repóban volt — nem csak az egyes fájlok legrégebbi
  // változata. (Korábbi hiba: a `seen` fájlnév szerint szűrt, ezért egy KÉSŐBB
  // commitban bekerült titok rejtve maradt. A `rev-list --objects` minden elért
  // blobot felsorol, a tartalom szerinti duplikátumot pedig a blob-hash fogja.)
  const seenBlobs = new Set();
  let objects;
  try {
    objects = git(["rev-list", "--objects", "--all"]).split(/\r?\n/u).filter(Boolean);
  } catch {
    objects = [];
  }

  for (const line of objects) {
    const space = line.indexOf(" ");
    if (space < 0) continue; // commit objektum (nincs útvonal)
    const sha = line.slice(0, space);
    const name = line.slice(space + 1);
    if (seenBlobs.has(sha)) continue;
    seenBlobs.add(sha);
    if (!/\.(js|mjs|cjs|ts|json|ya?ml|ps1|cmd|md|cs|txt|example)$/iu.test(name)) continue;
    let blob;
    try {
      blob = git(["cat-file", "-p", sha]);
    } catch {
      continue;
    }
    if (blob.includes("\u0000")) continue;
    const lines = blob.split(/\r?\n/u);
    for (let i = 0; i < lines.length; i++) {
      for (const { id, re } of PATTERNS) {
        if (allowed(name, id)) continue;
        const match = lines[i].match(re);
        if (match) add(`előzmény ${sha.slice(0, 8)} ${name}:${i + 1}`, i + 1, id, match[0]);
      }
    }
  }
}

/* --- jelentés -------------------------------------------------------------- */
const unique = new Map();
for (const f of findings) {
  const key = `${f.where}|${f.id}|${f.text}`;
  if (!unique.has(key)) unique.set(key, f);
}

const current = [...unique.values()].filter((f) => !f.where.startsWith("előzmény "));
const history = [...unique.values()].filter((f) => f.where.startsWith("előzmény "));

console.log(`Vizsgált követett fájl: ${files.length}`);
console.log(`Minta: ${PATTERNS.length}; előzmény vizsgálva: ${NO_HISTORY ? "nem" : "igen"}`);
console.log(`Találat a MOSTANI fában: ${current.length}; a git-ELŐZMÉNYBEN: ${history.length}`);
console.log("");

if (current.length === 0 && history.length === 0) {
  console.log("TISZTA: nincs találat. A repó nyilvánossá tehető.");
  process.exit(0);
}

// A mostani fa a kiadás blokkolója: egy benne maradt kulcs azonnal kikerül.
// Az előzmény más kérdés: onnan a titkot csak történelem-átírással lehet
// eltüntetni, ezért külön listázzuk, és a döntés a kiadóé.
if (current.length > 0) {
  console.log("BLOKKOLO: a mostani fában van találat — kiadás előtt rendbe kell tenni.");
  for (const f of current) {
    console.log(`  [${f.id}] ${f.where}`);
    console.log(`      ${f.text}`);
  }
  console.log("");
}

if (history.length > 0) {
  console.log("FIGYELMEZTETES: a git-előzményben van találat (a mostani fában már nincs).");
  console.log("  Ez akkor számít, ha a repó nyilvános lesz: a régi commitok láthatók maradnak.");
  console.log("  Titok (kulcs, jelszó, token) esetén a titkot KELL cserélni, és érdemes");
  console.log("  történelem-átírással (git filter-repo) is eltüntetni; puszta útvonal/név");
  console.log("  esetén a döntés a kiadóé.");
  for (const f of history) {
    console.log(`  [${f.id}] ${f.where}`);
    console.log(`      ${f.text}`);
  }
  console.log("");
}

process.exit(current.length > 0 ? 1 : 0);
