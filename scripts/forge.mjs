#!/usr/bin/env node
/**
 * forge.mjs — xxn-lite-loop 的 GitLab (`glab`) / GitHub (`gh`) 统一适配层。
 *
 * 零依赖 Node.js ESM（Node 20+）。外部命令全部用参数数组执行，不拼 shell 字符串。
 *
 * 通用开关：
 *   --dry-run            不执行外部命令，输出规范化 JSON：{forge, command, args, stdin}
 *   --hostname <host>    GitLab 实例（缺省读 GITLAB_HOST），透传到每条 `glab api`；GitHub 写入 GH_HOST
 *
 * 子命令：
 *   issue-get / issue-comments / issue-create / issue-update / issue-comment / issue-close
 *   change-list / change-create / change-label / change-merge
 *   labels-sync / baseline-check
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ledgerSection, splitPatterns } from './guard.mjs';
import { spawnSync } from 'node:child_process';

const VERSION = '1.2.0';
const GLAB = process.env.GLAB_BIN || 'glab';
const GH = process.env.GH_BIN || 'gh';
const GIT = process.env.GIT_BIN || 'git';
const PAGE = 100;
const BOOLEAN_FLAGS = new Set(['dry-run', 'draft', 'handoff', 'help', 'overwrite', 'require-issue-ref', 'require-lineage']);
const PROD_TRUNKS = ['main', 'master'];
const ENV_BRANCHES = ['main', 'master', 'test', 'uat'];
const BASE_LABELS = ['待终审', '终审中', '待合并', '需修改', '阻断', '风险高', '风险低', 'bug'];
const DEFAULT_SLOTS = ['主研发', 'A', 'B'];
const LABEL_TABLE = {
  待终审: { color: '1D76DB', description: '等待独立终审' },
  终审中: { color: '0E8A16', description: '终审会话进行中' },
  待合并: { color: 'FBCA04', description: '终审通过等待合并' },
  需修改: { color: 'D93F0B', description: '终审打回需修改' },
  阻断: { color: 'B60205', description: '存在阻断依赖' },
  风险高: { color: 'E11D21', description: '终审判定高风险' },
  风险低: { color: '0E8A16', description: '终审判定低风险' },
  bug: { color: 'B60205', description: '缺陷修复' },
};

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ */
/* 参数                                                                  */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    let key = token.slice(2);
    let value = true;
    if (eq > -1) {
      key = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else if (!BOOLEAN_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    flags[key] = value;
  }
  return { flags, positional };
}

function optional(flags, key, fallback = null) {
  const value = flags[key];
  if (value === undefined || value === true || String(value).trim() === '') return fallback;
  return String(value);
}

function required(flags, key) {
  const value = optional(flags, key);
  if (value === null) throw new CliError('MISSING_FLAG', `缺少必填参数 --${key}`);
  return value;
}

