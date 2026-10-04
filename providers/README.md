# Provider-bővítés a DeepSeek Harness-hez

Ez a mappa a DSH több-provideres beállítását tartalmazza: helyi Ollama, ingyenes
felhős providerek, és egy automatikus fallback proxy.

**Kiindulás:** DSH `0.1.5-rc.3`, a `dsh-llm-pi-ai` adapter már mountolva van a
`dsh-base`-ben, csak **dormant** (nulla route), amíg a `~/.dsh/settings.yaml`-ban
nincs `llm-pi-ai:` szekció. Újraindítás nem kell: a konfig a következő kérésre
életbe lép.

> **Teljes feljegyzés:** [`FELJEGYZES.md`](FELJEGYZES.md) — a kiindulás, a mért
> eredmények, a fallback proxy tervezése, a havi újrahangolás és a
> subagent-javaslat egy dokumentumban.

> **Ütemezés:** `DSH model retune daily` naponta 09:00 (2026-09-27 … 10-04),
> utána automatikusan `DSH model retune weekly` hétfőnként 09:00. Mindkettő
> `apply` módban fut. Átállítás kézzel: `.\schedule-retune.ps1 -Cadence Daily|Weekly`.

> **Napi behangolás:** a `chain-doctor.mjs` minden célra tool-hívást igénylő
> próbát küld, és a halott/lassú célokat a lánc végére sorolja. Ez fut a napi
> feladatban is. Kézzel: `node chain-doctor.mjs [--apply]`.

> **Subagent:** beállítva és élesben igazolva. A delegált munka a
> `subagent-worker` route-on megy (ingyenes lánc), a fő szál fizetős marad.
> A gyermek `write`/`edit` eszközeit a `toolFilter` tiltja.

> **⚠️ A proxy életben tartása (2026-09-29):** a proxy 2026-09-27-én minden
> hibaüzenet nélkül elhalt, és nem indult újra — onnantól a delegálás „behalt".
> A javítás **önjavító watchdog**, amit egyszer telepíteni kell egy szokásos
> PowerShell-ablakból (a DSH sandboxából nem lehet tartós folyamatot indítani):
>
> ```powershell
> cd "C:\Szerver\Deepseek Harness\providers"
> .\install-subagent-proxy.ps1
> ```
>
> Ellenőrzés bármikor: `node verify-subagent-chain.mjs`

> **A „Csoportosítatlan" a bal sávon:** a delegált gyermek-session-ök nincsenek
> a munkaterület-nyilvántartásban, ezért gazdátlanként jelennek meg. Javítás
> (riport először, majd írás + DSH-újraindítás):
>
> ```powershell
> node classify-subagent-sessions.mjs
> node classify-subagent-sessions.mjs --apply --adopt-parents
> ```

---

## A három lehetőség

| # | Módszer | Mire jó | Kell hozzá |
|---|---|---|---|
| 1 | **Natív `llm-pi-ai` provider** | Helyi Ollama, ingyenes felhős kertek, egyedi gateway-ek | Semmi — csak YAML vagy a GUI |
| 2 | **Fallback proxy** (`proxy.mjs`) | Automatikus átállás provider-hiba esetén, 0.1.5-ön is | Node ≥ 18 |
| 3 | **Közösségi plugin** | Auto tier-routing, gazdag fallback-lánc, cooldown | DSH **0.1.7**-re frissítés |

Az 1. és a 2. út **egymás mellett** működik: a providereket közvetlenül is
használhatod, a proxyt pedig a kritikus lánchoz.

### Miért nem plugin (egyelőre)?

A `dsh-llm-fallbacks`, `dsh-autotier` és `dsh-model-router` mind a 0.1.6/0.1.7
generációt célozza. A 0.1.6-ban a `@deepseek-ai/dsh-settings-file` és a
`ctx.settings.register` seam **megszűnt** (helyette `SettingsForms`), ezért ezek a
pluginek a 0.1.5-ös vonalat kifejezetten nem támogatják. Ha egyszer 0.1.7-re
frissítesz, ezek megnyílnak — addig a proxy adja ugyanazt a funkciót.

---

## 1. lépés — providerek bekötése

