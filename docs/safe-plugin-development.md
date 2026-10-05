# Biztonságos plugin-fejlesztés (DSH UI-bővítések)

Ez a jegyzet azt rögzíti, **hogyan fejlesztünk úgy, hogy az éles DSH felület ne
tudjon megbénulni**. Két alkalommal a saját plugin-bejegyzés megbuktatta a bootot
(„Failed to load plugins”), és a helyreállítás az npx cache törlését igényelte —
ezt a mellékhatást meg kell előzni.

## Mi történt (a két hiba tanulsága)

| Hibaüzenet | Ok | Megoldás |
|---|---|---|
| `dsh-ui-extras: pending (waiting for services: @deepseek-ai/...)` | a kliens-plugin `inject` listájában **csomagneveket** adtam meg | a kliens-szolgáltatásokat **rövid szolgáltatásnévvel** kell kérni, pl. `["slots"]` |
| `cannot get property "slots" without inject` | az `inject` üres volt, a `apply` mégis `ctx.slots`-ot használt | ugyanaz: fel kell venni a `"slots"` szolgáltatást |

A működő minta (`dsh-client-ui-goal`):

```js
const inject = ["slots", "sessions", "remote", "locale", "uiConversation"];
```

## A biztonságos munkafolyamat

### 1. Izolált teszt-környezet (az éles profil érintése nélkül)

```
.test-dsh-home\
  profiles\
    node_modules   -> junction az éles profil node_modules-ára
    web\
      package.json          (az éles profil package.json másolata)
      pnpm-workspace.yaml
      cordis.yml
      cordis.patch.yml      <- csak a saját plugin sorával
```

A dombornyomott plugin-csomag egy junction-nel kerül a **közös**
`profiles\node_modules`-ba, így az izolált és az éles profil ugyanazt a kódot
látja. A teszt harness **külön porton** fut (pl. 3081):

```powershell
.\tools\test-harness.ps1        # izolált harness indítása + boot-ellenőrzés
```

A szkript kiírja, hogy a boot rendben van-e, és hogy a plugin benne van-e a
`window.__DSH_BOOT__` gráfban. **Csak akkor szabad az éles profilba tenni, ha itt
már zöld.**

### 2. Konfiguráció-ellenőrzés indítás előtt

```powershell
$env:DSH_HOME = "C:\Szerver\Deepseek Harness\.test-dsh-home"
node "<dsh>\lib\bin.js" web --dump-config | Select-String ui-extras
```

Ez a plugin-fát **indítás nélkül** építi fel: a hibás bejegyzés itt látszik.

### 3. Élesítés — mindig helyreállítási tervvel

Az éles profilba való beírás előtt:

```powershell
# mentés
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" `
          "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.bak" -Force
