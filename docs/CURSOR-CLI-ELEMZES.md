# Cursor előfizetés a DeepSeek Harness-ben — elemzés és döntés

**Dátum:** 2026-09-30
**Státusz:** ELDÖNTVE, félretéve. Az út: **Cursor CLI, banmentes üzemmód**, a keret
elhasználása, az előfizetés lemondása 2026 októbere végén.
**Kapcsolódó:** [`BOT-TERV.md`](BOT-TERV.md) (a Grok Bot kiváltása), `providers/README.md`

---

## 1. A döntés és az indok egy bekezdésben

A banmentes felületek közül a **Cursor CLI** (`agent`) lett a választás, nem a
közösségi DSH-plugin (`dsh-llm-cursor`) és nem a `cursor2api` bridge. Az előfizetés
kerete tehát **nem** a DSH modellválasztóján keresztül, hanem a **hivatalos CLI-n**
keresztül hasznosul: a DSH tervez, ingyenes modellekkel felderít és ellenőriz, a
repo-szintű nehéz munkát pedig egy-egy jól megírt `agent -p` futás végzi.
A fő érvek: (a) a két nem-hivatalos út a Cursor staff szerint is **ToS-sértés,
akár végleges ban**; (b) a DSH cache-nehéz loopja mellett a Cursor-keret úgyis
néhány session alatt elfogyna, tehát a ban kockázatához képest kicsi a nyereség;
(c) a CLI ugyanazt a harness-t futtatja, csak **nem az IDE-ben**.

---

## 2. Amit elvetettünk, és miért

| Út | Miért nem |
|---|---|
| **`dsh-llm-cursor` plugin** (v0.2.23) | A szerző saját figyelmeztetése: „Cursor staff treat this class of private-client usage as against the Terms of Service. **Your Cursor account can be restricted or banned.**" A plugin privát `api2.cursor.sh` végpontokat hív (Deep Control PKCE + Connect/protobuf), nem hivatalos felület. |
| **`cursor2api`** (Docker, AGPL) | Ugyanaz a ToS-osztály + Docker/WSL2 + külön login-flow; a CLI-wrapper megközelítés „ceilingje" miatt született, de a ban kockázat és a karbantartási teher nő, nem csökken. |
| **Cursor a fő szálon / subagent alapértékként** | Pontosan az a minta, ami az IDE-ben elégette a keretet: sok, nagy kontextusú, tool-hívásos kör. A subagent fan-out és a compaction a legtoken-éhesebb rész. |

Hivatalos OpenAI-kompatibilis Cursor API **nincs**; a Cursor a saját harness-ét adja
(IDE, CLI, `@cursor/sdk`, Cloud Agents), és a nyilvános kérés rá a fórumon nyitott,
határidő nélkül.

---

## 3. Árak és a mért alapterhelés

Mért alapid (11 session, 3 143 hívás, 2026-09-27):

| Mérőszám | Érték |
|---|---|
| Friss input | 5 680 032 token |
| Output | 1 966 671 token |
| **Prompt-cache olvasás** | **1 081 724 032 token** |
| Költség akkori `deepseek-flash` áron | $4,37 |
| Ugyanez cache nélkül | $152,79 (a cache 97,1%-ot takarít meg) |

Ugyanez a mai DeepSeek árakkal:

| Forgatókönyv | Költség |
|---|---|
| DeepSeek Flash **csúcs** | **$10,55** |
| DeepSeek Flash **off-peak** | **$5,28** |
| DeepSeek V4-Pro csúcs | $62,88 |
| Egy session (~286 hívás), Flash csúcs | $0,96 |

Árak `/1M` token (a cache-hit a döntő oszlop):

| | DeepSeek Flash csúcs | DeepSeek Flash off-peak | Composer 2.5 | Grok 4.7 | Claude Opus 5.5 | Gemini 3.8 Flash (paid) |
|---|---|---|---|---|---|---|
| Input | $0,30 | $0,15 | $0,50 | $2,00 | $4,00 | $0,75 |
| **Cache-hit** | **$0,006** | **$0,003** | $0,20 | $0,50 | $0,20 | $0,075 |
| Output | $1,20 | $0,60 | $2,50 | $6,00 | $20,00 | $3,75 |

**Következmény:** a havi 1,08 Mrd cache-oltvas tokened Cursor-áron **$216–541** lenne.
A Cursor-keret nem olcsó tokenforrás a DSH loopjához; a szerepe **célzott, behatárolt
munka**, nem a napi agent-loop.

---

## 4. Cursor IDE vs DSH + Cursor CLI

Mindkettő **ugyanazt a Cursor-harness-t** futtatja, ugyanazokon a modelleken,
ugyanabban a két keretben (Cursor Models pool / Other Models pool) — a **token ára
azonos**. A különbség a **feladatonkénti tokenmennyiség** és a **veszteség**.

