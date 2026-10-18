# Alibaba (Qwen) EU bekötés — élő mérések és lelet

**Dátum:** 2026-10-14. **Mérő:** `providers/probe-alibaba*.mjs` (élő API-hívások, kulcs soha nem kerül ki).
**Jelölések:** [M] = ezen a gépen mért, [D] = gyári dokumentáció, [K] = kombináció/becslés. [D]-t nem tekintünk igazoltnak mérés nélkül.

## 1. Végpont, kulcs, régió

| Tétel | Eredmény |
|---|---|
| EU workspace-végpont (`ws-…eu-central-1.maas.aliyuncs.com/compatible-mode/v1`) | [M] `GET /models` 200, 194 ms, 85 id |
| Kulcs régióhoz kötöttsége | [M] a kulcs a `dashscope-intl`-en 401 → EU-kulcs, csak EU-végpont jó |
| `.credentials.yaml` `ALIBABA_API_KEY` | [M] jelen van (refs), a proxy-indító (`run-proxy-service.ps1`) a credential-store-ból tölti a környezetet → a proxy is látja majd |
| `settings.yaml` katalogus vs. élő `/models` | [M] 85/85 id azonos (a lista onnan másolt) |
| **Serving-mátrix** | [M] a 73 chat-próbára alkalmas id közül csak **37 él**; **36 darab 404 "Model not exist"**: minden `qwen3-max*`, `qwen3-coder-plus/next/480b/30b`, `qwen3-8b/32b/30b/235b`, a `qwen3-vl-*`-ból kivéve `qwen3-vl-plus` (az él!), a `qwen3-next-*`, `deepseek-v4-flash` (a sima!), `qwen-plus-2025-09-11/07-28`, `qwen3.5-35b-a3b` ("no suitable services in forward clusters") |

**Lelet:** a `/models` katalógus és a ténylegesen kiszolgált modellek NEM egyeznek — a lista ~44%-a halott. A settings.yaml-ból ki kell ritkítani.

## 2. Protokoll-választás (`api:`)

| Tétel | Eredmény |
|---|---|
| `api: openai-responses` (a jelenlegi beállítás) | [M] **MŰKÖDIK**: a jelenlegi DSH-fősession ezen fut (a session-log `replayState.api=openai-responses`, `stopReason=toolUse`), reasoning-blokkok, tool-callok, streaming mind élnek |
| `/responses` + tools | [M] csak a **LAPIDOS** (`{type:"function", name, parameters}`) tool-forma megy; a chat-stílusú ágyazott `function:{}` forma `response.failed`-t ad. A pi-ai adapter a lapidost küldi → rendben |
| `/responses` + large max-output | [M] csapda: `max_output_tokens=16` → `status=incomplete`, tartalom nélkül — a reasoning_tokens megeszi a keretet. Kicsi maxTokens + thinking = látszólag üres válasz |
| `/responses` modelllefedettség | [M] `qwen3-vl-plus`: **400 "Unsupported model"** — a VL-család és az OCR NEM elérhető responses módban, csak `/chat/completions`-on |
| `/chat/completions` | [M] minden élő modellre működik; tools+stream [M] (`tool_call_deltas`, `finish=tool_calls`, 1354 ms); `enable_thinking`+`reasoning_content` [M] (a `compat.thinkingFormat: qwen` a pi-ai-ban ehz illő forma) |

**Lelet:** az `openai-responses` valid választás a mainline Qwen modellekhez, de **második útvonal kell** (`api: openai-completions`), ha a VL/OCR modellek is kellenek. Egy provider-blokk egy `api` módot tud.

## 3. Képtámogatás (a felhasználói kérdés: "nem támogatja a képeket")

Két külön hiba van:

1. **DSH-dekláció hiany:** a `settings.yaml` alibaba modell-bejegyzésein **nincs `input:` mező** → a harness minden modellt text-onlynek lát. Éles bizonyíték [M]: `read_image` elutasítás: *"model qwen3.8-flash does not declare image input"*. A parser viszont támogatja a soronkénti `input:` mezőt (`dsh-llm-pi-ai/lib/index.js` 682. sor). EZ AZ ELSŐDRENTŐ TEENDŐ.
2. **Végpont-támogatás (mért):** a 37 élő modell közül **24 lát képet** a compatible-mode-on (3-jegyű szám beolvasa: 24/24 találat):

```
qwen3.8-flash, qwen3.8-max, qwen3.8-max-0902, qwen3.7-plus, qwen3.7-plus-2026-05-26,
qwen3.7-flash, qwen3.7-flash-2026-07-15, qwen3.7-max-2026-06-08,
qwen3.6-plus, qwen3.6-plus-2026-04-02, qwen3.6-flash, qwen3.6-flash-2026-04-16, qwen3.6-35b-a3b,
qwen3.5-plus, qwen3.5-plus-2026-02-15, qwen3.5-flash, qwen3.5-flash-2026-02-23,
qwen3.5-27b, qwen3.5-122b-a10b, qwen3.5-397b-a17b,
qwen3-vl-plus, qwen-vl-ocr(!), kimi-k3, kimi-k2.5, kimi-k2.7-code   ← 25 a "777"-re
```
*(qwen3-vl-plus és qwen-vl-ocr csak completions módban.)*

NEM látják [M]: `qwen3.7-max`, `qwen3.7-max-2026-05-20` (400 "Unexpected item type in content"), a `qwen3-coder-*` (szövegesen tagadja), `qwen-plus`, `qwen3.5-35b-a3b` (nincs EU-szolgáltatás), `deepseek-v4-flash-0731`, `deepseek-v4-pro`, `glm-5.1/5.2`. **VESZÉLYES [M]:** a `qwen-flash` és `qwen-flash-2025-07-28` NEM látja a képet, de választ ad (a 777-re "123"-at hallucinált) — ezekre soha ne deklaráld az `input: image`-et.

## 4. Hatékonyság [M]

| Próba | Eredmény |
|---|---|
| kis chat (nostream) | 862 ms; `qwen3-coder-flash` tools 686 ms |
| chat + tools stream | 1354 ms, valódi `tool_calls`, `finish=tool_calls` |
| kép + kérdés (flash) | ~2,2 s; `qwen3-vl-plus` képpel: **236 ms** |
| 123K token kontextus | TTFT 5 383 ms, teljes 6 352 ms, 200 token válasz — a Groq 8K TPM-fala (413) itt nincs |
| implicit cache | [M] ismételt 12K-token prefixnél `cached_tokens=11 264/12 099` (93%) **mindkét API-módban**; a pi-ai a `cached_tokens`→`cacheRead` mappinget mindkét ágon megcsinálja (`openai-completions.js` 1180, `openai-responses-shared.js` 441) |
| rate-limit | [D] a workspace-lap TPM/RPM korlátja EU-n nem látszik a response headerökben ([M] nincs `x-ratelimit-*`); a TERV-beli 1M TPM/600 RPM **EU-ra igazolatlan** |
| ingyenesség | [D] az 1M token gratis kvóta **csak Szingapúrban** érhető el, EU-ban nincs — a számla a bekötéstől fut |

## 5. Árak — Frankfurt/Global listaárak [D] (forrás: alibabacloud.com modellszámítás-oldal, 2026-10-13-i frissítés), USD / 1M token

| Modell | Input | Cache-találat (~10%) | Output | Megjegyzés |
|---|---|---|---|---|
| `qwen3.8-flash` | **0.113** | 0.0113 | **0.382** | fix, 0–1M-ig nincs lépcső |
| `qwen3.7-flash` | 0.028 (≤32K) / 0.083 / 0.165 | ~10% | 0.110 / 0.330 / 0.660 | lépcsős |
| `qwen3.7-plus` | 0.276 (≤256K) / 0.826 | 0.0276 | 1.101 / 3.301 | **korlátozott ideű nappali −20%, éjszakai −60%** (éjjel ~0.110/0.440) |
| `qwen3.8-max` | 1.65 | ~0.165 | 4.951 | Szingapúr 2.00/6.00 — az EU 20%-kal olcsóbb |
| `qwen3-coder-flash` | 0.144 (≤32K) → 0.717 (256K–1M) | ~10% | 0.574 → 3.584 | Szingapúri listával összevetve (0.30/1.50) az EU ~fele ár |
| `qwen3.5-flash` | 0.029 (≤128K) | — | 0.287 | külön EU-sor is van az oldalon |

