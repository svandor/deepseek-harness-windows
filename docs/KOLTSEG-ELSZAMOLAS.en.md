# Development cost accounting — usage

English | [Magyar](KOLTSEG-ELSZAMOLAS.md)

The feature lives in a **floating window** opened by the **coin icon** in the
menu bar (tooltip: "Cost accounting"). Default hourly rate **12 500 HUF**,
overridable per repository.

- Plan and decisions: [`KOLTSEG-ELSZAMOLAS-TERV.en.md`](KOLTSEG-ELSZAMOLAS-TERV.en.md)
- Plugin: `plugins\dsh-koltseg` (host + client), install: `install.ps1`
- Check: `node tools\check-koltseg.mjs`, tests: `plugins\dsh-koltseg\test\*.test.mjs`

---

## 1. Where is it?

In the conversation header, among the right-hand icons (next to the FTP and
Admin icons), a **26 px coin symbol**. There is no caption on the button — the
name is in the tooltip, as with the other header buttons.

When the conversation is **still empty** (a new session) the header is hidden —
in that case the same icon appears in the **strip above the composer** (the same
button, the same window). The phase comes from the interface's `data-phase`
attribute.

A click opens a **floating window** under the button (not a sidebar tab):

- closing: `✕`, `ESC`, or a click outside the window;
- the window does not steal focus, and it scrolls when it does not fit;
- **snapshot:** on open the last result appears **immediately**
  ("Snapshot: HH:MM — refreshing…"), the fresh calculation runs in the
  background and replaces it; the host also caches the same request for 90 s,
  while the **Refresh** button always recalculates (`fresh=1`);
- the measurement refreshes every 20 s while it is open (not on a hidden tab).

The button lives **only in the menu bar** (header icon), and in the strip above
the composer **for an empty conversation** — there is no separate cost chip at
the bottom of the panels.

## 2. What does it show?

Three scopes:

| Button | What it measures |
|---|---|
| **This workflow** | the selected conversation (session) and its turns |
| **Workspace** | every workflow of the workspace |
| **Period** | the same, between `From`/`To` dates (the `To` day is included) |

All components are **always** visible together with their weight — so it is
visible what is *not* being billed:

| Component | Where it comes from |
|---|---|
| Server-side work time | `turn/start` → `turn/end` from the durable session log (local Ollama included) |
| Background jobs | the panels' terminal runs (`state\runs.json`), an **estimate** |
| Reading | between the end of a turn and the first keystroke |
| Typing | between the first keystroke and the start of the next turn |
| Real active time | the union of the turns, merged across short gaps |

Below that the **total**: billable time, net HUF, (toggleable) VAT, gross.

Details: a per-turn table (session scope) or a per-workflow list (workspace
scope).

## 3. Hourly rate and profiles

- The **hourly rate** field shows the rate in effect for the repo; after editing
  press **Save**. The field groups thousands (`12 500`), and the totals are shown
  the same way. The UI also states the source: "global default" / "repo
  override". The repo-level rate lives in `state\koltseg\config.json` (nothing is
  written into the repositories).
- **Workspace resolution:** the panel resolves it from the selected
  conversation's `cwd` (then the selected workspace, then the first workspace);
  if the request does not say, the host does the same from the session log
  header. So the measurement never falls back to the server's own working
  directory.
- The **profile** supplies the weights. Four presets:

| id | name | agent | jobs | reading | typing | gross |
|---|---|---|---|---|---|---|
| `alap` | General | 1.0 | 0 | 1.0 | 1.0 | 0 |
| `gepido` | Machine-time based | 1.0 | 0.25 | 0 | 0 | 0 |
| `emberi` | Human working time | 0 | 0 | 1.0 | 1.0 | 0 |
| `brutto` | Active calendar time | 0 | 0 | 0 | 0 | 1.0 |

- A **custom profile** can be added in the `profiles` list of `config.json`
  (`weights` 0–3, `machineToHuman` 0.05–1, `idleCapMinutes`, `readCapMinutes`).
  A custom profile cannot override a preset (loading rejects it).

## 4. How is human time measured?

At two levels; the bottom of the window states which one was used:

1. **Log-based (always works):** the time between the end of a turn and the
   start of the next. Breaks **longer than 15 minutes do not count** (lunch,
   other work) — that is why it is conservative.
