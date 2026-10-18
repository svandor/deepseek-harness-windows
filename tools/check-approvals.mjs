#!/usr/bin/env node
/**
 * check-approvals.mjs — the remembered-approval matcher, exercised directly.
 *
 * Run from anywhere:  node tools/check-approvals.mjs
 *
 * The type derivation and the rule matcher decide, without a human in the loop,
 * whether a privileged action runs. A live prompt cannot prove the negative
 * (`this rule must NOT cover that request`), so the cases below pin the
 * properties the mechanism stands on:
 *
 *   1. a remembered type answers exactly its own type — a remembered
 *      `danger-full-access` never answers a `workspace-write` request,
 *   2. a tool-scoped rule answers its own tool only, while a rule stored for
 *      every tool answers all of them,
 *   3. an unrecognized reason is remembered narrowly (exact text, one tool),
 *   4. a SESSION grant answers its own session only and is never written to the
 *      durable store (that is the "for this conversation" promise),
 *   5. a PATH-scoped grant answers only a call whose own arguments point inside
 *      that path, never a request without a path and never a sibling prefix
 *      (`C:\Temp\proj` must not cover `C:\Temp\project2`).
 *
 * The answerer section installs the real listener into a fake context and calls
 * it with fabricated requests; the scope section drives the real HTTP route with
 * a fake req/res, so `remember`/`forget` are exercised as the browser drives
 * them. It reads and restores the real rule store, and (like the live host)
 * leaves a couple of lines in state/ui-extras-client.log — that log is a
 * debugging aid, not a record.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  apply, approvalTypeOf, findApprovalRule, readApprovals, writeApprovals, approvalsPath,
  approvalPathKey, approvalPathWithin, approvalPathOf, handleApprovals, APPROVAL_PATH_KEYS
} from '../plugins/dsh-ui-extras/lib/index.js';

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

const rule = (overrides) => ({
  id: 'r-test', key: 'sandbox-escalation|danger-full-access',
  kind: 'sandbox-escalation', target: 'danger-full-access',
  tools: null, labelHu: 'teljes hozzáférés (danger-full-access)',
  labelEn: 'full access (danger-full-access)', note: '', createdAt: '', updatedAt: '', hits: 0,
  ...overrides
});

const fullAccessReason = 'escalate sandbox to danger-full-access: the workspace-external file must be written';
const widerWriteReason = 'escalate sandbox to workspace-write: read a file outside the workspace';

/**
 * A minimal `approval/request` payload whose agent carries one `tool/call` event,
 * which is where the host reads the path from. `arguments` is the raw JSON string
 * the model emitted, exactly as the agent loop logs it.
 */
const requestWithCall = (sessionId, callId, args) => {
  const events = callId === undefined
    ? []
    : [{ type: 'tool/call', data: { callId, name: 'edit', arguments: JSON.stringify(args) } }];
  return {
    toolName: 'edit',
    reason: fullAccessReason,
    ...callId === undefined ? {} : { callId },
    agent: { session: { id: sessionId, seq: events.length, eventAt: (index) => events[index] } }
  };
};

/** Drive the real approvals route with a fake req/res, resolving its JSON answer. */
const callRoute = (method, query, body) => new Promise((resolve, reject) => {
  const req = new EventEmitter();
  req.method = method;
  req.destroy = () => {};
  const res = {
    writeHead: () => {},
    end: (text) => {
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    }
  };
  const url = new URL('http://127.0.0.1:3080/ui-extras/approvals' + (query ? '?' + query : ''));
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  handleApprovals(req, res, url);
});

/* --- 1) type derivation --------------------------------------------------- */
const escalation = approvalTypeOf('pwsh', fullAccessReason);
if (escalation.kind === 'sandbox-escalation' && escalation.target === 'danger-full-access') {
  ok('sandbox escalation derives its target mode');
} else fail(`wrong escalation type: ${JSON.stringify(escalation)}`);
if (escalation.labelHu.includes('teljes hozzáférés')) ok('the full-access type is labelled as such');
else fail(`missing Hungarian label: ${escalation.labelHu}`);
if (escalation.scopes.includes('all') && escalation.scopes.includes('tool')) ok('a sandbox type may be remembered per tool and for every tool');
else fail(`wrong scopes: ${JSON.stringify(escalation.scopes)}`);

