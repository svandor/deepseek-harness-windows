/**
 * Browser half of the dev-admin plugin: the "Admin" tab in the right sidebar.
 *
 * Everything it shows comes from the host half (`/devadmin/state`), which in
 * turn calls the same `tools\dev.ps1` a human uses. The browser never runs a
 * command itself; it only renders and asks the host to act.
 *
 * Two entry points:
 *   * a small "Admin" chip in the composer input dock, which opens the tab;
 *   * the tab itself (`devadmin` kind) with the full panel.
 *
 * The tab is registered statically (tab TYPE + body under the same key), the
 * same shape `dsh-ui-extras` uses for its terminal tab.
 */
window.__ModuleLoader__.load({
  id: "dsh-devadmin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");

    /** A tab azonositoja es tipusa (a jobb oldalsavban jelenik meg). */
    const TAB_ID = "dsh-devadmin/admin";
    const TAB_KIND = "devadmin";
    /** A FELSO MENUSOR rekesze, ahova az ikon kerul (a ui-extras is ezt hasznalja). */
    const HEADER_SLOT = "conversation.session.header.utilities";
    const BODY_SLOT = "sidebar.right.pane.tab";
    const POLL_MS = 5000;

    // ── stilbok (inline; a tema valtozoit hasznaljak) ────────────────────
    const PAGE = { padding: "12px", display: "flex", flexDirection: "column", gap: "12px", fontSize: "13px" };
    const CARD = {
      border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))",
      borderRadius: "8px",
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
    };
    const TITLE = {
      fontSize: "12px",
      textTransform: "uppercase",
      letterSpacing: ".04em",
      opacity: 0.7,
      fontWeight: 600,
    };
    const ROW = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
    const MONO = {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: "12px",
      wordBreak: "break-all",
    };
    const DIM = { opacity: 0.65 };
    /** A fejlec-ikon gomb: a menüsor magassagahoz illik, kerettel (mint a tobbi ikon). */
    const HEADER_BTN = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      font: "inherit",
      fontSize: "12px",
      lineHeight: "18px",
      height: "26px",
      minWidth: "30px",
      padding: "0 7px",
      borderRadius: "6px",
      // A keret MINDIG látszik, ahogy a többi menüsor-ikonon (a felhasználó
      // kérése: „a php ikonnak is kéne a keret, amit a többi ikon megkapott").
      border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))",
      background: "transparent",
      color: "var(--dsw-alias-label-secondary, inherit)",
      cursor: "pointer",
    };
    const HEADER_BTN_HOVER = {
      borderColor: "var(--dsw-alias-border-primary, rgba(127,127,127,.7))",
      color: "var(--dsw-alias-label-primary, inherit)",
    };
    /** Kis bemenet a projekt-szerkesztőhöz. */
    const INPUT = {
      font: "inherit",
      fontSize: "12px",
      padding: "2px 6px",
      borderRadius: "6px",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.5))",
      background: "transparent",
      color: "inherit",
      minWidth: "120px",
    };
    const INPUT_LABEL = (props) => h("span", { style: { ...DIM, fontSize: "11px" } }, props.text);
    const BTN = {
      font: "inherit",
      fontSize: "12px",
      padding: "3px 10px",
      borderRadius: "6px",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.5))",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
    };
    const BTN_PRIMARY = { ...BTN, background: "var(--dsw-alias-state-success-primary, #2e7d32)", borderColor: "transparent", color: "#fff" };
    const BTN_DANGER = { ...BTN, color: "var(--dsw-alias-state-error-primary, #d32f2f)" };
    const OK = { color: "var(--dsw-alias-state-success-primary, #2e7d32)" };
    const BAD = { color: "var(--dsw-alias-state-error-primary, #d32f2f)" };
    const WARN = { color: "var(--dsw-alias-state-warning-primary, #b26a00)" };
    const PRE = {
      margin: 0,
      padding: "8px",
      borderRadius: "6px",
      background: "rgba(127,127,127,.10)",
      maxHeight: "220px",
      overflow: "auto",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: "11px",
    };

    function h() {
      return react.createElement.apply(null, arguments);
    }

    async function getJson(url) {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    function badge(ok, onText, offText) {
      return h("span", { style: { ...MONO, ...(ok ? OK : BAD) } }, ok ? onText : offText);
    }

    // ── a panel ──────────────────────────────────────────────────────────
    /**
     * Az admin panel. 5 masodpercenkent frissit; a muveletek utan azonnal.
     * @param props - a shell altal adott slot-props (nem hasznaljuk).
     */
    function DevAdminPanel() {
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState("");
      const [logSite, setLogSite] = react.useState("");
      const [logs, setLogs] = react.useState("");
      /** A windows.php.net teljes listája (a telepítettek is, jelölve). */
      const [releaseList, setReleaseList] = react.useState([]);
      /** Szerkesztett projekt (domain) + a beírt értékek; null = nincs nyitva. */
      const [editing, setEditing] = react.useState(null);

      // Telepíthető PHP-verziók: egyszer töltjük, a lista ritkán változik.
      react.useEffect(() => {
        let alive = true;
        getJson("/devadmin/php?action=available")
          .then((payload) => {
            if (!alive) return;
            setReleaseList(payload.versions || []);
          })
          .catch(() => {
            if (alive) setReleaseList([]);
          });
        return () => {
          alive = false;
        };
      }, []);

      const refresh = react.useCallback(async () => {
        try {
          const next = await getJson("/devadmin/state");
          setData(next);
          setError("");
          if (!logSite && next.sites && next.sites.length > 0) setLogSite(next.sites[0].domain);
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        }
      }, [logSite]);

      react.useEffect(() => {
        let alive = true;
        const tick = async () => {
          if (!alive) return;
          await refresh();
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      const act = react.useCallback(
        async (action, extra) => {          setBusy(action);
          try {
            const url = `/devadmin/action?action=${encodeURIComponent(action)}${extra ? `&${extra}` : ""}`;
            const result = await getJson(url);
            if (!result.ok) throw new Error(result.error || result.output || "nem sikerult");
            await new Promise((resolve) => setTimeout(resolve, 2500));
            await refresh();
          } catch (failure) {
            setError(failure && failure.message ? failure.message : String(failure));
          } finally {
            setBusy("");
          }
        },
        [refresh],
      );

      /**
       * Egyetlen szolgaltatas muvelete. A host a hatterben inditja (a php-cgi
       * hosszu eletu), ezert nem varunk ra: 2,5 s mulva frissitunk.
       * @param serviceId - `caddy` | `php:<domain>` | `all`.
       * @param verb - `start` | `stop` | `restart`.
       */
      const actService = react.useCallback(
        async (serviceId, verb) => {
          setBusy(`${serviceId}:${verb}`);
          try {
            const url = `/devadmin/service?id=${encodeURIComponent(serviceId)}&verb=${encodeURIComponent(verb)}`;
            const result = await getJson(url);
            if (!result.ok) throw new Error(result.error || "nem sikerult");
            await new Promise((resolve) => setTimeout(resolve, 2500));
            await refresh();
          } catch (failure) {
            setError(failure && failure.message ? failure.message : String(failure));
          } finally {
            setBusy("");
          }
        },
        [refresh],
      );

      /**
       * A projekt `.dsh\dev.yaml`-jának mentése a felületről. A host a
       * `dev.ps1 -Action site-save`-ot hívja, tehát a CLI és a UI ugyanazt a
       * kódutat használja; `restart` esetén a projekt php-cgi munkása is
       * újraindul (a módosított php-verzió azonnal él).
       */
      const saveSite = react.useCallback(
        async (draft, restart) => {
          setBusy("site-save");
          try {
            const url =
              "/devadmin/site?action=save" +
              `&project=${encodeURIComponent(draft.project)}` +
              `&domain=${encodeURIComponent(draft.domain)}` +
              `&docroot=${encodeURIComponent(draft.docroot)}` +
              `&php=${encodeURIComponent(draft.php)}` +
              `&aliases=${encodeURIComponent(draft.aliases || "")}` +
              (restart ? "&restart=1" : "");
            const result = await getJson(url);
            if (!result.ok) throw new Error(result.output || result.error || "nem sikerult");
            setEditing(null);
            await new Promise((resolve) => setTimeout(resolve, 2500));
            await refresh();
          } catch (failure) {
            setError(failure && failure.message ? failure.message : String(failure));
          } finally {
            setBusy("");
          }
        },
        [refresh],
      );

      const loadLogs = react.useCallback(async () => {
        if (!logSite) return;
        try {
          const payload = await getJson(`/devadmin/logs?site=${encodeURIComponent(logSite)}&tail=120`);
          const parts = [];
          if (payload.phpError) parts.push("--- php-cgi stderr ---\n" + payload.phpError);
          if (payload.php) parts.push("--- php-cgi stdout ---\n" + payload.php);
          if (payload.access) parts.push("--- access ---\n" + payload.access);
          if (payload.caddyError) parts.push("--- caddy ---\n" + payload.caddyError);
          setLogs(parts.length ? parts.join("\n\n") : "(nincs naplobejegyzes)");
        } catch (failure) {
          setLogs("hiba: " + (failure && failure.message ? failure.message : String(failure)));
        }
      }, [logSite]);

      react.useEffect(() => {
        if (logSite) loadLogs();
      }, [logSite, loadLogs]);

      if (!data) {
        return h("div", { style: PAGE }, h("div", { style: DIM }, error ? `Hiba: ${error}` : "Betoltes…"));
      }

      const server = data.devServer;

      return h(
        "div",
        { style: PAGE },
        h(
          "div",
          { style: ROW },
          h("span", { style: { fontWeight: 600 } }, "Fejlesztoi kornyezet"),
          badge(server.running, "FUT", "ALL"),
          h("span", { style: { ...MONO, ...DIM } }, `caddy ${server.caddyPid || "-"}`),
          h(
            "button",
            { style: BTN_PRIMARY, disabled: busy !== "", onClick: () => act("start") },
            "Inditas",
          ),
          h("button", { style: BTN, disabled: busy !== "", onClick: () => act("restart") }, "Ujrainditas"),
          h("button", { style: BTN_DANGER, disabled: busy !== "", onClick: () => act("stop") }, "Leallitas"),
          error ? h("span", { style: BAD }, error) : null,
        ),

        // dev szerver reszletek
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, "Dev szerver"),
          h("div", { style: ROW }, h("span", { style: DIM }, "HTTPS"), h("span", { style: MONO }, String(server.httpsPort)),
            server.httpsPort === 443 ? h("span", { ...DIM }, "(kanonikus)") : h("span", { style: WARN }, "nem 443")),
          h("div", { style: ROW }, h("span", { style: DIM }, "HTTP"), h("span", { style: MONO }, `${server.httpPort} -> HTTPS`)),
          h("div", { style: { ...MONO, ...DIM } }, server.configFile),
        ),

        // projektek
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, `Projektek (${data.sites.length})`),
          data.sites.length === 0
            ? h("div", { style: DIM }, "Nincs felismert projekt (kell index.php es/vagy .dsh/dev.yaml).")
            : data.sites.map((site) =>
                h(
                  "div",
                  { key: site.domain, style: { display: "flex", flexDirection: "column", gap: "2px" } },
                  h(
                    "div",
                    { style: ROW },
                    h("a", { href: site.url, target: "_blank", rel: "noopener", style: MONO }, site.domain),
                    badge(site.phpCgiAlive, `php-cgi ${site.phpCgiPid || ""}`, "php-cgi all"),
                    h("span", { style: { ...MONO, ...DIM } }, `:${site.phpCgiPort || "-"}`),
                    h("span", { style: { ...MONO, ...(site.probe && site.probe.status < 400 ? OK : BAD) } },
                      site.probe && site.probe.status ? `HTTP ${site.probe.status}` : `HTTP ${site.probe && site.probe.error ? site.probe.error : "-"}`),
                  ),
                  h(
                    "div",
                    { style: { ...MONO, ...DIM } },
                    `php ${site.php} · ${site.docroot}`,
                  ),
                  site.db
                    ? h(
                        "div",
                        { style: { ...MONO, ...(site.db.connection === "sqlite" || site.db.reachable ? OK : BAD) } },
                        `db ${site.db.connection} ${site.db.host}:${site.db.port}/${site.db.database}`,
                      )
                    : h("div", { style: { ...MONO, ...DIM } }, "db nincs (.env)"),
                  site.inHosts ? null : h("div", { style: { ...MONO, ...WARN } }, "Hianyzik a hosts fajlbol!"),
                  h(
                    "div",
                    { style: ROW },
                    h(
                      "button",
                      {
                        style: BTN,
                        onClick: () =>
                          setEditing({
                            project: site.project,
                            domain: site.domain,
                            docroot:
                              site.docroot.indexOf(site.project) === 0
                                ? site.docroot.slice(site.project.length).replace(/^[\\/]/u, "") || "."
                                : site.docroot,
                            php: site.php,
                            aliases: site.aliases || "",
                          }),
                      },
                      "Beallitas",
                    ),
                  ),
                  editing && editing.project === site.project
                    ? h(
                        "div",
                        { style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" } },
                        h(
                          "div",
                          { style: ROW },
                          h(INPUT_LABEL, { text: "Domain" }),
                          h("input", {
                            style: INPUT,
                            value: editing.domain,
                            onChange: (event) => setEditing({ ...editing, domain: event.target.value }),
                          }),
                          h(INPUT_LABEL, { text: "Docroot" }),
                          h("input", {
                            style: INPUT,
                            value: editing.docroot,
                            onChange: (event) => setEditing({ ...editing, docroot: event.target.value }),
                          }),
                        ),
                        h(
                          "div",
                          { style: ROW },
                          h(INPUT_LABEL, { text: "PHP" }),
                          h(
                            "select",
                            {
                              style: INPUT,
                              value: editing.php,
                              onChange: (event) => setEditing({ ...editing, php: event.target.value }),
                            },
                            data.php.versions.map((version) => h("option", { key: version, value: version }, version)),
                          ),
                          h(INPUT_LABEL, { text: "Aliasok" }),
                          h("input", {
                            style: { ...INPUT, minWidth: "200px" },
                            value: editing.aliases,
                            onChange: (event) => setEditing({ ...editing, aliases: event.target.value }),
                          }),
                        ),
                        h(
                          "div",
                          { style: ROW },
                          h("button", { style: BTN_PRIMARY, disabled: busy !== "", onClick: () => saveSite(editing, false) }, "Mentes"),
                          h("button", { style: BTN, disabled: busy !== "", onClick: () => saveSite(editing, true) }, "Mentes + ujrainditas"),
                          h("button", { style: BTN, onClick: () => setEditing(null) }, "Megse"),
                        ),
                      )
                    : null,
                ),
              ),
        ),

        // php
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, "PHP"),
          h("div", { style: ROW }, h("span", { style: DIM }, "Aktualis:"), h("span", { style: MONO }, data.php.current || "nincs")),
          h(
            "div",
            { style: ROW },
            data.php.versions.map((version) =>
              h(
                "button",
                {
                  key: version,
                  style: version === data.php.current ? BTN_PRIMARY : BTN,
                  disabled: busy !== "",
                  onClick: () => act("php-use", `version=${encodeURIComponent(version)}`),
                },
                version,
              ),
            ),
          ),
          h("div", { style: { ...MONO, ...DIM } }, data.php.root),
          // A telepito resz MINDIG latszik (a felhasznalo jelezte: „én még nem
          // látok php telepítőt" — mert minden elerheto verzio telepítve volt,
          // és a szuro elrejtette a blokkot). Most a teljes lista latszik, a
          // telepítettek jelolve.
          h("div", { style: { ...ROW, marginTop: "6px", flexWrap: "wrap" } },
            h("span", { style: { ...MONO, ...DIM } }, "PHP telepítés:"),
            h(
              "button",
              {
                style: BTN,
                disabled: busy !== "",
                onClick: () => {
                  getJson("/devadmin/php?action=available")
                    .then((payload) => setReleaseList(payload.versions || []))
                    .catch((failure) => setError(failure?.message ?? String(failure)));
                },
              },
              "Lista frissítése",
            ),
            releaseList.length === 0
              ? h("span", { style: { ...MONO, ...DIM } }, "(nincs betöltött lista)")
              : null,
          ),
          releaseList.map((entry) =>
            h(
              "div",
              { key: `php-${entry.version}`, style: { ...ROW, marginTop: "2px" } },
              h("span", { style: { ...MONO, minWidth: "64px" } }, entry.version),
              entry.installed
                ? h("span", { style: { ...MONO, ...OK } }, "telepítve")
                : h(
                    "button",
                    {
                      style: BTN,
                      disabled: busy !== "",
                      onClick: () => act("php-install", `version=${encodeURIComponent(entry.version)}`),
                    },
                    "telepítés",
                  ),
            ),
          ),
        ),

        // szolgaltatasok: mindegyik kulon indithato/leallithato/ujraindithato
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, `Szolgaltatasok (${(data.services || []).length})`),
          (data.services || []).length === 0
            ? h("div", { style: DIM }, "A dev szerver nem fut — inditsd el a tetejen.")
            : data.services.map((service) =>
                h(
                  "div",
                  { key: service.id, style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
                  h("span", { style: { ...MONO, minWidth: "170px" } }, service.name),
                  badge(service.running, service.pid ? `pid ${service.pid}` : "fut", "all"),
                  h("span", { style: { ...MONO, ...DIM } }, service.detail),
                  h(
                    "button",
                    { style: BTN, disabled: service.running || busy !== "", onClick: () => actService(service.id, "start") },
                    "Indit",
                  ),
                  h("button", { style: BTN, disabled: busy !== "", onClick: () => actService(service.id, "restart") }, "Ujra"),
                  h(
                    "button",
                    { style: BTN_DANGER, disabled: !service.running || busy !== "", onClick: () => actService(service.id, "stop") },
                    "Leallit",
                  ),
                ),
              ),
        ),

        // adatbazis: a mysqld a DBngin (emelt) folyamata, ezert csak allapot
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, "Adatbazis"),
          h(
            "div",
            { style: ROW },
            badge(data.database && data.database.running, "fut", "all"),
            h("span", { style: { ...MONO, ...DIM } },
              data.database && data.database.pid
                ? `port ${data.database.port} · ${data.database.owner} (${data.database.pid})`
                : `port ${data.database ? data.database.port : 3306}`),
          ),
          h("div", { style: { ...MONO, ...DIM } }, (data.database && data.database.note) || ""),
          data.sites
            .filter((site) => site.db)
            .map((site) =>
              h(
                "div",
                { key: `db-${site.domain}`, style: { ...MONO, ...(site.db.connection === "sqlite" || site.db.reachable ? OK : BAD) } },
                `${site.domain}: ${site.db.connection} ${site.db.host}:${site.db.port}/${site.db.database}`,
              ),
            ),
        ),

        // portok
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, "Portok"),
          h(
            "div",
            { style: ROW },
            data.ports.map((entry) =>
              h(
                "span",
                { key: entry.port, style: { ...MONO, ...DIM, marginRight: "10px" } },
                `${entry.port}${entry.pid ? `=${entry.name || "?"}(${entry.pid})` : ": szabad"}`,
              ),
            ),
          ),
        ),

        // autostart
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, `Autostart (${data.autostart.length})`),
          data.autostart.map((entry) =>
            h(
              "div",
              { key: `${entry.source}/${entry.name}`, style: { display: "flex", gap: "6px" } },
              h("span", { style: { ...MONO, ...DIM, minWidth: "92px" } }, entry.source),
              /dev-hidden\.vbs/i.test(entry.command)
                ? h("span", { style: { ...MONO, ...OK } }, entry.name)
                : h("span", { style: MONO }, entry.name),
            ),
          ),
        ),

        // naplok
        h(
          "div",
          { style: CARD },
          h("div", { style: TITLE }, "Naplok"),
          h(
            "div",
            { style: ROW },
            h(
              "select",
              {
                value: logSite,
                onChange: (event) => setLogSite(event.target.value),
                style: { ...BTN, padding: "3px 6px" },
              },
              data.sites.map((site) => h("option", { key: site.domain, value: site.domain }, site.domain)),
            ),
            h("button", { style: BTN, onClick: loadLogs }, "Frissites"),
          ),
          h("pre", { style: PRE }, logs || "(meg nincs betoltve)"),
        ),
      );
    }

    // ── ikon a felso menusorban ─────────────────────────────────────────
    /**
     * A PHP-admin ikon a beszelgetes fejleceben (felso menusor).
     *
     * Miért nem a composer dokkban: a felhasznalo kerese szerint ez a
     * fejlec-ikon a helye. Egyetlen gomb: megnyitja a jobb oldalsav
     * `devadmin` fujet, ahol a teljes panel van.
     *
     * @param props - a slot `inject`-je adja az `openTab` hivatkozast.
     */
    function AdminHeaderButton(props) {
      const open = props && typeof props.openTab === "function" ? props.openTab : null;
      const [hover, setHover] = react.useState(false);
      return h(
        "button",
        {
          type: "button",
          title: "PHP admin — fejlesztoi kornyezet (Caddy, php-cgi, PHP-verziok, naplok)",
          "aria-label": "PHP admin",
          style: {
            ...HEADER_BTN,
            ...(hover ? HEADER_BTN_HOVER : null),
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: () => {
            if (open) open();
          },
        },
        // PHP-jellegu ikon: kapcsos zarojelek + pont (kod/fejlesztes)
        h(
          "svg",
          {
            width: 16,
            height: 16,
            viewBox: "0 0 16 16",
            fill: "none",
            "aria-hidden": "true",
            style: { flex: "none" },
          },
          h("path", {
            d: "M5.6 3.2 2.2 8l3.4 4.8",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }),
          h("path", {
            d: "M10.4 3.2 13.8 8l-3.4 4.8",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }),
          h("circle", { cx: 8, cy: 8, r: 1.3, fill: "currentColor" }),
        ),
        // Nincs felirat: a felso menusor gombjai ikonok, a nev a tooltipben van
        // (a felhasznalo kerese: „a php ikonhoz nem kell a php felirat").
      );
    }

    // ── plugin ──────────────────────────────────────────────────────────
    const inject = ["slots", "sidebarRightTabs", "sidebarRight"];

    function apply(ctx) {
      // 1) tab tipus
      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: "extension",
              title: () => "Admin",
              guide: [
                {
                  order: 90,
                  title: () => "Admin",
                  description: () => "Fejlesztoi kornyezet: Caddy, php-cgi, PHP-verziok, portok, naplok.",
                },
              ],
            }),
          "devadmin: tab type",
        );

        // 2) tab test ugyanazzal a kulccsal
        ctx.effect(
          () =>
            ctx.slots.inject(BODY_SLOT, () =>
              ctx.slots.register({ name: BODY_SLOT, key: TAB_ID }, DevAdminPanel),
            ),
          "devadmin: tab body",
        );
      }

      // 3) ikon a FELSO MENUSORBAN (a beszelgetes fejlece), nem a cset felett
      const openTab = () => {
        try {
          if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === "function") ctx.sidebarRight.openTab(TAB_KIND);
        } catch (error) {
          /* az ikon ilyenkor sem tesz semmit: nem nyit uj ablakot */
        }
      };
      ctx.slots.inject(HEADER_SLOT, () =>
        ctx.slots.register(
          {
            name: HEADER_SLOT,
            id: "devadmin-header",
            order: 60,
            inject: () => ({ openTab }),
          },
          AdminHeaderButton,
        ),
      );
    }

    exports.DevAdminPanel = DevAdminPanel;
    exports.AdminHeaderButton = AdminHeaderButton;
    exports.apply = apply;
    exports.inject = inject;
    exports.TAB_KIND = TAB_KIND;
    exports.HEADER_SLOT = HEADER_SLOT;
    return module.exports;
  },
});
