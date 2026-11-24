import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CliError, factFailure, ENV_BRANCHES, isEnvironmentSource, matchProtectedBranch, splitPatterns, withFileLock, tickLockPath, acceptanceEnabled, parseAcceptanceComments } from './common.mjs';
import {
  applyTickIssueBody, applyTickReviewLabels, collectRunFacts, postTickComment, publishVerdict, retryReviewedMerge,
  readChangeFiles, readChangeLabelEvents, readLinkedOwnership, readAcceptanceBaseline,
} from '../forge.mjs';
import { FULL_SHA, readReviews, reviewsFor } from './review-journal.mjs';
import { hasRejectFuse, isWaitingMerge, resolveReviewState, reviewLabelPlan } from './review-state.mjs';
import { flushTickNotifications } from './outbox.mjs';
import { describeAction, formatScriptComment } from './action-messages.mjs';
import { commentSignature, decisionIds, dispatchSlot, escalationsFor, issueRef, ledgerField, pendingLines, reviewRef, sameRef, scopedChanges, syncMasterLedger, withPendingDecisions } from './tick-dispatch.mjs';

const CONTROLLER_COMMENTS = new Set(['纠偏', '配置变更', '交接', '提醒', '裁决', '基线变更', '设计变更']);

/**
 * @typedef {'reply-comment'|'review-dispatch'|'pr-needs-changes'|'review-verdict'|'issue-work'|'issue-closed'
 *   |'phase-step'|'master-sync'|'pr-merged'|'controller-stuck'} ControllerWork
 * @typedef {'person-confirmation'|'person-decision'|'blocked-issue'|'pending-review'|'pending-merge'
 *   |'patrol-finding'|'patrol-correction'} WaitingWork
 * @typedef {{kind: ControllerWork, key: string, code: string, ref: object}} ActionableTask
 * @typedef {{kind: WaitingWork, key: string, ref: object}} ReminderTask
 */
const REPORT_HANDLED_FINDINGS = new Set(['CONFIRM_TIMEOUT', 'CORRECTION_TIMEOUT']);
const FORGE_REVIEW_LABELS = ['待终审', '终审中'];
const REVIEW_WORKFLOW_LABELS = [...FORGE_REVIEW_LABELS, '待合并', '需修改'];
const HOUR = 3_600_000;
const isUrgentFinding = ({ finding }) => finding.code === 'BLOCK_ESCALATE';
const PATROL_DOC = 'references/patrol-and-notify.md';
const REVIEW_DOC = 'references/review-and-dispatch.md';
const CONTROLLER_DOC = 'references/controller.md';
const HEARTBEAT_FIELDS = {
  controller: '最近唤醒',
  patrol: '小巡检最近唤醒',
  dispatch: '调度最近唤醒',
  'lead-patrol': '大巡检最近唤醒',
};
const HEARTBEAT_LABEL = `(?:${Object.values(HEARTBEAT_FIELDS).join('|')})`;

function action(kind, reason, refs, entryDoc, detail = {}) {
  return { kind, reason, refs, entryDoc, needsLlm: !['comment-posted', 'notify-sent'].includes(kind), ...detail };
}

function factError(error) {
  return action('facts-error', error.message, [error.source], null, { code: error.code, ...(error.stderr ? { stderr: error.stderr } : {}) });
}

function noteRef(item, note) {
  return { repo: item.repo, id: item.id, ...(note ? { commentId: note.id } : {}) };
}

