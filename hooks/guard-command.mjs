#!/usr/bin/env node
/**
 * guard-command.mjs — xxn-lite-loop 的可选薄安全栓（PreToolUse hook）。
 *
 * 铁律：绝不误杀任何正常 git / glab / gh 命令。
 *   - 按每条命令的实际操作目录匹配活跃 Loop 仓库。
 *   - 引号内字符串一律视为普通参数；只分析真正的命令词。
 *   - 只拦 2 类会酿事故的写命令：受保护环境分支的直推/合入、绕过 forge.mjs 的裸合并。
 *   - 自身出错时 fail-open（放行），不让安全栓变成路障。
 *
 * 两种用法：
 *   1. 作为库：import { evaluateCommand } from './hooks/guard-command.mjs'
 *      evaluateCommand({ command, cwd, configDir, env }) -> 纯评估结果，不写任何文件。
 *   2. 作为 CLI：
 *      node hooks/guard-command.mjs --cmd "git push origin main" --cwd . --config-dir ~/.config/dev-loop
 *      echo '{"tool_input":{"command":"git push origin main"},"cwd":"."}' | node hooks/guard-command.mjs
 *
 * Claude / Codex 拒绝时退出 2；Antigravity 始终退出 0，响应体为 allow 或 deny。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const HOOK_EVENT = 'PreToolUse';
const DEFAULT_ENV_BRANCHES = ['main', 'master', 'test', 'uat'];
const TRUNK_BRANCHES = new Set(['main', 'master']);
const FORGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'forge.mjs');
const BYPASS_HINT = '临时放行：DEV_LOOP_HOOK_BYPASS=1（仅限人工确认后）。';

/* ------------------------------------------------------------------ */
/* 词法级命令解析：引号 / 转义 / 命令替换感知                              */
/* ------------------------------------------------------------------ */

/**
 * 按未加引号的 && || ; | 换行 切成独立子命令。
 * 引号内、反引号内、$(...) 内一律视为普通字符，绝不参与切分。
 */
export function splitSegments(input) {
  return shellSegments(input).filter(Array.isArray);
}

function shellSegments(input) {
  const text = String(input ?? '');
  const segments = [];
  let tokens = [];
  let current = '';
  let hasToken = false;
  const heredocs = [];

  const pushToken = () => {
    if (!hasToken) return;
    tokens.push(current);
    current = '';
    hasToken = false;
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        current += c;
        hasToken = true;
        continue;
      }
      if (next === '\n') {
        i += 1;
        continue;
      }
      current += next;
      hasToken = true;
      i += 1;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      current += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      hasToken = true;
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < text.length) {
        const d = text[j];
        if (d === '\\') {
          const n = text[j + 1];
          if (n === '"' || n === '\\' || n === '$' || n === '`') {
            buf += n;
            j += 2;
            continue;
          }
          if (n === '\n') {
            j += 2;
            continue;
          }
          buf += d;
          j += 1;
          continue;
        }
        if (d === '"') break;
        buf += d;
        j += 1;
      }
      current += buf;
      hasToken = true;
      i = j;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      current += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      hasToken = true;
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') depth -= 1;
        j += 1;
      }
      current += text.slice(i, j);
      hasToken = true;
      i = j - 1;
      continue;
    }
    if (c === '#' && !hasToken) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end - 1;
      continue;
    }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      const match = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([^ \t\r\n;&|()<>]+))/.exec(text.slice(i));
      if (match) {
        if (hasToken && /^\d+$/.test(current)) {
          current = '';
          hasToken = false;
        }
        pushToken();
        const delimiter = match[2] ?? match[3] ?? match[4].replace(/\\(.)/g, '$1');
        heredocs.push({ delimiter, stripTabs: match[1] === '-' });
        i += match[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && heredocs.length) {
      pushSegment();
      let next = i + 1;
      for (const { delimiter, stripTabs } of heredocs.splice(0)) {
        while (next < text.length) {
          const end = text.indexOf('\n', next);
          const line = text.slice(next, end < 0 ? text.length : end).replace(/\r$/, '');
          next = end < 0 ? text.length : end + 1;
          if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
        }
      }
      i = next - 1;
      continue;
    }
    if (c === '(' || c === ')') {
      pushSegment();
      segments.push(c);
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n') {
      if (c === '&' && text[i - 1] === '>') {
        current += c;
        hasToken = true;
        continue;
      }
      if (c === '&' && text[i + 1] === '>') {
        current += '&>';
        hasToken = true;
        i += 1;
        continue;
      }
      if ((c === '&' || c === '|') && text[i + 1] === c) {
        pushSegment();
        i += 1;
        continue;
      }
      if (c === '|' && text[i + 1] === '&') {
        pushSegment();
        i += 1;
        continue;
      }
      if (c === ';' && text[i + 1] === ';') {
        pushSegment();
        i += 1;
        continue;
      }
      pushSegment();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pushToken();
      continue;
    }
    current += c;
    hasToken = true;
  }
  pushSegment();
  return segments;
}

