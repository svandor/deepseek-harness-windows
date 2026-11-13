# dsh-process-guard

Perzisztens folyamat-ledger + induláskori reconciláció a DeepSeek Harnesshez.

## Miért

A DSH job-nyilvántartása tisztán memóriabeli (`dsh-jobs-local/lib/index.js:105`
`store = new Map()`), a teardown pedig csak figyelmeztet
(`cancelForTeardown()`, 435–452: „work may be orphaned"). Ezért ha a DSH
összeomlik vagy újraindul, a gyerekfolyamat tovább fut, de a felület nem látja
és nem tudja leállítani.

Mért eset (2026-11-12): a DSH-ból indított Vite dev szerver
(`node.exe` PID 46484, 1,6 GB, **49 990 handle**) a DSH leállása után is futott;
a DSH nem tudott róla.

## Mit tesz

1. **Ledger**: minden `ctx.subprocess.spawn()` / `spawnTerminal()` után egy
   rekord, workspaconként egy append-only JSONL:
   `~/.dsh/process-ledger/<sha256(realpath(workspace))>.jsonl`.
   Mezők: `pid`, `started` (indítási idő), `cmdline`, `cwd`,
   `workspaceRealpath`, `sessionId`, `jobId`, `kind`, kilépéskor tombstone.
2. **Reconciláció**: induláskor visszajátssza a ledgert; a halott PID-eket
   eldobja, az élőket `recovered-<pid>` néven bejegyzi a jobs-registrybe
   (`owner: undefined`, ezért minden munkamenet listája látja, és
   `job_output` / `job_kill` működik rájuk).
3. **Biztonságos leállítás**: `job_kill` esetén PID **+ indítási idő**
   egyezését ellenőrzi, és csak utána `taskkill /T /F` (POSIX-on `kill`).
   PID-újrahasznosításnál **nem** öl idegen folyamatot — ilyenkor a naplóba
   `pid-reused` ok kerül, a job futva marad.
4. **Diagnosztika**: egy összefoglaló sor a boot naplóban (rekordok, recovered
   jobok, halottak, ellenőrizetlenek, eltelt idő).

## Telepítés

Normál PowerShell-ablakból (a `~\.dsh` a DSH sandboxján kívül van):

```powershell
cd "C:\Szerver\Deepseek Harness\plugins\dsh-process-guard"
.\install.ps1              # junction + patch-bejegyzés + újraindítás
.\install.ps1 -Check       # száraz ellenőrzés
.\install.ps1 -NoRestart   # telepítés újraindítás nélkül
.\install.ps1 -Remove      # eltávolítás
```

A telepítés ugyanaz az út, mint a `dsh-hazi-robot`-nál: junction a
`~\.dsh\profiles\node_modules` alá, és egy `- insert:` bejegyzés a
`~\.dsh\profiles\web\cordis.patch.yml` fájlba.

## Korlátok

- A PID kinyerése a subprocess handle-ből best-effort: a nyilvános
  `SubprocessHandle` típus nem írja elő a `pid` mezőt. amelyik handle nem adja
  ki, arról nem keletkezik rekord (a napló ilyenkor csendes).
- Ha a folyamat indítási ideje nem olvasható vissza (a mag belső inspectora
  sem elérhető, és a WMI sem válaszol), a rekord `started: null` marad: a job
  megjelenik, de **nem** ölhető — ez szándékos (inkább ne öljünk, mint
  idegent).
- A plugin a mag belső felületeit (`jobs.store`, `subprocess.spawn`) használja.
  Ha ezek egy DSH-frissítésben megváltoznak, a plugin néma: figyelmeztet a
  naplóban, de a bootot nem akasztja meg.

## Kapcsolódó

- `docs\DSH-ATADAS.md` — az átadási dokumentum és a gyökérokok ellenőrzése.
- `tools\patch-harness.mjs` — a mag memória-javításainak újraalkalmazható
  rétege (mivel a harness mag nem ebben a repóban van).
