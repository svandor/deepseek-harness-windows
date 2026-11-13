# Upstream issue — folyamat-életciklus, session-tároló kulcsa, memória-metrika

> English mirror: [`DSH-UPSTREAM-ISSUE.en.md`](DSH-UPSTREAM-ISSUE.en.md)

Ez a fájl **bemásolható issue** a `github.com/deepseek-ai/deepseek-harness`
repóba. Minden állítás ezen a gépen, a kiadott csomagokon (`0.1.5-rc.3`)
végzett mérésből származik, és a sorszámok a `lib/index.js` fájlokra
vonatkoznak.

---

## 1. `SubprocessHandle` nem ad ki PID-et

A nyilvános felület ma: `stdin, stdout, stderr, collected, done, terminate,
terminateForHostExit, waitForExit` — **nincs `pid`**. A `spawn()` által indított
folyamatot így semmilyen hosztoldali kód nem tudja azonosítani vagy később
leállítani; a `terminateForHostExit` a graceful leállásra elég, de egy összeomlás
után nincs mihez nyúlni.

**Kérés:** `readonly pid: number` (és opcionálisan az indítási idő identitása) a
`SubprocessHandle`-en — ez az egyetlen valódi API-hiány, ami miatt külső
megoldás kell.

## 2. Perzisztens folyamat-ledger és induláskori reconciláció

- `dsh-jobs-local/lib/index.js:105` — `store = new Map()`: a
  job-nyilvántartás tisztán memóriabeli.
- `dsh-jobs-local:435–452` — `cancelForTeardown()` csak warnol
  (`work may be orphaned`, `:444–445`), nem keres OS-szintű folyamatot.

**Kérés:** a teardown után is látszó, PID-del és indítási idővel azonosított
job-rekord, induláskori reconcilációval. Referenciamegvalósítás kívülről
működik (plugin), de a helye a magban van.

## 3. A session-tároló kulcsa nem kanonikus, és nem tolerálja az ekvivalenst

- `dsh-session-persistence-jsonl/lib/index.js:874` — `projectKey(cwd)` a fejléc
  `cwd` **literális** szövegét kódolja.
- `:3246–3257` — `assertStoredIdentity()` a fejlécből számolt utat hasonlítja a
  fizikai helyhez, és „corrupt session log"-ként elutasítja az eltérést.

Következmény: ugyanarra a könyvtárra **több tároló** keletkezik, ha az útvonal
különböző alakban került be (junction, áthelyezés, kis/nagybetű). Mért eset:
1093 napló `C:\…` fejléccel, miközben a valódi könyvtár a `D:` köteten van; a
felület ugyanazt a munkaterületet kétszer-háromszor listázta.

**Kérés (kettő együtt):**
1. a `cwd` **tároláskor** kanonizálódjon (`realpath`),
2. a betöltés fogadja el a kanonikus ekvivalenst (a `sameFile` szellemében),
   hogy egy áthelyezés ne tegye „corrupt"-tá a naplót.

*Megjegyzés a mérésből: a puszta áthelyezés tönkreteszi a bootot — ezt egy
helyi kísérlet igazolta (a DSH nem indult el, amíg a naplókat vissza nem
raktuk). Ezért a két lépés csak együtt biztonságos.*

## 4. A memória-metrika félrevezető: commit-charge ≠ lakó memória

Az induláskori „6,7 GB-os csúcs" **`PrivateMemorySize64`** (commit charge), nem
lakó memória. Ugyanarra a folyamatra, belülről mérve (`process.memoryUsage()`):

| metrika | érték |
|---|---|
| RSS csúcs | **825–941 MB** |
| heapUsed csúcs | 376 MB |
| arrayBuffers | ~100 MB |
| `PrivateMemorySize64` csúcs | **8 588 MB** |

Ez magyarázza, hogy a commit limit (lapozófájl) telt be, miközben a RAM üresnek
látszott. **Kérés:** a dokumentált memória-kritériumok mondják meg a metrikát
(RSS/working set), mert a commit charge a V8 címtér-foglalását is tartalmazza.

