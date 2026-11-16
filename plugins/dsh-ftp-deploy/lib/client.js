/**
 * Kliens oldal: az „FTP" fül a jobb oldalsávban.
 *
 * Minden adat a host `/ftp/*` végpontjairól jön; a böngésző sosem lát FTP-jelszót,
 * és sosem indít folyamatot. A hosszú műveletek (deploy, ZIP-mentés) állapotát
 * 2 s-onként pollozzuk (`/ftp/status`), ugyanazzal a mintával, mint a Kiadás gomb.
 */
window.__ModuleLoader__.load({
  id: "dsh-ftp-deploy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    var TAB_ID = "dsh-ftp-deploy/ftp";
    var TAB_KIND = "ftp";
    var HEADER_SLOT = "conversation.session.header.utilities";
    var BODY_SLOT = "sidebar.right.pane.tab";
    var NS = "ftp";
    var POLL_MS = 2000;

    // ─── szótár ─────────────────────────────────────────────────────────
    var HU = {
      "tab.title": "FTP deploy",
      "tab.guide": "FTP feltöltés a tárhelyre: profil, előnézet, deploy, ZIP-mentés.",
      "header.title": "FTP deploy — a tárhelyre feltöltés (a Kiadás gomb előtt ez a szokásos lépés)",
      "common.ok": "OK",
      "common.refresh": "Frissítés",
      "common.host": "tárhely",
      "common.size": "méret",
      "common.files": "fájl",
      "common.blocked": "kizárt",
      "common.upload": "feltöltés",
      "common.delete": "törlés",
      "common.loading": "Betöltés…",
      "common.error": "Hiba",
      "common.none": "nincs",
      "profile.title": "Profil",
      "profile.select": "Profil választása",
      "profile.noneYet": "Még nincs FTP-profil ezen a gépen. Alul tudsz újat felvenni.",
      "profile.new": "Új profil",
      "profile.edit": "Profil szerkesztése",
      "profile.save": "Profil mentése",
      "profile.saved": "A profil mentve.",
      "profile.delete": "Profil törlése",
      "profile.full": "A profil teljes",
      "profile.include": "Mappák (vesszővel)",
      "profile.extra": "Extra (gitignore-olt) mappák",
      "profile.allow": "Engedélyezett kivételek (a tiltás alól)",
      "profile.tls": "TLS (FTPS)",
      "profile.id": "Azonosító",
      "profile.name": "Megnevezés",
      "profile.host": "Host",
      "profile.port": "Port",
      "profile.user": "FTP felhasználó",
      "profile.localRoot": "Helyi gyökér (projekt)",
      "profile.remoteRoot": "Távoli gyökér (pl. /web/laravel12)",
      "password.title": "Jelszó",
      "password.none": "Nincs mentett jelszó — a deploy nem tud indulni.",
      "password.saved": "Van mentett jelszó (titkosítva, DPAPI).",
      "password.placeholder": "FTP jelszó (nem jelenik meg újra)",
      "password.save": "Jelszó mentése",
      "password.savedOk": "A jelszó elmentve.",
      "test.run": "Kapcsolat tesztelése",
      "test.ok": "A kapcsolat rendben. Távoli mappa: {cwd}",
      "test.fail": "A kapcsolat nem jött létre: {error}",
      "preview.run": "Előnézet",
      "preview.empty": "Nincs feltöltendő vagy törlendő fájl — minden fent van.",
      "preview.needsBaseline": "Nincs kiindulópont. Először állítsd be, hogy a mostani git állapot MÁR fent van (különben a deploy a teljes fát feltöltené).",
      "preview.baseline": "A mostani git állapot már fent van",
      "preview.baselineOk": "Kiindulópont beállítva: {sha}",
      "preview.blockedNote": "{n} fájl kimarad (tiltó minta: .env, storage, vendor, node_modules, …)",
      "preview.large": "Nagy feltöltés: {n} fájl (a határ {limit}). A deploy gomb második kattintást kér.",
      "deploy.run": "FTP deploy",
      "deploy.running": "FTP deploy fut…",
      "deploy.confirmLarge": "Biztosan? {n} fájl, {size}. Kattints újra a feltöltéshez.",
      "deploy.done": "Kész: {uploaded} feltöltve, {deleted} törölve, {size} ({attempts}. próbálkozás).",
      "deploy.failed": "A deploy elbukott: {error}",
      "deploy.bnothing": "Nincs mit feltölteni.",
      "extra.run": "Extra feltöltés",
      "extra.preview": "Extra előnézet",
      "extra.none": "Ehhez a profilhoz nincs extra mappa beállítva.",
      "extra.empty": "Nincs feltöltendő extra fájl.",
      "remote.title": "Távoli mappa",
      "remote.path": "Távoli útvonal",
      "remote.list": "Listázás",
      "remote.empty": "Nincs almappa.",
      "backup.title": "Mentés (Lepuffantás)",
      "backup.full": "teljes",
      "backup.code": "csak kód",
      "backup.run": "ZIP-mentés indítása",
      "backup.done": "Kész: {files} fájl, {size} → {zip}",
      "backup.failed": "A mentés elbukott: {error}",
      "status.running": "Fut: {kind} · {phase} · {done}/{total}{current}",
      "status.done": "Legutóbbi művelet kész: {kind}",
      "status.failed": "Legutóbbi művelet hiba: {error}",
      "log.title": "Napló (utolsó sorok)",
      "log.empty": "A napló még üres.",
    };
    var EN = {
      "tab.title": "FTP deploy",
      "tab.guide": "Upload to the host over FTP: profile, preview, deploy, ZIP backup.",
      "header.title": "FTP deploy — upload to the host (the usual step before a release)",
      "common.ok": "OK",
      "common.refresh": "Refresh",
      "common.host": "host",
      "common.size": "size",
      "common.files": "files",
      "common.blocked": "blocked",
      "common.upload": "upload",
      "common.delete": "delete",
      "common.loading": "Loading…",
      "common.error": "Error",
      "common.none": "none",
      "profile.title": "Profile",
      "profile.select": "Choose a profile",
      "profile.noneYet": "No FTP profile on this machine yet. Add one below.",
      "profile.new": "New profile",
      "profile.edit": "Edit profile",
      "profile.save": "Save profile",
      "profile.saved": "Profile saved.",
      "profile.delete": "Delete profile",
      "profile.full": "Profile fields",
      "profile.include": "Folders (comma separated)",
      "profile.extra": "Extra (gitignored) folders",
      "profile.allow": "Allowed exceptions (over the deny list)",
      "profile.tls": "TLS (FTPS)",
      "profile.id": "Id",
      "profile.name": "Name",
      "profile.host": "Host",
      "profile.port": "Port",
      "profile.user": "FTP user",
      "profile.localRoot": "Local root (project)",
      "profile.remoteRoot": "Remote root (e.g. /web/laravel12)",
      "password.title": "Password",
      "password.none": "No saved password — the deploy cannot start.",
      "password.saved": "Password saved (encrypted, DPAPI).",
      "password.placeholder": "FTP password (never shown again)",
      "password.save": "Save password",
      "password.savedOk": "Password saved.",
      "test.run": "Test connection",
      "test.ok": "Connection OK. Remote directory: {cwd}",
      "test.fail": "Connection failed: {error}",
      "preview.run": "Preview",
      "preview.empty": "Nothing to upload or delete — everything is up to date.",
      "preview.needsBaseline": "No baseline yet. First mark the current git state as ALREADY deployed (otherwise the deploy would upload the whole tree).",
      "preview.baseline": "The current git state is already deployed",
      "preview.baselineOk": "Baseline set: {sha}",
      "preview.blockedNote": "{n} file(s) skipped (deny list: .env, storage, vendor, node_modules, …)",
      "preview.large": "Large upload: {n} files (limit {limit}). The deploy button asks for a second click.",
      "deploy.run": "FTP deploy",
      "deploy.running": "FTP deploy running…",
      "deploy.confirmLarge": "Sure? {n} files, {size}. Click again to upload.",
      "deploy.done": "Done: {uploaded} uploaded, {deleted} deleted, {size} (attempt {attempts}).",
      "deploy.failed": "Deploy failed: {error}",
      "deploy.bnothing": "Nothing to upload.",
      "extra.run": "Extra upload",
      "extra.preview": "Extra preview",
      "extra.none": "This profile has no extra folders configured.",
      "extra.empty": "No extra files to upload.",
      "remote.title": "Remote folder",
      "remote.path": "Remote path",
      "remote.list": "List",
      "remote.empty": "No subfolders.",
      "backup.title": "Backup (download)",
      "backup.full": "full",
      "backup.code": "code only",
      "backup.run": "Start ZIP backup",
      "backup.done": "Done: {files} files, {size} → {zip}",
      "backup.failed": "Backup failed: {error}",
      "status.running": "Running: {kind} · {phase} · {done}/{total}{current}",
      "status.done": "Last action finished: {kind}",
      "status.failed": "Last action failed: {error}",
      "log.title": "Log (last lines)",
      "log.empty": "The log is empty.",
    };

    // ─── segédek ────────────────────────────────────────────────────────
    function bytes(value) {
      var n = Number(value) || 0;
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(2) + " MB";
    }

    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (_match, key) {
        return values && key in values ? String(values[key]) : "–";
      });
    }

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

    function delJson(url) {
      return fetch(url, { method: "DELETE", headers: { Accept: "application/json" } }).then(function (response) {
        return response.json();
      });
    }

    var S = {
      row: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
      section: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.10)" },
      label: { opacity: 0.7, fontSize: "12px" },
      button: {
        border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))",
        borderRadius: "7px",
        background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(255,255,255,0.08))",
        color: "inherit",
        font: "inherit",
        padding: "3px 10px",
        cursor: "pointer",
      },
      buttonDim: {
        border: "1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.25))",
        borderRadius: "7px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        padding: "3px 10px",
        cursor: "not-allowed",
        opacity: 0.45,
      },
      input: {
        padding: "3px 7px",
        borderRadius: "6px",
        background: "transparent",
        color: "inherit",
        border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))",
        font: "inherit",
        minWidth: "90px",
      },
      code: { fontSize: "12px", opacity: 0.85 },
      pre: {
        margin: "4px 0 0",
        padding: "6px",
        maxHeight: "180px",
        overflow: "auto",
        fontSize: "11px",
        lineHeight: 1.35,
        background: "rgba(0,0,0,0.22)",
        borderRadius: "6px",
        whiteSpace: "pre-wrap",
      },
      err: { color: "#ffb4ab" },
      good: { color: "#86efac" },
    };

    // A fül-törzs slotja nem feltétlenül adja át az `inject`-ált propokat, ezért
    // a fordítót modul-szinten is eltesszük (az `apply` állítja be).
    var translator = function (key) { return key; };

    // ─── panel ──────────────────────────────────────────────────────────
    var FtpPanel = react.memo(function FtpPanel(props) {
      var t = props.t || translator;
      var state = react.useState({ status: "loading" });
      var data = state[0];
      var setData = state[1];

      var sel = react.useState("");
      var selectedId = sel[0];
      var setSelectedId = sel[1];

      var msgState = react.useState(null); // {kind: "ok"|"error", text}
      var message = msgState[0];
      var setMessage = msgState[1];

      var previewState = react.useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];

      var extraState = react.useState(null);
      var extra = extraState[0];
      var setExtra = extraState[1];

      var statusState = react.useState({ state: "none" });
      var status = statusState[0];
      var setStatus = statusState[1];

      var logState = react.useState([]);
      var logLines = logState[0];
      var setLogLines = logState[1];

      var remoteState = react.useState({ path: "/", dirs: null });
      var remote = remoteState[0];
      var setRemote = remoteState[1];

      var pwState = react.useState("");
      var passwordDraft = pwState[0];
      var setPasswordDraft = pwState[1];

      var editState = react.useState(null); // null = zárva, objektum = szerkesztés
      var draft = editState[0];
      var setDraft = editState[1];

      var modeState = react.useState("code");
      var backupMode = modeState[0];
      var setBackupMode = modeState[1];

      var bigState = react.useState(false); // nagy feltöltés megerősítése
      var confirmLarge = bigState[0];
      var setConfirmLarge = bigState[1];

      var profiles = data && data.status === "ready" ? data.profiles : [];
      var current = profiles.filter(function (p) { return p.id === selectedId; })[0] || null;
      var running = status && (status.state === "running" || status.inFlight === true);

      function loadProfiles() {
        return getJson("/ftp/profiles")
          .then(function (body) {
            if (!body || body.ok !== true) {
              setData({ status: "error", error: (body && body.error) || "?" });
              return;
            }
            setData({ status: "ready", profiles: body.profiles || [] });
            var list = body.profiles || [];
            if (list.length > 0) {
              setSelectedId(function (prev) {
                return list.some(function (p) { return p.id === prev; }) ? prev : list[0].id;
              });
            }
          })
          .catch(function (error) {
            setData({ status: "error", error: String(error && error.message ? error.message : error) });
          });
      }

      function loadStatus() {
        return getJson("/ftp/status")
          .then(function (body) {
            if (body && body.ok === true) setStatus(body);
          })
          .catch(function () {});
      }

      function loadLog() {
        return getJson("/ftp/log?lines=25")
          .then(function (body) {
            if (body && body.ok === true) setLogLines(body.log || []);
          })
          .catch(function () {});
      }

      react.useEffect(function () {
        loadProfiles();
        loadStatus();
        loadLog();
      }, []);

      // Futás közben 2 s-onként frissítünk; a végén egyszer (a napló és az előnézet miatt).
      react.useEffect(function () {
        if (!running) return undefined;
        var timer = setInterval(function () {
          loadStatus();
        }, POLL_MS);
        return function () { clearInterval(timer); };
      }, [running]);

      var wasRunning = react.useRef(false);
      react.useEffect(function () {
        if (running) wasRunning.current = true;
        if (!running && wasRunning.current) {
          wasRunning.current = false;
          loadStatus();
          loadLog();
          if (selectedId) refreshPreview(selectedId);
        }
      }, [running, selectedId]);

      react.useEffect(function () {
        setPreview(null);
        setExtra(null);
        setConfirmLarge(false);
      }, [selectedId]);

      function refreshPreview(id) {
        if (!id) return Promise.resolve();
        return getJson("/ftp/preview?id=" + encodeURIComponent(id))
          .then(function (body) {
            if (body && body.ok === true) setPreview(body);
            else setMessage({ kind: "error", text: (body && body.error) || "?" });
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: String(error.message || error) });
          });
      }

      function runTest() {
        if (!current) return;
        setMessage({ kind: "ok", text: t("common.loading") });
        getJson("/ftp/test?id=" + encodeURIComponent(current.id))
          .then(function (body) {
            if (body && body.ok === true) setMessage({ kind: "ok", text: fmt(t("test.ok"), { cwd: body.cwd || "/" }) });
            else setMessage({ kind: "error", text: fmt(t("test.fail"), { error: (body && body.error) || "?" }) });
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: fmt(t("test.fail"), { error: String(error.message || error) }) });
          });
      }

      function runBaseline() {
        if (!current) return;
        postJson("/ftp/baseline?id=" + encodeURIComponent(current.id))
          .then(function (body) {
            if (body && body.ok === true) {
              setMessage({ kind: "ok", text: fmt(t("preview.baselineOk"), { sha: String(body.lastDeploySha || "").slice(0, 7) }) });
              loadProfiles();
              refreshPreview(current.id);
            } else {
              setMessage({ kind: "error", text: (body && body.error) || "?" });
            }
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: String(error.message || error) });
          });
      }

      function startDeploy(forceLarge) {
        if (!current || !preview) return;
        var large = preview.files.length > preview.largeLimit;
        if (large && !forceLarge && !confirmLarge) {
          setConfirmLarge(true);
          return;
        }
        setConfirmLarge(false);
        var query =
          "/ftp/push?id=" + encodeURIComponent(current.id) +
          "&confirm=1" + (forceLarge ? "&forceLarge=1" : "");
        postJson(query)
          .then(function (body) {
            if (body && body.ok === true) {
              setMessage({ kind: "ok", text: t("deploy.running") });
              loadStatus();
            } else {
              setMessage({ kind: "error", text: fmt(t("deploy.failed"), { error: (body && body.error) || "?" }) });
            }
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: fmt(t("deploy.failed"), { error: String(error.message || error) }) });
          });
      }

      function startExtra() {
        if (!current) return;
        postJson("/ftp/push-extra?id=" + encodeURIComponent(current.id) + "&confirm=1")
          .then(function (body) {
            if (body && body.ok === true) {
              setMessage({ kind: "ok", text: t("deploy.running") });
              loadStatus();
            } else {
              setMessage({ kind: "error", text: fmt(t("deploy.failed"), { error: (body && body.error) || "?" }) });
            }
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: fmt(t("deploy.failed"), { error: String(error.message || error) }) });
          });
      }

      function startBackup() {
        if (!current) return;
        postJson("/ftp/backup?id=" + encodeURIComponent(current.id) + "&mode=" + backupMode)
          .then(function (body) {
            if (body && body.ok === true) loadStatus();
            else setMessage({ kind: "error", text: (body && body.error) || "?" });
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: String(error.message || error) });
          });
      }

      function savePassword() {
        if (!current || passwordDraft === "") return;
        postJson("/ftp/secret", { id: current.id, password: passwordDraft })
          .then(function (body) {
            if (body && body.ok === true) {
              setPasswordDraft("");
              setMessage({ kind: "ok", text: t("password.savedOk") });
              loadProfiles();
            } else {
              setMessage({ kind: "error", text: (body && body.error) || "?" });
            }
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: String(error.message || error) });
          });
      }

      function listRemote(path) {
        if (!current) return;
        getJson("/ftp/remote?id=" + encodeURIComponent(current.id) + "&path=" + encodeURIComponent(path || "/"))
          .then(function (body) {
            if (body && body.ok === true) setRemote({ path: body.path || path || "/", dirs: body.dirs || [] });
            else setMessage({ kind: "error", text: (body && body.error) || "?" });
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: String(error.message || error) });
          });
      }

      function beginEdit() {
        if (current) {
          setDraft({
            id: current.id, name: current.name, host: current.host, port: current.port, user: current.user,
            localRoot: current.localRoot, remoteRoot: current.remoteRoot,
            include: (current.include || []).join(", "),
            extraUpload: (current.extraUpload || []).join(", "),
            allow: (current.allow || []).join(", "),
            tls: Boolean(current.tls), extra: (current.extraUpload || []).join(", "),
          });
          return;
        }
        setDraft({
          id: "", name: "", host: "", port: 21, user: "", localRoot: "", remoteRoot: "",
          include: "app, config, resources, routes, public, .htaccess, index.php",
          extraUpload: "", allow: "", tls: false,
        });
      }

      function saveDraft() {
        if (!draft) return;
        var payload = {
          id: draft.id, name: draft.name, host: draft.host, port: Number(draft.port) || 21, user: draft.user,
          localRoot: draft.localRoot, remoteRoot: draft.remoteRoot,
          include: String(draft.include || "").split(","),
          extraUpload: String(draft.extraUpload || "").split(","),
          allow: String(draft.allow || "").split(","),
          tls: Boolean(draft.tls), passive: true,
        };
        postJson("/ftp/profile", payload)
          .then(function (body) {
            if (body && body.ok === true) {
              setDraft(null);
              setMessage({ kind: "ok", text: t("profile.saved") });
              setSelectedId(body.profile ? body.profile.id : draft.id);
              loadProfiles();
            } else {
              setMessage({ kind: "error", text: (body && body.error) || "?" });
            }
          })
          .catch(function (error) {
            setMessage({ kind: "error", text: String(error.message || error) });
          });
      }

      // ─── megjelenítés ────────────────────────────────────────────────
      function field(labelText, value, onChange, extra) {
        return h("label", { style: { ...S.row, gap: "4px" } },
          h("span", { style: S.label }, labelText),
          h("input", { style: S.input, value: value, onChange: function (event) { onChange(event.currentTarget.value); }, ...(extra || {}) }),
        );
      }

      function renderStatus() {
        if (!status || status.state === "none") return null;
        if (status.state === "running") {
          var pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
          return h("div", { style: { marginTop: "6px", opacity: 0.85 } },
            h("div", null, fmt(t("status.running"), {
              kind: status.kind || "?", phase: status.phase || "?", done: status.done || 0, total: status.total || 0,
              current: status.current ? " — " + String(status.current).slice(-60) : "",
            })),
            h("div", { style: { height: "6px", background: "rgba(255,255,255,0.12)", borderRadius: "4px", marginTop: "4px" } },
              h("div", { style: { width: pct + "%", height: "6px", background: "var(--dsw-alias-accent-solid, #60a5fa)", borderRadius: "4px" } })),
          );
        }
        if (status.state === "done" && status.result) {
          var r = status.result;
          var text = r.zipPath
            ? fmt(t("backup.done"), { files: r.files, size: bytes(r.bytes), zip: r.zipPath })
            : fmt(t("deploy.done"), { uploaded: r.uploaded, deleted: r.deleted, size: bytes(r.bytes), attempts: r.attempts });
          return h("div", { style: { ...S.good, marginTop: "6px" } }, text);
        }
        if (status.state === "failed") {
          return h("div", { style: { ...S.err, marginTop: "6px" } }, fmt(t("status.failed"), { error: status.error || "?" }));
        }
        return null;
      }

      function renderPreview() {
        if (!preview) return null;
        if (preview.needsBaseline) {
          return h("div", { style: { marginTop: "6px" } },
            h("div", null, t("preview.needsBaseline")),
            h("button", { type: "button", style: { ...S.button, marginTop: "6px" }, onClick: runBaseline }, t("preview.baseline")),
          );
        }
        var files = preview.files || [];
        var totalBytes = files.reduce(function (sum, f) { return sum + (Number(f.size) || 0); }, 0);
        return h("div", { style: { marginTop: "6px" } },
          h("div", { style: S.row },
            h("span", null, t("common.files") + ": " + files.length),
            h("span", { style: S.label }, "·"),
            h("span", null, t("common.size") + ": " + bytes(totalBytes)),
            preview.blocked && preview.blocked.length > 0
              ? h("span", { style: { ...S.label, marginLeft: "6px" }, title: preview.blocked.slice(0, 30).join("\n") },
                fmt(t("preview.blockedNote"), { n: preview.blocked.length }))
              : null,
          ),
          files.length === 0
            ? h("div", { style: S.label }, t("preview.empty"))
            : h("table", { style: { width: "100%", marginTop: "4px", borderCollapse: "collapse" } },
              h("tbody", null, files.slice(0, 60).map(function (file, index) {
                return h("tr", { key: index },
                  h("td", { style: { ...S.code, width: "66px", opacity: 0.8 } }, file.action === "delete" ? t("common.delete") : t("common.upload")),
                  h("td", { style: { ...S.code, wordBreak: "break-all" } }, file.path),
                  h("td", { style: { ...S.code, textAlign: "right", opacity: 0.7 } }, file.size ? bytes(file.size) : ""),
                );
              })),
            ),
          files.length > 60 ? h("div", { style: S.label }, "… +" + (files.length - 60)) : null,
          preview.large
            ? h("div", { style: { marginTop: "4px", color: "#fcd34d" } }, fmt(t("preview.large"), { n: files.length, limit: preview.largeLimit }))
            : null,
        );
      }

      function renderRemote() {
        return h("div", { style: S.section },
          h("div", { style: S.row },
            h("strong", null, t("remote.title")),
            h("span", { style: S.label }, t("remote.path")),
            h("input", {
              style: { ...S.input, minWidth: "180px" },
              value: remote.path,
              onChange: function (event) { setRemote({ path: event.currentTarget.value, dirs: remote.dirs }); },
            }),
            h("button", { type: "button", style: S.button, disabled: !current, onClick: function () { listRemote(remote.path); } }, t("remote.list")),
          ),
          remote.dirs === null
            ? null
            : remote.dirs.length === 0
              ? h("div", { style: S.label }, t("remote.empty"))
              : h("div", { style: { ...S.row, marginTop: "4px" } }, remote.dirs.map(function (dir) {
                var base = String(remote.path || "/").replace(/\/+$/, "");
                var next = (base === "" ? "" : base) + "/" + dir;
                return h("button", {
                  key: dir,
                  type: "button",
                  style: { ...S.button, padding: "1px 7px" },
                  onClick: function () { listRemote(next); },
                  title: next,
                }, dir);
              })),
        );
      }

      function renderProfileForm() {
        if (!draft) return null;
        return h("div", { style: S.section },
          h("div", { style: S.row },
            h("strong", null, t("profile.new")),
            h("button", { type: "button", style: { ...S.buttonDim, marginLeft: "auto" }, onClick: function () { setDraft(null); } }, "✕"),
          ),
          h("div", { style: { ...S.row, marginTop: "4px" } },
            field(t("profile.id"), draft.id, function (v) { setDraft({ ...draft, id: v }); }),
            field(t("profile.name"), draft.name, function (v) { setDraft({ ...draft, name: v }); }),
          ),
          h("div", { style: { ...S.row, marginTop: "4px" } },
            field(t("profile.host"), draft.host, function (v) { setDraft({ ...draft, host: v }); }),
            field(t("profile.port"), draft.port, function (v) { setDraft({ ...draft, port: v }); }, { style: { ...S.input, width: "70px" } }),
            field(t("profile.user"), draft.user, function (v) { setDraft({ ...draft, user: v }); }),
            h("label", { style: { ...S.row, gap: "4px" } },
              h("input", { type: "checkbox", checked: Boolean(draft.tls), onChange: function (event) { setDraft({ ...draft, tls: event.currentTarget.checked }); } }),
              t("profile.tls"),
            ),
          ),
          h("div", { style: { ...S.row, marginTop: "4px" } },
            field(t("profile.localRoot"), draft.localRoot, function (v) { setDraft({ ...draft, localRoot: v }); }, { style: { ...S.input, minWidth: "240px" } }),
            field(t("profile.remoteRoot"), draft.remoteRoot, function (v) { setDraft({ ...draft, remoteRoot: v }); }, { style: { ...S.input, minWidth: "160px" } }),
          ),
          h("div", { style: { ...S.row, marginTop: "4px" } },
            field(t("profile.include"), draft.include, function (v) { setDraft({ ...draft, include: v }); }, { style: { ...S.input, minWidth: "320px" } }),
          ),
          h("div", { style: { ...S.row, marginTop: "4px" } },
            field(t("profile.extra"), draft.extraUpload, function (v) { setDraft({ ...draft, extraUpload: v }); }, { style: { ...S.input, minWidth: "260px" } }),
            field(t("profile.allow"), draft.allow, function (v) { setDraft({ ...draft, allow: v }); }, { style: { ...S.input, minWidth: "200px" } }),
          ),
          h("div", { style: { ...S.row, marginTop: "6px" } },
            h("button", { type: "button", style: S.button, onClick: saveDraft }, t("profile.save")),
          ),
        );
      }

      if (data && data.status === "error") {
        return h("div", { style: { padding: "8px" } }, h("div", { style: S.err }, t("common.error") + ": " + data.error));
      }

      return h("div", { style: { padding: "8px", display: "flex", flexDirection: "column", gap: "2px", fontSize: "13px" } },
        // fejléc
        h("div", { style: S.row },
          h("strong", null, t("profile.title")),
          h("select", {
            style: { ...S.input, minWidth: "200px" },
            value: selectedId,
            onChange: function (event) { setSelectedId(event.currentTarget.value); },
          },
            profiles.length === 0
              ? h("option", { value: "" }, t("common.none"))
              : profiles.map(function (profile) {
                return h("option", { key: profile.id, value: profile.id }, profile.name || profile.id);
              }),
          ),
          h("button", { type: "button", style: S.button, onClick: loadProfiles }, t("common.refresh")),
          h("button", { type: "button", style: S.button, onClick: beginEdit }, current ? t("profile.edit") : t("profile.new")),
        ),

        // profil összefoglaló
        current
          ? h("div", { style: { ...S.row, marginTop: "2px" } },
            h("span", { style: S.code }, current.user + "@" + current.host + ":" + current.port),
            h("span", { style: S.label }, "→"),
            h("span", { style: S.code }, current.remoteRoot),
            h("span", { style: S.label }, "· " + t("common.files") + ": " + (current.include || []).length + " · " + (current.hasPassword ? "🔑" : "⚠")),
          )
          : h("div", { style: S.label }, t("profile.noneYet")),

        // üzenet
        message
          ? h("div", { style: message.kind === "error" ? { ...S.err, marginTop: "4px" } : { ...S.good, marginTop: "4px" } }, message.text)
          : null,

        // akciósor
        h("div", { style: { ...S.row, marginTop: "6px" } },
          h("button", { type: "button", style: current ? S.button : S.buttonDim, disabled: !current || running, onClick: runTest }, t("test.run")),
          h("button", { type: "button", style: current ? S.button : S.buttonDim, disabled: !current || running, onClick: function () { refreshPreview(current && current.id); } }, t("preview.run")),
          h("button", {
            type: "button",
            style: current && !running ? S.button : S.buttonDim,
            disabled: !current || running,
            onClick: function () { startDeploy(false); },
            title: confirmLarge ? fmt(t("deploy.confirmLarge"), { n: preview ? preview.files.length : 0, size: preview ? bytes(preview.files.reduce(function (s, f) { return s + (Number(f.size) || 0); }, 0)) : "" }) : "",
          }, running ? t("deploy.running") : confirmLarge ? fmt(t("deploy.confirmLarge"), {
            n: preview ? preview.files.length : 0,
            size: preview ? bytes(preview.files.reduce(function (s, f) { return s + (Number(f.size) || 0); }, 0)) : "",
          }) : t("deploy.run")),
        ),

        renderStatus(),
        renderPreview(),

        // jelszó
        h("div", { style: S.section },
          h("div", { style: S.row },
            h("strong", null, t("password.title")),
            h("span", { style: current && current.hasPassword ? S.good : { color: "#fcd34d" } }, current && current.hasPassword ? t("password.saved") : t("password.none")),
          ),
          h("div", { style: { ...S.row, marginTop: "4px" } },
            h("input", {
              type: "password",
              style: { ...S.input, minWidth: "220px" },
              placeholder: t("password.placeholder"),
              value: passwordDraft,
              onChange: function (event) { setPasswordDraft(event.currentTarget.value); },
            }),
            h("button", { type: "button", style: passwordDraft === "" ? S.buttonDim : S.button, disabled: passwordDraft === "" || !current, onClick: savePassword }, t("password.save")),
          ),
        ),

        // extra feltöltés
        current && (current.extraUpload || []).length > 0
          ? h("div", { style: S.section },
            h("div", { style: S.row },
              h("strong", null, t("extra.run")),
              h("span", { style: S.label }, (current.extraUpload || []).join(", ")),
            ),
            h("div", { style: { ...S.row, marginTop: "4px" } },
              h("button", {
                type: "button",
                style: S.button,
                disabled: running,
                onClick: function () {
                  getJson("/ftp/preview-extra?id=" + encodeURIComponent(current.id))
                    .then(function (body) {
                      if (body && body.ok === true) setExtra(body);
                      else setMessage({ kind: "error", text: (body && body.error) || "?" });
                    })
                    .catch(function (error) { setMessage({ kind: "error", text: String(error.message || error) }); });
                },
              }, t("extra.preview")),
              h("button", { type: "button", style: running ? S.buttonDim : S.button, disabled: running, onClick: startExtra }, t("extra.run")),
              extra ? h("span", { style: S.label }, t("common.files") + ": " + (extra.files || []).length + " · " + bytes(extra.bytes || 0)) : null,
            ),
            extra && (extra.files || []).length === 0 ? h("div", { style: S.label }, t("extra.empty")) : null,
          )
          : null,

        renderRemote(),

        // mentés
        h("div", { style: S.section },
          h("div", { style: S.row },
            h("strong", null, t("backup.title")),
            h("select", {
              style: S.input,
              value: backupMode,
              onChange: function (event) { setBackupMode(event.currentTarget.value); },
            },
              h("option", { value: "code" }, t("backup.code")),
              h("option", { value: "full" }, t("backup.full")),
            ),
            h("button", { type: "button", style: current && !running ? S.button : S.buttonDim, disabled: !current || running, onClick: startBackup }, t("backup.run")),
          ),
        ),

        // napló
        h("div", { style: S.section },
          h("div", { style: S.row },
            h("strong", null, t("log.title")),
            h("button", { type: "button", style: { ...S.button, marginLeft: "auto" }, onClick: loadLog }, t("common.refresh")),
          ),
          logLines.length === 0 ? h("div", { style: S.label }, t("log.empty")) : h("pre", { style: S.pre }, logLines.join("\n")),
        ),

        renderProfileForm(),
      );
    });

    // ─── fejléc-ikon ────────────────────────────────────────────────────
    function FtpHeaderButton(props) {
      var t = props.t || translator;
      return h("button", {
        type: "button",
        title: t("header.title"),
        "aria-label": t("tab.title"),
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          height: "26px",
          padding: "0 8px",
          borderRadius: "7px",
          border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          fontSize: "12px",
          cursor: "pointer",
        },
        onClick: function () { props.openTab(); },
      }, "⤴ FTP");
    }

    // ─── plugin ─────────────────────────────────────────────────────────
    const inject = ["slots", "locale", "sidebarRightTabs", "sidebarRight"];

    function apply(ctx) {
      ctx.locale.register(NS, { hu: HU, en: EN });
      var t = ctx.locale.bind(NS);
      translator = t;

      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: "extension",
            title: function () { return t("tab.title"); },
            guide: [
              {
                order: 91,
                title: function () { return t("tab.title"); },
                description: function () { return t("tab.guide"); },
              },
            ],
          });
        }, "ftp-deploy: tab type");

        ctx.effect(function () {
          return ctx.slots.inject(BODY_SLOT, function () {
            return ctx.slots.register(
              { name: BODY_SLOT, key: TAB_ID, inject: function () { return { t: t }; } },
              FtpPanel,
            );
          });
        }, "ftp-deploy: tab body");
      }

      var openTab = function () {
        try {
          if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === "function") ctx.sidebarRight.openTab(TAB_KIND);
        } catch (error) {
          /* az ikon ilyenkor sem tesz semmit */
        }
      };

      ctx.slots.inject(HEADER_SLOT, function () {
        return ctx.slots.register(
          {
            name: HEADER_SLOT,
            id: "ftp-deploy-header",
            order: 62,
            inject: function () { return { openTab: openTab, t: t }; },
          },
          FtpHeaderButton,
        );
      });
    }

    exports.name = "dsh-ftp-deploy";
    exports.apply = apply;
    exports.inject = inject;
    exports.FtpPanel = FtpPanel;
    return module.exports;
  },
});
