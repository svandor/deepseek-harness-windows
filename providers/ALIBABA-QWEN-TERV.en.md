# Wiring Alibaba Cloud (Qwen) into DSH — a prepared plan

> Hungarian version: [`ALIBABA-QWEN-TERV.md`](ALIBABA-QWEN-TERV.md).

**State:** recon done, **waiting for an API key**. Not installed, not measured.
**Date:** 2026-10-01
**Related:** `FELJEGYZES.md` (sections 4 and 9), `README.md`, `config.json`

> **IMPORTANT about the source:** the endpoint, model and price data below come from the
> **vendor's own documentation**, not from a live measurement. This document deliberately
> distinguishes the *documented* from the *measured* claim. Where a measurement exists it is
> marked. As soon as a key exists, section 7 says how to measure — until then none of the claims
> here can be considered proven on this machine.

---

## 1. Why this came up at all

The measured weak points of the current free chain (`worker`):

- Groq's free quota is **8 000 tokens/minute**, below which a real subagent context (measured
  request: 9 395 tokens) dies with `HTTP 413`;
- the chain's last element, `ollama/qwen2.5-coder:14b`, does not produce real `tool_calls` within
  **35 s** either (it writes the call out as content text) — a measured result;
- the free cloud targets occasionally fail with `429`.

Qwen, by contrast, is documented to have **1M context**, **2–5M TPM**, **600–15 000 RPM**, and
`qwen3-coder-flash` is tuned specifically for *multi-turn tool interaction / tool-calling
stability*. A new account gets **1M tokens free per model**.

## 2. Endpoints

OpenAI-compatible endpoint, to be understood without the `/chat/completions` part:

| Region | Base URL |
|---|---|
| Singapore (new) | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Virginia (US) | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |
| Hong Kong (China) | `https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1` |
| Tokyo | `https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Beijing (new) | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |

Old domains that still work: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
(Singapore), `https://dashscope.aliyuncs.com/compatible-mode/v1` (Beijing). The QwenCloud
documentation also lists `https://maas.qwencloudapi.com/compatible-mode/v1`.

**The key is bound to a region.** The key must be created in the region whose endpoint you call.
A key from another region gives **not** `403` but `HTTP 401` + `invalid_api_key` + `Incorrect API
key provided` — which is misleading, because it suggests the key is wrong when you merely picked
the wrong region.

`{WorkspaceId}` = the Model Studio console's workspace ID.

## 3. Models and prices (documented, 2026-10-01)

| Model | Input /1M | Output /1M | Implicit cache /1M | Context | Max output | TPM | RPM |
|---|---|---|---|---|---|---|---|
| `qwen3-coder-flash` | $0.30 | $1.50 | $0.06 | 1M | 65K | 5M | 600 |
| `qwen3-coder-plus` | $1.00 | $5.00 | $0.20 | 1M | 65K | 2M | 2K |
| `qwen3.8-max` | $2.00 | $6.00 | $0.25 | 1M | 131K | 2M | 15K |

- **`qwen3-coder-plus` is retired on 2026-10-10** — do not build on it.
- `qwen3.8-max` natively accepts **image + text + video** input, and in "thinking" mode gives up to
  a 262K reasoning budget.
- Besides Qwen, Model Studio serves **third-party** models on the same endpoint: DeepSeek, Kimi,
  GLM, MiniMax. So DeepSeek is reachable through an Alibaba endpoint too (its price has to be
  checked separately).

## 4. Price comparison with DeepSeek

The DeepSeek-side numbers come from the **repo's own price table**
(`plugins/dsh-ui-extras/lib/index.js`, "Official DeepSeek list prices"), USD / 1M tokens, peak /
off-peak:

| Model | Input (cache miss) | Input (cache hit) | Output |
|---|---|---|---|
| `deepseek-flash` | 0.30 / **0.15** | 0.006 / **0.003** | 1.20 / **0.60** |
| `deepseek-v4-pro` | 1.32 / **0.66** | 0.044 / **0.022** | 3.96 / **1.98** |

Compared:

- `deepseek-flash` off-peak is **~2× cheaper on input, ~2.5× on output**, and **~20× cheaper on
  cache hits** than `qwen3-coder-flash`;
- `deepseek-v4-pro` off-peak is **~3× cheaper** than `qwen3.8-max`;
- at peak the input of `qwen3-coder-flash` ($0.30) equals that of `deepseek-flash`, while on output
  it is still more expensive ($1.50 vs $1.20).

**Conclusion:** DeepSeek is cheaper at every comparable level. Qwen's value is not the price but the
**context size, the rate limit and the tool stability**.

## 5. Wiring into DSH — concrete steps

There is no native Alibaba plugin. It has to be declared by hand on the
`@deepseek-ai/dsh-llm-pi-ai` route — exactly as Groq/NVIDIA/Ollama already work in this
installation.

