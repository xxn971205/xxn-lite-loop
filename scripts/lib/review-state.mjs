import { FULL_SHA, validRisk } from './review-journal.mjs';

const NEEDS_CHANGES = new Set(['SOURCE_CONTAINS_MERGE_COMMITS', 'SOURCE_LINEAGE_INVALID',
  'MERGE_CONFLICT', 'MISSING_ISSUE_REF', 'TRIAL_MERGE_CONFLICT', 'TRIAL_TEST_FAILED']);
const VERDICT_LABELS = ['待终审', '终审中', '待合并', '需修改', '风险低', '风险高'];

export function reviewLabelPlan({ state, code, reasonCodes = [] }, labels) {
  const reasons = [code, ...reasonCodes];
  const desired = state === 'invalidated' ? (code === 'HEAD_SHA_MISMATCH' ? ['待终审'] : null)
    : state === 'rejected' || reasons.some((reason) => NEEDS_CHANGES.has(reason)) ? ['需修改']
    : reasons.includes('HIGH_RISK_MANUAL') ? ['风险高', '待合并']
    : reasons.includes('REJECT_FUSE_FULL_REVIEW') ? ['待合并']
    : ['风险低', ...(state === 'merged' ? [] : ['待合并'])];
  return {
    add: desired?.filter((label) => !labels.includes(label)) ?? [],
    remove: desired ? VERDICT_LABELS.filter((label) => labels.includes(label) && !desired.includes(label)) : [],
  };
}

/**
 * @typedef {import('./review-journal.mjs').ReviewDispatch} ReviewDispatch
 * @typedef {{id: number, body: string}} ReviewComment
 */

function auditRecord(note) {
  const block = /^[ \t]*<!-- liteloop:verdict ([^\r\n]+?) -->[ \t]*$/m.exec(note.body);
  if (block) {
    let data;
    try { data = JSON.parse(block[1]); } catch { return null; }
    if (typeof data?.dispatchId === 'string' && data.dispatchId && typeof data.headSha === 'string' && FULL_SHA.test(data.headSha)
      && Number.isSafeInteger(data.round) && data.round > 0 && typeof data.session === 'string' && data.session
      && ['通过', '打回'].includes(data.conclusion) && validRisk(data.risk)) {
      return { ...data, headSha: data.headSha.toLowerCase(), commentId: note.id };
    }
    return null;
  }
  const dispatch = /^已派终审：第 ([1-9]\d*) 轮 ｜ 会话标识：([^\s｜|]+) ｜ head SHA：([\da-f]{40}) ｜ 派审 ID：(\S+)\s*$/mi.exec(note.body);
  return dispatch && Number.isSafeInteger(Number(dispatch[1])) ? {
    round: Number(dispatch[1]), session: dispatch[2], headSha: dispatch[3].toLowerCase(), dispatchId: dispatch[4],
  } : null;
}

/**
 * @param {ReviewDispatch[]} history This PR's dispatches in journal order.
 * @param {ReviewComment[]} comments Top-level Forge comments for this PR.
 * @param {string|null} headSha Current Forge head.
 */
export function resolveReviewState(history, comments, headSha) {
  const current = history.at(-1);
  const audit = comments.map(auditRecord).filter(Boolean);
  const records = [...history, ...audit];
  const rejectedDispatchIds = [...new Set([
    ...history.flatMap(({ rejectDispatchIds, dispatchId, verdict }) => [
      ...(rejectDispatchIds ?? []),
      ...(verdict?.conclusion === '打回' ? [dispatchId] : []),
    ]),
    ...audit.filter(({ conclusion }) => conclusion === '打回').map(({ dispatchId }) => dispatchId),
  ])];
  const state = !current ? 'awaiting-dispatch'
    : current.headSha.toLowerCase() !== headSha?.toLowerCase() ? 'head-changed'
    : current.verdict?.conclusion === '打回' ? 'rejected'
    : current.verdict ? 'recorded' : 'in-review';
  return {
    state,
    rejectCount: rejectedDispatchIds.length,
    rejectDispatchIds: rejectedDispatchIds,
    round: records.reduce((max, { round }) => Math.max(max, round), 0) + 1,
    usedSessions: [...new Set(records.map(({ session }) => session))],
  };
}

export function isWaitingMerge(dispatch, change) {
  return dispatch?.merge?.state === 'waiting'
    && dispatch.headSha.toLowerCase() === change.headSha?.toLowerCase()
    && ['open', 'merged'].includes(change.state) && !change.draft
    && !change.labels.some((label) => ['待终审', '需修改', '终审中'].includes(label));
}

export function hasRejectFuse(merge) {
  return merge?.code === 'REJECT_FUSE_FULL_REVIEW' || merge?.reasonCodes?.includes('REJECT_FUSE_FULL_REVIEW');
}