Másold a `settings.llm-pi-ai.yaml` tartalmát a `~/.dsh/settings.yaml` fájlba, a
meglévő kulcsok **mellé** (ugyanarra a szintre). A fájl jelenlegi tartalma ehhez
hasonló:

```yaml
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
ui-theme:
  preference: dark
ui-conversation:
  busyEnter: steer
locale:
  preference: hu
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: high
# ... ide jön az llm-pi-ai: blokk ...
```

**Kulcsok.** Két mód, a `settings.yaml` soha nem tartalmaz titkot:

- **Web GUI (ajánlott):** Settings → Models → a provider sorában az *API key*
  mezőbe gépeled. A kulcs write-only módon a `~/.dsh/.credentials.yaml`-ba kerül.
- **Környezeti változó:** állítsd be a harness folyamata számára
  (`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`), az `apiKeyEnv`
  pedig erre a névre hivatkozik.

Az Ollama helyi szerver is **kér** egy kulcsot az OpenAI-kompatibilis úton, ezért
kell a placeholder (`OLLAMA_LOCAL_API_KEY` = `ollama`). Ez a leggyakoribb hiba
oka: kulcs nélkül `MISSING_CREDENTIAL` / 401 lesz a válasz.

Ellenőrzés:

```powershell
# Ollama OpenAI-kompatibilis végpont él?
curl.exe -s http://127.0.0.1:11434/v1/models
```

---

## 2. lépés — fallback proxy (opcionális, de ez adja az automatikus átállást)

### Mit tud

- **Egy** OpenAI-kompatibilis végpont a DSH-nak, mögötte **lánc**.
- Ha egy provider 429 / 401 / 5xx / hálózati hibát ad **az első token előtt**,
  megy a következőre. A beszélgetés nem szakad meg.
- **Streaming** (SSE) és **tool-calling** teljes átvezetéssel — a DSH agent-loop
  változatlanul működik.
- `GET /v1/models` → a DSH *Fetch available models* gombja a virtuális
  route-neveket látja.
- `GET /healthz` → látszik, melyik providernek van kulcsa, mi a tényleges lánc.
- Hiányzó kulcsú providert **kihagy**, nem hal el tőle.

### Indítás

```powershell
cd "C:\Szerver\Deepseek Harness\providers"

# előtérben (Ctrl+C = leállítás)
.\start-fallback-proxy.ps1

# háttérben, PID fájllal
.\start-fallback-proxy.ps1 -Background
.\start-fallback-proxy.ps1 -Stop

# más port
.\start-fallback-proxy.ps1 -Port 4124
```

A proxy alapértelmezésben a `127.0.0.1:4123` címen figyel. A `config.json`
`providers` szekciója adja a végpontokat, a `routes` szekció a láncokat —
a route-nevek jelennek meg modellként a DSH-ban:

| Route | Lánc |
|---|---|
| `deepseek-chat` | Groq → Cerebras → OpenRouter → Ollama |
| `fast-chat` | Groq (8B instant) → Cerebras → Ollama (7B instruct) |
| `local-only` | csak helyi Ollama (adat nem hagyja el a gépet) |

A célokat `provider/model` formában kell megadni, és a feloldás **csak az első
perjelen** hasít — így a perjelet és kettőspontot tartalmazó id-k is helyesek
(`openrouter/deepseek/deepseek-chat-v3.1:free`,
`ollama/qwen2.5:7b-instruct`). A `baseURL`-t `/v1`-gyel vagy anélkül is
megadhatod, a proxy nem duplázza a szegmenst.

### Időzítés — két külön korlát

Ez a proxy legfontosabb tervezési döntése:

- **`connectTimeoutMs`** (alap 120 s, Ollamánál 300 s): mennyi ideig várunk a
  válasz *fejlécére*. Ez dönti el a fallbacket. Azért ilyen hosszú, mert egy
  helyi modell **cold startja** könnyen 15–70 s (mért érték: `gpt-oss:20b`
  hidegen 69 s, melegen 9 s). Túl rövid érték esetén a lánc feleslegesen
  továbblép egy munkanélküli providerre.
- **`stallTimeoutMs`** (alap 180 s): stream közben mennyi csend után adjuk fel a
  beragadt generációt. Ez **nem** a teljes generálási idő.

### Tesztelés

