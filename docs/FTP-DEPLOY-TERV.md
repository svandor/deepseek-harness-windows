# FTP deploy — panel + gyorsgomb (TERV)

Állapot: **terv, jóváhagyásra vár** (2026-11-16). Kiindulás: a `D:\Szerver\Felpuffanto`
projekt **működő, élesben használt** FTP-motorja (0.1.5, commit `bcf25fd`
„Ship Felpuffanto 0.1.5: FTP push retry, phase logging, MLSD dir check").

A cél két dolog, ebben a sorrendben:

1. **önálló FTP panel** a jobb oldalsávban (profil, előnézet, deploy, biztonsági
   mentés, távoli mappa, napló),
2. ha ez teljesen kész: **`FTP deploy` gyorsgomb a Git panel akciósorában, a
   `Kiadás` gomb ELŐTT**.

---

## 1. Kiindulás: mit emelünk át a Felpuffantóból

A motor tiszta Node/ESM, hálózat nélkül is tesztelhető darabokra vágva. A
fájlok:

| Felpuffantó fájl | Méret | Szerep | Átemelés |
|---|---|---|---|
| `src\engine\ftp.ts` | 14,5 KB | FTP kliens: feltöltés, törlés, ZIP-mentés, mappa-lista, hibaszöveg | **egy az egyben** (`lib\engine\ftp.js`) |
| `src\engine\gitdiff.ts` | 5,2 KB | előnézet: `git diff lastDeploy..HEAD` + staged + unstaged + untracked | **igen**, `simple-git` helyett a host `run("git", …)` helperével |
| `src\engine\tree.ts` | 4,0 KB | gitignore-olt (storage) fák bejárása az „extra" feltöltéshez | **igen** |
| `src\engine\deny.ts` | 4,2 KB | tiltó/engedélyező minták, `remoteRoot` és `localRoot` őrök | **igen**, profil-szintű kiegészítéssel |
| `src\engine\remoteDirs.ts` | 5,2 KB | `RemoteDirIndex`: MLSD-alapú mappaellenőrzés (MKD-spam nélkül) | **igen** |
| `src\engine\profiles.ts` | 2,6 KB | profil-tár (`profiles.json`), `lastDeploySha` | **igen**, DSH `state\` alá |
| `src\engine\secrets.ts` | 2,3 KB | jelszó: Windows **DPAPI** (CurrentUser), PowerShell-en át | **igen** |
| `src\engine\paths.ts` | 0,9 KB | `%APPDATA%\Felpuffanto` útvonalak | helyette `state\ftp-*` |
| `src\engine\log.ts` | 0,5 KB | napi naplófájl | helyette `state\ftp-deploy-log.txt` (rotál) |
| `src\engine\index.ts` | 7,0 KB | vezérlés: preview / baseline / push / push-extra / test / list / backup | **igen** |
| `src\presets\l12.ts` | 1,6 KB | L12 preset (Laravel include-lista) | **igen**, első valódi célpont |
| `src\cli.ts` | 4,7 KB | CLI (JSON kimenet) — a „CLI = UI" elv | **igen**, `tools\ftp-deploy.cmd` |

Függőségek (a Felpuffantóban már telepítve, mért verziók): **`basic-ftp` 5.3.1**,
**`yazl` 3.3.1** (`simple-git` 3.36.0 nem kell — git a hostból megy).

### A motor azon mért tulajdonságai, amiket meg kell tartani

- **3 próbálkozás**, növekvő várakozással `[3 s, 8 s]`; csak **átmeneti** hibánál
  (ECONNRESET/timeout/4xx) — a tartós FTP-kódok (`530`, `550`, `552`, `553`)
  azonnal megállnak. Ez pontosan megfelel az AGENTS §1.7 kötelező mintájának.
- **Fázis-naplózás** (`connect` → `mkdir` → `upload` → `delete`) és emberi
  hibaüzenet a **távoli IP-vel** — a tárhely-szolgáltató hibajegyéhez kellett.
- **`RemoteDirIndex`**: mappa-listával ellenőriz, csak a hiányzó szintre küld
  `MKD`-t. Mért ok: a `basic-ftp` `ensureDir()` vakon MKD-zott, egy 12 fájlos
  push **~84 `550 Can't create directory`** sort tett a tárhely naplójába, amit a
  szolgáltató klienshibának nézett.
- **ZIP-mentés („Lepuffantás")** streamelve (`yazl`), egyedi fájlnévvel — soha
  nem ír felül, hiba esetén törli a félkész ZIP-et.
- **Nagy push védelme**: `LARGE_FILE_LIMIT = 80` fájl, efelett külön
  `--force-large` (a UI-ban: második, megerősítő kattintás).
- **Jelszó**: DPAPI `CurrentUser`, PowerShell `ProtectedData.Protect/Unprotect`,
  a naplóba és a válaszba **soha** nem kerül (a séma sem tartalmazza).
- **`lastDeploySha` baseline**: az első deploy előtt be kell állítani („ami most
  fent van = a mostani git állapot"); utána csak a változások mennek fel, és a
  törlések is lekövethetők (`action: "delete"`).

---

## 2. Amit a DSH-ba építünk

Új plugin: **`plugins\dsh-ftp-deploy\`** (a `dsh-devadmin` mintájára: host + kliens
egy csomagban, junction + `- insert:` a profil-patchbe).

```
plugins\dsh-ftp-deploy\
  package.json            # name dsh-ftp-deploy, type module, dsh.client.platform: web,
                          # deps: basic-ftp ^5.3.1, yazl ^3.3.1 (a plugin saját node_modules-a)
  install.ps1             # -Check / -Remove / telepítés (junction + patch), a devadmin mintája
  lib\index.js            # HOST: /ftp/* végpontok + a futtató (runner)
  lib\client.js           # KLIENS: FTP panel + fejléc-ikon
  lib\engine\ftp.js       # a felpuffantós ftp.ts portja
  lib\engine\gitdiff.js   # előnézet (host `run()`-nal, nem simple-git)
  lib\engine\tree.js      # storage/extra fa-bejárás
  lib\engine\deny.js      # tiltó/engedélyező minták + remoteRoot őrök
  lib\engine\remoteDirs.js# RemoteDirIndex
  lib\engine\profiles.js  # state\ftp-profiles.json
  lib\engine\secrets.js   # DPAPI (state\ftp-secrets\<id>.dpapi)
  lib\engine\runner.js    # egyidejű deploy zár + állapotfájl + napló
  test\*.test.mjs         # node --test, hálózat nélkül (l. 6. pont)
tools\ftp-deploy.cmd      # CLI paritás (CLI = UI), ugyanazt a motort hívja
docs\FTP-DEPLOY.md        # használat (HU)
```

### Host-végpontok (mind a host oldalon fut, a böngésző nem lát titkot)

| Végpont | Mit tesz |
|---|---|
| `GET /ftp/profiles` | profilok (host, port, user, remoteRoot, include, `lastDeploySha`, **van-e mentett jelszó**) |
| `POST /ftp/profile` | profil mentése (a `deny.ts` őrei: `assertLocalRoot`, `assertRemoteRoot`) |
| `POST /ftp/secret` | jelszó mentése DPAPI-val / törlése — a válasz csak `{ok, saved}` |
| `GET /ftp/test?id=` | kapcsolat + `PWD` (csak olvas) |
| `GET /ftp/preview?id=` | git-diff előnézet: feltöltendő/törlendő fájlok, `blocked`, méret |
| `GET /ftp/preview-extra?id=` | a gitignore-olt `extraUpload` fák előnézete |
| `POST /ftp/baseline?id=` | „a mostani HEAD = már fent van" |
| `POST /ftp/push?id=&confirm=&forceLarge=` | deploy indítása (202 + `state\ftp-deploy-status.json`) |
| `GET /ftp/status` | a futó deploy állapota (fázis, kész/összes, bájt, aktuális fájl, hiba) + napló-tail |
| `POST /ftp/backup?id=&dest=&mode=full\|code` | éles tartalom mentése helyi ZIP-be |
| `GET /ftp/remote?id=&path=/` | távoli mappák listája (böngészőhöz, útvonal-ellenőrzéshez) |
| `GET /ftp/log` | a deploy-napló vége |

A hosszú művelet (push/backup) **a host folyamatában** fut, nem külön
gyerekfolyamatként: így **nem jön létre semmilyen konzolablak** (AGENTS §1), és a
panel ugyanúgy pollozza (`2 s`), mint a Kiadás gomb állapotát. Egyszerre **egy**
deploy futhat (zárfájl + memóriabeli zár), a másodikat a host elutasítja.

### Tárolás (minden a munkaterület `state\` alatt, ami gitignore-olt)

| Fájl | Tartalom |
|---|---|
| `state\ftp-profiles.json` | profilok (`state\` gitignore-olt → a repóba nem kerül) |
| `state\ftp-secrets\<id>.dpapi` | DPAPI-val titkosított FTP-jelszó (CurrentUser) |
| `state\ftp-deploy-status.json` | futó/kész/hibás állapot a panelnek (mint `release-status.json`) |
| `state\ftp-deploy-log.txt` | napló (2 MB fölött rotál, mint a `release-log.txt`) |

**Az induló profilok importja:** a Felpuffantó `%APPDATA%\Felpuffanto\profiles.json`
és `secrets\*.dpapi` **átemelhető** (ugyanaz a felhasználó, ugyanaz a DPAPI-scope),
tehát nem kell újra begépelni sem jelszót, sem profilt. A mért készlet:

| id | host:port | remoteRoot | baseline (`lastDeploySha`) | jelszó |
|---|---|---|---|---|
| `TGYO-L12` | `fw.elin.hu:2141` | `/web/laravel12` | `c04fe33…` | van |
| `jelentkezes-redirect` | `fw.elin.hu:2129` | `/web/public` | `45d4bf9…` | van |
| `atoktatas-redirect` | `fw.elin.hu:2141` | `/web` | `478de8d…` | van |

(A felhasználónevek szándékosan nem kerülnek a dokumentumba; a repó nyilvános, és
a titok-audit a `state\`-et nem vizsgálja, mert gitignore-olt.)

---

## 3. Kliens: az FTP panel

A jobb oldalsávban, a `devadmin` mintájára (mért minta: `plugins\dsh-devadmin\lib\client.js:770-821`):

- `ctx.sidebarRightTabs.register({ id: "dsh-ftp-deploy/ftp", kind: "ftp", priority: "extension", title: () => "FTP", guide: [...] })`
- `ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-ftp-deploy/ftp" }, FtpPanel)`
- fejléc-ikon: `conversation.session.header.utilities`, `id: "ftp-header"`, `order: 62`
  (a devadmin 60/61 után), kattintásra `ctx.sidebarRight.openTab("ftp")`

A panel felülről lefelé:

1. **Profil** — választó + a profil összefoglalója (host:port, remoteRoot, include
   chipek), „Kapcsolat tesztelése", jelszó mező (mentés DPAPI-val; a meglévő
   jelszót nem mutatja, csak azt hogy van).
2. **Előnézet** — `preview`: feltöltés/törlés sorok (`origin`: committed /
   unstaged / untracked / extra), méret, összes bájt; a `blocked` fájlok külön
   szekcióban, magyar indoklással (tiltó minta). Ha nincs baseline:
   „Első beállítás: ami most fent van = a mostani git állapot" gomb.
3. **Deploy** — `FTP deploy` gomb (a nagy push 80 fájl fölött második
   megerősítést kér: „Biztosan? 128 fájl, 24,3 MB"), futás közben
   `⏳ 12/48 — resources/views/x.blade.php` sor + haladássáv; a végén
   `✔ feltöltve 48, törölve 3, 24,3 MB (2. próbálkozás)` vagy a fázisos hiba.
4. **Extra feltöltés** (gitignore-olt fák, pl. `storage/...` seed) — ugyanaz a
   folyamat, külön gombbal, külön számlálóval.
5. **Távoli mappa** — `listRemote`: tallózás (az új remoteRoot ellenőrzéséhez).
6. **Mentés (Lepuffantás)** — `backup` `full` / `code` hatókörrel, célmappa
   választóval; az eredmény a ZIP útvonala + fájl/db szám.
7. **Napló** — a `state\ftp-deploy-log.txt` utolsó sorai (összecsukható).

Minden felirat `ctx.locale.register("ftp", { hu: {...}, en: {...} })` alatt, a
`dsh-ui-extras` kulcs-nevezését követve.

---

## 4. Kliens: a gyorsgomb a Git panelben

A Git panel akciósora (`plugins\dsh-ui-extras\lib\client.js`, a `Push` és a
`Kiadás` gomb között, ~5181–5215. sor) kap egy új gombot:

```
[ Commit ] [ Push ] [ FTP deploy ] [ Kiadás ]
```

Viselkedés (a mérés szerint ez a hasznos):

- **Van profil ehhez a munkaterülethez** (a profil `localRoot`-ja kanonikusan
  egyezik a panel munkaterületével): a gomb felirata `FTP deploy`, kattintásra
  `/ftp/preview` → ha van feltöltendő fájl, `/ftp/push` indul (a panelen kívül is
  látszik a haladás a Git panelben, ugyanúgy, mint a Kiadás gombé), a végén
  „✔ 12 fájl, 3,4 MB".
- **Nincs profil**: a gomb felirata `FTP beállítás`, és az FTP fület nyitja meg
  (`ctx.sidebarRight.openTab("ftp")` — a `dsh-ui-extras` kliens már injectálja a
  `sidebarRight`-ot, mért: `client.js:9747`).
- **Fut egy deploy**: inaktív, „FTP fut…" felirattal; a host is elutasítja a
  másodikat (ugyanaz a védvonal, mint a Kiadás gombon).

A gomb **a Kiadás előtt** áll, mert a tipikus sorrend: feltöltés a tárhelyre →
aztán (ha kell) új telepítő-kiadás.

---

## 5. Biztonsági szabályok (kötelezők, a motorral együtt jönnek)

- **Tiltó minták** (nem megy fel soha): `.env*`, `storage/*`, `vendor/*`,
  `node_modules/*`, `.git/*`, `bootstrap/cache/*`, `public/hot`,
  `public/.user.ini`, `phpinfo.php`, `rr(.exe)`.
- **Engedélyező kivételek** (a tiltás alól): profil-szintű `allow` lista (a
  Felpuffantóban ez vitte fel a média-könyvtárat és a dokumentum-előnézeteket) —
  a DSH-ban profil-mező, nem kódba égetett Laravel-lista. A `laravel` preset
  hozza a felpuffantós alapértéket.
- **`remoteRoot` őr**: nem lehet üres/`/`; `/web` csak tisztán átirányító profilnál
  (`.htaccess` + `index.php`); tiltott távoli szegmensek (`elearning*`, `magazin`,
  `dok`).
- **Biztonságos relatív útvonalak**: nincs `..`, nincs abszolút kezdés.
- **Nagy push**: 80 fájl felett megerősítés; a `forceLarge` csak a megerősítő
  kattintás után megy a hostra.
- **Titkok**: DPAPI, soha nem kerül naplóba/válaszba; a `state\` gitignore-olt.
- **Hálózat**: csak akkor indul, ha a felhasználó kattint; nincs időzített FTP.
- **Konzol**: a deploy a host folyamatában fut (nincs gyerekfolyamat) → §1 sértés
  kizárva; a `git` hívások a meglévő `run()` helperrel, `windowsHide`-dal.
- **Újrapróbálkozás**: 3 próba, `[3 s, 8 s]`, csak átmeneti hibára (§1.7).

---

## 6. Fázisok és az ellenőrzés minden fázisban

| # | Fázis | Kész, ha |
|---|---|---|
| 0 | Váz + `install.ps1` + `package.json` + engine-port | `node --check`, `install.ps1 -Check` zöld, a 3 profil importálva |
| 1 | Motor + tesztek (hálózat nélkül) | `node --test`: deny/allow, `remoteDirOf`/`RemoteDirIndex` (fake kliens), `parseNameStatus`, profil-tár (BOM-toleráns), DPAPI oda-vissza, hiba-osztályozás, ZIP-név egyedisége — mind zöld |
| 2 | Host végpontok + runner + CLI (`tools\ftp-deploy.cmd`) | élőben: `profiles`, `preview` (L12-re: hány fájl vár), `test` (kapcsolat OK), `remote` (mappa-lista), `status` (nincs futás), `backup` egy kis hatókörrel |
| 3 | Kliens panel (HU/EN) | a fül megnyílik, nincs `[ERROR]` a `state\ui-extras-client.log`-ban, a 6 szekció működik, a hosszú push haladása látszik |
| 4 | Gyorsgomb a Git panelben | a gomb a Kiadás előtt áll; profil nélkül az FTP fület nyitja; futás közben inaktív; a Kiadás gomb működése nem változik (regresszió-ellenőrzés) |
| 5 | Dokumentáció + AGENTS + kiadás | `docs\FTP-DEPLOY.md`, AGENTS „tizenegyedik kör", audit 0 találat, `node --check` mindenre |

Érvénybe lépés: a **host** plugin a harness következő indulásánál (§1.5 —
felhasználói engedély), a **kliens** fül panel-újratöltéssel. A panelek
munkaterület-függetlenek, ezért a `dsh-ui-extras` Git panel gombja akkor látszik,
ha a panel újratöltődik.

---

## 7. Amit NEM csinálunk (tudatosan)

- Nem lesz **ütemezett** FTP (nincs cron-szerű deploy) — csak kattintásra.
- Nem lesz **SFTP/SSH** ebben a körben (a `basic-ftp` plain FTP/FTPS; a tárhely
  a mért profilokon plain FTP, `tls: false`).
- Nem lesz **kétirányú szinkron**: lefelé csak a „Lepuffantás" ZIP-mentés megy.
- Nem emeljük át a Felpuffantó Tauri/UI rétegét (nincs rá szükség).
- Nem nyúlunk a `dsh-ui-extras` Kiadás-logikájához (csak egy gombot szúrunk be elé).

---

## 8. Nyitott döntés (1 kérdés)

**Mehet-e a megvalósítás a terv szerint?** A javasolt alapbeállítások:

1. **Profil-import** a Felpuffantóból (3 profil + DPAPI jelszavak) — így nincs
   újragépelés, és a mért baseline-ok (`lastDeploySha`) is megmaradnak.
2. **Gyorsgomb = azonnali deploy** (ha van profil és van mit feltölteni), a
   haladás a helyén; profil nélkül a gomb az FTP fület nyitja.
3. **Első éles próba** a `TGYO-L12` profilon, **előnézettel** (a baseline miatt
   várhatóan kevés vagy nulla fájl) — a tényleges feltöltés csak akkor indul, ha
   te rábökölsz.
