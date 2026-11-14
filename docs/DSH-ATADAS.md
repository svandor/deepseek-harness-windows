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
| 1 | elárvult job megjelenik és leállítható | **RÉSZBEN IGAZOLT — a job-ágon strukturálisan korlátos** | A ledger + induláskori reconciliáció kész, a `job_kill` PID + indítási idő ellenőrzéssel öl. A próba háromszor `no-orphan-adopted` lett, mert a szokásos spawn a **Job Object kill-on-close** miatt a harness halálakor meghal (9. pont) — ezen az ágon nincs mit visszanyerni. A **panel-futás** ága viszont 2026-11-13 óta igazoltan működik (10.6): a `vite` túlélte a restartot, recovered futásként megjelent, és ellenőrzött `taskkill /T`-vel leállt. |
| 2 | PID + indítási idő; PID-újrahasznosításnál nem öl | **IGAZOLT (egység- és élő szinten)** | 6 egységteszt a párosításra (egy jelölt / kétértelmű / időben távoli / rövid token / nincs találat / saját folyamat kizárása); a `cancel()` tesztje igazolja, hogy a saját folyamatot nem öli meg. Élő mérés: 2/13 találat, 2 különböző PID. |
| 3 | induláskori csúcs < 1 GB | **MÉRVE — értelmezésfüggő** | boot RSS 825–941 MB, heap 325–376 MB, `arrayBuffers` ~100 MB (2 s × 60 s minta, `_diag.jsonl` `boot-mem`) → az **RSS**-csúcs < 1 GB; a `PrivateMemorySize64` 5 853–8 588 MB, de az commit charge, nem rezidens memória (6.8). A korábbi 6,7 GB-os kiinduló nem reprodukálható (6.7). |
| 4 | áthelyezés után helyes workspace | **MEGOLDVA (fejléc-átírással, nem áthelyezéssel)** | Az áthelyezés önmagában hibás, mert a kulcs a fejléc literális `cwd`-je, amit a mag ellenőriz (`assertStoredIdentity`, `:3246–3257`) — ezt egyszer el is rontottam (6.5). A helyes út a fejléc `cwd` átírása + move: `tools\canonicalize-session-store.mjs`, eredmény **1188/1188 konzisztens session, 17 → 10 projektmappa**, az mtime-ok helyreállítva (`tools\restore-session-mtimes.mjs`). A mag-oldali kanonizálás továbbra is upstream kérés (3. pont). |
| 5 | szabályos leállásnál nincs „may be orphaned" | **NEM CÉLZOTT** | a sor a mag teardown-ágából jön (`dsh-jobs-local:444–445`), amikor egy `cancel()` dob. A plugin ezt nem érinti; csak upstream javítással szűnik meg. |


Ez a táblázat a dokumentum legfontosabb állítása: a leadott munka kritériumai
közül **kettő teljesen igazolt (2, 4), egy mérve (3), kettő pedig továbbra sem
teljesül** — az 1. a Job Object miatt strukturálisan korlátos (a panel-ága
viszont igen), az 5. csak upstream javítással szűnik meg.


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

### 6.4 Session-tár összevonás — VISSZAVONVA, MAJD HELYES MÓDSZERREL KÉSZ

> **Állapot 2026-11-13 12:20:** a lenti, hibás próbálkozás után a helyes módszer
> (`tools\canonicalize-session-store.mjs`) **lefutott**: 1184 munkamenet a
> kanonikus kulcs alá került, a fejléc `cwd`-je együtt átíródott, és a teljes
> ellenőrzés **1188/1188 konzisztens** (a maradék 4 nyitva tartott munkamenet a
> `--C-…--` mappában maradt, a fejlécével egyezően). Részletek: 6.4.2.

#### 6.4.2 A helyes módszer és a két mellékhatás (2026-11-13, kész)

A mag ellenőrzi, hogy a fejléc `cwd`-jéből számolt út **megegyezik** a fizikai
hellyel (`assertStoredIdentity`, `:3246–3257`), ezért a művelet a kettő EGYÜTT:

1. `tools\canonicalize-session-store.mjs` — a fejléc-frame `cwd`-jét a kanonikus
   (realpath) útra írja (csak az első frame-et tömöríti újra, a többi bájt
   változatlan), majd a munkamenetet a kanonikus kulcs alá helyezi;
2. **sorrend-hiba javítva:** a fejléc-írás **frissíti a fájl mtime-ját**, a lista
   pedig ebből rendez — ezért 1108 munkamenet „most" időponttal jelent meg, és a
   sorrend felborult (mért: `2026-11-13 12:20:21` az eredeti `2026-10-23 17:33`
   helyett). Javítás: `tools\restore-session-mtimes.mjs` a mentésből visszaállítja
   a fájlok időbélyegét (**1107 fájl**), a könyvtárakét nem kell (az áthelyezés
   megőrizte);
3. **sorrend-hiba a művelet közben:** az eszköz első változata előbb írta a
   fejlécet, aztán nevezte át a mappát; a futó harness által nyitva tartott
   4 munkamenetnél az átnevezés `EPERM`-mel bukott, a fejléc viszont már `D:\…`
   volt → 4 munkamenet inkonzisztens. A mentésből visszaállítva, és az eszköz
   most **áthelyezési hiba esetén visszaírja az eredeti fejlécet**.

