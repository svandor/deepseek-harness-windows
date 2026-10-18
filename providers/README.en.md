# Provider extensions for DeepSeek Harness

> Hungarian version: [`README.md`](README.md).

This folder holds DSH's multi-provider setup: local Ollama, free cloud providers, and an automatic
fallback proxy.

**Starting point:** DSH `0.1.5-rc.3`; the `dsh-llm-pi-ai` adapter is already mounted in `dsh-base`,
just **dormant** (zero routes) until a `llm-pi-ai:` section exists in `~/.dsh/settings.yaml`. No
restart is needed: the config takes effect on the next request.

> **The full record:** [`FELJEGYZES.md`](FELJEGYZES.md) — the starting point, the measured results,
> the fallback proxy design, the monthly re-tuning and the subagent proposal in one document.

> **Schedule:** `DSH model retune daily` every day at 09:00 (2026-09-27 … 10-04), after which
> `DSH model retune weekly` automatically runs on Mondays at 09:00. Both run in `apply` mode. Manual
> change: `.\schedule-retune.ps1 -Cadence Daily|Weekly`.

> **Daily tuning:** `chain-doctor.mjs` sends a tool-call-requiring probe to every target and sorts the
> dead/slow targets to the end of the chain. It also runs in the daily task. By hand:
> `node chain-doctor.mjs [--apply]`.

> **Subagent:** configured and proven live. Delegated work goes on the `subagent-worker` route (free
> chain), the main thread stays paid. The child's `write`/`edit` tools are denied by `toolFilter`.

> **⚠️ Keeping the proxy alive (2026-09-29):** the proxy died on 2026-09-27 without any error
> message and did not restart — from then on delegation "stalled". The fix is a **self-healing
> watchdog**, which has to be installed once from a normal PowerShell window (a persistent process
> cannot be started from the DSH sandbox):
>
> ```powershell
> cd "C:\Szerver\Deepseek Harness\providers"
> .\install-subagent-proxy.ps1
> ```
>
> Check at any time: `node verify-subagent-chain.mjs`

> **"Ungrouped" in the left sidebar:** delegated child sessions are not in the workspace registry, so
> they appear ownerless. Fix (report first, then write + DSH restart):
>
> ```powershell
> node classify-subagent-sessions.mjs
> node classify-subagent-sessions.mjs --apply --adopt-parents
> ```

---

## The three options

| # | Method | What it is good for | Needs |
|---|---|---|---|
| 1 | **Native `llm-pi-ai` provider** | Local Ollama, free cloud quotas, custom gateways | Nothing — just YAML or the GUI |
| 2 | **Fallback proxy** (`proxy.mjs`) | Automatic switch on a provider failure, even on 0.1.5 | Node ≥ 18 |
| 3 | **Community plugin** | Auto tier-routing, a rich fallback chain, cooldown | Upgrading DSH to **0.1.7** |

Options 1 and 2 work **side by side**: you can use the providers directly, and the proxy for the
critical chain.

### Why not a plugin (for now)?

`dsh-llm-fallbacks`, `dsh-autotier` and `dsh-model-router` all target the 0.1.6/0.1.7 generation. In
0.1.6 the `@deepseek-ai/dsh-settings-file` and the `ctx.settings.register` seam **disappeared**
(replaced by `SettingsForms`), so these plugins explicitly do not support the 0.1.5 line. If you
ever upgrade to 0.1.7 they open up — until then the proxy provides the same function.

---

## Step 1 — wiring the providers

Copy the content of `settings.llm-pi-ai.yaml` into `~/.dsh/settings.yaml`, **next to** the existing
keys (at the same level). The file's current content looks something like this:

```yaml
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
ui-theme:
  preference: dark
ui-conversation:
  busyEnter: steer
locale:
  preference: hu
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: high
# ... the llm-pi-ai: block goes here ...
```

**Keys.** Two modes; `settings.yaml` never contains a secret:

- **Web GUI (recommended):** Settings → Models → type into the *API key* field on the provider's
  row. The key goes into `~/.dsh/.credentials.yaml` in a write-only way.
