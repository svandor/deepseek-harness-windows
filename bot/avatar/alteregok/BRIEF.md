# Alteregó avatarok — gyártási brief

Ez a fájl a Házirobot **alteregó avatarjainak** közös szerződése. Aki új alteregót
rajzol (ember vagy ügynök), **ezt a szerződést kötelező betartania**, különben a
választóban és az automatikus váltogatásban az avatar elromlik.

- **Hely:** `bot/avatar/alteregok/<id>.svg` (egy fájl = egy alteregó)
- **Katalógus:** `bot/avatar/alteregok.json` (ide kerül a név, leírás, mozgás)
- **Betöltés:** minden avatar `<img src="…/avatar.svg?alterego=<id>">` alakban
  jelenik meg, tehát minden SVG **önálló, teljes dokumentum**.

## 1. Kötelező váz

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- Rövid magyarázat: mi ez, mi ihlette, mitől mozog. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320" width="240" height="320"
     role="img" aria-label="ALTEREGÓ NEVE">
  <defs>
    <!-- színátmenetek, szűrők — minden id egyedi, alteregó-prefixszel -->
  </defs>

  <style>
    /* KÖTELEZŐ, minden fájlban BETŰRE UGYANEZ a két blokk: */
    .lebeg { animation: lebeg 3.4s ease-in-out infinite; }
    @keyframes lebeg { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }

    .szem { transform-box: fill-box; transform-origin: center; animation: pislog 5.2s ease-in-out infinite; }
    @keyframes pislog { 0%,92%,100% { transform: scaleY(1); } 95% { transform: scaleY(0.08); } }

    /* IDE jönnek az alteregó SAJÁT animációi, mindig <prefix>- előtaggal: */
    .ez-kar { transform-box: fill-box; transform-origin: top center; animation: ez-tanc 1.1s ease-in-out infinite; }
    @keyframes ez-tanc { 0%,100% { transform: rotate(-18deg); } 50% { transform: rotate(28deg); } }
  </style>

  <!-- talajárnyék: kötelező, pontosan ez a sor (az y a test talpához igazítható) -->
  <ellipse cx="120" cy="292" rx="62" ry="10" fill="#000" opacity="0.28"/>

  <g class="lebeg">
    <!-- a robot teljes teste -->
  </g>
