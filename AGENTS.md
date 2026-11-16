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
- `2026-11-13` — **a panel munkaterület-kulcsai kanonikusak** (junction-javítás a
  panel állapotában). A `C:\Szerver` junction a `D:\Szerver`-re mutat, ezért
  ugyanaz a projekt KÉT kulccsal élt a `state\panel-layout.json`-ban: mért
  eset (2026-11-13) **14 kulcs, 9 valódi projekt**, és a panel beállításai
  (nyitott terminál, aktív fül, szűrő, panelmagasságok) kétfelé szóródtak.
  Javítás (`plugins\dsh-ui-extras\lib\index.js`): `canonicalWorkspace()`
  `realpathSync.native`-tal oldja fel a junctiont; a `handleLayout()` fogadott
  kulcsát és a `startRun()` munkaterületét is kanonizálja (így a `runs.json`
  rekordjai és a túlélő-keresés is a valódi útvonalat használja), bootkor pedig
  a `migrateWorkspaceKeys()` egyszer összevonja a meglévő bejegyzéseket
  (`panel-layout`, `runnables`, `runs`). Új kézi eszköz:
  `tools\canonicalize-panel-state.mjs` (`--apply`, előtte `*.bak-<időbélyeg>`
  mentés; mérése: 14 → 9 kulcs). A `terminal` tool és a terminál-panel
  érintetlen; a javítás a következő harness-újraindításnál lép életbe, a
  `--apply` már most rendezte a fájlokat.
