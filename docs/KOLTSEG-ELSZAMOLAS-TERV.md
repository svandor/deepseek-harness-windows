# Fejlesztési költségelszámolás — terv és javaslatok

[English](KOLTSEG-ELSZAMOLAS-TERV.en.md) | Magyar

Állapot: **MEGVALÓSÍTVA** (2026-11-16); a döntéseket a 9. szakasz rögzíti,
a használatot a [`KOLTSEG-ELSZAMOLAS.md`](KOLTSEG-ELSZAMOLAS.md)
Készült: 2026-11-16
Kapcsolódó: `docs\FTP-DEPLOY-TERV.md` (plugin-minta), `docs\dsh-plugin-notes.md`
(slot-szabályok), `AGENTS.md` §1 (nincs felugró ablak), §1.5 (restart-fegyelem)

---

## 1. Mit kér a felhasználó (a kérés pontosítása)

Új funkció a DSH-ban, helye a **menüsor ikon+tooltip gombjára nyíló lebegő
ablak**. A funkció a fejlesztések költségelszámolása:

| Követelmény | Értelmezés ebben a tervben |
|---|---|
| alap óradíj 12 500 Ft | `defaultRate: 12500` HUF/óra, profilban és repónként felülírható |
| repónként átírható a felületen | munkaterület-szintű felülírás, a felületről mentve |
| mérjen a konkrét kiválasztott munkafolyamatra | 1 session (beszélgetés), annak körei |
| mérjen az egész munkaterületre | a workspace összes session-je |
| dátum intervallummal is | `-tól`/`-ig`, magyar naptári nap szerint, a munkaterületen belül |
| a számítás alapja a tarifa + pontosan milyen időt mérünk | 4 mért időkomponens + súlyok profilban |
| több verzió + egyedileg súlyozott beállítás | 4 előre definiált profil + egyedi profil |
| szerver oldali munkaidő (a helyi Ollama is) | `turn/start` → `turn/end` a session-naplóból |
| háttérmunkák (relevancia csekély) | terminál-futások + jobok, súlya alapból 0–0,25 |
| olvasás + új prompt beírása (javaslat kell) | kliens-oldali aktivitás-mérés + napló-alapú tartalék |
| valós idő (nem számlázható bruttó) | aktív naptári idő, unióval, tétlenség-plafonnal |

---

## 2. Mit mértem (valós adat, ez a terv alapja)

Saját mérés a munkaterület 30 napján (`%TEMP%`-be írt eldobható szkripttel; a
session-naplók **több-frame-es zstd**-k, keretbejáró kell — ez a mérés is azt
használta, amit a plugin fog):

```
ablak: utolso 30 nap | session-ok (ezen a munkateruleten, root): 31
ossz brutto (session-elettartam):      484,44 h
ossz agent (turn/start -> turn/end):    26,78 h   = a brutto 6%-a
turn-ok: 351
emberi res (<=20 perc):                 20,21 h / 264 eset, median 3,0 min, p90 12,9 min
hosszu szunet (>20 perc):               99,14 h / 56 eset
```

**Következtetés, ami a tervet meghatározza:** a bruttó naptári idő
(484 h) a valós munkának nagyjából a tízszerese, mert a session-ök napokig
nyitva maradnak (mért példa: 8,89 h élettartam 0,67 h agent-munkával). A bruttó
idő tehát **önmagában semmire nem jó** — csak uniózva, tétlenség-plafonnal,
és a többi komponenssel együtt értelmezhető. Egy átlagos kör ~4,6 perc
agent-munka (26,78 h / 351 kör), az emberi szünet mediánja 3 perc.

Ugyanezen az ablakon a profilok (12 500 Ft/óra, kerekítés nélkül):

| Profil | Elszámolható | Összeg |
|---|---|---|
| agent + emberi (alap) | 47,00 h | ≈ 587 500 Ft |
| csak agent (gépidő) | 26,78 h | ≈ 334 800 Ft |
| csak emberi | 20,21 h | ≈ 252 700 Ft |
| agent × 0,5 + emberi | 33,60 h | ≈ 420 000 Ft |

