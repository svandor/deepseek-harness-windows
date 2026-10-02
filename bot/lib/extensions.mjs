/**
 * Telepítésenkénti integrációs modulok.
 *
 * MIÉRT: a robot-panel és az agent **keretrendszer** — nyilvános. Az, hogy egy
 * adott gépen milyen külső rendszerhez kapcsolódik (milyen feladatot végez,
 * milyen webhookot fogad, mit figyel), viszont a telepítő dolga, és nem
 * tartozik a repóra. Ezért a konkrétumok egy **gépenkénti** leíróban élnek:
 *
 *     bot/extensions.json      (a .gitignore kizárja)
 *
 * A panel és az agent ebből tudja meg, mi van telepítve. Modul nélkül egyetlen
 * feladatnév sem szerepel a kódban vagy a felületen.
 *
 * A leíró formátuma:
 *
 *     {
 *       "integraciok": [
 *         {
 *           "id": "sajat-integracio",
 *           "webhook": "/webhook/sajat",          // opcionális: ide érkezik a külső kérés
 *           "orchestrator": "sajat/flow.mjs",     // opcionális: ezt indítja a webhook
 *           "badge": { "hu": "webhook: /webhook/sajat", "en": "..." },
 *           "chip": { "hu": "Napló", "en": "Log", "parancs": "/sajat" },
 *           "figyelo": "sajat/collect.mjs",       // opcionális: megjeleníti az oldal-figyelőt
 *           "beallitasok": [
 *             { "utvonal": "sajat.callbackUrl", "cimkeHu": "Callback URL", "cimkeEn": "Callback URL" },
 *             { "utvonal": "sajat.titok", "cimkeHu": "Titok", "cimkeEn": "Secret", "titok": true }
 *           ],
 *           "szemelyiseg": "sajat/agent.md"       // opcionális: az agent.md végére fűzve
 *         }
 *       ]
 *     }
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A leíró beolvasása. Hibás/olvashatatlan fájl esetén üres lista (nem áll meg a panel). */
export function loadExtensions(botDir) {
  const path = join(botDir, 'extensions.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(raw?.integraciok) ? raw.integraciok : [];
    return list.filter((e) => e && typeof e.id === 'string' && e.id.length > 0);
  } catch {
    return [];
  }
}

/** Az integrációhoz tartozó, a bot mappához képest értett útvonal, ha a fájl létezik. */
export function extensionFile(botDir, extension, field) {
  const rel = extension?.[field];
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const path = join(botDir, rel);
  return existsSync(path) ? path : null;
}

/**
 * Van-e oldalfigyelő modul? Ez a `figyelo` mezőjű integrációkra igaz — a
 * beállítás-lapon csak ilyenkor jelenik meg az oldallista.
 */
export function hasWatcher(extensions) {
  return extensions.some((e) => typeof e.figyelo === 'string' && e.figyelo.length > 0);
}

/** Egy címke (badge/chip) adott nyelvű szövege, magyar tartalékkal. */
export function label(meta, lang) {
  if (!meta || typeof meta !== 'object') return '';
  return meta[lang] || meta.hu || meta.en || '';
}
