/**
 * dsh-rule-guard — szabálymotor (tiszta, tesztelhető).
 *
 * MIÉRT: az ágensek ismételten megsértették a projekt-szabályokat (mért esetek:
 * Video – 60 napos lomtár helyett `os.unlink`-kal 7 291 borítókép végleges
 * törlése; L12 – cron a `routes/console.php`-ba, az admin Szinkron lista
 * kihagyásával). Az AGENTS.md szövege önmagában nem kényszerít: a modell
 * elfelejtheti, átírhatja, vagy egyszerűen nem olvassa el. Ez a motor a
 * tool-hívás ELŐTT dönt, és indoklással blokkol.
 *
 * FELELŐSSÉG: a döntés itt tisztán, FS/hálózat nélkül születik. A plugin
 * (`lib/index.js`) csak összeköti a harness eseményeivel.
 *
 * A szabályok a `policy.json`-ban élnek; ez a fájl csak a végrehajtást adja.
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

/** Kód-kiterjesztések: a „destruktív kód" szabály csak ezekre fut (dokumentációra nem). */
const CODE_EXTENSIONS = new Set([
  '.php', '.py', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.js', '.mjs', '.cjs',
  '.ts', '.rb', '.pl', '.bat', '.cmd', '.go', '.rs', '.java', '.kt', '.lua'
]);

/** Csak olvasó sorok: ezeket nem vizsgáljuk (grep/Select-String önmagában nem töröl). */
const READ_ONLY_LINE = /^\s*(grep|rg|Select-String|findstr|Get-Content|Get-ChildItem|Get-Item|Test-Path|Where-Object|Select-Object|Out-String|cat|head|tail|less|more|type|dir|ls|git\s+(grep|log|diff|status|show|branch))\b/i;