- **Environment variable:** set it for the harness process (`GROQ_API_KEY`, `CEREBRAS_API_KEY`,
  `OPENROUTER_API_KEY`), and `apiKeyEnv` refers to that name.

The local Ollama server **also asks** for a key on the OpenAI-compatible route, which is why the
placeholder is needed (`OLLAMA_LOCAL_API_KEY` = `ollama`). This is the cause of the most common
failure: without a key the answer is `MISSING_CREDENTIAL` / 401.

Check:

```powershell
# is the Ollama OpenAI-compatible endpoint alive?
curl.exe -s http://127.0.0.1:11434/v1/models
```

---

## Step 2 — the fallback proxy (optional, but this gives the automatic switch)

### What it can do

- **One** OpenAI-compatible endpoint for DSH, with a **chain** behind it.
- If a provider gives 429 / 401 / 5xx / a network error **before the first token**, it moves to the
  next one. The conversation is not broken.
- **Streaming** (SSE) and **tool calling** pass through completely — the DSH agent loop works
  unchanged.
- `GET /v1/models` → DSH's *Fetch available models* button sees the virtual route names.
- `GET /healthz` → shows which provider has a key and what the actual chain is.
- It **skips** a provider with a missing key instead of dying on it.

### Starting

```powershell
cd "C:\Szerver\Deepseek Harness\providers"

# foreground (Ctrl+C = stop)
.\start-fallback-proxy.ps1

# background, with a PID file
.\start-fallback-proxy.ps1 -Background
.\start-fallback-proxy.ps1 -Stop

# another port
.\start-fallback-proxy.ps1 -Port 4124
```

By default the proxy listens on `127.0.0.1:4123`. The `providers` section of `config.json` gives the
endpoints, the `routes` section the chains — the route names appear as models in DSH:

| Route | Chain |
|---|---|
| `deepseek-chat` | Groq → Cerebras → OpenRouter → Ollama |
| `fast-chat` | Groq (8B instant) → Cerebras → Ollama (7B instruct) |
| `local-only` | local Ollama only (data never leaves the machine) |

Targets must be given in `provider/model` form, and resolution **splits only at the first slash** —
so ids containing a slash and a colon are also correct
(`openrouter/deepseek/deepseek-chat-v3.1:free`, `ollama/qwen2.5:7b-instruct`). `baseURL` may be
given with or without `/v1`; the proxy does not duplicate the segment.

### Timing — two separate limits

This is the proxy's most important design decision:

- **`connectTimeoutMs`** (default 120 s, 300 s for Ollama): how long we wait for the response
  *headers*. This decides the fallback. It is this long because a local model's **cold start** is
  easily 15–70 s (measured: `gpt-oss:20b` 69 s cold, 9 s warm). With too short a value the chain
  needlessly moves on to an idle provider.
- **`stallTimeoutMs`** (default 180 s): during streaming, how much silence before we give up on a
  stuck generation. This is **not** the total generation time.

### Testing

```powershell
# status and the actual chain
curl.exe -s http://127.0.0.1:4123/healthz

# available virtual models
curl.exe -s http://127.0.0.1:4123/v1/models

# what to call (non-stream)
curl.exe -s -X POST http://127.0.0.1:4123/v1/chat/completions `
  -H "content-type: application/json" `
  -d '{\"model\":\"fast-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}]}'
```

`config.test.json` describes a deliberately broken chain (dead endpoint → bad key → real Ollama),
with which the fallback can be verified under realistic conditions:

```powershell
$env:OLLAMA_LOCAL_API_KEY='ollama'
node proxy.mjs --config config.test.json
```

### Alternative: LiteLLM

If you want a ready-made solution instead of the proxy, `requirements-litellm.txt` and
`litellm-config.yaml` provide the same with LiteLLM. **Important:** a pip install writes into the
user's `Temp` folder, which the DSH sandbox blocks in `workspace-write` mode — so install it into a
**venv** inside the workspace:

