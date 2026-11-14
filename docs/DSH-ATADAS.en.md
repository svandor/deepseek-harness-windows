# DSH handover — process ledger, reconciliation, memory

> Magyar változat: [`DSH-ATADAS.md`](DSH-ATADAS.md)

Handover from the **Vector** repository (`D:\Szerver\Vector\DSH-atadas.md`,
written 2026-11-13). This file is the repo-side copy: the handed-over root
causes were **verified against the running code**, and it records where a fix
can actually live.

---

## 1. What the handover asks for

1. **Persistent process ledger**: one record per spawned process (`pid`, start
   time, `cmdline`, `cwd`, `sessionId`, `jobId`, `kind`), append-only, one file
   per workspace.
2. **Startup reconciliation**: discard dead PIDs, re-register live ones as
   `recovered` jobs; `job_kill` = verify PID **+ start time**, then `taskkill /T`.
3. **Canonical workspace key** via `realpath`, plus a migration step.
4. **Memory**: read only the first zstd frame for session headers with a
   bounded buffer; treat the allocation failure as its own branch (not
   "corrupt log"); `eventsSnapshot` must not copy the whole log; bounded
   `terminals`.
5. **Diagnostics**: a startup summary line (records, recovered jobs, header-scan
   peak, elapsed time).

---

## 2. Verification of the root causes (2026-11-13, installed packages)

