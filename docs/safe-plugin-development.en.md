# Safe plugin development (DSH UI extensions)

> Hungarian version: [`safe-plugin-development.md`](safe-plugin-development.md).

This note records **how we develop so that the live DSH interface cannot be paralysed**. Twice our
own plugin entry took down the boot ("Failed to load plugins"), and the recovery required deleting
the npx cache — that side effect has to be prevented.

## What happened (the lesson of the two failures)

| Error message | Cause | Fix |
|---|---|---|
| `dsh-ui-extras: pending (waiting for services: @deepseek-ai/...)` | I put **package names** in the client plugin's `inject` list | client services must be requested by their **short service name**, e.g. `["slots"]` |
| `cannot get property "slots" without inject` | `inject` was empty, yet `apply` used `ctx.slots` | the same: add the `"slots"` service |

The working pattern (`dsh-client-ui-goal`):

```js
const inject = ["slots", "sessions", "remote", "locale", "uiConversation"];
```

## The safe workflow

### 1. An isolated test environment (without touching the live profile)

```
.test-dsh-home\
  profiles\
    node_modules   -> junction to the live profile's node_modules
    web\
      package.json          (a copy of the live profile's package.json)
      pnpm-workspace.yaml
      cordis.yml
      cordis.patch.yml      <- only with our plugin's entry
```

The embossed plugin package goes into the **shared** `profiles\node_modules` through a junction, so
the isolated and the live profile see the same code. The test harness runs **on a separate port**
(e.g. 3081):

```powershell
.\tools\test-harness.ps1        # start the isolated harness + boot check
```

The script prints whether the boot is fine and whether the plugin is in the `window.__DSH_BOOT__`
graph. **Only put it into the live profile once this is green.**

### 2. Configuration check before starting

```powershell
$env:DSH_HOME = "C:\Szerver\Deepseek Harness\.test-dsh-home"
node "<dsh>\lib\bin.js" web --dump-config | Select-String ui-extras
```

This builds the plugin tree **without starting**: a bad entry shows up here.

### 3. Going live — always with a recovery plan

Before writing into the live profile:

```powershell
# backup
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" `
          "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.bak" -Force
