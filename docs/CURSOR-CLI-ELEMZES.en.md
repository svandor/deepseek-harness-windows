# Cursor subscription inside DeepSeek Harness — analysis and decision

> Hungarian version: [`CURSOR-CLI-ELEMZES.md`](CURSOR-CLI-ELEMZES.md).

**Date:** 2026-09-30
**Status:** DECIDED, set aside. The route: **Cursor CLI, ban-free mode**, using up the quota, and
cancelling the subscription at the end of October 2026.
**Related:** [`BOT-TERV.md`](BOT-TERV.md) (replacing the Grok Bot), `providers/README.md`

---

## 1. The decision and the reason in one paragraph

Of the ban-free surfaces **Cursor CLI** (`agent`) was chosen — not the community DSH plugin
(`dsh-llm-cursor`) and not the `cursor2api` bridge. The subscription's quota is therefore used
**not** through the DSH model selector but through the **official CLI**: DSH plans, reconnoitres
and verifies with free models, and the repo-level hard work is done by one well-written
`agent -p` run at a time. The main arguments: (a) according to Cursor staff, both unofficial
routes are **ToS violations, possibly a permanent ban**; (b) next to DSH's cache-heavy loop the
Cursor quota would be gone within a few sessions anyway, so the gain is small against the ban
risk; (c) the CLI runs the same harness, just **not inside the IDE**.

---

## 2. What we rejected, and why

| Route | Why not |
|---|---|
| **`dsh-llm-cursor` plugin** (v0.2.23) | The author's own warning: "Cursor staff treat this class of private-client usage as against the Terms of Service. **Your Cursor account can be restricted or banned.**" The plugin calls private `api2.cursor.sh` endpoints (Deep Control PKCE + Connect/protobuf), not an official surface. |
| **`cursor2api`** (Docker, AGPL) | The same ToS class + Docker/WSL2 + a separate login flow; it was born out of the "ceiling" of the CLI-wrapper approach, but the ban risk and the maintenance burden grow instead of shrinking. |
| **Cursor on the main thread / as the subagent default** | Precisely the pattern that burned the quota in the IDE: many large-context, tool-calling rounds. The subagent fan-out and compaction are the most token-hungry parts. |

There is **no** official OpenAI-compatible Cursor API; Cursor ships its own harness
(IDE, CLI, `@cursor/sdk`, Cloud Agents), and the public request for it on the forum is open with
no deadline.

---

## 3. Prices and the measured baseline

Measured baseline (11 sessions, 3 143 calls, 2026-09-27):

| Metric | Value |
|---|---|
| Fresh input | 5 680 032 tokens |
| Output | 1 966 671 tokens |
| **Prompt-cache read** | **1 081 724 032 tokens** |
| Cost at the then `deepseek-flash` price | $4.37 |
| The same without cache | $152.79 (the cache saves 97.1%) |

The same with today's DeepSeek prices:

| Scenario | Cost |
|---|---|
| DeepSeek Flash **peak** | **$10.55** |
| DeepSeek Flash **off-peak** | **$5.28** |
| DeepSeek V4-Pro peak | $62.88 |
| One session (~286 calls), Flash peak | $0.96 |

Prices per `/1M` tokens (the cache-hit is the decisive column):

| | DeepSeek Flash peak | DeepSeek Flash off-peak | Composer 2.5 | Grok 4.7 | Claude Opus 5.5 | Gemini 3.8 Flash (paid) |
|---|---|---|---|---|---|---|
| Input | $0.30 | $0.15 | $0.50 | $2.00 | $4.00 | $0.75 |
| **Cache-hit** | **$0.006** | **$0.003** | $0.20 | $0.50 | $0.20 | $0.075 |
| Output | $1.20 | $0.60 | $2.50 | $6.00 | $20.00 | $3.75 |

**Consequence:** the monthly 1.08 billion cached-read tokens would cost **$216–541** at Cursor
prices. The Cursor quota is not a cheap token source for DSH's loop; its role is **targeted,
bounded work**, not the daily agent loop.

---

## 4. Cursor IDE vs DSH + Cursor CLI

