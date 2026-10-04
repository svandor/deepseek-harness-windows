/**
 * Browser half of the DSH UI extras plugin: the extended statistics row.
 *
 * Hand-written bundle in the same shape the built client plugins use. The
 * factory only registers; every side effect happens when the shell materializes
 * the module.
 *
 * Contracts learned the hard way (see docs/safe-plugin-development.md):
 *   * client services are requested by their SHORT names (`slots`, `locale`);
 *   * a session-scoped slot view receives its data hooks from the shell, so
 *     `props.useProjection("tokenUsage")` / `("sessionStats")` is the supported
 *     read path;
 *   * `conversation.composer.dock` is the ambient row below the composer card —
 *     the same place the built-in "N turns ... Cache hit" pills live. The
 *     built-in pills are hidden and replaced by this extended row so there is
 *     ONE statistics line, not two;
 *   * the balance comes from the host half (`GET /ui-extras/balance`), which
 *     owns the API key; the browser never sees it.
 *
 * It also owns the approval prompt: the built-in card offers one-shot answers
 * only, so this plugin takes over the composer for approval interactions and
 * adds "remember this approval type" buttons. The type is derived and stored on
 * the host (`/ui-extras/approvals`), which then answers that type itself — see
 * the remembered-approvals section of the host half.
 *
 * Every visible string lives in the `hu` / `en` dictionaries below and is
 * requested through the slot-provided `t` function, so the row follows the
 * interface language instead of mixing languages.
 */

/**
 * The address-bar query as it was when this bundle was EVALUATED.
 *
 * The shell strips the sign-in token from the address bar during boot, so a
 * later read of `location.search` inside `apply()` already sees a clean URL.
 * That is why the language-pack probe (`?dsh-ui-extras-probe=1`) never sent its
 * report and why the debug handle stayed unpublished. Captured here, at script
 * evaluation — before any of the shell's own code runs — both flags survive.
 */
var __dshUiExtrasSearchAtLoad = (function () {
  try {
    return String(window.location.search);
  } catch (error) {
    return "";
  }
})();

