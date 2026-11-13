# Alibaba spend vs. DSH panel — who spent, how much, and was it worth it?

> Magyar változat: [`KOLTSEG-ELEMZES-2026-10-26.md`](KOLTSEG-ELEMZES-2026-10-26.md)

**Date:** 2026-10-26. **Cycle:** 2026-10 (October 1–26, month still open).
**Labels:** [M] = measured (live API / log), [D] = documented, [K] = calculated/estimated.

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Did DSH spend on the Alibaba bill? | **Yes, practically in full — DSH spent it.** [M] |
| How much is the October Alibaba bill? | **31,01 USD net / 39,38 USD gross** (with 27% VAT). [M] |
| What does the DSH panel show about it? | **0,13 USD** (0,4% of the real net bill). [M] |
| Is it due to delegation? | **Partly: ~1/4 of the bill is delegation, ~3/4 is the main thread `Auto` model.** [M/K] |
| Cost-effective? | **No: a loss with VAT.** On the measured 5 days (Oct 22–26), **17,01 USD gross** went to Alibaba, the same traffic on DeepSeek-flash would have been **10,74 USD** → **+58%, ≈6,3 USD loss**. For all of October ≈13–15 USD loss. [M/K] |
| Main error | The "free chain" is **dead** (Groq 8K TPM, OpenRouter 402), so the proxy routes every request to paid Alibaba models — while the panel prices them at 0. [M] |

The user observation ("similar spend on the Alibaba side as on the DSH panel") is **accurate**: on October 21 the Alibaba bill was 6,21 USD, the panel 6,29 USD the same day — 99% match, because the same traffic went to Alibaba. [M]

---

## 2. Who spent? (attribution)

**Verdict: the spend belongs to DSH, no foreign consumer.** [M]

Evidence:

1. **Bill side:** the 2026-10 cycle `DescribeInstanceBill` has 102 line items with **only two workspaces** listed, and both are DSH's configured endpoints:
   - `ws-kt393ifjia7nh7rh` (EU, Frankfurt) — `settings.yaml` `alibaba` provider, **11,87 USD**
   - `ws-7pa8b93c9tnmgi1w` (SG, Singapore) — `alibaba-intl`, **19,11 USD**
   No third workspace (other tenant/application) is on the bill.
2. **Model side:** the itemized breakdown is exactly the models of the DSH proxy chains: `qwen3.7-flash` 19,56 USD, `qwen3.8-flash` 11,39 USD, and the remaining 0,03 USD is spread across 11 models (`kimi-k3`, `glm-5.1/5.2`, `qwen3.8-max`, `qwen3.7-max*`, `deepseek-v4-pro`, `qwen3.5/3.6-*`) — this is the output of the 2026-10-14 `probe-alibaba*.mjs` measurement series. [M]
3. **Traffic side:** the Alibaba HITs in the proxy log and the request counts in the DSH session logs match day by day (93–99%), and the bill/HIT ratio is stable at **0,0017–0,0036 USD/request** — there is no "unexplained remainder" that would point to other consumption. [M]
4. **Machine side:** on the machine, **exactly one** process talks to `*.maas.aliyuncs.com`: `providers/proxy.mjs` (PID 31748, port 4123). LiteLLM is not installed/running, there is no `ALIBABA_*`/`DASHSCOPE_*` environment variable, and no other app config references the endpoints. [M]

**Limitation:** if the same key were also used on *another machine* in the same workspace, it would not show here — but then the per-request cost spread would differ from the narrow band measured now. The cost is still DSH's with 95%+ confidence.

---

## 3. Panel vs. reality

DSH panel (`/ui-extras/usage`, 2026-10-01…26): [M]

| Panel row | Request | Token | Panel cost |
|---|---|---|---|
| deepseek-official/deepseek-flash | 42 763 | 14,07 bn | **73,70 USD** |
| auto-router/auto (proxy, "Auto") | 6 995 | 1,75 bn | **26,68 USD** |
| alibaba/qwen3.8-flash (direct) | 46 | 4,45 M | **0,13 USD** |
| subagent-worker/worker ("free chain") | 8 990 | 0,40 bn | **0,00 USD** |
| **Total** | | | **100,50 USD** |

Alibaba BSS (same period): **31,01 USD net**, of which VAT 5,40 → **39,38 USD gross**. [M]

