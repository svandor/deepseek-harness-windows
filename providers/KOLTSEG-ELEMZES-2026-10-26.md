# Alibaba-költés vs. DSH-panel — ki költötte, mennyit, és megérte-e?

**Dátum:** 2026-10-26. **Ciklus:** 2026-10 (október 1–26., a hónap még nyitva).
**Jelölések:** [M] = mért (élő API / napló), [D] = dokumentált, [K] = számított/becsült.

---

## 1. Vezetői összefoglaló

| Kérdés | Válasz |
|---|---|
| Költött-e a DSH az Alibaba-egyenlegen? | **Igen, gyakorlatilag teljes egészében a DSH költötte.** [M] |
| Mennyi az októberi Alibaba-számla? | **31,01 USD nettó / 39,38 USD bruttó** (27% áfával). [M] |
| Mit mutat erről a DSH panel? | **0,13 USD-t** (a valós nettó számla **0,4%-át**). [M] |
| Delegálás miatt van? | **Részben: a számla ~1/4-e delegálás, ~3/4-e a fő szál `Auto` modellje.** [M/K] |
| Költséghatékony? | **Nem: áfával együtt veszteség.** A mért 5 napon (okt. 22–26.) **17,01 USD bruttó** ment el Alibabára, ugyanez a forgalom DeepSeek-flash-en **10,74 USD** lett volna → **+58%, ≈6,3 USD veszteség**. Egész októberre ≈13–15 USD veszteség. [M/K] |
| Fő hiba | A „free lánc” **halott** (Groq 8K TPM, OpenRouter 402), ezért a proxy minden kérést fizetős Alibaba-modellre tesz — a panel viszont 0-nak árazza. [M] |

A felhasználói megfigyelés („hasonló költés az Alibaba-oldalon, mint a DSH-panelon”) **találó**: október 21-én az Alibaba számla 6,21 USD, a panel ugyanaznap 6,29 USD — 99%-os egyezés, mert ugyanaz a forgalom ment át az Alibaba-felé. [M]

---

## 2. Ki költötte? (attribúció)

**Verdikt: a költés a DSH-hoz tartozik, nincs idegen fogyasztó.** [M]

Bizonyítékok:

1. **Számla-oldal:** a 2026-10 ciklus `DescribeInstanceBill` 102 tételében **csak két workspace** szerepel, és mindkettő a DSH konfigurált végpontja:
   - `ws-kt393ifjia7nh7rh` (EU, Frankfurt) — `settings.yaml` `alibaba` provider, **11,87 USD**
   - `ws-7pa8b93c9tnmgi1w` (SG, Szingapúr) — `alibaba-intl`, **19,11 USD**
   Harmadik workspace (más tenant/alkalmazás) nincs a számlán.
2. **Modell-oldal:** a tételes bontás pontosan a DSH proxy-láncainak modelljei: `qwen3.7-flash` 19,56 USD, `qwen3.8-flash` 11,39 USD, a maradék 0,03 USD pedig 11 modellre szóródik (`kimi-k3`, `glm-5.1/5.2`, `qwen3.8-max`, `qwen3.7-max*`, `deepseek-v4-pro`, `qwen3.5/3.6-*`) — ez a 2026-10-14-i `probe-alibaba*.mjs` méréssorozat lenyomata. [M]
3. **Forgalom-oldal:** a proxy-napló Alibaba HIT-jei és a DSH session-naplók kérésszámai napra egyeznek (93–99%), a számla/HIT hányados stabil **0,0017–0,0036 USD/kérés** — nincs „magyarázatlan maradék”, ami más fogyasztóra utalna. [M]
4. **Gép-oldal:** a gépen **egyetlen** folyamat beszél `*.maas.aliyuncs.com`-ra: a `providers/proxy.mjs` (PID 31748, port 4123). LiteLLM nincs telepítve/futtatva, nincs `ALIBABA_*`/`DASHSCOPE_*` környezeti változó, más app-konfig nem hivatkozik a végpontokra. [M]

**Korlát:** ha ugyanazt a kulcsot egy *másik gépen* is használnák ugyanebben a workspace-ben, az innen nem látszana — de akkor a kérésenkénti költség szórása eltérne a most mért szűk sávtól. A költség így is 95%+ biztonsággal a DSH-é.

---

## 3. Panel vs. valóság

