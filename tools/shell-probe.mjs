/**
 * shell-probe.mjs — manual check of the interactive-shell behaviour the terminal
 * panel depends on: a session that survives a command, keeps its working
 * directory, accepts a second command, accepts a multi-line block, and reports
 * where the echoed input ends.
 *
 * The panel's host half cannot be reached without restarting the harness, so this
 * runs the same spawn shape directly:
 *
 *     node tools/shell-probe.mjs
 */
import { spawn } from "node:child_process";

const cwd = process.cwd();
const child = spawn("powershell.exe", [
  "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "-"
], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function write(text) {
  const before = output.length;
  child.stdin.write(text.endsWith("\n") ? text : text + "\n");
  return before;
}

async function main() {
  await sleep(700);
  console.log("--- sessio elindult, pid", child.pid);
  console.log("kimenet hossz a kezdetkor:", output.length);
  console.log("kezdo konyvtar latszik-e a kimenetben:", /PS\s+[A-Z]:\\/u.test(output));

  const at1 = write("Get-Location");
  await sleep(900);
  const afterFirst = output.slice(at1);
  console.log("\n--- 1. parancs utan (", afterFirst.length, "karakter )");
  console.log(afterFirst.trim().split(/\r?\n/u).slice(0, 6).join("\n"));

  const at2 = write("cd ..");
  await sleep(700);
  const at3 = write("Write-Output ('most: ' + (Get-Location).Path)");
  await sleep(900);
  const afterMove = output.slice(at3);
  console.log("\n--- konyvtarvaltas utan (", afterMove.length, "karakter )");
  console.log(afterMove.trim().split(/\r?\n/u).slice(0, 6).join("\n"));

  const multi = "Write-Output 'elso'\nWrite-Output 'masodik'";
  const at4 = write(multi);
  await sleep(1200);
  const afterMulti = output.slice(at4);
  console.log("\n--- tobbosros blokk utan (", afterMulti.length, "karakter )");
  console.log(afterMulti.trim().split(/\r?\n/u).slice(0, 8).join("\n"));

  const running = child.exitCode === null;
  console.log("\n--- sessio meg el:", running);
  try { child.stdin.end(); child.kill(); } catch { }
  process.exit(running ? 0 : 1);
}

main();
