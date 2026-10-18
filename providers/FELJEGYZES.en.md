# Record — Provider configuration and maintenance

> Hungarian version: [`FELJEGYZES.md`](FELJEGYZES.md).

**Date:** 2026-09-27
**DSH version:** `0.1.5-rc.3` (npx cache: `@deepseek-ai/dsh@0.1.5-rc.3`)
**DSH home:** `%USERPROFILE%\.dsh`
**Workspace:** `C:\Szerver\Deepseek Harness`

---

## 1. Starting point and the main finding

In DSH the multi-provider layer (`@deepseek-ai/dsh-llm-pi-ai`) is **already built in**; `dsh-base`
mounts it, it is just *dormant* (zero routes) until there is an `llm-pi-ai:` section in
`~/.dsh/settings.yaml`. The Web GUI's **Settings → Models** page handles this: adding a provider, the
API key (write-only, goes into `~/.dsh/.credentials.yaml`), editing the model list, and *Fetch
available models* to query the endpoint.

So **nothing had to be developed**: the goal (local Ollama + free cloud providers + free models for
simple tasks) is reachable with native configuration. The community plugins (fallback, tier-routing)
only work on **0.1.7**, because in 0.1.6 the `@deepseek-ai/dsh-settings-file` and the
`ctx.settings.register` seam disappeared.

---

## 2. The current configuration

Five providers in `~/.dsh/settings.yaml`, **63 models** in total, every one checked with a live API
probe:

| Provider | Models | Endpoint | Key |
|---|---|---|---|
| `groq` | 4 | catalogue (`api.groq.com/openai/v1`) | `GROQ_API_KEY` |
| `openrouter` | 17 | catalogue (`openrouter.ai/api/v1`) | `OPENROUTER_API_KEY` |
| `nvidia` | 18 | catalogue (`integrate.api.nvidia.com/v1`) | `NVIDIA_API_KEY` |
| `google` | 16 | catalogue (native `google-generative-ai`) | `GOOGLE_API_KEY` |
| `ollama-local` | 8 | `http://localhost:11434/v1` | `OLLAMA_LOCAL_API_KEY` |

Default model: `deepseek-official` / `deepseek-flash`, effort `high` (**unchanged** — the re-tuner
never touches it).

### Rejected providers

| Provider | Reason |
|---|---|
| Cerebras | it asks for a card even on the free tier |
| GitHub Copilot | subscription cancelled |
| Z.AI | it looked paid |

### Important: Ollama asks for a key too

The OpenAI-compatible implementation in pi-ai requires the key or an `Authorization` header — even
when the local server does not. The code:
`if (apiKey) return apiKey; if (hasHeader(headers, "authorization")) return "unused"; throw …`

That is why a **placeholder** is needed (`OLLAMA_LOCAL_API_KEY` = `ollama`). Model *discovery*,
however, works without a key.

---

## 3. Measured results (live API probes)

The pi-ai catalogue's built-in model list and the provider's live list **regularly differ**. Of the 88
models listed, 15 were unusable.

| Provider | Did not exist / not callable | Fix |
|---|---|---|
| groq | `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `qwen/qwen3.6-27b` | deleted; instead `openai/gpt-oss-120b`, `-20b`, `qwen/qwen3.8-27b` |
| openrouter | `minimax/minimax-m2.7:free`, `minimax/minimax-m3:free`, `z-ai/glm-5.2:free` | deleted; instead `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free` |
| nvidia | `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`, `minimaxai/minimax-m3` | deleted; instead `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k3` |
| google | `gemini-3.1-flash-live-preview` (does not exist), `gemini-2.5-flash`, `-lite`, `-pro` (404: "no longer available to new users"), `deep-research-*` (Interactions API only) | deleted |

### Google: two routes, and only one is good

| Route | Protocol | Tool calling |
|---|---|---|
| **Native** `/v1beta/models/<m>:generateContent` | `google-generative-ai` — **this is what DSH uses** | ✅ `get_weather({"city":"Budapest"})` |
| OpenAI-compatibility `/v1beta/openai` | `openai-completions` | ❌ calls no tool; with reasoning models **empty content**, with Gemma a raw `<thought>` leaks into the answer |

**Consequence:** Google has to be used on the native route (that is the default), and it must **not**
be wired into the fallback proxy.

### The type of the Google key

The key is an **API key** (`AQ.…`), not an OAuth token:

| Authentication | Result |
|---|---|
| `?key=` query param | ✅ 200 |
| `x-goog-api-key` header | ✅ 200 (this is what the official SDK sends) |
| `Authorization: Bearer` | ❌ 401 |

### Google: the existence of the list does not mean it is callable

`/v1/models` returns 50 models, but only **11 are callable**. These did not answer temporarily because
of quota (429) or overload (503): `gemini-3.1-pro-preview`, `gemini-3.1-pro-preview-customtools`,
`gemini-3.1-flash-lite-image`, `gemini-2.5-computer-use-preview-10-2025`, `gemini-3.5-flash` — they
stayed on the list, because the failure is not permanent.

### Local Ollama: tool calling is the filter

Of the 18 local models, **11 can do tool calling** — only these can be used in an agent loop. Two
traps:

- `llava:13b` and `minicpm-v` **see, but cannot call tools** → unusable in an agent loop.
- `qwen3-vl:8b` is the **only** one that both sees *and* can call tools.

Removed from the config (no tool, or not a chat model): `qwen2.5-coder:1.5b-base` (a base model — a
measured example: for a trivial request it answered "I have no idea what this means!"),
`nomic-embed-text`, `glm-ocr`, `gemma2:9b`, `deepseek-coder-v2:16b`, `llava:13b`, `minicpm-v`,
`moondream`, `racka:*`.

### The token budget of reasoning models

`gpt-oss:20b` with a 24-token `max_tokens` gave **empty content**, because it ran out on its
reasoning. That is why local reasoning models need at least 16384 `maxTokens`.

---

## 4. Fallback proxy (`providers/proxy.mjs`)

Because the core of DSH 0.1.5 does not switch to another provider by itself (the `retryPolicy`
retries on the same route), a **zero-dependency Node proxy** was built that exposes a single
OpenAI-compatible endpoint and tries according to the configured chain — before the first token.

**The state of the chains on 2026-10-01** (from the live `/healthz`, with a `chain-doctor`
measurement):

| Route | Chain |
|---|---|
| `worker` | NVIDIA `gpt-oss-20b` → NVIDIA `nemotron-3-super-120b` → Groq `gpt-oss-120b` → OpenRouter `qwen3.8-27b:free` → Ollama `qwen2.5-coder:14b` |
| `deepseek-chat` | Groq `gpt-oss-120b` → NVIDIA `nemotron-3-super-120b` → Ollama `gpt-oss:20b` → OpenRouter `qwen3.8-27b:free` |
| `fast-chat` | Groq `gpt-oss-20b` → NVIDIA `gpt-oss-20b` → Ollama `qwen2.5:7b-instruct` |
| `local-only` | local Ollama `gpt-oss:20b` only (data never leaves the machine) |

### The proxy reads its config ONCE at startup — and that silently goes stale

**A measured failure (2026-10-01).** `proxy.mjs` reads `config.json` once at the top of the module
(`const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, …))`), and every request uses that in-memory
instance. Saving the file therefore has **no effect on the running instance**.

The proxy running since 2026-09-29 15:14 thus **served a stale chain for two days** — not what the
file said. The `worker` chain actually running was this:

```
groq/gpt-oss-120b → nvidia/nemotron-3-super-120b → ollama/qwen2.5-coder:14b
  → openrouter/qwen/qwen3.8-27b:free → nvidia/openai/gpt-oss-20b
