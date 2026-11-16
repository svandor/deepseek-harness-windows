# Beágyazott (vendored) függőségek

Ez a mappa **szándékosan** a repóban van, `node_modules` névvel — így a Node
modulfeloldás változtatás nélkül működik (a `yazl` saját `buffer-crc32`
függőségét is megtalálja), viszont nincs `npm install` a felhasználónál, és a
telepítő offline is működik.

| Csomag | Verzió | Licenc | Miért kell |
|---|---|---|---|
| `basic-ftp` | 5.3.1 | MIT | FTP kliens (feltöltés, törlés, lista, letöltés) |
| `yazl` | 3.3.1 | MIT | streamelt ZIP-írás a „Lepuffantás" mentéshez |
| `buffer-crc32` | 1.0.0 | MIT | a `yazl` saját függősége |

A források a Felpuffantó projekt `node_modules`-ából származnak (ott élesben
futnak), a `dist`/`*.js` és a `package.json`, valamint a `LICENSE` másolatai.
A `.gitignore`-ban kivétel (negáció) engedi be ezt a mappát.

## Frissítés

1. az új verzió `package.json` + `dist/*.js` (vagy `index.js`) fájljainak cseréje,
2. `node --test plugins\dsh-ftp-deploy\test\*.test.mjs` (36 teszt, hálózat nélkül),
3. `pwsh -NoProfile -File plugins\dsh-ftp-deploy\install.ps1 -Check`
   (a `vendor` és a `Client=function ZipFile=function` ellenőrzés).
