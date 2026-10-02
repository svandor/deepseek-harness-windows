# A robot kommunikációs felülete — javaslat

**Dátum:** 2026-10-01
**Státusz:** **MEGVALÓSÍTVA** (V2 robot-konzol, 3+1 felület, „Csak robot" mód)
**Kapcsolódó:** [`BOT-TERV.md`](BOT-TERV.md), `bot/README.md` 5.0–5.0b szakasz

---

## 0. Döntés és megvalósítás (2026-10-01)

| Kérdés | Döntés | Megvalósult |
|---|---|---|
| Melyik út | **V2 — robot-konzol a panelon** | ✅ Konzol fül: parancssáv + beszélgetés |
| Elrendezés | **3 munkaterület + robot** (32:9) | ✅ `state/tray-config.json`: `panes=3`, `robotPane=true` |
| Csak robot mód | **kell** | ✅ tálca: „Csak robot mód (1 felület)" |

A megvalósult konzol:

- **Parancssáv** (0 token): `/állapot`, `/futtat <job>`, `/napló`, `/oldal`,
  `/oldalak`, `/far`, `/email`, `/segít` — ékezet nélkül is.
- **Beszélgetés** (ingyenes lánc): `bot/lib/agent.mjs` mini-ügynök, persona:
  `bot/agent.md`. A modell akciót kér (`AKCIÓ: {...}`), a bot végrehajtja, majd a
  modell válaszol (`VÁLASZ: ...`).
- **Jóváhagyás**: a kockázatos művelet (`email_teszt`) kártyát ad a konzolon.
- **Bizonyítva** (élő): a modell lekérte az `allapot` akciót, az lefutott, és
  magyar választ adott (≈3300 be / 184 ki token, ingyenes láncon); a
  `/futtat konkurencia-figyelo` parancs elindította a jobot.

Amit ez **nem** tartalmaz (következő kör): e-mail bemenet (IMAP), és a
beszélgetés mentése (a konzol előzménye jelenleg a böngésző munkamenetében él).


---

## 1. A jelenlegi állapot (mért)

Az ablak 4 felülettel fut: **3 DSH munkaterület + a robot** (a 4. panel a
`http://127.0.0.1:4180/` panelt tölti).

| Megfigyelés | Érték |
|---|---|
| Panelek | 4 (3 × DSH kliens + 1 × robot panel) |
| A robot panel fülei | Állapot · Beállítások · Napló |
| **Bemenet a robot panelon** | **nincs** (nincs parancssáv, nincs chat) |
| Panel-arányok | egyenlő (25-25-25-25), ezért szűk a robot |

**A probléma nem az, hogy „chat van a robot panelben"** — a chat egy külön
munkaterület-panel. A valódi hiány: **a robottal nem lehet beszélni**, és a
mellette lévő chat egy *általános* munkamenet, nem a roboté.

---

## 2. Milyen kommunikáció kell (rétegek)

| Réteg | Mi | Token | Állapot |
|---|---|---|---|
| **0.** Gombok | job futtatása, panel-műveletek | 0 | ✅ kész |
| **1.** Parancssáv | `futtat <job>`, `oldal <url>`, `email teszt`, `far állapot`, `napló 50` | **0** | ❌ nincs |
| **2.** Beszélgetés | szabad szöveges utasítás → a robot végrehajtja/megválaszolja | van (ingyenes lánc) | ❌ nincs |
| **3.** Jóváhagyás | függő műveletek kártyán: elfogad/elutasít | 0 | ❌ nincs |
| **4.** Aszinkron | e-mailben utasítás/válasz (IMAP) | 0 | ❌ nincs |

A robot **soha** nem hoz döntést a 4. rétegig magától: a kockázatos lépések
(FAR-beküldés, e-mail küldés, fájlmódosítás) jóváhagyásra várnak.

---

## 3. Két út — és a javaslat

### V1 — „A robot munkamenete" (azonnal kész, fejlesztés nélkül)

A 4. felület **marad DSH kliens**, de nem általános munkamenettel, hanem a
**robotéra kötve**:

1. **Robot preset** (`robot`): persona + eszközkészlet + modell-politika
   (`bot/agent.md` alapján; a FAR-os személyes adatnál felhő-modell tilos).
2. **`.bot` munkaterület** a sávon: a robot session-jei ide kerülnek (a
   `providers/session-channel.mjs` már tud csatornát regisztrálni).
3. A 4. panelben **egyszer** kiválasztod a `.bot` munkaterületet és a `robot`
   presetet — a WebView2 profil megjegyzi, onnantól mindig az jön be.

Amit ad: valódi beszélgetés a robottal, **teljes DSH eszközkészlettel**
(jobok, fájlok, terminál), streameléssel, jóváhagyással és naplóval — új UI
nélkül. Amit nem ad: a robot „saját" arca (a DSH chat felületét látod).

**Költség:** ~30 perc (preset + persona + munkaterület-regisztráció).

### V2 — „Robot-konzol" a panelon (fejlesztés)

A robot panel kap egy **Beszélgetés** fület és egy **parancssávot**:

- **Parancssáv** (1. réteg): determinisztikus parancsok, 0 token.
- **Beszélgetés** (2. réteg): a beírt utasítás egy **dedikált robot-sessionbe**
  megy (`.bot` munkaterület, `robot` preset), a válasz ide fut be — nem külön
  DSH panelbe.
- **Jóváhagyás-kártyák** (3. réteg) és **e-mail** (4. réteg).

Technika: a `dsh-hazi-robot` host plugin **a hostban fut**, ezért közvetlenül
tud sessiont nyitni (`ctx.workspaceRegistry` + prompt-felvétel — ugyanaz a minta,
amit a `dsh-webhook` használ). Új route-ok:

```
POST /hazi-robot/command      determinisztikus parancs (0 token)
POST /hazi-robot/ask          utasítás a robot-sessionnek
GET  /hazi-robot/chat?since=  a beszélgetés előzménye (poll)
GET  /hazi-robot/approvals    függő jóváhagyások
POST /hazi-robot/approve      döntés
```

**Költség:** ~1 nap (route-ok + panel UI + persona).

### A javaslatom: **V1 most, V2 utána**

A V1 önmagában megszünteti a panaszt (nem általános chat lesz a robot mellett,
hanem a robot saját munkamenete), és **ma** elkészül. A V2 akkor éri meg, ha a
DSH chat felülete zavar a robot mellett — addig a V1 ugyanazt tudja.

---

## 4. Elrendezés (a mostani 25% túl szűk)

A tálca „Ablak felosztása" menüje ma **munkaterület-számot** állít (1–3) + a
robotot. Javaslat: **kombinációk** néven:

| Menüpont | Felületek | Kinek |
|---|---|---|
| **Csak a robot** | 1 (robot, teljes szélesség) | a robottal dolgozol |
| **1 munkaterület + robot** | 2 (50/50) | párhuzamos munka |
| **2 munkaterület + robot** | 3 (33/33/33) | **ez legyen az alap** |
| **3 munkaterület + robot** | 4 (25% mind) | a jelenlegi |

Emellett: a robot panel kapjon **szélesebb** alap-arányt (pl. 40%), és a
panel-arányok mentése már működik (húzható elválasztók).

---

## 5. Modell- és adatpolitika (nem tárgyalás kérdése)

| Feladat | Modell |
|---|---|
| Parancssáv, gombok, állapot | **nincs modell** |
| Beszélgetás, összegzés, e-mail | ingyenes lánc (`subagent-worker`) |
| Nehéz döntés, kód | DeepSeek **off-peak** |
| **FAR / személyes adat** | **csak determinisztikus kód vagy helyi Ollama** — felhő TILOS |

A robot session-je a `.bot` munkaterületen fut, ezért minden utasítás és válasz
a DSH naplóiban marad (auditálható), és a `toolFilter`/jóváhagyás ugyanúgy
érvényes rá, mint bármely más sessionre.

---

## 6. Fázisok

| Fázis | Mit ad | Költség |
|---|---|---|
| **A** | Elrendezés: tálca-kombinációk + robot-mód (csak robot) + 40%-os robot-arány | ~30 perc |
| **B** | V1: `robot` preset + `bot/agent.md` persona + `.bot` munkaterület a sávon | ~30 perc |
| **C** | V2/1: parancssáv a panelon (determinisztikus, 0 token) | ~2 óra |
| **D** | V2/2: Beszélgetés fül (dedikált robot-session) + jóváhagyás-kártyák | ~1 nap |
| **E** | E-mail kétirányú (IMAP): utasítás/válasz levélben | ~fél nap |

---

## 7. Döntést kérő kérdések

1. **V1 vagy V2?** (V1 = a robot saját DSH munkamenete a 4. panelben; V2 = saját
   robot-konzol a panelon.)
2. **Alap-elrendezés:** 2 munkaterület + robot (javasolt), vagy marad a 3+1?
3. **Kell-e „Csak a robot" mód** a tálcán (1 felület, teljes szélesség)?
4. **A parancssáv nyelve:** magyar kulcsszavak (`futtat`, `oldal`, `állapot`) —
   rendben?
5. **Hang:** kell-e a robotnak beszélni (TTS) vagy elég a szöveg?