Ez a négy sor pontosan megmutatja, miért kell profil: **ugyanarra a hónapra a
számla 253 ezer és 587 ezer Ft között mozog** attól függően, mit tekintünk
elszámolhatónak. Ezt nem szabad beégetni — ez a felhasználó üzleti döntése.

---

## 3. Mérési modell — négy komponens, egyértelmű definícióval

Minden komponenshez tartozik: **definíció, adatforrás, pontosság, kizárások.**
Az elszámolás ezekből számol, a súlyok profilban élnek.

### 3.1 `agent` — szerver oldali munkaidő

- **Definíció:** a kör (`turn`) kezdetétől a leállásáig tartó idő, azaz
  `turn/end.time − turn/start.time`. Ez a prompt feldolgozásától a kör
  lezárásáig tart, és magában foglalja az LLM-hívásokat, az eszközhívásokat
  (köztük a `pwsh`/terminál-futásokat) és a várakozást is. A helyi Ollama
  ugyanebbe a sávba esik, tehát külön kezelést nem igényel.
- **Adatforrás:** a tartós session-napló
  (`%USERPROFILE%\.dsh\sessions\<munkaterület>\<session-id>\session.v3.jsonl.zstd`).
  Minden esemény `{type, seq, time, data}` alakú, ahol `time` = Unix epoch ms.
  A kör-határok: `turn/start`, `turn/end` (`data.reason.kind`).
- **Pontosság:** ms-pontos, visszamenőleg is (a napló nem változik).
- **Kizárások:** a delegált (alügynök) session-ök külön naplófájlba mennek, de a
  **szülő köridejében már benne vannak** — ezért a `delegationDepth > 0`
  session-öket az agent-időbe NEM számoljuk bele (dupla számolás lenne), csak
  külön, tájékoztató sorban mutatjuk.
- **Nyitott kör:** a futó kört a *mostani* idővel zárjuk le, jelöléssel
  („fut”), és a felület 10 s-onként frissíti.

### 3.2 `jobs` — háttérmunkák

- **Definíció:** a panelek terminál-futásainak (`state\runs.json`, `startedAt`)
  és a session jobjainak élettartama, a mérés ablakára vágva.
- **Adatforrás:** `state\runs.json` + a host job-szolgáltatása; a folyamat
  tényleges élettartama PID-ellenőrzéssel (a `dsh-process-guard` mintájára).
- **Pontosság:** durva (indulás ismert, a leállás csak becsülhető; a boot előtti
  rekordok hiányosak). **Súlya alapból 0**, legfeljebb 0,25 — a felhasználó
  maga mondta, hogy a relevanciája csekély. Külön sorban látszik, hogy
  látható legyen, mit nem számolunk el.

### 3.3 `human` — olvasás + a következő prompt beírása

Két szinten mérjük; a kettő ugyanazt a számot adja, de a második pontosabban
bontja.

**A szint — napló-alapú tartalék (mindig működik, kliens nélkül is):**

```
emberi(kör n) = min( turn/start(n+1).time − turn/end(n).time , idleCap )
```

- `idleCap` profilonként (alap: 15 perc). A hosszabb szünet **nem** számít
  (ebédszünet, másik munka) — a mért 99 h „hosszú szünet" pont ezért nem mehet
  bele a számlába.
- A mérési ablak két szélén (ablak kezdete előtti, illetve a jelenlegi nyitott
  kör utáni rész) nincs pár, ezért ott a komponens 0 — ezt a felület kiírja.
- Ez a szint a session-ök **közötti** időt is beszámítja, ha a felhasználó két
  beszélgetés között dolgozik (ez valós munkaidő).

**B szint — kliens-oldali mérés (a javaslat, ez adja az olvasás/gépelés
szétválasztást):**

