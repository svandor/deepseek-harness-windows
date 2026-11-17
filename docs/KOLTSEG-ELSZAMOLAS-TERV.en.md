# Development cost accounting — plan and proposals

English | [Magyar](KOLTSEG-ELSZAMOLAS-TERV.md)

Status: **IMPLEMENTED** (2026-11-16); the decisions are recorded in section 9,
the usage in [`KOLTSEG-ELSZAMOLAS.en.md`](KOLTSEG-ELSZAMOLAS.en.md)
Created: 2026-11-16
Related: `docs\FTP-DEPLOY-TERV.md` (plugin template), `docs\dsh-plugin-notes.md`
(slot rules), `AGENTS.md` §1 (no pop-up windows), §1.5 (restart discipline)

---

## 1. What was asked (restated)

A new feature in DSH, placed in a **floating window opened by an icon+tooltip
button in the menu bar**. The feature is development cost accounting:

| Requirement | Reading in this plan |
|---|---|
| base hourly rate 12 500 HUF | `defaultRate: 12500` HUF/hour, overridable per profile and per repo |
| overridable per repo in the UI | workspace-level override, saved from the UI |
| measure the concrete selected workflow | 1 session (conversation) and its turns |
| measure the whole workspace | every session of the workspace |
| date-range measurement too | `from`/`to`, Hungarian calendar days, inside the workspace |
| basis is the rate plus exactly which time we measure | 4 measured time components + weights in a profile |
| several versions + individually weighted settings | 4 preset profiles + one custom profile |
| server-side work time (local Ollama included) | `turn/start` → `turn/end` from the session log |
| background jobs (low relevance) | terminal runs + jobs, default weight 0–0.25 |
| reading + typing the next prompt (needs a proposal) | client-side activity measurement + log-based fallback |
| real time (not billable gross) | active calendar time, unioned, with an idle cap |

---

## 2. What I measured (real data, the basis of this plan)

My own measurement over the workspace's last 30 days (throwaway script written
to `%TEMP%`; the session logs are **multi-frame zstd**, so a frame walker is
required — the same one the plugin will use):

```
window: last 30 days | sessions (this workspace, root): 31
total gross (session lifetime):        484.44 h
total agent (turn/start -> turn/end):   26.78 h  = 6% of gross
turns: 351
human gaps (<=20 min):                  20.21 h / 264 cases, median 3.0 min, p90 12.9 min
long gaps (>20 min):                    99.14 h / 56 cases
```

**The conclusion that shapes the plan:** gross calendar time (484 h) is roughly
ten times the real work, because sessions stay open for days (measured example:
8.89 h lifetime with 0.67 h of agent work). Gross time is therefore **useless on
its own** — only unioned, idle-capped, and read together with the other
components. An average turn is ~4.6 minutes of agent work (26.78 h / 351
turns); the median human gap is 3 minutes.

Same window, per profile (12 500 HUF/hour, no rounding):

| Profile | Billable | Amount |
|---|---|---|
| agent + human (base) | 47.00 h | ≈ 587 500 HUF |
| agent only (machine time) | 26.78 h | ≈ 334 800 HUF |
| human only | 20.21 h | ≈ 252 700 HUF |
| agent × 0.5 + human | 33.60 h | ≈ 420 000 HUF |

Those four rows are exactly why profiles are needed: **the same month's invoice
ranges from 253k to 587k HUF** depending on what counts as billable. That must
not be hard-coded — it is the user's business decision.

---

## 3. Measurement model — four components with exact definitions

Every component has a **definition, data source, accuracy and exclusions.** The
accounting is computed from these; the weights live in a profile.

### 3.1 `agent` — server-side work time

- **Definition:** the time from the start of a turn until it stops, i.e.
  `turn/end.time − turn/start.time`. It covers prompt processing to turn
  closure, including LLM calls, tool calls (the `pwsh`/terminal runs among them)
  and waiting. The local Ollama falls into the same band, so it needs no special
  handling.
- **Data source:** the durable session log
  (`%USERPROFILE%\.dsh\sessions\<workspace>\<session-id>\session.v3.jsonl.zstd`).
  Every event is `{type, seq, time, data}` with `time` = Unix epoch ms. Turn
  boundaries: `turn/start`, `turn/end` (`data.reason.kind`).
