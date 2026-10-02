# Helyi robot (bot) — terv a Grok Bot kiváltására

**Dátum:** 2026-09-30
**Státusz:** TERV — döntések rögzítve, még semmi nem épült meg.
**Kapcsolódó:** [`CURSOR-CLI-ELEMZES.md`](CURSOR-CLI-ELEMZES.md), `providers/README.md`,
`providers/FELJEGYZES.md`, `docs/dsh-plugin-notes.md`

---

## 0. Rögzített döntések (2026-09-30)

| Kérdés | Döntés |
|---|---|
| Platform | **DSH-natív** — egy rendszer, a tálca/webhook/MCP/ütemező/naplók már megvannak |
| Kimenet | **Elsődlegesen DSH-integráció**, sok esetben (pl. Facebook-csoport összefoglaló) **az e-mail a fő kimenet**. Telefonos alkalmazás egyelőre **nem** cél. |
| Facebook | **Csak a saját csoportjaim**, bejelentkezett profillal, alacsony frekvencián, kizárólag összegzés — posztolás/kommentelés nélkül |
| Első jobok | **1) a Felnőttképzési Adatszolgáltatási Rendszer (FAR) GrokBot-megoldásának teljes átvétele**, **2) konkurencia-figyelő** |

Az átvétel kiindulópontja: **a GrokBotból kimentett adatok** (lásd 7. szakasz).

---

## 1. Mit váltunk ki pontosan

A Cursor Pro **Grok Bot** jogosultságot tartalmaz (2026-08-26 óta). A Grok Bot
xAI „standing agent" terméke: **saját felhőgépen futó ágensek, amelyek
bejelentkeznek a felhasználó eszközeibe és weboldalaiba — API nélkül is —,
folyamatosan dolgoznak, és jóváhagyást kérve jelentenek vissza.**

| Grok Bot funkció | Helyi megfelelő |
|---|---|
| Saját felhő-PC | **A saját gép** (DSH host + tálca, már fut) — előny: az adat nem hagyja el a gépet |
| Bejelentkezés az eszközökbe/weboldalakba API nélkül | **Playwright perzisztens böngészőprofil** (bejelentkezve marad), MCP-n át a DSH tooljai között |
| Folyamatos munka | **Ütemezett jobok** (Windows Task Scheduler + DSH headless futás) |
| Visszajelzés, jóváhagyás kérése | **Jóváhagyás-tár** + **e-mail** (elsődleges), később Telegram/desktop |
| Felügyelet, korlátok | DSH approval, tool-allowlist, domain-allowlist, költségkeret, kill switch |

**Amit nem váltunk ki:** a felhő-PC előnye (akkor is fut, ha a gép ki van
kapcsolva). Ez tudatos csere: adatvédelem és $0 előfizetés a folyamatos
rendelkezésre állás helyett.

---

## 2. Alapelv: három réteg, és a legtöbb lépésben nulla token

| Réteg | Mi végzi | Mikor | Költség |
|---|---|---|---|
| **1. Determinisztikus** | Playwright/Node/PowerShell, HTTP API, SQLite, fájlművelet, `schtasks` | a munka **80–90%-a**: letöltés, parse, diff, validálás, fájlgenerálás, küldés | **$0** |
| **2. Ingyenes modell** | Groq / NVIDIA / OpenRouter `:free` / Google free tier (már bekötve), helyi Ollama | amihez **nyelvi** értelem kell: összegzés, címkézés, e-mail megfogalmazása | **$0** (rate limit) |
| **3. Fizetős modell** | DeepSeek **off-peak** (elsődleges), DeepSeek csúcs (ritka), Cursor CLI (amíg van) | nehéz döntés, kód, bizonytalan helyzet | mért, kerettel |

**Adatosztályozás (kemény szabály):**

| Adat | Réteg |
|---|---|
| Személyes adat (FAR-adatszolgáltatás, résztvevői adatok) | **csak 1. réteg**, vagy helyi Ollama. **Ingyenes felhő BE TILOS** (a free tier tanításra használja a tartalmat) |
| Nyilvános weboldal-tartalom, konkurencia-adat | 1–2. réteg |
| Belső üzleti döntés, kód | 1–3. réteg |