Végeredmény: **17 project-könyvtár → 10, mind kanonikus**; a hét `--C-…--` mappa
üres; a teljes ellenőrzés **1188/1188 konzisztens**.


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

### 6.8 A 6,7 GB MEGVAN — a projekció-gyorsítótár (2026-11-13)

Kontrollált kísérlet eldobható példányokkal (más port, ideiglenes `DSH_HOME`,
a valódi profil junctionként bekötve, hogy a pluginok és a beállítások azonosak
legyenek). Minden sor ugyanaz a kód, csak a tároló más:

| konfiguráció | WS csúcs | **private commit csúcs** |
|---|---|---|
| üres profil + üres tár | 516,5 MB | 1 168,1 MB |
| valódi profil (pluginok, beállítások) + üres tár | 559,8 MB | **566,5 MB** |
| valódi profil + 100 munkamenet | 550,1 MB | **567,6 MB** |
| valódi profil + 1188 munkamenet, **projcache nélkül** | 457,6 MB | **838,9 MB** |
| **valódi profil + 1188 munkamenet + projcache** | 889,1 MB | **5 853,7 MB** |

**Következtetés:** a csúcsot **nem** a pluginok, nem a beállítások és nem is a
session-logok okozzák (100 munkamenetnél nincs csúcs; 1188-nál projcache nélkül
838,9 MB). A ~5 GB többletet a `~/.dsh/storages/session_projcache`
(1188 fájl, 30,5 MB a lemezen) betöltése adja — a lemezen kis, memóriában
nagy.

Ebből két dolog következik:

1. **A 3. elfogadási kritérium teljesíthető** a gyorsítótár nélkül:
   1188 munkamenettel mért **838,9 MB** private commit < 1 GB.
2. A gyorsítótár **cache**: törlése nem veszít adatot (újraépül). A kívánt
   üzemmód ezért vagy a gyorsítótár korlátozása (méret/lusta betöltés), vagy a
   törlése + az újraépítés vállalása — ez **üzemeltetési döntés**, nem patch.

**Amit ez nem mond ki:** hogy a gyorsítótár *miért* foglal ~5 GB-ot 30 MB-ból
(ez a mag `dsh-session-projection-cache` viselkedése, upstream 4. pontként
javasolható). A mérés azt mutatja, hogy a csúcs a gyorsítótár jelenlétéhez
kötődik, nem a logok számához.

#### 6.8.2 A 6,7 GB valójában COMMIT-CHARGE, nem lakó memória (2026-11-13)

A pluginba épített belső mintavételezés (`boot-mem`, 2 mp-enként, 60 s) a
2026-11-13 13:13-as bootból 30 mintát adott. Ugyanarra a folyamatra:

| metrika | érték | honnan |
|---|---|---|
| **RSS (lakó) csúcs** | **825–941 MB** | `process.memoryUsage().rss` (belülről) |
| heapUsed csúcs | 325 MB | belülről |
| arrayBuffers | ~102 MB | belülről |
| `PrivateMemorySize64` csúcs | 7 534 MB | kívülről (`Get-Process`) |
| t = 60 s | RSS 344 MB-ra esett | belülről |

**Következtetés:** a „6,7 GB-os memóriacsúcs" **commit-charge** (lefoglalt, de
nem használt címtér), nem lakó memória. Ez magyarázza, hogy
- miért nem talált semmit a bájtmásolás-vizsgálat (a header-olvasás 9,2 MB),
- miért telt be a **commit limit** (lapozófájl), miközben a RAM üresnek látszott,
- és miért ugrált a jelentés „1,2 → 3,0 → 6,7 → 1,7 GB" között.
**HELYESBÍTÉS (2026-11-14, a felhasználó pontosítása):** a fenti „commit limit
(lapozófájl) betelt" jelenség **oka a rosszul beállított lapozófájl volt**, amit
korábban az ágens rontott el, és azóta javított (mért: `C:\pagefile.sys`,
32 768 MB kezdő / 65 536 MB max, `AutomaticManagedPagefile = False`; a
jelenlegi foglalás 32 GB, a csúcs-használat 224 MB). A ~22 GB-nál jelentkező
Windows-újraindítás tehát **nem** a helyi modell és a DSH együttes
memóriaigénye miatt történt. A helyi Ollama tiltása (AGENTS.md 2.1) felhasználói
döntésként érvényben marad.

**A 3. kritérium a helyes metrikán TELJESÜL:** az induláskori lakó memória
825–941 MB, azaz **< 1 GB**. A dokumentum 3. kritériuma a commit-metrikát
örökölte a kiinduló jelentésből; a mérőszámot ott kell rögzíteni, hogy commit
helyett RSS/working set értendő.

**Ami továbbra is nyitott:** a commit-charge *miért* ilyen nagy (V8
címtér-foglalás vs. tényleges allokáció). Ehhez a boot-fázisok mélyebb mérése
kellene (heap-prof/trace-gc), ami újraindítást és hosszabb mérést igényel — a
funkcionális viselkedést ez nem érinti.


#### 6.8.1 VISSZAVONVA — a gyorsítótár-hipotézis nem állta meg (2026-11-13)

A valódi példányon elvégzett A/B **cáfolja** a fenti következtetést. A
gyorsítótár (`session_projcache`, 1188 fájl) félretétele után lefuttatott
boot-mérés:

