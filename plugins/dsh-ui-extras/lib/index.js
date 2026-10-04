/**
 * Host half of the UI extras plugin.
 *
 * Routes (all server-side, so the browser never needs a credential):
 *
 *   GET /ui-extras/balance
 *     DeepSeek account balance through the stored API key.
 *
 *   GET /ui-extras/git?root=<path>
 *     Git repositories below one workspace directory, with branch, tracking,
 *     file states and recent commits.
 *
 *   GET /ui-extras/ssh
 *     The user's SSH setup: connection aliases from ~/.ssh/config, key files
 *     with their fingerprints (never the key material), the known-hosts entry
 *     count, and the live sessions this plugin keeps open.
 *
 *   GET /ui-extras/ssh?action=config | save | test | connect | disconnect
 *     Read or write ~/.ssh/config through the built-in editor, try one
 *     connection, and open or close a live SSH session.
 *
 *   GET /ui-extras/layout?workspace=<path>
 *   GET /ui-extras/layout?workspace=<path>&key=<name>&value=<json>
 *     Remember one workspace's panel layout (selected terminal, expanded
 *     terminal, output filter). Stored on the HOST, not in the browser: each
 *     window generation gets a fresh WebView2 profile directory, and every
 *     profile carries its own local storage, so a browser-side memory is lost
 *     exactly when it is needed.
 *
 *   GET /ui-extras/approvals
 *   GET /ui-extras/approvals?toolName=<name>&reason=<text>
 *     The remembered approval types (`state/approvals.json`), the recent
 *     auto-answered decisions, and — with a tool name and reason — the TYPE of
 *     the request the browser is currently showing, so the approval card can
 *     name what a "remember this" press would store.
 *
 *   POST /ui-extras/approvals   { action: remember | forget | clear | clear-log }
 *     Store one approval type as permanently answered (`remember`, with
 *     `scope: "tool" | "all"`), revoke one rule (`forget` with its `id`), or
 *     drop every rule (`clear`).
 *
 * The same file drives the waterfall answerer below: a request whose TYPE has a
 * remembered rule is answered `allowed-once` on the host, before the browser is
 * asked at all — that is what makes a repeated consent prompt disappear.
 *
 *   GET /ui-extras/usage?days=30&session=<id>
 *     Token and cost usage over the last `days` days, summed from the durable
 *     session logs with the official per-model price table and the peak /
 *     off-peak rate that applied at each request. The cost of one exact session
 *     (`session=`) comes from the same scan. The `delegated` block separates the
 *     work that ran on the ZERO-priced fallback chain from delegated work that
 *     stayed on the paid route, because only the former is a saving.
 *
 *   GET /ui-extras/workspace-session
 *     The sidebar's session channel: the archived (hidden) session ids and the
 *     registered workspaces.
 *
 *   POST /ui-extras/workspace-session   { action: archive | unarchive | workspace, ... }
 *     Hide sessions from the sidebar (`archive` with `sessions: [...]`), bring
 *     them back (`unarchive`), or register a directory as its own workspace
 *     (`workspace` with `path`, so automated runs land in their own group
 *     instead of the project's list). The archive set lives in the RUNNING
 *     host's registry — `storages/workspace.json` is read at startup — so this
 *     route is the only way to change it without a restart.
 *
 *   GET /ui-extras/github-action?action=...
 *     create | connect | clone | commit | push | describe | login | deploy |
 *     install-plugin | restart-node
 *
 * The plugin also serves its own static asset directory.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createZstdDecompress } from "node:zlib";

/** Package root, used for the static asset directory. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * A workspace repo gyökere (a `plugins/dsh-ui-extras` két szinttel feljebb).
 * A kiadás- és telepítő-szkriptek innen érhetők el (`tools/`).
 */
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

/** DeepSeek's account balance endpoint (documented, Bearer auth). */
const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Services this host plugin needs. */
const inject = ["webServer", "credentials"];

/** How long a balance answer stays fresh before the route asks again. */
const CACHE_MILLISECONDS = 60000;

/** Repository discovery limits: enough for a workspace, cheap to answer. */
const MAX_DEPTH = 3;
const MAX_REPOSITORIES = 20;
const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".venv",
  "venv", "__pycache__", ".cache", "vendor", "coverage"
]);

/** Commit history depth returned per repository. */
const COMMIT_COUNT = 15;

/** Deadline for an external program; overridden per call where a short answer matters. */
const DEFAULT_PROCESS_TIMEOUT_MS = 30000;

/** How long an SSH connection test may take before it is reported as unreachable. */
const SSH_TEST_TIMEOUT_MS = 15000;

let cachedBalance = null;
let cachedBalanceAt = 0;

/**
 * Run one program and resolve with its stdout (never throws).
 *
 * A deadline always applies: an SSH connection attempt or a hung tool would
 * otherwise hold the request open forever, and the panel would wait with it.
 * Callers pass `timeoutMs` when a short answer matters more than a complete one.
 */
function run(program, args, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(program, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = error.killed === true || error.signal !== null && error.signal !== undefined;
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: timedOut
            ? `a folyamat nem valsaszolt ${String(Math.round(timeoutMs / 1000))} masodpercen belul`
            : (stderr ?? String(error.message ?? error))
        });
        return;
      }
      resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

// ---------------------------------------------------------------- credentials

/** Read the API key from the Harness credential store. */
async function readApiKey(ctx) {
  const candidates = ["DEEPSEEK_API_KEY", "deepseek-api-key", "deepseek"];

  for (const name of candidates) {
    try {
      const provider = ctx.credentials;
      if (provider === undefined) break;

      if (typeof provider.resolve === "function") {
        const resolved = await provider.resolve(name);
        if (typeof resolved === "string" && resolved.length > 0) return resolved;
        if (resolved && typeof resolved.value === "string" && resolved.value.length > 0) return resolved.value;
      }
      if (typeof provider.get === "function") {
        const value = await provider.get(name);
        if (typeof value === "string" && value.length > 0) return value;
        if (value && typeof value.value === "string" && value.value.length > 0) return value.value;
      }
    } catch {
      // Try the next spelling, then the file fallback below.
    }
  }
  return readApiKeyFromFile();
}

/** Last-resort fallback: the local credential file, key parsed as text. */
function readApiKeyFromFile() {
  try {
    const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
    const text = readFileSync(join(home, ".credentials.yaml"), "utf8");
    const match = /DEEPSEEK_API_KEY:\s*["']?(sk-[A-Za-z0-9_-]+)["']?/u.exec(text);
    return match === null ? null : match[1];
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- balance

/** One balance answer from DeepSeek, normalized for the browser. */
async function queryBalance(apiKey) {
  const response = await fetch(BALANCE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `HTTP ${String(response.status)}`, detail: detail.slice(0, 200) };
  }

  const body = await response.json();
  const info = Array.isArray(body.balance_infos) ? body.balance_infos[0] : undefined;
  if (info === undefined) return { ok: false, error: "a valasz nem tartalmaz egyenleg-informaciot" };

  return {
    ok: true,
    available: body.is_available === true,
    currency: info.currency ?? "CNY",
    total: info.total_balance ?? null,
    granted: info.granted_balance ?? null,
    toppedUp: info.topped_up_balance ?? null
  };
}

/** Serve the balance (cached briefly so the strip can poll cheaply). */
async function handleBalance(ctx, res) {
  try {
    const now = Date.now();
    if (cachedBalance === null || now - cachedBalanceAt > CACHE_MILLISECONDS) {
      const apiKey = await readApiKey(ctx);
      cachedBalance = apiKey === null
        ? { ok: false, error: "nincs DEEPSEEK_API_KEY a hitelesitesi taroloban" }
        : await queryBalance(apiKey);
      cachedBalanceAt = now;
    }
    sendJson(res, cachedBalance);
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

// ------------------------------------------------------------------------ git

/** Breadth-first search for `.git` directories under one root. */
function findRepositories(root) {
  const found = [];
  let level = [root];

  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && found.length < MAX_REPOSITORIES; depth++) {
    const next = [];
    for (const directory of level) {
      if (existsSync(join(directory, ".git"))) found.push(directory);
      if (found.length >= MAX_REPOSITORIES) break;
      if (depth === MAX_DEPTH) continue;

      let entries = [];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          next.push(join(directory, entry.name));
        }
      }
    }
    level = next;
  }
  return found;
}

/** Parse `git status --porcelain=v1 --branch` into a compact shape. */
function parseStatus(stdout) {
  const files = [];
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      // Examples: "main", "main...origin/main [ahead 1, behind 2]", "No commits yet on main"
      const tracking = /^(?<branch>[^\s.]+|[^.\s][^\s]*?)(?:\.\.\.(?<upstream>\S+))?(?:\s\[(?<track>[^\]]+)\])?$/u.exec(header);
      if (tracking?.groups) {
        branch = tracking.groups.branch ?? null;
        upstream = tracking.groups.upstream ?? null;
        const track = tracking.groups.track ?? "";
        const aheadMatch = /ahead (\d+)/u.exec(track);
        const behindMatch = /behind (\d+)/u.exec(track);
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
        behind = behindMatch ? Number(behindMatch[1]) : 0;
      }
      continue;
    }
    const staged = line.slice(0, 1);
    const unstaged = line.slice(1, 2);
    files.push({
      path: line.slice(3).trim(),
      staged: staged !== " " && staged !== "?",
      unstaged: unstaged !== " ",
      untracked: staged === "?"
    });
  }

  return { branch, upstream, ahead, behind, files };
}

/** One repository snapshot: branch, tracking, file states, recent commits. */
async function describeRepository(path) {
  const [statusResult, logResult] = await Promise.all([
    run("git", ["-C", path, "status", "--porcelain=v1", "--branch"]),
    run("git", ["-C", path, "log", `-n${String(COMMIT_COUNT)}`, "--date=iso-strict", "--pretty=format:%h\u001f%an\u001f%ad\u001f%s"])
  ]);

  if (!statusResult.ok) {
    return { path, ok: false, error: statusResult.stderr.split(/\r?\n/u)[0] || "git status failed" };
  }

  const status = parseStatus(statusResult.stdout);
  const commits = logResult.ok
    ? logResult.stdout.split(/\r?\n/u).filter((line) => line.length > 0).map((line) => {
      const [hash, author, date, subject] = line.split("\u001f");
      return { hash, author, date, subject };
    })
    : [];

  return {
    path,
    ok: true,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    changed: status.files.filter((file) => !file.untracked).length,
    untracked: status.files.filter((file) => file.untracked).length,
    files: status.files.slice(0, 50),
    commits
  };
}

/** Serve the repositories of one workspace root. */
async function handleGit(req, res) {
  try {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const root = url.searchParams.get("root");
    if (root === null || root.length === 0) {
      sendJson(res, { ok: false, error: "hianyzik a root parameter" });
      return;
    }
    if (!existsSync(root)) {
      sendJson(res, { ok: false, error: "a megadott gyoker nem letezik: " + root });
      return;
    }

    const probe = await run("git", ["--version"]);
    if (!probe.ok) {
      sendJson(res, { ok: false, error: "a git nem erheto el a hoston" });
      return;
    }

    const repositories = findRepositories(root);
    const described = [];
    for (const path of repositories) {
      described.push(await describeRepository(path));
    }

    sendJson(res, { ok: true, root, git: probe.stdout.trim(), repositories: described });
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

// ------------------------------------------------------------------- github

/** Parse `gh repo list --json ...` output into a flat array. */
function parseRepoList(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      name: entry.nameWithOwner ?? entry.name ?? "",
      description: entry.description ?? "",
      visibility: entry.visibility ?? (entry.isPrivate === true ? "PRIVATE" : "PUBLIC"),
      updatedAt: entry.updatedAt ?? null,
      url: entry.url ?? null
    }));
  } catch {
    return [];
  }
}