```

That is, the **local coder that gives no tool call stood in 3rd place**, ahead of every other cloud
target — exactly the silent failure section 6d describes.

Meanwhile `chain-doctor.mjs` printed that *"no restart is needed"*. That statement **was wrong**, and
it caused the two-day staleness; fixed on 2026-10-01 (both the script and the `_napi_felulbiralat`
field of `config.json`).

**The rule:** after saving `config.json` (and thus `dailyOverrides` too) the proxy must be restarted:

```powershell
.\providers\run-proxy-service.ps1 -Stop
.\providers\run-proxy-service.ps1
```

`watchdog-subagent-proxy.ps1` also restores it by itself in a **60-second cycle** if `/healthz` does
not answer — but that can mean up to a minute of outage, and `proxy.pid` may contain a stale PID
during it.

**The watchdog works, but not instantly:** at the 2026-10-01 restart it detected the outage at
17:39:08, and the new chain was up by 17:39:12. Its log (`reports/proxy-watchdog.log`) writes only
the abnormal events.

**Two separate time limits** (this is the main design decision):
- `connectTimeoutMs` (120 s, 300 s for Ollama): how long we wait for the response *headers*. This
  decides the fallback. It is this long because a local model's cold start is 15–69 s by measurement.
- `stallTimeoutMs` (180 s): during streaming, how much silence before we give up.

**Proven behaviour** (live tests):
- A fallback branch dead endpoint → 401 → local Ollama: it walks through, the answer arrives.
- SSE streaming: chunks + `[DONE]` correctly.
- Tool calling on the real chain: `finish_reason: tool_calls`, correct arguments.
- It skips a provider with a missing key instead of dying on it.
- A model id with a slash/colon (`openrouter/qwen/qwen3.8-27b:free`) resolves correctly (it splits
  only at the first slash).

---

## 5. Monthly re-tuning (a scheduled task)

> **CURRENT SCHEDULE (2026-09-27):** two scheduled tasks, with an automatic switch-over:
>
> | Task | Cadence | When | Mode |
> |---|---|---|---|
> | `DSH model retune daily` | daily 09:00 | 2026-09-27 … **2026-10-04** | `apply` |
> | `DSH model retune weekly` | weekly, Mondays 09:00 | **from 2026-10-05** | `apply` |
>
> The daily task stops with `/ED 2026/10/04`, and the weekly one starts with `/SD 2026/10/05` — so
> the switch-over is **automatic**, no manual change is needed. Manual change, if needed:
> `.\schedule-retune.ps1 -Cadence Daily|Weekly`.
>
> **The task does three things** (`run-retune.ps1` does all three):
> 1. `retune.mjs` — discovering and fixing dead model ids,
> 2. `chain-doctor.mjs` — tuning the fallback chains (see below),
> 3. `clean-webview2-profiles.ps1` — cleaning the WebView2 profiles.

### The real content of the daily tuning: `chain-doctor.mjs`

`retune.mjs` only checks whether the configured model ids **exist**. That is little: a model can be in
the `/models` list and the call can still die (404 "not found for account", timeout, 429).

`chain-doctor.mjs` therefore **sends a real probe to every target** — a request requiring a tool call
— measures the response time, and sorts them into three categories:

| Result | Meaning |
|---|---|
| `OK` | it answered, and **called the tool** |
| `SLOW` | it answered, but > 5 s |
| `DEAD` | timeout, 429, 404, 5xx, or no key |

Then, with a **stable sort**, it puts the dead ones at the end of the chain, and within the same
category the faster ones first. Without `--apply` it only writes a report; the daily task runs it in
`apply` mode.

**In practice this gives a better order than manual configuration.** A measured example
(2026-09-27): instead of the hand-written chain
`nvidia/nemotron-3-super → nvidia/gpt-oss-20b → groq/gpt-oss-120b → …`, the doctor proposed and
applied this:

```
groq/openai/gpt-oss-120b (229 ms) -> nvidia/nemotron-3-super-120b-a12b (1193 ms)
  -> nvidia/openai/gpt-oss-20b (2095 ms) -> ollama/qwen2.5-coder:14b
  -> openrouter/qwen/qwen3.8-27b:free (DEAD: 429)
```

The local Ollama's cold start is 15–70 s, so the doctor uses a **separate, longer timeout** for it
(120 s), otherwise every local target would look dead.

The doctor's exit code is 1 if there is a dead target — so the Task Scheduler log also shows that
intervention is needed.

### Managing the scheduled task

```powershell
cd "C:\Szerver\Deepseek Harness\providers"

# state
schtasks /Query /TN "DSH model retune daily" /V /FO LIST
schtasks /Query /TN "DSH model retune weekly" /V /FO LIST

# run now
schtasks /Run /TN "DSH model retune daily"

# change the cadence (daily <-> weekly)
.\schedule-retune.ps1 -Cadence Daily
.\schedule-retune.ps1 -Cadence Weekly
.\schedule-retune.ps1 -Cadence Daily -DryRun    # report only

