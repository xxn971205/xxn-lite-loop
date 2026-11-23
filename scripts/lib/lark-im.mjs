import { spawnSync } from 'node:child_process';
import { CliError } from './common.mjs';

const isChatId = (value) => typeof value === 'string' && /^oc_[a-z0-9_]+$/i.test(value);

export function botIm(args) {
  const result = spawnSync(process.env.LARK_CLI_BIN || 'lark-cli', ['im', ...args, '--format', 'json'], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  });
  if (result.error) throw new CliError('LARK_CLI_FAILED', `lark-cli 执行失败（${result.error.code ?? '未知错误'}）`);
  let parsed;
  for (const output of result.status === 0 ? [result.stdout] : [result.stderr, result.stdout]) {
    try { parsed = JSON.parse(output); break; } catch { /* 尝试另一输出流的结构化回执 */ }
  }
  if (result.status !== 0 || parsed?.ok === false || (parsed?.code != null && parsed.code !== 0) || !parsed) {
    const code = parsed?.error?.code ?? parsed?.error?.type ?? parsed?.code ?? result.status;
    if (String(code) === '232011') {
      throw new CliError('LARK_BOT_NOT_IN_CHAT', '发送通知的机器人不在目标群里。请在目标群的「群设置 → 群机器人」里添加它，再重试绑定。');
    }
    throw new CliError('LARK_CLI_FAILED', `lark-cli 请求未成功（${code}）`);
  }
  return parsed.data ?? parsed;
}

function listPages(args, key) {
  const items = [];
  const seen = new Set();
  let token;
  do {
    const page = botIm([...args, ...(token ? ['--page-token', token] : [])]);
    if (!Array.isArray(page[key]) || (page.has_more && (!page.page_token || seen.has(page.page_token)))) {
      throw new CliError('INVALID_LARK_RESPONSE', '飞书列表或翻页回执不完整，无法确认绑定');
    }
    items.push(...page[key]);
    token = page.has_more ? page.page_token : null;
    seen.add(token);
  } while (token);
  return items;
}

export function verifyGroup(chat) {
  let chatId = chat;
  if (!isChatId(chat)) {
    const hits = listPages(['+chat-search', '--as', 'bot', '--query', chat, '--disable-search-by-user', '--page-size', '100'], 'chats');
    const exact = [...new Map(hits.filter((item) => item?.name?.trim() === chat && isChatId(item.chat_id))
      .map(({ name, chat_id, description }) => [chat_id, { name, chatId: chat_id, description }])).values()];
    if (exact.length > 1) throw new CliError('LARK_CHAT_AMBIGUOUS', '发现多个同名群。请选定群后用 chat_id 重试。', { candidates: exact });
    if (!exact.length) {
      throw new CliError('LARK_CHAT_NOT_FOUND', '发送通知的机器人看不到该群名。请把它添加到目标群后重试，或提供群的 chat_id。');
    }
    chatId = exact[0].chatId;
  }
  // 飞书要求调用者已在群内才能读取成员。每页都使用发送通知的 bot 身份。
  const members = listPages(['chat.members', 'get', '--as', 'bot', '--chat-id', chatId, '--member-id-type', 'open_id'], 'items');
  const info = botIm(['chats', 'get', '--as', 'bot', '--chat-id', chatId]);
  if (!['group', 'topic'].includes(info.chat_mode) || ['dissolved', 'dissolved_save'].includes(info.chat_status)) {
    throw new CliError('LARK_NOT_ACTIVE_GROUP', '请提供一个仍在使用的飞书群');
  }
  if (info.external && (!info.tenant_key || members.some((member) => member?.tenant_key !== info.tenant_key))) {
    throw new CliError('LARK_CROSS_TENANT_CHAT', '该外部群的成员无法核实为同一飞书租户。请使用同租户的飞书群。');
  }
  return { chatId, name: info.name?.trim() || chatId, members };
}