## 5. Konkrét hiba: az allokációs hiba „corrupt log"-ként álcázódik

`dsh-session-persistence-jsonl:3150` — a fejléc-frame dekódolásának minden hibája
`corrupt Zstandard session log` lesz, a `ZSTD_error_memory_allocation` is. Ez
félreviszi a diagnózist (a valódi ok memóriahiány, nem sérült fájl).

**Kérés:** külön ág az allokációs hibára (a kész patch
`tools/patch-harness.mjs`-ben van a hivatkozott repóban).

## 6. Terminálok containerezése

A közönséges `spawn()` folyamatok **kill-on-close Job Objectbe** kerülnek
(`dsh-win32-process`: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
`AssignProcessToJobObject`), ezért a harness halálakor megszűnnek — ez jó.
A **terminál (ConPTY)** viszont a mag saját figyelmeztetése szerint kívül esik a
Jobon (`dsh-subprocess-local:1025`), ezért a terminálból indított hosszú
folyamat összeomlás után **életben marad** (mért eset: 1,6 GB-os dev szerver).

**Kérés:** a ConPTY-folyamatfa ugyanilyen containerezése, vagy a `pid`
kiadása + ledger (1–2. pont), hogy legalább leállítható legyen.

## 7. `this.log` korlát (tervezési kérés)

`dsh-session:1200` — `this.log.push(event)` korlát nélkül; a `seq` szerződése
`seq = log.length` (`:1129–1132`), ezért a levágás `logStart` bázis-offszetet és
minden `seq`-fogyasztó (≈35 csomag) átnézését igényli. Ezért nem javaslom
lokális patchként; a protokoll-szintű tömörítés (`compaction/replace`) ma is
kordában tartja a lemezt és az újranyitott memóriát.

---

## Függelék: a hosszú session memóriája (`this.log` és `eventsSnapshot`)

### A session eseményforrása: `this.log` csak növeksik

A `Session` osztály (`@deepseek-ai/dsh-session/lib/index.js`) egy append-only
`log` tömböt tart, amely az eseményforrásos állapot egyetlen forrása:

```js
log = [];                                    // dsh-session/lib/index.js:989
```

A `seq` szerződése a log hossza:

```js
get seq() {
    return SessionLogOffset(this.log.length);  // :1130–1132
}
```

Minden `append` képbe push-ol egy eseményt:

```js
this.log.push(event);                        // :1200
this.eventsSnapshot = void 0;                // :1201 (snapshot cache invalidálása)
```

A clase-en **nincs** `logStart`, `reduce`, `applyEvent` vagy `restore` metódus
(a `lib/index.js`-ben kereséssel nem találtam ilyen neveket). A broadcast és az
azonos sorrend a `SurfaceManager`-on keresztül fut le a `log` पर직 feldolgozásával
(`_processDelta`, `:485–496`), de az alapadatok `this.log`-ban maradnak véglegesen.

### Visszatöltés (replay) a logból — nem reduce, hanem constructor seed

A session-t a konstruktor építi újra egy `seed` eventsorozatból, nem egy `reduce`-ből:

```js
constructor(id, seed, header, mode = "snapshot", suppliedInheritedEventCount) {
    ...
    if (seed !== void 0) for (const [index, source] of seed.entries()) {
        ...
        this.log.push(mode === "snapshot" ? deepFreeze(snapshot) : snapshot);  // :1075
    }
    ...
}
```

A perzisztencia réteg (`dsh-session-persistence-jsonl/lib/index.js`) a mentett
fájlból dekódolt `events` tömböt adja át `Session.fromRestore(...)`-nak (`:1822`),
és a konstruktor ismét le push-olja őket a `log`-ba. Tehát a betöltés **a teljes
`this.log`-ból építi** az állapotot: bármilyen lokális csonkolás (pl. a
legutolsó N esemény levágása) meghalást írnám meg a séance visszafejtéséhez,
mert a `seq = log.length` szerződés és minden `eventAt(seq)` /
`snapshotEvents(from, to)` hívó feltételezi a tanúsított, fuzzymentes sorrendet.

