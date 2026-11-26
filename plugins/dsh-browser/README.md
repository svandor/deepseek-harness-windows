# dsh-browser — a `browser` tool (headless Edge a host processzben)

> English summary at the end of this file.

## Miért van ez a plugin

A Chromium a DSH sandboxában **szerkezetileg** nem tud elindulni: a
`mojo::platform_channel` és a crashpad névtelen csöveket (named pipe) nyit, a
`WRITE_RESTRICTED` token pedig ezekhez nem ad írási jogot. A mért tünet:

```
mojo\public\cpp\platform\platform_channel.cc:187: Check failed: A hozzáférés megtagadva. (0x5)
crashpad_client_win.cc:457: OpenProcess: A hozzáférés megtagadva. (0x5)
```

A sandboxot ezért **nem** nyitjuk ki (az a fájl-védelmet is elvenné), hanem a
böngészőt oda tesszük, ahol futni tud: a Harness **saját, nem sandboxolt
processzébe**, és a modell elé tool-ként.

Ez a repó bizonyított mintáját használja: `.test-dsh-home\probe-hero.mjs`
(nyers CDP + headless Edge, új függőség nélkül).

## Telepítés

```powershell
pwsh -NoProfile -File plugins\dsh-browser\install.ps1          # junction + preset bejegyzés
pwsh -NoProfile -File plugins\dsh-browser\install.ps1 -Check   # ellenőrzés
pwsh -NoProfile -File plugins\dsh-browser\install.ps1 -Remove  # visszavonás
```

A tool a **következő session-létrehozásakor** jelenik meg a modell eszközei
között (az agent-síkos preset session-indításkor töltődik). A telepítés a
`~\.dsh`-ba ír, ezért a sandboxon kívülről (jóváhagyással) kell futtatni.

## Műveletek

| `action` | Mit tesz | Fontos paraméterek |
|---|---|---|
| `open` | megnyit egy URL-t, bevárja a betöltést | `url`, `scope`, `profile`, `width`, `height` |
| `read` | az oldal szövege vagy egy elem tartalma | `selector`, `format` (text/html/value/attrs) |
| `click` | kattint (valódi egér-esemény a középpontra, `el.click()` tartalékkal) | `selector` |
| `type` | beír szöveget, `input`/`change` eseménnyel (React-kompatibilis) | `selector`, `text`, `enter` |
| `eval` | JS kifejezés az oldalon, JSON-eredménnyel | `expression` |
| `shot` | PNG képernyőkép | `path`, `full_page`, `selector` |
| `download` | letöltés — **jóváhagyáshoz kötve** | `url`, `filename`, `wait_ms` |
| `console` | a böngésző konzol-sorai (hibák is) | – |
| `profiles` | tartós profilok listája / lomtárba helyezése | `profile_action`, `profile` |
| `close`, `status` | lezárás, állapot | – |

