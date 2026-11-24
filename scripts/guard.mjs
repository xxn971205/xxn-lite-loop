#!/usr/bin/env node
/**
 * guard.mjs — xxn-lite-loop 的脚本化状态守卫与写前锁（纯函数）。
 *
 * 零依赖 Node.js ESM（Node 20+）。状态守卫由 loopctl.mjs 路由调用：
 *   runDoctor(flags, configDir, opts)  只读环境体检：能不能跑、能跑到哪一档
 *   runLedgerLint(flags)               台账 4 条硬伤：行数、固定章节、状态枚举、围栏代码块
 *   checkPersonalPolicyOverride(text)  个人临时约定是否试图削弱 L3 公共硬底线
 *   buildLiveStatus(baseStatus, live, run) 单屏健康视图：overview / actionRequired / slotHealth / nextPrompt
 *
 * 设计取向（反过度防御、高确定性）：
 * - 只拦「会让 AI 失忆、让脚本解析失败、让漏审误合串单真正发生」的硬伤，其余合理动作全部放行；
 * - 可选工具缺失（lark-cli、未初始化 me.yaml）一律 WARN 并给冷启动引导，绝不把基础运行判死；
 * - 不写任何长期状态：只读探针 + 纯函数判定，同一输入必得同一输出，不含时间戳与随机量。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forgeHostArgs, matchProtectedBranch } from './lib/common.mjs';
import { escalationsFor, ledgerField } from './lib/tick-dispatch.mjs';

const NODE_MIN_MAJOR = 20;
const LOOPCTL = fileURLToPath(new URL('./loopctl.mjs', import.meta.url));

/** 台账第 1 节「状态：」的唯一枚举（references/templates.md 的机器可读副本）。 */
const LEDGER_STATES = ['未开始', '进行中', '待确认', '待裁决', '阻断', '待终审', '终审中', '待合并', '需修改', '已合入', '暂停'];

/** 正文行数上限：L1 放宽到 100，L2/L3 一屏 80（与 tiers.md 的 ledgerMaxLines 一致）。 */
const LEDGER_MAX_LINES = { L1: 100, L2: 80, L3: 80 };

/** 固定章节：只认「第 N 节 + 稳定关键词」，不要求标点与措辞逐字一致。 */
const TRACKING_SECTIONS = ['基本信息', '当前任务', '变更与终审', '收尾'];
const PERSONAL_SECTIONS = ['基本信息', '需本人处理', '当前进行中', '近期完成与挂起', '流程提醒'];
const LEDGER_LAYOUT = {
  tracking: { label: 'L1 追踪台账', titles: TRACKING_SECTIONS, requireState: true },
  personal: { label: 'L2/L3 个人台账', titles: PERSONAL_SECTIONS, requireState: true },
  master: { label: 'L3 总台账', titles: ['整体状态', '待主研发处理', '各开发者', '契约', '阶段节点'], requireState: false },
};

const TIERS = ['L1', 'L2', 'L3'];
const REJECT_FUSE = 2;

