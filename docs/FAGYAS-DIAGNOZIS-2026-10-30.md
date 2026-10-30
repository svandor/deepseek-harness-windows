# Feljegyzés — a 2026-10-30 09:20–09:55 közötti „lefagyás" diagnózisa

**Állapot: FELJEGYZÉS / NEM JAVÍTOTT.** Ez a dokumentum szándékosan nem tartalmaz
végrehajtott módosítást. A `settings.yaml`, a tálca-szkriptek és a DSH csomagok
érintetlenek. A javítási javaslatok a 8. pontban, alkalmazás nélkül.

- Kivizsgálás: 2026-10-30, 09:53–10:00 (helyi idő)
- A feljegyzés kiírása: 2026-10-30, 14:01 (helyi idő)
- Kivizsgálta: DSH ágens (session-6ea8638a…)
- Tárgy: „a `deepseek41flash` modellel indított munkák látszólag lefagytak, csak az
  idő telt"

---

## 1. Egy mondatban

Nem a DSH fagyott le és nem a modell volt lassú: a **DeepSeek hivatalos API-ja
503-as túlterhelési viharban volt**, a negyedik próbálkozás pedig egy **félholt
SSE-streamet** kapott, amely a válasz megkezdése után **15 perc 36 másodpercig
tartalom nélkül életben tartotta a kapcsolatot**. A DSH-nak erre nincs hatásos
határideje, ezért végig várta — ez volt a „csak az idő telt".

A `deepseek41flash` azonosítása: a `deepseek-official` provider `deepseek-flash`
modellje, amelynek megjelenített neve a DSH katalógusában
**`DeepSeek-V41-Flash`** (`dsh-llm-deepseek/lib/index.js:1843`). A session-naplókban
a `model: "deepseek-flash"`, a `provider: "deepseek-official"` szerepel.

---

## 2. Idővonal — a tényleges lefagyás

Forrás: `C:\Users\info\.dsh\sessions\--C-Szerver-Raider--\session-dfaea1e0-2e40-42cb-82f6-c70f195aa3f3\session.v3.jsonl.zstd`,
`turn 10`, `step 5`.

| Idő | Rekord | Tartalom |
|---|---|---|
| 09:26:00.744 | `assistant/attempt` → `finish{error}` | `503`: *„Service is too busy. We advise users to temporarily switch to alternative LLM API service providers."* — `request_id: 7ba1034c-3a77-4d0b-b1ee-10e51a5d7c7c` |
| 09:26:07 | `assistant/attempt` → `503` | `request_id: eb20111b-ec96-46ed-941f-83261efd1dbe` |
| 09:26:10 | `assistant/attempt` → `503` | `request_id: c6614d6b-de5a-4a26-95b1-724bb8c3419f` |
| 09:26:00–09:26:12 | 3× `llm/retry` | retry 1/5, 2/5, 3/5; késleltetés 457 ms / 944 ms / 1964 ms |
| 09:26:12 | `llm/retry-started` | retry 3/5 indul, `provider: deepseek-official` |
| 09:26:18.411 | stream: `block-start` reasoning | megindul a válasz |
| 09:27:08.320 | stream: `block-start` tool-call | megkezdődik egy `pwsh` hívás argumentum-folyama |
| **09:27:08 → 09:42:44** | **nincs tartalom** | **15 min 36 s csend** (a `finish` chunk `time`: 1793349764098) |
| 09:42:44.098 | `finish{error}` | `SSE stream ended without [DONE]` — kód: `STREAM_CLOSED` |
| 09:42:44 | `step/end` + `turn/end` | `{"kind":"error","error":{"message":"SSE stream ended without [DONE]","code":"STREAM_CLOSED"}}` |

Megjegyzés: az `assistant/attempt` rekord csak a stream **végén** íródik ki, ezért
a felületen 09:27:08-tól 09:42:44-ig szó szerint semmi nem jelent meg — csak a
múló idő. Ez pontosan a bejelentett tünet.

### 2.1 Ugyanez ismétlődött (nem egyszeri eset)

