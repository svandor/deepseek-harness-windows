# DSH UI plugin development notes

> Hungarian version: [`dsh-plugin-notes.md`](dsh-plugin-notes.md).

This note records the **reverse-engineered** attachment points needed to extend
the DSH interface (the source code is not available, only the installed, compiled
packages). Goal: a Git panel, an SSH panel, a statistics panel, a terminal and
runnable commands.

## 1. Client plugin format

A client plugin is a single ESM file in the browser that registers the factory:

```js
window.__ModuleLoader__.load({
  id: "<package-name>",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // require("react"), require("react/jsx-runtime"),
    // require("@deepseek-ai/dsh-client-ui-primitives") etc. are available
    function apply(ctx) { /* ... */ }
    const inject = ["@deepseek-ai/dsh-client-ui-renderer", /* ... */];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

- The `factory` only registers; the module body (and every side effect, e.g. CSS)
  runs at **materialisation**, not when the script loads.
- `require` resolves from the shell's own module graph (react, primitives, peer
  plugins).
- The package's `package.json` must carry the declaration:

```json
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-client-ui-renderer", "..."],
    "platform": "web",
    "immediately": true
  }
}
```

## 2. Loading on the host side

- The host's `clientModules` service (`@deepseek-ai/dsh-client-modules`) **scans
  every loaded cordis entry for a `dsh.client` declaration**, assembles the
  `window.__DSH_BOOT__` graph, serves the bundle on the `/plugins` route, and
  injects it into the index.
- A package is included only if it **appears in the profile's cordis file**:
  `~/.dsh/profiles/web/cordis.patch.yml` (the only file to edit; `cordis.yml` is
  built from the bundles).
- The profile's `cordis.patch.yml` is `[]` (an empty YAML array) by default, and
  because of `patchReload: live` a change can be loaded **without a restart**.
- The profile's `node_modules` points at the installed packages through
  **junctions** (e.g. `~/.dsh/profiles/node_modules/@deepseek-ai/cordis` →
  `...\_npx\...\node_modules\@deepseek-ai\cordis`). A new local plugin needs a
  junction here, or the package has to be placed here directly.

## 3. Slot API (UI attachment points)

Inside `apply(ctx)` the plugin uses the `ctx.slots` service:

```js
ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
  name: "conversation.input.dock",
  id: "goal",            // or: key: "command-input"
  locale: NS
}, ViewComponent));
```

Types: `dsh-client-ui-renderer/lib/types/client/registry.d.ts`
(`inject(key, callback)`, `register(...)`), `scoped-slots.d.ts`, `bindings.d.ts`.

### Available slot names (collected from the installed packages)

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

`rightbar` declares **tab types** (`sidebar.right.pane.tab` with `kind: "keyed"`),
so a new right-hand tab needs the tab-type registration too (lines 3700–3744 of
the `sidebar-right` package are the model; `tabs.register(...)` +
`tabInfoFactory`).

## 4. Data on the client

- The client reads session projections with the `useProjection("<name>")` hook
  (e.g. `useProjection("tokenUsage")` in the chat client).
- Session binding: `ctx.sessions.binding(sessionId)?.session.projections.faceOf("<name>")`
  → `.getSnapshot()`.
- **Token data already available**: `uncachedInputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` plus the cache hit rate.
- The `TurnUsagePanel` and the session statistics dialog live in the
  `dsh-client-ui-chat` package (not necessarily exported).

## 5. What is still open (for the next steps)

1. **Exact `register()` schema**: the `SlotMap` type in `registry.d.ts` defines
   which fields a given slot needs (`id` vs `key`, `store`, `inject`).
2. **Host-side plugin** (for Git operations, the terminal): a separate package
   with `lib/index.js`, added to `cordis.patch.yml`; the host plugin's `inject`
   names services (e.g. `shell`, `fs`).
3. **Terminal**: `dsh-terminal` + `dsh-tool-pwsh-persistent` already provide a
   persistent shell session; the UI needs the output streamed to the client
   (RPC/SSE) and `@xterm/xterm` (already installed in the profile).
4. **Pricing**: the DeepSeek price table has to be brought in as a constant (in
   one place); the off-peak window is defined in Chinese time and must be
   displayed in the user's local time.
5. **Balance**: either the DeepSeek balance API with the stored key (needs
   network), or a token-based estimate.

## 6. A safe working session for development

- **Backing up** `cordis.patch.yml` is mandatory before every change (a broken
  patch takes down the whole profile).
- The first try of a new plugin: a minimal "hello" panel, then checking the boot
  graph (`__DSH_BOOT__` in the browser), and finally the real panel.
- The profile's `cordis.patch.yml` and the node_modules junction live OUTSIDE the
  workspace (`~/.dsh`), so writing them needs wider access.