```powershell
# állapot és a tényleges lánc
curl.exe -s http://127.0.0.1:4123/healthz

# elérhető virtuális modellek
curl.exe -s http://127.0.0.1:4123/v1/models

# mit hívj (nem-stream)
curl.exe -s -X POST http://127.0.0.1:4123/v1/chat/completions `
  -H "content-type: application/json" `
  -d '{\"model\":\"fast-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}]}'
```

A `config.test.json` egy szándékosan hibás láncot ír le (halott végpont → hibás
kulcs → valódi Ollama), amivel a fallback éles körülmények között
ellenőrizhető:

```powershell
$env:OLLAMA_LOCAL_API_KEY='ollama'
node proxy.mjs --config config.test.json
```

### Alternatíva: LiteLLM

Ha a proxy helyett kész megoldást szeretnél, a `requirements-litellm.txt` és a
`litellm-config.yaml` megadja ugyanezt LiteLLM-mel. **Fontos:** a pip telepítés
a felhasználói `Temp` mappába ír, amit a DSH sandbox `workspace-write` módban
letilt — ezért **venv-be** telepítsd a munkaterületen belül:

```powershell
cd "C:\Szerver\Deepseek Harness\providers"
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-litellm.txt
$env:GROQ_API_KEY='...'; $env:CEREBRAS_API_KEY='...'
.\.venv\Scripts\python.exe -m litellm --config litellm-config.yaml --port 4123
```

A LiteLLM többet tud (spend tracking, virtual keys, admin UI, auto-router),
cserébe nagyobb függőség és a Python-verzióhoz kötött. A `proxy.mjs` kisebb,
átláthatóbb, és pontosan azt tudja, amire itt szükség van.

---

## 3. lépés — ingyenes modellek bevonása egyszerű feladatokra

Ez a rész **nem igényel proxyt**, csak a providereket:

- **Subagent-modell szabály** — Settings → Plugins: a `subagent-model-selection`
  engedélyezésével megadod, mely providerekre delegálhat a subagent. Így a fő
  orchestrátor marad a DeepSeek-en, a `subagent`/`workflow` fan-out megy
  ingyenes modellre.
- **Session-szintű váltás** — a `/model` választóval session-enként válthatsz.
  A meglévő sessionök megőrzik az induló modelljüket, tehát nem íródik át a
  história.
- **Olcsó sávok** — a compaction és a session-cím-generálás külön host-seam;
  ezek futnak a legtöbbet és igénylik a legkevesebb intelligenciát, ezért érdemes
  ingyenes modellre állítani őket.
- **Reasoning effort** — a Models oldal szándékosan nem ad provider-szintű
  szabályzót, mert az modell-képesség: egy nem támogatott szint
  `UNSUPPORTED_REASONING_EFFORT` hibát ad. A katalógusból ismert modellek
  esetén ez automatikus.

### Javasolt felosztás

| Feladat | Modell |
|---|---|
| Orchestráció, tervezés, nehéz döntések | `deepseek-official` (marad) |
| Subagent fan-out, keresés, összegzés | `groq` / `cerebras` (ingyenes) |
| Compaction, cím-generálás | `groq` legkisebb modellje vagy `ollama-local` |
| Bizalmas kód (nem hagyhatja el a gépet) | `ollama-local` |
| Látás (kép) | `qwen3-vl:8b` vagy `minicpm-v:latest` (helyi) |

---

## Ellenőrző szkriptek

A konfiguráció papíron jól nézhet ki, miközben a felvett modell-id-k már nem
léteznek a providernél. Ezek a szkriptek ezt szűrik ki:

```powershell
cd "C:\Szerver\Deepseek Harness\providers"

# Minden llm-pi-ai provider: él-e a kulcs, és léteznek-e a felvett modell-id-k?
node check-providers.mjs
node check-providers.mjs --verbose     # a provider teljes modell-listája

# Melyik helyi Ollama modell tud tool-callingot? (ez dönti el, melyik
# használható agent-loopban egyáltalán)
node check-ollama.mjs

# Google: a /v1/models listában szereplő modellek közül melyik HÍVHATÓ
# ténylegesen, és melyik tud toolt?
node check-google.mjs
```