- Egy láthatatlan, mindig mountolt komponens (`conversation.composer.dock`,
  `null`-t renderel) figyeli a **capture fázisban**: `keydown`, `input`,
  `pointerdown`, `wheel`, `scroll`, `visibilitychange`.
- 5 másodperces vödrökbe gyűjtött **aktivitás-jelzéseket** küld a hostnak
  (`POST /koltseg/activity`), 15 s-onként vagy kör-végkor; `keepalive: true`,
  hogy a lap elhagyásakor se vesszen el.
- A host a **kör-határokhoz illesztve** bontja fel:
  - `T_end` = a kör utolsó `assistant/message`-e (a naplóból, nem a kliensből!),
  - `T_type` = az első billentyű-leütés `T_end` után (plafon: `readCap`, alap 20 perc),
  - `T_next` = a következő kör `turn/start`-ja (a naplóból),
  - **olvasás** = `T_type − T_end`, **gépelés** = `T_next − T_type`.
- Ha a lap rejtett volt (`visibilitychange` → `hidden`) vagy a gép zárolva,
  az intervallum **kimarad** („távol”) — ez a legfontosabb hamisítás-szűrő.
- Ha nincs kliens-adat (más kliensből, távoli gépről, terminálból indított
  session), a host automatikusan az **A szintre** esik vissza, és ezt a
  felület jelzi („olvasás/gépelés bontás nélkül”).
- **Korlát, amit ki kell mondani:** ez a mérés a webes felületre igaz. Gépen
  kívüli olvasást (papír, másik program) nem lát — ezért kell a plafon és a
  profilsúly, nem pedig a nyers idő.

### 3.4 `wall` — valós (bruttó) idő, uniózva

- **Definíció:** aktív naptári idő = a `[kör.start, kör.end + humanSlack]`
  intervallumok **uniója** (összefésülve, ha a rés < `idleGap`, alap 15 perc).
  Párhuzamos session-ök nem duplázzák meg, mert uniót képzünk.
- **Miért így:** a nyers session-élettartam (484 h) hamis; az uniózott,
  tétlenséggel vágott érték a „tényleg a gépnél töltött nap”.
- **Súlya alapból 0** — ez a „nem számlázható bruttó”, de kell a kimutatásba
  viszonyítási alapnak (és a napidíjas profilhoz).

### 3.5 Amit szándékosan NEM mérünk

- Gondolkodási/olvasási idő a válasz **közben** (streamelés) — az agent-idő.
- A felhasználó más programban végzett munkája.
- Hálózati/várakozási idő szétválasztása az agent-időn belül (később, ha kell:
  `dsh-session-stats` `llmMs`/`toolMs` bontása megvan, beemelhető).

---

## 4. Elszámolási modell

### 4.1 Komponensek és súlyok

```
elszámolható_perc = Σ ( komponens_perc × súly )
                   × machineToHuman          (csak az agent komponensre)
                   → kerekítés (roundToMinutes, felfelé)
                   → minimum (minimumMinutes, hatókör-szinten)
összeg_Ft = elszámolható_perc / 60 × óradíj(repo)
```

Profil mezői (`state\koltseg\config.json`):

```json
{
  "id": "alap",
  "name": "Általános",
  "weights": { "agent": 1.0, "jobs": 0.0, "humanRead": 1.0, "humanType": 1.0, "wall": 0.0 },
  "machineToHuman": 1.0,
  "idleCapMinutes": 15,
  "readCapMinutes": 20,
  "roundToMinutes": 0,
  "minimumMinutes": 0,
  "combine": "union",
  "currency": "HUF"
}
```

### 4.2 A négy előre definiált profil („több verzió”)

| id | név | agent | jobs | olvasás | gépelés | wall | mikor |
|---|---|---|---|---|---|---|---|
| `alap` | Általános | 1,0 | 0,0 | 1,0 | 1,0 | 0,0 | gépidő + emberi idő, egy tarifával |
| `gepidő` | Gépidő-alapú | 1,0 | 0,25 | 0 | 0 | 0 | a gép munkáját számlázod |
| `emberi` | Emberi munkaidő | 0 | 0 | 1,0 | 1,0 | 0 | klasszikus óradíjas elszámolás |
| `bruttó` | Aktív naptári idő | 0 | 0 | 0 | 0 | 1,0 | napidíj / fix áras elszámolás |

