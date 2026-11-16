/**
 * A beágyazott (vendored) függőségek egyetlen belépési pontja.
 *
 * MIÉRT: a DSH plugin a repóból fut, és a telepítő offline kell működjön, ezért
 * a `basic-ftp` (MIT) és a `yazl` (MIT) forrása a `vendor\node_modules` alatt
 * utazik a repóval — nincs `npm install` a felhasználónál. A `buffer-crc32` a
 * `yazl` saját függősége, ezért van ugyanabban a mappában (Node így megtalálja).
 *
 * Frissítés: a `vendor\node_modules\*\package.json` verziója + a `dist` másolása
 * (lásd `docs\FTP-DEPLOY.md`), majd `node --test plugins/dsh-ftp-deploy/test`).
 */
import basicFtp from "../../vendor/node_modules/basic-ftp/dist/index.js";
import yazl from "../../vendor/node_modules/yazl/index.js";

export const Client = basicFtp.Client;
export const ZipFile = yazl.ZipFile;
export const versions = {
  basicFtp: basicFtp.version ?? "",
  yazl: yazl.version ?? "",
};