| Session | Idő | Eredmény |
|---|---|---|
| `--C-Szerver-Raider--` / `session-904850a6…` (`turn 1`, `step 1`) | 09:39:21 → 09:47:41 (**8 min 20 s**) | `STREAM_CLOSED`; a user közben ezt írta: *„leragadtál, folytasd"* (09:45:58) |
| `--C-Szerver-Raider--` / `session-dfaea1e0…` (`turn 11`, `step 9`) | 09:46:35 → 09:47:39 (~64 s) | `STREAM_CLOSED` |
| `--C-Szerver-Raider--` / `session-dfaea1e0…` (`turn 10`) | 09:26:12 → 09:42:44 (**15 min 36 s**) | `STREAM_CLOSED` (a fő eset) |

Korábban ugyanezen a napon: `--C-Szerver-Raider--` / `session-d8813da7…` 06:14-kor
szintén `STREAM_CLOSED`. Tehát a hiba-minta nem új keletű, csak 09:26 és 09:48
között sűrűsödött.

### 2.2 Az 503-asok száma

A `session-dfaea1e0…` nyers szövegében `"Service is too busy"` **6 találat** = 3
kísérlet × 2 rekord (`assistant/attempt` + `llm/retry`). `"STREAM_CLOSED"` **4
találat** = 2 hiba × 2 rekord.

---

## 3. Miért nem fogta meg semmilyen őr (gyökér-okok)

### 3.1 A retry ugyanazon a provideren próbálkozik — nincs provider-fallback

A `llm/retry` rekord `policyKey` mezője:

```
["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]
```

Ez a `dsh-llm-retry` alapértéke (`DEFAULT_MAX_RETRIES = 5`,
`DEFAULT_INITIAL_DELAY_MS = 500`, `DEFAULT_MAX_DELAY_MS = 10000`,
`DEFAULT_JITTER_RATIO = 0.1`, `DEFAULT_RETRYABLE_CODES` — `dsh-llm/lib/index.js:232–236`).
A DSH csak **ugyanarra a route-ra** kéri újra; a provider-váltás nincs benne.
A `settings.yaml` ezt a 80. sor környékén maga is kimondja:
*„a DSH llm-retry csak UGYANEZEN a route-on probalkozik ujra, nem valt providert"*.

Mivel az `agent-default-model` közvetlenül `deepseek-official` /
`deepseek-flash`, a `providers\proxy.mjs` `auto` lánca (deepseek/deepseek-flash →
alibaba-intl/qwen3.8-flash → alibaba/qwen3.8-flash) **ki van kerülve**. Egy
DeepSeek 503-vihar így a fő ágenst teljesen megállítja.

### 3.2 Az 5 perces idle-watchdog hatástalan keep-alive mellett

A `dsh-llm-deepseek/lib/index.js` szerint:

- `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000` (5 perc), `streamIdleTimeoutMs` a
  provider-configban állítható (1897. sor).
- A watchdog bekötése: `idleWatchdog(..., connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)`,
  és a `request()` a callbacket így adja tovább: `() => { watchdog.pulse(); }` (1627. sor).
- Ez a callback a `parseSse(response.body, onActivity)` (1816. sor) révén **kizárólag
  az SSE komment-sorokra** fut le: `new EventSourceParserStream({ onComment })`
  (1108. sor). A tartalom-chunkok nem pulzálják.

Következmény: ha az upstream **keep-alive kommenteket küld, de nem termel tokent**,
a watchdog örökre ébren marad. A 09:27:08–09:42:44 közötti 15,5 perc alatt
pontosan ez történt — a `streamIdleTimeoutMs: 300000` soha nem sült el, a
tényleges határidő gyakorlatilag végtelen volt.

### 3.3 A `STREAM_CLOSED` nem újrapróbálható kód

