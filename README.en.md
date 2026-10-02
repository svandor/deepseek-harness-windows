# DeepSeek Harness for Windows — tray, native window, Hungarian UI, free subagent delegation

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Platform: Windows 11](https://img.shields.io/badge/platform-Windows%2011-0078d4)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)

**Turns the DeepSeek Harness Web GUI into a normal Windows application — and adds
three things it does not ship with: a full Hungarian interface, an automatic
free-model fallback chain for subagent delegation, and a built-in local robot
with its own status panel.**

A DeepSeek Harness Web GUI **igazi Windows-alkalmazássá** alakítása — plusz három
olyan dolog, ami alapból nincs benne: **teljes magyar felület**, **ingyenes
modellekre épülő automatikus fallback-lánc a subagent-delegációhoz**, és egy
**beépített helyi robot** saját állapotpanellel.

> Author / Szerző: **Varga Sándor (svandor)** — MIT license / MIT licenc

---

## English

### What it is

The DeepSeek Harness Web GUI is a foreground process: it needs a terminal and it
serves a browser page. This project makes it a normal Windows application and
extends it.

**The Windows shell**

- a **tray icon** that starts, stops and restarts the background GUI,
- a **native window** (WebView2, dark title bar, no browser chrome) that remembers
  its position, size and pane layout,
- a **pinnable desktop launcher** (`bin\DshLauncher.exe`) — Windows 11 only pins
  real executables, never `.cmd` shortcuts,
- an **operations layer**: every restart is handed to the tray, which is the only
  process outside the DSH process tree, so a restart can never be cut in half —
  not even when it is started from the DSH terminal or the Web UI itself.

**What it adds to the Harness**

| Feature | What it does |
|---|---|
| **Hungarian interface** | 907/912 UI strings translated across 28 namespaces; the language button sits in the top-right corner next to the theme button. English stays available. |
| **Free subagent delegation** | A local OpenAI-compatible proxy (`providers/proxy.mjs`) with an **automatic fallback chain over free providers** (Groq, NVIDIA NIM, OpenRouter free tier, local Ollama). The Harness subagent route points at it, so delegated work runs on free models with measured failover instead of a paid API. A watchdog keeps the proxy alive and a monthly `chain-doctor` re-measures every target. |
| **Built-in robot ("Házirobot")** | A local agent with its **own status panel on port 4180**: chat console, job runner, e-mail reports, a webhook receiver, **14 selectable alter-ego avatars** (with optional automatic rotation) and a separate watchdog. The framework is public; the configured jobs and private integrations live only on the machine that runs them (`bot/extensions.json` describes them, and the panel renders from that descriptor). |
| **Extended statistics row** | Turns, steps, tokens, cache hit rate, estimated cost, live account balance from the DeepSeek API, and the current peak/off-peak pricing period with the next switch — all theme-aware. |
| **Git + GitHub panel** | Repositories of the current workspace with branch, tracking state and commit history, plus GitHub sign-in, repository selection, repository creation and **one-click release** — from the interface, no terminal. |
| **Built-in terminal and SSH** | A tabbed terminal **inside the interface** (no separate window) and saved SSH connections you can open, run and revisit. Both use your own shell and credentials; nothing is proxied through a third party. |
| **Approval management** | The Harness asks before risky tool calls. This project turns that one-shot question into **remembered, per-type, revocable consent**: "always allow" is stored on the host, the prompt disappears for that type, and an inspector lists every remembered rule so it can be withdrawn. The dangerous direction — silently allowing something forever — is the one it makes visible. |
| **Remote-friendly operations** | A tray icon that starts, stops and restarts everything, a **pinnable launcher**, and a restart path that cannot be cut in half: every restart is handed to the tray, the one process outside the Harness process tree. |
| **Connection watchdog** | Reloads the page when the server was replaced, so the interface never gets stuck on "Reconnecting…". |
| **Light and dark theme** | Follows the Harness theme across **all** panes, including the robot panel, which runs on a different origin and is synchronised through the host. |

### Install

**Option A — one-click installer (recommended)**

Download `DeepSeek-Harness-Setup-<version>.exe` from the
[latest release](https://github.com/svandor/deepseek-harness-windows/releases/latest) and run it. It extracts the workspace to
`%LOCALAPPDATA%\DeepSeekHarness`, checks for Node.js and the WebView2 runtime,
and creates the desktop and Start-menu shortcuts.

```text
DeepSeek-Harness-Setup-0.1.0.exe                 # install, show progress
DeepSeek-Harness-Setup-0.1.0.exe /silent         # no prompts
DeepSeek-Harness-Setup-0.1.0.exe /autostart      # + start the tray at sign-in
DeepSeek-Harness-Setup-0.1.0.exe /dir=D:\DSH     # custom target folder
DeepSeek-Harness-Setup-0.1.0.exe /uninstall      # remove folder + shortcuts
```

**Option B — portable ZIP**

Download `DeepSeek-Harness-<version>-portable.zip`, unpack it anywhere (the
program looks for its state files relative to its own location) and run:

```powershell
.\install.cmd                # desktop + Start-menu shortcut
.\install.cmd -AutoStart     # + start the tray at sign-in
```

**Option C — from source**

```powershell
git clone https://github.com/svandor/deepseek-harness-windows.git
cd deepseek-harness-windows
.\build.ps1                  # builds bin\DshWindow.exe and bin\DshLauncher.exe
.\install.ps1                # desktop shortcut (pinnable to the taskbar)
.\tools\deploy-plugin.ps1    # installs the UI plugins into the Harness profile
```

**Requirements**

| | |
|---|---|
| OS | Windows 11 |
| Node.js | ≥ 22 (`node --version`) |
| DeepSeek Harness | the `dsh` CLI (`npm install -g @deepseek-ai/dsh`) |
| WebView2 runtime | part of Windows 11; the installer checks it |
| To build the launcher | the Roslyn `csc.exe` from Visual Studio Build Tools (no .NET SDK needed) |
| For the free-model chain | a free API key from at least one of Groq / NVIDIA NIM / OpenRouter, or a local Ollama |

### Documentation

- [`README.md`](README.md) — the detailed Hungarian operating guide (tray, window, scripts)
- [`docs/UZEMELTETES.md`](docs/UZEMELTETES.md) — operations: entry points, restart/stop, state files, troubleshooting (Hungarian)
- [`docs/safe-plugin-development.md`](docs/safe-plugin-development.md) — how to extend the interface without breaking the boot
- [`docs/dsh-plugin-notes.md`](docs/dsh-plugin-notes.md) — the reverse-engineered plugin API
- [`providers/README.md`](providers/README.md) — the free-model fallback proxy and the scheduled re-tuning
- [`bot/README.md`](bot/README.md) — the built-in robot: panels, jobs, avatars, deployment

### Contributing

The repository keeps its engineering notes in-tree (`providers/FELJEGYZES.md`,
`docs/*.md`): what was measured, what failed, and why the current design looks
the way it does. If you change something, please leave the same kind of trace.

Before opening a pull request:

```powershell
node --test --test-isolation=none bot\tests\agent.test.mjs bot\tests\rules.test.mjs `
  bot\tests\plugin-settings.test.mjs bot\tests\alterego.test.mjs bot\tests\panel-render.test.mjs
node tools\check-plugin.mjs
node tools\audit-secrets.mjs
```

### Keywords

DeepSeek Harness · Windows 11 tray app · WebView2 native window · Hungarian UI
localization · free LLM API fallback · Groq · NVIDIA NIM · OpenRouter · Ollama ·
subagent delegation · local AI agent · desktop AI assistant · MIT licence

---

## Magyar

### Mi ez

A DeepSeek Harness Web GUI egy előtérben futó folyamat: terminált igényel, és egy
böngészőben nyílik. Ez a projekt normál Windows-alkalmazássá alakítja, és
kiterjeszti.

**A Windows-keret**

- **tálcaikon**, amivel a háttér-GUI indítható, leállítható és újraindítható,
- **natív ablak** (WebView2, sötét címsor, böngésző-UI nélkül), amely megjegyzi a
  pozícióját, a méretét és a panel-felosztását,
- **tálcára kitűzhető asztali indító** (`bin\DshLauncher.exe`) — a Windows 11 csak
  valódi `.exe`-t tűz ki, `.cmd` parancsikont nem,
- **üzemeltetési réteg**: minden újraindítás a tálcára megy át, amely az egyetlen
  folyamat a DSH folyamatfáján kívül — így az újraindítás nem szakadhat félbe,
  akkor sem, ha a DSH termináljából vagy magából a Web UI-ból indítják.

**Amit hozzáad a Harnesshez**

| Szolgáltatás | Mit tesz |
|---|---|
| **Magyar felület** | 907/912 feliratszöveg lefordítva, 28 névtérben; a nyelvváltó gomb a jobb felső sarokban, a témagomb mellett. Az angol is elérhető marad. |
| **Ingyenes subagent-delegáció** | Helyi, OpenAI-kompatibilis proxy (`providers/proxy.mjs`) **ingyenes providerekre épülő automatikus fallback-lánccal** (Groq, NVIDIA NIM, OpenRouter ingyenes szint, helyi Ollama). A Harness subagent-route-ja ide mutat, ezért a delegált munka ingyenes modelleken fut, mért átállással fizetős API helyett. Őrfolyam tartja életben a proxyt, a havi `chain-doctor` pedig újraméri az összes célpontot. |
| **Beépített robot („Házirobot")** | Helyi ügynök **saját állapotpanellel a 4180-as porton**: beszélgető konzol, job-futtató, e-mail riportok, webhook-fogadó, **14 választható alteregó-avatar** (opcionális automatikus körbeváltással) és külön őrfolyam. A keretrendszer nyilvános; a beállított feladatok és a privát integrációk csak azon a gépen élnek, amelyik futtatja őket (a ot/extensions.json írja le őket, és a panel abból a leíróból épül). |
| **Bővített statisztika-sor** | Körök, lépések, tokenek, cache-találati arány, becsült költség, élő egyenleg a DeepSeek API-ból, valamint az aktuális csúcs-/völgyidőszak és a következő váltás — téma-követő színekkel. |
| **Git + GitHub panel** | Az aktuális workspace repói branch-csel, követési állapottal és commit-előzménnyel, valamint GitHub-bejelentkezés, repóválasztás, új repó létrehozása és **egy kattintásos kiadás** — a felületről, terminál nélkül. |
| **Beépített terminál és SSH** | Lapos terminál **a felületen belül** (nem külön ablak), és mentett SSH-kapcsolatok, amelyeket megnyithatsz, futtathatsz és újra elővehetsz. Mindkettő a saját shelledet és hitelesítésedet használja; semmi nem megy át harmadik félen. |
| **Egyedi hozzájáruláskezelés** | A Harness kockázatos művelet előtt kérdez. Ez a projekt az egyszeri kérdésből **megjegyzett, típusonkénti, visszavonható hozzájárulást** csinál: a „mindig engedélyezem" a hoston tárolódik, a kérés eltűnik arra a típusra, és egy áttekintő felsorolja az összes megjegyzett szabályt, hogy visszavonható legyen. A veszélyes irány — valamit csendben örökre engedélyezni — az, amit láthatóvá tesz. |
| **Távoli üzemeltetés** | Tálcaikon, ami mindent indít, leállít és újraindít; **tálcára kitűzhető indító**; és olyan újraindítási út, ami nem szakadhat félbe: minden újraindítás a tálcára megy át, amely az egyetlen folyamat a Harness folyamatfáján kívül. |
| **Kapcsolat-őrfelügyelő** | Újratölti az oldalt, ha a szervert kicserélték, így a felület nem ragad be a „Reconnecting…" állapotba. |
| **Világos és sötét téma** | A Harness témáját követi **mind a négy** felületen, a robot panelen is — az külön originen fut, ezért a hoston át szinkronizálódik. |

### Telepítés

**A) Egy kattintásos telepítő (ajánlott)**

Töltsd le a `DeepSeek-Harness-Setup-<verzió>.exe`-t a
[legutóbbi kiadásból](https://github.com/svandor/deepseek-harness-windows/releases/latest), és futtasd. Kibontja a
munkaterületet a `%LOCALAPPDATA%\DeepSeekHarness` mappába, ellenőrzi a Node.js és
a WebView2 meglétét, és elkészíti az asztali + Start menü ikont.

```text
DeepSeek-Harness-Setup-0.1.0.exe                 # telepítés, folyamatjelzéssel
DeepSeek-Harness-Setup-0.1.0.exe /silent         # kérdés nélkül
DeepSeek-Harness-Setup-0.1.0.exe /autostart      # + tálca indítása bejelentkezéskor
DeepSeek-Harness-Setup-0.1.0.exe /dir=D:\DSH     # saját célmappa
DeepSeek-Harness-Setup-0.1.0.exe /uninstall      # mappa + parancsikonok törlése
```

**B) Portable ZIP**

Töltsd le a `DeepSeek-Harness-<verzió>-portable.zip`-et, csomagold ki bárhová (a
program a saját helyéhez képest keresi az állapotfájljait), majd:

```powershell
.\install.cmd                # asztali + Start menü ikon
.\install.cmd -AutoStart     # + tálca indítása bejelentkezéskor
```

**C) Forrásból**

```powershell
git clone https://github.com/svandor/deepseek-harness-windows.git
cd deepseek-harness-windows
.\build.ps1                  # bin\DshWindow.exe és bin\DshLauncher.exe
.\install.ps1                # asztali ikon (tálcára kitűzhető)
.\tools\deploy-plugin.ps1    # a UI-pluginok telepítése a Harness profilba
```

**Követelmények**

| | |
|---|---|
| Operációs rendszer | Windows 11 |
| Node.js | ≥ 22 (`node --version`) |
| DeepSeek Harness | a `dsh` CLI (`npm install -g @deepseek-ai/dsh`) |
| WebView2 futtatókörnyezet | a Windows 11 része; a telepítő ellenőrzi |
| Az indító fordítása | Visual Studio Build Tools Roslyn `csc.exe`-je (nem kell .NET SDK) |
| Az ingyenes modelllánchoz | ingyenes API-kulcs a Groq / NVIDIA NIM / OpenRouter valamelyikétől, vagy helyi Ollama |

### Dokumentáció

- [`README.md`](README.md) — a részletes magyar használati útmutató (tálca, ablak, szkriptek)
- [`docs/UZEMELTETES.md`](docs/UZEMELTETES.md) — üzemeltetés: belépési pontok, újraindítás/leállítás, állapotfájlok, hibaelhárítás
- [`docs/safe-plugin-development.md`](docs/safe-plugin-development.md) — hogyan bővítsük a felületet a boot elrontása nélkül
- [`docs/dsh-plugin-notes.md`](docs/dsh-plugin-notes.md) — a visszafejtett plugin-API
- [`providers/README.md`](providers/README.md) — az ingyenes fallback-proxy és az ütemezett újrahangolás
- [`bot/README.md`](bot/README.md) — a beépített robot: panelek, jobok, avatarok, telepítés

### Ellenőrzés kiadás előtt

```powershell
node --test --test-isolation=none bot\tests\agent.test.mjs bot\tests\rules.test.mjs `
  bot\tests\plugin-settings.test.mjs bot\tests\alterego.test.mjs bot\tests\panel-render.test.mjs
node tools\check-plugin.mjs
node tools\audit-secrets.mjs
```

### Kulcsszavak

DeepSeek Harness · Windows 11 tálcaalkalmazás · WebView2 natív ablak · magyar
felület · ingyenes LLM fallback · Groq · NVIDIA NIM · OpenRouter · Ollama ·
subagent-delegáció · helyi AI-ügynök · asztali AI-asszisztens · MIT licenc

## License / Licenc

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Varga Sándor (svandor).

Szabadon használható, módosítható és terjeszthető, a szerző nevének és a
licencszövegnek a feltüntetésével. A szoftver „adott állapotában" érhető el,
garancia nélkül.
