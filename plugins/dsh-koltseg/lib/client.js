/**
 * KLIENS oldal: „Költségelszámolás” — ikon+tooltip gomb a menüsorban, ami egy
 * LEBEGŐ ABLAKOT nyit (portal a `document.body`-ba), és a munkafolyamat /
 * munkaterület / időszak idejét mutatja forintban.
 *
 * Minta, amit követ:
 *   - fejléc-ikon: `dsh-ftp-deploy` (26 px, csak SVG, a felirat a tooltipben);
 *   - lebegő ablak: `dsh-ui-extras` statisztika-tooltipje (`createPortal`,
 *     `position: fixed`, magas z-index, ESC + kattintás kívülre zárja);
 *   - minden adat a host `/koltseg/*` végpontjairól jön, a böngésző nem olvas
 *     fájlt és nem számol üzleti logikát.
 *
 * Emellett egy LÁTHATATLAN komponens méri a felhasználó aktivitását
 * (billentyű/mutató/görgetés/lap-láthatóság) 5 s-os vödrökben — ebből tudja a
 * host szétválasztani az olvasást és a gépelést. Szöveget NEM küldünk.
 */
window.__ModuleLoader__.load({
  id: "dsh-koltseg",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    /** A lebegő ablakhoz (portal). Ha nincs, a panel a helyén renderel. */
    var reactDom = null;
    try {
      reactDom = require("react-dom");
    } catch (error) {
      reactDom = null;
    }

    var NS = "koltseg";
    // A kliens build-je: a panel fejlécében „v<bBuild>” alakban LÁTSZIK, és a
    // host `engine` mezőjéhez hasonlítva jelzi, ha a host régi. 2026-11-20.1:
    // bruttó (áfás) token-sor, pörgő folyamatjelző, „előző beállítás” jelzés.
    var BUILD = "2026-11-20.1";
    var ROUTE = "/koltseg";
    var HEADER_SLOT = "conversation.session.header.utilities";
    var TRACKER_SLOT = "conversation.composer.dock";
    /** A composer fölötti sáv: MINDKÉT fázisban létezik (hero is). */
    var INPUT_DOCK_SLOT = "conversation.input.dock";
    var HEADER_ID = "koltseg-header";
    /**
     * A fejléc-sorban a LEHETŐ LEGKORÁBBRA tesszük: a sor jobb szélén a
     * nagyobb `order` értékű elemek kiszorulhatnak (a panelek szűkek, a cím és
     * a modellválasztó viszi a helyet) — MÉRT panasz: „nem látom az ikont”.
     */
    var HEADER_ORDER = 5;

    /** A mérés frissítése nyitott ablak mellett (ms). */
    var REFRESH_MILLISECONDS = 20000;

    /**
     * A „számítás folyamatban” jelző MINIMÁLIS látszási ideje (ms).
     *
     * MIÉRT (2026-11-20, felhasználói jelzés: „továbbra sincs
     * folyamatvisszajelzés … nem lehet tudni, hogy kiírta-e már az eredményt”):
     * a `/koltseg/measure` MÉRVE 0,4–0,6 s alatt válaszol, tehát a pörgő egy
     * villanás volt, a számok pedig csendben kicserélődtek. A jelzőt a válasz
     * után is ennyi ideig tartjuk, hogy a felhasználó lássa: számolt.
     */
    var MIN_BUSY_MILLISECONDS = 700;

    /** Az aktivitás-vödrök hossza (ms) és a küldés üteme (ms). */
    var ACTIVITY_BUCKET_MILLISECONDS = 5000;
    var ACTIVITY_FLUSH_MILLISECONDS = 15000;

    // ─────────────────────────────────────────────────────────── szótár (HU/EN)
    var HU = {
      "tab.title": "Költségelszámolás",
      "header.title": "Költségelszámolás — a fejlesztés ideje és díja (munkafolyamat, munkaterület, időszak)",
      "panel.title": "Költségelszámolás",
      // A panel új (kliens) és a host motor régi lehet — ezt ki kell mondani,
      // különben a felhasználó hiába tölti újra a panelt (2026-11-17).
      "panel.hostOk": "host {build}",
      "panel.hostUnknown": "host ?",
      "panel.hostStale": "A panel kódja új (v{build}), de a HOST-on futó motor még a régi — a számok a következő harness-indításnál frissülnek. Indítás: tálca → „Harness újraindítása”.",
      "panel.close": "Bezárás",
      "scope.session": "Ez a munkafolyamat",
      "scope.workspace": "Munkaterület",
      "scope.range": "Időszak",
      "scope.range.from": "Tól",
      "scope.range.to": "Ig",
      "scope.range.last30": "Utolsó 30 nap",
      "scope.range.apply": "Alkalmaz",
      "rate.label": "Óradíj",
      "rate.unit": "Ft/óra",
      "rate.save": "Mentés",
      "rate.saved": "Mentve.",
      "rate.source.global": "globális alap",
      "rate.source.workspace": "repó felülírás",
      "profile.label": "Profil",
      "profile.source.request": "felületen választva",
      "profile.source.workspace": "repó beállítás",
      "profile.source.global": "globális alap",
      "components.head": "Mért idő",
      "components.agent": "Szerver oldali munkaidő",
      "components.jobs": "Háttérmunkák",
      "components.humanRead": "Olvasás (válasz elolvasása)",
      "components.humanType": "Gépelés (új prompt)",
      "components.humanType.estimated": "becsült (a beírt szövegből)",
      "components.wall": "Valós aktív idő (bruttó)",
      "components.weight": "súly",
      "components.counted": "beszámít",
      "components.notCounted": "nem számít",
      "components.empty": "Ebben az időszakban nincs mért adat.",
      "total.billable": "Elszámolható",
      "total.net": "Nettó",
      "total.vat": "ÁFA ({percent}%)",
      "total.gross": "Bruttó",
      "total.minutes": "{minutes} perc",
      "total.hours": "{hours} óra",
      "options.vat": "ÁFA ({percent}%) a végösszegen",
      "options.material": "Token/API önköltség (külön sor)",
      "options.material.note": "Az óradíj alapból magában foglalja a tokeneket; ez a sor csak kimutatás.",
      // 2026-11-20: a sor a FIZETENDŐ (bruttó) árat mutatja — 27% magyar áfa,
      // a DeepSeeknél további 6% DSH-pótdíj (×1,3462); Alibaba/OpenRouter ×1,27.
      // A szorzást a panel MAGA végzi (a `/ui-extras/usage` modell-bontásából),
      // ezért akkor is bruttó, ha a host fél még a régi, nettó összeget adja.
      "options.material.usd": "Token költség (bruttó, áfával): {usd}",
      "options.material.gross": "Bruttó bontás: nettó {net} listaáron + {vat}% magyar áfa (a DeepSeeknél ezen felül {dsh}% DSH-pótdíj, ×{dshRate}); az Alibaba és az OpenRouter ×{othersRate}. Az egyenleg a szolgáltató számláján lévő, szinkronizált összeg — azon nincs szorzó.",
      "options.material.cache": "Cache-találat: {hit} ({percent}% a bemenetből), {discount}% kedvezmény érvényesítve · kimenet {out} · {requests} kérés",
      "options.material.cache.saved": "Kedvezmény nélkül {baseline} lenne — a cache ennyit hozott: {saved}.",
      "options.material.scope": "A token-sor a kiválasztott munkaterületre/harmonikára szűrve.",
      "options.material.unavailable": "A token költség ehhez nem érhető el.",
      // MÉRT HIBA (2026-11-18): a token-sor a mérés ELSŐ ~1 percében
      // „nem érhető el”-t írt, mert nem volt külön betöltő állapot — a hideg
      // szkennelés (~1300 session-napló) addig tart. Most ki van mondva, hogy
      // mérés van folyamatban, nem hiba — és pörgő jelző is látszik mellette.
      "options.material.loading": "A token költség mérése folyamatban… (az első mérés hideg szkennelés, akár ~1 perc)",
      "status.calculating": "Számítás folyamatban…",
      // A KIVÁLASZTÁS megváltozott: a látható számok még az előző beállításból
      // valók (2026-11-20, felhasználói jelzés: nem lehetett tudni, kész van-e).
      "status.recalculating": "Újraszámítás folyamatban… (a számok még az előző beállításból valók)",
      "status.updated": "Frissítve: {at}",
      "status.stale": "Ez a szám még az előző beállításból való ({at}) — folyamatban az újraszámítás",
      "actions.refresh": "Frissítés",
      "actions.freeze": "Rögzítés",
      "actions.frozen": "Rögzítve.",
      "actions.csv": "CSV",
      "details.show": "Részletek",
      "details.hide": "Részletek elrejtése",
      "details.turn": "Kör",
      "details.start": "Kezdés",
      "details.agent": "Agent",
      "details.read": "Olvasás",
      "details.type": "Gépelés",
      "details.source": "Forrás",
      "details.edge": "utolsó kör",
      "details.none": "Nincs megjeleníthető részlet.",
      "session.current": "Kiválasztott munkafolyamat",
      "session.none": "Nincs kiválasztott munkafolyamat.",
      "session.list": "Munkafolyamatok",
      "source.client": "kliens-mérés (olvasás/gépelés bontva)",
      "source.fallback": "napló-alapú becslés (bontás nélkül)",
      "source.mixed": "vegyes (részben kliens-mérés)",
      "source.none": "nincs emberi idő",
      "status.loading": "Számítás…",
      "status.snapshot": "Pillanatkép: {at} — a friss mérés fut…",
      "status.error": "A mérés nem sikerült",
      "status.oldHost": "A host fél még a régi verzió (a /koltseg végpont nem válaszol). Indítsd újra a szervert.",
      "status.measureError": "A mérés hibája: {error}",
      "status.noSessions": "Ehhez a munkaterülethez nincs session-napló.",
      "note.workspace": "Munkaterület: {workspace}",
      "note.range": "Időszak: {from} — {to}",
      "note.activity": "Aktivitás-rekordok: {count}",
      "conn.error": "Kapcsolódási hiba: {error}",
      "unit.min": "{minutes} p",
      "unit.hour": "{hours} ó",
      "tracker.title": "Aktivitás-mérés (olvasás/gépelés)",
    };

    var EN = {
      "tab.title": "Cost accounting",
      "header.title": "Cost accounting — development time and price (workflow, workspace, period)",
      "panel.title": "Cost accounting",
      "panel.hostOk": "host {build}",
      "panel.hostUnknown": "host ?",
      "panel.hostStale": "The panel code is new (v{build}) but the HOST engine is still the old one — the numbers update at the next harness start. Start it from the tray: \u201eRestart harness\u201d.",
      "panel.close": "Close",
      "scope.session": "This workflow",
      "scope.workspace": "Workspace",
      "scope.range": "Period",
      "scope.range.from": "From",
      "scope.range.to": "To",
      "scope.range.last30": "Last 30 days",
      "scope.range.apply": "Apply",
      "rate.label": "Hourly rate",
      "rate.unit": "HUF/hour",
      "rate.save": "Save",
      "rate.saved": "Saved.",
      "rate.source.global": "global default",
      "rate.source.workspace": "repo override",
      "profile.label": "Profile",
      "profile.source.request": "picked in the UI",
      "profile.source.workspace": "repo setting",
      "profile.source.global": "global default",
      "components.head": "Measured time",
      "components.agent": "Server-side work time",
      "components.jobs": "Background jobs",
      "components.humanRead": "Reading (the answer)",
      "components.humanType": "Typing (next prompt)",
      "components.humanType.estimated": "estimated (from the typed text)",
      "components.wall": "Real active time (gross)",
      "components.weight": "weight",
      "components.counted": "counted",
      "components.notCounted": "not counted",
      "components.empty": "No measured data in this period.",
      "total.billable": "Billable",
      "total.net": "Net",
      "total.vat": "VAT ({percent}%)",
      "total.gross": "Gross",
      "total.minutes": "{minutes} minutes",
      "total.hours": "{hours} hours",
      "options.vat": "VAT ({percent}%) on the total",
      "options.material": "Token/API material cost (separate line)",
      "options.material.note": "The hourly rate already covers tokens by default; this line is informational.",
      "options.material.usd": "Token cost (gross, VAT included): {usd}",
      "options.material.gross": "Gross breakdown: net {net} at list price + {vat}% Hungarian VAT (plus a {dsh}% DSH surcharge on DeepSeek, ×{dshRate}); Alibaba and OpenRouter ×{othersRate}. The balance is the provider's synced figure — no multiplier on it.",
      "options.material.cache": "Cache hits: {hit} ({percent}% of input), {discount}% discount applied · output {out} · {requests} requests",
      "options.material.cache.saved": "Without the discount it would be {baseline} — the cache saved {saved}.",
      "options.material.scope": "The token line is filtered to the selected workspace/session.",
      "options.material.unavailable": "Token cost is unavailable here.",
      "options.material.loading": "Measuring the token cost… (the first scan is cold and can take about a minute)",
      "status.calculating": "Calculating…",
      "status.recalculating": "Recalculating… (the numbers still come from the previous setting)",
      "status.updated": "Updated: {at}",
      "status.stale": "This figure is still from the previous setting ({at}) — recalculating",
      "actions.refresh": "Refresh",
      "actions.freeze": "Freeze",
      "actions.frozen": "Frozen.",
      "actions.csv": "CSV",
      "details.show": "Details",
      "details.hide": "Hide details",
      "details.turn": "Turn",
      "details.start": "Start",
      "details.agent": "Agent",
      "details.read": "Reading",
      "details.type": "Typing",
      "details.source": "Source",
      "details.edge": "last turn",
      "details.none": "Nothing to show.",
      "session.current": "Selected workflow",
      "session.none": "No workflow selected.",
      "session.list": "Workflows",
      "source.client": "client measurement (reading/typing split)",
      "source.fallback": "log-based estimate (no split)",
      "source.mixed": "mixed (partly client measurement)",
      "source.none": "no human time",
      "status.loading": "Calculating…",
      "status.snapshot": "Snapshot: {at} — refreshing…",
      "status.error": "The measurement failed",
      "status.oldHost": "The host half is still the old build (the /koltseg endpoint does not answer). Restart the server.",
      "status.measureError": "Measurement error: {error}",
      "status.noSessions": "No session logs for this workspace.",
      "note.workspace": "Workspace: {workspace}",
      "note.range": "Period: {from} — {to}",
      "note.activity": "Activity records: {count}",
      "conn.error": "Connection error: {error}",
      "unit.min": "{minutes} m",
      "unit.hour": "{hours} h",
      "tracker.title": "Activity measurement (reading/typing)",
    };

    /** A jelenlegi fordító (a `apply` köti be). */
    var translator = function (key, values) {
      var template = HU[key] ?? key;
      if (!values) return template;
      return String(template).replace(/\{(\w+)\}/g, function (_match, name) {
        return name in values ? String(values[name]) : "–";
      });
    };

    /**
     * Kliens-oldali diagnosztika a hostnak (`POST /koltseg/log`).
     *
     * MIÉRT: a böngésző `console.warn`-ja nem látszik a hostból, ezért a
     * „miért nem jelenik meg a gomb” kérdésre csak így lehet mérhető választ
     * adni (regisztráció siker/hiba, mount, a doboz mérete és helye).
     */
    function reportEvent(text) {
      var line = "[koltseg] " + String(text).slice(0, 400);
      // Tartalék-útvonal: a `/ui-extras/log` a MÁR futó hoston is létezik, ezért
      // a diagnosztika akkor sem vész el, ha a `/koltseg/log` még nem él (a host
      // fél csak a következő harness-indításnál kapja meg az új végpontot).
      function fallback() {
        try {
          fetch("/ui-extras/log", {
            method: "POST",
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: new Date().toISOString() + " " + line,
            keepalive: true,
          }).catch(function () { /* diagnosztika: nem kritikus */ });
        } catch (error) {
          /* a diagnosztika hibája nem akaszthatja meg a felületet */
        }
      }
      try {
        fetch(ROUTE + "/log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: line }),
          keepalive: true,
        }).then(function (response) {
          if (!response || response.ok !== true) fallback();
        }).catch(function () { fallback(); });
      } catch (error) {
        fallback();
      }
    }

    // ─────────────────────────────────────────────────────────────── segédek
    function getJson(url) {
      return fetch(url, { headers: { Accept: "application/json" } }).then(function (response) {
        return response.json();
      });
    }

    function postJson(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (response) {
        return response.json();
      });
    }

    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (_match, key) {
        return values && key in values ? String(values[key]) : "–";
      });
    }

    function toNumber(value) {
      var parsed = Number.parseFloat(String(value ?? ""));
      return Number.isFinite(parsed) ? parsed : 0;
    }

    /** Milliszekundum -> perc, egy tizedessel, magyar tizedesvesszővel. */
    function fmtMinutes(ms) {
      var minutes = Math.round((toNumber(ms) / 60000) * 10) / 10;
      return String(minutes.toFixed(1)).replace(".", ",");
    }

    /** Milliszekundum -> óra, két tizedessel. */
    function fmtHours(ms) {
      var hours = Math.round((toNumber(ms) / 3600000) * 100) / 100;
      return String(hours.toFixed(2)).replace(".", ",");
    }

    /**
     * Ezres tagolás kis hézaggal (`12 500`) — a MEGJELENÍTÉSHEZ.
     * A beírt óradíjhoz is ezt használjuk, ezért a mező `type="text"`.
     */
    function groupDigits(value) {
      var digits = String(value ?? "").replace(/[^0-9]/gu, "");
      if (digits.length === 0) return "";
      return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, "\u00A0");
    }

    /** A tagolt szövegből szám (a hézagokat eldobja). */
    function digitsOnly(value) {
      return String(value ?? "").replace(/[^0-9]/gu, "");
    }

    function fmtHuf(value) {
      var number = Math.round(toNumber(value));
      // Ugyanaz az ezres tagolás, mint a beírt óradíjnál (kis hézag, U+00A0).
      var text = groupDigits(String(Math.abs(number)));
      return (number < 0 ? "-" : "") + (text.length > 0 ? text : "0") + " Ft";
    }

    /**
     * USD összeg MAGYAR alakban: `$1,0407` (tizedesvessző, nem pont).
     *
     * MÉRT HIBA (2026-11-17, felhasználói jelzés): a `toFixed` pontot ad, ami a
     * magyar felületen idegen (`$1.0407`) — ezért a tizedesjel vessző.
     */
    function fmtUsd(value) {
      var number = toNumber(value);
      try {
        return "$" + String(number.toFixed(4)).replace(".", ",");
      } catch (error) {
        return "$" + String(number).replace(".", ",");
      }
    }

    /**
     * Token-szám rövid alakja (`112,4 M` / `458,9 e` / `987`).
     *
     * MIÉRT: a token-sorban a nyers szám olvashatatlan (20544962161), a
     * mérnöki jelölés pedig idegen a felülettől; a magyar alak ezres/hátvány
     * tagolást használ.
     */
    function fmtTokens(value) {
      var number = toNumber(value);
      var abs = Math.abs(number);
      var text;
      if (abs >= 1000000000) text = String((number / 1000000000).toFixed(1)).replace(".", ",") + "\u00A0Mrd";
      else if (abs >= 1000000) text = String((number / 1000000).toFixed(1)).replace(".", ",") + "\u00A0M";
      else if (abs >= 10000) text = String((number / 1000).toFixed(1)).replace(".", ",") + "\u00A0e";
      else text = groupDigits(String(Math.round(number)));
      return text;
    }

    function pad2(value) {
      return String(value).padStart(2, "0");
    }

    // ── Bruttó (áfás) ár a panelben (2026-11-20, felhasználói jelzés) ──────
    /**
     * A bruttó szorzók — UGYANAZOK, mint a host ártáblájában
     * (`plugins/dsh-ui-extras/lib/index.js` → `GROSS_RATES`):
     *   DeepSeek ×1,3462 (27% magyar áfa + 6% DSH-pótdíj)
     *   Alibaba / OpenRouter ×1,27 (27% magyar áfa)
     *   ingyenes lánc ×1 (0 × bármi = 0)
     *
     * MIÉRT a kliensben is: a host-oldali áfázás csak a következő
     * harness-indításnál lép életbe, a panelnek viszont MOST a fizetendő árat
     * kell mutatnia. A panel a válasz MODELL-BONTÁSÁBÓL (`perModel`) számol, így
     * az eredmény modellenként pontosan ugyanaz, mintha a host számolná.
     */
    var FALLBACK_GROSS_RATES = { dsh: 1.3462, alibaba: 1.27, openrouter: 1.27, free: 1, vat: 27, surcharge: 6 };

    /** A válasz `pricing.gross` blokkja, ha van (különben a beégetett szorzók). */
    function grossRatesOf(data) {
      var gross = data && data.pricing && data.pricing.gross ? data.pricing.gross : null;
      var rates = gross && gross.rates && typeof gross.rates === "object" ? gross.rates : null;
      return {
        dsh: rates && typeof rates.dsh === "number" ? rates.dsh : FALLBACK_GROSS_RATES.dsh,
        alibaba: rates && typeof rates.alibaba === "number" ? rates.alibaba : FALLBACK_GROSS_RATES.alibaba,
        openrouter: rates && typeof rates.openrouter === "number" ? rates.openrouter : FALLBACK_GROSS_RATES.openrouter,
        free: rates && typeof rates.free === "number" ? rates.free : FALLBACK_GROSS_RATES.free,
        vat: gross && typeof gross.vatPercent === "number" ? gross.vatPercent : FALLBACK_GROSS_RATES.vat,
        surcharge: gross && typeof gross.dshSurchargePercent === "number" ? gross.dshSurchargePercent : FALLBACK_GROSS_RATES.surcharge,
      };
    }

    /** A host MÁR bruttó összegeket ad? (akkor a panel NEM szoroz) */
    function isHostGross(data) {
      return !!(data && data.pricing && data.pricing.gross && data.pricing.gross.basis === "gross");
    }

    /** Egy modell bruttó szorzója (a host `grossFamily`-jével azonos sorrend). */
    function grossRateOfModel(model, rates) {
      var table = rates && typeof rates === "object" ? rates : FALLBACK_GROSS_RATES;
      var lower = String(model ?? "").toLowerCase();
      if (lower.indexOf("openrouter") !== -1) return table.openrouter;
      if (lower.indexOf("alibaba") !== -1 || lower.indexOf("qwen") !== -1) return table.alibaba;
      // DeepSeek és minden ismeretlen (az a Flash ár-sorral megy): DSH szorzó.
      return table.dsh;
    }

    /**
     * A nettó összeg bruttóvá alakításának szorzója.
     *
     * A `perModel` bontásból modellenként pontos (`model`); ha nincs bontás
     * (pl. session-hatókör régi hostnál), a DSH szorzó a konzervatív becslés.
     * @returns {{factor: number, source: "model"|"estimated"}}
     */
    function grossFactorOf(data, rates) {
      var models = data && Array.isArray(data.perModel) ? data.perModel : [];
      var netSum = 0;
      var grossSum = 0;
      for (var i = 0; i < models.length; i++) {
        var entry = models[i];
        var cost = toNumber(entry && entry.costUsd);
        if (!(cost > 0)) continue;
        netSum += cost;
        grossSum += cost * grossRateOfModel(entry.model, rates);
      }
      if (netSum > 0 && grossSum > 0) return { factor: grossSum / netSum, source: "model" };
      return { factor: rates.dsh, source: "estimated" };
    }

    /** `YYYY-MM-DD` a helyi naptár szerint (a host magyar napként értelmezi). */
    function dayText(date) {
      var value = date instanceof Date ? date : new Date(date);
      return value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate());
    }

    function todayText() {
      return dayText(new Date());
    }

    function daysAgoText(days) {
      var date = new Date();
      date.setDate(date.getDate() - Math.max(0, days));
      return dayText(date);
    }

    function fmtStamp(ms) {
      var value = toNumber(ms);
      if (value <= 0) return "–";
      var date = new Date(value);
      return dayText(date) + " " + pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }

    /** A munkafolyamat rövid azonosítója (a session- prefix nélkül). */
    function shortId(id) {
      return String(id ?? "").replace(/^session-/u, "").slice(0, 8);
    }

    /**
     * A plugin szolgáltatásai (apply-kor kötjük be).
     *
     * MIÉRT: a slot-komponensek NEM kapják meg a `sessions`/`workspaces`
     * szolgáltatást (a `inject`-tel átadott props miatt a gomb komponense nem is
     * renderelt — mért hiba), ezért a szolgáltatásokat a plugin `apply`-jában
     * mentjük el, és a munkaterületet ebből oldjuk fel. Ugyanaz a három fokozat,
     * mint a `dsh-ui-extras` `resolveWorkspace`-ében (ez a bizonyított út).
     */
    var pluginServices = { sessions: null, workspaces: null };

    function resolveWorkspaceFromServices(sessionId) {
      try {
        var sessions = pluginServices.sessions;
        if (sessions && sessions.list && typeof sessions.list.getSnapshot === "function") {
          var snapshot = sessions.list.getSnapshot();
          var id = sessionId;
          if (id === undefined || id === null || id === "") {
            var selected = snapshot ? snapshot.selected : null;
            id = typeof selected === "string" ? selected : (selected && selected.id);
          }
          if ((id === undefined || id === null || id === "") && snapshot) id = snapshot.current;
          if (id !== undefined && id !== null && id !== "") {
            var entry = snapshot && snapshot.byId ? snapshot.byId[id] : undefined;
            if (entry && typeof entry.cwd === "string" && entry.cwd.length > 0) return entry.cwd;
          }
        }
      } catch (error) {
        /* marad a következő fokozat */
      }
      try {
        var workspaces = pluginServices.workspaces;
        if (workspaces && typeof workspaces.getSnapshot === "function") {
          var state = workspaces.getSnapshot();
          var list = state && Array.isArray(state.list) ? state.list : [];
          var picked = state && state.selected !== undefined && state.selected !== null ? state.selected : (state ? state.selectedId : undefined);
          var chosen = list.filter(function (item) { return item && (item.id === picked || item.path === picked); })[0];
          if (chosen && typeof chosen.path === "string" && chosen.path.length > 0) return chosen.path;
          if (list.length > 0 && list[0] && typeof list[0].path === "string") return list[0].path;
        }
      } catch (error) {
        /* marad az üres érték */
      }
      return "";
    }

    /**
     * A munkaterület feloldása a kliens-oldali állapotból.
     * Három fokozat: a slot props-a -> a plugin szolgáltatásai -> üres
     * (a host ilyenkor a session naplófejlécéből oldja fel).
     */
    function pickWorkspace(props) {
      if (props !== null && typeof props === "object" && typeof props.workspace === "string" && props.workspace.length > 0) {
        return props.workspace;
      }
      var sessionId = props && typeof props.sessionId === "string" ? props.sessionId : "";
      var fromProps = resolveWorkspaceFromServices(sessionId);
      if (fromProps.length > 0) return fromProps;
      // A props-ban kapott szolgáltatás (ha valaha megjön) erősebb a mentettnél.
      if (props && props.sessions !== undefined && props.sessions !== null) {
        var saved = pluginServices.sessions;
        pluginServices.sessions = props.sessions;
        try {
          var retried = resolveWorkspaceFromServices(sessionId);
          return retried;
        } finally {
          pluginServices.sessions = saved;
        }
      }
      return "";
    }

    // ─────────────────────────────────────────────────────────────── stílusok
    var S = {
      button: {
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
        borderRadius: "7px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        lineHeight: "1",
        cursor: "pointer",
      },
      headerBtn: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "4px",
        height: "26px",
        minWidth: "26px",
        // A slot-sor flex: enélkül a gomb teljes szélességre nyúlna (mért:
        // 688x18 px doboz a hero sávban) — így kompakt chip marad.
        flex: "0 0 auto",
        alignSelf: "center",
        maxWidth: "100%",
        padding: "0 6px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
        borderRadius: "7px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        lineHeight: "1",
        cursor: "pointer",
      },
      panel: {
        position: "fixed",
        zIndex: 2147483000,
        boxSizing: "border-box",
        width: "460px",
        maxWidth: "calc(100vw - 24px)",
        display: "flex",
        flexDirection: "column",
        borderRadius: "12px",
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
        background: "var(--dsw-alias-bg-layer-3, #242427)",
        color: "var(--dsw-alias-label-primary, #f5f5f5)",
        boxShadow: "0 18px 48px rgba(0,0,0,.5)",
        // A natív vezérlők (legördülő lista, dátumválasztó, jelölőnégyzet,
        // görgetősáv) így sötétek — enélkül a panel sötét hátterén világos
        // felugró elemek jelennek meg (mért hiba, 2026-11-17).
        colorScheme: "dark",
        fontSize: "12px",
        lineHeight: "18px",
        overflow: "hidden",
      },
      panelHead: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        padding: "10px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.10)",
        fontWeight: 600,
      },
      panelBody: {
        padding: "10px 12px",
        overflowY: "auto",
        overflowX: "hidden",
      },
      row: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
      between: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
      section: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.10)" },
      label: { opacity: 0.65, fontSize: "11px" },
      /**
       * PÖRGŐ FOLYAMATJELZŐ (2026-11-20, felhasználói jelzés: „nincs
       * folyamatjelző, amikor éppen számítást végez a panel”).
       *
       * MIÉRT inline `animation`: a panel csak inline stílusokat használ, a
       * kulcskockákat a panel gyökerében elhelyezett `<style>` adja (lásd
       * `spinKeyframes`). A `currentColor` miatt a téma színét örökli.
       */
      spin: {
        display: "inline-block",
        flex: "0 0 auto",
        width: "10px",
        height: "10px",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "50%",
        opacity: 0.8,
        animation: "dsh-koltseg-spin 0.9s linear infinite",
      },
      busy: { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" },
      /**
       * A számok blokkja. `stale` alatt halvány: amíg az új beállítás mérése
       * fut, a régi számok NE tűnjenek késznek (2026-11-20, felhasználói
       * jelzés), a halványítás pedig látható állapotváltozás.
       */
      result: { transition: "opacity 140ms linear", opacity: 1 },
      resultStale: { transition: "opacity 140ms linear", opacity: 0.4 },
      input: {
        border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.22))",
        borderRadius: "6px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        padding: "3px 6px",
        minWidth: "0",
      },
      /**
       * A profil-legördülő.
       *
       * MIÉRT KÜLÖN (2026-11-17, a felhasználó észrevétele: „rossz a legördülő
       * sötét módja”): a natív `<select>` NEM örökli a `transparent` hátteret —
       * a böngésző a saját (világos) festését használja, ezért a panel sötét
       * hátterén fehér csík/listа jelent meg, olvashatatlan szöveggel. A javítás
       * három dolog: konkrét háttér a vezérlőn, `colorScheme: "dark"` (a natív
       * felugró listát és a görgetősávot is sötétre állítja), és a
       * `<option>`-ökön is explicit háttér/szín (a Windows-Chrome az `option`
       * hátterét a select-tel együtt festi).
       */
      select: {
        border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.22))",
        borderRadius: "6px",
        background: "var(--dsw-alias-bg-layer-2, #2c2c30)",
        color: "var(--dsw-alias-label-primary, #f5f5f5)",
        colorScheme: "dark",
        font: "inherit",
        fontSize: "12px",
        padding: "3px 6px",
        minWidth: "0",
        maxWidth: "220px",
      },
      option: {
        background: "var(--dsw-alias-bg-layer-2, #2c2c30)",
        color: "var(--dsw-alias-label-primary, #f5f5f5)",
      },
      chip: {
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
        borderRadius: "999px",
        padding: "2px 8px",
        fontSize: "11px",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
      },
      chipActive: {
        border: "1px solid var(--dsw-alias-accent, #7c9cff)",
        borderRadius: "999px",
        padding: "2px 8px",
        fontSize: "11px",
        background: "rgba(124,156,255,0.18)",
        color: "inherit",
        cursor: "pointer",
      },
      table: { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
      th: { textAlign: "left", fontWeight: 500, opacity: 0.6, fontSize: "11px", padding: "3px 4px" },
      td: { padding: "3px 4px", borderTop: "1px solid rgba(255,255,255,0.07)" },
      tdNum: { padding: "3px 4px", borderTop: "1px solid rgba(255,255,255,0.07)", textAlign: "right", fontVariantNumeric: "tabular-nums" },
      total: {
        marginTop: "8px",
        padding: "8px 10px",
        borderRadius: "8px",
        background: "rgba(124,156,255,0.10)",
        border: "1px solid rgba(124,156,255,0.28)",
      },
      big: { fontSize: "18px", fontWeight: 700, fontVariantNumeric: "tabular-nums" },
      note: { opacity: 0.62, fontSize: "11px", marginTop: "4px" },
      error: { color: "#ffb4ab", fontSize: "12px", whiteSpace: "pre-wrap" },
      link: { color: "inherit", textDecoration: "underline", cursor: "pointer" },
    };

    // ─────────────────────────────────────────────────────── fázis-felismerés
    /**
     * A beszélgetés aktuális fázisa (`hero` = üres, új beszélgetés).
     *
     * MIÉRT KELL: a `hero` fázisban a fejléc EL VAN REJTVE, tehát a fejléc-slotba
     * regisztrált ikon nem látszik (pontosan ez a `dsh-ui-extras` „hero-era”
     * tanulsága: a gombokat ilyenkor a `conversation.input.dock` hozza). Ezért a
     * gombnak két példánya van, és a fázis dönti el, melyik látszik.
     */
    function readConversationPhase() {
      try {
        var anchor = document.querySelector("[data-conversation-scroll]");
        var node = anchor === null || anchor === undefined ? null : anchor.closest("[data-phase]");
        if (node !== null && node !== undefined) {
          var value = node.getAttribute("data-phase");
          if (typeof value === "string" && value !== "") return value;
        }
        var candidates = document.querySelectorAll("[data-phase]");
        for (var i = 0; i < candidates.length; i += 1) {
          var candidate = candidates[i].getAttribute("data-phase");
          if (candidate === "hero" || candidate === "active" || candidate === "settling") return candidate;
        }
      } catch (error) {
        /* dokumentum nélkül „nem hero” a helyes válasz */
      }
      return null;
    }

    /** Melyik példány látszik ebben a fázisban. */
    function phaseServesView(heroVariant, phase) {
      return heroVariant === true ? phase === "hero" : phase !== "hero";
    }

    /** Az élő fázis, újraolvasva, amikor a keretrendszer jelzi a váltást. */
    function useConversationPhase() {
      var state = react.useState(readConversationPhase);
      var phase = state[0];
      var setPhase = state[1];
      react.useEffect(function () {
        try {
          var observer = new MutationObserver(function () { setPhase(readConversationPhase()); });
          observer.observe(document.body, { attributes: true, attributeFilter: ["data-phase"], subtree: true });
          setPhase(readConversationPhase());
          return function () { observer.disconnect(); };
        } catch (error) {
          return undefined;
        }
      }, []);
      return phase;
    }

    /**
     * A hero-gombsor befogadója a `dsh-ui-extras` CornerControls hero-példányában
     * (`[data-dsh-hero-actions]`). A `conversation.input.dock` függőleges lista,
     * ezért a költség gomb külön slot-bejegyzésként külön sorba került — a
     * felhasználó jelzése szerint „más helyre van bedobva, nem a gombsorba”.
     * A portál a MÁR LÉTEZŐ gombsorba rajzol, így marad egy sor.
     *
     * A befogadó a hero-példánnyal együtt jelenik meg/tűnik el, ezért 500 ms-onként
     * újraolvassuk; a kör a komponens unmountjakor leáll (korlátos, §1.7).
     */
    /** A hero-gombsor befogadójának keresése (`[data-dsh-hero-actions]`). */
    function readHeroActionsHost() {
      try {
        if (typeof document === "undefined") return null;
        return document.querySelector("[data-dsh-hero-actions]");
      } catch (error) {
        return null;
      }
    }

    function useHeroActionsHost(enabled) {
      var state = react.useState(function () { return enabled === true ? readHeroActionsHost() : null; });
      var host = state[0];
      var setHost = state[1];
      react.useEffect(function () {
        if (enabled !== true) { setHost(null); return undefined; }
        setHost(readHeroActionsHost());
        var timer = setInterval(function () {
          var next = readHeroActionsHost();
          setHost(function (previous) { return previous === next ? previous : next; });
        }, 500);
        return function () { clearInterval(timer); };
      }, [enabled]);
      return host;
    }

    /**
     * Pillanatkép-tár: a legutóbbi mérés azonnal látható, amíg az új lefut.
     *
     * MIÉRT (felhasználói visszajelzés, 2026-11-17): „minden megnyitásnál újra
     * generálja, várni kell” — a `sessionStorage`-ban tárolt utolsó eredmény
     * azonnal kirajzolódik, a friss mérés a háttérben fut, és felülírja.
     */
    var SNAPSHOT_PREFIX = "dsh-koltseg.snapshot.";

    /** 12 óránál régebbi pillanatképet nem használunk. */
    var SNAPSHOT_MAX_AGE = 12 * 3600000;

    function snapshotKey(parts) {
      return SNAPSHOT_PREFIX + parts.join("|");
    }

    /**
     * A folyamatvisszajelzés állapota — TISZTA függvény (tesztelhető).
     *
     * MIÉRT (2026-11-20, felhasználói jelzés: „ha átkapcsolok munkaterületre,
     * nem lehet tudni, hogy kiírta-e már az eredményt”): a mérés MÉRVE 0,4–0,6 s,
     * a kirajzolt számok viszont addig az ELŐZŐ kiválasztásból valók. A
     * `stale` akkor igaz, ha a mérés kulcsa (`measureState.key`) eltér a most
     * kiválasztott kulcstól — ilyenkor a felület elhalványítja a számokat és
     * kimondja, hogy újraszámol; `busy` pedig a repülő kérést jelzi.
     *
     * @param measureState `{status, data, key}`
     * @param requestedKey a MOSTANI kiválasztás kulcsa
     * @param busyAt a repülő kérés kezdete (0 = nincs)
     * @returns {{data: object|null, stale: boolean, busy: boolean, label: string}}
     */
    function measureFeedback(measureState, requestedKey, busyAt) {
      var state = measureState !== null && typeof measureState === "object" ? measureState : {};
      var status = typeof state.status === "string" ? state.status : "loading";
      var data = status === "ready" && state.data !== null && typeof state.data === "object" ? state.data : null;
      var shownKey = typeof state.key === "string" ? state.key : "";
      var stale = data !== null && shownKey.length > 0 && shownKey !== requestedKey;
      return {
        data: data,
        stale: stale,
        busy: toNumber(busyAt) > 0 || status === "loading",
        label: stale ? "recalculating" : "calculating"
      };
    }

    /** @returns {{at: number, data: object}|null} */
    function readSnapshot(key) {
      try {
        if (typeof sessionStorage === "undefined") return null;
        var raw = sessionStorage.getItem(key);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.at !== "number" || !parsed.data) return null;
        if (Date.now() - parsed.at > SNAPSHOT_MAX_AGE) return null;
        return parsed;
      } catch (error) {
        return null;
      }
    }

    function writeSnapshot(key, data) {
      try {
        if (typeof sessionStorage === "undefined" || !data) return;
        sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data: data }));
      } catch (error) {
        /* betelt tár vagy privát mód: a mérés attól még él */
      }
    }

    /** `HH:MM` egy időbélyegből (a pillanatkép korának kiírásához). */
    function fmtClock(ms) {
      var value = toNumber(ms);
      if (value <= 0) return "–";
      var date = new Date(value);
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }

    /** A „Frissítés” gomb egyszeri, gyorsítótár-megkerülő kérése. */
    var pendingFresh = false;

    // ─────────────────────────────────────────────────────── lebegő panel
    /**
     * A panel tartalma. Minden szám a hostról jön; a felület csak megjelenít,
     * illetve az óradíjat/profilt írja vissza.
     */
    function KoltsegPanel(props) {
      var safeProps = props !== null && typeof props === "object" ? props : {};
      var t = typeof safeProps.t === "function" ? safeProps.t : translator;
      var sessionId = typeof safeProps.sessionId === "string" ? safeProps.sessionId : "";
      var workspace = safeProps.workspace !== undefined ? safeProps.workspace : pickWorkspace(safeProps);

      var scopeState = react.useState("session");
      var scope = scopeState[0];
      var setScope = scopeState[1];

      var rangeState = react.useState(false);
      var useRange = rangeState[0];
      var setUseRange = rangeState[1];

      var fromState = react.useState(daysAgoText(29));
      var fromText = fromState[0];
      var setFromText = fromState[1];

      var toState = react.useState(todayText());
      var toText = toState[0];
      var setToText = toState[1];

      var profileState = react.useState("");
      var profileId = profileState[0];
      var setProfileId = profileState[1];

      var configState = react.useState({ status: "loading", data: null, error: "" });
      var configStatus = configState[0];
      var setConfigState = configState[1];

      var measureState = react.useState({ status: "loading", data: null, error: "", snapshotAt: 0, key: "", updatedAt: 0 });
      var measureStatus = measureState[0];
      var setMeasureState = measureState[1];

      /**
       * Folyamatban van-e éppen mérés (a `/koltseg/measure` kérés repül).
       *
       * MIÉRT (2026-11-20, felhasználói jelzés: „nincs folyamatjelző … ezért az
       * áfa check box is úgy tűnik, mintha nem működne”): a mérés a MEGLÉVŐ
       * adatot hagyta a képernyőn, csak a válasz megérkezésekor cserélte ki —
       * közben semmi nem jelezte, hogy dolgozik. Most a kérés indulásakor és
       * befejezésekor állítjuk, a felület pedig pörgő jelzőt rajzol.
       */
      var busyState = react.useState(0);
      var busyAt = busyState[0];
      var setBusyAt = busyState[1];

      var detailsState = react.useState(false);
      var showDetails = detailsState[0];
      var setShowDetails = detailsState[1];

      var rateState = react.useState({ value: "", dirty: false });
      var rate = rateState[0];
      var setRate = rateState[1];

      var flashState = react.useState("");
      var flash = flashState[0];
      var setFlash = flashState[1];

      /** Kézi újratöltés jelzője: az effect ezen is figyel (a „Frissítés” gomb). */
      var reloadState = react.useState(0);
      var reloadKey = reloadState[0];
      var setReloadKey = reloadState[1];

      var materialState = react.useState({ status: "off", usd: 0, error: "", gross: false, netUsd: null, tax: null, rates: FALLBACK_GROSS_RATES, factorSource: "" });
      var material = materialState[0];
      var setMaterial = materialState[1];

      // Konfiguráció betöltése. A munkaterületet a host oldja fel (a session
      // naplófejlécéből), ezért a session-azonosítót MINDIG elküldjük.
      react.useEffect(function () {
        var alive = true;
        var configParams = [];
        if (workspace.length > 0) configParams.push("workspace=" + encodeURIComponent(workspace));
        if (sessionId.length > 0) configParams.push("session=" + encodeURIComponent(sessionId));
        getJson(ROUTE + "/config" + (configParams.length > 0 ? "?" + configParams.join("&") : ""))
          .then(function (data) {
            if (!alive) return;
            if (data && data.ok === true) {
              setConfigState({ status: "ready", data: data, error: "" });
              var current = data.resolved && typeof data.resolved.rate === "number" ? data.resolved.rate : 0;
              setRate({ value: String(current), dirty: false });
            } else {
              setConfigState({ status: "error", data: null, error: (data && data.error) || "" });
            }
            return undefined;
          })
          .catch(function (error) {
            if (alive) setConfigState({ status: "error", data: null, error: String(error && error.message ? error.message : error) });
          });
        return function () { alive = false; };
      }, [workspace]);

      // Mérés betöltése (és 20 s-onként frissítés, amíg az ablak nyitva van).
      // A legutóbbi eredményt pillanatképből AZONNAL kirajzoljuk, utána jön a
      // friss mérés — így megnyitáskor nem kell várni (felhasználói kérés).
      react.useEffect(function () {
        var alive = true;
        var key = snapshotKey([scope, sessionId, workspace, useRange ? fromText + "~" + toText : "-", profileId]);
        var cached = readSnapshot(key);
        // A pillanatkép a MÁR kirajzolt adathoz tartozik: a `key` és a `cached`
        // jelzi, hogy a számok melyik beállításból valók (a felület ez alapján
        // mondja ki, hogy „ez még az előző beállítás”).
        if (cached !== null) setMeasureState({ status: "ready", data: cached.data, error: "", snapshotAt: cached.at, key: key, updatedAt: 0 });
        var busyStartedAt = 0;
        // `showBusy`: a KÉZI/újraindított mérés pörgőt kap; a 20 s-os háttér-
        // frissítés NEM villogtatja a jelzőt (az csak zaj lenne).
        function load(showBusy) {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          if (showBusy === true) {
            busyStartedAt = Date.now();
            setBusyAt(busyStartedAt);
          }
          var params = [];
          params.push("scope=" + encodeURIComponent(scope));
          if (scope === "session" && sessionId.length > 0) params.push("id=" + encodeURIComponent(sessionId));
          if (workspace.length > 0) params.push("workspace=" + encodeURIComponent(workspace));
          // A host a session naplófejlécéből oldja fel a munkaterületet.
          if (sessionId.length > 0) params.push("session=" + encodeURIComponent(sessionId));
          if (useRange) {
            params.push("from=" + encodeURIComponent(fromText));
            params.push("to=" + encodeURIComponent(toText));
          }
          if (profileId.length > 0) params.push("profile=" + encodeURIComponent(profileId));
          // A „Frissítés” gomb egyszer átugorja a host gyorsítótárát.
          if (pendingFresh) {
            params.push("fresh=1");
            pendingFresh = false;
          }
          // A mérés MÉRVE 0,4–0,6 s: a pörgőt ennyi ideig nem látni. Ezért a
          // jelzőt a válasz után is tartjuk egy rövid ideig (MIN_BUSY_MILLISECONDS),
          // hogy a felhasználó LÁSSA: „számolt, és megjött az eredmény”.
          function settle() {
            var elapsed = busyStartedAt === 0 ? MIN_BUSY_MILLISECONDS : Date.now() - busyStartedAt;
            var left = Math.max(0, MIN_BUSY_MILLISECONDS - elapsed);
            busyStartedAt = 0;
            if (left === 0) { setBusyAt(0); return; }
            setTimeout(function () { if (alive) setBusyAt(0); }, left);
          }
          getJson(ROUTE + "/measure?" + params.join("&"))
            .then(function (data) {
              if (!alive) return;
              settle();
              if (data && data.ok === true) {
                setMeasureState({ status: "ready", data: data, error: "", snapshotAt: 0, key: key, updatedAt: Date.now() });
                writeSnapshot(key, data);
              } else {
                setMeasureState({ status: "error", data: null, error: (data && data.error) || "", snapshotAt: 0, key: key, updatedAt: 0 });
              }
              return undefined;
            })
            .catch(function (error) {
              // Hiba esetén a pillanatkép MARAD (nem cseréljük hibaképernyőre).
              if (!alive) return;
              settle();
              var fallback = readSnapshot(key);
              if (fallback !== null) setMeasureState({ status: "ready", data: fallback.data, error: "", snapshotAt: fallback.at, key: key, updatedAt: 0 });
              else setMeasureState({ status: "error", data: null, error: String(error && error.message ? error.message : error), snapshotAt: 0, key: key, updatedAt: 0 });
            });
        }
        busyStartedAt = Date.now();
        setBusyAt(busyStartedAt);
        load(true);
        var timer = setInterval(function () { load(false); }, REFRESH_MILLISECONDS);
        return function () {
          alive = false;
          clearInterval(timer);
          // Leszállt kérés ne hagyjon örök pörgőt (a következő effect úgyis
          // újra beállítja, ha van mit mérni).
          setBusyAt(0);
        };
      }, [scope, sessionId, workspace, useRange, fromText, toText, profileId, reloadKey]);

      // Token/API önköltség (opcionális, külön sor) — a meglévő usage végpontból.
      react.useEffect(function () {
        var enabled = configStatus.status === "ready" && configStatus.data && configStatus.data.config && configStatus.data.config.materialCost === true;
        if (!enabled) {
          setMaterial({ status: "off", usd: 0, error: "" });
          return undefined;
        }
        var alive = true;
        var days = useRange ? 60 : 30;
        // MUNKATERÜLET-SZŰRÉS (2026-11-17, mért hiba): enélkül a token-sor a
        // TELJES deployment 30 napos költségét mutatta a kiválasztott
        // munkaterület helyett (mért: 2 session / $0.62 helyett $133.76).
        var url = "/ui-extras/usage?days=" + String(days)
          + (scope === "session" && sessionId.length > 0 ? "&session=" + encodeURIComponent(sessionId) : "")
          + (workspace.length > 0 ? "&workspace=" + encodeURIComponent(workspace) : "");
        // BETÖLTŐ ÁLLAPOT (2026-11-18, mért hiba: „a token költség eltűnt”):
        // a sor eddig a kérés TELJES ideje alatt „nem érhető el”-t írt, mert nem
        // volt loading állapot. A hideg usage-szkennelés (~1300 session-napló
        // zstd-kibontása) MÉRVE ~58 s, tehát a panel első kb. egy perce mindig
        // ezt a hibaszöveget mutatta. Most a várakozás alatt „mérés folyamatban”
        // áll ott, és csak a valódi hiba után lesz „nem érhető el”.
        //
        // ÚJRAPRÓBÁLKOZÁS kötött (§1.7): legfeljebb 3 próba, 5 s / 15 s
        // várakozással; a várakozás alatt is loading állapot látszik.
        var attempts = 0;
        var maxAttempts = 3;
        var retryDelays = [5000, 15000];

        setMaterial({ status: "loading", usd: 0, error: "" });

        function loadMaterial() {
          attempts += 1;
          getJson(url)
            .then(function (data) {
              if (!alive) return;
              if (!data || data.ok !== true) {
                if (attempts < maxAttempts) {
                  setTimeout(function () { if (alive) loadMaterial(); }, retryDelays[attempts - 1] || 15000);
                  return;
                }
                setMaterial({ status: "unavailable", usd: 0, error: (data && data.error) || "" });
                return;
              }
              // A session-hatókör a saját session számát használja, a
              // munkaterület-hatókör a (szűrt) összesítést.
              var stats = scope === "session" && data.session ? data.session : data.totals;
              var netUsd = stats && typeof stats.costUsd === "number" ? stats.costUsd : 0;
              // ── BRUTTÓ (fizetendő) ár — a panel MAGA számolja (2026-11-20) ──
              // MIÉRT: a host-oldali áfázás csak a következő harness-indításnál
              // él, a panelnek viszont MOST kell a valós árat mutatnia. Ezért a
              // szorzót a válasz MODELL-BONTÁSÁBÓL (`perModel`) alkalmazzuk:
              // modellenként pontosan ugyanaz, mint a host `grossFamily`-je.
              // Ha a host már a bruttót adja (`pricing.gross.basis = "gross"`),
              // NEM szorzunk (az kétszeres áfa lenne).
              var rates = grossRatesOf(data);
              var hostGross = isHostGross(data);
              var grossInfo = hostGross ? { factor: 1, source: "host" } : grossFactorOf(data, rates);
              var factor = grossInfo.factor;
              var usd = hostGross ? netUsd : netUsd * factor;
              var netShown = hostGross
                ? (stats && typeof stats.netCostUsd === "number" ? stats.netCostUsd : netUsd / rates.dsh)
                : netUsd;
              // A cache-kedvezmény két összege ugyanabban a pénzben legyen.
              var hostCache = data.cache && typeof data.cache === "object" ? data.cache : null;
              var cache = hostCache === null ? null : (hostGross ? hostCache : {
                ...hostCache,
                hitCostUsd: toNumber(hostCache.hitCostUsd) * factor,
                baselineUsd: toNumber(hostCache.baselineUsd) * factor,
                savedUsd: toNumber(hostCache.savedUsd) * factor,
              });
              setMaterial({
                status: "ready",
                usd,
                error: "",
                gross: true,
                rates,
                netUsd: netShown,
                tax: data.pricing && data.pricing.gross ? data.pricing.gross : null,
                // A szorzó forrása: a bontásból pontos (`model`), különben becsült.
                factorSource: grossInfo.source,
                requests: stats && typeof stats.requests === "number" ? stats.requests : 0,
                missTokens: stats && typeof stats.miss === "number" ? stats.miss : 0,
                hitTokens: stats && typeof stats.hit === "number" ? stats.hit : 0,
                outTokens: stats && typeof stats.out === "number" ? stats.out : 0,
                // A cache-kedvezmény tényleges hatása (a host számolja).
                cache,
                scoped: typeof data.workspace === "string" && data.workspace.length > 0,
              });
              return undefined;
            })
            .catch(function () {
              if (!alive) return;
              if (attempts < maxAttempts) {
                setTimeout(function () { if (alive) loadMaterial(); }, retryDelays[attempts - 1] || 15000);
                return;
              }
              setMaterial({ status: "unavailable", usd: 0, error: "" });
            });
        }

        loadMaterial();
        return function () { alive = false; };
      }, [configStatus.status, configStatus.data, scope, sessionId, useRange, workspace]);

      var config = configStatus.status === "ready" && configStatus.data ? configStatus.data : null;
      var profiles = config && Array.isArray(config.profiles) ? config.profiles : [];
      /**
       * A KIVÁLASZTÁS kulcsa, és hogy a kirajzolt számok EHHEZ tartoznak-e.
       *
       * MIÉRT (2026-11-20, felhasználói jelzés: „ha átkapcsolok munkaterületre,
       * nem lehet tudni, hogy kiírta-e már az eredményt”): a mérés 0,4–0,6 s, a
       * számok viszont addig az ELŐZŐ beállításból valók — eddig ugyanúgy
       * néztek ki, mintha készen lennének. Most `stale` jelzi, a blokk
       * elhalványul, a felette lévő sor pedig kimondja, hogy újraszámol.
       */
      var requestedKey = snapshotKey([scope, sessionId, workspace, useRange ? fromText + "~" + toText : "-", profileId]);
      var feedback = measureFeedback(measureStatus, requestedKey, busyAt);
      var data = feedback.data;
      var stale = feedback.stale;
      var vatPercent = data ? toNumber(data.vatPercent) : 0;
      var vatAvailable = config && config.config ? toNumber(config.config.vatPercent) : 27;
      var materialOn = config && config.config ? config.config.materialCost === true : false;
      /**
       * Az ÁFA-kapcsoló állapota a KONFIGURÁCIÓBÓL (nem a mérés eredményéből).
       *
       * MIÉRT (2026-11-20, felhasználói jelzés: „az áfa check box … úgy tűnik,
       * mintha nem működne”): a pipa eddig a mérés `vatPercent` mezőjéhez volt
       * kötve, ami csak a (másodpercekkel később megérkező) új mérésben változik
       * meg. Most a kattintás AZONNAL látszik (a konfiguráció mentése gyors), a
       * hosszabb újraszámolást pedig a pörgő jelző mutatja.
       */
      var vatOn = config && config.config ? config.config.vatEnabled === true : (data !== null && vatPercent > 0);

      function saveRate() {
        var value = toNumber(rate.value);
        if (!(value > 0)) {
          setFlash(t("status.measureError", { error: "0" }));
          return;
        }
        var base = config && config.config ? config.config : {};
        var workspaces = base.workspaces && typeof base.workspaces === "object" ? { ...base.workspaces } : {};
        if (workspace.length > 0) {
          workspaces[workspace] = { ...(workspaces[workspace] || {}), rate: value };
        } else {
          base.defaultRate = value;
        }
        postJson(ROUTE + "/config", { ...base, workspaces })
          .then(function (saved) {
            if (saved && saved.ok === true) {
              var nextData = config !== null ? { ...config } : { status: "ready", error: "", path: "" };
              nextData.config = saved.config;
              nextData.profiles = saved.profiles;
              nextData.resolved = { ...(config && config.resolved ? config.resolved : {}), rate: value };
              setConfigState({ status: "ready", data: nextData, error: "" });
              setRate({ value: String(value), dirty: false });
              setFlash(t("rate.saved"));
              setReloadKey(reloadKey + 1);
              return;
            }
            setFlash(t("status.measureError", { error: (saved && saved.error) || "?" }));
            return undefined;
          })
          .catch(function (error) {
            setFlash(t("conn.error", { error: String(error && error.message ? error.message : error) }));
          });
      }

      function toggleOption(key) {
        var base = config && config.config ? config.config : null;
        if (base === null) return;
        var next = { ...base, [key]: !(base[key] === true) };
        postJson(ROUTE + "/config", next)
          .then(function (saved) {
            if (saved && saved.ok === true) {
              var nextData = config !== null ? { ...config } : { status: "ready", error: "", path: "" };
              nextData.config = saved.config;
              nextData.profiles = saved.profiles;
              setConfigState({ status: "ready", data: nextData, error: "" });
              setReloadKey(reloadKey + 1);
              return;
            }
            return undefined;
          })
          .catch(function () { /* a kapcsoló ilyenkor nem változik */ });
      }

      function chooseProfile(nextId) {
        setProfileId(nextId === profileId ? "" : nextId);
      }

      function freeze() {
        if (data === null) return;
        postJson(ROUTE + "/ledger", {
          scope: data.scope,
          workspace: data.workspace,
          workspaceLabel: data.workspaceLabel,
          from: data.from,
          to: data.to,
          fromDay: data.fromDay,
          toDay: data.toDay,
          profileId: data.profile.id,
          profileName: data.profile.name,
          rate: data.rate,
          minutes: data.minutes,
          net: data.amount.net,
          vat: data.amount.vat,
          gross: data.amount.gross,
          vatPercent: data.vatPercent,
          sessions: data.sessions.length,
          turns: data.sessions.reduce(function (sum, entry) { return sum + (entry.turns || 0); }, 0),
        })
          .then(function (saved) {
            if (saved && saved.ok === true) setFlash(t("actions.frozen"));
            else setFlash(t("status.measureError", { error: (saved && saved.error) || "?" }));
            return undefined;
          })
          .catch(function (error) {
            setFlash(t("conn.error", { error: String(error && error.message ? error.message : error) }));
          });
      }

      function csvHref() {
        var params = ["scope=" + encodeURIComponent(scope), "format=csv"];
        if (scope === "session" && sessionId.length > 0) params.push("id=" + encodeURIComponent(sessionId));
        if (workspace.length > 0) params.push("workspace=" + encodeURIComponent(workspace));
        if (sessionId.length > 0) params.push("session=" + encodeURIComponent(sessionId));
        if (useRange) {
          params.push("from=" + encodeURIComponent(fromText));
          params.push("to=" + encodeURIComponent(toText));
        }
        if (profileId.length > 0) params.push("profile=" + encodeURIComponent(profileId));
        return ROUTE + "/export?" + params.join("&");
      }

      var componentRows = data === null ? [] : [
        { key: "agent", label: t("components.agent"), ms: data.components.agentMs, weight: data.profile.weights.agent, value: data.contributions.agent },
        { key: "jobs", label: t("components.jobs"), ms: data.components.jobsMs, weight: data.profile.weights.jobs, value: data.contributions.jobs },
        { key: "humanRead", label: t("components.humanRead"), ms: data.components.readMs, weight: data.profile.weights.humanRead, value: data.contributions.humanRead },
        { key: "humanType", label: t("components.humanType"), ms: data.components.typeMs, weight: data.profile.weights.humanType, value: data.contributions.humanType, hint: toNumber(data.components.typeEstimatedMs) > 0 ? t("components.humanType.estimated") : "" },
        { key: "wall", label: t("components.wall"), ms: data.components.wallMs, weight: data.profile.weights.wall, value: data.contributions.wall },
      ];

      var scopeButtons = [
        { key: "session", label: t("scope.session") },
        { key: "workspace", label: t("scope.workspace") },
      ];

      var body = [];

      /** Pörgő jelző (a folyamatjelzéshez) — a színt a téma adja. */
      function spinner() {
        return h("span", { style: S.spin, "aria-hidden": "true", title: t("status.calculating") });
      }

      // hatókör
      body.push(h("div", { key: "scope", style: S.row },
        scopeButtons.map(function (entry) {
          return h("button", {
            key: entry.key,
            type: "button",
            style: scope === entry.key ? S.chipActive : S.chip,
            onClick: function () { setScope(entry.key); },
          }, entry.label);
        }),
        h("button", {
          key: "range",
          type: "button",
          style: useRange ? S.chipActive : S.chip,
          title: t("scope.range"),
          onClick: function () { setUseRange(!useRange); },
        }, t("scope.range")),
      ));

      // időszak
      if (useRange) {
        body.push(h("div", { key: "range", style: { ...S.row, marginTop: "6px" } },
          h("span", { style: S.label }, t("scope.range.from")),
          h("input", {
            type: "date",
            style: S.input,
            value: fromText,
            onChange: function (event) { setFromText(event.target.value); },
          }),
          h("span", { style: S.label }, t("scope.range.to")),
          h("input", {
            type: "date",
            style: S.input,
            value: toText,
            onChange: function (event) { setToText(event.target.value); },
          }),
          h("button", {
            type: "button",
            style: S.chip,
            onClick: function () {
              setFromText(daysAgoText(29));
              setToText(todayText());
            },
          }, t("scope.range.last30")),
        ));
      }

      // óradíj + profil
      body.push(h("div", { key: "rate", style: { ...S.row, marginTop: "8px" } },
        h("span", { style: S.label }, t("rate.label")),
        // `type="text"` ezres tagolással: a `type="number"` nem enged szóközt,
        // a felhasználó viszont `12 500` alakban kérte (2026-11-17).
        h("input", {
          type: "text",
          inputMode: "numeric",
          style: { ...S.input, width: "104px", textAlign: "right", fontVariantNumeric: "tabular-nums" },
          value: groupDigits(rate.value),
          onChange: function (event) { setRate({ value: digitsOnly(event.target.value), dirty: true }); },
        }),
        h("span", { style: S.label }, t("rate.unit")),
        h("button", { type: "button", style: S.chip, onClick: saveRate }, t("rate.save")),
        data !== null
          ? h("span", { style: S.label }, "· " + (data.rateSource === "workspace" ? t("rate.source.workspace") : t("rate.source.global")))
          : null,
      ));

      body.push(h("div", { key: "profile", style: { ...S.row, marginTop: "6px" } },
        h("span", { style: S.label }, t("profile.label")),
        h("select", {
          style: S.select,
          value: profileId,
          onChange: function (event) { chooseProfile(event.target.value); },
        },
          h("option", { value: "", style: S.option }, data !== null ? data.profile.name : "–"),
          profiles.map(function (entry) {
            return h("option", { key: entry.id, value: entry.id, style: S.option }, entry.name);
          }),
        ),
        data !== null
          ? h("span", { style: S.label }, "· " + (
              data.profileSource === "request" ? t("profile.source.request")
                : data.profileSource === "workspace" ? t("profile.source.workspace")
                  : t("profile.source.global")))
          : null,
      ));

      // állapot / folyamatjelző / hiba
      // A mérés közben MINDIG látszik a pörgő jelző (akkor is, ha a korábbi
      // eredmény még a képernyőn van) — enélkül a panel „lefagyottnak” tűnt.
      if (feedback.busy) {
        body.push(h("div", { key: "loading", style: S.busy },
          spinner(),
          h("span", { style: stale ? { fontWeight: 600 } : null },
            stale ? t("status.recalculating") : t("status.calculating"))));
      }
      if (measureStatus.status === "error") {
        var message = measureStatus.error || "";
        var oldHost = message.length === 0 || /404|Not Found|manifest|Cannot GET/iu.test(message);
        body.push(h("div", { key: "error", style: { ...S.error, marginTop: "8px" } },
          oldHost ? t("status.oldHost") : t("status.measureError", { error: message })));
      }

      // komponensek
      if (data !== null) {
        // A SZÁMOK blokkja: amíg az új beállítás mérése fut, elhalványul, hogy
        // ne tűnjön késznek (a `stale` a kiválasztás kulcsából jön).
        var resultParts = [];
        resultParts.push(h("div", { key: "components", style: S.section },
          h("div", { style: { ...S.between, marginBottom: "4px" } },
            h("strong", { style: { fontSize: "12px", fontWeight: 600 } }, t("components.head")),
            h("span", { style: S.label }, data.profile.name),
          ),
          h("table", { style: S.table },
            h("tbody", null,
              componentRows.map(function (row) {
                var counted = row.weight > 0;
                return h("tr", { key: row.key },
                  h("td", { style: S.td },
                    h("div", null, row.label),
                    h("div", { style: S.note },
                      "×" + String(row.weight).replace(".", ",") + " · " +
                      (counted ? t("components.counted") : t("components.notCounted")) +
                      (row.hint ? " · " + row.hint : "")),
                  ),
                  h("td", { style: S.tdNum }, fmtMinutes(row.ms) + " p"),
                  h("td", { style: S.tdNum, opacity: counted ? 1 : 0.45 }, fmtMinutes(row.value) + " p"),
                );
              }),
            ),
          ),
          data.components.agentMs === 0 && data.components.readMs === 0 && data.components.typeMs === 0
            ? h("div", { style: S.note }, t("components.empty"))
            : null,
        ));

        // végösszeg
        resultParts.push(h("div", { key: "total", style: S.total },
          h("div", { style: S.between },
            h("span", { style: S.label }, t("total.billable")),
            h("span", null, fmtMinutes(data.billableMs) + " p · " + t("unit.hour", { hours: fmtHours(data.billableMs) })),
          ),
          h("div", { style: { ...S.between, marginTop: "2px" } },
            h("span", { style: S.big }, fmtHuf(data.amount.net)),
            h("span", { style: S.label }, t("total.net")),
          ),
          data.vatPercent > 0
            ? h("div", null,
              h("div", { style: S.between },
                h("span", { style: S.label }, t("total.vat", { percent: String(data.vatPercent).replace(".", ",") })),
                h("span", null, fmtHuf(data.amount.vat)),
              ),
              h("div", { style: S.between },
                h("span", { style: S.label }, t("total.gross")),
                h("span", { style: { fontWeight: 600 } }, fmtHuf(data.amount.gross)),
              ),
            )
            : null,
          h("div", { style: S.note },
            t("note.range", { from: data.fromDay, to: data.toDay }) + " · " + t("source." + (data.humanSource || "none"))),
          data.workspaceLabel ? h("div", { style: S.note }, t("note.workspace", { workspace: data.workspaceLabel })) : null,
          // MIKOR készült a szám: pillanatképből (`snapshotAt`) vagy friss
          // válaszból (`updatedAt`). „Kiírta-e már az eredményt?” — ez mondja meg.
          stale
            ? h("div", { style: { ...S.note, fontWeight: 600 } },
              t("status.stale", {
                at: fmtClock(measureStatus.updatedAt > 0 ? measureStatus.updatedAt : measureStatus.snapshotAt)
              }))
            : measureStatus.snapshotAt > 0
              ? h("div", { style: S.note }, t("status.snapshot", { at: fmtClock(measureStatus.snapshotAt) }))
              : measureStatus.updatedAt > 0
                ? h("div", { style: S.note }, t("status.updated", { at: fmtClock(measureStatus.updatedAt) }))
                : null,
        ));
        body.push(h("div", { key: "result", style: stale ? S.resultStale : S.result }, resultParts));

        // opciók
        body.push(h("div", { key: "options", style: { ...S.row, marginTop: "8px" } },
          h("label", { style: { ...S.row, gap: "4px", cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: vatOn,
              disabled: config === null,
              onChange: function () { toggleOption("vatEnabled"); },
            }),
            h("span", { style: S.label }, t("options.vat", { percent: String(vatAvailable).replace(".", ",") })),
            // Az újraszámolás alatt a kapcsoló mellett is látszik, hogy dolgozik.
            busyAt > 0 ? spinner() : null,
          ),
          h("label", { style: { ...S.row, gap: "4px", cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: materialOn,
              onChange: function () { toggleOption("materialCost"); },
            }),
            h("span", { style: S.label }, t("options.material")),
          ),
        ));
        if (materialOn) {
          body.push(h("div", { key: "material", style: { ...S.note, display: "flex", alignItems: "center", gap: "6px" } },
            h("span", null,
              material.status === "ready"
                // A felirat KIMONDJA, hogy a szám BRUTTÓ (fizetendő). A szorzást a
                // panel végzi a modell-bontásból, ezért ez akkor is igaz, ha a host
                // fél még a régi, nettó összeget ad (lásd grossFactorOf).
                ? t("options.material.usd", { usd: fmtUsd(material.usd) })
                // A várakozás alatt (hideg szkennelés) NEM hiba, hanem mérés.
                : material.status === "unavailable"
                  ? t("options.material.unavailable")
                  : t("options.material.loading")),
            // PÖRGŐ JELZŐ (2026-11-20, felhasználói jelzés: „nincs
            // folyamatjelző, ezért úgy tűnik, mintha nem működne”).
            material.status === "loading" ? spinner() : null));
          // Bruttó bontás: nettó listaár + áfa (+ DSH-pótdíj) — így a szám
          // ellenőrizhető, és látszik, hogy az összeg NEM nettó.
          if (material.status === "ready" && toNumber(material.netUsd) > 0) {
            var shownRates = material.rates && typeof material.rates === "object" ? material.rates : FALLBACK_GROSS_RATES;
            body.push(h("div", { key: "material-gross", style: S.note },
              t("options.material.gross", {
                net: fmtUsd(material.netUsd),
                vat: String(toNumber(shownRates.vat)),
                dsh: String(toNumber(shownRates.surcharge)),
                dshRate: String(toNumber(shownRates.dsh)).replace(".", ","),
                othersRate: String(toNumber(shownRates.alibaba)).replace(".", ","),
              })));
          }
          // A cache-kedvezmény KIMONDVA (2026-11-17, felhasználói észrevétel:
          // „a 98% cache kedvezményt nem vonja le”). A kedvezmény érvényesül,
          // de eddig nem lehetett ellenőrizni — most a cache-elt bemenet, a
          // százalék és a tényleges megtakarítás is látszik.
          if (material.status === "ready" && material.cache && toNumber(material.hitTokens) > 0) {
            var inputTokens = toNumber(material.missTokens) + toNumber(material.hitTokens);
            var hitPercent = inputTokens > 0 ? Math.round((toNumber(material.hitTokens) / inputTokens) * 100) : 0;
            body.push(h("div", { key: "material-cache", style: S.note },
              t("options.material.cache", {
                hit: fmtTokens(material.hitTokens),
                percent: String(hitPercent),
                discount: String(toNumber(material.cache.discountPercent)),
                out: fmtTokens(material.outTokens),
                requests: String(toNumber(material.requests)),
              })));
            if (toNumber(material.cache.baselineUsd) > 0) {
              body.push(h("div", { key: "material-cache-saved", style: S.note },
                t("options.material.cache.saved", {
                  baseline: fmtUsd(material.cache.baselineUsd),
                  saved: fmtUsd(material.cache.savedUsd),
                })));
            }
          }
          if (material.status === "ready" && material.scoped === true) {
            body.push(h("div", { key: "material-scope", style: S.note }, t("options.material.scope")));
          }
          body.push(h("div", { key: "material-note", style: S.note }, t("options.material.note")));
        }

        // megjegyzések
        var notes = Array.isArray(data.notes) ? data.notes : [];
        if (notes.length > 0) {
          body.push(h("div", { key: "notes", style: S.section },
            notes.map(function (note, index) {
              return h("div", { key: "n" + String(index), style: S.note }, "· " + note);
            }),
          ));
        }

        // részletek
        body.push(h("div", { key: "details-toggle", style: { ...S.row, marginTop: "8px" } },
          h("button", {
            type: "button",
            style: S.chip,
            onClick: function () { setShowDetails(!showDetails); },
          }, showDetails ? t("details.hide") : t("details.show")),
          h("button", { type: "button", style: S.chip, onClick: freeze }, t("actions.freeze")),
          h("a", { href: csvHref(), style: { ...S.chip, textDecoration: "none", display: "inline-block" } }, t("actions.csv")),
          h("button", {
            type: "button",
            style: S.chip,
            onClick: function () {
              setFlash("");
              pendingFresh = true;
              setReloadKey(reloadKey + 1);
            },
          }, t("actions.refresh")),
        ));

        if (showDetails) {
          if (data.scope === "session" && Array.isArray(data.turns) && data.turns.length > 0) {
            body.push(h("table", { key: "turns", style: { ...S.table, marginTop: "6px" } },
              h("thead", null, h("tr", null,
                h("th", { style: S.th }, t("details.turn")),
                h("th", { style: S.th }, t("details.start")),
                h("th", { style: { ...S.th, textAlign: "right" } }, t("details.agent")),
                h("th", { style: { ...S.th, textAlign: "right" } }, t("details.read")),
                h("th", { style: { ...S.th, textAlign: "right" } }, t("details.type")),
              )),
              h("tbody", null,
                data.turns.map(function (row) {
                  return h("tr", { key: "t" + String(row.turn) },
                    h("td", { style: S.td }, String(row.turn) + (row.open ? " ·" : "")),
                    h("td", { style: S.td }, fmtStamp(row.start)),
                    h("td", { style: S.tdNum }, fmtMinutes(row.agentMs)),
                    h("td", { style: S.tdNum }, row.humanSource === "edge" ? "–" : fmtMinutes(row.readMs)),
                    h("td", { style: S.tdNum }, row.humanSource === "edge" ? "–" : (fmtMinutes(row.typeMs) + (row.estimated ? "\u00A0*" : ""))),
                  );
                }),
              ),
            ));
          } else if (Array.isArray(data.sessions) && data.sessions.length > 0) {
            body.push(h("table", { key: "sessions", style: { ...S.table, marginTop: "6px" } },
              h("thead", null, h("tr", null,
                h("th", { style: S.th }, t("session.list")),
                h("th", { style: S.th }, t("details.turn")),
                h("th", { style: { ...S.th, textAlign: "right" } }, t("details.agent")),
                h("th", { style: { ...S.th, textAlign: "right" } }, t("details.read")),
                h("th", { style: { ...S.th, textAlign: "right" } }, t("details.type")),
              )),
              h("tbody", null,
                data.sessions.map(function (row) {
                  return h("tr", { key: row.id },
                    h("td", { style: S.td, title: row.id }, row.label + (row.openTurns > 0 ? " ·" : "")),
                    h("td", { style: S.td }, String(row.turns)),
                    h("td", { style: S.tdNum }, fmtMinutes(row.agentMs)),
                    h("td", { style: S.tdNum }, fmtMinutes(row.readMs)),
                    h("td", { style: S.tdNum }, fmtMinutes(row.typeMs)),
                  );
                }),
              ),
            ));
          } else {
            body.push(h("div", { key: "nodetails", style: { ...S.note, marginTop: "6px" } }, t("details.none")));
          }
        }

        body.push(h("div", { key: "activity", style: S.note },
          t("note.activity", { count: String(data.activity && data.activity.records ? data.activity.records : 0) })));
      }

      if (scope === "session" && sessionId.length === 0) {
        body.unshift(h("div", { key: "nosession", style: { ...S.note, marginBottom: "6px" } }, t("session.none")));
      }
      if (flash.length > 0) {
        body.push(h("div", { key: "flash", style: { ...S.note, marginTop: "6px" } }, flash));
      }
      if (configStatus.status === "error" && configStatus.error.length > 0) {
        body.push(h("div", { key: "cfgerr", style: { ...S.error, marginTop: "6px" } },
          t("status.measureError", { error: configStatus.error })));
      }

      // A KLIENS build-je és a HOST-on futó motor jelzése. Ha a host régi, a
      // felhasználó lássa, hogy a számok miért nem frissültek (2026-11-17).
      var hostBuild = data !== null && typeof data.engine === "string" ? data.engine : "";
      var hostStale = hostBuild.length === 0 || hostBuild !== BUILD;
      var hostLabel = hostBuild.length > 0 ? t("panel.hostOk", { build: hostBuild }) : t("panel.hostUnknown");

      return h("div", null,
        // A pörgő jelző kulcskockái (a panel csak inline stílust használ, ezért
        // a `@keyframes` itt, egyszer jelenik meg a panel gyökerében).
        h("style", { key: "spin-kf" }, "@keyframes dsh-koltseg-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"),
        h("div", { style: S.panelHead },
          h("span", null, t("panel.title")),
          h("div", { style: { ...S.row, gap: "4px" } },
            h("span", { style: S.label }, "v" + BUILD),
            h("span", {
              style: hostStale ? { ...S.label, color: "#ffb86b", cursor: "help" } : S.label,
              title: hostStale ? t("panel.hostStale", { build: BUILD }) : hostLabel,
            }, hostLabel),
            safeProps.onClose
              ? h("button", {
                type: "button",
                style: { ...S.button, width: "22px", height: "22px", padding: "0" },
                title: t("panel.close"),
                onClick: function () { safeProps.onClose(); },
              }, "✕")
              : null,
          ),
        ),
        h("div", { style: { ...S.panelBody, maxHeight: "min(68vh, 620px)" } }, body),
      );
    }

    // ───────────────────────────────────────────────── fejléc-ikon + ablak
    /**
     * A menüsor ikonja. Kattintásra LEBEGŐ ABLAKOT nyit (nem oldalsáv-fület):
     * a panel a `document.body`-ba portol, `position: fixed`-fel, a gomb alá
     * igazítva, ESC-csel és a panelen kívüli kattintással zárva.
     */
    /** Egyszeri „ez a példány renderelt” jelzés (diagnosztika). */
    var renderedVariants = {};

    /**
     * A gomb egy seatje. A `variant` NEM propból jön: a regisztrációkor kötjük.
     *
     * MIÉRT: mért hiba (2026-11-17) — a `inject`-tel átadott props-mal
     * regisztrált gomb komponense SOHA nem hívódott meg (`dom proba: seats=0`,
     * `render belépett` nélkül), miközben az UGYANABBAN a slotban, üres
     * `inject`-tel regisztrált aktivitás-mérő futott. Ezért a gomb is üres
     * `inject`-tel megy, a `variant`-ot és a fordítót a modul adja.
     */
    function makeSeat(variant) {
      return function KoltsegSeat(props) {
        var safeProps = props !== null && typeof props === "object" ? props : {};
        var t = typeof safeProps.t === "function" ? safeProps.t : translator;
        try {
          if (renderedVariants[variant] !== true) {
            renderedVariants[variant] = true;
            reportEvent("render belépett: variant=" + variant + " build=" + BUILD + " propskulcsok=" + Object.keys(safeProps).join("|"));
          }
        } catch (error) {
          /* diagnosztika */
        }
        try {
          return renderKoltsegButton(safeProps, t, variant);
        } catch (error) {
          reportEvent("render HIBA variant=" + variant + ": " + String(error && error.message ? error.message : error));
          return null;
        }
      };
    }

    var HeaderSeat = makeSeat("header");
    var HeroSeat = makeSeat("hero");
    var DockSeat = makeSeat("dock");

    /** A teszt és a régi hívók felé megmaradó név (variant propból). */
    function KoltsegButton(props) {
      var safeProps = props !== null && typeof props === "object" ? props : {};
      var variant = typeof safeProps.variant === "string" ? safeProps.variant : "header";
      if (variant === "hero") return HeroSeat(safeProps);
      if (variant === "dock") return DockSeat(safeProps);
      return HeaderSeat(safeProps);
    }

    function renderKoltsegButton(safeProps, t, variant) {
      var heroVariant = variant === "hero";
      var withLabel = variant === "dock";
      var phase = useConversationPhase();
      // A hero-példány a `dsh-ui-extras` gombsorába portol; a fejléc-példány a
      // helyén marad (ott nincs is befogadó).
      var heroHost = useHeroActionsHost(heroVariant);
      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var buttonRef = react.useRef(null);
      var panelRef = react.useRef(null);
      var positionState = react.useState({ top: 56, right: 12 });
      var position = positionState[0];
      var setPosition = positionState[1];

      // Egyszeri diagnosztika: mountolt-e, és mekkora a gomb doboza (a
      // láthatatlan gomb leggyakoribb oka a szülő levágása/overflow-ja).
      react.useEffect(function () {
        try {
          var measure = function () {
            var rect = null;
            try {
              rect = buttonRef.current !== null && buttonRef.current !== undefined && typeof buttonRef.current.getBoundingClientRect === "function"
                ? buttonRef.current.getBoundingClientRect()
                : null;
            } catch (error) {
              rect = null;
            }
            var box = rect === null
              ? "nincs-doboz"
              : Math.round(rect.left) + "," + Math.round(rect.top) + " " + Math.round(rect.width) + "x" + Math.round(rect.height);
            reportEvent("mount variant=" + variant + " phase=" + String(phase) + " box=" + box + " vw=" + (typeof window !== "undefined" ? window.innerWidth : "?"));
          };
          if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(measure);
          else measure();
        } catch (error) {
          reportEvent("mount hiba: " + String(error && error.message ? error.message : error));
        }
      }, [variant]);

      function place() {
        try {
          var node = buttonRef.current;
          if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return;
          var rect = node.getBoundingClientRect();
          var vh = typeof window !== "undefined" ? window.innerHeight : 800;
          var vw = typeof window !== "undefined" ? window.innerWidth : 1280;
          var top = Math.round(rect.bottom + 8);
          var maxTop = Math.max(24, vh - 200);
          setPosition({ top: Math.min(top, maxTop), right: Math.max(12, Math.round(vw - rect.right)) });
        } catch (error) {
          /* marad az alaphelyzet */
        }
      }

      react.useEffect(function () {
        if (!open) return undefined;
        place();
        function onPointerDown(event) {
          try {
            var path = typeof event.composedPath === "function" ? event.composedPath() : [];
            for (var i = 0; i < path.length; i += 1) {
              if (path[i] === panelRef.current || path[i] === buttonRef.current) return;
            }
          } catch (error) {
            /* ha nincs composedPath, a láthatóság dönt */
          }
          setOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === "Escape" || event.key === "Esc") setOpen(false);
        }
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return function () {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [open]);

      // A fázis dönti el, melyik példány látszik (a fejléc a `hero` fázisban
      // rejtve van, ezért ott a `conversation.input.dock` példánya jelenik meg).
      if (!phaseServesView(heroVariant, phase)) return null;

      var button = h("button", {
        ref: buttonRef,
        type: "button",
        title: t("header.title"),
        "aria-label": t("tab.title"),
        "aria-expanded": open ? "true" : "false",
        "data-koltseg-seat": variant,
        style: S.headerBtn,
        onClick: function () { setOpen(!open); },
      },
        // HUF-jel egy érmében: a felirat a tooltipben van (a többi gombhoz hasonlóan).
        // A `dock` seaten rövid felirat is van, mert ott van hely — így akkor is
        // megtalálható, ha a fejléc-sor szűk.
        h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", style: { flex: "none" } },
          h("circle", { cx: 8, cy: 8, r: 6.2, stroke: "currentColor", strokeWidth: 1.5 }),
          h("path", { d: "M5.6 5.4h3.2M5.6 7.1h3.2M5.6 5.4c1.9 0 3 .5 3 1.6s-1.1 1.6-3 1.6", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
          h("path", { d: "M6.9 8.7v3.1M8.4 8.7v3.1", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
        ),
        withLabel ? h("span", { style: { whiteSpace: "nowrap" } }, t("tab.title")) : null,
      );

      // Csak a GOMB megy a hero-portálba; a panel a `document.body`-ba kerül
      // (position: fixed), tehát a gombsor nem mozdítja el.
      var shownButton = button;
      if (heroVariant && heroHost !== null && heroHost !== undefined && reactDom !== null && typeof reactDom.createPortal === "function") {
        shownButton = reactDom.createPortal(
          h("span", { style: { display: "inline-flex", alignItems: "center", order: 5 } }, button),
          heroHost,
        );
      }

      if (!open) return shownButton;

      var panel = h("div", {
        ref: panelRef,
        style: {
          ...S.panel,
          top: String(position.top) + "px",
          right: String(position.right) + "px",
        },
        role: "dialog",
        "aria-label": t("panel.title"),
      },
        // Hiba-határ: ha a panel renderelése elszáll, a felhasználó SZÖVEGET lát
        // (a láthatatlan hiba a legrosszabb diagnózis — projekt-tanulság).
        h(PanelBoundary, { t: t, sessions: safeProps.sessions, workspaces: safeProps.workspaces, sessionId: safeProps.sessionId, workspace: pickWorkspace(safeProps), onClose: function () { setOpen(false); } }),
      );

      if (reactDom !== null && typeof reactDom.createPortal === "function" && typeof document !== "undefined" && document.body) {
        return h(react.Fragment, null, shownButton, reactDom.createPortal(panel, document.body));
      }
      // Portál nélkül (régi kliens-környezet) a panel a gomb mellett jelenik meg.
      return h("span", { style: { position: "relative", display: "inline-block" } }, shownButton, panel);
    }

    // ─────────────────────────────────────────── láthatatlan aktivitás-mérő
    /**
     * A felhasználó aktivitását méri (billentyű, mutató, görgetés, lap-
     * láthatóság), 5 s-os vödrökben, és 15 s-onként elküldi a hostnak.
     *
     * MIÉRT KELL: ebből tudja a host szétválasztani az „elolvasta a választ” és
     * a „beírta a következő promptot” időt. Szöveget NEM küld — csak időt.
     * A komponens `null`-t renderel, tehát a felületet nem változtatja.
     *
     * FONTOS: a komponens KÉT slotban is regisztrálva van (composer dock + input
     * dock), mert a `hero` fázisban a composer dock nem létezik. Egyszerre mégis
     * CSAK EGY figyelő fut (referenciaszámláló), különben minden aktivitás
     * duplán menne a naplóba.
     */
    var tracker = { refs: 0, sessionId: "", workspace: "", dispose: null };

    /** A figyelő felcsatolása (egyszer, az első példány mountolásakor). */
    function startTracker() {
      if (tracker.dispose !== null) return;
      var pending = [];
      var bucketStart = Date.now();
      var bucket = { key: 0, pointer: 0 };
      var hiddenStart = 0;
      var disposed = false;

      function push(kind, from, to) {
        if (!(from > 0)) return;
        pending.push({
          kind,
          at: from,
          to: Math.max(from, to ?? from),
          session: tracker.sessionId,
          workspace: tracker.workspace,
        });
        if (pending.length > 400) pending.splice(0, pending.length - 400);
      }

      function mark(kind) {
        var now = Date.now();
        if (kind === "key") {
          if (bucket.key === 0) bucket.key = now;
          bucket.key_end = now;
        } else if (kind === "pointer") {
          if (bucket.pointer === 0) bucket.pointer = now;
          bucket.pointer_end = now;
        }
      }

      function flush(useBeacon) {
        if (pending.length === 0) return;
        var items = pending.slice(0, 400);
        pending = pending.slice(items.length);
        var body = JSON.stringify({ workspace: tracker.workspace, items });
        try {
          if (useBeacon === true && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
            // A lap elhagyásakor a `fetch` megszakadhat; a beacon nem.
            navigator.sendBeacon(ROUTE + "/activity", new Blob([body], { type: "application/json" }));
            return;
          }
          fetch(ROUTE + "/activity", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            keepalive: true,
          }).catch(function () { /* a következő kör újrapróbálja */ });
        } catch (error) {
          /* a mérés hibája nem akaszthatja meg a felületet */
        }
      }

      function rotate() {
        var now = Date.now();
        if (now - bucketStart >= ACTIVITY_BUCKET_MILLISECONDS) {
          if (bucket.key > 0) push("key", bucket.key, bucket.key_end ?? bucket.key);
          if (bucket.pointer > 0) push("pointer", bucket.pointer, bucket.pointer_end ?? bucket.pointer);
          bucket = { key: 0, pointer: 0 };
          bucketStart = now;
        }
      }

      function onKeyDown() {
        if (document.visibilityState === "hidden") return;
        mark("key");
      }
      function onPointerDown() {
        if (document.visibilityState === "hidden") return;
        mark("pointer");
      }
      function onWheel() {
        if (document.visibilityState === "hidden") return;
        mark("pointer");
      }
      function onVisibility() {
        var now = Date.now();
        if (document.visibilityState === "hidden") {
          hiddenStart = now;
          rotate();
          flush(true);
        } else if (hiddenStart > 0) {
          push("hidden", hiddenStart, now);
          hiddenStart = 0;
        }
      }
      function onPageHide() {
        rotate();
        flush(true);
      }

      var ticker = setInterval(function () {
        if (disposed) return;
        rotate();
        flush(false);
      }, ACTIVITY_FLUSH_MILLISECONDS);

      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("wheel", onWheel, { capture: true, passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);

      tracker.dispose = function () {
        disposed = true;
        clearInterval(ticker);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("wheel", onWheel, { capture: true });
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        rotate();
        flush(true);
        tracker.dispose = null;
      };
    }

    /** A figyelő lecsatolása (az utolsó példány unmountolásakor). */
    function stopTracker() {
      if (tracker.dispose !== null) tracker.dispose();
    }

    function ActivityTracker(props) {
      var safeProps = props !== null && typeof props === "object" ? props : {};
      var sessionId = typeof safeProps.sessionId === "string" ? safeProps.sessionId : "";
      var workspace = pickWorkspace(safeProps);

      react.useEffect(function () {
        if (typeof document === "undefined" || typeof window === "undefined") return undefined;
        tracker.sessionId = sessionId;
        tracker.workspace = workspace;
        tracker.refs += 1;
        if (tracker.refs === 1) startTracker();
        return function () {
          tracker.refs = Math.max(0, tracker.refs - 1);
          if (tracker.refs === 0) stopTracker();
        };
      }, [sessionId, workspace]);

      // Láthatatlan: semmit nem renderel.
      return null;
    }

    /**
     * A composer dock regisztrációja: CSAK aktivitás-mérő (nem rajzol gombot).
     *
     * MÉRT VISSZAJELZÉS (2026-11-17): a felhasználó kérte, hogy a panelek alján
     * ne legyen duplikált költségelszámolás-chip — a gomb a menüsorban van
     * (fejléc-ikon), illetve üres beszélgetésnél a composer fölötti sávban.
     */
    function KoltsegHeroHost(props) {
      return ActivityTracker(props);
    }

    // ──────────────────────────────────────────────────────────── hiba-határ
    /**
     * Ha a panel renderelése elszáll, a felhasználó SZÖVEGET lát (nem üres
     * helyet) — ez a projekt korábbi tanulsága (láthatatlan hiba = rossz
     * diagnózis).
     */
    class PanelBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: (error && error.message) || String(error) };
      }

      render() {
        if (this.state.error) {
          return h("div", { style: { padding: "10px", color: "#ffb4ab", fontSize: "12px", whiteSpace: "pre-wrap" } },
            "Költségelszámolás hiba: " + this.state.error);
        }
        return h(KoltsegPanel, this.props);
      }
    }

    // ───────────────────────────────────────────────────────────────── plugin
    /**
     * A deklarált szolgáltatások. FONTOS (MÉRT HIBA, 2026-11-17): a cordis
     * `ctx.sessions` / `ctx.workspaces` olvasása CSAK akkor engedett, ha a
     * plugin inject-listája deklarálja — enélkül a kliens-betöltés
     * `cannot get property "sessions" without inject` hibával elszállt, és az
     * egész felület a „Failed to load plugins” képernyőre esett. Ezért a
     * munkaterület-feloldáshoz használt szolgáltatások itt deklarálva vannak
     * (a `dsh-ui-extras` is így csinálja), és a hozzáférés `try`-ban történik.
     */
    const inject = ["slots", "locale", "sessions", "workspaces"];

    function apply(ctx) {
      ctx.locale.register(NS, { hu: HU, en: EN });
      var t = ctx.locale.bind(NS);
      translator = t;
      // A munkaterület-feloldáshoz (a slot-props nem tartalmazza ezeket).
      // `try`: ha egy szolgáltatás mégis hiányzik, a plugin attól még betölt.
      try {
        pluginServices.sessions = ctx.sessions !== undefined ? ctx.sessions : null;
      } catch (error) {
        pluginServices.sessions = null;
      }
      try {
        pluginServices.workspaces = ctx.workspaces !== undefined ? ctx.workspaces : null;
      } catch (error) {
        pluginServices.workspaces = null;
      }

      function safeRun(label, fn) {
        try {
          var value = fn();
          reportEvent("apply " + label + ": ok");
          return value;
        } catch (error) {
          var message = String(error && error.message ? error.message : error);
          try {
            console.warn("[dsh-koltseg] " + label + ": " + message);
          } catch (ignored) {
            /* a naplózás hibája nem számít */
          }
          reportEvent("apply " + label + ": HIBA " + message);
          return undefined;
        }
      }

      /** A slot-gyár jelentése: a shell meghívta-e egyáltalán a gyárat. */
      function seatFactory(label, slotName, id, order, component) {
        reportEvent("factory " + label + " hivva");
        return ctx.slots.register({
          name: slotName,
          id: id,
          order: order,
          locale: NS,
          inject: function () { return {}; },
        }, component);
      }

      safeRun("header inject", function () {
        ctx.slots.inject(HEADER_SLOT, function () {
          return seatFactory("header", HEADER_SLOT, HEADER_ID, HEADER_ORDER, HeaderSeat);
        });
      });

      // A méréshez a session-azonosító a slot props-aiból jön (ugyanaz, amit a
      // statisztika-sáv is használ). A composer dock példánya adja a LÁTHATÓ
      // gombot is (mért ok: a külön gomb-bejegyzés nem renderel), a hero sáv
      // példánya csak mér — így nincs két gomb.
      safeRun("tracker inject: " + TRACKER_SLOT, function () {
        ctx.slots.inject(TRACKER_SLOT, function () {
          return ctx.slots.register({
            name: TRACKER_SLOT,
            id: "koltseg-tracker",
            order: 90,
            locale: NS,
            inject: function () { return {}; },
          }, ActivityTracker);
        });
      });

      safeRun("tracker inject: " + INPUT_DOCK_SLOT, function () {
        ctx.slots.inject(INPUT_DOCK_SLOT, function () {
          return ctx.slots.register({
            name: INPUT_DOCK_SLOT,
            id: "koltseg-tracker-hero",
            order: 90,
            locale: NS,
            inject: function () { return {}; },
          }, KoltsegHeroHost);
        });
      });

      // ── hero fázis ────────────────────────────────────────────────────
      // Üres, új beszélgetésnél a fejléc REJTVE van, ezért a fejléc-ikon nem
      // látszana. A `conversation.input.dock` a composer fölötti sáv, ami MINDKÉT
      // fázisban létezik (a `dsh-ui-extras` ugyanezt teszi a CornerControls-szal).
      safeRun("hero button inject", function () {
        ctx.slots.inject(INPUT_DOCK_SLOT, function () {
          return seatFactory("hero", INPUT_DOCK_SLOT, "koltseg-hero", 42, HeroSeat);
        });
      });

      // A panelek alján NINCS külön költségelszámolás-chip (a felhasználó
      // kérésére): a composer dock bejegyzése csak aktivitást mér.

      // ── DOM-próba (diagnosztika) ──────────────────────────────────────
      // Megmondja, hogy a regisztrált gombokból MENNYI van a valódi DOM-ban:
      // 0 = a slot nem rendereli, >0 = rendereli (akkor a láthatóság/levágás a
      // kérdés). Ez dönti el, merre kell tovább menni.
      try {
        setTimeout(function () {
          try {
            var seats = document.querySelectorAll("[data-koltseg-seat]");
            var labels = [];
            for (var i = 0; i < seats.length; i += 1) labels.push(String(seats[i].getAttribute("data-koltseg-seat")));
            reportEvent("dom proba: seats=" + seats.length + " [" + labels.join(",") + "] phase=" + String(readConversationPhase()));
          } catch (error) {
            reportEvent("dom proba hiba: " + String(error && error.message ? error.message : error));
          }
        }, 2500);
      } catch (error) {
        /* diagnosztika */
      }
    }

    exports.name = "dsh-koltseg";
    exports.apply = apply;
    exports.inject = inject;
    exports.KoltsegPanel = KoltsegPanel;
    exports.KoltsegButton = KoltsegButton;
    exports.KoltsegHeroHost = KoltsegHeroHost;
    exports.ActivityTracker = ActivityTracker;
    exports.PanelBoundary = PanelBoundary;
    exports.reportEvent = reportEvent;
    exports.__util = {
      groupDigits: groupDigits,
      digitsOnly: digitsOnly,
      fmtTokens: fmtTokens,
      fmtUsd: fmtUsd,
      // Bruttó (áfás) ár a panelben — a tesztek ezeket a tiszta függvényeket
      // mérik (a host-independens számítás a felhasználói jelzés miatt van).
      grossRatesOf: grossRatesOf,
      isHostGross: isHostGross,
      grossRateOfModel: grossRateOfModel,
      grossFactorOf: grossFactorOf,
      FALLBACK_GROSS_RATES: FALLBACK_GROSS_RATES,
      // A folyamatvisszajelzés döntése (stale/busy) — lásd measureFeedback.
      measureFeedback: measureFeedback,
      snapshotKey: snapshotKey,
    };
    exports.__dict = { hu: HU, en: EN };
    exports.__constants = { NS, HEADER_SLOT, TRACKER_SLOT, INPUT_DOCK_SLOT, HEADER_ID, HEADER_ORDER, BUILD, ROUTE };
    return module.exports;
  },
});