---

## 3. Architektúra

```
  TRIGGER                RUNNER                      TOOLOK                KIMENET
┌──────────────┐   ┌────────────────────┐   ┌────────────────────┐   ┌──────────────┐
│ Task Sched.  │──▶│ bot/run-job.ps1    │──▶│ Playwright (Node)  │──▶│ riport (.md) │
│ DSH webhook  │──▶│  - job def (JSON)  │   │ Playwright MCP     │   │ E-MAIL (fő)  │
│ GUI panel    │──▶│  - preset + modell │   │ HTTP/API, pwsh     │   │ DSH panel    │
│ e-mail (IMAP)│──▶│  - elé- szkript    │   │ SQLite (dedup)     │   │ Telegram     │
└──────────────┘   │  - utó- validálás  │   │ DSH subagent (ingy)│   │  (később)    │
                   └────────────────────┘   └────────────────────┘   └──────────────┘
                              │
                       ┌──────┴───────┐
                       │  ŐRÖK        │  approval · allowlist · költségkeret · kill switch · audit
                       └──────────────┘
```

**Ami már megvan és újrahasznosítjuk:**

| Meglévő elem | Szerep a botban |
|---|---|
| `dsh` host + `tray/dsh-tray.ps1` | folyamatosan futó szerver, felügyelettel |
| `providers/run-headless-task.ps1` | a **futás** mintája (dedikált csatorna, `-ReportDirectory`, `-Patch`) |
| `providers/session-channel.mjs` | a bot session-jei külön munkaterületen |
| `@deepseek-ai/dsh-webhook` | bejövő webhook → **workspace-backed session** (a weboldal utasítása) |
| `@deepseek-ai/dsh-mcp-client` | Playwright MCP és más MCP-szerverek tooljai |
| `@deepseek-ai/dsh-schedule`, `dsh-jobs` | emlékeztetők, háttér-jobok |
| `plugins/dsh-ui-extras` | a **panel** és a host route-ok mintája (`/ui-extras/...`) |
| `providers/proxy.mjs` | ingyenes modell-lánc a bot összegző lépéseihez |
| `dsh-user-approval` + ui-extras approval store | jóváhagyás-vezérlés |

**Hiányzik, meg kell építeni:** job-definíciós réteg, egységes runner, Playwright
telepítés, **e-mail kimenet/bemenet** (a DSH-nak nincs mail-pluginja), panel, és egy
generikus HTTP webhook adapter (gyárilag csak GitHub-adapter van).

**Titkok:** a bot saját titkai (SMTP/IMAP jelszó, FAR-belépés) **nem** a repóban
tárolódnak, hanem Windows Credential Managerben vagy DPAPI-val védett fájlban
(`.bot/secrets.clixml`, a `.gitignore`-ban). A DSH `.credentials.yaml`-ja marad a
modellek kulcsainak helye.

---

## 4. A job-definíció (ez teszi „bot"-tá)

`bot/jobs/<id>.json` — egy fájl = egy ismételhető feladat:

```jsonc
{
  "id": "konkurencia-figyelo",
  "leiras": "Konkurens oldalak tartalom- és árfigyelése, heti riport",
  "schedule": { "tipus": "cron", "kifejezes": "0 7 * * 1" },   // hétfő 07:00 helyi
  "csatorna": ".bot",                       // DSH munkaterület a futásnak
  "preset": "standard-free",                // a gyermekek ingyenes láncon
  "modell": { "provider": "subagent-worker", "model": "worker", "effort": "low" },
  "eloSzkript": "bot/collect/konkurencia.mjs",   // 1. réteg: gyűjtés + diff
  "prompt": "bot/prompts/konkurencia.md",        // 2. réteg: csak összegzés
  "toolAllowlist": ["read", "write", "web_fetch"],
  "domainAllowlist": ["pelda.hu", "konkurencia.hu"],
  "koltsegKeretUsd": 0.05,
  "jovahagyasKell": false,
  "dedupStore": "bot/state/konkurencia.db",
  "kimenet": ["riport", "email"],
  "megorzesNap": 90
}
```

