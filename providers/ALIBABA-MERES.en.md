# Alibaba (Qwen) EU wiring — live measurements and findings

> Hungarian version: [`ALIBABA-MERES.md`](ALIBABA-MERES.md).

**Date:** 2026-10-14. **Measured with:** `providers/probe-alibaba*.mjs` (live API calls, the key never leaves the machine).
**Markers:** [M] = measured on this machine, [D] = vendor documentation, [K] = combination/estimate. [D] is not considered proven without a measurement.

## 1. Endpoint, key, region

| Item | Result |
|---|---|
| EU workspace endpoint (`ws-…eu-central-1.maas.aliyuncs.com/compatible-mode/v1`) | [M] `GET /models` 200, 194 ms, 85 ids |
| The key's region binding | [M] the key gives 401 on `dashscope-intl` → it is an EU key, only the EU endpoint works |
| `.credentials.yaml` `ALIBABA_API_KEY` | [M] present (refs); the proxy launcher (`run-proxy-service.ps1`) loads the environment from the credential store → the proxy will see it too |
| `settings.yaml` catalogue vs. live `/models` | [M] 85/85 ids identical (the list was copied from there) |
| **Serving matrix** | [M] of the 73 chat-probe-capable ids only **37 live**; **36 give 404 "Model not exist"**: every `qwen3-max*`, `qwen3-coder-plus/next/480b/30b`, `qwen3-8b/32b/30b/235b`, of the `qwen3-vl-*` all except `qwen3-vl-plus` (that one works!), the `qwen3-next-*`, `deepseek-v4-flash` (the plain one!), `qwen-plus-2025-09-11/07-28`, `qwen3.5-35b-a3b` ("no suitable services in forward clusters") |

**Finding:** the `/models` catalogue and the models actually served do NOT match — about 44% of the list is dead. The settings.yaml has to be pruned.

## 2. Protocol choice (`api:`)

