import { forgeRecordUrl } from '../forge.mjs';
import { ledgerSection } from '../guard.mjs';
import { describeAction } from './action-messages.mjs';
import { protectedMergeBaseline } from './common.mjs';
import { dispatchSlot, escalationsFor, ledgerField, pendingLines } from './tick-dispatch.mjs';

const ROLE_NAMES = { controller: '主控', patrol: '小巡检', dispatch: '调度', 'lead-patrol': '大巡检' };

export function describeMergeMode(run) {
  return run.autoMerge === true && !protectedMergeBaseline(run) ? '自动合并低风险变更' : '全部人工合并';
}

export function mergeModeFromMaster(run, master) {
  if (protectedMergeBaseline(run)) return false;
  if (!master) return null;
  const latest = master.comments.filter(({ body }) => /^巡检脚本 ｜ 主研发 ｜ MERGE_MODE_(AUTO|MANUAL)\r?\n【配置变更】/.test(body))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)[0];
  if (latest) return latest.body.split(/\r?\n/, 1)[0].endsWith('_AUTO');
  const value = ledgerField(ledgerSection(master.body, 1), '合并方式');
  return value === '自动合并低风险变更' ? true : value === '全部人工合并' ? false : null;
}

function localTime(at, today) {
  const date = new Date(at);
  if (!at || !Number.isFinite(date.valueOf())) return '时间未知';
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === today.toDateString() ? time
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function awaitingUser(run, facts, personal, master, slot) {
  const items = [personal, master].filter((ledger) => ledger?.state === 'open');
  const pending = items.flatMap((ledger) => pendingLines(ledgerSection(ledger.body, ledger.key === 'tracking' ? 4 : 2))
    .map(({ kind, text }) => ({ text: `请${kind === '待裁决' ? '裁决' : '确认'}${text}`, url: forgeRecordUrl(run, ledger) })));
  if (master?.state === 'open') {
    const escalation = facts.ledgers.find((item) => item.key === 'escalation' && item.state === 'open');
    for (const item of escalationsFor(escalation, master, ledgerSection)) {
      if (!item.blocking || item.adjudicated) continue;
      const label = `请裁决${item.id}`;
      const task = pending.find(({ text }) => text.startsWith(label));
      const url = forgeRecordUrl(run, { ...escalation, commentId: item.note.id });
      if (task) task.url = url;
      else pending.push({ text: `请裁决「${ledgerField(item.note.body, '问题') ?? '阻断事项'}」`, url });
    }
  }
  if (run.tier !== 'L3' || slot === '主研发') {
    for (const change of facts.changes) {
      if (change.state !== 'open' || change.draft) continue;
      const title = change.title?.replace(/\s+/g, ' ').trim() || `变更 #${change.id}`;
      const url = forgeRecordUrl(run, { ...change, kind: 'change' });
      if (change.mergeWaiting && run.autoMerge === true) continue;
      const inReview = change.labels.includes('终审中') && !change.labels.includes('待终审');
      const manual = inReview && ['recorded', 'awaiting-dispatch'].includes(change.review?.state);
      if (!manual && !change.labels.includes('待合并')) continue;
      if (change.review?.state === 'rejected') continue;
      if (pending.some(({ text }) => text.includes(`${change.repo}#${change.id}`) || (change.url && text.includes(change.url)))) continue;
      pending.push({ text: `请人工处理「${title}」的合入`, url });
    }
  }
  return pending.map(({ text, url }) => `${text}。${url ? ` ${url}` : ''}`);
}

export function formatStatus(status, run, today = new Date()) {
  const summary = status.run ?? status.activeRuns?.find(({ req }) => req === run?.req);
  const archived = status.state === 'archived';
  const title = run?.title ?? run?.req;
  const tier = run?.tier ?? '未登记';
  const baseline = run?.baselineBranch ?? run?.branch ?? '未登记';
  const collaborator = tier === 'L3' && dispatchSlot(run) !== '主研发';
  const mergeMode = collaborator && !archived
    ? summary?.autoMerge == null ? '等待从总台账核实' : describeMergeMode({ ...run, autoMerge: summary.autoMerge })
    : describeMergeMode(run);
  const otherRuns = (status.activeRuns?.length ?? 1) - 1;
  const header = title
    ? [`需求 ${title} ｜ 档位 ${tier} ｜ 需求基线 ${baseline}${archived ? ' ｜ 已归档' : ''}`,
      `合并方式：${mergeMode}`,
      ...(otherRuns > 0 ? [`另有 ${otherRuns} 个进行中的需求，用 --req 指定要查看的需求`] : [])]
    : [status.needsOnboarding ? '本机尚未完成初始配置' : '当前没有进行中的需求'];

  const facts = status.live?.forgeFacts;
  const errors = facts?.errors.length ?? 0;
  const slot = run ? dispatchSlot(run) : null;
  const personal = facts?.ledgers.find((item) => item.key === ({ L1: 'tracking', L2: 'main', L3: `slot:${slot}` })[tier]);
  const master = slot === '主研发' ? facts?.ledgers.find((item) => item.key === 'master') : null;
  const ledger = master ?? personal;
  const ledgerUrl = ledger && forgeRecordUrl(run, ledger);
  let progress = '暂无可核实的子任务和合入记录';
  if (errors) progress = `代码平台有 ${errors} 项读取失败，暂时无法核实完整进度`;
  else if (facts) {
    const changes = facts.changes.filter((change) => change.target === baseline && !change.draft && ['open', 'merged'].includes(change.state));
    progress = `子任务已完成 ${facts.subIssues.filter((issue) => issue.state === 'closed').length}/${facts.subIssues.length}，变更已合入 ${changes.filter((change) => change.state === 'merged').length}/${changes.length}`;
  }
  const pending = facts ? awaitingUser(run, facts, personal, master, slot) : [];
  for (const warning of facts?.warnings ?? []) {
    if (['closed', 'merged'].includes(warning.state)) continue;
    pending.push(`${warning.message}。 ${forgeRecordUrl(run, warning)}`);
  }
  const ledgerLink = ledgerUrl ? ` ${ledgerUrl}` : '';
  if (summary?.pendingUpgrade) pending.push(`请确认升档所需的台账和定时器已就绪。${ledgerLink}`);
  if (summary?.pendingTeardown) pending.push(`请核对归档前的清理清单。${ledgerLink}`);
  const waiting = [pending.join(' ｜ '), errors ? '还有待办未能核实' : null].filter(Boolean);
  if (!waiting.length) waiting.push(run && !archived && !ledger ? '暂无台账实况，待办还未核实' : '没有要你处理的事');

  const recent = summary?.recentTicks ?? {};
  const wakes = Object.entries(ROLE_NAMES).flatMap(([role, name]) => {
    const records = (recent[role] ?? []).slice(0, 5);
    if (!records.length) return [];
    const lines = [];
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const preview = row.apply === false ? '预览 · ' : '';
      const messages = [...new Set(row.actions.map(describeAction))];
      if (messages.length) {
        lines.push(`${localTime(row.at, today)} ${preview}${messages.join('，')}`);
        continue;
      }
      let end = i;
      while (end + 1 < records.length && !records[end + 1].actions.length && records[end + 1].apply === row.apply) end++;
      const from = localTime(records[end].at, today);
      const to = localTime(row.at, today);
      const sameDay = from.length > 5 && to.slice(0, -5) === from.slice(0, -5);
      lines.push(end === i ? `${to} ${preview}安静`
        : `${from}–${sameDay ? to.slice(-5) : to} ${preview}安静 ${end - i + 1} 次`);
      i = end;
    }
    return [name, ...lines];
  });
  if (summary?.tickHistoryError) wakes.push('部分本机唤醒记录无法读取');

  const comments = errors ? [...(status.live?.scriptComments ?? []), ...(summary?.scriptComments ?? [])]
    : status.live?.scriptComments ?? summary?.scriptComments ?? [];
  const links = new Map();
  for (const note of comments.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    if (!note.commentId) continue;
    const url = forgeRecordUrl(run, note);
    if (url && !links.has(url)) links.set(url, `${localTime(note.at, today)} ${url}`);
    if (links.size === 5) break;
  }
  return [
    header,
    ['进度', progress + (ledgerUrl ? `  ${ledgerUrl}` : '')],
    ['等你处理', ...waiting],
    ['最近唤醒', ...(wakes.length ? wakes : ['本机暂无唤醒记录'])],
    ['巡检脚本最近写过的评论', [...links.values()].join(' ｜ ') || '暂无评论记录'],
  ].map((lines) => lines.join('\n')).join('\n\n');
}