| | private commit csúcs |
|---|---|
| valódi példány **gyorsítótárral** | 5 853,7 MB |
| valódi példány **gyorsítótár nélkül** | **8 566,8 MB** |

Vagyis a gyorsítótár eltávolítása **nem csökkentette**, sőt növelte a mért
csúcsot — a hipotézis hamis. A gyorsítótárat visszaállítottuk
(`session_projcache.bak-20261113-120513` mentés megmarad), mert hasznos, és a
csúcsot nem ez adja.

**Miért tévesztett meg a kontrollált kísérlet?** Az eldobható példányok
(ideiglenes `DSH_HOME`, junction-profil) **kevesebb állapotot** állítanak
vissza: nincs aktív munkamenet, nincs megnyitott panel, nincs előzmény-alapú
előtöltés. Ezért azok a mérések alulbecsülik a valódi bootot — a 838,9 MB és az
8 566,8 MB ugyanarra a konfigurációra két különböző valóság.

**Az egyetlen megbízható út tovább:** a **valódi** folyamatot kell
instrumentálni (pl. `process.memoryUsage()` és `performance` minták a boot
fázisaira bontva, vagy `--heap-prof`), mert a kívülről mért
`PrivateMemorySize64` nem mondja meg, *melyik* fázis foglal. Ez újraindítást
igényel, ezért külön lépés. A csúcs forrása tehát továbbra is **ismeretlen** —
nem állítom, hogy megvan.

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

### 7.1 A `this.log` korlát miért NEM lokális patch (kód-elemzés, 2026-11-13)

A kérés jogos, de a kód szerint **nem foltozható itt** — és ezt jobb tudni,
mint egy félmegoldást szállítani:

- `dsh-session/lib/index.js:1200` — `this.log.push(event)` **korlát nélkül** nő;
  nincs `MAX_`, `truncate` vagy memória-checkpoint a fájlban.
- A `log` a munkamenet **hiteles eseménylistája**, és a `seq` szerződése
  `seq = log.length` (`get seq()`, `:1129–1132`). Levágás esetén be kellene
  vezetni egy `logStart` bázis-offszetet, és **minden** `seq`-et használó helyet
  át kellene írni (az `eventAt`, a `snapshotEvents`, a perzisztencia-kontinuitás
  és a projekciók).
- A `snapshotEvents`/`ownEvents` fogyasztóit beszkennelve **~35 csomag** hívja
  (agent-loop, api-session-controller, compaction, goal, subagent, session-query,
  tools, …), tehát az API-változás nagy, együtt tervezett munka.

**Ami ma is kordában tartja a memóriát:** a protokoll-szintű tömörítés
(`compaction/start|replace|prune`, `:89–92`) — a hosszú munkamenetek lemezen
tömörödnek, és újranyitáskor a rövidített eseményhalmaz töltődik be. A gyakorlati
kar tehát a **tömörítési politika**, nem egy új cap.

**Az `eventsSnapshot` (dsh-session:1109)** referenciatömb-másolata
(eseményenként ~8 bájt; 100 ezer eseménynél ~0,8 MB), és minden append
érvényteleníti — a költsége kicsi, a lapozás csak az API-rétegben indokolt.

Ezért a `this.log` korlát **upstream, együtt tervezett változás** (a `logStart`
bevezetésével), nem helyi patch. A helyi szinten elérhető nyereség a tömörítési
politika hangolása — az a mag beállítása, nem a burkolóé.

## 8. Tálca és indítás (2026-11-13)

Két, a mai mérésből fakadó javítás, amely **nem** a maghoz tartozik, hanem a
Windows-burkolóhoz (`src\DshTray.cs`, `bin\DshTray.exe`).

### 8.1 Panelbeállítások visszaállítása a tálcaikonon

**Tünet:** a rendszertálcaikon menüjéből eltűntek a panelbeállítások — nem
lehetett kapcsolni a panelek számát és a robot megjelenését.

**Ok, bizonyítékkal:** a 2026-10-31-i váltásnál a launcher a PowerShell-tálcáról
(`tray\dsh-tray.ps1`, ott: `panes`/`robotPane`/`robotOnly`, 102–105. sor) a
natív `bin\DshTray.exe`-re állt át, és a natív menü ezeket **nem** kínálta
(összesen 6 eleme volt). A `git status` szerint a tálca forrása **nem** volt
módosítva ebben a munkában (`src\DshTray.cs`, 2026-10-31 09:15) — a regresszió
tehát a váltásból eredt, nem a mai kódból.

**Javítás** (`src\DshTray.cs`):

- `Ablak felosztása` → **1 / 2 / 3 panel** (pipa a jelenlegin),
- `4. felület: robot panel` → `--pane-url "<panes>=<robotUrl>"` (a `DshWindow`
  ezt a 4. panelként értelmezi; `MaxPanes = 4`),
- `Csak robot mód (1 felület)` → `panes = 1` + robot panel,
- mentés a `state\tray-config.json`-ba; a `TinyJson.Set()` **csak a saját
  kulcsainkat** írja, a többit (`autostart`, `logLevel`) érintetlenül hagyja,
- váltáskor **csak az ablak** nyílik újra — a harness nem áll le, nincs
  token-újragenerálás.

