/**
 * A szabálymotor tesztjei — a MÉRT incidenesetekkel.
 *
 * A tesztek szándékosan a valós, megtörtént parancsokat/kódrészleteket
 * használják (Video: os.unlink-os sync; L12: közvetlen Schedule::call), hogy
 * a védelem ne elméletben, hanem a tényleges hibamintán legyen bizonyítva.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, evaluatePre } from '../lib/policy.js';

const POLICY_FILE = new URL('../policy.json', import.meta.url);
const policy = loadPolicy(POLICY_FILE);

const DSH = 'D:\\Szerver\\Deepseek Harness';
const VIDEO = 'D:\\Szerver\\Video';
const L12 = 'C:\\Herd\\termeszetgyogyaszoktatas-L12';

/** Egy tool-hívás a harness alakjában. */
function call(tool, args, cwd) {
  return { name: tool, arguments: args, agent: { session: { header: { cwd } } } };
}

/** Egy eldöntés rövid, olvasható alakja. */
function decision(tool, args, cwd) {
  const result = evaluatePre(policy, call(tool, args, cwd));
  return result === undefined ? undefined : { rule: result.rule, workspace: result.workspace, reason: result.reason };
}

test('a policy.json érvényes és betölthető', () => {
  assert.notEqual(policy, undefined);
  assert.equal(policy.workspaces.length, 4);
  for (const workspace of policy.workspaces) {
    assert.ok(workspace.id, 'workspace id kötelező');
    assert.ok(Array.isArray(workspace.match) && workspace.match.length > 0, `${workspace.id}: match kötelező`);
    for (const rule of workspace.rules ?? []) assert.ok(policy.rules[rule], `${workspace.id}: ismeretlen szabály: ${rule}`);
  }
  for (const rule of policy.globalRules ?? []) assert.ok(policy.rules[rule], `ismeretlen globális szabály: ${rule}`);
  for (const workspace of policy.workspaces) {
    for (const ruleId of workspace.rules ?? []) {
      const rule = policy.rules[ruleId];
      for (const source of rule.patterns ?? []) assert.doesNotThrow(() => new RegExp(source, 'i'), `${ruleId}: rossz regex: ${source}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 1) Video — 60 napos lomtár (MÉRT eset: `os.unlink` a sync-ágban)
// ---------------------------------------------------------------------------

test('Video: rm -rf a célfán → TILTVA', () => {
  const hit = decision('pwsh', { command: 'ssh svandor@192.168.1.8 "rm -rf /mnt/video-sdb2/Zene/Unknown Artist"' }, VIDEO);
  assert.equal(hit?.rule, 'delete-needs-trash');
  assert.match(hit.reason, /lomtár/i);
});

test('Video: fájlba írt os.unlink → TILTVA (ez volt a mért hiba)', () => {
  const hit = decision(
    'edit',
    { file_path: 'D:\\Szerver\\Video\\ops\\zene-fa-epites.py', new_string: '            if p not in terv:\n                os.unlink(p)\n                torolt += 1' },
    VIDEO
  );
  assert.equal(hit?.rule, 'no-destructive-code');
  assert.match(hit.reason, /os\.unlink|lomtár/i);
});

test('Video: shutil.rmtree a célfára → TILTVA', () => {
  const hit = decision(
    'edit',
    { file_path: 'D:\\Szerver\\Video\\ops\\zene-fa-epites.py', new_string: '            shutil.rmtree(mappa)' },
    VIDEO
  );
  assert.equal(hit?.rule, 'no-destructive-code');
});

test('Video: lomtárba mozgatás → ENGEDVE', () => {
  const hit = decision(
    'pwsh',
    { command: 'mv "/mnt/video-sdb2/Zene/Unknown Artist" ~/.local/state/video-ops/trash/20261120-013609-Unknown-Artist' },
    VIDEO
  );
  assert.equal(hit, undefined);
});

test('Video: shutil.move a TRASH alá → ENGEDVE', () => {
  const hit = decision(
    'edit',
    { file_path: 'D:\\Szerver\\Video\\ops\\zene-fa-epites.py', new_string: '            shutil.move(p, os.path.join(TRASH, stamp, ut))' },
    VIDEO
  );
  assert.equal(hit, undefined);
});

test('Video: temp tisztítás (tmpd) → ENGEDVE', () => {
  const hit = decision(
    'edit',
    { file_path: 'D:\\Szerver\\Video\\ops\\teszt.py', new_string: '        finally:\n            shutil.rmtree(tmpd, ignore_errors=True)' },
    VIDEO
  );
  assert.equal(hit, undefined);
});

test('Video: dokumentációban szereplő rm példa → ENGEDVE (nem kód)', () => {
  const hit = decision(
    'write',
    { file_path: 'D:\\Szerver\\Video\\README.md', content: 'Tilos:\n\n    rm -rf /mnt/video-sdb2/Zene\n' },
    VIDEO
  );
  assert.equal(hit, undefined);
});

test('Video: /tmp takarítás → ENGEDVE', () => {
  const hit = decision('pwsh', { command: 'rm -rf /tmp/zene-teszt' }, VIDEO);
  assert.equal(hit, undefined);
});

test('L12 session + video host: a host alapján is érvényes a lomtár-szabály', () => {
  const hit = decision('pwsh', { command: "ssh svandor@192.168.1.8 'rm -rf /mnt/video-sdb2/Zene/x'" }, L12);
  assert.equal(hit?.rule, 'delete-needs-trash');
});

// ---------------------------------------------------------------------------
// 2) L12 — admin cron lista (MÉRT eset: közvetlen Schedule::call)
// ---------------------------------------------------------------------------

test('L12: új közvetlen cron a routes/console.php-ban → TILTVA', () => {
  const hit = decision(
    'edit',
    {
      file_path: 'C:\\Herd\\termeszetgyogyaszoktatas-L12\\routes\\console.php',
      new_string: "Schedule::call(static fn (): bool => $artisanInProcess('applications:orphan-enrollments --report'))\n    ->name('applications:orphan-enrollments')\n    ->dailyAt('03:20');"
    },
    L12
  );
  assert.equal(hit?.rule, 'l12-schedule-admin');
  assert.match(hit.reason, /app_schedules\.php/);
});

test('L12: a MÁR MEGLÉVŐ közvetlen cron szerkesztése → ENGEDVE', () => {
  const hit = decision(
    'edit',
    {
      file_path: 'C:\\Herd\\termeszetgyogyaszoktatas-L12\\routes\\console.php',
      new_string: "Schedule::call(static fn (): bool => $artisanInProcess('seo:snapshot'))\n    ->name('seo:snapshot')\n    ->dailyAt('04:10');"
    },
    L12
  );
  assert.equal(hit, undefined);
});

test('L12: az admin lista (config/app_schedules.php) szerkesztése → ENGEDVE', () => {
  const hit = decision(
    'edit',
    {
      file_path: 'C:\\Herd\\termeszetgyogyaszoktatas-L12\\config\\app_schedules.php',
      new_string: "        'enrollment-consistency' => [\n            'group' => 'system',\n            'label' => 'Beiratkozás-konzisztencia',\n            'schedule_command' => 'applications:orphan-enrollments --report',\n            'interval_value' => 1,\n            'interval_unit' => 'days',\n            'time' => '03:20',\n        ],"
    },
    L12
  );
  assert.equal(hit, undefined);
});

test('L12: Schedule::call más fájlba → TILTVA', () => {
  const hit = decision(
    'write',
    {
      file_path: 'C:\\Herd\\termeszetgyogyaszoktatas-L12\\routes\\schedule-extra.php',
      content: "<?php\nSchedule::call(fn () => true)->name('x')->daily();\n"
    },
    L12
  );
  assert.equal(hit?.rule, 'l12-schedule-admin');
});

test('L12: helyi (Herd) artisan → ENGEDVE', () => {
  const hit = decision('pwsh', { command: 'php artisan migrate --force' }, L12);
  assert.equal(hit, undefined);
});

test('L12: éles artisan SSH-n → TILTVA', () => {
  const hit = decision('pwsh', { command: "ssh svandor@termeszetgyogyaszoktatas.hu 'php artisan migrate --force'" }, L12);
  assert.equal(hit?.rule, 'l12-no-prod-artisan');
});

// ---------------------------------------------------------------------------
// 3) Globális — név szerinti folyamatölés (AGENTS.md 1.6)
// ---------------------------------------------------------------------------

test('Globális: Stop-Process -Name node → TILTVA', () => {
  const hit = decision('pwsh', { command: 'Stop-Process -Name node -Force' }, DSH);
  assert.equal(hit?.rule, 'no-name-kill');
});

test('Globális: taskkill /IM node.exe → TILTVA', () => {
  const hit = decision('pwsh', { command: 'taskkill /IM node.exe /F' }, DSH);
  assert.equal(hit?.rule, 'no-name-kill');
});

test('Globális: ellenőrzött PID-del leállítás → ENGEDVE', () => {
  const hit = decision('pwsh', { command: 'Stop-Process -Id 12345 -Force' }, DSH);
  assert.equal(hit, undefined);
});

test('Video: Get-ChildItem | Remove-Item (nem tiszta olvasó sor) → TILTVA', () => {
  const hit = decision('pwsh', { command: 'Get-ChildItem C:\\temp | Remove-Item -Force' }, VIDEO);
  assert.equal(hit?.rule, 'delete-needs-trash');
});

// ---------------------------------------------------------------------------
// 4) Hatókör — a Video-szabály nem szivárog más workspace-be
// ---------------------------------------------------------------------------

test('DSH workspace: rm -rf → ENGEDVE (nincs rá szabály)', () => {
  const hit = decision('pwsh', { command: 'rm -rf .\\dist\\stage' }, DSH);
  assert.equal(hit, undefined);
});

test('Ismeretlen workspace: rm -rf → ENGEDVE', () => {
  const hit = decision('pwsh', { command: 'rm -rf C:\\Temp\\x' }, 'C:\\Valami\\Mas');
  assert.equal(hit, undefined);
});

test('Olvasó sor (Select-String) nem blokkol', () => {
  const hit = decision('pwsh', { command: "Select-String -Path log.txt -Pattern 'os.unlink'" }, VIDEO);
  assert.equal(hit, undefined);
});
