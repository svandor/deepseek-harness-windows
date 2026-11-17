# FTP deploy — panel + quick button (PLAN)

English | [Magyar](FTP-DEPLOY-TERV.md)

Status: **plan, awaiting approval** (2026-11-16). Origin: the **working,
production-used** FTP engine of the `D:\Szerver\Felpuffanto` project (0.1.5,
commit `bcf25fd` "Ship Felpuffanto 0.1.5: FTP push retry, phase logging, MLSD
dir check").

The goal is two things, in this order:

1. a **standalone FTP panel** in the right sidebar (profile, preview, deploy,
   backup, remote folder, log),
2. once that is fully done: an **`FTP deploy` quick button in the Git panel's
   action row, BEFORE the `Release` button**.

---

## 1. Origin: what we port from Felpuffantó

The engine is plain Node/ESM, cut into pieces that are testable without network.
The files:

| Felpuffantó file | Size | Role | Port |
|---|---|---|---|
| `src\engine\ftp.ts` | 14.5 KB | FTP client: upload, delete, ZIP backup, folder list, error text | **one to one** (`lib\engine\ftp.js`) |
| `src\engine\gitdiff.ts` | 5.2 KB | preview: `git diff lastDeploy..HEAD` + staged + unstaged + untracked | **yes**, with the host `run("git", …)` helper instead of `simple-git` |
| `src\engine\tree.ts` | 4.0 KB | walking gitignored (storage) trees for the "extra" upload | **yes** |
| `src\engine\deny.ts` | 4.2 KB | deny/allow patterns, `remoteRoot` and `localRoot` guards | **yes**, with profile-level additions |
| `src\engine\remoteDirs.ts` | 5.2 KB | `RemoteDirIndex`: MLSD based folder check (no MKD spam) | **yes** |
| `src\engine\profiles.ts` | 2.6 KB | profile store (`profiles.json`), `lastDeploySha` | **yes**, under the DSH `state\` |
| `src\engine\secrets.ts` | 2.3 KB | password: Windows **DPAPI** (CurrentUser), through PowerShell | **yes** |
| `src\engine\paths.ts` | 0.9 KB | `%APPDATA%\Felpuffanto` paths | replaced by `state\ftp-*` |
| `src\engine\log.ts` | 0.5 KB | daily log file | replaced by `state\ftp-deploy-log.txt` (rotated) |
| `src\engine\index.ts` | 7.0 KB | control: preview / baseline / push / push-extra / test / list / backup | **yes** |
| `src\presets\l12.ts` | 1.6 KB | L12 preset (Laravel include list) | **yes**, the first real target |
| `src\cli.ts` | 4.7 KB | CLI (JSON output) — the "CLI = UI" principle | **yes**, `tools\ftp-deploy.cmd` |

Dependencies (already installed in Felpuffantó, measured versions): **`basic-ftp`
5.3.1**, **`yazl` 3.3.1** (`simple-git` 3.36.0 is not needed — git runs from the
host).

### The engine's measured properties to keep

- **3 attempts** with growing waits `[3 s, 8 s]`; only for **transient** errors
  (ECONNRESET/timeout/4xx) — persistent FTP codes (`530`, `550`, `552`, `553`)
  stop immediately. This matches AGENTS §1.7's mandatory pattern exactly.
- **Phase logging** (`connect` → `mkdir` → `upload` → `delete`) and a human error
  message with the **remote IP** — needed for the hosting provider's ticket.
- **`RemoteDirIndex`**: it checks against the folder listing and sends `MKD` only
  for the missing level. Measured reason: `basic-ftp`'s `ensureDir()` issued blind
  MKDs, and a 12-file push put **~84 `550 Can't create directory`** lines into the
  host log, which the provider treated as a client bug.
- **ZIP backup ("Lepuffantás")** streamed (`yazl`), with a unique filename — it
  never overwrites and deletes the half-finished ZIP on error.
- **Large push protection**: `LARGE_FILE_LIMIT = 80` files; above that a separate
  `--force-large` (in the UI: a second, confirming click).
- **Password**: DPAPI `CurrentUser`, PowerShell `ProtectedData.Protect/Unprotect`,
  it **never** enters the log or a response (the schema does not contain it).
- **`lastDeploySha` baseline**: must be set before the first deploy ("what is up
  there now = the current git state"); after that only changes go up, and
  deletions are followed too (`action: "delete"`).

---

## 2. What we build into DSH

New plugin: **`plugins\dsh-ftp-deploy\`** (following `dsh-devadmin`: host +
client in one package, junction + `- insert:` into the profile patch).

```
plugins\dsh-ftp-deploy\
  package.json            # name dsh-ftp-deploy, type module, dsh.client.platform: web,
                          # deps: basic-ftp ^5.3.1, yazl ^3.3.1 (the plugin's own node_modules)
  install.ps1             # -Check / -Remove / install (junction + patch), the devadmin pattern
  lib\index.js            # HOST: /ftp/* endpoints + the runner
  lib\client.js           # CLIENT: FTP panel + header icon
  lib\engine\ftp.js       # the port of felpuffantós ftp.ts
  lib\engine\gitdiff.js   # preview (via the host run(), not simple-git)
  lib\engine\tree.js      # storage/extra tree walk
  lib\engine\deny.js      # deny/allow patterns + remoteRoot guards
  lib\engine\remoteDirs.js# RemoteDirIndex
  lib\engine\profiles.js  # state\ftp-profiles.json
  lib\engine\secrets.js   # DPAPI (state\ftp-secrets\<id>.dpapi)
  lib\engine\runner.js    # concurrent deploy lock + status file + log
  test\*.test.mjs         # node --test, without network (see point 6)
tools\ftp-deploy.cmd      # CLI parity (CLI = UI), calling the same engine
docs\FTP-DEPLOY.md        # usage (HU)
```

### Host endpoints (all run on the host side; the browser never sees a secret)

| Endpoint | What it does |
|---|---|
| `GET /ftp/profiles` | profiles (host, port, user, remoteRoot, include, `lastDeploySha`, **is a password stored**) |
| `POST /ftp/profile` | save a profile (the `deny.ts` guards: `assertLocalRoot`, `assertRemoteRoot`) |
| `POST /ftp/secret` | save/delete the password with DPAPI — the answer is only `{ok, saved}` |
| `GET /ftp/test?id=` | connection + `PWD` (read only) |
| `GET /ftp/preview?id=` | git-diff preview: files to upload/delete, `blocked`, size |
| `GET /ftp/preview-extra?id=` | preview of the gitignored `extraUpload` trees |
| `POST /ftp/baseline?id=` | "the current HEAD = already up there" |
| `POST /ftp/push?id=&confirm=&forceLarge=` | start a deploy (202 + `state\ftp-deploy-status.json`) |
| `GET /ftp/status` | state of the running deploy (phase, done/total, bytes, current file, error) + log tail |
| `POST /ftp/backup?id=&dest=&mode=full\|code` | save the live content into a local ZIP |
| `GET /ftp/remote?id=&path=/` | remote folder list (for browsing, path checks) |
| `GET /ftp/log` | tail of the deploy log |

The long operation (push/backup) runs **in the host process**, not as a separate
child process: so **no console window is created** (AGENTS §1), and the panel
polls it (`2 s`) exactly like the Release button's state. Only **one** deploy can
run at a time (lock file + in-memory lock); the host rejects the second one.

### Storage (all under the workspace's gitignored `state\`)

| File | Content |
|---|---|
| `state\ftp-profiles.json` | profiles (`state\` is gitignored → never enters the repo) |
| `state\ftp-secrets\<id>.dpapi` | DPAPI-encrypted FTP password (CurrentUser) |
| `state\ftp-deploy-status.json` | running/done/failed state for the panel (like `release-status.json`) |
| `state\ftp-deploy-log.txt` | log (rotated above 2 MB, like `release-log.txt`) |

**Importing the starting profiles:** Felpuffantó's
`%APPDATA%\Felpuffanto\profiles.json` and `secrets\*.dpapi` **can be imported**
(same user, same DPAPI scope), so neither password nor profile has to be retyped.
The measured set:

| id | host:port | remoteRoot | baseline (`lastDeploySha`) | password |
|---|---|---|---|---|
| `TGYO-L12` | `fw.elin.hu:2141` | `/web/laravel12` | `c04fe33…` | yes |
| `jelentkezes-redirect` | `fw.elin.hu:2129` | `/web/public` | `45d4bf9…` | yes |
| `atoktatas-redirect` | `fw.elin.hu:2141` | `/web` | `478de8d…` | yes |

(The usernames deliberately do not enter the document; the repo is public, and the
secret audit does not inspect `state\` because it is gitignored.)

---

## 3. Client: the FTP panel

In the right sidebar, following `devadmin` (measured pattern:
`plugins\dsh-devadmin\lib\client.js:770-821`):

- `ctx.sidebarRightTabs.register({ id: "dsh-ftp-deploy/ftp", kind: "ftp", priority: "extension", title: () => "FTP", guide: [...] })`
- `ctx.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-ftp-deploy/ftp" }, FtpPanel)`
- header icon: `conversation.session.header.utilities`, `id: "ftp-header"`, `order: 62`
  (after devadmin's 60/61), on click `ctx.sidebarRight.openTab("ftp")`

The panel, top to bottom:

1. **Profile** — picker + the profile summary (host:port, remoteRoot, include
   chips), "Test connection", password field (saved with DPAPI; an existing
   password is not shown, only that one exists).
2. **Preview** — `preview`: upload/delete rows (`origin`: committed / unstaged /
   untracked / extra), size, total bytes; the `blocked` files in a separate
   section with a Hungarian reason (deny pattern). Without a baseline:
   "First setup: what is up there now = the current git state" button.
3. **Deploy** — the `FTP deploy` button (a large push above 80 files asks for a
   second confirmation: "Are you sure? 128 files, 24.3 MB"), during the run a
   `⏳ 12/48 — resources/views/x.blade.php` line + progress bar; at the end
   `✔ uploaded 48, deleted 3, 24.3 MB (attempt 2)` or the phased error.
4. **Extra upload** (gitignored trees, e.g. a `storage/...` seed) — the same
   process, with a separate button and a separate counter.
5. **Remote folder** — `listRemote`: browsing (to verify the new remoteRoot).
6. **Backup (Lepuffantás)** — `backup` with `full` / `code` scope, destination
   folder picker; the result is the ZIP path + file/db count.
7. **Log** — the last lines of `state\ftp-deploy-log.txt` (collapsible).

Every label lives under `ctx.locale.register("ftp", { hu: {...}, en: {...} })`,
following `dsh-ui-extras` key naming.

---

## 4. Client: the quick button in the Git panel

The Git panel's action row (`plugins\dsh-ui-extras\lib\client.js`, between the
`Push` and the `Release` button, ~lines 5181–5215) gets a new button:

```
[ Commit ] [ Push ] [ FTP deploy ] [ Release ]
```

Behaviour (measured to be the useful one):

- **A profile exists for this workspace** (the profile's `localRoot` canonically
  matches the panel's workspace): the button says `FTP deploy`; a click runs
  `/ftp/preview` → if there is something to upload, `/ftp/push` starts (progress
  is visible in the Git panel even outside the tab, just like the Release
  button's), ending with "✔ 12 files, 3.4 MB".
- **No profile**: the button says `FTP settings` and opens the FTP tab
  (`ctx.sidebarRight.openTab("ftp")` — the `dsh-ui-extras` client already injects
  `sidebarRight`, measured: `client.js:9747`).
- **A deploy is running**: it is inactive, labelled "FTP running…"; the host also
  rejects the second one (the same guard as on the Release button).

The button sits **before Release** because the typical order is: upload to the
host → then (if needed) a new installer release.

---

## 5. Safety rules (mandatory, they come with the engine)

- **Deny patterns** (never uploaded): `.env*`, `storage/*`, `vendor/*`,
  `node_modules/*`, `.git/*`, `bootstrap/cache/*`, `public/hot`,
  `public/.user.ini`, `phpinfo.php`, `rr(.exe)`.
- **Allow exceptions** (from the deny): a profile-level `allow` list (in
  Felpuffantó this carried the media directory and the document previews) — in DSH
  it is a profile field, not a Laravel list burned into code. The `laravel` preset
  brings the felpuffantós defaults.
- **`remoteRoot` guard**: cannot be empty/`/`; `/web` only for a purely redirecting
  profile (`.htaccess` + `index.php`); forbidden remote segments (`elearning*`,
  `magazin`, `dok`).
- **Safe relative paths**: no `..`, no absolute start.
- **Large push**: confirmation above 80 files; `forceLarge` only reaches the host
  after the confirming click.
- **Secrets**: DPAPI, never into the log/response; `state\` is gitignored.
- **Network**: only when the user clicks; no scheduled FTP.
- **Console**: the deploy runs in the host process (no child process) → §1
  violation excluded; the `git` calls use the existing `run()` helper with
  `windowsHide`.
- **Retry**: 3 attempts, `[3 s, 8 s]`, only for transient errors (§1.7).

---

## 6. Phases and verification in every phase

| # | Phase | Done when |
|---|---|---|
| 0 | Skeleton + `install.ps1` + `package.json` + engine port | `node --check`, `install.ps1 -Check` green, the 3 profiles imported |
| 1 | Engine + tests (without network) | `node --test`: deny/allow, `remoteDirOf`/`RemoteDirIndex` (fake client), `parseNameStatus`, profile store (BOM tolerant), DPAPI round trip, error classification, ZIP name uniqueness — all green |
| 2 | Host endpoints + runner + CLI (`tools\ftp-deploy.cmd`) | live: `profiles`, `preview` (for L12: how many files are waiting), `test` (connection OK), `remote` (folder list), `status` (nothing running), `backup` with a small scope |
| 3 | Client panel (HU/EN) | the tab opens, no `[ERROR]` in `state\ui-extras-client.log`, the 6 sections work, a long push shows progress |
| 4 | Quick button in the Git panel | the button sits before Release; without a profile it opens the FTP tab; inactive while running; the Release button behaves unchanged (regression check) |
| 5 | Documentation + AGENTS + release | `docs\FTP-DEPLOY.md`, AGENTS "eleventh round", audit 0 hits, `node --check` on everything |

Taking effect: the **host** plugin on the harness's next start (§1.5 — user
permission), the **client** tab on a panel reload. The panels are
workspace-independent, so the `dsh-ui-extras` Git panel button appears once the
panel reloads.

---

## 7. What we deliberately do NOT do

- No **scheduled** FTP (no cron-like deploy) — only on click.
- No **SFTP/SSH** in this round (`basic-ftp` is plain FTP/FTPS; the host is plain
  FTP on the measured profiles, `tls: false`).
- No **two-way sync**: downwards only the "Lepuffantás" ZIP backup goes.
- We do not port Felpuffantó's Tauri/UI layer (no need for it).
- We do not touch `dsh-ui-extras`' Release logic (we only insert one button in
  front of it).

---

## 8. Open decision (1 question)

**May implementation proceed as planned?** The proposed defaults:

1. **Profile import** from Felpuffantó (3 profiles + DPAPI passwords) — so nothing
   has to be retyped, and the measured baselines (`lastDeploySha`) survive too.
2. **Quick button = immediate deploy** (if there is a profile and something to
   upload), with progress in place; without a profile the button opens the FTP tab.
3. **First live trial** on the `TGYO-L12` profile, **with preview** (expected to be
   few or zero files because of the baseline) — the actual upload starts only when
   you click it.
