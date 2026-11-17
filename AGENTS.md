# Projekt-szabályok — DeepSeek Harness (Windows)

Ezek a szabályok a **teljes munkaterületre** érvényesek, minden ágensre és minden
ember által írt automatizmusra. Nem javaslatok: megszegésük súlyos hiba, és a
hibás komponenst vissza kell vonni.

---

## 1. TILOS a fókusz elvétele felugró ablakkal  (P0, nem új szabály)

Windows alatt **szigorúan tilos** olyan folyamatot létrehozni vagy ütemezni,
amely látható ablakot nyit, villan, vagy elveszi a fókuszt a felhasználó
munkájától. Ez vonatkozik a konzolablakokra is (`cmd.exe` fekete,
`powershell.exe` kék) és minden GUI-ablakra.

**Csak beépített háttérfolyamat használható**, amely egyáltalán nem hoz létre
ablakot.

Mért esetek (ne ismétlődjön):

- `2026-10-22 23:31:01` — a `HáziRobot due` feladat közvetlenül a
  `powershell.exe`-t indította: a konzol **láthatóan létrejött**, a foreground a
  `ConsoleWindowClass` ablaka lett, majd a PowerShell elrejtette. 15 percenként
  fél másodperces villanás.
- `2026-10-28 09:00:01` — a `DSH model retune` feladat `run-retune.cmd` shimre
  mutatott, ezért **két ablak** jelent meg (fekete `cmd`, majd kék
  `powershell.exe`), és 09:00:01–09:09 között elvette a fókuszt.

### 1.1 A `-WindowStyle Hidden` NEM elég

A `-WindowStyle Hidden` csak a létrehozás **után** hívja a `ShowWindow(SW_HIDE)`-ot.
A konzolablak addig látható és fókuszra tesz szert. Önmagában tehát **tiltott
megoldás**.

### 1.2 Kötelező minta

Ütemezett feladat / háttérfolyamat művelete:

```
wscript.exe //nologo "<mappa>\<nev>-hidden.vbs" <argumentumok>
```