2. **Client measurement (more precise):** an invisible component of the web UI
   sends keyboard/pointer/scroll/tab-visibility buckets every 15 s
   (`POST /koltseg/activity`). That is what yields a separate **reading** and
   **typing** figure. Time on a hidden tab is excluded; if there is no activity
   during a gap it is "away" (0) rather than estimated upwards.
   No text is sent — only timestamps.

Without client data (another client, a session started from a terminal) the
measurement falls back to level 1 automatically and says so.

## 5. Freezing and export

- **Freeze:** saves the current statement **with a snapshot** (rate, profile,
  minutes) into `state\koltseg\ledger.jsonl`. A later rate change does not alter a
  frozen row.
- **CSV:** the current scope/period (per turn or per workflow), in Hungarian
  format (semicolon, decimal comma).
- **VAT:** a toggle on the total (off by default, 27%).
- **Token/API material cost:** a toggle; shows the estimated USD token cost in a
  separate line (from the existing `/ui-extras/usage` data). The hourly rate
  already covers tokens by default — this line is informational only.

## 6. Configuration

`state\koltseg\config.json` (no BOM, written atomically):

```json
{
  "version": 1,
  "currency": "HUF",
  "defaultRate": 12500,
  "defaultProfile": "alap",
  "vatPercent": 27,
  "vatEnabled": false,
  "materialCost": false,
  "profiles": [],
  "workspaces": {
    "D:\\Szerver\\Deepseek Harness": { "rate": 15000, "profile": "gepido" }
  }
}
```

The workspace key is **canonical** (junction resolved), so the `C:`/`D:` form
cannot create two entries. A damaged file loses no data: loading clamps the bad
value to the nearest valid one and the answer states what it changed.

## 7. Endpoints (host)

| Endpoint | What it returns |
|---|---|
| `GET /koltseg/ping` | liveness + version + paths |
| `GET /koltseg/config` | configuration + profiles + the rate in effect for the repo |
| `POST /koltseg/config` | save (validated, normalized) |
| `GET /koltseg/workspaces` | workspaces (registry or from the logs) |
| `GET /koltseg/sessions?workspace=` | workflow list |
| `GET /koltseg/measure?scope=&id=&workspace=&from=&to=&days=&profile=` | the measurement |
| `GET /koltseg/export?…&format=csv` | the measurement as CSV |
| `POST /koltseg/activity` | client activity buckets |
| `GET /koltseg/ledger` | frozen statements (+ `?format=csv`) |
| `POST /koltseg/ledger` / `DELETE /koltseg/ledger?id=` | freeze / delete |

## 8. State files

| File | Content |
|---|---|
| `state\koltseg\config.json` | rate, profiles, repo overrides |
| `state\koltseg\activity.jsonl` | activity buckets (append-only, rotated above 5 MB) |
| `state\koltseg\ledger.jsonl` | frozen statements (rotated above 5 MB) |
| `state\koltseg\koltseg.log` | diagnostics (route registrations, measurement summaries) |

## 9. Verification and troubleshooting

```
node tools\check-koltseg.mjs          # on real logs: frame reading, DST, profiles, measurement
node --test plugins\dsh-koltseg\test\engine.test.mjs
node --test plugins\dsh-koltseg\test\client.test.mjs
node --test plugins\dsh-koltseg\test\host.test.mjs
pwsh -NoProfile -File plugins\dsh-koltseg\install.ps1 -Check
```

- **"The host half is still the old build"** in the window: the harness started
  before the plugin entry. The host composition loads at boot, so it lives from
  the next start (AGENTS §1.5: restarting while work runs is forbidden).
- **0 HUF / 0 minutes:** no session log in the workspace, or the scope's period
  is empty. "Details" shows which workflows were counted.
- **"no split" (log-based estimate):** there is no client activity for that
  period (the tab was not open, or the client half did not run).
- The measurement **never** reads the content of conversations: only timestamps
  and counts.

## 10. Deliberately not measured

- Reading **while** the answer streams (that is part of agent time).
- Reading outside the machine (paper, another program).
- The exact end of background jobs (only the start is logged — hence the
  estimate, and hence their default weight of 0).
