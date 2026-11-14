# Herd-kiváltás — terv és mért kiinduló állapot

> English mirror: [`DSH-HERD-KIVALTAS.en.md`](DSH-HERD-KIVALTAS.en.md)

Ez a dokumentum a `D:\Szerver\Vector\DSH-atadas-herd-kivaltas.md` átadás
feldolgozása: a követelményt **végrehajtható tervre** bontja, a mért
kiinduló állapottal, a sorrenddel és az elfogadási kritériumok mérési
módjával. A munka a DSH repóban folyik; a Herd addig marad, amíg az
5 kritérium nem teljesül.

---

## 1. Mért kiinduló állapot (2026-11-14, ezen a gépen)

| Elem | Mért érték |
|---|---|
| Herd folyamatok | 5 × `Herd.exe`, 1 × `HerdHelper`, **25 × `nginx.exe`**, **5 × `php-cgi.exe`** |
| 80/443 | `127.0.0.1:80` több nginx-példány által foglalt (TLS a 443-on) |
| hosts | Herd által írt `.test` sorok: `database.herd.test`, `herd-studio.test`, `jelentkezes-redirect.test`, `termeszetgyogyaszoktatas-l12.test`, valamint egy hashelt aldomain (`3aa9ca55…`) |
| PHP | **`C:\Users\info\.config\herd\bin\php.bat` → PHP 8.4.27** (NTS, VC++ 2022 x64) |
| Composer | `C:\Users\info\.config\herd\bin\composer.bat` (**szintén Herd alól**) |
| Caddy / mkcert / nginx a PATH-ban | **nincs** |
| Node / npm | `C:\Program Files\nodejs\node.exe`, `npm.ps1` |
| Projekt | `D:\Herd\termeszetgyogyaszoktatas-L12`: `artisan`, `public/index.php`, `.env` megvan, **`.dsh\dev.yaml` nincs** |

### 1.1 Ez a legfontosabb megállapítás: a PHP a Herdé

Az átadás „a rendszer PHP-ját használja" mondata ezen a gépen **nem
teljesül**: nincs rendszer-PHP, a `php` és a `composer` is a Herd
`bin` könyvtárából jön. Ha a Herd autostartja kikerül (vagy a Herd
eltávolításra kerül), a projekt **nem indul el** — a PHP-nek önállóan kell
települnie. Ez a migráció **előfeltétele**, nem utólagos szépítés.

---

## 2. Követelmény → megvalósítás

### 2.1 Projektprofil: `.dsh\dev.yaml`

A projekt gyökerében, a következő kulcsokkal (a spec és a valóság egyesítve):

```yaml
domain: termeszetgyogyaszoktatas-l12.test
docroot: public
php: "8.4"                  # a rendszeren elérhető PHP főverziója
server: caddy               # caddy | nginx | artisan-serve
vite: true                  # a frontend dev szerver is induljon
port: 8443                  # amíg a Herd él, NEM a 443 (ütközés)
env:
  APP_ENV: local
hosts: true                 # a hosts-sor kezelését kérjük (emelt segédszkript)
```

### 2.2 Műveletek — a DSH job-kezelésén át

`dev_start` / `dev_stop` / `dev_status` / `dev_logs`. A követelmény szerint
ezek **nem külön daemon**, hanem a DSH job-rétegén mennek át, hogy a
`DSH-atadas.md` 3.A–B pontja (perzisztens ledger, recovered jobok)
automatikusan vonatkozzon rájuk. A megvalósítás tehát:
`plugins\dsh-devserver` (host-sík) regisztrál egy `dev_*` toolt, ami a
`ctx.jobs` szolgáltatáson indítja a folyamatokat — így a folyamat-őr
(`dsh-process-guard`) ledgerébe kerülnek, és restart után recovered jobként
jelennek meg.

### 2.3 HTTPS

| Mód | Mikor | Megjegyzés |
|---|---|---|
| `mkcert` + `caddy` | alapértelmezett | egyszeri `mkcert -install`, domainenként külön tanúsítvány |
| Caddy belső CA | ha nincs mkcert | a Caddy saját CA-ját a rendszer trust store-jába kell tenni |
| `artisan-serve` | fallback | HTTPS nélkül, a leggyorsabb indulás |

**Ütközés a Herddel:** a 443-at a Herd nginx-e tartja. Ezért a migráció
első szakaszában a DSH **másik porton** (pl. `8443`) szolgál, és csak a
Herd leállítása után kerül a 443-ra.

### 2.4 Hosts

A hosts fájl írása emelt szintet igényel. Terv:
1. `tools\dev-hosts.ps1 -Add|-Remove` — **emelt** futású segédszkript,
   amely csak a projekt domainjeit írja, és minden hozzáadott sort
   nyilvántart (`.dsh\hosts-added.json`: sor, időpont, projekt).
2. `dev_stop --purge` / uninstall → a nyilvántartás alapján **csak a saját
   sorok** törlődnek (a Herd soraihoz nem nyúlunk, amíg a Herd él).
3. A `dev_status` kimondja, hogy a projekt domainje szerepel-e a hosts
   fájlban (olvasás, nem írás).

### 2.5 Ütközés- és dupla-indítás védelem

- Indulás előtt: a kért port(ok) foglaltságának ellenőrzése
  (`Get-NetTCPConnection` / `netstat`), beszédes hiba vagy portváltás.
