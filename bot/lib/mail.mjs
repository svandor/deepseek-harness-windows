/**
 * Házirobot — e-mail küldés külső függőség nélkül (nyers SMTP).
 *
 * Támogat: implicit TLS (465), STARTTLS (587), AUTH LOGIN és AUTH PLAIN.
 * `dryRun` módban nem csatlakozik, hanem `.eml` fájlt ír az outbox mappába —
 * így minden kimenet tesztelhető valódi fiók nélkül.
 */
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

function b64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** Egy SMTP-beszélgetés vezérlése: soronkénti válaszolvasás, kódellenőrzéssel. */
class SmtpSession {
  constructor(socket, onLog) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.onLog = onLog ?? (() => {});
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this.#flush();
    });
    socket.on('error', (err) => {
      const w = this.waiters.shift();
      if (w) w.reject(err);
    });
  }

  #flush() {
    // Az SMTP válasz több soros lehet: addig várunk, míg egy "NNN " (szóköz) sor meg nem érkezik.
    const lines = this.buffer.split(CRLF);
    let consumed = 0;
    let last = null;
    for (const line of lines) {
      if (!/^\d{3}[ ]/.test(line)) {
        if (/^\d{3}-/.test(line)) consumed += line.length + CRLF.length;
        continue;
      }
      last = line;
      consumed += line.length + CRLF.length;
      break;
    }
    if (!last) return;
    this.buffer = this.buffer.slice(consumed);
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(last);
  }

  expect() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.#flush();
    });
  }

  async command(line) {
    this.onLog(`C: ${line.startsWith('AUTH') ? 'AUTH ***' : line}`);
    this.socket.write(line + CRLF);
    const reply = await this.expect();
    this.onLog(`S: ${reply}`);
    return reply;
  }

  async expectCode(code, context) {
    const reply = await this.expect();
    this.onLog(`S: ${reply}`);
    if (!reply.startsWith(String(code))) {
      throw new Error(`${context}: vart ${code}, kapott: ${reply}`);
    }
    return reply;
  }
}

function wrap(body, { from, to, subject, headers = {} }) {
  const date = new Date().toUTCString();
  const messageId = `<${randomUUID()}@hazirobot>`;
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
  ];
  const encoded = Buffer.from(body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, `$1${CRLF}`);
  return lines.join(CRLF) + CRLF + encoded + CRLF;
}

function writeOutbox(outboxDir, raw, meta) {
  mkdirSync(outboxDir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${meta.kind ?? 'mail'}.eml`;
  const path = join(outboxDir, name);
  writeFileSync(path, raw, 'utf8');
  return path;
}

/**
 * Levél küldése.
 * @param {object} cfg  { host, port, secure, user, password }
 * @param {object} msg  { from, to: string[], subject, text, kind }
 * @param {object} opts { dryRun, outboxDir, log }
 */
export async function sendMail(cfg, msg, opts = {}) {
  const to = Array.isArray(msg.to) ? msg.to : [msg.to];
  const raw = wrap(msg.text, { from: msg.from, to, subject: msg.subject });
  const log = opts.log ?? (() => {});

  if (opts.dryRun || !cfg?.host) {
    const path = writeOutbox(opts.outboxDir ?? 'state/outbox', raw, msg);
    log(`e-mail NEM elkuldve (dry-run) -> ${path}`);
    return { sent: false, dryRun: true, path };
  }

  const port = Number(cfg.port ?? (cfg.secure ? 465 : 587));
  const socket = cfg.secure
    ? tlsConnect({ host: cfg.host, port, servername: cfg.host })
    : netConnect({ host: cfg.host, port });
  socket.setTimeout(30000);

  await new Promise((resolve, reject) => {
    socket.once(cfg.secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });

  let session = new SmtpSession(socket, log);
  await session.expectCode(220, 'udvozles');

  let reply = await session.command(`EHLO hazirobot`);
  if (!cfg.secure && /STARTTLS/i.test(reply)) {
    await session.command('STARTTLS');
    const secured = tlsConnect({ socket, servername: cfg.host });
    await new Promise((resolve, reject) => {
      secured.once('secureConnect', resolve);
      secured.once('error', reject);
    });
    session = new SmtpSession(secured, log);
    await session.command('EHLO hazirobot');
  }

  if (cfg.user && cfg.password) {
    const mech = 'AUTH LOGIN';
    await session.command(mech);
    await session.command(b64(cfg.user));
    const authReply = await session.command(b64(cfg.password));
    if (!authReply.startsWith('235')) throw new Error(`SMTP hitelesites sikertelen: ${authReply}`);
  }

  await session.command(`MAIL FROM:<${msg.from}>`);
  for (const rcpt of to) await session.command(`RCPT TO:<${rcpt}>`);
  await session.command('DATA');
  session.socket.write(raw.replace(/\n\./g, '\n..') + '.' + CRLF);
  await session.expectCode(250, 'uzenet elfogadas');
  await session.command('QUIT');
  socket.end();

  log(`e-mail elkuldve: ${to.join(', ')} — ${msg.subject}`);
  return { sent: true, dryRun: false };
}

export { writeOutbox, wrap as _wrapForTests };