A runner (`bot/run-job.ps1`): job betöltés → **elő-szkript** (token nélkül) → ha van
érdemi változás, **egy** modellhívás a megadott sávon → séma-validálás → riport +
e-mail → napló. Ha az elő-szkript azt mondja „nincs változás", a modell **el sem
indul** (ez a legfontosabb költség-őr).

---

## 5. Az első jobok

| # | Job | Réteg | Megjegyzés |
|---|---|---|---|
| 1 | **`far-adatszolgaltatas`** | **csak 1** (+ helyi modell) | A GrokBot-megoldás teljes átvétele — lásd a 7. szakaszt. Ez az első, mert üzemi kötelezettség és személyes adat. |
| 2 | **`konkurencia-figyelo`** | 1 + 2 | Nyilvános oldalak, sitemap, RSS, árak. Jogilag tiszta, jó első bizonyíték. |
| 3 | `weboldal-ebreszto` | 1 (+2) | Saját oldal és adatszolgáltatási végpont figyelése; e-mail hiba esetén. |
| 4 | `heti-riport` | 1 + 2 | A bot naplóiból heti összefoglaló, ingyenes modellel, e-mailben. |
| 5 | `fb-csoport-figyelo` | 1 + 2 | **Csak saját csoportok**, alacsony frekvencia, saját bejelentkezett profil, kizárólag összegzés e-mailben. A Meta ToS a scrape-et tiltja → tudatos kockázatvállalás. |

---

## 6. A panel (külön fül a DSH-ban)

A `dsh-ui-extras` mintájára (`docs/dsh-plugin-notes.md` 3. pont: jobb oldali fül
`sidebar.right.pane.tab`, host route-ok):

- **Jobok:** következő futás, utolsó eredmény, állapot (OK / HIBA / VÁR).
- **Jóváhagyásra vár:** egy helyen, egy kattintással (e-mailben is kérhető).
- **Napló:** az utolsó N futás riportja.
- **Költség:** a bot napi tokenköltsége (a `check-usage.mjs` már tudja a bontást).
- **Kill switch:** minden ütemezett job azonnali leállítása.

Host route-ok: `/bot/jobs`, `/bot/run?job=…`, `/bot/log`, `/bot/approvals`, `/bot/state`.

---

## 7. A FAR-adatszolgáltatás átvétele a GrokBotból

**Cél:** a Cursor lemondása után a Felnőttképzési Adatszolgáltatási Rendszer
(FAR, eKRÉTA) felé menő adatszolgáltatás **ugyanúgy vagy jobban** működjön, helyi
gépen, a GrokBot kiváltásával.

### 7.1 Az átvétel öt lépése

| Lépés | Mit jelent | Kilépési kritérium |
|---|---|---|
| **1. Leltár (discovery)** | A jelenlegi GrokBot-megoldás lépésről lépésre: milyen URL-ek, milyen adatforrás, mit kattint, mit tölt fel, hol kér jóváhagyást, mi a hibaág | egy dokumentált folyamatábra, amit **te is** helyesnek ismersz el |
| **2. Adat- és tudáskivonás** | Amit a GrokBotból át lehet hozni: a folyamat dokumentációja, a jóváhagyott adatsorok, sablonok, korábbi beküldések listája. **Jelszót/KAÜ-t nem exportálunk** — az helyben, a bot saját titoktárába kerül | a kimentett állományok a `bot/far/import/` alatt, a bot titoktára beállítva |
| **3. Újraépítés** | Determinisztikus lépések (adatösszeállítás, formátum, validálás) + egyetlen böngésző- vagy API-lépés | **száraz futás** (dry-run) előállítja a beküldendő állományt, de nem küld semmit |
| **4. Párhuzamos futás** | A bot és a GrokBot ugyanazt az adatot állítja elő; az összehasonlítás tételes | N egymást követő hét egyezés (vagy a GrokBot kiváltása egy adott lépéskörre) |
| **5. Kiváltás** | A GrokBot-lépés törlése; a bot marad, naplóval és riasztással | a Cursor lemondása után is zöld a havi adatszolgáltatás |