```

If the interface breaks, **this is what to run** (nothing has to be reinstalled):

```powershell
.\tools\recover-harness.ps1
```

The script:
1. empties the profile's `cordis.patch.yml` (our entries are removed),
2. stops the process listening on the port,
3. starts a fresh harness from the **existing** dsh installation,
4. prints the new tokenised URL to open in the browser.

This **never touches the npx cache**, and it does not affect the built-in features.

## Current state

- `dsh-ui-extras` package: `plugins\dsh-ui-extras\` (host half: `lib\index.js`, client half:
  `lib\client.js`)
- Checker scripts (all without saving anything, and fast):
  - `node tools\check-plugin.mjs` — syntax, language-pack keys, missing functions, and loading the
    bundle into a "fake" module host: it checks the locale readers against the real `getLocale()`
    snapshot shape (`{active, locales, revision}`) — this class of bug (reading the snapshot as a
    plain string) is invisible statically, and exactly this produced the wrong language button
  - `node tools\check-approvals.mjs` — the type derivation and matching of remembered approvals and
    the host-side answerer (it saves/restores the real rule file)
  - `node tools\check-usage.mjs` — the cost engine: the peak/off-peak windows (weekdays 01:00–04:00
    and 06:00–10:00 UTC, **without weekends and Chinese holidays**), the official price table
    (Flash/Pro, off-peak = half price), the 30-day aggregate running on **real** session logs
    (without reading the zstd logs frame by frame the result would silently be zero), and the
    **free/paid split** of delegated work (the sum of the pockets, the cost of the zero-priced
    chain, the per-model tags)
  - `node tools\check-workspace-session.mjs` — the session channel's host route with a fake
    workspace registry: archiving (even on a partial failure), unarchiving (order untouched),
    channel registration, missing registry / path / action. This is the only code that writes into
    the **running** host's registry, so its bugs are not cosmetic
  - `node tools\probe-terminal.mjs [port] [project-path]` — on the **running** harness, with
    headless Edge + the DevTools protocol: it picks the session running in the given project, opens
    the right-hand "Terminals" tab, and checks from the panel's own DOM that (a) the printed working
    directory is the session's `cwd` and not the harness's own directory, (b) the project's saved
    quick commands (and the npm scripts in `package.json`) are visible, (c) an interactive terminal
    started by itself, (d) the output is at the **end** and stays there, (e) the card shows the
    working directory above the output, in the directory's line **without status text and serial
    number** (the serial number is in the header, and the send button is an icon + tooltip),
    (f) the font is monospace, (g) the input field shows what is typed by default and masks
    itself only at a password prompt in the output's last line (`type=password`, 🙈), revealing
    it on one click, (h) the terminal window gets a dark paper, and finally (i) Ctrl+C interrupts
    the running command — for this it starts **its own** terminal and identifies it with a marker,
    so it never stops a process it did not start. Before the fix exactly these three failed: the
    panel ran `npm run dev` in the harness's directory, because it took the working directory from
    the host's `process.cwd()` instead of the selected session's `cwd`.
  - `node tools\check-terminal-echo.mjs` — the **static** guard for point (g) above: it reads
    `SECRET_PROMPT_SHAPE` out of the client bundle and checks it against real password prompts
    (`Password:`, `Jelszó:`, `Enter passphrase for key …:`) and against log lines
    (`npm WARN … token expired`, `token: abc123`, `Password?`), so it can neither hide ordinary
    typing nor let a password through.
- The isolated test is **green**: the boot loads, the plugin appears in the boot graph
  (`dsh-ui-extras/client.js` in the `/plugins/??...&rev=...` list)
- Browser probes (the host cannot see the browser; without these the client bugs are invisible).
  The sandbox blocks Edge's IPC channels, so these run with wider permissions:
  - `.test-dsh-home\probe-edge.ps1` — headless Edge + `--dump-dom` on the isolated harness (boot,
    console, language pack)
  - `.test-dsh-home\probe-hero.mjs` — Edge through the DevTools protocol: loads the page, clicks the
    "New conversation" button, and inspects the blank (hero) phase's DOM; with `--add-workspace
    <path>` it adds a workspace to the running page, and measures every second whether the main
    thread responds (so a silent freeze is also detectable)
- Debug handle in the page: with `?dsh-ui-extras-debug=1` **or**
  `localStorage['dsh-ui-extras.debug']='1'` + reload, `window.__dshUiExtrasDebug` appears (the
  client `ctx`, `createWorkspace`, `phase`, `counters`). The shell cleans the URL during boot, so
  the query parameter does not always reach the bundle — that is why the localStorage gate exists.
- Every displayed time is **Hungarian local time** (Europe/Budapest): both the "switches in …"
  countdown and the peak window. The window is pinned to UTC, so the local hours shift at the
  summer/winter change — that is why the displayed text is computed
  (`peakWindowsLocalText`) instead of being hard-coded.
- The watchdog times precisely every 5 seconds: if the main thread blocks for longer, a
  `main thread stalled` line goes into `state\ui-extras-client.log` (without it a silent freeze
  leaves no trace at all).
- Deployment into the live profile **has happened** (the `cordis.patch.yml` contains the `ui-extras`
  entry); a new version of the host half only loads with a server restart.
- **The commit message's language is per workspace** (2026-10-05, fixed): the Git panel's HU/EN
  switch sets neither the interface language nor the whole Harness's setting, but the
  **workspace's**: the choice goes into the panel layout (`state\panel-layout.json`, key
  `commitLang`, `/ui-extras/layout`), so within the same interface one open project can get English
  and the other Hungarian commit messages. Previously a single `localStorage` key
  (`dsh-ui-extras.gitCommitLang`) held it — that was the same for every workspace, and on top of
  that every window generation gets a fresh WebView2 profile, so the choice was lost. Without a
  stored value the language follows the active interface language (`auto`).
- **Delegation in the statistics** (2026-09-30): the `/ui-extras/usage` response's `delegated` block
  splits into two pockets (`free` = the zero-priced chain, `paid` = a paid route even when
  delegated), plus `freeSavingsUsd`, a `models` breakdown and `lastAt`. The client shows these in
  separate lines, and falls back to the old combined line if the host half is still the old one.
  Check: `node tools\check-usage.mjs`.
- **Session channel** (2026-09-30): `GET/POST /ui-extras/workspace-session` on the host half
  (`archive` / `unarchive` / `workspace`). This is how machine runs' sessions can be hidden from the
  sidebar and a separate workspace registered for the `.automation` directory — editing
  `storages\workspace.json` by hand has no effect, because DSH reads it only at startup. The
  client-side pair: `providers\session-channel.mjs`, `providers\run-headless-task.ps1`.
  **ATTENTION:** the route requests the `workspaceRegistry` service lazily (`ctx.get`), so the
  plugin does not die in a profile where that service is missing.
- **The terminal panel's working directory** (2026-09-28, fixed): the panel takes the working
  directory from the **selected session's `cwd`** (`ctx.sessions.list.getSnapshot().current` →
  `byId[id].cwd`), because the right-hand tab's body mounts without a session, and the injected prop
  is `null` at the moment of registration — the host's `/ui-extras/workspace` response is only the
  last fallback, and it cannot be used until the session list has answered (otherwise it would list
  the wrong project's commands). The selection is re-read every 150 ms (then every 1 s), so the
  panel follows a conversation switch.
  - Quick command persistence is **keyed by workspace** (`state\runnables.json`), so a wrong working
    directory causes not only a run failure (`ENOENT … package.json`) but also "the saved commands
    disappeared": the save went under the wrong project's key.
  - The panel automatically starts **one** interactive shell if the project has no running terminal
    yet (it asks the host separately, so two panels do not start two); the `docked` tab and
    visibility are also conditions.
- **The terminal card's usability** (2026-09-28, fixed). These behaviours were established by
  measurement, so they must not be taken back:
  - The output **always shows the end**: the `useEffect` bound to the `terminals` map sets the
    post-DOM scroll (`scrollTop = scrollHeight`), and the header's `⤓` **follow icon**, plus
    scrolling upwards, toggles following.
  - The **working directory** is between the header and the output, in its own line (full path in
    the tooltip) — the output must not cover it. That line has **no** status and serial number: the
    status is the header's **coloured dot** (yellow = running, green/red = exited), the **serial
    number is in the header** next to the command, and every button is an **icon + tooltip** (no
    "Send" label).
  - The output and the command line are **monospace**, 12 px by default, and adjustable with the
    header's selectors (see below).
  - The **input field** is comfortable (5 px vertical inner margin + 18 px line height) — the "flat"
    field was a padding bug, not a style.
  - The **terminal window's height is draggable with the mouse**: the thin strip below the output
    (`data-dsh-ui-extras="cmd-resize"`) sets the output's height by pointer-drag (80 px … 90% of the
    viewport), and the size **survives** in the workspace layout (`height:<runId>`); a double click
    restores the default size. The double click must be watched on **pointer events**, not with
    React's `onDoubleClick`: the `pointerdown` `preventDefault()` swallows the compatibility mouse
    events, so the browser does not synthesise a `dblclick` (measured: this is why the size did not
    restore).
  - The active terminal's marking is **restrained** (a faint white border), not bright blue.
  - **ANSI handling**: the panel does NOT colour (it is not a tty), so it **strips** the escape
    sequences (`stripAnsi`), and treats `\r` as a **line overwrite** (`ingestTerminalText`:
    finished lines + a pending tail). Measured: Vite's coloured line used to appear as `[32m`-like
    boxes, and progress lines repeated. The root was handled too: `server.colors: false` in the
    Laravel project's `vite.config.js`, so that no colour code gets into the log in the first place
    (Vite has to be restarted for it).
  - The **serial number** in the header shows the FULL length (including the pending line), and if
    the buffer is longer than the 400 rendered lines, a "⋯ earlier lines hidden: N lines" marker
    stands at the start of the output — silent truncation creates the illusion that "the command
    stopped".
  - **Font-family and font-size selector** in the card's header (`Aa` and `A±`, both **icon +
    tooltip**, the tooltip showing the current value). The choice lives in `localStorage`
    (`dsh-ui-extras.terminalFont`), because the font is about the user, not the project, and it
    applies to the output AND the command line.
  - The input field **handles key combinations**: `Ctrl+C` interrupts, `Esc` clears the line
    (`0x1b`), `Ctrl+D` is end-of-input (`0x04`); when there is a text selection, `Ctrl+C` remains
    the browser's "copy".
  - **Stopping = the whole process tree.** Measured: `child.kill()` only takes the shell down, while
    `npm run dev` and Vite keep running and holding the port; `0x03` written to the input does **not**
    interrupt the native child. That is why the host runs `taskkill /F /T`, after measuring the
    descendants first (`descendantPids`), and after the tree walk it also kills any surviving
    orphans by PID. `tools/check-plugin.mjs` checks this with a real native grandchild ("the stop
    ends the native grandchild too").
  - **Known limit**: an orphan that ALREADY exists (started before the fix, e.g. `npm run dev`
    surviving the shell's death) cannot be stopped from the panel, because the host cannot see the
    parentless process. In that case the terminal has to be restarted (the panel with the fixed host
    already takes the tree).
  - **Workspace isolation**: the host's `action=runs` returns ALL runs, so the client **filters** by
    `run.workspace` (`refreshRuns` does not even put a foreign one in, and the cleanup throws it
    out). Without this, another project's dev server appeared here as if it were running in this
    directory.
  - **Default height**: the output is `170px` … `22vh` (docked) by default, not `46vh` — two
    terminals fit below each other; dragging and `⤢` enlarge it.
  - **The input field behaves like a terminal's: what you type is VISIBLE**
    (`type=text`), and it masks only while the output asks for a password. The
    earlier build had this exactly backwards — it hid every keystroke and then
    showed a password as soon as echoing was switched on — and that is the bug that
    was reported. The decision rides on the output's **last** line
    (`SECRET_PROMPT_SHAPE`): the secret word sits near the end of the line and the
    line ends where the answer goes (`:` or `>`). So `Password:`, `Jelszó:`,
    `Enter passphrase for key …:` and `Password for 'https://…':` mask, while
    `npm WARN … token expired` does not — an old "token" mention must not hide every
    later command. The 🙈/👁 button overrides exactly the prompt on screen (reveal
    it, or hide it by hand), and sending the answer restores the terminal's own
    rule: the choice is deliberately NOT remembered (not even in `localStorage`),
    because a stored "reveal" is precisely how a password ends up on screen days
    later.
  - **The terminal window gets its own paper, per scheme** (`TERM_PALETTES`): in dark mode a
    step deeper than the panel (`#101216` output, `#14171b` card, `#1b1f26` header/directory
    line/input row), in light mode a light sheet with dark text (`#f3f5f7` / `#eef1f4` /
    `#e5e9ee`, text `#1f2328`). The scheme is read from the DOM (`html.style.colorScheme` and
    the `body[data-ds-dark-theme]` attribute the theme presenter writes), watched by a
    `MutationObserver` — so a theme switch repaints **without a reload**, and light mode never
    gets a black hole in the panel.
