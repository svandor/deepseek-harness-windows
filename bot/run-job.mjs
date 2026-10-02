#!/usr/bin/env node
/**
 * Házirobot — a job-futtató.
 *
 * Használat:
 *   node bot/run-job.mjs list                 # elérhető jobok
 *   node bot/run-job.mjs check                # a job-definíciók ellenőrzése
 *   node bot/run-job.mjs due                  # a most esedékes jobok futtatása
 *   node bot/run-job.mjs <job-id>             # egy job kényszerített futtatása
 *
 * Kapcsolók: --dry-run (nincs LLM, nincs e-mail-küldés), --no-email, --force
 *
 * A futás menete: determinisztikus előlépés -> (csak változás esetén) EGY
 * modellhívás az ingyenes láncon -> validálás -> riport -> e-mail -> napló.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { logger } from './lib/log.mjs';
import { openState, startRun, finishRun, kvGet, kvSet, runsForDay } from './lib/state.mjs';
import { listJobs, loadJob, validateJobs, dueJobs } from './lib/jobs.mjs';
import { askLLM } from './lib/llm.mjs';
import { writeReport, emailBody } from './lib/report.mjs';
import { sendMail } from './lib/mail.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const noEmail = flags.has('--no-email');

const cfg = loadConfig();
openState(cfg.paths.state);

function usage() {
  console.log(`Házirobot job-futtató

  node bot/run-job.mjs list
  node bot/run-job.mjs check
  node bot/run-job.mjs due [--dry-run]
  node bot/run-job.mjs <job-id> [--dry-run] [--no-email] [--force]
`);
}

/** Egy job végrehajtása. Visszaadja a futás összegzését. */
async function runJob(job, opts = {}) {
  const log = logger(`job:${job.id}`);
  const runId = startRun(job.id);
  log.info(`futás indul${opts.dryRun ? ' (dry-run)' : ''}`);

  let tokensIn = 0;
  let tokensOut = 0;
  let llmUsed = false;
  let reportPath = null;

  try {
    // 1. Determinisztikus előlépés — ez dönti el, kell-e egyáltalán modell.
    let collected = { changed: true };
    if (job.eloSzkript) {
      const modulePath = join(cfg.paths.jobs, '..', job.eloSzkript);
      if (!existsSync(modulePath)) throw new Error(`az elo-szkript nem letezik: ${job.eloSzkript}`);
      const mod = await import(`file://${modulePath.replace(/\\/g, '/')}`);
      collected = await mod.collect({
        job,
        cfg,
        log: (message, extra) => log.info(message, extra),
        kvGet: (k) => kvGet(job.id, k),
        kvSet: (k, v) => kvSet(job.id, k, v),
        dryRun: opts.dryRun,
      });
      if (collected?.changed === false) {
        const summary = collected.summary ?? 'Nincs változás.';
        reportPath = writeReport({
          reportsDir: cfg.paths.reports,
          job,
          status: 'nincs-valtozas',
          summary,
          body: collected.body,
          log,
        });
        finishRun(runId, { status: 'nincs-valtozas', detail: summary, reportPath });
        log.ok(`nincs változás — modellhívás nélkül lezárva`);
        return { status: 'nincs-valtozas', summary, reportPath, llmUsed: false, emailSent: false };
      }
    }

    // 2. Egyetlen modellhívás az ingyenes láncon (ha van prompt).
    let summary = collected?.summary ?? '';
    let body = collected?.body ?? '';
    if (job.prompt) {
      const promptPath = join(cfg.paths.jobs, '..', job.prompt);
      const prompt = existsSync(promptPath) ? (await import('node:fs')).readFileSync(promptPath, 'utf8') : job.prompt;
      const payload = typeof collected?.data === 'string' ? collected.data : JSON.stringify(collected?.data ?? {}, null, 2);
      const res = await askLLM(cfg, {
        route: job.modell?.route,
        maxTokens: job.modell?.maxTokens ?? 2048,
        dryRun: opts.dryRun,
        log: (m) => log.info(m),
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: payload.slice(0, 60000) },
        ],
      });
      if (res.ok) {
        llmUsed = true;
        tokensIn = res.tokensIn;
        tokensOut = res.tokensOut;
        summary = res.text.trim();
      } else if (!res.skipped) {
        log.warn(`a modellhivas nem sikerult (${res.error ?? 'ismeretlen'}) — determinisztikus riport megy`);
      }
    }

    // 3. Validálás (opcionális modul).
    let validation = { ok: true };
    if (job.validacio) {
      const modulePath = join(cfg.paths.jobs, '..', job.validacio);
      const mod = await import(`file://${modulePath.replace(/\\/g, '/')}`);
      validation = await mod.validate({ job, collected, summary, cfg });
      if (!validation.ok) log.error(`validacio hibas: ${validation.error}`);
    }

    const status = validation.ok ? 'ok' : 'validacio-hiba';
    reportPath = writeReport({
      reportsDir: cfg.paths.reports,
      job,
      status,
      summary,
      body,
      data: job.riportNyersAdat === false ? undefined : collected?.data,
      log,
    });

    // 4. E-mail (a bot fő kimenete).
    let emailSent = false;
    if (!noEmail && cfg.email.enabled && job.kimenet?.includes('email') !== false) {
      const { subject, text } = emailBody({ job, status, summary, reportPath });
      const res = await sendMail(
        { ...cfg.email.smtp },
        { from: cfg.email.from, to: cfg.email.to, subject, text, kind: job.id },
        { dryRun: opts.dryRun || cfg.email.dryRun, outboxDir: cfg.paths.outbox, log: (m) => log.info(m) },
      );
      emailSent = res.sent;
    }

    finishRun(runId, { status, detail: summary.slice(0, 500), reportPath, tokensIn, tokensOut, costUsd: 0, llmUsed });
    log.ok(`futás kész: ${status}`);
    return { status, summary, reportPath, llmUsed, tokensIn, tokensOut, emailSent };
  } catch (err) {
    log.error(`futás hiba: ${err.message}`);
    finishRun(runId, { status: 'hiba', detail: err.message, reportPath });
    return { status: 'hiba', summary: err.message, reportPath, llmUsed };
  }
}