Plusz **egyedi profil**: a felület minden súlyt 0–3 között állíthatóvá tesz,
`machineToHuman` 0,05–1,0 között (az „1 óra gépidő = hány óra emberi munka”
kérdésre ez a válasz; alapból 1,0 = nem átszámolunk). Egyedi profil mentése
névre szól, a repóhoz rendelhető.

### 4.3 Óradíj és repó-felülírás

- `defaultRate: 12500` — globális alapérték.
- `workspaces: { "<kanonikus útvonal>": { "rate": 15000, "profile": "gepidő" } }`
  — a felületről írva, repónként.
- A felület mindig kiírja, **melyik forrás érvényes** (globális / repó), és a
  repó-szintű értéket egy kattintással vissza lehet állítani.
- A munkaterület-azonosítás a session-fejléc `cwd` mezőjéből és a
  `workspaceRegistry`-ból jön (kanonikus útvonal, ahogy a paneleknél már
  bevált), tehát a junction-elt útvonalak nem okoznak duplikált kulcsot.

### 4.4 Hatókörök

| Hatókör | Lekérdezés | Mit ad |
|---|---|---|
| Munkafolyamat | `scope=session&id=<sessionId>` | körönkénti bontás + összeg |
| Munkaterület | `scope=workspace&workspace=<path>` | session-önkénti lista + összeg |
| Dátum intervallum | `…&from=YYYY-MM-DD&to=YYYY-MM-DD` | naponkénti bontás, a munkaterületen belül |

A dátum-szűrés **kör-szintű** (nem fájl-szintű): egy session akkor is
beszámít a saját napjaiba, ha napokon át élt. A naphatárok magyar (Europe/
Budapest) naptár szerint értendők — ez a projektben már bevált minta.

### 4.5 Párhuzamos session-ök — a dupla számolás kérdése

`combine: "sum" | "union"` profilonként:

- **agent** komponensnél a `sum` a helyes (két párhuzamos stream tényleg két
  gép-munka),
- **human** és **wall** komponensnél az `union` (ugyanaz az ember, ugyanaz a nap),
- az alap profil ezért komponensenként rögzíti: `agent: sum`, `human: union`.
- A felület kiírja, ha az ablakban párhuzamos session volt („2 session futott
  egy időben — az emberi idő uniózva van”).

---

## 5. Architektúra

### 5.1 Új plugin: `plugins\dsh-koltseg` (host + kliens)

Önálló plugin a `dsh-ftp-deploy` mintájára (az `ui-extras` már 10 000+ sor,
nem hizlaljuk tovább):

```
plugins\dsh-koltseg\
  package.json
  install.ps1              junction + `- insert:` a cordis.patch.yml-be
  lib\index.js             HOST: /koltseg/* végpontok, inject = ["webServer"]
  lib\engine\scan.js       napló-bejárás (több-frame-es zstd keretbejáró)
  lib\engine\turns.js      turn-intervallumok, kör-metadata, date-range szűrés
  lib\engine\intervals.js  unió, vágás, tétlenség-plafon
  lib\engine\human.js      aktivitás-vödrök → olvasás/gépelés, A/B szint
  lib\engine\profile.js    súlyok, machineToHuman, kerekítés, minimum
  lib\engine\calc.js       hatókör-összesítés, Ft, opcionális ÁFA/anyagköltség
  lib\engine\config.js     config betöltés/mentés/validálás (kanonikus kulcsok)
  lib\engine\ledger.js     rögzített elszámolások (nem újraszámolt sorok)
  lib\client.js            KLIENS: ikon+tooltip gomb + lebegő ablak + tracker
  test\*.test.mjs          `node --test`, hálózat nélkül
```

