# Upstream issue — process lifecycle, session storage key, memory metric

> Magyar változat: [`DSH-UPSTREAM-ISSUE.md`](DSH-UPSTREAM-ISSUE.md)

This file is a **ready-to-paste issue** for
`github.com/deepseek-ai/deepseek-harness`. Every statement comes from
measurements on this machine against the published packages (`0.1.5-rc.3`), and
the line numbers refer to the `lib/index.js` files.

---

## 1. `SubprocessHandle` exposes no PID

The public surface is `stdin, stdout, stderr, collected, done, terminate,
terminateForHostExit, waitForExit` — **no `pid`**. Host-side code therefore
cannot identify, or later stop, a process started via `spawn()`;
`terminateForHostExit` covers a graceful exit only, and after a crash there is
nothing to point at.

**Request:** `readonly pid: number` (and optionally the start-time identity) on
`SubprocessHandle` — this is the only genuine API gap that forces an external
workaround.

## 2. Persistent process ledger and startup reconciliation

- `dsh-jobs-local/lib/index.js:105` — `store = new Map()`: the job registry is
  purely in memory.
- `dsh-jobs-local:435–452` — `cancelForTeardown()` only warns
  (`work may be orphaned`, `:444–445`); it never searches the OS for the process.

**Request:** job records that survive teardown, identified by PID and start
time, with a startup reconciliation pass. A reference implementation works from
outside as a plugin, but the right home is the core.

## 3. The session storage key is neither canonical nor equivalence-tolerant

- `dsh-session-persistence-jsonl/lib/index.js:874` — `projectKey(cwd)` encodes
  the header's **literal** `cwd` string.
- `:3246–3257` — `assertStoredIdentity()` compares the path derived from the
  header with the physical location and rejects a mismatch as
  "corrupt session log".

Consequence: **multiple stores** appear for one directory whenever the path was
recorded in a different spelling (junction, relocation, letter case). Measured:
1093 logs with a `C:\…` header while the real directory lives on the `D:` volume;
the UI listed the same workspace two or three times.

**Request (both together):**
1. canonicalize `cwd` (`realpath`) **at store time**;
2. accept the canonical equivalent at load time (in the spirit of `sameFile`),
   so a relocation does not turn a log into "corrupt".

*Measurement note: a pure file move destroys the boot — a local experiment
confirmed it (the DSH would not start until the logs were moved back). That is
why the two steps are only safe together.*

## 4. The memory metric is misleading: commit charge ≠ resident memory

The startup "6.7 GB peak" is **`PrivateMemorySize64`** (commit charge), not
resident memory. For the same process, measured from inside
(`process.memoryUsage()`):

| metric | value |
|---|---|
| RSS peak | **825–941 MB** |
| heapUsed peak | 376 MB |
| arrayBuffers | ~100 MB |
| `PrivateMemorySize64` peak | **8 588 MB** |

This explains why the commit limit (pagefile) was exhausted while RAM looked
idle. **Request:** documented memory criteria should state the metric
(RSS/working set), because commit charge includes V8's address-space
reservation.

## 5. Concrete bug: an allocation failure masquerades as a "corrupt log"

`dsh-session-persistence-jsonl:3150` — every header-frame decode failure becomes
`corrupt Zstandard session log`, including `ZSTD_error_memory_allocation`. That
misleads the diagnosis (the real cause is memory pressure, not a damaged file).

**Request:** a separate branch for allocation failures (the patch already exists
in `tools/patch-harness.mjs` of the referencing repo).

## 6. Terminal containment

Ordinary `spawn()` processes are placed in a **kill-on-close Job Object**
(`dsh-win32-process`: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
`AssignProcessToJobObject`), so they die with the harness — that is good.
The **terminal (ConPTY)** path explicitly stays outside the Job
(`dsh-subprocess-local:1025`), so a long-running process started in a terminal
**survives** a crash (measured: a 1.6 GB dev server).

**Request:** contain the ConPTY process tree the same way, or expose the `pid`
plus a ledger (items 1–2) so it can at least be stopped.

## 7. `this.log` cap (design request)

`dsh-session:1200` — `this.log.push(event)` is unbounded; the `seq` contract is
`seq = log.length` (`:1129–1132`), so truncation requires a `logStart` base
offset and a review of every `seq` consumer (≈35 packages). That is why it is
not proposed as a local patch; protocol-level compaction
(`compaction/replace`) already bounds disk usage and the memory of a reopened
session.
