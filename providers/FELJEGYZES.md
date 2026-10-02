# Feljegyzés — Provider-konfiguráció és karbantartás

**Dátum:** 2026-09-27
**DSH verzió:** `0.1.5-rc.3` (npx cache: `@deepseek-ai/dsh@0.1.5-rc.3`)
**DSH home:** `%USERPROFILE%\.dsh`
**Munkaterület:** `C:\Szerver\Deepseek Harness`

---

## 1. Kiindulás és a fő megállapítás

A DSH-ban a több-provideres réteg (`@deepseek-ai/dsh-llm-pi-ai`) **már be van
építve**, a `dsh-base` mountolja, csak *dormant* (nulla route) mindaddig, amíg a
`~/.dsh/settings.yaml`-ban nincs `llm-pi-ai:` szekció. A Web GUI **Settings →
Models** oldala ezt kezeli: provider hozzáadás, API-kulcs (write-only, a
`~/.dsh/.credentials.yaml`-ba kerül), modell-lista szerkesztése, és
*Fetch available models* a végpont lekérdezéséhez.

Tehát **nem kellett fejleszteni**: a cél (helyi Ollama + ingyenes felhős
providerek + egyszerű feladatokra ingyenes modellek) natív konfigurációval
elérhető. A közösségi pluginek (fallback, tier-routing) csak **0.1.7**-en
működnek, mert a 0.1.6-ban a `@deepseek-ai/dsh-settings-file` és a
`ctx.settings.register` seam megszűnt.

---

## 2. A jelenlegi konfiguráció

Öt provider a `~/.dsh/settings.yaml`-ban, összesen **63 modell**, mind
élő API-próbával ellenőrizve:

| Provider | Modellek | Végpont | Kulcs |
|---|---|---|---|
| `groq` | 4 | katalógus (`api.groq.com/openai/v1`) | `GROQ_API_KEY` |
| `openrouter` | 17 | katalógus (`openrouter.ai/api/v1`) | `OPENROUTER_API_KEY` |
| `nvidia` | 18 | katalógus (`integrate.api.nvidia.com/v1`) | `NVIDIA_API_KEY` |
| `google` | 16 | katalógus (natív `google-generative-ai`) | `GOOGLE_API_KEY` |
| `ollama-local` | 8 | `http://localhost:11434/v1` | `OLLAMA_LOCAL_API_KEY` |

Alapértelmezett modell: `deepseek-official` / `deepseek-flash`, effort `high`
(**változatlan** — az újrahangoló sosem nyúl hozzá).

### Elvetett providerek

| Provider | Ok |
|---|---|
| Cerebras | az ingyenes szinthez is kártyát kér |
| GitHub Copilot | előfizetés lemondva |
| Z.AI | fizetősnek tűnt |

### Fontos: az Ollama is kér kulcsot

Az OpenAI-kompatibilis implementáció a pi-ai-ban megköveteli a kulcsot vagy egy
`Authorization` fejlécet — akkor is, ha a helyi szerver nem. A kód:
`if (apiKey) return apiKey; if (hasHeader(headers, "authorization")) return "unused"; throw …`

Ezért kell egy **placeholder** (`OLLAMA_LOCAL_API_KEY` = `ollama`). A
modell-*felfedezés* viszont kulcs nélkül is működik.

---

## 3. Mért eredmények (élő API-próbák)

A pi-ai katalógus beépített modell-listája és a provider élő listája
**rendszeresen eltér**. A felvett 88 modellből 15 nem volt használható.

| Provider | Nem létezett / nem hívható | Javítás |
|---|---|---|
| groq | `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `qwen/qwen3.6-27b` | törölve; helyettük `openai/gpt-oss-120b`, `-20b`, `qwen/qwen3.8-27b` |
| openrouter | `minimax/minimax-m2.7:free`, `minimax/minimax-m3:free`, `z-ai/glm-5.2:free` | törölve; helyettük `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free` |
| nvidia | `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`, `minimaxai/minimax-m3` | törölve; helyettük `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k3` |
| google | `gemini-3.1-flash-live-preview` (nem létezik), `gemini-2.5-flash`, `-lite`, `-pro` (404: „no longer available to new users"), `deep-research-*` (csak Interactions API) | törölve |

### Google: két út, és csak az egyik jó

| Út | Protokoll | Tool-calling |
|---|---|---|
| **Natív** `/v1beta/models/<m>:generateContent` | `google-generative-ai` — **ezt használja a DSH** | ✅ `get_weather({"city":"Budapest"})` |
| OpenAI-kompatibilitási `/v1beta/openai` | `openai-completions` | ❌ nem hív toolt, a reasoning modelleknél **üres content**, a Gemmáknál nyers `<thought>` szivárog a válaszba |

**Következmény:** a Google-t a natív route-on kell használni (ez az
alapértelmezés), és **nem** szabad a fallback proxyba bekötni.

### Google-kulcs típusa

A kulcs **API-kulcs** (`AQ.…`), nem OAuth token:

| Hitelesítés | Eredmény |
|---|---|
| `?key=` query param | ✅ 200 |
| `x-goog-api-key` fejléc | ✅ 200 (ezt küldi a hivatalos SDK) |
| `Authorization: Bearer` | ❌ 401 |

### Google: a lista létezése nem jelenti, hogy hívható

A `/v1/models` 50 modellt ad vissza, de csak **11 hívható**. Kvóta (429) vagy
túlterheltség (503) miatt átmenetileg nem válaszolt: `gemini-3.1-pro-preview`,
`gemini-3.1-pro-preview-customtools`, `gemini-3.1-flash-lite-image`,
`gemini-2.5-computer-use-preview-10-2025`, `gemini-3.5-flash` — ezek a listán
maradtak, mert a hiba nem végleges.

### Helyi Ollama: tool-calling a szűrő

A 18 helyi modelledből **11 tud tool-callingot** — agent-loopban csak ezek
használhatók. Két csapda:

- `llava:13b` és `minicpm-v` **lát, de nem tud toolt** → agent-loopban
  használhatatlanok.
- `qwen3-vl:8b` az **egyetlen**, ami lát *és* tud toolt is.

Törölve a konfigból (nincs tool, vagy nem chat-modell): `qwen2.5-coder:1.5b-base`
(base modell — mért példa: triviális kérésre „I have no idea what this means!"),
`nomic-embed-text`, `glm-ocr`, `gemma2:9b`, `deepseek-coder-v2:16b`, `llava:13b`,
`minicpm-v`, `moondream`, `racka:*`.

### Reasoning modellek token-kerete

A `gpt-oss:20b` 24 tokenes `max_tokens`-szel **üres content**-et adott, mert a
gondolatmenetére futott ki. Ezért a helyi reasoning modelleknél legalább
16384 `maxTokens` kell.

---

## 4. Fallback proxy (`providers/proxy.mjs`)

Mivel a DSH 0.1.5 magja nem vált át automatikusan másik providerre (a
`retryPolicy` ugyanazon a route-on próbálkozik újra), készült egy **nulla
függőségű Node proxy**, ami egyetlen OpenAI-kompatibilis végpontot ad, és a
konfigurált lánc szerint próbálkozik — még az első token előtt.

**A láncok 2026-10-01-i állapota** (élő `/healthz`-ből, `chain-doctor` méréssel):

| Route | Lánc |
|---|---|
| `worker` | NVIDIA `gpt-oss-20b` → NVIDIA `nemotron-3-super-120b` → Groq `gpt-oss-120b` → OpenRouter `qwen3.8-27b:free` → Ollama `qwen2.5-coder:14b` |
| `deepseek-chat` | Groq `gpt-oss-120b` → NVIDIA `nemotron-3-super-120b` → Ollama `gpt-oss:20b` → OpenRouter `qwen3.8-27b:free` |
| `fast-chat` | Groq `gpt-oss-20b` → NVIDIA `gpt-oss-20b` → Ollama `qwen2.5:7b-instruct` |
| `local-only` | csak helyi Ollama `gpt-oss:20b` (adat nem hagyja el a gépet) |

### A proxy a configot INDULÁSKOR olvassa be egyszer — ez csendben elavul

**Mért hiba (2026-10-01).** A `proxy.mjs` a `config.json`-t a modul tetején
olvassa be egyszer (`const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, …))`),
és minden kérés ezt a memóriabeli példányt használja. A fájl mentése ezért a
**futó példányon nem hat**.

A 2026-09-29 15:14 óta futó proxy így **két napon át egy elavult láncot szolgált
ki** — nem azt, ami a fájlban állt. Az élesben futó `worker` lánc ez volt:

```
groq/gpt-oss-120b → nvidia/nemotron-3-super-120b → ollama/qwen2.5-coder:14b
  → openrouter/qwen/qwen3.8-27b:free → nvidia/openai/gpt-oss-20b
