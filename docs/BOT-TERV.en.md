# Local robot (bot) — a plan to replace the Grok Bot

> Hungarian version: [`BOT-TERV.md`](BOT-TERV.md).

**Date:** 2026-09-30
**Status:** PLAN — decisions recorded, nothing built yet.
**Related:** [`CURSOR-CLI-ELEMZES.md`](CURSOR-CLI-ELEMZES.md), `providers/README.md`,
`providers/FELJEGYZES.md`, `docs/dsh-plugin-notes.md`

---

## 0. Recorded decisions (2026-09-30)

| Question | Decision |
|---|---|
| Platform | **DSH-native** — one system; the tray/webhook/MCP/scheduler/logs already exist |
| Output | **Primarily DSH integration**; in many cases (e.g. a Facebook group summary) **e-mail is the main output**. A phone application is **not** a goal for now. |
| Facebook | **Only my own groups**, with a logged-in profile, at a low frequency, summarisation only — no posting/commenting |
| First jobs | **1) a complete takeover of the Adult Education Data Reporting System (FAR) GrokBot solution**, **2) a competitor monitor** |

The starting point of the takeover: **the data rescued from the GrokBot** (see section 7).

---

## 1. Exactly what we are replacing

Cursor Pro includes the **Grok Bot** entitlement (since 2026-08-26). The Grok Bot is xAI's
"standing agent" product: **agents running on their own cloud machine that log into the user's
devices and websites — even without an API — work continuously, and report back asking for
approval.**

| Grok Bot feature | Local equivalent |
|---|---|
| Own cloud PC | **Your own machine** (DSH host + tray, already running) — advantage: the data never leaves the machine |
| Logging into devices/websites without an API | **A persistent Playwright browser profile** (stays logged in), exposed through MCP among the DSH tools |
| Continuous work | **Scheduled jobs** (Windows Task Scheduler + a DSH headless run) |
| Feedback, requesting approval | **An approval store** + **e-mail** (primary), later Telegram/desktop |
| Supervision, limits | DSH approval, tool allowlist, domain allowlist, cost budget, kill switch |

**What we are not replacing:** the cloud PC's advantage (it runs even when your machine is off).
This is a deliberate trade: data protection and a $0 subscription instead of continuous
availability.

---

## 2. Principle: three layers, and zero tokens in most steps

| Layer | What does it | When | Cost |
|---|---|---|---|
| **1. Deterministic** | Playwright/Node/PowerShell, HTTP API, SQLite, file operations, `schtasks` | **80–90% of the work**: download, parse, diff, validate, generate files, send | **$0** |
| **2. Free model** | Groq / NVIDIA / OpenRouter `:free` / Google free tier (already wired), local Ollama | what needs **linguistic** understanding: summarising, labelling, wording an e-mail | **$0** (rate limit) |
| **3. Paid model** | DeepSeek **off-peak** (primary), DeepSeek peak (rare), Cursor CLI (while it lasts) | hard decisions, code, uncertain situations | measured, with a budget |

**Data classification (a hard rule):**

| Data | Layer |
|---|---|
| Personal data (FAR reporting, participant data) | **layer 1 only**, or local Ollama. **Free cloud is FORBIDDEN** (the free tier uses the content for training) |
| Public website content, competitor data | layers 1–2 |
| Internal business decisions, code | layers 1–3 |

---

## 3. Architecture

```
  TRIGGER                  RUNNER                      TOOLS                  OUTPUT
┌──────────────┐   ┌────────────────────┐   ┌────────────────────┐   ┌──────────────┐
│ Task Sched.  │──▶│ bot/run-job.ps1    │──▶│ Playwright (Node)  │──▶│ report (.md) │
│ DSH webhook  │──▶│  - job def (JSON)  │   │ Playwright MCP     │   │ E-MAIL (main)│
│ GUI panel    │──▶│  - preset + model  │   │ HTTP/API, pwsh     │   │ DSH panel    │
│ e-mail (IMAP)│──▶│  - pre- script     │   │ SQLite (dedup)     │   │ Telegram     │
└──────────────┘   │  - post-validation │   │ DSH subagent (fr.) │   │  (later)     │
                   └────────────────────┘   └────────────────────┘   └──────────────┘
                              │
                       ┌──────┴───────┐
                       │  GUARDS      │  approval · allowlist · cost budget · kill switch · audit
                       └──────────────┘
```