A `check-providers.mjs` a `~/.dsh/.credentials.yaml`-ból olvassa a kulcsokat, és
a providerek **élő** `/v1/models` végpontját kérdezi le. A kulcsokat soha nem
írja ki (csak maszkolva). A `check-ollama.mjs` az Ollama `/api/show`
`capabilities` mezőjét nézi: ha nincs benne `tools`, a modell agent-loopban
nem fog eszközt hívni.

### Mért eredmény (2026-09-27)

Ezen a napon a felvett 88 modellből **15 nem volt használható**: 10 nem létezett
a providernél, további 5 pedig létezett ugyan a listában, de a hívás 404-gyel
vagy 400-zal elhasalt (lásd a Google szakaszt).

| Provider | Nem létezett / nem hívható | Helyette |
|---|---|---|
| groq | `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `qwen/qwen3.6-27b` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` |
| openrouter | `minimax/minimax-m2.7:free`, `minimax/minimax-m3:free`, `z-ai/glm-5.2:free` | `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free` |
| nvidia | `deepseek-ai/deepseek-v4-flash-0731`, `deepseek-ai/deepseek-v4-pro-0813`, `minimaxai/minimax-m3` | `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k3` |
| google | `gemini-3.1-flash-live-preview`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`, `deep-research-*-preview-04-2026` | `gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-flash-latest` |

**A javítás megtörtént** a `~/.dsh/settings.yaml`-ban (mentés:
`settings.yaml.bak-20260927-143052`). Az ellenőrzés utána:

```
Minden rendben: 5 provider ellenőrizve, hibás modell-id nincs.
```

**A tanulság:** a pi-ai katalógus beépített modell-listája és a provider élő
listája rendszeresen eltér — és a lista létezése még nem jelenti, hogy a modell
hívható. Ezért a GUI *Fetch available models* gombját kell használni, majd a
`check-providers.mjs`-sel ellenőrizni.

### Google: két út, és csak az egyik jó

A Google-nek **két** hívási útja van, és ez dönti el, hogy a tool-calling
működik-e:

| Út | Protokoll | Tool-calling | Ezt használja |
|---|---|---|---|
| **Natív** `/v1beta/models/<m>:generateContent` | `google-generative-ai` | ✅ `get_weather({"city":"Budapest"})` | **a DSH katalógus-route-ja** |
| OpenAI-kompatibilitási `/v1beta/openai` | `openai-completions` | ❌ toolt nem hív, üres content | csak a proxy tudná |

Mért eredmény ugyanazokkal a modellekkel:

- **Natív út:** `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-flash-latest`
  → mind helyesen adja vissza a `functionCall`-t.
- **OpenAI-kompatibilitási réteg:** a reasoning modellek (`gemini-3.8-flash`)
  **üres `content`-et** adnak, a Gemma modellek pedig **nyers `<thought>`
  blokkot szivárogtatnak a `content`-be**. A tool-hívás egyiknél sem jött létre.

**Következmény:** a Google-t a DSH-nak a **natív katalógus-route-ján** kell
használnia (ez az alapértelmezett viselkedés, nem kell beállítani), és **nem**
szabad a fallback proxyba bekötni. A `config.json`-ban ezért nincs Google
provider — a proxy kizárólag OpenAI-kompatibilis végpontokon át dolgozik.

### Google: a lista létezése nem jelenti, hogy hívható

A `/v1/models` 50 modellt ad vissza a kulcsoddal, de ebből **csak 11 hívható
ténylegesen**. A `check-google.mjs` ezt méri. A felvett 21-ből 5 volt használhatatlan:

| Modell | Hiba |
|---|---|
| `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro` | **404 — „no longer available to new users"** |
| `deep-research-max-preview-04-2026`, `deep-research-preview-04-2026` | 400 — „This model only supports Interactions API" |

Ezeket eltávolítottuk. Emellett kvóta (429) vagy túlterheltség (503) miatt
átmenetileg nem válaszolt: `gemini-3.1-pro-preview`,
`gemini-3.1-pro-preview-customtools`, `gemini-3.1-flash-lite-image`,
`gemini-2.5-computer-use-preview-10-2025`, `gemini-3.5-flash` — ezek a listán
maradtak, mert a hiba nem végleges.

Ezek a Google-modellek bizonyítottan **hívhatók**:

```
gemini-3-flash-preview        gemini-3.1-flash-lite      gemini-3.1-flash-lite-preview
gemini-3.5-flash-lite         gemini-3.6-flash           gemini-3.7-flash
gemini-3.8-flash              gemini-flash-latest        gemini-flash-lite-latest
gemma-4-26b-a4b-it            gemma-4-31b-it
```

### Google-kulcs — fontos megkülönböztetés

A Google-kulcs **API-kulcs**, nem OAuth token. Mért eredmény ugyanazzal a
kulccsal:

| Hitelesítés | Eredmény |
|---|---|
| `?key=<kulcs>` query paraméter | ✅ HTTP 200 |
| `x-goog-api-key: <kulcs>` fejléc | ✅ HTTP 200 |
| `Authorization: Bearer <kulcs>` | ❌ HTTP 401 |

A pi-ai a hivatalos Google SDK-t használja, ami az `x-goog-api-key` fejlécet
küldi — tehát ez a helyes út. Ha valaha 401-et kapsz a Google-től, az szinte
biztosan nem ez a hiba, hanem lejárt vagy visszavont kulcs.

### Helyi modellek és tool-calling

Mért adat: a 18 helyi modelledből **11 tud tool-callingot**. Agent-loopban csak
ezek használhatók.

| Modell | tool | lát | gondolkodik | GB |
|---|---|---|---|---|
| `gpt-oss:20b` | ✅ | — | ✅ | 12,8 |
| `qwen2.5-coder:14b` | ✅ | — | — | 8,4 |
| `qwen2.5:14b` | ✅ | — | — | 8,4 |
| `deepseek-r1:14b` | ✅ | — | ✅ | 8,4 |
| `mistral-nemo:latest` | ✅ | — | — | 6,6 |
| **`qwen3-vl:8b`** | ✅ | ✅ | ✅ | 5,7 |
| `llama3.1:8b` | ✅ | — | — | 4,6 |
| `qwen2.5:7b-instruct` | ✅ | — | — | 4,4 |
| `glm-ocr:latest` | ✅ | ✅ | — | 2,1 |
| `minicpm-v:latest` | ❌ | ✅ | — | 5,1 |
| `llava:13b` | ❌ | ✅ | — | 7,5 |
| `deepseek-coder-v2:16b` | ❌ | — | — | 8,3 |
| `gemma2:9b` | ❌ | — | — | 5,1 |
| `moondream:latest` | ❌ | ✅ | — | 1,6 |
| `qwen2.5-coder:1.5b-base` | ❌ | — | — | 0,9 |
| `nomic-embed-text:latest` | ❌ | — | — | 0,3 |

Két csapda, amit érdemes észben tartani:

- A **`llava:13b` és `minicpm-v` lát, de nem tud toolt** — agent-loopban
  használhatatlanok, hiába vízió modellek.
- A **`qwen3-vl:8b` az egyetlen helyi modelled, ami lát *és* tud toolt is.**
  Ezért ez az egyetlen helyi jelölt képes feladatra.

---

## Ismert buktatók

1. **Az Ollama is kér kulcsot** az OpenAI-kompatibilis úton → placeholder kell.
2. **A `*-base` Ollama modellek nyers nyelvi modellek**, nem instruct-ok. Agent
   loopban használhatatlanok (mért példa: `qwen2.5-coder:1.5b-base`
   „I have no idea what this means!" választ adott egy triviális kérésre).
   Csak instruct változatot használj.
3. **A reasoning modellek elnyelik a token-keretet.** A `gpt-oss:20b` 24 tokenes
   `max_tokens`-szel üres `content`-et adott, mert a gondolatmenetére futott ki.
   Adj legalább 16384-et, vagy használj nem-reasoning modellt egyszerű munkára.
4. **A modell id pontosan az Ollama tag** legyen (`ollama list`), pl.
   `qwen2.5:7b-instruct`, `gpt-oss:20b`.
5. **Vízió explicit kell**: `input: [text, image]` a modell bejegyzésnél,
   különben a csatolt kép nem megy át.
6. **A kis helyi modellek gyakrabban ejtik el a tool-hívást.** A proxy ugyan
   átvezeti a `tool_calls` deltákat (ellenőrizve), de a modell döntése a szűk
   keresztmetszet.
7. **Az ingyenes kertek változnak.** A `settings.llm-pi-ai.yaml`-ban lévő
   modell-id-k kiindulópontok; kötelező érvényű lista mindig a provider
   `/v1/models` végpontja.
8. **A proxy egy provider a DSH szemében** → a DSH nem a valódi upstream
   metaadatokat látja, hanem a `config.json`-ban megadott
   `contextWindow` / `maxTokens` értékeket. Ezeket tartsd karban.
9. **Stream közben nem lehet visszatekerni.** Ha a hiba az első token *után*
   jön, a proxy jelzi a hibát a stream-ben, de nem tud másik providerre váltani.
   Ez ugyanaz a korlát, amit a `dsh-llm-fallbacks` is dokumentál.
10. **A `dsh` nincs a PATH-on.** A CLI-t a tray „dsh elérési út…" beállításából
    vagy a `bin\` könyvtárból kell hívni (pl. `dsh plugin --profile web add …`).

---

## Fájlok

| Fájl | Szerep |
|---|---|
| `settings.llm-pi-ai.yaml` | A `~/.dsh/settings.yaml`-ba másolandó provider-blokk (ellenőrzött id-kkel) |
| `check-providers.mjs` | Minden provider: él-e a kulcs, léteznek-e a felvett modell-id-k |
| `check-ollama.mjs` | Melyik helyi modell tud tool-callingot |
| `check-google.mjs` | Google: melyik modell hívható, és melyik tud toolt |
| `proxy.mjs` | A fallback proxy (nulla függőség, Node ≥ 18) |
| `config.json` | A proxy éles konfigurációja (providerek + route-ok) |
| `config.test.json` | Szándékosan hibás lánc a fallback teszteléséhez |
| `start-fallback-proxy.ps1` | Indító/leállító szkript |
| `litellm-config.yaml` | LiteLLM alternatíva a proxynak |
| `requirements-litellm.txt` | LiteLLM függőség (venv-be) |
| `run-headless-task.ps1` | Automatizált (headless) futás a saját csatornájában (`.automation`) |
| `session-channel.mjs` | A gépi futások session-jeinek riportja, elrejtése/visszahozása, a csatorna regisztrálása |
| `setup-automation-channel.ps1` | Egy paranccsal: a host fél ellenőrzése + csatorna regisztrálása + a meglévő gépi session-ök elrejtése |
| `install-free-preset.mjs` | `standard-free` preset: a GUI-ból indított gyermekek az ingyenes láncon (`agentOptions`) |
| `check-delegation-route.mjs` | Melyik gyermek melyik úton futott (ingyenes/fizetős), és mennyibe került |
| `ALIBABA-QWEN-TERV.md` | **Előkészített terv** az Alibaba Cloud / Qwen bekötésére (API-kulcsra vár): végpontok, árak, DSH-YAML, ismert akadályok, mérési terv |

A `~/.dsh` könyvtárban készült mentések a javítás előtti állapotról:
`settings.yaml.bak-20260927-143052` és `.credentials.yaml.bak-20260927-143052`.
Visszaállítás: másold vissza a `.bak-…` fájlt az eredeti névre.

---

## Automatizált futások csatornája

A headless futás **mindig** hagy maga után egy sessiont a munkakönyvtárában, és
a DSH induláskor minden ilyen könyvtárat külön munkaterületként csoportosít. Ha
a futás a projekt könyvtárából indul, a session a projekt sávjába kerül — a
2026-09-27-i delegálás-tesztek 9 sessionje így került a „Deepseek Harness"
listájára.

```powershell
# a csatorna (alap: <repo>\.automation) + a meglévő gépi session-ök elrejtése
node providers\session-channel.mjs                     # riport, nem ír
node providers\session-channel.mjs --channel --hide    # regisztrál + elrejt
.\providers\setup-automation-channel.ps1               # ugyanez egy paranccsal