**5.1 Key.** `DASHSCOPE_API_KEY` goes into the `refs:` section of `~/.dsh/.credentials.yaml` (the
Web GUI's Settings → Models writes it there, or by hand).

**5.2 Route in `~/.dsh/settings.yaml`** (under the `llm-pi-ai:` section, next to the existing
providers):

```yaml
llm-pi-ai:
  providers:
    alibaba:
      displayName: Alibaba Model Studio (Qwen)
      apiKeyEnv: DASHSCOPE_API_KEY
      api: openai-completions
      baseURL: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
      defaultContextWindow: 1000000
      defaultMaxTokens: 65536
      models:
        - id: qwen3-coder-flash
          name: Qwen3 Coder Flash
          contextWindow: 1000000
          maxTokens: 65536
        - id: qwen3.8-max
          name: Qwen3.8 Max
          contextWindow: 1000000
          maxTokens: 131072
```

- The provider key must be a **lower-case, hyphenated** identifier if you also want to use the
  built-in login (`alibaba` qualifies).
- The `models` list **replaces** that route's catalogue. Since there is no installed catalogue
  here, giving `contextWindow`/`maxTokens` is effectively mandatory: without them the route falls
  back to `defaultContextWindow` (262 144) and `defaultMaxTokens` (32 768), which is misleading
  next to Qwen's 1M.

**5.3 Reasoning.** Qwen uses the **same shape** as DeepSeek: `extra_body={"enable_thinking": true}`
in the request, and `reasoning_content` in the streamed delta fields. pi-ai also knows the `qwen`,
`qwen-chat-template` and `deepseek` thinking formats, so it has to be connected through
`compat.thinkingFormat` — which one is correct is **a question of measurement** (see section 7).

**5.4 Optional: include it in the fallback chain.** If you want to extend the `worker` chain's cloud
backup, an `alibaba` entry goes into the `providers` section of `providers/config.json` (`baseURL`,
`apiKeyEnv`), and then `alibaba/qwen3-coder-flash` into `routes.worker.targets`. **The proxy must be
restarted after saving config.json** — see `FELJEGYZES.md` section 4.

## 6. Known obstacles — to solve before "just as effective"

1. **Documented `stream` + `tools` conflict.** Alibaba's OpenAI-compatibility page says: *"The tools
   parameter cannot be used with stream=True simultaneously."* The current function-calling guide,
   however, shows a streaming tool call, so the sentence is probably a stale leftover. **DSH streams**,
   so this is the first thing to prove live. If it is true, Qwen is out for the agent loop.
2. **Region-bound key** (see section 2) — the endpoint must be chosen for the key's region.
3. **An accounting bug in the repo's price table.** The `modelPrices()` function in
   `plugins/dsh-ui-extras/lib/index.js` (lines 2071–2080) matches the model id as a **substring**,
   and the table contains a **zero-priced `"qwen3.8"` key** (line 2063) because of the *free*
   OpenRouter target (`qwen3.8-27b:free`). Therefore:
   - `qwen3.8-max` (paid, $2/$6) → contains `qwen3.8` → is classified as **free**, `isFreeModel()`
     returns true, and delegated work shows up in the statistics as "saved for free";
   - `qwen3-coder-flash` → matches nothing → takes `deepseek-flash`'s price, which happens to be
     right on input ($0.30) but underestimates on output ($1.20 instead of the real $1.50).

   **Fix (when needed):** narrow the `"qwen3.8"` key to `"qwen3.8-27b"` (that still hits the free
   `qwen3.8-27b:free` but not `qwen3.8-max`), and add separate, paid rows for the real Qwen models.
   Insertion order matters, because `modelPrices()` returns the **first** match.
4. **No native catalogue or reasoning integration.** DeepSeek has its own adapter
   (`dsh-llm-deepseek`); Qwen remains a manual route: you must supply the context and output budgets,
   the reasoning format is a `compat` setting, and DSH's price/statistics model does not know it —
   see point 3.

## 7. Verification plan once the key exists

In order, because if the 1st fails the rest is pointless:

1. **Key and region:** `GET {baseURL}/models` with a bearer token. If `401 invalid_api_key`, the key
   belongs to another region — do not start swapping the key, adjust the endpoint.
2. **`stream` + `tools` together** — this is the decisive test. By hand, calling the boundary
   directly (not through DSH), so the error is unambiguous.
3. **Tool call in non-stream mode**, then a **multi-turn** tool chain (`qwen3-coder-flash` is
   supposedly optimised for this).
4. **Large context** (~40–80K tokens) — because of Groq's 8K wall this is the real test, not the
   400-token one.
5. **Reasoning:** `enable_thinking`, and whether `reasoning_content` appears in the stream; this
   decides the correct value of `compat.thinkingFormat`.
6. **Price:** the actual billed tokens of a request of known size, compared with the prices in
   section 3.
7. **Only after that** the DSH integration: adding the route, running one delegation following the
   `subagent-worker` pattern, and fixing the price table (point 6.3).

## 8. Open questions

- Do `dashscope-intl` and the new workspace domain accept the same key.
- Exactly which models the free 1M tokens/model applies to, and for how long.
- How the DeepSeek price measured on the Alibaba endpoint compares to the direct DeepSeek price (if
  it is cheaper, that is a separate opportunity).
- After `qwen3-coder-plus` retires on 2026-10-10, what the official successor is.
