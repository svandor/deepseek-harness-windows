# Házirobot

Helyi, mindig futó ügynök a DeepSeek Harness mellett. Ez váltja ki a Cursor
előfizetéshez adott **Grok Bot**-ot: ugyanaz a munkaminta (bejelentkezik a
weboldalakba, ütemezetten dolgozik, jóváhagyást kér, visszajelez), de **a saját
gépen**, `$0` előfizetéssel, és az adat nem hagyja el a gépet.

**Avatar:** a robotnak **14 alteregója** van a
[`bot/avatar/alteregok/`](avatar/alteregok/) mappában — a panel fejlécében a
képre kattintva (vagy a DSH panel **Alteregók** fülén) váltható, és
**automatikus váltogatás** is beállítható. Az alapértelmezett a
**Gyuszi (a valódi)**: műanyag papírkosár a fej, bádogkuka a test, hosszú konyhai
páraelszívó flexicső a karok. A `klasszikus` alteregó a régi, fehér robot
([`avatar/hazirobot.svg`](avatar/hazirobot.svg)), amely a *Magyarok az űrben
1. rész* (Dik Tafon, 2013) 6:10–6:40 közötti képkockájából mintázva készült. A
teljes készletről [áttekintő kép](avatar/alteregok/attekintes.png), a rajzolási
szerződés a [`BRIEF.md`](avatar/alteregok/BRIEF.md), a további ötletek és a
rendszer leírása: [`docs/ALTEREGO-TERV.md`](../docs/ALTEREGO-TERV.md).

---

## 1. Architektúra

```
  TRIGGER                RUNNER                      TOOLOK                KIMENET
┌──────────────┐   ┌────────────────────┐   ┌────────────────────┐   ┌──────────────┐
│ Task Sched.  │──▶│ bot/run-job.mjs    │──▶│ Playwright (CDP)   │──▶│ riport (.md) │
│ webhook      │──▶│ <modul>/flow.mjs   │   │ HTTP/fetch, pwsh   │   │ E-MAIL (fő)  │
│ panel        │──▶│  (15 percenként)   │   │ SQLite (dedup)     │   │ panel        │
└──────────────┘   └────────────────────┘   └────────────────────┘   └──────────────┘
```

Három réteg, és a legtöbb lépésben **nulla token**:

| Réteg | Mi végzi | Költség |
|---|---|---|
| **1. Determinisztikus** | Node/PowerShell/Playwright, HTTP, SQLite, Excel | **$0** |
| **2. Ingyenes modell** | a helyi proxy `fast-chat` route-ja (Groq/NVIDIA/OpenRouter free → Ollama) | **$0** |
| **3. Fizetős modell** | DeepSeek off-peak (kézzel, ritkán) | mért |

**Kemény szabály:** a személyes adatot érintő job **soha** nem használ felhős
modellt. Ott minden lépés determinisztikus, vagy helyi.

---

## 2. Gyors start

```powershell
cd "C:\Szerver\Deepseek Harness\bot"

node run-job.mjs list          # elérhető jobok
node run-job.mjs check         # job-definíciók ellenőrzése
node run-job.mjs due           # a most esedékes jobok futtatása
node run-job.mjs pelda-oldalfigyelo --dry-run   # egy job próbafuttatása

node panel/server.mjs --port=4180          # webhook + állapotpanel
#   -> http://127.0.0.1:4180/

node --test --test-isolation=none tests/rules.test.mjs   # 20 szabályteszt
```

Telepítés (ütemezett feladat + startup panel) — **PowerShell-ablakban begépelve**:

```powershell
.\install-hazi-robot.ps1            # telepítés + ellenőrzés
.\install-hazi-robot.ps1 -Remove    # eltávolítás
```

> A `.ps1`-et **nem lehet dupla kattintással futtatni** ezen a gépen (nincs
> alkalmazás-társítás): az „Alkalmazás kiválasztása" ablak jön. Nyiss
> PowerShellt a `bot` mappában (Shift + jobb klikk → *Open PowerShell window
> here*), és **gépeld be** a parancsot.

> A DSH sandboxából a feladatregisztrálás `Access denied`-del elhal (mért érték:
> `New-ScheduledTaskAction : Access denied`), és a Startup parancsikon sem
> írható — ezért kell külön ablak (rendszergazdai, ha a normál nem engedi).