/** Komment-sorok: a kódban leírt szabály／példa nem hajt végre semmit. */
const COMMENT_LINE = /^\s*(#|\/\/|\/\*|\*|<!--|--|;|%|REM\b)/i;

/** Normalizált összehasonlítás: kisbetű, egységes elválasztó, perjel a végén. */
export function normPath(value) {
  return String(value ?? '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** Egy érték a tool argumentumaiból (az első nem üres string). */
function firstString(args, names) {
  for (const name of names) {
    const value = args?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

/** A hívás munkakönyvtára: a session fejléce, felülírva a kért workdir-rel. */
export function callCwd(exec) {
  const headerCwd = exec?.agent?.session?.header?.cwd;
  const requested = firstString(exec?.arguments, ['workdir', 'cwd']);
  if (typeof headerCwd !== 'string' || headerCwd === '') return requested || '';
  if (requested === '') return headerCwd;
  return isAbsolute(requested) ? requested : resolve(headerCwd, requested);
}

/** A fájl abszolút útja a hívás munkakönyvtárához képest. */
function filePathOf(exec) {
  const file = firstString(exec?.arguments, ['file_path', 'path', 'file']);
  if (file === '') return '';
  if (isAbsolute(file)) return file;
  const cwd = callCwd(exec);
  return cwd === '' ? file : resolve(cwd, file);
}

/** A munkakönyvtárhoz tartozó workspace (leghosszabb egyező prefix). */
export function workspaceForCwd(policy, cwd) {
  const normalized = normPath(cwd);
  if (normalized === '') return undefined;
  let best;
  for (const workspace of policy.workspaces ?? []) {
    for (const base of workspace.match ?? []) {
      const baseNorm = normPath(base);
      if (baseNorm === '') continue;
      if (normalized === baseNorm || normalized.startsWith(baseNorm + '\\')) {
        if (best === undefined || baseNorm.length > best.base.length) best = { workspace, base };
      }
    }
  }
  return best;
}

/** Azok a workspace-ek, amelyek gazdagép-neve szerepel a szövegben (ssh, curl, stb.). */
export function hostWorkspaces(policy, text) {
  const haystack = String(text ?? '').toLowerCase();
  if (haystack === '') return [];
  const found = [];
  for (const workspace of policy.workspaces ?? []) {
    const hosts = workspace.hosts ?? [];
    if (hosts.length === 0) continue;
    if (hosts.some((host) => haystack.includes(String(host).toLowerCase()))) found.push(workspace);
  }
  return found;
}

/** A szabály regexei (a string mintákat egyszer fordítjuk, lustán). */
export function compileRule(rule) {
  if (rule.__compiled !== undefined) return rule.__compiled;
  const compiled = {
    patterns: (rule.patterns ?? []).map((source) => new RegExp(source, 'i')),
    allowPatterns: (rule.allowPatterns ?? []).map((source) => new RegExp(source, 'i'))
  };
  Object.defineProperty(rule, '__compiled', { value: compiled, enumerable: false, configurable: true });
  return compiled;
}

/** Egy sor eldöntése: tiltott-e, és ha igen, miért. */
export function judgeLine(rule, line) {
  const { patterns, allowPatterns } = compileRule(rule);
  if (allowPatterns.some((pattern) => pattern.test(line))) return undefined;
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match === null) continue;
    // Ha a minta egy KERESŐ eszköz argumentumában szerepel (pl. `grep -nE "rm -rf"`),
    // akkor nem végrehajtás, hanem keresés: hagyjuk.
    if (rule.skipAfterSearch === true) {
      const before = line.slice(0, match.index);
      if (/(\b(grep|rg|ag|findstr|Select-String|git\s+grep)\b)/i.test(before)) continue;
    }
    return { line, pattern: pattern.source };
  }
  return undefined;
}

/** A vizsgálandó szövegmezők a szabály `fields` listája szerint. */
function fieldTexts(rule, exec) {
  const args = exec?.arguments ?? {};
  const out = [];
  for (const field of rule.fields ?? ['command']) {
    const value = args[field];
    if (typeof value === 'string' && value.length > 0) out.push({ field, value });
  }
  return out;
}

/** A tool neve engedélyezett-e a szabályhoz. */
function toolAllowed(rule, tool) {
  const tools = rule.tools;
  if (!Array.isArray(tools) || tools.length === 0) return true;
  return tools.includes(tool);
}

/**
 * `deny-lines` szabály: soronként dönt.
 * @returns {{line: string, field: string, pattern: string} | undefined}
 */
export function scanDenyLines(rule, exec) {
  const file = filePathOf(exec);
  if (rule.codeOnly === true) {
    if (file === '') return undefined;
    if (!CODE_EXTENSIONS.has(extname(file).toLowerCase())) return undefined;
  }
  // Az ágens saját piszkozat-mappája (`.tmp`, `.dsh-task-temp`, %TEMP%) nem
  // projekt-adat: ott a takarítás nem esik a lomtár-szabály alá.
  if (rule.skipScratchPaths === true && file !== '' && /([\\/])\.tmp([\\/]|$)|([\\/])\.dsh-task-temp([\\/]|$)|%TEMP%|\\Temp\\dsh-/i.test(file)) {
    return undefined;
  }
  for (const { field, value } of fieldTexts(rule, exec)) {
    for (const rawLine of value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      // Csak a TISZTÁN olvasó sorokat hagyjuk ki: ha cső/elválasztó van a sorban,
      // az már futtathat is valamit (pl. `Get-ChildItem … | Remove-Item`).
      if (rule.skipReadOnlyLines === true && READ_ONLY_LINE.test(line) && !/[|;&]/.test(line)) continue;
      if (rule.skipCommentLines === true && COMMENT_LINE.test(line)) continue;
      const hit = judgeLine(rule, line);
      if (hit !== undefined) return { ...hit, field };
    }
  }
  return undefined;
}

/** A denied döntés szövege: mit sértett, melyik sor, hogyan javítsd. */
function denyReason(ruleId, rule, workspace, hit) {
  const label = workspace?.label ?? 'projekt';
  const snippet = hit.line.length > 240 ? hit.line.slice(0, 240) + '…' : hit.line;
  const parts = [
    `[rule-guard:${ruleId}] ${label} — ${rule.reason ?? 'projekt-szabály megsértése'}`,
    `Érintett sor: ${snippet}`
  ];
  if (rule.hint) parts.push(rule.hint);
  return parts.join('\n\n');
}

/** Az `schedule-admin` szabály: új közvetlen cron csak az admin listán (config) át. */
function scheduleAdminHit(rule, workspace, exec) {
  const config = workspace.schedule;
  if (config === undefined) return undefined;
  if (!toolAllowed(rule, exec.name)) return undefined;
  const file = filePathOf(exec);
  if (file === '') return undefined;
  const base = normPath(workspace.__base);
  const relative = normPath(file).startsWith(base + '\\') ? normPath(file).slice(base.length + 1) : '';
  if (relative === '') return undefined;
  const adminFile = normPath(config.adminFile ?? '');
  const scheduleFile = normPath(config.scheduleFile ?? '');
  if (relative === adminFile) return undefined; // ez maga az admin lista
  const content = firstString(exec?.arguments, ['content', 'new_string', 'new_str', 'file_text']);
  if (content === '') return undefined;
  if (relative === scheduleFile) {
    const allowed = config.allowedDirectSchedules ?? [];
    const names = [...content.matchAll(/->name\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const unknown = [...new Set(names)].filter((name) => !allowed.includes(name));
    if (unknown.length === 0) return undefined;
    return {
      line: unknown.map((name) => `->name('${name}')`).join(', '),
      field: 'new_schedule',
      pattern: 'unknown direct Schedule name'
    };
  }
  if (!CODE_EXTENSIONS.has(extname(relative).toLowerCase())) return undefined;
  if (/\bSchedule::(call|command)\s*\(/.test(content)) {
    return { line: relative, field: 'content', pattern: 'Schedule outside the admin list' };
  }
  return undefined;
}

/**
 * A tool-hívás előtti döntés.
 *
 * @param {object} policy - a betöltött és előkészített szabálykészlet
 * @param {object} exec - `{ name, arguments, agent }` a harness-től
 * @returns {{kind: 'deny', reason: string, rule: string, workspace: string} | undefined}
 */
export function evaluatePre(policy, exec) {
  const tool = String(exec?.name ?? '');
  if (tool === '') return undefined;
  const args = exec?.arguments ?? {};

  const contexts = new Map();
  const cwdMatch = workspaceForCwd(policy, callCwd(exec));
  if (cwdMatch !== undefined) {
    const workspace = { ...cwdMatch.workspace, __base: cwdMatch.base };
    contexts.set(workspace.id, { workspace, via: 'cwd' });
  }
  const hostText = firstString(args, ['command', 'script', 'input', 'content', 'new_string', 'new_str', 'file_text']);
  for (const workspace of hostWorkspaces(policy, hostText)) {
    if (!contexts.has(workspace.id)) contexts.set(workspace.id, { workspace, via: 'host' });
  }

  const ruleIds = new Set(policy.globalRules ?? []);
  for (const { workspace } of contexts.values()) {
    for (const id of workspace.rules ?? []) ruleIds.add(id);
  }
  if (ruleIds.size === 0) return undefined;

  for (const ruleId of ruleIds) {
    const rule = policy.rules?.[ruleId];
    if (rule === undefined) continue;
    if (!toolAllowed(rule, tool)) continue;

    if (rule.type === 'deny-lines') {
      const hit = scanDenyLines(rule, exec);
      if (hit === undefined) continue;
      const owner = [...contexts.values()].find((entry) => (entry.workspace.rules ?? []).includes(ruleId));
      const workspace = owner?.workspace ?? [...contexts.values()][0]?.workspace ?? { id: 'global', label: 'globális szabály' };
      return {
        kind: 'deny',
        reason: denyReason(ruleId, rule, workspace, hit),
        rule: ruleId,
        workspace: workspace.id
      };
    }

    if (rule.type === 'schedule-admin') {
      const owner = contexts.get(workspaceForCwd(policy, callCwd(exec))?.workspace.id);
      if (owner === undefined || owner.via !== 'cwd') continue;
      const hit = scheduleAdminHit(rule, owner.workspace, exec);
      if (hit === undefined) continue;
      return {
        kind: 'deny',
        reason: denyReason(ruleId, rule, owner.workspace, hit),
        rule: ruleId,
        workspace: owner.workspace.id
      };
    }
  }
  return undefined;
}

/**
 * A `policy.json` betöltése és előkészítése. Hiba esetén `undefined` — a plugin
 * ilyenkor NEM blokkol (a guard hibája ne törje a munkát), csak naplóz.
 */
export function loadPolicy(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object') return undefined;
    if (!Array.isArray(raw.workspaces) || raw.workspaces === null) return undefined;
    if (raw.rules === null || typeof raw.rules !== 'object') return undefined;
    for (const workspace of raw.workspaces) {
      if (typeof workspace.id !== 'string' || !Array.isArray(workspace.match)) return undefined;
    }
    // Rossz regex ne ölje meg az egész védelmet: csak az adott szabály esik ki.
    for (const [id, rule] of Object.entries(raw.rules)) {
      if (rule === null || typeof rule !== 'object') {
        delete raw.rules[id];
        continue;
      }
      try {
        compileRule(rule);
      } catch {
        delete raw.rules[id];
      }
    }
    return raw;
  } catch {
    return undefined;
  }
}

/** mtime-alapú gyorsítótár: a fájl változását 2 másodpercen belül észreveszi. */
export function createPolicyLoader(file, { intervalMs = 2_000 } = {}) {
  let cached;
  let cachedAt = 0;
  let cachedMtime = -1;
  return () => {
    const now = Date.now();
    if (cached !== undefined && now - cachedAt < intervalMs) return cached;
    try {
      const mtime = statSync(file).mtimeMs;
      if (cached !== undefined && mtime === cachedMtime) {
        cachedAt = now;
        return cached;
      }
      cached = loadPolicy(file);
      cachedMtime = mtime;
    } catch {
      cached = undefined;
    }
    cachedAt = now;
    return cached;
  };
}

/** A döntés naplózható alakja (a plugin ezt írja a logba). */
export function describeDecision(exec, decision) {
  return {
    at: new Date().toISOString(),
    tool: exec?.name,
    cwd: callCwd(exec),
    rule: decision.rule,
    workspace: decision.workspace,
    reason: decision.reason
  };
}
