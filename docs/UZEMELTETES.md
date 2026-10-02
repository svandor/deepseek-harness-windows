# Üzemeltetés — indítás, újraindítás, leállítás

**Státusz:** az integritási átvizsgálás megtörtént (2026-10-02). Ez a dokumentum
azt rögzíti, **melyik belépési pont mit tesz**, és miért úgy teszi — hogy egy
nyilvános kiadásnál ne legyen „rossz helyről indítottam" típusú hiba.

---

## 1. A belépési pontok

| # | Belépési pont | Mit tesz | Hol fut |
|---|---|---|---|
| 1 | **Asztali ikon** / **tálcára tűzött ikon** (`DeepSeek Harness.lnk`) | `bin\DshLauncher.exe`: ha a tálca fut → jelzés rá, hogy nyissa meg az ablakot; ha nem → elindítja a tálcát `-OpenWindow`-nal. Kapcsolók: `--tray-only` (csak a tálca), `--reset-geometry` (mentett ablakpozíció törlése), `--help` (súgó **MessageBoxban** — az indító nem konzolprogram) | launcher (C#) |
| 2 | **Tálcaikon → Megnyitás (ablak)** | elindítja a háttér-GUI-t (ha kell), majd megnyitja a `DshWindow.exe` ablakot | tálca (PowerShell) |
| 3 | **Tálcaikon → Háttér-GUI leállítása** | leállítja a harness szervert (csak `node` folyamatot); az ablak és a tálca megmarad | tálca |
| 4 | **Tálcaikon → Újraindítás** | leállítja az összes figyelőt a porton, majd friss szervert indít és **friss tokent** ment; ezután a **robot panelt is újraindítja** az őrfolyamával | tálca |
| 5 | **Tálcaikon → Ablak felosztása → 4. felület: robot panel** | a robot panel külön ablak-felületként (a munkaterületek mellett) | tálca |
| 6 | **Tálcaikon → A tálca újraindítása** | csak a tálca programját tölti újra (frissítés után); az ablak és a háttér-GUI érintetlen | tálca |
| 7 | **Web UI → ⟳** | a felület újratöltése (a tokent a `DshWindow` figyeli) | böngésző |
| 8 | **Web UI → ⭯** | harness újraindítás: a kérés a **tálcára** megy át (lásd 2. pont) | host + tálca |
| 9 | **Web UI → ⇪** | élesítés: profil-patch írása, majd újraindítás — szintén a tálcán át | host + tálca |
| 10 | **`tools\restart-harness.cmd`** | újraindítás; a tálcára bízza, ha az fut | PowerShell |
| 11 | **`tools\restart-tray.cmd`** | csak a tálca újraindítása (frissítés után) | PowerShell |
| 12 | **`bot\start-robot-watchdog.cmd`** | a robot panel őrfolyamának indítása (az is elindítja a panelt) | PowerShell |
| 13 | **DSH terminál** (a Web GUI terminál panelje) | bármelyik fenti szkript futtatható — **nem szakad félbe** (lásd 2. pont) | DSH gyermekfolyamat |
| 14 | **`tools\release.cmd`** | kiadás: verzióemelés + commit + tag + push + GitHub Release (`gh release create`) | PowerShell |
| 15 | **Web UI → Git panel → Kiadás** | ugyanaz a `tools\release.ps1`, egy kattintással (`-Yes`) | host + PowerShell |
| 16 | **Robot panel → ⟳ / ⭯ / ☀ / HU** | a panel újratöltése · a Harness újraindítása a tálcán át · világos/sötét · nyelv | böngésző (+ tálca a restartnál) |
| 17 | **`tools\restart-all.cmd`** | **teljes frissítés egy kattintással**: előbb a tálca, majd a harness újraindítása (a sorrend számít), végül összegzés | PowerShell |
| 18 | **Tálcaikon → A robot panel újraindítása** | a robot panel (4180) és az őrfolyama is frissül — ez kell egy javított `webhook-server.mjs` életbe lépéséhez | tálca |

## 2. Miért megy minden újraindítás a tálcán át

A tálcaikon az **egyetlen** folyamat, amely a DSH folyamatfáján kívül fut: a
bejelentkezéskor indul, és a saját `DshHarnessTrayIcon` mutexével egyetlen
példány. Ezért egy újraindítás ott nem szakadhat félbe.

**A mért hiba (2026-10-02), amit ez megszüntet:** a `restart-harness.ps1`-et a
DSH termináljából futtatva a szkript a **saját ősét** állította le. A DSH a
leálláskor `taskkill /F /T`-vel a teljes folyamatfát viszi, ezért:

1. a szkript leállította a régi szervert és elindította az újat,
2. de a friss tokent már **nem** tudta kiírni (`state\harness.url` csonka lett:
   74 byte helyett 3 byte),
3. a tálca a **régi** tokent olvasta → `token=False`,
4. az önjavítás újraindította a szervert, és közben elveszett az ablak robot
   felülete (`robot felulet: KI`).

**A mostani lánc:**

```
bármely hívó (DSH terminál, Web UI, .cmd, szkript)
        │
        ├─ fut a tálca?  (state\tray.heartbeat friss)
        │      igen ──▶  state\restart-request  ──▶  TÁLCA végzi el
        │      nem  ──▶  elindítja a tálcát, majd az előző ág
        │      nem indítható ──▶ MEGÁLL (exit 3), nem nyúl a szerverhez
        │
        └─ -Force ──▶ WMI-vel leválasztott másolat
                       (a Win32_Process szolgáltatás gyermeke, ezért a hívó
                        taskkill /T-je nem éri el; normál ablakból biztonságos)
minden út végén: friss token a state\harness.url fájlba (ATOMIKUSAN írva)
```

**Miért áll meg a szkript, ha nincs tálca?** A saját út (leválasztott másolat)
első dolga a régi szerver leállítása. Ha a hívó maga is sandboxolt (DSH-agent)
vagy a DSH folyamatából indult, a hívó fájával együtt a másolat is meghalhat —
és akkor a **harness leállva marad**. Ez rosszabb, mint egy félbemaradt token,
ezért ez az út csak `-Force`-szal (vállalt kockázattal) indul.

Az atomikus írás (temp fájl + `Move-Item`) azért kell, mert egy megszakadt írás
csonka `harness.url`-t hagyott, és utána **minden** olvasó a régi tokent látta.

## 3. Állapotfájlok (`state\`)

| Fájl | Ki írja | Mire való |
|---|---|---|
| `harness.url` | tálca, `restart-node.js`, `restart-harness.ps1` | a **friss belépési token** — ez az igazság forrása; minden komponens innen olvas |
| `harness.pid` | tálca, `restart-harness.ps1` | a futó szerver folyamat-azonosítója |
| `harness.log` / `harness.err.log` | tálca, `restart-harness.ps1`, a DSH maga | a szerver naplója (ebből olvassa a tálca a tokent) |
| `tray.heartbeat` | tálca, 15 másodpercenként | „fut a tálca" — ebből dönt a külső kérés átadásáról |
| `tray.pid` | tálca induláskor | a tálca folyamat-azonosítója (`restart-tray.ps1` használja) |
| `restart-request` | `restart-harness.ps1`, `restart-node.js` | külső újraindítási kérés; a tálca a tickben dolgozza fel és törli |
| `tray-config.json` | tálca | `port`, `panes`, `robotPane`, `robotOnly`, `robotUrl`, geometria |
| `window.log` | `DshWindow.exe` | az ablak naplója (token-figyelő, panelek) |
| `tray.log` | tálca | a tálca naplója (minden művelet és hiba) |
| `restart.log` | `restart-node.js` | a Web UI-ból indított újraindítások naplója |
| `restart-harness.log` / `.err.log` | `restart-node.js` | a Web UI-ból indított **szerver** naplója (a friss token innen kerül a `harness.url`-ba) |

> **A `~\.dsh\dsh-web\harness.url` fájlt már NEM használjuk.** Korábban oda is
> írtunk tokent, és egy megszakadt írás csonka fájlt hagyott ott. Az igazság
> forrása a `state\harness.url`.

## 4. A robot panel (4180)

A robot panel a tálcától **független** folyamat:

```
tálca ──(60 s-enként, ha nincs)──▶ bot\watchdog-hazi-robot.ps1 ──▶ bot\panel\server.mjs (4180)
```

- A tálca `Invoke-RobotEnsure`-ja 60 másodpercenként ellenőrzi a `bot\state\robot-watchdog.pid`
  fájlt, és elindítja az őrfolyamot, ha nem fut.
- Az őrfolyam 60 másodpercenként figyeli a panelt (`/status.json`), és
  újraindítja, ha nem válaszol; a fallback proxy (4123) állapotát is jelzi.
- A **harness újraindítása nem állítja le** a robot panelt.
- Ha a robot felület (ablak-panel) kikapcsolódott: **tálcaikon → Ablak felosztása
  → 4. felület: robot panel**. A beállítás a `tray-config.json`-ba kerül, és a
  következő ablaknyitáskor lép életbe (a tálca rákérdez, hogy újraindítsa-e most
  az ablakot).

### 4.1 Téma és nyelv — mind a négy felületen egyszerre

A robot panel **külön originen** fut (4180), ezért nem látja a DSH
`localStorage`-át. A kétirányú szinkron ezért a **hoston** át megy
(szerver-szerver hívás, így nem ütközik CORS-ba):

| Irány | Út | Mikor |
|---|---|---|
| DSH → robot panel | `GET /ui-extras/github-action?action=theme-sync&value=light\|dark` → `POST http://127.0.0.1:4180/theme` | a DSH témagombjának megnyomásakor **és** minden panelbetöltéskor |
| robot panel → DSH | `GET /ui-extras/github-action?action=robot-theme` → `GET http://127.0.0.1:4180/theme` | **2 másodpercenként**, ha a panel témája eltér |

A robot panel oldalán a téma **élőben** követi a szervert (szintén 2
másodpercenként), ezért nem kell újratölteni ahhoz, hogy átváltsa a témát.

> **Miért 2 másodperc?** A robot panel a saját gombjára **azonnal** vált, a DSH
> viszont csak a következő lekérdezéskor értesül. 10 másodperces lekérdezéssel a
> felhasználó joggal látta úgy, hogy „csak a robot panelt kapcsolja" — pedig a
> szinkron működött, csak késve. A DSH oldal a `THEME_SYNC_HOLD_MS` (6 mp) alatt
> szándékosan nem hisz a panel válaszának: a saját váltásunk `theme-sync` POST-ja
> ugyanis kicsit késik, és a visszapollozás a régi értéket olvasná (villogás).
> Rejtett (minimalizált) lapon egyik irány sem kérdez.

- A **nyelv** a panel saját `HU`/`EN` gombjával váltható (a felirat az **aktív**
  nyelvet mutatja, a tooltip a váltás célját), és a localStorage-ban marad meg.
  A DSH-oldali robot panel (a 🤖 gomb) a **DSH aktív nyelvét** követi.
- A DSH-oldali robot panel a **DSH témáját** követi (a `<body data-ds-dark-theme>`
  jelölésből), ezért világos módban nem marad fekete téglalap.
- A témát a `bot\state\panel-theme.txt` tárolja; ez futásidejű állapot, a
  `.gitignore` kizárja.

#### Mit kell újraindítani egy javítás után?

| Amit módosítottál | Elég a lap újratöltése? |
|---|---|
| `plugins/*/lib/client.js` (kliens-bővítmény) | **Igen** — a bundle a kérés idején, a lemezről épül (a `rev` a tartalom sha1-je), ezért a ⟳ / Ctrl+R elég |
| `plugins/*/lib/index.js` (host-oldali route) | Nem — **harness újraindítás** kell |
| `bot/panel/server.mjs` (robot panel) | Nem — a **panelt** kell újraindítani (tálca → **A robot panel újraindítása**) |
| `tray/dsh-tray.ps1` | Nem — a **tálcát** kell újraindítani (tálca → **A tálca újraindítása**) |
| `src/DshWindow.cs` (natív ablak) | Nem — `tools\build-window.cmd`, majd **zárd be és nyisd meg újra az ablakot** (tálca → **Ablak bezárása** + **Megnyitás (ablak)**) |

Mindhárom egyszerre: `tools\restart-all.cmd`, vagy a tálca menüjében
**A tálca újraindítása** → **Újraindítás** (ez már a robot panelt is viszi).

> **A natív ablak és a robot panel viszonya.** A `DshWindow` a Harness paneleibe
> a betöltés előtti villanás ellen sötét hátteret injektál. Ez **csak a Harness
> panelekre** megy (`_isHarnessPane`): a robot panel a saját témáját hozza, és a
> kényszerített sötét háttér + sötét `color-scheme` világos módban fekete hátteret
> és vastag fekete görgetősávot rajzolt alá (mért hiba, 2026-10-02 — a
> `body.light` osztály megmaradt, de a háttér `rgb(21,21,23)` lett).

## 5. A tálca frissítése

A tálca a **saját kódját a folyamat indulásakor** tölti be, ezért a javított
`tray\dsh-tray.ps1` csak újraindítással lép életbe:

```powershell
.\tools\restart-tray.cmd          # dupla kattintás is elég
```

vagy a tálca menüjében: **A tálca újraindítása** (ez a frissített kódban van).
Mindkettő **futva hagyja az ablakot és a háttér-GUI-t** — csak a tálca programja
cserélődik.

Ha a tálca **és** a harness is friss kódot kell kapjon (ez a szokásos eset egy
javítás után), egyetlen kattintás elég — a sorrend itt számít, ezért érdemes
erre használni:

```powershell
.\tools\restart-all.cmd    # 1) tálca, 2) harness, végül összegzés
```

> **Miért kell ehhez a felhasználó?** A DSH sandboxa (a `pwsh` tool Win32 Job
> objectje) a parancs végén **minden** gyermekfolyamatot lelő — mérve még a
> `detached` Node-gyermeket is (a `Start-Process`-szel indított folyamatot is).
> Ezért a tálca újraindítását nem lehet a DSH sandboxából elvégezni: **normál
> ablak** kell hozzá (vagy a DSH *terminál* panelje, amely nem sandboxolt).
> Ugyanezért működik a `restart-harness.ps1` WMI-útja a terminálból, de nem a
> sandboxból.
>
> Ellenőrzés, hogy a tálca már a friss kódot futtatja-e:
> `Test-Path state\tray.pid` — a régi tálca nem írja ezt a fájlt.

## 6. Hibaelhárítás

| Tünet | Ok | Megoldás |
|---|---|---|
| „Reconnecting…" a felületen | a mentett token elavult (a szerver újraindult) | a `DshWindow` `--restart-if-stale`-je magától újraindítja a szervert; ha nem: tálca → **Újraindítás** |
| A robot felület eltűnt az ablakból | a `robotPane` kikapcsolódott a `tray-config.json`-ban | tálca → **Ablak felosztása** → pipa a **4. felület: robot panel**-re |
| A robot panel nem válaszol | az őrfolyam vagy a panel elhalt | `bot\start-robot-watchdog.cmd`, vagy várj 60 s-ot (a tálca elindítja) |
| A restart „félbemaradt" | a szkriptet a DSH-ból futtatták, és a WMI sem volt elérhető | futtasd a `tools\restart-harness.cmd`-t **normál** ablakból; a tálca a következő körben helyreállítja |
| `restart-harness.cmd` → „a tálca FUT, de RÉGI verziót futtat" | a tálca a javítás előtti kódból fut, ezért nincs `state\tray.heartbeat`-je, és nem tudja átvenni a kérést | `tools\restart-tray.cmd`, majd újra a `restart-harness.cmd`. A szkript ilyenkor **nem nyúl a szerverhez** (exit 3), hogy ne maradjon leállítva |
| `restart-harness.cmd` → „nincs futó rendszertálca" | nincs tálca-életjel és a mutex sem él | indítsd el a tálcát (`bin\DshLauncher.exe --tray-only` vagy az asztali ikon), majd újra; végső esetben `-Force` **normál ablakból** |
| Beragadt `state\restart-request` + „a tálca nem dolgozta fel" | a tálca a kérés előtt **kilépett**, és a régi életjel-fájl még frissnek látszott (mért hiba, 2026-10-02: kilépés után 5 másodperccel indított restart) | javítva: a `Test-TrayAlive` a **mutexet** és a **PID-fájlt** is ellenőrzi, a tálca pedig kilépéskor törli az életjelet. Indítsd újra a tálcát (`tools\restart-tray.cmd`); a beragadt kérést a tálca elavultként kihagyja |
| A tálca „átvette" a restartot, de a szerver a régi marad (150 s várakozás) | a tálca a portot figyelő folyamatot **kizárólag** a `Get-NetTCPConnection`-nel (WMI/CIM) kereste; ahol az „Access denied", ott üres listát ad, a régi szerver a porton marad, az új példány `EADDRINUSE`-szal elhal | javítva: a tálca `Get-PortListenerPids`-je a `netstat -ano -p TCP`-t is használja, és a port felszabadulását ellenőrzi, mielőtt új szervert indít. Tálcafrissítés: `tools\restart-tray.cmd` |
| A robot panel nem veszi át a DSH témáját | a panel külön originen fut, és a lap csak betöltéskor olvasta a témát | javítva: a DSH témagombja a hoston át POST-ol a `/theme` végpontra, a panel pedig 2 másodpercenként követi a szervert. Ha mégsem: `tools\restart-tray.cmd` + `tools\restart-harness.cmd` (a host-oldali `theme-sync`/`robot-theme` útvonalak a szerver újraindításakor töltődnek be) |
| A témagomb „csak a robot panelt kapcsolja" | a visszirány (panel → DSH) lekérdezése 10 másodpercenként futott, a DSH csak ezután értesült — a panel viszont azonnal váltott | javítva: a lekérdezés 2 másodperces, a `THEME_SYNC_HOLD_MS` pedig 15 → 6 másodperc (a 15 mp a visszirányt is blokkolta a saját váltás után). Kliens-oldali javítás: elég a **⟳** a paneleken |
| A tálca **Újraindítás** menüje nem indítja újra a robotot | a robot panel külön folyamat az őrfolyamával, a menüpont eddig csak a harness-t indította újra | javítva: az **Újraindítás** már a robot panelt is viszi, és van külön **A robot panel újraindítása** menüpont. Ehhez a **tálcát** kell egyszer újraindítani (tálca → **A tálca újraindítása**) |
| A robot panel világos módban **fekete hátteret és vastag fekete kereteket** mutat, pedig a fejléc világos | a `DshWindow` MINDEN panelbe injektálta a `html,body{background:#151517 !important;color-scheme:dark}` stílust és a `data-ds-dark-theme` jelölést — a robot panel saját világos témája alá is | javítva: az injektálás (`ThemeScript`, `PreferredColorScheme`) csak a Harness panelekre megy, és a pre-paint stílus 3 mp után eltűnik. Újra kell fordítani (`tools\build-window.cmd`) **és be kell zárni/nyitni az ablakot** |
| Az **egyenleg** csak sötét módban látszik | a `Pill` a kiemelt értéket fix `#f9fafb`-re színezte — fehér a fehér háttéren | javítva: `var(--dsw-alias-label-primary)`. Kliens-oldali javítás: elég a **⟳** |
| A DSH paneljei (Git, SSH, terminál, engedélyek) világos módban sötétek maradtak | beégetett sötét felületek (`rgba(21,21,23,…)`, `#e8eaed`) és fehér-alfa keretek | javítva: mind `--dsw-alias-*` témaváltozóra cserélve (a fix érték a tartalék). Kliens-oldali javítás: elég a **⟳** |
| A 🤖 panel a nyitás kori nyelven/témán marad, vagy fekete téglalap világos módban | a panel fix sötét színeket és magyar feliratokat használt | javítva: a panel a DSH aktív nyelvét és a `<body data-ds-dark-theme>` jelölést követi. A kliens-bundle a **harness újraindításakor** (vagy a lap újratöltésekor) frissül |
| A harness nem válaszol, és a tálca sem fejezte be | a tálca félbemaradt (összeomlás, kilépés) | a javított `restart-harness.ps1` ilyenkor **magától átvált a saját (leválasztott) útjára**, és helyreállítja a szervert |
| Az újraindítás után a robot felület helyére DSH panel kerül (duplikált panel) | a javítás előtti `DshWindow` **minden** panelen token-figyelőt indított, ezért a robot panelt (`--pane-url`) is a DSH token-URL-jére navigálta, amint friss token jelent meg | `tools\build-window.cmd` (futó ablak mellett is biztonságos), majd tálca → **Ablak bezárása** + **Megnyitás (ablak)** — az új exe a következő ablaknyitáskor lép életbe |
| Az ablak a képernyőn kívülre került | mentett geometria egy már nem létező monitorról | `bin\DshLauncher.exe --reset-geometry` (törli a `state\window-geometry.txt`-t) |
| A tálca nem indul | a `DshLauncher.exe` vagy a WebView2 DLL hiányzik | `.\build.ps1`, majd az asztali ikon |
| Boot-hiba: „Failed to load plugins" | egy saját plugin bejegyzése megbuktatta a bootot | `.\tools\recover-harness.ps1` (kiüríti a profil-patch-et, majd újraindít) |

## 7. Naplók

```powershell
Get-Content state\tray.log -Tail 30          # a tálca műveletei (innen látszik minden restart)
Get-Content state\window.log -Tail 30        # az ablak (token-figyelő, panelek)
Get-Content state\harness.err.log -Tail 30   # a szerver hibái
Get-Content state\restart.log -Tail 20       # a Web UI-ból indított újraindítások
Get-Content bot\state\robot-watchdog.log     # a robot őrfolyam (csak rendellenességek)
Get-Content bot\state\panel.err.log          # a robot panel hibái
```

A tálca naplója 256 KB-nál átfordul `tray.log.1`-be.

## 8. Ellenőrző lista nyilvános kiadás előtt

1. `.\tools\restart-tray.cmd` — a tálca a friss kóddal fut (a `tray.heartbeat`
   létezik és 15 másodpercenként frissül).
2. Tálca → **Állapot…** — a harness FUT, a robot panel ÉL, az őrfolyam fut.
3. Tálca → **Ablak felosztása** → a robot felület pipa be.
4. Web UI → **⭯** — az újraindítás végigmegy, a felület magától visszatér.
5. `.\tools\restart-harness.cmd` normál ablakból — ugyanaz.
6. `bot\tests` zöld (49 teszt):
   `node --test --test-isolation=none bot\tests\agent.test.mjs bot\tests\rules.test.mjs bot\tests\plugin-settings.test.mjs bot\tests\alterego.test.mjs bot\tests\panel-render.test.mjs`
   (a `panel-render` a DSH-oldali robot panelt rendereli le hamis Reacttel: nyelv,
   téma, hiányzó szolgáltatások — így egy futásidejű hiba még a restart előtt kiderül)
7. `node tools\check-plugin.mjs` zöld (a `dsh-ui-extras` plugin).
8. **Négy felület együtt:** a DSH témagombja (🌙/☀) és a nyelvváltó mind a négy
   panelen hasson — a robot panel (4180) is váltson, újratöltés nélkül.
   A robot panel saját ☀/HU gombja visszafelé is váltson (a DSH panelek kövessék).
9. **Kétirányú ellenőrzés:** a robot panel ⭯ gombja és a `restart-harness.cmd`
   is hozza vissza a felületet (a `state\harness.url` frissül, a `DshWindow`
   átnavigál rá).
10. `node tools\audit-secrets.mjs` — **a kiadás kapuja**: a mostani fában nem
    lehet találat (kulcs, jelszó, token, e-mail, személyes név, abszolút
    felhasználói útvonal). A git-előzmény találatait jelenti, de nem blokkolja
    a kiadást — azt csak történelem-átírással lehet eltüntetni.
11. `.\tools\build-installer.ps1` — elkészül a `dist\` alá a portable ZIP és a
    telepítő EXE. A csomag **csak a git által követett fájlokat** tartalmazza,
    ezért a `state\`, a `node_modules` és minden titok kimarad.
    Próba: `dist\DeepSeek-Harness-Setup-<verzió>.exe /dir=<temp> /noinstall /silent`
    (az `/uninstall` csak azt a parancsikont törli, amelyik a saját mappájába mutat).
12. **Kiadás:** `.\tools\release.cmd -Version x.y.z` — verzió + commit + tag +
    push + GitHub Release, a csomagok **automatikusan csatolva** a Release-hez.
    A `release.ps1` a titok-auditot maga is lefuttatja, és találat esetén leáll.
13. **Nyilvánossá tétel:** `gh repo edit --visibility public --accept-visibility-change-consequences`.
    A leírás és a témák beállítása (felfedezhetőség):
    `gh repo edit --description "..." --add-topic deepseek --add-topic hungarian …`