/** GitHub state for the panel: tool availability plus the signed-in account. */
async function handleGithub(req, res) {
  try {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const root = url.searchParams.get("root");

    const [ghVersion, authStatus] = await Promise.all([
      run("gh", ["--version"]),
      run("gh", ["auth", "status"])
    ]);

    if (!ghVersion.ok) {
      sendJson(res, {
        ok: true,
        ghInstalled: false,
        authenticated: false,
        hint: "A GitHub CLI (gh) nincs telepitve a hoston."
      });
      return;
    }

    const listResult = await run("gh", ["repo", "list", "--limit", "60", "--json", "nameWithOwner,description,visibility,updatedAt,url"]);

    sendJson(res, {
      ok: true,
      ghInstalled: true,
      authenticated: authStatus.ok,
      authMessage: authStatus.ok ? null : authStatus.stderr.split(/\r?\n/u)[0],
      repositories: listResult.ok ? parseRepoList(listResult.stdout) : [],
      root
    });
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

/**
 * GitHub action for one repository:
 *   action=create  -> `gh repo create <name> --source <root> --remote origin --push`
 *   action=connect -> `git remote add origin <url>` in the root
 *   action=clone   -> `gh repo clone <nameWithOwner> <target>`
 */
async function handleGithubAction(req, res) {
  try {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const action = url.searchParams.get("action");
    const root = url.searchParams.get("root");
    const name = url.searchParams.get("name");
    const repo = url.searchParams.get("repo");

    if (action === "login") {
      // The interactive sign-in needs a terminal for its prompt; a detached
      // helper window is opened so the user can finish it there, and the panel
      // reports the state after the next refresh.
      try {
        const child = spawn("cmd.exe", ["/c", "start", "GitHub bejelentes", "cmd.exe", "/k", "gh auth login --hostname github.com --git-protocol https --web"], {
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
        child.unref();
        sendJson(res, { ok: true, output: "A bejelentkezesi ablak megnyilt; a bongeszoben hagyd jova." });
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }

    if (action === "create") {
      if (!root || !name) {
        sendJson(res, { ok: false, error: "hianyzik a root vagy a name parameter" });
        return;
      }
      const visibility = url.searchParams.get("visibility") === "public" ? "--public" : "--private";
      const description = url.searchParams.get("description");
      const args = ["repo", "create", name, "--source", root, "--remote", "origin", "--push", visibility];
      if (description) args.push("--description", description);
      const result = await run("gh", args);
      sendJson(res, result.ok
        ? { ok: true, output: result.stdout.trim() }
        : { ok: false, error: result.stderr.split(/\r?\n/u)[0] || "gh repo create failed" });
      return;
    }

    if (action === "connect") {
      if (!root || !repo) {
        sendJson(res, { ok: false, error: "hianyzik a root vagy a repo parameter" });
        return;
      }
      const remoteUrl = `https://github.com/${repo}.git`;
      const existing = await run("git", ["-C", root, "remote", "get-url", "origin"]);
      const result = existing.ok
        ? await run("git", ["-C", root, "remote", "set-url", "origin", remoteUrl])
        : await run("git", ["-C", root, "remote", "add", "origin", remoteUrl]);
      sendJson(res, result.ok
        ? { ok: true, remote: remoteUrl }
        : { ok: false, error: result.stderr.split(/\r?\n/u)[0] || "git remote failed" });
      return;
    }

    if (action === "clone") {
      if (!repo) {
        sendJson(res, { ok: false, error: "hianyzik a repo parameter" });
        return;
      }
      const target = url.searchParams.get("target");
      const args = target ? ["repo", "clone", repo, target] : ["repo", "clone", repo];
      const result = await run("gh", args);
      sendJson(res, result.ok
        ? { ok: true, output: result.stdout.trim() }
        : { ok: false, error: result.stderr.split(/\r?\n/u)[0] || "gh repo clone failed" });
      return;
    }

    if (action === "install-plugin") {
      // Write the profile patch directly from the host: the running server owns
      // the profile, so it needs no helper script, no PowerShell window and no
      // quoting. The patch backup keeps the previous state recoverable.
      try {
        const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
        const patchPath = join(home, "profiles", "web", "cordis.patch.yml");
        const existing = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
        writeFileSync(`${patchPath}.pre-install-backup`, existing, "utf8");

        const body = [
          "# Your patch layer for this dsh profile, applied after every bundle layer:",
          "# a top-level YAML array of loader patch entries (id-targeted config",
          "# overrides, disables, and insert lists; `!!js` expressions allowed).",
          "#",
          "# DeepSeek Harness UI-bovitesek (dsh-ui-extras): sajat panelek.",
          "# Forras: C:\\Szerver\\Deepseek Harness\\plugins\\dsh-ui-extras",
          "# Kikapcsolas: torold az alabbi bejegyzest, majd inditsd ujra a harness-t.",
          "- insert:",
          "    - id: ui-extras",
          "      name: dsh-ui-extras",
          ""
        ].join("\n");
        writeFileSync(patchPath, body, "utf8");
        sendJson(res, { ok: true, output: "A profil patch frissitve: " + patchPath });
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }

    if (action === "restart-node") {
      // Spawn the Node.js restart helper OUTSIDE this process: it kills the
      // listeners, waits for the port to free, starts a fresh server and writes
      // the fresh token URL. A detached Node helper survives the Harness
      // process being killed, unlike a PowerShell one-liner.
      //
      // The helper waits `delay` milliseconds before killing anything. Without
      // that pause the kill races this very response: the socket closes before
      // the browser reads it, the request never settles, and the interface is
      // left on "Reconnecting" with no way back. The client also stops
      // depending on this response (it retries the page reload instead), so the
      // delay only has to cover the normal case.
      const port = url.searchParams.get("port") ?? "3080";
      // A kliens üresen hagyja: a host oldja fel a futó dsh CLI útját.
      const bin = url.searchParams.get("bin") || resolveDshBin();
      const delay = url.searchParams.get("delay") ?? "1500";
      const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
      if (!bin) {
        sendJson(res, { ok: false, error: "hianyzik a bin parameter" });
        return;
      }
      const helper = join(PACKAGE_ROOT, "restart-node.js");
      const child = spawn(process.execPath, [helper, port, bin, home, delay], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      sendJson(res, {
        ok: true,
        url: `/ui-extras/harness-url`,
        output: `A harness ujrainditasa elindult (${Number(delay) || 0} ms mulva all le a szerver).`
      });
      return;
    }
    if (action === "restart") {
      // Restart through the detached helper, NOT by running the restart script
      // in-process: the script waits for the old server to die and the new one
      // to boot, which both blocks this request and gets killed along with the
      // server it is restarting. The helper is a separate Node process with a
      // delayed kill, so this answer always reaches the browser.
      const port = url.searchParams.get("port") ?? "3080";
      // A kliens üresen hagyja: a host oldja fel a futó dsh CLI útját.
      const bin = url.searchParams.get("bin") || resolveDshBin();
      const delay = url.searchParams.get("delay") ?? "1500";
      const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
      if (!bin) {
        sendJson(res, { ok: false, error: "hianyzik a bin parameter" });
        return;
      }
      const helper = join(PACKAGE_ROOT, "restart-node.js");
      const child = spawn(process.execPath, [helper, port, bin, home, delay], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      sendJson(res, {
        ok: true,
        url: "/ui-extras/harness-url",
        output: `A harness ujrainditasa elindult (${Number(delay) || 0} ms mulva all le a szerver).`
      });
      return;
    }
    if (action === "deploy") {
      // Legacy path kept for compatibility: the preferred route is install-plugin
      // + restart-node (see the client's deployPlugin). This one writes the
      // profile patch WITHOUT restarting (`-NoRestart`), then hands the restart
      // over to the same detached helper as `restart`.
      //
      // MIERT NINCS `-Detached`: a `restart-harness.ps1`-ben a `-Detached` ma
      // BELSŐ kapcsoló (a leválasztott másolat jelzése) — átadva a szervert
      // leállítva hagyhatná. A `deploy-plugin.ps1` pedig nem is ismeri, ezért a
      // PowerShell hibát adna, és a patch el sem készülne.
      const script = url.searchParams.get("script") || join(REPO_ROOT, "tools", "deploy-plugin.ps1");
      if (!script) {
        sendJson(res, { ok: false, error: "hianyzik a script parameter" });
        return;
      }
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-NoRestart"];
      const patchChild = spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: true });
      patchChild.unref();

      // A restart ugyanazon az úton, mint a `restart` action: a tálcára bízva,
      // ha az fut (a tálca a DSH folyamatfáján kívül van, ezért nem szakad félbe).
      const port = url.searchParams.get("port") ?? "3080";
      // A kliens üresen hagyja: a host oldja fel a futó dsh CLI útját.
      const bin = url.searchParams.get("bin") || resolveDshBin();
      const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh");
      if (bin) {
        const helper = join(PACKAGE_ROOT, "restart-node.js");
        // 2500 ms: a patch-írás (npm/fs) rendszerint 1 s alatt lefut, a restart
        // előtt viszont be kell fejeződnie, különben a friss patch nem érvényesül.
        const restartChild = spawn(process.execPath, [helper, port, bin, home, "2500"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        restartChild.unref();
      }
      sendJson(res, {
        ok: true,
        url: "/ui-extras/harness-url",
        output: bin
          ? "Az elesites elindult hatterben (patch + ujrainditas a talcan at); a felulet a friss tokenre tolti magat."
          : "A patch elindult hatterben, de a dsh eleresi ut hianyzik, ezert az ujrainditas elmarad."
      });
      return;
    }
    // --- commit / push / description -----------------------------------------
    // Development happens on `main` unless stated otherwise, so push targets the
    // branch's own upstream (or origin/main when it has none).
    if (action === "release") {
      // Kiadás: a teljes folyamat a workspace tools\release.ps1-ében van (verzió +
      // commit + tag + push + GitHub Release). Azért szkript és nem itt: ugyanez
      // parancssorból is elérhető kell legyen, és a Git panel gombja pontosan azt
      // futtatja, amit a fejlesztő kézzel tenne. A szkript `-Yes`-szal fut, mert
      // innen nincs kitől megkérdezni.
      const script = join(REPO_ROOT, "tools", "release.ps1");
      if (!existsSync(script)) {
        sendJson(res, { ok: false, error: "nincs tools/release.ps1 a repo gyökerében" });
        return;
      }
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Yes"];
      const version = url.searchParams.get("version");
      if (version) args.push("-Version", version);
      const bump = url.searchParams.get("bump");
      if (bump) args.push("-Bump", bump);
      const message = url.searchParams.get("message");
      if (message) args.push("-Message", message);
      const child = spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      sendJson(res, {
        ok: true,
        output: "A kiadás elindult (verzió + commit + tag + push + GitHub Release). Az eredmény a Git panelen és a GitHubon látszik."
      });
      return;
    }
    // A robot panel (a 4180-as port) KÜLÖN originen fut, ezért nem látja a DSH
    // témabeállítását. A kliens ezért a témaváltáskor ide szól, és a host
    // szerver-szerver hívással értesíti a robot panelt (böngészőből CORS zárná el).
    if (action === "theme-sync") {
      const value = url.searchParams.get("value") === "light" ? "light" : "dark";
      const port = url.searchParams.get("port") ?? "4180";
      try {
        const response = await fetch(`http://127.0.0.1:${port}/theme`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ theme: value })
        });
        const body = await response.json().catch(() => ({}));
        sendJson(res, { ok: true, output: `robot panel tema: ${value}`, upstream: body });
      } catch (error) {
        sendJson(res, {
          ok: false,
          error: `a robot panel (${port}) nem erheto el: ${String(error?.message ?? error)}`
        });
      }
      return;
    }

    // A robot panel jelenlegi témája (a fenti theme-sync párja): a kliens
    // időnként lekérdezi, így a robot panel saját gombjával indított témaváltás
    // is átkerül a DSH panelekre — kétirányú szinkron.
    if (action === "robot-theme") {
      const port = url.searchParams.get("port") ?? "4180";
      try {
        const response = await fetch(`http://127.0.0.1:${port}/theme`, {
          headers: { accept: "application/json" }
        });
        const body = await response.json().catch(() => ({}));
        sendJson(res, { ok: true, theme: body.theme === "light" ? "light" : "dark" });
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }

    if (action === "commit") {
      if (!root) {
        sendJson(res, { ok: false, error: "hianyzik a root parameter" });
        return;
      }
      const message = url.searchParams.get("message") ?? "";
      // A commit üzenetének nyelve: a felület nyelve nem feltétlenül azonos a
      // repó nyelvével (nyilvános projektnél angol üzenet kell). A kliens ezért
      // külön `lang` paramétert küld; minden ismeretlen érték angolra esik
      // vissza, ami egy nyilvános repónál a biztonságos irány.
      const lang = url.searchParams.get("lang") === "hu" ? "hu" : "en";
      const staged = await run("git", ["-C", root, "add", "-A"]);
      if (!staged.ok) {
        sendJson(res, { ok: false, error: staged.stderr.split(/\r?\n/u)[0] || "git add failed" });
        return;
      }
      const pending = await run("git", ["-C", root, "status", "--porcelain"]);
      if (!pending.ok || pending.stdout.trim().length === 0) {
        sendJson(res, { ok: false, error: "nincs commitolni valo valtozas" });
        return;
      }
      // Default message: date plus the first changed path, so a one-click commit
      // is still self-describing. The language follows the panel's HU/EN switch,
      // so a public repository can be committed in English while the interface
      // stays Hungarian.
      const firstPath = pending.stdout.split(/\r?\n/u)[0].slice(3).trim();
      const date = new Date().toISOString().slice(0, 10);
      const auto = lang === "hu"
        ? "Frissítés " + firstPath + " (" + date + ")"
        : "Update " + firstPath + " (" + date + ")";
      const text = message.trim().length > 0 ? message.trim() : auto;
      const committed = await run("git", ["-C", root, "commit", "-m", text]);
      sendJson(res, committed.ok
        ? { ok: true, output: text, message: text }
        : { ok: false, error: committed.stderr.split(/\r?\n/u)[0] || "git commit failed" });
      return;
    }

    if (action === "push") {
      if (!root) {
        sendJson(res, { ok: false, error: "hianyzik a root parameter" });
        return;
      }
      const upstream = await run("git", ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      const args = upstream.ok && upstream.stdout.trim().length > 0
        ? ["-C", root, "push"]
        : ["-C", root, "push", "-u", "origin", "main"];
      const pushed = await run("git", args);
      sendJson(res, pushed.ok
        ? { ok: true, output: pushed.stdout.trim() || pushed.stderr.trim() || "pushed" }
        : { ok: false, error: pushed.stderr.split(/\r?\n/u)[0] || "git push failed" });
      return;
    }

    if (action === "describe") {
      if (!repo) {
        sendJson(res, { ok: false, error: "hianyzik a repo parameter" });
        return;
      }
      const description = url.searchParams.get("description") ?? "";
      const result = await run("gh", ["repo", "edit", repo, "--description", description]);
      sendJson(res, result.ok
        ? { ok: true, output: description }
        : { ok: false, error: result.stderr.split(/\r?\n/u)[0] || "gh repo edit failed" });
      return;
    }

    sendJson(res, { ok: false, error: "ismeretlen action: " + String(action) });
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

// ------------------------------------------------------------------------ ssh

/**
 * Parse ~/.ssh/config into connection entries. Only the fields the panel shows
 * are read: Host aliases plus the HostName/User/Port/IdentityFile of each block.
 */
function parseSshConfig(text) {
  const connections = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const match = /^(\w+)\s+(.+)$/u.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    const name = key.toLowerCase();

    if (name === "host") {
      // A block may list several aliases; only the first is shown as the name.
      current = { host: value.split(/\s+/u)[0], hostName: null, user: null, port: null, identityFile: null };
      connections.push(current);
      continue;
    }
    if (current === null) continue;
    if (name === "hostname") current.hostName = value;
    else if (name === "user") current.user = value;
    else if (name === "port") current.port = value;
    else if (name === "identityfile") current.identityFile = value;
  }
  return connections;
}

/** The user's SSH directory, honouring USERPROFILE on Windows. */
function sshDirectory() {
  const home = process.env.USERPROFILE ?? homedir();
  return join(home, ".ssh");
}

/** SSH setup for the panel: config aliases, key files, known-hosts count. */
async function handleSsh(req, res, url) {
  try {
    const action = url?.searchParams.get("action") ?? "state";

    if (action === "config") {
      sendJson(res, readSshConfigFile());
      return;
    }
    if (action === "save") {
      const content = url.searchParams.get("content") ?? "";
      sendJson(res, writeSshConfigFile(content));
      return;
    }
    if (action === "test") {
      await testSshConnection(res, url);
      return;
    }
    if (action === "connect") {
      connectSshSession(res, url);
      return;
    }
    if (action === "disconnect") {
      disconnectSshSession(res, url);
      return;
    }
    if (action === "sessions") {
      sendJson(res, { ok: true, sessions: listSshSessions() });
      return;
    }
    if (action !== "state") {
      sendJson(res, { ok: false, error: "ismeretlen action: " + action });
      return;
    }

    const directory = sshDirectory();
    const result = {
      ok: true,
      directory,
      exists: existsSync(directory),
      connections: [],
      keys: [],
      knownHosts: 0,
      agentKeys: null,
      sessions: listSshSessions()
    };

    if (!result.exists) {
      sendJson(res, result);
      return;
    }

    // Connection aliases.
    const configPath = join(directory, "config");
    if (existsSync(configPath)) {
      result.connections = parseSshConfig(readFileSync(configPath, "utf8"));
    }

    // Key files: fingerprints only, never the key material.
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch { }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".pub")) continue;
      const fingerprint = await run("ssh-keygen", ["-lf", join(directory, entry.name)]);
      result.keys.push({
        name: entry.name.replace(/\.pub$/u, ""),
        fingerprint: fingerprint.ok ? fingerprint.stdout.trim() : null
      });
    }

    // Known hosts: one entry per non-empty, non-comment line.
    const knownHostsPath = join(directory, "known_hosts");
    if (existsSync(knownHostsPath)) {
      result.knownHosts = readFileSync(knownHostsPath, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0 && !line.startsWith("#"))
        .length;
    }

    // Keys currently loaded into the agent, when an agent is running.
    const agent = await run("ssh-add", ["-l"]);
    if (agent.ok) {
      result.agentKeys = agent.stdout
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => line.trim());
    }

    sendJson(res, result);
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

/** Commented starting point for a fresh ~/.ssh/config. */
const SSH_CONFIG_TEMPLATE = [
  "# SSH kapcsolatok a DeepSeek Harness panelhez.",
  "#",
  "# Egy bejegyzes igy nez ki:",
  "#",
  "# Host sajatnev",
  "#     HostName 192.168.1.10",
  "#     User felhasznalo",
  "#     Port 22",
  "#     IdentityFile ~/.ssh/id_ed25519",
  ""
].join("\n");

/**
 * Read the SSH config for the built-in editor. A NEW file starts from a worked
 * example instead of an empty box, so the first save cannot produce a file whose
 * syntax the user has to guess.
 */
function readSshConfigFile() {
  const directory = sshDirectory();
  const configPath = join(directory, "config");
  try {
    if (existsSync(configPath)) {
      const stat = statSync(configPath);
      return {
        ok: true,
        path: configPath,
        exists: true,
        content: readFileSync(configPath, "utf8"),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
    }
    return {
      ok: true,
      path: configPath,
      exists: false,
      content: SSH_CONFIG_TEMPLATE,
      size: 0,
      modifiedAt: null
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Save the SSH config from the built-in editor.
 *
 * Two safety rules: the previous file is backed up next to it (so a broken edit
 * is recoverable without a git history), and the content is written atomically,
 * because a half-written config breaks every ssh invocation at once.
 */
function writeSshConfigFile(content) {
  const directory = sshDirectory();
  const configPath = join(directory, "config");
  try {
    mkdirSync(directory, { recursive: true });
    let backup = null;
    if (existsSync(configPath)) {
      backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
      copyFileSync(configPath, backup);
    }
    const temporary = `${configPath}.tmp-${String(process.pid)}`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, configPath);

    const connections = parseSshConfig(content);
    return {
      ok: true,
      path: configPath,
      backup,
      bytes: Buffer.byteLength(content, "utf8"),
      connectionCount: connections.length,
      output: `Mentve: ${configPath} (${String(connections.length)} kapcsolat)` +
        (backup === null ? "" : `\nMentes elotte: ${backup}`)
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Live SSH sessions kept open by the panel, keyed by the connection alias.
 *
 * A connection test answers one question and exits; this is the other half —
 * a channel that stays open until the user closes it, so "disconnect" has
 * something real to close and nothing keeps running unnoticed in the
 * background. Each entry holds the child process and its state.
 */
const SSH_SESSIONS = new Map();

/** How a live session is kept open: read the remote stdin until it is closed. */
const SSH_KEEPALIVE_COMMAND = "cat";

/** Seconds between SSH-level keepalives on a live session. */
const SSH_KEEPALIVE_INTERVAL = 15;

/**
 * Open a live SSH session for one alias and keep it open.
 *
 * The remote runs `cat` and consumes stdin, so the channel lives exactly as long
 * as this process holds its stdin pipe. Closing that pipe (or killing the
 * process, which is what the panel's disconnect does) ends the session
 * immediately, with no orphaned ssh left behind.
 */
function connectSshSession(res, url) {
  const alias = url.searchParams.get("host") ?? "";
  if (!alias) {
    sendJson(res, { ok: false, error: "hianyzik a host parameter" });
    return;
  }
  if (SSH_SESSIONS.has(alias)) {
    const existing = SSH_SESSIONS.get(alias);
    if (isProcessAlive(existing.pid)) {
      sendJson(res, { ok: true, already: true, session: describeSession(alias, existing), output: `Mar nyitva: ${alias}` });
      return;
    }
    SSH_SESSIONS.delete(alias);
  }

  const known = parseSshConfig(safeReadFile(join(sshDirectory(), "config")))
    .find((connection) => connection.host === alias);
  const address = known !== undefined
    ? (known.hostName ?? null)
    : alias;
  if (address === null) {
    sendJson(res, { ok: false, error: "ennek a bejegyzesnek nincs HostName mezoje, ezert nem nyithato" });
    return;
  }
  const target = known !== undefined && known.user
    ? `${known.user}@${address}`
    : address;

  try {
    const child = spawn("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ServerAliveInterval=" + String(SSH_KEEPALIVE_INTERVAL),
      "-o", "ServerAliveCountMax=3",
      target,
      SSH_KEEPALIVE_COMMAND
    ], {
      windowsHide: true,
      // stdin stays a pipe: holding it open is what keeps the session alive.
      stdio: ["pipe", "pipe", "pipe"]
    });

    const session = {
      alias,
      target,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      child,
      stderr: "",
      exited: false,
      exitCode: null
    };
    SSH_SESSIONS.set(alias, session);

    child.stderr.on("data", (chunk) => {
      session.stderr = (session.stderr + String(chunk)).slice(-2000);
    });
    child.stdout.on("data", () => { });
    child.on("close", (code) => {
      session.exited = true;
      session.exitCode = code;
      // Keep the record so the panel can still explain why it ended, but drop it
      // from the live set after a while so it does not linger forever.
      setTimeout(() => {
        if (SSH_SESSIONS.get(alias) === session) SSH_SESSIONS.delete(alias);
      }, 60000);
    });
    child.on("error", (error) => {
      session.exited = true;
      session.stderr = String(error?.message ?? error);
    });

    sendJson(res, {
      ok: true,
      session: describeSession(alias, session),
      output: `Kapcsolodva: ${target} (pid ${String(child.pid)})`
    });
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

/** Close a live session: end its stdin, then make sure the process is gone. */
function disconnectSshSession(res, url) {
  const alias = url.searchParams.get("host") ?? "";
  const session = SSH_SESSIONS.get(alias);
  if (session === undefined) {
    sendJson(res, { ok: true, closed: false, output: `Nem volt nyitva: ${alias}` });
    return;
  }

  try {
    // Closing stdin ends the remote `cat`, which closes the channel politely.
    try { session.child.stdin.end(); } catch { }
    try { session.child.kill(); } catch { }
    SSH_SESSIONS.delete(alias);
    sendJson(res, { ok: true, closed: true, output: `Lecsatlakozva: ${session.target}` });
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

/** Is a pid still running? Signal 0 only tests for existence. */
function isProcessAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One session as the panel sees it: no process handle, no secrets. */
function describeSession(alias, session) {
  return {
    alias,
    target: session.target,
    pid: session.pid,
    startedAt: session.startedAt,
    live: session.exited !== true && isProcessAlive(session.pid),
    exitCode: session.exitCode,
    detail: session.exited === true ? session.stderr.trim().split(/\r?\n/u)[0] ?? null : null
  };
}

/** Every session this plugin currently holds, live or just finished. */
function listSshSessions() {
  const sessions = [];
  for (const [alias, session] of SSH_SESSIONS) {
    sessions.push(describeSession(alias, session));
  }
  return sessions;
}

/**
 * Try one SSH connection and report what happened.
 *
 * `ssh` itself is the test, in batch mode with a deadline: a working key gives
 * the remote banner, while a refused or unreachable host is reported as the
 * connection error instead of silently waiting for a password prompt that a
 * browser request can never answer.
 */
async function testSshConnection(res, url) {
  const target = url.searchParams.get("host") ?? "";
  if (!target) {
    sendJson(res, { ok: false, error: "hianyzik a host parameter" });
    return;
  }

  // A named alias is resolved through the config; a raw address is used as is.
  const known = parseSshConfig(safeReadFile(join(sshDirectory(), "config")))
    .find((connection) => connection.host === target);
  const resolved = known !== undefined
    ? [known.hostName ?? known.host, known.user === null ? null : `${known.user}@${known.hostName ?? known.host}`]
    : [target, target];

  const started = Date.now();
  const result = await run("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    resolved[1],
    "echo dsh-ok"
  ], SSH_TEST_TIMEOUT_MS);
  const elapsed = Math.round((Date.now() - started) / 1000);

  const detail = (result.stdout + result.stderr).split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 6)
    .join("\n");

  if (result.ok && result.stdout.includes("dsh-ok")) {
    sendJson(res, {
      ok: true,
      host: resolved[0],
      alias: known === undefined ? null : known.host,
      seconds: elapsed,
      output: `Kapcsolodas rendben: ${resolved[0]} (${String(elapsed)} mp)`
    });
    return;
  }

  sendJson(res, {
    ok: false,
    host: resolved[0],
    alias: known === undefined ? null : known.host,
    seconds: elapsed,
    error: detail.length > 0 ? detail : "a kapcsolodas nem sikerult",
    hint: /permission denied|publickey/iu.test(detail)
      ? "A szerver elutasította a kulcsot. Ellenőrizd az IdentityFile-t és hogy a nyilvános kulcs fent van-e a szerveren."
      : /host key verification failed/iu.test(detail)
        ? "A hoszt kulcsa nem egyezik a known_hosts bejegyzéssel."
        : /timed out|unreachable|refused/iu.test(detail)
          ? "A hoszt nem elérhető ebből a hálózatból (tűzfal, VPN vagy hibás cím)."
          : null
  });
}

/** Read a file, returning an empty string when it does not exist or cannot be read. */
function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ------------------------------------------------------- terminal and commands

/**
 * In-memory command registry. The panel runs one command per workspace entry and
 * polls its buffered output, so no websocket is needed and a page reload does not
 * lose a running process' output.
 */
const RUNS = new Map();
let runSequence = 0;

/** Append one chunk to a run's bounded output buffer. */
function appendOutput(run, chunk) {
  run.output += chunk;
  if (run.output.length > 200000) run.output = run.output.slice(-200000);
}

/** The workspace-level run-command configuration path. */
function runnablesPath() {
  return join(PACKAGE_ROOT, "..", "..", "state", "runnables.json");
}

/** Read the configured run commands (per workspace root). */
function readRunnables() {
  try {
    return JSON.parse(readFileSync(runnablesPath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Persist the run commands.
 *
 * The failure is returned rather than swallowed: "the save button did nothing"
 * is exactly what a silent write error looks like from the interface, and the
 * panel needs something to show.
 * @param data - the whole runnable document.
 * @returns null on success, or the reason it failed.
 */
function writeRunnables(data) {
  try {
    mkdirSync(join(PACKAGE_ROOT, "..", "..", "state"), { recursive: true });
    writeFileSync(runnablesPath(), JSON.stringify(data, null, 2), "utf8");
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

/** npm scripts of one workspace, when it has a package.json. */
function npmScriptsOf(workspace) {
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {};
    return Object.keys(scripts).map((name) => ({
      id: "npm:" + name,
      label: "npm run " + name,
      command: "npm run " + name,
      source: "package.json"
    }));
  } catch {
    return [];
  }
}

/** Everything runnable for one workspace: npm scripts plus saved custom commands. */
function runnablesOf(workspace) {
  const saved = readRunnables();
  const custom = Array.isArray(saved[workspace]) ? saved[workspace] : [];
  return { npm: npmScriptsOf(workspace), custom };
}

/**
 * Start a terminal session in a workspace and return its run id.
 *
 * The child is an INTERACTIVE shell that stays alive until it is closed: stdin
 * remains open for further commands, so the panel behaves like a real terminal
 * (a prompt, several commands in a row, a persistent working directory) instead
 * of a one-shot command runner. The command, when there is one, is the first
 * thing that shell reads.
 */
function startRun(workspace, command) {
  const id = "run-" + String(++runSequence);
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  // `-NoExit -Command -` reads statements from stdin and keeps the session.
  const shellArgs = process.platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "-"]
    : ["-i"];

  // spawn, not execFile: the terminal panel writes to the process's standard
  // input, which is what keeps the session interactive.
  //
  // `detached` on POSIX puts the shell in its own process GROUP, which is what
  // lets a stop signal reach the commands it started (`killRun`); on Windows it
  // would open a console window, and the tree is taken by `taskkill /T` instead.
  const child = spawn(shell, shellArgs, {
    cwd: workspace,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });

  const run = {
    id,
    workspace,
    command: command ?? "",
    label: command && command.length > 0 ? command : "shell",
    startedAt: new Date().toISOString(),
    output: "",
    done: false,
    code: null,
    // Whether the child owns its process group (POSIX only); `killRun` needs it.
    detached: process.platform !== "win32",
    // Where the shell's own output starts; everything before it is the echoed
    // command, which the panel draws differently.
    promptAt: 0,
    child
  };

  child.stdout?.on("data", (chunk) => appendOutput(run, chunk.toString()));
  child.stderr?.on("data", (chunk) => appendOutput(run, chunk.toString()));
  child.on("close", (code) => {
    run.done = true;
    run.code = code;
    appendOutput(run, "\r\n[vege, kilepesi kod: " + String(code) + "]\r\n");
    // A session that ended is removed after a short grace period, so the panel
    // can still read its last output — but not so long that a closed terminal
    // looks like it came back. `action=forget` removes one immediately.
    setTimeout(() => {
      if (RUNS.get(id) === run && run.forgotten !== true) RUNS.delete(id);
    }, 15000);
  });

  RUNS.set(id, run);
  // Several terminals can run at once, so the history is deeper than a single
  // command's would need to be.
  if (RUNS.size > 24) {
    const oldest = [...RUNS.keys()][0];
    RUNS.delete(oldest);
  }

  // A command given at start-up is typed into the session, exactly as if the
  // user had written it, so the session then waits for the next one.
  if (typeof command === "string" && command.trim().length > 0) {
    setTimeout(() => {
      try {
        writeToRun(run, command + "\n");
      } catch { }
    }, 150);
  }
  return id;
}

/**
 * Write a line (or a multi-line block) to a session's input.
 *
 * Multi-line text is sent as it is: PowerShell reads statements line by line, so
 * a whole block can be pasted in at once, which is what makes multi-line
 * commands work.
 *
 * `promptAt`/`echoAt` mark the two boundaries the panel needs. `promptAt` is
 * where this write starts, so everything after it is the shell's fresh output.
 * `echoAt` is where that output starts, so everything between the two is the
 * line the shell echoed back — which the panel shows on its own, without
 * repeating the result.
 */
function writeToRun(run, text) {
  if (run.done === true) return { ok: false, error: "a folyamat mar lezarult" };
  if (!run.child || !run.child.stdin) return { ok: false, error: "a folyamat bemenete nem iranyithato" };
  const payload = text.endsWith("\n") ? text : text + "\n";
  run.promptAt = run.output.length;
  run.echoAt = null;
  run.child.stdin.write(payload);
  // The shell echoes the line back as it reads it; that echo is the boundary.
  // A timer because the echo is written asynchronously, and the write must not
  // block on it.
  const before = run.output.length;
  setTimeout(() => {
    if (run.echoAt === null && run.output.length > before) run.echoAt = before;
  }, 250);
  return { ok: true };
}

/**
 * The shell and its process TREE, deepest first.
 *
 * `taskkill /F /T` is what normally ends a run, and it does take `npm run dev`
 * and the dev server it starts. It cannot be the only answer, though: a native
 * child that was already re-parented when its parent died survives the tree walk,
 * and such an orphan keeps holding its port — the "stuck process I cannot stop"
 * this panel must never produce. Enumerating the descendants BEFORE the kill is
 * therefore what makes an explicit cleanup possible afterwards; the ids are
 * returned deepest-first so no parent is removed while its children still exist.
 * @param rootPid - the run's shell process id.
 * @returns descendant pids, deepest first (empty when the tree cannot be read).
 */
function descendantPids(rootPid) {
  if (process.platform !== "win32" || typeof rootPid !== "number") return [];
  try {
    const script = [
      "$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId",
      `$root = ${rootPid}`,
      "$byParent = @{}",
      "foreach ($p in $all) { if (-not $byParent.ContainsKey([int]$p.ParentProcessId)) { $byParent[[int]$p.ParentProcessId] = @() }; $byParent[[int]$p.ParentProcessId] += [int]$p.ProcessId }",
      "$order = New-Object System.Collections.ArrayList",
      "function Walk($id) { foreach ($child in $byParent[$id]) { Walk $child; [void]$order.Add($child) } }",
      "Walk $root",
      "$order -join ','"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000
    });
    const raw = String(result.stdout ?? "").trim();
    if (raw === "") return [];
    return raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

/**
 * Stop one run: the shell AND whatever it started.
 *
 * Measured: `child.kill()` alone ends the shell and leaves the whole command
 * tree running — `npm run dev`, a webpack watcher, a `php artisan serve` keep
 * going and keep holding their port, which is exactly the "stuck process I cannot
 * stop" a terminal panel must not produce. `taskkill /F /T /PID` (Win32) and a
 * negative-pid signal to the detached process group (POSIX) take the children
 * with them. `detached` is false for a run that never owned its process group, so
 * a plain `kill` stays the fallback.
 *
 * The chosen strategy and the pids involved are recorded on `run.evidence` so the
 * host log and the check script can see WHICH stop was used instead of guessing.
 * @param run - the registry entry.
 * @returns null on success, or the failure text.
 */
function killRun(run) {
  const child = run?.child;
  if (child === undefined || child === null) return null;
  try {
    if (process.platform === "win32" && typeof child.pid === "number") {
      const descendants = descendantPids(child.pid);
      // /T takes the tree, /F makes it immediate: the shell has no console to
      // answer a graceful request in the first place.
      const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        windowsHide: true,
        timeout: 10000
      });
      // Anything that survived the walk (a re-parented orphan) is killed by pid.
      // A pid that is already gone makes taskkill report an error and changes
      // nothing, so this can be run unconditionally.
      const survivors = descendants.filter((pid) => isAlive(pid));
      for (const pid of survivors) {
        try {
          spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true, timeout: 5000 });
        } catch {
          // Best effort: the tree kill already reported its own result.
        }
      }
      run.evidence = {
        strategy: survivors.length > 0 ? "taskkill /F /T + orphan sweep" : "taskkill /F /T",
        pid: child.pid,
        descendants: descendants.length,
        orphans: survivors.length,
        status: result.status,
        stdout: String(result.stdout ?? "").trim().slice(0, 200),
        error: result.error === undefined || result.error === null ? null : String(result.error.message ?? result.error)
      };
      if (result.status === 0 || survivors.length > 0) return null;
      // A failing taskkill on a process that is already gone is success.
      if (isAlive(child.pid) !== true) return null;
    } else if (run.detached === true && typeof child.pid === "number") {
      process.kill(-child.pid, "SIGTERM");
      run.evidence = { strategy: "process-group SIGTERM", pid: child.pid };
      return null;
    }
  } catch (error) {
    run.evidence = { strategy: "fallback", error: String(error?.message ?? error) };
  }
  try {
    const killed = child.kill();
    run.evidence = Object.assign({ strategy: "child.kill" }, run.evidence ?? {}, { killed });
    return killed === false ? "a folyamat nem vette a leallitast" : null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

/**
 * Whether a process id is still there.
 * @param pid - the process id to test.
 * @returns true when the process exists.
 */
function isAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

/** Serve the run-command routes. */
async function handleCmd(req, res, url) {
  try {
    const action = url.searchParams.get("action") ?? "list";
    const workspace = url.searchParams.get("workspace") ?? "";

    if (action === "list") {
      if (!workspace) {
        sendJson(res, { ok: false, error: "hianyzik a workspace parameter" });
        return;
      }
      sendJson(res, { ok: true, workspace, ...runnablesOf(workspace) });
      return;
    }

    if (action === "add" || action === "remove") {
      if (!workspace) {
        sendJson(res, { ok: false, error: "hianyzik a workspace parameter" });
        return;
      }
      const name = url.searchParams.get("name") ?? "";
      const command = url.searchParams.get("command") ?? "";
      // The label is what the quick-command button shows. Deriving it from the
      // first word alone made "npm run build" appear as "npm", which is
      // misleading, so the whole command is the label unless one is given.
      const label = url.searchParams.get("label") ?? command;
      const all = readRunnables();
      const list = Array.isArray(all[workspace]) ? all[workspace] : [];
      if (action === "add") {
        if (!name || !command) {
          sendJson(res, { ok: false, error: "hianyzik a name vagy a command parameter" });
          return;
        }
        const existing = list.filter((entry) => entry.id !== "custom:" + name);
        existing.push({ id: "custom:" + name, label, command, source: "custom" });
        all[workspace] = existing;
        const addFailure = writeRunnables(all);
        if (addFailure !== null) {
          sendJson(res, { ok: false, error: "a mentes nem sikerult: " + addFailure });
          return;
        }
        sendJson(res, { ok: true, workspace, ...runnablesOf(workspace) });
        return;
      }
      all[workspace] = list.filter((entry) => entry.id !== "custom:" + name);
      const failure = writeRunnables(all);
      if (failure !== null) {
        sendJson(res, { ok: false, error: "a mentes nem sikerult: " + failure });
        return;
      }
      sendJson(res, { ok: true, workspace, ...runnablesOf(workspace) });
      return;
    }

    if (action === "runs") {
      // Every known run with its output so far. The panel renders several
      // terminals at once and can be reopened or reloaded at any time, so the
      // list is the source of truth instead of whatever the page happened to
      // accumulate.
      const runs = [];
      for (const run of RUNS.values()) {
        runs.push({
          id: run.id,
          workspace: run.workspace,
          command: run.command,
          label: run.label,
          startedAt: run.startedAt,
          done: run.done,
          code: run.code,
          // `promptAt` and `echoAt` mark where the shell's own output starts and
          // where the echoed input line starts: the panel draws the echo as
          // input instead of repeating it as output.
          promptAt: run.promptAt,
          echoAt: run.echoAt === null || run.echoAt === undefined ? null : run.echoAt,
          length: run.output.length,
          output: run.output
        });
      }
      sendJson(res, { ok: true, runs });
      return;
    }

    if (action === "run") {
      if (!workspace) {
        sendJson(res, { ok: false, error: "hianyzik a workspace parameter" });
        return;
      }
      // No command at all is valid: that is an EMPTY terminal, which is what the
      // panel's "+" needs.
      const command = url.searchParams.get("command") ?? "";
      sendJson(res, { ok: true, id: startRun(workspace, command) });
      return;
    }

    if (action === "output") {
      const id = url.searchParams.get("id") ?? "";
      const run = RUNS.get(id);
      if (run === undefined) {
        sendJson(res, { ok: false, error: "ismeretlen futas: " + id });
        return;
      }
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      sendJson(res, {
        ok: true,
        id: run.id,
        done: run.done,
        code: run.code,
        length: run.output.length,
        chunk: run.output.slice(since)
      });
      return;
    }

    if (action === "stdin") {
      // Send a line (or a whole multi-line block) to a live session's input.
      const id = url.searchParams.get("id") ?? "";
      const run = RUNS.get(id);
      if (run === undefined) {
        sendJson(res, { ok: false, error: "ismeretlen futas: " + id });
        return;
      }
      const data = url.searchParams.get("data") ?? "";
      sendJson(res, writeToRun(run, data));
      return;
    }

    if (action === "forget") {
      // Drop a run for good. Without this the panel's "clean up" and its
      // per-terminal close were undone by the next poll: a finished run stays in
      // the registry for a while so its last output can still be read, and the
      // poll brought it straight back.
      const id = url.searchParams.get("id") ?? "";
      const run = RUNS.get(id);
      if (run === undefined) {
        sendJson(res, { ok: true, forgotten: false });
        return;
      }
      // The whole tree, not just the shell: a forgotten terminal must not leave
      // the command it started holding a port.
      killRun(run);
      RUNS.delete(id);
      sendJson(res, { ok: true, forgotten: true });
      return;
    }

    if (action === "kill") {
      const id = url.searchParams.get("id") ?? "";
      const run = RUNS.get(id);
      if (run === undefined) {
        sendJson(res, { ok: false, error: "ismeretlen futas: " + id });
        return;
      }
      const killFailure = killRun(run);
      sendJson(res, killFailure === null ? { ok: true, tree: true } : { ok: false, error: killFailure });
      return;
    }

    sendJson(res, { ok: false, error: "ismeretlen action: " + action });
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

// -------------------------------------------------------- remembered approvals

/**
 * Remembered approval types — the "ne kérdezze meg többször" mechanism.
 *
 * The built-in approval seam has exactly one grant: `allowed-once`. Every wider
 * retry therefore asks again, even when the user answered the very same question
 * a minute earlier. This half remembers a decision for one approval TYPE and
 * answers the `approval/request` waterfall itself, so a remembered type stops
 * prompting — while every other type keeps asking.
 *
 * What a "type" is, and why it is deliberately narrow:
 *
 *   * A sandbox escalation (`escalate sandbox to <mode>: <justification>`) is
 *     remembered per TARGET MODE. Widening the fence to `danger-full-access` is
 *     one decision whoever asks for it, so that type may be remembered for one
 *     tool or for every tool. A remembered `danger-full-access` never answers an
 *     `workspace-write` request: this is a remembered permission for one
 *     access type, NOT a blanket "no more approvals" switch.
 *   * Any other reason has no vocabulary to key on, so it is remembered for the
 *     exact tool and the exact reason text the user actually saw. A wider rule
 *     would grant more than the card ever showed.
 *
 * The document is a plain JSON file in the workspace's `state` directory, next
 * to the panel layout, so it is inspectable and deletable by hand.
 */

/** Path of the remembered-approval document: `state/approvals.json`. */
function approvalsPath() {
  return join(PACKAGE_ROOT, "..", "..", "state", "approvals.json");
}

/** Document version, so a later shape change can migrate instead of guessing. */
const APPROVALS_VERSION = 1;

/** How many decisions the document keeps for inspection. */
const APPROVAL_LOG_LIMIT = 60;

/** Human labels for the sandbox modes an escalation can target. */
const SANDBOX_MODE_LABELS = {
  "read-only": { hu: "csak olvasás (read-only)", en: "read-only" },
  "workspace-write": { hu: "munkaterület-írás (workspace-write)", en: "workspace write" },
  "danger-full-access": { hu: "teljes hozzáférés (danger-full-access)", en: "full access (danger-full-access)" }
};

/** An empty, valid approval document. */
function emptyApprovals() {
  return { version: APPROVALS_VERSION, rules: [], log: [] };
}

/** Whether one stored entry is a rule this module can match and display. */
function isApprovalRule(rule) {
  return rule !== null && typeof rule === "object"
    && typeof rule.id === "string"
    && typeof rule.key === "string"
    && typeof rule.kind === "string"
    && typeof rule.target === "string"
    && (rule.tools === null || Array.isArray(rule.tools));
}

/** Read the remembered approvals; an unreadable file is an empty document. */
function readApprovals() {
  try {
    const parsed = JSON.parse(readFileSync(approvalsPath(), "utf8"));
    if (parsed === null || typeof parsed !== "object") return emptyApprovals();
    return {
      version: APPROVALS_VERSION,
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter(isApprovalRule) : [],
      log: Array.isArray(parsed.log) ? parsed.log.slice(0, APPROVAL_LOG_LIMIT) : []
    };
  } catch {
    return emptyApprovals();
  }
}

/**
 * Write the document through a temporary file, so a crash mid-write cannot
 * leave a half-written rule list that fail-closed matching would then misread.
 * @returns the failure message, or null when the write landed.
 */
function writeApprovals(document) {
  try {
    const target = approvalsPath();
    const temporary = `${target}.tmp`;
    mkdirSync(join(PACKAGE_ROOT, "..", "..", "state"), { recursive: true });
    writeFileSync(temporary, JSON.stringify(document, null, 2), "utf8");
    renameSync(temporary, target);
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

/** Collapse a free-form reason into a comparable one-line signature. */
function reasonSignature(reason) {
  return String(reason ?? "").replace(/\s+/gu, " ").trim().slice(0, 400);
}

/**
 * Derive the approval TYPE of one request from what the asker actually sent.
 *
 * @param toolName - tool whose operation needs the decision.
 * @param reason - the asker's explanation (the only vocabulary a request has).
 * @returns the type: its key for matching, both labels, and which scopes the
 *   approval card may offer for it.
 */
function approvalTypeOf(toolName, reason) {
  const text = reasonSignature(reason);
  const escalation = /^escalate sandbox to ([A-Za-z0-9_-]+):\s*([\s\S]*)$/u.exec(text);
  if (escalation !== null) {
    const target = escalation[1];
    const label = SANDBOX_MODE_LABELS[target] ?? { hu: target, en: target };
    return {
      kind: "sandbox-escalation",
      target,
      key: `sandbox-escalation|${target}`,
      labelHu: label.hu,
      labelEn: label.en,
      justification: escalation[2].trim(),
      scopes: ["tool", "all"]
    };
  }
  return {
    kind: "reason",
    target: text,
    key: `reason|${text}`,
    labelHu: text === "" ? "(nincs megadott indok)" : text.slice(0, 180),
    labelEn: text === "" ? "(no reason given)" : text.slice(0, 180),
    justification: "",
    scopes: ["tool"]
  };
}

/** Whether one rule's tool scope covers the asking tool. */
function ruleCoversTool(rule, toolName) {
  if (!Array.isArray(rule.tools) || rule.tools.length === 0) return true;
  return rule.tools.includes(toolName);
}

/**
 * The remembered rule that already answers this request, or null. Fail-closed:
 * an unknown kind or target never matches, and a rule that only covers one tool
 * does not answer another tool's request.
 */
function findApprovalRule(rules, toolName, reason) {
  const type = approvalTypeOf(toolName, reason);
  for (const rule of rules) {
    if (rule.kind !== type.kind || rule.target !== type.target) continue;
    if (!ruleCoversTool(rule, toolName)) continue;
    return rule;
  }
  return null;
}

/** One new rule id; readable and unique enough for a local document. */
function newApprovalRuleId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append one audit line to the document's bounded log. */
function appendApprovalLog(document, entry) {
  document.log.unshift(entry);
  if (document.log.length > APPROVAL_LOG_LIMIT) document.log.length = APPROVAL_LOG_LIMIT;
}

/** The same tool scope, expressed for storage (null means "every tool"). */
function approvalToolsFor(scope, toolName) {
  return scope === "all" ? null : [toolName];
}

/** Read, mutate, write — the three steps every route performs. */
function updateApprovals(mutate) {
  const document = readApprovals();
  mutate(document);
  return { document, error: writeApprovals(document) };
}

/** The type as the browser needs it: no storage fields, both labels. */
function describeApprovalType(type) {
  return {
    kind: type.kind,
    target: type.target,
    key: type.key,
    labelHu: type.labelHu,
    labelEn: type.labelEn,
    justification: type.justification,
    scopes: type.scopes
  };
}

/** Read one JSON request body, bounded so a broken client cannot balloon. */
function readJsonBody(req, limit, done) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      done(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      done(error, null);
    }
  });
  req.on("error", (error) => done(error, null));
}

/**
 * The approval store's one route: read the rules, or act on them.
 *
 * Every write answers with the resulting rule list, so the panel renders what
 * the host stored instead of what it hoped it stored.
 */
function handleApprovals(req, res, url) {
  if (String(req.method ?? "GET").toUpperCase() === "GET") {
    const toolName = url.searchParams.get("toolName") ?? "";
    const reason = url.searchParams.get("reason") ?? "";
    const document = readApprovals();
    sendJson(res, {
      ok: true,
      rules: document.rules,
      log: document.log.slice(0, 25),
      type: toolName === "" ? null : describeApprovalType(approvalTypeOf(toolName, reason)),
      covered: toolName !== "" && findApprovalRule(document.rules, toolName, reason) !== null
    });
    return;
  }

  readJsonBody(req, 64 * 1024, (error, body) => {
    if (error !== null) {
      sendJson(res, { ok: false, error: "a keres test nem ertelmezheto JSON-kent" });
      return;
    }
    const action = String(body?.action ?? "");
    const at = new Date().toISOString();

    if (action === "remember") {
      const toolName = typeof body?.toolName === "string" ? body.toolName : "";
      if (toolName === "") {
        sendJson(res, { ok: false, error: "hianyzik a toolName" });
        return;
      }
      const reason = typeof body?.reason === "string" ? body.reason : "";
      const type = approvalTypeOf(toolName, reason);
      // Only a type that has a real vocabulary may be widened to every tool.
      const scope = body?.scope === "all" && type.scopes.includes("all") ? "all" : "tool";
      const tools = approvalToolsFor(scope, toolName);
      let stored = null;
      const result = updateApprovals((document) => {
        const existing = document.rules.find((rule) => rule.key === type.key
          && JSON.stringify(rule.tools ?? null) === JSON.stringify(tools));
        if (existing !== undefined) {
          existing.labelHu = type.labelHu;
          existing.labelEn = type.labelEn;
          if (type.justification !== "") existing.note = type.justification;
          existing.updatedAt = at;
          stored = existing;
          appendApprovalLog(document, { at, event: "remember-again", key: type.key, toolName, scope, label: type.labelHu });
          return;
        }
        const rule = {
          id: newApprovalRuleId(),
          key: type.key,
          kind: type.kind,
          target: type.target,
          tools,
          labelHu: type.labelHu,
          labelEn: type.labelEn,
          note: type.justification,
          createdAt: at,
          updatedAt: at,
          hits: 0
        };
        document.rules.unshift(rule);
        appendApprovalLog(document, { at, event: "remember", key: type.key, toolName, scope, label: type.labelHu });
        stored = rule;
      });
      appendClientLog(`approval remembered: ${type.key} (${scope === "all" ? "minden eszköz" : toolName})`
        + (result.error === null ? "" : `, write failed: ${result.error}`));
      sendJson(res, {
        ok: result.error === null,
        error: result.error,
        rule: stored,
        rules: result.document.rules
      });
      return;
    }

    if (action === "forget") {
      const id = typeof body?.id === "string" ? body.id : "";
      let removed = null;
      const result = updateApprovals((document) => {
        removed = document.rules.find((rule) => rule.id === id) ?? null;
        document.rules = document.rules.filter((rule) => rule.id !== id);
        if (removed !== null) appendApprovalLog(document, { at, event: "forget", key: removed.key, label: removed.labelHu });
      });
      appendClientLog(`approval rule revoked: ${removed === null ? id : removed.key}`);
      sendJson(res, { ok: result.error === null, error: result.error, rules: result.document.rules });
      return;
    }

    if (action === "clear" || action === "clear-log") {
      const result = updateApprovals((document) => {
        if (action === "clear") {
          const count = document.rules.length;
          document.rules = [];
          appendApprovalLog(document, { at, event: "clear", label: `${count} szabály törölve` });
          return;
        }
        document.log = [];
      });
      sendJson(res, { ok: result.error === null, error: result.error, rules: result.document.rules, log: result.document.log });
      return;
    }

    sendJson(res, { ok: false, error: `ismeretlen muvelet: ${action}` });
  });
}

/**
 * Answer a remembered approval type on the host, before the browser is asked.
 *
 * `prepend` is load-bearing: the browser's answerer is the Remote forwarder,
 * which registers when its own plugin loads — earlier than this one. Without
 * prepending, the page would already be showing the prompt by the time this
 * listener ran, and the remembered type would prompt again.
 *
 * Only `allowed-once` is a legal outcome, so a remembered rule answers exactly
 * like a user pressing the button, and every other outcome path (an aborted
 * request, a `never` policy) is left untouched: the policy check happens in the
 * approval service BEFORE the waterfall, so a session with approvals disabled
 * still rejects instead of silently auto-allowing.
 */
function installApprovalAnswerer(ctx) {
  return ctx.on("approval/request", function (request, next) {
    try {
      const toolName = typeof request?.toolName === "string" ? request.toolName : "";
      const reason = typeof request?.reason === "string" ? request.reason : "";
      const document = readApprovals();
      const rule = findApprovalRule(document.rules, toolName, reason);
      if (rule === null) return next();
      rule.hits = (Number(rule.hits) || 0) + 1;
      rule.lastUsedAt = new Date().toISOString();
      appendApprovalLog(document, {
        at: rule.lastUsedAt,
        event: "auto-allowed",
        key: rule.key,
        toolName,
        label: rule.labelHu,
        scope: Array.isArray(rule.tools) ? rule.tools.join(", ") : "minden eszköz"
      });
      const failure = writeApprovals(document);
      appendClientLog(`approval auto-allowed: ${rule.key} (${toolName})`
        + (failure === null ? "" : `, write failed: ${failure}`));
      return "allowed-once";
    } catch (error) {
      // A broken answerer must never answer for the user: fall through to the
      // built-in chain, which asks the browser.
      appendClientLog(`remembered-approval answerer failed: ${String(error?.stack ?? error)}`);
      return next();
    }
  }, { prepend: true });
}

// ------------------------------------------------------------------ usage

/**
 * Token and cost usage from the durable session logs.
 *
 * Why the host owns this: a real "30-day cost" is not a number the browser can
 * compute. It needs every request's token usage, the model that served it, and
 * the rate that applied at that moment (DeepSeek bills input cache hits, input
 * cache misses and output separately, at DOUBLE the price during peak hours),
 * and all of that lives in the session logs under DSH_HOME.
 *
 * The logs are append-only zstd streams: each append is its own frame, so they
 * are decompressed frame by frame rather than in one shot (a single-frame
 * reader returns only the session header — which is exactly how a "30-day"
 * figure would silently come out as zero).
 */

/**
 * Official DeepSeek list prices, USD per 1M tokens, peak and off-peak.
 *
 * PEAK is a non-holiday weekday in the two windows below; every other instant
 * — the whole weekend, and every Chinese public holiday — is off-peak at half
 * the peak rate. Weekends that the Chinese calendar turns into working days
 * (调休) are billed off-peak as well, so the weekend rule needs no exception.
 */
const PEAK_WINDOWS_UTC = [[1, 4], [6, 10]];

/** Offset of the Chinese public-holiday calendar from UTC, in minutes. */
const BEIJING_OFFSET_MINUTES = 8 * 60;

/**
 * Chinese public holidays, as BEIJING calendar dates, straight from the State
 * Council notice for 2026 ("Notice ... on Arrangements for Several Public
 * Holidays in 2026", Guo Ban Fa Ming Dian [2025] No. 7): New Year 1/1-3, Spring
 * Festival 2/15-23, Qingming 4/4-6, Labor Day 5/1-5, Dragon Boat 6/19-21,
 * Mid-Autumn 9/25-27, National Day 10/1-7.
 *
 * The provider bills these days off-peak, so pricing without them over-counts
 * every holiday request by a factor of two. The list must be refreshed when the
 * next year's notice is published: {@link holidaysCovered} reports the years the
 * table knows, and an uncovered year simply prices its holidays as peak days.
 */
const CHINESE_HOLIDAYS = (() => {
  const days = new Set();
  const spread = (year, month, from, to) => {
    for (let day = from; day <= to; day += 1) {
      days.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
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

/** Beijing calendar date of an instant (`YYYY-MM-DD`). */
function beijingDay(time) {
  return new Date(time + BEIJING_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}

/** Whether an instant falls on a Chinese public holiday (Beijing calendar). */
function isChineseHoliday(time) {
  return CHINESE_HOLIDAYS.has(beijingDay(time));
}

/** The years the holiday table covers, for the diagnostics and the checks. */
function holidaysCovered() {
  const years = new Set();
  for (const day of CHINESE_HOLIDAYS) years.add(day.slice(0, 4));
  return [...years].sort();
}

/**
 * Official DeepSeek list prices, USD per 1M tokens, peak and off-peak.
 *
 * `deepseek-flash` serves the retired `deepseek-v4-flash` and
 * `deepseek-v4-flash-vision-exp` names (the provider bills them at the Flash
 * price), so those map to the same numbers.
 */
const MODEL_PRICES = {
  "deepseek-flash": { hitPeak: 0.006, hitOff: 0.003, missPeak: 0.3, missOff: 0.15, outPeak: 1.2, outOff: 0.6 },
  "deepseek-v4-flash": { hitPeak: 0.006, hitOff: 0.003, missPeak: 0.3, missOff: 0.15, outPeak: 1.2, outOff: 0.6 },
  "deepseek-v4-flash-vision-exp": { hitPeak: 0.006, hitOff: 0.003, missPeak: 0.3, missOff: 0.15, outPeak: 1.2, outOff: 0.6 },
  "deepseek-v4-pro": { hitPeak: 0.044, hitOff: 0.022, missPeak: 1.32, missOff: 0.66, outPeak: 3.96, outOff: 1.98 },
  // Legacy routes, kept so an older session log still prices sensibly.
  "deepseek-chat": { hitPeak: 0.07, hitOff: 0.035, missPeak: 0.27, missOff: 0.135, outPeak: 1.1, outOff: 0.55 },
  "deepseek-reasoner": { hitPeak: 0.14, hitOff: 0.07, missPeak: 0.55, missOff: 0.275, outPeak: 2.19, outOff: 1.095 },
  // A helyi fallback-lanc route-jai: ezek INGYENESEK (Groq / NVIDIA NIM /
  // OpenRouter :free szint), ezert 0 arral kell szerepelniuk. Enelkul az
  // ismeretlen modell a Flash arat kapna, es a megtakaritas-szamitas
  // ertelmetlen lenne (0-t mutatna, holott a munka ingyen ment at).
  // A `worker` a proxy virtualis modellje; a tobbi a lanc tagjai, ha
  // kozvetlenul (proxy nelkul) valasztod oket.
  "worker": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "nemotron": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "gpt-oss": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "qwen3.8": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "gemini": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "gemma": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "kimi": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "llama": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 },
  "mistral": { hitPeak: 0, hitOff: 0, missPeak: 0, missOff: 0, outPeak: 0, outOff: 0 }
};

/** The price row a model id is billed with; unknown models fall back to Flash. */
function modelPrices(model) {
  if (typeof model === "string") {
    const lower = model.toLowerCase();
    for (const key of Object.keys(MODEL_PRICES)) {
      if (lower.indexOf(key) !== -1) return { key, ...MODEL_PRICES[key] };
    }
  }
  return { key: "deepseek-flash", ...MODEL_PRICES["deepseek-flash"] };
}

/**
 * Whether a model is served at no charge — the free fallback chain.
 *
 * This is the line between the two kinds of delegated work. A child that ran on
 * the zero-priced chain saved its whole paid baseline; a child that ran on the
 * PAID parent route cost what the parent would have cost, so it saved nothing.
 * Only the price row decides: a model the table does not know falls back to the
 * Flash row, which is not free, and must never be counted as a saving.
 */
function isFreeModel(model) {
  const price = modelPrices(model);
  return price.hitPeak === 0 && price.hitOff === 0
    && price.missPeak === 0 && price.missOff === 0
    && price.outPeak === 0 && price.outOff === 0;
}

/**
 * Whether one instant is billed at the PEAK rate.
 *
 * Peak needs all three: a weekday (UTC), a non-holiday Beijing day, and an hour
 * inside a peak window. The windows sit far from the Beijing midnight boundary
 * (09:00-12:00 and 14:00-18:00 Beijing time), so the UTC weekday and the Beijing
 * weekday agree inside them and the holiday test is unambiguous.
 */
function isPeakInstant(time) {
  const at = new Date(time);
  const weekday = at.getUTCDay();                    // 0 = Sunday
  if (weekday === 0 || weekday === 6) return false;  // weekends are off-peak
  if (isChineseHoliday(time)) return false;          // holidays are off-peak
  const hour = at.getUTCHours();
  for (const window of PEAK_WINDOWS_UTC) {
    if (hour >= window[0] && hour < window[1]) return true;
  }
  return false;
}

/** The model that served an assistant message, from its durable source field. */
function messageModel(data) {
  const source = (data.message !== undefined && data.message !== null ? data.message.source : undefined)
    ?? data.source
    ?? null;
  if (source !== null && typeof source.model === "string") return source.model;
  if (data.message !== undefined && data.message !== null && typeof data.message.model === "string") return data.message.model;
  return "";
}

/**
 * Cost of one request in USD.
 * @param usage - the durable usage object (`inputTokens` is the cache MISS part,
 *   `cacheReadTokens` the cache hit part).
 * @param model - the model that served the request.
 * @param time - the request instant (peak and off-peak rates differ twofold).
 */
function requestCost(usage, model, time) {
  const price = modelPrices(model);
  const peak = isPeakInstant(time);
  const miss = usage.inputTokens || 0;
  const hit = usage.cacheReadTokens || 0;
  const out = usage.outputTokens || 0;
  return (miss * (peak ? price.missPeak : price.missOff)
    + hit * (peak ? price.hitPeak : price.hitOff)
    + out * (peak ? price.outPeak : price.outOff)) / 1000000;
}

/** The session log directory of this deployment. */
function sessionsRoot() {
  const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** Every session log file below the sessions root, newest first. */
function sessionLogFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl.zstd") || entry.name.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

/** One zstd frame of an append-only session log. */
function readZstdFrame(buffer) {
  return new Promise((resolve) => {
    const stream = createZstdDecompress();
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), consumed: stream.bytesWritten }));
    stream.on("error", () => resolve({ text: "", consumed: buffer.length }));
    stream.end(buffer);
  });
}

/**
 * The whole log of one session, frame by frame.
 *
 * Bounded twice over: a frame budget and an output budget, so a pathological
 * file cannot pin the host. A truncated read still yields a usable (if partial)
 * aggregate instead of an error.
 */
async function decompressSessionLog(buffer) {
  let offset = 0;
  let text = "";
  let frames = 0;
  while (offset < buffer.length && frames < 200000 && text.length < 200 * 1024 * 1024) {
    const frame = await readZstdFrame(buffer.subarray(offset));
    if (frame.consumed <= 0) break;
    offset += frame.consumed;
    frames += 1;
    text += frame.text;
  }
  return text;
}

/** Budapest calendar day of an instant, the day the user actually lived in. */
function budapestDay(time) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(time));
  } catch {
    return new Date(time).toISOString().slice(0, 10);
  }
}

/** The last scan, kept for a short while: the wait is noticeable otherwise. */
const usageCache = { key: null, at: 0, value: null, running: null };

/** How long one usage scan stays fresh. */
const USAGE_CACHE_MILLISECONDS = 120000;

/**
 * Sum tokens and cost over the last `days` days of session logs.
 * @param days - window length; the file mtime filter uses it, so untouched
 *   sessions are never opened.
 * @returns the aggregate: totals, per-day and per-model breakdowns, and (when
 *   `sessionId` is given) that one session's own figures.
 */
async function scanUsage(days, sessionId) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const root = sessionsRoot();
  const files = sessionLogFiles(root);
  const perDay = new Map();
  const perModel = new Map();
  const totals = { requests: 0, miss: 0, hit: 0, out: 0, reasoning: 0, total: 0, costUsd: 0 };
  const wanted = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  const session = { id: wanted, requests: 0, miss: 0, hit: 0, out: 0, total: 0, costUsd: 0 };
  // Delegalt (subagent) munkat kulon merjuk: a megtakaritas-szamlashoz kell,
  // hogy mennyi ment at az ingyenes fallback-lancra a fizetos route helyett.
  // A "nem deepseek" szamitas a delegalt tokeneket a fizetos baseline aron
  // ertekeli — azaz mennyibe kerult volna, ha a szulo route-ja szolgalja ki.
  //
  // KET ZSEB, mert kulonben a szam hazudik: a `free` az ingyenes lanc
  // (0 aron szamolt) modelljein ment munka, a `paid` a delegalva is a FIZETOS
  // route-on futott munka. Utóbbi baseline-ja ugyanannyi, mint a tenyleges
  // koltsege, tehat nulla megtakaritas — a korabbi összevont szam ezt a ket
  // esetet mosta egybe, ezert tunt ugy, hogy "nincs ingyenes delegalas".
  const delegated = {
    requests: 0, miss: 0, hit: 0, out: 0, total: 0, costUsd: 0, baselineUsd: 0, sessions: 0,
    /** A legutolso delegalt keres ideje (epoch ms), 0 ha nincs ilyen. */
    lastAt: 0,
    free: { requests: 0, miss: 0, hit: 0, out: 0, total: 0, costUsd: 0, baselineUsd: 0, sessions: 0 },
    paid: { requests: 0, miss: 0, hit: 0, out: 0, total: 0, costUsd: 0, baselineUsd: 0, sessions: 0 }
  };
  /** Delegalt session-tokenek modellelkent: melyik ut mennyit vitt. */
  const delegatedModels = new Map();
  let scanned = 0;
  let skipped = 0;

  for (const file of files) {
    let modifiedAt = 0;
    try {
      modifiedAt = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedAt < since) {
      skipped += 1;
      continue;
    }
    const isWanted = wanted !== null && file.indexOf(wanted) !== -1;
    let text = "";
    try {
      const raw = readFileSync(file);
      text = file.endsWith(".zstd") ? await decompressSessionLog(raw) : raw.toString("utf8");
    } catch (error) {
      appendClientLog(`usage scan: ${file} nem olvashato (${String(error?.message ?? error)})`);
      continue;
    }
    scanned += 1;

    // A session-fejlec az elso sor: ebbol derul ki, hogy ez egy DELEGALT
    // (subagent) session-e. A DSH a `delegationDepth`-et es az `origin`
    // mezot irja ide.
    let delegatedFile = false;
    // Melyik uton ment ez a gyermek? Egy session keverheti is (a proxy
    // kiesese utan a gyermek mar a fizetos route-on futhat), ezert nem
    // cimkezzuk a fajlt, hanem keresenkent szamoljuk.
    let delegatedFreeFile = false;
    let delegatedPaidFile = false;
    const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    if (firstLine.indexOf('"type":"session"') !== -1 || firstLine.indexOf('"type": "session"') !== -1) {
      try {
        const header = JSON.parse(firstLine);
        const depth = typeof header.delegationDepth === "number" ? header.delegationDepth : 0;
        delegatedFile = depth > 0 || header.origin === "subagent";
      } catch { /* a fejlec ertelmezhetetlen: nem tekintjuk delegaltnak */ }
    }
    if (delegatedFile) delegated.sessions += 1;

    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      if (line.indexOf('"assistant/message"') === -1) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "assistant/message") continue;
      const data = event.data;
      if (data === undefined || data === null || data.usage === undefined || data.usage === null) continue;
      if (typeof event.time !== "number" || event.time < since) continue;
      const usage = data.usage;
      const model = messageModel(data);
      const cost = requestCost(usage, model, event.time);
      const tokens = usage.totalTokens || ((usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.outputTokens || 0));

      totals.requests += 1;
      totals.miss += usage.inputTokens || 0;
      totals.hit += usage.cacheReadTokens || 0;
      totals.out += usage.outputTokens || 0;
      totals.reasoning += usage.reasoningTokens || 0;
      totals.total += tokens;
      totals.costUsd += cost;

      if (delegatedFile) {
        // A baseline: ugyanezek a tokenek a fizetos DeepSeek-flash aron.
        const baseline = requestCost(usage, "deepseek-flash", event.time);
        const free = isFreeModel(model);
        const pocket = free ? delegated.free : delegated.paid;
        delegated.requests += 1;
        delegated.miss += usage.inputTokens || 0;
        delegated.hit += usage.cacheReadTokens || 0;
        delegated.out += usage.outputTokens || 0;
        delegated.total += tokens;
        delegated.costUsd += cost;
        delegated.baselineUsd += baseline;
        pocket.requests += 1;
        pocket.miss += usage.inputTokens || 0;
        pocket.hit += usage.cacheReadTokens || 0;
        pocket.out += usage.outputTokens || 0;
        pocket.total += tokens;
        pocket.costUsd += cost;
        pocket.baselineUsd += baseline;
        if (typeof event.time === "number" && event.time > delegated.lastAt) delegated.lastAt = event.time;
        if (free) delegatedFreeFile = true;
        else delegatedPaidFile = true;

        const delegatedKey = model === "" ? "ismeretlen" : model;
        const delegatedBucket = delegatedModels.get(delegatedKey)
          ?? { model: delegatedKey, requests: 0, tokens: 0, costUsd: 0, baselineUsd: 0, free };
        delegatedBucket.requests += 1;
        delegatedBucket.tokens += tokens;
        delegatedBucket.costUsd += cost;
        delegatedBucket.baselineUsd += baseline;
        delegatedModels.set(delegatedKey, delegatedBucket);
      }

      const day = budapestDay(event.time);
      const dayBucket = perDay.get(day) ?? { day, requests: 0, tokens: 0, costUsd: 0 };
      dayBucket.requests += 1;
      dayBucket.tokens += tokens;
      dayBucket.costUsd += cost;
      perDay.set(day, dayBucket);

      const modelKey = model === "" ? "ismeretlen" : model;
      const modelBucket = perModel.get(modelKey) ?? { model: modelKey, requests: 0, tokens: 0, costUsd: 0 };
      modelBucket.requests += 1;
      modelBucket.tokens += tokens;
      modelBucket.costUsd += cost;
      perModel.set(modelKey, modelBucket);

      if (isWanted) {
        session.requests += 1;
        session.miss += usage.inputTokens || 0;
        session.hit += usage.cacheReadTokens || 0;
        session.out += usage.outputTokens || 0;
        session.total += tokens;
        session.costUsd += cost;
      }
    }

    // A session-zaszlo a keresek utan: egy gyermek mindket zsebbe is tehet.
    if (delegatedFile) {
      if (delegatedFreeFile) delegated.free.sessions += 1;
      if (delegatedPaidFile) delegated.paid.sessions += 1;
    }
  }

  const days0 = [...perDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    ok: true,
    days,
    since: new Date(since).toISOString(),
    files: files.length,
    scanned,
    skipped,
    totals,
    // A delegalt (subagent) munka es a belole szarmazo megtakaritas.
    // `baselineUsd` = mennyibe kerult volna ugyanez a fizetos DeepSeek-flash
    // aron; `savedUsd` = baseline - tenyleges. A `share` a delegalt keresek
    // aranya az osszeshez kepest.
    //
    // A `free` / `paid` zseb es a `models` bontas azert van, hogy a felulet meg
    // tudja mondani, MENNYI ment at az ingyenes lancon: a felhasznalo kerdezese
    // pont ez volt ("nem jelenik meg az ingyenes delegalas adata").
    // `freeSavingsUsd` a tenyleges megtakaritas (csak a 0 aron futott keresek).
    // `lastAt` pedig megmutatja, mikor volt az utolso delegalas — enelkul a
    // valoban regi szam beégettnek latszik.
    delegated: {
      ...delegated,
      savedUsd: Math.max(0, delegated.baselineUsd - delegated.costUsd),
      freeSavingsUsd: Math.max(0, delegated.free.baselineUsd - delegated.free.costUsd),
      lastAt: delegated.lastAt > 0 ? delegated.lastAt : null,
      models: [...delegatedModels.values()].sort((a, b) => b.requests - a.requests),
      share: totals.requests > 0 ? delegated.requests / totals.requests : 0,
      baselineModel: "deepseek-flash"
    },
    perDay: days0,
    perModel: [...perModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    activeDays: days0.length,
    session: wanted === null ? null : session,
    pricing: {
      note: "hivatalos DeepSeek listárák, csúcsidőben dupla",
      peakWindowUtc: "hétköznap 01:00-04:00 és 06:00-10:00 UTC",
      peakWindowNote: "hétvégén és kínai ünnepnapokon mindig völgyidőszak",
      holidaysCovered: holidaysCovered()
    }
  };
}

/** Cached wrapper around {@link scanUsage}; one scan at a time. */
async function usageSnapshot(days, sessionId) {
  const key = `${days}`;
  const now = Date.now();
  if (usageCache.value !== null && usageCache.key === key && now - usageCache.at < USAGE_CACHE_MILLISECONDS) {
    return withSessionFigures(usageCache.value, sessionId);
  }
  if (usageCache.running === null) {
    usageCache.running = scanUsage(days, null)
      .then((value) => {
        usageCache.key = key;
        usageCache.at = Date.now();
        usageCache.value = value;
        return value;
      })
      .catch((error) => {
        appendClientLog(`usage scan failed: ${String(error?.stack ?? error)}`);
        return null;
      })
      .finally(() => {
        usageCache.running = null;
      });
  }
  const value = await usageCache.running;
  return value === null ? { ok: false, error: "a használati adat nem olvasható" } : withSessionFigures(value, sessionId);
}

/**
 * Attach one session's own figures to a cached scan.
 *
 * The heavy scan is cached without a session id, so a session change must not
 * throw it away: this reads just that session's log and prices it with the same
 * engine. The result is memoized per (scan, session).
 */
async function withSessionFigures(value, sessionId) {
  const wanted = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  if (wanted === null) return { ...value, session: null };
  if (value.session !== null && value.session !== undefined && value.session.id === wanted) return value;
  const cached = sessionFigureCache.get(wanted);
  if (cached !== undefined && cached.scan === usageCache.at) return { ...value, session: cached.session };
  const session = await scanOneSession(wanted, value.since);
  sessionFigureCache.set(wanted, { scan: usageCache.at, session });
  return { ...value, session };
}

/** One session's own figures, from its own log only. */
async function scanOneSession(sessionId, sinceIso) {
  const since = Date.parse(sinceIso);
  const root = sessionsRoot();
  const file = sessionLogFiles(root).find((candidate) => candidate.indexOf(sessionId) !== -1);
  const session = { id: sessionId, requests: 0, miss: 0, hit: 0, out: 0, total: 0, costUsd: 0 };
  if (file === undefined) return session;
  let text = "";
  try {
    const raw = readFileSync(file);
    text = file.endsWith(".zstd") ? await decompressSessionLog(raw) : raw.toString("utf8");
  } catch {
    return session;
  }
  for (const line of text.split("\n")) {
    if (line.indexOf('"assistant/message"') === -1) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "assistant/message" || !event.data || !event.data.usage) continue;
    if (typeof event.time === "number" && Number.isFinite(since) && event.time < since) continue;
    const usage = event.data.usage;
    const model = messageModel(event.data);
    session.requests += 1;
    session.miss += usage.inputTokens || 0;
    session.hit += usage.cacheReadTokens || 0;
    session.out += usage.outputTokens || 0;
    session.total += usage.totalTokens || ((usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.outputTokens || 0));
    session.costUsd += requestCost(usage, model, event.time);
  }
  return session;
}

/** Memoized single-session figures, keyed to the scan they belong to. */
const sessionFigureCache = new Map();

/** Answer one usage request. */
async function handleUsage(req, res, url) {
  const rawDays = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(rawDays) && rawDays > 0 && rawDays <= 365 ? Math.round(rawDays) : 30;
  const sessionId = url.searchParams.get("session") ?? "";
  let snapshot;
  try {
    snapshot = await usageSnapshot(days, sessionId);
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
    return;
  }
  sendJson(res, snapshot);
}

// -------------------------------------------------------------------- plumbing

/**
 * The sidebar's session channel: hide sessions, bring them back, and register
 * the directory automated runs work in as its own workspace.
 *
 * Why a host route instead of editing `storages/workspace.json`: that file is
 * read once, at startup, and the RUNNING host keeps the archive set and the
 * workspace table in memory. A file edit under a live server is therefore either
 * invisible or overwritten by the next registry write; this route mutates the
 * live registry, so the sidebar updates immediately and durably.
 *
 * The archived set is registry-global: an archived session leaves every grouping
 * and search surface, but its log stays on disk, so the statistics above keep
 * counting its tokens — hiding is not deleting.
 */
async function handleWorkspaceSession(req, res, url, ctx) {
  const registry = typeof ctx?.get === "function" ? ctx.get("workspaceRegistry") : undefined;
  if (registry === undefined) {
    sendJson(res, { ok: false, error: "a workspace-nyilvantartas ebben a profilban nem elerheto" });
    return;
  }

  if (String(req.method ?? "GET").toUpperCase() === "GET") {
    sendJson(res, {
      ok: true,
      archivedSessionIds: [...registry.archivedSessionIds],
      workspaces: registry.list().map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessions: workspace.sessionIds.length
      }))
    });
    return;
  }

  readJsonBody(req, 256 * 1024, async (error, body) => {
    if (error !== null) {
      sendJson(res, { ok: false, error: "a keres test nem ertelmezheto JSON-kent" });
      return;
    }
    const action = String(body?.action ?? "");
    try {
      if (action === "archive" || action === "unarchive") {
        const wanted = Array.isArray(body?.sessions)
          ? body.sessions.filter((id) => typeof id === "string" && id.length > 0)
          : [];
        if (wanted.length === 0) {
          sendJson(res, { ok: false, error: "hianyzik a sessions lista" });
          return;
        }
        const changed = [];
        const failed = [];
        for (const sessionId of wanted) {
          try {
            if (action === "archive") await registry.archiveSession(sessionId);
            else await unarchiveSession(registry, sessionId);
            changed.push(sessionId);
          } catch (error) {
            failed.push({ sessionId, error: String(error?.message ?? error) });
          }
        }
        sendJson(res, {
          ok: failed.length === 0,
          action,
          changed,
          failed,
          archivedSessionIds: [...registry.archivedSessionIds]
        });
        return;
      }

      if (action === "workspace") {
        const path = typeof body?.path === "string" ? body.path : "";
        if (path === "") {
          sendJson(res, { ok: false, error: "hianyzik a path" });
          return;
        }
        // A channel directory is created on demand: the caller asks for a
        // separate group, and an empty directory is exactly what that group is.
        mkdirSync(path, { recursive: true });
        const existing = await registry.resolveByPath(path);
        if (existing !== undefined) {
          sendJson(res, {
            ok: true,
            created: false,
            workspace: { id: existing.id, path: existing.path, title: existing.title }
          });
          return;
        }
        const title = typeof body?.title === "string" && body.title.length > 0 ? body.title : undefined;
        const workspace = await registry.create(path, title);
        sendJson(res, {
          ok: true,
          created: true,
          workspace: { id: workspace.id, path: workspace.path, title: workspace.title }
        });
        return;
      }

      sendJson(res, { ok: false, error: `ismeretlen action: ${action}` });
    } catch (error) {
      sendJson(res, { ok: false, error: String(error?.message ?? error) });
    }
  });
}

/**
 * Remove one session from the registry-global archive set.
 *
 * This build publishes `archiveSession` but no inverse, so the inverse is
 * written here against the same durable state object the registry itself writes
 * (initialized, order, archive set). It is deliberately narrow: it only REMOVES
 * one id from the archive set and never touches the workspace order, so a
 * mistaken archive can be undone without a restart.
 */
async function unarchiveSession(registry, sessionId) {
  if (!registry.archivedSessionIds.includes(sessionId)) return;
  if (typeof registry.setState !== "function") {
    throw new Error("ez a host nem tud visszavonni archiválást (nincs registry.setState)");
  }
  await registry.setState({
    initialized: true,
    workspaceIds: registry.list().map((workspace) => workspace.id),
    archivedSessionIds: registry.archivedSessionIds.filter((id) => id !== sessionId)
  });
}

/**
 * Path of the panel-layout file: `state/panel-layout.json`, keyed by workspace
 * and then by panel.
 */
function layoutPath() {
  return join(PACKAGE_ROOT, "..", "..", "state", "panel-layout.json");
}

/** Read the whole layout document; an unreadable file is treated as empty. */
function readLayout() {
  try {
    const parsed = JSON.parse(readFileSync(layoutPath(), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * One workspace's remembered layout, or one key's new value written into it.
 *
 * A layout is small and unvalidated by design: it holds the panel's own choices
 * (which terminal is selected, which is expanded, the filter text). The host
 * stores whatever the panel sends and hands it back, so the panel can evolve its
 * own state without a host change.
 */
function handleLayout(req, res, url) {
  const workspace = url.searchParams.get("workspace") ?? "";
  if (!workspace) {
    sendJson(res, { ok: false, error: "hianyzik a workspace parameter" });
    return;
  }
  const key = url.searchParams.get("key");
  const value = url.searchParams.get("value");

  const all = readLayout();
  if (key === null) {
    sendJson(res, { ok: true, workspace, layout: all[workspace] ?? {} });
    return;
  }

  const entry = all[workspace] !== null && typeof all[workspace] === "object" ? all[workspace] : {};
  if (value === null) delete entry[key];
  else {
    try {
      entry[key] = JSON.parse(value);
    } catch {
      // A plain string is a valid value too; only JSON-shaped text is parsed.
      entry[key] = value;
    }
  }
  all[workspace] = entry;
  try {
    mkdirSync(join(PACKAGE_ROOT, "..", "..", "state"), { recursive: true });
    writeFileSync(layoutPath(), JSON.stringify(all, null, 2), "utf8");
    sendJson(res, { ok: true, workspace, layout: entry });
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) });
  }
}

/** One JSON answer with no-store caching. */
function sendJson(res, body) {
  try {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify(body));
  } catch {
    // The response is already gone; nothing left to report to.
  }
}

/** Serve one file from the plugin's own asset directory. */
function handleAsset(res, relativePath) {
  const safe = relativePath.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (safe.includes("..")) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const bytes = readFileSync(join(PACKAGE_ROOT, safe));
    const type = safe.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : safe.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(bytes);
  } catch {
    res.writeHead(404).end("not found");
  }
}

/**
 * Last language-pack report posted by the browser. The client cannot be asked
 * "did your dictionaries register?" from the host, so it POSTs the answer to
 * this route and the deploy check reads it back. Kept in memory only: a fresh
 * server must not claim a report from the previous boot.
 */
let i18nReport = null;

/**
 * POST body: `{ active, locales, namespaces, failures }`.
 * GET: the last report, plus whether one arrived at all.
 */
function handleI18n(req, res) {
  const send = (status, payload) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    });
    res.end(JSON.stringify(payload, null, 2));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    });
    return res.end();
  }

  if (req.method === "POST") {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // A report is a handful of strings; anything larger is a mistake.
      if (size > 64 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        i18nReport = { receivedAt: new Date().toISOString(), ...body };
        send(200, { ok: true });
      } catch (error) {
        send(400, { ok: false, error: String(error?.message ?? error) });
      }
    });
    req.on("error", () => send(400, { ok: false, error: "request stream failed" }));
    return undefined;
  }

  if (i18nReport === null) {
    return send(200, {
      ok: false,
      reason: "no report yet",
      hint: "load the interface with ?dsh-ui-extras-probe=1 so the client posts its language-pack report"
    });
  }
  return send(200, { ok: true, ...i18nReport });
}

/**
 * The host's own working directory, as the last-resort workspace for panels.
 *
 * A freshly opened window can have no session and no workspace selected yet,
 * while the terminal panel still needs a directory to run in. The harness is
 * started in the workspace, so its own cwd is the right answer — and it is only
 * consulted when the client knows nothing better.
 */
function handleWorkspace(res) {
  sendJson(res, { ok: true, workspace: process.cwd() });
}

/**
 * Fresh sign-in URL of the running Harness, as written by the restart helper.
 *
 * This route is what makes a reload survive a restart: the window and the page
 * are signed in through a token in the URL, and a restarted server mints a NEW
 * token, so reloading the old address would land on a 401. The client asks here
 * for the address to reload onto. A running server holds a valid token, so the
 * file normally exists; when it does not, the caller keeps the current address.
 */
function handleHarnessUrl(res) {
  const candidates = [
    join(PACKAGE_ROOT, "..", "..", "state", "harness.url"),
    join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh"), "dsh-web", "harness.url")
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const url = readFileSync(candidate, "utf8").trim();
      if (!/^https?:\/\//u.test(url)) continue;
      const stat = statSync(candidate);
      sendJson(res, {
        ok: true,
        url,
        // The serving server's own pid is the reliable "is this a new process?"
        // marker: the client remembers the first pid it sees and reloads only
        // when it changes. A file timestamp can be too coarse (two writes inside
        // the same second) and would strand the page on a dead token.
        pid: process.pid,
        // A stale file must still be distinguishable from a fresh one.
        file: candidate,
        modifiedAt: stat.mtime.toISOString(),
        ageSeconds: Math.round((Date.now() - stat.mtimeMs) / 1000)
      });
      return;
    } catch {
      // Try the next candidate.
    }
  }
  sendJson(res, { ok: false, error: "nincs mentett token URL" });
}

/**
 * Append a line to state\ui-extras-client.log.
 *
 * A client-side failure is invisible from here: a thrown error leaves a blank
 * panel or a frozen control and nothing in the server log. The browser POSTs
 * what went wrong to /ui-extras/log, which is what this writes — so a problem
 * in the interface can be diagnosed with `Get-Content state\ui-extras-client.log`
 * instead of asking for DevTools.
 */
function appendClientLog(text) {
  try {
    const dir = join(PACKAGE_ROOT, "..", "..", "state");
    const file = join(dir, "ui-extras-client.log");
    const stamp = new Date().toISOString();
    writeFileSync(file, `[${stamp}] ${String(text).slice(0, 4000)}\n`, { flag: "a" });
    // Bounded history: the file is a debugging aid, not a record.
    const stat = statSync(file);
    if (stat.size > 2 * 1024 * 1024) writeFileSync(file, "", "utf8");
  } catch {
    // Logging must never become the failure.
  }
}

function handleClientLog(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) appendClientLog(raw);
    sendJson(res, { ok: true });
  });
  req.on("error", () => sendJson(res, { ok: false, error: "request stream failed" }));
}