# delete
.\schedule-retune.ps1 -Remove
```

Log: `providers\reports\retune-scheduled.log`
Reports: `providers\reports\retune-*.md`, `providers\reports\chain-doctor-*.md`

### Why not DSH's built-in scheduler

`dsh-schedule` delivers reminders into a **live session**, at a fixed interval; with a closed session
it waits stale. That is not suitable for monthly/daily maintenance — the Windows Task Scheduler runs
independently of whether DSH runs.

---

## 5b. The relationship of the background service and the schedule

Two separate things, with **different jobs**:

| Service | What it is for | If it does not run |
|---|---|---|
| **Windows Task Scheduler** (`DSH model retune …`) | the daily/weekly tuning | no tuning |
| **Fallback proxy** (Startup shortcut) | serving the delegated requests | **every call of the children dies** (the parent's does not) |

The background service therefore does **not** run the tuning. That is the Task Scheduler's job, which
runs even without the proxy. The proxy is needed only for the subagent requests. The tuning also
queries the proxy's `/v1/models` endpoint; if the proxy is down, the `subagent-worker` row reports an
error in the report, but the script does not die.

---

## 5c. Workspace and approval

The session's workspace: **`C:\Szerver\Deepseek Harness`**. Writing **inside** it needs **no separate
approval** — measured:

```
write INSIDE the workspace   -> SUCCESSFUL
write into ~/.dsh            -> DENIED
```

The `providers\` folder is inside it, so every change here goes without approval. What **always**
needs elevated access, because it is outside the workspace:

| Path | Why |
|---|---|
| `~\.dsh\settings.yaml` | the live home of the providers and the allowlist |
| `~\.dsh\.credentials.yaml` | the keys |
| `~\.dsh\profiles\web\cordis.patch.yml` | the setting of the subagent route |
| `~\AppData\Roaming\...\Startup\` | the proxy's startup shortcut |
| `~\AppData\Local\npm-cache\...` | the stock preset (was needed only for testing) |

**The session's scope cannot be widened afterwards** — it is fixed at startup. `~\.dsh` is not
reachable under `C:\Szerver`, so it cannot be covered with a parent directory either; it would need
separate authorisation when DSH starts.

One warning: `state\webview2` **is inside** the workspace, yet deleting it asked for elevated access.
"Inside the workspace" is not a guarantee for every operation.

---

## 6. Subagent — the configured, working system

> **STATE: configured and proven live. Usable.**
>
> Delegated work goes on the `subagent-worker` route — to a local proxy that serves the `worker`
> chain on free providers. The main thread stays on the paid `deepseek-official` route.
>
> **Measured proof (2026-09-27):** the child session (`delegationDepth: 1`) used the
> `subagent-worker/worker` route, and according to the proxy log
> `HIT nvidia/nvidia/nemotron-3-super-120b-a12b` — **hit on the first try, for 0 USD**. The child
> also called a tool (`pwsh`), and the delegation finished in 11–14 s.
>
> **Code protection:** with `toolFilter` the child cannot reach the `write`, `edit` and
> `str_replace_editor` tools — it cannot modify a file. That is a physical limit, not a behavioural
> request.
>
> **The single weak point:** if the proxy does not run, every call of the children dies (the parent's
> does not). The proxy starts from the Startup folder at logon.
> **This weak point failed in production on 2026-09-29 — see section 6d.**

### 6d. The 2026-09-29 failure: two independent causes, measured

The report: "the automatic subagent delegation to a free model does not work, as if it had died after
one use; on top of that an ungrouped workspace appeared in the left sidebar". Both are true, but they
are **two separate failures**, and the second is not the delegation's fault.

#### A) The proxy died and did not restart

Measured facts:

| Evidence | Value |
|---|---|
| last line of `providers\proxy.out.log` | `2026-09-27T16:19:31Z FALLBACK nvidia/...` |
| `providers\proxy.err.log` | **0 bytes** — there was no error message |
| `providers\proxy.pid` → PID 240320 | a process that does not exist |
| port 4123 | not listening (nothing) |

So the proxy died **without any error message**, and the Startup shortcut (which runs once at logon)
did not bring it back. From then on the `subagent-worker` route did not answer: every call of the
child session died. That is the "died" symptom.

**Why the Startup mechanism is not enough:** it runs once and does not retry. The fix is therefore
**self-healing**: `watchdog-subagent-proxy.ps1` + an installer.

#### B) The second, more hidden failure: a silent slide to local Ollama

This occurs when the proxy **is running** but the provider keys did not resolve (e.g. because it was
started directly as `node proxy.mjs` instead of via `run-proxy-service.ps1`). In that case the old
`routeChain()` **silently skipped** the cloud providers, and the `worker` chain slid down to a single
element.

**Measured value (2026-09-29, proxy started without keys):**

```
time: 117668 ms                   <- 2 minutes of silence
model: qwen2.5-coder:14b          <- local Ollama
tool_calls: (empty)
content: {"name": "get_weather", "arguments": {"city": "Budapest"}}
```

The model did not give `tool_calls` but a **pseudo-call wrapped in content**. For DSH this is
unusable — it looks exactly like a "dead delegation", although the proxy "worked".

**Fix (code, not habit):** the `requiredAnyEnv` section of `config.json` states which route needs at
least one key. Without one, the proxy **does not fall back to the local one** but gives a 503:

```
route worker: (no usable target) [MISSING KEY: GROQ_API_KEY, NVIDIA_API_KEY, OPENROUTER_API_KEY]
```

The `local-only` route deliberately stays local. **Verified** (keyless start, 2026-09-29):
`verify-subagent-chain.mjs` reported with exit code 1 and the error `worker chain: empty`.

**The correct chain, measured with keys:**

```
time: 409-550 ms
model: openai/gpt-oss-120b        <- groq, free
tool_calls: {"name":"get_weather","arguments":"{\"city\":\"Budapest\"}"}
```

#### C) The "Ungrouped" group in the left sidebar — not a delegation failure

The "Ungrouped" group in the left sidebar shows those sessions that no workspace records
(`dsh-client-ui-workspace`: `groupByWorkspace` → `stray`). According to the measurement:

| Session | What it is | Registered? |
|---|---|---|
| 9 × `session-…` (09-27, 15:09–16:19) | the **parents** of the delegation tests, with an empty log | no |
| 9 × bare UUID (at the same time) | the corresponding **delegated children** (`origin: subagent`, `delegationDepth: 1`) | no |

The child's header shows the `cwd` and the `parentSession`, but neither is in the `sessionIds` list of
`storages\workspace.json` — the registry contains only the user-started sessions. That is why every
delegation adds a new, ownerless line to the group.

**Fix:** `classify-subagent-sessions.mjs` — it files the children under the parent's workspace. The 9
parents are themselves ownerless, so the `--adopt-parents` switch files those too (otherwise assigning
the children would not remove the ownerless line).

**Important:** DSH reads `workspace.json` **at startup**, so the change is visible in the sidebar only
**after a restart**.

#### D) The state of the fix and the limit

| Item | State |
|---|---|
| removing the silent slide in `proxy.mjs` | **done, measured** |
| `config.json` `requiredAnyEnv` | **done, measured** |
| `watchdog-subagent-proxy.ps1` detection + restart | **done, measured** |
| `verify-subagent-chain.mjs` | **done, measured** (both the OK and the error branch) |
| `classify-subagent-sessions.mjs` | **done, the report is measured** (the write has not run yet) |
| **starting the persistent watchdog process** | **the user has to run it** |

**The watchdog's measurement** (`reports\proxy-watchdog.log`):

```
2026-09-29T12:18:44+02:00 OUTAGE (#1): the proxy does not answer on port 4123 — restarting
```

The detection of the outage and the start of the restart are proven: the watchdog calls
`run-proxy-service.ps1` (which resolves the keys), and after the restart
`verify-subagent-chain.mjs` measured `openai/gpt-oss-120b`.

**The limit that could not be proven here:** a persistent process **cannot** be started from the DSH
sandbox. `dsh-subprocess-local` keeps every child in a Win32 Job object and kills the whole tree with
`terminateJob` at the end of the work — measured: both the watchdog and the proxy started with
`Start-Process` died at the end of the command. For the same reason the Task Scheduler could not be
written either (`schtasks /Create` → "Access is denied", even with elevated access).

That is why the installation is run **by the user** from an ordinary PowerShell window:

```powershell
cd "C:\Szerver\Deepseek Harness\providers"
.\install-subagent-proxy.ps1
```

`-WindowStyle Hidden` together with the detached start ensures that no window flashes up and that the
cycle runs independently of DSH. If house rules prevent even that: `.\start-watchdog.ps1`.

---

### How it works

In the stock **standard** preset the `subagent` tool is assembled like this:

```yaml
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    modelSelectionSettings: true    # ← this allows the per-model choice
    backgroundMode: continuable
```

Two mechanisms are available:

1. **Allowlist** (the `subagent-model-selection` settings namespace):
   `{ enabled: bool, allowedModels: [{ provider, model }] }`. This is a **host setting**, reachable
   under Settings → Plugins (or in YAML). **An important limit:** it restricts only the *explicit*
   model choice. It does not affect the inherited (non-explicit) route, because no model choice
   happened there. It rejects a duplicated route.
2. **Child default** on the tool's `agentOptions` field (`provider`, `model`, `reasoningEffort`,
   `maxTokens`). This is **deterministic**: every child gets it. It lives in the **agent-preset**
   composition, not in `settings.yaml` — so the standard preset's copy under
   `$DSH_HOME\.agent-presets` has to be edited.

### My proposal

> ⚠️ **This section is the proposal BEFORE the change: the description of the mechanism is correct,
> but the PLACE of the setting is wrong.** I wrote that `agentOptions` goes into the preset — the
> measurement disproved that. The right route is overriding by id in the profile patch, see the
> section **"The exact plan — PROVEN BY MEASUREMENT"**. The model choice below (which model for what)
> is still valid.

**Leave `subagent_fork` alone.** The fork deliberately inherits the parent's route so that the copied
conversation prefix stays KV-cache compatible. If you redirect it, you lose the cache match — the
saving evaporates.

**Point `subagent` at a free but provably tool-capable model.** The subagent runs a full agent loop
with tools, so weak tool calling is the most common source of failure. For this purpose these are
proven good in your configuration:

| Role | Provider / model | Why |
|---|---|---|
| Delegated work (default) | `groq` / `openai/gpt-oss-120b` | fast, free, provably tool-capable |
| Large-context researcher | `nvidia` / `moonshotai/kimi-k2.6` | 262k context, free |
| Code-specific | `openrouter` / `cohere/north-mini-code:free` | made for code |
| Confidential (must not leave the machine) | `ollama-local` / `qwen2.5-coder:14b` | local |
| Image + tool | `ollama-local` / `qwen3-vl:8b` | the only local one that does both |

**What NOT to put on the subagent:** `qwen2.5:7b-instruct` and the other small local models. They work
for a simple question but often break tool calling, and the subagent is exactly where that error is
the most expensive.

**The simplest route I propose:** Settings → Plugins → `subagent-model-selection` →
`enabled: true`, and the models above in the `allowedModels` list. This allows ad-hoc choice by the
working model but excludes the bad choices. If you want **deterministic** behaviour instead (every
child gets the same fixed thing), then you have to take the preset route: copy the standard preset's
`agent.cordis.yml` under `$DSH_HOME\.agent-presets\standard\`, and add this to the `config` block of
the `tool-subagent` row:

```yaml
    agentOptions:
      provider: groq
      model: openai/gpt-oss-120b
      reasoningEffort: low
      maxTokens: 32768
```

If you ask, I will assemble and configure this preset copy.

### Cost impact — measured data

Real consumption extracted from the `~/.dsh/sessions` logs (11 sessions, 2026-09-27):

| Metric | Value |
|---|---|
| Model calls | **3 143** |
| Fresh input | 5 680 032 tokens |
| Output | 1 966 671 tokens |
| **Prompt-cache read** | **1 081 724 032 tokens** |
| Cost at the `deepseek-flash` price | **$4.37** |
| The same at the `deepseek-v4-pro` price | $8.10 |
| Per 1000 calls | $1.39 |

Routes used: `deepseek-official/deepseek-flash` (70×), `deepseek-official/deepseek-v4-pro` (3×) —
**all paid, effort `high`**.

**69% of the cost is cache reading**, which is odd at first but explainable: DeepSeek cache reading is
**50× cheaper** than fresh input ($0.0028 vs $0.14 / 1M tokens). Without prompt cache the same
consumption would be **$152.79** — the cache **saves $148.41 (97.1%)**.

Two conclusions follow, and the second is the more important:

1. **Delegation's saving is modest compared to the main thread.** If you move 20–50% of the traffic to
   a free model, that is **$0.87–$2.19** out of today's $4.37. Real, but not dramatic.
2. **The cache must not be sacrificed.** Since the cache is a 50× multiplier, `subagent_fork`'s route
   inheritance is not a "missed saving" but the protection of the largest cost item. If you redirect
   the fork, the copied conversation prefix loses the cache match and you lose part of the 97%
   saving — that is easily more than you gain from the model swap.

**So the correct use is:** `subagent` is a cache-independent, standalone loop → put that on the free
model. `subagent_fork` carries the parent's context forward → leave that on the parent's route.

**And the most important thing:** the real stake is not `deepseek-flash`'s $4.37, but that someone can
switch to `deepseek-v4-pro` in a moment (2×), or that an effort- and context-raising setting can
multiply the consumption by 10×. The free quotas (Groq / NVIDIA / OpenRouter `:free`) are **$0.00** by
contrast — but they may use your data for training, and they are rate limited. For confidential work
local Ollama is the right target, not the free cloud.

### How much can be saved safely

**The measured baseline:** 3 143 model calls → **$4.37** (11 real sessions), i.e. **$1.39 / 1000
calls**. I checked the linearity of the cost model: the session-level sum came to $4.54 from an
independent calculation (the difference is the test runs and the sessions with one `?` provider),
which confirms the $4.37.

**Measured unit cost for one delegated call** (from the test):

| Route | Cost / call |
|---|---|
| `deepseek-flash` (inherited) | $0.00107 |
| `deepseek-v4-pro` (the test's target model) | $0.00331 |
| free (Groq / NVIDIA / OpenRouter `:free`) | **$0.00000** |

**The saving at today's volume:**

| Delegated share | Saving / run |
|---|---|
| 10% | ~$0.44 |
| 20% | ~$0.87 |
| 30% | ~$1.31 |
| 50% | ~$2.19 |

This is **a modest amount**, and it is worth saying out loud: the main item is not `deepseek-flash`'s
$4.37 but that a bad setting (Pro model, higher effort, larger context) can multiply consumption by
2–10×. The value of redirecting delegation is **predictability rather than saving**.

**The safe measure — measured limits.** Groq publishes the quota in the response headers:

```
x-ratelimit-limit-requests: 1000
x-ratelimit-limit-tokens:   8000      ← this is the bottleneck
x-ratelimit-reset-tokens:   ~0.7–4 s
```

- **8 000 tokens / minute.** By my measurements a delegated call is a few hundred – a few thousand
  tokens (without the parent's context), so the practical ceiling is roughly **10–20 calls / minute**.
  That is tight with parallel subagents, but plenty for one or two children.
- **1 000 requests / window.** I could not establish the window's length unambiguously
  (`reset-requests` starts from 13 minutes, but the limit is set to 1000, which suggests a daily
  quota). **I did not plan sustained load on it** — if delegation were thousands of calls a day, this
  would run out.
- **NVIDIA NIM:** it gives no rate-limit header, one call was 1.0 s, 82 models are reachable. That
  makes it **a better first choice** than Groq for larger delegation volume — but the quota is unknown
  there too, so it has to be measured under load.
- **OpenRouter `:free`:** without a balance it is very tight (on the order of 50 requests/day), so it
  is unsuitable for sustained delegation.

**The proposed safe setting:** allow delegation up to **~20–30%** of the model calls (≈ $0.9–1.3 / run
saving), put the target model primarily on **NVIDIA NIM** because of the larger volume, and keep Groq
for the fast, small tasks. The load is worth following by watching `proxy.mjs`'s `/healthz` and the
provider headers.

**What this does not solve:** the parent agent stays paid, and **all the coordination calls** of
delegation (calling the `subagent` tool, reading the result back, the possible follow-up) run on the
parent. So the upper bound of the real saving is not 100% but the share of delegated work minus the
coordination overhead.

> **IMPORTANT: my original proposal was wrong, and the measurement disproved it.** I wrote that
> `agentOptions` goes into the **preset's** `tool-subagent` row. That **does not work**. The right
> route is overriding by id in the profile patch. The section below contains the corrected, measured
> result.

**Step 1 — the current state.** `check-subagent.ps1` checks whether a target model is configured:

```
No subagent target model is configured.
This means: the subagent inherits the PARENT's route
(currently the agent-default-model: deepseek-flash).
```

**Step 2 — where it has to be configured.** This is the essence, and I measured it after three failed
attempts:

| Attempt | Result |
|---|---|
| `- insert:` into the profile patch | ❌ `duplicate loader entry id: tool-subagent` |
| `agentOptions` in the **preset's** `tool-subagent` row (my proposal) | ❌ the child got **the parent's model** |
| `agentOptions` as an **override by id** in the profile patch | ✅ **the child got the configured model** |

The reason: the `tool-subagent` row comes **from `dsh-base`** (line 349 of the base
`cordis.patch.yml`). The **web** profile makes this row `disabled: true` and leaves it to the preset —
so there the preset route would be right. The **headless** profile does not disable it, so there the
base's row wins and the preset's `agentOptions` never takes effect.

The correct setting goes into the profile's patch file (`cordis.patch.yml`):

```yaml
# Overriding by id replaces the row's ENTIRE config, so every key to keep has to be listed again.
- id: tool-subagent
  config:
    provider: spawn
    toolName: subagent
    modelSelectionSettings: true
    backgroundMode: continuable
    agentOptions:
      provider: groq
      model: openai/gpt-oss-120b
      reasoningEffort: low
      maxTokens: 32768
```

**Step 3 — the pitfall of `modelSelectionSettings`.** This key requires the
`@deepseek-ai/dsh-tool-subagent/model-selection-settings` plugin in the **Host scope**, otherwise the
boot dies:

```
tool-subagent: `modelSelectionSettings` requires
@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope
```

The web profile mounts it (the `subagent-model-selection-settings` row), the headless one does not. So
in the web profile this key **may stay**; if you ever configure it in the headless profile, either
mount the plugin too or leave the key out (`agentOptions` works on its own).

**Step 4 — the allowlist (optional).** The `subagent-model-selection` namespace in `settings.yaml`. It
**restricts only the explicit model choice** — it does not affect the inherited route, so without step
2 the largest part stays paid:

```yaml
subagent-model-selection:
  enabled: true
  allowedModels:
    - { provider: groq, model: openai/gpt-oss-120b }
    - { provider: nvidia, model: moonshotai/kimi-k2.6 }
    - { provider: openrouter, model: cohere/north-mini-code:free }
    - { provider: ollama-local, model: qwen2.5-coder:14b }
```

**Step 5 — verification.** `check-subagent.ps1` tries a real tool call for every target model.

### The measurement that proved the mechanism

Two headless runs, the same delegation task:

| Run | Parent | Child (`delegationDepth: 1`) |
|---|---|---|
| `agentOptions` in the preset | `deepseek-flash` | ❌ `deepseek-flash` (inherited) |
| `agentOptions` in the override by id | `deepseek-flash` | ✅ **`deepseek-v4-pro`** |

Read from the child sessions' `request/header` event. I deliberately set the target model to one
different from the parent's (Pro) so that the effect would be unmistakable.

### What I do NOT propose

- **Redirecting `subagent_fork`.** The fork carries the parent's context forward; losing the cache
  match costs more than the gain (see the cache calculation above).
- **The small local models** (`qwen2.5:7b-instruct`, `llama3.1:8b`) for delegation. The subagent runs a
  full agent loop; these break tool calling.
- **The preset route in the headless profile.** A measured failure, see above.

---

## 7. Tools

| File | Role |
|---|---|
| `check-providers.mjs` | Every provider: is the key alive, do the listed model ids exist |
| `check-ollama.mjs` | Which local Ollama model can do tool calling |
| `check-google.mjs` | Google: which model is callable and which can call tools |
| `check-subagent.ps1` | Is there a subagent target model, and is it fit for delegation |
| `retune.mjs` | The monthly re-tuner (`--apply` writes, without it only a report) |
| `clean-webview2-profiles.ps1` | Cleaning up the accumulated WebView2 profiles |
| `run-retune.ps1` / `run-retune.cmd` | The Task Scheduler's entry point (retune + cleanup) |
| `register-monthly-retune.ps1` | Registering/deleting the monthly task |
| `proxy.mjs` / `config.json` | The fallback proxy |
| `config.test.json` | A deliberately broken chain for testing the fallback |
| `settings.llm-pi-ai.yaml` | The provider template (with checked ids) |
| `README.md` | The operations guide |

## 8. Backups and restore

| File | Content |
|---|---|
| `~/.dsh/settings.yaml.bak-20260927-143052` | the settings.yaml BEFORE the fix |
| `~/.dsh/.credentials.yaml.bak-20260927-143052` | the credential store before the fix |
| `~/.dsh/settings.yaml.bak-<timestamp>` | made by the monthly re-tuner before every write |

Restore:

```powershell
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-20260927-143052" `
          "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

---

## 9. Open points

1. **I did not prove the runtime behaviour of `toolFilter`.** The profile loads with it (exit 0), and
   the child did call a tool — but I did not measure whether a write attempt is actually rejected. It
   is worth trying once with a delegation that tries to write.
2. **I did not test parallel delegation** in production, with several children starting at once. Groq's
   8 000 tokens/minute limit is the tightest there.
3. **`git push` died for lack of authentication** (`SEC_E_NO_CREDENTIALS`). The commit was made
   (`18e45bc`), but pushing needs a token or an SSH key.
4. **`DshWindow.exe` does not clean the WebView2 profiles.** This is not a configuration error but the
   program's behaviour: every window start creates a new `gen-*` profile. The daily task handles it,
   but the real fix would be in `src\DshWindow.cs` (deleting the old generation at startup, keeping
   the `pane-*` profiles). On 2026-09-27 a manual cleanup freed 2.1 GB.
3. **The fallback proxy is not running permanently.** It can be started by hand
   (`start-fallback-proxy.ps1`), but it has no entry in the logon startup. If needed, it can be solved
   following the tray icon's pattern.
4. **Google's models skipped because of quota/overload** (`gemini-3.5-flash`,
   `gemini-3.1-pro-preview`, …) stayed on the list; if they keep failing, the monthly re-tuner will not
   remove them, because they *exist* — they are just occasionally callable.