| Item | Panel | Reality | Difference |
|---|---|---|---|
| Alibaba | 0,13 USD | 31,01 USD net / 39,38 USD gross | **≈240× underestimated** |
| Total spend | 100,50 USD | ≈118–122 USD net / ≈126–131 USD gross [K] | 18–30% underestimated |
| Alibaba share | 0,12% | **≈25–30%** | — |

**Why is the panel blind?** DSH only sees the *client-side* route name: delegated requests come in as `subagent-worker/worker`, for which `MODEL_PRICES` has **0 USD**, while the proxy calls a paid Alibaba model in the background. Likewise, `auto-router/auto` traffic is priced at DeepSeek-flash rates even when the proxy offloaded it to Qwen. The panel's `alibabaSg` row is 0 because the `alibaba-intl/*` label never occurs in the session logs.

Therefore the panel's "free chain" statistics are **fictitious**: for 9,077 requests it claims 0 USD cost and **17,07 USD savings**, while the real Alibaba bill for this traffic is ≈8–10 USD net — and worse than that: in reality it is **not savings, but extra cost** (see section 6).

---

## 4. VAT — the 27% invisible to the panel

The BSS `QueryBillOverview` and `QuerySettleBill` are clear: [M]

| Settlement | Net | VAT | Gross | VAT rate |
|---|---|---|---|---|
| 2026-10-14 11:27 → 10-22 23:53 | 6,97 | 1,88 | 8,85 | **26,97%** |
| 2026-10-14 12:36 → 10-22 23:56 | 13,04 | 3,52 | 16,56 | **26,99%** |
| 2026-10-22 23:55 → 10-26 15:25 (open) | 6,06 | — | — | (27% expected) |
| 2026-10-22 23:57 → 10-26 19:27 (open) | 5,01 | — | — | (27% expected) |

Therefore **27.0% Hungarian VAT** burdens the entire Alibaba spend (it will also apply to the still partially open 11,07 USD). Month-end gross: **31,01 × 1,27 = 39,38 USD**.

All panel prices are **net list prices**, without VAT — so the real payable amount on each Alibaba line is 27% more than what the panel shows. On the DeepSeek side the panel also uses net USD list prices; no VAT appears on DeepSeek USD top-ups (verifiable on your own invoice — if there is 6% Chinese VAT there anyway, it does not meaningfully move the ratios).

---

## 5. Price comparison — with VAT

USD / 1M token, **net → with 27% VAT** (net in parentheses): [D] list prices + [M] VAT rate

| Model / tier | Input (miss) | Cache hit | Output |
|---|---|---|---|
| deepseek-flash (off-peak) | 0,15 | 0,003 | 0,60 |
| deepseek-flash (peak 01–04, 06–10 UTC) | 0,30 | 0,006 | 1,20 |
| qwen3.7-flash EU ≤32K | 0,036 (0,028) | **0,0036 (0,0028)** | 0,140 (0,110) |
| qwen3.7-flash EU 32K–256K | 0,105 (0,083) | 0,0105 (0,0083) | 0,419 (0,330) |
| qwen3.7-flash EU >256K | 0,210 (0,165) | 0,021 (0,0165) | 0,838 (0,660) |
| qwen3.8-flash EU | 0,144 (0,113) | 0,0144 (0,0113) | 0,485 (0,382) |
| qwen3.8-flash SG | 0,191 (0,150) | 0,0190 (0,0150) | 0,597 (0,470) |

**Takeaway:** with VAT
- **qwen3.7-flash EU** beats DeepSeek on fresh tokens (0,036 vs 0,15–0,30), on cache ≤32K it is **on par** (0,0036 vs 0,003–0,006), but above 32K the cache is 1.8–3.5× more expensive;
- **qwen3.8-flash SG** is **3–6× more expensive on cache** than DeepSeek — the worst choice for cache-heavy traffic;
- our traffic is **cache-heavy** (main thread: 96% cache hit, delegation: 79%), so the cache column decides, not the fresh input.

---

## 6. Efficiency

