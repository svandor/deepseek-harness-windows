# Sandbox capability plan — a permanent fix for SSH, GitHub and browser use

> Hungarian original: [`SANDBOX-KAPACITAS-TERV.md`](SANDBOX-KAPACITAS-TERV.md)

**Status:** **Track 0, Track 1 and Track 2 are implemented** (2026-11-26/27, see
[“Executing track 0”](#executing-track-0--measured-2026-11-26), [“Track 1”](#track-1--eliminating-silent-denials--done-2026-11-27)
and [“Track 2”](#track-2--the-browser-as-a-host-side-tool--done-2026-11-26));
track 3 is still a plan. Every statement comes from a **measurement**
taken on this machine on 2026-11-26; the probe commands are in the
[appendix](#appendix-a--the-measurement-commands) so they can be re-run at any time.

**The complaint that triggered this:** agents keep reporting that the sandbox
"unjustifiably" blocks SSH, GitHub and the browser — while many built-in tools
exist. The measurements say the complaint is **justified but not the sandbox's
fault**: four separate causes are tangled together and only one of them is the
restriction's intent.

---

## What this is about — in plain words

**The sandbox is not an internet gate, it is a write guard.** It only prevents the
agent from writing files outside the workspace. It does not block the network and
does not block reads. Yet three things get stuck — and all three for different
reasons:

**1. The "name list" is incomplete (this is why HTTPS fails).**
Every program starts with a permission list that says what it may touch. One name
is missing from that list, and it is precisely the one **Windows' own encrypted
connection library** refers to when it requests a certificate for HTTPS. That is
why programs using Windows TLS (`curl`, `git` over https, PowerShell web requests)
cannot connect. Programs that bring **their own** TLS — Node.js and the GitHub CLI —
work flawlessly on the same machine. So the network is not broken; one program is
using the wrong "passport".

**2. Programs cannot open channels to each other (this is why SSH and the browser fail).**
Programs talk to each other through pipes internally. The restricted program cannot
open them. Three consequences, one single cause:
- PowerShell cannot collect a program's output → `git … | more` style commands fail
  ("Access to the path '\\.\pipe\…' is denied");
- the Unix-shell emulation shipped with Git (`sh.exe`) announces itself through such
  a channel, so **every git command that goes through a shell dies** — and that
  includes `core.sshCommand` and the `!gh auth git-credential` credential helper;
- Chrome/Edge open dozens of such channels at startup, so they **never start**.

**3. The harness does not recognize the error (this is why it feels "unjustified").**
The harness only knows **three English** error messages as "this is the sandbox".
The real errors look different — one of them appears **in Hungarian** ("A hozzáférés
megtagadva"). So the agent does not get the "this is the sandbox, do this instead"
signal; it sees a meaningless error and either gives up or starts working around it
by hand.

**4. There is no cheat sheet (which is why it returns in every new conversation).**
Nowhere is there one page saying *this operation works like this, use that*. The
agent's `pwsh` description only says what is **not** possible — not what the correct
path is. Every new conversation rediscovers it.

**The proposal in one sentence:** do not try to switch the restriction off (it
protects the machine), but **route every operation to where it works**, and tell the
agents that — after which approvals are rarely needed.

---

## 0. Executive summary

1. On Windows the sandbox restricts **writes only** (`WRITE_RESTRICTED` restricted
   token). Network and reads are **not** restricted — the package's own docs say so
   (`dsh-sandbox-windows-acl/README.md:114`). The blocked cases are therefore not a
   "network ban" but two side effects of the token.
2. **HTTPS**, **SSH** and the **browser** all **work today** inside the sandbox —
   with a different tool or with three configuration lines. None of them needs
   `danger-full-access`.
3. The three concrete errors agents see (`SEC_E_NO_CREDENTIALS`,
   `couldn't create signal pipe`, Edge `access denied`) **do not match the built-in
   denial fingerprints**, so the model never receives either the `[sandbox: …]`
   marker or the escalation guidance. That is why it reports "the sandbox blocks
   it" instead of choosing the working path.
4. The approval infrastructure is **already in place**: `state/approvals.json`
   holds a standing `sandbox-escalation|danger-full-access` rule for the `pwsh`
   tool with **5,317 hits** — hit number 5,317 is **this measurement's own**
   escalation (2026-11-26 03:18 UTC), logged as `log[].event = "auto-allowed"` and
   executed **immediately, without a prompt**. The bottleneck is not permission but
   **knowledge and detection**.
5. The permanent fix is not another patch but **four tracks together**:
   (0) configuration, (1) killing silent denials, (2) the browser as a host-side
   tool, (3) knowledge + measurement + upstream. Track 0 removes ~90% of the SSH
   and GitHub complaints today, with no code.

---

## 1. Measured state

Every row was measured on this machine, in the `workspace-write` sandbox, from the
DSH `pwsh` tool.

| # | Operation | Result | Note |
|---|---|---|---|
| 1 | `node -e "fetch('https://api.github.com/zen')"` | **OK, HTTP 200** | Node OpenSSL — no schannel |
| 2 | `web_fetch` (built-in host tool) | **OK, HTTP 200** | runs in the host process, outside the sandbox |
| 3 | `git --version` (output not captured) | **OK** | `git version 2.53.0.windows.2` |
| 4 | `git --version` (output captured: `$x=`, `\|`, `*>`) | **FAIL**: `Program 'git.exe' failed to run: Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied` | PowerShell opens a named pipe to capture a native child's output |
| 5 | `cmd /c "git --version > file 2>&1"` | **OK** | `cmd` hands over a real file handle: no pipe |
| 6 | `git ls-remote https://github.com/git/git.git` | **FAIL**: `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` | public repo |
| 7 | `git -c http.sslBackend=openssl ls-remote https://…` | **OK** (HEAD `acba8bf9…`) | same public repo |
| 8 | `git -c http.sslBackend=openssl ls-remote https://…/Raider.git` | **FAIL**: `sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5` | **private** repo → `!gh auth git-credential` helper → `sh` |
| 9 | `ssh.exe -T git@github.com` | **OK**: `Hi svandor! You've successfully authenticated` | `C:\Windows\System32\OpenSSH\ssh.exe` |
| 10 | `GIT_SSH=<native ssh> git ls-remote git@github.com:…` | **OK** (private `Rescue`, `LineageOS` refs) | `GIT_SSH` is exec'd **directly**, not through `sh` |
| 11 | `git -c core.sshCommand="ssh …"` / `GIT_SSH_COMMAND` | **FAIL**: `sh.exe … couldn't create signal pipe` | these go through the **shell** → MSYS fork |
| 12 | `Invoke-WebRequest`, `[System.Net.Http.HttpClient]` | **FAIL**: `The SSL connection could not be established` | .NET → schannel → SEC_E_NO_CREDENTIALS |
| 13 | `curl.exe https://github.com` | **FAIL**: `schannel: AcquireCredentialsHandle failed` | Windows curl is schannel-only (measured: `libcurl/8.18.0 Schannel`) |
| 14 | `msedge --headless=new --dump-dom https://example.com` | **FAIL**: `mojo\…\platform_channel.cc: Check failed: access denied (0x5)`, `crashpad OpenProcess: denied`, exit `0xC0000003` | Chromium IPC + crashpad need named pipes and process access |
| 15 | `node -e "execSync('git --version')"` | **FAIL**: `EPERM spawnSync C:\WINDOWS\system32\cmd.exe` | `stdio:'pipe'` inside the sandbox |
| 16 | `fetch('http://127.0.0.1:3080/')` | **OK, TCP+HTTP reached** (401 = token required) | loopback is **not** blocked |
| 17 | `sandbox_permissions: danger-full-access` + `curl https://github.com` | **OK, HTTP 200, instantly, without a prompt** | the standing approval rule auto-allows |
| 18 | `gh auth status` | **OK**, token in the keyring, `gho_…`, scopes: repo/workflow/… | `gh` uses its own Go TLS |

**Repository split** (`D:\Szerver\*`, from `.git/config`) — why HTTPS hurts:

| Protocol | Repositories |
|---|---|
| `https://github.com/…` | Deepseek Harness, Felpuffanto, LineageOS, Raider, Vector, Video (**6**) |
| `git@github.com:…` | Antikolt, Rescue, Zoom (**3**) |

Of the 6 HTTPS repositories **none can push** inside the sandbox today (row 8: the
credential helper needs `sh`) — and those are the main working repositories.

---

## 2. Root causes

### R1 — The restricting SID list omits `Authenticated Users` → schannel

The `workspace-write` token's restricting list is: *logon SID, Everyone, workspace
SID, temp SID* (`dsh-sandbox-windows-acl/README.md:94`). `Authenticated Users` is
**deliberately** absent (that is what closed the WMI namespace and the `C:\` root
tree-creation escape, same document). Windows performs the access check **twice**
and the restricting SID list must match as well — but SChannel credential
acquisition (lsass/CNG RPC) passes through objects granted to `Authenticated
Users`, so **every schannel-based TLS** fails: `curl.exe`, `Invoke-WebRequest`,
`.NET HttpClient`, `git` with the schannel backend. It is not a network ban: Node
OpenSSL and `gh` (Go) traverse the same machine fine.

### R2 — Named-pipe write cannot be granted → MSYS `sh`, Chromium, node `stdio:'pipe'`

The package states it (`README.md:171`): *"Piped stdio capture is impossible for
confined grandchildren"*. Four symptoms, one cause:

- **PowerShell native output capture** (`\|`, `$x=`, `*>`): `Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied` (row 4). This is the most frequent, because an agent **always** wants the output. (The project's own checker failed this way during the measurement: `node tools/check-docs-bilingual.mjs | Select-Object` → pipe denial; with `cmd /c "… > file"` it is green, 24/24.)
- **MSYS2 `sh.exe`/`bash.exe`** (Git for Windows): its fork emulation opens a signal pipe → `couldn't create signal pipe, Win32 error 5` (rows 8, 11). That is why `core.sshCommand`, `GIT_SSH_COMMAND` and any **shell-based credential helper** (`!gh auth git-credential`) fail.
- **Chromium/Edge**: mojo platform channel + crashpad (row 14) → the browser **never starts**.
- **Node `child_process` `stdio:'pipe'`** (row 15): `EPERM`.

### R3 — The four error families do not match the denial classifier → no marker, no guidance

The tool layer only emits the `[sandbox: file access denied under <mode> mode]`
marker and the escalation hint when stderr matches the backend's dialect
(`dsh-sandbox-local/lib/index.js:205–215`):

```
"windows-acl": ["access is denied", "access to the path", "permission denied"]
```

That is **three English phrases, case-insensitive**. Of the four measured families
**one** matches (the pipe one, "access to the path"); the other three do **not**:

| stderr | matches? |
|---|---|
| `Access to the path '\\.\pipe\…' is denied` | yes → marker + escalation hint |
| `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` | **no** |
| `couldn't create signal pipe, Win32 error 5` | **no** |
| Edge: `A hozzáférés megtagadva (0x5)` (localized rendering!) / `EPERM spawnSync` | **no** |

Consequence: the agent sees a meaningless error, diagnoses "the sandbox restricts
it", and either gives up or starts working around it by hand. **This is the bulk of
the complaints** — not the restriction, but the missing feedback.

### R4 — No documented capability matrix in one place

The `pwsh` tool description is **long** and accurate today (it even names the named
pipe limit, `dsh-tool-pwsh/lib/index.js:144`), but:
- it is **negative** (what cannot be done) and never says **what to use instead**;
- every new session rediscovers it (and it is lost after compaction unless it
  reaches the runtime context);
- subagents start from their own preset, so the `pwsh` description may not reach
  them;
- nowhere is it recorded that `GIT_SSH`/`openssl`/`cmd` redirection **work** —
  until today's measurements nobody had written that down.

---

## 3. The solution — four tracks

### Track 0 — Immediate configuration (no code, ~30 minutes) — **DONE**

Goal: SSH, GitHub and HTTP work **today**, without escalation.

In plain words the six steps mean this:

1. **0.1** — tell git to use its own crypto code instead of Windows'. That makes
   fetching/updating public repositories work, without permission.
2. **0.2** — tell git to launch the **real** Windows SSH program (and not through the
   Unix-shell emulation). That makes git push/pull over SSH work.
3. **0.3** — the same thing in "immediate" form, a one-line prefix, without a
   restart (while 0.2 only applies from the next harness start).
4. **0.4** — point the 6 HTTPS repositories at SSH. Not because HTTPS is bad, but
   because for **private** repositories git invokes a credential helper that needs a
   shell — which cannot start inside the sandbox. Over SSH no credential helper is
   needed at all.
5. **0.5** — for web requests the path is the built-in `web_fetch`/`node`, not `curl`
   or PowerShell's `Invoke-WebRequest` (those die on Windows TLS).
6. **0.6** — when a program's output must be captured, use `cmd /c "program … > file"`
   and then read the file. That way PowerShell does not try to capture it through a
   pipe.

| Step | Command / setting | Covers |
|---|---|---|
| 0.1 | `git config --global http.sslBackend openssl` | row 6→7: every **public** HTTPS read (`fetch`, `ls-remote`, `clone`) |
| 0.2 | User environment variable: `GIT_SSH=C:\Windows\System32\OpenSSH\ssh.exe`, `GIT_SSH_VARIANT=ssh` | row 11→10: the git SSH transport **does not** go through `sh` |
| 0.3 | Per-session idiom (immediate, no restart): `$env:GIT_SSH='C:\Windows\System32\OpenSSH\ssh.exe'; git push` | row 10 — **measured working** |
| 0.4 | Point the 6 HTTPS remotes at SSH: `git remote set-url origin git@github.com:svandor/<Repo>.git` | row 8 disappears (the credential helper's `sh` dependency) |
| 0.5 | HTTP for agents: `web_fetch` / `web_search` / `node -e fetch` — **not** `Invoke-WebRequest`, **not** `curl.exe` | rows 1, 2, 12, 13 |
| 0.6 | Capturing native output: `cmd /c "program … > file 2>&1"`, then read the file | row 4→5 |

> **Why `GIT_SSH` and not `core.sshCommand`?** Measured (row 11): git runs the
> value of `core.sshCommand` and `GIT_SSH_COMMAND` **through a shell** (MSYS `sh`),
> while `GIT_SSH` execs the program **directly**. For the same reason no
> credential helper starting with `!` should be used.

#### Executing track 0 — measured (2026-11-26)

All six steps were performed; the execution ran in **one approved escalated call**
(`~/.gitconfig` and `HKCU\Environment` live outside the sandbox).

| Step | Performed | Verification |
|---|---|---|
| 0.1 `http.sslBackend=openssl` | `git config --global http.sslBackend openssl` | read back as `openssl` from the sandbox; `git ls-remote --heads https://github.com/git/git.git` → **exit 0**, refs returned |
| 0.2 `GIT_SSH` user env | `GIT_SSH=C:\Windows\System32\OpenSSH\ssh.exe` and `GIT_SSH_VARIANT=ssh` | read back from `HKCU:\Environment` |
| 0.3 per-call idiom | `$env:GIT_SSH='…'` inside the call | the verification below ran **with it** |
| 0.4 the 6 remotes on SSH | Deepseek Harness, Felpuffanto, LineageOS, Raider, Vector, Video | `git remote get-url origin` is `git@github.com:…` for all six |
| 0.5 web path | `web_fetch` / `node -e fetch` | rows 1, 2, 12, 13 of the measurement |
| 0.6 output capture | `cmd /c "… > file"` | the verification itself used it |

**Real test inside the sandbox** (per-call `$env:GIT_SSH`, `cmd /c` redirection):

```
OK  Deepseek Harness  0d602bc0…  refs/heads/main
OK  Felpuffanto       bcf25fd8…  refs/heads/main
OK  LineageOS         62699707…  refs/heads/main
OK  Raider            b4328b99…  refs/heads/main
OK  Vector            31801bb4…  refs/heads/main
OK  Video             24cc60e7…  refs/heads/main
SSH reach: 6 OK, 0 failed

git push --dry-run origin HEAD  ->  exit=0, "Everything up-to-date"
```

The last line is the point: **`git push` works inside the sandbox without an
approval request.**

**Backup / rollback:** `C:\Users\info\.gitconfig.bak-20261126-045839`. Rollback:
per repository `git remote set-url origin https://github.com/svandor/<Repo>.git`,
delete the two env variables
(`[Environment]::SetEnvironmentVariable('GIT_SSH',$null,'User')`), restore the `.bak`.

**What this does NOT fix:** *private* HTTPS (the shell-based credential helper —
which is why the repositories moved to SSH), the `curl`/`Invoke-WebRequest` TLS path,
the browser, and PowerShell's output capture — those are tracks 1–2.

**Implementation:** the change was made by hand and verified (above). The idempotent
`tools/git-sandbox-config.mjs` (dry-run by default, `--apply`) remains an open item so
a machine rebuild can repeat it with one command.

### Track 1 — Eliminating silent denials — **DONE (2026-11-27)**

New plugin: **`plugins/dsh-sandbox-sentinel`** (agent plane, installed the proven
`dsh-rule-guard` way: junction + agent-preset entry).

In plain words: this is a **signpost**. When one of the known errors appears, the
plugin writes next to it: "this was the sandbox, for this reason, do this instead" —
and a short cheat sheet enters every conversation, so it does not have to be
rediscovered.

**Why it became urgent (measured, 2026-11-27, Vector `session-765b76d2`):** the agent
called `& pwsh -File tools\display-mode.ps1 -Status 2>&1 | Out-String` and
`& nvidia-smi … 2>&1 | Out-String`. The sandbox refused because of the named pipe:

```
Program 'pwsh.exe' failed to run: Access to the path '\\.\pipe\LOCAL\dotnet_e1d6…' is denied
```

In its own reasoning the agent translated this as **"Sandbox blocked launching
external programs?"** — a wrong diagnosis (it is not launching that is forbidden but
**capturing the output through a pipe**) — and then **closed the turn without an
answer**. The same two commands ran fine as `cmd /c "… > file"` (`nvidia-smi` exit 0,
full `display-mode.ps1 -Status` output) — the knowledge existed, it just never reached
the model. **This track closes exactly that gap.**

**Implementation (refined against the plan):**

1. **`tools/post-execute`**: seven error classes (`lib/classify.js`, a pure module) —
   `pipe-capture`, `msys-sh`, `schannel-tls`, `chromium-sandbox`, `node-spawn`,
   `sandbox-write`, `access-denied-hu` (the **Hungarian** "A hozzáférés megtagadva"
   too, which the built-in detection never sees). On a hit a concrete, copy-pasteable
   remedy is appended to the output — it does not block, the call stays successful.
2. **`agent/session-start`**: a short (≈1.1 KB) cheat sheet with the four basic
   patterns, marked "NOT a user message" (the lesson from `dsh-rule-guard`).
3. **Log**: `~\.dsh\sandbox-sentinel.log` (JSONL: time, class, tool, session) — this
   is how "did the complaints stop" becomes measurable.
4. **Safe**: every branch is `try/catch` and falls through to `next()` — the plugin
   never breaks a call and never stops the boot.

**Measured:** `node plugins\dsh-sandbox-sentinel\test\classify.test.mjs` → **13/13**
(with the measured strings, including the output of those two commands and the
Hungarian message; no false positives), `test\plugin.test.mjs` → **7/7** (the note
lands in the right place, ordinary output passes through unchanged, file tools are
not touched, the cheat sheet is injected). Installed: junction +
`- id: sandbox-sentinel` (backup: `agent.cordis.yml.bak-2026-11-27-103602`),
`install.ps1 -Check` → `HOOKS=agent/session-start,tools/post-execute
CLASS=pipe-capture NOTE=OK`. **Takes effect at the next session creation** (the
running harness was not restarted, §1.5).


### Track 2 — The browser as a host-side tool — **DONE (2026-11-26)**

Chromium **cannot** start inside the sandbox (structural: R2/d) and it is not
desirable to force it (see §4). So the browser runs in the **host process**, as a
tool — exactly what `dsh-terminal-tool`, `dsh-devadmin` and `dsh-ftp-deploy`
already do.

In plain words: the browser cannot start inside the restricted environment (and it
is a good thing it cannot — that protects the machine). So we start it in the
harness's **own**, unrestricted process and expose it to the agent as a tool: "open
this page", "read the text", "take a screenshot", "click here".

**Implementation — `plugins\dsh-browser`** (full description in the plugin's
`README.md`). It came out **simpler than planned**: no host-side HTTP route and no
file postbox is needed, because an agent-plane tool plugin already runs in the
**host process** (only *sandboxed commands* are confined) — so the engine is called
directly:

- **engine:** raw **CDP** on headless Edge, **no new dependency** (the proven
  pattern: `.test-dsh-home\probe-hero.mjs`); `lib\{edge,cdp,scope,profiles}.js` +
  `lib\index.js` (the tool);
- **operations:** `open`, `read`, `click`, `type`, `eval`, `shot`, `download`,
  `console`, `profiles`, `close`, `status`;
- **target scope:** all three levels are available (`loopback` / `lan` / `any`,
  default `any`); **clicking and typing work on external sites too** (the user's
  decision);
- **profiles:** disposable by default, but a **persistent** profile can be created
  (`profile: "lineageos"` → `state\browser-profiles\lineageos`) so logins survive;
  deletion goes to the **trash**, never `rm`;
- **download:** **gated by approval** (`ctx.approval`, one-shot) — without approval
  no download starts at all;
- **limits:** `--headless=new` only (AGENTS.md §1), its own `--user-data-dir` (never
  the user's profile), one browser at a time, automatic close after `idleMs`
  (3 minutes), termination **by its own PID only** (`taskkill /T /F`), and every
  navigation and download goes to `state\browser.log`.

**Measured (2026-11-26):** `node plugins\dsh-browser\test\*.test.mjs` → **33/33**
(11 scope + 8 profile + 6 CDP + 8 gate), and the real engine:
`node tools\browser-doctor.mjs --allow-download` → **7/7 ok**:

```
OK browser-exe        msedge.exe
OK scope-policy       5/5 cases correct
OK loopback-ui        title="DeepSeek Harness" ready=true shot=44079 B
OK external-read      title="Example Domain" body=917 characters
OK external-click     https://example.com/ → https://www.iana.org/help/example-domains
OK persistent-profile cookie survived the restart: yes
OK download           doctor.txt (19 B)
```

The `loopback-ui` screenshot is the **real running UI** (workspace list, hero and
model selector are visible). The measurement found and fixed two bugs:
(a) after `Page.navigate` the `readyState` was still the **previous** document's, so
the read landed on a half-loaded page — it now waits for `Page.loadEventFired`;
(b) `taskkill /F /T` did not let the profile be written, so a cookie placed in the
**persistent** profile was lost — it now sends `Browser.close` first and only then
force-kills the tree.

**Installed:** junction + `- id: tool-browser` in
`~\.dsh\.agent-presets\standard-free\agent.cordis.yml` (backup
`.bak-20261126-051734`), `install.ps1 -Check` → `TOOL=browser`. The tool appears at
the **next session creation** (the running harness was not restarted, §1.5).

With it, `tools/browser-probe.mjs`, `tools/probe-terminal.mjs`,
`tools/probe-hero.mjs` and any future visual check run **without escalation**, and
the "browser" complaint disappears.

### Track 3 — Knowledge, measurement, upstream (~1–2 hours)

In plain words: (1) **one command** that tells you with 18 probes whether everything
works — after an upgrade too, so a silent regression does not look like "a stricter
sandbox"; (2) **one page plus an automatic reminder** for the agents; (3) **guard
rules** so the new powers are no wider than necessary; (4) **a report to the DSH
developers** that these limits will hit many users — so the next version does not
need a detour at all.

1. **`tools/sandbox-doctor.mjs`** — today's 18-row matrix automated: every probe
   reports `ok` / `denied` / `broken` plus the triggering cause, with `--json` and
   an exit code. **Why mandatory:** a DSH upgrade (a) overwrites the `node_modules`
   patches (`tools/patch-sandbox-no-window.ps1` header), (b) re-seeds
   `settings.yaml`, (c) may bring new sandbox strictness — today a silent regression
   looks exactly like "a stricter sandbox". The doctor answers it in one command.
2. **`AGENTS.md`, new section 5, "Sandbox capabilities and tool routing"** — the
   matrix + the six idioms + an explicit sentence: *"'the sandbox blocks it' is
   never an acceptable report on its own; the correct path is the tool from the
   matrix, and if there is none, one escalation"*.
3. **`dsh-rule-guard` new rules** (in `policy.json`, hot-reload): `GIT_SSH`/git may
   only point at the native OpenSSH; `dsh-browser` only on the approved hostlist;
   `danger-full-access` escalation only for the Track 0 operations (the existing
   `delete-needs-trash` stays).
4. **Upstream request** in `docs/DSH-UPSTREAM-ISSUE.md` (which already has 5+2
   points): (a) `denialSignatures` should be extensible and include localized error
   text; (b) `windows-acl` should get an **opt-in** fixed "pipe+network" rung without
   `Authenticated Users` (preserving the write boundary); (c)
   `SandboxExecutionPolicy` should support extra writable roots (today: "One primary
   workspace root per session"); (d) the `dsh-user-approval` seam should support a
   durable grant (today only `allowed-once`), because the durable rule today comes
   from `dsh-ui-extras`'s own store, which is not the core contract.

---

## 4. What I do NOT recommend (and why)

| Idea | Why not |
|---|---|
| Add `Authenticated Users` to the restricting SIDs | it would patch `node_modules` (lost on upgrade) and **reopen** the write escapes (WMI, `C:\` root) the upstream deliberately closed |
| Make the session default `danger-full-access` | it loses the file boundary in every workspace; Track 0 fixes SSH without it |
| `Start-Process -WindowStyle Hidden` / `wscript` detours for network | against the spirit of AGENTS.md §1 (no focus theft, no hidden chain), and it solves nothing: the child runs in the same token |
| Patch `DENIAL_SIGNATURES` in `node_modules` | lost on a DSH upgrade; the plugin (Track 1) achieves the same durably |
| Delete the standing `danger-full-access` rule from `approvals.json` | it is the **working** path today; tracks 0–2 must land first, only then can it be narrowed (D4) |

---

## 5. Decisions

| # | Question | State |
|---|---|---|
| **D1** | Should the 6 HTTPS remotes switch to SSH? | **✔ done** 2026-11-26 (6/6, verified) |
| **D2** | May `GIT_SSH` be set as a user environment variable? | **✔ done** 2026-11-26 (full effect from the next harness start; until then the per-call idiom) |
| **D3** | The browser tool's target scope and operation scope | **✔ decided** 2026-11-26: **all three levels**, external clicking too, disposable **and** persistent profiles, downloads gated by approval (see Track 2) |
| **D4** | The fate of the standing approval rules | **✔ decided** 2026-11-26: **(a)** — all three rules stay, unchanged |

### D3 refined — what "target scope" means

Four different things are involved, and only the first two are decisions:

1. **Network scope** — three realistic steps:
   - **A1 — own UI only:** `127.0.0.1`, `localhost`, `[::1]`. The tool only serves checking the DSH panels (screenshot, DOM, click).
   - **A2 — A1 + local machines:** the above plus the development/test servers running on the LAN (e.g. `192.168.1.8`, `192.168.1.252` — the Video/L12/Raider test hosts). **This covers today's needs** (`probe-terminal`, the hero probe, and the project pages).
   - **A3 — any URL:** the public internet too. Then the browser is effectively an *unsandboxed* browser with the host's privileges: it can reach internal services, download files, and the network filtering (the sandbox) does not apply to it.
2. **Operation scope** — two steps:
   - **read:** `navigate`, `dom`, `text`, `shot`, `console`, `wait` — open and read a page;
   - **interactive:** `click`, `type`, `upload`, `eval` — click, type, upload, run code in the page context.
3. **Profile** — *not a decision, fixed:* always a fresh, disposable temp profile. The user's logged-in Edge profile must **never** be used (with it the tool would reach every session and bank login of the user).
4. **Exposure** — *not a decision, fixed:* downloads denied by default; screenshots may only be written under the workspace; the tool runs in the host process, so the file sandbox does not apply to it → that is why the `dsh-rule-guard` rule is required.

**The user's decision (2026-11-26):** "obviously all three levels must be reachable
with the browser … clicking on external sites is also needed sometimes (yesterday
that is exactly what was missing in the LineageOS repo) … OK on the disposable
profile, but be able to create a persistent one too for certain tasks (so I do not
have to log in on every attempt) … you may tie the download to an approval request."

Hence the implementation: **`any` is the default scope** (all three levels are
selectable at any time), **clicking/typing on external sites**, an optional named
**persistent profile**, and **downloads that always require approval**. The initial
"A2 + loopback-only interactive" recommendation is therefore **superseded**.

### D4 refined — what the standing approval rules do today

**Fact (measured):** there are **three** standing rules in `state/approvals.json`
today, all for `danger-full-access` (full access), all with **no expiry**:

| Tool | Hits | Created | Note in the rule |
|---|---|---|---|
| `pwsh` | **5,317** | 2026-09-27 | "headless Edge + DevTools protocol (the sandbox blocks Edge's IPC channels)" |
| `edit` | 61 | 2026-10-18 | music state note in the Video project |
| `write` | 17 | 2026-10-18 | artist-name normalizer in the Video project |

**What they mean precisely — and what they do not:**

- They do **not** grant full access to every call. They only take effect when the
  agent **explicitly asks for escalation** in the call (`sandbox_permissions:
  danger-full-access` + justification). Normal calls still run sandboxed.
- When they do fire, there is **no human check**: only the `dsh-rule-guard` rules
  (trash instead of delete, no kill-by-name) and the log (`approvals.json` `log[]`,
  `event: "auto-allowed"`).
- The `edit`/`write` rules are **not bound to any path** → they apply to any file.
  That is the widest of the three, and the easiest to narrow.

**Four realistic options:**

| Option | What it means | Cost |
|---|---|---|
| **(a) Keep all three** (today) | zero friction, the log provides the audit | 0 |
| **(b) Bind to a path** on the `edit`/`write` rules (`pathScope` + `pathKind`, e.g. `C:\Szerver\Video`) | the rule only allows inside the given folder — the file format and the matcher already support it, and the panel's "Folder:" scope sets it | ~10 min per file; verify with `node tools/check-approvals.mjs` |
| **(c) Command-prefix whitelist** for `pwsh` (only `git push`, `ssh`, `node tools\`, `msedge` …) | narrower, but the matcher must be developed, and it is brittle (paths, quoting, wrapper scripts) | ~1 day of development |
| **(d) Delete the rules + click per call** | the safest: a human decides every unusual situation | 0, but many clicks per day until tracks 1–2 land |

**The user's decision (2026-11-26): (a)** — all three rules stay, unchanged.
Escalation therefore keeps happening without a prompt today, and
`state\approvals.json` `log[]` provides the audit. Option (b) does not apply, and
`state\approvals.json` is untouched. Once tracks 1–3 are in place and the escalation
count drops to ~0 per week, this decision can be revisited — this document marks the
point where that would happen.

---

## 6. Acceptance criteria

The plan is **done** only when each of these is measurably true:

1. `node tools/sandbox-doctor.mjs` → **every row `ok`** (for the schannel/Edge/node
   pipe rows the doctor reports the correct **alternative**, not a failure).
2. **In a fresh session**, with zero approval requests: `git push` to an SSH remote,
   `git fetch` on an HTTPS remote, `web_fetch https://api.github.com/zen`, and a
   `browser shot` of our own UI.
   *Partially measured (2026-11-26): `git push --dry-run` over SSH inside the sandbox
   **yes**, `git ls-remote` over HTTPS (with the openssl backend) **yes**, `web_fetch`
   **yes**; the `browser shot` follows track 2.*
3. Over 7 days, `state/sandbox-sentinel.log` contains **0 unclassified** sandbox
   errors.
4. No new visible windows and no automatic harness restart (AGENTS.md §1, §1.5).
5. `node tools/check-plugin.mjs`, `node tools/check-docs-bilingual.mjs`,
   `node tools/check-rule-guard.mjs` are green; the Track 1–2 tests are green.

---

## 7. Files and estimate

| Track | Files | Estimate |
|---|---|---|
| 0 | new `tools/git-sandbox-config.mjs`; `~/.gitconfig` (2 keys), user env `GIT_SSH`, 6× `git remote set-url` | 30 min |
| 1 | new `plugins/dsh-sandbox-sentinel/` (`package.json`, `lib/index.js`, `lib/fingerprints.js`, `test/fingerprints.test.mjs`, `install.ps1`, `README.md`) | 2–3 h |
| 2 | new `plugins/dsh-browser/` (host route + agent tool + CDP engine), new `tools/browser-doctor.mjs` | ~half a day |
| 3 | new `tools/sandbox-doctor.mjs`; `AGENTS.md` section 5; `plugins/dsh-rule-guard/policy.json`; `docs/DSH-UPSTREAM-ISSUE.md`; this document + its Hungarian original | 1–2 h |

**Order:** 0 → 3/doctor → 1 → 2. Track 0 alone removes the SSH and GitHub
complaints; Track 1 removes the possibility that **anything** gets stuck silently;
Track 2 gives the browser back.

---

## 8. Risks and rollback

- **`http.sslBackend=openssl`** affects the **user's** own git too (not just the
  sandbox). Measured: public HTTPS works with it; risk: with a custom
  `http.sslCAInfo` the trust chain differs. Rollback:
  `git config --global --unset http.sslBackend`.
- **The `GIT_SSH` user env var** affects every git call (the user's too). Rollback:
  delete the variable. `core.sshCommand` must **not** stay set next to it, because
  it takes precedence and lands in `sh` again.
- **Remote switch (D1)** is reversible; the old URL is recorded in this document.
- **The sentinel** only **appends** to a tool result; it neither swallows nor
  rewrites the real error. If the plugin throws, it does **not** mark (fail-open on
  marking, it never blocks boot) and writes to its log.
- **`dsh-browser`** runs in the host process: that is more privilege, hence
  (a) headless only, (b) loopback-first (D3), (c) job-based termination,
  (d) guarded by a `dsh-rule-guard` rule.
- **Taking effect:** Track 0 immediately (per-call env) / from the next harness
  start (user env); the Track 1–2 host plugins at the **next harness start**
  (§1.5 — we do not restart the running harness).

---

## Appendix A — the measurement commands

```powershell
# 1) HTTPS: node (OpenSSL) vs schannel
node -e "fetch('https://api.github.com/zen',{signal:AbortSignal.timeout(12000)}).then(r=>r.text()).then(t=>console.log('OK',t)).catch(e=>console.log('ERR',e.message))"
Invoke-WebRequest -Uri 'https://api.github.com/zen' -UseBasicParsing -TimeoutSec 12   # -> SSL could not be established
cmd /c "curl.exe -sS -m 10 -o NUL -w \"http=%{http_code}\" https://github.com > %TEMP%\curl.txt 2>&1"

# 2) git: schannel vs openssl, ssh vs shell
cmd /c "git ls-remote https://github.com/git/git.git HEAD > %TEMP%\g1.txt 2>&1"                                # SEC_E_NO_CREDENTIALS
cmd /c "git -c http.sslBackend=openssl ls-remote https://github.com/git/git.git HEAD > %TEMP%\g2.txt 2>&1"     # OK
cmd /c "set GIT_SSH=C:\Windows\System32\OpenSSH\ssh.exe&& git ls-remote git@github.com:svandor/Rescue.git > %TEMP%\g3.txt 2>&1"  # OK
cmd /c "git -c core.sshCommand=\"ssh -o BatchMode=yes\" ls-remote git@github.com:git/git.git HEAD > %TEMP%\g4.txt 2>&1"          # sh signal pipe

# 3) output capture: pipe vs cmd redirection
$bad = git --version                 # Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied
cmd /c "git --version > %TEMP%\g5.txt 2>&1"; Get-Content %TEMP%\g5.txt   # OK

# 4) browser and node child
cmd /c "\"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe\" --headless=new --dump-dom https://example.com > %TEMP%\edge.txt 2>&1"
node -e "const{execSync}=require('child_process');try{execSync('git --version')}catch(e){console.log('ERR',e.code)}"

# 5) escalation (with the standing approval rule — no prompt)
#    through the pwsh tool's `sandbox_permissions: danger-full-access` + `justification`:
curl.exe -sS -o NUL -w "http=%{http_code}" --max-time 12 https://github.com

# 6) connectivity and toolchain
node -e "fetch('http://127.0.0.1:3080/').then(r=>console.log('loopback',r.status))"
cmd /c "gh auth status > %TEMP%\gh.txt 2>&1"; Get-Content %TEMP%\gh.txt
```
