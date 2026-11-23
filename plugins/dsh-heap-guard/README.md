# dsh-heap-guard — memória-telemetria a futó harnesshez

**Egy mondatban:** 5 percenként rögzíti a harness processz SAJÁT memóriáját
(`state\harness-memory.jsonl`), és a V8 heap-plafon 75% / 90%-a fölött
figyelmeztet — hogy a heap-OOM ne érjen váratlanul.

## Miért kell (mért eset)

**2026-11-23 18:15:35** — a 46 órája futó harness (`pid 26332`) leállt:

```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
```

(`state\harness.err.log`; a GC-sorok szerint 3 285,6 MB használt heap, a Node
alap `heap_size_limit`-je ezen a gépen **4 288 MB**.) A tálca 11 s múlva
„harness nem válaszol a 3080 porton — indítás” sorral újraindította
(`state\native-tray.log`), a megszakadt köröket a `dsh-session-auto-continue`
részben folytatta — de **a növekedést eddig SEMMI nem mérte**, ezért a leállás
váratlan volt.

Mért memória-pálya: indulás ~430 MB rss / ~135 MB heap; a boot első percében
~900–1 700 MB rss; 46 óra után ~3,3 GB heap. Ez ~60–70 MB/óra — hosszú
futásnál a plafon elérhető.

## Mit tesz

- Induláskor **egy `boot` minta** (a V8 plafon rögzítése — ebből látszik, hogy a
  tálca `--max-old-space-size` flagje érvényes-e), majd **5 percenként** egy
  `sample` sor: heap/limit %, rss, external, arrayBuffers, uptime.
- **Csúcsfigyelő 10 másodpercenként** (`peak` sor): csak akkor ír, ha a használt
  heap legalább **64 MB-tal** meghaladja az eddigi legnagyobbat. Így az 5 perces
  minták közé eső hirtelen foglalás is nyomot hagy — és a napló nem hízik.
  Ez a sor dönti el, hogy a leállás **lassú felhalmozódás** (egyenletes
  emelkedés) vagy **egy nagy blokk** (alacsony érték után ugrás) volt-e.
- Szintváltásnál (**ok → high 75% → critical 90%**) WARN a harness naplójába, a
  mért MB/óra trenddel és a kritikus szintig becsült idővel.
- A napló 512 KB-nál újraindul; az időzítők `unref`-eltek; a plugin leállásakor
  törlődnek. Minden hiba elnyelve — a bootot nem állíthatja meg.

## Ellenőrzés

```powershell
node tools\harness-memory.mjs          # emberi összegzés (pid, %, trend, teendő)
node tools\harness-memory.mjs --json   # ugyanez gépi alakban
node plugins\dsh-heap-guard\test\memory.test.mjs   # 7 teszt
```

A riport kilépési kódja: `0` = ok, `1` = high/critical, `2` = nincs mérés.
A `plafon:` sor kimondja, hogy a **tálca új verziója** (`--max-old-space-size=8192`)
érvényes-e már; ha „ALAP (4 288 MB)”, akkor a tálca még a régi binárist futtatja,
és a plafon-emelés a következő tálca-indításnál lép életbe.

## Telepítés / aktiválás

```powershell
.\plugins\dsh-heap-guard\install.ps1           # junction + profil-patch bejegyzés
.\plugins\dsh-heap-guard\install.ps1 -Check    # száraz ellenőrzés
.\plugins\dsh-heap-guard\install.ps1 -Remove   # eltávolítás
```

A patch a **futó** processzbe is betöltődik (mért: a `dsh-model-pin`-nél a
bejegyzés hozzáfűzése után 1 másodperccel megjelent a `boot` sor), a következő
indításnál is él. A Harness-t nem kell (és AGENTS.md 1.5 szerint nem is szabad)
újraindítani.

## Kapcsolódó változás: emelt V8 plafon a tálcában

`src\DshTray.cs` → `HarnessHeapFlags = "--max-old-space-size=8192"`: a harness
node-példánya 8 GB plafonnal indul (32 GB RAM + 32 GB lapozófájl mellett
biztonságos). A futó tálca a régi binárist futtatja, az új (`bin\DshTray.exe.new`)
a **következő tálca-indításnál** lép életbe (`PendingUpdate.Apply`).

**Amit az emelt plafon NEM old meg:** a növekedést. A hosszú távú válasz a
trend ismerete (ez a plugin), és hogy a munkamenetek **nyugodt pillanatban**
újraindíthatók legyenek (tálca menü: „Harness újraindítása”) — ezt a felhasználó
dönti el, nem a plugin.

## Fájlok

| fájl | szerep |
|---|---|
| `lib/memory.js` | tiszta számolás: minta, szint, trend |
| `lib/index.js` | a plugin: boot-minta + 5 perces telemetria |
| `lib/check-patch.mjs` | a profil-patch YAML/bejegyzés ellenőrzése |
| `install.ps1` | junction + profil-patch (`-Check`, `-Remove`) |
| `test/memory.test.mjs` | 6 teszt (a mért OOM-számokkal) |
| `..\..\tools\harness-memory.mjs` | riport (%, trend, plafon, teendő) |
