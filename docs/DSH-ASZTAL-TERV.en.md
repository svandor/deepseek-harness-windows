# DSH desktop model — IMPLEMENTED (two separate windows, 3+3 panes)

Status: **implemented and measured** (2026-11-16). This file replaces the older
"switch desktops inside one window" plan — that approach did not work on this
WebView2 host.

## The model

- The user sets a **total pane count** (1–6) in the tray / settings.
- `panes ≤ 3` → **one** desktop, one window with that many panes.
- `panes > 3` → **two** desktops, **one separate `DshWindow.exe` process per
  desktop**, at most 3 panes each: `4 → 2+2`, `5 → 3+2`, `6 → 3+3`.
- Exactly **one** window is visible at a time; the other is hidden at window
  level (`ShowWindow(SW_HIDE)`). Switching never touches the panes, the WebView2
  controllers or the column widths.
- Both windows use the same AppUserModelID (`DeepSeek.Harness`), so the taskbar
  shows **one** grouped button; a hidden window has no button at all.

## Responsibilities

| Role | Responsibility |
|---|---|
| `src\DshTray.cs` | Desktop switching, window start, visibility. The single switch signal is `state\window-desktop.txt`; the tray polls it every 700 ms and only **applies** it (writing it back caused an endless loop). |
| `src\DshWindow.cs` | Renders its own desktop's panes in ONE grid and writes its own pid file (`state\window-desktop<N>.pid`). It does not switch desktops. |
| Web header (plugin) | The 1/2 icon writes `window-desktop.txt`; it only appears with 4–6 panes. |

State files: `state\window-desktop.txt` (active desktop),
`state\window-desktop1.pid` / `window-desktop2.pid` (which process belongs to
which desktop), `state\tray.pid`, `state\tray-config.json` (`panes` = total).

## Measured pitfalls (do not retry these)

1. **Switching desktops inside one window** — `Collapsed`, a zero-width column or
   toggling `CoreWebView2Controller.IsVisible` produced white panes or a frozen
   window. Stacking two grids also left the lower desktop's panes occluded: with
   `--panes 6`, **3 panes lived invisibly and burned 3 WebView2 instances
   (~3.3 GB)**.
2. **Tray exit killed the windows.** `ExitApp()` called `StopDesktopWindows()`, so
   a tray upgrade or "Exit" **closed every work window** (measured 2026-11-16
   04:53:29). Exit now **leaves** the windows running.