```

Ha a felület megbukik, **ezt kell futtatni** (nem kell semmit újratelepíteni):

```powershell
.\tools\recover-harness.ps1
```

A szkript:
1. kiüríti a profil `cordis.patch.yml` fájlját (a saját bejegyzések kikerülnek),
2. leállítja a portot figyelő folyamatot,
3. friss harness-t indít a **meglévő** dsh telepítésből,
4. kiírja az új tokenezett URL-t, amit a böngészőben meg kell nyitni.

Ez **soha nem nyúl az npx cache-hez**, és a beépített funkciókat nem érinti.

## Jelenlegi állapot

- `dsh-ui-extras` csomag: `plugins\dsh-ui-extras\` (host fél: `lib\index.js`,
  kliens fél: `lib\client.js`)
- Ellenőrző szkriptek (mindegyik mentés nélkül, gyorsan fut):
  - `node tools\check-plugin.mjs` — szintaxis, nyelvi csomag kulcsai, hiányzó függvények,
    és a bundle betöltése „fake” modul-hostba: a locale-olvasókat a valódi
    `getLocale()` snapshot-alakjával (`{active, locales, revision}`) szemben
    ellenőrzi — ez a fajta hiba (a snapshotot sima szövegként olvasni) statikusan
    láthatatlan, és pont ez adta a rossz nyelvgombot
  - `node tools\check-approvals.mjs` — a megjegyzett hozzájárulások típus-levezetése,
    illesztése és a host-oldali answerer (a valódi szabályfájlt menti/visszaállítja)
  - `node tools\check-usage.mjs` — a költség-motor: a csúcs/völgyidőszak ablakok
    (hétköznap 01:00–04:00 és 06:00–10:00 UTC, **hétvége és kínai ünnepnap
    nélkül**), a hivatalos ártábla (Flash/Pro, völgyidőszak = fél ár), a
    **valódi** session-naplókon futó 30 napos összesítés (a zstd-naplók
    frame-enkénti olvasása nélkül az eredmény csendben nulla lenne), valamint a
    delegált munka **ingyenes/fizetős bontása** (a zsebek összege, a nulla árú
    lánc költsége, a modellenkénti jelölők)
  - `node tools\check-workspace-session.mjs` — a session-csatorna host route-ja
    hamis workspace-registry-vel: archiválás (részleges hiba esetén is),
    visszahozás (a sorrend érintetlenül), csatorna-regisztrálás, hiányzó
    registry / path / action. Ez az egyetlen kód, amely a **futó** host
    registry-ébe ír, ezért a hibái nem kozmetikaiak
  - `node tools\probe-terminal.mjs [port] [projektút]` — a **futó** harnessen,
    headless Edge + DevTools protokollal: kiválasztja a megadott projektben futó
    sessiont, megnyitja a jobb oldali „Terminálok” fület, és a panel saját DOM-jából
    ellenőrzi, hogy (a) a kiírt munkakönyvtár a session `cwd`-je és nem a harness
    saját könyvtára, (b) a projekt mentett gyorsparancsai (és a `package.json`
    npm scriptjei) látszanak, (c) magától elindult egy interaktív terminál,
    (d) a kimenet a **végén** áll és ott is marad, (e) a kártya a munkakönyvtárat
    a kimenet felett, a könyvtár sorában **állapot-szöveg és sorszám nélkül**
    mutatja (a sorszám a fejlécben van, a küldés gomb pedig ikon + tooltip),
    (f) a betűtípus monospace, végül (g) a Ctrl+C megszakítja a futó parancsot — ehhez **saját** terminált indít és markerrel
    azonosítja, hogy soha ne állítson le olyan folyamatot, amit nem ő indított.
    A javítás előtt pont ez a három bukott el: a panel a harness könyvtárában
    futtatta az `npm run dev`-et, mert a munkakönyvtárat a host `process.cwd()`-jéből
    vette a kiválasztott session `cwd`-je helyett.
- Az izolált teszt **zöld**: a boot betölt, a plugin szerepel a boot gráfban
  (`dsh-ui-extras/client.js` a `/plugins/??...&rev=...` listában)
- Böngészős próbák (a host nem látja a böngészőt, ezek nélkül a kliens-hibák
  láthatatlanok). A sandbox az Edge IPC-csatornáit blokkolja, ezért ezek
  szélesebb jogosultsággal futnak:
  - `.test-dsh-home\probe-edge.ps1` — headless Edge + `--dump-dom` az izolált
    harnessen (boot, konzol, nyelvi csomag)
  - `.test-dsh-home\probe-hero.mjs` — Edge a DevTools protokollon át: betölti a
    lapot, rákattint az „Új beszélgetés” gombra, és megnézi a blank (hero) fázis
    DOM-ját; `--add-workspace <út>` kapcsolóval futó lapon ad hozzá workspace-t,
    és másodpercenként méri, hogy a fő szál válaszol-e (így a néma fagyás is
    kimutatható)
- Debug-fogantyú a lapban: `?dsh-ui-extras-debug=1` **vagy**
  `localStorage['dsh-ui-extras.debug']='1'` + újratöltés hatására
  `window.__dshUiExtrasDebug` (a kliens `ctx`, `createWorkspace`, `phase`,
  `counters`). A shell a boot során kitakarítja az URL-t, ezért a query-paraméter
  nem mindig ér el a bundle-ig — a localStorage-kapu ezért van.
- Minden megjelenített idő **magyar helyi idő** (Europe/Budapest): a
  „váltás …” visszaszámlálás és a csúcsidő-ablak is. Az ablak a UTC-hez van
  rögzítve, ezért a helyi órák a nyári/téli időváltásnál elmozdulnak — a
  megjelenített szöveget ezért számoljuk (`peakWindowsLocalText`), nem
  beírjuk.
- A watchdog 5 másodpercenként pontosan időzít: ha a fő szál hosszabban
  blokkolódik, a `state\ui-extras-client.log`-ba `main thread stalled` sor kerül
  (enélkül egy néma fagyás semmilyen nyomot nem hagy).
- Az éles profilba telepítés **megtörtént** (a `cordis.patch.yml` tartalmazza a
  `ui-extras` bejegyzést); a host fél új verziója csak szerver-újraindítással
  töltődik be.
- **A commit-üzenet nyelve munkaterületenként** (2026-10-05, javítva): a Git
  panel HU/EN kapcsolója nem a felület nyelvét és nem is az egész Harness
  beállítását állítja, hanem a **munkaterületét**: a választás a
  panel-tördelésbe kerül (`state\panel-layout.json`, `commitLang` kulcs,
  `/ui-extras/layout`), ezért ugyanabban a felületben az egyik nyílt projekt
  angol, a másik magyar commit üzenetet kaphat. Korábban egyetlen `localStorage`
  kulcs (`dsh-ui-extras.gitCommitLang`) tartotta — az minden munkaterületre
  ugyanaz volt, ráadásul minden ablakgeneráció friss WebView2-profilt kap, ezért
  a választás elveszett. Mentett érték nélkül a nyelv az aktív felületi nyelvet
  követi (`auto`).
- **Delegálás a statisztikában** (2026-09-30): a `/ui-extras/usage` válasz
  `delegated` blokkja két zsebre bomlik (`free` = nulla árú lánc, `paid` =
  delegálva is fizetős route), plusz `freeSavingsUsd`, `models` bontás és
  `lastAt`. A kliens ezt külön sorokban mutatja, és visszaesik a régi összevont
  sorra, ha a host fél még a régi. Ellenőrzés: `node tools\check-usage.mjs`.
- **Session-csatorna** (2026-09-30): `GET/POST /ui-extras/workspace-session` a
  host félen (`archive` / `unarchive` / `workspace`). Ezzel lehet a sávból
  elrejteni a gépi futások session-jeit és külön munkaterületet regisztrálni a
  `.automation` könyvtárnak — a `storages\workspace.json` kézi szerkesztése
  hatástalan, mert a DSH azt csak induláskor olvassa. Kliens-oldali pár:
  `providers\session-channel.mjs`, `providers\run-headless-task.ps1`.
  **FIGYELEM:** a `workspaceRegistry` szolgáltatást a route lustán kéri
  (`ctx.get`), ezért a plugin olyan profilban sem hal el, ahol az nincs meg.
- **A terminál panel munkakönyvtára** (2026-09-28, javítva): a panel a
  munkakönyvtárat a **kiválasztott session `cwd`-jéből** veszi
  (`ctx.sessions.list.getSnapshot().current` → `byId[id].cwd`), mert a jobb oldali
  fül teste session nélkül mountol, az injektált prop pedig a regisztráció
  pillanatában `null` — a host `/ui-extras/workspace` válasza csak az utolsó
  tartalék, és addig sem használható, amíg a session-lista nem válaszolt (különben
  a rossz projekt parancsait listázná). A kiválasztás 150 ms-onként (majd 1 s-onként)
  újraolvasódik, ezért a panel követi a beszélgetésváltást.
  - A gyorsparancsok perzisztálása **workspace-kulcsos**
    (`state\runnables.json`), ezért a rossz munkakönyvtár nem csak futtatási hibát
    (`ENOENT … package.json`), hanem „eltűnt mentett parancsokat” is okoz: a
    mentés a rossz projekt kulcsa alá került.
  - A panel automatikusan indít **egy** interaktív shellt, ha a projektben még
    nincs futó terminál (a hostot külön megkérdezi, így két panel nem indít
    kettőt); a `docked` fül és a láthatóság is feltétel.
- **A terminál kártya használhatósága** (2026-09-28, javítva). Ezek a
  viselkedések méréssel lettek megállapítva, ezért nem szabad visszavenni őket:
  - A kimenet **mindig a végét mutatja**: a `useEffect` a `terminals` térképre
    kötve a DOM utáni scroll-t állítja (`scrollTop = scrollHeight`), és a
    fejléc `⤓` **követés ikonja**, valamint a felfelé görgetés kapcsolja a
    követést.
  - A **munkakönyvtár** a fejléc és a kimenet között, saját sorban van (teljes út
    a tooltipben) — a kimenet nem takarhatja. Ebben a sorban **nincs** állapot
    és sorszám: az állapot a fejléc **színes pöttye** (sárga = fut, zöld/piros =
    kilépett), a **sorszám a fejlécben** a parancs mellett, minden gomb pedig
    **ikon + tooltip** (nincs „Küldés” felirat).
  - A kimenet és a parancssor **monospace**, alapértelmezés 12 px, és a
    fejléc választóival állítható (lásd lentebb).
  - A **bemeneti mező** kényelmes (5 px függőleges belső margó + 18 px
    sormagasság) — a „lapos” mező padding-hiba volt, nem stílus.
  - A **terminál ablak magassága egérrel húzható**: a kimenet alatti vékony sáv
    (`data-dsh-ui-extras="cmd-resize"`) pointer-dragje a kimenet magasságát
    állítja (80 px … a viewport 90%-a), és a méret a workspace-layout-ban
    (`height:<runId>`) **megmarad**; dupla kattintás az alapméretre állít vissza.
    A dupla kattintást a **pointer-eseményeken** kell figyelni, nem React
    `onDoubleClick`-kel: a `pointerdown` `preventDefault()`-ja elnyeli a
    kompatibilitási egér-eseményeket, így a böngésző nem szintetizál `dblclick`-et
    (mérve: emiatt nem állt vissza a méret).
  - Az aktív terminál jelölése **visszafogott** (halvány fehér keret), nem
    élénk kék.
  - **ANSI-kezelés**: a panel NEM színez (nem tty), ezért az
    escape-szekvenciákat **kiszedi** (`stripAnsi`), a `\r`-t pedig **sor
    felülírásaként** kezeli (`ingestTerminalText`: kész sorok + függőben lévő
    farok). Mérve: a Vite színes sora korábban `[32m`-szerű négyzetekként jelent
    meg, a progress-sorok pedig ismétlődtek. A gyökeret is kezeltük: a
    Laravel-projekt `vite.config.js`-ében `server.colors: false`, hogy a naplóba
    már eleve ne kerüljön színkód (a Vite-ot újra kell indítani hozzá).
  - A **sorszám** a fejlécben a TELJES hosszt mutatja (a függőben lévő sorral
    együtt), és ha a puffer hosszabb a kirajzolt 400 sornál, a kimenet elején
    „⋯ korábbi sor elrejtve: N sor” jelzés áll — a néma csonkolás a „megállt a
    parancs” látszatát kelti.
  - **Betűtípus- és betűméret-választó** a kártya fejlécében (`Aa`, illetve
    `A±`, mindkettő **ikon + tooltip**, a tooltip az aktuális értéket mutatja).
    A választás `localStorage`-ban él (`dsh-ui-extras.terminalFont`), mert a
    betű a felhasználóról szól, nem a projektről, és a kimenetre ÉS a
    parancssorra is érvényes.
  - A bemeneti mező **billentyűparancsokat kezel**: `Ctrl+C` megszakít,
    `Esc` törli a sort (`0x1b`), `Ctrl+D` bemenet-vége (`0x04`); szövegkijelölés
    esetén a `Ctrl+C` marad a böngésző „másolás”.
  - **Leállítás = a teljes folyamatfa.** Mérve: a `child.kill()` csak a shellt
    viszi el, az `npm run dev` és a Vite tovább fut és fogja a portot; a bemenetre
    írt `0x03` a natív gyermeket **nem** szakítja meg. Ezért a host
    `taskkill /F /T`-t futtat, előtte felméri a leszármazottakat
    (`descendantPids`), és a fa-járás után életben maradt orphanokat PID szerint
    is kilövi. A `tools/check-plugin.mjs` ezt egy valódi natív unokafolyamattal
    ellenőrzi („the stop ends the native grandchild too”).
  - **Ismert korlát**: egy MÁR létező, a javítás előtt indított orphan
    (`npm run dev` a shell halála után) a panelről nem állítható le, mert a host
    nem látja a szülő nélküli folyamatot. Ilyenkor a terminált újra kell indítani
    (a panel a javított hosttal már a fát is viszi).
  - **Munkaterület-izoláció**: a host `action=runs` az ÖSSZES futást visszaadja,
    ezért a kliens a `run.workspace` alapján **szűr** (a `refreshRuns` bele sem
    teszi, a takarítás ki is dobja az idegent). Enélkül a másik projekt dev
    szervere itt látszott, mintha ebben a könyvtárban futna.
  - **Alapmagasság**: a kimenet alapból `170px` … `22vh` (docked), nem `46vh` —
    két terminál is elfér egymás alatt; a húzás és a `⤢` nagyítja.
  - **A bemeneti mező alapból REJT** (`type=password`), mert a `sudo`/`ssh`/`git`
    jelszókérés ugyanezen a mezőn jön be, és nincs általános mód annak
    felismerésére, hogy egy prompt titkos. A 🙈/👁 gomb mutatja/rejti (a választás
    `localStorage`-ban marad), és ha a kimenet utolsó sorai jelszóra utalnak
    (`password`, `passphrase`, `jelszó`, `token`, …), a mező kerete sárgára vált és
    a placeholder erre figyelmeztet.

## Következő lépések

1. A statisztika panel valódi adatai: `ctx.slots` + session-vetületek
   (`tokenUsage`), a `dsh-client-ui-chat` belső exportjain keresztül.
2. A panel áthelyezése a jobb oldali sávba (`sidebar.right.pane.tab`) vagy
   dedikált sávba a 32:9-es kijelzőhöz.
3. Git / SSH / terminál panelek: először host-oldali plugin (Node-ban fut, a
   `shell`/`fs` szolgáltatásokkal), utána kliens-oldali megjelenítés.