const unknown = approvalTypeOf('pwsh', 'a hook wants to run a privileged thing');
if (unknown.kind === 'reason' && unknown.scopes.length > 0 && !unknown.scopes.includes('all')) {
  ok('an unknown reason may never be widened to every tool');
} else fail(`unknown reason got wrong scopes: ${JSON.stringify(unknown)}`);

/* --- 2) matching: same type, scoped by tool ------------------------------- */
if (findApprovalRule([rule()], 'pwsh', fullAccessReason) !== null) ok('a rule for every tool answers pwsh');
else fail('a rule for every tool did not answer pwsh');
if (findApprovalRule([rule()], 'fs', fullAccessReason) !== null) ok('a rule for every tool answers another tool too');
else fail('a rule for every tool did not answer fs');

const perTool = rule({ tools: ['pwsh'] });
if (findApprovalRule([perTool], 'pwsh', fullAccessReason) !== null) ok('a tool-scoped rule answers its own tool');
else fail('a tool-scoped rule did not answer its own tool');
if (findApprovalRule([perTool], 'fs', fullAccessReason) === null) ok('a tool-scoped rule does not answer another tool');
else fail('a tool-scoped rule answered another tool');

/* --- 3) matching: the type is the boundary -------------------------------- */
if (findApprovalRule([rule()], 'pwsh', widerWriteReason) === null) ok('a full-access rule never answers a workspace-write request');
else fail('a full-access rule answered a different escalation target');

const writeRule = rule({ key: 'sandbox-escalation|workspace-write', target: 'workspace-write', tools: null });
if (findApprovalRule([writeRule], 'pwsh', widerWriteReason) !== null) ok('the workspace-write type answers its own request');
else fail('the workspace-write rule did not answer its own request');

/* --- 4) an unknown reason is narrow on both axes -------------------------- */
const reasonRule = rule({
  key: 'reason|a hook wants to run a privileged thing', kind: 'reason',
  target: 'a hook wants to run a privileged thing', tools: ['pwsh']
});
if (findApprovalRule([reasonRule], 'pwsh', 'a hook wants to run a privileged thing') !== null) ok('a remembered reason answers the identical reason');
else fail('a remembered reason did not answer the identical reason');
if (findApprovalRule([reasonRule], 'pwsh', 'a hook wants to run a DIFFERENT thing') === null) ok('a remembered reason does not answer a different reason');
else fail('a remembered reason swallowed a different reason');
if (findApprovalRule([reasonRule], 'fs', 'a hook wants to run a privileged thing') === null) ok('a remembered reason does not answer another tool');
else fail('a remembered reason answered another tool');

/* --- 5) an empty store is valid ------------------------------------------ */
const document = readApprovals();
if (document && Array.isArray(document.rules) && Array.isArray(document.log)) ok('the approval document reads back as a rule + log list');
else fail('readApprovals did not return a usable document');

/* --- 6) the waterfall answerer itself ------------------------------------ */
//
// The plugin half that actually removes the prompt is the `approval/request`
// listener, so it is installed into a minimal fake context and called with
// fabricated requests. The rule store is the real file, so it is saved,
// exercised, and put back exactly as it was.
const storeExisted = existsSync(approvalsPath());
const storeBackup = storeExisted ? readFileSync(approvalsPath(), 'utf8') : null;

