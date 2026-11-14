# DSH munkaasztal-modell (2 asztal, 3+3 panel) — megvalósítási terv

Állapot: **terv** (2026-11-14). A tálca már tud 1–6 felosztást, a 6 paneles
ablak még nem; a két asztal közötti váltó gomb a fejlécbe kerül.

## Cél

- 1 vagy 2 munkaasztal, asztalonként **max 3 panel** (a 3 fölötti panelszám a
  második asztalra kerül: `panes 4/5/6` → 3 + 1/2/3).
- A váltó gomb a **fejlécben, a kicsinyítő ikon előtt**, szövegesen
  („1. munkaterület" / „2. munkaterület").
- A nem látszó asztal paneljei **altatva** (`CoreWebView2Controller.TrySuspendAsync`
  + `CoreWebView2.MemoryUsageTargetLevel.Low`), hogy a memória ne a panelek
  számával nőjön. Mért alap: 3 panel = 3,33 GB WebView2, panelenként ~1,1 GB.
- A robot panel asztala választható (`robotDesktop`).

## Hol kell módosítani

| Fájl | Változás |
|---|---|
| `src\DshWindow.cs` | `Options`: `--desktops N` (1–2), `--desktop N` (1–2). `MaxPanes = 6` már megvan. A `ShowWindow()` pane-rácsát asztalokra bontani (lásd lent). Fejléc-sáv (WPF `Grid` 0. sora, 30 px) a két szöveges gombbal, csak 2 asztalnál. `DshWebViewHost`: `SuspendAsync()` / `ResumeAsync()` burkoló. |
| `src\DshTray.cs` | `WindowConfig`: `Desktops`, `Desktop`, `RobotDesktop` kulcsok (a `TinyJson` csak a saját kulcsokat írja). Menü: „Munkaterületek: 1 / 2", a felosztás 1–6 marad, a robot panel mellé „asztal: 1/2". A `RestartWindowForLayout()` a `--desktops`/`--desktop` kapcsolókat is átadja. |
| `state\tray-config.json` | `desktops`, `desktop`, `robotDesktop` (a tálca írja, az ablak olvassa). |
| `tools\build-window.ps1` | változatlan (átnevezi a futó exe-t, majd fordít). |

## Rács felépítése (DshWindow)

```
Window.Content
└─ Grid (2 sor)
   ├─ sor 0 (30 px): fejléc-sáv — "1. munkaterület" | "2. munkaterület" (csak ha desktops=2)
   └─ sor 1: Grid (desktopok)
      ├─ Desktop1 Grid (1–3 oszlop + GridSplitter)   Visibility = Collapsed, ha nem aktív
      └─ Desktop2 Grid (1–3 oszlop + GridSplitter)   Visibility = Visible,  ha aktív
```

- A panelek a MEGSZOKOTT módon jönnek létre (`DshWebViewHost`), csak más
  szülő-rácsba. A `PaneLayout` (oszlopszélességek) asztalonként külön fájl:
  `state\pane-layout-<desktop>.json` — enélkül a két asztal szélességei
  felülírják egymást.
- Váltáskor: a régi asztal `Visibility = Collapsed` + `SuspendAsync()` minden
  paneljére; az új `Visible` + `ResumeAsync()`. A `Collapsed` panel WebView2-je
  életben marad (állapot megmarad), csak nem rajzol.

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
            // a fókusz/adott esemény önmagában feléleszti; ha nem, az
            // első kattintás után újra kell tölteni
        }
    }
    catch (Exception ex) { Logger.Info("suspend: " + ex.Message); }
}
```

Ha a telepített `Microsoft.Web.WebView2.Core.dll` nem ismeri a
`TrySuspendAsync`-et, **csak a `MemoryUsageTargetLevel`** marad meg (az is
csökkent), és a váltás `Visibility`-váltásra épül.

## Elfogadási feltételek

1. `--panes 6 --desktops 2` → 6 WebView2, egyszerre 3 látszik, a váltó gomb
   működik, a két asztal oszlopszélessége megmarad.
2. A nem aktív asztal paneljei altatva: a folyamataik élnek, a memóriájuk
   mérten kisebb (`Get-Process msedgewebview2` összesítés a váltás előtt/után).
3. A robot panel a kiválasztott asztalon jelenik meg.
4. A tálca 1–6 felosztása és a „Munkaterületek: 1/2" ugyanazt az állapotot
   írja, amit az ablak használ (egy igazság: `state\tray-config.json`).

## Mérés a készültség igazolásához

```
# összes WebView2 memória (a váltás előtt és után)
Get-Process msedgewebview2 | Measure-Object WorkingSet64 -Sum
# a panelek száma(ról) a napló:
Get-Content state\window.log -Tail 20   # "panes: N (desktop 1/2)"
```
