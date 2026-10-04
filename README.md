# DeepSeek Harness for Windows — tálcaikon, natív ablak, magyar felület

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Platform: Windows 11](https://img.shields.io/badge/platform-Windows%2011-0078d4)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)

> **English** — Turns the DeepSeek Harness Web GUI into a normal Windows
> application (tray icon, native WebView2 window, pinnable launcher) and adds
> three things it does not ship with: a **full Hungarian interface**, an
> **automatic free-model fallback chain for subagent delegation**, and a
> **built-in local robot** with its own status panel. Full English description:
> [`README.en.md`](README.en.md).
>
> **Magyar** — A DeepSeek Harness Web GUI-t igazi Windows-alkalmazássá alakítja
> (tálcaikon, natív WebView2 ablak, tálcára kitűzhető indító), és hozzáad hármat,
> ami alapból nincs benne: **teljes magyar felület**, **ingyenes modellekre
> épülő automatikus fallback-lánc a subagent-delegációhoz**, és egy **beépített
> helyi robot** saját állapotpanellel.

Szerző / Author: **Varga Sándor (svandor)** — MIT licenc / MIT license.

## Telepítés egy kattintással

Töltsd le a `DeepSeek-Harness-Setup-<verzió>.exe`-t a
[legutóbbi kiadásból](https://github.com/svandor/deepseek-harness-windows/releases/latest), és futtasd. Kibontja a
munkaterületet a `%LOCALAPPDATA%\DeepSeekHarness` mappába, ellenőrzi a Node.js és
a WebView2 meglétét, és elkészíti az asztali + Start menü ikont.

```text
DeepSeek-Harness-Setup-0.1.0.exe                 # telepítés, folyamatjelzéssel
DeepSeek-Harness-Setup-0.1.0.exe /silent         # kérdés nélkül
DeepSeek-Harness-Setup-0.1.0.exe /autostart      # + tálca indítása bejelentkezéskor
DeepSeek-Harness-Setup-0.1.0.exe /dir=D:\DSH     # saját célmappa
DeepSeek-Harness-Setup-0.1.0.exe /uninstall      # mappa + parancsikonok törlése
```

Portable változat (kicsomagolás után `install.cmd`), vagy forrásból: lásd
[`README.en.md`](README.en.md). A csomagok előállítása:
`.\tools\build-installer.ps1`.

**Követelmények:** Windows 11 · Node.js ≥ 22 · a `dsh` CLI
(`npm install -g @deepseek-ai/dsh`) · WebView2 futtatókörnyezet (a Windows 11
része). Az indító újrafordításához Visual Studio Build Tools Roslyn `csc.exe`
(nem kell .NET SDK).

---

Az alábbiak a magyar üzemeltetési útmutató részletei: a tálcaikon, a natív ablak,
a panelek, az állapotfájlok és a hibaelhárítás.


Ez a könyvtár a DeepSeek Harness **helyi beállítása**: egy tálcaikon, ami elindítja
a háttérben futó Web GUI-t, és megnyitja azt egy **saját, natív ablakban** – nem kell
terminált nyitva tartani, és nem böngészőfülben nyílik.

```
tálcaikon (jobb alsó sarok)
   ├─ elindítja a háttér-GUI-t (dsh web, rejtett folyamat)
   ├─ megnyitja a natív WebView2 ablakot (bin\DshWindow.exe), sötét témában
   └─ az ablak bezárása után a GUI a háttérben fut tovább
```

## Indítás

Dupla kattintás: **`tray\dsh-tray.cmd`** – vagy az asztali **DeepSeek Harness** ikon

Ez elindítja a rendszertálcai ikont a jobb alsó sarokban, elindítja a háttér-GUI-t,
és megnyitja a natív ablakot. Ezt követően **nem kell semmilyen konzol** – minden a
tálcaikonról érhető el.

### Asztali indító ikon (tálcára kitűzhető)

Úgy viselkedik, mint egy normál alkalmazás indítója:

```
dupla kattintás az asztali ikonra
   ├─ a rendszertálcai ikon még nem fut  -> elindul, és megnyílik az ablak
   ├─ a tálca fut, az ablak zárva        -> megnyílik az ablak
   └─ az ablak már nyitva van            -> előtérbe kerül
                                            (nem nyílik második, nincs hibaüzenet)
```

Létrehozása:

```powershell
.\install.ps1                 # asztali ikon
.\install.ps1 -AutoStart      # + bejelentkezéskori indítás (tálca, ablak nélkül)
.\install.ps1 -RemoveAutoStart
```

### Tálcára tűzés — a megoldás: valódi `.exe` célpont

A Windows 11 **csak azt a parancsikont tűzi ki a tálcára, amelynek célpontja
valódi `.exe`**. Ha a célpont `.cmd`/`.bat`/`.ps1`, akkor az ikon **nem húzható**
és a jobb klikk menüben sem jelenik meg a „Kitűzés a tálcára”. Ezért készült a
`bin\DshLauncher.exe`, és az asztali + Start menü ikonok már erre mutatnak.

```
Asztali ikon / Start menü  ->  bin\DshLauncher.exe  ->  tálcaikon (dsh-tray.ps1)
```

Így az asztali ikon **húzással** is feltehető a tálcára (vagy jobb klikk →
Kitűzés a tálcára). A `DshLauncher.exe` kapcsolói:

```powershell
.\bin\DshLauncher.exe                # ablak megnyitása (a tálcát is elindítja)
.\bin\DshLauncher.exe --tray-only    # csak a rendszertálcai ikon, ablak nélkül
```

A Start menü bejegyzést a `.\pin-to-taskbar.ps1` készíti el (`-Remove` törli);
a `.\install.ps1 -PinToTaskbar` ugyanezt teszi.

A tálcára kitűzött ikon ugyanúgy viselkedik, mint az asztali: ha a tálcaikon már
fut, az ablakot nyitja meg; ha nem, elindítja.

A tálcaikon menüjében is van **Asztali gyorsparancs…** pont.

Amit a tálcaikon tud (jobb klikk) — **minden pontnak van tooltipje**, amely
megmondja, mi történik és mi marad utána:

| Menüpont | Mit csinál |
|---|---|
| **Állapot…** | A harness, az ablak, a robot panel és az őrfolyam állapota egy ablakban |
| **Megnyitás (ablak)** | Megnyitja (vagy előtérbe hozza) a natív ablakot; a háttér-GUI-t is elindítja, ha kell |
| **Ablak bezárása** | Bezárja az ablakot – a háttér-GUI és a tálca futva marad |
| **Ablak felosztása ▸** | 1–3 munkaterület-panel, és külön a **4. felület: robot panel** / **Csak robot mód (1 felület)** |
| **Háttér-GUI indítása** | Elindítja a `dsh web` folyamatot, ha nem fut |
| **Háttér-GUI leállítása** | Leállítja a háttérfolyamatot (a munkamenetek megmaradnak) |
| **Újraindítás** | Leállít + friss belépési tokennel újraindít; az ablak magától az új tokenre vált |
| **Port beállítása…** | Melyik porton figyeljen (alapértelmezés: 3080) |
| **dsh elérési út…** | Ha nem találná a dsh-t, itt adható meg kézzel |
| **Naplók megnyitása** | A tálca, az ablak és a háttérfolyamat naplója |
| **Asztali gyorsparancs…** | Készít egy „DeepSeek Harness” ikont az asztalra |
| **A tálca újraindítása** | Újratölti a tálca programját (frissítés után); az ablak és a háttér-GUI érintetlen |
| **Kilépés (minden leáll)** | **MINDENT** leállít: az ablakot, a háttér-GUI-t és a tálcát is. A robot panel őrfolyama külön folyamat, az futva marad |

Dupla kattintás a tálcaikonon: azonnal megnyitja az ablakot.

Az ikon színe az állapotot mutatja: **kék = fut**, **szürke = áll**.

## Az ablak

A `bin\DshWindow.exe` egy saját, keret nélküli alkalmazásablak (WPF + WebView2),
sötét címsorral és sötét témával. Nem böngésző: nincs cím- és fülsáv, külön
taskbár-eleme van. Az ablak **több panelre osztható**, és minden panel egy-egy
teljes kliens a maga munkaterületével — lásd
[Panelos felosztás](#panelos-felosztás--több-munkaterület-egy-ablakban).

### Pozíció- és méretmemória

Az ablak **minden esetben megjegyzi, hol és mekkora volt**, és a következő
megnyitáskor oda tölti vissza (`state\window-geometry.txt`). Így a 32:9-es
monitoron a megszokott helyen nyílik, nem középen.

- A mentés az ablak bezárásakor történik (maximalizált ablaknál is a „normál”
  méretet jegyzi meg).
- Ha a mentett hely egy már lecsatolt monitorra esne, az ablak automatikusan
  középre kerül (nem tűnik el).
- Középre tenni: töröld a `state\window-geometry.txt` fájlt, vagy indítsd
  `--reset-geometry` kapcsolóval.

Hasznos kapcsolók (kézi indításhoz):

```powershell
.\bin\DshWindow.exe --port 3080                  # háttér-GUI indítása + ablak
.\bin\DshWindow.exe --port 3080 --restart-if-stale   # friss token, ha kell
.\bin\DshWindow.exe --url "http://127.0.0.1:3080/?token=..."   # közvetlen cím
.\bin\DshWindow.exe --panes 2                    # két panel, két munkaterület
.\bin\DshWindow.exe --width 1600 --height 1000   # első méret (ha még nincs mentés)
.\bin\DshWindow.exe --reset-geometry             # pozíció felejtése
.\bin\DshWindow.exe --close-after 10             # teszt: 10s után bezár
```

### Panelos felosztás — több munkaterület egy ablakban

Az ablak `--panes N` kapcsolóval **N egymás melletti panelre** osztható
(1–4; alapérték a tálcánál 2). Nem egy beszélgetés látszik több panelen, hanem
**panelenként egy-egy teljes kliens**, saját WebView2 profillal:

- Minden panel a saját profiljából fut (`state\webview2\pane-1`, `pane-2`, …),
  ezért **megjegyzi a saját munkaterületét, a kiválasztott sessionjét és a
  piszkozatait** — a bal panel lehet pl. a `Raider`, a jobb a `Deepseek Harness`
  munkaterület, és mindkettő a sajátján marad újranyitás után is.
- A két panel **valóban párhuzamosan fut**: két külön kliens, két külön
  kapcsolat ugyanahhoz a háttér-GUI-hoz. Az egyikben indíthatsz hosszú
  szöveg-/képfeldolgozást, a másikban közben weboldalt fejleszthetsz.
- A panelek közti **elválasztó húzható**; a pozíció a `state\pane-layout.txt`-be
  mentődik (töröld, ha egyenlő felosztást szeretnél).
- Munkaterületen belül **nem** javasolt két párhuzamos session ugyanazon a
  fákon: a panelek ezért munkaterületre valók, nem ugyanazon munkaterület
  duplikálására.

Beállítás és használat a tálcáról:

1. Tálcaikon → **Ablak felosztása** → `1` / `2` / `3` panel (a `state\tray-config.json`
   `panes` értékét írja).
2. Ha épp nyitva van ablak, a program megkérdezi, hogy újraindítsa-e; a panelek
   a saját profiljukból visszatöltenek.
3. Külön menüpont: **Ablak bezárása** (a háttér-GUI futva marad).
4. Az állapotablak (`Állapot…`) mutatja az éppen beállított felosztást.

> A paneleket külön kliensként a háttér-GUI szolgálja ki; a szervert nem kell
> hozzá újraindítani, és a panelek száma a szervert nem érinti.

> A `tray\dsh-tray.ps1` módosítása után a **futó tálcát újra kell indítani**
> (tálcaikon → *Kilépés*, majd az asztali ikon), különben a régi, memóriában futó
> szkript nyitja az ablakot — panel nélkül.

## Miért volt szükség erre a könyvtárra

A gépen már volt globálisan telepítve a `dsh-harness-control` csomag, de két okból
nem volt használható a jelenlegi DSH-val:

1. A csomag a saját, régebbi `@deepseek-ai/dsh` példányát (0.1.0-rc.8) indítja,
   ami **más hitelesítési fájlformátumot** vár, mint a most futó 0.1.5-rc.3 –
   ezért a `.credentials.yaml`-nél elhasalt (`must be a string` hiba).
2. Ablakot nem tud nyitni: böngészőt indít.

Ez a megoldás a **meglévő, működő dsh telepítést** használja (a legfrissebbet
választja ki), és saját natív ablakot ad hozzá.

### A belépési token (miért nem volt elég a sima URL)

A `dsh web` minden induláskor egy **tokent** ír ki, és a böngészőt csak a
tokenezett URL-lel szolgálja ki (`http://127.0.0.1:3080/?token=...`); ez cseréli
sütire. A sima `http://127.0.0.1:3080` ezért `401`-et ad. A launcher ezt kezeli:

- elindítja a harness-t, és **kiolvassa a tokenezett URL-t** a kimenetéből,
- elmenti a `state\harness.url` fájlba (tálcához és későbbi ablaknyitáshoz),
- ha egy **már futó** harness-hez nincs token, `--restart-if-stale` módban
  újraindítja, és megszerzi az újat.

## Fájlok

```
install.ps1          asztali ikon (és opcionális bejelentkezéskori indítás)
pin-to-taskbar.ps1   Start menü bejegyzés a tálcára tűzéshez
build.ps1            a natív ablak újrafordítása (bin\DshWindow.exe)
make-icons.ps1       az ikonok újragenerálása a frontend favicon.svg-jéből
src\DshWindow.cs     a natív ablak forrása (WPF + WebView2, Core API)
bin\DshWindow.exe    a kész ablakprogram (+ WebView2 futtató DLL-ek)
lib\                 a fordításhoz használt WebView2 assembly-k
assets\              ablak-/tálcaikonok (kék és szürke)
tray\dsh-tray.ps1    a tálcaikon és az indító logika (fő belépési pont)
tray\dsh-tray.cmd    asztali/tálcára kitűzhető indító (ablakot nyit)
tray\dsh-tray-startup.cmd  csak a tálcaikon indítása (bejelentkezéskor)
tray\dsh-window.cmd  az ablak megnyitása (ugyanaz, mint az asztali indító)
tray\dsh-window.ps1  az ablak közvetlen indítása PowerShellből
tools\restart-harness.cmd  a harness újraindítása (a tálca végzi el; bárhonnan fut)
tools\restart-tray.cmd     csak a tálca programjának újratöltése (frissítés után)
tools\restart-all.cmd      teljes frissítés egy kattintással: ELŐBB a tálca, AZUTÁN
                           a harness (a sorrend számít), végül összegzés és állapot
tools\build-window.cmd     az ablak újrafordítása FUTÓ ablak mellett is (átnevezi a régit,
                           az új exe a következő ablaknyitáskor lép életbe)
tools\check-servers.ps1    állapot: harness, robot panel, tálca-életjel, token
tools\release.cmd          kiadás: verzióemelés + commit + tag + push + GitHub Release
                           (a Git panel "Kiadás" gombja ugyanezt hívja)
VERSION              a kiadás verziója; a pluginok package.json-ja innen kapja
state\               állapot: pid, token URL, naplók, beállítások, ablakgeometria
state\tray-config.json     a tálca beállításai (port, panelek, robot felület)
state\tray.heartbeat       a tálca életjele (15 másodpercenként; ebből tudja a
                           restart-szkript, hogy rábízhatja az újraindítást)
state\restart-request      külső újraindítási kérés a tálcának (feldolgozás után törlődik)
state\window-geometry.txt  az ablak utolsó pozíciója és mérete
state\pane-layout.txt      a panelek egymáshoz viszonyított szélessége
state\webview2\pane-1\     az 1. panel saját böngésző-profilja (állandó)
state\webview2\pane-2\     a 2. panel saját böngésző-profilja (állandó)
```

## Beállítások

A tálca beállításait a `state\tray-config.json` tárolja:

```json
{ "port": 3080, "dshBin": "", "width": 1280, "height": 840, "panes": 2 }
```

A `dshBin` üresen hagyva a program a legfrissebb elérhető dsh-t választja
(npx cache → globális npm → helyi `node_modules` → PATH).

A `panes` a natív ablak paneljeinek száma (1–4). A tálcáról az
**Ablak felosztása** menüben állítható; a `--panes` kapcsoló felülírja.

## Automatikus indítás bejelentkezéskor (opcionális)

Alapértelmezésben **nincs** bekapcsolva. Bekapcsolás:

```powershell
.\install.ps1 -AutoStart
```

Ez a `tray\dsh-tray-startup.cmd`-t teszi a bejelentkezési mappába, ami a tálcaikont
indítja el **ablak nélkül** (a GUI a háttérben elindul). Az ablakot ilyenkor az
asztali ikonnal nyitod. Kikapcsolás: `.\install.ps1 -RemoveAutoStart`.

## Megjegyzett hozzájárulások („mindig” engedélyek)

Ha egy művelet a workspace-en kívülre nyúlna, a Harness sárga kártyán kér
hozzájárulást. A kártya magyarul beszél, és háromféle válasz adható rajta:

| Gomb | Mit tesz |
|---|---|
| **Elutasítás** | a művelet nem fut le |
| **Engedélyezés egyszer** | csak erre az egy alkalomra engedélyez |
| **Mindig: …** | elmenti a hozzájárulás **típusát**, és legközelebb már nem kérdez rá |

Két „Mindig” gomb van: az egyik csak arra az eszközre érvényes, amelyik kérte
(`pwsh`, `fs`, …), a másik minden eszközre. A típus mindig a kérés megnevezett
célja — például `teljes hozzáférés (danger-full-access)` —, ezért egy megjegyzett
teljes hozzáférés **nem** engedélyezi automatikusan a `workspace-write` emelést,
és fordítva. Ez tehát nem a „soha többé nem kérdezek semmit” kapcsoló, hanem
**egy hozzáféréstípus megjegyzése**: minden más típus továbbra is kérdez.

A döntés a **host** oldalon születik: ha a típus meg van jegyezve, a szerver
válaszol a kérésre, mielőtt a böngésző egyáltalán látná — a kártya meg sem
jelenik. A megjegyzett tételek a `state\approvals.json` fájlban vannak, és a
jobb felső sarok **🛡** gombjánál tekinthetők meg: egyenként visszavonhatók, az
összes törölhető, és látszik az automatikus engedélyezések naplója is (ugyanez a
szerver oldalon a `state\ui-extras-client.log`-ban).

> A „Mindig” gombok csak akkor látszanak, ha a host oldal (a `/ui-extras/approvals`
> route) már fut. Új plugin-verzió után ezért a szervert egyszer újra kell
> indítani a **⇪ élesítés** vagy a **⭯ újraindítás** gombbal; a kártya addig is
> működik, csak a megjegyzés nélkül.

A **sarokgombok és a statisztika-sor új, még üres beszélgetésben is látszanak**:
ilyenkor a beviteli mező fölött jelennek meg, majd az első üzenet elküldése után
átkerülnek a megszokott helyükre (jobb felső sarok, illetve a beviteli kártya
alatti sor).

### Költség és statisztika — mi hol van

A sorban csak a pillanatnyi, egyértelmű adatok vannak: kör, lépés, zseton,
gyorsítótár-találat, egyenleg, valamint a csúcs/völgyidőszak állapota és a
következő váltás. A **költség és a napi átlag a sor gyorstippjében** (egér a sor
fölé) van, mert ezekhez az egész előzmény kell:

```
Használat és költség (becslés a hivatalos ártáblával)
Ez a beszélgetés: $0.6644
Költség (30 nap): $0.6644
Napi átlag (30 nap): $0.0221/nap
Aktív nap: 1 (átlag $0.6644/nap)
Zseton (30 nap): 145.2M — nem cache-elt 292.4k, cache-találat 144.6M, kimenet 311.3k
Kérések: 455
Csúcsidő csak hétköznap van, magyar idő szerint 03:00–06:00 és 08:00–12:00;
hétvégén és kínai ünnepnapokon mindig völgyidőszak (fél ár).
```

A 30 napos összesítőt a **host** számolja a session-naplókból
(`GET /ui-extras/usage?days=30&session=…`), kérésenként a valódi modellel és a
**akkori** árfolyammal (a DeepSeek hivatalos ártáblája szerint; csúcsidő csak
hétköznap 01:00–04:00 és 06:00–10:00 UTC, magyar idő szerint télen 02:00–05:00 és
07:00–11:00, nyáron 03:00–06:00 és 08:00–12:00). Hétvége és a kínai
munkaszüneti napok mindig völgyidőszaknak számítanak — az ünnepnap-lista a
2026-os State Council-rendeletből származik, és évente frissítendő a host fél
`CHINESE_HOLIDAYS` táblájában. A `check-usage.mjs` és a `check-plugin.mjs`
ellenőrzi az árakat, az ablakokat és a két másolatban élő ünnepnap-tábla
egyezését.

#### Delegált munka — ingyenes lánc és fizetős út külön

A delegált (subagent) munkát a tooltip **két zsebre** bontja, mert csak az egyik
fajta megtakarítás:

```
Megtakarítás — delegált munka az ingyenes láncon
Megtakarítás: $0.0128 (ennyibe került volna a fizetős úton)
Ingyenes láncon: 10 kérés · $0.0000 · 5 session
Delegálva, de fizetős route-on: 274 kérés · $0.3019 (nincs megtakarítás)
Delegálva: 284 / 7.2k kérés (3.9%)
ingyenes worker: 10 kérés · $0.0000
fizetős deepseek-flash: 273 kérés · $0.2969
Utolsó delegálás: 2026. 09. 29. 12:44
```

- **Ingyenes láncon** = a kérés a `MODEL_PRICES` tábla **nulla árú** sorára esett
  (a helyi fallback proxy `worker` route-ja és a lánc tagjai). Ez a valódi
  megtakarítás: `freeSavingsUsd = free.baseline − free.cost`.
- **Fizetős route-on delegálva** = a gyermek delegálva is a fizetős úton futott
  (jellemzően mert a proxy állt, vagy explicit modellt kapott). Ez **nem**
  megtakarítás: ugyanannyiba kerül, mintha a szülő végezte volna.
- Az **utolsó delegálás** ideje azért van a sorok között, hogy egy régi adat ne
  tűnjön beégett számnak: ha hetek óta nincs delegálás, a panel ezt kimondja.
- A szám akkor mozdul, ha **tényleg történik delegálás**: a lánc önmagában nem
  indít munkát (az ütemezett retune/watchdog szkriptek nem hívnak `subagent`
  toolt). Ezért a `standard-free` preset **delegálási irányelvet** kap a
  persona-sávban: a fő modell feladata, hogy a szeparálható munkát (felmérés,
  többfájlos keresés, napló/adat-pásztázás, állítás ellenőrzése, független
  review, párhuzamosítható darabok) leadja a gyermeknek. Enélkül a felület
  egész napos használata is **nulla ingyenes kérést** termelhet (mért eset:
  FELJEGYZES 12.). A gyermekek route-ját a
  `providers\check-delegation-route.mjs` mutatja meg napra/hétre visszamenőleg.
- **Fontos:** a GUI-ból indított gyermek csak akkor megy az ingyenes láncra, ha
  a beszélgetés a `standard-free` preseten fut (a web profilban a `tool-subagent`
  sor a presetből jön, és a standard presetben nincs `agentOptions` — ilyenkor a
  gyermek a szülő fizetős route-ját örökli). A delegálási irányelv a persona-sáv
  része, ezért **csak a telepítés után indított beszélgetésekben** érvényes.
  Telepítés és alapértelmezetté tétel:
  `node providers\install-free-preset.mjs --apply --default`; részletek:
  `providers\README.md`.

A régi, egyetlen összevont „Delegált költség / baseline" sor csak akkor jelenik
meg, ha a host fél még a régi (nincs benne a `free`/`paid` bontás), hogy a
tooltip ilyenkor se hazudjon.

#### Automatizált (headless) futások — külön csatorna

A DSH headless futása **mindig** létrehoz egy sessiont a munkakönyvtárában, a
DSH pedig induláskor minden ilyen könyvtárat külön munkaterületként csoportosít.
Ha a futás a projekt könyvtárából indul, a session a projekt sávjába kerül —
2026-09-27-én a delegálás-tesztek 9 sessionje így szórta tele a listát.

Ezért az automatizált futások **saját könyvtárból** indulnak (`.automation`),
amit a host külön munkaterületként ismer:

```powershell
# egy automatizált feladat, a saját csatornájában (a jelentés fájlba is mehet)
.\providers\run-headless-task.ps1 "Report the current date using the pwsh tool." `
    -ReportDirectory .\providers\reports

node providers\session-channel.mjs              # riport: mi szemetel a listán
node providers\session-channel.mjs --channel    # a csatorna regisztrálása
node providers\session-channel.mjs --hide       # a gépi futások elrejtése
```

Az elrejtés **archiválás**, nem törlés: a session eltűnik a sávból és a
keresésből, de a naplója a helyén marad, ezért a 30 napos statisztika továbbra
is számol vele. Az archiválás a **futó** host registry-ében történik
(`POST /ui-extras/workspace-session`), mert a `storages/workspace.json`-t a DSH
csak induláskor olvassa — kézi fájlszerkesztést a host felülírna.
Visszahozás: `node providers\session-channel.mjs --unhide --ids <id,...>`.

## Hibakeresés

| Tünet | Magyarázat / megoldás |
|---|---|
| Az ablak „Nem indult el a DeepSeek Harness” lapot mutat | A napló megmondja az okot: tálca → **Naplók megnyitása** (`state\window.log`) |
| „Nem találom a dsh CLI-t” | `npm install @deepseek-ai/dsh` a könyvtárban, vagy add meg a tálca **dsh elérési út…** menüjében |
| A port foglalt | Tálca → **Port beállítása…**, majd **Újraindítás** |
| Az ablak nem nyílik meg | Ellenőrizd a `state\window.log`-ot; a WebView2 futtatókörnyezet a Windowshoz tartozik |
| Az ikon nem frissül | Tálca → **A tálca újraindítása**, vagy `tools\restart-tray.cmd` |
| Az ablak a képernyőn kívülre került (monitorcsere után) | `.\bin\DshLauncher.exe --reset-geometry` — törli a mentett pozíciót, az ablak középre kerül. (Kézzel ugyanez: a `state\window-geometry.txt` törlése.) |
| Nem tudod, milyen kapcsolói vannak az indítónak | `.\bin\DshLauncher.exe --help` — **MessageBoxban** jelenik meg, mert az indító nem konzolprogram |
| Felosztás beállítva, mégis egy panel nyílik | A futó tálca még a régi szkriptet futtatja: **A tálca újraindítása** (`tools\restart-tray.cmd`). Ellenőrzés: `state\tray-config.json` → `panes`, illetve `state\window.log` → `panes: N`. |
| A robot felület eltűnt az ablakból | Tálca → **Ablak felosztása** → pipa a **4. felület: robot panel**-re. A beállítás a `state\tray-config.json`-ba kerül, és a következő ablaknyitáskor lép életbe. |
| Az újraindítás után a robot panel helyére DSH panel kerül (duplikált panel) | A javítás előtti `DshWindow` minden panelen token-figyelőt indított, ezért a robot panelt is a DSH token-URL-jére navigálta. `tools\build-window.cmd`, majd tálca → **Ablak bezárása** + **Megnyitás (ablak)**. |
| A robot panel nem válaszol | `bot\start-robot-watchdog.cmd`, vagy várj 60 mp-et — a tálca automatikusan elindítja az őrfolyamot. Ellenőrzés: `tools\check-servers.ps1`. |
| A robot panel nem váltja a világos/sötét témát vagy a nyelvet a többivel | A panel külön originen fut (4180), ezért a szinkron a **hoston** át megy. A DSH témagombja `theme-sync`-kel szól neki, a panel pedig 10 másodpercenként visszakérdez (`robot-theme`). Ha a host-oldali útvonal még nem él, indítsd újra a szervert (**⭯** vagy `tools\restart-harness.cmd`). |
| A 🤖 panel magyar felirattal jelenik meg angol felületen, vagy fekete marad világos módban | A panel a DSH aktív nyelvét és a `<body data-ds-dark-theme>` jelölést követi; a kliens-bundle a szerver újraindításakor frissül. Frissítés: **⭯** vagy `tools\restart-harness.cmd`, majd a lap újratöltése. |
| Az egyik panel üres / hibás lapot mutat | `state\window.log`: `webview2 init failed (pane N)` sor. A panel saját profilja `state\webview2\pane-N`; ha zárolt maradt (kilőtt ablak), az indulás időbélyeges testvérmappára vált. |
| Egy panel „elfelejtette” a munkaterületét | A panel profilja zárolva volt az induláskor (egy korábbi ablak kilövése), ezért friss profilra váltott. A következő nyitáskor visszatér; tartós nullázáshoz töröld a `state\webview2\pane-N` mappát. |
| „Újracsatlakozás…” felirat és nem múlik el | A lap a régi belépési tokent tartja. Az ablak 4 másodpercenként figyeli a friss tokent (`state\harness.url` és a szerver naplója), és magától átnavigál rá — ehhez az ablaknak a **legfrissebb `bin\DshWindow.exe`-vel** kell futnia. |
| A sárga hozzájárulás-kártyán nincs „Mindig” gomb | A plugin host fele még a régi (a route csak újraindítás után él). Indítsd újra a szervert a **⇪** vagy **⭯** gombbal. Ha utána sem jelenik meg, a `state\ui-extras-client.log` megmondja, miért. |
| A felület „lefagy” (nem lehet gépelni, kattintani) | Először nézd meg a `state\ui-extras-client.log` végét: a `main thread stalled` sor megmutatja, mikor és mennyi ideig blokkolt a lap. Ha ott nincs ilyen sor, a fagyás nem a lap JavaScriptjében van (tipikusan egy natív ablak, pl. a mappaválasztó dialógus tartja magánál a bevitelt) — ilyenkor a folyamat kilövése/az ablak újraindítása a kiút. |

### Szerver újraindítása — bárhonnan, a tálcán át

A harness újraindítása **megszakítja** azt a folyamatot, amely őt kiszolgálja.
Ezért a `tools\restart-harness.ps1` **nem maga** végzi el a munkát: a kérést átadja
a **rendszertálca ikonnak**, amely az egyetlen folyamat a DSH folyamatfáján kívül
(a bejelentkezéskor indul, saját mutexszel). Így az újraindítás **bárhonnan**
indítható — a DSH termináljából, a Web UI-ból vagy normál ablakból —, és nem
szakadhat félbe.

```
bármely hívó  ─▶  fut a tálca?  (state\tray.heartbeat friss)
                    ├ igen ─▶ state\restart-request ─▶ a TÁLCA végzi el
                    ├ nem  ─▶ elindítja a tálcát, majd az előző ág
                    └ nem indítható ─▶ WMI-vel leválasztott másolat
minden út végén: friss token a state\harness.url fájlba (ATOMIKUSAN írva)
```

* **⇪ élesítés** (Web UI) — a host beírja a profil-patch-et, majd újraindítást kér.
* **⭯ újraindítás** (Web UI) — ugyanez patch-írás nélkül.
* **Tálcaikon → Újraindítás** — közvetlenül a tálcából.
* **`tools\restart-harness.cmd`** — kattintható; mindegyik út ugyanoda fut.

```powershell
.\tools\restart-harness.cmd            # a tálca végzi el (ajánlott)
.\tools\restart-harness.cmd -NoWait    # csak a kérést adja le, nem vár
.\tools\restart-harness.cmd -Force     # a tálcát kihagyva, WMI-vel
.\tools\check-servers.ps1              # állapot: harness, robot panel, tálca-életjel, token
```

> **Miért nem `-Detached`?** A korábbi verzió egy rejtett PowerShell-másolatot
> indított — de az is a hívó folyamatfájában maradt, ezért a DSH
> `taskkill /F /T`-je azt is elvitte. Mért hiba (2026-10-02): a friss token nem
> íródott ki (a `state\harness.url` 74 byte helyett 3 byte lett), a tálca a régi
> tokent olvasta, és önjavítással újraindította a szervert. A `-Detached` ezért ma
> **belső** kapcsoló (a leválasztott másolat használja), nem felhasználói opció.
>
> **Ha nincs futó tálca**, a szkript **megáll** (exit 3), és nem nyúl a
> szerverhez: a saját út első lépése a régi szerver leállítása, és ha a hívó
> folyamatfájával együtt az is meghal, a harness **leállva marad**. Ez rosszabb,
> mint egy félbemaradt token — ezért a saját út csak `-Force`-szal indul.

A belépési pontok, az állapotfájlok és a hibaelhárítás teljes leírása:
[`docs/UZEMELTETES.md`](docs/UZEMELTETES.md).

### Fontos a WebView2 ablak futtatásához

A WebView2 saját böngészőfolyamatot indít. Ez **normál Windows-asztali
környezetben** (amikor te indítod a tálcát) működik. **Korlátozott
környezetben** – például ha a DSH agent a saját sandboxából indítja a tálcát –
a böngészőfolyamat nem tud elindulni, és a `state\window.log`-ban ez látszik:

```
webview2 init failed: ... E_UNEXPECTED
```

Ez nem hiba a beállításban: a tálcát és az ablakot a Windowsból (dupla
kattintással vagy bejelentkezéskor) kell indítani, nem egy sandboxolt folyamatból.

## Újrafordítás

Ha módosítod a `src\DshWindow.cs`-t:

```powershell
.\build.ps1
```

A fordításhoz a Visual Studio 2022 Build Tools Roslyn `csc.exe`-jét és a benne lévő
WebView2 assembly-ket használja – nincs szükség .NET SDK-ra vagy internetre.
Figyelem: a `bin\DshWindow.exe` nem fordítható újra, amíg egy példány fut belőle.
Ilyenkor a `build.ps1` a `bin\DshWindow.exe.new` fájlt készíti el; **futó ablak
mellett** így telepíthető (a futó példány a régi fájlt használja tovább, és a
következő ablaknyitás már az újat):

```powershell
Move-Item bin\DshWindow.exe bin\DshWindow.exe.old -Force
Move-Item bin\DshWindow.exe.new bin\DshWindow.exe -Force
```

## Kiadási csomagok készítése

```powershell
.\tools\build-installer.ps1        # dist\ alá: portable ZIP + telepítő EXE
.\tools\release.cmd                # verzió + commit + tag + push + GitHub Release
```

A csomag **csak a git által követett fájlokat** tartalmazza, ezért a `state\`,
a `node_modules` és minden titok kimarad belőle. Kiadás előtt:

```powershell
node tools\audit-secrets.mjs       # titok- és személyesadat-audit (fában ÉS előzményben)
node tools\check-plugin.mjs        # plugin-integritás
```

## Licenc

MIT — lásd [`LICENSE`](LICENSE). Copyright (c) 2026 **Varga Sándor (svandor)**.

Szabadon használható, módosítható és terjeszthető, a szerző nevének és a
licencszövegnek a feltüntetésével. A szoftver „adott állapotában" érhető el,
garancia nélkül.

## Kulcsszavak

DeepSeek Harness · Windows 11 tálcaalkalmazás · WebView2 natív ablak · magyar
felület · ingyenes LLM fallback · Groq · NVIDIA NIM · OpenRouter · Ollama ·
subagent-delegáció · helyi AI-ügynök · asztali AI-asszisztens · MIT licenc

**Keywords (EN):** DeepSeek Harness · Windows 11 tray app · WebView2 native
window · Hungarian UI localization · free LLM API fallback · Groq · NVIDIA NIM ·
OpenRouter · Ollama · subagent delegation · local AI agent · desktop AI
assistant · MIT licence