### `eventsSnapshot` — a teljes log másolata első hozzáférésnél

```js
eventsSnapshot;                                              // :1090
snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq) {   // :1107
    if (fromSeq === 0 && toSeqExclusive === this.log.length) {
        this.eventsSnapshot ??= Object.freeze([...this.log]);   // :1109
        return this.eventsSnapshot;                              // :1110
    }
    return Object.freeze(this.log.slice(fromSeq, toSeqExclusive));          // :1112
}
```

A `??=` azt jelenti, hogy a teljes logot **egyszer** lemásolja (sekély másolat,
de minden elem referencia), és addig újraadja, amíg egy `append` nem nullázza
azt (`this.eventsSnapshot = void 0`, `:1201`).

### `snapshotEvents` fogyasztói (kik hívják, milyen gyakran)

A `snapshotEvents()` / `eventsSnapshot()` / `ownEvents()` hívói széles körben
terjednek a `@deepseek-ai` csomagokban. A legfontosabbak (tesztelt fájl, sort —
a teljes lista a grep-ből):

- `dsh-api-session-controller/lib/index.js:904, 2815` — `events:
  attached.snapshotEvents()` (kliens-felé kiadott session snapshot, teljes log)
- `dsh-api-session-controller/lib/types/commands.js:493` — teljes log a session
  parancsban
- `dsh-api-session-controller/lib/types/history.js:170` — offset-alapú sufix
  (már lapozott)
- `dsh-agent-loop/lib/index.js:231` — `session.snapshotEvents().toReversed()`
  (teljes log, fordítva)
- `dsh-agent-loop/lib/index.js:1808` — sufix `stored.storedCount`-tól
  (inkrementális perzisztencia)
- `dsh-session-query/lib/index.js:276, 303, 484` — teljes log, illetve
  `materialized ??= snapshotEvents(0, seq)` (már lapozott)
- `dsh-session-projection/lib/index.js:381, 407` — teljes log és prefixig
  tartó lapozott hívás
- `dsh-session-log-deepseek/lib/types/index.js:134` — teljes log
- `dsh-session-title/lib/index.js:282, 456` — teljes log
- `dsh-goal/lib/invariant.js:297` — teljes log (fold)
- `dsh-session-telemetry/lib/index.js:115` — cursor-alapú sufix (lazozott)
- `dsh-subagent/lib/index.js:342`, `dsh-subagent-in-process-driver/lib/index.js:232`
  — gyerek-boundary sufix
- `dsh-session/lib/invariant.js:136` — teljes log `applyTransition` replay
- További validációs rétegek: `dsh-commands`, `dsh-compaction`,
  `dsh-hook-protocol`, `dsh-llm-retry`, `dsh-message-feedback`,
  `dsh-permission-presets`, `dsh-plan-mode`, `dsh-sandbox-policy`, `dsh-schedule`,
  `dsh-tools`, `dsh-tool-todo`, `dsh-tool-workflow`, `dsh-time-context`,
  `dsh-user-approval`

A kliens-felé lévő hívók (`dsh-api-session-controller`) azonnal egy **teljes**
log másolatot kapnak, mert az alapesetek `fromSeq = 0`,
`toSeqExclusive = this.log.length` — vagyis elérik az `eventsSnapshot` cache-et.
Egy hosszú sessionben ez minden olyan kérésnél új teljes tömb másolatot
jelent, amely nem ad meg offset/limitet.

### Miért nő lineárisan a memória?

1. `this.log` soha nem csökken: minden `append` push-ol, nincs expiracy, nincs
   memóriábani compaction (a `compaction/*` események csak felületi címkék a
   logban, nem törlnek eseményt a `log` tömbből).
2. `eventsSnapshot` a teljes logot segédtömbként tárolja addig, amíg nem jön új
   append (`??=` invalidate csak append-nél).