| Mechanizmus | Ki nyer | Miért |
|---|---|---|
| **Session-újrafelhasználás (cache)** | IDE, ill. DSH **egy** `--resume`-szal vezetett sessionnel | Minden új `agent -p` hívás **új Cursor-sessiont** kezd → a repo-kontextus újra fizetve. 5 külön hívás = 5× input. |
| **Hibás futás költsége** | **IDE** | Komplex feladatnál nagy a drift esélye; az IDE-ben a 3. lépésnél leállítod, a `-p` módban a **teljes futás** tokene elmegy. |
| **Kontextus alakja** | **DSH** | Te szabod meg a promptot; a mért cache-tanulság (97% megtakarítás) itt érvényesül. |
| **Ingyenes offload** | **DSH** | Recon, keresés, összegzés, verifikáció a $0-s láncon — a Cursor-keret csak a nehéz magra megy. |

| | Cursor IDE | DSH + Cursor CLI |
|---|---|---|
| Interaktív kormányzás | ✅ plan/approve, checkpoint, rollback, diff | ❌ egy lövés; utólag `git diff` |
| Kontextus a repóról | ✅ gazdagabb (index, retrieval, review) | ⚠️ könyvtár-alapú, kevesebb review-eszköz |
| Írás fájlba | ✅ jóváhagyással | ⚠️ `--force` kell, különben csak javasol |
| Párhuzamosítás | ⚠️ kézi | ✅ több `agent -p` egyszerre |
| Automatizálás, ismételhetőség | ❌ | ✅ JSON kimenet, ütemezhető, naplózott |
| Beépülés a DSH workflow-ba | ❌ | ✅ skill/preset/session-napló/subagent |

**Szabály:** ha a feladat közben derül ki → IDE. Ha előre megírható és utólag
ellenőrizhető (teszt, `git diff`, séma) → DSH + CLI.

**A cél-alak (a legkisebb keret-fogyás):**
ingyenes recon → pontos brief → **egy** `agent -p` futás → 1× `--resume` javítás →
ingyenes verifikáció. Kerüld az 5 külön hívást `--resume` nélkül.

---

## 5. A DSH + Cursor CLI üzemmód szabályai

1. **Egy feladat = egy session.** Javításra `--resume` / `--continue`, sose új session.
2. **Explicit `--model`** (`composer-2.5`, max. `grok-4.7`), hogy ne csússzon Auto-val
   a drága Other Models poolba.
3. **`--mode`**: kutatásra `ask`/`plan` (csak olvas), írásra `agent` + `--force`.
4. **Git-checkpoint `--force` előtt** (branch vagy commit) — a rollback a git.
5. **Hosszú futás háttér-jobként** a DSH-ból (a sandbox a parancs végén kilövi a
   folyamatfát — lásd `providers/FELJEGYZES.md` 6/d).
6. **On-demand spend limit 0** a Cursor dashboardon, hogy a keret kifogyása
   megálljon, ne számlázzon.
7. **Kordonok:** a Cursor nem lesz default modell, nem kerül a
   `subagent-model-selection` allowlistbe, a preset `agentOptions`-ába, sem a
   `providers/config.json` láncba.
8. **A DSH statisztikája nem látja a Cursor tokeneket** (azok a CLI-n belül mennek
   el) — a keret fogyását a Cursor dashboardon kell mérni.

---

## 6. Nyitott, üzembe helyezés előtt igazolandó pontok

1. A DSH sandbox engedi-e a CLI saját állapot-írásait (`~/.cursor`): első próba
   `agent -p "say OK" --output-format json`.
2. A hosszú futás túléli-e a `pwsh` tool végét (háttér-job vs. előtér).
3. A Cursor CLI verzió-pin és a HTTP/2 (ALPN) követelménye — frissítés után
   újra kell ellenőrizni.

---

## 7. Ami a lemondással megszűnik

- A Cursor Models pool (Grok 4.7 / Composer 2.5) és az Other Models keret.
- **Grok Bot hozzáférés** (Cursor Pro tartalmazza 2026-08-26 óta) — a kiváltás
  terve: [`BOT-TERV.md`](BOT-TERV.md).

---

## 8. Teendők a lemondás előtt

- [ ] A keret **tudatos** elhasználása: a fenti cél-alak szerinti feladatokra
      (nem szórásra), a dashboard heti figyelésével.
- [ ] On-demand spend limit **0** — ellenőrizve a számlázás előtt.
- [ ] Ami kell, exportálása a Cursor-ból (saját szabályok, skillek, promptok,
      `.cursor/rules`) a munkaterületre.
- [ ] A CLI eltávolítása vagy bent hagyása (a bejelentkezés a lemondással
      érvénytelenné válik); a `~/.cursor` tisztítása.
- [ ] A `dsh-llm-cursor` **nem** települ — nincs mit visszabontani.
