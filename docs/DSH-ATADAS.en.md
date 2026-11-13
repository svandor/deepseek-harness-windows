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
| 1 | an orphaned job appears and can be stopped | **NOT PROVEN** | the mechanism is ready (ledger + reconciliation + `job_kill`), but the end-to-end test returned `restart-failed`: after the hard kill the boot died on my broken session merge (6.5). It must be re-run on a clean store. |
| 2 | PID + start time; no foreign kill on PID reuse | **PROVEN (unit and live)** | 6 unit assertions on matching (single / ambiguous / time-distant / short token / no match / own process excluded); the `cancel()` test proves it does not kill our own process. Live: 2/13 matches, 2 distinct PIDs. |
| 3 | startup peak < 1 GB | **NOT MEASURED** | steady state is 811 MB; the boot peak has not been sampled yet (`tools\sample-startup-memory.ps1` is ready). The original 6.7 GB is **not reproducible** per the static analysis (6.7). |
| 4 | sessions under the correct workspace after relocation | **DESIGN ERROR — NOT MOVABLE** | the storage key is the literal header `cwd`, which the core verifies (`assertStoredIdentity`, `:3246–3257`). It cannot be fixed by moving; either the header `cwd` must be rewritten or the core must canonicalize at store time → upstream item 3. |
| 5 | no "may be orphaned" line on clean shutdown | **NOT ADDRESSED** | that line comes from the core teardown branch (`dsh-jobs-local:444–445`) when a `cancel()` throws. The plugin does not affect it; only an upstream fix removes it. |

This table is the document's most important statement: **none of the delivered
work is fully proven against its acceptance criteria**, and the partial results
do not paper over that.


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

### 6.4 Session store merge — REVERTED (2026-11-13)

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




