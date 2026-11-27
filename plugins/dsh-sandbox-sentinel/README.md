# dsh-sandbox-sentinel — a sandbox „jelzőtáblája"

> English summary at the end.

## Miért van ez

A DSH sandboxa (`write-restricted` token) a hibaosztályok nagy részét **néma**
módon adja vissza: a harness csak három angol kifejezésből ismeri fel, hogy „ez a
sandbox", a Windows üzenetei pedig **lokalizáltak**. Ezért az ágens érthetetlen
hibát lát, és vagy feladja, vagy **rosszul diagnosztizál**.

Mért eset (2026-11-27, Vector session `765b76d2`, „240Hz kijelző hiba vizsgálata"):

```
& pwsh -File tools\display-mode.ps1 -Status 2>&1 | Out-String
→ Program 'pwsh.exe' failed to run:
  Access to the path '\\.\pipe\LOCAL\dotnet_e1d6…' is denied
```

Az ágens ezt így fordította: **„Sandbox blocked launching external programs?"** —
pedig nem az indítás tilos, hanem a **kimenet csővezetéken való elkapása** —, majd
válasz nélkül lezárta a kört. Ugyanaz a két parancs `cmd /c "… > fájl"` alakban
azonnal lefutott (`nvidia-smi` exit 0).

## Mit tesz

1. **`tools/post-execute`** — a tool-kimenet osztályozása és a kimenet végére
   fűzött, konkrét, másolható teendő. A hívás **nem lesz hiba**, csak értelmes.
2. **`agent/session-start`** — rövid súgó (≈1,1 KB) a négy alapmintával, hogy
   tömörítés és alügynökök után is meglegyen.
3. **Napló** — `~\.dsh\sandbox-sentinel.log` (JSONL: idő, osztály, tool, session),
   ebből mérhető, hogy a panaszok megszűntek-e.
4. **Soha nem rontja el a hívást** — minden ág `try/catch`, hiba esetén `next()`.

## A hét felismert osztály

| osztály | miről ismerhető fel | a teendő |
|---|---|---|
| `pipe-capture` | `\\.\pipe\…` + `denied` / `failed to run` | `cmd /c "prog … > fájl 2>&1"`, majd `Get-Content` |
| `msys-sh` | `couldn't create signal pipe` | `GIT_SSH` a natív OpenSSH-ra, SSH remote |
| `schannel-tls` | `SEC_E_NO_CREDENTIALS`, `schannel` | `web_fetch`, `node -e fetch`, `gh` |
| `chromium-sandbox` | `mojo`, `crashpad`, `0xC0000003` | `browser` tool (host-oldali Edge) |
| `node-spawn` | `EPERM` + `spawn`/`spawnSync` | `stdio:'inherit'` vagy fájl-átirányítás |
| `sandbox-write` | `[sandbox: file access denied` | **ez** az egyetlen eset: egyszeri eszkaláció |
| `access-denied-hu` | `A hozzáférés megtagadva` (magyar) | először fájlba irányítás, utána eszkaláció |

A magyar osztály azért kell, mert a Windows hibaüzenetei ezen a gépen magyarul
jönnek — a beépített felismerés csak angol kulcsszavakat néz.

## Telepítés és ellenőrzés

```powershell
pwsh -NoProfile -File plugins\dsh-sandbox-sentinel\install.ps1          # junction + preset bejegyzés
pwsh -NoProfile -File plugins\dsh-sandbox-sentinel\install.ps1 -Check   # hookok + osztályozó
pwsh -NoProfile -File plugins\dsh-sandbox-sentinel\install.ps1 -Remove  # visszavonás
```

A plugin a **következő session-létrehozásakor** lép életbe (agent-síkú preset).

Tesztek:

```powershell
node plugins\dsh-sandbox-sentinel\test\classify.test.mjs   # 13 eset (mért sztringekkel)
node plugins\dsh-sandbox-sentinel\test\plugin.test.mjs     # 7 eset (hamis ctx)
```

Mért eredmény (2026-11-27): **13/13 + 7/7**, `install.ps1 -Check` →
`HOOKS=agent/session-start,tools/post-execute CLASS=pipe-capture NOTE=OK`.

## Korlát

A felismerés **mintaillesztés**: egy új hibaalak (vagy egy másik nyelvű Windows)
kimaradhat. Ezért a napló a mérőeszköz: ha egy osztály gyakran szerepel, a
megoldás az, hogy a mintát **nem** bővítjük tovább, hanem a kiváltó okot szüntetjük
meg (mint a `GIT_SSH` beállításnál történt).

---

## English summary

`dsh-sandbox-sentinel` closes the "silent sandbox failure" gap: it classifies the
tool output against seven **measured** error classes (five of them are not
recognised by the harness at all, and the Hungarian Windows messages never are),
appends a concrete, copy-pasteable remedy to the tool result — without turning the
call into an error — and injects a short playbook at session start. Which remedy:
`cmd /c "prog > file"` for the named-pipe capture boundary, `GIT_SSH` for the MSYS
shell, `web_fetch` for schannel, the `browser` tool for Chromium, file redirection
for Node `EPERM`, and a one-shot escalation **only** for writes outside the
workspace. Every hit is logged to `~\.dsh\sandbox-sentinel.log`. Measured:
13/13 classifier tests (with the real strings from the 2026-11-27 incident) and
7/7 plugin tests; installed via junction + agent-preset entry, active from the next
session.
