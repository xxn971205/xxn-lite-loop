import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROD_TRUNKS = ['main', 'master'];
export const ENV_BRANCHES = [...PROD_TRUNKS, 'test', 'uat'];

export function resolveTrialConfig(verification, repo) {
  const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const commands = verification?.commands;
  const command = clean(repo?.verificationCommand)
    ?? clean(repo?.name && commands?.[repo.name])
    ?? clean(repo?.repo && commands?.[repo.repo])
    ?? clean(repo?.path && commands?.[repo.path]);
  return { mode: clean(verification?.mode) ?? 'local-test', command, skipReason: clean(verification?.skipReason) };
}

export class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function factFailure(source, error) {
  const stderr = String(error.extra?.stderr ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
  return { source, code: error.code ?? 'UNEXPECTED_ERROR', message: error.message, ...(stderr ? { stderr } : {}) };
}

export function splitPatterns(value) {
  if (value == null || value === true) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value).trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return splitPatterns(parsed);
    } catch { /* fall back to the delimited form */ }
  }
  const patterns = [];
  let start = 0;
  let inRegex = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && inRegex) i += 1;
    else if (char === '/' && (inRegex || !text.slice(start, i).trim())) inRegex = !inRegex;
    else if (char === ',' && !inRegex) {
      patterns.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  patterns.push(text.slice(start).trim());
  return patterns.filter(Boolean);
}

function compileBranchPattern(pattern) {
  const raw = String(pattern ?? '').trim();
  if (!raw) throw new CliError('INVALID_BRANCH_PATTERN', '受保护分支规则不能为空');
  if (raw.startsWith('/')) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
    if (!m || /[^i]/.test(m[2])) {
      throw new CliError('INVALID_BRANCH_PATTERN', `非法正则分支规则（仅支持 /pattern/ 或 /pattern/i）：${raw}`, { pattern: raw });
    }
    try {
      const re = new RegExp(m[1], m[2]);
      return (branch) => re.test(branch);
    } catch (err) {
      throw new CliError('INVALID_BRANCH_PATTERN', `正则分支规则编译失败（${raw}）：${err.message}`, { pattern: raw });
    }
  }
  if (raw.includes('*')) {
    const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return (branch) => re.test(branch);
  }
  return (branch) => branch === raw;
}

export function validateBranchPatterns(patterns) {
  for (const pat of patterns) compileBranchPattern(pat);
  return patterns;
}

export function matchProtectedBranch(branch, patterns) {
  const name = String(branch ?? '').trim();
  let match = null;
  for (const raw of patterns) {
    const test = compileBranchPattern(raw);
    if (match === null && name && test(name)) match = String(raw).trim();
  }
  return match;
}

export function protectedMergeBaseline(run) {
  return matchProtectedBranch(run.baselineBranch ?? run.branch, [
    ...ENV_BRANCHES, ...splitPatterns(run.protectedEnvBranches), ...(run.repos ?? []).map(({ branch }) => branch).filter(Boolean),
  ]);
}

export function isEnvironmentSource(source, repoTrunk, patterns) {
  return Boolean(source && !PROD_TRUNKS.includes(source) && source !== repoTrunk && matchProtectedBranch(source, patterns));
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function lockOwnerRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function reapStaleLock(lock) {
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (lockOwnerRunning(pid)) return;
    const current = fs.statSync(lock);
    if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) fs.unlinkSync(lock);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function withFileLock(lock, write, { busy = () => new CliError('LOCK_BUSY', '运行态正在更新，请稍后重试') } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      reapStaleLock(lock);
      if (Date.now() >= deadline) {
        throw busy();
      }
      Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, 50);
    }
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    return write();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function isRunSidecar(name) {
  return /\.(?:outbox|tick-state\.(?:controller|dispatch|patrol|lead-patrol))\.json$/.test(name);
}

export function tickLockPath(runPath) {
  return runPath.replace(/\.json$/, '.tick.lock');
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function safeSlug(value) {
  const s = String(value ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/\.{2,}/g, '.');
  return s.replace(/^[.-]+|[.-]+$/g, '') || 'req';
}

export function writeAtomic(file, text, { create = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    if (create) fs.linkSync(tmp, file);
    else fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function runFile(configDir, req) {
  return path.join(configDir, 'runs', `${safeSlug(req)}.json`);
}

export function configPath(dir) {
  return path.resolve(expandHome(dir ?? process.env.XXN_LITE_LOOP_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'dev-loop')));
}

export function demandLabel(req) {
  return `需求:${safeSlug(req)}`;
}

export function forgeHostArgs(run) {
  const raw = run.forge === 'gitlab' ? run.gitlabHost ?? run.hostname : run.hostname ?? run.gitlabHost;
  const host = typeof raw === 'string' ? raw.trim() : '';
  return host && host.toLowerCase() !== 'null' ? ['--hostname', host] : [];
}

export function primaryLedgerKey(tier) {
  return { L1: 'tracking', L2: 'main', L3: 'master' }[tier] ?? 'main';
}

export function issueNumber(value) {
  return /^#?([1-9]\d*)$/.exec(String(value ?? '').trim())?.[1] ?? null;
}

export function boundLedger(run, key) {
  const ledger = run.ledgers?.find((item) => item.key === key);
  const bound = run.issues?.[key] ?? ledger?.issue ?? ledger;
  const id = issueNumber(bound?.id ?? bound);
  const repo = bound?.repo ?? ledger?.repo ?? run.hubRepo?.repo;
  return repo && id ? { id, repo } : null;
}

export const normModel = (value) => typeof value === 'string' ? value.trim() : '';
export const sameModel = (a, b) => Boolean(normModel(a) && normModel(a).toLowerCase() === normModel(b).toLowerCase());
export const acceptanceEnabled = (run) => run.tier !== 'L1' && run.acceptance?.enabled === true;

export function matchingDeveloperModel(run, model) {
  return [run.roleModels?.coder, run.roleModels?.coderEscalation].find((coder) => sameModel(model, coder));
}

export function parseAcceptanceComments(comments) {
  const records = [];
  for (const note of comments ?? []) {
    const match = /^[ \t]*<!-- liteloop:acceptance ([^\r\n]+?) -->[ \t]*$/m.exec(note.body ?? '');
    if (!match) continue;
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    if (['通过', '不通过'].includes(data?.conclusion) && normModel(data.model)
      && typeof data?.session === 'string' && data.session && typeof data?.at === 'string' && data.at) {
      records.push({ ...data, baselineSha: typeof data.baselineSha === 'string' ? data.baselineSha.toLowerCase() : null, commentId: note.id });
    }
  }
  return records;
}

export function latestAcceptance(ledger) {
  return parseAcceptanceComments(ledger?.comments).reduce((latest, record) =>
    !latest || record.commentId > latest.commentId ? record : latest, null);
}
