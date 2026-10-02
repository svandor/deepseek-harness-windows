/**
 * YouTube-storyboard kinyerő — avatar-alapanyag.
 *
 * A `yt-dlp` a storyboardot egyetlen `.mhtml` fájlba tölti: laponként egy
 * sprite-kép, benne rácsszerkezetben a kockák. Ez a script:
 *   1. kiolvassa a meta.json-ból a storyboard rácsát (rows/columns) és a lapok
 *      időtartományait,
 *   2. az .mhtml-ből kimenti a sprite JPEG-eket,
 *   3. kiszámolja, melyik lap melyik kockája esik a kért időpontokra,
 *   4. kiírja a `magick -crop` geometriát (a vágást PowerShell végzi, mert a
 *      Node-ból indított piped folyamat a sandboxban EPERM-et kaphat).
 *
 * Használat:
 *   node extract_storyboard.mjs <meta.json> <sb0.mhtml> <ki-mappa> [másodperc...]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A PowerShell átirányítása UTF-16LE BOM-mal írhat — ezt is kezeljük. */
function readTextSmart(path) {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function parseStoryboard(metaText, formatId) {
  const meta = JSON.parse(metaText);
  const formats = meta.formats ?? [];
  const fmt = formats.find((f) => f.format_id === formatId);
  if (!fmt) throw new Error(`nincs ilyen storyboard formatum: ${formatId}`);
  const rows = Number(fmt.rows ?? 0);
  const columns = Number(fmt.columns ?? 0);
  const frags = fmt.fragments ?? [];
  if (!rows || !columns) throw new Error('a formathoz nincs rows/columns a metaadatban');
  // A lapok időtartamai: a fragment.duration az adott lap által lefedett hossz.
  let t = 0;
  const pages = frags.map((fr, index) => {
    const duration = Number(fr.duration ?? 0);
    const page = { index, start: t, duration, end: t + duration, tiles: rows * columns };
    t += duration;
    return page;
  });
  return { rows, columns, pages, totalDuration: t, width: Number(fmt.width ?? 0), height: Number(fmt.height ?? 0) };
}

/**
 * Az .mhtml-t latin1-ként olvassuk: így 1 byte = 1 karakter, veszteség nélkül,
 * a bináris kép-részek sértetlenek maradnak (a yt-dlp nyers binárisként írja
 * a storyboard-képeket, NEM base64-ként).
 */
function readBinaryAsLatin1(path) {
  return readFileSync(path).toString('latin1');
}

function extractImages(mhtmlLatin1, outDir) {
  const boundaryMatch = /boundary="([^"]+)"/i.exec(mhtmlLatin1);
  if (!boundaryMatch) throw new Error('nincs MIME boundary az mhtml-ben');
  const boundary = boundaryMatch[1];
  const parts = mhtmlLatin1.split(`--${boundary}`);
  const images = [];
  for (const part of parts) {
    const typeMatch = /Content-Type:\s*image\/([a-z0-9.+-]+)/i.exec(part);
    if (!typeMatch) continue;
    const ext = typeMatch[1].toLowerCase().replace('jpeg', 'jpg');
    const sepIndex = part.indexOf('\r\n\r\n');
    const sepLen = sepIndex >= 0 ? 4 : 2;
    const at = sepIndex >= 0 ? sepIndex : part.indexOf('\n\n');
    if (at < 0) continue;
    let body = part.slice(at + sepLen);
    const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(part);
    const index = images.length;
    const path = join(outDir, `sprite-${String(index).padStart(2, '0')}.${ext}`);
    const bytes = isBase64
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : Buffer.from(body, 'latin1');
    writeFileSync(path, bytes);
    images.push(path);
  }
  return images;
}

function main() {
  const [metaPath, mhtmlPath, outDir, formatId = 'sb0', ...timesRaw] = process.argv.slice(2);
  if (!metaPath || !mhtmlPath || !outDir) {
    console.error('Hasznalat: node extract_storyboard.mjs <meta.json> <sb0.mhtml> <ki-mappa> [formatId] [masodperc...]');
    return 1;
  }
  const times = (timesRaw.length ? timesRaw : ['370', '385', '400']).map(Number);
  mkdirSync(outDir, { recursive: true });

  const sb = parseStoryboard(readTextSmart(metaPath), formatId);
  const images = extractImages(readBinaryAsLatin1(mhtmlPath), outDir);
  console.log(`racs: ${sb.rows} sor x ${sb.columns} oszlop, lapok: ${sb.pages.length}, sprite-ok: ${images.length}`);

  const tileW = sb.width || 160;
  const tileH = sb.height || 90;
  const jobs = [];
  for (const t of times) {
    const page = sb.pages.find((p) => t >= p.start && t < p.end) ?? sb.pages[sb.pages.length - 1];
    const tileDuration = page.duration / page.tiles;
    const tileIndex = Math.min(page.tiles - 1, Math.floor((t - page.start) / tileDuration));
    const row = Math.floor(tileIndex / sb.columns);
    const col = tileIndex % sb.columns;
    const sprite = images[page.index];
    if (!sprite) {
      console.log(`${t}s: nincs sprite a ${page.index}. laphoz`);
      continue;
    }
    const geom = `${tileW}x${tileH}+${col * tileW}+${row * tileH}`;
    const out = join(outDir, `crop-${String(Math.round(t)).padStart(4, '0')}.png`);
    jobs.push({ time: t, sprite, geom, out, page: page.index, tile: tileIndex, row, col });
    console.log(`${t}s -> lap ${page.index} (${page.start.toFixed(1)}-${page.end.toFixed(1)}s), kocka ${tileIndex} (sor ${row}, oszlop ${col})`);
  }
  writeFileSync(join(outDir, 'crop-jobs.json'), JSON.stringify(jobs, null, 2), 'utf8');
  console.log(`vagasi terv: ${join(outDir, 'crop-jobs.json')}`);
  return 0;
}

export { parseStoryboard, extractImages, readTextSmart };

// Közvetlen futtatáskor azonnal dolgozunk (a fájl-URL összehasonlítás a
// szóközt tartalmazó útvonalakon törékeny, ezért nem használjuk).
process.exit(main());
