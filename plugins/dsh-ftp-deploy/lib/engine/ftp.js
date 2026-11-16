/**
 * FTP motor — a Felpuffantó `src\engine\ftp.ts` (0.1.5) portja, változtatás
 * nélkül a viselkedésben. A mért tulajdonságok, amiket meg kell tartani:
 *
 *  * 3 próbálkozás, [3 s, 8 s] várakozással, CSAK átmeneti hibára (hálózat, 4xx);
 *    a tartós FTP-kódok (530 jelszó, 550/551/552/553) azonnal megállnak;
 *  * fázis-naplózás (connect -> mkdir -> upload -> delete) és a tényleges távoli
 *    IP a hibaüzenetben (a tárhely-szolgáltató ezt kéri a hibajegyhez);
 *  * `RemoteDirIndex` a mappákhoz (nem `ensureDir`: az MKD-spamot csinált);
 *  * ZIP-mentés streamelve, egyedi névvel, hiba esetén a félkész ZIP törlése.
 */
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { Client, ZipFile } from "./vendor.js";
import { completeLaravelInclude } from "./deny.js";
import { posixRel } from "./paths.js";
import { RemoteDirIndex, remoteDirOf } from "./remoteDirs.js";

/** Egy push ennyiszer próbálkozhat, mielőtt hibát dob. */
export const PUSH_ATTEMPTS = 3;
/** Várakozás a próbálkozások között (ms) — a másodiktól. */
export const PUSH_RETRY_DELAY_MS = [3000, 8000];

const PHASE_LABEL = {
  connect: "csatlakozás / bejelentkezés",
  mkdir: "távoli mappa ellenőrzése",
  upload: "fájlfeltöltés (STOR)",
  delete: "távoli törlés",
};

/**
 * Átmeneti (újrapróbálható) hibák: hálózati megszakítás, időtúllépés, 4xx.
 * A tartós FTP-hibák (530 jelszó, 550/552/553 jogosultság, kvóta) NEM
 * próbálhatók újra — csak lassítanák a hibaüzenetet.
 */
const TRANSIENT_ERROR = new RegExp(
  [
    "FIN packet",
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "socket hang up",
    "connection closed",
    "connection reset",
    "no connection",
    "timeout",
    "timed out",
    "\\b421\\b",
    "\\b425\\b",
    "\\b426\\b",
    "\\b450\\b",
    "\\b452\\b",
  ].join("|"),
  "i",
);
/** Tartós hibakódok, amiket soha nem próbálunk újra. */
const PERMANENT_ERROR = /\b(530|532|550|551|552|553)\b/;

export function errorText(err) {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return "ismeretlen hiba";
  return String(err);
}

