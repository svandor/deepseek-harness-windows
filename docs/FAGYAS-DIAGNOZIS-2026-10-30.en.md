# Diagnosis — freeze between 09:20–09:55 on 2026-10-30

> Magyar változat: [`FAGYAS-DIAGNOZIS-2026-10-30.md`](FAGYAS-DIAGNOZIS-2026-10-30.md)

**Status: NOTE / NOT FIXED.** This document intentionally contains no implemented changes. The `settings.yaml`, tray scripts, and DSH packages are untouched. Fix proposals are in section 8, without application.

- Investigation: 2026-10-30, 09:53–10:00 (local time)
- Note written: 2026-10-30, 14:01 (local time)
- Investigated by: DSH agent (session-6ea8638a…)
- Subject: jobs launched with the `deepseek41flash` model appeared to freeze, only time passed

---

## 1. In one sentence

The DSH did not freeze and the model was not slow: the **DeepSeek official API was under a 503 overload storm**, and the fourth attempt received a **half-dead SSE stream** that, after the answer began, **kept the connection alive for 15 minutes 36 seconds without content**. The DSH has no effective timeout for this, so it waited all the way through — that was "only time passed".

Identification of `deepseek41flash`: the `deepseek-official` provider's `deepseek-flash` model, whose display name in the DSH catalog is **`DeepSeek-V41-Flash`** (`dsh-llm-deepseek/lib/index.js:1843`). The session logs contain `model: "deepseek-flash"` and `provider: "deepseek-official"`.

---

## 2. Timeline — the actual freeze

Source: `C:\Users\info\.dsh\sessions\--C-Szerver-Raider--\session-dfaea1e0-2e40-42cb-82f6-c70f195aa3f3\session.v3.jsonl.zstd`, `turn 10`, `step 5`.

| Time | Record | Content |
|---|---|---|
| 09:26:00.744 | `assistant/attempt` → `finish{error}` | `503`: "Service is too busy. We advise users to temporarily switch to alternative LLM API service providers." — `request_id: 7ba1034c-3a77-4d0b-b1ee-10e51a5d7c7c` |
| 09:26:07 | `assistant/attempt` → `503` | `request_id: eb20111b-ec96-46ed-941f-83261efd1dbe` |
| 09:26:10 | `assistant/attempt` → `503` | `request_id: c6614d6b-de5a-4a26-95b1-724bb8c3419f` |
| 09:26:00–09:26:12 | 3× `llm/retry` | retry 1/5, 2/5, 3/5; delay 457 ms / 944 ms / 1964 ms |
| 09:26:12 | `llm/retry-started` | retry 3/5 started, `provider: deepseek-official` |
| 09:26:18.411 | stream: `block-start` reasoning | response starts |
| 09:27:08.320 | stream: `block-start` tool-call | a `pwsh` call argument stream begins |
| **09:27:08 → 09:42:44** | **no content** | **15 min 36 s silence** (the `finish` chunk `time`: 1793349764098) |
| 09:42:44.098 | `finish{error}` | `SSE stream ended without [DONE]` — code: `STREAM_CLOSED` |
| 09:42:44 | `step/end` + `turn/end` | `{"kind":"error","error":{"message":"SSE stream ended without [DONE]","code":"STREAM_CLOSED"}}` |

Note: the `assistant/attempt` record is only written at the **end** of the stream, so on the UI from 09:27:08 to 09:42:44 literally nothing appeared — only the passing time. That is exactly the reported symptom.

### 2.1 It happened again (not a one-off case)

| Session | Time | Result |
|---|---|---|
| `--C-Szerver-Raider--` / `session-904850a6…` (`turn 1`, `step 1`) | 09:39:21 → 09:47:41 (**8 min 20 s**) | `STREAM_CLOSED`; meanwhile the user wrote: "you're stuck, continue" (09:45:58) |
| `--C-Szerver-Raider--` / `session-dfaea1e0…` (`turn 11`, `step 9`) | 09:46:35 → 09:47:39 (~64 s) | `STREAM_CLOSED` |
| `--C-Szerver-Raider--` / `session-dfaea1e0…` (`turn 10`) | 09:26:12 → 09:42:44 (**15 min 36 s**) | `STREAM_CLOSED` (the main case) |

Earlier that same day: `--C-Szerver-Raider--` / `session-d8813da7…` at 06:14 also `STREAM_CLOSED`. So the error pattern is not new, it just clustered between 09:26 and 09:48.

