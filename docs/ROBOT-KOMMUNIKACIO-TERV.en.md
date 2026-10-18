# The robot's communication surface — a proposal

> Hungarian version: [`ROBOT-KOMMUNIKACIO-TERV.md`](ROBOT-KOMMUNIKACIO-TERV.md).

**Date:** 2026-10-01
**Status:** **IMPLEMENTED** (V2 robot console, 3+1 surfaces, "robot only" mode)
**Related:** [`BOT-TERV.md`](BOT-TERV.md), `bot/README.md` sections 5.0–5.0b

---

## 0. Decision and implementation (2026-10-01)

| Question | Decision | Implemented |
|---|---|---|
| Which route | **V2 — robot console inside the panel** | ✅ Console tab: command bar + conversation |
| Layout | **3 workspaces + robot** (32:9) | ✅ `state/tray-config.json`: `panes=3`, `robotPane=true` |
| Robot-only mode | **needed** | ✅ tray: "Robot only mode (1 surface)" |

The console that was built:

- **Command bar** (0 tokens): `/allapot`, `/futtat <job>`, `/naplo`, `/oldal`,
  `/oldalak`, `/far`, `/email`, `/segit` — also without accents.
- **Conversation** (free chain): the `bot/lib/agent.mjs` mini-agent, persona:
  `bot/agent.md`. The model requests an action (`AKCIO: {...}`), the bot executes it, then the
  model answers (`VALASZ: ...`).
- **Approval**: the risky operation (`email_teszt`) presents a card on the console.
- **Proven** (live): the model requested the `allapot` action, it ran, and it gave a Hungarian
  answer (≈3300 in / 184 out tokens, on the free chain); the `/futtat konkurencia-figyelo`
  command started the job.

What this does **not** include (next round): e-mail input (IMAP), and saving the conversation
(the console's history currently lives in the browser session).


---

## 1. The current state (measured)

The window runs with 4 surfaces: **3 DSH workspaces + the robot** (the 4th panel loads the
`http://127.0.0.1:4180/` panel).

| Observation | Value |
|---|---|
| Panels | 4 (3 × DSH client + 1 × robot panel) |
| The robot panel's tabs | Status · Settings · Log |
| **Input on the robot panel** | **none** (no command bar, no chat) |
| Panel ratios | equal (25-25-25-25), so the robot is narrow |

**The problem is not that "there is chat in the robot panel"** — the chat is a separate
workspace panel. The real gap: **you cannot talk to the robot**, and the chat next to it is a
*general* session, not the robot's.

---

## 2. What kind of communication is needed (layers)

| Layer | What | Token | State |
|---|---|---|---|
| **0.** Buttons | running a job, panel operations | 0 | ✅ done |
| **1.** Command bar | `futtat <job>`, `oldal <url>`, `email teszt`, `far allapot`, `naplo 50` | **0** | ❌ missing |
| **2.** Conversation | free-text instruction → the robot executes/answers it | yes (free chain) | ❌ missing |
| **3.** Approval | pending operations on a card: accept/reject | 0 | ❌ missing |
| **4.** Asynchronous | instruction/answer by e-mail (IMAP) | 0 | ❌ missing |

The robot **never** decides on its own up to layer 4: risky steps (FAR submission, sending e-mail,
modifying files) wait for approval.

---

## 3. Two routes — and the proposal

### V1 — "The robot's own session" (ready immediately, no development)

The 4th surface **stays a DSH client**, but not with a general session — bound to the
**robot's**:

1. **Robot preset** (`robot`): persona + toolset + model policy (based on `bot/agent.md`; a cloud
   model is forbidden for FAR personal data).
2. **A `.bot` workspace** in the sidebar: the robot's sessions go there (`providers/session-channel.mjs`
   can already register a channel).
3. In the 4th panel you pick the `.bot` workspace and the `robot` preset **once** — the WebView2
   profile remembers it, and from then on that is what loads.

What it gives: a real conversation with the robot, with the **full DSH toolset** (jobs, files,
terminal), streaming, approval and a log — with no new UI. What it does not give: the robot's
"own" face (you see the DSH chat interface).

**Cost:** ~30 minutes (preset + persona + workspace registration).

### V2 — "Robot console" inside the panel (development)

The robot panel gets a **Conversation** tab and a **command bar**:

- **Command bar** (layer 1): deterministic commands, 0 tokens.
- **Conversation** (layer 2): the typed instruction goes into a **dedicated robot session**
  (`.bot` workspace, `robot` preset), and the answer lands there — not in a separate DSH panel.
- **Approval cards** (layer 3) and **e-mail** (layer 4).

Technique: the `dsh-hazi-robot` host plugin **runs inside the host**, so it can open a session
directly (`ctx.workspaceRegistry` + prompt submission — the same pattern `dsh-webhook` uses). New
routes:

```
POST /hazi-robot/command      deterministic command (0 token)
POST /hazi-robot/ask          instruction for the robot session
GET  /hazi-robot/chat?since=  the conversation history (poll)
GET  /hazi-robot/approvals    pending approvals
POST /hazi-robot/approve      decision
```

**Cost:** ~1 day (routes + panel UI + persona).

### My proposal: **V1 now, V2 afterwards**

V1 alone removes the complaint (the robot gets its own session instead of a general chat next to
it), and it is done **today**. V2 is worth it once the DSH chat interface gets in the way next to
the robot — until then V1 can do the same thing.

---

## 4. Layout (the current 25% is too narrow)

The tray's "Split window" menu currently sets a **workspace count** (1–3) + the robot. Proposal:
call it **combinations**:

| Menu item | Surfaces | For whom |
|---|---|---|
| **Robot only** | 1 (robot, full width) | you work with the robot |
| **1 workspace + robot** | 2 (50/50) | parallel work |
| **2 workspaces + robot** | 3 (33/33/33) | **this should be the default** |
| **3 workspaces + robot** | 4 (25% each) | the current one |

Also: the robot panel should get a **wider** default ratio (e.g. 40%), and saving panel ratios
already works (draggable separators).

---

## 5. Model and data policy (not a matter of negotiation)

| Task | Model |
|---|---|
| Command bar, buttons, status | **no model** |
| Conversation, summarisation, e-mail | free chain (`subagent-worker`) |
| Heavy decision, code | DeepSeek **off-peak** |
| **FAR / personal data** | **only deterministic code or local Ollama** — the cloud is FORBIDDEN |

The robot's session runs in the `.bot` workspace, so every instruction and answer stays in the DSH
logs (auditable), and `toolFilter`/approval apply to it exactly as to any other session.

---

## 6. Phases

| Phase | What it delivers | Cost |
|---|---|---|
| **A** | Layout: tray combinations + robot mode (robot only) + 40% robot ratio | ~30 min |
| **B** | V1: `robot` preset + `bot/agent.md` persona + `.bot` workspace in the sidebar | ~30 min |
| **C** | V2/1: command bar on the panel (deterministic, 0 tokens) | ~2 hours |
| **D** | V2/2: Conversation tab (dedicated robot session) + approval cards | ~1 day |
| **E** | Two-way e-mail (IMAP): instruction/answer by letter | ~half a day |

---

## 7. Questions asking for a decision

1. **V1 or V2?** (V1 = the robot's own DSH session in the 4th panel; V2 = its own robot console on
   the panel.)
2. **Default layout:** 2 workspaces + robot (proposed), or keep 3+1?
3. **Is a "Robot only" mode needed** on the tray (1 surface, full width)?
4. **The command bar's language:** Hungarian keywords (`futtat`, `oldal`, `allapot`) — is that fine?
5. **Voice:** does the robot need to speak (TTS), or is text enough?
