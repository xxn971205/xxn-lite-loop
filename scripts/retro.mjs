#!/usr/bin/env node
/**
 * retro.mjs — xxn-lite-loop 的条件触发复盘引擎（纯只读）。
 *
 * 设计边界：
 *   1. 只读：不改配置、不发 Issue、不写任何文件；提案与 Issue 草稿只作为返回值。
 *   2. 条件触发：小顺风需求不打扰，只有命中客观硬门槛或 --force 才产出提案。
 *   3. 只谈 Loop 机制与配置：不评价个人代码风格，不给编程语言写法建议。
 *   4. 脱敏：草稿只含计数与通用机制描述，不含业务路径、仓库名、人员姓名与需求名。
 *
 * 用法：
 *   node scripts/retro.mjs --req <slug> --input @facts.json
 *   node scripts/retro.mjs --req <slug> --input '{"mrCount":6,"firstPassCount":3}'
 *   node scripts/retro.mjs --req <slug> --force --feedback-repo <owner/repo>
 *
 * 退出码：0 = 正常（无论是否触发），2 = 参数或读取错误。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const SKILL_NAME = 'xxn-lite-loop';
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGE_PATH = path.join(SKILL_ROOT, 'scripts', 'forge.mjs');
const DEFAULT_FEEDBACK_REPO = 'xxn/xxn-lite-loop';
const MAX_PROPOSALS = 5;
const NOT_TRIGGERED_REASON = '小顺风需求未命中复盘门槛，建议直接收尾拆架。';
const ENV_BRANCHES = ['main', 'master', 'test', 'uat'];
const PUBLIC_TERMS = new Set([...ENV_BRANCHES, SKILL_NAME, 'xxn', 'lite', 'loop', 'git', 'node', 'repo']);
const CATEGORY_LABEL = { 'config-tune': '配置调优', 'project-guard': '工程守卫', 'skill-proposal': 'Skill 提案' };

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ */
/* 参数与文件                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
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
  return { flags, positional };
}

function optFlag(flags, key) {
  const v = flags[key];
  return v === undefined || v === true || String(v).trim() === '' ? null : String(v);
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveConfigDir(flags) {
  const dir = optFlag(flags, 'config-dir') ?? process.env.XXN_LITE_LOOP_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'dev-loop');
  return path.resolve(expandHome(dir));
}

/** 与 loopctl.mjs 的 safeSlug 保持同一规则，保证能找到同名的 run.json。 */
function safeSlug(value) {
  const s = String(value ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/\.{2,}/g, '.');
  return s.replace(/^[.-]+|[.-]+$/g, '') || 'req';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError('RUN_NOT_FOUND', `读取失败：${file}（${err.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError('INVALID_JSON', `${file} 不是合法 JSON：${err.message}`);
  }
}

function listActiveRunFiles(configDir) {
  const runsDir = path.join(configDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(runsDir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/* ------------------------------------------------------------------ */
/* 输入事实                                                              */
/* ------------------------------------------------------------------ */

function parseInput(raw) {
  if (raw === null || raw === undefined) return {};
  let text = String(raw);
  if (text.trim().startsWith('@')) {
    const file = expandHome(text.trim().slice(1));
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new CliError('INPUT_NOT_FOUND', `--input 文件读取失败：${file}（${err.message}）`);
    }
  }
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError('INVALID_INPUT', `--input 不是合法 JSON：${err.message}`);
  }
  if (!isPlainObject(parsed)) throw new CliError('INVALID_INPUT', '--input 顶层必须是对象');
  return parsed;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function knownCount(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function amount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeFacts(raw) {
  const corrections = (Array.isArray(raw.repeatedCorrections) ? raw.repeatedCorrections : [])
    .filter(isPlainObject)
    .map((item) => ({
      type: String(item.type ?? '').trim() || '未命名纠偏',
      count: count(item.count),
      refs: Array.isArray(item.refs) ? item.refs.map((r) => String(r)) : item.refs == null ? [] : [String(item.refs)],
    }))
    .filter((item) => item.count > 0);
  const tempRules = (Array.isArray(raw.tempRules) ? raw.tempRules : [])
    .filter(isPlainObject)
    .map((item) => ({
      text: String(item.text ?? '').trim(),
      effective: item.effective === true,
      reusable: item.reusable === true,
    }))
    .filter((item) => item.text);
  return {
    mrCount: count(raw.mrCount),
    firstPassCount: knownCount(raw.firstPassCount),
    rejectCount: count(raw.rejectCount),
    fusedRejectCount: count(raw.fusedRejectCount),
    durationDays: Math.round(amount(raw.durationDays) * 10) / 10,
    repeatedCorrections: corrections,
    blockingTimeoutCount: count(raw.blockingTimeoutCount),
    stuckOrDisconnectCount: count(raw.stuckOrDisconnectCount),
    reviewTimeoutCount: count(raw.reviewTimeoutCount),
    collisionCount: count(raw.collisionCount),
    guardBlockCount: count(raw.guardBlockCount),
    tempRules,
  };
}

/* ------------------------------------------------------------------ */
/* run.json 定位                                                         */
/* ------------------------------------------------------------------ */

function loadRun(flags, configDir) {
  const req = optFlag(flags, 'req');
  const runsDir = path.join(configDir, 'runs');
  if (req) {
    const slug = safeSlug(req);
    const active = path.join(runsDir, `${slug}.json`);
    const archived = path.join(runsDir, 'archive', `${slug}.json`);
    if (fs.existsSync(active)) return { run: readJson(active), runPath: active, archived: false, req };
    if (fs.existsSync(archived)) return { run: readJson(archived), runPath: archived, archived: true, req };
    throw new CliError('RUN_NOT_FOUND', `未找到需求运行快照：${active}（归档路径 ${archived} 也不存在）`, { req, runPath: active });
  }
  const files = listActiveRunFiles(configDir);
  if (files.length === 0) {
    throw new CliError('NO_ACTIVE_RUN', `没有活跃需求：${runsDir} 下无 run.json；已归档需求请用 --req 指定`, { runsDir });
  }
  if (files.length > 1) {
    throw new CliError('AMBIGUOUS_RUN', `存在 ${files.length} 个活跃需求，请用 --req 指定要复盘的那个`, {
      runs: files.map((file) => path.basename(file, '.json')),
    });
  }
  const run = readJson(files[0]);
  return { run, runPath: files[0], archived: run?.status === 'archived', req: run?.req ?? path.basename(files[0], '.json') };
}

/* ------------------------------------------------------------------ */
/* 指标                                                                  */
/* ------------------------------------------------------------------ */

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeMetrics(facts, run) {
  const mrCount = facts.mrCount;
  const firstPassCount = facts.firstPassCount !== null && mrCount > 0
    ? Math.min(facts.firstPassCount, mrCount)
    : facts.firstPassCount;
  const rawFirstPassRate = mrCount > 0 && firstPassCount !== null ? firstPassCount / mrCount : null;
  const reviewRejects = Math.max(facts.fusedRejectCount, facts.rejectCount, count(run?.review?.rejectCount));
  const avgReviewRounds = mrCount > 0 ? round(1 + reviewRejects / mrCount, 2) : 0;
  const repeatedCorrectionTotal = facts.repeatedCorrections.reduce((sum, item) => sum + item.count, 0);
  const maxRepeatedCorrection = facts.repeatedCorrections.reduce((max, item) => Math.max(max, item.count), 0);
  return {
    firstPassRate: rawFirstPassRate === null ? null : round(rawFirstPassRate, 3),
    rawFirstPassRate,
    firstPassCount,
    mrCount,
    avgReviewRounds,
    stabilityIssues: facts.blockingTimeoutCount + facts.stuckOrDisconnectCount + facts.reviewTimeoutCount,
    frictionCount: repeatedCorrectionTotal + reviewRejects + facts.collisionCount,
    guardInterceptions: facts.guardBlockCount,
    repeatedCorrectionTotal,
    repeatedCorrectionKinds: facts.repeatedCorrections.length,
    maxRepeatedCorrection,
    tempRuleCount: facts.tempRules.length,
    reviewRejects,
    rejectFused: facts.fusedRejectCount > 0 || reviewRejects >= 2,
    lowFirstPassRate: mrCount >= 2 && rawFirstPassRate !== null && rawFirstPassRate < 0.6,
  };
}

function publicMetrics(metrics, facts) {
  return {
    firstPassRate: metrics.firstPassRate,
    avgReviewRounds: metrics.avgReviewRounds,
    stabilityIssues: metrics.stabilityIssues,
    frictionCount: metrics.frictionCount,
    guardInterceptions: metrics.guardInterceptions,
    mrCount: metrics.mrCount,
    firstPassCount: metrics.firstPassCount,
    durationDays: facts.durationDays,
    repeatedCorrectionTotal: metrics.repeatedCorrectionTotal,
    tempRuleCount: metrics.tempRuleCount,
  };
}

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

/* ------------------------------------------------------------------ */
/* 触发门槛                                                              */
/* ------------------------------------------------------------------ */

function evaluateTrigger({ facts, metrics, tier, force }) {
  if (force) {
    return { triggered: true, reasons: [{ code: 'FORCE', label: '人工强制复盘', detail: '按 --force 跳过客观门槛' }] };
  }
  const reasons = [];
  const push = (code, label, detail) => reasons.push({ code, label, detail });
  if (tier === 'L3') push('TIER_L3', 'L3 团队严格档', '多人并行或强耦合多仓，协作成本需要定期回收');
  if (facts.mrCount >= 6) push('MR_VOLUME', '变更单数量达到 6', `本次共 ${facts.mrCount} 个变更单，批次已偏大`);
  if (facts.durationDays >= 3) push('DURATION', '需求跨度达到 3 天', `本次跨度 ${facts.durationDays} 天`);
  if (metrics.rejectFused) push('FUSED_REJECT', '累计打回熔断', `累计打回熔断（记录 ${metrics.reviewRejects} 次打回）`);
  if (metrics.lowFirstPassRate) {
    push('FIRST_PASS_LOW', '一次通过率低于 60%', `一次通过率 ${pct(metrics.rawFirstPassRate)}（${metrics.firstPassCount}/${facts.mrCount}）`);
  }
  if (metrics.maxRepeatedCorrection >= 2) {
    push('REPEATED_CORRECTION', '同类纠偏重复出现', `同类纠偏最高重复 ${metrics.maxRepeatedCorrection} 次`);
  }
  if (facts.blockingTimeoutCount >= 1) push('BLOCKING_TIMEOUT', '出现阻塞超时', `阻塞超时 ${facts.blockingTimeoutCount} 次`);
  if (facts.stuckOrDisconnectCount >= 1) push('STUCK_OR_DISCONNECT', '出现卡死或断线', `卡死/断线 ${facts.stuckOrDisconnectCount} 次`);
  if (facts.collisionCount >= 1) push('COLLISION', '出现并行冲突', `并行冲突 ${facts.collisionCount} 次`);
  if (facts.tempRules.length >= 1) push('TEMP_RULES', '本次产生临时规则', `临时规则 ${facts.tempRules.length} 条`);
  return { triggered: reasons.length > 0, reasons };
}

/* ------------------------------------------------------------------ */
/* 提案规则（只谈 Loop 机制与配置）                                        */
/* ------------------------------------------------------------------ */

function reposWithoutVerification(run) {
  const repos = Array.isArray(run?.repos) ? run.repos : [];
  return repos.filter((repo) => !repo?.verificationCommand);
}

function tempRuleBuckets(facts) {
  return {
    promote: facts.tempRules.filter((rule) => rule.effective && rule.reusable).length,
    project: facts.tempRules.filter((rule) => rule.effective && !rule.reusable).length,
    drop: facts.tempRules.filter((rule) => !rule.effective).length,
  };
}

const RULES = [
  {
    id: 'fused-reject-frontload',
    category: 'config-tune',
    score: 96,
    when: (c) => c.metrics.rejectFused,
    build: (c) => ({
      title: '终审前置自检，减少累计打回熔断',
      evidence: [`累计打回熔断（记录 ${c.metrics.reviewRejects} 次打回）`, `平均终审轮次 ${c.metrics.avgReviewRounds}`],
      rootCause: '变更单进入独立终审前没有留下可复现的自检证据，终审被迫承担本可前移的验证成本，同类问题因此反复出现在终审阶段。',
      action: '在 me.yaml 打开 selfReview；在工程档案 verification.commands 为每个仓补一条最小验证命令，建变更单前先跑一遍并把结果写进变更说明。',
      frictionCost: '每次变更多一次本地验证，通常 1 分钟内；换来终审轮次下降，净成本为负。',
      dedupe: '工程档案已有该仓验证命令时，只调整原条目，不要新增重复键。',
    }),
  },
  {
    id: 'first-pass-gap',
    category: 'config-tune',
    score: 90,
    when: (c) => c.metrics.lowFirstPassRate,
    build: (c) => ({
      title: '一次通过率偏低，收紧送审前置条件',
      evidence: [`一次通过率 ${pct(c.metrics.rawFirstPassRate)}（${c.metrics.firstPassCount}/${c.metrics.mrCount}）`],
      rootCause: '送审标准停留在口头约定，变更单没有统一的完成定义，终审只能逐单重新对齐预期。',
      action: '把「可送审」写成固定清单（验证命令通过、影响面、回滚方式），挂到工程档案 verification 或台账模板；未满足不建变更单。',
      frictionCost: '建单前多花几分钟自查，减少一次完整终审往返。',
      dedupe: '清单已存在时只补缺失项，不要新建第二份清单。',
    }),
  },
  {
    id: 'verification-gap',
    category: 'project-guard',
    score: 86,
    when: (c) => c.metrics.mrCount >= 1 && reposWithoutVerification(c.run).length > 0,
    build: (c) => {
      const missing = reposWithoutVerification(c.run);
      return {
        title: '补齐工程级验证命令',
        evidence: [`${missing.length}/${Array.isArray(c.run?.repos) ? c.run.repos.length : 0} 个仓未登记验证命令`],
        rootCause: '缺少工程级验证入口，验证只能靠终审人肉判断，标准无法复用，也无法在送审前自动拦截退化。',
        action: '在 projects/<工程>.yaml 的 verification.commands 下，为每个仓写入一条可复现的最小验证命令（构建或测试），并保持命令幂等。',
        frictionCost: '一次性配置成本；之后每次送审自动复用，不再重复沟通验证方式。',
        dedupe: '已有 verification 段时只补缺失仓；不要为同一仓同时保留两条命令。',
      };
    },
  },
  {
    id: 'collision-contract',
    category: 'skill-proposal',
    score: 88,
    when: (c) => c.facts.collisionCount >= 1,
    build: (c) => ({
      title: '并行冲突说明槽位归属校验缺失',
      evidence: [`并行冲突 ${c.facts.collisionCount} 次`, `档位 ${c.tier ?? '未知'}`],
      rootCause: '多会话并行时没有写前归属校验，冲突直到合并阶段才暴露，返工成本被推迟并放大。',
      action: '在 Loop 规范里固化「写前查槽位归属 + 契约文件声明影响面」，L3 强制；把归属校验做成脚本检查而不是口头约定。',
      frictionCost: '每次写前多一次归属查询；换来合并阶段冲突显著下降。',
      dedupe: '若 skill 已有槽位规则，只补充「写前校验」这一条，不重复描述槽位定义。',
    }),
  },
  {
    id: 'repeated-correction',
    category: 'skill-proposal',
    score: 84,
    when: (c) => c.metrics.maxRepeatedCorrection >= 2,
    build: (c) => ({
      title: '把重复纠偏固化为可执行检查',
      evidence: [`同类纠偏最高 ${c.metrics.maxRepeatedCorrection} 次`, `纠偏类型 ${c.metrics.repeatedCorrectionKinds} 类`],
      rootCause: '同一类纠偏重复出现，说明规则只存在于对话里，没有进入可执行检查，换一个会话就会重新犯。',
      action: '把该纠偏写成一条可执行检查（验证命令、台账模板或 hook），并删除对话里的口头约定；同类纠偏超过两次不再靠提醒。',
      frictionCost: '一次性把规则脚本化；之后不再重复人工纠正。',
      dedupe: '先搜 skill 与工程档案里的同类规则，命中则合并进原条目并删除旧描述。',
    }),
  },
  {
    id: 'blocking-timeout',
    category: 'config-tune',
    score: 82,
    when: (c) => c.facts.blockingTimeoutCount >= 1,
    build: (c) => ({
      title: '阻塞超时阈值与真实执行时长不匹配',
      evidence: [`阻塞超时 ${c.facts.blockingTimeoutCount} 次`],
      rootCause: '默认等待阈值按理想时长设定，实际构建或评审更慢，等待被误判成卡死，提醒与重试因此失真。',
      action: '在 me.yaml 的 thresholds 里按实测时长上调一档阻塞阈值，只改原值；同时保留一条「超时先查台账」的处理约定。',
      frictionCost: '改一个阈值；减少误报带来的重复排查。',
      dedupe: '已有阻塞阈值时直接改值，不要新增第二个键。',
    }),
  },
  {
    id: 'review-timeout',
    category: 'config-tune',
    score: 76,
    when: (c) => c.facts.reviewTimeoutCount >= 1,
    build: (c) => ({
      title: '终审超时提醒偏晚或偏早',
      evidence: [`终审超时 ${c.facts.reviewTimeoutCount} 次`],
      rootCause: '终审提醒没有对齐真实评审节奏，提醒太晚导致等待堆积，太早导致无效打扰。',
      action: '按本次实测终审时长调整 me.yaml 的终审超时与提醒窗口，保持一个需求只保留一组阈值。',
      frictionCost: '一次配置调整；减少无效提醒和等待。',
      dedupe: '与阻塞阈值同属 thresholds，合并到同一段配置，不新建配置文件。',
    }),
  },
  {
    id: 'stuck-recovery',
    category: 'config-tune',
    score: 80,
    when: (c) => c.facts.stuckOrDisconnectCount >= 1,
    build: (c) => ({
      title: '补一个稳定的断线续接锚点',
      evidence: [`卡死/断线 ${c.facts.stuckOrDisconnectCount} 次`],
      rootCause: '会话中断后没有固定续接点，恢复依赖人回忆上下文，续接成本随需求跨度增长。',
      action: '主控台账固定记录「最后完成动作 + 下一步口令」；me.yaml 打开心跳提醒，恢复时先读台账再继续。',
      frictionCost: '每步多写一行台账；断线时省掉整段上下文重建。',
      dedupe: '台账已有「下一步」字段时只强化写法，不新增字段。',
    }),
  },
  {
    id: 'guard-config',
    category: 'project-guard',
    score: 74,
    when: (c) => c.facts.guardBlockCount >= 1,
    build: (c) => ({
      title: '复核受保护分支与合并通道',
      evidence: [`守卫拦截 ${c.facts.guardBlockCount} 次`, `受保护规则 ${c.run?.protectedEnvBranches?.length ?? ENV_BRANCHES.length} 条`],
      rootCause: '出现拦截说明有人或代理尝试绕过约定通道，或受保护分支清单与真实环境不一致；两者都会让守卫从安全栓退化成噪音。',
      action: '核对 protectedEnvBranches 与真实环境分支是否一致；确认合并统一走 forge.mjs change-merge，并在工程档案记录人工合并负责人。',
      frictionCost: '一次核对；避免守卫误报或漏报。',
      dedupe: '清单已覆盖 main/master/test/uat 时只增补差异项，不重复罗列默认分支。',
    }),
  },
  {
    id: 'temp-rule-promote',
    category: 'skill-proposal',
    score: 72,
    when: (c) => tempRuleBuckets(c.facts).promote > 0,
    build: (c) => ({
      title: '把已验证的临时规范转正',
      evidence: [`可复用临时规则 ${tempRuleBuckets(c.facts).promote} 条`],
      rootCause: '临时规范已经证明有效且可复用，却只活在本需求里，下个需求会重新发明一遍。',
      action: '把该规则合并进 skill 的 references 或规则表，标注适用档位；同时在本次配置里删除临时条目，避免双份维护。',
      frictionCost: '一次文档合并；之后所有需求复用。',
      dedupe: '先查 skill 是否已有同类规则，命中则合并并删除旧条目。',
    }),
  },
  {
    id: 'temp-rule-project',
    category: 'project-guard',
    score: 68,
    when: (c) => tempRuleBuckets(c.facts).project > 0,
    build: (c) => ({
      title: '把工程专属临时规范下沉到工程档案',
      evidence: [`仅本工程有效的临时规则 ${tempRuleBuckets(c.facts).project} 条`],
      rootCause: '规则只在本次生效，下次同工程的新需求不会继承，等于每次重新约定。',
      action: '把该规则写入 projects/<工程>.yaml 的对应段落（验证、阈值或通知），并从本次临时配置删除。',
      frictionCost: '一次配置迁移；同工程后续需求自动继承。',
      dedupe: '工程档案已有同类段落时合并进原段落，不新增顶层键。',
    }),
  },
  {
    id: 'temp-rule-drop',
    category: 'config-tune',
    score: 64,
    when: (c) => tempRuleBuckets(c.facts).drop > 0,
    build: (c) => ({
      title: '删除未生效的临时规则',
      evidence: [`未生效临时规则 ${tempRuleBuckets(c.facts).drop} 条`],
      rootCause: '无效规则留在配置里会继续参与判定，增加噪音，也让后续复盘误以为它仍被使用。',
      action: '从本次配置删除该规则；若仍想保留意图，改写为一条可验证的检查，否则直接放弃。',
      frictionCost: '删除成本接近零；减少后续误判。',
      dedupe: '删除前确认没有其他规则引用它。',
    }),
  },
  {
    id: 'backlog-split',
    category: 'config-tune',
    score: 58,
    when: (c) => c.facts.durationDays >= 3 || c.facts.mrCount >= 6,
    build: (c) => ({
      title: '打开压单提醒，把变更拆成可独立终审的小批次',
      evidence: [`跨度 ${c.facts.durationDays} 天`, `变更单 ${c.facts.mrCount} 个`],
      rootCause: '单个需求跨度过长、批次过大，等待与返工成本随批次线性增长，终审也无法快速给出确定结论。',
      action: '在 me.yaml 打开压单提醒并按工作时段设置提醒窗口；把变更拆成可独立终审、可独立回滚的小批次。',
      frictionCost: '多几次建单动作；换来更短的反馈回路和更小的回滚面。',
      dedupe: '已有压单提醒配置时只调窗口，不重复开启。',
    }),
  },
  {
    id: 'l3-calibration',
    category: 'skill-proposal',
    score: 50,
    when: (c) => c.tier === 'L3',
    build: (c) => ({
      title: '复核 L3 协作开销是否匹配真实并行度',
      evidence: ['档位 L3', `变更单 ${c.metrics.mrCount} 个`, `并行冲突 ${c.facts.collisionCount} 次`],
      rootCause: 'L3 的台账、契约与巡检成本只在真实多人并行时才划算；并行度不足时，这套结构会变成纯开销。',
      action: '若本次实际单人推进且无并行冲突，下次直接起 L2；若确有并行，保留 L3 并补齐契约与归属声明。',
      frictionCost: '一次档位判断；避免长期为不存在的并行度付费。',
      dedupe: '与升档规则合并表述，不新增第二套档位判断标准。',
    }),
  },
  {
    id: 'forced-review',
    category: 'skill-proposal',
    score: 5,
    when: (c) => c.force,
    build: () => ({
      title: '人工强制复盘：确认是否有可复用机制',
      evidence: ['--force 触发'],
      rootCause: '指标未达门槛但人工判断存在机制问题，说明现有门槛可能漏掉了某类信号。',
      action: '复盘本次 Loop 的执行路径，确认是否出现新的通用缺陷；若是，补一条客观门槛，而不是只修这一次。',
      frictionCost: '一次人工复盘；换来门槛本身的校准。',
      dedupe: '若已有同类门槛，调整阈值而不是新增条件。',
    }),
  },
];

function buildProposals(context) {
  const candidates = [];
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.when(context);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    const built = rule.build(context);
    candidates.push({
      id: rule.id,
      category: rule.category,
      categoryLabel: CATEGORY_LABEL[rule.category],
      score: rule.score,
      ...built,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return candidates.slice(0, MAX_PROPOSALS);
}

/* ------------------------------------------------------------------ */
/* 脱敏与 Issue 草稿                                                      */
/* ------------------------------------------------------------------ */

function fingerprintOf(value) {
  return crypto.createHash('sha256').update(String(value ?? 'unknown')).digest('hex').slice(0, 8);
}

/** 最终兜底：把已知标识与常见绝对路径替换成占位符。 */
function redact(markdown, secrets) {
  let out = String(markdown)
    .replace(/\/(?:Users|home|private|var|opt|root|tmp)\/[^\s`"'）)，,；;]+/g, '<local-path>')
    .replace(/\bou_[0-9a-f]{20,}\b/gi, '<已脱敏>');
  for (const value of secrets) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = value.length <= 6 ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
    out = out.replace(new RegExp(pattern, 'gu'), '<已脱敏>');
  }
  return out;
}

