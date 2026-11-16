# DSH munkaasztal-modell — MEGVALÓSÍTVA (két külön ablak, 3+3 panel)

Állapot: **megvalósítva és mérve** (2026-11-16). Ez a fájl a régi, „egy ablakon
belüli asztalváltás" tervet váltja fel — az a minta a mérés szerint nem
működött ezen a WebView2-hoston.

## A modell

- A felhasználó **teljes panelszámot** állít be (1–6) a tálcán / a beállításban.
- `panes ≤ 3` → **egy** munkaasztal, egy ablak, annyi panellel.
- `panes > 3` → **két** munkaasztal, **asztalonként külön `DshWindow.exe`
  folyamat**, asztalonként legfeljebb 3 panellel:
  `4 → 2+2`, `5 → 3+2`, `6 → 3+3`.
- Egyszerre **pontosan egy** ablak látszik; a másik ablakszinten rejtett
  (`ShowWindow(SW_HIDE)`). A panelekhez, a WebView2 vezérlőkhöz és az
  oszlopszélességekhez a váltás **nem nyúl**.
- A két ablak azonos AppUserModelID-t használ (`DeepSeek.Harness`), ezért a
  tálcán **egy** csoportosított gombjuk van; a rejtett ablaknak nincs gombja.

## Ki mit csinál

| Szerep | Felelősség |
|---|---|
| `src\DshTray.cs` | Asztalváltás, ablakindítás, láthatóság. A váltás egyetlen jelzője `state\window-desktop.txt`; a tálca 700 ms-onként figyeli, és **csak alkalmazza** (nem írja vissza — a visszaírás végtelen ciklust adott). |
| `src\DshWindow.cs` | A saját asztalának paneljeit rajzolja EGY rácsba, és a saját pid-fájlját írja (`state\window-desktop<N>.pid`). Asztalváltással nem foglalkozik. |
| Webes fejléc (plugin) | Az 1/2 ikon a `window-desktop.txt`-be ír; csak 4–6 panelnél jelenik meg. |

Állapotfájlok: `state\window-desktop.txt` (aktív asztal), `state\window-desktop1.pid`
/ `window-desktop2.pid` (melyik folyamat melyik asztalé), `state\tray.pid`,
`state\tray-config.json` (`panes` = teljes panelszám).

## Mért buktatók (ezeket ne próbáld újra)

1. **Egy ablakon belüli asztalváltás** — `Collapsed`, 0 széles oszlop vagy
   `CoreWebView2Controller.IsVisible` kapcsolása **fehér panelt vagy befagyott
   ablakot** adott. A két rács egymásra fektetése pedig takarásban hagyta az alsó
   asztal paneleit: `--panes 6` esetén **3 panel láthatatlanul élt és 3 WebView2-t
   fogyasztott (~3,3 GB)**.
2. **A tálca kilépése megölte az ablakokat.** Az `ExitApp()` `StopDesktopWindows()`
   hívása miatt egy tálca-frissítés vagy „Kilépés" **minden munkaablakot bezárt**
   (mért 2026-11-16 04:53:29). Most a kilépés **otthagyja** az ablakokat.