async function main() {
  const cmd = positional[0] ?? 'list';

  if (cmd === 'list') {
    const jobs = listJobs(cfg.paths.jobs);
    if (!jobs.length) {
      console.log('Nincs job a bot/jobs mappában.');
      return 0;
    }
    for (const j of jobs) {
      const expr = j.schedule?.kifejezes ?? j.schedule?.tipus ?? '-';
      console.log(`${j.id.padEnd(26)} ${String(expr).padEnd(16)} ${j.leiras ?? ''}`);
    }
    return 0;
  }

  if (cmd === 'check') {
    const { problems } = validateJobs(cfg.paths.jobs);
    if (!problems.length) {
      console.log('Minden job-definíció rendben.');
      return 0;
    }
    for (const p of problems) console.log(`HIBA: ${p}`);
    return 1;
  }

  if (cmd === 'due') {
    const today = new Date().toISOString().slice(0, 10);
    const todaysRuns = runsForDay(today).filter((r) => r.status !== 'hiba');
    const ranThisMinute = new Set(
      todaysRuns
        .filter((r) => r.started_at.slice(0, 16) === new Date().toISOString().slice(0, 16))
        .map((r) => r.job_id),
    );
    const jobs = listJobs(cfg.paths.jobs);
    const due = dueJobs(jobs, new Date(), ranThisMinute);
    if (!due.length) {
      console.log('Most nincs esedékes job.');
      return 0;
    }
    for (const job of due) {
      console.log(`--- esedékes: ${job.id} ---`);
      await runJob(job, { dryRun });
    }
    return 0;
  }

  const job = loadJob(cfg.paths.jobs, cmd);
  const result = await runJob(job, { dryRun, noEmail });
  return result.status === 'hiba' ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`végzetes hiba: ${err.stack ?? err.message}`);
    process.exit(1);
  });

export { runJob };