Host-oldali végpontok:

| Végpont | Mit csinál |
|---|---|
| `GET /koltseg/ping` | életjel + verzió + config-útvonal (telepítés-ellenőrzés) |
| `GET /koltseg/config` | díjak, profilok, repó-felülírások |
| `POST /koltseg/config` | mentés validálással (tartományok, ismeretlen profil elutasítva) |
| `GET /koltseg/sessions?workspace=&from=&to=` | munkafolyamat-választó listája |
| `GET /koltseg/measure?scope=…&profile=…` | a számítás (session / workspace / range) |
| `POST /koltseg/activity` | kliens aktivitás-vödrök (kis JSON, `keepalive`) |
| `POST /koltseg/ledger` / `GET /koltseg/ledger` | elszámolás rögzítése / listája |
| `GET /koltseg/export?…&format=csv` | CSV (hatókör, profil, időszak szerint) |

Állapotfájlok (a `state\` a repóban, ahogy a többi pluginé):

- `state\koltseg\config.json` — díj, profilok, repó-felülírások
- `state\koltseg\activity.jsonl` — kliens aktivitás-vödrök (napi rotálás)
- `state\koltseg\ledger.jsonl` — rögzített elszámolások
- `state\koltseg\koltseg.log` — diagnosztika (2 MB fölött rotál)

### 5.2 Kliens: ikon + tooltip + lebegő ablak

Bizonyított minta, nem találgatás:

- **Gomb:** `conversation.session.header.utilities` slot, `id: "koltseg-header"`,
  `order: 64` (az FTP 62-nél van), `title` = tooltip, `aria-label`; 26 px-es
  keret, csak SVG ikon (HUF-jel/érme), felirat nélkül — pontosan mint az FTP
  gomb (`dsh-ftp-deploy\lib\client.js:908-971`).
- **Lebegő ablak:** `reactDom.createPortal(..., document.body)` +
  `position: fixed`, `zIndex: 2147483000` — ugyanaz a minta, amit a statisztika
  tooltipje már használ (`ui-extras\lib\client.js:2563-2597`). Bezárás: ESC +
  capture-fázisú `pointerdown` a panelen kívül (ui-extras:4264-4282), és ×
  gomb. Nem vesz el fókuszt (AGENTS §1 szelleme): nyitáskor nincs autofocus.
- **Adatok:** `props.sessionId` (aktuális munkafolyamat), `props.sessions` /
  `props.workspaces` a repó feloldásához, `props.useProjection("sessionStats")`
  az élő kör-statisztikához; minden szám a host végpontjairól jön.

Ablak vázlata (≈ 460 × 640 px, jobb felső sarok alá igazítva):

```
┌ Költségelszámolás ───────────────────────── ✕ ┐
│ [Ez a munkafolyamat] [Munkaterület] [Időszak] │
│ Óradíj: 12 500 Ft/óra [✎]   Forrás: globális  │
│ Profil:  [Általános ▾]      [Szerkesztés]     │
│ ───────────────────────────────────────────── │
│ Agent          26,8 h   ×1,0 → 26,8 h         │
│ Háttérmunka     0,3 h   ×0,0 →  0,0 h         │
│ Olvasás         8,1 h   ×1,0 →  8,1 h         │
│ Gépelés        12,1 h   ×1,0 → 12,1 h         │
│ (bruttó aktív  61,4 h   ×0,0 →  0,0 h)        │
│ ───────────────────────────────────────────── │
│ Elszámolható: 47,0 h  →  587 500 Ft           │
│ [Rögzítés]  [CSV]  [Részletek ▾]              │
└───────────────────────────────────────────────┘
```

Részletek kinyitva: körönkénti tábla (kör #, kezdés, agent, olvasás, gépelés,
Ft), illetve munkaterület-hatókörben session-önkénti lista.

---

## 6. Számítási példa (a mért adatokból)

Ugyanaz a 30 napos ablak, `alap` profil, 12 500 Ft/óra, 15 percre felfelé
kerekítve:

| Komponens | Mért | Súly | Beszámít |
|---|---|---|---|
| agent (351 kör) | 26,78 h | 1,0 | 26,78 h |
| emberi (264 szünet ≤20 p) | 20,21 h | 1,0 | 20,21 h |
| háttérmunka | ≈ 0,3 h | 0,0 | 0,00 h |
| bruttó aktív (unió) | ≈ 61 h | 0,0 | 0,00 h |
| **összesen** | | | **46,99 h → 47,00 h** |
| **számla** | | | **587 500 Ft** |

Ha ugyanez `emberi` profillal megy: 20,21 h → kerekítve 20,25 h → 253 125 Ft.
A két szám közötti különbség a profil döntése, nem a mérés hibája — ezért
látszik mindig mind a négy komponens a felületen.

---

## 7. Fázisok, tesztek, élesítés

### 1. fázis — motor + alap felület (a lényeg)

1. `lib\engine\scan.js` + `turns.js`: napló-bejárás, kör-intervallumok,
   `delegationDepth` szerinti szűrés, `cwd` → munkaterület.
2. `intervals.js`, `profile.js`, `calc.js`, `config.js`: tiszta függvények.
3. Host végpontok (`/koltseg/ping|config|sessions|measure`).
4. Kliens: ikon+tooltip, lebegő ablak, három hatókör, profil- és díjszerkesztés,
   HU/EN szótár, explicit hiba/üres állapot.
5. `install.ps1` (`-Check`, `-Remove`), `node --test` tesztek.

**Elfogadási kritérium:** a `/koltseg/measure?scope=workspace&from=2026-10-18&to=2026-11-16`
ugyanazokat a számokat adja (±2%), amit a 2. szakasz független mérése mutatott
(26,78 h agent / 20,21 h emberi / 351 kör). Ez a legjobb lehetséges teszt: a
motor egy független méréshez van kalibrálva.

### 2. fázis — emberi idő pontosítása

6. Kliens aktivitás-tracker (`conversation.composer.dock`, láthatatlan),
   `POST /koltseg/activity`, `keepalive`, rejtett lap kiszűrése.
7. `human.js`: A/B szint, olvasás/gépelés bontás, plafonok, „távol” jelzés.
8. A felület kiírja, melyik szinten mér (bontással / bontás nélkül).

### 3. fázis — elszámolás rögzítése

9. `ledger.js`: rögzítés (díj + profil pillanatképe, hogy a későbbi díjváltozás
    ne írja át a múltat), lista, törlés.
10. CSV export hatókör/ időszak szerint (magyar számformátum, pontosvessző).
11. Opcionális: ÁFA (27%) sor, és a token/API önköltség **külön sorban**
    (a `dsh-ui-extras` `/ui-extras/usage` már kiszámolja USD-ben, session-re is
    — ezt hívjuk, ha van, egyébként a sor elmarad) → fedezet/margin.

### Tesztek (`node --test`, hálózat és valódi napló nélkül)

- intervallum-unió, tétlenség-plafon, ablak-szélek,
- kör-párosítás szélső esetek (nyitott kör, megszakított kör, `turn/end` nélkül),
- delegált session kizárása (ne duplázzon),
- párhuzamos session: agent `sum` + human `union`,
- profil-matematika (súly, `machineToHuman`, kerekítés felfelé, minimum),
- díj-feloldás: repó-felülírás > globális, kanonikus útvonal,
- dátum-szűrés magyar naphatárral (téli/nyári időszámítás),
- config-validálás (ismeretlen profil, negatív díj, 3 fölé vitt súly),
- kliens-bundle: stubolt React-tel betöltés, regisztrációk, `locale`, render
  props nélkül is (a FTP-nál ez a minta 41/41-et adott),
- HU/EN szótár kulcs-paritás.

### Élesítés (a projekt szabályai szerint)

- `install.ps1` — junction + `- insert: { id: koltseg, name: dsh-koltseg }`,
  utána `-Check` zöld, `node tools\check-plugin.mjs` is futtatva.
- A **host** végpontok csak **harness-újraindítás** után élnek (AGENTS §1.5:
  előbb ellenőrizni kell, fut-e munka, és a felhasználó engedélye kell); a
  **kliens** panel-újratöltéssel él.
- Nincs gyerekfolyamat, nincs konzolablak, nincs felugró ablak (AGENTS §1). A
  mérés a host folyamatában, fájlolvasással történik.
- Dokumentáció: ez a terv + `docs\KOLTSEG-ELSZAMOLAS.md` (használat), és a
  kötelező angol tükör (`tools\check-docs-bilingual.mjs` szerint).

### Becsült munka

1. fázis: a motor és a felület a munka 60%-a; 2. fázis ~20%; 3. fázis ~20%.
Rizikó a napló-formátum változása (a `session.v3.jsonl.zstd` verziózott; a
bejáró a fejléc `version` mezőjét ellenőrzi, és ismeretlen verziónál inkább
hibát jelez, mint hogy csendben 0-t adjon).

---

## 8. Kockázatok és korlátok (kimondva)

1. **A napló-alapú agent-idő a kör teljes ideje**, tehát a modell-várakozást is
   tartalmazza — ez szándékos („a gép dolgozott”), de nem azonos a „hasznos
   munkával”. Ha erre külön szám kell, a `sessionStats` `llmMs`/`toolMs`
   bontása beemelhető.
2. **Az emberi idő mérése a webes felületre igaz.** A plafonok (15/20 perc)
   védik a hamisítást, de a mérés nem látja a gépen kívüli olvasást.
3. **Több kliens / terminálból indított session:** nincs aktivitás-adat → A
   szint, jelöléssel.
4. **A bruttó idő csábít.** 484 h vs 47 h: ezért a bruttó sor alapból 0 súlyú,
   és a felület mindig mind a négy komponenst mutatja.
5. **A díj és a profil változása nem írhatja át a múltat** → rögzített
   elszámolás (ledger) pillanatképpel.
6. **A host végpontok restart nélkül nem élnek** — a telepítés két lépés
   (telepítés + jóváhagyott restart), ezt a felület is kiírja, amíg a host fél
   régi („a host fél még a régi verzió” üzenet, ahogy a usage sornál).

---

## 9. Döntések (2026-11-16, felhasználói válaszok)

| Kérdés | Döntés | Következmény a kódban |
|---|---|---|
| Mit számoljon az alap profil? | **gépidő + emberi idő** | `alap`: agent 1,0 / olvasás 1,0 / gépelés 1,0 / háttér 0 / bruttó 0 |
| Emberi idő mérése | **kliens-mérés + napló-tartalék** | `human.js` A/B szint, `POST /koltseg/activity` |
| Kerekítés / minimum | **percre pontos, kerekítés nélkül** | `roundToMinutes: 0` (a legközelebbi egész percre), `minimumMinutes: 0` |
| Repó-szintű díj helye | **csak központi config** | `state\koltseg\config.json` → `workspaces` (kanonikus kulcs), a repókba nem írunk |
| Kimenet | nettó HUF + **kapcsolható 27% ÁFA** + **CSV** + **opcionális token-önköltség** | `vatEnabled` (alapból ki), `/koltseg/export`, `materialCost` (alapból ki, mert az óradíj magában foglalja a tokeneket) |

A válaszok beépültek: a funkció **megvalósítva** (`plugins\dsh-koltseg`), a
használatot a [`KOLTSEG-ELSZAMOLAS.md`](KOLTSEG-ELSZAMOLAS.md) írja le.
A visszamérés a valós naplókon: `node tools\check-koltseg.mjs` (a 2. szakasz
számait hozza, ±2%-on belül: agent ≈ 27,2 h, olvasás ≈ 15,5 h / 30 nap).

