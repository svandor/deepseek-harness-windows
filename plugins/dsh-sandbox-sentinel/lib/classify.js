/**
 * dsh-sandbox-sentinel/classify — a sandbox NÉMA hibaosztályainak felismerése.
 *
 * MIÉRT: a harness csak HÁROM angol hibaüzenetből ismeri fel, hogy „ez a
 * sandbox" (`access is denied`, `access to the path`, `permission denied`).
 * A mért hibaosztályok nagy része viszont MÁSKÉPP néz ki — vagy magyarul
 * jelenik meg —, ezért a tool-kimenetben ott marad egy érthetetlen hiba, az
 * ágens pedig vagy feladja, vagy rosszul diagnosztizál.
 *
 * MÉRT ESET (2026-11-27, Vector session `765b76d2`, a 240Hz-vizsgálat):
 *   `& pwsh -File tools\display-mode.ps1 -Status 2>&1 | Out-String`
 *   `& nvidia-smi --query-gpu=… 2>&1 | Out-String`
 * → `Program 'pwsh.exe' failed to run: Access to the path
 *    '\\.\pipe\LOCAL\dotnet_…' is denied`
 * Az ágens naplójában ez így jelent meg: „Sandbox blocked launching external
 * programs?" — VAGYIS ROSSZ DIAGNÓZIS. Valójában nem a program indítása
 * tilos, hanem a **kimenet csővezetéken át való elkapása**. Ugyanaz a két
 * parancs `cmd /c "… > fájl"` alakban azonnal lefutott (exit 0, mért).
 *
 * Ez a modul TISZTA (nincs FS, nincs hálózat): bemenet a tool-kimenet
 * szövege, kimenet a hozzá tartozó magyarázat + a konkrét teendő.
 */

/** @typedef {"pipe-capture"|"msys-sh"|"schannel-tls"|"chromium-sandbox"|"node-spawn"|"sandbox-write"|"access-denied-hu"} SandboxClass */

/**
 * @typedef {object} SandboxHit
 * @property {SandboxClass} id a hibaosztály azonosítója
 * @property {string} title egy soros cím a modellnek
 * @property {string} body a teendő (konkrét, másolható minta)
 * @property {boolean} escalate kell-e hozzá eszkaláció (a legtöbb esetben NEM)
 */

/** A natív program kimenetének elkapása (named pipe) — a legfontosabb eset. */
const PIPE_HINT =
  'Ez NEM a parancs hibája: a sandbox a programok közti csővezetéket (named pipe) tiltja, ezért a PowerShell NEM tudja elkapni egy natív program kimenetét. ' +
  'Eszkaláció NEM kell. A működő minta:\n' +
  '  cmd /c "prog --kapcsoló > %TEMP%\\kimenet.txt 2>&1"   majd   Get-Content $env:TEMP\\kimenet.txt\n' +
  'Ugyanígy fut: Start-Process -Wait -NoNewWindow -RedirectStandardOutput fájl. ' +
  'TILOS alak: `& prog … | Out-String`, `$x = prog …`, `prog … 2>&1 | Select-Object …`, `prog … *> fájl`.';

