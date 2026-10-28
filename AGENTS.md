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

- Helyi modell `contextWindow` értéke **max. 32768** (kivétel: indokolt, mért
  eset, kommentben dokumentálva).
- Teljesítménymérés (retune / chain-doctor) **ne** töltsön be helyi modellt
  teljes kontextussal; a helyi sávot vagy hagyd ki a mérésből, vagy korlátozott
  kontextussal mérd.
- Betöltés után ellenőrizd: `ollama ps` és a `llama-server.exe` memóriája.
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
