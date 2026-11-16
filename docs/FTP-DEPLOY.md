# FTP deploy — használat

A `dsh-ftp-deploy` plugin git-diff alapú FTP-feltöltést ad a Git panel mellé: a
tárhelyre csak a **változás** megy fel (a törlések is lekövetve), a jelszó pedig
Windows DPAPI-val titkosítva, a gépen marad.

- **Fül:** jobb oldalsáv → „FTP deploy" (vagy a fejléc `⤴ FTP` ikonja).
- **Gyorsgomb:** Git panel → `FTP deploy` a `Kiadás` gomb **előtt** (ha a
  munkaterülethez nincs profil, a gomb `FTP beállítás` felirattal az FTP fület
  nyitja meg).
- **Motor:** a Felpuffantó 0.1.5 (`basic-ftp` + `yazl`) portja, ugyanazzal a
  viselkedéssel: 3 próbálkozás `[3 s, 8 s]` csak átmeneti hibára, fázisos
  hibaszöveg a távoli IP-vel, `RemoteDirIndex` (nincs MKD-spam), ZIP-mentés.

## 1. Első használat egy projektnél

1. **Profil felvétele** — FTP fül → `Új profil`: azonosító, megnevezés, host,
   port, FTP-felhasználó, helyi gyökér (a projekt mappája), távoli gyökér
   (pl. `/web/laravel12`), mappák (vesszővel: `app, config, resources, …`).
   A /web csak tisztán átirányító profilnál (`​.htaccess`, `index.php`) engedett.
2. **Jelszó** — FTP fül → `Jelszó mentése` (DPAPI, `CurrentUser`; a felület
   később csak azt mutatja, hogy van).
3. **Kiindulópont** — ha a tárhelyen már ott a projekt, előbb
   `A mostani git állapot már fent van` gomb: ez állítja be a `lastDeploySha`
   baseline-t. E nélkül a deploy a **teljes fát** feltöltené.
4. **Előnézet** — `Előnézet`: feltöltendő/törlendő fájlok, méret, kizárt fájlok.
5. **Deploy** — `FTP deploy`. 80 fájl fölött második kattintás kér
   („Biztosan? 128 fájl, 24,3 MB").

## 2. Mit tölt fel

- a `lastDeploySha` **óta** commitolt, staged és unstaged változásokat,
- a nem követett (untracked) fájlokat,
- a profil `extraUpload` mappáit (gitignore-olt seedek, pl. `storage/...`),
- a törölt fájlokat **le is törli** a tárhelyről (`DEL`, az „550 nincs fent”
  válasz nem hiba).

**Soha nem megy fel:** `.env*`, `storage/*`, `vendor/*`, `node_modules/*`,
`.git/*`, `bootstrap/cache/*`, `public/hot`, `public/.user.ini`, `phpinfo.php`,
`rr(.exe)` — kivéve a profil `allow` listáján szereplő prefixeket (a beépített
Laravel-kivételek: média-könyvtár, dokumentum-előnézetek, Számlázz-inbox, …).

## 3. Mentés („Lepuffantás")

`Mentés` szekció: `csak kód` (a profil mappái szerint) vagy `teljes` (a teljes
távoli gyökér) → helyi ZIP a `state\ftp-backups` mappába, egyedi névvel (soha nem
ír felül). A letöltés streamelt, a félkész ZIP hiba esetén törlődik.

## 4. Parancssor (ugyanaz a motor)

```
tools\ftp-deploy.cmd profiles
tools\ftp-deploy.cmd preview  --profile TGYO-L12
tools\ftp-deploy.cmd baseline --profile TGYO-L12
tools\ftp-deploy.cmd test     --profile TGYO-L12
tools\ftp-deploy.cmd push     --profile TGYO-L12 --confirm
tools\ftp-deploy.cmd remote   --profile TGYO-L12 --path /web/laravel12
tools\ftp-deploy.cmd backup   --profile TGYO-L12 --mode code
tools\ftp-deploy.cmd log --lines 40
```

A kimenet JSON; a jelszó soha nem jelenik meg. Jelszó beírása:
`echo JELSZO | node tools\ftp-deploy.mjs set-password --profile <id>`
(a jelszó a **stdin-en** jön, nem parancssori argumentumban).

## 5. Hol vannak az adatok

| Fájl | Tartalom |
|---|---|
| `state\ftp-profiles.json` | profilok (`lastDeploySha` baseline-nal) |
| `state\ftp-secrets\<id>.dpapi` | DPAPI-jelszó (a bejelentkezett felhasználóhoz kötve) |
| `state\ftp-deploy-status.json` | a futó/utolsó művelet állapota (a panel ezt pollozza) |
| `state\ftp-deploy-log.txt` | napló (`connect`/`mkdir`/`upload`/`delete`, 2 MB fölött rotál) |
| `state\ftp-backups\` | a ZIP-mentések |

A `state\` gitignore-olt: a profilok, a napló és a titkosított jelszavak **nem**
kerülnek a repóba.

## 6. Hibák olvasása

A hibaüzenet szándékosan „hibajegy-kompatibilis":

```
Feltöltés megszakadt — fázis: távoli mappa ellenőrzése · fw.elin.hu:2141 ·
user=web… · távoli IP=… · 2/3 próbálkozás — 550 Can't create directory
```

- `530` = jelszó/fiók hiba (nem próbálja újra),
- `550/552/553` = jogosultság/kvóta/név (nem próbálja újra),
- `ECONNRESET`/`timeout`/`421` = átmeneti (legfeljebb 3 próba, `[3 s, 8 s]`).

## 7. Beágyazott függőségek

A `vendor\node_modules` alatt utazik a repóval: `basic-ftp` 5.3.1, `yazl` 3.3.1,
`buffer-crc32` 1.0.0 (mind MIT). Így nincs `npm install` a felhasználónál, és a
telepítő offline is működik. Frissítés: a három csomag `dist`/`*.js` fájljainak és
`package.json`-jának cseréje, majd:

```
node --test plugins\dsh-ftp-deploy\test\*.test.mjs
```

## 8. Érvénybe lépés

- **Host** végpontok (`/ftp/*`): a harness következő indulásánál (a plugin a
  `~\.dsh\profiles\web\cordis.patch.yml` `- insert:` bejegyzésével töltődik).
- **Kliens** (fül + gomb): panel-újratöltés (a bundle kiszolgálása kérésre megy).
- Ellenőrzés: `pwsh -NoProfile -File plugins\dsh-ftp-deploy\install.ps1 -Check`.
