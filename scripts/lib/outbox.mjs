import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CliError, forgeHostArgs, withFileLock, tickLockPath } from './common.mjs';
import { issueRef, ledgerField, reviewRef } from './tick-dispatch.mjs';
import { botIm } from './lark-im.mjs';
import { describeAction } from './action-messages.mjs';

const KINDS = ['daily', 'alert', 'contract-sync'];
const KINDS_BY_TIER = { L1: [], L2: ['alert'], L3: KINDS };
const STATUSES = ['awaiting-confirm', 'pending', 'sent', 'failed', 'suppressed'];
const MAX_ATTEMPTS = 3;
const ALERT_WORK_HOURS = 24;
const PATROL_DOC = 'references/patrol-and-notify.md';

function audienceFor(run, kind, people) {
  if (!KINDS_BY_TIER[run.tier]?.includes(kind)) return null;
  const settings = run.notify ?? {};
  const validId = (value, prefix) => typeof value === 'string' && value.startsWith(prefix) && /^[a-z0-9_]+$/i.test(value);
  const memberId = (person) => {
    const entry = Object.hasOwn(settings.memberOpenIds ?? {}, person) ? settings.memberOpenIds[person] : null;
    return validId(entry, 'ou_') ? entry : null;
  };
  const chatId = settings.feishuGroupChatId;
  if (validId(chatId, 'oc_')) {
    const mentions = kind === 'daily' ? ['all'] : [...new Set(people.map(memberId).filter(Boolean))];
    if (kind === 'alert' && people.length && !mentions.length) return null;
    return { chatId, mentions };
  }
  if (run.tier === 'L2') {
    const userId = settings.feishuUserOpenId ?? memberId(run.user);
    if (validId(userId, 'ou_')) return { chatId: null, userId, mentions: [] };
  }
  return null;
}

function eventWindow(run, audience, nowMs, lib) {
  const win = audience?.chatId ? lib.mentionWindow(run) : lib.workWindow(run);
  return lib.windowAt(nowMs, win);
}

function readEvents(file, req, lib) {
  if (!fs.existsSync(file)) return [];
  const items = lib.readJson(file);
  if (!Array.isArray(items) || items.some((item) => !item || item.run !== req || !item.id || !item.dedupKey
    || !KINDS.includes(item.kind) || !STATUSES.includes(item.status) || !Number.isInteger(item.attempts) || item.attempts < 0
    || typeof item.text !== 'string' || !Number.isFinite(Date.parse(item.notBefore))
    || (item.expiresAt != null && !Number.isFinite(Date.parse(item.expiresAt)))
    || (['pending', 'failed', 'awaiting-confirm'].includes(item.status) && (!item.audience || !Array.isArray(item.audience.mentions))))) {
    throw new CliError('INVALID_OUTBOX', '出站队列结构无效，无法确认历史送达状态');
  }
  const ids = new Set();
  const latest = new Map();
  for (const event of items) {
    const previous = latest.get(event.dedupKey);
    if (ids.has(event.id) || (previous && previous.status !== 'suppressed')) {
      throw new CliError('INVALID_OUTBOX', '出站队列存在重复的发送记录，无法确认历史送达状态');
    }
    ids.add(event.id);
    latest.set(event.dedupKey, event);
  }
  return items;
}

function send(event) {
  const { audience } = event;
  const text = event.text.replace(/<\/?at(?=[\s>])/gi, (tag) => tag.replace('<', '＜'));
  const content = {
    zh_cn: { content: [[...audience.mentions.map((user_id) => ({ tag: 'at', user_id })), { tag: 'text', text }]] },
  };
  const { message_id: messageId } = botIm([
    '+messages-send', '--as', 'bot', ...(audience.chatId ? ['--chat-id', audience.chatId] : ['--user-id', audience.userId]),
    '--msg-type', 'post', '--content', JSON.stringify(content), '--idempotency-key', event.id,
  ]);
  if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('lark-cli 未返回发送成功回执');
  return messageId;
}