DSH-panel (`/ui-extras/usage`, 2026-10-01…26): [M]

| Panel-sor | Kérés | Token | Panel-költség |
|---|---|---|---|
| deepseek-official/deepseek-flash | 42 763 | 14,07 Mrd | **73,70 USD** |
| auto-router/auto (proxy, „Auto”) | 6 995 | 1,75 Mrd | **26,68 USD** |
| alibaba/qwen3.8-flash (közvetlen) | 46 | 4,45 M | **0,13 USD** |
| subagent-worker/worker („ingyenes lánc”) | 8 990 | 0,40 Mrd | **0,00 USD** |
| **Összesen** | | | **100,50 USD** |

Alibaba BSS (ugyanaz az időszak): **31,01 USD nettó**, ebből áfa 5,40 → **39,38 USD bruttó**. [M]

| Tétel | Panel | Valóság | Eltérés |
|---|---|---|---|
| Alibaba | 0,13 USD | 31,01 USD nettó / 39,38 USD bruttó | **≈240× alábecsülve** |
| Összes költés | 100,50 USD | ≈118–122 USD nettó / ≈126–131 USD bruttó [K] | 18–30% alábecsülve |
| Alibaba részaránya | 0,12% | **≈25–30%** | — |

**Miért vak a panel?** A DSH csak a *kliens-oldali* route-nevet látja: a delegált kérések `subagent-worker/worker` néven futnak be, amire a `MODEL_PRICES`-ban **0 USD** áll, a proxy viszont a háttérben fizetős Alibaba-modellt hív. Ugyanígy az `auto-router/auto` forgalom a DeepSeek-flash árával számolódik, akkor is, ha a proxy közben Qwenre terelte. A panel `alibabaSg` sora pedig 0, mert `alibaba-intl/*` címke egyáltalán nem keletkezik a session-naplókban.

A panel „ingyenes lánc” statisztikája ezért **fiktív**: 9 077 kérésre 0 USD költséget és **17,07 USD megtakarítást** állít, miközben a valós Alibaba-számla ebből a forgalomból ≈8–10 USD nettó — és ami ennél is rosszabb: a valóságban **nem megtakarítás, hanem többletköltség** (lásd 6. pont).

---

## 4. ÁFA — a panel számára láthatatlan 27%

A BSS `QueryBillOverview` és `QuerySettleBill` egyértelmű: [M]

| Elszámolás | Nettó | ÁFA | Bruttó | ÁFA-kulcs |
|---|---|---|---|---|
| 2026-10-14 11:27 → 10-22 23:53 | 6,97 | 1,88 | 8,85 | **26,97%** |
| 2026-10-14 12:36 → 10-22 23:56 | 13,04 | 3,52 | 16,56 | **26,99%** |
| 2026-10-22 23:55 → 10-26 15:25 (nyitott) | 6,06 | — | — | (27% várható) |
| 2026-10-22 23:57 → 10-26 19:27 (nyitott) | 5,01 | — | — | (27% várható) |

Tehát **27,0% magyar áfa** terheli a teljes Alibaba-költést (a részben még nyitott 11,07 USD-ra is rá fog kerülni). A hónap végi bruttó: **31,01 × 1,27 = 39,38 USD**.

A panel minden ára **nettó listaár**, áfa nélkül — ezért a valós, fizetendő összeg minden Alibaba-sornál 27%-kal több, mint amit a panel mutat. A DeepSeek-oldalon a panel szintén nettó USD-listaárat használ; a DeepSeek USD-feltöltésénél áfa nem jelenik meg (a saját számlán ellenőrizhető — ha ott mégis van 6% kínai áfa, az arányokat érdemben nem mozgatja).

---

## 5. Ár-összehasonlítás — áfával együtt

USD / 1M token, **nettó → 27% áfával** (zárójelben a nettó): [D] listaárak + [M] áfakulcs

| Modell / sáv | Input (miss) | Cache-találat | Output |
|---|---|---|---|
| deepseek-flash (off-peak) | 0,15 | 0,003 | 0,60 |
| deepseek-flash (csúcs 01–04, 06–10 UTC) | 0,30 | 0,006 | 1,20 |
| qwen3.7-flash EU ≤32K | 0,036 (0,028) | **0,0036 (0,0028)** | 0,140 (0,110) |
| qwen3.7-flash EU 32K–256K | 0,105 (0,083) | 0,0105 (0,0083) | 0,419 (0,330) |
| qwen3.7-flash EU >256K | 0,210 (0,165) | 0,021 (0,0165) | 0,838 (0,660) |
| qwen3.8-flash EU | 0,144 (0,113) | 0,0144 (0,0113) | 0,485 (0,382) |
| qwen3.8-flash SG | 0,191 (0,150) | 0,0190 (0,0150) | 0,597 (0,470) |