DeepSeek közvetlen összehasonlítás (repó ártábla [D]): `deepseek-flash` csúcs 0.30/1.20, távol 0.15/0.60, cache 0.006/0.003. **Következtetés [K]:** az EU-s `qwen3.8-flash` flat 0.113/0.382 naponta 24 órában olcsóbb, mint a DeepSeek-flash CSÚCSBAN (2,65×/3,1×) és MÉT CSÚCSIDŐN KÍVÜL IS (1,33×/1,57×); a DeepSeek csak cache-találatban ver (0.003 vs 0.0113).

Alibaba-árazás időszaka: a "csúcs" fogalma náluk a **22:00–08:00 (UTC+8) éjszakai −60%/nappali −20% akció** (only certain models; [D]) = **14:00–24:00 UTC**. Ez pont ellentétes a DeepSeek pék-abbakjaival (01–04, 06–10 UTC) — a két időablak互补 (lásd 7. pont).

## 6. Költségmentesítés (a "DSH-s modell" — `plugins/dsh-ui-extras/lib/index.js`)

A meglévő modell: `MODEL_PRICES` (2155–2178), `modelPrices()` first-substring-match (2181–2189), `isPeakInstant` (2215, DeepSeek-ablakok), `requestCost` (2244), `scanUsage` (2341) a session-logokból (`usage.inputTokens/cacheReadTokens/outputTokens`, `source.model`), `freeSavingsUsd` (2525). Eredmény:.costUsd / .savedUsd a `/ui-extras/usage` végponton át a cost panelen. **Előrejelzés (forward) nincs** — csak lookback; előrejelzésnek a `days=30` és a futó napi átlag tekinthető.

**ÉLES HIBA [M+D]:** a 2172. sor `"qwen3.8": {minden 0}` miatt a FŐ MODELLEM (`qwen3.8-flash`, fizetős EU) **ingyenyesnek minősül** (`isFreeModel` true), a teljes main-route forgalom "megtakarításnak" könyelődik el, és a `qwen3.8-max` is ugyanebbe a sorba esik. A delegált deepseek-v4 és a `qwen3.7-flash` a `deepseek-flash` fallback-árba menne (véletlen közelítő, de nem az EU-s ár).

Javasolt javítás (pontos diff a 7.4 pontban):
1. `"qwen3.8"` kulcs szűkítése `"qwen3.8-27b"`-re (megnyíki az OR `:free` célt, nem a fizetős flagshipt).
2. **Provider-függő illesztés:** a `messageModel(data)` csak a modell-id-t adja vissza, pedig az eseményben ott a `source.provider` is. `modelPrices` kapja meg a providert, és a sorok `"alibaba:qwen3.8-flash"` alakban kulcsolódjanak (ez oldja meg a kimi-k3 "ingyen" ütközést is: az NVIDIA-kimi ingyenes, az Alibaba-kimi fizetős).
3. Új sorok (USD/M; peak=osoff, mert alibaba flat; éjszakai akciót megjegyzésbe): lásd 5. pont táblázat.
4. Fallback alibabaismeretlen modellre: a `qwen3.8-flash` sor, ne a deepseek-flash.

## 7. Automatikus modellváltás csúcsidőre — terv

**Időzónák (UTC), hétköznap [D a forrásaik]:**
- DeepSeek csúcs (drágul 2×-re): **01:00–04:00** és **06:00–10:00**
- Alibaba Global éjszakai akció (−60%): **14:00–24:00** (= 22–8 UTC+8); nappal −20%

**Optimalizálás minőségi szintenként:**
- *Flash szint (main):* nincs időfüggő teendő — `qwen3.8-flash` flat EU-díja [D] minden napszakban veri a deepseek-flash-t [K]; a main modell helyben maradhat. A DeepSeek-pék-nyitós váltás lényege **hogy a drágább DeepSeek-családból maradjon ki a csúcs**: a `deepseek-v4-pro`-t 01–04/06–10 UTC között ne használjuk (0.30 helyett 0.15 + cache), mert abban az ablakban a `qwen3.8-max` (1.65) és a `qwen3.7-plus` nappali (0.221) jobbak/dolcsóbbak minőségóssággal.
- *Plusz/medium szint:* **14:00–24:00 UTC** (Alibaba-éjszaka) a `qwen3.7-plus` efektif ~0.110/0.440 — flash-áron plusz-minőség. A nehéz, hosszú futású delegálások ütemezése ebbe az ablakba = a legnagyobb azonnali nyereség KÓDMódosítás nélkül (már most van `dailyOverrides` + `retune.mjs` + óra-alapú Windows-scheduled feladat-infrastruktúra: `register-monthly-retune.ps1`).
- *Delegált (ingyenes) lánc:* nem változik — a proxy fizeti-lánc-elve csak tartaléknak veszi fel az Alibabát (7.3).

**Megvalósítás a proxy-ban (javasolt, ~40 sor):**
1. `providers/config.json`: `"providers.alibaba": { baseURL, apiKeyEnv: ALIBABA_API_KEY }` (a kulcsot a launcher már most betölti a credential-store-ból [M]).
2. `routes.worker.targets` sorrend: `groq → nvidia → openrouter:free → alibaba/qwen3.7-flash → ollama` — a fizetős Alibaba az ingyenesek MELLETT, a locsi Ollama ELŐTT (a mért ollama 35 s alatt sem ad valódi tool_calls-t [D a config.json megjegyzésből]). Vagy költségkeretben gondolkodva: a free célok után elöl `alibaba/qwen3.7-flash` (0.028/0.110).
3. Új `"timeWindows"` a route-okban: `[{ "utc": [1,4], "targets": [...] }, { "utc": [6,10], … }, { "utc": [14,24], "targets": ["alibaba/qwen3.7-plus", …] }]`, az `effectiveRoute()`-ban óra-szűréssel a `dailyOverrides` mellé; + `fs.watch` for config hot-reload (most csak induláskor olvassa [D a config kommentjéből], a watchdog-felújítás helyett).
4. A DSH main-route nem mehet proxyon át (a main `llm-pi-ai` route statikus), így a fő modell váltása csak `settings.yaml`-újraírással + harness-újraindítással történhet — NEM javasolt automatizálni; helyette a fenti "kihasználjuk, hogy a flash EU-díj flat" érv.

## 7.4 Javasolt settings.yaml-patch (vázlat)

```yaml
  alibaba:
    # … unchanged: apiKeyEnv ALIBABA_API_KEY, api openai-responses, EU baseURL
    defaultContextWindow: 1000000
    defaultMaxTokens: 65536
    models:
      - id: qwen3.8-flash
        name: Qwen3.8 Flash
        contextWindow: 1000000
        maxTokens: 65536
        input: [ text, image ]      # [M] képet lát, válasz is [M]
      - id: qwen3.8-max
        contextWindow: 1000000
        maxTokens: 131072
        input: [ text, image ]
      - id: qwen3-coder-flash
        contextWindow: 1000000
        maxTokens: 65536
      # … minden MARADÉK 37 ÉLŐ modell; a 36 halott ATIDARAB törlendő;
      # qwen-flash / qwen3.7-max: SOHA input:image (hallucinál / elutasítja)

  alibaba-compat:                   # ÚTVONAL: completions, a VL/OCR miatt
    displayName: Alibaba (completions, VL)
    apiKeyEnv: ALIBABA_API_KEY
    api: openai-completions
    baseURL: https://{EU-WorkspaceId}.eu-central-1.maas.aliyuncs.com/compatible-mode/v1
    defaultContextWindow: 262144
    defaultMaxTokens: 32768
    compat: { thinkingFormat: qwen }
    models:
      - id: qwen3-vl-plus
        input: [ text, image ]
      - id: qwen-vl-ocr
        input: [ text, image ]
```