```powershell
cd "C:\Szerver\Deepseek Harness\providers"
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-litellm.txt
$env:GROQ_API_KEY='...'; $env:CEREBRAS_API_KEY='...'
.\.venv\Scripts\python.exe -m litellm --config litellm-config.yaml --port 4123
```

LiteLLM can do more (spend tracking, virtual keys, an admin UI, auto-router), at the cost of more
dependencies and being tied to the Python version. `proxy.mjs` is smaller, more transparent, and does
exactly what is needed here.

---

## Step 3 — bringing free models in for simple tasks

This part **does not need the proxy**, only the providers:

- **Subagent model rule** — Settings → Plugins: enabling `subagent-model-selection` lets you specify
  which providers the subagent may delegate to. So the main orchestrator stays on DeepSeek, and the
  `subagent`/`workflow` fan-out goes to a free model.
- **Session-level switching** — with the `/model` selector you can switch per session. Existing
  sessions keep their starting model, so the history is not rewritten.
- **Cheap lanes** — compaction and session-title generation are separate host seams; these run the
  most and need the least intelligence, so it is worth pointing them at a free model.
- **Reasoning effort** — the Models page deliberately does not offer a provider-level control,
  because that is a model capability: an unsupported level gives an `UNSUPPORTED_REASONING_EFFORT`
  error. For models known from the catalogue this is automatic.

### Recommended split

| Task | Model |
|---|---|
| Orchestration, planning, hard decisions | `deepseek-official` (stays) |
| Subagent fan-out, search, summarising | `groq` / `cerebras` (free) |
| Compaction, title generation | Groq's smallest model or `ollama-local` |
| Confidential code (must not leave the machine) | `ollama-local` |
| Vision (image) | `qwen3-vl:8b` or `minicpm-v:latest` (local) |

---

## Checker scripts

A configuration can look fine on paper while the model ids it lists no longer exist at the provider.
These scripts filter that out:

```powershell
cd "C:\Szerver\Deepseek Harness\providers"

# Every llm-pi-ai provider: is the key alive, and do the listed model ids exist?
node check-providers.mjs
node check-providers.mjs --verbose     # the provider's full model list

# Which local Ollama model can do tool calling? (this decides which can be used in an
# agent loop at all)
node check-ollama.mjs

# Google: which of the models in the /v1/models list can ACTUALLY be called, and which
# can call tools?
node check-google.mjs
```

`check-providers.mjs` reads the keys from `~/.dsh/.credentials.yaml` and queries the providers'
**live** `/v1/models` endpoint. It never prints the keys (only masked). `check-ollama.mjs` looks at
the `capabilities` field of Ollama's `/api/show`: if it does not contain `tools`, the model will not
call a tool in an agent loop.

### Measured result (2026-09-27)

On that day, of the 88 models listed, **15 were unusable**: 10 did not exist at the provider, and a
further 5 existed in the list but the call failed with 404 or 400 (see the Google section).