**Lelet:** áfával együtt
- **qwen3.7-flash EU** friss tokenen veri a DeepSeeket (0,036 vs 0,15–0,30), cache-en ≤32K-nál **egálban** van (0,0036 vs 0,003–0,006), 32K felett viszont 1,8–3,5× drágább a cache;
- **qwen3.8-flash SG** cache-en **3–6× drágább** a DeepSeeknél — a legrosszabb választás a cache-nehéz forgalomra;
- a mi forgalmunk **cache-nehéz** (fő szál: 96% cache-találat, delegálás: 79%), ezért a döntést a cache-oszlop hozza, nem a friss input.

---

## 6. Hatékonyság

| Mutató | Érték |
|---|---|
| Delegált gyerek-session (okt.) | 556 db [M] |
| Delegált kérés | 9 015 db [M] |
| Delegált token | ≈398 M (miss 82,9 M / cache 311,6 M / out 3,9 M) [M] |
| Kérés/session | 16,2 |
| Token/kérés | ≈44 000 (79% cache, 1% output) |
| Delegálási sikerarány | 96% (utolsó 2 nap, dedup) [M] |
| Elhalt/leállított gyerek | 8 db / 3 nap [M] |
| Proxy HIT (okt. 22–26) | 6 878 |
| Ebből Alibaba | 5 116 (**74,4%**) |
| Ebből DeepSeek | 1 762 (25,6%) |
| Ingyenes célok (Groq/OpenRouter/Ollama/NVIDIA/Google) HIT | **0** |
| Proxy FAIL | 314 (Groq 413, OpenRouter 402) |
| „COOLDOWN-előre” naplósor | **151 028** (≈22/kérés) |

**A „free lánc” nem létezik a gyakorlatban:**
- **Groq**: `HTTP 413 … TPM Limit 8000, Requested 9502` — a delegált kérések ~44K tokenje eleve nem fér bele a 8K TPM keretbe.
- **OpenRouter**: `HTTP 402 … can only afford 187` — elfogytak a kreditek.
- Ezért minden kérés a lánc végén lévő **fizetős Alibaba**-ra esik, és a health-logika a halott célokat minden kérésnél hátracsúsztatja (innen a 151K cooldown-sor).

**Egységköltség [M] — ez a döntő tábla:**

| Időszak | Alibaba bruttó (27% áfával) | Ugyanez DeepSeek-flash-en (csúcs/időn kívül) | Eredmény |
|---|---|---|---|
| Okt. 24–26. (csak delegálás, 2 483 kérés, 133,7 M token) | **6,44 USD** | 4,20 USD | **+53% drágább** |
| Okt. 22–23. (delegálás + `Auto` session-ök, 5 116 kérés) | **10,57 USD** | 6,54 USD | **+62% drágább** |
| **Okt. 22–26. együtt** | **17,01 USD** | **10,74 USD** | **+58%, ≈6,3 USD veszteség** |
| Egész október (okt. 1–26.) | 39,34 USD | ≈25 USD [K] | ≈14 USD veszteség [K] |

**Miért nem spórol?** Mert a proxy a ≤32K-os, 0%-cache-es sávval számol, a valós kéréseink viszont **50–250K tokenesek, 80–96% cache-találattal**. Ott a qwen cache-ára a DeepSeek cache-árának **3–7×-ese** (qwen3.7 SG: 0,01–0,02 vs. DeepSeek 0,003–0,006 USD/M), és a qwen „olcsó” sávja (0,003) csak 32K alatt él, ahová a kéréseink soha nem esnek. A mérés szerint a delegálás effektív ára az Alibabán **≈0,048 USD/M token** (okt. 24–26.), a DeepSeeké ugyanazon a mixen **≈0,031 USD/M**.


**Hol megy el a pénz valójában (október, nettó) [M/K]:**

