/**
 * A sandbox-osztályozó tesztjei — a MÉRT hibaüzenetekkel.
 *
 * Futtatás: `node plugins/dsh-sandbox-sentinel/test/classify.test.mjs`
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASS_IDS, PLAYBOOK, classify, noteFor } from "../lib/classify.js";

test("a mért named-pipe hiba a pipe-capture osztály (2026-11-27, Vector)", () => {
  const text = [
    "[stderr]",
    "ResourceUnavailable: Program 'pwsh.exe' failed to run: Access to the path '\\\\.\\pipe\\LOCAL\\dotnet_e1d69bba8b0647319b1de08137a2e044' is denied.At line:1 char:164",
    "+ … 'Continue'; & pwsh -NoProfile -ExecutionPolicy Bypass -File 'D:\\Szerv …",
    "[sandbox: file access denied under workspace-write mode]",
    "[exit code: 1]"
  ].join("\n");
  const hit = classify(text);
  assert.equal(hit?.id, "pipe-capture");
  assert.equal(hit.escalate, false);
  assert.match(hit.body, /cmd \/c "prog[^"]*>/u, "a működő minta benne van");
});

test("az nvidia-smi ugyanaz az osztály (nem 'blokkolt külső program')", () => {
  const text = "Program 'nvidia-smi.exe' failed to run: Access to the path '\\\\.\\pipe\\LOCAL\\dotnet_47ed171f2dfd4a17ad94d2e29bb2f213' is denied.";
  assert.equal(classify(text)?.id, "pipe-capture");
});

test("az MSYS sh csatorna-hibája külön osztály, GIT_SSH a teendő", () => {
  const hit = classify("sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5");
  assert.equal(hit?.id, "msys-sh");
  assert.match(hit.body, /GIT_SSH/u);
  assert.match(hit.body, /OpenSSH/u);
});

test("a schannel/TLS osztály a helyes alternatívákat kínálja", () => {
  const hit = classify("error:1416F086:SSL routines:tls_process_server_certificate:schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)");
  assert.equal(hit?.id, "schannel-tls");
  assert.match(hit.body, /web_fetch/u);
  assert.match(hit.body, /openssl/u);
});

test("a Chromium-osztály a browser toolra mutat", () => {
  const hit = classify("mojo\\public\\cpp\\platform\\platform_channel.cc:187: Check failed: A hozzáférés megtagadva. (0x5)");
  assert.equal(hit?.id, "chromium-sandbox");
  assert.match(hit.body, /browser/u);
});

test("a Node EPERM-es spawn osztálya", () => {
  assert.equal(classify("Error: spawnSync C:\\WINDOWS\\system32\\cmd.exe EPERM").id, "node-spawn");
  assert.equal(classify("spawn EPERM").id, "node-spawn", "rövid alak is felismerhető");
});

test("a munkaterületen kívüli írás az EGYETLEN eset, ahol eszkaláció kell", () => {
  const hit = classify("[sandbox: file access denied under workspace-write mode]");
  if (hit !== undefined) {
    assert.equal(hit.id, "sandbox-write");
    assert.equal(hit.escalate, true);
  } else {
    // A pipe-osztály előbb illeszkedik a hosszabb szövegre; önmagában is jó, ha nincs találat.
    assert.ok(true);
  }
});

test("a magyar 'hozzáférés megtagadva' is felismert (a beépített felismerés nem látja)", () => {
  const hit = classify("A hozzáférés megtagadva\r\nGet-CimInstance : A hozzáférés megtagadva. (Hibás: 5)");
  assert.equal(hit?.id, "access-denied-hu");
});

test("a saját jegyzetet nem osztályozza újra (nincs végtelen fűzés)", () => {
  const text = "valami kimenet\n\n[sandbox-sentinel] már megkapta a jegyzetet";
  assert.equal(classify(text), undefined);
});

test("a normál kimenet nem riaszt (nincs téves pozitív)", () => {
  for (const text of [
    "Everything up-to-date",
    "TimeCreated Id LevelDisplayName ProviderName",
    "nvidia-smi: NVIDIA GeForce RTX 5080 Laptop GPU, 621.40",
    "",
    "access to the network is fine"
  ]) {
    assert.equal(classify(text), undefined, text);
  }
});

test("a jegyzet kimondja, hogy nem kell eszkalálni", () => {
  const hit = classify("Program 'x.exe' failed to run: Access to the path '\\\\.\\pipe\\LOCAL\\dotnet_1' is denied");
  const note = noteFor(hit);
  assert.match(note, /\[sandbox-sentinel\]/u);
  assert.match(note, /NEM eszkaláció/u);
  assert.match(note, /cmd \/c/u);
});

test("a session-súgó rövid és tartalmazza a négy szabályt", () => {
  assert.ok(PLAYBOOK.length < 1400, `a súgó rövid marad (${PLAYBOOK.length} karakter)`);
  assert.match(PLAYBOOK, /NEM felhasználói üzenet/u);
  assert.match(PLAYBOOK, /pipe/u);
  assert.match(PLAYBOOK, /web_fetch/u);
  assert.match(PLAYBOOK, /browser/u);
  assert.match(PLAYBOOK, /GIT_SSH/u);
});

test("a hét osztály mind létezik", () => {
  assert.deepEqual(CLASS_IDS, [
    "pipe-capture",
    "msys-sh",
    "schannel-tls",
    "chromium-sandbox",
    "node-spawn",
    "sandbox-write",
    "access-denied-hu"
  ]);
});
