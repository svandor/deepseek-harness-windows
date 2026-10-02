#!/usr/bin/env node
/**
 * check-approvals.mjs — the remembered-approval matcher, exercised directly.
 *
 * Run from anywhere:  node tools/check-approvals.mjs
 *
 * The type derivation and the rule matcher decide, without a human in the loop,
 * whether a privileged action runs. A live prompt cannot prove the negative
 * (`this rule must NOT cover that request`), so the cases below pin the two
 * properties the mechanism stands on:
 *
 *   1. a remembered type answers exactly its own type — a remembered
 *      `danger-full-access` never answers a `workspace-write` request,
 *   2. a tool-scoped rule answers its own tool only, while a rule stored for
 *      every tool answers all of them,
 *   3. an unrecognized reason is remembered narrowly (exact text, one tool).
 *
 * The answerer section installs the real listener into a fake context and calls
 * it with fabricated requests; it reads and restores the real rule store, and
 * (like the live host) leaves a couple of lines in state/ui-extras-client.log —
 * that log is a debugging aid, not a record.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import {
  apply, approvalTypeOf, findApprovalRule, readApprovals, writeApprovals, approvalsPath
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
if (unknown.kind === 'reason' && unknown.scopes.length === 1 && unknown.scopes[0] === 'tool') ok('an unknown reason is only rememberable per tool');
else fail(`unknown reason got wrong scopes: ${JSON.stringify(unknown)}`);

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
  }
} finally {
  if (storeExisted) writeFileSync(approvalsPath(), storeBackup, 'utf8');
  else rmSync(approvalsPath(), { force: true });
}

console.log(failures ? `\n${failures} problem(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