- `2026-11-13` — **a panel-futás túléli a harness-restartot** (a felhasználó
  jelezte: „a gyorsgombbal indítottam és korábban megjelent újraindítás után
  is"). A `RUNS` szándékosan memóriabeli, ezért a restart után a rekord eltűnt,
  a folyamat (két `vite` az 5173/5174-en) pedig árvaként tovább élt — a panelben
  nem látszott, csak `taskkill`-lel lehetett elérni. Javítás
  (`plugins\dsh-ui-extras\lib\index.js`): `persistRuns()` a `state\runs.json`-ba
  írja minden futás `id + workspace + label + pid + startedAt + survivors`
  rekordját; `restoreRuns()` bootkor két ágat kezel — élő **héj** (pid elég),
  illetve kilépett héj (a `powershell -NoExit -Command -` a szülő halálakor
  EOF-ot kap a stdin-en és kilép), amikor a `survivorPidsByWorkspace()` egyetlen
  rejtett CIM-hívással a rekord **munkaterület-útvonalát** keresi a
  parancssorokban. A kereső kihagyja önmagát, a harness pid-jét és a héjakat
  (`powershell`/`pwsh`/`conhost`/`WindowsTerminal`), és csak a gyökereket adja
  vissza (ez szűri ki az `esbuild` segédeket). A `killRecoveredRun()` pid-enként
  ellenőriz (`-NoExit`, illetve munkaterület-egyezés), és csak egyezésnél lő
  `taskkill /F /T`-vel; ami nem egyezik, azt kihagyja. A recovered rekord
  olvasható, de nem írható (`writeToRun()` hiba, `latestLiveRun()` kihagyja),
  és a kimenete nem hozható vissza. **Mérve:** `runs: 2 korábbi futás
  visszatöltve (2 rekord, ebből 2 héj nélküli)`; a panel `run-3`/`run-4`
  `recovered: true`-val; a `46676`/`42540` a restart előtt és után is élt;
  `action=kill&id=run-4` → `{"ok":true,"tree":true}`, 5174 felszabadult, 5173
  érintetlen. Ugyanekkor: a lemezen maradt kérés **boot-replayét** is lezártuk —
  a tool törli a `state\terminal-request.json`-t, a host pedig a 30 s-nál
  régebbi kérést eldobja (mért eset: egy `insert` a boot után újra beíródott).
  Részletek: `docs\DSH-ATADAS.md` 10.6.
- `2026-11-13` — **a modell mostantól a beépített terminál-panelben dolgozik**
  (`terminal` tool). A lánc három része: (1) HOST oldal a `dsh-ui-extras`-ban —
  `startTerminalMailbox()` 250 ms-onként figyeli a `state\terminal-request.json`-t,
  a `runMailboxAction()` a panel `RUNS` nyilvántartásán hajtja végre
  (`run|insert|input|output|stop|list`), a válasz a `state\terminal-response.json`-ba
  megy; az `insert` Enter NÉLKÜL gépel, és a host echo-t ír, mert a csővezetékes
  héj nem echo-zna. (2) AGENT oldal: új plugin `plugins\dsh-terminal-tool`
  (`inject = ["tools"]`, `defineTool` → `terminal` tool), telepítés/ellenőrzés/
  visszavonás `plugins\dsh-terminal-tool\install.ps1` (`-Check`, `-Remove`), a
  junction a `~\.dsh\profiles\node_modules\dsh-terminal-tool`. (3) A preset
  bejegyzés (`tool-terminal` / `dsh-terminal-tool`) az agent-síkos
  `~\.dsh\.agent-presets\standard-free\agent.cordis.yml`-ben — enélkül a tool
  hiába regisztrálódik a host-síkon, a modell nem látja.
  **Mért buktatók:** a `defineTool` kötelező `output { schema, render }`-je; az
  `output.schema` value-DSL a `required` MINDKÉT formáját elutasítja (a
  `parameters`-ban viszont a `required: true` helyes); a junction ellenére a Node
  a valódi útvonalról oldja fel az importokat, ahol nincs `node_modules`, ezért a
  `@deepseek-ai/dsh-tools`-t `createRequire` jelöltlistával kell feloldani; a
  preset kompozíció SESSION-LÉTREHOZÁSKOR töltődik, tehát a tool csak új
  sessionben vagy harness-újraindítás után jelenik meg. **Boot-replay hiba
  (javítva):** a kérésfájl a lemezen maradt, a `handledMailboxIds` viszont
  memóriabeli, ezért a boot után a legutolsó kérés újra végrehajtódott (mért:
  egy `insert` még egyszer beíródott; `run` esetén ez minden bootnál lefuttatott
  volna egy parancsot) — a tool most törli a kérésfájlt, a host pedig a 30 s-nál
  régebbi kérést eldobja. **Mérve:** harness-oldali mount (`defineTool feloldva` +
  `beregisztrálva`), és a tool `action=run` hívása a panel `run-2` futásában
  végrehajtotta a `git status --short`-ot. Részletek: `docs\DSH-ATADAS.md` 10. szakasz.
- `2026-11-13` — **a tálcaikonról eltűntek a panelbeállítások, és dupla
  indítások futottak.** (1) A panelbeállítások a 2026-10-31-i váltásnál vesztek
  el, amikor a launcher a PowerShell-tálcáról a natív `DshTray.exe`-re állt át: a
  natív menü nem kínálta a felosztást és a robot felületet. Visszaállítva
  `src\DshTray.cs`-ben (`Ablak felosztása` 1/2/3, `4. felület: robot panel`,
  `Csak robot mód`), a `state\tray-config.json`-ba mentve — a `TinyJson.Set()`
  csak a saját kulcsokat írja, a többit (`autostart`, `logLevel`) nem bántja —,
  és váltáskor csak az ablak nyílik újra, a harness nem áll le. Régi bináris:
  `bin\DshTray.exe.old-20261113-110249`. (2) A dupla indítás megszűnt: a natív
  tálca `EnsureHarness()` és az új `tools\start-harness-once.ps1` **közös neves
  mutexet** (`Global\DshHarnessStart-<port>`) és „friss `harness.pid` = éppen
  indul" ablakot használ; mért eset: 24504 nyert / 35424 elhalt, illetve korábban
  három indítás egymás után (6988 → 16956 → 14412). Az indítás `-NoWait`-tel
  megy, mert a `restart-harness.ps1` szinkron hívása **elakadt** (0 CPU-s
  gyermek), és emiatt az elfogadási próba riport nélkül maradt.
- `2026-11-12` — **a Git panel commitja nem működött HU módban.** A repó
  publikus, ezért a `commit-msg` hook (`tools/check-commit-msg.mjs`) angol
  üzenetet követel, a panel viszont HU kapcsolóval magyar üzenetet állít elő
  (`Frissítés: …`) — a hook elutasította. A panel csak ennyit mutatott:
  `git commit failed`, mert a hook stderr-je ÜRES SORRAL kezdődik, a kód pedig az
  első sort vette. Javítás (`plugins\dsh-ui-extras\lib\index.js`): magyar
  üzenethez a hook dokumentált `commit-lang: any` tracert fűzi (tehát a magyar
  üzenet JELÖLVE megy át; a jelöletlen magyart a hook továbbra is elutasítja), a
  hibaüzenet pedig az első NEM ÜRES sort adja vissza. A javítás a harness
  újraindításakor lép életbe (a plugin szerveroldali kódja boot-időben töltődik;
  a kliens a lap újratöltésével). Mellékesen: a DSH sandboxában a `git commit`
  hookja MSYS `sh`-t indít, ami signal-pipe-ot nem tud létrehozni
  (`couldn't create signal pipe, Win32 error 5`) — ilyenkor a commit emelt
  hozzáféréssel megy át.
- `2026-11-11` — **a helyi Ollama hívása TILOS Windows alatt** (2.1. pont).
  **HELYESBÍTETT OK (2026-11-14):** a „~22 GB-nál a Windows újraindítja a DSH-t"
  tünet oka **a rosszul beállított lapozófájl (virtuális memória) volt** — azt
  korábban én rontottam el, és azóta javítottam (32 768 MB kezdő / 65 536 MB max,
  mért). A „a `llama-server` és a DSH együtt nem fér el a 32 GB-os gépen" mondat
  tehát **téves volt**; a tiltás felhasználói döntésként marad érvényben. Kivéve:
  (1) `providers\config.json` minden `ollama/...` lánctagja, a kivett
  láncok az `localOllama.archivedTargets`-ben (worker, free-quota, deepseek-chat,
  fast-chat, vision-worker, `auto.rules.kep`, local-only), a `local-only` route
  üres lánccal 503-at ad; (2) `~/.dsh/settings.yaml`: `ollama-local` provider és
  `local-only` modell (mentés: `settings.yaml.bak-*-ollama-off`); (3) második
  védvonal a `proxy.mjs` `localOllamaGate()` kapuja, ami win32 alatt a visszatett
  célokat is ejti, és a `/healthz` kimondja; (4) kapuzva a `free-guard`, a
  `chain-doctor`, a `check-ollama`, a `check-subagent.ps1` és a
  `focus-ollama-check.mjs` bot-job 11434-es hívása. Új eszköz:
  `tools\local-ollama-settings.mjs` (ellenőrzés/kivétel, YAML-validálással).
  Linuxos visszaállítás: `providers\settings.ollama-local-disabled.yaml`.
- `2026-10-28` — szabálytár létrehozva; a fókusz-tilalom eddig csak prózában élt
  a `bot\README.md`-ben, kikényszerítve nem volt. Ezt ez a fájl pótolja.
- `2026-10-28` — a 09:00-s villanás valódi gyökere a `DSH model retune daily`
  `.cmd` shimje. A meglévő `fix-flashing-tasks.ps1` két okból nem találta meg:
  (1) csak `.exe` neveket vizsgált, a `.cmd` műveletet nem; (2) a hivatkozott
  `tools\run-hidden.vbs` nem létezett, így `-Apply` el sem indult. Mindkettő
  javítva; a `.cmd`-felismerés és a feladatonkénti hibakezelés is bekerült.
- `2026-10-31` — **az ablak X gombbal nem volt bezárható**: a `bin\DshTray.exe`
  20 másodperces `EnsureWindow()` felügyelete visszaindította. Javítás: a
  `DshWindow` a szabályos bezárás `Closing` eseményében `state\window.closed`
  jelölőt hagy, a tálca ezt tiszteletben tartja (a jelölőt a menü / tálcaikon
  törli). Összeomlás és `kill` után nincs jelölő, ezért az automatikus
  helyreállítás megmaradt (mérve: X → 45 s után sincs ablak; `kill -Force` →
  32 s alatt újra megnyílik). Ugyanekkor a `DshLauncher.exe` már **nem** a régi
  `powershell.exe -WindowStyle Hidden` + `tray\dsh-tray.ps1` párost indítja
  (második felügyelő *és* látható konzolvillanás — 1.1/1.3 tilos minta), hanem
  a natív `bin\DshTray.exe`-t; a régi ps1 tálca `Open-Window`-ja is figyeli a
  jelölőt, ha valaki mégis elindítja.
- `2026-10-31` — **az újranyitott ablak fehéren indult**. Mért eset: az előző
  ablak 09:18:42-kor zárt be, az új 4 másodperccel később indult, és mindhárom
  panelen `webview2 init failed (pane N): COMException 0x8000FFFF
  (E_UNEXPECTED)` lett — a WebView2 böngészőfolyamata még leállóban volt. A
  meglévő újrapróbálkozás csak a *környezet* létrehozását fogta, a *vezérlőét*
  nem. Javítás: a környezet és a vezérlő egy közös próbaciklusban fut (3 próba,
  friss profilkönyvtár, 1,5 s → 3 s várakozás), és ha mind elbukik, a panel
  `static` gyerekablaka szöveges hibaüzenetet rajzol ki a néma fehér helyett
  (eddig a hibaoldal is WebView2-re épült, ezért nem jelent meg semmi).
- `2026-11-02` — **Gemma 4 12B a helyi záró szakaszban** (`ollama/gemma4-12b-128k`,
  a `worker`, `local-only` és `vision-worker` route végén). Mérések: 11,95B dense,
  48 réteg, Q4_K_M 8,0 GB, GPU-n fut, generálás 53–77 tok/s, prefill
  1142–1308 tok/s, valódi `tool_calls`, látás MŰKÖDIK (a `vision-test.png`-ből
  kiolvasta a „777"-et, 117 képtoken), magyar szöveg folyékony. Hang: a Google
  szerint a 12B natívan fogad hangot (≤30 s), de az Ollama 0.30.9 HTTP API-ja
  NEM viszi át (mért: `/api/generate` `audio` mező 480 KB WAV-ot némán eldobott
  — 25 tokos prompt; `/api/chat` `messages[].audio` → 400; OpenAI `input_audio`
  → eldobva; `type:audio` → 400), ezért delegálásra nem használható.
  **Három saját hiba, amit a napló leplezett le:** (1) a nyers `gemma4:12b`
  betöltése 15 285 MiB VRAM fölé ment — az ok nem a modell mérete, hanem hogy a
  szerver `OLLAMA_CONTEXT_LENGTH=262144` alapértéke érvényesül, ha a tag nem ad
  `num_ctx`-et; (2) a „dupla betöltés" gyanúja HAMIS, mert
  `OLLAMA_MAX_LOADED_MODELS=1` — a 11–12 s-os újratöltések oka az, hogy egy
  MÁSIK kliens (`-c 4096`, a mérő) és a delegálás felváltva kilökte egymást;
  (3) az `/v1` végpont a `think`-et és az `options.num_ctx`-et is eldobja, ezért
  a gondolkodást csak `reasoning_effort`-tal lehet fogni. Javítás: származtatott
  tag (`PARAMETER num_ctx 131072`, blob-megosztással), a proxy kis keretnél
  (`max_tokens < 2048`) automatikusan `reasoning_effort: none`-t injektál
  (mért: 6,6 s + üres válasz → 0,2 s + helyes válasz), és induláskor
  kontextus-lintet futtat. Üzemeltetési csapda: a proxy `proxy.pid`-je üres
  lehet, miközben egy ÁRVA példány tartja a 4123-at; a `run-proxy-service.ps1`
  „már fut" ága ilyenkor nem indít újat, ezért a valódi PORTBIRTOKLÓT kell
  leállítani (a `netstat` állapotoszlopa ezen a gépen magyar: `HALLGATÁS`).
  Újraindítás csak `wscript`/`cscript` + `*-hidden.vbs` úton (1.2): közvetlen
  `wscript.exe` hívásnál a PowerShell NEM várja meg (GUI-alkalmazás), ezért a
  `restart-proxy-hidden.vbs`-t `cscript`-tel kell futtatni.
