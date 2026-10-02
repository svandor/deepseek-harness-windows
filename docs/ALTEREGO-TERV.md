# Alteregó avatarok — terv és ötletlista

**Státusz:** **MEGVALÓSÍTVA** (2026-10-01) — 14 alteregó, kattintható választó,
automatikus váltogatás, közös perzisztált állapot.

A Házirobotnak eddig **egy** avatarja volt (`bot/avatar/hazirobot.svg`, a fehér
robot). Mostantól **alteregói** vannak: a panel fejlécében lévő képre kattintva
(vagy a DSH panel **Alteregók** fülére váltva) bármelyik kiválasztható, és
beállítható **automatikus váltogatás** is.

---

## 1. Mi készült el

| Hol | Mit tud |
|---|---|
| **Robot-panel** (`http://127.0.0.1:4180/`) | 🎭 **Alteregó váltás** gomb a fejlécben → kattintható kép-rács; mellette az automatikus váltogatás választója |
| **DSH panel** (🤖 gomb) | a fejléc avatarjára kattintva (vagy az **Alteregók** fülön) ugyanaz a rács és auto-választó |
| **Állapot** | a választás a `bot/config.json` `avatarAlterego` blokkjába kerül — mindkét panel ugyanazt mutatja, és újraindítás után is megmarad |
| **API** | `GET /alteregok` (lista + aktív + auto), `POST /alterego` (`{aktiv}` / `{auto}`), `GET /avatar.svg?alterego=<id>` |
| **DSH host** | ugyanaz a három route `/hazi-robot/alteregok`, `/hazi-robot/alterego`, `/hazi-robot/avatar.svg?alterego=` alatt |
| **Teszt** | `node --test --test-isolation=none bot/tests/alterego.test.mjs` — 12 teszt: viewBox, közös animációs blokk, ütközésmentes keyframes-nevek, tiltott elemek, id-egyediség, útvonal-bejárás |

A választás **nem kliens-oldali**: a `config.json`-ban él, ezért a robot-panel,
a DSH panel és a jövőbeli felületek ugyanazt az alteregót mutatják.

## 2. A 14 alteregó

A `bot/avatar/alteregok/attekintes.png` egy pillanatkép a teljes készletről.

| # | id | Név | Ihlet | Mozgás |
|---|---|---|---|---|
| 1 | `gyuszi` | **Gyuszi (a valódi)** | *Magyarok az űrben* + a kért kukás változat | billeg + integet |
| 2 | `klasszikus` | Klasszikus | a régi avatar (Magyarok az űrben 6:10–6:40) | lebeg + integet + villog |
| 3 | `ezeros` | Ezüst gépember | **Clouds Across the Moon** (The Rah Band) klip táncos-robotja | táncol |
| 4 | `gonk` | Gonk | Csillagok háborúja — GNK power droid | billeg |
| 5 | `asztromech` | Asztromech | Csillagok háborúja — R2-D2 | fejforgat |
| 6 | `protokoll` | Protokoll-droid | Csillagok háborúja — C-3PO | biccent |
| 7 | `kukagyerek` | Kuka-gyerek | WALL-E | sasszézik |
| 8 | `tojas` | Tojás | WALL-E — EVE | lebeg |
| 9 | `gomb` | Golyó | Csillagok háborúja — BB-8 | gurul |
| 10 | `bender` | Bender | Futurama | pattog |
| 11 | `marvin` | Búskomor | Galaxis útikalauz stopposoknak — Marvin | lebeg |
| 12 | `szem` | Szem | 2001: Űrodüsszeia — HAL 9000 | villog |
| 13 | `clippy` | Iratkapocs | Microsoft Office — Clippy mém | pattog |
| 14 | `spot` | Robotkutya | Boston Dynamics — Spot | billeg |

### A Gyuszi (a valódi)

A kérés szerint: **műanyag papírkosár a fej** (áttetsző, rácsos, kampós fülekkel),
**bádogkuka a test** (hullámos bordák, horpadt fedél, fémfülek), **hosszú konyhai
páraelszívó flexicső a karok** (fehér műanyag, az acélmerevítés miatt gyűrűzött,
a végén csipesz). A mozgás: tántorgó billegés, a csőkarok gumi módjára kilengenek
és visszahullanak, a fedél zörög, a kosárba süllyesztett szemek pisloganak.

Ez az **alapértelmezett** alteregó (`alteregok.json` → `"alap": "gyuszi"`).

### A közös mozgás-nyelv

Mindegyik SVG ugyanazt a két animációs blokkot tartalmazza **betűre ugyanúgy**
(`.lebeg` + `@keyframes lebeg`, `.szem` + `@keyframes pislog`), ezért az összes
alteregó ugyanúgy lélegzik és pislog. Az alteregó **saját** animációi mind
prefixet kapnak (`gy-`, `ez-`, `gonk-`, …), különben a választóban egyszerre
betöltött képek CSS-e felülírná egymást. Ezt a teszt kényszeríti ki.

## 3. Automatikus váltogatás

A fejléc választója: **kikapcsolva · 10 mp · 30 mp · 1 perc · 5 perc**.
Bekapcsolva a panel `auto` másodpercenként a katalógus sorrendjében **körbevált**.
Az automatikus váltás **nem ír** a szerverre minden váltásnál (csak a beállítás
megy a `config.json`-ba), ezért nem terheli a lemezt; a kézzel választott alteregó
viszont azonnal mentődik.

## 4. Új alteregó hozzáadása (2 lépés)

1. Készítsd el a `bot/avatar/alteregok/<id>.svg` fájlt a
   [`BRIEF.md`](../bot/avatar/alteregok/BRIEF.md) szerződése szerint
   (fixed `viewBox="0 0 240 320"`, közös `.lebeg`/`.szem` blokk, prefixelt saját
   animációk, tilos a script/külső hivatkozás/SMIL).
