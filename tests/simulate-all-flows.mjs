#!/usr/bin/env node
/**
 * simulate-all-flows.mjs — xxn-lite-loop 全节点端到端模拟测试。
 *
 * 全部在 fs.mkdtempSync 临时目录内运行，结束自动清理；
 * 不触碰真实 ~/.config/dev-loop，不访问真实 GitLab/GitHub（真实执行路径用本地 fake gh/glab）。
 * 所有账号、仓库、群均为中性示例值。
 *
 * 运行：node tests/simulate-all-flows.mjs
 * 退出码：0 = 全部 PASS，1 = 有 FAIL。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOOPCTL = path.join(ROOT, 'scripts', 'loopctl.mjs');
const FORGE = path.join(ROOT, 'scripts', 'forge.mjs');
const BASE_ENV = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
for (const key of ['GITLAB_HOST', 'GH_HOST', 'GH_BIN', 'GLAB_BIN', 'GIT_BIN', 'XXN_LITE_LOOP_CONFIG_DIR']) delete BASE_ENV[key];
const execFileAsync = promisify(execFile);

const groups = [];
let current = null;
let totalPass = 0;
let totalFail = 0;
const failures = [];

function group(name) {
  current = { name, pass: 0, fail: 0 };
  groups.push(current);
}

function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canon(value[k])]));
  return value;
}

function preview(value) {
  const text = typeof value === 'string' ? value : String(JSON.stringify(canon(value)) ?? 'undefined');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function ok(name, condition, detail = '') {
  if (condition) {
    current.pass += 1;
    totalPass += 1;
  } else {
    current.fail += 1;
    totalFail += 1;
    failures.push({ group: current.name, name, detail });
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(canon(actual)) === JSON.stringify(canon(expected)), `expected=${preview(expected)} actual=${preview(actual)}`);
}

function includes(name, haystack, needle) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  ok(name, text.includes(needle), `expected to include ${preview(needle)} in ${preview(text)}`);
}

function excludes(name, haystack, needle) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  ok(name, !text.includes(needle), `expected NOT to include ${preview(needle)} in ${preview(text)}`);
}

function runCli(script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120000, env: { ...BASE_ENV, ...env } });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { code: result.status, json: json ?? {}, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const loopctl = (args, configDir) => runCli(LOOPCTL, [...args, '--config-dir', configDir]);
const forge = (args, env) => runCli(FORGE, args, env);
const input = (payload) => ['--input', JSON.stringify(payload)];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function patchRun(configDir, req, mutate) {
  const file = path.join(configDir, 'runs', `${req}.json`);
  const run = readJson(file);
  mutate(run);
  write(file, `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

function git(args, cwd) {
  const result = spawnSync('git', ['-c', 'user.name=LoopTest', '-c', 'user.email=loop@test.local', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 60000, env: BASE_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout ?? '';
}

function commitFixture(cwd, branch, message, parent) {
  git(['add', '.'], cwd);
  const tree = git(['write-tree'], cwd).trim();
  const args = ['commit-tree', tree, '-m', message];
  if (parent) args.push('-p', parent);
  const sha = git(args, cwd).trim();
  git(['update-ref', `refs/heads/${branch}`, sha], cwd);
  return sha;
}

function updateFixtureRemote(bare, source, branch) {
  git(['fetch', '-q', '--no-tags', source, `+refs/heads/${branch}:refs/heads/${branch}`], bare);
}

function makeRepoPair(base) {
  fs.mkdirSync(base, { recursive: true });
  const cloneA = path.join(base, 'a');
  const bare = path.join(base, 'remote.git');
  const cloneB = path.join(base, 'b');
  git(['init', '-q', '-b', 'main', cloneA], base);
  write(path.join(cloneA, 'README.md'), 'v1\n');
  const initial = commitFixture(cloneA, 'main', 'init');
  git(['init', '-q', '--bare', '-b', 'main', bare], base);
  git(['remote', 'add', 'origin', bare], cloneA);
  updateFixtureRemote(bare, cloneA, 'main');
  git(['fetch', '-q', 'origin'], cloneA);
  git(['clone', '-q', bare, cloneB], base);
  write(path.join(cloneB, 'README.md'), 'v1\nv2\n');
  commitFixture(cloneB, 'main', 'second', initial);
  updateFixtureRemote(bare, cloneB, 'main');
  return { base, cloneA, bare, cloneB };
}

/* ------------------------------------------------------------------ */
/* 中性 fixture                                                          */
/* ------------------------------------------------------------------ */

const FULL_LOW = { contract: false, hotFile: false, migration: false, switchDefault: false, signature: false, foundation: false };

function meYaml() {
  return [
    'user: lead-dev',
    'timezone: Asia/Shanghai',
    'workHours: 09:00-19:00',
    'defaultTier: L2',
    'roleModels:',
    '  controller: model-strong',
    '  planner: model-strong',
    '  coder: model-coder',
    '  selfReviewer: model-review',
    '  patrol: model-light',
    '  finalReviewer: model-strong',
    'selfReview: true',
    'thresholds:',
    '  stuckHours: 3',
    'notify:',
    '  dailyReportTime: "10:00"',
    '',
  ].join('\n');
}

function coreProject(repoPath, webPath) {
  return [
    'forge: gitlab',
    'gitlabHost: gitlab.acme.test',
    'defaultTier: L3',
    'hubRepo:',
    '  name: core-svc',
    '  repo: acme/core-svc',
    `  path: ${repoPath}`,
    '  branch: main',
    'linkedRepos:',
    '  - name: web-app',
    '    repo: acme/web-app',
    `    path: ${webPath}`,
    '    branch: main',
    'verification: { mode: "isolated-build", commands: { "core-svc": "./mvnw -q test", \'web-app\': "npm test" } }',
    'slots: [主研发, A, B]',
    'notify:',
    '  feishuGroupChatId: oc_demo_group',
    'thresholds:',
    '  ledgerMaxLines: 90',
    '',
  ].join('\n');
}

function simpleProject({ forge: f, tier, name, repo, repoPath, extra = [] }) {
  return [
    `forge: ${f}`,
    `defaultTier: ${tier}`,
    'hubRepo:',
    `  name: ${name}`,
    `  repo: ${repo}`,
    `  path: ${repoPath}`,
    '  branch: main',
    'verification:',
    '  mode: local-test',
    '  commands:',
    `    ${name}: npm test`,
    ...extra,
    '',
  ].join('\n');
}

function setupConfig(tmp, projects) {
  const configDir = path.join(tmp, 'config');
  write(path.join(configDir, 'me.yaml'), meYaml());
  for (const [slug, content] of Object.entries(projects)) write(path.join(configDir, 'projects', slug), content);
  return configDir;
}