A `wscript` `WshShell.Run(cmd, 0, True)` hívása **egyáltalán nem hoz létre
konzolt** (0 = rejtett, True = megvárja és visszaadja a valódi exit kódot).
A VBS-en belül a gyermek `powershell.exe` továbbra is kapjon
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden`
kapcsolókat.

Referenciamegvalósítás (másolható):
`bot\run-job-hidden.vbs` + `bot\register-hidden-task.ps1`.

### 1.3 Tiltott minták — ellenőrzés nélkül soha

| Tiltott | Miért |
|---|---|
| Task Scheduler művelete = `powershell.exe` | látható konzol jön létre |
| Task Scheduler művelete = `cmd.exe` / `.cmd` / `.bat` shim | a shimhez mindig létrejön konzol |
| `-WindowStyle Hidden` egyedül | lásd 1.1 |
| `Start-Process` `-WindowStyle` nélkül | új ablak, fókuszlopás |
| `Invoke-Item` / `Start-Process` az ágens eszközeiből | a felhasználó elől nyit ablakot |
| űrlap/panelen induló `ps1`-k `start`/`/b` nélkül | villanás |

### 1.4 Kötelező ellenőrzés bármely háttérfolyamat beépítése előtt

1. A feladat művelete `wscript.exe` + `*-hidden.vbs` legyen — **nem**
   `powershell.exe`, **nem** `.cmd`.
2. Indítás után ellenőrizd: nincs új, a feladat gyerekfához tartozó
   `conhost.exe` / `cmd.exe` / `powershell.exe` a `Get-Process` listában.
3. A regisztrációt **normál PowerShell-ablakból** futtasd: a DSH sandboxa nem ér
   el CIM-et, ezért a `ScheduledTasks` modul és a `schtasks` ott nem működik.
4. Ha a feladat már létezik rossz művelettel, **újra kell regisztrálni**, nem
   elég a `.cmd` belsejét javítani — a konzolt a Task Scheduler hozza létre a
   `.cmd` lefutása előtt.

### 1.5 TILOS a futó Harness-t (vagy a felügyelő láncot) újraindítani  (P0, 2026-11-16)

A Harness **minden futó sessiont és jobot megszakít**. Ezért:

- **Indítás/újraindítás előtt kötelező ellenőrizni**, fut-e munka: a `state\runs.json`,
  az aktív sessionök és a Harness job-listája. Ha bármi fut, **a felhasználó
  engedélye nélkül tilos** újraindítani — és nem elég „megkérdezni a szövegben":
  meg kell várni a választ.
- **Tilos** a Harness folyamatának vagy a felügyelő láncnak (tálca → node →
  gyermekfolyamatok) a leállítása „frissítés" céljából. A `bin\*.exe.new` csere
  **a következő természetes indításkor** történik meg (`PendingUpdate.Apply`),
  tehát nem kell érte semmit leállítani.
- **MÉRT ESET (2026-11-16 ~07:06–07:08):** a WebView2-újrapróbálkozások
  „takarítása" közben a Harness processze elhalt (a felügyelt job futása
  megszakadt), a tálca újraindította, **3 futó munka megszakadt**, és a
  hiba-lavina miatt a felhasználónak **Windows-t kellett újraindítania**.

### 1.6 TILOS folyamatot NÉV szerint leállítani  (P0, 2026-11-16)

- `Stop-Process -Name` / `taskkill /IM` **tilos** olyan névre, ami nem kizárólag a
  miénk (`node`, `msedgewebview2`, `chrome`, `php-cgi`, …): az más alkalmazások
  és a Harness saját folyamatait is megöli.
- Leállítás csak **ellenőrzött PID**-del: előbb a parancssor/process-name
  egyezését ellenőrizni kell (a gyermekfolyamatok listája, a szülő pidje), és a
  Harness pidje (`state\harness.pid`) nem lehet a listában.
- A WebView2 gyermekfolyamatok a **panelekhez** tartoznak: azokat csak akkor
  szabad leállítani, ha az adott ablak/panelek mar nem kellenek, es ezt a
  felhasznalo tudja.

### 1.7 TILOS korlátlan vagy lavinát indító újrapróbáló ciklus  (P0, 2026-11-16)

- Bármely újrapróbálkozás **köteles** korlátozott lenni: max. próbaszám,
  növekvő várakozás (1 s → 2 s → 4 s → 8 s, plafon), és **globális áramköri
  megszakító** (időablakos hibaszámláló), ami lavina esetén MINDEN további
  próbát leállít.
- **Tilos** olyan háttérciklus, ami folyamatot/környezetet indít (WebView2
  environment, node, php-cgi), és a kör után is futva marad.
- **MÉRT ESET (2026-11-16):** 6 panel × 8 próba + 10 s-os önjavítás = 43
  profil-mappa és több tucat félig leállt böngészőfolyamat; a gép
  használhatatlanná vált. A javítás: futásonként egy tartalék-mappa, 8 próba,
  és `WebViewCircuit` (12 hiba / 2 perc után leáll).

### 1.8 Boot-sorrend: mindig az 1. asztal legyen a látható  (2026-11-16)

Minden indításnál (boot, tálca-újraindítás) a **látható** munkaablak az **1.
asztalé**; a másik asztal csak **utána**, rejtve indulhat. A tálca ezért
indításkor `window-desktop.txt` = 1-et ír, a „másik asztal" előindítása pedig
csak akkor fut, ha a Harness már figyel **és** az aktív asztal ablaka él; utána
normalizál (`ApplyDesktopAsync(1)`). **MÉRT HIBA (2026-11-16 07:08:13):** az
előindítás feltétel nélkül futott, ezért boot után a **2. asztal** nyílt meg.

---

## 2. Helyi modell (Ollama) — memória-korlát

A helyi Ollama a **legutolsó tartalék**, nem mérethető és nem terhelhető
teljes kontextussal.

Mért eset: `2026-10-28 09:02:50` — a napi retune a `qwen3-vl:8b` modellt
`-c 262144` kontextussal töltette be (mert a `~/.dsh/settings.yaml`-ban
`contextWindow: 262144` szerepelt). A `llama-server.exe` **19,6 GB RAM-ot**
foglalt, a mérés **93,96 másodpercig** tartott, a gép gyakorlatilag megállt.

Szabályok:

- Helyi modell `contextWindow` értéke **alapból max. 32768** (kivétel: indokolt,
  mért eset, kommentben dokumentálva).
- **MÉRT KIVÉTEL (2026-11-02): `gemma4-12b-128k` = 131072.** A KV-cache a
  betöltéskor, a `num_ctx` arányában foglalódik (a súlyok fixek), ezért a
  plafon modellenként MÉRENDŐ, nem önkényes. Mért VRAM (tiszta asztal
  1 996 MiB, 16 303 MiB-os RTX 5080 Laptop): 16K=11 275, 32K=11 590,
  64K=12 287, 96K=12 491, **128K=13 057**, 192K=14 200, 256K=15 282 MiB.
  A 256K önmagában befér, de a valós asztali foglalással (2,5–2,7 GB) már
  túlcsordul (mért: a védőkorlát 15 285 MiB-nál fogta el) — ezért 128K.
  Nagyobb modellnél (méret) a felhasználói szabály: **nem lehet nagyobb, mint
  a `gemma4:12b` (8,0 GB)**.
- **A `num_ctx`-et a MODELL-TAG hordozza, nem a kérés.** Az `/v1` végpont az
  `options.num_ctx`-et és a `think`-et is ELDOBJA (mért: 32K-t kérve is 256K-val
  töltött, 15 050 MiB; `think:false`-ra a reasoning 157 karakter maradt).
  Ezért kell származtatott tag (`providers/Modelfile.gemma4-12b-128k`,
  `PARAMETER num_ctx 131072`) — a blobokat megosztja, nem foglal plusz lemezt.
  A proxy induláskor **kontextus-lintet** futtat, és hangosan jelzi, ha egy
  helyi cél tag-ablaka eltér a `targetContext` értékétől.
- **A gondolkodás a KIMENETI KERETBŐL eszik.** MÉRVE: 200 tokos kérésnél a
  `thinking` 145–786 karaktert vitt el, a `content` ÜRES lett, a válasz pedig
  ép JSON — a proxy HIT-nek látta volna (ugyanaz a hibaosztály, mint a
  `targetContext` esetén). Az egyetlen működő kapcsoló a `reasoning_effort`
  (`'none'` → 0 karakter, 0,2 s; alapból 6,6 s): a proxy ezt KIS keretnél
  (`max_tokens < 2048`) automatikusan injektálja, nagy keretnél meghagyja a
  gondolkodást. Új helyi cél bevezetésekor ezt a viselkedést ne töröld el.
- **`OLLAMA_MAX_LOADED_MODELS=1` miatt két modell egyszerre KIZÁRT**, tehát a
  megnövekedett VRAM SOSEM dupla betöltés. Ha két kliens MÁS `num_ctx`-szel
  hívja ugyanazt a modellt (mért: a mérő `-c 4096`, a delegálás `-c 32768/131072`),
  azok felváltva kilökik egymást, és minden váltás 11–12 s újratöltés. A
  megoldás az azonos ablak, nem a kontextus csökkentése.
  **A 4096-os kliens AZONOSÍTVA (2026-11-02): a weboldal bridge szolgáltatása**
  (node, a nyers `gemma4:12b` tagot tölti `-c 4096`-tal). Ez ALKALMI használat,
  és a felhasználó döntése szerint a 11 s-os váltási költség nem téma — **ezt ne
  vizsgáld újra, és ne állítsd át**. A `OLLAMA_MAX_LOADED_MODELS` emelése tilos
  (a 128K-s gemma4 13 GB, mellé nem fér be második modell a 16,3 GB-os kártyán).
- Teljesítménymérés (retune / chain-doctor) **ne** töltsön be helyi modellt
  teljes kontextussal; a helyi sávot vagy hagyd ki a mérésből, vagy korlátozott
  kontextussal mérd.
- Betöltés után ellenőrizd: **`nvidia-smi` memóriája** — az `ollama ps` és a
  `/api/ps` ezen a gépen MÉRTEN üres listát ad, miközben a modell be van töltve,
  ezért ellenőrzésre alkalmatlan.
- Ha a tartalék modell betöltése 10 GB fölé megy, az hibás konfiguráció, nem
  „lassú gép”.

### 2.1 Windows alatt a helyi Ollama hívása TILOS  (2026-11-11, P0)

**A szabály:** amíg ez a gép Windows alatt fut, **egyetlen komponens sem hívhatja
a helyi Ollamát** (`127.0.0.1:11434`) — sem a DSH, sem az ingyenes delegálási
lánc, sem mérő/ellenőrző szkript, sem bot-job. A tiltás **felhasználói döntés**,
és érvényben marad; az indoklását lásd a következő bekezdésben (HELYESBÍTVE).

**HELYESBÍTETT OK (2026-11-14, a felhasználó pontosítása):** a `2026-11-11`-i
„~22 GB-nál a Windows újraindítja a DSH-t" tünet **valódi oka a rosszul beállított
lapozófájl (virtuális memória) volt** — nem az, hogy a helyi modell és a DSH nem
fér el a 32 GB-on. Azt a beállítást korábban **én rontottam el**, és azóta
javítottam: a lapozófájl most `C:\pagefile.sys`, **32 768 MB kezdő / 65 536 MB
max**, automatikus kezelés nélkül (`AutomaticManagedPagefile = False`, mért
`Win32_PageFileSetting`); a jelenlegi foglalás 32 GB, a csúcs-használat 224 MB
(`Win32_PageFileUsage`). A korábbi kicsi/letiltott lapozófájl mellett a
**commit limit** telt be ~22 GB-nál, miközben a fizikai RAM üresnek látszott —
ezért indította újra a Windows a DSH-t. Ellenőrzés:

```
Get-CimInstance Win32_PageFileSetting   # kezdő/max MB
Get-CimInstance Win32_PageFileUsage     # foglalt + csúcs
```

A tiltás tehát **nem** a „nem fér el a memóriában" miatt van érvényben, hanem mert
a felhasználó így döntött; a lapozófájl javítása óta a 22 GB-os újraindulás oka
megszűnt. A helyi modell memória-szabályai (2. pont) továbbra is élnek.


**Kikényszerítés — két védvonal, mindkettő kötelező:**

1. `providers\config.json`: a route-láncokban **nincs** `ollama/...` cél. A kivett
   láncok az `localOllama.archivedTargets`-ben vannak (7 route), a `local-only`
   route szándékosan **üres láncú** (a proxy `local_ollama_disabled` 503-at ad rá).
2. `providers\proxy.mjs` → `localOllamaGate()`: win32 alatt akkor is tilt, ha
   valaki visszateszi a célokat. A `DSH_ALLOW_LOCAL_OLLAMA=1` környezeti változó
   az egyetlen feloldás (rövid, kézi méréshez); a config `enabled: true`-ja
   Windows alatt **hatástalan**. A `/healthz` `localOllama` mezője kimondja.

**Kapuzott eszközök** (mindegyik a saját fejlécében hivatkozik ide):
`free-guard.mjs` (szabálysértés + hibás kilépés, ha helyi cél kerül a láncba),
`chain-doctor.mjs`, `check-ollama.mjs`, `check-subagent.ps1`, valamint a
`bot\collect\focus-ollama-check.mjs` (a napi fókusz-őr C) ellenőrzése kimarad, és
a job összegzése kimondja a tiltást).

**A DSH közvetlen útja is zárva:** a `~/.dsh/settings.yaml`-ból kivettük az
`ollama-local` providert és a `local-only` modellt (mind az `allowedModels`, mind
a `subagent-worker.models` alól). Ellenőrzés és kivétel:

```
node tools/local-ollama-settings.mjs          # 0 találat kell
node tools/local-ollama-settings.mjs --apply  # ha mégis visszakerült
```

**Linuxra átállás után** a tiltás feloldható; a teendők (mind a 4 hely:
settings.yaml 1–3. blokk, config.json 4. blokk) a
`providers\settings.ollama-local-disabled.yaml` fejlécében vannak. Utána
ellenőrizd a `/healthz` `localOllama.allowed` mezőjét és a `nvidia-smi`-t.

**Amit NE tegyél:** ne „javítsd” úgy, hogy csak a `keep_alive`-t csökkented vagy a
kontextusablakot húzod lejjebb — a tiltás oka nem a kontextus. Ne emeld a
`OLLAMA_MAX_LOADED_MODELS`-t, és ne vezesd vissza a helyi célt a delegálási
láncba „utolsó tartalékként”.

---

## 3. Ütemezett feladatok higiéniája

**Egy feladat = EGY regisztráció.** Ugyanarra a munkára nem élhet két-három
párhuzamos task-név, mert mindegyik külön lefut, és mindegyik ugyanazt a
terhelést indítja (jelen esetben az Ollama-betöltést).

Mért eset (`2026-10-28`): **három** retune feladat élt egyszerre —
`DSH model retune`, `DSH model retune daily`, `DSH model retune weekly` —, három
különböző regisztráló szkriptből. A `register-hidden-retune.ps1` csak az első
nevet állította át, ezért a napi villanás valódi forrása (`… daily`) érintetlen
maradt, és a „javítás” után is felugrott volna.

Kötelező:

- Az új regisztráló szkript a **kanonikus** nevet használja, és `-Force`-szal
  írja felül a meglévőt — ne hozzon létre új nevet.
- Beépítés után: `.\tools\fix-flashing-tasks.ps1` → a saját feladatok között
  **0 találat**.
- A javítás csak akkor kész, ha a **művelet** (`Execute` = `wscript.exe`)
  **és az argumentum** is ellenőrizve van. A riport csak az `Execute`-ot nézi,
  az argumentumok helyességét nem.
- A feladat műveletében `.cmd` / `.bat` shim nem szerepelhet (lásd 1.3).
- Állapotellenőrzés kézzel:
  `Get-ScheduledTask -TaskName 'DSH*' | Select TaskName, State`

### 3.1 Ismétlődő feladat: a `Repetition` blokk

A `<Repetition>` blokk határozza meg az ismétlést. Baj, ha:

- **nincs** `Interval` → a feladat csak egyszer fut;
- van `Duration`, és az **rövidebb** az intervallumnál → az ismétlés a duration
  végén megáll;
- `StopAtDurationEnd=true` **Duration nélkül** → ez volt a mért néma leállás
  állapota (lásd lentebb).

**CSAPDA (saját hiba, 2026-10-28):** a task XML-ben a `<Duration>` MÁSHOL is
szerepel. A `<Settings><IdleSettings><Duration>PT10M</Duration>` a Task
Scheduler **alapértelmezett idle-durationje** — semmi köze a repetícióhoz. Egy
dokumentum-szintű regex ezt olvassa ki, és hamis „Duration=PT10M” diagnózist ad.
**Mindig a `<Triggers> → <TimeTrigger> → <Repetition>` blokkon belül kell
olvasni.**

Mért eset (`2026-10-28`): `HáziRobot due` — a bot naplójában
`2026-10-02` és `2026-10-28` között **egyetlen `job:` sor sincs**, és a hétfői
(10-26) 07:00-s esedékes job sem futott le: a feladat nem tüzelt. A régi
regisztráció `StopAtDurationEnd=true` volt; az új (`schtasks /SC MINUTE /MO 15`)
`false`, és nincs Duration → végtelen ismétlés.

Kötelező:
- Ismétlődő feladatot `schtasks /SC MINUTE /MO <n>`-nel regisztrálj.
- `New-ScheduledTaskTrigger -Once -At ... -RepetitionInterval ...` önmagában
  NEM elég: `StopAtDurationEnd=true`-t hagy maga után.
- Ellenőrzés: `.\bot\register-hidden-task.ps1 -Verify`.
- **A „fut-e egyáltalán” kérdésre a napló a bizonyíték, nem a feladat léte.**
  Ha nincs új bejegyzés a várt időpont után, a feladat halott — a
  konfiguráció kinézete nem bizonyíték.

## 4. Változásnapló

- `2026-11-17` (húszadik kör) — **a „két kattintás” indítás, az 1. asztal
  kikényszerítése, és a hero gombsor egyetlen sorba rendezése.** (1) **MÉRT OK
  (log `11:09:52`–`11:10:30`):** a tálca a launcher első kattintására indult, de
  TISZTELTE a `state\window.closed` jelölőt („a felhasználó bezárta az ablakot —
  a tálca-indulás NEM nyitja meg újra”), ezért csak a tálca-ikon jelent meg; a
  MÁSODIK kattintás jelzésére az ablak a `window-desktop.txt`-ben maradt **2**-t
  nyitotta. A gyökér: (a) a kifejezett indítás (launcher-ikon) ugyanúgy
  viselkedett, mint a bejelentkezéskori autostart; (b) a „friss indítás”
  feltétele a DshWindow **folyamatszám** volt — a 2. asztal ablaka rejtve életben
  maradt, ezért hamis „van már ablak” választ adott, és nem írta vissza az 1-et
  (§1.8); (c) a felügyelet 20 s-os ciklusa miatt az ablak a tickre várt (~24 s).
  **Javítás:** a `DshLauncher` kifejezett indításkor `--show`-t ad át
  (`DshTray.Main(string[])`); ilyenkor a tálca törli a bezárás-jelölőt, és ha
  NINCS **látható** DshWindow (`AnyVisibleDshWindow`), a `window-desktop.txt` 1
  lesz (az élő, rejtett ablak pid-fájlja megmarad, csak az elavultak törlődnek).
  Új, kötött `StartStartupOpener()` szál: 500 ms-onként, max. 120× (60 s, §1.7) a
  megszokott `EnsureWindow`-t hívja, amint a harness figyel — így az első
  kattintásra megnyílik az ablak. Az autostart (Registry `Run` = `DshTray.exe`,
  kapcsoló nélkül) változatlanul tiszteli a jelölőt. (2) **Hero gombsor:** a
  `conversation.input.dock` FÜGGŐLEGES lista (a frontend `composerStack`
  `flex-direction: column`), ezért a külön slot-bejegyzésként regisztrált
  hero-gombok külön sorba estek (robot a bal szélre, költség lejjebb), a PHP /
  1/2 / FTP pedig egyáltalán nem kapott hero-példányt. Most a `dsh-ui-extras`
  hero-sora egy `[data-dsh-hero-actions]` befogadót rajzol, és a többi plugin a
  `react-dom` portállal **oda** teszi a gombját (a slot-bejegyzés `null`):
  `dsh-devadmin` (PHP 60, 1/2 61), `dsh-ftp-deploy` (62), `dsh-hazi-robot` (0),
  `dsh-koltseg` (5) — a portált elemek CSS `order`-je a fejléc-sorrend, tehát a
  hero sor ugyanaz, mint az aktív fejlécé. (3) **A „hanyag hiba” az új
  beszélgetés felületén a GOMBOK elrendezése volt** (a felhasználó pontosítása
  szerint), nem a lábléc összege — a (2) pont portál-javítása pont ezt szünteti
  meg: a hero gombsor egy sorban, a fejléc-sorrenddel jelenik meg. **Az Alibaba
  előtti mínusz NEM hiba, hanem egyeztetett működés:** a `-$0.00` szándékos,
  mert az Alibaba-egyenleg negatívba megy (tartozás-oldal) — ezért a korábbi
  „előjel-levágó” próbálkozást **visszavontuk** (`formatSignedUsd2` törölve, a
  pill újra `"-" + formatUsd2(...)`; a kódban komment mondja ki, hogy senki ne
  „javítsa”). (4) **Tesztek:** ui-extras 1 (hero-befogadó), devadmin 2, ftp 1,
  robot 1, koltseg 10 — mind zöld; a valódi kiszolgált bundle ellenőrizve
  (tartalmazza a `data-dsh-hero-actions` befogadót). (5) **Érvénybe lépés:**
  `bin\DshLauncher.exe` újraépült (a következő kattintás már az); a
  `bin\DshTray.exe.new` / `DshWindow.exe.new` csere a következő természetes
  indításnál (`PendingUpdate.Apply`, §1.5 — a futó tálca/ablak nem lett
  leállítva); a kliens-oldali változások panel-újratöltéssel élnek.

- `2026-11-17` (tizenkilencedik kör) — **a tálca „Kilépés" mostantól MINDEN
  háttérfolyamatot leállít (felhasználói döntés).** A 2026-11-16-i szabály
  („a kilépés otthagyja a munkaablakokat, a következő tálca átveszi őket")
  invazívnak bizonyult, ezért `src\DshTray.cs` → `ExitApp()` most ebben a
  sorrendben állít le: felügyelet/ütemező/asztal-figyelő timerek (előbb, hogy a
  20 s-os tick ne indítsa vissza) → munkaablakok (`HealDesktopPidFromRunningWindow`
  + `StopDesktopWindows`, a ciklus már `DesktopCount()`-ig megy, nem 1..2-ig) →
  harness (`StopPort(_cfg.Port)` = 3080) → LLM-proxy (`StopPort(4123)`) →
  robot-szerver (4180, ha fut) → `state\harness.pid` és `state\harness.url`
  törlése (a következő indítás ne higgye futónak, és ne a halott tokenre
  navigáljon). Minden leállítás **ellenőrzött PID-del vagy port-tulajdonossal**
  megy (§1.6: név szerint soha). A napló kimondja a maradék `DshWindow`
  darabszámot (`tálca kilépés kész (maradék DshWindow: N)`).
  **Érvénybe lépés:** a build `bin\DshTray.exe.new` (60 416 B) — a futó tálca
  zárja a `DshTray.exe`-t, ezért a csere a **következő tálca-indításnál**
  automatikus (`PendingUpdate.Apply`). Onnantól a „Kilépés" a futó sessionöket
  is megszakítja — ez a kért viselkedés, a session-naplók tartósak.

- `2026-11-17` (tizennyolcadik kör) — **MÉRVE: a küszöb-alapú (szelíd) tömörítés
  SOHA nem fut le; a `thresholdRatio` hatástalan knob.** A kiváltó eset: az
  Antikolt session (`session-5d611e3c`, 23 kör / 689 lépés) ágense azt írta,
  hogy „a munkamenet-tárhelyem gyakorlatilag elfogyott”. **A „tárhely” a
  kontextus-ablak**, nem lemez: a kérés 255 662 token volt a DeepSeek valódi
  1 048 576-os ablakából (**24%**), a harness mérője 1 000 000-hoz mér. A session
  egyetlen kemény hibája a 13. körben (08:44:54): `CONTEXT_WINDOW_EXCEEDED`,
  mert **792 685 (üzenetek) + 256 000 (completion) = 1 048 685 > 1 048 576** —
  a `maxTokens` (a `dsh-llm-deepseek` gyári defaultja, `lib/index.js:1394`) az
  ablak 24%-át lefoglalja, ezért a valódi üzenet-plafon **792 576**.
  **A mérés (40 session, 57 compaction esemény, 2026-09-26 … 11-17):** minden
  tömörítés 771–795 ezer tokennél történt, azaz a plafonnál, a 400-as válasz
  UTÁN; egyetlen küszöb-alapú tömörítés sincs, akármi a `thresholdRatio`
  (0.30 / 0.45 / 0.80). A kód szerint a döntés a `compactIfNeeded()`-ben van
  (`measurement.totalTokens < spec.thresholdTokens`), a hibát a plugin csak
  `logger.warn`-nal nyeli el, a harness stderr-je pedig nincs mentve — ezért
  láthatatlan. **Folt (diagnosztika):** `tools\patch-compaction-diag.mjs`
  (`--check|--apply|--revert`, mentés `*.diag-bak`) minden lépésnél egy sort ír
  a `~/.dsh/compaction-diag.log`-ba: `measure=… threshold=… window=… ratio=…`,
  illetve a kivétel szövegét és a „nincs cél” ágat. A viselkedést nem
  változtatja; **a harness következő indulásakor** él (§1.5 — újraindítás csak
  a felhasználó engedélyével). A mérés után jön a valódi javítás; a
  `maxTokens`-t addig **nem** csökkentjük, mert az a gyári defaulttal az
  egyetlen működő triggert (792 576) **későbbre** tolná (1 015 808).
  Tanulság: a kontextus-problémára NE a `thresholdRatio`-t tekerjük tovább —
  először azt kell bizonyítani, hogy a szelíd út egyáltalán lefut.

- `2026-11-17` (tizenhetedik kör) — **költségelszámolás: pillanatkép + gyorsítótár,
  duplikált chip ki, és a maximalizált indulás javítása.** (1) **Pillanatkép:**
  a felhasználó jelezte, hogy „minden megnyitásnál újra generálja, várni kell”.
  Két réteg: a **host** `measure` válasza **90 s-ig gyorsítótárazott** (a kulcs a
  KÉRÉS paramétereiből épül — a feloldott `from`/`to` között ms-ok telnek el,
  ezért azzal a kulcs sosem találna; `?fresh=1` megkerüli, a config mentése
  törli), a **kliens** pedig a legutóbbi eredményt `sessionStorage`-ban tartja, és
  megnyitáskor **azonnal kirajzolja** („Pillanatkép: HH:MM — a friss mérés fut…”),
  a friss mérés a háttérben fut és felülírja; hibánál a pillanatkép MARAD. A
  „Frissítés” gomb egyszer `fresh=1`-gyel kér. (2) **Duplikált chip ki:** a
  composer dock (a panelek alja) már csak aktivitást mér, gombot nem rajzol — a
  gomb a menüsorban (fejléc-ikon), illetve üres beszélgetésnél a composer fölötti
  sávban van. (3) **A maximalizált indulás visszatérő hibája** („számítógép
  újraindítás után nem teljes képernyőn indul, pedig be van kapcsolva”): a
  beállítás (`tray-config.json` → `maximized: true`) az INDÍTÁSNÁL érvényesült,
  de a későbbi **megjelenítési utak** (`ShowWindow` tálcaikonra, asztalváltás,
  „látható ablak helyreállítása”) `SW_SHOW`/`SW_RESTORE`-t hívtak, ami normál
  méretre viheti az ablakot. Új `EnsureMaximized(asztal)` fut a
  `ShowDesktopWindow`-ban, a `ShowWindow(true)`-ban és az `ApplyDesktopOnce`
  végén: ha a beállítás aktív és az ablak nincs zoomolva, `SW_MAXIMIZE`. Csak
  megjelenítéskor fut, tehát a felhasználó kézi visszaállítását nem írja felül.
  **MÉRVE** (valódi ablakon, Win32 `GetWindowPlacement`/`IsZoomed`): előtte
  `zoomed=True` → `SW_RESTORE` → `False` → tálca-jelzés (`DshHarnessShowWindow`)
  → **`True`**, napló: `ablak maximalizalva (asztal 1, a beallitas szerint)`.
  Tálca újraindítva (a felhasználó kérésére, §1.5): `tray.pid` **3476**,
  `bin\DshTray.exe` **58 880 B / 05:58:54**; a `DshWindow.exe.new` a következő
  ablaknyitásnál lép életbe. Tesztek: **52/52** (engine 31, kliens 9, host 12,
  köztük az új gyorsítótár-teszt). Kliens-változás → **panel-újratöltés**.
  **INCIDENS UGYANEBBEN A KÖRBEN (a felhasználó azonnal jelezte): „egy
  MediaContextNotification ablak van előtte, a tálca befagyott”.** OK: az új
  `EnsureMaximized` a `WindowHandleOf`-fal kérte a fogantyút, az pedig a frissen
  indult ablaknál (a keret címe még nem áll) a `HwndWrapper[…]` osztályú
  **segédablakra** esett — a `SW_MAXIMIZE` azt tette LÁTHATÓVÁ a valódi ablak
  előtt (mért: `pid=… vis=True title='MediaContextNotificationWindow'` a
  `title='DeepSeek Harness'` keret mellett). **Javítás:** (a) a segédablakot
  `SW_HIDE`-dal elrejtettem (azonnali helyreállítás), (b) az `EnsureMaximized`
  mostantól **csak igazolt keretablakon** dolgozik: LÁTHATÓ + pontos termékcím
  (`DeepSeek Harness`), különben nem tesz semmit, (c) a `FindWindowForProcess`
  soha nem választja a `MediaContextNotificationWindow` / `CiceroUIWndFrame` /
  `SystemResourceNotifyWindow` című ablakokat. Újraépítés + tálca-újraindítás:
  `tray.pid` **12052**, `bin\DshTray.exe` **59 392 B / 06:16:36**. **MÉRVE
  utána:** látható ablak **egy** (`pid=14232 zoomed=True title='DeepSeek
  Harness'`, előtérben), a tálca-jelzésre (`DshHarnessShowWindow`) sem helper,
  sem új ablak nem jelent meg, napló: `asztalvaltas kesz: aktiv=1
  lathato=[14232]`. **Tanulság:** a `FindWindowForProcess` „HwndWrapper”
  tartaléka a WPF segédablakokra is illik — minden `ShowWindow`-előtti
  műveletnél cím-ellenőrzés kell.