A `DEFAULT_RETRYABLE_CODES` listában (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`,
`TIMEOUT`, `TRANSPORT`) a `STREAM_CLOSED` **nincs benne**. Így a 16,5 perc várakozás
után kapott hibára már nincs retry: a turn azonnal `error`-ral lezárul. Vagyis a
legdrágább hibát (hosszú csend) a legkisebb tolerancia fogadja.

Összefoglalva a lánc: **503-vihar → ugyanazon provideren 3 gyors retry → a 4.
próbálkozás félholt streamje → keep-alive miatt soha nem tüzelő watchdog → 15,5
perc üresjárat → nem-retryelhető `STREAM_CLOSED` → turn halála.**

---

## 4. Hálózati kontextus: nem csak a fő route égett

A kivizsgálás közben indított három párhuzamos gyerek (ingyenes lánc, `worker`
route a `http://127.0.0.1:4123` proxyn át) **mindhárom** 09:54:26-kor ezzel állt le:

```
turn/end  {"kind":"error","error":{"message":"Connection error.","code":"TRANSPORT"}}
```

A proxy `/healthz` válasza közben `ok: true, usable: true, workerUsable: true`
(minden provider-kulcs „configured", cooldown üres) volt. Tehát a proxy
konfigurációja rendben van, a hiba a kifelé menő kérésekben volt — ugyanabban az
idősávban, amikor a DeepSeek 503-akat adott. Ez megerősíti, hogy **külső,
szolgáltató-oldali hullámzásról** van szó, nem DSH-regresszióról.

---

## 5. Második, független hiba: a tálca önjavító ciklusa

Forrás: `C:\Szerver\Deepseek Harness\state\tray.log`.

**Kiváltó ok (időbélyeggel):** 04:13:39-kor a `tray.log` rotálódott
(`tray.log.1`, 04:13:39), az első `token=False` pedig **04:13:59**-kor jelent meg.
A health-check a naplóban keresi a boot-kor kiírt token URL-t; a rotáció után az
már nincs meg, ezért a szervert örökre „betegnek" látja.

Mai számok a `tray.log`-ból:

| Minta | Darab |
|---|---|
| `egeszseg-ellenorzes: szerver=True token=False` | **816** |
| `automatikus onjavitas: ujrainditas (szerver=True token=False)` | **205** |
| `ujrainditas: HIBA - a 3080 portot nem sikerult felszabaditani (pid: 0)` | **139** |
| `indítás: node … dsh\lib\bin.js web --host 127.0.0.1 --port 3080` | **29** |

Jellemző részlet (09:32–09:55):

```
09:33:03 automatikus onjavitas: ujrainditas (szerver=True token=False)
09:33:25 indítás: node … bin.js web --host 127.0.0.1 --port 3080 --no-open
09:33:46 harness fut a 3080 porton (pid 66156)
09:36:07 automatikus onjavitas: ujrainditas (szerver=True token=False)
09:36:10 ujrainditas: HIBA - a 3080 portot nem sikerult felszabaditani (pid: 0)
09:44:11 (native-tray.log) tálca kilépés
09:44:28 indítás: nincs futó tálca, új példány indul (ablak nyitásával)
09:53:27 indítás: node … (pid 58308)
09:53:48 FIGYELEM: nem találtam token URL-t a naplóban
09:53:49 → harness.err.log: EADDRINUSE 127.0.0.1:3080
09:55:25 automatikus onjavitas: ujrainditas (szerver=True token=False)
```

Következmények:

- 60–90 másodpercenként elindul egy újabb `dsh web` példány, ami a foglalt port
  miatt `EADDRINUSE`-szal elhasal — ezt rögzíti a `state\harness.err.log`
  (`@deepseek-ai/dsh-host-webserver: listen EADDRINUSE … 127.0.0.1:3080`).
- A leállítás nem működik: a port tulajdonosa `pid: 0`-ként jelenik meg, ezért a
  régi példány életben marad.
- 09:44:11-kor a tálca kilépett, 09:44:28-kor egy **második** tálca-példány indult.

**Fontos pontosítás:** ez a ciklus **nem** a 15 perces fagyás okozója. A hosszú
`turn 10` túlélte a 09:33-as újraindítási kísérletet (az a példány nem tudott
bindolni), és a stream csak 09:42:44-kor szakadt meg. A tálca-ciklus önálló,
krónikus üzemeltetési hiba: fölös boot, CPU/RAM pazarlás, félrevezető naplók,
és elfedhet valódi hibákat.

---

## 6. Amit kizártam (hogy ne erre menjen el a következő kör)

- **Nem a helyi Ollama / VRAM.** A `llama-server.exe` nem vett részt a fő route-on;
  a `ollama-local` provider csak tartalék.
- **Nem a proxy leállása.** A `/healthz` végig `ok: true` volt, cooldownok üresek,
  minden kulcs „configured".
- **Nem a session-napló írása.** A naplók konzisztensek, a 15 perces csend
  rekordidőbélyegekkel igazolható, nem csonkolt fájl.
- **Nem a felület (Web GUI) hibája.** A kliens csak azt nem kapta, ami nem jött:
  a szerver oldalán némán állt a stream.
- **Nem kontextus-túllépés.** A `usage` mezők normálisak (input ~0,2–3 k token,
  `cacheReadTokens` magas), nincs `CONTEXT_WINDOW_EXCEEDED`.

---

## 7. Hogyan lehet bármikor újraellenőrizni

A session-naplók zstd-tömörített JSONL-ek, `zstd.exe` nélkül is olvashatók
Python 3.14-ggyel (`from compression import zstd`):

```python
import json, datetime, glob, os
from compression import zstd
p = r"C:\Users\info\.dsh\sessions\--C-Szerver-Raider--\session-dfaea1e0-…\session.v3.jsonl.zstd"
for l in zstd.decompress(open(p,'rb').read()).decode('utf-8','replace').splitlines():
    r = json.loads(l)
    if r.get('type') in ('llm/retry','turn/end','assistant/attempt'):
        print(datetime.datetime.fromtimestamp(r['time']/1000).strftime('%H:%M:%S'), r['type'], json.dumps(r['data'], ensure_ascii=False)[:200])
```

- A félholt streamek bizonyítéka: `'SSE stream ended without [DONE]'` és
  `'Service is too busy'` a session-fájlokban.
- A tálca-ciklus bizonyítéka: `Get-Content state\tray.log | Select-String 'token=False'`.
- Az indulási ütközés bizonyítéka: `state\harness.err.log` (EADDRINUSE).
- A watchdog viselkedése: `dsh-llm-deepseek/lib/index.js` 1108., 1627., 1816. sor.

---

## 8. Javasolt javítások — **NEM ALKALMAZVA**

Sorrend a hatás/kockázat arány szerint. Az 1. pont emberi döntés, a 2–3. pont
konfiguráció/szkript, a 4. pont DSH-kód.

### 8.1 (emberi döntés) Fő modell átállítása 503-vihar idejére

Amíg a DeepSeek hivatalos API túlterhelt, a fő ágens olyan route-ra kerüljön,
amelynek van provider-szintű fallbackje:

- `auto-router` / `auto` (proxy `auto` lánc: deepseek → alibaba-intl/qwen3.8-flash → alibaba/qwen3.8-flash), vagy
- `alibaba-compat` / `qwen3.8-flash` közvetlenül.

Érintett kulcs: `~/.dsh/settings.yaml` → `agent-default-model`. Ez költség- és
route-politikai döntés, ezért nem javaslom automatikus átírását.

### 8.2 A `STREAM_CLOSED` felvétele az újrapróbálható kódok közé

A `retryPolicy` a provider-config alatt értelmezett (a `dsh-llm-retry`
`validateConfig`-ja szerint a gyökér-szintű `retryPolicy` kifejezetten tiltott).
Javasolt illesztés a `settings.yaml`-ba (a pontosság kedvéért: a `backoff`
mezőnevek a `dsh-llm` `backoffSchema`-jából: `initialDelayMs`, `maxDelayMs`,
`jitterRatio`):

```yaml
llm-deepseek:
  retryPolicy:
    mode: normal
    maxRetries: 5
    retryableCodes:
      [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, STREAM_CLOSED]
    backoff:
      initialDelayMs: 500
      maxDelayMs: 10000
      jitterRatio: 0.1
```

Előny: a csonkolt stream újrapróbálás után válaszhoz juthat ahelyett, hogy a turn
meghal. Kockázat: a retry a 15,5 perces csendet is megismételheti — ezért a 8.4
ponttal együtt van értelme.

### 8.3 A tálca health-check javítása

- A `token=False` kritérium eltávolítása vagy a token URL **perzisztens**
  eltárolása (a boot után egyszer, a rotációtól független helyre), hogy a
  naplórotáció ne triggereljen örökre.
- A `pid: 0` miatti „port felszabadítás" hiba kezelése: a port tulajdonosát ne a
  saját PID-fájlból, hanem a tényleges listenerből oldja fel, különben a régi
  példány sosem áll le.
- Újraindítás előtt kötelező ellenőrzés: ha a 3080 már válaszol, **ne** indítson
  új példányt (ez adja az `EADDRINUSE` crasheket).

### 8.4 (DSH-kód) Tartalom-alapú határidő a watchdog mellé

A jelenlegi watchdog a keep-alive kommentekre pulzál, ezért nem véd a
„kapcsolat él, de a modell nem termel" ellen. Javaslat: a `watchdog.pulse()` a
**payload-chunkokra** is fusson (vagy legyen külön `firstByte`/`progress`
határidő), hogy a tartalom nélküli csend `TIMEOUT`-ot adjon — ami viszont már
szerepel a retryelhető kódok között, tehát a 8.2 nélkül is hasznos.

Ez csomagmódosítás (`@deepseek-ai/dsh-llm-deepseek`), a `state`-en kívül nem
érinti a munkaterületet, de a `_npx` cache-t patch-elni kell — csak külön
jóváhagyással.

### 8.5 Amit **ne** tegyünk

- Ne növeljük a `streamIdleTimeoutMs`-t: nem az a szűk keresztmetszet, a watchdog
  eddig sem tüzelt.
- Ne csökkentsük a `maxRetries`-t: a hibát nem a retry-szám okozta.
- Ne nyúljunk a proxy route-jaihoz: a `/healthz` szerint azok rendben vannak.

---

## 9. Megfigyelendő a következő napokban

1. Visszatér-e a `503 Service is too busy` a `deepseek-official`-on (session-naplók
   `'Service is too busy'` találatai)?
2. Keletkezik-e új `STREAM_CLOSED` a `dsh-llm-deepseek` javítása nélkül is?
3. Csökken-e a `token=False` / `automatikus onjavitas` száma a `tray.log`-ban
   (ma 816 / 205) — ha nem, a tálca-ciklus önállóan is javítandó.
4. Marad-e 0 a `harness.err.log` EADDRINUSE sorainak száma?

---

## 10. Változásnapló

- `2026-10-30` — feljegyzés létrehozva a 09:20–09:55 közötti lefagyás
  kivizsgálásáról. **Módosítás nem történt**: a `settings.yaml`, a tálca-szkriptek,
  a proxy és a DSH csomagok érintetlenek.
- `2026-10-30 14:01` — a 11. pont (utólagos megfigyelés) hozzáfűzve; a fejléc
  időbélyegei pontosítva. Továbbra sincs funkcionális módosítás.

---

## 11. Utólagos megfigyelés (14:01) — a tálca-állapot azóta változott

A feljegyzés írásakor, 14:01-kor ellenőriztem a tálca állapotát. A kép részben
más, mint a 04:13–10:51 közötti időszakban, ezért rögzítem:

- A `state\tray.log` **10:51:48-kor megszakad**, és az utolsó sorai már nem
  hibát, hanem sikert mutatnak:
  `10:51:45 harness már fut a 3080 porton (egészséges: True)`.
  Tehát a korábbi 60–90 másodperces önjavító ciklus ekkor megállt (legalábbis
  ebben a naplóban nem folytatódott; azóta ~3 órán át nincs új bejegyzés).
- A `state\native-tray.log` szerint **13:29:48–13:30:07** között a natív tálca
  újraindult, és ezúttal **megtalálta és elmentette a token URL-t**
  (`uj token elmentve: http://127.0.0.1:3080/?token=1cVlvvp3…`), majd elindította
  a harness-t (pid 56384) és az ablakot is.
- A `state\tray.pid` viszont **09:44:28 óta 10844**, vagyis elavult: a pid-fájl
  nem követi a tényleges tálca-példányt. Ez magyarázhatja a 8.3 pontban leírt
  `pid: 0` / „portot nem sikerult felszabaditani" viselkedést.

Következtetés a feljegyzés szempontjából: az 5. pontban leírt ciklus **mérhető
tény** a 04:13:39–10:51 közötti ablakra, de **nem állandó**: a token URL
újbóli megtalálása (új boot) megszünteti a hamis riasztást. A hiba így is valós
(log-rotáció → tartós hamis `token=False`), csak nem folyamatos — a javítási
javaslat (8.3) érvényes marad, a prioritása viszont alacsonyabb, mint a 8.2-é.

A 8.1–8.5 pontok továbbra is **alkalmazatlan javaslatok**.