### 2.2 Number of 503s

In the raw text of `session-dfaea1e0…` `"Service is too busy"` has **6 hits** = 3 attempts × 2 records (`assistant/attempt` + `llm/retry`). `"STREAM_CLOSED"` has **4 hits** = 2 errors × 2 records.

---

## 3. Why no guard caught it (root causes)

### 3.1 The retry tries the same provider — no provider fallback

The `llm/retry` record's `policyKey` field:

```
["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]
```

This is the `dsh-llm-retry` default (`DEFAULT_MAX_RETRIES = 5`, `DEFAULT_INITIAL_DELAY_MS = 500`, `DEFAULT_MAX_DELAY_MS = 10000`, `DEFAULT_JITTER_RATIO = 0.1`, `DEFAULT_RETRYABLE_CODES` — `dsh-llm/lib/index.js:232–236`). The DSH only retries **on the same route**; provider switching is not included. The `settings.yaml` states this itself around line 80: "the DSH llm-retry retries only on the SAME route, does not switch provider".

Since `agent-default-model` points directly to `deepseek-official` / `deepseek-flash`, the `auto` chain in `providers\proxy.mjs` (deepseek/deepseek-flash → alibaba-intl/qwen3.8-flash → alibaba/qwen3.8-flash) is **bypassed**. A DeepSeek 503 storm thus completely halts the main agent.

### 3.2 The 5-minute idle watchdog ineffective against keep-alive

According to `dsh-llm-deepseek/lib/index.js`:

- `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000` (5 minutes), `streamIdleTimeoutMs` is configurable in the provider config (line 1897).
- Watchdog hookup: `idleWatchdog(..., connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)`,
and `request()` passes the callback as: `() => { watchdog.pulse(); }` (line 1627).
- This callback runs **only on SSE comment lines** via `parseSse(response.body, onActivity)` (line 1816): `new EventSourceParserStream({ onComment })` (line 1108). Content chunks do not pulse.

Consequence: if the upstream **sends keep-alive comments but produces no tokens**,
the watchdog stays awake forever. This is exactly what happened during the 15.5 minutes between 09:27:08–09:42:44 — `streamIdleTimeoutMs: 300000` never expired, and the actual deadline was effectively infinite.

### 3.3 `STREAM_CLOSED` is not a retryable code