try {
  const listeners = [];
  const fakeContext = {
    on: (name, listener, options) => { listeners.push({ name, listener, options }); return () => {}; },
    effect: (body) => { const disposer = body(); return typeof disposer === 'function' ? disposer : () => {}; },
    get: () => undefined
  };
  apply(fakeContext);
  const registered = listeners.find((entry) => entry.name === 'approval/request');
  if (registered === undefined) {
    fail('apply() registered no approval/request answerer');
  } else {
    if (registered.options && registered.options.prepend === true) ok('the answerer is prepended, so the browser is never asked first');
    else fail('the answerer is not prepended — the prompt would appear before it runs');

    const next = () => Promise.resolve('unavailable');
    const answer = (toolName, reason) => registered.listener({ toolName, reason }, next);

    writeApprovals({
      version: 1,
      rules: [{
        id: 'r-check', key: 'sandbox-escalation|danger-full-access',
        kind: 'sandbox-escalation', target: 'danger-full-access', tools: null,
        labelHu: 'teljes hozzáférés (danger-full-access)', labelEn: 'full access (danger-full-access)',
        note: '', createdAt: '', updatedAt: '', hits: 0
      }],
      log: []
    });

    const remembered = await answer('pwsh', fullAccessReason);
    if (remembered === 'allowed-once') ok('a remembered type is answered on the host, without a prompt');
    else fail(`a remembered type was not answered (got ${JSON.stringify(remembered)})`);

    const otherType = await answer('pwsh', widerWriteReason);
    if (otherType === 'unavailable') ok('a different escalation target still asks (the answerer delegated)');
    else fail(`a different escalation target was answered automatically (got ${JSON.stringify(otherType)})`);

    const otherTool = await answer('fs', 'escalate sandbox to danger-full-access: x');
    if (otherTool === 'allowed-once') ok('a rule stored for every tool answers another tool');
    else fail(`a rule for every tool did not answer fs (got ${JSON.stringify(otherTool)})`);

    const afterUse = readApprovals();
    const used = afterUse.rules[0]?.hits ?? 0;
    if (Number(used) >= 2) ok(`an automatic allowance is counted and logged (hits=${used})`);
    else fail(`the rule's use count did not move (hits=${used})`);
    if (afterUse.log.some((entry) => entry.event === 'auto-allowed')) ok('the automatic allowance is audited in the store');
    else fail('the automatic allowance left no audit entry');

    /* --- 7) session scope: this conversation only ------------------------- */
    //
    // From here on the durable store must be EMPTY, otherwise the every-tool rule
    // written above would answer every case below and hide a real failure.
    writeApprovals({ version: 1, rules: [], log: [] });

    const editType = approvalTypeOf('edit', fullAccessReason);
    if (editType.scopes.includes('session') && editType.scopes.includes('path-dir') && editType.scopes.includes('path-file')) {
      ok('the card may offer the session and location scopes');
    } else fail(`the location scopes are missing: ${JSON.stringify(editType.scopes)}`);

    const sessionGrant = await callRoute('POST', '', {
      action: 'remember', toolName: 'edit', reason: fullAccessReason, scope: 'session', session: 'sess-1'
    });
    if (sessionGrant.ok === true && sessionGrant.rule?.sessionScoped === true) ok('a session grant is stored');
    else fail(`the session grant was rejected: ${JSON.stringify(sessionGrant)}`);
    if (!readApprovals().rules.some((entry) => entry.id === sessionGrant.rule.id)) {
      ok('the session grant is NOT written to state/approvals.json');
    } else fail('the session grant leaked into the durable store');

    const listed = await callRoute('GET', '');
    if (listed.ok === true && listed.rules.some((entry) => entry.id === sessionGrant.rule.id)) ok('the permissions panel sees the session grant');
    else fail('the session grant is missing from the rule list');

    const sessionAnswered = await registered.listener(requestWithCall('sess-1'), next);
    if (sessionAnswered === 'allowed-once') ok('a session grant answers its own session, without a prompt');
    else fail(`the session grant did not answer (got ${JSON.stringify(sessionAnswered)})`);

    const otherSessionAnswered = await registered.listener(requestWithCall('sess-2'), next);
    if (otherSessionAnswered === 'unavailable') ok('a session grant does NOT answer another conversation');
    else fail(`the session grant leaked into another session (got ${JSON.stringify(otherSessionAnswered)})`);

    await callRoute('POST', '', { action: 'forget', id: sessionGrant.rule.id });
    const afterForget = await registered.listener(requestWithCall('sess-1'), next);
    if (afterForget === 'unavailable') ok('revoking a session grant puts the prompt back');
    else fail(`the revoked session grant still answered (got ${JSON.stringify(afterForget)})`);

    /* --- 8) location scope: only the named path --------------------------- */
    // The prefix boundary is the whole point: "C:\Temp\proj" must not cover
    // "C:\Temp\project2", and a file grant must not cover a sibling file.
    const dirRule = {
      ...rule(),
      tools: ['edit'],
      pathScope: process.platform === 'win32' ? 'C:\\Temp\\proj' : '/tmp/proj',
      pathKind: 'dir'
    };
    const insidePath = process.platform === 'win32' ? 'C:\\Temp\\proj\\sub\\a.txt' : '/tmp/proj/sub/a.txt';
    const siblingPath = process.platform === 'win32' ? 'C:\\Temp\\project2\\a.txt' : '/tmp/project2/a.txt';
    if (findApprovalRule([dirRule], 'edit', fullAccessReason, insidePath) !== null) ok('a folder grant answers a file inside it');
    else fail('a folder grant did not answer a file inside it');
    if (findApprovalRule([dirRule], 'edit', fullAccessReason, siblingPath) === null) ok('a folder grant does not answer a look-alike sibling prefix');
    else fail('a folder grant answered a path outside it (prefix boundary broken)');
    if (findApprovalRule([dirRule], 'edit', fullAccessReason, null) === null) ok('a location grant never answers a request with no path');
    else fail('a location grant answered a request that named no path');

    const fileRule = { ...dirRule, pathKind: 'file', pathScope: insidePath };
    if (findApprovalRule([fileRule], 'edit', fullAccessReason, insidePath) !== null) ok('a file grant answers exactly its file');
    else fail('a file grant did not answer its own file');
    if (findApprovalRule([fileRule], 'edit', fullAccessReason, process.platform === 'win32' ? 'C:\\Temp\\proj\\sub\\b.txt' : '/tmp/proj/sub/b.txt') === null) {
      ok('a file grant does not answer a sibling file');
    } else fail('a file grant answered another file in the same folder');

    if (process.platform === 'win32') {
      const mixedCase = 'c:\\temp\\PROJ\\Sub\\A.TXT';
      if (findApprovalRule([dirRule], 'edit', fullAccessReason, mixedCase) !== null) ok('the path comparison is case-insensitive on Windows');
      else fail('a differently-cased path inside the folder did not match');
      if (approvalPathKey('C:\\Temp\\proj\\') === approvalPathKey('c:/temp/proj')) ok('a trailing separator and forward slashes normalize to the same key');
      else fail('the path key does not normalize separators');
      if (approvalPathWithin(approvalPathKey('C:\\Temp\\proj'), approvalPathKey('C:\\Temp\\project2'), 'dir') === false) ok('approvalPathWithin keeps the separator boundary');
      else fail('approvalPathWithin matched a sibling prefix');
    }

    const pathGrant = await callRoute('POST', '', {
      action: 'remember', toolName: 'edit', reason: fullAccessReason, scope: 'path-file', path: insidePath
    });
    if (pathGrant.ok === true && pathGrant.rule?.pathKind === 'file' && approvalPathKey(pathGrant.rule.pathScope) === approvalPathKey(insidePath)) {
      ok('a file grant stores the path it was granted for');
    } else fail(`the file grant was not stored: ${JSON.stringify(pathGrant)}`);

    const pathAnswered = await registered.listener(requestWithCall('sess-9', 'call-1', { file_path: insidePath }), next);
    if (pathAnswered === 'allowed-once') ok('a file grant answers a call whose arguments name that file');
    else fail(`the file grant did not answer its own file (got ${JSON.stringify(pathAnswered)})`);

    const otherPathAnswered = await registered.listener(requestWithCall('sess-9', 'call-2', { file_path: siblingPath }), next);
    if (otherPathAnswered === 'unavailable') ok('a file grant does NOT answer a call naming another path');
    else fail(`a file grant answered another path (got ${JSON.stringify(otherPathAnswered)})`);

    const noPathAnswered = await registered.listener(requestWithCall('sess-9', undefined), next);
    if (noPathAnswered === 'unavailable') ok('a file grant does NOT answer a call with no readable path');
    else fail(`a file grant answered a pathless call (got ${JSON.stringify(noPathAnswered)})`);

    if (approvalPathOf(requestWithCall('sess-9', 'call-3', { file_path: insidePath })) === insidePath) ok('the path is derived from the logged tool call');
    else fail('approvalPathOf did not read the tool call arguments');

    const folderGrant = await callRoute('POST', '', {
      action: 'remember', toolName: 'edit', reason: fullAccessReason, scope: 'path-dir', path: insidePath
    });
    // The folder grant stores the folder OF the named file, so another file in
    // that same folder is covered while a file one level up is not.
    const otherFileInFolder = process.platform === 'win32' ? 'C:\\Temp\\proj\\sub\\other.txt' : '/tmp/proj/sub/other.txt';
    if (folderGrant.ok === true
      && (await registered.listener(requestWithCall('sess-9', 'call-4', { file_path: otherFileInFolder }), next)) === 'allowed-once') {
      ok('a folder grant answers another file of the same folder');
    } else fail('a folder grant did not cover another file of the folder');

    const parentFile = process.platform === 'win32' ? 'C:\\Temp\\proj\\up.txt' : '/tmp/proj/up.txt';
    if ((await registered.listener(requestWithCall('sess-9', 'call-5', { file_path: parentFile }), next)) === 'unavailable') {
      ok('a folder grant does not cover the folder above it');
    } else fail('a folder grant reached above its folder');

    // The same request again is a repeat of one decision, not a second rule.
    const folderAgain = await callRoute('POST', '', {
      action: 'remember', toolName: 'edit', reason: fullAccessReason, scope: 'path-dir', path: insidePath
    });
    if (folderAgain.rule.id === folderGrant.rule.id) ok('remembering the same folder twice updates one rule');
    else fail('remembering the same folder twice created a second rule');

    if (readApprovals().rules.some((entry) => entry.id === pathGrant.rule.id) === true) ok('the location grants are durable (they live in the store)');
    else fail('the location grant was not written to the durable store');

    /* --- 9) the client's path-key list must not drift from the host's ------ */
    //
    // The folder/file buttons are offered from the BROWSER's copy of the key list
    // while the host stores/matches with its own. If one side gains a key the
    // other lacks, the card either offers a scope the host can never match or
    // hides one it could — both look like "the button does nothing".
    const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'dsh-ui-extras', 'lib', 'client.js');
    const clientText = readFileSync(clientPath, 'utf8');
    const clientKeys = /var APPROVAL_PATH_ARG_KEYS = \[([^\]]*)\]/u.exec(clientText);
    if (clientKeys === null) {
      fail('the client does not declare APPROVAL_PATH_ARG_KEYS');
    } else {
      const parsed = [...clientKeys[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
      if (JSON.stringify(parsed) === JSON.stringify(APPROVAL_PATH_KEYS)) ok('the client and host path-key lists agree');
      else fail(`the path-key lists drifted: client ${JSON.stringify(parsed)} vs host ${JSON.stringify(APPROVAL_PATH_KEYS)}`);
    }
  }
} finally {
  if (storeExisted) writeFileSync(approvalsPath(), storeBackup, 'utf8');
  else rmSync(approvalsPath(), { force: true });
}

console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
