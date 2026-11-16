/**
 * Deploy-napló: egy fájl a `state\` alatt, 2 MB fölött rotálással (ugyanaz a
 * minta, mint a `release-log.txt`-nél). A napló SOHA nem tartalmaz jelszót:
 * a hívók csak felhasználót, hostot, portot és fájlútvonalat írnak bele.
 */
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

const ROTATE_BYTES = 2 * 1024 * 1024;

export function createLog(logFile) {
  function rotateIfNeeded() {
    try {
      if (!existsSync(logFile)) return;
      if (statSync(logFile).size < ROTATE_BYTES) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      renameSync(logFile, `${logFile}.${stamp}.bak`);
    } catch {
      /* a rotálás hibája nem állíthatja meg a deployt */
    }
  }

  /** Egy sor a naplóba; visszaadja a napló útvonalát (a motor ezt adja tovább). */
  function append(line) {
    rotateIfNeeded();
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      /* ha nem megy, a deploy attól még lefut */
    }
    return logFile;
  }

  return { logFile, append };
}