| Provider | Did not exist / not callable | Instead |
|---|---|---|
| groq | `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `qwen/qwen3.6-27b` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` |
| openrouter | `minimax/minimax-m2.7:free`, `minimax/minimax-m3:free`, `z-ai/glm-5.2:free` | `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free` |
| nvidia | `deepseek-ai/deepseek-v4-flash-0731`, `deepseek-ai/deepseek-v4-pro-0813`, `minimaxai/minimax-m3` | `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k3` |
| google | `gemini-3.1-flash-live-preview`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`, `deep-research-*-preview-04-2026` | `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-flash-latest` |

**The fix has been made** in `~/.dsh/settings.yaml` (backup: `settings.yaml.bak-20260927-143052`).
The check afterwards:

```
All good: 5 providers checked, no bad model ids.
```

**The lesson:** the pi-ai catalogue's built-in model list and the provider's live list regularly
differ — and the existence of a list entry does not mean the model is callable. That is why the GUI's
*Fetch available models* button should be used, and then checked with `check-providers.mjs`.

### Google: two routes, and only one is good

Google has **two** call routes, and this decides whether tool calling works:

| Route | Protocol | Tool calling | Used by |
|---|---|---|---|
| **Native** `/v1beta/models/<m>:generateContent` | `google-generative-ai` | ✅ `get_weather({"city":"Budapest"})` | **DSH's catalogue route** |
| OpenAI-compatibility `/v1beta/openai` | `openai-completions` | ❌ calls no tool, empty content | only the proxy could use it |

Measured result with the same models:

- **Native route:** `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-flash-latest` → all return
  the `functionCall` correctly.
- **OpenAI-compatibility layer:** the reasoning models (`gemini-3.8-flash`) give **empty `content`**,
  and the Gemma models **leak a raw `<thought>` block into `content`**. The tool call was created in
  neither case.

**Consequence:** DSH must use Google on its **native catalogue route** (that is the default
behaviour, nothing to configure), and it must **not** be wired into the fallback proxy. That is why
there is no Google provider in `config.json` — the proxy works exclusively through OpenAI-compatible
endpoints.

### Google: the existence of the list does not mean it is callable

`/v1/models` returns 50 models with your key, but of those **only 11 are actually callable**.
`check-google.mjs` measures this. Of the 21 listed, 5 were unusable:

| Model | Error |
|---|---|
| `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro` | **404 — "no longer available to new users"** |
| `deep-research-max-preview-04-2026`, `deep-research-preview-04-2026` | 400 — "This model only supports Interactions API" |

These were removed. In addition, these did not answer temporarily because of quota (429) or
overload (503): `gemini-3.1-pro-preview`, `gemini-3.1-pro-preview-customtools`,
`gemini-3.1-flash-lite-image`, `gemini-2.5-computer-use-preview-10-2025`, `gemini-3.5-flash` — they
stayed on the list, because the failure is not permanent.

These Google models are proven to be **callable**:

```
gemini-3-flash-preview        gemini-3.1-flash-lite      gemini-3.1-flash-lite-preview
gemini-3.5-flash-lite         gemini-3.6-flash           gemini-3.7-flash
gemini-3.8-flash              gemini-flash-latest        gemini-flash-lite-latest
gemma-4-26b-a4b-it            gemma-4-31b-it
```

### Google key — an important distinction

The Google key is an **API key**, not an OAuth token. Measured result with the same key:

| Authentication | Result |
|---|---|
| `?key=<key>` query parameter | ✅ HTTP 200 |
| `x-goog-api-key: <key>` header | ✅ HTTP 200 |
| `Authorization: Bearer <key>` | ❌ HTTP 401 |

pi-ai uses the official Google SDK, which sends the `x-goog-api-key` header — so that is the right
route. If you ever get a 401 from Google, it is almost certainly not this bug but an expired or
revoked key.

### Local models and tool calling

Measured data: of the 18 local models, **11 can do tool calling**. Only these can be used in an
agent loop.

| Model | tool | sees | thinks | GB |
|---|---|---|---|---|
| `gpt-oss:20b` | ✅ | — | ✅ | 12.8 |
| `qwen2.5-coder:14b` | ✅ | — | — | 8.4 |
| `qwen2.5:14b` | ✅ | — | — | 8.4 |
| `deepseek-r1:14b` | ✅ | — | ✅ | 8.4 |
| `mistral-nemo:latest` | ✅ | — | — | 6.6 |
| **`qwen3-vl:8b`** | ✅ | ✅ | ✅ | 5.7 |
| `llama3.1:8b` | ✅ | — | — | 4.6 |
| `qwen2.5:7b-instruct` | ✅ | — | — | 4.4 |
| `glm-ocr:latest` | ✅ | ✅ | — | 2.1 |
| `minicpm-v:latest` | ❌ | ✅ | — | 5.1 |
| `llava:13b` | ❌ | ✅ | — | 7.5 |
| `deepseek-coder-v2:16b` | ❌ | — | — | 8.3 |
| `gemma2:9b` | ❌ | — | — | 5.1 |
| `moondream:latest` | ❌ | ✅ | — | 1.6 |
| `qwen2.5-coder:1.5b-base` | ❌ | — | — | 0.9 |
| `nomic-embed-text:latest` | ❌ | — | — | 0.3 |

Two traps worth keeping in mind:

- **`llava:13b` and `minicpm-v` see but cannot call tools** — they are unusable in an agent loop,
  despite being vision models.
- **`qwen3-vl:8b` is the only local model that both sees *and* can call tools.** That is why it is
  the only local candidate for vision tasks.

---

## Known pitfalls

1. **Ollama asks for a key too** on the OpenAI-compatible route → a placeholder is needed.
2. **`*-base` Ollama models are raw language models**, not instruct ones. Unusable in an agent loop
   (measured example: `qwen2.5-coder:1.5b-base` answered a trivial request with "I have no idea what
   this means!"). Use only the instruct variant.
3. **Reasoning models swallow the token budget.** `gpt-oss:20b` with a 24-token `max_tokens` gave
   empty `content`, because it ran out on its reasoning. Give at least 16384, or use a non-reasoning
   model for simple work.
4. **The model id must be exactly the Ollama tag** (`ollama list`), e.g. `qwen2.5:7b-instruct`,
   `gpt-oss:20b`.
5. **Vision has to be explicit**: `input: [text, image]` in the model entry, otherwise the attached
   image does not go through.
6. **Small local models drop the tool call more often.** The proxy does pass the `tool_calls` deltas
   through (verified), but the model's decision is the narrow cross-section.
7. **The free quotas change.** The model ids in `settings.llm-pi-ai.yaml` are starting points; the
   authoritative list is always the provider's `/v1/models` endpoint.
8. **The proxy is one provider in DSH's eyes** → DSH does not see the real upstream metadata but the
   `contextWindow` / `maxTokens` values given in `config.json`. Keep these maintained.
9. **You cannot rewind during a stream.** If the error comes *after* the first token, the proxy
   signals the error in the stream but cannot switch to another provider. This is the same limit
   `dsh-llm-fallbacks` documents.
10. **`dsh` is not on the PATH.** The CLI has to be called from the tray's "dsh path…" setting or
    from the `bin\` directory (e.g. `dsh plugin --profile web add …`).

---

## Files

| File | Role |
|---|---|
| `settings.llm-pi-ai.yaml` | The provider block to copy into `~/.dsh/settings.yaml` (with checked ids) |
| `check-providers.mjs` | Every provider: is the key alive, do the listed model ids exist |
| `check-ollama.mjs` | Which local model can do tool calling |
| `check-google.mjs` | Google: which model is callable and which can call tools |
| `proxy.mjs` | The fallback proxy (zero dependencies, Node ≥ 18) |
| `config.json` | The proxy's live configuration (providers + routes) |
| `config.test.json` | A deliberately broken chain for testing the fallback |
| `start-fallback-proxy.ps1` | Start/stop script |
| `litellm-config.yaml` | A LiteLLM alternative to the proxy |
| `requirements-litellm.txt` | LiteLLM dependency (into a venv) |
| `run-headless-task.ps1` | An automated (headless) run in its own channel (`.automation`) |
| `session-channel.mjs` | Reporting, hiding/unhiding and registering the machine runs' sessions |
| `setup-automation-channel.ps1` | In one command: host-half check + channel registration + hiding the existing machine sessions |
| `install-free-preset.mjs` | `standard-free` preset: children started from the GUI on the free chain (`agentOptions`) |
| `check-delegation-route.mjs` | Which child ran on which route (free/paid), and what it cost |
| `ALIBABA-QWEN-TERV.md` | **A prepared plan** for wiring Alibaba Cloud / Qwen (waiting for an API key): endpoints, prices, DSH YAML, known obstacles, measurement plan |

The backups made in `~/.dsh` of the state before the fix: `settings.yaml.bak-20260927-143052` and
`.credentials.yaml.bak-20260927-143052`. Restore: copy the `.bak-…` file back to the original name.

---

## The automated runs' channel

A headless run **always** leaves behind a session in its working directory, and on startup DSH groups
every such directory as a separate workspace. If the run starts from the project's directory, the
session goes into the project's sidebar — this is how the 9 sessions of the 2026-09-27 delegation
tests ended up in the "Deepseek Harness" list.

```powershell
# the channel (default: <repo>\.automation) + hiding the existing machine sessions
node providers\session-channel.mjs                     # report, does not write
node providers\session-channel.mjs --channel --hide    # registers + hides
.\providers\setup-automation-channel.ps1               # the same in one command