**What already exists and will be reused:**

| Existing element | Role in the bot |
|---|---|
| `dsh` host + `tray/dsh-tray.ps1` | an always-running server, with supervision |
| `providers/run-headless-task.ps1` | the model for **running** (dedicated channel, `-ReportDirectory`, `-Patch`) |
| `providers/session-channel.mjs` | the bot's sessions in a separate workspace |
| `@deepseek-ai/dsh-webhook` | incoming webhook → **workspace-backed session** (the website's instruction) |
| `@deepseek-ai/dsh-mcp-client` | the tools of Playwright MCP and other MCP servers |
| `@deepseek-ai/dsh-schedule`, `dsh-jobs` | reminders, background jobs |
| `plugins/dsh-ui-extras` | the model for a **panel** and host routes (`/ui-extras/...`) |
| `providers/proxy.mjs` | the free model chain for the bot's summarising steps |
| `dsh-user-approval` + the ui-extras approval store | approval control |

**Missing, to be built:** the job-definition layer, a single runner, the Playwright installation,
**e-mail output/input** (DSH has no mail plugin), the panel, and a generic HTTP webhook adapter
(out of the box there is only a GitHub adapter).

**Secrets:** the bot's own secrets (SMTP/IMAP password, FAR login) are **not** stored in the repo
but in Windows Credential Manager or a DPAPI-protected file (`.bot/secrets.clixml`, in
`.gitignore`). DSH's `.credentials.yaml` remains the place for the model keys.

---

## 4. The job definition (this is what makes it a "bot")

`bot/jobs/<id>.json` — one file = one repeatable task:

```jsonc
{
  "id": "competitor-monitor",
  "description": "Content and price monitoring of competitor sites, weekly report",
  "schedule": { "type": "cron", "expression": "0 7 * * 1" },   // Monday 07:00 local
  "channel": ".bot",                         // the DSH workspace for the run
  "preset": "standard-free",                 // the children on the free chain
  "model": { "provider": "subagent-worker", "model": "worker", "effort": "low" },
  "preScript": "bot/collect/competitor.mjs",     // layer 1: collect + diff
  "prompt": "bot/prompts/competitor.md",         // layer 2: summarising only
  "toolAllowlist": ["read", "write", "web_fetch"],
  "domainAllowlist": ["example.com", "competitor.com"],
  "costBudgetUsd": 0.05,
  "needsApproval": false,
  "dedupStore": "bot/state/competitor.db",
  "output": ["report", "email"],
  "retentionDays": 90
}
```

The runner (`bot/run-job.ps1`): load the job → **pre-script** (without tokens) → if there is a
substantive change, **one** model call on the given lane → schema validation → report + e-mail →
log. If the pre-script says "no change", the model **does not even start** (this is the most
important cost guard).

---

## 5. The first jobs

| # | Job | Layer | Note |
|---|---|---|---|
| 1 | **`far-reporting`** | **1 only** (+ local model) | The complete takeover of the GrokBot solution — see section 7. This is first because it is a statutory obligation and personal data. |
| 2 | **`competitor-monitor`** | 1 + 2 | Public sites, sitemap, RSS, prices. Legally clean, a good first proof. |
| 3 | `website-watchdog` | 1 (+2) | Monitoring our own site and the reporting endpoint; e-mail on failure. |
| 4 | `weekly-report` | 1 + 2 | A weekly summary from the bot's logs, with a free model, by e-mail. |
| 5 | `fb-group-monitor` | 1 + 2 | **Own groups only**, low frequency, own logged-in profile, summarisation only, by e-mail. The Meta ToS forbids scraping → a deliberate risk. |

---

## 6. The panel (a separate tab in DSH)

Following the `dsh-ui-extras` pattern (`docs/dsh-plugin-notes.md` point 3: a right-hand tab
`sidebar.right.pane.tab`, host routes):

- **Jobs:** next run, last result, state (OK / ERROR / WAITING).
- **Awaiting approval:** in one place, with one click (also requestable by e-mail).
- **Log:** the report of the last N runs.
- **Cost:** the bot's daily token cost (`check-usage.mjs` already does the breakdown).
- **Kill switch:** immediate stop of every scheduled job.

Host routes: `/bot/jobs`, `/bot/run?job=…`, `/bot/log`, `/bot/approvals`, `/bot/state`.

---

## 7. Taking over FAR reporting from the GrokBot

**Goal:** after the Cursor cancellation, the reporting to the Adult Education Data Reporting System
(FAR, eKRÉTA) should work **the same or better**, on a local machine, replacing the GrokBot.

### 7.1 The five steps of the takeover

| Step | What it means | Exit criterion |
|---|---|---|
| **1. Inventory (discovery)** | The current GrokBot solution step by step: which URLs, which data source, what it clicks, what it uploads, where it asks for approval, what the error branch is | a documented flowchart that **you** also accept as correct |
| **2. Data and knowledge extraction** | What can be brought over from the GrokBot: the process documentation, the approved data sets, templates, the list of previous submissions. **We do not export passwords/KAÜ** — those go locally into the bot's own secret store | the rescued files under `bot/far/import/`, the bot's secret store configured |
| **3. Rebuild** | Deterministic steps (data assembly, format, validation) + a single browser or API step | a **dry run** produces the file to be submitted but sends nothing |
| **4. Parallel run** | The bot and the GrokBot produce the same data; the comparison is item by item | N consecutive weeks agreeing (or replacing the GrokBot for a given step) |
| **5. Replacement** | Delete the GrokBot step; the bot stays, with logging and alerting | monthly reporting stays green after the Cursor cancellation |

### 7.2 Two technical routes — decide in step 1

| Route | When viable | Advantage | Disadvantage |
|---|---|---|---|
| **A) Machine interface (fKRÉTA/FAR API)** | If the institution has an **API key/domain** in the eKRÉTA/fKRÉTA system. The fKRÉTA manual has a separate chapter on *"Domain setup and API key generation"*, so an institutional integration surface exists | Fully deterministic, **zero tokens**, fast, auditable, immune to UI changes | It has to be checked whether it also covers the **reporting** workflow, not just document templates |
| **B) Browser RPA (Playwright)** | If there is no API, or FAR only accepts through a web surface | It can do what the GrokBot does (login, form, upload); FAR supports **Excel import**, which simplifies a lot | Breaks on UI changes; the login (KAÜ/client gateway) has to be refreshed by hand; slower |