- `2026-11-17` (tizenhatodik kör) — **a költségelszámolás panel megjelent, de nem
  mért; ezres tagolás.** (1) **A panel látszik** (a mérő regisztrációjából
  renderelt seat), de minden érték 0 volt, és a fejléc **„Munkaterület: lib”**-et
  írt: a mérés a host saját munkakönyvtárára esett
  (`…\@deepseek-ai\dsh\lib`), ezért 0 session-t talált. **OK:** a slot-props NEM
  tartalmazza a `sessions` szolgáltatást, a plugin pedig a `inject`-tel átadott
  props miatt nem is renderelt — ezért a szolgáltatásokat most az `apply(ctx)`
  menti el (`pluginServices`), és a munkaterületet ebből oldjuk fel, a
  `dsh-ui-extras` `resolveWorkspace` három fokozatával (session `cwd` →
  kiválasztott workspace → első workspace). A **host** is feloldja, ha a kérés
  nem mondja meg: a session naplófejlécének `cwd` mezőjéből (`resolveWorkspace`
  most `async`), és a session-keresés **fájlnév-egyezéssel** megy (az összes
  napló kibontása 20+ s volt — mért). (2) **MÉRVE** a javítás után, közvetlen
  host-hívással a mostani session-re: 7 kör, agent **89,1 perc**, olvasás
  **50,5**, gépelés **1,8**, aktív 126,1 perc → elszámolható **141 perc** =
  **29 375 Ft** — tehát a motor jó, csak a munkaterület volt rossz. (3) **A
  nyitott kör nem fújódik fel:** eddig a „mostani idővel” zártuk, ezért egy
  órákig nyitva hagyott kör felfújt agent-időt adott; mostantól az **utolsó
  naplózott esemény** idejével zárul (dolgozó körnél friss, elhagyottnál ott áll
  meg, ahol a szerver abbahagyta) — teszt is őrzi. (4) **Ezres tagolás kis
  hézaggal:** az óradíj mező mostantól `type="text"` + csoportosítás
  (`12 500`, U+00A0), a végösszegek ugyanazzal a `groupDigits`-szel mennek (a
  `type="number"` nem enged szóközt — ezért nem lehetett eddig). (5) **JSON
  kulcs-ütközés javítva:** a válasz `toDay` ÉS `today` kulcsot is adott, amit a
  PowerShell `ConvertFrom-Json` (kis/nagybetű-érzéketlen) nem tudott olvasni →
  `currentDay`. (6) **Host-oldali változások** (munkaterület-feloldás,
  nyitott-kör szabály, `/koltseg/log` végpont, JSON-kulcs) a **következő
  harness-indításnál** élnek; a kliens-oldali feloldás és a formázás
  **panel-újratöltéssel**. Tesztek: **51/51** (engine 31, kliens 9, host 11).

- `2026-11-17` (tizenötödik kör) — **a becsukott ablak újranyitása: a tálca
  régi binárisa + a jelölőt felülíró ág; és a költségelszámolás ikonja a `hero`
  fázisban.** (1) **A panasz:** „X-szel bezárom, és magától újra megnyílik”.
  **MÉRT OK:** a futó `bin\DshTray.exe` a **10:30-as** build (57 856 B), amely
  NEM ismeri a `state\window.closed` jelölőt; a javított forrás 17:12-kor kész
  volt, de a `.new` (58 368 B) sosem lépett életbe, mert a tálca 17:06 óta
  folyamatosan futott. A napló kimondja a láncot: `02:17:32 asztalvaltas -> 1`,
  majd `02:17:46 munkaasztal 1 inditas (3 panel)` / `02:17:47 lathato ablak
  helyreallitasa (asztal 1)` — a MÁSIK asztal ablaka élt (rejtve), ezért a
  „nincs látható ablak” valódi hibának látszott. (2) **Forrásjavítás
  (`src\DshTray.cs`):** az `EnsureWindow()` élő-ablak ágában eddig FELTÉTLENÜL
  törölte a jelölőt (`ClearCloseMarker()`, 789. sor) — mostantól a jelölő
  **elsőbbséget élvez** (korai `return`, egyszeri naplózással); az explicit
  asztalváltás (`ApplyDesktopOnce`) viszont törli, mert az kifejezett kérés.
  (3) **Újraépítés + élesítés:** `build.ps1` → `bin\DshTray.exe.new` 58 880 B;
  a tálca újraindítva (a felhasználó engedélyével, §1.5): új `tray.pid` 18816,
  `bin\DshTray.exe` most 58 880 B / 02:24, a `DshWindow.exe.new` a következő
  ablaknyitásnál lép életbe; **a DSH-ablak és a session végig élt** (mért:
  `asztalvaltas kesz: aktiv=1 lathato=[18868]`, harness pid 15432 változatlan).
  (4) **A `tools\restart-tray.ps1` HALOTT VOLT:** csak `powershell.exe`-t
  keresett, ezért a C# tálcát (`DshTray.exe`) nem találta meg, és „csak
  elindítom” ágon egy második példányt indított — a javítás így sosem lépett
  volna életbe. Mostantól a PID-fájlból (ellenőrzött útvonallal, meghajtóbetű
  nélkül egyezve — a repó `C:` alatt is elérhető), folyamatnévből, illetve a
  régi naplóból azonosít, leállítás után **kicseréli a `.new`-t** (copy+delete,
  mert a `Move-Item -Force` nem ír felül), és csak akkor nyúl a
  `DshWindow.exe.new`-hez, ha nem fut ablak. (5) **A költségelszámolás ikonja
  nem látszott:** a host FÉL élt (a `cordis` loader a patch-fájl változására
  betöltötte: `/koltseg/ping` → **200**, a kliens-modul benne van a kiszolgált
  HTML-ben `dsh-koltseg/client.js&rev=23479dae18db`, az aktivitás-mérő pedig
  02:21-kor írt a `state\koltseg\activity.jsonl`-ba) — a gomb viszont csak a
  fejlécben volt regisztrálva, a fejlécet pedig a **`hero` fázis elrejti**. Így
  a gombnak most **két példánya** van (`conversation.session.header.utilities`
  + `conversation.input.dock`, `heroVariant`, a `dsh-ui-extras` mintájára), és
  az aktivitás-mérő is mindkét slotban regisztrálva van, **referenciaszámlálóval
  (egyszerre egy figyelő)**. Kliens-változás → **panel-újratöltés** elég.
  (6) **Teszt-higiénia:** a host teszt a valódi `state\koltseg.log`-ba írt, és a
  napló alapján úgy tűnt, mintha a host elindult volna — mostantól a
  `DSH_KOLTSEG_STATE_DIR` ideiglenes könyvtárat ad, tehát a teszt nem hagy
  nyomot. Tesztek: **48/48** (engine 31, kliens 8, host 9).

