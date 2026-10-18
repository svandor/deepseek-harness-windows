# Alterego avatars — plan and idea list

> Hungarian version: [`ALTEREGO-TERV.md`](ALTEREGO-TERV.md).

**Status:** **IMPLEMENTED** (2026-10-01) — 14 alteregos, a clickable selector, automatic
rotation, one shared persisted state.

Until now the Házirobot had **one** avatar (`bot/avatar/hazirobot.svg`, the white robot). From
now on it has **alteregos**: clicking the image in the panel header (or switching to the **Alteregos**
tab of the DSH panel) selects any of them, and **automatic rotation** can be configured too.

---

## 1. What was built

| Where | What it does |
|---|---|
| **Robot panel** (`http://127.0.0.1:4180/`) | 🎭 **Alterego switch** button in the header → a clickable image grid; next to it the automatic rotation selector |
| **DSH panel** (🤖 button) | clicking the header avatar (or on the **Alteregos** tab) gives the same grid and auto selector |
| **State** | the choice goes into the `avatarAlterego` block of `bot/config.json` — both panels show the same one, and it survives a restart |
| **API** | `GET /alteregok` (list + active + auto), `POST /alterego` (`{aktiv}` / `{auto}`), `GET /avatar.svg?alterego=<id>` |
| **DSH host** | the same three routes under `/hazi-robot/alteregok`, `/hazi-robot/alterego`, `/hazi-robot/avatar.svg?alterego=` |
| **Test** | `node --test --test-isolation=none bot/tests/alterego.test.mjs` — 12 tests: viewBox, shared animation block, collision-free keyframe names, forbidden elements, id uniqueness, path traversal |

The choice is **not client-side**: it lives in `config.json`, so the robot panel, the DSH panel and
future surfaces all show the same alterego.

## 2. The 14 alteregos

`bot/avatar/alteregok/attekintes.png` is a snapshot of the whole set.

| # | id | Name | Inspiration | Motion |
|---|---|---|---|---|
| 1 | `gyuszi` | **Gyuszi (the real one)** | *Magyarok az űrben* + the requested bin-man version | sways + waves |
| 2 | `klasszikus` | Classic | the old avatar (Magyarok az űrben 6:10–6:40) | floats + waves + blinks |
| 3 | `ezeros` | Silver machine-man | the dancer robot from the **Clouds Across the Moon** (The Rah Band) video | dances |
| 4 | `gonk` | Gonk | Star Wars — GNK power droid | sways |
| 5 | `asztromech` | Astromech | Star Wars — R2-D2 | head turn |
| 6 | `protokoll` | Protocol droid | Star Wars — C-3PO | nods |
| 7 | `kukagyerek` | Bin kid | WALL-E | shuffles |
| 8 | `tojas` | Egg | WALL-E — EVE | floats |
| 9 | `gomb` | Ball | Star Wars — BB-8 | rolls |
| 10 | `bender` | Bender | Futurama | bounces |
| 11 | `marvin` | Gloomy | The Hitchhiker's Guide to the Galaxy — Marvin | floats |
| 12 | `szem` | Eye | 2001: A Space Odyssey — HAL 9000 | blinks |
| 13 | `clippy` | Paperclip | Microsoft Office — the Clippy meme | bounces |
| 14 | `spot` | Robot dog | Boston Dynamics — Spot | sways |

### The Gyuszi (the real one)

As requested: **a plastic paper basket for a head** (translucent, lattice, with hooked ears),
**a tin bin for a body** (corrugated ribs, a dented lid, metal ears), **a long kitchen extractor
flexible hose for arms** (white plastic, ringed by the steel reinforcement, tweezers at the end).
The motion: a staggering sway, the hose arms swing out like rubber and fall back, the lid rattles,
the eyes sunk into the basket blink.

This is the **default** alterego (`alteregok.json` → `"alap": "gyuszi"`).

### The shared motion language

Every SVG contains the same two animation blocks **character for character** (`.lebeg` +
`@keyframes lebeg`, `.szem` + `@keyframes pislog`), so every alterego breathes and blinks the same
way. The alterego's **own** animations all get a prefix (`gy-`, `ez-`, `gonk-`, …), otherwise the
CSS of the images loaded at once in the selector would override each other. The test enforces this.

## 3. Automatic rotation

The header selector: **off · 10 s · 30 s · 1 min · 5 min**. When enabled, the panel rotates through
the catalogue order every `auto` seconds. The automatic rotation does **not** write to the server on
every switch (only the setting goes into `config.json`), so it does not load the disk; a manually
picked alterego is saved immediately.

## 4. Adding a new alterego (2 steps)

1. Create `bot/avatar/alteregok/<id>.svg` according to the contract in
   [`BRIEF.md`](../bot/avatar/alteregok/BRIEF.md) (fixed `viewBox="0 0 240 320"`, the shared
   `.lebeg`/`.szem` block, prefixed own animations, no script/external reference/SMIL).
