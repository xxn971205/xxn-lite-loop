#!/usr/bin/env node
/**
 * install-hooks.mjs — 把 xxn-lite-loop 的薄守卫幂等注册到各 Agent 的 PreToolUse。
 *
 * 原则：
 *   1. 绝不覆盖用户现有 hooks：只增删带 `xxn-lite-loop:guard-command` 标识的条目。
 *   2. 幂等：重复执行结果一致；--uninstall 只摘自己的条目。
 *   3. 非破坏：目标文件不是合法 JSON 时直接报错，不写坏原文件；改动前留一份 .bak。
 *   4. 可预演：--dry-run 只报告将要发生的改动，不落盘。
 *   5. 参数严格：只认下列已知参数；未知参数（如 --status）立即退出码 1 返回结构化错误 + usage，
 *      绝不静默当成 install 执行，也不改写任何文件。
 *
 * 用法：
 *   node hooks/install-hooks.mjs [--target claude|codex|antigravity|all] [--scope user|project]
 *                                [--file <settings.json>] [--cwd <dir>] [--config-dir <dir>]
 *                                [--dry-run] [--uninstall] [--help|-h]
 *
 * 默认目标：自动探测已安装的 Agent，探测不到时用 claude。
 * 默认作用域：user。
 *
 * 各端用户级配置路径：
 *   claude      ~/.claude/settings.json
 *   codex       ~/.codex/hooks.json
 *   antigravity ~/.gemini/config/hooks.json 与 ~/.t3/userdata/providers/antigravity/<instance>/config/hooks.json
 *               （插件级为 <plugin>/hooks/hooks.json；指定单文件可用 --file）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const SENTINEL = 'xxn-lite-loop:guard-command';
const MATCHER = 'Bash';
const HOOK_TIMEOUT = 10;
const GUARD_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'guard-command.mjs');

function discoverT3AntigravityHookFiles() {
  const base = path.join(os.homedir(), '.t3', 'userdata', 'providers', 'antigravity');
  if (!fs.existsSync(base)) return [];
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configDir = path.join(base, entry.name, 'config');
    try {
      if (fs.statSync(configDir).isDirectory()) {
        files.push(path.join(configDir, 'hooks.json'));
      }
    } catch {
      // 忽略不可读或悬空的实例目录
    }
  }
  return files.sort();
}

function resolveAntigravityUserFiles() {
  const geminiConfigDir = path.join(os.homedir(), '.gemini', 'config');
  const geminiHooks = path.join(geminiConfigDir, 'hooks.json');
  const t3Files = discoverT3AntigravityHookFiles();
  const candidates = [];
  if (fs.existsSync(geminiConfigDir) || t3Files.length === 0) {
    candidates.push(geminiHooks);
  }
  for (const file of t3Files) {
    if (!candidates.includes(file)) candidates.push(file);
  }
  return candidates;
}

const TARGETS = {
  claude: {
    label: 'Claude Code',
    user: () => path.join(os.homedir(), '.claude', 'settings.json'),
    project: (cwd) => path.join(cwd, '.claude', 'settings.json'),
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude')),
  },
  codex: {
    label: 'Codex',
    user: () => path.join(os.homedir(), '.codex', 'hooks.json'),
    project: (cwd) => path.join(cwd, '.codex', 'hooks.json'),
    detect: () => fs.existsSync(path.join(os.homedir(), '.codex')),
  },
  antigravity: {
    label: 'Antigravity',
    user: () => path.join(os.homedir(), '.gemini', 'config', 'hooks.json'),
    userFiles: () => resolveAntigravityUserFiles(),
    project: (cwd) => path.join(cwd, '.agents', 'hooks.json'),
    detect: () => fs.existsSync(path.join(os.homedir(), '.gemini', 'config')) || discoverT3AntigravityHookFiles().length > 0,
  },
};

class CliError extends Error {
  constructor(code, message, extra = {}, exitCode = 2) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.exitCode = exitCode;
  }
}

const USAGE = [
  'node hooks/install-hooks.mjs [--target claude|codex|antigravity|all] [--scope user|project] [--dry-run] [--uninstall]',
  'node hooks/install-hooks.mjs --target claude --file <settings.json> --dry-run',
];

const VALUE_FLAGS = ['target', 'scope', 'file', 'cwd', 'config-dir'];
const BOOLEAN_FLAGS = ['dry-run', 'uninstall', 'help'];
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

function unknownArg(token) {
  return new CliError(
    'UNKNOWN_ARG',
    `未知参数：${token}；install-hooks 只认 ${[...KNOWN_FLAGS].map((key) => `--${key}`).join(' / ')} 与 -h，绝不把未知参数当成 install 执行`,
    { usage: USAGE, knownFlags: [...KNOWN_FLAGS], arg: token },
    1,
  );
}

function parseArgs(argv) {
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (!token.startsWith('--')) throw unknownArg(token);
    const eq = token.indexOf('=');
    const key = eq > -1 ? token.slice(2, eq) : token.slice(2);
    if (!KNOWN_FLAGS.has(key)) throw unknownArg(token);
    if (eq > -1) {
      flags[key] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (VALUE_FLAGS.includes(key)) {
      if (next === undefined || String(next).startsWith('-')) {
        throw new CliError('MISSING_VALUE', `--${key} 缺少取值`, { usage: USAGE, arg: token }, 1);
      }
      flags[key] = String(next);
      i += 1;
    } else if (next !== undefined && /^(true|false)$/i.test(String(next))) {
      flags[key] = String(next);
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveTargets(flags) {
  if (flags.target === undefined || flags.target === true) {
    const detected = Object.keys(TARGETS).filter((name) => TARGETS[name].detect());
    return detected.length ? detected : ['claude'];
  }
  const requested = String(flags.target).trim().toLowerCase();
  if (requested === 'all') return Object.keys(TARGETS);
  if (!TARGETS[requested]) {
    throw new CliError('UNKNOWN_TARGET', `--target 只支持 ${Object.keys(TARGETS).join('|')}|all，收到：${requested}`, {
      targets: Object.keys(TARGETS),
    });
  }
  return [requested];
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function hookCommand(target, configDir) {
  const configArg = configDir ? ` --config-dir ${shellQuote(configDir)}` : '';
  return `node ${shellQuote(GUARD_PATH)} --client ${target}${configArg} # ${SENTINEL}`;
}

function isOurs(hook) {
  return isPlainObject(hook) && hook.type === 'command'
    && String(hook.command ?? '').trimEnd().endsWith(` # ${SENTINEL}`);
}

function readConfig(file, key) {
  if (!fs.existsSync(file)) return { data: {}, existed: false };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { data: {}, existed: true };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new CliError('INVALID_JSON', `${file} 不是合法 JSON，拒绝覆盖：${err.message}`, { file });
  }
  if (!isPlainObject(data)) throw new CliError('INVALID_CONFIG', `${file} 顶层必须是对象，拒绝覆盖`, { file });
  if (data[key] !== undefined && !isPlainObject(data[key])) {
    throw new CliError('INVALID_CONFIG', `${file} 的 ${key} 必须是对象，拒绝覆盖`, { file });
  }
  if (data[key]?.PreToolUse !== undefined && !Array.isArray(data[key].PreToolUse)) {
    throw new CliError('INVALID_CONFIG', `${file} 的 ${key}.PreToolUse 必须是数组，拒绝覆盖`, { file });
  }
  return { data, existed: true };
}

/** 只摘掉带我们标识的 hook；同一条目里的其他 hook 原样保留。 */
function stripOurs(entries) {
  let removed = 0;
  const kept = [];
  for (const entry of entries) {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const hooks = entry.hooks.filter((hook) => {
      if (!isOurs(hook)) return true;
      removed += 1;
      return false;
    });
    if (hooks.length === entry.hooks.length) kept.push(entry);
    else if (hooks.length > 0) kept.push({ ...entry, hooks });
  }
  return { kept, removed };
}