- **Approval scopes: session, directory, file** (2026-10-18). The yellow card previously had only
  two "remember" options: `Always: <tool>` and `Always: every tool` — that is, for `write`/`edit`
  only the "every edit is automatic" level existed, not "only for this conversation" and "only in
  this directory". Now the card offers, in a left-to-right narrowing order:
  `For the session` → `Directory: <name>` → `File: <name>` → `Always: <tool>` →
  `Always: every tool` → `Allow once`.
  - The **session scope is deliberately not persistent**: it lives in the host's memory
    (`sessionApprovalRules`, under the session id), is not written into `state/approvals.json`, and
    is lost when the host restarts (or the conversation ends). It appears on the 🛡 panel with an
    `⏳` mark, and can be revoked in the usual way. That is why an "accidentally permanent"
    permission is impossible.
  - The **directory/file scope** is persistent: the rule gets a `pathScope` + `pathKind`
    (`dir`/`file`) field. When matching, the host reads the path **from the call's own argument**
    (`approvalPathOf`: in the session log, the `tool/call` event's `arguments` field, under
    `file_path` / `path` / … keys), because the approval request has NO path field (only `toolName`,
    `callId`, `reason` — and the reason is free text). On Windows the comparison is case-insensitive,
    and the `C:\Temp\proj` scope does **not** cover `C:\Temp\project2` (a separator boundary, not a
    plain prefix).
  - **Fail-closed**: a location-scoped rule never answers a request from which no path can be read
    (e.g. `pwsh`, where the command text cannot tell what it touches) — in that case the card offers
    only the session/tool levels. This is deliberate: we do not give false precision.
  - Check: `node tools\check-approvals.mjs` (it drives the real route with fake req/res, saving and
    restoring the real rule file: 45 cases, including session leakage, the prefix boundary, the
    "no path" case, and the agreement of the client's and the host's path key lists), plus
    `node tools\check-plugin.mjs`. Going live: server restart (the host half only loads then),
    followed by a page reload.

## Next steps

1. The statistics panel's real data: `ctx.slots` + session projections (`tokenUsage`), through the
   internal exports of `dsh-client-ui-chat`.
2. Moving the panel into the right-hand sidebar (`sidebar.right.pane.tab`) or a dedicated strip for
   the 32:9 display.
3. Git / SSH / terminal panels: first a host-side plugin (running in Node, with the `shell`/`fs`
   services), then client-side presentation.
