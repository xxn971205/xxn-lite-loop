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
 *   issue-get / issue-comments / issue-create / issue-update / issue-comment / issue-close / reply
 *   labels-sync / baseline-check
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { labelNames, ledgerSection } from './guard.mjs';
import { spawnSync } from 'node:child_process';
import { configPath, demandLabel, forgeHostArgs, primaryLedgerKey, boundLedger, matchingDeveloperModel, runFile, writeAtomic, factFailure, CliError, PROD_TRUNKS, ENV_BRANCHES, splitPatterns, validateBranchPatterns, matchProtectedBranch, isEnvironmentSource, withFileLock, tickLockPath, resolveTrialConfig } from './lib/common.mjs';
import { FULL_SHA, RISK_RULES, appendReview, readReviews, reviewsFor } from './lib/review-journal.mjs';
import { isWaitingMerge, reviewLabelPlan, resolveReviewState } from './lib/review-state.mjs';
import { formatScriptComment } from './lib/action-messages.mjs';
import { dispatchSlot, scopedChanges } from './lib/tick-dispatch.mjs';
import { activeSlotClaims, forgeSlotClaims, slotKey } from './lib/slot-claims.mjs';

const VERSION = '1.4.0';
const GLAB = process.env.GLAB_BIN || 'glab';
const GH = process.env.GH_BIN || 'gh';
const GIT = process.env.GIT_BIN || 'git';
const PAGE = 100;
const BOOLEAN_FLAGS = new Set(['dry-run', 'draft', 'handoff', 'help', 'overwrite', 'require-issue-ref', 'require-lineage', 'republish']);
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
  const suppliedHost = optional(flags, 'hostname')?.trim();
  const explicitHost = suppliedHost && suppliedHost.toLowerCase() !== 'null' ? suppliedHost : null;
  const host = explicitHost ?? (forge === 'gitlab' ? process.env.GITLAB_HOST || null : null);
  return { forge, host, explicitHost, dryRun: Boolean(flags['dry-run']) };
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
  if (ctx.explicitHost) inv.env = { GH_HOST: ctx.explicitHost };
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
    timeout: 60_000,
    env: { ...process.env, ...(inv.env ?? {}) },
  });
  const where = { invocation: { command: inv.command, args: inv.args }, stderr: (result.stderr || '').trim() };
  if (result.error) throw new CliError('EXEC_FAILED', `无法执行 ${inv.command}：${result.error.message}`, where);
  if (result.status !== 0) {
    throw new CliError('EXEC_FAILED', `${inv.command} 退出码 ${result.status}`, {
      ...where,
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

function issueGet(ctx, flags, extraFields = '') {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  if (ctx.forge === 'gitlab') return [api(ctx, 'GET', `projects/${encodeProject(repo)}/issues/${id}`)];
  return [gh(ctx, ['issue', 'view', id, '--repo', repo, '--json', `number,title,body,state,labels,url${extraFields}`])];
}

function commentsEndpoint(ctx, kind, repo, id) {
  return ctx.forge === 'gitlab'
    ? `projects/${encodeProject(repo)}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${id}/notes`
    : `repos/${repo}/issues/${id}/comments`;
}

function apiPage(ctx, endpoint, page, filters = {}) {
  const query = queryString({ ...filters, per_page: PAGE, page: page > 1 ? page : null });
  return ctx.forge === 'gitlab' ? api(ctx, 'GET', endpoint + query) : gh(ctx, ['api', endpoint + query]);
}

function* readPages(ctx, endpoint, filters) {
  for (let page = 1; ; page += 1) {
    const items = readJson(apiPage(ctx, endpoint, page, filters));
    if (!Array.isArray(items)) throw new CliError('EXEC_FAILED', `Forge 未返回列表：${endpoint}`);
    yield* items;
    if (items.length < PAGE) break;
  }
}

function readComments(ctx, endpoint) {
  return Array.from(readPages(ctx, endpoint), (item) => {
    const id = Number(item?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new CliError('EXEC_FAILED', 'Forge 评论缺少有效数字 ID');
    return {
      id,
      author: ctx.forge === 'gitlab' ? (item.author?.username ?? null) : (item.user?.login ?? null),
      createdAt: item.created_at ?? null,
      body: item.body ?? '',
    };
  });
}

function issueComments(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  if (!/^[1-9]\d*$/.test(id)) throw new CliError('INVALID_ISSUE_ID', '--id 必须是正整数');
  const endpoint = commentsEndpoint(ctx, 'issue', repo, id);
  if (ctx.dryRun) return emitDry([apiPage(ctx, endpoint, 1)], { repo, id });
  const comments = readComments(ctx, endpoint);
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

function issueLockPath(ctx, flags, repo, id) {
  const configured = optional(flags, 'config-dir') ?? process.env.XXN_LITE_LOOP_CONFIG_DIR;
  const root = configured
    ? path.resolve(configured.replace(/^~(?=\/|$)/, os.homedir()))
    : path.join(os.homedir(), '.config', 'dev-loop');
  const host = (ctx.host ?? (ctx.forge === 'gitlab' ? 'gitlab.com' : process.env.GH_HOST || 'github.com')).toLowerCase();
  const key = [ctx.forge, host, ctx.forge === 'github' ? repo.toLowerCase() : repo, String(id).replace(/^0+(?=\d)/, '')];
  return path.join(root, 'locks', `${createHash('sha256').update(JSON.stringify(key)).digest('hex')}.lock`);
}

function withIssueLock(ctx, flags, repo, id, write) {
  return withFileLock(issueLockPath(ctx, flags, repo, id), write, {
    busy: () => new CliError('ISSUE_LOCK_BUSY', '同一 Issue 正在更新，本次尚未写入，请稍后重试', { repo, id }),
  });
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

function replyComment(ctx, flags) {
  const kind = required(flags, 'kind');
  if (kind !== 'issue' && kind !== 'change') throw new CliError('INVALID_REPLY_KIND', '--kind 必须是 issue 或 change');
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  const replyTo = required(flags, 'reply-to');
  if (!/^[1-9]\d*$/.test(id) || !/^[1-9]\d*$/.test(replyTo)) {
    throw new CliError('INVALID_REPLY_ID', '--id 与 --reply-to 必须是正整数');
  }
  const body = `${required(flags, 'body').trimEnd()}\n\n<!-- liteloop:reply-to=${replyTo} -->`;
  const endpoint = commentsEndpoint(ctx, kind, repo, id);
  return simple(ctx, [ctx.forge === 'gitlab'
    ? api(ctx, 'POST', endpoint, { body })
    : { ...gh(ctx, ['api', '--method', 'POST', endpoint, '--input', '-']), stdin: JSON.stringify({ body }) }]);
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

function changeComment(ctx, flags) {
  const repo = required(flags, 'repo');
  const id = required(flags, 'id');
  if (!/^[1-9]\d*$/.test(id)) throw new CliError('INVALID_CHANGE_ID', '--id 必须是正整数');
  const body = required(flags, 'body');
  if (/^(?:【)?已派终审|<!--\s*liteloop:verdict\b/m.test(body)) {
    throw new CliError('REVIEW_COMMAND_REQUIRED', '派审和结论分别使用 dispatch-review 和 verdict');
  }
  return simple(ctx, [ctx.forge === 'gitlab'
    ? api(ctx, 'POST', commentsEndpoint(ctx, 'change', repo, id), { body })
    : gh(ctx, ['pr', 'comment', id, '--repo', repo, '--body', body])]);
}

function postComment(ctx, kind, repo, id, body) {
  const endpoint = commentsEndpoint(ctx, kind, repo, id);
  return readJson(ctx.forge === 'gitlab'
    ? api(ctx, 'POST', endpoint, { body })
    : { ...gh(ctx, ['api', '--method', 'POST', endpoint, '--input', '-']), stdin: JSON.stringify({ body }) });
}

function postReviewNote(ctx, repo, id, body) {
  return postComment(ctx, 'change', repo, id, body);
}

function withReviewRun(ctx, flags, operation) {
  const runPath = required(flags, 'run');
  if (!runPath.endsWith('.json')) throw new CliError('INVALID_RUN', '--run 必须指向需求运行态 JSON');
  if (ctx.dryRun) throw new CliError('REVIEW_DRY_RUN_UNSUPPORTED', '派审和终审结论必须核对并写入本机登记簿');
  const repo = required(flags, 'repo');
  const id = factsId(required(flags, 'id'));
  return withFileLock(tickLockPath(runPath), () => {
    const { run } = loadRunOptional(flags);
    assertRunForge(ctx, run);
    if (!run.repos?.some((entry) => String(entry.repo).toLowerCase() === repo.toLowerCase())) {
      throw new CliError('REPO_NOT_IN_RUN', '变更单仓库未登记在需求运行态');
    }
    return operation(runPath, run, { repo, id });
  });
}

function reviewSession(flags, key = 'session') {
  const session = required(flags, key);
  if (!/^[^\s｜|<>`，]+$/.test(session)) throw new CliError('INVALID_SESSION', `--${key} 必须是单个有效的会话标识`);
  return session;
}

function reviewHead(flags) {
  const headSha = required(flags, 'head-sha').toLowerCase();
  if (!FULL_SHA.test(headSha)) throw new CliError('INVALID_HEAD_SHA', '--head-sha 必须是 40 位十六进制 SHA');
  return headSha;
}

function memberLabelConflict(labels) {
  return new Set(labels.filter((label) => label.startsWith('需求:'))).size > 1;
}

function changeMembership(run, { labels, target }) {
  if (memberLabelConflict(labels)) return 'DEMAND_LABEL_CONFLICT';
  if (!run.req || !labels.includes(demandLabel(run.req)) || target !== (run.baselineBranch ?? run.branch)) return 'CHANGE_NOT_IN_RUN';
  return null;
}

function assertChangeMembership(run, change) {
  const code = changeMembership(run, change);
  if (code) throw new CliError(code, code === 'DEMAND_LABEL_CONFLICT'
    ? '变更单有多个需求标签，请核实归属' : '变更单须带本需求标签且目标分支为需求基线');
}

function reviewLive(ctx, change) {
  const { repo, id } = change;
  const data = readJson(changeRead(ctx, repo, id, ',labels,isDraft,mergeable'));
  const fields = changeFields(ctx, data);
  const state = normalizeState(fields.state).replace(/^opened$/, 'open');
  return { ...fields, state, labels: labelNames(data.labels), draft: Boolean(data.isDraft || data.draft || data.work_in_progress),
    conflict: data.has_conflicts === true || data.mergeable === 'CONFLICTING' };
}

function reviewHeadChanged(expected, actual) {
  return new CliError('HEAD_SHA_MISMATCH', `终审的是 ${expected}，现在是 ${actual ?? '未知'}，需重新送审`, { expected, actual });
}

function assertReviewCandidate(live, headSha) {
  if (live.headSha?.toLowerCase() !== headSha) {
    throw reviewHeadChanged(headSha, live.headSha);
  }
  if (live.state !== 'open' || live.draft) {
    throw new CliError('REVIEW_CHANGE_NOT_OPEN', '只处理已打开且非草稿的 PR/MR');
  }
}

function dispatchReview(ctx, flags) {
  const headSha = reviewHead(flags);
  const session = reviewSession(flags);
  const role = required(flags, 'role');
  const by = role === 'dispatch' || flags.by !== undefined ? reviewSession(flags, 'by') : null;
  return withReviewRun(ctx, flags, (runPath, run, pr) => {
    const slot = dispatchSlot(run);
    const isLead = run.tier === 'L3';
    let controllerId = run.controller?.sessionId;
    if (isLead ? role !== 'dispatch' || slot !== '主研发' : role !== 'controller') {
      throw new CliError('REVIEW_DISPATCH_FORBIDDEN', 'L1/L2 由主控派审，L3 由主研发调度派审');
    }
    if (!isLead) {
      const key = run.tier === 'L1' ? 'tracking' : 'main';
      const ledger = run.issues?.[key] ?? run.ledgers?.find((item) => item.key === key)?.issue;
      if (!ledger) throw new CliError('LEDGER_NOT_BOUND', '运行态未登记主控台账');
      const repo = ledger.repo ?? run.hubRepo?.repo;
      const id = factsId(ledger.id ?? ledger);
      const owners = extractLedgerOwners(liveIssueBody(ctx, repo, id));
      if (owners.length !== 1) throw new CliError('CONTROLLER_STATE_UNKNOWN', '台账第 1 节必须有唯一的现任主控');
      controllerId = owners[0].sessionId;
    }
    const live = reviewLive(ctx, pr);
    assertReviewCandidate(live, headSha);
    assertChangeMembership(run, live);
    const { labels, source } = live;
    if (!labels.includes('待终审') || labels.includes('终审中')) {
      throw new CliError('REVIEW_NOT_QUEUED', '变更单须处于「待终审」才能派审');
    }
    const trunk = findRunRepo(run, pr.repo)?.branch;
    const protectedBranches = collectProtectedPatterns(flags, run);
    if (isEnvironmentSource(source, trunk, protectedBranches)) {
      assertSourceAllowed(source, protectedBranches, new Set());
    }
    const history = reviewsFor(readReviews(runPath), pr);
    const notes = readComments(ctx, commentsEndpoint(ctx, 'change', pr.repo, pr.id));
    const review = resolveReviewState(history, notes, headSha);
    if (session === controllerId || session === by || review.usedSessions.includes(session)) {
      throw new CliError('REVIEW_SESSION_REUSED', '每次派审须使用新的独立终审会话');
    }
    const { round } = review;
    const dispatchId = randomUUID();
    const nonce = randomBytes(32).toString('hex');
    const dispatcher = isLead ? '主研发调度' : '主控';
    const signature = by ?? controllerId;
    const at = new Date().toISOString();
    const previous = history.at(-1);
    if (previous?.merge?.state === 'waiting') {
      appendReview(runPath, { type: 'merge-result', dispatchId: previous.dispatchId, state: 'invalidated', code: 'REVIEW_NOT_ACTIVE' });
    }
    appendReview(runPath, { type: 'dispatch', dispatchId, pr, round, headSha, session, nonce, at, rejectDispatchIds: review.rejectDispatchIds });
    postReviewNote(ctx, pr.repo, pr.id, [
      `${dispatcher} ｜ ${slot} ｜ ${signature}`,
      `已派终审：第 ${round} 轮 ｜ 会话标识：${session} ｜ head SHA：${headSha} ｜ 派审 ID：${dispatchId}`,
    ].join('\n'));
    emitReal(changeLabel(ctx, { ...pr, add: '终审中', remove: '待终审' }));
    return {
      ok: true, dispatchId, round, headSha, session, nonce,
      rejectCount: review.rejectCount, fullReReview: review.rejectCount >= (run.thresholds?.rejectFuseCount ?? 2),
    };
  });
}

function verdictRisk(value) {
  const keys = new Set(RISK_RULES.map(({ key }) => key));
  const risk = Object.create(null);
  for (const field of value.split(',')) {
    const match = /^\s*(\w+)\s*=\s*([01])\s*$/.exec(field);
    if (!match || !keys.delete(match[1])) {
      throw new CliError('INVALID_RISK', '--risk 必须为六个不同的已知风险项，每项填 0 或 1');
    }
    risk[match[1]] = match[2] === '1';
  }
  if (keys.size) throw new CliError('INVALID_RISK', `--risk 缺少 ${[...keys].join(',')}`);
  return risk;
}

const GRADE_PREFIX = /^((?:\d+(?:\.(?!\d)|[、)）])|-[ \t])[ \t]*)?(?:(\*{1,2}|_{1,2})(?:【(P[012])】|\[(P[012])\]|(P[012])[：:]?)\2(?:[ \t]*[：:][ \t]*|[ \t]+)?|(?:【(P[012])】|\[(P[012])\])(?:[ \t]*[：:][ \t]*|[ \t]+)?|(P[012])(?:[：:][ \t]*|[ \t]+(?:[-—][ \t]+)?|(?=\n)))/i;

function parseReviewItems(text, label = '必改项') {
  const lines = String(text).split(/\r\n?|\n/);
  const indent = lines.reduce((min, line) => line.trim() ? Math.min(min, line.match(/^[ \t]*/)[0].length) : min, Infinity);
  const items = lines.map((line) => line.slice(indent)).join('\n')
    .split(/\n(?=\d+(?:\.(?!\d)|[、)）])|-[ \t])/).map((item) => item.trim()).filter(Boolean);
  const incomplete = [];
  const missingGrade = [];
  const grades = { p0: 0, p1: 0, p2: 0 };
  const parsed = [];
  items.forEach((item, idx) => {
    const headline = item.split('\n')[0].trim();
    const short = headline.length > 80 ? `${headline.slice(0, 80)}…` : headline;
    const fields = new Set();
    for (const [, field, content] of item.replace(/[*_]/g, '').matchAll(/(入口|证据)[：:]([\s\S]*?)(?=(?:入口|证据)[：:]|$)/g)) {
      if (content.replace(/[\s；;，,。、|｜\-—]+/g, '')) fields.add(field);
    }
    const missing = ['入口', '证据'].filter((field) => !fields.has(field)).map((field) => `${field}：`);
    if (missing.length) incomplete.push({ index: idx + 1, item: short, missing });
    const match = GRADE_PREFIX.exec(item);
    if (!match) {
      missingGrade.push({ index: idx + 1, item: short });
      return;
    }
    const grade = match.slice(3).find(Boolean).toLowerCase();
    grades[grade] += 1;
    const normalizedBody = `【${grade.toUpperCase()}】${item.slice(match[0].length)}`;
    const key = normalizedBody.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
    parsed.push({ index: idx + 1, item: short, grade, key, text: `${match[1] ?? ''}${normalizedBody}` });
  });
  if (!items.length || incomplete.length) {
    const detail = incomplete.map(({ index, item, missing }) => `第 ${index} 条（${item}）缺${missing.join('、')}`).join('；');
    throw new CliError('MUST_FIX_INCOMPLETE', `${label}的每条必须同时包含「入口：」和「证据：」${detail ? `：${detail}` : ''}`, { incomplete });
  }
  if (missingGrade.length) {
    const detail = missingGrade.map(({ index, item }) => `第 ${index} 条（${item}）`).join('；');
    throw new CliError('MUST_FIX_GRADE_MISSING', `${label}的每条必须以【P0】、【P1】或【P2】开头：${detail}`, { missingGrade });
  }
  return { text: parsed.map((entry) => entry.text).join('\n'), grades, items: parsed };
}

export function publishVerdict(run, runPath, dispatch) {
  if (!dispatch.commentId) {
    const { pr, verdict, dispatchId } = dispatch;
    if (verdict.body === undefined) throw new CliError('REVIEW_BODY_UNAVAILABLE', '本机登记没有审计评论正文');
    dispatch.commentId = factsId(postReviewNote(runForgeContext(run), pr.repo, pr.id, verdict.body).id);
    appendReview(runPath, { type: 'published', dispatchId, commentId: dispatch.commentId });
  }
  return { ok: true, dispatchId: dispatch.dispatchId, commentId: dispatch.commentId };
}

function republishVerdict(ctx, flags) {
  const dispatchId = required(flags, 'dispatch-id');
  return withReviewRun(ctx, flags, (runPath, run, pr) => {
    const dispatch = reviewsFor(readReviews(runPath), pr).find((row) => row.dispatchId === dispatchId);
    if (!dispatch?.verdict) throw new CliError('REVIEW_DISPATCH_MISMATCH', '本机没有可补发的结论');
    if (!dispatch.commentId) assertChangeMembership(run, reviewLive(ctx, pr));
    return publishVerdict(run, runPath, dispatch);
  });
}

function changeVerdict(ctx, flags) {
  if (flags.republish === true) return republishVerdict(ctx, flags);
  const round = Number(required(flags, 'round'));
  const conclusion = required(flags, 'conclusion');
  const risk = verdictRisk(required(flags, 'risk'));
  const headSha = reviewHead(flags);
  const session = reviewSession(flags);
  const slot = optional(flags, 'slot', '主研发');
  if (!/^[1-9]\d*$/.test(flags.round) || !Number.isSafeInteger(round)) throw new CliError('INVALID_REVIEW_ROUND', '--round 必须是正整数');
  if (!['通过', '打回'].includes(conclusion)) throw new CliError('INVALID_CONCLUSION', '--conclusion 必须是「通过」或「打回」');
  if (/[\r\n｜|]/.test(slot)) throw new CliError('INVALID_SLOT', '--slot 不能含换行或分隔符');
  const dispatchId = required(flags, 'dispatch-id');
  const nonce = required(flags, 'nonce');
  const reviewText = (key, needed = false) => !needed && flags[key] === undefined ? '无'
    : required(flags, key).replace(/<!--(?=\s*liteloop:verdict\b)/g, '&lt;!--').replaceAll(nonce, '[已隐藏]');
  const rawMustFix = reviewText('must-fix', conclusion === '打回');
  if (conclusion === '通过' && rawMustFix.trim() !== '无') {
    throw new CliError('PASS_WITH_MUST_FIX', '结论为「通过」时 --must-fix 只能省略或填「无」；P2 遗留建议请放进 --remaining，有 P0/P1 请改为「打回」');
  }
  const mustFixParsed = conclusion === '打回' ? parseReviewItems(rawMustFix, '必改项') : null;
  const mustFix = mustFixParsed ? mustFixParsed.text : '无';
  const rawRemaining = reviewText('remaining');
  const remainingParsed = rawRemaining.trim() === '无' ? null : parseReviewItems(rawRemaining, '遗留建议');
  if (remainingParsed && (remainingParsed.grades.p0 > 0 || remainingParsed.grades.p1 > 0)) {
    const high = remainingParsed.items.filter(({ grade }) => grade !== 'p2');
    const detail = high.map(({ index, item }) => `第 ${index} 条（${item}）`).join('；');
    throw new CliError('REMAINING_GRADE_TOO_HIGH', `遗留建议仅允许 P2，P0/P1 必须打回：${detail}`, {
      items: high.map(({ index, item, grade }) => ({ index, item, grade: grade.toUpperCase() })),
    });
  }
  if (mustFixParsed && remainingParsed) {
    const mustFixKeys = new Set(mustFixParsed.items.map(({ key }) => key));
    const duplicates = remainingParsed.items.filter(({ key }) => mustFixKeys.has(key));
    if (duplicates.length) {
      const detail = duplicates.map(({ index, item }) => `第 ${index} 条（${item}）`).join('；');
      throw new CliError('DUPLICATE_REVIEW_ITEM', `同一条目不能同时出现在必改项和遗留建议中，请只保留一处：${detail}`, {
        items: duplicates.map(({ index, item }) => ({ index, item })),
      });
    }
  }
  const remaining = remainingParsed ? remainingParsed.text : '无';
  const grades = {
    p0: (mustFixParsed?.grades.p0 ?? 0) + (remainingParsed?.grades.p0 ?? 0),
    p1: (mustFixParsed?.grades.p1 ?? 0) + (remainingParsed?.grades.p1 ?? 0),
    p2: (mustFixParsed?.grades.p2 ?? 0) + (remainingParsed?.grades.p2 ?? 0),
  };
  const body = [
    `终审 ｜ ${slot} ｜ ${session}`,
    `结论：${conclusion}（第 ${round} 轮）`,
    `问题分级：P0 ${grades.p0} · P1 ${grades.p1} · P2 ${grades.p2}`,
    '必改项：', mustFix,
    '遗留建议：', remaining,
    '不要改动的范围：', reviewText('keep'),
    `风险：${Object.values(risk).some(Boolean) ? '高' : '低'}`,
    ...RISK_RULES.map(({ key, label }, index) => `${index + 1}. ${label}：${risk[key] ? '是' : '否'}`),
    '', `<!-- liteloop:verdict ${JSON.stringify({ dispatchId, round, conclusion, risk, grades, headSha, session })} -->`,
  ].join('\n');
  return withReviewRun(ctx, flags, (runPath, run, pr) => {
    const history = reviewsFor(readReviews(runPath), pr);
    const dispatch = history.at(-1);
    if (!dispatch || dispatch.dispatchId !== dispatchId || dispatch.nonce !== nonce
      || dispatch.headSha !== headSha || dispatch.round !== round || dispatch.session !== session) {
      throw new CliError('REVIEW_DISPATCH_MISMATCH', '结论与本机当前派审登记不一致');
    }
    if (dispatch.verdict) throw new CliError('REVIEW_ALREADY_RECORDED', '同一派审只能登记一次结论');
    const live = reviewLive(ctx, pr);
    assertReviewCandidate(live, headSha);
    if (memberLabelConflict(live.labels) || !live.labels.includes(demandLabel(run.req))) assertChangeMembership(run, live);
    if (!live.labels.includes('终审中') || live.labels.includes('待终审')) {
      throw new CliError('REVIEW_NOT_ACTIVE', '变更单没有可登记结论的当前派审，请核对终审状态');
    }
    const member = !changeMembership(run, live);
    if (mustFixParsed?.grades.p2 > 0) {
      const fuseCount = run.thresholds?.rejectFuseCount ?? 2;
      const priorRejects = Array.isArray(dispatch.rejectDispatchIds)
        ? dispatch.rejectDispatchIds.length
        : resolveReviewState(history, [], headSha).rejectCount;
      if (priorRejects >= fuseCount) {
        const p2Items = mustFixParsed.items.filter(({ grade }) => grade === 'p2');
        const detail = p2Items.map(({ index, item }) => `第 ${index} 条（${item}）`).join('；');
        throw new CliError('MUST_FIX_P2_AFTER_FUSE',
          `已累计打回 ${priorRejects} 次（达到熔断阈值 ${fuseCount}），熔断后必改项不能包含 P2，请改写到 --remaining（只剩 P2 时请给「通过」）：${detail}`,
          { rejectCount: priorRejects, rejectFuseCount: fuseCount, items: p2Items.map(({ index, item }) => ({ index, item })) });
      }
    }
    dispatch.verdict = { type: 'verdict', dispatchId, conclusion, risk, grades, body };
    appendReview(runPath, dispatch.verdict);
    const publication = { auditPending: !member };
    if (member) {
      try {
        Object.assign(publication, publishVerdict(run, runPath, dispatch));
      } catch (error) {
        Object.assign(publication, { auditPending: true, auditError: error.message });
      }
    }
    let notes = [];
    if (member) {
      try { notes = readComments(ctx, commentsEndpoint(ctx, 'change', pr.repo, pr.id)); } catch { /* Use the last known rejection count. */ }
    }
    const { rejectCount } = resolveReviewState(history, notes, headSha);
    if (conclusion === '打回') {
      const result = { ok: true, dispatchId, conclusion, grades, state: 'rejected', code: 'REVIEW_REJECTED', rejectCount, ...publication };
      if (member) applyVerdictLabels(ctx, pr, live, result);
      else result.message = '变更目标已离开需求基线，请人工处理打回结论。';
      return result;
    }
    const result = mergeReviewedChange(ctx, runPath, run, dispatch, rejectCount, { live });
    return { ...result, ok: true, dispatchId, conclusion, grades, rejectCount, ...publication };
  });
}

function recordAcceptance(flags) {
  const runPath = required(flags, 'run');
  if (!runPath.endsWith('.json')) throw new CliError('INVALID_RUN', '--run 必须指向需求运行态 JSON');
  if (flags['dry-run']) throw new CliError('ACCEPTANCE_DRY_RUN_UNSUPPORTED', '验收结论须发布至主台账');
  if (flags.forge !== undefined || flags.hostname !== undefined) throw new CliError('UNSUPPORTED_FLAG', '验收使用运行态的 Forge，不能传 --forge 或 --hostname');
  const conclusion = required(flags, 'conclusion');
  if (!['通过', '不通过'].includes(conclusion)) {
    throw new CliError('INVALID_CONCLUSION', '--conclusion 必须是「通过」或「不通过」');
  }
  const report = required(flags, 'report');
  const model = required(flags, 'model').trim();
  const session = reviewSession(flags);
  return withFileLock(tickLockPath(runPath), () => {
    const { run } = loadRunOptional(flags);
    const coder = matchingDeveloperModel(run, model);
    if (coder) {
      throw new CliError('SAME_MODEL_AS_CODER', `验收模型 ${model} 与开发模型 ${coder} 相同，必须使用不同模型`, { model, coder });
    }
    const key = primaryLedgerKey(run.tier);
    const ledger = boundLedger(run, key);
    if (!ledger) throw new CliError('LEDGER_NOT_BOUND', '运行态未登记主台账');
    const { repo } = ledger;
    const id = factsId(ledger.id);
    const record = { conclusion, model, session, at: new Date().toISOString(), baselineSha: readAcceptanceBaseline(run) };
    const safeReport = report.replace(/<!--(?=\s*liteloop:acceptance\b)/g, '&lt;!--');
    const body = [
      `验收者 ｜ 主研发 ｜ ${session}`,
      `【出口验收】结论：${conclusion}`,
      `验收模型：${model}`,
      `验收报告：${safeReport}`,
      '',
      `<!-- liteloop:acceptance ${JSON.stringify(record)} -->`,
    ].join('\n');
    const commentId = factsId(postComment(runForgeContext(run), 'issue', repo, id, body).id);
    return { ok: true, req: run.req, ledger: { key, repo, id }, commentId, ...record, report };
  });
}

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


function loadRunOptional(flags) {
  const runPath = flags.run === undefined ? null : required(flags, 'run');
  if (!runPath) return { runPath: null, run: null };
  try {
    return { runPath, run: JSON.parse(fs.readFileSync(runPath, 'utf8')) };
  } catch (err) {
    throw new CliError('INVALID_RUN', `无法读取 --run：${err.message}`);
  }
}

function createMember(ctx, flags, create, isChange = false) {
  if (flags.req === undefined) return simple(ctx, create(ctx, flags));
  const req = required(flags, 'req');
  const runPath = runFile(configPath(optional(flags, 'config-dir')), req);
  if (flags.run !== undefined && path.resolve(required(flags, 'run')) !== runPath) {
    throw new CliError('RUN_REQ_MISMATCH', '--run 与 --req 指向不同的运行态');
  }
  const createRegistered = () => {
    const { run } = loadRunOptional({ run: runPath });
    if (run.req !== req) throw new CliError('RUN_REQ_MISMATCH', '--req 与运行态需求名称不一致');
    assertRunForge(ctx, run);
    const requestedRepo = required(flags, 'repo');
    const repo = String(findRunRepo(run, requestedRepo)?.repo ?? requestedRepo);
    if (!findRunRepo(run, repo) && repo !== String(run.hubRepo?.repo)) {
      throw new CliError('REPO_NOT_IN_RUN', '创建对象的仓库未登记在需求运行态');
    }
    const memberLabels = [...new Set([...splitList(flags.labels), demandLabel(req)])];
    if (memberLabelConflict(memberLabels)) throw new CliError('DEMAND_LABEL_CONFLICT', '不能创建带多个需求标签的对象');
    if (isChange) assertChangeMembership(run, { labels: memberLabels, target: required(flags, 'target') });
    const labels = memberLabels.join(',');
    const result = simple(ctx, create(ctx, { ...flags, labels, repo, run: runPath }));
    if (ctx.dryRun) return result;
    const url = result.json?.web_url ?? result.stdout.split(/\r?\n/).reverse().find((line) => URL.canParse(line.trim()))?.trim();
    const id = factsId(result.json?.iid ?? /\/(?:issues|pull)\/([1-9]\d*)\/?$/.exec(url ?? '')?.[1]);
    const key = isChange ? 'changes' : 'demandIssues';
    const entries = run[key] ?? [];
    if (!entries.some((item) => String(item?.repo ?? run.hubRepo?.repo).toLowerCase() === repo.toLowerCase()
      && String(item?.id ?? item).replace(/^#/, '') === String(id))) {
      run[key] = [...entries, { repo, id }];
      run.updatedAt = new Date().toISOString();
      writeAtomic(runPath, JSON.stringify(run, null, 2) + '\n');
    }
    return { ...result, member: { req, repo, id, url: url ?? null } };
  };
  return ctx.dryRun ? createRegistered() : withFileLock(tickLockPath(runPath), createRegistered);
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
  return validateBranchPatterns(patterns);
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
  if (!prodTrunks.has(source) && matchProtectedBranch(source, protectedBranches)) {
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

/**
 * @typedef {import('./lib/review-journal.mjs').ReviewDispatch} ReviewDispatch
 * @typedef {{flags: object, run?: object|null, dispatch?: ReviewDispatch, rejectCount?: number,
 *   snapshot?: {live?: object, issues?: MemberRef[]}}} MergeGateInput
 * @typedef {{state: 'merged', receipt: object}
 *   | {state: 'waiting'|'manual'|'invalidated', error: CliError}} MergeGateResult
 */

export function parseDepRef(token, defaultRepo, currentForge, kind = 'change') {
  const text = String(token).trim().replace(/[.;。；]+$/, '');
  const link = /^https?:\/\/([\w.:-]+)\/([\w.-]+(?:\/[\w.-]+)+?)\/(-\/issues|-\/merge_requests|issues|pull)\/([1-9]\d*)\/?(?:[?#][^\s]*)?$/i.exec(text);
  if (link) {
    const route = link[3].toLowerCase();
    if (route.endsWith('issues') !== (kind === 'issue')) return null;
    const forge = route.startsWith('-/') ? 'gitlab' : 'github';
    if (forge === 'github' && link[2].split('/').length !== 2) return null;
    return { forge, host: link[1].toLowerCase(), repo: link[2], id: Number(link[4]) };
  }
  const ref = (kind === 'issue' ? /^([\w.-]+(?:\/[\w.-]+)+)?#([1-9]\d*)$/ : /^([\w.-]+(?:\/[\w.-]+)+)?[!#]([1-9]\d*)$/).exec(text);
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
    if (!declaration) {
      invalid.push(line.trim());
      continue;
    }
    const value = declaration[1].trim();
    if (!value || /^(?:无|none)$/i.test(value)) continue;
    const tokens = value.split(/[\s,，]+/).filter(Boolean);
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

function changeRead(ctx, repo, id, extraFields = '') {
  if (ctx.forge === 'gitlab') return api(ctx, 'GET', `projects/${encodeProject(repo)}/merge_requests/${id}`);
  return gh(ctx, ['pr', 'view', String(id), '--repo', repo, '--json', `baseRefName,headRefName,headRefOid,body,state${extraFields}`]);
}

function changeFields(ctx, data) {
  if (ctx.forge === 'gitlab') {
    return { target: data.target_branch ?? null, source: data.source_branch ?? null, headSha: data.sha?.toLowerCase() ?? null, body: data.description ?? '', state: data.state ?? null };
  }
  return { target: data.baseRefName ?? null, source: data.headRefName ?? null, headSha: data.headRefOid?.toLowerCase() ?? null, body: data.body ?? '', state: data.state ?? null };
}

function readLiveChange(ctx, repo, id) {
  return changeFields(ctx, readJson(changeRead(ctx, repo, id)));
}

/* ------------------------------------------------------------------ */
/* RunFacts                                                              */
/* ------------------------------------------------------------------ */

function withForgeHost(ctx) {
  return { ...ctx, host: ctx.host ?? (ctx.forge === 'github' ? process.env.GH_HOST || 'github.com' : 'gitlab.com') };
}

function runForgeContext(run) {
  return withForgeHost(makeCtx({ forge: run.forge, hostname: forgeHostArgs(run)[1] }));
}

function readForgeBaseline(ctx, repo, branch) {
  if (!repo || !branch) throw new CliError('INVALID_FACT_REF', '运行态未登记基线仓库或分支');
  const encoded = encodeURIComponent(branch);
  const data = readJson(ctx.forge === 'gitlab'
    ? api(ctx, 'GET', `projects/${encodeProject(repo)}/repository/branches/${encoded}`)
    : gh(ctx, ['api', `repos/${repo}/branches/${encoded}`]));
  const sha = ctx.forge === 'gitlab' ? data.commit?.id : data.commit?.sha;
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) throw new CliError('INVALID_FORGE_FACT', 'Forge 未返回有效的基线分支 SHA');
  return sha.toLowerCase();
}

export function readAcceptanceBaseline(run) {
  return readForgeBaseline(runForgeContext(run), run.hubRepo?.repo ?? run.repos?.[0]?.repo, run.baselineBranch ?? run.branch);
}

export function forgeRecordUrl(run, { repo, id, kind = 'issue', url, commentId }) {
  if (!repo || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || !['github', 'gitlab'].includes(run?.forge)) return null;
  const { forge, host } = runForgeContext(run);
  const route = forge === 'gitlab' ? (kind === 'change' ? '-/merge_requests' : '-/issues') : (kind === 'change' ? 'pull' : 'issues');
  const base = url || `https://${host}/${repo}/${route}/${id}`;
  return commentId ? `${base.split('#')[0]}#${forge === 'gitlab' ? 'note_' : 'issuecomment-'}${commentId}` : base;
}

function assertRunForge(ctx, run) {
  const actual = withForgeHost(ctx);
  const expected = runForgeContext({ ...run, forge: run.forge ?? actual.forge });
  if (expected.forge !== actual.forge || expected.host.toLowerCase() !== actual.host.toLowerCase()) {
    throw new CliError('FORGE_NOT_IN_RUN', 'Forge 实例与需求记录不一致');
  }
}

function factsId(value) {
  const id = Number(/^[#!]?([1-9]\d*)$/.exec(String(value ?? '').trim())?.[1]);
  if (!Number.isSafeInteger(id)) {
    throw new CliError('INVALID_FACT_REF', 'Forge 事实引用缺少有效编号');
  }
  return id;
}

function issueState(data) {
  const state = normalizeState(data?.state);
  if (state === 'opened' || state === 'open') return 'open';
  if (state === 'closed') return state;
  throw new CliError('INVALID_FORGE_FACT', 'Forge 未返回有效的 Issue 状态');
}

export function readForgeIssueState(run, repo, id, { rejectConflictingLabels = false } = {}) {
  const ctx = runForgeContext(run);
  const issue = readJson(issueGet(ctx, { repo, id: factsId(id) })[0]);
  if (rejectConflictingLabels && memberLabelConflict(labelNames(issue.labels))) {
    throw new CliError('DEMAND_LABEL_CONFLICT', '本人台账有多个需求标签，请核对归属');
  }
  return issueState(issue);
}

export function readForgeIssueOwner(run, { repo, id }, session) {
  const ctx = runForgeContext(run);
  const issue = readJson(issueGet(ctx, { repo, id: factsId(id) })[0]);
  if (memberLabelConflict(labelNames(issue.labels))) {
    throw new CliError('DEMAND_LABEL_CONFLICT', '本人台账有多个需求标签，请核对归属');
  }
  return assertIssueOwner(issue.description ?? issue.body ?? '', session, repo, id);
}

function factMetadata(labels, updatedAt) {
  if (!Array.isArray(labels) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new CliError('INVALID_FORGE_FACT', 'Forge 未返回有效的标签列表或更新时间');
  }
  return { labels: labelNames(labels), updatedAt };
}

function commentsWithReplies(ctx, kind, repo, id) {
  const comments = readComments(ctx, commentsEndpoint(ctx, kind, repo, id));
  if (comments.some((comment) => !Number.isFinite(Date.parse(comment.createdAt)) || typeof comment.body !== 'string')) {
    throw new CliError('INVALID_FORGE_FACT', 'Forge 未返回有效的评论正文或创建时间');
  }
  comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  const fragment = ctx.forge === 'gitlab' ? 'note_' : 'issuecomment-';
  const hash = new RegExp('^#' + fragment + '([1-9]\\d*)$');
  const objectPath = ctx.forge === 'gitlab' ? (kind === 'issue' ? '-/issues' : '-/merge_requests')
    : (kind === 'issue' ? 'issues' : 'pull');
  const directPath = `/${repo}/${objectPath}/${id}`.toLowerCase();
  const replyLine = /^(?:已执行|不执行)(?=$|[\s:：｜|。！!？?])/;
  const replied = new Set();
  for (const comment of comments.slice().reverse()) {
    const raw = comment.body.trimStart();
    const text = raw.replace(/^[^\r\n]+[｜|][^\r\n]+[｜|][^\r\n]+\r?\n/, '').trimStart();
    comment.prefix = /^【([^】\r\n]+)】/.exec(text)?.[1] ?? null;
    comment.liteloopKey = /<!--\s*liteloop:key=([^\s>]+)\s*-->/.exec(comment.body)?.[1] ?? null;
    comment.replied = replied.has(String(comment.id));
    const explicitReply = /<!--\s*liteloop:reply-to=([1-9]\d*)\s*-->[ \t]*(?:\r?\n[ \t]*)*$/.exec(comment.body);
    if (explicitReply) {
      comment.replyTo = Number(explicitReply[1]);
      replied.add(explicitReply[1]);
    }
    const reply = replyLine.test(raw) ? raw : text;
    if (!replyLine.test(reply)) continue;
    for (const [link] of reply.matchAll(/https?:\/\/[^\s)）\]><"'，。；、!?！？，：｜|]+/gi)) {
      try {
        const url = new URL(link);
        if (url.host.toLowerCase() !== ctx.host.toLowerCase() || decodeURIComponent(url.pathname).toLowerCase() !== directPath) continue;
        const commentId = hash.exec(url.hash)?.[1];
        if (commentId) replied.add(commentId);
      } catch {
        // Malformed URLs are ordinary prose, not a direct reply.
      }
    }
  }
  return comments;
}

function ledgerFields(body) {
  const section = ledgerSection(body, 1);
  const owners = extractLedgerOwners(body);
  const match = /(?:^|[｜|])\s*本轮[：:]\s*(执行中|空闲|暂停)(?:\s*[（(]\s*开始\s*[：:]?\s*([^）)\r\n]+)[）)])?/m.exec(section);
  const paused = /(?:^|[｜|])\s*状态[：:]\s*暂停(?=[\s（(｜|]|$)/m.test(section);
  const round = paused ? '暂停' : match?.[1] ?? null;
  return { owner: owners.length === 1 ? owners[0] : null, round, roundStartedAt: round === '执行中' ? match?.[2]?.trim() ?? null : null };
}

function readFactIssue(ctx, repo, id, { includeAuthor = false } = {}) {
  const fields = ',updatedAt,createdAt,assignees' + (includeAuthor ? ',author' : '');
  const data = readJson(issueGet(ctx, { repo, id }, fields)[0]);
  const state = issueState(data);
  const body = data.description ?? data.body ?? '';
  const author = ctx.forge === 'gitlab' ? data.author?.username : data.author?.login;
  if (typeof body !== 'string') throw new CliError('INVALID_FORGE_FACT', 'Forge 未返回有效的 Issue 正文');
  return {
    state,
    ...factMetadata(data.labels, data.updated_at ?? data.updatedAt),
    body,
    title: data.title ?? null,
    url: data.web_url ?? data.url ?? null,
    createdAt: data.created_at ?? data.createdAt ?? null,
    ...(includeAuthor ? { author } : {}),
    assignee: (ctx.forge === 'gitlab' ? data.assignees?.[0]?.username ?? data.assignee?.username : data.assignees?.[0]?.login) ?? null,
  };
}

function ledgerChangeRefs(ctx, body, repo, key) {
  const section = ledgerSection(body, key === 'master' ? 1 : 3);
  const refs = section.match(/https?:\/\/[^\s|｜<>()\]]+|(?:[\w.-]+(?:\/[\w.-]+)+)?![1-9]\d*\b/g) ?? [];
  return refs.map((ref) => parseDepRef(ref, repo, ctx.forge))
    .filter((ref) => ref?.forge === ctx.forge && (!ref.host || ref.host === ctx.host.toLowerCase()));
}

function issueRefsInField(ctx, field, repo) {
  const local = field.replace(/https?:\/\/[^\s\])>]+/g, (link) => {
    const host = /^https?:\/\/([^/]+)/.exec(link)?.[1];
    if (host?.toLowerCase() !== ctx.host.toLowerCase()) return '';
    return ctx.forge === 'gitlab' ? link.replace('/-/issues/', '/issues/') : link;
  });
  return extractDemandIssueRefs(local, repo);
}

function masterSlotLedgers(ctx, body, repo) {
  return ledgerSection(body, 3).split(/\r?\n/).flatMap((row) => {
    const columns = /^\s*\|(.*)\|\s*$/.exec(row)?.[1].split('|');
    if (columns?.length !== 5) return [];
    return issueRefsInField(ctx, columns[4], repo).map((ref) => ({
      ...ref, slot: columns[0].trim(), user: columns[1].trim(),
    }));
  });
}

export function readSlotClaimFacts(run, masterLink, { viewer = false } = {}) {
  let ctx, repo, id;
  if (run) {
    ctx = runForgeContext(run);
    const ledger = run.ledgers?.find((item) => item.key === 'master');
    const bound = run.issues?.master ?? ledger?.issue ?? ledger;
    repo = bound?.repo ?? ledger?.repo ?? run.hubRepo?.repo;
    const rawId = bound?.id ?? bound;
    if (!repo || !rawId) throw new CliError('LEDGER_NOT_BOUND', '运行态未绑定 L3 总台账');
    id = factsId(rawId);
  } else {
    let url;
    try { url = new URL(masterLink); } catch {
      throw new CliError('INVALID_MASTER_URL', '--master 需要 GitHub/GitLab 总台账 Issue 的完整链接');
    }
    const gitlab = /^\/([\w.-]+(?:\/[\w.-]+)+)\/-\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    const github = /^\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    const match = gitlab ?? github;
    if (!match || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new CliError('INVALID_MASTER_URL', '--master 需要 GitHub/GitLab 总台账 Issue 的完整链接');
    }
    ctx = runForgeContext({ forge: gitlab ? 'gitlab' : 'github', hostname: url.host });
    repo = match[1];
    id = factsId(match[2]);
  }
  const issue = readJson(issueGet(ctx, { repo, id })[0]);
  const facts = slotClaimFacts(ctx, { repo, id, body: issue.body ?? issue.description ?? '',
    url: issue.web_url ?? issue.url, comments: commentsWithReplies(ctx, 'issue', repo, id) });
  if (!viewer) return facts;
  const account = readJson(ctx.forge === 'gitlab' ? api(ctx, 'GET', 'user') : gh(ctx, ['api', 'user']));
  const username = ctx.forge === 'gitlab' ? account.username : account.login;
  if (typeof username !== 'string' || !username.trim()) throw new CliError('FORGE_USER_UNKNOWN', '无法核实当前 Forge 用户名');
  return { ...facts, username };

}

function slotClaimFacts(ctx, { repo, id, body, url, comments }) {
  const gitlab = ctx.forge === 'gitlab';
  return {
    comments, slotLedgers: masterSlotLedgers(ctx, body, repo),
    url: url ?? `https://${ctx.host}/${repo}/${gitlab ? '-/issues' : 'issues'}/${id}`,
    fragment: gitlab ? 'note_' : 'issuecomment-',
  };
}

export function registeredDemandIssues(run) {
  return [run.issues?.subIssues, run.issues?.demandIssues, run.demandIssues].flatMap((group) =>
    group == null ? [] : Array.isArray(group) ? group : typeof group === 'object' && group.id == null ? Object.values(group) : [group]);
}

/**
 * @typedef {{kind: 'issue'|'change', repo: string, id: number, code: string, message: string, state?: string, slot?: string}} MembershipWarning
 * @typedef {{repo: string, id: number, key?: string, user?: string}} MemberRef
 */
/** Run 注册对象只提供引用。状态、正文、标签、评论与变更单头部均从 Forge 读取。 */
export function collectRunFacts(run, { includeBaselines = false, localLedgerKey = null, issuesOnly = false, skipChangeComments = () => false } = {}) {
  const facts = {
    req: run.req, tier: run.tier, collectedAt: new Date().toISOString(), ledgers: [], changes: [], subIssues: [],
    errors: [], warnings: /** @type {MembershipWarning[]} */ ([]), slotClaims: [],
  };
  if (includeBaselines) facts.baselines = [];
  const attempt = (source, read) => {
    try {
      return read();
    } catch (err) {
      facts.errors.push(factFailure(source, err));
      return null;
    }
  };
  const ctx = attempt('forge', () => runForgeContext(run));
  if (!ctx) return facts;
  const hub = run.hubRepo?.repo;
  const ledgers = /** @type {Map<string, MemberRef>} */ (new Map());
  const subIssues = new Map();
  const changes = new Map();
  const register = (map, source, repo, rawId, key, user) => attempt(source, () => {
    if (!repo) throw new CliError('INVALID_FACT_REF', 'Forge 事实引用缺少仓库');
    const id = factsId(rawId);
    const ref = String(repo).toLowerCase() + '#' + id;
    if (!map.has(ref)) map.set(ref, { repo: String(repo), id, ...(key ? { key } : {}), ...(user ? { user } : {}) });
  });
  const issueMap = run.issues ?? {};
  for (const ledger of run.ledgers ?? []) {
    if (localLedgerKey && ledger.key !== localLedgerKey && ledger.key !== 'master') continue;
    const issue = ledger.issue ?? issueMap[ledger.key] ?? ledger;
    const id = issue.id ?? (typeof issue === 'object' ? null : issue);
    if (id != null) register(ledgers, 'ledger:' + ledger.key, ledger.repo ?? issue.repo ?? hub, id, ledger.key);
  }
  for (const [key, issue] of Object.entries(issueMap)) {
    if (!issue) continue;
    if (/^(?:tracking|main|master|escalation|slot:.+)$/.test(key)) {
      if (localLedgerKey && key !== localLedgerKey && key !== 'master') continue;
      register(ledgers, 'ledger:' + key, issue.repo ?? hub, issue.id ?? issue, key);
    } else if (!['subIssues', 'demandIssues'].includes(key)) {
      register(subIssues, 'sub-issue:' + key, issue.repo ?? hub, issue.id ?? issue);
    }
  }
  const memberLabel = run.req ? demandLabel(run.req) : null;
  const localSlotLabel = localLedgerKey && `槽位${localLedgerKey.slice(5)}`;
  const taggedIssues = new Map();
  const taggedSlotLedgers = new Map();
  const warnings = new Map();
  const warn = (kind, ref, code, message, state, slot) => {
    const { repo, id } = ref;
    warnings.set(`${kind}:${repo.toLowerCase()}#${id}:${code}`, {
      kind, repo, id, code, message, ...(state ? { state: normalizeState(state).replace(/^opened$/, 'open') } : {}), ...(slot ? { slot } : {}),
    });
  };
  const conflicting = (kind, ref, labels, state) => {
    if (!memberLabelConflict(labels)) return false;
    if (!localSlotLabel || !labels.some((label) => label.startsWith('槽位')) || labels.includes(localSlotLabel)) {
      warn(kind, ref, 'DEMAND_LABEL_CONFLICT', '对象带有多个需求标签，请核实归属', state);
    }
    return true;
  };
  const ledgerRef = ({ repo, id }) => `${repo.toLowerCase()}#${id}`;
  const refsFromLedgers = new Set();
  const localIssueRefs = new Set();
  const readLedger = (ref) => {
    const { key, repo, id } = ref;
    const source = 'ledger:' + ledgerRef(ref);
    const issue = attempt(source, () => readFactIssue(ctx, repo, id, { includeAuthor: key === 'master' }));
    if (!issue || conflicting('issue', ref, issue.labels, issue.state)) return null;
    const { state, body, updatedAt } = issue;
    const comments = issuesOnly && key !== 'master' ? [] : attempt(source + ':comments', () => commentsWithReplies(ctx, 'issue', repo, id));
    if (!comments) return null;
    const current = /(?:^|[｜|])\s*当前 Issue[：:]\s*([^｜|\r\n]+)/m.exec(ledgerSection(body, 1));
    if (key !== 'escalation') {
      for (const listed of issueRefsInField(ctx, body, repo)) {
        refsFromLedgers.add(ledgerRef(listed));
        if (key === localLedgerKey) localIssueRefs.add(ledgerRef(listed));
      }
    }
    const values = {
      state, body, updatedAt, ...(issue.createdAt ? { createdAt: issue.createdAt } : {}),
      title: issue.title, ...ledgerFields(body), comments,
      currentIssues: current ? issueRefsInField(ctx, current[1], repo) : [],
      changeRefs: ledgerChangeRefs(ctx, body, repo, key),
    };
    if (!localLedgerKey || key === localLedgerKey) facts.ledgers.push({ key, repo, id, ...values });
    return { repo, id, body, url: issue.url, author: issue.author, comments };
  };
  const master = [...ledgers.values()].find(({ key }) => key === 'master');
  const masterLive = master && readLedger(master);
  const masterFacts = masterLive ? slotClaimFacts(ctx, masterLive) : null;
  const claims = masterFacts ? forgeSlotClaims(masterFacts) : [];
  const slotWinners = new Map([...new Set(claims.map(({ slot }) => slot))].flatMap((slot) => {
    const winner = activeSlotClaims(claims, slot)[0];
    return winner ? [[slot, winner]] : [];
  }));
  if (masterLive && run.tier === 'L3') {
    const leadUser = masterLive.author ?? (dispatchSlot(run) === '主研发' ? run.user : null);
    if (leadUser) slotWinners.set('主研发', { slot: '主研发', user: leadUser });
  }
  facts.slotClaims = [...slotWinners.values()];

  if (memberLabel) {
    const repos = new Set([hub, ...(run.repos ?? []).map(({ repo }) => repo)].filter(Boolean).map(String));
    for (const repo of repos) {
      const github = ctx.forge === 'github';
      const project = github ? `repos/${repo}` : `projects/${encodeProject(repo)}`;
      const filters = { ...(github ? { state: 'all' } : { scope: 'all' }), labels: memberLabel };
      attempt(`issue-list:${repo}`, () => {
        for (const row of readPages(ctx, `${project}/issues`, filters)) {
          const labels = labelNames(row.labels);
          if (!labels.includes(memberLabel)) continue;
          const id = factsId(github ? row.number : row.iid);
          const ref = { repo, id };
          if (conflicting(github && row.pull_request ? 'change' : 'issue', ref, labels, row.state)) continue;
          if (github && row.pull_request) {
            register(changes, `change-list:${repo}`, repo, id);
            continue;
          }
          const slot = run.tier === 'L3' && labels.filter((label) => label.startsWith('槽位'))
            .map(slotKey).find((name) => row.title?.startsWith(`【小台账】${name}-`));
          if (slot) {
            taggedSlotLedgers.set(ledgerRef(ref), { ...ref, key: 'slot:' + slot, state: row.state });
          } else {
            taggedIssues.set(ledgerRef(ref), ref);
          }
        }
      });
      if (!github) attempt(`change-list:${repo}`, () => {
        for (const row of readPages(ctx, `${project}/merge_requests`, filters)) {
          const labels = labelNames(row.labels);
          if (!labels.includes(memberLabel)) continue;
          const id = factsId(row.iid);
          if (!conflicting('change', { repo, id }, labels)) register(changes, `change-list:${repo}`, repo, id);
        }
      });
    }
  }
  for (const [ref, ledger] of taggedSlotLedgers) {
    if (localLedgerKey && ledger.key !== localLedgerKey) continue;
    if (ledgers.has(ref)) continue;
    const slot = ledger.key.slice(5);
    const winner = slotWinners.get(slot);
    if (!winner) {
      warn('issue', ledger, 'UNCLAIMED_SLOT_LEDGER', `槽位 ${slot} 未认领，请核对小台账`, ledger.state, slot);
      continue;
    }
    const listed = masterFacts.slotLedgers.some((row) => slotKey(row.slot) === slot && ledgerRef(row) === ref);
    if (!listed || !winner.user) {
      warn('issue', ledger, 'UNVERIFIED_SLOT_LEDGER', `槽位 ${slot} 的小台账与总台账或认领人不一致`, ledger.state, slot);
      continue;
    }
    const existing = [...ledgers.values()].find(({ key }) => key === ledger.key);
    if (existing) {
      warn('issue', ledger, 'DUPLICATE_SLOT_LEDGER', `槽位 ${slot} 有多份小台账，请核实归属`, ledger.state, slot);
      continue;
    }
    ledgers.set(ref, ledger);
  }
  for (const ledger of ledgers.values()) {
    if (ledger === master || (localLedgerKey && ledger.key !== localLedgerKey)) continue;
    const slot = ledger.key.startsWith('slot:') ? ledger.key.slice(5) : null;
    if (slot && slot !== '主研发' && !slotWinners.has(slot)) {
      const issue = attempt('ledger:' + ledgerRef(ledger), () => readFactIssue(ctx, ledger.repo, ledger.id));
      if (issue) {
        if (master && !masterLive) warn('issue', ledger, 'UNVERIFIED_SLOT_LEDGER', `无法从总台账核实槽位 ${slot} 的绑定`, issue.state, slot);
        else warn('issue', ledger, 'UNCLAIMED_SLOT_LEDGER', `槽位 ${slot} 未认领，请核对小台账`, issue.state, slot);
      }
      continue;
    }
    readLedger(ledger);
  }
  const baseline = run.baselineBranch ?? run.branch;
  if (includeBaselines && baseline) {
    const repos = run.repos?.length ? run.repos : [run.hubRepo];
    for (const repo of new Set(repos.map((entry) => entry?.repo).filter(Boolean))) {
      const sha = attempt('baseline:' + repo + ':' + baseline, () => readForgeBaseline(ctx, repo, baseline));
      facts.baselines.push({ repo, branch: baseline, sha });
    }
  }
  for (const issue of registeredDemandIssues(run)) register(subIssues, 'sub-issue:' + (issue?.id ?? issue), issue?.repo ?? hub, issue?.id ?? issue);
  const registeredIssueRefs = new Set(subIssues.keys());
  for (const [ref, issue] of taggedIssues) {
    if (refsFromLedgers.has(ref) && !subIssues.has(ref)) subIssues.set(ref, issue);
  }
  const localLedger = facts.ledgers.find(({ key }) => key === localLedgerKey);
  for (const [ref, { repo, id }] of subIssues) {
    if (ledgers.has(ref) || taggedSlotLedgers.has(ref) || (ctx.forge === 'github' && changes.has(ref))) continue;
    const issue = attempt('sub-issue:' + ref, () => readFactIssue(ctx, repo, id));
    if (!issue || conflicting('issue', { repo, id }, issue.labels, issue.state)) continue;
    if (!registeredIssueRefs.has(ref) && !issue.labels.includes(memberLabel)) continue;
    if (localLedgerKey && !(localIssueRefs.has(ref) || (run.user && issue.assignee === run.user) || issue.labels.includes(localSlotLabel))) continue;
    const comments = issuesOnly ? [] : attempt('sub-issue:' + ref + ':comments', () => commentsWithReplies(ctx, 'issue', repo, id));
    if (comments) facts.subIssues.push({ repo, id, ...issue, comments });
  }

  for (const [ref, { repo, id }] of issuesOnly ? [] : changes) {
    const source = 'change:' + ref;
    const change = attempt(source, () => {
      const data = readJson(changeRead(ctx, repo, id, ',labels,updatedAt,createdAt,author,isDraft,mergedAt,mergedBy,mergeCommit,mergeable,url,title'));
      const fields = changeFields(ctx, data);
      const rawState = normalizeState(fields.state);
      const state = rawState === 'opened' ? 'open' : rawState;
      if (!['open', 'closed', 'merged', 'locked'].includes(state) || !fields.headSha || !fields.source || !fields.target) {
        throw new CliError('INVALID_FORGE_FACT', 'Forge 未返回有效的变更单状态、分支或 head SHA');
      }
      const deps = state !== 'closed' ? parseDependsOnFromBody(fields.body, repo, ctx.forge) : { deps: [], invalid: [] };
      let dependencyError;
      try {
        if (state === 'open') validateDependencies(ctx, deps);
      } catch (error) {
        dependencyError = { code: error.code, message: error.message };
      }
      const dependsOn = dependencyError ? [] : uniqueDeps(deps.deps).map(({ forge, host, repo, id }) => ({ forge, host, repo, id }));
      return {
        state, headSha: fields.headSha, source: fields.source, target: fields.target, body: fields.body,
        author: (ctx.forge === 'gitlab' ? data.author?.username : data.author?.login) ?? null,
        mergedBy: (ctx.forge === 'gitlab' ? (data.merge_user ?? data.merged_by)?.username : data.mergedBy?.login) ?? null,
        createdAt: data.created_at ?? data.createdAt ?? null,
        mergedAt: data.merged_at ?? data.mergedAt ?? null,
        draft: data.draft === true || data.work_in_progress === true || data.isDraft === true,
        url: data.web_url ?? data.url ?? null,
        ...factMetadata(data.labels, data.updated_at ?? data.updatedAt), dependsOn,
        ...(dependencyError ? { dependencyError } : {}),
        issueRefs: issueRefsInField(ctx, fields.body, repo),
        title: data.title ?? null,
        mergeSha: data.merge_commit_sha ?? data.mergeCommit?.oid ?? null,
        conflict: ctx.forge === 'gitlab' ? data.has_conflicts === true : data.mergeable === 'CONFLICTING',
      };
    });
    if (!change) continue;
    if (localLedgerKey && !scopedChanges(localLedger, facts.subIssues, [{ repo, id, ...change }]).length) continue;
    if (conflicting('change', { repo, id }, change.labels, change.state)) continue;
    if (changeMembership(run, change)) {
      if (change.labels.includes(memberLabel) && change.target !== baseline && ['open', 'locked'].includes(change.state)) {
        warn('change', { repo, id }, 'CHANGE_WRONG_TARGET', `变更单 #${id} 的目标分支为 ${change.target}，请改为需求基线 ${baseline}`, change.state);
      }
      continue;
    }
    const item = { repo, id, ...change };
    const comments = skipChangeComments(item) ? [] : attempt(source + ':comments', () => commentsWithReplies(ctx, 'change', repo, id));
    if (comments) facts.changes.push({ ...item, comments });
  }
  facts.warnings = [...warnings.values()];
  return facts;
}

export function readLinkedOwnership(run, master) {
  const field = /^\s*文件归属表(?:[ \t]*[：:]|[ \t]*→)[ \t]*(.+)$/m.exec(ledgerSection(master.body, 4))?.[1];
  if (!field) return '';
  const ctx = runForgeContext(run);
  const linked = issueRefsInField(ctx, field, master.repo).find((ref) => ref.repo !== master.repo.toLowerCase() || Number(ref.id) !== master.id);
  if (linked) return readFactIssue(ctx, linked.repo, linked.id).body;
  const link = field.match(/https?:\/\/[^\s)\]>]+/)?.[0];
  if (!link) return '';
  const url = new URL(link);
  if (url.host.toLowerCase() !== ctx.host.toLowerCase()) return '';
  const parts = /^\/(.+?)\/(?:-\/)?blob\/(.+)$/.exec(decodeURIComponent(url.pathname));
  if (!parts) return '';
  const [, repo, remainder] = parts;
  const registered = (run.repos ?? []).find((entry) => String(entry.repo).toLowerCase() === repo.toLowerCase());
  const refs = [run.baselineBranch, registered?.branch].filter(Boolean).sort((a, b) => b.length - a.length);
  const ref = refs.find((branch) => remainder.startsWith(branch + '/')) ?? remainder.split('/', 1)[0];
  const file = remainder.slice(ref.length + 1);
  if (!file) return '';
  if (ctx.forge === 'gitlab') {
    return runProcess(api(ctx, 'GET', `projects/${encodeProject(repo)}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`));
  }
  const location = file.split('/').map(encodeURIComponent).join('/');
  return runProcess(gh(ctx, ['api', '--header', 'Accept: application/vnd.github.raw+json',
    `repos/${repo}/contents/${location}?ref=${encodeURIComponent(ref)}`]));
}

export function readChangeLabelEvents(run, change) {
  const ctx = runForgeContext(run);
  const endpoint = ctx.forge === 'gitlab'
    ? `projects/${encodeProject(change.repo)}/merge_requests/${change.id}/resource_label_events`
    : `repos/${change.repo}/issues/${change.id}/events`;
  return [...readPages(ctx, endpoint)].flatMap((row) => {
    const action = row.action ?? { labeled: 'add', unlabeled: 'remove' }[row.event];
    if (!action || !row.label?.name) return [];
    if (!Number.isFinite(Date.parse(row.created_at))) throw new CliError('INVALID_FORGE_FACT', 'Forge 标签事件缺少时间');
    return [{ action, label: row.label.name, at: row.created_at, id: row.id }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
}

export function readChangeFiles(run, change) {
  const ctx = runForgeContext(run);
  const gitlab = ctx.forge === 'gitlab';
  const endpoint = gitlab
    ? `projects/${encodeProject(change.repo)}/merge_requests/${change.id}/diffs`
    : `repos/${change.repo}/pulls/${change.id}/files`;
  const rows = [...readPages(ctx, endpoint)];
  if (!gitlab && rows.length >= 3000) throw new CliError('INCOMPLETE_DIFF', 'PR 文件列表达到 GitHub 3000 文件上限');
  if (readLiveChange(ctx, change.repo, change.id).headSha !== change.headSha) {
    throw new CliError('HEAD_SHA_MISMATCH', '读取文件差异时 head SHA 已变化，下轮重新读取');
  }
  return rows.map((row) => ({
    path: gitlab ? row.new_path : row.filename,
    oldPath: gitlab ? row.old_path : row.previous_filename,
    added: gitlab ? row.new_file === true : row.status === 'added',
    removed: gitlab ? row.deleted_file === true : row.status === 'removed',
    renamed: gitlab ? row.renamed_file === true : row.status === 'renamed',
    patch: gitlab ? row.diff : row.patch,
  }));
}

export function postTickComment(run, kind, item, body, key) {
  const ctx = runForgeContext(run);
  const endpoint = commentsEndpoint(ctx, kind, item.repo, item.id);
  if (commentsWithReplies(ctx, kind, item.repo, item.id).some((note) => note.liteloopKey === key)) return null;
  const marked = `${body.trimEnd()}\n\n<!-- liteloop:key=${key} -->`;
  const posted = parseMaybeJson(runProcess(ctx.forge === 'gitlab'
    ? api(ctx, 'POST', endpoint, { body: marked })
    : { ...gh(ctx, ['api', '--method', 'POST', endpoint, '--input', '-']), stdin: JSON.stringify({ body: marked }) }));
  return { commentId: posted?.id ?? null };
}

export function applyTickIssueBody(run, configDir, issue, body, expectOwner) {
  const ctx = runForgeContext(run);
  const { repo, id } = issue;
  const flags = { repo, id, 'config-dir': configDir, body };
  return withIssueLock(ctx, flags, repo, id, () => {
    const current = liveIssueBody(ctx, repo, id);
    if (expectOwner) assertIssueOwner(current, expectOwner, repo, id);
    if (current !== issue.body) throw new CliError('LEDGER_CHANGED', '台账正文已变化，下轮重新对账');
    return emitReal(issueUpdate(ctx, flags));
  });
}

export function applyTickReviewLabels(run, change, labelPlan) {
  const ctx = runForgeContext(run);
  const data = readJson(changeRead(ctx, change.repo, change.id, ',labels'));
  const live = changeFields(ctx, data);
  if (live.headSha !== change.headSha || normalizeState(live.state).replace(/^opened$/, 'open') !== change.state
    || JSON.stringify(labelNames(data.labels).sort()) !== JSON.stringify([...change.labels].sort())) {
    throw new CliError('REVIEW_STATE_CHANGED', '变更单 head、状态或标签已变化，下轮重新对账');
  }
  return emitReal(changeLabel(ctx, { repo: change.repo, id: change.id, add: labelPlan.add.join(','), remove: labelPlan.remove.join(',') }));
}

function validateDependencies(ctx, { deps, invalid }) {
  const malformed = [...invalid, ...deps.filter((d) => !Number.isSafeInteger(d.id)
    || (d.forge === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(d.repo)))];
  if (malformed.length) throw new CliError('DEPENDS_ON_INVALID', 'Depends-On 格式非法，拒绝合并', { invalid: malformed });
  const otherInstance = deps.filter((d) => d.forge !== ctx.forge || (d.host && d.host !== ctx.host.toLowerCase()));
  if (otherInstance.length) throw new CliError('DEPENDS_ON_CROSS_INSTANCE', 'Depends-On 无法在当前 Forge 实例核验，拒绝合并', { blocked: otherInstance });
}

function checkDependencies(ctx, root, deps) {
  const keyFor = ({ repo, id }) => `${repo.toLowerCase()}#${id}`;
  const active = new Set([keyFor(root)]);
  const checked = new Map();
  const visit = (dep) => {
    const key = keyFor(dep);
    if (active.has(key)) {
      throw new CliError('DEPENDS_ON_CYCLE', `Depends-On 形成循环（${[...active, key].join(' → ')}），请修正依赖`);
    }
    if (checked.has(key)) return checked.get(key);
    const { state, body } = readLiveChange(ctx, dep.repo, dep.id);
    const status = normalizeState(state);
    if (!['open', 'opened', 'closed', 'merged', 'locked'].includes(status)) {
      throw new CliError('INVALID_FORGE_FACT', `Forge 未返回依赖 ${dep.repo}#${dep.id} 的有效状态`);
    }
    if (status === 'open' || status === 'opened') {
      active.add(key);
      const nested = parseDependsOnFromBody(body, dep.repo, ctx.forge);
      validateDependencies(ctx, nested);
      nested.deps.forEach(visit);
      active.delete(key);
    }
    checked.set(key, state);
    return state;
  };
  return deps.map((dep) => ({ ...dep, state: visit(dep) }));
}

function dependsError(blocked) {
  return new CliError('DEPENDS_ON_UNMERGED', `${blocked.length} 个 Depends-On 未合入：拒绝合并，停在待合并`, { blocked });
}

function protectedTargetError(target, protectedBranches) {
  if (!matchProtectedBranch(target, protectedBranches)) return null;
  const branches = [...new Set(protectedBranches)];
  return new CliError('ENV_BRANCH_FORBIDDEN', `目标分支 ${target} 命中受保护环境分支规则（${branches.join(', ')}），只允许人工合并`, { target, protectedBranches: branches });
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
  if (matchProtectedBranch(source, protectedBranches)) {
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

function extractDemandIssueRefs(body, currentRepo) {
  const cleaned = String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[-*+]\s+|\d+[.)]\s+)?depends-on\s*[:：]/i.test(line))
    .join('\n');
  const refs = [];
  for (const m of cleaned.matchAll(/https?:\/\/[\w.:-]+\/([\w.-]+(?:\/[\w.-]+)+)\/(?:-\/)?issues\/([1-9]\d*)\b/gi)) {
    refs.push({ repo: m[1].toLowerCase(), id: m[2], explicitRepo: true });
  }
  for (const m of cleaned.matchAll(/(?:^|[\s(（:：\[,，、；;])([\w.-]+(?:\/[\w.-]+)+)#([1-9]\d*)\b/g)) {
    refs.push({ repo: m[1].toLowerCase(), id: m[2], explicitRepo: true });
  }
  for (const m of cleaned.matchAll(/(?:^|[\s(（:：\[,，、；;])#([1-9]\d*)\b/g)) {
    refs.push({ repo: currentRepo ? String(currentRepo).toLowerCase() : null, id: m[1], explicitRepo: false });
  }
  return refs;
}

const GIT_LOCAL_ENV = /^GIT_(DIR|WORK_TREE|COMMON_DIR|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|PREFIX|INTERNAL_SUPER_PREFIX|ATTR_SOURCE|QUARANTINE_PATH|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_(KEY|VALUE)_\d+)$/;

function spawnMergeProcess(command, args, options) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_LOCAL_ENV.test(key)));
  const result = spawnSync(command, args, { env, encoding: 'utf8', detached: true, killSignal: 'SIGKILL', ...options });
  // spawnSync reaps the immediate child. The process group may still contain its descendants.
  if (result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return result;
}

function gitRaw(repoPath, args, allowNoMatch = false) {
  const result = spawnMergeProcess(GIT, ['-C', repoPath, ...args], { timeout: 60_000 });
  if (result.error || (result.status !== 0 && !(allowNoMatch && result.status === 1))) {
    throw new CliError('EXEC_FAILED', `Git ${args[0]} 执行失败${result.error ? `：${result.error.message}` : ''}`,
      { stderr: (result.stderr ?? '').trim() });
  }
  return result;
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
    gitRaw(repoPath, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-auto-maintenance',
      'origin', `+refs/heads/${br}:refs/remotes/origin/${br}`]);
  }
  const baseSha = gitRaw(repoPath, ['rev-parse', `refs/remotes/origin/${target}`]).stdout.trim();
  const fetchedHead = gitRaw(repoPath, ['rev-parse', `refs/remotes/origin/${source}`]).stdout.trim();
  if (headSha && fetchedHead !== headSha) {
    throw new CliError('HEAD_SHA_MISMATCH', `本地 fetch 到的 origin/${source} (${fetchedHead}) 与终审 SHA (${headSha}) 不一致`, { expected: headSha, actual: fetchedHead });
  }
  const mb = gitRaw(repoPath, ['merge-base', baseSha, fetchedHead], true);
  if (mb.status !== 0 || !mb.stdout.trim()) {
    throw new CliError('SOURCE_LINEAGE_INVALID', `源分支 ${source} 与需求基线 ${target} 无共同祖先，非基于本次需求基线拉取`, { source, target });
  }
  const mergeBase = mb.stdout.trim();
  if (baselineStartSha) {
    const anc = gitRaw(repoPath, ['merge-base', '--is-ancestor', baselineStartSha, mergeBase], true);
    if (anc.status !== 0) {
      throw new CliError(
        'SOURCE_LINEAGE_INVALID',
        `源分支 ${source} 的分叉点 (${mergeBase.slice(0, 8)}) 早于需求基线起点 (${baselineStartSha.slice(0, 8)})，非基于本次需求基线拉取`,
        { source, target, mergeBase, baselineStartSha },
      );
    }
  }
  const merges = gitRaw(repoPath, ['rev-list', '--merges', `${baseSha}..${fetchedHead}`]);
  const mergeCommits = (merges.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (mergeCommits.length > 0) {
    throw new CliError(
      'SOURCE_CONTAINS_MERGE_COMMITS',
      `源分支 ${source} 相对需求基线 ${target} 包含 ${mergeCommits.length} 个 merge commit。请在原候选分支用 git rebase origin/${target} 变基到最新需求基线（默认不保留 merge commit），仅保留本次需求提交，再用 git push --force-with-lease 更新原 PR/MR 后重新送审`,
      { source, target, mergeCommits },
    );
  }
  return { verified: true, source, target, baseSha, mergeBase, baselineStartSha: baselineStartSha ?? null, mergeCommits: 0 };
}

function tailLines(text, max = 40) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.slice(-max).join('\n');
}

function runTrialMerge({ repoPath, target, source, baseSha, headSha, command, minutes }) {
  if (!baseSha) throw new CliError('TRIAL_ENV_ERROR', '合并前试合需要本地仓库和已核对的基线 SHA');
  const timeoutMs = Math.max(1, Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000));
  let checkout;
  try {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'liteloop-trial-'));
    const root = gitRaw(repoPath, ['rev-parse', '--show-toplevel']).stdout.trim();
    gitRaw(checkout, ['clone', '--shared', '--no-checkout', '-c', 'core.hooksPath=/dev/null', '--', root, '.']);
    const origin = gitRaw(repoPath, ['remote', 'get-url', 'origin']).stdout.trim();
    const localOrigin = path.resolve(root, origin);
    gitRaw(checkout, ['remote', 'set-url', 'origin', fs.existsSync(localOrigin) ? localOrigin : origin]);
    gitRaw(checkout, ['checkout', '--detach', baseSha]);
    try {
      gitRaw(checkout, ['-c', 'user.name=liteloop-trial', '-c', 'user.email=liteloop-trial@local', 'merge', '--no-ff', '--no-commit', headSha]);
    } catch (error) {
      const conflicts = gitRaw(checkout, ['diff', '--name-only', '--diff-filter=U', '-z']).stdout.split('\0').filter(Boolean);
      if (!conflicts.length) throw error;
      throw new CliError('TRIAL_MERGE_CONFLICT',
        `合并前试合发现冲突（${source} → ${target}）：${conflicts.join('、')}，请基于最新需求基线解决冲突后重新送审`,
        { baseSha, headSha, conflicts });
    }
    const started = Date.now();
    const testRes = spawnMergeProcess(command, [], { cwd: checkout, shell: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    const trial = { baseSha, headSha, command, exitCode: testRes.status, durationMs: Math.max(0, Date.now() - started) };
    const output = [testRes.stdout, testRes.stderr].filter((s) => s?.trim()).join('\n');
    if (testRes.error || [126, 127, null].includes(testRes.status)) {
      const reason = testRes.error?.code === 'ETIMEDOUT' ? `执行超时（${timeoutMs}ms）`
        : testRes.error?.message ?? `无法启动或异常中断（退出码 ${testRes.status ?? testRes.signal}） ${tailLines(output, 20)}`;
      throw new CliError('TRIAL_ENV_ERROR', `合并前试合命令环境异常（${command}）：${reason}`,
        { trial: { ...trial, errorCode: testRes.error?.code ?? null, signal: testRes.signal ?? null } });
    }
    if (testRes.status !== 0) {
      const outputTail = tailLines(output);
      throw new CliError('TRIAL_TEST_FAILED',
        `合并前试合失败（${command}，退出码 ${testRes.status}）${outputTail ? `\n${outputTail}` : ''}`,
        { trial, outputTail });
    }
    return trial;
  } catch (error) {
    if (error.code?.startsWith('TRIAL_')) throw error;
    throw new CliError('TRIAL_ENV_ERROR', `合并前试合环境异常：${error.message} ${tailLines(error.extra?.stderr, 20)}`.trim());
  } finally {
    if (checkout) fs.rmSync(checkout, { recursive: true, force: true });
  }
}

function reviewMergeReasons(run, dispatch, rejectCount) {
  const reasons = [];
  if (rejectCount >= (run.thresholds?.rejectFuseCount ?? 2)) {
    reasons.push(new CliError('REJECT_FUSE_FULL_REVIEW', `已经打回 ${rejectCount} 次，请本人裁决是否合入`));
  }
  if (Object.values(dispatch.verdict.risk).some(Boolean)) {
    reasons.push(new CliError('HIGH_RISK_MANUAL', '终审判为高风险，请人工确认合入'));
  }
  return reasons;
}

/** @param {MergeGateInput} input */
function executeMerge(ctx, { flags, run, dispatch, rejectCount, snapshot = {} }) {
  ctx = withForgeHost(ctx);
  let repo = required(flags, 'repo');
  const id = required(flags, 'id');
  const target = required(flags, 'target');
  let selected = null;
  if (!run && !ctx.dryRun) throw new CliError('INVALID_RUN', '真实合并需要有效的运行态');
  if (run) {
    if (!Array.isArray(run.repos) || typeof run.baselineBranch !== 'string'
      || (run.protectedEnvBranches != null && !Array.isArray(run.protectedEnvBranches))) {
      throw new CliError('INVALID_RUN', '--run 缺少已确认仓库或基线');
    }
    selected = findRunRepo(run, repo);
    if (!selected) {
      throw new CliError('REPO_NOT_IN_RUN', `${repo} 不在需求已勾选的仓库中`);
    }
    repo = String(selected.repo ?? repo);
    if (target !== run.baselineBranch) {
      throw new CliError('TARGET_NOT_BASELINE', `目标分支 ${target} 不是已确认的需求基线 ${run.baselineBranch}`);
    }
    assertRunForge(ctx, run);
    if (ctx.dryRun && run.autoMerge === false) {
      throw new CliError('AUTO_MERGE_DISABLED', '需求记录已关闭自动合并，请人工合并');
    }
  }
  if (ctx.forge === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new CliError('INVALID_REPO', 'GitHub --repo 必须是当前实例的 owner/repo');
  }
  const prodTrunks = collectProdTrunks(flags, selected);
  const protectedBranches = [...new Set([...collectProtectedPatterns(flags, run), ...prodTrunks])];
  if (dispatch && !ctx.dryRun) snapshot.live ??= reviewLive(ctx, { repo, id });
  const targetError = protectedTargetError(target, run
    ? [...protectedBranches, ...run.repos.map(({ branch }) => branch).filter(Boolean)] : protectedBranches);
  if (targetError && (ctx.dryRun || !dispatch)) throw targetError;
  const headSha = ctx.dryRun ? required(flags, 'head-sha').toLowerCase() : reviewHead(flags);
  const repoPath = optional(flags, 'repo-path', '') || (selected?.path ? String(selected.path) : '');
  const baselineStartSha = optional(flags, 'baseline-start-sha', '') || (selected?.baselineStartSha ? String(selected.baselineStartSha) : '');
  const requireLineage = Boolean(flags['require-lineage']) || Boolean(repoPath);
  const allowedIds = new Set(splitList(flags['allowed-issues']).map(normalizeIssueId).filter(Boolean));
  const requireIssueRef = Boolean(run || flags['require-issue-ref'] || allowedIds.size);
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

  if (!dispatch || dispatch.verdict?.conclusion !== '通过') {
    throw new CliError('REVIEW_AUTHORIZATION_REQUIRED', '当前候选没有本机登记的自动合并授权，请人工核对');
  }
  if (run.tier === 'L3' && dispatchSlot(run) !== '主研发') {
    throw new CliError('MERGE_ROLE_FORBIDDEN', 'L3 由主研发执行合并');
  }
  const live = snapshot.live;
  if (live.target !== target) {
    const liveTargetError = protectedTargetError(live.target, protectedBranches);
    if (liveTargetError) throw liveTargetError;
    throw new CliError('TARGET_MISMATCH', `变更单实际目标 ${live.target} 与需求基线 ${target} 不一致，拒绝合并`, { target, actual: live.target });
  }
  if (live.state !== 'merged') assertReviewCandidate(live, headSha);
  if (live.headSha?.toLowerCase() !== headSha.toLowerCase()) {
    throw reviewHeadChanged(headSha, live.headSha);
  }
  if (dispatch.headSha !== headSha) {
    throw new CliError('REVIEW_AUTHORIZATION_REQUIRED', '当前候选没有本机登记的自动合并授权，请人工核对');
  }
  assertChangeMembership(run, live);
  if (dispatch.merge?.state === 'waiting' && live.state !== 'merged' && !isWaitingMerge(dispatch, live)) {
    throw new CliError('REVIEW_NOT_ACTIVE', '变更单已退回修改或重新送审，请核对当前派审');
  }
  const manualReason = targetError ?? reviewMergeReasons(run, dispatch, rejectCount)[0]
    ?? (run.autoMerge === true ? null : new CliError('AUTO_MERGE_DISABLED', '需求记录已关闭自动合并，请人工合并'));
  const { mode, command, skipReason } = resolveTrialConfig(run.verification, selected);
  const skipTrial = mode !== 'local-test' || !command;
  const skipNote = skipTrial ? skipReason ?? (mode === 'local-test' ? '未配置验证命令' : `mode=${mode}`) : null;
  if (live.state === 'merged') {
    if (manualReason) throw manualReason;
    return mergeReceipt(ctx, live, repo, id, headSha, strategy, [], null, '', dispatch.merge?.trial, skipNote);
  }
  if (live.conflict) throw new CliError('MERGE_CONFLICT', '变更单有合并冲突，请解决冲突后重新送审');
  if (!live.source) throw new CliError('SOURCE_BRANCH_MISSING', 'Forge 未返回源分支名，请人工核对');
  assertSourceAllowed(live.source, protectedBranches, prodTrunks);
  {
    const refs = issueRefsInField(ctx, live.body, repo);
    if (!refs.length) throw new CliError('MISSING_ISSUE_REF', 'PR/MR 描述未关联本次需求 Issue（已排除 Depends-On 行），拒绝自动合并');
    let verifiedIssues = snapshot.issues;
    if (!verifiedIssues) {
      const facts = collectRunFacts({ ...run, forge: ctx.forge, hubRepo: run.hubRepo ?? { repo } }, { issuesOnly: true });
      if (facts.errors.length) {
        throw new CliError('FORGE_FACTS_UNAVAILABLE', '无法核实需求 Issue 集合，拒绝自动合并', { errors: facts.errors });
      }
      verifiedIssues = [...facts.ledgers, ...facts.subIssues];
    }
    const known = new Set(verifiedIssues.map((item) => `${item.repo.toLowerCase()}#${item.id}`));
    if (!refs.some((ref) => known.has(`${ref.repo}#${ref.id}`))) {
      const hubRepo = run?.hubRepo?.repo?.toLowerCase();
      if (hubRepo && hubRepo !== repo.toLowerCase() && refs.every((ref) => !ref.explicitRepo)) {
        throw new CliError('ISSUE_REF_WRONG_REPO', `跨仓 PR/MR 描述应显式引用需求 Issue（如 ${hubRepo}#编号）`);
      }
      throw new CliError('ISSUE_REF_NOT_IN_RUN', `PR/MR 引用的 Issue（${refs.map((ref) => `${ref.repo}#${ref.id}`).join('、')}）不在本轮 Forge 核实的需求集合内`);
    }
  }
  const lineage = requireLineage
    ? verifySourceLineage({ repoPath, target, source: live.source, headSha, baselineStartSha })
    : { verified: false, skippedReason: 'no-repo-path' };
  const body = parseDependsOnFromBody(live.body, repo, ctx.forge);
  validateDependencies(ctx, body);
  const dependencies = checkDependencies(ctx, { repo, id }, uniqueDeps([...caller.deps, ...body.deps]));
  const blocked = dependencies.filter((d) => normalizeState(d.state) !== 'merged');
  if (blocked.length) throw dependsError(blocked);
  const trial = skipTrial ? null : runTrialMerge({ repoPath, target, source: live.source, baseSha: lineage.baseSha, headSha,
    command, minutes: Number(run.thresholds?.trialMergeTimeoutMinutes) });
  if (manualReason) {
    const trialNote = formatTrialNote(trial, skipNote);
    throw new CliError(manualReason.code, manualReason.message, {
      ...manualReason.extra, trial, trialNote: trial ? `${trialNote}\n试合基线若前移，人工合入前请重新确认。` : trialNote,
    });
  }
  if (trial) {
    const [actual] = gitRaw(repoPath, ['ls-remote', '--exit-code', '--refs', 'origin', `refs/heads/${target}`]).stdout.trim().split(/\s+/);
    if (actual !== trial.baseSha) throw new CliError('TRIAL_BASE_MOVED', `远端基线已从 ${trial.baseSha.slice(0, 8)} 变为 ${actual.slice(0, 8)}，需重新试合`,
      { expected: trial.baseSha, actual });
  }

  let stdout;
  try {
    stdout = runProcess(merge).trim();
  } catch (error) {
    let current;
    try { current = reviewLive(ctx, { repo, id }); } catch { /* Keep the original merge failure if the re-read fails. */ }
    if (FULL_SHA.test(current?.headSha ?? '') && current.headSha.toLowerCase() !== headSha) {
      snapshot.live = current;
      throw reviewHeadChanged(headSha, current.headSha);
    }
    throw error;
  }
  return mergeReceipt(ctx, live, repo, id, headSha, strategy, dependencies, lineage, stdout, trial, skipNote);
}

function formatTrialNote(trial, skipNote) {
  return trial ? `合并前试合：${trial.command} 通过（base ${trial.baseSha.slice(0, 8)}）` : skipNote && `未做合并前试合：${skipNote}`;
}

function mergeReceipt(ctx, live, repo, id, headSha, strategy, dependencies, lineage, stdout, trial = null, skipNote = null) {
  const after = readJson(changeRead(ctx, repo, id, ',mergeCommit,mergedAt,mergedBy'));
  if (normalizeState(after.state) !== 'merged') {
    throw new CliError('MERGE_NOT_CONFIRMED', `合并命令已执行但读回状态为 ${after.state}，不记成功`,
      { forgeState: after.state, stdout, ...(trial ? { trial } : {}) });
  }
  const trialNote = formatTrialNote(trial, skipNote);
  const mergeSha = after.merge_commit_sha ?? after.mergeCommit?.oid ?? null;
  const mergedAt = after.merged_at ?? after.mergedAt ?? null;
  const mergedBy = (ctx.forge === 'gitlab' ? (after.merge_user ?? after.merged_by)?.username : after.mergedBy?.login) ?? null;
  return { ok: true, dryRun: false, forge: ctx.forge, merged: true, repo, id, target: live.target, source: live.source, headSha, lineage, dependencies,
    mergeSha, mergedAt, mergedBy, ...strategy, stdout, ...(trial ? { trial } : {}), ...(trialNote ? { trialNote } : {}) };
}

function temporaryForgeError({ code, message, stderr, extra }) {
  return code === 'MERGE_NOT_CONFIRMED' || (code === 'EXEC_FAILED' &&
    /\b(?:HTTP\s+(?:408|429|5\d\d)|ETIMEDOUT|ECONNRESET)\b|timed?\s*out|temporarily unavailable/i.test(`${message} ${stderr ?? extra?.stderr ?? ''}`));
}

/** @param {MergeGateInput} input @returns {MergeGateResult} */
function mergeGate(ctx, input) {
  try {
    return { state: 'merged', receipt: executeMerge(ctx, input) };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const { dispatch, snapshot } = input;
    const changedHead = error.code === 'HEAD_SHA_MISMATCH' && snapshot?.live?.headSha
      && snapshot.live.headSha.toLowerCase() !== dispatch.headSha;
    if (changedHead || (dispatch?.merge?.state === 'waiting' && snapshot?.live && !isWaitingMerge(dispatch, snapshot.live)
      && ['HEAD_SHA_MISMATCH', 'REVIEW_NOT_ACTIVE', 'REVIEW_CHANGE_NOT_OPEN'].includes(error.code))) {
      return { state: 'invalidated', error };
    }
    const waiting = (error.code === 'DEPENDS_ON_UNMERGED'
      && error.extra.blocked.every(({ state }) => ['open', 'opened'].includes(normalizeState(state))))
      || error.code === 'TRIAL_BASE_MOVED' || temporaryForgeError(error)
      || (error.code === 'FORGE_FACTS_UNAVAILABLE' && error.extra.errors.every(temporaryForgeError));
    return { state: waiting ? 'waiting' : 'manual', error };
  }
}

function applyVerdictLabels(ctx, pr, live, result) {
  const { add, remove } = reviewLabelPlan(result, live.labels);
  if (add.length || remove.length) emitReal(changeLabel(ctx, { ...pr, add: add.join(','), remove: remove.join(',') }));
}

function mergeReviewedChange(ctx, runPath, run, dispatch, rejectCount, snapshot, flags = {}) {
  const { pr, headSha, dispatchId } = dispatch;
  const result = mergeGate(ctx, {
    run, dispatch, rejectCount, snapshot,
    flags: { repo: pr.repo, id: pr.id, target: run.baselineBranch, 'head-sha': headSha, ...flags },
  });
  const { state, error } = result;
  const code = error?.code ?? 'LOW_RISK_AUTO_MERGE';
  const needsChanges = reviewLabelPlan({ state, code }, []).add.includes('需修改');
  const otherReasons = (state === 'manual' || state === 'waiting') && !needsChanges
    ? reviewMergeReasons(run, dispatch, rejectCount).filter((reason) => reason.code !== code) : [];
  const reasonCodes = [code, ...otherReasons.map((reason) => reason.code)];
  const trial = result.receipt?.trial ?? error?.extra?.trial ?? (state === 'waiting' ? dispatch.merge?.trial : undefined);
  const unchanged = state === 'waiting' && dispatch.merge?.code === code;
  if (!unchanged || trial !== dispatch.merge?.trial) appendReview(runPath, {
    type: 'merge-result', dispatchId, state, code,
    ...(state === 'waiting' ? { rejectCount } : {}),
    ...(otherReasons.length ? { reasonCodes } : {}),
    ...(trial ? { trial } : {}),
  });
  const stderr = state === 'manual' && code === 'EXEC_FAILED' ? error.extra?.stderr?.split(/\r?\n/, 1)[0] : null;
  const detail = [error?.message, stderr, ...otherReasons.map((reason) => reason.message)].filter(Boolean).join('；');
  const message = state === 'merged' ? '终审通过，已自动合入需求基线。'
    : state === 'waiting' ? `${detail}。LiteLoop 会自动重试。`
    : state === 'invalidated' && code === 'HEAD_SHA_MISMATCH' ? `${detail}。` : `${detail}。请人工处理。`;
  const { live } = snapshot;
  let followupError;
  if (live && !changeMembership(run, live) && (live.state === 'open' || state === 'merged')) {
    try {
      applyVerdictLabels(ctx, pr, live, { state, code, reasonCodes });
      const mergedNote = result.receipt?.trialNote ? `终审通过｜风险低｜自动合并\n${result.receipt.trialNote}` : '终审通过｜风险低｜自动合并';
      const note = state === 'merged' ? mergedNote
        : [code === 'HIGH_RISK_MANUAL' ? null : message, error?.extra?.trialNote].filter(Boolean).join('\n');
      if (!unchanged) postReviewNote(ctx, pr.repo, pr.id, formatScriptComment(dispatchSlot(run), code, note));
    } catch (failure) {
      followupError = failure.message;
    }
  }
  return { state, code, message, ...(result.receipt ?? {}), ...(error?.extra ?? {}), ...(followupError ? { followupError } : {}) };
}

export function retryReviewedMerge(run, runPath, dispatch, issues) {
  const ctx = runForgeContext(run);
  const snapshot = { issues };
  // The retry itself reads the current candidate once and uses only the local approval.
  return mergeReviewedChange(ctx, runPath, run, dispatch, dispatch.merge.rejectCount, snapshot);
}

function changeMerge(ctx, flags) {
  if (ctx.dryRun || flags.run === undefined) {
    const { run } = loadRunOptional(flags);
    return executeMerge({ ...ctx, dryRun: true }, { flags, run });
  }
  const runPath = required(flags, 'run');
  if (!runPath.endsWith('.json')) throw new CliError('INVALID_RUN', '--run 必须指向需求运行态 JSON');
  return withFileLock(tickLockPath(runPath), () => {
    const { run } = loadRunOptional(flags);
    const repo = required(flags, 'repo');
    const selected = run && findRunRepo(run, repo);
    const pr = { repo: String(selected?.repo ?? repo), id: factsId(required(flags, 'id')) };
    const dispatch = selected ? reviewsFor(readReviews(runPath), pr).at(-1) : null;
    if (dispatch?.merge?.state !== 'waiting') return executeMerge(ctx, { flags, run });
    if (reviewHead(flags) !== dispatch.headSha) throw new CliError('HEAD_SHA_MISMATCH', '指定的 SHA 与已登记的终审候选不一致');
    if (required(flags, 'target') !== run.baselineBranch) throw new CliError('TARGET_NOT_BASELINE', '目标分支不是需求基线');
    assertRunForge(ctx, run);
    const result = mergeReviewedChange(ctx, runPath, run, dispatch, dispatch.merge.rejectCount, {}, { ...flags, repo: pr.repo });
    if (!result.merged) throw new CliError(result.code, result.message, result);
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* labels-sync：默认只补缺，不改共享标签                                  */
/* ------------------------------------------------------------------ */

function labelSpecs(flags) {
  const explicit = splitList(flags.labels);
  const slots = splitList(flags.slots);
  const names = explicit.length ? explicit : [...BASE_LABELS, ...(slots.length ? slots : DEFAULT_SLOTS).map((s) => `槽位${s}`)];
  if (flags.req !== undefined) names.push(demandLabel(required(flags, 'req')));
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
  'issue-create': (ctx, flags) => createMember(ctx, flags, issueCreate),
  'issue-update': issueUpdateWithOwner,
  'issue-comment': (ctx, flags) => simple(ctx, issueComment(ctx, flags)),
  reply: replyComment,
  'issue-close': (ctx, flags) => simple(ctx, issueClose(ctx, flags)),
  'change-list': changeList,
  'change-create': (ctx, flags) => createMember(ctx, flags, changeCreate, true),
  'change-label': (ctx, flags) => simple(ctx, changeLabel(ctx, flags)),
  'change-comment': changeComment,
  'dispatch-review': dispatchReview,
  verdict: changeVerdict,
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
      'issue-create --forge <f> --repo <...> --title <t> [--body <b>] [--labels a,b] [--req <slug>]',
      'issue-update --forge <f> --repo <...> --id <num> [--title <t>] [--body <b>] [--expect-owner <sessionId> [--handoff]]（--expect-owner：先 issue-get 核对第 1 节「主控：第 N 任 ｜ <sessionId>」，非现任抛 OWNER_CHANGED 拒写；--handoff 显式接任时跳过核对）',
      'issue-comment --forge <f> --repo <...> --id <num> --body <b>',
      'reply --kind issue|change --forge <f> --repo <...> --id <num> --reply-to <commentId> --body <text>',
      'issue-close --forge <f> --repo <...> --id <num>',
      'change-list --forge <f> --repos <r1,r2> [--group <g>（按 --repos 白名单过滤）] [--label <l>] [--state open] [--updated-after <iso>]',
      'change-create --forge <f> --repo <...> --source <br> --target <br> --title <t> [--body <b>] [--labels a,b] [--draft] [--req <slug>] [--run <run.json>] [--protected-branches a,b]',
      'change-label --forge <f> --repo <...> --id <num> [--add a,b] [--remove c]',
      'change-comment --forge <f> --repo <...> --id <num> --body <text>',
      'dispatch-review --run <run.json> --role controller|dispatch --forge <f> --repo <...> --id <num> --head-sha <40位> --session <新终审会话标识> [--by <派审会话标识>]（dispatch 必填 --by）',
      'verdict --run <run.json> --dispatch-id <id> --nonce <nonce> --forge <f> --repo <...> --id <num> --round <n> --conclusion 通过|打回 --risk contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0 --head-sha <40位> --session <id> [--slot <槽位>] [--must-fix <text>（打回必填，每条须以【P0】/【P1】/【P2】开头并含「入口：」和「证据：」，熔断后禁 P2）] [--remaining <text>（可选，仅允许【P2】并含「入口：」和「证据：」）] [--keep <text>]',
      'acceptance --run <run.json> --conclusion 通过|不通过 --report <文本或链接> --model <验收模型> --session <id>',
      'change-merge --forge <f> --repo <...> --id <num> --head-sha <sha> --target <需求基线> [--run <run.json>] [--repo-path <dir>] [--baseline-start-sha <sha>] [--require-lineage] [--require-issue-ref] [--protected-branches a,b] [--depends-on <json>]',
      'labels-sync --forge <f> --repos <r1,r2> [--req <slug>] [--labels a,b,c | --slots 主研发,A,B] [--overwrite（仅 GitHub）]',
      'baseline-check --repos <path1:branch1,path2:branch2>',
    ],
  };
}

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const sub = positional[0];
  if (!sub || sub === 'help' || flags.help) return usage();
  if (sub === 'baseline-check') return baselineCheck(flags);
  if (sub === 'acceptance') return recordAcceptance(flags);
  const handler = COMMANDS[sub];
  if (!handler) throw new CliError('UNKNOWN_COMMAND', `未知子命令：${sub}`, { commands: usage().commands });
  return handler(makeCtx(flags), flags);
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode, ...payload } = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = Number(exitCode ?? 0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? 'UNEXPECTED_ERROR', message: err.message, ...(err.extra ?? {}) }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