**Recommendation:** check route **A)** first (a single question to the institutional administrator:
is there an API key/domain and what does it cover), and prepare route **B)** in parallel. FAR's
**Excel import** is common to both: the bot deterministically produces **the file in the prescribed
format**, and either submits it via the API or uploads it on the surface.

### 7.3 Hard rules in the FAR job

1. **Personal data never goes to the cloud.** Processing participant data happens exclusively with
   deterministic code or **local Ollama**. The free cloud lanes (Groq/NVIDIA/OpenRouter `:free`,
   Google free tier) are **forbidden** for this job.
2. **A dry run is mandatory.** Before every submission: `--dry-run`, which shows the payload/diff
   but does not send.
3. **Approval before sending.** A human approves the submission (on the DSH panel or with an e-mail
   reply) — the equivalent of the GrokBot's "messages back for approval".
4. **Idempotency.** A submission log (SQLite) with hashes: the same data set is not sent twice; a
   repeated run sends only the difference.
5. **Full audit.** Who, when, what, from which source data, with what result.
6. **Saving and restoring.** Keeping every submitted file and the corresponding answer (for legal
   compliance and in case of a dispute).
7. **No secret left on screen.** The login lives in a persistent Playwright profile; the profile's
   directory is outside the workspace, in `.gitignore`.

