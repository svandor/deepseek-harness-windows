/**
 * Házirobot — konfiguráció és titkok.
 *
 * A `bot/config.json` a nem titkos beállítás. A titkok három helyről jöhetnek,
 * ebben a sorrendben:
 *   1. környezeti változó (pl. BOT_SMTP_PASSWORD, BOT_FAR_CALLBACK_SECRET)
 *   2. `bot/secrets.json` (a .gitignore-ban; jogosultság: csak a felhasználónak)
 *   3. egyik sem -> a funkció dry-run módban fut, nem hibázik el
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOT_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
export const REPO_ROOT = resolve(join(BOT_ROOT, '..'));

function readJson(path, fallback) {
  try {
    // UTF-8 BOM levágása (PowerShell/Notepad gyakran ír ilyet).
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

export function loadConfig() {
  const cfg = readJson(join(BOT_ROOT, 'config.json'), {});
  const secrets = readJson(join(BOT_ROOT, 'secrets.json'), {});
  const env = process.env;

  // A minta-fájl helykitöltőit ("IDE-KERUL-...") NEM tekintjük beállított
  // titoknak: különben egy ismert sztring lenne az élő token/jelszó.
  const isPlaceholder = (value) => !value || /^IDE-KERUL/i.test(String(value).trim());
  const pick = (envKey, secretKey, fallback = '') => {
    const candidates = [env[envKey], secrets[secretKey], fallback];
    for (const candidate of candidates) {
      if (!isPlaceholder(candidate)) return candidate;
    }
    return '';
  };

  const paths = {
    state: absolutize(cfg.paths?.state ?? 'state/bot.db'),
    reports: absolutize(cfg.paths?.reports ?? 'reports'),
    outbox: absolutize(cfg.paths?.outbox ?? 'state/outbox'),
    runs: absolutize(cfg.paths?.runs ?? 'state/runs'),
    jobs: absolutize(cfg.paths?.jobs ?? 'jobs'),
  };
  for (const dir of [paths.reports, paths.outbox, paths.runs]) mkdirSync(dir, { recursive: true });
  mkdirSync(dirname(paths.state), { recursive: true });

  return {
    raw: cfg,
    botName: cfg.botName ?? 'Házirobot',
    avatar: absolutize(cfg.avatar ?? 'avatar/hazirobot.svg'),
    paths,
    proxy: {
      baseUrl: env.BOT_PROXY_URL ?? cfg.proxy?.baseUrl ?? 'http://127.0.0.1:4123/v1',
      route: cfg.proxy?.route ?? 'fast-chat',
      timeoutMs: Number(cfg.proxy?.timeoutMs ?? 120000),
    },
    panel: {
      host: env.BOT_PANEL_HOST ?? cfg.panel?.host ?? '127.0.0.1',
      port: Number(env.BOT_PANEL_PORT ?? cfg.panel?.port ?? 4180),
      token: pick('BOT_WEBHOOK_TOKEN', 'panelToken', cfg.panel?.token ?? ''),
    },
    llm: {
      enabled: cfg.llm?.enabled !== false && env.BOT_LLM_DISABLED !== '1',
      maxCostUsdPerRun: Number(cfg.limits?.defaultBudgetUsd ?? 0.05),
    },
    email: {
      enabled: cfg.email?.enabled !== false,
      dryRun: cfg.email?.dryRun !== false && env.BOT_EMAIL_SEND !== '1',
      from: pick('BOT_EMAIL_FROM', 'emailFrom', cfg.email?.from ?? ''),
      to: (cfg.email?.to ?? []).slice(),
      smtp: {
        host: pick('BOT_SMTP_HOST', 'smtpHost', cfg.email?.smtp?.host ?? ''),
        port: Number(pick('BOT_SMTP_PORT', 'smtpPort', cfg.email?.smtp?.port ?? 587)),
        secure: String(pick('BOT_SMTP_SECURE', 'smtpSecure', cfg.email?.smtp?.secure ?? 'false')) === 'true',
        user: pick('BOT_SMTP_USER', 'smtpUser', cfg.email?.smtp?.user ?? ''),
        password: pick('BOT_SMTP_PASSWORD', 'smtpPassword', ''),
      },
    },
    far: {
      callbackUrl: cfg.far?.callbackUrl ?? 'https://example.org/api/far/resztvevo',
      callbackSecret: pick('BOT_FAR_CALLBACK_SECRET', 'farCallbackSecret', ''),
      selyemTo: cfg.far?.ertesitesTo ?? cfg.email?.to ?? [],
      cdpUrl: env.BOT_FAR_CDP_URL ?? cfg.far?.cdpUrl ?? 'http://127.0.0.1:9333',
      profileDir: cfg.far?.profileDir ?? '',
      executorMode: cfg.far?.executorMode ?? 'local', // local | ssh
      sshHost: cfg.far?.sshHost ?? 'user@example-host',
      sshRunDir: cfg.far?.sshRunDir ?? '/home/user/far-survey',
      dryRun: cfg.far?.dryRun !== false || env.BOT_FAR_LIVE !== '1',
    },
    secretsPath: join(BOT_ROOT, 'secrets.json'),
    hasSecretsFile: existsSync(join(BOT_ROOT, 'secrets.json')),
  };
}

function absolutize(p) {
  return isAbsolute(p) ? p : join(BOT_ROOT, p);
}