## 8. Nyitott kérdések (mérési lemaradás)

- [M] hiányzik: TPM/RPM korlátok EU-workspace-re (header nem adja); `qwen3.7-flash` tools-támogatás; a tényleges számlázott egységárak (console-ból ellenőrizendő!); `/responses`-on a kimi-k3.
- Az EU-s árlista "Global" deployment-scope sorait használtuk [D]; a számlán a workspace scope-dönti el — első számla után kalibrálni az ártáblát.

## 9. Verdikt a 5 kérdésre

1. **Beállítások:** a provider-blokk érvényes és ÉLŐ (a main session rajta fut), de hiányzik a `contextWindow/maxTokens` (262K/32K-re esik vissza [D a parser kódból: dsh-llm-pi-ai 670–673]), a 85 modellből 36 halott [M], nincs `input:` [M], és a `qwen3-vl-*` responses módban nem használható [M].
2. **Modellválasztás:** a `qwen3.8-flash` main-nak jóváhagyható [M+D: lapos EU-díj, 1M, kép, cache 93%]. A `qwen3-coder-flash`工具-láncra kiváló [M: 686 ms, valódi tool_calls]. A halott id-k törlése kötelező, különben a `/model` választó csalóka.
3. **Hatékonyság:** [M] mért: kis kérés ~0,9–1,4 s, 123K kontextus TTFT 5,4 s — reális; a Groq 413/TPM-probléma megszűnik; cache működik; de EU-ban nincs gratis kvóta [D] → a "ingyen" statisztika most hazudik (6. pont).
4. **Költség-elorejelzési modell:** van lookback + ár-tábla [M a kódban]; az Alibaba bekötése = provider-függő sorok + a "qwen3.8" free-bug javítás (diff a 6/7.4 pontokban). Forward előrejelzés nincs a modellben — csak napok szerinti visszanézés.
5. **Automatikus csúcsváltás:** a leghatékonyabb = (a) main: nincs teendő (flat EU-díj), (b) heavy feladatok átütemezése 14:00–24:00 UTC (Alibaba −60% éj), (c) a DeepSeek-család kizárása a 01–04/06–10 UTC csúcsból, (d) worker-láncba az `alibaba/qwen3.7-flash` fizetős tartalékként az ollama elé, `timeWindows`-al a proxy-ban.

---

# 10. ALKALMAZOTT JAVÍTÁSOK (2026-10-14)

A felhasználó jóváhagyta az ár-tábla javítást, a proxy-lánc bővítést és a
`timeWindows` mechanizmust. Az alábbi fájlok módosultak (mind a repóban):

| Fájl | Változás |
|---|---|
| `providers/proxy.mjs` | `timeWindows` (UTC-óra szerinti lánccsere, éjfélen átforduló ablakkal, opcionális `days`), **config hot-reload** (fs.watch + 800 ms debounce, BOM-tűrő `loadConfig`), `CONFIG`/`PROVIDERS`/`REQUIRED_ENV` mutable |
| `providers/config.json` | `alibaba` + `alibaba-intl` (Szingapúr, előkészítve) provider; `alibaba/qwen3.7-flash` a worker-láncba az ollama ELÉ; új `vision-worker` route; `requiredAnyEnv.vision-worker`; `_timeWindows_megjegyzes` |
| `providers/run-proxy-service.ps1` | a kulcs-feloldó lista bővítve `ALIBABA_API_KEY` + `DASHSCOPE_API_KEY`-vel (enélkül a proxy csendben SKIP-elte volna az Alibaba-célokat) |
| `plugins/dsh-ui-extras/lib/index.js` | Alibaba EU ár-sorok provider-előtaggal + `alibaba/` fallback; a `"qwen3.8"` free-csapda → `"qwen3.8-27b"`; `messageModel` provider-előtagot ad (`source.provider/model`) |
| `providers/verify-savings.py` | ugyanaz a tábla + provider-előtag a `model_of`-ban |
| `~/.dsh/settings.yaml` | alibaba blokk újraszervezve: `alibaba` (openai-responses, 3 flagship) + `alibaba-compat` (openai-completions + `thinkingFormat: qwen`, 34 modell); 36 halott id törölve; 25 látó modellen `input: [text, image]`; `contextWindow/maxTokens` mindenhol; `allowedModels` + `vision-worker` + `alibaba-compat/qwen3.7-flash`. Backup: `settings.yaml.bak-2026-10-14T04-19-22-alibaba` |

## 10.1 Új mérések

| Próba | Eredmény |
|---|---|
| `qwen3.7-flash` tools (stream) | [M] HTTP 200, `tool_deltas=6`, `finish=tool_calls` — **11 982 ms** (lassabb, mint a várt; ezért van az ingyenes célok UTÁN a láncban) |
| `qwen3.7-flash` kép + tool EGY kérésben | [M] `report_number({"n": 777})` — a kép és a tool egyszerre megy |
| proxy `vision-worker` végpont (kép + tool) | [M] HTTP 200, **2 072 ms**, `HIT alibaba/qwen3.7-flash` a proxy-naplóban |
| proxy hot-reload | [M] `CONFIG ujratoltve (hot-reload)` — restart nélkül, a következő kéréstől |
| ár-tábla illesztés | [M] `providers/check-price-table.mjs`: 15/15 eset (Alibaba fizetős, ingyenes lánc 0, provider-ütközés feloldva) |

## 10.2 Időközben megváltozott körülmény: a main modell már DeepSeek

A munka közben a fő modell `alibaba/qwen3.8-flash`-ről
**`deepseek-official/deepseek-flash`-re** váltott (`agent-default-model`), ami a
csúcsidős kérdést konkréttá teszi — a DeepSeek-nek UGYANIS van napi csúcs- és
távoli tarifája:

| Időszak (UTC) | deepseek-flash be/ki | alibaba/qwen3.8-flash (flat) | Nyereség Alibabával |
|---|---|---|---|
| 01–04 és 06–10 (csúcs) | 0.30 / 1.20 | 0.113 / 0.382 | **2,65× / 3,14×** |
| egyéb (távol) | 0.15 / 0.60 | 0.113 / 0.382 | 1,33× / 1,57× |

Vagyis a `timeWindows` most már VALÓDI hasznot hoz a main útvonalon is: a
javasolt lépés egy `smart-main` proxy-route, amelynek `timeWindows`-a a 01–04 és
06–10 UTC ablakban `alibaba/qwen3.8-flash`-re, egyébként DeepSeekre küldi a
kérést (ehhez a proxy `providers` szekciójába fel kell venni a DeepSeek
közvetlen végpontot a meglévő `DEEPSEEK_API_KEY`-jel). Ez a main DSH-route-ot
proxyra kötné, ezért külön döntést igényel.

## 10.3 Ismert korlát

A proxy-n BELÜL történő fizetős ráesés (pl. a `worker`/`vision-worker` route
ingyenes céljai helyett az `alibaba/qwen3.7-flash` válaszol) a DSH
költség-paneljén **ingyenesnek** látszik, mert a session-log a route nevét
(`worker`) rögzíti, nem az upstream modellt. A valós fizetős forgalom a
`proxy.out.log` `HIT alibaba/...` sorai­ból számolható. Opcionális javítás: a
proxy egyedi válasz-fejlécben jelezze a tényleges upstream modellt, és a plugin
azt is olvassa.

## 10.4 Nyitott: Szingapúr