/** 去掉重定向及其目标，避免把文件名当成 git 的位置参数。 */
export function stripRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\d*(>>?|<)&?$/.test(token)) {
      i += 1;
      continue;
    }
    if (/^\d*>>?[^\s]+$/.test(token)) continue;
    if (/^\d*>&\d+$/.test(token)) continue;
    if (/^\d*<[^\s]+$/.test(token)) continue;
    if (token === '&>' || token === '&>>') {
      i += 1;
      continue;
    }
    if (/^&>>?[^\s]+$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

const WRAPPERS = new Set(['rtk', 'command', 'env', 'sudo', 'nohup', 'time', 'exec', 'builtin']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 剥离前置环境变量赋值与透明包装前缀（rtk / rtk bypass / command / env / sudo ...）。 */
const WRAPPER_VALUE_OPTS = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host']),
  exec: new Set(['-a']),
};

export function stripWrappers(tokens) {
  return unwrapCommand(tokens, process.cwd()).tokens;
}

function unwrapCommand(tokens, cwd) {
  let i = 0;
  while (i < tokens.length) {
    while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i += 1;
    const head = commandName(tokens[i]);
    if (!WRAPPERS.has(head)) break;
    i += 1;
    if (head === 'rtk' && tokens[i] === 'bypass') i += 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const option = tokens[i++];
      if (option === '--') break;
      const name = option.split('=', 1)[0];
      const value = WRAPPER_VALUE_OPTS[head]?.has(option) ? tokens[i++] : option.slice(name.length + 1);
      if ((head === 'env' && (name === '-C' || name === '--chdir'))
        || (head === 'sudo' && (name === '-D' || name === '--chdir'))) {
        if (value) cwd = path.resolve(cwd, expandHomeToken(value));
      } else if (head === 'env' && option.startsWith('-C') && option.length > 2) {
        cwd = path.resolve(cwd, expandHomeToken(option.slice(2)));
      }
    }
  }
  return { tokens: tokens.slice(i), cwd };
}

function shellScript(tokens) {
  for (let i = 1; i < tokens.length; i += 1) {
    const option = tokens[i];
    if (option === '--') continue;
    if (!option.startsWith('-')) break;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) return tokens[i + 1] ?? null;
    if (['--rcfile', '--init-file', '-o', '-O'].includes(option)) i += 1;
  }
  return null;
}