| Metric | Value |
|---|---|
| Delegated child sessions (Oct.) | 556 sessions [M] |
| Delegated requests | 9 015 requests [M] |
| Delegated tokens | ≈398 M (miss 82,9 M / cache 311,6 M / out 3,9 M) [M] |
| Requests/session | 16,2 |
| Tokens/request | ≈44 000 (79% cache, 1% output) |
| Delegation success rate | 96% (last 2 days, dedup) [M] |
| Dead/stopped children | 8 children / 3 days [M] |
| Proxy HIT (Oct 22–26) | 6 878 |
| of which Alibaba | 5 116 (**74,4%**) |
| of which DeepSeek | 1 762 (25,6%) |
| Free targets (Groq/OpenRouter/Ollama/NVIDIA/Google) HIT | **0** |
| Proxy FAIL | 314 (Groq 413, OpenRouter 402) |
| "COOLDOWN-ahead" log lines | **151 028** (≈22/request) |

**The "free chain" does not exist in practice:**
- **Groq**: `HTTP 413 … TPM Limit 8000, Requested 9502` — the ~44K tokens of delegated requests don't even fit into the 8K TPM frame.
- **OpenRouter**: `HTTP 402 … can only afford 187` — credits exhausted.
- Therefore every request falls on the **paid Alibaba** at the end of the chain, and the health logic pushes the dead targets back on every request (hence the 151K cooldown lines).

**Unit cost [M] — this is the decisive table:**

| Period | Alibaba gross (with 27% VAT) | The same on DeepSeek-flash (peak/off-peak) | Result |
|---|---|---|---|
| Oct 24–26 (delegation only, 2 483 requests, 133,7 M tokens) | **6,44 USD** | 4,20 USD | **+53% more expensive** |
| Oct 22–23 (delegation + `Auto` sessions, 5 116 requests) | **10,57 USD** | 6,54 USD | **+62% more expensive** |
| **Oct 22–26 total** | **17,01 USD** | **10,74 USD** | **+58%, ≈6,3 USD loss** |
| All of October (Oct 1–26) | 39,34 USD | ≈25 USD [K] | ≈14 USD loss [K] |

**Why no savings?** Because the proxy calculates with the ≤32K, 0%-cache tier, while our real requests are **50–250K tokens with 80–96% cache hits**. There the Qwen cache price is **3–7×** the DeepSeek cache price (qwen3.7 SG: 0,01–0,02 vs. DeepSeek 0,003–0,006 USD/M), and Qwen's "cheap" tier (0,003) only lives below 32K, where our requests never land. Per the measurement, the effective price of delegation on Alibaba is **≈0,048 USD/M token** (Oct 24–26), while DeepSeek's is **≈0,031 USD/M** on the same mix.


**Where the money really goes (October, net) [M/K]:**

| Consumer | Alibaba net | Share |
|---|---|---|
| Main thread on `Auto` model (33 top-level sessions + 2 children, 6 866 requests): EU qwen3.7 11,62 + SG qwen3.8 11,17 + EU qwen3.8 0,22 | **≈23,0 USD** | **≈74%** |
| Delegation (`worker` route): SG qwen3.7 7,94 + EU leakage ≈1 | **≈9,0 USD** | ≈26% |
| 2026-10-14 measurements (11 models) | 0,03 USD | 0.1% |

That means **delegation is not the main cost** — at monthly level, the biggest item is that some main-thread sessions run on the `Auto (proxy)` model. **But the spending without Auto for days running is 100% delegation:** according to the proxy log, only `alibaba-intl` HITs occurred on Oct 24–26 (986 + 882 + 350), and the worker request counts (1 045 / 947 / 491) cover that. This $6,44 gross is what the "free chain" produced.

---

## 7. Recommendations (in order of importance)

1. **Make the Alibaba bill visible in the panel.** `providers/bss-client.mjs` already can do it (`QueryBillOverview` → `PretaxAmount`, `Tax`, `AfterTaxAmount`). An "Alibaba (bill, gross)" line would immediately show the 39 USD instead of the current 0,13. This also kills the `freeSavingsUsd` lie.

2. **Price the proxy's background decisions.** `subagent-worker/worker` should not be 0, but the actual upstream (qwen3.7-flash) price; and `auto-router/auto` should not calculate at DeepSeek-flash prices when the proxy chose Qwen. The proxy's `/healthz` already writes the last decision (`Auto → alibaba/qwen3.7-flash`), this can be hooked up.

3. **Decide the fate of the "free chain".** The current state is the worst: you pay for it, but it's labeled "free". Choose:
   - (a) really free: Groq Dev tier (8K → higher TPM) + OpenRouter credit, or squeezing the delegated context below 8K — the latter hurts subagent usability;
   - (b) knowingly paid: `qwen3.7-flash` EU as the primary delegation target (the cheapest live option, even with VAT), remove the dead targets from the front of the chain so they don't generate 151K cooldown lines and don't slow things down.