3. **Helper windows hijacked show/hide.** `CiceroUIWndFrame`,
   `SystemResourceNotifyWindow` and `MediaContextNotificationWindow` are also
   top-level, titled, `HwndWrapper[...]` windows; the old finder picked them, so
   `ShowWindow` hid/showed a **helper** window and left the real one invisible
   (measured: **both windows hidden**, empty desktop, "I had to start it
   manually"). The finder therefore **prefers the exact product title**
   (`DeepSeek Harness`).
4. **`Process.MainWindowHandle` is 0 for hidden windows** and unreliable for WPF
   windows (it returns the IME window) — use `EnumWindows` +
   `GetWindowThreadProcessId` + `GetClassName`/`GetWindowText`.
5. **The pid file cannot be shared:** every window used to write desktop 1's
   file, so the desktop-2 window appeared as "desktop 1" and switching did not
   start a new window.

## Taskbar: why the pinned launcher and the running window cannot merge

Windows groups taskbar buttons by **AppUserModelID (AUMID)**, not by process or
shortcut:

- Each process sets the identity of **its windows** with
  `SetCurrentProcessExplicitAppUserModelID("DeepSeek.Harness")` — both
  `DshWindow.exe` and `DshTray.exe` do this, so the **two work windows share one**
  grouped button.
- The **pinned icon is a shortcut (`.lnk`)**, not a window. Windows can merge the
  running window into it only if the shortcut's `System.AppUserModel.ID` property
  **equals** `DeepSeek.Harness`. When that property is absent, the shortcut's
  identity is derived from the **target path** (`bin\DshLauncher.exe`) — a
  different identity, so the taskbar shows **two items**: the pinned launcher and
  the group of running windows.
- The launcher process (`DshLauncher.exe`) **exits** after starting the tray, so
  it can never own a window — the two icons are not caused by having two
  processes but by their **identities differing**.
- The correct fix is therefore to set `System.AppUserModel.ID` = `DeepSeek.Harness`
  on the pinned shortcut and **re-pin** it (the stale taskbar-item cache sometimes
  needs an `explorer.exe` restart — that is what produced the earlier
  "This item is not openable" error).

### Implemented (2026-11-16)

- `tools\set-pinned-aumid.ps1` — `-Check` / `-Apply` / `-RemoveBogusPin`: sets
  `System.AppUserModel.ID` plus `System.AppUserModel.RelaunchCommand` /
  `RelaunchDisplayNameResource` / `RelaunchIconResource` on the shortcuts
  (`IPropertyStore`; backup under `D:\Szerver\DSH-backup\pins-<timestamp>\`) and
  removes the bogus pin that pointed straight at the window exe.
- **Without `RelaunchCommand` the pin cannot relaunch:** once the window closes,
  the taskbar item shows "This item is not openable" (measured). The AUMID alone
  only provides grouping; relaunching a non-running app needs the relaunch
  properties.
- Applied to the pinned-folder, desktop and Start-menu shortcuts; the bogus pin
  was deleted (the stale, dead taskbar icon is gone).
- **Creating a pin is not scriptable on this build:** Windows 11 removed the
  "Pin to taskbar" verb from Explorer's verbs (only "Unpin" exists),
  `InvokeVerb('taskbarpin')` is a silent no-op, and the `User Pinned\TaskBar`
  folder is **not** a source: after clearing `Taskband\Favorites`, Explorer did
  **not** rebuild the pins from it — they were **lost** (63 pins; restored from
  the backup, `state\taskband-values.json` + registry write). Pinning is
  therefore **one manual step**: Start menu → right-click → "Pin to taskbar", or
  drag the desktop icon onto the taskbar. With the properties set, that gives
  **one** icon and it launches even with the window closed.
- **Measured pitfalls:** `IPersistFile::Load` needs **`STGM_READWRITE` (2)**,
  otherwise `Save` returns `STG_E_ACCESSDENIED` (0x80030005); `PROPVARIANT` is
  **24 bytes** on x64 (the 16-byte version corrupts the stack and the value reads
  back as empty); a half-failed `Save` can **truncate the `.lnk` to 0 bytes**
  (restored from the backup).

Source: `src\DshTray.cs` / `src\DshWindow.cs`
(`SetCurrentProcessExplicitAppUserModelID`), `tools\set-pinned-aumid.ps1`.

## Measurements (2026-11-16, this machine)

- 8 simulated clicks (1→2→1→2→2→1→2→1): **all within 0.2–0.8 s**, and after
  every switch exactly **one** window was visible (log:
  `asztalvaltas kesz: aktiv=N (lathato=igen)`).
- Switch that starts a new window: **1.1 s** (the WebView2 panes load
  afterwards).
- Automatic recovery of a hidden (not closed) window: **3.1 s** — supervision
  notices that no window is visible and shows the active desktop's window.
- Memory with 6 panes (2 windows × 3 panes): WebView2 ~3.7–4.3 GB (48
  processes), `DshWindow` ~0.25 GB, harness node ~2.2 GB.

## Forbidden

- Do not start `DshWindow.exe` by hand (duplicate taskbar button, missing pid
  file) — the tray owns window creation.
- Do not collapse panes, zero a column, toggle `IsVisible`, or modify the native
  window frame (each measurably broke the window).
- Tray upgrades use **force-kill** (`Stop-Process -Force`) so that `ExitApp()`
  never runs and the windows survive.
