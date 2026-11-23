import { commentSignature } from './tick-dispatch.mjs';

export function slotKey(value) {
  return String(value ?? '').trim().replace(/^槽位/, '');
}

function compareIds(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b) ? -1 : (BigInt(a) > BigInt(b) ? 1 : 0);
  return a.localeCompare(b);
}

export function forgeSlotClaims({ comments, url, fragment }) {
  const claims = new Map();
  const withdrawn = new Set();
  const ledger = new URL(url);
  for (const note of comments) {
    const signed = commentSignature(note.body);
    if (signed?.role !== '主控') continue;
    const text = signed.text.split(/\r?\n/, 1)[0];
    const binding = /^【配置变更】绑定\s+槽位([^\s｜|]+)(?=\s*[｜|]|$)/.exec(text);
    if (binding && slotKey(signed.slot) === binding[1]) {
      claims.set(note.id, { slot: binding[1], commentId: note.id, user: note.author, sessionId: signed.sessionId, createdAt: note.createdAt });
      continue;
    }
    const withdrawal = /^【配置变更】撤回绑定[：:]\s*槽位([^\s｜|]+)\s*[｜|]\s*原评论链接\s+(https?:\/\/[^\s｜|]+)/.exec(text);
    if (!withdrawal || slotKey(signed.slot) !== withdrawal[1] || !URL.canParse(withdrawal[2])) continue;
    const linked = new URL(withdrawal[2]);
    const hash = linked.hash.match(new RegExp(`^#${fragment}([1-9]\\d*)$`));
    if (linked.host !== ledger.host || linked.pathname !== ledger.pathname || !hash) continue;
    const claimId = Number(hash[1]);
    const claim = claims.get(claimId);
    if (claim?.slot === withdrawal[1] && claim.user && claim.user.toLowerCase() === note.author?.toLowerCase()) withdrawn.add(claimId);
  }
  return [...claims.values()].map((claim) => ({ ...claim, withdrawn: withdrawn.has(claim.commentId) }));
}

export function activeSlotClaims(claims, slot, isWithdrawn = (claim) => claim.withdrawn, toTime = Date.parse) {
  return claims.filter((claim) => claim && slotKey(claim.slot) === slot)
    .map((claim) => ({ ...claim, claimId: String(claim.claimId ?? claim.commentId ?? ''), at: toTime(claim.createdAt ?? claim.at) }))
    .filter((claim) => !isWithdrawn(claim))
    .sort((a, b) => (a.at - b.at) || compareIds(a.claimId, b.claimId));
}