4. **Don't use the `Auto` model for long, cache-heavy sessions.** The selector's 0% cache-share assumption is wrong there; remove `qwen3.8-flash` (esp. SG) from the `candidates` list, or keep the main thread on `deepseek-official/deepseek-flash`. Estimated gain: 10–15 USD net/month.

5. **Cost watchdog:** daily BSS query + alert above 25 USD/month; the 27% VAT must be included in the budget (the panel shows a number 27% lower than payable).

---

## 8. Reproduction

The scripts newly written for the measurements are in the `.tmp-probe/` directory (built on the existing `providers/bss-client.mjs`):

| Script | Yields |
|---|---|
| `bill-dump.mjs [YYYY-MM]` | monthly bill + model/workspace breakdown |
| `bill-daily.mjs [YYYY-MM]` | daily breakdown (`DescribeInstanceBill` DAILY) |
| `bill-ws-model.mjs` | workspace × model cross-tab |
| `dbg-tax.mjs`, `dbg-tax2.mjs` | `QueryBillOverview` / `QuerySettleBill` — VAT items |
| `proxy-stats.mjs [log]` | daily breakdown of proxy HIT/FAIL/cooldown |
| `provider-daily.mjs [YYYY-MM]` | daily × provider breakdown of session logs |
| `cost-daily.mjs [YYYY-MM]` | daily cost computed with panel pricing logic vs. Alibaba bill |
| `route-sessions.mjs` | which sessions ran on which route (child/main) |

Re-run: `node .tmp-probe/<script>.mjs`. The BSS calls need `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET` in `~/.dsh/.credentials.yaml` (available, `AliyunBSSReadOnlyAccess`).

---

## 9. Configuration change (2026-10-26 12:05) — excluding paid Alibaba from delegation

**Root cause why it fell on paid so far:** among the `worker` chain members there were **four paid/credit-requiring targets** (`openrouter/inclusionai/ling-3.0-flash` = paid slug, `openrouter/qwen/qwen3.8-27b` = paid, `alibaba` EU + SG), and the three "free" targets at the front of the chain always failed on real requests:

| Target | Why it failed | Measurement |
|---|---|---|
| `groq/openai/gpt-oss-120b` | TPM 8000 — requests are 12–250K tokens | `HTTP 413` |
| `openrouter/qwen/qwen3.8-27b` | **paid** slug, 0 credits | `HTTP 402 … can only afford 187` |
| `openrouter/inclusionai/ling-3.0-flash` | **paid** slug (the `:free` variant 404s: "unavailable for free") | `HTTP 404 / 200 paid` |
| `ollama/qwen2.5:7b-instruct` | not running + 32K window | `SKIP … would truncate` |

**New chains (config.json, hot-reload — no restart needed):**

| Route | Old | New |
|---|---|---|
| `worker` | groq → ling(paid) → qwen27b(paid) → **alibaba(paid)** → **alibaba-intl(paid)** → ollama | `nemotron-3.5-super-vl:free` → `nemotron-3.5-lightning:free` → `ollama/qwen25-32k:latest` → `ollama/qwen2.5:7b-instruct` → `groq/gpt-oss-120b` |
| `free-quota` | 5× alibaba-intl (paid per the bill) | same free list |
| `vision-worker` | 3× alibaba | `nemotron-3.5-super-vl:free` → `nemotron-3.5-lightning:free` → `ollama/qwen3-vl:8b` |
| `deepseek-chat` | groq → qwen27b(**paid**) → ollama | groq → `nemotron-3.5-lightning:free` → ollama |
| `auto` **candidates** | 4× alibaba + deepseek | **only `deepseek/deepseek-flash`** (Alibaba dropped out of the selector; it remains in `targets` as a last resort) |

The `pricing` table received the free targets (price 0 + real `contextWindow`), so the SKIP decision and panel pricing are correct. `maxTokens` on the subagent routes: 32768 → 8192.

