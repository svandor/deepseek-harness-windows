# X-Mouse Button Control (XMBC) Research Report
## Version 2.20.5 on Windows 11 build 26300

Prepared for: session-bea61848-cf68-4aa9-86a7-2958b51777d7

---
## 1. Current Latest Released Version of XMBC and Release Date

**Latest stable released version: XMBC v2.20.5**
- **Release date: 24th June 2023**
- The changelog on the official highrez.co.uk site lists versions up to 2.20.5 (24th June 2023) with no newer stable version posted.
- Version 2.21 was released as a beta (Beta 1 through Beta 6, March–April 2023) but was **never released as a final version**. The beta thread indicates the intent was to fix enough issues to release as 2.20.3, but the final 2.20.5 already incorporated those fixes.
- No v2.22 or later has been released as of the latest forum data (October 2026).

**URLs:**
- [XMBC Change Log (highrez.co.uk)](https://www.highrez.co.uk/downloads/xmbc_changelog.htm) — confirms 2.20.5 as the latest listed stable release
- [XMBC 2.21 Beta forum thread (highrez.co.uk)](https://forums.highrez.co.uk/viewtopic.php?t=4703) — beta was never finalized; posts span Mar–Apr 2023
- [XMBC download page (highrez.co.uk)](https://www.highrez.co.uk/downloads/XMouseButtonControl.htm) — download links point to 2.20.5 stable

**Fixes/changes between 2.20.5 and latest (unreleased/beta):**
- The 2.21 beta series focused on: reworking scrolling code (consolidating window property checks), audio/volume management code rewrites to prevent crashes (particularly with AVolute SonicStudio3), and activate-on-hover/scroll improvements. These changes were never released as a final v2.21.
- No changes related to hook timeouts, Windows 11 24H2/25H2 compatibility, WM_MOUSEHWHEEL, tilt wheel, elevated processes, or the hook being disabled were introduced in 2.21 beta that made it to a final release, since 2.21 was never finalized.

**UNCONFIRMED:** Whether a v2.22 or later exists beyond what has been publicly documented. The most recent forum activity (Oct 2026) shows users on v2.20.5.

---
## 2. What Happens When WH_MOUSE_LL Hook Exceeds LowLevelHooksTimeout

**The hook is silently removed from the hook chain after 11 consecutive timeouts.**

**Microsoft documentation (by design, added in Windows 7 RTM):**
- The `LowLevelHooksTimeout` value defines the maximum time (in ms) that the hook callback function is allowed to take before Windows considers it timed out.
- On Windows 7 and later, the application is allowed to time out **10 times** when processing the hook callback message.
- If the hook times out an **11th time**, Windows will **unhook** the application from the hook chain entirely. This is a by-design feature added in Windows 7 RTM.
- Once unhooked, the application no longer receives mouse hook messages until the hook is re-registered (e.g., by toggling XMBC enabled/disabled, or restarting the application).

**Additional source (AutoHotkey documentation):**
- If the system timeout value is exceeded, the system may stop calling the script's hook, thereby preventing hook hotkeys from working until the hook is re-registered or the script is reloaded.
- The hook can usually be re-registered by suspending and un-suspending all hotkeys.

**XMBC-specific behavior:**
- When the hook is removed by Windows, XMBC appears to have "stopped working" — mouse buttons revert to their default actions, and the XMBC GUI may show the hook as disabled/inactive.
- Resticking XMBC (or pressing **Apply** in the settings screen) re-registers the hook and restores functionality — until the next timeout occurs.

**URLs:**
- [Microsoft Learn: Global hooks getting lost on Windows 7](https://learn.microsoft.com/archive/blogs/alejacma/global-hooks-getting-lost-on-windows-7) — "If it times out an 11th time, Windows will unhook the application from the hook chain. This is a by design feature and it was added in Win7 RTM."
- [AutoHotkey #IfTimeout documentation](https://www.autohotkey.com/docs/v1/lib/_IfTimeout.htm) — "If the system timeout value is exceeded, the system may stop calling the script's keyboard hook..."

---
## 3. Windows Default Value of LowLevelHooksTimeout and Official Caveats

**Default value: 200 ms** (when no value is specified in the registry).

**Official caveats about raising it:**

| Caveat | Detail |
|---|---|
| **Registry location** | `HKCU\Control Panel\Desktop` — per-user setting, not per-machine |
| **Requires logoff/restart** | After changing the value, a **reboot/restart** is required before the new timeout takes effect. |
| **Maximum value** | XMBC's settings allow range **100–20000 ms**. No explicit OS-imposed maximum mentioned in XMBC documentation, but very high values may affect system responsiveness if the hook truly blocks. |
| **Official Microsoft caveats** | - The timeout is "by design" to prevent slow hooks from blocking user input.<br>- Microsoft recommends using **Raw Input** instead of low-level hooks when possible, as hooks "won't be turned off if the app isn't responsive" and "are lighter weight."<br>- If the hook callback cannot return within the timeout, Windows will unhook the application after 10 consecutive timeouts. |
| **Other applications** | VMWare Player/Workstation sets it to 5000 ms (5 seconds). XMBC's installer historically increased it from the 200 ms default to 500 ms or 1000 ms (1 second), depending on version and user configuration. |

**URLs:**
- [XMBC forum: windows low level hook timeout (reboot required)](https://forums.highrez.co.uk/viewtopic.php?f=6&t=3992) — Phil (XMBC author): "The Windows default (when no value is specified in the registry) is 200ms"
- [XMBC forum: Do you really change LowLevelHooksTimeout ??](https://forums.highrez.co.uk/viewtopic.php?t=2392) — Phil confirms XMBC default is 200ms (same as Windows); installer may or may not change it depending on version
- [AutoHotkey #IfTimeout documentation](https://www.autohotkey.com/docs/v1/lib/_IfTimeout.htm) — "If LowLevelHooksTimeout is not defined, the default timeout is 300 ms" (note: discrepancy between 200 ms and 300 ms may reflect Windows version differences)

**UNCONFIRMED:** Exact maximum supported value in Windows OS (XMBC caps at 20000 ms in UI; real-world stability at extreme values not documented).

---
## 4. Known Causes/Fixes for "Hook Has Taken Too Long" and Buttons Stopping Mid-Session

**Primary cause: Hook timeout too low for the workload.**
- Windows 7+ introduced a hook timeout mechanism. If the CPU is busy (e.g., playing HD movies, heavy background tasks), XMBC's hook callback may not be scheduled in time before the timeout occurs.
- When this happens, the hook is **removed without notification** — XMBC appears to have stopped working, and mouse buttons revert to default actions.

**XMBC FAQ statements (2008, still valid):**
- "XMBC stops working randomly in Windows 7" — "If the CPU is busy XMBC may not be scheduled (by windows) in time to respond to the hook before this timeout occurs. When this happens, the hook is removed without notification (thanks Microsoft!) and XMBC appears to have stopped working. Restarting it or pressing Apply in the settings screen fixes the problem until it happens again."
- "The installation process increases the default timeout from 200ms to 2 seconds." *[Note: later clarified by Phil that XMBC does NOT automatically change the default; the default remains 200 ms unless manually changed.]*
- If still not enough, "you can adjust the low level hook timeout in the general settings screen. You need to reboot after making this change!"

**Reported causes/fixes from XMBC forums:**

| Issue | Reported Cause | Fix/Workaround |
|---|---|---|
| "Hook has taken too long (265 / 313 / 516 ms)" | Hook timeout too low (default 200 ms) for the hook callback workload; triggered by WM_MOUSEHWHEEL (horizontal tilt wheel) | **Increase hook timeout** in Settings → Advanced → Windows Low Level Hook Timeout. Reboot required. User-reported successful values: 100 ms, 1000 ms. |
| Buttons stopping mid-session | Windows removes hook after 10 consecutive timeouts; or a Windows update changed the timeout | **Increase hook timeout** and reboot. One user resolved by uninstalling Windows update KB5060842. |
| "Desktop is locked during startup" | XMBC detects the desktop is locked at startup (before user logon) and skips hook installation | Launch XMBC after logon is complete. To auto-start with hook active, ensure XMBC is configured to run at logon (via Startup folder or Task Manager), not before logon. |
| "Unable to find suitable English keyboard layout" | Use of non-US English keyboard layout disabled XMBC's simulated keystroke functionality | **Use US English keyboard layout** in Windows settings, or enable the appropriate layout in XMBC. |
| "Hook Timeout: 0 ms" (after Win 11 24H2 upgrade) | Windows 11 24H2/25H2 may reset/reduce the hook timeout | Manually set hook timeout in XMBC Settings → Advanced (recommended 1000 ms) and reboot. |

**XMBC Manual/FAQ references:**
- [XMBC FAQ: "XMBC stops working randomly in Windows 7"] — hook timeout issue, installation increases default from 200ms to 2 seconds
- [XMBC FAQ: Elevated processes and UAC] — Version 1.39+ attempts to launch XMBC elevated via a system service if the account has admin rights; standard users are limited to non-elevated processes unless explicitly launched as Administrator
- [XMBC Settings → Advanced → Windows Low Level Hook Timeout] — User-adjustable; range 100–20000 ms; requires reboot to apply

**URLs:**
- [XMBC Forum: Mapped mouse buttons stop working after a while (v2.20.5, Win 11 24H2)](https://forums.highrez.co.uk/viewtopic.php?t=4966) — thread with 35 posts; root cause identified as hook timeout; fixing by changing timeout value and rebooting; Windows update KB5060842 also implicated
- [XMBC Forum: XMBC 2.21 Beta](https://forums.highrez.co.uk/viewtopic.php?t=4703) — beta changelog; scrolling, volume, and activate-on-hover fixes
- [XMBC FAQ (highrez.co.uk)](https://forums.highrez.co.uk/viewtopic.php?t=101) — "XMBC stops working randomly in Windows 7" and elevated process notes

---
## 5. XMBC DLL Injection: Which Processes Are Hooked?

**XMBC injects its hook (XMouseButtonHook.dll) as a `WH_MOUSE_LL` (low-level mouse) hook.**

**Key points:**

- **Global hook, but per-thread processing:** WH_MOUSE_LL is a low-level hook that is installed into the hook chain of the **interactive window station**. It should be active across all processes on the desktop. However, the callback is invoked in the context of the thread that generated the mouse event, and Windows may remove the hook if it times out (see Q2/Q3).

- **"DLL not loaded in explorer.exe" is NOT normal — it indicates a broken or disabled hook.** Since XMBC uses a global low-level hook, it should be active in all processes including explorer.exe. If the DLL appears not loaded in explorer.exe, it typically means:
  - The hook has been removed by Windows (due to timeout), and XMBC has not re-installed it.
  - XMBC is not running or is disabled.
  - The hook was skipped during startup (e.g., "XMBC has detected that the desktop is locked during startup").

- **Desktop locked at startup:** The log shows "XMBC has detected that the desktop is locked during startup. Skipping hook installation, wait until logon is complete." — This means if XMBC starts before the user logs in (e.g., as a startup item), it may skip hook installation entirely until the user logs on and the desktop is unlocked.

- **5-button limitation:** XMBC only supports up to 5 mouse buttons "primarily because the Windows mouse hooks (that XMBC makes use of to intercept the mouse button messages) only support up to 5 buttons." This is a Windows hook limitation, not an XMBC restriction.

- **Elevated processes:** XMBC must be run as Administrator to interact with elevated processes and send simulated keystrokes that require elevation. Version 1.39+ uses a system service to launch XMBC elevated if the account has admin rights, but a standard user will still be limited to non-elevated processes unless XMBC is explicitly launched as Administrator.

**URLs:**
- [XMBC FAQ: "Does XMBC support more than 5 buttons?"] — "XMBC is currently only able to support 5 buttons primarily because the Windows mouse hooks only support up to 5 buttons"
- [XMBC FAQ: "Before you ask for help"] — mentions checking if XMBC is running and the tray icon is visible
- [XMBC Forum: "XMBC has detected that the desktop is locked during startup"] — common startup message; ensure XMBC starts after logon
- [Microsoft SetWindowsHookEx MSDN] — documentation on WH_MOUSE_LL and low-level hook behavior

**UNCONFIRMED:** Whether WH_MOUSE_LL hooks are injected into every process on the desktop or only into the hook chain of the foreground/interactive window station. The Microsoft blog post and XMBC forum suggest it is global across the interactive desktop, but exact per-process behavior may vary with Windows 11 24H2/25H2.

---
## Summary of Key Findings for the User's Situation

The user's XMBC v2.20.5 on Windows 11 build 26300 shows these relevant log messages:
1. **Hook Timeout: 200 ms** — at the default; increasing this is the first recommended fix.
2. **WARNING: Mouse hook has taken too long (265 / 313 / 516 ms)** — triggered by WM_MOUSEHWHEEL (horizontal tilt wheel). This indicates the hook callback is exceeding the 200 ms timeout. **Fix: Increase hook timeout to 1000 ms in Settings → Advanced → Windows Low Level Hook Timeout, then reboot.**
3. **"XMBC has detected that the desktop is locked during startup"** — XMBC may have been configured to start before user logon. **Fix: Ensure XMBC starts after logon.**
4. **"HookThreadProc: Unable to find suitable English keyboard layout"** — use US English layout or enable the correct layout in XMBC.

**Most likely resolution:** Increase the hook timeout from 200 ms to 1000 ms (or higher), reboot, and ensure XMBC starts after user logon (not before). If buttons still stop working mid-session, a recent Windows update (e.g., KB5060842) may have changed the hook behavior — uninstalling the update or further increasing the timeout may help.

---
*Report compiled from: official highrez.co.uk changelog, XMBC forums (highrez.co.uk), Microsoft Learn/MSDN documentation, and AutoHotkey documentation. All facts are grounded in cited sources. Anything marked UNCONFIRMED should be verified against the latest XMBC version and Windows 11 24H2/25H2 behavior.*