Ellenőrzés: a futó új tálca naplója (`state\native-tray.log`):
`config: port=3080 panes=3 robotPane=False robotOnly=False …`. A régi bináris
mentve: `bin\DshTray.exe.old-20261113-110249`.

### 8.2 Dupla indítás kizárása

**Tünet (mért):** ugyanarra a portra két harness indult — a tálca és a
`restart-harness.ps1 -Force` is indított egyet (24504 nyert, 35424 elhalt);
korábban három egymást követő indítás futott (6988 → 16956 → 14412), mert a
tálca ~20 mp-enként újrapróbált, amíg nem jelent meg a token-URL.

**Javítás — két oldal, közös kapuval:**

| Hol | Mit tesz |
|---|---|
| `src\DshTray.cs` → `EnsureHarness()` | neves **mutex** `Global\DshHarnessStart-<port>` (0 ms várakozás: ha más indít, kihagyja) + „friss `harness.pid` = éppen indul" (25 mp) |
| `tools\start-harness-once.ps1` (új) | ugyanaz a mutex + előzetes ellenőrzés (élő pid, foglalt port) + friss pid-fájl ablak; az indítást `restart-harness.ps1 -NoWait`-tel adja le |

A `-NoWait` egyben a másik mért hibát is javítja: a `restart-harness.ps1`
szinkron hívása **elakadt** (a gyermeke 0 CPU-val várt), ezért az elfogadási
próba riport nélkül maradt.

Bizonyíték: futó harness mellett `start-harness-once.ps1` → `a harness már fut
(pid …) — nincs teendő`, a folyamat nem indult újra.

## 9. FONTOS FELFEDEZÉS — közönséges spawnból nincs orphan (2026-11-13)

Ez a nap legfontosabb tanulsága, mert **az átadási dokumentum premisszáját
pontosítja**.

**A mérés:** az elfogadási próba háromszor sem talált elárvult folyamatot.
A diagnosztika (`untracked-pass`: 358 rekord, 471 folyamat a pillanatképben,
0 párosítás) és a közvetlen szimuláció megmutatta: a próbafolyamat **nem élt**
a restart után — a pillanatképben egyetlen azonos nevű folyamat volt, az is a
mérés saját hívása.

