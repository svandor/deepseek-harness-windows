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