### 7.2 Két technikai út — ezt kell eldönteni az 1. lépésben

| Út | Mikor járható | Előny | Hátrány |
|---|---|---|---|
| **A) Gépi interfész (fKRÉTA/FAR API)** | Ha az intézménynek van **API-kulcsa/domainje** az eKRÉTA/fKRÉTA rendszerben. Az fKRÉTA kézikönyvben külön fejezet foglalkozik a *„Domain beállítás és API kulcs generálása"* témával, tehát létezik intézményi integrációs felület | Teljesen determinisztikus, **nulla token**, gyors, auditálható, nem törik UI-változástól | Ellenőrizni kell, hogy az **adatszolgáltatás** munkafolyamatra is kiterjed-e, nem csak a dokumentumsablonokra |
| **B) Böngésző-RPA (Playwright)** | Ha nincs API, vagy a FAR csak webes felületen fogad | Ugyanazt tudja, amit a GrokBot (bejelentkezés, űrlap, feltöltés); a FAR támogatja az **Excel-importot**, ami jelentősen leegyszerűsíti | Törik a UI-változásoktól; a bejelentkezést (KAÜ/ügyfélkapu) kézzel kell frissíteni; lassabb |

**Ajánlás:** először az **A) utat** kell ellenőrizni (egyetlen kérdés az
intézményi adminisztrátorhoz: van-e API-kulcs/domain és mire terjed ki), és a
**B) utat** párhuzamosan előkészíteni. A FAR **Excel-importja** mindkét útban
közös: a bot determinisztikusan **az előírt formátumú állományt** állítja elő, és
vagy API-val adja be, vagy a felületen tölti fel.

### 7.3 Kemény szabályok a FAR-jobban

1. **Személyes adat nem megy felhőbe.** A résztvevői adatok feldolgozása kizárólag
   determinisztikus kóddal vagy **helyi Ollamával** történik. Az ingyenes felhős
   sávok (Groq/NVIDIA/OpenRouter `:free`, Google free tier) **tiltottak** erre a jobra.
2. **Száraz futás kötelező.** Minden beküldés előtt: `--dry-run`, ami megmutatja a
   payloadot/diffet, de nem küld.
3. **Jóváhagyás küldés előtt.** A beküldést ember hagyja jóvá (DSH panelon vagy
   e-mail-válasszal) — a GrokBot „messages back for approval" mintájának megfelelője.
4. **Idempotencia.** Beküldési napló (SQLite) hash-sel: ugyanaz az adatsor kétszer
   nem megy ki; ismételt futás csak a különbözetet küldi.
5. **Teljes audit.** Ki, mikor, mit, melyik forrásadatból, milyen eredménnyel.
6. **Mentés és visszaállás.** Minden beküldött állomány és a hozzá tartozó válasz
   megőrzése (jogi megfelelés és vita esetére).
7. **Nincs képernyőn hagyott titok.** A bejelentkezés Playwright perzisztens
   profilban él; a profil könyvtára a munkaterületen kívül, a `.gitignore`-ban.

---

## 8. Alternatívák (miért a DSH-natív út)

| Opció | Előny | Hátrány |
|---|---|---|
| **DSH-natív (választott)** | Egy rendszer, ami már fut; tálca, webhook, MCP, ütemező, subagent-lánc, naplók **mind megvannak**; adat helyben | Nekünk kell megépíteni a job-réteget, a panelt és az e-mail csatornát |
| OpenClaw | Kész csatornák, cron, böngésző-vezérlés, memória | Második ágens-rendszer ugyanarra a gépre; nagy felület |
| SuperGrok ($30/hó) | A Grok Bot közvetlen cseréje, nulla fejlesztés | Drágább, mint a mostani Cursor; új előfizetést tart életben |

---

## 9. Fázisterv