| Fogyasztó | Alibaba nettó | Arány |
|---|---|---|
| Fő szál „Auto” modellen (33 top-level session + 2 gyerek, 6 866 kérés): EU qwen3.7 11,62 + SG qwen3.8 11,17 + EU qwen3.8 0,22 | **≈23,0 USD** | **≈74%** |
| Delegálás (`worker` route): SG qwen3.7 7,94 + EU beszivárgás ≈1 | **≈9,0 USD** | ≈26% |
| 2026-10-14-i mérések (11 modell) | 0,03 USD | 0,1% |

Vagyis **nem a delegálás a fő költség** — havi szinten a legnagyobb tétel az, hogy a fő szál egyes session-jei `Auto (proxy)` modellen futnak. **De a napok óta tartó, Auto nélküli költés 100%-ban delegálás:** okt. 24–26-án a proxy-napló szerint csak `alibaba-intl` HIT volt (986 + 882 + 350), és a worker-kérések száma (1 045 / 947 / 491) ezt lefedi. Ez a $6,44 bruttó az, amit a „free chain” termelt.

---

## 7. Javaslatok (fontossági sorrendben)

1. **Tedd láthatóvá az Alibaba-számlát a panelben.** A `providers/bss-client.mjs` már tudja (`QueryBillOverview` → `PretaxAmount`, `Tax`, `AfterTaxAmount`). Egy „Alibaba (számla, bruttó)” sor azonnal megmutatná a 39 USD-t a mostani 0,13 helyett. Ez egyben a `freeSavingsUsd` hazugságát is megszünteti.
2. **Árazd be a proxy háttér-döntéseit.** A `subagent-worker/worker` ne 0 legyen, hanem a tényleges upstream (qwen3.7-flash) ára; az `auto-router/auto` pedig ne a DeepSeek-flash árával számoljon, ha a proxy Qwent választott. A proxy `/healthz` már kiírja az utolsó döntést (`Auto → alibaba/qwen3.7-flash`), ezt be lehet kötni.
3. **Döntsd el a „free lánc” sorsát.** A mostani állapot a legrosszabb: fizetsz érte, de „ingyenesnek” van címkézve. Válassz:
   - (a) tényleg ingyenes: Groq Dev tier (8K→nagyobb TPM) + OpenRouter kredit, vagy a delegált kontextus 8K alá szorítása — utóbbi a subagent használhatóságát rontja;
   - (b) vállaltan fizetős: `qwen3.7-flash` EU az elsődleges delegálási cél (ez a legolcsóbb élő opció, áfával is), a lánc elejéről vedd ki a halott célokat, hogy ne generáljanak 151K cooldown-sort és ne lassítsanak.
4. **Az `Auto` modellt ne használd hosszú, cache-nehéz session-ökre.** A választó `cache-arány 0%`-os feltételezése ott téves; a `candidates` listából a `qwen3.8-flash` (főleg SG) vegyél ki, vagy a fő szál maradjon `deepseek-official/deepseek-flash`. Becsült nyereség: 10–15 USD nettó/hó.
5. **Költség-őrszem:** napi BSS-lekérdezés + riasztás havi 25 USD felett; a 27%-os áfát a keretbe bele kell számolni (a panel 27%-kal alacsonyabb számot mutat, mint a fizetendő).

---

## 8. Reprodukció

A mérésekhez használt, újonnan írt szkriptek a `.tmp-probe/` mappában (a meglévő `providers/bss-client.mjs`-re épülnek):

| Szkript | Mit ad |
|---|---|
| `bill-dump.mjs [YYYY-MM]` | havi számla + modell/workspace-bontás |
| `bill-daily.mjs [YYYY-MM]` | napi bontás (`DescribeInstanceBill` DAILY) |
| `bill-ws-model.mjs` | workspace × modell keresztábla |
| `dbg-tax.mjs`, `dbg-tax2.mjs` | `QueryBillOverview` / `QuerySettleBill` — áfa-tételek |
| `proxy-stats.mjs [log]` | proxy HIT/FAIL/cooldown napi bontása |
| `provider-daily.mjs [YYYY-MM]` | session-napló napi × provider bontás |
| `cost-daily.mjs [YYYY-MM]` | panel-árlogikával számolt napi költség vs. Alibaba-számla |
| `route-sessions.mjs` | mely session-ök melyik route-on futottak (gyerek/fő) |

