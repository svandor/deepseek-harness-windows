# dsh-rule-guard — gépileg kényszerített projekt-szabályok

**Miért van:** az ágensek ismételten megsértették a projekt-szabályokat, mert azok
csak `AGENTS.md` szövegként éltek. Mért esetek (2026-11-20):

| hol | mi történt |
|---|---|
| **Video** (`D:\Szerver\Video`) | a `zene-fa-epites.py --sync` **`os.unlink`-kal** kivett a célfából **7 291 borítóképet** és 11 275 címkézett másolatot — a projekt 60 napos lomtár-szabálya ellenére. A hardlinkek visszaálltak, a címkézés eredménye elveszett (~2 óra újrafutás). |
| **termeszetgyogyaszoktatas-L12** (`C:\Herd\…`) | az ágens **új cront** tett a `routes/console.php`-ba (`applications:orphan-enrollments`), így az **nem jelent meg az admin „Szinkron státusz” listán** (a lista a `config/app_schedules.php`-ból épül). |

A szöveges szabály nem kényszerít: a modell elfelejtheti, tömörítés után kiesik,
vagy egyszerűen nem olvassa el. Ez a plugin a **tool-hívás előtt** dönt, és
**indoklással blokkol** — a modell a hibaüzenetből megtudja, mit kell helyette tenni.

## Mit blokkol

| szabály | hol | mit tilt |
|---|---|---|
| `delete-needs-trash` | Video, Raider (munkaterület **vagy** ssh-host alapján) | `rm`, `Remove-Item`, `os.unlink`, `shutil.rmtree`, `rsync --delete`, `find -delete`, `git clean -f`, `dd … of=`, `DROP/TRUNCATE TABLE` stb. — kivéve, ha a sor lomtár/mentés/temp útvonalat tartalmaz |
| `no-destructive-code` | Video, Raider (fájlba írt kód) | ugyanaz a minta a **kódban** (`.php/.py/.sh/.js/…`) — ez fogta meg a mért `os.unlink`-ot |
| `l12-schedule-admin` | L12 | új közvetlen `Schedule::call` a `routes/console.php`-ba; `Schedule::` más fájlban. Az admin lista (`config/app_schedules.php`) szerkesztése szabad |
| `l12-no-prod-artisan` | L12 | SSH + `php artisan` / `migrate` / `config:cache` az éles hoston (helyi Herd-en szabad) |
| `no-name-kill` | **globális** | `Stop-Process -Name`, `taskkill /IM node.exe`, `killall node` — AGENTS.md 1.6 |

A tiltás **determinisztikus**: nincs „ágenkénti kikapcsolás”, nincs `ask`.
Ha a felhasználó mégis végleges törlést kér, a helyes út a lomtár-mechanizmus
(visszaállítható), vagy a `policy.json` tudatos módosítása.

## A szabályok helye

`plugins/dsh-rule-guard/policy.json` — **hot-reload** (mtime, 2 s): a fájl
mentése után a következő tool-hívás már az új szabályt használja, újraindítás
nélkül. Egy szabály alakja:

```json
"delete-needs-trash": {
  "type": "deny-lines",
  "tools": ["pwsh", "bash", "terminal"],
  "fields": ["command"],
  "patterns": ["\\brm\\s+-{1,2}[A-Za-z-]+"],
  "allowPatterns": ["lomt[áa]r", "\\btrash\\b"],
  "skipReadOnlyLines": true,
  "skipAfterSearch": true,
  "reason": "…",
  "hint": "…"
}
```

- `type: deny-lines` — soronként dönt; a `skipReadOnlyLines` a tiszta olvasó
  sorokat hagyja ki, a `skipAfterSearch` a `grep "rm -rf"` típusú keresést.
- `type: schedule-admin` — az L12 admin cron-listájának kapuja.
- `codeOnly` — csak kód-kiterjesztésű fájlra fut (dokumentációra nem).
- `skipScratchPaths` — az ágens `.tmp` / `%TEMP%` piszkozatára nem fut.

Új szabály: vedd fel a `rules` alá, majd egy workspace `rules` listájába (vagy a
`globalRules`-ba), és futtasd: `node tools/check-rule-guard.mjs`.

## Telepítés

A `~\.dsh` a DSH sandboxján **kívül** van, ezért **normál PowerShell-ablakból**:

```powershell
.\plugins\dsh-rule-guard\install.ps1          # junction + patch bejegyzés
.\plugins\dsh-rule-guard\install.ps1 -Check   # száraz ellenőrzés
.\plugins\dsh-rule-guard\install.ps1 -Remove  # eltávolítás
```

A patch **boot-időben** töltődik, ezért a plugin a **következő Harness-indításnál**
lép életbe. A futó Harness-t tilos újraindítani (AGENTS.md 1.5): a felhasználó
indítja újra a tálcáról (Kilépés → ikon), amikor nem fut munka.

## Ellenőrzés

```powershell
node tools/check-rule-guard.mjs --verbose   # konzisztencia + regressziós esetek
node plugins/dsh-rule-guard/test/policy.test.mjs   # 23 teszt
```

A futó plugin naplója: `~\.dsh\rule-guard.log` (minden blokk: idő, tool, cwd,
szabály, indoklás). A boot ténye is bekerül (`kind: "boot"`).

## Mért hatékonyság (valós session-naplók újrajátszása)

| session | tool-hívás | blokkolt | mi volt a blokk |
|---|---|---|---|
| Video (2026-11-11 … 11-20) | 943 | 14 | mind törlési kísérlet; köztük a **2 `os.unlink`-os szerkesztés**, ami a 7 291 borító törlését okozta |
| L12 (4 session, 2026-11-20) | 1 090 | **1** | a mért szabálysértés: az új közvetlen cron (`applications:orphan-enrollments`) |
| L12 további 3 session | 865 | 0 | nincs téves riasztás |

A Video 14 blokkja nem téves riasztás: mindegyik végleges törlést tartalmazó
parancs/kód a lomtár-szabály hatálya alatt. A tiszta olvasás (`grep`, `ls`),
a `dd … of=/dev/null`, a lomtárba mozgatás, a `/tmp`/`.tmp` takarítás és a
dokumentáció engedve van.

Az újramérés parancsa (valós, tömörített session-naplókon):

```powershell
node tools/replay-rule-guard.mjs "$env:USERPROFILE\.dsh\sessions\<mappa>\<session>\session.v3.jsonl.zstd"
```

## Korlátok (őszintén)

- Ez **háló, nem homokozó**: a mintafelismerést meg lehet kerülni (pl. törlés
  egy nem listázott primitívvel, vagy a tiltott szót összefűzött stringgel).
  A cél a véletlen és a megszokásból fakadó szabálysértés kizárása — nem egy
  ellenséges fél feltartóztatása.
- A `write`/`edit` tartalmát ellenőrzi, a **futó szkript belsejét nem**. Ezért
  van a kód-szabály (`no-destructive-code`): a törlő ág már a fájlba íráskor
  elakad.
- A session-szabály injektálás (`agent/session-start`) best-effort: ha az
  `agent.inject` nem elérhető, a kapu akkor is működik.