function notifyAction(kind, reason, event) {
  return {
    kind, reason, refs: [event.id], entryDoc: PATROL_DOC, needsLlm: kind !== 'notify-sent',
    dedupKey: event.dedupKey, ...(event.messageId ? { messageId: event.messageId } : {}),
  };
}

export function openOutbox(runPath, run, nowMs, lib) {
  const file = runPath.replace(/\.json$/, '.outbox.json');
  const events = readEvents(file, run.req, lib);
  const save = () => lib.writeJson(file, events);
  const disabled = run.notify?.externalNotifyDisabled === true;
  const win = lib.workWindow(run);
  const work = lib.windowAt(nowMs, win);
  const today = work.now.slice(0, 10);
  const enqueue = ({ kind, dedupKey, text, confirmRequired = false, people = [] }) => {
    if (!KINDS.includes(kind)) throw new CliError('INVALID_NOTIFY_KIND', '--kind 必须是 daily、alert 或 contract-sync');
    if (!KINDS_BY_TIER[run.tier]?.includes(kind)) {
      const message = kind === 'daily' ? '日报仅 L3 大巡检可投递' : `${run.tier} 无法投递 ${kind} 类型的通知`;
      throw new CliError('NOTIFY_KIND_UNAVAILABLE', message);
    }
    const existing = events.findLast((item) => item.dedupKey === dedupKey);
    const audience = audienceFor(run, kind, people);
    const timing = eventWindow(run, audience, nowMs, lib);
    const needsConfirm = confirmRequired || kind === 'contract-sync';
    const repeatable = existing?.kind === 'alert' && !existing.confirmRequired
      && !['sent', 'awaiting-confirm'].includes(existing.status) && kind === 'alert' && !needsConfirm;
    if (repeatable && existing.status !== 'suppressed' && Date.parse(existing.expiresAt) <= nowMs) {
      existing.status = 'suppressed';
      save();
    }
    const recovered = repeatable && existing.status === 'suppressed' && !disabled && audience && work.inside && timing.inside;
    if (existing && !recovered) {
      if (kind === 'daily' && !['sent', 'suppressed'].includes(existing.status) && existing.text !== text) {
        existing.text = text;
        save();
      }
      return { event: existing, duplicate: existing.status === 'sent' };
    }
    const expiresAt = kind === 'alert' && !needsConfirm
      ? new Date(lib.addWorkingHours(nowMs, ALERT_WORK_HOURS, win)).toISOString() : null;
    const identity = [run.forge, forgeHostArgs(run)[1] ?? null, run.hubRepo?.repo, run.req, dedupKey];
    if (existing) identity.push(existing.id);
    const event = {
      id: createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32),
      run: run.req, kind, dedupKey, people, audience: audience ?? { chatId: null, mentions: [] },
      notBefore: timing.deferredUntil ?? timing.now, createdAt: work.now, expiresAt, confirmRequired: needsConfirm, text,
      ...(kind === 'daily' ? { day: today } : {}),
      status: needsConfirm ? 'awaiting-confirm' : expiresAt && (disabled || !audience) ? 'suppressed' : 'pending',
      attempts: 0, messageId: null, lastError: null,
    };
    events.push(event);
    save();
    return { event, duplicate: false };
  };
  const confirm = (id) => {
    const event = events.find((item) => item.id === id);
    if (!event) throw new CliError('NOTIFY_EVENT_NOT_FOUND', '出站队列没有该事件');
    if (event.status === 'awaiting-confirm') {
      event.confirmRequired = true;
      event.status = 'pending';
      save();
    }
    return event;
  };
  const flush = (reportTerminal = false, reportUser = true, alertStatus = () => 'active') => {
    const actions = [];
    const canReport = reportUser && work.inside;
    const dayOf = (event) => event.day ?? /^daily:(\d{4}-\d{2}-\d{2})$/.exec(event.dedupKey)?.[1];
    const latestDaily = events.findLast((event) => event.kind === 'daily' && dayOf(event) === today && event.status !== 'suppressed');
    const dailyAlreadySent = events.some((event) => event.kind === 'daily' && dayOf(event) === today && event.status === 'sent');
    for (const event of events) {
      if (['sent', 'suppressed'].includes(event.status)) continue;
      const ordinary = event.kind === 'alert' && !event.confirmRequired && event.status !== 'awaiting-confirm';
      if (ordinary && event.expiresAt === undefined) {
        event.expiresAt = new Date(lib.addWorkingHours(Date.parse(event.notBefore), ALERT_WORK_HOURS, win)).toISOString();
        save();
      }
      if ((ordinary && (Date.parse(event.expiresAt) <= nowMs || (!event.audience?.chatId && !event.audience?.userId)))
        || (event.kind === 'daily' && (event !== latestDaily || dailyAlreadySent))) {
        event.status = 'suppressed';
        save();
        continue;
      }
      if (disabled) continue;
      const oldMentions = new Set(event.audience?.mentions ?? []);
      const people = event.people ?? Object.entries(run.notify?.memberOpenIds ?? {})
        .filter(([, id]) => oldMentions.has(id)).map(([person]) => person);
      const audience = audienceFor(run, event.kind, people);
      if (!audience) continue;
      const timing = eventWindow(run, audience, nowMs, lib);
      const moved = event.audience?.chatId !== audience.chatId || event.audience?.userId !== audience.userId;
      const mentionsChanged = JSON.stringify(event.audience?.mentions) !== JSON.stringify(audience.mentions);
      if (moved || mentionsChanged) {
        if (moved) event.notBefore = timing.deferredUntil ?? timing.now;
        event.audience = audience;
        save();
      }
      if (event.status === 'awaiting-confirm') {
        if (canReport) actions.push(notifyAction('notify-awaiting-confirm', '外部通知等待本人确认', event));
        continue;
      }
      if (event.attempts >= MAX_ATTEMPTS) {
        if (canReport && (reportTerminal || event.lastError === '发送中断，结果待核对' || event.reportPending)) {
          actions.push(notifyAction('user-report', '外部通知三次尝试后停止重试，请核对送达结果', event));
          if (!reportTerminal) {
            if (event.lastError === '发送中断，结果待核对') event.lastError = '发送中断，已汇报待核对';
            delete event.reportPending;
            save();
          }
        }
        continue;
      }
      if (Date.parse(event.notBefore) > nowMs) continue;
      if (!work.inside || !timing.inside) {
        const boundaries = [work.deferredUntil, timing.deferredUntil].filter(Boolean);
        event.notBefore = boundaries.reduce((later, next) => Date.parse(next) > Date.parse(later) ? next : later);
        save();
        continue;
      }
      const status = alertStatus(event);
      if (status === 'resolved') {
        event.status = 'suppressed';
        save();
        continue;
      }
      if (status === 'unverified') {
        if (canReport) actions.push(notifyAction('facts-error', '发送前无法核实提醒对应的事项，已保留待核实', event));
        continue;
      }
      event.attempts += 1;
      event.status = 'failed';
      event.lastError = '发送中断，结果待核对';
      save();
      try {
        event.messageId = send(event);
        event.status = 'sent';
        event.lastError = null;
      } catch (error) {
        event.lastError = error.message;
      }
      if (event.status === 'sent') actions.push(notifyAction('notify-sent', '外部通知已送达', event));
      else if (event.attempts >= MAX_ATTEMPTS) {
        if (canReport) actions.push(notifyAction('user-report', '外部通知三次尝试后仍未收到成功回执，请核对送达结果', event));
        else event.reportPending = true;
      }
      save();
    }
    return actions;
  };
  return { enqueue, confirm, flush };
}