**Verification (live, via the running proxy):**
- `GET /healthz` → `worker: nemotron-3.5-super-vl:free -> nemotron-3.5-lightning:free -> ollama/qwen2.5:7b-instruct -> groq/gpt-oss-120b`
- 11,5K-token tool-calling test via the proxy: `HTTP 200`, **2,99 s**, 1 real `tool_call`, `usage.cost = 0`, `HIT openrouter/nvidia/nemotron-3.5-super-vl:free` in the log, **0 Alibaba lines**.
- `providers/free-guard.mjs` (new): rule check + **12K-token live test** (1× retry) for every chain member + `--apply` (moves the failed member to the end of the chain, `.bak` before saving) + **BSS Alibaba bill check** (the real measure of the "Singapore free tier"). It was added to `run-retune.ps1` after `chain-doctor`, and the **daily** "DSH model retune daily" task runs it (09:00, `apply` mode).
- **The daily task was dead for 3 weeks:** the trigger with `<EndBoundary>2026-10-04</EndBoundary>` expired, so `Next Run Time: N/A` was set, last run 2026-10-03. I removed the expiry → **next run: 2026-10-27 09:00, daily**. (The weekly "DSH model retune weekly" remains Monday 09:00.)
- **Live example of the limit today:** around 12:50 UTC OpenRouter answered `HTTP 429 — Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free models`, i.e. the **50/day quota is exhausted** (real delegation + today's measurements together), and the chain fell to the local Ollama — `ollama/qwen25-32k` gave a real tool_call in 12 s. This is the practical argument for the one-time 10 USD top-up.
- Ollama running (`ollama serve`, models available: `qwen2.5:7b-instruct`, `qwen3-vl:8b`); `/api/tags` responds.

**Known limitations (these are subjects of the next decision):**
1. **OpenRouter free ceiling:** the documented limit is **50 requests/day** below 10 USD lifetime credit (0,157 USD total used on the key). Delegation is currently 1 000–1 500 requests/day → after the ceiling, the chain falls to **local Ollama**. A one-time 10 USD top-up raises it to 1 000/day — the models remain 0-priced.
2. **Local Ollama — measured, and usable:** `ollama serve` started, models available. By default truncated due to 4K `num_ctx` (a 12K request became 2K and the tool_call was lost), so a 32K variant was created: `ollama create qwen25-32k` (`PARAMETER num_ctx 32768`). Measurement: **10 657-token tool-calling request → HTTP 200, 1 real tool_call, 7,3 s, 0 USD**. On smaller prompts `qwen2.5:7b-instruct` and `gpt-oss:20b` also return tool_call (qwen2.5-coder:14b does not). For delegation above 32K the local model is not suitable (the proxy SKIPs it).
3. **Groq** is only usable below ~4K tokens (TPM 8000), so it's at the end of the chain.
4. Alibaba remains in the `auto` route `targets` list as a **last resort** (in case of DeepSeek failure); if not needed, it can be removed from there too.

### 9.1 OpenRouter: what are the options (status as of 2026-10-26)

According to OpenRouter's official pricing page, the **Free** plan: 25+ free models, 4 free providers, **50 requests/day**. Without top-up, that is the ceiling — delegation is 1 000–1 500 requests/day, i.e. the cloud free tier covers ~4% of the traffic.

Options, measured:

| Option | Cost | Daily quota | Measured result (12K token + tool-call) |
|---|---|---|---|
| **Google AI Studio** (`GOOGLE_API_KEY` available) | **0 Ft** (free tier, if no billing in the project) | Google provides, RPM/RPD per model | **`gemini-3-flash-preview`: 200, 1,7 s, 1 tool_call** — the best |
| **Local Ollama** | 0 Ft | unlimited | `qwen25-32k`: 200, 7,3 s, 1 tool_call |
| OpenRouter `:free` | 0 Ft | **50/day** | `nemotron-3.5-super-vl:free`: 200, 12,7 s |
| OpenRouter with top-up | one-time credit (not a subscription) | per documentation **1 000/day** on free models above ~10 USD credit; credit does not expire | — |
| NVIDIA NIM | 0 Ft | — | **not an option:** nemotron ids 404, `gpt-oss-120b` 410 ("reached its end") |

**Configured:** the `google` provider was added to the proxy (`https://generativelanguage.googleapis.com/v1beta/openai`, `GOOGLE_API_KEY`), and became the **first** target of the delegation chains. Live test on the running proxy: `HTTP 200`, **1,5 s**, 1 real `tool_call`, 11 270-token prompt, log: `HIT google/gemini-3-flash-preview`. `free-guard` rule check: OK (no paid target).

**Still to verify:** (a) whether billing is really disabled in the Google project (otherwise paid), (b) the actual RPM/RPD limit of the Google free tier — on 429 the chain automatically moves to the next free target.