function ledgerTime(value, now, timezone) {
  if (!value) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const raw = /^(?:(\d{4})-)?(\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(value);
  if (!raw) throw new CliError('INVALID_LEDGER_TIME', `台账时间格式无法识别：${value}`);
  const year = Number(raw[1] ?? timezone.slice(0, 4));
  const offset = timezone.slice(-6);
  const parse = (y) => Date.parse(`${y}-${raw[2]}T${raw[3]}:00${offset}`);
  let time = parse(year);
  if (!raw[1] && time > now + 24 * HOUR) time = parse(year - 1);
  if (!Number.isFinite(time)) throw new CliError('INVALID_LEDGER_TIME', `台账时间无法读取：${value}`);
  return new Date(time).toISOString();
}

function latestTimestamp(values) {
  return values.filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

function controllerState(ledger, snapshot, previous = {}) {
  const first = snapshot.lib.ledgerSection(ledger.body, 1);
  const [lastWakeAt, startedAt, lastActionAt] = [
    ledgerField(first, '最近唤醒'), ledger.roundStartedAt, ledgerField(first, '最近动作'),
  ].map((value) => ledgerTime(value, snapshot.nowMs, snapshot.localNow));
  const owner = ledger.owner?.sessionId;
  const currentWake = owner && previous.owner === owner ? previous.lastWake : null;
  const savedSince = previous.runningWithoutStart?.owner === owner ? previous.runningWithoutStart?.since : null;
  const signedActionAt = ledger.comments.findLast((note) =>
    commentSignature(note.body)?.sessionId === owner && Date.parse(note.createdAt) <= snapshot.nowMs)?.createdAt;
  const runningSince = ledger.round === '执行中' ? startedAt
    ?? latestTimestamp([lastActionAt, signedActionAt, savedSince ?? latestTimestamp([lastWakeAt, ledger.updatedAt])])
    ?? snapshot.localNow : null;
  return {
    state: ledger.round,
    generation: ledger.owner?.generation,
    lastWakeAt: latestTimestamp([lastWakeAt, currentWake]),
    runningSince,
    runningHours: runningSince ? (snapshot.nowMs - Date.parse(runningSince)) / HOUR : 0,
  };
}

function workKey(kind, item, identity) {
  return `${kind}:${issueRef(item)}${identity == null ? '' : '@' + identity}`;
}

/** @param {ReminderTask[]} items */
function dueReminders(snapshot, stateKey, items, hours) {
  const sent = new Map();
  const due = [];
  for (const item of items) {
    if (sent.has(item.key)) continue;
    const previousAt = snapshot.previous[stateKey]?.[item.key]?.sentAt;
    if (!Number.isFinite(previousAt)
      || snapshot.lib.workHoursBetween(previousAt, snapshot.nowMs, snapshot.win) >= hours) {
      due.push(item);
      sent.set(item.key, { sentAt: snapshot.nowMs });
    } else {
      sent.set(item.key, { sentAt: previousAt });
    }
  }
  snapshot.next[stateKey] = Object.fromEntries(sent);
  return due;
}

function controllerWork(snapshot, personal, master) {
  const { run, ownIssues, ownChanges, slot, lib } = snapshot;
  const first = lib.ledgerSection(personal.body, 1);
  const status = ledgerField(first, '状态') ?? '';
  const stage = ledgerField(first, '阶段') ?? ledgerField(first, '当前阶段');
  const current = new Set(personal.currentIssues.map(issueRef));
  const inScope = (note) => commentSignature(note.body)?.sessionId !== personal.owner.sessionId;
  /** @type {ActionableTask[]} */
  const tasks = [];
  const add = (kind, code, item, identity, ref = noteRef(item)) =>
    tasks.push({ kind, key: workKey(kind, item, identity), code, ref });

  for (const item of [personal, ...ownChanges, ...ownIssues.filter(({ state }) => state === 'open')]) {
    const kind = ownChanges.includes(item) ? 'change' : 'issue';
    for (const note of item.comments) {
      if (note.replied || !inScope(note)) continue;
      const signature = commentSignature(note.body);
      if (!CONTROLLER_COMMENTS.has(note.prefix) && (signature || note.liteloopKey || note.prefix === '恢复')) continue;
      add('reply-comment', 'UNREPLIED_COMMENT', item, `${kind}:${note.id}`, { ...noteRef(item, note), kind, prefix: note.prefix });
    }
  }
  const escalation = snapshot.facts.ledgers.find((item) => item.key === 'escalation');
  for (const note of escalation?.comments ?? []) {
    if (note.prefix !== '裁决' || note.replied || !inScope(note)) continue;
    if (slot !== '主研发' && !decisionIds(note, escalation).some((id) => id.replace(/-\d+$/, '') === `升级-${slot}`)) continue;
    add('reply-comment', 'UNREPLIED_COMMENT', escalation, `issue:${note.id}`, { ...noteRef(escalation, note), kind: 'issue' });
  }
  for (const item of activeChanges(ownChanges, snapshot.baseline)) {
    if (item.labels.includes('需修改')) {
      add('pr-needs-changes', 'PR_NEEDS_CHANGES', item, item.headSha, { ...noteRef(item), headSha: item.headSha });
    } else if (run.tier === 'L3' && item.labels.includes('终审中')) {
      const dispatch = reviewsFor(snapshot.reviews ??= readReviews(snapshot.runPath), item).at(-1);
      const note = dispatch?.headSha === item.headSha && item.comments.find(({ id }) => id === dispatch.commentId);
      if (note && !note.replied) add('review-verdict', 'NEW_REVIEW_VERDICT', item, dispatch.dispatchId,
        { ...noteRef(item, note), headSha: item.headSha });
    }
  }
  for (const item of ownChanges) {
    if (item.state !== 'merged') continue;
    const linked = snapshot.facts.subIssues.filter((issue) => !issue.labels.includes('bug') && sameRef(item.issueRefs, issue));
    if (linked.length && linked.every((issue) => issue.state === 'closed')) continue;
    add('pr-merged', 'PR_MERGED_NEXT_STEP', item, item.mergeSha ?? item.headSha);
  }

  if (master) {
    const masterStage = ledgerField(lib.ledgerSection(master.body, 1), '当前阶段');
    const masterContract = contractVersion(master, lib);
    if ((stage && masterStage && stage !== masterStage)
      || (masterContract && contractVersion(personal, lib) && masterContract !== contractVersion(personal, lib))) {
      add('master-sync', 'SELF_IDLE_START', master, slot);
    }
  }
  if (/待确认|待裁决|暂停|已归档/.test(status)) return tasks;
  for (const item of ownIssues) {
    const isCurrent = current.has(issueRef(item));
    const bug = item.labels.includes('bug');
    if (item.state === 'closed' && isCurrent && !bug) add('issue-closed', 'SELF_IDLE_START', item);
    if (item.state !== 'open' || item.labels.includes('阻断')) continue;
    const owned = isCurrent || item.assignee === run.user || item.labels.includes(`槽位${slot}`) || (run.tier === 'L2' && !item.assignee);
    if (!owned) continue;
    if (bug) {
      const result = item.comments.map((note) => /^(?:【)?(复测不通过|已合入基线)/m.exec(note.body)?.[1]).filter(Boolean).at(-1);
      if (result !== '已合入基线') add('issue-work', 'SELF_IDLE_START', item);
    } else if (!/待终审|终审中|待合并/.test(status) && (!status.includes('阻断') || !isCurrent)) {
      add('issue-work', 'SELF_IDLE_START', item);
    }
  }
  const step = ledgerField(first, '当前步骤') ?? '';
  if (!/待终审|终审中|待合并|阻断/.test(status) && !/已完成/.test(status)
    && (/^P[012]$/.test(stage ?? '') || /^(准备做|待执行)|(?:测试|验证).*(?:待|未完成|没跑完)/.test(step)
      || /待(?:测试|验证|自验|复测)/.test(status))) {
    add('phase-step', 'SELF_IDLE_START', personal, stage);
  }
  return tasks;
}

/** @returns {ReminderTask[]} */
function controllerReminders(snapshot, personal) {
  const { lib, run, ownChanges, ownIssues } = snapshot;
  const section = lib.ledgerSection(personal.body, run.tier === 'L1' ? 4 : 2);
  const tasks = pendingLines(section).map(({ kind, text }) => {
    const type = kind === '待裁决' ? 'person-decision' : 'person-confirmation';
    return { kind: type, key: workKey(type, personal, text), ref: { ...noteRef(personal), text } };
  });
  for (const item of ownIssues) {
    if (item.state === 'open' && item.labels.includes('阻断')) {
      tasks.push({ kind: 'blocked-issue', key: workKey('blocked-issue', item), ref: noteRef(item) });
    }
  }
  for (const item of activeChanges(ownChanges, snapshot.baseline)) {
    const label = item.labels.includes('待合并') ? 'pending-merge'
      : item.labels.includes('终审中') ? 'pending-review' : null;
    if (label) tasks.push({ kind: label, key: workKey(label, item, item.headSha), ref: noteRef(item) });
  }
  return tasks;
}

function controllerActions(snapshot) {
  const { personal, master, actions, offHours, run, nowMs, lib } = snapshot;
  if (!personal || personal.state !== 'open') return;
  const owner = personal.owner?.sessionId;
  if (!owner || !personal.round) {
    throw new CliError('CONTROLLER_STATE_UNKNOWN', '台账缺少可核对的主控标识或本轮状态');
  }
  const state = snapshot.controller;
  const wake = lib.evalWakeDecision({
    now: new Date(nowMs).toISOString(), trigger: 'scheduled', workHours: snapshot.win, thresholds: snapshot.thresholds,
    ledgerControllerId: owner, currentSessionId: owner, generation: state.generation, state: state.state, runningHours: state.runningHours,
  });
  snapshot.next.owner = owner;
  snapshot.next.lastWake = snapshot.localNow;
  if (personal.round === '执行中' && !personal.roundStartedAt) {
    snapshot.next.runningWithoutStart = { owner, since: state.runningSince };
  } else delete snapshot.next.runningWithoutStart;
  if (offHours || personal.round === '暂停') return;
  planMergedLabelCleanup(snapshot, snapshot.ownChanges);
  if (run.tier !== 'L3') {
    planReviews(snapshot, snapshot.ownChanges, wake.action === 'start-round');
    if (snapshot.fusedChanges.length) snapshot.effects.unshift({
      type: 'fuse', item: personal,
      body: withPendingDecisions(personal.body, run.tier === 'L1' ? 4 : 2, snapshot.fusedChanges),
    });
  }
  if (wake.selfHeal.required) {
    const key = workKey('controller-stuck', personal, `${owner}:${state.runningSince}`);
    actions.push(action('controller', wake.nextAction, [noteRef(personal)], CONTROLLER_DOC, { code: wake.code, sessionId: owner, taskKeys: [key] }));
    return;
  }
  if (wake.action !== 'start-round') return;

  const work = controllerWork(snapshot, personal, master);
  const reasons = {
    UNREPLIED_COMMENT: '有未回执评论', PR_NEEDS_CHANGES: '终审打回，请处理必改项',
    NEW_REVIEW_VERDICT: '名下有终审结论待处理', PR_MERGED_NEXT_STEP: '名下变更已合入，请完成后续核验',
    SELF_IDLE_START: '主控空闲且有可推进项',
  };
  for (const code of Object.keys(reasons)) {
    const tasks = work.filter((item) => item.code === code);
    if (tasks.length) actions.push(action('controller', reasons[code], tasks.map(({ ref }) => ref), CONTROLLER_DOC,
      { code, sessionId: owner, taskKeys: tasks.map(({ key }) => key) }));
  }
  const primary = run.tier === 'L3' ? master : personal;
  const status = ledgerField(lib.ledgerSection(personal.body, 1), '状态') ?? '';
  const businessIssues = snapshot.facts.subIssues.filter((item) => !item.labels.includes('bug'));
  if (acceptanceEnabled(run) && (run.tier !== 'L3' || snapshot.slot === '主研发')
    && primary && !/暂停|已归档/.test(status)
    && businessIssues.length && businessIssues.every((issue) => issue.state === 'closed'
      && snapshot.facts.changes.some((change) => change.state === 'merged' && sameRef(change.issueRefs, issue)))) {
    const baselineSha = readAcceptanceBaseline(run);
    if (!parseAcceptanceComments(primary.comments).some((record) => record.baselineSha === baselineSha)) actions.push(action(
      'acceptance-dispatch', '用 brief --role acceptor 派独立验收', [noteRef(primary)], CONTROLLER_DOC, {
      code: 'ACCEPTANCE_DISPATCH', runPath: snapshot.runPath, sessionId: owner, baselineSha,
      ...(run.acceptance.guide ? { guide: run.acceptance.guide } : {}),
      taskKeys: [workKey('acceptance-dispatch', primary, baselineSha)],
    }));
  }
  const reminders = dueReminders(snapshot, 'controllerReminders', controllerReminders(snapshot, personal), snapshot.thresholds.controllerReminderHours);
  if (reminders.length) actions.push(action('controller', '有事项等待他人处理', reminders.map(({ ref }) => ref), CONTROLLER_DOC,
    { code: 'CONTROLLER_WAITING', sessionId: owner, taskKeys: reminders.map(({ key }) => key) }));
}

function contractVersion(ledger, lib) {
  if (!ledger) return null;
  const master = ledger.key === 'master';
  return ledgerField(lib.ledgerSection(ledger.body, master ? 4 : 1), master ? '契约版本' : '基于契约')?.split(/[（(\s]/)[0] ?? null;
}

function activeChanges(changes, baseline) {
  return changes.filter((item) => item.state === 'open' && !item.draft && item.source !== baseline);
}

function linesChanged(before, after) {
  const oldLines = before?.split('\n') ?? [];
  const newLines = after?.split('\n') ?? [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let end = 0;
  while (end < oldLines.length - start && end < newLines.length - start && oldLines.at(-1 - end) === newLines.at(-1 - end)) end += 1;
  return { startLine: start + 1, before: oldLines.slice(start, oldLines.length - end), after: newLines.slice(start, newLines.length - end) };
}

function documentLinks(item) {
  const links = [item.body, ...item.comments.map((note) => note.body)].flatMap((text) => text?.match(/https?:\/\/[^\s<>()[\]｜|]+/g) ?? []);
  return [...new Set(links.map((url) => url.replace(/[。，！；,.;]+$/, '')))]
    .filter((url) => !/\/(?:issues|pull|merge_requests)\/\d+(?:[#/?]|$)/.test(url));
}

function semanticBody(body) {
  return body
    .replace(new RegExp(`^[ \\t]*${HEARTBEAT_LABEL}[：:][^\\r\\n]*(?:\\r?\\n|$)`, 'gm'), '')
    .replace(new RegExp(`[ \\t]*[｜|][ \\t]*${HEARTBEAT_LABEL}[：:][^｜|\\r\\n]*`, 'g'), '');
}

function refreshHeartbeat(snapshot) {
  const { personal, master, role, run, localNow, lib } = snapshot;
  const item = role === 'controller' || role === 'patrol' ? personal : master;
  if (!roleNeedsLedger(run.tier, role) || item?.state !== 'open') return;
  const expectOwner = item === personal ? personal.owner?.sessionId : undefined;
  if (item === personal && !expectOwner) return;
  const field = HEARTBEAT_FIELDS[role];
  const heading = /^ {0,3}##[ \t]*1(?!\d)[^\r\n]*\r?\n/m.exec(item.body);
  if (!heading) throw new CliError('LEDGER_HEADING_MISSING', '台账缺少第 1 节，无法刷新最近唤醒');
  const start = heading.index + heading[0].length;
  const rest = item.body.slice(start);
  const end = rest.search(/^ {0,3}#{1,2}(?:\s|(?=\d))/m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const pattern = new RegExp(`(^[ \\t]*|[｜|][ \\t]*)${field}[：:][^｜|\\r\\n]*`, 'm');
  const line = `${field}：${localNow.slice(5, 16).replace('T', ' ')}`;
  const updated = pattern.test(section) ? section.replace(pattern, `$1${line}`)
    : line + (heading[0].endsWith('\r\n') ? '\r\n' : '\n') + section;
  const body = item.body.slice(0, start) + updated + rest.slice(section.length);
  if (body !== item.body) {
    applyTickIssueBody(run, lib.configDir, item, body, expectOwner);
    item.body = body;
  }
  if (role === 'dispatch') snapshot.next.lastWake = localNow;
}

function planPatrolReview(snapshot, ledgers, issues, changes) {
  const { nowMs, localNow, previous, next, actions, lib, offHours, role } = snapshot;
  const day = localNow.slice(0, 10);
  const workday = ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  const full = workday && !offHours && previous.fullReviewDate !== day;
  const ranges = [];
  const observed = { ledgers: {}, issues: {}, changes: {} };
  for (const item of [...ledgers, ...issues, ...changes]) {
    const type = ledgers.includes(item) ? 'ledgers' : issues.includes(item) ? 'issues' : 'changes';
    const key = issueRef(item);
    const before = previous[type]?.[key] ?? {};
    const info = { ...noteRef(item), kind: type === 'changes' ? 'change' : 'issue' };
    const masterContractOnly = role === 'patrol' && item.key === 'master';
    const documents = masterContractOnly ? [] : documentLinks(item);
    const maxCommentId = Math.max(before.maxCommentId ?? 0, 0, ...item.comments.map((note) => note.id));
    const configComments = masterContractOnly ? [] : item.comments.filter((note) => note.id > (before.maxCommentId ?? 0) && note.prefix === '配置变更').map((note) => note.id);
    const newDesignLinks = documents.filter((link) => !before.documents?.includes(link));
    const version = type === 'ledgers' ? contractVersion(item, lib) : null;
    const body = type !== 'ledgers' ? null : semanticBody(masterContractOnly
      ? lib.ledgerSection(item.body, 4).split('\n').find((line) => /^契约版本[：:]/.test(line)) ?? '' : item.body);
    const bodyHash = body === null ? null : createHash('sha256').update(body).digest('hex');
    const present = { maxCommentId, documents };
    const range = { ...info };
    if (type === 'ledgers') {
      const bodyChanged = before.bodyHash !== bodyHash;
      Object.assign(present, { body, bodyHash, version, bodyUpdatedAt: bodyChanged ? (before.bodyHash ? new Date(nowMs).toISOString() : item.updatedAt) : before.bodyUpdatedAt });
      if (bodyChanged) range.bodyDiff = linesChanged(before.body, body);
      if (version !== (before.version ?? null)) range.contractVersion = { before: before.version ?? null, after: version };
    } else if (type === 'changes') {
      const revision = createHash('sha256').update(JSON.stringify([
        item.headSha, item.body, item.title, item.state, item.labels.slice().sort(), item.source, item.target, item.draft,
      ])).digest('hex');
      Object.assign(present, { headSha: item.headSha, revision });
      if (revision !== before.revision) {
        range.diff = { url: item.url, repo: item.repo, id: item.id, before: before.headSha ?? null, headSha: item.headSha };
      }
    }
    if (configComments.length) range.configCommentIds = configComments;
    if (newDesignLinks.length) range.designLinks = newDesignLinks;
    if (Object.keys(range).length > Object.keys(info).length) ranges.push(range);
    observed[type][key] = present;
  }
  snapshot.patrolLedgers = observed.ledgers;
  if (offHours) return;
  Object.assign(next, observed);
  if (full) next.fullReviewDate = day;
  if (full || ranges.length) actions.push(action('patrol-review', full ? '工作日首次全量巡检' : '发现需判断的变化',
    (full ? [...ledgers, ...issues, ...changes].map(noteRefForItem) : ranges.map(({ repo, id, kind }) => ({ repo, id, kind }))), PATROL_DOC,
    { full, ranges }));
}

const noteRefForItem = (item) => ({ repo: item.repo, id: item.id, kind: item.headSha ? 'change' : 'issue' });

function confirmationsFor(ledger, since, lib) {
  const section = lib.ledgerSection(ledger.body, ledger.key === 'tracking' ? 4 : 2);
  return pendingLines(section).map((item) => ({ id: `${issueRef(ledger)}:${item.text}`, title: item.text, since }));
}

function mechanicalFinding(item, finding) {
  const key = `patrol:${issueRef(item)}:${createHash('sha256').update(finding.key).digest('hex').slice(0, 20)}`;
  return { item, key, finding, targetKind: item.headSha ? 'change' : 'issue' };
}

function findingTarget(finding, fallback, changes) {
  return changes.find((change) => change.id === finding.id && change.repo === finding.repo) ?? fallback;
}

function patrolSmall(snapshot, ledger, changes, findings) {
  const { lib, patrolLedgers, master, run, thresholds, ctx, controllerTick } = snapshot;
  const slot = ledger.key.startsWith('slot:') ? ledger.key.slice(5) : snapshot.slot;
  const updatedAt = patrolLedgers[issueRef(ledger)]?.bodyUpdatedAt ?? ledger.updatedAt;
  const entries = lib.evalSmallPatrol({
    tier: run.tier,
    ledger: { ...ledger, updatedAt, contractVersion: contractVersion(ledger, lib) },
    master: { contractVersion: contractVersion(master, lib) },
    controller: controllerState(ledger, snapshot, controllerTick),
    changes: changes.map((change) => ({
      ...change,
      updatedAt: change.createdAt ?? change.updatedAt,
      reviewRequestedAt: (snapshot.reviewEvents.get(issueRef(change)) ?? [])
        .findLast((event) => event.action === 'add' && FORGE_REVIEW_LABELS.includes(event.label))?.at ?? change.updatedAt,
    })),
    confirmations: confirmationsFor(ledger, updatedAt, lib),
    corrections: [ledger, ...changes].flatMap((item) => item.comments.filter((note) => note.prefix === '纠偏' && !note.replied)
      .map((note) => ({ id: note.id, title: note.body.split('\n').find((line) => line.startsWith('【纠偏】')) ?? `评论 ${note.id}`, since: note.createdAt }))),
  }, thresholds, ctx);
  for (const entry of entries) findings.push(mechanicalFinding(findingTarget(entry, ledger, changes), { ...entry, slot }));
}

function ledgersForPatrol(snapshot) {
  if (snapshot.role === 'lead-patrol') return snapshot.facts.ledgers.filter((ledger) => ledger.state === 'open');
  return [snapshot.personal, snapshot.master].filter((ledger) => ledger?.state === 'open');
}

function patrolLead(snapshot, ledgers, changes, findings) {
  const { master, facts, lib, thresholds, ctx, patrolLedgers, dispatchTick } = snapshot;
  const slots = ledgers.filter((ledger) => ledger.key.startsWith('slot:'));
  const escalation = ledgers.find((ledger) => ledger.key === 'escalation');
  const escalations = escalationsFor(escalation, master, lib.ledgerSection);
  const first = lib.ledgerSection(master?.body, 1);
  const stage = ledgerField(first, '当前阶段');
  const stageStarted = stage === 'P3' ? ledgerTime(ledgerField(first, '阶段开始时间') ?? ledgerField(first, '阶段开始'),
    snapshot.nowMs, snapshot.localNow) ?? snapshot.previous.p3StartedAt
    ?? (snapshot.run.stage === 'P3' ? snapshot.run.createdAt : null) ?? master?.createdAt ?? master?.updatedAt : null;
  if (stageStarted) snapshot.next.p3StartedAt = stageStarted;
  else delete snapshot.next.p3StartedAt;
  const lastDispatchWake = latestTimestamp([
    ledgerTime(ledgerField(first, HEARTBEAT_FIELDS.dispatch), snapshot.nowMs, snapshot.localNow), dispatchTick.lastWake,
  ]);
  const slotRows = lib.ledgerSection(master?.body, 3).split(/\r?\n/)
    .map((line) => line.replace(/^\s*\||\|\s*$/g, '').split('|').map((cell) => cell.trim()));
  const people = new Map(slotRows.filter((cells) => cells.length === 5 && slots.some((ledger) => ledger.key === `slot:${cells[0]}`))
    .map(([slot, person]) => [slot, person]));
  for (const { slot, user } of facts.slotClaims) if (user) people.set(slot, user);
  const projections = slots.map((ledger) => {
    const slot = ledger.key.slice(5);
    const issues = facts.subIssues.filter((item) => sameRef(ledger.currentIssues, item) || item.labels.includes(`槽位${slot}`));
    const related = scopedChanges(ledger, issues, changes);
    const slotEscalations = escalations.filter((item) => item.slot === slot);
    const lastOutputAt = latestTimestamp([...related.map((item) => item.createdAt ?? item.updatedAt), ...slotEscalations.map((item) => item.since)])
      ?? latestTimestamp(issues.map((item) => item.createdAt)) ?? stageStarted;
    const changeState = patrolLedgers[issueRef(ledger)];
    return {
      ...ledger, slot, person: people.get(slot) ?? null,
      paused: ledger.round === '暂停', pausedAt: changeState.bodyUpdatedAt,
      lastOutputAt, contractVersion: contractVersion(ledger, lib),
      correctionIneffective: ledger.comments.some((note) => note.prefix === '纠偏'),
    };
  });
  const inspected = lib.evalLeadPatrol({
    tier: 'L3', ledgers: projections, master: { contractVersion: contractVersion(master, lib) },
    changes: activeChanges(changes, snapshot.baseline).filter((item) => !item.labels.includes('需修改')).map((item) => ({ ...item, updatedAt: item.createdAt ?? item.updatedAt, person: item.author })),
    escalations, p3: { slots: stage === 'P3' ? projections : [] }, lead: { person: snapshot.run.user },
    dispatch: lastDispatchWake && !snapshot.offHours ? { alive: lib.workHoursBetween(Date.parse(lastDispatchWake), snapshot.nowMs, snapshot.win)
      < thresholds.controllerLoopMinutes * thresholds.disconnectCycles / 60 } : null,
  }, thresholds, ctx);
  for (const entry of inspected) {
    const target = (entry.code === 'BLOCK_ESCALATE' ? escalation : slots.find((item) => item.key === `slot:${entry.slot}`)) ?? master;
    if (target) findings.push(mechanicalFinding(findingTarget(entry, target, changes), entry));
  }
}

function ownershipRows(body) {
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((value) => value.trim().replace(/^\x60|\x60$/g, ''));
  const columns = (name) => ({ 仓库: 'repo', 文件: 'path', 路径: 'path', 文件路径: 'path', 归属: 'slot', 槽位: 'slot', 归属槽位: 'slot', 持有槽位: 'slot', 热点: 'hot', 热点文件: 'hot' })[name];
  let header;
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) { header = null; continue; }
    const values = cells(line);
    const names = values.map(columns);
    if (names.includes('path') && names.includes('slot')) { header = names; continue; }
    if (!header || !values.length || /^:?-+:?$/.test(values[0])) continue;
    const row = Object.fromEntries(header.flatMap((name, i) => name ? [[name, values[i]]] : []));
    if (row.path && row.slot) out.push(row);
  }
  return out;
}

function ownershipOf(ownership, change, file) {
  return ownership.filter((record) => (!record.repo || record.repo.toLowerCase() === change.repo.toLowerCase())
    && [file.path, file.oldPath].some((name) => name && (record.path === name
      || (record.path.endsWith('/') && name.startsWith(record.path)))));
}

function modifiedExistingLine(file) {
  if (file.added) return false;
  if (file.removed || file.renamed) return true;
  if (!file.patch) throw new CliError('INCOMPLETE_DIFF', `Forge 未提供 ${file.path} 的文件差异`);
  return file.patch.split(/^@@[^\r\n]*\r?\n/gm).slice(1).some((hunk) => {
    const lines = hunk.split(/\r?\n/);
    if (lines.some((line) => line.startsWith('-'))) return true;
    let added = false;
    for (const line of lines) {
      if (line.startsWith('+')) added = true;
      if (added && line.startsWith(' ')) return true;
    }
    return false;
  });
}

function ownershipFindings(snapshot, changes, findings) {
  const { run, ownership, facts } = snapshot;
  for (const change of changes) {
    const slot = change.labels.find((label) => label.startsWith('槽位'))?.slice(2)
      ?? facts.ledgers.find((item) => item.key.startsWith('slot:') && sameRef(item.changeRefs, change))?.key.slice(5);
    if (!slot || !ownership.length) continue;
    guarded(snapshot, `diff:${issueRef(change)}`, () => {
      const files = getChangedFiles(snapshot, change);
      const paths = files.filter((file) => ownershipOf(ownership, change, file).some((rule) => rule.slot !== slot || /^(是|热点|true)$/i.test(rule.hot))
        && modifiedExistingLine(file)).map((file) => file.path);
      if (!paths.length) return;
      findings.push(mechanicalFinding(change, {
        code: 'OWNED_LINES_CHANGED', key: `owned-lines:${change.headSha}`, slot, title: '修改他人或热点文件已有行',
        recipients: [{ person: change.author }, { person: snapshot.run.user }],
        text: `【纠偏】${reviewRef(change)} 修改受归属保护的已有内容（head ${change.headSha}）：${paths.join('、')}。请对照归属表及已定裁决复核。`,
      }));
    });
  }
}

function getChangedFiles(snapshot, change) {
  const key = issueRef(change);
  if (!snapshot.changeFiles.has(key)) snapshot.changeFiles.set(key, readChangeFiles(snapshot.run, change));
  return snapshot.changeFiles.get(key);
}

function dispatchMergeFindings(snapshot, findings) {
  for (const change of snapshot.facts.changes) {
    if (change.state !== 'merged') continue;
    const audit = change.comments.findLast((note) => {
      const [signature, first, second] = note.body.split(/\r?\n/, 3);
      if (!/^(?:(?:主研发调度|调度)\s*[｜|].+|巡检脚本 ｜ .+ ｜ LOW_RISK_AUTO_MERGE)$/.test(signature)) return false;
      const recorded = first === describeAction({ code: 'LOW_RISK_AUTO_MERGE' }) + '。' ? second : first;
      return /^终审通过\s*[｜|]\s*风险低\s*[｜|]\s*自动合并/.test(recorded);
    });
    if (!audit || (change.mergedBy && change.mergedBy !== audit.author)) continue;
    const repo = snapshot.run.repos?.find((entry) => entry.repo.toLowerCase() === change.repo.toLowerCase());
    const prohibited = [...ENV_BRANCHES, ...(snapshot.run.protectedEnvBranches ?? []), ...[repo?.branch].filter(Boolean)];
    const reasons = [
      change.target !== snapshot.baseline && '目标不是需求基线',
      matchProtectedBranch(change.target, prohibited) && '目标命中环境分支保护',
      matchProtectedBranch(change.source, prohibited) && '源分支受保护，需人工处理',
      change.labels.includes('风险高') && '变更单显示风险高',
    ].filter(Boolean);
    if (!reasons.length) continue;
    findings.push(mechanicalFinding(change, {
      code: 'DISPATCH_UNAUTHORIZED_MERGE', key: `dispatch-merge:${change.mergeSha ?? change.headSha}`, title: '主研发调度合并记录命中红线',
      recipients: [{ person: snapshot.run.user }],
      text: `【纠偏】${reviewRef(change)} 有调度自动合并记录，但 Forge 显示${reasons.join('、')}。请主研发复核合入记录与处置方式。`,
    }));
  }
}

function applyPatrolComments(snapshot) {
  const writable = snapshot.offHours ? snapshot.findings.filter(isUrgentFinding) : snapshot.findings;
  for (const { finding, item, key, targetKind } of writable) {
    if (item.comments.some((note) => note.liteloopKey === key)) continue;
    const content = finding.text.startsWith('【') ? finding.text : `【提醒】${finding.text}`;
    guarded(snapshot, `comment:${issueRef(item)}`, () =>
      writeScriptComment(snapshot, targetKind, item, content, key, finding.code, PATROL_DOC));
  }
}

function planPatrol(snapshot) {
  const { role, personal, master, facts, ownIssues, ownChanges, actions, findings, lib } = snapshot;
  if (role === 'lead-patrol' && !master) return;
  if (role === 'patrol' && !personal) return;
  const ledgers = ledgersForPatrol(snapshot);
  const issues = role === 'lead-patrol' ? facts.subIssues : ownIssues;
  const changes = role === 'lead-patrol' ? facts.changes : ownChanges;
  if (!ledgers.length || (role === 'patrol' && personal.state !== 'open') || (role === 'lead-patrol' && master.state !== 'open')) return;
  planPatrolReview(snapshot, ledgers, issues, changes);
  const active = activeChanges(changes, snapshot.baseline);
  if (role === 'patrol') patrolSmall(snapshot, personal, active.filter((item) => !item.labels.includes('需修改')), findings);
  else {
    patrolLead(snapshot, ledgers, changes, findings);
    dispatchMergeFindings(snapshot, findings);
  }
  ownershipFindings(snapshot, active, findings);

  if (snapshot.offHours) return;
  const ownLedger = role === 'lead-patrol' ? master : personal;
  /** @type {ReminderTask[]} */
  const outstanding = [
    ...confirmationsFor(ownLedger, ownLedger.updatedAt, lib).map((item) => ({
      kind: 'person-confirmation', key: workKey('person-confirmation', ownLedger, item.title),
      ref: { ...noteRef(ownLedger), text: item.title },
    })),
    ...[ownLedger, ...active].flatMap((item) => item.comments.filter((note) => note.prefix === '纠偏' && !note.replied)
      .map((note) => ({
        kind: 'patrol-correction', key: note.liteloopKey ?? workKey('patrol-correction', item, note.id),
        ref: { ...noteRef(item, note), kind: item.headSha ? 'change' : 'issue' },
      }))),
    ...findings.filter(({ finding, item, key }) => !REPORT_HANDLED_FINDINGS.has(finding.code)
      && !item.comments.some((note) => note.liteloopKey === key && note.replied)).map(({ item, key, finding }) => ({
      kind: 'patrol-finding', key, ref: { ...noteRef(item), code: finding.code, title: finding.title },
    })),
  ];
  const reports = dueReminders(snapshot, 'patrolReminders', outstanding, snapshot.thresholds.confirmTimeoutHours);
  if (reports.length) actions.push(action('user-report', '有待本人处理的事项', reports.map(({ ref }) => ref), PATROL_DOC,
    { taskKeys: reports.map(({ key }) => key) }));

}

function planMergedLabelCleanup(snapshot, changes) {
  for (const item of changes) {
    if (item.state !== 'merged') continue;
    const remove = item.labels.filter((label) => REVIEW_WORKFLOW_LABELS.includes(label));
    if (remove.length) snapshot.effects.push({
      type: 'review', item, labelPlan: { add: [], remove }, reason: '摘除已合入变更的审查标签',
    });
  }
}

function planReviews(snapshot, changes, planQueue = true) {
  const { nowMs, thresholds, actions, effects, runPath } = snapshot;
  const records = snapshot.reviews ??= readReviews(runPath);
  const planned = new Set(changes.map(issueRef));
  for (const dispatch of records) {
    if (dispatch.merge?.state === 'waiting' && !planned.has(issueRef(dispatch.pr))
      && reviewsFor(records, dispatch.pr).at(-1) === dispatch) {
      effects.push({ type: 'retry-merge', item: dispatch.pr, dispatch });
    }
  }
  for (const change of changes) {
    const history = reviewsFor(records, change);
    const dispatch = history.at(-1);
    for (const record of history) {
      if (record.verdict?.body && !record.commentId) effects.push({ type: 'audit-verdict', item: change, dispatch: record });
    }
    if (dispatch?.merge?.state === 'waiting') {
      effects.push({ type: 'retry-merge', item: change, dispatch });
      if (isWaitingMerge(dispatch, change)) continue;
    }
    if (change.state !== 'open' || change.draft || change.source === snapshot.baseline) continue;
    const merge = dispatch?.merge;
    if (merge?.state === 'manual' && dispatch.headSha === change.headSha && !change.labels.includes('待终审')) {
      const labelPlan = reviewLabelPlan(merge, change.labels);
      if (labelPlan.remove.includes('需修改')) continue;
      if (labelPlan.add.length || labelPlan.remove.length) effects.push({ type: 'review', item: change,
        labelPlan, reason: '同步合并门禁标签', data: { code: merge.code } });
      const pending = labelPlan.add.includes('待合并') || (change.labels.includes('待合并') && !labelPlan.remove.includes('待合并'));
      if (pending && hasRejectFuse(merge)) snapshot.fusedChanges.push(reviewRef(change));
      continue;
    }
    if (!planQueue || !change.labels.some((label) => FORGE_REVIEW_LABELS.includes(label))) continue;
    const ref = issueRef(change);
    if (snapshot.rejectedSources.has(ref)) {
      effects.push({
        type: 'review', item: change, key: `review-source:${ref}:${change.source}`,
        labelPlan: { remove: ['终审中', '待终审', '风险低'], add: ['需修改'] },
        data: { code: 'SOURCE_ENV_BRANCH_FORBIDDEN', note: `源分支 ${change.source} 是受保护的环境分支，请改用从需求基线拉出的开发分支。` },
      });
      continue;
    }
    const inReview = change.labels.includes('终审中') && !change.labels.includes('待终审');
    if (!inReview) {
      if (change.commentError) continue;
      const review = resolveReviewState(history, change.comments, change.headSha);
      const fullReReview = review.rejectCount >= thresholds.rejectFuseCount;
      if (FULL_SHA.test(change.headSha)) actions.push(action('review-dispatch', fullReReview ? '派全量重审' : '派独立终审',
        [{ ...noteRef(change), headSha: change.headSha }], REVIEW_DOC, {
          code: 'dispatch', runPath, rejectCount: review.rejectCount, fullReReview,
          taskKeys: [workKey('review-dispatch', change, change.headSha)],
        }));
      continue;
    }
    const review = resolveReviewState(history, change.comments, change.headSha);
    const key = `review:${ref}:${dispatch?.dispatchId ?? change.headSha}`;
    if (review.state === 'head-changed' || (review.state === 'in-review' && nowMs - Date.parse(dispatch.at) >= thresholds.reviewStaleHours * HOUR)) {
      effects.push({ type: 'review', item: change, key,
        data: { code: 'REVIEW_TIMEOUT', comment: review.state === 'head-changed' ? '候选提交已变化，退回「待终审」重派' : '终审超时，退回「待终审」重派' },
        labelPlan: { remove: ['终审中'], add: ['待终审'] } });
    } else if (review.state === 'rejected') {
      effects.push({ type: 'review', item: change, key,
        labelPlan: reviewLabelPlan({ state: 'rejected' }, change.labels),
        data: { code: 'REVIEW_REJECTED', comment: `打回第 ${review.rejectCount} 次` } });
    } else if (review.state !== 'in-review') {
      effects.push({ type: 'review', item: change, key,
        labelPlan: { remove: ['终审中', '风险低'], add: ['待合并'] },
        data: { code: 'REVIEW_AUTHORIZATION_REQUIRED', note: '当前候选没有等待自动合并的本机登记，请人工处理。' } });
    }
  }
}

function writeScriptComment(snapshot, kind, item, text, key, code, doc) {
  const slot = snapshot.role === 'patrol' ? snapshot.slot : '主研发';
  const body = formatScriptComment(slot, code, text);
  const signature = body.split('\n', 1)[0];
  const posted = postTickComment(snapshot.run, kind, item, body, key);
  if (posted) snapshot.actions.push(action('comment-posted', text, [{ ...noteRef(item), kind, ...posted }], doc, { code, dedupKey: key, signature }));
}

function applyReview(snapshot, effect) {
  const { run } = snapshot;
  const { item, key, data = {}, labelPlan } = effect;
  const comment = data.comment ?? data.note;
  if (comment) writeScriptComment(snapshot, 'change', item, comment, key, data.code, REVIEW_DOC);
  const remove = labelPlan.remove.filter((label) => item.labels.includes(label));
  const add = labelPlan.add.filter((label) => !item.labels.includes(label));
  if (remove.length || add.length) {
    applyTickReviewLabels(run, item, { add, remove });
    item.labels = [...item.labels.filter((label) => !remove.includes(label)), ...add];
  }
}

function planDispatch(snapshot) {
  const { master, facts, baseline, effects, run, lib } = snapshot;
  if (run.tier !== 'L3' || dispatchSlot(run) !== '主研发' || !master || master.state !== 'open') return;
  const selected = new Set((run.repos ?? []).map(({ repo }) => String(repo).toLowerCase()));
  const changes = facts.changes.filter((change) => selected.has(change.repo.toLowerCase()));
  planMergedLabelCleanup(snapshot, changes);
  planReviews(snapshot, changes);
  const escalation = facts.ledgers.find((item) => item.key === 'escalation');
  for (const item of escalationsFor(escalation, master, lib.ledgerSection)) {
    if (!item.listed && !item.adjudicated) snapshot.decisions.push(`${item.id} ｜ ${issueRef(escalation)}#${item.note.id}`);
  }
  if (snapshot.fusedChanges.length) effects.unshift({
    type: 'fuse', item: master, body: syncMasterLedger(master, facts, baseline, snapshot.fusedChanges).body,
  });
  const desired = syncMasterLedger(master, facts, baseline, [...snapshot.decisions, ...snapshot.fusedChanges]);
  if (desired.body !== master.body || desired.retainedProgress || effects.some((effect) => effect.type === 'retry-merge')) {
    effects.push({ type: 'master', item: master, data: desired.retainedProgress ? {
      code: 'MASTER_PROGRESS_RETAINED', note: desired.retainedProgress,
    } : null });
  }
  effects.push({ type: 'baseline' });
}

function notifyBaseline(snapshot) {
  const { facts, baseline, previous, next, nowMs, thresholds, ownership } = snapshot;
  const since = (previous.baselineCheckedAt ?? nowMs - thresholds.controllerLoopMinutes * 60_000) - 10 * 60_000;
  const slots = facts.ledgers.filter((ledger) => ledger.state === 'open' && ledger.key.startsWith('slot:'));
  for (const merged of facts.changes) {
    if (merged.state !== 'merged' || merged.target !== baseline || (!merged.newlyMerged && Date.parse(merged.mergedAt) < since)) continue;
    if (!merged.newlyMerged && !merged.mergedAt) continue;
    const affected = new Set();
    for (const change of facts.changes) {
      if (change.state !== 'open' || !sameRef(change.dependsOn, merged)) continue;
      for (const ledger of slots) if (scopedChanges(ledger, facts.subIssues.filter((issue) => sameRef(ledger.currentIssues, issue)), [change]).length) affected.add(ledger.key);
    }
    if (ownership.length) {
      for (const file of getChangedFiles(snapshot, merged)) {
        for (const row of ownershipOf(ownership, merged, file)) affected.add(`slot:${row.slot}`);
      }
    }
    if (!merged.mergeSha && affected.size) throw new CliError('MERGE_SHA_MISSING', `Forge 未返回 ${reviewRef(merged)} 的合入 SHA`);
    const ownSlot = merged.labels.find((label) => label.startsWith('槽位'))?.slice(2);
    const key = `baseline:${issueRef(merged)}:${merged.mergeSha}`;
    const text = `【基线变更】${merged.repo} 的 ${baseline} 已合入 ${reviewRef(merged)}（${merged.mergeSha}），请同步基线并复核关联依赖和改动文件。`;
    for (const ledger of slots) {
      if (ledger.key === `slot:${ownSlot}` || !affected.has(ledger.key)) continue;
      writeScriptComment(snapshot, 'issue', ledger, text, key, 'BASELINE_CHANGED', REVIEW_DOC);
    }
  }
  next.baselineCheckedAt = nowMs;
}

function guarded(snapshot, source, work, failures = snapshot.actions) {
  try {
    return work();
  } catch (error) {
    failures.push(factError(factFailure(source, error)));
    return null;
  }
}

function readTickState(file, role, actions) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: {} };
    throw error;
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    // A damaged sidecar can be regenerated from Forge on the next applied tick.
  }
  if (state?.req) {
    actions.push(action('state-notice', `跳过 ${role} 巡检状态，文件属于另一条需求`, [], null,
      { code: 'TICK_STATE_OCCUPIED', needsLlm: false }));
    return { state: {}, occupied: true };
  }
  if (state && typeof state === 'object' && !Array.isArray(state)) return { state };
  actions.push(action('state-notice', `${role} 巡检状态已损坏，本轮从 Forge 重建`, [], null,
    { code: 'TICK_STATE_RESET', needsLlm: false }));
  return { state: {}, reset: true };
}

function roleNeedsLedger(tier, role) {
  return role === 'controller' || (role === 'patrol' && tier !== 'L1')
    || (['dispatch', 'lead-patrol'].includes(role) && tier === 'L3');
}

function executeTick(runPath, role, apply, nowMs, lib, { findingsOnly = false, session = null } = {}) {
  const run = lib.readJson(runPath, 'RUN_NOT_FOUND');
  if (run.status === 'archived') return null;
  const reviewRole = role === 'controller' && run.tier !== 'L3' || role === 'dispatch' && run.tier === 'L3';
  const reviews = reviewRole ? readReviews(runPath) : undefined;
  const latest = new Map(reviews?.map((row) => [issueRef(row.pr), row]));
  const facts = collectRunFacts(run, {
    skipChangeComments(change) {
      return isWaitingMerge(latest.get(issueRef(change)), change);
    },
    isolateChangeComments: reviewRole,
  });
  const personalTask = run.scheduledTasks?.find((task) => task.role === (role === 'patrol' ? 'patrol' : 'controller'));
  const slot = run.slot ?? personalTask?.ledgerKey?.match(/^slot:(.+)$/)?.[1] ?? '主研发';
  const personalKey = lib.personalLedgerKey(run.tier, slot);
  const personal = facts.ledgers.find((item) => item.key === personalKey);
  if (role === 'controller' && session && personal?.owner && session !== personal.owner.sessionId) {
    return { runs: [{ req: run.req, actions: [
      action('controller', `本会话已被第 ${personal.owner.generation} 任接替，删除本会话的主控定时任务后结束`,
        [noteRef(personal)], CONTROLLER_DOC, { code: 'SUPERSEDED' }),
    ] }] };
  }
  const actions = facts.errors.map(factError);
  const reviewErrors = facts.changes.filter(({ commentError }) => commentError).map(({ commentError }) => factError(commentError));
  const win = lib.workWindow(run);
  const work = lib.windowAt(nowMs, win);
  const collaborator = run.tier === 'L3' && slot !== '主研发' && ['controller', 'patrol'].includes(role);
  for (const warning of work.inside ? facts.warnings : []) {
    if (['closed', 'merged'].includes(warning.state)) continue;
    if (collaborator && warning.slot && warning.slot !== slot) continue;
    actions.push(action('membership-notice', warning.message, [noteRef(warning)], null,
      { code: warning.code, needsLlm: false }));
  }
  const result = () => actions.length || reviewErrors.length ? { runs: [{ req: run.req, actions: [...actions, ...reviewErrors] }] } : null;
  const base = runPath.slice(0, -5);
  const statePath = (which) => `${base}.tick-state.${which}.json`;
  const loaded = readTickState(statePath(role), role, actions);
  const previous = loaded.state;
  const next = { ...previous };
  const thresholds = { ...lib.defaults, ...run.thresholds };
  const master = facts.ledgers.find((item) => item.key === 'master');
  const ownIssues = facts.subIssues.filter((item) => {
    if (run.tier !== 'L3') return true;
    const slotLabels = item.labels.filter((label) => label.startsWith('槽位'));
    return slotLabels.length ? slotLabels.length === 1 && slotLabels[0] === `槽位${slot}`
      : (personal && sameRef(personal.currentIssues, item)) || item.assignee === run.user;
  });
  const ownChanges = scopedChanges(personal, ownIssues, facts.changes);
  const offHours = !work.inside;
  const snapshot = {
    run, role, nowMs, localNow: work.now, offHours, win, ctx: { nowMs, win, offHours }, facts, master, personal, slot, ownIssues, ownChanges,
    runPath, lib, thresholds, reviews, reviewErrors, baseline: run.baselineBranch ?? run.branch, previous, next, actions, effects: [], findings: [], decisions: [], fusedChanges: [],
    reviewEvents: new Map(), rejectedSources: new Set(), changeFiles: new Map(), ownership: [],
  };
  if (role === 'controller' && personal?.state === 'open') {
    snapshot.controller = guarded(snapshot, 'controller-state', () => controllerState(personal, snapshot, previous));
  }
  if (apply) guarded(snapshot, `${role}:heartbeat`, () => refreshHeartbeat(snapshot));
  if (actions.some((item) => item.kind === 'facts-error')) return result();
  if (roleNeedsLedger(run.tier, role) && !(role === 'controller' || role === 'patrol' ? personal : master)) {
    actions.push(factError({ source: 'ledger', code: 'LEDGER_NOT_BOUND', message: '运行态未绑定本角色台账' }));
    return result();
  }
  if (master?.state === 'open' && role !== 'controller' && (role !== 'dispatch' || !offHours)) {
    guarded(snapshot, 'file-ownership', () => {
      const inline = lib.ledgerSection(master.body, 4);
      const linked = readLinkedOwnership(run, master);
      snapshot.ownership = ownershipRows(inline + '\n' + linked);
    });
  }
  if (role === 'patrol') snapshot.controllerTick = readTickState(statePath('controller'), 'controller', actions).state;
  if (role === 'lead-patrol') snapshot.dispatchTick = readTickState(statePath('dispatch'), 'dispatch', actions).state;
  const reviewChanges = role === 'dispatch' && run.tier === 'L3' ? facts.changes
    : role === 'patrol' || (role === 'controller' && run.tier !== 'L3' && !offHours) ? ownChanges : [];
  const protectedBranches = [...ENV_BRANCHES, ...splitPatterns(run.protectedEnvBranches)];
  for (const change of activeChanges(reviewChanges, snapshot.baseline).filter((item) => item.labels.some((label) => FORGE_REVIEW_LABELS.includes(label)))) {
    const ref = issueRef(change);
    guarded(snapshot, `review-events:${ref}`, () => {
      const trunk = run.repos?.find(({ repo }) => repo === change.repo)?.branch;
      if (role !== 'patrol' && isEnvironmentSource(change.source, trunk, protectedBranches)) {
        snapshot.rejectedSources.add(ref);
      } else if (role === 'patrol') {
        snapshot.reviewEvents.set(ref, readChangeLabelEvents(run, change));
      }
    });
  }
  const errorsBeforePlanning = actions.some((item) => item.kind === 'facts-error');
  if (role === 'controller') guarded(snapshot, 'controller', () => controllerActions(snapshot));
  else if (role === 'dispatch' && !offHours && !errorsBeforePlanning) planDispatch(snapshot);
  else if (role === 'patrol' || role === 'lead-patrol') guarded(snapshot, role, () => planPatrol(snapshot));
  if (findingsOnly) return actions.some(({ kind }) => kind === 'facts-error') ? null : new Set(snapshot.findings.map(({ key }) => key));
  if (!apply) {
    for (const { finding, item, key } of snapshot.findings) {
      if (!item.comments.some((note) => note.liteloopKey === key)) actions.push(action(offHours ? 'comment-planned' : 'user-report', finding.text, [noteRef(item)], PATROL_DOC, { code: finding.code, planned: 'comment', ...(offHours ? { needsLlm: false } : {}) }));
    }
    for (const effect of snapshot.effects) {
      if (effect.type === 'baseline') continue;
      if (effect.type === 'audit-verdict' || effect.type === 'retry-merge') {
        const audit = effect.type === 'audit-verdict';
        actions.push(action(effect.type, audit ? '补发终审审计评论' : '重试等待中的自动合入', [noteRef(effect.item)], REVIEW_DOC,
          { code: audit ? 'VERDICT_AUDIT_REPUBLISH' : 'AUTO_MERGE_RETRY', needsLlm: false }));
        continue;
      }
      actions.push(action('review-dispatch', effect.reason ?? effect.data?.note ?? effect.data?.comment ?? (effect.type === 'fuse' ? '登记台账待裁决事项' : '同步总台账事实'),
        [noteRef(effect.item)], REVIEW_DOC, { planned: effect.type, needsLlm: false, ...(effect.data ? { code: effect.data.code } : {}) }));
    }
    return result();
  }
  if (!actions.some((item) => item.kind === 'facts-error') && ['patrol', 'lead-patrol'].includes(role)) applyPatrolComments(snapshot);
  for (const effect of snapshot.effects) {
    if (actions.some((item) => item.kind === 'facts-error')) break;
    if (effect.type === 'audit-verdict') {
      guarded(snapshot, `verdict-audit:${issueRef(effect.item)}`, () => {
        const { commentId } = publishVerdict(run, runPath, effect.dispatch);
        actions.push(action('comment-posted', '已补发终审审计评论', [{ ...noteRef(effect.item), kind: 'change', commentId }], REVIEW_DOC,
          { code: 'VERDICT_AUDIT_REPUBLISH', needsLlm: false }));
      }, reviewErrors);
      continue;
    }
    if (effect.type === 'retry-merge') {
      guarded(snapshot, `merge-retry:${issueRef(effect.item)}`, () => {
        const result = retryReviewedMerge(run, runPath, effect.dispatch, [...facts.ledgers, ...facts.subIssues]);
        if (result.state === 'merged') {
          const { mergeSha, mergedAt, mergedBy } = result;
          Object.assign(effect.item, { mergeSha, mergedAt, mergedBy, state: 'merged', newlyMerged: true });
        }
        actions.push(action('retry-merge', result.message, [noteRef(effect.item)], REVIEW_DOC,
          { code: result.code, needsLlm: false, ...(result.followupError ? { stderr: result.followupError } : {}) }));
      }, reviewErrors);
      continue;
    }
    if (effect.type === 'review') {
      guarded(snapshot, `review-apply:${issueRef(effect.item)}`, () => applyReview(snapshot, effect), reviewErrors);
      continue;
    }
    guarded(snapshot, `${role}:${effect.type}`, () => {
      if (effect.type === 'baseline') notifyBaseline(snapshot);
      else {
        const { body, retainedProgress } = effect.type === 'master'
          ? syncMasterLedger(master, facts, snapshot.baseline, snapshot.decisions) : effect;
        if (retainedProgress) {
          const key = createHash('sha256').update(retainedProgress).digest('hex').slice(0, 20);
          writeScriptComment(snapshot, 'issue', effect.item, retainedProgress,
            `dispatch-progress:${issueRef(effect.item)}:${key}`, 'MASTER_PROGRESS_RETAINED', REVIEW_DOC);
        }
        if (body !== effect.item.body) {
          const change = createHash('sha256').update(JSON.stringify([
            effect.item.updatedAt, semanticBody(effect.item.body), semanticBody(body),
          ])).digest('hex').slice(0, 20);
          applyTickIssueBody(run, lib.configDir, effect.item, body, role === 'controller' ? personal.owner.sessionId : undefined);
          effect.item.body = body;
          const code = effect.type === 'fuse' ? 'REVIEW_FUSE_REGISTERED' : 'MASTER_LEDGER_SYNC';
          const text = effect.type === 'fuse' ? '已在台账登记全量重审的待裁决事项。' : '已按 Forge 实况同步总台账的进度和待办。';
          writeScriptComment(snapshot, 'issue', effect.item, text, `dispatch-ledger:${issueRef(effect.item)}:${change}`, code, REVIEW_DOC);
        }
      }
    });
  }
  if (!actions.some((item) => item.kind === 'facts-error') && ['patrol', 'lead-patrol'].includes(role)) {
    guarded(snapshot, 'outbox', () => flushTickNotifications(snapshot,
      offHours ? snapshot.findings.filter(isUrgentFinding) : snapshot.findings, patrolAlertStatus(runPath, nowMs, lib, run)));
  }
  if (!loaded.occupied && !reviewErrors.length && !actions.some((item) => item.kind === 'facts-error')
    && (loaded.reset || JSON.stringify(previous) !== JSON.stringify(next))) {
    guarded(snapshot, `${role}:tick-state`, () => lib.writeJson(statePath(role), next));
  }
  return result();
}

export function patrolAlertStatus(runPath, nowMs, lib, run) {
  const role = run.tier === 'L3' ? 'lead-patrol' : 'patrol';
  let current;
  return (event) => {
    const key = /^alert:(patrol:.+:[0-9a-f]{20})$/.exec(event.dedupKey)?.[1];
    if (event.kind !== 'alert' || !key) return 'active';
    if (current === undefined) {
      const read = executeTick(runPath, role, false, nowMs, lib, { findingsOnly: true });
      current = read instanceof Set ? read : null;
    }
    return current ? (current.has(key) ? 'active' : 'resolved') : 'unverified';
  };
}

export function tick(runPath, role, apply, nowMs, lib, session) {
  if (!Object.hasOwn(HEARTBEAT_FIELDS, role)) {
    throw new CliError('INVALID_TICK_ROLE', '--role 必须是 controller、dispatch、patrol 或 lead-patrol');
  }
  const failure = (error) => {
    if (error.code === 'RUN_NOT_FOUND') throw error;
    return { runs: [{ req: lib.req, actions: [factError(factFailure(role, error))] }] };
  };
  try {
    return withFileLock(tickLockPath(runPath), () => {
      let result;
      try {
        result = executeTick(runPath, role, apply, nowMs, lib, { session });
      } catch (error) {
        result = failure(error);
      }
      const actions = result?.runs[0].actions ?? [];
      if (actions[0]?.code === 'SUPERSEDED') return result;
      const summaries = actions.map(({ kind, code, refs, reason, signature, stderr }) => ({
        kind, ...(code ? { code } : {}), refs, reason, ...(signature ? { signature } : {}), ...(stderr ? { stderr } : {}),
      }));
      try {
        fs.appendFileSync(tickHistoryPath(runPath), JSON.stringify({
          at: new Date(nowMs).toISOString(), role, apply, result: actions.length ? 'actions' : 'quiet', actions: summaries,
        }) + '\n');
      } catch (error) {
        actions.push(factError({ source: role, code: 'TICK_HISTORY_WRITE_FAILED', message: `无法追加唤醒记录（${error.code ?? '未知错误'}）` }));
        return { runs: [{ req: lib.req, actions }] };
      }
      return result;
    });
  } catch (error) {
    return failure(error);
  }
}

export function tickHistoryPath(runPath) {
  return runPath.replace(/\.json$/, '.ticks.jsonl');
}

export function readTickHistory(runPath, { requireLog = false } = {}) {
  const recentTicks = Object.fromEntries(Object.keys(HEARTBEAT_FIELDS).map((role) => [role, []]));
  const scriptComments = [];
  let contents;
  try {
    contents = fs.readFileSync(tickHistoryPath(runPath), 'utf8');
  } catch (error) {
    return { recentTicks, scriptComments, ...(error.code === 'ENOENT' && !requireLog ? {} : { tickHistoryError: `无法读取唤醒记录（${error.code}）` }) };
  }
  let invalidRows = 0;
  for (const line of contents.split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      if (!row || !Object.hasOwn(recentTicks, row.role) || !Array.isArray(row.actions)) throw new Error();
      const recent = recentTicks[row.role];
      recent.unshift(row);
      if (recent.length > 5) recent.pop();
      for (const { kind, ...comment } of row.actions) {
        if (kind === 'comment-posted') scriptComments.push({ ...comment, at: row.at, role: row.role });
      }
    } catch {
      invalidRows += 1;
    }
  }
  return { recentTicks, scriptComments, ...(invalidRows ? { tickHistoryError: `${invalidRows} 条唤醒记录无法读取` } : {}) };
}