function splitList(value) {
  if (value === undefined || value === true) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function queryString(params) {
  const pairs = Object.entries(compact(params)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}

function normalizeState(value) {
  return String(value ?? '').trim().toLowerCase();
}

function encodeProject(repo) {
  const text = String(repo);
  return /^\d+$/.test(text) ? text : encodeURIComponent(text);
}

/* ------------------------------------------------------------------ */
/* 调用构造与执行                                                        */
/* ------------------------------------------------------------------ */

function makeCtx(flags) {
  const forge = String(required(flags, 'forge')).toLowerCase();
  if (!['gitlab', 'github'].includes(forge)) {
    throw new CliError('INVALID_FORGE', `--forge 必须是 gitlab 或 github，收到：${flags.forge}`);
  }
  const host = optional(flags, 'hostname') ?? (forge === 'gitlab' ? (process.env.GITLAB_HOST || null) : null);
  return { forge, host, dryRun: Boolean(flags['dry-run']) };
}

function api(ctx, method, apiPath, body) {
  const args = ['api'];
  if (ctx.host) args.push('--hostname', ctx.host);
  args.push('--method', method, apiPath);
  if (body !== undefined) args.push('--header', 'Content-Type: application/json', '--input', '-');
  return { forge: 'gitlab', command: GLAB, args, stdin: body === undefined ? '' : JSON.stringify(body) };
}

function gh(ctx, args) {
  const inv = { forge: 'github', command: GH, args, stdin: '' };
  if (ctx.host) inv.env = { GH_HOST: ctx.host };
  return inv;
}

function git(args) {
  return { forge: 'git', command: GIT, args, stdin: '' };
}

function runProcess(inv) {
  const result = spawnSync(inv.command, inv.args, {
    input: inv.stdin ?? '',
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(inv.env ?? {}) },
  });
  const where = { invocation: { command: inv.command, args: inv.args } };
  if (result.error) throw new CliError('EXEC_FAILED', `无法执行 ${inv.command}：${result.error.message}`, where);
  if (result.status !== 0) {
    throw new CliError('EXEC_FAILED', `${inv.command} 退出码 ${result.status}`, {
      ...where,
      stderr: (result.stderr || '').trim(),
      stdout: (result.stdout || '').trim(),
    });
  }
  return result.stdout ?? '';
}

function parseMaybeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readJson(inv) {
  const data = parseMaybeJson(runProcess(inv));
  if (data === null) throw new CliError('EXEC_FAILED', `${inv.command} 未返回 JSON`, { invocation: { command: inv.command, args: inv.args } });
  return data;
}

function emitDry(invocations, extra = {}) {
  const [first] = invocations;
  const payload = {
    ok: true,
    dryRun: true,
    forge: first.forge,
    command: first.command,
    args: first.args,
    stdin: first.stdin ?? '',
    ...extra,
  };
  if (invocations.length > 1) payload.invocations = invocations;
  return payload;
}

function emitReal(invocations, extra = {}) {
  const results = invocations.map((inv) => {
    const stdout = runProcess(inv);
    return { command: inv.command, args: inv.args, stdout: stdout.trim(), json: parseMaybeJson(stdout) };
  });
  if (results.length === 1) return { ok: true, dryRun: false, forge: invocations[0].forge, ...results[0], ...extra };
  return { ok: true, dryRun: false, results, ...extra };
}

function simple(ctx, invocations) {
  return ctx.dryRun ? emitDry(invocations) : emitReal(invocations);
}

/* ------------------------------------------------------------------ */
/* Issue                                                                 */
/* ------------------------------------------------------------------ */

function issueGet(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  if (ctx.forge === 'gitlab') return [api(ctx, 'GET', `projects/${encodeProject(repo)}/issues/${id}`)];
  return [gh(ctx, ['issue', 'view', id, '--repo', repo, '--json', 'number,title,body,state,labels,url'])];
}

function issueComments(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  if (!/^[1-9]\d*$/.test(id)) throw new CliError('INVALID_ISSUE_ID', '--id 必须是正整数');
  const endpoint = ctx.forge === 'gitlab'
    ? `projects/${encodeProject(repo)}/issues/${id}/notes`
    : `repos/${repo}/issues/${id}/comments`;
  const pageRead = (page) => {
    const query = queryString({ per_page: PAGE, page: page > 1 ? page : null });
    return ctx.forge === 'gitlab' ? api(ctx, 'GET', endpoint + query) : gh(ctx, ['api', endpoint + query]);
  };
  if (ctx.dryRun) return emitDry([pageRead(1)], { repo, id });

  const comments = [];
  for (let page = 1; ; page += 1) {
    const items = readJson(pageRead(page));
    if (!Array.isArray(items)) throw new CliError('EXEC_FAILED', 'Forge 未返回评论列表');
    for (const item of items) {
      const commentId = Number(item.id);
      if (!Number.isSafeInteger(commentId) || commentId <= 0) throw new CliError('EXEC_FAILED', 'Forge 评论缺少有效数字 ID');
      comments.push({
        id: commentId,
        author: ctx.forge === 'gitlab' ? (item.author?.username ?? null) : (item.user?.login ?? null),
        createdAt: item.created_at ?? null,
        body: item.body ?? '',
      });
    }
    if (items.length < PAGE) break;
  }
  return { ok: true, dryRun: false, forge: ctx.forge, repo, id, comments };
}

function issueCreate(ctx, flags) {
  const repo = required(flags, 'repo');
  const title = required(flags, 'title');
  const body = optional(flags, 'body', '');
  const labels = optional(flags, 'labels', '');
  if (ctx.forge === 'gitlab') {
    return [api(ctx, 'POST', `projects/${encodeProject(repo)}/issues`, compact({ title, description: body, labels }))];
  }
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  if (labels) args.push('--label', labels);
  return [gh(ctx, args)];
}

function issueUpdate(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  const title = optional(flags, 'title');
  const body = optional(flags, 'body');
  if (title === null && body === null) throw new CliError('MISSING_FLAG', 'issue-update 至少提供 --title 或 --body');
  if (ctx.forge === 'gitlab') {
    return [api(ctx, 'PUT', `projects/${encodeProject(repo)}/issues/${id}`, compact({ title, description: body }))];
  }
  const args = ['issue', 'edit', id, '--repo', repo];
  if (title !== null) args.push('--title', title);
  if (body !== null) args.push('--body', body);
  return [gh(ctx, args)];
}

function extractLedgerOwners(body) {
  const section = ledgerSection(body, 1);
  return [...section.matchAll(/^[ \t]*(?:[-*+][ \t]+)?主控[ \t]*[：:][ \t]*第[ \t]*(\d+)[ \t]*任[ \t]*[｜|][ \t]*([^\s｜|]+)/gm)]
    .map((m) => ({ sessionId: m[2], generation: Number(m[1]) }));
}

function liveIssueBody(ctx, repo, id) {
  const data = readJson(ctx.forge === 'gitlab'
    ? api(ctx, 'GET', `projects/${encodeProject(repo)}/issues/${id}`)
    : gh(ctx, ['issue', 'view', String(id), '--repo', String(repo), '--json', 'body']));
  return ctx.forge === 'gitlab' ? (data.description ?? '') : (data.body ?? '');
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

function issueLockPath(ctx, flags, repo, id) {
  const configured = optional(flags, 'config-dir') ?? process.env.XXN_LITE_LOOP_CONFIG_DIR;
  const root = configured
    ? path.resolve(configured.replace(/^~(?=\/|$)/, os.homedir()))
    : path.join(os.homedir(), '.config', 'dev-loop');
  const host = (ctx.host ?? (ctx.forge === 'gitlab' ? 'gitlab.com' : process.env.GH_HOST || 'github.com')).toLowerCase();
  const key = [ctx.forge, host, ctx.forge === 'github' ? repo.toLowerCase() : repo, id.replace(/^0+(?=\d)/, '')];
  return path.join(root, 'locks', `${createHash('sha256').update(JSON.stringify(key)).digest('hex')}.lock`);
}

function reapStaleIssueLock(lock) {
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

function withIssueLock(ctx, flags, repo, id, write) {
  const lock = issueLockPath(ctx, flags, repo, id);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      reapStaleIssueLock(lock);
      if (Date.now() >= deadline) {
        throw new CliError('ISSUE_LOCK_BUSY', '同一 Issue 正在更新，本次尚未写入，请稍后重试', { repo, id });
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

function assertIssueOwner(body, expected, repo, id, phase = 'before') {
  const owners = extractLedgerOwners(body);
  const actualOwner = owners[0]?.sessionId ?? null;
  const generation = owners[0]?.generation ?? null;
  const details = { expectOwner: expected, actualOwner, generation, repo, id };
  if (phase === 'after' && (owners.length !== 1 || actualOwner !== expected)) {
    throw new CliError('OWNER_CONFLICT_POST_WRITE', '写入后读回的台账主控与预期不一致，请核对远端台账', details);
  }
  if (!owners.length) throw new CliError('OWNER_MISSING', '远端台账第 1 节缺少主控行，拒绝写入', details);
  if (owners.length > 1) throw new CliError('OWNER_AMBIGUOUS', '远端台账第 1 节存在多条主控行，拒绝写入', details);
  if (actualOwner !== expected) {
    throw new CliError('OWNER_CHANGED', `远端台账主控已变为第 ${generation} 任 ${actualOwner}，与 --expect-owner ${expected} 不一致，拒绝写入`, details);
  }
  return owners[0];
}

function issueUpdateWithOwner(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  const expectOwner = optional(flags, 'expect-owner');
  const handoff = Boolean(flags.handoff);
  const invocations = issueUpdate(ctx, flags);
  const body = optional(flags, 'body');

  if (ctx.dryRun) {
    if (!expectOwner) return emitDry(invocations);
    const reads = issueGet(ctx, flags);
    return handoff
      ? emitDry(body === null ? invocations : [...invocations, ...reads], { expectOwner, ownerCheck: { mode: 'handoff-skip', field: '主控' } })
      : emitDry([...reads, ...reads, ...invocations, ...reads], {
        expectOwner,
        ownerCheck: { mode: 'issue-get', field: '主控', note: '在本机同 Issue 锁内核对主控，写前再确认，写后复读' },
      });
  }

  return withIssueLock(ctx, flags, repo, id, () => {
    if (!expectOwner) return emitReal(invocations);
    if (handoff) {
      const owners = body === null ? [] : extractLedgerOwners(body);
      if (body !== null && owners.length !== 1) {
        throw new CliError('INVALID_HANDOFF_OWNER', '交接后正文第 1 节须有唯一主控行', { repo, id });
      }
      const result = emitReal(invocations, { expectOwner, ownerCheck: { mode: 'handoff-skip', field: '主控' } });
      if (owners.length) assertIssueOwner(liveIssueBody(ctx, repo, id), owners[0].sessionId, repo, id, 'after');
      return result;
    }

    assertIssueOwner(liveIssueBody(ctx, repo, id), expectOwner, repo, id);
    if (body !== null) {
      const owners = extractLedgerOwners(body);
      if (owners.length !== 1 || owners[0].sessionId !== expectOwner) {
        throw new CliError('OWNER_UPDATE_MISMATCH', '更新正文须在第 1 节保留唯一现任主控，变更主控请显式交接', { expectOwner, repo, id });
      }
    }
    assertIssueOwner(liveIssueBody(ctx, repo, id), expectOwner, repo, id);
    const result = emitReal(invocations);
    const owner = assertIssueOwner(liveIssueBody(ctx, repo, id), expectOwner, repo, id, 'after');
    return {
      ...result,
      expectOwner,
      ownerCheck: { mode: 'issue-get', field: '主控', actualOwner: owner.sessionId, generation: owner.generation, matched: true },
    };
  });
}

function issueComment(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  const body = required(flags, 'body');
  if (ctx.forge === 'gitlab') return [api(ctx, 'POST', `projects/${encodeProject(repo)}/issues/${id}/notes`, { body })];
  return [gh(ctx, ['issue', 'comment', id, '--repo', repo, '--body', body])];
}

function issueClose(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  if (ctx.forge === 'gitlab') return [api(ctx, 'PUT', `projects/${encodeProject(repo)}/issues/${id}`, { state_event: 'close' })];
  return [gh(ctx, ['issue', 'close', id, '--repo', repo])];
}

/* ------------------------------------------------------------------ */
/* 变更单 PR/MR                                                          */
/* ------------------------------------------------------------------ */

function mrRepoPath(mr) {
  const full = mr?.references?.full;
  if (full) return String(full).split(/[!#]/)[0];
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//.exec(String(mr?.web_url ?? ''));
  return m ? m[1] : null;
}

function changeList(ctx, flags) {
  const repos = splitList(flags.repos);
  if (repos.length === 0) throw new CliError('MISSING_FLAG', '缺少必填参数 --repos');
  const label = optional(flags, 'label');
  const state = normalizeState(optional(flags, 'state', 'open'));
  const updatedAfter = optional(flags, 'updated-after');
  const group = ctx.forge === 'gitlab' ? optional(flags, 'group') : null;
  let invocations;
  if (ctx.forge === 'gitlab') {
    const query = queryString({
      state: state === 'open' ? 'opened' : state,
      labels: label,
      updated_after: updatedAfter,
      per_page: PAGE,
    });
    invocations = group
      ? [api(ctx, 'GET', `groups/${encodeProject(group)}/merge_requests${query}`)]
      : repos.map((repo) => api(ctx, 'GET', `projects/${encodeProject(repo)}/merge_requests${query}`));
  } else {
    const args = [
      'search', 'prs',
      '--state', state === 'opened' ? 'open' : state,
      '--limit', String(PAGE),
      '--json', 'number,title,state,url,repository,updatedAt,labels',
    ];
    for (const repo of repos) args.push('--repo', repo);
    if (label) args.push('--label', label);
    if (updatedAfter) args.push('--updated', `>=${updatedAfter}`);
    invocations = [gh(ctx, args)];
  }
  const meta = { repos, pageLimit: PAGE, ...(group ? { group, filterRepos: repos } : {}) };
  if (ctx.dryRun) return emitDry(invocations, { ...meta, count: invocations.length });

  let truncated = false;
  const items = [];
  for (const inv of invocations) {
    const data = readJson(inv);
    const list = Array.isArray(data) ? data : [];
    if (list.length >= PAGE) truncated = true;
    items.push(...(group ? list.filter((mr) => repos.includes(mrRepoPath(mr)) || repos.includes(String(mr.project_id))) : list));
  }
  return {
    ok: true,
    dryRun: false,
    forge: ctx.forge,
    ...meta,
    items,
    truncated,
    complete: !truncated,
    warnings: truncated ? [`结果达到 ${PAGE} 条上限，可能漏单：缩小 --updated-after 或按仓分批，查全前不得用于审查/清理`] : [],
  };
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

function matchesBranchPattern(branch, patterns) {
  const name = String(branch ?? '').trim();
  if (!name) return false;
  for (const pat of patterns) {
    if (compileBranchPattern(pat)(name)) return true;
  }
  return false;
}

function loadRunOptional(flags) {
  const runPath = flags.run === undefined ? null : required(flags, 'run');
  if (!runPath) return { runPath: null, run: null };
  try {
    return { runPath, run: JSON.parse(fs.readFileSync(runPath, 'utf8')) };
  } catch (err) {
    throw new CliError('INVALID_RUN', `无法读取 --run：${err.message}`);
  }
}

function findRunRepo(run, repo) {
  if (!run || !Array.isArray(run.repos) || repo == null) return null;
  const key = String(repo);
  return run.repos.find((r) => r?.repo != null && String(r.repo) === key)
    ?? run.repos.find((r) => r?.name != null && String(r.name) === key)
    ?? null;
}

function collectProdTrunks(flags, selectedRepo) {
  const trunks = new Set(PROD_TRUNKS);
  for (const t of splitList(flags['prod-trunks'])) trunks.add(t);
  if (selectedRepo?.branch) trunks.add(String(selectedRepo.branch));
  return trunks;
}

function collectProtectedPatterns(flags, run) {
  const patterns = [...new Set([...ENV_BRANCHES, ...splitPatterns(flags['protected-branches']), ...(run?.protectedEnvBranches ?? [])])];
  for (const p of patterns) compileBranchPattern(p);
  return patterns;
}

function changeCreate(ctx, flags) {
  const repo = required(flags, 'repo');
  const source = required(flags, 'source');
  const target = required(flags, 'target');
  const title = required(flags, 'title');
  const body = optional(flags, 'body', '');
  const labels = optional(flags, 'labels', '');
  const draft = Boolean(flags.draft);
  const { run } = loadRunOptional(flags);
  const selected = findRunRepo(run, repo);
  const prodTrunks = collectProdTrunks(flags, selected);
  const protectedBranches = collectProtectedPatterns(flags, run);
  // 生产主干（仅限当前仓自身主干）允许建单回合需求基线；非主干公共环境分支严禁作为源分支建单污染基线
  if (!prodTrunks.has(source) && matchesBranchPattern(source, protectedBranches)) {
    throw new CliError(
      'SOURCE_ENV_BRANCH_FORBIDDEN',
      `源分支 ${source} 命中非主干受保护环境分支规则（${protectedBranches.join(', ')}），严禁将其合入或建单污染需求基线`,
      { repo, source, target, protectedBranches },
    );
  }
  if (ctx.forge === 'gitlab') {
    return [api(ctx, 'POST', `projects/${encodeProject(repo)}/merge_requests`, compact({
      source_branch: source,
      target_branch: target,
      title: draft ? `Draft: ${title}` : title,
      description: body,
      labels,
      remove_source_branch: true,
    }))];
  }
  const args = ['pr', 'create', '--repo', repo, '--base', target, '--head', source, '--title', title, '--body', body];
  if (labels) args.push('--label', labels);
  if (draft) args.push('--draft');
  return [gh(ctx, args)];
}

function changeLabel(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  const add = splitList(flags.add);
  const remove = splitList(flags.remove);
  if (add.length === 0 && remove.length === 0) throw new CliError('MISSING_FLAG', '至少提供 --add 或 --remove');
  if (ctx.forge === 'gitlab') {
    return [api(ctx, 'PUT', `projects/${encodeProject(repo)}/merge_requests/${id}`, compact({
      add_labels: add.join(','),
      remove_labels: remove.join(','),
    }))];
  }
  const args = ['pr', 'edit', id, '--repo', repo];
  if (add.length) args.push('--add-label', add.join(','));
  if (remove.length) args.push('--remove-label', remove.join(','));
  return [gh(ctx, args)];
}

/* ------------------------------------------------------------------ */
/* change-merge：目标分支 + head SHA + Depends-On 全部向 Forge 实查         */
/* ------------------------------------------------------------------ */

function parseDepRef(token, defaultRepo, currentForge) {
  const text = String(token).trim().replace(/[.;。；]+$/, '');
  const gitlab = /^https?:\/\/([\w.:-]+)\/([\w.-]+(?:\/[\w.-]+)+)\/-\/merge_requests\/([1-9]\d*)(?:[?#][^\s]*)?$/i.exec(text);
  if (gitlab) return { forge: 'gitlab', host: gitlab[1].toLowerCase(), repo: gitlab[2], id: Number(gitlab[3]) };
  const github = /^https?:\/\/([\w.:-]+)\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:[?#][^\s]*)?$/i.exec(text);
  if (github) return { forge: 'github', host: github[1].toLowerCase(), repo: github[2], id: Number(github[3]) };
  const ref = /^([\w.-]+(?:\/[\w.-]+)+)?[!#]([1-9]\d*)$/.exec(text);
  return ref ? { forge: currentForge, host: null, repo: ref[1] ?? defaultRepo, id: Number(ref[2]) } : null;
}

function parseCallerDeps(value, repo, forge) {
  if (value === undefined) return { deps: [], invalid: [] };
  let raw;
  try {
    const text = String(value);
    raw = JSON.parse(text.startsWith('@') ? fs.readFileSync(text.slice(1), 'utf8') : text);
  } catch (err) {
    return { deps: [], invalid: [`--depends-on 不是合法 JSON：${err.message}`] };
  }
  if (raw && !Array.isArray(raw) && Array.isArray(raw.dependsOn)) raw = raw.dependsOn;
  if (!Array.isArray(raw)) return { deps: [], invalid: ['--depends-on 必须是数组'] };
  const deps = [];
  const invalid = [];
  for (const dep of raw) {
    if (typeof dep === 'string') {
      const ref = parseDepRef(dep, repo, forge);
      if (ref) deps.push({ ...ref, declaredState: null, source: 'caller' });
      else invalid.push(dep);
    } else if (dep && typeof dep.repo === 'string' && /^(?:\d+|[\w.-]+(?:\/[\w.-]+)+)$/.test(dep.repo)
      && /^[1-9]\d*$/.test(String(dep.id)) && (dep.forge == null || ['gitlab', 'github'].includes(dep.forge))
      && (dep.host == null || (typeof dep.host === 'string' && /^[\w.:-]+$/.test(dep.host)))) {
      deps.push({ forge: dep.forge ?? forge, host: dep.host?.toLowerCase() ?? null, repo: dep.repo, id: Number(dep.id), declaredState: dep.state ?? null, source: 'caller' });
    } else {
      invalid.push(JSON.stringify(dep));
    }
  }
  return { deps, invalid };
}

function parseDependsOnFromBody(body, repo, forge) {
  const deps = [];
  const invalid = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:[-*+]\s*|\d+[.)]\s+)?Depends-On\b(.*)$/i.exec(line);
    if (!m) continue;
    const declaration = /^\s*[:：]\s*(.*)$/.exec(m[1]);
    const tokens = declaration ? declaration[1].split(/[\s,，]+/).filter(Boolean) : [];
    if (tokens.length === 0) invalid.push(line.trim());
    for (const token of tokens) {
      const ref = parseDepRef(token, repo, forge);
      if (ref) deps.push({ ...ref, declaredState: null, source: 'body' });
      else invalid.push(token);
    }
  }
  return { deps, invalid };
}

function uniqueDeps(list) {
  const seen = new Map();
  for (const dep of list) {
    const key = `${dep.forge}:${dep.host || 'current'}:${dep.repo}#${dep.id}`;
    const previous = seen.get(key);
    if (!previous) seen.set(key, dep);
    else if (previous.source !== dep.source) seen.set(key, { ...previous, source: 'caller+body' });
  }
  return [...seen.values()];
}

function changeRead(ctx, repo, id) {
  if (ctx.forge === 'gitlab') return api(ctx, 'GET', `projects/${encodeProject(repo)}/merge_requests/${id}`);
  return gh(ctx, ['pr', 'view', String(id), '--repo', repo, '--json', 'baseRefName,headRefName,headRefOid,body,state']);
}

function readLiveChange(ctx, repo, id) {
  const data = readJson(changeRead(ctx, repo, id));
  if (ctx.forge === 'gitlab') {
    return { target: data.target_branch ?? null, source: data.source_branch ?? null, headSha: data.sha ?? null, body: data.description ?? '', state: data.state ?? null };
  }
  return { target: data.baseRefName ?? null, source: data.headRefName ?? null, headSha: data.headRefOid ?? null, body: data.body ?? '', state: data.state ?? null };
}

function validateDependencies(ctx, { deps, invalid }) {
  const malformed = [...invalid, ...deps.filter((d) => !Number.isSafeInteger(d.id)
    || (d.forge === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(d.repo)))];
  if (malformed.length) throw new CliError('DEPENDS_ON_INVALID', 'Depends-On 格式非法，拒绝合并', { invalid: malformed });
  const otherInstance = deps.filter((d) => d.forge !== ctx.forge || (d.host && d.host !== ctx.host.toLowerCase()));
  if (otherInstance.length) throw new CliError('DEPENDS_ON_CROSS_INSTANCE', 'Depends-On 无法在当前 Forge 实例核验，拒绝合并', { blocked: otherInstance });
}

function dependsError(blocked) {
  return new CliError('DEPENDS_ON_UNMERGED', `${blocked.length} 个 Depends-On 未合入或查询失败：拒绝合并，停在待合并`, { blocked });
}

function assertTarget(target, protectedBranches, code = 'ENV_BRANCH_FORBIDDEN') {
  if (matchesBranchPattern(target, protectedBranches)) {
    throw new CliError(code, `目标分支 ${target} 命中受保护环境分支规则（${protectedBranches.join(', ')}），只允许人工合并`, { target, protectedBranches });
  }
}

function assertSourceAllowed(source, protectedBranches, prodTrunks) {
  if (!source) return;
  if (prodTrunks.has(source)) {
    throw new CliError(
      'SOURCE_TRUNK_MANUAL_ONLY',
      `源分支 ${source} 是生产主干：允许向需求基线同步，但禁止 AI 自动合并，请由人确认后手动合并`,
      { source, prodTrunks: [...prodTrunks] },
    );
  }
  if (matchesBranchPattern(source, protectedBranches)) {
    throw new CliError(
      'SOURCE_ENV_BRANCH_FORBIDDEN',
      `源分支 ${source} 命中非主干受保护环境分支规则（${protectedBranches.join(', ')}），严禁合入需求基线`,
      { source, protectedBranches },
    );
  }
}

function normalizeIssueId(raw) {
  const m = /(\d+)$/.exec(String(raw ?? '').trim());
  return m ? m[1] : null;
}

function collectAllowedIssueIds(flags, run) {
  const ids = new Set();
  for (const token of splitList(flags['allowed-issues'])) {
    const id = normalizeIssueId(token);
    if (id) ids.add(id);
  }
  const addIssue = (item) => {
    const id = normalizeIssueId(typeof item === 'object' && item !== null ? item.id : item);
    if (id) ids.add(id);
  };
  const { subIssues, demandIssues, ...ledgerIssues } = run?.issues ?? {};
  for (const item of Object.values(ledgerIssues)) addIssue(item);
  for (const group of [subIssues, demandIssues, run?.demandIssues]) {
    const entries = Array.isArray(group) ? group
      : group && typeof group === 'object' && group.id == null ? Object.values(group) : [group];
    for (const item of entries) addIssue(item);
  }
  return ids;
}

function extractDemandIssueRefs(body, currentRepo) {
  const cleaned = String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[-*+]\s+|\d+[.)]\s+)?depends-on\s*[:：]/i.test(line))
    .join('\n');
  const refs = [];
  for (const m of cleaned.matchAll(/https?:\/\/[\w.:-]+\/([\w.-]+(?:\/[\w.-]+)+)\/(?:-\/)?issues\/([1-9]\d*)\b/gi)) {
    refs.push({ repo: m[1].toLowerCase(), id: m[2], explicitRepo: true });
  }
  for (const m of cleaned.matchAll(/(?:^|[\s(（:：\[,，])([\w.-]+(?:\/[\w.-]+)+)#([1-9]\d*)\b/g)) {
    refs.push({ repo: m[1].toLowerCase(), id: m[2], explicitRepo: true });
  }
  for (const m of cleaned.matchAll(/(?:^|[\s(（:：\[,，])#([1-9]\d*)\b/g)) {
    refs.push({ repo: currentRepo ? String(currentRepo).toLowerCase() : null, id: m[1], explicitRepo: false });
  }
  return refs;
}

function assertDemandIssueRef(body, { hubRepo, currentRepo, allowedIds, repo, id }) {
  const refs = extractDemandIssueRefs(body, currentRepo);
  if (refs.length === 0) {
    throw new CliError('MISSING_ISSUE_REF', 'PR/MR 描述未关联本次需求 Issue（已排除 Depends-On 行），拒绝自动合并', { repo, id });
  }
  const hub = hubRepo ? String(hubRepo).toLowerCase() : null;
  const cur = currentRepo ? String(currentRepo).toLowerCase() : null;
  const isCrossRepo = Boolean(hub && cur && hub !== cur);
  const repoMatched = hub
    ? refs.filter((r) => (isCrossRepo ? r.explicitRepo && r.repo === hub : r.repo === hub))
    : refs;
  if (repoMatched.length === 0) {
    throw new CliError(
      'ISSUE_REF_WRONG_REPO',
      `跨仓 PR/MR 描述必须显式引用核心仓 ${hubRepo} 的需求 Issue（如 ${hubRepo}#编号）`,
      { repo, id, hubRepo, found: refs },
    );
  }
  if (allowedIds.size > 0 && !repoMatched.some((r) => allowedIds.has(r.id))) {
    throw new CliError(
      'ISSUE_REF_NOT_IN_RUN',
      `PR/MR 引用的 Issue（${repoMatched.map((r) => `#${r.id}`).join(', ')}）不在本次需求登记的 Issue 集合（${[...allowedIds].map((x) => `#${x}`).join(', ')}）中，拒绝自动合并`,
      { repo, id, hubRepo, allowedIds: [...allowedIds], found: repoMatched },
    );
  }
}

function gitRaw(repoPath, args) {
  return spawnSync(GIT, args, { cwd: repoPath, encoding: 'utf8', timeout: 60000 });
}

function verifySourceLineage({ repoPath, target, source, headSha, baselineStartSha }) {
  if (!source) {
    throw new CliError('SOURCE_BRANCH_MISSING', 'Forge 未返回源分支名，无法完成血统校验，拒绝自动合并');
  }
  if (!repoPath || !fs.existsSync(repoPath)) {
    throw new CliError('SOURCE_LINEAGE_UNKNOWN', `本地仓库路径不存在，无法完成 Git 血统校验：${repoPath ?? '未提供'}`, { repoPath });
  }
  const inside = gitRaw(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || (inside.stdout ?? '').trim() !== 'true') {
    throw new CliError('SOURCE_LINEAGE_UNKNOWN', `路径不是有效的 Git 仓库，无法完成血统校验：${repoPath}`, { repoPath });
  }
  for (const br of [target, source]) {
    const fetched = gitRaw(repoPath, ['fetch', '--no-tags', 'origin', `+refs/heads/${br}:refs/remotes/origin/${br}`]);
    if (fetched.status !== 0) {
      throw new CliError('SOURCE_LINEAGE_UNKNOWN', `无法 fetch 远端分支 ${br}，拒绝跳过血统校验：${(fetched.stderr || fetched.stdout || '').trim()}`, { branch: br });
    }
  }
  const remoteSourceSha = gitRaw(repoPath, ['rev-parse', `refs/remotes/origin/${source}`]);
  if (remoteSourceSha.status !== 0) {
    throw new CliError('SOURCE_LINEAGE_UNKNOWN', `无法解析远端源分支 SHA：origin/${source}`);
  }
  const fetchedHead = remoteSourceSha.stdout.trim();
  if (headSha && fetchedHead !== headSha) {
    throw new CliError('HEAD_SHA_MISMATCH', `本地 fetch 到的 origin/${source} (${fetchedHead}) 与终审 SHA (${headSha}) 不一致`, { expected: headSha, actual: fetchedHead });
  }
  const mb = gitRaw(repoPath, ['merge-base', `refs/remotes/origin/${target}`, `refs/remotes/origin/${source}`]);
  if (mb.status !== 0 || !mb.stdout.trim()) {
    throw new CliError('SOURCE_LINEAGE_INVALID', `源分支 ${source} 与需求基线 ${target} 无共同祖先，非基于本次需求基线拉取`, { source, target });
  }
  const mergeBase = mb.stdout.trim();
  if (baselineStartSha) {
    const anc = gitRaw(repoPath, ['merge-base', '--is-ancestor', baselineStartSha, mergeBase]);
    if (anc.status !== 0) {
      throw new CliError(
        'SOURCE_LINEAGE_INVALID',
        `源分支 ${source} 的分叉点 (${mergeBase.slice(0, 8)}) 早于需求基线起点 (${baselineStartSha.slice(0, 8)})，非基于本次需求基线拉取`,
        { source, target, mergeBase, baselineStartSha },
      );
    }
  }
  const merges = gitRaw(repoPath, ['rev-list', '--merges', `refs/remotes/origin/${target}..refs/remotes/origin/${source}`]);
  if (merges.status !== 0) {
    throw new CliError('SOURCE_LINEAGE_UNKNOWN', `无法核验源分支提交线性度：${(merges.stderr || '').trim()}`);
  }
  const mergeCommits = (merges.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (mergeCommits.length > 0) {
    throw new CliError(
      'SOURCE_CONTAINS_MERGE_COMMITS',
      `源分支 ${source} 相对需求基线 ${target} 包含 ${mergeCommits.length} 个 merge commit，疑似混入 test/uat 或其他外部需求分支，请基于最新需求基线 rebase 后重送`,
      { source, target, mergeCommits },
    );
  }
  return { verified: true, source, target, mergeBase, baselineStartSha: baselineStartSha ?? null, mergeCommits: 0 };
}

function changeMerge(ctx, flags) {
  ctx = { ...ctx, host: ctx.host ?? (ctx.forge === 'gitlab' ? 'gitlab.com' : 'github.com') };
  let repo = required(flags, 'repo');
  const id = required(flags, 'id');
  const target = required(flags, 'target');
  const { run } = loadRunOptional(flags);
  let selected = null;
  if (run) {
    if (!Array.isArray(run.repos) || typeof run.baselineBranch !== 'string'
      || (run.protectedEnvBranches != null && !Array.isArray(run.protectedEnvBranches))) {
      throw new CliError('INVALID_RUN', '--run 缺少已确认仓库或基线');
    }
    selected = run.repos.find((r) => r?.repo != null && String(r.repo) === repo) ?? run.repos.find((r) => r?.name === repo);
    if (!selected) {
      throw new CliError('REPO_NOT_IN_RUN', `${repo} 不在需求已勾选的仓库中`);
    }
    repo = String(selected.repo ?? repo);
    if (target !== run.baselineBranch) {
      throw new CliError('TARGET_NOT_BASELINE', `目标分支 ${target} 不是已确认的需求基线 ${run.baselineBranch}`);
    }
    if ((run.forge && run.forge !== ctx.forge) || (ctx.forge === 'gitlab' && run.gitlabHost
      && String(run.gitlabHost).toLowerCase() !== ctx.host.toLowerCase())) {
      throw new CliError('FORGE_NOT_IN_RUN', 'Forge 实例与需求记录不一致，拒绝合并');
    }
    if (run.autoMerge === false) {
      throw new CliError('AUTO_MERGE_DISABLED', '需求记录已关闭自动合并，请人工合并');
    }
  }
  if (ctx.forge === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new CliError('INVALID_REPO', 'GitHub --repo 必须是当前实例的 owner/repo');
  }
  const prodTrunks = collectProdTrunks(flags, selected);
  const protectedBranches = [...new Set([...collectProtectedPatterns(flags, run), ...prodTrunks])];
  assertTarget(target, protectedBranches);
  const headSha = required(flags, 'head-sha');
  const repoPath = optional(flags, 'repo-path', '') || (selected?.path ? String(selected.path) : '');
  const baselineStartSha = optional(flags, 'baseline-start-sha', '') || (selected?.baselineStartSha ? String(selected.baselineStartSha) : '');
  const requireLineage = Boolean(flags['require-lineage']) || Boolean(repoPath);
  const allowedIds = collectAllowedIssueIds(flags, run);
  const requireIssueRef = Boolean(flags['require-issue-ref']) || allowedIds.size > 0;
  const caller = parseCallerDeps(flags['depends-on'], repo, ctx.forge);
  validateDependencies(ctx, caller);

  const merge = ctx.forge === 'gitlab'
    ? api(ctx, 'PUT', `projects/${encodeProject(repo)}/merge_requests/${id}/merge`, {
      sha: headSha,
      squash: false,
      should_remove_source_branch: true,
    })
    : gh(ctx, ['pr', 'merge', id, '--repo', repo, '--merge', '--delete-branch', '--match-head-commit', headSha]);
  const read = changeRead(ctx, repo, id);
  const strategy = {
    mergeStrategy: 'merge-commit',
    squash: false,
    mergeMethodNote: ctx.forge === 'gitlab'
      ? 'GitLab 项目若强制 fast-forward/squash，以项目设置为准；合并后读回 state=merged 才算成功'
      : '仓库启用合并队列时 gh 会入队，读回 state=MERGED 前不记成功',
  };

  if (ctx.dryRun) {
    const unmerged = caller.deps.filter((d) => d.declaredState && normalizeState(d.declaredState) !== 'merged');
    if (unmerged.length) throw dependsError(unmerged);
    const deps = uniqueDeps(caller.deps);
    const depReads = deps.map((d) => changeRead(ctx, d.repo, d.id));
    return emitDry([read, ...depReads, merge, read], {
      ...strategy,
      repo,
      id,
      target,
      headSha,
      protectedBranches,
      prodTrunks: [...prodTrunks],
      lineageCheck: { enabled: requireLineage, repoPath: repoPath || null, baselineStartSha: baselineStartSha || null },
      requireIssueRef,
      steps: {
        preflight: read,
        dependencyChecks: depReads,
        merge,
        verify: read,
      },
      dependencies: deps.map((d) => ({ ...d, verified: false })),
      note: '真实执行顺序：读回目标/源分支/head SHA/正文 → 源分支血统与环境护栏 → 核验 Issue 关联与 Depends-On → 带 SHA 合并 → 读回确认已合入。',
    });
  }

  const live = readLiveChange(ctx, repo, id);
  assertTarget(live.target, protectedBranches);
  if (live.target !== target) {
    throw new CliError('TARGET_MISMATCH', `变更单实际目标 ${live.target} 与需求基线 ${target} 不一致，拒绝合并`, { target, actual: live.target });
  }
  assertSourceAllowed(live.source, protectedBranches, prodTrunks);
  if (live.headSha !== headSha) {
    throw new CliError('HEAD_SHA_MISMATCH', '变更单当前 head 与终审时的 SHA 不一致，需重新送审', { expected: headSha, actual: live.headSha });
  }
  if (requireIssueRef) {
    assertDemandIssueRef(live.body, { hubRepo: run?.hubRepo?.repo ?? repo, currentRepo: repo, allowedIds, repo, id });
  }
  const lineage = requireLineage
    ? verifySourceLineage({ repoPath, target, source: live.source, headSha, baselineStartSha })
    : { verified: false, skippedReason: 'no-repo-path' };
  const body = parseDependsOnFromBody(live.body, repo, ctx.forge);
  validateDependencies(ctx, body);
  const dependencies = uniqueDeps([...caller.deps, ...body.deps]).map((dep) => {
    try {
      return { ...dep, state: readJson(changeRead(ctx, dep.repo, dep.id)).state ?? null };
    } catch (err) {
      return { ...dep, state: null, error: err.message };
    }
  });
  const blocked = dependencies.filter((d) => normalizeState(d.state) !== 'merged');
  if (blocked.length) throw dependsError(blocked);

  const stdout = runProcess(merge).trim();
  const after = readLiveChange(ctx, repo, id);
  if (normalizeState(after.state) !== 'merged') {
    throw new CliError('MERGE_NOT_CONFIRMED', `合并命令已执行但读回状态为 ${after.state}，不记成功`, { state: after.state, stdout });
  }
  return { ok: true, dryRun: false, forge: ctx.forge, merged: true, repo, id, target, source: live.source, headSha, lineage, dependencies, ...strategy, stdout };
}

/* ------------------------------------------------------------------ */
/* labels-sync：默认只补缺，不改共享标签                                  */
/* ------------------------------------------------------------------ */

function labelSpecs(flags) {
  const explicit = splitList(flags.labels);
  const slots = splitList(flags.slots);
  const names = explicit.length ? explicit : [...BASE_LABELS, ...(slots.length ? slots : DEFAULT_SLOTS).map((s) => `槽位${s}`)];
  return [...new Set(names)].map((name) => ({
    name,
    color: LABEL_TABLE[name]?.color ?? '5319E7',
    description: LABEL_TABLE[name]?.description ?? `xxn-lite-loop ${name}`,
  }));
}

function labelCreate(ctx, repo, label, overwrite) {
  if (ctx.forge === 'gitlab') {
    return api(ctx, 'POST', `projects/${encodeProject(repo)}/labels`, {
      name: label.name,
      color: `#${label.color}`,
      description: label.description,
    });
  }
  const args = ['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description];
  if (overwrite) args.push('--force');
  return gh(ctx, args);
}

function labelList(ctx, repo, page = 1) {
  if (ctx.forge === 'gitlab') return api(ctx, 'GET', `projects/${encodeProject(repo)}/labels?per_page=${PAGE}&page=${page}`);
  return gh(ctx, ['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name']);
}

function existingLabels(ctx, repo) {
  const names = new Set();
  for (let page = 1; page <= 50; page += 1) {
    const list = readJson(labelList(ctx, repo, page));
    for (const item of Array.isArray(list) ? list : []) names.add(item.name);
    if (ctx.forge === 'github' || !Array.isArray(list) || list.length < PAGE) break;
  }
  return names;
}

function labelsSync(ctx, flags) {
  const repos = splitList(flags.repos);
  if (repos.length === 0) throw new CliError('MISSING_FLAG', '缺少必填参数 --repos');
  const labels = labelSpecs(flags);
  const overwrite = ctx.forge === 'github' && Boolean(flags.overwrite);
  const meta = { labels, repos, overwrite };
  if (ctx.dryRun) {
    const invocations = [];
    for (const repo of repos) {
      if (!overwrite) invocations.push(labelList(ctx, repo));
      for (const label of labels) invocations.push(labelCreate(ctx, repo, label, overwrite));
    }
    return emitDry(invocations, {
      ...meta,
      note: overwrite ? '--overwrite：GitHub 用 --force 覆盖同名标签颜色与描述' : '真实执行先读既有标签，只补缺，不改共享标签',
    });
  }
  const results = [];
  for (const repo of repos) {
    const existing = overwrite ? new Set() : existingLabels(ctx, repo);
    for (const label of labels) {
      if (existing.has(label.name)) continue;
      const inv = labelCreate(ctx, repo, label, overwrite);
      results.push({ repo, label: label.name, stdout: runProcess(inv).trim() });
    }
  }
  return { ok: true, dryRun: false, forge: ctx.forge, ...meta, created: results };
}

/* ------------------------------------------------------------------ */
/* baseline-check：fetch 失败即未知，绝不拿陈旧 tracking ref 报对齐         */
/* ------------------------------------------------------------------ */

function baselineCheck(flags) {
  const specs = splitList(flags.repos);
  if (specs.length === 0) throw new CliError('MISSING_FLAG', '缺少必填参数 --repos path1:branch1,path2:branch2');
  const repos = specs.map((spec) => {
    const idx = spec.lastIndexOf(':');
    if (idx <= 0 || idx === spec.length - 1) throw new CliError('INVALID_REPOS', `baseline-check 仓库规格必须是 path:branch，收到：${spec}`);
    return { path: spec.slice(0, idx), branch: spec.slice(idx + 1) };
  });

  const fetch = (dir, branch) => git(['-C', dir, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (flags['dry-run']) {
    const invocations = repos.flatMap((repo) => [
      fetch(repo.path, repo.branch),
      git(['-C', repo.path, 'rev-parse', '--verify', `refs/heads/${repo.branch}`]),
      git(['-C', repo.path, 'rev-parse', '--verify', `refs/remotes/origin/${repo.branch}`]),
      git(['-C', repo.path, 'rev-list', '--left-right', '--count', `refs/heads/${repo.branch}...refs/remotes/origin/${repo.branch}`]),
    ]);
    return emitDry(invocations, { repos, note: 'dry-run 仅列出将执行的 git 命令' });
  }

  const results = repos.map((repo) => {
    const absolute = path.resolve(repo.path);
    if (!fs.existsSync(absolute)) throw new CliError('BASELINE_PATH_MISSING', `本地仓库路径不存在：${absolute}`);
    const remoteRef = `refs/remotes/origin/${repo.branch}`;
    const base = { path: absolute, branch: repo.branch, remoteRef };
    try {
      runProcess(fetch(absolute, repo.branch));
    } catch (err) {
      return { ...base, localSha: null, remoteSha: null, upToDate: false, fetchFailed: true, fetchError: `${err.message} ${err.extra?.stderr ?? ''}`.trim() };
    }
    const localSha = runProcess(git(['-C', absolute, 'rev-parse', '--verify', `refs/heads/${repo.branch}`])).trim();
    let remoteSha = null;
    try {
      remoteSha = runProcess(git(['-C', absolute, 'rev-parse', '--verify', remoteRef])).trim();
    } catch {
      return { ...base, localSha, remoteSha: null, upToDate: false, fetchFailed: false, remoteMissing: true };
    }
    const [ahead, behind] = runProcess(git(['-C', absolute, 'rev-list', '--left-right', '--count', `${localSha}...${remoteSha}`]))
      .trim().split(/\s+/).map((n) => Number(n) || 0);
    return {
      ...base,
      localSha,
      remoteSha,
      upToDate: localSha === remoteSha,
      ahead,
      behind,
      remoteAhead: behind > 0,
      localAhead: ahead > 0,
      fetchFailed: false,
    };
  });
  const unknown = results.filter((r) => r.fetchFailed || r.remoteMissing).length;
  return {
    ok: unknown === 0,
    forge: 'git',
    repos: results,
    drifted: results.filter((r) => !r.upToDate).length,
    unknown,
    ...(unknown ? { code: 'BASELINE_UNKNOWN', message: `${unknown} 个仓库无法读取远端，基线未知，拒绝依赖该 SHA`, exitCode: 2 } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                  */
/* ------------------------------------------------------------------ */

const COMMANDS = {
  'issue-get': (ctx, flags) => simple(ctx, issueGet(ctx, flags)),
  'issue-comments': issueComments,
  'issue-create': (ctx, flags) => simple(ctx, issueCreate(ctx, flags)),
  'issue-update': issueUpdateWithOwner,
  'issue-comment': (ctx, flags) => simple(ctx, issueComment(ctx, flags)),
  'issue-close': (ctx, flags) => simple(ctx, issueClose(ctx, flags)),
  'change-list': changeList,
  'change-create': (ctx, flags) => simple(ctx, changeCreate(ctx, flags)),
  'change-label': (ctx, flags) => simple(ctx, changeLabel(ctx, flags)),
  'change-merge': changeMerge,
  'labels-sync': labelsSync,
};

function usage() {
  return {
    ok: true,
    name: 'xxn-lite-loop/forge.mjs',
    version: VERSION,
    globalFlags: ['--dry-run', '--forge gitlab|github', '--hostname <host>（GitLab 缺省 GITLAB_HOST）'],
    commands: [
      'issue-get --forge <f> --repo <id|owner/repo> --id <num>',
      'issue-comments --forge <f> --repo <id|owner/repo> --id <num>',
      'issue-create --forge <f> --repo <...> --title <t> [--body <b>] [--labels a,b]',
      'issue-update --forge <f> --repo <...> --id <num> [--title <t>] [--body <b>] [--expect-owner <sessionId> [--handoff]]（--expect-owner：先 issue-get 核对第 1 节「主控：第 N 任 ｜ <sessionId>」，非现任抛 OWNER_CHANGED 拒写；--handoff 显式接任时跳过核对）',
      'issue-comment --forge <f> --repo <...> --id <num> --body <b>',
      'issue-close --forge <f> --repo <...> --id <num>',
      'change-list --forge <f> --repos <r1,r2> [--group <g>（按 --repos 白名单过滤）] [--label <l>] [--state open] [--updated-after <iso>]',
      'change-create --forge <f> --repo <...> --source <br> --target <br> --title <t> [--body <b>] [--labels a,b] [--draft] [--run <run.json>] [--protected-branches a,b]',
      'change-label --forge <f> --repo <...> --id <num> [--add a,b] [--remove c]',
      'change-merge --forge <f> --repo <...> --id <num> --head-sha <sha> --target <需求基线> [--run <run.json>] [--repo-path <dir>] [--baseline-start-sha <sha>] [--require-lineage] [--require-issue-ref] [--protected-branches a,b] [--depends-on <json>]',
      'labels-sync --forge <f> --repos <r1,r2> [--labels a,b,c | --slots 主研发,A,B] [--overwrite（仅 GitHub）]',
      'baseline-check --repos <path1:branch1,path2:branch2>',
    ],
  };
}

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const sub = positional[0];
  if (!sub || sub === 'help' || flags.help) return usage();
  if (sub === 'baseline-check') return baselineCheck(flags);
  const handler = COMMANDS[sub];
  if (!handler) throw new CliError('UNKNOWN_COMMAND', `未知子命令：${sub}`, { commands: usage().commands });
  return handler(makeCtx(flags), flags);
}

try {
  const { exitCode, ...payload } = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = Number(exitCode ?? 0);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? 'UNEXPECTED_ERROR', message: err.message, ...(err.extra ?? {}) }, null, 2)}\n`);
  process.exitCode = 2;
}
