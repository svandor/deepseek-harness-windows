# DSH-átadás — folyamat-ledger, reconciláció, memória

> English mirror: [`DSH-ATADAS.en.md`](DSH-ATADAS.en.md)

Átvétel a **Vector** repótól (`D:\Szerver\Vector\DSH-atadas.md`, készült
2026-11-13). Ez a fájl a DSH repó oldali példány: az átadott gyökérokokat
**ellenőriztem a futó kódban**, és rögzítem, hol lehet ténylegesen javítani.

---

## 1. Mit kér az átadás

1. **Perzisztens folyamat-ledger**: minden indított folyamat rekordja
   (`pid`, indítási idő, `cmdline`, `cwd`, `sessionId`, `jobId`, `kind`),
   append-only, workspaconként egy fájl.
2. **Induláskori reconciláció**: halott PID-ek eldobása, élők „recovered"
   jobként való visszaregisztrálása; `job_kill` = PID **+ indítási idő**
   ellenőrzése után `taskkill /T`.
3. **Workspace-kulcs kanonizálása** `realpath`-szal + migráció.
4. **Memória**: session-header olvasás csak az első zstd frame, korlátozott
   pufferrel; az allokációs hiba külön ág (ne „corrupt log");
   `eventsSnapshot` ne másolja a teljes logot; `terminals` felső korlát.
5. **Diagnosztika**: induláskori összefoglaló (rekordok, recovered jobok,
   header-scan csúcs, eltelt idő).

---

## 2. A gyökérokok ellenőrzése (2026-11-13, futó csomagokban)

Minden állítás a **kiadott** csomagok kódjában ellenőrizve:
`%LOCALAPPDATA%\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai\`.

| # | Állítás | Állapot | Bizonyíték |
|---|---|---|---|
| 1 | `dsh-jobs-local` job-nyilvántartás csak memóriában | **IGAZ** | `lib/index.js:105` `store = /* @__PURE__ */ new Map();`; `start()` 131–177, perzisztálás nincs |
| 2 | `cancelForTeardown()` csak warnol | **IGAZ** | 435–452; a `may be orphaned` szöveg 444–445, OS-szintű keresés/kill nincs |
| 3 | `dsh-subprocess-local` PTY-handle-ök memóriában | **IGAZ** | `terminals` Set (a csomag 1084 soros, a `lib/index.js` fejlécében a `SubprocessRuntime`/`LocalTerminalHandle`) |
| 4 | PID + `rootIdentity` megvan, de nem perzisztált | **IGAZ** | `lib/index.js:654` `this.rootIdentity = inspector.snapshot().tree(this.pid)...`; a `started` (Win32 `GetProcessTimes` FILETIME) a `runner-launch-COYGu0Dl.js` 263–277. soraiban keletkezik |
| 5 | `spawn()` / `spawnTerminal()` a ledger írás helye | **IGAZ** | `spawn` 990, `spawnTerminal` 1028 |
| 6 | A session-tároló helye a nyers `cwd`-től függ | **IGAZ** | `sessionDir` 913–914 `join(projectDir(root, cwd), ...)`; `projectDir` 901–904 → `projectKey(cwd)` 874–892: pusztán szintaktikus, **`realpath` nélkül**, nagybetű-érzékeny |
| 7 | `eventsSnapshot` a teljes log másolata | **IGAZ** | `dsh-session/lib/index.js:1109` `this.eventsSnapshot ??= Object.freeze([...this.log]);` (a 1201 törli) |
| 8 | `jobsBySession` memóriabeli Map | **IGAZ** | megerősítve: a registry a 8-as ponton kívül is tisztán memóriabeli |

**Következtetés: az átadás gyökérok-elemzése megállja a helyét, a sorszámok
pontosak.** A 6. pont következménye a mérésnél is élesebb: mivel a `C:` egy
junction a `D:`-re, a `C:\Szerver\…` és a `D:\Szerver\…` cwd **két különböző**
project-kulcsot ad ugyanarra a könyvtárra — ezért nem kapcsolódik vissza a
munkamenet áthelyezés után.

---

## 3. Korrekciók az átadáshoz képest

### 3.1 A repó és a futó kód nem ugyanaz a forrás

Az átadás azt kéri: „a javítást a repóban kell megcsinálni és onnan telepíteni".
Ez **szó szerint nem lehetséges**, mert:

- `C:\Szerver` → junction → `D:\Szerver` (ugyanaz a fa, nem két telepítés);
- ez a repó (`svandor/deepseek-harness-windows`) **burkoló**: tálca, natív
  ablak, indító, installer, pluginok, eszközök. **Nincs benne** a harness magja:
  nincs `packages/`, nincs `src/` a `@deepseek-ai/*` csomagokból;
- a harness mag a fenti npx cache-ből jön, ami **kiadott tarball** (csak
  `lib/index.js` + `.d.ts`, TypeScript forrás nem jár hozzá).

A `~/AppData/Local/npm-cache/_npx/<hash>/` ráadásul **npx-hoz kötött**:
frissítéskor új hash-könyvtár lesz, a régi javítás elvész.

### 3.2 Ezért a javítás helye (javaslat)

| Réteg | Mechanizmus | Miért |
|---|---|---|
| A–C, E (folyamat-életciklus) | **új plugin a repóban**: `plugins\dsh-process-guard`, junction a `~\.dsh\profiles\node_modules`-ba + `- insert:` a `cordis.patch.yml`-be | ez a repó **már használt, támogatott** telepítési útja (`dsh-hazi-robot`, `dsh-ui-extras`); a javítás a repóban él, npm-frissítés nem viszi el |
| D (memória-mag) | vagy ugyanígy plugin-oldali befogás, vagy `tools\`-ba tett, **verzióhoz kötött, újraalkalmazható** text-patch a kiadott csomagokra | a header-scan és az `eventsSnapshot` a magban van; plugin csak akkor tudja, ha a szolgáltatást be tudja fogni |
| végleges | **upstream PR** a `github.com/deepseek-ai/deepseek-harness` repóba | csak ott nem veszik el a következő kiadásnál |

A plugin-oldali befogás műszakilag megalapozott: a szolgáltatásnevek
`jobs` (`dsh-jobs/lib/index.js:61`), `subprocess` (`dsh-subprocess:88`),
`terminals` (`dsh-terminal:58`), `sessions` (`dsh-session:1315`); egy plugin
`inject` listával hozzájut, és a `job_kill` tool a `ctx.jobs.kill(...)`-t hívja
(`dsh-tool-jobs:342`). Az `owner: undefined` jobot a `list()` mindenkinek
mutatja (`dsh-jobs-local:180`), tehát a recovered job felületi listázása nem
igényel új toolt.

---

## 4. Terv (A–E → konkrét lépések)

- **A. Ledger**: `~\.dsh\process-ledger\<sha256(realpath(workspace))>.jsonl`;
  rekord `{pid, started, cmdline, cwd, workspaceRealpath, sessionId, jobId,
  kind}`; kilépéskor tombstone-sor. A `started` a meglévő Win32
  `GetProcessTimes` identitás, nem fal-óra.
- **B. Reconciláció**: induláskor ledger-beolvasás; halott vagy **más**
  `started` → eldobás; élő → `recovered` job a `ctx.jobs` store-ba
  (`owner: undefined`); `cancel()` = PID + `started` egyezés után
  `taskkill /T /F`, POSIX-on process group.
- **C. Workspace-kulcs**: `realpath` mindenhol (job-owner, terminal,
  session-tároló) + egyszeri migráció a régi project-könyvtárakra.
- **D. Memória**: header-olvasás csak az első zstd frame, korlátozott
  pufferrel; `ZSTD_error_memory_allocation` külön ág, kisebb pufferrel való
  újrapróbálás; `eventsSnapshot` nézet/lapozás; `this.log` felső korlát;
  `terminals` felső korlát.
- **E. Diagnosztika**: egy induláskori összefoglaló sor a logba.

---

## 5. Elfogadási kritériumok

1. `npm run dev` a DSH-ból → a DSH-t `kill -9` éri → újraindítás után a job
   **megjelenik** (recovered) és `job_kill`-lel leállítható.
2. Azonosítás PID **+ indítási idő** alapján; PID-újrahasznosításnál **nem**
   öl meg idegen folyamatot.
3. Induláskori memóriacsúcs < 1 GB (jelenleg 6,7 GB), 1178 session-artefaktummal.
4. Áthelyezett telepítés után a munkamenetek a helyes workspace alatt.
5. Szabályos leállásnál nincs „work may be orphaned" naplósor.

**Mérési megjegyzés:** az 1. kritérium csak a futó harness megölésével mérhető,
ezért külön, tudatos lépés (a munkamenet megszakad vele).

### 5.1 Állapot kritériumonként (2026-11-13)

| # | Kritérium | Állapot | Bizonyíték / mi hiányzik |
|---|---|---|---|
| 1 | elárvult job megjelenik és leállítható | **NEM IGAZOLT** | a mechanizmus kész (ledger + reconciláció + `job_kill`), de a végpontig tartó próba `restart-failed` lett: a durva leállítás után a boot elhalt a hibás session-összevonásomon (6.5). Tiszta állapotban újra kell futtatni. |
| 2 | PID + indítási idő; PID-újrahasznosításnál nem öl | **IGAZOLT (egység- és élő szinten)** | 6 egységteszt a párosításra (egy jelölt / kétértelmű / időben távoli / rövid token / nincs találat / saját folyamat kizárása); a `cancel()` tesztje igazolja, hogy a saját folyamatot nem öli meg. Élő mérés: 2/13 találat, 2 különböző PID. |
| 3 | induláskori csúcs < 1 GB | **NEM MÉRT** | a futó állapot 811 MB; a boot-csúcsot még nem mintavételeztük (`tools\sample-startup-memory.ps1` kész). A kiinduló 6,7 GB a statikus elemzés szerint **nem reprodukálható** (6.7). |
| 4 | áthelyezés után helyes workspace | **TERVEZÉSI HIBA — NEM MOZGATHATÓ** | a tároló kulcsa a fejléc `cwd` literális szövege, ezt a mag ellenőrzi (`assertStoredIdentity`, `:3246–3257`). Áthelyezéssel nem javítható, csak ha a fejléc `cwd` is átíródik VAGY a mag kanonizál tároláskor → upstream 3. pont. |
| 5 | szabályos leállásnál nincs „may be orphaned" | **NEM CÉLZOTT** | a sor a mag teardown-ágából jön (`dsh-jobs-local:444–445`), amikor egy `cancel()` dob. A plugin ezt nem érinti; csak upstream javítással szűnik meg. |

Ez a táblázat a dokumentum legfontosabb állítása: **a leadott munka egyik
kritériuma sincs teljes egészében bizonyítva**, és ezt nem szépíti a
részeredmények felsorolása.


---

## 6. Státusz

- [x] Az átadás átvétele, gyökérokok ellenőrzése a futó kódban
- [x] A javítás helyének tisztázása (3. pont)
- [x] `plugins\dsh-process-guard` (A, B, C, E) — telepítve: junction +
      `cordis.patch.yml` bejegyzés, 21/21 teszt (hamis `ctx`-szel, boot-biztonság
      és PID-újrahasznosítás ellenőrzése)
- [x] Memória (D) — patch alkalmazva, **de a mérési indoklásomat javítani
      kellett** (lásd 6.5). A `readFirstZstdLine` valódi költsége a teljes
      korpuszon **9,2 MB másolás** (0,02×), fájlonként **1 olvasás** — tehát
      NEM ez a 6,7 GB-os induláskori csúcs oka. A patch ettől függetlenül
      hasznos: az allokációs hibát külön ágon viszi (`not a corrupt log`),
      a `>64 MiB` fájlokra az eredeti utat hagyja, a scan bemenete bájtazonos,
      idempotens, `--revert`-tel visszavonható.
- [x] `terminals` felső korlát — **nincs teendő**: a Set önmagát tisztítja
      (`dsh-subprocess-local:957`, `:1070` `terminals.delete`), tehát csak élő
      terminalokat tart.
- [ ] `eventsSnapshot` (dsh-session:1109) — ez **referenciatömb** másolata, nem
      eseményeké; a költsége az eseményszám × 8 bájt. Előbb mérni kell, hogy
      egyáltalán számít-e.
- [ ] `this.log` felső korlát — checkpoint + levágás kellene (a `seq = log.length`
      kontinuitási szerződés miatt), ez már mag-szintű tervezés, nem patch.
- [ ] Elfogadási mérések (az 1. kritérium a harness megölésével jár)

### 6.1 Mérési korrekció a 6. gyökérokhoz

A `realpath`-hiány a tárhely-kulcsban **részben** igaz: a `dsh-workspace`
(`lib/types/paths.js`, `realpathNormalize()`) kanonizálja a `cwd`-t a workspace
létrehozásakor (`entity.js:70`). A gyakorlat mégis azt mutatja, hogy **ugyanarra
a könyvtárra két külön tároló keletkezett**:

```
~/.dsh/sessions/--C-Szerver-Deepseek~0020Harness--/   (több száz artefaktum)
~/.dsh/sessions/--D-Szerver-Deepseek~0020Harness--/   (több száz artefaktum)
```

Összesen 1182 artefaktum, ~599 MB. A `projectKey()` maga nem hív `realpath`-ot,
ezért minden olyan út, amely a kanonizálást megkerülve jut el a tárolóhoz (vagy
a kanonizálás a junction miatt mást ad), új project-könyvtárat nyit. A
migráció ezért nem elvi: a két könyvtárat össze kell vonni a kanonikus kulcs
alá.

### 6.2 A plugin méréssel talált hibái (2026-11-13)

A plugin élesítése után a `~/.dsh/process-ledger/_diag.jsonl` és a
`plugins\dsh-process-guard\test\live-match.mjs` mutatta ki ezeket — mind a
négy a saját hibám volt, és mind a négyet teszt őrzi:

1. **A `spawn()` handle-je nem ad PID-et.** Mért felület: `stdin, stdout,
   stderr, collected, done, terminate, terminateForHostExit, waitForExit`.
   Megoldás: `untracked` rekord íráskor, párosítás induláskor.
2. **A `spawnTerminal` aszinkron** — az első változat a `Promise`-t adta tovább
   a rekordkészítésnek, ezért a terminálok (amelyek pedig kiadják a pid-et)
   kimaradtak a ledgerből.
3. **A PowerShell 5.1 `/Date(…)/` alakban adja a dátumot**, amit a
   `Date.parse` nem értelmez → minden `startedMs` `null` lett, ezért a
   párosítás soha nem talált. Most Unix-ms-et kérünk.
4. **A 20 s-os időablak összecsúsztatta a rekordokat** (három különböző rekord
   ugyanarra a PID-re). Szigorítás: ±3 s, szülő-PID elsődleges jel, és csak a
   **korábbi** futás rekordja lehet elárvult (`PLUGIN_BOOT_MS`).

Ellenőrzés: **29/29 egységteszt**, valamint élő mérés a futó harness ellen
(`live-match.mjs`: 2/13 találat, **2 különböző PID** — a már kilépett
folyamatok rekordjai helyesen kimaradnak).

### 6.3 Ami még nyitva van

- Ledger-tömörítés (a `rg.exe` / sandbox-runner rekordok nőnek, igaz csak
  ~200 B/hívás; 7 nap után a beolvasás már eldobja őket).
- Session-tár összevonása: a könyvtárnevek **lossy** kódolásúak, ezért a
  párosítást a fejlécek `cwd` mezőjéből kell számolni
  (`--C-Szerver-Vector--`, `--D-Server-Vector--` és `--D-Szerver-Vector--`
  ugyanarra a könyvtárra utalhatnak).
- `eventsSnapshot`, `this.log`, `terminals` felső korlát.
- kill -9-es elfogadási próba (ehhez a harness leállítása kell).

### 6.4 Session-tár összevonás — VISSZAVONVA (2026-11-13)

`tools\merge-session-store.mjs` — a párosítás alapja **nem a könyvtárnév**
(lossy kódolás), hanem minden munkamenet fejlécének `cwd` mezője, és a
kanonikus kulcs `projectKey(realpath(cwd))` (a mag `projectKey()` pontos
másolata).

Mért eredmény (száraz próba → alkalmazás):

| | |
|---|---|
| munkamenet-könyvtár | 1184 (minden fejléc olvasható) |
| áthelyezett | **1106** |
| ütközés | **0** |
| aktív (kihagyva) | 0 (a C:-kulcsú könyvtárakban nem futott munkamenet) |
| fájlszám / bájt **előtte → utána** | 1184 / 574,7 MB → **1184 / 574,7 MB** |

A hét üres `--C-…--` project-könyvtár törölve; 10 project-könyvtár maradt, mind
a kanonikus (`--D-…--`) kulcs alatt. Visszaállítás: a
`D:\Szerver\DSH-backup\2026-11-13-0616\sessions` másolatból.

**Megjegyzés:** a futó harness a munkamenet-listát memóriából is mutatja, ezért
a felületen a régi (C:-kulcsú) bejegyzések a következő indulásig láthatók
maradhatnak — a lemezen a helyük már jó.

### 6.5 ÜZEMZAVAR — a session-összevonásom tönkretette a bootot (2026-11-13)

**Ez a legfontosabb tanulság ebben a dokumentumban: a 6.4. szakasz migrációja
HIBÁS VOLT, és leállította a DSH-t.**

Mi történt:

1. A 6.4. összevonás a kulcsot `projectKey(realpath(cwd))`-ből számolta, és
   1106 munkamenetet áthelyezett `--C-…--` → `--D-…--` könyvtárakba.
2. A harness ezután **nem indult el**. A mag ugyanis a tároló helyét a fejlécben
   tárolt `cwd` **LITERÁLIS** szövegéből számolja, és ellenőrzi is:

   ```
   dsh-session-persistence-jsonl/lib/index.js:3251
     expectedPath = generationLogPath(this.root, meta.cwd, …)
   :3255
     if (path !== expectedPath && !sameFile(…))
       throw "corrupt session log …: header id and cwd identify …"
   ```

   A `C:\…` fejlécű napló a `--D-…--` mappában tehát „corrupt"-tá vált, a boot
   pedig elhalt a session-header listázásnál.
3. **Kár:** a DSH 08:47 és ~09:08 között nem indult (a 08:47-es durva leállítást
   a saját elfogadási próbám végezte, az újraindulás pedig az összevont tárolón
   hasalt el — a próba ítélete ezért `restart-failed` lett). A felhasználó egy
   Cursor-ágenssel állíttatta helyre, amely **1093 naplót visszatett** a fejléc
   szerinti mappába.
4. **Adat NEM veszett el:** 1184 fájl, a fájlszám és a méret végig változatlan.

Helyreállítás és a jelenlegi állapot:

- `--check` (javított, literális kulccsal): **0 áthelyezendő / 1184 a helyén**.
- A `merge-session-store.mjs` `--apply`-ja **elutasít** (3-as kilépés), mert a
  realpath-alapú mozgatás érvénytelen; az eszköz csak riportál.

**Amit elrontottam módszertanilag:** a `projectKey`/`readGenerationHeader`
kódját elolvastam, de az `assertStoredIdentity` ellenőrzést **nem** — pedig az
dönti el, hogy egy áthelyezés jogszerű-e. Mozgatás előtt ezt kellett volna
ellenőriznem (egy egyedi naplón, előbb másolaton). A „fix forward" a helyes út:
a régi, `C:\` fejlécű munkamenetek maradnak, az újakat a mag már kanonikus
cwd-vel hozza létre.

### 6.6 SAJÁT HIBA — a memória-mérésem félrevezető volt (2026-11-13)

A `tools\measure-header-read.mjs` első változata egy olyan ciklust mért,
amely **végigolvassa a fájlt**, majd csak utána keres frame-et. A valódi
`readFirstZstdLine` viszont minden chunk után scannel, ezért az első (fejléc)
frame megtalálásakor **azonnal kilép**.

Újramérés a valódi logikával (a mag `scanZstdFrames()` hűséges másolatával),
mind az 1184 session-logon:

| | |
|---|---|
| első frame eléréséhez másolt adat | **9,2 MB** (a 574,8 MB korpusz **0,02×**-a) |
| olvasások száma fájlonként | **1** (mind a 1184 fájlnál) |
| első frame > 64 KiB | **0 fájl** |
| nem talált/sérült | **0** |

Tehát a korábbi „17 594,7 MB → 28,5 MB (617×)" és „104 319,7 MB (182×)" szám
**nem a valódi kódra vonatkozott** — visszavonom. A header-olvasás nem
magyarázza a 6,7 GB-os induláskori csúcsot.

**A patch sorsa:** nem árt (bájtazonos scan-bemenet, idempotens, visszavonható),
és a hibakezelést javítja (allokációs hiba ≠ „corrupt log"), de **nem ez a
memória-javítás**. Ha valaki a 6,7 GB-ot akarja megfogni, másfelé kell nézni.

**Következő hipotézis (mérés előtt nincs patch):** az induláskori csúcs a
**teljes logok ki-/visszafejtéséből** jöhet, nem a fejléc-olvasásból — a korpusz
574,8 MB tömörítve, és ha a projekció-gyorsítótár vagy a lista több
munkamenetet **párhuzamosan** tölt be teljes generációval, a többszörös
expanzió nagyságrendileg kiadhat több GB-ot. Ezt a
`~/.dsh/storages/session_projcache` és a `list()` teljes-generáció olvasási
útjának mérésével kell eldönteni — patch csak utána.

### 6.7 A boot-útvonal statikus elemzése — a 6,7 GB nincs megmagyarázva

A kód elolvasása után a boot a vártnál **olcsóbb**, nem drágább:

| Hely | Mit tesz | Költség |
|---|---|---|
| `list()` (`:2454–2481`) | kizárólag `artifact.header`-ből épít snapshotot | fejléc-olvasás (mért: 1 olvasás/fájl) |
| `readFirstZstdLine` (`:3125`) | az első frame-nél megáll | **9,2 MB** a teljes korpuszra |
| `requireStoredLog()` (`:2483`) | **teljes** logot olvas | csak munkamenet-megnyitáskor, nem bootkor |
| `session_projcache` | lemezen 30,3 MB, `hydratePrepared()` munkamenetenként | lusta, nem bootkori teljes betöltés |
| `MAX_CONCURRENT_VERIFIERS` (`:1400`) | = 2 | csak migráció-ellenőrzésre |

**Következtetés:** a beolvasott kóddal a 6,7 GB-os induláskori csúcs **nem
reprodukálható**. Ezért nem írok rá patch-et. Három lehetséges magyarázat
maradt, és mindegyik méréskérdés:

1. a mért 6,7 GB egy **crash-loop** terméke (ismételt, félbeszakadt bootok
   egymásra rakódó pufferei), nem egyetlen indulásé;
2. a gép **egyéb terhelése** (a jelentés ugyanazon a napon 20 GB-os
   `llama-server`-t és 10,9 GB-os játékot is mért — a commit-plafon közös);
3. más kódváltozat, mint ami ma fut.

Eldönteni csak a futó folyamat mintavételezésével lehet:
`tools\sample-startup-memory.ps1` (5.1 alatt ellenőrizve, működik).

## 7. Upstream javaslat (PR-vázlat a deepseek-ai/deepseek-harness repóba)

A repó itteni javításai **kerülőutak**: a plugin és a patch a helyi telepítést
menti, de a következő kiadás elviheti. A tartós javítás helye a mag.
Sorrendben, a mért hatás szerint:

1. **`SubprocessHandle` adjon ki `pid`-et (és indítási időt).** Ma a felület:
   `stdin, stdout, stderr, collected, done, terminate, terminateForHostExit,
   waitForExit` — PID nélkül. Emiatt kellett a pluginban a `untracked` rekord +
   induláskori WMI-párosítás kerülőút. Ez az egyetlen *valódi* API-hiány.
2. **Perzisztens folyamat-ledger a magban.** A `store = new Map()`
   (`dsh-jobs-local:105`) és a „may be orphaned" (`:444–445`) miatt ma minden
   összeomlás után elárvult folyamat marad. A ledger + reconciláció a magban
   természetes helyen van (a plugin ezt igazoltan meg tudja csinálni kívülről).
3. **A session-tároló kulcsa legyen kanonikus ÉS önkonzisztens.** A
   `projectKey()` a fejléc `cwd` literális szövegét kódolja (`:874`), az
   `assertStoredIdentity()` ezt ellenőrzi (`:3246–3257`). A junction/áthelyezés
   miatt ugyanarra a könyvtárra két tároló keletkezik (mért: 1093 napló `C:`
   fejléccel). Javaslat: a `cwd` **tároláskor** kanonizálódjon (`realpath`), és
   a betöltés fogadja el a kanonikus ekvivalenst — így a migráció is
   biztonságossá válik. *Ez az a pont, ahol a 2026-11-13-i üzemzavart okoztam:
   a kanonizálást olvasáskor akartam kikényszeríteni, mozgatással.*
4. **`readFirstZstdLine`: az allokációs hiba legyen külön ág** (ma „corrupt
   log"-ként álcázódik, `:3150`) — ez a patch, ami már kész van.
5. **`this.log` felső korlát** checkpoint + levágás formájában (a `seq =
   log.length` szerződés miatt ez tervezést igényel), és az `eventsSnapshot`
   lapozása nagy munkameneteknél.