/** 三层协作规矩（rules）提醒的统一前缀：loopctl 产出，doctor 据此在 config 检查里透出。 */
const RULES_WARNING_PREFIX = '协作规矩：';

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ */
/* 参数与输入（只做边界收敛，不做二次防御）                                  */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flagText(flags, key) {
  const value = flags?.[key];
  if (value === undefined || value === true) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function expandHome(target) {
  const text = String(target);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function positiveInt(value, key) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new CliError('INVALID_FLAG', `--${key} 必须是正整数，收到：${value}`);
  return n;
}

function findConfigFile(baseDir, slug) {
  for (const ext of ['.yaml', '.yml', '.json']) {
    const file = path.join(baseDir, `${slug}${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function listProjectSlugs(configDir) {
  const dir = path.join(configDir, 'projects');
  if (!fs.existsSync(dir)) return [];
  const slugs = new Set();
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name).toLowerCase();
    if (['.yaml', '.yml', '.json'].includes(ext)) slugs.add(name.slice(0, -ext.length));
  }
  return [...slugs].sort();
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
}

function parseMaybeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 只读探针                                                              */
/* ------------------------------------------------------------------ */

function defaultProbe(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? (result.error.code ?? result.error.message) : null,
  };
}

function binaryOnPath(name, env = process.env) {
  const text = String(name ?? '');
  if (!text) return false;
  if (text.includes('/') || text.includes('\\')) return fs.existsSync(text);
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return dirs.some((dir) => exts.some((ext) => {
    try {
      fs.accessSync(path.join(dir, text + ext), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

function probeForgeCli(bin, probe, cwd, host) {
  const result = probe(bin, ['auth', 'status', ...forgeHostArgs({ hostname: host })], { cwd, timeout: 20000 });
  const detail = firstLine(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error) {
    const missing = /ENOENT|not found|not recognized/i.test(String(result.error));
    return { installed: false, loggedIn: false, detail: missing ? `${bin} 未安装` : `${bin} 无法执行：${result.error}` };
  }
  if (result.status === 0) return { installed: true, loggedIn: true, detail: detail || `${bin} 已登录` };
  return { installed: true, loggedIn: false, detail: detail || `${bin} auth status 退出码 ${result.status}` };
}

/** 配置解析只信 loopctl 这一份实现：guard 不再复制 YAML 子集解析器。 */
function resolveConfigViaCli({ configDir, project, probe, cwd }) {
  const result = probe(process.execPath, [LOOPCTL, 'config-resolve', '--config-dir', configDir, '--project', project], { cwd, timeout: 30000 });
  if (result.error) {
    return { ok: false, code: 'CONFIG_PROBE_FAILED', message: `无法执行 ${process.execPath}：${result.error}` };
  }
  const payload = parseMaybeJson(result.stdout);
  if (result.status === 0 && isPlainObject(payload) && payload.ok) return { ok: true, config: payload };
  return {
    ok: false,
    code: payload?.code ?? 'CONFIG_UNRESOLVED',
    message: payload?.message ?? `config-resolve 退出码 ${result.status}`,
  };
}

/* ------------------------------------------------------------------ */
/* 模块 1：doctor                                                       */
/* ------------------------------------------------------------------ */

function check(id, status, detail, fix) {
  return fix ? { id, status, detail, fix } : { id, status, detail };
}

function probeForgeNames(read, endpoint) {
  const names = [];
  for (let page = 1; ; page += 1) {
    const result = read(endpoint + '?per_page=100' + (page === 1 ? '' : '&page=' + page));
    const rows = parseMaybeJson(result.stdout);
    if (result.status !== 0 || result.error || !Array.isArray(rows) || rows.some((row) => typeof row?.name !== 'string')) {
      throw new Error('无法读取 ' + endpoint + '（' + (result.error || firstLine(result.stderr) || '返回格式异常') + '）');
    }
    names.push(...rows.map((row) => row.name));
    if (rows.length < 100) return names;
  }
}

function shellWord(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function checkForgeBranchProtection(cfg, forge, { probe, cwd, env, loggedIn, host }) {
  const id = 'forge-branch-protection';
  if (!forge || !cfg?.repos?.length) return check(id, 'WARN', '工程尚未登记可检查的 Forge 仓库');
  if (!loggedIn) return check(id, 'WARN', 'Forge CLI 登录态不可用，服务端分支保护未核验');

  const gitlab = forge === 'gitlab';
  const bin = gitlab ? 'glab' : 'gh';
  const hostArgs = forgeHostArgs({ hostname: host });
  const hostname = hostArgs.length ? ` ${hostArgs[0]} ${shellWord(hostArgs[1])}` : '';
  const read = (endpoint, include = false) => probe(bin, [
    'api', ...hostArgs, ...(include ? ['--include'] : []), endpoint,
  ], { cwd, env });
  const hookFix = '可运行 node <skill>/hooks/install-hooks.mjs 加装本地 Hook';
  const details = [];
  const fixes = new Set();
  for (const { repo, branch } of cfg.repos) {
    const candidates = new Set([...(cfg.protectedEnvBranches ?? []), branch].filter((name) => name && !name.startsWith('/') && !name.includes('*')));
    if (!candidates.size) continue;
    const base = gitlab ? 'projects/' + encodeURIComponent(repo) : 'repos/' + repo;
    try {
      const remote = probeForgeNames(read, base + (gitlab ? '/repository/branches' : '/branches'));
      const present = remote.filter((name) => candidates.has(name));
      if (!present.length) continue;
      const gitlabProtection = gitlab ? probeForgeNames(read, base + '/protected_branches') : null;
      for (const name of present) {
        const ref = repo + ':' + name;
        if (gitlab) {
          if (matchProtectedBranch(name, gitlabProtection)) {
            details.push(ref + ' 已保护');
          } else {
            details.push(ref + ' 未保护');
            fixes.add('glab api' + hostname + ' --method POST ' + shellWord(base + '/protected_branches') + ' --raw-field ' + shellWord('name=' + name));
          }
          continue;
        }
        const endpoint = base + '/branches/' + encodeURIComponent(name) + '/protection';
        const result = read(endpoint, true);
        const status = /^HTTP\/[\d.]+\s+(\d{3})\b/m.exec(result.stdout)?.[1] ?? /\(HTTP (\d{3})\)/.exec(result.stderr)?.[1];
        const unsupported = /upgrade to github|make this repository public|plan.{0,30}not support/i.test(result.stdout + '\n' + result.stderr);
        if (result.status === 0 && !result.error && status === '200') {
          details.push(ref + ' 已保护');
        } else if (status === '403' || unsupported) {
          details.push(ref + ' 无法核验保护（' + (status === '403' ? 'HTTP 403，检查权限或仓库套餐' : '仓库套餐不支持') + '）');
          fixes.add(hookFix);
        } else if (status === '404') {
          details.push(ref + ' 未查到分支保护（HTTP 404）');
          fixes.add('配置 branch-protection.json 后执行 gh api' + hostname + ' --method PUT ' + shellWord(endpoint) + ' --input branch-protection.json');
        } else {
          details.push(ref + ' 分支保护读取失败（' + (result.error ?? status ?? result.status) + '）');
          fixes.add(hookFix);
        }
      }
    } catch (err) {
      details.push(repo + '：' + err.message);
      fixes.add(hookFix);
    }
  }
  return check(id, fixes.size ? 'WARN' : 'PASS', details.join(' ｜ ') || '远端没有匹配的精确名分支', [...fixes].join('；'));
}

function runDoctor(flags = {}, configDir, opts = {}) {
  const dir = path.resolve(expandHome(String(
    configDir ?? flagText(flags, 'config-dir') ?? process.env.XXN_LITE_LOOP_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'dev-loop'),
  )));
  const cwd = path.resolve(expandHome(String(opts.cwd ?? flagText(flags, 'cwd') ?? process.cwd())));
  const probe = typeof opts.probe === 'function' ? opts.probe : defaultProbe;
  const resolveConfig = typeof opts.resolveConfig === 'function' ? opts.resolveConfig : resolveConfigViaCli;
  const env = opts.env ?? process.env;
  const nodeVersion = String(opts.nodeVersion ?? process.version);

  const slugs = listProjectSlugs(dir);
  const explicitProject = flagText(flags, 'project');
  const resolve = (project) => resolveConfig({ configDir: dir, project, probe, cwd });
  let projectSlug = explicitProject ?? (slugs.length === 1 ? slugs[0] : null);
  let resolution;
  if (projectSlug) {
    resolution = resolve(projectSlug);
  } else {
    const canonical = (target) => fs.existsSync(target) ? fs.realpathSync(target) : target;
    const current = canonical(cwd);
    let depth = -1;
    for (const slug of slugs) {
      const candidate = resolve(slug);
      for (const repo of candidate.config?.repos ?? []) {
        if (!repo.path) continue;
        const root = canonical(path.resolve(expandHome(repo.path)));
        const relative = path.relative(root, current);
        if (root.length > depth && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          depth = root.length;
          projectSlug = slug;
          resolution = candidate;
        }
      }
    }
    resolution ??= resolve('__doctor__');
  }
  const cfg = resolution.ok ? resolution.config : null;

  const checks = [];

  // ① Node 版本：整个 Skill 的运行时前提。
  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1] ?? 0);
  checks.push(major >= NODE_MIN_MAJOR
    ? check('node-version', 'PASS', `${nodeVersion}（>= v${NODE_MIN_MAJOR}）`)
    : check('node-version', 'BLOCK', `当前 Node ${nodeVersion} 低于 v${NODE_MIN_MAJOR}`, `升级到 Node ${NODE_MIN_MAJOR}+ 后重跑 doctor`));

  // ② git：缺失即无法做基线核对与血统校验；当前目录不是仓库只影响就近操作，不判死。
  const gitVersion = probe('git', ['--version'], { cwd });
  if (gitVersion.error || gitVersion.status !== 0) {
    const reason = gitVersion.error ?? (firstLine(gitVersion.stderr) || `退出码 ${gitVersion.status}`);
    checks.push(check('git', 'BLOCK', `git 不可用：${reason}`, '安装 git 并确保在 PATH 中'));
  } else {
    const inside = probe('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    const isRepo = inside.status === 0 && String(inside.stdout).trim() === 'true';
    checks.push(isRepo
      ? check('git', 'PASS', `${firstLine(gitVersion.stdout)} ｜ ${cwd} 是 git 仓库`)
      : check('git', 'WARN', `${firstLine(gitVersion.stdout)} ｜ ${cwd} 不是 git 仓库`, '在目标仓库目录运行，或传 --cwd <仓库路径>；已登记仓库路径仍可正常操作'));
  }

  // ③ Forge CLI：--forge 显式覆盖工程配置（与 --tier 等一致），否则以工程档案为准，不静默换实例。
  const forgeOverride = flagText(flags, 'forge')?.toLowerCase() ?? null;
  const configuredForge = (['gitlab', 'github'].includes(forgeOverride ?? '') ? forgeOverride : null)
    ?? (cfg?.forge ? String(cfg.forge).toLowerCase() : null);
  const configuredHost = !cfg?.forge || cfg.forge === configuredForge ? forgeHostArgs({ ...cfg, forge: configuredForge })[1] : null;
  const protectionHost = flagText(flags, 'hostname') ?? configuredHost
    ?? (configuredForge === 'gitlab' ? env.GITLAB_HOST : env.GH_HOST);
  let forgeLoggedIn = false;
  if (configuredForge) {
    const bin = configuredForge === 'gitlab' ? 'glab' : 'gh';
    const state = probeForgeCli(bin, probe, cwd, protectionHost);
    forgeLoggedIn = state.loggedIn;
    if (!state.installed) {
      checks.push(check('forge-cli', 'BLOCK', `工程 Forge=${configuredForge}，但 ${bin} 不可用：${state.detail}`, `安装 ${bin} 后执行 ${bin} auth login`));
    } else if (!state.loggedIn) {
      checks.push(check('forge-cli', 'BLOCK', `${bin} 已安装但未登录：${state.detail}`, `执行 ${bin} auth login 完成登录后重跑 doctor`));
    } else {
      checks.push(check('forge-cli', 'PASS', `${configuredForge} ｜ ${state.detail}`));
    }
  } else {
    const glab = probeForgeCli('glab', probe, cwd);
    const gh = probeForgeCli('gh', probe, cwd);
    const usable = [glab.loggedIn ? 'glab' : null, gh.loggedIn ? 'gh' : null].filter(Boolean);
    checks.push(usable.length
      ? check('forge-cli', 'PASS', `未配置 forge，探测到可用：${usable.join(' / ')}（工程档案仍需写明 forge）`)
      : check('forge-cli', 'BLOCK', `未配置 forge，且 glab / gh 均不可用（${glab.detail}；${gh.detail}）`, '安装并登录 glab 或 gh，并在工程档案写 forge: gitlab|github'));
  }
  checks.push(checkForgeBranchProtection(cfg, configuredForge, { probe, cwd, env, loggedIn: forgeLoggedIn, host: protectionHost }));

  // ④ 配置：me.yaml 与工程档案存在且能解析；未初始化只 WARN 引导冷启动。
  const meFile = findConfigFile(dir, 'me');
  const projectFile = projectSlug ? findConfigFile(path.join(dir, 'projects'), projectSlug) : null;
  if (!resolution.ok) {
    checks.push(check('config', 'BLOCK', `配置无法解析（${resolution.code}）：${resolution.message}`, '按报错行修好 me.yaml / projects/<slug>.yaml（支持 .json 等价格式），或删掉损坏文件重跑冷启动向导'));
  } else {
    const parts = [meFile ? `me.yaml ✓ ${meFile}` : 'me.yaml 缺失'];
    if (projectSlug) parts.push(projectFile ? `工程档案 ✓ ${projectFile}` : `工程档案缺失：projects/${projectSlug}.yaml|yml|json`);
    else if (slugs.length > 0) parts.push(`未指定 --project（检测到 ${slugs.length} 个工程档案）`);
    else parts.push('工程档案缺失');
    const ready = Boolean(meFile) && Boolean(projectFile);
    // 三层协作规矩的轻护栏提醒与 L3 越界拦截：只把提醒搬到 config 检查里，绝不把基础运行判死。
    const rulesWarnings = (Array.isArray(cfg?.warnings) ? cfg.warnings : [])
      .filter((item) => String(item).startsWith(RULES_WARNING_PREFIX));
    const rulesBlocked = Array.isArray(cfg?.rules?.blocked) ? cfg.rules.blocked.length : 0;
    const detail = [
      ...parts,
      ...(rulesBlocked ? [`${RULES_WARNING_PREFIX}L3 个人规矩已拦下 ${rulesBlocked} 条（不生效）`] : []),
      ...rulesWarnings,
    ].join(' ｜ ');
    if (ready && (rulesWarnings.length > 0 || rulesBlocked > 0)) {
      checks.push(check('config', 'WARN', detail, '按提醒精简 rules（每层 ≤5 条、单条 ≤80 字、三层合计 ≤10 条，只收协作与风控规矩）；L3 个人规矩不得绕过公共门禁'));
    } else if (ready) {
      checks.push(check('config', 'PASS', detail));
    } else {
      checks.push(check('config', 'WARN', detail, '按 4 题冷启动向导一次生成 me.yaml 与工程档案（绝不让用户手写 YAML）；多工程时传 --project <slug>'));
    }
  }

  // ⑤ 首个校验命令：只看配置里第一条命令的可执行性，缺失只 WARN（验证时才发现也来得及）。
  const commandEntries = Object.entries(isPlainObject(cfg?.verification?.commands) ? cfg.verification.commands : {});
  if (commandEntries.length === 0) {
    checks.push(check('verification-command', 'PASS', '未配置 verification.commands（按仓库实际命令自验）'));
  } else {
    const [repoName, command] = commandEntries[0];
    const executable = String(command ?? '').trim().replace(/^(?:[A-Za-z_]\w*=(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s"'\\])*(?:[ \t]+|$))+/, '');
    const token = executable.match(/^("[^"]+"|'[^']+'|\S+)/)?.[0]?.replace(/^['"]|['"]$/g, '') ?? '';
    const repoPath = cfg?.repos?.find((r) => r?.name === repoName || String(r?.repo ?? '') === repoName)?.path
      ?? cfg?.repos?.[0]?.path ?? null;
    const baseDir = repoPath ? path.resolve(expandHome(String(repoPath))) : cwd;
    const shellBuiltin = ['cd', 'echo', 'export', 'source', '.', 'set', 'true', 'false', 'test', '[', 'if', 'for'].includes(token);
    const pathLike = /^(\.{1,2}[\\/]|\/|~[\\/])/.test(token) || (token.includes('/') && !/^https?:/.test(token));
    let status = 'PASS';
    let detail;
    if (!token) {
      status = 'WARN';
      detail = `校验命令为空：${repoName}`;
    } else if (shellBuiltin) {
      detail = `首个命令是 shell 内建 ${token}：${command}`;
    } else if (pathLike) {
      const target = path.resolve(baseDir, expandHome(token));
      status = fs.existsSync(target) ? 'PASS' : 'WARN';
      detail = status === 'PASS' ? `脚本存在：${target}` : `脚本不存在：${target}（${repoName}）`;
    } else {
      status = binaryOnPath(token, env) ? 'PASS' : 'WARN';
      detail = status === 'PASS' ? `可执行文件在 PATH：${token}` : `PATH 中找不到可执行文件：${token}（${repoName}）`;
    }
    checks.push(status === 'PASS'
      ? check('verification-command', 'PASS', detail)
      : check('verification-command', 'WARN', detail, '补齐脚本或改成当前机器可执行的命令；只影响自验，不阻塞基础运行'));
  }

  // ⑥ 飞书通知：只在配置了外部通知时检查 lark-cli，缺失永远只是 WARN。
  const notify = isPlainObject(cfg?.notify) ? cfg.notify : {};
  const notifyConfigured = Boolean(notify.feishuGroupChatId) || notify.dailyReportEnabled === true;
  const larkAvailable = binaryOnPath('lark-cli', env);
  if (!notifyConfigured) {
    checks.push(check('notify-lark', 'PASS', '未配置外部通知（仅会话内汇报）'));
  } else {
    checks.push(larkAvailable
      ? check('notify-lark', 'PASS', '已配置飞书通知，lark-cli 在 PATH 中')
      : check('notify-lark', 'WARN', '已配置飞书通知，但 PATH 中没有 lark-cli：外部通知会失败', '安装并登录 lark-cli；缺失只影响外部通知，不阻塞任何档位'));
  }

  const blocked = checks.some((c) => c.status === 'BLOCK');
  const configReady = checks.find((c) => c.id === 'config')?.status === 'PASS';
  const supportedTiers = blocked ? [] : configReady ? TIERS : ['L1'];
  const count = (status) => checks.filter((c) => c.status === status).length;
  const summary = [
    `${count('PASS')} PASS ｜ ${count('WARN')} WARN ｜ ${count('BLOCK')} BLOCK`,
    `可用档位：${supportedTiers.length ? supportedTiers.join(' / ') : '无（先修 BLOCK 项）'}`,
  ].join(' ｜ ');

  return { ok: !blocked, checks, supportedTiers, externalNotifyAvailable: larkAvailable, summary };
}

/* ------------------------------------------------------------------ */
/* 模块 2：台账 lint                                                     */
/* ------------------------------------------------------------------ */

const HEADING = /^ {0,3}##\s*(\d+)\s*[.、．)）:：]?\s*(.*)$/;

function parseHeadings(lines) {
  const map = new Map();
  lines.forEach((line, index) => {
    const m = HEADING.exec(line);
    if (!m) return;
    const no = Number(m[1]);
    if (!map.has(no)) map.set(no, { no, title: m[2].trim(), index });
  });
  return map;
}

function ledgerLines(body) {
  const normalized = String(body ?? '').replace(/\r\n?/g, '\n');
  return normalized ? normalized.replace(/\n$/, '').split('\n') : [];
}

function countLedgerLines(body) {
  return ledgerLines(body).length;
}

function ledgerSection(body, no) {
  const lines = ledgerLines(body);
  const heading = parseHeadings(lines).get(no);
  if (!heading) return '';
  const start = heading.index + 1;
  const end = lines.findIndex((line, index) => index >= start && /^ {0,3}#{1,2}(?:\s|(?=\d))/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

function parseLedgerState(value) {
  const text = String(value ?? '').trim();
  if (LEDGER_STATES.includes(text)) return { state: text, original: null };
  const paused = /^暂停\s*[（(]\s*原\s*[：:]\s*(.+?)\s*[)）]$/.exec(text);
  if (paused && LEDGER_STATES.includes(paused[1])) return { state: '暂停', original: paused[1] };
  return null;
}

function ledgerLayout(tier, kind) {
  if (kind === 'master') return { key: 'master', ...LEDGER_LAYOUT.master };
  if (tier === 'L1') return { key: 'tracking', ...LEDGER_LAYOUT.tracking };
  return { key: 'personal', ...LEDGER_LAYOUT.personal };
}

function runLedgerLint(flags = {}) {
  const tier = String(flagText(flags, 'tier') ?? 'L2').toUpperCase();
  if (!TIERS.includes(tier)) throw new CliError('INVALID_TIER', `--tier 只能是 ${TIERS.join('/')}，收到：${flags.tier}`);
  const kind = flagText(flags, 'kind');
  if (kind !== null && !['master', 'personal'].includes(kind)) throw new CliError('INVALID_KIND', `--kind 只能是 master 或 personal，收到：${kind}`);
  const layout = ledgerLayout(tier, kind);
  const maxLines = flagText(flags, 'max-lines') !== null ? positiveInt(flags['max-lines'], 'max-lines') : LEDGER_MAX_LINES[tier];

  let body = typeof flags.body === 'string' && flags.body.trim() ? flags.body : null;
  if (body === null) {
    const file = flagText(flags, 'file');
    if (file === null) throw new CliError('MISSING_FLAG', '缺少必填参数 --body 或 --file');
    const target = path.resolve(expandHome(file));
    try {
      body = fs.readFileSync(target, 'utf8');
    } catch (err) {
      throw new CliError('FILE_READ_FAILED', `无法读取 --file：${target}（${err.message}）`);
    }
  }

  const lines = ledgerLines(body);
  const lineCount = lines.length;
  const headings = parseHeadings(lines);
  const issues = [];

  // ① 行数：一屏读完是 AI 不失忆的前提。
  if (lineCount > maxLines) {
    issues.push({
      code: 'LINE_LIMIT_EXCEEDED',
      severity: 'BLOCK',
      message: `正文 ${lineCount} 行超过 ${maxLines} 行上限（${tier} ${layout.label}）`,
      hint: '台账只保留当前快照：删过程流水与设计讨论，长内容放变更单或另开会话；上限见 references/tiers.md 的 ledgerMaxLines。',
    });
  }

  // ② 固定章节：编号与稳定关键词都在，脚本和 AI 才有稳定锚点。
  const missing = layout.titles
    .map((title, idx) => ({ no: idx + 1, title, heading: headings.get(idx + 1) }))
    .filter((item) => !item.heading || !item.heading.title.includes(item.title))
    .map((item) => `第 ${item.no} 节「${item.title}」`);
  if (missing.length) {
    issues.push({
      code: 'MISSING_SECTION',
      severity: 'BLOCK',
      message: `固定章节缺失或标题不符：${missing.join('、')}`,
      hint: `按 references/templates.md 的${layout.label}模板恢复第 1..${layout.titles.length} 节，标题保留编号与关键词。`,
    });
  }

  // ③ 第 1 节状态：只认固定枚举，否则任何脚本都读不出当前状态。
  if (layout.requireState) {
    const section = ledgerSection(body, 1);
    const matched = /状态\s*[：:]\s*([^｜|\r\n]+)/.exec(section);
    const value = matched ? matched[1].trim() : null;
    if (value === null) {
      issues.push({
        code: 'INVALID_STATE',
        severity: 'BLOCK',
        message: '第 1 节缺少「状态：」字段',
        hint: `第 1 节必须写「状态：<固定枚举>」：${LEDGER_STATES.join(' / ')}，或「暂停（原：某合法状态）」。`,
      });
    } else if (!parseLedgerState(value)) {
      const templateNote = value === '初始化' ? '（init 模板当前写「初始化」，应改为「未开始」）' : '';
      issues.push({
        code: 'INVALID_STATE',
        severity: 'BLOCK',
        message: `第 1 节「状态：${value}」不在固定枚举内${templateNote}`,
        hint: `只能是 ${LEDGER_STATES.join(' / ')}，或「暂停（原：某合法状态）」。`,
      });
    }
  }

  // ④ 围栏代码块：台账会膨胀，且任何按行解析的脚本都会错位。
  const fences = lines.filter((line) => /^\s{0,3}```/.test(line)).length;
  if (fences > 0) {
    issues.push({
      code: 'CODE_FENCE_FORBIDDEN',
      severity: 'BLOCK',
      message: `正文含 ${fences} 处围栏代码块（\`\`\`）：台账会膨胀且脚本无法稳定解析`,
      hint: '代码、日志、命令清单放变更单或普通会话，台账只写一行结论与链接。',
    });
  }

  return { ok: issues.length === 0, lineCount, maxLines, issues, exitCode: issues.length ? 2 : 0 };
}

/** 削弱门禁的动作词：命中后还必须落在受保护对象上才算违规。 */
const BYPASS_VERBS = /(免除?|跳过|绕开|绕过|无需|无须|不用|不必|不经过|不走|不送|省去|省略|忽略|关闭|取消|私自|自行|强制|先合|直接(合|合并|合入|推|改|写入|落盘))/;

/** 复述公共规则（禁止句 / 强制句）不是违规，先整体放行；只认真正的否定与必经表述。 */
const RULE_RESTATEMENT = /(不得|不可|不能|禁止|严禁|绝不|不允许|勿|必经|必须先|须先|先过|方可|才能|必须经|必须走)/;

const POLICY_RULES = [
  {
    code: 'BYPASS_FINAL_REVIEW',
    message: '个人约定试图免掉或跳过独立终审（公共硬底线：所有变更必经 1 次独立终审）',
    verbs: BYPASS_VERBS,
    objects: [/终审/, /独立审/],
  },
  {
    code: 'DOWNGRADE_RISK',
    message: '个人约定试图降级风险判定或强制风险低（公共硬底线：6 条规则命中即高风险，未核验不得判低）',
    verbs: /(降(低|级|档)|调低|调降|放宽|降格|按低风险|视为低风险|当作低风险|强制低|一律低|直接判低)/,
    objects: [/风险(?:等级|判定|定级|高|低)/],
  },
  {
    code: 'BYPASS_CONTRACT_OR_HOTFILE',
    message: '个人约定试图绕过升级串改契约或他人热点文件（公共硬底线：契约与归属变更必须走升级串裁决）',
    verbs: BYPASS_VERBS,
    objects: [/契约/, /热点文件/, /归属表/, /他人(的)?(文件|代码|模块)/],
  },
  {
    code: 'BYPASS_BRANCH_GATE',
    message: '个人约定试图绕过分支门禁或私自合入基线/环境分支（公共硬底线：test/uat/main/master 只允许人合）',
    verbs: /(直接合|直接合并|直接合入|自行合|私自合|绕过|跳过|无需审|不用审|先合入|直接推|强推)/,
    objects: [/分支门禁/, /受保护分支/, /环境分支/, /基线/, /\b(test|uat|main|master)\b/i],
  },
];

function checkPersonalPolicyOverride(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const violations = [];
  const seen = new Set();
  for (const clause of source.split(/[，,。；;\n]/)) {
    const evidence = clause.replace(/\s+/g, ' ').trim();
    if (!evidence || RULE_RESTATEMENT.test(evidence)) continue;
    for (const rule of POLICY_RULES) {
      if (!rule.verbs.test(evidence)) continue;
      if (!rule.objects.some((pattern) => pattern.test(evidence))) continue;
      const key = `${rule.code}:${evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ code: rule.code, message: rule.message, evidence: evidence.slice(0, 120) });
    }
  }
  return { ok: violations.length === 0, violations };
}

/* ------------------------------------------------------------------ */
/* 模块 5：单屏健康视图                                                    */
/* ------------------------------------------------------------------ */

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) {
    return Object.entries(value).map(([key, item]) => (isPlainObject(item) ? { key, ...item } : { key, id: item }));
  }
  return [];
}

function isMergedState(state) {
  return /^(merged|已合入|已合并)$/i.test(String(state ?? '').trim());
}

function normalizeIssues(raw) {
  return asArray(raw).map((item) => ({
    ref: String(item.url ?? item.key ?? item.id ?? 'issue'),
    state: String(item.state ?? item.status ?? '').trim(),
    slot: item.slot ?? null,
    stale: item.stale === true,
  }));
}

function labelNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((label) => typeof label === 'string' ? label : label?.name ?? label?.title ?? '').filter(Boolean);
}

function normalizeMrs(raw) {
  return asArray(raw).map((item) => {
    const state = String(item.state ?? item.status ?? '').trim();
    const labels = labelNames(item.labels);
    const inReview = labels.includes('终审中') && !labels.includes('待终审');
    const rejected = inReview && item.review?.state === 'rejected';
    return {
      ref: String(item.url ?? (item.repo && item.id ? `${item.repo}!${item.id}` : (item.id ?? item.key ?? 'MR'))),
      slot: item.slot ?? item.ownerSlot ?? labels.find((label) => /^槽位.+/.test(label))?.slice(2) ?? null,
      open: !isMergedState(state) && !/^(closed|locked|已关闭)$/i.test(state),
      blocked: state === '阻断' || labels.includes('阻断'),
      needsChanges: rejected || state === '需修改' || labels.includes('需修改') || String(item.reviewVerdict ?? '').trim() === '打回',
      awaitingReview: !rejected && [state, ...labels].some((label) => label === '待终审' || label === '终审中'),
      rejectCount: Number(item.review?.rejectCount ?? item.rejectCount ?? 0) || 0,
      stale: item.stale === true,
    };
  });
}

function normalizeEscalations(raw) {
  return asArray(raw).map((item) => ({
    ref: String(item.id ?? item.url ?? item.key ?? '升级'),
    slot: item.slot ?? null,
    blocking: item.blocking === true || String(item.kind ?? '').trim() === '阻断',
    resolved: item.resolved === true || String(item.verdict ?? '').trim() !== '',
  }));
}

function collectSlotNames(live, mrs, issues, escalations) {
  const names = [];
  for (const item of asArray(live?.slots)) {
    const name = typeof item === 'string' ? item : (item?.slot ?? item?.name ?? item?.key);
    if (name) names.push(String(name));
  }
  for (const item of [...mrs, ...issues, ...escalations]) if (item.slot) names.push(String(item.slot));
  return [...new Set(names)];
}

function slotHealthOf(slot, { mrs, issues, escalations, fuse, slotMeta }) {
  const mine = mrs.filter((m) => m.slot === slot && m.open);
  const escalationsMine = escalations.filter((e) => e.slot === slot && e.blocking && !e.resolved);
  const blockedIssues = issues.filter((i) => i.slot === slot && i.state === '阻断');
  const awaitingVerdict = issues.filter((i) => i.slot === slot && i.state === '待裁决');
  const fused = mine.filter((m) => m.rejectCount >= fuse);
  const blocked = mine.filter((m) => m.blocked);
  const needsChanges = mine.filter((m) => m.needsChanges);
  const awaitingReview = mine.filter((m) => m.awaitingReview);
  const stale = mine.filter((m) => m.stale);
  const unclaimed = slotMeta && slot !== '主研发' && !slotMeta.owner && !slotMeta.sessionId;

  const red = [];
  const yellow = [];
  if (escalationsMine.length) red.push(`阻断升级 ${escalationsMine.length}`);
  if (blockedIssues.length) red.push(`台账阻断 ${blockedIssues.length}`);
  if (fused.length) red.push(`打回熔断 ${fused.length}（交人裁决）`);
  if (blocked.length) yellow.push(`MR 阻断 ${blocked.length}`);
  if (needsChanges.length) yellow.push(`需修改 ${needsChanges.length}`);
  if (awaitingReview.length) yellow.push(`待终审 ${awaitingReview.length}`);
  if (awaitingVerdict.length) yellow.push(`待裁决 ${awaitingVerdict.length}`);
  if (stale.length) yellow.push(`停滞 ${stale.length}`);
  if (unclaimed) yellow.push('待认领');

  const level = red.length ? 'red' : (yellow.length ? 'yellow' : 'green');
  const summary = red.length || yellow.length ? [...red, ...yellow].join(' ｜ ') : '无异常';
  return { slot, level, summary };
}

function buildLiveStatus(base, live, run, forgeFacts) {
  const data = live ?? run;
  const errors = forgeFacts?.errors ?? [];
  const verified = !live && forgeFacts && !errors.length;
  const req = run?.req ?? live?.req ?? base.req ?? null;
  const tier = run?.tier ?? live?.tier ?? null;
  const stage = run?.stage ?? live?.stage ?? null;
  const fuse = Number(data?.rejectFuseCount ?? run?.thresholds?.rejectFuseCount ?? REJECT_FUSE) || REJECT_FUSE;

  const issues = normalizeIssues(verified ? [...forgeFacts.ledgers, ...forgeFacts.subIssues].map((issue) => ({
    ...issue,
    slot: issue.key?.match(/^slot:(.+)$/)?.[1] ?? issue.labels?.find((label) => /^槽位.+/.test(label))?.slice(2),
    state: issue.state === 'open' ? (issue.labels?.includes('阻断') ? '阻断' : ledgerField(ledgerSection(issue.body, 1), '状态') ?? 'open') : issue.state,
  })) : data?.issues);
  const mrs = normalizeMrs(verified ? forgeFacts.changes : data?.mrs ?? data?.changes);
  const blockers = asArray(data?.blockers)
    .filter((blocker) => !blocker.closed)
    .map((blocker) => ({ ...blocker, blocking: true }));
  const escalationLedger = verified ? forgeFacts.ledgers.find((item) => item.key === 'escalation' && item.state === 'open') : null;
  const master = verified ? forgeFacts.ledgers.find((item) => item.key === 'master') : null;
  const escalations = normalizeEscalations(verified
    ? escalationsFor(escalationLedger, master, ledgerSection).map((entry) => ({ ...entry, resolved: entry.adjudicated }))
    : [...asArray(data?.escalations), ...blockers]);
  const slotMetas = new Map();
  for (const item of asArray(data?.slots)) {
    const name = typeof item === 'string' ? item : (item?.slot ?? item?.name ?? item?.key);
    if (name) slotMetas.set(String(name), typeof item === 'object' ? item : { slot: name });
  }
  const slotNames = collectSlotNames(data, mrs, issues, escalations);

  const actions = [];
  const push = (code, level, text, extra = {}) => actions.push({ code, level, text, ...extra });
  for (const item of escalations) {
    if (item.blocking && !item.resolved) push('ESCALATION_BLOCKING', 'red', `阻断升级未裁决：${item.ref}`, { ref: item.ref, slot: item.slot });
  }
  for (const item of issues) {
    if (item.state === '阻断') push('LEDGER_BLOCKED', 'red', `台账处于阻断：${item.ref}`, { ref: item.ref, slot: item.slot });
    if (item.state === '待裁决') push('LEDGER_AWAITING_VERDICT', 'yellow', `台账待裁决：${item.ref}`, { ref: item.ref, slot: item.slot });
  }
  for (const item of mrs) {
    if (!item.open) continue;
    if (item.rejectCount >= fuse) push('REJECT_FUSE', 'red', `${item.ref} 累计打回 ${item.rejectCount} 次已熔断：交人裁决`, { ref: item.ref, slot: item.slot });
    if (item.blocked) push('MR_BLOCKED', 'yellow', `${item.ref} 处于阻断`, { ref: item.ref, slot: item.slot });
    if (item.needsChanges) push('MR_NEEDS_CHANGES', 'yellow', `${item.ref} 需修改`, { ref: item.ref, slot: item.slot });
    if (item.awaitingReview) push('MR_AWAITING_REVIEW', 'yellow', `${item.ref} 待终审`, { ref: item.ref, slot: item.slot });
    if (item.stale) push('MR_STALE', 'yellow', `${item.ref} 停滞超时`, { ref: item.ref, slot: item.slot });
  }
  if (run?.pendingUpgrade) {
    push('PENDING_UPGRADE', 'yellow', `未落盘升档 ${run.pendingUpgrade.from ?? tier ?? ''}→${run.pendingUpgrade.to}：补齐外部对象后 upgrade --apply`, { ref: req });
  }
  if (run?.pendingTeardown) {
    push('PENDING_TEARDOWN', 'yellow', `拆架 ${run.pendingTeardown.phase}：按清单逐项回执后 teardown --finalize`, { ref: req });
  }
  const levelRank = { red: 0, yellow: 1, green: 2 };
  actions.sort((a, b) => (levelRank[a.level] - levelRank[b.level])
    || a.code.localeCompare(b.code)
    || String(a.ref ?? '').localeCompare(String(b.ref ?? '')));

  const slotHealth = slotNames
    .map((slot) => slotHealthOf(slot, { mrs, issues, escalations, fuse, slotMeta: slotMetas.get(slot) }))
    .sort((a, b) => levelRank[a.level] - levelRank[b.level]);
  const openMrs = mrs.filter((m) => m.open);
  const totals = {
    issues: issues.length,
    mrs: mrs.length,
    openMrs: openMrs.length,
    awaitingReview: openMrs.filter((m) => m.awaitingReview).length,
    needsChanges: openMrs.filter((m) => m.needsChanges).length,
    blockedMrs: openMrs.filter((m) => m.blocked).length,
    blockingEscalations: escalations.filter((e) => e.blocking && !e.resolved).length,
    slots: slotHealth.length,
    actions: actions.length,
  };

  const overview = {
    state: base.state ?? (base.needsOnboarding ? 'onboarding' : (live ? 'live' : 'idle')),
    req,
    tier,
    stage,
    source: verified ? 'forge' : live ? 'live' : 'run',
    totals,
    headline: [
      errors.length ? `Forge 实时读取失败 ${errors.length} 项（${[...new Set(errors.map(({ code }) => code))].join('、')}）` : null,
      tier ?? '未配置档位',
      `阶段 ${stage ?? '未知'}`,
      `未合入 MR ${totals.openMrs}`,
      `阻断 ${totals.blockingEscalations}`,
      `待办 ${totals.actions} 项`,
      live || verified ? null : (forgeFacts ? '（概览基于运行态，实查见 forgeFacts）' : '（未提供 live 数据，仅基于运行态）'),
    ].filter(Boolean).join(' ｜ '),
  };

  const first = actions[0];
  const fallback = base.run?.nextPrompt ?? base.activeRuns?.find((entry) => entry.req === req)?.nextPrompt ?? base.nextPrompt ?? '$xxn-lite-loop <一句话描述你要做的需求>';
  const nextPrompt = first ? `$xxn-lite-loop 处理 ${req ?? '当前需求'}：${first.text}` : fallback;

  return { overview, actionRequired: actions, slotHealth, nextPrompt };
}

/* ------------------------------------------------------------------ */
/* 导出（loopctl.mjs 路由调用；本文件不执行任何写操作）                       */
/* ------------------------------------------------------------------ */

export {
  TRACKING_SECTIONS,
  PERSONAL_SECTIONS,
  RULES_WARNING_PREFIX,
  countLedgerLines,
  ledgerSection,
  labelNames,
  runDoctor,
  runLedgerLint,
  checkPersonalPolicyOverride,
  buildLiveStatus,
};
