#!/usr/bin/env node
/**
 * guard.mjs — xxn-lite-loop 的脚本化状态守卫与写前锁（纯函数）。
 *
 * 零依赖 Node.js ESM（Node 20+）。状态守卫由 loopctl.mjs 路由调用：
 *   runDoctor(flags, configDir, opts)  只读环境体检：能不能跑、能跑到哪一档
 *   runLedgerLint(flags)               台账 4 条硬伤：行数、固定章节、状态枚举、围栏代码块
 *   runTransitionCheck(flags)          状态机 5 条红线：主控、漏审、熔断、阻断、环境分支
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

/** `--input` / `--live-input` 同时支持内联 JSON 与 `@file`（与 loopctl 的 parseJsonArg 一致）。 */
function readJsonArg(flags, key, { required = true } = {}) {
  const raw = flagText(flags, key);
  if (raw === null) {
    if (!required) return null;
    throw new CliError('MISSING_FLAG', `缺少必填参数 --${key}`);
  }
  let text = raw;
  if (raw.startsWith('@')) {
    const file = path.resolve(expandHome(raw.slice(1)));
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new CliError('FILE_READ_FAILED', `无法读取 --${key} 文件：${file}（${err.message}）`);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError('INVALID_JSON', `--${key} 不是合法 JSON：${err.message}`);
  }
  if (!isPlainObject(parsed)) throw new CliError('INVALID_JSON', `--${key} 必须是 JSON 对象`);
  return parsed;
}