Both run **the same Cursor harness**, on the same models, in the same two pools (Cursor Models
pool / Other Models pool) — the **token price is identical**. The difference is the **token
volume per task** and the **waste**.

| Mechanism | Who wins | Why |
|---|---|---|
| **Session reuse (cache)** | IDE, or DSH with **one** session driven by `--resume` | Every new `agent -p` call **starts a new Cursor session** → the repo context is paid for again. 5 separate calls = 5× input. |
| **Cost of a failed run** | **IDE** | On a complex task the chance of drift is high; in the IDE you stop it at step 3, in `-p` mode the **whole run's** tokens are spent. |
| **Shape of the context** | **DSH** | You define the prompt; the measured cache lesson (97% saving) applies here. |
| **Free offload** | **DSH** | Recon, search, summarisation, verification on the $0 chain — the Cursor quota only goes to the hard core. |

| | Cursor IDE | DSH + Cursor CLI |
|---|---|---|
| Interactive steering | ✅ plan/approve, checkpoint, rollback, diff | ❌ one shot; `git diff` afterwards |
| Context about the repo | ✅ richer (index, retrieval, review) | ⚠️ directory-based, fewer review tools |
| Writing to files | ✅ with approval | ⚠️ `--force` needed, otherwise it only suggests |
| Parallelism | ⚠️ manual | ✅ several `agent -p` at once |
| Automation, repeatability | ❌ | ✅ JSON output, schedulable, logged |
| Fitting into the DSH workflow | ❌ | ✅ skill/preset/session log/subagent |

**Rule:** if the task only becomes clear midway → IDE. If it can be written in advance and checked
afterwards (test, `git diff`, schema) → DSH + CLI.

**The target shape (the smallest quota burn):**
free recon → a precise brief → **one** `agent -p` run → 1× `--resume` fix → free verification.
Avoid 5 separate calls without `--resume`.

---

## 5. Rules of the DSH + Cursor CLI mode

1. **One task = one session.** For fixes `--resume` / `--continue`, never a new session.
2. **Explicit `--model`** (`composer-2.5`, at most `grok-4.7`), so it does not slip into the
   expensive Other Models pool via Auto.
3. **`--mode`**: `ask`/`plan` for research (read-only), `agent` + `--force` for writing.
4. **Git checkpoint before `--force`** (branch or commit) — rollback is git.
5. **Long runs as background jobs** from DSH (the sandbox kills the process tree at the end of the
   command — see `providers/FELJEGYZES.md` 6/d).
6. **On-demand spend limit 0** on the Cursor dashboard, so running out of quota stops instead of
   billing.
7. **Guard rails:** Cursor never becomes the default model, it is not added to the
   `subagent-model-selection` allowlist, to the preset's `agentOptions`, or to the
   `providers/config.json` chain.
8. **DSH's statistics do not see Cursor tokens** (those are spent inside the CLI) — the quota burn
   has to be measured on the Cursor dashboard.

---

## 6. Open points to prove before deployment

1. Does the DSH sandbox allow the CLI's own state writes (`~/.cursor`): first try
   `agent -p "say OK" --output-format json`.
2. Does a long run survive the end of the `pwsh` tool (background job vs. foreground).
3. The Cursor CLI version pin and the HTTP/2 (ALPN) requirement — re-check after an update.

---

## 7. What disappears with the cancellation

- The Cursor Models pool (Grok 4.7 / Composer 2.5) and the Other Models quota.
- **Grok Bot access** (included in Cursor Pro since 2026-08-26) — the replacement plan:
  [`BOT-TERV.md`](BOT-TERV.md).

---

## 8. To do before the cancellation

- [ ] **Deliberate** use of the quota: for tasks along the target shape above (not scattered),
      watching the dashboard weekly.
- [ ] On-demand spend limit **0** — checked before billing.
- [ ] Export what is needed from Cursor (own rules, skills, prompts, `.cursor/rules`) into the
      workspace.
- [ ] Remove the CLI or leave it in place (the login becomes invalid with the cancellation); clean
      up `~/.cursor`.
- [ ] `dsh-llm-cursor` is **not** installed — there is nothing to uninstall.