function concise(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0].slice(0, 120);
}

function dailyText(snapshot, date) {
  const { run, facts, master, baseline, lib } = snapshot;
  const issues = facts.subIssues;
  const opened = issues.filter((issue) => issue.state === 'open');
  const merged = facts.changes.filter((change) => change.target === baseline && change.state === 'merged');
  const verification = issues.filter((issue) => issue.comments.some((note) => /^(?:【)?复测通过/m.test(note.body)));
  const notes = facts.ledgers.flatMap((ledger) => ledger.comments).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const summaries = (rows) => rows.slice(0, 3).map((note) => concise(note.body.split(/\r?\n/).find((line) => /^【/.test(line)))).filter(Boolean).join('；') || '暂无记录';
  const unresolved = notes.filter((note) => note.prefix === '提醒' && !note.replied);
  const blockers = opened.filter((issue) => issue.labels.includes('阻断'));
  const report = [
    `${run.title ?? run.req}｜${date} 日报`,
    `整体进度：${ledgerField(lib.ledgerSection(master.body, 1), '当前阶段') ?? '阶段待核实'}。已关闭子任务 ${issues.length - opened.length}/${issues.length}，已合入需求基线 ${merged.length} 项。有明确复测通过记录的子任务 ${verification.length} 项。`,
    `提醒与待裁决：未回复提醒 ${unresolved.length} 条，待裁决 ${(lib.ledgerSection(master.body, 2).match(/^[ \t]*(?:[-*+][ \t]*)?\[待裁决\]/gm) ?? []).length} 项。`,
    `近期记录：提醒 ${summaries(notes.filter((note) => note.prefix === '提醒'))}。已裁决 ${summaries(notes.filter((note) => note.prefix === '裁决'))}。`,
    `风险：${blockers.length ? blockers.map((issue) => concise(issue.title ?? issueRef(issue))).join('、') : '未发现标记为阻断的子任务'}。`,
    `研发进度：${opened.length ? opened.map((issue) => `${issue.assignee ?? '负责人待定'} · ${concise(issue.title ?? issueRef(issue))}`).join('；') : '暂无打开的子任务'}。`,
  ];
  return report.join('\n');
}