3. A fogyasztók többnyire `snapshotEvents()` hívják offset/limit nélkül → minden
   ilyen hozzáférés egy új (vagy a cached) teljes tömbötől függ.
4. A `seq = log.length` szerződés megakadályozza a triviális
   `this.log = this.log.slice(-N)` csonkolást: a betöltés a teljes logból
   építi, és minden `eventAt(seq)` feltételezi a continuitást.

Lineáris a memóriában az eseményszámban: O(N) a log, plusz O(N) a snapshot
cache, plusz minden nem-lapozott `snapshotEvents()` hívás új O(N) másolatot.

### Javaslat (API-kompatibilis)

A meglévő `snapshotEvents(fromSeq, toSeqExclusive)` aláírás már lapozott nézetet
tesz lehetővé (már most használják pl. `history.js:170`,
`session-query:484`, `subagent:342`). A gyökérprobléma, hogy az alapértelmezett
(offset/limit nélkül) hívás a teljes logot másolja. Ajánlott:

1. **Hagyjuk meg `snapshotEvents(fromSeq, toSeqExclusive)` és `ownEvents()`
   unchanged** — már támogatják az offset/limitet.
2. **`eventsSnapshot`/`??=` teljes-log cache-ének eltávolítása**: a
   `snapshotEvents(0, this.seq)` esetén ne tároljunk egy teljes másolatot,
   hanem adjon vissza `Object.freeze(this.log.slice(0, this.log.length))` —
   ugyanaz a szemantika (immutable, független a későbbi appenttől), de nem marad
   meg egy O(N) cached másolat a session életciklusában. Az `append` helyen a
   `this.eventsSnapshot = void 0` sort töröljük (hiába van, ha nincs cache).
3. **Kliens-felé (API) hívókat** (`dsh-api-session-controller:904, 2815;
   commands.js:493`) folyamítsunk át `snapshotEvents(0, this.seq)`-re, vagy adjunk
   egy opcionális, dokumentált `maxEvents` korlátot, ami a legutolsó N
   eseményt adja vissza anélkül, hogy a `log`-ot csonkolná.
4. **Ne csonkoljuk soha `this.log`-ot vakosan** — a betöltés a teljes logból
   építi az állapotot (`Session.create`/`fromRestore`, `:1063–1088`;
   persistence `:1822`), és a `seq = log.length` szerződést minden
   `eventAt` / `snapshotEvents` hívó feltételezi. A csonkolás csak egy
   protokoll-szintű compaction/replace-val lehetséges, ami már létezik a lemezen
   (`compaction/*` események), de az in-memory `log` törlése a `seq`
   referenciait sérrelné.

A `??=` elhagyása a legbiztosabb minimális változtatás: nem tör új API-t, nem
változtatja a viselkedést a fogyasztók számára (minden snapshot továbbra is
immutable), csak elévíti a O(N) cached másolatot a session memória-profile-
jából.

### Mit NEM szabad tenni

- **Ne csonkoljuk `this.log`-ot** (pl. `this.log = this.log.slice(-N)`), mert a
  konstruktor és a persistence betöltés a teljes logból építi az állapotot, és a
  `seq = log.length` szerződést minden `eventAt(seq)` / `snapshotEvents`
  fogyasztó feltételezi.
- **Ne távolítsuk el `snapshotEvents(fromSeq, toSeqExclusive)`-t** — már most a
  lapozott nézet alapja, és több hívó (`history.js:170`, `session-query:484`,
  `subagent:342`) használja.
- **Ne nevezzünk be `reduce`/`applyEvent`-et** a clase-be a log lapozása
  nélkül — a restauráció a constructor seed replay-on alapul, nem egy fold-on,
  ami működné egy részes loggal.

### Összefoglaló (upstream issue-kompatibilis, 5 pont)

- `this.log` append-only, `seq = log.length`
  (`dsh-session/lib/index.js:1130–1132, 1200`); nincs expiracy, nincs
  `logStart`/`reduce`/`applyEvent` metódus; a betöltés a teljes logból építi
  (`:1063–1088`, persistence `:1822`).