- `2026-11-16` (tizennegyedik kör) — **fejlesztési költségelszámolás (új plugin).**
  Új plugin `plugins\dsh-koltseg` (host + kliens): a menüsor **érme-ikonjára**
  (tooltip) nyíló **lebegő ablak**, alap óradíj **12 500 Ft**, repónként
  felülírható a felületről (a díj a központi `state\koltseg\config.json`-ban él —
  a repókba nem írunk). (1) **Mérés:** szerver oldali munkaidő = `turn/start` →
  `turn/end` a tartós session-naplóból (a helyi Ollama is benne; a delegált
  session a szülő idejében van, ezért nem duplázunk), háttérmunkák (becslés,
  0 súly), olvasás/gépelés (kliens-oldali aktivitás-vödrök + napló-alapú
  tartalék), valós aktív idő (intervallum-unió). (2) **Profilok:** `alap`
  (gépidő + emberi), `gepido`, `emberi`, `brutto` + egyedi súlyozott profil;
  a felhasználó döntése szerint **percre pontos, kerekítés nélkül**, ÁFA
  kapcsolható, a token-önköltség **opcionális** (alapból ki, mert az óradíj
  magában foglalja). (3) **Hatókörök:** munkafolyamat / munkaterület / dátum
  intervallum (magyar naphatárral, DST-helyesen). (4) **MÉRVE** a valódi
  naplókon (`node tools\check-koltseg.mjs`): 30 nap, 33 munkafolyamat, 387 kör →
  agent **27,26 h**, olvasás **15,52 h** (napló-alapú), aktív idő **43,29 h**,
  elszámolható **2567 perc** → **534 792 Ft** 12 500 Ft/órán; a mérés 6,5 s.
  Tesztek: **48/48** (`engine` 31, `client` 8, `host` 9), a host végpontok a
  valódi handlerekkel, a kliens stubolt React-tel. Telepítés megtörtént
  (`install.ps1`: junction + `- insert: koltseg`, `-Check` zöld: `webServer`,
  `measure=function`, `kliens=ok`); a host végpontok a **következő
  harness-indításnál** élnek (§1.5 — futó munka közben tilos újraindítani), a
  kliens fél panel-újratöltéssel. Dokumentáció: `docs\KOLTSEG-ELSZAMOLAS.md`
  (használat) + `docs\KOLTSEG-ELSZAMOLAS-TERV.md` (terv és döntések), angol
  tükörrel. **A kétnyelvűség teljes:** a hiányzó `docs\FTP-DEPLOY.md` és
  `docs\FTP-DEPLOY-TERV.md` angol tükör is pótolva, a
  `node tools\check-docs-bilingual.mjs` **23 magyar · 23 tükör · 0 hiányzó**
  (`exit 0`); mind a 6 érintett doksiban oda-vissza nyelvi hivatkozás van.
  **Tanulság:** a legfrissebb napló lehet FUTÓ session (nincs lezárt
  kör), ezért a mérés a nyitott kört a mostani idővel zárja; a munkaterület-
  szűrés a fejlécből (első zstd frame) megy, különben a több száz megás naplók
  lassítanák a felületet.

- `2026-11-16` (tizenharmadik kör) — **három javítás.** (1) **A becsukott ablak
  nem nyílik újra:** a tálca induláskor feltétel nélkül törölte a
  `state\window.closed` jelölőt, ezért egy tálca-újraindulás után az ablak
  visszajött. Most csak akkor törli, ha a jelölő a mostani **boot előtt**
  keletkezett (`GetTickCount64`, mert a .NET 4.8-ban nincs `Environment.TickCount64`
  — a build meg is mutatta). (2) **Maximalizált indulás:** a `WindowState` a
  `Loaded`-ban újra beállítva, és a valódi Win32 állapot naplózva
  (`window placement after load: showCmd=…`, 3 = maximalizált) — mérés, nem
  találgatás. (3) **FTP napló:** a host `{log: "sor\nsor"}` sztringet ad, a panel
  `.join`-t hívott → `logLines.join is not a function`; most sorokra vágja.
  `bin\DshWindow.exe.new` + `bin\DshTray.exe.new` kész.

- `2026-11-16` (tizenkettedik kör) — **három mért hiba: a látható konzolablakok
  VALÓDI forrása, a Kiadás gomb aktív maradása, és az üres FTP fül.** (1) **A
  konzolablakok a `dsh-subprocess-local`-ból jönnek, NEM a `dsh-win32-process`-ből.**
  Ablak-figyelővel (EnumWindows + CIM folyamatlánc) mérve: a látható
  `ConsoleWindowClass` címe a `node.exe` útvonala, a folyamat a
  `dsh-subprocess-local\lib\runner.js`, a szülője a harness, a gyermeke az ACL
  runner és a pwsh — tehát a `launchWindowsJob` spawn-ja
  (`index.js` ~499–507) **`windowsHide` nélkül** indított, és a gyermekek
  örökölték a látható konzolt. Javítás: `windowsHide: true` (a
  `tools\patch-sandbox-no-window.ps1` mostantól **ezt is** alkalmazza és
  `-Check`-kel ellenőrzi; a mag-folt a DSH-frissítés után újrafuttatandó).
  **Az első körös STARTUPINFO-folt helyes, de másik modulra készült** — a
  konzol titka a `windowsHide` hiánya volt. (2) **A Kiadás gomb azért maradt
  aktív a v0.2.8 kiadás után, mert a státuszfájl BOM-mal íródott** (a
  `Set-Content -Encoding utf8` BOM-ot tesz, a `JSON.parse` elutasítja) → a host
  „nincs kiadás" állapotot adott.
  Javítás: a host BOM-ot levág, a `release.ps1` BOM nélkül ír, a kliens pedig
  MINDEN lezáró ágban (`done`/`failed`/`none`/`stale`/timeout) frissíti a
  git-snapshotot, mert a gomb inaktivitása a `releaseTag`-en múlik. (3) **Az FTP
  fül üresen nyílt meg:** a `sidebar.right.pane.tab` regisztrációból hiányzott a
  **`locale: NS`**, amiből a slot a `t`-t köti (a `dsh-ui-extras` terminál-fülje
  is így csinálja) → a törzs nem renderelt. Javítás: `locale` + defenzív
  `props` + **hiba-határ** (kivételnél a fül a hibaüzenetet írja ki a fehér helyett)
  + host-napló diagnosztika (`/ui-extras/log`: mount + crash). A fejléc-gomb
  mostantól **ikon + tooltip** (SVG feltöltés-nyíl, 26 px, felirat nélkül — a
  felhasználó kérése). Tesztek: **41/41** (a kliens-bundle stubolt React-tel:
  betöltés, regisztrációk, `locale`, render props nélkül is, hiba-határ).

- `2026-11-16` (tizenegyedik kör) — **FTP deploy: panel + gyorsgomb, a Felpuffantó
  motorjával.** (1) **Új plugin `plugins\dsh-ftp-deploy`** (host + kliens): a
  `src\engine\*.ts` (Felpuffantó 0.1.5, `bcf25fd`) **portja** JS-re —
  `ftp.js` (feltöltés/törlés/ZIP/mappa-lista), `gitdiff.js` (`simple-git`
  helyett a host `execFile("git")`), `tree.js`, `deny.js`, `remoteDirs.js`,
  `profiles.js`, `secrets.js` (DPAPI), `deploy.js` (vezérlés), `log.js`,
  `runner.js`. A mért viselkedés megmaradt: **3 próba `[3 s, 8 s]`** csak
  átmeneti hibára (`530`/`550`/`552`/`553` azonnal áll), fázis-napló + távoli IP
  a hibaszövegben, `RemoteDirIndex` (a `basic-ftp` vakon MKD-zott: ~84 `550` sor
  egy 12 fájlos pushnál), **80 fájl** felett megerősítés. (2) **Függőségek
  beágyazva:** `basic-ftp` 5.3.1 + `yazl` 3.3.1 + `buffer-crc32` 1.0.0 (MIT) a
  `plugins\dsh-ftp-deploy\vendor\node_modules` alatt — nincs `npm install` a
  felhasználónál, a telepítő offline is működik. (3) **ÉLŐ, CSAK OLVASÓ
  ellenőrzés** (a felpuffantós `%APPDATA%\Felpuffanto\profiles.json` +
  `secrets\*.dpapi` importja után, 3 élő profil: `TGYO-L12`, `jelentkezes-redirect`,
  `atoktatas-redirect`): kapcsolat-teszt `cwd=/` **OK**; távoli lista
  `/web/laravel12` → app, bootstrap, config, database, home, lang, packages,
  public, resources, routes, storage, vendor; előnézet mindhárom profilra
  **0 fájl** (a baseline == HEAD, tehát minden fent van); ZIP-mentés próba a
  `public\build`-ra: **82 fájl, 13,3 MB → 3,58 MB ZIP**, érvényes `PK` fejléc.
  ÉLES FELTÖLTÉS eddig **nem** történt (az csak a felhasználó kattintására megy).
  (4) **Két port-hiba javítva:** a `git rev-parse` (a simple-git `revparse()`
  API-ja mögött ezt rejtette → a `revparse` parancs nem létezik, ezért a HEAD
  `null` volt és az előnézet hamis „0 fájl”-t adott), és az `isSafeRelPath`
  (a `posixRel` leveszi a `/`-t, ezért az abszolút út átcsúszott — most a
  normalizálás ELŐTT utasítja el). (5) **Kliens:** „FTP deploy" fül a jobb
  oldalsávban (profil, jelszó, előnézet, deploy, extra, távoli mappa, ZIP-mentés,
  napló) + `⤴ FTP` fejléc-ikon; a **Git panel `FTP deploy` gyorsgombja a `Kiadás`
  ELŐTT** áll, profil nélkül `FTP beállítás` felirattal az FTP fület nyitja
  (`ftpOpenRef` a `dsh-ui-extras`-ban), futás közben inaktív. (6) **Tesztek:
  36/36** (`node --test`, hálózat nélkül: deny/allow, `RemoteDirIndex` fake
  klienssel, git-diff valódi temp repóval, profil-tár BOM-mal, DPAPI oda-vissza,
  retry-osztályozás, ZIP-név). Telepítés megtörtént (`install.ps1`: junction +
  `- insert:`), `-Check` zöld; a **host végpontok a következő harness-indításnál**
  élnek (§1.5), a fül/gomb panel-újratöltéssel. Részletek: `docs\FTP-DEPLOY.md`,
  `docs\FTP-DEPLOY-TERV.md`.

- `2026-11-16` (tizedik kör) — **a Kiadás gomb némítása, ha a legújabb commit már
  kiadott.** (1) **A panel-szintű szabály:** ha a legfrissebb commiton kiadási tag
  van (`releaseTag` a git-snapshotban), VAGY a legfrissebb commit maga a
  `Release vX.Y.Z` commit (a `tools\release.ps1` minden kiadást így zár, ezért ez
  a régi hosttal is működik, újraindítás nélkül), a gomb **„Kiadva”** felirattal
  inaktív, a tooltipje kimondja a tagot; ha van függő commit, a tooltip azt is
  kiírja (`sinceRelease`). (2) **Host-oldali kényszer:** a `release` végpont
  elutasítja a kérést, ha a HEAD-en kiadási tag van (elavult panel se tudjon
  duplikált kiadást indítani); a `?dry=1` próbaút kivétel. Új snapshot-mezők:
  `releaseTag`, `lastReleaseTag`, `sinceRelease`. (3) **MÉRT ÁLLAPOT a javítás
  előtt:** a HEAD `36f99cd` **nincs** tagelve (`git tag --points-at HEAD` üres),
  és a v0.2.7 óta a `plugins\dsh-ui-extras\lib\index.js` is változott (valódi
  javítás: `detached: false` kiadás-indítás), tehát ott a gomb **helyesen aktív**
  — a kiadás indokolt; a következő kiadás után automatikusan „Kiadva” lesz, amíg
  új commit nem jön. A kliens-oldali szabály panel-újratöltéssel él, a
  host-oldali kényszer a következő harness-indulásnál.

