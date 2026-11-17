# Fejlesztési költségelszámolás — használat

[English](KOLTSEG-ELSZAMOLAS.en.md) | Magyar

A funkció a menüsor **érme-ikonjára** (tooltip: „Költségelszámolás”) nyíló
**lebegő ablakban** él. Alap óradíj **12 500 Ft**, repónként felülírható.

- Terv és döntések: [`KOLTSEG-ELSZAMOLAS-TERV.md`](KOLTSEG-ELSZAMOLAS-TERV.md)
- Plugin: `plugins\dsh-koltseg` (host + kliens), telepítés: `install.ps1`
- Ellenőrzés: `node tools\check-koltseg.mjs`, tesztek: `plugins\dsh-koltseg\test\*.test.mjs`

---

## 1. Hol van?

A beszélgetés fejlécében, a jobb oldali ikonok között (az FTP és az Admin ikon
mellett), egy **26 px-es érmeszimbólum**. A felirat nincs a gombon — a tooltipben
van, ahogy a többi fejléc-gombnál.

Ha a beszélgetés **még üres** (új session), a fejléc rejtve van — ilyenkor
ugyanaz az ikon a **composer fölötti sávban** jelenik meg (ugyanaz a gomb,
ugyanaz az ablak). A fázist a felület `data-phase` attribútuma dönti el.

Kattintásra **lebegő ablak** nyílik a gomb alatt (nem oldalsáv-fül):

- bezárás: `✕`, `ESC`, vagy kattintás az ablakon kívülre;
- az ablak nem vesz el fókuszt, és görgethető, ha nem fér ki;
- **pillanatkép:** megnyitáskor a legutóbbi eredmény **azonnal** megjelenik
  („Pillanatkép: HH:MM — a friss mérés fut…”), a friss számítás a háttérben fut
  és felülírja; a host is 90 s-ig gyorsítótárazza ugyanazt a kérést, a
  **Frissítés** gomb viszont mindig újraszámol (`fresh=1`);
- a mérés 20 s-onként frissül, amíg nyitva van (rejtett lapon nem).

A gomb **csak a menüsorban** van (fejléc-ikon), illetve **üres beszélgetésnél** a
composer fölötti sávban — a panelek alján nincs külön költség-chip.

## 2. Mit mutat?

Három hatókör:

| Gomb | Mit mér |
|---|---|
| **Ez a munkafolyamat** | a kiválasztott beszélgetés (session) körei |
| **Munkaterület** | a munkaterület összes munkafolyamata |
| **Időszak** | ugyanaz, `Tól`/`Ig` dátum között (a `Ig` napja beleszámít) |

A komponensek mindig **mind** látszanak, a súlyukkal együtt — így látszik, mit
nem számolunk el:

| Komponens | Honnan jön |
|---|---|
| Szerver oldali munkaidő | `turn/start` → `turn/end` a tartós session-naplóból (a helyi Ollama is benne) |
| Háttérmunkák | a panelek terminál-futásai (`state\runs.json`), **becslés** |
| Olvasás | a kör vége és az első billentyű között |
| Gépelés | az első billentyű és a következő kör kezdete között |
| Valós aktív idő | a körök uniója, rövid résekkel összefűzve |

Alatta a **végösszeg**: elszámolható idő, nettó Ft, (kapcsolható) ÁFA, bruttó.

Részletek: körönkénti tábla (session-hatókör) vagy munkafolyamatonkénti lista
(munkaterület-hatókör).

## 3. Óradíj és profilok

- Az **óradíj** mező a repóra érvényes díjat mutatja; átírás után **Mentés**.
  A mező **ezres tagolással** ír (`12 500`), a végösszegek ugyanígy jelennek meg.
  A felület kiírja a forrást is: „globális alap” / „repó felülírás”.
  A repó-szintű díj a `state\koltseg\config.json`-ban él (a repókba nem írunk).
- **Munkaterület-feloldás:** a panel a kiválasztott beszélgetés `cwd` mezőjéből
  (majd a kiválasztott, végül az első munkaterületből) oldja fel — ha a kérés nem
  mondja meg, a host a session naplófejlécéből teszi ugyanezt. Így a mérés nem a
  szerver saját munkakönyvtárára esik.
- A **profil** a súlyokat adja. Négy előre definiált profil:

| id | név | agent | háttér | olvasás | gépelés | bruttó |
|---|---|---|---|---|---|---|
| `alap` | Általános | 1,0 | 0 | 1,0 | 1,0 | 0 |
| `gepido` | Gépidő-alapú | 1,0 | 0,25 | 0 | 0 | 0 |
| `emberi` | Emberi munkaidő | 0 | 0 | 1,0 | 1,0 | 0 |
| `brutto` | Aktív naptári idő | 0 | 0 | 0 | 0 | 1,0 |

- **Egyedi profil** a `config.json` `profiles` listájában adható hozzá
  (`weights` 0–3, `machineToHuman` 0,05–1, `idleCapMinutes`, `readCapMinutes`).
  Az előre definiált profilt egyedi nem írhatja felül (a betöltés elutasítja).

## 4. Hogyan mérjük az emberi időt?

Két szinten; a felület a mérés alján kiírja, melyik élt:

1. **Napló-alapú (mindig működik):** a kör vége és a következő kör kezdete
   közötti idő. A **15 percnél hosszabb** szünet **nem számít** (ebéd, másik
   munka) — ezért konzervatív.
2. **Kliens-mérés (pontosabb):** a webes felület láthatatlan komponense
   billentyű/mutató/görgetés/lap-láthatóság vödröket küld 15 s-onként
   (`POST /koltseg/activity`). Ebből lesz külön **olvasás** és **gépelés**.
   A rejtett lapon töltött idő kimarad; ha a szünetben nincs aktivitás, az
   „távol” (0), nem becsüljük felülre.
   Szöveget **nem** küldünk — csak időbélyegeket.

Ha nincs kliens-adat (másik kliens, terminálból indított session), a mérés
automatikusan az 1. szintre esik vissza, és ezt ki is írja.

## 5. Rögzítés és export

- **Rögzítés:** elmenti a mostani kimutatást **pillanatképpel** (díj, profil,
  percek) a `state\koltseg\ledger.jsonl`-be. A későbbi díjváltozás a rögzített
  sort nem írja át.
- **CSV:** a mostani hatókör/ időszak adatai (körönként vagy
  munkafolyamatonként), magyar formátumban (pontosvessző, tizedesvessző).
- **ÁFA:** kapcsoló a végösszegen (alapból kikapcsolva, 27%).
- **Token/API önköltség:** kapcsoló; külön sorban mutatja a becsült USD
  tokenköltséget (a meglévő `/ui-extras/usage` adataiból). Az óradíj alapból
  magában foglalja a tokeneket — ez a sor csak kimutatás.

## 6. Konfiguráció

`state\koltseg\config.json` (BOM nélkül, atomikusan írva):

```json
{
  "version": 1,
  "currency": "HUF",
  "defaultRate": 12500,
  "defaultProfile": "alap",
  "vatPercent": 27,
  "vatEnabled": false,
  "materialCost": false,
  "profiles": [],
  "workspaces": {
    "D:\\Szerver\\Deepseek Harness": { "rate": 15000, "profile": "gepido" }
  }
}
```

A munkaterület-kulcs **kanonikus** (junction feloldva), ezért a `C:`/`D:` alak
nem hoz létre két bejegyzést. A fájl sérülése nem visz el adatot: a betöltés a
hibás értéket a legközelebbi érvényesre állítja, és a válasz kimondja, mit
módosított.

## 7. Végpontok (host)

| Végpont | Mit ad |
|---|---|
| `GET /koltseg/ping` | életjel + verzió + útvonalak |
| `GET /koltseg/config` | konfiguráció + profilok + a repóra érvényes díj |
| `POST /koltseg/config` | mentés (validálva, normalizálva) |
| `GET /koltseg/workspaces` | munkaterületek (registry vagy a naplókból) |
| `GET /koltseg/sessions?workspace=` | munkafolyamat-lista |
| `GET /koltseg/measure?scope=&id=&workspace=&from=&to=&days=&profile=` | a mérés |
| `GET /koltseg/export?…&format=csv` | a mérés CSV-ben |
| `POST /koltseg/activity` | kliens aktivitás-vödrök |
| `GET /koltseg/ledger` | rögzített elszámolások (+ `?format=csv`) |
| `POST /koltseg/ledger` / `DELETE /koltseg/ledger?id=` | rögzítés / törlés |

## 8. Állapotfájlok

| Fájl | Tartalom |
|---|---|
| `state\koltseg\config.json` | díj, profilok, repó-felülírások |
| `state\koltseg\activity.jsonl` | aktivitás-vödrök (append-only, 5 MB-nál rotál) |
| `state\koltseg\ledger.jsonl` | rögzített elszámolások (5 MB-nál rotál) |
| `state\koltseg\koltseg.log` | diagnosztika (útvonal-regisztrációk, mérés-összegzés) |

## 9. Ellenőrzés és hibakeresés

```
node tools\check-koltseg.mjs          # valódi naplókon: frame-olvasás, DST, profil, mérés
node --test plugins\dsh-koltseg\test\engine.test.mjs
node --test plugins\dsh-koltseg\test\client.test.mjs
node --test plugins\dsh-koltseg\test\host.test.mjs
pwsh -NoProfile -File plugins\dsh-koltseg\install.ps1 -Check
```

- **„A host fél még a régi verzió”** az ablakban: a harness még a plugin
  bejegyzése ELŐTT indult. A host-kompozíció boot-időben töltődik, tehát a
  következő indításnál él (AGENTS §1.5: futó munka közben tilos újraindítani).
- **0 Ft / 0 perc:** nincs session-napló a munkaterületen, vagy a hatókör
  időszaka üres. A „Részletek” megmutatja, mely munkafolyamatok számítottak.
- **„bontás nélkül” (napló-alapú becslés):** ehhez az időszakhoz nincs
  kliens-aktivitás (a lap nem volt nyitva, vagy a plugin kliens fele nem futott).
- A mérés **soha** nem olvassa a beszélgetések tartalmát: csak időbélyegeket és
  számosságokat.

## 10. Amit szándékosan nem mér

- A válasz **közbeni** olvasást (az agent-idő része).
- A gépen kívüli olvasást (papír, másik program).
- A háttérmunkák pontos végét (csak az indulás van naplózva — ezért becslés, és
  ezért 0 az alap súlyuk).