- `eventsSnapshot ??= Object.freeze([...this.log])` (`:1109`) a teljes logot
  másolja első teljes kérésnél, és append-nél invalidálódik (`:1201`).
- `snapshotEvents()` / `ownEvents()` sok fogyasztó van a `@deepseek-ai` fában
  (pl. `dsh-api-session-controller:904`, `dsh-agent-loop:231`,
  `dsh-goal:invariant.js:297`), többségük offset/limit nélkül → O(N) másolat
  minden hozzáférésnél.
- Memória lineáris a session eseményszámában: `this.log` + snapshot cache +
  minden nem-lapozott hívás új másolata.
- Javaslat: `??=` teljes-log cache-ének elhagyása,
  `snapshotEvents(fromSeq, toSeqExclusive)` megtartása már meglévő lapozott
  API-ként, kliens-felé hívók áthelyezése offset/limit használatára;
  `this.log` soha ne csonkolódjon vakúan.

---

## Függelék: a hosszú session memóriája (`this.log` és `eventsSnapshot`)

Ellenőrzés a futó kódon (2026-11-13); a hímek a
`@deepseek-ai/dsh-session/lib/index.js`-re mutatnak.

**1. A napló korlátlanul nő.** `append()` → `this.log.push(event)` (`:1200`),
majd `this.eventsSnapshot = void 0` (`:1201`): minden esemény után
érvényteleníti a cache-t. A `seq` szerződés `seq = log.length`
(`:1129–1131`), és `eventAt(seq)` közvetlenül indexel (`:1096–1098`) — ezért a
napló **nem csonkítható elölnézetből**: a vágás `baseSeq`/`logStart` eltolást
kíván, és a `seq` minden fogyasztóját át kell nézni (kb. 35 csomag).

**2. A „teljes" pillanatkép MÁSOLAT, nem nézet.** `snapshotEvents()` teljes
tartományra `Object.freeze([...this.log])` (`:1109`), részleges tartományra
`this.log.slice(...)` (`:1112`) — mindkettő ÚJ tömb.

**3. A drága hívó a meleg úton van.** `dsh-agent-loop:231`
`session.snapshotEvents().toReversed()` — minden LLM-kérésnél a TELJES naplóból
két tömb készül (másolat + fordított másolat). Teljes pillanatképet kér a
projekció-újraépítés (`dsh-session-projection:381`), a session-csatolás
(`dsh-api-session-controller:904, 2815`), a session-title (`:282`) és a
`log-deepseek` író (`:124`); a `dsh-session-query:303` még `structuredClone`-nal
MÉLYEN is másol.

**4. Már van prefix-fogalom, csak nem erre.** A fork `inheritedEventCount`-ja
(`:1083–1084`, `ownEvents()` `:1118–1120`) pontosan egy prefix-határ — ott a
prefix MEGMARAD. Egy sapkához ugyanez kellene, eldobott prefixszel.

**5. Javaslat (5 pont).**
1. `logStart`/`baseSeq` a session fejlécében és a perzisztált alakban;
   `eventAt(seq)` és `snapshotEvents` erre indexeljen.
2. `snapshotEvents()` adjon **nézetet** (iterátor + `length` + `at()`), ne
   tömböt; a `.toReversed()` helyére fordított iterátor.
3. Időszakos `session/checkpoint` esemény az összehajtott állapottal, hogy a
   betöltés a checkpointsávtól replayseljen, ne 0-tól.
4. Konfigurálható sapka (`maxLogEvents`), és a levágás csak checkpoint(ok) után.
5. A kliens-felé menő hívások (`dsh-api-session-controller`) használjanak
   offset/limit lapozást — az API a félig nyílt tartományt már támogatja.

**Amit NE:** a `this.log` vak csonkolása. A betöltés a naplóból épít, a
`seq`-folytonosság szerződés, és a `storedCount` / `inheritedEventCount` / a
projekciók a levágott prefixre hivatkoznának — ugyanaz a hibaosztály, mint a
session-tároló kulcsának áthelyezése (3. pont).