5. **The `dsh-local-ai` plugin** (Ollama management, pull/remove, `/ollama` command, local-first
   routing with fallback) is tested on `0.1.5-rc.2`, not guaranteed on `-rc.3`. Not installed.
6. **Upgrading to 0.1.7** would open up the `dsh-llm-fallbacks` and `dsh-autotier` plugins — then the
   proxy could be replaced. That is a separate decision, and the `dsh-ui-extras` patch would have to
   be re-checked too.
7. **Wiring Alibaba Cloud / Qwen — waiting for an API key (2026-10-01).** The reconnaissance is done,
   the installation is not: there is no `DASHSCOPE_API_KEY` in the credential store. All the material
   is in a separate document: **`providers/ALIBABA-QWEN-TERV.md`** — endpoints, region-bound key,
   models and prices, the concrete YAML for wiring it into DSH, the four known obstacles, and the
   measurement plan for the moment the key exists.

   The essence up front: Qwen is **functionally** deployable the same way (chat + tool calling +
   reasoning through `dsh-llm-pi-ai`), and it is clearly better in context and rate limit than
   DeepSeek — but it is **more expensive** (`deepseek-flash` off-peak is ~2× cheaper on input, ~2.5×
   on output, ~20× on cache hits), it has no native catalogue or price integration, and because of a
   documented `stream` + `tools` conflict it **needs a live probe before we build anything on it**.

