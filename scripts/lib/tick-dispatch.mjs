export function dispatchSlot(run) {
  return run.slot ?? run.scheduledTasks?.find((task) => task.role === 'controller')?.ledgerKey?.match(/^slot:(.+)$/)?.[1] ?? '主研发';
}

export function issueRef(item) {
  return `${item.repo.toLowerCase()}#${item.id}`;
}

export function sameRef(refs, item) {
  return refs.some((ref) => issueRef(ref) === issueRef(item));
}

export function scopedChanges(ledger, issues, changes) {
  if (!ledger) return [];
  const slot = ledger.key.startsWith('slot:') ? ledger.key.slice(5) : null;
  return changes.filter((item) => {
    if (!slot) return true;
    const slotLabels = item.labels.filter((label) => label.startsWith('槽位'));
    return slotLabels.length ? slotLabels.length === 1 && slotLabels[0] === `槽位${slot}`
      : sameRef(ledger.changeRefs, item) || sameRef(item.issueRefs, ledger) || issues.some((issue) => sameRef(item.issueRefs, issue));
  });
}

export function ledgerField(body, name) {
  return new RegExp(`(?:^|[｜|])\\s*${name}[：:]\\s*([^｜|\\r\\n]+)`, 'm').exec(body)?.[1].trim() ?? null;
}

export function pendingLines(body) {
  return [...body.matchAll(/^\s*(?:[-*+]\s+)?\[(待本人确认|待确认|待裁决)\]\s*(.+)$/gm)]
    .map((match) => ({ kind: match[1], text: match[2].trim() }));
}

export function commentSignature(body) {
  const match = /^([^\r\n｜|]+)[｜|]([^\r\n｜|]+)[｜|]\s*([^\s｜|]+)\s*\r?\n/.exec(body);
  return match && { role: match[1].trim(), slot: match[2].trim(), sessionId: match[3], text: body.slice(match[0].length) };
}

export function reviewRef(change) {
  return change.url ?? issueRef(change);
}

export function withPendingDecisions(body, section, decisions) {
  if (!decisions.length) return body;
  const heading = new RegExp(`^ {0,3}##\\s+${section}[.、．]\\s+[^\\r\\n]+(\\r?\\n)`, 'm').exec(body);
  if (!heading) return body;
  const start = heading.index + heading[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/^ {0,3}#{1,2}(?:\s|(?=\d))/m);
  const sectionBody = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  const lines = sectionBody.split(/\r?\n/).map((line) => line.trim());
  const added = [...new Set(decisions)].map((ref) => `- [待裁决] ${ref}`).filter((line) => !lines.includes(line));
  return body.slice(0, start) + added.map((line) => line + heading[1]).join('')
    + sectionBody.replace(/^[ \t]*(?:-[ \t]+)?无[ \t]*(?:\r?\n|$)/gm, '')
    + rest.slice(sectionBody.length);
}

const ESCALATION_ID = /升级-([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)-\d+(?![\p{L}\p{N}_-])/gu;
const ESCALATION_HEADER = /^(升级-([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)-\d+)\s*[｜|][^\r\n｜|]+[｜|]\s*(阻断|非阻断)(?=$|\s|[｜|])/mu;

export function decisionIds(note, ledger) {
  const parent = note.replyTo && ledger.comments.find(({ id }) => id === note.replyTo);
  const linked = parent && ESCALATION_HEADER.exec(parent.body);
  return linked ? [linked[1]] : [...note.body.matchAll(ESCALATION_ID)].map(([id]) => id);
}

export function escalationsFor(ledger, master, ledgerSection) {
  if (!ledger) return [];
  const verdicts = new Set(ledger.comments.filter((note) => note.prefix === '裁决')
    .flatMap((note) => decisionIds(note, ledger)));
  const decisions = ledgerSection(master?.body, 2);
  return ledger.comments.flatMap((note) => {
    const record = ESCALATION_HEADER.exec(note.body);
    if (!record) return [];
    const [, id, slot, severity] = record;
    return [{ id, note, slot, since: note.createdAt, blocking: severity === '阻断', adjudicated: verdicts.has(id),
      listed: decisions.includes(id) }];
  });
}

export function syncMasterLedger(master, facts, baseline, decisions) {
  const changes = facts.changes.filter((change) => change.target === baseline && !change.draft && ['open', 'merged'].includes(change.state));
  const merged = changes.filter((change) => change.state === 'merged');
  const total = facts.subIssues.length;
  const complete = facts.subIssues.filter((issue) => issue.state === 'closed').length;
  let body = master.body;
  let retainedProgress = null;
  const progress = /^整体进度[：:].*$/m;
  if (progress.test(body)) {
    body = body.replace(progress, (line) => {
      const known = /Issue 已完成 (\d+)\/(\d+)/.exec(line);
      const retain = known && (complete < Number(known[1]) || total < Number(known[2]));
      if (retain) retainedProgress = `总台账子 Issue 计数保留 ${known[1]}/${known[2]}。本轮 Forge 采集为 ${complete}/${total}，请核对台账引用和归档记录。`;
      const issues = retain ? line : line.replace(/Issue 已完成 \d+\/\d+/, `Issue 已完成 ${complete}/${total}`);
      return issues.replace(/PR\/MR 已合入 \d+\/\d+/, `PR/MR 已合入 ${merged.length}/${changes.length}`);
    });
  }
  return { body: withPendingDecisions(body, 2, decisions), retainedProgress };
}