> **A panelt NE indítsd a DSH sandboxából.** Mért hiba (2026-10-01): a
> tool-hívásból indított folyamat **a hívás végén meghal**. A panel elindul és
> kiszolgál (`GET /status.json` → `HTTP 200`), majd néhány másodperccel a hívás
> befejezése után eltűnik. Mivel a `bot.log` csak a saját eseményeit írja, a
> halál **naplóbejegyzés nélkül** történik — összeomlásnak látszik, holott
> kilövés. Mért bizonyíték: a `state/panel.err.log` **üres** maradt, a folyamat
> pedig a hívás után nem élt.
>
> Ez a „nem válaszol a robot" tünet legvalószínűbb oka: a böngésző `Failed to
> fetch`-et ír, mert a panel szervere már nem fut.
>
> **Helyes indítás** (a sandboxon KÍVÜL): a Startup parancsikon
> (`HáziRobot panel.lnk`), vagy `.\install-hazi-robot.ps1` normál
> PowerShell-ablakból. Ha mégis sandboxból indítod, a robot csak addig
> válaszol, amíg az adott DSH-munkamenet él.
>
> **A panelnek VAN őrfolyama** (`watchdog-hazi-robot.ps1`, 60 s ciklus),
> ugyanazzal a mintával, mint a proxyé.
>
> **Indítás — dupla kattintással, nem PowerShell-paranccsal:**
>
> ```
> start-robot-watchdog.cmd      <- ezt kattintsd (a panel is elindul vele)
> robot-status.cmd              <- ez csak megmondja, fut-e minden
> ```
>
> ⚠️ **A `.ps1` fájlt NE kattintsd duplán ezen a gépen.** A `.ps1` nincs
> társítva egyetlen alkalmazáshoz sem, ezért a dupla kattintás az
> *„Alkalmazás kiválasztása"* ablakot nyitja a futtatás helyett. Ezért van
> minden futtatható belépési pontnak `.cmd` burkolója (itt és a `providers/`
> mappában is: `run-proxy.cmd`, `run-retune.cmd`).
>
> Mért eredmény (2026-10-01): a panel szándékos leállítása után a ciklus
> **3 másodperc** alatt helyreállította (`KIESES` → `HELYREALLITVA` a
> `state/robot-watchdog.log`-ban), és a helyreállított panel a `/allapot`
> parancsra helyesen válaszolt.
>
> Az őrfolyam **a proxyt is figyeli**: ha a panel él, de a fallback proxy (4123)
> nem, azt külön jelzi — az pontosan „nem válaszol a robot" tünetet ad, mert a
> `/parancsok` mennek, a beszélgetés viszont nem.
>
> A `start-robot-watchdog.cmd` elég: az őrfolyam az első körben elindítja a
> panelt is, ha az nem fut. A `HáziRobot panel.lnk` ezzel szemben csak a
> panelt indítja, őrfolyam nélkül — ha az elhal, nem indul újra.
>
> **Kézi indításra a gyakorlatban nincs szükség.** A felügyeleti lánc:
>
> ```
> tálca (tray/dsh-tray.ps1, 20 s-enként: Invoke-RobotEnsure)
>    └─> orfolyam (watchdog-hazi-robot.ps1, 60 s-enként)
>           └─> panel (webhook-server.mjs, 4180)
> ```
>
> A tálca a bejelentkezéskor magától indul, és már eddig is öngyógyította a
> Harness-t; mostantól az őrfolyamot is ellenőrzi (ha elhalt, elindítja).
> Emellett a bejelentkezéskori `HáziRobot panel.lnk` **is** az őrfolyamot
> indítja (átkötve 2026-10-01-én), és az `install-hazi-robot.ps1` is így
> állítja be — így egy újratelepítés sem viszi vissza a csupasz panelre.
>
> Mért eredmény (2026-10-01): az őrfolyam szándékos leállítása után a tálca
> `Invoke-RobotEnsure` függvénye **6 másodpercen belül** visszaindította
> (PID 55604), a panel pedig közben folyamatosan válaszolt.
>
> Ütemezett feladattal **nem** lehetett megoldani: a `Register-ScheduledTask`
> ezen a gépen `0x80070005` (hozzáférés megtagadva) hibával elhal, tágabb
> sandbox-joggal is — ez Windows-jogosultság, nem a DSH korlátja. Ezért a
> tálcára került a felügyelet, mert az már fut.

---

## 3. Jobok — a saját feladataid

A robot **keretrendszer**: a feladatokat a `bot/jobs/` mappa JSON fájljai írják le.
Egy job megmondja, *mikor* fusson, *mi* készítse elő az adatot, *melyik modell*
dolgozza fel, és *mi* legyen a kimenet. A konkrét feladatok viszont
**telepítésenkéntiek** — a repóban csak minta van.

```jsonc
{
  "id": "pelda-oldalfigyelo",
  "leiras": "mit tesz, egy sorban",
  "schedule": { "tipus": "cron", "kifejezes": "0 7 * * 1" },   // vagy {"tipus":"webhook"}
  "csatorna": ".bot",                    // a DSH-munkamenet csatornája
  "preset": "standard-free",             // agent-preset
  "modell": { "route": "fast-chat", "maxTokens": 1500 },
  "eloSzkript": "collect/sajat-gyujto.mjs",  // opcionális: determinisztikus előkészítés
  "prompt": "prompts/sajat-prompt.md",
  "toolAllowlist": ["read"],             // az agent ennyi eszközt kap
  "koltsegKeretUsd": 0,                  // 0 = ingyenes láncon kell maradnia
  "jovahagyasKell": false,               // true = külső művelet előtt jóváhagyás
  "kimenet": ["riport", "email"],
  "megorzesNap": 180
}
```

Indítás kézzel (`node bot/run-job.mjs <id>`), a panel **Állapot** füléről
(**futtat**), vagy a konzolból (`/futtat <id>`).

### 3.1 A három réteg, és a nulla token

| Réteg | Mi végzi | Költség |
|---|---|---|
| **1. Determinisztikus** | Node/PowerShell/Playwright, HTTP, SQLite, Excel | **$0** |
| **2. Ingyenes modell** | a helyi proxy `fast-chat` route-ja (Groq/NVIDIA/OpenRouter free → Ollama) | **$0** |
| **3. Fizetős modell** | DeepSeek off-peak (kézzel, ritkán) | mért |

A legtöbb lépés az 1. rétegben fut: az `eloSzkript` összegyűjti és
normalizálja az adatot, a modell csak az összefoglalót írja meg. Egy
személyes adatot érintő jobot érdemes **végig** az 1. rétegben tartani
(`llmTiltva: true`), mert akkor az adat el sem hagyja a gépet.

### 3.2 A saját feladataid NEM kerülnek a repóba

A `bot/jobs/*.json`, a hozzá tartozó gyűjtők (`bot/collect/`), promptok
(`bot/prompts/`) és integrációs modulok (lásd a 4. fejezetet) **gépenkéntiek**:
a `.gitignore` kizárja őket, és csak a `pelda-*` minták maradnak nyilvánosak.

```powershell
Copy-Item bot\jobs\pelda-oldalfigyelo.json bot\jobs\sajat-feladatom.json
# ... szerkeszd, majd:
node bot\run-job.mjs sajat-feladatom
```

A futások és a riportok a `bot/state/` és a `bot/reports/` alá kerülnek — azok
szintén nincsenek a repóban.

---

## 4. Privát integrációs modulok (gépenkénti)

Ha a robot egy **külső rendszerhez** kapcsolódik (kötelező adatszolgáltatás,
belső API, ügyfélrendszer), azt külön modulba érdemes tenni. A modul a gépen él,
a repóban nem — és a **panel kódja sem tud róla**: mindent a `bot/extensions.json`
leíró mond meg, amely szintén gépenkénti (gitignore-olt).

```jsonc
{
  "integraciok": [
    {
      "id": "sajat-integracio",
      "nev": { "hu": "Saját integráció", "en": "My integration" },
      "webhook": "/webhook/sajat",           // ide érkezik a külső kérés
      "orchestrator": "sajat/flow.mjs",      // ezt indítja a webhook (a bot mappához képest)
      "badge": { "hu": "webhook: /webhook/sajat", "en": "webhook: /webhook/sajat" },
      "chip": { "hu": "Saját napló", "en": "My log", "parancs": "/sajat" },
      "figyelo": "sajat/collect.mjs",        // megjeleníti a figyelt oldalak szekciót
      "figyeloJob": "sajat-oldalfigyelo",    // melyik job tartja a figyelt oldalakat
      "beallitasok": [                        // beállítás-mezők (a config.json-ba írnak)
        { "utvonal": "sajat.callbackUrl", "cimkeHu": "Callback URL", "cimkeEn": "Callback URL" }
      ],
      "titkok": [                             // write-only jelszó-mezők (secrets.json)
        { "kulcs": "sajatTitok", "cimkeHu": "Titok", "cimkeEn": "Secret" }
      ],
      "szemelyiseg": "sajat/agent.md"         // a robot személyiségének végére fűzve
    }
  ]
}
```

A panel és az agent ebből épül:

| Mező | Mit tesz |
|---|---|
| `webhook` + `orchestrator` | a `POST <webhook>` útvonalat regisztrálja, és a modul folyamatát indítja (a kérés azonnal választ kap) |
| `badge` | fejléc-jelvény (a mostani állapot) |
| `chip` + `parancs` | gomb a konzol-gombsorban, és a hozzá tartozó `/parancs` |
| `figyelo` + `figyeloJob` | megjeleníti a **Figyelt oldalak** beállítás-szekciót, és megmondja, melyik job tárolja a listát |
| `beallitasok` / `titkok` | beállítás-mezők a panelen; a titkok soha nem mennek vissza a böngészőbe |
| `szemelyiseg` | a `bot/agent.md` végére fűzött, modul-specifikus munkaszabályok |

Modul nélkül a panel **nem kínál olyan mezőt, ami mögött nincs semmi**: nincs
webhook-útvonal, nincs jelvény, nincs chip, és a beállítások lapon sem jelenik meg
az adott szekció. A keretrendszer — konzol, jobok, avatarok, napló, őrfolyam —
változatlanul működik.

> **Miért így?** Az, hogy a robot **hogyan működik**, közérdeklődésre tart számot;
> az, hogy **ki milyen feladatot** állít be és melyik rendszerhez köti, senki
> másra nem tartozik. Ez a szétválasztás ezt a kettőt választja el: a
> keretrendszer nyilvános, a bekötés privát.
## 5. Panel és avatar

### 5.0 A robot mint 4. felület az asztali ablakban

A DSH ablaka (`DshWindow.exe`) 1–4 egymás melletti felületet tud nyitni
(`--panes N`), mindegyik saját WebView2 profillal, és a **rendszertálcaikon**
váltja őket. A robot ezek mellé kerül **4. felületként**:

- A tálca **„Ablak felosztása"** menüjében új, bejelölhető pont:
  **„4. felület: robot panel"**. Bekapcsolva az ablak 4 felülettel nyílik:
  3 munkaterület + a robot (a munkaterületek száma legfeljebb 3 lesz).
- A robot felület a saját állapotpaneljét tölti be
  (`http://127.0.0.1:4180/`), **nem** a harness klienst — ezért nem foglal
  session-t és nem zavarja a munkaterületeket.
- Az ablak oldalán ezt a `--pane-url <n>=<url>` kapcsoló adja át
  (a `DshWindow.exe` ezt 2026-10-01 óta támogatja).

Telepítés/ellenőrzés:

```powershell
# a robot panel-szerver állandó futása (bejelentkezéskor indul, hiba esetén újraindul)
schtasks /Query /TN "HáziRobot panel" /V /FO LIST
schtasks /Run   /TN "HáziRobot panel"

# az ablak azonnali megnyitása a robottal, a tálcától függetlenül
.\tools\open-window-with-robot.ps1              # 3 munkaterület + robot
.\tools\open-window-with-robot.ps1 -DryRun      # csak kiírja a parancsot
.\tools\open-window-with-robot.ps1 -NoRobot     # visszaállás: csak munkaterületek

# a feladatütemezőből indított változat (a DSH sandboxa kilövi a gyermekeit)
schtasks /Run /TN "HáziRobot ablak"

# az ablak újrafordítása (futó ablak mellett is biztonságos: átnevezi a régit)
.\tools\build-window.ps1
```

A tálca beállítása a `state\tray-config.json`-ban van (`panes`, `robotPane`,
`robotOnly`, `robotUrl`). Bekapcsolt robot felületnél `panes = 3`, és az ablak
4 felülettel nyílik (3 munkaterület + robot).

A tálca **„Ablak felosztása"** menüjében két jelölő négyzet van:

| Menüpont | Hatás |
|---|---|
| **4. felület: robot panel** | a robot a munkaterületek mellé kerül (a munkaterületek száma 3-ra szorul) |
| **Csak robot mód (1 felület)** | az ablak egyetlen felülettel nyílik: teljes szélességben a robot-konzol |

> **Fontos:** a tálca a menüjét **betöltéskor** építi, a „Újraindítás" menüpont
> pedig a *harness szervert* indítja újra — **nem a tálca-programot**. Ezért az
> új „4. felület: robot panel" menüpont csak a **tálca újraindítása** után
> jelenik meg (tálca → *Kilépés (minden leáll)*, majd a kitűzött *DeepSeek
> Harness* ikon). Addig a fenti `open-window-with-robot.ps1` használható.
>
> **A DSH sandboxából indított folyamatok elhalnak** a parancs végén (Win32 Job),
> ezért az ablakot és a panelt **nem** a DSH-ból kell indítani: az ablak a
> `HáziRobot ablak` feladatból (vagy a szkriptből, normál PowerShell-ablakból), a
> panel a `HáziRobot panel` feladatból fut.

### 5.0b Robot-konzol (a 4. felület tartalma)

A robot felülete (`http://127.0.0.1:4180/`) egy **konzol**: itt lehet a robottal
kommunikálni. Fülei: **Konzol** (alap) · Állapot · Beállítások · Napló.

**Konzol fül** — egy beviteli mező, két móddal:

| Bemenet | Mi történik | Token |
|---|---|---|
| `/`-ral kezdődik | **determinisztikus parancs**, a robot azonnal végrehajtja | **0** |
| bármi más | **beszélgetés** a robottal: a modell kérhet akciót, a bot végrehajtja, majd válaszol | ingyenes lánc |

Parancsok (ékezet nélkül is működnek):

```
/állapot            a jobok, az utolsó futások és az integrációs napló
/futtat <job>       egy job azonnali futtatása
/napló [sor]        a napló utolsó sorai
/oldal <név> <url>  figyelt oldal felvétele
/oldalak            a figyelt oldalak listája
/<modul-parancs>    az integrációs napló (a modul leírójából)
/email <cím>        teszt e-mail (JÓVÁHAGYÁSSAL)
/segít              a parancsok listája
```

**A beszélgetés** a robot saját mini-ügynökén megy (`bot/lib/agent.mjs`,
persona: `bot/agent.md`): a modell **nem kap közvetlen hozzáférést** semmihez,
csak akciót kérhet egy szűk protokollon (`AKCIÓ: {...}` / `VÁLASZ: ...`), a
végrehajtás pedig determinisztikus és naplózott. A kockázatos művelet
(`email_teszt`) **jóváhagyás-kártyát** ad a konzolon.

Ez azért fontos, mert így a beszélgetés **nem** futtat DSH-sessiont, nem
használ fizetős modellt, és a személyes adat továbbra sem hagyhatja el a
gépet.

### 5.1 A DSH-ba integrált panel

A `plugins/dsh-hazi-robot` bővítmény egy **🤖 gombot** tesz a beszélgetés
eszközei közé (a fejléc-eszközök sávjába, illetve hero-fázisban a beviteli sáv
fölé). A gomb **csak ikon** — a magyarázat a tooltipben van
(„Házirobot — állapot és beállítások").

A gomb egy **oldalra dokkolt panelt** nyit (nem lebegő ablak): teljes magasság,
a képernyő széléhez simulva, saját fejléccel és fülekkel — mint a munkaterület-
panelek. A fejlécben két gomb van:

| Gomb | Mit tesz |
|---|---|
| **⇄** | átváltja a panelt **jobb és bal oldal** között (a választás megmarad: `localStorage`) |
| **✕** | bezárja a panelt |

A panel fülei:

| Fül | Mit mutat |
|---|---|
| **Állapot** | a jobok (egy kattintással futtathatók), az utolsó 15 futás, az integrációs auditnapló |
| **Beállítások** | **űrlap**: feladó, címzettek, SMTP (host/port/TLS/felhasználó/jelszó), száraz-futás kapcsoló, a telepített modulok beállításai, valamint a titkok (write-only: üresen hagyva nem változnak) |
| **Napló** | a `bot/state/bot.log` utolsó sorai |

A beállítás-űrlap a `bot/config.json`, `bot/secrets.json` és a
a modulhoz tartozó job-fájlba ír (írás előtt `.bak-…` mentéssel); melyik job az, a leíró `figyeloJob` mezője mondja meg.
A **titkok soha nem mennek vissza a böngészőbe**: a panel csak azt jelzi, hogy
be vannak-e állítva, és az üresen hagyott titokmező nem írja felül a meglévőt.

Telepítés (a `~\.dsh` a sandboxon kívül van, ezért normál PowerShell-ablakból):

```powershell
cd "C:\Szerver\Deepseek Harness\plugins\dsh-hazi-robot"
.\install.ps1                 # junction + profil-patch + újraindítás + boot-ellenőrzés
.\install.ps1 -NoRestart      # csak bekötés
.\install.ps1 -Remove         # eltávolítás
```

> A profil-patch (`cordis.patch.yml`) **élőben** újratöltődik: a bekötés után egy
> **böngésző-frissítés (F5)** elég, a DSH szervert nem kell újraindítani.
> Ha a boot elromlik: `.\install.ps1 -Remove`, vagy állítsd vissza a
> `cordis.patch.yml.bak-…` mentést.

A host oldali végpontok: `GET /hazi-robot/status`, `GET|POST /hazi-robot/settings`,
`GET /hazi-robot/avatar.svg?alterego=<id>`, `GET /hazi-robot/alteregok`,
`POST /hazi-robot/alterego`, `POST /hazi-robot/run?job=<id>`,
`GET /hazi-robot/log`.
Ezek a DSH saját munkamenet-hitelesítése mögött vannak (nem külön token).

> **A host fél módosítása szerver-újraindítást igényel** (a profil-patch élőben
> újratöltődik, de a `lib/index.js` új verziója nem): az új alteregó-route-ok
> csak újraindítás után élnek. A kliens félhez elég az F5. Újraindítás:
> `.\tools\restart-harness.cmd` — **bárhonnan futtatható**, mert a munkát a
> rendszertálca ikon végzi el (a DSH folyamatfáján kívül; lásd
> [`docs/UZEMELTETES.md`](../docs/UZEMELTETES.md)). Az újraindítás megszakítja a
> futó munkamenetet, és új belépési tokent ad — az ablak magától az új tokenre vált.

### 5.2 Alteregó avatarok (kattintásra és automatikusan)

A robotnak **14 alteregója** van. A választó mindkét panelen ugyanaz, és a
választás a **`bot/config.json` `avatarAlterego` blokkjába** kerül
(`{ "aktiv": "gyuszi", "auto": 0 }`), ezért a robot-panel (4180) és a DSH panel
ugyanazt az alteregót mutatja, és újraindítás után is megmarad.

| Hol | Hogyan |
|---|---|
| **Robot-panel** (4180) | fejléc → **🎭 Alteregó váltás**: kattintható kép-rács; mellette az **Automatikus váltogatás** választó (ki · 10 mp · 30 mp · 1 perc · 5 perc · 15 perc · 30 perc · 1 óra · 2 óra) |
| **DSH panel** | a fejléc avatarjára kattintva, vagy az **Alteregók** fülön: ugyanaz a rács és auto-választó |
| **Token nélkül** | `GET /avatar.svg?alterego=<id>` — ismeretlen id esetén az alapértelmezett (Gyuszi) |

Az automatikus váltás **körbevált** a katalógus sorrendjében, és nem ír a
lemezre minden váltásnál (csak maga a beállítás mentődik). A kézzel választott
alteregó azonnal mentődik.

| # | id | Név | Ihlet | Mozgás |
|---|---|---|---|---|
| 1 | `gyuszi` | **Gyuszi (a valódi)** | *Magyarok az űrben* + papírkosár/kuka/flexicső | billeg + integet |
| 2 | `klasszikus` | Klasszikus | a régi fehér robot | lebeg + integet + villog |
| 3 | `ezeros` | Ezüst gépember | *Clouds Across the Moon* klip táncos-robotja | táncol |
| 4 | `gonk` | Gonk | Csillagok háborúja — GNK power droid | billeg |
| 5 | `asztromech` | Asztromech | R2-D2 | fejforgat |
| 6 | `protokoll` | Protokoll-droid | C-3PO | biccent |
| 7 | `kukagyerek` | Kuka-gyerek | WALL-E | sasszézik |
| 8 | `tojas` | Tojás | EVE | lebeg |
| 9 | `gomb` | Golyó | BB-8 | gurul |
| 10 | `bender` | Bender | Futurama | pattog |
| 11 | `marvin` | Búskomor | Marvin (Galaxis útikalauz) | lebeg |
| 12 | `szem` | Szem | HAL 9000 | villog |
| 13 | `clippy` | Iratkapocs | Clippy mém | pattog |
| 14 | `spot` | Robotkutya | Boston Dynamics Spot | billeg |

Új alteregó: egy SVG a `bot/avatar/alteregok/<id>.svg` alá (szerződés:
[`BRIEF.md`](avatar/alteregok/BRIEF.md)) + egy sor az `alteregok.json` `lista`
tömbjébe. Ellenőrzés:

```powershell
node --test --test-isolation=none bot/tests/alterego.test.mjs
# a DSH-oldali panel fordítása/témája (hamis Reacttel renderelve):
node bot/tests/panel-render.test.mjs
```

### 5.3 A robot panel eszközei és nyelvei

A panel fejlécében négy gomb van (ugyanaz a minta, mint a DSH panelen: **ikon +
tooltip**):

| Gomb | Mit tesz |
|---|---|
| **⟳** frissítés | újratölti a panelt (az adatok frissülnek) |
| **⭯** újraindítás | a Harness újraindítása a **tálcán át** (`POST /restart` → `tools\restart-harness.ps1 -NoWait`), friss belépési tokennel |
| **☀ / 🌙** | világos / sötét mód |
| **HU / EN** | nyelv váltása |

A **nyelv és a téma** a böngésző `localStorage`-ában marad meg
(`hazi-robot-lang`, `hazi-robot-theme`), és `?lang=hu|en`, illetve
`?theme=light|dark` paraméterrel felülbírálható — így egy adott nyelvű/témájú
panel linkelhető.

**A téma a DSH-val kétirányban szinkronban van**, mert a panel külön originen
fut, és nem látja a DSH `localStorage`-át:

- **DSH → panel:** a DSH témagombja a hoston át hívja a
  `GET /ui-extras/github-action?action=theme-sync&value=…` útvonalat, ami
  `POST http://127.0.0.1:4180/theme` kérést küld. Ez panelbetöltéskor is lefut,
  hogy a panel a **mostani** témával nyisson.
- **panel → DSH:** a DSH kliens 10 másodpercenként lekérdezi a panel témáját
  (`action=robot-theme`), és ha eltér, átveszi — így a panel saját ☀/🌙 gombja
  az egész ablakot váltja.
- A már **betöltött** panel lapja 4 másodpercenként követi a szerver témáját,
  ezért a váltás újratöltés nélkül látszik.

A **DSH-oldali** robot panel (a 🤖 gomb) ugyanezt a két dolgot a DSH
szolgáltatásaitól kapja: a nyelvet a `locale`, a témát a `<body
data-ds-dark-theme>` jelölés követi (a `theme` injektáláson át). A szótár a
`plugins/dsh-hazi-robot/lib/client.js` `I18N` objektuma (`hu`/`en`, 67 kulcs) —
**új szövegnél mindkét nyelvet fel kell venni.**

**A panel minden szövege kétnyelvű.** A statikus szövegeket a HTML-ben
`data-i18n`, `data-i18n-title` és `data-i18n-placeholder` attribútumok jelölik, a
dinamikus részeket a szkript `t()` függvénye fordítja. A szótár a
`bot/panel/server.mjs` `panelHtml()` függvényében van (`I18N.hu` és
`I18N.en`); **új szövegnél mindkét nyelvet fel kell venni**, különben a kulcs
jelenik meg a felületen.

> A **robot válaszai** (a `/segít` lista és a parancsok üzenetei) továbbra is
> magyarul vannak: a robot personája (`bot/agent.md`) és a determinisztikus
> parancsrendszer magyar. A panel fordítása ettől független.

### 5.4 Önálló panel (a webhook-szerverrel)

`node panel/server.mjs --port=4180` → <http://127.0.0.1:4180/>

Ugyanaz az avatar és állapot, e-mail nélkül; ez a **webhook-fogadó** is
(`POST <a leíróban megadott útvonal>`), ezért a külső rendszer ide küld. Tokennel védhető
(`panelToken` a `secrets.json`-ban, vagy `BOT_WEBHOOK_TOKEN`). A panel
30 másodpercenként frissül, és `GET /status.json` gépi állapotot is ad.

---

## 6. Titkok és konfiguráció

- `bot/config.json` — nem titkos beállítások (proxy, e-mail, integráció, portok).
- `bot/secrets.json` — **titkok**, a `.gitignore`-ban. Minta:
  `secrets.example.json`. Alternatíva: környezeti változók
  (`BOT_SMTP_PASSWORD`, `BOT_WEBHOOK_TOKEN` és a modul saját titkai).
- A minta **helykitöltőit** (`IDE-KERUL-…`) a bot nem tekinti beállított
  titoknak — így egy ismert sztring soha nem lesz élő jelszó vagy token. Amíg a
  panel-token üres, a webhook **token nélkül** fogad (csak helyi használatra
  biztonságos), és ezt a naplóban jelzi; beállított tokennél a rossz/ hiányzó
  `X-Bot-Token` **401**-et kap.
- A modul callback-titka a futásmappában lévő `.callback_secret` fájlból is
  jöhet (a Linux-gépen így él) — ez elsőbbséget élvez.

> A titkot **soha** ne írd chatbe, és ne kerüljön a repóba.

---

## 7. Ami még neked kell megtenned

- [ ] A **beállítások kitöltése a DSH panelon** (🤖 Robot gomb → Beállítások):
      feladó, címzettek, SMTP host/port/felhasználó/jelszó, a modul beállításai,
      panel-token, figyelt oldalak. (Vagy kézzel: `bot\secrets.json`.)
- [ ] Éles e-mail-küldéshez a panelon kikapcsolni a **száraz futás** kapcsolót.
- [ ] Az ütemezett feladat ellenőrzése **PowerShell-ablakban** (nem cmd.exe):
      `schtasks /Query /TN "HáziRobot due" /V /FO LIST`
- [ ] A Linux-gépen: a `bot` mappa átmásolása, `--mode=selftest` futtatása, a
      szelektorok véglegesítése.
- [ ] A weboldal (Laravel) webhookjának átirányítása a botra:
      `POST http://<gép>:4180/<a modul útvonala>` + `X-Bot-Token` fejléc.
- [ ] A figyelt oldalak listája (a panelon is kitölthető).
- [ ] Az Ollama indítása, ha a helyi modell-sávot is használni akarod.

---

## 8. Hibakeresés

| Tünet | Hol nézd |
|---|---|
| Nincs e-mail | `bot/state/outbox/*.eml` (dry-run), `config.json` `email.dryRun`, `BOT_EMAIL_SEND=1` az éles küldéshez |
| A job nem fut le ütemezésre | `schtasks /Query /TN "HáziRobot due" /V /FO LIST`, `bot/state/bot.log` |
| A panel nem válaszol | `node panel/server.mjs --port=4180` kézzel; a port foglalt-e |

Naplók: `bot/state/bot.log` (JSONL), riportok: `bot/reports/<dátum>/`,
audit: `bot/state/bot.db` (`runs`, `kv`, az integrációs napló táblája).

---

## 9. Fájltérkép

| Fájl | Szerep |
|---|---|
| `run-job.mjs` | job-futtató (`list` / `check` / `due` / `<job-id>`) |
| `run-job.ps1` | PowerShell belépési pont az ütemezőhöz |
| `install-hazi-robot.ps1` | telepítő/eltávolító (ütemezett feladat + startup panel) |
| `watchdog-hazi-robot.ps1` | a panel őrfolyama (60 s ciklus): kiesés → újraindítás, és proxy-figyelmeztetés |
| `start-robot-watchdog.ps1` | az őrfolyam indítása leválasztva, láthatatlanul (normál ablakból) |
| `start-robot-watchdog.cmd` | **kattintható belépési pont** — őrfolyam + panel indítása (a `.ps1` helyett ezt) |
| `robot-status.cmd` | **kattintható állapotellenőrzés** — panel, proxy, őrfolyam fut-e |
| `deploy-remote.ps1` | a bot átvitele a Raiderre + távoli `selftest` |
| `config.json`, `secrets.example.json` | beállítás és titok-minta |
| `lib/state.mjs` | SQLite állapot: `runs`, `kv`, integrációs napló |
| `lib/mail.mjs` | függőség nélküli SMTP kliens (STARTTLS/TLS, dry-run outbox) |
| `lib/llm.mjs` | LLM-híd a helyi proxyhoz (ingyenes lánc) |
| `lib/jobs.mjs` | job-betöltés + cron |
| `jobs/*.json` | job-definíciók |
| `lib/extensions.mjs` | a gépenkénti integrációs modulok leírójának betöltése |
| `panel/server.mjs` | webhook-fogadó + állapotpanel |
| `avatar/hazirobot.svg` | az animált avatar |
| `agent.md` | a robot personája és akció-protokollja (a konzol beszélgetéséhez) |
| `lib/agent.mjs` | a mini-ügynök: akció-kérés → végrehajtás → válasz |
| `tools/db-cleanup.mjs` | a próbafutások törlése a `runs`/`kv` táblából (`--apply`) |
| `tests/rules.test.mjs` | 20 szabályteszt (`node --test --test-isolation=none`) |
| `tests/plugin-settings.test.mjs` | a DSH-panel beállítás-logikájának tesztje |
| `../plugins/dsh-hazi-robot/` | a DSH-ba integrált panel (host route-ok + kliens gomb és űrlap) |
| `../plugins/dsh-hazi-robot/install.ps1` | a panel bekötése a DSH profiljába |

---

## 10. Következő kör (még nincs benne)

1. **E-mail bemenet (IMAP)** — a bot e-mail-válaszból is elfogadjon
   jóváhagyást/utasítást.
2. **Facebook-csoport figyelő** — csak a saját csoportok, alacsony frekvencia,
   összegzés e-mailben (a Meta ToS a scrape-et tiltja: tudatos kockázat).
3. **Weboldal-ébresztő job** — a saját oldal és az adatszolgáltatási végpont
   figyelése.

> A privát integrációs modul fájljai (`<modul>/orchestrator.mjs`, `<modul>/rules.mjs`,
> `<modul>/executor/*`) gépenkéntiek, ezért ebben a fában nem szerepelnek. A modul
> saját hibáit a saját naplója és a saját README-je írja le.
