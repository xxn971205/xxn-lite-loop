#!/usr/bin/env node
/**
 * loopctl.mjs — xxn-lite-loop 配置引擎、状态判定、平滑升档与收尾拆架 CLI。
 *
 * 零依赖 Node.js ESM（Node 20+）。长期配置与运行态落在 --config-dir（默认 ~/.config/dev-loop）。
 *
 * 子命令：
 *   config-resolve  四级配置合并（tiers.md 默认 < me < projects/<slug> < overrides）
 *   preview-init    6 行确认单 + 应建台账/定时任务/标签清单（与 init 共用 buildRunSpec）
 *   init            写入 runs/<req>.json（已存在默认拒绝，--resume 读回）
 *   upgrade         L1→L2→L3 逐级升档：默认出计划，--apply 逐项回执后落盘
 *   slot-claim      L3 抢槽：按槽位过滤「最早未撤回绑定」胜出
 *   brief           生成角色任务头，先 fetch 更新对应的 origin/* 基线引用
 *   teardown        两步拆架：默认出清单保留 run，--finalize 逐项核验后归档
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { FULL_SHA, readReviews, reviewJournalPath, reviewsFor } from './lib/review-journal.mjs';
import { hasRejectFuse, isWaitingMerge, resolveReviewState } from './lib/review-state.mjs';
import { configPath, demandLabel, forgeHostArgs, primaryLedgerKey, latestAcceptance, acceptanceEnabled, boundLedger, issueNumber, matchingDeveloperModel, normModel, sameModel, expandHome, runFile, safeSlug, writeAtomic, factFailure, CliError, ENV_BRANCHES, splitPatterns, validateBranchPatterns, protectedMergeBaseline, isRunSidecar, withFileLock, tickLockPath, resolveTrialConfig } from './lib/common.mjs';
import {
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
} from './guard.mjs';
import { collectRunFacts, postTickComment, readForgeIssueOwner, readForgeIssueState, readSlotClaimFacts, readAcceptanceBaseline, parseDepRef, forgeRecordUrl, registeredDemandIssues } from './forge.mjs';
import { patrolAlertStatus, readTickHistory, tick, tickHistoryPath } from './lib/tick.mjs';
import { formatScriptComment } from './lib/action-messages.mjs';
import { describeMergeMode, formatStatus, mergeModeFromMaster } from './lib/status-view.mjs';
import { dispatchSlot, escalationsFor, issueRef } from './lib/tick-dispatch.mjs';
import { activeSlotClaims, forgeSlotClaims, slotKey } from './lib/slot-claims.mjs';
import { runNotification } from './lib/outbox.mjs';
import { verifyGroup } from './lib/lark-im.mjs';

const VERSION = '2.3.0';
const SKILL_NAME = 'xxn-lite-loop';
const DEFAULT_WORK_HOURS = { start: '09:00', end: '19:00', timezone: 'Asia/Shanghai' };
const BASE_LABELS = ['待终审', '终审中', '待合并', '需修改', '阻断', '风险高', '风险低', 'bug'];
const REVIEW_LABELS = ['待终审', '终审中', '待合并'];

/** 唯一阈值表（references/tiers.md 的机器可读副本）。 */
const THRESHOLD_DEFAULTS = {
  controllerLoopMinutes: 30,
  smallPatrolMinutes: 60,
  leadPatrolMinutes: 30,
  stuckHours: 2,
  disconnectCycles: 2,
  confirmTimeoutHours: 4,
  controllerReminderHours: 2,
  correctionTimeoutHours: 2,
  ledgerMaxLines: 80,
  mrIdleWarnHours: 4,
  mrIdleEscalateHours: 8,
  p3PauseMaxHours: 8,
  p3SilentMaxHours: 8,
  reviewStaleHours: 2,
  reviewWaitWarnHours: 24,
  blockEscalateHours: 4,
  rejectFuseCount: 2,
  trialMergeTimeoutMinutes: 15,
  externalMentionWindow: '09:00-19:00',
};

const L2_THRESHOLDS = [
  'controllerLoopMinutes', 'smallPatrolMinutes', 'stuckHours', 'disconnectCycles',
  'confirmTimeoutHours', 'controllerReminderHours', 'correctionTimeoutHours', 'ledgerMaxLines', 'mrIdleWarnHours',
  'reviewStaleHours', 'reviewWaitWarnHours', 'rejectFuseCount', 'trialMergeTimeoutMinutes',
];

const TIER_PROFILES = {
  L1: {
    label: 'L1 · 极轻档（Sprint）',
    ledgerMode: 'single',
    tasks: [],
    labels: ['待终审', '终审中', '待合并', '需修改', '风险高', '风险低'],
    activeThresholds: ['reviewStaleHours', 'rejectFuseCount', 'trialMergeTimeoutMinutes'],
    autoMerge: false,
    contracts: false,
    notifyMode: '仅会话',
    defaultStage: 'P3',
    allowedStages: ['P0', 'P3'],
  },
  L2: {
    label: 'L2 · 标准档（Standard）',
    ledgerMode: 'main',
    tasks: ['controller', 'patrol'],
    labels: BASE_LABELS,
    activeThresholds: L2_THRESHOLDS,
    autoMerge: true,
    contracts: 'brief',
    notifyMode: '可选个人私信',
    defaultStage: 'P2',
    allowedStages: ['P0', 'P1', 'P2', 'P3'],
  },
  L3: {
    label: 'L3 · 团队严格档（Squad）',
    ledgerMode: 'squad',
    tasks: ['controller', 'patrol', 'dispatch', 'lead-patrol'],
    labels: BASE_LABELS,
    activeThresholds: Object.keys(THRESHOLD_DEFAULTS),
    autoMerge: true,
    contracts: 'full',
    notifyMode: '可选飞书/外部群',
    defaultStage: 'P0',
    allowedStages: ['P0', 'P1', 'P2', 'P3'],
  },
};