export function flushTickNotifications(snapshot, findings, alertStatus) {
  const { role, run, nowMs, runPath, lib, actions, master } = snapshot;
  if (!(role === 'lead-patrol' && run.tier === 'L3' && master?.state === 'open')
    && !(role === 'patrol' && run.tier === 'L2' && snapshot.personal?.state === 'open')) return;
  const outbox = openOutbox(runPath, run, nowMs, lib);
  if (role === 'lead-patrol' && !snapshot.offHours && run.notify?.dailyReportEnabled
    && lib.hm(snapshot.localNow.slice(11, 16)) >= lib.hm(run.notify.dailyReportTime ?? '10:00')) {
    const date = snapshot.localNow.slice(0, 10);
    outbox.enqueue({ kind: 'daily', dedupKey: `daily:${date}`, text: dailyText(snapshot, date) });
  }
  for (const { finding, item, key } of findings) {
    const people = role === 'patrol' ? [run.user] : (finding.recipients ?? []).map((person) => person.person).filter(Boolean);
    if (role === 'lead-patrol' && !people.length) continue;
    const detail = concise(finding.text).replace(/^【[^】]+】/, '');
    outbox.enqueue({
      kind: 'alert', dedupKey: `alert:${key}`, people,
      text: `${concise(item.title ?? run.title ?? run.req)}｜${describeAction(finding)}。\n${detail}\n记录：${reviewRef(item)}`,
    });
  }
  actions.push(...outbox.flush(false, !snapshot.offHours, alertStatus));
}

export function runNotification(runPath, nowMs, lib, operation) {
  return withFileLock(tickLockPath(runPath), () => {
    const run = lib.readJson(runPath, 'RUN_NOT_FOUND');
    if (run.status === 'archived') throw new CliError('RUN_ARCHIVED', '该需求已归档');
    return operation(openOutbox(runPath, run, nowMs, lib), run);
  });
}