- **Accuracy:** millisecond-precise, and retroactive (the log never changes).
- **Exclusions:** delegated (sub-agent) sessions write their own log file but
  are **already inside the parent's turn time** — so `delegationDepth > 0`
  sessions are NOT added to agent time (that would double count); they are shown
  in a separate informational row only.
- **Open turn:** the running turn is closed with the *current* time, marked
  ("running"), and the UI refreshes every 10 s.

### 3.2 `jobs` — background work

- **Definition:** the lifetime of the panels' terminal runs (`state\runs.json`,
  `startedAt`) and of session jobs, clipped to the measurement window.
- **Data source:** `state\runs.json` + the host job service; the real process
  lifetime via PID checks (the `dsh-process-guard` pattern).
- **Accuracy:** coarse (start is known, stop is only estimated; pre-boot records
  are incomplete). **Default weight 0**, at most 0.25 — the user said its
  relevance is low. It is shown as its own row so it is visible what is *not*
  being billed.

### 3.3 `human` — reading + typing the next prompt

Measured at two levels; both give the same quantity, the second splits it
finer.

**Level A — log-based fallback (always works, even with no client):**

```
human(turn n) = min( turn/start(n+1).time − turn/end(n).time , idleCap )
```

- `idleCap` per profile (default 15 min). Longer breaks **do not count**
  (lunch, other work) — that is exactly why the measured 99 h of "long gaps"
  must not enter an invoice.
- At the edges of the window (before the window start, after the currently open
  turn) there is no pair, so the component is 0 — the UI says so.
- This level also counts time **between** sessions when the user works between
  two conversations (that is real work time).

**Level B — client-side measurement (the proposal; this yields the
reading/typing split):**

- An invisible, always-mounted component (`conversation.composer.dock`,
  rendering `null`) listens in the **capture phase**: `keydown`, `input`,
  `pointerdown`, `wheel`, `scroll`, `visibilitychange`.
- It sends **activity signals** bucketed into 5-second slots to the host
  (`POST /koltseg/activity`) every 15 s or at turn end, with `keepalive: true`
  so a page hide does not lose them.
- The host splits them **against the turn boundaries**:
  - `T_end` = the turn's last `assistant/message` (from the log, not the client!),
  - `T_type` = the first keystroke after `T_end` (capped: `readCap`, default 20 min),
  - `T_next` = the next turn's `turn/start` (from the log),
  - **reading** = `T_type − T_end`, **typing** = `T_next − T_type`.
- If the tab was hidden (`visibilitychange` → `hidden`) or the machine locked,
  the interval is **skipped** ("away") — the most important anti-noise filter.
- Without client data (another client, a remote machine, a session started from
  a terminal) the host falls back to **level A** automatically and the UI says
  so ("no reading/typing split").
- **Limitation to state plainly:** this measurement is valid for the web UI. It
  cannot see reading outside the machine (paper, another program) — which is why
  the cap and the profile weight exist, rather than the raw time.

### 3.4 `wall` — real (gross) time, unioned

- **Definition:** active calendar time = the **union** of the
  `[turn.start, turn.end + humanSlack]` intervals (merged when the gap <
  `idleGap`, default 15 min). Parallel sessions do not double it, because we
  take a union.
- **Why:** the raw session lifetime (484 h) is a lie; the unioned, idle-clipped
  value is "the day actually spent at the machine".
- **Default weight 0** — this is the "non-billable gross", but it must appear in
  the statement as the reference baseline (and for the day-rate profile).

### 3.5 What we deliberately do not measure

- Thinking/reading time **while** the answer streams — that is agent time.
- Work the user does in another program.
- Splitting network/waiting time inside agent time (later, if needed: the
  `dsh-session-stats` `llmMs`/`toolMs` breakdown exists and can be folded in).

---

## 4. Accounting model

### 4.1 Components and weights

```
billable_minutes = Σ ( component_minutes × weight )
                   × machineToHuman         (agent component only)
                   → rounding (roundToMinutes, up)
                   → minimum (minimumMinutes, per scope)
total_HUF = billable_minutes / 60 × rate(repo)
```

Profile fields (`state\koltseg\config.json`):

```json
{
  "id": "alap",
  "name": "General",
  "weights": { "agent": 1.0, "jobs": 0.0, "humanRead": 1.0, "humanType": 1.0, "wall": 0.0 },
  "machineToHuman": 1.0,
  "idleCapMinutes": 15,
  "readCapMinutes": 20,
  "roundToMinutes": 0,
  "minimumMinutes": 0,
  "combine": "union",
  "currency": "HUF"
}
```

