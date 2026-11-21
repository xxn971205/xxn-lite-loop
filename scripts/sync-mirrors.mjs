#!/usr/bin/env node
/**
 * 同步分发文件并扫描敏感信息。
 * --check | --mirror <dir> | --sync-local | --pack <out.zip>
 * --extra-patterns-file <file> 或 XXN_SECRET_PATTERNS_FILE
 * 词表每行一个正则，按大小写不敏感匹配，空行与 # 注释忽略。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const SKILL_ITEMS = ['SKILL.md', 'README.md', 'references', 'scripts', 'hooks'];
const MIRROR_ITEMS = [
  'SKILL.md', 'README.md', 'LICENSE', 'CONTRIBUTING.md', '.gitignore', 'install.sh',
  '.github', '.gitlab', 'references', 'scripts', 'hooks', 'tests',
];
const PACK_ITEMS = [...SKILL_ITEMS, 'CONTRIBUTING.md', 'install.sh'];
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);
const FORBIDDEN_PATTERNS = [
  { name: 'feishu_user_id', re: /\bou_[0-9a-f]{20,}\b/i },
  { name: 'feishu_chat_id', re: /\boc_[0-9a-f]{24,}\b/i },
  { name: 'personal_abs_path', re: /\/(?:Users|home)\/[^/\s"\x27]+\// },
  { name: 'access_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,})\b/ },
];

function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED.has(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  });
}

function scanTree(root, patterns) {
  const hits = [];
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file);
    const content = fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file, 'utf8');
    const display = patterns.some(({ re }) => re.test(rel)) ? '<redacted>' : rel;
    for (const { name, re } of patterns) {
      if (re.test(rel) || re.test(content)) hits.push({ file: display, rule: name });
    }
  }
  if (hits.length) throw new Error(`敏感信息扫描未通过：${JSON.stringify(hits, null, 2)}`);
}

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function resolvedDestination(destination) {
  try {
    return fs.realpathSync(destination);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // A dangling symlink is not a directory we can safely create through.
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw err;
    return path.join(resolvedDestination(path.dirname(destination)), path.basename(destination));
  }
}

function prepareDestination(destination) {
  const absolute = path.resolve(destination);
  const verify = (canonical) => {
    if (contains(ROOT, canonical) || contains(canonical, ROOT)) {
      throw new Error('同步目标与源仓相同或互相嵌套');
    }
    return canonical;
  };
  verify(resolvedDestination(absolute));
  fs.mkdirSync(absolute, { recursive: true });
  return verify(fs.realpathSync(absolute));
}

function copyItems(items, destination, excluded = null) {
  for (const item of items) {
    const source = path.join(ROOT, item);
    if (!fs.existsSync(source)) continue;
    const target = path.join(destination, item);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => !IGNORED.has(path.basename(file)) && file !== excluded,
    });
  }
}

function main(args) {
  const getArg = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return null;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少路径`);
    return value;
  };
  const privateFile = getArg('--extra-patterns-file') ?? process.env.XXN_SECRET_PATTERNS_FILE;
  const privatePatterns = privateFile ? fs.readFileSync(privateFile, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith('#')) return [];
    try {
      return [{ name: `extra_pattern_line_${index + 1}`, re: new RegExp(pattern, 'i') }];
    } catch {
      throw new Error(`私有词表第 ${index + 1} 行不是有效正则`);
    }
  }) : [];
  const patterns = [...FORBIDDEN_PATTERNS, ...privatePatterns];
  const mirror = getArg('--mirror');
  const pack = getArg('--pack');
  const syncLocal = args.includes('--sync-local');
  if (!pack || mirror || syncLocal || args.includes('--check')) scanTree(ROOT, patterns);

  if (mirror) copyItems(MIRROR_ITEMS, prepareDestination(mirror));
  if (syncLocal) {
    const home = os.homedir();
    const targets = [path.join(home, '.agents/skills/xxn-lite-loop')];
    if (fs.existsSync(path.join(home, '.claude'))) targets.push(path.join(home, '.claude/skills/xxn-lite-loop'));
    for (const target of targets) copyItems(SKILL_ITEMS, prepareDestination(target));
  }
  if (pack) {
    const absolute = path.resolve(pack);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-lite-loop-pack-'));
    const folder = 'xxn-lite-loop-starter-pack';
    const stage = path.join(temp, folder);
    try {
      fs.mkdirSync(stage);
      copyItems(PACK_ITEMS, stage, path.join(ROOT, 'scripts', 'sync-mirrors.mjs'));
      fs.copyFileSync(path.join(stage, 'install.sh'), path.join(stage, '一键安装.sh'));
      for (const name of ['install.sh', '一键安装.sh']) fs.chmodSync(path.join(stage, name), 0o755);
      scanTree(stage, patterns);
      fs.rmSync(absolute, { force: true });
      execFileSync('zip', ['-qry', absolute, folder], { cwd: temp });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log(`✅ 已打包 Starter Pack：${absolute}`);
  }
  if (mirror) console.log('✅ 已单向同步到镜像仓');
  if (syncLocal) console.log('✅ 已同步本机运行副本');
  console.log('✅ 敏感信息扫描通过');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exitCode = 2;
}