---

## 8. Alternatives (why the DSH-native route)

| Option | Advantage | Disadvantage |
|---|---|---|
| **DSH-native (chosen)** | One system that already runs; tray, webhook, MCP, scheduler, subagent chain, logs **all exist**; data stays local | We have to build the job layer, the panel and the e-mail channel |
| OpenClaw | Ready channels, cron, browser control, memory | A second agent system on the same machine; a large surface |
| SuperGrok ($30/month) | A direct replacement of the Grok Bot, zero development | More expensive than the current Cursor; keeps a new subscription alive |

---

## 9. Phase plan

| Phase | What it delivers | Done when |
|---|---|---|
| **0. Foundations** | a `bot/` workspace, the job format, logging, the secret store, Playwright inside the workspace (local npm cache — the global install is EPERM in the sandbox), e-mail sending (SMTP) | a "hello job" runs, writes a report and **sends an e-mail** |
| **1. FAR inventory** | step 7.1/1: documenting the GrokBot process, deciding route A or B | the flowchart is ready, the API question answered |
| **2. FAR dry run** | data assembly + validation + dry run, without submission; with the data rescued from the GrokBot | the generated file matches the GrokBot's item by item |
| **3. FAR live** | submission (API or RPA) + approval + idempotency + audit | one full period green, without human intervention |
| **4. Runner + scheduler** | `bot/run-job.ps1` + Task Scheduler (**you** must run the registration from a normal PowerShell) + `competitor-monitor` | two consecutive days run by themselves |
| **5. Panel** | right-hand tab: jobs, approval, log, cost, kill switch | the panel's data matches the logs |
| **6. E-mail input (IMAP)** | the bot also accepts approval/instruction from an e-mail reply | one submission can be approved with a reply letter |
| **7. FB monitor** | summarising own groups by e-mail | 1 week without a block |
| **8. Hardening** | domain allowlist, cost budget, bot-loop protection, backup, documentation | a simulated failure run sends no data out and does not blow up the cost |

---

## 10. Risks and hard limits

1. **GDPR / data handling** — FAR involves personal data: it never goes to a free cloud (the free
   tier uses it for training), only deterministic code or local Ollama, with a full audit log.
2. **Operational continuity** — during the takeover the GrokBot **cannot** be switched off
   immediately; a parallel run is needed until the replacement (7.1/4).
3. **Meta ToS** — scraping a Facebook group is forbidden; own group only, low frequency, no
   posting, human approval.
4. **Sandbox limits (measured)** — writing into `~/.dsh` and starting a persistent process from the
   DSH sandbox **does not work**; **you** must register the scheduled task and the watchdog from a
   normal PowerShell window.
5. **npm EPERM** — every Node dependency goes inside the workspace, with a local cache.
6. **Ollama is not running at the moment** — it has to be started for the local/private lane.
7. **Cost explosion** — the risk is not the bot but the configuration; that is why the per-job
   budget and the "no change → no model call" rule are mandatory.
8. **Bot loop** — the bot never answers its own message; its own address/identifier must be excluded
   on the input channel.

---

## 11. What I need to know from you before phase 0

1. **What exactly does the GrokBot's FAR solution do today?** At which URL, with which login
   (KAÜ/client gateway?), what does it upload (a form or Excel?), at what frequency, and where does
   it ask you for approval?
2. **What can be exported from the GrokBot?** Are there ready data sets, templates, previous
   submissions, or only the conversations/the process description?
3. **Does the institution have an API key/domain in the eKRÉTA/fKRÉTA system?** (If so, route A is
   viable and the bot can be fully deterministic.)
4. **Is there a test/practice surface**, or does every attempt mean a live submission? (This decides
   how risk-free phase 2's dry run is.)
5. **The e-mail output** — which account should it come from, and who receives the reports?
6. **The competitor monitor** — which sites should it watch (2–5 domains to start)?
