/**
 * Futás-kezelő a hosszú FTP-műveletekhez (deploy, extra deploy, ZIP-mentés).
 *
 * MIÉRT: a feltöltés percekig is eltarthat, a böngésző viszont nem várhat. A
 * művelet a HOST folyamatában fut (nem gyerekfolyamat — így nincs konzolablak,
 * AGENTS §1), az állapotot pedig `state\ftp-deploy-status.json`-ba írjuk, amit a
 * panel 2 s-onként polloz. Egyszerre EGY művelet futhat: a másodikat elutasítjuk
 * (ugyanaz a védelem, mint a Kiadás gombnál).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const WRITE_INTERVAL_MS = 500;

export function createRunner({ statusFile }) {
  let current = null;
  let lastWriteAt = 0;

  function persist(force = false) {
    if (!current) return;
    const now = Date.now();
    if (!force && now - lastWriteAt < WRITE_INTERVAL_MS) return;
    lastWriteAt = now;
    current.updatedAt = new Date(now).toISOString();
    try {
      writeFileSync(statusFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    } catch {
      /* az állapot írása nem állíthatja meg a deployt */
    }
  }

  function snapshot() {
    if (current) return { ...current, inFlight: true };
    if (!existsSync(statusFile)) return { state: "none", inFlight: false };
    try {
      const parsed = JSON.parse(readFileSync(statusFile, "utf8").replace(/^\uFEFF/, ""));
      // A lemezen maradt „running" a host újraindulása után elavult: a futás
      // ugyanis ebben a folyamatban él, nem a fájlban.
      return { ...parsed, inFlight: false };
    } catch {
      return { state: "none", inFlight: false };
    }
  }

  function busy() {
    return current !== null;
  }

  /**
   * @param {"push"|"push-extra"|"backup"} kind
   * @param {string} profileId
   * @param {(progress: Function) => Promise<any>} task
   */
  async function start(kind, profileId, task) {
    if (current) {
      throw Object.assign(new Error("Már fut egy FTP-művelet — várd meg a végét."), {
        code: "FTP_BUSY",
      });
    }
    const startedAt = new Date().toISOString();
    current = {
      state: "running",
      kind,
      profileId,
      phase: "connect",
      done: 0,
      total: 0,
      uploaded: 0,
      deleted: 0,
      bytes: 0,
      current: "",
      result: null,
      error: "",
      startedAt,
      updatedAt: startedAt,
    };
    persist(true);

    const onProgress = (progress) => {
      if (!current) return;
      const { phase, done, total, uploaded, deleted, bytes, current: file } = progress ?? {};
      if (typeof phase === "string") current.phase = phase;
      if (Number.isFinite(done)) current.done = done;
      if (Number.isFinite(total)) current.total = total;
      if (Number.isFinite(uploaded)) current.uploaded = uploaded;
      if (Number.isFinite(deleted)) current.deleted = deleted;
      if (Number.isFinite(bytes)) current.bytes = bytes;
      if (typeof file === "string") current.current = file;
      persist();
    };

    try {
      const result = await task(onProgress);
      current.state = "done";
      current.result = result ?? null;
      current.phase = "kesz";
      current.done = current.total || current.done;
      persist(true);
      return result;
    } catch (error) {
      current.state = "failed";
      current.error = String(error?.message ?? error);
      current.code = error?.code ?? "";
      current.phase = "hiba";
      persist(true);
      throw error;
    } finally {
      current = null;
    }
  }

  return { start, snapshot, busy };
}