/** 本地 fake gh/glab：按状态文件应答，记录每次调用，绝不访问网络。 */
const FAKE_FORGE_SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const file = process.env.FAKE_FORGE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(process.env.FAKE_FORGE_LOG, JSON.stringify({ args, stdin }) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const reply = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const fail = (m) => { process.stderr.write(m); process.exit(1); };
const repoArg = () => args[args.indexOf('--repo') + 1];
if (args[0] === 'api') {
  const opt = {}; const pos = [];
  for (let i = 1; i < args.length; i += 1) {
    if (args[i].startsWith('--')) { opt[args[i].slice(2)] = args[i + 1]; i += 1; } else pos.push(args[i]);
  }
  const p = pos[0].split('?')[0];
  const query = new URLSearchParams(pos[0].split('?')[1]);
  let m;
  if (/^projects\\/[^/]+\\/issues\\/\\d+\\/notes$/.test(p) || /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+\\/comments$/.test(p)) {
    reply(state.comments?.[p]?.[Number(query.get('page') ?? 1) - 1] ?? []);
  }
  if ((m = /^projects\\/([^/]+)\\/merge_requests\\/(\\d+)\\/merge$/.exec(p))) {
    const mr = state.mrs[decodeURIComponent(m[1]) + '!' + m[2]];
    if (!mr) fail('404');
    if (state.mergeSucceeds !== false) mr.state = 'merged';
    save(); reply(mr);
  }
  if ((m = /^projects\\/([^/]+)\\/merge_requests\\/(\\d+)$/.exec(p))) {
    const mr = state.mrs[decodeURIComponent(m[1]) + '!' + m[2]];
    if (mr) reply(mr); else fail('404');
  }
  if (/^groups\\/[^/]+\\/merge_requests$/.test(p)) reply(state.groupMrs ?? []);
  if ((m = /^projects\\/([^/]+)\\/merge_requests$/.exec(p))) reply(state.projectMrs?.[decodeURIComponent(m[1])] ?? []);
  if ((m = /^projects\\/([^/]+)\\/labels$/.exec(p))) { if (opt.method === 'POST') reply({}); reply(state.labels?.[decodeURIComponent(m[1])] ?? []); }
  fail('unknown api ' + p);
}
if (args[0] === 'pr' && args[1] === 'view') { const pr = state.prs[repoArg() + '#' + args[2]]; if (pr) reply(pr); else fail('not found'); }
if (args[0] === 'pr' && args[1] === 'merge') {
  const pr = state.prs[repoArg() + '#' + args[2]];
  if (state.mergeSucceeds !== false) pr.state = 'MERGED';
  save(); process.exit(0);
}
if (args[0] === 'label' && args[1] === 'list') reply(state.labels?.[repoArg()] ?? []);
if (args[0] === 'label' && args[1] === 'create') process.exit(0);
fail('unknown ' + args.join(' '));
`;

function makeFakeForge(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'fake-forge.mjs');
  write(bin, FAKE_FORGE_SOURCE);
  fs.chmodSync(bin, 0o755);
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'calls.jsonl');
  return {
    env: { GH_BIN: bin, GLAB_BIN: bin, FAKE_FORGE_STATE: stateFile, FAKE_FORGE_LOG: logFile },
    reset(state) {
      write(stateFile, JSON.stringify(state));
      write(logFile, '');
    },
    calls() {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

/* ================================================================== */
/* 场景 1：配置继承、YAML 严格解析、确认单与执行对象一致、零仓库侵入        */
/* ================================================================== */

async function scenario1(tmp) {
  group('1. 配置继承 + YAML 严格解析 + 确认单与执行一致 + 零仓库侵入');
  const repoDir = path.join(tmp, 'repo-core');
  const webDir = path.join(tmp, 'repo-web');
  const ghDir = path.join(tmp, 'repo-gh');
  for (const d of [repoDir, webDir, ghDir]) fs.mkdirSync(d, { recursive: true });
  const agentsPath = path.join(repoDir, 'AGENTS.md');
  write(agentsPath, '# 业务仓库规范\n不得改写\n');
  const agentsBefore = fs.readFileSync(agentsPath, 'utf8');
  const realRunPath = path.join(os.homedir(), '.config', 'dev-loop', 'runs', 'export-md.json');
  const realRunBefore = fs.existsSync(realRunPath);
  const configDir = setupConfig(tmp, {
    'core.yaml': coreProject(repoDir, webDir),
    'gh-tool.yaml': simpleProject({ forge: 'github', tier: 'L1', name: 'gh-tool', repo: 'acme/gh-tool', repoPath: ghDir }),
    'tz-proj.yaml': [
      'forge: github', 'timezone: America/Los_Angeles', 'workHours: 08:00-17:00',
      'hubRepo: acme/tz-svc', '',
    ].join('\n'),
    'bad-indent.yaml': 'forge: gitlab\n  oops: 1\n',
    'bad-line.yaml': 'forge: gitlab\njust words here\n',
    'json-proj.json': JSON.stringify({
      forge: 'github',
      defaultTier: 'L2',
      hubRepo: { name: 'json-tool', repo: 'acme/json-tool', path: ghDir, branch: 'main' },
      linkedRepos: [{ name: 'json-ui', repo: 'acme/json-ui', path: webDir, branch: 'main' }],
      verification: { mode: 'hybrid', commands: { 'json-tool': 'npm test' } },
    }),
  });

  const core = loopctl(['config-resolve', '--project', 'core'], configDir);
  eq('config-resolve 退出码 0', core.code, 0);
  eq('档位取工程默认 L3', core.json.tier, 'L3');
  eq('Forge 为 gitlab', core.json.forge, 'gitlab');
  eq('GitLab hostname 从工程档案带出', core.json.gitlabHost, 'gitlab.acme.test');
  eq('仓库数 2（核心+关联）', core.json.repos.length, 2);
  eq('内联对象双引号键名正确去引号', core.json.repos[0].verificationCommand, './mvnw -q test');
  eq('内联对象单引号键名正确去引号', core.json.repos[1].verificationCommand, 'npm test');
  eq('验证模式 isolated-build', core.json.verification.mode, 'isolated-build');
  eq('me 的 stuckHours=3 被继承', core.json.thresholds.stuckHours, 3);
  eq('工程覆盖 ledgerMaxLines=90', core.json.thresholds.ledgerMaxLines, 90);
  eq('阈值默认 mrIdleWarnHours=4 保留', core.json.thresholds.mrIdleWarnHours, 4);
  eq('工作时段从 me 继承', core.json.workHours, { start: '09:00', end: '19:00', timezone: 'Asia/Shanghai' });
  eq('角色模型从 me 继承', core.json.roleModels.controller, 'model-strong');
  eq('内联数组槽位 3 个', core.json.slots, ['主研发', 'A', 'B']);
  includes('L3 激活 P3 暂停阈值', core.json.activeThresholds, 'p3PauseMaxHours');
  eq('默认环境分支保护集', core.json.protectedEnvBranches, ['main', 'master', 'test', 'uat']);
  eq('日报默认关闭', core.json.notify.dailyReportEnabled, false);
  eq('配置来源四层完整', core.json.sources.map((s) => s.level), ['skill', 'me', 'project', 'overrides']);

  const tz = loopctl(['config-resolve', '--project', 'tz-proj'], configDir);
  eq('工程顶层 timezone 与 workHours 生效', tz.json.workHours, { start: '08:00', end: '17:00', timezone: 'America/Los_Angeles' });

  const badIndent = loopctl(['config-resolve', '--project', 'bad-indent'], configDir);
  eq('非法缩进 YAML 退出码 2', badIndent.code, 2);
  eq('非法缩进错误码', badIndent.json.code, 'INVALID_CONFIG');
  eq('非法缩进定位到第 2 行', badIndent.json.line, 2);
  includes('错误信息带文件名', badIndent.json.message, 'bad-indent.yaml');
  const badLine = loopctl(['config-resolve', '--project', 'bad-line'], configDir);
  eq('非映射行直接报错并定位第 2 行', [badLine.json.code, badLine.json.line], ['INVALID_CONFIG', 2]);

  const gh = loopctl(['config-resolve', '--project', 'gh-tool'], configDir);
  eq('github 工程自动带出 L1', [gh.json.tier, gh.json.forge, gh.json.repos.length], ['L1', 'github', 1]);
  eq('L1 不建定时任务', gh.json.scheduledTaskRoles, []);
  const jsonProject = loopctl(['config-resolve', '--project', 'json-proj'], configDir);
  eq('JSON 工程档案可解析', [jsonProject.code, jsonProject.json.tier, jsonProject.json.repos.length, jsonProject.json.verification.mode], [0, 'L2', 2, 'hybrid']);

  const subset = loopctl(['preview-init', '--req', 'subset', '--project', 'core', '--repos', 'acme/core-svc'], configDir);
  eq('--repos 只选核心仓', subset.json.plan.repos, ['acme/core-svc']);
  eq('未配模板和显式基线时使用需求分支', subset.json.branch, 'loop/subset');
  eq('L3 只建 总台账+主研发小台账+升级 3 个台账', subset.json.plan.ledgers.map((l) => l.key), ['master', 'slot:主研发', 'escalation']);

  const linkedOnly = loopctl(['preview-init', '--req', 'linked', '--project', 'core', '--repos', 'web-app'], configDir);
  eq('只勾关联仓时核心仓身份不漂移', linkedOnly.json.hubRepo.repo, 'acme/core-svc');
  eq('勾选仓保持关联角色', linkedOnly.json.repos.map((r) => [r.repo, r.role]), [['acme/web-app', 'linked']]);
  includes('确认单核心仓仍为真实核心仓', linkedOnly.json.confirmSheet[1], '核心仓=acme/core-svc');
  includes('定时任务描述指向真实核心仓', linkedOnly.json.plan.scheduledTasks[0].description, '仓库=acme/core-svc');

  const typo = loopctl(['preview-init', '--req', 'typo', '--project', 'core', '--repos', 'core-svcc'], configDir);
  eq('未知勾选仓直接拒绝', [typo.code, typo.json.code], [2, 'UNKNOWN_REPO']);

  const prevBranch = loopctl(['preview-init', '--req', 'br', '--project', 'core', '--branch', 'loop/confirmed'], configDir);
  const initBranch = loopctl(['init', '--req', 'br', '--project', 'core', '--branch', 'loop/confirmed'], configDir);
  eq('--branch 预览与初始化一致', [prevBranch.json.branch, initBranch.json.branch, initBranch.json.run.baselineBranch], ['loop/confirmed', 'loop/confirmed', 'loop/confirmed']);
  includes('确认单基线显示 --branch', prevBranch.json.confirmSheet[1], '基线=loop/confirmed');
  eq('预览与初始化定时任务完全一致', prevBranch.json.plan.scheduledTasks, initBranch.json.scheduledTasks);
  eq('预览与初始化标签同步参数一致', prevBranch.json.plan.labelsSync, initBranch.json.forgePlan.labelsSync);

  const templated = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--overrides', JSON.stringify({ branchTemplate: 'feature_2611B_{slug}' })], configDir);
  const templatedOverride = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--overrides', JSON.stringify({ branchTemplate: 'feature_2611B_{slug}' }), '--branch', 'loop/custom'], configDir);
  eq('branchTemplate 自动推算且 --branch 优先', [templated.json.branch, templatedOverride.json.branch], ['feature_2611B_feat-x', 'loop/custom']);
  const explicitBaseline = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--overrides', '{"baselineBranch":"loop/configured"}'], configDir);
  eq('配置了 baselineBranch 时保留显式基线', explicitBaseline.json.branch, 'loop/configured');
  const manualText = '合并=全人工合并（基线命中受保护环境分支，硬禁自动合并）';
  for (const branch of ['main', 'preprod']) {
    const protectedPreview = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--tier', 'L2', '--branch', branch,
      '--overrides', '{"protectedEnvBranches":["preprod"]}'], configDir);
    includes(`L2 确认单展示 ${branch} 的人工合并限制`, protectedPreview.json.confirmSheet[4], manualText);
    excludes(`L2 确认单不同时宣称 ${branch} 可自动合并`, protectedPreview.json.confirmSheet[4], '低风险自动合并');
  }

  const overrides = { tier: 'L2', thresholds: { ledgerMaxLines: 70, stuckHours: 4 }, notify: { feishuGroupChatId: 'oc_override' } };
  const over = loopctl(['config-resolve', '--project', 'core', '--overrides', JSON.stringify(overrides)], configDir);
  eq('本次覆盖优先级', [over.json.tier, over.json.thresholds.ledgerMaxLines, over.json.thresholds.stuckHours, over.json.notify.feishuGroupChatId, over.json.thresholds.mrIdleWarnHours], ['L2', 70, 4, 'oc_override', 4]);
  const explicit = loopctl(['config-resolve', '--project', 'core', '--tier', 'L1'], configDir);
  eq('--tier 显式覆盖工程默认', [explicit.json.tier, explicit.json.ledgerMode], ['L1', 'single']);

  const init = loopctl(['init', '--req', 'export-md', '--project', 'core', '--issue-map', '{"master":"#1"}'], configDir);
  eq('隔离配置目录 init 成功', init.code, 0);
  const runPath = path.join(configDir, 'runs', 'export-md.json');
  const run = readJson(runPath);
  eq('run 持久化已确认 forge/基线/自动合并/环境分支/host', [run.forge, run.baselineBranch, run.autoMerge, run.protectedEnvBranches, run.gitlabHost], ['gitlab', 'loop/export-md', true, ['main', 'master', 'test', 'uat'], 'gitlab.acme.test']);
  includes('独立需求基线仍可低风险自动合并', init.json.confirmSheet[4], '低风险自动合并');
  eq('原子写无 .tmp 残留', fs.readdirSync(path.join(configDir, 'runs')).filter((f) => f.includes('.tmp.')), []);
  eq('未写入真实 ~/.config/dev-loop', fs.existsSync(realRunPath), realRunBefore);

  const dup = loopctl(['init', '--req', 'export-md', '--project', 'core', '--issue-map', '{"master":"#999"}'], configDir);
  eq('重复 init 默认拒绝', [dup.code, dup.json.code], [2, 'RUN_ALREADY_EXISTS']);
  eq('重复 init 不覆盖台账绑定', readJson(runPath).issues.master.id, '#1');
  const resume = loopctl(['init', '--req', 'export-md', '--project', 'core', '--resume'], configDir);
  eq('--resume 返回既有记录', [resume.code, resume.json.resumed, resume.json.run.issues.master.id], [0, true, '#1']);

  write(path.join(configDir, 'projects', 'race.json'), JSON.stringify({
    forge: 'github',
    hubRepo: 'acme/hub',
    linkedRepos: Array.from({ length: 2000 }, (_, i) => `acme/service-${i}`),
  }));
  const attempts = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    let code = 0;
    let stdout;
    try {
      ({ stdout } = await execFileAsync(process.execPath, [
        LOOPCTL, 'init', '--req', 'race', '--project', 'race', '--tier', 'L1', '--config-dir', configDir,
        '--session', `race-${i}`, '--issue-map', JSON.stringify({ tracking: i + 1 }),
      ], { env: BASE_ENV, timeout: 60000 }));
    } catch (err) {
      ({ code, stdout } = err);
    }
    return { code, output: JSON.parse(stdout), session: `race-${i}`, ledgerId: String(i + 1) };
  }));
  const winners = attempts.filter((r) => r.code === 0);
  eq('并发 6 路 init 恰好 1 路成功', winners.length, 1);
  eq('其余 5 路都返回 RUN_ALREADY_EXISTS', attempts.filter((r) => r.code !== 0).map((r) => [r.code, r.output.code]),
    Array.from({ length: 5 }, () => [2, 'RUN_ALREADY_EXISTS']));
  const persisted = readJson(path.join(configDir, 'runs', 'race.json'));
  eq('唯一获胜者的会话和台账完整落盘', [persisted.controller.sessionId, persisted.issues.tracking.id], [winners[0]?.session, winners[0]?.ledgerId]);
  eq('并发失败者未留下临时文件', fs.readdirSync(path.join(configDir, 'runs')).sort(), ['br.json', 'export-md.json', 'race.json']);

  eq('业务仓库 AGENTS.md 内容零改动', fs.readFileSync(agentsPath, 'utf8'), agentsBefore);
  eq('业务仓库目录零新增文件', fs.readdirSync(repoDir), ['AGENTS.md']);
}

/* ================================================================== */
/* 场景 2：L1 极轻档（GitHub）闭环 + 两步拆架                              */
/* ================================================================== */

function scenario2(tmp) {
  group('2. L1 极轻档闭环（GitHub）+ 两步拆架');
  const repoDir = path.join(tmp, 'repo-gh');
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-q', '-b', 'main'], repoDir);
  const configDir = setupConfig(tmp, { 'gh-tool.yaml': simpleProject({ forge: 'github', tier: 'L1', name: 'gh-tool', repo: 'acme/gh-tool', repoPath: repoDir }) });
  const meBefore = fs.readFileSync(path.join(configDir, 'me.yaml'), 'utf8');

  const pre = loopctl(['preview-init', '--req', 'export-md', '--project', 'gh-tool'], configDir);
  eq('preview-init 退出码 0', pre.code, 0);
  eq('确认单固定 6 行', pre.json.confirmSheet.length, 6);
  includes('确认单含 L1 与起跳 P3', pre.json.confirmSheet[0], '档位：L1 ｜ 起跳阶段：P3');
  includes('确认单第 6 行为两步拆架约定', pre.json.confirmSheet[5], 'teardown 两步拆架');
  includes('确认单工作时段来自配置', pre.json.confirmSheet[4], '09:00-19:00（Asia/Shanghai）');
  eq('L1 应建 1 个 tracking 台账', pre.json.plan.ledgers.map((l) => l.key), ['tracking']);
  eq('L1 不建定时任务', pre.json.plan.scheduledTasks.length, 0);
  eq('L1 标签集补齐待合并', pre.json.plan.labels, ['待终审', '终审中', '待合并', '需修改', '风险高', '风险低']);
  includes('L1 标签同步按清单传 --labels', pre.json.plan.labelsSync.args, '--labels');

  const init = loopctl(['init', '--req', 'export-md', '--project', 'gh-tool', '--branch', 'feat/export', '--issue-map', '{"tracking":"#7"}'], configDir);
  eq('init 退出码 0', init.code, 0);
  eq('--branch 覆盖运行态基线', [init.json.branch, init.json.run.baselineBranch], ['feat/export', 'feat/export']);
  eq('L1 台账标题', init.json.ledgers[0].title, '【Loop】export-md');
  eq('L1 台账固定 4 节', (init.json.ledgers[0].body.match(/^## /gm) ?? []).length, 4);
  eq('L1 默认关闭自动合并并持久化', init.json.run.autoMerge, false);

  const review = loopctl(['eval-review', '--req', 'export-md', ...input({
    forge: 'gitlab',
    autoMerge: true,
    dispatchedSessionId: 's-l1',
    dispatchedHeadSha: 'abc123',
    review: { sessionId: 's-l1', conclusion: '通过', risk: '低', round: 1 },
    change: { repo: 'acme/gh-tool', id: 55, headSha: 'abc123', targetBranch: 'feat/export' },
    riskChecks: FULL_LOW,
  })], configDir);
  eq('L1 自动合并按 run 确认的关闭执行', [review.json.action, review.json.code], ['pending-merge', 'AUTO_MERGE_DISABLED']);
  eq('L1 以 run 的 forge 为准不被输入覆盖', review.json.forge, 'github');
  eq('L1 低风险进待合并', review.json.labelPlan.add, ['风险低', '待合并']);

  const plan = loopctl(['teardown', '--req', 'export-md'], configDir);
  eq('拆架第 1 步只出清单', [plan.code, plan.json.phase, plan.json.runRetained], [0, 'planned', true]);
  ok('第 1 步保留活动 run', fs.existsSync(path.join(configDir, 'runs', 'export-md.json')));
  eq('L1 无定时任务可停', plan.json.scheduledTasksToStop.length, 0);
  eq('完结评论覆盖已绑定台账', plan.json.closingComments.map((c) => c.key), ['tracking']);
  includes('台账关闭命令走 forge issue-close', plan.json.closingComments[0].commands[1], 'issue-close');
  eq('台账关闭命令编号去 #', plan.json.closingComments[0].commands[1].slice(-1), ['7']);

  const noResults = loopctl(['teardown', '--req', 'export-md', '--finalize'], configDir);
  eq('--finalize 无 --results 退出 2 且保留 run', [noResults.code, noResults.json.code, fs.existsSync(init.json.runPath)], [2, 'MISSING_RESULTS', true]);
  const early = loopctl(['teardown', '--req', 'export-md', '--finalize', '--results', '{}'], configDir);
  eq('台账未回执关闭则拒绝归档', [early.code, early.json.code], [3, 'TEARDOWN_INCOMPLETE']);
  ok('失败后 run 仍在可重试', fs.existsSync(path.join(configDir, 'runs', 'export-md.json')));
  const done = loopctl(['teardown', '--req', 'export-md', '--finalize', '--results', '{"ledgers":{"tracking":{"closed":true}}}'], configDir);
  eq('逐项回执后归档', [done.code, done.json.status, done.json.zeroResidue], [0, 'archived', true]);
  ok('归档文件存在', fs.existsSync(path.join(configDir, 'runs', 'archive', 'export-md.json')));
  ok('原运行态已移除', !fs.existsSync(path.join(configDir, 'runs', 'export-md.json')));
  eq('个人与工程记忆保留', [done.json.memoryPreserved.me.preserved, done.json.memoryPreserved.project.preserved], [true, true]);
  eq('me.yaml 内容不变', fs.readFileSync(path.join(configDir, 'me.yaml'), 'utf8'), meBefore);
  const again = loopctl(['teardown', '--req', 'export-md'], configDir);
  eq('已归档后重复 teardown 幂等', [again.code, again.json.alreadyArchived], [0, true]);
}

/* ================================================================== */
/* 场景 3：L2 标准档（唤醒、工作时段、巡检、终审门禁、拆架重试）             */
/* ================================================================== */

function scenario3(tmp) {
  group('3. L2 标准档（工作时段 + 巡检 + 终审门禁 + 拆架重试）');
  const repoDir = path.join(tmp, 'repo-l2');
  fs.mkdirSync(repoDir, { recursive: true });
  const configDir = setupConfig(tmp, {
    'demo-l2.yaml': simpleProject({ forge: 'gitlab', tier: 'L2', name: 'core-svc', repo: 'acme/core-svc', repoPath: repoDir }),
    'gh-l2.yaml': simpleProject({ forge: 'github', tier: 'L2', name: 'web-app', repo: 'acme/web-app', repoPath: repoDir }),
    'manual-l2.yaml': simpleProject({ forge: 'gitlab', tier: 'L2', name: 'core-svc', repo: 'acme/core-svc', repoPath: repoDir, extra: ['autoMerge: false'] }),
  });

  const init = loopctl(['init', '--req', 'night-run', '--project', 'demo-l2', '--branch', 'main', '--issue-map', '{"main":"#201"}'], configDir);
  eq('L2 init 退出码 0', init.code, 0);
  eq('L2 单主台账', init.json.ledgers.map((l) => l.key), ['main']);
  eq('L2 定时任务角色', init.json.scheduledTasks.map((t) => t.role), ['controller', 'patrol']);
  eq('主控/巡检周期 30m/60m', init.json.scheduledTasks.map((t) => t.everyMinutes), [30, 60]);
  eq('L2 任务绑定主台账', init.json.scheduledTasks.map((t) => t.ledgerRef), ['#201', '#201']);
  eq('L2 主台账固定 5 节', (init.json.ledgers[0].body.match(/^## /gm) ?? []).length, 5);
  const l2Preview = loopctl(['preview-init', '--req', 'night-run', '--project', 'demo-l2'], configDir);
  includes('L2 确认单节奏为主控30m+静音巡检60m', l2Preview.json.confirmSheet[4], '主控30m+静音巡检60m');

  // ---- 唤醒判定 ----
  const wake = (payload) => loopctl(['wake-decision', ...input(payload)], configDir).json;
  const ids = { currentSessionId: 's1', ledgerControllerId: 's1' };
  const SH = { workHours: '09:00-19:00', timezone: 'Asia/Shanghai' };
  const idle = wake({ ...ids, state: '空闲' });
  eq('空闲且标识是自己 → 开轮', [idle.action, idle.tableRow, idle.writeGuard.scope], ['start-round', 1, 'full']);
  const selfNoIds = wake({ isSelf: true, state: '空闲' });
  eq('缺双方标识不得全量写入', [selfNoIds.writeGuard.allowed, selfNoIds.writeGuard.requiresIdCheck], [false, true]);
  const pausedNoIds = wake({ isSelf: true, state: '暂停（原：空闲）' });
  eq('暂停入口 writeGuard 只心跳', [pausedNoIds.action, pausedNoIds.writeGuard.scope, pausedNoIds.writeGuard.allowed], ['paused-hold', 'heartbeat-only', true]);
  const heartbeat = wake({ ...ids, state: '执行中', runningMinutes: 45 });
  eq('执行中未满 2h → 仅心跳', [heartbeat.action, heartbeat.allowedWrites, heartbeat.writeGuard.scope], ['heartbeat', ['ledger-last-wake'], 'heartbeat-only']);
  const heal = wake({ ...ids, state: '执行中', runningMinutes: 150 });
  eq('执行中满 2h → 自愈', [heal.action, heal.selfHeal.atMinutes], ['self-heal', 120]);
  const explicitRunning = wake({ ...ids, state: '执行中', runningMinutes: 10, explicitTakeover: true });
  eq('执行中且本人要求继续 → 先确认上一轮已停', [explicitRunning.action, explicitRunning.allowedWrites], ['confirm-previous-stopped', ['confirm-only']]);
  const paused = wake({ ...ids, state: '暂停（原：执行中）', runningMinutes: 500 });
  eq('暂停态仅心跳不误开轮', [paused.action, paused.tableRow, paused.writeGuard.scope], ['paused-hold', 0, 'heartbeat-only']);
  const offHours = wake({ ...ids, ...SH, state: '空闲', now: '2024-05-01T17:00:00Z' });
  eq('上海 01:00 定时唤醒 → 只心跳', [offHours.action, offHours.code], ['heartbeat-only', 'OFF_HOURS_HEARTBEAT']);
  eq('非工作时段只允许刷新最近唤醒', [offHours.allowedWrites, offHours.writeGuard.scope], [['ledger-last-wake'], 'heartbeat-only']);
  includes('非工作时段禁止开轮', offHours.forbiddenWrites, 'start-round');
  includes('非工作时段禁止 push', offHours.forbiddenWrites, 'push');
  const offRunning = wake({ ...ids, ...SH, state: '执行中', runningMinutes: 300, now: '2024-05-01T17:00:00Z' });
  eq('非工作时段执行中也不自愈开工', offRunning.action, 'heartbeat-only');
  const inHours = wake({ ...ids, ...SH, state: '空闲', now: '2024-05-01T02:00:00Z' });
  eq('上海 10:00 正常开轮', inHours.action, 'start-round');
  const userWake = wake({ ...ids, ...SH, state: '空闲', now: '2024-05-01T17:00:00Z', trigger: 'user' });
  eq('本人主动唤醒不受工作时段限制', userWake.action, 'start-round');
  const nightWin = wake({ ...ids, workHours: '22:00-06:00', timezone: 'Asia/Shanghai', state: '空闲', now: '2024-05-01T17:00:00Z' });
  eq('跨午夜工作窗 01:00 在窗内', [nightWin.action, nightWin.workHours.inside], ['start-round', true]);
  const splitBrain = wake({ isSelf: true, currentSessionId: 's9', ledgerControllerId: 's1', state: '执行中', runningMinutes: 10 });
  eq('旧主控标识不一致 → 退出非现任', [splitBrain.action, splitBrain.writeGuard.allowed, splitBrain.allowedWrites], ['exit-non-current', false, ['self-timer-stop']]);
  includes('拦截原因说明禁止写台账', splitBrain.writeGuard.reason, '禁止写台账');
  const takeover = wake({ currentSessionId: 's9', ledgerControllerId: 's1', state: '空闲', handoffBasis: true });
  eq('有依据无交接 → 按依据接任 + 首轮边界', [takeover.action, takeover.firstRoundBoundary, takeover.writeGuard.scope], ['take-over-by-basis', true, 'identity-only']);
  includes('首轮禁止建 PR', takeover.forbiddenWrites, 'create-pr');
  const scheduled = { ...SH, currentSessionId: 's9', ledgerControllerId: 's1', trigger: 'scheduled', handoffBasis: true, handoffComment: true };
  const waitTakeover = wake({ ...scheduled, now: '2024-05-01T17:00:00Z' });
  eq('窗外定时接任等开工且无任何写权限', [waitTakeover.action, waitTakeover.writeGuard.allowed, waitTakeover.writeGuard.allowedWrites],
    ['outside-work-hours-wait', false, []]);
  for (const verb of ['push', 'create-pr', 'change-label']) includes(`窗外自动接任禁止 ${verb}`, waitTakeover.forbiddenWrites, verb);
  const manualContinue = wake({ ...scheduled, now: '2024-05-01T17:00:00Z', manualContinue: true });
  eq('窗外明确继续保留人工接任路径', [manualContinue.action, manualContinue.writeGuard.scope], ['take-over-by-basis', 'takeover']);
  const workTakeover = wake({ ...scheduled, now: '2024-05-02T02:00:00Z' });
  eq('窗内定时唤醒按交接依据接任', workTakeover.action, 'take-over-by-basis');
  const active = wake({ currentSessionId: 's9', ledgerControllerId: 's1', state: '空闲', explicitTakeover: true });
  eq('本人明确接管 → 主动接任', [active.action, active.tableRow], ['take-over-active', 4]);

  // ---- 小巡检 ----
  const patrol = (payload) => loopctl(['eval-patrol', ...input({ mode: 'small', now: '2024-05-02T10:00:00+08:00', master: { contractVersion: 'v1' }, ...payload })], configDir).json;
  const okLedger = { id: '#201', lines: 40, sectionCount: 5, contractVersion: 'v1' };
  const okCtl = { state: '空闲', lastWakeHours: 0.2 };
  const quiet = patrol({ ledger: okLedger, controller: okCtl, changes: [] });
  eq('小巡检无事安静退出', [quiet.quiet, quiet.action, quiet.notifications.length], [true, 'quiet-exit', 0]);
  const backlog = patrol({ ledger: okLedger, controller: okCtl, changes: [{ repo: 'acme/core-svc', id: 3, idleHours: 5, labels: [], url: 'https://forge.example/acme/core-svc/3' }] });
  eq('4h 压单被识别并带链接', [backlog.findings[0].code, backlog.findings[0].url], ['MR_IDLE_WARN', 'https://forge.example/acme/core-svc/3']);
  const dedup = patrol({ ledger: okLedger, controller: okCtl, sentKeys: backlog.newKeys, changes: [{ repo: 'acme/core-svc', id: 3, idleHours: 5, labels: [], url: 'https://forge.example/acme/core-svc/3' }] });
  eq('sentKeys 去重后不再重复提醒', [dedup.quiet, dedup.notifications.length, dedup.suppressedKeys], [true, 0, backlog.newKeys]);
  const overnight = patrol({ ...SH, now: '2024-05-02T10:00:00+08:00', ledger: okLedger, controller: okCtl, changes: [{ repo: 'acme/core-svc', id: 4, updatedAt: '2024-05-01T18:30:00+08:00', labels: [] }] });
  eq('18:30→次日 10:00 只计 1.5 工作小时不误报压单', overnight.quiet, true);
  const longIdle = patrol({ ...SH, now: '2024-05-02T10:00:00+08:00', ledger: okLedger, controller: okCtl, changes: [{ repo: 'acme/core-svc', id: 5, updatedAt: '2024-05-01T13:00:00+08:00', labels: [] }] });
  eq('13:00→次日 10:00 计 7 工作小时', [longIdle.findings[0]?.code, longIdle.findings[0]?.idleHours], ['MR_IDLE_WARN', 7]);
  const objLabels = patrol({ ledger: okLedger, controller: okCtl, changes: [{ repo: 'acme/web-app', id: 6, idleHours: 9, labels: [{ name: '待终审' }] }] });
  eq('GitHub 对象标签识别为已送审', objLabels.quiet, true);
  const bloat = patrol({ ledger: { ...okLedger, lines: 82 }, controller: okCtl });
  eq('80 行膨胀发【纠偏】', [bloat.findings[0].code, bloat.corrections.length], ['LEDGER_BLOAT', 1]);
  includes('纠偏文案含 80 行', bloat.corrections[0], '80 行');
  const broken = patrol({ ledger: { ...okLedger, staleHours: 999, sectionCount: 6 }, controller: okCtl });
  eq('多节 + 长期无变化同时报出', broken.findings.map((f) => f.code), ['LEDGER_STRUCTURE', 'LEDGER_STALE']);
  const missing = patrol({ ledger: { ...okLedger, sectionCount: 4 }, controller: okCtl });
  eq('缺节同样报出', missing.findings.map((f) => f.code), ['LEDGER_STRUCTURE']);
  const generated = patrol({ ledger: { body: init.json.ledgers[0].body }, controller: okCtl });
  eq('L2 初始化生成的实际章节通过巡检', generated.quiet, true);
  const badHeadings = '## 一\n## 二\n## 三\n## 四\n## 五';
  const wrongTitles = patrol({ ledger: { sectionCount: 5, body: badHeadings }, controller: okCtl });
  eq('L2 同节数错标题也报出', wrongTitles.findings.map((f) => f.code), ['LEDGER_STRUCTURE']);
  const l1Body = '## 基本信息\n## 当前任务\n## 变更与终审\n## 收尾';
  eq('L1 四个指定章节通过', patrol({ tier: 'L1', ledger: { body: l1Body }, controller: okCtl }).quiet, true);
  eq('L1 四节仍需核对标题', patrol({ tier: 'L1', ledger: { body: l1Body.replace('变更与终审', '其他') }, controller: okCtl }).findings.map((f) => f.code), ['LEDGER_STRUCTURE']);
  const reviewWait = patrol({ ledger: okLedger, controller: okCtl, changes: [{ repo: 'acme/core-svc', id: 8, reviewWaitHours: 25, labels: ['待终审'] }] });
  eq('待终审满 24 工作小时提醒', reviewWait.findings.map((f) => f.code), ['REVIEW_WAIT_WARN']);
  const lag = patrol({ ledger: { ...okLedger, externalDocs: [{ url: 'https://docs.example/x', landedInItems: false }] }, master: { contractVersion: 'v2' }, controller: okCtl });
  eq('契约滞后 + 外部文档未落五项', lag.findings.map((f) => f.code), ['CONTRACT_LAG', 'EXTERNAL_DOC_NOT_LANDED']);
  const stuck = patrol({ ledger: okLedger, controller: { state: '执行中', runningHours: 2.5, generation: 3 } });
  eq('2h 卡住要求拉新主控', [stuck.findings[0].code, stuck.findings[0].pullNewController], ['CONTROLLER_STUCK', true]);
  const stuckNight = patrol({ ...SH, now: '2024-05-01T17:00:00Z', controller: { state: '执行中', runningHours: 3, generation: 3 } });
  eq('窗外小巡检不报卡住或要求换主控', [stuckNight.quiet, stuckNight.findings.some((f) => f.code === 'CONTROLLER_STUCK' || f.pullNewController)], [true, false]);
  const lost = patrol({ ledger: okLedger, controller: { state: '空闲', lastWakeHours: 1.5, generation: 4 } });
  eq('2 周期失联被识别', lost.findings[0].code, 'CONTROLLER_DISCONNECTED');
  const lostNight = patrol({ ...SH, now: '2024-05-01T17:00:00Z', ledger: okLedger, controller: { state: '空闲', lastWakeHours: 5, generation: 4 } });
  eq('非工作时段小巡检不判失联', lostNight.quiet, true);
  const pausedPatrol = patrol({ ledger: { ...okLedger, staleHours: 30 }, controller: { state: '暂停（原：执行中）', runningHours: 5, lastWakeHours: 10 } });
  eq('小巡检排除个人暂停', pausedPatrol.quiet, true);

  // ---- 终审分流与自动合并门禁 ----
  const evalReview = (payload, extra = []) => loopctl(['eval-review', ...extra, ...input({
    tier: 'L2',
    forge: 'gitlab',
    autoMerge: true,
    baselineBranch: 'feat/night',
    dispatchedSessionId: 's1',
    dispatchedHeadSha: 'abc',
    review: { sessionId: 's1', conclusion: '通过', risk: '低', round: 1 },
    change: { repo: 'acme/core-svc', id: 11, headSha: 'abc', targetBranch: 'feat/night', url: 'https://forge.example/acme/core-svc/11' },
    rejectCount: 0,
    riskChecks: FULL_LOW,
    ...payload,
  })], configDir).json;

  const auto = evalReview({});
  eq('全部门禁通过 → 自动合并', [auto.action, auto.code], ['auto-merge', 'LOW_RISK_AUTO_MERGE']);
  const args = auto.merge.args;
  eq('合并参数绑定 head SHA', args[args.indexOf('--head-sha') + 1], 'abc');
  eq('合并参数绑定需求基线', args[args.indexOf('--target') + 1], 'feat/night');
  eq('合并参数沿用确认的 forge', args[args.indexOf('--forge') + 1], 'gitlab');
  includes('合并参数携带环境分支保护', args[args.indexOf('--protected-branches') + 1], 'test');
  const withDeps = evalReview({ dependsOn: [{ repo: 'acme/core-svc', id: 10, state: 'merged' }] });
  eq('合并参数携带 Depends-On 原始身份', JSON.parse(withDeps.merge.args[withDeps.merge.args.indexOf('--depends-on') + 1]),
    [{ repo: 'acme/core-svc', id: 10, state: 'merged' }]);

  const envBranch = evalReview({ change: { repo: 'acme/core-svc', id: 11, headSha: 'abc', targetBranch: 'test' } });
  eq('目标为环境分支 → 禁止自动合并', [envBranch.action, envBranch.code, envBranch.merge], ['manual-merge', 'BLOCKED_ENV_BRANCH', null]);
  eq('环境分支进入待合并', envBranch.labelPlan.add, ['风险低', '待合并']);
  const envEqBaseline = evalReview({ baselineBranch: 'main', change: { repo: 'acme/core-svc', id: 11, headSha: 'abc', targetBranch: 'main' } });
  eq('基线本身是 main 也禁止自动合并', envEqBaseline.code, 'BLOCKED_ENV_BRANCH');
  const offBaseline = evalReview({ change: { repo: 'acme/core-svc', id: 11, headSha: 'abc', targetBranch: 'feat/other' } });
  eq('目标不是需求基线 → 人工合并', offBaseline.code, 'TARGET_NOT_BASELINE');
  const shaMoved = evalReview({ change: { repo: 'acme/core-svc', id: 11, headSha: 'NEW', targetBranch: 'feat/night' } });
  eq('送审后 head 变化 → 重新送审', [shaMoved.action, shaMoved.code, shaMoved.merge], ['re-review', 'HEAD_SHA_MISMATCH', null]);
  eq('SHA 变化换回待终审', shaMoved.labelPlan.add, ['待终审']);
  const shaMissing = evalReview({ dispatchedHeadSha: null });
  eq('缺派审 SHA → 拒绝自动合并', [shaMissing.action, shaMissing.code], ['manual-merge', 'HEAD_SHA_MISMATCH']);
  const noForge = evalReview({ forge: undefined });
  eq('未确认 forge 不回退默认 gitlab', [noForge.code, noForge.merge], ['MISSING_FORGE', null]);
  const noChecks = evalReview({ riskChecks: {} });
  eq('6 条风险核验缺失 → 不默认低风险', [noChecks.action, noChecks.code, noChecks.risk.level], ['manual-merge', 'RISK_UNVERIFIED', '未核验']);
  const noDeclared = evalReview({ review: { sessionId: 's1', conclusion: '通过', round: 1 } });
  eq('缺风险结论 → 保留人工合并', noDeclared.code, 'RISK_UNVERIFIED');

  const runBlocked = evalReview({ change: { repo: 'acme/core-svc', id: 11, headSha: 'abc', targetBranch: 'main' } }, ['--req', 'night-run']);
  eq('--req 读 run 基线 main → 环境分支拦截', [runBlocked.code, runBlocked.gate.baseline], ['BLOCKED_ENV_BRANCH', 'main']);
  const chosenRun = loopctl(['init', '--req', 'gh-run', '--project', 'gh-l2', '--branch', 'feat/night',
    '--overrides', '{"protectedEnvBranches":["preprod"]}'], configDir);
  const ghRun = evalReview({ forge: undefined, change: { repo: 'web-app', id: 11, headSha: 'abc', targetBranch: 'feat/night' } }, ['--req', 'gh-run']);
  eq('--req 沿用 run 中 github 不回退 gitlab', [ghRun.action, ghRun.merge.args[ghRun.merge.args.indexOf('--forge') + 1]], ['auto-merge', 'github']);
  eq('仓库短名经 run 精确匹配后使用全名', ghRun.merge.args[ghRun.merge.args.indexOf('--repo') + 1], 'acme/web-app');
  eq('自动合并参数绑定运行态、明确基线及保护分支', ['--run', '--target', '--protected-branches'].map((key) => ghRun.merge.args[ghRun.merge.args.indexOf(key) + 1]),
    [chosenRun.json.runPath, 'feat/night', 'main,master,test,uat,preprod']);
  const unselected = evalReview({}, ['--req', 'gh-run']);
  eq('未勾选仓拒绝自动合并并保留人工路径', [unselected.action, unselected.decision, unselected.code, unselected.merge],
    ['manual-merge', 'manual-merge', 'REPO_NOT_IN_RUN', null]);
  loopctl(['init', '--req', 'manual-run', '--project', 'manual-l2', '--branch', 'feat/night'], configDir);
  const manualRun = evalReview({}, ['--req', 'manual-run']);
  eq('工程 autoMerge:false 持久化后生效', manualRun.code, 'AUTO_MERGE_DISABLED');

  const deps = evalReview({ dependsOn: [{ repo: 'acme/core-svc', id: 10, state: 'opened' }] });
  eq('未合 Depends-On 拦截自动合并', [deps.action, deps.code, deps.labelPlan.add.includes('待合并')], ['pending-merge', 'DEPENDS_ON_UNMERGED', true]);
  const conflict = evalReview({ conflict: true });
  eq('合并冲突转需修改', [conflict.action, conflict.code], ['needs-changes', 'MERGE_CONFLICT']);
  const fusePass = evalReview({ rejectCount: 2 });
  eq('k=2 全量重审通过 → 交人裁决', [fusePass.action, fusePass.fullReReview, fusePass.labelPlan.add], ['await-human-verdict', true, ['待合并']]);
  includes('台账第 2 节登记待裁决', fusePass.ledger.section2, '[待裁决]');
  const fuseReject = evalReview({ rejectCount: 2, review: { sessionId: 's1', conclusion: '打回', risk: '低', round: 1 } });
  eq('k=2 全量重审再打回仍进待裁决', [fuseReject.action, fuseReject.code, fuseReject.labelPlan.add], ['await-human-verdict', 'REJECT_FUSE_FULL_REVIEW', ['待合并']]);
  eq('熔断打回计数照常累加', fuseReject.rejectCountAfter, 3);
  eq('熔断再打回仍计划记录评论', fuseReject.actions, [{ kind: 'comment', body: '打回第 3 次' }]);
  includes('熔断再打回仍进入待裁决', fuseReject.ledger.section2, '[待裁决]');
  const stale = evalReview({ review: { sessionId: 's-old', conclusion: '通过', risk: '低', round: 1 } });
  eq('旧终审会话结论作废静默', [stale.action, stale.code, stale.silent], ['discard', 'STALE_REVIEW_SESSION', true]);
  const roundMismatch = evalReview({ currentRound: 2 });
  eq('旧轮次结论作废', [roundMismatch.action, roundMismatch.code], ['discard', 'ROUND_MISMATCH']);
  for (const key of Object.keys(FULL_LOW)) {
    const r = evalReview({ riskChecks: { ...FULL_LOW, [key]: true } });
    eq(`6 条高风险规则命中走手合：${key}`, [r.risk.level, r.action], ['高', 'manual-merge']);
  }
  const rejected = evalReview({ review: { sessionId: 's1', conclusion: '打回', risk: '低', round: 1 } });
  eq('终审打回转需修改 + 计数', [rejected.action, rejected.rejectCountAfter, rejected.comment], ['needs-changes', 1, '打回第 1 次']);

  // ---- 拆架：阻断、强制、未知 worktree、失败重试 ----
  const worktreeDir = path.join(tmp, 'worktrees', 'wt-1');
  fs.mkdirSync(worktreeDir, { recursive: true });
  patchRun(configDir, 'night-run', (run) => {
    run.changes = [{ repo: 'acme/core-svc', id: 9, state: 'opened', title: 'feat: 跨夜变更', url: 'https://forge.example/acme/core-svc/9' }];
    run.worktrees = [worktreeDir];
    run.blockers = [{ id: 'B-1', title: '契约未冻结', state: 'open', closed: false }];
  });
  const blocked = loopctl(['teardown', '--req', 'night-run'], configDir);
  eq('未结 MR 与阻断阻止拆架', [blocked.code, blocked.json.status, blocked.json.blocked.map((b) => b.kind)], [3, 'blocked', ['change', 'blocker']]);
  const planned = loopctl(['teardown', '--req', 'night-run', '--force'], configDir);
  eq('--force 只出清单不删 run', [planned.code, planned.json.phase, planned.json.forced], [0, 'planned', true]);
  eq('清单含 2 个定时任务', planned.json.scheduledTasksToStop.length, 2);
  eq('非 git 目录标 unknown 而非已移除', planned.json.worktrees[0].status, 'unknown');
  ok('第 1 步后 run 仍在', fs.existsSync(path.join(configDir, 'runs', 'night-run.json')));
  const taskResults = Object.fromEntries(init.json.scheduledTasks.map((t) => [t.id, { stopped: true }]));
  const partial = loopctl(['teardown', '--req', 'night-run', '--finalize', '--results', JSON.stringify({ tasks: taskResults, ledgers: { main: { closed: true } } })], configDir);
  eq('unknown worktree 未确认 → 拒绝归档', [partial.code, partial.json.code], [3, 'TEARDOWN_INCOMPLETE']);
  includes('失败原因写明 git 状态未知', partial.json.failures, 'git 状态未知');
  const lie = loopctl(['teardown', '--req', 'night-run', '--finalize', '--results', JSON.stringify({ worktrees: { [worktreeDir]: { removed: true } } })], configDir);
  includes('回执已删但目录仍在 → 继续拒绝', lie.json.failures, '目录仍存在');
  ok('多次失败后 run 仍可重试', fs.existsSync(path.join(configDir, 'runs', 'night-run.json')));
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  const replanTeardown = loopctl(['teardown', '--req', 'night-run', '--live', '{"openChanges":[],"openBlockers":[],"openBugs":[]}'], configDir);
  eq('重出清单保留原 unknown 状态及已有强制豁免', [replanTeardown.json.worktrees[0].dirty, replanTeardown.json.forcedWaivers.length], [null, 2]);
  const unverified = loopctl(['teardown', '--req', 'night-run', '--finalize', '--results', '{}'], configDir);
  includes('unknown 目录即使已删除仍要求核实干净回执', unverified.json.failures, 'verifiedClean');
  const finalOk = loopctl(['teardown', '--req', 'night-run', '--finalize', '--results', JSON.stringify({ worktrees: { [worktreeDir]: { removed: true, verifiedClean: true } } })], configDir);
  eq('实际清理和核实后重试可归档，历史强制豁免保留', [finalOk.code, finalOk.json.status, finalOk.json.zeroResidue, finalOk.json.forced], [0, 'archived', false, true]);
  eq('未读到业务仓状态如实记录', finalOk.json.unverifiedItems.map((item) => item.status), ['unknown']);
  eq('归档中的强制豁免包含原未结变更和阻断', finalOk.json.forcedWaivers.map((item) => item.kind), ['change', 'blocker']);
  const readArchive = loopctl(['teardown', '--req', 'night-run'], configDir);
  eq('重读归档不能变成零残留', [readArchive.json.alreadyArchived, readArchive.json.zeroResidue, readArchive.json.forcedWaivers.length], [true, false, 2]);
  ok('L2 归档文件存在', fs.existsSync(path.join(configDir, 'runs', 'archive', 'night-run.json')));
}

/* ================================================================== */
/* 场景 4：L3 团队严格档                                                  */
/* ================================================================== */

function leadPatrolInput(now) {
  return {
    mode: 'lead',
    tier: 'L3',
    now,
    timezone: 'Asia/Shanghai',
    lead: { person: 'lead-dev', openId: 'ou_lead' },
    memberOpenIds: { 'lead-dev': 'ou_lead', 'dev-a': 'ou_dev_a', 'dev-b': 'ou_dev_b' },
    master: { stage: 'P3', contractVersion: 'v3' },
    p3: {
      slots: [
        { slot: 'A', person: 'dev-a', openId: 'ou_dev_a', paused: true, pausedHours: 9, updatingExternalDocs: true },
        { slot: 'B', person: 'dev-b', openId: 'ou_dev_b', paused: false, hoursSinceLastOutput: 9, newChanges24h: 0, newEscalations24h: 0 },
      ],
    },
    ledgers: [{ slot: 'A', person: 'dev-a', openId: 'ou_dev_a', lines: 95, correctionIneffective: true, contractVersion: 'v2' }],
    changes: [{ repo: 'acme/core-svc', id: 7, idleHours: 9, labels: [], person: 'dev-c', openId: '', url: 'https://forge.example/acme/core-svc/7' }],
    externalDocs: [{ url: 'https://docs.example/p3-design', landedInItems: false, slot: 'A', person: 'dev-a', openId: 'ou_dev_a' }],
    mentionWindow: '09:00-19:00',
  };
}

function scenario4(tmp) {
  group('4. L3 团队严格档（个人台账任务 + 抢槽 + 大巡检 + 回执拆架）');
  const repoDir = path.join(tmp, 'repo-l3');
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '-q', '-b', 'main'], repoDir);
  const configDir = setupConfig(tmp, {
    'squad.yaml': simpleProject({ forge: 'gitlab', tier: 'L3', name: 'squad-api', repo: 'acme/squad-api', repoPath: repoDir, extra: ['slots:', '  - 主研发', '  - A', '  - B'] }),
  });

  const init = loopctl(['init', '--req', 'squad-run', '--project', 'squad', '--slots', '主研发,A,B', '--issue-map', '{"master":"#300","slot:主研发":"#301"}'], configDir);
  eq('L3 init 退出码 0', init.code, 0);
  eq('L3 台账：总台账 + 主研发小台账 + 升级', init.json.ledgers.map((l) => l.kind), ['master', 'slot', 'escalation']);
  eq('主研发小台账标题', init.json.ledgers[1].title, '【小台账】主研发-lead-dev');
  includes('总台账含各开发者表', init.json.ledgers[0].body, '## 3. 各开发者');
  includes('协作者槽位等加入时自建小台账', init.json.ledgers[0].body, '加入时本人自建');
  eq('日报未启用时不建日报任务', init.json.scheduledTasks.map((t) => t.role), ['controller', 'patrol', 'dispatch', 'lead-patrol']);
  eq('个人主控/小巡检绑定个人小台账', init.json.scheduledTasks.slice(0, 2).map((t) => t.ledgerRef), ['#301', '#301']);
  eq('调度/大巡检绑定总台账', init.json.scheduledTasks.slice(2).map((t) => t.ledgerRef), ['#300', '#300']);
  includes('定时任务描述固定尾句', init.json.scheduledTasks[0].description, '以台账为准');
  includes('定时任务描述显式指向 Skill 与角色入口文件', init.json.scheduledTasks[0].description, '使用 $xxn-lite-loop（必读 references/controller.md）');
  includes('调度任务描述指向 review-and-dispatch.md', init.json.scheduledTasks[2].description, 'references/review-and-dispatch.md');
  excludes('定时任务描述不写当前阶段', init.json.scheduledTasks[0].description, 'P0');
  includes('L3 标签含槽位标签', init.json.labels, '槽位A');

  const daily = loopctl(['preview-init', '--req', 'squad-daily', '--project', 'squad', '--overrides', JSON.stringify({ notify: { dailyReportEnabled: true, dailyReportTime: '11:30' } })], configDir);
  const dailyTask = daily.json.plan.scheduledTasks.find((t) => t.role === 'lead-daily');
  eq('显式启用日报才生成且用配置时间', dailyTask?.at, '11:30');
  includes('确认单节奏显示日报时间', daily.json.confirmSheet[4], '日报11:30');

  const cn = (req) => loopctl(['preview-init', '--req', req, '--project', 'squad', '--overrides', '{"user":"测试用户"}'], configDir).json.plan.scheduledTasks[0].id;
  const exportId = cn('导出需求');
  const searchId = cn('搜索需求');
  ok('中文需求名任务 ID 不撞名', exportId !== searchId, `${exportId} vs ${searchId}`);
  ok('中文任务 ID 为纯 ASCII', /^[\x21-\x7e]+$/.test(exportId), exportId);
  eq('同名需求任务 ID 稳定', cn('导出需求'), exportId);

  const claim = (payload) => loopctl(['slot-claim', ...input(payload)], configDir).json;
  const claimCli = (payload) => loopctl(['slot-claim', '--slot', 'A', ...input(payload)], configDir);
  const flagOnly = claimCli({ claims: [] });
  eq('--slot 可独立提供槽位', [flagOnly.code, flagOnly.json.slot], [0, 'A']);
  eq('--slot 覆盖输入中的不同槽位', claimCli({ slot: 'B', claims: [] }).json.slot, 'A');
  eq('未提供槽位仍明确报错', claim({ claims: [] }).code, 'MISSING_SLOT');
  const early = claim({
    slot: '槽位A',
    currentSessionId: 's2',
    claims: [
      { slot: 'A', sessionId: 's2', user: 'dev-b', commentId: 11, createdAt: '2024-05-01T10:00:05+08:00' },
      { slot: 'A', sessionId: 's1', user: 'dev-a', commentId: 10, createdAt: '2024-05-01T10:00:00+08:00' },
    ],
  });
  eq('同槽最早未撤回胜出，后到者撤回', [early.winner.sessionId, early.action, early.currentWins, early.ledgerAction], ['s1', 'withdraw-binding', false, 'none']);
  const mixed = claim({
    slot: 'A',
    currentSessionId: 's2',
    claims: [
      { slot: 'B', sessionId: 's0', user: 'dev-c', commentId: 5, createdAt: '2024-05-01T09:59:00+08:00' },
      { slot: '槽位A', sessionId: 's2', user: 'dev-b', commentId: 11, createdAt: '2024-05-01T10:00:05+08:00' },
    ],
  });
  eq('他槽更早绑定不影响本槽', [mixed.winner.sessionId, mixed.currentWins, mixed.ignored], ['s2', true, 1]);
  eq('取得绑定后才建小台账', mixed.ledgerAction, 'create-ledger-after-bind');
  const sameSecond = claim({
    slot: 'A',
    currentSessionId: 's-small',
    claims: [
      { slot: 'A', sessionId: 's-big', commentId: '1000', createdAt: '2024-05-01T10:00:00+08:00' },
      { slot: 'A', sessionId: 's-small', commentId: '999', createdAt: '2024-05-01T10:00:00+08:00' },
    ],
  });
  eq('同秒按数字评论 ID 排序（999 < 1000）', [sameSecond.winner.sessionId, sameSecond.currentWins], ['s-small', true]);
  const withdrawal = claim({
    slot: 'A',
    currentSessionId: 's2',
    claims: [
      { slot: 'A', sessionId: 's1', commentId: '1', createdAt: '2024-05-01T10:00:00+08:00' },
      { slot: 'A', sessionId: 's2', commentId: '2', createdAt: '2024-05-01T10:00:05+08:00' },
    ],
    withdrawals: [{ slot: 'B', commentId: '1' }],
  });
  eq('他槽撤回不作用于本槽', withdrawal.winner.sessionId, 's1');
  const withdrawnA = claim({
    slot: 'A',
    currentSessionId: 's2',
    claims: [
      { slot: 'A', sessionId: 's1', commentId: '1', createdAt: '2024-05-01T10:00:00+08:00' },
      { slot: 'A', sessionId: 's2', commentId: '2', createdAt: '2024-05-01T10:00:05+08:00' },
    ],
    withdrawals: [{ slot: 'A', commentId: '1' }],
  });
  eq('本槽撤回后次早者胜出', withdrawnA.winner.sessionId, 's2');

  const lead = (payload) => loopctl(['eval-patrol', ...input(payload)], configDir).json;
  const late = lead(leadPatrolInput('2024-05-01T23:30:00+08:00'));
  eq('大巡检 6 项客观探针', late.findings.map((f) => f.code), ['P3_PAUSE_EXCEEDED', 'P3_SILENT', 'MR_IDLE_ESCALATE', 'LEDGER_BLOAT_ESCALATE', 'CONTRACT_LAG_LEAD', 'EXTERNAL_DOC_GAP']);
  eq('23:30 群 @ 全部延后', [late.action, late.mentions.length, late.deferredMentions.length], ['defer', 0, 7]);
  includes('延后到次日工作时段', late.deferredMentions[0].deferredUntil, '2024-05-02T09:00');
  eq('无 openId 只落 Forge 不发空 @', late.forgeOnly.map((m) => m.person), ['dev-c']);
  const p3Pause = late.deferredMentions.filter((m) => m.code === 'P3_PAUSE_EXCEEDED').map((m) => m.person);
  eq('P3 长期暂停同时 @ 涉事人与主研发', p3Pause, ['dev-a', 'lead-dev']);
  eq('P3 零产出同时 @ 涉事人与主研发', late.deferredMentions.filter((m) => m.code === 'P3_SILENT').map((m) => m.person), ['dev-b', 'lead-dev']);
  const morning = lead(leadPatrolInput('2024-05-02T10:30:00+08:00'));
  eq('10:30 即时 @ 7 条', [morning.action, morning.mentions.length, morning.deferredMentions.length], ['notify', 7, 0]);
  const repeat = lead({ ...leadPatrolInput('2024-05-02T11:00:00+08:00'), sentKeys: morning.newKeys });
  eq('同日 sentKeys 去重不刷屏', [repeat.quiet, repeat.mentions.length], [true, 0]);
  const nextDay = lead({ ...leadPatrolInput('2024-05-03T10:30:00+08:00'), sentKeys: morning.newKeys });
  eq('同一批未变化问题跨日不重复提醒', [nextDay.quiet, nextDay.mentions.length, nextDay.suppressedKeys], [true, 0, morning.newKeys]);
  const blocking = { mode: 'lead', escalations: [{ id: 'block-A-1', blocking: true, hours: 5 }] };
  const firstBlock = lead({ ...blocking, now: '2024-05-02T10:30:00+08:00' });
  const repeatingBlock = lead({ ...blocking, now: '2024-05-03T10:30:00+08:00', sentKeys: firstBlock.newKeys });
  eq('阻断超时跨日仍用同一问题键', [firstBlock.newKeys, repeatingBlock.newKeys, repeatingBlock.suppressedKeys],
    [['BLOCK_ESCALATE:block-A-1'], [], ['BLOCK_ESCALATE:block-A-1']]);
  const dailyFirst = lead({ mode: 'lead', dailyReport: true, now: '2024-05-02T10:30:00+08:00' });
  const dailyRepeat = (now) => lead({ mode: 'lead', dailyReport: true, now, sentKeys: dailyFirst.newKeys });
  eq('日报用日期键，同日去重，次日仍应生成', [
    dailyFirst.newKeys, dailyRepeat('2024-05-02T17:00:00+08:00').newKeys, dailyRepeat('2024-05-03T10:30:00+08:00').newKeys,
  ], [['daily-report:2024-05-02'], [], ['daily-report:2024-05-03']]);
  const shanghai = lead({ ...leadPatrolInput('2024-05-02T01:00:00Z') });
  eq('01:00Z 在上海为 09:00 窗内放行', [shanghai.window.inside, shanghai.window.now.slice(0, 16)], [true, '2024-05-02T09:00']);
  const utc = lead({ ...leadPatrolInput('2024-05-02T01:00:00Z'), timezone: 'UTC' });
  eq('同一时刻按 UTC 为窗外', utc.window.inside, false);
  const crossMidnight = lead({ ...leadPatrolInput('2024-05-02T01:00:00+08:00'), mentionWindow: '22:00-06:00' });
  eq('跨午夜提醒窗 01:00 在窗内', crossMidnight.window.inside, true);
  const noMap = lead({ ...leadPatrolInput('2024-05-02T10:30:00+08:00'), memberOpenIds: undefined });
  eq('没有人名映射时本人上报 ID 也只能落 Forge', [noMap.mentions.length, noMap.forgeOnly.length], [0, 8]);
  const idArray = lead({ ...leadPatrolInput('2024-05-02T10:30:00+08:00'), memberOpenIds: ['ou_lead', 'ou_dev_a'] });
  eq('仅 ID 列表无法证明人与 openId 的映射', [idArray.mentions.length, idArray.forgeOnly.length], [0, 8]);
  const whitelist = lead({ ...leadPatrolInput('2024-05-02T10:30:00+08:00'), memberOpenIds: { 'different-person': 'ou_dev_a', 'lead-dev': 'ou_lead', 'dev-b': 'ou_dev_a' } });
  eq('只给准确匹配人名和 openId 的成员发 mention', [...new Set(whitelist.mentions.map((m) => m.person))], ['lead-dev']);
  eq('同 openId 属于别人或给错 ID 都只留 Forge 证据', [...new Set(whitelist.forgeOnly.map((m) => m.person))], ['dev-a', 'dev-b', 'dev-c']);
  const customNotify = { notify: { feishuGroupChatId: 'oc_demo_group', externalMentionWindow: '10:00-16:00' } };
  const resolvedWindow = loopctl(['config-resolve', '--project', 'squad', '--overrides', JSON.stringify(customNotify)], configDir);
  const confirmWindow = loopctl(['preview-init', '--req', 'window', '--project', 'squad', '--overrides', JSON.stringify(customNotify)], configDir);
  eq('notify.externalMentionWindow 成为实际提醒阈值', resolvedWindow.json.thresholds.externalMentionWindow, { start: '10:00', end: '16:00' });
  includes('确认单显示实际提醒窗', confirmWindow.json.confirmSheet[4], '限10:00-16:00@');
  const configuredLead = (now) => lead({ ...leadPatrolInput(now), mentionWindow: undefined, thresholds: resolvedWindow.json.thresholds });
  eq('09:30 按配置延后，10:00 群提醒放行', [
    configuredLead('2024-05-02T09:30:00+08:00').deferredMentions.length,
    configuredLead('2024-05-02T10:00:00+08:00').mentions.length,
  ], [7, 7]);
  const goodBody = init.json.ledgers[1].body;
  const badBody = goodBody.replace('近期完成与挂起', '其他章节');
  const bodyFindings = (body, correctionIneffective) => lead({
    mode: 'lead', tier: 'L3', now: '2024-05-02T10:30:00+08:00',
    ledgers: [{ slot: 'A', lines: 30, body, correctionIneffective }],
  }).findings.map((f) => f.code);
  eq('未超行且同节数错标题，大巡检仍升级', bodyFindings(badBody, true), ['LEDGER_STRUCTURE_ESCALATE']);
  eq('章节缺失同样升级', bodyFindings(goodBody.split('## 5.')[0], true), ['LEDGER_STRUCTURE_ESCALATE']);
  eq('章节正常或纠偏仍有效时不升级', [bodyFindings(goodBody, true), bodyFindings(badBody, false)], [[], []]);
  const overnightPause = lead({
    mode: 'lead', now: '2024-05-02T10:00:00+08:00', timezone: 'Asia/Shanghai', workHours: '09:00-19:00',
    p3: { slots: [{ slot: 'A', person: 'dev-a', openId: 'ou_dev_a', paused: true, pausedAt: '2024-05-01T18:30:00+08:00' }] },
  });
  eq('暂停按工作时段累计 1.5h 不误报', overnightPause.quiet, true);
  const leadQuiet = lead({ mode: 'lead', now: '2024-05-02T10:30:00+08:00', master: { contractVersion: 'v1' }, p3: { slots: [] } });
  eq('大巡检无变化安静退出', [leadQuiet.quiet, leadQuiet.action], [true, 'quiet-exit']);

  const worktreeDirs = ['clean', 'dirty', 'keep'].map((name) => path.join(tmp, name));
  const [clean, dirty, keep] = worktreeDirs;
  for (const dir of worktreeDirs) {
    fs.mkdirSync(dir);
    git(['init', '-q', '-b', 'main'], dir);
  }
  write(path.join(dirty, 'pending.txt'), '临时未提交内容');
  patchRun(configDir, 'squad-run', (run) => {
    run.changes = [{ repo: 'acme/squad-api', id: 50, state: 'opened' }];
    run.blockers = [{ id: 51, closed: false }];
    run.bugs = [{ id: 52, closed: false }];
    run.worktrees = worktreeDirs;
  });
  const teardown = (args = []) => loopctl(['teardown', '--req', 'squad-run', ...args], configDir);
  const finalize = (results) => teardown(['--finalize', '--results', JSON.stringify(results)]);
  eq('旧快照三类未结项阻塞', teardown().json.blocked.map((item) => item.kind), ['change', 'blocker', 'bug']);
  eq('未出计划时不能直接归档', finalize({}).json.code, 'TEARDOWN_NOT_PLANNED');
  const live = { openChanges: [], openBlockers: [], openBugs: [], ledgers: [{ slot: 'A', id: 303, user: 'dev-a' }] };
  const newBlocker = teardown(['--live', JSON.stringify({ ...live, openBlockers: [{ id: 53 }] })]);
  eq('实时事实新增的未结项仍阻塞', [newBlocker.code, newBlocker.json.blocked.map((item) => item.id)], [3, [53]]);
  const plan = teardown(['--live', JSON.stringify(live)]);
  eq('--live 覆盖三类过期快照后无需强制即可预检', [plan.code, plan.json.status, plan.json.forced, fs.existsSync(init.json.runPath)],
    [0, 'planned', false, true]);
  eq('L3 拆架清单标记协作者台账对应槽位已认领', plan.json.receipts.map((r) => [r.slot, r.claimed]), [['A', true], ['B', false]]);
  eq('L3 完结评论合并本机和实查的协作者台账', plan.json.closingComments.map((c) => c.key), ['master', 'slot:主研发', 'slot:A']);
  eq('工作树预检保留真实干净及脏状态', plan.json.worktrees.map((item) => item.dirty), [false, true, false]);
  const freshOpen = teardown(['--live', JSON.stringify({ ...live, openBugs: [{ id: 54 }] })]);
  eq('重查发现新未结项时旧清单已失效', [freshOpen.code, finalize({}).json.code], [3, 'TEARDOWN_NOT_PLANNED']);
  eq('修正实时清单后可重新进入计划', teardown(['--live', JSON.stringify(live)]).json.status, 'planned');

  const wrongTypes = finalize({
    tasks: Object.fromEntries(init.json.scheduledTasks.map((t) => [t.id, { closed: true }])),
    ledgers: { master: { stopped: true } },
    receipts: { A: { unclaimed: true }, B: { unclaimed: true } },
    worktrees: { [keep]: { keep: true, reason: '  ' } },
  });
  eq('拆架拒绝任务、台账、已认领槽位、无原因保留的错位回执', [
    wrongTypes.code, [...new Set(wrongTypes.json.failures.map((f) => f.kind))],
  ], [3, ['scheduled-task', 'remote-scheduled-task', 'issue-close', 'worktree']]);
  eq('已认领和未认领分别验回执', wrongTypes.json.failures.filter((f) => f.kind === 'remote-scheduled-task').map((f) => f.id), ['A']);
  fs.rmSync(clean, { recursive: true, force: true });
  fs.rmSync(dirty, { recursive: true, force: true });
  const results = {
    tasks: Object.fromEntries(init.json.scheduledTasks.map((t) => [t.id, { status: 'stopped' }])),
    ledgers: { master: { status: 'closed' }, 'slot:主研发': { closed: true }, 'slot:A': { closed: true } },
    receipts: { A: { stopped: true, confirmedBy: ' ' } },
    worktrees: { [clean]: { removed: true }, [dirty]: { removed: true }, [keep]: { keep: true, reason: '保留调试记录' } },
  };
  const noReceipt = finalize(results);
  eq('真实删掉脏目录仍需确认放弃改动，已认领槽也需非空负责人', [noReceipt.code, noReceipt.json.failures.map((f) => f.id)],
    [3, ['A', dirty]]);
  includes('脏工作树失败项明确缺 confirmedDiscard', noReceipt.json.failures, 'confirmedDiscard');
  const archived = finalize({
    receipts: { A: { stopped: true, confirmedBy: 'dev-a' } },
    worktrees: { [dirty]: { removed: true, confirmedDiscard: true } },
  });
  eq('实时核实后无需强制就可归档，有保留项不报零残留', [archived.code, archived.json.status, archived.json.zeroResidue, archived.json.forcedWaivers],
    [0, 'archived', false, []]);
  eq('归档如实记录保留路径及原因', readJson(archived.json.archivePath).teardown.retainedItems,
    [{ kind: 'worktree', path: keep, status: 'clean', reason: '保留调试记录' }]);
}

/* ================================================================== */
/* 场景 5：逐级升档（计划 / 确认分离、保留确认配置、幂等重试）               */
/* ================================================================== */

function scenario5(tmp) {
  group('5. 逐级升档（L1 → L2 → L3，计划与确认分离）');
  const repoDir = path.join(tmp, 'repo-upgrade');
  fs.mkdirSync(repoDir, { recursive: true });
  const configDir = setupConfig(tmp, { 'gh-tool.yaml': simpleProject({ forge: 'github', tier: 'L1', name: 'gh-tool', repo: 'acme/gh-tool', repoPath: repoDir }) });
  const runPath = path.join(configDir, 'runs', 'upgrade-run.json');
  const upgrade = (args) => loopctl(['upgrade', '--req', 'upgrade-run', ...args], configDir);
  const allDone = (res) => JSON.stringify(Object.fromEntries(res.json.forgeObjects.map((a) => [a.id, true])));

  const init = loopctl(['init', '--req', 'upgrade-run', '--project', 'gh-tool', '--issue-map', '{"tracking":"#101"}'], configDir);
  eq('升档前置 L1 初始化', [init.json.tier, init.json.run.contractVersion], ['L1', null]);
  patchRun(configDir, 'upgrade-run', (run) => {
    run.changes = [
      { repo: 'acme/gh-tool', id: 55, state: 'merged', title: 'feat: export markdown', url: 'https://github.example/acme/gh-tool/pull/55' },
      { repo: 'acme/gh-tool', id: 56, state: 'open', title: 'feat: export csv' },
    ];
    run.review.rejectCount = 1;
  });

  const skip = upgrade(['--to', 'L3']);
  eq('禁止直接 L1→L3', [skip.code, skip.json.code], [2, 'SKIP_TIER_FORBIDDEN']);
  eq('跨档被拒不改运行态', readJson(runPath).tier, 'L1');

  const plan = upgrade(['--to', 'L2']);
  eq('L1→L2 默认只出计划', [plan.code, plan.json.phase], [0, 'planned']);
  eq('计划阶段不提前改档位', readJson(runPath).tier, 'L1');
  ok('计划写入 pendingUpgrade', readJson(runPath).pendingUpgrade?.to === 'L2');
  includes('保留原 Issue ID', plan.json.preserved.issueIds, '#101');
  eq('保留已合入计数', plan.json.preserved.mergedCount, 1);
  eq('L1→L2 新增 2 个定时任务', plan.json.addedScheduledTasks.length, 2);
  eq('未完成子任务提升为子 Issue', plan.json.forgeObjects.filter((a) => a.kind === 'issue').map((a) => a.id), ['subissue:acme/gh-tool#56']);
  eq('原追踪 Issue 升格主台账', [plan.json.nextRun.ledgers[0].key, plan.json.nextRun.issues.main.id], ['main', '#101']);
  includes('主台账保留已合入 PR 链接', plan.json.nextRun.ledgers[0].body, 'pull/55');
  eq('L2 契约版本补齐 v1', plan.json.nextRun.contractVersion, 'v1');
  const replan = upgrade(['--to', 'L2']);
  eq('外部动作未完成前重跑不锁死 SAME_TIER', [replan.code, replan.json.phase, replan.json.pending], [0, 'planned', plan.json.pending]);

  const partial = upgrade(['--to', 'L2', '--apply', '--results', '{"ledger:main":true}']);
  eq('回执不全 → 保留 pendingUpgrade', [partial.code, partial.json.code], [3, 'UPGRADE_INCOMPLETE']);
  includes('未完成项列出标签同步', partial.json.pending, 'labels:sync');
  eq('回执不全不改档位', readJson(runPath).tier, 'L1');
  const applied = upgrade(['--to', 'L2', '--apply', '--results', allDone(plan)]);
  eq('回执齐全落盘 L2', [applied.code, applied.json.phase, readJson(runPath).tier], [0, 'applied', 'L2']);
  ok('落盘后清除 pendingUpgrade', readJson(runPath).pendingUpgrade === undefined);
  eq('L1 未显式配置 → 升 L2 开启自动合并', readJson(runPath).autoMerge, true);
  eq('L1→L2 同步成 brief 契约', readJson(runPath).contracts, 'brief');
  eq('历史打回计数保留', readJson(runPath).review.rejectCount, 1);

  patchRun(configDir, 'upgrade-run', (run) => {
    run.thresholds.controllerLoopMinutes = 43;
  });
  const p3 = upgrade(['--to', 'L3', '--slots', '主研发,A']);
  eq('L2→L3 保留已确认 43m 主控周期', p3.json.scheduledTasks.find((t) => t.role === 'controller').everyMinutes, 43);
  eq('调度周期同样沿用 43m', p3.json.scheduledTasks.find((t) => t.role === 'dispatch').everyMinutes, 43);
  eq('L2→L3 新增调度与大巡检（日报未启用）', p3.json.addedScheduledTasks.map((t) => t.role), ['dispatch', 'lead-patrol']);
  includes('主控任务改绑个人小台账需更新', p3.json.forgeObjects.map((a) => a.id), 'task:update:');
  eq('L2→L3 只补建主研发小台账与升级 Issue', p3.json.forgeObjects.filter((a) => a.kind === 'issue').map((a) => a.key), ['slot:主研发', 'escalation']);
  const pendingApply = (issueMap, receipts) => upgrade(['--to', 'L3', '--apply',
    ...(issueMap ? ['--issue-map', JSON.stringify(issueMap)] : []), '--results', JSON.stringify(receipts)]);
  const allReceipts = JSON.parse(allDone(p3));
  const noIds = pendingApply(null, allReceipts);
  eq('L2→L3 仅提交完成布尔值无法跳过两个 Issue 编号', [noIds.code, noIds.json.code, readJson(runPath).tier], [3, 'UPGRADE_INCOMPLETE', 'L2']);
  eq('缺少两个编号的计划仍列出实际建单动作', noIds.json.pending.filter((id) => id.startsWith('issue:')), ['issue:slot:主研发', 'issue:escalation']);
  const placeholders = pendingApply({ personalLedger: '待建', upgrade: 103 }, {});
  eq('个人台账占位符不通过 apply', placeholders.json.pending.filter((id) => id.startsWith('issue:')), ['issue:slot:主研发']);
  const upgradePlaceholder = pendingApply({ personalLedger: 102, upgrade: '待建' }, {});
  eq('升级 Issue 占位符也不通过 apply', upgradePlaceholder.json.pending.filter((id) => id.startsWith('issue:')), ['issue:escalation']);
  const actualIds = { personalLedger: '#102', upgrade: '#103' };
  const oldReceipts = pendingApply(actualIds, allReceipts);
  const taskUpdates = p3.json.forgeObjects.filter((a) => a.kind === 'scheduled-task' && a.action === 'update');
  eq('应用时才补编号，旧回执不能证明主控和巡检改绑', [oldReceipts.code, oldReceipts.json.pending], [3, taskUpdates.map((a) => a.id)]);
  eq('未改绑时运行态保留原档位和旧主台账绑定', [readJson(runPath).tier, readJson(runPath).scheduledTasks[0].ledgerRef], ['L2', '#101']);
  eq('未通过时给出新绑定的回执要求', oldReceipts.json.forgeObjects.filter((a) => !a.done).map((a) => a.required),
    [{ updated: true, ledgerId: '#102' }, { updated: true, ledgerId: '#102' }]);
  const wrongBindings = Object.fromEntries(taskUpdates.map((a) => [a.id, { updated: true, ledgerId: '#101' }]));
  const wrongReceipt = pendingApply(null, wrongBindings);
  eq('重试不带 issue-map 时仍拒绝旧编号绑定', [wrongReceipt.code, wrongReceipt.json.pending], [3, taskUpdates.map((a) => a.id)]);
  const updatedBindings = Object.fromEntries(taskUpdates.map((a) => [a.id, { updated: true, ledgerId: '102' }]));
  const l3 = pendingApply(null, updatedBindings);
  eq('L2→L3 落盘', [l3.code, l3.json.phase], [0, 'applied']);
  const final = readJson(runPath);
  eq('总台账保留原 Issue', final.issues.master.id, '#101');
  eq('L2→L3 同步成 full 契约', final.contracts, 'full');
  eq('落盘后阈值仍为 43m', final.thresholds.controllerLoopMinutes, 43);
  eq('L3 主控任务绑定个人小台账', final.scheduledTasks.find((t) => t.role === 'controller').ledgerRef, '#102');
  eq('L3 台账集', final.ledgers.map((l) => l.key), ['master', 'slot:主研发', 'escalation']);

  const downgrade = upgrade(['--to', 'L1']);
  eq('禁止逆向降档', [downgrade.code, downgrade.json.code, readJson(runPath).tier], [2, 'DOWNGRADE_FORBIDDEN', 'L3']);
  const repeat = upgrade(['--to', 'L3']);
  eq('完成后重复升档报 SAME_TIER', [repeat.code, repeat.json.code], [2, 'SAME_TIER']);

  loopctl(['init', '--req', 'late-master', '--project', 'gh-tool', '--tier', 'L2'], configDir);
  const upgradeLate = (args) => loopctl(['upgrade', '--req', 'late-master', '--to', 'L3', ...args], configDir);
  const latePlan = upgradeLate([]);
  const lateIssueMap = JSON.stringify({ master: 207, personalLedger: 208, upgrade: 209 });
  const lateResults = Object.fromEntries(latePlan.json.forgeObjects.map((a) => [a.id, a.action === 'update' && a.task
    ? { updated: true, ledgerId: 208 }
    : true]));
  const lateApply = (receipts) => upgradeLate(['--apply', '--issue-map', lateIssueMap, '--results', JSON.stringify(receipts)]);
  const latePending = lateApply(lateResults);
  const newTasks = latePlan.json.forgeObjects.filter((a) => a.kind === 'scheduled-task' && a.action === 'create');
  eq('迟到的总台账编号也要求新增调度任务确认绑定', [latePending.code, latePending.json.pending], [3, newTasks.map((a) => a.id)]);
  const wrongCreate = Object.fromEntries(newTasks.map((a) => [a.id, { updated: true, ledgerId: 207 }]));
  eq('新增任务不能用更新回执代替', lateApply(wrongCreate).json.pending, newTasks.map((a) => a.id));
  const rightCreate = Object.fromEntries(newTasks.map((a) => [a.id, { created: true, ledgerId: 207 }]));
  eq('新增任务确认实际总台账绑定后升档', lateApply(rightCreate).json.phase, 'applied');
}

/* ================================================================== */
/* 场景 6：双 Forge 命令、合并安全实查、标签、截断与 baseline-check          */
/* ================================================================== */

function scenario6(tmp) {
  group('6. 双 Forge 命令 + 合并实查 + 标签/截断 + baseline-check');

  const getGlab = forge(['issue-get', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '7', '--dry-run']);
  eq('gitlab issue-get 命令', getGlab.json.command, 'glab');
  includes('gitlab issue-get 路径编码', getGlab.json.args, 'projects/acme%2Fcore-svc/issues/7');
  excludes('未配置 host 时不带 --hostname', getGlab.json.args, '--hostname');
  const hostFlag = forge(['issue-get', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '7', '--hostname', 'gitlab.acme.test', '--dry-run']);
  eq('--hostname 透传到 glab api', hostFlag.json.args.slice(0, 3), ['api', '--hostname', 'gitlab.acme.test']);
  const hostEnv = forge(['change-list', '--forge', 'gitlab', '--repos', 'acme/core-svc', '--dry-run'], { GITLAB_HOST: 'gitlab.env.test' });
  includes('GITLAB_HOST 透传到 glab api', hostEnv.json.args, 'gitlab.env.test');

  const createGlab = forge(['issue-create', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--title', 'T', '--body', 'B', '--labels', '待终审,bug', '--dry-run']);
  includes('gitlab JSON 写入带 Content-Type', createGlab.json.args, 'Content-Type: application/json');
  eq('gitlab issue-create stdin', [JSON.parse(createGlab.json.stdin).title, JSON.parse(createGlab.json.stdin).labels], ['T', '待终审,bug']);
  const createGh = forge(['issue-create', '--forge', 'github', '--repo', 'acme/web-app', '--title', 'T', '--body', 'B', '--labels', 'bug', '--dry-run']);
  includes('github issue-create 标签', createGh.json.args, '--label');

  const updTitle = forge(['issue-update', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '7', '--title', '新标题', '--dry-run']);
  eq('gitlab issue-update 支持 --title', JSON.parse(updTitle.json.stdin), { title: '新标题' });
  const updBoth = forge(['issue-update', '--forge', 'github', '--repo', 'acme/web-app', '--id', '7', '--title', '新标题', '--body', 'B2', '--dry-run']);
  eq('github issue-update 同时改标题与正文', updBoth.json.args, ['issue', 'edit', '7', '--repo', 'acme/web-app', '--title', '新标题', '--body', 'B2']);
  const updNone = forge(['issue-update', '--forge', 'github', '--repo', 'acme/web-app', '--id', '7', '--dry-run']);
  eq('issue-update 无改动参数报错', updNone.json.code, 'MISSING_FLAG');
  const closeGlab = forge(['issue-close', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '7', '--dry-run']);
  eq('gitlab issue-close 用 state_event', [closeGlab.json.args.includes('PUT'), JSON.parse(closeGlab.json.stdin)], [true, { state_event: 'close' }]);
  const closeGh = forge(['issue-close', '--forge', 'github', '--repo', 'acme/web-app', '--id', '7', '--dry-run']);
  eq('github issue-close', closeGh.json.args, ['issue', 'close', '7', '--repo', 'acme/web-app']);
  const commentGlab = forge(['issue-comment', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '7', '--body', 'C', '--dry-run']);
  includes('gitlab issue-comment 走 notes', commentGlab.json.args, 'notes');

  const listGlab = forge(['change-list', '--forge', 'gitlab', '--repos', 'acme/core-svc,acme/web-app', '--dry-run']);
  eq('gitlab 默认逐仓查询', listGlab.json.invocations.length, 2);
  includes('gitlab 查询 state=opened', listGlab.json.invocations[0].args.join(' '), 'state=opened');
  const groupList = forge(['change-list', '--forge', 'gitlab', '--group', 'acme', '--repos', 'acme/core-svc,acme/web-app', '--dry-run']);
  includes('gitlab group 级 API 路径', groupList.json.args, 'groups/acme/merge_requests');
  eq('group 查询携带白名单', groupList.json.filterRepos, ['acme/core-svc', 'acme/web-app']);
  const listGh = forge(['change-list', '--forge', 'github', '--repos', 'acme/core-svc,acme/web-app', '--updated-after', '2024-05-01T00:00:00Z', '--dry-run']);
  eq('github 双 repo 单次检索', listGh.json.args.filter((a) => a === '--repo').length, 2);
  includes('github 增量查询带 --updated', listGh.json.args, '>=2024-05-01T00:00:00Z');

  const createChange = forge(['change-create', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--source', 'feat/x', '--target', 'feat/base', '--title', 'feat: x', '--draft', '--dry-run']);
  eq('gitlab change-create 分支与 Draft', [JSON.parse(createChange.json.stdin).source_branch, JSON.parse(createChange.json.stdin).title.startsWith('Draft:')], ['feat/x', true]);
  const labelGh = forge(['change-label', '--forge', 'github', '--repo', 'acme/web-app', '--id', '9', '--add', '风险低', '--dry-run']);
  includes('github change-label 参数', labelGh.json.args, '--add-label');

  const mergeGlab = forge(['change-merge', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '9', '--head-sha', 'abc', '--target', 'feat/base', '--depends-on', '[{"repo":"acme/core-svc","id":8,"state":"merged"}]', '--dry-run']);
  const mergeBody = JSON.parse(mergeGlab.json.steps.merge.stdin);
  eq('gitlab dry-run 合并带 sha 且禁 squash', [mergeGlab.code, mergeBody.sha, mergeBody.squash], [0, 'abc', false]);
  const { preflight, dependencyChecks, merge, verify } = mergeGlab.json.steps;
  eq('dry-run invocations 与预检、依赖、合并、读回顺序相同', mergeGlab.json.invocations, [preflight, ...dependencyChecks, merge, verify]);
  eq('通用 dry-run 命令的首步是读取变更单', [mergeGlab.json.command, mergeGlab.json.args, mergeGlab.json.stdin], [preflight.command, preflight.args, preflight.stdin]);
  includes('dry-run 输出前置读回步骤', mergeGlab.json.steps.preflight.args, 'projects/acme%2Fcore-svc/merge_requests/9');
  eq('dry-run 输出依赖逐条实查步骤', mergeGlab.json.steps.dependencyChecks.length, 1);
  eq('dry-run 依赖标未实查', mergeGlab.json.dependencies[0].verified, false);
  const mergeGh = forge(['change-merge', '--forge', 'github', '--repo', 'acme/web-app', '--id', '9', '--head-sha', 'abc', '--target', 'feat/base', '--dry-run']);
  eq('github 合并绑定 --match-head-commit', mergeGh.json.steps.merge.args.slice(-2), ['--match-head-commit', 'abc']);
  excludes('github 合并禁用 --squash', mergeGh.json.steps.merge.args, '--squash');
  for (const target of ['main', 'master', 'test', 'uat']) {
    const r = forge(['change-merge', '--forge', 'github', '--repo', 'acme/web-app', '--id', '9', '--head-sha', 'abc', '--target', target, '--dry-run']);
    eq(`环境分支 ${target} 硬拒绝`, [r.code, r.json.code], [2, 'ENV_BRANCH_FORBIDDEN']);
  }
  const customProtected = forge(['change-merge', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '9', '--head-sha', 'abc', '--target', 'release', '--protected-branches', 'release', '--dry-run']);
  eq('--protected-branches 自定义环境分支拒绝', customProtected.json.code, 'ENV_BRANCH_FORBIDDEN');
  const noSha = forge(['change-merge', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '9', '--target', 'feat/base', '--dry-run']);
  eq('缺 --head-sha 拒绝', [noSha.code, noSha.json.code], [2, 'MISSING_FLAG']);
  const declaredOpen = forge(['change-merge', '--forge', 'github', '--repo', 'acme/web-app', '--id', '9', '--head-sha', 'abc', '--target', 'feat/base', '--depends-on', '[{"repo":"acme/web-app","id":8,"state":"open"}]', '--dry-run']);
  eq('dry-run 已知未合依赖同样拦截', [declaredOpen.code, declaredOpen.json.code, declaredOpen.json.command], [2, 'DEPENDS_ON_UNMERGED', undefined]);
  const badDep = forge(['change-merge', '--forge', 'github', '--repo', 'acme/web-app', '--id', '9', '--head-sha', 'abc', '--target', 'feat/base', '--depends-on', '["???"]', '--dry-run']);
  eq('非法依赖格式拦截', [badDep.code, badDep.json.code, badDep.json.invalid], [2, 'DEPENDS_ON_INVALID', ['???']]);
  const emptyDep = forge(['change-merge', '--forge', 'github', '--repo', 'acme/web-app', '--id', '9', '--head-sha', 'abc', '--target', 'feat/base', '--depends-on', '--dry-run']);
  eq('显式 --depends-on 缺值不能当成没有声明', [emptyDep.code, emptyDep.json.code], [2, 'DEPENDS_ON_INVALID']);

  const syncGlab = forge(['labels-sync', '--forge', 'gitlab', '--repos', 'acme/core-svc,acme/web-app', '--slots', '主研发,A,B', '--dry-run']);
  eq('gitlab 标签同步逐仓列出', syncGlab.json.invocations.length, 2 * (1 + 11));
  const syncList = forge(['labels-sync', '--forge', 'github', '--repos', 'acme/core-svc,acme/web-app', '--labels', '待终审,终审中,待合并', '--dry-run']);
  eq('--labels 严格按清单同步', syncList.json.labels.map((l) => l.name), ['待终审', '终审中', '待合并']);
  eq('github 默认先列后补（2×(1+3)）', syncList.json.invocations.length, 8);
  excludes('github 默认不带 --force', syncList.json.invocations, '--force');
  const syncOverwrite = forge(['labels-sync', '--forge', 'github', '--repos', 'acme/core-svc', '--labels', 'bug', '--overwrite', '--dry-run']);
  eq('仅 --overwrite 才加 --force', syncOverwrite.json.args.at(-1), '--force');

  const fake = makeFakeForge(path.join(tmp, 'fake'));
  const commentDate = '2024-05-01T02:00:00Z';
  const comment = { id: 42, created_at: commentDate, body: '【配置变更】绑定 槽位A' };
  const commentsArgs = (f) => ['issue-comments', '--forge', f, '--repo', 'acme/core-svc', '--id', '7'];
  const fixtureComments = { ...comment, author: { username: 'dev-a' } };
  fake.reset({ comments: {
    'projects/acme%2Fcore-svc/issues/7/notes': [
      Array.from({ length: 100 }, (_, i) => ({ ...fixtureComments, id: i + 100 })),
      [fixtureComments],
    ],
    'repos/acme/core-svc/issues/7/comments': [[{ ...comment, id: '42', user: { login: 'dev-a' } }]],
  } });
  const ghComments = forge(commentsArgs('github'), fake.env);
  const glComments = forge([...commentsArgs('gitlab'), '--hostname', 'gitlab.acme.test'], fake.env);
  const normalized = { id: 42, author: 'dev-a', createdAt: commentDate, body: comment.body };
  eq('GitHub issue-comments 读取并规范化原生评论', [ghComments.code, ghComments.json.comments], [0, [normalized]]);
  eq('GitLab issue-comments 翻页并保留数字 ID', [glComments.code, glComments.json.comments.length, glComments.json.comments.at(-1)], [0, 101, normalized]);
  const calls = fake.calls();
  eq('GitHub 评论查询使用正确端点', calls[0].args, ['api', 'repos/acme/core-svc/issues/7/comments?per_page=100']);
  eq('GitLab 评论查询带定制 host 并翻至第二页', calls.slice(1).map((c) => [c.args[2], c.args.at(-1)]), [
    ['gitlab.acme.test', 'projects/acme%2Fcore-svc/issues/7/notes?per_page=100'],
    ['gitlab.acme.test', 'projects/acme%2Fcore-svc/issues/7/notes?per_page=100&page=2'],
  ]);
  includes('Forge help 列出 issue-comments', forge(['--help']).json.commands, 'issue-comments');
  const ghState = (extra = {}) => ({
    prs: {
      'acme/core-svc#22': { baseRefName: 'feat/export', headRefOid: 'abc', body: '实现导出\nDepends-On: acme/core-svc#21', state: 'OPEN' },
      'acme/core-svc#21': { state: 'OPEN' },
      'acme/core-svc#23': { baseRefName: 'main', headRefOid: 'abc', body: '', state: 'OPEN' },
      'acme/core-svc#24': { baseRefName: 'feat/export', headRefOid: 'abc', body: 'Depends-On: 某个前置', state: 'OPEN' },
    },
    ...extra,
  });
  const realMerge = (id, more = []) => forge(['change-merge', '--forge', 'github', '--repo', 'acme/core-svc', '--id', String(id), '--head-sha', 'abc', '--target', 'feat/export', ...more], fake.env);
  const mergeCalls = () => fake.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');

  fake.reset(ghState());
  const lying = realMerge(22, ['--depends-on', '[{"repo":"acme/core-svc","id":21,"state":"merged"}]']);
  eq('调用方谎报 merged 仍向 Forge 实查并拒绝', [lying.code, lying.json.code, lying.json.blocked?.[0]?.id], [2, 'DEPENDS_ON_UNMERGED', 21]);
  eq('依赖未合时绝不发出合并', mergeCalls().length, 0);
  fake.reset(ghState());
  const bodyDep = realMerge(22);
  eq('不传依赖也从正文读出 Depends-On 并拒绝', [bodyDep.json.code, bodyDep.json.blocked?.[0]?.source], ['DEPENDS_ON_UNMERGED', 'body']);
  fake.reset(ghState());
  const shaMoved = forge(['change-merge', '--forge', 'github', '--repo', 'acme/core-svc', '--id', '22', '--head-sha', 'old', '--target', 'feat/export'], fake.env);
  eq('真实 head 已变 → HEAD_SHA_MISMATCH', [shaMoved.code, shaMoved.json.code, mergeCalls().length], [2, 'HEAD_SHA_MISMATCH', 0]);
  const targetDiff = forge(['change-merge', '--forge', 'github', '--repo', 'acme/core-svc', '--id', '22', '--head-sha', 'abc', '--target', 'feat/other'], fake.env);
  eq('真实目标与基线不一致 → TARGET_MISMATCH', targetDiff.json.code, 'TARGET_MISMATCH');
  const liveMain = realMerge(23);
  eq('读回真实目标为 main → ENV_BRANCH_FORBIDDEN', [liveMain.json.code, mergeCalls().length], ['ENV_BRANCH_FORBIDDEN', 0]);
  const badBody = realMerge(24);
  eq('正文 Depends-On 格式非法 → 拒绝', [badBody.code, badBody.json.code, badBody.json.invalid], [2, 'DEPENDS_ON_INVALID', ['某个前置']]);
  fake.reset(ghState({ mergeSucceeds: false, prs: { ...ghState().prs, 'acme/core-svc#21': { state: 'MERGED' } } }));
  const notConfirmed = realMerge(22);
  eq('合并后读回未合入不报成功', [notConfirmed.code, notConfirmed.json.code], [2, 'MERGE_NOT_CONFIRMED']);
  fake.reset(ghState({ prs: { ...ghState().prs, 'acme/core-svc#21': { state: 'MERGED' } } }));
  const merged = realMerge(22);
  eq('依赖实查全合入后合并并读回成功', [merged.code, merged.json.merged, merged.json.dependencies[0].state], [0, true, 'MERGED']);
  eq('真实合并带 --match-head-commit', mergeCalls()[0]?.args.slice(-2), ['--match-head-commit', 'abc']);

  const bodyState = (body, dependencyState = 'MERGED') => {
    const state = ghState();
    state.prs['acme/core-svc#22'].body = body;
    state.prs['acme/core-svc#21'].state = dependencyState;
    return state;
  };
  const localUrl = 'https://github.com/acme/core-svc/pull/21';
  const crossHost = 'https://github.other.example.test/acme/core-svc/pull/21';
  const otherForge = 'https://github.com/acme/core-svc/-/merge_requests/21';
  for (const reference of [crossHost, otherForge]) {
    fake.reset(bodyState(`- Depends-On: acme/core-svc#21\n* Depends-On: ${reference}`));
    const foreign = realMerge(22);
    eq(`依赖 ${reference} 跨实例或 Forge 时只读当前变更单即拒绝`, [foreign.code, foreign.json.code, fake.calls().length],
      [2, 'DEPENDS_ON_CROSS_INSTANCE', 1]);
  }
  fake.reset(bodyState(`1. Depends-On: ${localUrl}`, 'OPEN'));
  const numbered = realMerge(22);
  eq('编号列表中的同实例依赖未合时阻止合并', [numbered.code, numbered.json.code, mergeCalls().length], [2, 'DEPENDS_ON_UNMERGED', 0]);
  fake.reset(bodyState(`1. Depends-On: ${localUrl}\n- Depends-On: ${localUrl}\n* Depends-On: acme/core-svc#21`));
  const allowed = realMerge(22);
  eq('编号和无序列表生效，同 Forge、host、repo、id 才去重', [allowed.code, allowed.json.merged, allowed.json.dependencies.map((d) => [d.forge, d.host, d.repo, d.id])],
    [0, true, [['github', 'github.com', 'acme/core-svc', 21], ['github', null, 'acme/core-svc', 21]]]);
  fake.reset(bodyState(`Depends-On: ${localUrl}wrong`));
  const malformed = realMerge(22);
  eq('URL 编号后跟非法字符不能被部分匹配', [malformed.code, malformed.json.code, fake.calls().length], [2, 'DEPENDS_ON_INVALID', 1]);
  fake.reset(bodyState(''));
  const crossCaller = realMerge(22, ['--depends-on', JSON.stringify([{ repo: 'acme/core-svc', id: 21, forge: 'github', host: 'github.other.example.test', state: 'merged' }])]);
  eq('结构化调用方依赖也校验完整主机身份', [crossCaller.code, crossCaller.json.code, fake.calls().length], [2, 'DEPENDS_ON_CROSS_INSTANCE', 0]);

  const runPath = path.join(tmp, 'merge-run.json');
  const confirmedRun = { forge: 'github', repos: [{ name: 'core-svc', repo: 'acme/core-svc' }], baselineBranch: 'feat/export', protectedEnvBranches: ['preprod'] };
  const runArgs = ['change-merge', '--forge', 'github', '--id', '22', '--head-sha', 'abc', '--run', runPath];
  write(runPath, JSON.stringify(confirmedRun));
  fake.reset(bodyState(''));
  const disallowedRepo = forge([...runArgs, '--repo', 'acme/other', '--target', 'feat/export'], fake.env);
  const wrongTarget = forge([...runArgs, '--repo', 'acme/core-svc', '--target', 'feat/unconfirmed'], fake.env);
  eq('Forge 执行入口根据 run 拒绝仓和基线越界', [
    disallowedRepo.code, disallowedRepo.json.code, wrongTarget.code, wrongTarget.json.code, fake.calls().length,
  ], [2, 'REPO_NOT_IN_RUN', 2, 'TARGET_NOT_BASELINE', 0]);
  const selectedAlias = forge([...runArgs, '--repo', 'core-svc', '--target', 'feat/export'], fake.env);
  eq('Forge 接受选中仓的精确别名并在对应仓实查和合并', [selectedAlias.code, selectedAlias.json.merged, selectedAlias.json.repo],
    [0, true, 'acme/core-svc']);
  write(runPath, JSON.stringify({ ...confirmedRun, baselineBranch: 'preprod' }));
  fake.reset(bodyState(''));
  const protectedByRun = forge([...runArgs, '--repo', 'acme/core-svc', '--target', 'preprod'], fake.env);
  eq('只传 run 也能保护自定义环境分支，无任何 Forge 调用', [protectedByRun.code, protectedByRun.json.code, fake.calls().length],
    [2, 'ENV_BRANCH_FORBIDDEN', 0]);

  fake.reset({ mrs: { 'acme/core-svc!9': { target_branch: 'feat/x', sha: 'abc', description: '', state: 'opened' } } });
  const glabMerge = forge(['change-merge', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '9', '--head-sha', 'abc', '--target', 'feat/x', '--hostname', 'gitlab.acme.test'], fake.env);
  eq('GitLab 真实合并读回成功', [glabMerge.code, glabMerge.json.merged], [0, true]);
  ok('每条 glab 调用都带 --hostname', fake.calls().length >= 3 && fake.calls().every((c) => c.args[1] === '--hostname' && c.args[2] === 'gitlab.acme.test'));
  eq('GitLab 合并请求体带 sha', JSON.parse(fake.calls().find((c) => c.args.some((a) => a.endsWith('/merge'))).stdin).sha, 'abc');
  const glabDeps = (host, hostFlags = [], env = {}) => {
    fake.reset({ mrs: {
      'acme/core-svc!9': { target_branch: 'feat/x', sha: 'abc', description: `1. Depends-On: https://${host}/acme/infra/lib/-/merge_requests/7`, state: 'opened' },
      'acme/infra/lib!7': { state: 'merged' },
    } });
    return forge(['change-merge', '--forge', 'gitlab', '--repo', 'acme/core-svc', '--id', '9', '--head-sha', 'abc', '--target', 'feat/x', ...hostFlags],
      { ...fake.env, ...env });
  };
  const foreignGlab = glabDeps('gitlab.other.example.test', ['--hostname', 'gitlab.acme.test']);
  eq('GitLab 跨主机依赖不查询当前实例同名依赖', [foreignGlab.code, foreignGlab.json.code, fake.calls().length],
    [2, 'DEPENDS_ON_CROSS_INSTANCE', 1]);
  const envGlab = glabDeps('gitlab.env.test', [], { GITLAB_HOST: 'gitlab.env.test' });
  eq('GitLab 实例由 GITLAB_HOST 确认后，同实例多级路径可合', [envGlab.code, envGlab.json.dependencies[0]?.repo], [0, 'acme/infra/lib']);
  const defaultGlab = glabDeps('gitlab.com');
  eq('GitLab 未配置时只核验默认实例', [defaultGlab.code, defaultGlab.json.dependencies[0]?.host], [0, 'gitlab.com']);
  write(runPath, JSON.stringify({ forge: 'gitlab', repos: [{ repo: 123 }], baselineBranch: 'feat/x' }));
  fake.reset({ mrs: { '123!9': { target_branch: 'feat/x', sha: 'abc', description: '', state: 'opened' } } });
  const numericGitlab = forge(['change-merge', '--forge', 'gitlab', '--repo', '123', '--id', '9', '--head-sha', 'abc', '--target', 'feat/x', '--run', runPath], fake.env);
  eq('GitLab 的数字项目 ID 通过运行态仓范围验证', [numericGitlab.code, numericGitlab.json.merged], [0, true]);

  fake.reset({ labels: { 'acme/core-svc': [{ name: 'bug' }] } });
  const realSync = forge(['labels-sync', '--forge', 'github', '--repos', 'acme/core-svc', '--labels', 'bug,待合并'], fake.env);
  eq('真实同步只补缺不覆盖共享 bug', realSync.json.created.map((c) => c.label), ['待合并']);
  excludes('真实同步无 --force', fake.calls(), '--force');

  fake.reset({
    groupMrs: [
      { iid: 1, references: { full: 'acme/core-svc!1' } },
      { iid: 2, references: { full: 'acme/other!2' } },
      { iid: 3, web_url: 'https://gitlab.acme.test/acme/web-app/-/merge_requests/3' },
    ],
    projectMrs: { 'acme/core-svc': Array.from({ length: 100 }, (_, i) => ({ iid: i + 1 })) },
  });
  const groupReal = forge(['change-list', '--forge', 'gitlab', '--group', 'acme', '--repos', 'acme/core-svc,acme/web-app'], fake.env);
  eq('group 查询真实执行按白名单过滤', [groupReal.json.items.map((m) => m.iid), groupReal.json.truncated], [[1, 3], false]);
  const truncated = forge(['change-list', '--forge', 'gitlab', '--repos', 'acme/core-svc'], fake.env);
  eq('满 100 条标 truncated 告警', [truncated.json.truncated, truncated.json.complete, truncated.json.warnings.length], [true, false, 1]);

  const baselineDry = forge(['baseline-check', '--repos', '/tmp/a:main,/tmp/b:dev', '--dry-run']);
  eq('baseline-check dry-run 命令数', [baselineDry.json.command, baselineDry.json.invocations.length], ['git', 8]);
  eq('baseline-check 预览按指定分支和 refspec 拉取', baselineDry.json.invocations[4].args.slice(2),
    ['fetch', '--no-tags', 'origin', '+refs/heads/dev:refs/remotes/origin/dev']);
  const pairOne = makeRepoPair(path.join(tmp, 'git-one'));
  const pairTwo = makeRepoPair(path.join(tmp, 'git-two'));
  const spacePair = makeRepoPair(path.join(tmp, 'git space'));
  const real = forge(['baseline-check', '--repos', `${pairOne.cloneA}:main,${pairTwo.cloneA}:main`]);
  eq('真实双仓检出 2 个漂移', [real.code, real.json.ok, real.json.drifted], [0, true, 2]);
  eq('仓库 1 落后 1 个提交', [real.json.repos[0].remoteAhead, real.json.repos[0].behind], [true, 1]);
  eq('真实 SHA 为 40 位', real.json.repos[0].remoteSha.length, 40);
  git(['pull', '-q', '--ff-only', 'origin', 'main'], pairOne.cloneA);
  const afterPull = forge(['baseline-check', '--repos', `${pairOne.cloneA}:main,${pairTwo.cloneA}:main`]);
  eq('拉取后仓库 1 对齐、仍剩 1 个漂移', [afterPull.json.repos[0].upToDate, afterPull.json.drifted], [true, 1]);
  const spaceResult = forge(['baseline-check', '--repos', `${spacePair.cloneA}:main`]);
  eq('含空格路径 baseline 可跑', [spaceResult.code, spaceResult.json.repos[0].path], [0, spacePair.cloneA]);
  const branch = 'loop/demo';
  const oldSha = git(['rev-parse', 'refs/heads/main'], pairTwo.cloneA).trim();
  git(['branch', branch, oldSha], pairTwo.cloneA);
  updateFixtureRemote(pairTwo.bare, pairTwo.cloneA, branch);
  git(['fetch', '-q', 'origin'], pairTwo.cloneA);
  git(['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main'], pairTwo.cloneA);
  const alignedNarrow = forge(['baseline-check', '--repos', `${pairTwo.cloneA}:${branch}`]);
  eq('窄 refspec 下尚未漂移的需求分支仍正确报对齐', [alignedNarrow.code, alignedNarrow.json.repos[0]?.upToDate], [0, true]);
  write(path.join(pairTwo.cloneB, 'README.md'), 'remote branch advanced\n');
  const newSha = commitFixture(pairTwo.cloneB, branch, 'advance demand branch', oldSha);
  updateFixtureRemote(pairTwo.bare, pairTwo.cloneB, branch);
  eq('检查前的本地 tracking ref 确实仍是旧 SHA', git(['rev-parse', `refs/remotes/origin/${branch}`], pairTwo.cloneA).trim(), oldSha);
  const driftedNarrow = forge(['baseline-check', '--repos', `${pairTwo.cloneA}:${branch}`]);
  const drift = driftedNarrow.json.repos[0];
  eq('窄 refspec 下读出需求分支最新 SHA 和漂移', [driftedNarrow.code, driftedNarrow.json.drifted, drift.localSha, drift.remoteSha, drift.behind], [0, 1, oldSha, newSha, 1]);
  fs.renameSync(pairOne.bare, `${pairOne.bare}.moved`);
  const fetchFail = forge(['baseline-check', '--repos', `${pairOne.cloneA}:main`]);
  eq('fetch 失败绝不假报对齐', [fetchFail.code, fetchFail.json.ok, fetchFail.json.repos[0].upToDate, fetchFail.json.repos[0].fetchFailed], [2, false, false, true]);
  eq('fetch 失败错误码', fetchFail.json.code, 'BASELINE_UNKNOWN');
}