```

Vagyis a **tool-hívást nem adó helyi coder a 3. helyen** állt, minden más
felhős cél előtt — pontosan az a csendhiba, amit a 6d. szakasz ír le.

A `chain-doctor.mjs` eközben azt írta ki, hogy *„nem kell újraindítani"*. Ez az
állítás **hibás volt**, és ez okozta a kétnapos elavulást; 2026-10-01-én
javítva (a szkript és a `config.json` `_napi_felulbiralat` mezője is).

**Szabály:** a `config.json` (és így a `dailyOverrides` is) mentése után a
proxyt újra kell indítani:

```powershell
.\providers\run-proxy-service.ps1 -Stop
.\providers\run-proxy-service.ps1
```

A `watchdog-subagent-proxy.ps1` **60 másodperces ciklusban** magától is
helyreállítja, ha a `/healthz` nem válaszol — de ez akár egy perc kiesést jelent,
és a `proxy.pid` ilyenkor elavult PID-et tartalmazhat.

**A watchdog működik, de nem azonnal:** a 2026-10-01-i újraindításnál 17:39:08-kor
észlelte a kiesést, és 17:39:12-re állt fel az új lánc. A naplója
(`reports/proxy-watchdog.log`) csak a rendellenes eseményeket írja.

**Két külön időkorlát** (ez a fő tervezési döntés):
- `connectTimeoutMs` (120 s, Ollamánál 300 s): mennyit várunk a válasz
  *fejlécére*. Ez dönti el a fallbacket. Azért ilyen hosszú, mert egy helyi
  modell cold startja mért érték szerint 15–69 s.
- `stallTimeoutMs` (180 s): stream közben mennyi csend után adjuk fel.

**Bizonyított viselkedés** (élő tesztek):
- Fallback-ág halott végpont → 401 → helyi Ollama: végigsétál, a válasz megjön.
- SSE streaming: chunkok + `[DONE]` helyesen.
- Tool-calling a valódi láncon: `finish_reason: tool_calls`, helyes argumentumok.
- Hiányzó kulcsú providert kihagy, nem hal el tőle.
- Perjeles/kettőspontos modell-id (`openrouter/qwen/qwen3.8-27b:free`) helyesen
  oldódik fel (csak az első perjelen hasít).

---

## 5. Havi újrahangolás (ütemezett feladat)

> **AKTUÁLIS ÜTEMEZÉS (2026-09-27):** két ütemezett feladat, automatikus
> átállással:
>
> | Feladat | Ütem | Mikor | Mód |
> |---|---|---|---|
> | `DSH model retune daily` | naponta 09:00 | 2026-09-27 … **2026-10-04** | `apply` |
> | `DSH model retune weekly` | hetente, hétfőnként 09:00 | **2026-10-05-től** | `apply` |
>
> A napi feladat `/ED 2026/10/04` végdátummal áll le, a heti pedig `/SD 2026/10/05`
> kezdődátummal indul — így az átállás **automatikus**, nem kell kézzel
> átállítani. Átállítás kézzel, ha kell: `.\schedule-retune.ps1 -Cadence Daily|Weekly`.
>
> **A feladat három dolgot végez** (a `run-retune.ps1` mindhármat):
> 1. `retune.mjs` — elhalt modell-id-k felderítése és javítása,
> 2. `chain-doctor.mjs` — a fallback-láncok behangolása (lásd lent),
> 3. `clean-webview2-profiles.ps1` — a WebView2-profilok tisztítása.

### A napi behangolás valódi tartalma: `chain-doctor.mjs`

A `retune.mjs` csak azt nézi, hogy a beállított modell-id-k **léteznek-e**. Ez
kevés: egy modell szerepelhet a `/models` listában, és a hívás mégis elhalhat
(404 „not found for account", timeout, 429).

A `chain-doctor.mjs` ezért **minden célra valódi próbát küld** — egy
tool-hívást igénylő kérést —, méri a válaszidőt, és három kategóriába sorolja:

| Eredmény | Jelentés |
|---|---|
| `OK` | válaszolt, és **hívta a toolt** |
| `LASSU` | válaszolt, de > 5 s |
| `HALOTT` | timeout, 429, 404, 5xx, vagy nincs kulcs |

Ezután **stabil rendezéssel** a halottakat a lánc végére, az azonos
kategórián belül a gyorsabbakat előre sorolja. `--apply` nélkül csak riportot
ír; a napi feladat `apply` módban futtatja.

**Ez a gyakorlatban jobb sorrendet ad, mint a kézi beállítás.** Mért példa
(2026-09-27): a kézzel írt lánc
`nvidia/nemotron-3-super → nvidia/gpt-oss-20b → groq/gpt-oss-120b → …`
helyett a doctor ezt javasolta és alkalmazta:

```
groq/openai/gpt-oss-120b (229 ms) -> nvidia/nemotron-3-super-120b-a12b (1193 ms)
  -> nvidia/openai/gpt-oss-20b (2095 ms) -> ollama/qwen2.5-coder:14b
  -> openrouter/qwen/qwen3.8-27b:free (HALOTT: 429)
```

A helyi Ollama cold startja 15–70 s, ezért a doctor **külön, hosszabb
időkorlátot** használ neki (120 s), különben minden helyi cél halottnak tűnne.

A doctor kilépési kódja 1, ha van halott cél — így a Feladatütemező naplójában
is látszik, hogy beavatkozás kell.

### Az ütemezett feladat kezelése

```powershell
cd "C:\Szerver\Deepseek Harness\providers"

# állapot
schtasks /Query /TN "DSH model retune daily" /V /FO LIST
schtasks /Query /TN "DSH model retune weekly" /V /FO LIST

# azonnali futtatás
schtasks /Run /TN "DSH model retune daily"

# ütem átállítása (napi <-> heti)
.\schedule-retune.ps1 -Cadence Daily
.\schedule-retune.ps1 -Cadence Weekly
.\schedule-retune.ps1 -Cadence Daily -DryRun    # csak riport