export function isRetryable(err) {
  const message = errorText(err);
  if (PERMANENT_ERROR.test(message)) return false;
  if (TRANSIENT_ERROR.test(message)) return true;
  const code = err && typeof err === "object" ? err.code : undefined;
  return typeof code === "number" && code >= 400 && code < 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A ténylegesen elért kiszolgáló IP-je — ezt kéri a szolgáltatói hibajegy. */
function remoteAddress(client) {
  try {
    const address = client.ftp && client.ftp.socket ? client.ftp.socket.remoteAddress : "";
    return String(address ?? "").replace(/^::ffff:/, "");
  } catch {
    return "";
  }
}

async function connect(client, profile, password) {
  await client.access({
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password,
    secure: Boolean(profile.tls),
    secureOptions: { rejectUnauthorized: false },
    // A `passive` mezőt a basic-ftp 4+ magától passzív módban használja; a
    // profilban azért marad, hogy a beállítás látható legyen.
  });
}

export async function testConnection(profile, password, options = {}) {
  const log = options.log ?? (() => "");
  const client = new Client(20000);
  try {
    await connect(client, profile, password);
    const cwd = await client.pwd();
    log(`TEST ok profile=${profile.id} host=${profile.host}:${profile.port} user=${profile.user} pwd=${cwd}`);
    return { cwd };
  } finally {
    client.close();
  }
}

/**
 * Feltöltés + törlés egy menetben. A hívó adja a fájllistát (előnézet), a
 * jelszót a DPAPI-tárból. Visszaadja a számokat a felületnek.
 */
export async function uploadFiles(profile, password, files, options = {}) {
  const log = options.log ?? (() => "");
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const uploads = files.filter((f) => f.action !== "delete");
  const deletes = files.filter((f) => f.action === "delete");
  const root = String(profile.remoteRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const doneUploads = new Set();
  const doneDeletes = new Set();
  let bytes = 0;
  let attemptsUsed = 0;
  let lastError = null;
  let lastPhase = "connect";
  let lastLogFile = "";

  lastLogFile = log(
    `PUSH start profile=${profile.id} user=${profile.user} host=${profile.host}:${profile.port} tls=${profile.tls ? "on" : "off"} upload=${uploads.length} delete=${deletes.length} remote=${root}`,
  );

  onProgress({
    phase: "connect",
    done: 0,
    total: uploads.length + deletes.length,
    uploaded: 0,
    deleted: 0,
    bytes: 0,
    current: "",
  });

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    const pendingUploads = uploads.filter((f) => !doneUploads.has(posixRel(f.path)));
    const pendingDeletes = deletes.filter((f) => !doneDeletes.has(posixRel(f.path)));
    if (pendingUploads.length === 0 && pendingDeletes.length === 0) break;

    attemptsUsed = attempt;
    if (attempt > 1) {
      const wait = PUSH_RETRY_DELAY_MS[Math.min(attempt - 2, PUSH_RETRY_DELAY_MS.length - 1)];
      lastLogFile = log(
        `PUSH retry ${attempt}/${PUSH_ATTEMPTS} in ${wait}ms after phase=${lastPhase} err="${errorText(lastError)}"`,
      );
      await sleep(wait);
    }

    const client = new Client(60000);
    let phase = "connect";
    let remoteIp = "";

    try {
      await connect(client, profile, password);
      remoteIp = remoteAddress(client);
      const dirs = new RemoteDirIndex(client);

      for (const file of pendingUploads) {
        const rel = posixRel(file.path);
        const local = path.join(profile.localRoot, rel);
        const remote = `${root}/${rel}`;
        phase = "mkdir";
        await dirs.ensure(remoteDirOf(remote));
        phase = "upload";
        await client.uploadFrom(local, remote);
        doneUploads.add(rel);
        bytes += file.size;
        lastLogFile = log(`OK ${rel} -> ${remote} (${file.size})`);
        onProgress({
          phase,
          done: doneUploads.size + doneDeletes.size,
          total: uploads.length + deletes.length,
          uploaded: doneUploads.size,
          deleted: doneDeletes.size,
          bytes,
          current: rel,
        });
      }

      for (const file of pendingDeletes) {
        const rel = posixRel(file.path);
        const remote = `${root}/${rel}`;
        phase = "delete";
        try {
          await client.remove(remote);
          doneDeletes.add(rel);
          lastLogFile = log(`DEL ${rel} -> ${remote}`);
        } catch (err) {
          const message = errorText(err);
          if (/550|not found|no such file/i.test(message)) {
            doneDeletes.add(rel);
            lastLogFile = log(`DEL skip (nincs fent) ${rel}`);
          } else {
            throw err;
          }
        }
        onProgress({
          phase,
          done: doneUploads.size + doneDeletes.size,
          total: uploads.length + deletes.length,
          uploaded: doneUploads.size,
          deleted: doneDeletes.size,
          bytes,
          current: rel,
        });
      }

      const dirStats = dirs.stats;
      lastLogFile = log(
        `PUSH done uploaded=${doneUploads.size} deleted=${doneDeletes.size} bytes=${bytes} attempts=${attempt} dirs_checked=${dirStats.checked} dirs_created=${dirStats.created}`,
      );
      return {
        uploaded: doneUploads.size,
        deleted: doneDeletes.size,
        bytes,
        attempts: attempt,
        logFile: lastLogFile,
      };
    } catch (err) {
      lastPhase = phase;
      lastError = err;
      const retryable = isRetryable(err) && attempt < PUSH_ATTEMPTS;
      lastLogFile = log(
        `FAIL phase=${phase} attempt=${attempt}/${PUSH_ATTEMPTS} host=${profile.host}:${profile.port} user=${profile.user}${remoteIp ? ` remote=${remoteIp}` : ""} err="${errorText(err)}"${retryable ? " (ujraprobalkozas)" : ""}`,
      );
      if (!retryable) throw pushFailure(profile, phase, attempt, remoteIp, err);
    } finally {
      client.close();
    }
  }

  throw pushFailure(profile, lastPhase, attemptsUsed, "", lastError);
}

export async function listRemoteDirectories(profile, password, remotePath) {
  const client = new Client(20000);
  const pathNorm = String(remotePath ?? "").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  try {
    await connect(client, profile, password);
    await client.cd(pathNorm);
    const entries = await client.list();
    const dirs = entries
      .filter((e) => e.isDirectory && e.name !== "." && e.name !== "..")
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "hu"));
    return { path: pathNorm, dirs };
  } finally {
    client.close();
  }
}

/**
 * Éles FTP tartalom mentése helyi ZIP-be (soha nem írja felül a localRootot,
 * és soha nem írja felül a meglévő ZIP-et).
 */