2. Add it to the `lista` array of `bot/avatar/alteregok.json`
   (`id`, `nev`, `alcim`, `fajl`, `mozgas`, `ihlet`, `szin`).

Then run the test, and it already appears on the panel:

```powershell
node --test --test-isolation=none bot/tests/alterego.test.mjs
```

---

## 5. Further ideas (not included yet)

Any of these can be added with 1 SVG and 1 catalogue line. The selection criteria:
a **recognisable silhouette** and **motion that works inside the 240×320 frame**.

### 5.1 Film and series robots

| Idea | Why it is good | Motion idea |
|---|---|---|
| **Maschinenmensch** (Metropolis, 1927) | the **first** film robot — a historical item | rigid, measured turn |
| **RoboCop** (OCP-01) | helmet + red visor, instantly recognisable | targeting head turn, heavy step |
| **T-800 endoskeleton** (The Terminator) | the "red eye in the dark" icon | slow, unstoppable walk |
| **Gort** (The Day the Earth Stood Still) | smooth silver giant, shutter-like visor | completely still, only the visor opens |
| **Johnny 5** (Short Circuit) | cassette head, eyebrows, curious | head turn + eyebrow raise |
| **Baymax** (Big Hero 6) | inflated white body, dot eyes | slow, soft sideways lean |
| **The Iron Giant** | iron giant, kind | heavy nod |
| **TARS** (Interstellar) | rectangular block, military | rectangular block rotation, dry humour |
| **M-O** (WALL-E) | obsessive cleaner | nervous sidestep, cleaning roller |
| **Rosie** (The Jetsons) | **house-robot lady** — exactly this topic | vacuuming, motherly rocking |
| **Data** (Star Trek TNG) | golden skin, pale face | head tilt, "emotionless" |
| **K-2SO** (Rogue One) | tall, black, clumsy | long arms swinging |
| **Cylon** (Battlestar Galactica) | wandering red eye | the eye walks inside the visor |
| **ED-209** (RoboCop) | combat robot | angry steps, cannon barrel |
| **GLaDOS / Wheatley** (Portal) | hanging "personality core" | swinging on the cable |
| **BMO / GIR** (Adventure Time / Invader Zim) | small, meme favourite | bouncy, chaotic |
| **Daft Punk / Kraftwerk** robots | musical icons | even, machine tempo |

### 5.2 Memes and internet culture

| Idea | Why it is good |
|---|---|
| **Clippy** ✔ (already in) | the "helpful, annoying" archetype |
| **This is fine** dog — in a robot version | the serenity that survives everything |
| **"Danger, Will Robinson"** (Lost in Space) | the classic warning robot |
| **Skynet / HAL** ✔ (HAL is in) | the "evil machine" line |
| **Big Dog / Atlas** (Boston Dynamics) | the other two next to Spot ✔ |
| **Sophia / Pepper / ASIMO** | real humanoids, more famous faces |
| **"Checkered robot"** (the "I don't know what this is" meme) | deliberately meaningless |
| **Vecsés "Is this a robot?"** | a Hungarian meme line |

### 5.3 Hungarian line

| Idea | Why it is good |
|---|---|
| **Mikrobi** | Hungarian cartoon history; a machine, not a robot — but the silhouette is iconic |
| **The other robots of "Magyarok az űrben"** | from the same source as the Gyuszi |
| **Pannónia / Ikarus** style retro machine | Hungarian industrial design |
| **Amusement-park structure** | nostalgia |

### 5.4 Household and abstract ideas (the "house robot" literally)

| Idea | Why it is good |
|---|---|
| **Vacuum robot (Roomba)** | literally a house robot |
| **Coffee-maker robot** | the morning routine |
| **Toaster robot** | the "popping toast" as a punchline |
| **Retro CRT television head** | analogue nostalgia |
| **Radio robot** | the vintage line |
| **Plug head / light-bulb head** | "it is powered" |
| **LEGO robot** | brick aesthetics |
| **Origami / paper robot** | relatives of the paper-basket head |
| **Fan robot** | the head spins |
| **Festive versions** (Santa hat, pumpkin head, bunny ears) | seasonal rotation for auto mode |

### 5.5 Broader ideas for the system

- **Custom order** for automatic rotation (not the catalogue order, but a selectable "favourites").
- **Switch on an event**: when the robot reports an error → red (`szem`), when a job succeeds →
  `klasszikus`, when it waits for approval → `clippy`.
- **Alterego by time of day** (`bender` in the morning, `szem` at night).
- **Avatar in the report e-mail header** (the active alterego in the letter's HTML).
- **`?alterego=` on the console URL**, so the panel opens with a given alterego.