# törlés
.\schedule-retune.ps1 -Remove
```

Napló: `providers\reports\retune-scheduled.log`
Riportok: `providers\reports\retune-*.md`, `providers\reports\chain-doctor-*.md`

### Miért nem a DSH beépített ütemezője

A `dsh-schedule` emlékeztetőket egy **élő sessionbe** kézbesít, fix
intervallummal; bezárt session esetén elavultan vár. Havi/napi karbantartásra
ez nem alkalmas — a Windows Feladatütemező a DSH futásától függetlenül lefut.

---

## 5b. A háttérszolgáltatás és az ütemezés viszonya

Két külön dolog, és **más a dolguk**:

| Szolgáltatás | Mire kell | Ha nem fut |
|---|---|---|
| **Windows Feladatütemező** (`DSH model retune …`) | a napi/heti behangolás | nincs behangolás |
| **Fallback proxy** (Startup parancsikon) | a delegált kérések kiszolgálása | **a gyermekek minden hívása elhal** (a szülő nem) |

A háttérszolgáltatás tehát **nem** futtatja a behangolást. Az a Feladatütemező
dolga, ami a proxy nélkül is lefut. A proxyra csak a subagent-kérésekhez van
szükség. A behangolás a proxy `/v1/models` végpontját is kérdezi; ha a proxy
áll, a `subagent-worker` sora hibát jelez a riportban, de a szkript nem hal el.

---

## 5c. Munkaterület és jóváhagyás

A munkamenet munkaterülete: **`C:\Szerver\Deepseek Harness`**. Ezen belül
íráshoz **nincs külön jóváhagyás** — mérve:

```
írás a munkaterületen BELÜL  -> SIKERES
írás a ~/.dsh-ba            -> MEGTAGADVA
```

A `providers\` mappa ezen belül van, ezért minden itteni változtatás
jóváhagyás nélkül megy. Ami **mindig** emelt hozzáférést igényel, mert a
munkaterületen kívül van:

| Útvonal | Miért |
|---|---|
| `~\.dsh\settings.yaml` | a providerek és az allowlist élő helye |
| `~\.dsh\.credentials.yaml` | a kulcsok |
| `~\.dsh\profiles\web\cordis.patch.yml` | a subagent-útvonal beállítása |
| `~\AppData\Roaming\...\Startup\` | a proxy indítóparancsikona |
| `~\AppData\Local\npm-cache\...` | a gyári preset (csak tesztelésnél kellett) |

**A munkamenet hatókörét utólag nem lehet bővíteni** — az indításkor rögzül.
A `~\.dsh` a `C:\Szerver` alatt nem érhető el, tehát egy szülőkönyvtárral sem
lefedhető; külön engedélyezést igényelne a DSH indításánál.

Egy figyelmeztetés: a `state\webview2` **a munkaterületen belül van**, mégis
emelt hozzáférést kért a törlés. A „munkaterületen belül" nem garancia minden
műveletre.

---

## 6. Subagent — a beállított, működő rendszer

> **ÁLLAPOT: beállítva és élesben igazolva. Használható.**
>
> A delegált munka a `subagent-worker` route-on megy — egy helyi proxyra, ami
> a `worker` láncot szolgálja ki ingyenes providereken. A fő szál a fizetős
> `deepseek-official` route-on marad.
>
> **Mért igazolás (2026-09-27):** a gyermek-session (`delegationDepth: 1`) a
> `subagent-worker/worker` route-ot használta, a proxy naplója szerint
> `HIT nvidia/nvidia/nemotron-3-super-120b-a12b` — **elsőre talált, 0 USD-ért**.
> A gyermek toolt is hívott (`pwsh`), és a delegálás 11–14 s alatt lefutott.
>
> **Kódvédelem:** a gyermek `toolFilter`-rel nem érheti el a `write`, `edit`
> és `str_replace_editor` eszközöket — fájlt nem módosíthat. Ez fizikai
> korlát, nem viselkedési kérés.
>
> **Egyetlen gyenge pont:** ha a proxy nem fut, a gyermekek minden hívása
> elhal (a szülő nem). A proxy a Startup mappából indul bejelentkezéskor.
> **Ez a gyenge pont 2026-09-29-én élesben meghibázott — lásd a 6d. szakaszt.**

### 6d. A 2026-09-29-i hiba: két önálló ok, mérve

A bejelentés: „az automatikus subagent delegálás ingyenes modellre nem működik,
mintha egy használat után behalt volna; ráadásul megjelent egy csoportosítatlan
munkaterület a bal sávon". Mindkettő igaz, de **két külön hiba**, és a második
nem a delegálás hibája.

#### A) A proxy elhalt és nem indult újra

Mért tények:

| Bizonyíték | Érték |
|---|---|
| `providers\proxy.out.log` utolsó sora | `2026-09-27T16:19:31Z FALLBACK nvidia/...` |
| `providers\proxy.err.log` | **0 byte** — nem volt hibaüzenet |
| `providers\proxy.pid` → PID 240320 | nem létező folyamat |
| 4123-as port | nem figyelt (semmi) |

Tehát a proxy **minden hibaüzenet nélkül** halt el, és a Startup parancsikon
(ami egyszer fut bejelentkezéskor) nem hozta vissza. Onnantól a
`subagent-worker` route nem válaszolt: a gyermek-session minden hívása elhalt.
Ez a „behalt" tünet.

**Miért nem elég a Startup mechanizmus:** egyszer fut, és nem próbálkozik újra.
A javítás ezért **önjavító**: `watchdog-subagent-proxy.ps1` + telepítő.

#### B) A második, rejtettebb hiba: néma lecsúszás a helyi Ollamára

Ez akkor jelentkezik, ha a proxy **fut**, de a provider-kulcsok nem oldódtak fel
(pl. mert a `run-proxy-service.ps1` helyett közvetlenül `node proxy.mjs`-ként
indult). A régi `routeChain()` ilyenkor **csendben kihagyta** a felhős
providereket, és a `worker` lánc egyetlen elemre csúszott.

**Mért érték (2026-09-29, kulcsok nélkül indított proxy):**

```
ido: 117668 ms                    <- 2 perc csend
model: qwen2.5-coder:14b          <- helyi Ollama
tool_calls: (üres)
content: {"name": "get_weather", "arguments": {"city": "Budapest"}}
```

A modell nem `tool_calls`-t adott, hanem **content-be csomagolt pszeudo-hívást**.
A DSH-nak ez használhatatlan — pontosan „behalt delegálásnak" látszik, pedig a
proxy „működött".

**Javítás (kód, nem szokás):** a `config.json` `requiredAnyEnv` szakasza
megmondja, melyik route-hoz kell legalább egy kulcs. Ha nincs, a proxy **nem esik
vissza a helyire**, hanem 503-at ad:

```
route worker: (nincs használható cél) [HIANYZO KULCS: GROQ_API_KEY, NVIDIA_API_KEY, OPENROUTER_API_KEY]
```

A `local-only` route szándékosan helyi marad. **Ellenőrizve** (kulcs nélküli
indítás, 2026-09-29): a `verify-subagent-chain.mjs` 1-es kilépéssel és
`worker lánc: üres` hibával jelent.

**A helyes lánc, kulcsokkal mérve:**

```
ido: 409-550 ms
model: openai/gpt-oss-120b        <- groq, ingyenes
tool_calls: {"name":"get_weather","arguments":"{\"city\":\"Budapest\"}"}
```

#### C) A „Csoportosítatlan" a bal sávon — nem delegálási hiba

A bal sáv „Csoportosítatlan" (Ungrouped) csoportja azokat a session-öket
mutatja, amelyeket egyetlen munkaterület sem jegyez fel
(`dsh-client-ui-workspace`: `groupByWorkspace` → `stray`). A mérés szerint:

| Session | Mi az | Nyilvántartva? |
|---|---|---|
| 9 db `session-…` (09-27, 15:09–16:19) | a delegálási tesztek **szülői**, üres naplóval | nem |
| 9 db csupasz UUID (ugyanakkor) | a hozzájuk tartozó **delegált gyermekek** (`origin: subagent`, `delegationDepth: 1`) | nem |

A gyermek fejlécében ott a `cwd` és a `parentSession`, de a
`storages\workspace.json` `sessionIds` listájában egyik sem szerepel — a
nyilvántartás csak a felhasználó által indított session-öket tartalmazza.
Ezért minden delegálás egy új, gazdátlan sorral szaporítja a csoportot.

**Javítás:** `classify-subagent-sessions.mjs` — a gyermekeket a szülő
munkaterületéhez sorolja. A 9 szülő maga is gazdátlan, ezért az
`--adopt-parents` kapcsoló azokat is besorolja (különben a gyermek
hozzárendelése nem szünteti meg a gazdátlan sort).

**Fontos:** a DSH a `workspace.json`-t **induláskor** olvassa, ezért a változás
csak **újraindítás után** látszik a sávon.

#### D) A javítás állapota és a korlát

| Elem | Állapot |
|---|---|
| `proxy.mjs` néma lecsúszás megszüntetése | **kész, mérve** |
| `config.json` `requiredAnyEnv` | **kész, mérve** |
| `watchdog-subagent-proxy.ps1` észlelés + újraindítás | **kész, mérve** |
| `verify-subagent-chain.mjs` | **kész, mérve** (OK és hibaág is) |
| `classify-subagent-sessions.mjs` | **kész, riport mérve** (írás még nem futott) |
| **tartós watchdog-folyamat indítása** | **a felhasználónak kell futtatnia** |

**A watchdog mérése** (`reports\proxy-watchdog.log`):

```
2026-09-29T12:18:44+02:00 KIESES (#1): a proxy nem valaszol a 4123 porton — ujrainditas
```

A kiesés észlelése és az újraindítás indítása igazolt: a watchdog a
`run-proxy-service.ps1`-t hívja (ez oldja fel a kulcsokat), majd a
`verify-subagent-chain.mjs` az újraindítás után `openai/gpt-oss-120b`-t mért.

**A korlát, amit nem lehetett itt igazolni:** tartós folyamatot a DSH
sandboxából **nem lehet** indítani. A `dsh-subprocess-local` minden gyermeket
egy Win32 Job objektumban tart, és a munka végén `terminateJob`-bal kilövi a
teljes fát — mérve: `Start-Process`-szel indított watchdog és proxy is elhalt a
parancs végén. Ugyanezért nem volt írható a Feladatütemező sem
(`schtasks /Create` → „A hozzáférés megtagadva", emelt hozzáféréssel is).

Ezért a telepítést **a felhasználó futtatja** egy szokásos PowerShell-ablakból:

```powershell
cd "C:\Szerver\Deepseek Harness\providers"
.\install-subagent-proxy.ps1
```

A `-WindowStyle Hidden` és a leválasztott indítás együtt gondoskodik róla, hogy
ne villanjon fel ablak, és a ciklus a DSH-tól függetlenül fusson. Ha ez a
gépházirend miatt sem megy: `.\start-watchdog.ps1`.

---

### Hogyan működik

A `subagent` tool a gyári **standard** presetben így áll össze:

```yaml
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    modelSelectionSettings: true    # ← ez engedi a modellenkénti választást
    backgroundMode: continuable
```

Két mechanizmus áll rendelkezésre:

1. **Allowlist** (`subagent-model-selection` settings namespace):
   `{ enabled: bool, allowedModels: [{ provider, model }] }`. Ez a **host
   beállítása**, a Settings → Plugins alatt (vagy YAML-ban) érhető el.
   **Fontos korlát:** ez csak az *explicit* modellválasztást korlátozza. Az
   örökölt (nem explicit) route-ot nem érinti, mert ott nem történt
   modellválasztás. Duplikált route-ot elutasít.
2. **Gyermek-alapértelmezés** a tool `agentOptions` mezőjén (`provider`,
   `model`, `reasoningEffort`, `maxTokens`). Ez **determinisztikus**: minden
   gyermek ezt kapja. Ez az **agent-preset** kompozíciójában él, nem a
   `settings.yaml`-ban — tehát a standard preset másolatát kell szerkeszteni a
   `$DSH_HOME\.agent-presets` alatt.

### A javaslatom

> ⚠️ **Ez a szakasz a MÓDOSÍTÁS ELŐTTI javaslat, és a mechanizmus leírása
> helyes, de a beállítás HELYE hibás.** Azt írtam, hogy az `agentOptions` a
> presetbe kerül — a mérés ezt megcáfolta. A helyes út a profil-patch id
> szerinti felülírása, lásd a **„A pontos terv — MÉRÉSSEL IGAZOLVA"** szakaszt.
> A lenti modellválasztás (melyik modell mire) továbbra is érvényes.

**A `subagent_fork`-ot hagyd békén.** A fork szándékosan a szülő route-ját
örökli, hogy a másolt beszélgetés-prefix KV Cache-kompatibilis maradjon. Ha
átirányítod, elveszíted a cache-egyezést — a megtakarítás elpárolog.

**A `subagent`-et állítsd ingyenes, de bizonyítottan tool-képes modellre.** A
subagent teljes agent-loopot futtat toolokkal, ezért a gyenge tool-calling a
leggyakoribb hibaforrás. Erre a célra a konfigodban ezek bizonyítottan jók:

| Szerep | Provider / modell | Miért |
|---|---|---|
| Delegált munka (alap) | `groq` / `openai/gpt-oss-120b` | gyors, ingyenes, bizonyítottan tool-képes |
| Nagy kontextusú kutató | `nvidia` / `moonshotai/kimi-k2.6` | 262k kontextus, ingyenes |
| Kód-specifikus | `openrouter` / `cohere/north-mini-code:free` | kódra szánt |
| Bizalmas (nem hagyhatja el a gépet) | `ollama-local` / `qwen2.5-coder:14b` | helyi |
| Kép + tool | `ollama-local` / `qwen3-vl:8b` | az egyetlen helyi, ami mindkettőt tudja |

**Amit NE tegyél subagentre:** a `qwen2.5:7b-instruct`-et és a többi kis helyi
modellt. Működnek egyszerű kérdésre, de a tool-callingot gyakran elrontják, és
a subagent épp az a hely, ahol ez a legdrágább hiba.

**A legegyszerűbb út, amit javaslok:** Settings → Plugins →
`subagent-model-selection` → `enabled: true`, és az `allowedModels` listába a
fenti modellek. Ez ad-hoc választást enged a dolgozó modellnek, de a rossz
választásokat kizárja. Ha viszont **determinisztikus** viselkedést akarsz
(minden gyermek fixen ugyanazt kapja), akkor a preset-útra kell lépni: másold a
standard preset `agent.cordis.yml`-jét a `$DSH_HOME\.agent-presets\standard\`
alá, és a `tool-subagent` sor `config` blokkjába vedd fel:

```yaml
    agentOptions:
      provider: groq
      model: openai/gpt-oss-120b
      reasoningEffort: low
      maxTokens: 32768
```

Ha kéred, ezt a preset-másolatot összeállítom és beállítom.

### Költség-hatás — mért adatok

A `~/.dsh/sessions` naplóiból kinyert valós fogyasztás (11 session, 2026-09-27):

| Mérőszám | Érték |
|---|---|
| Modellhívások | **3 143** |
| Friss input | 5 680 032 token |
| Output | 1 966 671 token |
| **Prompt-cache olvasás** | **1 081 724 032 token** |
| Költség `deepseek-flash` áron | **$4,37** |
| Ugyanez `deepseek-v4-pro` áron | $8,10 |
| 1000 hívásra vetítve | $1,39 |

Használt route-ok: `deepseek-official/deepseek-flash` (70×),
`deepseek-official/deepseek-v4-pro` (3×) — **mind fizetős, effort `high`**.

**A költség 69%-a a cache-olvasás**, ami elsőre furcsa, de magyarázható: a
DeepSeek cache-olvasás **50× olcsóbb**, mint a friss input ($0,0028 vs $0,14 /
1M token). Ha nem lenne prompt-cache, ugyanez a fogyasztás **$152,79** lenne —
a cache **$148,41-t (97,1%) takarít meg**.

Ebből két következtetés adódik, és a második a fontosabb:

1. **A delegálás megtakarítása szerény a fő szálhoz képest.** Ha a forgalom
   20–50%-át ingyenes modellre viszed, az a mai $4,37-ból **$0,87–$2,19**.
   Valódi, de nem drámai.
2. **A cache-t nem szabad feláldozni.** Mivel a cache 50×-es szorzó, a
   `subagent_fork` route-öröklése nem „kihagyott megtakarítás", hanem a
   legnagyobb költségtétel védelme. Ha a forkot átirányítod, a másolt
   beszélgetés-prefix elveszti a cache-egyezést, és a 97%-os megtakarítás egy
   részét elbukod — ez könnyen több, mint amit a modellcserén nyersz.

**A helyes használat tehát:** a `subagent` a cache-től független, önálló loop →
azt vidd ingyenes modellre. A `subagent_fork` a szülő kontextusát viszi tovább →
azt hagyd a szülő route-on.

**És a legfontosabb:** a valódi tét nem a `deepseek-flash` $4,37-a, hanem hogy
egy pillanat alatt `deepseek-v4-pro`-ra válthat valaki (2×), vagy egy effort- és
kontextus-növelő beállítás 10×-ezheti a fogyasztást. Az ingyenes kertek
(Groq / NVIDIA / OpenRouter `:free`) ezzel szemben **$0,00** — de az adataidat
tanításra használhatják, és rate limit alatt állnak. Bizalmas munkára a helyi
Ollama a helyes cél, nem az ingyenes felhő.

### Mennyit lehet biztonságosan spórolni

**A mért alap:** 3 143 modellhívás → **$4,37** (11 valós session), azaz
**$1,39 / 1000 hívás**. A költségmodell linearitását ellenőriztem: a
session-szintű összeg független számításból $4,54 lett (a különbség a
teszt-futások és az egy `?` providerű sessionök), ami a $4,37-et megerősíti.

**Mért egységköltség egy delegált hívásra** (a tesztből):

| Route | Költség / hívás |
|---|---|
| `deepseek-flash` (örökölt) | $0,00107 |
| `deepseek-v4-pro` (a teszt célmodellje) | $0,00331 |
| ingyenes (Groq / NVIDIA / OpenRouter `:free`) | **$0,00000** |

**A megtakarítás a mai volumenen:**

| Delegált hányad | Megtakarítás / futás |
|---|---|
| 10% | ~$0,44 |
| 20% | ~$0,87 |
| 30% | ~$1,31 |
| 50% | ~$2,19 |

Ez **szerény összeg**, és ezt érdemes kimondani: a fő tétel nem a
`deepseek-flash` $4,37-a, hanem hogy egy rossz beállítás (Pro modell, magasabb
effort, nagyobb kontextus) 2–10×-ezheti a fogyasztást. A delegálás
átirányításának értéke **inkább a kiszámíthatóság**, mint a megtakarítás.

**A biztonságos mérték — mért korlátok.** A Groq a válaszfejlécekben
közzéteszi a kvótát:

```
x-ratelimit-limit-requests: 1000
x-ratelimit-limit-tokens:   8000      ← ez a szűk keresztmetszet
x-ratelimit-reset-tokens:   ~0,7–4 s
```

- **8 000 token / perc.** Egy delegált hívás a méréseim szerint néhány száz – pár
  ezer token (a szülő kontextusa nélkül), tehát a gyakorlati plafon nagyjából
  **10–20 hívás / perc**. Ez párhuzamos subagenteknél szűkös, de egy-két
  gyermeknél bőven elég.
- **1 000 kérés / ablak.** Az ablak hosszát nem tudtam egyértelműen megállapítani
  (a `reset-requests` 13 perctől indul, de a limit 1000-re van állítva, ami
  inkább napi kvótára utal). **Tartós terhelést nem terveztem rá** — ha a
  delegálás napi több ezer hívás lenne, ez elfogyna.
- **NVIDIA NIM:** nem ad rate-limit fejlécet, egy hívás 1,0 s volt, 82 modell
  érhető el. Emiatt **jobb első választás** a Groqnál nagyobb delegálási
  volumenre — de a kvóta ott is ismeretlen, ezért terhelés alatt mérni kell.
- **OpenRouter `:free`:** egyenleg nélkül nagyon szűk (nagyságrendileg 50
  kérés/nap), ezért tartós delegálásra nem alkalmas.

**A javasolt biztonságos beállítás:** a delegálást a modellhívások
**~20–30%-áig** engedni (≈ $0,9–1,3 / futás megtakarítás), a célmodellt
elsődlegesen **NVIDIA NIM**-re tenni a nagyobb volumen miatt, és a Groqot
megtartani a gyors, kis feladatokra. A terhelést érdemes a `proxy.mjs`
`/healthz` és a provider-fejlécek figyelésével kísérni.

**Amit ez nem old meg:** a szülő agent továbbra is fizetős marad, és a
delegálás **összes koordinációs hívása** (a `subagent` tool meghívása, az
eredmény visszaolvasása, az esetleges utánkövetés) a szülőn fut. A valódi
megtakarítás felső korlátja tehát nem 100%, hanem a delegált munka aránya
minusz a koordinációs overhead.

> **FONTOS: az eredeti javaslatom hibás volt, és a mérés megcáfolta.**
> Azt írtam, hogy az `agentOptions` a **preset** `tool-subagent` sorába kerül.
> Ez **nem működik**. A helyes út a profil-patch id szerinti felülírása.
> Az alábbi szakasz a javított, mért eredményt tartalmazza.

**1. lépés — a jelenlegi állapot.** A `check-subagent.ps1` ellenőrzi, van-e
célmodell beállítva:

```
Nincs subagent célmodell beállítva.
Ez azt jelenti: a subagent a SZÜLŐ route-ját örökli
(jelenleg az agent-default-model: deepseek-flash).
```

**2. lépés — hol kell beállítani.** Ez a lényeg, és ezt három hibás
próbálkozás után mértem meg:

| Próbálkozás | Eredmény |
|---|---|
| `- insert:` a profil-patchbe | ❌ `duplicate loader entry id: tool-subagent` |
| `agentOptions` a **preset** `tool-subagent` sorába (a javaslatom) | ❌ a gyermek **a szülő modelljét** kapta |
| `agentOptions` **id szerinti felülírás** a profil-patchben | ✅ **a gyermek a beállított modellt kapta** |

Az ok: a `tool-subagent` sor a **`dsh-base`-ből** jön (a base
`cordis.patch.yml` 349. sora). A **web** profil ezt a sort `disabled: true`-vé
teszi, és a preset-re bízza — ezért ott a preset-út lenne a helyes. A
**headless** profil viszont nem tiltja le, ezért ott a base sora nyer, és a
preset `agentOptions`-a sosem érvényesül.

A helyes beállítás a profil patch-fájljába (`cordis.patch.yml`):

```yaml
# Az id szerinti felülírás a sor TELJES config-ját cseréli, ezért minden
# megtartandó kulcsot újra fel kell sorolni.
- id: tool-subagent
  config:
    provider: spawn
    toolName: subagent
    modelSelectionSettings: true
    backgroundMode: continuable
    agentOptions:
      provider: groq
      model: openai/gpt-oss-120b
      reasoningEffort: low
      maxTokens: 32768
```

**3. lépés — a `modelSelectionSettings` buktatója.** Ez a kulcs megköveteli a
`@deepseek-ai/dsh-tool-subagent/model-selection-settings` plugint a **Host
scope-ban**, különben a boot elhal:

```
tool-subagent: `modelSelectionSettings` requires
@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope
```

A web profil ezt mountolja (`subagent-model-selection-settings` sor), a
headless nem. A web profilban tehát ez a kulcs **maradhat**; ha valaha
headless profilban állítod be, vagy a plugint is mountolni kell, vagy hagyd ki
a kulcsot (az `agentOptions` önmagában is működik).

**4. lépés — az allowlist (opcionális).** A `subagent-model-selection`
namespace a `settings.yaml`-ban. **Csak az explicit modellválasztást
korlátozza** — az örökölt route-ot nem érinti, ezért a 2. lépés nélkül a
legnagyobb rész fizetős marad:

```yaml
subagent-model-selection:
  enabled: true
  allowedModels:
    - { provider: groq, model: openai/gpt-oss-120b }
    - { provider: nvidia, model: moonshotai/kimi-k2.6 }
    - { provider: openrouter, model: cohere/north-mini-code:free }
    - { provider: ollama-local, model: qwen2.5-coder:14b }
```

**5. lépés — ellenőrzés.** A `check-subagent.ps1` minden célmodellre valódi
tool-hívást próbál.

### A mérés, ami igazolta a mechanizmust

Két headless futás, ugyanaz a delegálási feladat:

| Futás | Szülő | Gyermek (`delegationDepth: 1`) |
|---|---|---|
| `agentOptions` a presetben | `deepseek-flash` | ❌ `deepseek-flash` (örökölt) |
| `agentOptions` id szerinti felülírásban | `deepseek-flash` | ✅ **`deepseek-v4-pro`** |

A gyermek-sessionök `request/header` eseményéből olvasva. A célmodellt
szándékosan a szülőtől eltérőre (Pro) állítottam, hogy a hatás
félreérthetetlen legyen.

### Amit NEM javaslok

- **A `subagent_fork` átirányítása.** A fork a szülő kontextusát viszi tovább;
  a cache-egyezés elvesztése többe kerül, mint a nyereség (lásd a
  cache-számítást feljebb).
- **A kis helyi modellek** (`qwen2.5:7b-instruct`, `llama3.1:8b`) delegálásra.
  A subagent teljes agent-loopot futtat; ezek a tool-callingot elrontják.
- **A preset-út a headless profilban.** Mért hiba, lásd fent.

---

## 7. Eszközök

| Fájl | Szerep |
|---|---|
| `check-providers.mjs` | Minden provider: él-e a kulcs, léteznek-e a felvett modell-id-k |
| `check-ollama.mjs` | Melyik helyi Ollama modell tud tool-callingot |
| `check-google.mjs` | Google: melyik modell hívható, és melyik tud toolt |
| `check-subagent.ps1` | Van-e subagent célmodell, és alkalmas-e delegálásra |
| `retune.mjs` | Havi újrahangoló (`--apply` ír, anélkül csak riport) |
| `clean-webview2-profiles.ps1` | A felhalmozódott WebView2-profilok tisztítása |
| `run-retune.ps1` / `run-retune.cmd` | A Feladatütemező belépési pontja (retune + tisztítás) |
| `register-monthly-retune.ps1` | A havi feladat regisztrálása/törlése |
| `proxy.mjs` / `config.json` | Fallback proxy |
| `config.test.json` | Szándékosan hibás lánc a fallback teszteléséhez |
| `settings.llm-pi-ai.yaml` | Provider-sablon (ellenőrzött id-kkel) |
| `README.md` | Üzemeltetési útmutató |

## 8. Mentések és visszaállítás

| Fájl | Tartalom |
|---|---|
| `~/.dsh/settings.yaml.bak-20260927-143052` | a javítás ELŐTTI settings.yaml |
| `~/.dsh/.credentials.yaml.bak-20260927-143052` | a javítás előtti credential store |
| `~/.dsh/settings.yaml.bak-<időbélyeg>` | a havi újrahangoló minden írás előtt készít |

Visszaállítás:

```powershell
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-20260927-143052" `
          "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

---

## 9. Nyitott pontok

1. **A `toolFilter` futásidejű viselkedését nem igazoltam.** A profil betölt
   vele (exit 0), és a gyermek toolt is hívott — de azt nem mértem, hogy egy
   írási kísérlet valóban elutasításra kerül-e. Érdemes egyszer kipróbálni egy
   delegálással, amelyik írni próbál.
2. **A párhuzamos delegálást nem teszteltem** élesben, ahol egyszerre több
   gyermek indul. A Groq 8 000 token/perc korlátja ott a legszűkebb.
3. **A `git push` hitelesítés hiányában elhalt** (`SEC_E_NO_CREDENTIALS`).
   A commit elkészült (`18e45bc`), de a pushhoz token vagy SSH-kulcs kell.
4. **A `DshWindow.exe` nem takarítja a WebView2-profilokat.** Ez nem
   konfigurációs hiba, hanem a program viselkedése: minden ablakindításkor új
   `gen-*` profil jön létre. A napi feladat kezeli, de a valódi javítás a
   `src\DshWindow.cs`-ben lenne (a régi generáció törlése indításkor, a
   `pane-*` profilok megtartásával). 2026-09-27-én 2,1 GB-ot szabadított fel a
   kézi tisztítás.
3. **A fallback proxy nincs állandóan futva.** Kézzel indítható
   (`start-fallback-proxy.ps1`), de nincs bejegyzése a bejelentkezéskori
   indításba. Ha kell, a tálcaikon mintájára megoldható.
4. **A Google kvóta/túlterhelés miatt kihagyott modelljei** (`gemini-3.5-flash`,
   `gemini-3.1-pro-preview`, …) a listán maradtak; ha tartósan hibáznak, a havi
   újrahangoló nem fogja kivenni őket, mert *léteznek* — csak hívhatók
   időnként.
5. **A `dsh-local-ai` plugin** (Ollama-kezelés, pull/remove, `/ollama` parancs,
   local-first routing fallbackkel) a `0.1.5-rc.2`-re van tesztelve, a `-rc.3`-on
   nem garantált. Nem telepítve.
6. **A 0.1.7-re frissítés** megnyitná a `dsh-llm-fallbacks` és `dsh-autotier`
   plugineket — akkor a proxy kiváltható lenne. Ez külön döntés, és a
   `dsh-ui-extras` patchet is újra kellene ellenőrizni.
7. **Alibaba Cloud / Qwen bekötése — API-kulcsra vár (2026-10-01).** A
   felderítés kész, a telepítés nem: nincs `DASHSCOPE_API_KEY` a credential
   store-ban. Minden anyag külön dokumentumban:
   **`providers/ALIBABA-QWEN-TERV.md`** — végpontok, régióhoz kötött kulcs,
   modellek és árak, a DSH-ba kötés konkrét YAML-je, a négy ismert akadály, és
   a mérési terv arra a pillanatra, amikor a kulcs megvan.

   A lényeg előre: a Qwen **funkcionálisan** ugyanúgy bevethető (chat +
   tool-hívás + reasoning a `dsh-llm-pi-ai`-n át), és kontextusban / rate
   limitben egyértelműen jobb a DeepSeeknél — de **drágább** (a `deepseek-flash`
   csúcsidőn kívül ~2× olcsóbb inputon, ~2,5× outputon, ~20× cache-találaton),
   nincs natív katalógus- és ár-integrációja, és egy dokumentált `stream` +
   `tools` ütközés miatt **élő próbát igényel, mielőtt bármit erre építünk**.

---

## 10. A „DSH web szerver" — mi ez pontosan

Három külön dolog, amit könnyű összekeverni:

| Réteg | Mi ez | Hol látszik |
|---|---|---|
| **`dsh web`** | Node folyamat: a HTTP-szerver + a Host (LLM, session, toolok) | `state\harness.pid`, `state\harness.log` |
| **`DshWindow.exe`** | WPF + WebView2 ablak, ami a szerver URL-jét **megjeleníti** | `state\window.log`, `Get-Process DshWindow` |
| **Tálcaikon** | Felügyelő: indítja/figyeli/újraindítja a szervert és az ablakot | `state\tray.log` |

A `DshWindow.exe` **nem** a szerver — ha az ablak nyitva van, attól a szerver
még állhat, és fordítva. A tálcaikon `egészség-ellenőrzés` sorai ezt a kettőt
mérik külön (`szerver=`, `token=`).

### Amit érdemes ellenőrizni

**1. Él-e a szerver.** A token nélküli kérés `401`-et ad, ha a szerver fut —
ez a helyes, várt válasz:

```powershell
try { Invoke-WebRequest http://127.0.0.1:3080/ -UseBasicParsing -TimeoutSec 5 | Out-Null; "200" }
catch { "HTTP $($_.Exception.Response.StatusCode.value__)" }   # 401 = fut
```

**2. Figyel-e a port.** `netstat` megbízhatóbb, mint a `Get-NetTCPConnection`:

```powershell
netstat -ano | Select-String ':3080'
```

> **Mért tanulság:** a `Get-NetTCPConnection` ezen a gépen **üres eredményt ad
> emelt jogosultság nélkül**, ami könnyen azt a téves következtetést adja, hogy
> „nem fut a szerver". A `netstat` és a HTTP-próba a megbízható módszer.

**3. A naplók, fontossági sorrendben:**

| Fájl | Mit mond meg |
|---|---|
| `state\tray.log` | ki indította/újraindította a szervert, és miért |
| `state\harness.log` | a szerver URL-je tokennel |
| `state\harness.err.log` | a szerver indulási hibái |
| `state\window.log` | az ablak (WebView2) eseményei |
| `state\harness.url.err` | **a tényleges indulási hiba**, ha volt |

A `harness.url.err`-ben egy korábbi indítás ezt írta:

```
Error: EPERM: operation not permitted, open '%USERPROFILE%\.dsh\profiles\web\cordis.yml'
```

Ez **nem** a jelenlegi állapot, hanem egy régi, jogosultsági okból elhalt
indítás maradványa — pontosan az a hibaosztály, amibe a sandbox miatt én is
futottam. A napló megmondja, melyik indításról van szó.

**4. Az egészség-ellenőrzés naplója.** A tálca 4 másodpercenként méri a
szervert és a tokent. A `2026-09-27 12:44:22 egeszseg-ellenorzes: szerver=False
token=True` sor egy **pillanatnyi** állapotot rögzít; a `szerver=True
token=False` eset viszont automatikus újraindítást indít (`automatikus
onjavitas: ujrainditas`). Ez a mechanizmus működik — 10:42:05-kor le is futott.

### A jelenlegi tényleges állapot (2026-09-27)

- Szerver: **fut** (PID 223424, `127.0.0.1:3080` LISTENING, HTTP 401 tokennel
  szemben).
- Ablak: **fut** (PID 149712, `pane-1`/`pane-2` profilokon).
- Tálca: fut (utolsó naplósor 12:44:22).
- `state\webview2`: 2,2 GB → **95 MB** a tisztítás után.

### Amit érdemes rendszeresen nézni

- `state\webview2` mérete — ha újra nő, a havi feladat kezeli, de a valódi
  javítás a `DshWindow.cs`-ben lenne (lásd a 9. szakasz 2. pontját).
- `state\*.log` mérete — a `window.log` és `ui-extras-client.log` nő; a
  `window.log.1` rotáció létezik, az `ui-extras-client.log`-nak nincs.
- `providers\reports\retune-scheduled.log` — a havi karbantartás eredménye.

---

## 11. Delegálás a statisztikában és az automatizált futások csatornája (2026-09-30)

**A bejelentés:** „nem jelennek meg az ingyenes delegálás adatai a statisztikában,
állandó, beégett számok vannak a subagent költség résznél; illetve az
automatizáció egy csomó munkamenetet beszemetel a listára."

### 11.1 A mért ok — nem beégett szám, hanem összevont szám

A `/ui-extras/usage?days=30` élő válasza és a session-naplók egyeztek:

| Tény | Érték |
|---|---|
| Delegált kérés (30 nap) | 284 / 7204 (3,9%) |
| Ebből **ingyenes láncon** (`worker`) | **10 kérés, 5 session — $0.0000** |
| Ebből **fizetős route-on** (`deepseek-flash`, `deepseek-v4-pro`) | 274 kérés — $0.3019 |
| Utolsó delegálás | **2026-09-29 10:44** (azóta egy sem) |

A régi felület egyetlen „Delegált költség / baseline" sorba mosta a kettőt:
$0.3019 vs $0.3108 → $0.0089 megtakarítás, amiben a 274 fizetős kérés elnyomta a
10 ingyeneset. Ezért tűnt úgy, hogy „nincs ingyenes delegálás", és mert
09-27/09-29 óta nincs új delegálás, a szám valóban állt.

**Javítás** (`plugins\dsh-ui-extras\lib\index.js`, `scanUsage`):
- `delegated.free` / `delegated.paid` zseb (kérés, token, költség, baseline,
  session) — a szétválasztás a **nulla árú ártábla-sor** alapján történik
  (`isFreeModel`), nem a modellnév kitalálásával. Az ismeretlen modell a Flash
  sorára esik, tehát sosem lesz „ingyenes".
- `delegated.freeSavingsUsd` — a valódi megtakarítás (csak a 0 árú kérésekből).
- `delegated.models` — modellenkénti bontás (`free` jelzővel).
- `delegated.lastAt` — az utolsó delegált kérés ideje, hogy a régi adat ne
  tűnjön beégettnek.
- A kliens (`lib\client.js`) a két zsebet külön sorban mutatja, és **visszaesik**
  a régi összevont sorra, ha a host fél még a régi (nincs benne a bontás).
- `tools\check-usage.mjs`: új ellenőrzések a bontás konzisztenciájára
  (zsebek összege = delegált összeg, az ingyenes zseb költsége 0, a modell-jelzők
  helyesek).

### 11.2 A lista-szemét forrása — a headless futás saját sessionje

A `session-24fa376c` (09-27 08:43) naplójában megvan a bizonyíték: a delegálás
tesztek `dsh\lib\bin.js` **headless futásokkal** indultak, mindegyik egy
**top-level sessiont** hozott létre a projekt könyvtárában (09-27 15:09–16:19,
9 db, a sávon „Delegate … via subagent" címekkel). A 10 valódi subagent-gyerek
**nem** látszik a sávon: a `dsh-client-ui-workspace` `sessionVisible()`-je
kizárja az `origin: "subagent"` sorokat. A szemét tehát a headless **szülők**.

**Javítás:**
- `providers\run-headless-task.ps1` — a headless futás a dedikált `.automation`
  könyvtárból indul, és futás előtt regisztrálja azt külön munkaterületként,
  így a gépi session-ök külön csoportba kerülnek (a DSH bootstrapja amúgy is
  külön munkaterületet csinál minden olyan könyvtárból, amelyben session van).
- `providers\session-channel.mjs` — a meglévő gépi session-ök riportja,
  elrejtése (`--hide`) és visszahozása (`--unhide`), valamint a csatorna
  regisztrálása (`--channel`).
- Host route: `GET/POST /ui-extras/workspace-session` a `dsh-ui-extras`
  pluginban (`archive` / `unarchive` / `workspace`). Azért host-oldali, mert a
  `storages\workspace.json`-t a DSH **csak induláskor** olvassa: a futó host a
  registryt a memóriában tartja, így a kézi fájlszerkesztést a következő
  registry-írás felülírná. Az archiválás a futó registry-én megy át, ezért
  azonnal és tartósan érvényes.
- Az archiválás **nem törlés**: az `archivedSessionIds` csak a sávból és a
  keresésből veszi ki a sessiont, a napló a helyén marad — a 30 napos
  statisztika továbbra is számol vele. Ezért a két cél nem ütközik.
- **Korlát:** ebben a DSH-buildben nincs `unarchiveSession` a registryn, ezért a
  visszahozás a registry `setState`-jével történik (csak kiveszi az id-t az
  archívumból, a sorrendhez nem nyúl). Ha egy jövőbeli build máshogy tárolja az
  állapotot, ez a route hibát ad — a többi út érintetlen marad.

### 11.3 Amit tudni kell az élesítéshez

- A **host fél** új verziója csak **szerver-újraindítással** töltődik be; a
  kliens fél újratöltéssel.
- A headless profilban a `tool-subagent` a `dsh-base`-ből jön, ezért ott a
  gyermek a **szülő route-ját** örökli (fizetős). Az ingyenes lánchoz
  `run-headless-task.ps1 -Patch providers\test-subagent-worker.patch.yml`.
- A csatorna-könyvtár (`.automation`) a `.gitignore`-ban van.

### 11.4 A gyökér-ok: a GUI-ból indított gyermek SOSEM kapja meg az ingyenes route-ot (2026-09-30)

Ez a szakasz a 6. pont korábbi következtetését **pontosítja**: ott a kiesés
okaként a proxy néma lecsúszása szerepelt. A proxy azóta is egészséges
(`verify-subagent-chain.mjs`: valódi tool-hívás 461 ms alatt, Groq
`openai/gpt-oss-120b`), a gyermekek mégsem az ingyenes láncon futnak.

**A mért tények:**

| Bizonyíték | Érték |
|---|---|
| Utolsó **ingyenes** delegálás | **2026-09-27 16:19** (azóta egy sem) |
| Az összes ingyenes kérés | 10 kérés / 5 gyermek — **mind a 09-27-i headless tesztekből** |
| 09-29-i „connectivity probe" gyermek | `deepseek-flash` (fizetős) |
| 2026-09-30-i, GUI-ból indított próbagyermek | `deepseek-flash` (fizetős), 1 kérés, $0.00006 |
| `subagent` tool-hívás az elmúlt 36 órában | **1** (09-29 12:44) — nincs automatikus delegáló |

**Az ok:** a web profilban a `tool-subagent` sor a **presetből** jön. A
`@deepseek-ai/dsh-web-app/cordis.patch.yml` a host-plane sorát letiltja:

```yaml
- id: tool-subagent
  disabled: true
```

és az agent a **standard preset** sorát kapja, amely viszont nem tartalmaz
`agentOptions`-t:

```yaml
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelectionSettings: true
        backgroundMode: continuable
```

`agentOptions` nélkül a gyermek a **szülő route-ját** örökli (a tool
dokumentációja szerint: „Providers without these defaults use compatible values
from the parent's latest logged request") — a GUI szülője pedig
`deepseek-official/deepseek-flash`. A `~/.dsh/profiles/web/cordis.patch.yml`
`tool-subagent` felülírása ezért **hatástalan**: egy letiltott sort patchel,
amit a preset sora felülír.

A korábbi „a preset-út nem működik" mérés félrevezető volt: az **headless**
futásban készült, ahol a preset-rendszer nincs mountolva (a `tool-subagent` a
`dsh-base`-ből jön), ezért ott valóban csak a profil-patch (`--patch`) számít.
A két profil két különböző mechanizmust használ.

**A javítás** (`providers\install-free-preset.mjs`):
- a `standard` preset másolata `standard-free` id-val a
  `<DSH_HOME>\.agent-presets` alá (a beépített gyökér nyeri a duplikált id-t,
  ezért felülírni nem lehet, csak másolni),
- a `tool-subagent` sor configjában `agentOptions:
  { provider: subagent-worker, model: worker, maxTokens: 32768 }`,
- `--default` esetén `agent-presets: default: standard-free` a
  `settings.yaml`-ba (mentéssel).

**Élő hatás:** a preset-roster hívásonként olvasódik
(`list() → discoverPresets`), az alapértelmezett pedig a hot-reloadolt
settings-ből (`defaultId`) — ezért **nem kell újraindítás** hozzá. A már futó
beszélgetések a saját presetjükön maradnak; az új beszélgetések indulnak a
`standard-free`-en.

**Ellenőrzés:** `node providers\check-delegation-route.mjs --hours 24` — megmondja,
melyik gyermek melyik úton futott. A várt eredmény egy új beszélgetésben:
`worker / subagent-worker` (ingyenes), nem `deepseek-flash`.

**Kockázat, amit tudni kell:** a `worker` route a helyi proxyra mutat, és a DSH
retry nem vált providert — ha a proxy áll, a gyermek hívása **elhal** (nem esik
vissza fizetősre). A watchdog 5 másodpercenként figyeli; a kiesés a
`providers\reports\proxy-watchdog.log`-ban látszik.