# starting an automated task from the channel
.\providers\run-headless-task.ps1 "Report the current date using the pwsh tool."
```

- Hiding is **archiving**: the session disappears from the sidebar and from search, but its log stays
  in place, so the 30-day statistics still count it. Bringing it back: `--unhide --ids <id,...>`.
- Archiving happens through the **running** host's registry (`POST /ui-extras/workspace-session`),
  because DSH reads `storages/workspace.json` only at startup; a manual file edit would be
  overwritten by the host.
- `run-headless-task.ps1` registers the channel as a workspace before the run (if the harness is
  running), so the machine sessions go into a separate group. With `-ReportDirectory` the output also
  goes into a file (`automation-*.md`); `-Patch` passes one or more additional patch layers to DSH
  (for the headless profile's free chain: `test-subagent-worker.patch.yml`).

---

## Free delegation from the GUI (the standard-free preset)

In the web profile the `tool-subagent` row comes from the **preset** (the `dsh-web-app` disables the
host-plane row), so overriding `tool-subagent` in
`~/.dsh/profiles/web/cordis.patch.yml` has no effect: the standard preset's row has no
`agentOptions`, so the child inherits the **parent's route** — a delegation started from the GUI is
always paid `deepseek-flash`. (Measured: on 2026-09-30 a probe child started from the GUI ran on
`deepseek-flash`; all the free requests came from the 09-27 headless tests.)

```powershell
# report (does not write), then installation + making it the default
node providers\install-free-preset.mjs
node providers\install-free-preset.mjs --apply --default

