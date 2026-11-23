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

### 2.2 Az alapértelmezett modell RÖGZÍTVE (dsh-model-pin)  (2026-11-23)

Az új munkamenet alapértelmezett modellje **mindig** a rögzített modell:
`deepseek-official/deepseek-flash` (= DeepSeek V4.1 Flash), `reasoningEffort: high`.
A felhasználói kérés szerint ez **nem** követheti a legutóbbi beszélgetésbeli
modellválasztást (a harness alapból éppen azt tenné: `selectModel()` →
`saveSelection()` → a `settings.yaml` `agent-default-model` szekciója).

- A rögzítés **egyetlen** helye: `plugins\dsh-model-pin\pin.json` (hot-reload,
  `enabled: false` kikapcsol). A plugin minden driftre visszaállítja a
  `~\.dsh\settings.yaml` szekcióját.
- **TILOS** a `settings.yaml` `agent-default-model` szekcióját „javítani”: a
  plugin visszaállítja (ez a rögzítés lényege). Más alapértelmezést a
  `pin.json`-ban kell kérni.
- A beszélgetés **saját** modellválasztását ez nem érinti (az session-lokális),
  a delegálás `subagent-model-selection` láncát szintén nem.
- Ellenőrzés: `node tools\check-model-pin.mjs` (settings + junction + patch +
  napló) és `node plugins\dsh-model-pin\test\pin.test.mjs` (15 teszt).
  Napló: `~\.dsh\model-pin.log`. Részletek: `plugins\dsh-model-pin\README.md`.

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

## 3.5 Projekt-szabály őr (dsh-rule-guard) — a szabály NEM csak szöveg

**Miért:** 2026-11-20-án két mért szabálysértés történt, mert a projekt-szabályok
csak `AGENTS.md` szövegként éltek:

- **Video:** a `zene-fa-epites.py --sync` **`os.unlink`-kal** törölt a célfából
  **7 291 borítóképet** (+ 11 275 címkézett másolatot linkké cserélt) a 60 napos
  lomtár-szabály ellenére; ~2 óra újrafutás.
- **L12:** az ágens **új cront** tett a `routes/console.php`-ba
  (`applications:orphan-enrollments`), így az **nem jelent meg az admin
  „Szinkron státusz” listán** (az a `config/app_schedules.php`-ból épül).

**Mi ez:** a `plugins\dsh-rule-guard` plugin a `tools/pre-execute` kapuban, a
tool-hívás ELŐTT dönt, és indoklással blokkol (`{kind:'deny'}`). Session
indításakor a projekt kemény szabályait rövid üzenetként befecskendezi, hogy
tömörítés után is meglegyenek.

**A szabályok** (`plugins\dsh-rule-guard\policy.json`, **hot-reload**):

| szabály | hol | mit tilt |
|---|---|---|
| `delete-needs-trash` | Video, Raider (munkaterület vagy ssh-host szerint) | `rm`, `Remove-Item`, `os.unlink`, `shutil.rmtree`, `rsync --delete`, `find -delete`, `git clean -f`, `dd … of=`, `DROP/TRUNCATE` — kivéve lomtár/mentés/temp cél |
| `no-destructive-code` | Video, Raider (fájlba írt kód) | ugyanez a kódban (ez fogta meg a mért `os.unlink`-ot) |
| `l12-schedule-admin` | L12 | új közvetlen `Schedule::call` a `routes/console.php`-ba; `Schedule::` más fájlban |
| `l12-no-prod-artisan` | L12 | SSH + `php artisan`/`migrate`/`config:cache` az éles hoston |
| `no-name-kill` | **globális** | `Stop-Process -Name`, `taskkill /IM node.exe`, `killall node` (1.6) |

**Kötelező:**
- A tiltás **determinisztikus**, nincs kikapcsolás és nincs `ask`. Ha a felhasználó
  mégis végleges törlést kér, a helyes út a lomtár-mechanizmus (visszaállítható);
  a `policy.json` módosítása tudatos, dokumentált döntés.
- Új szabály: `rules` + a workspace `rules`/`globalRules` listája, majd
  `node tools/check-rule-guard.mjs --verbose` (15 eset) és
  `node plugins/dsh-rule-guard/test/policy.test.mjs` (23 teszt).
- Telepítés (a `~\.dsh` a sandboxon kívül van, ezért **normál PowerShell**):
  `.\plugins\dsh-rule-guard\install.ps1` (junction + profil-patch). A patch
  **boot-időben** töltődik: a plugin a **következő indításnál** lép életbe —
  a futó Harness-t tilos újraindítani (1.5), a felhasználó indítja újra.
- Ellenőrzés: `.\plugins\dsh-rule-guard\install.ps1 -Check`; a döntések naplója
  `~\.dsh\rule-guard.log` (idő, tool, cwd, szabály, indoklás).
- **Ne kerüld meg** a kaput más primitívvel vagy összefűzött stringgel: a szabály
  szándéka a lomtár/mentés, nem a minta megkerülése. Ez háló, nem homokozó.

## 4. Változásnapló