/** ledger: personal = 本人台账（L2 主台账 / L3 本人小台账），master = L3 总台账；entryDoc = 定时唤醒必读的 Skill 角色入口文件。 */
const TASK_DEFS = {
  controller: { title: '主控', every: 'controllerLoopMinutes', ledger: 'personal', entryDoc: 'references/controller.md' },
  patrol: { title: '静音小巡检', every: 'smallPatrolMinutes', ledger: 'personal', entryDoc: 'references/patrol-and-notify.md' },
  dispatch: { title: '主研发调度', every: 'controllerLoopMinutes', ledger: 'master', entryDoc: 'references/review-and-dispatch.md' },
  'lead-patrol': { title: '全局大巡检', every: 'leadPatrolMinutes', ledger: 'master', entryDoc: 'references/patrol-and-notify.md' },
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

const BOOLEAN_FLAGS = new Set(['force', 'help', 'plan', 'finalize', 'apply', 'resume', 'all', 'confirm-required', 'json', 'manual', 'auto']);

function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    let key = token.slice(2);
    let value = true;
    if (eq > -1) {
      key = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else if (!BOOLEAN_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    flags[key] = value;
  }
  return { flags, positional };
}

function optFlag(flags, key) {
  const v = flags[key];
  return v === undefined || v === true || String(v).trim() === '' ? null : String(v);
}

function requireFlag(flags, key) {
  const v = optFlag(flags, key);
  if (v === null) throw new CliError('MISSING_FLAG', `缺少必填参数 --${key}`);
  return v;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(...sources) {
  const out = {};
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined) continue;
      if (isPlainObject(value)) out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, value);
      else out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|1|yes|y|是)$/i.test(value.trim())) return true;
    if (/^(false|0|no|n|否)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function list(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

/** 定时任务 ID 片段：纯 ASCII 原样保留；含非 ASCII 时附稳定 SHA-256 短后缀，杜绝撞名。 */
function taskSafe(value) {
  const text = String(value ?? '').trim();
  const ascii = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (ascii && ascii === text) return ascii;
  return ascii ? `${ascii}-${shortHash(text)}` : shortHash(text);
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function readJson(file, code = 'JSON_NOT_FOUND') {
  if (!fs.existsSync(file)) throw new CliError(code, `文件不存在：${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError('INVALID_JSON', `${file} 不是合法 JSON：${err.message}`);
  }
}

/** 同目录临时文件保证读取者只会看到完整配置；首次创建用硬链接原子判重。 */
function writeJson(file, payload, options) {
  const stored = payload.autoMerge === true && protectedMergeBaseline(payload) ? { ...payload, autoMerge: false } : payload;
  writeAtomic(file, `${JSON.stringify(stored, null, 2)}\n`, options);
}

function parseJsonArg(value, flagName) {
  if (value === undefined || value === true || value === '') return {};
  const text = String(value).startsWith('@') ? fs.readFileSync(expandHome(String(value).slice(1)), 'utf8') : String(value);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError('INVALID_JSON', `--${flagName} 不是合法 JSON：${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 受限 YAML 子集（映射 / 缩进嵌套 / 序列 / 内联数组与对象），非法即报行号   */
/* ------------------------------------------------------------------ */

function yamlError(line, message) {
  return Object.assign(new Error(message), { line });
}

function scan(text, onChar) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{') depth += 1;
    if (c === ']' || c === '}') depth -= 1;
    if (onChar(c, i, depth) === false) return { quote, depth, stopped: i };
  }
  return { quote, depth, stopped: -1 };
}

function stripComment(line) {
  const res = scan(line, (c, i) => !(c === '#' && (i === 0 || /\s/.test(line[i - 1]))));
  return res.stopped >= 0 ? line.slice(0, res.stopped) : line;
}

function splitKey(text) {
  const res = scan(text, (c, i, depth) => !(depth === 0 && c === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]))));
  return res.stopped >= 0 ? [text.slice(0, res.stopped).trim(), text.slice(res.stopped + 1).trim()] : null;
}

function splitInline(text, line) {
  const parts = [];
  let start = 0;
  const res = scan(text, (c, i, depth) => {
    if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  });
  if (res.quote || res.depth !== 0) throw yamlError(line, `内联值括号或引号不闭合：${text}`);
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}

function unquote(text, line) {
  const v = text.trim();
  if (v[0] === '"') {
    if (v.length < 2 || v.at(-1) !== '"') throw yamlError(line, `引号不闭合：${v}`);
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v[0] === "'") {
    if (v.length < 2 || v.at(-1) !== "'") throw yamlError(line, `引号不闭合：${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function parseScalar(raw, line) {
  const v = String(raw).trim();
  if (v === '') return '';
  if (v[0] === '"' || v[0] === "'") return unquote(v, line);
  if (/^(null|~)$/i.test(v)) return null;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v[0] === '[') {
    if (v.at(-1) !== ']') throw yamlError(line, `内联数组不闭合：${v}`);
    return splitInline(v.slice(1, -1), line).map((p) => parseScalar(p, line));
  }
  if (v[0] === '{') {
    if (v.at(-1) !== '}') throw yamlError(line, `内联对象不闭合：${v}`);
    const obj = {};
    for (const part of splitInline(v.slice(1, -1), line)) {
      const kv = splitKey(part);
      if (!kv) throw yamlError(line, `内联对象项缺少「键: 值」：${part}`);
      obj[unquote(kv[0], line)] = parseScalar(kv[1], line);
    }
    return obj;
  }
  return v;
}

function parseYaml(src) {
  const lines = [];
  String(src).replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
    const text = stripComment(raw);
    if (!text.trim()) return;
    const lead = text.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) throw yamlError(idx + 1, '缩进不能使用 Tab');
    lines.push({ no: idx + 1, indent: lead.length, text: text.trim() });
  });
  let i = 0;
  const isSeq = (t) => t === '-' || t.startsWith('- ');

  function child(parentIndent) {
    return i < lines.length && lines[i].indent > parentIndent ? parseNode(lines[i].indent) : null;
  }

  function noDeeper(indent) {
    if (i < lines.length && lines[i].indent > indent) throw yamlError(lines[i].no, '缩进异常：标量值后不能再嵌套子项');
  }

  function parseNode(indent) {
    return isSeq(lines[i].text) ? parseSeq(indent) : parseMap(indent);
  }

  function assign(obj, kv, indent, line) {
    const key = unquote(kv[0], line);
    if (!key) throw yamlError(line, '键名不能为空');
    if (Object.hasOwn(obj, key)) throw yamlError(line, `重复键：${key}`);
    if (kv[1] === '') {
      obj[key] = child(indent);
    } else {
      obj[key] = parseScalar(kv[1], line);
      noDeeper(indent);
    }
  }

  function parseMap(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isSeq(lines[i].text)) {
      const { no, text } = lines[i];
      const kv = splitKey(text);
      if (!kv) throw yamlError(no, `无法解析的映射行（需「键: 值」）：${text}`);
      i += 1;
      assign(obj, kv, indent, no);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isSeq(lines[i].text)) {
      const { no, text } = lines[i];
      const rest = text.slice(1).trimStart();
      i += 1;
      const kv = rest ? splitKey(rest) : null;
      if (!rest) {
        arr.push(child(indent));
      } else if (!kv || rest[0] === '{' || rest[0] === '[') {
        arr.push(parseScalar(rest, no));
        noDeeper(indent);
      } else {
        const keyIndent = indent + (text.length - rest.length);
        const item = {};
        assign(item, kv, keyIndent, no);
        if (i < lines.length && lines[i].indent === keyIndent && !isSeq(lines[i].text)) Object.assign(item, parseMap(keyIndent));
        arr.push(item);
      }
    }
    return arr;
  }

  if (lines.length === 0) return {};
  const result = parseNode(lines[0].indent);
  if (i < lines.length) throw yamlError(lines[i].no, `缩进与上文不一致或多余行：${lines[i].text}`);
  return result;
}

function loadConfigFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = file.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    const where = err.line ? ` 第 ${err.line} 行` : '';
    throw new CliError('INVALID_CONFIG', `${file}${where} 解析失败：${err.message}`, { file, line: err.line ?? null });
  }
  if (!isPlainObject(parsed)) throw new CliError('INVALID_CONFIG', `${file} 顶层必须是映射对象`, { file });
  return parsed;
}

function findConfigFile(baseDir, slug) {
  for (const ext of ['.yaml', '.yml', '.json']) {
    const candidate = path.join(baseDir, `${slug}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function yamlFlow(value) {
  if (Array.isArray(value)) return `[${value.map(yamlFlow).join(', ')}]`;
  if (isPlainObject(value)) return `{${Object.entries(value).map(([key, val]) => `${JSON.stringify(key)}: ${yamlFlow(val)}`).join(', ')}}`;
  return JSON.stringify(value);
}

function projectNotifyText(file, desired) {
  if (file.toLowerCase().endsWith('.json')) return `${JSON.stringify(desired, null, 2)}\n`;
  const original = fs.readFileSync(file, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const fields = lines.flatMap((line, index) => {
    const body = stripComment(line);
    return body.trim() ? [{ index, indent: body.match(/^ */)[0].length, key: splitKey(body.trim())?.[0] }] : [];
  });
  const indent = fields[0]?.indent ?? 0;
  const at = fields.findIndex((field) => field.indent === indent && field.key && unquote(field.key, field.index + 1) === 'notify');
  const block = [
    `${' '.repeat(indent)}notify:`,
    ...Object.entries(desired.notify).map(([key, value]) => `${' '.repeat(indent + 2)}${JSON.stringify(key)}: ${yamlFlow(value)}`),
  ];
  if (at < 0) {
    if (lines.at(-1) === '') lines.pop();
    lines.push(...block, '');
  } else {
    const last = fields.slice(at + 1).findIndex((field) => field.indent === indent);
    const tail = last < 0 ? fields.at(-1).index : fields[at + last].index;
    lines.splice(fields[at].index, tail - fields[at].index + 1, ...block);
  }
  const next = lines.join(newline);
  if (!isDeepStrictEqual(parseYaml(next), desired)) throw new CliError('INVALID_NOTIFY_CONFIG', '更新群配置后工程档案无法按原结构读回');
  return next;
}

const zoneFormatters = new Map();

function validateTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new CliError('INVALID_TIMEZONE', `非法时区：${tz}`);
  }
  return tz;
}

function zoned(ms, tz) {
  let fmt = zoneFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormatters.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

function localMinutes(ms, tz) {
  const z = zoned(ms, tz);
  return z.h * 60 + z.mi + z.s / 60 + (ms % 1000) / 60000;
}

function formatLocal(ms, tz) {
  const z = zoned(ms, tz);
  const p = (n) => String(n).padStart(2, '0');
  const offset = Math.round((Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi, z.s) - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${z.y}-${p(z.mo)}-${p(z.d)}T${p(z.h)}:${p(z.mi)}:${p(z.s)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function parseInstant(value, field) {
  const text = String(value ?? '').trim();
  const ms = Date.parse(text);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text) || !Number.isFinite(ms)) {
    throw new CliError('INVALID_TIME', `${field} 必须是带时区的 ISO 时间（如 2024-05-01T23:30:00+08:00），收到：${text}`);
  }
  return ms;
}

function hm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new CliError('INVALID_CONFIG', `时间必须是 HH:MM，收到：${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 'HH:MM-HH:MM' 或 {start,end,timezone} → {start,end[,timezone]}。 */
function parseWindow(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(value);
    if (!m) throw new CliError('INVALID_CONFIG', `时间窗必须是 HH:MM-HH:MM，收到：${value}`);
    return { start: m[1], end: m[2] };
  }
  if (!isPlainObject(value)) throw new CliError('INVALID_CONFIG', `时间窗格式非法：${JSON.stringify(value)}`);
  const out = {};
  for (const key of ['start', 'end']) if (value[key] !== undefined) out[key] = String(value[key]);
  if (value.timezone) out.timezone = String(value.timezone);
  return out;
}

function insideWindow(minutes, win) {
  const s = hm(win.start);
  const e = hm(win.end);
  if (s === e) return true;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

function minutesToBoundary(minutes, win) {
  const s = hm(win.start);
  const e = hm(win.end);
  if (s === e) return Infinity;
  const until = (b) => {
    const d = (((b - minutes) % 1440) + 1440) % 1440;
    return d === 0 ? 1440 : d;
  };
  return Math.min(until(s), until(e));
}

/** 只累计落在工作窗内的时长（小时），支持跨午夜窗口。 */
function workHoursBetween(fromMs, toMs, win) {
  let t = fromMs;
  let total = 0;
  for (let guard = 0; t < toMs && guard < 20000; guard += 1) {
    const minutes = localMinutes(t, win.timezone);
    const step = Math.max(1, Math.min(Math.round(minutesToBoundary(minutes, win) * 60000), toMs - t));
    if (insideWindow(minutes, win)) total += step;
    t += step;
  }
  return total / 3600000;
}

function addWorkingHours(nowMs, hours, win) {
  let cursor = nowMs;
  let remaining = hours * 3_600_000;
  for (let windowCount = 0; remaining > 0 && windowCount < 20_000; windowCount += 1) {
    const minutes = localMinutes(cursor, win.timezone);
    const boundary = Math.max(1, Math.round(minutesToBoundary(minutes, win) * 60_000));
    if (insideWindow(minutes, win)) {
      const step = Math.min(remaining, boundary);
      cursor += step;
      remaining -= step;
    } else {
      cursor += boundary;
    }
  }
  if (remaining > 0) throw new CliError('INVALID_CONFIG', '工作时段无法累计通知有效期');
  return cursor;
}

function windowAt(nowMs, win) {
  const minutes = localMinutes(nowMs, win.timezone);
  const inside = insideWindow(minutes, win);
  const toStart = (((hm(win.start) - minutes) % 1440) + 1440) % 1440;
  return {
    now: formatLocal(nowMs, win.timezone),
    start: win.start,
    end: win.end,
    timezone: win.timezone,
    inside,
    deferredUntil: inside ? null : formatLocal(Math.round((nowMs + toStart * 60000) / 60000) * 60000, win.timezone),
  };
}

function workWindow(input, fallback = DEFAULT_WORK_HOURS) {
  const win = { ...DEFAULT_WORK_HOURS, ...parseWindow(fallback), ...parseWindow(input.workHours) };
  if (input.timezone) win.timezone = String(input.timezone);
  validateTimezone(win.timezone);
  return win;
}

function mentionWindow(input, win = workWindow(input)) {
  const mentionWin = { timezone: win.timezone, ...parseWindow(THRESHOLD_DEFAULTS.externalMentionWindow),
    ...parseWindow(input.thresholds?.externalMentionWindow ?? input.notify?.externalMentionWindow), ...parseWindow(input.mentionWindow) };
  if (input.timezone) mentionWin.timezone = String(input.timezone);
  validateTimezone(mentionWin.timezone);
  return mentionWin;
}

/* ------------------------------------------------------------------ */
/* 配置解析                                                              */
/* ------------------------------------------------------------------ */

function normalizeTier(value) {
  const tier = String(value ?? '').trim().toUpperCase();
  if (!TIER_PROFILES[tier]) throw new CliError('INVALID_TIER', `档位必须是 L1/L2/L3，收到：${value}`);
  return tier;
}

function tierRank(tier) {
  return Number(normalizeTier(tier).slice(1));
}

function normalizeForge(value) {
  const forge = String(value).trim().toLowerCase();
  if (!['gitlab', 'github'].includes(forge)) throw new CliError('INVALID_FORGE', `forge 必须是 gitlab 或 github，收到：${value}`);
  return forge;
}

/** 把层内顶层 timezone 折进 workHours，使每一层都能单独覆盖时区。 */
function foldLayer(layer) {
  const out = { ...layer };
  if (layer.workHours !== undefined || layer.timezone !== undefined) {
    const win = parseWindow(layer.workHours);
    if (!win.timezone && layer.timezone) win.timezone = String(layer.timezone);
    out.workHours = win;
  }
  const mentionWindow = layer.notify?.externalMentionWindow ?? layer.thresholds?.externalMentionWindow;
  if (mentionWindow !== undefined) {
    out.thresholds = { ...layer.thresholds, externalMentionWindow: parseWindow(mentionWindow) };
  }
  delete out.timezone;
  return out;
}

function normalizeRepo(entry, fallbackName) {
  if (!entry) return null;
  if (typeof entry === 'string') return { name: entry.split('/').filter(Boolean).pop() || fallbackName, repo: entry, path: null, branch: null };
  if (!isPlainObject(entry)) return null;
  const repo = entry.repo ?? entry.id ?? entry.slug ?? entry.name ?? null;
  return {
    ...entry,
    name: entry.name ?? (repo ? String(repo).split('/').filter(Boolean).pop() : fallbackName),
    repo,
    path: entry.path ?? entry.localPath ?? null,
    branch: entry.branch ?? entry.defaultBranch ?? null,
  };
}

function normalizeSlots(value) {
  const slots = [...new Set(list(value).map((s) => s.replace(/^槽位/, '')))];
  if (!slots.includes('主研发')) slots.unshift('主研发');
  return slots;
}

function resolveGitBaselineStartSha(repoPath, baselineBranch, trunkBranch) {
  if (!repoPath || !fs.existsSync(repoPath)) return null;
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath, encoding: 'utf8', timeout: 15000 });
  if (inside.status !== 0 || (inside.stdout ?? '').trim() !== 'true') return null;
  // 绝不回退到任意当前 HEAD（若 init 时检出在别的老开发分支上会误拦正常开发）；仅查已存在的需求基线或已登记主干
  const refs = [
    baselineBranch ? `refs/remotes/origin/${baselineBranch}` : null,
    baselineBranch ? `refs/heads/${baselineBranch}` : null,
    trunkBranch ? `refs/remotes/origin/${trunkBranch}` : null,
    trunkBranch ? `refs/heads/${trunkBranch}` : null,
  ].filter(Boolean);
  for (const ref of refs) {
    const r = spawnSync('git', ['rev-parse', '--verify', ref], { cwd: repoPath, encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && /^[0-9a-f]{40}$/i.test((r.stdout ?? '').trim())) return r.stdout.trim();
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 三层协作规矩（rules）：清洗、轻护栏提醒与 L3 公共门禁安全阀                 */
/* ------------------------------------------------------------------ */

const RULES_MAX_PER_LAYER = 5;
const RULES_MAX_LENGTH = 80;
const RULES_MAX_TOTAL = 10;

/** 明显属于编码/格式规范的词：命中只提醒挪到仓库 AGENTS.md，不阻断、不改写。 */
const RULE_STYLE_HINTS = [
  /驼峰/, /下划线命名|命名用下划线|下划线分隔/, /缩进/, /分号/,
  /注释语言|注释风格|注释规范/, /eslint/i, /checkstyle/i, /stylelint/i, /prettier/i, /golangci-lint/i,
  /单测覆盖率|单元测试覆盖率|测试覆盖率/, /代码风格|代码规范|编码规范|代码格式/,
];

/** 单层清洗：允许误传单条字符串；trim + 去空串 + 去重；空或未填零警告。 */
function cleanRuleLayer(value, label, warnings) {
  if (value === undefined || value === null) return [];
  let items;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    warnings.push(`${RULES_WARNING_PREFIX}「${label}」里的 rules 写成了单条字符串，已按一条规矩处理；建议改成列表 rules: ["……"]。`);
    items = [text];
  } else if (Array.isArray(value)) {
    items = value;
  } else {
    throw new CliError('INVALID_RULES', `「${label}」的 rules 必须是字符串数组（一条大白话规矩一项），收到：${typeof value}`);
  }
  const out = [];
  items.forEach((item, index) => {
    if (item === null || item === undefined) return;
    if (typeof item !== 'string') {
      throw new CliError('INVALID_RULES', `「${label}」的 rules 第 ${index + 1} 项不是字符串，收到：${typeof item}`);
    }
    const text = item.trim();
    if (text && !out.includes(text)) out.push(text);
  });
  return out;
}

/**
 * 三条轻护栏，只给 warnings 绝不静默截断：
 *   (a) 每层 ≤5 条、单条 ≤80 字、三层合计 ≤10 条；
 *   (b) 命中编码/格式规范词时提醒挪到仓库 AGENTS.md；
 *   (c) L3 个人规矩不得绕过公共门禁：命中的记入 blocked 并移出生效规则。
 */
function reviewRules({ personal, project, temp, tier, warnings }) {
  for (const [label, rules] of [['me.yaml', personal], ['工程组档案', project], ['本次覆盖', temp]]) {
    if (rules.length > RULES_MAX_PER_LAYER) {
      warnings.push(`${RULES_WARNING_PREFIX}「${label}」配了 ${rules.length} 条，超过每层 ${RULES_MAX_PER_LAYER} 条上限；请精简或合并（一条都没截断）。`);
    }
    rules.forEach((rule, index) => {
      if (rule.length > RULES_MAX_LENGTH) {
        warnings.push(`${RULES_WARNING_PREFIX}「${label}」第 ${index + 1} 条有 ${rule.length} 字，超过单条 ${RULES_MAX_LENGTH} 字建议；请压缩成一句话（一条都没截断）。`);
      }
      if (RULE_STYLE_HINTS.some((pattern) => pattern.test(rule))) {
        warnings.push(`${RULES_WARNING_PREFIX}「${label}」第 ${index + 1} 条「${rule}」像编码/格式规范；编码规范建议放到仓库 AGENTS.md，Loop rules 只收协作与风控规矩。`);
      }
    });
  }

  const blocked = [];
  const personalEffective = [];
  for (const rule of personal) {
    if (tier !== 'L3') {
      personalEffective.push(rule);
      continue;
    }
    const probe = checkPersonalPolicyOverride(rule);
    if (probe.ok === false && probe.violations.length > 0) {
      const codes = probe.violations.map((item) => item.code).join(',');
      blocked.push({ layer: 'personal', rule, code: probe.violations[0].code, message: probe.violations[0].message });
      warnings.push(`${RULES_WARNING_PREFIX}L3 个人规矩「${rule}」试图绕过公共门禁（${codes}）：已拦下不生效，请改成加严或撤销。`);
      continue;
    }
    personalEffective.push(rule);
  }

  const effective = [...personalEffective, ...project, ...temp];
  if (effective.length > RULES_MAX_TOTAL) {
    warnings.push(`${RULES_WARNING_PREFIX}三层合计生效 ${effective.length} 条，超过 ${RULES_MAX_TOTAL} 条上限；请瘦身到 ${RULES_MAX_TOTAL} 条以内（一条都没截断）。`);
  }
  return { personal, project, temp, effective, blocked };
}

/** 三层各自取 rules：个人（me.yaml）→ 工程（projects/<slug>）→ 临时（overrides）。 */
function collectRules({ me, proj, over, tier, warnings }) {
  return reviewRules({
    personal: cleanRuleLayer(me?.rules, 'me.yaml', warnings),
    project: cleanRuleLayer(proj?.rules, '工程组档案', warnings),
    temp: cleanRuleLayer(over?.rules, '本次覆盖', warnings),
    tier,
    warnings,
  });
}

function resolveConfig({ configDir, project, tier, overrides }) {
  const meFile = findConfigFile(configDir, 'me');
  const projectFile = project ? findConfigFile(path.join(configDir, 'projects'), project) : null;
  const layers = [meFile ? loadConfigFile(meFile) : {}, projectFile ? loadConfigFile(projectFile) : {}, overrides ?? {}].map(foldLayer);
  const [me, proj, over] = layers;
  const chosen = normalizeTier(tier || over.tier || proj.defaultTier || proj.tier || me.defaultTier || me.tier || 'L2');
  const profile = TIER_PROFILES[chosen];
  const m = deepMerge({ workHours: DEFAULT_WORK_HOURS, thresholds: THRESHOLD_DEFAULTS }, ...layers);

  const workHours = { ...DEFAULT_WORK_HOURS, ...m.workHours };
  hm(workHours.start);
  hm(workHours.end);
  validateTimezone(workHours.timezone);
  const thresholds = { ...THRESHOLD_DEFAULTS, ...m.thresholds };
  thresholds.externalMentionWindow = { ...parseWindow(THRESHOLD_DEFAULTS.externalMentionWindow), ...parseWindow(thresholds.externalMentionWindow) };
  hm(thresholds.externalMentionWindow.start);
  hm(thresholds.externalMentionWindow.end);

  const commands = isPlainObject(m.verification?.commands) ? m.verification.commands : {};
  const { mode, skipReason } = resolveTrialConfig(m.verification);
  const verification = {
    ...(isPlainObject(m.verification) ? m.verification : {}),
    mode,
    commands,
    skipReason,
  };
  const linked = Array.isArray(m.linkedRepos) ? m.linkedRepos : [];
  const repos = [normalizeRepo(m.hubRepo, 'hub'), ...linked.map((r, idx) => normalizeRepo(r, `repo-${idx + 1}`))]
    .filter(Boolean)
    .map((r, idx) => ({
      ...r,
      branch: r.branch ?? 'main',
      role: idx === 0 ? 'hub' : 'linked',
      verificationCommand: resolveTrialConfig(verification, r).command,
    }));
  const notify = {
    ...(m.notify ?? {}),
    dailyReportEnabled: bool(m.notify?.dailyReportEnabled, false),
    dailyReportTime: String(m.notify?.dailyReportTime ?? '10:00'),
    externalNotifyDisabled: bool(m.notify?.externalNotifyDisabled, false),
    ...(isPlainObject(m.notify?.externalContacts) ? { externalContacts: m.notify.externalContacts } : {}),
  };
  const groupLayer = layers.findLastIndex((layer) => Object.hasOwn(layer.notify ?? {}, 'feishuGroupChatId'));
  if (groupLayer >= 0 && Object.hasOwn(layers[groupLayer].notify, 'memberOpenIds')) {
    notify.memberOpenIds = Object.fromEntries(layers.slice(groupLayer).flatMap((layer) => Object.entries(layer.notify?.memberOpenIds ?? {})));
  }
  hm(notify.dailyReportTime);
  const warnings = [];
  if (project && !projectFile) warnings.push(`工程组档案不存在：projects/${project}.yaml|yml|json（按首次工程处理）`);
  const rules = collectRules({ me, proj, over, tier: chosen, warnings });
  const rawAcceptance = isPlainObject(m.acceptance) ? m.acceptance : {};
  const acceptance = {
    enabled: chosen !== 'L1' && bool(rawAcceptance.enabled, false),
    guide: rawAcceptance.guide == null || String(rawAcceptance.guide).trim() === '' ? null : String(rawAcceptance.guide).trim(),
  };

  return {
    configDir,
    project: project ?? null,
    projectFile,
    meFile,
    tier: chosen,
    tierLabel: profile.label,
    forge: m.forge ? normalizeForge(m.forge) : null,
    hostname: m.hostname ?? null,
    gitlabHost: m.gitlabHost ?? m.hostname ?? null,
    hubRepo: repos[0] ?? null,
    linkedRepos: repos.slice(1),
    repos,
    slots: normalizeSlots(m.slots),
    branchTemplate: m.branchTemplate ? String(m.branchTemplate) : null,
    baselineBranch: m.baselineBranch == null ? null : String(m.baselineBranch),
    protectedEnvBranches: validateBranchPatterns([...new Set([...ENV_BRANCHES, ...splitPatterns(m.protectedEnvBranches)])]),
    defaultTier: proj.defaultTier || me.defaultTier || chosen,
    stage: m.stage || profile.defaultStage,
    allowedStages: profile.allowedStages,
    verification,
    acceptance,
    workHours,
    roleModels: m.roleModels ?? {},
    selfReview: bool(m.selfReview, true),
    notify,
    notifyMode: profile.notifyMode,
    thresholds,
    activeThresholds: profile.activeThresholds,
    scheduledTaskRoles: profile.tasks,
    ledgerMode: profile.ledgerMode,
    autoMerge: bool(m.autoMerge, profile.autoMerge),
    autoMergeConfigured: layers.some((l) => l.autoMerge !== undefined),
    contracts: profile.contracts,
    user: String(m.user ?? m.name ?? 'me'),
    rules,
    warnings,
  };
}

function validateStage(cfg, stage) {
  const chosen = stage ? String(stage).toUpperCase() : cfg.stage;
  if (!cfg.allowedStages.includes(chosen)) {
    throw new CliError('INVALID_STAGE', `${cfg.tier} 起跳阶段只能是 ${cfg.allowedStages.join('/')}，收到：${chosen}`);
  }
  return chosen;
}

/** 勾选仓只能来自已登记仓库；保持登记顺序与角色，核心仓身份永不漂移。 */
function selectRepos(repos, spec) {
  const tokens = list(spec === true ? '' : spec);
  if (tokens.length === 0) return repos;
  const picked = new Set(tokens.map((token) => {
    const hit = repos.find((r) => [r.name, r.repo, r.path].filter(Boolean).some((v) => String(v) === token || path.basename(String(v)) === token));
    if (!hit) throw new CliError('UNKNOWN_REPO', `--repos 含未登记的仓库：${token}`, { known: repos.map((r) => r.repo) });
    return hit;
  }));
  return repos.filter((r) => picked.has(r));
}

function normalizeIssueMap(raw) {
  const out = {};
  for (const [key, value] of Object.entries(isPlainObject(raw) ? raw : {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = { id: String(value), url: null };
    else if (isPlainObject(value) && value.id !== undefined && value.id !== null) out[key] = { id: String(value.id), url: value.url ?? null };
  }
  return out;
}

function missingVerificationRepos(spec) {
  return spec.repos.filter((repo) => {
    const { mode, command, skipReason } = resolveTrialConfig(spec.verification, repo);
    return mode === 'local-test' && !command && !skipReason;
  });
}

/** preview-init 与 init 共用：确认单展示的对象即落盘执行的对象。 */
function buildRunSpec(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const project = requireFlag(flags, 'project');
  const cfg = resolveConfig({ configDir, project, tier: optFlag(flags, 'tier'), overrides: parseJsonArg(flags.overrides, 'overrides') });
  const explicitBranch = optFlag(flags, 'branch');
  const templatedBranch = cfg.branchTemplate ? cfg.branchTemplate.replaceAll('{slug}', req) : null;
  const branch = explicitBranch ?? templatedBranch ?? cfg.baselineBranch ?? `loop/${safeSlug(req)}`;
  const slots = cfg.tier === 'L3' ? normalizeSlots(optFlag(flags, 'slots') ?? cfg.slots) : ['主研发'];
  const slot = flags.slot === undefined ? '主研发' : slotKey(requireFlag(flags, 'slot'));
  if (flags.slot !== undefined && (cfg.tier !== 'L3' || !slots.includes(slot))) {
    throw new CliError('INVALID_SLOT', '--slot 必须是本次 L3 已登记槽位', { slots });
  }
  const spec = {
    req,
    project,
    tier: cfg.tier,
    stage: validateStage(cfg, optFlag(flags, 'stage')),
    forge: cfg.forge,
    gitlabHost: cfg.gitlabHost,
    hostname: cfg.hostname,
    branch,
    baselineBranch: branch,
    protectedEnvBranches: cfg.protectedEnvBranches,
    autoMerge: cfg.autoMerge,
    autoMergeConfigured: cfg.autoMergeConfigured,
    hubRepo: cfg.hubRepo,
    repos: selectRepos(cfg.repos, flags.repos),
    slots,
    ...(cfg.tier === 'L3' ? { slot } : {}),
    user: cfg.user,
    verification: cfg.verification,
    acceptance: cfg.acceptance,
    thresholds: cfg.thresholds,
    workHours: cfg.workHours,
    notify: cfg.notify,
    roleModels: cfg.roleModels,
    selfReview: cfg.selfReview,
    contracts: cfg.contracts,
    rules: cfg.rules,
    issues: normalizeIssueMap(parseJsonArg(flags['issue-map'], 'issue-map')),
  };
  const warnings = [...cfg.warnings];
  if (!spec.forge) warnings.push('工程档案未配置 forge：init 将拒绝执行');
  const unverified = missingVerificationRepos(spec);
  if (unverified.length) {
    warnings.push(`未配置合并前试合命令的仓库：${unverified.map((r) => r.name ?? r.repo).join('、')}（需补 verification.commands 或写明 verification.skipReason，否则 init 将拒绝执行）`);
  }
  if (protectedMergeBaseline(spec)) {
    spec.autoMerge = false;
    warnings.push(`基线 ${branch} 是受保护分支，全部人工合并`);
  } else if (spec.autoMerge && spec.tier === 'L1' && spec.forge) {
    try {
      assertL1AutoMerge(spec);
    } catch (error) {
      spec.autoMerge = false;
      warnings.push(error.message);
    }
  }
  return { spec, cfg, warnings };
}

/* ------------------------------------------------------------------ */
/* 台账、标签、定时任务与确认单                                            */
/* ------------------------------------------------------------------ */

function labelsFor(tier, slots, req) {
  const labels = [...TIER_PROFILES[tier].labels, demandLabel(req)];
  return tier === 'L3' ? [...labels, ...normalizeSlots(slots).map((s) => `槽位${s}`)] : labels;
}

function labelsSyncArgs(run) {
  const repos = [...new Set([...(run.repos ?? []).map((r) => r.repo), run.hubRepo?.repo].filter(Boolean))];
  const args = ['labels-sync', '--forge', String(run.forge), '--repos', repos.join(','), '--req', run.req,
    '--labels', labelsFor(run.tier, run.slots, run.req).join(',')];
  return [...args, ...forgeHostArgs(run)];
}

/** L3 只建总台账 + 主研发本人小台账 + 升级 Issue；协作者加入时自建本人小台账。 */
function ledgerDescriptors({ tier, req, user, slot = '主研发' }) {
  if (tier === 'L1') return [{ key: 'tracking', kind: 'tracking', title: `【Loop】${req}` }];
  if (tier === 'L2') return [{ key: 'main', kind: 'main', title: `【台账】${req}` }];
  const personal = { key: `slot:${slot}`, kind: 'slot', slot, title: `【小台账】${slot}-${user}` };
  if (slot !== '主研发') return [personal];
  return [
    { key: 'master', kind: 'master', title: `【总台账】${req}` },
    personal,
    { key: 'escalation', kind: 'escalation', title: `【升级】${req}` },
  ];
}

function personalLedgerKey(tier, slot = '主研发') {
  return { L1: 'tracking', L2: 'main', L3: `slot:${slot}` }[tier];
}

function shellArg(value) {
  return /^[\w./-]+$/.test(value) ? value : "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function scheduledTasksFor(run, configDir) {
  const command = ['node', shellArg(fileURLToPath(import.meta.url))];
  const scope = ['--req', shellArg(run.req), '--config-dir', shellArg(configDir)];
  const slot = dispatchSlot(run);
  const roles = run.tier === 'L3' && slot !== '主研发' ? ['controller', 'patrol'] : TIER_PROFILES[run.tier].tasks;
  return roles.map((role) => {
    const def = TASK_DEFS[role];
    const ledgerKey = def.ledger === 'master' ? 'master' : personalLedgerKey(run.tier, slot);
    const bound = run.issues?.[ledgerKey];
    const ledgerRef = bound?.id ?? bound ?? '待建';
    const id = `liteloop-${taskSafe(run.req)}-${taskSafe(run.user)}-${role}`;
    const session = role === 'controller' ? ['--session', shellArg(run.controller?.sessionId ?? '<会话标识>')] : [];
    const wake = [...command, 'tick', '--req', shellArg(run.req), '--role', role, '--apply', '--config-dir', shellArg(configDir), ...session].join(' ');
    const answersUser = role === 'patrol' || role === 'lead-patrol' || (role === 'controller' && run.tier === 'L1');
    const answer = answersUser ? ` 回答进度前运行 \`${[...command, 'status', ...scope, '--live', '--json'].join(' ')}\`。` : '';
    return {
      id,
      name: id,
      role,
      title: def.title,
      enabled: true,
      schedule: 'interval',
      everyMinutes: num(run.thresholds?.[def.every], THRESHOLD_DEFAULTS[def.every]),
      ledgerKey,
      ledgerRef,
      skill: SKILL_NAME,
      entryDoc: def.entryDoc,
      description: `先跑 \`${wake}\`，无输出即结束本轮。使用 $${SKILL_NAME}（必读 ${def.entryDoc}）；${def.title}入口：需求=${run.req}；仓库=${run.hubRepo?.repo ?? 'unknown'}；台账=${ledgerRef}；阶段、当前任务与版本以台账为准，个人配置以本机与台账配置为准。${answer}`,
    };
  });
}

function changeRef(c) {
  return c.url ?? `${c.repo ?? ''}!${c.id ?? ''}`;
}

function changeRows(changes) {
  if (!changes?.length) return ['| 1 | 待拆分 | 未开始 | 无 |'];
  return changes.map((c, idx) => {
    const clean = (v) => String(v ?? '').replace(/\|/g, '/');
    return `| ${idx + 1} | ${clean(c.title ?? c.repo)} | ${clean(c.state ?? '未开始')} | ${c.url ?? (c.repo && c.id ? `${c.repo}!${c.id}` : '无')} |`;
  });
}

function isMerged(state) {
  return ['merged', '已合入', '已合并'].includes(String(state ?? '').trim().toLowerCase());
}

function renderLedgerBody(kind, run, issue) {
  const models = run.roleModels ?? {};
  const model = (key) => models[key] ?? '未配置';
  const commands = Object.entries(run.verification?.commands ?? {}).map(([k, v]) => `${k}=${v}`).join('；') || '按仓库实际命令';
  const controllerLine = `主控：第 ${run.controller.generation} 任 ｜ ${run.controller.sessionId} ｜ ${run.controller.env ?? 'local'} ｜ ${stamp()}`;
  const changes = run.changes ?? [];
  const stage = run.stage;

  if (kind === 'tracking') {
    return [
      `## 1. ${TRACKING_SECTIONS[0]}（当前状态）`,
      `档位：L1 ｜ 阶段：${stage} ｜ 状态：未开始 ｜ 基线：${run.branch}`,
      `${controllerLine} ｜ 本轮：空闲 ｜ 最近唤醒：${stamp()}`,
      '当前步骤：准备做 初始化脚手架',
      '',
      `## 2. ${TRACKING_SECTIONS[1]}（简版范围与验收）`,
      `- 改什么 / 不改什么：${run.req}`,
      `- 验证命令与自验标准：${run.verification?.mode ?? 'local-test'} ｜ ${commands}`,
      '- 回退方式：revert 本次变更单合入提交',
      '',
      `## 3. ${TRACKING_SECTIONS[2]}（PR/MR 清单）`,
      '| 编号 | 内容 | 状态 | 链接 |',
      '| --- | --- | --- | --- |',
      ...changeRows(changes),
      '',
      `## 4. ${TRACKING_SECTIONS[3]}（待本人处理 / 风险）`,
      '无',
      '',
    ].join('\n');
  }

  if (kind === 'main' || kind === 'slot') {
    const confirmationPoints = run.rules?.effective?.filter((rule) => run.rules.personal?.includes(rule)
      && /^(?:提交|送审)前(?:本人)?先看[。！.!]?$/.test(rule)).join('、') || '无';
    return [
      `## 1. ${PERSONAL_SECTIONS[0]}（当前状态）`,
      `档位：${run.tier} ｜ 阶段：${stage} ｜ 当前 Issue：未绑定 ｜ 状态：未开始 ｜ 基于契约：${run.contractVersion ?? 'v1'}（待冻结）`,
      '当前步骤：准备做 初始化脚手架',
      controllerLine,
      '本轮：空闲',
      `最近唤醒：${stamp()}`,
      '依赖：无',
      '',
      `## 2. ${PERSONAL_SECTIONS[1]}`,
      '- 无',
      '',
      `## 3. ${PERSONAL_SECTIONS[2]}（当前 Issue 的变更单计划）`,
      '| 变更单 | 内容一句话 | 状态 | 链接 |',
      '| --- | --- | --- | --- |',
      ...changeRows(changes),
      '',
      `## 4. ${PERSONAL_SECTIONS[3]}（风险与阻断）`,
      '无',
      '',
      `## 5. ${PERSONAL_SECTIONS[4]}与规则引用（个人配置）`,
      `模型：主控 ${model('controller')} / 拆分 ${model('planner')} / 开发 ${model('coder')} / 自审 ${model('selfReviewer')} / 终审 ${model('finalReviewer')} / 验收 ${model('acceptor')} / 小巡检 ${model('patrol')}`,
      `自审：${run.selfReview === false ? '否' : '是'} ｜ 可选确认点：${confirmationPoints} ｜ 巡检频率：${run.thresholds.smallPatrolMinutes}m ｜ 工作时段：${run.workHours.start}-${run.workHours.end}（${run.workHours.timezone}） ｜ 汇报方式：进度、待办、最近唤醒各一句并附链接`,
      '',
    ].join('\n');
  }

  if (kind === 'master') {
    const slotRows = normalizeSlots(run.slots).map((slot) => (slot === '主研发'
      ? `| 主研发 | ${run.user} | 全局调度 | 无 | ${run.issues?.['slot:主研发']?.id ?? '待建'} |`
      : `| ${slot} | - | 待认领 | 无 | 加入时本人自建 |`));
    const merged = changes.filter((c) => isMerged(c.state)).map(changeRef);
    const ref = issue?.id ?? '未绑定';
    const node = (p) => (p === stage ? '进行中' : (Number(p.slice(1)) < Number(stage.slice(1)) ? '已完成' : '未开始'));
    return [
      '## 1. 整体状态',
      `当前阶段：${stage} ｜ 下一节点：${stage === 'P0' ? 'P1 方案设计（五项汇总确认后）' : '按阶段节点推进'}`,
      `合并方式：${describeMergeMode(run)}`,
      `整体进度：Issue 已完成 ${run.completedIssues ?? 0}/${run.totalIssues ?? 0} ｜ PR/MR 已合入 ${merged.length}/${changes.length}`,
      `已合入变更单：${merged.length ? merged.join('、') : '无'}`,
      '整体风险：无',
      '全量审阅变更单：未建',
      '',
      '## 2. 待主研发处理（只列未关闭项）',
      '- 无',
      '',
      '## 3. 各开发者',
      '| 槽位 | 用户名 | 负责范围 | 依赖（照抄小台账并标来源） | 小台账链接 |',
      '| --- | --- | --- | --- | --- |',
      ...slotRows,
      '',
      '## 4. 契约与归属',
      `契约版本：${run.contractVersion ?? 'v1'}（待冻结） → ${ref}`,
      `文件归属表 → ${ref}`,
      '',
      '## 5. 阶段节点',
      `P0 ${node('P0')} ｜ P1 ${node('P1')} ｜ P2 ${node('P2')} ｜ P3 ${node('P3')} ｜ P4 未开始`,
      '',
    ].join('\n');
  }

  return [
    '## 升级串（一事一串，正文不维护索引表）',
    '',
    '固定首条：',
    '角色 ｜ 槽位 ｜ 会话标识',
    '升级-<槽位>-NNN ｜ 提出人槽位 ｜ 阻断 / 非阻断',
    '问题：……',
    '影响：……',
    '建议方案：……',
    '建议执行人：……',
    '',
    '裁决回写（同串追加，写入评论才生效）：',
    '角色 ｜ 槽位 ｜ 会话标识',
    '【裁决】升级-<槽位>-NNN：结论 ｜ 执行人 ｜ 解除条件：无 / 某变更单合入',
    '',
  ].join('\n');
}

function buildLedgers(run) {
  return ledgerDescriptors(run).map((d) => {
    const issue = run.issues?.[d.key] ?? null;
    return { ...d, issue, body: renderLedgerBody(d.kind, run, issue) };
  });
}

function timerSummary(run) {
  const t = run.thresholds;
  if (run.tier === 'L1') return '关';
  const base = `主控${t.controllerLoopMinutes}m+静音巡检${t.smallPatrolMinutes}m`;
  if (run.tier === 'L2' || (run.slot && run.slot !== '主研发')) return base;
  return `${base}+调度${t.controllerLoopMinutes}m+大巡检${t.leadPatrolMinutes}m${run.notify.dailyReportEnabled ? `+日报${run.notify.dailyReportTime}` : ''}`;
}

/** 有生效协作规矩时才追加的 1 行摘要；未配置 rules 时确认单保持原样 6 行。 */
function ruleSummaryLine(rules) {
  const effective = Array.isArray(rules?.effective) ? rules.effective : [];
  if (effective.length === 0) return null;
  const blockedPersonal = (Array.isArray(rules?.blocked) ? rules.blocked : []).filter((item) => item?.layer === 'personal').length;
  const personal = Math.max((rules?.personal?.length ?? 0) - blockedPersonal, 0);
  return `协作规矩：生效 ${effective.length} 条（个人 ${personal} / 工程 ${rules?.project?.length ?? 0} / 临时 ${rules?.temp?.length ?? 0}）`;
}

function trialStrategySummary(run) {
  const { mode, skipReason } = resolveTrialConfig(run.verification);
  const skip = `不试合（原因：${skipReason ?? (mode === 'local-test' ? '未配置验证命令' : `mode=${mode}`)}）`;
  const commands = run.repos.map((repo) => ({ repo, command: resolveTrialConfig(run.verification, repo).command }));
  if (mode !== 'local-test' || !commands.some(({ command }) => command)) return skip;
  return commands.map(({ repo, command }) => `${repo.name ?? repo.repo}=${command ?? skip}`).join('；');
}

function confirmLines(run) {
  const models = run.roleModels ?? {};
  const model = (key) => models[key] ?? '未配置';
  const mode = run.verification?.mode ?? 'local-test';
  const trialSummary = trialStrategySummary(run);
  const win = run.thresholds.externalMentionWindow;
  const notify = run.notify?.feishuGroupChatId ? `群ID(${run.notify.feishuGroupChatId})(限${win.start}-${win.end}@)` : '仅会话';
  const linked = run.repos.filter((r) => r.repo !== run.hubRepo?.repo).map((r) => r.repo);
  const mergeRestriction = protectedMergeBaseline(run) ? '（基线是受保护分支）' : '';
  const acceptorPart = run.tier !== 'L1' && (run.acceptance?.enabled || models.acceptor) ? ` ｜ 验收=${model('acceptor')}` : '';
  const acceptancePart = run.tier === 'L1' ? ''
    : run.acceptance?.enabled ? ` ｜ 出口验收：开启（说明：${run.acceptance.guide ?? '未配置'}）`
    : ' ｜ 出口验收：关闭';
  const lines = [
    `1. 需求与档位：${run.req} ｜ 档位：${run.tier} ｜ 起跳阶段：${run.stage}`,
    `2. 工程组与基线：Forge=${run.forge ?? '未配置'}${run.gitlabHost ? `@${run.gitlabHost}` : ''} ｜ 核心仓=${run.hubRepo?.repo ?? '未配置'} ｜ 关联仓=${linked.length ? linked.join(',') : '无'} ｜ 基线=${run.branch}`,
    `3. 验证策略：mode=${mode} ｜ 合并前试合=${trialSummary}`,
    `4. 角色模型：主控=${model('controller')} ｜ 开发=${model('coder')} ｜ 开发升档=${model('coderEscalation')} ｜ 自审=${run.selfReview === false ? '关' : model('selfReviewer')} ｜ 终审=${model('finalReviewer')}${acceptorPart} ｜ 巡检=${run.tier === 'L1' ? '关' : model('patrol')}`,
    `5. 节奏与收尾：定时=${timerSummary(run)} ｜ 工作时段=${run.workHours.start}-${run.workHours.end}（${run.workHours.timezone}） ｜ 通知=${notify}${acceptancePart} ｜ 合入后执行 teardown 两步拆架，逐项清理后归档，业务仓库零规范残留。`,
    `6. 合并方式：${describeMergeMode(run)}${mergeRestriction}`,
  ];
  const summary = ruleSummaryLine(run.rules);
  if (summary) lines.push(summary);
  return lines;
}

function planFor(run, configDir) {
  const confirmSheet = confirmLines(run);
  return {
    confirmSheet,
    text: ['【xxn-lite-loop 初始化确认单】', ...confirmSheet, '请回复「确认」启动，或直接指出要改的一项。'].join('\n'),
    ledgers: ledgerDescriptors(run),
    scheduledTasks: scheduledTasksFor(run, configDir),
    labels: labelsFor(run.tier, run.slots, run.req),
    labelsSync: { script: 'forge.mjs', args: labelsSyncArgs(run) },
  };
}

/* ------------------------------------------------------------------ */
/* config-resolve / preview-init / init                                 */
/* ------------------------------------------------------------------ */

function cmdConfigResolve(flags, configDir) {
  const project = requireFlag(flags, 'project');
  const cfg = resolveConfig({ configDir, project, tier: optFlag(flags, 'tier'), overrides: parseJsonArg(flags.overrides, 'overrides') });
  return {
    ok: true,
    version: VERSION,
    ...cfg,
    sources: [
      { level: 'skill', path: 'references/tiers.md' },
      { level: 'me', path: cfg.meFile },
      { level: 'project', path: cfg.projectFile },
      { level: 'overrides', inline: flags.overrides !== undefined },
    ],
  };
}

function modelVendor(model) {
  const name = String(model ?? '').trim().toLowerCase();
  const vendors = [
    ['OpenAI', /(?:^|[\s/:])(?:openai|codex|gpt-[\d]|o[134](?:\b|[-.]))/],
    ['Anthropic', /(?:^|[\s/:])(?:anthropic|claude)(?:[-/:\s]|$)/],
    ['Google', /(?:^|[\s/:])(?:google|gemini)(?:[-/:\s]|$)/],
    ['DeepSeek', /(?:^|[\s/:])deepseek(?:[-/:\s]|$)/],
    ['xAI', /(?:^|[\s/:])(?:xai|grok)(?:[-/:\s]|$)/],
    ['Alibaba', /(?:^|[\s/:])(?:alibaba|qwen)(?:[-/:\s]|\d|$)/],
  ];
  return vendors.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

function cmdPreviewInit(flags, configDir) {
  const { spec, cfg, warnings } = buildRunSpec(flags, configDir);
  const plan = planFor({ ...spec, controller: { sessionId: optFlag(flags, 'session') } }, configDir);
  const vendor = modelVendor(spec.roleModels.controller);
  const roles = spec.tier === 'L3' ? [['小巡检', spec.roleModels.patrol], ['大巡检', spec.roleModels.leadPatrol]]
    : spec.tier === 'L2' ? [['小巡检', spec.roleModels.patrol]] : [];
  for (const [role, model] of roles) {
    if (vendor && modelVendor(model) === vendor) warnings.push(`${role}与主控模型同为 ${vendor}，请留意交叉判断覆盖。`);
  }
  return {
    ok: true,
    req: spec.req,
    project: spec.project,
    tier: spec.tier,
    tierLabel: cfg.tierLabel,
    stage: spec.stage,
    forge: spec.forge,
    branch: spec.branch,
    hubRepo: spec.hubRepo,
    repos: spec.repos,
    slots: spec.slots,
    ...(spec.slot ? { slot: spec.slot } : {}),    autoMerge: spec.autoMerge,
    acceptance: spec.acceptance,
    protectedEnvBranches: spec.protectedEnvBranches,
    confirmSheet: plan.confirmSheet,
    text: plan.text,
    plan: { ...plan, repos: spec.repos.map((r) => r.repo), verification: spec.verification },
    warnings,
  };
}

function initForgePlan(run, labelsSync = { script: 'forge.mjs', args: labelsSyncArgs(run) }) {
  return {
    issueCreates: (run.ledgers ?? []).filter((ledger) => !ledger.issue)
      .map(({ key, title, body }) => ({
        key, title, body, labels: key.startsWith('slot:') ? [`槽位${key.slice(5)}`] : [],
      })),
    labelsSync,
    scheduledTasks: run.scheduledTasks,
  };
}

function bindInitIssues(run, raw) {
  const supplied = normalizeIssueMap(raw);
  if (!isPlainObject(raw) || Object.keys(raw).length !== Object.keys(supplied).length) {
    throw new CliError('INVALID_ISSUE_MAP', '--issue-map 必须是台账键到 Issue 编号或 {id,url} 的映射');
  }
  const issues = { ...run.issues };
  const ledgers = run.ledgers ?? [];
  for (const [key, issue] of Object.entries(supplied)) {
    const id = issueNumber(issue.id);
    if (!id) throw new CliError('INVALID_ISSUE_MAP', `台账 ${key} 缺少有效的 Issue 编号`);
    const existing = issues[key] ?? ledgers.find((ledger) => ledger.key === key)?.issue;
    const existingId = existing?.id ?? existing;
    if (existingId != null && issueNumber(existingId) !== id) {
      throw new CliError('ISSUE_ALREADY_BOUND', `台账 ${key} 已绑定 ${existingId}，无法回填 ${issue.id}`);
    }
    issues[key] = { ...issue, id: existingId ?? issue.id, url: existing?.url ?? issue.url };
  }
  return {
    ...run,
    issues,
    ledgers: ledgers.map((ledger) => ({ ...ledger, issue: issues[ledger.key] ?? ledger.issue })),
    scheduledTasks: (run.scheduledTasks ?? []).map((task) => {
      const ledgerRef = issues[task.ledgerKey]?.id;
      if (!ledgerRef || ledgerRef === task.ledgerRef) return task;
      return {
        ...task,
        ledgerRef,
        description: task.description?.replace(`；台账=${task.ledgerRef}；`, () => `；台账=${ledgerRef}；`),
      };
    }),
  };
}

function cmdInit(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const file = runFile(configDir, req);
  const session = flags.session === undefined ? null : requireFlag(flags, 'session');
  const alreadyExists = () => new CliError('RUN_ALREADY_EXISTS', `需求 ${req} 已有运行态：传 --resume 读回既有记录或回填未绑定台账`, { runPath: file });
  const readResume = () => {
    let run = readJson(file, 'RUN_NOT_FOUND');
    let next = run;
    if (flags['issue-map'] !== undefined) {
      requireFlag(flags, 'issue-map');
      next = bindInitIssues(run, parseJsonArg(flags['issue-map'], 'issue-map'));
    }
    if (session) {
      const ledger = boundLedger(next, personalLedgerKey(next.tier, dispatchSlot(next)));
      if (!ledger) throw new CliError('LEDGER_NOT_BOUND', '运行态未绑定主控台账');
      const owner = readForgeIssueOwner(next, ledger, session);
      next = { ...next, controller: { ...next.controller, ...owner } };
    }
    const generated = scheduledTasksFor(next, configDir);
    const controllerTask = generated.find(({ role }) => role === 'controller');
    const scheduledTasks = (next.scheduledTasks ?? generated).map((task) => task.role === 'controller' && controllerTask
      ? { ...task, description: controllerTask.description } : task);
    if (next !== run) {
      next = { ...next, scheduledTasks };
      if (JSON.stringify(next) !== JSON.stringify(run)) {
        run = { ...next, updatedAt: new Date().toISOString() };
        writeJson(file, run);
      }
    }
    return { ok: true, resumed: true, req, runPath: file, run, scheduledTasks, forgePlan: initForgePlan(run) };
  };
  const resume = () => flags['issue-map'] === undefined && !session ? readResume() : withFileLock(tickLockPath(file), readResume);
  if (fs.existsSync(file)) {
    if (flags.resume) return resume();
    throw alreadyExists();
  }
  const { spec, warnings } = buildRunSpec(flags, configDir);
  if (!spec.forge) throw new CliError('MISSING_FORGE', '工程档案未配置 forge（gitlab/github），拒绝初始化');
  const unverified = missingVerificationRepos(spec);
  if (unverified.length) {
    const names = unverified.map((r) => r.name ?? r.repo).join('、');
    throw new CliError(
      'MISSING_VERIFICATION',
      `verification.mode=local-test 下仓库 ${names} 既未配置验证命令，也未写明 verification.skipReason；请补充 verification.commands 或写明不测原因`,
      { repos: unverified.map((r) => r.name ?? r.repo) },
    );
  }
  const reposWithOrigin = spec.repos.map((r) => ({
    ...r,
    baselineStartSha: r.baselineStartSha ?? resolveGitBaselineStartSha(r.path, spec.baselineBranch, r.branch),
  }));
  const now = new Date().toISOString();
  const run = {
    schema: 2,
    version: VERSION,
    ...spec,
    repos: reposWithOrigin,
    status: 'active',
    controller: {
      generation: 1,
      sessionId: session ?? `session-${Date.now().toString(36)}`,
      state: '空闲',
      env: 'local',
      startedAt: now,
      lastWake: now,
    },
    changes: [],
    worktrees: [],
    participants: [],
    contractVersion: spec.contracts === false ? null : 'v1',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, type: 'init', tier: spec.tier, stage: spec.stage }],
  };
  run.ledgers = buildLedgers(run);
  const plan = planFor(run, configDir);
  run.scheduledTasks = plan.scheduledTasks;
  try {
    writeJson(file, run, { create: true });
  } catch (err) {
    if (err.code === 'EEXIST') {
      if (flags.resume) return resume();
      throw alreadyExists();
    }
    throw err;
  }
  return {
    ok: true,
    req,
    project: spec.project,
    tier: spec.tier,
    stage: spec.stage,
    branch: spec.branch,
    runPath: file,
    run,
    ledgers: run.ledgers,
    scheduledTasks: run.scheduledTasks,
    labels: plan.labels,
    confirmSheet: plan.confirmSheet,
    forgePlan: initForgePlan(run, plan.labelsSync),
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* upgrade：逐级、保留已确认配置、计划与确认分离                            */
/* ------------------------------------------------------------------ */

function resultDone(value) {
  if (value === true || value === 'done') return true;
  return isPlainObject(value) && (value.done === true || value.ok === true || value.stopped === true || value.closed === true);
}

function planUpgrade(run, to, slots, cfg) {
  const issues = { ...(run.issues ?? {}) };
  if (to === 'L2') issues.main = issues.main ?? issues.tracking ?? null;
  else issues.master = issues.master ?? issues.main ?? null;
  const next = {
    ...run,
    tier: to,
    slots,
    issues,
    thresholds: { ...cfg.thresholds, ...run.thresholds },
    notify: { ...cfg.notify, ...run.notify },
    autoMerge: !protectedMergeBaseline(run) && (run.autoMergeConfigured ? run.autoMerge : TIER_PROFILES[to].autoMerge),
    contracts: TIER_PROFILES[to].contracts,
    contractVersion: run.contractVersion ?? 'v1',
    rules: cfg.rules,
  };
  next.ledgers = buildLedgers(next);
  next.scheduledTasks = scheduledTasksFor(next, cfg.configDir);

  const hubKey = to === 'L2' ? 'main' : 'master';
  const hub = next.ledgers.find((l) => l.key === hubKey);
  const actions = [{
    id: `ledger:${hubKey}`,
    kind: 'issue-upgrade',
    action: 'update',
    key: hubKey,
    issue: hub.issue,
    title: hub.title,
    note: to === 'L2'
      ? '原 L1 追踪 Issue 升格为 L2 主台账，补齐 5 节快照；历史评论与已合入 PR/MR 原样保留'
      : '原 L2 主台账升格为 L3 总台账，原进度计数与已完成 PR/MR 全部继承',
  }];
  if (to === 'L2') {
    (run.changes ?? []).forEach((change, idx) => {
      if (isMerged(change.state)) return;
      actions.push({
        id: `subissue:${change.repo ?? run.hubRepo?.repo}#${change.id ?? idx + 1}`,
        kind: 'issue',
        action: 'create',
        parent: 'main',
        title: `【子任务】${change.title ?? `${run.req}-${idx + 1}`}`,
        note: '把尚未完成的拆分子任务提升为独立业务子 Issue 并挂载主台账',
      });
    });
  } else {
    for (const ledger of next.ledgers.filter((l) => l.key !== 'master' && !issueNumber(l.issue?.id))) {
      actions.push({ id: `issue:${ledger.key}`, kind: 'issue', action: 'create', key: ledger.key, title: ledger.title, note: '新建后通过 --issue-map 回填编号' });
    }
    actions.push({ id: 'contract:ensure', kind: 'contract', action: 'ensure', note: '按需补齐契约文档与文件归属表，挂总台账第 4 节' });
    for (const slot of slots.filter((s) => s !== '主研发')) {
      actions.push({ id: `slot-label:${slot}`, kind: 'issue-label', action: 'assign', slot, label: `槽位${slot}`, note: '给未分配的业务子 Issue 打槽位标签，不预指派账号' });
    }
  }
  actions.push({ id: 'labels:sync', kind: 'labels', action: 'sync', labels: labelsFor(to, slots, run.req), args: labelsSyncArgs(next) });

  const prev = new Map((run.scheduledTasks ?? []).map((t) => [t.id, t]));
  const added = next.scheduledTasks.filter((t) => !prev.has(t.id));
  const removed = [...prev.values()].filter((t) => !next.scheduledTasks.some((n) => n.id === t.id));
  for (const task of next.scheduledTasks) {
    const old = prev.get(task.id);
    if (!old) actions.push({ id: `task:create:${task.id}`, kind: 'scheduled-task', action: 'create', task });
    else if (old.description !== task.description || old.ledgerKey !== task.ledgerKey || old.ledgerRef !== task.ledgerRef
      || old.everyMinutes !== task.everyMinutes || old.schedule !== task.schedule) {
      actions.push({ id: `task:update:${task.id}`, kind: 'scheduled-task', action: 'update', task });
    }
  }
  for (const task of removed) actions.push({ id: `task:stop:${task.id}`, kind: 'scheduled-task', action: 'stop', task });

  const t = next.thresholds;
  const notes = to === 'L2'
    ? [
      `自动合并：${next.autoMerge ? '开启（仅需求基线、非环境分支、SHA 与依赖实查通过）' : '关闭（工程档案已确认）'}；每完成 1 个业务子 Issue 计划交接换新主控。`,
      `启用 ${t.mrIdleWarnHours}h 压单提醒与 ${t.ledgerMaxLines} 行台账检查。`,
    ]
    : [
      `主研发机器另开「主研发调度」${t.controllerLoopMinutes}m 与「大巡检」${t.leadPatrolMinutes}m${next.notify.dailyReportEnabled ? `，由大巡检在 ${next.notify.dailyReportTime} 后首次唤醒时处理日报` : '（日报未启用）'}。`,
      `启用 P3 长期暂停 ${t.p3PauseMaxHours}h / 零产出静默 ${t.p3SilentMaxHours}h / MR 压单 ${t.mrIdleEscalateHours}h / 阻断 ${t.blockEscalateHours}h 客观探针。`,
    ];
  return { next, actions, added, removed, notes };
}

function cmdUpgrade(flags, configDir) {
  const req = optFlag(flags, 'req') ?? requireFlag(flags, 'run');
  const to = normalizeTier(requireFlag(flags, 'to'));
  const file = runFile(configDir, req);
  const run = readJson(file, 'RUN_NOT_FOUND');
  const from = normalizeTier(run.tier);
  if (tierRank(to) < tierRank(from)) throw new CliError('DOWNGRADE_FORBIDDEN', `禁止逆向降档：${from} → ${to}；升档只支持 L1→L2、L2→L3`);
  if (to === from) throw new CliError('SAME_TIER', `当前已是 ${from}，无需重复升档`);
  if (tierRank(to) - tierRank(from) > 1) {
    throw new CliError('SKIP_TIER_FORBIDDEN', `禁止跨档 ${from} → ${to}：先 upgrade --to L2 并 --apply 完成，再 upgrade --to L3`);
  }
  const pending = run.pendingUpgrade ?? null;
  if (pending && pending.to !== to) throw new CliError('UPGRADE_PENDING', `已有未完成的升档 ${from} → ${pending.to}，先完成或重试该升档`);

  const cfg = resolveConfig({ configDir, project: run.project, tier: to });
  const slots = pending?.slots ?? (to === 'L3' ? normalizeSlots(optFlag(flags, 'slots') ?? cfg.slots) : ['主研发']);
  const suppliedIssues = normalizeIssueMap(parseJsonArg(flags['issue-map'], 'issue-map'));
  if (to === 'L3') {
    if (suppliedIssues.personalLedger) suppliedIssues['slot:主研发'] ??= suppliedIssues.personalLedger;
    if (suppliedIssues.upgrade) suppliedIssues.escalation ??= suppliedIssues.upgrade;
    delete suppliedIssues.personalLedger;
    delete suppliedIssues.upgrade;
  }
  const issues = { ...run.issues, ...pending?.issues, ...suppliedIssues };
  const results = { ...(pending?.results ?? {}), ...parseJsonArg(flags.results, 'results') };
  const plan = planUpgrade({ ...run, issues }, to, slots, cfg);
  const initialTasks = flags.apply && !pending?.plannedBindings ? planUpgrade(run, to, slots, cfg).next.scheduledTasks : plan.next.scheduledTasks;
  const plannedBindings = pending?.plannedBindings ?? Object.fromEntries(initialTasks.map((task) => [task.id, task.ledgerRef]));
  const forgeObjects = plan.actions.map((a) => {
    const receipt = results[a.id];
    if (to === 'L3' && a.kind === 'issue') return { ...a, done: false, required: '--issue-map <实际 Issue 编号>' };
    if (to === 'L3' && a.kind === 'scheduled-task' && a.action !== 'stop') {
      const ledgerId = issueNumber(a.task.ledgerRef);
      const confirmedBinding = a.action === 'create' ? 'created' : 'updated';
      if (!ledgerId) return { ...a, done: false, required: `--issue-map 补齐 ${a.task.ledgerKey} 的实际 Issue 编号` };
      const needsBinding = ledgerId !== issueNumber(plannedBindings[a.task.id]);
      if (needsBinding || receipt?.ledgerId !== undefined || receipt?.[confirmedBinding] === true) {
        return {
          ...a,
          done: receipt?.[confirmedBinding] === true && issueNumber(receipt.ledgerId) === ledgerId,
          required: { [confirmedBinding]: true, ledgerId: a.task.ledgerRef },
        };
      }
    }
    return { ...a, done: resultDone(receipt) };
  });
  const missing = forgeObjects.filter((a) => !a.done);
  const now = new Date().toISOString();
  const preserved = {
    issueIds: Object.entries(run.issues ?? {}).filter(([, v]) => v?.id).map(([key, v]) => ({ key, id: v.id, url: v.url ?? null })),
    changeCount: run.changes?.length ?? 0,
    mergedCount: (run.changes ?? []).filter((c) => isMerged(c.state)).length,
    changes: (run.changes ?? []).map((c) => ({ repo: c.repo, id: c.id, state: c.state, url: c.url ?? null })),
    controllerGeneration: run.controller?.generation ?? 1,
    thresholds: run.thresholds,
  };
  const base = {
    req: run.req,
    from,
    to,
    runPath: file,
    preserved,
    forgeObjects,
    labels: labelsFor(to, slots, run.req),
    scheduledTasks: plan.next.scheduledTasks,
    addedScheduledTasks: plan.added,
    removedScheduledTasks: plan.removed,
    notes: plan.notes,
  };

  if (!flags.apply || missing.length) {
    writeJson(file, { ...run, pendingUpgrade: { to, slots, issues, plannedBindings, createdAt: pending?.createdAt ?? now, results }, updatedAt: now });
    if (!flags.apply) {
      return { ok: true, phase: 'planned', ...base, pending: missing.map((a) => a.id), nextRun: plan.next, next: `完成外部动作后执行 upgrade --req ${req} --to ${to} --apply --results <json>` };
    }
    return {
      ok: false,
      phase: 'apply-incomplete',
      code: 'UPGRADE_INCOMPLETE',
      message: `${missing.length} 项外部动作未确认：补齐实际 Issue 编号、按最新台账绑定更新定时任务，再提交缺失回执`,
      ...base,
      pending: missing.map((a) => a.id),
      exitCode: 3,
    };
  }

  const { pendingUpgrade, ...rest } = plan.next;
  const nextRun = {
    ...rest,
    updatedAt: now,
    history: [...(run.history ?? []), { at: now, type: 'upgrade', from, to, preservedIssues: preserved.issueIds, results: Object.keys(results) }],
  };
  writeJson(file, nextRun);
  return { ok: true, phase: 'applied', ...base, run: nextRun };
}

/* ------------------------------------------------------------------ */
/* wake-decision                                                        */
/* ------------------------------------------------------------------ */

function evalWakeDecision(input) {
  const t = { ...THRESHOLD_DEFAULTS, ...(input.thresholds ?? {}) };
  const ledgerControllerId = input.ledgerControllerId ?? input.ledger?.controllerSessionId ?? null;
  const currentSessionId = input.currentSessionId ?? input.sessionId ?? null;
  const verified = Boolean(ledgerControllerId && currentSessionId);
  const isSelf = verified ? String(ledgerControllerId) === String(currentSessionId) : bool(input.isSelf, false);
  const rawState = String(input.state ?? input.controllerState ?? '空闲');
  const state = rawState.includes('暂停') ? '暂停' : (rawState.includes('执行中') ? '执行中' : '空闲');
  const explicit = bool(input.explicitTakeover ?? input.explicit, false);
  const basis = bool(input.handoffBasis ?? input.hasBasis, false);
  const handoffComment = bool(input.handoffComment, false);
  const generation = num(input.generation ?? input.controllerGeneration, 1);
  const stuckHours = num(input.stuckHours ?? t.stuckHours, 2);
  const runningMinutes = num(input.runningMinutes ?? num(input.runningHours) * 60, 0);
  const lastWakeMinutes = num(input.lastWakeMinutes ?? num(input.lastWakeHours) * 60, 0);
  const disconnectAt = num(input.controllerLoopMinutes ?? t.controllerLoopMinutes, 30) * num(t.disconnectCycles, 2);
  const scheduled = input.trigger === 'scheduled';
  const now = input.now ? parseInstant(input.now, 'now') : (scheduled ? Date.now() : null);
  const work = now === null ? null : windowAt(now, workWindow(input));
  const offHours = Boolean(work && !work.inside && input.manualContinue !== true
    && (scheduled || (input.trigger !== 'user' && !explicit)));

  let row;
  if (isSelf && state === '暂停') {
    row = ['paused-hold', 'SELF_PAUSED_HOLD', '暂停中：仅更新最近唤醒后退出；本人说「开工」才恢复原状态，不得自行开轮。'];
  } else if (isSelf && offHours) {
    row = ['heartbeat-only', 'OFF_HOURS_HEARTBEAT', `非工作时段（${work.start}-${work.end} ${work.timezone}）：定时唤醒只更新最近唤醒，不开轮、不 push、不建 PR/MR、不改标签。`];
  } else if (isSelf && state === '空闲') {
    row = ['start-round', 'SELF_IDLE_START', '开始本轮：写「本轮：执行中」与开始时间、最近唤醒，对账推进，结束改空闲。'];
  } else if (isSelf && state === '执行中' && !explicit) {
    row = runningMinutes < stuckHours * 60
      ? ['heartbeat', 'SELF_RUNNING_HEARTBEAT', `未满 ${stuckHours}h：仅刷新最近唤醒后退出，不开新轮。`]
      : ['self-heal', 'SELF_RUNNING_STUCK_HEAL', `已满 ${stuckHours}h：重写「执行中」与开始时间，发【恢复】续接断点。`];
  } else if (isSelf && state === '执行中') {
    row = ['confirm-previous-stopped', 'SELF_RUNNING_EXPLICIT', '先向本人确认上一轮已停，确认后按断点重开并发【恢复】，不得并行开轮。'];
  } else if (offHours && (explicit || basis)) {
    row = ['outside-work-hours-wait', 'OFF_HOURS_TAKEOVER_WAIT', '非工作时段：等待进入工作时段或本人明确继续后再接任。'];
  } else if (explicit) {
    row = ['take-over-active', 'TAKEOVER_EXPLICIT', '接管前本人先关旧会话；登记第 N+1 任、发【交接】、先停旧同名定时任务再自建本会话定时任务。'];
  } else if (basis) {
    row = ['take-over-by-basis', 'TAKEOVER_BY_BASIS', '按依据接任：登记第 N+1 任、发【交接】/【恢复】、自建定时任务；遵守接任首轮边界。'];
  } else {
    row = ['exit-non-current', 'EXIT_NON_CURRENT', `退出非现任会话：停用本会话定时任务并提示「已被第 ${generation} 任接替」。`];
  }
  const [action, code, nextAction] = row;
  const firstRoundBoundary = action.startsWith('take-over') && !handoffComment;

  return {
    ok: true,
    action,
    code,
    identity: { isSelf, verified, ledgerControllerId, currentSessionId, generation },
    state: { raw: rawState, normalized: state, runningMinutes, lastWakeMinutes },
    workHours: work,
    explicitTakeover: explicit,
    handoffBasis: basis,
    firstRoundBoundary,
    selfHeal: {
      required: action === 'self-heal',
      atMinutes: stuckHours * 60,
      thresholdHours: stuckHours,
      action: action === 'self-heal' ? 'rewrite-executing + recovery-comment' : null,
    },
    disconnect: { thresholdMinutes: disconnectAt, disconnected: state === '空闲' && !offHours && lastWakeMinutes >= disconnectAt },
    nextAction,
  };
}

/** `xxxHours` 视为上游已按工作时段核算；否则用时间戳 + now 按工作分钟累计。 */
function workElapsed(item, hoursKey, atKey, ctx) {
  if (item?.[hoursKey] !== undefined) return num(item[hoursKey]);
  if (item?.[atKey] && ctx.nowMs !== null) return workHoursBetween(parseInstant(item[atKey], atKey), ctx.nowMs, ctx.win);
  return 0;
}

function finding(code, severity, key, title, text, extra = {}) {
  return { code, severity, key, title, detail: text, text, ...extra };
}

function ledgerStructure(ledger, tier) {
  const expectedTitles = String(tier).toUpperCase() === 'L1' ? TRACKING_SECTIONS : PERSONAL_SECTIONS;
  let titles;
  if (typeof ledger.body === 'string') {
    titles = [...ledger.body.matchAll(/^ {0,3}##[ \t]+([^\r\n]+)$/gm)].map((m) => m[1]);
  } else if (Array.isArray(ledger.sections)) {
    titles = ledger.sections.map((section) => String(section?.title ?? section ?? ''));
  }
  const sectionCount = titles?.length ?? ledger.sectionCount ?? ledger.sections;
  if (sectionCount === undefined) return null;
  if (num(sectionCount) === expectedTitles.length && (!titles || expectedTitles.every((title, i) => titles[i].includes(title)))) return null;
  return { sectionCount: num(sectionCount), expected: expectedTitles.length, expectedTitles, titles: titles ?? null };
}

function evalSmallPatrol(input, t, ctx) {
  const out = [];
  const ledger = input.ledger ?? {};
  const ledgerRef = ledger.id ?? ledger.url ?? 'ledger';
  const body = typeof ledger.body === 'string' ? ledger.body : null;
  const lines = num(ledger.lines ?? ledger.lineCount ?? countLedgerLines(body), 0);
  const maxLines = num(t.ledgerMaxLines, 80);
  const controller = input.controller ?? {};
  const cState = String(controller.state ?? '空闲');
  const paused = cState.includes('暂停');

  if (lines > maxLines) {
    out.push(finding('LEDGER_BLOAT', 'correction', `LEDGER_BLOAT:${ledgerRef}`, '台账正文膨胀',
      `【纠偏】台账正文 ${lines} 行超过 ${maxLines} 行：请精简为当前快照，聊设计另开普通会话，必要时换新主控。`, { lines, maxLines }));
  }
  const structure = ledgerStructure(ledger, input.tier ?? 'L2');
  if (structure) {
    out.push(finding('LEDGER_STRUCTURE', 'correction', `LEDGER_STRUCTURE:${ledgerRef}`, '台账固定章节被破坏',
      `【纠偏】台账实有 ${structure.sectionCount} 节，请恢复目录「${structure.expectedTitles.join(' / ')}」。`, structure));
  }
  const masterContract = input.master?.contractVersion ?? input.contractVersion ?? null;
  if (ledger.contractVersion && masterContract && String(ledger.contractVersion) !== String(masterContract)) {
    out.push(finding('CONTRACT_LAG', 'correction', `CONTRACT_LAG:${ledgerRef}:${masterContract}`, '契约版本滞后',
      `【纠偏】契约版本滞后：小台账 ${ledger.contractVersion} → 总台账 ${masterContract}，请对齐后继续。`, { ledgerContract: ledger.contractVersion, masterContract }));
  }

  for (const change of input.changes ?? []) {
    const labels = labelNames(change.labels);
    const ref = changeRef(change);
    if (!labels.some((l) => REVIEW_LABELS.includes(l))) {
      const idle = workElapsed(change, 'idleHours', 'updatedAt', ctx);
      if (idle >= num(t.mrIdleWarnHours, 4)) {
        out.push(finding('MR_IDLE_WARN', 'reminder', `MR_IDLE_WARN:${ref}`, 'PR/MR 压单未送审',
          `PR/MR 压单 ${idle.toFixed(1)}h 未送审：${ref}`, { repo: change.repo ?? null, id: change.id ?? null, url: change.url ?? null, idleHours: idle }));
      }
    } else if (labels.some((l) => l === '待终审' || l === '终审中')) {
      const wait = workElapsed(change, 'reviewWaitHours', 'reviewRequestedAt', ctx);
      if (wait >= num(t.reviewWaitWarnHours, 24)) {
        out.push(finding('REVIEW_WAIT_WARN', 'reminder', `REVIEW_WAIT_WARN:${ref}:r${change.round ?? 1}`, '待终审等待过久',
          `【提醒】${ref} 待终审已 ${wait.toFixed(1)} 工作小时（≥ ${t.reviewWaitWarnHours}h），请催终审。`, { waitHours: wait }));
      }
    }
  }

  const gen = controller.generation ?? 'N';
  const runningHours = num(controller.runningHours ?? num(controller.runningMinutes) / 60, 0);
  if (!paused && !ctx.offHours && cState.includes('执行中') && runningHours >= num(t.stuckHours, 2)) {
    out.push(finding('CONTROLLER_STUCK', 'alert', `CONTROLLER_STUCK:g${gen}`, '主控卡住',
      `【提醒】第 ${gen} 任主控卡住 ${runningHours.toFixed(1)}h，请新主控按依据接任。`, { generation: controller.generation ?? null, pullNewController: true }));
  }
  const disconnectAt = (num(input.controllerLoopMinutes ?? t.controllerLoopMinutes, 30) * num(t.disconnectCycles, 2)) / 60;
  const lastWakeHours = controller.lastWakeMinutes !== undefined ? num(controller.lastWakeMinutes) / 60 : workElapsed(controller, 'lastWakeHours', 'lastWakeAt', ctx);
  if (!paused && !ctx.offHours && cState === '空闲' && lastWakeHours >= disconnectAt) {
    out.push(finding('CONTROLLER_DISCONNECTED', 'alert', `CONTROLLER_DISCONNECTED:g${gen}`, '主控失联',
      `【提醒】第 ${gen} 任主控失联 ${lastWakeHours.toFixed(1)}h（≥ ${t.disconnectCycles} 个主控周期），请新主控按依据接任。`, { generation: controller.generation ?? null, pullNewController: true }));
  }
  for (const item of input.confirmations ?? []) {
    const hours = workElapsed(item, 'hours', 'since', ctx);
    if (hours >= num(t.confirmTimeoutHours, 4)) {
      out.push(finding('CONFIRM_TIMEOUT', 'reminder', `CONFIRM_TIMEOUT:${item.id ?? item.title}`, '待确认项超时',
        `【提醒】待确认项「${item.title ?? item.id ?? ''}」已等待 ${hours.toFixed(1)}h，请本人回复。`, { id: item.id ?? null }));
    }
  }
  for (const item of input.corrections ?? []) {
    const hours = workElapsed(item, 'hours', 'since', ctx);
    if (!item.executed && hours >= num(t.correctionTimeoutHours, 2)) {
      out.push(finding('CORRECTION_TIMEOUT', 'reminder', `CORRECTION_TIMEOUT:${item.id ?? item.title}`, '纠偏未执行',
        `【提醒】【纠偏】「${item.title ?? item.id ?? ''}」超 ${hours.toFixed(1)}h 未回执，请回复「已执行」或「不执行：理由」。`, { id: item.id ?? null }));
    }
  }
  return out;
}

function evalLeadPatrol(input, t, ctx) {
  const out = [];
  const lead = { person: input.lead?.person ?? '主研发', openId: input.lead?.openId ?? input.leadOpenId ?? null };
  const who = (x) => ({ person: x?.person ?? x?.owner ?? x?.name ?? null, openId: x?.openId ?? null });
  for (const slot of input.p3?.slots ?? []) {
    const name = slot.slot ?? slot.name ?? '未命名槽位';
    if (bool(slot.paused, false)) {
      const hours = workElapsed(slot, 'pausedHours', 'pausedAt', ctx);
      const docs = bool(slot.updatingExternalDocs, false);
      if (hours >= num(t.p3PauseMaxHours, 8) || docs) {
        out.push(finding('P3_PAUSE_EXCEEDED', 'alert', `P3_PAUSE_EXCEEDED:${name}:${slot.pausedAt ?? slot.since ?? 'unknown'}`, 'P3 长期暂停不再豁免',
          `槽位 ${name} 标「暂停」已 ${hours.toFixed(1)}h${docs ? '，且暂停期间仍在更新外部设计文档' : ''}，请确认卡点或恢复时间。`,
          { slot: name, pausedHours: hours, updatingExternalDocs: docs, recipients: [who(slot), lead] }));
      }
    } else {
      const silent = workElapsed(slot, 'hoursSinceLastOutput', 'lastOutputAt', ctx);
      if (silent >= num(t.p3SilentMaxHours, 8) && num(slot.newChanges24h ?? slot.newChanges) === 0 && num(slot.newEscalations24h ?? slot.newEscalations) === 0) {
        out.push(finding('P3_SILENT', 'alert', `P3_SILENT:${name}:${slot.lastOutputAt ?? 'unknown'}`, 'P3 零产出静默',
          `槽位 ${name} 连续 ${silent.toFixed(1)}h 无新 PR/MR 且无新升级串，请核对子 Issue 五项与外部设计链接。`,
          { slot: name, silentHours: silent, recipients: [who(slot), lead] }));
      }
    }
  }
  for (const change of input.changes ?? []) {
    if (labelNames(change.labels).some((l) => REVIEW_LABELS.includes(l))) continue;
    const idle = workElapsed(change, 'idleHours', 'updatedAt', ctx);
    if (idle >= num(t.mrIdleEscalateHours, 8)) {
      const ref = change.repo && change.id != null ? `${change.repo}#${change.id}` : changeRef(change);
      out.push(finding('MR_IDLE_ESCALATE', 'alert', `MR_IDLE_ESCALATE:${ref}`, 'MR 压单满 1 工作日',
        `${changeRef(change)} 已压单 ${idle.toFixed(1)}h 未打「待终审」。`, { repo: change.repo ?? null, id: change.id ?? null, url: change.url ?? null, idleHours: idle, recipients: [who(change)] }));
    }
  }
  for (const ledger of input.ledgers ?? []) {
    const lines = num(ledger.lines ?? ledger.lineCount ?? countLedgerLines(ledger.body));
    const slot = ledger.slot ?? '-';
    const ledgerRef = ledger.id ?? ledger.url ?? slot;
    if (bool(ledger.correctionIneffective, true)) {
      if (lines > num(t.ledgerMaxLines, 80)) {
        out.push(finding('LEDGER_BLOAT_ESCALATE', 'alert', `LEDGER_BLOAT_ESCALATE:${ledgerRef}`, '台账膨胀且小巡检纠偏未生效',
          `槽位 ${slot} 小台账 ${lines} 行，超过 ${t.ledgerMaxLines} 行且纠偏未生效，请精简。`, { slot, lines, recipients: [who(ledger)] }));
      }
      const structure = ledgerStructure(ledger, ledger.tier ?? input.tier ?? 'L3');
      if (structure) {
        out.push(finding('LEDGER_STRUCTURE_ESCALATE', 'alert', `LEDGER_STRUCTURE_ESCALATE:${ledgerRef}`, '台账固定章节被破坏且小巡检纠偏未生效',
          `槽位 ${slot} 小台账纠偏未生效，请恢复目录「${structure.expectedTitles.join(' / ')}」。`, { slot, ...structure, recipients: [who(ledger)] }));
      }
    }
    const master = input.master?.contractVersion ?? null;
    if (ledger.contractVersion && master && String(ledger.contractVersion) !== String(master)) {
      out.push(finding('CONTRACT_LAG_LEAD', 'alert', `CONTRACT_LAG_LEAD:${ledgerRef}:${master}`, '契约滞后',
        `槽位 ${slot} 契约 ${ledger.contractVersion} 落后总台账 ${master}。`, { slot, ledgerContract: ledger.contractVersion, masterContract: master, recipients: [who(ledger)] }));
    }
  }
  for (const esc of input.escalations ?? []) {
    const hours = workElapsed(esc, 'hours', 'since', ctx);
    if (bool(esc.blocking, false) && !bool(esc.adjudicated, false) && hours >= num(t.blockEscalateHours, 4)) {
      out.push(finding('BLOCK_ESCALATE', 'alert', `BLOCK_ESCALATE:${esc.id ?? esc.url}`, '阻断升级串超时未裁决',
        `阻断类升级串 ${esc.id ?? ''} 已 ${hours.toFixed(1)}h 未裁决（超时绝不产生默认裁决）。`, { id: esc.id ?? null, url: esc.url ?? null, recipients: [who(esc), lead] }));
    }
  }
  if (input.dispatch && input.dispatch.alive === false) {
    out.push(finding('DISPATCH_DEAD', 'alert', 'DISPATCH_DEAD', '主研发调度疑似失联',
      '反向监督发现「主研发调度」会话未存活或长时间未更新，请主研发确认。', { recipients: [lead] }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* slot-claim                                                           */
/* ------------------------------------------------------------------ */

function liveSlotClaim(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const slot = slotKey(requireFlag(flags, 'slot'));
  const file = runFile(configDir, req);
  const run = fs.existsSync(file) ? readJson(file) : null;
  if (run && run.tier !== 'L3') throw new CliError('SLOT_CLAIM_REQUIRES_L3', '槽位绑定只适用于 L3');
  const masterLink = run ? null : requireFlag(flags, 'master');
  const currentSessionId = optFlag(flags, 'session') ?? run?.controller?.sessionId ?? requireFlag(flags, 'session');
  const facts = readSlotClaimFacts(run, masterLink, { viewer: true });
  const { slotLedgers, url, fragment, username } = facts;
  const claims = forgeSlotClaims(facts);
  const current = claims.find((claim) => claim.slot === slot && claim.sessionId === currentSessionId && claim.user?.toLowerCase() === username.toLowerCase() && !claim.withdrawn);
  return {
    slot, currentSessionId, currentUser: username, claims, masterUrl: url, fragment,
    existingLedger: slotLedgers.some((ledger) => slotKey(ledger.slot) === slot),
    ...(current ? { currentCommentUrl: `${url}#${fragment}${current.commentId}` } : {}),
  };
}

function cmdSlotClaim(flags, configDir) {
  const input = flags.input === undefined ? liveSlotClaim(flags, configDir) : parseJsonArg(flags.input, 'input');
  const slot = slotKey(optFlag(flags, 'slot') ?? input.slot);
  if (!slot) throw new CliError('MISSING_SLOT', '缺少 slot');
  const all = Array.isArray(input.claims) ? input.claims : [];
  const withdrawnIds = new Set((input.withdrawals ?? []).filter((w) => slotKey(w.slot) === slot).map((w) => String(w.claimId ?? w.commentId)));
  const claims = activeSlotClaims(all, slot, (claim) => bool(claim.withdrawn, false) || withdrawnIds.has(claim.claimId),
    (value) => parseInstant(value, 'claims[].createdAt'));
  const ignored = all.filter((claim) => !claim || slotKey(claim.slot) !== slot).length;
  if (claims.length === 0) {
    return { ok: true, slot, winner: null, losers: [], ignored, currentWins: false, action: 'claim', ledgerAction: 'none', note: '本槽位当前无有效绑定，可发起绑定；绑定生效后再建或复用小台账。' };
  }
  const [winner, ...losers] = claims;
  const currentSessionId = input.currentSessionId ?? input.sessionId ?? null;
  const currentWins = input.currentUser
    ? Boolean(winner.user && String(winner.user).toLowerCase() === String(input.currentUser).toLowerCase())
    : Boolean(currentSessionId && String(winner.sessionId) === String(currentSessionId));
  const rebind = currentWins && currentSessionId && winner.sessionId !== currentSessionId;
  const oldLink = rebind && input.masterUrl ? `${input.masterUrl}#${input.fragment}${winner.commentId}` : null;
  return {
    ok: true,
    slot,
    winner,
    losers,
    ignored,
    currentWins,
    action: currentWins ? 'bound' : 'withdraw-binding',
    ledgerAction: currentWins ? (input.existingLedger ? 'reuse-existing-ledger' : 'create-ledger-after-bind') : 'none',
    ...(oldLink ? { withdrawalComment: `【配置变更】撤回绑定：槽位${slot}｜原评论链接 ${oldLink}｜同一用户换会话` } : {}),
    comment: currentWins
      ? `【配置变更】绑定 槽位${slot}｜${input.currentUser ?? currentSessionId}｜${currentSessionId}`
      : `【配置变更】撤回绑定：槽位${slot}｜原评论链接 ${input.currentCommentUrl ?? '本会话绑定评论'}｜冲突：${winner.sessionId} 更早`,
    note: currentWins
      ? rebind ? '同一 Forge 用户可复用小台账。先登记新会话绑定，撤回旧绑定后重新核实最早有效绑定。'
        : '以本槽位最早未撤回绑定为准，绑定生效；此后才建或复用小台账并开始分派。'
      : '不改旧评论，追加撤回绑定评论后停下联系主研发，不建小台账、不覆盖他人指派。',
  };
}

/* ------------------------------------------------------------------ */
/* teardown：两步法，核验通过前绝不删除活动 run                            */
/* ------------------------------------------------------------------ */

function gitStatus(dir) {
  const abs = path.resolve(expandHome(String(dir)));
  if (!fs.existsSync(abs)) return { path: abs, exists: false, status: 'absent', dirty: null, files: [] };
  const res = spawnSync('git', ['-C', abs, 'status', '--porcelain'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(abs) },
  });
  if (res.status !== 0) return { path: abs, exists: true, status: 'unknown', dirty: null, files: [], error: (res.stderr || '').trim() };
  const files = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return { path: abs, exists: true, status: files.length ? 'dirty' : 'clean', dirty: files.length > 0, files };
}

function fileDigest(file) {
  return file && fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

function mergeResults(prev = {}, next = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    out[key] = isPlainObject(prev[key]) || isPlainObject(next[key]) ? { ...(prev[key] ?? {}), ...(next[key] ?? {}) } : (next[key] ?? prev[key]);
  }
  return out;
}

/** @typedef {{kind: 'change'|'bug'|'blocker'|'membership', ref: string, state: string, repo: string, id: number, title?: string, url?: string}} TeardownResidue */

function teardownResidue(facts) {
  const record = (item, kind, ref = issueRef(item)) => ({
    kind, ref, state: item.state, repo: item.repo, id: item.id, title: item.title, url: item.url,
  });
  const master = facts.ledgers.find((item) => item.key === 'master');
  const escalation = facts.ledgers.find((item) => item.key === 'escalation' && item.state === 'open');
  /** @type {TeardownResidue[]} */
  const residual = facts.changes.filter((item) => !isMerged(item.state) && item.state !== 'closed')
    .map((item) => record(item, 'change'));
  for (const warning of facts.warnings) {
    if (['closed', 'merged'].includes(warning.state)) continue;
    if (warning.kind === 'change' && warning.code === 'CHANGE_WRONG_TARGET') {
      residual.push(record({ ...warning, title: warning.message }, 'change'));
    } else {
      residual.push(record({ ...warning, title: warning.message, state: warning.state ?? 'unknown' }, 'membership',
        `${warning.kind}:${issueRef(warning)}`));
    }
  }
  for (const item of facts.subIssues) {
    if (item.state !== 'open') continue;
    if (item.labels.includes('阻断')) residual.push(record(item, 'blocker'));
    else if (item.labels.includes('bug')) residual.push(record(item, 'bug'));
  }
  for (const item of escalationsFor(escalation, master, ledgerSection)) {
    if (item.blocking && !item.adjudicated) residual.push(record(escalation, 'blocker', item.id));
  }
  return residual;
}

function teardownClosingSummary(facts) {
  const merged = facts.changes.filter((change) => isMerged(change.state)).map(changeRef);
  const incomplete = facts.errors.some(({ source }) => !source.startsWith('baseline:'));
  const baselines = facts.baselines.map(({ repo, branch, sha }) => {
    const prefix = facts.baselines.length > 1 ? `${repo} ` : '';
    return `${prefix}${branch}@${sha ?? '读取失败'}`;
  });
  return {
    changes: [merged.join('、'), incomplete ? 'Forge 实查不完整' : null].filter(Boolean).join('；') || '无',
    baselines: baselines.join('、') || '未核实',
  };
}

function teardownChecklist(run, facts, closingSummary, metrics, localLedgerKey) {
  const { ledgers: ledgerTargets, slotClaims } = facts;
  const residual = teardownResidue(facts);
  const tasks = (run.scheduledTasks ?? []).filter((task) => !localLedgerKey || task.ledgerKey === localLedgerKey
    || (!task.ledgerKey && ['controller', 'patrol'].includes(task.role)))
    .map((task) => ({ kind: 'scheduled-task', taskId: task.id, role: task.role, host: run.user, action: 'stop-and-delete' }));
  const participants = new Map((run.participants ?? []).map((p) => [slotKey(p.slot), p]));
  const claimedSlots = new Map(slotClaims.map((claim) => [claim.slot, claim]));
  const receipts = run.tier === 'L3' && !localLedgerKey
    ? normalizeSlots([...list(run.slots), ...claimedSlots.keys()]).filter((s) => s !== '主研发').map((slot) => {
      const participant = participants.get(slot);
      const claim = claimedSlots.get(slot);
      const claimed = Boolean(claim);
      return {
        kind: 'remote-scheduled-task',
        slot,
        claimed,
        user: claim?.user ?? null,
        taskIds: participant?.tasks ?? [],
        need: claimed ? '协作者回执 {stopped:true,confirmedBy:"负责人"}' : '未认领槽位回执 {unclaimed:true}',
      };
    })
    : [];
  const reviewSummary = metrics.changes === null ? '未核实'
    : `${metrics.changes} 个变更单 / 累计打回 ${metrics.rejects} 次 / 分级合计 P0 ${metrics.grades.p0} · P1 ${metrics.grades.p1} · P2 ${metrics.grades.p2}`;
  const ledgers = ledgerTargets.map((ledger) => {
    const issue = String(ledger.id);
    const slot = ledger.key.startsWith('slot:') ? ledger.key.slice(5) : '主研发';
    const role = { master: '主研发调度', escalation: '主研发' }[ledger.key] ?? '主控';
    const body = [
      `${role} ｜ ${slot} ｜ ${run.controller?.sessionId ?? 'unknown'}`,
      `【完结】${run.req} 已收尾拆架`,
      `- 已合入的变更单：${closingSummary?.changes ?? '未核实'}`,
      `- 终审记录：${reviewSummary}`,
      `- 上线基线：${closingSummary?.baselines ?? '未核实'}`,
    ].join('\n');
    const common = ['--forge', String(run.forge), '--repo', String(ledger.repo), '--id', issue, ...forgeHostArgs(run)];
    return {
      kind: 'issue-close',
      key: ledger.key,
      issue: { repo: ledger.repo, id: ledger.id },
      title: ledger.title,
      body,
      commands: [['issue-comment', ...common, '--body', body], ['issue-close', ...common]],
    };
  });
  const worktrees = (run.worktrees ?? []).map((w) => ({ kind: 'worktree', ...gitStatus(typeof w === 'string' ? w : w.path) }));
  return { residual, tasks, receipts, ledgers, worktrees, closingSummary };
}

function verifyTeardown(check, results, repoResidue, ledgerFacts) {
  const failures = [];
  const need = (kind, id, reason) => failures.push({ kind, id, reason });
  const hasText = (value) => typeof value === 'string' && value.trim() !== '';
  for (const task of check.tasks) {
    const v = results.tasks?.[task.taskId];
    if (v?.stopped !== true && v?.status !== 'stopped') need(task.kind, task.taskId, '定时任务未回执已停用');
  }
  for (const r of check.receipts) {
    const v = results.receipts?.[r.slot];
    const stopped = v?.stopped === true && hasText(v.confirmedBy) && v.unclaimed !== true;
    if (!(stopped || (r.claimed === false && v?.unclaimed === true))) {
      need(r.kind, r.slot, '已认领槽位需负责人确认任务已停用；只有未认领槽位可回执 unclaimed');
    }
  }
  for (const ledger of ledgerFacts.ledgers) {
    if (ledger.state !== 'closed') need('issue-close', ledger.key, `Forge 实查 ${ledger.repo}#${ledger.id} 仍为打开状态，请关闭台账后重试`);
  }
  for (const error of ledgerFacts.errors) {
    const kind = error.source.startsWith('ledger:') ? 'issue-close' : 'forge-facts';
    need(kind, error.source, `Forge 实查失败（${error.code}）：${error.message}`);
  }
  const kept = [];
  for (const wt of check.worktrees) {
    const v = results.worktrees?.[wt.path];
    const current = gitStatus(wt.path);
    if (v?.keep === true) {
      if (!hasText(v.reason) || v.removed === true) need(wt.kind, wt.path, '保留 worktree 必须回执非空原因，且不能同时标为已删除');
      else kept.push({ kind: wt.kind, path: wt.path, status: current.status, reason: v.reason });
    } else if (current.exists) {
      need(wt.kind, wt.path, v?.removed === true ? `回执已删除但目录仍存在（git 状态 ${current.status}）`
        : current.status === 'unknown' ? 'git 状态未知：先核实干净再删除，或保留并说明原因'
          : `worktree 仍存在（${current.status}）：删除或显式保留`);
    } else if (wt.exists) {
      if (v?.removed !== true) need(wt.kind, wt.path, '缺少 worktree 已删除回执');
      else if (wt.dirty === true && v.confirmedDiscard !== true) need(wt.kind, wt.path, '删除有修改的 worktree 缺少 confirmedDiscard');
      else if (wt.dirty === null && v.verifiedClean !== true) need(wt.kind, wt.path, 'git 状态未知的 worktree 缺少 verifiedClean');
    }
  }
  for (const repo of repoResidue) if (repo.agentsMdModified) need('repo', repo.path, '业务仓库 AGENTS.md 有改动残留');
  return { failures, kept };
}

function archiveRunSidecars(file, archivePath, req) {
  const base = file.slice(0, -'.json'.length);
  const archiveDir = archivePath.replace(/\.json$/, '.state');
  const suffixes = ['.outbox.json', ...Object.keys(TASK_DEFS).map((role) => `.tick-state.${role}.json`)];
  for (const suffix of suffixes) {
    const from = base + suffix;
    if (!fs.existsSync(from)) continue;
    // A v2.0 request may have the same name as a sidecar. Leave that run in place.
    let value;
    try { value = readJson(from); } catch (error) {
      if (error.code !== 'INVALID_JSON') throw error;
    }
    if (value?.req) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(from, path.join(archiveDir, safeSlug(req) + suffix));
  }
  for (const journal of [tickHistoryPath(file), reviewJournalPath(file)]) {
    if (!fs.existsSync(journal)) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(journal, path.join(archiveDir, path.basename(journal)));
  }
}

function teardownMetrics(runPath) {
  let reviews;
  try { reviews = readReviews(runPath); } catch { reviews = null; }
  const { scriptComments, tickHistoryError } = readTickHistory(runPath, { requireLog: true });
  const grades = reviews ? reviews.reduce((sum, { verdict }) => ({
    p0: sum.p0 + (verdict?.grades?.p0 ?? 0),
    p1: sum.p1 + (verdict?.grades?.p1 ?? 0),
    p2: sum.p2 + (verdict?.grades?.p2 ?? 0),
  }), { p0: 0, p1: 0, p2: 0 }) : null;
  return {
    changes: reviews ? new Set(reviews.map(({ pr }) => issueRef(pr))).size : null,
    rejects: reviews?.filter(({ verdict }) => verdict?.conclusion === '打回').length ?? null,
    fuses: reviews ? new Set(reviews.filter(({ merge }) => hasRejectFuse(merge)).map(({ pr }) => issueRef(pr))).size : null,
    timeouts: tickHistoryError ? null : scriptComments.filter(({ code }) => code === 'REVIEW_TIMEOUT').length,
    grades,
  };
}

function cmdTeardown(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const file = runFile(configDir, req);
  const teardown = () => executeTeardown(flags, configDir);
  return flags.finalize && fs.existsSync(file) ? withFileLock(tickLockPath(file), teardown) : teardown();
}

function executeTeardown(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const file = runFile(configDir, req);
  const archivePath = path.join(configDir, 'runs', 'archive', `${safeSlug(req)}.json`);
  const finalize = Boolean(flags.finalize);
  if (finalize && !optFlag(flags, 'results')) throw new CliError('MISSING_RESULTS', '拆架归档必须提供 --results <json>');
  if (!fs.existsSync(file)) {
    if (fs.existsSync(archivePath)) {
      const archived = readJson(archivePath).teardown ?? {};
      const retainedItems = archived.retainedItems ?? archived.keptWorktrees ?? [];
      const forcedWaivers = archived.forcedWaivers ?? (archived.forced ? archived.residualAtStart ?? [] : []);
      const unverifiedItems = archived.unverifiedItems ?? [];
      const zeroResidue = archived.zeroResidue === true && !(retainedItems.length || forcedWaivers.length || unverifiedItems.length);
      return { ok: true, status: 'archived', alreadyArchived: true, req, archivePath, retainedItems, forcedWaivers, unverifiedItems, zeroResidue, ...(archived.metrics ? { metrics: archived.metrics } : {}) };
    }
    throw new CliError('RUN_NOT_FOUND', `文件不存在：${file}`);
  }
  const run = readJson(file);
  const prior = run.teardown ?? {};
  if (finalize && (!['planned', 'finalize-failed'].includes(prior.phase) || !prior.checklist)) {
    throw new CliError('TEARDOWN_NOT_PLANNED', '先执行 teardown（不带 --finalize）生成清单，再按清单回执 --finalize');
  }
  const submitted = finalize ? parseJsonArg(flags.results, 'results') : {};
  if (!isPlainObject(submitted)) throw new CliError('INVALID_RESULTS', '--results 必须是对象');
  const results = mergeResults(prior.results, submitted);
  delete results.ledgers;
  const forceNow = !finalize && bool(flags.force, false);
  const forced = forceNow || prior.forced === true;
  // Recheck even a ledger removed from the master table after planning.
  const priorLedgers = (prior.checklist?.ledgers ?? []).flatMap((ledger) => {
    const { flags } = parseArgs(ledger.commands?.find((args) => args[0] === 'issue-close') ?? []);
    return flags.repo && flags.id ? [{ key: ledger.key, repo: flags.repo, issue: { id: flags.id } }] : [];
  });
  const slot = dispatchSlot(run);
  const localLedgerKey = run.tier === 'L3' && slot !== '主研发' ? personalLedgerKey(run.tier, slot) : null;
  const runWithLedgers = { ...run, ledgers: [...(run.ledgers ?? []), ...priorLedgers] };
  const facts = collectRunFacts(runWithLedgers, { includeBaselines: !finalize, localLedgerKey });
  if (localLedgerKey && !facts.ledgers.some(({ key }) => key === localLedgerKey) && !facts.errors.length) {
    facts.errors.push(factFailure('ledger:' + localLedgerKey, new CliError('LEDGER_NOT_BOUND', '无法核实本人已认领的小台账')));
  }
  const factErrors = facts.errors.filter(({ source }) => !source.startsWith('baseline:'));
  if (!finalize && factErrors.length) {
    return {
      ok: false, status: 'incomplete', code: 'TEARDOWN_INCOMPLETE', req, runPath: file, runRetained: true,
      failures: factErrors, membershipWarnings: facts.warnings, message: 'Forge 读取不全，请核实后重试拆架清单。', exitCode: 3,
    };
  }
  const closingSummary = finalize ? prior.checklist.closingSummary : teardownClosingSummary(facts);
  const metrics = teardownMetrics(file);
  const check = teardownChecklist(run, facts, closingSummary, metrics, localLedgerKey);
  if (finalize) {
    if (!localLedgerKey) {
      check.tasks = prior.checklist.tasks;
      check.receipts = [...new Map([...prior.checklist.receipts, ...check.receipts].map((receipt) => [receipt.slot,
        { ...receipt, claimed: receipt.claimed || prior.checklist.receipts.some((prior) => prior.slot === receipt.slot && prior.claimed) },
      ])).values()];
    }
  }
  if (prior.checklist) {
    const probes = new Map(check.worktrees.map((worktree) => [worktree.path, worktree]));
    for (const earlier of prior.checklist.worktrees.filter((item) => item.exists)) {
      const current = probes.get(earlier.path) ?? { kind: 'worktree', ...gitStatus(earlier.path) };
      if (!current.exists) probes.set(earlier.path, earlier);
      else probes.set(earlier.path, current);
    }
    check.worktrees = [...probes.values()];
  }
  const now = new Date().toISOString();

  const waiverKey = (item) => `${item.kind}:${item.ref ?? item.id ?? item.url ?? item.title}`;
  const waiverMap = new Map((prior.forcedWaivers ?? []).map((item) => [waiverKey(item), item]));
  const blocked = check.residual.filter((item) => !waiverMap.has(waiverKey(item)));
  if (blocked.length && !forceNow) {
    writeJson(file, { ...run, teardown: { ...prior, phase: 'blocked', checklist: check }, updatedAt: now });
    return {
      ok: false,
      status: 'blocked',
      req,
      runPath: file,
      runRetained: true,
      blocked,
      membershipWarnings: facts.warnings,
      message: `发现 ${blocked.length} 项未结残留：请先处理，或确认后加 --force 强制收尾。`,
      exitCode: 3,
    };
  }
  if (forceNow) for (const item of blocked) waiverMap.set(waiverKey(item), item);
  const forcedWaivers = [...waiverMap.values()];
  const resultsTemplate = {
    tasks: Object.fromEntries(check.tasks.map((x) => [x.taskId, { stopped: false }])),
    receipts: Object.fromEntries(check.receipts.map((x) => [x.slot, x.claimed ? { stopped: false, confirmedBy: x.user } : { unclaimed: false }])),
    worktrees: Object.fromEntries(check.worktrees.filter((w) => w.exists).map((w) => [w.path, {
      removed: false,
      ...(w.dirty === true ? { confirmedDiscard: false } : {}),
      ...(w.dirty === null ? { verifiedClean: false } : {}),
    }])),
  };

  if (!finalize) {
    writeJson(file, { ...run, teardown: { ...prior, phase: 'planned', forced, forcedWaivers, checklist: check, plannedAt: now, results }, updatedAt: now });
    return {
      ok: true,
      phase: 'planned',
      status: 'planned',
      req,
      runPath: file,
      runRetained: true,
      forced,
      forcedWaivers,
      blockedAtStart: check.residual,
      scheduledTasksToStop: check.tasks,
      receipts: check.receipts,
      closingComments: check.ledgers,
      forgeReadErrors: facts.errors,
      membershipWarnings: facts.warnings,
      worktrees: check.worktrees,
      resultsTemplate,
      next: `逐项执行后：teardown --req ${req} --finalize --results <json>`,
    };
  }

  const primaryKey = primaryLedgerKey(run.tier);
  const primaryLedger = facts.ledgers.find((item) => item.key === primaryKey) ?? null;
  const latestAcc = latestAcceptance(primaryLedger);
  const waiveReason = optFlag(flags, 'waive-acceptance');
  let acceptanceFailure;
  if (!localLedgerKey && acceptanceEnabled(run)) {
    if (latestAcc?.conclusion !== '通过') acceptanceFailure = `最近验收结论为「${latestAcc?.conclusion ?? '无'}」`;
    else if (matchingDeveloperModel(run, latestAcc.model)) acceptanceFailure = `验收模型 ${latestAcc.model} 与本运行态的开发模型相同`;
    else {
      try {
        if (latestAcc.baselineSha !== readAcceptanceBaseline(run)) acceptanceFailure = '最近验收未覆盖当前远端需求基线';
      } catch { acceptanceFailure = '无法核对当前远端需求基线 SHA'; }
    }
  }
  if (acceptanceFailure && !waiveReason) {
    throw new CliError('ACCEPTANCE_REQUIRED',
      flags['waive-acceptance'] !== undefined ? '--waive-acceptance 必须提供放弃验收的原因'
        : `${acceptanceFailure}，须验收通过后再归档，或传 --waive-acceptance <原因>`,
      { req, runPath: file, runRetained: true, latestConclusion: latestAcc?.conclusion ?? null });
  }

  const meFile = findConfigFile(configDir, 'me');
  const projectFile = run.project ? findConfigFile(path.join(configDir, 'projects'), run.project) : null;
  const memoryBefore = { me: fileDigest(meFile), project: fileDigest(projectFile) };
  const repoResidue = (run.repos ?? []).filter((r) => r.path).map((r) => {
    const st = gitStatus(r.path);
    return { repo: r.repo ?? r.name, ...st, agentsMdModified: st.files.some((l) => l.includes('AGENTS.md')) };
  });
  const { failures, kept } = verifyTeardown(check, results, repoResidue, facts);
  if (failures.length) {
    writeJson(file, { ...run, teardown: { ...prior, phase: 'finalize-failed', forced, results, failures, lastAttemptAt: now }, updatedAt: now });
    return {
      ok: false,
      status: 'incomplete',
      code: 'TEARDOWN_INCOMPLETE',
      req,
      runPath: file,
      runRetained: true,
      failures,
      membershipWarnings: facts.warnings,
      resultsTemplate,
      message: failures.length + ' 项未核验通过：运行态保留，处理失败项后重试同一命令。',
      exitCode: 3,
    };
  }
  const unverifiedItems = repoResidue.filter((r) => r.status === 'unknown' || r.status === 'absent')
    .map((r) => ({ kind: 'repo', repo: r.repo, path: r.path, status: r.status }));
  const zeroResidue = !(kept.length || forcedWaivers.length || unverifiedItems.length);
  const archivedAt = new Date().toISOString();
  let acceptanceWaiver = null;
  if (acceptanceFailure && waiveReason) {
    const targetLedger = primaryLedger ?? boundLedger(run, primaryKey);
    if (!targetLedger) throw new CliError('LEDGER_NOT_BOUND', '运行态未绑定主台账，无法记录放弃出口验收');
    const waiverBody = [
      `主控 ｜ ${slot} ｜ ${run.controller?.sessionId ?? 'unknown'}`,
      '【出口验收】放弃验收并归档',
      `放弃原因：${waiveReason}`,
    ].join('\n');
    const posted = postTickComment(run, 'issue', targetLedger, waiverBody, `acceptance-waive:${safeSlug(req)}`);
    acceptanceWaiver = {
      waived: true,
      reason: waiveReason,
      at: archivedAt,
      previousConclusion: latestAcc?.conclusion ?? null,
      commentId: posted?.commentId ?? null,
    };
  }
  writeJson(archivePath, {
    ...run,
    ...(run.acceptance ? { acceptance: { enabled: acceptanceEnabled(run), guide: run.acceptance.guide ?? null } } : {}),
    ...(acceptanceWaiver ? {
      acceptance: { enabled: true, guide: run.acceptance.guide ?? null, waived: true, waiveReason, waivedAt: archivedAt, ...(acceptanceWaiver.commentId ? { waiverCommentId: acceptanceWaiver.commentId } : {}) },
    } : {}),
    status: 'archived',
    archivedAt,
    teardown: {
      phase: 'archived', forced, forcedWaivers, results, residualAtStart: prior.checklist.residual, keptWorktrees: kept,
      retainedItems: kept, unverifiedItems, closingComments: check.ledgers, zeroResidue, metrics,
      ...(acceptanceWaiver ? { acceptanceWaiver } : {}),
    },
  });
  archiveRunSidecars(file, archivePath, req);
  fs.unlinkSync(file);
  const memoryAfter = { me: fileDigest(meFile), project: fileDigest(projectFile) };
  return {
    ok: true,
    phase: 'archived',
    status: 'archived',
    req,
    archivePath,
    archivedAt,
    forced,
    forcedWaivers,
    ...(acceptanceWaiver ? { acceptanceWaiver } : {}),
    residualAtStart: prior.checklist.residual,
    keptWorktrees: kept,
    retainedItems: kept,
    unverifiedItems,
    zeroResidue,
    metrics,
    membershipWarnings: facts.warnings,
    repoResidue,
    memoryPreserved: {
      me: { path: meFile, preserved: memoryBefore.me === memoryAfter.me },
      project: { path: projectFile, preserved: memoryBefore.project === memoryAfter.project },
    },
    note: zeroResidue ? '定时任务、台账、worktree 已逐项核验清理，运行态已归档。'
      : `已归档：保留 ${kept.length} 项、强制豁免 ${forcedWaivers.length} 项、清理状态未核实 ${unverifiedItems.length} 项。`,
  };
}

/* ------------------------------------------------------------------ */
/* status：只读状态与冷启动/下一步导览                                      */
/* ------------------------------------------------------------------ */

const ONBOARDING_QUESTIONS = [
  'Q1 你的称呼/账号名与工作时段（默认 git 用户名、09:00-19:00 Asia/Shanghai）',
  'Q2 本工程是否关联其他仓库（默认单仓；多仓请给关联仓路径或名称）',
  'Q3 本工程本地能否起服务自测（local-test / isolated-build / hybrid）及默认严格度（L1 / L2 / L3）',
  'Q4 写码后是否默认开启跨模型自审（默认开启）',
];

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

function summarizeRunStatus(run, file) {
  const req = run.req;
  const tier = run.tier;
  const stage = run.stage;
  const pendingUpgrade = run.pendingUpgrade
    ? { from: run.pendingUpgrade.from ?? run.tier, to: run.pendingUpgrade.to, plannedAt: run.pendingUpgrade.plannedAt ?? null }
    : null;
  const tdPhase = run.teardown?.phase ?? null;
  const pendingTeardown = tdPhase && tdPhase !== 'archived'
    ? { phase: tdPhase, lastAttemptAt: run.teardown?.lastAttemptAt ?? null }
    : null;

  let nextAction;
  let nextPrompt;
  if (pendingUpgrade) {
    nextAction = `存在未落盘升档（${pendingUpgrade.from}→${pendingUpgrade.to}）：完成外部台账与任务后执行 upgrade --req ${req} --to ${pendingUpgrade.to} --apply`;
    nextPrompt = `$xxn-lite-loop 继续完成 ${req} 从 ${pendingUpgrade.from} 到 ${pendingUpgrade.to} 的升档落盘`;
  } else if (pendingTeardown?.phase === 'blocked') {
    nextAction = `拆架被未结项阻断：先合入/关闭未结 PR/MR 或阻断项，再重跑 teardown`;
    nextPrompt = `$xxn-lite-loop 检查 ${req} 未结项并继续收尾拆架`;
  } else if (pendingTeardown) {
    nextAction = `拆架清单已生成（${pendingTeardown.phase}）：停任务、关台账、清 worktree 后执行 teardown --req ${req} --finalize --results <json>`;
    nextPrompt = `$xxn-lite-loop 提交 ${req} 清理回执并完成归档`;
  } else {
    const upgradeHint = tier === 'L1' ? '从 L1 升档到 L2' : (tier === 'L2' ? '从 L2 升档到 L3' : null);
    nextAction = `${tier} 阶段 ${stage} 运行中（基线 ${run.baselineBranch}）：按台账继续推进当前步骤或送审合入`;
    nextPrompt = upgradeHint
      ? `$xxn-lite-loop 继续推进 ${req}（如需升级：把 ${req} ${upgradeHint}；合完后：收尾拆架）`
      : `$xxn-lite-loop 继续推进 ${req}（全部合入后：收尾拆架）`;
  }
  return {
    req,
    project: run.project ?? null,
    tier,
    stage,
    forge: run.forge ?? null,
    baselineBranch: run.baselineBranch ?? null,
    autoMerge: run.tier === 'L3' && dispatchSlot(run) !== '主研发' ? null : run.autoMerge === true && !protectedMergeBaseline(run),
    repos: (run.repos ?? []).map((r) => r.repo ?? r.name),
    issues: run.issues ?? {},
    runPath: file,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
    pendingUpgrade,
    pendingTeardown,
    ...readTickHistory(file),
    nextAction,
    nextPrompt,
  };
}

function liveStatus(base, input, run, runPath) {
  const facts = !input && run ? collectRunFacts(run) : null;
  if (!facts) return buildLiveStatus(base, input, run, facts);
  try {
    const history = readReviews(runPath);
    for (const change of facts.changes) {
      const records = reviewsFor(history, change);
      change.review = resolveReviewState(records, change.comments, change.headSha);
      change.mergeWaiting = isWaitingMerge(records.at(-1), change);
    }
  } catch (error) {
    facts.errors.push(factFailure('review-journal', error));
  }
  const overview = buildLiveStatus(base, input, run, facts);
  const scriptComments = [];
  for (const [kind, items] of [['issue', [...facts.ledgers, ...facts.subIssues]], ['change', facts.changes]]) {
    for (const item of items) {
      for (const note of item.comments) {
        const [signature, reason] = note.body.split(/\r?\n/, 2);
        if (!/^巡检脚本 ｜ [^｜]+ ｜ \S+$/.test(signature) && !(note.liteloopKey && / ｜ tick:\S+$/.test(signature))) continue;
        scriptComments.push({ kind, repo: item.repo, id: item.id, commentId: note.id, at: note.createdAt, signature, reason });
      }
    }
  }
  scriptComments.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.commentId - a.commentId);
  return { ...overview, forgeFacts: facts, scriptComments };
}

function cmdStatus(flags, configDir) {
  const meFile = findConfigFile(configDir, 'me');
  const projects = listProjectSlugs(configDir);
  const needsOnboarding = !meFile || projects.length === 0;
  const req = optFlag(flags, 'req') ?? optFlag(flags, 'run');
  const liveArg = optFlag(flags, 'live-input') ?? optFlag(flags, 'live');
  const asJson = flags.json === true;
  const showLive = Boolean(flags.live || liveArg);
  const live = liveArg ? parseJsonArg(liveArg, 'live-input') : null;
  if (liveArg && !isPlainObject(live)) throw new CliError('INVALID_JSON', '--live-input 必须是 JSON 对象');
  const liveReq = live?.req ?? null;
  if (req && liveReq !== null && liveReq !== req) {
    throw new CliError('LIVE_REQ_CONFLICT', 'live 输入的 req 与 --req 不一致', { req, liveReq });
  }
  const present = (base, run) => {
    const useLive = showLive || (!asJson && run?.forge);
    const runPath = base.run?.runPath ?? base.activeRuns?.find(({ req }) => req === run?.req)?.runPath;
    const result = useLive ? { ...base, live: liveStatus(base, live, run, runPath) } : base;
    if (useLive && run?.tier === 'L3' && dispatchSlot(run) !== '主研发') {
      const master = result.live?.forgeFacts?.ledgers.find(({ key }) => key === 'master');
      const autoMerge = mergeModeFromMaster(run, master);
      if (base.run) result.run = { ...base.run, autoMerge };
      else result.activeRuns = base.activeRuns.map((summary) => summary.req === run.req ? { ...summary, autoMerge } : summary);
    }
    return asJson ? result : formatStatus(result, run);
  };

  if (req) {
    const file = runFile(configDir, req);
    if (fs.existsSync(file)) {
      const rawRun = readJson(file);
      const result = {
        ok: true,
        readOnly: true,
        state: 'active',
        needsOnboarding,
        meConfigured: Boolean(meFile),
        projects,
        run: summarizeRunStatus(rawRun, file),
      };
      return present(result, rawRun);
    }
    const archivePath = path.join(configDir, 'runs', 'archive', `${safeSlug(req)}.json`);
    if (fs.existsSync(archivePath)) {
      const archived = readJson(archivePath);
      const result = {
        ok: true,
        readOnly: true,
        state: 'archived',
        req,
        archivePath,
        archivedAt: archived.archivedAt ?? null,
        zeroResidue: archived.teardown?.zeroResidue ?? false,
        nextAction: '该需求已完成拆架归档，无需继续处理。',
        nextPrompt: '$xxn-lite-loop <一句话描述你的下一个新需求>',
      };
      return asJson ? result : formatStatus(result, archived);
    }
    throw new CliError('RUN_NOT_FOUND', `未找到运行态或归档记录：${req}`);
  }

  const runsDir = path.join(configDir, 'runs');
  const activeRuns = [];
  const rawRuns = new Map();
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir).sort()) {
      if (!name.endsWith('.json') || isRunSidecar(name)) continue;
      const full = path.join(runsDir, name);
      if (!fs.statSync(full).isFile()) continue;
      const rawRun = readJson(full);
      const summary = summarizeRunStatus(rawRun, full);
      activeRuns.push(summary);
      if (showLive || !asJson) rawRuns.set(summary.req, rawRun);
    }
  }
  const archiveDir = path.join(runsDir, 'archive');
  const archivedCount = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((n) => n.endsWith('.json')).length
    : 0;

  let nextAction;
  let nextPrompt;
  if (needsOnboarding) {
    nextAction = '本机尚未完成初始配置：请按 4 题冷启动向导一次问清后自动生成 me.yaml 与工程档案（绝不让用户手写 YAML）。';
    nextPrompt = '$xxn-lite-loop <一句话描述你要做的需求>';
  } else if (activeRuns.length > 0) {
    nextAction = `当前有 ${activeRuns.length} 个进行中的需求，优先处理待落盘升档/拆架或继续推进活动台账。`;
    nextPrompt = activeRuns[0].nextPrompt;
  } else {
    nextAction = '本机配置已就绪，当前无进行中的需求。';
    nextPrompt = '$xxn-lite-loop <一句话描述你要做的需求>';
  }

  const baseResult = {
    ok: true,
    readOnly: true,
    configDir,
    meConfigured: Boolean(meFile),
    meFile,
    projects,
    needsOnboarding,
    ...(needsOnboarding ? { onboardingQuestions: ONBOARDING_QUESTIONS } : {}),
    activeRuns,
    archivedCount,
    nextAction,
    nextPrompt,
  };
  if (liveReq !== null && !rawRuns.has(liveReq)) {
    throw new CliError('LIVE_REQ_NOT_FOUND', 'live 输入的 req 未匹配任何活跃需求', { liveReq });
  }
  return present(baseResult, rawRuns.get(liveReq ?? activeRuns[0]?.req) ?? null);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                  */
/* ------------------------------------------------------------------ */

function tickOperations(req, configDir) {
  return {
    req, configDir, readJson, writeJson, workWindow, mentionWindow, windowAt, hm, workHoursBetween, addWorkingHours, ledgerSection, personalLedgerKey,
    evalWakeDecision, evalSmallPatrol, evalLeadPatrol, defaults: THRESHOLD_DEFAULTS,
  };
}

function cmdTick(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const role = requireFlag(flags, 'role');
  const now = optFlag(flags, 'now');
  const session = flags.session === undefined ? null : requireFlag(flags, 'session');
  return tick(runFile(configDir, req), role, flags.apply === true, now ? parseInstant(now, 'now') : Date.now(), tickOperations(req, configDir), session);
}

function matchNotifyMembers(run, members) {
  const participants = new Map([[run.user, run.user]]);
  for (const member of [...(run.ledgers ?? []), ...(run.participants ?? [])]) {
    if (!member?.user || member.claimed === false) continue;
    participants.set(member.user, member.displayName ?? member.name ?? member.user);
  }
  if (run.tier === 'L3' && boundLedger(run, 'master')) {
    const facts = readSlotClaimFacts(run);
    const claims = forgeSlotClaims(facts);
    for (const slot of new Set(claims.map(({ slot }) => slot))) {
      const winner = activeSlotClaims(claims, slot)[0];
      if (!winner?.user || participants.has(winner.user)) continue;
      const displayName = facts.slotLedgers.find((entry) => slotKey(entry.slot) === slot)?.user;
      participants.set(winner.user, displayName && !/^(无|-|待认领)$/.test(displayName) ? displayName : winner.user);
    }
  }
  const people = [...participants].filter(([user]) => typeof user === 'string' && user)
    .map(([user, name]) => [user, String(name).trim()]);
  const matches = [];
  const unmatchedMembers = [];
  for (const [user, name] of people) {
    const matching = new Set(members.filter((member) => member?.name?.trim() === name && /^ou_[a-z0-9_]+$/i.test(member.member_id))
      .map((member) => member.member_id));
    const ambiguous = matching.size > 1 || people.some(([other, theirName]) => other !== user && theirName === name);
    if (matching.size === 1 && !ambiguous) matches.push([user, [...matching][0]]);
    else unmatchedMembers.push({ user, name, reason: ambiguous ? '同名，无法唯一匹配' : '群成员中未找到同名用户' });
  }
  return { memberOpenIds: Object.fromEntries(matches), unmatchedMembers };
}

function assertL1AutoMerge(run) {
  const facts = collectRunFacts(run);
  if (facts.errors.length) throw new CliError('FORGE_FACTS_UNAVAILABLE', '无法核实 L1 需求的变更单，当前使用人工合并', { errors: facts.errors });
  if (facts.changes.filter(({ state, draft }) => !draft && ['open', 'merged'].includes(state)).length < 2) {
    throw new CliError('L1_AUTO_MERGE_REQUIRES_MULTIPLE_CHANGES', 'L1 须拆成多个变更单并使用独立需求基线，才能开启自动合并');
  }
}

function cmdMergeMode(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const autoMerge = flags.auto === true;
  if (autoMerge ? flags.manual !== undefined : flags.manual !== true || flags.auto !== undefined) {
    throw new CliError('INVALID_MERGE_MODE', '请选择 --manual 或 --auto');
  }
  const file = runFile(configDir, req);
  return withFileLock(tickLockPath(file), () => {
    const run = readJson(file, 'RUN_NOT_FOUND');
    if (run.status === 'archived') throw new CliError('RUN_ARCHIVED', '该需求已归档');
    const slot = dispatchSlot(run);
    if (run.tier === 'L3' && slot !== '主研发') {
      throw new CliError('MERGE_ROLE_FORBIDDEN', 'L3 由主研发切换合并方式');
    }
    if (autoMerge && protectedMergeBaseline(run)) {
      throw new CliError('ENV_BRANCH_FORBIDDEN', '需求基线是受保护分支，请使用全人工合并');
    }
    if (autoMerge && run.tier === 'L1') assertL1AutoMerge(run);
    const changed = run.autoMerge !== autoMerge || run.autoMergeConfigured !== true;
    if (!changed) return { ok: true, req, autoMerge, changed };
    const ledger = boundLedger(run, personalLedgerKey(run.tier, slot));
    if (!ledger) throw new CliError('LEDGER_NOT_BOUND', '请先绑定本人台账，以记录合并方式变更');
    if (readForgeIssueState(run, ledger.repo, ledger.id, { rejectConflictingLabels: true }) !== 'open') {
      throw new CliError('LEDGER_CLOSED', '本人台账已关闭，无法记录合并方式变更');
    }
    const code = autoMerge ? 'MERGE_MODE_AUTO' : 'MERGE_MODE_MANUAL';
    const key = `merge-mode:${req}:${fs.statSync(file, { bigint: true }).mtimeNs}:${autoMerge}`;
    const body = formatScriptComment(slot, code, '【配置变更】');
    const master = run.tier === 'L3' ? boundLedger(run, 'master') : null;
    if (run.tier === 'L3' && (!master || readForgeIssueState(run, master.repo, master.id, { rejectConflictingLabels: true }) !== 'open')) {
      throw new CliError('LEDGER_NOT_BOUND', '请先绑定开放的总台账，以同步主研发的合并方式');
    }
    const posted = postTickComment(run, 'issue', ledger, body, key);
    if (master) postTickComment(run, 'issue', master, body, key);
    writeJson(file, { ...run, autoMerge, autoMergeConfigured: true });
    return { ok: true, req, autoMerge, changed, ledger: { ...ledger, ...posted } };
  });
}

function notifyLedger(run, scope, action) {
  const slot = run.slot ?? run.scheduledTasks?.find((task) => task.role === 'patrol')?.ledgerKey?.match(/^slot:(.+)$/)?.[1] ?? '主研发';
  const personal = run.tier === 'L3' ? `slot:${slot}` : personalLedgerKey(run.tier);
  const keys = run.tier === 'L3' && scope === 'run' && action === 'bind' ? ['master']
    : scope === 'project' && run.tier === 'L3' ? ['master', personal] : [personal, 'master'];
  for (const key of keys) {
    const ledger = boundLedger(run, key);
    if (ledger) return { ...ledger, slot };
  }
  throw new CliError('LEDGER_NOT_BOUND', '请先将需求绑定到 Git 台账，以记录通知配置变更');
}

const NOTIFY_CONFIG_CODES = { bind: 'NOTIFY_BIND', unbind: 'NOTIFY_UNBIND', mute: 'NOTIFY_MUTE', unmute: 'NOTIFY_UNMUTE' };

function updateNotifyConfig(sub, flags, configDir) {
  const req = requireFlag(flags, 'req');
  const scope = flags.scope === undefined ? 'run' : requireFlag(flags, 'scope');
  if (!['run', 'project'].includes(scope)) throw new CliError('INVALID_NOTIFY_SCOPE', '--scope 必须是 run 或 project');
  const chat = sub === 'bind' ? requireFlag(flags, 'chat').trim() : null;
  const runPath = runFile(configDir, req);
  return withFileLock(tickLockPath(runPath), () => {
    const run = readJson(runPath, 'RUN_NOT_FOUND');
    if (run.status === 'archived') throw new CliError('RUN_ARCHIVED', '该需求已归档');
    if (sub === 'bind' && run.tier === 'L1' && scope === 'run') {
      throw new CliError('NOTIFY_GROUP_UNAVAILABLE', 'L1 只有会话通知。可用 --scope project 为后续 L2/L3 需求设置工程默认群。');
    }
    const file = scope === 'run' ? runPath : run.project && findConfigFile(path.join(configDir, 'projects'), safeSlug(run.project));
    if (!file) throw new CliError('PROJECT_CONFIG_NOT_FOUND', '运行态关联的工程档案不存在');
    const update = () => {
      const current = scope === 'run' ? run : loadConfigFile(file);
      const notify = { ...current.notify };
      const code = NOTIFY_CONFIG_CODES[sub];
      const group = sub === 'bind' ? verifyGroup(chat) : null;
      const { memberOpenIds, unmatchedMembers } = group ? matchNotifyMembers(run, group.members) : {};
      if (group) Object.assign(notify, { feishuGroupChatId: group.chatId, memberOpenIds });
      else if (sub === 'unbind') {
        notify.feishuGroupChatId = null;
        if (current.notify?.feishuGroupChatId || scope === 'project') notify.memberOpenIds = {};
      } else notify.externalNotifyDisabled = sub === 'mute';

      const changed = !isDeepStrictEqual(current.notify ?? {}, notify);
      const result = {
        ok: true, req, scope, changed, action: sub, muted: notify.externalNotifyDisabled === true,
        chatId: notify.feishuGroupChatId ?? null, ...(group ? { chatName: group.name, matchedCount: Object.keys(memberOpenIds).length, unmatchedMembers } : {}),
      };
      if (!changed) return result;
      const desired = { ...current, notify };
      const projectText = scope === 'project' ? projectNotifyText(file, desired) : null;
      const ledger = notifyLedger(run, scope, sub);
      if (readForgeIssueState(run, ledger.repo, ledger.id) !== 'open') throw new CliError('LEDGER_CLOSED', '台账已关闭，无法记录通知配置变更');
      const version = fs.statSync(file, { bigint: true }).mtimeNs.toString();
      const key = 'notify-config:' + crypto.createHash('sha256').update(JSON.stringify([scope, scope === 'project' ? run.project : req, version, sub, notify]))
        .digest('hex').slice(0, 24);
      const target = scope === 'run' ? '仅本次需求' : '工程默认值，后续需求使用';
      const clean = (value) => String(value).replace(/[\r\n<>]/g, ' ').slice(0, 120);
      const detail = group ? ` ｜ 群：${clean(group.name)} ｜ 已匹配 ${result.matchedCount} 人 ｜ 未匹配：${unmatchedMembers.map(({ name }) => clean(name)).join('、') || '无'}` : '';
      const body = formatScriptComment(ledger.slot, code, `【配置变更】范围：${target}${detail}`);
      const posted = postTickComment(run, 'issue', ledger, body, key);
      // 先留下用户确认的操作，再写本机。重试同一次写入复用同一个评论去重键。
      if (scope === 'run') writeJson(file, desired);
      else writeAtomic(file, projectText);
      return { ...result, ledger: { repo: ledger.repo, id: ledger.id, ...posted } };
    };
    return scope === 'project' ? withFileLock(file + '.notify.lock', update) : update();
  });
}

function cmdNotify(flags, configDir, positional) {
  const sub = positional[1];
  const configCommands = ['bind', 'unbind', 'mute', 'unmute'];
  if (![...configCommands, 'enqueue', 'confirm', 'flush'].includes(sub)) {
    throw new CliError('INVALID_NOTIFY_COMMAND', 'notify 子命令必须是 bind、unbind、mute、unmute、enqueue、confirm 或 flush');
  }
  const rawNow = optFlag(flags, 'now');
  const nowMs = rawNow ? parseInstant(rawNow, 'now') : Date.now();
  const lib = { readJson, writeJson, workWindow, mentionWindow, windowAt, addWorkingHours };
  if (configCommands.includes(sub)) return updateNotifyConfig(sub, flags, configDir);
  const useOutbox = (file, operation) => runNotification(file, nowMs, lib, operation);
  if (sub === 'enqueue') {
    const file = runFile(configDir, requireFlag(flags, 'req'));
    const kind = requireFlag(flags, 'kind');
    const dedupKey = requireFlag(flags, 'dedup');
    const text = requireFlag(flags, 'text');
    return useOutbox(file, (outbox) => ({
      ok: true, ...outbox.enqueue({ kind, dedupKey, text, confirmRequired: flags['confirm-required'] === true }),
    }));
  }
  if (sub === 'confirm') {
    const file = runFile(configDir, requireFlag(flags, 'req'));
    const id = requireFlag(flags, 'id');
    return useOutbox(file, (outbox) => ({ ok: true, event: outbox.confirm(id) }));
  }
  const req = optFlag(flags, 'req');
  const all = flags.all === true;
  if (Boolean(req) === all) throw new CliError('INVALID_NOTIFY_SCOPE', 'notify flush 必须择一提供 --req <slug> 或 --all');
  const flush = (file) => useOutbox(file, (outbox, run) => ({
    req: run.req, actions: outbox.flush(true, true, patrolAlertStatus(file, nowMs, tickOperations(run.req, configDir), run)),
  }));
  if (req) return { ok: true, runs: [flush(runFile(configDir, req))] };
  const dir = path.join(configDir, 'runs');
  const runs = [];
  const errors = [];
  const names = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  for (const name of names.filter((entry) => entry.isFile() && entry.name.endsWith('.outbox.json')).map((entry) => entry.name).sort()) {
    const base = name.slice(0, -'.outbox.json'.length);
    const file = path.join(dir, base + '.json');
    if (!fs.existsSync(file)) continue;
    try {
      runs.push(flush(file));
    } catch (error) {
      if (error.code === 'RUN_ARCHIVED') continue;
      errors.push({ req: base, code: error.code ?? 'UNEXPECTED_ERROR', message: error.message });
    }
  }
  return { ok: errors.length === 0, runs, ...(errors.length ? { errors, exitCode: 2 } : {}) };
}

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIEF_ROLES = {
  planner: { label: '拆分', anchor: 'planner' },
  coder: { label: '开发', anchor: 'coder' },
  selfReviewer: { label: '自审', anchor: 'self-reviewer', guarded: true },
  finalReviewer: { label: '终审', anchor: 'final-reviewer', guarded: true },
  acceptor: { label: '验收者', anchor: 'acceptor', guarded: true },
};

function briefRef(run, raw, kind, registered) {
  const key = `--${kind}`;
  const ref = parseDepRef(/^\d+$/.test(raw) ? `#${raw}` : raw, null, run.forge, kind);
  if (!ref || !Number.isSafeInteger(ref.id)) throw new CliError(kind === 'issue' ? 'INVALID_ISSUE' : 'INVALID_CHANGE', `${key} 须为编号、带仓库的引用或完整链接`);
  const hub = run.hubRepo?.repo;
  const known = registered.filter((item) => Number(issueNumber(item?.id ?? item)) === ref.id).map((item) => item?.repo ?? hub);
  const repos = known.length ? known : [hub, ...(run.repos ?? []).map(({ repo }) => repo)];
  const unique = new Map(repos.filter(Boolean).map((repo) => [repo.toLowerCase(), repo]));
  const repo = ref.repo ?? (unique.size === 1 ? unique.values().next().value : null);
  if (!repo) throw new CliError('AMBIGUOUS_REF', `${key} ${raw} 无法确定所属仓库，请传带仓库的引用或完整链接`);
  const url = forgeRecordUrl(run, { repo, id: ref.id, kind });
  if (ref.forge !== run.forge || (ref.host && ref.host !== new URL(url).host.toLowerCase())) {
    throw new CliError('FORGE_NOT_IN_RUN', `${key} 的 Forge 与需求运行态不一致`);
  }
  return { repo, id: ref.id, url };
}

function fetchBaselineSha(repoPath, baselineBranch) {
  const dir = repoPath && baselineBranch ? path.resolve(expandHome(repoPath)) : null;
  if (!dir || !fs.existsSync(dir)) return '未取到';
  const opts = { encoding: 'utf8', timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
  const fetched = spawnSync('git', ['-C', dir, 'fetch', '--no-tags', 'origin', `+refs/heads/${baselineBranch}:refs/remotes/origin/${baselineBranch}`], opts);
  if (fetched.status !== 0) return '未取到';
  const rev = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', `refs/remotes/origin/${baselineBranch}`], opts);
  const sha = (rev.stdout ?? '').trim();
  return rev.status === 0 && FULL_SHA.test(sha) ? sha : '未取到';
}

function cmdBrief(flags) {
  const runArg = requireFlag(flags, 'run');
  const role = requireFlag(flags, 'role');
  const issue = requireFlag(flags, 'issue');
  const roleMeta = BRIEF_ROLES[role];
  if (!roleMeta) throw new CliError('INVALID_ROLE', `--role 必须是 ${Object.keys(BRIEF_ROLES).join('|')}，收到：${role}`);

  if (!runArg.endsWith('.json')) throw new CliError('INVALID_RUN', '--run 必须指向需求运行态 JSON');
  const runPath = path.resolve(expandHome(runArg));
  const run = readJson(runPath, 'RUN_NOT_FOUND');
  const ledgerRefs = (run.ledgers ?? []).map(({ key }) => boundLedger(run, key));
  const issueRef = briefRef(run, issue, 'issue', [...registeredDemandIssues(run), ...Object.values(run.issues ?? {}), ...ledgerRefs]);
  const changeArg = optFlag(flags, 'change');
  const reviews = changeArg ? readReviews(runPath) : [];
  const changeRef = changeArg ? briefRef(run, changeArg, 'change', [...(run.changes ?? []), ...reviews.map(({ pr }) => pr)]) : null;
  const changeReviews = changeRef ? reviewsFor(reviews, changeRef) : [];
  const activeDispatch = changeReviews.at(-1) && !changeReviews.at(-1).verdict ? changeReviews.at(-1) : null;
  const reviewState = changeRef ? resolveReviewState(changeReviews, [], null) : null;
  const rejectCount = changeRef
    ? (Array.isArray(activeDispatch?.rejectDispatchIds)
      ? activeDispatch.rejectDispatchIds.length
      : reviewState.rejectCount)
    : 0;
  const dispatchRound = activeDispatch?.round ?? reviewState?.round ?? 1;
  const fuseCount = run.thresholds?.rejectFuseCount ?? 2;
  const fullReReview = Boolean(changeRef && rejectCount >= fuseCount);

  const models = run.roleModels ?? {};
  const coderModel = normModel(models.coder);
  const escalationModel = normModel(models.coderEscalation);
  const escalated = Boolean(changeRef && rejectCount >= 1 && escalationModel);

  let modelLine;
  if (role === 'coder') {
    modelLine = escalated
      ? `${escalationModel}（升档：变更单已打回 ${rejectCount} 次，由 ${coderModel || '未配置'} 升档至 coderEscalation）`
      : (coderModel || '未配置');
  } else {
    const roleModel = normModel(models[role]);
    const conflict = roleMeta.guarded && roleModel
      ? (sameModel(roleModel, coderModel) ? ['开发模型（coder）', coderModel]
        : (escalated || role === 'acceptor') && sameModel(roleModel, escalationModel) ? ['升档开发模型（coderEscalation）', escalationModel] : null)
      : null;
    if (conflict) {
      throw new CliError('SAME_MODEL_AS_CODER', `${roleMeta.label}（${role}）模型 ${roleModel} 与${conflict[0]}相同`, {
        role, model: roleModel, coderModel: conflict[1], escalated,
      });
    }
    modelLine = roleModel || '未配置';
  }

  const repo = changeRef?.repo ?? issueRef.repo;
  const entry = (run.repos ?? []).find((item) => item.repo?.toLowerCase() === repo.toLowerCase())
    ?? (run.hubRepo?.repo?.toLowerCase() === repo.toLowerCase() ? run.hubRepo : null);
  const baseline = run.baselineBranch ?? run.branch ?? null;

  const reviewScopeLine = role === 'finalReviewer' && changeRef
    ? (fullReReview
      ? `终审口径：已熔断（已打回 ${rejectCount} 次，fullReReview=true，全量复审）；仅允许就 P0/P1 打回，P2 只能写进 --remaining 遗留建议（只剩 P2 请给「通过」），通过后仍交人裁决`
      : rejectCount === 0
        ? `终审口径：尚未打回（第 ${dispatchRound} 次派审，fullReReview=false）：全单深审，P0/P1/P2 均可打回，问题尽量一次挖透；熔断后（累计打回 ≥ ${fuseCount} 次）P2 只能写进 --remaining 遗留建议`
        : `终审口径：已打回 ${rejectCount} 次、未熔断（fullReReview=false）：核上轮必改项与直接影响面，P0/P1/P2 均可打回，问题尽量一次挖透；熔断后（累计打回 ≥ ${fuseCount} 次）P2 只能写进 --remaining 遗留建议`)
    : null;

  return [
    `开工前先读 ${path.join(SKILL_ROOT, 'references', 'roles.md')}#${roleMeta.anchor}`,
    `需求：${run.req ?? '未配置'}`,
    `子 Issue：#${issueRef.id}（${issueRef.url}）`,
    ...(changeRef ? [`变更单：${changeRef.url}${rejectCount > 0 ? `（已打回 ${rejectCount} 次）` : ''}`] : []),
    ...(reviewScopeLine ? [reviewScopeLine] : []),
    `仓库：${repo}`,
    `基线分支：${baseline ?? '未配置'}`,
    `基线 SHA：${fetchBaselineSha(entry?.path, baseline)}`,
    `角色：${roleMeta.label}（${role}）`,
    `模型：${modelLine}`,
    '项目有工程规范（AGENTS.md、CLAUDE.md、CONTRIBUTING 等）时以项目规范为准',
  ].join('\n');
}

function usage() {
  return {
    ok: true,
    name: SKILL_NAME,
    version: VERSION,
    commands: [
      'doctor [--project <slug>] [--cwd <dir>] [--hostname <host>]            # 只读 6 项环境体检，返回支持档位 L1/L2/L3',
      'ledger-lint (--body <text>|--file <path>) [--tier L1|L2|L3] [--kind personal|master] [--max-lines 80]',
      'status [--req <slug>] [--json] [--live] [--live-input <json>] # 查看需求进展，--json 输出机器可读数据，配 --live 实查代码平台',
      'config-resolve --project <slug> [--tier L1|L2|L3] [--overrides <json>]',
      'preview-init --req <slug> --project <slug> [--tier ..] [--stage P0..P3] [--repos a,b] [--branch <br>] [--slots 主研发,A] [--slot <本机槽位>] [--overrides <json>]',
      'init --req <slug> --project <slug> [同 preview-init] [--issue-map <json>] [--session <id>] [--resume]',
      'init --req <slug> --resume [--issue-map <json>] [--session <现任主控会话标识>]',
      'upgrade --req|--run <slug> --to L2|L3 [--slots a,b]            # 出计划，写 pendingUpgrade',
      'upgrade --req <slug> --to L2|L3 --apply [--issue-map <json>] [--results <json>]  # 逐项回执后落盘',
      'tick --req <slug> --role controller|dispatch|patrol|lead-patrol [--apply] [--now <iso>] [--session <主控会话标识>]',
      'merge-mode --req <slug> --manual|--auto',
      'notify bind --req <slug> --chat <群名或chat_id> [--scope run|project]',
      'notify unbind|mute|unmute --req <slug> [--scope run|project]',
      'notify enqueue --req <slug> --kind daily|alert|contract-sync --dedup <key> --text <text> [--confirm-required]',
      'notify confirm --req <slug> --id <id>',
      'notify flush (--req <slug> | --all)',
      'wake-decision --input <json>   # 含 now/workHours/trigger 时非工作时段只心跳',
      'slot-claim --req <slug> --slot <槽位> [--master <总台账 URL> --session <id>（首次加入）]',
      'brief --run <run.json> --role planner|coder|selfReviewer|finalReviewer|acceptor --issue <编号或链接> [--change <PR/MR编号>]',
      'teardown --req <slug> [--force]      # 第 1 步：出清单，保留 run',
      'teardown --req <slug> --finalize --results <json> [--waive-acceptance <原因>]    # 第 2 步：逐项核验后归档',
    ],
    globalFlags: ['--config-dir <dir>（默认 ~/.config/dev-loop，测试必须隔离）'],
  };
}

const COMMANDS = {
  doctor: (flags, configDir) => runDoctor(flags, configDir),
  'ledger-lint': (flags) => runLedgerLint(flags),
  status: cmdStatus,
  'config-resolve': cmdConfigResolve,
  'preview-init': cmdPreviewInit,
  init: cmdInit,
  upgrade: cmdUpgrade,
  tick: cmdTick,
  'merge-mode': cmdMergeMode,
  notify: cmdNotify,
  'wake-decision': (flags) => evalWakeDecision(parseJsonArg(flags.input, 'input')),
  'slot-claim': cmdSlotClaim,
  brief: cmdBrief,
  teardown: cmdTeardown,
};

function main(flags, positional) {
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.help) return usage();
  const handler = COMMANDS[cmd];
  if (!handler) throw new CliError('UNKNOWN_COMMAND', `未知子命令：${cmd}`, { commands: usage().commands });
  return handler(flags, configPath(optFlag(flags, 'config-dir')), positional);
}

const { flags, positional } = parseArgs(process.argv.slice(2));
try {
  const result = main(flags, positional);
  if (typeof result === 'string') {
    process.stdout.write(`${result}\n`);
  } else if (result) {
    const { exitCode, ...payload } = result;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = Number(exitCode ?? 0);
  }
} catch (err) {
  if (positional[0] === 'status' && flags.json !== true) process.stderr.write(`${err.message}\n`);
  else process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? 'UNEXPECTED_ERROR', message: err.message, ...(err.extra ?? {}) }, null, 2)}\n`);
  process.exitCode = 2;
}