- `2026-11-16` (kilencedik kör) — **a titok-audit hamis találata, a konzolablakok
  VALÓDI oka, és a Kiadás gomb egyidejűsége.** (1) **A kiadás elbukott a
  titok-kapun:** a MOSTANI fában 2 találat volt — `tools\patch-sandbox-no-window.ps1`
  28. és 68. sora: a `CREATE_NO_WINDOW` konstans DECIMÁLIS értéke (kilenc jegyű
  szám), amit a minta TAJ-számnak lát. Ezt hex alak (`0x08000000`) és név szerinti
  hivatkozás váltotta, így az audit
  0 találat → `exit 0` (a git-előzményben maradt találat csak figyelmeztetés).
  **Tanulság: 9+ jegyű számot ne írj a szkriptekbe.** (2) **A látható `node.exe`
  konzolablakok valódi oka:** a `CREATE_NO_WINDOW` NEM elég — a gyermeknek így
  egyáltalán nincs konzolja, ezért amikor Ő indít konzolos programot (`node`,
  `git`, `pwsh`), a Windows ÚJ, LÁTHATÓ ablakot ad neki (mért: a 13:02-es
  újraindítás UTÁN is jöttek ablakok 13:12:23-kor és 13:12:30-kor). Helyes módszer
  (ezt teszi a Node `windowsHide` is): `STARTUPINFOW` `dwFlags = 256 | 1`
  (`STARTF_USESHOWWINDOW`) + `wShowWindow = 0` (`SW_HIDE`), a létrehozási jelzők
  maradnak az eredetiek (`0`, `4`, `1028`) — a rejtett konzolt a gyermekek
  ÖRÖKLIK. `tools\patch-sandbox-no-window.ps1` ezt alkalmazza, a korábbi hibás
  foltot visszafordítja, idempotens (`-Check` OK), DSH-frissítés után újrafuttatható.
  (3) **A Kiadás gomb egyidejűsége:** a futás tényét eddig a státusz-fájl pid-je
  döntötte el, a pid viszont a hostból nem mindig ellenőrizhető → a gomb újra aktív
  lett egy FUTÓ kiadás mellett. Most a host `inFlight` mezőt ad (állapot + 45 perces
  életkor), a panel nyitáskor `probeRelease()`-szel kérdez rá, a gomb addig inaktív
  („Kiadás fut…"), a spawn hibája is nyomot hagy. (4) **A dupla hibaüzenet
  megszűnt:** a végleges üzenet (kész/hiba) CSAK az alsó sorban jelenik meg, a
  felső sor csak a folyamatjelzést (⏳) mutatja. Az audit-blokkoló javítása után a
  v0.2.7 kiadás lefut (commit `97e00bd`, portable ZIP 2,45 MB + telepítő EXE
  2,48 MB, `isDraft:false`). (5) **A Kiadás gomb „néma” indulásának VALÓDI oka:
  `detached: true`.** MÉRVE (marker-fájlos próba): leválasztva a gyermek
  `powershell.exe` SOHA nem fut le (`DETACHED_PROCESS` → nincs konzol → a Windows
  PowerShell 5.1 azonnal elhal), leválasztás nélkül 1/1 lefut. Ezért a host
  `detached: false`-szal indít (`stdio: ignore`, `windowsHide: true`), a gyermek a
  harness alatt fut (a kiadás ideje alatt a harness úgyis él). Ellenőrzés: a
  javított spawn `-DryRun`-nal lefuttatta a szkriptet (transcript kész, terv
  kiírva, `exit 0`). Új `dry=1` paraméter: a gomb útvonala éles kiadás nélkül
  próbálható.

- `2026-11-16` (nyolcadik kör) — **a „Kiadás" gomb teljes értékűvé tétele + v0.2.6
  kiadva.** (1) **A lánc ellenőrzése és ÉLES futtatása:** a gomb a
  `/ui-extras/github-action?action=release` végpontot hívja, a host pedig
  `powershell … tools\release.ps1 -Yes` folyamatot indít **leválasztva**
  (`detached`, `stdio: ignore`). Ugyanezt a parancsot kézzel futtatva a **v0.2.6**
  kiadás elkészült és **közzé lett téve** (portable ZIP 2,36 MB + telepítő EXE
  2,39 MB, `isDraft:false`), a push `8a4d021..9925d48`. (2) **Két hiányosság
  javítva:** (a) a `gh release create --generate-notes` ebben a repóban csak a
  „Full Changelog" sort adta — mostantól a szkript a **commitokból** írja a
  jegyzetet (telepítési linkekkel, a kiadás-commit és a build generálta
  bináris-frissítés kihagyásával), a v0.2.6 jegyzetét utólag is kicseréltük;
  (b) a gomb eddig **nyomtalan** volt (a kimenet a leválasztott folyamatban
  elveszett) — mostantól a szkript `Start-Transcript`-tel **`state\release-log.txt`**
  naplót ír (2 MB fölött rotál), a `Fail` pedig lezárja. (3) **A gomb valódi
  állapot-visszajelzést kapott:** a host új `action=release-status` végpontja a
  `state\release-status.json`-t adja vissza (állapot, pid, tag, url, hiba,
  napló-tail, `alive`), a panel 2 s-onként pollozza **legfeljebb 10 percig**
  (kötött ciklus, §1.7), és kiírja: „Kiadás fut…" → „Kész: vX — <link>", illetve
  hiba esetén a **napló utolsó soraival**; a gomb futás közben **letiltott**, a
  host pedig **elutasítja a második kiadást**, amíg az előző folyamata él.
  MÉRVE: a hibás-verziós próba (`-Version 1.2`) `state\release-status.json`-ba
  `{"state":"failed", … "error":"érvénytelen verzió…"}`-t írt. **Érvénybe lépés:**
  a szkript-oldal azonnal él, a host-oldali végpont/gombhoz **harness-újraindítás**
  kell (§1.5 — felhasználói engedély), a kliens-oldali pollozáshoz **panel-újratöltés**
  (a harness-újraindítás a pid-váltással ezt is elvégzi). Nyitva: a panel még nem
  mutatja a teljes naplót (csak a hiba utolsó sorait) — igény esetén bővíthető.

- `2026-11-16` (hetedik kör) — **az ablakok maximalizált indulása (felhasználói kérés)
  + az alügynök-fül.** (1) **Miért kellett kézzel kinagyítani minden indításnál:** a
  `DshWindow` a geometriát a `RestoreBounds`-ból menti (hogy maximalizált ablakból
  is a helyes NORMÁL méret jöjjön vissza), ezért a maximalizált **állapot** nem
  öröklődött. Javítás: a `state\window-geometry.txt` mostantól `maximized=0|1`-t is
  tárol, induláskor pedig a sorrend **CLI (`--maximized` / `--no-maximized`) > a
  tálca `tray-config.json` `maximized` kulcsa > a mentett állapot**. Új tálca-menü:
  **„Ablakok maximalizálva nyíljanak"** — menti a configba, és a MOST futó aktív
  ablakot azonnal átállítja (`ShowWindow` `SW_MAXIMIZE`/`SW_RESTORE`), tehát ehhez
  nem kell ablakot újraindítani. A `StartDesktopWindow` a beállításnál
  `--maximized`-et ad át. **Fontos üzemeltetési tény:** a tálca MENÜJE csak akkor
  jelenik meg, ha a tálca binárisa is frissült (`bin\DshTray.exe.new` készült; a
  csere a következő természetes tálca-indulásnál történik) — a **hatás** viszont
  már most él, mert a `DshWindow` a config-fájlt maga is olvassa
  (`WindowGeometry.ReadTrayMaximizedPreference()`), tehát egy ablak-újraindítással
  a `maximized: true` érvénybe lép. (2) **Alügynök-fül** (`dsh-ui-extras` kliens,
  `uix-subagents`, order 30): a beszélgetés alügynökeit a fejléc „N alügynök ⌄"
  sora helyett fülön mutatja — az adat ugyanaz (`subagentsByParent[sessionId]`
  katalógus + `byId` session-összegzések), kattintásra `ctx.sessions.openSubagent()`,
  „Frissítés" gombbal; a fejléc-sort a `conversation.session.header.lineage`
  (**single**) slot `priority: -100`-as árnyékolása rejti el. **MÉRT TANULSÁG:** a
  slot-duplikáció a `(id, priority)` párra megy — azonos prioritás **dob**, ezért
  kell eltérő (alacsonyabb) prioritás; ezt a kliens-napló
  (`state\ui-extras-client.log`) mondta ki. A két fül a betöltés után **0 hibával**
  regisztrált (48 új naplósor, 0 hiba), az ablakok initje is hibamentes.

- `2026-11-16` (hatodik kör) — **a „Háttérmunkák" fül befejezése: a slot-szabály, az
  üres nézet és a két fantom-háttérmunka.** (1) **A gyári jelző elrejtése CSAK
  priority-vel megy:** a kliens-napló (`state\ui-extras-client.log`) kimondta, hogy
  az azonos id-jű, AZONOS prioritású újraregisztrálás **nem cserél, hanem dob** —
  `list slot "conversation.session.header.actions" already has an entry with id
  "job-list" at priority 0 … register at a different priority to shadow it (lowest
  renders)` (a szabály a `dsh-web-frontend` bundle-ben: a duplikáció-ellenőrzés
  `(id, priority)` párra megy). Ezért a `job-list` bejegyzést `priority: -100`-zal
  regisztráljuk felül (a legalacsonyabb renderel) — a korábbi, azonos prioritású
  próbálkozás dobott, ezért maradt látszólag a jelző. (2) **Az üres fül oka: rossz
  adatforrás.** A nézet a terminál-panel futásait kérte le
  (`/ui-extras/cmd?action=runs`), miközben a jelző a **session** munkáit számolja
  (`useSessions(state => state.jobsBySession[sessionId])`) — ezért tűnt üresnek.
  Mostantól a nézet a session-munkákat mutatja (a gyári jelző pontos adatforrása),
  külön szakaszban a panel-futásokat, és **hiba esetén is ír ki szöveget** (a
  láthatatlan tartalom a legrosszabb diagnózis). A gyári chip-et árnyékoló
  komponens `null`-t ad, a fül címkéje változatlanul HU/EN. (3) **A „2 beragadt
  háttérfolyamat" valójában két fantom-rekord**: `job_list` →
  `recovered-27820 [recovered] running — process (pid 27820)` és
  `recovered-28304 … (pid 28304)`. A pid-ek NEM munkafolyamatok, hanem a tálca
  két gyermeke (CIM-mel ellenőrizve): `27820` = a **harness** (`bin.js web --port
  3080`), `28304` = az **LLM-proxy** (`providers\proxy.mjs --port 4123`), mindkettő
  `ParentProcessId 9528` (DshTray). A helyreállítási logika tehát a spawner-pideket
  „process" munkaként vette fel → **ezeket TILOS `job_kill`-elni** (a harness/proxy
  halálát okozná); a rekordot a mag állítja elő, ez nyitott upstream kérdés.
  (4) **A kliens-hibák naplója a diagnózis eszköze:**
  a `state\ui-extras-client.log` a böngésző összes `window.error` /
  `unhandledrejection` / init-hiba eseményét host-oldalon rögzíti — itt derült ki a
  slot-hiba is.