- `2026-11-23` (dsh-model-pin: az alapértelmezett modell **rögzítve** — DeepSeek
  V4.1 Flash) — **a felhasználó kérése: „állítsd be, hogy új munkamenet
  indításakor a felajánlott alapértelmezett modell (ágens) mindig a deepseek v41
  flash legyen, függetlenül attól, hogy mi volt az előző (most az előzőt ajánlja
  fel)”.** (1) **MÉRT OK (a drift forrása):** a harness szándékos viselkedése az,
  hogy az alapértelmezés követi a legutóbbi választást — `dsh-api-session-controller`
  `selectModel()` (`lib/index.js:605–634`) a választás után
  `agentDefaultModel.saveSelection(selected)`-et hív (`:621`), ami a
  `~\.dsh\settings.yaml` `agent-default-model` szekcióját írja
  (`dsh-agent-default-model/lib/index.js:66–72`); az új munkamenet
  `agentOptions()`-a (`:456–462`) és a kliens választójának alapértéke
  (`buildModelCatalog`, `:1991`, `catalog.default`) ugyanezt olvassa. A
  `settings.yaml` mtime-ja (17:30:58) egybeesett az utolsó `model/selection`
  eseménnyel (`session-a6b22838`, 16:30:58Z) — nem elmélet, hanem a napló.
  (2) **MEGVALÓSÍTÁS — új `plugins\dsh-model-pin` plugin** (nem mag-patch, tehát
  a `dsh` csomag frissítése nem törli el): a `pin.json` a rögzítés EGYETLEN
  helye (hot-reload, `enabled: false` kikapcsol), a plugin induláskor
  helyreállítja a `settings.yaml` szekcióját és figyeli a `settings/updated`
  eseményt, minden driftet visszaállítva. A beszélgetés **saját**
  modellválasztását NEM érinti (az session-lokális), a
  `subagent-model-selection` láncot sem. A javítások sorban futnak, 6/60 s-os
  **áramköri fékkel** (§1.7) — nincs lavina; minden hiba elnyelve, a bootot nem
  állítja meg; minden döntés a `~\.dsh\model-pin.log` JSONL naplóba megy.
  (3) **MÉRVE (élő, a futó harness processzben — pid 26332, NEM indult újra):**
  a profil-patch bejegyzés hozzáfűzése után 1 másodperccel megjelent a `boot`
  sor (`16:39:20.602Z`), tehát a patch a **futó** processzbe is betöltődik; a
  `settings.yaml` `agent-default-model` szekciójának szándékos átírása
  `deepseek-v4-pro`-ra **0,4 s alatt** visszaállt, a napló szerint
  `16:39:47.992Z corrected settings-updated deepseek-v4-pro:high →
  deepseek-flash:high`; a teszt után a `settings.yaml` **bájtazonos** a
  mentéssel (SHA256 `3223B95C…C76AC`, 57 404 B, 10 top-level kulcs érintetlen).
  Tesztek: `pin.test.mjs` **15/15**; `node tools\check-model-pin.mjs` minden
  ellenőrzése zöld (settings-szekció, junction, patch-bejegyzés, érvényes YAML,
  napló); `node --check` OK; a profil-patch **11 bejegyzés**, érvényes YAML,
  mentés: `cordis.patch.yml.bak-20261123-173920`.
  (4) **FÁJLOK:** új `plugins\dsh-model-pin\` (`package.json`, `pin.json`,
  `lib\pin.js`, `lib\index.js`, `lib\check-patch.mjs`, `install.ps1`,
  `test\pin.test.mjs`, `README.md`) és új `tools\check-model-pin.mjs`; a szabály
  a **2.2** pontban. A telepítés a `dsh-rule-guard` bizonyított útja (junction
  `~\.dsh\profiles\node_modules\dsh-model-pin` → a repó pluginja + `- insert:`
  bejegyzés; a `~\.dsh` a sandboxon kívül van, ezért jóváhagyással futott).
  (5) **Korlát (kimondva):** a rögzítés a **settings layerre** hat — a
  `settings.yaml` kézi átírása ezért NEM marad meg (ez a lényeg), más
  alapértelmezést a `pin.json`-ban kell kérni; a `pin.json` olvashatatlan
  tartalma esetén a beépített Flash-rögzítés él, a hiba a naplóban van. A
  modellváltás és a javítás között néhány ms-os rés marad (a következő
  munkamenet már a rögzítést kapja).

- `2026-11-23` (dsh-rule-guard: a session-szabály NE user-üzenetként érkezzen) —
  **a felhasználó jelezte: „a raider repó teljesen irreleváns válaszokat ad”.**
  MÉRT OK az utolsó Raider munkamenetből (`session-576aaa5c`): a plugin a
  `agent.inject`-tel a projekt kemény szabályát (`⛔ RAIDER: törlés csak
  lomtárba…`) **`role: user`** üzenetként szúrta be a session elejére, így a
  modell (deepseek-v4-pro, `reasoningEffort: high`) a valódi kérdés
  („nem működik a vezeték nélküli egér”) mellé második felhasználói kérésnek
  vette, rákérdezett („milyen törlési szabály? ez hogy jön az egérhez?”), a
  felhasználó pedig joggal válaszolta: „nem volt ilyen üzenet, honnan vetted?”.
  **Javítás:** `plugins/dsh-rule-guard/lib/index.js` — az injektált szöveg elé
  explicit jelölő kerül: `[Rendszerszabály — állandó projekt-kontextus, NEM
  felhasználói üzenet; nincs belőle feladat, nem kell rá válaszolni vagy
  rákérdezni.]`. A harness `agent.inject` API-ja csak `UserMessage`-t fogad
  (a `dsh-agent` `runtime-types.d.ts` szerint), ezért rendszer-role nem
  adható — a jelölő az elérhető, biztonságos megoldás. A tényleges
  kényszerítés továbbra is a `tools/pre-execute` kapu. **MÉRVE:**
  `policy.test.mjs` 23/23, `check-rule-guard.mjs` 15/15, `node --check` OK.
  **Érvénybe lépés:** a plugin a profilban junction-ön át töltődik, a `policy.json`
  hot-reload; az `index.js` változása a **következő harness-indításnál** él
  (§1.5 — futó session miatt nem indítjuk újra). **KÜLÖN GYÖKÉR-OK (a Raider
  repóban, nem itt):** nincs `AGENTS.md` a `D:\Szerver\Raider`-ben — a modell
  ezért nem tudta, hogy a repó egy **Ubuntu Linux szervert** ír le
  (`192.168.1.252`, `ssh svandor@192.168.1.252`, kulcsalapú, sudo nincs), és a
  **helyi Windows gépet** (VECTOR) debugolta: „milyen windowsról beszélsz? ez
  egy linux szerver, amin nem megy az egér”. A Raider repóba kell egy
  `AGENTS.md` a gépek/SSH/„ez nem a helyi gép” tényekkel (lásd a README
  „Gépek” és „SSH” szakaszát).

- `2026-11-20` (ÁFA a token-költségen: DSH ×1,3462, Ali/OpenRouter ×1,27) —
  **a felhasználó kérése: „finomítani kell a token költségek számításán mind a
  költségelszámolás panelben, mind a delegálási számításoknál … a valós
  számítás szerint a dhs/ali/openr modellek árára minden esetben fel kell
  számítani 27% áfát, illetve a dsh esetében még 6%-ot is … a láblécen az
  egyenleg marad a feltüntetett, szinkronizált tartalom, de amikor valós árakat
  számítunk, akkor a dsh 1,3462 szorzót kap, a másik kettő pedig 1,27
  szorzót.”** (1) **MÉRT ÁLLAPOT (kiváltó ok):** a lábléc kliens-oldali
  szorzói `ALIBABA_VAT_RATE = 1.27` és **`DSH_FEE_RATE = 1.06`** voltak — a
  DeepSeek-oldalon tehát a 6% pótdíj igen, a **27% magyar ÁFA nem** volt benne,
  az OpenRouter/egyéb pedig **egyáltalán nem** kapott szorzót; a
  költségelszámolás panel token-sora és a delegálási megtakarítás pedig
  **nettó listaáron** ment, mert a szorzás csak a lábléc egy szűk
  megjelenítési ágában élt. (2) **MEGVALÓSÍTÁS — EGY forrás, a host:** a
  `plugins\dsh-ui-extras\lib\index.js`-ben új bruttó réteg van a
  KÖLTSÉGSZÁMÍTÁS fölött (`requestCost` / `cacheReadCost`): `VAT_PERCENT = 27`,
  `DSH_SURCHARGE_PERCENT = 6`, `VAT_MULTIPLIER = 1.27`,
  `DSH_GROSS_RATE = 1.27 × 1.06 = 1.3462` (MÉRVE: a JS-ben pontosan 1.3462),
  `GROSS_RATES = { dsh: 1.3462, alibaba: 1.27, openrouter: 1.27, free: 1 }`,
  valamint `grossFamily()` / `grossMultiplier()`. A `MODEL_PRICES` tábla
  **NETTÓ marad** (ez a szolgáltató listája, ehhez lehet a számlát egyeztetni),
  a nettó érték `requestCostNet()`-ként él tovább. Mivel a szorzó a közös
  költségfüggvényben van, **minden fogyasztó egyszerre** a valós árat kapja: a
  panel token-sora, a lábléc `$DSH / $Ali / $OpenR` költés-parja, a
  cache-kedvezmény (alap és megtakarítás), a delegálási `baseline`/`saved`, a
  `spend.*` és a `byProvider[]`. A besorolás: **ingyenes lánc → ×1** (a 0 ár
  marad 0), `openrouter*` → ×1,27, `alibaba*`/`qwen*` → ×1,27, minden más
  (DeepSeek és az ismeretlen, mert az a Flash ár-sorral számol) → ×1,3462.
  (3) **A VÁLASZ KIMONDJA (kétszeres szorzás ellen):** a snapshot új
  `pricing.gross` blokkja (`basis: "gross"`, `vatPercent`, `dshSurchargePercent`,
  `rates`, `note`) és a `netCostUsd` mezők (totals, session, delegated,
  `spend.*NetUsd`, `byProvider[].netCostUsd`, SG-keret arányosan) — a kliens
  csak akkor szoroz, ha a host **régi** (nincs `basis`), különben a kapott
  számot használja. (4) **KLIENS (`plugins\dsh-ui-extras\lib\client.js`):** a
  beégetett `DSH_FEE_RATE` helyett a szorzók a `pricing.gross`-ból jönnek
  (`grossOf()` / `grossRateOfFamily()`), a tooltip új `usageGrossLine` sora
  mondja ki, hogy minden itteni összeg bruttó, az egyenlegen viszont **nincs**
  szorzó; a HU/EN szövegek (usageTaxNote, usageSessionCost, usageWindowCost,
  usageActiveDays, usageSavings*, spendPair*) „bruttó/gross” jelölést kaptak.
  Az **Alibaba-számla API-ja továbbra is nettó**, ezért a számla bruttója a
  `pretaxAmount × 1.27` marad (ez nem kettős szorzás: az API-ból jövő összeg).
  (5) **PANEL (`plugins\dsh-koltseg\lib\client.js`):** a token-sor felirata
  „bruttó, áfával”, alatta a bontás (nettó listaár + 27% áfa, DSH-nál +6%) a
  host `pricing.gross`-ából; ha a host még régi, a sor „nettó listaár — a host
  még a régi build” feliratot kap (nem hazudik bruttót nettó számra).
  (6) **DELEGÁLÁSI SZÁMÍTÁSOK:** `providers\check-delegation-route.mjs` a közös
  `requestCost`-tal már bruttó (a fejléc ki is mondja);
  `providers\analyze-orchestration.mjs`, `analyze-escalation.mjs`,
  `analyze-model-choice.mjs` és `autotune.mjs` a `GROSS_RATES`-et importálja a
  pluginból (egy forrás), az `autotune` a **számla-egyeztetést szándékosan
  nettó** hagyja (`withVat = false`), a `check-vs-bill.mjs` szintén nettó, és
  ezt ki is mondja. (7) **MÉRVE (valódi naplók, 30 nap):** `check-usage.mjs`
  → **minden ellenőrzés zöld**, a kimutatott összeg bruttó:
  **nettó $138.20 → bruttó $186.03**; a delegált baseline
  **nettó $29.10 × 1.3462 = $39.18 bruttó**; a szorzó-teszt szerint
  `deepseek-official/deepseek-flash` ×1,3462, `alibaba`/`alibaba-compat`/
  `alibaba-intl` ×1,27, `openrouter/<fizetős>` ×1,27,
  `openrouter/<:free>` ×1, `worker` ×1, ismeretlen ×1,3462; 1M Flash-token
  csúcsáron nettó $1,506 → bruttó $2,0274. (8) **TESZTEK:** ui-extras
  usage **8/8** (két új: „a kimutatott költség BRUTTÓ”, „a delegálási baseline
  is BRUTTÓ”), a többi ui-extras teszt 4+2+1+8+8 zöld, koltseg engine **37**,
  client **13** (HU/EN kulcs-paritás!), host **12**, `check-price-table`
  **19/19**. A `check-plugin.mjs` minden tartalmi ellenőrzése zöld (a
  szótár-paritás, a naptár- és a csúcsidő-egyezés is) — a folyamatfa-ölés
  próbája a sandboxban nem fut (EPERM spawn, és §1 miatt nem is eszkaláljuk).
  (9) **ÉRVÉNYBE LÉPÉS:** a **kliens-oldali** rész (lábléc-szövegek, panel
  felirata) **panel-újratöltéssel** él; a **host-oldali** rész (a szorzó
  maga, a `pricing.gross`) a **következő harness-indításnál** (§1.5 — a futó
  session miatt nem indítjuk újra). Amíg a host régi, a kliens a saját
  tartalék szorzóival számol (1,3462 / 1,27), tehát a lábléc már most bruttó.
  (10) **FÁJLOK:** `plugins\dsh-ui-extras\lib\index.js`,
  `plugins\dsh-ui-extras\lib\client.js`,
  `plugins\dsh-koltseg\lib\client.js`, `tools\check-usage.mjs`,
  `plugins\dsh-ui-extras\test\usage.test.mjs`,
  `providers\check-delegation-route.mjs`, `providers\analyze-orchestration.mjs`,
  `providers\analyze-escalation.mjs`, `providers\analyze-model-choice.mjs`,
  `providers\autotune.mjs`, `providers\check-vs-bill.mjs`,
  `docs\KOLTSEG-ELSZAMOLAS.md`, `docs\KOLTSEG-ELSZAMOLAS.en.md`.
  **(11) FELHASZNÁLÓI JELZÉS ugyanezen a napon: „hibás a számítás. a token
  költség éppen hogy nem tartalmazza az áfát, helyette azt írja, hogy ez nettó,
  ez pont annak az ellenkezője, amit állítottál. nincs továbbá folyamatjelző,
  amikor éppen számítást végez a panel, ezért az áfa check box is úgy tűnik,
  mintha nem működne.”** A (5) pont ELSŐ változata ezt hagyta: amíg a host a
  régi buildet futtatta, a panel a NETTÓ összeget írta ki „nettó listaár — a
  mérés még a régi bontásból való” felirattal. Ez elfogadhatatlan: a panelnek
  MÁR MOST a fizetendő árat kell mutatnia. Ráadásul a `/koltseg/measure` a
  KORÁBBI eredményt hagyta a képernyőn, csak a válasz után cserélte — semmi nem
  jelezte, hogy dolgozik, ezért az ÁFA-kapcsoló (ami a mérés
  `vatPercent`-jéhez volt kötve, nem a konfigurációhoz) „nem működőnek” tűnt.
  **(12) JAVÍTÁS — a panel MAGA áfázik, host-independensen
  (`plugins\dsh-koltseg\lib\client.js`):** új tiszta primitívek
  (`grossRatesOf`, `isHostGross`, `grossRateOfModelName`, `grossFactorOf`, a
  `__util`-ban exportálva) a válasz `perModel` bontásából számolnak:
  modellenként ×1,3462 (DSH/ismeretlen) vagy ×1,27 (Alibaba/OpenRouter), az
  így kapott szorzót a nettó `totals.costUsd`-ra alkalmazva. Ha a host MÁR
  bruttót ad (`pricing.gross.basis = "gross"`), a panel NEM szoroz (nincs
  kétszeres áfa). A cache-kedvezmény két összege ugyanezzel a szorzóval megy,
  a „nettó listaár” felirat **törölve** — a sor mindig „bruttó, áfával”, alatta
  a bontás (nettó + áfa + DSH-pótdíj, a szorzókkal kiírva).
  **(13) JAVÍTÁS — folyamatjelző (`busyAt` + CSS pörgő):** a mérés indulásakor
  és végén állítjuk a `busyAt`-ot; a panel gyökerében egy `<style>` adja a
  `@keyframes dsh-koltseg-spin`-t (a panel csak inline stílust használ), a
  jelző a mérés-sornál, a token-sornál ÉS a kapcsolók mellett is megjelenik. A
  20 s-os háttér-frissítés szándékosan NEM villogtatja. Az **ÁFA-pipa a
  konfigurációból** olvas (`config.config.vatEnabled`), ezért a kattintás
  AZONNAL látszik, a hosszabb újraszámolást a pörgő mutatja.
  **(14) A LÁBLÉC delegálási blokkja is bruttó a régi hostnál
  (`plugins\dsh-ui-extras\lib\client.js`):** a megtakarítás eddig SZORZÓ NÉLKÜL
  ment (nettó), a költség-sorok pedig csak a provider-soron kaptak áfát. Most
  modul-szintű `grossFromModels` / `grossRateOfModelName` / `GROSS_FALLBACK`
  (exportálva a `check-plugin`-nek) számol a `perModel` és `delegated.models`
  bontásból; a baseline egységesen ×1,3462; bruttó hostnál nincs szorzás.
  **(15) MÉRVE:** `check-plugin.mjs` **4 új esete** zöld (modell-család szerinti
  áfázás; nettó bontásból pontos bruttó; bruttó hostnál nincs dupla szorzás;
  baseline ×1,3462), a többi tartalmi ellenőrzés változatlanul zöld (a
  folyamatfa-ölés a sandboxban nem fut, §1); `koltseg` client **16/16** (3 új
  eset), ui-extras usage **8/8**, a többi készlet zöld. VALÓDI ADATON (ez a
  munkaterület, 30 nap): a host válasza nettó **$20,4106**, a `perModel`
  összege **pontosan ugyanennyi**, a panel bruttója **$27,4768** (szorzó
  1,3462, forrás `model`); a motor ugyanezt **$27,5077**-nak méri — a $0,03
  különbség a két mérés közti forgalom (a `deepseek-flash` aránya a motor és a
  panel között 1,34826 a várt 1,3462 helyett, azaz 0,15% adatdrift;
  `auto-router/auto` és `deepseek-v4-pro`: pontosan ×1,3462). A kiszolgált
  bundle-ök a HTTP-ről ellenőrizve tartalmazzák az új kódot
  (`grossFactorOf`/`dsh-koltseg-spin`/`vatOn`, illetve
  `grossFromModels`/`baselineRate`) → **panel-újratöltés** elég.
  **(16) HARMADIK FELHASZNÁLÓI JELZÉS ugyanezen a napon: „továbbra sincs
  folyamatvisszajelzés, ha a költségelszámolásban átkapcsolok munkaterületre,
  nem lehet tudni, hogy kiírta-e már az eredményt, ha módosítok a
  beállításon.”** A (13) pörgője önmagában kevés volt: a `/koltseg/measure`
  **MÉRVE 0,4–0,6 s** alatt válaszol (workspace 621 ms hidegen, 384 ms
  `fresh=1`-gyel), tehát a jelző egy villanás volt, a számok pedig **csendben**
  cserélődtek ki — ráadásul a kérés ideje alatt a blokk az ELŐZŐ kiválasztás
  számait mutatta, ugyanolyan kinézettel, mint a kész eredmény. (17) **JAVÍTÁS
  (`plugins\dsh-koltseg\lib\client.js`):** a mérés állapota most a kiválasztás
  KULCSÁT is hordozza (`measureState.key`), és az új, TISZTA
  `measureFeedback(state, requestedKey, busyAt)` dönti el a jelzést
  (`stale`, `busy`, `label`; a `__util`-ban exportálva, tesztelve). Hatás:
  (a) a **számok blokkolja elhalványul (40%)**, amíg az új beállítás mérése fut;
  (b) felette pörgő + **félkövér** „Újraszámítás folyamatban… (a számok még az
  előző beállításból valók)”; (c) a blokkban „Ez a szám még az előző
  beállításból való ({idő})”; (d) sikeres válasz után **„Frissítve: HH:MM:SS”**
  — ez mondja meg, hogy kiírta-e már; (e) a jelző **minimum 700 ms-ig látszik**
  (`MIN_BUSY_MILLISECONDS`), hogy észlelhető legyen, a 20 s-os háttér-frissítés
  viszont nem villogtat. A **`BUILD` felment `2026-11-20.1`-re**, hogy a panel
  fejlécében (`v2026-11-20.1`) LÁTSZODJON, melyik kliens fut — a korábbi
  `2026-11-17.4` mellett a felhasználó nem tudhatta, új-e a panel; a
  „render belépett” diagnosztika is viszi a buildet (`state\koltseg.log`).
  **MÉRVE:** `koltseg` client **17/17** (új eset: „a számok »elavult« jelzése a
  kiválasztás kulcsából jön” — friss/átkapcsolt/loading/kulcs nélküli eset), a
  kiszolgált bundle a HTTP-ről ellenőrizve tartalmazza a `2026-11-20.1`-et, a
  `status.recalculating`/`status.stale`/`status.updated` szövegeket, a
  `measureFeedback`-et és a `resultStale` stílust. **Érvénybe lépés:** a panel
  ÚJRATÖLTÉSE (a fejlécben `v2026-11-20.1` kell legyen).
- `2026-11-20` (boot utáni kicsi/fehér ablak) — **a felhasználó boot után azt
  látta, hogy „az ablak teljes képernyőn jelent meg, de csak a képernyő egy kis
  részét foglalta el", majd a 2-es ablakra váltva „tiszta fehér lett az egész",
  és be kellett zárnia.** A kiváltó okok: a boot ELŐTTI halott tokennel nyitott
  ablak, a HWND-szintű rejtés/mutatás (a WPF nem tud róla), az egyidejű
  WebView2-indítás, ÉS az, hogy a függő tálca-frissítés **két napja nem lépett
  életbe**. (1) **MÉRT IDŐVONAL (`state\native-tray.log` + `state\window.log`,
  04:01:56–04:03:27):** 04:01:56 tálca indul (autostart, Registry `Run` =
  `bin\DshTray.exe`), 04:02:07 **mindkét** munkaasztal ablaka ugyanabban a
  másodpercben indul (`munkaasztal 1 pid=28124`, `munkaasztal 2 pid=12308`),
  04:02:08 `navigation failed: status=Unknown http=404` a `zKaI…` tokennel (ez a
  **boot előtti** `state\harness.url`), 04:02:14 friss token (`mWq3…`),
  04:02:16–17 minden panel újratölt (a 2. asztal ablaka **már rejtve** volt
  04:02:14 óta), 04:02:56 `asztalvaltas -> 2` → fehér, 04:03:10 a felhasználó
  bezárja (geometria mentve), 04:03:14 tálcaikonra újranyitva (friss tokennel) →
  hibátlan. (2) **GYÖKÉR-OKOK:** (a) **A függő frissítés nem lépett életbe:**
  `bin\DshTray.exe.new` (2026-11-18 15:32, a halott tokenre navigálás javítása)
  mellett `bin\DshTray.exe` **2026-11-17 14:31** volt — a `PendingUpdate`
  `IsLocked()`-ja a SAJÁT futó képet kihagyta, az autostart pedig közvetlenül a
  `DshTray.exe`-t indítja (a `PendingUpdate.Apply` csak a `DshLauncher`-en át
  jutott volna be). Ezért a tálca a boot előtti tokent adta át, a 404-es
  hibaoldal + a rejtés alatti újratöltés pedig fehér paneleket hagyott. (b) **A
  „megjelenés utáni újraméretezés" halott kód volt:** a `DshWindow`
  `window.IsVisibleChanged` eseményre épített, a tálca viszont a HWND-t rejti/
  mutatja `ShowWindow`-nal — ettől a WPF `Visibility` **nem** változik meg.
  (c) `IsZoomed`/`showCmd=3` esetén a maximalizált téglalap kisebb is maradhat a
  monitor munkaterületénél (boot alatti monitor-felállás), ezt semmi nem
  ellenőrizte. (d) §1.8: a 2. asztal előindítása az 1. asztal ablakának
  elkészülte előtt futott (a 8 s a tálca indulásához mérődött, nem az ablakhoz).
  (3) **JAVÍTÁS — `src\PendingUpdate.cs`:** a SAJÁT futó lemezkép **átnevezéssel**
  cserélődik (a Windows a leképezett képet megtartja) — MÉRVE ártalmatlan
  teszttel: futó `wscript.exe` átnevezése **OK**; hiba esetén a mentés
  visszakerül; az eredmény a tálca naplójába megy. (4) **JAVÍTÁS —
  `src\DshWindow.cs`:** új `WindowRecovery` (a) `WM_SHOWWINDOW` + rejtés-jelző
  (csak VALÓDI rejtés→megjelenítés után ébreszt, a legelső megjelenésnél nem
  villant), (b) a tálca `DshHarnessWake` üzenete (`RegisterWindowMessage`) mint
  független jel, (c) `WM_DISPLAYCHANGE` + betöltés; a `DshWebViewHost.WakeUp()`
  a **dokumentált** `CoreWebView2Controller.IsVisible` false→true váltással
  hozza létre újra a felületet (3 kör: 120/700/1900 ms, csak az első épít
  felületet); a `FillCheck` a maximalizált téglalapot a **monitor
  munkaterületéhez** méri (max. 5 próba, §1.7), és szükség esetén Normal→
  Maximized; a `NoteSizeMismatch` 2 egymást követő eltérés után a gyerekablakot
  a panel valódi méretére állítja (`SetWindowPos`) — ez adja a „csak egy kis
  részén van tartalom" képet. (5) **JAVÍTÁS — `src\DshTray.cs`:**
  `EnsureMaximized` a méretet is ellenőrzi (`GetWindowRect` +
  `MonitorFromWindow`/`GetMonitorInfo`), és ha a maximalizált ablak kisebb a
  munkaterületnél, `RESTORE` + `MAXIMIZE`; a megjelenítés (`ShowDesktopWindow`,
  `ApplyDesktopOnce`, `ShowWindow`) csak akkor küld `WakeWindow`-t, ha az ablak
  ELŐTTE rejtve volt; az `EnsureOtherDesktopWindows` az
  `WaitActivePanesReady`-vel megvárja az aktív asztal paneleit
  (`ReadyPaneCountSince`: a napló `webview2 controller ready (pane N)` sorai az
  ablak indítási ideje után, max. 20 s + 1,2 s ráhagyás), és csak utána indítja a
  második asztalt; a `PendingUpdate.Apply` a `TrayApp` konstruktorába került, a
  `Log.Init` UTÁN (mérhető eredmény). (6) **ÉLESÍTÉS (MÉRVE):** `.\build.ps1` →
  exit 0, `bin\DshWindow.exe` **112 128 B**, `bin\DshTray.exe` **66 048 B**,
  `bin\DshLauncher.exe` **25 088 B**; a futó példányokat **nem** állítottam le
  (§1.5) — a cserét a futó képek átnevezése végezte (mentések:
  `DshWindow.exe.old-20261120-041252`, `DshTray.exe.old-20261120-041252`), a
  folyamatok élnek és válaszolnak (tálca 26188, ablakok 28124 / 24852). A bináris
  tartalma bájt-szintű UTF-16 kereséssel ellenőrizve (pl. „DshHarnessWake",
  „surface re-created after show", „panelei keszen", „pending update applied
  while running"). A pane-készlet olvasója a VALÓDI `window.log`-on emulálva:
  04:02:07 után **3**, 04:03:14 után **3** kész panel. **Érvénybe lépés:** a
  felhasználó tálca „Kilépés" → ikon (a futó tálca/ablak a régi képet futtatja).
  **Visszavonás:** `Move-Item bin\DshWindow.exe.old-20261120-041252
  bin\DshWindow.exe -Force` (ugyanígy a tálcára). **Ami NEM mérhető reboot
  nélkül:** a fehér ablak tényleges előfordulása — a következő booton a napló
  kimondja: „panels waking up (…)", „pane N: surface re-created after show",
  „window fills its monitor: …", „surface forced to …", „ablak maximalizált, de
  kisebb a munkaterületnél", „asztal 1 panelei keszen (3/3)".

- `2026-11-20` (projekt-szabály őr) — **a projekt-szabályok GÉPILEG kényszerítve:
  új `dsh-rule-guard` plugin blokkolja a lomtár nélküli törlést, az admin
  cron-listából kimaradó ütemezést és a név szerinti folyamatölést.**
  (1) **MÉRT INCIDENSEK (a kiváltó ok):** (a) **Video** — a
  `zene-fa-epites.py --sync` `sync_target` ágában **`os.unlink`** állt, és
  2026-11-20 01:35-kor (UTC) a célfából **7 291 borítóképet** törölt, valamint
  11 275 címkézett másolatot linkké cserélt, a Video `AGENTS.md` 1. pontja
  (60 napos lomtár) ellenére; ~2 óra újrafutás, a gyűjtő érintetlen. (b) **L12**
  — 2026-11-20 01:52-kor az ágens **új közvetlen cront** tett a
  `routes/console.php`-ba (`->name('applications:orphan-enrollments')`), így az
  **nem jelent meg az admin „Szinkron státusz” listán**, mert az a
  `config/app_schedules.php` `jobs` tömbből épül (`MasterDataSyncStatusService`
  → `MasterDataSyncScheduleSettings::ids()`); a session végén az ágens maga
  ismerte el és átmozgatta. A szöveges szabály tehát nem kényszerít.
  (2) **MEGVALÓSÍTÁS — `plugins\dsh-rule-guard`:** a `tools/pre-execute`
  vízesésben a tool-hívás ELŐTT dönt (`{kind:'deny', reason}`), a szabályok a
  `policy.json`-ban élnek (**mtime hot-reload**, újraindítás nélkül); session
  indításkor a projekt kemény szabályait rövid plugin-üzenetként befecskendezi
  (`agent/session-start` → `agent.inject`), hogy tömörítés után is meglegyenek.
  A motor (`lib/policy.js`) tiszta, FS/hálózat nélkül tesztelhető; a plugin
  minden hibát elnyel (hiba esetén ENGED, a bootot nem állítja meg). **5 szabály,
  4 workspace:** `delete-needs-trash` + `no-destructive-code` (Video/Raider,
  munkaterület VAGY ssh-host szerint: 192.168.1.8, video.kepzes.eu,
  192.168.1.252, raider), `l12-schedule-admin` (a `config/app_schedules.php`
  a kapu; a `routes/console.php`-ban csak a 11 meglévő közvetlen cron neve
  engedett), `l12-no-prod-artisan` (SSH + artisan), globális `no-name-kill`
  (§1.6). A lomtár-szabály kivételei: lomtár/mentés/`/tmp`/`%TEMP%`/`.tmp`
  cél, `dd … of=/dev/null`, tiszta olvasó sor, kereső eszköz mögötti minta
  (`grep "rm -rf"`), és a `.md`/dokumentáció (csak kód-kiterjesztésre fut).
  (3) **MÉRVE — valós session-naplók újrajátszása a motorral** (`node
  tools/replay-rule-guard.mjs`, a tömörített naplókból, frame-enként dekódolva):
  **Video** (2026-11-11 … 11-20, 943 tool-hívás) → **14 blokk**, mind törlési
  kísérlet, köztük a **2 `os.unlink`-os szerkesztés** (2026-11-17 05:50/05:52),
  ami a 7 291 borító törlését okozta — a kapu ezt már a fájlba íráskor megfogta
  volna. **L12** (4 session, 1 090 hívás) → **1 blokk: pontosan a mért
  szabálysértés** (2026-11-20 01:52, `applications:orphan-enrollments`); a másik
  3 session (865 hívás) **0 téves riasztás**. A hamis riasztások a mérés alapján
  javítva: `grep "rm -rf"` (kereső eszköz mögötti minta), `dd if=… of=/dev/null`,
  `.tmp` piszkozat-szkriptek, `.md` dokumentáció. (4) **TESZTEK:** `node
  plugins/dsh-rule-guard/test/policy.test.mjs` → **23/23**; `node
  tools/check-rule-guard.mjs --verbose` → **15/15** (konzisztencia + a mért
  esetek + a helyes megoldások engedve); a plugin `apply()` szimulációja valódi
  (fake) ctx-szel: regisztrál (`tools/pre-execute`, `agent/session-start`),
  a Video `os.unlink` és az L12 új cron **deny**, a lomtár-mozgatás **allow**.
  (5) **TELEPÍTÉS (MÉRVE):** junction
  `~\.dsh\profiles\node_modules\dsh-rule-guard` → a repó plugInja (Target
  ellenőrizve), a `~\.dsh\profiles\web\cordis.patch.yml` **10 bejegyzés**, a
  `rule-guard` bent, **érvényes YAML** (`lib/check-patch.mjs`, a `js-yaml` a
  profilból); mentés: `cordis.patch.yml.bak-20261120-032506`. A `~\.dsh` a
  sandboxon kívül van, ezért a telepítés jóváhagyással futott (egyszeri
  eszkaláció). **Érvénybe lépés:** a patch BOOT-időben töltődik → a plugin a
  **következő indításnál** él; a futó Harness-t NEM indítottuk újra (§1.5), a
  felhasználó indítja (tálca Kilépés → ikon). A `policy.json` viszont onnantól
  **újraindítás nélkül** frissül. (6) **FÁJLOK:** új
  `plugins\dsh-rule-guard\` (`package.json`, `policy.json`, `lib\policy.js`,
  `lib\index.js`, `lib\check-patch.mjs`, `install.ps1`, `test\policy.test.mjs`,
  `README.md`), új `tools\check-rule-guard.mjs`; a Video/L12 `AGENTS.md`
  kiegészítve a kényszerítés tényével; a szabály részletei a 3.5 pontban.
  **Korlát (kimondva):** ez háló, nem homokozó — a mintafelismerést meg lehet
  kerülni; a cél a véletlen/megszokásból fakadó szabálysértés kizárása.

- `2026-11-19` (modell-lista rendezés) — **a `~/.dsh/settings.yaml` llm-pi-ai
  modell-listái élő katalógusból ellenőrizve és rendberakva; az OpenRouter
  új ingyenes modelljei felvéve; a DeepSeek V4.1 Flash a legújabb flash.**
  (1) **MÉRT állapot (élő `/models` + kulcsok, 2026-11-19):** OpenRouter **444**
  modell (16 ingyenes), NVIDIA **32**, Google **50**, Groq **11**, Alibaba EU
  **49**, DeepSeek hivatalos **2** (`deepseek-flash`, `deepseek-v4-pro`),
  a helyi proxy **7** route. (2) **TÖRLÉS — nem elérhető / elavult (83 db):**
  a `nvidia` listából a végponton már nem szolgált `meta/llama-3.2-90b-vision-instruct`,
  valamint a 3 téves duplikátum (a `nvidia/riva-translate-4b-instruct-v2`
  háromszor, más-más Llama/Mistral névvel, és a `nvidia/nemotron-3-ultra-550b-a55b`
  kétszer); az `alibaba` ÉS `alibaba-compat` listából **39-39** olyan id
  (qwen3-vl-flash/32b/235b, qwen3-max*, qwen3-coder-*, qwen3-next-*, qwen3-8b/32b,
  qwen-plus-2025-*, qwen-mt-turbo, `llm-3.7-drillrun-5-deepseek-v4.1-flash`,
  `llm-3.6-drillrun-4-kimi-k3`, `deepseek-v4-flash`), amit az Alibaba EU
  végpontja már nem listáz. (3) **OPENROUTER újragenerálva az élő katalógusból
  (`node tools/model-list-tidy.mjs`):** a korábbi lista 3 bejegyzése tévesen a
  `cohere/north-mini-code:free` id-re mutatott (Poolside Laguna S/XS, Thinking
  Machines Inkling), egyszer pedig a `:free` utótag hiányzott
  (`thinkingmachines/inkling-small`) — ezek helyett a **tényleges ingyenes**
  készlet él: 13 ingyenes chat-modell + `openrouter/free` router. **ÚJ:** 
  `inclusionai/ling-3.2-flash:free`, `baidu/ernie-5.5-flash-preview:free`,
  `nvidia/nemotron-3.5-super-vl:free` (a proxy vision-láncának első tagja, eddig
  hiányzott a listáról!), `particle-ai/particle-1:free`,
  `recursive/flint-v1.0:free`; a név/kontextus/kimeneti keret a katalógusból jön,
  a multimodálisaknál `input: [text, image]`. A **428 fizetős** modell
  szándékosan NINCS a listán (a delegálási lánc ingyenes célokra épül), a 2
  `google/lyria-*` kép/hang generáló, ezért kimaradt. **FIGYELEM (mért):** a
  `thinkingmachines/inkling-2-small` a nap folyamán FIZETŐSSÉ vált (0,3 $/M be) —
  ezért nem került be; az ingyenes készlet a napon belül is változik, a
  listát ezért csak mérés után szabad alkalmazni. (4) **Javított hivatkozás:**
  a `subagent-model-selection.allowedModels` egy `subagent-worker/vision-worker`
  célra hivatkozott, ami a listából hiányzott (a proxy viszont szolgálja) —
  most felvéve, így a kép-delegálás nem metaadat nélküli (text-only) úton megy.
  (5) **DeepSeek V4.1 Flash = a legújabb flash (bizonyíték):** a hivatalos
  `/models` a `deepseek-flash` id-t **„DeepSeek-V4.1-Flash”** néven adja
  (1 048 576 kontextus, 393 216 max kimenet, text+image, `in-history` system
  prompt); a gateway szerint a támogatott nevek: `deepseek-flash`,
  `deepseek-v4-pro`; a `deepseek-v4.2-flash` és `deepseek-v5-flash` próba
  **400**-at ad („supported API model names are deepseek-flash, deepseek-v4-pro”).
  A `deepseek-v4-flash` és `deepseek-v4-flash-vision-exp` **alias** (200, a válasz
  `model=deepseek-flash`), tehát nem halott. Az OpenRouteren a legfrissebb
  DeepSeek a `deepseek/deepseek-v4.1-flash` (2026-09-10) és a
  `deepseek-v4.1-flash-1017` snapshot (2026-10-17); **V4.2 nem létezik**, és az
  NVIDIA már nem szolgál `deepseek-ai/*` modellt (a korábbi „DeepSeek V4.1
  Flash” nevű nvidia-bejegyzés valójában `minimaxai/minimax-m3.1-flash` volt —
  átnevezve). (6) **Eszközök:** új `tools/model-list-tidy.mjs` (dry-run
  tervezet → `--apply` írás időbélyeges mentéssel) és `tools/model-inventory.mjs`
  (élő katalógus-pillanatkép a `state/model-catalog/` alá); a
  `providers/check-providers.mjs` listaelemzése javítva (a kommentsorok eddig
  megszakították a `models:` blokkot, ezért a felvett modellek egy részét nem is
  látta). A `providers/settings.llm-pi-ai.yaml` sablon OpenRouter/NVIDIA blokkja
  az új, ellenőrzött listát tartalmazza. **ELLENŐRZÉS:** `node
  providers/check-providers.mjs` → **8 provider, 0 hibás modell-id**, a
  settings.yaml YAML-je érvényes, a top-level kulcsok és a provider-mezők
  változatlanok. **Érvénybe lépés:** a settings.yaml a pi-ai adapterben
  újraregisztráláskor él (nincs harness-restart), a fájl mentése után a
  modellválasztó a friss listát mutatja.
  **(7) Eszkalációs engedély (2026-11-19, második kérés): „nem tud openrouterre
  eszkalálni”.** MÉRT OK (a másik repó session-naplója, `session-cdd5140f`,
  14:00:36): `Error: child LLM route "openrouter/claude-haiku-5.5" is not
  allowed for this Session` — nem a modell-lista hibája: az eszkalációt a
  `subagent-model-selection.allowedModels` ENGEDÉLYLISTA dönti el, abban pedig
  csak egy OpenRouter-route volt (`nvidia/nemotron-3.5-lightning:free`). Ráadásul
  a kért id `anthropic/` előtag nélkül szerepelt, és így még a katalógusban sem
  létezik. Ugyanebben a sessionben korábban `Error: LLM provider "deepseek" is not
  allowed for this Session` (13:06) — a helyes providernév `deepseek-official`.
  **Javítás:** `tools/model-list-add.mjs` (új eszköz, élő katalógusból vesz fel
  modellt) felvette az `openrouter` providerek közé az `anthropic/claude-haiku-5.5`
  tételt (1M kontextus, 128k kimenet, text+image, FIZETŐS: $0,10/M be, $0,50/M ki,
  cache-read $0,01/M) ÉS a `allowedModels` listába. MÉRVE: élő OpenRouter-hívás
  `HTTP 200` („OK”, 648 ms), `check-providers.mjs` → openrouter **15/15**,
  YAML érvényes, mentés: `settings.yaml.bak-2026-11-19T13-12-02-modell-felvetel`.
  **FONTOS (mért viselkedés, ne téveszd össze „hibával”):** az engedélylista
  **munkamenet-indításkor** rögzül a session naplójába
  (`subagent/model-selection-policy`, a `selectForSession` egyszer írja, a
  gyerek-session a szülő listáját örökli), ezért **a MÁR FUTÓ beszélgetések nem
  látják az új tételt** — saját magamon is ellenőrizve: a settings szerkesztése
  után ugyanaz a session továbbra is `not allowed`-t ad. Ezért az eszkaláláshoz
  **ÚJ beszélgetést kell indítani** abban a repóban; a modellválasztó listája
  viszont élőben frissül. Az ingyenes alternatíva továbbra is
  `openrouter/nvidia/nemotron-3.5-lightning:free` (mért 200).
  **(8) A models beállítás oldal HIBÁI (2026-11-19, harmadik kérés): a route
  `api:` mező hiányzott — ez blokkolta a mentést és a választót.** A GUI két
  hibaüzenetet mutatott: `provider "nvidia" lists model
  "nvidia/riva-translate-4b-instruct-v2" more than once` (ez a RÉGI, még
  betöltött dokumentumé volt — a 13:03-as rendezés már dedupálta) és
  `provider "openrouter" model "liquid/lfm-3-1.7b:free" needs an api…`, illetve
  az „Add model" ablakban `model "anthropic/claude-haiku-5.5" needs an api`.
  **MÉRT OK (a `dsh-llm-pi-ai` `resolveRouteModels` szerint):** a modell
  drótprotokollja `route.api → katalógusbeli api → a route KÖZÖS api-ja`; az
  OpenRouter katalógusa viszont **két** protokollt használ
  (openai-completions 351 + anthropic-messages 15), ezért nincs „közös" api, és
  minden katalóguson kívüli modell (a haiku, a baidu/ernie, a ling-3.2, a
  particle, a flint, a nemotron-3.5-super-vl, és már korábban a liquid is)
  elutasításra került → **a settings-dokumentum soha nem lett elfogadva**, ezért
  a választó a régi listát mutatta („Inkling Small (free)") és a mentés
  elbukott. **Javítás:** `api: openai-completions` az `openrouter` route-on (az
  `/api/v1/chat/completions` OpenAI-kompatibilis, a Claude is ezen megy);
  ugyanez a sablonba is bekerült. **ÚJ ESZKÖZ:** `tools/check-model-config.mjs`
  — a pi-ai szabályait (duplikált id, api-feloldás, baseURL, kontextus/keret)
  HELYBEN reprodukálja a valódi katalógussal, tehát a settings szerkesztése
  előtt/után azonnal látszik, mit fog a GUI elutasítani. **MÉRVE:** a
  checker „Minden route érvényes"; `check-providers.mjs` → 8 provider, 0 hibás
  id (openrouter 15/15); a route az api-váltás után is válaszol (subagent
  `openrouter/nvidia/nemotron-3.5-lightning:free` → „OK"). **Érvénybe lépés:** a
  settings-dokumentum most már elfogadható, ezért a `settings/document-updated`
  eseményre a kliens katalógus frissül (a `ModelDirectoryResolver` figyeli), és
  a választó a 15 OpenRouter-modellt mutatja; a haiku eszkalálásához továbbra is
  **új beszélgetés** kell ((7) pont: a allowlist munkamenet-indításkor rögzül).
  **(9) Kétszintű modellválasztó (2026-11-19, negyedik kérés): szolgáltató →
  modell.** A felhasználó képernyőképe szerint a gyári választó egyetlen
  görgethető listába ömlesztette MINDEN szolgáltató modelljeit (a csoportcímek
  csak elválasztók) — „így nem lehet eligazodni”. **Megvalósítás
  (`plugins/dsh-ui-extras/lib/client.js`):** a composer fészke a
  `conversation.input.model` slot EGYETLEN bejegyzése, ezért a gyári
  (priority 0) bejegyzést egy **priority −100**-as saját bejegyzéssel
  árnyékoljuk (ugyanaz a minta, mint a „hide core job chip”-nél: azonos
  priority = dob, más priority = csere, a legalacsonyabb renderel). A
  slot-szerződést (`available/directory/load/select/t`) VÁLTOZATLANUL a gyári
  `inject` adja, ezért a kiválasztás ugyanazon a közös `ModelDirectory`-n megy,
  mint a `/model` popupé. A menü: gyökér = „Modell: <jelenlegi> ›” +
  „Gondolkodás ›” (ha van effort) → **szolgáltató-lista** (név + „N modell” +
  ›) → **az adott szolgáltató modelljei** (pipával) → kiválasztás. A sorokat a
  **`seatPaneRows(pane, view)` TISZTA függvény** állítja elő, ezért böngésző
  nélkül tesztelhető; a stílusok inline-ok a téma-tokenekkel
  (`--dsw-specific-menu`, `--dsw-elevation-prominent`, `--dsw-alias-*`), így
  nincs CSS-modul függés. Hiba esetén a fészek LÁTHATÓ marad (magyarázó sor a
  menüben), alügynök-sessionben pedig nem renderel (mint a gyári).
  **MÉRVE:** `node plugins/dsh-ui-extras/test/model-seat.test.mjs` **7/7**
  (köztük: a gyökérben NINCS modell-sor, a szolgáltató-választó csak
  szolgáltatókat sorol darabszámmal, a `provider:openrouter` pane-en CSAK annak
  a szolgáltatónak a modelljei látszanak — a másiké nem szivárog be —, a
  kiválasztás a helyes `{provider, model}` objektumot adja), a meglévő ui-extras
  tesztek **21/21** zöldek, `node --check` OK. **Érvénybe lépés:** kliens-oldali
  változás → **panel-újratöltés** (a kiszolgált bundle a fájlt élőben olvassa);
  visszavonás egy lépés: a `safeRun("model seat: provider first", ...)` blokk
  törlése (vagy `git checkout plugins/dsh-ui-extras/lib/client.js`) +
  panel-újratöltés — a gyári fészek ilyenkor azonnal visszatér.
  **(10) „Nem működik a Claude Sonnet” — 404 a hiányzó `/v1` miatt, és a GUI
  által behúzott 102 halott modell (2026-11-19, ötödik kérés).** A kérés
  `404: {"message":"Not Found","code":404}` + `PI_AI_ERROR` hibával esett el.
  **MÉRT OK:** a route `api: openai-completions` beállítása után a
  **katalógusbeli** modellek a saját baseUrl-jüket használták
  (`https://openrouter.ai/api`, `/v1` NÉLKÜL), és az openai-completions út csak
  `/chat/completions`-t fűz hozzá → `https://openrouter.ai/api/chat/completions`
  = **404**; ugyanaz `/api/v1/chat/completions`-en **200** (közvetlen mérés,
  `anthropic/claude-sonnet-5`). **Javítás:** `baseURL:
  https://openrouter.ai/api/v1` a route-on (a fájlban kommentben az indoklás).
  Emellett kiderült, hogy a GUI „Add model / Fetch” útja a **beépített pi-ai
  katalógusból** dolgozik, ami elavult: a settings.yaml-ba **373** OpenRouter-
  bejegyzés került, ebből **102 nem létezik** a valódi OpenRouteren
  (claude-3-haiku, gpt-3.5-turbo, `:batch` változatok, kivezetett modellek,
  `openrouter/auto`). **ÚJ ESZKÖZ:** `tools/model-list-prune.mjs` (száraz próba
  → `--apply`, élő `/models` ellen; a bejegyzést a fölötte álló kommenttel
  együtt törli, időbélyeges mentéssel). **MÉRVE utána:** `check-providers.mjs`
  → **8 provider, 0 hibás id** (openrouter **271/271**), `check-model-config.mjs`
  → „Minden route érvényes”. **TANULSÁG:** a GUI-ból felvett modelllistát MINDIG
  futtasd át a prune + check-model-config + check-providers hármason — a
  beépített katalógus nem az élő kínálat.
  **(11) Teljes modell-lista audit — a maradék hibák is javítva (2026-11-19,
  hatodik kérés: „minden hibát javítottál?”).** A zöld checkerek után is volt
  **28 valódi metaadat-hiba**: a bejegyzések több kimenetet/kontextust kértek,
  mint amit az élő OpenRouter enged (pl. `google/gemma-3-27b-it`: 117 964 kért,
  élő plafon **16 384**; `openai/gpt-oss-120b`: 117 964 → 65 536;
  `minimax/minimax-m2.7`: 204 800 → 196 608) — ez a kérésnél **400**-at ad.
  **Javítás:** `tools/model-meta-sync.mjs` (a bejegyzést a MÉRT plafonra
  szorítja, soha nem emeli; `--apply` + időbélyeges mentés) → **28 mező**
  szinkronizálva (`settings.yaml.bak-2026-11-19T13-32-30-metaadat`). **ÚJ
  AUDIT-ESZKÖZ:** `tools/check-model-list.mjs` — providerek, `allowedModels` /
  `agent-default-model` hivatkozások (a `deepseek-official` BEÉPÍTETT route a
  profil-patchből, ezért NEM hiba, hogy nincs a `llm-pi-ai` blokkban),
  duplikátumok, hiányzó kulcsok, és a metaadat az élő katalógus ellen.
  **A NÉGYES ELLENŐRZŐ-SOR (mind zöld, MÉRVE):** `check-model-list.mjs` →
  „NINCS hiba”; `check-model-config.mjs` → „Minden route érvényes”;
  `providers/check-providers.mjs` → 8 provider, **0 hibás id** (openrouter
  **271/271**); `model-list-prune.mjs` (száraz) → **0 törlendő**;
  `model-meta-sync.mjs` (száraz) → **0 szorítandó**. A settings:
  **62 407 B / 1 759 sor**, 10 top-level kulcs változatlan; `openrouter`: 271
  modell + `api: openai-completions` + `baseURL …/api/v1`. **Amit a checkerek
  NEM fednek (tudatosan):** a szolgáltató oldali viselkedés (rate limit,
  tier-korlát) és az árazás — azt csak élő hívás méri.
  **(12) „Ami nem használható, azt töröld” (2026-11-19, hetedik kérés) — ÉLŐ
  HASZNÁLHATÓSÁGI SZKANNEL, nem szemre.** A statikus ellenőrzők (létezik az id,
  van api/baseURL, nem lóg túl a keret) NEM mondják meg, hogy a modell
  tényleg válaszol-e a `chat/completions` végponton. **ÚJ ESZKÖZ:**
  `tools/model-usability-scan.mjs` — 1 próbahívás modellenként (16 max token,
  6 párhuzamos, 20 s-os újrapróbálkozás 429/5xx-re), és CSAK bizonyított hibát
  töröl: batch-only (`:batch`), kivezetett (`Invalid model`, „reached the end of
  its life”), audio-kötelező („requires that either input content or output
  modality contain audio”), régió-tiltott („not available in your region”).
  429/5xx esetén **bizonytalan → NEM töröl** (átmeneti rate limit lehet).
  **MÉRVE (237 modell, 243 → 237):** 234 OK, **6 törölve** —
  `amazon/nova-premier-v1` (EOL), `mistralai/mistral-medium-3` és `-3.1`
  (upstream `Invalid model`), `openai/gpt-audio` + `gpt-audio-mini`
  (audio-kötelező), `sakana/fugu-ultra` (régió-tiltás); mentés:
  `settings.yaml.bak-2026-11-19T13-39-50-nem-hasznalhato`. **3 bizonytalant
  SZÁNDÉKOSAN megtartottam** (`google/gemma-4-31b-it:free`,
  `inclusionai/ling-3.2-flash:free`, `particle-ai/particle-1:free` — 429
  upstream rate limit, a delegálási lánc tagjai!). **A teljes záró ellenőrzés
  MIND zöld:** `check-model-list` „NINCS hiba” (237 modell, 0 metaadat-eltérés),
  `check-model-config` „Minden route érvényes”, `check-providers` **8 provider /
  0 hibás id** (openrouter **237/237**), `model-list-prune` száraz → 0,
  `model-meta-sync` száraz → 0. **Tanulság:** a `:batch` és az audio-modellek
  ÉLŐ id-k, a statikus checkerek átengedik őket — csak a próbahívás buktatja le
  őket; a használhatóság-szkennel ezért a lista rendezésének KÖTELEZŐ utolsó
  lépése.
  **(13) SZABÁLY: fizetős modell NEM kerülhet a delegálási listára (2026-11-19,
  nyolcadik kérés — a felhasználó szó szerint: „semmilyen fizetős modell nem
  kerülhet delegálási listára, ilyet soha nem kértem!!! csak eszkalálásra
  mehetnek fizetős modellek külön utasításra”).** A (7) pontban ÉN vettem fel az
  `openrouter/anthropic/claude-haiku-5.5`-öt ($0,10/M be, $0,50/M ki) a
  `subagent-model-selection.allowedModels`-be — ez SZABÁLYSÉRTÉS volt, ezért
  **TÖRÖLVE** (a lista 9 → 8 tétel; a haiku a modell-listán megmarad, tehát
  beszélgetés-modellként választható). **Beépített őr:** a
  `tools/check-model-list.mjs` mostantól minden `allowedModels` tételre kiszámolja
  a fizetőséget (OpenRouter = élő árazás; `deepseek-official`/`alibaba*` =
  számlázott; proxy route-ok + Groq = ingyenes lánc) és **figyelmeztetésként
  KIÍRJA** — így új fizetős cél nem csúszhat be észrevétlenül. **A listán maradt
  két fizetős tétel a felhasználó KORÁBBI, a fájlban dokumentált döntése**
  (`deepseek-official/deepseek-v4-pro` a tömör brief-eszkalációhoz ~$0,02;
  `alibaba-compat/qwen3.7-flash`) — ezeket nem töröltem, csak a futás jelzi
  őket; szigorítás egy paranccsal: a két bejegyzés törlése az
  `allowedModels`-ból. **MÉRVE:** audit → „NINCS hiba”, 8 tétel, 2 figyelmeztetés.
  **(14) A modellválasztó ELTŰNT a compose-ból — a szolgáltatás rossz elérési
  útja (2026-11-19, kilencedik kérés; felhasználói jelzés: „nem elég a panel
  újratöltés, nincs modellkiválasztó”).** **MÉRT OK:** a (9) pont fészkében
  `ctx.get("modelDirectories")` állt — ilyen accessor NINCS a kliens-Cordison
  (a szolgáltatások property-ként vagy `ctx.inject([...])`-tel érhetők el), ezért
  az `inject` `{available:false}`-t adott, a fészek `null`-t renderelt, és mert
  a priority −100-as bejegyzés ÁRNYÉKOLTA a gyárit, **a modellválasztó teljesen
  eltűnt**. **Javítás:** a gyári minta szerinti `ctx.inject(["slots",
  "modelDirectories"], scope => …)` (a callback csak akkor fut, ha MINDKÉT
  szolgáltatás él — így hiba esetén a gyári fészek marad), PLUSZ a fészek
  **hibatűrő burokba** került (`ModelSeat` → `ModelSeatInner` + külön
  `SeatFallback` komponens, hogy a hook-sorszám ne ütközzön): kivétel esetén a
  jelenlegi modell NEVE látszik, letiltott gombbal, a hiba pedig a host
  naplójába megy (`reportToHost("model seat", …)`) — a compose nem törhet el
  csendben. **MÉRVE:** `plugins/dsh-ui-extras/test/model-seat.test.mjs` **8/8**
  (új eset: „hiba esetén LÁTSZÓ tartalék marad”), a teljes ui-extras készlet
  **29/29** zöld, `node --check` OK. **Érvénybe lépés:** kliens-oldali változás →
  panel-újratöltés; ha a fészek így sem jön vissza, a következő lépés a tálca
  „Kilépés” → ikon (a felhasználó kattintása, §1.5). **TANULSÁG:** slotot
  árnyékolni csak akkor szabad, ha a saját komponens MINDEN ágon renderel
  valamit — a „néma null” egy árnyékolt slotnál azt jelenti, hogy a funkció
  eltűnik.

- `2026-11-18` (első kör) — **a DSH-leállítás utáni indítás: a munkamenetek
  visszaállítása (a „Az ismeretlenbe” hiba), a halott tokennel induló ablak,
  és a költségelszámolás token-sorának eltűnése.** (1) **MÉRT OK a
  munkamenet-vesztésre (felhasználói jelzés, 15:03):** a DSH kliensben
  **nincs** perzisztencia a megnyitott beszélgetésre — az egyetlen
  localStorage-kulcs a `dsh.conversation.*` (nézet, szélesség). A boot a
  `dsh-client-ui-workspace` `watchNavigation()`-ján a `recentWorkspace()`-re
  esik, és ott a `connectWorkspace()` egy ÜRES sessiont nyit/csinál, ezért
  egy teljes oldalbetöltés **mindig** üres beszélgetésre visz. A DshWindow
  viszont minden indításnál újratölti a paneleket → DSH-leállítás + indítás
  után MINDEN panel „Az ismeretlenbe” volt, más-más (a legutóbbi)
  munkaterületen. **Javítás:** a `dsh-ui-extras` kliens új
  „munkamenet-emlékezet” része panelekent (a WebView2-profil saját
  localStorage-a, `dsh-ui-extras.last-session`) elmenti az utolsó VALÓDI
  beszélgetést, és oldalbetöltésenként EGYSZER visszaállítja
  (`uiWorkspace.openSession`, tartalék: `sessions.open`); az üres sessiont
  SOHA nem menti, archiváltat nem nyit, a próbák kötöttek (4 időzített próba,
  max. 3 megnyitás, §1.7), és a lista későbbi betöltésére is reagál. Tesztek:
  `plugins\dsh-ui-extras\test\session-memory.test.mjs` **8/8**. (2) **MÉRT
  második hiba (idővonal a naplókból):** a tálca a harness indítása után **a
  régi, halott tokent** adta át az ablaknak (15:03:51, `--url …qNw…`), majd a
  friss token 15:03:59-kor érkezett, és a panelek 15:04:00-kor RELOADOLTAK rá
  — vagyis két teljes oldalbetöltés, az első kör munkamenet-választása
  elveszett, a félbeszakadt kérések pedig a költség-panel token-sorát is
  elbuktaták. **Javítás (`src\DshTray.cs`):** a harness indításakor
  `_awaitToken = true` (a `CurrentUrl()` addig üres, tehát nem esik vissza a
  régi `harness.url`/`harness.log` tokenre), a `CaptureTokenUrl()` pedig a
  friss token megérkezésekor kapcsolja vissza; az indítási szál/felügyelet
  addig vár (max. 60 s), és csak utána nyit ablakot. **Biztonsági korlát
  (§1.7):** ha a friss token 45 s alatt nem érkezik meg (pl. a harness kimenete
  nem olvasható), a tálca visszaesik a mentett URL-re, tehát az ablaknyitás
  nem blokkolódik örökre — a napló kimondja
  (`token-varakozas: 45 s alatt nem erkezett friss token`). **Érvénybe lépés:**
  `bin\DshTray.exe.new` (61 440 B, exit 0), a csere a következő
  tálca-indításnál (`PendingUpdate.Apply`). (3) **A token-költség sor
  eltűnése:** a panel a `material.status !== "ready"` esetén eddig MINDIG „A
  token költség ehhez nem érhető el.”-t írt — betöltő állapot nem volt, a
  hideg `/ui-extras/usage` szkennelés pedig MÉRVE **~58 s** (1 303 napló).
  Most van `loading` állapot („mérés folyamatban… akár ~1 perc”), a várakozás
  alatt is az látszik, és 3 kötött próba (5 s / 15 s) után lesz csak „nem
  érhető el”. **MÉRT host-hiba ugyanitt:** a `usageSnapshot` egyetlen
  cache-slotot és KÖZÖS `running` ígéretet használt, ezért egy MÁS kulcsra
  futó szkennelés kiszolgálta a munkaterület-szűrt kérést — MÉRVE a futó
  hoston: `days=28&workspace=D:\Szerver\Antikolt` és a globális kérés is
  `requests=77082`, a szűrt válaszban `workspace: null` (a globális 5 959
  bájtos válasz a szűrt 2 974 helyett). **Javítás:** kulcsonkénti cache és
  kulcsonkénti futó szkennelés, lemezes pillanatkép
  (`state\usage-snapshot.json`, 10 perc, max. 4 kulcs) azonnali értékkel és
  háttér-frissítéssel; a teszt `DSH_USAGE_STATE_DIR`-rel ideiglenes
  könyvtárba ír (nincs state-szennyezés). Tesztek: ui-extras usage **6/6**,
  session-memory **8/8**, hero/git/run-log **7/7**, koltseg **13+37+12**.
  **Érvénybe lépés:** a kliens-oldali rész (loading szöveg)
  **panel-újratöltéssel**, a host-oldali (kulcs-izoláció, lemezes
  pillanatkép) a **következő harness-indításnál** (§1.5 — a futó session
  miatt nem indítjuk újra). **FIGYELEM az első újraindításra:** az emlékezet
  az ELSŐ olyan oldalbetöltésnél íródik ki, amikor a panel már valódi
  beszélgetést mutat — ezért érdemes a paneleket egyszer újratölteni, vagy az
  első restart után a munkamenetet kézzel megnyitni, különben az első restart
  még üres beszélgetésre eshet.

- `2026-11-17` (huszonkettedik kör) — **költségelszámolás: sötét legördülő,
  visszamenőleges gépelés-becslés a beírt szövegből, és a token-sor
  munkaterület-szűrése + cache-kedvezmény kimondva.** (1) **Sötét legördülő:**
  a natív `<select>` a `transparent` hátteret nem örökli, ezért a profil-választó
  fehér listát rajzolt a sötét panelen (mért, képernyőképen). Javítás: konkrét
  háttér + `colorScheme: "dark"` a panelen ÉS a selecten, valamint explicit
  háttér/szín az `<option>`-ökön. (2) **Gépelés visszamenőleg:** a kliens-mérés
  csak a most futó felületre él, ezért a korábbi időszakokra 0 gépelés jött ki
  (MÉRT: 4,8 perc 2492 perc olvasás mellett). A napló viszont tartalmazza a
  **felhasználó által beírt** prompt hosszát (`user/message` → `content[].text`,
  csak `source.kind === "user"`; a befecskendezett AGENTS-emlékeztető 61 ezer
  karakter, azt KI KELL zárni), ebből a gépelés becsülhető:
  `hossz / 150 leütés-perc` (profil-mező: `typingCharsPerMinute`, 30–600),
  12 karakter alatt nincs becslés, plafon a szünet és a tétlenség-plafon, és a
  kliens-mért értéknél nem kisebb (`max(mért, becsült)`). **MÉRVE** a valódi
  naplókon: 30 nap, 36 munkafolyamat, 416 kör → gépelés **3,75 h** (ebből
  **3,25 h** becsült) a korábbi 4,8 perc helyett; a panel „becsült (a beírt
  szövegből)” jelölést tesz a sorra. (3) **Token-sor: a 98% cache-kedvezmény
  valóban érvényesült** (`requestCost` a találati árat használja: a
  DeepSeek-flash találat a miss-ár 2%-a), a panasz oka a **hatókör** volt: a
  panel a `/ui-extras/usage` válaszának GLOBÁLIS 30 napos összegét mutatta a
  kiválasztott munkaterület helyett (MÉRT: 2 session / $0.62 helyett $133.76).
  Mostantól a végpont `workspace=` paramétert fogad (a session-napló fejlécének
  `cwd` mezője alapján szűr, a cache-kulcsban is benne van), a panel ezt küldi,
  és a sor alatt **ki van mondva** a cache-találat mennyisége, a kedvezmény
  százaléka és a megtakarítás (`cacheReadCost` a hoston). **MÉRVE:** ez a
  munkaterület $19.94 (globális $134.05), cache-kedvezmény **98%**, megtakarítás
  $451.66. Tesztek: **112/112** (koltseg engine 36, kliens 12, host 12,
  ui-extras 7+3, ftp 9), a kétnyelvű ellenőrző **23/23** (`exit 0`).
  **Érvénybe lépés:** a kliens-oldali rész (sötét legördülő, cache-sor
  formázása, „becsült” jelölés) **panel-újratöltéssel** él (a kiszolgált bundle
  a fájlt élőben olvassa, ellenőrizve); a **host-oldali** számok (gépelés-becslés,
  szűrt token-sor) a **következő harness-indításnál** (§1.5 — a futó session
  miatt nem indítjuk újra).
  **(4) Utólagos pontosítás ugyanezen a napon (a felhasználó másodszor is
  jelezte: „a gépelésnél még mindig keveset számol, és nem látom, hogy a korábbi
  promptokat beszámolná úgy, ahogy az olvasást”):** a mérés MÉRVE az Antikolt
  sessionön (20 kör) **0,3 perc** gépelést adott, holott a naplóban ott van egy
  **2340 karakteres első prompt** (= 15,6 perc). Két ok: (a) a session ELSŐ
  promptja a napló kezdete ELŐTT íródott, ezért nem volt hozzá szünet — mostantól
  40 karakter fölött a plafonig becsüljük (`firstPromptMs`); (b) a 12 karakteres
  küszöb a „folytasd” (8 karakter) promptokat kihagyta — a küszöb **4**.
  Emellett a körönkénti tábla **átrendezve**: az olvasás a *válasz* körénél, a
  gépelés a *beírt prompt* körénél jelenik meg (eddig mindkettő a válasznál volt,
  ezért tűnt úgy, hogy a promptok nincsenek benne). **MÉRVE** ugyanarra a
  munkaterületre: gépelés **39,9 perc** (ebből 39,6 becsült, 24 perc az első
  promptokból) a korábbi 14,9 helyett; az érintett session **0,3 → 16,2 perc**
  (15,0 perc az első promptból). A token-sor tizedesjele **vessző** (`$1,0407`,
  a `toFixed` pontot adott — magyar felületen hibás). Tesztek: **114/114**
  (engine 37, kliens 13, host 12, ui-extras 7+3, ftp 9).

- `2026-11-17` (huszonegyedik kör) — **az ágens-indította újraindítás INCIDENSE,
  és a WebView2-profil védelme.** (1) **MÉRT INCIDENS (13:45:59):** az ágens a
  DSH sandboxából indította a launchert; az így indult tálca/ablak megörökölte a
  sandbox PRIVÁT `TEMP`-jét (`C:\Users\info\AppData\Local\Temp\dsh-ECvtxu\...`),
  és mivel az előző ablak WebView2 folyamatai még fogták a stabil profilokat,
  a panel a MÁSODIK próbánál a `%TEMP%` alatti ÜRES tartalék-profilra váltott →
  a munkamenet-állapot (workspace, kiválasztott beszélgetés) elveszett, több
  pane-nél pedig a vezérlő E_UNEXPECTED (0x8000FFFF) hibával elszállt → FEHÉR
  panelek. Ez NEM a tálca-javítás hibája: a napló szerint a 13:45:59-es indítás
  helyesen futott (`kifejezett indítás (--show)`, `friss indítás: az 1.
  munkaasztal lesz a látható`, `indítási ablak megnyitva (0 ms)`), és a
  13:46:22-es Kilépés leállította a munkaablakot, a harness-t (3080), a proxyt
  (4123) és a robot-szervert (4180). A felhasználó saját indítása (13:46:25,
  Explorerből) már hibátlan lett: mind a 6 panel `controller ready`, stabil
  profilokkal, a munkamenetek visszaálltak. **ÜZEMELTETÉSI SZABÁLY:** az
  alkalmazást SOHA nem indítja ágens-parancs (a sandbox TEMP/ACL-je
  kontaminálja a WebView2-t); a megbízható újraindítás a tálca „Kilépés" →
  ikon (a felhasználó kattintása). (2) **Javítás (DshWindow):**
  `StableProfileAttempts = 3` — az első három próba UGYANAZT a stabil profilt
  használja (~5 s, növekvő várakozással), és csak utána vált a `%TEMP%` alatti
  tartalékra; a `-d<asztal>` utótag mostantól MINDEN stabil próbára jár (eddig
  csak az elsőre). Így egy gyors újraindítás nem veszíti el a panel
  munkamenet-állapotát. (3) **Javítás (DshTray):** a második asztal ablaka
  4 s helyett **8 s** múlva indul (ne concurrent WebView2-környezetek);
  `StopDesktopWindows` a pid-fájlok után **sweepet** is futtat: a bezárt, de
  futva maradt DshWindow (a Closing törölte a pid-fájlját, a folyamat élt)
  is leáll, folyamatnév + saját exe-útvonal ellenőrzéssel (§1.6).
  (4) **Élesítve:** `bin\DshWindow.exe` (104 448 B) és `bin\DshTray.exe`
  (61 440 B) — a futó példányok a régi képet használják, a következő indítás
  (Kilépés → ikon) már az új kódot futtatja. A kliens-oldali hero gombsor
  javítása a futó ablakban ELLENŐRIZVE (képernyőkép: HU…⚙ + 🤖 + érme + PHP +
  1 + 2 + FTP egy sorban; a láblécben a szándékos `-$0.00`).

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