/** @type {Array<{id: SandboxClass, title: string, body: string, escalate: boolean, match: (text: string) => boolean}>} */
const RULES = [
  {
    id: 'pipe-capture',
    title: 'A kimenet elkapása (named pipe) volt a hiba — a parancs jó, a forma rossz.',
    body:
      PIPE_HINT +
      '\nMÉRVE (2026-11-27): `& pwsh -File … -Status` és `& nvidia-smi --query-gpu=…` így hasalt el, ' +
      'míg `cmd /c "… > fájl"` alakban azonnal lefutott (exit 0).',
    escalate: false,
    match: (text) =>
      // A mért alak: Program 'X' failed to run: Access to the path '\\.\pipe\LOCAL\dotnet_…' is denied
      (/failed to run[^\n]*\\pipe\\/iu.test(text) ||
        /\\pipe\\[^\n]*denied/iu.test(text) ||
        /\\pipe\\[^\n]*megtagadva/iu.test(text) ||
        /pipe is being closed|broken pipe/iu.test(text))
  },
  {
    id: 'msys-sh',
    title: 'Az MSYS `sh.exe` nem tud csatornát nyitni — a shell-alapú git-út hal el.',
    body:
      'A Githez adott Unix-shell (sh.exe) fork-emulációja névtelen csövet nyit, amit a sandbox tilt ' +
      '(`couldn\'t create signal pipe`). Ezért a `core.sshCommand`, a `GIT_SSH_COMMAND` és a `!`-lel kezdődő ' +
      'credential helper (pl. `!gh auth git-credential`) MINDIG elhal. Megoldás: `GIT_SSH` a NATÍV OpenSSH-ra ' +
      '(beállítva: `C:\\Windows\\System32\\OpenSSH\\ssh.exe`), és SSH remote HTTPS helyett; a privát HTTPS a ' +
      'shell-alapú helper miatt nem megy. Ellenőrzés: `git ls-remote --heads origin`.',
    escalate: false,
    match: (text) => /couldn't create signal pipe|create signal pipe, win32 error/iu.test(text)
  },
  {
    id: 'schannel-tls',
    title: 'A Windows TLS-e (schannel) nem kap hitelesítő adatot — nem hálózati hiba.',
    body:
      'A korlátozott token miatt a schannel nem tud tanúsítvány-hitelesítőt szerezni ' +
      '(`SEC_E_NO_CREDENTIALS 0x8009030e`), ezért a `curl`, az `Invoke-WebRequest`, a `.NET HttpClient` és a ' +
      '`git` HTTPS-en elhasal — miközben a Node OpenSSL-je és a `gh` (Go TLS) ugyanazon a gépen átmegy. ' +
      'Webes kérésre: `web_fetch` (a legjobb), `node -e "fetch(\'URL\').then(r=>r.text()).then(console.log)"`, ' +
      'vagy `gh`. A git HTTPS-hez beállítottuk a `http.sslBackend=openssl`-t, tehát a `git` HTTPS is megy.',
    escalate: false,
    match: (text) => /schannel/iu.test(text) || /sec_e_no_credentials/iu.test(text) || /0x8009030e/iu.test(text)
  },
  {
    id: 'chromium-sandbox',
    title: 'A Chromium/Edge a sandboxban szerkezetileg nem indul — használd a `browser` toolt.',
    body:
      'A Chromium a mojo platform-csatornát és a crashpad névtelen csövét nyitja, amihez a korlátozott token ' +
      'nem kap írási jogot (`platform_channel.cc … A hozzáférés megtagadva (0x5)`, `crashpad OpenProcess`, ' +
      'kilépés `0xC0000003`). Ezt NEM lehet feloldani (a sandbox megnyitása a fájl-védelmet is elvenné), és nem is kell: ' +
      'van `browser` tool (headless Edge a HOST processzben: `open`, `read`, `click`, `type`, `shot`, `download`). ' +
      'Képernyőképhez `shot` + `read_image`.',
    escalate: false,
    match: (text) =>
      /mojo/iu.test(text) ||
      /crashpad/iu.test(text) ||
      /platform_channel/iu.test(text) ||
      /0xc0000003/iu.test(text)
  },
  {
    id: 'node-spawn',
    title: 'A Node `stdio: "pipe"` nem működik a sandboxban (EPERM) — irányíts fájlba.',
    body:
      'A `child_process.spawn`/`execSync` alapértelmezett csövezett kimenete `EPERM`-mel elhal. Megoldás: ' +
      '`stdio: "inherit"` vagy `stdio: "ignore"`, illetve a program kimenetének fájlba irányítása ' +
      '(`cmd /c "prog > fájl"`), majd a fájl beolvasása. Ez a korlát a Node-ból indított gyermekre is igaz.',
    escalate: false,
    match: (text) => /eperm/iu.test(text) && /spawn|spawnsync|exec/iu.test(text)
  },
  {
    id: 'sandbox-write',
    title: 'Írási korlát (a sandbox szándékos védelme) — a munkaterületen kívül nem írhat.',
    body:
      'A sandbox `write-restricted`: a munkaterületen kívüli írás (pl. `~/.dsh`, `%USERPROFILE%`) elutasított. ' +
      'Ez az egyetlen eset, amikor a helyes út a JÓVÁHAGYOTT eszkaláció: pontosan EGYSZER próbáld újra ugyanazt ' +
      'a hívást `sandbox_permissions` (a legszűkebb elég) + `justification` mezővel. Ne kerüld meg más úton.',
    escalate: true,
    match: (text) => /\[sandbox: file access denied/iu.test(text)
  },
  {
    id: 'access-denied-hu',
    title: '„A hozzáférés megtagadva" — magyarul megjelenő sandbox-hiba (a beépített felismerés nem látja).',
    body:
      'A Windows magyar üzenete (`A hozzáférés megtagadva`, `hozzáférés megtagadva`) ugyanannak a korlátozott ' +
      'tokennek a következménye, de a harness csak angol kulcsszavakra illeszt, ezért néma marad. ' +
      'A leggyakoribb ok a névtelen cső (kimenet-elkapás) vagy egy munkaterületen kívüli írás. ' +
      'Először a kimenetet irányítsd fájlba (`cmd /c "… > fájl"`); ha ez nem segít, akkor írási korlát: ' +
      'egyszeri eszkaláció indoklással.',
    escalate: false,
    match: (text) => /hozzáférés megtagadva/iu.test(text) || /a hozzáférés megtagadva/iu.test(text)
  }
];

/**
 * A tool-kimenet osztályozása.
 * @param {string} text a tool-kimenet szövege
 * @returns {SandboxHit|undefined} a találat, vagy undefined (nincs sandbox-jel)
 */
export function classify(text) {
  if (typeof text !== 'string' || text === '') return undefined;
  // A saját jelölőnket ne osztályozzuk újra (ne fűzzük magunkhoz a jegyzetet).
  const probe = text.includes('[sandbox-sentinel]') ? text.split('[sandbox-sentinel]')[0] : text;
  for (const rule of RULES) {
    let hit = false;
    try {
      hit = rule.match(probe);
    } catch {
      hit = false;
    }
    if (hit) return { id: rule.id, title: rule.title, body: rule.body, escalate: rule.escalate };
  }
  return undefined;
}

/**
 * A tool-kimenethez fűzendő jegyzet.
 * @param {SandboxHit} hit
 * @returns {string}
 */
export function noteFor(hit) {
  return (
    `[sandbox-sentinel] ${hit.title}\n${hit.body}` +
    (hit.escalate
      ? '\n(Ez az az eset, amikor az eszkaláció a helyes út.)'
      : '\n(Ez NEM eszkaláció-kérdés: a fenti alakban újra lefuttatva működik.)')
  );
}

/** A session-indító súgó (rövid, hogy ne vigyen el kontextust). */
export const PLAYBOOK =
  '[Sandbox-tudás — rendszerkontextus, NEM felhasználói üzenet; nincs belőle feladat.]\n' +
  'Ez a gép Windows + DSH sandbox (korlátozott token). Négy dolog MINDIG így megy, eszkaláció nélkül:\n' +
  '1) Natív program kimenetét NE csípd el PowerShellben: `& prog … | Out-String`, `$x = prog …`, `prog … 2>&1 | Select-Object` → ' +
  '„Access to the path \\\\.\\pipe\\… is denied". Helyette: cmd /c "prog … > %TEMP%\\out.txt 2>&1", majd Get-Content.\n' +
  '2) HTTPS: `curl`/`Invoke-WebRequest`/HttpClient → `SEC_E_NO_CREDENTIALS` (schannel). Helyette: `web_fetch`, `node -e "fetch(...)"`, `gh`.\n' +
  '3) Böngésző: a Chromium a sandboxban nem indul (mojo/crashpad) — használd a `browser` toolt (open/read/click/type/shot/download).\n' +
  '4) git SSH: `GIT_SSH=C:\\Windows\\System32\\OpenSSH\\ssh.exe` (a shell-alapú `core.sshCommand` elhal). A repók SSH remote-on vannak.\n' +
  'Eszkaláció (`sandbox_permissions`) csak a MUNKATERÜLETEN KÍVÜLI ÍRÁSHOZ kell, egyszer, indoklással.';

/** A felismert osztályok listája (a tesztek és a dokumentáció miatt). */
export const CLASS_IDS = RULES.map((rule) => rule.id);
