# Operations — start, restart, stop

> Hungarian version: [`UZEMELTETES.md`](UZEMELTETES.md).

**Status:** the integrity review has been done (2026-10-02). This document records **which entry
point does what**, and why it does it that way — so that a public release does not carry
"started it from the wrong place" kinds of errors.

---

## 1. The entry points

| # | Entry point | What it does | Where it runs |
|---|---|---|---|
| 1 | **Desktop icon** / **taskbar-pinned icon** (`DeepSeek Harness.lnk`) | `bin\DshLauncher.exe`: if the tray is running → signals it to open the window; if not → starts the tray with `-OpenWindow`. Switches: `--tray-only` (tray only), `--reset-geometry` (delete the saved window position), `--help` (help in a **MessageBox** — the launcher is not a console program) | launcher (C#) |
| 2 | **Tray icon → Open (window)** | starts the background GUI (if needed), then opens the `DshWindow.exe` window | tray (PowerShell) |
| 3 | **Tray icon → Stop background GUI** | stops the harness server (the `node` process only); the window and the tray stay | tray |
| 4 | **Tray icon → Restart** | stops every listener on the port, starts a fresh server and saves a **fresh token**; then it **also restarts the robot panel** with its watchdog | tray |
| 5 | **Tray icon → Split window → 4th surface: robot panel** | the robot panel as a separate window surface (next to the workspaces) | tray |
| 6 | **Tray icon → Restart the tray** | reloads only the tray program (after an update); the window and the background GUI are untouched | tray |
| 7 | **Web UI → ⟳** | reloads the interface (the token is watched by `DshWindow`) | browser |
| 8 | **Web UI → ⭯** | harness restart: the request goes to the **tray** (see section 2) | host + tray |
| 9 | **Web UI → ⇪** | go live: write the profile patch, then restart — also through the tray | host + tray |
| 10 | **`tools\restart-harness.cmd`** | restart; it hands it to the tray if that is running | PowerShell |
| 11 | **`tools\restart-tray.cmd`** | restarts only the tray (after an update) | PowerShell |
| 12 | **`bot\start-robot-watchdog.cmd`** | starts the robot panel's watchdog (which also starts the panel) | PowerShell |
| 13 | **DSH terminal** (the Web GUI's terminal panel) | any of the scripts above can be run — it **does not get cut off** (see section 2) | DSH child process |
| 14 | **`tools\release.cmd`** | release: version bump + commit + tag + push + GitHub Release (`gh release create`) | PowerShell |
| 15 | **Web UI → Git panel → Release** | the same `tools\release.ps1`, with one click (`-Yes`) | host + PowerShell |
| 16 | **Robot panel → ⟳ / ⭯ / ☀ / HU** | reload the panel · restart the Harness through the tray · light/dark · language | browser (+ tray on restart) |
| 17 | **`tools\restart-all.cmd`** | **a full update in one click**: first the tray, then the harness (the order matters), finally a summary | PowerShell |
| 18 | **Tray icon → Restart the robot panel** | both the robot panel (4180) and its watchdog are refreshed — needed for a fixed `webhook-server.mjs` to take effect | tray |

## 2. Why every restart goes through the tray

The tray icon is the **only** process that runs outside the DSH process family: it starts at logon
and is single-instance thanks to its own `DshHarnessTrayIcon` mutex. That is why a restart cannot be
cut in half there.

**The measured failure (2026-10-02) that this eliminates:** running `restart-harness.ps1` from the
DSH terminal, the script stopped **its own ancestor**. On shutdown DSH takes the whole process tree
with `taskkill /F /T`, therefore:

1. the script stopped the old server and started the new one,
2. but it could no longer write the fresh token (`state\harness.url` became truncated: 3 bytes
   instead of 74),
3. the tray read the **old** token → `token=False`,
4. the self-healing restarted the server, and meanwhile the window's robot surface was lost
   (`robot felulet: KI`).

**The current chain:**

```
any caller (DSH terminal, Web UI, .cmd, script)
        │
        ├─ is the tray running?  (state\tray.heartbeat fresh)
        │      yes ──▶  state\restart-request  ──▶  the TRAY does it
        │      no  ──▶  starts the tray, then the previous branch
        │      cannot start ──▶ STOPS (exit 3), does not touch the server
        │
        └─ -Force ──▶ a copy detached through WMI
                       (a child of the Win32_Process service, so the caller's
                        taskkill /T cannot reach it; safe from a normal window)
at the end of every route: a fresh token into state\harness.url (written ATOMICALLY)
```

**Why does the script stop when there is no tray?** The own route (a detached copy) first stops the
old server. If the caller itself is sandboxed (DSH agent) or was started from the DSH process, the
copy may die together with the caller's file — and then the **harness stays down**. That is worse
than a half-written token, so this route only runs with `-Force` (an accepted risk).

The atomic write (temp file + `Move-Item`) is needed because an interrupted write left a truncated
`harness.url`, and afterwards **every** reader saw the old token.

## 3. State files (`state\`)

| File | Who writes it | What it is for |
|---|---|---|
| `harness.url` | tray, `restart-node.js`, `restart-harness.ps1` | the **fresh entry token** — the source of truth; every component reads it from here |
| `harness.pid` | tray, `restart-harness.ps1` | the running server's process id |
| `harness.log` / `harness.err.log` | tray, `restart-harness.ps1`, DSH itself | the server's log (the tray reads the token from here) |
| `tray.heartbeat` | tray, every 15 seconds | "the tray is running" — this decides handing over an external request |
| `tray.pid` | tray at startup | the tray's process id (used by `restart-tray.ps1`) |
| `restart-request` | `restart-harness.ps1`, `restart-node.js` | an external restart request; the tray processes and deletes it in its tick |
| `tray-config.json` | tray | `port`, `panes`, `robotPane`, `robotOnly`, `robotUrl`, geometry |
| `window.log` | `DshWindow.exe` | the window's log (token watcher, panels) |
| `tray.log` | tray | the tray's log (every operation and error) |
| `restart.log` | `restart-node.js` | the log of restarts started from the Web UI |
| `restart-harness.log` / `.err.log` | `restart-node.js` | the log of the **server** started from the Web UI (the fresh token goes from here into `harness.url`) |
| `panel-layout.json` | the `dsh-ui-extras` host half | the terminal panel's remembered state per workspace (`rightbarWidth`, `active`, `search`, `terminalWanted`, `terminalRail`, `height:run-N`) |

> **The `~\.dsh\dsh-web\harness.url` file is NO LONGER used.** Previously we wrote a token there
> too, and an interrupted write left a truncated file. The source of truth is `state\harness.url`.

### 3.1 The terminal tab after a new workflow

The right-hand column's tab set is **per session** (DSH mints a separate store for
every session, and a new session starts with a collapsed, empty column). A new
workflow therefore **cannot keep** the terminal tab: the shell never put it into the
new session's column. The only thing a plugin can do — and the only thing it does —
is **re-open it**.

The mechanism has two halves:

- **Intent** (`terminalWanted` in `panel-layout.json`, per workspace): set to 1 when
  the terminal panel appears. Closing it (switching to the files tab, collapsing the
  column, closing the tab) does **not** clear it: two of those are not a decision, and
  guessing wrong there is exactly how the earlier build lost the terminal for good.
- **Re-open**: only on a **session switch** and on **page load**, through one watcher
  (`watchTerminalPresence`), with a handful of tries and verified on the panel's DOM.
  Nothing re-opens while the reader works inside the current session, so a tab closed
  by hand stays closed until the next workflow starts.

> **Once after deploying:** the fix takes effect on the first **page reload** (the
> client bundle is served by the host). Then open the terminal once with the ▶ button —
> that records the intent — and from then on it comes back by itself after every new
> workflow, and after an app restart too.

Checks (live server plus headless Edge, on the right column's real behaviour):

```
node tools\probe-terminal-restore.mjs
node tools\check-plugin.mjs
```

`check-plugin.mjs` also pins the **shape** of the mechanism (no `terminalOpen`
heartbeat, one watcher, no DOM watcher on the sidebar's subtree, a re-open verified on
the DOM), so the old loop cannot creep back in.

## 4. The robot panel (4180)

The robot panel is a process **independent** of the tray:

```
tray ──(every 60 s, if missing)──▶ bot\watchdog-hazi-robot.ps1 ──▶ bot\panel\server.mjs (4180)
```

- The tray's `Invoke-RobotEnsure` checks `bot\state\robot-watchdog.pid` every 60 seconds and starts
  the watchdog if it is not running.
- The watchdog watches the panel every 60 seconds (`/status.json`) and restarts it if it does not
  answer; it also reports the state of the fallback proxy (4123).
- **Restarting the harness does not stop** the robot panel.
- If the robot surface (window panel) got switched off: **tray icon → Split window → 4th surface:
  robot panel**. The setting goes into `tray-config.json` and takes effect at the next window open
  (the tray asks whether to restart the window now).

### 4.1 Theme and language — on all four surfaces at once

The robot panel runs **on a separate origin** (4180), so it does not see DSH's `localStorage`. The
two-way sync therefore goes **through the host** (a server-to-server call, so it does not hit CORS):

| Direction | Route | When |
|---|---|---|
| DSH → robot panel | `GET /ui-extras/github-action?action=theme-sync&value=light\|dark` → `POST http://127.0.0.1:4180/theme` | when the DSH theme button is pressed **and** on every panel load |
| robot panel → DSH | `GET /ui-extras/github-action?action=robot-theme` → `GET http://127.0.0.1:4180/theme` | **every 2 seconds**, if the panel's theme differs |

On the robot panel's side the theme follows the server **live** (also every 2 seconds), so it does
not need a reload to switch the theme.

> **Why 2 seconds?** The robot panel switches on its own button **immediately**, while DSH only
> learns about it at the next poll. With a 10-second poll the user rightly felt that it "only
> switches the robot panel" — although the sync worked, just late. On the DSH side, during
> `THEME_SYNC_HOLD_MS` (6 s) it deliberately does not trust the panel's answer: our own switch's
> `theme-sync` POST is a little late, and the returning poll would read the old value (flicker). On
> a hidden (minimised) page neither direction polls.

- The **language** is switched with the panel's own `HU`/`EN` button (the label shows the
  **active** language, the tooltip the target of the switch), and it is kept in localStorage. The
  DSH-side robot panel (the 🤖 button) follows the **DSH active language**.
- The DSH-side robot panel follows the **DSH theme** (from the `<body data-ds-dark-theme>` marker),
  so it does not stay a black rectangle in light mode.
- The theme is stored in `bot\state\panel-theme.txt`; this is runtime state, `.gitignore` excludes it.

#### What has to be restarted after a fix?

| What you modified | Is a page reload enough? |
|---|---|
| `plugins/*/lib/client.js` (client plugin) | **Yes** — the bundle is built from disk at request time (the `rev` is the content's sha1), so ⟳ / Ctrl+R is enough |
| `plugins/*/lib/index.js` (host-side route) | No — a **harness restart** is needed |
| `bot/panel/server.mjs` (robot panel) | No — the **panel** has to be restarted (tray → **Restart the robot panel**) |
| `tray/dsh-tray.ps1` | No — the **tray** has to be restarted (tray → **Restart the tray**) |
| `src/DshWindow.cs` (native window) | No — `tools\build-window.cmd`, then **close and reopen the window** (tray → **Close window** + **Open (window)**) |

All three at once: `tools\restart-all.cmd`, or in the tray menu **Restart the tray** →
**Restart** (that already takes the robot panel too).

> **The relationship of the native window and the robot panel.** `DshWindow` injects a dark
> background into the Harness panels against the pre-load flash. This goes **only to the Harness
> panels** (`_isHarnessPane`): the robot panel brings its own theme, and the forced dark background
> + dark `color-scheme` drew a black background and a thick black scrollbar underneath it in light
> mode (a measured failure, 2026-10-02 — the `body.light` class remained, but the background became
> `rgb(21,21,23)`).

## 5. Updating the tray

The tray loads **its own code when the process starts**, so a fixed `tray\dsh-tray.ps1` only takes
effect with a restart:

```powershell
.\tools\restart-tray.cmd          # a double click is enough
```

or in the tray menu: **Restart the tray** (this exists in the updated code). Both **leave the window
and the background GUI running** — only the tray program is replaced.

If **both** the tray and the harness need fresh code (the usual case after a fix), one click is
enough — the order matters here, so it is worth using this:

```powershell
.\tools\restart-all.cmd    # 1) tray, 2) harness, finally a summary
```

> **Why does this need the user?** The DSH sandbox (the `pwsh` tool's Win32 Job object) kills
> **every** child process at the end of the command — measured even for the `detached` Node child
> (and for the process started with `Start-Process`). That is why the tray cannot be restarted from
> the DSH sandbox: a **normal window** is needed (or the DSH *terminal* panel, which is not
> sandboxed). For the same reason `restart-harness.ps1`'s WMI route works from the terminal but not
> from the sandbox.
>
> To check whether the tray is already running the fresh code: `Test-Path state\tray.pid` — the old
> tray does not write this file.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Reconnecting…" in the interface | the saved token is stale (the server restarted) | `DshWindow`'s `--restart-if-stale` restarts the server by itself; if not: tray → **Restart** |
| The robot surface disappeared from the window | `robotPane` got switched off in `tray-config.json` | tray → **Split window** → check **4th surface: robot panel** |
| The robot panel does not answer | the watchdog or the panel died | `bot\start-robot-watchdog.cmd`, or wait 60 s (the tray starts it) |
| The restart "stopped halfway" | the script was run from DSH and WMI was not available either | run `tools\restart-harness.cmd` from a **normal** window; the tray restores it in the next round |
| `restart-harness.cmd` → "the tray is RUNNING, but an OLD version" | the tray runs code from before the fix, so it has no `state\tray.heartbeat` and cannot take the request over | `tools\restart-tray.cmd`, then `restart-harness.cmd` again. In this case the script **does not touch the server** (exit 3), so it does not stay stopped |
| `restart-harness.cmd` → "no running system tray" | there is no tray heartbeat and the mutex is not alive either | start the tray (`bin\DshLauncher.exe --tray-only` or the desktop icon), then retry; as a last resort `-Force` from a **normal window** |
| A stuck `state\restart-request` + "the tray did not process it" | the tray **exited** before the request, and the old heartbeat file still looked fresh (a measured failure, 2026-10-02: a restart started 5 seconds after the exit) | fixed: `Test-TrayAlive` checks the **mutex** and the **PID file** too, and the tray deletes the heartbeat on exit. Restart the tray (`tools\restart-tray.cmd`); the tray skips a stuck request as stale |
| The tray "took over" the restart but the server stays the old one (150 s wait) | the tray looked for the process listening on the port **exclusively** with `Get-NetTCPConnection` (WMI/CIM); where that gives "Access denied" it returns an empty list, the old server stays on the port, and the new instance dies with `EADDRINUSE` | fixed: the tray's `Get-PortListenerPids` also uses `netstat -ano -p TCP`, and it checks that the port is free before starting a new server. Tray update: `tools\restart-tray.cmd` |
| The robot panel does not take over the DSH theme | the panel runs on a separate origin, and the page read the theme only at load | fixed: the DSH theme button POSTs to the `/theme` endpoint through the host, and the panel follows the server every 2 seconds. If not: `tools\restart-tray.cmd` + `tools\restart-harness.cmd` (the host-side `theme-sync`/`robot-theme` routes load when the server restarts) |
| The theme button "only switches the robot panel" | the reverse direction (panel → DSH) polled every 10 seconds, DSH only learned about it then — while the panel switched immediately | fixed: the poll is 2 seconds, and `THEME_SYNC_HOLD_MS` went 15 → 6 seconds (15 s blocked the reverse direction right after our own switch too). Client-side fix: **⟳** on the panels is enough |
| The tray's **Restart** menu does not restart the robot | the robot panel is a separate process with its own watchdog, and the menu item previously restarted only the harness | fixed: **Restart** already takes the robot panel too, and there is a separate **Restart the robot panel** item. For this the **tray** has to be restarted once (tray → **Restart the tray**) |
| The robot panel shows a **black background and thick black frames** in light mode, even though the header is light | `DshWindow` injected the `html,body{background:#151517 !important;color-scheme:dark}` style and the `data-ds-dark-theme` marker into EVERY panel — including under the robot panel's own light theme | fixed: the injection (`ThemeScript`, `PreferredColorScheme`) only goes to the Harness panels, and the pre-paint style disappears after 3 s. It has to be recompiled (`tools\build-window.cmd`) **and the window closed/reopened** |
| The **balance** is visible only in dark mode | `Pill` coloured the highlighted value with a fixed `#f9fafb` — white on a white background | fixed: `var(--dsw-alias-label-primary)`. Client-side fix: **⟳** is enough |
| Only the **paid** (topped-up) balance was visible in the footer, not the granted credit | the pill printed `topped_up_balance`, although the DeepSeek API's `total_balance` is the topped-up **+** granted amount, and the web console shows that too | fixed: the pill shows the `total`, and the breakdown (`topped-up + granted = total`) stays in the tooltip. Client-side fix: **⟳** is enough (the footer's `client.js` comes from disk on every load) |
| The DSH panels (Git, SSH, terminal, permissions) stayed dark in light mode | hard-coded dark surfaces (`rgba(21,21,23,…)`, `#e8eaed`) and white-alpha borders | fixed: all replaced with `--dsw-alias-*` theme variables (the fixed value is the fallback). Client-side fix: **⟳** is enough |
| The 🤖 panel stays on the language/theme of opening, or is a black rectangle in light mode | the panel used fixed dark colours and Hungarian labels | fixed: the panel follows the DSH active language and the `<body data-ds-dark-theme>` marker. The client bundle refreshes on a **harness restart** (or a page reload) |
| The harness does not answer, and the tray did not finish either | the tray stopped halfway (crash, exit) | the fixed `restart-harness.ps1` **switches to its own (detached) route** by itself in this case, and restores the server |
| After the restart a DSH panel appears in place of the robot surface (a duplicated panel) | the `DshWindow` before the fix started a token watcher on **every** panel, so it navigated the robot panel (`--pane-url`) to the DSH token URL as soon as a fresh token appeared | `tools\build-window.cmd` (safe even with a running window), then tray → **Close window** + **Open (window)** — the new exe takes effect at the next window open |
| The window went off-screen | a saved geometry from a monitor that no longer exists | `bin\DshLauncher.exe --reset-geometry` (deletes `state\window-geometry.txt`) |
| The tray does not start | `DshLauncher.exe` or the WebView2 DLL is missing | `.\build.ps1`, then the desktop icon |
| Boot error: "Failed to load plugins" | one of our plugin entries broke the boot | `.\tools\recover-harness.ps1` (empties the profile patch, then restarts) |

## 7. Logs

```powershell
Get-Content state\tray.log -Tail 30          # the tray's operations (every restart is visible here)
Get-Content state\window.log -Tail 30        # the window (token watcher, panels)
Get-Content state\harness.err.log -Tail 30   # the server's errors
Get-Content state\restart.log -Tail 20       # restarts started from the Web UI
Get-Content bot\state\robot-watchdog.log     # the robot watchdog (abnormalities only)
Get-Content bot\state\panel.err.log          # the robot panel's errors
```

The tray's log rolls over into `tray.log.1` at 256 KB.

## 8. Checklist before a public release

1. `.\tools\restart-tray.cmd` — the tray runs the fresh code (`tray.heartbeat` exists and refreshes
   every 15 seconds).
2. Tray → **Status…** — the harness is RUNNING, the robot panel is ALIVE, the watchdog runs.
3. Tray → **Split window** → the robot surface is checked.
4. Web UI → **⭯** — the restart completes, the interface returns by itself.
5. `.\tools\restart-harness.cmd` from a normal window — the same.
6. `bot\tests` green (49 tests):
   `node --test --test-isolation=none bot\tests\agent.test.mjs bot\tests\rules.test.mjs bot\tests\plugin-settings.test.mjs bot\tests\alterego.test.mjs bot\tests\panel-render.test.mjs`
   (`panel-render` renders the DSH-side robot panel with fake React: language, theme, missing
   services — so a runtime error shows up even before the restart)
7. `node tools\check-plugin.mjs` green (the `dsh-ui-extras` plugin).
8. **Four surfaces together:** the DSH theme button (🌙/☀) and the language switcher should affect
   all four panels — the robot panel (4180) should switch too, without a reload. The robot panel's
   own ☀/HU button should switch backwards too (the DSH panels following it).
9. **Two-way check:** the robot panel's ⭯ button and `restart-harness.cmd` should both bring the
   interface back (`state\harness.url` refreshes, `DshWindow` navigates to it).
10. `node tools\audit-secrets.mjs` — **the release gate**: the current tree must contain no hit
    (key, password, token, e-mail, personal name, absolute user path). It reports hits in the git
    history but does not block the release — those can only be removed by rewriting history.
11. `.\tools\build-installer.ps1` — the portable ZIP and the installer EXE are produced under
    `dist\`. The package contains **only git-tracked files**, so `state\`, `node_modules` and every
    secret are excluded. Try: `dist\DeepSeek-Harness-Setup-<version>.exe /dir=<temp> /noinstall /silent`
    (`/uninstall` deletes only the shortcut that points into its own folder).
12. **Release:** `.\tools\release.cmd -Version x.y.z` — version + commit + tag + push + GitHub
    Release, with the packages **automatically attached** to the Release. `release.ps1` runs the
    secret audit itself and stops on a hit.
13. **Making it public:** `gh repo edit --visibility public --accept-visibility-change-consequences`.
    Setting the description and the topics (discoverability):
    `gh repo edit --description "..." --add-topic deepseek --add-topic hungarian …`
