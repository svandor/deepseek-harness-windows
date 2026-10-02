/**
 * Házirobot — DSH kliens bővítmény (böngésző oldal).
 *
 *  - 🤖 gomb a beszélgetés eszközei között (CSAK ikon, a magyarázat tooltipben)
 *  - a gomb egy oldalra dokkolt PANELT nyit (nem lebegő ablak): teljes magasság,
 *    a képernyő széléhez simulva, mint a munkaterület-panelek
 *  - a panel fejlécében ⇄ gomb váltja a panelt jobb és bal oldal között
 *    (a választás localStorage-ban megmarad)
 *  - fülek: Állapot · Beállítások · Alteregók · Napló
 *
 * NYELV: a panel a DSH aktív nyelvét követi (magyar/angol). Nyilvános kiadáshoz
 * ez kell: a DSH felülete angolul is fut, és egy magyar feliratú panel ott
 * kilógna. A szótár ezért itt helyben él (mint a robot-panelben is).
 *
 * TÉMA: a panel a DSH világos/sötét témáját követi. Korábban fix sötét színeket
 * használt, ezért világos módban egy fekete téglalap maradt a fehér felületen.
 *
 * A host oldali route-okat a `dsh-hazi-robot/lib/index.js` szolgálja ki.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hazi-robot',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require('react');
    var h = react.createElement;

    var NS = 'hazi-robot';
    var inject = ['slots', 'locale', 'theme'];
    var SIDE_KEY = 'hazi-robot-side';

    /* --------------------------------- nyelv ---------------------------------- */

    /**
     * Az aktív nyelv azonosítója a locale szolgáltatásból.
     *
     * Több alakot is elfogadunk (sima string, `{active}`, `{id}`): a szolgáltatás
     * verziótól függően mást ad, és egy `[object Object]` miatt korábban már
     * rossz ágra került a nyelvváltás. Ha a szolgáltatás nem válaszol, a dokumentum
     * nyelve a második forrás (a DSH azt is beállítja).
     */
    function activeLocaleId(localeService) {
      try {
        var value = localeService.getLocale();
        if (typeof value === 'string') return value;
        if (value && typeof value.active === 'string') return value.active;
        if (value && typeof value.id === 'string') return value.id;
      } catch (error) { }
      try {
        if (typeof document !== 'undefined' && typeof document.documentElement.lang === 'string'
          && document.documentElement.lang !== '') {
          return document.documentElement.lang;
        }
      } catch (error) { }
      return 'hu';
    }

    function isHungarianLocaleId(id) {
      return String(id).toLowerCase().indexOf('hu') === 0;
    }

    /**
     * Az aktív nyelv, ÉLŐBEN: feliratkozunk, ha a szolgáltatás tudja, és
     * biztonsági hálóként ritkán lekérdezzük. Enélkül a panel a nyitás kori
     * nyelven maradna, amíg be nem zárják.
     */
    function useLocaleId(localeService) {
      var state = react.useState(function () { return activeLocaleId(localeService); });
      var localeId = state[0];
      var setLocaleId = state[1];

      react.useEffect(function () {
        var unsubscribe = null;
        try {
          if (localeService && typeof localeService.subscribe === 'function') {
            unsubscribe = localeService.subscribe(function () { setLocaleId(activeLocaleId(localeService)); });
          }
        } catch (error) { }
        var timer = setInterval(function () {
          var next = activeLocaleId(localeService);
          setLocaleId(function (prev) { return prev === next ? prev : next; });
        }, 3000);
        return function () {
          clearInterval(timer);
          if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (error) { } }
        };
      }, []);

      return localeId;
    }

    var I18N = {
      hu: {
        appName: 'Házirobot',
        openTitle: 'Házirobot — állapot és beállítások',
        tabStatus: 'Állapot',
        tabSettings: 'Beállítások',
        tabAlteregok: 'Alteregók',
        tabLog: 'Napló',
        flipTitle: 'Panel átváltása a másik oldalra (most: {side})',
        sideLeft: 'bal oldalon',
        sideRight: 'jobb oldalon',
        closeTitle: 'Panel bezárása',
        avatarTitleSwitch: 'Alteregó: {nev} — kattints a váltáshoz',
        avatarTitlePlain: 'Alteregó váltása',
        loading: 'Betöltés…',
        errorPrefix: 'Hiba: ',
        unknown: 'ismeretlen',

        emailSection: 'E-mail (a riportok kimenete)',
        fieldFrom: 'Feladó cím',
        fieldTo: 'Címzettek',
        hintComma: 'vesszővel elválasztva',
        smtpHost: 'SMTP host',
        smtpPort: 'Port',
        smtpTls: 'TLS',
        hintBool: 'false/true',
        smtpUser: 'SMTP felhasználó',
        smtpPassword: 'SMTP jelszó',
        dryRun: 'Száraz futás (nem küld e-mailt, csak fájlba ír)',

        farSection: 'FAR (résztvevő-adatszolgáltatás)',
        callbackUrl: 'Callback URL',
        notifyTo: 'Értesítési címek',
        hintCommaShort: 'vesszővel',
        farSecret: 'FAR callback titok',
        panelToken: 'Webhook panel-token',

        pagesSection: 'Konkurencia-figyelő: figyelt oldalak',
        pageName: 'Név',
        schedule: 'Ütemezés (cron: perc óra nap hónap hét-napja)',
        save: 'Beállítások mentése',
        saving: 'Mentés…',
        savedOk: 'Elmentve.',
        savedSecrets: ' Titok frissítve: {list}.',
        savedNoSecret: ' (Titkot nem írtál be.)',
        saveFailed: 'Mentés sikertelen: ',
        secretSet: '{label} — beállítva, üresen hagyva nem változik',
        secretUnset: '{label} — még nincs beállítva',
        secretsNote: 'A titkok a bot/secrets.json fájlba kerülnek (a .gitignore-ban), és soha nem kerülnek vissza a böngészőbe.',

        jobs: 'Jobok',
        run: 'futtat',
        started: 'elindítva',
        lastRuns: 'Utolsó futások',
        colJob: 'job',
        colStart: 'kezdés',
        colStatus: 'állapot',
        farLog: 'FAR-napló (audit)',
        colTime: 'idő',
        colJelentkezes: 'jelentkezés',
        colPhase: 'fázis',
        colSigma: 'Σ',

        noLog: 'nincs még napló',

        avatarList: 'Alteregó — kattints a választáshoz ({n} db)',
        autoSwitch: 'Automatikus váltogatás',
        autoNote: 'A választás a bot/config.json-ba kerül (avatarAlterego), ezért a robot-panel (4180) és ez a panel ugyanazt mutatja.',
        autoOff: 'kikapcsolva',
        unitSec: 'másodperc',
        unitMin: 'perc',
        unitHour: 'óra',
        missingSvg: 'Hiányzó SVG: ',
        listError: 'Az alteregó-lista nem érhető el: {error}',
        listErrorHint: 'Az alteregó-lista nem érhető el ({error}). Ha a bővítmény host fele most frissült, '
          + 'a DSH szerver újraindítása kell hozzá — addig a robot-panel (http://127.0.0.1:4180/) már mutatja az alteregókat.',
      },
      en: {
        appName: 'House robot',
        openTitle: 'House robot — status and settings',
        tabStatus: 'Status',
        tabSettings: 'Settings',
        tabAlteregok: 'Alter egos',
        tabLog: 'Log',
        flipTitle: 'Move the panel to the other side (now: {side})',
        sideLeft: 'on the left',
        sideRight: 'on the right',
        closeTitle: 'Close the panel',
        avatarTitleSwitch: 'Alter ego: {nev} — click to switch',
        avatarTitlePlain: 'Switch alter ego',
        loading: 'Loading…',
        errorPrefix: 'Error: ',
        unknown: 'unknown',

        emailSection: 'E-mail (where the reports go)',
        fieldFrom: 'From address',
        fieldTo: 'Recipients',
        hintComma: 'comma separated',
        smtpHost: 'SMTP host',
        smtpPort: 'Port',
        smtpTls: 'TLS',
        hintBool: 'false/true',
        smtpUser: 'SMTP user',
        smtpPassword: 'SMTP password',
        dryRun: 'Dry run (sends no e-mail, only writes to a file)',

        farSection: 'FAR (participant data service)',
        callbackUrl: 'Callback URL',
        notifyTo: 'Notification addresses',
        hintCommaShort: 'comma separated',
        farSecret: 'FAR callback secret',
        panelToken: 'Webhook panel token',

        pagesSection: 'Concurrency watch: monitored pages',
        pageName: 'Name',
        schedule: 'Schedule (cron: minute hour day month weekday)',
        save: 'Save settings',
        saving: 'Saving…',
        savedOk: 'Saved.',
        savedSecrets: ' Secret updated: {list}.',
        savedNoSecret: ' (No secret was entered.)',
        saveFailed: 'Save failed: ',
        secretSet: '{label} — set; leaving it empty keeps it unchanged',
        secretUnset: '{label} — not set yet',
        secretsNote: 'Secrets go into bot/secrets.json (git-ignored) and are never sent back to the browser.',

        jobs: 'Jobs',
        run: 'run',
        started: 'started',
        lastRuns: 'Recent runs',
        colJob: 'job',
        colStart: 'started',
        colStatus: 'status',
        farLog: 'FAR log (audit)',
        colTime: 'time',
        colJelentkezes: 'application',
        colPhase: 'phase',
        colSigma: 'Σ',

        noLog: 'no log yet',

        avatarList: 'Alter ego — click to select ({n})',
        autoSwitch: 'Automatic switching',
        autoNote: 'The choice is written into bot/config.json (avatarAlterego), so the robot panel (4180) and this panel show the same one.',
        autoOff: 'off',
        unitSec: 'seconds',
        unitMin: 'minutes',
        unitHour: 'hours',
        missingSvg: 'Missing SVG: ',
        listError: 'The alter ego list is unavailable: {error}',
        listErrorHint: 'The alter ego list is unavailable ({error}). If the host side of the plugin was just updated, '
          + 'the DSH server must be restarted — until then the robot panel (http://127.0.0.1:4180/) already shows the alter egos.',
      },
    };

    /** Egy nyelv szótára, `hu` tartalék. */
    function translator(localeId) {
      var table = isHungarianLocaleId(localeId) ? I18N.hu : I18N.en;
      return function t(key, params) {
        var text = table[key];
        if (text === undefined) text = I18N.hu[key];
        if (text === undefined) return key;
        if (params) {
          Object.keys(params).forEach(function (name) {
            text = text.split('{' + name + '}').join(String(params[name]));
          });
        }
        return text;
      };
    }

    /* --------------------------- fázis (hero/aktív) --------------------------- */

    function readConversationPhase() {
      try {
        var anchor = document.querySelector('[data-conversation-scroll]');
        var node = anchor === null || anchor === undefined ? null : anchor.closest('[data-phase]');
        if (node !== null && node !== undefined) {
          var value = node.getAttribute('data-phase');
          if (typeof value === 'string' && value !== '') return value;
        }
        var candidates = document.querySelectorAll('[data-phase]');
        for (var i = 0; i < candidates.length; i++) {
          var candidate = candidates[i].getAttribute('data-phase');
          if (candidate === 'hero' || candidate === 'active' || candidate === 'settling') return candidate;
        }
      } catch (error) {
        /* nincs még document: a hívó a "nem hero" ágat veszi */
      }
      return null;
    }

    function useConversationPhase() {
      var state = react.useState(readConversationPhase);
      var phase = state[0];
      var setPhase = state[1];
      react.useEffect(function () {
        try {
          var observer = new MutationObserver(function () { setPhase(readConversationPhase()); });
          observer.observe(document.body, { attributes: true, attributeFilter: ['data-phase'], subtree: true });
          setPhase(readConversationPhase());
          return function () { observer.disconnect(); };
        } catch (error) {
          return undefined;
        }
      }, []);
      return phase;
    }

    function phaseServesView(heroVariant, phase) {
      return heroVariant === true ? phase === 'hero' : phase !== 'hero';
    }

    /* --------------------------------- téma ----------------------------------- */

    /**
     * Sötét-e a DSH témája?
     *
     * ELSŐDLEGES a DOM: a DSH a `<body data-ds-dark-theme>` jelöléssel adja meg a
     * MÁR feloldott témát (a `system` beállítást is feloldva), és ez az, amit a
     * felhasználó lát. A szolgáltatás csak tartalék: ott a `preference` lehet
     * `system` is, amit a rendszer-beállításból kell feloldani.
     */
    function readDark(themeService) {
      try {
        if (typeof document !== 'undefined' && document.body && document.body.hasAttribute) {
          return document.body.hasAttribute('data-ds-dark-theme');
        }
      } catch (error) { }
      try {
        var snapshot = themeService.getTheme();
        var value = snapshot
          ? (typeof snapshot.preference === 'string' ? snapshot.preference : snapshot.id)
          : null;
        if (value === 'system') {
          return !!(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
        }
        if (typeof value === 'string' && value.length > 0) return value !== 'light';
      } catch (error) { }
      return true;
    }

    /**
     * A téma élőben: a DSH fejléc gombja is átválthatja, amíg a panel nyitva van.
     * A body jelölésére figyelünk (az pontos), és ritkán lekérdezünk is — ha a
     * MutationObserver nem indul el, a panel akkor sem ragad be a régi témába.
     */
    function useDarkTheme(themeService) {
      var state = react.useState(function () { return readDark(themeService); });
      var dark = state[0];
      var setDark = state[1];

      var sync = function () {
        var next = readDark(themeService);
        setDark(function (prev) { return prev === next ? prev : next; });
      };

      react.useEffect(function () {
        var observer = null;
        try {
          observer = new MutationObserver(sync);
          observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        } catch (error) { }
        var timer = setInterval(sync, 3000);
        return function () {
          clearInterval(timer);
          if (observer) { try { observer.disconnect(); } catch (error) { } }
        };
      }, []);

      return dark;
    }

    var DARK = {
      bg: '#151a21',
      deep: '#0f1216',
      border: '#2a3541',
      text: '#e7ecf1',
      dim: '#8b98a8',
      ok: '#4ade80',
      warn: '#fbbf24',
      err: '#f87171',
      accent: '#22303f',
      hover: '#1b2530',
      line: '#1e2530',
      shadow: 'rgba(0,0,0,.45)',
    };

    var LIGHT = {
      bg: '#ffffff',
      deep: '#f2f5f9',
      border: '#d3dae3',
      text: '#1b2430',
      dim: '#5b6878',
      ok: '#15803d',
      warn: '#b45309',
      err: '#b91c1c',
      accent: '#e8eef5',
      hover: '#eef2f7',
      line: '#e4e9ef',
      shadow: 'rgba(15,23,42,.18)',
    };

    /**
     * A paletta és a stílusok a TÉMÁTÓL függenek, ezért modulszintű, újraszámolt
     * értékek: minden komponens a render idején olvassa őket, így a témaváltás
     * (a panel újrarenderelése) mindenhol átszínezi a felületet.
     */
    var C = DARK;
    var S = null;

    function buildStyles(C) {
      return {
        button: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '26px', height: '26px', padding: 0, fontSize: '15px', lineHeight: 1,
          background: 'transparent', color: 'inherit', border: '1px solid ' + C.border,
          borderRadius: '6px', cursor: 'pointer',
        },
        panel: function (side) {
          return {
            position: 'fixed', top: 0, bottom: 0, width: 'min(400px, 92vw)',
            [side === 'left' ? 'left' : 'right']: 0,
            background: C.bg, color: C.text, borderLeft: side === 'left' ? 'none' : '1px solid ' + C.border,
            borderRight: side === 'left' ? '1px solid ' + C.border : 'none',
            boxShadow: side === 'left' ? '10px 0 28px ' + C.shadow : '-10px 0 28px ' + C.shadow,
            zIndex: 9000, display: 'flex', flexDirection: 'column', fontSize: '13px',
          };
        },
        header: {
          display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px',
          borderBottom: '1px solid ' + C.border, background: C.deep, flex: '0 0 auto',
        },
        title: { flex: 1, fontWeight: 600, fontSize: '13px' },
        iconBtn: {
          background: 'transparent', color: C.dim, border: '1px solid ' + C.border,
          borderRadius: '6px', cursor: 'pointer', padding: '2px 7px', fontSize: '12px', lineHeight: 1.4,
        },
        tabs: { display: 'flex', gap: '4px', padding: '8px 10px 0', flex: '0 0 auto' },
        tab: { padding: '4px 10px', borderRadius: '6px 6px 0 0', cursor: 'pointer', color: C.dim, border: '1px solid transparent', borderBottom: 'none', fontSize: '12px' },
        tabActive: { color: C.text, background: C.accent, borderColor: C.border },
        body: { padding: '10px 12px', overflowY: 'auto', flex: '1 1 auto' },
        row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '4px 0', borderBottom: '1px solid ' + C.line },
        input: { width: '100%', background: C.deep, color: C.text, border: '1px solid ' + C.border, borderRadius: '6px', padding: '5px 8px', fontSize: '12px' },
        label: { display: 'block', color: C.dim, fontSize: '11px', margin: '8px 0 3px' },
        primary: { background: '#2b6cb0', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', cursor: 'pointer', fontSize: '12px' },
        small: { background: C.accent, color: C.text, border: '1px solid ' + C.border, borderRadius: '5px', padding: '2px 7px', cursor: 'pointer', fontSize: '11px' },
        table: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' },
        th: { textAlign: 'left', color: C.dim, fontWeight: 600, padding: '3px 5px', borderBottom: '1px solid ' + C.border },
        td: { padding: '3px 5px', borderBottom: '1px solid ' + C.line },
      };
    }

    S = buildStyles(C);

    /** A témát beállítja, és újraszámolja a belőle származó stílusokat. */
    function applyTheme(dark) {
      C = dark ? DARK : LIGHT;
      S = buildStyles(C);
    }

    function colorFor(status) {
      if (status === 'ok' || status === 'hitelesitve' || status === 'nincs-valtozas') return C.ok;
      if (status === 'hiba' || status === 'IMPORT_HIBA' || status === 'RECONCILE_FAIL') return C.err;
      return C.warn;
    }

    function shortTime(value) {
      try {
        return String(value).slice(0, 16).replace('T', ' ');
      } catch (error) {
        return String(value);
      }
    }

    function readSide() {
      try {
        var stored = window.localStorage.getItem(SIDE_KEY);
        if (stored === 'left' || stored === 'right') return stored;
      } catch (error) { }
      return 'right';
    }

    /* ------------------------------- beállítások ------------------------------ */

    function Field(props) {
      return h('div', null,
        h('label', { style: S.label }, props.label + (props.hint ? '  (' + props.hint + ')' : '')),
        h('input', {
          style: S.input,
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          onChange: function (event) { props.onChange(event.target.value); },
        }),
      );
    }

    function SettingsTab(props) {
      var t = props.t;
      var state = react.useState(null);
      var form = state[0];
      var setForm = state[1];
      var msgState = react.useState('');
      var message = msgState[0];
      var setMessage = msgState[1];
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      react.useEffect(function () {
        fetch('/hazi-robot/settings')
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.ok) { setMessage(t('errorPrefix') + data.error); return; }
            setForm({
              email: {
                from: data.settings.email.from,
                to: data.settings.email.to,
                dryRun: data.settings.email.dryRun,
                smtp: Object.assign({}, data.settings.email.smtp),
              },
              far: Object.assign({}, data.settings.far),
              oldalak: (data.settings.oldalak || [])
                .concat([{ nev: '', url: '' }, { nev: '', url: '' }, { nev: '', url: '' }])
                .slice(0, Math.max(3, data.settings.oldalak.length + 1)),
              jobSchedule: data.settings.jobSchedule,
              secrets: { smtpPassword: '', farCallbackSecret: '', panelToken: '' },
              secretsSet: data.secretsSet || {},
            });
          })
          .catch(function (error) { setMessage(t('errorPrefix') + error.message); });
      }, []);

      if (!form) return h('div', { style: S.body }, message || t('loading'));

      var set = function (patch) { setForm(Object.assign({}, form, patch)); };
      var setEmail = function (patch) { set({ email: Object.assign({}, form.email, patch) }); };
      var setSmtp = function (patch) { setEmail({ smtp: Object.assign({}, form.email.smtp, patch) }); };
      var setFar = function (patch) { set({ far: Object.assign({}, form.far, patch) }); };
      var setSecret = function (key, value) { set({ secrets: Object.assign({}, form.secrets, { [key]: value }) }); };
      var setPage = function (index, patch) {
        var next = form.oldalak.slice();
        next[index] = Object.assign({}, next[index], patch);
        set({ oldalak: next });
      };

      var save = function () {
        setBusy(true);
        setMessage('');
        fetch('/hazi-robot/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: form.email,
            far: form.far,
            oldalak: form.oldalak.filter(function (p) { return p.url; }),
            jobSchedule: form.jobSchedule,
            secrets: form.secrets,
          }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            setBusy(false);
            if (!data.ok) { setMessage(t('saveFailed') + data.error); return; }
            var saved = (data.savedSecrets || []).length;
            setMessage(t('savedOk') + (saved ? t('savedSecrets', { list: data.savedSecrets.join(', ') }) : t('savedNoSecret')));
          })
          .catch(function (error) { setBusy(false); setMessage(t('saveFailed') + error.message); });
      };

      var secretHint = function (key, label) {
        return form.secretsSet[key] ? t('secretSet', { label: label }) : t('secretUnset', { label: label });
      };

      return h('div', { style: S.body },
        h('div', { style: S.label }, t('emailSection')),
        h(Field, { label: t('fieldFrom'), value: form.email.from, onChange: function (v) { setEmail({ from: v }); } }),
        h(Field, { label: t('fieldTo'), hint: t('hintComma'), value: form.email.to, onChange: function (v) { setEmail({ to: v }); } }),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('div', { style: { flex: 1 } }, h(Field, { label: t('smtpHost'), value: form.email.smtp.host, onChange: function (v) { setSmtp({ host: v }); } })),
          h('div', { style: { width: '80px' } }, h(Field, { label: t('smtpPort'), value: form.email.smtp.port, onChange: function (v) { setSmtp({ port: v }); } })),
          h('div', { style: { width: '100px' } }, h(Field, { label: t('smtpTls'), hint: t('hintBool'), value: form.email.smtp.secure, onChange: function (v) { setSmtp({ secure: v }); } })),
        ),
        h(Field, { label: t('smtpUser'), value: form.email.smtp.user, onChange: function (v) { setSmtp({ user: v }); } }),
        h(Field, { label: secretHint('smtpPassword', t('smtpPassword')), type: 'password', value: form.secrets.smtpPassword, onChange: function (v) { setSecret('smtpPassword', v); } }),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '10px 0 0', fontSize: '12px' } },
          h('input', { type: 'checkbox', checked: form.email.dryRun === true, onChange: function (e) { setEmail({ dryRun: e.target.checked }); } }),
          t('dryRun'),
        ),

        h('div', { style: Object.assign({}, S.label, { marginTop: '16px' }) }, t('farSection')),
        h(Field, { label: t('callbackUrl'), value: form.far.callbackUrl, onChange: function (v) { setFar({ callbackUrl: v }); } }),
        h(Field, { label: t('notifyTo'), hint: t('hintCommaShort'), value: form.far.ertesitesTo, onChange: function (v) { setFar({ ertesitesTo: v }); } }),
        h(Field, { label: secretHint('farCallbackSecret', t('farSecret')), type: 'password', value: form.secrets.farCallbackSecret, onChange: function (v) { setSecret('farCallbackSecret', v); } }),
        h(Field, { label: secretHint('panelToken', t('panelToken')), type: 'password', value: form.secrets.panelToken, onChange: function (v) { setSecret('panelToken', v); } }),

        h('div', { style: Object.assign({}, S.label, { marginTop: '16px' }) }, t('pagesSection')),
        form.oldalak.map(function (page, index) {
          return h('div', { key: index, style: { display: 'flex', gap: '6px', marginBottom: '4px' } },
            h('input', { style: Object.assign({}, S.input, { width: '36%' }), placeholder: t('pageName'), value: page.nev, onChange: function (e) { setPage(index, { nev: e.target.value }); } }),
            h('input', { style: S.input, placeholder: 'https://…', value: page.url, onChange: function (e) { setPage(index, { url: e.target.value }); } }),
          );
        }),
        h(Field, { label: t('schedule'), value: form.jobSchedule, onChange: function (v) { set({ jobSchedule: v }); } }),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px', flexWrap: 'wrap' } },
          h('button', { style: S.primary, onClick: save, disabled: busy }, busy ? t('saving') : t('save')),
          message ? h('span', { style: { color: message.indexOf(t('saveFailed')) === 0 ? C.err : C.ok, fontSize: '12px' } }, message) : null,
        ),
        h('div', { style: { color: C.dim, fontSize: '11px', marginTop: '10px' } },
          t('secretsNote')),
      );
    }

    /* -------------------------------- állapot fül ----------------------------- */

    function StatusTab(props) {
      var t = props.t;
      var state = react.useState(null);
      var data = state[0];
      var setData = state[1];
      var msgState = react.useState('');
      var message = msgState[0];
      var setMessage = msgState[1];

      var load = function () {
        fetch('/hazi-robot/status')
          .then(function (r) { return r.json(); })
          .then(setData)
          .catch(function (error) { setMessage(error.message); });
      };
      react.useEffect(function () {
        load();
        var timer = setInterval(load, 20000);
        return function () { clearInterval(timer); };
      }, []);

      if (!data) return h('div', { style: S.body }, t('loading'));
      if (!data.ok) return h('div', { style: S.body }, t('errorPrefix') + (data.error || t('unknown')));

      var run = function (id) {
        fetch('/hazi-robot/run?job=' + encodeURIComponent(id), { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (res) { setMessage(res.message || (res.ok ? t('started') : res.error)); setTimeout(load, 1500); });
      };

      return h('div', { style: S.body },
        h('div', { style: S.label }, t('jobs')),
        (data.jobs || []).map(function (job) {
          return h('div', { key: job.id, style: S.row },
            h('div', null,
              h('div', null, job.id),
              h('div', { style: { color: C.dim, fontSize: '11px' } },
                job.leiras + '  ·  ' + ((job.schedule && (job.schedule.kifejezes || job.schedule.tipus)) || '-')),
            ),
            h('button', { style: S.small, onClick: function () { run(job.id); } }, t('run')),
          );
        }),
        message ? h('div', { style: { color: C.ok, fontSize: '11px', margin: '6px 0' } }, message) : null,

        h('div', { style: Object.assign({}, S.label, { marginTop: '12px' }) }, t('lastRuns')),
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, t('colJob')), h('th', { style: S.th }, t('colStart')), h('th', { style: S.th }, t('colStatus')))),
          h('tbody', null, (data.runs || []).map(function (r) {
            return h('tr', { key: r.id },
              h('td', { style: S.td }, r.job_id),
              h('td', { style: S.td }, shortTime(r.started_at)),
              h('td', { style: Object.assign({}, S.td, { color: colorFor(r.status) }) }, r.status),
            );
          })),
        ),

        h('div', { style: Object.assign({}, S.label, { marginTop: '12px' }) }, t('farLog')),
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, t('colTime')), h('th', { style: S.th }, t('colJelentkezes')), h('th', { style: S.th }, t('colPhase')),
            h('th', { style: S.th }, t('colSigma')), h('th', { style: S.th }, t('colStatus')))),
          h('tbody', null, (data.far || []).map(function (l) {
            return h('tr', { key: l.id },
              h('td', { style: S.td }, shortTime(l.ts)),
              h('td', { style: S.td }, String(l.jelentkezes_id || '')),
              h('td', { style: S.td }, String(l.fazis || '')),
              h('td', { style: S.td }, (l.sigma_before === null ? '?' : l.sigma_before) + '→' + (l.sigma_after === null ? '?' : l.sigma_after)),
              h('td', { style: Object.assign({}, S.td, { color: colorFor(l.status) }) }, l.status),
            );
          })),
        ),
        data.stateError ? h('div', { style: { color: C.warn, fontSize: '11px', marginTop: '8px' } }, data.stateError) : null,
      );
    }

    function LogTab(props) {
      var t = props.t;
      var state = react.useState([]);
      var lines = state[0];
      var setLines = state[1];
      react.useEffect(function () {
        var load = function () {
          fetch('/hazi-robot/log?lines=80')
            .then(function (r) { return r.json(); })
            .then(function (data) { if (data.ok) setLines(data.lines); })
            .catch(function () { });
        };
        load();
        var timer = setInterval(load, 10000);
        return function () { clearInterval(timer); };
      }, []);
      return h('div', { style: S.body },
        h('div', { style: { fontFamily: 'Consolas, monospace', fontSize: '11px', whiteSpace: 'pre-wrap', color: C.dim } },
          (lines || []).join('\n') || t('noLog')),
      );
    }

    /* -------------------------------- alteregók ------------------------------- */

    /**
     * Az alteregó-állapot a hostról jön (`/hazi-robot/alteregok`), mert a
     * választás a bot/config.json-ban él — így a robot-panel (4180) és ez a
     * panel ugyanazt az avatart mutatja.
     */
    function useAlterego(t) {
      var state = react.useState(null);
      var data = state[0];
      var setData = state[1];
      var errState = react.useState('');
      var error = errState[0];
      var setError = errState[1];

      var load = function () {
        fetch('/hazi-robot/alteregok')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) { setData(d); setError(''); return; }
            setError(t('listError', { error: (d && d.error) || t('unknown') }));
          })
          .catch(function (err) {
            setError(t('listErrorHint', { error: err.message }));
          });
      };
      react.useEffect(function () { load(); }, []);

      var save = function (patch) {
        fetch('/hazi-robot/alterego', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d && d.ok) setData(d); })
          .catch(function () { /* a helyi váltás így is megtörtént */ });
      };

      var pick = function (id) {
        setData(function (prev) { return prev ? Object.assign({}, prev, { aktiv: id }) : prev; });
        save({ aktiv: id });
      };
      var setAuto = function (seconds) {
        setData(function (prev) { return prev ? Object.assign({}, prev, { auto: seconds }) : prev; });
        save({ auto: seconds });
      };

      // Automatikus váltogatás: körben, a katalógus sorrendjében.
      react.useEffect(function () {
        if (!data || !data.auto || !data.lista || data.lista.length < 2) return undefined;
        var timer = setInterval(function () {
          setData(function (prev) {
            if (!prev || !prev.lista || prev.lista.length < 2) return prev;
            var index = -1;
            for (var k = 0; k < prev.lista.length; k++) if (prev.lista[k].id === prev.aktiv) index = k;
            var next = prev.lista[(index + 1) % prev.lista.length];
            if (!next) return prev;
            return Object.assign({}, prev, { aktiv: next.id, aktivNev: next.nev });
          });
        }, data.auto * 1000);
        return function () { clearInterval(timer); };
      }, [data]);

      return { data: data, error: error, pick: pick, setAuto: setAuto, reload: load };
    }

    /**
     * A választék felirata. A 2 órás érték is "2 óra" (nem "120 perc"), ezért
     * kell a harmadik ág — a legördülő a szerverről kapott másodperceket kapja.
     */
    function autoLabel(seconds, t) {
      if (seconds === 0) return t('autoOff');
      if (seconds < 60) return seconds + ' ' + t('unitSec');
      if (seconds < 3600) return (seconds / 60) + ' ' + t('unitMin');
      return (seconds / 3600) + ' ' + t('unitHour');
    }

    function AlteregokTab(props) {
      var av = props.av;
      var t = props.t;
      if (!av.data) {
        return h('div', { style: S.body },
          av.error
            ? h('div', { style: { color: C.warn, fontSize: '12px', lineHeight: 1.5 } }, av.error)
            : t('loading'));
      }
      var d = av.data;

      var cardStyle = function (id) {
        var active = id === d.aktiv;
        return {
          cursor: 'pointer', textAlign: 'center', padding: '6px 4px', borderRadius: '8px',
          border: '1px solid ' + (active ? C.ok : C.border),
          background: active ? C.hover : C.deep,
        };
      };

      return h('div', { style: S.body },
        h('div', { style: S.label }, t('avatarList', { n: d.lista.length })),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' } },
          d.lista.map(function (item) {
            return h('div', {
              key: item.id,
              style: cardStyle(item.id),
              title: item.nev + ' — ' + item.ihlet + ' · ' + item.mozgas,
              onClick: function () { av.pick(item.id); },
            },
              h('img', {
                src: '/hazi-robot/avatar.svg?alterego=' + encodeURIComponent(item.id),
                width: 52, height: 69, alt: item.nev,
                style: { display: 'block', margin: '0 auto' },
              }),
              h('div', { style: { fontSize: '11px', marginTop: '4px', fontWeight: item.id === d.aktiv ? 600 : 400 } }, item.nev),
              h('div', { style: { color: C.dim, fontSize: '9.5px', lineHeight: 1.2 } }, item.alcim),
            );
          })),
        h('div', { style: Object.assign({}, S.label, { marginTop: '14px' }) }, t('autoSwitch')),
        h('select', {
          value: String(d.auto),
          style: S.input,
          onChange: function (event) { av.setAuto(Number(event.target.value)); },
        }, (d.autoValasztak || [0]).map(function (seconds) {
          return h('option', { key: seconds, value: String(seconds) }, autoLabel(seconds, t));
        })),
        h('div', { style: { color: C.dim, fontSize: '11px', marginTop: '8px' } },
          // A kiválasztott időköz maga a legördülő értéke — nincs külön
          // "most X-ként körbeváltanak" sor, az csak megkettőzte volna.
          t('autoNote'),
        ),
        (d.hianyzo && d.hianyzo.length)
          ? h('div', { style: { color: C.warn, fontSize: '11px', marginTop: '6px' } }, t('missingSvg') + d.hianyzo.join(', '))
          : null,
      );
    }

    /* ---------------------------------- panel --------------------------------- */

    function RobotPanel(props) {
      var localeId = useLocaleId(props.locale);
      var t = translator(localeId);
      var dark = useDarkTheme(props.theme);
      // A paletta a render ELŐTT frissül, hogy a stílusok már a helyes téma
      // szerint szülessenek (a modulszintű C/S-t minden komponens innen olvassa).
      applyTheme(dark);

      var tabState = react.useState('status');
      var tab = tabState[0];
      var setTab = tabState[1];
      var sideState = react.useState(readSide);
      var side = sideState[0];
      var setSide = sideState[1];

      var flip = function () {
        var next = side === 'left' ? 'right' : 'left';
        setSide(next);
        try { window.localStorage.setItem(SIDE_KEY, next); } catch (error) { }
      };

      var av = useAlterego(t);
      var aktivId = av.data ? av.data.aktiv : null;
      var avatarSrc = '/hazi-robot/avatar.svg' + (aktivId ? '?alterego=' + encodeURIComponent(aktivId) : '');
      var aktivNev = av.data ? av.data.aktivNev : '';

      var tabStyle = function (name) { return Object.assign({}, S.tab, tab === name ? S.tabActive : {}); };
      var sideLabel = side === 'left' ? t('sideLeft') : t('sideRight');

      return h('div', { style: S.panel(side), 'data-hazi-robot': 'panel', 'data-side': side, 'data-theme': dark ? 'dark' : 'light' },
        h('div', { style: S.header },
          h('img', {
            src: avatarSrc,
            width: 26, height: 34, alt: t('appName'),
            title: aktivNev ? t('avatarTitleSwitch', { nev: aktivNev }) : t('avatarTitlePlain'),
            style: { cursor: 'pointer' },
            onClick: function () { setTab('alteregok'); },
          }),
          h('div', { style: S.title }, t('appName') + (aktivNev ? ' · ' + aktivNev : '')),
          h('button', {
            style: S.iconBtn,
            title: t('flipTitle', { side: sideLabel }),
            onClick: flip,
          }, side === 'left' ? '⇄ ▶' : '◀ ⇄'),
          h('button', { style: S.iconBtn, title: t('closeTitle'), onClick: props.onClose }, '✕'),
        ),
        h('div', { style: S.tabs },
          h('div', { style: tabStyle('status'), onClick: function () { setTab('status'); } }, t('tabStatus')),
          h('div', { style: tabStyle('settings'), onClick: function () { setTab('settings'); } }, t('tabSettings')),
          h('div', { style: tabStyle('alteregok'), onClick: function () { setTab('alteregok'); } }, t('tabAlteregok')),
          h('div', { style: tabStyle('log'), onClick: function () { setTab('log'); } }, t('tabLog')),
        ),
        tab === 'status' ? h(StatusTab, { t: t }) : null,
        tab === 'settings' ? h(SettingsTab, { t: t }) : null,
        tab === 'alteregok' ? h(AlteregokTab, { av: av, t: t }) : null,
        tab === 'log' ? h(LogTab, { t: t }) : null,
      );
    }

    function RobotButton(props) {
      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var phase = useConversationPhase();
      var localeId = useLocaleId(props.locale);
      var t = translator(localeId);
      var dark = useDarkTheme(props.theme);
      applyTheme(dark);
      if (!phaseServesView(props.heroVariant, phase)) return null;
      return h(react.Fragment, null,
        h('button', {
          style: S.button,
          title: t('openTitle'),
          'aria-label': t('appName'),
          onClick: function () { setOpen(!open); },
        }, '🤖'),
        open ? h(RobotPanel, {
          onClose: function () { setOpen(false); },
          locale: props.locale,
          theme: props.theme,
        }) : null,
      );
    }

    /* ---------------------------------- plugin -------------------------------- */

    function apply(ctx) {
      var slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function') return;

      var safeRun = function (label, body) {
        try {
          return body();
        } catch (error) {
          try { console.error('[hazi-robot] ' + label, error); } catch (ignored) { }
          return null;
        }
      };

      var register = function (slotName, id, heroVariant) {
        safeRun('inject ' + slotName, function () {
          slots.inject(slotName, function () {
            return slots.register({
              name: slotName,
              id: id,
              locale: NS,
              inject: function () { return { locale: ctx.locale, theme: ctx.theme, heroVariant: heroVariant === true }; },
            }, RobotButton);
          });
        });
      };

      register('conversation.session.header.utilities', 'hazi-robot-corner', false);
      register('conversation.input.dock', 'hazi-robot-hero', true);
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.RobotButton = RobotButton;
    exports.RobotPanel = RobotPanel;
    exports.readConversationPhase = readConversationPhase;
    exports.phaseServesView = phaseServesView;
    exports.translator = translator;
    exports.activeLocaleId = activeLocaleId;
    exports.readDark = readDark;
    exports.I18N = I18N;
    return module.exports;
  },
});