### 4.2 The four preset profiles ("several versions")

| id | name | agent | jobs | reading | typing | wall | when |
|---|---|---|---|---|---|---|---|
| `alap` | General | 1.0 | 0.0 | 1.0 | 1.0 | 0.0 | machine time + human time at one rate |
| `gepidő` | Machine-time based | 1.0 | 0.25 | 0 | 0 | 0 | you bill the machine's work |
| `emberi` | Human working time | 0 | 0 | 1.0 | 1.0 | 0 | classic hourly accounting |
| `bruttó` | Active calendar time | 0 | 0 | 0 | 0 | 1.0 | day rate / fixed price |

Plus a **custom profile**: the UI makes every weight editable from 0–3, and
`machineToHuman` from 0.05–1.0 (this answers "1 hour of machine time equals how
much human work"; default 1.0 = no conversion). A custom profile is saved under
a name and can be assigned to a repo.

### 4.3 Hourly rate and per-repo override

- `defaultRate: 12500` — global default.
- `workspaces: { "<canonical path>": { "rate": 15000, "profile": "gepidő" } }`
  — written from the UI, per repo.
- The UI always shows **which source applies** (global / repo), and the
  repo-level value can be reset with one click.
- Workspace identification comes from the session header `cwd` field and the
  `workspaceRegistry` (canonical path, as already proven for panels), so
  junctioned paths cannot produce duplicated keys.

### 4.4 Scopes

| Scope | Query | What it gives |
|---|---|---|
| Workflow | `scope=session&id=<sessionId>` | per-turn breakdown + total |
| Workspace | `scope=workspace&workspace=<path>` | per-session list + total |
| Date range | `…&from=YYYY-MM-DD&to=YYYY-MM-DD` | per-day breakdown, inside the workspace |

Date filtering is **turn-level** (not file-level): a session counts into its own
days even if it lived for days. Day boundaries follow the Hungarian (Europe/
Budapest) calendar — an already proven pattern in this project.

### 4.5 Parallel sessions — the double-counting question

`combine: "sum" | "union"` per profile:

- for **agent** the `sum` is correct (two parallel streams really are two units
  of machine work),
- for **human** and **wall** the `union` (the same human, the same day),
- the base profile therefore fixes it per component: `agent: sum`, `human: union`.
- The UI says so when the window had parallel sessions ("2 sessions ran at once
  — human time is unioned").

---

## 5. Architecture

### 5.1 New plugin: `plugins\dsh-koltseg` (host + client)

A standalone plugin following `dsh-ftp-deploy` (the `ui-extras` bundle is
already 10 000+ lines, we do not grow it further):

```
plugins\dsh-koltseg\
  package.json
  install.ps1              junction + `- insert:` into cordis.patch.yml
  lib\index.js             HOST: /koltseg/* endpoints, inject = ["webServer"]
  lib\engine\scan.js       log walk (multi-frame zstd frame walker)
  lib\engine\turns.js      turn intervals, turn metadata, date-range filter
  lib\engine\intervals.js  union, clipping, idle cap
  lib\engine\human.js      activity buckets → reading/typing, levels A/B
  lib\engine\profile.js    weights, machineToHuman, rounding, minimum
  lib\engine\calc.js       scope aggregation, HUF, optional VAT/material cost
  lib\engine\config.js     config load/save/validate (canonical keys)
  lib\engine\ledger.js     frozen calculations (not recomputed rows)
  lib\client.js            CLIENT: icon+tooltip button + floating window + tracker
  test\*.test.mjs          `node --test`, without network
```

Host endpoints:

| Endpoint | What it does |
|---|---|
| `GET /koltseg/ping` | liveness + version + config path (install check) |
| `GET /koltseg/config` | rates, profiles, repo overrides |
| `POST /koltseg/config` | save with validation (ranges, unknown profile rejected) |
| `GET /koltseg/sessions?workspace=&from=&to=` | workflow picker list |
| `GET /koltseg/measure?scope=…&profile=…` | the calculation (session / workspace / range) |
| `POST /koltseg/activity` | client activity buckets (small JSON, `keepalive`) |
| `POST /koltseg/ledger` / `GET /koltseg/ledger` | freeze / list calculations |
| `GET /koltseg/export?…&format=csv` | CSV (per scope, profile, period) |

State files (under `state\` in the repo, as with the other plugins):

- `state\koltseg\config.json` — rate, profiles, repo overrides
- `state\koltseg\activity.jsonl` — client activity buckets (daily rotation)
- `state\koltseg\ledger.jsonl` — frozen calculations
- `state\koltseg\koltseg.log` — diagnostics (rotated above 2 MB)

### 5.2 Client: icon + tooltip + floating window

A proven pattern, not guesswork:

- **Button:** `conversation.session.header.utilities` slot, `id: "koltseg-header"`,
  `order: 64` (FTP sits at 62), `title` = tooltip, `aria-label`; 26 px frame,
  SVG icon only (HUF sign/coin), no caption — exactly like the FTP button
  (`dsh-ftp-deploy\lib\client.js:908-971`).
- **Floating window:** `reactDom.createPortal(..., document.body)` +
  `position: fixed`, `zIndex: 2147483000` — the same pattern the stats tooltip
  already uses (`ui-extras\lib\client.js:2563-2597`). Closing: ESC + capture-phase
  `pointerdown` outside the panel (ui-extras:4264-4282), plus an × button. It does
  not steal focus (the spirit of AGENTS §1): no autofocus on open.
- **Data:** `props.sessionId` (the current workflow), `props.sessions` /
  `props.workspaces` for repo resolution, `props.useProjection("sessionStats")`
  for live turn statistics; every number comes from the host endpoints.

Window sketch (≈ 460 × 640 px, aligned under the top-right corner):

```
┌ Cost accounting ──────────────────────────── ✕ ┐
│ [This workflow] [Workspace] [Date range]      │
│ Rate: 12 500 HUF/h [✎]      Source: global    │
│ Profile: [General ▾]        [Edit]            │
│ ───────────────────────────────────────────── │
│ Agent          26.8 h   ×1.0 → 26.8 h         │
│ Background      0.3 h   ×0.0 →  0.0 h         │
│ Reading         8.1 h   ×1.0 →  8.1 h         │
│ Typing         12.1 h   ×1.0 → 12.1 h         │
│ (gross active  61.4 h   ×0.0 →  0.0 h)        │
│ ───────────────────────────────────────────── │
│ Billable: 47.0 h  →  587 500 HUF              │
│ [Freeze]  [CSV]  [Details ▾]                  │
└───────────────────────────────────────────────┘
```

Details expanded: a per-turn table (turn #, start, agent, reading, typing, HUF),
and in workspace scope a per-session list.

---

## 6. Worked example (from the measured data)

The same 30-day window, `alap` profile, 12 500 HUF/hour, rounded up to 15
minutes:

| Component | Measured | Weight | Counted |
|---|---|---|---|
| agent (351 turns) | 26.78 h | 1.0 | 26.78 h |
| human (264 gaps ≤20 min) | 20.21 h | 1.0 | 20.21 h |
| background | ≈ 0.3 h | 0.0 | 0.00 h |
| gross active (union) | ≈ 61 h | 0.0 | 0.00 h |
| **total** | | | **46.99 h → 47.00 h** |
| **invoice** | | | **587 500 HUF** |

With the `emberi` profile the same window is 20.21 h → rounded 20.25 h →
253 125 HUF. The difference is the profile's decision, not a measurement error —
which is why all four components are always visible.

---

## 7. Phases, tests, go-live

### Phase 1 — engine + base UI (the substance)

1. `lib\engine\scan.js` + `turns.js`: log walk, turn intervals,
   `delegationDepth` filtering, `cwd` → workspace.
2. `intervals.js`, `profile.js`, `calc.js`, `config.js`: pure functions.
3. Host endpoints (`/koltseg/ping|config|sessions|measure`).
4. Client: icon+tooltip, floating window, three scopes, profile and rate
   editing, HU/EN dictionaries, explicit error/empty states.
5. `install.ps1` (`-Check`, `-Remove`), `node --test` tests.

**Acceptance criterion:** `/koltseg/measure?scope=workspace&from=2026-10-18&to=2026-11-16`
must return the same numbers (±2%) as the independent measurement in section 2
(26.78 h agent / 20.21 h human / 351 turns). That is the best possible test: the
engine is calibrated against a separate measurement.

### Phase 2 — refining human time

6. Client activity tracker (`conversation.composer.dock`, invisible),
   `POST /koltseg/activity`, `keepalive`, hidden-tab filtering.
7. `human.js`: levels A/B, reading/typing split, caps, "away" marking.
8. The UI states which level it measures at (split / no split).

### Phase 3 — freezing the accounting

9. `ledger.js`: freeze (rate + profile snapshot so later rate changes cannot
   rewrite the past), list, delete.
10. CSV export per scope/period (Hungarian number format, semicolon).
11. Optional: a VAT (27%) row, and the token/API cost in a **separate row**
    (the `dsh-ui-extras` `/ui-extras/usage` already computes it in USD, per
    session — call it when present, otherwise omit the row) → margin.

### Tests (`node --test`, no network, no real logs)

- interval union, idle cap, window edges,
- turn pairing edge cases (open turn, interrupted turn, missing `turn/end`),
- delegated-session exclusion (must not double count),
- parallel sessions: agent `sum` + human `union`,
- profile math (weight, `machineToHuman`, round-up, minimum),
- rate resolution: repo override > global, canonical path,
- date filtering with Hungarian day boundaries (DST both ways),
- config validation (unknown profile, negative rate, weight above 3),
- client bundle: load with a stubbed React, registrations, `locale`, render
  without props (the FTP pattern gave 41/41),
- HU/EN dictionary key parity.

### Go-live (per project rules)

- `install.ps1` — junction + `- insert: { id: koltseg, name: dsh-koltseg }`,
  then `-Check` green and `node tools\check-plugin.mjs` run.
- **Host** endpoints only live after a **harness restart** (AGENTS §1.5: check
  first whether work is running, and the user's permission is required); the
  **client** half lives after a panel reload.
- No child processes, no console window, no pop-up window (AGENTS §1). The
  measurement happens in the host process by reading files.
- Documentation: this plan + `docs\KOLTSEG-ELSZAMOLAS.md` (usage), and the
  mandatory English mirror (`tools\check-docs-bilingual.mjs`).

### Effort estimate

Phase 1 is ~60% of the work (engine and UI); phase 2 ~20%; phase 3 ~20%. The
main risk is a change of the log format (`session.v3.jsonl.zstd` is versioned;
the walker checks the header `version` field and is expected to fail loudly on
an unknown version rather than silently return 0).

---

## 8. Risks and limits (stated plainly)

1. **Log-based agent time is the whole turn**, so it includes model waiting —
   deliberate ("the machine was working"), but not identical to "useful work".
   If that number is needed separately, the `sessionStats` `llmMs`/`toolMs`
   breakdown can be folded in.
2. **Human time measurement is valid for the web UI.** The caps (15/20 min) guard
   against inflation, but it cannot see reading outside the machine.
3. **Multiple clients / terminal-started sessions:** no activity data → level A,
   marked as such.
4. **Gross time is seductive.** 484 h vs 47 h: that is why the gross row carries
   weight 0 by default and all four components are always shown.
5. **A rate or profile change must not rewrite the past** → frozen accounting
   (ledger) with a snapshot.
6. **Host endpoints do not exist without a restart** — installation is two steps
   (install + approved restart); the UI says so while the host half is old (the
   "the host half is still the old build" message, as the usage row does).

---

## 9. Decisions (2026-11-16, user answers)

| Question | Decision | Consequence in the code |
|---|---|---|
| What should the base profile bill? | **machine time + human time** | `alap`: agent 1.0 / reading 1.0 / typing 1.0 / jobs 0 / gross 0 |
| Measuring human time | **client measurement + log fallback** | `human.js` levels A/B, `POST /koltseg/activity` |
| Rounding / minimum | **per-minute precision, no rounding** | `roundToMinutes: 0` (nearest whole minute), `minimumMinutes: 0` |
| Where the per-repo rate lives | **central config only** | `state\koltseg\config.json` → `workspaces` (canonical key), nothing written into repos |
| Output | net HUF + **toggleable 27% VAT** + **CSV** + **optional token cost** | `vatEnabled` (off by default), `/koltseg/export`, `materialCost` (off by default because the rate already covers tokens) |

The answers are implemented: the feature is **built** (`plugins\dsh-koltseg`), and
the usage is documented in
[`KOLTSEG-ELSZAMOLAS.en.md`](KOLTSEG-ELSZAMOLAS.en.md). Re-measurement on the real
logs: `node tools\check-koltseg.mjs` (returns the numbers from section 2 within
±2%: agent ≈ 27.2 h, reading ≈ 15.5 h per 30 days).

