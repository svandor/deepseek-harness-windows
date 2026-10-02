# DSH UI-plugin fejlesztési jegyzet

Ez a jegyzet a DSH felületének bővítéséhez szükséges, **visszafejtett** csatolási
pontokat rögzíti (a forráskód nem elérhető, csak a telepített, lefordított
csomagok). Cél: Git panel, SSH panel, statisztika panel, terminál + futtatható
parancsok.

## 1. Kliens-plugin formátuma

Egy kliens-plugin a böngészőben egyetlen ESM fájl, ami regisztrálja a gyárat:

```js
window.__ModuleLoader__.load({
  id: "<csomagnév>",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // require("react"), require("react/jsx-runtime"),
    // require("@deepseek-ai/dsh-client-ui-primitives") stb. elérhető
    function apply(ctx) { /* ... */ }
    const inject = ["@deepseek-ai/dsh-client-ui-renderer", /* ... */];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

- A `factory` csak regisztrál; a modul törzse (és minden mellékhatás, pl. CSS) a
  **materializáláskor** fut, nem a szkript betöltésekor.
- A `require` a shell saját modulgráfjából old fel (react, primitívek, társ-pluginok).
- A csomag `package.json`-jában kell a deklaráció:

```json
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-client-ui-renderer", "..."],
    "platform": "web",
    "immediately": true
  }
}
```

## 2. Betöltés a host oldalon

- A host `clientModules` szolgáltatása (`@deepseek-ai/dsh-client-modules`)
  **végigpásztázza a betöltött cordis-entry-ket `dsh.client` deklarációért**,
  összeállítja a `window.__DSH_BOOT__` gráfot, kiszolgálja a bundle-t a
  `/plugins` útvonalon, és beszúrja az indexbe.
- Egy csomag akkor kerül be, ha **szerepel a profil cordis-fájában**:
  `~/.dsh/profiles/web/cordis.patch.yml` (az egyetlen szerkesztendő fájl; a
  `cordis.yml` csak a bundle-ökből épül).
- A profil `cordis.patch.yml` alapból `[]` (üres YAML tömb), és a
  `patchReload: live` miatt a módosítás **újraindítás nélkül** is betölthető.
- A profil `node_modules`-a **junction-ökkel** mutat a telepített csomagokra
  (pl. `~/.dsh/profiles/node_modules/@deepseek-ai/cordis` →
  `...\_npx\...\node_modules\@deepseek-ai\cordis`). Új helyi pluginhez ide kell
  egy junction, vagy a csomagot közvetlenül ide kell tenni.

## 3. Slot-API (UI csatlakozási pontok)

A plugin az `apply(ctx)`-ben a `ctx.slots` szolgáltatást használja:

```js
ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
  name: "conversation.input.dock",
  id: "goal",            // vagy: key: "command-input"
  locale: NS
}, ViewComponent));
```

Típusok: `dsh-client-ui-renderer/lib/types/client/registry.d.ts`
(`inject(key, callback)`, `register(...)`), `scoped-slots.d.ts`, `bindings.d.ts`.

### Elérhető slotnevek (a telepített csomagokból kigyűjtve)

```
main, rightbar
sidebar, sidebar.brand.mark, sidebar.brand.name, sidebar.footer.action
sidebar.settings, sidebar.workspaces, sidebar.workspaces.directoryFlow
sidebar.right.pane.tab, sidebar.right.pane.tab.title
sidebar.right.tab.document, sidebar.right.tab.menu.item
conversation.view, conversation.chat.node, conversation.chat.turnTail
conversation.composer, conversation.composer.dock, conversation.input.dock
conversation.input.attachments, conversation.input.model, conversation.input.overlay
conversation.input.plan, conversation.message.images
conversation.session.header.actions, .corner, .lineage, .utilities
conversation.hero.workspace, conversation.hero.workspace.directoryFlow
conversation.approval.detail, conversation.trajectory.images
settings.trigger, settings.section, settings.header, settings.action, settings.close
settings.general.item, settings.plugin.item, settings.plugins.tab, settings.onboarding
tool.call.images, tool.call.toolview
```

A `rightbar` **fül-típusokat** deklarál (`sidebar.right.pane.tab` `kind: "keyed"`),
ezért új jobb oldali fülhöz a tab-típus regisztrációját is meg kell érteni
(`sidebar-right` csomag 3700–3744. sora a minta; `tabs.register(...)` +
`tabInfoFactory`).

## 4. Adatok a kliensen

- A kliens a session-vetületeket `useProjection("<név>")` hookkal olvassa
  (pl. `useProjection("tokenUsage")` a chat-kliensben).
- Session-kötés: `ctx.sessions.binding(sessionId)?.session.projections.faceOf("<név>")`
  → `.getSnapshot()`.
- **Már elérhető token-adat**: `uncachedInputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` + cache-találati arány.
- A `TurnUsagePanel` és a session-statisztika dialog a `dsh-client-ui-chat`
  csomagban van (nem feltétlenül exportált).

## 5. Ami még nyitott (a következő lépésekhez)

1. **Pontos `register()` séma**: a `registry.d.ts` `SlotMap` típusa mondja meg,
   milyen mezők kellenek egy adott slothez (`id` vs `key`, `store`, `inject`).
2. **Host-oldali plugin** (Git műveletekhez, terminálhoz): külön csomag
   `lib/index.js`-szel, `cordis.patch.yml`-be felvéve; a host plugin
   `inject`-je szolgáltatásnevekre megy (pl. `shell`, `fs`).
3. **Terminál**: a `dsh-terminal` + `dsh-tool-pwsh-persistent` már perzisztens
   shell-munkamenetet ad; a UI-hoz a kimenet streamelése kell a kliens felé
   (RPC/SSE), illetve `@xterm/xterm` (már telepítve a profilban).
4. **Árazás**: a DeepSeek ártábláját konstansként kell bevinni (egy helyen),
   az off-peak ablak kínai idő szerint értendő; a felhasználó helyi idejében kell
   kijelezni.
5. **Egyenleg**: vagy a DeepSeek balance API a mentett kulccsal (hálózat kell),
   vagy token-alapú becslés.

## 6. Biztonságos munkamenet a fejlesztéshez

- A `cordis.patch.yml` **biztonsági mentése** kötelező minden módosítás előtt
  (a hibás patch az egész profilt megbuktatja).
- Új plugin első próbája: minimális „hello" panel, majd a boot gráf ellenőrzése
  (`__DSH_BOOT__` a böngészőben), végül a valódi panel.
- A profil `cordis.patch.yml` és a node_modules junction a workspace-en KÍVÜL
  van (`~/.dsh`), ezért írásuk szélesebb hozzáférést igényel.