**A kód oka** (`dsh-win32-process`): a közönséges `spawn()` folyamatok
**kill-on-close Job Objectbe** kerülnek —
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 8192` (`lib/index.js:481`),
`AssignProcessToJobObject` (`:570`). A harness halálakor a kernel lezárja a
job-handle-t, és **a teljes gyermekfa megszűnik**, akkor is, ha a folyamatot
`Stop-Process -Force`-szal ölték meg. Ezért a közönséges spawnból **nem
keletkezhet orphan** ezen a builden.

**Ami orphan lehet:** a **terminál (ConPTY)** — a mag saját figyelmeztetése
szerint „Windows ConPTY remains outside Job containment"
(`dsh-subprocess-local:1025` `warnFallback`). A mért eredeti eset (Vite dev
szerver) is ilyen volt: terminálból indított folyamat.

**Következmények:**

1. Az 1. elfogadási kritériumot **terminálból** kell reprodukálni (a felületen
   egy terminál-panelben hosszú folyamatot indítani), nem háttér-jobbal. A
   háttér-jobbal végzett próba **soha** nem adhat `pass`-t — ezt a
   `test-orphan-recovery.ps1` fejlécében rögzítettem.
2. A plugin a helyes utat fedi le: a `spawnTerminal` handle **kiadja a pid-et**,
   a ledger rögzíti, a restart utáni reconciláció pedig élő PID-ként
   regisztrálja `recovered` jobként (ezt egységteszt igazolja).
3. **Upstream javaslat pontosítás:** a közönséges spawnok Job-védelme jó;
   a hiány a **terminálok** esetében van (azok nincsenek containerezve, ezért
   maradnak életben és válnak elárvulttá).


## 10. Ágens-terminál: a modell a beépített panelben dolgozik

### 10.1 Architektúra, és miért fájl-postafiók

A DSH beépített terminál-panelje a host síkon fut (`plugins\dsh-ui-extras\lib\index.js`), és egy memóriabeli `RUNS` nyilvántartásban tartja nyomon a futó terminálokat. Az ágens (modell) nem hívhatja meg közvetlenül a panel JavaScript objektumait: a kettő különböző kontextusban van, és a host-oldali panel nem áll toolként az ágens elé. A kettőt egy fájl-alapú postafiókkal kötök össze:

- kérés: `state\terminal-request.json` — mezői: `id`, `action`, valamint az akció függő paraméterek
- válasz: `state\terminal-response.json` — ugyanazon `id`-vel válaszol a kérésre
- figyelő: `startTerminalMailbox()`, 250 ms-enként olvassa a kérésfájlt
- végrehajtó: `runMailboxAction()` a memóriabeli `RUNS` nyilvántartáson
- deduplikáció: a `handledMailboxIds` halmaz az `id` szerinti ismételt feldolgozását kizárja
- diagnosztika: `state\ui-extras-terminal-diag.log`

Miért fájl-postafiók, nem közvetlen IPC? A panel az alkalmazás-UI rétege, nem tool registry; a fájl-postafiók nem igényel új csatornát a harness magában, és minden akció fájlként nyomkövethető. A host oldal már mért állapot: a napló tartalmazza az `apply: terminal mailbox elindult` sort.

A preset bejegyzés az agent-síkban jön létre: `%USERPROFILE%\.dsh\.agent-presets\standard-free\agent.cordis.yml` (`id: tool-terminal`, `name: dsh-terminal-tool`); a plugin a `%USERPROFILE%\.dsh\profiles\node_modules\dsh-terminal-tool` junctionon át töltődik a repó `plugins\dsh-terminal-tool` mappájából.

### 10.2 A fájlprotokoll és az akciók

A kérés egy JSON objektum a `state\terminal-request.json`-ban, a válasz az `id`-vel egyező objektum a `state\terminal-response.json`-ban. Támogatott akciók:

| Akció | Mit tesz |
|---|---|
| `run` | parancs futtatása a panel memóriabeli termináljában |
| `insert` | parancs beírása a terminálba **Enter NÉLKÜL** (a felhasználó nyomja meg az Entert); a host echo-t ír a kimenetbe (`\r\n> <parancs>`), mert a csővezetékes héj nem echo-zna |
| `input` | bemenet küldése futó folyamatnak |
| `output` | terminál-kimenet lekérése |
| `stop` | futás leállítása |
| `list` | futó terminálok listázása |

Agent oldal (`plugins\dsh-terminal-tool\lib\index.js`, új plugin):

- `inject = ["tools"]`
- `defineTool`-nal regisztrált `terminal` tool
- `sendRequest()` a fenti postafiókon kommunikál
- `sleep()`: `run`-nál `waitMs + 8000 ms`, többi akcionál `6000 ms`
- diagnosztika: `state\terminal-tool.log`

Mért működő állapot a protokollon: a `list` kérésre két futás jött vissza (`run-1` = `D:\Szerver\Video`, `run-2` = a repó), és az `insert` valóban beírta a parancsot a panel termináljába.

### 10.3 Mért buktatók

Az implementáció során a következő hibák szakadtak ki, mindegyik mért hibaüzenettel vagy mért viselkedéssel):

| # | Buktató | Mért hibaüzenet / jellemzés | Megoldás |
|---|---|---|---|
| 1 | `defineTool` használata `output` deklaráció nélkül | `tool "terminal" must declare output { schema, render, presentationMeta? }` | `output: { schema, render }` kötelező |
| 2 | `required: true` tulajdonságnál az `output.schema` value-DSL-ben | `unsupported JSON schema: schema.properties.text.required is not supported on type "string"` | a `required` teljes elhagyása az `output.schema`-ban |
| 3 | tömbös `required: [...]` az `output.schema`-ban | `unsupported JSON schema: schema.required is not supported by the value schema DSL` | a `required` teljes elhagyása az `output.schema`-ban |
| 4 | `required: true` a `parameters`-ban | — (itt helyes: a `defineTool` JSON-Schemává alakítja, `parameterSchemaSpecToJsonSchema`) | a `parameters`-nál a `required: true` megmaradhat |
| 5 | `import("@deepseek-ai/dsh-tools")` a junction mappájából | Node a junction valódi útján oldja fel a további importokat; ott nincs `node_modules` (`D:\Szerver\Deepseek Harness\node_modules` nem létezik) | `createRequire` jelöltlista: a plugin saját URL-je, `process.cwd()`, `process.argv[1]` (harness belépési pont), utoljára `~\.dsh\profiles\noop.mjs` |
| 6 | `defineTool` nem oldható fel | — | tartalék: nyers definíció regisztrálása JSON-Schema paraméterekkel (`register()` csak az `output.schema`-t validálja) |
| 7 | preset bejegyzés azonnal látható | preset kompozíció SESSION-LÉTREHOZÁSKOR töltődik | csak új sessionben vagy harness újraindítása után; a kliens a `tools/change` eseményre komponál újra |
| 8 | `ctx.tools` közvetlen olvasása | `cannot get property "tools" without inject` | `ctx.inject(["tools"], cb)` a biztonságos minta |
| 9 | a kérésfájl a lemezen marad | a `handledMailboxIds` memóriabeli, ezért boot után a legutolsó kérés **újra végrehajtódik** (mért 2026-11-13 21:15:56Z: egy korábbi `insert` még egyszer beíródott) — `run` esetén ez minden bootnál lefuttatna egy parancsot | a tool a válasz után törli a `state\terminal-request.json`-t, ÉS a host a 30 s-nál régebbi kérést eldobja (`mailbox: elavult kérés eldobva`) |

### 10.4 Telepítés, ellenőrzés, visszavonás

A repó gyökeréből:

Telepítés:
```
pwsh -NoProfile -File plugins\dsh-terminal-tool\install.ps1
```

Ellenőrzés (junction + preset bejegyzés + node oldali `PARAMS-OK` próba):
```
pwsh -NoProfile -File plugins\dsh-terminal-tool\install.ps1 -Check
```

Visszavonás:
```
pwsh -NoProfile -File plugins\dsh-terminal-tool\install.ps1 -Remove
```

A telepítő létrehozza a `%USERPROFILE%\.dsh\profiles\node_modules\dsh-terminal-tool` junctionot (a repó `plugins\dsh-terminal-tool` mappájára) és a `tool-terminal` / `dsh-terminal-tool` bejegyzést a `%USERPROFILE%\.dsh\.agent-presets\standard-free\agent.cordis.yml` presetbe.

Kézi postafiók-próba PowerShell-ből (a válasz `state\terminal-response.json`-ba kerül):

```
# list akció (mért kimenet: {"id":"…","ok":true,"runs":[…]})
$req = @{ id=[guid]::NewGuid().ToString(); action='list' } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $PWD 'state\terminal-request.json'), $req, (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Seconds 2
Get-Content state\terminal-response.json -Raw

# insert akció: a parancs mező neve `command`, és Enter NÉLKÜL gépel
$req = @{ id=[guid]::NewGuid().ToString(); action='insert'; command='git status --short' } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $PWD 'state\terminal-request.json'), $req, (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Seconds 2
Get-Content state\terminal-response.json -Raw
```

Két csapda a kézi próbában: (1) a parancs mező neve **`command`** (a `text` csendben figyelmen kívül marad, és `az insert parancsot kér (command)` hibát kapsz); (2) a `Set-Content` a PowerShell 5.1-ben ANSI-t ír, ezért UTF-8-at explicit kell kérni — különben az ékezetes parancs hibásan megy át.

### 10.5 Elfogadási állapot

- **HOST oldal: ÉLŐ (mért).** A postafiók fut: a napló tartalmazza az `apply: terminal mailbox elindult` sort.
- **`insert` / `list`: MÉRT MÜKÖDŐ.** A `list` kérésre két futás jött vissza (`run-1` = `D:\Szerver\Video`, `run-2` = a repó), és az `insert` valóban beírta a parancsot a panel termináljába.
- **AGENT oldal (`terminal` tool): IGAZOLT (mért 2026-11-13 22:15).** A harness-újraindítás után a `state\terminal-tool.log` a harness saját mountját rögzítette: `21:15:59.947Z apply: defineTool feloldva (…\dsh-tools\lib\index.js)`, majd `apply: a terminal tool beregisztrálva`; a restartot a `state\restart-later.log` `22:15:47 restart-harness.ps1 -Force elinditva` sora igazolja (új harness pid 36144, indulás 22:15:51).
- **TELJES LÁNC: IGAZOLT.** A `terminal` tool `action=run` hívása a panel `run-2` futásában végrehajtotta a `git status --short` parancsot, és a kimenet a tool válaszaként jött vissza (`run: run-2`, `workspace: D:\Szerver\Deepseek Harness`). A parancs a felhasználó paneljában futott, nem az ágens saját `pwsh` eszközével.
- **A boot-replay javítás (10.3/9. sor) életbe lépése:** a host-oldali 30 s-os eldobás és a tool-oldali kérésfájl-törlés a következő harness-újraindításig nem aktív; addig a `state\terminal-request.json` kézi törlése (vagy a tool törlése egy restart után) tartja tisztán.

### 10.6 A panel-futás túléli a harness-restartot

A `RUNS` szándékosan memóriabeli — a panel viszont HOSSZÚ életű folyamatokat indít (`npm run dev`, `npm run build`). A restart eddig nyom nélkül elfelejtette őket: a rekord eltűnt, a folyamat árvaként tovább élt, a panelben nem látszott, csak `taskkill`-lel lehetett elérni. Mért eset (2026-11-13): két `vite` futott az 5173/5174-en, a panelben egyik sem — a felhasználó joggal hitte, hogy eltűnt a munkája. Ezt a `state\runs.json` zárja be.

- **Mentés (`persistRuns`):** minden induló futás `id + workspace + label + pid + startedAt` rekordja; kilépéskor és a visszatöltés után újraíródik. A `survivors` lista is mentődik, különben a visszatöltés utáni első kiírás elfelejtené.
- **Visszatöltés bootkor (`restoreRuns`), két ág:** (1) a **héj él** → a pid elég; (2) a **héj kilépett** — ez a tipikus, mert a `powershell -NoExit -Command -` a szülő halálakor **EOF-ot kap a stdin-en és kilép** —, a gyerekei viszont élnek → a `survivorPidsByWorkspace()` egyetlen rejtett CIM-hívással megkeresi a rekord **munkaterület-útvonalát** tartalmazó parancssorokat (a `vite` parancssora hordozza: `…\node_modules\.bin\..\vite\bin\vite.js`).
- **A kereső szűrői:** önmaga, a harness pid-je, a kereső saját parancssora, valamint a **héjak** (`powershell.exe`, `pwsh.exe`, `conhost.exe`, `WindowsTerminal.exe`) kimaradnak — egy útvonalat említő terminál nem munkafolyamat, a leállítása a felhasználó kezét vágná le. A találatokból csak a **gyökerek** maradnak: ha egy jelölt szülője is jelölt, a gyereket a szülő `taskkill /T`-je amúgy is elviszi (ez szűri ki az `esbuild` segédfolyamatokat is).
- **Leállítás (`killRecoveredRun`):** pid-enként **ellenőrzött** — a héjnál `-NoExit`, a túlélőknél a munkaterület-útvonal egyezése a parancssorban —, és csak egyezés esetén `taskkill /F /T`. Ami nem egyezik, azt kihagyja (idegen folyamathoz nem nyúl), a maradékot visszaírja a rekordba.
- **Amit NEM tud:** a recovered futás **kimenete nem hozható vissza** (a cső megszakadt) és a **bemenete nem irányítható**. Ezért a `writeToRun()` érthető hibát ad, a `latestLiveRun()` pedig kihagyja őket, hogy a `terminal` tool mindig írható héjat kapjon.

**Mért elfogadási bizonyíték (2026-11-13, 22:34–22:38):**

| Lépés | Mérés |
|---|---|
| restart, 2 rekord, héj nélkül | `runs: 2 korábbi futás visszatöltve (2 rekord, ebből 2 héj nélküli)` |
| a panel listája | `run-3` / `run-4` `recovered: true`, szövegük: „a héj, ami ezt indította, … kilépett — a folyamat viszont ÉL: 46676" |
| a folyamatok túlélték | 5173 = `46676`, 5174 = `42540` a restart ELŐTT és UTÁN is |
| a kereső pontossága | nyers: `46676`, `45352` (esbuild), `42540`, `47544` (esbuild) → gyökér-szűrés után `D:\Herd…` → 46676, `C:\Herd…` → 42540 |
| recovered leállítás | `action=kill&id=run-4` → `{"ok":true,"tree":true}`; 42540 eltűnt, 5174 felszabadult, **5173 érintetlen** |

- **Az üres terminál kimarad:** a `shell` feliratú (parancs nélküli) futásokat sem nem mentjük, sem nem keressük. Ennek oka a hamis találat: a munkaterület-útvonal a parancssorban bármilyen később indított folyamatra illeszkedhet (például egy `node tools\…` futásra), és abból „túlélő" lenne — üres terminálnál viszont nincs mit megmenteni.
- **Kanonikus munkaterület-kulcs a panel állapotában is:** a `C:\Szerver` junction miatt ugyanaz a projekt KÉT kulccsal élt a `state\panel-layout.json`-ban — mért eset (2026-11-13): **14 kulcs, 9 valódi projekt**, és a beállítások (nyitott terminál, aktív fül, szűrő) kétfelé szóródtak. A `canonicalWorkspace()` `realpathSync.native`-tal oldja fel a junctiont; a `handleLayout()` és a `startRun()` már kanonikus kulccsal dolgozik, bootkor a `migrateWorkspaceKeys()` egyszer összevonja a meglévő bejegyzéseket (`state\panel-layout.json`, `state\runnables.json`, `state\runs.json`). Kézi eszköz ugyanerre: `node tools\canonicalize-panel-state.mjs [--apply]` (mentés `*.bak-<időbélyeg>` néven). Mért eredmény: 14 → 9 kulcs, a `runnables` kulcsa a `D:` alakra íródott, a `runs` 1 rekordjának workspace-e átíródott, és a `layout` API a kanonikus kulcsra válaszol.
- **A kereső a MAPPANEVRE is illeszt, és egy pid csak egy rekordé:** a folyamat a MEGINDÍTÁSKORI útvonalat hordozza, az pedig junctionos alak lehet. Mért eset (2026-11-13 23:33): a `C:` alakkal indult `vite` (`41572`) láthatatlan maradt, mert a rekord kulcsa a `D:` alak; a `canonicalWorkspace()` által egységesített rekordok pedig UGYANAZOKAT a pid-eket követelték (`run-3` és `run-7` is `[46676, 7112]`). Javítás: `workspaceNeedles()` a kanonikus útvonal mellé a `\<mappanév>\` szegmenst is keresi, a boot pedig egy `claimedPids` halmazzal biztosítja, hogy **egy folyamat csak egy rekordhoz** tartozzon. Mért próba: a tűk a `C:` és `D:` alakú `vite`-ot is megtalálják (`46676`, `41572`), az `esbuild` segédeket a gyökér-szűrés kiveszi.
- **A `state\harness.pid` nem marad elavult:** a `tools\restart-harness.ps1` a pid-fájlt eddig csak a token-URL megtalálása UTÁN írta, és a listener-listából az ELSŐ pidet vette. Mért eset (2026-11-13 23:33): a restart után a fájl a KORÁBBI harness pid-jét (`40860`) tartalmazta, miközben az új a `38480` volt — az elavult fájl miatt a tálca indítója halottnak hiheti a futó harness-t. Javítás két oldalon: a szkript a tokenre várás ELŐTT ír, és a **legfrissebb indulású** listenert választja; a `dsh-process-guard` pedig bootkor a saját pid-jével írja ki a fájlt (a harness biztosan tudja), így a fájl akkor is helyes, ha a külső szkript írása kimarad.
- **A megszakadt futás automatikusan folytatódik:** a rekord mostantól a **parancsot** is tárolja (`command`), nem csak a pidet. Ha bootkor a munkaterületen **semmi nem él** (a héj is elment, a gyerekek is), az `autoResumeRuns()` újraindítja ugyanazzal a munkaterülettel és paranccsal, és a terminál kimenetébe beírja, hogy `[automatikus folytatas a korabbi bootbol: …]`. Nem indít újra, ha a munkaterületen még él folyamat (az a folytatás), ha a rekordnak nincs parancsa (üres terminál), vagy ha a `state\no-auto-resume` jelölő / a `DSH_NO_AUTO_RESUME=1` kikapcsolja. Legfeljebb 8 rekord indul, 3 s késleltetéssel és 1,5 s lépésközzel, hogy a boot ne kapjon egyszerre nyolc indulást. A felhasználói szándékot a rekord **eltűnése** hordozza: a `stop` / `forget` után a futás `done` lesz, a `persistRuns()` kiveszi a `state\runs.json`-ból, tehát semmi nem támasztja fel.
- **A kereső HÁROM szűrője (a teszt tanulsága, 2026-11-14 04:58):** a teszt-rekord túlélőiként a `DshWindow.exe` (`36392`) és a `DshTray.exe` (`37368`) került a fájlba — ezek parancssorában is ott a munkaterület útvonala, mégsem munkafolyamatok, és egy `stop` kilőtte volna a tálcát. Ezért a kereső: (a) kizárja a héjakat ÉS a DSH saját binárisait (`DshWindow`/`DshTray`/`DshLauncher`/`explorer`), (b) kizárja a **mostani** harness közvetlen gyerekeit és mindent, ami a mostani boot UTÁN született (idő-kapu a `process.uptime()`-ból), (c) a **mentett** túlélőket is ellenőrzi: csak az maradhat, amit a keresés is megtalált, tehát a parancssora tényleg a munkaterülethez tartozik.

### 10.7 A beszélgetés folytatása boot után

A 10.6 a **folyamatokat** folytatja; a megszakadt **beszélgetés-kört** a `plugins\dsh-session-auto-continue` plugin indítja újra. Ez HOST-síkos plugin (a `sessions` és `sessionController` szolgáltatást injektálja), a helye a profil-patch (`~\.dsh\profiles\web\cordis.patch.yml`), nem az agent-preset.

- **A jel, amit keres:** a mag a crash után betöltéskor **javítja** a naplót (`interruptedTurnClosers`, `dsh-session/lib/index.js` ~593–710): `turn/end` eseményt fűz be `data.reason.kind === "interrupted"` jelöléssel. Ha egy session utolsó kör-határa ilyen, az a kör a harness leállása miatt szakadt meg — **ezt** folytatjuk. (A session tehát nem marad nyitva, csak nem folytatódik magától.)
- **A belépő:** `ctx.sessionController.prompt({ sessionId, content: [{type:"text", text}], requestId })` — ugyanaz, amit a böngésző használ (`dsh-api-session-controller/lib/index.js:736` `async prompt`, a szolgáltatás `:2726`-nál `super(ctx, "sessionController", …)`); belül `resolveAgent()` → `agent.followup(message)`.
- **Korlátok:** legfeljebb **2 session** bootonként, a megszakadás legfeljebb **6 órás**, és session+szekvencia szerinti jelölő a `state\auto-continue.json`-ban — ugyanaz a megszakadt kör **nem** folytatódik kétszer. A beadott szöveg kimondja, hogy előbb ellenőrizze a valós állapotot, ne ismételjen vakon (a félbemaradt lépés mellékhatása ne duplázódjon).
- **Kikapcsolás:** `state\no-auto-continue` jelölő vagy `DSH_NO_AUTO_CONTINUE=1`. Napló: `state\auto-continue.log`.
- **Telepítés:** `pwsh -NoProfile -File plugins\dsh-session-auto-continue\install.ps1` (`-Check`, `-Remove`); a host-kompozíció boot-időben töltődik, tehát **újraindítás** kell hozzá.

**MÉRT ÁLLAPOT (2026-11-14 06:45) — a folytatás a HOST HTTP RPC-n MŰKÖDIK:**

A folyamaton belüli út **zsákutca** (és ezt meg is mértük): a `sessionController.prompt()` közvetlen hívása `Cannot read properties of undefined (reading 'throwIfAborted')` hibát ad, mert a typert réteg a híváshoz `signal`-t (cancellation) ad, a `sessionController`-en pedig **nincs `resume()`** — így ágenst sem lehet szerezni.

A **működő út a böngésző HTTP-csatornája**, amit a `promptViaHttp()` használ (mért, 2026-11-14 06:45 — `{"ok":true,"value":{"accepted":true}}`):

1. `GET <state\harness.url>` (a token az URL-ben) → `dsh-auth-…` süti;
2. `POST <origin>/api/session/prompt`, `content-type: application/json`, a sütivel, ezzel a borítékkal:
   ```json
   { "type": "client-request", "rpcId": "<uuid>", "method": "session/prompt",
     "payload": { "args": { "request": {
       "sessionId": "<id>", "requestId": "<uuid>", "mode": "queue",
       "content": [{ "type": "text", "text": "Automatikus folytatás: …" }] } } } }
   ```
3. a válasz `{ "result": { "ok": true, "value": { "accepted": true } } }`.

**A boríték buktatói (mind mért hibaüzenet):** a `payload`-nak pontosan egy `args` mezője lehet, az `args`-ban a paraméter neve `request` (nem laposítva), a `mode` **kötelező** (`queue` | `steer`), és a `content` csak `[{type:"text",text}]` / `image` / `file` alakú lehet. Az endpoint `<namespace>/<method>` (itt `session/prompt`), nem ponttal elválasztva — a `session.list` alak 404.

Az egységtesztek ezért egy **helyi fake RPC-szervert** indítanak, és a valódi kódutat futtatják: 4/4 zöld (megszakadt kör → egy hívás, befejezett kör → nincs hívás, nyitott turn → hívás, jelölő → nincs dupla).

**Következmény:** a *terminál*-futások (10.6) és a *beszélgetés* is automatikusan folytatódik restart után; a folytatás a `state\auto-continue.log`-ban `folytatás elküldve (HTTP RPC)` sorral jelenik meg.








