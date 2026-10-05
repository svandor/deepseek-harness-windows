# Fejlesztési rend / Development notes

## Nyelv / Language

Ez a projekt **kétnyelvű**: minden felhasználói szöveg magyarul és angolul is
megvan. A felület szövegei a `plugins/dsh-ui-extras/lib/client.js` fájlban, a
`hu` és `en` szótárakban élnek; új szöveget mindkettőbe fel kell venni.

This project is **bilingual**: every user-facing string exists in Hungarian and
English. The strings live in the `hu` and `en` dictionaries inside
`plugins/dsh-ui-extras/lib/client.js`; a new string must be added to both.

## Ágak / Branches

**Egyedül fejlesztek, ezért a `main` ágra dolgozunk** — külön ág csak akkor
készül, ha arról kifejezetten szó van.

**This is a single-developer project, so development happens on `main`** —
a separate branch is created only when explicitly requested.

## Commit üzenetek / Commit messages

A Git panel commit gombja üres üzenet esetén automatikusan nevez el
(dátum + az első módosított útvonal). Kézzel is beírható szöveg a mezőbe.

A commit üzenet **nyelve** a Git panel HU/EN gombjával váltható, és a
**munkaterülethez** tartozik: a választás a munkaterület panel-tördelésében
(`state/panel-layout.json`, `commitLang` kulcs) marad meg, ezért lehet az egyik
nyílt projekté angol, a másiké magyar. Amíg egy munkaterülethez nincs mentett
érték, a nyelv az aktív felületi nyelvét követi — a felület nyelve és a commit
nyelve szándékosan két külön dolog.

The Git panel's commit button generates a message automatically when the field
is empty (date + the first changed path). A message can also be typed in.

The **language** of the commit message is switched with the Git panel's HU/EN
button and belongs to the **workspace**: the choice is remembered in the
workspace's panel layout (`state/panel-layout.json`, key `commitLang`), so one
open project can commit in English while another one commits in Hungarian.
Until a workspace has a stored value, the language follows the active interface
language — the interface language and the commit language are deliberately two
separate things.

## Szerző / Author

**Varga Sándor (svandor)** — MIT licenc / MIT license.

## Élesítés / Deploying

```powershell
.\build.ps1                  # a natív ablak és az indító újrafordítása
.\tools\build-window.cmd     # ugyanaz FUTÓ ablak mellett is: átnevezi a régit, az új exe
                             # a következő ablaknyitáskor lép életbe (hiba esetén visszaállít)
.\tools\deploy-plugin.ps1    # a UI-plugin telepítése a Harness profilba
.\tools\deploy-plugin.ps1 -Disable   # visszaállítás
.\tools\recover-harness.ps1  # ha a boot megbukik: patch ürítése + újraindítás
```

## Kiadás / Releasing

Ez a projekt **telepíthető verzió** (a `bin\DshWindow.exe` és a
`bin\DshLauncher.exe` benne van a repóban), ezért minden kiadásnál a verzió, a
git tag és a GitHub Release **együtt** mozog:

```powershell
.\tools\release.cmd                 # patch kiadás (0.1.0 -> 0.1.1), kérdez
.\tools\release.cmd -Bump minor     # 0.1.0 -> 0.2.0
.\tools\release.cmd -Bump major     # 0.1.0 -> 1.0.0
.\tools\release.cmd -Version 1.0.0  # kézzel megadott verzió
.\tools\release.cmd -DryRun         # csak kiírja, mit tenne
.\tools\release.cmd -NoPush         # commit + tag, push és Release nélkül
```

A gyökér `VERSION` fájl az igazság forrása: a `tools\release.ps1` ebből
frissíti a pluginok `package.json`-jának `version` mezőjét is, majd commitol
(`Release vX.Y.Z`), annotált taget készít, pushol, végül
`gh release create vX.Y.Z --generate-notes`-szal kiadja a GitHubon.

A `dsh-ui-extras` Git paneljének **Kiadás** gombja pontosan ugyanezt a szkriptet
hívja (`-Yes`-szal), ezért a felületi és a parancssori út nem tud eltérni.

**A kiadás előtt** nézd át a `git status`-t: a szkript `git add -A`-val a
**teljes** repót commitolja.

## Újraindítás és leállítás / Restart and stop

**Minden újraindítás a rendszertálca ikonra megy át.** A tálca az egyetlen
folyamat a DSH folyamatfáján kívül, ezért ott nem szakadhat félbe; a
`tools\restart-harness.ps1` ezért nem maga indítja újra a szervert, hanem a
`state\restart-request` fájllal kéri meg a tálcát (ha az nem fut, elindítja, és
csak végső esetben indít WMI-vel leválasztott másolatot).

```powershell
.\tools\restart-harness.cmd  # a harness újraindítása (bárhonnan futtatható)
.\tools\restart-tray.cmd     # CSAK a tálca programjának újratöltése (frissítés után)
.\tools\check-servers.ps1    # állapot: harness, robot panel, tálca-életjel, token
```

A belépési pontok, az állapotfájlok és a hibaelhárítás teljes leírása:
[`docs/UZEMELTETES.md`](docs/UZEMELTETES.md).

**Every restart goes through the tray icon** — the only process outside the DSH
process tree, so a restart there cannot be cut short. `restart-harness.ps1` asks
the tray (via `state\restart-request`) instead of doing the work itself.

## Futtatható belépési pontok / Runnable entry points

**Amit a felhasználó futtat, annak legyen `.cmd` burkolója — ne csupasz `.ps1`.**

Ezen a gépen a `.ps1` **nincs társítva** egyetlen alkalmazáshoz sem: a dupla
kattintás az *„Alkalmazás kiválasztása"* ablakot nyitja a futtatás helyett.
Ezért van a `providers/` mappában `run-proxy.cmd`, `run-retune.cmd` és
`run-switch-weekly.cmd`, a `bot/` mappában pedig `start-robot-watchdog.cmd` és
`robot-status.cmd`. **A dokumentációba is a `.cmd`-t írd** a futtatási
útmutatóba — különben a felhasználó zsákutcába fut, és jelezni fogja.

A `.cmd` burkoló szabályai (mind mérésen alapul):

- `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<a .ps1>"`,
- **ASCII-only tartalom és CRLF sorvégek**: a `^` sorfolytatás és az ékezetes
  karakter megzavarja a `cmd.exe` értelmezését (mért hiba: a szkript sorai
  parancsokként futottak, majd `'M' is not recognized...`),
- a végén `pause`, hogy dupla kattintáskor látszódjon az eredmény,
- `exit /b %ERRORLEVEL%`, hogy a hívó (ütemezett feladat) lássa a hibát.

**Anything the user runs needs a `.cmd` wrapper, not a bare `.ps1`.** On this
machine `.ps1` has no application association, so double-clicking opens the
"Choose an app" dialog instead of running it. The wrapper uses
`-ExecutionPolicy Bypass -File`, is ASCII-only with CRLF endings (a `^`
continuation or an accented character breaks `cmd.exe` parsing), ends with
`pause` so a double-click shows its result, and returns `%ERRORLEVEL%` so a
scheduled task can see the failure.