function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function writeConfig(file, data, existed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (existed && fs.existsSync(file)) {
    backup = `${file}.xxn-lite-loop.bak`;
    fs.copyFileSync(file, backup);
  }
  const mode = existed && fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, serialize(data), { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return backup;
}

function applyFile(name, target, file, scope, flags) {
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const uninstall = flags.uninstall === true || flags.uninstall === 'true';

  const key = name === 'antigravity' ? SENTINEL : 'hooks';
  const { data, existed } = readConfig(file, key);
  const hooks = { ...data[key] };
  const { kept, removed } = stripOurs(hooks.PreToolUse ?? []);
  let removedCount = removed;
  if (name === 'antigravity' && Array.isArray(data.hooks?.PreToolUse)) {
    // Migrate only our previously installed entry in the generic hook section.
    const legacy = stripOurs(data.hooks.PreToolUse);
    if (legacy.removed) {
      removedCount += legacy.removed;
      if (legacy.kept.length) data.hooks.PreToolUse = legacy.kept;
      else delete data.hooks.PreToolUse;
    }
  }

  if (!uninstall) {
    const configDir = flags['config-dir'] ? path.resolve(String(flags['config-dir'])) : null;
    const matcher = name === 'antigravity' ? 'run_command' : MATCHER;
    kept.push({ matcher, hooks: [{ type: 'command', command: hookCommand(name, configDir), timeout: HOOK_TIMEOUT }] });
  }
  if (kept.length > 0) hooks.PreToolUse = kept;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) data[key] = hooks;
  else if (key === SENTINEL) delete data[key];
  else if (data[key] !== undefined) data[key] = hooks;

  const nextRaw = serialize(data);
  const currentRaw = existed ? fs.readFileSync(file, 'utf8') : null;
  const noop = uninstall && (!existed || removedCount === 0);
  const changed = !noop && (currentRaw === null || nextRaw !== currentRaw);
  const emptyAfterUninstall = uninstall
    && (Object.keys(data).length === 0 || (key === 'hooks' && !Object.keys(hooks).length && Object.keys(data).length === 1));

  let backup = null;
  let removedFile = false;
  if (changed && !dryRun) {
    if (emptyAfterUninstall && existed) {
      fs.rmSync(file, { force: true });
      removedFile = true;
    } else {
      backup = writeConfig(file, data, existed);
    }
  }

  return {
    target: name,
    label: target.label,
    file,
    scope,
    existed,
    changed,
    added: changed && !uninstall ? 1 : 0,
    removed: changed ? removedCount : 0,
    removedFile,
    backup,
    dryRun,
    ...(changed ? {} : { skipped: 'already-installed-or-nothing-to-remove' }),
  };
}