function collectSecrets(run, req) {
  const secrets = new Set();
  const add = (value) => {
    const text = String(value ?? '').trim();
    if (text.length >= 3 && !PUBLIC_TERMS.has(text.toLowerCase())) secrets.add(text);
  };
  add(req);
  add(run?.project);
  add(run?.user);
  add(run?.branch);
  add(run?.baselineBranch);
  for (const repo of Array.isArray(run?.repos) ? run.repos : []) {
    add(repo?.name);
    add(repo?.repo);
    add(repo?.path);
    add(repo?.localPath);
  }
  for (const worktree of Array.isArray(run?.worktrees) ? run.worktrees : []) {
    add(typeof worktree === 'string' ? worktree : worktree?.path);
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function buildIssueDraft({ metrics, proposals, reasons, fingerprint }) {
  const top = proposals[0];
  const title = `【Loop 复盘】${top ? top.title : '机制改进提案'}（${proposals.length} 项）`;
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('> 由 `xxn-lite-loop` 复盘引擎生成，**需用户确认后手动提交**；本稿已脱敏，不含业务路径、仓库名与人员姓名。');
  lines.push('');
  lines.push('## 一、客观指标摘要');
  lines.push('');
  lines.push('| 指标 | 数值 | 口径 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 变更单数 | ${metrics.mrCount} | 本次需求创建并送审的 MR/PR 总数 |`);
  lines.push(`| 一次通过率 | ${metrics.rawFirstPassRate !== null ? pct(metrics.rawFirstPassRate) : '—'} | 一次通过数 / 变更单数 |`);
  lines.push(`| 平均终审轮次 | ${metrics.avgReviewRounds} | 1 + 打回次数 / 变更单数 |`);
  lines.push(`| 稳定性问题 | ${metrics.stabilityIssues} | 阻塞超时 + 会话中断 + 终审超时 |`);
  lines.push(`| 摩擦次数 | ${metrics.frictionCount} | 重复纠偏 + 累计打回 + 并行冲突 |`);
  lines.push(`| 守卫拦截 | ${metrics.guardInterceptions} | 高危写命令被拦截的次数 |`);
  lines.push('');
  lines.push('## 二、触发原因');
  lines.push('');
  for (const reason of reasons) lines.push(`- **${reason.label}**：${reason.detail}`);
  lines.push('');
  lines.push('## 三、第一性原理根因');
  lines.push('');
  for (const proposal of proposals) lines.push(`- **${proposal.title}**：${proposal.rootCause}`);
  lines.push('');
  lines.push('## 四、建议改法');
  lines.push('');
  proposals.forEach((proposal, index) => {
    lines.push(`${index + 1}. \`${proposal.category}\` ${proposal.action}`);
  });
  lines.push('');
  lines.push('## 五、摩擦成本评估');
  lines.push('');
  for (const proposal of proposals) lines.push(`- **${proposal.title}**：${proposal.frictionCost}`);
  lines.push('');
  lines.push('## 六、可合并/删除旧规则自查');
  lines.push('');
  for (const proposal of proposals) lines.push(`- **${proposal.title}**：${proposal.dedupe}`);
  lines.push('');
  lines.push('## 七、脱敏与提交说明');
  lines.push('');
  lines.push(`- 需求指纹：\`${fingerprint}\`（仅用于本地对照，不含需求名）`);
  lines.push('- 草稿只保留计数与通用机制描述；仓库、分支、路径与人员均已泛化。');
  lines.push('- 提交前请人工确认：是否仍然复现、是否已有同类 Issue、是否值得长期维护。');
  lines.push('');
  return { title, markdown: lines.join('\n'), labels: ['loop-retro'], requiresUserConfirmation: true };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                                */
/* ------------------------------------------------------------------ */

export function runRetro(flags = {}, configDirInput) {
  const configDir = path.resolve(expandHome(configDirInput ?? process.env.XXN_LITE_LOOP_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'dev-loop')));
  const { run, runPath, archived, req } = loadRun(flags, configDir);
  const rawFacts = parseInput(flags.input);
  const facts = normalizeFacts(rawFacts);
  const metrics = computeMetrics(facts, run);
  const tier = run?.tier ?? (typeof rawFacts.tier === 'string' ? rawFacts.tier : null);
  const force = flags.force === true || flags.force === 'true' || flags.force === '1';
  const trigger = evaluateTrigger({ facts, metrics, tier, force });

  const feedbackRepo = optFlag(flags, 'feedback-repo') ?? DEFAULT_FEEDBACK_REPO;
  const feedbackRepoIsPlaceholder = optFlag(flags, 'feedback-repo') === null;
  const fingerprint = fingerprintOf(req ?? run?.req ?? runPath);

  if (!trigger.triggered) {
    return {
      ok: true,
      readOnly: true,
      version: VERSION,
      triggered: false,
      reason: NOT_TRIGGERED_REASON,
      metrics: publicMetrics(metrics, facts),
      req: run?.req ?? req ?? null,
      tier,
      runPath,
      archived,
      triggerReasons: [],
      proposals: [],
    };
  }

  const proposals = buildProposals({ facts, metrics, run, tier, force });
  const draft = buildIssueDraft({
    metrics,
    proposals,
    reasons: trigger.reasons,
    fingerprint,
  });
  const secrets = collectSecrets(run, req ?? run?.req);
  const issueDraft = { ...draft, title: redact(draft.title, secrets), markdown: redact(draft.markdown, secrets) };
  const submitCommands = [
    '# 1) 先把返回里的 issueDraft.markdown 存成本地 draft.md，并人工确认脱敏与措辞',
    `node "${FORGE_PATH}" issue-create --forge <gitlab|github> --repo "<submit.target 中的仓库>" --title "${issueDraft.title}" --body "$(cat draft.md)"`,
  ];

  return {
    ok: true,
    readOnly: true,
    version: VERSION,
    triggered: true,
    req: run?.req ?? req ?? null,
    tier,
    runPath,
    archived,
    triggerReasons: trigger.reasons,
    metrics: publicMetrics(metrics, facts),
    proposals,
    issueDraft,
    feedbackRepoIsPlaceholder,
    submit: {
      requiresUserConfirmation: true,
      target: feedbackRepo,
      commands: submitCommands,
      note: '复盘引擎不会自动改配置或发 Issue；确认后由用户手动执行上面的命令。',
    },
    warnings: feedbackRepoIsPlaceholder ? ['未指定 --feedback-repo，使用默认占位仓库，提交前请替换。'] : [],
  };
}

function usage() {
  return {
    ok: true,
    name: `${SKILL_NAME}/retro.mjs`,
    version: VERSION,
    readOnly: true,
    usage: [
      'node scripts/retro.mjs --req <slug> --input <json|@file> [--force] [--feedback-repo <owner/repo>] [--config-dir <dir>]',
      'node scripts/retro.mjs --req <slug> --input \'{"mrCount":6,"firstPassCount":3,"durationDays":4}\'',
    ],
    triggers: [
      'tier === L3', 'mrCount >= 6', 'durationDays >= 3', 'rejectCount >= 2 或已记录熔断',
      'mrCount >= 2 且已知 firstPassRate < 0.6', '同类纠偏 count >= 2',
      'blockingTimeoutCount >= 1', 'stuckOrDisconnectCount >= 1', 'collisionCount >= 1', 'tempRules.length >= 1',
    ],
    categories: ['config-tune', 'project-guard', 'skill-proposal'],
  };
}

function main(argv) {
  const { flags } = parseArgs(argv);
  if (flags.help) return usage();
  return runRetro(flags, resolveConfigDir(flags));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const payload = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 0;
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? 'UNEXPECTED_ERROR', message: err.message, ...(err.extra ?? {}) }, null, 2)}\n`);
    process.exitCode = 2;
  }
}