The `DEFAULT_RETRYABLE_CODES` list (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`,
`TIMEOUT`, `TRANSPORT`) does **not** include `STREAM_CLOSED`. So there is no retry for the error received after 16.5 minutes of waiting: the turn immediately closes with `error`. I.e. the most expensive error (long silence) is met with the least tolerance.

Summarizing the chain: **503 storm → 3 quick retries on the same provider → the 4th attempt's half-dead stream → keep-alive watchdog that never fires → 15.5 minutes of idling → non-retryable `STREAM_CLOSED` → turn death.**

---

## 4. Network context: not only the main route burned

Three parallel children launched during the investigation (free chain, `worker` route via the `http://127.0.0.1:4123` proxy) **all three** stopped at 09:54:26 with this:

```
turn/end  {"kind":"error","error":{"message":"Connection error.","code":"TRANSPORT"}}
```

Meanwhile the proxy `/healthz` response was `ok: true, usable: true, workerUsable: true`
(every provider key "configured", cooldowns empty). So the proxy configuration is fine, the error was in the outbound requests — in the same time window when DeepSeek returned 503s. This confirms it is an **external, provider-side wave**, not a DSH regression.

---

## 5. Second, independent error: the tray's self-healing loop

Source: `C:\Szerver\Deepseek Harness\state\tray.log`.

**Trigger (timestamped):** the `tray.log` rotated at 04:13:39 (`tray.log.1`, 04:13:39), and the first `token=False` appeared at **04:13:59**. The health-check looks for the token URL printed at boot in the log; after rotation it is gone, so it sees the server as "sick" forever.

Current figures from `tray.log`:

| Pattern | Count |
|---|---|
| `health-check: server=True token=False` | **816** |
| `automatic self-heal: restart (server=True token=False)` | **205** |
| `restart: ERROR - could not free port 3080 (pid: 0)` | **139** |
| `start: node … dsh\lib\bin.js web --host 127.0.0.1 --port 3080` | **29** |

Typical excerpt (09:32–09:55):

```
09:33:03 automatikus onjavitas: ujrainditas (szerver=True token=False)
09:33:25 indítás: node … bin.js web --host 127.0.0.1 --port 3080 --no-open
09:33:46 harness fut a 3080 porton (pid 66156)
09:36:07 automatikus onjavitas: ujrainditas (szerver=True token=False)
09:36:10 ujrainditas: HIBA - a 3080 portot nem sikerult felszabaditani (pid: 0)
09:44:11 (native-tray.log) tálca kilépés
09:44:28 indítás: nincs futó tálca, új példány indul (ablak nyitásával)
09:53:27 indítás: node … (pid 58308)
09:53:48 FIGYELEM: nem találtam token URL-t a naplóban
09:53:49 → harness.err.log: EADDRINUSE 127.0.0.1:3080
09:55:25 automatikus onjavitas: ujrainditas (szerver=True token=False)
```

Consequences:

- A new `dsh web` instance starts every 60–90 seconds, failing with `EADDRINUSE` due to the occupied port — recorded in `state\harness.err.log` (`@deepseek-ai/dsh-host-webserver: listen EADDRINUSE … 127.0.0.1:3080`).
- Shutdown does not work: the port owner appears as `pid: 0`, so the old instance stays alive.
- The tray exited at 09:44:11, and a **second** tray instance started at 09:44:28.

**Important clarification:** this cycle is **not** the cause of the 15-minute freeze. The long `turn 10` survived the 09:33 restart attempt (that instance could not bind), and the stream only broke at 09:42:44. The tray cycle is an independent, chronic operational error: redundant boots, CPU/RAM waste, misleading logs, and it can mask real errors.

---

## 6. What I ruled out (so the next round doesn't go there)

- **Not local Ollama / VRAM.** `llama-server.exe` did not participate in the main route;
  the `ollama-local` provider is only a fallback.
- **Not proxy shutdown.** `/healthz` was `ok: true` throughout, cooldowns empty,
  every key "configured".
- **Not session log writing.** The logs are consistent, the 15-minute silence is
  proven by record timestamps, not a truncated file.
- **Not a Web GUI client error.** The client simply did not receive what never arrived:
- the stream silently stalled on the server side.
- **Not a context window overflow.** The `usage` fields are normal (input ~0.2–3 k tokens,
  `cacheReadTokens` high), no `CONTEXT_WINDOW_EXCEEDED`.

---

## 7. How to re-verify at any time

The session logs are zstd-compressed JSONLs, readable without `zstd.exe`
with Python 3.14+ (`from compression import zstd`):

```python
import json, datetime, glob, os
from compression import zstd
p = r"C:\Users\info\.dsh\sessions\--C-Szerver-Raider--\session-dfaea1e0-…\session.v3.jsonl.zstd"
for l in zstd.decompress(open(p,'rb').read()).decode('utf-8','replace').splitlines():
    r = json.loads(l)
    if r.get('type') in ('llm/retry','turn/end','assistant/attempt'):
        print(datetime.datetime.fromtimestamp(r['time']/1000).strftime('%H:%M:%S'), r['type'], json.dumps(r['data'], ensure_ascii=False)[:200])
```

- Evidence of half-dead streams: `'SSE stream ended without [DONE]'` and
  `'Service is too busy'` in the session files.
- Evidence of the tray cycle: `Get-Content state\tray.log | Select-String 'token=False'`.
- Evidence of the startup collision: `state\harness.err.log` (EADDRINUSE).
- Watchdog behavior: `dsh-llm-deepseek/lib/index.js` lines 1108, 1627, 1816.

---

## 8. Suggested fixes — **NOT APPLIED**

Ordered by impact/risk ratio. Item 1 is a human decision, items 2–3 are
configuration/script, item 4 is DSH code.

### 8.1 (human decision) Switch main model for the duration of the 503 storm

While the DeepSeek official API is overloaded, the main agent should be routed to
a route that has provider-level fallback:

- `auto-router` / `auto` (proxy `auto` chain: deepseek → alibaba-intl/qwen3.8-flash → alibaba/qwen3.8-flash), or
- `alibaba-compat` / `qwen3.8-flash` directly.

Affected key: `~/.dsh/settings.yaml` → `agent-default-model`. This is a cost and
route-policy decision, so I do not recommend automatic overwriting.

### 8.2 Adding `STREAM_CLOSED` to retryable codes

`retryPolicy` is defined under the provider-config (per the `dsh-llm-retry`
`validateConfig`, root-level `retryPolicy` is explicitly disallowed).
Suggested insertion into `settings.yaml` (for accuracy: the `backoff` field names
come from `dsh-llm`'s `backoffSchema`: `initialDelayMs`, `maxDelayMs`,
`jitterRatio`):

```yaml
llm-deepseek:
  retryPolicy:
    mode: normal
    maxRetries: 5
    retryableCodes:
      [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, STREAM_CLOSED]
    backoff:
      initialDelayMs: 500
      maxDelayMs: 10000
      jitterRatio: 0.1
```

Benefit: the truncated stream can reach a response after retry instead of the turn
dying. Risk: the retry could repeat the 15.5-minute silence — so it makes sense
together with item 8.4.

### 8.3 Fixing the tray health-check

- Remove the `token=False` criterion or **persistently store** the token URL
  (once after boot, in a rotation-independent location), so log rotation does not
  trigger forever.
- Handle the "port freeing" error caused by `pid: 0`: resolve the port owner
  from the actual listener, not from its own PID file, otherwise the old instance
  never shuts down.
- Mandatory check before restart: if 3080 already responds, **do not** launch a
  new instance (this causes the `EADDRINUSE` crashes).

### 8.4 (DSH code) Content-based deadline next to the watchdog

The current watchdog pulses on keep-alive comments, so it does not protect against
"the connection is alive but the model produces nothing". Proposal: let `watchdog.pulse()`
also run on **payload chunks** (or have a separate `firstByte`/`progress`
deadline), so content-free silence yields a `TIMEOUT` — which is already among
the retryable codes, so it is useful even without item 8.2.

This is a package modification (`@deepseek-ai/dsh-llm-deepseek`); outside `state`
it does not affect the workspace, but the `_npx` cache needs patching — only with
separate approval.

### 8.5 What **not** to do

- Do not increase `streamIdleTimeoutMs`: that is not the bottleneck, the watchdog
  never fired anyway.
- Do not reduce `maxRetries`: the error was not caused by the number of retries.
- Do not touch the proxy routes: per `/healthz` they are fine.

---

## 9. To watch in the coming days

1. Does `503 Service is too busy` return on `deepseek-official` (session log
   hits of `'Service is too busy'`)?
2. Does a new `STREAM_CLOSED` occur even without a `dsh-llm-deepseek` fix?
3. Does the `token=False` / `automatic self-heal` count in `tray.log` decrease
   (today 816 / 205) — if not, the tray cycle needs fixing on its own too.
4. Does the number of EADDRINUSE lines in `harness.err.log` stay at 0?

---

## 10. Changelog

- `2026-10-30` — note created regarding investigation of the freeze between
  09:20–09:55. **No modification made**: `settings.yaml`, tray scripts,
  the proxy, and DSH packages are untouched.
- `2026-10-30 14:01` — item 11 (post-observation) appended; header timestamps
  refined. Still no functional modification.

---

## 11. Post-observation (14:01) — tray state has changed since

When writing the note, at 14:01 I checked the tray state. The picture is partly
different from the 04:13–10:51 period, so I record:

- `state\tray.log` **breaks off at 10:51:48**, and its last lines no longer show
  an error but success:
  `10:51:45 harness already running on port 3080 (healthy: True)`.
  So the earlier 60–90-second self-healing cycle stopped then (at least it does
  not continue in this log; no new entries for ~3 hours since).
- Per `state\native-tray.log`, the native tray restarted between **13:29:48–13:30:07**,
  and this time it **found and saved the token URL**
  (`new token saved: http://127.0.0.1:3080/?token=1cVlvvp3…`), then launched
  the harness (pid 56384) and the window too.
- Per `state\tray.pid`, however it has been **10844 since 09:44:28**, i.e. stale:
  the PID file does not track the actual tray instance. This may explain the
  `pid: 0` / "could not free port" behavior described in item 8.3.

Conclusion for the note: the cycle described in item 5 is a **measurable fact**
for the 04:13:39–10:51 window, but **not permanent**: re-finding the token URL
(new boot) ends the false alert. The error is still real (log rotation → lasting
false `token=False`), just not continuous — the fix proposal (8.3) remains valid,
its priority is just lower than 8.2's.

Items 8.1–8.5 remain **unapplied proposals**.
