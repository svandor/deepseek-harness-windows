# dsh-model-pin — rögzített alapértelmezett modell

**Egy mondatban:** új munkamenet alapértelmezett modellje mindig a rögzített
modell (alapból **DeepSeek V4.1 Flash**, `deepseek-official/deepseek-flash:high`),
függetlenül attól, hogy az előző beszélgetésben melyik modellt választották.

## Miért kell (mért ok)

A felhasználó jelezte (2026-11-23): *„új munkamenet indításakor a felajánlott
alapértelmezett modell (ágens) mindig a deepseek v41 flash legyen, függetlenül
attól, hogy mi volt az előző (most az előzőt ajánlja fel)”*.

A drift a harness saját útján jön:

| lépés | hol |
|---|---|
| a modellváltás a beszélgetésben | `dsh-client-ui-model-selection` → `session.selectModel` |
| mentés az ALAPÉRTELMEZÉSBE | `dsh-api-session-controller` `selectModel()` → `agentDefaultModel.saveSelection()` |
| írás a settings user layerbe | `dsh-agent-default-model` → `settings.replace('agent-default-model', …)` |
| ezt olvassa az új munkamenet | `agentOptions()` = `agentDefaultModel.currentSelection()`, és a kliens `catalog.default`-ja |

Tehát a legutóbb választott modell **minden** új munkamenet alapértelmezése lett.
Ez a harness szándékos viselkedése, nem hiba — a felhasználó viszont rögzíteni
akarja az alapértelmezést.

## Mit tesz a plugin

1. **Induláskor** helyreállítja az alapértelmezést, ha a `settings.yaml`
   `agent-default-model` szekciója eltér a rögzítéstől.
2. Figyeli a `settings/updated` eseményt: minden driftet **visszaállít** a
   rögzítésre. A `settings.yaml` így is az igazság forrása marad (nem hazudik),
   és a beszélgetés **saját** modellválasztását NEM érinti (az session-lokális,
   `model/selection` esemény + `selectionFor`), csak a globális alapértelmezést.
3. A javítások **egymás után** futnak (a settings írásai is sorban mennek), és
   időablakos **fék** védi (6 javítás / 60 s): ha valami folyamatosan visszaírja
   a driftet, a plugin leáll és naplózza — nem indít lavinát (AGENTS.md 1.7).
4. A plugin **soha** nem állítja meg a bootot: minden hívás try/catch-ben fut,
   hiba esetén a naplóba ír és tovább él.

## A rögzítés (`pin.json`)

A plugin mellett, a repóban: `plugins\dsh-model-pin\pin.json` (**hot-reload**,
mtime szerint — újraindítás nélkül él a következő eseményre).

```json
{
  "enabled": true,
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoningEffort": "high"
}
```

| mező | jelentés |
|---|---|
| `enabled` | `false` → a plugin nem javít (a harness saját viselkedése él tovább) |
| `provider` | kötelező, pl. `deepseek-official` |
| `model` | kötelező, pl. `deepseek-flash` (= DeepSeek V4.1 Flash) |
| `reasoningEffort` | opcionális. Ha meg van adva, a szintet is rögzíti; ha nincs, a korábbi írásból visszamaradt szintet **kiveszi**, hogy a szolgáltató döntsön (különben egy másik modell effort-ja ragadna a Flash-re) |

**A rögzítés megváltoztatása:** írd át a `pin.json`-t (a plugin a következő
settings-eseményre, de legkésőbb a következő indulásnál alkalmazza). A
`settings.yaml` kézi átírása **nem** marad meg: a plugin visszaállítja — ez
szándékos, ez a rögzítés lényege.

**Hibás/hiányzó `pin.json`:** a plugin a beépített rögzítésre esik vissza
(`DEFAULT_PIN` = DeepSeek V4.1 Flash, `high`) — a szándék ugyanaz —, és a hibát a
naplóba írja. Soha nem esik csendben egy másik modellre.

## Telepítés / aktiválás

