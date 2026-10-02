# Alibaba Cloud (Qwen) bekötése a DSH-ba — előkészített terv

**Állapot:** felderítés kész, **API-kulcsra vár**. Nem telepítve, nem mérve.
**Dátum:** 2026-10-01
**Kapcsolódó:** `FELJEGYZES.md` (4. és 9. szakasz), `README.md`, `config.json`

> **FONTOS a forrásról:** az alábbi végpont-, modell- és áradatok a **gyártó
> saját dokumentációjából** származnak, nem élő mérésből. Ez a dokumentum
> szándékosan megkülönbözteti a *dokumentált* és a *mért* állítást. Ahol mérés
> történt, az jelölve van. Amint van kulcs, a 7. szakasz szerint kell mérni —
> addig egyetlen itteni állítás sem tekinthető igazoltnak ezen a gépen.

---

## 1. Miért merült fel egyáltalán

A jelenlegi ingyenes lánc (`worker`) mért gyenge pontjai:

- a Groq ingyenes kerete **8 000 token/perc**, ami alatt egy valódi
  subagent-kontextus (mért kérés: 9 395 token) `HTTP 413`-mal elhal;
- a lánc záró eleme, az `ollama/qwen2.5-coder:14b`, **35 s** alatt sem ad valódi
  `tool_calls`-t (a hívást content-szövegként írja ki) — mért eredmény;
- az ingyenes felhős célok `429`-cel időnként elesnek.

A Qwen ezzel szemben dokumentáltan **1M kontextus**, **2–5M TPM**,
**600–15 000 RPM**, és a `qwen3-coder-flash` kifejezetten *multi-turn tool
interaction / tool-calling stability* célra van hangolva. Új fióknak
**1M token ingyen modellenként**.

## 2. Végpontok

OpenAI-kompatibilis végpont, a `/chat/completions` nélkül értendő:

| Régió | Base URL |
|---|---|
| Szingapúr (új) | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Virginia (US) | `https://dashscope-us.aliyuncs.com/compatible-mode/v1` |
| Hongkong (Kína) | `https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1` |
| Tokió | `https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Peking (új) | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |

Régi, még élő domainek: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
(Szingapúr), `https://dashscope.aliyuncs.com/compatible-mode/v1` (Peking).
A QwenCloud dokumentációban ezen kívül ez is szerepel:
`https://maas.qwencloudapi.com/compatible-mode/v1`.

**A kulcs régióhoz kötött.** A kulcsot abban a régióban kell létrehozni,
amelynek a végpontját hívod. Más régió kulcsa **nem** `403`, hanem
`HTTP 401` + `invalid_api_key` + `Incorrect API key provided` — ez félrevezető,
mert azt sugallja, hogy a kulcs hibás, holott csak régiót tévesztettél.

`{WorkspaceId}` = a Model Studio konzol workspace ID-ja.

## 3. Modellek és árak (dokumentált, 2026-10-01)

| Modell | Input /1M | Output /1M | Implicit cache /1M | Kontextus | Max output | TPM | RPM |
|---|---|---|---|---|---|---|---|
| `qwen3-coder-flash` | $0.30 | $1.50 | $0.06 | 1M | 65K | 5M | 600 |
| `qwen3-coder-plus` | $1.00 | $5.00 | $0.20 | 1M | 65K | 2M | 2K |
| `qwen3.8-max` | $2.00 | $6.00 | $0.25 | 1M | 131K | 2M | 15K |

- **`qwen3-coder-plus`-t 2026-10-10-én kivezetik** — ne erre építs.
- A `qwen3.8-max` natívan fogad **kép + szöveg + videó** bemenetet, és
  „thinking" módban max 262K reasoning keretet ad.
- A Model Studio a Qwen mellett **harmadik féltől származó** modelleket is
  kiszolgál ugyanezen a végponton: DeepSeek, Kimi, GLM, MiniMax. Vagyis a
  DeepSeek elérhető Alibaba végponton keresztül is (ennek ára külön ellenőrzendő).

## 4. Ár-összehasonlítás a DeepSeekkel