| Item | Result |
|---|---|
| `api: openai-responses` (the current setting) | [M] **WORKS**: the current DSH main session runs on it (the session log's `replayState.api=openai-responses`, `stopReason=toolUse`), reasoning blocks, tool calls and streaming are all alive |
| `/responses` + tools | [M] only the **FLAT** (`{type:"function", name, parameters}`) tool form works; the chat-style nested `function:{}` form gives `response.failed`. The pi-ai adapter sends the flat one → fine |
| `/responses` + large max-output | [M] a trap: `max_output_tokens=16` → `status=incomplete`, without content — the reasoning_tokens eat the budget. Small maxTokens + thinking = a seemingly empty answer |
| `/responses` model coverage | [M] `qwen3-vl-plus`: **400 "Unsupported model"** — the VL family and OCR are NOT available in responses mode, only on `/chat/completions` |
| `/chat/completions` | [M] it works for every live model; tools+stream [M] (`tool_call_deltas`, `finish=tool_calls`, 1354 ms); `enable_thinking`+`reasoning_content` [M] (`compat.thinkingFormat: qwen` in pi-ai is the matching form) |

**Finding:** `openai-responses` is a valid choice for the mainline Qwen models, but **a second route is needed** (`api: openai-completions`) if the VL/OCR models are wanted too. One provider block can have one `api` mode.

## 3. Image support (the user's question: "it does not support images")

There are two separate problems:

1. **A DSH declaration gap:** the alibaba model entries in `settings.yaml` have **no `input:` field** → the harness sees every model as text-only. Live evidence [M]: `read_image` refused: *"model qwen3.8-flash does not declare image input"*. The parser does support the per-entry `input:` field (`dsh-llm-pi-ai/lib/index.js` line 682). THIS IS THE FIRST THING TO DO.
2. **Endpoint support (measured):** of the 37 live models, **24 see images** on compatible-mode (reading a 3-digit number: 24/24 hits):

```
qwen3.8-flash, qwen3.8-max, qwen3.8-max-0902, qwen3.7-plus, qwen3.7-plus-2026-05-26,
qwen3.7-flash, qwen3.7-flash-2026-07-15, qwen3.7-max-2026-06-08,
qwen3.6-plus, qwen3.6-plus-2026-04-02, qwen3.6-flash, qwen3.6-flash-2026-04-16, qwen3.6-35b-a3b,
qwen3.5-plus, qwen3.5-plus-2026-02-15, qwen3.5-flash, qwen3.5-flash-2026-02-23,
qwen3.5-27b, qwen3.5-122b-a10b, qwen3.5-397b-a17b,
qwen3-vl-plus, qwen-vl-ocr(!), kimi-k3, kimi-k2.5, kimi-k2.7-code   ← 25 on "777"
```
*(qwen3-vl-plus and qwen-vl-ocr only in completions mode.)*

They do NOT see images [M]: `qwen3.7-max`, `qwen3.7-max-2026-05-20` (400 "Unexpected item type in content"), the `qwen3-coder-*` (denies it in text), `qwen-plus`, `qwen3.5-35b-a3b` (no EU service), `deepseek-v4-flash-0731`, `deepseek-v4-pro`, `glm-5.1/5.2`. **DANGEROUS [M]:** `qwen-flash` and `qwen-flash-2025-07-28` do NOT see the image but still answer (they hallucinated "123" for the 777) — never declare `input: image` for these.

## 4. Efficiency [M]

| Probe | Result |
|---|---|
| small chat (nostream) | 862 ms; `qwen3-coder-flash` tools 686 ms |
| chat + tools stream | 1354 ms, real `tool_calls`, `finish=tool_calls` |
| image + question (flash) | ~2.2 s; `qwen3-vl-plus` with an image: **236 ms** |
| 123K token context | TTFT 5383 ms, total 6352 ms, 200-token answer — Groq's 8K TPM wall (413) is not here |
| implicit cache | [M] on a repeated 12K-token prefix `cached_tokens=11 264/12 099` (93%) **in both API modes**; pi-ai does the `cached_tokens`→`cacheRead` mapping on both paths (`openai-completions.js` 1180, `openai-responses-shared.js` 441) |
| rate limit | [D] the workspace page's TPM/RPM limit is not visible in the response headers on EU ([M] there is no `x-ratelimit-*`); the 1M TPM/600 RPM from the PLAN is **unproven for EU** |
| free tier | [D] the 1M token free quota is available **only in Singapore**, not in EU — the invoice starts with the wiring |

## 5. Prices — Frankfurt/Global list prices [D] (source: the alibabacloud.com model-pricing page, 2026-10-13 update), USD / 1M tokens

| Model | Input | Cache hit (~10%) | Output | Note |
|---|---|---|---|---|
| `qwen3.8-flash` | **0.113** | 0.0113 | **0.382** | flat, no tiering from 0–1M |
| `qwen3.7-flash` | 0.028 (≤32K) / 0.083 / 0.165 | ~10% | 0.110 / 0.330 / 0.660 | tiered |
| `qwen3.7-plus` | 0.276 (≤256K) / 0.826 | 0.0276 | 1.101 / 3.301 | **limited-time daytime −20%, night −60%** (at night ~0.110/0.440) |
| `qwen3.8-max` | 1.65 | ~0.165 | 4.951 | Singapore 2.00/6.00 — EU is 20% cheaper |
| `qwen3-coder-flash` | 0.144 (≤32K) → 0.717 (256K–1M) | ~10% | 0.574 → 3.584 | against the Singapore list (0.30/1.50) the EU price is about half |
| `qwen3.5-flash` | 0.029 (≤128K) | — | 0.287 | the page also has a separate EU row |

Direct DeepSeek comparison (the repo's price table [D]): `deepseek-flash` peak 0.30/1.20, off-peak 0.15/0.60, cache 0.006/0.003. **Conclusion [K]:** the EU `qwen3.8-flash` at a flat 0.113/0.382, 24 hours a day, is cheaper than DeepSeek-flash AT PEAK (2.65×/3.1×) AND EVEN OFF-PEAK (1.33×/1.57×); DeepSeek only wins on cache hits (0.003 vs 0.0113).

The period of Alibaba's pricing: their notion of "peak" is the **22:00–08:00 (UTC+8) night −60% / daytime −20% promotion** (only certain models; [D]) = **14:00–24:00 UTC**. This is exactly opposite to DeepSeek's peak windows (01–04, 06–10 UTC) — the two time windows complement each other (see section 7).

## 6. Cost accounting (the "DSH model" — `plugins/dsh-ui-extras/lib/index.js`)

The existing model: `MODEL_PRICES` (2155–2178), `modelPrices()` first-substring-match (2181–2189), `isPeakInstant` (2215, DeepSeek windows), `requestCost` (2244), `scanUsage` (2341) from the session logs (`usage.inputTokens/cacheReadTokens/outputTokens`, `source.model`), `freeSavingsUsd` (2525). Result: `.costUsd` / `.savedUsd` on the cost panel through the `/ui-extras/usage` endpoint. **There is no forward projection** — only lookback; the `days=30` and the running daily average can be considered projections.

**A LIVE BUG [M+D]:** because line 2172 has `"qwen3.8": {all 0}`, MY MAIN MODEL (`qwen3.8-flash`, paid EU) **is classified as free** (`isFreeModel` true), all the main-route traffic is booked as "saving", and `qwen3.8-max` falls into the same row. The delegated deepseek-v4 and `qwen3.7-flash` would go into the `deepseek-flash` fallback price (a coincidence-level approximation, but not the EU price).

Proposed fix (the exact diff is in section 7.4):
1. Narrow the `"qwen3.8"` key to `"qwen3.8-27b"` (that still catches the OR `:free` target, but not the paid flagship).
2. **Provider-dependent matching:** `messageModel(data)` returns only the model id, although the event also carries `source.provider`. `modelPrices` should get the provider, and the rows should be keyed as `"alibaba:qwen3.8-flash"` (this also solves the kimi-k3 "free" collision: NVIDIA-kimi is free, Alibaba-kimi is paid).
3. New rows (USD/M; peak = off-peak, because Alibaba is flat; the night promotion in a comment): see the table in section 5.
4. Fallback for an unknown Alibaba model: the `qwen3.8-flash` row, not deepseek-flash.

## 7. Automatic model switching for peak hours — a plan

**Time zones (UTC), weekdays [D from their sources]:**
- DeepSeek peak (price doubles): **01:00–04:00** and **06:00–10:00**
- Alibaba Global night promotion (−60%): **14:00–24:00** (= 22–8 UTC+8); daytime −20%

**Optimisation by quality level:**
- *Flash level (main):* nothing time-dependent to do — `qwen3.8-flash`'s flat EU price [D] beats deepseek-flash at every time of day [K]; the main model can stay where it is. The point of the DeepSeek peak-hour switch is **to keep the peak out of the more expensive DeepSeek family**: do not use `deepseek-v4-pro` between 01–04/06–10 UTC (0.15 + cache instead of 0.30), because in that window `qwen3.8-max` (1.65) and `qwen3.7-plus` daytime (0.221) are better/cheaper in quality-adjusted terms.
- *Plus/medium level:* **14:00–24:00 UTC** (Alibaba night) gives `qwen3.7-plus` an effective ~0.110/0.440 — plus quality at flash price. Scheduling the heavy, long-running delegations into this window is the largest immediate gain WITHOUT a code change (the `dailyOverrides` + `retune.mjs` + the hour-based Windows scheduled task infrastructure already exist: `register-monthly-retune.ps1`).
- *Delegated (free) chain:* unchanged — the proxy's paid-chain principle only adds Alibaba as a backup (7.3).

**Implementation in the proxy (proposed, ~40 lines):**
1. `providers/config.json`: `"providers.alibaba": { baseURL, apiKeyEnv: ALIBABA_API_KEY }` (the launcher already loads the key from the credential store [M]).
2. `routes.worker.targets` order: `groq → nvidia → openrouter:free → alibaba/qwen3.7-flash → ollama` — paid Alibaba NEXT TO the free ones, BEFORE the local Ollama (the measured Ollama does not give real `tool_calls` even within 35 s [D from the config.json comment]). Or, thinking in a cost budget: after the free targets, `alibaba/qwen3.7-flash` first (0.028/0.110).
3. A new `"timeWindows"` in the routes: `[{ "utc": [1,4], "targets": [...] }, { "utc": [6,10], … }, { "utc": [14,24], "targets": ["alibaba/qwen3.7-plus", …] }]`, with hour filtering in `effectiveRoute()` next to the `dailyOverrides`; + `fs.watch` for config hot reload (currently it reads only at startup [D from the config comment], instead of the watchdog refresh).
4. The DSH main route cannot go through the proxy (the main `llm-pi-ai` route is static), so switching the main model can only happen by rewriting `settings.yaml` + restarting the harness — NOT worth automating; instead the argument above ("we exploit that flash's EU price is flat") applies.

## 7.4 Proposed settings.yaml patch (sketch)

```yaml
  alibaba:
    # … unchanged: apiKeyEnv ALIBABA_API_KEY, api openai-responses, EU baseURL
    defaultContextWindow: 1000000
    defaultMaxTokens: 65536
    models:
      - id: qwen3.8-flash
        name: Qwen3.8 Flash
        contextWindow: 1000000
        maxTokens: 65536
        input: [ text, image ]      # [M] sees images, and answers them too [M]
      - id: qwen3.8-max
        contextWindow: 1000000
        maxTokens: 131072
        input: [ text, image ]
      - id: qwen3-coder-flash
        contextWindow: 1000000
        maxTokens: 65536
      # … every REMAINING 37 LIVE model; the 36 dead ids must be deleted;
      # qwen-flash / qwen3.7-max: NEVER input:image (they hallucinate / refuse)

  alibaba-compat:                   # ROUTE: completions, because of VL/OCR
    displayName: Alibaba (completions, VL)
    apiKeyEnv: ALIBABA_API_KEY
    api: openai-completions
    baseURL: https://{EU-WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1
    defaultContextWindow: 262144
    defaultMaxTokens: 32768
    compat: { thinkingFormat: qwen }
    models:
      - id: qwen3-vl-plus
        input: [ text, image ]
      - id: qwen-vl-ocr
        input: [ text, image ]
```

## 8. Open questions (measurement backlog)

- [M] missing: the TPM/RPM limits for the EU workspace (the headers do not give them); `qwen3.7-flash` tool support; the actual billed unit prices (to be checked in the console!); kimi-k3 on `/responses`.
- We used the "Global" deployment-scope rows of the EU price list [D]; the workspace scope decides on the invoice — calibrate the price table after the first invoice.

## 9. Verdict on the 5 questions

1. **Configuration:** the provider block is valid and LIVE (the main session runs on it), but `contextWindow/maxTokens` is missing (it falls back to 262K/32K [D from the parser code: dsh-llm-pi-ai 670–673]), 36 of the 85 models are dead [M], there is no `input:` [M], and `qwen3-vl-*` cannot be used in responses mode [M].
2. **Model choice:** `qwen3.8-flash` can be approved for main [M+D: flat EU price, 1M, image, 93% cache]. `qwen3-coder-flash` is excellent for the tool chain [M: 686 ms, real tool_calls]. Deleting the dead ids is mandatory, otherwise the `/model` selector is misleading.
3. **Efficiency:** [M] measured: a small request ~0.9–1.4 s, 123K context TTFT 5.4 s — realistic; the Groq 413/TPM problem disappears; the cache works; but there is no free quota in EU [D] → the "free" statistic lies right now (section 6).
4. **Cost projection model:** there is lookback + a price table [M in the code]; wiring Alibaba = provider-dependent rows + fixing the "qwen3.8" free bug (diff in sections 6/7.4). There is no forward projection in the model — only a day-by-day lookback.
5. **Automatic peak switching:** the most effective is (a) main: nothing to do (flat EU price), (b) rescheduling the heavy tasks to 14:00–24:00 UTC (Alibaba night −60%), (c) excluding the DeepSeek family from the 01–04/06–10 UTC peak, (d) `alibaba/qwen3.7-flash` in the worker chain as a paid backup before Ollama, with `timeWindows` in the proxy.

---

# 10. APPLIED FIXES (2026-10-14)

The user approved the price-table fix, the proxy-chain extension and the `timeWindows` mechanism. The following files changed (all in the repo):

| File | Change |
|---|---|
| `providers/proxy.mjs` | `timeWindows` (chain switching by UTC hour, with a window that wraps over midnight, optional `days`), **config hot reload** (fs.watch + 800 ms debounce, BOM-tolerant `loadConfig`), `CONFIG`/`PROVIDERS`/`REQUIRED_ENV` mutable |
| `providers/config.json` | `alibaba` + `alibaba-intl` (Singapore, prepared) provider; `alibaba/qwen3.7-flash` in the worker chain before ollama; a new `vision-worker` route; `requiredAnyEnv.vision-worker`; `_timeWindows_megjegyzes` |
| `providers/run-proxy-service.ps1` | the key-resolution list extended with `ALIBABA_API_KEY` + `DASHSCOPE_API_KEY` (without it the proxy would have silently SKIPped the Alibaba targets) |
| `plugins/dsh-ui-extras/lib/index.js` | Alibaba EU price rows with a provider prefix + `alibaba/` fallback; the `"qwen3.8"` free trap → `"qwen3.8-27b"`; `messageModel` adds a provider prefix (`source.provider/model`) |
| `providers/verify-savings.py` | the same table + provider prefix in `model_of` |
| `~/.dsh/settings.yaml` | the alibaba block reorganised: `alibaba` (openai-responses, 3 flagship) + `alibaba-compat` (openai-completions + `thinkingFormat: qwen`, 34 models); 36 dead ids deleted; `input: [text, image]` on 25 vision-capable models; `contextWindow/maxTokens` everywhere; `allowedModels` + `vision-worker` + `alibaba-compat/qwen3.7-flash`. Backup: `settings.yaml.bak-2026-10-14T04-19-22-alibaba` |

## 10.1 New measurements

| Probe | Result |
|---|---|
| `qwen3.7-flash` tools (stream) | [M] HTTP 200, `tool_deltas=6`, `finish=tool_calls` — **11 982 ms** (slower than expected; that is why it is in the chain AFTER the free targets) |
| `qwen3.7-flash` image + tool in ONE request | [M] `report_number({"n": 777})` — the image and the tool go at the same time |
| the proxy's `vision-worker` endpoint (image + tool) | [M] HTTP 200, **2072 ms**, `HIT alibaba/qwen3.7-flash` in the proxy log |
| proxy hot reload | [M] `CONFIG reloaded (hot-reload)` — without a restart, from the next request |
| price-table matching | [M] `providers/check-price-table.mjs`: 15/15 cases (Alibaba paid, free chain 0, provider collision resolved) |

## 10.2 A circumstance that changed in the meantime: the main model is already DeepSeek

During the work the main model switched from `alibaba/qwen3.8-flash` to
**`deepseek-official/deepseek-flash`** (`agent-default-model`), which makes the peak question concrete —
DeepSeek DOES have a daily peak and an off-peak tariff:

| Period (UTC) | deepseek-flash in/out | alibaba/qwen3.8-flash (flat) | Gain with Alibaba |
|---|---|---|---|
| 01–04 and 06–10 (peak) | 0.30 / 1.20 | 0.113 / 0.382 | **2.65× / 3.14×** |
| otherwise (off-peak) | 0.15 / 0.60 | 0.113 / 0.382 | 1.33× / 1.57× |

So `timeWindows` now brings REAL benefit on the main route too: the proposed step is a `smart-main`
proxy route whose `timeWindows` sends the request to `alibaba/qwen3.8-flash` in the 01–04 and 06–10 UTC
windows and to DeepSeek otherwise (for this the DeepSeek direct endpoint has to be added to the proxy's
`providers` section with the existing `DEEPSEEK_API_KEY`). This would tie the main DSH route to the
proxy, so it needs a separate decision.

## 10.3 A known limit

A paid fall-through INSIDE the proxy (e.g. `alibaba/qwen3.7-flash` answering instead of the
`worker`/`vision-worker` route's free targets) looks **free** on DSH's cost panel, because the session
log records the route's name (`worker`), not the upstream model. The real paid traffic can be computed
from the `HIT alibaba/...` lines of `proxy.out.log`. An optional fix: the proxy signals the actual
upstream model in a custom response header, and the plugin reads that too.

## 10.4 Open: Singapore

`DASHSCOPE_API_KEY` is **not** in the credential store (`refs`) and not in the environment either — the
Singapore provider is prepared in config.json (`alibaba-intl`), but without a key the proxy SKIPs it.
The 1M token/model free quota [D] lives only in Singapore, so this target is ideal for free delegation.
The key has to be created in the Model Studio Singapore workspace and added to the DSH credential store
under the name `DASHSCOPE_API_KEY`.

---

# 11. SINGAPORE WIRED (2026-10-14, from the user's CSV)

The workspace received: `{SG-WorkspaceId}` (ap-southeast-1). **Not** the old
`dashscope-intl.aliyuncs.com` domain, but the workspace-domain form:
`https://{SG-WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.
The key was added to the credential store under the name `DASHSCOPE_API_KEY` (with a timestamped
backup), and `run-proxy-service.ps1` now loads it too.

| Probe [M] | Result |
|---|---|
| `GET /models` | 200, **99 models** (85 on EU) |
| Ids that live only in Singapore | `qwen3.8-omni-flash` (+realtime), `glm-5.3`, `glm-5.3-prime`, `deepseek-v4.1-flash`, `kimi/kimi-k3`, `qwen3.8-27b`, `qwen3-audio-3.1-realtime-plus`, `qwen3.8-livetranslate-flash-realtime` |
| `qwen3.8-flash` stream+tools | 1229 ms (EU: 1354 ms) |
| `qwen3.7-flash` stream+tools | **3041 ms** (the same on EU was 11 982 ms) |
| `qwen3-coder-flash` stream+tools | 1063 ms |
| image + tool (`qwen3.8-flash`) | `report_number({"n": 777})` |

**Consequence:** Singapore became the FIRST paid-level target in the chains (`worker` and
`vision-worker`), because (a) the free 1M/model quota lives there, (b) it is faster, (c) the catalogue is
richer. The EU instance is a backup behind it.

# 12. STABILITY MEASUREMENT — why the cooldown is needed

| Endpoint | large request, NOT stream (30 s limit) | large request, STREAM |
|---|---|---|
| Singapore | 10.1 s / **TIMEOUT** / **TIMEOUT** / **TIMEOUT** / 21.8 s | 3/3 OK (TTFT 1.2–1.3 s) |
| EU (Frankfurt) | **TIMEOUT** / 5.5 s / **TIMEOUT** / 15.8 s / 3.2 s | 2/3 OK (TTFT 0.6–1.0 s), 1/3 sent not even headers |
| small request (both) | 0.7–8 s, without a timeout | — |

**Interpretation:** on large non-stream requests the server sends headers only after the full
generation, and qwen3.8-flash's long reasoning can push it past 30 s — that is not a failure but an
artefact of the measurement mode. The **real** problem is that the EU endpoint sporadically (≈1/3) **does
not even send headers**, not even on stream. DSH streams, so in practice this is rare, but one stuck
target would have taken 120 s.

**Solution (built into the proxy):**
1. Provider-level `connectTimeoutMs`: `alibaba` and `alibaba-intl` = **30 s**, so a stuck target gives up
   its place quickly (ollama stays at 300 s).
2. **Target-level cooldown** (`targetCooldownMs` = 90 s): a failed target moves to the **end** of the
   chain (it does not drop out), and the cooldown clears on success; the `cooldowns` field of `/healthz`
   shows it. Proven on live traffic: after a Groq 400 (a replayed `reasoning_content`), the next requests
   already sorted Groq to the end of the chain.

# 13. `auto` — THE INTELLIGENT MODEL SELECTOR

The rules of `routes.auto` in `providers/config.json` (the first match wins):

| Rule | Condition | Target chain |
|---|---|---|
| `kep` | the request contains image content | `alibaba-intl/qwen3.8-flash` → `alibaba/qwen3.7-flash` → `alibaba/qwen3.8-flash` |
| `hosszu-kontextus-180k` | estimated > 180 000 tokens | `alibaba-intl/qwen3.8-flash` → `alibaba/qwen3.8-flash` → `deepseek/deepseek-flash` |
| `deepseek-csucs-01-04` | UTC 01–04, weekday | `alibaba-intl/qwen3.8-flash` → `alibaba/qwen3.8-flash` → `deepseek/deepseek-flash` |
| `deepseek-csucs-06-10` | UTC 06–10, weekday | the same |
| (default) | none of them | `deepseek/deepseek-flash` → the backups |

In the DeepSeek peak window the price of `deepseek-flash` **doubles** (0.30/1.20), while qwen3.8-flash's
EU price is flat (0.113/0.382) → a **2.65× / 3.14×** saving in those hours, automatically.

**Measurement proof** (`providers/probe-auto.mjs`, with temporary test routes for each branch
separately): default → deepseek HIT; image → SG qwen3.8-flash HIT; tool → SG qwen3.7-flash HIT; large
context → EU qwen3.8-flash HIT; time window → EU qwen3.8-flash HIT; live `auto`: stream+tool 11
tool-deltas, `finish=tool_calls`, image → `777`. The large-context case that used to time out at 120 s
took **1532 ms** after the cooldown + the 30 s target limit.

In DSH the `auto-router` provider (`~/.dsh/settings.yaml`) puts it into the selector:
`Auto (by image / peak / long context)`, plus `vision-worker` for image delegation. **It appears after a
harness restart.**

# 14. All the modified/new files (2026-10-14)

| File | Role |
|---|---|
| `providers/proxy.mjs` | `rules` (auto selector), `timeWindows`, hot reload, **cooldown**, BOM-tolerant config |
| `providers/config.json` | EU + SG + DeepSeek providers, `auto`/`vision-worker` routes, target time limits, `targetCooldownMs` |
| `providers/run-proxy-service.ps1` | loading the ALIBABA / DASHSCOPE / DEEPSEEK keys |
| `providers/apply-alibaba-settings.mjs` | settings.yaml: 37 live models, 25 vision-capable, two Alibaba routes |
| `providers/apply-auto-provider.mjs` | settings.yaml: the `auto-router` provider (the Auto model) |
| `providers/add-sg-key.mjs` | adding the Singapore key to the credential store |
| `providers/check-price-table.mjs` | price-table self-check (15/15) |
| `providers/probe-alibaba*.mjs`, `probe-singapore.mjs`, `probe-proxy.mjs`, `probe-auto.mjs` | repeatable probes |
| `plugins/dsh-ui-extras/lib/index.js` | Alibaba prices with a provider prefix, the `qwen3.8` free trap fixed |
| `providers/verify-savings.py` | the cost mirror updated |

**An operational note:** in this session the proxy runs as a managed background job (the pwsh tool kills
the process tree at the end of the call, so the instance started with `Start-Process` died; the watchdog
brought it back). For persistence, the `providers\run-proxy.cmd` (logon) route or the watchdog serves.

---

# 15. COST MANAGEMENT FOR ALIBABA (2026-10-14, second round)

## 15.1 What the user asked, and what was delivered

| Request | State |
|---|---|
| "Was the Singapore free quota added to the free chain?" | **Yes** — in the `worker` chain after the free targets, first in `vision-worker`, and included in `auto` too. In the cost model a **per-model quota credit** was added (see 15.2). |
| "Is the Alibaba cost handling built in?" | **Yes** — EU + Singapore price rows with a provider prefix, the `"qwen3.8"` free trap fixed, provider-family breakdown, SG quota. (In the first round only the EU prices went in.) |
| "In the footer, instead of the DSH balance, `$/$`, DSH/Alibaba, with a tooltip" | **Done** — the pill's label is `DSH / Alibaba`, its value `$DeepSeek / $Alibaba`; the tooltip shows the breakdown, the SG quota and the **DeepSeek balance too** (the latter was not lost). If the host is still old (no `spend` field), the old balance pill remains automatically. |
| "Only the paid balance is visible in the footer, not the one increased by the granted credit" | **Done** — the pill's left side shows the DeepSeek API's `total_balance` (`total` = `topped_up_balance` + `granted_balance`, matching the console), not just the topped-up part. The breakdown (`topped-up + granted = total`) stays in the tooltip; an old host (without `total`) computes from the two parts, and `tools/check-plugin.mjs` pins it. |
| "Alibaba should be handled in the statistics too" | **Done** — the usage row's tooltip gets a new "By provider" block (DeepSeek / Alibaba EU / Alibaba Singapore / free chain), plus the state of the SG quota and a refinement of the Alibaba prices. |

## 15.2 How the model calculates

1. **Price rows** (`MODEL_PRICES`): `alibaba/…` = EU Frankfurt, `alibaba-intl/…` = Singapore
   (International), with a generic `…/` fallback for both, so that an unknown Alibaba model does not
   fall on the DeepSeek price.
2. **Free quota**: `SG_FREE_TOKENS_PER_MODEL` = 1 000 000 tokens/model, `SG_FREE_WINDOW_DAYS` = 90.
   `scanUsage` counts the Singapore tokens per model, credits the part under the quota at **0 USD**, and
   subtracts it from the total cost, from the model rows and from the daily rows too.
   **Limit:** DSH cannot see the invoice-side quota state; this is a value estimated from our own logs —
   another tool using the same key may exhaust it earlier.
3. **Provider breakdown**: `providerFamily()` sorts the request from the `source.provider` prefix into
   the `deepseek` / `alibabaEu` / `alibabaSg` / `free` / `other` family; the `spend` block gives the
   footer's pair (`deepseekUsd` / `alibabaUsd`, and in an EU and SG breakdown too).
4. **A known approximation**: on the proxy routes (`worker`, `vision-worker`, `auto`) the log records the
   **route's name**, not the upstream model, so the Alibaba cost there is an approximation — the real
   target can be read from the `HIT alibaba…` lines of `proxy.out.log`. The tooltip prints this too.

## 15.3 Verification

| Probe | Result |
|---|---|
| Price-table classification (`providers/check-price-table.mjs`) | [M] **19/19** (EU + SG + free chain + DeepSeek + provider collision) |
| Plugin host and client syntax | [M] `node --check` OK on both |
| Live usage endpoint | [M] `GET /ui-extras/usage?days=30` → 200, **old shape** (the plugin loads at startup) → the new `spend`/`byProvider`/`alibabaSg` fields appear **after a DSH restart** |
| An independent cross-check running on the real logs (`providers/verify-savings.py`) | [M] 29 899 requests; **DeepSeek $37.06 / Alibaba EU $0.1254 (46 requests) / free chain $0**; the 46 Alibaba requests previously shown as "free" now correctly appear as a **paid item** |

## 15.4 What the user has to do

**Restart DSH** (the plugin's host and client halves load at startup): that is how the `Auto` model
appears in the selector, the footer's new `$DSH / $Alibaba` value and the statistics' Alibaba breakdown.
Afterwards it is worth a glance at the tooltip: if the number does not match the expectation,
`node providers/check-price-table.mjs` and `python providers/verify-savings.py` show the price-table and
log-based values.

---

# 16. ORCHESTRATION ANALYSIS: pro orchestrator + flash children?

**Question:** if the task distribution were entrusted to `deepseek-v4-pro`, and the main model
consistently delegated every subtask to flash models, would that bring a quality and a cost saving?

**Method:** `providers/analyze-orchestration.mjs` — from the real session logs (30 days, 64 main and 138
child sessions) it measures the tokens, the cache ratio and the step counts, then re-prices the same
main token volume on several models.

## 16.1 The measured traffic

| | requests | cache-miss input | cache hit | output | cache ratio | cost |
|---|---|---|---|---|---|---|
| **Main** | 26 914 | 22.4 M | **9.60 B** | 23.4 M | **99.8%** | **$54.57** |
| **Child (delegated)** | 3 030 | 16.3 M | 140.1 M | 1.6 M | 89.6% | **$0.30** |
| Total | 29 944 | — | — | — | — | $54.87 |

- The **main route is 99.4% of the cost**, delegated work is **0.55%**.
- Average context: **a main request 357 602 tokens**, a child request 51 626 tokens.
- Steps/turn: main 28.8 · child 22.2.

**The main engine of cost is resending the context:** 9.6 billion cached input tokens over 30 days — that
alone is ~$29 (off-peak) of the ~$46. Not the output, but that a 357K-token context is resent step by
step (cached, but not free).

## 16.2 The same main token volume on other models (off-peak)

| Main model | cost | compared to the current |
|---|---|---|
| `deepseek-flash` (current) | **$46.21** | 1.00× |
| `deepseek-flash` **at peak price** | $92.42 | 2.00× |
| `alibaba/qwen3.8-flash` EU (flat) | ~$119.97 | 2.60× |
| `alibaba-intl/qwen3.8-flash` SG (flat) | $158.39 | 3.43× |
| `deepseek-v4-pro` | **$272.37** | **5.89×** |

**A pro orchestrator would mean a 5.89× main cost.** To break even, the pro would have to do the same
work from **83% fewer main tokens** (4 steps/turn instead of 28.8) — which is not realistic in practice.

## 16.3 CORRECTING the earlier peak-hour proposal

In section 13 I wrote that in the DeepSeek peak (01–04, 06–10 UTC) it is worth switching to Alibaba,
because the list price is 2.65×/3.14× better. **Given the token mix, that is wrong:** the cache hit is
99.8% of the main traffic, and there DeepSeek is cheaper (0.006/M at peak) than Alibaba (0.0113/M EU,
0.015/M SG). Computed on the measured volume, Alibaba is **~30% more expensive even at peak** (EU ~$120 vs
flash peak $92). That is why I **removed** the `deepseek-csucs-*` rules from the `auto` route; Alibaba
gets the roles of **vision**, **long context** and **backup**. *(Refinement in section 18: Alibaba is
**cheaper on fresh tokens** — the measured increase is caused by the 10% cache tariff and the tiered
pricing on large cached requests, not by the base list price.)* The `timeWindows`/`rules` mechanism
remains available if a miss-heavy (fresh, large, uncached) workload were to make it worthwhile.

## 16.4 What brings a real saving

1. **Aggressive delegation — yes.** The children cost 0.55% while working on a 51.6K-token context
   instead of the main's 357.6K. The key: the child should return a **short digest** instead of raw
   content, because that way the main context does not swell — the main's cost is proportional to the
   context size.
2. **Slimming the main context** — the largest item (9.6 B cached tokens). Context compaction, fewer
   unnecessary rounds, outsourcing large tool outputs to a child.
3. **Selective pro — yes; fanatical pro — no.** A pro planner/checker request on ~30K fresh tokens ≈
   **$0.02**; if that prevents a 5-step failed round (5 × 357K cached tokens at peak price ≈ $10.7), it
   pays back handsomely. So: pro **only at the hard decision points**, not for the whole orchestration.
4. **The free chain** (Groq/NVIDIA/OpenRouter + the Singapore quota) is still $0 — even if delegation
   went to paid flash it would only be ~$5 for 30 days (measured: $0.30).

---

# 17. ESCALATION — flash sends the decision upwards (2026-10-14)

**Naming.** What the user described is **not delegation** (that goes downwards, to a cheaper worker) but
**escalation**: flash does the work, and when it gets stuck it hands the decision *upwards* to pro. The
literature calls it **cascade routing** or an escalation policy; the essence is that the expensive model
enters only when the expected saving (avoided failed rounds) is larger than the cost of entering.

## 17.1 Measuring escalation (`providers/analyze-escalation.mjs`)

| Item | Value |
|---|---|
| Main sessions (30 days) | 61 sessions, **26 974 steps**, **$53.51** |
| Average / session | $0.877 · **442 steps** |
| Median end-of-session context | **317 778 tokens** |
| **Flash step** (cached) | **$0.0010** (off-peak) / $0.0019 (peak) |
| **Pro entry** (full context, cache loss!) | **$0.2097** |
| Pro further step (cached) | $0.0070 (7× flash) |
| **Pro entry with a COMPACT BRIEF** (30K fresh tokens) | **$0.0198** |
| **Break-even point** transferring the full context | **220** failed flash steps |
| **Break-even point** with a compact brief | **21** failed flash steps |

**Two conclusions:**
1. Switching models **takes the cache away too** (DeepSeek's cache is bound to the model), so transferring
   the whole conversation costs ~$0.21 — 200× one flash step. Handing over the *task* with a compact brief,
   however, costs only ~$0.02.
2. "Ten bad attempts" on their own do **not** justify escalation (10 × $0.001 = $0.01); the real stake is
   **long, many-step work**: the largest sessions are 1000–2300 steps ($2.4–4.1 each).

**A measurement limit, honestly:** the word "error" in the free text of tool results cannot be used as a
signal — it occurs in file content too, and it gave a 98% false error rate in the measurement. The
reliable signal is the **repeated identical tool call** (the same name AND arguments) and the length of
the conversation.

## 17.2 What was built

1. **Proxy detector** (`proxy.mjs`): `requestSignals` now measures the conversation's length and the
   repeated calls (`messages`, `repeatedCalls`, `maxRepeat`); `rules` can filter on these too
   (`minMessages`, `minRepeatedCalls`, `minMaxRepeat`).
2. **Escalation rule** in the `auto` route:
   `{ "name": "eszkalacio-porgas", "minMessages": 40, "minMaxRepeat": 3,
   "targets": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"] }` — with a long conversation **and**
   at least 3× repeated calls, pro gets the next step. Disabling: delete the rule.
3. **Child escalation**: `deepseek-official/deepseek-v4-pro` was added to
   `subagent-model-selection.allowedModels`, so flash can request pro **with a compact brief** too (the
   cheap route with the 21-step break-even).

## 17.3 Verification (`providers/probe-escalation.mjs`)

| Case | Result |
|---|---|
| 25 rounds + 3× the same call | [M] **deepseek-v4-pro** — `AUTO auto: eszkalacio-porgas (msg=52, ismetles=2 max=3)` |
| the same in a short (5-round) conversation | [M] deepseek-flash (no escalation) |
| clean long (25 rounds, every call different) | [M] deepseek-flash (no false positive) |

## 17.4 Recommended policy

- **Base:** flash works (the steps are cheap), the expensive model only for escalation.
- **Escalation triggers:** a repeated identical call (≥3), a long conversation, an explicit tool error, or
  the user's request.
- **Form:** escalate the *task* with a compact brief (state, limits, what failed, expected output) — not
  the conversation.
- **What NOT to do:** do not move the whole orchestration to pro (a measured 5.89×), and do not escalate
  short, well-progressing work.

---

# 18. MODEL SHOPPING: where Alibaba is cheaper, and at what price they sell DeepSeek v4

**Question:** (1) is Alibaba really more expensive even at peak, when certain models are cheaper than
DeepSeek off-peak too? (2) are the DeepSeek v4 models cheaper or more expensive through Alibaba EU or
Singapore?

**Method:** `providers/analyze-model-choice.mjs` — it re-prices the same real main-route requests (30
days, 26 954 requests) per model, **with tiered pricing** and the real cache ratio.

## 18.1 The shape of the measured requests (this decides everything)

| Indicator | Value |
|---|---|
| Median request size | **335 454 tokens** |
| ≤32K | 2.3% |
| ≤128K | 15.3% |
| **>256K** | **62.5%** |
| Cache ratio | **99.8%** |

## 18.2 The same requests on other models

| Model | cost | vs deepseek-flash |
|---|---|---|
| **deepseek-flash (direct)** | **$53.36** | 1.00× |
| qwen3.8-flash (Ali EU) | $120.07 | 2.25× |
| qwen3.8-flash (Ali SG) | $158.52 | 2.97× |
| qwen3.7-flash (Ali EU) | $161.95 | 3.03× |
| deepseek-v4.1-flash (Ali EU) | $176.19 | 3.30× |
| deepseek-v4.1-flash (Ali SG) | $187.23 | 3.51× |
| qwen3.5-flash (Ali EU) | $189.55 | 3.55× |
| deepseek-v4-pro (direct) | $216.93 | 4.07× |
| **deepseek-v4-pro-0813 (Ali EU)** | **$776.68** | **14.56×** |

**The three reasons why Alibaba, cheaper on fresh tokens, is still more expensive on the main route:**
1. **Cache tariff:** DeepSeek gives a cache hit at **2%** of the input price (0.006/0.30), Alibaba at
   **10%** — and 99.8% of the traffic is a cache hit.
2. **Tiered pricing:** Alibaba sorts by the size of the *whole request* (`qwen3.7-flash` above 256K is
   0.165/0.66), and 62.5% of the requests are >256K.
3. **Fresh tokens are cheaper, but there are few of them:** 22.0M miss vs **9.61 B** cached tokens.

**The user is right that cheap, usable models exist:** `qwen3.7-flash` in the ≤32K tier is **0.028 /
0.110** — a **fifth** of deepseek-flash's off-peak price (0.15 / 0.60), and on cache 0.0028 vs 0.003
(a tie). Measured capabilities: real tool call, **sees images**, 1M context. So for small, fresh work it
is clearly the winner.

## 18.3 DeepSeek v4 through Alibaba

| Model | Input (idle/busy) | Output (idle/busy) | Cache hit | vs direct |
|---|---|---|---|---|
| `deepseek-v4.1-flash` **Ali EU (Global)** | **0.141 / 0.283** | **0.565 / 1.131** | 10% → 0.0141 | on fresh tokens **~6% cheaper**, on cache 4.7× more expensive |
| `deepseek-v4.1-flash` Ali SG (Intl.) | 0.15 / 0.30 | 0.60 / 1.20 | 10% | on fresh tokens it matches direct |
| `deepseek-v4-pro-0813` **Ali EU** | **0.636 / 1.272** | **1.908 / 3.816** | 10% → 0.0636 | on fresh tokens **~4% cheaper**, on cache 2.9× more expensive |
| `deepseek-v4-pro` Ali EU | 1.65 (flat) | 3.301 (flat) | 10% | on input **2.5× more expensive** (idle), cheaper on output |
| `deepseek-v4-pro` Ali SG | 2.400 (flat) | 4.800 (flat) | 10% | more expensive |
| DeepSeek direct (reference) | 0.15–0.30 / 0.66–1.32 | 0.60–1.20 / 1.98–3.96 | **2%** | — |

**Answer:** Alibaba sells the same DeepSeek v4 models **4–6% cheaper on fresh tokens** (EU/Global scope)
than direct DeepSeek — but because of the **10% cache tariff**, for cache-heavy agent work it is
**3.3× (flash) / 14.6× (pro)** more expensive overall. In Singapore the DeepSeek rows are not competitive
at all (pro: 2.4/4.8 flat).

## 18.4 Size-dependent policy — why that is not the answer

The rule "small request → Qwen, otherwise DeepSeek" on the real traffic:

| Threshold | saving |
|---|---|
| <32K → qwen3.7-flash | 0.7% |
| <64K → qwen3.7-flash | 1.1% |
| Theoretical lower bound (per-request optimum) | **6.1%** |

On top of that **every switch throws the cache away** (the cache is bound to the model), so switching per
request on the large, cached steps **costs more than it brings**. The lesson: the model should be chosen
at the **workload/session level**, not per request. That is why I narrowed the `hosszu-kontextus-180k`
rule to `friss-nagy-kontextus` (`maxMessages: 6`): we switch only for fresh, large input (there Alibaba is
cheaper AND gives 1M context), and the agent loop's large cached steps stay on DeepSeek.

## 18.5 Where Alibaba really wins

1. **Fresh, small work** (≤32K): 5× cheaper, and `qwen3.7-flash` can call tools and sees images.
2. **Image**: DeepSeek-flash does not see (measured), Qwen does.
3. **The Singapore free quota**: 1M tokens/model, zero cost.
4. **Output-heavy, short input**: output 0.110 vs 0.60 (5.5×).
5. **Data residency**: EU (Frankfurt) and Singapore on one invoice.

---

# 19. INTELLIGENT AUTOMATIC MODEL SELECTION (2026-10-14)

The `auto` route is no longer a fixed rule list: the proxy runs a **cost- and capability-based selector**
for every request (`proxy.mjs`: `chooseTarget`, `estimateCost`, `sessionKeyOf`).

## 19.1 The four principles (all from measurement)

1. **Cost-based decision.** From the `pricing` table of `config.json` it estimates the request's expected
   cost per target: the tiered price (`tiers`), the cache ratio depending on the session's age, the
   DeepSeek peak window (`peakMiss/peakHit/peakOut`), and the Singapore **free quota**
   (`freeQuotaTokens`, until the estimated consumption is under the quota → 0 USD). The **cheapest
   suitable** target wins — not the listing order.
2. **Hard capability filtering.** `contextWindow ≥ estimated tokens`, and only a `vision: true` target may
   get an image. (`deepseek-flash` **sees** — in this session it read the 777 test image — so it has
   `vision: true`.)
3. **Session stickiness.** The conversation's identifier is a fingerprint of the system message + the
   first user message; the chosen target is bound to it, and **we do not switch** — because a model switch
   throws the provider's cache away too. A switch happens only when the expected gain over
   `assumedRemainingSteps` steps exceeds the one-off cost of **re-warming the cache**
   (`size × (new miss price − old cache price)`).
4. **Escalation overrides everything.** `rules` runs first: spinning work (long conversation + repeated
   call) → pro; image → the vision chain.

## 19.2 The decision table (what the selector works from)

| Target | fresh input | cache hit | output | context | sees |
|---|---|---|---|---|---|
| `deepseek/deepseek-flash` | 0.15 (peak 0.30) | 0.003 (0.006) | 0.60 (1.20) | 1M | ✔ |
| `alibaba/qwen3.7-flash` EU | 0.028 / 0.083 / 0.165 per tier | 10% | 0.11 / 0.33 / 0.66 | 1M | ✔ |
| `alibaba-intl/qwen3.7-flash` SG | 0.03 / 0.10 / 0.20 | 10% | 0.13 / 0.40 / 0.80 | 1M | ✔ |
| `alibaba/qwen3.8-flash` EU | 0.113 | 0.0113 | 0.382 | 1M | ✔ |
| `alibaba-intl/qwen3.8-flash` SG | 0.15 | 0.015 | 0.47 | 1M | ✔ |

The SG rows have `freeQuotaTokens: 1000000` — while the quota lasts the target is **0 USD**, so the
selector works for free until then.

## 19.3 Verification (`providers/probe-intelligent.mjs`)

| Case | Chosen target | Estimated cost |
|---|---|---|
| ~293K tokens, cached (8 messages) | **deepseek/deepseek-flash** | ~$0.00671/step |
| ~98K tokens, cached (6 messages) | **alibaba/qwen3.7-flash** (EU) | ~$0.00187/step |
| ~2K tokens, fresh | **alibaba/qwen3.7-flash** (EU) | ~$0.00012/step |
| new session, quota free | **alibaba-intl/qwen3.7-flash** | **$0.00000** (free quota) |
| the same session, next step | **STICKY** (does not switch) | — |
| long + repeated call | **deepseek-v4-pro** (escalation) | — |
| an image in the request | **alibaba-intl/qwen3.8-flash** (vision chain) | — |

Of these **3/3 are at the real switch-over point**: at 293K DeepSeek wins (above 256K Qwen falls into the
top tier), at 98K the EU Qwen wins, and for a small fresh request the EU Qwen wins too (5× under
DeepSeek).

**That is why I deleted an earlier rule:** `friss-nagy-kontextus` (`minTokens: 180000, maxMessages: 6`)
override the selector and chose a more expensive target — the selector handles tiered pricing more
accurately. The `kep` rule stayed (it guarantees a capability and gives a local backup).

## 19.4 Observability and tuning

- `GET /healthz` → `intelligent`: `sessions` (which conversation is stuck on which target, how many steps,
  how many switches), `quotaUsed` (the estimated free-quota consumption per target), `decisions` (the last
  12 decisions with reasoning), `tuning`.
- Tuning in `config.json`: `assumedCachedShare` (0.9), `assumedOutputTokens` (900),
  `assumedRemainingSteps` (8), `switchMarginPct`.
- The log lines: `AUTO auto: VALASZTAS — cost-optimal (…)` / `AUTO auto: RAGADOS — …` /
  `AUTO auto: eszkalacio-porgas …`.

## 19.5 Usage

In DSH the model selector's **`Auto (by image / peak / long context)`** chooses this route
(`auto-router/auto` in `settings.yaml`). It appears **after a DSH restart**; from then on every request
goes through the above logic automatically.

---

# 20. AUTOMATIC RE-MEASUREMENT AND OPTIMISATION (`autotune.mjs`)

## 20.1 The cycle (six phases)

| Phase | What it does |
|---|---|
| **1. Measurement** | from the real session logs: request count, tokens, **cache ratio**, output/request (median), steps/session, **the share of spinning work**, cost per target |
| **2. Calibration** | recomputing the selector's parameters from the measured values: `assumedCachedShare`, `assumedOutputTokens`, `assumedRemainingSteps` — **with limits** (0.6–0.95 / 200–4000 / 4–16) |
| **3. Live check** | every provider's `/models` catalogue + latency; it flags if a route target or candidate **no longer exists** |
| **4. Price monitoring** | re-reading the vendor price list (`pricing-parser.mjs`) and a diff against the `pricing` table |
| **5. Application** | `--apply`: writing the tuning into `config.json` (a timestamped backup, only the changed keys); the proxy picks it up by **hot reload**, no restart needed |
| **6. Report + trend** | `providers/reports/autotune-<time>.json`, compared with the previous run (cost/request, cache ratio, spin ratio) |

**Safety limits:** dry-run by default; it **never** writes a price automatically (only with
`--apply-prices`, after checking — because the price colours every decision); every value is clamped into
the sane band; on a warning a **non-zero exit code** (so the scheduler/watchdog can signal it).

## 20.2 The result of the first run

Measured (30 days, 196 sessions, 30 222 requests): cost **$58.38**, **$0.0019/request**, cache ratio
**99.60%**, output/request (median) **394** tokens, steps/session (median) 25, spinning sessions **18.9%**.

From that, the **first calibration** (applied):

| Parameter | Before | After |
|---|---|---|
| `assumedCachedShare` | 0.9 | **0.95** (measured 99.6% × 0.98, clamped) |
| `assumedOutputTokens` | 900 | **394** (measured median) |
| `assumedRemainingSteps` | 8 | **4** (steps/session/8, clamped — cautious, so it does not switch too often) |

Live check: all 7 providers OK (groq 278 ms, nvidia 118 ms, openrouter 258 ms, **alibaba 202 ms**,
**alibaba-intl 684 ms**, **deepseek 293 ms**, ollama 174 ms).

**The autotune also filtered out and fixed a false positive:** it flagged the
`openrouter/qwen/qwen3.8-27b:free` target as missing, because OpenRouter's catalogue does not list the
`:free` **variant** — from now on the presence of the base id is accepted (and so are the dated suffixes).

## 20.3 Scheduling

- **`providers/run-autotune.cmd`** — an ASCII-only shim (`cmd.exe` reads the file in its own code page;
  the UTF-8 accents turned into **command fragments**, measured and fixed), `--days 30 --apply`, output:
  `autotune.out.log`.
- **`providers/register-weekly-autotune.ps1`** — a weekly Windows task (`-Time`, `-Day`, `-Remove`),
  following the repo's existing retune pattern.
- **Registered:** `DSH-AutoTune`, **Sunday 04:30**, first run **2026-10-18 04:30**. Immediate try:
  `schtasks /Run /TN "DSH-AutoTune"`.

## 20.4 What deliberately stays manual

- **Applying a price** (`--apply-prices`): the vendor price list's format may change, and one wrong price
  breaks every cost decision — so human approval is required.
- **The `settings.yaml` model list** (replacing live ids): that is the job of the existing monthly
  `retune.mjs`; the autotune only **flags** if a target died.