/* ================================================================== */
/* 场景 7：只读 status 冷启动导览与半程升档/拆架/归档引导                 */
/* ================================================================== */

function scenario7(tmp) {
  group('7. 只读 status 冷启动导览与下一步提示');
  const emptyCfg = path.join(tmp, 'empty-cfg');
  const cold = loopctl(['status'], emptyCfg);
  eq('空目录冷启动触发 onboarding 且不建目录', [cold.code, cold.json.readOnly, cold.json.needsOnboarding, cold.json.onboardingQuestions.length, fs.existsSync(emptyCfg)], [0, true, true, 4, false]);

  fs.mkdirSync(tmp, { recursive: true });
  const repoDir = path.join(tmp, 'repo');
  git(['init', '-q', '-b', 'main', repoDir], tmp);
  const cfgDir = setupConfig(tmp, { 'demo.yaml': simpleProject({ forge: 'github', tier: 'L1', name: 'demo', repo: 'acme/demo', repoPath: repoDir }) });
  const idle = loopctl(['status'], cfgDir);
  eq('已配置无活动需求时 needsOnboarding=false', [idle.code, idle.json.needsOnboarding, idle.json.activeRuns.length, idle.json.projects], [0, false, 0, ['demo']]);

  loopctl(['init', '--req', 'guide-demo', '--project', 'demo', '--issue-map', '{"tracking":"#10"}'], cfgDir);
  const active = loopctl(['status', '--req', 'guide-demo'], cfgDir);
  eq('活动 L1 需求返回阶段与只读态', [active.code, active.json.state, active.json.run.tier, active.json.run.baselineBranch], [0, 'active', 'L1', 'loop/guide-demo']);
  includes('活动 L1 下一步提示包含升档指引', active.json.run.nextPrompt, '从 L1 升档到 L2');

  loopctl(['upgrade', '--req', 'guide-demo', '--to', 'L2'], cfgDir);
  const upgrading = loopctl(['status', '--req', 'guide-demo'], cfgDir);
  eq('半程升档暴露 pendingUpgrade', [upgrading.code, upgrading.json.run.pendingUpgrade.from, upgrading.json.run.pendingUpgrade.to], [0, 'L1', 'L2']);
  includes('半程升档提示先 --apply 落盘', upgrading.json.run.nextAction, '--apply');

  loopctl(['teardown', '--req', 'guide-demo'], cfgDir);
  const tearing = loopctl(['status'], cfgDir);
  eq('半程拆架在列表态暴露 pendingTeardown', [tearing.code, tearing.json.activeRuns.length, tearing.json.activeRuns[0].pendingTeardown.phase], [0, 1, 'planned']);
  loopctl(['teardown', '--req', 'guide-demo', '--finalize', '--results', JSON.stringify({ ledgers: { tracking: { closed: true } } })], cfgDir);
  const archived = loopctl(['status', '--req', 'guide-demo'], cfgDir);
  eq('归档后 status 返回 archived 状态', [archived.code, archived.json.state, archived.json.zeroResidue], [0, 'archived', true]);

  const extCfg = loopctl(['config-resolve', '--project', 'demo', '--overrides', JSON.stringify({
    notify: { externalNotifyDisabled: true, externalContacts: { appClient: 'ou_ext_app' } },
  })], cfgDir);
  eq('config-resolve 透传 externalNotifyDisabled 与 externalContacts', [extCfg.code, extCfg.json.notify.externalNotifyDisabled, extCfg.json.notify.externalContacts.appClient], [0, true, 'ou_ext_app']);

  const mutedLead = loopctl(['eval-patrol', ...input({
    mode: 'lead',
    now: '2026-11-21T10:30:00+08:00',
    externalNotifyDisabled: true,
    lead: { person: 'lead-dev' },
    memberOpenIds: { 'dev-a': 'ou_dev_a', 'lead-dev': 'ou_lead' },
    p3: { slots: [{ slot: 'A', person: 'dev-a', paused: true, pausedHours: 9 }] },
  })], cfgDir);
  eq('externalNotifyDisabled 关闭大巡检外部推送但保留 Forge 留证', [mutedLead.code, mutedLead.json.action, mutedLead.json.externalNotifySuppressed, mutedLead.json.mentions.length, mutedLead.json.notifications.length, mutedLead.json.forgeOnly.length >= 1], [0, 'forge-only', true, 0, 0, true]);
}

