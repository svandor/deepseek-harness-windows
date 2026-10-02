/**
 * A DSH host plugin beállítás-logikájának tesztje (hálózat nélkül).
 *
 * Egy ideiglenes bot-mappán dolgozik, ezért a valódi beállításokat nem érinti.
 * Futtatás:  node --test --test-isolation=none bot/tests/plugin-settings.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hazi-robot-test-'));
mkdirSync(join(dir, 'jobs'), { recursive: true });
writeFileSync(join(dir, 'config.json'), JSON.stringify({ email: { dryRun: true, to: [], smtp: {} }, far: {} }, null, 2));
writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ smtpPassword: 'IDE-KERUL-A-JELSZO', panelToken: 'IDE-KERUL-A-PANEL-TOKEN' }, null, 2));
writeFileSync(join(dir, 'jobs', 'konkurencia-figyelo.json'), JSON.stringify({ id: 'konkurencia-figyelo', leiras: 'teszt', oldalak: [], schedule: { tipus: 'cron', kifejezes: '0 7 * * 1' } }, null, 2));

process.env.HAZIROBOT_DIR = dir;
const mod = await import('file:///C:/Szerver/Deepseek%20Harness/plugins/dsh-hazi-robot/lib/index.js');

test('a minta-helykitöltő titkot nem tekinti beállítottnak', () => {
  const s = mod.currentSettings();
  assert.equal(s.secretsSet.smtpPassword, false);
  assert.equal(s.secretsSet.panelToken, false);
  assert.equal(s.settings.email.dryRun, true);
});

test('a beállítások mentése a config.json-ba és a secrets.json-ba ír', () => {
  const result = mod.applySettings({
    email: { from: 'robot@pelda.hu', to: 'a@pelda.hu, b@pelda.hu', dryRun: false, smtp: { host: 'smtp.pelda.hu', port: 465, secure: 'true', user: 'robot' } },
    far: { callbackUrl: 'https://pelda.hu/api/far', ertesitesTo: 'sandor@pelda.hu' },
    oldalak: [{ nev: 'Konkurens', url: 'https://konkurens.hu/arak' }, { nev: '', url: '' }],
    jobSchedule: '30 6 * * 2',
    secrets: { smtpPassword: 'titkos-jelszo', panelToken: 'panel-titok', farCallbackSecret: '' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.savedSecrets.sort(), ['SMTP jelszó', 'panel-token'].sort());

  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.email.from, 'robot@pelda.hu');
  assert.deepEqual(cfg.email.to, ['a@pelda.hu', 'b@pelda.hu']);
  assert.equal(cfg.email.dryRun, false);
  assert.equal(cfg.email.smtp.port, 465);
  assert.equal(cfg.email.smtp.secure, 'true');
  assert.equal(cfg.far.callbackUrl, 'https://pelda.hu/api/far');
  assert.deepEqual(cfg.far.ertesitesTo, ['sandor@pelda.hu']);

  const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
  assert.equal(secrets.smtpPassword, 'titkos-jelszo');
  assert.equal(secrets.panelToken, 'panel-titok');
  // Az üresen hagyott titok nem íródik felül.
  assert.equal(secrets.farCallbackSecret, undefined);

  const job = JSON.parse(readFileSync(join(dir, 'jobs', 'konkurencia-figyelo.json'), 'utf8'));
  assert.equal(job.oldalak.length, 1);
  assert.equal(job.oldalak[0].url, 'https://konkurens.hu/arak');
  assert.equal(job.schedule.kifejezes, '30 6 * * 2');
});

test('mentés után a titkok beállítottnak látszanak, de az értékük nem megy vissza', () => {
  const s = mod.currentSettings();
  assert.equal(s.secretsSet.smtpPassword, true);
  assert.equal(s.secretsSet.panelToken, true);
  assert.equal(s.secretsSet.farCallbackSecret, false);
  assert.equal(JSON.stringify(s).includes('titkos-jelszo'), false, 'a jelszó nem szivároghat ki a válaszban');
});

test('a mentés biztonsági másolatot készít', () => {
  const files = readFileSync(join(dir, 'config.json'), 'utf8');
  const backups = readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
  assert.ok(backups.length >= 1, 'kell legalább egy .bak fájl');
  assert.ok(files.includes('robot@pelda.hu'));
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