A képernyőképet a `shot` a munkaterületre (vagy `state\browser-shots\` alá)
írja, és **visszaadja az útvonalat** — megnézni a `read_image` toollal lehet
(így nem kerül base64 a kontextusba).

## Célterület (mindhárom elérhető)

| `scope` | Mit ér el |
|---|---|
| `loopback` | `127.0.0.1`, `localhost`, `[::1]` — a saját felület |
| `lan` | a fenti + `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `*.local`, `*.lan`, `*.internal` |
| `any` (**alap**) | bármely http/https URL — külső oldalakon is lehet kattintani és gépelni |

Nem http(s) séma (`file:`, `javascript:`, `data:`) **mindig tiltott**.
A `state\browser-config.json` opcionális kulcsai: `defaultScope`, `allowHosts`
(kivétellista minden hatókörben), `width`, `height`, `idleMs`.

## Profilok

- **eldobható (alap):** futásonként új `state\browser-profiles\tmp-*` könyvtár,
  zárás után törölve — nincs bejelentkezés, nincs maradék.
- **tartós:** `profile: "lineageos"` → `state\browser-profiles\lineageos`, a
  sütik és bejelentkezések **megmaradnak** a hívások és a sessionök között.
  A név `[a-z0-9._-]`, max 41 karakter. Törlés: `profiles` +`profile_action: delete`
  → **lomtárba** kerül (`.trash-<idő>-<név>`), nem törlődik.

A zárás **szabályos** (`Browser.close`, majd a maradék fa `taskkill /T /F`-fel):
mért hiba volt, hogy a kényszerített ölés miatt a tartós profilba tett süti
elveszett.

## Letöltés — jóváhagyáshoz kötve

A `download` a `state\browser-downloads\<idő>-<slug>\` mappába tölt, és **előbb**
egyszeri jóváhagyást kér a `ctx.approval`-on keresztül:

- jóváhagyás → letöltés, a fájlok listája a válaszban;
- elutasítás / nincs csatorna / megszakítás → **nem indul letöltés**, a tool
  kimondja, mi történt, és hogy a felhasználót kell megkérni.

## Biztonsági keret

- **Csak headless** (`--headless=new`, `windowsHide: true`, `stdio: "ignore"`):
  AGENTS.md 1. pont — soha nem nyílik látható ablak, nincs fókuszlopás.
- A böngésző a **host processzben** fut: a fájl-sandbox rá nem érvényes. Ezért a
  hatókör-ellenőrzés itt, a toolban van, és minden navigáció/letöltés a
  `state\browser.log`-ba kerül (idő, URL, hatókör, profil).
- A böngésző **soha** nem használja a felhasználó bejelentkezett Edge-profilját:
  mindig saját `--user-data-dir`.
- A folyamat leállítása **csak a saját PID-del** történik (AGENTS.md 1.6),
  a `/T` a renderelőket is viszi — nincs árva folyamat.
- A tool egyszerre **egy** böngészőt tart; `idleMs` (alap 3 perc) után magától
  lezár, és a host leállásakor (`dispose`) is takarít.

## Tesztek és ellenőrzés

```powershell
node plugins\dsh-browser\test\scope.test.mjs      # 11 eset — célterület-szabály
node plugins\dsh-browser\test\profiles.test.mjs   # 8 eset — profilok, lomtár, kisöprés
node plugins\dsh-browser\test\cdp.test.mjs        # 6 eset — CDP protokoll-réteg
node plugins\dsh-browser\test\tool.test.mjs       # 8 eset — a kapuk (böngésző nélkül)
node tools\browser-doctor.mjs --allow-download    # valódi böngésző, 7 lépés
```

A `browser-doctor` a **sandboxon belülről nem fut** (a Chromium ott nem indul),
ezért eszkalációval vagy a DSH terminál-paneljéből kell futtatni. A plugin maga
viszont mindig a host processzben fut, tehát neki nem kell eszkaláció.

Mért eredmény (2026-11-26, ezen a gépen):

```
OK browser-exe        C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
OK scope-policy       5/5 eset helyes
OK loopback-ui        cím="DeepSeek Harness" kész=true kép=44079 B
OK external-read      cím="Example Domain" törzsszöveg=917 karakter
OK external-click     https://example.com/ → https://www.iana.org/help/example-domains
OK persistent-profile fájlok: 289 → 289 · süti túlélte az újraindítást: igen
OK download           doctor.txt (19 B)
7 lépés · 7 ok · 0 hiba
```

## Ismert korlátok

- Az `eval` bármit futtathat az oldalon — a hatókör-ellenőrzés a **tool**
  `open`/`download` műveleteire érvényes; egy `eval`-lal kezdeményezett
  navigációt a tool csak utólag jelent (`URL:` a válaszban). A szűkítés a
  `dsh-rule-guard` szabályával lehetséges.
- A tartós profil **kényelmi**, nem biztonsági határ: a benne lévő bejelentkezés
  bárkié, aki a gépet használja.
- A `--headless=new` néha nem ad képet bizonyos GPU-illesztésű oldalakról; ilyenkor
  a `shot` üres/fehér képet adhat — a `read`/`eval` ilyenkor is működik.

---

## English summary

`dsh-browser` registers a `browser` tool that drives a **headless** Edge/Chromium
through raw CDP from the **host process** (the sandbox cannot start Chromium at
all — mojo/crashpad need named pipes). Actions: `open`, `read`, `click`, `type`,
`eval`, `shot` (PNG path for `read_image`), `download` (**gated by a one-shot user
approval**), `console`, `profiles`, `close`, `status`. All three target scopes are
available (`loopback`, `lan`, `any`), clicking/typing works on external sites, the
non-http(s) schemes are always refused, and profiles are either disposable
(default) or **named and persistent** so logins survive between calls and
sessions. Closing is graceful (`Browser.close`, then `taskkill /T /F`) so the
persistent profile is actually written. Install with `install.ps1` (junction +
agent-preset entry); the tool appears in the **next** session. Tests: 33 unit
cases across four files; end-to-end: `node tools/browser-doctor.mjs` (7/7 green,
2026-11-26).
