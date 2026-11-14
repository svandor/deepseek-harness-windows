# Herd replacement — plan and measured baseline

> Magyar változat: [`DSH-HERD-KIVALTAS.md`](DSH-HERD-KIVALTAS.md)

This document turns the handover `D:\Szerver\Vector\DSH-atadas-herd-kivaltas.md`
into an **executable plan**: the measured baseline, the order of work and the
way the acceptance criteria are measured. The work happens in the DSH repo;
Herd stays until all 5 criteria are met.

---

## 1. Measured baseline (2026-11-14, on this machine)

| Item | Measured value |
|---|---|
| Herd processes | 5 × `Herd.exe`, 1 × `HerdHelper`, **25 × `nginx.exe`**, **5 × `php-cgi.exe`** |
| 80/443 | `127.0.0.1:80` held by several nginx instances (TLS on 443) |
| hosts | Herd-written `.test` lines: `database.herd.test`, `herd-studio.test`, `jelentkezes-redirect.test`, `termeszetgyogyaszoktatas-l12.test`, plus a hashed subdomain (`3aa9ca55…`) |
| PHP | **`C:\Users\info\.config\herd\bin\php.bat` → PHP 8.4.27** (NTS, VC++ 2022 x64) |
| Composer | `C:\Users\info\.config\herd\bin\composer.bat` (**also from Herd**) |
| Caddy / mkcert / nginx on PATH | **none** |
| Node / npm | `C:\Program Files\nodejs\node.exe`, `npm.ps1` |
| Project | `D:\Herd\termeszetgyogyaszoktatas-L12`: `artisan`, `public/index.php`, `.env` present, **no `.dsh\dev.yaml`** |

### 1.1 The most important finding: PHP belongs to Herd

The handover says "use the system PHP", but on this machine that is **not
true**: there is no system PHP — both `php` and `composer` come from Herd's
`bin` directory. Once Herd's autostart is removed (or Herd itself is
uninstalled), the project **will not start**: PHP must be installed
standalone. This is a **precondition** of the migration, not a later polish.

---

## 2. Requirement → implementation

### 2.1 Project profile: `.dsh\dev.yaml`

In the project root, with these keys (the spec merged with reality):

```yaml
domain: termeszetgyogyaszoktatas-l12.test
docroot: public
php: "8.4"                  # the system's PHP major version
server: caddy               # caddy | nginx | artisan-serve
vite: true                  # start the frontend dev server too
port: 8443                  # while Herd runs, NOT 443 (conflict)
env:
  APP_ENV: local
hosts: true                 # manage the hosts line (elevated helper script)
```

### 2.2 Operations — through the DSH job layer

`dev_start` / `dev_stop` / `dev_status` / `dev_logs`. Per the requirement these
are **not a separate daemon** but go through the DSH job layer, so that
`DSH-atadas.md` items 3.A–B (persistent ledger, recovered jobs) apply
automatically. The implementation therefore is `plugins\dsh-devserver`
(host plane): it registers a `dev_*` tool that starts the processes through
`ctx.jobs`, so the process guard (`dsh-process-guard`) records them in its
ledger and they appear as recovered jobs after a restart.

### 2.3 HTTPS

| Mode | When | Note |
|---|---|---|
| `mkcert` + `caddy` | default | one-time `mkcert -install`, per-domain certificate |
| Caddy internal CA | if mkcert is missing | Caddy's own CA must be added to the system trust store |
| `artisan-serve` | fallback | no HTTPS, fastest start |

**Conflict with Herd:** port 443 is held by Herd's nginx. In the first phase of
the migration the DSH therefore serves on **another port** (e.g. `8443`) and
moves to 443 only after Herd is stopped.

### 2.4 hosts

Writing the hosts file needs elevation on Windows. Plan:
1. `tools\dev-hosts.ps1 -Add|-Remove` — an **elevated** helper script that writes
   only the project's domains and journals every added line in
   `.dsh\hosts-added.json` (line, timestamp, project).
2. `dev_stop --purge` / uninstall → only the project's own lines are removed
   based on that journal (Herd's lines are untouched while Herd lives).
3. `dev_status` states whether the project's domain is present in the hosts file
   (read only, never write).

### 2.5 Collision and double-start protection

- Before starting: check whether the requested port(s) are taken
  (`Get-NetTCPConnection` / `netstat`), give a clear error or switch ports.
- **One** run per project: the DSH job layer plus the project's `.dsh\run.json`
  record (pid + start time) blocks a second one — the same principle as the
  `tools\start-harness-once.ps1` mutex and the tray's `EnsureHarness()`.

---

## 3. Acceptance criteria — how they are measured

| # | Criterion | Measurement |
|---|---|---|
| 1 | after a clean boot `dev_start` → `https://<project>.test` answers as Laravel, with a valid local-CA certificate | `curl -sS -o NUL -w "%{http_code}" https://…` + certificate chain check (`Invoke-WebRequest`); expected 200 and `Laravel` in the body |
| 2 | after `dev_stop` no nginx/php-cgi/node remains | `tools\dsh-orphans.ps1` returns an empty list; the project's ports are free |
| 3 | after a DSH restart the dev server shows as a recovered job and can be stopped | `dev_status` still reports a PID after the restart; `dev_stop` stops it |
| 4 | hosts contains only the project's lines and they disappear on uninstall | hosts diff against `.dsh\hosts-added.json`; after `-Remove` 0 own lines |
| 5 | works with Herd switched off | remove Herd's autostart + stop `Herd`/`HerdHelper`, then repeat criterion 1 |

---

## 4. Order (what happens now)

1. **Precondition — standalone PHP.** Install PHP 8.4 (NTS, x64) outside Herd's
   `bin` (e.g. `C:\Tools\php84`) and put `php`/`composer` on PATH. **Until that
   exists, criteria 2 and 5 cannot be met** (removing Herd would remove PHP).
2. **`tools\dev.ps1 status`** — the first risk-free slice: read the profile,
   ports, hosts line, running processes, DB port. Starts nothing.
3. **`dev_start` + `artisan-serve`** — the simplest start (no HTTPS) so the
   chain becomes measurable.
4. **Caddy + mkcert** on `8443`, alongside Herd; measure criterion 1.
5. **Job integration** (`plugins\dsh-devserver`) so the post-restart recovered
   job (criterion 3) works.
6. **hosts management** via the elevated helper script (criterion 4).
7. **Remove Herd** only after 1–5 pass (criterion 5), by deleting the
   `HKCU\...\Run\de.beyondco.herd` value.

---

## 5. Non-goals

- Not a general web server manager, not a PHP version manager.
- Does not replace MySQL/DBngin management (the DB port is read-only status
  information in `dev_status`).
