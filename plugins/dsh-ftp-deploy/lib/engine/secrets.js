/**
 * FTP-jelszavak: Windows DPAPI (`CurrentUser`), a Felpuffantó `secrets.ts` portja.
 *
 * MIÉRT DPAPI és nem sima fájl: a jelszó a bejelentkezett felhasználóhoz kötve
 * titkosított, tehát a fájl ellopása/másolása önmagában nem ad jelszót, és a
 * naplóba/válaszba SOHA nem kerül vissza (a felület csak azt látja, hogy van-e).
 *
 * A jelszó a PowerShell **stdin**-jén megy (nem parancssori argumentumban),
 * így nem látszik a folyamatlistában.
 */
import { existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

function runPowerShell(script, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `PowerShell kilépési kód: ${code}`));
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin, "utf8");
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

const psQuote = (value) => JSON.stringify(String(value));

export async function setPassword(secretPath, password) {
  const script = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$prot = [Security.Cryptography.ProtectedData]::Protect(
  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes(${psQuote(secretPath)}, $prot)
`;
  await runPowerShell(script, String(password));
}

export async function getPassword(secretPath) {
  if (!existsSync(secretPath)) return null;
  try {
    const script = `
Add-Type -AssemblyName System.Security
$prot = [IO.File]::ReadAllBytes(${psQuote(secretPath)})
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $prot, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;
    const value = (await runPowerShell(script)).replace(/^\uFEFF/, "");
    return value.length ? value : null;
  } catch {
    return null;
  }
}

export function hasPassword(secretPath) {
  return existsSync(secretPath);
}

export function deletePassword(secretPath) {
  if (existsSync(secretPath)) unlinkSync(secretPath);
}