</svg>
```

## 2. Szabályok (mind kötelező)

1. `viewBox="0 0 240 320"`, `width="240"`, `height="320"` — pontosan.
2. A robot **talpa y ≈ 280–296**, a feje teteje y ≈ 30–70 között legyen; vízben
   középen (x ≈ 60–180). A talajárnyék a test alatt maradjon.
3. **Csak tiszta SVG**: `rect`, `circle`, `ellipse`, `path`, `line`, `polygon`,
   `polyline`, `g`, `defs`, `linearGradient`, `radialGradient`, `filter`,
   `feGaussianBlur`, `feMerge`. Tilos: `<script>`, `<foreignObject>`,
   `<image>`, `<use href="http…">`, `<animate>`/SMIL, külső font, `onclick`.
4. **Animáció kizárólag CSS-sel**, a `<style>` blokkban. A `.lebeg` és `.szem`
   blokk **betűre ugyanaz** minden fájlban (ez a közös mozgás-nyelv), minden más
   class és `@keyframes` név kapja meg az alteregó 2–4 betűs prefixét
   (pl. `gy-`, `ez-`, `gonk-`), különben két avatar a választóban felülírná
   egymás animációját.
5. Legalább **egy `.szem` class-szal jelölt elem** legyen (ez pislog). A szem
   lehet `<ellipse>` vagy `<circle>`; ha nem kerek, a `pislog` helyett saját
   `transform-box: fill-box` + `transform-origin: center` kell.
6. Minden `id="…"` egyedi, alteregó-prefixszel (`ez-feher`, `gonk-acel`), mert
   a választó több avatart tölthet be ugyanabba a lapba.
7. Emberi alaknál a karok külön `<g>`-ben, `transform-box: fill-box` +
   `transform-origin` a vállon — így a csukló nem szakad le.
8. A `role="img"` és az `aria-label` magyar név legyen.
9. **Ne** legyen `<title>`/`<desc>` (a panel saját feliratot ad).
10. A fájl UTF-8, sortörés LF; a végén egy sor záró `</svg>`.

## 3. Mozgás-nyelv (válassz egyet, vagy kérj újat)

| kulcs | mit jelent |
|---|---|
| `lebeg` | lebegő alap (a `.lebeg` blokk), finom himbálás |
| `pislog` | a szem időnként összezár (a `.szem` blokk) |
| `integet` | az egyik kar rendszeresen felemelkedik |
| `himbal` | a karok lazán kilengenek |
| `tancol` | egész testes ritmus, csípő- és karrövidülés |
| `fejforgat` | a fej ide-oda fordul |
| `biccent` | kimért fejbiccentés |
| `billeg` | oldalirányú dőlés (járó, nehézkes) |
| `pattoq` | pattogó, fürge mozgás |
| `villog` | fény/szem pulzál, a test mozdulatlan |
| `gurul` | a test gurul, a fej külön lebeg |
| `sassze` | oldalazó, kíváncsi mozgás |

## 4. Az alteregók és a hozzájuk tartozó brief

A `<id>` a fájlnév és a katalógus-kulcs. A prefixet a rajzoló választja
(2–4 betű, az id kezdete).

### `gyuszi` — Gyuszi (a valódi)
A *Magyarok az űrben* (Comedy Central, 2013) Gyuszi robotjának ihletett,
„kukás” változata: **műanyag papírkosár a feje** (áttetsző, rácsos, fülei
kampósak), **bádogkuka a teste** (hullámos bordák, horpadt fedél, fémfülek),
**hosszú konyhai páraelszívó flexicsövek a karjai** (fehér műanyag, acélmerevítés
miatt gyűrűzött, a végén kis csipesz/műanyag csatlakozó). Mozgás: `billeg` +
`integet` — tántorog, a csőkarok kilengenek és gumi módjára visszahullanak.
Ez a **fő alteregó** (alapértelmezett).

### `klasszikus` — Fehér robot
A jelenlegi avatar: fehér/szürke humanoid, sötét visorral, cián szemekkel,
piros antennagombbal, lánctalpas talppal. A *Magyarok az űrben* 6:10–6:40
közötti képkockájából mintázva. Mozgás: `lebeg` + `integet` + `villog`
(mellkasi fények). Ez a **visszafelé kompatibilis** alteregó.

### `ezeros` — Ezüst gépember
A **Clouds Across the Moon** (The Rah Band) videóklip robot-utánzó táncosának
ihletett változata: emberi alak, ezüstfestés, hengeres fej, kémcső-szerű
üvegszár-antenna, ízületes végtagok, csillogó felület. Mozgás: `tancol` —
disco-ütemű csípőrizálás és karlendítés, a csillanás végigfut a felületén.
Paletta: ezüst, kék derengés, meleg rózsaszín rivaldafény.

### `gonk` — Gonk
A Csillagok háborúja GNK power droidjának ihletett változata: négyzetes, láda
alakú test, rövid, vastag lábak, lapos fejtető, oldalt kábelek, elöl sárga
címke. Mozgás: `billeg` — nehézkes, apró léptű dülöngélés, a lábak váltakozva
emelkednek. Paletta: szürke fém, sárga-fekete csíkozás.

### `asztromech` — Asztromech
R2-D2 ihlette: hengeres test, gömb alakú fejtető, elöl kör alakú „szemlencse”,
oldalt két rövid láb, a fejtetőn projektor. Mozgás: `fejforgat` — a fej
ide-oda fordul, közben rövid csipogó fény villan. Paletta: fehér-kék-ezüst.

### `protokoll` — Protokoll-droid
C-3PO ihlette: arany, emberi arányú, szögletes ízületek, téglalap alakú
fénylő szemek, hasi vezérlőpanel. Mozgás: `biccent` — merev, udvarias
fejbiccentés és apró karlendítés. Paletta: arany, bronz, sötétbarna hézagok.

### `kukagyerek` — Kuka-gyerek
WALL-E ihlette: alacsony, kockás test, távcső-szerű nyak, binokuláris fej,
napszem alakú szemek, lánctalp, elöl sárga-fekete veszélycsík. Mozgás:
`sassze` — kíváncsi oldalazás, a fej előre-hátra billen. Paletta: rozsdás
sárga, barna, acél.

### `tojas` — Tojás
EVE (WALL-E) ihlette: fehér tojásdad test, sötét „szemüveg” sáv, lebegő
karok, alul leváló gyűrű. Mozgás: `lebeg` — magasabban lebeg, a karok
összehúzódnak, a szemüveg-sáv kéken világít. Paletta: fehér, égkék.

### `gomb` — Golyó
BB-8 ihlette: nagy gömb alakú test guruló mintázattal, külön lebegő
kúpos fej, két antenna. Mozgás: `gurul` — a test gurul, a fej lebeg és
követi. Paletta: fehér-narancs, sötét panelek.

### `bender` — Bender
Futurama ihlette: hengeres fej, szemetes-száj, gombszem, antennán gömb,
szivar a szájban. Mozgás: `pattoq` — hátradől, az antenna rezeg, füstkarika.
Paletta: szürke fém, cián szem, sárga fény.

### `marvin` — Búskomor
Marvin (Galaxis útikalauz stopposoknak) ihlette: túlméretezett fej,
apró test, búskomor szemek, oldalt kartámaszok. Mozgás: `lebeg` — alig
mozdul, a fej nehezen billen, a szemek félrebillennek. Paletta: zöldes-fehér,
szürke, narancs sáv.

### `szem` — Szem
HAL 9000 ihlette: lapos panel, középen nagy vörös kameralencse, körülötte
fémes gyűrű, alul vékony fénycsík. Mozgás: `villog` — a lencse lassan
pulzál, a gyűrű forog. Paletta: fekete panel, vörös lencse, ezüst.

### `clippy` — Iratkapocs
A Clippy (Microsoft Office) mém ihlette: nagy gemkapocs-alak, vastag
drótvonal, rajta két nagy szem és szemöldök, alul papírlap. Mozgás:
`pattoq` — idegesen pattog, a szemöldök fel-le jár, a drót vége integet.
Paletta: ezüst drót, sárga papír.

### `spot` — Robotkutya
Boston Dynamics Spot ihlette: alacsony, négylábú test, hátán szenzortorony,
térdei hátrafelé hajlanak. Mozgás: `billeg` — lábváltogató járás, a
szenzortorony körbefordul. Paletta: sárga-fekete, sötétszürke ízületek.

## 5. Új alteregó hozzáadása

1. Készítsd el a `bot/avatar/alteregok/<id>.svg` fájlt a fenti váz szerint.
2. Vedd fel a `bot/avatar/alteregok.json` `lista` tömbjébe:
   `{ "id", "nev", "alcim", "fajl", "mozgas", "ihlet", "szin" }`.
3. Ellenőrzés: `node bot/tests/alterego.test.mjs` — minden SVG-re megvizsgálja
   a viewBoxot, a kötelező class-okat, a tiltott elemeket és a prefix-követést.
4. A panelen a 🤖 → **Alteregók** fülön azonnal megjelenik.