# check: which child ran on which route
node providers\check-delegation-route.mjs --hours 24

# restoring settings.yaml, if needed
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-<timestamp>" `
          "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

- The script copies the `standard` preset under the id `standard-free` into
  `<DSH_HOME>\.agent-presets` (the built-in root wins the duplicated id, so it cannot be overridden,
  only copied), and writes **two** things into it (both verified; `--verbose` prints the patched
  blocks):
  1. into the `tool-subagent` row,
     `agentOptions: { provider: subagent-worker, model: worker, maxTokens: 32768 }`
     — this is the child's **route**;
  2. into the `suffix` of the `persona` row, the **delegation directive** — this tells the main
     model to hand separable work to the child, and that the decision/file modification/the answer
     to the user stays on the main thread.
- **The route alone does not delegate.** A measured case (2026-10-03/04): a full day's use of the
  interface produced ~1.8k paid requests but **not a single** free request, because nobody called the
  `subagent` tool — in that case the statistics are correct yet look "frozen". The directive is meant
  to reverse this; the detailed measurement and the evidence: `FELJEGYZES.md` section 12.
- The delegation directive is part of the **persona row**, so it is valid only in conversations
  started after the installation (running conversations keep their own prompt/preset).
- **No restart is needed:** the preset roster is read per call, the default comes from the hot-reloaded
  settings. **New** conversations start on `standard-free`.
- **Risk:** the `worker` route points at the local proxy, and the DSH retry does not switch
  providers — if the proxy is down, the child's call dies (it does not fall back to paid). The
  watchdog watches it (`reports\proxy-watchdog.log`); check: `node providers\verify-subagent-chain.mjs`.
- **Restoring:** the installer does not back up the preset folder, so make a backup before a swap
  (`Copy-Item -Recurse` of `.agent-presets\standard-free`); the `persona` patch can be removed by
  searching for the `DELEGALAS-IRANYELV` marker.