Újrafuttatás: `node .tmp-probe/<szkript>.mjs`. A BSS-hívásokhoz a `~/.dsh/.credentials.yaml` `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET` kell (megvan, `AliyunBSSReadOnlyAccess`).

---

## 9. Beállítás-módosítás (2026-10-26 12:05) — a fizetős Alibaba kivétele a delegálásból

**Gyökér-ok, amiért eddig fizetősre esett:** a `worker` lánc tagjai között **négy fizetős/kredit-igényes cél** volt (`openrouter/inclusionai/ling-3.0-flash` = fizetős slug, `openrouter/qwen/qwen3.8-27b` = fizetős, `alibaba` EU + SG), és a lánc elején álló három „ingyenes” cél a valós kéréseken mindig elhalt:

| Cél | Miért halt el | Mérés |
|---|---|---|
| `groq/openai/gpt-oss-120b` | TPM 8000 — a kérések 12–250 K tokenesek | `HTTP 413` |
| `openrouter/qwen/qwen3.8-27b` | **fizetős** slug, 0 kredittel | `HTTP 402 … can only afford 187` |
| `openrouter/inclusionai/ling-3.0-flash` | **fizetős** slug (a `:free` változat 404: „unavailable for free”) | `HTTP 404 / 200 fizetős` |
| `ollama/qwen2.5:7b-instruct` | nem futott + 32K ablak | `SKIP … csonkolna` |

**Új láncok (config.json, hot-reload — restart nem kell):**

| Route | Régi | Új |
|---|---|---|
| `worker` | groq → ling(fizetős) → qwen27b(fizetős) → **alibaba(fizetős)** → **alibaba-intl(fizetős)** → ollama | `nemotron-3.5-super-vl:free` → `nemotron-3.5-lightning:free` → `ollama/qwen25-32k:latest` → `ollama/qwen2.5:7b-instruct` → `groq/gpt-oss-120b` |
| `free-quota` | 5× alibaba-intl (fizetős volt a számla szerint) | ugyanaz az ingyenes lista |
| `vision-worker` | 3× alibaba | `nemotron-3.5-super-vl:free` → `nemotron-3.5-lightning:free` → `ollama/qwen3-vl:8b` |
| `deepseek-chat` | groq → qwen27b(**fizetős**) → ollama | groq → `nemotron-3.5-lightning:free` → ollama |
| `auto` **candidates** | 4× alibaba + deepseek | **csak `deepseek/deepseek-flash`** (az Alibaba kiesett a választóból; a `targets`-ben megmaradt vésztartaléknak) |

A `pricing` tábla megkapta az ingyenes célokat (ár 0 + valós `contextWindow`), így a SKIP-döntés és a panel-árazás helyes. A `maxTokens` a szubagent-route-okon 32768 → 8192.

