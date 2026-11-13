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