- Egy projektre **egy** futás: a DSH job-réteg + a projekt `.dsh\run.json`
  nyilvántartása (pid + indítási idő) tiltja a másodikat — ugyanaz az elv,
  mint a `tools\start-harness-once.ps1` mutexe és a tray
  `EnsureHarness()`-e esetében.

---

## 3. Elfogadási kritériumok — hogyan mérjük

| # | Kritérium | Mérés |
|---|---|---|
| 1 | tiszta boot után `dev_start` → `https://<projekt>.test` Laravel-válasz, érvényes helyi CA-s tanúsítvánnyal | `curl -sS -o NUL -w "%{http_code}" https://…` + `openssl s_client`/`Invoke-WebRequest` tanúsítványlánc-ellenőrzés; elvárt 200 és `Laravel` a válaszban |
| 2 | `dev_stop` után nincs maradék nginx/php-cgi/node | `tools\dsh-orphans.ps1` üres lista; a projekt portjai szabadok |
| 3 | DSH-restart után a dev szerver recovered jobként látszik és leállítható | a `dev_status` a restart után is PID-et ad; `dev_stop` leállítja |
| 4 | a hosts csak a projekt sorait tartalmazza, uninstallkor eltűnik | a hosts diff a `.dsh\hosts-added.json`-hoz; `-Remove` után 0 saját sor |
| 5 | a Herd kikapcsolása után is működik | Herd autostart kivétele + `Herd`/`HerdHelper` leállítása után az 1. kritérium megismétlése |

---

## 4. Sorrend (mi történik most)

1. **Előfeltétel — önálló PHP a D: meghajtón, verzióválasztóval.** A Herd
   `bin` könyvtára helyett **minden új eszköz a D:-re** kerül (a C: nem
   szemetelődik, mert a Linux-telepítéshez üríteni kell):
   ```
   D:\Tools\php\8.4.27\        (NTS, x64, a Herd-től független)
   D:\Tools\php\current\        -> junction a kiválasztott verzióra
   D:\Tools\caddy\             (HTTPS, a Herd nélkül)
   D:\Tools\mkcert\            (helyi CA + tanúsítványok)
   ```
   A **verzióválasztó** (`tools\php-version.ps1 -List|-Use 8.4`) a `current`
   junctiont állítja át, a `.dsh\dev.yaml` `php:` kulcsa pedig a főverziót
   kéri — így a projekt a maga PHP-ját kapja, nem a Herdét.
   **Amíg ez nincs meg, a 2. és 5. kritérium nem teljesíthető.**
2. **`tools\dev.ps1 status`** — KÉSZ. Kockázatmentes szelet: profil, portok,
   hosts-sor, futó folyamatok, DB-port. Semmit nem indít.
3. **`dev_start` + `artisan-serve`** — a legegyszerűbb indulás (HTTPS nélkül),
   hogy a lánc mérhető legyen.
4. **Caddy + mkcert** a `8443`-on, a Herd mellett; az 1. kritérium mérése.
5. **Job-integráció** (`plugins\dsh-devserver`), hogy a restart utáni
   recovered job (3. kritérium) működjön.
6. **Hosts-kezelés** emelt segédszkripttel (4. kritérium).
7. **Adatbázis — DBngin integráció (nem új adatbázis-kezelő).** A DBngin adja
   a MySQL-t (mért: `dbngin-go` + 2 `mysqld`, `0.0.0.0:3306`). A DSH ezt
   **felismeri és kiszolgálja**, nem telepít helyette mást:
   - `dev_status` kimondja, hogy a 3306 figyel-e, és melyik PID tartja;
   - a `dev_start` a projekt `.env`-jében ellenőrzi a `DB_HOST/DB_PORT`
     egyezést (írni csak kifejezett `--fix-env` kapcsolóval ír);
   - `dev_logs` a MySQL-t **nem** naplózza (az a DBngin dolga); csak az
     alkalmazás `storage\logs\laravel.log`-ját.
8. **Herd kivétele** csak az 1–5 teljesülése után (5. kritérium), a
   `HKCU\...\Run\de.beyondco.herd` érték törlésével.

---

## 5. Vezérelv: faék egyszerűség

A cél egy **minimalista Laravel fejlesztői környezet** — nem termék, nem
szolgáltatás-ajánlat. Ezért:

- **Csak az van benne, ami muszáj:** egy profil (`.dsh\dev.yaml`), egy
  parancs (`tools\dev.ps1`), PHP + Caddy + mkcert. Nincs plugin-marketplace,
  nincs bejelentkezés, nincs telemetria, nincs upsell.
- **Semmit nem telepít magától**: minden hiányzó eszközre érthető hiba és a
  telepítési hely (D:) mondja meg, mit kell tenni.
- **Nem ír olyat, amihez nincs joga**: hosts/port/tanúsítvány csak kifejezett
  művelettel, és minden írás naplózva, visszavehetően.
- **Nem kezel mást, mint a dev szervert**: az adatbázist (DBngin), a Node-ot
  és a Composer-t használja, nem helyettesíti.

Az átadási spec „nem PHP-verziókezelő" pontja a felhasználói döntés szerint
**nem érvényes**: kell verziókövető és -választó (2.1/4. pont), mert a Herd
eltávolítása után a projektnek a saját PHP-verzióját kell megkapnia.