- `2026-11-16` (ötödik kör) — **a „minden lassú / valami zabál" gyökere: a
  `/devadmin/state` poll-vihar.** MÉRVE: `/devadmin/state` **2794–3044 ms**,
  miközben `/ui-extras/harness-url` 2–4 ms; a dev oldal access logjában az utolsó
  3000 kérésből **2995 `GET /`**, mind `127.0.0.1`, **`user-agent: dsh-devadmin`**,
  a log 13 MB-ra hízott, **14 php-cgi munkás 5–10% CPU**-n pörgött, a node
  (harness) 147%-on, három `msedgewebview2` renderer 110–115%-on. OK: a
  `handleState` **minden hívásnál HTTP-próbát indít a dev oldalakra**
  (Laravel-indítás, site-onként) + port-tulajdonosokat kérdez, a fejléc pedig
  **2 s-onként, minden panelből** hívta (6 panel → ~3 hívás/s → ~6 Laravel-render/s).
  Ez blokkolta a harness eseményciklusát (a Git panel lassú betöltése) és a
  kattintás `/devadmin/desktop` kérését is sorba állította → **1 perc fölötti
  asztalváltás**. JAVÍTÁS: (1) a state válasz **15 s-ig cache-elt** (`?fresh=1`
  megkerüli); (2) új, **olcsó olvasó végpont**: `GET /devadmin/desktop` `n`
  nélkül → `{ok, desktop, desktopCount}` (két fájlolvasás, hálózat nélkül; a
  meglévő `?n=` írás változatlan); (3) a fejléc-váltó **öntempózó**: olcsó
  végpontnál 5 s, a régi host 404-jénél **30 s** tartalék, **rejtett panel nem
  polloz**, kattintás után 600 ms/2 s egyszeri újraolvasás; (4) az Admin panel
  5 s → **15 s**, rejtve nem frissít. **Mérve:** közvetlen hívással
  `{"ok":true,"desktop":1,"desktopCount":2}` (nincs próba), a devadmin tesztjei
  **11/11**. Kiadás: **v0.2.5**. A host-cache csak **harness-újraindítás** után
  él (§1.5 — a felhasználó engedélye kell), a kliens-oldali ritkítás pedig
  **panel-újratöltés** után.
  **MÉRT AKTIVÁLÁS (07:44, a felhasználó engedélyével):** a két munkaablak
  újraindult **ellenőrzött PID-del** (27720, 32728 — a futó képek a régi
  binárisból: `DshWindow.exe.old-20261116-071825`), a tálca pedig a **nem
  aktív** asztal ablakát **nem** indítja újra magától (75 s alatt sem), ezért a
  `window-desktop.txt` 2→1 írásával kellett létrehozni — **tanulság: egy ablak
  „visszahozása" a `window-desktop.txt` írása, nem a tálca önjavítása.** Eredmény:
  `36068` (1. asztal, látható) + `10204` (2. asztal, rejtett), 6 panel, mind a 6
  WebView2-vezérlő **első próbából** (`attempt 1`), **0 `[ERROR]`**. Mérve utána:
  próba-ráta **1,5/s → 0,20/s**, harness CPU **128% → 1,8%**, asztalváltás
  **145/108/108/109 ms** (korábban **1 perc fölött**), minden váltás után
  pontosan egy látható ablak (`asztalvaltas kesz: aktiv=N lathato=[pid]`).
  A maradék meleg panel-renderer (**2 db, ~95% és ~79%**) a két **ÉLŐ sessiont**
  mutató panel — a session-naplók 07:40-kor is íródtak (L12 8,3 MB, ez a session
  13,5 MB) —, ez a streamelés költsége, nem szivárgás. **Nem DSH:** a
  `RaiderBridge` node 67%-on (a jóváhagyott weboldal-bridge, AGENTS 2.1 — nem
  vizsgáljuk tovább) és a felhasználó saját Pest-tesztje
  (`php vendor/pestphp/pest/bin/pest --filter=Document`, 100%). Új eszköz:
  `tools\perf-check.ps1` — CPU + panel-rendererek + próba-ráta + verdikt, csak
  olvas. A 15 s-os host-cache továbbra **nem** él (harness-újraindítás kell): a
  maradék 0,2 próba/s a régi host 30 s-os tartalék útja.

  **A WMI Provider Host (wmiprvse) 20–73%-a NEM a DSH** (2026-11-16, 08:00, a
  felhasználó kérdésére mérve): a `wmiprvse` önmagában semmit nem csinál, csak
  más programok WMI-kéréseit szolgálja ki. MÉRT ügyfelek a
  `Microsoft-Windows-WMI-Activity/Operational` naplóból (5858):
  (1) **MSI „Sensor dev service"** (`Sendevsvc.exe`, `MSI NBFoundation Service`)
  — `root\WMI`: `MSI_CPU`, `MSI_VGA`, `MSI_AP`, `MSSMBios_RawSMBiosTables`,
  `Win32_PowerPlan` (a napló csak a HIBÁS hívásokat rögzíti, a sikeres
  érzékelő-pollozás a folyamatos terhelés); (2) **`MSI_TraceFPS.exe`** FPS-overlay
  (mért 7,7%); (3) a Windows **`DoSvc`** (Kézbesítés optimalizálása, svchost /
  NETWORK SERVICE) 2 s-onként **mindig hibázó** lekérdezése:
  `SELECT * FROM MSFT_NetAdapterStatisticsSettingData WHERE Name = 'Ethernet'`,
  `0x80041032` — 118 hiba 07:48:04–07:49:57 között. A DSH-ban **nincs**
  időzített WMI-hívás (csak `IPGlobalProperties` a C#-ban, és 3 eseményhez kötött
  CIM-próba a pluginokban; a devadmin panel `netstat`/`tasklist`-et használ).
  **A `perf-check.ps1` 1b szakasza ezért PDH-számlálókkal mér** (a `Get-Process`
  a SYSTEM folyamatok CPU-ját 0,00-nak látja — a legnagyobb fogyasztó
  láthatatlan volt); a `(*)`-os gyűjtőútvonal ingatag (PDH 800007D2), ezért
  példányonként, kötegekben kérdezi le.

  **A „73% a Task Managerben, 35% az MSI Centerben" NEM ellentmondás — két
  különböző CPU-mutató** (2026-11-16, ugyanabban a percben mérve):
  `\Processzorinformációk(_Total)\Üresjárat` → mag-idő szerint **29–33%**, a
  frekvencia-súlyozott („% Processor Utility") érték **46–83%**. A **Task Manager
  a frekvencia-súlyozottat** mutatja (turbo 4,02 GHz mellett ez a nagyobb), a
  legtöbb más eszköz (MSI Center, PDH `Processzor` készlet, `Get-Counter`
  `Processzor kihasználtsága`) az **idő-alapút**. A hő és a fogyasztás a
  frekvencia-súlyozottal korrelál (mért 89 °C CPU-hőmérséklet valós terhelés
  mellett). Ezért a `perf-check.ps1` mindkettőt kiírja, és a folyamat-összeget
  **alsó becslésnek** jelöli (a PDH a közben változó példányokat kihagyja —
  MÉRT hiba: a régi verzió az azonos nevű példányokat ÁTLAGOLTA, ezért a gépet
  8%-nak mutatta ~30% helyett). A tényleges fogyasztók ekkor: 3 panel-renderer
  (~3 mag), `msi.centralserver` (~1 mag, a nyitott MSI Center Hardware Monitoring
  fül), `memory compression` (~1,6 mag, 22,6/31,4 GB RAM), `WmiPrvSE` (0,5–0,7),
  Intel `esrv_svc` (Energy Server, ~0,9), `system`+`dwm`. A WMI-csillapítás
  egykattintásos eszköze: **`tools\wmi-calm.ps1` + `wmi-calm.cmd`** (emelt jog
  kell, a szkript magát emeli; `-Report` csak mér, `-StopOnly` nem írja át az
  indítási típust) — leállítja az MSI Sendevsvc/Center/Companion/Foundation
  szolgáltatást, a TraceFPS/CentralServer folyamatokat (ellenőrzött útvonal
  alapján) és a DoSvc hibás adapter-ciklusát, `Manual` indítási típusra állít,
  és **előtte/utána méri a wmiprvse CPU-ját**.

- `2026-11-16` (negyedik kör) — **„Háttérmunkák" fül a Beszélgetés/Pálya sorban, a
  felső sor jelzőjének elrejtésével.** (1) Új nézet a `conversation.view` **slotban**
  (`dsh-ui-extras` kliens): `id: "uix-jobs"`, `order: 20`, `label` **thunk**
  (`view.jobs` → HU „Háttérmunkák" / EN „Background jobs"), ezért a címke követi a
  nyelvet. A slot-dokumentáció szerint friss `id`-vel az elem a meglévők **mellé**
  kerül (`replaceRisk: none`), a regisztráció alakja a hivatalos példa
  (`{ name, id, order, label }` + komponens). A nézet adatforrása ugyanaz, amit a
  terminál-panel használ: `GET /ui-extras/cmd?action=runs` (2 s-onként), soronként
  állapotpötty, címke, munkaterület, `id`, indulás, „fut/kész", valamint
  kinyitható **kimenet-tail** (utolsó 4000 karakter); a „külső" (folyamatlistából
  felismert) bejegyzéseket kihagyja. (2) **A felső sor `job-list` jelzője
  elrejtve** a core bejegyzés **azonos id-vel** való felülírásával
  (`conversation.session.header.actions`, `id: "job-list"` → üres komponens) — ez
  a dokumentált „azonos id = abba a cellába" út, CSS-hack és core-patch nélkül;
  a core `dsh-client-ui-jobs` osztálynevei (`QsffPG_root`) buildenként változnak,
  ezért nem azokra hivatkozunk. (3) **Nem kell harness-újraindítás:** a kiszolgált
  bundle (458 454 byte, `rev=3c40acef4ea1`) már tartalmazza a kódot
  (`view.jobs`, „Háttérmunkák", a felülíró regisztráció), tehát egy **panel-
  frissítés** (fogaskerék → frissítés, vagy az ablak újranyitása) elég.

- `2026-11-16` (harmadik kör) — **a Harness futó munka közbeni újraindulása, a
  Windows-újraindítást kiváltó hiba-lavina, és a boot-sorrend.** (1)
  **MÉRT INCIDENS `~07:06–07:08`:** a WebView2-újrapróbálkozások „takarítása"
  közben a Harness processze elhalt, a tálca újraindította — **3 futó munka
  megszakadt**, és a hiba-lavina (6 panel × 8 próba + 10 s-os önjavítás, összesen
  43 profil-mappa és több tucat félig leállt böngészőfolyamat) miatt a
  felhasználónak **Windows-t kellett újraindítania**. Ezért **négy új P0 szabály**
  született: **§1.5** (tilos a futó Harness-t/felügyelő láncot újraindítani; a
  `bin\*.exe.new` csere a következő természetes indításkor történik), **§1.6**
  (tilos folyamatot NÉV szerint leállítani — csak ellenőrzött PID-del, a Harness
  pidje nem lehet a listában), **§1.7** (tilos korlátlan/lavinát indító
  újrapróbáló ciklus; kötelező a korlát + növekvő várakozás + áramköri
  megszakító, és a ciklus nem maradhat futva a kör után), **§1.8** (boot után
  mindig az 1. asztal ablaka látszik). (2) **Boot-sorrend hiba javítva:** a
  „másik asztal előindítása" **feltétel nélkül** futott, ezért boot után a 2.
  asztal nyílt meg (napló: `07:08:13 munkaasztal 2 inditas` **a** `07:08:30
  munkaasztal 1` **előtt**, a harness csak 07:08:24-re adott friss tokent).
  Most: az előindítás csak akkor fut, ha a harness figyel **és** az aktív asztal
  ablaka él, utána `ApplyDesktopAsync(active)` normalizál; a `StartDesktopWindow`
  pedig elutasítja a nem aktív asztalt, ha az aktív ablaka még nincs meg. (3)
  **`WebViewCircuit`** (12 hiba / 2 perc → minden további próba leáll) és a
  recovery 18 → **6** próbára csökkentve: a lavina nem tud újra lefutni. (4) A
  binárisok cseréje **folyamatleállítás nélkül** történt (a futó exe átnevezése
  `.old-<időbélyeg>`-re, majd a `.new` a helyére), ezért a javítások a
  **következő természetes indításkor** (ablak/tálca újraindítás vagy boot) lépnek
  életbe — a futó sessionök érintetlenek.

- `2026-11-16` (második kör) — **a „panel újraindul / eltűnik a
  munkafolyamat-lista" és a WebView2-hiba gyökere.** (1) **Hamis „kicserélték a
  szervert" újratöltés:** a `dsh-ui-extras` 5 s-os életjele a
  `/ui-extras/balance` végpontot hívta, ami **külső API-t** kérdez (egyenleg); egy
  átmeneti hiba/rate limit után az első sikeres válaszra a kód
  `navigateToFreshServer()`-t hívott, ami ~12 s után
  `window.location.reload()`-ra esett vissza → a panel újratöltött, a munkaterület
  munkafolyamat-listája „eltűnt". Javítás: az életjel **helyi** végpontot
  (`/ui-extras/harness-url`) hív, és újratöltés **csak akkor** történik, ha a
  válasz `pid`-je eltér az elsőként látottól (tényleg új szerverprocessz van). A
  kiszolgált bundle ellenőrizve: `dsh-ui-extras/client.js` 448 741 byte,
  tartalmazza a `recovered on the same server` ágat. (2) **A WebView2
  `E_UNEXPECTED` (0x8000FFFF) lavina gyökere a profil-mappák elszaporodása volt:**
  a korábbi „próbánként új mappa" stratégia 6 panel × 8 próbával **43
  profil-mappát** és sok, félig leállt WebView2 folyamatot hagyott maga után, ami
  után a `CreateCoreWebView2ControllerAsync` tartósan E_UNEXPECTED hibát adott (a
  környezet létrejött, a vezérlő nem). Javítás: **futásonként EGY tartalék-mappa**
  panelenként (`pane-N-<pid>-<időbélyeg>`), 8 próba (~25 s, 1/1,5/2,5/3,5/5 s), és
  **önjavító újrapróbálás** a hibaoldal után (10 s-onként, max 18×): siker esetén
  letörli a hibaoldal szövegét és a normál láncot futtatja (`AttachController`),
  tehát nem kell bezárni/újranyitni az ablakot. Kézi takarítás után (43 → 0
  timestampes mappa, orphan `msedgewebview2` leállítva) **mind a 6 panel**
  vezérlője létrejött (07:08:14 és 07:08:31), a váltás **119–231 ms**. (3) A
  `%TEMP%\dsh-*\DSH Harness\WebView2` mappák is törölhetők; a stabil profilok a
  `state\webview2\pane-N` / `pane-N-d2`. Részletek: `docs\DSH-ASZTAL-TERV.md`.

- `2026-11-16` — **a munkaasztal két külön ablakra állt át, és a „minden
  bezárult" hiba okai javítva.** (1) **A tálca kilépése megölte az ablakokat:**
  `ExitApp()` → `StopDesktopWindows()` miatt egy tálca-frissítés („Kilépés",
  telepítés) MINDEN munkaablakot bezárt — mért eset `04:53:29`; a felhasználó ezt
  „minden bezárult"-ként élte meg, miközben a harness (`pid 28304`) és a
  sessionök végig éltek. A kilépés mostantól **otthagyja** az ablakokat
  (`a munkaablakok nyitva maradnak (N ablak)`), a frissítés pedig force-killel
  megy (`Stop-Process -Force`), hogy az `ExitApp()` le se fusson. (2) **A
  segédablakok elrabolták a mutatást/rejtést:** a `CiceroUIWndFrame`,
  `SystemResourceNotifyWindow` és `MediaContextNotificationWindow` is top-level,
  címzett, `HwndWrapper[...]` osztályú ablak, ezért a `FindWindowForProcess`
  ezeket választotta, a `ShowWindow` a segédablakon hatott, a valódi ablak viszont
  **rejtve maradt** — mért következmény: mindkét munkaablak `hidden`, üres
  asztal, „kézzel kellett indítani". A kereső most **elsőbbséget ad a pontos
  termékcímnek** (`DeepSeek Harness`); `Process.MainWindowHandle` rejtett/WPF
  ablakra használhatatlan (0, illetve az IME ablak). (3) **Panel-osztás
  asztalonként:** a beállított panelszám a TELJES szám; `>3` esetén két ablak,
  `4 → 2+2`, `5 → 3+2`, `6 → 3+3` (`PanesForDesktop()`). Korábban a főablak a
  teljes 6-ot kapta, a `DshWindow` pedig asztalonkénti rácsokat rakott egymásra,
  ezért 3 panel takarásban élt és 3 WebView2-t fogyasztott (~3,3 GB); mostantól
  a `DshWindow` EGY rácsot épít, asztalonként egy ablak van. (4) **Pid-fájl
  asztalonként:** a `DshWindow` a saját `state\window-desktop<N>.pid`-jét írja
  (kilépéskor törli), a tálca csak akkor pótol, ha EGYETLEN pid-fájl sem érvényes
  és pontosan egy ablak fut (korábban minden ablakot az 1-es asztalhoz írt,
  ezért a 2. asztal ablaka „1. asztalként" jelent meg, és a váltás nem indított
  új ablakot). (5) A `RestartWindowForLayout()` **csak az aktív asztal** ablakát
  zárja be, a `ShowWindow()` (tálcaikon, kitűzött ikon) csak az aktív asztalét
  mutatja, a nem aktív asztal új ablaka pedig az inicializálás után rejtve marad
  (`HideWhenReady`); a 700 ms-os figyelő a kiinduló írásidőt is megjegyzi, ezért
  a legelső tick nem indít felesleges második ablakot. (6) **A váltás
  ellenőrzött, háttérszálas végrehajtású** (`ApplyDesktopAsync`): megvárja a
  cél-ablak fogantyúját (max ~15 s), megjeleníti, fókuszba hozza
  (`SetForegroundWindow`, majd ha nem sikerült, `AttachThreadInput` az előtér
  szálához — a háttérben futó tálcából a Windows foreground-lock miatt a sima
  `SetForegroundWindow` NEM ad fókuszt; a `SwitchToThisWindow` Alt+Tab-szerűen
  MÁS programot hozott előtérbe, ezért kivéve), és **csak utána** rejti el a
  többit (ez volt a „bezár, aztán kinyit" élmény), végül **ellenőrzi, hogy
  pontosan egy ablak látható**, és naplózza a látható pid-eket
  (`asztalvaltas kesz: aktiv=N lathato=[pid]`). A fejléc 1/2 gombja eddig
  **eldobta** a `/devadmin/state` válaszát, ezért csak a saját kattintását
  jelezte — váltás után nem az aktív asztal volt kiemelve („az egyes van aktív
  színnel"); mostantól 2 s-enként a tényleges állapotot mutatja (ez a
  kliens-csomag miatt csak harness-újraindítás után él). A tálca induláskor a
  MÁSIK
  asztal ablakát is előre elindítja rejtve (`EnsureOtherDesktopWindows`), hogy a
  váltás ne új ablak indításával kezdődjön. A két ablak WebView2-profilja
  **asztalonként külön** (`pane-N-d2`): a közös profilmappa miatt minden panel
  első próbálkozása `0x800700AA`-val bukott el, és ~6 s-ig fehér panel látszott.
  **Mért eredmény
  (2026-11-16):** 8 szimulált kattintás (1→2→1→2→2→1→2→1) mindegyike
  **0,2–0,8 s** alatt ért célba, minden váltás után **pontosan egy** látható
  ablak („asztalvaltas kesz: aktiv=N (lathato=igen)"); új ablak indításakor
  `0x800700AA` **0 db**. (7) **Friss indításnál az 1. asztal nyílik**
  (felhasználói kérés): ha a tálca indulásakor **egyetlen** `DshWindow` sem fut,
  a `window-desktop.txt` 1-re áll, a pid-fájlok törlődnek, és az első ablak az
  1. asztalé (a 2. asztal 4 s múlva, rejtve előindul). (8) **A váltás
  gyorsabb:** a figyelő ciklusa 700 → **200 ms**, és a mérés szerint a kattintás
  és a „cél látható + fókuszált" között **154–252 ms** telik el (medián 245 ms;
  a láthatóvá válás önmagában 31–130 ms). A maradék idő a 200 ms-os poll és a
  fókusz-átvétel (~100 ms); esemény-alapú jelzéssel (FileSystemWatcher vagy neves
  esemény) ~50–100 ms lenne elérhető. (9) **Tálcaikon: AUMID + `RelaunchCommand`,
  a kitűzés viszont NEM scriptelhető.** Új eszköz
  `tools\set-pinned-aumid.ps1` (`-Check` / `-Apply` / `-RemoveBogusPin`)
  beállítja a hivatkozások `System.AppUserModel.ID`-ját (`DeepSeek.Harness`) **és**
  a `RelaunchCommand` / `RelaunchDisplayNameResource` / `RelaunchIconResource`
  értékét a kitűzött, az asztali és a Start-menü hivatkozáson, és törli a rossz,
  közvetlen ablak-pint (`DshWindow.lnk` → `DshWindow.exe`). Mentés:
  `D:\Szerver\DSH-backup\pins-<időbélyeg>\`. **A `RelaunchCommand` nélkül a pin
  nem indítható újra:** az ablak bezárása után a tálcaelem „Nem nyitható meg az
  elem" hibát ad (mért hiba) — az AUMID csak a csoportosítást adja. **A kitűzés
  létrehozása ezen a builden nem megy scriptből:** a Windows 11 kivette a
  „Csatolás a tálcához" igét (a „Levétel a tálcáról" megvan),
  `InvokeVerb('taskbarpin')` csendben hatástalan, és a `User Pinned\TaskBar`
  mappa nem forrás: a `Taskband\Favorites` törlése után az Explorer **nem**
  abból épített újjá, hanem **elvesztek a pinek** (63 db; mentésből
  visszaállítva: `state\taskband-values.json` + registry-írás, a
  `Favorites`/`FavoritesResolve` bináris értékek, majd Explorer-újraindítás).
  Ezért a kitűzés **egy kézi lépés** (Start-menü → jobb klikk → Csatolás a
  tálcához, vagy az asztali ikon tálcára húzása) — utána a beállított
  tulajdonságok miatt egy ikon lesz, és becsukott ablak mellett is indít.
  **Mért buktatók:** az `IPersistFile::Load`-hoz **`STGM_READWRITE` (2)** kell
  (különben `STG_E_ACCESSDENIED`), a `PROPVARIANT` x64-en **24 byte** (a 16
  byte-os változatnál a beállított érték visszaolvasáskor üresnek látszik), és
  egy félresikerült `Save` **0 byte-ra csonkíthatja** a `.lnk`-et (a mentésből
  visszaállítva). Explorer-újraindítás
  után a panelek hibamentesek (0 `[ERROR]`, 48 WebView2 folyamat).
  Váltás új ablakkal = 1,1 s, elrejtett ablak
  automatikus visszahozása = 3,1 s, 6 panel = 2 ablak × 3 panel (WebView2
  ~3,7–4,3 GB / 48 folyamat, `DshWindow` ~0,25 GB, node ~2,2 GB). A webes fejléc
  (fogaskerék-panel, 1/2 ikon, magyar címkék) ellenőrzése **harness-újraindítás**
  után esedékes, mert a kliens-csomag boot-időben kap rev-hash-t. Részletek:
  `docs\DSH-ASZTAL-TERV.md`.

- `2026-11-15` — **a „kis adagokban készülő fejlesztés" okának mérése, és két
  beállítás ennek ellenére.** (1) **MÉRVE: a harness NEM korlátozza a
  munkafolyamat hosszát.** A `dsh-agent-loop`-ban nincs `maxSteps`/`maxTurns`
  (0 találat), és a kör-vég okok teljes típusában (`dsh-session/lib/types/
  types.d.ts:165-199`) nincs `max-steps` ág: `completed`, `aborted`, `blocked`,
  `error`, `max-tokens`, `interrupted`. Napló-mérés (163 session / 530 lezárt
  kör, 45 nap, ez a munkaterület; a session-naplók TÖBB zstd-frame-esek, ezért
  keretbejáró kell, a Node `zstdDecompressSync` csak az első frame-et adja
  vissza): `completed` 469 (88,5%), `error` 21, `aborted` 20, `interrupted` 19,
  `max-tokens` 1 — **egyetlen hosszkorlát sincs**. Lépés/kör: min 1, p25 4,
  medián 9, p75 21, p90 43, max 187; egy session 172 kör / 1 873 lépés / 527
  ezer token surface. Tehát a rövid köröket a MODELL megállása okozza. A fő
  modell plafonjai: `deepseek-flash` contextWindow **1 000 000**, maxTokens
  **256 000**, stream idle 300 s (`dsh-llm-deepseek/lib/index.js:1390-1394`).
  (2) **Munkaszerződés a personába** (`~\.dsh\.agent-presets\standard-free\
  agent.cordis.yml`, `persona.suffix`): egy kör csak akkor ér véget, ha az
  eredmény kész ÉS ellenőrizve van, vagy felhasználói döntés blokkol; tilos a
  „folytassam?" zárás; a terv `todo_write`-ba megy (az TÚLÉLI a tömörítést, a
  beszélgetés nem); elemzés helyett eszközhívás; állítás csak bizonyítékkal.
  (3) **`compaction-basic` `thresholdRatio` 0,30 → 0,45**
  (`~\.dsh\profiles\web\cordis.patch.yml`, mentés `.bak-20261115-161414-*`):
  0,30-nál a tömörítés 300 ezer tokennél vágott, LLM-összefoglalóval
  helyettesítve a régi előzményt — a mért 172 körös session 2 tömörítést és 9
  megkurtított tool-eredményt szenvedett el. 0,45 → küszöb 450 ezer token,
  retention 16% (160 ezer) marad; a schema a (0,1] tartományt fogadja el
  (`compaction-basic/lib/index.js:200`). Érvénybe lépés: a persona **új
  sessionben**, a patch **harness-újraindítás után** (boot-időben töltődik).
  Mindkét fájl YAML-parse ellenőrzése megtörtént (yaml 2.9.1, `!!js` tagekkel
  együtt). Nyitva hagyva: a gyerekek `write`/`edit` tiltása (`tool-subagent`
  `toolFilter.deny`) miatt minden szerkesztés a fő szálon sorosodik — ez
  felhasználói döntés, és a free children naplóiban körönként 4-5 `llm/retry`
  látszik.

- `2026-11-14` — **Herd-kiváltás, 2. szakasz: admin felület a DSH-ban, és a Herd
  ki van kapcsolva.** (1) **A Herd leállt és kikerült az autostartból**: a
  `HKCU\...\Run\de.beyondco.herd` érték törölve (mentés:
  `D:\Szerver\DSH-backup\herd-autostart-<időbélyeg>\herd-autostart.reg`, a
  Startup mappában nem volt Herd-hivatkozás); a `Herd`, `HerdHelper`, `nginx`
  (25 példány) és a Herd `php-cgi` (5) folyamatok leálltak, a 80/443
  felszabadult, és a Caddy azóta a **443/80-on** szolgál (kanonikus URL,
  `https://<domain>/` port nélkül). A `HerdHelper` egy emelt szolgáltatás
  (`hozzáférés megtagadva` `taskkill`-nél) — portot nem fog, emelt
  PowerShell-ből állítható le. (2) **`plugins\dsh-devadmin` — admin felület**
  (host + kliens): `GET /devadmin/` önálló HTML, `/devadmin/state` JSON,
  `/devadmin/action` (`start|stop|restart|php-use|check-hosts`),
  `/devadmin/logs`; a kliens oldalon `devadmin` tab a jobb oldalsávban +
  `Admin` chip a composer dokkban. A host **nem implementálja újra** a dev
  szervert: a `tools\dev.ps1`-et hívja, tehát a CLI és a UI egy kódúton megy
  (ez a „ne legyen két igazság" szabály alkalmazása). Telepítés:
  `plugins\dsh-devadmin\install.ps1` (`-Check`, `-Remove`). **9/9 teszt**
  (`node --test`): 6 host-oldali (projektfelismerés, PHP-lista, TCP,
  `tailFile`, `/devadmin/state` JSON-alak, `/devadmin/logs`) + 3 kliens-oldali
  (bundle id, exportok, apply-regisztrációk). (3) **`tools\dev-hosts.ps1`** — a
  hosts fájl kezelése nyilvántartással: minden hozzáadott sor bekerül a projekt
  `.dsh\hosts-added.json`-jába, és az eltávolítás CSAK a nyilvántartott sorokat
  törli; emelt hatalom nélkül kimondja a futtatandó parancsot, de nem nyit
  felugró ablakot. (4) `dev.ps1` pontosítások: a **443/80 foglaltságát bind-tal**
  dönti el (a listener-alapú vizsgálat a lecsengő socket miatt 8443-on ragadt),
  a DBngin/MySQL állapot a `list`/`status`/`start` kimenetében (`.env`
  `DB_*` + TCP), és a `Get-EffectiveHttpsPort` a szabad 443-at részesíti előnyben.

- `2026-11-14` — **Herd-kiváltás, 1. szakasz: a fejlesztői környezet már Herd
  nélkül is kiszolgálja a projekteket.** (1) Saját PHP: `D:\Tools\php\8.4.27`
  (a Herd 8.4.27-tel azonos verzió, saját `php.ini`-val), `D:\Tools\php\current`
  junction, választó: `tools\php-version.ps1` (`-List` / `-Use`); Composer a
  `D:\Tools\php\composer\composer.phar` (2.11.2), hívó: `bin\composer.cmd` —
  a Herd `bin` könyvtára nélkül is van `php` és `composer`. (2) Saját kiszolgáló:
  `D:\Tools\caddy\caddy.exe` (2.11.9) + `php-cgi` FastCGI munkások (9101–9199),
  HTTPS a Caddy saját CA-jával. (3) `tools\dev.ps1` (`list|status|start|stop|
  restart|logs`) újraírva: minden indulásnál újragenerálja a
  `state\dev\Caddyfile`-t a projektprofilokból (`.dsh\dev.yaml`:
  `domain/docroot/php/aliases`), a `state\dev\state.json` a pideket és a
  portokat tartalmazza, a naplók a `state\dev\logs`-ban. (4) Új
  `tools\dev-hidden.vbs`: a szervert `wscript` + `WshShell.Run(cmd,0,False)`
  indítja, mert a DSH-eszközből indított folyamat a harness job-objektumában
  marad, és a hívás a gyerekek lezárásáig (időtúllépésig) vár — a rejtett
  indító 220 ms alatt visszatér, a szerver tovább él. **Mért eredmény:** a két
  Herd-telepítésű projekt (`termeszetgyogyaszoktatas-L12`, `jelentkezes-redirect`)
  a saját láncon is kiszolgálódik, és a válaszok **paritásban** vannak a Herd
  (nginx, 443) kimenetével: `/` → 200, `/jelentkezes` → 200,
  `jelentkezes-redirect.test/` → 301 (ugyanoda). **Mért buktatók:** a
  `caddy trust` a Windows-on certutil-t indít, és **megakadt** (90 s után sem
  tért vissza) — helyette a `certutil -addstore -user Root` megy (UAC nélkül);
  a `Get-NetTCPConnection` portonkénti hívása 799 hívást jelentett (~30 s),
  ezért egyetlen lekérdezés kell a tartományra; a `Caddyfile` útvonalában van
  szóköz, ezért a `Start-Process -ArgumentList` tömb helyett **idézőjelezett
  argumentumsor** kell. A Herd még fut (a 443/80-at fogja), ezért most 8443 a
  HTTPS port; a Herd leállítása és a 443/80 átvétele a következő szakasz.
  Új eszköz: `tools\check-autostart-duplicates.ps1` — autostart (Run/RunOnce +
  Startup) duplikátumok, idegen nem-`.lnk` fájlok a Startup mappában,
  launcher-szkript dupla példányai és a **két külön bridge telepítés**
  (`LocalAIBridge` + `RaiderBridge`) kimutatása, valamint a Herd, nginx,
  php-cgi, mysqld jelenléte.

- `2026-11-14` — **a megszakadt BESZÉLGETÉS is folytatódik boot után** (a
  felhasználó pontosítása: a kérés nem csak a terminálra vonatkozott). Új
  HOST-síkos plugin: `plugins\dsh-session-auto-continue` (junction + `- insert:`
  a `~\.dsh\profiles\web\cordis.patch.yml`-ben, telepítés:
  `install.ps1` / `-Check` / `-Remove`). Működés: a mag a crash után betöltéskor
  **javítja** a naplót (`interruptedTurnClosers`, `dsh-session/lib/index.js`
  ~593–710) — `turn/end` + `data.reason.kind === "interrupted"` —, de nem
  folytatja; a plugin ezt a kört indítja újra a hivatalos belépővel:
  `prompt({ sessionId, content, requestId })` (`SessionCommandController.prompt`,
  `dsh-api-session-controller/lib/index.js:736`; a host-síkon
  `sessionController` néven, `:2726`), belül `resolveAgent()` →
  `agent.followup()`. **Korlátok:** max **2** session bootonként, a megszakadás
  max **6 órás**, session+szekvencia jelölő a `state\auto-continue.json`-ban
  (ugyanaz a kör nem folytatódik kétszer), a szöveg előírja a valós állapot
  ellenőrzését az ismétlés előtt; kikapcsolás `state\no-auto-continue` vagy
  `DSH_NO_AUTO_CONTINUE=1`; napló `state\auto-continue.log`. A prompt-belépőt
  futáskor oldja fel (`sessionController` → `sessionCommands` → `sessions`),
  mert a szolgáltatás neve verziófüggő. Részletek: `docs\DSH-ATADAS.md` 10.7.
- `2026-11-14` — **a megszakadt panel-futás automatikusan folytatódik** (a
  felhasználó kérése: „újraindítás után automatikus folytatódjanak a
  megszakadt folyamatok"). A `state\runs.json` rekord mostantól a **parancsot**
  is tárolja (`command`), nem csak a pidet és a túlélőket. Ha bootkor a
  munkaterületen **semmi nem él** (a héj EOF-fal kilépett ÉS a gyerekek is
  elmentek), a `plugins\dsh-ui-extras` `autoResumeRuns()`-ja újraindítja
  ugyanazzal a munkaterülettel és paranccsal, és a kimenetbe beírja, hogy
  `[automatikus folytatas a korabbi bootbol: …]`. **Nem** indít újra, ha a
  munkaterületen még él folyamat (az a folytatás), ha a rekordnak nincs parancsa,
  vagy ha a `state\no-auto-resume` jelölő / `DSH_NO_AUTO_RESUME=1` kikapcsolja;
  legfeljebb 8 rekord indul (3 s késleltetés, 1,5 s lépésköz), hogy a boot ne
  kapjon egyszerre nyolc indulást. A felhasználói szándékot a rekord
  **eltűnése** hordozza: `stop`/`forget` után a futás `done`, a `persistRuns()`
  kiveszi a fájlból, tehát semmi nem támasztja fel. Ugyanekkor javítva a
  **kétfázisú visszatöltés** is: két rekord ugyanarra a munkaterületre a
  kereséssel nem különböztethető meg, ezért előbb minden rekord a SAJÁT mentett
  túlélőit kapja, és csak a maradékot osztja ki a keresés (mért eset 04:35:
  a `run-3` mindkét `vite`-ot elorozta, a `run-7` elveszett; 04:53 után
  `runs: 2 korábbi futás visszatöltve`, külön rekorddal `46676`-ra és
  `41572`-re).
- `2026-11-14` — **két hiba a 2026-11-13-i panel-javítások után** (a 23:33-as
  restart mérése). (1) **A `state\harness.pid` elavultan maradt:** a
  `tools\restart-harness.ps1` a pid-fájlt csak a token-URL megtalálása UTÁN
  írta, és a listener-listából az ELSŐ pidet vette; mért eset: a fájl a korábbi
  harness pid-jét (`40860`) tartalmazta, miközben az új a `38480` volt. Ezért a
  szkript most a tokenre várás ELŐTT ír, és a **legfrissebb indulású** listenert
  választja, a `dsh-process-guard` pedig bootkor a saját pid-jével írja ki a
  fájlt (a harness biztosan tudja) — a boot-diag `harnessPidWritten` mezője
  kimondja, sikerült-e. (2) **A túlélő-kereső kihagyta a junctionos útvonalú
  folyamatot:** a `C:` alakkal indult `vite` (`41572`) láthatatlan maradt a
  `D:` kulcsú rekord mellett, és a két rekord UGYANAZOKAT a pid-eket követelte
  (`run-3`/`run-7` → `[46676, 7112]`). Javítás: `workspaceNeedles()` a
  kanonikus útvonal mellé a `\<mappanév>\` szegmenst is keresi, a boot pedig
  `claimedPids` halmazzal biztosítja, hogy egy folyamat csak egy rekordhoz
  tartozzon (a leállítás ellenőrzése ugyanezekkel a tűkkel megy). Mért próba:
  a tűk megtalálják a `C:` és a `D:` alakú `vite`-ot is (`46676`, `41572`), az
  `esbuild` segédeket a gyökér-szűrés kiveszi. Mindkettő a **következő**
  harness-újraindításnál lép életbe.

- **Korábbi körök (tömörítve; részletek: `docs\DSH-ATADAS.md` 10.6–10.7,
  `docs\DSH-ASZTAL-TERV.md`).** `2026-11-13` — a panelállapot kulcsai kanonikusak
  (junction-feloldás `canonicalWorkspace()`-szel, `tools\canonicalize-panel-state.mjs`;
  mért 14 → 9 kulcs); a panel-futás TÚLÉLI a restartot (`state\runs.json` a
  `command`-ot is tárolja, kétfázisú visszatöltés, `killRecoveredRun()` pid- és
  útvonal-ellenőrzéssel) és bootkor automatikusan folytatódik (`autoResumeRuns()`,
  max 8 rekord, kikapcsolás `state\no-auto-resume`); a `terminal` tool host- és
  ágens-oldala (`plugins\dsh-terminal-tool`, mailbox a
  `state\terminal-request.json`-on át, preset-bejegyzés nélkül a modell nem látja).
  `2026-11-12` — a Git panel commitja HU módban átment: a hook a `commit-lang: any`
  tracert fogadja el, a hibaolvasás pedig az első NEM üres sort veszi (a hook
  stderr-je üres sorral kezdődik). `2026-10-31` — az X gombbal bezárt ablak nem jön
  vissza (`state\window.closed` jelölő), a launcher a natív `DshTray.exe`-t indítja,
  és az újranyitott ablak nem indul fehéren (3 próbás környezet+vezérlő ciklus,
  szöveges hibaoldal a fehér helyett). `2026-10-28` — a villanás gyökere a
  `DSH model retune daily` `.cmd` shimje volt (`fix-flashing-tasks.ps1` javítva:
  `.cmd`-felismerés + a hiányzó `tools\run-hidden.vbs`). A helyi Ollama tilalma
  (`2026-11-11`) és a gemma4-12b-128k memória-mérései (`2026-11-02`) a 2. és 2.1.
  pontban élnek tovább.