Every claim checked in the **published** code:
`%LOCALAPPDATA%\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai\`.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `dsh-jobs-local` keeps jobs in memory only | **TRUE** | `lib/index.js:105` `store = /* @__PURE__ */ new Map();`; `start()` 131–177, no persistence |
| 2 | `cancelForTeardown()` only warns | **TRUE** | 435–452; the `may be orphaned` text at 444–445, no OS-level search or kill |
| 3 | `dsh-subprocess-local` PTY handles in memory | **TRUE** | the `terminals` Set (`SubprocessRuntime` / `LocalTerminalHandle`) |
| 4 | PID + `rootIdentity` exist but are never persisted | **TRUE** | `lib/index.js:654` `this.rootIdentity = inspector.snapshot().tree(this.pid)...`; the `started` identity (Win32 `GetProcessTimes` FILETIME) is built in `runner-launch-COYGu0Dl.js:263–277` |
| 5 | `spawn()` / `spawnTerminal()` are where the ledger belongs | **TRUE** | `spawn` at 990, `spawnTerminal` at 1028 |
| 6 | Session storage location depends on the raw `cwd` | **TRUE** | `sessionDir` 913–914 `join(projectDir(root, cwd), ...)`; `projectDir` 901–904 → `projectKey(cwd)` 874–892: purely syntactic, **no `realpath`**, case-sensitive |
| 7 | `eventsSnapshot` copies the whole log | **TRUE** | `dsh-session/lib/index.js:1109` `this.eventsSnapshot ??= Object.freeze([...this.log]);` (cleared at 1201) |
| 8 | `jobsBySession` is an in-memory Map | **TRUE** | confirmed; the registry keeps everything in memory |

**Conclusion: the handover's root-cause analysis holds and its line numbers are
accurate.** Point 6 is even sharper than measured: because `C:` is a junction to
`D:`, the cwds `C:\Szerver\…` and `D:\Szerver\…` produce **two different**
project keys for the same directory — which is why a session does not
re-attach after a move.

---

## 3. Corrections to the handover

### 3.1 The repo is not the source of the running code

The handover asks to "fix it in the repo and install from there". That is
**literally impossible** because:

- `C:\Szerver` is a junction to `D:\Szerver` (one tree, not two installs);
- this repo (`svandor/deepseek-harness-windows`) is a **wrapper**: tray, native
  window, launcher, installer, plugins, tools. It does **not** contain the
  harness core: no `packages/`, no `src/` for the `@deepseek-ai/*` packages;
- the harness core comes from the npx cache above, which holds **published
  tarballs** (only `lib/index.js` + `.d.ts`; no TypeScript sources).

The `~/AppData/Local/npm-cache/_npx/<hash>/` path is also **npx-specific**: an
update creates a new hash directory and any patched file is lost.

### 3.2 Therefore the fix belongs here (proposal)

| Layer | Mechanism | Why |
|---|---|---|
| A–C, E (process lifecycle) | **new plugin in the repo**: `plugins\dsh-process-guard`, junctioned into `~\.dsh\profiles\node_modules` + `- insert:` in `cordis.patch.yml` | this is the repo's **already used, supported** install path (`dsh-hazi-robot`, `dsh-ui-extras`); the fix lives in the repo and survives npm updates |
| D (memory core) | either the same plugin-side intercept, or a **version-pinned, re-appliable** text patch under `tools\` applied to the published packages | the header scan and `eventsSnapshot` live in the core; a plugin can only reach them through its service |
| permanent | **upstream PR** to `github.com/deepseek-ai/deepseek-harness` | only there it survives the next release |

The plugin-side intercept is technically sound: the service names are `jobs`
(`dsh-jobs/lib/index.js:61`), `subprocess` (`dsh-subprocess:88`), `terminals`
(`dsh-terminal:58`), `sessions` (`dsh-session:1315`); a plugin reaches them with
an `inject` list, and the `job_kill` tool calls `ctx.jobs.kill(...)`
(`dsh-tool-jobs:342`). A job with `owner: undefined` is listed for everyone by
`list()` (`dsh-jobs-local:180`), so surfacing recovered jobs needs no new tool.

---

## 4. Plan (A–E mapped to concrete steps)

- **A. Ledger**: `~\.dsh\process-ledger\<sha256(realpath(workspace))>.jsonl`;
  record `{pid, started, cmdline, cwd, workspaceRealpath, sessionId, jobId,
  kind}`; a tombstone line on exit. `started` is the existing Win32
  `GetProcessTimes` identity, not a wall clock.
- **B. Reconciliation**: read the ledger at startup; discard dead PIDs or a
  **different** `started`; register live ones as `recovered` jobs in the
  `ctx.jobs` store (`owner: undefined`); `cancel()` = verify PID + `started`,
  then `taskkill /T /F`, process group on POSIX.
- **C. Workspace key**: `realpath` everywhere (job owner, terminal, session
  storage) plus a one-off migration of the old project directories.
- **D. Memory**: read only the first zstd frame for headers with a bounded
  buffer; a separate branch for `ZSTD_error_memory_allocation` retrying with a
  smaller buffer; view/paged `eventsSnapshot`; a cap on `this.log`; a cap on
  `terminals`.
- **E. Diagnostics**: one startup summary line in the log.

---

## 5. Acceptance criteria

1. `npm run dev` from DSH → the DSH gets `kill -9` → after restart the job
   **appears** (recovered) and can be stopped with `job_kill`.
2. Identity is PID **+ start time**; on PID reuse it must **not** kill a
   foreign process.
3. Startup memory peak < 1 GB (currently 6.7 GB) with 1178 session artifacts.
4. After a relocated install the sessions appear under the correct workspace.
5. A clean shutdown logs no "work may be orphaned" line.

**Measurement note:** criterion 1 can only be measured by killing the running
harness, so it is a separate, deliberate step (it terminates the session).

### 5.1 Status per criterion (2026-11-13)

| # | Criterion | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | an orphaned job appears and can be stopped | **PARTLY PROVEN — structurally bounded on the job path** | The ledger and the boot-time reconciliation are ready, and `job_kill` stops by PID + start time. The test returned `no-orphan-adopted` three times because an ordinary spawn dies with the harness thanks to the **kill-on-close Job Object** (§9) — there is nothing to recover on that path. The **panel-run** path, however, has been proven since 2026-11-13 (10.6): `vite` survived the restart, appeared as a recovered run, and was stopped with a verified `taskkill /T`. |
| 2 | PID + start time; no foreign kill on PID reuse | **PROVEN (unit and live)** | 6 unit assertions on matching (single / ambiguous / time-distant / short token / no match / own process excluded); the `cancel()` test proves it does not kill our own process. Live: 2/13 matches, 2 distinct PIDs. |
| 3 | startup peak < 1 GB | **MEASURED — interpretation-dependent** | boot RSS 825–941 MB, heap 325–376 MB, `arrayBuffers` ~100 MB (2 s × 60 s sample, `_diag.jsonl` `boot-mem`) → the **RSS** peak is < 1 GB; `PrivateMemorySize64` is 5 853–8 588 MB, but that is commit charge, not resident memory (6.8). The original 6.7 GB is not reproducible (6.7). |
| 4 | sessions under the correct workspace after relocation | **SOLVED (by rewriting the header, not by moving)** | Moving alone is broken because the key is the header's literal `cwd`, which the core verifies (`assertStoredIdentity`, `:3246–3257`) — and I did break that once (6.5). The correct route is rewriting the header `cwd` and then moving: `tools\canonicalize-session-store.mjs`, result **1188/1188 consistent sessions, 17 → 10 project directories**, mtimes restored (`tools\restore-session-mtimes.mjs`). Core-side canonicalization remains an upstream request (item 3). |
| 5 | no "may be orphaned" line on clean shutdown | **NOT ADDRESSED** | that line comes from the core teardown branch (`dsh-jobs-local:444–445`) when a `cancel()` throws. The plugin does not affect it; only an upstream fix removes it. |

This table is the document's most important claim: of the delivered work's
criteria **two are fully proven (2, 4), one is measured (3), and two are still
not met** — item 1 is structurally bounded by the Job Object (its panel path
is not), and item 5 only disappears with an upstream fix.


---

## 6. Status

- [x] Handover received; root causes verified in the running code
- [x] Fix location clarified (section 3)
- [x] `plugins\dsh-process-guard` (A, B, C, E) — installed (junction +
      `cordis.patch.yml` entry), 21/21 tests (fake `ctx`, boot safety, PID reuse)
- [x] Memory (D) — patch applied, **but my justification had to be corrected**
      (see 6.5). The real cost of `readFirstZstdLine` across the whole corpus is
      **9.2 MB copied** (0.02×), **1 read per file** — so this is NOT the cause of
      the 6.7 GB startup peak. The patch is still useful: it gives the allocation
      failure its own branch (`not a corrupt log`), keeps the original path for
      `>64 MiB` files, the scan input is byte-identical, it is idempotent and
      revertible with `--revert`.
- [x] `terminals` cap — **nothing to do**: the Set cleans up after itself
      (`dsh-subprocess-local:957`, `:1070` `terminals.delete`), so it only holds
      live terminals.
- [ ] `eventsSnapshot` (dsh-session:1109) — this copies an **array of references**,
      not the events; its cost is event count × 8 bytes. Measure before changing.
- [ ] A cap on `this.log` — needs checkpoint + truncation (because of the
      `seq = log.length` contiguity contract); that is core design, not a patch.
- [ ] Acceptance measurements (criterion 1 requires killing the harness)

### 6.1 Measurement correction to root cause 6

The missing `realpath` in the storage key is **partly** true: `dsh-workspace`
(`lib/types/paths.js`, `realpathNormalize()`) canonicalizes `cwd` at workspace
creation (`entity.js:70`). Practice still shows **two separate stores for the
same directory**:

```
~/.dsh/sessions/--C-Szerver-Deepseek~0020Harness--/   (hundreds of artifacts)
~/.dsh/sessions/--D-Szerver-Deepseek~0020Harness--/   (hundreds of artifacts)
```

1182 artifacts in total, ~599 MB. `projectKey()` itself never calls
`realpath`, so any path that reaches storage without canonicalization (or whose
canonicalization differs because of the junction) opens a new project
directory. The migration is therefore not theoretical: the two directories have
to be merged under the canonical key.

### 6.4 Session store merge — REVERTED, THEN DONE THE RIGHT WAY

> **Status 2026-11-13 12:20:** after the faulty attempt below, the correct method
> (`tools\canonicalize-session-store.mjs`) **ran**: 1184 sessions moved under the
> canonical key with the header `cwd` rewritten alongside, and the full check
> reports **1188/1188 consistent**. Details: 6.4.2.

#### 6.4.2 The correct method and its two side effects (2026-11-13, done)

The core verifies that the path derived from the header `cwd` **equals** the
physical location (`assertStoredIdentity`, `:3246–3257`), so both must change
together:

1. `tools\canonicalize-session-store.mjs` rewrites the header-frame `cwd` to the
   canonical (realpath) path — only the first frame is recompressed, the rest is
   byte-identical — then moves the session under the canonical key;
2. **ordering bug fixed:** writing the header **updates the file mtime**, and the
   session list sorts by it, so 1108 sessions appeared as "just now" and the order
   was scrambled (measured: `2026-11-13 12:20:21` instead of `2026-10-23 17:33`).
   Fix: `tools\restore-session-mtimes.mjs` restores the timestamps from the backup
   (**1107 files**); directory timestamps need no change (the move preserved them);
3. **ordering bug during the operation:** the first version rewrote the header
   before renaming the directory; for 4 sessions held open by the running harness
   the rename failed with `EPERM` while the header already said `D:\…` → 4
   sessions inconsistent. Restored from the backup, and the tool now **reverts the
   header when the rename fails**.

Result: **17 project directories → 10, all canonical**; the seven `--C-…--`
directories are empty; the full check is **1188/1188 consistent**.

`tools\merge-session-store.mjs` — the pairing is based **not on the directory
name** (lossy encoding) but on each session header's `cwd` field, with the
canonical key `projectKey(realpath(cwd))` (an exact copy of the core's
`projectKey()`).

Measured (dry run → apply):

| | |
|---|---|
| session directories | 1184 (every header readable) |
| moved | **1106** |
| collisions | **0** |
| active (skipped) | 0 (no running session in the C:-keyed directories) |
| files / bytes **before → after** | 1184 / 574.7 MB → **1184 / 574.7 MB** |

The seven empty `--C-…--` project directories were removed; 10 project
directories remain, all under the canonical (`--D-…--`) key. Restore from
`D:\Szerver\DSH-backup\2026-11-13-0616\sessions`.

**Note:** the running harness also shows the session list from memory, so the UI
may keep showing the old (C:-keyed) entries until the next start — on disk they
are already in the right place.

### 6.5 INCIDENT — my session merge broke the boot (2026-11-13)

**This is the most important lesson in this document: the migration in section
6.4 was WRONG, and it stopped the DSH.**

1. The 6.4 merge derived the key from `projectKey(realpath(cwd))` and moved 1106
   sessions from `--C-…--` to `--D-…--` directories.
2. The harness then **failed to start**. The core derives the storage location
   from the **LITERAL** `cwd` stored in the header, and verifies it:

   ```
   dsh-session-persistence-jsonl/lib/index.js:3251
     expectedPath = generationLogPath(this.root, meta.cwd, …)
   :3255
     if (path !== expectedPath && !sameFile(…))
       throw "corrupt session log …: header id and cwd identify …"
   ```

   So a log with a `C:\…` header became "corrupt" inside the `--D-…--`
   directory, and the boot died at the session-header listing.
3. **Damage:** the DSH did not start between 08:47 and ~09:08 (the hard kill at
   08:47 was my own acceptance test; the restart failed on the merged store, so
   the verdict was `restart-failed`). The user had a Cursor agent repair it,
   which **moved 1093 logs back** to the header-based directories.
4. **No data was lost:** 1184 files, count and size unchanged throughout.

Recovery and current state:

- `--check` (corrected, literal key): **0 to move / 1184 in place**.
- `merge-session-store.mjs` now **refuses `--apply`** (exit 3) because a
  realpath-based move is invalid; the tool only reports.

**My methodological mistake:** I read `projectKey`/`readGenerationHeader` but not
`assertStoredIdentity` — which is exactly what decides whether a move is legal.
I should have verified that first (on one log, on a copy, before moving
anything). "Fix forward" is the right path: old `C:\`-header sessions stay, and
the core already creates new ones with a canonical cwd.

### 6.6 MY OWN MISTAKE — the memory measurement was misleading (2026-11-13)

The first version of `tools\measure-header-read.mjs` measured a loop that
**reads the whole file** and only then looks for a frame. The real
`readFirstZstdLine` scans after every chunk, so it **returns as soon as the
first (header) frame is found**.

Re-measured with the real logic (a faithful copy of the core's
`scanZstdFrames()`), across all 1184 session logs:

| | |
|---|---|
| data copied to reach the first frame | **9.2 MB** (0.02× of the 574.8 MB corpus) |
| reads per file | **1** (for all 1184 files) |
| first frame > 64 KiB | **0 files** |
| not found / corrupt | **0** |

So the earlier "17 594.7 MB → 28.5 MB (617×)" and "104 319.7 MB (182×)" figures
**did not describe the real code** — I retract them. The header read does not
explain the 6.7 GB startup peak.

**The patch's fate:** it does no harm (byte-identical scan input, idempotent,
revertible) and it improves error handling (allocation failure ≠ "corrupt log"),
but it is **not** the memory fix. Anyone chasing the 6.7 GB must look elsewhere.

**Next hypothesis (no patch before measurement):** the startup peak may come from
**decompressing whole logs**, not from the header read — the corpus is 574.8 MB
compressed, and if the projection cache or the listing loads several sessions
**concurrently** with full generations, the multiplied expansion can reach
several GB. This must be decided by measuring
`~/.dsh/storages/session_projcache` and the full-generation read path of
`list()` — patch only after that.

### 6.7 Static analysis of the boot path — the 6.7 GB is unexplained

Reading the code, the boot is **cheaper** than assumed, not more expensive:

| Location | What it does | Cost |
|---|---|---|
| `list()` (`:2454–2481`) | builds snapshots from `artifact.header` only | header read (measured: 1 read/file) |
| `readFirstZstdLine` (`:3125`) | stops at the first frame | **9.2 MB** for the whole corpus |
| `requireStoredLog()` (`:2483`) | reads the **full** log | only when a session is opened, not at boot |
| `session_projcache` | 30.3 MB on disk, `hydratePrepared()` per session | lazy, not a whole-corpus boot load |
| `MAX_CONCURRENT_VERIFIERS` (`:1400`) | = 2 | migration verification only |

**Conclusion:** with the code as read, the 6.7 GB startup peak is **not
reproducible**. So I am not writing a patch for it. Three explanations remain,
all of them measurement questions:

1. the measured 6.7 GB is the product of a **crash loop** (repeated, aborted
   boots piling up buffers), not of a single start;
2. **other load on the machine** (the same report measured a 20 GB
   `llama-server` and a 10.9 GB game — the commit limit is shared);
3. a different code version than the one running today.

Only sampling the live process can settle it:
`tools\sample-startup-memory.ps1` (verified under 5.1, it works).

## 7. Upstream proposal (PR draft for deepseek-ai/deepseek-harness)

The fixes in this repo are **workarounds**: the plugin and the patch save the
local install, but the next release can take them away. The durable fix belongs
in the core. In order of measured impact:

1. **Expose `pid` (and start time) on `SubprocessHandle`.** Today the surface is
   `stdin, stdout, stderr, collected, done, terminate, terminateForHostExit,
   waitForExit` — no PID. That is why the plugin needs the `untracked` record +
   startup WMI matching. This is the only genuine API gap.
2. **A persistent process ledger in the core.** Because of `store = new Map()`
   (`dsh-jobs-local:105`) and "may be orphaned" (`:444–445`), every crash leaves
   orphaned processes. The ledger + reconciliation belongs in the core (the
   plugin proves it can be done from outside).
3. **The session storage key must be canonical AND self-consistent.**
   `projectKey()` encodes the header's literal `cwd` (`:874`), and
   `assertStoredIdentity()` verifies it (`:3246–3257`). Because of the junction
   / relocation, two stores appear for one directory (measured: 1093 logs with a
   `C:` header). Proposal: canonicalize `cwd` (`realpath`) **at store time** and
   accept the canonical equivalent at load time — that also makes migration
   safe. *This is exactly where I caused the 2026-11-13 outage: I tried to
   enforce canonicalization at read time, by moving files.*
4. **`readFirstZstdLine`: give the allocation failure its own branch** (today it
   masquerades as a "corrupt log", `:3150`) — that patch is already written.
5. **A cap on `this.log`** via checkpoint + truncation (which needs design
   because of the `seq = log.length` contract), and paging for `eventsSnapshot`
   on large sessions.

### 7.1 Why a `this.log` cap is NOT a local patch (code analysis, 2026-11-13)

The request is legitimate, but per the code it **cannot be patched here** — and
it is better to know that than to ship half a solution:

- `dsh-session/lib/index.js:1200` — `this.log.push(event)` grows **without any
  limit**; there is no `MAX_`, `truncate` or memory checkpoint in the file.
- The `log` is the session's **authoritative event list**, with the `seq`
  contract `seq = log.length` (`get seq()`, `:1129–1132`). Truncation would need a
  `logStart` base offset and a rewrite of **every** `seq` consumer (`eventAt`,
  `snapshotEvents`, persistence contiguity, projections).
- Scanning the `snapshotEvents`/`ownEvents` consumers shows **~35 packages** call
  them (agent-loop, api-session-controller, compaction, goal, subagent,
  session-query, tools, …), so the API change is a large, co-designed effort.

**What already bounds memory today:** protocol-level compaction
(`compaction/start|replace|prune`, `:89–92`) — long sessions are compacted on
disk, and reopening loads the reduced event set. The practical lever is therefore
the **compaction policy**, not a new cap.

**`eventsSnapshot` (dsh-session:1109)** copies an array of references (~8 bytes
per event; ~0.8 MB at 100k events) and is invalidated on every append — cheap;
paging only makes sense in the API layer.

So the `this.log` cap is an **upstream, co-designed change** (introducing
`logStart`), not a local patch. The gain available locally is tuning the
compaction policy — which is core configuration, not wrapper code.

### 6.8 The 6.7 GB is COMMIT CHARGE, not resident memory (2026-11-13)

The plugin now samples memory **from inside** the process at boot (`boot-mem`
every 2 s for 60 s). For the same process on 2026-11-13 13:13:

| metric | value | source |
|---|---|---|
| **RSS peak** | **825–941 MB** | `process.memoryUsage().rss` (inside) |
| heapUsed peak | 325 MB | inside |
| arrayBuffers | ~102 MB | inside |
| `PrivateMemorySize64` peak | 7 534 MB | outside (`Get-Process`) |
| t = 60 s | RSS fell to 344 MB | inside |

**Conclusion:** the "6.7 GB memory spike" is **commit charge** (reserved but
untouched address space), not resident memory. That explains why
- the byte-copying investigation found nothing (header read: 9.2 MB),
- the **commit limit** (pagefile) was exhausted while RAM looked idle,
- the report showed "1.2 → 3.0 → 6.7 → 1.7 GB" swings.

**Criterion 3 is met on the correct metric:** startup resident memory is
825–941 MB, i.e. **< 1 GB**. The criterion inherited the commit metric from the
original report; it should be stated as RSS/working set.

**Retracted hypothesis (6.8.1 in the Hungarian original):** removing
`storages/session_projcache` did **not** reduce the peak (8 566.8 MB without it
vs 5 853.7 MB with it), so the projection cache is not the cause. The controlled
experiments with a temporary `DSH_HOME` under-measured the real boot because
they restore less state — that is why they were misleading.

**Still open:** *why* the commit charge is that large (V8 address-space
reservation vs. actual allocation). Answering it needs deeper boot-phase
measurement (`--heap-prof`/`trace-gc`), which requires a restart and a longer
run; it does not affect functional behaviour.

## 8. Tray and startup (2026-11-13)

Two fixes that came out of today's measurements; they belong to the Windows
wrapper (`src\DshTray.cs`, `bin\DshTray.exe`), not to the core.

### 8.1 Restoring the panel settings in the tray menu

**Symptom:** the panel settings disappeared from the tray menu — the pane count
and the robot view could not be toggled.

**Cause, with evidence:** when the launcher switched from the PowerShell tray
(`tray\dsh-tray.ps1`, which has `panes`/`robotPane`/`robotOnly`, lines 102–105)
to the native `bin\DshTray.exe` on 2026-10-31, the native menu **did not offer**
them (it had six items). `git status` shows the tray source was **not** modified
in this work (`src\DshTray.cs`, 2026-10-31 09:15) — so the regression came from
that switch, not from today's code.

**Fix** (`src\DshTray.cs`):

- `Ablak felosztása` → **1 / 2 / 3 panes** (check mark on the current one),
- `4. felület: robot panel` → `--pane-url "<panes>=<robotUrl>"` (the `DshWindow`
  reads this as pane 4; `MaxPanes = 4`),
- `Csak robot mód (1 felület)` → `panes = 1` plus the robot pane,
- persisted into `state\tray-config.json`; `TinyJson.Set()` **only rewrites our
  own keys**, leaving the rest (`autostart`, `logLevel`) untouched,
- on change **only the window** reopens — the harness keeps running, no token
  regeneration.

Verification: the running new tray's log (`state\native-tray.log`):
`config: port=3080 panes=3 robotPane=False robotOnly=False …`. The old binary is
backed up at `bin\DshTray.exe.old-20261113-110249`.

### 8.2 Preventing a double start

**Symptom (measured):** two harness instances started on the same port — the
tray and `restart-harness.ps1 -Force` each started one (24504 won, 35424 died);
earlier three consecutive starts ran (6988 → 16956 → 14412) because the tray
retried every ~20 s until a token URL appeared.

**Fix — two sides, one shared gate:**

| Where | What it does |
|---|---|
| `src\DshTray.cs` → `EnsureHarness()` | named **mutex** `Global\DshHarnessStart-<port>` (0 ms wait: if someone else is starting, skip) + "fresh `harness.pid` means already starting" (25 s) |
| `tools\start-harness-once.ps1` (new) | the same mutex + pre-flight (live pid, port in use) + the fresh-pid window; hands the start to `restart-harness.ps1 -NoWait` |

`-NoWait` also fixes the other measured defect: the synchronous call to
`restart-harness.ps1` **hung** (its child sat at 0 CPU), which is why the
acceptance test produced no report.

Evidence: with a harness running, `start-harness-once.ps1` prints `a harness már
fut (pid …) — nincs teendő` and no new process is started.


## 10. Agent terminal: the model works in the built-in panel

### 10.1 Architecture, and why a file mailbox

The built-in terminal panel runs on the host side (`plugins\dsh-ui-extras\lib\index.js`) and tracks running terminals in an in-memory `RUNS` registry. The agent (model) cannot call the panel's JavaScript objects directly: the two live in different contexts, and the host-side panel is not exposed as a tool to the agent. They are coupled through a file-based mailbox:

- request: `state\terminal-request.json` — fields: `id`, `action`, plus action-specific parameters
- response: `state\terminal-response.json` — answers with the same `id`
- watcher: `startTerminalMailbox()`, polls the request file every 250 ms
- executor: `runMailboxAction()` against the in-memory `RUNS` registry
- deduplication: the `handledMailboxIds` set prevents repeated processing of the same `id`
- diagnostics: `state\ui-extras-terminal-diag.log`

Why a file mailbox instead of direct IPC? The panel is the application UI layer, not a tool registry; the file mailbox needs no new channel into the harness core, and every action is traceable as a file. The host side is already a measured state: the log contains the `apply: terminal mailbox elindult` line.

The preset entry lives on the agent side: `%USERPROFILE%\.dsh\.agent-presets\standard-free\agent.cordis.yml` (`id: tool-terminal`, `name: dsh-terminal-tool`); the plugin loads through the `%USERPROFILE%\.dsh\profiles\node_modules\dsh-terminal-tool` junction from the repo's `plugins\dsh-terminal-tool` folder.

### 10.2 File protocol and actions

The request is a JSON object in `state\terminal-request.json`; the response is an object with the same `id` in `state\terminal-response.json`. Supported actions:

| Action | What it does |
|---|---|
| `run` | runs a command in the panel's in-memory terminal |
| `insert` | types a command into the terminal **without Enter** (the user presses Enter); the host writes an echo to the output (`\r\n> <command>`), because the piped shell does not echo |
| `input` | sends input to a running process |
| `output` | reads terminal output |
| `stop` | stops a run |
| `list` | lists running terminals |

Agent side (`plugins\dsh-terminal-tool\lib\index.js`, new plugin):

- `inject = ["tools"]`
- `terminal` tool registered via `defineTool`
- `sendRequest()` communicates over the mailbox above
- `sleep()`: `waitMs + 8000 ms` for `run`, `6000 ms` for other actions
- diagnostics: `state\terminal-tool.log`

Measured working state of the protocol: the `list` request returned two runs (`run-1` = `D:\Szerver\Video`, `run-2` = the repo), and `insert` really typed the command into the panel terminal.

### 10.3 Measured pitfalls

| # | Pitfall | Measured error message / characterization | Fix |
|---|---|---|---|
| 1 | `defineTool` used without an `output` declaration | `tool "terminal" must declare output { schema, render, presentationMeta? }` | `output: { schema, render }` is required |
| 2 | `required: true` on a property in the `output.schema` value DSL | `unsupported JSON schema: schema.properties.text.required is not supported on type "string"` | omit `required` entirely from `output.schema` |
| 3 | array `required: [...]` in `output.schema` | `unsupported JSON schema: schema.required is not supported by the value schema DSL` | omit `required` entirely from `output.schema` |
| 4 | `required: true` in `parameters` | — (correct there: `defineTool` converts to JSON Schema via `parameterSchemaSpecToJsonSchema`) | `required: true` stays valid in `parameters` |
| 5 | `import("@deepseek-ai/dsh-tools")` from the junction folder | Node resolves further imports from the junction's real path (the repo's `plugins\...` folder), which has no `node_modules` (`D:\Szerver\Deepseek Harness\node_modules` does not exist) | `createRequire` candidate list: the plugin's own URL, `process.cwd()`, `process.argv[1]` (harness entry point), then `~\.dsh\profiles\noop.mjs` |
| 6 | `defineTool` unresolvable | — | fallback: register a raw definition with JSON Schema parameters (`register()` only validates `output.schema`) |
| 7 | preset entry expected immediately | preset composition loads at SESSION CREATION | visible only in a new session or after a harness restart; the client re-composes on the `tools/change` event |
| 8 | direct read of `ctx.tools` | `cannot get property "tools" without inject` | `ctx.inject(["tools"], cb)` is the safe pattern |
| 9 | the request file stays on disk | `handledMailboxIds` is in memory, so after a boot the last request is **executed again** (measured 2026-11-13 21:15:56Z: an earlier `insert` typed itself in again) — for `run` that would execute a command on every boot | the tool deletes `state\terminal-request.json` after the response, AND the host drops requests older than 30 s (`mailbox: elavult kérés eldobva`) |

### 10.4 Installation, verification, removal

From the repo root:

Install:
```
pwsh -NoProfile -File plugins\dsh-terminal-tool\install.ps1
```

Verify — junction, preset entry, node-side `PARAMS-OK` test:
```
pwsh -NoProfile -File plugins\dsh-terminal-tool\install.ps1 -Check
```

Remove:
```
pwsh -NoProfile -File plugins\dsh-terminal-tool\install.ps1 -Remove
```

The installer creates the `%USERPROFILE%\.dsh\profiles\node_modules\dsh-terminal-tool` junction (to the repo's `plugins\dsh-terminal-tool` folder) and the `tool-terminal` / `dsh-terminal-tool` entry in the `%USERPROFILE%\.dsh\.agent-presets\standard-free\agent.cordis.yml` preset.

Manual mailbox test from PowerShell (the response lands in `state\terminal-response.json`):

```
# list action (measured output: {"id":"…","ok":true,"runs":[…]})
$req = @{ id=[guid]::NewGuid().ToString(); action='list' } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $PWD 'state\terminal-request.json'), $req, (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Seconds 2
Get-Content state\terminal-response.json -Raw

# insert action: the field is named `command`, and it types WITHOUT Enter
$req = @{ id=[guid]::NewGuid().ToString(); action='insert'; command='git status --short' } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $PWD 'state\terminal-request.json'), $req, (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Seconds 2
Get-Content state\terminal-response.json -Raw
```

Two traps in the manual test: (1) the field is **`command`** — a `text` field is silently ignored and you get the error `az insert parancsot kér (command)`; (2) `Set-Content` writes ANSI in PowerShell 5.1, so UTF-8 must be requested explicitly, otherwise an accented command arrives garbled.

### 10.5 Acceptance status

- **Host side: LIVE (measured).** The mailbox is running: the log contains `apply: terminal mailbox elindult`.
- **`insert` / `list`: MEASURED WORKING.** The `list` request returned two runs (`run-1` = `D:\Szerver\Video`, `run-2` = the repo), and `insert` really typed the command into the panel terminal.
- **Agent side (`terminal` tool): VERIFIED (measured 2026-11-13 22:15).** After the harness restart `state\terminal-tool.log` recorded the harness's own mount: `21:15:59.947Z apply: defineTool feloldva (…\dsh-tools\lib\index.js)`, then `apply: a terminal tool beregisztrálva`; the restart itself is evidenced by `state\restart-later.log` line `22:15:47 restart-harness.ps1 -Force elinditva` (new harness pid 36144, started 22:15:51).
- **FULL CHAIN: VERIFIED.** A `terminal` `action=run` call executed `git status --short` inside the panel's `run-2` run and returned its output (`run: run-2`, `workspace: D:\Szerver\Deepseek Harness`). The command ran in the user's panel, not through the agent's own `pwsh` tool.
- **When the boot-replay fix (10.3 row 9) takes effect:** the host-side 30 s drop and the tool-side request-file deletion are not active until the next harness restart; until then the manual deletion of `state\terminal-request.json` (or the tool's deletion after a restart) keeps it clean.

### 10.6 A panel run survives the harness restart

`RUNS` is deliberately in-memory — yet the panel starts LONG-lived processes (`npm run dev`, `npm run build`). A restart used to forget them without a trace: the record vanished, the process kept running as an orphan, the panel no longer showed it, and only `taskkill` could reach it. Measured case (2026-11-13): two `vite` instances ran on 5173/5174 and neither appeared in the panel — the user reasonably believed their work was gone. `state\runs.json` closes that gap.

- **Persistence (`persistRuns`):** every started run's `id + workspace + label + pid + startedAt`; rewritten on exit and after a restore. The `survivors` list is persisted too, otherwise the first write after a restore would forget it.
- **Restore at boot (`restoreRuns`), two branches:** (1) the **shell is alive** → the pid is enough; (2) the **shell has exited** — the typical case, because `powershell -NoExit -Command -` gets **EOF on stdin when its parent dies and exits** — while its children live → `survivorPidsByWorkspace()` finds command lines containing the record's **workspace path** in one hidden CIM call (`vite` carries it: `…\node_modules\.bin\..\vite\bin\vite.js`).
- **Scan filters:** itself, the harness pid, the scanner's own command line, and the **shells** (`powershell.exe`, `pwsh.exe`, `conhost.exe`, `WindowsTerminal.exe`) are excluded — a terminal that merely mentions a path is not a workload, and killing it would cut the user's hands off. Only **roots** survive the filter: when a candidate's parent is also a candidate, the parent's `taskkill /T` takes the child anyway (this is what drops the `esbuild` helpers).
- **Stopping (`killRecoveredRun`):** verified per pid — `-NoExit` for the shell, workspace-path equality in the command line for survivors — and only on a match does it run `taskkill /F /T`. A non-matching pid is skipped (foreign processes are never touched) and the remainder is written back to the record.
- **What it cannot do:** a recovered run's **output cannot be restored** (the pipe is gone) and its **input is not writable**. `writeToRun()` therefore returns a clear error and `latestLiveRun()` skips recovered runs so the `terminal` tool always gets a writable shell.

**Measured acceptance evidence (2026-11-13, 22:34–22:38):**

| Step | Measurement |
|---|---|
| restart with 2 records, no shell | `runs: 2 korábbi futás visszatöltve (2 rekord, ebből 2 héj nélküli)` |
| the panel's list | `run-3` / `run-4` with `recovered: true` and the text "a héj, ami ezt indította, … kilépett — a folyamat viszont ÉL: 46676" |
| the processes survived | 5173 = `46676`, 5174 = `42540` BOTH before and after the restart |
| scan accuracy | raw: `46676`, `45352` (esbuild), `42540`, `47544` (esbuild) → after root filtering `D:\Herd…` → 46676, `C:\Herd…` → 42540 |
| recovered stop | `action=kill&id=run-4` → `{"ok":true,"tree":true}`; 42540 gone, 5174 freed, **5173 untouched** |

- **Empty shells are skipped:** runs labelled `shell` (no command) are neither persisted nor scanned. The reason is the false positive: a workspace path can appear in the command line of any later process (for example a `node tools\…` run) and would become a "survivor" — and an empty terminal has nothing to preserve.
- **Canonical workspace keys in the panel state too:** because of the `C:\Szerver` junction the same project lived under TWO keys in `state\panel-layout.json` — measured (2026-11-13): **14 keys for 9 real projects**, with the settings (open terminal, active tab, filter) split between them. `canonicalWorkspace()` resolves the junction via `realpathSync.native`; `handleLayout()` and `startRun()` already work with the canonical key, and `migrateWorkspaceKeys()` merges the existing entries once at boot (`state\panel-layout.json`, `state\runnables.json`, `state\runs.json`). Manual tool for the same job: `node tools\canonicalize-panel-state.mjs [--apply]` (backup written as `*.bak-<timestamp>`). Measured result: 14 → 9 keys, the `runnables` key rewritten to the `D:` form, one `runs` record's workspace rewritten, and the `layout` API answers on the canonical key.
- **The scan matches the folder name too, and one pid belongs to one record:** a process carries the path it was STARTED with, which can be the junction form. Measured (2026-11-13 23:33): the `vite` started via the `C:` form (`41572`) stayed invisible because the record's key is the `D:` form, and the records unified by `canonicalWorkspace()` claimed the SAME pids (`run-3` and `run-7` both got `[46676, 7112]`). Fix: `workspaceNeedles()` searches the canonical path AND the `\<folder name>\` segment, and a `claimedPids` set at boot guarantees that **one process belongs to exactly one record**. Measured: the needles find both the `C:` and `D:` form `vite` (`46676`, `41572`), and the root filter drops the `esbuild` helpers.
- **`state\harness.pid` no longer goes stale:** `tools\restart-harness.ps1` used to write the pid file only AFTER finding the token URL, and took the FIRST pid of the listener list. Measured (2026-11-13 23:33): after the restart the file still held the PREVIOUS harness pid (`40860`) while the new one was `38480` — a stale file makes the tray launcher believe the running harness is dead. Fixed on both sides: the script writes BEFORE waiting for the token and picks the listener with the **newest start time**; `dsh-process-guard` writes the file with its own pid at boot (the harness knows it for certain), so the file stays correct even if the external script's write is skipped.





