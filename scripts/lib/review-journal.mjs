import fs from 'node:fs';
import { CliError } from './common.mjs';

/**
 * 等待记录由派审 ID 绑定同一 PR、候选 SHA 和六项风险结论。
 * @typedef {{type: 'merge-result', dispatchId: string, state: 'waiting', code: string, rejectCount: number, trial?: TrialRecord}} WaitingMerge
 * @typedef {{baseSha: string, headSha: string, command: string, exitCode: number, durationMs: number}} TrialRecord
 * @typedef {{type: 'merge-result', dispatchId: string, state: 'manual'|'merged'|'invalidated', code: string, reasonCodes?: string[], trial?: TrialRecord}} FinishedMerge
 * @typedef {{dispatchId: string, pr: {repo: string, id: number}, headSha: string, round: number, session: string,
 *   nonce: string, at: string, rejectDispatchIds?: string[], verdict?: {conclusion: '通过'|'打回', risk: Record<string, boolean>, body?: string},
 *   commentId?: number, merge?: WaitingMerge|FinishedMerge}} ReviewDispatch
 */

export const FULL_SHA = /^[\da-f]{40}$/i;

export const RISK_RULES = [
  { key: 'contract', label: '涉及契约字段或对外接口（含 MQ、RPC/Dubbo、OpenAPI）' },
  { key: 'hotFile', label: '修改公共热点文件或其他槽位持有文件的已有内容（末尾声明追加不算）' },
  { key: 'migration', label: '数据表结构或存量数据迁移变更' },
  { key: 'switchDefault', label: '改变开关默认值，或改写开关关闭时会执行的存量逻辑' },
  { key: 'signature', label: '修改其他槽位或关联仓会调用的接口/方法签名' },
  { key: 'foundation', label: '地基 PR/MR 或共用构建配置（如根 pom.xml / 顶层依赖锁文件）' },
];

export function reviewJournalPath(runPath) {
  return runPath.replace(/\.json$/, '.reviews.jsonl');
}

export function validRisk(risk) {
  return RISK_RULES.every(({ key }) => typeof risk?.[key] === 'boolean');
}

/** @returns {ReviewDispatch[]} */
export function readReviews(runPath) {
  let text;
  try {
    text = fs.readFileSync(reviewJournalPath(runPath), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const dispatches = new Map();
  for (const [index, line] of text.split('\n').entries()) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { /* Reject an incomplete or damaged journal. */ }
    const dispatch = dispatches.get(row?.dispatchId);
    if (row?.type === 'dispatch' && typeof row.dispatchId === 'string' && !dispatch
      && typeof row.pr?.repo === 'string' && Number.isSafeInteger(row.pr?.id) && row.pr.id > 0
      && Number.isSafeInteger(row.round) && row.round > 0 && typeof row.headSha === 'string' && FULL_SHA.test(row.headSha)
      && typeof row.session === 'string' && typeof row.nonce === 'string' && Number.isFinite(Date.parse(row.at))) {
      dispatches.set(row.dispatchId, { ...row, headSha: row.headSha.toLowerCase() });
    } else if (row?.type === 'verdict' && dispatch && !dispatch.verdict
      && ['通过', '打回'].includes(row.conclusion) && validRisk(row.risk)
      && (row.body === undefined || typeof row.body === 'string')) {
      dispatch.verdict = row;
    } else if (row?.type === 'published' && dispatch?.verdict && !dispatch.commentId
      && Number.isSafeInteger(row.commentId) && row.commentId > 0) {
      dispatch.commentId = row.commentId;
    } else if (row?.type === 'merge-result' && dispatch?.verdict?.conclusion === '通过' && typeof row.code === 'string'
      && (dispatch.merge === undefined || dispatch.merge.state === 'waiting')
      && (['merged', 'manual', 'invalidated'].includes(row.state)
        || (row.state === 'waiting' && Number.isSafeInteger(row.rejectCount) && row.rejectCount >= 0))) {
      dispatch.merge = row;
    } else {
      throw new CliError('INVALID_REVIEW_JOURNAL', `终审登记簿第 ${index + 1} 行无效，无法核验合入授权`);
    }
  }
  return [...dispatches.values()];
}

export function appendReview(runPath, row) {
  fs.appendFileSync(reviewJournalPath(runPath), JSON.stringify(row) + '\n', { mode: 0o600, flush: true });
}

export function reviewsFor(reviews, change) {
  return reviews.filter(({ pr }) => pr.id === Number(change.id) && pr.repo.toLowerCase() === change.repo.toLowerCase());
}
