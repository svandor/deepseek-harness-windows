# FTP deploy — usage

English | [Magyar](FTP-DEPLOY.md)

The `dsh-ftp-deploy` plugin adds git-diff based FTP upload next to the Git panel:
only the **change** goes up to the host (deletions followed through), and the
password stays on the machine, encrypted with Windows DPAPI.

- **Tab:** right sidebar → "FTP deploy" (or the `⤴ FTP` icon in the header).
- **Quick button:** Git panel → `FTP deploy` **before** the `Release` button (if
  the workspace has no profile, the button says `FTP settings` and opens the FTP
  tab).
- **Engine:** the port of Felpuffantó 0.1.5 (`basic-ftp` + `yazl`) with the same
  behaviour: 3 attempts `[3 s, 8 s]` only for transient errors, phased error text
  with the remote IP, `RemoteDirIndex` (no MKD spam), ZIP backup.

## 1. First use on a project

1. **Add a profile** — FTP tab → `New profile`: id, label, host, port, FTP user,
   local root (the project folder), remote root (e.g. `/web/laravel12`), folders
   (comma separated: `app, config, resources, …`).
   `/web` is allowed only for a purely redirecting profile (`.htaccess`,
   `index.php`).
2. **Password** — FTP tab → `Save password` (DPAPI, `CurrentUser`; the UI only
   shows later that one exists).
3. **Baseline** — if the project is already on the host, press
   `The current git state is already up there` first: that sets the
   `lastDeploySha` baseline. Without it the deploy would upload the **whole tree**.
4. **Preview** — `Preview`: files to upload/delete, size, excluded files.
5. **Deploy** — `FTP deploy`. Above 80 files a second click is required
   ("Are you sure? 128 files, 24.3 MB").

## 2. What it uploads

- committed, staged and unstaged changes since `lastDeploySha`,
- untracked files,
- the profile's `extraUpload` folders (gitignored seeds, e.g. `storage/...`),
- deleted files are **deleted** from the host too (`DEL`; an "550 not found"
  answer is not an error).

**Never uploaded:** `.env*`, `storage/*`, `vendor/*`, `node_modules/*`, `.git/*`,
`bootstrap/cache/*`, `public/hot`, `public/.user.ini`, `phpinfo.php`, `rr(.exe)` —
except the prefixes listed in the profile's `allow` list (the built-in Laravel
exceptions: media directory, document previews, Számlázz inbox, …).

## 3. Backup ("Lepuffantás")

`Backup` section: `code only` (per the profile's folders) or `full` (the whole
remote root) → local ZIP into the `state\ftp-backups` folder, with a unique name
(never overwritten). The download is streamed, and a half-finished ZIP is removed
on error.

## 4. Command line (the same engine)

```
tools\ftp-deploy.cmd profiles
tools\ftp-deploy.cmd preview  --profile TGYO-L12
tools\ftp-deploy.cmd baseline --profile TGYO-L12
tools\ftp-deploy.cmd test     --profile TGYO-L12
tools\ftp-deploy.cmd push     --profile TGYO-L12 --confirm
tools\ftp-deploy.cmd remote   --profile TGYO-L12 --path /web/laravel12
tools\ftp-deploy.cmd backup   --profile TGYO-L12 --mode code
tools\ftp-deploy.cmd log --lines 40
```

The output is JSON; the password never appears. Setting a password:
`echo PASSWORD | node tools\ftp-deploy.mjs set-password --profile <id>`
(the password arrives on **stdin**, not as a command-line argument).

## 5. Where the data lives

| File | Content |
|---|---|
| `state\ftp-profiles.json` | profiles (with the `lastDeploySha` baseline) |
| `state\ftp-secrets\<id>.dpapi` | DPAPI password (bound to the signed-in user) |
| `state\ftp-deploy-status.json` | state of the running/last operation (polled by the panel) |
| `state\ftp-deploy-log.txt` | log (`connect`/`mkdir`/`upload`/`delete`, rotated above 2 MB) |
| `state\ftp-backups\` | the ZIP backups |

`state\` is gitignored: profiles, log and encrypted passwords **never** enter the
repository.

## 6. Reading errors

The error message is deliberately "ticket-compatible":

```
Upload aborted — phase: checking remote folder · fw.elin.hu:2141 ·
user=web… · remote IP=… · attempt 2/3 — 550 Can't create directory
```

- `530` = password/account error (not retried),
- `550/552/553` = permission/quota/name (not retried),
- `ECONNRESET`/`timeout`/`421` = transient (at most 3 attempts, `[3 s, 8 s]`).

## 7. Embedded dependencies

They travel with the repository under `vendor\node_modules`: `basic-ftp` 5.3.1,
`yazl` 3.3.1, `buffer-crc32` 1.0.0 (all MIT). So there is no `npm install` on the
user's machine, and the installer works offline. Upgrading: replace the three
packages' `dist`/`*.js` files and `package.json`, then:

```
node --test plugins\dsh-ftp-deploy\test\*.test.mjs
```

## 8. Taking effect

- **Host** endpoints (`/ftp/*`): on the next harness start (the plugin loads via
  the `- insert:` entry in `~\.dsh\profiles\web\cordis.patch.yml`).
- **Client** (tab + button): panel reload (the bundle is served on request).
- Check: `pwsh -NoProfile -File plugins\dsh-ftp-deploy\install.ps1 -Check`.