/**
 * A futó dsh CLI útja, szerveroldalon feloldva.
 *
 * MIÉRT A HOSTON: a kliens-bundle nem tudhatja, hol van a dsh ezen a gépen, és
 * korábban a fejlesztő gépének abszolút útja volt beégetve (más gépen hibás,
 * nyilvános repóban felhasználónevet szivárogtat). A harness maga a dsh CLI-vel
 * indult, ezért a saját `process.argv[1]`-je a legjobb forrás.
 *
 * @returns a bin.js útvonala, vagy "" ha nem ismerhető fel.
 */
function resolveDshBin() {
  const argv = process.argv[1] ?? "";
  if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/u.test(argv) && existsSync(argv)) return argv;
  // Tartalék: npm globális telepítés.
  try {
    const global = join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (existsSync(global)) return global;
  } catch {
    // marad az üres válasz: a hívó hibát jelez, nem találgat
  }
  return "";
}

/** Host plugin body: register the routes. */
function apply(ctx) {
  // The answerer is registered BEFORE the web-server guard: remembering an
  // approval type is useful even in a composition without a browser route, and
  // losing it silently would reintroduce the repeated prompt.
  ctx.effect(() => installApprovalAnswerer(ctx), "ui-extras: remembered approvals");

  if (ctx.webServer === undefined) return;

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/approvals",
    handler: (req, res) => handleApprovals(req, res, new URL(req.url ?? "/", "http://dsh.invalid"))
  }), "ui-extras: approvals route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/i18n",
    handler: (req, res) => handleI18n(req, res)
  }), "ui-extras: i18n report route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/log",
    handler: (req, res) => handleClientLog(req, res)
  }), "ui-extras: client log route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/workspace",
    handler: (_req, res) => handleWorkspace(res)
  }), "ui-extras: default workspace route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/layout",
    handler: (req, res) => handleLayout(req, res, new URL(req.url ?? "/", "http://dsh.invalid"))
  }), "ui-extras: panel layout route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/harness-url",
    handler: (_req, res) => handleHarnessUrl(res)
  }), "ui-extras: harness url route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/balance",
    handler: (_req, res) => handleBalance(ctx, res)
  }), "ui-extras: balance route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/usage",
    handler: (req, res) => handleUsage(req, res, new URL(req.url ?? "/", "http://dsh.invalid"))
  }), "ui-extras: usage route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/workspace-session",
    handler: (req, res) => handleWorkspaceSession(req, res, new URL(req.url ?? "/", "http://dsh.invalid"), ctx)
  }), "ui-extras: workspace session route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/git",
    handler: (req, res) => handleGit(req, res)
  }), "ui-extras: git route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/cmd",
    handler: (req, res) => handleCmd(req, res, new URL(req.url ?? "/", "http://dsh.invalid"))
  }), "ui-extras: run-command route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/ssh",
    handler: (req, res) => handleSsh(req, res, new URL(req.url ?? "/", "http://dsh.invalid"))
  }), "ui-extras: ssh route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/github",
    handler: (req, res) => handleGithub(req, res)
  }), "ui-extras: github route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ui-extras/github-action",
    handler: (req, res) => handleGithubAction(req, res)
  }), "ui-extras: github action route");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/ui-extras/assets",
    handler: (req, res) => handleAsset(res, (req.url ?? "").replace(/^\/ui-extras\/assets/u, ""))
  }), "ui-extras: asset route");
}