---

## 10. The "DSH web server" — what it exactly is

Three separate things that are easy to confuse:

| Layer | What it is | Where it shows |
|---|---|---|
| **`dsh web`** | a Node process: the HTTP server + the Host (LLM, session, tools) | `state\harness.pid`, `state\harness.log` |
| **`DshWindow.exe`** | a WPF + WebView2 window that **displays** the server's URL | `state\window.log`, `Get-Process DshWindow` |
| **Tray icon** | Supervisor: starts/watches/restarts the server and the window | `state\tray.log` |

`DshWindow.exe` is **not** the server — the server may be down while the window is open, and vice
versa. The tray icon's `health check` lines measure the two separately (`server=`, `token=`).

### What is worth checking

**1. Is the server alive.** A request without a token gives `401` if the server runs — that is the
correct, expected answer:

```powershell
try { Invoke-WebRequest http://127.0.0.1:3080/ -UseBasicParsing -TimeoutSec 5 | Out-Null; "200" }
catch { "HTTP $($_.Exception.Response.StatusCode.value__)" }   # 401 = running
```

**2. Is the port listening.** `netstat` is more reliable than `Get-NetTCPConnection`:

```powershell
netstat -ano | Select-String ':3080'
```

> **A measured lesson:** on this machine `Get-NetTCPConnection` **gives an empty result without
> elevated rights**, which easily leads to the wrong conclusion that "the server is not running".
> `netstat` and the HTTP probe are the reliable methods.