window.__ModuleLoader__.load({
  id: "dsh-ui-extras",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require("react");
    var jsx = require("react/jsx-runtime");

    /**
     * The shell's shared UI primitives, when this module graph exposes them.
     *
     * The approval card uses the primitive's Button so it looks exactly like the
     * built-in prompt it replaces. The require is optional on purpose: a
     * composition without the primitives must still be able to approve, which is
     * why every use site falls back to the plugin's own button class.
     */
    var primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      primitives = null;
    }
    // A loader that answers an unresolvable request with `undefined` (instead of
    // throwing) must not turn into a property access on nothing later.
    if (!primitives || typeof primitives.Button !== "function") primitives = null;

    /** Locale namespace owned by this plugin. */
    var NS = "ui-extras";

    /**
     * Build marker, reported with the boot diagnostics.
     *
     * Without it there is no way to tell whether a page is running the bundle on
     * disk or an older one the browser kept: the plugin URL carries a revision
     * query, and a stale page looks exactly like a failing one.
     */
    var BUILD = "2026-09-27.2";

    /**
     * One-time cleanup of this plugin's leftovers in the browser.
     *
     * Automatic re-opening wrote the right sidebar's dock layout into browser
     * storage, and that stored column could come back covering the interface. A
     * browser preference is not worth a broken layout, so the keys this plugin
     * wrote — and any dock/column layout key — are dropped once, guarded by a
     * version stamp. The settings the user actually chose (theme, language) live
     * on the host, so nothing of theirs is lost.
     */
    function cleanupPanelStorage() {
      try {
        var marker = "dsh-ui-extras.cleanup";
        if (window.localStorage.getItem(marker) === "2026-09-27.2") return;
        window.localStorage.setItem(marker, "2026-09-27.2");

        var doomed = [];
        for (var i = 0; i < window.localStorage.length; i++) {
          var key = window.localStorage.key(i);
          if (key === null || key === marker) continue;
          // Only OUR keys. The framework's sidebar/dock layout is its own state
          // and must not be wiped: the restore above lives beside it.
          if (key.indexOf("dsh-ui-extras.") === 0) doomed.push(key);
        }
        doomed.forEach(function (key) {
          try { window.localStorage.removeItem(key); } catch (error) { }
        });
        reportToHost("storage cleanup", "removed " + String(doomed.length) + " key(s): " + doomed.slice(0, 12).join(", "));
      } catch (error) { }
    }

    /**
     * One width restore per page, and a guard for this plugin's own drag.
     *
     * The synthetic drag ends with a `pointerup`, and the width watcher treats a
     * pointerup on the handle as "the user resized it" — without the guard the
     * restore saved whatever width it saw mid-drag (the log showed `remembered 860`
     * racing a wanted 482), which is why the width only sometimes came back.
     */
    var widthRestoreState = { started: false };
    var syntheticDrag = false;

    /**
     * Recovery helpers published by the mounted corner controls and consumed by
     * the connection watchdog. The watchdog is not part of the component tree,
     * so it cannot close over the component's functions; the component fills
     * this in on every render instead.
     */
    var serverRecovery = null;

    /**
     * The host's own working directory, asked for once at boot.
     *
     * The last resort for panels that have neither a session nor a workspace
     * selected (a freshly opened window before any conversation exists). The
     * harness runs in the workspace directory, so its answer is the right default.
     */
    var hostWorkspace = null;

    function loadHostWorkspace() {
      return fetch("/ui-extras/workspace", { headers: { Accept: "application/json" } })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          if (body && body.ok === true && typeof body.workspace === "string" && body.workspace !== "") {
            hostWorkspace = body.workspace;
          }
          return hostWorkspace;
        })
        .catch(function () { return null; });
    }

    /**
     * The host's working directory as a FUNCTION, so a panel that renders later
     * reads the answer that arrived in the meantime.
     *
     * `hostWorkspace` is filled asynchronously, and a slot's `inject` callback
     * captures whatever it returned at registration time — which was null on a
     * fresh page. Passing this getter instead keeps that fallback alive; the
     * panel calls it on every render.
     */
    function hostWorkspaceOf() {
      return hostWorkspace;
    }

    /**
     * The workspace path recorded on the CURRENT selection of a sessions
     * snapshot, or null.
     *
     * `current` is the documented field (`SessionListState.current`); the older
     * `selected`/`selectedId` spellings are read as well so a snapshot from a
     * different controller revision still answers. The row's `cwd` is the
     * directory that Session was opened in, which is exactly the directory a
     * terminal of that Session has to run in.
     */
    function pickSessionWorkspace(sessions) {
      try {
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return null;
        var snapshot = sessions.list.getSnapshot();
        if (!snapshot) return null;
        var id = snapshot.current;
        if (id === undefined || id === null) {
          var selected = snapshot.selected;
          id = typeof selected === "string" ? selected : (selected && selected.id);
        }
        if (id === undefined || id === null) id = snapshot.selectedId;
        if (id === undefined || id === null) return null;
        var entry = snapshot.byId ? snapshot.byId[id] : undefined;
        if (entry && typeof entry.cwd === "string" && entry.cwd !== "") return entry.cwd;
      } catch (error) { }
      return null;
    }

    /**
     * Report a client-side failure to the host, which appends it to
     * state\ui-extras-client.log. The host cannot see the browser, so without
     * this a broken panel looks like "the deploy froze" and there is nothing to
     * inspect. Failures here are swallowed: reporting must never add a failure.
     */
    function reportToHost(kind, detail) {
      try {
        var text = kind + ": " + detail;
        console.error("[dsh-ui-extras] " + text);
        if (typeof fetch === "function") {
          fetch("/ui-extras/log", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: text + "\n@" + String(location.href)
          }).catch(function () { });
        }
      } catch (error) { }
    }

    /**
     * Run one initialisation step in isolation. A throw inside a boot effect can
     * take the whole plugin — and with it the statistics row and every panel —
     * down, so each step reports and continues instead.
     */
    function safeRun(label, body) {
      try {
        return body();
      } catch (error) {
        reportToHost("init failed", label + " :: " + String(error && error.stack ? error.stack : error));
        return null;
      }
    }

    /**
     * Namespaces whose built-in English copy is replaced by a Hungarian
     * dictionary. The locale runtime refuses a second owner for an existing
     * (namespace, language) pair, so the shipped English cannot be overwritten;
     * `hu` is a NEW language, and the runtime's lookup chain is
     * `hu -> en -> common -> key`. That means every key left out of a Hungarian
     * dictionary falls back to correct English instead of showing a raw key, so
     * these dictionaries can grow a namespace at a time.
     */
    var PACK_NS = "common";

    /**
     * Hungarian copy for the `common` namespace — the cross-feature vocabulary
     * that every button, row action and truncation notice reads through when a
     * feature's own namespace has no key. This is what turns the separator
     * dialogs, the "Load earlier" control and the sidebar's copy actions into
     * Hungarian in one step.
     */
    var commonHu = {
      "ok": "Rendben",
      "cancel": "Mégse",
      "close": "Bezárás",
      "copy": "Másolás",
      "copied": "Kimásolva",
      "copy.failed": "A másolás nem sikerült",
      "copy.value": "Érték másolása",
      "copy.json": "JSON másolása",
      "copy.path": "Tulajdonság-útvonal másolása",
      "copy.prettyJson": "Formázott JSON másolása",
      "copy.compactJson": "Tömör JSON másolása",
      "copy.optionsHint": "{action}; jobb kattintással másolási mód választható",
      "retry": "Újra",
      "loading": "Betöltés…",
      "load.failed": "A betöltés nem sikerült",
      "submit": "Küldés",
      "submitting": "Küldés…",
      "next": "Tovább",
      "previous": "Vissza",
      "skip": "Kihagyás",
      "delete": "Törlés",
      "edit": "Szerkesztés",
      "save": "Mentés",
      "search": "Keresés",
      "more": "Több",
      "collapse": "Összecsukás",
      "expand": "Kibontás",
      "back": "Vissza",
      "brand.localBuild": "DSH helyi build",
      "unknown": "ismeretlen",
      "none": "nincs",
      "truncated": "levágva",
      "json.collapseNode": "JSON csomópont összecsukása",
      "json.expandNode": "JSON csomópont kibontása",
      "json.label": "JSON",
      "markdown.footnotes": "lábjegyzetek",
      "markdown.truncatedCharacters": "… levágva, összesen {total} karakter",
      "number.thousand": "{value} e",
      "number.million": "{value} M"
    };

    /**
     * Hungarian copy for the built-in feature namespaces.
     *
     * Keyed by namespace, registered one namespace at a time through
     * ctx.locale.register(ns, "hu", …) so a missing key falls back to the
     * correct built-in English. Only namespaces that are actually worth reading
     * in Hungarian are listed; an English-looking string in the interface means
     * its key is not covered here yet, never a broken build. tools/check-plugin.mjs
     * verifies every key below against the shipped English dictionaries, so a
     * typo cannot silently fall back.
     */
    var packHu = {
      /** Sidebar session list. */
      "sidebar": {
        "session.new": "Új beszélgetés",
        "session.new.label": "Új beszélgetés",
        "toggle.open": "Oldalsáv megnyitása",
        "toggle.collapse": "Oldalsáv összecsukása",
        "panels.label": "Globális panelek"
      },
      /** Workspace and session list, search, rename, delete. */
      "workspace": {
        "group.ungrouped": "Csoportosítatlan",
        "session.new": "Új beszélgetés",
        "section.workspaces": "Munkaterületek",
        "section.sessions": "Beszélgetések",
        "viewOptions.label": "Nézet beállításai",
        "groupBy.label": "Csoportosítás",
        "groupBy.workspace": "Munkaterület szerint",
        "groupBy.flat": "Egy listában",
        "orderBy.label": "Rendezés",
        "orderBy.manual": "Kézi",
        "orderBy.updated": "Utolsó frissítés",
        "sessions.expand": "További {n} beszélgetés",
        "sessions.collapse": "Kevesebb",
        "empty.none": "Még nincs beszélgetés",
        "empty.noMatches": "Nincs találat",
        "workspace.add": "Munkaterület hozzáadása",
        "search.sessions.aria": "Keresés a beszélgetésekben",
        "search.placeholder": "Keresés a beszélgetésekben…",
        "search.clear": "Keresés törlése",
        "search.results.aria": "Keresési találatok",
        "search.pending": "Keresés a beszélgetések előzményeiben…",
        "search.unavailable": "A tartalomkeresés átmenetileg nem elérhető. Név szerinti találatok láthatók.",
        "search.noMatches": "Nincs egyező beszélgetés",
        "search.hasMore": "Az első {n} találat látható. Szűkítsd a keresést.",
        "menu.addWorkspace": "Munkaterület hozzáadása…",
        "picker.loading": "Munkaterületek betöltése…",
        "conflict.named": "Már létezik „{name}” nevű munkaterület.",
        "folderError.title": "A mappa nem nyitható meg",
        "folderError.retry": "Új választás",
        "rename": "Átnevezés",
        "rename.workspace.title": "Munkaterület átnevezése",
        "rename.session.title": "Beszélgetés átnevezése",
        "field.workspaceName": "Munkaterület neve",
        "field.sessionName": "Beszélgetés neve",
        "delete.workspace": "Munkaterület törlése",
        "delete.desc": "Eltávolítja a(z) „{name}” elemet a munkaterület-listából. A mappa és a beszélgetésnaplók megmaradnak. A beszélgetései a Csoportosítatlan alatt jelennek meg.",
        "delete.pending": "Munkaterület törlése…",
        "menu.fork": "Beszélgetés elágaztatása",
        "menu.archiveSession": "Beszélgetés archiválása",
        "sessions.count.one": "{n} beszélgetés",
        "sessions.count.other": "{n} beszélgetés",
        "actions.workspace.aria": "Munkaterület műveletek: {name}",
        "actions.session.aria": "Beszélgetés műveletei: {name}",
        "actions.newSession.aria": "Új beszélgetés itt: {name}",
        "status.running": "Fut",
        "status.subagentsRunning.one": "{n} alügynök fut",
        "status.subagentsRunning.other": "{n} alügynök fut",
        "status.idle": "Tétlen",
        "status.waitingApproval": "Jóváhagyásra vár",
        "status.planReview": "Terv felülvizsgálatra vár",
        "status.waitingAnswer": "Válaszra vár",
        "status.completed": "Kész",
        "schedule.active": "Van aktív ütemezett feladat",
        "hover.created": "Létrehozva: {time}",
        "hover.copied": "Kimásolva",
        "date.ymd": "{y}-{m}-{d}",
        "time.now": "most",
        "time.minutes": "{n} perc",
        "time.hours": "{n} óra",
        "time.days": "{n} nap",
        "time.months": "{n} hónap",
        "time.years": "{n} év",
        "time.ago": "{t} ezelőtt"
      },
      /** Settings dialog shell and connection state. */
      "settings": {
        "trigger": "Beállítások",
        "title": "Beállítások",
        "close": "Bezárás",
        "openDocument": "Konfigurációs fájl megnyitása",
        "openDocument.error": "A konfigurációs fájlt nem sikerült megnyitni",
        "general.nav": "Általános",
        "connection.error": "Megszakadt",
        "connection.retry": "Újracsatlakozás most",
        "connection.connecting": "Újracsatlakozás",
        "connection.connected": "Kapcsolódva",
        "connection.reconnect": "Megszakadt, újracsatlakozás most",
        "connection.restart": "Automatikus újracsatlakozás, kapcsolódás most"
      },
      /** Model and reasoning-effort picker. */
      "model": {
        "command.description": "A beszélgetés modelljének kiválasztása",
        "option.loadError": "A modellkatalógus betöltése nem sikerült: {message}",
        "option.deepseekV4Flash.description": "Gyors, hatékony és gazdaságos; fókuszált, rutin- vagy párhuzamos feladatokhoz.",
        "option.deepseekV4Pro.description": "Erősebb ügynökös kódolás, tudás és nehéz következtetés; összetett vagy minőségkritikus feladatokhoz, magasabb költséggel.",
        "trigger.fallback": "Modell választása",
        "trigger.loading": "Modellek betöltése…",
        "trigger.selectAria": "Modell választása",
        "trigger.aria": "Modell választása, jelenlegi: {model}",
        "trigger.ariaEffort": "Modell választása, jelenlegi: {model}, következtetési szint: {effort}",
        "menu.aria": "Modell és következtetési szint",
        "menu.model": "Modell",
        "menu.effort": "Szint",
        "effort.providerDefault": "Alapértelmezett",
        "status.loading": "Modellista frissítése…",
        "error.action": "A modellművelet nem sikerült: {message}",
        "action.reload": "Újratöltés",
        "warning.groupLoad": "{name} betöltése nem sikerült: {message}",
        "empty.models": "Nincs elérhető modell.",
        "blocked.composer": "Ez a modell nem elérhető — válassz egyet a folytatáshoz",
        "empty.efforts": "Ez a modell nem kínál következtetési szinteket."
      },
      /** Slash-command picker and plan/skill panels. */
      "command": {
        "description.compact": "A régebbi beszélgetés-előzmény tömörítése",
        "description.export": "A beszélgetés naplójának letöltése ZIP archívumként",
        "description.feedback": "visszajelzés rögzítése erről a beszélgetésről",
        "description.goal": "hosszú futású feladat céljának beállítása vagy megtekintése",
        "description.permission": "Jogosultsági szint váltása (sandbox mód + jóváhagyási szabály)",
        "description.plan": "Terv mód be- vagy kikapcsolása",
        "search.placeholder": "Keresés…",
        "search.aria": "Opciók szűrése",
        "status.loading": "Opciók betöltése…",
        "status.applying": "Alkalmazás…",
        "status.empty": "Nincs opció",
        "overlay.aria": "/{command} opciók",
        "listbox.aria": "/{command} találatok",
        "notice.attachmentsUnsupported": "/{command} nem fogad mellékletet; előbb távolítsd el őket"
      },
      /** Plan-mode chip. */
      "plan": {
        "chip.label": "Terv",
        "chip.on.aria": "Terv mód bekapcsolva, nyomd meg a kikapcsoláshoz",
        "chip.on.title": "Terv mód bekapcsolva — kattints a kikapcsoláshoz (/plan off)",
        "chip.off.aria": "Terv mód kikapcsolva, nyomd meg a bekapcsoláshoz",
        "chip.off.title": "Terv mód kikapcsolva — kattints a bekapcsoláshoz (/plan)",
        "chip.exitFailed": "A terv módból nem sikerült kilépni"
      },
      /** Long-running goal card. */
      "goal": {
        "phase.active": "Aktív cél",
        "phase.active.disarmed": "Inaktív cél",
        "phase.paused": "Szüneteltetett cél",
        "phase.blocked": "Elakadt cél",
        "objective.aria": "A cél megfogalmazása",
        "commandInput.aria": "Parancsbevitel",
        "action.save": "Cél mentése",
        "action.cancel": "Szerkesztés elvetése",
        "action.pause": "Cél szüneteltetése",
        "action.resume": "Cél folytatása",
        "action.edit": "Cél szerkesztése",
        "action.clear": "Cél törlése"
      },
      /** Skill load row. */
      "skill": {
        "row.title": "Készség",
        "row.running": "Készség betöltése",
        "row.failed": "A készség betöltése nem sikerült",
        "row.stopped": "A készség betöltése leállt",
        "row.instructions": "Utasítások",
        "row.inspect": "Megtekintés",
        "menu.userOnly": "csak felhasználói"
      },
      /** Clarifying questions and plan review. */
      "question": {
        "error.incomplete": "Előbb fejezd be ezt a kérdést.",
        "error.unanswered": "Válassz egy lehetőséget, vagy írj be saját választ.",
        "nav.prev": "Előző kérdés",
        "nav.next": "Következő kérdés",
        "nav.minimize": "Kérdéskártya összecsukása",
        "nav.maximize": "Kérdéskártya kibontása",
        "nav.cancel": "Az összes kérdés elvetése",
        "option.recommended": "Javasolt",
        "custom.placeholder": "Írd be a válaszod",
        "action.skip": "Kérdés kihagyása",
        "action.next": "Tovább",
        "plan.header": "Terv felülvizsgálata",
        "plan.approve": "Jóváhagyás",
        "plan.decline": "Elutasítás",
        "plan.discuss": "Beszéljünk róla"
      },
      /** Approval prompt (the composer takeover the plugin itself also renders). */
      "approval": {
        "waiting": "Jóváhagyásra vár",
        "detail.aria": "Jóváhagyás részletei",
        "escalation": "A(z) {toolName} eszköz emelt szintű futtatást kér",
        "reject": "Elutasítás",
        "allowOnce": "Engedélyezés egyszer"
      },
      /** @-reference picker. */
      "reference": {
        "section.files": "Fájlok és mappák",
        "section.sessions": "Beszélgetések",
        "candidate.noCwd": "(nincs munkakönyvtár)",
        "crumb.root": "Munkaterület",
        "time.now": "most",
        "time.minutes": "{n} perc",
        "time.hours": "{n} óra",
        "time.days": "{n} nap",
        "time.months": "{n} hónap",
        "time.years": "{n} év"
      },
      /** "Open in app" menu. */
      "open-in-app": {
        "open.title": "Munkaterület megnyitása ezzel: {app}",
        "open.tooltip": "Megnyitás helyben",
        "open.error": "A megnyitás nem sikerült",
        "menu.toggle": "Válassz alkalmazást a megnyitáshoz",
        "menu.aria": "Megnyitás ezzel",
        "app.finder": "Finder",
        "app.explorer": "Fájlkezelő",
        "app.filemanager": "Fájlok",
        "app.terminal": "Terminál"
      },
      /** Workspace file browser in the sidebar. */
      "sidebarFiles": {
        "type.label": "Fájlok",
        "guide.title": "Munkaterület fájljai",
        "guide.description": "A beszélgetés munkaterületének fájljai",
        "entry.other": "Nem fájl és nem mappa, ezért nem nyitható meg.",
        "error.notFound": "Ez a mappa eltűnt. Lehet, hogy áthelyezték vagy törölték.",
        "error.outsideWorkspace": "Ez a mappa a munkaterületen kívül van, ezért az oldalsáv nem olvassa.",
        "error.notDirectory": "Ez nem mappa.",
        "error.unavailable": "Az olvasás nem sikerült: {message}"
      },
      /** Message feedback dialog. */
      "feedback": {
        "action.like": "Jó válasz",
        "action.likeActive": "Értékelés törlése",
        "action.dislike": "Hibás válasz",
        "action.dislikeActive": "Értékelés törlése",
        "dialog.title": "Visszajelzés küldése",
        "dialog.categories": "Visszajelzés kategóriája",
        "dialog.detail": "Visszajelzés részletei",
        "dialog.hint": "Egészítsd ki részletekkel, hogy javíthassunk. A beküldéssel a jelenlegi beszélgetés naplója is elküldésre kerül.",
        "category.task-result": "Feladat eredménye",
        "category.instruction-following": "Utasítás megértése és követése",
        "category.product-interaction": "Termékfunkciók és használat",
        "category.service-stability": "Stabilitás és sebesség",
        "category.resource-cost": "Erőforrás-használat és költség",
        "category.security-privacy-permission": "Biztonság, adatvédelem és jogosultságok",
        "category.other": "Egyéb",
        "toast.recorded": "Köszönjük a visszajelzést",
        "error.conflict": "Ez a visszajelzés máshol módosult; a legfrissebb állapot látható",
        "error.load": "A visszajelzést nem sikerült betölteni",
        "error.generic": "A visszajelzést nem sikerült menteni",
        "error.noteTooLarge": "A leírás túl hosszú; rövidítsd, és küldd be újra"
      },
      /** Conversation view: history, turn navigation, transcript settings. */
      "chat": {
        "view.chat": "Beszélgetés",
        "number.groupSeparator": " ",
        "duration.compactSeconds": "{seconds} mp",
        "duration.compactMinutes": "{minutes} p {seconds} mp",
        "duration.milliseconds": "{milliseconds} ms",
        "stats.counts": "{turns} kör {steps} lépés",
        "stats.cacheHit": "Gyorsítótár-találat {percent}%",
        "stats.dialog.title": "Beszélgetés statisztikái",
        "stats.dialog.usageTitle": "Zseton használat",
        "stats.dialog.llmTime": "LLM idő",
        "stats.dialog.toolTime": "Eszközidő",
        "stats.dialog.ttft": "Átlagos idő az első zsetonig (TTFT)",
        "stats.dialog.speed": "Zseton másodpercenként (TPS)",
        "chat.loadingHistory": "Előzmények betöltése…",
        "chat.loadError": "Az előzmények betöltése nem sikerült: {message} ({code})",
        "chat.loadOlder": "Korábbiak betöltése",
        "chat.toBottom": "Vissza az aljára",
        "chat.deepDiving": "Mélyebb elemzés…",
        "chat.turnNavigation.label": "Körök közötti ugrás",
        "chat.turnNavigation.jump": "Ugrás a(z) {turn}. körre",
        "chat.turnNavigation.jumpLoad": "A(z) {turn}. kör betöltése és megnyitása",
        "chat.turnNavigation.turn": "{turn}. kör",
        "settings.transcript.title": "Beszélgetés megjelenítése",
        "settings.transcript.description": "A lezárt körök folyamat-tartalmát szabályozza",
        "settings.transcript.normal": "Normál",
        "settings.transcript.compact": "Tömör",
        "fileOpen.title": "A fájlt nem sikerült megnyitni",
        "fileOpen.unknown": "Ezt a fájlt nem sikerült megnyitni",
        "message.extraBlock": "További tartalomblokk",
        "message.systemPrompt": "Rendszerprompt",
        "message.systemPromptUpdate": "Rendszerprompt frissítése",
        "message.contextInjection": "Kontextus befecskendezése",
        "message.contextRecall": "Beszélgetés felidézése",
        "message.referenceSummary": "Hivatkozott beszélgetés · {labels}",
        "message.referenceSeparator": ", ",
        "message.context.instructions.loaded": "betöltve",
        "message.context.instructions.added": "hozzáadva",
        "message.context.instructions.updated": "frissítve",
        "message.context.instructions.removed": "eltávolítva",
        "message.context.catalog.replaced": "Lecserélt katalógus",
        "message.context.catalog.more": "… további {count}",
        "message.context.snapshot.supersedes": "A korábbi pillanatképek helyett",
        "message.context.relay.from": "A következő beszélgetésből: {session}",
        "message.context.recall.counts": "{retained} megtartva · {omitted} kihagyva",
        "message.context.recall.truncated": "levágva",
        "message.compaction": "Kontextus tömörítve",
        "message.compaction.running": "Kontextus tömörítése…",
        "message.compaction.completed": "{items} előzményelem tömörítve (~{tokens} zseton)",
        "message.compaction.expand": "Tömörítési összefoglaló megtekintése",
        "message.compaction.unavailable": "A tömörítési összefoglaló nem elérhető",
        "message.compaction.commandTitle": "compact",
        "message.think": "Gondolkodás",
        "message.unknownSurface": "Ismeretlen felületi esemény: {type}",
        "message.unknownBlock": "Ismeretlen tartalomblokk",
        "message.turnProcess.toolCalls.one": "{count} eszközhívás",
        "message.turnProcess.toolCalls.other": "{count} eszközhívás",
        "message.turnProcess.messages.one": "{count} üzenet",
        "message.turnProcess.messages.other": "{count} üzenet",
        "message.turnProcess.subagents.one": "{count} alügynök",
        "message.turnProcess.subagents.other": "{count} alügynök",
        "message.turnProcess.thoughtForAWhile": "Egy ideig gondolkodott",
        "message.turnProcess.separator": "  ·  ",
        "message.stopped": "Leállítva",
        "message.branch": "Elágazás új beszélgetésbe",
        "message.branchUnavailable": "Csak egy lezárt kör utolsó üzeneténél érhető el",
        "message.retry.active": "Modellkérés újrapróbálása",
        "message.retry.cancelled": "A modellkérés újrapróbálása megszakítva",
        "message.retry.started": "A modellkérés újrapróbálva",
        "message.retry.scheduled": "Várakozás a modellkérés újrapróbálására",
        "message.retry.status": "{label} ({retry}/{maximum}) · {seconds} mp",
        "message.retry.delay": "Újrapróbálás késleltetése: ",
        "message.retry.failure": "Hiba oka: ",
        "message.failure.auth": "Az API-kulcs érvénytelen",
        "message.turnError": "Ez a kör nem sikerült",
        "message.maxTokens": "Elérted a kimeneti zseton korlátot",
        "message.maxTokens.hint": "A válasz levágódott; a korábbi kimenet megmaradt a beszélgetésben. Küldd el, hogy „folytasd”, és a modell folytatni tudja.",
        "message.ranFor": "{duration} ideig futott",
        "message.tokensPerSecond": "{tps} zseton/s",
        "message.turnUsage.title": "Kör használata",
        "message.turnUsage.consumed": "Használat: {total}",
        "message.turnUsage.model": "Szolgáltató / modell",
        "message.turnUsage.cacheHit": "Gyorsítótár-találat",
        "message.turnUsage.input": "Nem gyorsítótárazott bemenet",
        "message.turnUsage.cacheRead": "Gyorsítótárból olvasott bemenet",
        "message.turnUsage.cacheWrite": "Gyorsítótárba írt bemenet",
        "message.turnUsage.output": "Kimenet",
        "message.turnUsage.reasoning": " ({tokens} következtetés)",
        "message.turnUsage.count": "{count} zseton",
        "message.turnTime.title": "Kör ideje és sebessége",
        "message.turnTime.duration": "Teljes futásidő",
        "message.turnTime.speed": "Zseton másodpercenként (TPS)",
        "message.turnTime.ttft": "Idő az első zsetonig (TTFT)",
        "duration.seconds": "{seconds} mp",
        "duration.minutes": "{minutes} p {seconds} mp",
        "command.running": "Futás…",
        "command.failed": "A parancs nem sikerült",
        "command.done": "Kész",
        "command.title": "Parancs",
        "row.running": "Fut",
        "row.failed": "Hiba",
        "json.truncated": "… levágva, összesen {total} karakter",
        "clock.md": "{m}/{d}",
        "clock.ymd": "{y}-{m}-{d}"
      },
      /** Composer, attachments, tool rows, queue and terminal output. */
      "conversation": {
        "hint.goal": "add meg a hosszú futású feladat célját",
        "hint.goal.active": "a cél aktív — szerkesztés / szüneteltetés / folytatás / törlés",
        "placeholder.default": "Írj üzenetet vagy adj feladatot, / parancsok, @ fájlok vagy beszélgetések",
        "placeholder.unavailable": "A beszélgetés nem elérhető",
        "placeholder.parentOffline": "A szülő beszélgetés offline; a küldés nem elérhető, de a futást le tudod állítani",
        "placeholder.hero": "Írd le, mit szeretnél építeni, / parancsok, @ fájlok vagy beszélgetések",
        "placeholder.workspace": "Válassz munkaterületet a kezdéshez",
        "placeholder.steerQueue": "Cmd/Ctrl+Enter az összes várakozó üzenetet átirányítja",
        "input.commands": "Parancsok",
        "input.stop": "Generálás leállítása",
        "input.send": "Üzenet küldése",
        "input.send.queue": "Üzenet sorba állítása",
        "input.send.steer": "Üzenet átirányítása",
        "input.accessMode": "Hozzáférési mód, jelenleg: {name}",
        "attachment.pending": "Feltöltésre váró mellékletek",
        "attachment.scrollLeft": "Mellékletek görgetése balra",
        "attachment.scrollRight": "Mellékletek görgetése jobbra",
        "attachment.dropTitle": "Húzz ide fájlokat vagy képeket a hozzáadáshoz",
        "attachment.dropDesc": "Képek: legfeljebb {count} kép, egyenként {size}",
        "attachment.dropBlocked": "Fájl és kép most nem adható hozzá",
        "image.pending": "Feltöltésre váró képek",
        "image.openOriginal": "Eredeti megtekintése",
        "image.openOriginalLabel": "{label}, kattints az eredeti megtekintéséhez",
        "image.remove": "A(z) {name} kép eltávolítása",
        "image.original": "Eredeti kép",
        "image.label": "Kép",
        "image.loadFailed": "A kép betöltése nem sikerült; kattints az újrapróbáláshoz",
        "image.loading": "Kép betöltése…",
        "image.preview": "Eredeti kép előnézete",
        "image.closePreview": "Az eredeti kép előnézetének bezárása",
        "image.unsupportedType": "Csak PNG, JPG, WebP és GIF kép támogatott",
        "image.tooMany": "Egy üzenet legfeljebb {count} képet tartalmazhat",
        "image.fileTooLarge": "Minden kép kisebb legyen, mint {size}",
        "image.totalTooLarge": "A képek összesen meghaladják a(z) {size} méretet; távolíts el néhányat, és próbáld újra",
        "image.tooManyPixels": "A kép felbontása túl nagy; tömörítsd, és próbáld újra",
        "image.dimensionTooLarge": "A kép oldalai legfeljebb {size}px méretűek lehetnek; kicsinyítsd, és próbáld újra",
        "image.modelUnsupported": "A jelenlegi modell nem támogatja a képeket; válts olyan modellre, amely igen",
        "image.sendFailed": "A képek küldése nem sikerült ({reason}); vedd fel újra őket, és próbáld megint",
        "file.attach": "Melléklet hozzáadása",
        "file.pending": "Feltöltésre váró fájlok",
        "file.remove": "A(z) {name} fájl eltávolítása",
        "file.uploading": "Feltöltés…",
        "file.uploadFailed": "A feltöltés nem sikerült; kattints az újrapróbáláshoz",
        "file.retry": "A(z) {name} feltöltésének újrapróbálása",
        "file.stillUploading": "A fájlok feltöltése még tart; a befejezésük után küldd el",
        "file.sessionUnavailable": "A beszélgetés nem elérhető; fájl nem tölthető fel",
        "file.notStaged": "A fájl feltöltése nem fejeződött be; vedd fel újra, és próbáld megint",
        "file.label": "Fájl",
        "context.aria": "A kontextus {percent} része használt",
        "context.used": "a kontextusból használt",
        "context.system": "Rendszerprompt",
        "context.tools": "Eszközdefiníciók",
        "context.messages": "Üzenetek",
        "settings.enter.title": "Küldési viselkedés elfoglaltság közben",
        "settings.enter.description": "Mit tesz az Enter és a Küldés gomb, amíg az ügynök fut; a Cmd/Ctrl+Enter a másik viselkedést használja",
        "settings.enter.queue": "Sorba állítás",
        "settings.enter.steer": "Átirányítás",
        "access.preset.readOnly": "Csak olvasás",
        "access.preset.workspaceWrite": "Írás a munkaterületen",
        "access.preset.fullAccess": "Teljes hozzáférés",
        "access.confirm.title": "Bekapcsolod a teljes hozzáférést?",
        "access.confirm.description": "A teljes hozzáférés csökkenti a megerősítési lépéseket, és az ügynök több műveletet hajthat végre közvetlenül, beleértve az érzékeny műveleteket, fájlmódosításokat vagy külső parancsokat. Csak akkor használd, ha megbízol a jelenlegi feladatban.",
        "access.confirm.acknowledge": "Értem a kockázatokat, és folytatni akarom",
        "access.confirm.cancel": "Mégse",
        "access.confirm.enable": "Teljes hozzáférés bekapcsolása",
        "hero.headline": "Az ismeretlenbe",
        "hero.preview": "Előnézet",
        "hero.chooseWorkspace": "Munkaterület választása",
        "session.hierarchy": "Beszélgetések hierarchiája",
        "todo.title": "Teendők",
        "todo.progress.done": "{done} kész",
        "todo.progress.active": "{active} folyamatban",
        "todo.progress.pending": "{pending} várakozik",
        "todo.rowTitle": "Teendőlista frissítése",
        "todo.completed": "{done}/{total} kész",
        "command.attachmentsUnsupported": "/{command} nem fogad mellékletet; előbb távolítsd el őket",
        "ask.rowTitle": "Kérdés feltevése",
        "ask.waiting": "várakozik",
        "ask.cancelled": "megszakítva",
        "ask.cancelledDetail": "Ezt a kérdéssort a válaszok beküldése előtt megszakították.",
        "ask.interrupted": "félbeszakítva",
        "ask.interruptedDetail": "Ezt a kérdéssort a válaszok beküldése előtt félbeszakították.",
        "ask.answered": "{answered}/{total} megválaszolva",
        "ask.skipped": "Nincs megválaszolva",
        "bash.running": "Fut",
        "bash.failed": "Hiba",
        "bash.stopped": "Leállítva",
        "row.running": "Fut",
        "row.failed": "Hiba",
        "row.stopped": "Leállítva",
        "row.input": "BE",
        "row.output": "KI",
        "row.inspect": "Megtekintés",
        "tool.title.search": "Keresés",
        "tool.title.read": "Olvasás",
        "tool.title.bash": "Bash",
        "tool.title.write": "Írás",
        "tool.title.edit": "Szerkesztés",
        "tool.title.code": "Kód",
        "tool.title.generic": "Eszközhívás",
        "tool.title.inspect": "Megtekintés",
        "tool.title.runCordis": "Cordis plugin futtatása",
        "tool.title.stopCordis": "Cordis plugin leállítása",
        "tool.title.removeCordis": "Cordis plugin eltávolítása",
        "tool.title.pwsh": "Pwsh",
        "tool.title.readImage": "Kép olvasása",
        "tool.title.grep": "Grep",
        "tool.title.glob": "Glob",
        "tool.title.webSearch": "Keresés",
        "tool.title.webFetch": "Letöltés",
        "diff.files.one": "{count} fájl",
        "diff.files.other": "{count} fájl",
        "diff.collapseAria": "Diff összecsukása",
        "diff.expandAria": "További {count} diff-sor kibontása",
        "diff.expandRest": "… további {count} sor",
        "read.window": "{total} sorból {shown} látható",
        "read.collapseAria": "Tartalom összecsukása",
        "read.expandAria": "További {count} sor kibontása",
        "read.expandRest": "… további {count} sor",
        "search.paths": "{shown} útvonal",
        "search.paths.truncated": "{total} útvonalból {shown} látható",
        "search.matches": "{shown} találat · {files} fájl",
        "search.matches.truncated": "{total} találatból {shown} látható · {files} fájl",
        "search.noResults": "Nincs találat",
        "search.collapseAria": "Találatok összecsukása",
        "search.expandAria": "További {count} találati sor kibontása",
        "search.expandRest": "… további {count} sor",
        "web.noResults": "Nincs találat",
        "web.sourcesTruncated": "A forráslista levágva",
        "web.http": "HTTP",
        "web.contentTruncated": "A tartalom levágva",
        "details.running": "Futás…",
        "queue.count": "{n} várakozó üzenet",
        "queue.sending": "Küldés…",
        "queue.image": "Várakozó üzenet képe",
        "queue.file": "Várakozó fájl: {name}",
        "queue.edit": "Várakozó üzenet szerkesztése",
        "queue.edit.unsupported": "Nem szöveges tartalmat tartalmaz; a szerkesztés még nem támogatott",
        "queue.save": "Várakozó üzenet mentése",
        "queue.cancelEdit": "Szerkesztés elvetése",
        "queue.remove": "Várakozó üzenet eltávolítása",
        "queue.steer": "Várakozó üzenet átirányítása",
        "queue.steer.unavailable": "Az átirányítás csak akkor érhető el, amíg az ügynök fut",
        "queue.editFailed": "A szerkesztés nem sikerült: lehet, hogy az üzenet elküldése már elkezdődött.",
        "queue.removeFailed": "Az eltávolítás nem sikerült: lehet, hogy az üzenet elküldése már elkezdődött.",
        "queue.steerFailed": "Az átirányítás nem sikerült. Próbáld újra.",
        "terminal.signal": "{signal} szignál",
        "terminal.exitCode": "{code} kilépési kód",
        "terminal.running": "Fut",
        "terminal.failed": "Hiba",
        "terminal.done": "Kész",
        "terminal.noOutput": "Nincs kimenet",
        "terminal.collapseAria": "Kimenet összecsukása",
        "terminal.expandAria": "A maradék {n} kimeneti sor kibontása",
        "terminal.expandRest": "… további {n} sor",
        "terminal.sendInput": "(bemenet küldése)",
        "terminal.session": "Terminál {sessionId}"
      },
      /** Cordis plugin cards and panel — this is how the UI itself is extended. */
      "cordis": {
        "row.defineTitle": "Cordis plugin regisztrálása",
        "row.runTitle": "Cordis plugin futtatása",
        "row.updateTitle": "Cordis plugin frissítése",
        "row.stopTitle": "Cordis plugin leállítása",
        "row.removeTitle": "Cordis plugin eltávolítása",
        "purpose.missing": "(nincs megadott cél)",
        "status.idle": "Kész",
        "status.awaitingApproval": "Jóváhagyásra vár",
        "status.failed": "A futás nem sikerült",
        "status.clientPending": "A kliens aktiválásra kész",
        "status.running": "Fut",
        "status.removed": "Eltávolítva",
        "status.superseded": "Újabb futás érhető el",
        "run.removed": "Ez a csomag már nem létezik",
        "run.superseded": "Alább egy újabb futáskártya érhető el",
        "panel.hint": "A futtatás vezérlői a Beállítások feletti Cordis panelen vannak",
        "panel.plugins.aria": "Cordis pluginok",
        "panel.approvals.aria": "Cordis jóváhagyások",
        "panel.trigger": "Cordis plugin",
        "panel.runningCount": "{count} fut",
        "panel.title": "Cordis pluginok",
        "panel.empty": "Még nincs definiált plugin",
        "panel.loading": "Olvasás…",
        "panel.readFailed": "A pluginlistát nem sikerült beolvasni: {message}",
        "panel.group.current": "Ez a beszélgetés",
        "panel.group.others": "Más beszélgetések",
        "panel.version": "Verzió",
        "panel.current": "Jelenlegi: {packageId}",
        "panel.next": "Következő: {packageId}",
        "action.approve": "Engedélyezés",
        "action.approveOnce": "Csak ennek a verziónak az engedélyezése",
        "action.approvePlugin": "A plugin jövőbeli verzióinak engedélyezése",
        "action.decline": "Elutasítás",
        "action.run": "Futtatás",
        "action.stop": "Leállítás",
        "action.remove": "Eltávolítás",
        "action.retry": "Újra",
        "action.rollback": "Visszaállítás",
        "action.inspect": "Megtekintés",
        "render.failedAbdicated": "A(z) {slot} helyen a megjelenítés nem sikerült; az alapértelmezett felület állt vissza:",
        "render.failedHeld": "A(z) {slot} helyen a megjelenítés nem sikerült:",
        "a11y.defining": "A plugin definiálása",
        "a11y.failed": "A definiálás nem sikerült",
        "a11y.stopped": "A definiálás megszakadt",
        "body.source": "Plugin forráskódja",
        "body.hostCode": "Host",
        "body.clientCode": "Kliens",
        "body.output": "Eredmény",
        "body.copy": "Másolás",
        "body.copied": "Kimásolva"
      },
      /** Delivered files and "present" rows. */
      "deliverables": {
        "presented.nativeUnavailable": "Ehhez a fájlhoz nincs elérhető host-útvonal. Az oldalsávban nézheted meg.",
        "presented.revealError": "A fájlkezelőben nem sikerült megjeleníteni. Próbáld újra.",
        "presented.directoryError": "A tartalmazó mappát nem sikerült megnyitni. Próbáld újra.",
        "presented.directoryOpening": "A tartalmazó mappa megnyitása…",
        "presented.directoryOpened": "A tartalmazó mappa megnyitása kérve",
        "presented.revealed": "A fájlkezelőben való megjelenítés kérve",
        "presented.revealing": "Megjelenítés a fájlkezelőben…",
        "presented.unavailable": "Ezen a hoston nincs asztali környezet fájlok vagy mappák megnyitásához",
        "presented.retry": "Újra",
        "presented.hostError": "A host asztali adatait nem sikerült beolvasni",
        "presented.directory": "Tartalmazó mappa megnyitása",
        "presented.explorer": "Megjelenítés a Fájlkezelőben",
        "presented.finder": "Megjelenítés a Finderben",
        "presented.defaultApp": "Megnyitás az alapértelmezett alkalmazással",
        "presented.more": "További fájlműveletek: {name}",
        "presented.action": "Megnyitás",
        "presented.preview": "Előnézet az oldalsávban",
        "presented.previewButton": "A(z) {name} megnyitása az oldalsávban",
        "presented.previewCard": "A(z) {name} előnézete az oldalsávban",
        "presented.all": "Mind a(z) {count} fájl",
        "presented.expandAria": "Mind a(z) {count} átadott fájl megjelenítése",
        "presented.collapse": "Összecsukás",
        "presented.collapseAria": "Az átadott fájlok összecsukása",
        "presented.opening": "Megnyitás…",
        "presented.opened": "Megnyitva az alapértelmezett alkalmazásban",
        "presented.error": "A megnyitás nem sikerült. Kattints az újrapróbáláshoz.",
        "presented.file": "Fájl",
        "row.title": "Fájlok átadása",
        "row.running": "Átadás",
        "row.ok": "Átadva",
        "row.error": "Az átadás nem sikerült",
        "row.stopped": "Megszakítva",
        "row.inspect": "Hívás megtekintése",
        "presented.open": "A(z) {name} megnyitása az alapértelmezett alkalmazással",
        "produced.label": "Módosított fájlok",
        "produced.moreOne": "+ 1 fájl",
        "produced.more": "+ {count} fájl",
        "produced.open": "A(z) {name} megnyitása"
      },
      /** Subagent tree and its read-only states. */
      "subagent": {
        "diagnostic.corrupt": "sérült beszélgetésrekord",
        "diagnostic.unsupported": "nem támogatott alügynök-rekordverzió",
        "diagnostic.unavailable": "a beszélgetésrekord átmenetileg nem elérhető",
        "duration.seconds": "{seconds} mp",
        "duration.minutes": "{minutes} p {seconds} mp",
        "duration.hours": "{hours} ó {minutes} p {seconds} mp",
        "duration.days": "{days} nap",
        "duration.daysHours": "{days} nap {hours} ó",
        "duration.months": "~{months} hó",
        "duration.monthsDays": "~{months} hó {days} nap",
        "duration.years": "~{years} év",
        "duration.yearsMonths": "~{years} év {months} hó",
        "duration.exactDays": "{days} nap {hours} ó {minutes} p {seconds} mp",
        "duration.exactTitle": "Teljes aktív időtartam: {duration}",
        "tokens.thousand": "{value} e",
        "tokens.million": "{value} M",
        "tokens.total": "{value} zseton",
        "loading.label": "Alügynökök betöltése…",
        "loading.aria": "Alügynökök betöltése",
        "load.error": "Az alügynököket nem sikerült betölteni",
        "retry": "Újra",
        "mode.oneShot": "egyszeri",
        "mode.continuable": "folytatható",
        "activity.running": "fut",
        "activity.inactive": "nem fut",
        "branch.collapse": "{label} leszármazottak összecsukása",
        "branch.expand": "{label} leszármazottak kibontása",
        "count.total.one": "{count} alügynök",
        "count.total.other": "{count} alügynök",
        "count.running.one": "{count} alügynök fut",
        "count.running.other": "{count} alügynök fut",
        "switcher.aria": "Alügynök váltása: {title}",
        "tree.aria": "Alügynök beszélgetések",
        "readonly.oneShot.title": "Egyszeri alügynök rekordja",
        "readonly.title": "Ez az alügynök egyelőre csak olvasható",
        "readonly.oneShot.body": "Az egyszeri feladatok nem fogadnak további üzeneteket; itt a teljes végrehajtási rekordot nézheted át.",
        "readonly.body": "A szülő beszélgetés offline; nyisd meg újra az üzenetküldés folytatásához."
      },
      /** Right-hand dock: tabs, panes, fullscreen. */
      "sidebarRight": {
        "chrome.expand": "Oldalsáv megnyitása",
        "chrome.expandAria": "Jobb oldalsáv megnyitása",
        "chrome.collapse": "Oldalsáv összecsukása",
        "chrome.collapseAria": "Jobb oldalsáv összecsukása",
        "chrome.toFullscreen": "Teljes képernyő",
        "chrome.exitFullscreen": "Kilépés a teljes képernyőből",
        "dock.emptyPane": "Üres panel",
        "dock.splitPane": "Osztás",
        "dock.splitPaneDisabled": "Két panel a maximum",
        "dock.splitPaneNarrow": "Nincs elég szélesség az osztáshoz; szélesítsd az oldalsávot",
        "dock.closeTab": "Bezárás",
        "dock.addTab": "Új lap",
        "dock.dockFloat": "Vissza az oldalsávba",
        "dock.closeFloat": "Bezárás",
        "dock.drop.center": "Áthelyezés ide",
        "dock.drop.left": "Bal oldali osztás hozzáadása",
        "dock.drop.right": "Jobb oldali osztás hozzáadása",
        "dock.drop.top": "Felső osztás hozzáadása",
        "dock.drop.bottom": "Alsó osztás hozzáadása",
        "tab.guide.title": "Kezdés",
        "tab.unavailable": "Ezt a tartalomtípust itt még semmi nem tudja megjeleníteni."
      },
      /** Workflow run cards. */
      "workflowRun": {
        "run.title": "{name}",
        "run.members.one": "{count} tag",
        "run.members.other": "{count} tag",
        "run.empty": "Egy tag sem indult el",
        "phase.unassigned": "Fázis nélkül",
        "phase.empty": "Üres fázisnév",
        "statusCount.running": "{count} fut",
        "statusCount.completed": "{count} kész",
        "statusCount.failed": "{count} hiba",
        "statusCount.cancelled": "{count} megszakítva",
        "statusCount.interrupted": "{count} félbeszakítva",
        "member.empty": "Üres tagnév",
        "member.open": "A(z) {name} megnyitása",
        "status.running": "Fut",
        "status.completed": "Kész",
        "status.failed": "Hiba",
        "status.cancelled": "Megszakítva",
        "status.interrupted": "Félbeszakítva"
      },
      /** Scheduled reminders. */
      "schedule.catalog": {
        "trigger.one": "{count} emlékeztető",
        "trigger.other": "{count} emlékeztető",
        "list.aria": "Aktív emlékeztetők",
        "status.scheduled": "Ütemezve",
        "status.overdue": "Lejárt",
        "frequency.once": "Egyszer",
        "frequency.every": "Minden {value} {unit}",
        "unit.day.one": "nap",
        "unit.day.other": "nap",
        "unit.hour.one": "óra",
        "unit.hour.other": "óra",
        "unit.minute.one": "perc",
        "unit.minute.other": "perc",
        "unit.second.one": "másodperc",
        "unit.second.other": "másodperc",
        "relative.now": "Most esedékes",
        "relative.future": "{value} {unit} múlva",
        "relative.overdue": "{value} {unit} késésben"
      },
      /** Background job counters. */
      "dsh-client-ui-jobs": {
        "count.live.one": "{count} háttérfeladat fut",
        "count.live.other": "{count} háttérfeladat fut",
        "count.idle.one": "{count} háttérfeladat",
        "count.idle.other": "{count} háttérfeladat",
        "list.aria": "Háttérfeladatok",
        "status.running": "fut",
        "status.stopping": "leállítás alatt",
        "status.completed": "kész",
        "status.killed": "megszakítva",
        "status.failed": "hiba",
        "duration.seconds": "{seconds} mp",
        "duration.minutes": "{minutes} p {seconds} mp",
        "duration.hours": "{hours} ó {minutes} p",
        "duration.title.live": "{duration} ideje fut",
        "duration.title.done": "{duration} ideig tartott"
      },
      /** Default permission mode for new sessions. */
      "dsh-client-ui-permission-presets": {
        "title": "Jogosultság",
        "description": "Az új beszélgetések alapértelmezett jogosultsági módjának kiválasztása",
        "loading": "Betöltés",
        "unavailable": "Nem elérhető",
        "preset.readOnly": "Csak olvasás",
        "preset.workspaceWrite": "Írás a munkaterületen",
        "preset.fullAccess": "Teljes hozzáférés",
        "confirm.title": "Bekapcsolod a teljes hozzáférést?",
        "confirm.description": "A teljes hozzáférés révén az új beszélgetések kevesebb megerősítési lépést kérnek, és több műveletet hajtanak végre közvetlenül, beleértve az érzékeny műveleteket, fájlmódosításokat vagy külső parancsokat. Csak akkor használd, ha megbízol a következő feladatokban.",
        "confirm.acknowledge": "Értem a kockázatokat, és folytatni akarom",
        "confirm.cancel": "Mégse",
        "confirm.enable": "Teljes hozzáférés bekapcsolása"
      },
      /** Appearance and font size settings. */
      "dsh-client-ui-theme": {
        "appearance.title": "Megjelenés",
        "appearance.light": "Világos",
        "appearance.dark": "Sötét",
        "appearance.system": "Rendszer",
        "fontSize.title": "Betűméret",
        "fontSize.description": "Csak a beszélgetés tartalmára hat",
        "fontSize.unit": "px",
        "fontSize.increase": "Betűméret növelése",
        "fontSize.decrease": "Betűméret csökkentése"
      },
      /** `/` and `@` trigger suggestions. */
      "dsh-client-ui-input-trigger": {
        "command": "Parancsok",
        "skill": "Készségek",
        "subagent": "Alügynökök",
        "loading": "Betöltés…",
        "drill.aria": "Mappa böngészése",
        "drill.hint": "Mappa böngészése",
        "drill.key": "Tab",
        "crumbs.aria": "Mappanavigáció",
        "suggestions.aria": "Javaslatok"
      },
      /** Trajectory view: the per-request timeline and record inspector. */
      "trajectory": {
        "view.trajectory": "Pálya",
        "toolbar.aria": "Pálya eszköztára",
        "toolbar.duration": "Időtartam",
        "toolbar.useActualDuration": "Valós időtartam használata",
        "toolbar.useEqualWidth": "Egyenlő szélességű műveletek",
        "toolbar.actualTime": "Valós idő",
        "toolbar.turns": "Körök",
        "toolbar.expandTurns": "Körök kibontása",
        "toolbar.collapseTurns": "Körök összecsukása",
        "toolbar.calls": "Hívások",
        "toolbar.expandCalls": "Hívások kibontása",
        "toolbar.collapseCalls": "Hívások összecsukása",
        "toolbar.search": "Keresés a pályán",
        "toolbar.searchPlaceholder": "Keresés",
        "kind.system": "RENDSZER",
        "kind.user": "FELHASZNÁLÓ",
        "kind.context": "KONTEXTUS",
        "kind.compacted": "TÖMÖRÍTVE",
        "kind.message": "Üzenet",
        "kind.assistant": "ASSZISZTENS",
        "kind.tool": "ESZKÖZ",
        "kind.subtool": "ALESZKÖZ",
        "kind.sub": "Al-",
        "column.input": "Bemenet",
        "column.output": "Kimenet",
        "column.think": "Gondolkodás",
        "column.time": "Idő",
        "column.model": "Modell",
        "column.tools": "Eszközök",
        "turn.label": "{turn}. kör",
        "section.betweenTurns": "Körök között",
        "group.message": "Üzenet",
        "group.step": "{step}. lépés",
        "group.compaction": "{seq}. tömörítés",
        "status.failed": "Hiba",
        "status.pending": "Várakozik",
        "status.completed": "Kész",
        "timing.notAvailable": "Nem elérhető",
        "timing.notRecorded": "Nincs rögzítve",
        "timing.stepStartUnavailable": "A lépés kezdete nem elérhető",
        "timing.firstTokenUnavailable": "Az első zseton nem elérhető",
        "timing.usageUnavailable": "A használat nem elérhető",
        "timing.outputTokensUnavailable": "A kimeneti zsetonok nem elérhetők",
        "timing.durationTooShort": "Az időtartam túl rövid",
        "timing.showLocalTime": "Helyi idő megjelenítése",
        "timing.showUnixTimestamp": "Unix időbélyeg megjelenítése",
        "timing.started": "Kezdés",
        "timing.totalDuration": "Teljes időtartam",
        "timing.ttft": "TTFT",
        "timing.generation": "Generálás",
        "timing.throughput": "Átbocsátás",
        "timing.duration": "Időtartam",
        "timing.source": "Időmérés forrása",
        "timing.sessionTimestamps": "Beszélgetés időbélyegei",
        "timing.sessionTimestampsRunning": "Beszélgetés időbélyegei (fut)",
        "timing.request": "Kérés időzítése",
        "unit.milliseconds": "{value} ms",
        "unit.seconds": "{value} mp",
        "unit.tokens": "{value} zseton",
        "unit.tokensPerSecond": "{value} zseton/s",
        "usage.tokens": "Zsetonok",
        "usage.reasoning": "Következtetés",
        "usage.content": "Tartalom",
        "usage.notReported": "A használat nincs jelentve",
        "usage.input": "Bemenet",
        "usage.cached": "Gyorsítótárazott",
        "usage.cacheCreated": "Gyorsítótár létrehozva",
        "usage.other": "Egyéb",
        "usage.output": "Kimenet",
        "usage.thisRequest": "Ez a kérés",
        "usage.sessionCumulative": "Beszélgetés összesen",
        "options.notRecorded": "A beállítások nincsenek rögzítve",
        "options.json": "Kérésbeállítások JSON",
        "source.unknown": "Ismeretlen",
        "source.user": "Felhasználó",
        "source.plugin": "Plugin",
        "source.pluginNamed": "Plugin · {plugin}",
        "source.goal": "Cél",
        "source.goalRound": "Cél · {round}. kör",
        "source.notRecorded": "A forrás nincs rögzítve",
        "source.messageJson": "Üzenetforrás JSON",
        "tab.summary": "Összefoglaló",
        "tab.rawOutput": "Nyers kimenet",
        "tab.preview": "Előnézet",
        "tab.raw": "Nyers",
        "tab.source": "Forrás",
        "tab.payload": "Terhelés",
        "tab.result": "Eredmény",
        "tab.schema": "Séma",
        "tab.timing": "Időzítés",
        "tab.diff": "Diff",
        "tab.systemPrompt": "Rendszerprompt",
        "tab.tools": "Eszközök",
        "tab.options": "Beállítások",
        "tab.usage": "Használat",
        "record.toolCallOnly": "(csak eszközhívás)",
        "record.noContent": "Nincs tartalom",
        "record.noPayload": "Nem rögzült terhelés",
        "record.noResult": "Nem rögzült eredmény",
        "record.noOutput": "Nincs kimenet",
        "record.schemaUnavailable": "A séma nem elérhető",
        "record.parameters": "Paraméterek",
        "record.resultJson": "Eredmény JSON",
        "record.json": "JSON",
        "record.parametersJson": "paraméterek JSON",
        "record.namedParametersJson": "{name} paraméterek JSON",
        "record.payloadJson": "Terhelés JSON",
        "record.outputJson": "Eredmény JSON",
        "record.thinking": "Gondolkodás",
        "record.systemPromptMissing": "Ebben a kérésben nincs rendszerprompt",
        "record.toolsMissing": "Ebben a kérésben nincsenek eszközök",
        "record.systemPrompt": "Rendszerprompt",
        "record.tools": "Eszközök",
        "block.openSummary": "A(z) #{index}. blokk eszközhívás-összefoglalójának megnyitása",
        "block.openSummaryTitle": "Eszközhívás-összefoglaló megnyitása",
        "block.label": "#{index}. blokk {type}",
        "history.loadingTrajectory": "Pálya betöltése…",
        "history.loadingEarlier": "Korábbi előzmények betöltése…",
        "history.loadingEarlierAria": "Korábbi előzmények betöltése…",
        "history.loadEarlier": "Korábbi előzmények betöltése",
        "history.clickToLoadEarlier": "Kattints a korábbi előzmények betöltéséhez",
        "request.label": "#{request}. kérés",
        "request.labelCompaction": "#{request}. kérés · tömörítés",
        "request.compaction": "Tömörítés · {section}",
        "request.compactionPurpose": "Tömörítés",
        "request.retryProgress": "{retry} / {maximum}",
        "request.collapsedSummary": "Összecsukott {kind} összefoglaló, {summary}",
        "request.collapsedTurn": "kör",
        "request.collapsedAssistant": "asszisztens",
        "request.rowAria": "{request}{kind}, {content}",
        "request.rowPrefix": "{request}. kérés, ",
        "request.rowAriaCompaction": "{request}. kérés, tömörítés",
        "request.noContent": "nincs tartalom",
        "summary.toolCalls.one": "{count} eszközhívás",
        "summary.toolCalls.other": "{count} eszközhívás",
        "summary.steps.one": "{count} lépés",
        "summary.steps.other": "{count} lépés",
        "details.event": "Esemény részletei",
        "details.resize": "Átméretezési esemény részletei",
        "details.resizeTitle": "Húzd az átméretezéshez. Dupla kattintás az visszaállításhoz.",
        "details.close": "Részletek bezárása",
        "details.status": "Állapot",
        "details.purpose": "Rendeltetés",
        "details.provider": "Szolgáltató",
        "details.model": "Modell",
        "details.toolCalls": "Eszközhívások",
        "details.subtoolCalls": "Aleszköz-hívások",
        "details.error": "Hiba",
        "details.failure.auth": "Az API-kulcs érvénytelen",
        "details.retry": "Újrapróbálás",
        "details.scheduled": "Ütemezve",
        "details.retryDelay": "Újrapróbálás késleltetése",
        "details.result": "Eredmény",
        "details.compacted": "Tömörítve",
        "details.assistantMessage": "Asszisztens üzenete",
        "details.source": "Forrás",
        "details.hierarchy": "Hierarchia",
        "details.toolCall": "Eszközhívás",
        "timeline.aria": "Pálya idővonala",
        "timeline.overviewAria": "Idővonal áttekintése; húzd vízszintesen az események fókuszálásához",
        "timeline.noTimingData": "Nincs időzítési adat",
        "timeline.total": "Összesen {duration}",
        "timeline.started": "Kezdés: {time}",
        "timeline.ttftDecoding": "TTFT {ttft} · Dekódolás {decoding}",
        "layout.compacting": "Kontextus tömörítése…",
        "layout.compactionFailed": "A tömörítés nem sikerült",
        "layout.compacted": "Kontextus tömörítve",
        "layout.toolCallOnly": "Csak eszközhívás",
        "layout.imageOnly": "Képek ×{count}",
        "layout.fileAttachments": "Fájlok ×{count}",
        "layout.initialSystemPrompt": "Kezdeti rendszerprompt",
        "layout.systemPromptUpdated": "Rendszerprompt frissítve",
        "layout.toolsUpdated": "Eszközök frissítve",
        "layout.systemPromptAndToolsUpdated": "Rendszerprompt és eszközök frissítve",
        "layout.compactionInterrupted": "A tömörítés a befejezés előtt megszakadt."
      }
    };

    /** Hungarian strings (default for this installation). */
    var hu = {
      "turns": "kör",
      "steps": "lépés",
      "token": "zseton",
      "cache": "gyorsítótár",
      "cost": "költség",
      "dailyAverage": "napi átlag",
      "balance": "egyenleg",
      "balanceLoading": "betöltés…",
      "balanceUnavailable": "nem elérhető",
      "balanceTitle": "Élő egyenleg a DeepSeek számláról, szerveroldali lekérdezéssel.",
      "balanceErrorTitle": "A szerveroldali egyenleg-lekérdezés nem sikerült: ",
      "costTitle": "Költség: a hivatalos ártáblából, kérésenként számolva (USD).",
      "rowTitle": "Használat és költség. A költség a hivatalos ártáblából becsült érték.",
      "usageTooltipHead": "Használat és költség (becslés a hivatalos ártáblával)",
      "usageSessionCost": "Ez a beszélgetés: {cost}",
      "usageSessionTokens": "Ez a beszélgetés: {tokens} zseton",
      "usageWindowCost": "Költség ({days} nap): {cost}",
      "usageWindowAverage": "Napi átlag ({days} nap): {cost}/nap",
      "usageActiveDays": "Aktív nap: {days} (átlag {cost}/nap)",
      "usageWindowTokens": "Zseton ({days} nap): {total} — nem cache-elt {miss}, cache-találat {hit}, kimenet {out}",
      "usageWindowRequests": "Kérések: {count}",
      "usageSavingsHead": "Megtakarítás — delegált munka az ingyenes láncon",
      "usageSavingsAmount": "Megtakarítás: {saved} (ennyibe került volna a fizetős úton)",
      "usageSavingsShare": "Delegálva: {delegated} / {total} kérés ({share})",
      "usageSavingsDetail": "Delegált költség: {cost} · baseline {model}: {baseline} · {sessions} alügynök-session",
      "usageSavingsNone": "Ebben az időszakban még nincs delegált munka",
      "usageDelegatedFree": "Ingyenes láncon: {requests} kérés · {cost} · {sessions} session",
      "usageDelegatedPaid": "Delegálva, de fizetős route-on: {requests} kérés · {cost} (nincs megtakarítás)",
      "usageDelegatedModel": "{tag} {model}: {requests} kérés · {cost}",
      "usageDelegatedFreeTag": "ingyenes",
      "usageDelegatedPaidTag": "fizetős",
      "usageDelegatedLast": "Utolsó delegálás: {when}",
      "usageLoading": "A 30 napos használat betöltése…",
      "usageUnavailable": "A 30 napos összesítő nem érhető el — a host fél még a régi verzió (indítsd újra a szervert).",
      "usagePeakNote": "Csúcsidő csak hétköznap van, magyar idő szerint {window}; hétvégén és kínai ünnepnapokon mindig völgyidőszak (fél ár).",
      "offPeak": "völgyidőszak",
      "peak": "csúcsidőszak",
      "switch": "váltás ",
      "today": "ma ",
      "tomorrow": "holnap ",
      "dayAfterTomorrow": "holnapután ",
      "daysLater": " nap múlva ",
      "unknown": "?",
      "later": "később",
      "langSwitchToEnglish": "Váltás angol nyelvre",
      "langSwitchToHungarian": "Váltás magyar nyelvre",
      "themeSwitchToLight": "Váltás világos módra",
      "themeSwitchToDark": "Váltás sötét módra",
      "gitOpen": "Git repók és előzmények",
      "gitTitle": "Git repók ebben a munkaterületen",
      "gitError": "Hiba: ",
      "gitNoRepositories": "Ebben a munkaterületen nem találtam git repót.",
      "gitNoWorkspace": "Nincs kiválasztott munkaterület.",
      "gitChanged": "módosított: ",
      "gitUntracked": "új: ",
      "refreshPage": "Felület frissítése (újratöltés)",
      "langHungarian": "Magyar nyelv",
      "gitPublic": "Nyilvános",
      "gitPrivateShort": "titkos",
      "gitPublicShort": "nyilvános",
      "gitCommitDisabled": "Nincs mit commitolni",
      "gitPushDisabled": "Nincs feltolatlan commit",
      "deployNow": "Élesítés: a profil-patch újraírása, majd azonnali újraindítás (a rendszertálca ikon végzi el)",
      "restartRunning": "Újraindítás…",
      "restartStarted": "Újraindítás elindult…",
      "deployRunning": "Élesítés…",
      "deployRestarting": "Újraindítás az élesítéshez…",
      "deployStarted": "Élesítés elindult…",
      "deployFailed": "Az élesítés nem indult el",
      "sshOpen": "SSH kapcsolatok és kulcsok",
      "sshTitle": "SSH beállítások",
      "sshDirectory": "Könyvtár:",
      "sshConnections": "Kapcsolatok",
      "sshNoConnections": "Nincs kapcsolat a ~/.ssh/config fájlban.",
      "sshKeys": "Kulcsok (ujjlenyomat)",
      "sshNoKeys": "Nincs nyilvános kulcs a ~/.ssh mappában.",
      "sshKnownHosts": "Ismert hosztok:",
      "sshAgentKeys": "Az agentben lévő kulcsok",
      "sshNoDirectory": "Nincs ~/.ssh könyvtár:",
      "sshConnect": "Kapcsolódás",
      "sshTesting": "Kapcsolódás…",
      "sshTest": "Teszt",
      "sshWorking": "Dolgozom…",
      "sshDisconnect": "Lecsatlakozás",
      "sshConnectHint": "Élő SSH munkamenet nyitása ehhez a kapcsolathoz",
      "sshDisconnectHint": "Az élő SSH munkamenet bontása",
      "sshConnected": "A munkamenet nyitva",
      "sshDisconnected": "A munkamenet lezárva",
      "sshSessionLive": "élő munkamenet",
      "sshTestOk": "A kapcsolat rendben",
      "sshTestHint": "SSH kapcsolat kipróbálása (batch mód, 15 másodperc)",
      "sshTestNoHostName": "Ennek a bejegyzésnek nincs HostName mezője, ezért nem tesztelhető",
      "sshEditConfig": "config szerkesztése",
      "sshEditConfigHint": "A ~/.ssh/config megnyitása a beépített szerkesztőben",
      "sshEditorTitle": "SSH config szerkesztése",
      "sshEditorHint": "Mentés előtt biztonsági másolat készül a fájlról.",
      "sshEditorClose": "Bezárás",
      "sshSaving": "Mentés…",
      "cmdOpen": "Terminál és futtatható parancsok",
      "cmdTitle": "Terminálok",
      "cmdGuideDescription": "Parancsok futtatása a munkaterületen, külső terminálablak nélkül",
      "cmdQuickRun": "Gyorsparancs futtatása új terminálban",
      "cmdQuickRemove": "Gyorsparancs törlése",
      "cmdQuickHint": "Ments el egy parancsot a 💾 gombbal, és legközelebb egy kattintás lesz.",
      "cmdRunHint": "Új terminál indítása ezzel a paranccsal",
      "cmdSaveHint": "A parancs mentése gyorsparancsként (a 💾 gombbal)",
      "cmdRunsHint": "A futó terminálok állapotának frissítése",
      "cmdClearHint": "A lezárt terminálok eltávolítása a panelről",
      "cmdNoRunnables": "Nincs mentett gyorsparancs. Írj be egyet lent, és mentsd el a 💾 gombbal.",
      "cmdPlaceholder": "Parancs (Enter = futtatás, Ctrl+Enter = mentés gombként)",
      "cmdPlaceholderHint": "Többsoros parancs is beírható: Enter futtat, Shift+Enter új sort nyit, Ctrl+Enter gyorsparancsként menti a teljes blokkot.",
      "cmdNewTerminalHint": "Új üres terminál indítása a munkaterület gyökerében",
      "cmdRun": "Futtatás",
      "cmdSave": "Mentés gombként",
      "cmdStop": "Leállítás",
      "cmdRunning": "Fut…",
      "cmdTerminals": "terminál",
      "cmdRunningShort": "fut",
      "cmdNoTerminals": "Még nincs terminál. Indíts egyet a fenti gombokkal vagy a parancssorral.",
      "cmdNewTerminal": "Új terminál indítása",
      "cmdSelectTerminal": "Ez a terminál lesz a kijelölt",
      "cmdCloseTerminal": "Terminál bezárása (futó parancsot leállítja)",
      "cmdZoomIn": "Kibontás a teljes szélességre",
      "cmdZoomOut": "Vissza a rácsba",
      "cmdSearchPlaceholder": "Szűrés a kimenetben…",
      "cmdSearchHint": "A kimenet szűrése a keresett szövegre",
      "cmdNoMatch": "(nincs egyező sor)",
      "cmdExited": "Kilépett:",
      "cmdLines": "sor",
      "cmdDirectoryHint": "A terminál munkakönyvtára:",
      "cmdRunsIn": "A parancsok ebben a mappában futnak:",
      "cmdRunsInUnknown": "Nincs ismert munkakönyvtár ehhez a nézethez.",
      "cmdStopTree": "Leállítás — a teljes folyamatfa (a shell és amit indított)",
      "cmdInterrupt": "Ctrl+C küldése: megszakítja a futó parancsot (ha nem engedelmeskedik, leáll a folyamatfa)",
      "cmdInterruptShort": "Megszakítás (Ctrl+C)",
      "cmdInterrupting": "megszakítás…",
      "cmdInterruptForceKilled": "A folyamat nem engedelmeskedett a Ctrl+C-nek, ezért a teljes folyamatfa leállt.",
      "cmdInterruptShortcut": "Ctrl+C = megszakítás, Esc = sor törlése, Ctrl+D = bemenet vége",
      "cmdFollowTail": "Követés",
      "cmdFollowTailHint": "A kimenet végének követése. Felfelé görgetve kikapcsol; ez a gomb kapcsolja vissza, és odaugrik az utolsó sorhoz.",
      "cmdResizeHint": "Húzd az egérrel a terminál magasságának állításához (dupla kattintás: vissza az alapméretre)",
      "cmdFontFace": "Betűtípus",
      "cmdFontSize": "Betűméret",
      "cmdHiddenLines": "korábbi sor elrejtve:",
      "cmdSecretPlaceholder": "Titkos bemenet (nem látszik, amit beírsz)",
      "cmdSecretHint": "Ez a kimenet jelszóra vagy titkos adatra kérdezhet. A mező elrejti a beírt karaktereket; a 🙈/👁 gombbal kapcsolható.",
      "cmdEchoShow": "Bevitel megjelenítése",
      "cmdEchoShowHint": "A beírt szöveg láthatóvá tétele (jelszónál maradjon rejtve)",
      "cmdEchoHide": "Bevitel elrejtése",
      "cmdEchoHideHint": "A beírt szöveg elrejtése (jelszóhoz ez a biztonságos)",
      "cmdStdinPlaceholder": "Bemenet a futó parancsnak (Enter = küldés)",
      "cmdStdinSend": "Küldés",
      "cmdStdinSendHint": "A sor elküldése a folyamat bemenetére",
      "restartHarness": "A Harness újraindítása (friss belépési token; a rendszertálca ikon végzi el, ezért nem szakad félbe)",
      "gitCommit": "Commit",
      "gitPush": "Push",
      "gitRelease": "Kiadás",
      "gitReleaseHint": "Kiadás: verzióemelés + commit + tag + push + GitHub Release. A tools\\release.ps1 fut le, kérdés nélkül (patch verzió). Parancssorból: tools\\release.cmd",
      "gitCommitPlaceholder": "Commit üzenet (üresen automatikus)",
      "gitAheadBehindHint": "↑ = hány commit vár feltolásra (Push), ↓ = hány commit van a távoli ágon, ami nálad még nincs meg. Ez commitok száma, nem fájloké.",
      "gitCommitFiles": "commitra:",
      "gitChangedHint": "A commit a munkaterület MINDEN változását viszi (git add -A): a fenti szám a commitba kerülő fájlok mennyisége.",
      "gitCommitLangToggle": "A commit üzenete most {lang} nyelven születik. Kattints a váltáshoz.",
      "gitStatusTooltip": "↑ commit feltolásra vár\n↓ commit a távoli ágon\n\nEz a szám commitokat jelent, nem fájlokat. A „commitra” szám mutatja, hány fájl kerül a következő commitba.",
      "langEnglish": "Angol nyelv",
      "ghTitle": "GitHub",
      "ghNotInstalled": "A GitHub CLI (gh) nincs telepítve a gépen.",
      "ghLogin": "Belépés GitHubra",
      "ghLoggedIn": "Bejelentkezve",
      "ghNotLoggedIn": "Nincs bejelentkezve",
      "ghLoginHint": "A gh CLI a böngészőben nyit egy bejelentkezési oldalt, és ott kell jóváhagyni.",
      "ghPickRepo": "Válassz repót a munkaterülethez",
      "ghCreateRepo": "Új repó létrehozása",
      "ghRepoName": "Repó neve",
      "ghPrivate": "Titkos (privát)",
      "ghCreate": "Létrehozás és feltöltés",
      "ghConnect": "Csatlakoztatás",
      "ghWorking": "Folyamatban…",
      "ghDone": "Kész",
      "ghCreating": "Repó létrehozása…",
      "gitPushing": "Feltolás…",
      "gitCommitting": "Commitolás…",
      "ghRefresh": "GitHub adatok frissítése",
      "approvalWaitTitle": "Jóváhagyásra vár",
      "approvalHeadline": "A(z) {tool} eszköz emelt szintű futtatást kér",
      "approvalHeadlineEscalation": "A(z) {tool} eszköz szélesebb hozzáférést kér",
      "approvalTypeLine": "Hozzáféréstípus: {type}",
      "approvalReasonLine": "Indok: {reason}",
      "approvalCommandLine": "A jóváhagyandó parancs:",
      "approvalReject": "Elutasítás",
      "approvalRejectHint": "A művelet nem fut le",
      "approvalAllowOnce": "Engedélyezés egyszer",
      "approvalAllowOnceHint": "Csak erre az egyszeri alkalomra engedélyezi",
      "approvalRememberTool": "Mindig: {tool}",
      "approvalRememberToolHint": "Ezentúl nem kérdez rá, ha a(z) {tool} eszköz ilyen típusú hozzáférést kér",
      "approvalRememberAll": "Mindig: minden eszköz",
      "approvalRememberAllHint": "Ezentúl nem kérdez rá, ha bármely eszköz ilyen típusú hozzáférést kér",
      "approvalRememberHint": "A „Mindig” gomb elmenti ezt a hozzájárulás-típust, és legközelebb már nem kérdez rá. A 🛡 gombnál bármikor visszavonható.",
      "approvalRemembering": "Megjegyzés…",
      "approvalRemembered": "Megjegyezve",
      "approvalWriteFailed": "A művelet nem sikerült:",
      "approvalPermissionsOpen": "Engedélyek (megjegyzett hozzájárulások)",
      "approvalPermissionsTitle": "Megjegyzett hozzájárulások",
      "approvalPermissionsHint": "Az itt felsorolt hozzáféréstípusokra a Harness többé nem kérdez rá: a kérést a szerver automatikusan engedélyezi. Visszavonás után ismét kérdezni fog.",
      "approvalNoRules": "Nincs megjegyzett hozzájárulás. A sárga jóváhagyás-kártyán a „Mindig” gombbal vehetsz fel egyet.",
      "approvalRuleEveryTool": "minden eszközre érvényes",
      "approvalRuleTools": "csak ezekre az eszközökre: {tools}",
      "approvalRuleUsed": "alkalmazva: {count}×",
      "approvalRuleCreated": "létrehozva: {date}",
      "approvalRevoke": "Visszavonás",
      "approvalRefresh": "Frissítés",
      "approvalClearAll": "Összes törlése",
      "approvalClearAllHint": "Minden megjegyzett hozzájárulás törlése (ezután minden kérés ismét kérdez)",
      "approvalLogTitle": "Automatikus engedélyezések",
      "approvalClearLog": "Napló törlése",
      "approvalNoLog": "Még nem volt automatikus engedélyezés.",
      "approvalLoadFailed": "Az engedélyek betöltése nem sikerült:"
    };

    /** English strings for the same row. */
    var en = {
      "turns": "turns",
      "steps": "steps",
      "token": "tokens",
      "cache": "cache",
      "cost": "cost",
      "dailyAverage": "daily avg",
      "balance": "balance",
      "balanceLoading": "loading…",
      "balanceUnavailable": "unavailable",
      "balanceTitle": "Live balance from the DeepSeek account, queried on the host.",
      "balanceErrorTitle": "The host-side balance query failed: ",
      "costTitle": "Cost: computed per request from the official price table (USD).",
      "rowTitle": "Usage and cost. The cost is an estimate from the official price table.",
      "usageTooltipHead": "Usage and cost (estimated with the official price table)",
      "usageSessionCost": "This conversation: {cost}",
      "usageSessionTokens": "This conversation: {tokens} tokens",
      "usageWindowCost": "Cost ({days} days): {cost}",
      "usageWindowAverage": "Daily average ({days} days): {cost}/day",
      "usageActiveDays": "Active days: {days} (average {cost}/day)",
      "usageWindowTokens": "Tokens ({days} days): {total} — uncached {miss}, cache hit {hit}, output {out}",
      "usageWindowRequests": "Requests: {count}",
      "usageSavingsHead": "Savings — delegated work on the free chain",
      "usageSavingsAmount": "Savings: {saved} (what the paid route would have cost)",
      "usageSavingsShare": "Delegated: {delegated} / {total} requests ({share})",
      "usageSavingsDetail": "Delegated cost: {cost} · baseline {model}: {baseline} · {sessions} subagent sessions",
      "usageSavingsNone": "No delegated work in this period yet",
      "usageDelegatedFree": "On the free chain: {requests} requests · {cost} · {sessions} sessions",
      "usageDelegatedPaid": "Delegated, but on the paid route: {requests} requests · {cost} (no saving)",
      "usageDelegatedModel": "{tag} {model}: {requests} requests · {cost}",
      "usageDelegatedFreeTag": "free",
      "usageDelegatedPaidTag": "paid",
      "usageDelegatedLast": "Last delegation: {when}",
      "usageLoading": "Loading the 30-day usage…",
      "usageUnavailable": "The 30-day summary is unavailable — the host half is still the old build (restart the server).",
      "usagePeakNote": "Peak hours are weekdays only, {window} Hungarian time; weekends and Chinese public holidays are always off-peak (half price).",
      "offPeak": "off-peak",
      "peak": "peak",
      "switch": "switches ",
      "today": "today ",
      "tomorrow": "tomorrow ",
      "dayAfterTomorrow": "in two days ",
      "daysLater": " days later ",
      "unknown": "?",
      "later": "later",
      "langSwitchToEnglish": "Switch to English",
      "langSwitchToHungarian": "Switch to Hungarian",
      "themeSwitchToLight": "Switch to light mode",
      "themeSwitchToDark": "Switch to dark mode",
      "gitOpen": "Git repositories and history",
      "gitTitle": "Git repositories in this workspace",
      "gitError": "Error: ",
      "gitNoRepositories": "No git repository found in this workspace.",
      "gitNoWorkspace": "No workspace selected.",
      "gitChanged": "changed: ",
      "gitUntracked": "new: ",
      "refreshPage": "Reload the interface",
      "langHungarian": "Hungarian language",
      "gitPublic": "Public",
      "gitPrivateShort": "private",
      "gitPublicShort": "public",
      "gitCommitDisabled": "Nothing to commit",
      "gitPushDisabled": "No commits to push",
      "deployNow": "Deploy (reinstall the plugin)",
      "restartRunning": "Restarting…",
      "restartStarted": "Restart started…",
      "deployRunning": "Deploying…",
      "deployRestarting": "Restarting for the deploy…",
      "deployStarted": "Deploy started…",
      "deployFailed": "The deploy did not start",
      "sshOpen": "SSH connections and keys",
      "sshTitle": "SSH setup",
      "sshDirectory": "Directory:",
      "sshConnections": "Connections",
      "sshNoConnections": "No connection in ~/.ssh/config.",
      "sshKeys": "Keys (fingerprint)",
      "sshNoKeys": "No public key in ~/.ssh.",
      "sshKnownHosts": "Known hosts:",
      "sshAgentKeys": "Keys loaded in the agent",
      "sshNoDirectory": "No ~/.ssh directory:",
      "sshConnect": "Connect",
      "sshTesting": "Connecting…",
      "sshTest": "Test",
      "sshWorking": "Working…",
      "sshDisconnect": "Disconnect",
      "sshConnectHint": "Open a live SSH session for this connection",
      "sshDisconnectHint": "Close the live SSH session",
      "sshConnected": "The session is open",
      "sshDisconnected": "The session is closed",
      "sshSessionLive": "live session",
      "sshTestOk": "The connection works",
      "sshTestHint": "Try the SSH connection (batch mode, 15 seconds)",
      "sshTestNoHostName": "This entry has no HostName, so it cannot be tested",
      "sshEditConfig": "edit config",
      "sshEditConfigHint": "Open ~/.ssh/config in the built-in editor",
      "sshEditorTitle": "Edit the SSH config",
      "sshEditorHint": "A backup of the file is written before saving.",
      "sshEditorClose": "Close",
      "sshSaving": "Saving…",
      "cmdOpen": "Terminal and run commands",
      "cmdTitle": "Terminals",
      "cmdGuideDescription": "Run commands in the workspace without an external terminal window",
      "cmdQuickRun": "Run the quick command in a new terminal",
      "cmdQuickRemove": "Remove the quick command",
      "cmdQuickHint": "Save a command with the 💾 button and it becomes one click next time.",
      "cmdPlaceholderHint": "A multi-line command is fine: Enter runs it, Shift+Enter opens a new line, Ctrl+Enter saves the whole block as a quick command.",
      "cmdNewTerminalHint": "Start a new empty terminal at the workspace root",
      "cmdRunHint": "Start a new terminal with this command",
      "cmdSaveHint": "Save the command as a quick command (the 💾 button)",
      "cmdRunsHint": "Refresh the state of the running terminals",
      "cmdClearHint": "Remove the finished terminals from the panel",
      "cmdNoRunnables": "No saved quick command. Type one below and save it with the 💾 button.",
      "cmdPlaceholder": "Command (Enter = run, Ctrl+Enter = save as button)",
      "cmdRun": "Run",
      "cmdSave": "Save as button",
      "cmdStop": "Stop",
      "cmdRunning": "Running…",
      "cmdTerminals": "terminals",
      "cmdRunningShort": "running",
      "cmdNoTerminals": "No terminal yet. Start one with the buttons above or the command line.",
      "cmdNewTerminal": "Start a new terminal",
      "cmdSelectTerminal": "Make this the selected terminal",
      "cmdCloseTerminal": "Close the terminal (stops a running command)",
      "cmdZoomIn": "Expand to full width",
      "cmdZoomOut": "Back to the grid",
      "cmdSearchPlaceholder": "Filter the output…",
      "cmdSearchHint": "Filter the output to the searched text",
      "cmdNoMatch": "(no matching line)",
      "cmdExited": "Exited:",
      "cmdLines": "lines",
      "cmdDirectoryHint": "Working directory of this terminal:",
      "cmdRunsIn": "Commands run in this directory:",
      "cmdRunsInUnknown": "No known working directory for this view.",
      "cmdStopTree": "Stop — the whole process tree (the shell and what it started)",
      "cmdInterrupt": "Send Ctrl+C: interrupts the running command (the process tree is stopped if it refuses)",
      "cmdInterruptShort": "Interrupt (Ctrl+C)",
      "cmdInterrupting": "interrupting…",
      "cmdInterruptForceKilled": "The process did not answer Ctrl+C, so the whole process tree was stopped.",
      "cmdInterruptShortcut": "Ctrl+C = interrupt, Esc = clear line, Ctrl+D = end of input",
      "cmdFollowTail": "Follow",
      "cmdFollowTailHint": "Follow the end of the output. Scrolling up turns it off; this button turns it back on and jumps to the last line.",
      "cmdResizeHint": "Drag with the mouse to change the terminal's height (double click: back to the default)",
      "cmdFontFace": "Typeface",
      "cmdFontSize": "Font size",
      "cmdHiddenLines": "earlier lines hidden:",
      "cmdSecretPlaceholder": "Secret input (what you type is hidden)",
      "cmdSecretHint": "This output may be asking for a password or another secret. The field hides what you type; the 🙈/👁 button toggles it.",
      "cmdEchoShow": "Reveal the input",
      "cmdEchoShowHint": "Show what is typed (keep it hidden for a password)",
      "cmdEchoHide": "Hide the input",
      "cmdEchoHideHint": "Hide what is typed (this is the safe choice for a password)",
      "cmdStdinPlaceholder": "Input for the running command (Enter sends)",
      "cmdStdinSend": "Send",
      "cmdStdinSendHint": "Send the line to the process input",
      "restartHarness": "Restart the Harness (fresh sign-in token)",
      "gitCommit": "Commit",
      "gitPush": "Push",
      "gitRelease": "Release",
      "gitReleaseHint": "Release: version bump + commit + tag + push + GitHub Release. Runs tools\\release.ps1 without asking (patch bump). From a shell: tools\\release.cmd",
      "gitCommitPlaceholder": "Commit message (empty = automatic)",
      "gitAheadBehindHint": "↑ = how many commits are waiting to be pushed (Push), ↓ = how many commits exist on the remote branch that you do not have yet. These count commits, not files.",
      "gitCommitFiles": "to commit:",
      "gitChangedHint": "A commit takes EVERY change in the workspace (git add -A): the number above is how many files go into the commit.",
      "gitCommitLangToggle": "The commit message is written in {lang} right now. Click to switch.",
      "gitStatusTooltip": "↑ commits waiting to be pushed\n↓ commits on the remote branch\n\nThese are commit counts, not file counts. The \"to commit\" number shows how many files go into the next commit.",
      "langEnglish": "English language",
      "ghTitle": "GitHub",
      "ghNotInstalled": "The GitHub CLI (gh) is not installed on this machine.",
      "ghLogin": "Sign in to GitHub",
      "ghLoggedIn": "Signed in",
      "ghNotLoggedIn": "Not signed in",
      "ghLoginHint": "The gh CLI opens a browser page for sign-in; approve it there.",
      "ghPickRepo": "Pick a repository for this workspace",
      "ghCreateRepo": "Create a new repository",
      "ghRepoName": "Repository name",
      "ghPrivate": "Private",
      "ghCreate": "Create and push",
      "ghConnect": "Connect",
      "ghWorking": "Working…",
      "ghDone": "Done",
      "ghCreating": "Creating repository…",
      "gitPushing": "Pushing…",
      "gitCommitting": "Committing…",
      "ghRefresh": "Refresh GitHub data",
      "approvalWaitTitle": "Waiting for approval",
      "approvalHeadline": "Tool {tool} requests privileged execution",
      "approvalHeadlineEscalation": "Tool {tool} requests wider access",
      "approvalTypeLine": "Access type: {type}",
      "approvalReasonLine": "Reason: {reason}",
      "approvalCommandLine": "The command to approve:",
      "approvalReject": "Reject",
      "approvalRejectHint": "The operation does not run",
      "approvalAllowOnce": "Allow once",
      "approvalAllowOnceHint": "Allows this one occurrence only",
      "approvalRememberTool": "Always: {tool}",
      "approvalRememberToolHint": "Never asks again when tool {tool} requests this access type",
      "approvalRememberAll": "Always: every tool",
      "approvalRememberAllHint": "Never asks again when any tool requests this access type",
      "approvalRememberHint": "An “Always” button stores this approval type, so it will not ask again. It can be revoked behind the 🛡 button at any time.",
      "approvalRemembering": "Remembering…",
      "approvalRemembered": "Remembered",
      "approvalWriteFailed": "The operation failed:",
      "approvalPermissionsOpen": "Permissions (remembered approvals)",
      "approvalPermissionsTitle": "Remembered approvals",
      "approvalPermissionsHint": "For the access types listed here the Harness no longer asks: the server allows the request automatically. After a revoke it asks again.",
      "approvalNoRules": "No remembered approval yet. The “Always” button on the yellow approval card adds one.",
      "approvalRuleEveryTool": "valid for every tool",
      "approvalRuleTools": "only for these tools: {tools}",
      "approvalRuleUsed": "applied: {count}×",
      "approvalRuleCreated": "created: {date}",
      "approvalRevoke": "Revoke",
      "approvalRefresh": "Refresh",
      "approvalClearAll": "Clear all",
      "approvalClearAllHint": "Delete every remembered approval (every request will ask again)",
      "approvalLogTitle": "Automatic allowances",
      "approvalClearLog": "Clear log",
      "approvalNoLog": "No automatic allowance yet.",
      "approvalLoadFailed": "Loading the approvals failed:"
    };

    /**
     * The price table lives on the HOST now (`MODEL_PRICES` in the host half).
     *
     * A correct cost needs the model that served each request and the rate in
     * force at that instant (peak is double, and the peak windows are UTC
     * weekday hours). The browser only sees one session's aggregate tokens, so
     * every figure it could compute was a guess — that guess is what the row
     * used to show as "költség" and "napi átlag".
     */

    /** Where the host half publishes the balance. */
    var BALANCE_ROUTE = "/ui-extras/balance";

    /** Where the host half publishes the 30-day token and cost usage. */
    var USAGE_ROUTE = "/ui-extras/usage";

    /** How many days the usage statistic covers. */
    var USAGE_DAYS = 30;

    /**
     * DeepSeek's rate windows, from the official pricing page: the PEAK rate
     * applies on a NON-HOLIDAY WEEKDAY between 01:00-04:00 and 06:00-10:00 UTC.
     * Everything else — the whole weekend, and every Chinese public holiday — is
     * off-peak at half the peak rate. (The provider says so explicitly: weekends
     * with adjusted working days and Chinese public holidays are all billed at
     * off-peak rates.)
     *
     * The windows are anchored to UTC and shown in Hungarian local time; the
     * local hours move with daylight saving, so they are computed, never typed
     * in. The earlier schedule modelled the retired "daily 16:30-00:30"
     * discount, which made both the pill and every price estimate wrong.
     */
    var PEAK_WINDOWS_UTC = [[1, 4], [6, 10]];

    /** Beijing offset from UTC in minutes; the holiday calendar is Chinese. */
    var BEIJING_OFFSET_MINUTES = 8 * 60;

    /**
     * Chinese public holidays as BEIJING dates — the same table as the host
     * half's (`CHINESE_HOLIDAYS` in lib/index.js), which owns the actual
     * pricing. This copy only drives the row's peak/off-peak pill, and
     * `tools/check-plugin.mjs` compares the two so they cannot drift apart.
     *
     * Source: State Council notice for 2026, Guo Ban Fa Ming Dian [2025] No. 7
     * (New Year 1/1-3, Spring Festival 2/15-23, Qingming 4/4-6, Labor Day
     * 5/1-5, Dragon Boat 6/19-21, Mid-Autumn 9/25-27, National Day 10/1-7).
     * Refresh when the next year's notice appears.
     */
    var CHINESE_HOLIDAYS = (function () {
      var days = {};
      var spread = function (year, month, from, to) {
        for (var day = from; day <= to; day += 1) {
          days[year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day] = true;
        }
      };
      spread(2026, 1, 1, 3);
      spread(2026, 2, 15, 23);
      spread(2026, 4, 4, 6);
      spread(2026, 5, 1, 5);
      spread(2026, 6, 19, 21);
      spread(2026, 9, 25, 27);
      spread(2026, 10, 1, 7);
      return days;
    })();

    /** The Beijing calendar date of an instant, `YYYY-MM-DD`. */
    function beijingDay(date) {
      return new Date(date.getTime() + BEIJING_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
    }

    /** Whether an instant falls on a Chinese public holiday (Beijing date). */
    function isChineseHoliday(date) {
      return CHINESE_HOLIDAYS[beijingDay(date)] === true;
    }

    var HUNGARIAN_TIME_ZONE = "Europe/Budapest";

    /** How often the strip re-reads the balance and the usage (host-cached). */
    var BALANCE_REFRESH_MILLISECONDS = 60000;

    /** One minute in milliseconds; the peak/off-peak scan works in minutes. */
    var DAY_MINUTES = 24 * 60;

    /**
     * The instants at which the peak/off-peak state can change, as UTC hours of
     * a day: the window edges, plus midnight.
     *
     * The state is a function of the weekday, the holiday calendar and the
     * window the hour falls in, so it can ONLY flip where one of those inputs
     * changes: at a window edge (01:00, 04:00, 06:00, 10:00 UTC) or where the
     * calendar day changes. Probing edges instead of every minute is what makes
     * a long horizon affordable — see {@link nextSwitch}.
     */
    var PEAK_EDGE_HOURS_UTC = (function () {
      var hours = [0];
      PEAK_WINDOWS_UTC.forEach(function (window) { hours.push(window[0], window[1]); });
      return hours.sort(function (a, b) { return a - b; });
    })();

    /**
     * How far ahead the next switch is looked for.
     *
     * A Chinese holiday block is longer than a weekend: National Day is seven
     * days (10/01-10/07) and Spring Festival nine (02/15-02/23), so an off-peak
     * stretch can last that long plus the weekend around it. The previous
     * three-day scan therefore found nothing during National Day and the row
     * printed "váltás ?" for a week — a question mark is never a good answer for
     * something that is known. Forty days covers every holiday block in the
     * table with room to spare.
     */
    var SWITCH_SCAN_DAYS = 40;

    /**
     * Whether an instant is billed at the PEAK rate: a non-holiday weekday
     * inside one of the UTC windows. Weekends and Chinese public holidays are
     * always off-peak. The cost itself is computed on the HOST (per request,
     * with the model and the rate that applied then); this predicate only drives
     * the row's peak/off-peak pill.
     */
    function isPeakRate(date) {
      var weekday = date.getUTCDay();                  // 0 = Sunday, 6 = Saturday
      if (weekday === 0 || weekday === 6) return false; // the weekend is off-peak
      if (isChineseHoliday(date)) return false;         // holidays are off-peak
      var hour = date.getUTCHours();
      for (var i = 0; i < PEAK_WINDOWS_UTC.length; i++) {
        var window = PEAK_WINDOWS_UTC[i];
        if (hour >= window[0] && hour < window[1]) return true;
      }
      return false;
    }

    function isOffPeak(date) {
      return !isPeakRate(date);
    }

    /** Budapest's UTC offset in minutes at one instant (+60 CET / +120 CEST). */
    function budapestOffsetMinutes(date) {
      try {
        var parts = new Intl.DateTimeFormat("en-US", {
          timeZone: HUNGARIAN_TIME_ZONE, hour12: false,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit"
        }).formatToParts(date);
        var fields = {};
        parts.forEach(function (part) { fields[part.type] = part.value; });
        var local = Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day),
          Number(fields.hour) % 24, Number(fields.minute), Number(fields.second));
        return Math.round((local - date.getTime()) / 60000);
      } catch (error) {
        return 60;
      }
    }

    /** `HH:MM` for a minute-of-day count, wrapped into one day. */
    function hhmm(minutes) {
      var wrapped = ((minutes % 1440) + 1440) % 1440;
      var hour = Math.floor(wrapped / 60);
      var minute = wrapped % 60;
      return (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") + minute;
    }

    /**
     * The peak windows in HUNGARIAN local time for one instant.
     *
     * Everything this plugin shows is local time: "váltás holnap 03:00" is
     * Budapest time, so the window that explains it must be local too. The
     * underlying anchor is UTC, which is why the local hours shift by an hour
     * when daylight saving changes — hence computing them instead of typing
     * them in.
     */
    function peakWindowsLocalText(date) {
      var offset = budapestOffsetMinutes(date);
      return PEAK_WINDOWS_UTC.map(function (window) {
        return hhmm(window[0] * 60 + offset) + "–" + hhmm(window[1] * 60 + offset);
      }).join(" és ");
    }

    /**
     * When the current peak/off-peak state next flips.
     *
     * Only the instants where a flip is possible are probed (window edges and
     * UTC midnights, {@link PEAK_EDGE_HOURS_UTC}) instead of stepping minute by
     * minute: a whole month costs a few hundred predicate calls this way, while
     * minute-stepping three days already cost thousands and still stopped before
     * the end of National Day.
     *
     * Returns `null` only when no switch exists inside the horizon — which the
     * callers must not render as "?" but as "later".
     */
    function nextSwitch(date) {
      var start = isOffPeak(date);
      var midnight = new Date(date.getTime());
      midnight.setUTCHours(0, 0, 0, 0);
      for (var day = 0; day <= SWITCH_SCAN_DAYS; day++) {
        for (var i = 0; i < PEAK_EDGE_HOURS_UTC.length; i++) {
          var probe = new Date(midnight.getTime() + day * DAY_MINUTES * 60000 + PEAK_EDGE_HOURS_UTC[i] * 3600000);
          if (probe.getTime() <= date.getTime()) continue;
          if (isOffPeak(probe) !== start) return probe;
        }
      }
      return null;
    }

    /** Budapest calendar day of an instant (for "ma / holnap / holnapután"). */
    function hungarianDayKey(date) {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: HUNGARIAN_TIME_ZONE,
          year: "numeric", month: "2-digit", day: "2-digit"
        }).format(date);
      } catch (e) {
        return String(date.getFullYear()) + "-" + String(date.getMonth() + 1) + "-" + String(date.getDate());
      }
    }

    /** Hungarian wall-clock time of an instant, always Europe/Budapest. */
    function hungarianTime(date) {
      if (!date) return "?";
      try {
        return new Intl.DateTimeFormat("hu-HU", {
          timeZone: HUNGARIAN_TIME_ZONE,
          hour: "2-digit", minute: "2-digit", hour12: false
        }).format(date);
      } catch (e) {
        return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
      }
    }

    /**
     * Full date and time of a commit, always Europe/Budapest, in the Hungarian
     * order: `2026. 09. 26. 18:34`.
     *
     * A date alone cannot tell two commits of the same day apart, which is
     * exactly when the list matters most. The value arrives as an ISO string
     * from `git log --date=iso-strict`.
     */
    function formatCommitStamp(value) {
      if (!value) return "";
      var date = value instanceof Date ? value : new Date(value);
      if (isNaN(date.getTime())) return String(value);
      try {
        return new Intl.DateTimeFormat("hu-HU", {
          timeZone: HUNGARIAN_TIME_ZONE,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hour12: false
        }).format(date);
      } catch (e) {
        return String(date.getFullYear()) + ". " + String(date.getMonth() + 1).padStart(2, "0") + ". " +
          String(date.getDate()).padStart(2, "0") + ". " + hungarianTime(date);
      }
    }

    /** Day prefix for a target instant, relative to now, through the locale. */
    function dayWord(target, now, t) {      if (!target) return "";
      var b = hungarianDayKey(target);
      if (b === hungarianDayKey(now)) return t("today");
      if (b === hungarianDayKey(new Date(now.getTime() + 86400000))) return t("tomorrow");
      if (b === hungarianDayKey(new Date(now.getTime() + 2 * 86400000))) return t("dayAfterTomorrow");
      for (var i = 3; i <= 10; i++) {
        if (b === hungarianDayKey(new Date(now.getTime() + i * 86400000))) return i + t("daysLater");
      }
      return "";
    }

    function formatCount(value) {
      if (typeof value !== "number" || !isFinite(value)) return "0";
      if (value >= 1000000) return (value / 1000000).toFixed(1) + "M";
      if (value >= 1000) return (value / 1000).toFixed(1) + "k";
      return String(Math.round(value));
    }

    /** Currency symbol for the balance answer. */
    function currencySymbol(code) {
      if (code === "USD") return "$";
      if (code === "EUR") return "€";
      if (code === "HUF") return "Ft";
      if (code === "CNY" || code === "RMB") return "¥";
      return (code || "") + " ";
    }

    function formatMoney(raw, code) {
      var value = Number(raw);
      if (!isFinite(value)) return null;
      return currencySymbol(code) + value.toFixed(2);
    }

    /** USD to four decimals, the shape the usage tooltip shows costs in. */
    function formatUsd(value) {
      var amount = Number(value);
      if (!isFinite(amount)) return "n/a";
      return "$" + amount.toFixed(4);
    }

    function totalTokensOf(usage) {
      return (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.outputTokens || 0);
    }

    function cacheHitPercent(usage) {
      var billed = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
      if (billed <= 0) return null;
      return Math.round(((usage.cacheReadTokens || 0) / billed) * 100);
    }

    // ------------------------------------------------------ conversation phase

    /**
     * The conversation's own phase: `settling | hero | active`.
     *
     * In a brand-new ("blank") session the framework HIDES the session header and
     * gives the composer bar the `hero` variant. Both slots this plugin normally
     * fills disappear with it — `conversation.session.header.utilities` is not
     * rendered at all, and `conversation.composer.dock` only exists for the
     * `composer` variant — so the corner controls and the statistics row used to
     * be missing until the first message was sent.
     *
     * Reading the phase is what lets the plugin serve the same content from
     * `conversation.input.dock`, which exists in BOTH phases, without rendering
     * it twice once the session turns active.
     *
     * The value is read from the conversation ROOT: the scroll body
     * (`[data-conversation-scroll]`) is inside it and `closest()` walks up to
     * exactly that element. The composer carries a `data-phase` attribute of its
     * own, but it speaks a different vocabulary (input state), so it must never
     * be mistaken for this one — hence the anchor rather than a bare query.
     */
    function readConversationPhase() {
      try {
        var anchor = document.querySelector("[data-conversation-scroll]");
        var node = anchor === null || anchor === undefined ? null : anchor.closest("[data-phase]");
        if (node !== null && node !== undefined) {
          var value = node.getAttribute("data-phase");
          if (typeof value === "string" && value !== "") return value;
        }
        // Without the anchor, accept only the conversation vocabulary.
        var candidates = document.querySelectorAll("[data-phase]");
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i].getAttribute("data-phase");
          if (candidate === "hero" || candidate === "active" || candidate === "settling") return candidate;
        }
      } catch (error) {
        // No document yet: the caller treats an unknown phase as "not hero".
      }
      return null;
    }

    /**
     * The live conversation phase, re-read whenever the framework publishes a
     * new one (the attribute changes in place when the first message lands).
     */
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
     * Whether one copy of a plugin view belongs on screen in this phase.
     *
     * `heroVariant` marks the copy registered in `conversation.input.dock`: it
     * serves the blank/hero phase only, while the regular copy (header
     * utilities, composer dock) serves every other phase. An unknown phase keeps
     * the regular copy — the state before this existed — and never makes the
     * hero copy appear on top of it.
     */
    function phaseServesView(heroVariant, phase) {
      return heroVariant === true ? phase === "hero" : phase !== "hero";
    }

    /**
     * One label/value pair, styled like the built-in composer stats pills.
     *
     * A `strong` érték színe a TÉMA változója, nem fix fehér: az egyenleg az
     * egyetlen `strong` pill, és a beégetett `#f9fafb` világos módban fehér
     * maradt a fehér háttéren — az egyenleg csak sötét módban látszott
     * (mért hiba, 2026-10-02). A `--dsw-alias-label-primary` sötétben
     * majdnem fehér, világosban majdnem fekete.
     */
    function Pill(props) {
      return jsx.jsxs("span", {
        title: props.title,
        style: { display: "inline-flex", alignItems: "center", gap: "5px", whiteSpace: "nowrap" },
        children: [
          jsx.jsx("span", { style: { opacity: 0.6 }, children: props.label }),
          jsx.jsx("span", {
            style: {
              fontWeight: props.strong ? 600 : 400,
              color: props.strong ? "var(--dsw-alias-label-primary, inherit)" : "inherit"
            },
            children: props.value
          })
        ]
      });
    }

    /**
     * Extended composer statistics row: the built-in numbers (turns, steps,
     * tokens, cache hit) plus cost, live account balance and the peak/off-peak
     * state with the next switch in Hungarian local time.
     */
    function StatsBar(props) {
      var t = typeof props.t === "function" ? props.t : function (key) { return key; };
      // Two registrations render this row: the regular one below the composer
      // card (active sessions) and the hero one above the card (blank sessions,
      // where the composer dock does not exist). Exactly one of them is on
      // screen at a time.
      var phase = useConversationPhase();
      var heroVariant = props.heroVariant === true;

      var tickState = react.useState(function () { return new Date(); });
      var now = tickState[0];
      var setNow = tickState[1];

      var balanceState = react.useState({ status: "loading" });
      var balance = balanceState[0];
      var setBalance = balanceState[1];

      // The 30-day usage aggregate, computed and priced on the host from the
      // durable session logs. `status` distinguishes "still loading" from "the
      // host cannot answer" (an older host half has no /ui-extras/usage route),
      // so the tooltip never lies about which one it is.
      var usageState = react.useState({ status: "loading", summary: null });
      var usageStatus = usageState[0];
      var setUsageState = usageState[1];

      react.useEffect(function () {
        var timer = setInterval(function () { setNow(new Date()); }, 20000);
        return function () { clearInterval(timer); };
      }, []);

      // Live balance from the host half; the API key stays on the server.
      react.useEffect(function () {
        var alive = true;

        function load() {
          fetch(BALANCE_ROUTE, { headers: { Accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (data) {
              if (!alive) return;
              if (data && data.ok === true) setBalance({ status: "ready", data: data });
              else setBalance({ status: "error", error: (data && data.error) || "unknown" });
            })
            .catch(function (error) {
              if (alive) setBalance({ status: "error", error: String(error && error.message ? error.message : error) });
            });
        }

        load();
        var timer = setInterval(load, BALANCE_REFRESH_MILLISECONDS);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      // The 30-day usage: one request per session (the host prices that session
      // from its own log) and a refresh on the same beat as the balance.
      var sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
      react.useEffect(function () {
        var alive = true;

        function load() {
          fetch(USAGE_ROUTE + "?days=" + String(USAGE_DAYS) + (sessionId === "" ? "" : "&session=" + encodeURIComponent(sessionId)),
            { headers: { Accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (data) {
              if (!alive) return;
              if (data && data.ok === true) setUsageState({ status: "ready", summary: data });
              else setUsageState({ status: "error", summary: null });
            })
            .catch(function () {
              if (alive) setUsageState({ status: "error", summary: null });
            });
        }

        load();
        var timer = setInterval(load, BALANCE_REFRESH_MILLISECONDS);
        return function () { alive = false; clearInterval(timer); };
      }, [sessionId]);

      var usage = null;
      var stats = null;
      try {
        if (props && typeof props.useProjection === "function") {
          usage = props.useProjection("tokenUsage") || null;
          stats = props.useProjection("sessionStats") || null;
        }
      } catch (e) { }

      var offPeak = isOffPeak(now);
      var switchAt = nextSwitch(now);
      var cacheHit = usage ? cacheHitPercent(usage) : null;

      var balanceTotal = balance.status === "ready" && balance.data ? Number(balance.data.total) : null;
      var balanceCurrency = balance.status === "ready" && balance.data ? balance.data.currency : null;
      var balanceText;
      if (balance.status === "loading") balanceText = t("balanceLoading");
      else if (balance.status === "error") balanceText = t("balanceUnavailable");
      else balanceText = formatMoney(balanceTotal, balanceCurrency) || t("balanceUnavailable");

      // A missing switch is "later", never "?": the scan only returns nothing
      // when no flip exists inside its horizon, and a question mark next to a
      // state the row already knows reads like a broken row.
      var switchText = switchAt
        ? t("switch") + dayWord(switchAt, now, t) + hungarianTime(switchAt)
        : t("switch") + t("later");

      // Both lines are Hungarian local time: the row's "váltás" countdown is
      // local, so the window has to be local too.
      var peakWindowLocal = peakWindowsLocalText(now);

      // The cost and the daily average are NOT pills any more: a real figure
      // needs the whole history and the rate that applied per request, so both
      // live in this row's tooltip instead of posing as session numbers.
      var tooltipLines = [t("usageTooltipHead")];
      var usageSummary = usageStatus.status === "ready" ? usageStatus.summary : null;
      var sessionFigures = usageSummary && usageSummary.session ? usageSummary.session : null;
      if (sessionFigures !== null) {
        tooltipLines.push(t("usageSessionCost", { cost: formatUsd(sessionFigures.costUsd) }));
      } else if (usage) {
        tooltipLines.push(t("usageSessionTokens", { tokens: formatCount(totalTokensOf(usage)) }));
      }
      if (usageSummary && usageSummary.totals) {
        var totals = usageSummary.totals;
        tooltipLines.push(t("usageWindowCost", { days: String(usageSummary.days), cost: formatUsd(totals.costUsd) }));
        tooltipLines.push(t("usageWindowAverage", { days: String(usageSummary.days), cost: formatUsd(totals.costUsd / Math.max(1, usageSummary.days)) }));
        if (usageSummary.activeDays > 0) {
          tooltipLines.push(t("usageActiveDays", {
            days: String(usageSummary.activeDays),
            cost: formatUsd(totals.costUsd / usageSummary.activeDays)
          }));
        }
        tooltipLines.push(t("usageWindowTokens", {
          days: String(usageSummary.days),
          total: formatCount(totals.total),
          miss: formatCount(totals.miss),
          hit: formatCount(totals.hit),
          out: formatCount(totals.out)
        }));
        tooltipLines.push(t("usageWindowRequests", { count: String(totals.requests) }));

        // Megtakaritas a delegalt (subagent) munkabol. A host a
        // `delegated` blokkot adja vissza; ha meg nincs benne (regi host),
        // ezt a szakaszt kihagyjuk, hogy a tooltip ne hazudjon.
        //
        // Ketfele delegalas van, es a kulonbseg LATSZIK: ami a 0 aron szamolt
        // ingyenes lancon ment (`delegated.free`), az megtakaritas; ami
        // delegalva is a fizetos route-on futott (`delegated.paid`), az nem.
        // A regi host csak az osszevont szamokat adja — akkor arra esunk vissza.
        var delegated = usageSummary.delegated;
        if (delegated && typeof delegated.requests === "number") {
          tooltipLines.push("");
          tooltipLines.push(t("usageSavingsHead"));
          if (delegated.requests > 0) {
            var freePocket = delegated.free && typeof delegated.free.requests === "number" ? delegated.free : null;
            var paidPocket = delegated.paid && typeof delegated.paid.requests === "number" ? delegated.paid : null;
            var freeSaving = typeof delegated.freeSavingsUsd === "number" ? delegated.freeSavingsUsd : (delegated.savedUsd || 0);
            tooltipLines.push(t("usageSavingsAmount", { saved: formatUsd(freeSaving) }));
            if (freePocket !== null && paidPocket !== null) {
              tooltipLines.push(t("usageDelegatedFree", {
                requests: formatCount(freePocket.requests),
                cost: formatUsd(freePocket.costUsd || 0),
                sessions: formatCount(freePocket.sessions || 0)
              }));
              tooltipLines.push(t("usageDelegatedPaid", {
                requests: formatCount(paidPocket.requests),
                cost: formatUsd(paidPocket.costUsd || 0)
              }));
            }
            tooltipLines.push(t("usageSavingsShare", {
              delegated: formatCount(delegated.requests),
              total: formatCount(totals.requests),
              share: Math.round((delegated.share || 0) * 1000) / 10 + "%"
            }));
            var delegatedModels = Array.isArray(delegated.models) ? delegated.models.slice(0, 5) : [];
            for (var modelIndex = 0; modelIndex < delegatedModels.length; modelIndex++) {
              var entry = delegatedModels[modelIndex];
              tooltipLines.push(t("usageDelegatedModel", {
                tag: entry.free === true ? t("usageDelegatedFreeTag") : t("usageDelegatedPaidTag"),
                model: entry.model || t("unknown"),
                requests: formatCount(entry.requests || 0),
                cost: formatUsd(entry.costUsd || 0)
              }));
            }
            if (freePocket === null || paidPocket === null) {
              // Regi host: a fa, osszevont sor marad, hogy ne vesszen el az adat.
              tooltipLines.push(t("usageSavingsDetail", {
                cost: formatUsd(delegated.costUsd || 0),
                model: delegated.baselineModel || "deepseek-flash",
                baseline: formatUsd(delegated.baselineUsd || 0),
                sessions: formatCount(delegated.sessions || 0)
              }));
            }
            if (typeof delegated.lastAt === "number") {
              tooltipLines.push(t("usageDelegatedLast", { when: formatCommitStamp(delegated.lastAt) }));
            }
          } else {
            tooltipLines.push(t("usageSavingsNone"));
          }
        }
      } else if (usageStatus.status === "error") {
        tooltipLines.push(t("usageUnavailable"));
      } else {
        tooltipLines.push(t("usageLoading"));
      }
      tooltipLines.push(t("usagePeakNote", { window: peakWindowLocal }));
      // A native title shows every line of a multi-line string, which is exactly
      // the "quick tip" this extra information belongs in.
      var rowTitle = tooltipLines.join("\n");

      var pills = [];
      if (stats && stats.turns > 0) pills.push({ label: "", value: stats.turns + " " + t("turns") });
      if (stats && stats.steps > 0) pills.push({ label: "", value: stats.steps + " " + t("steps") });
      if (usage) pills.push({ label: t("token"), value: formatCount(totalTokensOf(usage)) });
      if (cacheHit !== null) pills.push({ label: t("cache"), value: cacheHit + "%" });
      pills.push({
        label: t("balance"),
        value: balanceText,
        strong: balance.status === "ready",
        title: balance.status === "error" ? t("balanceErrorTitle") + balance.error : t("balanceTitle")
      });
      pills.push({ label: offPeak ? t("offPeak") : t("peak"), value: switchText, title: t("usagePeakNote", { window: peakWindowLocal }) });

      // Every hook above has run: this early return is phase-only.
      if (!phaseServesView(heroVariant, phase)) return null;

      var rowStyle = {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: "6px 14px",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: "100%",
        margin: 0,
        padding: "2px 8px",
        background: "transparent",
        color: "inherit",
        fontSize: "12px",
        lineHeight: "18px",
        fontVariantNumeric: "tabular-nums",
        opacity: 0.85,
        overflow: "hidden"
      };
      // The hero copy is a flex child of the composer stack, whose height is
      // tight enough to squeeze it: measured live, the row collapsed from its
      // natural 22px to 8px and its own `overflow: hidden` then cut the text
      // away — the row was in the DOM, yet unreadable. `flex: none` keeps the
      // line; if the stack then overflows on a very short window it scrolls,
      // which is the better failure.
      if (heroVariant) rowStyle.flex = "none";

      return jsx.jsx("div", {
        "data-dsh-ui-extras": "stats",
        title: rowTitle,
        style: rowStyle,
        children: pills.map(function (item, index) {
          return jsx.jsx(Pill, {
            label: item.label,
            value: item.value,
            strong: item.strong,
            title: item.title
          }, index);
        })
      });
    }

    // ------------------------------------------------- remembered approvals
    //
    // The approval prompt (the yellow card that takes over the composer) asks a
    // one-shot question: the built-in seam has `allowed-once` and nothing else,
    // so the same escalation asks again every time. This plugin takes over that
    // card and adds two "remember" answers, which the HOST stores per approval
    // TYPE; from then on the host answers the request itself and the card is not
    // shown at all. Everything the user must decide stays visible: which tool
    // asks, which access type the answer would cover, and the exact command.

    /** Where the host half keeps the remembered approval types. */
    var APPROVALS_ROUTE = "/ui-extras/approvals";

    /**
     * The card's own class names and styles.
     *
     * The built-in card's stylesheet belongs to another plugin, so it is not
     * addressable from here; these rules reproduce that look through the same
     * theme variables, with the plugin's own prefix. Injected once.
     */
    var APPROVAL_CSS = [
      ".uix-appr-root{padding:8px calc(var(--dsh-composer-side-clearance,16px) + 16px) 12px;display:flex;flex-direction:column;align-items:center}",
      ".uix-appr-card{width:100%;max-width:var(--dsh-chat-content-width,760px);border:1px solid var(--dsw-alias-state-warn-secondary,#8a6d1f);background:var(--dsw-specific-input-major,#1b1b1d);box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.35));border-radius:20px;overflow:hidden}",
      ".uix-appr-strip{background:var(--dsw-alias-state-warn-tertiary,rgba(255,196,0,.14));color:var(--dsw-alias-state-warn-primary,#ffc400);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}",
      ".uix-appr-dot{background:var(--dsw-alias-state-warn-primary,#ffc400);border-radius:50%;width:8px;height:8px}",
      ".uix-appr-body{box-sizing:border-box;max-height:var(--dsh-composer-text-max-height,260px);flex-direction:column;gap:6px;padding:12px 16px 0;display:flex;overflow-y:auto}",
      ".uix-appr-headline{color:var(--dsw-alias-label-primary,inherit);font-size:15px;font-weight:500;line-height:24px}",
      ".uix-appr-line{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.66));font-size:12px;line-height:18px}",
      ".uix-appr-type{color:var(--dsw-alias-label-secondary,inherit);font-size:13px;line-height:20px}",
      ".uix-appr-command{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.66));font-family:var(--ds-font-family-code,ui-monospace,monospace);word-break:break-all;white-space:pre-wrap;font-size:13px;line-height:20px}",
      ".uix-appr-actions{justify-content:flex-end;align-items:center;gap:8px;padding:14px 16px;display:flex;flex-wrap:wrap}",
      ".uix-appr-hint{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.6));flex:1 1 100%;font-size:11px;line-height:16px}",
      ".uix-appr-status{color:var(--dsw-alias-label-secondary,inherit);flex:1 1 auto;font-size:11px;line-height:16px}",
      ".uix-appr-btn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.22));border-radius:10px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px;padding:6px 14px}",
      ".uix-appr-btn[disabled]{cursor:default;opacity:.5}",
      ".uix-appr-btn-primary{border-color:transparent;background:var(--dsw-alias-interactive-bg-primary,#4c7dff);color:#fff;font-weight:500}",
      ".uix-appr-btn-danger:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(255,0,0,.12));color:var(--dsw-alias-state-error-primary,#ff8a80);border-color:transparent}"
    ].join("");

    /** Install the card's stylesheet once per page. */
    function installApprovalStyles() {
      try {
        if (document.querySelector("style[data-dsh-ui-extras=approval-card]") !== null) return;
        var style = document.createElement("style");
        style.setAttribute("data-dsh-ui-extras", "approval-card");
        style.textContent = APPROVAL_CSS;
        document.head.appendChild(style);
      } catch (error) {
        reportToHost("approval styles", String(error && error.message ? error.message : error));
      }
    }

    /**
     * The ACTIVE locale id — never the raw value the service hands back.
     *
     * `ctx.locale.getLocale()` answers an immutable SNAPSHOT
     * (`{ active, locales, revision }`), not an id string. Reading it with
     * `String(...)` produced "[object Object]", which sent every branch that
     * compares it to the wrong side — that is why the language button started
     * as "EN" while Hungarian was on screen, and only corrected itself once a
     * click had written an id into local state.
     *
     * @param localeService - the injected locale service.
     * @returns the active id, falling back to the document language and finally
     *   to "hu", this installation's default.
     */
    function activeLocaleId(localeService) {
      try {
        var value = localeService.getLocale();
        if (typeof value === "string") return value;
        if (value && typeof value.active === "string") return value.active;
        if (value && typeof value.id === "string") return value.id;
      } catch (error) {
        // No locale service: fall through to the document language.
      }
      // The locale service points <html lang> at the active locale, so the
      // document is a real second source (and it is already set at boot).
      try {
        if (typeof document !== "undefined" && typeof document.documentElement.lang === "string"
          && document.documentElement.lang !== "") {
          return document.documentElement.lang;
        }
      } catch (error) {
        // No document: fall through to the default.
      }
      return "hu";
    }

    /** Whether one locale id names Hungarian ("hu", "hu-HU"; never "en"). */
    function isHungarianLocaleId(id) {
      return String(id).toLowerCase().indexOf("hu") === 0;
    }

    /** One-line description of a remembered rule's tool scope. */
    function approvalRuleScopeText(rule, t) {
      if (rule === null || rule === undefined) return t("approvalRuleEveryTool");
      if (!Array.isArray(rule.tools) || rule.tools.length === 0) return t("approvalRuleEveryTool");
      return t("approvalRuleTools", { tools: rule.tools.join(", ") });
    }

    /** The command text of the tool call an approval is about, when there is one. */
    function approvalCommandOf(snapshot, callId) {
      if (callId === undefined || snapshot === null || snapshot === undefined) return null;
      if (snapshot.nodes === undefined || typeof snapshot.nodes.values !== "function") return null;
      var nodes = snapshot.nodes.values();
      for (var step = nodes.next(); step.done !== true; step = nodes.next()) {
        var node = step.value;
        var root = node && node.kind === "tool-call" && node.data ? node.data.root : undefined;
        if (root === undefined || root === null || root.callId !== callId) continue;
        if ("kind" in root) return null;
        try {
          var args = JSON.parse(root.argsRaw);
          if (args !== null && typeof args.command === "string") return args.command;
        } catch (error) {
          return null;
        }
        return null;
      }
      return null;
    }

    /**
     * One card button.
     *
     * The shell's own Button primitive is used when it is reachable from this
     * module graph, so the card matches the built-in prompt; without it the
     * plugin's own class keeps the card usable instead of failing to render.
     */
    function ApprovalButton(props) {
      if (primitives !== null && typeof primitives.Button === "function") {
        return jsx.jsx(primitives.Button, {
          variant: props.variant,
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.onClick,
          children: props.children
        });
      }
      return jsx.jsx("button", {
        type: "button",
        title: props.title,
        disabled: props.disabled === true,
        onClick: props.onClick,
        className: props.variant === "primary" ? "uix-appr-btn uix-appr-btn-primary" : "uix-appr-btn",
        children: props.children
      });
    }

    /**
     * The approval card: the built-in prompt plus remembered consent.
     *
     * A chain cell keeps ONE component instance across elections — the outlet
     * keys the boundary by entry identity, not by the matched value — so the
     * stateful flow lives in an inner component keyed by the pending request.
     * Without that key the second approval of a session would inherit the
     * first one's "already answered" state and its derived type.
     *
     * `matched` is the pending interaction the shell elected into the composer
     * chain: the same object the built-in panel renders, whose `answer(outcome)`
     * settles the waiting host request.
     */
    function ApprovalCard(props) {
      var pending = props.matched;
      var key = pending && pending.key !== undefined ? pending.key : "approval";
      return jsx.jsx(ApprovalGuard, {
        t: props.t,
        locale: props.locale,
        useChat: props.useChat,
        pending: pending
      }, key);
    }

    /**
     * Error boundary for the approval card.
     *
     * This card is elected AHEAD of the built-in one, so a crash inside it would
     * leave the session unable to answer the waiting request at all: a chain
     * entry is never abdicated, so the composer keeps serving the crashed card.
     * The boundary therefore falls back to the two answers the built-in panel
     * offers, which is exactly enough to unblock the tool.
     */
    class ApprovalGuard extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error, info) {
        reportToHost("approval card crashed",
          String(error && error.stack ? error.stack : error) + " :: " + String(info && info.componentStack ? info.componentStack : ""));
      }

      render() {
        if (this.state.error !== null) {
          return jsx.jsx(ApprovalFallback, { t: this.props.t, pending: this.props.pending });
        }
        return jsx.jsx(ApprovalFlow, {
          t: this.props.t,
          locale: this.props.locale,
          useChat: this.props.useChat,
          pending: this.props.pending
        });
      }
    }

    /** The minimal card shown when the full one crashes: reject or allow once. */
    function ApprovalFallback(props) {
      var t = typeof props.t === "function" ? props.t : function (key) { return key; };
      var pending = props.pending;
      var answeredState = react.useState(false);
      var answered = answeredState[0];
      var setAnswered = answeredState[1];

      function answer(outcome) {
        setAnswered(true);
        try {
          pending.answer(outcome).catch(function () { setAnswered(false); });
        } catch (error) {
          setAnswered(false);
        }
      }

      var toolName = pending && typeof pending.toolName === "string" ? pending.toolName : "";
      return jsx.jsx("div", {
        className: "uix-appr-root",
        "data-dsh-ui-extras": "approval-card-fallback",
        children: jsx.jsxs("div", {
          className: "uix-appr-card",
          children: [
            jsx.jsxs("div", {
              className: "uix-appr-strip",
              children: [jsx.jsx("span", { className: "uix-appr-dot" }), t("approvalWaitTitle")]
            }),
            jsx.jsx("div", {
              className: "uix-appr-body",
              children: jsx.jsx("div", { className: "uix-appr-headline", children: t("approvalHeadline", { tool: toolName }) })
            }),
            jsx.jsxs("div", {
              className: "uix-appr-actions",
              children: [
                jsx.jsx(ApprovalButton, {
                  variant: "outline",
                  disabled: answered,
                  onClick: function () { answer("rejected"); },
                  children: t("approvalReject")
                }),
                jsx.jsx(ApprovalButton, {
                  variant: "primary",
                  disabled: answered,
                  onClick: function () { answer("allowed-once"); },
                  children: t("approvalAllowOnce")
                })
              ]
            })
          ]
        })
      });
    }

    /**
     * One pending approval's card, mounted fresh per request.
     *
     * The two "remember" buttons answer exactly as "allow once" does — the
     * user's press is consent for THIS action — and additionally store the
     * approval type on the host, which is what makes the host skip the prompt
     * from then on.
     */
    function ApprovalFlow(props) {
      var t = typeof props.t === "function" ? props.t : function (key) { return key; };
      var pending = props.pending;

      var answeredState = react.useState(false);
      var answered = answeredState[0];
      var setAnswered = answeredState[1];

      var typeState = react.useState(null);
      var type = typeState[0];
      var setType = typeState[1];

      // `null` while the host has not answered yet; `false` when this
      // composition has no approval store (the remember buttons are then not
      // offered at all, instead of failing on press).
      var hostState = react.useState(null);
      var hostReady = hostState[0];
      var setHostReady = hostState[1];

      var statusState = react.useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];

      var isHungarian = isHungarianLocaleId(activeLocaleId(props.locale));

      var command = null;
      try {
        if (typeof props.useChat === "function" && pending && pending.callId !== undefined) {
          var callId = pending.callId;
          command = props.useChat(function (snapshot) { return approvalCommandOf(snapshot, callId); });
        }
      } catch (error) {
        command = null;
      }

      var pendingKey = pending && pending.key !== undefined ? pending.key : "";
      var toolName = pending && typeof pending.toolName === "string" ? pending.toolName : "";
      var reason = pending && typeof pending.reason === "string" ? pending.reason : "";

      // One read of the derived TYPE per pending request: it names what a
      // "remember" press would store, and it is the host that derives it, so the
      // browser never guesses what a rule covers.
      react.useEffect(function () {
        var cancelled = false;
        if (pendingKey === "") {
          setHostReady(false);
          return undefined;
        }
        fetch(APPROVALS_ROUTE + "?toolName=" + encodeURIComponent(toolName) + "&reason=" + encodeURIComponent(reason), {
          headers: { Accept: "application/json" }
        })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (cancelled) return;
            if (body && body.ok === true) {
              setType(body.type ?? null);
              setHostReady(true);
            } else {
              setHostReady(false);
            }
          })
          .catch(function (error) {
            if (cancelled) return;
            setHostReady(false);
            reportToHost("approval type", "failed: " + String(error && error.message ? error.message : error));
          });
        return function () { cancelled = true; };
      }, [pendingKey]);

      /** Settle the waiting request with one outcome. */
      function answer(outcome) {
        setAnswered(true);
        pending.answer(outcome).catch(function () {
          setAnswered(false);
          setStatus(t("approvalWriteFailed"));
        });
      }

      /** The one-shot grant: exactly what the built-in card's primary button does. */
      function allowOnce() {
        answer("allowed-once");
      }

      /**
       * Remember this approval type on the host, then answer the pending
       * request: the user's press is consent for THIS action too, so the card
       * must not leave the tool waiting for a second decision.
       */
      function remember(scope) {
        setStatus(t("approvalRemembering"));
        fetch(APPROVALS_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ action: "remember", toolName: toolName, reason: reason, scope: scope })
        })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!body || body.ok !== true) {
              throw new Error(body && body.error ? String(body.error) : "?");
            }
            setStatus(t("approvalRemembered"));
            answer("allowed-once");
          })
          .catch(function (error) {
            setStatus(t("approvalWriteFailed") + " " + String(error && error.message ? error.message : error));
          });
      }

      var typeLabel = null;
      if (type !== null && type !== undefined) {
        typeLabel = isHungarian ? type.labelHu : type.labelEn;
      }
      var headline = type !== null && type !== undefined && type.kind === "sandbox-escalation"
        ? t("approvalHeadlineEscalation", { tool: toolName })
        : t("approvalHeadline", { tool: toolName });

      // The asker's own words, shown whenever the host could not name the type:
      // without a reachable store the card must still say WHY it asks, exactly
      // as the built-in panel does with the raw reason.
      var reasonLine = type !== null && type !== undefined
        ? (type.justification === "" ? null : type.justification)
        : (reason.trim() === "" ? null : reason.slice(0, 400));

      return jsx.jsx("div", {
        className: "uix-appr-root",
        "data-dsh-ui-extras": "approval-card",
        "data-approval-key": pendingKey,
        children: jsx.jsxs("div", {
          className: "uix-appr-card",
          children: [
            jsx.jsxs("div", {
              className: "uix-appr-strip",
              children: [
                jsx.jsx("span", { className: "uix-appr-dot" }),
                t("approvalWaitTitle")
              ]
            }),
            jsx.jsxs("div", {
              className: "uix-appr-body",
              tabIndex: 0,
              role: "group",
              "aria-label": t("approvalWaitTitle"),
              children: [
                jsx.jsx("div", { className: "uix-appr-headline", children: headline }),
                typeLabel !== null
                  ? jsx.jsx("div", { className: "uix-appr-type", children: t("approvalTypeLine", { type: typeLabel }) })
                  : null,
                reasonLine !== null
                  ? jsx.jsx("div", { className: "uix-appr-line", children: t("approvalReasonLine", { reason: reasonLine }) })
                  : null,
                command !== null && command !== undefined && command !== ""
                  ? jsx.jsxs("div", {
                    children: [
                      jsx.jsx("div", { className: "uix-appr-line", children: t("approvalCommandLine") }),
                      jsx.jsx("div", { className: "uix-appr-command", children: command })
                    ]
                  })
                  : null
              ]
            }),
            jsx.jsxs("div", {
              className: "uix-appr-actions",
              children: [
                status !== null ? jsx.jsx("span", { className: "uix-appr-status", children: status }) : null,
                hostReady === true
                  ? jsx.jsx("span", { className: "uix-appr-hint", children: t("approvalRememberHint") })
                  : null,
                jsx.jsx(ApprovalButton, {
                  variant: "outline",
                  disabled: answered,
                  title: t("approvalRejectHint"),
                  onClick: function () { answer("rejected"); },
                  children: t("approvalReject")
                }),
                hostReady === true
                  ? jsx.jsx(ApprovalButton, {
                    variant: "outline",
                    disabled: answered,
                    title: t("approvalRememberToolHint", { tool: toolName }),
                    onClick: function () { remember("tool"); },
                    children: t("approvalRememberTool", { tool: toolName })
                  })
                  : null,
                hostReady === true && type !== null && type !== undefined && type.scopes.indexOf("all") >= 0
                  ? jsx.jsx(ApprovalButton, {
                    variant: "outline",
                    disabled: answered,
                    title: t("approvalRememberAllHint"),
                    onClick: function () { remember("all"); },
                    children: t("approvalRememberAll")
                  })
                  : null,
                jsx.jsx(ApprovalButton, {
                  variant: "primary",
                  disabled: answered,
                  title: t("approvalAllowOnceHint"),
                  onClick: function () { allowOnce(); },
                  children: t("approvalAllowOnce")
                })
              ]
            })
          ]
        })
      });
    }

    /**
     * The remembered-approval panel behind the 🛡 corner button: which types the
     * host answers without asking, and what it answered recently.
     */
    function PermissionsPanel(props) {
      var t = typeof props.t === "function" ? props.t : function (key) { return key; };
      // The stored rule carries both labels; the panel shows the one matching
      // the language on screen, exactly like the card's type line.
      var isHungarian = isHungarianLocaleId(activeLocaleId(props.locale));
      var stateResult = react.useState({ status: "loading", rules: [], log: [], error: null });
      var state = stateResult[0];
      var setState = stateResult[1];

      function load() {
        fetch(APPROVALS_ROUTE, { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!body || body.ok !== true) throw new Error(body && body.error ? String(body.error) : "?");
            setState({
              status: "ready",
              rules: Array.isArray(body.rules) ? body.rules : [],
              log: Array.isArray(body.log) ? body.log : [],
              error: null
            });
          })
          .catch(function (error) {
            setState({
              status: "error",
              rules: [],
              log: [],
              error: String(error && error.message ? error.message : error)
            });
          });
      }

      react.useEffect(function () {
        load();
      }, []);

      /** One write against the store; the answer is the new rule list. */
      function act(body) {
        fetch(APPROVALS_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body)
        })
          .then(function (response) { return response.json(); })
          .then(function (answer) {
            if (!answer || answer.ok !== true) throw new Error(answer && answer.error ? String(answer.error) : "?");
            load();
          })
          .catch(function (error) {
            setState({
              status: "error",
              rules: state.rules,
              log: state.log,
              error: String(error && error.message ? error.message : error)
            });
          });
      }

      var smallButton = {
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
        borderRadius: "7px",
        background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        padding: "1px 8px"
      };

      return jsx.jsxs("div", {
        "data-dsh-ui-extras": "permissions-panel",
        style: {
          position: "absolute",
          top: "30px",
          right: 0,
          zIndex: 40,
          width: "min(620px, 94vw)",
          maxHeight: "70vh",
          overflowY: "auto",
          padding: "10px 12px",
          border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
          borderRadius: "10px",
          background: "var(--dsw-alias-bg-layer-2, rgba(21,21,23,0.98))",
          color: "var(--dsw-alias-label-primary, #e8eaed)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
          fontSize: "12px",
          lineHeight: "18px",
          textAlign: "left"
        },
        children: [
          jsx.jsxs("div", {
            style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" },
            children: [
              jsx.jsx("strong", { children: t("approvalPermissionsTitle") }),
              jsx.jsxs("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center" }, children: [
                jsx.jsx("button", { type: "button", onClick: load, style: smallButton, children: "⟳ " + t("approvalRefresh") }),
                jsx.jsx("button", {
                  type: "button",
                  title: t("approvalClearAllHint"),
                  onClick: function () { act({ action: "clear" }); },
                  style: smallButton,
                  children: "🗑 " + t("approvalClearAll")
                }),
                jsx.jsx("button", {
                  type: "button",
                  onClick: props.onClose,
                  style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
                  children: "✕"
                })
              ] })
            ]
          }),
          jsx.jsx("div", { style: { opacity: 0.72, marginBottom: "8px" }, children: t("approvalPermissionsHint") }),
          state.status === "loading" ? jsx.jsx("div", { children: t("balanceLoading") }) : null,
          state.status === "error"
            ? jsx.jsx("div", { style: { color: "#fca5a5" }, children: t("approvalLoadFailed") + " " + state.error })
            : null,
          state.status !== "loading" && state.rules.length === 0
            ? jsx.jsx("div", { style: { opacity: 0.8 }, children: t("approvalNoRules") })
            : null,
          state.rules.map(function (rule) {
            return jsx.jsxs("div", {
              key: rule.id,
              "data-dsh-ui-extras": "permission-rule",
              style: {
                border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))",
                borderRadius: "8px",
                padding: "6px 8px",
                marginBottom: "6px",
                display: "flex",
                gap: "8px",
                alignItems: "flex-start",
                justifyContent: "space-between"
              },
              children: [
                jsx.jsxs("div", { style: { minWidth: 0 }, children: [
                  jsx.jsx("div", { style: { fontWeight: 600 }, children: isHungarian ? rule.labelHu : rule.labelEn }),
                  jsx.jsx("div", { style: { opacity: 0.7 }, children: approvalRuleScopeText(rule, t) }),
                  jsx.jsx("div", {
                    style: { opacity: 0.6 },
                    children: t("approvalRuleUsed", { count: String(Number(rule.hits) || 0) })
                      + " · " + t("approvalRuleCreated", { date: String(rule.createdAt ?? "").slice(0, 16).replace("T", " ") })
                  }),
                  rule.note ? jsx.jsx("div", { style: { opacity: 0.6 }, children: rule.note }) : null
                ] }),
                jsx.jsx("button", {
                  type: "button",
                  onClick: function () { act({ action: "forget", id: rule.id }); },
                  style: smallButton,
                  children: t("approvalRevoke")
                })
              ]
            });
          }),
          jsx.jsxs("div", { style: { marginTop: "8px" }, children: [
            jsx.jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
              jsx.jsx("strong", { children: t("approvalLogTitle") }),
              jsx.jsx("button", { type: "button", onClick: function () { act({ action: "clear-log" }); }, style: smallButton, children: t("approvalClearLog") })
            ] }),
            state.log.length === 0
              ? jsx.jsx("div", { style: { opacity: 0.7 }, children: t("approvalNoLog") })
              : jsx.jsx("ul", {
                style: { margin: "4px 0 0", paddingLeft: "18px", opacity: 0.8 },
                children: state.log.map(function (entry, index) {
                  return jsx.jsx("li", {
                    children: String(entry.at ?? "").slice(0, 19).replace("T", " ")
                      + " — " + String(entry.event ?? "") + ": " + String(entry.label ?? entry.key ?? "")
                      + (entry.toolName ? " (" + String(entry.toolName) + ")" : "")
                  }, index);
                })
              })
          ] })
        ]
      });
    }

    /** Compact icon button used by the corner controls. */
    function CornerButton(props) {
      var hoverState = react.useState(false);
      var hovered = hoverState[0];
      var setHovered = hoverState[1];
      // `disabled` keeps the button on screen but inert: a control that
      // disappears cannot be used to get out of a stuck state.
      var disabled = props.disabled === true;
      return jsx.jsx("button", {
        type: "button",
        title: props.title,
        "aria-label": props.title,
        disabled: disabled,
        onClick: props.onClick,
        onMouseEnter: function () { if (!disabled) setHovered(true); },
        onMouseLeave: function () { setHovered(false); },
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "4px",
          height: "26px",
          minWidth: "26px",
          padding: "0 6px",
          border: "1px solid " + (props.active === true
            ? "var(--dsw-alias-border-l4, rgba(255,255,255,0.55))"
            : hovered ? "var(--dsw-alias-border-l3, rgba(255,255,255,0.28))" : "var(--dsw-alias-border-l2, rgba(255,255,255,0.14))"),
          borderRadius: "7px",
          background: props.active === true
            ? "var(--dsw-alias-interactive-bg-active, rgba(255,255,255,0.16))"
            : hovered ? "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07))" : "transparent",
          color: "inherit",
          font: "inherit",
          fontSize: "12px",
          lineHeight: "1",
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? "not-allowed" : "pointer"
        },
        children: [
          jsx.jsx("span", { "aria-hidden": "true", children: props.icon }),
          props.text ? jsx.jsx("span", { children: props.text }) : null
        ]
      });
    }

    /**
     * Corner controls beside the open-in-app icons: one button switches the
     * interface language (Hungarian is added to the catalog, because the
     * shipped selector only offers Chinese and English), the other switches
     * between dark and light appearance. Both carry a tooltip and a glyph.
     */
    function CornerControls(props) {
      var t = typeof props.t === "function" ? props.t : function (key) { return key; };
      // Two registrations render these controls: the regular one in the session
      // header (which the framework does not render at all in a blank session)
      // and the hero one in the composer's input dock, which exists in both
      // phases and hides itself as soon as the session turns active.
      var phase = useConversationPhase();
      var heroVariant = props.heroVariant === true;

      // The ACTIVE LOCALE ID, never the raw snapshot: `getLocale()` answers
      // `{ active, locales, revision }`, so the earlier `String(locale)` read
      // "[object Object]" and the button started on the "switch to Hungarian"
      // branch while Hungarian was already on screen — it only looked right
      // after a click had stored an id string in this state.
      var localeState = react.useState(function () { return activeLocaleId(props.locale); });
      var localeId = localeState[0];
      var setLocaleId = localeState[1];

      // Read the resolved theme through getTheme(): the theme service keeps no
      // public `preference` field, so reading one returned undefined and the
      // button stayed stuck on the "switch to light" branch forever.
      function readTheme() {
        try {
          var snapshot = props.theme.getTheme();
          if (snapshot && typeof snapshot.preference === "string") return snapshot.preference;
          if (snapshot && typeof snapshot.id === "string") return snapshot.id;
        } catch (e) { }
        return "dark";
      }

      var themeState = react.useState(readTheme);
      var themePreference = themeState[0];
      var setThemePreference = themeState[1];

      var panelState = react.useState(false);
      var panelOpen = panelState[0];
      var setPanelOpen = panelState[1];

      var sshState = react.useState(false);
      var sshOpen = sshState[0];
      var setSshOpen = sshState[1];

      var cmdState = react.useState(false);
      var cmdOpen = cmdState[0];
      var setCmdOpen = cmdState[1];

      var permState = react.useState(false);
      var permOpen = permState[0];
      var setPermOpen = permState[1];

      // Visible feedback for the restart / deploy buttons, so pressing them is
      // never a silent no-op.
      var statusState = react.useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];

      react.useEffect(function () {
        try {
          return props.locale.subscribe(function () {
            // Re-derive the id: a switch, a late language pack or a settings
            // adoption all arrive as a new snapshot.
            try { setLocaleId(activeLocaleId(props.locale)); } catch (e) { }
          });
        } catch (e) {
          return undefined;
        }
      }, []);

      var isHungarian = isHungarianLocaleId(localeId);
      var isDark = themePreference !== "light";

      function switchLanguage(target) {
        try {
          props.locale.setLocale(target);
          // Immediate feedback with the id we asked for; the service's own
          // notification then confirms it.
          setLocaleId(target);
        } catch (error) {
          console.error("[dsh-ui-extras] language switch failed:", error);
        }
      }

      function switchTheme() {
        var next = isDark ? "light" : "dark";
        try {
          // The theme service persists the preference itself, but only through
          // setTheme(id): that is the write entry which also reaches the host
          // settings. (setPreference exists on the internal runtime and is
          // overwritten as soon as the host settings sync, which is why the
          // toggle appeared to do nothing.)
          if (typeof props.theme.setTheme === "function") {
            props.theme.setTheme(next);
          } else if (typeof props.theme.setPreference === "function") {
            props.theme.setPreference(next);
          }
          setThemePreference(next);
          syncRobotPanelTheme(next);
        } catch (error) {
          console.error("[dsh-ui-extras] theme switch failed:", error);
        }
      }

      /**
       * A robot panel (a 4180-as port) KÜLÖN originen fut, ezért nem látja ezt a
       * témabeállítást — a saját localStorage-ához nem férünk hozzá. Ezért a
       * HOSTON át értesítjük (szerver-szerver hívás, nem ütközik CORS-ba), így a
       * 4. felület is egyszerre vált a többivel.
       */
      function syncRobotPanelTheme(value) {
        try {
          fetchWithTimeout(
            "/ui-extras/github-action?action=theme-sync&value=" + encodeURIComponent(value),
            null,
            8000
          ).catch(function () { /* a robot panel lehet, hogy épp nem fut */ });
        } catch (error) {
          /* a szinkron nem kritikus: a DSH panelek így is váltottak */
        }
      }

      // Ha MI váltottunk, egy ideig nem hiszünk a robot panel válaszának: a
      // theme-sync POST kicsit késik, így a visszapollozás a régi értéket
      // olvasná, és egy pillanatra visszapattanna a téma (villogás).
      //
      // 6 másodperc: a panel 2 másodpercenként követi a szervert, tehát ennyi
      // bőven elég az átfutásra — a 15 másodperc viszont már a VISSZIRÁNYT is
      // blokkolta, ezért a felhasználó úgy látta, hogy a panel gombja nem hat.
      var themeSyncHoldRef = react.useRef(0);
      var THEME_SYNC_HOLD_MS = 6000;

      // Induláskor is szinkronizálunk, hogy a robot panel a MOSTANI témával
      // töltődjön — különben az első váltásig a mentett értékén maradna.
      react.useEffect(function () {
        if (typeof themePreference === "string" && themePreference.length > 0) {
          themeSyncHoldRef.current = Date.now();
          syncRobotPanelTheme(themePreference === "light" ? "light" : "dark");
        }
      }, [themePreference]);

      // A másik irány: a robot panel saját témagombja is hasson a DSH panelekre.
      //
      // MIÉRT ILYEN SŰRŰN (2 mp): a robot panel a saját gombjára AZONNAL vált, a
      // DSH viszont csak a következő lekérdezéskor értesül. 10 másodperccel a
      // felhasználó úgy látta, hogy „csak a robot panelt kapcsolja" — pedig a
      // szinkron működött, csak késve. A 2 mp alatt a váltás együtt mozog.
      // A láthatatlan (minimalizált) lapot nem terheljük.
      react.useEffect(function () {
        var timer = setInterval(function () {
          if (Date.now() - themeSyncHoldRef.current < THEME_SYNC_HOLD_MS) return;
          try {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          } catch (error) { }
          fetchWithTimeout("/ui-extras/github-action?action=robot-theme", null, 6000)
            .then(function (response) { return response.json(); })
            .then(function (body) {
              if (!body || body.ok !== true || !body.theme) return;
              var current = isDark ? "dark" : "light";
              if (body.theme === current) return;
              try {
                themeSyncHoldRef.current = Date.now();
                if (typeof props.theme.setTheme === "function") props.theme.setTheme(body.theme);
                else if (typeof props.theme.setPreference === "function") props.theme.setPreference(body.theme);
                setThemePreference(body.theme);
              } catch (error) {
                /* a szinkron nem kritikus */
              }
            })
            .catch(function () { /* a robot panel lehet, hogy épp nem fut */ });
        }, 2000);
        return function () { clearInterval(timer); };
      }, [isDark]);

      function refreshPage() {
        try {
          window.location.reload();
        } catch (error) {
          console.error("[dsh-ui-extras] reload failed:", error);
        }
      }

      /**
       * fetch() with a deadline. Without one a request issued just before the
       * server dies never settles at all — the browser keeps the socket open
       * waiting for a reply that cannot come — which is exactly how the restart
       * button used to leave the interface spinning forever.
       */
      function fetchWithTimeout(url, options, timeoutMs) {
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var timer = null;
        if (controller) {
          timer = setTimeout(function () {
            try { controller.abort(); } catch (error) { }
          }, timeoutMs);
        }
        var init = { headers: { Accept: "application/json" } };
        if (options) Object.keys(options).forEach(function (k) { init[k] = options[k]; });
        if (controller) init.signal = controller.signal;
        return fetch(url, init).then(function (response) {
          if (timer !== null) clearTimeout(timer);
          return response;
        }, function (error) {
          if (timer !== null) clearTimeout(timer);
          throw error;
        });
      }

      // Exposed to the connection watchdog below, which lives outside this
      // component but must navigate the same way when the server was replaced.
      serverRecovery = { fetchWithTimeout: fetchWithTimeout, reloadWhenServerIsBack: reloadWhenServerIsBack };

      /**
       * Navigate onto the freshest sign-in URL and reload.
       *
       * A restart mints a NEW token, so reloading the current address would
       * answer 401 and the interface would stay dead. The host exposes the
       * address the restart helper saved; the page retries until the fresh
       * server answers, then reloads onto it. Reloading the CURRENT address is
       * the last resort: it still helps whenever the token happens to be valid,
       * and it costs nothing when it is not.
       *
       * Returns a promise that settles when the page is navigating away, so the
       * caller can show status until the very last moment.
       */
      function reloadWhenServerIsBack(attempts, intervalMs) {
        var attempt = 0;
        // The OLD server keeps answering until the helper kills it, and it
        // reports the SAME old address. A candidate is therefore only accepted
        // once it comes from a DIFFERENT server process (a new pid), or — when
        // the host does not report a pid — once its file stamp moved forward.
        // Without this the page would reload onto the dead token and never
        // recover.
        var baselinePid = null;
        var baselineStamp = null;
        return new Promise(function (resolve) {
          function once() {
            attempt++;
            fetchWithTimeout("/ui-extras/harness-url", { cache: "no-store" }, 5000)
              .then(function (response) { return response.json(); })
              .then(function (body) {
                if (!body || body.ok !== true || typeof body.url !== "string") return null;
                var pid = body.pid === undefined || body.pid === null ? null : String(body.pid);
                var stamp = body.modifiedAt || "";
                if (baselinePid === null) baselinePid = pid;
                if (baselineStamp === null) baselineStamp = stamp;
                var fromNewProcess = pid !== null && baselinePid !== null && pid !== baselinePid;
                var stampMoved = pid === null && stamp !== "" && baselineStamp !== "" && stamp > baselineStamp;
                if (!fromNewProcess && !stampMoved) return null;
                // A server that answers proves the new process is up; only then
                // is its token worth using.
                return fetchWithTimeout("/", { cache: "no-store" }, 5000)
                  .then(function () { return body.url; })
                  .catch(function () { return null; });
              })
              .catch(function () { return null; })
              .then(function (fresh) {
                if (fresh) {
                  if (fresh !== window.location.href) window.location.replace(fresh);
                  else window.location.reload();
                  return resolve("navigating");
                }
                if (attempt >= attempts) {
                  window.location.reload();
                  return resolve("reloading current address");
                }
                setTimeout(once, intervalMs);
                return undefined;
              });
          }
          once();
        });
      }

      /**
       * Restart the Harness server. The host answers immediately and a detached
       * helper takes the server down a moment later, so the interface is never
       * left waiting on a socket that is about to disappear.
       */
      /**
       * Restart the Harness server.
       *
       * The host answers immediately and a detached helper takes the server down
       * a moment later. No reload is issued here: the WINDOW watches the sign-in
       * token and navigates onto the fresh one by itself, which is what keeps a
       * restart from leaving the page stuck — and a reload from inside the page
       * could not do that reliably anyway, because the request that asked for the
       * restart dies with the server it restarted.
       */
      function restartHarness() {
        try {
          var port = window.location.port || "3080";
          var bin = props.dshBin || "";
          setStatus({ kind: "working", text: t("restartRunning") });
          fetchWithTimeout("/ui-extras/github-action?action=restart-node&port=" + encodeURIComponent(port) +
            "&bin=" + encodeURIComponent(bin) + "&delay=1500", null, 10000)
            .then(function (response) { return response.json(); })
            .then(function (body) {
              if (!body || body.ok !== true) {
                setStatus({ kind: "error", text: (body && body.error) || "?" });
                return;
              }
              setStatus({ kind: "done", text: t("restartStarted") });
            })
            .catch(function (error) {
              // A lost answer still means the restart is under way: the helper is
              // detached, so the window reload is what finishes the job.
              setStatus({ kind: "working", text: t("restartStarted") });
              reportToHost("restart answer lost", String(error && error.message ? error.message : error));
            });
        } catch (error) {
          console.error("[dsh-ui-extras] restart failed:", error);
        }
      }

      /**
       * Deploy from the interface: the host writes the profile patch itself (the
       * running server already owns the profile), then restarts the Harness so the
       * bundle is rebuilt.
       *
       * Deliberately reload-free: the window notices the fresh sign-in token and
       * navigates onto it, so the page does not have to guess when the new server
       * is up — and must not, because the request that asked for the restart is
       * cancelled by the restart itself.
       */
      function deployPlugin() {
        setStatus({ kind: "working", text: t("deployRunning") });
        fetchWithTimeout("/ui-extras/github-action?action=install-plugin", null, 20000)
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!body || body.ok !== true) {
              setStatus({ kind: "error", text: (body && body.error) || t("deployFailed") });
              return { failed: true };
            }
            setStatus({ kind: "working", text: t("deployRestarting") });
            return fetchWithTimeout(
              "/ui-extras/github-action?action=restart-node&port=" + encodeURIComponent(window.location.port || "3080") +
              "&bin=" + encodeURIComponent(props.dshBin || "") + "&delay=1500",
              null, 10000
            ).then(function (response) { return response.json(); });
          })
          .then(function (body) {
            if (body && body.failed === true) return;
            if (body && body.ok === true) setStatus({ kind: "done", text: t("deployStarted") });
          })
          .catch(function (error) {
            // The patch is written before the restart, so the deploy continues by
            // itself; the window brings the page back.
            setStatus({ kind: "working", text: t("deployRestarting") });
            reportToHost("deploy answer lost", String(error && error.message ? error.message : error));
          });
      }

      // A panel a workspace gyokeret a session cwd-jebol kapja (a kliens
      // hivatalos útja: ctx.sessions.list.byId[sessionId].cwd).
      function workspaceRoot() {
        return resolveWorkspace(props.sessions, props.sessionId, props.workspaces, hostWorkspace);
      }

      /**
       * Show the terminals: as a TAB in the right sidebar, next to the files
       * panel — the layout can dock, split and remember it.
       *
       * `openTab` needs the sidebar's seat to be mounted; before that, or in a
       * composition without the right sidebar at all, the overlay is the only way
       * to reach the terminals, so it stays as the fallback.
       */
      function openTerminal() {
        if (openTerminalTab(props.sidebarRight)) {
          // The framework resets the column to its default when the panel opens,
          // so the remembered width is re-applied here as well.
          var root = workspaceRoot();
          if (root) applyRememberedWidth(root, 20);
          setCmdOpen(false);
          return;
        }
        setCmdOpen(true);
      }

      // A running operation only DISABLES the controls. Hiding them was a trap:
      // the status could stay on "working" (a server that restarts mid-request
      // never answers), and with every button gone the only way back was a
      // keyboard reload.
      var busy = status !== null && status.kind === "working";

      // Every hook above has run: this early return is phase-only. The hero copy
      // stretches across the composer column and keeps the controls at its right
      // edge, which is where the header copy sits in an active session.
      if (!phaseServesView(heroVariant, phase)) return null;
      var rootStyle = { display: "inline-flex", alignItems: "center", gap: "6px", position: "relative" };
      if (heroVariant) {
        // Same squeeze as the statistics row: this row is a flex child of the
        // hero composer stack, so it must opt out of shrinking to keep its
        // buttons on screen.
        rootStyle.flex = "none";
        rootStyle.width = "100%";
        rootStyle.justifyContent = "flex-end";
        rootStyle.boxSizing = "border-box";
        rootStyle.padding = "2px 8px";
      }

      return jsx.jsxs("span", {
        "data-dsh-ui-extras": "corner-controls",
        "data-dsh-ui-extras-variant": heroVariant ? "hero" : "header",
        style: rootStyle,
        children: [
          // One language button at a time: it shows the ACTIVE language and
          // clicking it switches to the other one, exactly like the theme
          // button. Showing both at once was confusing.
          isHungarian
            ? jsx.jsx(CornerButton, {
              icon: "HU",
              title: t("langSwitchToEnglish"),
              active: true,
              disabled: busy,
              onClick: function () { switchLanguage("en"); }
            })
            : jsx.jsx(CornerButton, {
              icon: "EN",
              title: t("langSwitchToHungarian"),
              disabled: busy,
              onClick: function () { switchLanguage("hu"); }
            }),
          jsx.jsx(CornerButton, {
            icon: isDark ? "☾" : "☀",
            title: isDark ? t("themeSwitchToLight") : t("themeSwitchToDark"),
            disabled: busy,
            onClick: switchTheme
          }),
          // Button order: language, theme, git, ssh, terminal, refresh, restart,
          // deploy. The panels themselves are rendered after the buttons.
          jsx.jsx(CornerButton, {
            icon: "⎇",
            title: t("gitOpen"),
            active: panelOpen,
            disabled: busy,
            onClick: function () { setPanelOpen(!panelOpen); }
          }),
          jsx.jsx(CornerButton, {
            icon: "🔑",
            title: t("sshOpen"),
            active: sshOpen,
            disabled: busy,
            onClick: function () { setSshOpen(!sshOpen); }
          }),
          jsx.jsx(CornerButton, {
            icon: "▶",
            title: t("cmdOpen"),
            active: cmdOpen,
            disabled: busy,
            onClick: openTerminal
          }),
          // Remembered consents: the only place a stored approval type can be
          // inspected and revoked, which is what keeps "mindig" reversible.
          jsx.jsx(CornerButton, {
            icon: "🛡",
            title: t("approvalPermissionsOpen"),
            active: permOpen,
            disabled: busy,
            onClick: function () { setPermOpen(!permOpen); }
          }),
          jsx.jsx(CornerButton, {
            icon: "⟳",
            title: t("refreshPage"),
            onClick: refreshPage
          }),
          jsx.jsx(CornerButton, {
            icon: "⭯",
            title: t("restartHarness"),
            disabled: busy,
            onClick: restartHarness
          }),
          jsx.jsx(CornerButton, {
            icon: "⇪",
            title: t("deployNow"),
            disabled: busy,
            onClick: deployPlugin
          }),
          status
            ? jsx.jsx("span", {
              "data-dsh-ui-extras": "status",
              title: status.text,
              style: {
                marginLeft: "6px",
                maxWidth: "220px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "11px",
                opacity: status.kind === "error" ? 0.95 : 0.75,
                color: status.kind === "error" ? "#ffb4ab" : "inherit"
              },
              children: status.text
            })
            : null,
          // Each panel sits in its own error boundary: a panel that throws must
          // not take the button row down with it.
          panelOpen
            ? jsx.jsx(PanelBoundary, {
              name: "Git panel",
              label: t("gitTitle"),
              onClose: function () { setPanelOpen(false); },
              children: jsx.jsx(GitPanel, {
                t: t,
                root: workspaceRoot(),
                // A commit-üzenet nyelvének alapértéke az aktív felületi nyelv;
                // a panel saját HU/EN kapcsolója ezt felülírhatja.
                localeId: localeId,
                onClose: function () { setPanelOpen(false); }
              })
            })
            : null,
          sshOpen
            ? jsx.jsx(PanelBoundary, {
              name: "SSH panel",
              label: t("sshTitle"),
              onClose: function () { setSshOpen(false); },
              children: jsx.jsx(SshPanel, { t: t, onClose: function () { setSshOpen(false); } })
            })
            : null,
          cmdOpen
            ? jsx.jsx(PanelBoundary, {
              name: "Terminal panel",
              label: t("cmdTitle"),
              onClose: function () { setCmdOpen(false); },
              children: jsx.jsx(CmdPanel, { t: t, workspace: workspaceRoot(), onClose: function () { setCmdOpen(false); } })
            })
            : null,
          permOpen
            ? jsx.jsx(PanelBoundary, {
              name: "Permissions panel",
              label: t("approvalPermissionsTitle"),
              onClose: function () { setPermOpen(false); },
              children: jsx.jsx(PermissionsPanel, { t: t, locale: props.locale, onClose: function () { setPermOpen(false); } })
            })
            : null
        ]
      });
    }

    /**
     * Nyelv, amiben a GÉP által írt commit üzenet születik.
     *
     * MIÉRT KÜLÖN a felület nyelvétől: a felület lehet magyar, miközben a repó
     * nyilvános, ezért angol commit üzenet kell. A választás ezért nem a globális
     * nyelvet állítja, hanem csak ezt a panelt — és megjegyzi magának.
     */
    var GIT_COMMIT_LANG_KEY = "dsh-ui-extras.gitCommitLang";

    function readGitCommitLang() {
      try {
        var raw = window.localStorage.getItem(GIT_COMMIT_LANG_KEY);
        return raw === "hu" || raw === "en" ? raw : "auto";
      } catch (error) {
        return "auto";
      }
    }

    function writeGitCommitLang(value) {
      try {
        window.localStorage.setItem(GIT_COMMIT_LANG_KEY, value === "hu" || value === "en" ? value : "auto");
      } catch (error) { }
    }

    /** A tényleges nyelv, amiben a host az automatikus üzenetet írja. */
    function resolveGitCommitLang(choice, localeId) {
      if (choice === "hu" || choice === "en") return choice;
      return isHungarianLocaleId(localeId) ? "hu" : "en";
    }

    /**
     * Git panel: the repositories of the current workspace with their branch,
     * tracking state and recent commit history. Data comes from the host route
     * `/ui-extras/git`, so git runs on the server next to the workspace.
     */
    // Memoized: the corner controls re-render on every statistics tick, and a
    // fresh element identity would remount the panel and drop the picked
    // repository. Memo keeps the component (and its local state) alive.
    var GitPanel = react.memo(function GitPanel(props) {
      var t = props.t;
      var state = react.useState({ status: "loading" });
      var data = state[0];
      var setData = state[1];

      var ghState = react.useState({ status: "loading" });
      var github = ghState[0];
      var setGithub = ghState[1];

      var actionState = react.useState(null);
      var action = actionState[0];
      var setAction = actionState[1];

      // The picked repository is remembered on the HOST, so reopening the panel
      // — or restarting the window, which mints a fresh browser profile — does
      // not silently drop the selection the user already made.
      var pickState = react.useState(function () {
        return typeof readTerminalPrefs(props.root).repo === "string" ? readTerminalPrefs(props.root).repo : "";
      });
      var pickedRepo = pickState[0];
      var setPickedRepo = pickState[1];

      // One fetch of this workspace's layout, then the selection is applied.
      react.useEffect(function () {
        if (!props.root) return undefined;
        var alive = true;
        loadPanelLayout(props.root).then(function (layout) {
          if (alive && layout && typeof layout.repo === "string" && layout.repo !== "") setPickedRepo(layout.repo);
        });
        return function () { alive = false; };
      }, [props.root]);

      react.useEffect(function () {
        if (!props.root || pickedRepo === "") return undefined;
        var timer = setTimeout(function () {
          savePanelLayout(props.root, { repo: pickedRepo });
        }, 400);
        return function () { clearTimeout(timer); };
      }, [props.root, pickedRepo]);

      var nameState = react.useState("");
      var newName = nameState[0];
      var setNewName = nameState[1];

      var privateState = react.useState(true);
      var privateRepo = privateState[0];
      var setPrivateRepo = privateState[1];

      // Optional commit message; empty means the host generates one from the
      // first changed path and the date.
      var messageState = react.useState("");
      var commitMessage = messageState[0];
      var setCommitMessage = messageState[1];

      // Commit üzenet nyelve (HU/EN/Automatikus): a felület nyelvétől független
      // választás, mert egy nyilvános repóhoz angol üzenet kell akkor is, ha a
      // felület magyar. Alapérték: az aktív felületi nyelv.
      var commitLangState = react.useState(function () { return readGitCommitLang(); });
      var commitLangChoice = commitLangState[0];
      var setCommitLangChoice = commitLangState[1];
      // Csak a KIVÁLASZTOTT nyelv látszik (a gomb felirata HU vagy EN); minden
      // további nyelv egy kattintásra van. Amíg nincs kézi választás, a felület
      // nyelvét követi — ezt a tooltip mondja meg.
      var commitLang = resolveGitCommitLang(commitLangChoice, props.localeId);
      var commitLangLabel = commitLang.toUpperCase();

      function toggleCommitLang() {
        var next = commitLang === "hu" ? "en" : "hu";
        writeGitCommitLang(next);
        setCommitLangChoice(next);
      }

      // Local repositories below the workspace root.
      function loadGit() {
        var root = props.root;
        if (!root) {
          setData({ status: "error", error: t("gitNoWorkspace") });
          return;
        }
        setData(function (previous) {
          // Keep the previous rows on a refresh: a commit or push must not blank
          // the panel while the request is in flight.
          return previous && previous.status === "ready" ? previous : { status: "loading" };
        });
        fetch("/ui-extras/git?root=" + encodeURIComponent(root), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            setData(body && body.ok === true ? { status: "ready", body: body } : { status: "error", error: (body && body.error) || "?" });
          })
          .catch(function (error) {
            setData({ status: "error", error: String(error && error.message ? error.message : error) });
          });
      }

      react.useEffect(function () { loadGit(); }, [props.root]);

      // GitHub CLI state and the repository list of the signed-in account.
      function loadGithub() {
        setGithub({ status: "loading" });
        fetch("/ui-extras/github" + (props.root ? "?root=" + encodeURIComponent(props.root) : ""), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) { setGithub(body && body.ok === true ? { status: "ready", body: body } : { status: "error", error: (body && body.error) || "?" }); })
          .catch(function (error) { setGithub({ status: "error", error: String(error && error.message ? error.message : error) }); });
      }

      react.useEffect(function () { loadGithub(); }, [props.root]);

      /**
       * Run one GitHub action on the host and report its result.
       *
       * A commit or a push CHANGES the repository state, so the git snapshot has
       * to be reloaded too — reloading only the GitHub side left the Push button
       * enabled and the ahead counter stale, which made a successful push look
       * like it had not happened. `after` runs on success, which is where a
       * consumed commit message is cleared.
       */
      function runGithubAction(params, after) {
        var label = params.action === "push" ? t("gitPushing")
          : params.action === "commit" ? t("gitCommitting")
            : params.action === "create" ? t("ghCreating")
              : t("ghWorking");
        setAction({ status: "working", message: label });
        var query = Object.keys(params)
          .map(function (key) { return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]); })
          .join("&");
        fetch("/ui-extras/github-action?" + query, { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) {
              setAction({ status: "done", message: body.output || body.remote || t("ghDone") });
              loadGithub();
              // Only a commit or a push moves the branch, but reloading the
              // snapshot unconditionally is cheaper than reasoning about which
              // action touches which field.
              loadGit();
              if (typeof after === "function") after(body);
            } else {
              setAction({ status: "error", message: (body && body.error) || "?" });
            }
          })
          .catch(function (error) {
            setAction({ status: "error", message: String(error && error.message ? error.message : error) });
          });
      }

      var repositories = data.status === "ready" ? data.body.repositories : [];
      var githubBody = github.status === "ready" ? github.body : null;
      var githubRepos = githubBody && githubBody.repositories ? githubBody.repositories : [];

      return jsx.jsxs("div", {
        "data-dsh-ui-extras": "git-panel",
        style: {
          position: "absolute",
          top: "30px",
          right: 0,
          zIndex: 40,
          width: "min(680px, 90vw)",
          maxHeight: "60vh",
          overflowY: "auto",
          padding: "10px 12px",
          border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
          borderRadius: "10px",
          background: "var(--dsw-alias-bg-layer-2, rgba(21,21,23,0.98))",
          color: "var(--dsw-alias-label-primary, #e8eaed)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
          fontSize: "12px",
          lineHeight: "18px",
          textAlign: "left"
        },
        children: [
          jsx.jsxs("div", {
            style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" },
            children: [
              jsx.jsx("strong", { children: t("gitTitle") }),
              // A ✕ mellett, attól BALRA: a commit üzenet nyelvének választója.
              // Egyszerre mindig csak a kiválasztott nyelv látszik; a másik
              // nyelv egy kattintásra van (a gomb a kettő között vált).
              jsx.jsx("button", {
                type: "button",
                title: t("gitCommitLangToggle", { lang: commitLang.toUpperCase() }),
                "aria-label": t("gitCommitLangToggle", { lang: commitLang.toUpperCase() }),
                onClick: toggleCommitLang,
                style: {
                  marginLeft: "auto",
                  marginRight: "8px",
                  border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.35))",
                  borderRadius: "6px",
                  background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.10))",
                  color: "inherit",
                  cursor: "pointer",
                  font: "inherit",
                  fontWeight: 600,
                  padding: "1px 8px"
                },
                children: commitLangLabel
              }),
              jsx.jsx("button", {
                type: "button",
                onClick: props.onClose,
                style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
                children: "✕"
              })
            ]
          }),
          // Commit / push row: both buttons are disabled when there is nothing
          // to do, and the message is optional (the host generates one).
          repositories.length > 0
            ? (function () {
              var primary = repositories[0];
              var state = data.status === "ready" && data.body ? data.body : null;
              var busy = action !== null && action.status === "working";
              var canCommit = primary.ok === true && (primary.changed > 0 || primary.untracked > 0) && !busy;
              var canPush = primary.ok === true && primary.ahead > 0 && !busy;
              return jsx.jsxs("div", {
                style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" },
                children: [
                  jsx.jsx("input", {
                    type: "text",
                    value: commitMessage,
                    placeholder: t("gitCommitPlaceholder"),
                    onChange: function (event) { setCommitMessage(event.currentTarget.value); },
                    style: { flex: "1 1 220px", padding: "2px 6px", borderRadius: "6px", background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", font: "inherit" }
                  }),
                  jsx.jsx("button", {
                    type: "button",
                    disabled: !canCommit,
                    title: canCommit ? t("gitCommit") : t("gitCommitDisabled"),
                    onClick: function () {
                      // The message is cleared only once the commit actually
                      // succeeded, so a failed commit does not lose what was typed.
                      runGithubAction({ action: "commit", root: props.root, message: commitMessage, lang: commitLang }, function () { setCommitMessage(""); });
                    },
                    style: { border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))", borderRadius: "7px", background: canCommit ? "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))" : "transparent", color: "inherit", opacity: canCommit ? 1 : 0.45, cursor: canCommit ? "pointer" : "not-allowed", font: "inherit", padding: "2px 10px" },
                    children: t("gitCommit")
                  }),
                  jsx.jsx("button", {
                    type: "button",
                    disabled: !canPush,
                    title: canPush ? t("gitPush") : t("gitPushDisabled"),
                    onClick: function () { runGithubAction({ action: "push", root: props.root }); },
                    style: { border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))", borderRadius: "7px", background: canPush ? "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))" : "transparent", color: "inherit", opacity: canPush ? 1 : 0.45, cursor: canPush ? "pointer" : "not-allowed", font: "inherit", padding: "2px 10px" },
                    children: t("gitPush")
                  }),
                  // Kiadás: a commit + tag + push + GitHub Release egy lépésben.
                  // Ez a projekt TELEPÍTHETŐ verzió (a bin\ exe-k a repóban vannak),
                  // ezért a push önmagában nem elég: a verzió és a Release is kell.
                  jsx.jsx("button", {
                    type: "button",
                    title: t("gitReleaseHint"),
                    onClick: function () { runGithubAction({ action: "release" }); },
                    style: { border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))", borderRadius: "7px", background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))", color: "inherit", cursor: "pointer", font: "inherit", padding: "2px 10px" },
                    children: t("gitRelease")
                  }),
                  primary.ok === true
                    ? jsx.jsx("span", {
                      // Az „állapot” eddig csak ennyi volt: „↑0 ↓0”. Ez két
                      // COMMIT-szám (feltolásra váró, illetve a távoli ágon
                      // lévő commitok), nem fájlszám — ezért most ki van írva,
                      // mennyi megy commitra és mennyi pushra.
                      style: { opacity: 0.7 },
                      title: t("gitStatusTooltip"),
                      children: "↑" + primary.ahead + " ↓" + primary.behind
                        + " · " + t("gitCommitFiles") + " " + (primary.changed + primary.untracked)
                    })
                    : null,
                  // Operation feedback: the two buttons look identical before and
                  // after a push, so without this the only evidence is the output
                  // line at the bottom of a long panel.
                  action
                    ? jsx.jsx("span", {
                      style: {
                        opacity: action.status === "working" ? 0.75 : 1,
                        color: action.status === "error" ? "#fca5a5" : action.status === "done" ? "#86efac" : "inherit"
                      },
                      title: action.message || "",
                      children: action.status === "working" ? "⏳ " + (action.message || "") : action.status === "done" ? "✔ " + (action.message || "") : "✕ " + (action.message || "")
                    })
                    : null
                ]
              });
            })()
            : null,          data.status === "loading" ? jsx.jsx("div", { children: t("balanceLoading") }) : null,
          data.status === "error" ? jsx.jsx("div", { children: t("gitError") + data.error }) : null,
          data.status === "ready" && repositories.length === 0
            ? jsx.jsx("div", { children: t("gitNoRepositories") })
            : null,
          repositories.map(function (repository, index) {
            return jsx.jsxs("div", {
              style: { marginTop: index === 0 ? 0 : "10px", paddingTop: index === 0 ? 0 : "8px", borderTop: index === 0 ? 0 : "1px solid rgba(255,255,255,0.10)" },
              children: [
                jsx.jsx("div", {
                  style: { display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" },
                  children: [
                    jsx.jsx("code", { style: { color: "var(--dsw-alias-label-primary, #f9fafb)" }, children: repository.path }),
                    repository.ok
                      ? jsx.jsx("span", { style: { opacity: 0.7 }, children: "(" + (repository.branch || "?") + ")" })
                      : null,
                    repository.ok ? jsx.jsx("span", {
                      style: { opacity: 0.8 },
                      title: t("gitChangedHint"),
                      children: t("gitChanged") + repository.changed + " · " + t("gitUntracked") + repository.untracked
                    }) : null,
                    repository.ok && (repository.ahead > 0 || repository.behind > 0)
                      ? jsx.jsx("span", { style: { opacity: 0.8 }, title: t("gitAheadBehindHint"), children: "↑" + repository.ahead + " ↓" + repository.behind })
                      : null
                  ]
                }),
                repository.ok === false ? jsx.jsx("div", { style: { opacity: 0.8 }, children: repository.error }) : null,
                repository.ok
                  ? jsx.jsx("ul", {
                    style: { margin: "4px 0 0", padding: 0, listStyle: "none" },
                    children: (repository.commits || []).slice(0, 10).map(function (commit) {
                      return jsx.jsxs("li", {
                        style: { display: "flex", gap: "8px", whiteSpace: "nowrap", overflow: "hidden" },
                        children: [
                          jsx.jsx("code", { style: { opacity: 0.7, flex: "0 0 auto" }, children: commit.hash }),
                          jsx.jsx("span", {
                            style: { flex: "0 0 auto", opacity: 0.6 },
                            title: commit.author ? commit.author : "",
                            children: formatCommitStamp(commit.date)
                          }),
                          jsx.jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis" }, children: commit.subject })
                        ]
                      }, commit.hash);
                    })
                  })
                  : null
              ]
            }, repository.path);
          }),
          // ---------------------------------------------------------- GitHub
          jsx.jsxs("div", {
            style: { marginTop: "12px", paddingTop: "8px", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))" },
            children: [
              jsx.jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
                children: [
                  jsx.jsx("strong", { children: t("ghTitle") }),
                  github.status === "ready" && githubBody && githubBody.ghInstalled === false
                    ? jsx.jsx("span", { style: { opacity: 0.8 }, children: t("ghNotInstalled") })
                    : null,
                  github.status === "ready" && githubBody && githubBody.ghInstalled === true
                    ? jsx.jsx("span", {
                      style: { opacity: 0.85 },
                      children: githubBody.authenticated ? t("ghLoggedIn") : t("ghNotLoggedIn")
                    })
                    : null,
                  jsx.jsx("button", {
                    type: "button",
                    onClick: loadGithub,
                    style: { border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", borderRadius: "7px", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", padding: "1px 8px" },
                    children: "⟳ " + t("ghRefresh")
                  })
                ]
              }),
              github.status === "ready" && githubBody && githubBody.ghInstalled === true && githubBody.authenticated === false
                ? jsx.jsxs("div", {
                  style: { marginTop: "6px" },
                  children: [
                    jsx.jsx("button", {
                      type: "button",
                      onClick: function () { runGithubAction({ action: "login" }); },
                      style: { border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))", borderRadius: "7px", background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))", color: "inherit", cursor: "pointer", font: "inherit", padding: "3px 10px" },
                      children: t("ghLogin")
                    }),
                    jsx.jsx("div", { style: { opacity: 0.7, marginTop: "4px" }, children: t("ghLoginHint") })
                  ]
                })
                : null,
              github.status === "ready" && githubBody && githubBody.authenticated === true
                ? jsx.jsxs("div", {
                  style: { marginTop: "6px", display: "flex", flexDirection: "column", gap: "6px" },
                  children: [
                    jsx.jsxs("div", {
                      style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
                      children: [
                        jsx.jsx("span", { style: { opacity: 0.7 }, children: t("ghPickRepo") }),
                        jsx.jsx("select", {
                          value: pickedRepo,
                          onChange: function (event) { setPickedRepo(event.currentTarget.value); },
                          style: { minWidth: "220px", padding: "2px 6px", borderRadius: "6px", background: "var(--dsw-alias-bg-layer-2, rgba(21,21,23,0.9))", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", font: "inherit" },
                          children: [jsx.jsx("option", { value: "", children: "—" })].concat(
                            githubRepos.map(function (repo) {
                              return jsx.jsx("option", {
                              value: repo.name,
                              children: repo.name + " (" + ((repo.visibility || "").toLowerCase() === "private" ? t("gitPrivateShort") : t("gitPublicShort")) + ")"
                            }, repo.name);
                            })
                          )
                        }),
                        jsx.jsx("button", {
                          type: "button",
                          disabled: pickedRepo === "" || !props.root,
                          onClick: function () { runGithubAction({ action: "connect", root: props.root, repo: pickedRepo }); },
                          style: { border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))", borderRadius: "7px", background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))", color: "inherit", cursor: "pointer", font: "inherit", padding: "2px 10px" },
                          children: t("ghConnect")
                        })
                      ]
                    }),
                    jsx.jsxs("div", {
                      style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
                      children: [
                        jsx.jsx("span", { style: { opacity: 0.7 }, children: t("ghCreateRepo") }),
                        jsx.jsx("input", {
                          type: "text",
                          value: newName,
                          placeholder: t("ghRepoName"),
                          onChange: function (event) { setNewName(event.currentTarget.value); },
                          style: { width: "160px", padding: "2px 6px", borderRadius: "6px", background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", font: "inherit" }
                        }),
                        jsx.jsxs("label", {
                          style: { display: "inline-flex", gap: "4px", alignItems: "center", opacity: 0.85 },
                          children: [
                            jsx.jsx("input", { type: "checkbox", checked: privateRepo, onChange: function (event) { setPrivateRepo(event.currentTarget.checked); } }),
                            privateRepo ? t("gitPrivateShort") : t("gitPublicShort")
                          ]
                        }),
                        jsx.jsx("button", {
                          type: "button",
                          disabled: newName === "" || !props.root,
                          onClick: function () {
                            runGithubAction({
                              action: "create",
                              root: props.root,
                              name: newName,
                              visibility: privateRepo ? "private" : "public"
                            });
                          },
                          style: { border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))", borderRadius: "7px", background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))", color: "inherit", cursor: "pointer", font: "inherit", padding: "2px 10px" },
                          children: t("ghCreate")
                        })
                      ]
                    })
                  ]
                })
                : null,
              action
                ? jsx.jsx("div", {
                  style: { marginTop: "6px", opacity: action.status === "error" ? 0.95 : 0.8, color: action.status === "error" ? "#ffb4ab" : "inherit", whiteSpace: "pre-wrap" },
                  children: (action.status === "working" ? t("ghWorking") : action.message) || ""
                })
                : null
            ]
          })
        ]
      });
    });

    /**
     * SSH panel: the user's SSH setup — config aliases, key files with their
     * fingerprints, and the known-hosts count. The key material never leaves the
     * host; only names and fingerprints travel to the browser.
     */
    var SshPanel = react.memo(function SshPanel(props) {
      var t = props.t;
      var state = react.useState({ status: "loading" });
      var data = state[0];
      var setData = state[1];

      // One test result per connection alias, so several rows can be checked
      // without the panel forgetting the earlier answers.
      var testState = react.useState({});
      var tests = testState[0];
      var setTests = testState[1];

      // Built-in editor for ~/.ssh/config. `content` is null while the editor is
      // closed, which keeps the panel compact until it is actually needed.
      var editorState = react.useState(null);
      var editor = editorState[0];
      var setEditor = editorState[1];

      function setTest(host, value) {
        setTests(function (previous) {
          var next = {};
          Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
          next[host] = value;
          return next;
        });
      }

      function refresh() {
        return fetch("/ui-extras/ssh", { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            setData(body && body.ok === true ? { status: "ready", body: body } : { status: "error", error: (body && body.error) || "?" });
          })
          .catch(function (error) {
            setData({ status: "error", error: String(error && error.message ? error.message : error) });
          });
      }

      react.useEffect(function () {
        var alive = true;
        fetch("/ui-extras/ssh", { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (alive) setData(body && body.ok === true ? { status: "ready", body: body } : { status: "error", error: (body && body.error) || "?" });
          })
          .catch(function (error) {
            if (alive) setData({ status: "error", error: String(error && error.message ? error.message : error) });
          });
        return function () { alive = false; };
      }, []);

      // A live session can also end on its own (the remote closes it, the
      // network drops). Poll the session list so the row stops claiming the
      // connection is open when it is not.
      react.useEffect(function () {
        var timer = setInterval(function () {
          fetch("/ui-extras/ssh?action=sessions", { headers: { Accept: "application/json" } })
            .then(function (response) { return response.json(); })
            .then(function (body) {
              if (!body || body.ok !== true) return;
              setData(function (previous) {
                if (!previous || previous.status !== "ready") return previous;
                return { status: "ready", body: Object.assign({}, previous.body, { sessions: body.sessions }) };
              });
            })
            .catch(function () { });
        }, 15000);
        return function () { clearInterval(timer); };
      }, []);

      /** Try one alias over SSH and keep the answer on that row. */
      function testConnection(host) {
        setTest(host, { status: "working" });
        fetch("/ui-extras/ssh?action=test&host=" + encodeURIComponent(host), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) {
              setTest(host, { status: "ok", message: body.output || t("sshTestOk") });
            } else {
              setTest(host, { status: "error", message: (body && body.error) || "?", hint: body && body.hint });
            }
          })
          .catch(function (error) {
            setTest(host, { status: "error", message: String(error && error.message ? error.message : error) });
          });
      }

      /**
       * Open or close a LIVE session for one alias.
       *
       * A test answers one question and exits; a session stays open until it is
       * closed here, which is what makes "disconnect" mean something. The row
       * shows the pid and the start time, so an open channel is always visible
       * instead of running unnoticed in the background.
       */
      function toggleSession(host, live) {
        setTest(host, { status: "working" });
        fetch("/ui-extras/ssh?action=" + (live ? "disconnect" : "connect") + "&host=" + encodeURIComponent(host),
          { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) {
              setTest(host, { status: "ok", message: body.output || (live ? t("sshDisconnected") : t("sshConnected")) });
            } else {
              setTest(host, { status: "error", message: (body && body.error) || "?" });
            }
            // Refresh so the row's live state follows the answer.
            refresh();
          })
          .catch(function (error) {
            setTest(host, { status: "error", message: String(error && error.message ? error.message : error) });
          });
      }

      /** Open the editor with whatever the config holds right now. */
      function openEditor() {
        setEditor({ status: "loading", content: "", path: "" });
        fetch("/ui-extras/ssh?action=config", { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) setEditor({ status: "ready", content: body.content, path: body.path, exists: body.exists === true });
            else setEditor({ status: "error", content: "", path: "", error: (body && body.error) || "?" });
          })
          .catch(function (error) {
            setEditor({ status: "error", content: "", path: "", error: String(error && error.message ? error.message : error) });
          });
      }

      /** Save the editor content and refresh the panel from the new file. */
      function saveEditor() {
        if (!editor) return;
        setEditor({ status: "saving", content: editor.content, path: editor.path, exists: editor.exists });
        fetch("/ui-extras/ssh?action=save&content=" + encodeURIComponent(editor.content), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) {
              setEditor({ status: "saved", content: editor.content, path: body.path || editor.path, output: body.output });
              refresh();
            } else {
              setEditor({ status: "error", content: editor.content, path: editor.path, error: (body && body.error) || "?" });
            }
          })
          .catch(function (error) {
            setEditor({ status: "error", content: editor.content, path: editor.path, error: String(error && error.message ? error.message : error) });
          });
      }

      var body = data.status === "ready" ? data.body : null;
      var rowStyle = { display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" };
      var smallButton = {
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22))",
        borderRadius: "7px",
        background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        padding: "1px 8px"
      };

      return jsx.jsxs("div", {
        "data-dsh-ui-extras": "ssh-panel",
        style: {
          position: "absolute",
          top: "30px",
          right: 0,
          zIndex: 40,
          // The editor needs room for a multi-line document; the read-only view
          // stays a small overlay.
          width: editor ? "min(760px, 95vw)" : "min(560px, 90vw)",
          maxHeight: editor ? "80vh" : "60vh",
          overflowY: "auto",
          padding: "10px 12px",
          border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
          borderRadius: "10px",
          background: "var(--dsw-alias-bg-layer-2, rgba(21,21,23,0.98))",
          color: "var(--dsw-alias-label-primary, #e8eaed)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
          fontSize: "12px",
          lineHeight: "18px",
          textAlign: "left"
        },
        children: [
          jsx.jsxs("div", {
            style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" },
            children: [
              jsx.jsx("strong", { children: t("sshTitle") }),
              jsx.jsxs("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center" }, children: [
                jsx.jsx("button", {
                  type: "button",
                  title: t("sshEditConfigHint"),
                  onClick: openEditor,
                  style: smallButton,
                  children: "✎ " + t("sshEditConfig")
                }),
                jsx.jsx("button", {
                  type: "button",
                  onClick: props.onClose,
                  style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
                  children: "✕"
                })
              ] })
            ]
          }),
          data.status === "loading" ? jsx.jsx("div", { children: t("balanceLoading") }) : null,
          data.status === "error" ? jsx.jsx("div", { children: t("gitError") + data.error }) : null,
          body && body.exists === false ? jsx.jsx("div", { children: t("sshNoDirectory") + " " + body.directory }) : null,
          body && body.exists
            ? jsx.jsxs("div", {
              children: [
                jsx.jsx("div", { style: { opacity: 0.7, marginBottom: "6px" }, children: t("sshDirectory") + " " + body.directory }),
                jsx.jsx("div", { style: { fontWeight: 600, marginTop: "4px" }, children: t("sshConnections") + " (" + body.connections.length + ")" }),
                body.connections.length === 0
                  ? jsx.jsx("div", { style: { opacity: 0.7 }, children: t("sshNoConnections") })
                  : jsx.jsx("ul", {
                    style: { margin: "2px 0 8px", padding: 0, listStyle: "none" },
                    children: body.connections.map(function (connection) {
                      var test = tests[connection.host];
                      // Testing and connecting need an address: an alias with no
                      // HostName is a pattern block (for example `Host *`), not a
                      // target.
                      var target = connection.hostName || null;
                      var session = (body.sessions || []).filter(function (item) { return item.alias === connection.host; })[0] || null;
                      var live = session !== null && session.live === true;
                      return jsx.jsxs("li", {
                        style: { marginBottom: "4px" },
                        children: [
                          jsx.jsxs("div", {
                            style: rowStyle,
                            children: [
                              jsx.jsx("code", { style: { color: "var(--dsw-alias-label-primary, #f9fafb)" }, children: connection.host }),
                              jsx.jsx("span", { style: { opacity: 0.7 }, children: (connection.user ? connection.user + "@" : "") + (connection.hostName || "") + (connection.port ? ":" + connection.port : "") }),
                              // A live session is the state the user can act on,
                              // so its button comes first and is clearly labelled.
                              jsx.jsx("button", {
                                type: "button",
                                disabled: target === null || (test && test.status === "working"),
                                title: target === null ? t("sshTestNoHostName") : live ? t("sshDisconnectHint") : t("sshConnectHint"),
                                onClick: function () { toggleSession(connection.host, live); },
                                style: target === null
                                  ? Object.assign({}, smallButton, { opacity: 0.45, cursor: "not-allowed" })
                                  : live
                                    ? Object.assign({}, smallButton, { borderColor: "var(--dsw-alias-state-success-secondary, rgba(134,239,172,0.6))" })
                                    : smallButton,
                                children: test && test.status === "working"
                                  ? t("sshWorking")
                                  : live ? "■ " + t("sshDisconnect") : "● " + t("sshConnect")
                              }),
                              jsx.jsx("button", {
                                type: "button",
                                disabled: target === null || (test && test.status === "working"),
                                title: target === null ? t("sshTestNoHostName") : t("sshTestHint"),
                                onClick: function () { testConnection(connection.host); },
                                style: target === null
                                  ? Object.assign({}, smallButton, { opacity: 0.45, cursor: "not-allowed" })
                                  : smallButton,
                                children: t("sshTest")
                              }),
                              live
                                ? jsx.jsx("span", { style: { color: "#86efac", opacity: 0.9 }, children: t("sshSessionLive") + " (pid " + session.pid + ")" })
                                : null
                            ]
                          }),
                          test
                            ? jsx.jsxs("div", {
                              style: {
                                marginLeft: "12px",
                                whiteSpace: "pre-wrap",
                                color: test.status === "error" ? "#fca5a5" : test.status === "ok" ? "#86efac" : "inherit",
                                opacity: test.status === "working" ? 0.7 : 0.95
                              },
                              children: [
                                test.status === "ok" ? "✔ " : test.status === "error" ? "✕ " : "⏳ ",
                                test.message || "",
                                test.hint ? jsx.jsx("div", { style: { opacity: 0.8, marginTop: "2px" }, children: "ℹ " + test.hint }) : null
                              ]
                            })
                            : null
                        ]
                      }, connection.host);
                    })
                  }),
                jsx.jsx("div", { style: { fontWeight: 600 }, children: t("sshKeys") + " (" + body.keys.length + ")" }),
                body.keys.length === 0
                  ? jsx.jsx("div", { style: { opacity: 0.7 }, children: t("sshNoKeys") })
                  : jsx.jsx("ul", {
                    style: { margin: "2px 0 8px", padding: 0, listStyle: "none" },
                    children: body.keys.map(function (key) {
                      return jsx.jsxs("li", {
                        style: rowStyle,
                        children: [
                          jsx.jsx("code", { style: { color: "var(--dsw-alias-label-primary, #f9fafb)" }, children: key.name }),
                          jsx.jsx("span", { style: { opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis" }, children: key.fingerprint || "?" })
                        ]
                      }, key.name);
                    })
                  }),
                jsx.jsx("div", { style: { opacity: 0.8 }, children: t("sshKnownHosts") + " " + body.knownHosts }),
                body.agentKeys && body.agentKeys.length > 0
                  ? jsx.jsxs("div", {
                    children: [
                      jsx.jsx("div", { style: { fontWeight: 600, marginTop: "6px" }, children: t("sshAgentKeys") }),
                      jsx.jsx("ul", {
                        style: { margin: "2px 0 0", padding: 0, listStyle: "none" },
                        children: body.agentKeys.map(function (line, index) {
                          return jsx.jsx("li", { style: { opacity: 0.75 }, children: line }, index);
                        })
                      })
                    ]
                  })
                  : null,
                // ------------------------------------------------- editor
                editor === null
                  ? null
                  : jsx.jsxs("div", {
                    style: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))" },
                    children: [
                      jsx.jsxs("div", {
                        style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "4px" },
                        children: [
                          jsx.jsx("strong", { children: t("sshEditorTitle") }),
                          jsx.jsx("code", { style: { opacity: 0.65 }, children: editor.path || "~/.ssh/config" })
                        ]
                      }),
                      editor.status === "loading"
                        ? jsx.jsx("div", { children: t("balanceLoading") })
                        : jsx.jsxs("div", {
                          children: [
                            jsx.jsx("textarea", {
                              value: editor.content,
                              spellCheck: false,
                              rows: 12,
                              onChange: function (event) {
                                var value = event.currentTarget.value;
                                setEditor(function (previous) {
                                  return Object.assign({}, previous, { content: value, status: "ready", output: null, error: null });
                                });
                              },
                              style: {
                                width: "100%",
                                boxSizing: "border-box",
                                minHeight: "180px",
                                resize: "vertical",
                                padding: "6px 8px",
                                borderRadius: "8px",
                                border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
                                background: "var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.35))",
                                color: "var(--dsw-alias-label-primary, #e8eaed)",
                                fontFamily: "Consolas, 'Cascadia Mono', monospace",
                                fontSize: "12px",
                                lineHeight: "16px",
                                whiteSpace: "pre"
                              }
                            }),
                            jsx.jsxs("div", {
                              style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" },
                              children: [
                                jsx.jsx("button", {
                                  type: "button",
                                  disabled: editor.status === "saving",
                                  onClick: saveEditor,
                                  style: smallButton,
                                  children: editor.status === "saving" ? t("sshSaving") : t("save")
                                }),
                                jsx.jsx("button", {
                                  type: "button",
                                  onClick: function () { setEditor(null); },
                                  style: smallButton,
                                  children: t("sshEditorClose")
                                }),
                                jsx.jsx("span", { style: { opacity: 0.6 }, children: t("sshEditorHint") }),
                                editor.output
                                  ? jsx.jsx("span", { style: { color: "#86efac", whiteSpace: "pre-wrap" }, children: "✔ " + editor.output })
                                  : null,
                                editor.error
                                  ? jsx.jsx("span", { style: { color: "#fca5a5", whiteSpace: "pre-wrap" }, children: "✕ " + editor.error })
                                  : null
                              ]
                            })
                          ]
                        })
                    ]
                  })
              ]
            })
            : null
        ]
      });
    });

    /**
     * The terminal panel's own remembered layout.
     *
     * The right sidebar remembers its column arrangement, but not what OUR panel
     * was doing inside it: which terminal was selected, which one was expanded,
     * and the output filter. Those used to live in browser local storage, which
     * turned out to be the wrong place: every window generation gets a fresh
     * WebView2 profile directory, and each profile carries its own local storage,
     * so the layout was lost exactly when it was needed. The host keeps it
     * instead, in state/panel-layout.json, keyed by workspace.
     */
    var LAYOUT_ROUTE = "/ui-extras/layout";

    /**
     * How many terminal panels this page has mounted, counted for the host log.
     *
     * A panel that remounts (a fresh component identity per render is the usual
     * cause) starts over — including any per-mount "open one shell" step — so the
     * count in the log is what distinguishes "the panel came back" from "the panel
     * never went away".
     */
    var panelMounts = 0;

    /**
     * Whether a panel's own element is really on screen.
     *
     * A docked tab that is not the active one stays mounted but hidden, and a
     * hidden panel must not start processes or write heartbeats. `offsetParent`
     * is null for a `display:none` branch and for a detached node, which is
     * exactly the distinction needed; a fixed-position element reports null too,
     * so the bounding box is the second opinion.
     */
    function panelOnScreen(node) {
      try {
        if (!node || !node.isConnected) return false;
        var box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      } catch (error) {
        return false;
      }
    }

    /** Remembered layouts by workspace, filled from the host. */
    var terminalPrefsCache = {};

    /**
     * The terminal panel's monospace stack.
     *
     * A terminal has a natural typeface and this is it: Cascadia Mono is the
     * Windows Terminal default, Consolas/Menlo cover older machines, and the
     * generic `monospace` is the floor. It starts with `ui-monospace` so every
     * platform resolves to its own terminal font before any fallback.
     */
    var TERMINAL_FONT = "ui-monospace, 'Cascadia Mono', 'Cascadia Code', Consolas, Menlo, 'DejaVu Sans Mono', monospace";

    /** The faces the panel offers, in the order the font button cycles them. */
    var FONT_OPTIONS = [
      { id: "default", label: "Rendszer", font: TERMINAL_FONT },
      { id: "cascadia", label: "Cascadia Mono", font: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace" },
      { id: "consolas", label: "Consolas", font: "Consolas, 'Courier New', monospace" },
      { id: "courier", label: "Courier New", font: "'Courier New', Courier, monospace" }
    ];

    /** The sizes the size button cycles, in pixels. */
    var SIZE_OPTIONS = [10, 11, 11.5, 12, 12.5, 13, 14, 15, 16];

    /**
     * The reader's own terminal appearance, shared by every workspace.
     *
     * Deliberately not part of the per-workspace layout: the face and the size are
     * about this person's eyes and screen, not about one project, so they are
     * stored once in localStorage.
     */
    var FONT_PREF_KEY = "dsh-ui-extras.terminalFont";

    /** Whether the input line may show what is typed in it (default: it may not). */
    var ECHO_PREF_KEY = "dsh-ui-extras.terminalEcho";

    /**
     * The input line is hidden by default, and that default is the point.
     *
     * A `sudo`/`ssh`/`git` prompt asks for a password through the SAME input this
     * panel uses for ordinary text, and there is no general way to know that a
     * prompt is a secret one — the process only knows. Masking is therefore the
     * safe default: an echoed password ends up in a tooltip, a screenshot, a shared
     * screen or a recording. Anyone who wants to see what they type (a long path, a
     * one-off command) can reveal it with the eye button, and that choice is
     * remembered.
     */
    function readEchoPref() {
      try {
        return window.localStorage.getItem(ECHO_PREF_KEY) === "1";
      } catch (error) {
        return false;
      }
    }

    function writeEchoPref(show) {
      try {
        window.localStorage.setItem(ECHO_PREF_KEY, show ? "1" : "0");
      } catch (error) { }
    }

    /**
     * Whether a line looks like a SECRET prompt.
     *
     * Only used to warn the reader (the field is masked either way): the moment a
     * password prompt appears is exactly when it must be obvious that nothing is
     * echoed. Words are matched in both languages the panel ships.
     */
    function looksLikeSecretPrompt(line) {
      return /(password|passphrase|jelszo|jelszó|passwd|\bpin\b|secret|token|api[-_ ]?key)/iu.test(String(line || ""));
    }

    function readFontPrefs() {
      var fallback = { font: 0, size: Math.max(0, SIZE_OPTIONS.indexOf(12)) };
      try {
        var raw = window.localStorage.getItem(FONT_PREF_KEY);
        if (raw === null) return fallback;
        var parsed = JSON.parse(raw);
        var font = Number(parsed && parsed.font);
        var size = Number(parsed && parsed.size);
        return {
          font: isFinite(font) ? Math.max(0, Math.min(FONT_OPTIONS.length - 1, Math.round(font))) : fallback.font,
          size: isFinite(size) ? Math.max(0, Math.min(SIZE_OPTIONS.length - 1, Math.round(size))) : fallback.size
        };
      } catch (error) {
        return fallback;
      }
    }

    function writeFontPrefs(prefs) {
      try {
        window.localStorage.setItem(FONT_PREF_KEY, JSON.stringify(prefs));
      } catch (error) { }
    }

    /**
     * ANSI escape sequences, as they arrive in a piped terminal.
     *
     * Why this is stripped rather than rendered: a colour code written by a tool
     * (`vite`, `npm`, a watcher) reached the panel as literal text — the reader saw
     * small boxes like `[32m` in the middle of the output. Stripping is also the
     * honest reading of a NON-tty: the colour only exists for a console that can
     * show it, and this panel is not one.
     */
    var ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

    /**
     * Read one chunk into the lines it represents.
     *
     * A carriage return means "back to the start of this line" — a progress
     * spinner or a Vite log rewrites its own line that way, so treating `\r` as a
     * line break (the old behaviour) printed the same line several times.
     * @param clean - the text with its escape sequences already removed.
     * @param carry - the unfinished line of the previous chunk.
     * @returns the finished lines and the new unfinished tail.
     */
    function ingestTerminalText(clean, carry) {
      var lines = [];
      var pending = carry || "";
      for (var i = 0; i < clean.length; i++) {
        var ch = clean.charAt(i);
        if (ch === "\n") {
          lines.push(pending);
          pending = "";
          continue;
        }
        if (ch === "\r") {
          pending = "";
          continue;
        }
        if (ch === "\b") {
          pending = pending.slice(0, -1);
          continue;
        }
        pending += ch;
      }
      return { lines: lines, carry: pending };
    }

    /**
     * The rendered `<pre>` of every terminal, by run id.
     *
     * The tail-follow cannot live in the render: the scroll position has to be
     * set AFTER the new text is in the DOM, which is what a `useEffect` keyed on
     * the output gives — and the element itself is needed for that.
     */
    var outputNodes = { current: {} };

    /** True while the reader is watching the tail, false once they scroll up. */
    var followTail = { current: true };
    /** The remembered layout of one workspace; empty until the host answers. */
    function readTerminalPrefs(workspace) {
      if (!workspace) return {};
      var cached = terminalPrefsCache[workspace];
      return cached && typeof cached === "object" ? cached : {};
    }

    function applyTerminalPrefs(workspace, prefs) {
      if (!workspace || !prefs || typeof prefs !== "object") return;
      terminalPrefsCache[workspace] = prefs;
    }

    /**
     * Write layout fields to the host.
     *
     * One request per field rather than a whole-document save, so a request
     * already in flight can never overwrite a newer field with an older copy.
     */
    function writeTerminalPrefs(workspace, patch) {
      if (!workspace) return;
      var current = readTerminalPrefs(workspace);
      applyTerminalPrefs(workspace, Object.assign({}, current, patch));
      Object.keys(patch).forEach(function (key) {
        fetch(LAYOUT_ROUTE + "?workspace=" + encodeURIComponent(workspace) +
          "&key=" + encodeURIComponent(key) + "&value=" + encodeURIComponent(JSON.stringify(patch[key])),
          { headers: { Accept: "application/json" } }).catch(function () { });
      });
    }

    /** Fetch one workspace's layout into the cache; resolves with it. */
    function loadPanelLayout(workspace) {
      if (!workspace) return Promise.resolve({});
      return fetch(LAYOUT_ROUTE + "?workspace=" + encodeURIComponent(workspace), { headers: { Accept: "application/json" } })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          if (body && body.ok === true && body.layout) {
            applyTerminalPrefs(workspace, body.layout);
            return body.layout;
          }
          return {};
        })
        .catch(function () { return {}; });
    }

    /** Remember one layout field of a workspace. */
    function savePanelLayout(workspace, patch) {
      writeTerminalPrefs(workspace, patch);
    }

    /**
     * Track whether the terminal panel is on screen.
     *
     * A page cannot run anything while it is closing, so "was it open?" is
     * answered by the ABSENCE of a signal: the mounted panel refreshes
     * `terminalOpen` every few seconds, and a value that has gone stale means the
     * page went away with the panel open — which is exactly when the next page
     * should reopen it. Closing the tab clears the flag at once, so a deliberate
     * close stays closed.
     */
    function startTerminalHeartbeat(workspace) {
      if (!workspace) return function () { };
      function beat() {
        writeTerminalPrefs(workspace, { terminalOpen: Math.floor(Date.now() / 1000) });
      }
      beat();
      var timer = setInterval(beat, 4000);
      return function () {
        clearInterval(timer);
        writeTerminalPrefs(workspace, { terminalOpen: 0 });
      };
    }

    /**
     * Drop the shell's prompt prefix from every line.
     *
     * A piped PowerShell still prints `PS C:\some\path> ` before each statement
     * and before each result line. That prefix is noise in a panel that already
     * shows the working directory, and stripping it is what makes the transcript
     * readable.
     */
    function stripPrompts(text) {
      if (!text) return "";
      return text.replace(/^PS\s+[^\r\n>]{1,260}>\s?/u, "");
    }

    /**
     * Remove ANSI escape sequences from one chunk.
     *
     * A piped console program still writes colour codes because it sees a
     * "terminal"; the panel has no colour model, so without this the codes show up
     * as the little boxes (`[32m`) the reader complained about. Anything that is
     * not an escape sequence is left exactly as it arrived.
     */
    function stripAnsi(text) {
      if (!text) return "";
      return String(text).replace(ANSI_PATTERN, "");
    }

    /** Open the terminal tab, ignoring a composition without the right sidebar. */
    function openTerminalTab(sidebarRight) {
      try {
        if (sidebarRight && typeof sidebarRight.openTab === "function") {
          sidebarRight.openTab(TERMINAL_KIND);
          return true;
        }
      } catch (error) {
        reportToHost("terminal tab failed", String(error && error.message ? error.message : error));
      }
      return false;
    }

    /**
     * Put the remembered column width back on the frame, once.
     *
     * The framework resets the column to its 45% default whenever the right panel
     * re-opens, so restoring the width at start-up is not enough: it has to happen
     * after the panel is shown as well. A handful of tries covers the render that
     * follows, and then it stops — re-applying it forever is what made the column
     * jump, and writing it while nobody asked is what made it look like the panel
     * resized itself.
     */
    /**
     * The frame element that owns the three column tracks.
     *
     * Identified by its CONTENT, not by a class name: the frame's class is a
     * build-time hash, and the earlier `div[class*="frame"]` lookup silently found
     * nothing — which is why the remembered width was never written at all. The
     * grid is the element whose inline `grid-template-columns` has three tracks;
     * `[data-rightbar-col]` (the framework's own marker) is the fallback, because
     * its parent is that grid.
     */
    function findLayoutFrame() {
      try {
        var best = null;
        var nodes = document.querySelectorAll("div");
        for (var i = 0; i < nodes.length; i++) {
          var style = nodes[i].style ? String(nodes[i].style.gridTemplateColumns || "") : "";
          if (style === "") continue;
          var parts = style.split(/\s+/u).filter(function (part) { return part.length > 0; });
          if (parts.length === 3) return nodes[i];
          if (best === null && style.indexOf("minmax") >= 0) best = nodes[i];
        }
        if (best !== null) return best;
        var col = document.querySelector("[data-rightbar-col]");
        if (col && col.parentElement) return col.parentElement;
        return null;
      } catch (error) {
        return null;
      }
    }

    /**
     * The right sidebar's resize handle, and the drag callback its React props carry.
     *
     * The column width is NOT the frame's grid value: the panel is drawn at the
     * layout store's own `rightbar` preference, and the grid only mirrors it — which
     * is why writing `grid-template-columns` had no visible effect at all while the
     * panel kept its 45% default and covered the conversation.
     *
     * The probe below is kept because it is how that was established: the handle's
     * React props carry only the pointer handlers, never the drag callback.
     */
    /**
     * Report what the handle element actually carries, once per page.
     *
     * The drag callback is NOT among the handle's props (only the pointer handlers
     * are), which is what this proves — calling the framework's pointer path is
     * therefore the way to set the width.
     */
    function probeHandleOnce() {
      try {
        var handle = document.querySelector('[data-side="rightbar"]');
        if (!handle) {
          reportToHost("terminal probe", "no handle element");
          return;
        }
        var keys = Object.keys(handle);
        var report = [];
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__react") !== 0) continue;
          var value = handle[keys[i]];
          if (!value || typeof value !== "object") { report.push(keys[i].slice(0, 20) + "=non-object"); continue; }
          report.push(keys[i].slice(0, 20) + "{" + Object.keys(value).slice(0, 10).join("/") + "}");
        }
        reportToHost("terminal probe", "domKeys=" + String(keys.length) +
          " react=" + (report.length > 0 ? report.join(" ") : "none"));
      } catch (error) {
        reportToHost("terminal probe", "failed: " + String(error && error.message ? error.message : error));
      }
    }

    /** The right column's current width, as the framework actually draws it. */
    function rightbarColumnWidth() {
      try {
        var col = document.querySelector("[data-rightbar-col]");
        return col ? Math.round(col.getBoundingClientRect().width) : 0;
      } catch (error) {
        return 0;
      }
    }

    /**
     * Ask the framework's own resize path to set the column to `saved` pixels.
     *
     * The drag logic is NOT published on the handle's React props (its `onDrag`
     * belongs to the component, not to the host element), but the pointer handlers
     * are. A real `pointerdown` therefore starts the drag through the framework's
     * own code — capture included — and a synthetic `pointermove` on the captured
     * pointer then carries the delta, exactly like a user's drag. Nothing here
     * reaches into framework internals.
     */
    function dragColumnTo(saved, sign) {
      try {
        var handle = document.querySelector('[data-side="rightbar"]');
        if (!handle) return null;
        var current = rightbarColumnWidth();
        if (current < 240) return null;
        // `sign` lets the caller flip the direction after measuring that the first
        // attempt moved away from the target.
        var delta = (current - saved) * (typeof sign === "number" ? sign : 1);
        if (Math.abs(delta) < 4) return { from: current, to: current };
        var rect = handle.getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + rect.height / 2;
        var base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 };
        syntheticDrag = true;
        try {
          handle.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, base)));
          // The framework computes `new = base - (moveX - downX)`, so moving the
          // pointer to `x + delta` asks for `current - delta = saved`. Sending
          // `x - delta` instead lands on `2*current - saved`, which is how a drag
          // once squeezed the column to a third of its width.
          handle.dispatchEvent(new PointerEvent("pointermove", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }, base, { clientX: x + delta })));
          handle.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }, base, { clientX: x + delta })));
        } finally {
          // Cleared on the next tick: the width watcher sees the pointerup it must
          // ignore, and a real drag afterwards is still recorded.
          setTimeout(function () { syntheticDrag = false; }, 0);
        }
        return { from: current, to: saved };
      } catch (error) {
        reportToHost("terminal width", "drag failed: " + String(error && error.message ? error.message : error));
        return null;
      }
    }

    /**
     * Write the remembered width through the framework's own drag path, retrying
     * while the column and its handle settle. Stops as soon as the column measures
     * what was asked for, so it never fights the framework.
     */
    function applyRememberedWidth(workspace, tries) {
      if (widthRestoreState.started) return;
      widthRestoreState.started = true;
      var left = typeof tries === "number" ? tries : 30;

      function usePrefs(prefs) {
        var saved = Number(prefs.rightbarWidth || 0);
        reportToHost("terminal width", "workspace=" + String(workspace) +
          " keys=" + Object.keys(prefs).join("/") + " saved=" + String(saved));
        if (saved < 240) return;
        var attempt = 0;
        var lastSign = 1;
        var timer = setInterval(function () {
          attempt++;
          var current = rightbarColumnWidth();
          var done = false;
          if (current >= 240 && Math.abs(current - saved) < 6) {
            reportToHost("terminal width", "settled at " + String(current) + " (wanted " + String(saved) + ")");
            done = true;
          } else if (current > 0 && attempt <= 6) {
            // Verified, not assumed: the drag is sent, the column is measured again,
            // and a sign that moved it the wrong way is flipped on the next try.
            var before = current;
            var result = dragColumnTo(saved, lastSign);
            var after = rightbarColumnWidth();
            reportToHost("terminal width", "drag " + String(before) + " -> " + String(after) +
              " (wanted " + String(saved) + ", sign " + String(lastSign) + ")");
            if (after >= 240 && Math.abs(after - saved) > Math.abs(before - saved)) {
              lastSign = -lastSign;
              reportToHost("terminal width", "that moved away from the target; flipping direction");
            }
            if (result === null) done = true;
          } else {
            done = true;
          }
          if (done || attempt >= left) clearInterval(timer);
        }, 700);
      }

      // The cache is empty on a fresh page — the layout request is still in flight —
      // and returning early for that was exactly why the width never came back.
      var cached = readTerminalPrefs(workspace);
      if (cached && Number(cached.rightbarWidth || 0) >= 240) {
        usePrefs(cached);
        return;
      }
      fetch(LAYOUT_ROUTE + "?workspace=" + encodeURIComponent(workspace), { headers: { Accept: "application/json" } })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          var layout = body && body.ok === true && body.layout ? body.layout : {};
          applyTerminalPrefs(workspace, layout);
          usePrefs(layout);
        })
        .catch(function () { });
    }

    var CmdPanel = react.memo(function CmdPanel(props) {
      var t = props.t;
      var workspace = props.workspace;
      var docked = props.docked === true;
      var prefs = readTerminalPrefs(workspace);

      // Proof that this component actually ran, and with what. The panel opening
      // while nothing appears can mean the tab body never rendered, and that is
      // invisible from the host without a line like this.
      var panelIdRef = react.useRef(null);
      if (panelIdRef.current === null) {
        panelMounts += 1;
        panelIdRef.current = String(panelMounts);
      }
      react.useEffect(function () {
        reportToHost("panel mounted", "docked=" + String(docked) +
          " panel=" + String(panelIdRef.current) +
          " propWorkspace=" + String(workspace) + " hostWorkspace=" + String(hostWorkspace));
      }, []);

      var state = react.useState({ status: "loading" });
      var data = state[0];
      var setData = state[1];

      // Several terminals at once. Each entry holds the server-side run id, the
      // output received so far and the server's own length counter, so a poll
      // returns only the new part.
      var termState = react.useState({});
      var terminals = termState[0];
      var setTerminals = termState[1];

      // Which terminal the command line targets, and which one is expanded.
      var activeState = react.useState(typeof prefs.active === "string" ? prefs.active : null);
      var activeId = activeState[0];
      var setActiveId = activeState[1];

      var zoomState = react.useState(typeof prefs.zoom === "string" ? prefs.zoom : null);
      var zoomId = zoomState[0];
      var setZoomId = zoomState[1];

      var inputState = react.useState("");
      var input = inputState[0];
      var setInput = inputState[1];

      var searchState = react.useState(typeof prefs.search === "string" ? prefs.search : "");
      var search = searchState[0];
      var setSearch = searchState[1];

      /**
       * The workspace FOLLOWS the pane's current Session.
       *
       * The tab body is mounted once and its injected props are captured at that
       * moment — `sessions` is a live service, but nothing re-renders the body
       * when the user switches conversation, which is how "npm run dev" ended up
       * running in the Harness's own directory: the panel kept the workspace it
       * resolved on its first render (the host fallback) while the Session in
       * front of the user had a different `cwd`, and the saved commands of the
       * real project never appeared because the panel asked the host for the
       * WRONG workspace's list.
       *
       * So the current selection is re-read on a timer and on every
       * focus/visibility change, and the panel moves with it. The order is:
       * the injected prop (a panel that was given a workspace keeps it), then the
       * Session's own `cwd` — the directory the conversation works in — then the
       * selected workspace, and the host's own directory only as the very last
       * resort, once the session list has genuinely nothing to say.
       */
      var liveState = react.useState(function () {
        return pickSessionWorkspace(props.sessions) || resolveWorkspace(props.sessions, null, props.workspaces, null);
      });
      var liveWorkspace = liveState[0];
      var setLiveWorkspace = liveState[1];
      var trackedWorkspace = react.useRef(liveWorkspace);
      trackedWorkspace.current = liveWorkspace;

      /**
       * Whether the session list has NOTHING to say yet.
       *
       * While it is still loading, the host's own directory would answer as the
       * fallback — and the panel would list and later run the WRONG project's
       * commands for that first second. An empty panel is honest; the wrong
       * project is not.
       */
      function sessionListPending() {
        try {
          if (!props.sessions || !props.sessions.list) return false;
          var snapshot = props.sessions.list.getSnapshot();
          if (!snapshot) return true;
          var ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId || {});
          // `phase` is the documented lifecycle field; when it is absent the
          // emptiness of the list is the only signal available.
          return ids.length === 0 && (snapshot.phase === undefined || snapshot.phase === "loading");
        } catch (error) {
          return false;
        }
      }

      react.useEffect(function () {
        var alive = true;
        function sync() {
          if (!alive) return;
          var next = pickSessionWorkspace(props.sessions) || resolveWorkspace(props.sessions, null, props.workspaces, null);
          if (next !== trackedWorkspace.current) {
            trackedWorkspace.current = next;
            setLiveWorkspace(next);
            reportToHost("terminal workspace", String(next));
          }
        }
        // The session list usually arrives a moment after the panel, and while it
        // is missing the panel correctly shows nothing — so the first seconds are
        // polled fast, then the loop settles into its steady second. The events
        // cover a switch that happened while the page was in the background.
        sync();
        var burst = setInterval(sync, 150);
        var settle = setTimeout(function () {
          clearInterval(burst);
          burst = setInterval(sync, 1000);
        }, 6000);
        window.addEventListener("focus", sync);
        document.addEventListener("visibilitychange", sync);
        return function () {
          alive = false;
          clearInterval(burst);
          clearTimeout(settle);
          window.removeEventListener("focus", sync);
          document.removeEventListener("visibilitychange", sync);
        };
      }, []);

      // The live resolution first, the captured prop second, the host's own
      // directory last — and that last one only once the session list has really
      // answered. Never the empty string: every request below rejects a missing
      // workspace, and an empty one would silently fall back on the host process
      // cwd — the bug this whole block exists to kill.
      var workspaceDir = workspace || liveWorkspace || (sessionListPending() ? "" : (hostWorkspace || ""));

      /**
       * A terminal's output height, when the user dragged it.
       *
       * The number is the height of the OUTPUT area in pixels, which is what the
       * drag handle under it changes. It is remembered per terminal and per
       * workspace (the layout document already carries search/zoom/active), so a
       * window that was made taller comes back the same size.
       */
      var heightPrefix = "height:";
      function readHeights(prefs) {
        var out = {};
        Object.keys(prefs || {}).forEach(function (key) {
          if (key.indexOf(heightPrefix) !== 0) return;
          var value = Number(prefs[key]);
          if (isFinite(value) && value >= 80) out[key.slice(heightPrefix.length)] = value;
        });
        return out;
      }
      var heightsState = react.useState(function () { return readHeights(prefs); });
      var heights = heightsState[0];
      var setHeights = heightsState[1];

      /**
       * The terminal's face and size, chosen by the reader.
       *
       * Both cycle through a short list of real terminal faces and a sane range of
       * sizes; the choice is remembered for the whole browser (it is about the
       * reader, not about one project), and it applies to the output AND to the
       * input line, which must line up with it.
       */
      var fontPrefsState = react.useState(readFontPrefs);
      var fontPrefs = fontPrefsState[0];
      var setFontPrefs = fontPrefsState[1];
      // Whether the input line shows what is typed. False by default: a password
      // prompt arrives through this very field (see readEchoPref).
      var echoState = react.useState(readEchoPref);
      var echoInput = echoState[0];
      var setEchoInput = echoState[1];
      var activeFont = FONT_OPTIONS[fontPrefs.font] || FONT_OPTIONS[0];
      var activeSize = SIZE_OPTIONS[fontPrefs.size] || 12;

      function chooseFont(next) {
        var value = { font: next, size: fontPrefs.size };
        setFontPrefs(value);
        writeFontPrefs(value);
      }

      function chooseSize(next) {
        var value = { font: fontPrefs.font, size: next };
        setFontPrefs(value);
        writeFontPrefs(value);
      }

      // The previous press on a resize bar, for the double-click reset.
      var lastResizePress = react.useRef(null);

      /** Remember one terminal's dragged output height. */
      function setHeight(id, value) {
        setHeights(function (previous) {
          if (previous[id] === value) return previous;
          var next = {};
          Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
          next[id] = value;
          return next;
        });
      }

      /** Forget a dragged height: the next render is the panel's own default. */
      function clearHeight(id) {
        setHeights(function (previous) {
          if (previous[id] === undefined) return previous;
          var next = {};
          Object.keys(previous).forEach(function (key) { if (key !== id) next[key] = previous[key]; });
          return next;
        });
      }

      /**
       * Start dragging the output's bottom edge.
       *
       * Pointer capture is what makes the drag survive the cursor leaving the thin
       * bar, and the height is applied from the CURSOR position every move (start
       * height + the distance dragged), so it can never drift. The listeners live
       * on the handle element and are always removed again, including when the
       * pointer is cancelled by the window losing focus.
       *
       * The double click is detected HERE rather than with React's `onDoubleClick`:
       * `preventDefault()` on `pointerdown` (which stops the drag from selecting the
       * surrounding text) also suppresses the compatibility mouse events, so the
       * browser never synthesizes the `dblclick` React listens for. Measured — the
       * height simply refused to reset until this was done on the pointer stream.
       */
      function onResizeStart(event, id) {
        if (event.button !== undefined && event.button !== 0) return;
        var node = outputNodes.current[id];
        if (!node) return;
        var now = Date.now();
        var isSecondPress = lastResizePress.current !== null &&
          lastResizePress.current.id === id &&
          now - lastResizePress.current.at < 400;
        lastResizePress.current = isSecondPress ? null : { id: id, at: now };
        if (isSecondPress) {
          clearHeight(id);
          return;
        }
        event.preventDefault();
        var handle = event.currentTarget;
        var startY = event.clientY;
        var startHeight = node.getBoundingClientRect().height;
        var nextHeight = startHeight;

        function onMove(moveEvent) {
          var delta = moveEvent.clientY - startY;
          nextHeight = Math.max(80, Math.min(Math.round(window.innerHeight * 0.9), Math.round(startHeight + delta)));
          setHeight(id, nextHeight);
        }
        function stop() {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
          try { handle.releasePointerCapture(event.pointerId); } catch (error) { }
          reportToHost("terminal resize", id + " -> " + String(nextHeight) + "px");
        }

        try { handle.setPointerCapture(event.pointerId); } catch (error) { }
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
      }

      // While this panel is on screen it keeps refreshing its heartbeat; the host
      // reads a stale value as "the page went away with the panel open", and the
      // next page then reopens it. Closing the tab clears the flag immediately,
      // so a deliberate close stays closed.
      react.useEffect(function () {
        return startTerminalHeartbeat(workspaceDir);
      }, [workspaceDir]);

      // Record the right sidebar's width, but ONLY when the user actually drags
      // its resize handle. Passive observation was the earlier bug: the framework
      // resets the column to its 45% default when it re-renders, and the watcher
      // both mistook that for the user's width and wrote it back forever.
      react.useEffect(function () {
        if (!workspaceDir) return undefined;
        var dragStart = null;
        var startListeners = [];
        var endListeners = [];

        function onHandleDown(event) {
          var handle = event.target;
          if (!handle || handle.getAttribute("data-side") !== "rightbar") return;
          dragStart = event.clientX;
        }
        function onPointerUp(event) {
          // This plugin's own restore drag ends with a pointerup too; recording that
          // would save a width nobody chose.
          if (syntheticDrag) return;
          if (dragStart === null) return;
          dragStart = null;
          // Measured on the column the framework actually draws, not on the frame's
          // grid: the two disagree, and the drawn one is the width the user chose.
          var width = rightbarColumnWidth();
          if (width >= 240) {
            writeTerminalPrefs(workspaceDir, { rightbarWidth: width });
            reportToHost("terminal width", "remembered " + String(width));
          }
        }

        function bind() {
          var handles = document.querySelectorAll('[data-side="rightbar"]');
          for (var i = 0; i < handles.length; i++) {
            handles[i].addEventListener("pointerdown", onHandleDown, true);
            startListeners.push(handles[i]);
          }
          window.addEventListener("pointerup", onPointerUp, true);
          endListeners.push(window);
        }
        bind();
        // The handle mounts when the column is open; poll a little so a late
        // mount still gets its listener.
        var rebind = setInterval(bind, 2000);

        return function () {
          clearInterval(rebind);
          for (var i = 0; i < startListeners.length; i++) {
            startListeners[i].removeEventListener("pointerdown", onHandleDown, true);
          }
          for (var j = 0; j < endListeners.length; j++) {
            endListeners[j].removeEventListener("pointerup", onPointerUp, true);
          }
        };
      }, [workspaceDir]);

      // The layout lives on the host, so it has to be fetched once per workspace.
      // The state setters are used directly here: this is the one place that
      // fills the panel from storage, and it must not write back what it read.
      react.useEffect(function () {
        if (!workspaceDir) return undefined;
        var alive = true;
        fetch(LAYOUT_ROUTE + "?workspace=" + encodeURIComponent(workspaceDir), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!alive || !body || body.ok !== true || !body.layout) return;
            applyTerminalPrefs(workspaceDir, body.layout);
            if (typeof body.layout.active === "string") setActiveId(body.layout.active);
            if (typeof body.layout.zoom === "string") setZoomId(body.layout.zoom);
            if (typeof body.layout.search === "string") setSearch(body.layout.search);
            // The dragged output heights belong to the workspace layout too.
            setHeights(function (current) {
              var stored = readHeights(body.layout);
              // What the user dragged in THIS session wins over what was stored.
              return Object.assign({}, stored, current);
            });
          })
          .catch(function () { });
        return function () { alive = false; };
      }, [workspaceDir]);

      // Saving on every change would write while the user types; a short debounce
      // keeps the stored layout one step behind the last edit and nothing more.
      react.useEffect(function () {
        if (!workspaceDir) return undefined;
        var timer = setTimeout(function () {
          writeTerminalPrefs(workspaceDir, { search: search, zoom: zoomId, active: activeId });
        }, 600);
        return function () { clearTimeout(timer); };
      }, [workspaceDir, search, zoomId, activeId]);

      // A dragged output height is stored under its own key per terminal, so one
      // terminal being made taller cannot move another one.
      react.useEffect(function () {
        if (!workspaceDir) return undefined;
        var timer = setTimeout(function () {
          var patch = {};
          Object.keys(heights).forEach(function (id) {
            patch[heightPrefix + id] = heights[id];
          });
          if (Object.keys(patch).length > 0) writeTerminalPrefs(workspaceDir, patch);
        }, 500);
        return function () { clearTimeout(timer); };
      }, [workspaceDir, heights]);

      // Per-terminal input line, so a running command's question can be answered
      // without leaving the panel.
      var stdinState = react.useState({});
      var stdins = stdinState[0];
      var setStdins = stdinState[1];

      // The output filter appears only while it is being used.
      var searchOpenState = react.useState(typeof prefs.search === "string" && prefs.search !== "");
      var searchOpen = searchOpenState[0];
      var setSearchOpen = searchOpenState[1];

      function setStdin(id, value) {
        setStdins(function (previous) {
          var next = {};
          Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
          next[id] = value;
          return next;
        });
      }

      /** Send one line to a running command's standard input. */
      function sendStdin(id) {
        var value = (stdins[id] || "").trim();
        if (value === "") return;
        fetch("/ui-extras/cmd?action=stdin&id=" + encodeURIComponent(id) + "&data=" + encodeURIComponent(value),
          { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) {
              setStdin(id, "");
              trackDirectory(id, value);
            }
            refreshRuns();
          })
          .catch(function () { });
      }

      // The poll interval must not be re-created on every output chunk, so it
      // reads the current map through a ref instead of a dependency.
      var terminalsRef = react.useRef({});
      terminalsRef.current = terminals;

      // Current directory per terminal, mirrored into a ref for the same reason.
      var dirsRef = react.useRef({});

      // The panel's own box: whether it is actually on screen decides if the
      // automatic shell may start (a hidden tab must not spawn processes).
      var rootRef = react.useRef(null);

      // Ids the user closed. The host keeps a finished run for a short while so
      // its output can still be read, and the poll would therefore resurrect a
      // closed terminal; these ids are refused by the merge.
      var closedRef = react.useRef({});

      // Current directory per terminal, tracked from the commands that change it
      // (the shell's own cwd is not visible from the host), starting at the
      // workspace root the session was opened in.
      var dirState = react.useState({});
      var dirs = dirState[0];
      var setDirs = dirState[1];
      dirsRef.current = dirs;

      function setDir(id, value) {
        setDirs(function (previous) {
          if (previous[id] === value) return previous;
          var next = {};
          Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
          next[id] = value;
          return next;
        });
      }

      /**
       * Follow `cd` in a command so the card can show where it currently runs.
       *
       * The shell resolves relative paths itself, so only an absolute target is
       * tracked; a relative one leaves the remembered directory in place instead
       * of showing something wrong.
       */
      function trackDirectory(id, command) {
        var match = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/u.exec(String(command || ""));
        if (!match) return;
        var target = match[1] || match[2] || match[3] || "";
        if (/^[A-Za-z]:[\\/]/u.test(target) || target.startsWith("\\\\") || target.startsWith("/")) {
          var cleaned = target.replace(/[\\/]+$/u, "");
          if (cleaned.length > 0) setDir(id, cleaned);
        }
      }

      /**
       * The workspace can arrive late: the session or the workspace list loads
       * after this panel mounts, and the panel must follow it, because a null
       * workspace disables every control and hides the start directory.
       */
      /** The label a quick command shows: the stored one, or the whole command. */
      function quickLabel(entry) {
        var label = String(entry.label || "");
        var command = String(entry.command || "");
        // Older saves kept only the first word, which showed "npm run build" as
        // "npm"; the full command is the honest label.
        if (label === "" || label === command.split(/\s+/u)[0]) return command;
        return label;
      }

      /** Open a terminal with no command: an interactive shell at the workspace root. */
      function newTerminal() {
        if (!workspaceDir) return;
        fetch("/ui-extras/cmd?action=run&workspace=" + encodeURIComponent(workspaceDir),
          { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!body || body.ok !== true) return;
            setActiveId(body.id);
            setDir(body.id, workspaceDir);
            refreshRuns();
          })
          .catch(function () { });
      }

      function loadRunnables() {
        if (!workspaceDir) {
          setData({ status: "error", error: t("gitNoWorkspace") });
          return;
        }
        fetch("/ui-extras/cmd?action=list&workspace=" + encodeURIComponent(workspaceDir), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) { setData(body && body.ok === true ? { status: "ready", body: body } : { status: "error", error: (body && body.error) || "?" }); })
          .catch(function (error) { setData({ status: "error", error: String(error && error.message ? error.message : error) }); });
      }

      /**
       * Merge the host's run list into the local terminals.
       *
       * Only the missing tail of each output is appended, so polling every second
       * stays cheap even with a chatty command. A run the host has forgotten is
       * dropped, and one that finished keeps its last output with a done flag.
       */
      function refreshRuns() {
        return fetch("/ui-extras/cmd?action=runs", { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!body || body.ok !== true || !Array.isArray(body.runs)) return;
            setTerminals(function (previous) {
              var next = {};
              Object.keys(previous).forEach(function (id) { next[id] = previous[id]; });
              body.runs.forEach(function (run) {
                // A terminal the user closed stays closed: the host keeps the
                // finished record for a while, which would bring it back here.
                if (closedRef.current[run.id] === true) return;
                // ONLY this workspace's terminals. `action=runs` answers with every
                // run the host knows, and the panel used to draw them all — so the
                // other project's dev server showed up here as if it were running
                // in this directory. Switching workspaces is switching projects;
                // the other one's output is not this panel's business.
                if (String(run.workspace).toLowerCase() !== String(workspaceDir).toLowerCase()) return;
                var previousEntry = previous[run.id];
                var known = previousEntry ? previousEntry.received : 0;
                // The prompt prefix is stripped per line, but a chunk can arrive
                // in the middle of a line: the tail of the previous text is
                // re-processed so no half prompt survives.
                var chunk = run.length > known ? run.output.slice(known) : "";
                // Escape sequences and carriage returns are handled HERE, once per
                // chunk: the panel keeps finished LINES plus the unfinished tail,
                // which is what a terminal shows and what a `\r` rewrite needs.
                var raw = previousEntry ? chunk : run.output;
                var ingested = ingestTerminalText(stripAnsi(raw), previousEntry ? previousEntry.carry : "");
                var fresh = previousEntry ? ingested.lines : ingested.lines.slice(1);
                var kept = previousEntry ? previousEntry.lines.slice() : [];
                for (var li = 0; li < fresh.length; li++) {
                  var value = stripPrompts(fresh[li]);
                  if (kept.length > 0 && kept[kept.length - 1] === value) continue;
                  kept.push(value);
                }
                var keptLines = kept.length > 4000 ? kept.slice(-4000) : kept;
                next[run.id] = {
                  id: run.id,
                  workspace: run.workspace,
                  command: run.label || run.command,
                  startedAt: run.startedAt,
                  done: run.done === true,
                  code: run.code,
                  lines: keptLines,
                  carry: ingested.carry,
                  received: run.length
                };
              });
              var present = {};
              body.runs.forEach(function (run) { present[run.id] = true; });
              Object.keys(next).forEach(function (id) {
                if (closedRef.current[id] === true) { delete next[id]; return; }
                // A terminal of another workspace is dropped outright, even while it
                // runs: this panel shows one project.
                if (String(next[id].workspace).toLowerCase() !== String(workspaceDir).toLowerCase()) { delete next[id]; return; }
                if (!present[id] && next[id].done === true) delete next[id];
              });
              return next;
            });
          })
          .catch(function () { });
      }

      // Both lists belong to ONE workspace: the quick commands are stored per
      // workspace root, and the runs of another project are not this panel's.
      // Keying them on the prop was the "opens with no saved commands" bug — the
      // docked tab's prop is null, so the one request that ever ran hit an empty
      // workspace, and only saving a command (which answered with a fresh list)
      // ever filled the row.
      react.useEffect(function () { loadRunnables(); }, [workspaceDir]);
      react.useEffect(function () { refreshRuns(); }, [workspaceDir]);

      /**
       * Follow the pane's Session into another project.
       *
       * A switch of workspace is a switch of project: finished terminals of the
       * previous one are noise (and their saved commands are not on screen any
       * more), while a RUNNING one is a server the user is deliberately watching,
       * so it is kept.
       */
      var termOwnerRef = react.useRef(null);
      react.useEffect(function () {
        if (!workspaceDir) return;
        var previous = termOwnerRef.current;
        termOwnerRef.current = workspaceDir;
        if (previous === null || previous === workspaceDir) return;
        closedRef.current = {};
        setTerminals(function (current) {
          var next = {};
          Object.keys(current).forEach(function (id) {
            if (current[id].done !== true) next[id] = current[id];
          });
          return next;
        });
        dirsRef.current = {};
        setDirs({});
        setActiveId(null);
        setZoomId(null);
        reportToHost("terminal workspace switch", String(previous) + " -> " + String(workspaceDir));
      }, [workspaceDir]);

      /**
       * A terminal panel is expected to BE a terminal: an empty panel with a
       * workspace known opens one interactive shell by itself, exactly like the
       * right-hand panel of any other editor. Only a DOCKED panel that is ON
       * SCREEN does this — the fallback overlay is opened deliberately and stays
       * quiet — and only once per mount, so closing the shell is not undone a
       * second later.
       *
       * The decision waits for the first run poll and then asks the HOST again:
       * two panels on the same workspace (two windows, or two tabs of one
       * session) would otherwise each start a shell for the same project. A
       * workspace that already has a run keeps it and starts nothing.
       */
      var autoStartedRef = react.useRef(false);
      var autoStartCountRef = react.useRef(0);
      var panelTagRef = react.useRef(String(Math.floor(Math.random() * 1e9)));
      react.useEffect(function () {
        if (autoStartedRef.current || !docked || !workspaceDir) return undefined;
        if (!panelOnScreen(rootRef.current)) return undefined;
        if (Object.keys(terminalsRef.current).length > 0) {
          autoStartedRef.current = true;
          return undefined;
        }
        var alive = true;
        // Ask the host what is already running: the local map is empty on a fresh
        // mount, which says nothing about the project.
        fetch("/ui-extras/cmd?action=runs", { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!alive || autoStartedRef.current) return;
            var runs = body && body.ok === true && Array.isArray(body.runs) ? body.runs : [];
            var existing = runs.filter(function (run) {
              return String(run.workspace).toLowerCase() === workspaceDir.toLowerCase();
            });
            autoStartedRef.current = true;
            if (existing.length > 0) {
              reportToHost("terminal autostart skipped",
                workspaceDir + " (a projektben mar fut " + String(existing.length) + " terminal)");
              return;
            }
            autoStartCountRef.current += 1;
            reportToHost("terminal autostart", workspaceDir +
              " (#" + String(autoStartCountRef.current) + " panel=" + panelTagRef.current + ")");
            newTerminal();
          })
          .catch(function () { });
        return function () { alive = false; };
      }, [docked, workspaceDir, terminals]);

      // One poll loop for every terminal. It keeps running while any terminal is
      // alive, and the last tick after the final exit settles the exit code.
      react.useEffect(function () {
        var alive = true;
        var timer = setInterval(function () {
          if (!alive) return;
          var anyRunning = Object.keys(terminalsRef.current).some(function (id) {
            return terminalsRef.current[id].done !== true;
          });
          // A pending Ctrl+C is settled even when nothing is "running": that is
          // exactly the case it detects.
          var pending = Object.keys(interruptDeadlineRef.current);
          if (!anyRunning && pending.length === 0) return;
          refreshRuns();
          var now = Date.now();
          pending.forEach(function (id) {
            if (interruptDeadlineRef.current[id] <= now) settleInterrupt(id);
          });
        }, 1000);
        return function () { alive = false; clearInterval(timer); };
      }, [workspaceDir]);

      /** Start a command as a NEW terminal and focus it. */
      function runCommand(command) {
        if (!workspaceDir || !command) return;
        fetch("/ui-extras/cmd?action=run&workspace=" + encodeURIComponent(workspaceDir) + "&command=" + encodeURIComponent(command),
          { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (!body || body.ok !== true) return;
            setActiveId(body.id);
            // The session starts in the workspace root, and a leading `cd`
            // changes that immediately.
            setDir(body.id, workspaceDir);
            trackDirectory(body.id, command);
            refreshRuns();
          })
          .catch(function () { });
      }

      /**
       * Stop this terminal's process TREE.
       *
       * The host kills the shell and everything it started (`taskkill /T` on
       * Windows): stopping only the shell left `npm run dev` running and holding
       * its port, which is the stuck process the ■ is supposed to end.
       */
      function killTerminal(id) {
        fetch("/ui-extras/cmd?action=kill&id=" + encodeURIComponent(id), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok !== true) reportToHost("terminal kill failed", String(body.error));
            refreshRuns();
          })
          .catch(function () { });
      }

      // Ctrl+C handling: an interrupt is asked for first (`0x03`), and if the
      // process has produced nothing new shortly afterwards the tree is killed
      // outright. Measured: a piped powershell.exe ignores the console control
      // character for an in-process command, and a native program like `npm run
      // dev` does not read it either — so "send the key and hope" would look like
      // a broken panel.
      var interruptDeadlineRef = react.useRef({});
      var interruptFromRef = react.useRef({});
      var interruptingState = react.useState({});
      var interrupting = interruptingState[0];
      var setInterrupting = interruptingState[1];

      /** Send an interrupt request to one terminal's process. */
      function interruptTerminal(id) {
        var entry = terminalsRef.current[id];
        if (!entry || entry.done === true) return;
        interruptFromRef.current[id] = entry.received;
        setInterrupting(function (previous) {
          var next = {};
          Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
          next[id] = true;
          return next;
        });
        fetch("/ui-extras/cmd?action=stdin&id=" + encodeURIComponent(id) + "&data=" + encodeURIComponent("\u0003"),
          { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) {
              interruptDeadlineRef.current[id] = Date.now() + 1500;
              return;
            }
            reportToHost("terminal interrupt rejected", String(body && body.error));
            killTerminal(id);
          })
          .catch(function () { });
      }

      /** Send a control character (ESC, Ctrl+D, …) to one terminal's input. */
      function sendControl(id, text) {
        var entry = terminalsRef.current[id];
        if (!entry || entry.done === true) return;
        fetch("/ui-extras/cmd?action=stdin&id=" + encodeURIComponent(id) + "&data=" + encodeURIComponent(text),
          { headers: { Accept: "application/json" } })
          .then(function () { refreshRuns(); })
          .catch(function () { });
      }

      /**
       * The panel's own key handling for the input line.
       *
       * A text field alone cannot drive a terminal, which is why this exists:
       *   * Ctrl+C stops whatever is running (interrupt first, then the tree),
       *   * Escape sends the ESC byte PowerShell's line editor uses to clear the
       *     current line,
       *   * Ctrl+D sends the end-of-input byte,
       *   * a TEXT SELECTION keeps Ctrl+C as "copy" — the browser default.
       */
      function onTerminalKeyDown(event, id) {
        if ((event.ctrlKey || event.metaKey) && (event.key === "c" || event.key === "C")) {
          var input = event.currentTarget;
          var selection = typeof input.selectionStart === "number" && input.selectionStart !== input.selectionEnd;
          if (selection) return;
          event.preventDefault();
          interruptTerminal(id);
          return;
        }
        if (event.key === "Escape") {
          if (String(event.currentTarget.value || "") !== "") return;
          event.preventDefault();
          sendControl(id, "\u001b");
          return;
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === "d" || event.key === "D")) {
          event.preventDefault();
          sendControl(id, "\u0004");
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          sendStdin(id);
        }
      }

      /**
       * Follow the tail of every terminal, like a terminal does.
       *
       * Keyed on the whole map so it runs after the text is in the DOM. A reader
       * who scrolled up is left where they are — but only until they scroll back
       * down or the panel remounts, because "shows the beginning" is the failure
       * this exists to prevent.
       */
      react.useEffect(function () {
        outputNodes.current = outputNodes.current || {};
        Object.keys(terminals).forEach(function (id) {
          var node = outputNodes.current[id];
          if (!node) return;
          try {
            if (followTail.current) node.scrollTop = node.scrollHeight;
          } catch (error) { }
        });
      }, [terminals]);

      // Scrolling up stops the follow, coming back to the bottom resumes it. The
      // `tailTick` state exists only to re-render the button when the follow
      // switches: the scroll position is not React state, so without a render the
      // button would keep claiming the tail is followed.
      var tailTickState = react.useState(0);
      var setTailTick = tailTickState[1];
      var tailFollowing = followTail.current === true;

      function onOutputScroll(id, event) {
        var node = event.currentTarget;
        try {
          var distance = node.scrollHeight - node.scrollTop - node.clientHeight;
          var following = distance < 60;
          if (following !== followTail.current) {
            followTail.current = following;
            setTailTick(function (value) { return value + 1; });
          }
        } catch (error) { }
      }

      // Coming back to the terminal panel resumes the tail: a reload must never
      // leave the panel parked at the top of a long log.
      react.useEffect(function () {
        followTail.current = true;
      }, [workspaceDir]);

      /**
       * Settle every pending interrupt: if the process stopped producing output
       * after the Ctrl+C, the interrupt worked; if it did not, the whole tree is
       * killed and the card says so, because silence would look like a hang.
       */
      function settleInterrupt(id) {
        var entry = terminalsRef.current[id];
        var from = interruptFromRef.current[id];
        delete interruptDeadlineRef.current[id];
        delete interruptFromRef.current[id];
        setInterrupting(function (previous) {
          if (previous[id] !== true) return previous;
          var next = {};
          Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
          delete next[id];
          return next;
        });
        if (!entry || entry.done === true || entry.received !== from) return;
        fetch("/ui-extras/cmd?action=kill&id=" + encodeURIComponent(id), { headers: { Accept: "application/json" } })
          .then(function () {
            setTerminals(function (previous) {
              var current = previous[id];
              if (!current) return previous;
              var next = {};
              Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
              next[id] = Object.assign({}, current, {
                lines: current.lines.concat([t("cmdInterruptForceKilled")])
              });
              return next;
            });
            refreshRuns();
          })
          .catch(function () { });
      }

      /**
       * Close a terminal for good.
       *
       * `forget` is what makes the close stick: killing alone leaves the finished
       * record on the host, which the next poll would show again. The id is also
       * remembered locally so nothing can resurrect it in the meantime.
       */
      function closeTerminal(id) {
        closedRef.current[id] = true;
        fetch("/ui-extras/cmd?action=forget&id=" + encodeURIComponent(id), { headers: { Accept: "application/json" } })
          .catch(function () { });
        setTerminals(function (previous) {
          var next = {};
          Object.keys(previous).forEach(function (key) { if (key !== id) next[key] = previous[key]; });
          return next;
        });
        if (activeId === id) setActiveId(null);
        if (zoomId === id) setZoomId(null);
        setDirs(function (previous) {
          var next = {};
          Object.keys(previous).forEach(function (key) { if (key !== id) next[key] = previous[key]; });
          return next;
        });
      }

      function addCustom() {
        var value = input.trim();
        if (!workspaceDir || value === "") return;
        // The label is the whole command: showing only its first word made
        // "npm run build" appear as "npm".
        fetch("/ui-extras/cmd?action=add&workspace=" + encodeURIComponent(workspaceDir) +
          "&name=" + encodeURIComponent(value) + "&label=" + encodeURIComponent(value) +
          "&command=" + encodeURIComponent(value),
          { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) {
              setInput("");
              setData({ status: "ready", body: body });
            }
          })
          .catch(function () { });
      }

      /** Remove one saved quick command; npm scripts are not removable here. */
      function removeCustom(entry) {
        if (!workspaceDir || !entry) return;
        var name = String(entry.command || entry.id).replace(/^custom:/u, "");
        fetch("/ui-extras/cmd?action=remove&workspace=" + encodeURIComponent(workspaceDir) + "&name=" + encodeURIComponent(name),
          { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            if (body && body.ok === true) setData({ status: "ready", body: body });
          })
          .catch(function () { });
      }

      var body = data.status === "ready" ? data.body : null;
      var buttons = body ? (body.npm || []).concat(body.custom || []) : [];
      var order = Object.keys(terminals);
      var runningCount = order.filter(function (id) { return terminals[id].done !== true; }).length;

      /** A compact, square control: the meaning is on the tooltip. */
      function iconButton(enabled) {
        return {
          border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))",
          borderRadius: "7px",
          background: enabled ? "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))" : "transparent",
          color: "inherit",
          cursor: enabled ? "pointer" : "not-allowed",
          opacity: enabled ? 1 : 0.45,
          font: "inherit",
          lineHeight: 1,
          padding: "2px 8px"
        };
      }

      /** Drop every finished terminal for good, not just from this view. */
      function closeFinishedTerminals() {
        Object.keys(terminalsRef.current).forEach(function (id) {
          if (terminalsRef.current[id].done === true) closeTerminal(id);
        });
        setZoomId(null);
      }

      /**
       * One terminal card.
       *
       * Layout is deliberate and follows the complaints it has to answer:
       *   * the run state is the COLOURED DOT in the header; it needs no word,
       *     and "Fut…" next to the directory was noise in the wrong place;
       *   * the line count sits in the HEADER, right after the command;
       *   * the CURRENT DIRECTORY is the line between the header and the output,
       *     above it, so the output can never cover it;
       *   * the output is its own block and it FOLLOWS THE TAIL on every update:
       *     a terminal that shows the beginning of a long log is unusable.
       */
      function renderTerminal(id) {
        var entry = terminals[id];
        var isActive = id === activeId;
        var isZoomed = id === zoomId;
        // The kept LINES, plus the line the process is still writing (a prompt or
        // a progress line that has not been finished yet).
        var lines = entry.lines || [];
        var carried = String(entry.carry || "");
        var total = lines.length + (carried === "" ? 0 : 1);
        // Cap what is rendered: a build log can be huge and the browser only
        // needs the tail to be useful.
        var shown = lines.slice(-400);
        var hidden = total - shown.length;
        if (carried !== "") shown = shown.concat([carried]);
        var running = entry.done !== true;
        var dir = dirs[id] || workspaceDir;
        // The dot is the state: amber while it runs, green/red once it exited.
        var stateColor = entry.done === true ? (entry.code === 0 ? "#86efac" : "#fca5a5") : "#fbbf24";
        var stateTitle = entry.done === true
          ? t("cmdExited") + " " + (entry.code === null ? "?" : String(entry.code))
          : t("cmdRunning");
        // The output is user-sized: without a dragged height it keeps the
        // panel's own room, and once dragged that number is what it uses.
        var dragged = Number(heights[id]) > 0 ? Number(heights[id]) : null;
        var outputStyle = dragged === null
          ? {
            // A sensible DEFAULT, not a stage: 46vh per card meant two terminals
            // could not be seen together at all. This leaves room for two or three
            // cards plus their headers, and the drag handle (or the zoom button)
            // is there for anyone who wants a big one.
            minHeight: "170px",
            height: isZoomed ? "60vh" : (docked ? "22vh" : "240px"),
            maxHeight: isZoomed ? "70vh" : (docked ? "38vh" : "340px")
          }
          : {
            height: String(dragged) + "px",
            minHeight: "80px",
            maxHeight: isZoomed ? "80vh" : "70vh"
          };

        var output = (function () {
          if (search.trim() === "") return shown.join("\n");
          // A search term keeps only the matching lines: a build log is mostly
          // noise, and the panel is not a full text editor.
          var needle = search.trim().toLowerCase();
          var hits = shown.filter(function (line) { return line.toLowerCase().indexOf(needle) !== -1; });
          return hits.length > 0 ? hits.join("\n") : t("cmdNoMatch");
        })();
        // When the buffer is longer than what is drawn, the panel says so: a
        // silently truncated log reads as "the command stopped printing".
        if (search.trim() === "" && hidden > 0) {
          output = "⋯ " + t("cmdHiddenLines") + " " + String(hidden) + " " + t("cmdLines") + "\n" + output;
        }

        return jsx.jsxs("section", {
          "data-dsh-ui-extras": "terminal",
          style: {
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            maxWidth: "100%",
            // Without minHeight:0 a flex child refuses to shrink below its
            // content, which is how a long terminal used to grow past the pane.
            minHeight: 0,
            // The selected terminal is the one a new command belongs to. It only
            // needs a hint: the loud blue outline read as an alert for something
            // as ordinary as "this is the one the command line talks to".
            border: "1px solid " + (isActive ? "var(--dsw-alias-border-l4, rgba(255,255,255,0.3))" : "var(--dsw-alias-border-l2, rgba(255,255,255,0.12))"),
            borderRadius: "9px",
            background: isActive ? "var(--dsw-alias-interactive-bg-active, rgba(255,255,255,0.05))" : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.28))",
            overflow: "hidden"
          },
          children: [
            jsx.jsxs("header", {
              style: { display: "flex", gap: "6px", alignItems: "center", padding: "4px 6px", background: "var(--dsw-alias-border-l1, rgba(255,255,255,0.05))" },
              children: [
                jsx.jsxs("button", {
                  type: "button",
                  title: t("cmdSelectTerminal") + " · " + stateTitle,
                  onClick: function () { setActiveId(id); },
                  style: {
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    minWidth: 0,
                    flex: "1 1 auto",
                    border: 0,
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    cursor: "pointer",
                    textAlign: "left"
                  },
                  children: [
                    jsx.jsx("span", {
                      title: stateTitle,
                      style: { width: "8px", height: "8px", borderRadius: "50%", flex: "0 0 auto", background: stateColor }
                    }),
                    jsx.jsx("code", {
                      style: {
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        // A terminal is monospace; the command line is code.
                        fontFamily: activeFont.font,
                        fontSize: "12px"
                      },
                      children: entry.command
                    }),
                    // The line count belongs here, with the title it counts.
                    jsx.jsx("span", {
                      title: t("cmdLines"),
                      style: { flex: "0 0 auto", fontSize: "10.5px", opacity: 0.6 },
                      children: String(total)
                    })
                  ]
                }),
                running
                  ? jsx.jsx("button", {
                    type: "button",
                    title: t("cmdStopTree"),
                    "aria-label": t("cmdStopTree"),
                    onClick: function () { killTerminal(id); },
                    style: { border: 0, background: "transparent", color: "#ffb4ab", cursor: "pointer", font: "inherit" },
                    children: "■"
                  })
                  : null,
                // Appearance controls: the face and the size of THIS terminal's
                // text. Both cycle, both carry the current value in the tooltip —
                // a picker in a header this small would cost more than it gives.
                jsx.jsx("button", {
                  type: "button",
                  title: t("cmdFontFace") + ": " + activeFont.label,
                  "aria-label": t("cmdFontFace") + ": " + activeFont.label,
                  onClick: function () { chooseFont((fontPrefs.font + 1) % FONT_OPTIONS.length); },
                  style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontFamily: activeFont.font, fontSize: "11px", lineHeight: 1, padding: "0 3px" },
                  children: "Aa"
                }),
                jsx.jsx("button", {
                  type: "button",
                  title: t("cmdFontSize") + ": " + String(activeSize) + "px",
                  "aria-label": t("cmdFontSize") + ": " + String(activeSize) + "px",
                  onClick: function () { chooseSize((fontPrefs.size + 1) % SIZE_OPTIONS.length); },
                  style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontFamily: activeFont.font, fontSize: "11px", lineHeight: 1, padding: "0 3px" },
                  children: "A±"
                }),
                jsx.jsx("button", {
                  type: "button",
                  title: t("cmdFollowTailHint"),
                  "aria-label": t("cmdFollowTail"),
                  onClick: function () {
                    followTail.current = true;
                    var node = outputNodes.current[id];
                    try { if (node) node.scrollTop = node.scrollHeight; } catch (error) { }
                    setTailTick(function (value) { return value + 1; });
                  },
                  style: {
                    border: "1px solid " + (tailFollowing ? "var(--dsw-alias-border-l2, rgba(255,255,255,0.18))" : "var(--dsw-alias-border-l4, rgba(255,255,255,0.4))"),
                    borderRadius: "6px",
                    background: tailFollowing ? "transparent" : "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))",
                    color: "inherit",
                    cursor: "pointer",
                    font: "inherit",
                    lineHeight: 1,
                    padding: "1px 6px",
                    opacity: tailFollowing ? 0.65 : 1
                  },
                  children: "⤓"
                }),
                jsx.jsx("button", {
                  type: "button",
                  title: isZoomed ? t("cmdZoomOut") : t("cmdZoomIn"),
                  "aria-label": isZoomed ? t("cmdZoomOut") : t("cmdZoomIn"),
                  onClick: function () { setZoomId(isZoomed ? null : id); },
                  style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
                  children: isZoomed ? "⤡" : "⤢"
                }),
                jsx.jsx("button", {
                  type: "button",
                  title: t("cmdCloseTerminal"),
                  "aria-label": t("cmdCloseTerminal"),
                  onClick: function () { closeTerminal(id); },
                  style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
                  children: "✕"
                })
              ]
            }),
            // Current directory: its own line between the header and the output.
            // Nothing else rides here — the state is the dot and the count is in
            // the header — so the directory can use the whole width.
            jsx.jsx("div", {
              "data-dsh-ui-extras": "terminal-dir",
              title: t("cmdDirectoryHint") + " " + (dir || t("gitNoWorkspace")),
              style: {
                display: "flex",
                gap: "8px",
                alignItems: "center",
                padding: "2px 8px",
                fontSize: "11px",
                opacity: 0.85,
                borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.06))"
              },
              children: [
                jsx.jsx("span", {
                  style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto", minWidth: 0 },
                  children: "📁 " + (dir || "?")
                }),
                // Only a transient state may appear here: it is not a statistic.
                interrupting[id] === true
                  ? jsx.jsx("span", { style: { flex: "0 0 auto", color: "#fbbf24" }, children: t("cmdInterrupting") })
                  : null
              ]
            }),
            jsx.jsx("pre", {
              "data-dsh-ui-extras": "cmd-output",
              ref: function (node) {
                outputNodes.current[id] = node;
                // The first paint of a long log must land on the tail too: the
                // effect above runs after this ref, but a node that was just
                // created has never been scrolled.
                if (!node) return;
                try {
                  if (followTail.current) node.scrollTop = node.scrollHeight;
                } catch (error) { }
              },
              onScroll: function (event) { onOutputScroll(id, event); },
              style: Object.assign({
                margin: 0,
                padding: "6px 8px",
                flex: "1 1 auto",
                overflow: "auto",
                color: "#d6d9dd",
                // The chosen face and size, from the panel's own toolbar.
                fontFamily: activeFont.font,
                fontSize: String(activeSize) + "px",
                lineHeight: "16px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
              }, outputStyle),
              children: output
            }),
            // The output is a terminal WINDOW: the bar under it changes its height
            // with the mouse, and a double click puts the panel's own height back.
            jsx.jsx("div", {
              "data-dsh-ui-extras": "cmd-resize",
              title: t("cmdResizeHint"),
              onPointerDown: function (event) { onResizeStart(event, id); },
              style: {
                height: "7px",
                flex: "0 0 auto",
                cursor: "ns-resize",
                background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.03))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                touchAction: "none"
              },
              children: jsx.jsx("span", {
                style: { width: "24px", height: "2px", borderRadius: "2px", background: "var(--dsw-alias-border-l3, rgba(255,255,255,0.25))" }
              })
            }),
            // A running command can wait for an answer; shortcuts work here, so a
            // stuck process can be stopped without reaching for the mouse. A
            // finished one has no input left to take.
            running
              ? (function () {
                // A password prompt arrives through this same field, so the mask is
                // the default and the eye button is the deliberate exception.
                var secretPrompt = lines.slice(-25).concat(carried === "" ? [] : [carried]).some(looksLikeSecretPrompt);
                return jsx.jsxs("div", {
                  // Comfortable input row: the field needs air above and below the
                  // text, and the controls line up with its height instead of
                  // cramping it ("flat" was the complaint and it is a padding bug).
                  style: { display: "flex", gap: "4px", alignItems: "center", padding: "5px 6px", background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.04))" },
                  children: [
                    jsx.jsx("input", {
                      // `password` hides every keystroke: a sudo/ssh prompt typed here
                      // must not end up readable in a tooltip, a screenshot or a
                      // recording. The eye button next to it turns echoing on for
                      // ordinary text (long paths, one-off commands).
                      type: echoInput ? "text" : "password",
                      autoComplete: "off",
                      value: stdins[id] || "",
                      placeholder: secretPrompt ? t("cmdSecretPlaceholder") : t("cmdStdinPlaceholder"),
                      title: secretPrompt ? t("cmdSecretHint") : t("cmdStdinHint"),
                      spellCheck: false,
                      onKeyDown: function (event) { onTerminalKeyDown(event, id); },
                      onChange: function (event) { setStdin(id, event.currentTarget.value); },
                      style: {
                        flex: "1 1 auto",
                        minWidth: 0,
                        padding: "5px 8px",
                        lineHeight: "18px",
                        borderRadius: "6px",
                        background: "transparent",
                        color: "inherit",
                        border: "1px solid " + (secretPrompt ? "var(--dsw-alias-state-warn-secondary, rgba(251,191,36,0.55))" : "var(--dsw-alias-border-l2, rgba(255,255,255,0.18))"),
                        fontFamily: activeFont.font,
                        fontSize: String(activeSize) + "px"
                      }
                    }),
                    // Icon controls everywhere: the panel is narrow, and a word
                    // costs three times the width of the glyph it explains.
                    jsx.jsx("button", {
                      type: "button",
                      title: echoInput ? t("cmdEchoHideHint") : t("cmdEchoShowHint"),
                      "aria-label": echoInput ? t("cmdEchoHide") : t("cmdEchoShow"),
                      "data-dsh-ui-extras": "cmd-echo",
                      onClick: function () {
                        var next = !echoInput;
                        setEchoInput(next);
                        writeEchoPref(next);
                      },
                      style: { border: 0, background: "transparent", color: echoInput ? "#fbbf24" : "inherit", cursor: "pointer", font: "inherit", lineHeight: 1, padding: "0 3px" },
                      children: echoInput ? "👁" : "🙈"
                    }),
                    jsx.jsx("button", {
                      type: "button",
                      disabled: (stdins[id] || "").trim() === "",
                      title: t("cmdStdinSendHint"),
                      "aria-label": t("cmdStdinSend"),
                      onClick: function () { sendStdin(id); },
                      style: iconButton((stdins[id] || "").trim() !== ""),
                      children: "➤"
                    }),
                    jsx.jsx("button", {
                      type: "button",
                      title: t("cmdInterrupt"),
                      "aria-label": t("cmdInterruptShort"),
                      onClick: function () { interruptTerminal(id); },
                      style: { border: "1px solid rgba(252,165,165,0.4)", borderRadius: "7px", background: "transparent", color: "#ffb4ab", cursor: "pointer", font: "inherit", lineHeight: 1, padding: "4px 8px" },
                      children: "^C"
                    })
                  ]
                });
              })()
              : null
          ]
        }, id);
      }

      return jsx.jsxs("div", {
        "data-dsh-ui-extras": "cmd-panel",
        ref: rootRef,
        style: {
          // Docked tab body: fill the pane the right sidebar gives it. The
          // fallback overlay is deliberately SMALL and anchored to the corner: a
          // full-width fallback covered the conversation, which is worse than not
          // showing the panel at all.
          position: docked ? "relative" : "fixed",
          bottom: docked ? undefined : "16px",
          right: docked ? undefined : "16px",
          top: docked ? undefined : "auto",
          zIndex: docked ? undefined : 40,
          width: docked ? "100%" : "min(460px, 92vw)",
          height: docked ? "100%" : "min(360px, 60vh)",
          maxHeight: docked ? "none" : "60vh",
          // A docked pane is a narrow column: nothing inside may push the panel
          // wider than it or past its bottom edge, or it paints over the
          // conversation next to it.
          maxWidth: "100%",
          minWidth: 0,
          minHeight: 0,
          overflowX: "hidden",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: docked ? "8px 10px" : "10px 12px",
          border: docked ? 0 : "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
          borderRadius: docked ? 0 : "10px",
          background: docked ? "transparent" : "var(--dsw-alias-bg-layer-2, rgba(21,21,23,0.98))",
          color: "var(--dsw-alias-label-primary, #e8eaed)",
          boxShadow: docked ? undefined : "0 10px 30px rgba(0,0,0,0.45)",
          boxSizing: "border-box",
          fontSize: "12px",
          lineHeight: "18px",
          textAlign: "left"
        },
        children: [
          jsx.jsxs("div", {
            style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
            children: [
              jsx.jsxs("strong", {
                children: [
                  t("cmdTitle"),
                  order.length > 0
                    ? jsx.jsxs("span", { style: { fontWeight: 400, opacity: 0.7 }, children: [
                      " · " + String(order.length) + " " + t("cmdTerminals"),
                      runningCount > 0 ? " (" + String(runningCount) + " " + t("cmdRunningShort") + ")" : ""
                    ] })
                    : null
                ]
              }),
              jsx.jsxs("span", { style: { display: "inline-flex", gap: "4px", alignItems: "center" }, children: [
                // The filter is an icon until it is used: a permanent text field
                // would cost width in an already narrow pane.
                searchOpen
                  ? jsx.jsx("input", {
                    type: "text",
                    autoFocus: true,
                    value: search,
                    placeholder: t("cmdSearchPlaceholder"),
                    title: t("cmdSearchHint"),
                    onChange: function (event) { setSearch(event.currentTarget.value); },
                    onKeyDown: function (event) {
                      if (event.key === "Escape") { setSearch(""); setSearchOpen(false); }
                    },
                    style: { width: "130px", padding: "1px 6px", borderRadius: "6px", background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))", font: "inherit" }
                  })
                  : jsx.jsx("button", {
                    type: "button",
                    title: t("cmdSearchHint"),
                    "aria-label": t("cmdSearchHint"),
                    onClick: function () { setSearchOpen(true); },
                    style: iconButton(true),
                    children: "🔍"
                  }),
                // A docked tab is closed by its own chip, so only the fallback
                // overlay carries a close button.
                docked
                  ? null
                  : jsx.jsx("button", {
                    type: "button",
                    onClick: props.onClose,
                    style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
                    children: "✕"
                  })
              ] })
            ]
          }),
          // Where the commands of THIS view will run. Showing it here removes the
          // guesswork that produced "npm run dev" in the wrong project: the panel
          // is narrow, so the path is one ellipsised line with the full path on
          // the tooltip.
          jsx.jsx("div", {
            "data-dsh-ui-extras": "cmd-workspace",
            title: workspaceDir || t("cmdRunsInUnknown"),
            style: {
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: workspaceDir ? 0.75 : 0.55,
              fontSize: "11px"
            },
            children: workspaceDir
              ? "📁 " + t("cmdRunsIn") + " " + workspaceDir
              : "📁 " + t("cmdRunsInUnknown")
          }),
          // ------------------------------------------------- quick commands
          // A saved command starts a NEW terminal with one click, so a routine
          // command never has to be typed again. Custom entries carry a remove
          // button; npm scripts come from package.json and are not removable here.
          jsx.jsxs("div", {
            style: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" },
            children: buttons.length > 0
              ? buttons.map(function (entry) {
                var custom = entry.source === "custom";
                return jsx.jsxs("span", {
                  style: { display: "inline-flex", alignItems: "center" },
                  children: [
                    jsx.jsx("button", {
                      type: "button",
                      key: entry.id,
                      title: t("cmdQuickRun") + ": " + entry.command,
                      onClick: function () { runCommand(entry.command); },
                      style: {
                        border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))",
                        borderRadius: custom ? "7px 0 0 7px" : "7px",
                        background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))",
                        color: "inherit",
                        cursor: "pointer",
                        font: "inherit",
                        padding: "2px 10px"
                      },
                      children: quickLabel(entry)
                    }),
                    custom
                      ? jsx.jsx("button", {
                        type: "button",
                        title: t("cmdQuickRemove"),
                        onClick: function () { removeCustom(entry); },
                        style: {
                          border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))",
                          borderLeft: 0,
                          borderRadius: "0 7px 7px 0",
                          background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.04))",
                          color: "inherit",
                          cursor: "pointer",
                          font: "inherit",
                          padding: "2px 6px"
                        },
                        children: "✕"
                      })
                      : null
                  ]
                }, entry.id);
              })
              : jsx.jsx("span", { title: t("cmdQuickHint"), style: { opacity: 0.7 }, children: t("cmdNoRunnables") })
          }),
          jsx.jsxs("div", {
            style: { display: "flex", gap: "4px", alignItems: "center" },
            children: [
              // Multi-line commands are normal (a pipeline, a small script), so
              // this is a textarea: Enter runs the command, Shift+Enter opens a
              // new line, Ctrl+Enter saves the whole block as a quick command.
              jsx.jsx("textarea", {
                value: input,
                rows: input.indexOf("\n") >= 0 ? Math.min(6, input.split("\n").length) : 1,
                placeholder: t("cmdPlaceholder"),
                title: t("cmdPlaceholderHint"),
                spellCheck: false,
                onChange: function (event) { setInput(event.currentTarget.value); },
                onKeyDown: function (event) {
                  if (event.key !== "Enter") return;
                  if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    addCustom();
                    return;
                  }
                  if (event.shiftKey) return;
                  event.preventDefault();
                  runCommand(input.trim());
                },
                style: {
                  flex: "1 1 auto",
                  minWidth: 0,
                  resize: "vertical",
                  padding: "2px 6px",
                  borderRadius: "6px",
                  background: "transparent",
                  color: "inherit",
                  border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
                  fontFamily: "Consolas, 'Cascadia Mono', monospace",
                  fontSize: "11.5px",
                  lineHeight: "16px"
                }
              }),
              // Icon-only controls: the panel is narrow, so the meaning rides the
              // tooltip instead of taking horizontal space.
              jsx.jsx("button", {
                type: "button",
                title: t("cmdNewTerminalHint"),
                "aria-label": t("cmdNewTerminalHint"),
                disabled: !workspaceDir,
                onClick: newTerminal,
                style: iconButton(Boolean(workspaceDir)),
                children: "＋"
              }),
              jsx.jsx("button", {
                type: "button",
                disabled: input.trim() === "",
                title: t("cmdRunHint"),
                "aria-label": t("cmdRunHint"),
                onClick: function () { runCommand(input.trim()); },
                style: iconButton(input.trim() !== ""),
                children: "▶"
              }),
              jsx.jsx("button", {
                type: "button",
                disabled: input.trim() === "",
                title: t("cmdSaveHint"),
                "aria-label": t("cmdSaveHint"),
                onClick: addCustom,
                style: iconButton(input.trim() !== ""),
                children: "💾"
              }),
              jsx.jsx("button", {
                type: "button",
                title: t("cmdRunsHint"),
                "aria-label": t("cmdRunsHint"),
                onClick: refreshRuns,
                style: iconButton(true),
                children: "⟳"
              }),
              jsx.jsx("button", {
                type: "button",
                title: t("cmdClearHint"),
                "aria-label": t("cmdClearHint"),
                onClick: function () { closeFinishedTerminals(); },
                style: iconButton(order.some(function (id) { return terminals[id].done === true; })),
                children: "🧹"
              })
            ]
          }),
          order.length === 0
            ? jsx.jsx("div", { style: { opacity: 0.7 }, children: t("cmdNoTerminals") })
            : jsx.jsx("div", {
              "data-dsh-ui-extras": "terminals",
              style: {
                display: "grid",
                // A docked pane is narrow, so its terminals stack; the wide
                // fallback overlay lays them out side by side.
                gridTemplateColumns: zoomId !== null || docked
                  ? "1fr"
                  : "repeat(auto-fit, minmax(320px, 1fr))",
                // The grid may not be wider than the pane, and its rows may not
                // squeeze the cards into each other.
                maxWidth: "100%",
                minWidth: 0,
                gap: "8px"
              },
              children: (zoomId !== null && terminals[zoomId] ? [zoomId] : order).map(renderTerminal)
            })
        ]
      });
    });

    /**
     * The selected workspace path from the `workspaces` service, or null.
     *
     * Used where only the path is needed (the auto-reopen key), separately from
     * the full three-source resolution a panel performs.
     */
    function selectedWorkspaceOf(workspaces) {
      try {
        if (!workspaces || typeof workspaces.getSnapshot !== "function") return null;
        var state = workspaces.getSnapshot();
        var list = state && Array.isArray(state.list) ? state.list : [];
        var picked = state && state.selected !== undefined && state.selected !== null
          ? state.selected
          : (state ? state.selectedId : undefined);
        var chosen = list.filter(function (item) {
          return item && (item.id === picked || item.path === picked);
        })[0];
        if (chosen && chosen.path) return chosen.path;
        if (list.length > 0 && list[0] && list[0].path) return list[0].path;
      } catch (error) { }
      return null;
    }

    /**
     * Workspace root of the active context, through the official client paths.
     *
     * Three sources, in order, because a panel may be mounted with no session at
     * all (the right sidebar's tab body receives none):
     *   1. the session's `cwd` (`ctx.sessions.list.byId[sessionId].cwd`),
     *   2. the SELECTED workspace of `ctx.workspaces`, which is what the sidebar
     *      highlights and the only source that exists before a session is picked,
     *   3. the first workspace in that list.
     *
     * `fallback` is the host's own answer (`/ui-extras/workspace`), used when the
     * client knows no workspace at all, so a panel is never left without a
     * directory to run commands in.
     */
    function resolveWorkspace(sessions, sessionId, workspaces, fallback) {
      try {
        if (sessions && sessions.list) {
          var snapshot = sessions.list.getSnapshot();
          var id = sessionId;
          if (id === undefined || id === null) {
            var selected = snapshot && snapshot.selected;
            id = typeof selected === "string" ? selected : (selected && selected.id);
          }
          if ((id === undefined || id === null) && snapshot) id = snapshot.current;
          if (id !== undefined && id !== null) {
            var entry = snapshot && snapshot.byId ? snapshot.byId[id] : undefined;
            if (entry && entry.cwd) return entry.cwd;
          }
        }
      } catch (error) { }

      try {
        if (workspaces && typeof workspaces.getSnapshot === "function") {
          var state = workspaces.getSnapshot();
          var list = state && Array.isArray(state.list) ? state.list : [];
          var picked = state && state.selected !== undefined && state.selected !== null
            ? state.selected
            : (state ? state.selectedId : undefined);
          var chosen = list.filter(function (item) {
            return item && (item.id === picked || item.path === picked);
          })[0];
          if (chosen && chosen.path) return chosen.path;
          if (list.length > 0 && list[0] && list[0].path) return list[0].path;
        }
      } catch (error) { }

      return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
    }

    /**
     * Contains a panel's failure.
     *
     * A panel and the corner buttons live in the same React tree, so one throwing
     * panel used to unmount the whole thing — the button row vanished with it,
     * which is exactly what a ReferenceError inside the git panel did. This
     * boundary keeps the failure inside the panel's own box and shows the reason
     * instead.
     */
    class PanelBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error, info) {
        reportToHost("panel crashed", this.props.name + " :: " +
          String(error && error.stack ? error.stack : error) + " :: " + String(info && info.componentStack ? info.componentStack : ""));
      }

      render() {
        if (this.state.error !== null) {
          return jsx.jsxs("div", {
            "data-dsh-ui-extras": "panel-error",
            style: {
              position: "absolute",
              top: "30px",
              right: 0,
              zIndex: 40,
              width: "min(520px, 92vw)",
              padding: "10px 12px",
              border: "1px solid rgba(252,165,165,0.5)",
              borderRadius: "10px",
              background: "var(--dsw-alias-bg-layer-2, rgba(21,21,23,0.98))",
              color: "#fca5a5",
              fontSize: "12px",
              lineHeight: "18px",
              textAlign: "left"
            },
            children: [
              jsx.jsx("div", { children: this.props.name + " — " + (this.props.label || "hiba") }),
              jsx.jsx("div", { style: { opacity: 0.85, whiteSpace: "pre-wrap", marginTop: "4px" }, children: String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error) }),
              jsx.jsx("button", {
                type: "button",
                onClick: this.props.onClose,
                style: { marginTop: "6px", border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))", borderRadius: "7px", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", padding: "2px 10px" },
                children: "Bezárás"
              })
            ]
          });
        }
        return this.props.children;
      }
    }

    /**
     * Terminal tab identity in the right sidebar's tab system.
     *
     * `id` is what the body and title register under; `kind` is what `openTab`
     * names. The tab is a DOC PAGE rather than an overlay, so terminals live in
     * the same column as the files panel: they can be split, made fullscreen and
     * remembered by the layout instead of floating over the conversation.
     */
    var TERMINAL_KIND = "ui-extras-terminal";
    var TERMINAL_ID = "dsh-ui-extras/terminal";

    /** The terminal tab's registry definition; copy is read fresh per call. */
    function terminalDefinition(t) {
      return {
        id: TERMINAL_ID,
        kind: TERMINAL_KIND,
        // `extension` (the default) is the band that may take over a builtin
        // kind, and it outranks every shipped viewer for the same address.
        priority: "extension",
        title: function () { return t("cmdTitle"); },
        guide: [{
          order: 40,
          title: function () { return t("cmdTitle"); },
          description: function () { return t("cmdGuideDescription"); }
        }]
      };
    }

    /**
     * Connection watchdog.
     *
     * A tray-side auto-heal, the restart button or a deploy can restart the
     * Harness server, but an already open page only holds the previous
     * WebSocket: it stays on "Reconnecting…" forever even though the server is
     * back. This watchdog pings a lightweight host route every 5 seconds.
     *
     * Two details make it actually recover:
     *   * the ping has a deadline, because a request issued while the server is
     *     dying never settles and would silently stop the whole watchdog;
     *   * the reload goes through the same fresh-token navigation the buttons
     *     use, because a restarted server mints a NEW token — reloading the old
     *     address answers 401 and the page would stay dead.
     */
    function startConnectionWatchdog() {
      var failures = 0;
      var recovering = false;
      var timeout = 6000;
      /** When this beat last ran, to expose a blocked main thread. */
      var lastBeat = Date.now();

      function request(url) {
        // The component publishes its abortable fetch; before the first render
        // there is nothing to borrow, and a plain fetch is enough for a ping.
        if (serverRecovery && serverRecovery.fetchWithTimeout) {
          return serverRecovery.fetchWithTimeout(url, { cache: "no-store" }, timeout);
        }
        return fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      }

      function ping() {
        // A frozen interface leaves NO other trace: no exception, no failed
        // request, and the framework's own timers simply stop. This 5-second
        // beat is the only clock that would notice, so a gap longer than two
        // beats is reported the moment the thread runs again — which turns
        // "the UI froze" into a timestamp and a duration in this log.
        var now = Date.now();
        var gap = now - lastBeat;
        lastBeat = now;
        if (gap > 12000) {
          reportToHost("main thread stalled", String(Math.round(gap / 1000)) + "s without a beat (frozen from " +
            new Date(now - gap).toISOString() + " to " + new Date(now).toISOString() + ")");
        }
        if (recovering) return;
        request("/ui-extras/balance")
          .then(function (response) {
            return response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status));
          })
          .then(function () {
            // ANY recovery after a failed ping means the server was replaced
            // (a restart hands out a new sign-in token), so the page must
            // reload to rebuild its socket and re-run the token exchange.
            if (failures > 0) {
              recovering = true;
              console.info("[dsh-ui-extras] the host answered after a gap; reconnecting");
              navigateToFreshServer(6);
              return;
            }
            failures = 0;
          })
          .catch(function () {
            failures++;
            if (failures === 4) {
              console.warn("[dsh-ui-extras] the host stopped answering; waiting for the server to come back");
            }
          });
      }

      /** Reload onto the freshest sign-in URL, retrying while the new server boots. */
      function navigateToFreshServer(attempts) {
        if (serverRecovery && serverRecovery.reloadWhenServerIsBack) {
          serverRecovery.reloadWhenServerIsBack(attempts, 2000);
          return;
        }
        window.location.reload();
      }

      // A restart takes tens of seconds; a 5-second beat notices the server
      // coming back quickly, which keeps the "Reconnecting" window short.
      var timer = setInterval(ping, 5000);
      return function () { clearInterval(timer); };
    }

    /**
     * Register the extended row below the composer card, the corner controls,
     * hide the built-in pills, and publish the dictionaries.
     */
    function apply(ctx) {
      // Any uncaught error inside this bundle lands in the host log, so a broken
      // client build is diagnosable without opening DevTools. Installed once.
      try {
        if (!window.__dshUiExtrasErrorHooks) {
          window.__dshUiExtrasErrorHooks = true;
          window.addEventListener("error", function (event) {
            reportToHost("window error", String(event.message) + " @ " + String(event.filename) + ":" + String(event.lineno));
          });
          window.addEventListener("unhandledrejection", function (event) {
            var reason = event.reason;
            reportToHost("unhandled rejection", String(reason && reason.stack ? reason.stack : reason));
          });
        }
      } catch (error) { }

      /**
       * Debug handle for driving this page from the outside.
       *
       * Why it exists: the host cannot see the browser, and some failures (a
       * blocked main thread, a missing slot) leave no trace in any log. The
       * harness's own probes load the page with `?dsh-ui-extras-debug=1` and
       * then speak to the live services through this handle.
       *
       * It is deliberately flag-gated: without the query parameter nothing is
       * published, so an ordinary page (or any script that happens to run in it)
       * never gets the client context.
       */
      try {
        // Two sources, because the address bar is not reliable: the shell may
        // clean it before this bundle is evaluated. The localStorage key is what
        // the harness's own browser probes set before reloading the page.
        var debugWanted = false;
        try {
          debugWanted = new URLSearchParams(__dshUiExtrasSearchAtLoad).get("dsh-ui-extras-debug") === "1";
        } catch (error) { }
        if (!debugWanted) {
          try { debugWanted = window.localStorage.getItem("dsh-ui-extras.debug") === "1"; } catch (error) { }
        }
        if (debugWanted) {
          window.__dshUiExtrasDebug = {
            context: ctx,
            phase: readConversationPhase,
            createWorkspace: function (path) { return ctx.workspaces.create({ path: path }); },
            counters: function () {
              return {
                controls: document.querySelectorAll('[data-dsh-ui-extras="corner-controls"]').length,
                stats: document.querySelectorAll('[data-dsh-ui-extras="stats"]').length,
                phase: readConversationPhase()
              };
            }
          };
          reportToHost("debug handle", "published for dsh-ui-extras-debug=1");
        }
      } catch (error) {
        reportToHost("debug handle", "failed: " + String(error && error.message ? error.message : error));
      }

      ctx.effect(function () {
        return ctx.locale.register(NS, { hu: hu, en: en });
      }, "ui-extras: dictionaries");

      // Ask for the host's working directory ONCE, at boot, instead of leaving it
      // to the first terminal panel: the last-resort fallback has to be in hand
      // before a panel renders, otherwise that panel resolves its workspace to
      // nothing and every directory-dependent control starts disabled.
      ctx.effect(function () {
        var alive = true;
        loadHostWorkspace().then(function (value) {
          if (alive && value) reportToHost("host workspace", String(value));
        });
        return function () { alive = false; };
      }, "ui-extras: host workspace");

      ctx.effect(function () {
        return startConnectionWatchdog();
      }, "ui-extras: connection watchdog");

      // Restore the terminal panel's open state and column width after a reload.
      //
      // ONE source of truth, guarded so it cannot double-open and cannot fight the
      // framework over the width:
      //   * the panel is re-opened once, when the previous page had it open (the
      //     heartbeat), and only after the sidebar's session seat is mounted;
      //   * the column width is written ONCE, right after the frame first renders,
      //     and then never again — the earlier bug was a watcher that re-applied
      //     the width forever and, worse, mistook the framework's 45% default for
      //     the user's own size and saved it.
      var restoreAttempts = 0;
      // Declared before the function that stops it: the restore runs asynchronously
      // and would otherwise reach a `const` in its temporal dead zone.
      var restoreTimer = null;

      /**
       * One full state dump, written to the host log.
       *
       * The browser is invisible from here, so this reports every side of the
       * question at once: whether the layout is stored, whether the sidebar says it
       * is expanded, what the frame's grid actually measures, which storage keys the
       * framework keeps, and whether the terminal tab is among them. Without this
       * the diagnosis is guesswork.
       */
      function dumpPanelState(tag, workspace) {
        try {
          // Same detector the restore uses, so the log proves whether the write
          // will find its target.
          var frame = findLayoutFrame();
          var frameInfo = "none";
          if (frame) {
            frameInfo = String(frame.className).slice(0, 48) + " grid=" +
              String(frame.style.gridTemplateColumns || "").slice(0, 60);
          }
          var col = document.querySelector("[data-rightbar-col]");
          var colWidth = "none";
          if (col) {
            colWidth = String(Math.round(col.getBoundingClientRect().width)) + "px";
          }
          var expanded = "n/a";
          try {
            expanded = String(ctx.sidebarRight.isExpanded());
          } catch (error) {
            expanded = "error";
          }
          var keys = [];
          for (var j = 0; j < window.localStorage.length && j < 40; j++) {
            var key = window.localStorage.key(j);
            if (key !== null) keys.push(key);
          }
          // What the framework itself remembers: if the terminal kind appears in its
          // layout key, re-opening is the framework's job and not ours.
          var viewInfo = "none";
          try {
            var raw = window.localStorage.getItem("dsh.workspace.view.v5");
            if (raw !== null) {
              var parsed = JSON.parse(raw);
              var text = JSON.stringify(parsed);
              viewInfo = "len=" + String(text.length) +
                " hasTerminalKind=" + String(text.indexOf(TERMINAL_KIND) >= 0) +
                " topKeys=" + Object.keys(parsed).slice(0, 6).join("/");
            }
          } catch (error) {
            viewInfo = "unreadable";
          }
          reportToHost("panel state (" + tag + ")",
            "expanded=" + expanded +
            " rightbarCol=" + colWidth +
            " frame=[" + frameInfo + "]" +
            " view={" + viewInfo + "}" +
            " keys={" + keys.join(",") + "}");
        } catch (error) {
          reportToHost("panel state (" + tag + ")", "failed: " + String(error && error.message ? error.message : error));
        }
      }

      function tryRestoreTerminal() {
        restoreAttempts++;
        if (restoreAttempts > 25) {
          if (restoreTimer !== null) clearInterval(restoreTimer);
          reportToHost("terminal restore", "gave up after " + String(restoreAttempts) + " tries");
          return;
        }
        if (!ctx.sidebarRight || typeof ctx.sidebarRight.openTab !== "function") {
          return;
        }
        var workspace = hostWorkspace || selectedWorkspaceOf(ctx.workspaces);
        if (!workspace) {
          return;
        }

        fetch(LAYOUT_ROUTE + "?workspace=" + encodeURIComponent(workspace), { headers: { Accept: "application/json" } })
          .then(function (response) { return response.json(); })
          .then(function (body) {
            var layout = body && body.ok === true && body.layout ? body.layout : {};
            var beat = Number(layout.terminalOpen || 0);
            var age = beat <= 0 ? -1 : Math.floor(Date.now() / 1000) - beat;

            reportToHost("terminal restore", "beat=" + String(beat) + " age=" + String(age) +
              " width=" + String(layout.rightbarWidth || 0));
            dumpPanelState("after fetch", workspace);

            // The heartbeat is cleared only when the tab is CLOSED, so a non-zero
            // beat means the panel was on screen. Older than half an hour is stale.
            if (beat > 0 && age >= 0 && age <= 1800) {
              var opened = "ok";
              try {
                ctx.sidebarRight.openTab(TERMINAL_KIND);
              } catch (error) {
                opened = "threw: " + String(error && error.message ? error.message : error);
              }
              // Verified, not assumed: the tab body logs its own mount, so a
              // successful call that still shows nothing is distinguishable from a
              // call that threw.
              reportToHost("terminal restore", "openTab " + opened +
                ", isExpanded=" + String((function () {
                  try { return ctx.sidebarRight.isExpanded(); } catch (error) { return "error"; }
                })()));
              // Opening the tab does NOT show the column: the right sidebar can be
              // on its rail, and then the tab exists while nothing of it is on
              // screen — which is exactly what "the panel did not come back" looks
              // like. The expansion happens only here, i.e. only when the panel was
              // genuinely open before, so a deliberate collapse is still respected.
              var wasCollapsed = false;
              try {
                wasCollapsed = typeof ctx.sidebarRight.isExpanded === "function" && ctx.sidebarRight.isExpanded() === false;
              } catch (error) {
                wasCollapsed = false;
              }
              if (wasCollapsed) {
                try {
                  ctx.sidebarRight.toggleExpanded();
                  reportToHost("terminal restore", "column was collapsed; expanded it");
                } catch (error) {
                  reportToHost("terminal restore", "expand failed: " + String(error && error.message ? error.message : error));
                }
              }
              // Re-opening resets the column, so the width goes back with it.
              applyTerminalPrefs(workspace, layout);
              applyRememberedWidth(workspace, 20);
              // What the page looks like AFTER the restore, which is the state the
              // next reload has to reproduce.
              setTimeout(function () { dumpPanelState("after restore", workspace); }, 3000);
              // Done: one restore per page, not one per second.
              clearInterval(restoreTimer);
            }
          })
          .catch(function () { });
      }

      restoreTimer = setInterval(tryRestoreTerminal, 1000);
      ctx.effect(function () { return function () { if (restoreTimer !== null) clearInterval(restoreTimer); }; }, "ui-extras: terminal restore");

      // A dump early in the page's life, before any restore runs: it shows what the
      // framework restored on its own, plus how the resize handle is reachable.
      setTimeout(function () {
        dumpPanelState("page load", hostWorkspace || selectedWorkspaceOf(ctx.workspaces));
        probeHandleOnce();
      }, 2500);

      // Clear the layout keys this plugin once let cover the interface; the
      // restore above no longer writes into browser storage, so it is safe.
      safeRun("storage cleanup", cleanupPanelStorage);

      // Hungarian is not in the shipped catalog (the selector offers Chinese and
      // English only), so it is contributed as a selectable language with
      // English as its fallback chain.
      try {
        ctx.locale.addLanguage({ id: "hu", label: "Magyar", fallback: "en" });
      } catch (error) {
        // Already registered (a second load or HMR) — not a failure.
        console.info("[dsh-ui-extras] Hungarian language already present");
      }

      // One language-pack namespace registered per entry: `register` throws for a
      // (namespace, language) pair that already has an owner, and a throw inside
      // a boot effect would cost the whole plugin — so each namespace is
      // registered independently and a collision is reported, never fatal.
      var packReport = {};
      ctx.effect(function () {
        var disposers = [];
        var packs = { common: commonHu };
        Object.keys(packHu).forEach(function (ns) { packs[ns] = packHu[ns]; });
        Object.keys(packs).forEach(function (ns) {
          try {
            disposers.push(ctx.locale.register(ns, "hu", packs[ns]));
            packReport[ns] = Object.keys(packs[ns]).length;
          } catch (error) {
            packReport[ns] = "FAILED: " + String(error && error.message ? error.message : error);
          }
        });
        // The host plugin keeps this through /ui-extras/i18n and reports it as a
        // normal deploy check, so "did the language pack load?" never needs a
        // browser console.
        //
        // The report is sent on EVERY page load, unconditionally: the earlier
        // `?dsh-ui-extras-probe=1` gate silently never fired, because the shell
        // is free to clean the address bar before this bundle runs — the check
        // then answered "no report yet" forever. One small POST per load is
        // cheaper than a diagnostic that lies.
        try {
          window.__dshUiExtrasI18n = packReport;
        } catch (error) { }
        console.info("[dsh-ui-extras] Hungarian language pack:", JSON.stringify(packReport));
        try {
          var snapshot = ctx.locale.getLocale();
          fetch("/ui-extras/i18n", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              active: snapshot ? snapshot.active : null,
              locales: snapshot && snapshot.locales ? snapshot.locales.map(function (l) { return l.id; }) : [],
              namespaces: packReport,
              bundled: Object.keys(packs).map(function (ns) { return ns + ":" + Object.keys(packs[ns]).length; })
            })
          }).then(function () {
            console.info("[dsh-ui-extras] language-pack report sent");
            // A probe parameter in the address bar is stale once the report is
            // out; it is removed so a shared URL does not carry it.
            try {
              if (new URLSearchParams(__dshUiExtrasSearchAtLoad).get("dsh-ui-extras-probe") === "1") {
                var clean = new URL(location.href);
                clean.searchParams.delete("dsh-ui-extras-probe");
                history.replaceState(null, "", clean.pathname + clean.search + clean.hash);
              }
            } catch (error) { }
          }).catch(function (error) {
            console.warn("[dsh-ui-extras] language-pack report failed:", error);
          });
        } catch (error) { }
        return function () {
          disposers.forEach(function (dispose) { try { dispose(); } catch (error) { } });
        };
      }, "ui-extras: hungarian language pack");

      safeRun("composer.dock inject", function () {
        ctx.slots.inject("conversation.composer.dock", function () {
          return ctx.slots.register({
            name: "conversation.composer.dock",
            id: "ui-extras-stats",
            locale: NS
          }, StatsBar);
        });
      });

      // ------------------------------------------------- approval card takeover
      //
      // The composer chain elects the first entry whose `select` returns
      // non-null, in ascending priority order. The built-in approval panel sits
      // at priority 1 and the question composer at 0, so registering at 0 puts
      // this card ahead of the built-in one for approval interactions while
      // leaving every other pending interaction (a question, a plan review)
      // untouched: the selectors are disjoint.
      //
      // The card renders the whole prompt — headline, access type, reason and
      // the command — because it REPLACES the built-in panel rather than sitting
      // beside it: a chain cell has exactly one winner.
      safeRun("approval card inject", function () {
        installApprovalStyles();
        ctx.slots.inject("conversation.composer", function () {
          return ctx.slots.register({
            name: "conversation.composer",
            priority: 0,
            locale: NS,
            inject: function () {
              return { locale: ctx.locale };
            },
            select: function (owner) {
              var pending = owner ? owner.pendingInteraction : null;
              if (pending === null || pending === undefined) return null;
              // The pending interaction's domain discriminator is the only
              // stable identity every kind shares; ui-approval's own class is
              // not addressable from here.
              return pending.kind === "approval" ? pending : null;
            }
          }, ApprovalCard);
        });
      });

      // The theme preference must reach the HOST settings: the theme service
      // re-adopts the stored host value on every settings change, so a purely
      // local setPreference() is overwritten and the toggle looks dead. Binding
      // the theme settings namespace gives a durable store whose update() writes
      // through to the host. If the namespace is not bindable in this build, the
      // button still flips the live theme locally.
      var themeStore = null;
      try {
        if (ctx.settingsScope && typeof ctx.settingsScope.bind === "function") {
          themeStore = ctx.settingsScope.bind({ namespace: "ui-theme" });
        }
      } catch (error) {
        console.info("[dsh-ui-extras] theme settings store unavailable, using local preference only");
      }

      // A HOST oldja fel a gépspecifikus útvonalakat (dsh CLI, deploy szkript).
      //
      // MIÉRT NINCS ITT BEÉGETVE: korábban a fejlesztő gépének abszolút útjai
      // álltak itt (`C:\Szerver\...`, `C:\Users\<felhasználó>\AppData\...`), ami
      // más gépen hibás volt, és a felhasználónevet is kiszivárogtatta egy
      // nyilvános repóban. A host a futó dsh CLI saját útját ismeri
      // (`process.argv[1]`), a deploy szkriptet pedig a repó gyökeréhez képest.
      // Üres értéket adunk át, és a host tölti ki.
      var deployScript = "";
      var dshBin = "";
      var restartScript = "";

      safeRun("corner controls inject", function () {
        ctx.slots.inject("conversation.session.header.utilities", function () {
          return ctx.slots.register({
            name: "conversation.session.header.utilities",
            id: "ui-extras-corner",
            locale: NS,
            inject: function () {
              return { locale: ctx.locale, theme: ctx.theme, sessions: ctx.sessions, workspaces: ctx.workspaces, themeStore: themeStore, deployScript: deployScript, restartScript: restartScript, dshBin: dshBin, sidebarRight: ctx.sidebarRight };
            }
          }, CornerControls);
        });
      });

      // ------------------------------------------------------- hero-era copies
      //
      // A brand-new session hides the header and drops the composer dock, so the
      // controls and the statistics row used to appear only after the first
      // message. `conversation.input.dock` is the one full-width seat above the
      // composer card that exists in BOTH phases, so both views are registered
      // there a second time with `heroVariant` — and both hide themselves as
      // soon as the session turns active, which keeps exactly one copy on screen.
      safeRun("hero-era inject", function () {
        var heroControlsProps = function () {
          return { locale: ctx.locale, theme: ctx.theme, sessions: ctx.sessions, workspaces: ctx.workspaces, themeStore: themeStore, deployScript: deployScript, restartScript: restartScript, dshBin: dshBin, sidebarRight: ctx.sidebarRight, heroVariant: true };
        };
        ctx.slots.inject("conversation.input.dock", function () {
          return [
            ctx.slots.register({
              name: "conversation.input.dock",
              id: "ui-extras-hero-controls",
              order: 40,
              locale: NS,
              inject: heroControlsProps
            }, CornerControls),
            ctx.slots.register({
              name: "conversation.input.dock",
              id: "ui-extras-hero-stats",
              order: 41,
              locale: NS,
              inject: function () { return { heroVariant: true }; }
            }, StatsBar)
          ];
        });
      });

      // ---------------------------------------------------------- terminal tab
      // The terminals are a tab TYPE in the right sidebar, exactly like the files
      // panel: registered statically here, its body registered under the same
      // id in the keyed body slot. `sidebarRight.openTab(kind)` — the ▶ corner
      // button — is what puts it on screen.
      safeRun("terminal tab type", function () {
        if (!ctx.sidebarRightTabs || typeof ctx.sidebarRightTabs.register !== "function") {
          reportToHost("init failed", "sidebarRightTabs service unavailable; terminals stay in the overlay");
          return;
        }
        var boundTranslate = ctx.locale.bind(NS);
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register(terminalDefinition(boundTranslate));
        }, "ui-extras: terminal tab type");

        ctx.effect(function () {
          return ctx.slots.inject("sidebar.right.pane.tab", function () {
            return ctx.slots.register({
              name: "sidebar.right.pane.tab",
              key: TERMINAL_ID,
              locale: NS,
              inject: function () {
                // Sessions and workspaces come from the plugin context, not from
                // the tab props: a tab body is mounted by the sidebar and carries
                // no session id, so the workspace has to be resolved elsewhere.
                //
                // `hostWorkspaceOf` is a GETTER on purpose: this callback runs once,
                // when the tab type is registered, and the host's answer to
                // `/ui-extras/workspace` usually arrives after it — a captured null
                // then disabled the last-resort fallback for the life of the page.
                return { sessions: ctx.sessions, workspaces: ctx.workspaces, hostWorkspaceOf: hostWorkspaceOf };
              }
            }, function TerminalTabBody(bodyProps) {
              // Read through the getter on EVERY render, so a late host answer (or
              // a session switch) is picked up by the panel below.
              var hostNow = typeof bodyProps.hostWorkspaceOf === "function"
                ? bodyProps.hostWorkspaceOf()
                : null;
              return jsx.jsx(CmdPanel, {
                t: bodyProps.t,
                workspace: resolveWorkspace(bodyProps.sessions, null, bodyProps.workspaces, hostNow),
                docked: true
              });
            });
          });
        }, "ui-extras: terminal tab body");

        // The chip has no separate registration: the registry's `title(address)`
        // text captured at open time is what the chip shows.
      });

      // A beépített sor elrejtése: így egyetlen, bővített statisztika-sor van.
      safeRun("builtin stats hiding", function () {
        var style = document.createElement("style");
        style.setAttribute("data-dsh-ui-extras", "hide-builtin-stats");
        style.textContent = "[data-composer-stats]{display:none !important}";
        document.head.appendChild(style);
      });
    }
    var inject = ["slots", "locale", "theme", "sessions", "workspaces", "settingsScope", "sidebarRightTabs", "sidebarRight"];

    exports.StatsBar = StatsBar;
    exports.CornerControls = CornerControls;
    exports.ApprovalCard = ApprovalCard;
    exports.PermissionsPanel = PermissionsPanel;
    // The locale readers are exported so tools/check-plugin.mjs can pin them
    // against the real `getLocale()` snapshot shape: reading a snapshot as a
    // plain id is what made the language button start on the wrong branch.
    exports.activeLocaleId = activeLocaleId;
    exports.isHungarianLocaleId = isHungarianLocaleId;
    // Same reason: the phase readers decide which copy of a view is on screen,
    // and they must never confuse the composer's own `data-phase` with the
    // conversation's.
    exports.readConversationPhase = readConversationPhase;
    exports.phaseServesView = phaseServesView;
    // Exported so tools/check-plugin.mjs can prove the holiday calendar here has
    // not drifted from the host half's — that table is duplicated by necessity
    // (the pill is computed in the browser) and duplication without a check is
    // how two copies of a rule start disagreeing.
    exports.CHINESE_HOLIDAYS = CHINESE_HOLIDAYS;
    exports.isChineseHoliday = isChineseHoliday;
    exports.isPeakRate = isPeakRate;
    exports.nextSwitch = nextSwitch;
    exports.peakWindowsLocalText = peakWindowsLocalText;
    exports.apply = apply;
    exports.inject = inject;
    // Exported so tools/check-plugin.mjs can pin the workspace resolution: the
    // terminal ran "npm run dev" in the Harness's own directory because a panel
    // fell back to the host cwd while a session with its own cwd was selected.
    // That ordering is a rule, and a rule without a test drifts.
    exports.resolveWorkspace = resolveWorkspace;
    exports.pickSessionWorkspace = pickSessionWorkspace;
    return module.exports;
  }
});
