# automatizált feladat indítása a csatornából
.\providers\run-headless-task.ps1 "Report the current date using the pwsh tool."
```

- Az elrejtés **archiválás**: a session eltűnik a sávból és a keresésből, a
  naplója viszont a helyén marad, ezért a 30 napos statisztika továbbra is
  számol vele. Visszahozás: `--unhide --ids <id,...>`.
- Az archiválás a **futó** host registry-én keresztül történik
  (`POST /ui-extras/workspace-session`), mert a `storages/workspace.json`-t a
  DSH csak induláskor olvassa; a kézi fájlszerkesztést a host felülírná.
- A `run-headless-task.ps1` a futás előtt regisztrálja a csatornát
  munkaterületként (ha a harness fut), így a gépi session-ök külön csoportba
  kerülnek. `-ReportDirectory` esetén a kimenet fájlba (`automation-*.md`) is
  kerül; `-Patch` egy vagy több további patch-réteget ad át a DSH-nak (a
  headless profil ingyenes láncához: `test-subagent-worker.patch.yml`).

---

## Ingyenes delegálás a GUI-ból (standard-free preset)

A web profilban a `tool-subagent` sor a **presetből** jön (a host-plane sorát a
`dsh-web-app` letiltja), ezért a `~/.dsh/profiles/web/cordis.patch.yml`
`tool-subagent` felülírása hatástalan: a standard preset sorában nincs
`agentOptions`, így a gyermek a **szülő route-ját** örökli — a GUI-ból indított
delegálás mindig fizetős `deepseek-flash`. (Mérve: 2026-09-30-án egy GUI-ból
indított próbagyermek `deepseek-flash`-en futott; az összes ingyenes kérés a
09-27-i headless tesztekből származik.)

```powershell
# riport (nem ír), majd telepítés + alapértelmezetté tétel
node providers\install-free-preset.mjs
node providers\install-free-preset.mjs --apply --default