**Ellenőrzés (élő, futó proxyn át):**
- `GET /healthz` → `worker: nemotron-3.5-super-vl:free -> nemotron-3.5-lightning:free -> ollama/qwen2.5:7b-instruct -> groq/gpt-oss-120b`
- 11,5 K tokenes, tool-hívásos teszt a proxyn: `HTTP 200`, **2,99 s**, 1 valódi `tool_call`, `usage.cost = 0`, a naplóban `HIT openrouter/nvidia/nemotron-3.5-super-vl:free`, **0 Alibaba-sor**.
- `providers/free-guard.mjs` (új): szabály-ellenőrzés + **12 K tokenes élő próba** (1× újrapróbával) minden lánctagra + `--apply` (a megbukott tagot a lánc végére sorolja, mentés előtt `.bak`) + **BSS Alibaba-számla ellenőrzés** (a „szingapúri ingyenes keret" valódi mérője). Bekerült a `run-retune.ps1`-be a `chain-doctor` után, és a **napi** „DSH model retune daily" feladat futtatja (09:00, `apply` mód).
- **A napi feladat 3 hétig halott volt:** a trigger `<EndBoundary>2026-10-04</EndBoundary>`-tel lejárt, ezért `Next Run Time: N/A` volt, az utolsó futás 2026-10-03. A lejáratot töröltem → **következő futás: 2026-10-27 09:00, naponta**. (A heti „DSH model retune weekly" is megmaradt hétfő 09:00-ra.)
- **Ma mért élő példa a korlátra:** 12:50 UTC körül az OpenRouter `HTTP 429 — Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free models` választ adott, vagyis az **50/nap keret elfogyott** (a valós delegálás + a mai mérések együtt), és a lánc a helyi Ollamára esett — az `ollama/qwen25-32k` 12 s alatt valódi tool-callt adott. Ez a gyakorlati érv a 10 USD-s egyszeri feltöltés mellett.
- Ollama elindítva (`ollama serve`, a modellek megvannak: `qwen2.5:7b-instruct`, `qwen3-vl:8b`); a `/api/tags` válaszol.

**Ismert korlátok (ezek a következő döntés tárgyai):**
1. **OpenRouter ingyenes plafon:** a dokumentált limit <10 USD élettartam-kredit alatt **50 kérés/nap** (a kulcson 0,157 USD összhasználat van). A delegálás jelenleg 1 000–1 500 kérés/nap → a plafon után a lánc a **helyi Ollamára** esik. Egy egyszeri 10 USD feltöltés 1 000/nap-ra emeli — a modellek továbbra is 0 árasak.
2. **Helyi Ollama — mért, és használható:** az `ollama serve` elindítva, a modellek megvannak. Alapból a 4K-s `num_ctx` miatt csonkolt (12K-s kérésből 2K lett, és elveszett a tool-call), ezért készült egy 32K-s változat: `ollama create qwen25-32k` (`PARAMETER num_ctx 32768`). Mérés: **10 657 tokenes, tool-hívásos kérés → HTTP 200, 1 valódi tool_call, 7,3 s, 0 USD**. Kisebb prompton a `qwen2.5:7b-instruct` és a `gpt-oss:20b` is ad tool_call-t (a `qwen2.5-coder:14b` nem). A 32K feletti delegálásra a helyi modell nem alkalmas (a proxy SKIP-el).
3. **Groq** csak ~4K token alatt használható (TPM 8000), ezért van a lánc végén.
4. Az `auto` route `targets` listájában az Alibaba **vésztartalékként** megmaradt (DeepSeek-kiesés esetére); ha ez sem kell, onnan is törölhető.

### 9.1 OpenRouter: mik a lehetőségek (2026-10-26-i állapot)

Az OpenRouter hivatalos árazási oldala szerint a **Free** csomag: 25+ ingyenes modell, 4 ingyenes provider, **50 kérés/nap**. Feltöltés nélkül tehát ez a plafon — a delegálás 1 000–1 500 kérés/nap, vagyis a felhős ingyenes keret a forgalom ~4%-át fedi.

Lehetőségek, mérve:

| Opció | Költség | Napi keret | Mért eredmény (12K token + tool-call) |
|---|---|---|---|
| **Google AI Studio** (`GOOGLE_API_KEY` megvan) | **0 Ft** (ingyenes szint, ha a projektben nincs számlázás) | Google adja, modellenként RPM/RPD | **`gemini-3-flash-preview`: 200, 1,7 s, 1 tool_call** — a legjobb |
| **Helyi Ollama** | 0 Ft | korlátlan | `qwen25-32k`: 200, 7,3 s, 1 tool_call |
| OpenRouter `:free` | 0 Ft | **50/nap** | `nemotron-3.5-super-vl:free`: 200, 12,7 s |
| OpenRouter feltöltéssel | egyszeri kredit (nem előfizetés) | a dokumentáció szerint ~10 USD kredit felett **1 000/nap** az ingyenes modellekre; a kredit nem vész el | — |
| NVIDIA NIM | 0 Ft | — | **nem opció:** a nemotron id-k 404, a `gpt-oss-120b` 410 („reached its end”) |

**Beállítva:** a `google` provider bekerült a proxyba (`https://generativelanguage.googleapis.com/v1beta/openai`, `GOOGLE_API_KEY`), és a delegálási láncok **első** célja lett. Élő teszt a futó proxyn: `HTTP 200`, **1,5 s**, 1 valódi `tool_call`, 11 270 token prompt, napló: `HIT google/gemini-3-flash-preview`. A `free-guard` szabály-ellenőrzése: OK (nincs fizetős cél).

**Amit még ellenőrizni kell:** (a) a Google-projektnél tényleg ki van-e kapcsolva a számlázás (különben fizetős), (b) a Google ingyenes szint tényleges RPM/RPD korlátja — 429 esetén a lánc automatikusan a következő ingyenes célra lép.