function applyTarget(name, flags) {
  const target = TARGETS[name];
  const cwd = path.resolve(String(flags.cwd ?? process.cwd()));
  const scope = flags.scope === undefined || flags.scope === true ? 'user' : String(flags.scope).toLowerCase();
  if (!['user', 'project'].includes(scope)) throw new CliError('INVALID_SCOPE', `--scope 只支持 user|project，收到：${scope}`);
  const files = flags.file
    ? [path.resolve(String(flags.file))]
    : (scope === 'user' && typeof target.userFiles === 'function' ? target.userFiles() : [target[scope](cwd)]);
  return files.map((file) => applyFile(name, target, file, scope, flags));
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    return {
      ok: true,
      name: 'xxn-lite-loop/install-hooks.mjs',
      version: VERSION,
      usage: USAGE,
      targets: Object.fromEntries(Object.entries(TARGETS).map(([name, t]) => [
        name,
        {
          label: t.label,
          user: t.user(),
          ...(typeof t.userFiles === 'function' ? { userFiles: t.userFiles() } : {}),
          project: t.project(process.cwd()),
        },
      ])),
      sentinel: SENTINEL,
    };
  }
  if (!fs.existsSync(GUARD_PATH)) {
    throw new CliError('GUARD_MISSING', `守卫脚本不存在：${GUARD_PATH}`);
  }
  const targets = resolveTargets(flags);
  if (flags.file && targets.length > 1) throw new CliError('FILE_WITH_MULTI_TARGET', '--file 只能配合单个 --target 使用');
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const uninstall = flags.uninstall === true || flags.uninstall === 'true';
  const results = targets.flatMap((name) => applyTarget(name, flags));
  const changed = results.filter((item) => item.changed);
  return {
    ok: true,
    action: uninstall ? 'uninstall' : 'install',
    dryRun,
    guard: GUARD_PATH,
    sentinel: SENTINEL,
    summary: dryRun
      ? `预演：${changed.length}/${results.length} 个配置会有改动`
      : changed.length === 0
        ? `无需改动：${results.length} 个配置已是目标状态`
        : `已更新 ${changed.length}/${results.length} 个配置`,
    targets: results,
  };
}

try {
  const payload = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 0;
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? 'UNEXPECTED_ERROR', message: err.message, ...(err.extra ?? {}) }, null, 2)}\n`);
  process.exitCode = err.exitCode ?? 2;
}