# ellenőrzés: melyik gyermek melyik úton futott
node providers\check-delegation-route.mjs --hours 24

# a settings.yaml visszaállítása, ha kell
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-<időbélyeg>" `
          "$env:USERPROFILE\.dsh\settings.yaml" -Force
```

- A szkript a `standard` presetet másolja `standard-free` id-val a
  `<DSH_HOME>\.agent-presets` alá (a beépített gyökér nyeri a duplikált id-t,
  ezért felülírni nem lehet, csak másolni), és **két** dolgot ír bele
  (mindkettő ellenőrzötten; `--verbose` kiírja a patchelt blokkokat):
  1. a `tool-subagent` sorba
     `agentOptions: { provider: subagent-worker, model: worker, maxTokens: 32768 }`
     — ez a gyermek **route**-ja;
  2. a `persona` sor `suffix`-ébe a **delegálási irányelvet** — ez mondja meg a
     fő modellnek, hogy a szeparálható munkát adja le a gyermeknek, és a
     döntés/fájlmódosítás/felhasználónak szóló válasz maradjon a fő szálon.
- **A route önmagában nem delegál.** Mért eset (2026-10-03/04.): a felület
  egész napos használata ~1,8k fizetős kérést termelt, de **egyetlen** ingyenes
  kérést sem, mert a `subagent` toolt senki nem hívta — a statisztika ilyenkor
  helyesen áll, mégis „befagyottnak" látszik. Az irányelv ezt hivatott
  megfordítani; a részletes mérés és a bizonyíték: `FELJEGYZES.md` 12. pont.
- A delegálási irányelv a **persona-sáv** része, ezért csak a telepítés után
  indított beszélgetésekben érvényes (a futó beszélgetések a saját
  promptjukon/presetjükön maradnak).
- **Nem kell újraindítás:** a preset-roster hívásonként olvasódik, az
  alapértelmezett a hot-reloadolt settings-ből jön. Az **új** beszélgetések
  indulnak a `standard-free`-en.
- **Kockázat:** a `worker` route a helyi proxyra mutat, és a DSH-retry nem vált
  providert — ha a proxy áll, a gyermek hívása elhal (nem esik vissza fizetősre).
  A watchdog figyeli (`reports\proxy-watchdog.log`); ellenőrzés:
  `node providers\verify-subagent-chain.mjs`.
- **Visszaállítás:** a telepítő nem menti a preset-mappát, ezért csere előtt
  készíts mentést (`Copy-Item -Recurse` a `.agent-presets\standard-free`-ról);
  a `persona`-patch a `DELEGALAS-IRANYELV` jelölőnél keresve távolítható el.