| Fázis | Mit ad | Kész akkor, ha |
|---|---|---|
| **0. Alapok** | `bot/` munkaterület, job-formátum, napló, titoktár, Playwright a munkaterületen belül (lokális npm cache — a globális telepítés a sandboxban EPERM), e-mail küldés (SMTP) | egy „hello job" lefut, riportot ír és **e-mailt küld** |
| **1. FAR-leltár** | a 7.1/1. lépés: a GrokBot-folyamat dokumentálása, az A/B út eldöntése | a folyamatábra kész, az API-kérdés megválaszolva |
| **2. FAR száraz futás** | adatösszeállítás + validálás + dry-run, beküldés nélkül; a GrokBotból kimentett adatokkal | a generált állomány tételesen egyezik a GrokBotéval |
| **3. FAR élesítés** | beküldés (API vagy RPA) + jóváhagyás + idempotencia + audit | egy teljes időszak zöld, emberi beavatkozás nélkül |
| **4. Runner + ütemező** | `bot/run-job.ps1` + Task Scheduler (a regisztrációt **neked** kell futtatni normál PowerShell-ből) + `konkurencia-figyelo` | két egymást követő nap magától lefut |
| **5. Panel** | jobb oldali fül: jobok, jóváhagyás, napló, költség, kill switch | a panel adatai egyeznek a naplókkal |
| **6. E-mail bemenet (IMAP)** | a bot e-mail-válaszból is elfogad jóváhagyást/utasítást | egy válaszlevéllel jóváhagyható egy beküldés |
| **7. FB-figyelő** | saját csoportok összegzése e-mailben | 1 hét blokk nélkül |
| **8. Keményítés** | domain-allowlist, költségkeret, bot-loop védelem, backup, dokumentáció | szimulált hibafutás nem visz ki adatot és nem robbant költséget |

---

## 10. Kockázatok és kemény korlátok

1. **GDPR / adatkezelés** — a FAR személyes adatot érint: soha nem megy ingyenes
   felhőbe (a free tier tanításra használja), csak determinisztikus kód vagy helyi
   Ollama, teljes audit-naplóval.
2. **Üzemi folytonosság** — az átvétel alatt a GrokBot **nem** kapcsolható ki
   azonnal; párhuzamos futás kell a kiváltásig (7.1/4).
3. **Meta ToS** — a Facebook-csoport scrape tiltott; csak saját csoport, alacsony
   frekvencia, nincs posztolás, emberi jóváhagyás.
4. **Sandbox-korlátok (mérve)** — a `~/.dsh`-ba írás és tartós folyamat indítása a
   DSH sandboxából **nem megy**; az ütemezett feladatot és a watchdogot **neked**
   kell regisztrálnod normál PowerShell-ablakból.
5. **npm EPERM** — minden Node-függőség a munkaterületen belülre, lokális cache-sel.
6. **Ollama jelenleg nem fut** — a helyi/privát sávhoz indítani kell.
7. **Költségrobbanás** — a kockázat nem a bot, hanem a beállítás; ezért kötelező a
   job-szintű keret és a „nincs változás → nincs modellhívás" szabály.
8. **Bot-loop** — a bot soha nem válaszol a saját üzenetére; a bemeneti csatornán a
   saját címét/azonosítóját ki kell zárni.

---

## 11. Amit tőled kell tudnom a 0. fázis előtt

1. **A GrokBot FAR-megoldása ma pontosan mit csinál?** Melyik URL-en, milyen
   belépéssel (KAÜ/ügyfélkapu?), mit tölt fel (űrlap vagy Excel?), milyen
   gyakorisággal, és hol kér tőled jóváhagyást?
2. **Mi exportálható a GrokBotból?** Vannak-e kész adatsorok, sablonok, korábbi
   beküldések, vagy csak a beszélgetések/folyamat leírása?
3. **Van-e az intézménynek API-kulcsa/domainje az eKRÉTA/fKRÉTA rendszerben?**
   (Ha igen, az A) út járható, és a bot teljesen determinisztikus lehet.)
4. **Van-e teszt/gyakorló felület**, vagy minden próba éles beküldést jelent?
   (Ez dönti el, hogy a 2. fázis száraz futása mennyire kockázatmentes.)
5. **Az e-mail kimenet** melyik fiókból menjen, és kik kapják a riportokat?
6. **A konkurencia-figyelo** mely oldalakat figyelje (2–5 domain a kezdéshez)?
