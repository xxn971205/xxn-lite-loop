#!/usr/bin/env node
/**
 * loopctl.mjs — xxn-lite-loop 配置引擎、状态判定、平滑升档与收尾拆架 CLI。
 *
 * 零依赖 Node.js ESM（Node 20+），不读写任何业务仓库，
 * 所有长期配置与临时运行态都落在 --config-dir（默认 ~/.config/dev-loop）。
 *
 * 子命令：
 *   config-resolve  四级配置合并（tiers.md 默认 < me < projects/<slug> < overrides）
 *   preview-init    6 行确认单 + 应建台账/定时任务/标签清单（与 init 共用 buildRunSpec）
 *   init            写入 runs/<req>.json（已存在默认拒绝，--resume 读回）
 *   upgrade         L1→L2→L3 逐级升档：默认出计划，--apply 逐项回执后落盘
 *   wake-decision   唤醒判定 + 工作时段心跳限权 + 接任首轮边界 + 写前校验
 *   eval-review     终审结论分流：k≥2 熔断、6 条风险、环境分支、head SHA、Depends-On
 *   eval-patrol     小巡检 / 大巡检判定（工作分钟计时、去重键、群 @ 护栏）
 *   slot-claim      L3 抢槽：按槽位过滤「最早未撤回绑定」胜出
 *   teardown        两步拆架：默认出清单保留 run，--finalize 逐项核验后归档
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  TRACKING_SECTIONS,
  PERSONAL_SECTIONS,
  countLedgerLines,
  ledgerSection,
  labelNames,
  splitPatterns,
  runDoctor,
  runLedgerLint,
  runTransitionCheck,
  checkPersonalPolicyOverride,
  buildLiveStatus,
} from './guard.mjs';
import { runRetro } from './retro.mjs';

const VERSION = '2.0.0';
const SKILL_NAME = 'xxn-lite-loop';
const WORKDAY_HOURS = 8;
const PROD_TRUNKS = ['main', 'master'];
const ENV_BRANCHES = ['main', 'master', 'test', 'uat'];
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
  handoffGraceCycles: 2,
  confirmTimeoutHours: 4,
  correctionTimeoutHours: 2,
  ledgerMaxLines: 80,
  ledgerStaleWorkdays: 1,
  mrIdleWarnHours: 4,
  mrIdleEscalateHours: 8,
  p3PauseMaxHours: 8,
  p3SilentMaxHours: 8,
  reviewStaleHours: 2,
  reviewWaitWarnHours: 24,
  blockEscalateHours: 4,
  rejectFuseCount: 2,
  changeGranularity: '1-3',
  externalMentionWindow: '09:00-19:00',
};

const L2_THRESHOLDS = [
  'controllerLoopMinutes', 'smallPatrolMinutes', 'stuckHours', 'disconnectCycles', 'handoffGraceCycles',
  'confirmTimeoutHours', 'correctionTimeoutHours', 'ledgerMaxLines', 'ledgerStaleWorkdays', 'mrIdleWarnHours',
  'reviewStaleHours', 'reviewWaitWarnHours', 'rejectFuseCount', 'changeGranularity',
];

const TIER_PROFILES = {
  L1: {
    label: 'L1 · 极轻档（Sprint）',
    ledgerMode: 'single',
    tasks: [],
    labels: ['待终审', '终审中', '待合并', '需修改', '风险高', '风险低'],
    activeThresholds: ['reviewStaleHours', 'rejectFuseCount'],
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
    tasks: ['controller', 'patrol', 'dispatch', 'lead-patrol', 'lead-daily'],
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
  'lead-daily': { title: '每日日报', daily: true, ledger: 'master', entryDoc: 'references/patrol-and-notify.md' },
};

const RISK_RULES = [
  { key: 'contract', label: '涉及契约字段或对外接口（含 MQ、RPC/Dubbo、OpenAPI）' },
  { key: 'hotFile', label: '修改公共热点文件或其他槽位持有文件的已有内容（末尾声明追加不算）' },
  { key: 'migration', label: '数据表结构或存量数据迁移变更' },
  { key: 'switchDefault', label: '改变开关默认值，或改写开关关闭时会执行的存量逻辑' },
  { key: 'signature', label: '修改其他槽位或关联仓会调用的接口/方法签名' },
  { key: 'foundation', label: '地基 PR/MR 或共用构建配置（如根 pom.xml / 顶层依赖锁文件）' },
];

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const BOOLEAN_FLAGS = new Set(['force', 'help', 'plan', 'finalize', 'apply', 'resume']);

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

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveConfigDir(flags) {
  const dir = optFlag(flags, 'config-dir') ?? process.env.XXN_LITE_LOOP_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'dev-loop');
  return path.resolve(expandHome(dir));
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

function safeSlug(value) {
  const s = String(value ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/\.{2,}/g, '.');
  return s.replace(/^[.-]+|[.-]+$/g, '') || 'req';
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

/** 同目录临时文件保证读取者只会看到完整 JSON；首次创建用硬链接原子判重。 */
function writeJson(file, payload, { create = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    if (create) fs.linkSync(tmp, file);
    else fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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

function runFile(configDir, req) {
  return path.join(configDir, 'runs', `${safeSlug(req)}.json`);
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
      if (c === quote) quote = null;
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

/* ------------------------------------------------------------------ */
/* 时区、时间窗与工作分钟（wake-decision 与 eval-patrol 共用）              */
/* ------------------------------------------------------------------ */

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

function compileBranchPattern(pattern) {
  const raw = String(pattern ?? '').trim();
  if (!raw) throw new CliError('INVALID_BRANCH_PATTERN', '受保护分支规则不能为空');
  if (raw.startsWith('/')) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
    if (!m || /[^i]/.test(m[2])) {
      throw new CliError('INVALID_BRANCH_PATTERN', `非法正则分支规则（仅支持 /pattern/ 或 /pattern/i）：${raw}`, { pattern: raw });
    }
    try {
      const re = new RegExp(m[1], m[2]);
      return (branch) => re.test(branch);
    } catch (err) {
      throw new CliError('INVALID_BRANCH_PATTERN', `正则分支规则编译失败（${raw}）：${err.message}`, { pattern: raw });
    }
  }
  if (raw.includes('*')) {
    const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return (branch) => re.test(branch);
  }
  return (branch) => branch === raw;
}

function validateBranchPatterns(patterns) {
  for (const pat of patterns) compileBranchPattern(pat);
  return patterns;
}

function matchesBranchPattern(branch, patterns) {
  const name = String(branch ?? '').trim();
  if (!name) return false;
  for (const pat of patterns) {
    if (compileBranchPattern(pat)(name)) return true;
  }
  return false;
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

  const commands = m.verification?.commands ?? {};
  const linked = Array.isArray(m.linkedRepos) ? m.linkedRepos : [];
  const repos = [normalizeRepo(m.hubRepo, 'hub'), ...linked.map((r, idx) => normalizeRepo(r, `repo-${idx + 1}`))]
    .filter(Boolean)
    .map((r, idx) => ({
      ...r,
      branch: r.branch ?? 'main',
      role: idx === 0 ? 'hub' : 'linked',
      verificationCommand: commands[r.name] ?? commands[r.repo] ?? null,
    }));
  const notify = {
    ...(m.notify ?? {}),
    dailyReportEnabled: bool(m.notify?.dailyReportEnabled, false),
    dailyReportTime: String(m.notify?.dailyReportTime ?? '10:00'),
    externalNotifyDisabled: bool(m.notify?.externalNotifyDisabled, false),
    ...(isPlainObject(m.notify?.externalContacts) ? { externalContacts: m.notify.externalContacts } : {}),
  };
  hm(notify.dailyReportTime);
  const warnings = [];
  if (project && !projectFile) warnings.push(`工程组档案不存在：projects/${project}.yaml|yml|json（按首次工程处理）`);

  return {
    configDir,
    project: project ?? null,
    projectFile,
    meFile,
    tier: chosen,
    tierLabel: profile.label,
    forge: m.forge ? normalizeForge(m.forge) : null,
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
    verification: m.verification ?? { mode: 'local-test', commands: {} },
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

/** preview-init 与 init 共用：确认单展示的对象即落盘执行的对象。 */
function buildRunSpec(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const project = requireFlag(flags, 'project');
  const cfg = resolveConfig({ configDir, project, tier: optFlag(flags, 'tier'), overrides: parseJsonArg(flags.overrides, 'overrides') });
  const explicitBranch = optFlag(flags, 'branch');
  const templatedBranch = cfg.branchTemplate ? cfg.branchTemplate.replaceAll('{slug}', req) : null;
  const branch = explicitBranch ?? templatedBranch ?? cfg.baselineBranch ?? `loop/${safeSlug(req)}`;
  const spec = {
    req,
    project,
    tier: cfg.tier,
    stage: validateStage(cfg, optFlag(flags, 'stage')),
    forge: cfg.forge,
    gitlabHost: cfg.gitlabHost,
    branch,
    baselineBranch: branch,
    protectedEnvBranches: cfg.protectedEnvBranches,
    autoMerge: cfg.autoMerge,
    autoMergeConfigured: cfg.autoMergeConfigured,
    hubRepo: cfg.hubRepo,
    repos: selectRepos(cfg.repos, flags.repos),
    slots: cfg.tier === 'L3' ? normalizeSlots(optFlag(flags, 'slots') ?? cfg.slots) : ['主研发'],
    user: cfg.user,
    verification: cfg.verification,
    thresholds: cfg.thresholds,
    workHours: cfg.workHours,
    notify: cfg.notify,
    roleModels: cfg.roleModels,
    selfReview: cfg.selfReview,
    contracts: cfg.contracts,
    issues: normalizeIssueMap(parseJsonArg(flags['issue-map'], 'issue-map')),
  };
  const warnings = [...cfg.warnings];
  if (!spec.forge) warnings.push('工程档案未配置 forge：init 将拒绝执行');
  if (matchesBranchPattern(branch, spec.protectedEnvBranches)) warnings.push(`基线 ${branch} 是环境分支：自动合并会被硬拒绝，全部人工合并`);
  return { spec, cfg, warnings };
}

/* ------------------------------------------------------------------ */
/* 台账、标签、定时任务与确认单                                            */
/* ------------------------------------------------------------------ */

function labelsFor(tier, slots) {
  const labels = [...TIER_PROFILES[tier].labels];
  return tier === 'L3' ? [...labels, ...normalizeSlots(slots).map((s) => `槽位${s}`)] : labels;
}

function labelsSyncArgs(run) {
  const args = ['labels-sync', '--forge', String(run.forge), '--repos', run.repos.map((r) => r.repo).join(','), '--labels', labelsFor(run.tier, run.slots).join(',')];
  if (run.forge === 'gitlab' && run.gitlabHost) args.push('--hostname', run.gitlabHost);
  return args;
}

/** L3 只建总台账 + 主研发本人小台账 + 升级 Issue；协作者加入时自建本人小台账。 */
function ledgerDescriptors(tier, req, user) {
  if (tier === 'L1') return [{ key: 'tracking', kind: 'tracking', title: `【Loop】${req}` }];
  if (tier === 'L2') return [{ key: 'main', kind: 'main', title: `【台账】${req}` }];
  return [
    { key: 'master', kind: 'master', title: `【总台账】${req}` },
    { key: 'slot:主研发', kind: 'slot', slot: '主研发', title: `【小台账】主研发-${user}` },
    { key: 'escalation', kind: 'escalation', title: `【升级】${req}` },
  ];
}

function personalLedgerKey(tier) {
  return { L1: 'tracking', L2: 'main', L3: 'slot:主研发' }[tier];
}

function scheduledTasksFor(run) {
  return TIER_PROFILES[run.tier].tasks
    .filter((role) => role !== 'lead-daily' || run.notify?.dailyReportEnabled === true)
    .map((role) => {
      const def = TASK_DEFS[role];
      const ledgerKey = def.ledger === 'master' ? 'master' : personalLedgerKey(run.tier);
      const ledgerRef = run.issues?.[ledgerKey]?.id ?? '待建';
      const id = `liteloop-${taskSafe(run.req)}-${taskSafe(run.user)}-${role}`;
      const task = {
        id,
        name: id,
        role,
        title: def.title,
        enabled: true,
        schedule: def.daily ? 'daily' : 'interval',
        ledgerKey,
        ledgerRef,
        skill: SKILL_NAME,
        entryDoc: def.entryDoc,
        description: `使用 $${SKILL_NAME}（必读 ${def.entryDoc}）；${def.title}入口：需求=${run.req}；仓库=${run.hubRepo?.repo ?? 'unknown'}；台账=${ledgerRef}；阶段、当前任务与版本以台账为准，个人配置以本机与台账配置为准。`,
      };
      if (def.daily) task.at = run.notify.dailyReportTime;
      else task.everyMinutes = num(run.thresholds[def.every], THRESHOLD_DEFAULTS[def.every]);
      return task;
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
      `模型：主控 ${model('controller')} / 拆分 ${model('planner')} / 开发 ${model('coder')} / 自审 ${model('selfReviewer')} / 小巡检 ${model('patrol')}`,
      `自审：${run.selfReview === false ? '否' : '是'} ｜ 可选确认点：提交前本人先看、送审前先看 ｜ 巡检频率：${run.thresholds.smallPatrolMinutes}m ｜ 工作时段：${run.workHours.start}-${run.workHours.end}（${run.workHours.timezone}） ｜ 汇报方式：四项汇报`,
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
  return ledgerDescriptors(run.tier, run.req, run.user).map((d) => {
    const issue = run.issues?.[d.key] ?? null;
    return { ...d, issue, body: renderLedgerBody(d.kind, run, issue) };
  });
}

function timerSummary(run) {
  const t = run.thresholds;
  if (run.tier === 'L1') return '关';
  const base = `主控${t.controllerLoopMinutes}m+静音巡检${t.smallPatrolMinutes}m`;
  if (run.tier === 'L2') return base;
  return `${base}+调度${t.controllerLoopMinutes}m+大巡检${t.leadPatrolMinutes}m${run.notify.dailyReportEnabled ? `+日报${run.notify.dailyReportTime}` : ''}`;
}

function confirmLines(run) {
  const models = run.roleModels ?? {};
  const model = (key) => models[key] ?? '未配置';
  const commands = Object.entries(run.verification?.commands ?? {}).map(([k, v]) => `${k}=${v}`).join('；') || '按仓库实际命令';
  const win = run.thresholds.externalMentionWindow;
  const notify = run.notify?.feishuGroupChatId ? `群ID(${run.notify.feishuGroupChatId})(限${win.start}-${win.end}@)` : '仅会话';
  const linked = run.repos.filter((r) => r.repo !== run.hubRepo?.repo).map((r) => r.repo);
  let merge = '全部人工合并';
  if (matchesBranchPattern(run.baselineBranch, run.protectedEnvBranches)) merge = '全人工合并（基线命中受保护环境分支，硬禁自动合并）';
  else if (run.autoMerge) merge = `低风险自动合并（${run.protectedEnvBranches.join('/')} 一律人工）`;
  return [
    `1. 需求与档位：${run.req} ｜ 档位：${run.tier} ｜ 起跳阶段：${run.stage}`,
    `2. 工程组与基线：Forge=${run.forge ?? '未配置'}${run.gitlabHost ? `@${run.gitlabHost}` : ''} ｜ 核心仓=${run.hubRepo?.repo ?? '未配置'} ｜ 关联仓=${linked.length ? linked.join(',') : '无'} ｜ 基线=${run.branch}`,
    `3. 验证策略：mode=${run.verification?.mode ?? 'local-test'} ｜ 命令=${commands}`,
    `4. 角色模型：主控=${model('controller')} ｜ 开发=${model('coder')} ｜ 自审=${run.selfReview === false ? '关' : model('selfReviewer')} ｜ 终审=${model('finalReviewer')} ｜ 巡检=${run.tier === 'L1' ? '关' : model('patrol')}`,
    `5. 节奏与确认点：定时=${timerSummary(run)} ｜ 工作时段=${run.workHours.start}-${run.workHours.end}（${run.workHours.timezone}） ｜ 合并=${merge} ｜ 通知=${notify}`,
    '6. 收尾约定：业务仓库零规范残留；合入后执行 teardown 两步拆架（先出清单保留运行态，逐项回执后才归档）。',
  ];
}

function planFor(run) {
  const confirmSheet = confirmLines(run);
  return {
    confirmSheet,
    text: ['【xxn-lite-loop 初始化确认单】', ...confirmSheet, '请回复「确认」启动，或直接指出要改的一项。'].join('\n'),
    ledgers: ledgerDescriptors(run.tier, run.req, run.user),
    scheduledTasks: scheduledTasksFor(run),
    labels: labelsFor(run.tier, run.slots),
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

function cmdPreviewInit(flags, configDir) {
  const { spec, cfg, warnings } = buildRunSpec(flags, configDir);
  const plan = planFor(spec);
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
    autoMerge: spec.autoMerge,
    protectedEnvBranches: spec.protectedEnvBranches,
    confirmSheet: plan.confirmSheet,
    text: plan.text,
    plan: { ...plan, repos: spec.repos.map((r) => r.repo), verification: spec.verification },
    warnings,
  };
}

function cmdInit(flags, configDir) {
  const req = requireFlag(flags, 'req');
  const file = runFile(configDir, req);
  const alreadyExists = () => new CliError('RUN_ALREADY_EXISTS', `需求 ${req} 已有运行态：传 --resume 读回既有记录，绝不覆盖台账绑定与历史`, { runPath: file });
  const resume = () => ({ ok: true, resumed: true, req, runPath: file, run: readJson(file) });
  if (fs.existsSync(file)) {
    if (flags.resume) return resume();
    throw alreadyExists();
  }
  const { spec, warnings } = buildRunSpec(flags, configDir);
  if (!spec.forge) throw new CliError('MISSING_FORGE', '工程档案未配置 forge（gitlab/github），拒绝初始化');
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
      sessionId: optFlag(flags, 'session') ?? `session-${Date.now().toString(36)}`,
      state: '空闲',
      env: 'local',
      startedAt: now,
      lastWake: now,
    },
    changes: [],
    review: { round: 1, rejectCount: 0 },
    worktrees: [],
    blockers: [],
    participants: [],
    contractVersion: spec.contracts === false ? null : 'v1',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, type: 'init', tier: spec.tier, stage: spec.stage }],
  };
  run.ledgers = buildLedgers(run);
  const plan = planFor(run);
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
    forgePlan: {
      issueCreates: run.ledgers.filter((l) => !l.issue).map((l) => ({ key: l.key, title: l.title, body: l.body })),
      labelsSync: plan.labelsSync,
      scheduledTasks: run.scheduledTasks,
    },
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

function issueNumber(value) {
  return /^#?([1-9]\d*)$/.exec(String(value ?? '').trim())?.[1] ?? null;
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
    autoMerge: run.autoMergeConfigured ? run.autoMerge : TIER_PROFILES[to].autoMerge,
    contracts: TIER_PROFILES[to].contracts,
    contractVersion: run.contractVersion ?? 'v1',
  };
  next.ledgers = buildLedgers(next);
  next.scheduledTasks = scheduledTasksFor(next);

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
  actions.push({ id: 'labels:sync', kind: 'labels', action: 'sync', labels: labelsFor(to, slots), args: labelsSyncArgs(next) });

  const prev = new Map((run.scheduledTasks ?? []).map((t) => [t.id, t]));
  const added = next.scheduledTasks.filter((t) => !prev.has(t.id));
  const removed = [...prev.values()].filter((t) => !next.scheduledTasks.some((n) => n.id === t.id));
  for (const task of next.scheduledTasks) {
    const old = prev.get(task.id);
    if (!old) actions.push({ id: `task:create:${task.id}`, kind: 'scheduled-task', action: 'create', task });
    else if (old.description !== task.description || old.ledgerKey !== task.ledgerKey || old.ledgerRef !== task.ledgerRef
      || old.everyMinutes !== task.everyMinutes || old.at !== task.at) {
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
      `主研发机器另开「主研发调度」${t.controllerLoopMinutes}m 与「大巡检」${t.leadPatrolMinutes}m${next.notify.dailyReportEnabled ? `，日报 ${next.notify.dailyReportTime}` : '（日报未启用）'}。`,
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
    labels: labelsFor(to, slots),
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

function cmdWakeDecision(flags) {
  const input = parseJsonArg(flags.input, 'input');
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
    row = ['paused-hold', 'SELF_PAUSED_HOLD', 0, '暂停中：仅更新最近唤醒后退出；本人说「开工」才恢复原状态，不得自行开轮。'];
  } else if (isSelf && offHours) {
    row = ['heartbeat-only', 'OFF_HOURS_HEARTBEAT', 0, `非工作时段（${work.start}-${work.end} ${work.timezone}）：定时唤醒只更新最近唤醒，不开轮、不 push、不建 PR/MR、不改标签。`];
  } else if (isSelf && state === '空闲') {
    row = ['start-round', 'SELF_IDLE_START', 1, '开始本轮：写「本轮：执行中」与开始时间、最近唤醒，对账推进，结束改空闲。'];
  } else if (isSelf && state === '执行中' && !explicit) {
    row = runningMinutes < stuckHours * 60
      ? ['heartbeat', 'SELF_RUNNING_HEARTBEAT', 2, `未满 ${stuckHours}h：仅刷新最近唤醒后退出，不开新轮。`]
      : ['self-heal', 'SELF_RUNNING_STUCK_HEAL', 2, `已满 ${stuckHours}h：重写「执行中」与开始时间，发【恢复】续接断点。`];
  } else if (isSelf && state === '执行中') {
    row = ['confirm-previous-stopped', 'SELF_RUNNING_EXPLICIT', 3, '先向本人确认上一轮已停，确认后按断点重开并发【恢复】，不得并行开轮。'];
  } else if (offHours && (explicit || basis)) {
    row = ['outside-work-hours-wait', 'OFF_HOURS_TAKEOVER_WAIT', 0, '非工作时段：等待进入工作时段或本人明确继续后再接任。'];
  } else if (explicit) {
    row = ['take-over-active', 'TAKEOVER_EXPLICIT', 4, '接管前本人先关旧会话；登记第 N+1 任、发【交接】、先停旧同名定时任务再自建本会话定时任务。'];
  } else if (basis) {
    row = ['take-over-by-basis', 'TAKEOVER_BY_BASIS', 5, '按依据接任：登记第 N+1 任、发【交接】/【恢复】、自建定时任务；遵守接任首轮边界。'];
  } else {
    row = ['exit-non-current', 'EXIT_NON_CURRENT', 6, `退出非现任会话：停用本会话定时任务并提示「已被第 ${generation} 任接替」。`];
  }
  const [action, code, tableRow, nextAction] = row;

  const takeover = action.startsWith('take-over');
  const firstRoundBoundary = takeover && !handoffComment;
  const allowedWrites = {
    'start-round': ['ledger', 'push', 'create-pr', 'change-label', 'timers'],
    heartbeat: ['ledger-last-wake'],
    'heartbeat-only': ['ledger-last-wake'],
    'outside-work-hours-wait': [],
    'paused-hold': ['ledger-last-wake'],
    'self-heal': ['ledger', 'recovery-comment', 'push', 'create-pr', 'change-label'],
    'confirm-previous-stopped': ['confirm-only'],
    'exit-non-current': ['self-timer-stop'],
  }[action] ?? ['identity', handoffComment ? 'handoff-comment' : 'recovery-comment', 'reconcile', 'timers', ...(firstRoundBoundary ? [] : ['push', 'create-pr', 'change-label'])];
  const forbiddenWrites = firstRoundBoundary || allowedWrites[0] === 'ledger-last-wake' || action === 'outside-work-hours-wait'
    ? ['push', 'create-pr', 'create-mr', 'change-label', 'external-write', ...(firstRoundBoundary ? [] : ['start-round'])]
    : [];

  let scope = 'none';
  if (takeover) scope = firstRoundBoundary ? 'identity-only' : 'takeover';
  else if (isSelf) scope = allowedWrites[0] === 'ledger-last-wake' ? 'heartbeat-only' : (action === 'confirm-previous-stopped' ? 'confirm-only' : 'full');
  const allowed = takeover || (isSelf && (verified || scope === 'heartbeat-only'));
  let reason;
  if (action === 'outside-work-hours-wait') reason = '定时唤醒处于非工作时段，保留定时等待，禁止接任和写入。';
  else if (!isSelf && !takeover) reason = `非现任主控（台账为第 ${generation} 任，本会话不是现任），禁止写台账、push、建 PR/MR、改标签；立即自停定时任务。`;
  else if (takeover) reason = firstRoundBoundary ? '接任会话仅可写自身标识、【恢复】/【交接】并对账；首轮禁止 push、建 PR/MR、改标签。' : '接任会话已完成交接，可按台账推进。';
  else if (!allowed) reason = '缺少台账主控标识或本会话标识：写入前必须先核对两者一致。';
  else reason = scope === 'heartbeat-only' ? '仅允许刷新台账「最近唤醒」，其余写入一律禁止。' : '会话标识与台账第 1 节主控标识一致，可写。';

  return {
    ok: true,
    action,
    code,
    tableRow,
    identity: { isSelf, verified, ledgerControllerId, currentSessionId, generation },
    state: { raw: rawState, normalized: state, runningMinutes, lastWakeMinutes },
    workHours: work,
    explicitTakeover: explicit,
    handoffBasis: basis,
    firstRoundBoundary,
    allowedWrites,
    forbiddenWrites,
    writeGuard: { ledgerControllerId, currentSessionId, verified, isCurrent: isSelf, allowed, allowedWrites, requiresIdCheck: isSelf && !verified, scope, reason },
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

/* ------------------------------------------------------------------ */
/* eval-review                                                          */
/* ------------------------------------------------------------------ */

function parseReviewDeps(raw) {
  return (Array.isArray(raw) ? raw : []).map((dep) => {
    if (typeof dep === 'string') {
      const m = /^(.*?)[!#](\d+)$/.exec(dep.trim());
      return m ? { repo: m[1], id: Number(m[2]), state: null } : { repo: dep, id: null, state: null, invalid: true };
    }
    return { repo: dep?.repo ?? null, id: dep?.id ?? null, state: dep?.state ?? null };
  });
}

function assessRisk(checks, declared) {
  const missing = RISK_RULES.filter((r) => typeof checks?.[r.key] !== 'boolean').map((r) => r.key);
  const matched = RISK_RULES.filter((r) => checks?.[r.key] === true);
  let level = '未核验';
  if (matched.length || declared === '高') level = '高';
  else if (declared === '低' && missing.length === 0) level = '低';
  return {
    level,
    source: matched.length ? 'rules' : (declared === '高' ? 'declared' : (level === '低' ? 'declared+rules' : 'missing')),
    reasons: matched.length ? matched.map((m) => m.label) : (declared === '高' ? ['终审显式判定为高风险'] : []),
    missingChecks: missing,
    checks: RISK_RULES.map((r) => ({ key: r.key, label: r.label, matched: checks?.[r.key] === true, verified: typeof checks?.[r.key] === 'boolean' })),
  };
}

function cmdEvalReview(flags, configDir) {
  const input = parseJsonArg(flags.input, 'input');
  const req = optFlag(flags, 'req');
  const runPath = req ? runFile(configDir, req) : null;
  const run = runPath ? readJson(runPath, 'RUN_NOT_FOUND') : null;
  const review = input.review ?? {};
  const change = input.change ?? {};
  const t = { ...THRESHOLD_DEFAULTS, ...(input.thresholds ?? {}), ...(run?.thresholds ?? {}) };
  const tier = normalizeTier(run?.tier ?? input.tier ?? 'L2');
  const forge = run?.forge ?? (input.forge ? normalizeForge(input.forge) : null);
  const baseline = run?.baselineBranch ?? input.baselineBranch ?? null;
  const protectedBranches = validateBranchPatterns([...new Set([...ENV_BRANCHES, ...splitPatterns(run?.protectedEnvBranches ?? input.protectedEnvBranches)])]);
  const autoMerge = run ? run.autoMerge === true : bool(input.autoMerge, TIER_PROFILES[tier].autoMerge);
  const gitlabHost = run?.gitlabHost ?? input.gitlabHost ?? null;
  const sessionId = review.sessionId ?? input.sessionId ?? null;
  const dispatchedSessionId = input.dispatchedSessionId ?? review.dispatchedSessionId ?? input.dispatch?.sessionId ?? null;
  const currentRound = num(input.currentRound ?? input.round ?? review.round ?? 1, 1);
  const reviewRound = num(review.round ?? input.reviewRound ?? currentRound, currentRound);

  const discard = (code, note, extra = {}) => ({ ok: true, action: 'discard', code, silent: true, effectiveRound: currentRound, note, labelPlan: { remove: [], add: [] }, merge: null, ...extra });
  if (!dispatchedSessionId || !sessionId || String(dispatchedSessionId) !== String(sessionId)) {
    return discard('STALE_REVIEW_SESSION', '结论前校验失败：本轮无「已派终审」记录，或最新记录对应会话不是自己；旧终审会话结论作废，静默退出不发结论。', { session: { sessionId, dispatchedSessionId } });
  }
  if (reviewRound !== currentRound) {
    return discard('ROUND_MISMATCH', '超时重派不算新轮：旧轮次结论作废，由调度/主控回复「已作废：已重派」。', { reviewRound });
  }
  const conclusion = String(review.conclusion ?? input.conclusion ?? '').trim();
  if (!['通过', '打回'].includes(conclusion)) throw new CliError('INVALID_CONCLUSION', `终审结论必须是「通过」或「打回」，收到：${conclusion}`);

  const fuse = num(input.rejectFuseCount ?? t.rejectFuseCount, 2);
  const rejectCount = num(input.rejectCount ?? input.history?.rejectCount, 0);
  const rejectCountAfter = rejectCount + (conclusion === '打回' ? 1 : 0);
  const fullReReview = rejectCount >= fuse;
  const risk = assessRisk(input.riskChecks ?? review.riskChecks ?? null, review.risk ? String(review.risk) : null);
  const riskLabel = { 高: '风险高', 低: '风险低' }[risk.level];
  const rawDependencies = input.dependsOn ?? review.dependsOn;
  const dependsOn = parseReviewDeps(rawDependencies);
  const unresolvedDeps = dependsOn.filter((d) => String(d.state ?? '').toLowerCase() !== 'merged');
  const dispatchedHeadSha = input.dispatchedHeadSha ?? review.dispatchedHeadSha ?? input.dispatch?.headSha ?? null;
  const currentHeadSha = change.headSha ?? input.currentHeadSha ?? null;
  const target = change.targetBranch ?? change.target ?? null;
  const source = change.sourceBranch ?? change.source ?? input.sourceBranch ?? null;
  const manualBy = tier === 'L3' ? '主研发本人' : '本人';
  const ref = change.url ?? `${change.repo}#${change.id}`;

  const out = (action, code, add, extra) => ({
    ok: true,
    action,
    code,
    effectiveRound: currentRound,
    tier,
    forge,
    conclusion,
    risk,
    rejectCountAfter,
    fullReReview,
    gate: { baseline, target, protectedBranches, autoMerge, dispatchedHeadSha, currentHeadSha },
    labelPlan: { remove: ['终审中'], add: add.filter(Boolean) },
    merge: null,
    ...extra,
  });
  const manual = (code, note) => out('manual-merge', code, [riskLabel, '待合并'], { decision: 'manual-merge', executor: manualBy, note });

  if (fullReReview) {
    const comment = conclusion === '打回' ? `打回第 ${rejectCountAfter} 次` : null;
    return out('await-human-verdict', 'REJECT_FUSE_FULL_REVIEW', ['待合并'], {
      ledger: { section2: `[待裁决] ${ref}` },
      ...(comment ? { comment, actions: [{ kind: 'comment', body: comment }] } : {}),
      note: `历史累计打回 k=${rejectCount}（≥${fuse}）：本次为全量重审，结论「${conclusion}」不再自动分流，一律「待合并」并在台账第 2 节列 [待裁决]，交${manualBy}裁决；打回计数照常累加为 ${rejectCountAfter}。`,
    });
  }
  if (conclusion === '打回') {
    return out('needs-changes', 'REVIEW_REJECTED', ['需修改'], {
      comment: `打回第 ${rejectCountAfter} 次`,
      fullReReviewRequired: rejectCountAfter >= fuse,
      note: rejectCountAfter >= fuse
        ? `同一 PR/MR 历史累计打回 k=${rejectCountAfter}（≥${fuse}）：再次送审必须标「全量重审」，结论出后一律交人裁决。`
        : '提交方同分支只改必改项追加提交并逐条回复，换回「待终审」。',
    });
  }
  const requestedRepo = change.repo ?? input.repo;
  const repoName = requestedRepo == null ? null : String(requestedRepo);
  const selected = run?.repos?.find((r) => r?.repo != null && String(r.repo) === repoName) ?? run?.repos?.find((r) => r?.name === repoName);
  if (run && requestedRepo != null && !selected) {
    return manual('REPO_NOT_IN_RUN', `${requestedRepo} 不在需求已勾选的仓库中，禁止自动合并。`);
  }
  const repo = selected?.repo ?? requestedRepo;
  if (bool(input.conflict ?? change.conflict, false)) {
    return out('needs-changes', 'MERGE_CONFLICT', ['需修改'], { comment: '合并冲突，需 rebase', rebaseReviewOnly: true, note: 'rebase 后重打「待终审」，非全量重审仅复审 rebase 差异。' });
  }
  if (dispatchedHeadSha && currentHeadSha && dispatchedHeadSha !== currentHeadSha) {
    return out('re-review', 'HEAD_SHA_MISMATCH', ['待终审'], { reReviewRequired: true, note: `派审时 head=${dispatchedHeadSha}，当前 head=${currentHeadSha}：送审后有新提交，本结论不得用于合并，重新派审。` });
  }
  if (unresolvedDeps.length) {
    return out('pending-merge', 'DEPENDS_ON_UNMERGED', [riskLabel, '待合并'], { blockedBy: unresolvedDeps, note: '存在未合入 Depends-On：不得自动合并；待前置依赖合入并 rebase 后再处理。' });
  }
  const repoProdTrunks = new Set([...PROD_TRUNKS, ...(selected?.branch ? [String(selected.branch)] : [])]);
  if (source && repoProdTrunks.has(source)) {
    return manual('PROD_TRUNK_MANUAL_SYNC', `源分支 ${source} 是当前仓生产主干：允许向需求基线同步，但禁止 AI 自动合并，由${manualBy}确认后手动合并。`);
  }
  if (source && matchesBranchPattern(source, protectedBranches)) {
    return out('reject-source', 'SOURCE_ENV_BRANCH_FORBIDDEN', ['需修改'], {
      decision: 'reject-source',
      note: `源分支 ${source} 命中非主干受保护环境分支规则（${protectedBranches.join(', ')}）：严禁合入需求基线，立即拒绝。`,
    });
  }
  if (risk.level === '高') return manual('HIGH_RISK_MANUAL', `终审通过但风险高：换「风险高」「待合并」，由${manualBy}手合。`);
  if (risk.level !== '低') return manual('RISK_UNVERIFIED', `风险结论或 6 条风险核验缺失（${risk.missingChecks.join(',') || '未声明风险'}）：不得默认低风险，保留人工合并。`);
  if (!autoMerge) {
    return out('pending-merge', 'AUTO_MERGE_DISABLED', ['风险低', '待合并'], { executor: manualBy, note: '终审通过且风险低，但自动合并关闭：换「风险低」「待合并」，由本人手合。' });
  }
  if (!forge) return manual('MISSING_FORGE', '未确认 Forge：不回退默认值，保留人工合并。');
  if (!repo || !change.id) return manual('CHANGE_UNIDENTIFIED', '变更单缺 repo/id：保留人工合并。');
  if (!target || matchesBranchPattern(target, protectedBranches)) {
    return manual('BLOCKED_ENV_BRANCH', `目标分支 ${target ?? '未知'} 未核实或命中受保护环境分支规则（${protectedBranches.join(', ')}）：禁止自动合并，只能人工合并。`);
  }
  if (!baseline || target !== baseline) return manual('TARGET_NOT_BASELINE', `目标分支 ${target} 不是已确认的需求基线 ${baseline ?? '未知'}：禁止自动合并。`);
  if (!dispatchedHeadSha || !currentHeadSha) return manual('HEAD_SHA_MISMATCH', '缺派审 head SHA 或当前 head SHA：无法绑定终审提交，拒绝自动合并。');

  const protectedArg = protectedBranches.some((p) => p.includes(',')) ? JSON.stringify(protectedBranches) : protectedBranches.join(',');
  const args = [
    'change-merge',
    '--forge', forge,
    '--repo', String(repo),
    '--id', String(change.id),
    '--head-sha', String(currentHeadSha),
    '--target', baseline,
    '--protected-branches', protectedArg,
    '--depends-on', JSON.stringify(rawDependencies ?? []),
  ];
  if (runPath) args.push('--run', runPath);
  if (forge === 'gitlab' && gitlabHost) args.push('--hostname', gitlabHost);
  return out('auto-merge', 'LOW_RISK_AUTO_MERGE', ['风险低'], {
    merge: { script: 'forge.mjs', command: 'change-merge', args },
    comment: '终审通过｜风险低｜自动合并',
    executor: tier === 'L3' ? '主研发调度' : '主控',
    note: '终审通过 + 6 条风险全核验为低 + 自动合并开启 + 目标为需求基线 + SHA 绑定：调用 forge.mjs change-merge（合并前实查目标、SHA 与正文 Depends-On），读回已合入才记成功。',
  });
}

/* ------------------------------------------------------------------ */
/* eval-patrol                                                          */
/* ------------------------------------------------------------------ */


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
  const notLanded = (ledger.externalDocs ?? []).filter((d) => d?.landedInItems === false).map((d) => d.url ?? d);
  if (notLanded.length) {
    out.push(finding('EXTERNAL_DOC_NOT_LANDED', 'correction', `EXTERNAL_DOC_NOT_LANDED:${notLanded.join(',')}`, '外部设计文档未落入子 Issue 五项',
      `【纠偏】外部设计文档未落五项：${notLanded.join('、')}，请同步到对应子 Issue 的范围/契约/拆分/验收/风险五项。`, { documents: notLanded }));
  }
  const staleHours = workElapsed(ledger, 'staleHours', 'updatedAt', ctx);
  const staleLimit = num(t.ledgerStaleWorkdays, 1) * WORKDAY_HOURS;
  if (!paused && staleHours >= staleLimit) {
    out.push(finding('LEDGER_STALE', 'reminder', `LEDGER_STALE:${ledgerRef}:${ledger.updatedAt ?? 'unknown'}`, '台账长时间无变化',
      `【提醒】台账正文已 ${staleHours.toFixed(1)} 工作小时无变化（≥ ${staleLimit}h），请刷新当前快照。`, { staleHours, staleLimit }));
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
  if (num(controller.handoff?.waitingCycles ?? controller.handoffWaitingCycles, 0) >= num(t.handoffGraceCycles, 2)) {
    out.push(finding('HANDOFF_GRACE_EXCEEDED', 'alert', `HANDOFF_GRACE_EXCEEDED:g${gen}`, '交接宽限期已过',
      `【提醒】交接后 ${t.handoffGraceCycles} 个主控周期仍无新主控接上，请本人确认接管人。`));
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
    const policyText = typeof ledger.personalPolicy === 'string'
      ? ledger.personalPolicy
      : ledgerSection(ledger.body, 5);
    if (policyText) {
      const policyCheck = checkPersonalPolicyOverride(policyText);
      if (policyCheck && policyCheck.ok === false && Array.isArray(policyCheck.violations) && policyCheck.violations.length > 0) {
        const codes = policyCheck.violations.map((v) => v.code).join(',');
        out.push(finding(
          'PERSONAL_POLICY_VIOLATION',
          'alert',
          `PERSONAL_POLICY_VIOLATION:${ledgerRef}:${codes}`,
          '个人临时约定试图绕过 L3 公共门禁',
          `槽位 ${slot} 小台账个人约定触发公共红线（${policyCheck.violations.map((v) => v.reason ?? v.message ?? v.code).join('；')}）：该约定无效，请立即撤销。`,
          { slot, violations: policyCheck.violations, recipients: [who(ledger), lead] },
        ));
      }
    }
  }
  for (const doc of input.externalDocs ?? []) {
    if (doc?.landedInItems !== false) continue;
    out.push(finding('EXTERNAL_DOC_GAP', 'alert', `EXTERNAL_DOC_GAP:${doc.url}`, '外部设计文档未落五项',
      `外部设计文档 ${doc.url ?? ''} 尚未同步到对应子 Issue 五项。`, { slot: doc.slot ?? null, url: doc.url ?? null, recipients: [who(doc)] }));
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

function cmdEvalPatrol(flags) {
  const input = parseJsonArg(flags.input, 'input');
  const t = { ...THRESHOLD_DEFAULTS, ...(input.thresholds ?? {}) };
  const mode = String(input.mode ?? 'small').toLowerCase();
  if (!['small', 'lead'].includes(mode)) throw new CliError('INVALID_PATROL_MODE', `巡检模式必须是 small/lead，收到：${mode}`);
  const win = workWindow(input);
  const mentionWin = { timezone: win.timezone, ...parseWindow(THRESHOLD_DEFAULTS.externalMentionWindow),
    ...parseWindow(input.thresholds?.externalMentionWindow ?? input.notify?.externalMentionWindow), ...parseWindow(input.mentionWindow) };
  if (input.timezone) mentionWin.timezone = String(input.timezone);
  validateTimezone(mentionWin.timezone);
  const nowMs = input.now ? parseInstant(input.now, 'now') : Date.now();
  const work = windowAt(nowMs, win);
  const ctx = { nowMs, win, offHours: !work.inside };

  const findings = mode === 'small' ? evalSmallPatrol(input, t, ctx) : evalLeadPatrol(input, t, ctx);
  if (mode === 'lead' && input.dailyReport === true) {
    const day = formatLocal(nowMs, win.timezone).slice(0, 10);
    findings.push(finding('DAILY_REPORT', 'report', `daily-report:${day}`, '每日日报', `生成 ${day} 的日报`));
  }
  const sent = new Set(list(input.sentKeys));
  for (const f of findings) f.alreadySent = sent.has(f.key);
  const fresh = findings.filter((f) => !f.alreadySent);
  const quiet = fresh.length === 0;
  const externalNotifyDisabled = bool(input.externalNotifyDisabled ?? input.notify?.externalNotifyDisabled, false);
  const base = {
    ok: true,
    mode,
    tier: input.tier ?? (mode === 'small' ? 'L2' : 'L3'),
    quiet,
    externalNotifySuppressed: externalNotifyDisabled,
    findings,
    newKeys: fresh.map((f) => f.key),
    suppressedKeys: findings.filter((f) => f.alreadySent).map((f) => f.key),
    workHours: work,
  };

  if (mode === 'small') {
    const corrections = fresh.filter((f) => f.severity === 'correction').map((f) => f.text);
    const reminders = fresh.filter((f) => f.severity !== 'correction').map((f) => f.text);
    return {
      ...base,
      action: quiet ? 'quiet-exit' : 'notify',
      corrections,
      reminders,
      mentions: [],
      deferredMentions: [],
      forgeOnly: externalNotifyDisabled ? [...corrections, ...reminders] : [],
      notifications: externalNotifyDisabled ? [] : [...corrections, ...reminders],
      report: quiet ? null : {
        stage: input.stage ?? input.ledger?.stage ?? '未知',
        currentWork: input.currentWork ?? input.ledger?.currentWork ?? '未知',
        needsOwner: fresh.map((f) => ({ code: f.code, title: f.title, detail: f.detail })),
        next: input.nextAction ?? '按 findings 逐项处理并回执',
      },
      note: quiet
        ? '无新增待办或均已提醒过（sentKeys）：安静退出不刷屏。'
        : (externalNotifyDisabled ? '外部推送已关闭：仅会话汇报并落 Forge 评论留证，不发外部私信。' : '命中待办或偏离：输出四项汇报。'),
    };
  }

  const verifiedIds = isPlainObject(input.memberOpenIds) ? input.memberOpenIds : {};
  const status = windowAt(nowMs, mentionWin);
  const mentions = [];
  const deferred = [];
  const forgeOnly = [];
  for (const f of fresh) {
    const seen = new Set();
    for (const r of f.recipients ?? []) {
      if (!r.person || seen.has(r.person)) continue;
      seen.add(r.person);
      const mappedId = Object.hasOwn(verifiedIds, r.person) ? verifiedIds[r.person] : null;
      const openId = r.openId ?? mappedId;
      const item = { person: r.person, openId, code: f.code, key: f.key, text: f.text };
      if (externalNotifyDisabled) {
        forgeOnly.push({ ...item, reason: '外部推送已关闭（externalNotifyDisabled=true）：只落 Forge 评论留证，不发外部群/私信' });
        continue;
      }
      const valid = typeof mappedId === 'string' && mappedId.trim() !== '' && mappedId === openId;
      if (!valid) forgeOnly.push({ ...item, reason: '无同一 bot 核实的 openId：只落 Forge 评论留证，不发空 @' });
      else if (status.inside) mentions.push(item);
      else deferred.push({ ...item, deferredUntil: status.deferredUntil });
    }
  }
  return {
    ...base,
    action: quiet ? 'quiet-exit' : (externalNotifyDisabled ? 'forge-only' : (mentions.length === 0 && deferred.length > 0 ? 'defer' : 'notify')),
    corrections: [],
    reminders: fresh.map((f) => f.text),
    mentions,
    deferredMentions: deferred,
    forgeOnly,
    notifications: mentions.map((m) => m.text),
    window: status,
    note: quiet
      ? '无变化且无到期项：安静退出。'
      : (externalNotifyDisabled
        ? '外部推送已关闭（externalNotifyDisabled=true）：巡检照常运行并落 Forge 评论留证，不发外部群/私信。'
        : (status.inside
          ? '工作时段内：群内按成员映射真 @ 需要行动的人；无核实 openId 的只落 Forge 评论。'
          : `非协作者工作时段（${status.start}-${status.end} ${status.timezone}）：先落 Forge 评论留证，群内 @ 暂存到 ${status.deferredUntil}。`)),
  };
}

/* ------------------------------------------------------------------ */
/* slot-claim                                                           */
/* ------------------------------------------------------------------ */

function slotKey(value) {
  return String(value ?? '').trim().replace(/^槽位/, '');
}

function compareIds(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b) ? -1 : (BigInt(a) > BigInt(b) ? 1 : 0);
  return a.localeCompare(b);
}

function cmdSlotClaim(flags) {
  const input = parseJsonArg(flags.input, 'input');
  const slot = slotKey(optFlag(flags, 'slot') ?? input.slot);
  if (!slot) throw new CliError('MISSING_SLOT', '缺少 slot');
  const all = Array.isArray(input.claims) ? input.claims : [];
  const withdrawnIds = new Set((input.withdrawals ?? []).filter((w) => slotKey(w.slot) === slot).map((w) => String(w.claimId ?? w.commentId)));
  const sameSlot = all.filter((c) => c && slotKey(c.slot) === slot);
  const claims = sameSlot
    .map((c) => ({ ...c, claimId: String(c.claimId ?? c.commentId ?? ''), at: parseInstant(c.createdAt ?? c.at, 'claims[].createdAt') }))
    .filter((c) => !bool(c.withdrawn, false) && !withdrawnIds.has(c.claimId))
    .sort((a, b) => (a.at - b.at) || compareIds(a.claimId, b.claimId));
  const ignored = all.length - sameSlot.length;
  if (claims.length === 0) {
    return { ok: true, slot, winner: null, losers: [], ignored, currentWins: false, action: 'claim', ledgerAction: 'none', note: '本槽位当前无有效绑定，可发起绑定；绑定生效后再建或复用小台账。' };
  }
  const [winner, ...losers] = claims;
  const currentSessionId = input.currentSessionId ?? input.sessionId ?? null;
  const currentWins = Boolean(currentSessionId && String(winner.sessionId) === String(currentSessionId));
  return {
    ok: true,
    slot,
    winner,
    losers,
    ignored,
    currentWins,
    action: currentWins ? 'bound' : 'withdraw-binding',
    ledgerAction: currentWins ? (input.existingLedger ? 'reuse-existing-ledger' : 'create-ledger-after-bind') : 'none',
    comment: currentWins
      ? `【配置变更】绑定 槽位${slot}｜${winner.sessionId}｜最早未撤回`
      : `【配置变更】撤回绑定：槽位${slot}｜原评论链接 ${input.currentCommentUrl ?? '本会话绑定评论'}｜冲突：${winner.sessionId} 更早`,
    note: currentWins
      ? '以本槽位最早未撤回绑定为准，绑定生效；此后才建或复用小台账并开始分派。'
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

function settled(state) {
  return ['merged', 'closed', '已合入', '已关闭', '已合并'].includes(String(state ?? '').trim().toLowerCase());
}

function teardownLive(flags, prior) {
  if (flags.live === undefined) return prior ?? {};
  requireFlag(flags, 'live');
  const live = parseJsonArg(flags.live, 'live');
  if (!isPlainObject(live)) throw new CliError('INVALID_LIVE', '--live 必须是对象');
  for (const key of ['openChanges', 'openBlockers', 'openBugs', 'ledgers']) {
    if (Object.hasOwn(live, key) && (!Array.isArray(live[key]) || !live[key].every(isPlainObject))) {
      throw new CliError('INVALID_LIVE', `--live 的 ${key} 必须是对象数组`);
    }
  }
  return { ...prior, ...live };
}

function teardownLedgers(run, live) {
  const byIssue = new Map();
  const keys = new Set();
  for (const ledger of [...(run.ledgers ?? []), ...(live.ledgers ?? [])]) {
    const id = issueNumber(ledger.issue?.id ?? ledger.id);
    const repo = ledger.repo ?? ledger.issue?.repo ?? run.hubRepo?.repo;
    if (!id || !repo) {
      if (live.ledgers?.includes(ledger)) throw new CliError('INVALID_LIVE', '--live 的 ledgers 必须包含实际 Issue 编号和可确认的仓库');
      continue;
    }
    const ref = `${repo}#${id}`;
    const previous = byIssue.get(ref);
    let key = previous?.key ?? ledger.key ?? (ledger.slot ? `slot:${slotKey(ledger.slot)}` : ref);
    if (!previous && keys.has(key)) key = `${key}:${ref}`;
    keys.add(key);
    byIssue.set(ref, { ...previous, ...ledger, repo, key, issue: ledger.issue ?? { id } });
  }
  return [...byIssue.values()];
}

function teardownChecklist(run, live) {
  const openChanges = live.openChanges ?? (run.changes ?? []).filter((c) => !settled(c.state));
  const openBlockers = live.openBlockers ?? (run.blockers ?? []).filter((b) => !bool(b.closed, false));
  const openBugs = live.openBugs ?? (run.bugs ?? []).filter((b) => !bool(b.closed, false) && !bool(b.verified, false));
  const residual = [
    ...openChanges.map((c) => ({ ...c, kind: 'change', ref: `${c.repo}#${c.id}`, state: c.state ?? 'unknown' })),
    ...openBlockers.map((b) => ({ ...b, kind: 'blocker', state: b.state ?? 'open' })),
    ...openBugs.map((b) => ({ ...b, kind: 'bug', state: b.state ?? 'open' })),
  ];
  const tasks = (run.scheduledTasks ?? []).map((task) => ({ kind: 'scheduled-task', taskId: task.id, role: task.role, host: run.user, action: 'stop-and-delete' }));
  const ledgerTargets = teardownLedgers(run, live);
  const participants = new Map((run.participants ?? []).filter((p) => slotKey(p.slot)).map((p) => [slotKey(p.slot), p]));
  for (const ledger of ledgerTargets) {
    const slot = slotKey(ledger.slot ?? (ledger.key.startsWith('slot:') ? ledger.key.slice(5) : null));
    if (slot) {
      const participant = participants.get(slot) ?? {};
      participants.set(slot, { ...participant, user: participant.user ?? ledger.user ?? null, claimed: true });
    }
  }
  const receipts = run.tier === 'L3'
    ? normalizeSlots([...list(run.slots), ...participants.keys()]).filter((s) => s !== '主研发').map((slot) => {
      const participant = participants.get(slot);
      const claimed = Boolean(participant && participant.claimed !== false);
      return {
        kind: 'remote-scheduled-task',
        slot,
        claimed,
        user: participant?.user ?? null,
        taskIds: participant?.tasks ?? [],
        need: claimed ? '协作者回执 {stopped:true,confirmedBy:"负责人"}' : '未认领槽位回执 {unclaimed:true}',
      };
    })
    : [];
  const stillOpen = new Set(openChanges.map((c) => `${c.repo}#${c.id}`));
  const merged = (run.changes ?? []).filter((c) => isMerged(c.state) && !stillOpen.has(`${c.repo}#${c.id}`)).map(changeRef);
  const ledgers = ledgerTargets.map((ledger) => {
    const issue = issueNumber(ledger.issue.id);
    const role = { master: '主研发调度', escalation: '主研发' }[ledger.kind] ?? '主控';
    const body = [
      `${role} ｜ ${ledger.slot ?? '主研发'} ｜ ${run.controller?.sessionId ?? 'unknown'}`,
      `【完结】${run.req} 已收尾拆架`,
      `- 已记录合入的变更单：${merged.length ? merged.join('、') : '无'}`,
      `- 终审记录：${run.review?.round ?? 1} 轮 / 累计打回 ${run.review?.rejectCount ?? 0} 次`,
      `- 上线基线：${run.branch ?? 'main'}@${run.baselineSha ?? '未记录'}`,
    ].join('\n');
    const common = ['--forge', String(run.forge), '--repo', String(ledger.repo), '--id', issue];
    if (run.forge === 'gitlab' && run.gitlabHost) common.push('--hostname', run.gitlabHost);
    return {
      kind: 'issue-close',
      key: ledger.key,
      issue: ledger.issue,
      title: ledger.title,
      body,
      commands: [['issue-comment', ...common, '--body', body], ['issue-close', ...common]],
    };
  });
  const worktrees = (run.worktrees ?? []).map((w) => ({ kind: 'worktree', ...gitStatus(typeof w === 'string' ? w : w.path) }));
  return { residual, tasks, receipts, ledgers, worktrees };
}

function verifyTeardown(check, results, repoResidue) {
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
  for (const ledger of check.ledgers) {
    const v = results.ledgers?.[ledger.key];
    if (v?.closed !== true && v?.status !== 'closed') need(ledger.kind, ledger.key, '台账未回执已留完结评论并关闭');
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

function cmdTeardown(flags, configDir) {
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
      return { ok: true, status: 'archived', alreadyArchived: true, req, archivePath, retainedItems, forcedWaivers, unverifiedItems, zeroResidue };
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
  const live = finalize ? prior.live : teardownLive(flags, prior.live);
  const forceNow = !finalize && bool(flags.force, false);
  const forced = forceNow || prior.forced === true;
  const check = finalize ? prior.checklist : teardownChecklist(run, live);
  if (!finalize && prior.checklist) {
    const existingWorktrees = new Map(check.worktrees.map((wt) => [wt.path, wt]));
    for (const wt of prior.checklist.worktrees.filter((item) => item.exists)) {
      const current = existingWorktrees.get(wt.path);
      if (!current?.exists || wt.dirty === true || (wt.dirty === null && current.dirty === false)) existingWorktrees.set(wt.path, wt);
    }
    check.worktrees = [...existingWorktrees.values()];
  }
  const now = new Date().toISOString();

  const waiverKey = (item) => `${item.kind}:${item.ref ?? item.id ?? item.url ?? item.title}`;
  const waiverMap = new Map((prior.forcedWaivers ?? []).map((item) => [waiverKey(item), item]));
  const blocked = check.residual.filter((item) => !waiverMap.has(waiverKey(item)));
  if (blocked.length && !forceNow) {
    writeJson(file, { ...run, teardown: { ...prior, phase: 'blocked', live, checklist: check }, updatedAt: now });
    return {
      ok: false,
      status: 'blocked',
      req,
      runPath: file,
      runRetained: true,
      blocked,
      message: `发现 ${blocked.length} 项未结残留：请先处理，或确认后加 --force 强制收尾。`,
      exitCode: 3,
    };
  }
  if (forceNow) for (const item of blocked) waiverMap.set(waiverKey(item), item);
  const forcedWaivers = [...waiverMap.values()];
  const resultsTemplate = {
    tasks: Object.fromEntries(check.tasks.map((x) => [x.taskId, { stopped: false }])),
    receipts: Object.fromEntries(check.receipts.map((x) => [x.slot, x.claimed ? { stopped: false, confirmedBy: x.user } : { unclaimed: false }])),
    ledgers: Object.fromEntries(check.ledgers.map((x) => [x.key, { closed: false }])),
    worktrees: Object.fromEntries(check.worktrees.filter((w) => w.exists).map((w) => [w.path, {
      removed: false,
      ...(w.dirty === true ? { confirmedDiscard: false } : {}),
      ...(w.dirty === null ? { verifiedClean: false } : {}),
    }])),
  };

  if (!finalize) {
    writeJson(file, { ...run, teardown: { ...prior, phase: 'planned', forced, forcedWaivers, live, checklist: check, plannedAt: now, results }, updatedAt: now });
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
      worktrees: check.worktrees,
      resultsTemplate,
      next: `逐项执行后：teardown --req ${req} --finalize --results <json>`,
    };
  }

  const meFile = findConfigFile(configDir, 'me');
  const projectFile = run.project ? findConfigFile(path.join(configDir, 'projects'), run.project) : null;
  const memoryBefore = { me: fileDigest(meFile), project: fileDigest(projectFile) };
  const repoResidue = (run.repos ?? []).filter((r) => r.path).map((r) => {
    const st = gitStatus(r.path);
    return { repo: r.repo ?? r.name, ...st, agentsMdModified: st.files.some((l) => l.includes('AGENTS.md')) };
  });
  const { failures, kept } = verifyTeardown(check, results, repoResidue);
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
      resultsTemplate,
      message: `${failures.length} 项未核验通过：运行态保留，补齐回执后重试同一命令。`,
      exitCode: 3,
    };
  }
  const unverifiedItems = repoResidue.filter((r) => r.status === 'unknown' || r.status === 'absent')
    .map((r) => ({ kind: 'repo', repo: r.repo, path: r.path, status: r.status }));
  const zeroResidue = !(kept.length || forcedWaivers.length || unverifiedItems.length);
  const archivedAt = new Date().toISOString();
  writeJson(archivePath, {
    ...run,
    status: 'archived',
    archivedAt,
    teardown: {
      phase: 'archived', forced, forcedWaivers, results, residualAtStart: check.residual, keptWorktrees: kept,
      retainedItems: kept, unverifiedItems, closingComments: check.ledgers, zeroResidue,
    },
  });
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
    residualAtStart: check.residual,
    keptWorktrees: kept,
    retainedItems: kept,
    unverifiedItems,
    zeroResidue,
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
    nextAction = `拆架被未结项阻断：先合入/关闭未结 PR/MR 或阻断项，再传 --live 重跑 teardown`;
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
    autoMerge: run.autoMerge === true,
    repos: (run.repos ?? []).map((r) => r.repo ?? r.name),
    issues: run.issues ?? {},
    runPath: file,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
    pendingUpgrade,
    pendingTeardown,
    nextAction,
    nextPrompt,
  };
}

function cmdStatus(flags, configDir) {
  const meFile = findConfigFile(configDir, 'me');
  const projects = listProjectSlugs(configDir);
  const needsOnboarding = !meFile || projects.length === 0;
  const req = optFlag(flags, 'req') ?? optFlag(flags, 'run');
  const liveArg = optFlag(flags, 'live-input') ?? optFlag(flags, 'live');
  const showLive = Boolean(flags.live || liveArg);
  const live = liveArg ? parseJsonArg(liveArg, 'live-input') : null;
  if (liveArg && !isPlainObject(live)) throw new CliError('INVALID_JSON', '--live-input 必须是 JSON 对象');
  const liveReq = live?.req ?? null;
  if (req && liveReq !== null && liveReq !== req) {
    throw new CliError('LIVE_REQ_CONFLICT', 'live 输入的 req 与 --req 不一致', { req, liveReq });
  }

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
      return showLive ? { ...result, live: buildLiveStatus(result, live, rawRun) } : result;
    }
    const archivePath = path.join(configDir, 'runs', 'archive', `${safeSlug(req)}.json`);
    if (fs.existsSync(archivePath)) {
      const archived = readJson(archivePath);
      return {
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
    }
    throw new CliError('RUN_NOT_FOUND', `未找到运行态或归档记录：${req}`);
  }

  const runsDir = path.join(configDir, 'runs');
  const activeRuns = [];
  const rawRuns = new Map();
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(runsDir, name);
      if (!fs.statSync(full).isFile()) continue;
      const rawRun = readJson(full);
      const summary = summarizeRunStatus(rawRun, full);
      activeRuns.push(summary);
      if (showLive) rawRuns.set(summary.req, rawRun);
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
  if (showLive) {
    if (liveReq !== null && !rawRuns.has(liveReq)) {
      throw new CliError('LIVE_REQ_NOT_FOUND', 'live 输入的 req 未匹配任何活跃需求', { liveReq });
    }
    const selected = rawRuns.get(liveReq ?? activeRuns[0]?.req) ?? null;
    return { ...baseResult, live: buildLiveStatus(baseResult, live, selected) };
  }
  return baseResult;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                  */
/* ------------------------------------------------------------------ */

function usage() {
  return {
    ok: true,
    name: SKILL_NAME,
    version: VERSION,
    commands: [
      'doctor [--project <slug>] [--cwd <dir>]            # 只读 6 项环境体检，返回支持档位 L1/L2/L3',
      'ledger-lint (--body <text>|--file <path>) [--tier L1|L2|L3] [--kind personal|master] [--max-lines 80]',
      'transition-check --input <json>                    # 状态流转 5 条红线守卫',
      'status [--req <slug>] [--live] [--live-input <json>] # 只读查看配置状态、活动需求、实时健康视图与下一步口令',
      'config-resolve --project <slug> [--tier L1|L2|L3] [--overrides <json>]',
      'preview-init --req <slug> --project <slug> [--tier ..] [--stage P0..P3] [--repos a,b] [--branch <br>] [--slots 主研发,A] [--overrides <json>]',
      'init --req <slug> --project <slug> [同 preview-init] [--issue-map <json>] [--session <id>] [--resume]',
      'upgrade --req|--run <slug> --to L2|L3 [--slots a,b]            # 出计划，写 pendingUpgrade',
      'upgrade --req <slug> --to L2|L3 --apply [--issue-map <json>] [--results <json>]  # 逐项回执后落盘',
      'wake-decision --input <json>   # 含 now/workHours/trigger 时非工作时段只心跳',
      'eval-review --input <json> [--req <slug>]   # --req 时以 run 中 forge/基线/自动合并为准',
      'eval-patrol --input <json>   # 大巡检日报入口：mode=lead、dailyReport=true（含个人临时规范探针）',
      'slot-claim [--slot <槽位>] --input <json>',
      'retro [--req <slug>] --input <json> [--force] [--feedback-repo <repo>]  # 条件触发纯机制复盘（纯只读）',
      'teardown --req <slug> [--live <json>] [--force]      # 第 1 步：出清单，保留 run',
      'teardown --req <slug> --finalize --results <json>    # 第 2 步：逐项核验后归档',
    ],
    globalFlags: ['--config-dir <dir>（默认 ~/.config/dev-loop，测试必须隔离）'],
  };
}

const COMMANDS = {
  doctor: (flags, configDir) => runDoctor(flags, configDir),
  'ledger-lint': (flags) => runLedgerLint(flags),
  'transition-check': (flags) => runTransitionCheck(flags),
  status: cmdStatus,
  'config-resolve': cmdConfigResolve,
  'preview-init': cmdPreviewInit,
  init: cmdInit,
  upgrade: cmdUpgrade,
  'wake-decision': cmdWakeDecision,
  'eval-review': cmdEvalReview,
  'eval-patrol': cmdEvalPatrol,
  'slot-claim': cmdSlotClaim,
  retro: (flags, configDir) => runRetro(flags, configDir),
  teardown: cmdTeardown,
};

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.help) return usage();
  const handler = COMMANDS[cmd];
  if (!handler) throw new CliError('UNKNOWN_COMMAND', `未知子命令：${cmd}`, { commands: usage().commands });
  return handler(flags, resolveConfigDir(flags));
}

try {
  const { exitCode, ...payload } = main(process.argv.slice(2)) ?? {};
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = Number(exitCode ?? 0);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: err.code ?? 'UNEXPECTED_ERROR', message: err.message, ...(err.extra ?? {}) }, null, 2)}\n`);
  process.exitCode = 2;
}