export { apply, inject };

/**
 * Exported for `tools/check-plugin.mjs`: "stop" has to take the whole process
 * tree, because a shell-only kill leaves `npm run dev` running and holding its
 * port. The check spawns a real shell with a real child and calls this.
 */
export { killRun };

/**
 * Exported for `tools/check-git-commit-lang.mjs`: the commit action's
 * automatic message depends on the `lang` parameter, and that has to be
 * provable against a throw-away repository instead of the real one.
 */
export { handleGithubAction };

/**
 * Exported for `tools/check-approvals.mjs`: the type derivation and the rule
 * matcher are the security-relevant part of the remembered-approval store, so
 * they are exercised directly instead of only through a live prompt.
 */
export { approvalTypeOf, findApprovalRule, readApprovals, writeApprovals, approvalsPath };

/**
 * Exported for `tools/check-usage.mjs`: the price table, the peak-window
 * predicate and the log scan are what the displayed cost is made of, so they are
 * exercised against the real session logs and against explicit instants. The
 * holiday table is exported so `tools/check-plugin.mjs` can prove the client's
 * copy of it has not drifted from this one.
 */
export { isPeakInstant, modelPrices, requestCost, scanUsage, sessionsRoot };
export { isFreeModel };

/**
 * Exported for `tools/check-workspace-session.mjs`: the channel route is the one
 * place that mutates the RUNNING host's workspace registry (archive, unarchive,
 * register a channel directory), so its decisions are exercised against a fake
 * registry instead of only through a live server.
 */
export { handleWorkspaceSession, unarchiveSession };
export { CHINESE_HOLIDAYS, beijingDay, holidaysCovered, isChineseHoliday, PEAK_WINDOWS_UTC };