A DeepSeek-oldali számok a **repó saját ártáblájából** valók
(`plugins/dsh-ui-extras/lib/index.js`, „Official DeepSeek list prices"),
USD / 1M token, csúcs / csúcsidőn kívül:

| Modell | Input (cache miss) | Input (cache találat) | Output |
|---|---|---|---|
| `deepseek-flash` | 0.30 / **0.15** | 0.006 / **0.003** | 1.20 / **0.60** |
| `deepseek-v4-pro` | 1.32 / **0.66** | 0.044 / **0.022** | 3.96 / **1.98** |

Összevetve:

- `deepseek-flash` csúcsidőn kívül **~2× olcsóbb inputon, ~2,5× outputon**, és
  **~20× olcsóbb cache-találaton**, mint a `qwen3-coder-flash`;
- `deepseek-v4-pro` csúcsidőn kívül **~3× olcsóbb**, mint a `qwen3.8-max`;
- csúcsidőben a `qwen3-coder-flash` inputja ($0.30) megegyezik a
  `deepseek-flash`-ével, outputban viszont így is drágább ($1.50 vs $1.20).

**Következtetés:** a DeepSeek minden összevethető szinten olcsóbb. A Qwen
értéke nem az ár, hanem a **kontextusméret, a rate limit és a tool-stabilitás**.

## 5. Bekötés a DSH-ba — konkrét lépések

Nincs natív Alibaba-plugin. A `@deepseek-ai/dsh-llm-pi-ai` útvonalon kell
kézzel deklarálni — pontosan úgy, ahogy a Groq/NVIDIA/Ollama már működik ebben
a telepítésben.

**5.1 Kulcs.** A `DASHSCOPE_API_KEY` a `~/.dsh/.credentials.yaml` `refs:`
szakaszába kerül (a Web GUI Settings → Models írja oda, vagy kézzel).

**5.2 Route a `~/.dsh/settings.yaml`-ban** (`llm-pi-ai:` szakasz alá, a meglévő
providerek mellé):

```yaml
llm-pi-ai:
  providers:
    alibaba:
      displayName: Alibaba Model Studio (Qwen)
      apiKeyEnv: DASHSCOPE_API_KEY
      api: openai-completions
      baseURL: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
      defaultContextWindow: 1000000
      defaultMaxTokens: 65536
      models:
        - id: qwen3-coder-flash
          name: Qwen3 Coder Flash
          contextWindow: 1000000
          maxTokens: 65536
        - id: qwen3.8-max
          name: Qwen3.8 Max
          contextWindow: 1000000
          maxTokens: 131072
```

- A provider-kulcsnak **kisbetűs, kötőjeles** azonosítónak kell lennie, ha a
  beépített bejelentkezést is használni akarod (`alibaba` megfelel).
- A `models` lista **lecseréli** az adott route katalógusát. Mivel itt nincs
  telepített katalógus, a `contextWindow`/`maxTokens` megadása kötelező jellegű:
  enélkül a route `defaultContextWindow` (262 144) és `defaultMaxTokens`
  (32 768) értékére esik vissza, ami a Qwen 1M-jéhez képest félrevezető.

**5.3 Reasoning.** A Qwen a DeepSeekkel **azonos alakot** használ:
`extra_body={"enable_thinking": true}` kérésnél, és `reasoning_content` a
streamelt delta mezőkben. A pi-ai ismeri a `qwen`, `qwen-chat-template` és
`deepseek` thinking-formátumokat is, tehát a `compat.thinkingFormat` értékkel
kell összekötni — melyik a helyes, **mérés kérdése** (lásd 7. szakasz).

**5.4 Opcionális: bevenni a fallback láncba.** Ha a `worker` lánc felhős tartalékát
bővíteni akarod, a `providers/config.json` `providers` szakaszába kell egy
`alibaba` bejegyzés (`baseURL`, `apiKeyEnv`), majd a `routes.worker.targets`
közé az `alibaba/qwen3-coder-flash`. **A config.json mentése után a proxyt újra
kell indítani** — lásd `FELJEGYZES.md` 4. szakasz.

## 6. Ismert akadályok — ezeket kell megoldani, mielőtt „ugyanolyan hatékony"

1. **Dokumentált `stream` + `tools` ütközés.** Az Alibaba OpenAI-kompatibilitási
   oldala azt írja: *„The tools parameter cannot be used with stream=True
   simultaneously."* A jelenlegi function-calling útmutató viszont streaming
   tool-hívást mutat, tehát a mondat valószínűleg elavult maradvány. **A DSH
   streamel**, ezért ez az első dolog, amit élőben igazolni kell. Ha igaz, a
   Qwen kiesik agent-loopra.
2. **Régióhoz kötött kulcs** (lásd 2. szakasz) — a végpontot a kulcs régiójához
   kell választani.
3. **Számviteli hiba a repó ártáblájában.** A
   `plugins/dsh-ui-extras/lib/index.js` `modelPrices()` függvénye
   (2071–2080. sor) **részstringre** illeszti a modell-id-t, és a táblában van
   egy **nulla árú `"qwen3.8"` kulcs** (2063. sor) az *ingyenes* OpenRouter-cél
   (`qwen3.8-27b:free`) miatt. Ezért:
   - `qwen3.8-max` (fizetős, $2/$6) → tartalmazza a `qwen3.8`-at → **ingyenesnek
     sorolódik**, az `isFreeModel()` igazat ad, és a delegált munka „ingyen
     megtakarításként" jelenik meg a statisztikában;
   - `qwen3-coder-flash` → nem illeszkedik semmire → a `deepseek-flash` árát
     kapja, ami inputon véletlenül egyezik ($0.30), outputon viszont alábecsül
     ($1.20 a valós $1.50 helyett).

   **Javítás (amikor kell):** a `"qwen3.8"` kulcsot `"qwen3.8-27b"`-re szűkíteni
   (ez továbbra is eltalálja az ingyenes `qwen3.8-27b:free`-et, de nem a
   `qwen3.8-max`-ot), és felvenni külön, fizetős sorokat a tényleges Qwen
   modelleknek. A beszúrási sorrend számít, mert a `modelPrices()` az **első**
   illeszkedést adja vissza.
4. **Nincs natív katalógus- és reasoning-integráció.** A DeepSeeknek külön
   adaptere van (`dsh-llm-deepseek`), a Qwen kézi route marad: a kontextus- és
   output-keretet neked kell megadni, a reasoning-formátum `compat` beállítás,
   és a DSH ár-/statisztika-modellje nem ismeri — lásd a 3. pontot.

## 7. Ellenőrzési terv, amint megvan a kulcs

Sorrendben, mert az 1. bukás esetén a többi értelmetlen:

1. **Kulcs és régió:** `GET {baseURL}/models` bearer tokennel. Ha `401
   invalid_api_key`, a kulcs másik régióhoz tartozik — ne a kulcsot kezdd
   cserélni, hanem a végpontot igazítsd.
2. **`stream` + `tools` együtt** — ez a döntő próba. Kézzel, a határ közvetlen
   megkeresésével (nem a DSH-n át), hogy a hiba egyértelmű legyen.
3. **Tool-hívás nem-stream módban**, majd **több körös** tool-lánc (a
   `qwen3-coder-flash` állítólag ezt optimalizálja).
4. **Nagy kontextus** (~40–80K token) — a Groq 8K-s fala miatt ez a valódi
   próba, nem a 400 tokenes.
5. **Reasoning:** `enable_thinking`, és hogy a `reasoning_content` megjelenik-e a
   streamben; ez dönti el a `compat.thinkingFormat` helyes értékét.
6. **Ár:** egy ismert méretű kérés tényleges számlázott tokenjei, összevetve a
   3. szakasz áraival.
7. **Csak ezután** a DSH-integráció: route felvétele, egy delegálás futtatása a
   `subagent-worker` mintájára, és az ártábla javítása (6.3. pont).

## 8. Nyitott kérdések

- A `dashscope-intl` és az új workspace-domain ugyanazt a kulcsot fogadja-e.
- Az ingyenes 1M token/modell pontosan mely modellekre és meddig érvényes.
- A DeepSeek Alibaba-végponton mért ára hogyan viszonyul a közvetlen
  DeepSeek-árhoz (ha olcsóbb, az külön lehetőség).
- A `qwen3-coder-plus` 2026-10-10-i kivezetése után mi a hivatalos utód.