function commandName(token) {
  const text = String(token ?? '');
  const base = (text.split(/[\\/]/).pop() ?? text).replace(/^[({]+/, '');
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* 受保护分支                                                            */
/* ------------------------------------------------------------------ */

function protectedPatterns(runs) {
  const patterns = new Set(DEFAULT_ENV_BRANCHES);
  for (const entry of runs) {
    const list = Array.isArray(entry.run?.protectedEnvBranches) ? entry.run.protectedEnvBranches : [];
    for (const pattern of list) {
      const text = String(pattern ?? '').trim();
      if (text) patterns.add(text);
    }
  }
  return [...patterns];
}

/** 命中返回命中的规则，未命中返回 null。支持精确、通配符与 /正则/。 */
export function matchProtectedBranch(branch, patterns) {
  const name = String(branch ?? '').trim();
  if (!name) return null;
  for (const raw of patterns) {
    const pattern = String(raw ?? '').trim();
    if (!pattern) continue;
    if (pattern.startsWith('/')) {
      const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
      if (!m) continue;
      try {
        if (new RegExp(m[1], m[2]).test(name)) return pattern;
      } catch {
        // 非法正则忽略，绝不让配置错误变成拦截
      }
      continue;
    }
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`).test(name)) return pattern;
      continue;
    }
    if (pattern === name) return pattern;
  }
  return null;
}

/** refs/heads/x、refs/remotes/origin/x、origin/x、+x 统一成 x；标签返回 tag。 */
export function normalizeRef(ref, remote) {
  let text = String(ref ?? '').trim();
  if (!text) return null;
  text = text.replace(/^\+/, '');
  if (text.startsWith('refs/tags/')) return { tag: true, name: text.slice('refs/tags/'.length) };
  text = text.replace(/^(?:refs\/)?heads\//, '');
  const remoteMatch = /^refs\/remotes\/[^/]+\//.exec(text);
  if (remoteMatch) text = text.slice(remoteMatch[0].length);
  if (remote && text.startsWith(`${remote}/`)) text = text.slice(remote.length + 1);
  else if (text.startsWith('origin/')) text = text.slice('origin/'.length);
  return { tag: false, name: text };
}

/* ------------------------------------------------------------------ */
/* git 解析                                                              */
/* ------------------------------------------------------------------ */

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--list-cmds', '--attr-source']);

function gitSubcommand(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('-')) return { name: token, args: tokens.slice(i + 1), globals: tokens.slice(1, i) };
    if (GIT_VALUE_OPTS.has(token)) i += 2;
    else i += 1;
  }
  return null;
}

function gitLocation(globals, baseCwd) {
  let cwd = baseCwd;
  let explicitGitDir = null;
  for (let i = 0; i < globals.length; i += 1) {
    const option = globals[i];
    if (option === '-C') {
      const target = globals[++i];
      if (target) cwd = path.resolve(cwd, expandHomeToken(target));
    } else if (option.startsWith('-C')) {
      cwd = path.resolve(cwd, expandHomeToken(option.slice(2)));
    } else if (option === '--git-dir') {
      explicitGitDir = globals[++i];
    } else if (option.startsWith('--git-dir=')) {
      explicitGitDir = option.slice('--git-dir='.length);
    } else if (GIT_VALUE_OPTS.has(option)) {
      i += 1;
    }
  }
  return { cwd, gitDir: explicitGitDir ? path.resolve(cwd, expandHomeToken(explicitGitDir)) : null };
}

function spawnText(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 4000 });
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
}

function currentBranch(ctx) {
  const branch = ctx.readGit(['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch || branch === 'HEAD') return null;
  return branch;
}

function listRemotes(readGit) {
  const remotes = new Set(['origin']);
  const text = readGit(['remote']);
  if (!text) return remotes;
  for (const line of text.split('\n')) {
    const name = line.trim();
    if (name) remotes.add(name);
  }
  return remotes;
}

function parseRepoUrl(url) {
  const text = String(url ?? '').trim();
  if (!text) return null;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(text);
  if (scp) return scp[1].replace(/\.git$/, '') || null;
  try {
    const parsed = new URL(text);
    return parsed.pathname.replace(/^\//, '').replace(/\.git$/, '') || null;
  } catch {
    return null;
  }
}

const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--receive-pack', '--exec']);

function parsePushArgs(args) {
  const state = { positionals: [], force: false, deleteMode: false, all: false, mirror: false, dryRun: false, tags: false, help: false, remote: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      state.positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      state.positionals.push(arg);
      continue;
    }
    if (arg === '-f' || arg === '--force' || arg === '--force-if-includes' || arg === '--force-with-lease' || arg.startsWith('--force-with-lease=')) state.force = true;
    else if (arg === '--delete' || arg === '-d') state.deleteMode = true;
    else if (arg === '--all' || arg === '--branches') state.all = true;
    else if (arg === '--mirror') state.mirror = true;
    else if (arg === '--dry-run' || arg === '-n') state.dryRun = true;
    else if (arg === '--tags') state.tags = true;
    else if (arg === '--help' || arg === '-h') state.help = true;
    else if (arg === '--repo') state.remote = args[++i];
    else if (arg.startsWith('--repo=')) state.remote = arg.slice('--repo='.length);
    else if (PUSH_VALUE_OPTS.has(arg)) i += 1;
  }
  return state;
}

function refspecTarget(spec, remote, ctx) {
  const raw = String(spec ?? '').replace(/^\+/, '');
  const colon = raw.indexOf(':');
  const source = colon === -1 ? raw : raw.slice(0, colon);
  let target = colon === -1 ? raw : raw.slice(colon + 1);
  const deleting = colon > -1 && (source === '' || target === '');
  if (!target) target = source;
  const normalized = normalizeRef(target, remote);
  if (!normalized || normalized.tag) return null;
  const name = normalized.name === 'HEAD' || normalized.name === '@' ? currentBranch(ctx) : normalized.name;
  if (!name) return null;
  return { name, deleting };
}

function pushBlock(state, target, pattern, ctx, deleting = false) {
  const isDelete = deleting || state.deleteMode;
  const action = isDelete ? '删除' : state.force ? '强制推送' : '推送';
  const repo = ctx.repo ?? '<owner/repo>';
  const runArg = ctx.runPath ? ` --run "${ctx.runPath}"` : '';
  return {
    decision: 'block',
    code: 'PUSH_PROTECTED_BRANCH',
    title: `git push ${action}目标分支 “${target}” 命中受保护规则 “${pattern}”`,
    detail: isDelete
      ? '受保护环境分支不允许从命令行删除；删掉后的恢复成本极高。'
      : '受保护环境分支的合入必须由人执行；直推或强推会绕过独立终审与 head SHA 校验。',
    alternatives: [
      '只推需求分支：git push origin <需求分支>',
      `走统一合并：node "${FORGE_PATH}" change-merge --forge <gitlab|github> --repo ${repo} --id <MR号> --head-sha <sha> --target <需求基线>${runArg}`,
      '或交给人工合并：main/master/test/uat 的合入与部署一律由人执行。',
    ],
    target,
    pattern,
  };
}

function evaluatePush(args, ctx) {
  const state = parsePushArgs(args);
  if (state.help || state.dryRun) return null;
  if (state.mirror || state.all) {
    return {
      decision: 'block',
      code: 'PUSH_PROTECTED_BRANCH',
      title: `git push ${state.mirror ? '--mirror' : '--all'} 会同时推送受保护分支`,
      detail: '整仓推送会把所有本地分支（含 main/master/test/uat）一并推到远端，绕过逐分支终审。',
      alternatives: [
        '只推当前需求分支：git push origin <需求分支>',
        '需要备份整仓时改用只读镜像仓库，并在人工确认后执行。',
      ],
      target: null,
      pattern: null,
    };
  }

  const collect = (remote, refspecs) => {
    const targets = [];
    for (let i = 0; i < refspecs.length; i += 1) {
      const spec = refspecs[i];
      if (remote && spec === 'tag' && i + 1 < refspecs.length) {
        i += 1;
        continue;
      }
      const resolved = refspecTarget(spec, remote, ctx);
      if (!resolved) continue;
      const pattern = matchProtectedBranch(resolved.name, ctx.patterns);
      if (pattern) targets.push({ target: resolved.name, pattern, deleting: resolved.deleting });
    }
    return targets;
  };

  if (state.positionals.length === 0) {
    if (state.tags) return null;
    const branch = currentBranch(ctx);
    if (!branch) return null;
    const pattern = matchProtectedBranch(branch, ctx.patterns);
    return pattern ? pushBlock(state, branch, pattern, ctx) : null;
  }

  const first = state.positionals[0];
  let remote = null;
  let refspecs = [];
  if (state.remote) {
    remote = state.remote;
    refspecs = state.positionals;
  } else if (state.positionals.length >= 2) {
    remote = first;
    refspecs = state.positionals.slice(1);
  } else if (first.includes(':')) {
    refspecs = [first];
  } else if (ctx.remotes.has(first) || /:\/\//.test(first) || /^[^@/\s]+@[^:/\s]+:/.test(first)) {
    remote = first;
    refspecs = [];
  } else {
    refspecs = [first];
  }

  if (refspecs.length === 0) {
    if (state.tags) return null;
    const branch = currentBranch(ctx);
    if (!branch) return null;
    const pattern = matchProtectedBranch(branch, ctx.patterns);
    return pattern ? pushBlock(state, branch, pattern, ctx) : null;
  }

  const targets = collect(remote, refspecs);
  if (targets.length === 0) return null;
  return pushBlock(state, targets[0].target, targets[0].pattern, ctx, targets[0].deleting);
}

const MERGE_VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name', '--cleanup']);

function parseMergeArgs(args) {
  const state = { positionals: [], abortLike: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--abort' || arg === '--continue' || arg === '--quit') {
      state.abortLike = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      state.help = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      state.positionals.push(arg);
      continue;
    }
    if (MERGE_VALUE_OPTS.has(arg)) i += 1;
  }
  return state;
}

function evaluateMerge(args, ctx) {
  const state = parseMergeArgs(args);
  if (state.abortLike || state.help) return null;
  for (const source of state.positionals) {
    const normalized = normalizeRef(source, null);
    if (!normalized || normalized.tag) continue;
    let name = normalized.name;
    const slash = name.indexOf('/');
    if (slash > 0 && ctx.remotes.has(name.slice(0, slash))) name = name.slice(slash + 1);
    if (!name || name === 'HEAD' || name === '@') continue;
    if (ctx.trunks.has(name)) continue;
    const pattern = matchProtectedBranch(name, ctx.patterns);
    if (!pattern) continue;
    return {
      decision: 'block',
      code: 'MERGE_PROTECTED_ENV',
      title: `git merge 来源 “${name}” 是受保护环境分支，不能直接合入当前开发分支`,
      detail: '环境分支只承载部署态；合进来会把环境提交混入需求分支，之后无法干净回滚，也绕过了主干同步与终审。',
      alternatives: [
        '需要同步生产代码：git merge origin/main（主干允许）',
        '需要环境验证：让主控走 forge.mjs change-merge 合入需求基线后由人部署',
        '或交给人工处理。',
      ],
      target: name,
      pattern,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* glab / gh 解析                                                        */
/* ------------------------------------------------------------------ */

const FORGE_GLOBAL_VALUE_OPTS = new Set(['-R', '--repo', '--hostname', '-t', '--token', '--config', '-c']);

const API_VALUE_OPTS = new Set([
  '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '--hostname',
  '--template', '-t', '--jq', '-q', '--cache', '-R', '--repo', '--output', '-o',
]);
const API_BODY_OPTS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

function mergeApiId(args) {
  let method;
  let hasBody = false;
  let endpoint;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return null;
    const [name, ...value] = arg.split('=');
    if (name === '-X' || name === '--method') method = value.length ? value.join('=') : args[++i];
    else if (/^-X[A-Za-z]+$/.test(arg)) method = arg.slice(2);
    else if (API_VALUE_OPTS.has(name)) {
      if (API_BODY_OPTS.has(name)) hasBody = true;
      if (!value.length) i += 1;
    } else if (/^-[fF].+/.test(arg)) hasBody = true;
    else if (!arg.startsWith('-') && !endpoint) endpoint = arg;
  }
  if (/^(?:GET|HEAD)$/i.test(method ?? (hasBody ? 'POST' : 'GET'))) return null;
  return /\/(?:pulls|merge_requests)\/(\d+)\/merge\/?(?:[?#]|$)/.exec(endpoint ?? '')?.[1] ?? null;
}

function evaluateForge(tokens, ctx) {
  const tool = commandName(tokens[0]);
  const group = tool === 'glab' ? 'mr' : 'pr';
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    i += FORGE_GLOBAL_VALUE_OPTS.has(tokens[i]) ? 2 : 1;
  }
  let id;
  let verb;
  if (tokens[i] === 'api') {
    id = mergeApiId(tokens.slice(i + 1));
    if (id === null) return null;
    verb = 'api merge';
  } else {
    if (tokens[i++] !== group) return null;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += FORGE_GLOBAL_VALUE_OPTS.has(tokens[i]) ? 2 : 1;
    }
    if (tokens[i] !== 'merge') return null;
    const rest = tokens.slice(i + 1);
    if (rest.includes('--help') || rest.includes('-h')) return null;
    id = rest.find((token) => /^\d+$/.test(token)) ?? '<MR号>';
    verb = `${group} merge`;
  }
  const repo = ctx.repo ?? '<owner/repo>';
  const runArg = ctx.runPath ? ` --run "${ctx.runPath}"` : '';
  const forge = tool === 'glab' ? 'gitlab' : 'github';
  return {
    decision: 'block',
    code: 'BYPASS_FORGE_MERGE',
    title: `裸跑 ${tool} ${verb} 绕过了 forge.mjs change-merge`,
    detail: '直接合并会跳过 head SHA、目标分支、基线血缘与依赖校验；终审结论与台账可能和实际合入不一致。',
    alternatives: [
      `走统一合并：node "${FORGE_PATH}" change-merge --forge ${forge} --repo ${repo} --id ${id} --head-sha <sha> --target <需求基线>${runArg}`,
      `只查看：${tool} ${group} view ${id}`,
      '或交给人工合并。',
    ],
    target: null,
    pattern: null,
  };
}

/* ------------------------------------------------------------------ */
/* 活跃 run 门控                                                         */
/* ------------------------------------------------------------------ */

function resolveReal(target) {
  const absolute = path.resolve(String(target));
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function compareKey(target) {
  const text = String(target);
  return process.platform === 'darwin' || process.platform === 'win32' ? text.toLowerCase() : text;
}

function isInside(child, parent) {
  const c = compareKey(child);
  const p = compareKey(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function expandHomePath(value) {
  const text = String(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function registeredPath(entry) {
  const value = typeof entry === 'string' ? entry : entry?.path ?? entry?.localPath;
  return value ? resolveReal(expandHomePath(value)) : null;
}

function commonGitDirectory(gitDir) {
  try {
    const relative = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').replace(/\r?\n$/, '');
    return resolveReal(path.resolve(gitDir, relative));
  } catch {
    return resolveReal(gitDir);
  }
}

function gitDirectoryAt(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.git');
    const stat = fs.statSync(marker, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return resolveReal(marker);
    if (stat?.isFile()) {
      const target = /^gitdir: (.+)/.exec(fs.readFileSync(marker, 'utf8'))?.[1];
      return target ? resolveReal(path.resolve(dir, target)) : null;
    }
    if (dir === path.dirname(dir)) return null;
  }
}

/**
 * 只扫 configDir/runs/*.json（不含 archive/），返回 cwd 命中的活跃 run。
 * 目录不存在或没有命中时立即返回空数组，调用方直接放行。
 */
export function findActiveRuns(cwd, configDir, gitDir = null) {
  const runsDir = path.join(configDir, 'runs');
  let entries;
  try {
    if (!fs.existsSync(runsDir)) return [];
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const target = resolveReal(cwd);
  const operationGitDir = gitDir ?? gitDirectoryAt(target);
  const common = operationGitDir && commonGitDirectory(operationGitDir);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(runsDir, entry.name);
    let run;
    try {
      run = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!run || typeof run !== 'object' || run.status === 'archived') continue;
    const matchRoot = (root) => {
      if (!root) return false;
      const repoDir = gitDirectoryAt(root);
      if (common && repoDir) return compareKey(common) === compareKey(commonGitDirectory(repoDir));
      if (!gitDir && isInside(target, root)) return true;
      return common && compareKey(common) === compareKey(root);
    };
    const repos = (Array.isArray(run.repos) ? run.repos : []).filter((repo) => matchRoot(registeredPath(repo)));
    const worktrees = Array.isArray(run.worktrees) ? run.worktrees : [];
    if (repos.length || worktrees.some((entry) => matchRoot(registeredPath(entry)))) {
      matches.push({ req: run.req ?? path.basename(entry.name, '.json'), runPath: file, run, repos });
    }
  }
  matches.sort((a, b) => String(b.run.updatedAt ?? '').localeCompare(String(a.run.updatedAt ?? '')));
  return matches;
}

function resolveConfigDir(configDir) {
  if (configDir) {
    const text = String(configDir);
    const expanded = text === '~' ? os.homedir() : text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text;
    return path.resolve(expanded);
  }
  return path.resolve(process.env.XXN_LITE_LOOP_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'dev-loop'));
}

/* ------------------------------------------------------------------ */
/* 评估                                                                  */
/* ------------------------------------------------------------------ */

function allowResult(command, cwd, code, extra = {}) {
  return { ok: true, decision: 'allow', code, reason: '', command, cwd, run: null, segment: null, ...extra };
}

function contextFor(cwd, dir, gitDir = null) {
  const active = findActiveRuns(cwd, dir, gitDir);
  if (active.length === 0) return null;
  const primary = active[0];
  // remotes / repo 按需探测：放行路径不 spawn git，保证非 git 命令也足够快。
  let remotes = null;
  let repo;
  const trunks = new Set([...TRUNK_BRANCHES, ...active.flatMap((entry) => entry.repos.map((item) => item.branch).filter(Boolean))]);
  const readGit = (args) => spawnText('git', [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...args], cwd);
  return {
    readGit,
    trunks,
    patterns: protectedPatterns(active),
    runPath: primary.runPath,
    req: primary.req,
    get remotes() {
      if (!remotes) remotes = listRemotes(readGit);
      return remotes;
    },
    get repo() {
      if (repo === undefined) repo = parseRepoUrl(readGit(['remote', 'get-url', 'origin']));
      return repo;
    },
  };
}

function expandHomeToken(target) {
  const text = String(target);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function evaluateUnsafe({ command, cwd, configDir, env }) {
  const rawCommand = String(command ?? '');
  const workingDir = path.resolve(String(cwd ?? process.cwd()));
  const effectiveEnv = env ?? process.env;

  if (effectiveEnv && effectiveEnv.DEV_LOOP_HOOK_BYPASS === '1') return allowResult(rawCommand, workingDir, 'ALLOW_BYPASS');
  if (!rawCommand.trim()) return allowResult(rawCommand, workingDir, 'ALLOW_EMPTY');

  const dir = resolveConfigDir(configDir);
  let matched = null;
  const contexts = new Map();
  const getContext = (cwd, gitDir = null) => {
    const key = JSON.stringify([cwd, gitDir]);
    if (!contexts.has(key)) contexts.set(key, contextFor(cwd, dir, gitDir));
    const ctx = contexts.get(key);
    if (ctx) matched = { req: ctx.req, runPath: ctx.runPath };
    return ctx;
  };

  function evaluateShell(text, cwd) {
    const scopes = [{ cwd, previous: effectiveEnv?.OLDPWD }];
    for (const segment of shellSegments(text)) {
      const scope = scopes.at(-1);
      if (segment === '(') {
        scopes.push({ ...scope });
        continue;
      }
      if (segment === ')') {
        if (scopes.length > 1) scopes.pop();
        continue;
      }
      const { tokens, cwd: commandCwd } = unwrapCommand(stripRedirections(segment), scope.cwd);
      if (tokens.length === 0) continue;
      const tool = commandName(tokens[0]);

      if (tool === 'cd' || tool === 'pushd') {
        const arg = tokens.slice(1).find((token) => !['--', '-L', '-P', '-e'].includes(token));
        const target = arg === '-' ? scope.previous : arg ?? os.homedir();
        if (target && !/[$`]/.test(target)) {
          const next = path.resolve(commandCwd, expandHomeToken(target));
          if (fs.statSync(next, { throwIfNoEntry: false })?.isDirectory()) {
            scope.previous = scope.cwd;
            scope.cwd = next;
          }
        }
        continue;
      }
      if (['sh', 'bash', 'zsh'].includes(tool)) {
        const script = shellScript(tokens);
        const block = script === null ? null : evaluateShell(script, commandCwd);
        if (block) return block;
        continue;
      }

      let ctx;
      let block;
      if (tool === 'git') {
        const sub = gitSubcommand(tokens);
        if (!sub || !['push', 'merge'].includes(sub.name)) continue;
        const location = gitLocation(sub.globals, commandCwd);
        ctx = getContext(location.cwd, location.gitDir);
        if (!ctx) continue;
        block = sub.name === 'push' ? evaluatePush(sub.args, ctx) : evaluateMerge(sub.args, ctx);
      } else if (tool === 'glab' || tool === 'gh') {
        ctx = getContext(commandCwd);
        if (ctx) block = evaluateForge(tokens, ctx);
      }
      if (block) {
        const runInfo = { req: ctx.req, runPath: ctx.runPath };
        return {
          ...block,
          ok: true,
          reason: formatReason(block, runInfo),
          command: rawCommand,
          cwd: workingDir,
          run: runInfo,
          segment: tokens.join(' '),
        };
      }
    }
    return null;
  }

  const block = evaluateShell(rawCommand, workingDir);
  if (block) return block;
  if (!matched) getContext(workingDir);
  return allowResult(rawCommand, workingDir, matched ? 'ALLOW_IN_LOOP' : 'ALLOW_OUTSIDE_LOOP', { run: matched });
}