2. Vedd fel a `bot/avatar/alteregok.json` `lista` tömbjébe
   (`id`, `nev`, `alcim`, `fajl`, `mozgas`, `ihlet`, `szin`).

Ezután futtasd a tesztet, és a panelen már meg is jelenik:

```powershell
node --test --test-isolation=none bot/tests/alterego.test.mjs
```

---

## 5. További ötletek (még nincs benne)

Ezek bármelyike 1 SVG-vel és 1 katalógus-sorral bevehető. A válogatás szempontja:
**felismerhető sziluett** és **a 240×320-as keretben is működő mozgás**.

### 5.1 Filmes és sorozatbeli robotok

| Ötlet | Miért jó | Mozgás-ötlet |
|---|---|---|
| **Maschinenmensch** (Metropolis, 1927) | az **első** filmes robot — történelmi tétel | merev, kimért fordulás |
| **RoboCop** (OCP-01) | sisak + vörös visor, azonnal felismerhető | célzó fejfordítás, súlyos lépés |
| **T-800 endoskeleton** (Terminátor) | a „vörös szem a sötétben” ikon | lassú, megállíthatatlan járás |
| **Gort** (Aznap, amikor megállt a Föld) | sima ezüst óriás, redőnyszerű visor | teljesen mozdulatlan, csak a visor nyílik |
| **Johnny 5** (Short Circuit) | kazettás fej, szemöldök, kíváncsi | fejforgatás + szemöldök-felvonás |
| **Baymax** (Big Hero 6) | felfújt fehér test, pont-szemek | lassú, puha oldaldőlés |
| **Vasóriás** (The Iron Giant) | vasóriás, kedves | nehéz fejbiccentés |
| **TARS** (Interstellar) | téglatest, katonás | téglatest-forgás, száraz humor |
| **M-O** (WALL-E) | megszállott takarító | ideges oldalazás, tisztítóhenger |
| **Rosie** (Jetsons) | **házirobot-asszony** — pont ez a téma | porszívózó, anyáskodó ringás |
| **Data** (Star Trek TNG) | arany bőr, sápadt arc | fejbillentés, „érzelem nélküli” |
| **K-2SO** (Zsivány Egyes) | magas, fekete, esetlen | hosszú karok lengése |
| **Cylon** (Battlestar Galactica) | vándorló vörös szem | a szem sétál a visorban |
| **ED-209** (RoboCop) | harci robot | dühös lépések, ágyú-cső |
| **GLaDOS / Wheatley** (Portal) | függő „személyiség-kocka” | ringás a kábelen |
| **BMO / GIR** (Adventure Time / Invader Zim) | kicsi, mém-kedvenc | pattogó, kaotikus |
| **Daft Punk / Kraftwerk** robotok | zenei ikonok | egyenletes, gépi ütem |

### 5.2 Mémek és internet-kultúra

| Ötlet | Miért jó |
|---|---|
| **Clippy** ✔ (már benne) | a „segítőkész, idegesítő” archetípus |
| **This is fine** kutya — robot változatban | a mindent túlélő nyugalom |
| **„Danger, Will Robinson”** (Lost in Space) | a klasszikus figyelmeztető robot |
| **Skynet / HAL** ✔ (HAL benne) | a „gonosz gép” vonal |
| **Big Dog / Atlas** (Boston Dynamics) | Spot ✔ mellé a másik kettő |
| **Sophia / Pepper / ASIMO** | valódi humanoidok, híresebb arcok |
| **„Kockás robot”** (a „nem tudom, mi ez” mém) | szándékosan semmitmondó |
| **Vecsési „Ez egy robot?”** | magyar mém-vonal |

### 5.3 Magyar vonal

| Ötlet | Miért jó |
|---|---|
| **Mikrobi** | magyar rajzfilmtörténet; gép, nem robot — de a sziluett ikonikus |
| **A „Magyarok az űrben” többi robotja** | ugyanabból a forrásból, mint a Gyuszi |
| **Pannónia / Ikarus** stílusú retro gép | magyar ipari formavilág |
| **Vidám park-i szerkezet** | nosztalgia |

### 5.4 Háztartási és absztrakt ötletek (a „házirobot” szó szerint)

| Ötlet | Miért jó |
|---|---|
| **Porszívó-robot (Roomba)** | szó szerint házirobot |
| **Kávéfőző-robot** | reggeli rutin |
| **Kenyérpirító-robot** | a „kiugró pirítós” mint poén |
| **Retró CRT-televízió fej** | analóg nosztalgia |
| **Rádió-robot** | vintage vonal |
| **Konnektor-fej / villanykörte-fej** | „áram alatt van” |
| **LEGO-robot** | építőkocka-esztétika |
| **Origami / papírrobot** | a papírkosár-fej rokonai |
| **Ventilátor-robot** | a fej pörög |
| **Ünnepi változatok** (Mikulás-sapka, töklámpás-fej, nyuszifül) | szezonális váltogatás az auto-módhoz |

### 5.5 Bővebb ötletek a rendszerhez

- **Saját sorrend** az automatikus váltáshoz (ne a katalógus sorrendje legyen,
  hanem kijelölhető „kedvencek”).
- **Váltás eseményre**: amikor a robot hibát jelez → vörös (`szem`), amikor
  sikeres egy job → `klasszikus`, amikor jóváhagyásra vár → `clippy`.
- **Napszak szerinti alteregó** (reggel `bender`, éjszaka `szem`).
- **Avatar a riport-e-mail fejlécében** (a levél HTML-jében az aktív alteregó).
- **`?alterego=` a konzol URL-jén**, hogy egy adott alteregóval nyíljon a panel.