**3. The logs, in order of importance:**

| File | What it tells you |
|---|---|
| `state\tray.log` | who started/restarted the server, and why |
| `state\harness.log` | the server's URL with the token |
| `state\harness.err.log` | the server's startup errors |
| `state\window.log` | the window's (WebView2) events |
| `state\harness.url.err` | **the actual startup error**, if there was one |

In `harness.url.err` an earlier start wrote this:

```
Error: EPERM: operation not permitted, open '%USERPROFILE%\.dsh\profiles\web\cordis.yml'
```

This is **not** the current state but the remnant of an old start that died for a permission reason —
exactly the error class I also ran into because of the sandbox. The log says which start it was.

**4. The health check's log.** The tray measures the server and the token every 4 seconds. The
`2026-09-27 12:44:22 health check: server=False token=True` line records a **momentary** state; the
`server=True token=False` case, however, starts an automatic restart
(`automatic self-healing: restart`). This mechanism works — it also ran at 10:42:05.

### The actual current state (2026-09-27)

- Server: **running** (PID 223424, `127.0.0.1:3080` LISTENING, HTTP 401 against a tokenless
  request).
- Window: **running** (PID 149712, on the `pane-1`/`pane-2` profiles).
- Tray: running (last log line 12:44:22).
- `state\webview2`: 2.2 GB → **95 MB** after the cleanup.