/**
 * 纯评估入口：只读 run.json 与 git 状态，不写任何文件、不改任何状态。
 * 任何内部异常都 fail-open，避免安全栓自身变成路障。
 */
export function evaluateCommand({ command, cwd, configDir, env } = {}) {
  try {
    return evaluateUnsafe({ command, cwd, configDir, env });
  } catch (err) {
    return allowResult(String(command ?? ''), path.resolve(String(cwd ?? process.cwd())), 'ALLOW_GUARD_ERROR', {
      warning: `guard 内部异常，已放行：${err.message}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 输出                                                                  */
/* ------------------------------------------------------------------ */

function formatReason(block, runInfo) {
  const lines = [];
  lines.push(`[xxn-lite-loop] 已拦截：${block.title}`);
  lines.push(`原因：${block.detail}`);
  lines.push('建议：');
  block.alternatives.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
  if (runInfo) lines.push(`当前活跃需求：${runInfo.req}（${runInfo.runPath}）`);
  lines.push(BYPASS_HINT);
  return lines.join('\n');
}

function parseArgs(argv) {
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const COMMAND_KEYS = ['command', 'cmd', 'Command', 'CommandLine', 'commandLine', 'command_line', 'shellCommand', 'shell_command', 'script'];
const CWD_KEYS = ['Cwd', 'cwd', 'workingDirectory', 'working_directory', 'workspaceRoot', 'workspace_root', 'projectRoot', 'project_root'];
const CONTAINERS = ['tool_input', 'toolInput', 'args', 'arguments', 'input', 'toolCall', 'tool_call', 'params', 'payload', 'request', 'data'];

function deepFind(node, keys, findKey = false, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return null;
  seen.add(node);
  for (const key of keys) {
    if (findKey && Object.hasOwn(node, key)) return key;
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const key of CONTAINERS) {
    const value = node[key];
    if (value && typeof value === 'object') {
      const hit = deepFind(value, keys, findKey, depth + 1, seen);
      if (hit) return hit;
    }
    if (typeof value === 'string' && value.trim().startsWith('{')) {
      try {
        const hit = deepFind(JSON.parse(value), keys, findKey, depth + 1, seen);
        if (hit) return hit;
      } catch {
        // 非 JSON 字符串忽略
      }
    }
  }
  return null;
}

function emitBlock(result, { hookMode, jsonMode }) {
  const message = result.reason || result.title || '已被 xxn-lite-loop 守卫拦截';
  if (hookMode || jsonMode) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: HOOK_EVENT,
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
      decision: 'block',
      reason: message,
      code: result.code,
      run: result.run,
    })}\n`);
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function usage() {
  return {
    ok: true,
    name: 'xxn-lite-loop/guard-command.mjs',
    version: VERSION,
    usage: [
      'node hooks/guard-command.mjs --cmd "git push origin main" [--cwd <dir>] [--config-dir <dir>] [--json]',
      'echo \'{"tool_input":{"command":"git push origin main"},"cwd":"."}\' | node hooks/guard-command.mjs',
    ],
    bypass: 'DEV_LOOP_HOOK_BYPASS=1',
  };
}

function main(flags, payload) {
  if (flags.help || (payload === null && flags.cmd === undefined)) return usage();
  const cliMode = flags.cmd !== undefined && flags.cmd !== true;
  const command = cliMode ? String(flags.cmd) : deepFind(payload, COMMAND_KEYS);
  if (command === null || command === undefined) {
    const code = payload === undefined ? 'ALLOW_INVALID_HOOK_PAYLOAD' : 'ALLOW_NO_COMMAND';
    return { ok: true, decision: 'allow', code, reason: '' };
  }
  const cwd = cliMode
    ? (flags.cwd ? String(flags.cwd) : process.cwd())
    : (deepFind(payload, CWD_KEYS) ?? process.cwd());

  return evaluateCommand({
    command,
    cwd,
    configDir: flags['config-dir'] ? String(flags['config-dir']) : undefined,
    env: process.env,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && resolveReal(invokedPath) === fileURLToPath(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2));
  let antigravity = [flags.client, flags.hook].includes('antigravity');
  try {
    let payload = null;
    if (flags.cmd === undefined && !flags.help) {
      const text = readStdin();
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = undefined;
        }
      }
      antigravity ||= payload?.tool_name === 'run_command' || Boolean(deepFind(payload, ['Cwd'], true));
    }
    const result = main(flags, payload);
    if (antigravity && !flags.help) {
      const decision = result.decision === 'block' ? { decision: 'deny', reason: result.reason } : { decision: 'allow' };
      process.stdout.write(`${JSON.stringify(decision)}\n`);
    } else if (result.decision === 'block') {
      emitBlock(result, { hookMode: flags.cmd === undefined, jsonMode: flags.json === true });
    } else if (flags.help || flags.json || flags.verbose || (Array.isArray(result.usage) && process.stdin.isTTY)) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (err) {
    // Keep the client's allow contract even if the guard itself fails.
    if (antigravity) process.stdout.write('{"decision":"allow"}\n');
    process.stderr.write(`[xxn-lite-loop] guard 内部异常，已放行：${err.message}\n`);
  }
}