function splitPatterns(value) {
  if (value == null || value === true) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value).trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return splitPatterns(parsed);
    } catch { /* fall back to the delimited form */ }
  }
  const patterns = [];
  let start = 0;
  let inRegex = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && inRegex) i += 1;
    else if (char === '/' && (inRegex || !text.slice(start, i).trim())) inRegex = !inRegex;
    else if (char === ',' && !inRegex) {
      patterns.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  patterns.push(text.slice(start).trim());
  return patterns.filter(Boolean);
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

function probeForgeCli(bin, probe, cwd) {
  const result = probe(bin, ['auth', 'status'], { cwd, timeout: 20000 });
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
  if (configuredForge) {
    const bin = configuredForge === 'gitlab' ? 'glab' : 'gh';
    const state = probeForgeCli(bin, probe, cwd);
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

/* ------------------------------------------------------------------ */
/* 模块 3：状态机红线                                                     */
/* ------------------------------------------------------------------ */

function transitionBlock(code, reason, requiredAction) {
  return { ok: false, allowed: false, code, reason, requiredAction, exitCode: 2 };
}

function runTransitionCheck(flags = {}) {
  const input = readJsonArg(flags, 'input');
  const tier = String(input.tier ?? 'L2').toUpperCase();
  if (!TIERS.includes(tier)) throw new CliError('INVALID_TIER', `tier 只能是 ${TIERS.join('/')}，收到：${input.tier}`);

  const states = {};
  for (const name of ['fromState', 'toState']) {
    const value = String(input[name] ?? '').trim();
    const parsed = parseLedgerState(value);
    if (!parsed) {
      throw new CliError('INVALID_STATE', `${name} 必须是 ${LEDGER_STATES.join('/')} 之一，收到：${value || '(空)'}`);
    }
    states[name] = parsed;
  }
  const { fromState: from, toState: { state: toState } } = states;
  // mrMeta.hasUnmergedDependsOn 不在这里判：叠加依赖由 forge.mjs change-merge 与 eval-review 实查，
  // guard 只守状态机 5 条红线，同一门禁不重复实现（否则两处口径必然漂移）。
  const mrMeta = isPlainObject(input.mrMeta) ? input.mrMeta : {};
  const autoMerge = input.autoMerge === true || mrMeta.autoMerge === true;
  const rejectCount = Number(mrMeta.rejectCount ?? input.rejectCount ?? 0) || 0;

  // ① 非现任主控写台账，且没有显式声明接任：串单与误覆盖的第一来源。
  if (input.isOwner === false && input.isHandoff !== true) {
    return transitionBlock(
      'NOT_OWNER',
      '当前会话不是台账现任主控，且未声明接任：禁止变更状态',
      '先 issue-get 核对第 1 节「主控：第 N 任 ｜ <sessionId>」；非现任立即停写并自停定时任务，确需接管则显式传 isHandoff: true。',
    );
  }

  // ② 跳过独立终审直奔待合并/已合入：漏审的唯一入口。
  if (toState === '待合并' || toState === '已合入') {
    const reviewed = mrMeta.hasValidReview === true && String(mrMeta.reviewVerdict ?? '').trim() === '通过';
    const l1Escape = tier === 'L1' && input.allowSkipReview === true && !autoMerge;
    const fusedVerdict = toState === '待合并' && rejectCount >= REJECT_FUSE
      && mrMeta.hasValidReview === true && String(mrMeta.reviewVerdict ?? '').trim() === '打回';
    if (!reviewed && !l1Escape && !fusedVerdict) {
      const why = mrMeta.hasValidReview === true
        ? `终审结论是「${mrMeta.reviewVerdict ?? '未写'}」而非「通过」`
        : '没有独立终审的有效结论';
      return transitionBlock(
        'SKIP_FINAL_REVIEW',
        `直接进入「${toState}」，但${why}`,
        '先派独立终审并回写结论「通过」；仅 L1 可在显式 allowSkipReview: true 且人工合并时跳过。',
      );
    }
  }

  // ③ 打回熔断后仍试图自动合入：k≥2 一律交人裁决。
  if (rejectCount >= REJECT_FUSE && autoMerge) {
    return transitionBlock(
      'REJECT_FUSE_BLOCK',
      `同一变更单累计打回 k=${rejectCount}（≥${REJECT_FUSE}）已熔断，仍试图自动合入`,
      '熔断后结论一律交人裁决：台账第 2 节列 [待裁决]，禁止自动合并。',
    );
  }

  // ④ 阻断未解除就切回进行中/待终审：会带着未解阻断继续写码与送审。
  if ((from.original ?? from.state) === '阻断' && input.blockResolved !== true && ['进行中', '待终审'].includes(toState)) {
    return transitionBlock(
      'BLOCK_UNRESOLVED',
      '当前处于「阻断」，blockResolved 不为 true 却试图切回进行中/待终审',
      '先在台账第 4 节写清阻断解除依据（或升级串裁决结论），再切回。',
    );
  }

  // ⑤ 受保护环境分支自动合并：test/uat/main/master 一律人合。
  if (mrMeta.targetIsProtectedEnv === true && autoMerge) {
    return transitionBlock(
      'PROTECTED_ENV_AUTO_MERGE',
      '目标分支命中受保护环境分支，却试图自动合并',
      'test/uat/main/master 等环境分支一律人工合并，AI 只停在「待合并」。',
    );
  }

  return { ok: true, allowed: true };
}

/* ------------------------------------------------------------------ */
/* 模块 4：个人临时约定抽查                                                */
/* ------------------------------------------------------------------ */

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
    return {
      ref: String(item.url ?? (item.repo && item.id ? `${item.repo}!${item.id}` : (item.id ?? item.key ?? 'MR'))),
      slot: item.slot ?? item.ownerSlot ?? labels.find((label) => /^槽位.+/.test(label))?.slice(2) ?? null,
      merged: isMergedState(state),
      blocked: state === '阻断' || labels.includes('阻断'),
      needsChanges: state === '需修改' || labels.includes('需修改') || String(item.reviewVerdict ?? '').trim() === '打回',
      awaitingReview: [state, ...labels].some((label) => label === '待终审' || label === '终审中'),
      rejectCount: Number(item.rejectCount ?? 0) || 0,
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
  const mine = mrs.filter((m) => m.slot === slot && !m.merged);
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

function buildLiveStatus(base, live, run) {
  const data = live ?? run;
  const req = run?.req ?? live?.req ?? base.req ?? null;
  const tier = run?.tier ?? live?.tier ?? null;
  const stage = run?.stage ?? live?.stage ?? null;
  const fuse = Number(data?.rejectFuseCount ?? run?.thresholds?.rejectFuseCount ?? REJECT_FUSE) || REJECT_FUSE;

  const issues = normalizeIssues(data?.issues);
  const mrs = normalizeMrs(data?.mrs ?? data?.changes);
  const blockers = asArray(data?.blockers)
    .filter((blocker) => !blocker.closed)
    .map((blocker) => ({ ...blocker, blocking: true }));
  const escalations = normalizeEscalations([...asArray(data?.escalations), ...blockers]);
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
    if (item.merged) continue;
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
  const openMrs = mrs.filter((m) => !m.merged);
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
    source: live ? 'live' : 'run',
    totals,
    headline: [
      tier ?? '未配置档位',
      `阶段 ${stage ?? '未知'}`,
      `未合入 MR ${totals.openMrs}`,
      `阻断 ${totals.blockingEscalations}`,
      `待办 ${totals.actions} 项`,
      live ? null : '（未提供 live 数据，仅基于运行态）',
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
  splitPatterns,
  runDoctor,
  runLedgerLint,
  runTransitionCheck,
  checkPersonalPolicyOverride,
  buildLiveStatus,
};