/* ================================================================== */
/* 场景 8：环境分支正则/通配、生产主干豁免、Git 血统白名单与 Issue 关联校验 */
/* ================================================================== */

function scenario8(tmp) {
  group('8. 环境分支正则/通配 + 生产主干豁免 + Git 血统白名单');
  fs.mkdirSync(tmp, { recursive: true });
  const bare = path.join(tmp, 'remote.git');
  const work = path.join(tmp, 'work');
  git(['init', '-q', '--bare', '-b', 'main', bare], tmp);
  git(['init', '-q', '-b', 'main', work], tmp);
  git(['remote', 'add', 'origin', bare], work);

  // 构造真实 Git 历史：C_old -> C0 (需求基线起点) -> 各种分支
  write(path.join(work, 'app.txt'), 'old\n');
  const cOld = commitFixture(work, 'main', 'old main commit');
  write(path.join(work, 'app.txt'), 'base\n');
  const c0 = commitFixture(work, 'main', 'baseline start commit', cOld);
  updateFixtureRemote(bare, work, 'main');

  // 建需求基线分支 loop/lin-demo 指向 c0
  git(['branch', 'loop/lin-demo', c0], work);
  updateFixtureRemote(bare, work, 'loop/lin-demo');

  // 1) 正常开发分支：从 c0 拉出纯线性提交
  git(['checkout', '-q', '-b', 'dev/clean', c0], work);
  write(path.join(work, 'feat.txt'), 'ok\n');
  const cleanSha = commitFixture(work, 'dev/clean', 'clean feature commit', c0);
  updateFixtureRemote(bare, work, 'dev/clean');

  // 2) 陌生旧分支：从 cOld (早于基线起点 c0) 分叉
  git(['checkout', '-q', '-b', 'other/old-req', cOld], work);
  write(path.join(work, 'other.txt'), 'stale\n');
  const oldReqSha = commitFixture(work, 'other/old-req', 'other req from old main', cOld);
  updateFixtureRemote(bare, work, 'other/old-req');

  // 3) 混入 test 的借壳污染分支：从 c0 拉出并把 test 分支 merge 进来
  git(['checkout', '-q', '-b', 'test', cOld], work);
  write(path.join(work, 'dirty-test.txt'), 'unreleased\n');
  const testSha = commitFixture(work, 'test', 'other team unreleased test commit', cOld);
  updateFixtureRemote(bare, work, 'test');

  git(['checkout', '-q', '-b', 'dev/polluted', c0], work);
  git(['merge', '-q', '--no-edit', '--no-ff', 'test'], work);
  const pollutedSha = git(['rev-parse', 'HEAD'], work).trim();
  updateFixtureRemote(bare, work, 'dev/polluted');

  git(['checkout', '-q', 'loop/lin-demo'], work);
  git(['fetch', '-q', 'origin'], work);

  const patterns = ['/^feature_\\d{4}[A-Z]?_(test|uat)$/', 'release/*'];
  const cfgDir = setupConfig(tmp, {
    'lin.yaml': [
      'forge: github',
      'defaultTier: L2',
      'protectedEnvBranches:',
      '  - "/^feature_\\\\d{4}[A-Z]?_(test|uat)$/"',
      '  - "release/*"',
      'hubRepo:',
      '  name: lin',
      '  repo: acme/lin',
      `  path: ${work}`,
      '  branch: main',
      'verification:',
      '  mode: local-test',
    ].join('\n'),
  });

  // 正则/通配精准命中 & 0 误杀
  const badPat = loopctl(['config-resolve', '--project', 'lin', '--overrides', JSON.stringify({ protectedEnvBranches: ['/(unclosed/'] })], cfgDir);
  eq('非法正则分支规则立即报错', [badPat.code, badPat.json.code], [2, 'INVALID_BRANCH_PATTERN']);

  const hitMonthly = loopctl(['preview-init', '--req', 'r1', '--project', 'lin', '--branch', 'feature_2610B_test'], cfgDir);
  includes('正则精准命中月度测试分支 feature_2610B_test 确认单改全人工', hitMonthly.json.confirmSheet[4], '全人工合并');
  const noFalsePos = loopctl(['preview-init', '--req', 'r2', '--project', 'lin', '--branch', 'feature_2611B_ab_test'], cfgDir);
  includes('feature_2611B_ab_test 不误杀仍可低风险自动合', noFalsePos.json.confirmSheet[4], '低风险自动合并');

  // init 自动记录 baselineStartSha（登记本需求 Issue #100 与子单 #13）
  const initRes = loopctl(['init', '--req', 'lin-demo', '--project', 'lin', '--branch', 'loop/lin-demo', '--issue-map', '{"master":"#100","story1":"#13"}'], cfgDir);
  eq('init 自动记录真实 Git 基线起点 baselineStartSha', [initRes.code, initRes.json.run.repos[0].baselineStartSha], [0, c0]);
  const runPath = initRes.json.runPath;

  // 回归测试 1（基线晚建）：init 时基线尚未建且工作区检出在无关旧分支 other/old-req，绝不误把 HEAD 记作基线起点
  git(['checkout', '-q', 'other/old-req'], work);
  const lateInit = loopctl(['init', '--req', 'late-base', '--project', 'lin', '--branch', 'loop/not-created-yet', '--issue-map', '{"master":"#200"}'], cfgDir);
  eq('基线晚建时绝不回退到无关 HEAD，取主干起点 c0', [lateInit.code, lateInit.json.run.repos[0].baselineStartSha], [0, c0]);
  git(['checkout', '-q', 'loop/lin-demo'], work);

  // 回归测试 2（生产主干豁免不串仓）：核心仓主干为 release/stable，关联仓主干为 main 且 release/* 受保护
  const multiCfg = setupConfig(path.join(tmp, 'multi-trunk'), {
    'mt.yaml': [
      'forge: github',
      'defaultTier: L2',
      'protectedEnvBranches:',
      '  - "release/*"',
      'hubRepo:',
      '  name: hub',
      '  repo: acme/hub',
      '  branch: release/stable',
      'linkedRepos:',
      '  - name: web',
      '    repo: acme/web',
      '    branch: main',
    ].join('\n'),
  });
  const mtInit = loopctl(['init', '--req', 'mt-req', '--project', 'mt', '--branch', 'loop/mt-req', '--issue-map', '{"master":"#300"}'], multiCfg);
  const mtRunPath = mtInit.json.runPath;
  const hubFromStable = forge(['change-create', '--forge', 'github', '--repo', 'acme/hub', '--source', 'release/stable', '--target', 'loop/mt-req', '--title', 'hub sync', '--run', mtRunPath, '--dry-run']);
  eq('核心仓自身主干 release/stable 允许同步建单', hubFromStable.code, 0);
  const webFromStable = forge(['change-create', '--forge', 'github', '--repo', 'acme/web', '--source', 'release/stable', '--target', 'loop/mt-req', '--title', 'bad web sync', '--run', mtRunPath, '--dry-run']);
  eq('关联仓不得串用核心仓主干豁免，release/stable 被硬拒', [webFromStable.code, webFromStable.json.code], [2, 'SOURCE_ENV_BRANCH_FORBIDDEN']);
  const revWebStable = loopctl(['eval-review', '--req', 'mt-req', ...input({
    dispatchedSessionId: 'rev-1', sessionId: 'rev-1', conclusion: '通过', risk: '低', riskChecks: FULL_LOW,
    dispatchedHeadSha: cleanSha, sourceBranch: 'release/stable',
    change: { repo: 'acme/web', id: 60, targetBranch: 'loop/mt-req', headSha: cleanSha },
  })], multiCfg);
  eq('eval-review 关联仓同样不串用核心仓主干豁免', [revWebStable.code, revWebStable.json.action, revWebStable.json.code], [0, 'reject-source', 'SOURCE_ENV_BRANCH_FORBIDDEN']);

  // change-create 双向校验：禁 test/feature_2610B_test 反向建单，放行 main 回合和向环境提测
  const createFromTest = forge(['change-create', '--forge', 'github', '--repo', 'acme/lin', '--source', 'feature_2610B_test', '--target', 'loop/lin-demo', '--title', 'bad', '--run', runPath, '--dry-run']);
  eq('change-create 硬拒月度测试分支反向建单', [createFromTest.code, createFromTest.json.code], [2, 'SOURCE_ENV_BRANCH_FORBIDDEN']);
  const createFromMain = forge(['change-create', '--forge', 'github', '--repo', 'acme/lin', '--source', 'main', '--target', 'loop/lin-demo', '--title', 'sync main', '--run', runPath, '--dry-run']);
  eq('change-create 放行生产主干 main 向需求基线同步建单', createFromMain.code, 0);
  const createToTest = forge(['change-create', '--forge', 'github', '--repo', 'acme/lin', '--source', 'loop/lin-demo', '--target', 'feature_2610B_test', '--title', 'deploy test', '--run', runPath, '--dry-run']);
  eq('change-create 放行需求基线向测试环境提测建单', createToTest.code, 0);

  // eval-review 源分支分流：主干走人工同步，非主干环境直接拒绝
  const baseReview = {
    dispatchedSessionId: 'rev-1', sessionId: 'rev-1', conclusion: '通过', risk: '低', riskChecks: FULL_LOW,
    dispatchedHeadSha: cleanSha, change: { repo: 'acme/lin', id: 50, targetBranch: 'loop/lin-demo', headSha: cleanSha },
  };
  const revFromMain = loopctl(['eval-review', '--req', 'lin-demo', ...input({ ...baseReview, sourceBranch: 'main' })], cfgDir);
  eq('eval-review 生产主干源分支退人手合', [revFromMain.code, revFromMain.json.action, revFromMain.json.code], [0, 'manual-merge', 'PROD_TRUNK_MANUAL_SYNC']);
  const revFromMonthly = loopctl(['eval-review', '--req', 'lin-demo', ...input({ ...baseReview, sourceBranch: 'feature_2610B_test' })], cfgDir);
  eq('eval-review 非主干环境源分支直接拒绝', [revFromMonthly.code, revFromMonthly.json.action, revFromMonthly.json.code], [0, 'reject-source', 'SOURCE_ENV_BRANCH_FORBIDDEN']);

  // change-merge 真实 Git 血统白名单 + Issue 关联校验
  const fake = makeFakeForge(path.join(tmp, 'fake-lin'));
  const mergeWithRun = (prId, sha) => forge([
    'change-merge', '--forge', 'github', '--repo', 'acme/lin', '--id', String(prId), '--head-sha', sha, '--target', 'loop/lin-demo', '--run', runPath,
  ], fake.env);

  // A. 源分支为生产主干 main -> 拒绝 AI 自动合（须人手合）
  fake.reset({ prs: { 'acme/lin#51': { baseRefName: 'loop/lin-demo', headRefName: 'main', headRefOid: c0, body: 'Refs #13', state: 'OPEN' } } });
  const mMain = mergeWithRun(51, c0);
  eq('change-merge 生产主干源分支禁 AI 自动合', [mMain.code, mMain.json.code], [2, 'SOURCE_TRUNK_MANUAL_ONLY']);

  // B. 源分支命中非主干正则 feature_2610B_test -> 硬拒
  fake.reset({ prs: { 'acme/lin#52': { baseRefName: 'loop/lin-demo', headRefName: 'feature_2610B_test', headRefOid: testSha, body: 'Refs #13', state: 'OPEN' } } });
  const mMonthly = mergeWithRun(52, testSha);
  eq('change-merge 月度测试分支源分支硬拒', [mMonthly.code, mMonthly.json.code], [2, 'SOURCE_ENV_BRANCH_FORBIDDEN']);

  // C. 陌生旧分支（分叉点早于 baselineStartSha）-> SOURCE_LINEAGE_INVALID
  fake.reset({ prs: { 'acme/lin#53': { baseRefName: 'loop/lin-demo', headRefName: 'other/old-req', headRefOid: oldReqSha, body: 'Refs #13', state: 'OPEN' } } });
  const mOld = mergeWithRun(53, oldReqSha);
  eq('旧分叉陌生分支被 Git 血统拦截', [mOld.code, mOld.json.code], [2, 'SOURCE_LINEAGE_INVALID']);

  // D. 借壳污染分支（含 test 的 merge commit）-> SOURCE_CONTAINS_MERGE_COMMITS
  fake.reset({ prs: { 'acme/lin#54': { baseRefName: 'loop/lin-demo', headRefName: 'dev/polluted', headRefOid: pollutedSha, body: 'Refs #13', state: 'OPEN' } } });
  const mPolluted = mergeWithRun(54, pollutedSha);
  eq('混入 test 的借壳分支被 merge commit 拦截', [mPolluted.code, mPolluted.json.code], [2, 'SOURCE_CONTAINS_MERGE_COMMITS']);

  // E. 同 C0 线性分支但正文只写 Depends-On 未关联本需求 Issue -> MISSING_ISSUE_REF
  fake.reset({ prs: { 'acme/lin#55': { baseRefName: 'loop/lin-demo', headRefName: 'dev/clean', headRefOid: cleanSha, body: 'Depends-On: acme/lin#8', state: 'OPEN' } } });
  const mNoIssue = mergeWithRun(55, cleanSha);
  eq('仅写 Depends-On 未关联需求 Issue 拒绝自动合', [mNoIssue.code, mNoIssue.json.code], [2, 'MISSING_ISSUE_REF']);

  // E2. 正文引用了不在本次需求集合里的无关 Issue #999 -> ISSUE_REF_NOT_IN_RUN
  fake.reset({ prs: { 'acme/lin#57': { baseRefName: 'loop/lin-demo', headRefName: 'dev/clean', headRefOid: cleanSha, body: '关联 #999', state: 'OPEN' } } });
  const mWrongIssue = mergeWithRun(57, cleanSha);
  eq('无关 Issue 编号 #999 拒绝自动合', [mWrongIssue.code, mWrongIssue.json.code], [2, 'ISSUE_REF_NOT_IN_RUN']);

  // E3. 跨仓 PR 仅写裸 #300 未写核心仓全称 acme/hub#300 -> ISSUE_REF_WRONG_REPO
  fake.reset({ prs: { 'acme/web#58': { baseRefName: 'loop/mt-req', headRefName: 'dev/web', headRefOid: cleanSha, body: '关联 #300', state: 'OPEN' } } });
  const mCrossRepoBare = forge(['change-merge', '--forge', 'github', '--repo', 'acme/web', '--id', '58', '--head-sha', cleanSha, '--target', 'loop/mt-req', '--run', mtRunPath], fake.env);
  eq('跨仓 PR 裸写 #300 拒绝（须显式核心仓引用）', [mCrossRepoBare.code, mCrossRepoBare.json.code], [2, 'ISSUE_REF_WRONG_REPO']);

  // F. 纯血线性分支 + 关联本次需求登记的 Issue #13 -> 全部 4 层门禁通过并合入
  fake.reset({ prs: { 'acme/lin#56': { baseRefName: 'loop/lin-demo', headRefName: 'dev/clean', headRefOid: cleanSha, body: '关联 #13', state: 'OPEN' } } });
  const mClean = mergeWithRun(56, cleanSha);
  eq('纯血需求分支 + 关联登记 Issue 四层门禁全部通过并合入', [mClean.code, mClean.json.merged, mClean.json.lineage.verified, mClean.json.lineage.mergeCommits], [0, true, true, 0]);
}