3. **A segédablakok elrabolták a mutatás/rejtést.** A `CiceroUIWndFrame`,
   `SystemResourceNotifyWindow`, `MediaContextNotificationWindow` is top-level,
   címzett, `HwndWrapper[...]` osztályú ablak — a régi kereső ezeket választotta,
   ezért a `ShowWindow` a **segédablakot** rejtette/mutatta, a valódi ablaktól
   pedig elvett minden láthatóságot (mért: **mindkét ablak rejtett**, üres
   asztal, „kézzel kellett indítani"). A kereső ezért **elsőbbséget ad a pontos
   termékcímnek** (`DeepSeek Harness`).
4. **`Process.MainWindowHandle` rejtett ablakra 0**, és WPF-ablakra megbízhatatlan
   (az IME-ablakot adja vissza) — csak `EnumWindows` + `GetWindowThreadProcessId`
   + `GetClassName`/`GetWindowText` használható.
5. **A pid-fájl nem lehet közös:** korábban minden ablak az 1-es fájlba íródott,
   ezért a 2. asztal ablaka „1. asztalként" jelent meg, és a váltás nem indított
   új ablakot.

## Tálcaikon: miért nem olvad össze a kitűzött indító és a futó ablak ikonja

A Windows a tálcagombokat **AppUserModelID (AUMID)** szerint csoportosítja, nem
folyamat vagy parancsikon szerint:

- Minden folyamat a `SetCurrentProcessExplicitAppUserModelID("DeepSeek.Harness")`
  hívással **az ablakai** identitását állítja be — ezt a `DshWindow.exe` és a
  `DshTray.exe` meg is teszi, ezért a **két munkaablak egyetlen** csoportosított
  gombot ad.
- A **kitűzött ikon viszont parancsikon (`.lnk`)**, nem ablak. A Windows az
  `.lnk`-hez akkor tudja összevonni a futó ablakot, ha a parancsikon
  `System.AppUserModel.ID` tulajdonsága **ugyanaz** (`DeepSeek.Harness`). Ha ez a
  tulajdonság hiányzik, a parancsikon identitása a **célfájl útvonalából**
  származik (`bin\DshLauncher.exe`) — ez más identitás, ezért a tálca **két
  elemet** mutat: a kitűzött indítót és a futó ablakok csoportját.
- Az indító folyamat (`DshLauncher.exe`) **kilép**, miután elindította a tálcát,
  tehát ablakot sem birtokolhat — a „két ikon" nem attól függ, hogy két
  folyamatunk van, hanem hogy **az identitásuk nem egyezik**.
- A helyes megoldás ezért: a kitűzött parancsikon `System.AppUserModel.ID`
  tulajdonságának beállítása `DeepSeek.Harness`-re, majd **újra kitűzés**
  (a régi tálcaelem-cache miatt néha `explorer.exe` újraindítás kell — ez okozta
  korábban a „Nem nyitható meg az elem" hibát is).

### Megvalósítva (2026-11-16)

- `tools\set-pinned-aumid.ps1` — `-Check` / `-Apply` / `-RemoveBogusPin`:
  beállítja a hivatkozások `System.AppUserModel.ID`-ját és a
  `System.AppUserModel.RelaunchCommand` / `RelaunchDisplayNameResource` /
  `RelaunchIconResource` értékét (`IPropertyStore`, mentés:
  `D:\Szerver\DSH-backup\pins-<időbélyeg>\`), és eltávolítja a rossz, közvetlen
  ablak-pint (`DshWindow.lnk` → `DshWindow.exe`).
- **A `RelaunchCommand` nélkül a pin nem indítható újra:** az ablak bezárása után
  a tálcaelem „Nem nyitható meg az elem" hibát ad (mért hiba). Az AUMID önmagában
  csak a csoportosítást adja, a nem futó alkalmazás elindításához a relaunch
  tulajdonságok kellenek.
- Beállítva: kitűzött tálcahivatkozás, asztali hivatkozás és Start-menü
  hivatkozás = `DeepSeek.Harness` + relaunch parancs; a rossz pin törölve (a
  tálcáról a stale elem eltűnt, nincs többé halott ikon).
- **A pin LÉTREHOZÁSA nem scriptelhető ezen a builden:** a Windows 11 kivette a
  „Csatolás a tálcához" igét az Explorer igéi közül (a „Levétel a tálcáról"
  megvan, a visszafelé irány nem), az `InvokeVerb('taskbarpin')` csendben
  hatástalan, és a `User Pinned\TaskBar` mappa **nem** forrás: a
  `Taskband\Favorites` gyorsítótár törlése után az Explorer nem abból építette
  újra a pineket, hanem **elvesztek** (63 pin; a mentésből visszaállítva,
  `state\taskband-values.json` + registry-írás). Ezért a kitűzés **egy kézi
  lépés**: a Start-menüből (jobb klikk → Csatolás a tálcához) vagy az asztali
  ikon tálcára húzásával — utána a beállított tulajdonságok miatt **egy** ikon
  lesz, és becsukott ablak mellett is indít.
- **Mért buktatók:** a `IPersistFile::Load` **`STGM_READWRITE` (2)** kell, különben
  a `Save` `STG_E_ACCESSDENIED` (0x80030005)-öt ad; a `PROPVARIANT` x64-en
  **24 byte** (a 16 byte-os változat stacket ront, és a beállított érték
  visszaolvasáskor üresnek látszik); egy félresikerült `Save` **0 byte-ra
  csonkíthatja** a `.lnk`-et (a mentésből visszaállítva).

Forrás: `src\DshTray.cs` / `src\DshWindow.cs`
(`SetCurrentProcessExplicitAppUserModelID`), `tools\set-pinned-aumid.ps1`.

## Mérés (2026-11-16, ez a gép)

- 8 szimulált kattintás (1→2→1→2→2→1→2→1): **mind 0,2–0,8 s** alatt ért célba,
  és minden váltás után **pontosan egy** látható ablak volt (napló:
  `asztalvaltas kesz: aktiv=N (lathato=igen)`).
- Váltás új ablak indításával: **1,1 s** (a WebView2 panelek ezután töltődnek be).
- Elrejtett (nem bezárt) ablak **automatikus visszahozása: 3,1 s** — a felügyelet
  észleli, hogy nincs látható ablak, és megmutatja az aktív asztalét.
- Memória 6 panelnél (2 ablak × 3 panel): WebView2 ~3,7–4,3 GB (48 folyamat),
  `DshWindow` ~0,25 GB, harness node ~2,2 GB.

## Amit tilos

- Nem szabad kézzel `DshWindow.exe`-t indítani (duplikált tálcagomb, hiányzó
  pid-fájl) — az ablakot a tálca indítja.
- Nem szabad a paneleket összecsukni, 0 szélesre állítani, `IsVisible`-t
  kapcsolni, és a natív ablakkeretet módosítani (mind mérten tönkretette az
  ablakot).
- A tálca-frissítés **force-kill**-lel megy (`Stop-Process -Force`), hogy az
  `ExitApp()` ne fusson le; így az ablakok életben maradnak.
