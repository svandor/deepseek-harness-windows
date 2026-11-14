# DSH desktop model (2 desktops, 3+3 panes) — implementation plan

Status: **plan** (2026-11-14). The tray already offers a 1–6 split; the window
does not build six panes yet, and the switch button between the two desktops
belongs in the header row.

## Goal

- One or two desktops, **max 3 panes each** (a pane count above 3 goes to the
  second desktop: `panes 4/5/6` → 3 + 1/2/3).
- The switch button sits **in the header, before the minimize icon**, as text
  ("1. desktop" / "2. desktop").
- Panes of the inactive desktop are **suspended**
  (`CoreWebView2Controller.TrySuspendAsync` + `CoreWebView2.MemoryUsageTargetLevel.Low`)
  so memory does not grow with the pane count. Measured baseline: 3 panes =
  3.33 GB of WebView2, about 1.1 GB per pane.
- The robot pane's desktop is selectable (`robotDesktop`).

## Where to change

| File | Change |
|---|---|
| `src\DshWindow.cs` | `Options`: `--desktops N` (1–2), `--desktop N` (1–2). `MaxPanes = 6` already there. Split the pane grid of `ShowWindow()` into desktops (below). Header strip (WPF `Grid` row 0, 30 px) with the two text buttons, only when there are 2 desktops. `DshWebViewHost`: `SetSuspended(bool)` wrapper. |
| `src\DshTray.cs` | `WindowConfig`: `Desktops`, `Desktop`, `RobotDesktop` keys (the `TinyJson` writer only touches its own keys). Menu: "Desktops: 1 / 2", the 1–6 split stays, and "desktop: 1/2" next to the robot pane. `RestartWindowForLayout()` must pass `--desktops`/`--desktop`. |
| `state\tray-config.json` | `desktops`, `desktop`, `robotDesktop` (written by the tray, read by the window). |
| `tools\build-window.ps1` | unchanged (renames the running exe, then compiles). |

## Grid layout (DshWindow)

```
Window.Content
└─ Grid (2 rows)
   ├─ row 0 (30 px): header strip — "1. desktop" | "2. desktop" (only when desktops=2)
   └─ row 1: Grid (desktops)
      ├─ Desktop1 Grid (1–3 columns + GridSplitter)   Visibility = Collapsed when inactive
      └─ Desktop2 Grid (1–3 columns + GridSplitter)   Visibility = Visible when active
```

- Panes are created exactly as today (`DshWebViewHost`), only into a different
  parent grid. `PaneLayout` (column widths) must be per desktop:
  `state\pane-layout-<desktop>.json`, otherwise the two desktops overwrite each
  other's widths.
- On a switch: the old desktop `Visibility = Collapsed` + `SetSuspended(true)`
  for each of its panes; the new one `Visible` + `SetSuspended(false)`. A
  collapsed pane's WebView2 stays alive (state preserved), it just stops
  drawing.

## Suspend API (WebView2)

```csharp
// DshWebViewHost
internal async void SetSuspended(bool suspended)
{
    try
    {
        CoreWebView2Controller c = _controller;
        if (c == null || c.CoreWebView2 == null) return;
        if (suspended)
        {
            c.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low;
            await c.TrySuspendAsync();
        }
        else
        {
            c.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Normal;
            // focus or any input wakes it; if it does not, the pane reloads
        }
    }
    catch (Exception ex) { Logger.Info("suspend: " + ex.Message); }
}
```

If the installed `Microsoft.Web.WebView2.Core.dll` does not know
`TrySuspendAsync`, keep **only `MemoryUsageTargetLevel`** (still a reduction)
and rely on the `Visibility` switch.

## Acceptance criteria

1. `--panes 6 --desktops 2` → six WebView2s, three visible at a time, the switch
   button works, both desktops keep their own column widths.
2. The inactive desktop's panes are suspended: their processes live on, their
   memory is measurably smaller (`Get-Process msedgewebview2` sum before/after).
3. The robot pane appears on the selected desktop.
4. The tray's 1–6 split and the "Desktops: 1/2" entry write the same state the
   window reads (one source of truth: `state\tray-config.json`).

## Measurement used to prove it

```
# total WebView2 memory (before and after a switch)
Get-Process msedgewebview2 | Measure-Object WorkingSet64 -Sum
# pane count per boot, from the log:
Get-Content state\window.log -Tail 20   # "panes: N (desktop 1/2)"
```
