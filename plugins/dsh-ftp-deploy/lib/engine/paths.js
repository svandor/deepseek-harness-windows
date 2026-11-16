/**
 * Útvonalak és segédek a `dsh-ftp-deploy` pluginhoz.
 *
 * A Felpuffantó (`%APPDATA%\Felpuffanto`) helyett minden a MUNKATERÜLET
 * `state\` mappájába kerül, mert az gitignore-olt: így a profilok, a napló és a
 * titkosított jelszavak soha nem kerülnek a repóba (a repó nyilvános).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** A munkaterület `state\` mappájához tartozó összes FTP-útvonal. */
export function ftpPaths(repoRoot) {
  const stateDir = join(repoRoot, "state");
  const secretsDir = join(stateDir, "ftp-secrets");
  const backupsDir = join(stateDir, "ftp-backups");
  return {
    stateDir,
    secretsDir,
    backupsDir,
    profilesPath: join(stateDir, "ftp-profiles.json"),
    logFile: join(stateDir, "ftp-deploy-log.txt"),
    statusFile: join(stateDir, "ftp-deploy-status.json"),
    secretPath(profileId) {
      const safe = String(profileId).replace(/[^a-zA-Z0-9._-]/g, "_");
      return join(secretsDir, `${safe}.dpapi`);
    },
  };
}

/** A `state\` alkönyvtárait létrehozza (idempotens). */
export function ensureFtpDirs(paths) {
  for (const dir of [paths.stateDir, paths.secretsDir, paths.backupsDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* a hívó úgyis jelezni fogja, ha írni akar és nem megy */
    }
  }
}

/**
 * Git/FTP-relatív útvonal: per-jelölt, vezető `/` nélkül.
 * (A Felpuffantó `posixRel` portja — a Windows-útvonalakból per-jelet csinál.)
 */
export function posixRel(rel) {
  return String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
}