export async function backupRemoteToZip(profile, password, destDir, mode, options = {}) {
  const log = options.log ?? (() => "");
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const root = String(profile.remoteRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || root === "/") throw new Error("Érvénytelen remoteRoot a mentéshez.");
  const dest = String(destDir ?? "").trim();
  if (!dest) throw new Error("Add meg a célmappát.");
  mkdirSync(dest, { recursive: true });

  const stamp = formatStamp(new Date());
  const proj = path.basename(String(profile.localRoot).replace(/[\\/]+$/, "")) || profile.id;
  const zipPath = uniqueZipPath(dest, `${proj}-ftp_${stamp}`);

  const client = new Client(120000);
  let logFile = log(`BACKUP start profile=${profile.id} mode=${mode} remote=${root} zip=${zipPath}`);

  try {
    await connect(client, profile, password);
    const listed = await collectBackupFiles(client, profile, mode, root, log);
    if (listed.length === 0) throw new Error("Nincs letöltendő fájl a választott hatókörben.");
    logFile = log(`BACKUP list files=${listed.length}`);

    const zipfile = new ZipFile();
    const output = createWriteStream(zipPath);
    const done = finished(output);
    zipfile.outputStream.pipe(output);

    let files = 0;
    let bytes = 0;
    for (const file of listed) {
      const pass = new PassThrough();
      const opts = file.size > 0 ? { size: file.size, compress: true } : { compress: true };
      zipfile.addReadStream(pass, file.rel, opts);
      await client.downloadTo(pass, file.remote);
      files += 1;
      bytes += file.size;
      if (files % 25 === 0 || files === listed.length) {
        logFile = log(`BACKUP progress ${files}/${listed.length} bytes=${bytes}`);
        onProgress({ phase: "download", done: files, total: listed.length, current: file.rel, bytes });
      }
    }

    zipfile.end();
    await done;

    logFile = log(`BACKUP done files=${files} bytes=${bytes} zip=${zipPath}`);
    return { zipPath, files, bytes, logFile };
  } catch (err) {
    log(`BACKUP FAIL ${errorText(err)}`);
    try {
      if (existsSync(zipPath)) unlinkSync(zipPath);
    } catch {
      /* ignored */
    }
    throw err;
  } finally {
    client.close();
  }
}

async function collectBackupFiles(client, profile, mode, root, log) {
  const out = [];
  if (mode === "full") {
    await walkRemote(client, root, "", out, log);
    return out;
  }

  const include = completeLaravelInclude(profile.include);
  for (const raw of include) {
    const prefix = posixRel(raw).replace(/\/+$/, "");
    if (!prefix) continue;
    const remote = `${root}/${prefix}`;
    const before = out.length;
    await walkRemote(client, remote, prefix, out, log);
    if (out.length > before) continue;

    try {
      const slash = remote.lastIndexOf("/");
      const parent = slash > 0 ? remote.slice(0, slash) : root;
      const base = slash > 0 ? remote.slice(slash + 1) : prefix;
      const siblings = await client.list(parent);
      const hit = siblings.find((e) => e.name === base && e.isFile);
      if (hit) {
        out.push({ rel: prefix, remote, size: Number(hit.size) || 0 });
      } else {
        log(`BACKUP skip (nincs fent) ${prefix}`);
      }
    } catch {
      log(`BACKUP skip (nincs fent) ${prefix}`);
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return dedupeRemoteFiles(out);
}

async function walkRemote(client, absDir, relBase, out, log) {
  let entries;
  try {
    entries = await client.list(absDir);
  } catch (err) {
    log(`BACKUP list fail ${absDir}: ${errorText(err)}`);
    return;
  }

  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const remote = `${String(absDir).replace(/\/+$/, "")}/${entry.name}`;
    if (entry.isDirectory) {
      await walkRemote(client, remote, rel, out, log);
    } else if (entry.isFile) {
      out.push({ rel, remote, size: Number(entry.size) || 0 });
    }
  }
}

function dedupeRemoteFiles(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (seen.has(f.rel)) continue;
    seen.add(f.rel);
    out.push(f);
  }
  return out;
}

export function formatStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Új ZIP útvonal — soha nem ír felül meglévő fájlt. */
export function uniqueZipPath(dir, stem) {
  let candidate = path.join(dir, `${stem}.zip`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${n}.zip`);
    n += 1;
  }
  return candidate;
}

/**
 * Emberi (és hibajegybe másolható) hibaüzenet: fázis, host:port, FTP user,
 * távoli IP, próbálkozás száma. Pont ezek a mezők hiányoztak a szolgáltatónak
 * küldött hibajelentésből.
 */
function pushFailure(profile, phase, attempt, remoteIp, err) {
  const context = [
    `fázis: ${PHASE_LABEL[phase] ?? phase}`,
    `${profile.host}:${profile.port}`,
    `user=${profile.user}`,
  ];
  if (remoteIp) context.push(`távoli IP=${remoteIp}`);
  if (attempt > 1) context.push(`${attempt}/${PUSH_ATTEMPTS} próbálkozás`);
  const error = new Error(`Feltöltés megszakadt — ${context.join(" · ")} — ${errorText(err)}`);
  return Object.assign(error, { code: "FTP_PUSH_FAILED", phase, cause: err });
}