/* ================================================================== */
/* 主流程                                                                */
/* ================================================================== */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-lite-loop-test-'));
let crashed = null;
try {
  await scenario1(path.join(tmp, 's1'));
  scenario2(path.join(tmp, 's2'));
  scenario3(path.join(tmp, 's3'));
  scenario4(path.join(tmp, 's4'));
  scenario5(path.join(tmp, 's5'));
  scenario6(path.join(tmp, 's6'));
  scenario7(path.join(tmp, 's7'));
  scenario8(path.join(tmp, 's8'));
} catch (err) {
  crashed = err;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('xxn-lite-loop 全流程模拟测试');
console.log(`临时目录：${tmp}（${fs.existsSync(tmp) ? '清理失败' : '已清理'}）`);
console.log('');
for (const [index, item] of groups.entries()) {
  console.log(`[${index + 1}] ${item.name}  ${item.fail === 0 ? 'PASS' : 'FAIL'} ${item.pass} / ${item.fail}`);
}
console.log('');
if (failures.length > 0) {
  console.log('失败明细：');
  for (const failure of failures) {
    console.log(`- [${failure.group}] ${failure.name}`);
    if (failure.detail) console.log(`  ${failure.detail}`);
  }
  console.log('');
}
if (crashed) {
  console.log('测试执行异常：');
  console.log(crashed.stack ?? String(crashed));
  console.log('');
}
const leaked = fs.existsSync(tmp);
console.log(`TOTAL PASS ${totalPass} / FAIL ${totalFail + (crashed ? 1 : 0) + (leaked ? 1 : 0)}`);
const failed = crashed || totalFail > 0 || leaked;
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exitCode = failed ? 1 : 0;