### What is worth looking at regularly

- the size of `state\webview2` — if it grows again, the monthly task handles it, but the real fix would
  be in `DshWindow.cs` (see point 2 of section 9).
- the size of `state\*.log` — `window.log` and `ui-extras-client.log` grow; `window.log.1` rotation
  exists, `ui-extras-client.log` has none.
- `providers\reports\retune-scheduled.log` — the result of the monthly maintenance.

---

## 11. Delegation in the statistics and the automated runs' channel (2026-09-30)

**The report:** "the free delegation's data does not appear in the statistics, there are constant,
burned-in numbers at the subagent cost part; and automation scatters a bunch of sessions onto the
list."

### 11.1 The measured cause — not a burned-in number but a combined one

The live answer of `/ui-extras/usage?days=30` and the session logs agreed:

| Fact | Value |
|---|---|
| Delegated request (30 days) | 284 / 7204 (3.9%) |
| Of which **on the free chain** (`worker`) | **10 requests, 5 sessions — $0.0000** |
| Of which **on a paid route** (`deepseek-flash`, `deepseek-v4-pro`) | 274 requests — $0.3019 |
| Last delegation | **2026-09-29 10:44** (none since) |

The old interface washed the two into a single "Delegated cost / baseline" line: $0.3019 vs $0.3108 →
$0.0089 saving, in which the 274 paid requests suppressed the 10 free ones. That is why it looked like
"there is no free delegation", and because there had been no new delegation since 09-27/09-29, the
number really was frozen.

**Fix** (`plugins\dsh-ui-extras\lib\index.js`, `scanUsage`):
- a `delegated.free` / `delegated.paid` pocket (request, token, cost, baseline, session) — the split is
  based on the **zero-priced price-table row** (`isFreeModel`), not on guessing the model name. An
  unknown model falls on the Flash row, so it never becomes "free".
- `delegated.freeSavingsUsd` — the real saving (only from the 0-priced requests).
- `delegated.models` — a per-model breakdown (with a `free` marker).
- `delegated.lastAt` — the time of the last delegated request, so old data does not look burned in.
- The client (`lib\client.js`) shows the two pockets on separate lines, and **falls back** to the old
  combined line if the host half is still the old one (the breakdown is not in it).
- `tools\check-usage.mjs`: new checks for the consistency of the breakdown (the sum of the pockets =
  the delegated total, the free pocket's cost is 0, the model markers are correct).

### 11.2 The source of the list garbage — the headless run's own session

In the log of `session-24fa376c` (09-27 08:43) the evidence is there: the delegation tests were started
with `dsh\lib\bin.js` **headless runs**, each creating a **top-level session** in the project's
directory (09-27 15:09–16:19, 9 of them, with "Delegate … via subagent" titles in the sidebar). The 10
real subagent children are **not** visible in the sidebar: `sessionVisible()` of
`dsh-client-ui-workspace` excludes the `origin: "subagent"` rows. So the garbage is the headless
**parents**.

**Fix:**
- `providers\run-headless-task.ps1` — the headless run starts from the dedicated `.automation`
  directory and registers it as a separate workspace before the run, so the machine sessions go into a
  separate group (DSH's bootstrap makes a separate workspace out of every directory that has a session
  anyway).
- `providers\session-channel.mjs` — reporting, hiding (`--hide`) and bringing back (`--unhide`) the
  existing machine sessions, plus registering the channel (`--channel`).
- Host route: `GET/POST /ui-extras/workspace-session` in the `dsh-ui-extras` plugin (`archive` /
  `unarchive` / `workspace`). It is host-side because DSH reads `storages\workspace.json` **only at
  startup**: the running host keeps the registry in memory, so a manual file edit would be overwritten
  by the next registry write. Archiving goes through the running registry, so it is immediate and
  durable.
- Archiving is **not deletion**: `archivedSessionIds` only removes the session from the sidebar and
  from search, the log stays in place — the 30-day statistics still count it. So the two goals do not
  conflict.
- **Limit:** this DSH build has no `unarchiveSession` on the registry, so bringing it back uses the
  registry's `setState` (it only removes the id from the archive and does not touch the order). If a
  future build stores the state differently, this route errors — the other routes stay untouched.

### 11.3 What to know for going live

- A new version of the **host half** only loads with a **server restart**; the client half with a
  reload.
- In the headless profile `tool-subagent` comes from `dsh-base`, so there the child inherits the
  **parent's route** (paid). For the free chain:
  `run-headless-task.ps1 -Patch providers\test-subagent-worker.patch.yml`.
- The channel directory (`.automation`) is in `.gitignore`.

### 11.4 The root cause: a child started from the GUI NEVER gets the free route (2026-09-30)

This section **refines** section 6's earlier conclusion: there the silent slide of the proxy appeared
as the cause of the outage. The proxy has been healthy since then
(`verify-subagent-chain.mjs`: a real tool call in 461 ms, Groq `openai/gpt-oss-120b`), yet the
children do not run on the free chain.

**The measured facts:**

| Evidence | Value |
|---|---|
| Last **free** delegation | **2026-09-27 16:19** (none since) |
| All the free requests | 10 requests / 5 children — **all from the 09-27 headless tests** |
| The 09-29 "connectivity probe" child | `deepseek-flash` (paid) |
| The 2026-09-30 probe child started from the GUI | `deepseek-flash` (paid), 1 request, $0.00006 |
| `subagent` tool calls in the last 36 hours | **1** (09-29 12:44) — there is no automatic delegator |

**The cause:** in the web profile the `tool-subagent` row comes **from the preset**. The
`@deepseek-ai/dsh-web-app/cordis.patch.yml` disables the host-plane row:

```yaml
- id: tool-subagent
  disabled: true
```

and the agent gets the **standard preset's** row, which does not contain `agentOptions`:

```yaml
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelectionSettings: true
        backgroundMode: continuable
```

Without `agentOptions` the child inherits the **parent's route** (per the tool's documentation:
"Providers without these defaults use compatible values from the parent's latest logged request") —
and the GUI's parent is `deepseek-official/deepseek-flash`. Overriding `tool-subagent` in
`~/.dsh/profiles/web/cordis.patch.yml` is therefore **ineffective**: it patches a disabled row, which
the preset's row overrides.

