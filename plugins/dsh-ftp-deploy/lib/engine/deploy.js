/**
 * A deploy vezérlése — a Felpuffantó `src\engine\index.ts` portja.
 *
 * A felület (panel vagy gyorsgomb) csak ezt hívja; minden ellenőrzés itt van,
 * hogy a CLI és a UI pontosan ugyanazt csinálja („CLI = UI”, nincs két igazság).
 */
import { collectPreviewFiles, currentHead } from "./gitdiff.js";
import { collectTreeFiles } from "./tree.js";
import { createLog } from "./log.js";
import { ensureFtpDirs, ftpPaths } from "./paths.js";
import {
  deleteProfile,
  getProfile,
  listProfiles,
  setLastDeploySha,
  upsertProfile,
} from "./profiles.js";
import {
  backupRemoteToZip,
  listRemoteDirectories,
  testConnection,
  uploadFiles,
} from "./ftp.js";
import { deletePassword, getPassword, hasPassword, setPassword } from "./secrets.js";

/** Ennyi fájl fölött a felület második megerősítést kér (és a motor is). */
export const LARGE_FILE_LIMIT = 80;

export function createDeploy({ repoRoot }) {
  const paths = ftpPaths(repoRoot);
  ensureFtpDirs(paths);
  const log = createLog(paths.logFile);

  const append = (line) => log.append(line);
  const secretOf = (profileId) => paths.secretPath(profileId);

  function list() {
    return listProfiles(paths.profilesPath).map((p) => ({
      ...p,
      hasPassword: hasPassword(secretOf(p.id)),
    }));
  }

  function get(id) {
    return getProfile(paths.profilesPath, id);
  }

  function upsert(input) {
    return upsertProfile(paths.profilesPath, input);
  }

  function remove(id) {
    const removed = deleteProfile(paths.profilesPath, id);
    if (removed) deletePassword(secretOf(id));
    return removed;
  }

  async function requirePassword(id) {
    const password = await getPassword(secretOf(id));
    if (!password) throw new Error("Nincs mentett FTP-jelszó ehhez a profilhoz.");
    return password;
  }

  async function preview(id) {
    const profile = get(id);
    const collected = await collectPreviewFiles(profile.localRoot, profile.include, profile.lastDeploySha, {
      allow: profile.allow,
    });
    return {
      ok: true,
      profileId: id,
      needsBaseline: collected.needsBaseline,
      headSha: collected.headSha,
      lastDeploySha: profile.lastDeploySha,
      files: collected.files,
      blocked: collected.blocked,
      large: collected.files.length > LARGE_FILE_LIMIT,
      largeLimit: LARGE_FILE_LIMIT,
    };
  }

  /** Gitignore-olt seed mappák előnézete — nem git-diff. */
  async function previewExtra(id) {
    const profile = get(id);
    const trees = profile.extraUpload?.length ? profile.extraUpload : [];
    if (trees.length === 0) {
      throw new Error("Ehhez a profilhoz nincs extra feltöltés (extraUpload) beállítva.");
    }
    const files = [];
    const blocked = [];
    let bytes = 0;
    for (const tree of trees) {
      const part = await collectTreeFiles(profile.localRoot, tree, { allow: profile.allow });
      files.push(...part.files);
      blocked.push(...part.blocked);
      bytes += part.bytes;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const headSha = await currentHead(profile.localRoot);
    return {
      ok: true,
      profileId: id,
      needsBaseline: false,
      headSha,
      lastDeploySha: profile.lastDeploySha,
      files,
      blocked,
      bytes,
      large: files.length > LARGE_FILE_LIMIT,
      largeLimit: LARGE_FILE_LIMIT,
    };
  }

  /**
   * „Ami most fent van = a mostani git állapot." Ez az első lépés egy új
   * projektnél (különben a deploy a teljes fát feltöltené).
   */
  async function baseline(id) {
    const profile = get(id);
    const head = await currentHead(profile.localRoot);
    if (!head) throw new Error("Nincs aktuális git állapot — a kiindulópontot nem lehet beállítani.");
    setLastDeploySha(paths.profilesPath, id, head);
    append(`BASELINE profile=${id} sha=${head}`);
    return { ok: true, profileId: id, lastDeploySha: head };
  }

  async function push({ profileId, confirm, forceLarge, onProgress }) {
    if (!confirm) {
      throw Object.assign(new Error("A feltöltéshez megerősítés kell."), { code: "NEED_CONFIRM" });
    }
    const shown = await preview(profileId);
    if (shown.needsBaseline) {
      throw new Error("Nincs kiindulópont. Először: „a mostani git állapot = már fent van”.");
    }
    if (shown.files.length === 0) throw new Error("Nincs élesítendő fájl.");
    if (shown.large && !forceLarge) {
      throw Object.assign(
        new Error(
          `Több mint ${shown.largeLimit} fájl (${shown.files.length}). Ismételd megerősítéssel, kényszerített nagy feltöltéssel.`,
        ),
        { code: "NEED_FORCE_LARGE", preview: shown },
      );
    }
    const profile = get(profileId);
    const password = await requirePassword(profileId);
    const sent = await uploadFiles(profile, password, shown.files, { log: append, onProgress });
    const head = shown.headSha;
    if (head) setLastDeploySha(paths.profilesPath, profileId, head);
    append(`PUSH baseline updated profile=${profileId} sha=${head ?? ""}`);
    return {
      ok: true,
      profileId,
      uploaded: sent.uploaded,
      deleted: sent.deleted,
      bytes: sent.bytes,
      attempts: sent.attempts,
      lastDeploySha: head,
      logFile: sent.logFile,
    };
  }

  /** Extra (gitignore-olt) fák feltöltése — a git baseline-t NEM mozgatja. */
  async function pushExtra({ profileId, confirm, forceLarge, onProgress }) {
    if (!confirm) {
      throw Object.assign(new Error("A feltöltéshez megerősítés kell."), { code: "NEED_CONFIRM" });
    }
    const shown = await previewExtra(profileId);
    if (shown.files.length === 0) throw new Error("Nincs feltöltendő extra fájl (üres mappa?).");
    if (shown.large && !forceLarge) {
      throw Object.assign(
        new Error(
          `Több mint ${shown.largeLimit} fájl (${shown.files.length}). Ismételd megerősítéssel, kényszerített nagy feltöltéssel.`,
        ),
        { code: "NEED_FORCE_LARGE", preview: shown },
      );
    }
    const profile = get(profileId);
    const password = await requirePassword(profileId);
    const sent = await uploadFiles(profile, password, shown.files, { log: append, onProgress });
    return {
      ok: true,
      profileId,
      uploaded: sent.uploaded,
      deleted: sent.deleted,
      bytes: sent.bytes,
      attempts: sent.attempts,
      lastDeploySha: profile.lastDeploySha,
      logFile: sent.logFile,
    };
  }

  async function test(profileId) {
    const profile = get(profileId);
    const password = await requirePassword(profileId);
    const result = await testConnection(profile, password, { log: append });
    return { ok: true, profileId, cwd: result.cwd };
  }

  async function listRemote(profileId, remotePath) {
    const profile = get(profileId);
    const password = await requirePassword(profileId);
    const listed = await listRemoteDirectories(profile, password, remotePath);
    return { ok: true, path: listed.path, dirs: listed.dirs };
  }

  /** Éles FTP biztonsági mentés helyi ZIP-be („Lepuffantás”). */
  async function backup({ profileId, destDir, mode, onProgress }) {
    const profile = get(profileId);
    const password = await requirePassword(profileId);
    const safeMode = mode === "code" ? "code" : "full";
    const sent = await backupRemoteToZip(
      profile,
      password,
      destDir || paths.backupsDir,
      safeMode,
      { log: append, onProgress },
    );
    return {
      ok: true,
      profileId,
      mode: safeMode,
      zipPath: sent.zipPath,
      files: sent.files,
      bytes: sent.bytes,
      logFile: sent.logFile,
    };
  }

  async function savePassword(id, password) {
    get(id); // léteznie kell a profilnak
    if (!password || String(password).length === 0) throw new Error("Üres jelszó nem menthető.");
    await setPassword(secretOf(id), password);
    append(`SECRET saved profile=${id}`);
    return { ok: true, profileId: id, saved: true };
  }

  return {
    paths,
    log: append,
    profiles: { list, get, upsert, remove, hasPassword: (id) => hasPassword(secretOf(id)) },
    preview,
    previewExtra,
    baseline,
    push,
    pushExtra,
    test,
    listRemote,
    backup,
    savePassword,
  };
}
