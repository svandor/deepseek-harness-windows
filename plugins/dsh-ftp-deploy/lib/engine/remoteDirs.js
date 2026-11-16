/**
 * Távoli mappák idempotens biztosítása egy FTP-kapcsolaton belül.
 *
 * Miért nem `client.ensureDir()`: az basic-ftp minden szintre vakon küld egy
 * `MKD`-t (és a `/`-tól indulva minden fájlnál újra végigjárja az egész utat),
 * így a meglévő mappákra a szerver `550 Can't create directory: File exists`
 * hibát naplóz. Egy 12 fájlos push ~84 ilyen ERROR sort tett a tárhely
 * naplójába, amit a szolgáltató klienshibának nézett.
 *
 * Ez az osztály listával (MLSD/LIST) ellenőrzi, hogy a mappa megvan-e, és csak
 * a tényleg hiányzó szintre küld `MKD`-t — így a szerver- és a saját napló
 * tiszta marad, a körlevelek (CWD) pedig elmaradnak, mert a feltöltés abszolút
 * úttal megy.
 */

/** `/web/laravel12/resources` + `views` -> `/web/laravel12/resources/views` */
export function joinRemote(dir, name) {
  const base = normalizeRemote(dir);
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

/** Egységes, abszolút, per-jelölt távoli útvonal (nincs dupla `/`, nincs záró `/`). */
export function normalizeRemote(raw) {
  const cleaned = String(raw ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  if (!cleaned) return "/";
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

/** A fájl távoli mappája (a remoteRoot-tal együtt, abszolútan). */
export function remoteDirOf(remoteFile) {
  const path = normalizeRemote(remoteFile);
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

export class RemoteDirIndex {
  /** @param {{ list: Function, cd: Function, sendIgnoringError: Function }} client */
  constructor(client) {
    this.client = client;
    this.known = new Set(["/"]);
    this.listings = new Map();
    this.checkedCount = 0;
    this.createdCount = 0;
  }

  async ensure(absDirRaw) {
    const absDir = normalizeRemote(absDirRaw);
    if (this.known.has(absDir)) return;

    let current = "/";
    for (const name of absDir.split("/").filter((part) => part !== "")) {
      const child = joinRemote(current, name);
      if (!this.known.has(child)) {
        await this.ensureOne(current, name, child);
      }
      current = child;
    }
    this.known.add(absDir);
  }

  get stats() {
    return { checked: this.checkedCount, created: this.createdCount };
  }

  async ensureOne(parent, name, child) {
    const exists = await this.hasEntry(parent, name);
    if (exists === true) {
      this.known.add(child);
      return;
    }

    // A szülő létezését fentről lefelé haladva már biztosítottuk, ezért a
    // relatív MKD + CWD minden FTP-szerveren működik (az abszolút MKD nem mindenhol).
    try {
      await this.client.cd(parent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`A távoli mappa nem érhető el: ${parent} (${message})`);
    }

    const res = await this.client.sendIgnoringError(`MKD ${name}`);
    if (res.code === 257) {
      this.createdCount += 1;
      this.remember(parent, name);
      this.known.add(child);
      return;
    }
    // 550 = közben valaki/valami létrehozta (versenyhelyzet) — ez nem hiba.
    // Minden más kód valódi probléma (jogosultság, kvóta): itt álljunk meg,
    // a feltöltésnél már csak később, zavarosabban derülne ki.
    if (res.code === 550) {
      this.remember(parent, name);
      this.known.add(child);
      return;
    }
    throw new Error(
      `A távoli mappa nem hozható létre: ${child} (${res.code} ${String(res.message).trim()})`,
    );
  }

  /** `true` = megvan, `false` = biztos, hogy nincs, `null` = nem tudjuk (listázás hiba). */
  async hasEntry(parent, name) {
    let names = this.listings.get(parent);
    if (names === undefined) {
      try {
        const entries = await this.client.list(parent);
        names = new Set(entries.map((entry) => entry.name));
        // Amit most listában láttunk, az létezik: a mélyebb szinteknél spórolunk vele.
        for (const entry of entries) {
          if (entry.isDirectory) this.known.add(joinRemote(parent, entry.name));
        }
      } catch {
        names = null;
      }
      this.checkedCount += 1;
      this.listings.set(parent, names);
    }
    if (names === null) return null;
    return names.has(name);
  }

  remember(parent, name) {
    const names = this.listings.get(parent);
    if (names) names.add(name);
  }
}