The earlier "the preset route does not work" measurement was misleading: it was made in a **headless**
run, where the preset system is not mounted (`tool-subagent` comes from `dsh-base`), so there only the
profile patch (`--patch`) counts. The two profiles use two different mechanisms.

**The fix** (`providers\install-free-preset.mjs`):
- a copy of the `standard` preset under the id `standard-free` into `<DSH_HOME>\.agent-presets` (the
  built-in root wins the duplicated id, so it cannot be overridden, only copied),
- `agentOptions: { provider: subagent-worker, model: worker, maxTokens: 32768 }` in the
  `tool-subagent` row's config,
- with `--default`, `agent-presets: default: standard-free` into `settings.yaml` (with a backup).

**Live effect:** the preset roster is read per call (`list() → discoverPresets`), and the default comes
from the hot-reloaded settings (`defaultId`) — so **no restart is needed** for it. Conversations
already running stay on their own preset; new conversations start on `standard-free`.

**Check:** `node providers\check-delegation-route.mjs --hours 24` — it tells you which child ran on
which route. The expected result in a new conversation: `worker / subagent-worker` (free), not
`deepseek-flash`.

**A risk to know:** the `worker` route points at the local proxy, and the DSH retry does not switch
providers — if the proxy is down, the child's call **dies** (it does not fall back to paid). The
watchdog watches it every 5 seconds; the outage is visible in `providers\reports\proxy-watchdog.log`.

---

## 12. "The free delegation froze again" — the route is not behaviour (2026-10-04)

**The report:** "the free delegation froze again. even though I used the interface all day, no data
appeared for it for a day."

### 12.1 The measurement — nothing froze

Every value measured around 2026-10-04 06:46 (local):

| What I looked at | Measured value |
|---|---|
| Proxy `/healthz` | `ok: true`, `usable: true`, `workerUsable: true`, all 4 providers with a key |
| The `worker` chain | nvidia gpt-oss-20b → nvidia nemotron-3-super → groq gpt-oss-120b → openrouter qwen3.8-27b:free → ollama |
| Watchdog | running (PID 48004); last outage **2026-10-01 17:39** |
| Chain-doctor (10-03 09:01) | every cloud target OK, with a real tool call (305–964 ms) |
| `/ui-extras/usage?days=30` | live: 13 564 requests, delegated 366 — of which free **91 requests / 23 sessions** |
| Last free delegation | **2026-10-03 07:53** (local) |
| `subagent` tool calls in the last 24 hours | **0** (none after the 07:53 one) |
| Child sessions in the last 24 hours | 1 (the 07:53 one, with 3 requests) |
| Session presets (72 hours, 34 sessions) | 33× `standard-free`, 1× `standard` (09-29) |

So the statistics were live, there was just nothing to count: using the interface drives the **paid main
thread** (10-03: 1 810 requests, $3.21), and the free chain only counts when the model calls the
`subagent` tool.

**Evidence that the chain is alive:** during the investigation a probe delegation ran from this GUI
session (2026-10-04 06:48:43). The child `f6e4e7cd-a510-46c6-8d0e-aa8fa1344acb` made 3 requests on the
`worker` route for $0.0000, and the `/ui-extras/usage` answer moved from **91 to 94** free requests,
with `lastAt` stepping to 2026-10-04 06:49:04. The panel polls every 60 s, the host scans every 120 s,
so the delay is at most ~2 minutes — there is no question of a "freeze".

### 12.2 The root cause — the route is only a possibility, not behaviour

The `standard-free` preset installed in 11.4 correctly sets the child's route
(`agentOptions: subagent-worker/worker`), and the 10-01 measurements prove that the chain works for
free (81 requests / 18 children). **Nothing, however, told the main model to delegate at all**: for most
of the day all the work runs on the main thread, so no free data is generated. This is the second time
for the same report (cf. 11.1), so this time the fix targets **behaviour**, not the display.

### 12.3 The fix — a delegation directive in the persona row

`providers\install-free-preset.mjs` got a second, equally strictly checked patch next to the
`tool-subagent` one: the `DELEGALAS-IRANYELV` text goes into the `suffix` of the preset's `persona` row
(keeping the `{{cwd}}` line, as a `|-` block scalar; if the source suffix is not a plain scalar, the
script throws and does not write). The text:

- what the free chain is, and why it is worth delegating to it (the main thread is the paid one),
- **when** to delegate: surveying, multi-file search, log/data scanning, verifying a claim, independent
  review, parallelisable pieces,
- **what stays on the main thread**: the user's decision, a 1–2 call step, file modification, and
  anything that cannot be verified from the child's summary,
- how to give the task (a complete, standalone prompt — the child does not see the conversation and runs
  on a weaker, free model),
- to indicate in the answer that the work went on the free chain.

The installer's checks extend to it (`persona row: present`, `delegation directive: true`), and
`--verbose` prints the patched persona block.

**Going live (2026-10-04 06:54):** a backup
(`~\.dsh\.agent-presets\standard-free.bak-20261004-065408`), then
`node providers\install-free-preset.mjs --apply --force`. I checked the generated YAML by parsing it
with DSH's own `yaml` package: the persona block both as a separate document and the full composition
are flawless (the `suffix` is a 1 361-character string, the `prefix` untouched).

**What to know:** the persona row is part of the system prompt, so the directive is valid only in
conversations **started after** the installation; running conversations keep their own prompt. The text
is editable in one place, in the `DELEGATION_GUIDANCE` array of `providers\install-free-preset.mjs`, and
can be reinstalled with `--apply --force`.

### 12.4 What is still true

- The chain **does not fall back to paid**: if the proxy is down, the child's call dies. So increasing
  delegation also increases the proxy dependency — the watchdog and `verify-subagent-chain.mjs` remain
  the check.
- `check-delegation-route.mjs --hours 24` is the measuring tool: if there is no free child there at the
  end of a day, then either no delegation happened, or the proxy/chain is faulty. The two are separated
  by `verify-subagent-chain.mjs` and `reports\proxy-watchdog.log`.
- The directive **does not** force delegation at every step: the decision, the file modification and the
  answer to the user deliberately stay on the main thread, because the child runs on a weaker (free)
  model.