```powershell
# normál PowerShell-ablakból (a ~\.dsh a DSH sandboxján kívül van)
.\plugins\dsh-model-pin\install.ps1            # junction + profil-patch bejegyzés
.\plugins\dsh-model-pin\install.ps1 -Check     # száraz ellenőrzés
.\plugins\dsh-model-pin\install.ps1 -Remove    # eltávolítás
```

A telepítés ugyanaz a bizonyított út, mint a `dsh-rule-guard`-nál:
junction (`~\.dsh\profiles\node_modules\dsh-model-pin` → ez a mappa) +
`- insert:` bejegyzés a `~\.dsh\profiles\web\cordis.patch.yml`-be.

**Aktiválás:** a profil-patch a harness **futó** processzébe is betöltődik
(mérve, 2026-11-23: a bejegyzés hozzáfűzése után 1 másodperccel megjelent a
`boot` bejegyzés a naplóban, a harness PID-je nem változott), tehát a következő
indításnál is él. A Harness-t **tilos** újraindítani (AGENTS.md 1.5).

## Ellenőrzés

```powershell
node tools\check-model-pin.mjs
```

Ellenőrzi: a `pin.json` érvényes-e; a `settings.yaml` szekciója a rögzítés-e;
a junction a pluginra mutat-e; a profil-patch tartalmazza-e a bejegyzést és
érvényes YAML-e; a napló utolsó bejegyzései. Kilépés: 0 = rendben, 1 = eltérés.

```powershell
node plugins\dsh-model-pin\test\pin.test.mjs   # 15 teszt
```

Élő viselkedéspróba (a `saveSelection` írását utánozza, és mindenképp a rögzített
értéket hagyja a fájlban — **normál PowerShell-ablakból**, mert a `~\.dsh` a
sandboxon kívül van):

```powershell
.\plugins\dsh-model-pin\test\live-drift-test.ps1
```

A napló: `~\.dsh\model-pin.log` (JSONL, 2 MB-os felső korláttal). Példa egy
javításra:

```json
{"at":"2026-11-23T16:39:47.992Z","kind":"corrected","reason":"settings-updated",
 "from":"deepseek-official/deepseek-v4-pro:high","to":"deepseek-official/deepseek-flash:high",
 "pinSource":"file"}
```

`kind` értékek: `boot` (indulás), `corrected` (visszaállítás), `fuse` (a fék
leállította a javítást), `error` (az írás nem sikerült), `disabled` (a rögzítés
ki van kapcsolva).

## Korlátok (kimondva)

- **A beszélgetés saját modellje nem változik** — a rögzítés csak az új
  munkamenetek alapértékére és a kliens választójának alapértékére hat.
- **A `fork` is a rögzítést kapja** (a harness a forkolt session `agentOptions`-át
  is az alapértelmezésből veszi) — ez a kért viselkedés.
- **A pillanatnyi rés bezárva, de nem nulla:** ha valaki a modellváltás és a
  javítás között (néhány ms) indít új munkamenetet, az még a régi értéket
  kaphatja; a következő már a rögzítést.
- **A `settings.yaml` kézi szerkesztése nem tartós** — a plugin visszaállítja.
  Ez nem hiba, hanem a rögzítés jelentése.
- A rögzítés a **settings layerre** hat, nem a harness forráskódjára: a `dsh`
  csomag frissítése nem törli el (a plugin a repóból, junction-ön át töltődik).

## Fájlok

| fájl | szerep |
|---|---|
| `lib/pin.js` | a tiszta szabály: illeszkedés, javítás-terv, áramköri fék |
| `lib/index.js` | a plugin: induláskori helyreállítás + `settings/updated` figyelő |
| `pin.json` | a rögzítés (hot-reload) |
| `install.ps1` | junction + profil-patch (`-Check`, `-Remove`) |
| `lib/check-patch.mjs` | a profil-patch YAML/bejegyzés ellenőrzése |
| `test/pin.test.mjs` | 15 teszt (fake settings-szolgáltatással) |
| `..\..\tools\check-model-pin.mjs` | élő állapot ellenőrzése (settings, junction, patch, napló) |
