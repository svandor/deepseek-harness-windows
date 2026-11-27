# Sandbox-kapacitás terv — SSH, GitHub és böngésző végleges megoldása

> English mirror: [`SANDBOX-KAPACITAS-TERV.en.md`](SANDBOX-KAPACITAS-TERV.en.md)

**Státusz:** a **0., 1. és 2. sáv végrehajtva** (2026-11-26/27, lásd
[„A 0. sáv végrehajtása"](#a-0-sáv-végrehajtása--mérve-2026-11-26),
[„Sáv 1"](#sáv-1--a-néma-elutasítások-megszüntetése--kész-2026-11-27) és
[„Sáv 2"](#sáv-2--böngésző-mint-host-oldali-tool--kész-2026-11-26));
a Sáv 3 még terv. Minden állítás ezen a gépen, 2026-11-26/27-én
végzett **mérésből** származik; a mérési parancsok a [függelékben](#függelék-a--a-mérés-parancsai)
vannak, hogy bármikor megismételhetők legyenek.

**A kiváltó panasz:** az ügynökök visszatérően azt jelentik, hogy a sandbox
„indokolatlanul" blokkolja az SSH-t, a GitHubot és a böngészőt — miközben sok
beépített eszköz van. A mérés szerint **a panasz jogos, de nem a sandbox a hibás**:
négy különböző ok keveredik, és csak egyik sem a korlátozás szándéka.

---

## Miről van szó — hétköznapi nyelven

**A sandbox nem internetkapu, hanem írásvédő.** Csak azt akadályozza meg, hogy az
ügynök a munkaterületen kívül fájlokat írjon. Hálózatot nem tilt, olvasást nem
tilt. Mégis három dolog elakad — és mind a három másképp:

**1. A „névlista" hiányos (ezért nem megy a HTTPS).**
Minden program egy engedélylistával indul, ami megmondja, mihez nyúlhat. Erről a
listáról kimaradt egy név, és pont az, amire a **Windows saját titkosított
kapcsolat-kezelője** hivatkozik, amikor HTTPS-hez tanúsítványt kér. Ezért a Windows
TLS-ét használó programok (`curl`, `git` https-en, PowerShell webkérés) nem tudnak
kapcsolódni. Azok viszont, amelyek **saját** TLS-t hoznak magukkal — a Node.js és a
GitHub CLI —, hibátlanul mennek ugyanezen a gépen. Nem a hálózat rossz tehát, hanem
egy program használ rossz „útlevelet".

**2. A programok nem tudnak egymással csatornát nyitni (ezért nem megy az SSH és a böngésző).**
A programok belül csöveken (pipe) beszélnek egymással. A korlátozott program ezeket
nem tudja megnyitni. Három következmény, egyetlen ok:
- a PowerShell nem tudja összeszedni egy program kimenetét → a `git … | more`
  típusú parancsok elhasalnak („Access to the path '\\.\pipe\…' is denied");
- a Githez adott Unix-shell emuláció (`sh.exe`) ilyen csatornán jelzi magát, ezért
  **minden olyan git-parancs elhal, ami shellen megy át** — és ilyen az
  `core.sshCommand`, valamint a `!gh auth git-credential` hitelesítő is;
- a Chrome/Edge indításkor több tucat ilyen csatornát nyit, ezért **el sem indul**.

**3. A Harness nem ismeri fel a hibát (ezért „indokolatlan").**
A Harness csak **három angol** hibaüzenetről tudja, hogy „ez a sandbox". A valódi
hibák másképp néznek ki — az egyik ráadásul **magyarul** jelenik meg
(„A hozzáférés megtagadva"). Ezért az ügynök nem kapja meg a „ez a sandbox, ezt
tedd helyette" jelzést, hanem értelmetlen hibát lát, és vagy feladja, vagy kézzel
kezd kerülgetni.

**4. Nincs súgó (ezért tér vissza minden új beszélgetésben).**
Sehol nincs egy lap, ami megmondaná: *ez a művelet így működik, ezt használd*. Az
ügynöknek a `pwsh` leírása csak azt mondja meg, mit **nem** lehet — azt nem, hogy
mi a helyes út. Ezt minden új beszélgetés újra felfedezi.

**A javaslatok lényege egy mondatban:** ne a korlátozást próbáljuk kikapcsolni
(az védi a gépet), hanem **irányítsuk minden műveletet oda, ahol működik**, és
mondjuk meg ezt az ügynököknek — utána már csak ritkán kell engedélyt kérni.

---

## 0. Vezetői összefoglaló

1. A sandbox a Windows-on **csak az ÍRÁST** korlátozza (`WRITE_RESTRICTED`
   restricted token). A hálózat és az olvasás **nincs** tilalmazva — ezt a
   csomag saját dokumentációja kimondja
   (`dsh-sandbox-windows-acl/README.md:114`). A blokkolt ügyek tehát nem
   „hálózati tilalom", hanem a token két mellékhatása.
2. **HTTPS**, **SSH** és **böngésző** mindegyike **ma is működik** a sandboxban —
   másik eszközzel vagy három konfigurációs sorral. Egyikhez sem kell
   `danger-full-access`.
3. A három konkrét hiba, amit az ügynökök látnak (`SEC_E_NO_CREDENTIALS`,
   `couldn't create signal pipe`, Edge `hozzáférés megtagadva`), **nem illeszkedik
   a beépített elutasítás-felismerő mintákra**, ezért a modell nem kapja meg sem
   a `[sandbox: …]` jelölőt, sem az eszkalációs útmutatást. Ezért jelenti azt,
   hogy „a sandbox blokkolja", ahelyett hogy a működő utat választaná.
4. A jóváhagyási infrastruktúra **már kész**: a `state/approvals.json`-ban él egy
   állandó `sandbox-escalation|danger-full-access` szabály a `pwsh` toolra
   **5 317 találattal** — az 5 317. épp a **saját mérésem** eszkalációja
   (2026-11-26 03:18 UTC), amely `log[].event = "auto-allowed"` néven,
   **kérés nélkül, azonnal** lefutott. A szűk keresztmetszet nem a jogosultság,
   hanem a **tudás és az észlelés**.
5. A végleges megoldás nem újabb folt, hanem **négy sáv együtt**: (0) konfiguráció,
   (1) néma elutasítások megszüntetése, (2) böngésző host-oldali toolként,
   (3) tudás + mérés + upstream. A 0. sáv ma, kód nélkül megszünteti az SSH és a
   GitHub panaszok ~90%-át.

---

## 1. Mért állapot

Minden sor ezen a gépen, `workspace-write` sandboxban, a DSH `pwsh` tooljából mérve.

| # | Művelet | Eredmény | Megjegyzés |
|---|---|---|---|
| 1 | `node -e "fetch('https://api.github.com/zen')"` | **OK, HTTP 200** | Node OpenSSL — nem használ schannel-t |
| 2 | `web_fetch` (beépített host-tool) | **OK, HTTP 200** | a host processzben fut, sandboxon kívül |
| 3 | `git --version` (kimenet nem elfogva) | **OK** | `git version 2.53.0.windows.2` |
| 4 | `git --version` (kimenet elfogva: `$x=`, `\|`, `*>`) | **HIBA**: `Program 'git.exe' failed to run: Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied` | PowerShell a natív kimenet elfogásához **névtelen cső**-szerű named pipe-ot nyit |
| 5 | `cmd /c "git --version > fájl 2>&1"` | **OK** | a `cmd` közvetlen fájl-handle-t ad: nincs pipe |
| 6 | `git ls-remote https://github.com/git/git.git` | **HIBA**: `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` | nyilvános repó |
| 7 | `git -c http.sslBackend=openssl ls-remote https://…` | **OK** (HEAD `acba8bf9…`) | ugyanaz a nyilvános repó |
| 8 | `git -c http.sslBackend=openssl ls-remote https://…/Raider.git` | **HIBA**: `sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5` | **privát** repó → `!gh auth git-credential` helper → `sh` |
| 9 | `ssh.exe -T git@github.com` | **OK**: `Hi svandor! You've successfully authenticated` | `C:\Windows\System32\OpenSSH\ssh.exe` |
| 10 | `GIT_SSH=<natív ssh> git ls-remote git@github.com:…` | **OK** (privát `Rescue`, `LineageOS` refs) | a `GIT_SSH` **közvetlenül** indul, nem `sh`-en át |
| 11 | `git -c core.sshCommand="ssh …" ls-remote …` / `GIT_SSH_COMMAND` | **HIBA**: `sh.exe … couldn't create signal pipe` | ezek **héjon** mennek át → MSYS fork |
| 12 | `Invoke-WebRequest`, `[System.Net.Http.HttpClient]` | **HIBA**: `The SSL connection could not be established` | .NET → schannel → SEC_E_NO_CREDENTIALS |
| 13 | `curl.exe https://github.com` | **HIBA**: `schannel: AcquireCredentialsHandle failed` | a Windows curl csak schannel (mért: `libcurl/8.18.0 Schannel`) |
| 14 | `msedge --headless=new --dump-dom https://example.com` | **HIBA**: `mojo\…\platform_channel.cc: Check failed: A hozzáférés megtagadva (0x5)`, `crashpad OpenProcess: megtagadva`, exit `0xC0000003` | Chromium IPC + crashpad named pipe és process-open |
| 15 | `node -e "execSync('git --version')"` | **HIBA**: `EPERM spawnSync C:\WINDOWS\system32\cmd.exe` | `stdio:'pipe'` a sandboxon belül |
| 16 | `fetch('http://127.0.0.1:3080/')` | **OK, TCP+HTTP elérve** (401 = token kell) | loopback **nem** tiltott |
| 17 | `sandbox_permissions: danger-full-access` + `curl https://github.com` | **OK, HTTP 200, azonnal, kérdés nélkül** | az állandó jóváhagyási szabály auto-allow |
| 18 | `gh auth status` | **OK**, token a keyringben, `gho_…`, scopes: repo/workflow/… | a `gh` saját Go TLS-t használ |

**A repók megoszlása** (`D:\Szerver\*`, `.git/config` alapján) — ezért fáj a HTTPS:

| Protokoll | Repók |
|---|---|
| `https://github.com/…` | Deepseek Harness, Felpuffanto, LineageOS, Raider, Vector, Video (**6**) |
| `git@github.com:…` | Antikolt, Rescue, Zoom (**3**) |

A 6 HTTPS-os repóból **egy sem tud ma push-olni** sandboxban (8. sor: a credential
helper `sh`-t igényel), pedig ezek a fő munkarepók.

---

## 2. Gyökér-okok

### R1 — A restricting SID-lista nem tartalmazza az `Authenticated Users`-t → schannel

A `workspace-write` token restricting listája: *logon SID, Everyone, workspace SID,
temp SID* (`dsh-sandbox-windows-acl/README.md:94`). Az `Authenticated Users`
**szándékosan** kimaradt (ez zárta be a WMI-t és a `C:\` gyökér
mappalétrehozási kiskapuját, ugyanott). A Windows a hozzáférés-ellenőrzést
**kétszer** futtatja, és a restricting SID-ek listájával is egyeznie kell — a
SChannel hitelesítő-adat megszerzése (lsass/CNG RPC) viszont `Authenticated Users`
jogosultságú objektumokon megy át, ezért **minden schannel-alapú TLS** elhasal:
`curl.exe`, `Invoke-WebRequest`, `.NET HttpClient`, `git` (schannel backend).
Nem hálózati tilalom: a Node OpenSSL és a `gh` (Go) ugyanazon a gépen átmegy.

### R2 — A named pipe írása nem adható meg → MSYS `sh`, Chromium, node `stdio:'pipe'`

A csomag ezt kimondja (`README.md:171`): *„Piped stdio capture is impossible for
confined grandchildren"*. Négy tünet, egy ok:

- **PowerShell natív kimenet-elfogás** (`\|`, `$x=`, `*>`): `Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied` (4. sor). Ez a leggyakoribb, mert az ügynök **mindig** el akarja kapni a kimenetet. (A projekt saját ellenőrzője is így hasalt el a mérés közben: `node tools/check-docs-bilingual.mjs | Select-Object` → pipe-hiba; `cmd /c "… > fájl"`-lal zöld, 24/24.)
- **MSYS2 `sh.exe`/`bash.exe`** (Git for Windows): a fork-emulációhoz jel-csövet nyit → `couldn't create signal pipe, Win32 error 5` (8., 11. sor). Emiatt nem megy a `core.sshCommand`, a `GIT_SSH_COMMAND` és a **shell-alapú credential helper** (`!gh auth git-credential`).
- **Chromium/Edge**: mojo platform channel + crashpad (14. sor) → a böngésző **el sem indul**.
- **Node `child_process` `stdio:'pipe'`** (15. sor): `EPERM`.

### R3 — A négy hibaosztály nem illeszkedik az elutasítás-felismerőre → nincs jelölő, nincs útmutatás

A tool-réteg csak akkor adja a `[sandbox: file access denied under <mode> mode]`
jelölőt és az eszkalációs útmutatást, ha a stderr illeszkedik a backend
dialektusára (`dsh-sandbox-local/lib/index.js:205–215`):

```
"windows-acl": ["access is denied", "access to the path", "permission denied"]
```

Ez **három angol kifejezés, kis/nagybetű-függetlenül**. A mért négy családból
**egy** illeszkedik (a pipe-os, „access to the path"), a másik három **nem**:

| stderr | illeszkedik? |
|---|---|
| `Access to the path '\\.\pipe\…' is denied` | igen → jelölő + eszkalációs hint |
| `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)` | **nem** |
| `couldn't create signal pipe, Win32 error 5` | **nem** |
| Edge: `A hozzáférés megtagadva (0x5)` (magyar renderelés!) / `EPERM spawnSync` | **nem** |

Következmény: az ügynök értelmetlen hibát lát, „a sandbox korlátoz" feliratot
diagnosztizál, és vagy feladja, vagy kézzel kezd kerülgetni. **Ez a panaszok
legnagyobb része** — nem a korlátozás, hanem a visszajelzés hiánya.

### R4 — Nincs egy helyen leírt kapacitásmátrix

A `pwsh` tool leírása ma **igen hosszú** és pontos (tartalmazza a named pipe
korlátot is, `dsh-tool-pwsh/lib/index.js:144`), de:
- **negatív** (mit nem lehet), nem mondja meg, **mit kell helyette használni**;
- minden új session újra felfedezi (tömörítés után is elvész, ha nem kerül a
  futásidejű kontextusba);
- az alügynökök a saját presetjükből indulnak, a `pwsh` leírás nem feltétlenül
  jut el hozzájuk;
- sehol nincs meg, hogy a `GIT_SSH`/`openssl`/`cmd`-átirányítás **működik** —
  ezt a mai mérésig senki nem rögzítette.

---

## 3. A megoldás — négy sáv

### Sáv 0 — Azonnali konfiguráció (kód nélkül, ~30 perc) — **VÉGREHAJTVA**

Cél: az SSH, a GitHub és a HTTP **ma** működjön, eszkaláció nélkül.

Hétköznapi nyelven a hat lépés ennyit jelent:

1. **0.1** — mondjuk meg a gitnek, hogy a saját titkosítási kódját használja a
   Windowsé helyett. Ettől a nyilvános repók letöltése/frissítése működik, engedély
   nélkül.
2. **0.2** — mondjuk meg a gitnek, hogy az **igazi** Windows SSH-programot indítsa
   (és ne a Unix-shell emuláción keresztül). Ettől a git push/pull SSH-n működik.
3. **0.3** — ugyanez „azonnali" formában, egy soros előtaggal, újraindítás nélkül
   (amíg a 0.2 csak a következő harness-indítástól él).
4. **0.4** — a 6 HTTPS-es repót átállítjuk SSH-ra. Nem azért, mert a HTTPS rossz,
   hanem mert a **privát** repókhoz a git olyan hitelesítőt hív, ami shellt igényel
   — az pedig a sandboxban nem tud elindulni. SSH-nál hitelesítő sem kell.
5. **0.5** — webes kérésre a beépített `web_fetch`/`node` az út, nem a `curl` vagy a
   PowerShell `Invoke-WebRequest` (azok a Windows TLS-én hasalnak el).
6. **0.6** — ha egy program kimenetét el kell kapni, `cmd /c "program … > fájl"`,
   majd a fájl elolvasása. Így nem a PowerShell próbálja csövön át elkapni.

| Lépés | Parancs / beállítás | Fedi |
|---|---|---|
| 0.1 | `git config --global http.sslBackend openssl` | 6.→7. sor: minden **nyilvános** HTTPS olvasás (`fetch`, `ls-remote`, `clone`) |
| 0.2 | Felhasználói környezeti változó: `GIT_SSH=C:\Windows\System32\OpenSSH\ssh.exe`, `GIT_SSH_VARIANT=ssh` | 11.→10. sor: git SSH transport **nem** megy `sh`-en át |
| 0.3 | Session-idióma (azonnal, újraindítás nélkül): `$env:GIT_SSH='C:\Windows\System32\OpenSSH\ssh.exe'; git push` | 10. sor — **mért működik** |
| 0.4 | A 6 HTTPS repó remote-jának átállítása SSH-ra: `git remote set-url origin git@github.com:svandor/<Repo>.git` | 8. sor megszűnik (a credential helper `sh`-igénye) |
| 0.5 | HTTP az ügynököknek: `web_fetch` / `web_search` / `node -e fetch` — **ne** `Invoke-WebRequest`, **ne** `curl.exe` | 1., 2., 12., 13. sor |
| 0.6 | Natív kimenet elfogása: `cmd /c "program … > fájl 2>&1"`, majd a fájl olvasása | 4.→5. sor |

> **Miért `GIT_SSH` és nem `core.sshCommand`?** Mérve (11. sor): a
> `core.sshCommand` és a `GIT_SSH_COMMAND` értékét a git **héjon** keresztül
> futtatja (MSYS `sh`), az `GIT_SSH` viszont **közvetlenül** indítja a programot.
> Ugyanezért nem javasolt semmilyen `!`-lel kezdődő credential helper.

#### A 0. sáv végrehajtása — mérve (2026-11-26)

Mind a hat lépés megtörtént; a végrehajtás **egyetlen, jóváhagyott eszkalált
hívásban** futott (a `~/.gitconfig` és a `HKCU\Environment` a sandboxon kívül van).

| Lépés | Végrehajtva | Ellenőrzés |
|---|---|---|
| 0.1 `http.sslBackend=openssl` | `git config --global http.sslBackend openssl` | sandboxból visszaolvasva `openssl`; `git ls-remote --heads https://github.com/git/git.git` → **exit 0**, refs jönnek |
| 0.2 `GIT_SSH` user env | `GIT_SSH=C:\Windows\System32\OpenSSH\ssh.exe` és `GIT_SSH_VARIANT=ssh` | `HKCU:\Environment` visszaolvasva |
| 0.3 per-call idióma | `$env:GIT_SSH='…'` a hívásban | **ezzel** futott a lenti ellenőrzés |
| 0.4 a 6 remote SSH-ra | Deepseek Harness, Felpuffanto, LineageOS, Raider, Vector, Video | `git remote get-url origin` mind a hatnál `git@github.com:…` |
| 0.5 webes út | `web_fetch` / `node -e fetch` | 1., 2., 12., 13. sor mérése |
| 0.6 kimenet-elfogás | `cmd /c "… > fájl"` | maga az ellenőrzés is ezzel futott |

**Igazi próba a sandboxban** (`$env:GIT_SSH` per-call, `cmd /c` átirányítással):

```
OK  Deepseek Harness  0d602bc0…  refs/heads/main
OK  Felpuffanto       bcf25fd8…  refs/heads/main
OK  LineageOS         62699707…  refs/heads/main
OK  Raider            b4328b99…  refs/heads/main
OK  Vector            31801bb4…  refs/heads/main
OK  Video             24cc60e7…  refs/heads/main
SSH elérés: 6 OK, 0 hiba

git push --dry-run origin HEAD  ->  exit=0, "Everything up-to-date"
```

Az utolsó sor a lényeg: **a `git push` a sandboxban, engedélykérés nélkül működik.**

**Mentés / visszaállás:** `C:\Users\info\.gitconfig.bak-20261126-045839`. Visszaállás:
remote-onként `git remote set-url origin https://github.com/svandor/<Repo>.git`, a két
env változó törlése (`[Environment]::SetEnvironmentVariable('GIT_SSH',$null,'User')`),
a `.bak` visszamásolása.

**Amit ez NEM old meg:** a *privát* HTTPS-t (a shell-alapú credential helper miatt —
ezért álltak át a repók SSH-ra), a `curl`/`Invoke-WebRequest` TLS-ét, a böngészőt és a
PowerShell kimenet-elfogását — ezek a Sáv 1–2 tételei.

**Megvalósítás:** a változtatás kézzel, ellenőrzötten megtörtént (fent). A
`tools/git-sandbox-config.mjs` (idempotens, dry-run, `--apply`) továbbra is nyitott
tétel, hogy gép-újratelepítésnél egy paranccsal megismételhető legyen.

### Sáv 1 — A néma elutasítások megszüntetése — **KÉSZ (2026-11-27)**

Új plugin: **`plugins/dsh-sandbox-sentinel`** (agent-sík, a `dsh-rule-guard`
telepítési útján: junction + preset-bejegyzés).

Hétköznapi nyelven: ez egy **jelzőtábla**. Amikor a négy ismert hiba valamelyike
megjelenik, a plugin odaírja az ügynöknek, hogy „ez a sandbox volt, ezért, és ezt
tedd helyette" — és minden beszélgetés elejére bekerül egy rövid súgó, hogy ne
kelljen újra felfedezni.

**MIÉRT lett sürgős (mért eset, 2026-11-27, Vector `session-765b76d2`):** az ágens
`& pwsh -File tools\display-mode.ps1 -Status 2>&1 | Out-String` és
`& nvidia-smi … 2>&1 | Out-String` alakban hívott. A sandbox a névtelen cső miatt
elutasította:

```
Program 'pwsh.exe' failed to run: Access to the path '\\.\pipe\LOCAL\dotnet_e1d6…' is denied
```

Az ágens a saját gondolatmenetében ezt így fordította le: **„Sandbox blocked
launching external programs?"** — vagyis rossz diagnózis (nem az indítás tilos,
hanem a **kimenet csővezetéken való elkapása**), majd **válasz nélkül lezárta a
kört**. Ugyanaz a két parancs `cmd /c "… > fájl"` alakban azonnal lefutott
(`nvidia-smi` exit 0, `display-mode.ps1 -Status` teljes kimenet) — a tudás tehát
megvolt, csak nem jutott el a modellig. **Ez a sáv pontosan ezt a rést zárja.**

**Megvalósítás (a tervhez képest pontosítva):**

1. **`tools/post-execute`**: hét hibaosztály (`lib/classify.js`, tiszta modul) —
   `pipe-capture`, `msys-sh`, `schannel-tls`, `chromium-sandbox`, `node-spawn`,
   `sandbox-write`, `access-denied-hu` (a **magyar** „A hozzáférés megtagadva" is,
   amit a beépített felismerés nem lát). Találatnál a kimenet VÉGÉRE kerül egy
   konkrét, másolható teendő — nem blokkol, a hívás sikeres marad.
2. **`agent/session-start`**: rövid (≈1,1 KB) súgó a négy szabállyal, „NEM
   felhasználói üzenet" jelölővel (a `dsh-rule-guard` tanulsága szerint).
3. **Napló**: `~\.dsh\sandbox-sentinel.log` (JSONL: idő, osztály, tool, session) —
   ebből mérhető, hogy a panaszok megszűntek-e.
4. **Biztonságos**: minden ág `try/catch`, hiba esetén `next()` — a plugin soha nem
   rontja el a hívást és nem állítja meg a bootot.

**MÉRVE:** `node plugins\dsh-sandbox-sentinel\test\classify.test.mjs` → **13/13**
(a mért sztringekkel, köztük a fenti két parancs kimenetével és a magyar üzenettel;
téves pozitív nélkül), `test\plugin.test.mjs` → **7/7** (a jegyzet a helyére kerül,
a normál kimenet változatlanul megy át, a fájl-toolokhoz nem szól hozzá,
a súgó beinjektálódik). Telepítve: junction +
`- id: sandbox-sentinel` (mentés: `agent.cordis.yml.bak-2026-11-27-103602`),
`install.ps1 -Check` → `HOOKS=agent/session-start,tools/post-execute
CLASS=pipe-capture NOTE=OK`. **Érvénybe lépés: a következő session-létrehozásnál**
(a futó Harness-t nem indítottuk újra, §1.5).


### Sáv 2 — Böngésző mint host-oldali tool — **KÉSZ (2026-11-26)**

A Chromium sandboxon belül **szerkezetileg** nem indítható (R2/d), és nem is
kívánatos feloldani (lásd 4. pont). Ezért a böngésző a **host processzben** fut,
toolként — ahogy a `dsh-terminal-tool`, a `dsh-devadmin` és a `dsh-ftp-deploy` már ma
is teszi.

Hétköznapi nyelven: a böngésző a korlátozott környezetben nem tud elindulni (és nem
is baj, hogy nem tud — ez védi a gépet). Ezért a Harness **saját**, nem korlátozott
folyamatában indítjuk, és eszközként adjuk az ügynöknek: „nyisd meg ezt az oldalt",
„olvasd ki a szöveget", „csinálj képernyőképet", „kattints ide".

**Megvalósítás — `plugins\dsh-browser`** (a teljes leírás a plugin
`README.md`-jében). A tervhez képest **egyszerűbb lett**: nincs szükség host-oldali
HTTP route-ra és fájl-postafiókra, mert az agent-síkos plugin toolja maga is a
**host processzben** fut (csak a sandboxolt *parancsok* korlátozottak) — így a
motor közvetlenül hívható:

- **motor:** nyers **CDP** headless Edge-en, **új függőség nélkül** (a bizonyított
  minta: `.test-dsh-home\probe-hero.mjs`); `lib\{edge,cdp,scope,profiles}.js` +
  `lib\index.js` (a tool);
- **műveletek:** `open`, `read`, `click`, `type`, `eval`, `shot`, `download`,
  `console`, `profiles`, `close`, `status`;
- **célterület:** mindhárom fokozat elérhető (`loopback` / `lan` / `any`, alap az
  `any`), **külső oldalon is lehet kattintani és gépelni** (a felhasználó döntése);
- **profilok:** eldobható az alap, de **tartós** profil is létrehozható
  (`profile: "lineageos"` → `state\browser-profiles\lineageos`), hogy a
  bejelentkezés megmaradjon; a törlés **lomtárba** megy;
- **letöltés:** **jóváhagyáshoz kötött** (`ctx.approval`, egyszeri engedély) —
  jóváhagyás nélkül a letöltés el sem indul;
- **korlátok:** csak `--headless=new` (AGENTS.md 1. pont), saját `--user-data-dir`
  (soha nem a felhasználó profilja), egy böngésző, `idleMs` (3 perc) után automatikus
  zárás, leállítás **csak saját PID-del** (`taskkill /T /F`), minden navigáció és
  letöltés a `state\browser.log`-ba.

**MÉRVE (2026-11-26):** `node plugins\dsh-browser\test\*.test.mjs` → **33/33**
(11 célterület + 8 profil + 6 CDP + 8 kapu), és a valódi motor:
`node tools\browser-doctor.mjs --allow-download` → **7/7 ok**:

```
OK browser-exe        msedge.exe
OK scope-policy       5/5 eset helyes
OK loopback-ui        cím="DeepSeek Harness" kész=true kép=44079 B
OK external-read      cím="Example Domain" törzsszöveg=917 karakter
OK external-click     https://example.com/ → https://www.iana.org/help/example-domains
OK persistent-profile süti túlélte az újraindítást: igen
OK download           doctor.txt (19 B)
```

A `loopback-ui` képernyőkép a **valódi futó felület** (a munkaterület-lista, a hero
és a modellválasztó látszik rajta). Két hibát a mérés talált meg és javítottunk:
(a) `Page.navigate` után a `readyState` még az **előző** dokumentumé volt, ezért az
olvasás a félig töltött lapra esett — most a `Page.loadEventFired` eseményt várjuk be;
(b) a `taskkill /F /T` nem engedte kiírni a profilt, ezért a **tartós profilba tett
süti elveszett** — most előbb `Browser.close`, csak utána a kényszerített fa.

**Telepítve:** junction + `- id: tool-browser` a
`~\.dsh\.agent-presets\standard-free\agent.cordis.yml`-ba (mentés:
`.bak-20261126-051734`), `install.ps1 -Check` → `TOOL=browser`. A tool a
**következő session-létrehozáskor** jelenik meg (a futó Harness-t nem indítottuk
újra, §1.5).

Ezzel a `tools/browser-probe.mjs`, `tools/probe-terminal.mjs`,
`tools/probe-hero.mjs` és minden jövőbeli képi ellenőrzés **eszkaláció nélkül**
fut, és a „böngésző" panasz megszűnik.

### Sáv 3 — Tudás, mérés, upstream (~1–2 óra)

Hétköznapi nyelven: (1) **egy parancs**, ami 18 próbával megmondja, minden
működik-e — frissítés után is, hogy egy csendes visszaesés ne tűnjön „szigorúbb
sandboxnak"; (2) **egy lap + automatikus emlékeztető** az ügynököknek; (3)
**őrszem-szabályok**, hogy az új lehetőségek ne legyenek szélesebbek a kelleténél;
(4) **jelzés a DSH fejlesztőinek**, hogy ezek a korlátok sok felhasználót fognak —
így a következő verzióban már nem kell kerülőút.

1. **`tools/sandbox-doctor.mjs`** — a ma mért 18 soros mátrix automatizálva:
   minden próba `ok` / `denied` / `broken` + a kiváltó ok, `--json`, kilépési kód.
   **Miért kötelező:** a DSH frissítése (a) felülírja a `node_modules` foltokat
   (`tools/patch-sandbox-no-window.ps1` fejléce), (b) újraírja a `settings.yaml`-t,
   (c) hozhat új sandbox-szigorítást — a csendes visszaesés ma pontosan úgy néz ki,
   mint egy „szigorúbb sandbox". A doctor ezt **egy parancsban** megmondja.
2. **`AGENTS.md` új pont (5.): „Sandbox-kapacitások és eszköz-útválasztás"** — a
   mátrix + a 6 idióma + kimondva: *„a 'a sandbox blokkolja' önmagában nem
   elfogadható jelentés; a helyes út a mátrix szerinti eszköz, majd ha nincs ilyen,
   egy eszkaláció"*.
3. **`dsh-rule-guard` új szabályai** (a `policy.json`-ban, hot-reload):
   `GIT_SSH`/git csak a natív OpenSSH-ra mutathat; a `dsh-browser` csak a
   jóváhagyott hostlistára; `danger-full-access` eszkaláció csak a 0. sáv
   műveleteire (a meglévő `delete-needs-trash` marad).
4. **Upstream beadvány** a `docs/DSH-UPSTREAM-ISSUE.md`-be (van már 5+2 pont):
   (a) a `denialSignatures` legyen bővíthető és tartalmazzon lokalizált
   hibaszöveget; (b) a `windows-acl` kapjon **opt-in** rögzített
   „pipe+network" szintet az `Authenticated Users` nélkül (a write-határok
   megtartásával); (c) `SandboxExecutionPolicy` támogasson extra írható gyökereket
   (ma „One primary workspace root per session"); (d) a `dsh-user-approval` seam
   kapjon tartós grantot (ma csak `allowed-once`), mert a tartós szabályt ma a
   `dsh-ui-extras` saját store-ja adja, ami nem a mag szerződése.

---

## 4. Amit NEM javaslok (és miért)

| Ötlet | Miért nem |
|---|---|
| `Authenticated Users` a restricting SID-ek közé | a `node_modules`-t kellene foltozni (frissítésnél elvész), és **visszanyitná** a write-kiskapukat (WMI, `C:\` gyökér), amit az upstream szándékosan zárt be |
| A munkamenet alapból `danger-full-access` | minden munkaterületen elvész a fájl-határ; a 0. sáv enélkül is megoldja az SSH-t |
| `Start-Process -WindowStyle Hidden` / `wscript` kerülőutak a hálózatra | AGENTS.md 1. pont szelleme (nincs fókuszlopás, nincs rejtett lánc), és nem old meg semmit: a gyermek ugyanabban a tokenben fut |
| A `DENIAL_SIGNATURES` foltozása a `node_modules`-ban | DSH-frissítésnél elvész; a plugin (Sáv 1) ugyanazt tudja, tartósan |
| Az `approvals.json` állandó `danger-full-access` szabályának törlése | ez a **működő** út ma; előbb a 0–2. sávnak kell elkészülnie, csak utána szűkíthető (D4) |

---

## 5. Döntések

| # | Kérdés | Állapot |
|---|---|---|
| **D1** | Átálljanak-e a 6 HTTPS repó remote-jai SSH-ra? | **✔ elvégezve** 2026-11-26 (6/6, ellenőrizve) |
| **D2** | Beállítható-e a `GIT_SSH` felhasználói környezeti változóként? | **✔ elvégezve** 2026-11-26 (a teljes hatás a következő harness-indítástól; addig a per-call idióma) |
| **D3** | A böngésző-eszköz célterülete és műveleti hatóköre | **✔ eldöntve** 2026-11-26: **mindhárom szint**, külső kattintás is, eldobható **és** tartós profil, a letöltés jóváhagyáshoz kötve (lásd Sáv 2) |
| **D4** | Az állandó jóváhagyási szabályok sorsa | **✔ eldöntve** 2026-11-26: **(a)** — mind a három szabály marad, változatlanul |

### D3 pontosítva — mit jelent a „célterület"

Négy külön dologról van szó, és csak az első kettő döntés:

1. **Hálózati hatókör** — három reális fokozat:
   - **A1 — csak a saját felület:** `127.0.0.1`, `localhost`, `[::1]`. A tool kizárólag a DSH paneljeinek ellenőrzésére jó (képernyőkép, DOM, kattintás).
   - **A2 — A1 + a helyi gépek:** a fenti plusz a LAN-on futó fejlesztői/teszt szerverek (pl. `192.168.1.8`, `192.168.1.252` — a Video/L12/Raider teszt-hostok). **Ez fedi a mostani igényeket** (a `probe-terminal`, a hero-próba és a projekt-oldalak ellenőrzése).
   - **A3 — bármely URL:** a nyilvános internet is. Ekkor a böngésző gyakorlatilag egy *nem sandboxolt* böngésző a host jogosultságaival: elér belső szolgáltatásokat, letölt fájlokat, és a hálózati szűrés (a sandbox) rajta nem érvényesül.
2. **Műveleti hatókör** — két fokozat:
   - **olvasó:** `navigate`, `dom`, `text`, `shot`, `console`, `wait` — oldalt nyit és olvas;
   - **interaktív:** `click`, `type`, `upload`, `eval` — kattint, gépel, fájlt tölt fel, kódot futtat az oldal kontextusában.
3. **Profil** — *nem döntés, fix:* mindig friss, eldobható temp profil. A felhasználó bejelentkezett Edge-profilja **soha** nem használható (azzal a tool a felhasználó minden munkamenet- és banki bejelentkezéséhez hozzáférne).
4. **Kitettség** — *nem döntés, fix:* letöltés alapból tiltva; a képernyőkép csak a munkaterület alá írhat; a tool a host processzben fut, tehát a fájl-védelem rá nem érvényes → ezért kell a `dsh-rule-guard` szabálya is.

**A felhasználó döntése (2026-11-26):** „nyilván mind a három szintet el kell tudni
érni böngészővel … a külső oldalakra is kell néha a kattintás (tegnap pont ez
hiányzott a LineageOS repóban) … oké az eldobható profil, de tudj tartósabbat is
létrehozni egyes feladatokra (pl. hogy ne kelljen minden próbálkozásnál
bejelentkeznem) … a letöltést kötheted engedélykéréshez."

Ebből a megvalósítás: **`any` az alap-hatókör** (a három szint bármikor
választható), **kattintás/gépelés külső oldalon is**, **tartós profil** opcionális
névvel, **a letöltés pedig kötelezően jóváhagyáshoz kötött**. A kezdeti
„A2 + csak loopback interaktív" ajánlat ezzel **hatályát vesztette**.

### D4 pontosítva — mit tesznek ma az állandó jóváhagyási szabályok

**Tény (mért):** ma **három** állandó szabály él a `state/approvals.json`-ban, mind
`danger-full-access`-ra (teljes hozzáférés), mind **lejárat nélkül**:

| Tool | Találat | Kelt | Megjegyzés a szabályban |
|---|---|---|---|
| `pwsh` | **5 317** | 2026-09-27 | „headless Edge + DevTools protokoll (a sandbox az Edge IPC-csatornáit blokkolja)" |
| `edit` | 61 | 2026-10-18 | zenei állapotjegyzet a Video-projektban |
| `write` | 17 | 2026-10-18 | előadónév-egységesítő a Video-projektban |

**Mit jelentenek pontosan — és mit nem:**

- **Nem** adnak teljes hozzáférést minden híváshoz. Csak akkor lépnek életbe, ha az
  ügynök a hívásban **kifejezetten eszkalációt kér** (`sandbox_permissions:
  danger-full-access` + indoklás). A normál hívások továbbra is sandboxban futnak.
- Amikor viszont életbe lépnek, **nincs emberi ellenőrzés**: csak a `dsh-rule-guard`
  szabályai (lomtár, név szerinti folyamatölés tiltása) és a napló
  (`approvals.json` `log[]`, `event: "auto-allowed"`).
- Az `edit`/`write` szabály **nincs útvonalhoz kötve** → bármely fájlra érvényes.
  Ez a három közül a legszélesebb, és ez a legkönnyebben szűkíthető.

**Négy reális lehetőség:**

| Opció | Mit jelent | Költség |
|---|---|---|
| **(a) Marad mind a három** (ma) | nulla súrlódás, a napló adja az auditot | 0 |
| **(b) Útvonalhoz kötés** az `edit`/`write` szabályokon (`pathScope` + `pathKind`, pl. `C:\Szerver\Video`) | a szabály csak a megadott mappában enged — a fájl-formátum és az illesztő már támogatja, a panel kártyáján a „Mappa:" hatókörrel beállítható | ~10 perc/fájl; ellenőrzés: `node tools/check-approvals.mjs` |
| **(c) Parancs-előtag whitelist** a `pwsh`-ra (csak `git push`, `ssh`, `node tools\`, `msedge` …) | szűkebb, de az illesztőt fejleszteni kell, és törékeny (útvonalak, idézőjelek, burkoló szkriptek) | ~1 nap fejlesztés |
| **(d) A szabályok törlése + kattintás hívásonként** | a legbiztonságosabb: minden rendkívüli helyzetben az ember dönt | 0, de a Sáv 1–2 előtt napi több kattintás |

**A felhasználó döntése (2026-11-26): (a)** — mind a három szabály marad,
változatlanul. A `pivot` a valós használat: az eszkaláció ma is kérés nélkül megy,
és a napló (`state\approvals.json` `log[]`) adja az auditot. A (b) szűkítés nem
lép életbe, a `state\approvals.json` érintetlen. Ha a Sáv 1–3 elkészülte után az
eszkalációk száma hetente ~0-ra esik, ez a döntés bármikor felülvizsgálható — a
dokumentum ezt a pontot jelöli meg rá.

---

## 6. Elfogadási kritériumok

A terv **akkor kész**, ha mindegyik mérhetően teljesül:

1. `node tools/sandbox-doctor.mjs` → **minden sor `ok`** (a 18 mért sorból a
   schannel/Edge/node-pipe sorok helyes **alternatívát** jelölnek, nem hibát).
2. **Új munkamenetben**, nulla jóváhagyási kéréssel:
   `git push` egy SSH-s repóra, `git fetch` egy HTTPS-s repóra,
   `web_fetch https://api.github.com/zen`, és egy `browser shot` a saját felületről.
   *Részlegesen mért (2026-11-26): `git push --dry-run` SSH-n a sandboxban **igen**,
   `git ls-remote` HTTPS-en (openssl backenddel) **igen**, `web_fetch` **igen**; a
   `browser shot` a Sáv 2 után teljesül.*
3. 7 nap alatt a `state/sandbox-sentinel.log`-ban **0 nem osztályozott** sandbox-hiba.
4. Nincs új látható ablak és nincs automatikus harness-újraindítás (AGENTS.md 1., 1.5).
5. `node tools/check-plugin.mjs`, `node tools/check-docs-bilingual.mjs`,
   `node tools/check-rule-guard.mjs` zöld; a Sáv 1–2 tesztjei zöldek.

---

## 7. Fájlok és becslés

| Sáv | Fájlok | Becslés |
|---|---|---|
| 0 | új `tools/git-sandbox-config.mjs`; `~/.gitconfig` (2 kulcs), user env `GIT_SSH`, 6× `git remote set-url` | 30 perc |
| 1 | új `plugins/dsh-sandbox-sentinel/` (`package.json`, `lib/index.js`, `lib/fingerprints.js`, `test/fingerprints.test.mjs`, `install.ps1`, `README.md`) | 2–3 óra |
| 2 | új `plugins/dsh-browser/` (host route + agent tool + CDP motor), 1 új `tools/browser-doctor.mjs` | ~fél nap |
| 3 | új `tools/sandbox-doctor.mjs`; `AGENTS.md` 5. pont; `plugins/dsh-rule-guard/policy.json`; `docs/DSH-UPSTREAM-ISSUE.md`; ez a dokumentum + EN tükör | 1–2 óra |

**Sorrend:** 0 → 3/doctor → 1 → 2. A 0. sáv önmagában megszünteti az SSH és a
GitHub panaszokat; az 1. sáv szünteti meg azt, hogy **bármi** csendben elakadjon;
a 2. sáv a böngészőt adja vissza.

---

## 8. Kockázatok és visszaállás

- **`http.sslBackend=openssl`** hatással van a **user** saját git-jára is (nem csak
  a sandboxra). Mért: a nyilvános HTTPS működik vele; kockázat: egyedi
  `http.sslCAInfo` beállítás esetén a tanúsítványlánc más. Visszaállás:
  `git config --global --unset http.sslBackend`.
- **`GIT_SSH` user env var** minden git-hívást érint (a felhasználóét is).
  Visszaállás: a változó törlése. Mellette a `core.sshCommand` **nem** maradhat
  beállítva, mert az elsőbbséget élvez és ismét `sh`-be fut.
- **Remote átállítás (D1)** visszafordítható; a régi URL a cikkben dokumentálva.
- **A sentinel** csak **hozzáfűz** a tool-eredményhez; nem nyeli el és nem írja át
  a valódi hibát. Ha a plugin hibára fut, **nem jelöl** (fail-open a jelölésre,
  a bootot nem állítja meg), és a naplóba ír.
- **A `dsh-browser`** a host processzben fut: ez nagyobb jog, ezért (a) csak
  headless, (b) loopback-first (D3), (c) job-alapú leállítás, (d) a
  `dsh-rule-guard` szabálya fogja.
- **Érvénybe lépés:** a 0. sáv azonnal (per-call env) / a következő
  harness-indítástól (user env); a Sáv 1–2 hoszt-plugInjai a **következő
  harness-indításnál** (§1.5 — a futó Harness-t nem indítjuk újra).

---

## Függelék A — a mérés parancsai

```powershell
# 1) HTTPS: node (OpenSSL) vs schannel
node -e "fetch('https://api.github.com/zen',{signal:AbortSignal.timeout(12000)}).then(r=>r.text()).then(t=>console.log('OK',t)).catch(e=>console.log('ERR',e.message))"
Invoke-WebRequest -Uri 'https://api.github.com/zen' -UseBasicParsing -TimeoutSec 12   # -> SSL could not be established
cmd /c "curl.exe -sS -m 10 -o NUL -w \"http=%{http_code}\" https://github.com > %TEMP%\curl.txt 2>&1"

# 2) git: schannel vs openssl, ssh vs héj
cmd /c "git ls-remote https://github.com/git/git.git HEAD > %TEMP%\g1.txt 2>&1"                      # SEC_E_NO_CREDENTIALS
cmd /c "git -c http.sslBackend=openssl ls-remote https://github.com/git/git.git HEAD > %TEMP%\g2.txt 2>&1"   # OK
cmd /c "set GIT_SSH=C:\Windows\System32\OpenSSH\ssh.exe&& git ls-remote git@github.com:svandor/Rescue.git > %TEMP%\g3.txt 2>&1"  # OK
cmd /c "git -c core.sshCommand=\"ssh -o BatchMode=yes\" ls-remote git@github.com:git/git.git HEAD > %TEMP%\g4.txt 2>&1"          # sh signal pipe

# 3) kimenet-elfogás: pipe vs cmd-átirányítás
$bad = git --version                 # Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied
cmd /c "git --version > %TEMP%\g5.txt 2>&1"; Get-Content %TEMP%\g5.txt   # OK

# 4) böngésző és node-gyermek
cmd /c "\"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe\" --headless=new --dump-dom https://example.com > %TEMP%\edge.txt 2>&1"
node -e "const{execSync}=require('child_process');try{execSync('git --version')}catch(e){console.log('ERR',e.code)}"

# 5) eszkaláció (állandó jóváhagyási szabállyal — kérdés nélkül)
#    a pwsh tool `sandbox_permissions: danger-full-access` + `justification` mezővel:
curl.exe -sS -o NUL -w "http=%{http_code}" --max-time 12 https://github.com

# 6) kapcsolódás és eszköztár
node -e "fetch('http://127.0.0.1:3080/').then(r=>console.log('loopback',r.status))"
cmd /c "gh auth status > %TEMP%\gh.txt 2>&1"; Get-Content %TEMP%\gh.txt
```