A `DASHSCOPE_API_KEY` **nincs** a credential-store-ban (`refs`) és a
környezetben sem — a szingapúri provider elő van készítve a config.json-ban
(`alibaba-intl`), de kulcs nélkül a proxy SKIP-eli. Az 1M token/modell gratis
kvóta [D] csak Szingapúrban él, ezért ez a cél ingyenes delegálásra ideális.
A kulcsot a Model Studio szingapúri workspace-ében kell létrehozni, és a
DSH credential-store-ba `DASHSCOPE_API_KEY` néven felvenni.

---

# 11. SZINGAPÚR BEKÖTVE (2026-10-14, a felhasználó CSV-jéből)

A kapott workspace: `{SG-WorkspaceId}` (ap-southeast-1). **Nem** a régi
`dashscope-intl.aliyuncs.com` domain, hanem a workspace-domain forma:
`https://{SG-WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.
A kulcs a credential-store-ba `DASHSCOPE_API_KEY` néven került (időbélyeges
backuppal), és a `run-proxy-service.ps1` mostantól ezt is betölti.

| Próba [M] | Eredmény |
|---|---|
| `GET /models` | 200, **99 modell** (az EU-n 85) |
| Csak Szingapúrban élő id-k | `qwen3.8-omni-flash` (+realtime), `glm-5.3`, `glm-5.3-prime`, `deepseek-v4.1-flash`, `kimi/kimi-k3`, `qwen3.8-27b`, `qwen3-audio-3.1-realtime-plus`, `qwen3.8-livetranslate-flash-realtime` |
| `qwen3.8-flash` stream+tools | 1 229 ms (EU: 1 354 ms) |
| `qwen3.7-flash` stream+tools | **3 041 ms** (EU-n ugyanez 11 982 ms volt) |
| `qwen3-coder-flash` stream+tools | 1 063 ms |
| kép + tool (`qwen3.8-flash`) | `report_number({"n": 777})` |

**Következmény:** Szingapúr lett az ELSŐ fizetős szintű cél a láncokban
(`worker` és `vision-worker`), mert (a) a gratis 1M/modell kvóta ott él,
(b) gyorsabb, (c) gazdagabb a katalógus. Az EU-példány mögötte tartalék.

# 12. STABILITÁSI MÉRÉS — miért kell a cooldown

| Végpont | nagy kérés, NEM-stream (30 s korlát) | nagy kérés, STREAM |
|---|---|---|
| Szingapúr | 10,1 s / **TIMEOUT** / **TIMEOUT** / **TIMEOUT** / 21,8 s | 3/3 OK (TTFT 1,2–1,3 s) |
| EU (Frankfurt) | **TIMEOUT** / 5,5 s / **TIMEOUT** / 15,8 s / 3,2 s | 2/3 OK (TTFT 0,6–1,0 s), 1/3 fejlécet sem küldött |
| kis kérés (mindkettő) | 0,7–8 s, timeout nélkül | — |

**Értelmezés:** a nem-stream nagy kéréseknél a szerver csak a teljes generálás
után küld fejlécet, és a qwen3.8-flash hosszú reasoningja 30 s fölé viheti — ez
nem hiba, hanem a mérési mód artefaktja. A **valódi** probléma az, hogy az
EU-végpont szórványosan (≈1/3) **fejlécet sem küld**, streamen sem. A DSH
streamel, ezért a gyakorlatban ritka, de egy beragadt cél 120 s-ot vitt volna el.

**Megoldás (beépítve a proxyba):**
1. Provider-szintű `connectTimeoutMs`: `alibaba` és `alibaba-intl` = **30 s**,
   így a beragadt cél hamar átadja a helyét (ollama marad 300 s).
2. **Cél-szintű cooldown** (`targetCooldownMs` = 90 s): a hibázott cél a lánc
   **végére** kerül (nem esik ki), siker esetén a cooldown törlődik; a
   `/healthz` `cooldowns` mezője mutatja. Éles forgalmon igazolva: egy Groq
   400-as (visszajátszott `reasoning_content`) után a következő kérések már a
   lánc végére sorolták a Groqot.

# 13. `auto` — INTELLIGENS MODELLVÁLASZTÓ

A `providers/config.json` `routes.auto` szabályai (első illeszkedő nyer):

| Szabály | Feltétel | Cél-lánc |
|---|---|---|
| `kep` | a kérés tartalmaz kép-tartalmat | `alibaba-intl/qwen3.8-flash` → `alibaba/qwen3.7-flash` → `alibaba/qwen3.8-flash` |
| `hosszu-kontextus-180k` | becsült > 180 000 token | `alibaba-intl/qwen3.8-flash` → `alibaba/qwen3.8-flash` → `deepseek/deepseek-flash` |
| `deepseek-csucs-01-04` | UTC 01–04, hétköznap | `alibaba-intl/qwen3.8-flash` → `alibaba/qwen3.8-flash` → `deepseek/deepseek-flash` |
| `deepseek-csucs-06-10` | UTC 06–10, hétköznap | ugyanaz |
| (alap) | egyik sem | `deepseek/deepseek-flash` → tartalékok |

A DeepSeek csúcsablakban a `deepseek-flash` ára **duplázódik** (0.30/1.20), a
qwen3.8-flash EU-díja lapos (0.113/0.382) → **2,65× / 3,14×** megtakarítás
azokban az órákban, automatikusan.

**Mérési igazolás** (`providers/probe-auto.mjs`, átmeneti teszt-route-okkal
minden ág külön): alap → deepseek HIT; kép → SG qwen3.8-flash HIT; tool →
SG qwen3.7-flash HIT; nagy kontextus → EU qwen3.8-flash HIT; időablak →
EU qwen3.8-flash HIT; élő `auto`: stream+tool 11 tool-delta, `finish=tool_calls`,
kép → `777`. A korábban 120 s-osat timeoutoló nagy-kontextus eset a cooldown +
30 s-os célkorlát után **1 532 ms**.

A DSH-ban az `auto-router` provider (`~/.dsh/settings.yaml`) teszi a választóba:
`Auto (kép / csúcs / hosszú kontextus szerint)`, valamint `vision-worker` a
kép-delegáláshoz. **A harness-újraindítás után jelenik meg.**

# 14. Az összes módosított/új fájl (2026-10-14)

| Fájl | Szerep |
|---|---|
| `providers/proxy.mjs` | `rules` (auto szelektor), `timeWindows`, hot-reload, **cooldown**, BOM-tűrő config |
| `providers/config.json` | EU + SG + DeepSeek provider, `auto`/`vision-worker` route-ok, cél-időkorlátok, `targetCooldownMs` |
| `providers/run-proxy-service.ps1` | ALIBABA / DASHSCOPE / DEEPSEEK kulcsok betöltése |
| `providers/apply-alibaba-settings.mjs` | settings.yaml: 37 élő modell, 25 látó, két Alibaba-útvonal |
| `providers/apply-auto-provider.mjs` | settings.yaml: `auto-router` provider (Auto modell) |
| `providers/add-sg-key.mjs` | a szingapúri kulcs felvétele a credential-store-ba |
| `providers/check-price-table.mjs` | ártábla-önellenőrzés (15/15) |
| `providers/probe-alibaba*.mjs`, `probe-singapore.mjs`, `probe-proxy.mjs`, `probe-auto.mjs` | újramérhető próbák |
| `plugins/dsh-ui-extras/lib/index.js` | Alibaba-árak provider-előtaggal, `qwen3.8` free-csapda javítva |
| `providers/verify-savings.py` | a költség-tükör frissítve |

**Üzemeltetési megjegyzés:** ebben a sessionben a proxy kezelt háttér-jobként fut
(a pwsh-eszköz a hívás végén kilövi a folyamafát, ezért a `Start-Process`-szel
indított példány elhalt; a watchdog viszont visszahozta). Tartósításhoz a
`providers\run-proxy.cmd` (bejelentkezéskori) út vagy a watchdog szolgál.

---

# 15. KÖLTSÉGKEZELÉS AZ ALIBABÁRA (2026-10-14, második kör)

## 15.1 Amit a felhasználó kérdezett, és ami elkészült

| Kérés | Állapot |
|---|---|
| „Az ingyenes lánchoz hozzá lett adva a szingapúri ingyenes keret?" | **Igen** — a `worker` láncban az ingyenes célok után, a `vision-worker`-ben elsőként, az `auto`-ban is szerepel. A költség-modellben pedig **modellenkénti keret-jóváírás** készült (lásd 15.2). |
| „Be van építve az alibabás költségkezelés?" | **Igen** — EU + szingapúri ár-sorok provider-előtaggal, a `"qwen3.8"` free-csapda javítva, provider-család bontás, SG-keret. (Az első körben csak az EU-árak kerültek be.) |
| „A láblécben a DSH egyenlege helyett `$/$`, DSH/Alibaba, tooltippel" | **Kész** — a pill felirata `DSH / Alibaba`, értéke `$DeepSeek / $Alibaba`; a tooltip a bontást, az SG-keretet és a **DeepSeek-egyenleget is** mutatja (utóbbi nem veszett el). Ha a host még régi (nincs `spend` mező), automatikusan a régi egyenleg-pill marad. |
| „Csak a fizetős egyenleg látszik a láblécben, a grátisszal növelt nem" | **Kész** — a pill bal oldala a DeepSeek API `total_balance`-ét mutatja (`total` = `topped_up_balance` + `granted_balance`, a konzollal egyezően), nem csak a feltöltött részt. A bontás (`feltöltött + jóváírt = összesen`) a tooltipben marad; régi host (`total` nélkül) a két részből számol, és fixálja a `tools/check-plugin.mjs` ellenőrzése. |
| „A statisztikáknál is kéne kezelni az alit" | **Kész** — a használati sor tooltipje új „Szolgáltatók szerint" blokkot kap (DeepSeek / Alibaba EU / Alibaba Szingapúr / ingyenes lánc), plusz az SG-keret állapotát és az Alibaba-árak pontosítását. |

## 15.2 Hogyan számol a modell

1. **Ár-sorok** (`MODEL_PRICES`): `alibaba/…` = EU Frankfurt, `alibaba-intl/…` =
   Szingapúr (International), mindkettőhöz generikus `…/` fallback, hogy egy
   ismeretlen Alibaba-modell se essen a DeepSeek-árra.
2. **Ingyenes keret**: `SG_FREE_TOKENS_PER_MODEL` = 1 000 000 token/modell,
   `SG_FREE_WINDOW_DAYS` = 90. A `scanUsage` modellenként számolja a szingapúri
   tokeneket, a keret alatti részt **0 USD-ra** írja jóvá, és levonja a
   összköltségből, a modell-sorokból és a napi sorokból is.
   **Korlát:** a DSH nem látja a számla oldali keret-állapotot, ez saját
   naplóinkból becsült érték — más eszköz ugyanazzal a kulccsal hamarabb
   kimerítheti.
3. **Provider-bontás**: `providerFamily()` a `source.provider` előtagból
   sorolja a kérést `deepseek` / `alibabaEu` / `alibabaSg` / `free` / `other`
   családba; a `spend` blokk adja a lábléc párját
   (`deepseekUsd` / `alibabaUsd`, illetve EU és SG bontásban).
4. **Ismert közelítés**: a proxy-útvonalakon (`worker`, `vision-worker`,
   `auto`) a napló a **route nevét** rögzíti, nem az upstream modellt, ezért az
   ottani Alibaba-költség közelítés — a valós cél a `proxy.out.log`
   `HIT alibaba…` soraiból olvasható. Ezt a tooltip is kiírja.

## 15.3 Ellenőrzés

| Próba | Eredmény |
|---|---|
| Ártábla-besorolás (`providers/check-price-table.mjs`) | [M] **19/19** (EU + SG + ingyenes lánc + DeepSeek + provider-ütközés) |
| Plugin host és kliens szintaxis | [M] `node --check` OK mindkettőn |
| Élő usage-végpont | [M] `GET /ui-extras/usage?days=30` → 200, **régi shape** (a plugin induláskor töltődik) → az új `spend`/`byProvider`/`alibabaSg` mezők **a DSH-újraindítás után** jelennek meg |
| Valós naplón futó független keresztellenőrzés (`providers/verify-savings.py`) | [M] 29 899 kérés; **DeepSeek $37,06 / Alibaba EU $0,1254 (46 kérés) / ingyenes lánc $0**; a korábban „ingyenesnek" mutatott 46 Alibaba-kérés most helyesen **fizetős tételként** látszik |

## 15.4 Amit a felhasználónak kell tennie

**Indítsd újra a DSH-t** (a plugin host- és kliens-félje induláskor töltődik):
ezáltal jelenik meg az `Auto` modell a választóban, a lábléc új `$DSH / $Alibaba`
értéke és a statisztika Alibaba-bontása. Utána érdemes egy pillantást vetni a
tooltipre: ha a szám nem egyezik a várakozással, a
`node providers/check-price-table.mjs` és a `python providers/verify-savings.py`
mutatja az ártábla és a naplók szerinti értéket.

---

# 16. ORCHESTRÁCIÓ-ELEMZÉS: pro orchestrator + flash gyermekek?

**Kérdés:** ha a feladatok elosztását `deepseek-v4-pro`-ra bíznánk, a fő modell
pedig következetesen flash modelleknek delegálna minden részfeladatot, az
jelentene-e minőségi és költségmegtakarítást?

**Módszer:** `providers/analyze-orchestration.mjs` — a valós session-naplókból
(30 nap, 64 fő- és 138 gyermek-session) méri a tokeneket, a cache-arányt, a
lépésszámokat, majd újraárazza ugyanazt a main-tokenvolument több modellen.

## 16.1 A mért forgalom

| | kérés | cache-miss input | cache-találat | output | cache-arány | költség |
|---|---|---|---|---|---|---|
| **Fő (main)** | 26 914 | 22,4 M | **9,60 Mrd** | 23,4 M | **99,8%** | **$54,57** |
| **Gyermek (delegált)** | 3 030 | 16,3 M | 140,1 M | 1,6 M | 89,6% | **$0,30** |
| Összesen | 29 944 | — | — | — | — | $54,87 |

- A **fő route a költség 99,4%-a**, a delegált munka **0,55%**.
- Átlagos kontextus: **fő kérés 357 602 token**, gyermek kérés 51 626 token.
- Lépés/fokorduló: fő 28,8 · gyermek 22,2.

**A fő költség motorja a kontextus-újraküldés:** 9,6 milliárd cache-elt input
token 30 nap alatt — ez önmagában ~$29 (völgyáron) a ~$46-ból. Nem az output,
hanem az, hogy egy 357K tokenes kontextust lépésenként újra átküldünk
(cachelve, de nem ingyen).

## 16.2 Ugyanaz a main-tokenvolumen más modelleken (völgyáron)

| Main modell | költség | a mostanihoz képest |
|---|---|---|
| `deepseek-flash` (mostani) | **$46,21** | 1,00× |
| `deepseek-flash` **csúcsáron** | $92,42 | 2,00× |
| `alibaba/qwen3.8-flash` EU (lapos) | ~$119,97 | 2,60× |
| `alibaba-intl/qwen3.8-flash` SG (lapos) | $158,39 | 3,43× |
| `deepseek-v4-pro` | **$272,37** | **5,89×** |

**A pro orchestrator 5,89×-es main-költséget jelentene.** Nulla egyenleghez a
pro-nak ugyanazt a munkát **83%-kal kevesebb main-tokenből** kellene elvégeznie
(28,8 lépés/fokorduló helyett ~5) — ez a gyakorlatban nem reális.

## 16.3 A korábbi csúcsidős javaslat HELYESBÍTÉSE

A 13. szakaszban azt írtam, hogy a DeepSeek-csúcsban (01–04, 06–10 UTC) érdemes
Alibabára váltani, mert a listaár 2,65×/3,14× kedvezőbb. **Ez a tokenmix
ismeretében téves:** a cache-találat a fő forgalom 99,8%-a, és ott a DeepSeek
olcsóbb (0,006/M csúcson), mint az Alibaba (0,0113/M EU, 0,015/M SG). A mért
volumenre számolva az Alibaba **~30%-kal drágább** a csúcson is (EU ~$120 vs
flash-csúcs $92). Ezért a `deepseek-csucs-*` szabályokat **eltávolítottam** az
`auto` route-ból; az Alibaba a **látás**, a **hosszú kontextus** és a
**tartalék** szerepét kapja. *(Pontosítás a 18. szakaszban: az Alibaba **friss
tokenen olcsóbb** — a mért drágulás oka a 10%-os cache-tarifa és a sávos árazás
a nagy, cache-elt kéréseknél, nem az alapszintű listaár.)* A `timeWindows`/`rules` mechanizmus változatlanul
elérhető, ha egy miss-nehéz (friss, nagy, nem cache-elt) munkaterhelésnél mégis
megérné.

## 16.4 Mi hoz valódi megtakarítást

1. **Agresszív delegálás — igen.** A gyermekek 0,55%-ba kerülnek, miközben
   51,6K tokenes kontextuson dolgoznak a fő 357,6K-ja helyett. Kulcs: a
   gyermek **rövid digestet** adjon vissza nyers tartalom helyett, mert ezzel a
   fő kontextus nem hízik — a fő költsége a kontextus méretével arányos.
2. **A fő kontextus karcsúsítása** — a legnagyobb tétel (9,6 Mrd cache-elt
   token). Kontextus-tömörítés, kevesebb felesleges kör, nagy tool-kimenetek
   kiszervezése gyermekbe.
3. **Szelektív pro — igen; fanatikus pro — nem.** Egy pro tervező/ellenőrző
   kérés ~30K friss tokenen ≈ **$0,02**; ha ez megelőz egy 5 lépéses,
   elrontott kört (5 × 357K cache-elt token csúcsáron ≈ $10,7), bőven
   megtérül. Vagyis: pro-t **csak a nehéz döntési pontokra**, nem a teljes
   orchestrációra.
4. **Az ingyenes lánc** (Groq/NVIDIA/OpenRouter + a szingapúri keret) továbbra
   is $0 — a delegálás akkor is csak ~$5 lenne 30 napra, ha fizetős flash-re
   tennénk (mért: $0,30).

---

# 17. ESZKALÁCIÓ — a flash felfelé küldi a döntést (2026-10-14)

**Elnevezés.** Amit a felhasználó leírt, az **nem delegálás** (az lefelé megy,
olcsóbb munkásra), hanem **eszkaláció**: a flash dolgozik, és amikor elakad,
*felfelé* adja a döntést a pro-nak. A szakirodalom **kaszkád-routingnak**
(cascade) vagy eszkalációs politikának hívja; a lényeg, hogy a drága modell
csak akkor lép be, amikor a várható megtakarítás (elkerült hibás körök) nagyobb
a belépés költségénél.

## 17.1 Az eszkaláció mérése (`providers/analyze-escalation.mjs`)

| Tétel | Érték |
|---|---|
| Fő sessionok (30 nap) | 61 session, **26 974 lépés**, **$53,51** |
| Átlag / session | $0,877 · **442 lépés** |
| Medián session-végi kontextus | **317 778 token** |
| **Flash-lépés** (cache-elt) | **$0,0010** (völgy) / $0,0019 (csúcs) |
| **Pro belépés** (teljes kontextus, cache-vesztés!) | **$0,2097** |
| Pro további lépés (cache-elt) | $0,0070 (7× a flash) |
| **Pro belépés TÖMÖR BRIEF-fel** (30K friss token) | **$0,0198** |
| **Fedezeti pont** teljes kontextus átvitelével | **220** elrontott flash-lépés |
| **Fedezeti pont** tömör brief-fel | **21** elrontott flash-lépés |

**Két következtetés:**
1. A modellváltás **a cache-t is elviszi** (a DeepSeek cache modellhez kötött),
   ezért a teljes beszélgetés átvitele ~$0,21 — 200× egy flash-lépés. A
   *feladat* átadása tömör brief-fel viszont csak ~$0,02.
2. „Tíz rossz próbálkozás" önmagában **nem** indokol eszkalációt (10 × $0,001 =
   $0,01); a valódi tét a **hosszú, sok lépéses munka**: a legnagyobb sessionok
   1 000–2 300 lépésesek ($2,4–4,1 egyenként).

**Mérési korlát, őszintén:** a tool-eredmények szabad szövegében az „error" szó
nem használható jelzés — fájltartalomban is előfordul, és a mérésben 98%-os
hamis hibaarányt adott. A megbízható jel az **ismétlődő azonos tool-hívás**
(ugyanaz a név ÉS argumentum) és a beszélgetés hossza.

## 17.2 Ami elkészült

1. **Proxy-detektor** (`proxy.mjs`): a `requestSignals` mostantól méri a
   beszélgetés hosszát és az ismétlődő hívásokat (`messages`, `repeatedCalls`,
   `maxRepeat`); a `rules` ezekre is szűrhet (`minMessages`, `minRepeatedCalls`,
   `minMaxRepeat`).
2. **Eszkalációs szabály** az `auto` route-ban:
   `{ "name": "eszkalacio-porgas", "minMessages": 40, "minMaxRepeat": 3,
   "targets": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"] }` —
   hosszú beszélgetés **és** legalább 3× ismétlődő hívás esetén a következő
   lépést a pro kapja. Kikapcsolás: a szabály törlése.
3. **Gyermek-eszkaláció**: a `deepseek-official/deepseek-v4-pro` bekerült a
   `subagent-model-selection.allowedModels` listába, így a flash **tömör
   brief-fel** is tud pro-t kérni (ez a 21 lépéses fedezeti pontú, olcsó út).

## 17.3 Ellenőrzés (`providers/probe-escalation.mjs`)

| Eset | Eredmény |
|---|---|
| 25 kör + 3× ugyanaz a hívás | [M] **deepseek-v4-pro** — `AUTO auto: eszkalacio-porgas (msg=52, ismetles=2 max=3)` |
| ugyanaz rövid (5 kör) beszélgetésben | [M] deepseek-flash (nincs eszkaláció) |
| tiszta hosszú (25 kör, mind más hívás) | [M] deepseek-flash (nincs hamis pozitív) |

## 17.4 Ajánlott politika

- **Alap:** flash dolgozik (a lépések olcsók), a drága modell csak eszkalációra.
- **Eszkalációs triggerek:** ismétlődő azonos hívás (≥3), hosszú beszélgetés,
  explicit tool-hiba, vagy a felhasználó kérése.
- **Forma:** a *feladatot* eszkaláld tömör brief-fel (állapot, korlátok, mi
  hibázott, elvárt kimenet) — ne a beszélgetést.
- **Amit NE tegyél:** ne vezesd át a teljes orchestrációt pro-ra (mért 5,89×),
  és ne eszkalálj rövid, jól haladó munkát.

---

# 18. MODELLVÁSÁRLÁS: hol olcsóbb az Alibaba, és mennyiért adják a DeepSeek v4-et?

**Kérdés:** (1) tényleg drágább-e az Alibaba csúcsidőben is, amikor bizonyos
modellek völgyidőben is olcsóbbak a DeepSeeknél? (2) a DeepSeek v4 modellek az
Alibaba EU-n vagy Szingapúron keresztül olcsóbbak vagy drágábbak?

**Módszer:** `providers/analyze-model-choice.mjs` — ugyanazokat a valós fő-route
kéréseket (30 nap, 26 954 kérés) árazza újra modellenként, **sávos (tier)
árazással** és a valós cache-aránnyal.

## 18.1 A mért kérések alakja (ez dönt mindent)

| Mutató | Érték |
|---|---|
| Kérésméret medián | **335 454 token** |
| ≤32K | 2,3% |
| ≤128K | 15,3% |
| **>256K** | **62,5%** |
| Cache-arány | **99,8%** |

## 18.2 Ugyanazok a kérések más modelleken

| Modell | költség | a DeepSeek-flash-hoz |
|---|---|---|
| **deepseek-flash (közvetlen)** | **$53,36** | 1,00× |
| qwen3.8-flash (Ali EU) | $120,07 | 2,25× |
| qwen3.8-flash (Ali SG) | $158,52 | 2,97× |
| qwen3.7-flash (Ali EU) | $161,95 | 3,03× |
| deepseek-v4.1-flash (Ali EU) | $176,19 | 3,30× |
| deepseek-v4.1-flash (Ali SG) | $187,23 | 3,51× |
| qwen3.5-flash (Ali EU) | $189,55 | 3,55× |
| deepseek-v4-pro (közvetlen) | $216,93 | 4,07× |
| **deepseek-v4-pro-0813 (Ali EU)** | **$776,68** | **14,56×** |

**A három ok, amiért a friss-tokenen olcsóbb Alibaba mégis drágább a main
route-on:**
1. **Cache-tarifa:** a DeepSeek a cache-találatot az input **2%**-án adja
   (0,006/0,30), az Alibaba **10%**-án — a forgalom 99,8%-a cache-találat.
2. **Sávos árazás:** az Alibaba a *teljes kérés* mérete szerint sorol (a
   `qwen3.7-flash` 256K felett 0,165/0,66), és a kérések 62,5%-a >256K.
3. **A friss token olcsóbb, de kevés van belőle:** 22,0M miss vs **9,61 Mrd**
   cache-elt token.

**A felhasználónak igaza van abban, hogy léteznek olcsó, használható modellek:**
`qwen3.7-flash` ≤32K sávon **0,028 / 0,110** — ez a deepseek-flash völgyárának
(0,15 / 0,60) **ötödrésze**, cache-en pedig 0,0028 vs 0,003 (egál). Mért
képességek: valódi tool-hívás, **lát**, 1M kontextus. Kis, friss munkára tehát
egyértelműen ő a nyerő.

## 18.3 DeepSeek v4 az Alibabán keresztül

| Modell | Input (idle/busy) | Output (idle/busy) | Cache-találat | vs közvetlen |
|---|---|---|---|---|
| `deepseek-v4.1-flash` **Ali EU (Global)** | **0,141 / 0,283** | **0,565 / 1,131** | 10% → 0,0141 | friss tokenen **~6%-kal olcsóbb**, cache-en 4,7× drágább |
| `deepseek-v4.1-flash` Ali SG (Intl.) | 0,15 / 0,30 | 0,60 / 1,20 | 10% | friss tokenen egyezik a közvetlennel |
| `deepseek-v4-pro-0813` **Ali EU** | **0,636 / 1,272** | **1,908 / 3,816** | 10% → 0,0636 | friss tokenen **~4%-kal olcsóbb**, cache-en 2,9× drágább |
| `deepseek-v4-pro` Ali EU | 1,65 (lapos) | 3,301 (lapos) | 10% | inputen **2,5× drágább** (idle), outputon olcsóbb |
| `deepseek-v4-pro` Ali SG | 2,400 (lapos) | 4,800 (lapos) | 10% | drágább |
| DeepSeek közvetlen (referencia) | 0,15–0,30 / 0,66–1,32 | 0,60–1,20 / 1,98–3,96 | **2%** | — |

**Válasz:** az Alibaba **friss tokenen 4–6%-kal olcsóbban** adja ugyanazokat a
DeepSeek v4 modelleket (EU/Global scope), mint a közvetlen DeepSeek — de a
**10%-os cache-tarifa** miatt a cache-nehéz agent-munkára összességében
**3,3× (flash) / 14,6× (pro)** drágább. Szingapúrban a DeepSeek-sorok
egyáltalán nem versenyképesek (pro: 2,4/4,8 lapos).

## 18.4 Meret-fuggo politika — miert nem az a valasz

Kis keres → Qwen, egyébként DeepSeek szabály a valós forgalmon:

| Küszöb | megtakarítás |
|---|---|
| <32K → qwen3.7-flash | 0,7% |
| <64K → qwen3.7-flash | 1,1% |
| Elméleti alsó korlát (kérésenkénti optimum) | **6,1%** |

Ezen felül **minden váltás eldobja a cache-t** (a cache modellhez kötött), ezért
a kérésenkénti váltogatás a nagy, cache-elt lépéseknél **többe kerül, mint amit
hoz**. A tanulság: a modellt **munkatípus/session szinten** kell választani,
nem kérésenként. Ezért a `hosszu-kontextus-180k` szabályt
`friss-nagy-kontextus`-ra szűkítettem (`maxMessages: 6`): csak a friss, nagy
bemenetre váltunk (ott az Alibaba olcsóbb ÉS 1M kontextust ad), az agent-loop
nagy, cache-elt lépései a DeepSeeken maradnak.

## 18.5 Hol nyer valóban az Alibaba

1. **Friss, kis munka** (≤32K): 5× olcsóbb, és a `qwen3.7-flash` tud toolt és lát.
2. **Kép**: a DeepSeek-flash nem lát (mért), a Qwen igen.
3. **Szingapúri ingyenes keret**: 1M token/modell, nulla költség.
4. **Kimenet-nehéz, rövid bemenet**: output 0,110 vs 0,60 (5,5×).
5. **Adatrezidencia**: EU (Frankfurt) és Szingapúr egy számlán.

---

# 19. INTELLIGENS AUTOMATIKUS MODELLVÁLASZTÁS (2026-10-14)

A `auto` route már nem fix szabálylista: a proxy **költség- és képesség-alapú
szelektort** futtat minden kérésre (`proxy.mjs`: `chooseTarget`, `estimateCost`,
`sessionKeyOf`).

## 19.1 A négy elv (mind mérésből)

1. **Költség-alapú döntés.** A `config.json` `pricing` táblájából célonként
   becsli a kérés várható költségét: sávos ár (`tiers`), a session korától függő
   cache-arány, a DeepSeek csúcs-ablaka (`peakMiss/peakHit/peakOut`), és a
   szingapúri **ingyenes keret** (`freeQuotaTokens`, amíg a becsült fogyasztás a
   keret alatt van → 0 USD). A **legolcsóbb alkalmas** cél nyer — nem a
   felsorolás sorrendje.
2. **Kemény képesség-szűrés.** `contextWindow ≥ becsült token`, és képet csak
   `vision: true` cél kaphat. (A `deepseek-flash` **lát** — ebben a sessionben
   beolvasta a 777-es tesztképet —, ezért nála `vision: true`.)
3. **Session-ragadóság.** A beszélgetés azonosítója a rendszer-üzenet + az első
   felhasználói üzenet lenyomata; a választott cél ehhez kötődik, és **nem
   váltogatunk** — mert a modellváltás a szolgáltató cache-ét is eldobja. A
   váltás csak akkor történik meg, ha a várható nyereség
   `assumedRemainingSteps` lépésre meghaladja a **cache-újraeles** egyszeri
   költségét (`size × (új miss-ár − régi cache-ár)`).
4. **Eszkaláció felülír mindent.** A `rules` előbb fut: pörgő munka
   (hosszú beszélgetés + ismétlődő hívás) → pro; kép → látó lánc.

## 19.2 A döntési tábla (amiből a szelektor dolgozik)

| Cél | friss input | cache-találat | kimenet | kontextus | lát |
|---|---|---|---|---|---|
| `deepseek/deepseek-flash` | 0,15 (csúcs 0,30) | 0,003 (0,006) | 0,60 (1,20) | 1M | ✔ |
| `alibaba/qwen3.7-flash` EU | 0,028 / 0,083 / 0,165 sávonként | 10% | 0,11 / 0,33 / 0,66 | 1M | ✔ |
| `alibaba-intl/qwen3.7-flash` SG | 0,03 / 0,10 / 0,20 | 10% | 0,13 / 0,40 / 0,80 | 1M | ✔ |
| `alibaba/qwen3.8-flash` EU | 0,113 | 0,0113 | 0,382 | 1M | ✔ |
| `alibaba-intl/qwen3.8-flash` SG | 0,15 | 0,015 | 0,47 | 1M | ✔ |

Az SG soroknál `freeQuotaTokens: 1000000` — amíg a keret tart, a cél **0 USD**,
ezért a szelektor addig ingyen dolgozik.

## 19.3 Ellenőrzés (`providers/probe-intelligent.mjs`)

| Eset | Választott cél | Becsült költség |
|---|---|---|
| ~293K token, cache-elt (8 üzenet) | **deepseek/deepseek-flash** | ~$0,00671/lépés |
| ~98K token, cache-elt (6 üzenet) | **alibaba/qwen3.7-flash** (EU) | ~$0,00187/lépés |
| ~2K token, friss | **alibaba/qwen3.7-flash** (EU) | ~$0,00012/lépés |
| új session, keret szabadon | **alibaba-intl/qwen3.7-flash** | **$0,00000** (ingyenes keret) |
| ugyanaz a session, következő lépés | **RAGADOS** (nem vált) | — |
| hosszú + ismétlődő hívás | **deepseek-v4-pro** (eszkaláció) | — |
| kép a kérésben | **alibaba-intl/qwen3.8-flash** (látó lánc) | — |

Ebből **3/3** a valódi átfordulási ponton: 293K-nál a DeepSeek nyer (a Qwen
256K felett a top sávba esik), 98K-nál az EU Qwen, kis friss kérésnél szintén az
EU Qwen (5× a DeepSeek alatt).

**Egy korábbi szabályt ezért töröltem:** a `friss-nagy-kontextus`
(`minTokens: 180000, maxMessages: 6`) felülírta a szelektort és drágább célt
választott — a sávos árazást a szelektor pontosabban kezeli. A `kep` szabály
maradt (képességet garantál és helyi tartalékot ad).

## 19.4 Megfigyelhetőség és hangolás

- `GET /healthz` → `intelligent`: `sessions` (melyik beszélgetés melyik célon
  ragadt be, hány lépés, hány váltás), `quotaUsed` (becsült ingyenes-keret
  fogyasztás célonként), `decisions` (az utolsó 12 döntés indoklással),
  `tuning`.
- Hangolás a `config.json`-ban: `assumedCachedShare` (0,9),
  `assumedOutputTokens` (900), `assumedRemainingSteps` (8), `switchMarginPct`.
- A napló sorai: `AUTO auto: VALASZTAS — költség-optimális (…)` /
  `AUTO auto: RAGADOS — …` / `AUTO auto: eszkalacio-porgas …`.

## 19.5 Használat

A DSH-ban a modellválasztóban az **`Auto (kép / csúcs / hosszú kontextus
szerint)`** választja ezt a route-ot (`auto-router/auto` a `settings.yaml`-ban).
A **DSH-újraindítás** után jelenik meg; utána minden kérés automatikusan a
fenti logika szerint megy.

---

# 20. AUTOMATIKUS ÚJRAMÉRÉS ÉS OPTIMALIZÁLÁS (`autotune.mjs`)

## 20.1 A ciklus (hat fázis)

| Fázis | Mit tesz |
|---|---|
| **1. Mérés** | a valós session-naplókból: kérésszám, tokenek, **cache-arány**, kimenet/kérés (medián), lépés/session, **pörgő-munka aránya**, célonkénti költség |
| **2. Kalibrálás** | a szelektor paramétereinek újraszámolása a mért értékekből: `assumedCachedShare`, `assumedOutputTokens`, `assumedRemainingSteps` — **korlátokkal** (0,6–0,95 / 200–4000 / 4–16) |
| **3. Élő ellenőrzés** | minden provider `/models` katalógusa + latencia; jelzi, ha egy route-cél vagy jelölt **már nem létezik** |
| **4. Árfigyelés** | a gyári árlista újraolvasása (`pricing-parser.mjs`) és diff a `pricing` táblához |
| **5. Alkalmazás** | `--apply`: a hangolás beírása a `config.json`-ba (időbélyeges backup, csak a változott kulcsok); a proxy **hot-reloaddal** veszi át, restart nem kell |
| **6. Jelentés + trend** | `providers/reports/autotune-<idő>.json`, összevetve az előző futással (költség/kérés, cache-arány, pörgő-arány) |

**Biztonsági korlátok:** alapból **dry-run**; árat **soha** nem ír automatikusan
(csak `--apply-prices`, ellenőrzés után — mert az ár minden döntést átszínez);
minden érték csonkolva a józan sávba; figyelmeztetés esetén **nem nulla
kilépési kód** (az ütemező/watchdog jelezni tud).

## 20.2 Az első futás eredménye

Mért (30 nap, 196 session, 30 222 kérés): költség **$58,38**, **$0,0019/kérés**,
cache-arány **99,60%**, kimenet/kérés (medián) **394** token, lépés/session
(medián) 25, pörgő session **18,9%**.

Ebből az **első kalibrálás** (alkalmazva):

| Paraméter | Előtte | Utána |
|---|---|---|
| `assumedCachedShare` | 0,9 | **0,95** (mért 99,6% × 0,98, korlátozva) |
| `assumedOutputTokens` | 900 | **394** (mért medián) |
| `assumedRemainingSteps` | 8 | **4** (lépés/session/8, korlátozva — óvatos, hogy ne váltson túl gyakran) |

Élő ellenőrzés: mind a 7 provider OK (groq 278 ms, nvidia 118 ms, openrouter
258 ms, **alibaba 202 ms**, **alibaba-intl 684 ms**, **deepseek 293 ms**,
ollama 174 ms).

**Az autotune egy hamis pozitívot is kiszűrt és javított:** az
`openrouter/qwen/qwen3.8-27b:free` célt hiányzóként jelezte, mert az OpenRouter
katalógusa a `:free` **variánst** nem listázza — a bázis-id meglétét mostantól
elfogadjuk (a dátumozott utótagokra ugyanígy).

## 20.3 Ütemezés

- **`providers/run-autotune.cmd`** — ASCII-only shim (a `cmd.exe` a saját
  kódlapján olvassa a fájlt; az UTF-8 ékezetekből **parancstöredékek** lettek,
  mérve és javítva), `--days 30 --apply`, kimenet: `autotune.out.log`.
- **`providers/register-weekly-autotune.ps1`** — heti Windows-feladat
  (`-Time`, `-Day`, `-Remove`), a repó meglévő retune-mintáját követve.
- **Bejegyezve:** `DSH-AutoTune`, **vasárnap 04:30**, első futás
  **2026-10-18 04:30**. Azonnali próba: `schtasks /Run /TN "DSH-AutoTune"`.

## 20.4 Ami szándékosan kézi marad

- **Ár alkalmazása** (`--apply-prices`): a gyári árlista formátuma változhat, és
  egy elrontott ár minden költség-döntést elront — ezért emberi jóváhagyás kell.
- **`settings.yaml` modell-lista** (élő id-k cseréje): a meglévő havi
  `retune.mjs` dolga; az autotune csak **jelzi**, ha egy cél elhalt.








