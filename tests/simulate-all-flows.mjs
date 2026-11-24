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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ACTION_MESSAGES, describeAction } from '../scripts/lib/action-messages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOOPCTL = path.join(ROOT, 'scripts', 'loopctl.mjs');
const FORGE = path.join(ROOT, 'scripts', 'forge.mjs');
const BASE_ENV = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
for (const key of ['GITLAB_HOST', 'GH_HOST', 'GH_BIN', 'GLAB_BIN', 'GIT_BIN', 'LARK_CLI_BIN', 'XXN_LITE_LOOP_CONFIG_DIR']) delete BASE_ENV[key];
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

const loopctl = (args, configDir, env) => runCli(LOOPCTL, [...args, '--config-dir', configDir], env);
const forge = (args, env) => runCli(FORGE, args, env);
const input = (payload) => ['--input', JSON.stringify(payload)];

function collectFacts(run, env) {
  const script = `import { collectRunFacts } from ${JSON.stringify(pathToFileURL(FORGE).href)};
    console.log(JSON.stringify(collectRunFacts(JSON.parse(process.env.FACTS_TEST_RUN))));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', env: { ...BASE_ENV, ...env, FACTS_TEST_RUN: JSON.stringify(run) },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'collectRunFacts 测试子进程失败');
  return JSON.parse(result.stdout);
}

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

function slotBinding(id, slot, user, sessionId, at = '2024-05-01T01:00:00Z') {
  return {
    id, body: `主控 ｜ ${slot} ｜ ${sessionId}\n【配置变更】绑定 槽位${slot}`, created_at: at,
    user: { login: user }, author: { username: user },
  };
}

function withSlotBindings(state, masterEndpoint, ...claims) {
  if (!claims.length) return state;
  const copy = structuredClone(state);
  const notes = (copy.comments ??= {})[masterEndpoint] ??= [[]];
  const ids = new Set(notes.flat().map(({ id }) => id));
  notes[0].push(...claims.filter(({ id }) => !ids.has(id)));
  return copy;
}

function workflowLabels(change) {
  return change.labels.map((label) => label.name ?? label).filter((label) => !label.startsWith('需求:'));
}

// Seed an already completed dispatch when the test is about another gate.
function seedReviews(runPath, state, specs) {
  const rows = [];
  for (const { repo, id, session, headSha, round = 1, conclusion, risk = FULL_LOW, at, commentId, waiting = false, platform = 'github' } of specs) {
    const dispatchId = `fixture-${id}-${session}`;
    rows.push({ type: 'dispatch', dispatchId, pr: { repo, id }, round, headSha, session, nonce: 'fixture', at });
    if (!conclusion) continue;
    const body = `终审 ｜ A ｜ ${session}\n结论：${conclusion}\n<!-- liteloop:verdict ${JSON.stringify({ dispatchId, round, conclusion, risk, headSha, session })} -->`;
    const endpoint = platform === 'github' ? `repos/${repo}/issues/${id}/comments` : `projects/${encodeURIComponent(repo)}/merge_requests/${id}/notes`;
    const pages = (state.comments ??= {})[endpoint] ??= [[]];
    pages[0].push({ id: commentId, body, created_at: at });
    rows.push({ type: 'verdict', dispatchId, conclusion, risk, body },
      { type: 'published', dispatchId, commentId });
    if (waiting) rows.push({ type: 'merge-result', dispatchId, state: 'waiting', code: 'DEPENDS_ON_UNMERGED', rejectCount: 0 });
  }
  write(runPath.replace(/\.json$/, '.reviews.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return state;
}

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
fs.appendFileSync(process.env.FAKE_FORGE_LOG, JSON.stringify({ args, stdin, ghHost: process.env.GH_HOST ?? null }) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const reply = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const fail = (m) => { process.stderr.write(m); process.exit(1); };
const repoArg = () => args[args.indexOf('--repo') + 1];
const addComment = (endpoint, body) => {
  const pages = (state.comments ??= {})[endpoint] ??= [[]];
  const note = { body, id: Math.max(998, ...pages.flat().map((note) => note.id)) + 1, created_at: state.commentAt ?? '2024-05-01T04:00:00Z' };
  pages.at(-1).push(note);
  save(); reply(note);
};
if (args[0] === 'api') {
  const opt = {}; const pos = [];
  for (let i = 1; i < args.length; i += 1) {
    if (args[i].startsWith('--')) { opt[args[i].slice(2)] = args[i + 1]; i += 1; } else pos.push(args[i]);
  }
  const p = pos[0].split('?')[0];
  const query = new URLSearchParams(pos[0].split('?')[1]);
  let m;
  if (state.failApi?.includes(pos[0])) fail('read failed');
  if (p === 'user') reply({ login: state.viewer ?? 'dev', username: state.viewer ?? 'dev' });
  if (Object.hasOwn(state.branches ?? {}, p)) reply(state.branches[p]);
  if (/^projects\\/[^/]+\\/(?:issues|merge_requests)\\/\\d+\\/notes$/.test(p) || /^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+\\/comments$/.test(p)) {
    if (opt.method === 'POST') addComment(p, JSON.parse(stdin).body);
    reply(state.comments?.[p]?.[Number(query.get('page') ?? 1) - 1] ?? []);
  }
  if (/\\/(?:events|resource_label_events)$/.test(p)) reply(state.labelEvents?.[p] ?? []);
  if (/\\/(?:files|diffs)$/.test(p)) reply(state.changeFiles?.[p] ?? []);
  if ((m = /^projects\\/([^/]+)\\/issues\\/(\\d+)$/.exec(p))) {
    const issue = state.issues?.[decodeURIComponent(m[1]) + '#' + m[2]];
    if (issue && opt.method === 'PUT') { Object.assign(issue, JSON.parse(stdin)); save(); }
    if (issue) reply(issue); else fail('404');
  }
  if ((m = /^projects\\/([^/]+)\\/merge_requests\\/(\\d+)\\/merge$/.exec(p))) {
    const mr = state.mrs[decodeURIComponent(m[1]) + '!' + m[2]];
    if (!mr) fail('404');
    if (state.mergeSucceeds !== false) mr.state = 'merged';
    save(); reply(mr);
  }
  if ((m = /^projects\\/([^/]+)\\/merge_requests\\/(\\d+)$/.exec(p))) {
    const mr = state.mrs[decodeURIComponent(m[1]) + '!' + m[2]];
    if (mr && opt.method === 'PUT') {
      const payload = JSON.parse(stdin);
      const remove = (payload.remove_labels ?? '').split(',');
      mr.labels = [...(mr.labels ?? []).filter((label) => !remove.includes(label)), ...(payload.add_labels ?? '').split(',').filter(Boolean)];
      save();
    }
    if (mr) reply(mr); else fail('404');
  }
  if (/^groups\\/[^/]+\\/merge_requests$/.test(p)) reply(state.groupMrs ?? []);
  const memberRows = (entries, repo, prefix, marker) => Object.entries(entries ?? {})
    .filter(([key, row]) => key.startsWith(repo + marker) && (row.labels ?? []).some((label) => (label.name ?? label) === query.get('labels')))
    .map(([key, row]) => ({ ...row, [prefix]: Number(key.slice(repo.length + 1)) }));
  if (query.has('labels') && (m = /^repos\\/([^/]+\\/[^/]+)\\/issues$/.exec(p))) {
    reply([...memberRows(state.issues, m[1], 'number', '#'),
      ...memberRows(state.prs, m[1], 'number', '#').map((row) => ({ ...row, pull_request: {} }))]);
  }
  if (query.has('labels') && (m = /^projects\\/([^/]+)\\/(issues|merge_requests)$/.exec(p))) {
    const isIssue = m[2] === 'issues';
    reply(memberRows(isIssue ? state.issues : state.mrs, decodeURIComponent(m[1]), 'iid', isIssue ? '#' : '!'));
  }
  if (/^(?:repos\\/[^/]+\\/[^/]+|projects\\/[^/]+)\\/issues$/.test(p)) reply(state.issueLists?.[pos[0]] ?? []);
  if (/^repos\\/[^/]+\\/[^/]+\\/pulls$/.test(p)
    || (/^projects\\/[^/]+\\/merge_requests$/.test(p) && query.get('scope') === 'all' && state.branchChanges?.[pos[0]])) {
    reply(state.branchChanges?.[pos[0]] ?? []);
  }
  if ((m = /^projects\\/([^/]+)\\/merge_requests$/.exec(p))) reply(state.projectMrs?.[decodeURIComponent(m[1])] ?? []);
  if ((m = /^projects\\/([^/]+)\\/labels$/.exec(p))) { if (opt.method === 'POST') reply({}); reply(state.labels?.[decodeURIComponent(m[1])] ?? []); }
  fail('unknown api ' + p);
}
if (['issue', 'pr'].includes(args[0]) && args[1] === 'create') {
  const isIssue = args[0] === 'issue';
  const repo = repoArg();
  const id = isIssue ? 50 : 51;
  const rows = isIssue ? (state.issues ??= {}) : (state.prs ??= {});
  const labels = args.includes('--label') ? args[args.indexOf('--label') + 1].split(',') : [];
  rows[repo + '#' + id] = { labels };
  save();
  console.log('https://github.com/' + repo + '/' + (isIssue ? 'issues' : 'pull') + '/' + id);
  process.exit(0);
}
if (args[0] === 'issue' && ['view', 'edit'].includes(args[1])) {
  const issue = state.issues?.[repoArg() + '#' + args[2]];
  if (!issue) fail('not found');
  if (args[1] === 'edit') { issue.body = args[args.indexOf('--body') + 1]; save(); }
  reply(issue);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  if (!state.prs?.[repoArg() + '#' + args[2]]) fail('not found');
  addComment('repos/' + repoArg() + '/issues/' + args[2] + '/comments', args[args.indexOf('--body') + 1]);
}
if (args[0] === 'pr' && args[1] === 'edit') {
  const pr = state.prs[repoArg() + '#' + args[2]];
  if (!pr) fail('not found');
  const remove = args.includes('--remove-label') ? args[args.indexOf('--remove-label') + 1].split(',') : [];
  const add = args.includes('--add-label') ? args[args.indexOf('--add-label') + 1].split(',') : [];
  pr.labels = [...pr.labels.filter((label) => !remove.includes(label.name ?? label)), ...add.map((name) => ({ name }))];
  save(); reply(pr);
}
if (args[0] === 'pr' && args[1] === 'view') {
  if (state.failView?.[args[2]]) fail(state.failView[args[2]]);
  const pr = state.prs[repoArg() + '#' + args[2]]; if (pr) reply(pr); else fail('not found'); }
if (args[0] === 'pr' && args[1] === 'merge') {
  if (state.failMerge?.[args[2]]) fail(state.failMerge[args[2]]);
  const pr = state.prs[repoArg() + '#' + args[2]];
  if (state.moveHeadAtMerge) { pr.headRefOid = state.moveHeadAtMerge; save(); }
  if (args[args.indexOf('--match-head-commit') + 1] !== pr.headRefOid) fail('head SHA does not match');
  if (state.mergeSucceeds !== false) {
    pr.state = 'MERGED';
    pr.mergeCommit = { oid: 'merge-fixture-sha' };
    pr.mergedAt = state.commentAt ?? '2024-05-01T04:00:00Z';
  }
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

  const docsConfig = path.join(tmp, 'docs-config');
  const lifecycle = fs.readFileSync(path.join(ROOT, 'references', 'lifecycle.md'), 'utf8');
  for (const [, file, yaml] of lifecycle.matchAll(/^### `(me\.yaml|projects\/demo\.yaml)`\n\n```yaml\n([\s\S]*?)^```$/gm)) {
    write(path.join(docsConfig, file), yaml);
  }
  const example = loopctl(['config-resolve', '--project', 'demo'], docsConfig);
  const exampleBranches = [['L1', '--branch', 'main'], ['L2'], ['L3']].map((tierArgs) =>
    loopctl(['preview-init', '--req', 'demo-task', '--project', 'demo', '--tier', ...tierArgs], docsConfig).json.branch);
  const { meFile, projectFile, user, forge: platform, tier, workHours, hubRepo, baselineBranch, verification, roleModels, thresholds } = example.json;
  eq('lifecycle.md 示例可解析，L1 指定 main，L2/L3 使用默认需求基线', [
    example.code, meFile, projectFile, user, platform, tier, workHours, hubRepo?.repo, hubRepo?.path,
    hubRepo?.verificationCommand, baselineBranch, verification?.mode, exampleBranches,
  ], [
    0, path.join(docsConfig, 'me.yaml'), path.join(docsConfig, 'projects', 'demo.yaml'), 'demo-user', 'github', 'L1',
    { start: '09:30', end: '18:30', timezone: 'Asia/Shanghai' }, 'example-org/demo', '/work/demo',
    'npm ci && npm test', null, 'local-test', ['main', 'loop/demo-task', 'loop/demo-task'],
  ]);
  eq('R32 文档中的 me.yaml 可直接解析巡检模型和两个定时周期', [
    example.code, roleModels?.controller, roleModels?.patrol, roleModels?.finalReviewer,
    thresholds?.controllerLoopMinutes, thresholds?.smallPatrolMinutes,
  ], [0, 'antigravity/gemini-4-neon', 'antigravity/gemini-4-hydrogen', 'magpie_codex/gpt-6.2-sol', 10, 20]);

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

  const branchArgs = ['--req', 'br', '--project', 'core', '--branch', 'loop/confirmed', '--session', 'br-controller'];
  const prevBranch = loopctl(['preview-init', ...branchArgs], configDir);
  const initBranch = loopctl(['init', ...branchArgs], configDir);
  eq('--branch 预览与初始化一致', [prevBranch.json.branch, initBranch.json.branch, initBranch.json.run.baselineBranch], ['loop/confirmed', 'loop/confirmed', 'loop/confirmed']);
  includes('确认单基线显示 --branch', prevBranch.json.confirmSheet[1], '基线=loop/confirmed');
  eq('预览与初始化定时任务完全一致', prevBranch.json.plan.scheduledTasks, initBranch.json.scheduledTasks);
  eq('预览与初始化标签同步参数一致', prevBranch.json.plan.labelsSync, initBranch.json.forgePlan.labelsSync);

  const templated = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--overrides', JSON.stringify({ branchTemplate: 'feature_2611B_{slug}' })], configDir);
  const templatedOverride = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--overrides', JSON.stringify({ branchTemplate: 'feature_2611B_{slug}' }), '--branch', 'loop/custom'], configDir);
  eq('branchTemplate 自动推算且 --branch 优先', [templated.json.branch, templatedOverride.json.branch], ['feature_2611B_feat-x', 'loop/custom']);
  const explicitBaseline = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--overrides', '{"baselineBranch":"loop/configured"}'], configDir);
  eq('配置了 baselineBranch 时保留显式基线', explicitBaseline.json.branch, 'loop/configured');
  const manualText = '6. 合并方式：全部人工合并（基线是受保护分支）';
  for (const branch of ['main', 'preprod']) {
    const protectedPreview = loopctl(['preview-init', '--req', 'feat-x', '--project', 'core', '--tier', 'L2', '--branch', branch,
      '--overrides', '{"protectedEnvBranches":["preprod"]}'], configDir);
    includes(`L2 确认单展示 ${branch} 的人工合并限制`, protectedPreview.json.confirmSheet[5], manualText);
    excludes(`L2 基线 ${branch} 只提供全人工模式`, protectedPreview.json.confirmSheet[5], '自动合并低风险变更');
  }

  const modeArgs = ['--req', 'manual-start', '--project', 'core', '--tier', 'L2'];
  const modePreview = loopctl(['preview-init', ...modeArgs], configDir);
  const manualArgs = [...modeArgs, '--overrides', '{"autoMerge":false}'];
  const manualPreview = loopctl(['preview-init', ...manualArgs], configDir);
  const manualInit = loopctl(['init', ...manualArgs], configDir);
  eq('回复改成全人工后重新预览再初始化，确认单第 6 行和运行态均切换', [
    modePreview.json.confirmSheet[5], manualPreview.json.confirmSheet[5], manualInit.json.confirmSheet[5],
    manualPreview.json.autoMerge, readJson(path.join(configDir, 'runs', 'manual-start.json')).autoMerge,
  ], ['6. 合并方式：自动合并低风险变更', '6. 合并方式：全部人工合并',
    '6. 合并方式：全部人工合并', false, false]);

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
  includes('独立需求基线仍可低风险自动合并', init.json.confirmSheet[5], '自动合并低风险变更');
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
    verification: { mode: 'local-test', skipReason: 'fixture race test' },
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
  eq('并发失败者未留下临时文件', fs.readdirSync(path.join(configDir, 'runs')).sort(), ['br.json', 'export-md.json', 'manual-start.json', 'race.json']);

  const staged = loopctl(['init', '--req', 'bind-tasks', '--project', 'core', '--tier', 'L2'], configDir);
  const tasks = staged.json.scheduledTasks;
  const bound = loopctl(['init', '--req', 'bind-tasks', '--resume', '--issue-map', '{"main":"#202"}'], configDir);
  eq('回填后 L2 任务保留原 ID，并使用真实台账编号', [bound.code, bound.json.scheduledTasks.map((task) => [task.id, task.ledgerRef])],
    [0, tasks.map((task) => [task.id, '#202'])]);
  ok('回填后的任务说明也引用真实台账', bound.json.scheduledTasks.every((task) => task.description.includes('；台账=#202；')));

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
  eq('L1 确认单第 6 行默认全人工', pre.json.confirmSheet[5], '6. 合并方式：全部人工合并');
  includes('确认单保留两步拆架约定', pre.json.confirmSheet[4], 'teardown 两步拆架');
  includes('确认单工作时段来自配置', pre.json.confirmSheet[4], '09:00-19:00（Asia/Shanghai）');
  eq('L1 应建 1 个 tracking 台账', pre.json.plan.ledgers.map((l) => l.key), ['tracking']);
  eq('L1 不建定时任务', pre.json.plan.scheduledTasks.length, 0);
  eq('L1 标签集补齐待合并', pre.json.plan.labels, ['待终审', '终审中', '待合并', '需修改', '风险高', '风险低', '需求:export-md']);
  includes('L1 标签同步按清单传 --labels', pre.json.plan.labelsSync.args, '--labels');

  const init = loopctl(['init', '--req', 'export-md', '--project', 'gh-tool', '--branch', 'feat/export', '--session', 'l1-controller'], configDir);
  eq('init 退出码 0', init.code, 0);
  eq('--branch 覆盖运行态基线', [init.json.branch, init.json.run.baselineBranch], ['feat/export', 'feat/export']);
  eq('L1 台账标题', init.json.ledgers[0].title, '【Loop】export-md');
  eq('L1 台账固定 4 节', (init.json.ledgers[0].body.match(/^## /gm) ?? []).length, 4);
  eq('L1 默认关闭自动合并并持久化', init.json.run.autoMerge, false);
  const issuePlan = init.json.forgePlan.issueCreates[0];
  eq('首次 init 的建台账计划含键、标题和渲染正文', issuePlan,
    { key: 'tracking', title: '【Loop】export-md', body: init.json.ledgers[0].body, labels: [] });
  includes('计划正文写入实际主控会话', issuePlan.body, '主控：第 1 任 ｜ l1-controller ｜ local ｜');
  const resume = (...args) => loopctl(['init', '--req', 'export-md', '--resume', ...args], configDir);
  eq('中断后可以读回待建台账正文', resume().json.forgePlan.issueCreates, [issuePlan]);
  const issue = { id: '#7', url: 'https://github.com/acme/gh-tool/issues/7' };
  const issueArgs = ['--issue-map', JSON.stringify({ tracking: issue })];
  const bound = resume(...issueArgs);
  eq('回填后运行态、台账描述和待建计划一致', [
    bound.code, bound.json.run.issues.tracking, readJson(init.json.runPath).ledgers[0].issue, bound.json.forgePlan.issueCreates,
  ], [0, issue, issue, []]);
  eq('回填保留已生成的正文、初始化历史和会话', [
    bound.json.run.ledgers[0].body, bound.json.run.history, bound.json.run.controller,
  ], [issuePlan.body, init.json.run.history, init.json.run.controller]);
  const boundFile = fs.readFileSync(init.json.runPath, 'utf8');
  eq('回填同一编号可重试，其他编号不能覆盖', [resume(...issueArgs).code, resume('--issue-map', '{"tracking":"#8"}').json.code,
    fs.readFileSync(init.json.runPath, 'utf8')], [0, 'ISSUE_ALREADY_BOUND', boundFile]);

  const fake = makeFakeForge(path.join(tmp, 'teardown-forge'));
  fake.reset({
    issues: { 'acme/gh-tool#7': { state: 'unknown' } },
    failApi: ['repos/acme/gh-tool/issues?state=all&labels=' + encodeURIComponent('需求:export-md') + '&per_page=100'],
  });
  const gheHost = 'git.example.test';
  const hostReq = 'ghe-host';
  const hostInit = loopctl(['init', '--req', hostReq, '--project', 'gh-tool', '--tier', 'L2', '--issue-map', '{"main":7}',
    '--overrides', JSON.stringify({ hostname: gheHost })], configDir);
  const sha = 'e'.repeat(40);
  const hostForge = makeFakeForge(path.join(tmp, 'ghe-forge'));
  hostForge.reset({ issues: { 'acme/gh-tool#7': { state: 'OPEN', labels: [], updatedAt: '2024-05-01T04:00:00Z' } },
    branches: { 'repos/acme/gh-tool/branches/loop%2Fghe-host': { commit: { sha } } } });
  const gheTeardown = loopctl(['teardown', '--req', hostReq], configDir, hostForge.env);
  const hostOf = (args) => args?.[args.indexOf('--hostname') + 1];
  eq('GitHub Enterprise 实例贯穿标签、拆架命令及所有实际读请求', [
    hostOf(hostInit.json.forgePlan?.labelsSync.args),
    ...gheTeardown.json.closingComments.flatMap(({ commands }) => commands.map(hostOf)),
    ...new Set(hostForge.calls().map(({ ghHost }) => ghHost)),
  ], Array(4).fill(gheHost));
  const callCount = hostForge.calls().length;
  const wrongHostMerge = forge(['change-merge', '--forge', 'github', '--hostname', 'other.example.test', '--run', hostInit.json.runPath,
    '--repo', 'acme/gh-tool', '--id', '8', '--head-sha', sha, '--target', 'loop/ghe-host', '--dry-run'], hostForge.env);
  eq('同 owner/repo 但实例不同的合并在访问 Forge 前被拦住', [wrongHostMerge.json.code, hostForge.calls().length], ['FORGE_NOT_IN_RUN', callCount]);
  const failedLive = loopctl(['status', '--json', '--req', 'export-md', '--live'], configDir, fake.env);
  eq('实时读取有失败时在概览开头列出条数与错误码',
    [failedLive.code, failedLive.json.live.overview.headline.split(' ｜ ')[0]],
    [0, 'Forge 实时读取失败 2 项（EXEC_FAILED、INVALID_FORGE_FACT）']);
  const mergedUrl = 'https://github.com/acme/gh-tool/pull/8';
  const mergedSha = '8'.repeat(40);
  const latest = '9'.repeat(40);
  const updatedAt = '2024-05-01T04:00:00Z';
  const forgeState = {
    issues: { 'acme/gh-tool#7': { state: 'OPEN', labels: [], updatedAt } },
    prs: {
      'acme/gh-tool#8': {
        state: 'MERGED', headRefOid: '1'.repeat(40), headRefName: 'dev/export', baseRefName: 'feat/export',
        mergeCommit: { oid: mergedSha }, url: mergedUrl, labels: ['需求:export-md'], updatedAt,
      },
    },
  };
  fake.reset(forgeState);
  const partialPlan = loopctl(['teardown', '--req', 'export-md'], configDir, fake.env);
  eq('基线读取失败时只把基线标为读取失败', [
    partialPlan.json.closingComments[0].body.split('\n').at(-1), partialPlan.json.forgeReadErrors.map(({ code }) => code),
  ], ['- 上线基线：feat/export@读取失败', ['EXEC_FAILED']]);
  fake.reset({ ...forgeState, branches: { 'repos/acme/gh-tool/branches/feat%2Fexport': { commit: { sha: latest } } } });
  const plan = loopctl(['teardown', '--req', 'export-md'], configDir, fake.env);
  eq('拆架第 1 步只出清单', [plan.code, plan.json.phase, plan.json.runRetained], [0, 'planned', true]);
  ok('第 1 步保留活动 run', fs.existsSync(path.join(configDir, 'runs', 'export-md.json')));
  eq('L1 无定时任务可停', plan.json.scheduledTasksToStop.length, 0);
  eq('完结评论覆盖已绑定台账', plan.json.closingComments.map((c) => c.key), ['tracking']);
  eq('空本地变更快照下，完结评论使用 Forge 合入的 PR 与基线分支当前 SHA', [
    readJson(init.json.runPath).changes, plan.json.closingComments[0].body.split('\n').filter((line) => /已合入的变更单|上线基线/.test(line)),
  ], [[], [`- 已合入的变更单：${mergedUrl}`, `- 上线基线：feat/export@${latest}`]]);
  includes('台账关闭命令走 forge issue-close', plan.json.closingComments[0].commands[1], 'issue-close');
  eq('台账关闭命令编号去 #', plan.json.closingComments[0].commands[1].slice(-1), ['7']);

  const noResults = loopctl(['teardown', '--req', 'export-md', '--finalize'], configDir);
  eq('--finalize 无 --results 退出 2 且保留 run', [noResults.code, noResults.json.code, fs.existsSync(init.json.runPath)], [2, 'MISSING_RESULTS', true]);
  const finalize = (results) => loopctl(['teardown', '--req', 'export-md', '--finalize', '--results', JSON.stringify(results)], configDir, fake.env);
  fake.reset({ issues: { 'acme/gh-tool#7': { state: 'OPEN', labels: [], updatedAt } } });
  const legacyReceipt = { ledgers: { tracking: { closed: true } } };
  const early = finalize(legacyReceipt);
  eq('台账回执 closed:true 但实查打开则拒绝归档', [early.code, early.json.code], [3, 'TEARDOWN_INCOMPLETE']);
  includes('失败原因区分实查打开', early.json.failures[0].reason, '仍为打开状态');
  ok('失败后 run 仍在可重试', fs.existsSync(path.join(configDir, 'runs', 'export-md.json')));
  const archivePath = path.join(configDir, 'runs', 'archive', 'export-md.json');
  fake.reset({});
  const unavailable = finalize(legacyReceipt);
  eq('Forge 实查失败则拒绝归档且保留 run', [unavailable.code, unavailable.json.code, fs.existsSync(init.json.runPath), fs.existsSync(archivePath)], [3, 'TEARDOWN_INCOMPLETE', true, false]);
  includes('查状态失败原因保留错误码', unavailable.json.failures[0].reason, 'EXEC_FAILED');
  fake.reset({ issues: { 'acme/gh-tool#7': { state: 'MERGED' } } });
  includes('异常 Issue 状态归类为实查失败', finalize(legacyReceipt).json.failures[0].reason, 'INVALID_FORGE_FACT');
  fake.reset({ issues: { 'acme/gh-tool#7': { state: 'CLOSED', labels: [], updatedAt } } });
  const done = finalize({});
  eq('台账实查关闭可在无台账回执时归档', [done.code, done.json.status, done.json.zeroResidue], [0, 'archived', true]);
  eq('预检模板和归档都不记录台账关闭回执', [plan.json.resultsTemplate.ledgers, readJson(archivePath).teardown.results.ledgers], [undefined, undefined]);
  eq('归档保留出清单时的完结评论正文', readJson(archivePath).teardown.closingComments[0].body, plan.json.closingComments[0].body);
  eq('拆架归档只读需求成员列表及预检清单上的台账', fake.calls().map((c) => c.args.slice(0, 5)), [
    ['api', 'repos/acme/gh-tool/issues?state=all&labels=' + encodeURIComponent('需求:export-md') + '&per_page=100'],
    ['issue', 'view', '7', '--repo', 'acme/gh-tool'],
    ['api', 'repos/acme/gh-tool/issues/7/comments?per_page=100'],
  ]);
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
  ok('L2 两个角色的任务描述第一句均先跑自己的 tick', init.json.scheduledTasks.every((task) =>
    task.description.startsWith(`先跑 \`node ${LOOPCTL} tick --req night-run --role ${task.role} --apply --config-dir ${configDir}`
      + (task.role === 'controller' ? ` --session ${init.json.run.controller.sessionId}` : '') + '\`，无输出即结束本轮。')));
  eq('L2 主台账固定 5 节', (init.json.ledgers[0].body.match(/^## /gm) ?? []).length, 5);
  const l2Preview = loopctl(['preview-init', '--req', 'night-run', '--project', 'demo-l2'], configDir);
  includes('L2 确认单节奏为主控30m+静音巡检60m', l2Preview.json.confirmSheet[4], '主控30m+静音巡检60m');

  // ---- 唤醒判定 ----
  const wake = (payload) => loopctl(['wake-decision', ...input(payload)], configDir).json;
  const ids = { currentSessionId: 's1', ledgerControllerId: 's1' };
  const SH = { workHours: '09:00-19:00', timezone: 'Asia/Shanghai' };
  const idle = wake({ ...ids, state: '空闲' });
  eq('空闲且标识是自己 → 开轮', [idle.action, idle.code, idle.identity.verified], ['start-round', 'SELF_IDLE_START', true]);
  const selfNoIds = wake({ isSelf: true, state: '空闲' });
  eq('缺双方标识时 identity.verified 为 false', [selfNoIds.action, selfNoIds.identity.verified], ['start-round', false]);
  const pausedNoIds = wake({ isSelf: true, state: '暂停（原：空闲）' });
  eq('暂停态不误开轮', [pausedNoIds.action, pausedNoIds.code], ['paused-hold', 'SELF_PAUSED_HOLD']);
  const heartbeat = wake({ ...ids, state: '执行中', runningMinutes: 45 });
  eq('执行中未满 2h → 仅心跳', [heartbeat.action, heartbeat.code], ['heartbeat', 'SELF_RUNNING_HEARTBEAT']);
  const heal = wake({ ...ids, state: '执行中', runningMinutes: 150 });
  eq('执行中满 2h → 自愈', [heal.action, heal.selfHeal.atMinutes], ['self-heal', 120]);
  const explicitRunning = wake({ ...ids, state: '执行中', runningMinutes: 10, explicitTakeover: true });
  eq('执行中且本人要求继续 → 先确认上一轮已停', [explicitRunning.action, explicitRunning.code], ['confirm-previous-stopped', 'SELF_RUNNING_EXPLICIT']);
  const paused = wake({ ...ids, state: '暂停（原：执行中）', runningMinutes: 500 });
  eq('暂停态（原执行中）仅心跳不误开轮', [paused.action, paused.code], ['paused-hold', 'SELF_PAUSED_HOLD']);
  const offHours = wake({ ...ids, ...SH, state: '空闲', now: '2024-05-01T17:00:00Z' });
  eq('上海 01:00 定时唤醒 → 只心跳', [offHours.action, offHours.code], ['heartbeat-only', 'OFF_HOURS_HEARTBEAT']);
  const offRunning = wake({ ...ids, ...SH, state: '执行中', runningMinutes: 300, now: '2024-05-01T17:00:00Z' });
  eq('非工作时段执行中也不自愈开工', offRunning.action, 'heartbeat-only');
  const inHours = wake({ ...ids, ...SH, state: '空闲', now: '2024-05-01T02:00:00Z' });
  eq('上海 10:00 正常开轮', inHours.action, 'start-round');
  const userWake = wake({ ...ids, ...SH, state: '空闲', now: '2024-05-01T17:00:00Z', trigger: 'user' });
  eq('本人主动唤醒不受工作时段限制', userWake.action, 'start-round');
  const nightWin = wake({ ...ids, workHours: '22:00-06:00', timezone: 'Asia/Shanghai', state: '空闲', now: '2024-05-01T17:00:00Z' });
  eq('跨午夜工作窗 01:00 在窗内', [nightWin.action, nightWin.workHours.inside], ['start-round', true]);
  const splitBrain = wake({ isSelf: true, currentSessionId: 's9', ledgerControllerId: 's1', state: '执行中', runningMinutes: 10 });
  eq('旧主控标识不一致 → 退出非现任', [splitBrain.action, splitBrain.code, splitBrain.identity.isSelf], ['exit-non-current', 'EXIT_NON_CURRENT', false]);
  const takeover = wake({ currentSessionId: 's9', ledgerControllerId: 's1', state: '空闲', handoffBasis: true });
  eq('有依据无交接 → 按依据接任 + 首轮边界', [takeover.action, takeover.firstRoundBoundary], ['take-over-by-basis', true]);
  const scheduled = { ...SH, currentSessionId: 's9', ledgerControllerId: 's1', trigger: 'scheduled', handoffBasis: true, handoffComment: true };
  const waitTakeover = wake({ ...scheduled, now: '2024-05-01T17:00:00Z' });
  eq('窗外定时接任等开工', [waitTakeover.action, waitTakeover.code], ['outside-work-hours-wait', 'OFF_HOURS_TAKEOVER_WAIT']);
  const manualContinue = wake({ ...scheduled, now: '2024-05-01T17:00:00Z', manualContinue: true });
  eq('窗外明确继续保留人工接任路径', [manualContinue.action, manualContinue.firstRoundBoundary], ['take-over-by-basis', false]);
  const workTakeover = wake({ ...scheduled, now: '2024-05-02T02:00:00Z' });
  eq('窗内定时唤醒按交接依据接任', workTakeover.action, 'take-over-by-basis');
  const active = wake({ currentSessionId: 's9', ledgerControllerId: 's1', state: '空闲', explicitTakeover: true });
  eq('本人明确接管 → 主动接任', [active.action, active.code], ['take-over-active', 'TAKEOVER_EXPLICIT']);

  // ---- 拆架：阻断、强制、未知 worktree、失败重试 ----
  const teardownForge = makeFakeForge(path.join(tmp, 'teardown-forge'));
  const nightAt = '2024-05-01T04:00:00Z';
  const nightLedger = { state: 'closed', labels: [], updated_at: nightAt, description: '关联 #10' };
  const nightState = {
    issues: {
      'acme/core-svc#201': nightLedger,
      'acme/core-svc#10': { ...nightLedger, state: 'opened', labels: ['阻断', '需求:night-run'] },
    },
    mrs: { 'acme/core-svc!9': { state: 'opened', target_branch: 'main', source_branch: 'dev/night',
      sha: 'a'.repeat(40), labels: ['需求:night-run'], updated_at: nightAt } },
  };
  teardownForge.reset(nightState);
  const finalizeNight = (results) => loopctl(['teardown', '--req', 'night-run', '--finalize', '--results', JSON.stringify(results)], configDir, teardownForge.env);
  const worktreeDir = path.join(tmp, 'worktrees', 'wt-1');
  fs.mkdirSync(worktreeDir, { recursive: true });
  patchRun(configDir, 'night-run', (run) => {
    run.changes = [{ repo: 'acme/core-svc', id: 9, state: 'opened', title: 'feat: 跨夜变更', url: 'https://forge.example/acme/core-svc/9' }];
    run.worktrees = [worktreeDir];
    run.blockers = [{ id: 'B-1', title: '契约未冻结', state: 'open', closed: false }];
  });
  const blocked = loopctl(['teardown', '--req', 'night-run'], configDir, teardownForge.env);
  eq('未结 MR 与阻断阻止拆架', [blocked.code, blocked.json.status, blocked.json.blocked.map((b) => b.kind)], [3, 'blocked', ['change', 'blocker']]);
  const planned = loopctl(['teardown', '--req', 'night-run', '--force'], configDir, teardownForge.env);
  eq('--force 只出清单不删 run', [planned.code, planned.json.phase, planned.json.forced], [0, 'planned', true]);
  eq('清单含 2 个定时任务', planned.json.scheduledTasksToStop.length, 2);
  eq('非 git 目录标 unknown 而非已移除', planned.json.worktrees[0].status, 'unknown');
  ok('第 1 步后 run 仍在', fs.existsSync(path.join(configDir, 'runs', 'night-run.json')));
  const taskResults = Object.fromEntries(init.json.scheduledTasks.map((t) => [t.id, { stopped: true }]));
  const partial = finalizeNight({ tasks: taskResults });
  eq('unknown worktree 未确认 → 拒绝归档', [partial.code, partial.json.code], [3, 'TEARDOWN_INCOMPLETE']);
  includes('失败原因写明 git 状态未知', partial.json.failures, 'git 状态未知');
  const lie = finalizeNight({ worktrees: { [worktreeDir]: { removed: true } } });
  includes('回执已删但目录仍在 → 继续拒绝', lie.json.failures, '目录仍存在');
  ok('多次失败后 run 仍可重试', fs.existsSync(path.join(configDir, 'runs', 'night-run.json')));
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  teardownForge.reset({ issues: { 'acme/core-svc#201': nightLedger } });
  const replanTeardown = loopctl(['teardown', '--req', 'night-run'], configDir, teardownForge.env);
  eq('重出清单保留原 unknown 状态及已有强制豁免', [replanTeardown.json.worktrees[0].dirty, replanTeardown.json.forcedWaivers.length], [null, 2]);
  const unverified = finalizeNight({});
  includes('unknown 目录即使已删除仍要求核实干净回执', unverified.json.failures, 'verifiedClean');
  const finalOk = finalizeNight({ worktrees: { [worktreeDir]: { removed: true, verifiedClean: true } } });
  eq('实际清理和核实后重试可归档，历史强制豁免保留', [finalOk.code, finalOk.json.status, finalOk.json.zeroResidue, finalOk.json.forced], [0, 'archived', false, true]);
  eq('未读到业务仓状态如实记录', finalOk.json.unverifiedItems.map((item) => item.status), ['unknown']);
  eq('归档中的强制豁免包含原未结变更和阻断', finalOk.json.forcedWaivers.map((item) => item.kind), ['change', 'blocker']);
  const readArchive = loopctl(['teardown', '--req', 'night-run'], configDir, teardownForge.env);
  eq('重读归档不能变成零残留', [readArchive.json.alreadyArchived, readArchive.json.zeroResidue, readArchive.json.forcedWaivers.length], [true, false, 2]);
  ok('L2 归档文件存在', fs.existsSync(path.join(configDir, 'runs', 'archive', 'night-run.json')));
}

/* ================================================================== */
/* 场景 4：L3 团队严格档                                                  */
/* ================================================================== */

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
  eq('L3 只建原有四个角色的定时任务', init.json.scheduledTasks.map((t) => t.role), ['controller', 'patrol', 'dispatch', 'lead-patrol']);
  eq('个人主控/小巡检绑定个人小台账', init.json.scheduledTasks.slice(0, 2).map((t) => t.ledgerRef), ['#301', '#301']);
  eq('调度/大巡检绑定总台账', init.json.scheduledTasks.slice(2).map((t) => t.ledgerRef), ['#300', '#300']);
  includes('定时任务描述固定尾句', init.json.scheduledTasks[0].description, '以台账为准');
  includes('定时任务描述显式指向 Skill 与角色入口文件', init.json.scheduledTasks[0].description, '使用 $xxn-lite-loop（必读 references/controller.md）');
  includes('调度任务描述指向 review-and-dispatch.md', init.json.scheduledTasks[2].description, 'references/review-and-dispatch.md');
  excludes('定时任务描述不写当前阶段', init.json.scheduledTasks[0].description, 'P0');
  includes('L3 标签含槽位标签', init.json.labels, '槽位A');

  const daily = loopctl(['preview-init', '--req', 'squad-daily', '--project', 'squad', '--overrides', JSON.stringify({ notify: { dailyReportEnabled: true, dailyReportTime: '11:30' } })], configDir);
  eq('启用日报也只保留四个原 ID 和各自间隔', daily.json.plan.scheduledTasks.map((task) => [task.role, task.everyMinutes, task.schedule, task.at]),
    [['controller', 30, 'interval', undefined], ['patrol', 60, 'interval', undefined], ['dispatch', 30, 'interval', undefined], ['lead-patrol', 30, 'interval', undefined]]);
  ok('L3 四个角色先跑自己的 tick 且继续指向原角色入口', init.json.scheduledTasks.every((task) =>
    task.description.startsWith(`先跑 \`node ${LOOPCTL} tick --req squad-run --role ${task.role} --apply --config-dir ${configDir}`
      + (task.role === 'controller' ? ` --session ${init.json.run.controller.sessionId}` : '') + '\`，无输出即结束本轮。')
      && task.description.includes(task.entryDoc)));
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

  const claimConfig = path.join(tmp, 'join-only');
  const claimForge = makeFakeForge(path.join(tmp, 'claim-forge'));
  const claimRepo = 'acme/loop';
  const masterUrl = `https://github.com/${claimRepo}/issues/9`;
  const masterNotes = `repos/${claimRepo}/issues/9/comments`;
  const master = { state: 'OPEN', body: '## 3. 各开发者\n| A | 待认领 | 无 | 无 | 无 |' };
  const boundNote = (id, slot, session, at) => ({ id, user: { login: session }, created_at: at,
    body: `主控 ｜ ${slot} ｜ ${session}\n【配置变更】绑定 槽位${slot}｜dev｜${session}` });
  const bound = [
    boundNote(12, 'A', 'member-c', '2024-05-01T10:00:01+08:00'),
    boundNote(10, 'A', 'member-a', '2024-05-01T02:00:00Z'),
    boundNote(11, 'B', 'member-b', '2024-05-01T01:59:00Z'),
  ];
  const join = (...flags) => loopctl(['slot-claim', '--req', 'join-demo', '--slot', 'A', ...flags], claimConfig, claimForge.env);
  claimForge.reset({ viewer: 'member-a', issues: { [claimRepo + '#9']: master }, comments: { [masterNotes]: [bound] } });
  const firstClaim = join('--master', masterUrl, '--session', 'member-a');
  eq('首次加入没有运行态，仍从总台账实查最早绑定并允许建本人小台账', [
    firstClaim.json.winner?.sessionId, firstClaim.json.currentWins, firstClaim.json.ledgerAction,
    fs.existsSync(path.join(claimConfig, 'runs')),
  ], ['member-a', true, 'create-ledger-after-bind', false]);
  claimForge.reset({ viewer: 'member-c', issues: { [claimRepo + '#9']: master }, comments: { [masterNotes]: [bound] } });
  const conflict = join('--master', masterUrl, '--session', 'member-c');
  eq('抢槽冲突从 Forge 生成原评论链接且不落盘', [
    conflict.json.action, conflict.json.ledgerAction, conflict.json.comment?.includes(masterUrl + '#issuecomment-12'),
    fs.existsSync(path.join(claimConfig, 'runs')),
  ], ['withdraw-binding', 'none', true, false]);
  const withdraw = { ...bound[1], id: 13, created_at: '2024-05-01T02:00:02Z',
    body: `主控 ｜ A ｜ member-a\n【配置变更】撤回绑定：槽位A｜原评论链接 ${masterUrl}#issuecomment-10｜移交` };
  claimForge.reset({ viewer: 'member-c', issues: { [claimRepo + '#9']: { ...master, body: '## 3. 各开发者\n| A | 显示名 | 无 | 无 | #14 |' } },
    comments: { [masterNotes]: [[...bound, withdraw]] } });
  write(path.join(claimConfig, 'runs/join-demo.json'), JSON.stringify({ forge: 'github', tier: 'L3',
    hubRepo: { repo: claimRepo }, issues: { master: '#9' }, controller: { sessionId: 'member-c' } }));
  const reused = join();
  eq('已有运行态只传 req 和 slot，核对原评论撤回后复用 Forge 上已登记的小台账', [
    reused.json.winner?.sessionId, reused.json.currentWins, reused.json.ledgerAction,
  ], ['member-c', true, 'reuse-existing-ledger']);
  const rebound = join('--session', 'member-c-new');
  eq('R5/04 同一 Forge 用户换会话可以复用小台账并撤回旧绑定', [
    rebound.json.currentWins, rebound.json.ledgerAction, rebound.json.withdrawalComment?.includes('#issuecomment-12'),
  ], [true, 'reuse-existing-ledger', true]);
  const reboundFacts = readJson(claimForge.env.FAKE_FORGE_STATE);
  reboundFacts.comments[masterNotes][0].push({ id: 15, user: { login: 'member-c' }, created_at: '2024-05-01T02:05:00Z',
    body: `主控 ｜ A ｜ member-c-new\n${rebound.json.withdrawalComment}` });
  claimForge.reset({ ...reboundFacts, viewer: 'member-b' });
  eq('R5/04 新会话签名的撤回按同一 Forge 用户生效', join('--session', 'member-b').json.action, 'claim');
  claimForge.reset({ issues: { [claimRepo + '#9']: master }, failApi: [masterNotes + '?per_page=100'] });
  eq('总台账评论读取失败不误判槽位可认领', join().json.code, 'EXEC_FAILED');

  const customNotify = { notify: { feishuGroupChatId: 'oc_demo_group', externalMentionWindow: '10:00-16:00' } };
  const resolvedWindow = loopctl(['config-resolve', '--project', 'squad', '--overrides', JSON.stringify(customNotify)], configDir);
  const confirmWindow = loopctl(['preview-init', '--req', 'window', '--project', 'squad', '--overrides', JSON.stringify(customNotify)], configDir);
  eq('notify.externalMentionWindow 成为实际提醒阈值', resolvedWindow.json.thresholds.externalMentionWindow, { start: '10:00', end: '16:00' });
  includes('确认单显示实际提醒窗', confirmWindow.json.confirmSheet[4], '限10:00-16:00@');

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
  const teardownForge = makeFakeForge(path.join(tmp, 'teardown-forge'));
  const closedLedgers = Object.fromEntries([300, 301, 303].map((id) => ['acme/squad-api#' + id, { state: 'closed', labels: [], updated_at: '2024-05-01T04:00:00Z' }]));
  Object.assign(closedLedgers['acme/squad-api#303'], { title: '【小台账】A-dev-a', labels: ['需求:squad-run', '槽位A'] });
  closedLedgers['acme/squad-api#300'].description = '## 3. 各开发者\n| A | dev-a | 开发 | 无 | #303 |';
  const closedTeardown = withSlotBindings({ issues: closedLedgers }, 'projects/acme%2Fsquad-api/issues/300/notes',
    slotBinding(8001, 'A', 'dev-a', 'slot-a'));
  const openMaster = { ...closedTeardown, issues: { ...closedLedgers, 'acme/squad-api#300': { ...closedLedgers['acme/squad-api#300'], state: 'opened' } } };
  teardownForge.reset(openMaster);
  const teardown = (args = []) => loopctl(['teardown', '--req', 'squad-run', ...args], configDir, teardownForge.env);
  const finalize = (results) => teardown(['--finalize', '--results', JSON.stringify(results)]);
  const forgeIssue = (labels) => ({ state: 'opened', labels: [...labels, '需求:squad-run'], updated_at: '2024-05-01T04:00:00Z' });
  const demandMr = { ...forgeIssue([]), target_branch: init.json.run.baselineBranch, source_branch: 'dev/other-slot', sha: 'a'.repeat(40) };
  const crossMachine = {
    ...openMaster,
    issues: {
      ...openMaster.issues,
      'acme/squad-api#300': { ...openMaster.issues['acme/squad-api#300'], description:
        openMaster.issues['acme/squad-api#300'].description + '\n## 4. 契约\n关联 #105、#106' },
      'acme/squad-api#105': forgeIssue(['阻断', 'bug']), 'acme/squad-api#106': forgeIssue(['bug']),
    },
    mrs: { 'acme/squad-api!99': demandMr },
  };
  teardownForge.reset(crossMachine);
  eq('复现 04 主研发发现其他机器的未合入变更和阻断缺陷', teardown().json.blocked.map(({ kind, id }) => [kind, id]),
    [['change', 99], ['blocker', 105], ['bug', 106]]);
  eq('未出计划时不能直接归档', finalize({}).json.code, 'TEARDOWN_NOT_PLANNED');
  teardownForge.reset(openMaster);
  const plan = teardown();
  eq('Forge 全部结清后，旧运行态中的未结状态不阻塞拆架', [plan.code, plan.json.status, plan.json.forced, fs.existsSync(init.json.runPath)],
    [0, 'planned', false, true]);
  eq('L3 拆架清单标记协作者台账对应槽位已认领', plan.json.receipts.map((r) => [r.slot, r.claimed]), [['A', true], ['B', false]]);
  eq('L3 完结评论合并本机和实查的协作者台账', plan.json.closingComments.map((c) => c.key), ['master', 'slot:主研发', 'slot:A']);
  eq('工作树预检保留真实干净及脏状态', plan.json.worktrees.map((item) => item.dirty), [false, true, false]);
  teardownForge.reset(crossMachine);
  const freshOpen = finalize({});
  eq('归档时实查发现新未结项会使旧清单失效', [freshOpen.code, freshOpen.json.status, finalize({}).json.code],
    [3, 'blocked', 'TEARDOWN_NOT_PLANNED']);
  teardownForge.reset(openMaster);
  eq('Forge 清掉未结项后可重新进入计划', teardown().json.status, 'planned');
  teardownForge.reset(openMaster);

  const wrongTypes = finalize({
    tasks: Object.fromEntries(init.json.scheduledTasks.map((t) => [t.id, { closed: true }])),
    ledgers: { master: { stopped: true } },
    receipts: { A: { unclaimed: true }, B: { unclaimed: true } },
    worktrees: { [keep]: { keep: true, reason: '  ' } },
  });
  eq('拆架拒绝任务与槽位错位回执、实查未关的台账及无原因保留', [
    wrongTypes.code, [...new Set(wrongTypes.json.failures.map((f) => f.kind))],
  ], [3, ['scheduled-task', 'remote-scheduled-task', 'issue-close', 'worktree']]);
  eq('已认领和未认领分别验回执', wrongTypes.json.failures.filter((f) => f.kind === 'remote-scheduled-task').map((f) => f.id), ['A']);
  eq('L3 归档只从一轮实查取得 GitLab 总台账及本机和协作者小台账', teardownForge.calls()
    .map((c) => c.args.at(-1)).filter((endpoint) => /\/issues\/\d+$/.test(endpoint)), [
    'projects/acme%2Fsquad-api/issues/300', 'projects/acme%2Fsquad-api/issues/301', 'projects/acme%2Fsquad-api/issues/303',
  ]);
  teardownForge.reset(closedTeardown);
  fs.rmSync(clean, { recursive: true, force: true });
  fs.rmSync(dirty, { recursive: true, force: true });
  const results = {
    tasks: Object.fromEntries(init.json.scheduledTasks.map((t) => [t.id, { status: 'stopped' }])),
    receipts: { A: { stopped: true, confirmedBy: ' ' } },
    worktrees: { [clean]: { removed: true }, [dirty]: { removed: true }, [keep]: { keep: true, reason: '保留调试记录' } },
  };
  const noReceipt = finalize(results);
  eq('真实删掉脏目录仍需确认放弃改动，已认领槽也需非空负责人', [noReceipt.code, noReceipt.json.failures.map((f) => f.id)],
    [3, ['A', dirty]]);
  includes('脏工作树失败项明确缺 confirmedDiscard', noReceipt.json.failures, 'confirmedDiscard');
  const sidecars = ['squad-run.outbox.json', 'squad-run.tick-state.patrol.json', 'squad-run.ticks.jsonl'];
  write(path.join(configDir, 'runs', sidecars[0]), '[]');
  write(path.join(configDir, 'runs', sidecars[1]), '{"fullReviewDate":"2024-05-01"}');
  write(path.join(configDir, 'runs', sidecars[2]), '{"role":"patrol","result":"quiet"}\n');
  const archived = finalize({
    receipts: { A: { stopped: true, confirmedBy: 'dev-a' } },
    worktrees: { [dirty]: { removed: true, confirmedDiscard: true } },
  });
  eq('实时核实后无需强制就可归档，有保留项不报零残留', [archived.code, archived.json.status, archived.json.zeroResidue, archived.json.forcedWaivers],
    [0, 'archived', false, []]);
  ok('拆架仅在核验成功后随需求归档队列、巡检状态和唤醒日志', sidecars.every((name) => !fs.existsSync(path.join(configDir, 'runs', name))
    && fs.existsSync(path.join(configDir, 'runs', 'archive', 'squad-run.state', name))));
  eq('归档如实记录保留路径及原因', readJson(archived.json.archivePath).teardown.retainedItems,
    [{ kind: 'worktree', path: keep, status: 'clean', reason: '保留调试记录' }]);

  const slotConfig = path.join(tmp, 'slot-config');
  write(path.join(slotConfig, 'me.json'), JSON.stringify({ user: 'dev-a', defaultTier: 'L3' }));
  write(path.join(slotConfig, 'projects', 'team.json'), JSON.stringify({ forge: 'github', hubRepo: 'acme/team', slots: ['主研发', 'A'], verification: { mode: 'local-test', skipReason: 'fixture slot join' } }));
  const spec = ['--req', 'join-team', '--project', 'team', '--tier', 'L3', '--slot', 'A'];
  const joined = loopctl(['init', ...spec, '--session', 'slot-a', '--issue-map', '{"master":"#5","slot:A":"#7"}'], slotConfig);
  eq('协作者 init 写入 run.slot，只生成本槽位 controller 与 patrol',
    [joined.code, joined.json.run.slot, joined.json.scheduledTasks.map((task) => [task.role, task.ledgerKey, task.ledgerRef])],
    [0, 'A', [['controller', 'slot:A', '#7'], ['patrol', 'slot:A', '#7']]]);
  eq('协作者只生成个人台账模板，主研发共有台账继续从 Forge 读取', joined.json.ledgers.map((ledger) => ledger.key), ['slot:A']);
  eq('未登记槽位不能创建错误绑定', loopctl(['preview-init', ...spec.slice(0, -1), 'Z'], slotConfig).json.code, 'INVALID_SLOT');
  const when = '2024-05-01T04:00:00Z';
  const issue = (body) => ({ body, state: 'OPEN', updatedAt: when, labels: [] });
  const slotBody = joined.json.ledgers.find((ledger) => ledger.issue?.id === '#7')?.body
    ?? '## 1. 基本信息\n主控：第 1 任 ｜ slot-a\n本轮：空闲\n';
  teardownForge.reset(withSlotBindings({ issues: {
    'acme/team#5': issue('## 1. 整体状态\n## 3. 各开发者\n| 主研发 | lead | 开发 | 无 | #6 |\n| A | dev-a | 开发 | 无 | #7 |'),
    'acme/team#6': issue('## 1. 基本信息\n主控：第 1 任 ｜ lead\n本轮：空闲\n'),
    'acme/team#7': issue(slotBody),
  } }, 'repos/acme/team/issues/5/comments', slotBinding(8001, 'A', 'dev-a', 'slot-a')));
  for (const role of ['controller', 'patrol']) loopctl(['tick', '--req', 'join-team', '--role', role, '--now', when, '--apply'], slotConfig, teardownForge.env);
  eq('协作者的两种心跳都只写小台账 #7', teardownForge.calls().filter((call) => call.args[1] === 'edit').map((call) => call.args[2]), ['7', '7']);

  const localWorktree = path.join(tmp, 'member-worktree');
  fs.mkdirSync(localWorktree);
  git(['init', '-q', '-b', 'main'], localWorktree);
  patchRun(slotConfig, 'join-team', (run) => { run.worktrees = [localWorktree]; });
  const slotTeardown = (...args) => loopctl(['teardown', '--req', 'join-team', ...args], slotConfig, teardownForge.env);
  const created = forge(['change-create', '--req', 'join-team', '--config-dir', slotConfig, '--forge', 'github', '--repo', 'acme/team',
    '--source', 'dev/member', '--target', joined.json.run.baselineBranch, '--title', '协作者变更', '--body', 'Refs #7'], teardownForge.env);
  const joinedForge = readJson(teardownForge.env.FAKE_FORGE_STATE);
  joinedForge.prs = { 'acme/team#51': {
    state: 'MERGED', labels: ['需求:join-team'], headRefOid: 'a'.repeat(40), headRefName: 'dev/member',
    baseRefName: joined.json.run.baselineBranch, updatedAt: when, body: 'Refs #7',
  } };
  teardownForge.reset(joinedForge);
  const slotPlan = slotTeardown();
  eq('协作者拆架清单只列本人小台账和本机任务，无远程回执', [
    slotPlan.json.closingComments?.map((item) => item.key), slotPlan.json.scheduledTasksToStop?.length, slotPlan.json.receipts,
  ], [['slot:A'], 2, []]);
  eq('复现 04 已合入的协作者变更不再自阻，登记项只有引用', [
    created.json.member?.id, readJson(joined.json.runPath).changes, slotPlan.json.status,
    slotPlan.json.blockedAtStart, slotPlan.json.closingComments[0].body.includes('acme/team!51'),
  ], [51, [{ repo: 'acme/team', id: 51 }], 'planned', [], true]);
  const memberResults = { tasks: Object.fromEntries(joined.json.scheduledTasks.map(({ id }) => [id, { stopped: true }])) };
  eq('协作者本人小台账和 worktree 未清理仍拒绝归档', slotTeardown('--finalize', '--results', JSON.stringify(memberResults))
    .json.failures?.map(({ kind, id }) => [kind, id]), [['issue-close', 'slot:A'], ['worktree', localWorktree]]);
  fs.rmSync(localWorktree, { recursive: true });
  const keepOpen = readJson(teardownForge.env.FAKE_FORGE_STATE);
  keepOpen.issues['acme/team#7'].state = 'CLOSED';
  teardownForge.reset(keepOpen);
  eq('协作者只给本人回执可归档，即使总台账和其他槽位仍开放', [
    slotTeardown('--finalize', '--results', JSON.stringify({ ...memberResults, worktrees: { [localWorktree]: { removed: true } } })).json.status,
    teardownForge.calls().filter((call) => call.args[0] === 'issue' && call.args[1] === 'view').map((call) => call.args[2]),
  ], ['archived', ['5', '7']]);

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
  });
  seedReviews(runPath, {}, [{
    repo: 'acme/gh-tool', id: 56, session: 'old-reviewer', headSha: 'a'.repeat(40),
    conclusion: '打回', at: '2024-05-01T04:00:00Z', commentId: 1,
  }]);

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
  const brief = loopctl(['brief', '--run', runPath, '--role', 'coder', '--issue', '101', '--change', '56'], configDir);
  includes('升档后任务说明沿用终审日志的历史打回计数', brief.stdout, '已打回 1 次');

  patchRun(configDir, 'upgrade-run', (run) => {
    run.thresholds.controllerLoopMinutes = 43;
  });
  const p3 = upgrade(['--to', 'L3', '--slots', '主研发,A']);
  eq('L2→L3 保留已确认 43m 主控周期', p3.json.scheduledTasks.find((t) => t.role === 'controller').everyMinutes, 43);
  eq('调度周期同样沿用 43m', p3.json.scheduledTasks.find((t) => t.role === 'dispatch').everyMinutes, 43);
  eq('L2→L3 新增调度与大巡检（日报未启用）', p3.json.addedScheduledTasks.map((t) => t.role), ['dispatch', 'lead-patrol']);
  const legacyDaily = { ...readJson(runPath), req: 'upgrade-daily', pendingUpgrade: null };
  legacyDaily.notify = { ...legacyDaily.notify, dailyReportEnabled: true, dailyReportTime: '11:30' };
  const legacyId = 'liteloop-upgrade-daily-legacy-lead-daily';
  legacyDaily.scheduledTasks = [{ id: legacyId, role: 'lead-daily', schedule: 'daily', at: '11:30' }];
  write(path.join(configDir, 'runs', 'upgrade-daily.json'), JSON.stringify(legacyDaily));
  const dailyUpgrade = loopctl(['upgrade', '--req', 'upgrade-daily', '--to', 'L3'], configDir);
  eq('带历史日报任务的升档计划只停旧任务，日报交给已有大巡检角色', [
    dailyUpgrade.json.forgeObjects.filter((item) => item.kind === 'scheduled-task' && item.action === 'stop').map((item) => item.task.id),
    dailyUpgrade.json.scheduledTasks.map((task) => task.role),
  ], [[legacyId], ['controller', 'patrol', 'dispatch', 'lead-patrol']]);
  ok('升档的四个角色使用同一套 tick 起手式，继续保留计划交接提示',
    dailyUpgrade.json.scheduledTasks.every((task) => task.description.startsWith('先跑 ') && task.description.includes(`--role ${task.role} --apply`))
    && plan.json.notes.some((note) => note.includes('计划交接换新主控')));
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
  const sha = 'a'.repeat(40);
  const runPath = path.join(tmp, 'merge-run.json');
  const repo = 'acme/core-svc';
  const at = '2024-05-01T04:00:00Z';
  const confirmedRun = { req: 'merge-run', autoMerge: true, forge: 'github', repos: [{ name: 'core-svc', repo }],
    baselineBranch: 'feat/export', protectedEnvBranches: ['preprod'], issues: { main: 7 } };
  const ghState = (extra = {}) => ({
    issues: { [repo + '#7']: { state: 'OPEN', labels: [], updatedAt: at } },
    prs: {
      'acme/core-svc#22': { baseRefName: 'feat/export', headRefOid: 'abc', body: '实现导出\nDepends-On: acme/core-svc#21', state: 'OPEN' },
      'acme/core-svc#21': { state: 'OPEN' },
      'acme/core-svc#23': { baseRefName: 'main', headRefOid: 'abc', body: '', state: 'OPEN' },
      'acme/core-svc#24': { baseRefName: 'feat/export', headRefOid: 'abc', body: 'Depends-On: 某个前置', state: 'OPEN' },
    },
    ...extra,
  });
  const authorize = (id, run = confirmedRun, platform = 'github') => {
    const state = readJson(fake.env.FAKE_FORGE_STATE);
    const pr = platform === 'github' ? state.prs[repo + '#' + id] : state.mrs[repo + '!' + id];
    const identity = platform === 'github' ? { headRefOid: sha, headRefName: 'dev/export' } : { sha, source_branch: 'dev/export' };
    const bodyField = platform === 'github' ? 'body' : 'description';
    Object.assign(pr, { ...identity, labels: ['待合并', '需求:merge-run'], updatedAt: at, updated_at: at });
    pr[bodyField] = '关联 #7\n' + pr[bodyField];
    write(runPath, JSON.stringify(run));
    fake.reset(seedReviews(runPath, state, [{ repo, id, session: 'authorized-review', waiting: true, platform,
      headSha: sha, conclusion: '通过', at, commentId: 1 }]));
  };
  const mergeArgs = ['change-merge', '--forge', 'github', '--repo', repo, '--target', 'feat/export', '--head-sha', sha];
  const realMerge = (id, more = []) => {
    authorize(id);
    return forge([...mergeArgs, '--run', runPath, '--id', String(id), ...more], fake.env);
  };
  const mergeCalls = () => fake.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');

  fake.reset(ghState());
  const noRun = forge([...mergeArgs, '--id', '22'], fake.env);
  eq('R22 无运行态仅预览，不读取或修改 Forge', [noRun.code, noRun.json.dryRun, fake.calls().length], [0, true, 0]);
  const lying = realMerge(22, ['--depends-on', '[{"repo":"acme/core-svc","id":21,"state":"merged"}]']);
  eq('调用方谎报 merged 仍向 Forge 实查并拒绝', [lying.code, lying.json.code, lying.json.blocked?.[0]?.id], [2, 'DEPENDS_ON_UNMERGED', 21]);
  eq('依赖未合时绝不发出合并', mergeCalls().length, 0);
  fake.reset(ghState());
  const bodyDep = realMerge(22);
  eq('不传依赖也从正文读出 Depends-On 并拒绝', [bodyDep.json.code, bodyDep.json.blocked?.[0]?.source], ['DEPENDS_ON_UNMERGED', 'body']);
  fake.reset(ghState());
  const shaMoved = realMerge(22, ['--head-sha', 'b'.repeat(40)]);
  eq('真实 head 已变 → HEAD_SHA_MISMATCH', [shaMoved.code, shaMoved.json.code, mergeCalls().length], [2, 'HEAD_SHA_MISMATCH', 0]);
  const targetDiff = realMerge(22, ['--target', 'feat/other']);
  eq('指定目标与运行态基线不一致', targetDiff.json.code, 'TARGET_NOT_BASELINE');
  const liveMain = realMerge(23);
  eq('读回真实目标为 main → ENV_BRANCH_FORBIDDEN', [liveMain.json.code, mergeCalls().length], ['ENV_BRANCH_FORBIDDEN', 0]);
  const badBody = realMerge(24);
  eq('正文 Depends-On 格式非法 → 拒绝', [badBody.code, badBody.json.code, badBody.json.invalid], [2, 'DEPENDS_ON_INVALID', ['某个前置']]);
  for (const [name, reference, nested] of [['自依赖', '#22', ''], ['循环依赖', '#21', 'Depends-On: #22']]) {
    const state = ghState();
    state.prs[repo + '#22'].body = 'Depends-On: ' + reference;
    state.prs[repo + '#21'].body = nested;
    fake.reset(state);
    const result = realMerge(22);
    eq(`R6/06 ${name}转人工，停止自动重试`, [result.json.state, result.json.code, mergeCalls().length], ['manual', 'DEPENDS_ON_CYCLE', 0]);
  }
  const closedDependency = ghState();
  closedDependency.prs[repo + '#21'].state = 'CLOSED';
  fake.reset(closedDependency);
  eq('R6/07 前置变更关闭后命令行重试转人工', [realMerge(22).json.state, mergeCalls().length], ['manual', 0]);
  fake.reset(ghState({ mergeSucceeds: false, prs: { ...ghState().prs, 'acme/core-svc#21': { state: 'MERGED' } } }));
  const notConfirmed = realMerge(22);
  eq('合并后读回未合入不报成功', [notConfirmed.code, notConfirmed.json.code], [2, 'MERGE_NOT_CONFIRMED']);
  fake.reset(ghState({ prs: { ...ghState().prs, 'acme/core-svc#21': { state: 'MERGED' } } }));
  const merged = realMerge(22, ['--head-sha', sha.toUpperCase()]);
  eq('依赖实查全合入后合并并读回成功', [merged.code, merged.json.merged, merged.json.dependencies[0].state], [0, true, 'MERGED']);
  eq('R6/07 大写 SHA 归一化，合入后清除待合并并写审计', [
    mergeCalls()[0]?.args.slice(-2), workflowLabels(readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#22']),
    readJson(fake.env.FAKE_FORGE_STATE).comments[`repos/${repo}/issues/22/comments`][0].at(-1).body.includes('自动合并'),
  ], [['--match-head-commit', sha], ['风险低'], true]);

  const bodyState = (body, dependencyState = 'MERGED') => {
    const state = ghState();
    state.prs['acme/core-svc#22'].body = body;
    state.prs['acme/core-svc#21'].state = dependencyState;
    return state;
  };
  const localUrl = 'https://github.com/acme/core-svc/pull/21';
  const dependencyReads = () => fake.calls().filter(({ args }) => args[0] === 'pr' && args[1] === 'view' && args[2] === '21').length;
  const crossHost = 'https://github.other.example.test/acme/core-svc/pull/21';
  const otherForge = 'https://github.com/acme/core-svc/-/merge_requests/21';
  for (const reference of [crossHost, otherForge]) {
    fake.reset(bodyState(`- Depends-On: acme/core-svc#21\n* Depends-On: ${reference}`));
    const foreign = realMerge(22);
    eq(`依赖 ${reference} 跨实例或 Forge 时不读取前置变更单`, [foreign.code, foreign.json.code, dependencyReads()],
      [2, 'DEPENDS_ON_CROSS_INSTANCE', 0]);
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
  eq('URL 编号后跟非法字符不能被部分匹配', [malformed.code, malformed.json.code, dependencyReads()], [2, 'DEPENDS_ON_INVALID', 0]);
  fake.reset(bodyState(''));
  const crossCaller = realMerge(22, ['--depends-on', JSON.stringify([{ repo: 'acme/core-svc', id: 21, forge: 'github', host: 'github.other.example.test', state: 'merged' }])]);
  eq('结构化调用方依赖也校验完整主机身份', [crossCaller.code, crossCaller.json.code, dependencyReads()], [2, 'DEPENDS_ON_CROSS_INSTANCE', 0]);

  fs.rmSync(runPath.replace(/\.json$/, '.reviews.jsonl'));
  const runArgs = ['change-merge', '--forge', 'github', '--id', '22', '--head-sha', 'a'.repeat(40), '--run', runPath];
  write(runPath, JSON.stringify(confirmedRun));
  fake.reset(bodyState(''));
  const disallowedRepo = forge([...runArgs, '--repo', 'acme/other', '--target', 'feat/export'], fake.env);
  const wrongTarget = forge([...runArgs, '--repo', 'acme/core-svc', '--target', 'feat/unconfirmed'], fake.env);
  eq('Forge 执行入口根据 run 拒绝仓和基线越界', [
    disallowedRepo.code, disallowedRepo.json.code, wrongTarget.code, wrongTarget.json.code, fake.calls().length,
  ], [2, 'REPO_NOT_IN_RUN', 2, 'TARGET_NOT_BASELINE', 0]);
  const aliasState = { ...bodyState('关联 #7'), issues: { 'acme/core-svc#7': { state: 'OPEN', labels: [], updatedAt: '2024-05-01T04:00:00Z' } } };
  Object.assign(aliasState.prs['acme/core-svc#22'], { headRefOid: 'a'.repeat(40), headRefName: 'dev/export', labels: ['待合并', '需求:merge-run'], updatedAt: '2024-05-01T04:00:00Z' });
  fake.reset(seedReviews(runPath, aliasState, [{ repo: 'acme/core-svc', id: 22, session: 'alias-review', waiting: true,
    headSha: 'a'.repeat(40), conclusion: '通过', at: '2024-05-01T04:00:00Z', commentId: 1 }]));
  const selectedAlias = forge([...runArgs, '--repo', 'core-svc', '--target', 'feat/export'], fake.env);
  eq('Forge 接受选中仓的精确别名并在对应仓实查和合并', [selectedAlias.code, selectedAlias.json.merged, selectedAlias.json.repo],
    [0, true, 'acme/core-svc']);
  write(runPath, JSON.stringify({ ...confirmedRun, baselineBranch: 'preprod' }));
  fake.reset(bodyState(''));
  const protectedByRun = forge([...runArgs, '--repo', 'acme/core-svc', '--target', 'preprod'], fake.env);
  eq('只传 run 也能保护自定义环境分支，无任何 Forge 调用', [protectedByRun.code, protectedByRun.json.code, fake.calls().length],
    [2, 'ENV_BRANCH_FORBIDDEN', 0]);

  const glabDeps = (host, hostFlags = [], env = {}) => {
    const runHost = hostFlags[1] ?? env.GITLAB_HOST;
    fake.reset({
      issues: { [repo + '#7']: { state: 'opened', labels: [], updated_at: at } },
      mrs: {
        [repo + '!9']: { target_branch: 'feat/x', description: host ? `1. Depends-On: https://${host}/acme/infra/lib/-/merge_requests/7` : '', state: 'opened' },
        'acme/infra/lib!7': { state: 'merged' },
      },
    });
    authorize(9, { ...confirmedRun, forge: 'gitlab', gitlabHost: runHost, baselineBranch: 'feat/x' }, 'gitlab');
    return forge(['change-merge', '--forge', 'gitlab', '--repo', repo, '--id', '9', '--head-sha', sha, '--target', 'feat/x',
      '--run', runPath, ...hostFlags], { ...fake.env, ...env });
  };
  const glabMerge = glabDeps(null, ['--hostname', 'gitlab.acme.test']);
  eq('GitLab 真实合并读回成功', [glabMerge.code, glabMerge.json.merged], [0, true]);
  ok('每条 glab 调用都带 --hostname', fake.calls().length >= 3 && fake.calls().every((c) => c.args[1] === '--hostname' && c.args[2] === 'gitlab.acme.test'));
  eq('GitLab 合并请求体带 sha', JSON.parse(fake.calls().find((c) => c.args.some((a) => a.endsWith('/merge'))).stdin).sha, sha);
  const foreignGlab = glabDeps('gitlab.other.example.test', ['--hostname', 'gitlab.acme.test']);
  eq('GitLab 跨主机依赖不查询当前实例同名依赖', [
    foreignGlab.code, foreignGlab.json.code, fake.calls().some(({ args }) => args.some((arg) => arg.includes('infra'))),
  ], [2, 'DEPENDS_ON_CROSS_INSTANCE', false]);
  const envGlab = glabDeps('gitlab.env.test', [], { GITLAB_HOST: 'gitlab.env.test' });
  eq('GitLab 实例由 GITLAB_HOST 确认后，同实例多级路径可合', [envGlab.code, envGlab.json.dependencies[0]?.repo], [0, 'acme/infra/lib']);
  const defaultGlab = glabDeps('gitlab.com');
  eq('GitLab 未配置时只核验默认实例', [defaultGlab.code, defaultGlab.json.dependencies[0]?.host], [0, 'gitlab.com']);
  write(runPath, JSON.stringify({ req: 'merge-run', autoMerge: true, forge: 'gitlab', repos: [{ repo: 123 }], baselineBranch: 'feat/x', issues: { main: 7 } }));
  fake.reset(seedReviews(runPath, { issues: { '123#7': { state: 'opened', labels: [], updated_at: '2024-05-01T04:00:00Z' } },
    mrs: { '123!9': { target_branch: 'feat/x', sha: 'a'.repeat(40), description: '关联 #7', state: 'opened', labels: ['待合并', '需求:merge-run'], source_branch: 'dev/x', updated_at: '2024-05-01T04:00:00Z' } } },
  [{ repo: '123', id: 9, session: 'gitlab-review', waiting: true, platform: 'gitlab', headSha: 'a'.repeat(40), conclusion: '通过',
    at: '2024-05-01T04:00:00Z', commentId: 1 }]));
  const numericGitlab = forge(['change-merge', '--forge', 'gitlab', '--repo', '123', '--id', '9', '--head-sha', 'a'.repeat(40), '--target', 'feat/x', '--run', runPath], fake.env);
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
  const cold = loopctl(['status', '--json'], emptyCfg);
  eq('空目录冷启动触发 onboarding 且不建目录', [cold.code, cold.json.readOnly, cold.json.needsOnboarding, cold.json.onboardingQuestions.length, fs.existsSync(emptyCfg)], [0, true, true, 4, false]);

  fs.mkdirSync(tmp, { recursive: true });
  const repoDir = path.join(tmp, 'repo');
  git(['init', '-q', '-b', 'main', repoDir], tmp);
  const cfgDir = setupConfig(tmp, { 'demo.yaml': simpleProject({ forge: 'github', tier: 'L1', name: 'demo', repo: 'acme/demo', repoPath: repoDir }) });
  const idle = loopctl(['status', '--json'], cfgDir);
  eq('已配置无活动需求时 needsOnboarding=false', [idle.code, idle.json.needsOnboarding, idle.json.activeRuns.length, idle.json.projects], [0, false, 0, ['demo']]);

  loopctl(['init', '--req', 'guide-demo', '--project', 'demo', '--issue-map', '{"tracking":"#10"}'], cfgDir);
  const active = loopctl(['status', '--json', '--req', 'guide-demo'], cfgDir);
  eq('活动 L1 需求返回阶段与只读态', [active.code, active.json.state, active.json.run.tier, active.json.run.baselineBranch], [0, 'active', 'L1', 'loop/guide-demo']);
  includes('活动 L1 下一步提示包含升档指引', active.json.run.nextPrompt, '从 L1 升档到 L2');

  loopctl(['upgrade', '--req', 'guide-demo', '--to', 'L2'], cfgDir);
  const upgrading = loopctl(['status', '--json', '--req', 'guide-demo'], cfgDir);
  eq('半程升档暴露 pendingUpgrade', [upgrading.code, upgrading.json.run.pendingUpgrade.from, upgrading.json.run.pendingUpgrade.to], [0, 'L1', 'L2']);
  includes('半程升档提示先 --apply 落盘', upgrading.json.run.nextAction, '--apply');

  const teardownForge = makeFakeForge(path.join(tmp, 'teardown-forge'));
  teardownForge.reset({ issues: { 'acme/demo#10': { state: 'CLOSED', labels: [], updatedAt: '2024-05-01T04:00:00Z' } } });
  loopctl(['teardown', '--req', 'guide-demo'], cfgDir, teardownForge.env);
  const tearing = loopctl(['status', '--json'], cfgDir);
  eq('半程拆架在列表态暴露 pendingTeardown', [tearing.code, tearing.json.activeRuns.length, tearing.json.activeRuns[0].pendingTeardown.phase], [0, 1, 'planned']);
  loopctl(['teardown', '--req', 'guide-demo', '--finalize', '--results', '{}'], cfgDir, teardownForge.env);
  const archived = loopctl(['status', '--json', '--req', 'guide-demo'], cfgDir);
  eq('归档后 status 返回 archived 状态', [archived.code, archived.json.state, archived.json.zeroResidue], [0, 'archived', true]);

  const extCfg = loopctl(['config-resolve', '--project', 'demo', '--overrides', JSON.stringify({
    notify: { externalNotifyDisabled: true, externalContacts: { appClient: 'ou_ext_app' } },
  })], cfgDir);
  eq('config-resolve 透传 externalNotifyDisabled 与 externalContacts', [extCfg.code, extCfg.json.notify.externalNotifyDisabled, extCfg.json.notify.externalContacts.appClient], [0, true, 'ou_ext_app']);
}

function scenarioHumanStatus(tmp) {
  group('人话状态视图');
  const config = path.join(tmp, 'config');
  const fake = makeFakeForge(path.join(tmp, 'forge'));
  const req = 'member-discount';
  const repo = 'acme/shop';
  const hostname = 'git.example.test';
  const baselineBranch = `loop/${req}`;
  const at = '2024-05-01T17:25:00Z';
  const run = {
    req, title: '会员券抵扣', tier: 'L2', autoMerge: true, user: 'dev-a', forge: 'github', hostname, baselineBranch,
    hubRepo: { repo }, repos: [{ repo, branch: 'main' }], issues: { main: 7 },
    demandIssues: [11, 12].map((id) => ({ repo, id })), changes: [21, 22].map((id) => ({ repo, id })),
  };
  const issue = (body, state = 'OPEN') => ({ body, state, updatedAt: at, labels: [] });
  const change = { state: 'OPEN', headRefOid: 'a'.repeat(40), baseRefName: baselineBranch, headRefName: 'dev/coupon', updatedAt: at, labels: [`需求:${req}`] };
  const state = {
    issues: {
      [repo + '#7']: issue('## 1. 基本信息\n当前步骤：核对会员券抵扣显示\n## 2. 需本人处理\n- [待确认] 退款时是否退回会员券'),
      [repo + '#11']: issue('会员券抵扣', 'CLOSED'),
      [repo + '#12']: issue('退款时退回会员券'),
    },
    prs: { [repo + '#21']: { ...change, state: 'MERGED' }, [repo + '#22']: change },
    comments: { [`repos/${repo}/issues/7/comments`]: [[{
      id: 456, body: '巡检脚本 ｜ 主研发 ｜ CONFIRM_TIMEOUT\n【提醒】事项等待你确认已超时。', created_at: at,
    }]] },
  };
  write(path.join(config, 'runs', `${req}.json`), JSON.stringify(run));
  const wakes = Array.from({ length: 6 }, (_, i) => ({
    at: `2024-05-01T16:0${i}:00Z`, role: 'controller', apply: true, result: i === 5 ? 'actions' : 'quiet',
    actions: i === 5 ? [{ kind: 'controller', code: 'UNREPLIED_COMMENT', refs: [{ repo, id: 7, commentId: 456 }, { repo, id: 7 }] }] : [],
  }));
  wakes.push({ at, role: 'patrol', apply: true, result: 'actions',
    actions: [{ kind: 'comment-posted', code: 'CONFIRM_TIMEOUT', refs: [{ repo, id: 7, kind: 'issue', commentId: 456 }] }] });
  write(path.join(config, 'runs', `${req}.ticks.jsonl`), wakes.map((row) => JSON.stringify(row)).join('\n') + '\n');
  fake.reset(state);
  const env = { ...fake.env, TZ: 'Asia/Shanghai' };
  const human = loopctl(['status', '--req', req], config, env);
  const [header, progress, waiting, wakeList, comments] = human.stdout.trim().split('\n\n');
  eq('默认 status 的五段正文包含实况、待办和评论直达链接', [human.code, header, progress, waiting, comments], [
    0, '需求 会员券抵扣 ｜ 档位 L2 ｜ 需求基线 loop/member-discount\n合并方式：自动合并低风险变更',
    `进度\n子任务已完成 1/2，变更已合入 1/2  https://${hostname}/${repo}/issues/7`,
    `等你处理\n请确认退款时是否退回会员券。 https://${hostname}/${repo}/issues/7`,
    `巡检脚本最近写过的评论\n2024-05-02 01:25 https://${hostname}/${repo}/issues/7#issuecomment-456`,
  ]);
  ok('最多保留五次主控唤醒，连续安静合并成一行，按本地日期和登记表短句显示', wakeList?.includes('2024-05-02 00:05 有 2 条评论等主控回复')
    && wakeList.includes('2024-05-02 00:01–00:04 安静 4 次') && !wakeList.includes('00:00')
    && !wakeList.includes('UNREPLIED_COMMENT'));
  const machine = loopctl(['status', '--json', '--req', req], config, env);
  eq('旧机器结构继续区分本机数据和显式实时读取', [machine.json.live, machine.json.run.recentTicks.controller.length], [undefined, 5]);
  fake.reset({ ...state, failView: { 22: 'HTTP 502 upstream unavailable' } });
  const incomplete = loopctl(['status', '--req', req], config, env);
  ok('读取失败时保留已知待办且不把部分数据当完整进度', incomplete.stdout.includes('有 1 项读取失败')
    && incomplete.stdout.includes('还有待办未能核实') && incomplete.stdout.includes('请确认退款时是否退回会员券'));
  fake.reset(state);
  const setMode = (...flags) => loopctl(['merge-mode', '--req', req, ...flags], config, env);
  const modeLine = () => loopctl(['status', '--req', req], config, env).stdout.trim().split('\n\n')[0];
  const runFile = path.join(config, 'runs', req + '.json');
  const manual = setMode('--manual');
  const manualHeader = modeLine();
  if (process.env.LITELOOP_TEST_RECEIPTS === '1') console.log('STATUS BEFORE\n' + header + '\nSTATUS AFTER\n' + manualHeader);
  const manualAgain = setMode('--manual');
  const automatic = setMode('--auto');
  eq('运行中切换合并方式更新状态，重复相同配置只写一次', [
    manual.code, manualHeader, manualAgain.json.changed, automatic.code, modeLine(), readJson(runFile).autoMerge,
  ], [0, '需求 会员券抵扣 ｜ 档位 L2 ｜ 需求基线 loop/member-discount\n合并方式：全部人工合并', false, 0, header, true]);
  const commentsEndpoint = `repos/${repo}/issues/7/comments`;
  eq('运行中两次切换在本人台账留下可读的配置变更评论', readJson(fake.env.FAKE_FORGE_STATE).comments[commentsEndpoint][0]
    .slice(1).map(({ body }) => body.split('\n').slice(0, 2)), [
    ['巡检脚本 ｜ 主研发 ｜ MERGE_MODE_MANUAL', '【配置变更】合并方式已改为全部人工。'],
    ['巡检脚本 ｜ 主研发 ｜ MERGE_MODE_AUTO', '【配置变更】合并方式已改为低风险自动合并。'],
  ]);
  eq('合并方式参数只能二选一', [setMode().json.code, setMode('--auto', '--manual').json.code],
    ['INVALID_MERGE_MODE', 'INVALID_MERGE_MODE']);

  const l1Project = simpleProject({ forge: 'github', tier: 'L1', name: 'shop', repo, repoPath: tmp });
  write(path.join(config, 'projects', 'shop.yaml'), l1Project);
  const l1Req = 'single-pr';
  const l1Args = ['--req', l1Req, '--project', 'shop', '--issue-map', '{"tracking":"#7"}', '--overrides', '{"autoMerge":true}'];
  const l1Change = { ...change, labels: ['需求:single-pr'], baseRefName: 'loop/single-pr' };
  const l1Facts = { issues: state.issues, prs: { [repo + '#22']: l1Change } };
  fake.reset(l1Facts);
  const l1Preview = loopctl(['preview-init', ...l1Args], config, env);
  const l1Init = loopctl(['init', ...l1Args], config, env);
  const l1Mode = (...flags) => loopctl(['merge-mode', '--req', l1Req, ...flags], config, env);
  eq('R6/08 L1 只有一个 PR 时确认单、初始化和运行中均保持全人工', [
    l1Preview.json.autoMerge, l1Init.json.run.autoMerge, l1Mode('--auto').json.code,
  ], [false, false, 'L1_AUTO_MERGE_REQUIRES_MULTIPLE_CHANGES']);
  fake.reset({ ...l1Facts, prs: { ...l1Facts.prs, [repo + '#23']: { ...l1Change, state: 'MERGED' } } });
  eq('R6/08 L1 有两条变更且建立独立基线时两处均可开启', [
    loopctl(['preview-init', ...l1Args], config, env).json.autoMerge, l1Mode('--auto').json.autoMerge,
  ], [true, true]);
  const l3 = { ...run, tier: 'L3', issues: { master: 7, 'slot:主研发': 11, 'slot:A': 12 } };
  fake.reset({ issues: { ...state.issues, [repo + '#7']: issue('## 1. 整体状态\n合并方式：自动合并低风险变更'),
    [repo + '#11']: issue('主研发小台账') } });
  write(runFile, JSON.stringify({ ...l3, slot: 'A', autoMerge: false }));
  eq('R6/08 L3 协作者读取总台账合并方式，不能切换', [
    modeLine().split('\n')[1], setMode('--manual').json.code, setMode('--auto').json.code,
  ], ['合并方式：自动合并低风险变更', 'MERGE_ROLE_FORBIDDEN', 'MERGE_ROLE_FORBIDDEN']);
  write(runFile, JSON.stringify({ ...l3, slot: '主研发' }));
  eq('R6/08 主研发可以切换并同步总台账', setMode('--manual').json.autoMerge, false);
  write(runFile, JSON.stringify({ ...l3, slot: 'A' }));
  eq('R6/08 协作者看到主研发刚切换的合并方式', modeLine().split('\n')[1], '合并方式：全部人工合并');
  write(runFile, JSON.stringify(run));

  fake.reset({ ...state, issues: { ...state.issues, [repo + '#7']: {
    ...state.issues[repo + '#7'], labels: ['需求:' + req, '需求:another'],
  } } });
  eq('本人台账带冲突需求标签时拒绝切换且不写评论', [
    setMode('--manual').json.code, readJson(runFile).autoMerge, fake.calls().some(({ args }) => args.includes('POST')),
  ], ['DEMAND_LABEL_CONFLICT', true, false]);

  const issueState = (branch, extra = {}) => write(runFile, JSON.stringify({ ...run, autoMerge: false, baselineBranch: branch, ...extra }));
  for (const branch of ['main', 'uat/release', 'release/stable']) {
    issueState(branch, { protectedEnvBranches: ['uat/*'], repos: [{ repo, branch: 'release/stable' }] });
    fake.reset(state);
    eq(`受保护基线 ${branch} 拒绝自动合并，且不写台账`, [
      setMode('--auto').json.code, readJson(runFile).autoMerge, fake.calls().length,
    ], ['ENV_BRANCH_FORBIDDEN', false, 0]);
  }

  issueState(baselineBranch, { tier: 'L1', issues: { tracking: 7 }, changes: [{ repo, id: 21 }] });
  fake.reset({ ...state, prs: { [repo + '#21']: state.prs[repo + '#21'] } });
  eq('L1 只有一个变更单时不开启自动合并', setMode('--auto').json.code, 'L1_AUTO_MERGE_REQUIRES_MULTIPLE_CHANGES');
  fake.reset(state);
  eq('L1 已拆两个变更单且使用独立基线，可以开启自动合并', setMode('--auto').code, 0);

  issueState(baselineBranch, { tier: 'L3', slot: '主研发', issues: { master: 5, 'slot:主研发': 7 }, autoMerge: true });
  fake.reset({ ...state, issues: { ...state.issues, [repo + '#5']: issue('总台账') } });
  eq('L3 主研发切换写本人小台账和总台账，评论带槽位签名', [
    setMode('--manual').code, fake.calls().filter(({ args }) => args.includes('POST')).map(({ args, stdin }) =>
      [args.includes(commentsEndpoint), JSON.parse(stdin).body.split('\n')[0]]),
  ], [0, [[true, '巡检脚本 ｜ 主研发 ｜ MERGE_MODE_MANUAL'], [false, '巡检脚本 ｜ 主研发 ｜ MERGE_MODE_MANUAL']]]);
  return human.stdout;
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
      '  skipReason: fixture lineage test',
    ].join('\n'),
  });

  // 正则/通配精准命中 & 0 误杀
  const badPat = loopctl(['config-resolve', '--project', 'lin', '--overrides', JSON.stringify({ protectedEnvBranches: ['/(unclosed/'] })], cfgDir);
  eq('非法正则分支规则立即报错', [badPat.code, badPat.json.code], [2, 'INVALID_BRANCH_PATTERN']);

  const hitMonthly = loopctl(['preview-init', '--req', 'r1', '--project', 'lin', '--branch', 'feature_2610B_test'], cfgDir);
  includes('正则精准命中月度测试分支 feature_2610B_test 确认单改全人工', hitMonthly.json.confirmSheet[5], '全部人工合并');
  const noFalsePos = loopctl(['preview-init', '--req', 'r2', '--project', 'lin', '--branch', 'feature_2611B_ab_test'], cfgDir);
  includes('feature_2611B_ab_test 不误杀仍可低风险自动合', noFalsePos.json.confirmSheet[5], '自动合并低风险变更');

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
      'verification:',
      '  mode: local-test',
      '  skipReason: fixture multi-trunk test',
    ].join('\n'),
  });
  const mtInit = loopctl(['init', '--req', 'mt-req', '--project', 'mt', '--branch', 'loop/mt-req', '--issue-map', '{"master":"#300"}'], multiCfg);
  const mtRunPath = mtInit.json.runPath;
  const hubFromStable = forge(['change-create', '--forge', 'github', '--repo', 'acme/hub', '--source', 'release/stable', '--target', 'loop/mt-req', '--title', 'hub sync', '--run', mtRunPath, '--dry-run']);
  eq('核心仓自身主干 release/stable 允许同步建单', hubFromStable.code, 0);
  const webFromStable = forge(['change-create', '--forge', 'github', '--repo', 'acme/web', '--source', 'release/stable', '--target', 'loop/mt-req', '--title', 'bad web sync', '--run', mtRunPath, '--dry-run']);
  eq('关联仓不得串用核心仓主干豁免，release/stable 被硬拒', [webFromStable.code, webFromStable.json.code], [2, 'SOURCE_ENV_BRANCH_FORBIDDEN']);

  // change-create 双向校验：禁 test/feature_2610B_test 反向建单，放行 main 回合和向环境提测
  const createFromTest = forge(['change-create', '--forge', 'github', '--repo', 'acme/lin', '--source', 'feature_2610B_test', '--target', 'loop/lin-demo', '--title', 'bad', '--run', runPath, '--dry-run']);
  eq('change-create 硬拒月度测试分支反向建单', [createFromTest.code, createFromTest.json.code], [2, 'SOURCE_ENV_BRANCH_FORBIDDEN']);
  const createFromMain = forge(['change-create', '--forge', 'github', '--repo', 'acme/lin', '--source', 'main', '--target', 'loop/lin-demo', '--title', 'sync main', '--run', runPath, '--dry-run']);
  eq('change-create 放行生产主干 main 向需求基线同步建单', createFromMain.code, 0);
  const createToTest = forge(['change-create', '--forge', 'github', '--repo', 'acme/lin', '--source', 'loop/lin-demo', '--target', 'feature_2610B_test', '--title', 'deploy test', '--run', runPath, '--dry-run']);
  eq('change-create 放行需求基线向测试环境提测建单', createToTest.code, 0);

  // change-merge 真实 Git 血统白名单 + Issue 关联校验
  const fake = makeFakeForge(path.join(tmp, 'fake-lin'));
  const issue = { state: 'OPEN', labels: [], updatedAt: '2024-05-01T04:00:00Z' };
  const registered = { 'acme/lin#100': { ...issue, body: '关联 #13' }, 'acme/lin#13': issue };
  const mergeWithRun = (prId, sha, file = runPath, repo = 'acme/lin', req = 'lin-demo') => {
    const state = readJson(fake.env.FAKE_FORGE_STATE);
    const pr = state.prs[repo + '#' + prId];
    Object.assign(pr, { labels: ['待合并', '需求:' + req], updatedAt: issue.updatedAt });
    fake.reset(seedReviews(file, state, [{ repo, id: prId, session: 'lineage-review', headSha: sha,
      at: issue.updatedAt, conclusion: '通过', commentId: 1, waiting: true }]));
    return forge(['change-merge', '--forge', 'github', '--repo', repo, '--id', String(prId), '--head-sha', sha,
      '--target', pr.baseRefName, '--run', file], fake.env);
  };

  // A. 源分支为生产主干 main -> 拒绝 AI 自动合（须人手合）
  fake.reset({ prs: { 'acme/lin#51': { baseRefName: 'loop/lin-demo', headRefName: 'main', headRefOid: c0, body: 'Refs #13', state: 'OPEN' } } });
  const mMain = mergeWithRun(51, c0);
  eq('change-merge 生产主干源分支禁 AI 自动合', [mMain.code, mMain.json.code], [2, 'SOURCE_TRUNK_MANUAL_ONLY']);

  // B. 源分支命中非主干正则 feature_2610B_test -> 硬拒
  fake.reset({ prs: { 'acme/lin#52': { baseRefName: 'loop/lin-demo', headRefName: 'feature_2610B_test', headRefOid: testSha, body: 'Refs #13', state: 'OPEN' } } });
  const mMonthly = mergeWithRun(52, testSha);
  eq('change-merge 月度测试分支源分支硬拒', [mMonthly.code, mMonthly.json.code], [2, 'SOURCE_ENV_BRANCH_FORBIDDEN']);

  // C. 陌生旧分支（分叉点早于 baselineStartSha）-> SOURCE_LINEAGE_INVALID
  fake.reset({ issues: registered, prs: { 'acme/lin#53': { baseRefName: 'loop/lin-demo', headRefName: 'other/old-req', headRefOid: oldReqSha, body: 'Refs #13', state: 'OPEN' } } });
  const mOld = mergeWithRun(53, oldReqSha);
  eq('旧分叉陌生分支被 Git 血统拦截', [mOld.code, mOld.json.code], [2, 'SOURCE_LINEAGE_INVALID']);

  // D. 借壳污染分支（含 test 的 merge commit）-> SOURCE_CONTAINS_MERGE_COMMITS
  fake.reset({ issues: registered, prs: { 'acme/lin#54': { baseRefName: 'loop/lin-demo', headRefName: 'dev/polluted', headRefOid: pollutedSha, body: 'Refs #13', state: 'OPEN' } } });
  const mPolluted = mergeWithRun(54, pollutedSha);
  eq('混入 test 的借壳分支被 merge commit 拦截', [mPolluted.code, mPolluted.json.code], [2, 'SOURCE_CONTAINS_MERGE_COMMITS']);

  // E. 同 C0 线性分支但正文只写 Depends-On 未关联本需求 Issue -> MISSING_ISSUE_REF
  fake.reset({ prs: { 'acme/lin#55': { baseRefName: 'loop/lin-demo', headRefName: 'dev/clean', headRefOid: cleanSha, body: 'Depends-On: acme/lin#8', state: 'OPEN' } } });
  const mNoIssue = mergeWithRun(55, cleanSha);
  eq('仅写 Depends-On 未关联需求 Issue 拒绝自动合', [mNoIssue.code, mNoIssue.json.code], [2, 'MISSING_ISSUE_REF']);

  // E2. 正文引用了不在本次需求集合里的无关 Issue #999 -> ISSUE_REF_NOT_IN_RUN
  fake.reset({ issues: registered, prs: { 'acme/lin#57': { baseRefName: 'loop/lin-demo', headRefName: 'dev/clean', headRefOid: cleanSha, body: '关联 #999', state: 'OPEN' } } });
  const mWrongIssue = mergeWithRun(57, cleanSha);
  eq('无关 Issue 编号 #999 拒绝自动合', [mWrongIssue.code, mWrongIssue.json.code], [2, 'ISSUE_REF_NOT_IN_RUN']);

  // E3. 跨仓 PR 仅写裸 #300 未写核心仓全称 acme/hub#300 -> ISSUE_REF_WRONG_REPO
  fake.reset({ issues: { 'acme/hub#300': issue },
    prs: { 'acme/web#58': { baseRefName: 'loop/mt-req', headRefName: 'dev/web', headRefOid: cleanSha, body: '关联 #300', state: 'OPEN' } } });
  const mCrossRepoBare = mergeWithRun(58, cleanSha, mtRunPath, 'acme/web', 'mt-req');
  eq('跨仓 PR 裸写 #300 拒绝（须显式核心仓引用）', [mCrossRepoBare.code, mCrossRepoBare.json.code], [2, 'ISSUE_REF_WRONG_REPO']);

  fake.reset({ issues: registered, prs: { 'acme/lin#56': { baseRefName: 'loop/lin-demo',
    headRefName: 'dev/clean', headRefOid: cleanSha, body: '关联 #13', state: 'OPEN' } } });
  const mClean = mergeWithRun(56, cleanSha);
  eq('纯血需求分支 + 关联登记 Issue 四层门禁全部通过并合入', [mClean.code, mClean.json.merged, mClean.json.lineage.verified, mClean.json.lineage.mergeCommits], [0, true, true, 0]);
}

function scenarioRunFacts(tmp) {
  group('9. Forge 实况采集 + 台账和变更单评论回执');
  const fake = makeFakeForge(tmp);
  const repo = 'acme/core-svc';
  const updatedAt = '2024-05-01T03:00:00Z';
  const body = '## 1. 基本信息\n主控：第 2 任 ｜ live-owner ｜ local\n本轮：执行中（开始 05-01 10:00）\n当前 Issue：#8\n';
  const comment = (id, text, createdAt = updatedAt) => ({
    id, body: text, created_at: createdAt, user: { login: 'dev-a' }, author: { username: 'dev-a' },
  });
  const reply = (platform, kind, to, more = []) => forge(
    ['reply', '--forge', platform, '--repo', repo, '--id', '7', ...(kind ? ['--kind', kind] : []), '--reply-to', to, '--body', '主控 ｜ A ｜ live-owner\n已执行', ...more],
    fake.env,
  );
  const run = {
    req: 'facts-demo', tier: 'L2', forge: 'github', hubRepo: { repo }, repos: [{ repo, branch: 'main' }], baselineBranch: 'loop/facts-demo',
    ledgers: [{ key: 'main', issue: { id: '#7' }, body: '过期本地正文' }],
    changes: [{ repo, id: 10, state: 'closed', labels: ['过期标签'] }],
    controller: { sessionId: 'stale-owner' },
  };
  const ghIssueEndpoint = 'repos/acme/core-svc/issues/7/comments';
  const ghChangeEndpoint = 'repos/acme/core-svc/issues/9/comments';
  const ghPull = { state: 'MERGED', labels: [{ name: '待合并' }, { name: '需求:facts-demo' }], headRefOid: 'abc', headRefName: 'dev/facts', baseRefName: 'loop/facts-demo', updatedAt, body: '实现功能\nDepends-On: #6, #6' };
  fake.reset({
    issues: { [repo + '#7']: { state: 'OPEN', updatedAt, labels: [], body }, [repo + '#8']: { state: 'CLOSED', updatedAt, labels: [{ name: 'bug' }, { name: '需求:facts-demo' }], assignees: [{ login: 'dev-b' }] } },
    prs: { [repo + '#10']: ghPull, [repo + '#9']: { ...ghPull, state: 'OPEN', labels: ['需求:facts-demo'] }, [repo + '#12']: { ...ghPull, labels: [], body: '台账 acme/core-svc#7' } },
    comments: {
      [ghIssueEndpoint]: [[
        comment(10, '主控 ｜ A ｜ live-owner\n【纠偏】检查\n<!-- liteloop:key=correction:7 -->'),
        comment(11, '【提醒】检查第二项'),
        comment(15, '已执行'), comment(16, '已执行 [原评论](https://github.com/acme/core-svc/issues/7#issuecomment-10)'),
        comment(17, '<!-- liteloop:reply-to=11 -->', '2024-05-01T02:00:00Z'),
        comment(18, 'https://github.com/acme/core-svc/issues/7#issuecomment-110'),
      ]],
      [ghChangeEndpoint]: [[comment(42, '【设计变更】PR 走独立评论流')]],
    },
  });
  for (const gitlabHost of [null, 'null']) {
    const callsBefore = fake.calls().length;
    const plain = collectFacts({ ...run, gitlabHost }, fake.env);
    eq(`GitHub 主机缺省值 ${JSON.stringify(gitlabHost)} 不注入 gh 子进程`,
      [plain.errors.length, [...new Set(fake.calls().slice(callsBefore).map((call) => call.ghHost))]], [0, [null]]);
  }
  const gh = collectFacts(run, fake.env);
  eq('采集头部标明需求、档位和 ISO 时间', [gh.req, gh.tier, new Date(gh.collectedAt).toISOString()], [run.req, run.tier, gh.collectedAt]);
  eq('GitHub 实查成功无 errors', gh.errors, []);
  const { comments: ghNotes, currentIssues, changeRefs, title: ledgerTitle, ...ghLedger } = gh.ledgers[0];
  eq('GitHub 台账正文、状态、主控、轮次及开始时间来自 Forge', ghLedger, {
    key: 'main', repo, id: 7, state: 'open', body, updatedAt, owner: { sessionId: 'live-owner', generation: 2 },
    round: '执行中', roundStartedAt: '05-01 10:00',
  });
  eq('已执行首行直达链接才算回复，时间未到、只贴链接或编号前缀均不算',
    ghNotes.map((n) => [n.id, n.replied]), [[17, false], [10, true], [11, false], [15, false], [16, false], [18, false]]);
  eq('评论保留正文、作者、时间、前缀和去重键', ghNotes[1], {
    id: 10, author: 'dev-a', createdAt: updatedAt, body: '主控 ｜ A ｜ live-owner\n【纠偏】检查\n<!-- liteloop:key=correction:7 -->',
    prefix: '纠偏', liteloopKey: 'correction:7', replied: true,
  });
  eq('格式化台账引用可用于角色范围判定', [currentIssues, changeRefs], [[{ repo, id: '8', explicitRepo: false }], []]);
  eq('GitHub 子 Issue 由需求成员标签实查，保留经办人和标签', gh.subIssues.map(({ body: b, createdAt, comments, title, url, ...entry }) => entry),
    [{ repo, id: 8, state: 'closed', labels: ['bug', '需求:facts-demo'], assignee: 'dev-b', updatedAt }]);
  const { comments: _, author, body: changeBody, mergedBy, createdAt, mergedAt, draft, url, title, mergeSha, issueRefs, conflict, ...ghPr } = gh.changes.find(({id}) => id === 10);
  eq('PR 状态、标签、head、源目标及去重后的依赖来自 Forge', ghPr, {
    repo, id: 10, state: 'merged', labels: ['待合并', '需求:facts-demo'], headSha: 'abc', source: 'dev/facts', target: 'loop/facts-demo', updatedAt,
    dependsOn: [{ forge: 'github', host: null, repo, id: 6 }],
  });
  eq('GitHub 需求成员标签发现未登记 PR 并读取评论', gh.changes.filter((change) => change.target === run.baselineBranch).sort((a, b) => b.id - a.id).map((c) => [c.id, c.comments.length]), [[10, 0], [9, 1]]);
  eq('GitHub 不会以基线或正文提及发现其他需求的 PR', gh.changes.map((c) => c.id).sort((a, b) => a - b), [9, 10]);
  eq('供判定使用的 PR 正文、身份、时间、草稿和合入元数据保留来源',
    [changeBody, author, mergedBy, createdAt, mergedAt, draft, url, title, mergeSha, issueRefs, conflict],
    [ghPull.body, null, null, null, null, false, null, null, null, [], false]);
  eq('reply 缺 kind、错误 kind 和非法评论 ID 均拒绝', [
    reply('github', null, '10').json.code, reply('github', 'mr', '10').json.code, reply('github', 'issue', 'x').json.code,
  ], ['MISSING_FLAG', 'INVALID_REPLY_KIND', 'INVALID_REPLY_ID']);
  eq('GitHub Issue 与 PR 回执都走同一个评论 endpoint', ['issue', 'change'].map((kind) => {
    const result = reply('github', kind, '11', ['--dry-run']);
    return [result.code, result.json.args, JSON.parse(result.json.stdin).body.split('\n').at(-1)];
  }), Array.from({ length: 2 }, () => [0, ['api', '--method', 'POST', ghIssueEndpoint, '--input', '-'], '<!-- liteloop:reply-to=11 -->']));
  eq('GitHub 正式回复写入签名、回执和标记', reply('github', 'issue', '11').json.json.body, '主控 ｜ A ｜ live-owner\n已执行\n\n<!-- liteloop:reply-to=11 -->');
  eq('GitHub 写入后按原 ID 读回已回复', collectFacts(run, fake.env).ledgers[0].comments.find((n) => n.id === 11).replied, true);

  fake.reset({
    issues: { [repo + '#7']: { state: 'OPEN', labels: [], updatedAt, body: '## 1. 基本信息' } },
    comments: { [ghIssueEndpoint]: [[
      comment(10, '【纠偏】假回执'), comment(11, '【纠偏】真回执'), comment(12, '【纠偏】他仓链接'),
      comment(13, '【提醒】请处理 https://github.com/acme/core-svc/issues/7#issuecomment-10'),
      comment(14, '主控 ｜ A ｜ live-owner\n已执行｜原评论 https://github.com/acme/core-svc/issues/7#issuecomment-11｜处理完成'),
      comment(15, '不执行：https://github.example.test/acme/core-svc/issues/7#issuecomment-12！'),
      comment(16, '不执行：https://github.com/acme/other/issues/7#issuecomment-12？'),
      comment(17, '不执行：https://github.com/acme/core-svc/issues/77#issuecomment-12|'),
      comment(18, '不执行：https://github.com/acme/core-svc/pull/7#issuecomment-12：'),
    ]] },
  });
  eq('提醒引用、异实例、异仓、异对象和异类型链接均不回执，竖线分隔的真回复有效',
    collectFacts({ ...run, changes: [] }, fake.env).ledgers[0].comments.slice(0, 3).map((note) => note.replied),
    [false, true, false]);

  const glIssueEndpoint = 'projects/acme%2Fcore-svc/issues/7/notes';
  const glChangeEndpoint = 'projects/acme%2Fcore-svc/merge_requests/7/notes';
  const glMr = { state: 'opened', labels: ['待终审', '需求:facts-demo'], sha: 'def', source_branch: 'dev/gl', target_branch: 'loop/facts-demo', updated_at: updatedAt, description: '实现功能' };
  const glState = {
    issues: {
      [repo + '#6']: { state: 'opened', updated_at: updatedAt, labels: [], description: '## 3. 各开发者\n| A | dev-a | 测试 | 无 | [小台账](https://gitlab.acme.test/acme/core-svc/-/issues/7) |\n' },
      [repo + '#7']: { state: 'opened', updated_at: updatedAt, title: '【小台账】A-dev-a',
        labels: ['需求:facts-demo', '槽位A'], description: body.replace('本轮：执行中（开始 05-01 10:00）', '状态：暂停（原：进行中）') },
      [repo + '#8']: { state: 'opened', updated_at: updatedAt, labels: [], assignees: [{ username: 'dev-b' }] },
    },
    mrs: { [repo + '!7']: glMr },
    comments: {
      [glIssueEndpoint]: [[comment(22, '【提醒】台账'), comment(23, '已执行 [原评论](https://gitlab.acme.test/acme/core-svc/-/issues/7#note_22)')]],
      [glChangeEndpoint]: [
        [comment(20, '【配置变更】同号 MR'), ...Array.from({ length: 99 }, (_, i) => comment(100 + i, '历史记录'))],
        [comment(200, '已执行\n<!-- liteloop:reply-to=20 -->'), comment(201, '【纠偏】待回执')],
      ],
    },
  };
  const glRun = { ...run, forge: 'gitlab', gitlabHost: 'gitlab.acme.test', changes: [{ repo, id: 7 }] };
  fake.reset(glState);
  const gl = collectFacts(glRun, fake.env);
  eq('GitLab 实查成功无 errors', gl.errors, []);
  eq('GitLab 台账直接链接关联且暂停来自正文', [gl.ledgers[0].round, gl.ledgers[0].roundStartedAt, gl.ledgers[0].comments[0].replied], ['暂停', null, true]);
  eq('GitLab 同号 MR 独立分页，跨页回复正确关联', [gl.changes[0].comments.length, gl.changes[0].comments[0].replied, gl.changes[0].comments.at(-1).replied], [102, true, false]);
  eq('GitLab 带定制 host 读取 MR 的第二页评论', fake.calls().find((c) => c.args.at(-1) === glChangeEndpoint + '?per_page=100&page=2')?.args.slice(0, 5),
    ['api', '--hostname', 'gitlab.acme.test', '--method', 'GET']);
  const posted = reply('gitlab', 'change', '201', ['--hostname', 'gitlab.acme.test']);
  eq('GitLab MR 实写到 merge_requests notes', [posted.code, posted.json.args[5], posted.json.json.body.split('\n').at(-1)], [0, glChangeEndpoint, '<!-- liteloop:reply-to=201 -->']);
  eq('GitLab Issue 回执走 issues notes', reply('gitlab', 'issue', '22', ['--dry-run']).json.args[3], glIssueEndpoint);
  const glReadback = collectFacts(glRun, fake.env);
  eq('GitLab 写入同号 MR 仅影响 MR 评论流', [glReadback.changes[0].comments.find((n) => n.id === 201).replied, glReadback.ledgers[0].comments.length], [true, 2]);
  fake.reset(withSlotBindings(glState, 'projects/acme%2Fcore-svc/issues/6/notes', slotBinding(8001, 'A', 'dev-a', 'live-owner')));
  const squad = collectFacts({ ...glRun, tier: 'L3', ledgers: [], issues: { master: '#6' } }, fake.env);
  eq('L3 从 Forge 成员标签发现另一台机器的小台账', squad.ledgers.map((l) => [l.key, l.id, l.comments.length]), [['master', 6, 1], ['slot:A', 7, 2]]);

  fake.reset({
    ...glState, issues: { ...glState.issues, [repo + '#8']: { state: 'opened', labels: [], updated_at: updatedAt } },
    failApi: [glChangeEndpoint + '?per_page=100&page=2'],
  });
  const failure = collectFacts({ ...glRun, issues: { subIssues: [8, 81] } }, fake.env);
  eq('分页读取失败不返回空或部分评论的 MR；其他对象继续采集', [failure.changes.length, failure.ledgers.length, failure.subIssues.map((issue) => issue.id)], [0, 1, [8]]);
  eq('评论分页失败和子 Issue 读取失败分别进 errors', failure.errors.map(({ source, code, message }) => [source, code, typeof message]), [
    ['sub-issue:acme/core-svc#81', 'EXEC_FAILED', 'string'], ['change:acme/core-svc#7:comments', 'EXEC_FAILED', 'string'],
  ]);
}

function checkActionMessages() {
  group('动作码和巡检规则登记');
  const read = (file) => fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
  const tickSource = read('lib/tick.mjs');
  const outboxSource = read('lib/outbox.mjs');
  const loopctlSource = read('loopctl.mjs');
  const forgeSource = read('forge.mjs');
  const literals = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);
  const kinds = literals(tickSource + outboxSource, /\b(?:action|notifyAction)\(([^,\n]+),/g)
    .flatMap((argument) => literals(argument, /'([\w-]+)'/g));
  const notifyCodes = /const NOTIFY_CONFIG_CODES = \{([^}]+)\}/.exec(loopctlSource)[1];
  const assignedCodes = literals(tickSource, /\bconst code = ([^;]+)/g);
  const codes = new Set([
    ...kinds,
    ...literals(forgeSource, /\bwarn\([^\n]+?,\s*'([A-Z_]+)',/g),
    ...literals(tickSource, /\bcode:\s*'([\w-]+)'/g),
    ...literals(tickSource, /\bnew CliError\('(?!INVALID_TICK_ROLE')([A-Z_]+)'/g),
    ...literals(tickSource, /writeScriptComment\([^;]*?,\s*'([A-Z_]+)',\s*\w+_DOC\)/g),
    ...literals(loopctlSource, /'(MERGE_MODE_[A-Z]+)'/g),
    ...literals([notifyCodes, ...assignedCodes].join('\n'), /'([A-Z_]+)'/g),
    ...literals(loopctlSource, /\bfinding\(\s*'([A-Z0-9_]+)'/g),
    ...literals(loopctlSource, /\['[\w-]+',\s*'([A-Z_]+)',\s*'/g),
  ]);
  const registered = Object.keys(ACTION_MESSAGES);
  const missing = [...codes].filter((code) => !registered.includes(code) && !registered.some((key) => key.endsWith(':' + code)));
  const invalid = registered.filter((key) => !/^.{1,20}$/u.test(ACTION_MESSAGES[key]));
  eq('源码产出的码都登记为 20 字以内的单行人话', { missing, invalid }, { missing: [], invalid: [] });
}

function scenarioTick(tmp) {
  group('10. 事实优先 tick 四角色 + 变化判定 + 调度');
  const fake = makeFakeForge(path.join(tmp, 'forge'));
  const config = path.join(tmp, 'config');
  const repo = 'acme/loop';
  const baseline = 'loop/tick-demo';
  const now = '2024-05-01T04:00:00Z';
  const earlier = '2024-05-01T01:00:00Z';
  const run = {
    req: 'tick-demo', tier: 'L2', user: 'dev-a', forge: 'github', hubRepo: { repo }, repos: [{ repo, branch: 'main' }],
    baselineBranch: baseline, autoMerge: true, issues: { main: { id: 7 } }, controller: { sessionId: 'controller-a' },
  };
  const runFile = path.join(config, 'runs', run.req + '.json');
  const patrolState = runFile.replace(/\.json$/, '.tick-state.patrol.json');
  const register = (value) => write(runFile, JSON.stringify(value));
  const tick = (role, date = now, apply = true) => loopctl(['tick', '--req', run.req, '--role', role, '--now', date, ...(apply ? ['--apply'] : [])], config, fake.env);
  const actions = (result) => result.json.runs?.[0].actions ?? [];
  const kinds = (result) => actions(result).map((item) => item.kind);
  const notice = (id, body, time = now) => ({ id, body, created_at: time, user: { login: 'dev-a' } });
  const issue = (body, state = 'OPEN') => ({ body, state, labels: [], updatedAt: now });
  const personal = [
    '## 1. 基本信息', '阶段：P3 ｜ 状态：未开始', '主控：第 1 任 ｜ controller-a ｜ local',
    '本轮：空闲', '最近唤醒：05-01 12:00', '## 2. 需本人处理', '- 无', '## 3. 当前进行中',
    '无', '## 4. 近期完成与挂起', '无', '## 5. 流程提醒与规则引用', '无', '',
  ].join('\n');
  const ledgerNotes = 'repos/acme/loop/issues/7/comments';
  const changeNotes = (id) => 'repos/acme/loop/issues/' + id + '/comments';
  const resetForge = (state) => fake.reset(state.issues?.[repo + '#5']
    ? withSlotBindings(state, changeNotes(5), slotBinding(8001, 'A', 'dev-a', 'controller-a'), slotBinding(8002, 'B', 'dev-b', 'controller-b'))
    : state);
  const meta = { state: 'OPEN', headRefOid: 'abcdef123456'.padEnd(40, '0'), baseRefName: baseline, headRefName: 'dev/one', updatedAt: now, createdAt: now, body: '关联 #7' };
  const state = { issues: { [repo + '#7']: issue(personal) } };
  register(run);
  resetForge(state);
  eq('tick 缺 req 和非法角色拒绝', [
    loopctl(['tick', '--role', 'controller'], config, fake.env).json.code, tick('lead-daily').json.code,
  ], ['MISSING_FLAG', 'INVALID_TICK_ROLE']);
  const quiet = tick('controller', '2024-05-01T04:01:00Z');
  eq('主控空闲无下一步时退出 0 且 stdout/stderr 为空', [quiet.code, quiet.stdout, quiet.stderr], [0, '', '']);
  ok('主控即使无动作也把最近唤醒刷新到 Forge', fake.calls().some((call) => call.args[1] === 'edit'
    && call.args.at(-1).includes('最近唤醒：05-01 12:01')));
  const first = tick('patrol', now, false);
  eq('不带 apply 时预览工作日全量而不写 tick-state', [kinds(first), actions(first)[0]?.full, fs.existsSync(patrolState)], [['patrol-review'], true, false]);
  const applied = tick('patrol');
  eq('工作日首轮巡检保存台账哈希和全量日期', [kinds(applied), typeof readJson(patrolState).ledgers[repo + '#7'].bodyHash, readJson(patrolState).fullReviewDate], [['patrol-review'], 'string', '2024-05-01']);
  eq('同日同事实再次巡检无输出', tick('patrol').stdout, '');
  ok('小巡检在同一台账留下自己的心跳且保留主控心跳', fake.calls().some((call) => call.args[1] === 'edit'
    && call.args.at(-1).includes('小巡检最近唤醒：05-01 12:00')
    && call.args.at(-1).includes('\n最近唤醒：05-01 12:01')));
  resetForge({ ...state, issues: { [repo + '#7']: issue(personal.replace('05-01 12:00', '05-01 12:20')) } });
  eq('单独刷新最近唤醒不会触发巡检判断', tick('patrol', '2024-05-01T04:20:00Z').stdout, '');
  eq('周末无变化不做每日全量', kinds(tick('patrol', '2024-05-04T04:00:00Z')).includes('patrol-review'), false);
  const nextDay = tick('patrol', '2024-05-06T04:00:00Z');
  eq('下个工作日同一份事实仍做一次全量', actions(nextDay).some((item) => item.kind === 'patrol-review' && item.full), true);
  const historyFile = runFile.replace(/\.json$/, '.ticks.jsonl');
  const history = fs.readFileSync(historyFile, 'utf8').trim().split('\n').map(JSON.parse);
  const recent = loopctl(['status', '--json', '--req', run.req], config, fake.env).json.run.recentTicks;
  eq('每次唤醒留本机日志，状态按角色返回最近五次且保留 quiet', [
    history.length, history[0].result, history[1].apply, recent.patrol.map((row) => row.at), recent.controller[0].result,
  ], [7, 'quiet', false, ['2024-05-06T04:00:00.000Z', '2024-05-04T04:00:00.000Z', '2024-05-01T04:20:00.000Z',
    '2024-05-01T04:00:00.000Z', '2024-05-01T04:00:00.000Z'], 'quiet']);
  const handedOff = personal.replace('第 1 任 ｜ controller-a', '第 2 任 ｜ controller-b');
  resetForge({ issues: { [repo + '#7']: issue(handedOff) },
    comments: { [ledgerNotes]: [[notice(1000, '【设计变更】请核对新验收条件')]] } });
  const handoff = actions(tick('controller', '2024-05-01T05:00:00Z'));
  const afterHandoff = actions(tick('patrol', '2024-05-01T05:30:00Z'));
  eq('R5/01 交接后按台账现任开轮和更新心跳，小巡检不误报失联', [
    handoff.find(({ code }) => code === 'UNREPLIED_COMMENT')?.sessionId,
    readJson(fake.env.FAKE_FORGE_STATE).issues[repo + '#7'].body.includes('最近唤醒：05-01 13:00'),
    afterHandoff.some(({ code }) => code === 'CONTROLLER_DISCONNECTED'),
  ], ['controller-b', true, false]);

  const legacyRunning = personal.replace('本轮：空闲', '本轮：执行中');
  resetForge({ issues: { [repo + '#7']: issue(legacyRunning) } });
  eq('R5/06 上轮缺开始时间，短时只续心跳，超过卡住阈值可自愈并提醒', [
    actions(tick('controller', '2024-05-01T05:30:00Z')).some(({ code }) => code === 'SELF_RUNNING_STUCK_HEAL'),
    actions(tick('controller', '2024-05-01T06:05:00Z')).some(({ code }) => code === 'SELF_RUNNING_STUCK_HEAL'),
    actions(tick('patrol', '2024-05-01T06:10:00Z')).some(({ code, refs }) =>
      code === 'CONTROLLER_STUCK' || refs.some((ref) => ref?.code === 'CONTROLLER_STUCK')),
  ], [false, true, true]);

  const unassigned = (labels) => ({ ...issue('待推进'), labels, assignees: [] });
  register({ ...run, issues: { main: 7, subIssues: [12, 13] } });
  resetForge({ issues: { ...state.issues, [repo + '#12']: unassigned([]), [repo + '#13']: unassigned(['bug']) } });
  eq('R5/05 L2 连续两轮空闲且子 Issue 和 bug 未完成，每轮均可推进', [
    ...['2024-05-01T06:30:00Z', '2024-05-01T07:00:00Z'].map((date) =>
      actions(tick('controller', date)).find(({ code }) => code === 'SELF_IDLE_START')?.refs.map(({ id }) => id)),
  ], [[12, 13], [12, 13]]);

  const waitingForPerson = personal.replace('状态：未开始', '状态：待确认').replace('- 无', '- [待确认] 核对方案甲');
  resetForge({ issues: { ...state.issues, [repo + '#7']: issue(waitingForPerson), [repo + '#12']: unassigned([]), [repo + '#13']: unassigned(['bug']) } });
  const firstWait = actions(tick('controller', '2024-05-01T07:30:00Z')).map(({ code }) => code);
  const workState = readJson(fake.env.FAKE_FORGE_STATE);
  workState.issues[repo + '#7'].body = waitingForPerson.replace('本轮：空闲', '当前步骤：已完成细化\n本轮：空闲');
  workState.comments = { [changeNotes(12)]: [[notice(1090, '主控 ｜ 主研发 ｜ controller-a\n【配置变更】已登记待确认')]] };
  resetForge(workState);
  const edits = tick('controller', '2024-05-01T08:00:00Z');
  const overdue = actions(tick('controller', '2024-05-01T09:30:00Z')).map(({ code }) => code);
  eq('R5/08 台账编辑和自己签名的评论不打开新一轮，仅在等待人处理的时间点提醒', [
    firstWait, edits.stdout, overdue,
  ], [['CONTROLLER_WAITING'], '', ['CONTROLLER_WAITING']]);

  resetForge({ ...state, issues: { [repo + '#7']: issue(personal.replace('阶段：P3', '阶段：P2')) },
    comments: { [ledgerNotes]: [[notice(1001, '【配置变更】检查 https://docs.example.test/change')]] },
    prs: { [repo + '#8']: { ...meta, labels: ['需求:tick-demo'] } } });
  register({ ...run, changes: [{ repo, id: 8 }] });
  const changed = tick('patrol');
  const delta = actions(changed).find((item) => item.kind === 'patrol-review');
  ok('巡检给出正文前后差异、新配置评论、新设计文档和 PR diff 引用', delta?.ranges.some((entry) =>
    entry.bodyDiff?.before[0]?.includes('P3') && entry.bodyDiff?.after[0]?.includes('P2') && entry.configCommentIds?.[0] === 1001
    && entry.designLinks?.[0] === 'https://docs.example.test/change') && delta.ranges.some((entry) => entry.diff?.headSha === meta.headRefOid));
  const advance = tick('controller');
  eq('主控工作时段按实况发现未回复评论和可推进状态', actions(advance).map((item) => item.code), ['UNREPLIED_COMMENT', 'SELF_IDLE_START']);
  eq('主控非工作时段无 LLM 动作', tick('controller', '2024-05-01T15:00:00Z').stdout, '');
  ok('非工作时段仍刷新已核实身份的主控心跳', fake.calls().some((call) => call.args[1] === 'edit'
    && call.args.at(-1).includes('最近唤醒：05-01 23:00')));
  register(run);
  resetForge({ ...state, failApi: [ledgerNotes + '?per_page=100'] });
  for (const role of ['controller', 'dispatch', 'patrol', 'lead-patrol']) {
    const failed = tick(role, '2024-05-01T15:00:00Z');
    eq(`${role} 即使在非工作时段也输出 facts-error`, [kinds(failed), actions(failed)[0]?.code], [['facts-error'], 'EXEC_FAILED']);
  }

  register(run);
  resetForge({});
  const makeMember = (sub, args) => forge([sub, '--req', run.req, '--config-dir', config,
    '--forge', 'github', '--repo', repo, '--title', '成员', ...args], fake.env);
  const memberIssue = makeMember('issue-create', ['--labels', 'bug']);
  const memberChange = makeMember('change-create', ['--source', 'dev/member', '--target', baseline, '--labels', '待终审']);
  eq('创建带 --req 的 Issue 和 PR 时自动加成员标签并登记', [
    memberIssue.json.member?.id, memberChange.json.member?.id, readJson(runFile).demandIssues, readJson(runFile).changes,
    fake.calls().map(({ args }) => args.at(-1)),
  ], [50, 51, [{ repo, id: 50 }], [...run.changes ?? [], { repo, id: 51 }], ['bug,需求:tick-demo', '待终审,需求:tick-demo']]);
  const memberSync = forge(['labels-sync', '--forge', 'github', '--repos', repo, '--req', run.req, '--dry-run'], fake.env);
  ok('labels-sync 创建需求成员标签', memberSync.json.invocations?.some(({args}) => args.includes('需求:tick-demo')));
  register(run);

  const masterBody = [
    '## 1. 整体状态', '当前阶段：P3', '整体进度：Issue 已完成 0/0 ｜ PR/MR 已合入 0/0', '整体风险：人工保留',
    '## 2. 待主研发处理', '- 无', '- 人工保留的事项', '## 3. 各开发者', '| A | dev-a | 测试 | 无 | #7 |', '| B | dev-b | 测试 | 无 | #6 |',
    '## 4. 契约、归属与本次临时规范', '契约版本：v2', '- 无', '## 5. 阶段节点', 'P3 进行中', '',
  ].join('\n');
  const squad = { ...run, tier: 'L3', slot: 'A', issues: { master: 5, 'slot:A': 7, 'slot:B': 6, subIssues: [15] },
    changes: [8, 9, 10, 11, 12, 13].map((id) => ({ repo, id })) };
  register(squad);
  const withLabels = (...labels) => ({ ...meta, labels: [...new Set(['需求:tick-demo', ...labels])] });
  const review = (id, session, conclusion, props = {}) =>
    ({ repo, id, session, conclusion, at: now, headSha: meta.headRefOid, ...props });
  const resetWithReviews = (state, ...specs) => resetForge(seedReviews(runFile, structuredClone(state), specs));
  const approvedChild = {
    issues: { [repo + '#7']: issue(personal.replace('## 3. 当前进行中\n无', '## 3. 当前进行中\n办理 #15')),
      [repo + '#15']: { ...issue('子任务'), labels: ['需求:tick-demo'] } },
    prs: { [repo + '#10']: { ...withLabels('终审中', '需求:tick-demo'), body: '关联 #15' } },
  };
  const lowChild = review(10, 'reviewer-a', '通过', { commentId: 21 });
  const command = ['change-merge', '--forge', 'github', '--repo', repo, '--id', '10', '--target', baseline,
    '--head-sha', meta.headRefOid, '--run', runFile];
  const reviewFlags = ['--round', '1', '--conclusion', '通过', '--risk',
    'contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0',
    '--head-sha', meta.headRefOid, '--session', 'reviewer-a'];
  const changeArgs = (platform, id = 10) =>
    ['--run', runFile, '--forge', platform, '--repo', repo, '--id', String(id)];
  const startReview = (platform, role, session, id = 10, by = role === 'dispatch' ? 'disp-1' : null) =>
    forge(['dispatch-review', ...changeArgs(platform, id), '--role', role, '--head-sha', meta.headRefOid,
      '--session', session, ...(by ? ['--by', by] : [])], fake.env);
  const finishReview = (platform, record, conclusion = '通过', id = 10, more = []) =>
    forge(['verdict', ...changeArgs(platform, id), ...reviewFlags,
      '--dispatch-id', record.dispatchId, '--nonce', record.nonce, '--round', String(record.round),
      '--conclusion', conclusion, '--session', record.session, ...more], fake.env);
  const headState = (labels) => ({ ...approvedChild, prs: { [repo + '#10']: { ...approvedChild.prs[repo + '#10'], labels: [...labels, '需求:tick-demo'] } } });
  register(run);
  resetWithReviews(headState(['待终审']));
  const dispatchPost = startReview('github', 'controller', 'reviewer-a');
  const record = dispatchPost.json;
  const validMustFix = ['--must-fix', '1. 【P1】必改项示例\n入口：POST /api/orders\n证据：src/order.js:10 未校验空值'];
  const wrongNonce = finishReview('github', record, '通过', 10, ['--nonce', 'incorrect']);
  const reviewPost = finishReview('github', record, '通过', 10, ['--keep', '保留默认逻辑']);
  const duplicate = finishReview('github', record, '打回', 10, validMustFix);
  const generated = readJson(fake.env.FAKE_FORGE_STATE).comments?.[changeNotes(10)]?.[0] ?? [];
  eq('GitHub 终审当场合入，带候选 SHA 并记录审计评论且不公开 nonce', [
    dispatchPost.code, reviewPost.code, reviewPost.json.state, reviewPost.json.merged,
    generated[1]?.body.includes('保留默认逻辑'), generated[1]?.body.match(/<!-- liteloop:verdict /g)?.length,
    generated.some((note) => note.body.includes(record.nonce)),
    fake.calls().find(({ args }) => args[1] === 'merge')?.args.slice(-2),
    readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
  ], [0, 0, 'merged', true, true, 1, false, ['--match-head-commit', meta.headRefOid], 'MERGED']);
  if (process.env.LITELOOP_TEST_RECEIPTS === '1') console.log('VERDICT RECEIPT\n' + reviewPost.stdout.trimEnd());
  eq('伪造 nonce 和重发结论都被拦住', [wrongNonce.json.code, duplicate.json.code],
    ['REVIEW_DISPATCH_MISMATCH', 'REVIEW_ALREADY_RECORDED']);
  eq('普通评论不能代替派审命令', forge(['change-comment', ...changeArgs('github'), '--body', generated[0].body], fake.env).json.code,
    'REVIEW_COMMAND_REQUIRED');
  resetWithReviews({ ...headState(['终审中']), comments: { [changeNotes(10)]: [generated] } });
  eq('没有本机派审记录时，Forge 的通过结论只转人工，change-merge 和 tick 都不合并', [
    forge(command, fake.env).json.code, actions(tick('controller')).some(({ code }) => code === 'REVIEW_AUTHORIZATION_REQUIRED'),
    readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
    fake.calls().filter(({ args }) => args[1] === 'merge').length,
  ], ['REVIEW_AUTHORIZATION_REQUIRED', true, 'OPEN', 0]);

  resetWithReviews(headState(['待终审']));
  const waitingDispatch = startReview('github', 'controller', 'depends-open').json;
  const withDependency = readJson(fake.env.FAKE_FORGE_STATE);
  withDependency.prs[repo + '#10'].body += '\nDepends-On: #29';
  withDependency.prs[repo + '#29'] = { ...meta, baseRefName: 'main' };
  resetForge(withDependency);
  const waitingResult = finishReview('github', waitingDispatch);
  const pending = readJson(fake.env.FAKE_FORGE_STATE);
  eq('依赖未合时登记等待、标待合并并说明自动重试', [
    waitingResult.json.state, waitingResult.json.code, waitingResult.json.message.includes('自动重试'),
    workflowLabels(pending.prs[repo + '#10']), fake.calls().filter(({ args }) => args[1] === 'merge').length,
  ], ['waiting', 'DEPENDS_ON_UNMERGED', true, ['风险低', '待合并'], 0]);
  pending.prs[repo + '#29'].state = 'MERGED';
  delete pending.comments[changeNotes(10)];
  resetForge(pending);
  eq('依赖合入后 tick 用本机等待记录合入，不读取 PR 评论', [
    actions(tick('controller')).some(({ code }) => code === 'LOW_RISK_AUTO_MERGE'),
    readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
    fake.calls().some(({ args }) => args.some((arg) => arg.startsWith(changeNotes(10))) && !args.includes('POST')),
  ], [true, 'MERGED', false]);

  for (const label of ['需修改', '待终审']) {
    const queued = headState([label]);
    const comment = notice(2202, '提交者 ｜ 主研发 ｜ peer\n【纠偏】请核查本次改动');
    queued.comments = { [changeNotes(10)]: [[comment]] };
    resetWithReviews(queued, { ...lowChild, waiting: true });
    const result = actions(tick('controller'));
    const actual = readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'];
    eq(`R6/03 旧等待记录作废，保留${label}`, [
      result.some(({ code }) => code === 'REVIEW_NOT_ACTIVE'), workflowLabels(actual), actual.state,
    ], [true, [label], 'OPEN']);
  }
  const requeued = headState(['待终审']);
  requeued.comments = { [changeNotes(10)]: [[notice(2203, '提交者 ｜ 主研发 ｜ peer\n【纠偏】请核查新的候选')]] };
  const historical = headState(['待终审']);
  seedReviews(runFile, historical, [review(10, 'forge-only-reject', '打回', { commentId: 2204 })]);
  requeued.comments[changeNotes(10)][0].push(...historical.comments[changeNotes(10)][0]);
  resetWithReviews(requeued,
    { ...lowChild, waiting: true },
    review(10, 'local-reject', '打回', { round: 2, commentId: 2205 }));
  const requeuedFacts = readJson(fake.env.FAKE_FORGE_STATE);
  requeuedFacts.comments[changeNotes(10)][0] = requeuedFacts.comments[changeNotes(10)][0].filter(({ id }) => id !== 2205);
  resetForge(requeuedFacts);
  const requeuedActions = actions(tick('controller'));
  eq('R6/05 已被替换的自动合入登记不屏蔽纠偏评论和重审', [
    requeuedActions.some(({ code }) => code === 'UNREPLIED_COMMENT'),
    requeuedActions.find(({ code }) => code === 'dispatch')?.rejectCount,
    requeuedActions.find(({ code }) => code === 'dispatch')?.fullReReview,
  ], [true, 2, true]);
  const mixed = startReview('github', 'controller', 'mixed-rejects').json;
  const fused = finishReview('github', mixed);
  eq('R6/02 本机和 Forge 两个派审各算一次并触发熔断', [
    mixed.round, fused.json.rejectCount, fused.json.code, readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
  ], [3, 2, 'REJECT_FUSE_FULL_REVIEW', 'OPEN']);

  for (const move of ['before-verdict', 'at-merge', 'while-waiting']) {
    resetWithReviews(headState(['待终审']));
    const candidate = startReview('github', 'controller', 'head-' + move).json;
    const moved = readJson(fake.env.FAKE_FORGE_STATE);
    const otherSha = 'b'.repeat(40);
    if (move === 'while-waiting') {
      moved.prs[repo + '#10'].body += '\nDepends-On: #29';
      moved.prs[repo + '#29'] = { ...meta, baseRefName: 'main' };
      resetForge(moved);
      finishReview('github', candidate);
      const later = readJson(fake.env.FAKE_FORGE_STATE);
      later.prs[repo + '#29'].state = 'MERGED';
      later.prs[repo + '#10'].headRefOid = otherSha;
      resetForge(later);
      eq('等待中 head 变化，tick 停止重试并退回待终审', [
        actions(tick('controller')).some(({ code }) => code === 'HEAD_SHA_MISMATCH'),
        workflowLabels(readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10']),
        fake.calls().filter(({ args }) => args[1] === 'merge').length,
      ], [true, ['待终审'], 0]);
    } else {
      if (move === 'before-verdict') moved.prs[repo + '#10'].headRefOid = otherSha;
      else moved.moveHeadAtMerge = otherSha;
      resetForge(moved);
      const result = finishReview('github', candidate);
      eq(`候选 head 移动（${move}）拒绝合入`, [
        result.json.code, readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
        fake.calls().filter(({ args }) => args[1] === 'merge').length,
      ], ['HEAD_SHA_MISMATCH', 'OPEN', move === 'before-verdict' ? 0 : 1]);
      if (move === 'at-merge') {
        const after = readJson(fake.env.FAKE_FORGE_STATE);
        eq('R26 合并时 head 变动退回待终审，评论写明两个候选', [
          result.json.state, workflowLabels(after.prs[repo + '#10']),
          after.comments[changeNotes(10)].flat().at(-1).body.includes(
            `终审的是 ${meta.headRefOid}，现在是 ${otherSha}，需重新送审`),
        ], ['invalidated', ['待终审'], true]);
      }
    }
  }

  resetWithReviews(headState(['待终审']));
  const failedMergeDispatch = startReview('github', 'controller', 'merge-permission').json;
  const permissionFailure = readJson(fake.env.FAKE_FORGE_STATE);
  permissionFailure.failMerge = { 10: 'HTTP 403 Forbidden\nadditional diagnostics' };
  resetForge(permissionFailure);
  const failedMerge = finishReview('github', failedMergeDispatch);
  const failureAudit = readJson(fake.env.FAKE_FORGE_STATE).comments[changeNotes(10)].flat().at(-1).body;
  eq('R26 head 未变的硬失败转人工，评论只附 stderr 首行', [
    failedMerge.json.state, failedMerge.json.code,
    failureAudit.split('\n').at(-1).includes('HTTP 403 Forbidden'), failureAudit.includes('additional diagnostics'),
  ], ['manual', 'EXEC_FAILED', true, false]);

  for (const [code, mode, patch, extra] of [
    ['AUTO_MERGE_DISABLED', { autoMerge: false }, {}, []],
    ['HIGH_RISK_MANUAL', {}, {}, ['--risk', reviewFlags[5].replace('contract=0', 'contract=1')]],
    ['ENV_BRANCH_FORBIDDEN', {}, { baseRefName: 'test' }, []],
    ['SOURCE_ENV_BRANCH_FORBIDDEN', {}, { headRefName: 'uat' }, []],
    ['TARGET_MISMATCH', {}, { baseRefName: 'loop/other' }, []],
  ]) {
    register({ ...run, ...mode });
    resetWithReviews(headState(['待终审']));
    const candidate = startReview('github', 'controller', 'manual-' + code).json;
    const updated = readJson(fake.env.FAKE_FORGE_STATE);
    Object.assign(updated.prs[repo + '#10'], patch);
    resetForge(updated);
    const result = finishReview('github', candidate, '通过', 10, extra);
    eq(`终审通过但 ${code} 时转人工`, [
      result.json.state, result.json.code, result.json.message?.includes('人工'),
      readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
    ], ['manual', code, true, 'OPEN']);
  }
  register(run);
  register({ ...run, forge: 'gitlab', tier: 'L3', slot: 'A' });
  resetWithReviews({ mrs: { [repo + '!10']: { state: 'opened', sha: meta.headRefOid, target_branch: baseline, labels: ['待终审', '需求:tick-demo'] } } });
  eq('L3 槽位主控自派被拦住', startReview('gitlab', 'dispatch', 'slot-review').json.code, 'REVIEW_DISPATCH_FORBIDDEN');
  register({ ...run, forge: 'gitlab', tier: 'L3', slot: '主研发' });
  const queuedGitLab = readJson(fake.env.FAKE_FORGE_STATE);
  const missingBy = startReview('gitlab', 'dispatch', 'missing-dispatcher', 10, null);
  eq('R27 调度漏填 --by 拒绝派审且不发评论', [
    missingBy.code, missingBy.json.code, missingBy.json.message?.includes('--by') ?? false,
    fake.calls().filter(({ args }) => args.includes('POST')).length,
  ], [2, 'MISSING_FLAG', true, 0]);
  resetWithReviews(queuedGitLab);
  const glDispatch = startReview('gitlab', 'dispatch', 'gitlab-review');
  const glReview = finishReview('gitlab', glDispatch.json, '打回', 10, [
    '--slot', 'A', '--must-fix', '1. 【P1】修复空值\n入口：POST /api/orders\n证据：src/order.js:12 未判空',
  ]);
  const glNotes = readJson(fake.env.FAKE_FORGE_STATE).comments?.['projects/acme%2Floop/merge_requests/10/notes']?.[0] ?? [];
  eq('R27 派审评论由调度实际会话签名', glNotes[0]?.body.split('\n')[0], '主研发调度 ｜ 主研发 ｜ disp-1');
  eq('GitLab 顶层评论去 MR notes，打回正文带必改项和槽位', [
    glDispatch.code, glReview.code, glNotes.length, glNotes[1]?.body.startsWith('终审 ｜ A ｜ gitlab-review\n结论：打回'),
    glNotes[1]?.body.includes('修复空值'),
  ], [0, 0, 2, true, true]);
  resetForge({});
  eq('verdict 参数缺失、轮次/结论错误、风险不完整或重复、SHA 不全时拒绝发评论', [
    forge(['verdict', ...changeArgs('github')], fake.env).json.code,
    ...[
      ['--round', '1.5'], ['--conclusion', '通过/打回'], ['--risk', 'contract=0'],
      ['--risk', reviewFlags[5] + ',contract=1'], ['--head-sha', 'abcd'], ['--session', 'two words'],
    ].map((more) => forge(['verdict', ...changeArgs('github'), ...reviewFlags, ...more], fake.env).json.code),
    fake.calls().length,
  ], ['MISSING_FLAG', 'INVALID_REVIEW_ROUND', 'INVALID_CONCLUSION', 'INVALID_RISK', 'INVALID_RISK', 'INVALID_HEAD_SHA', 'INVALID_SESSION', 0]);
  register(run);
  resetWithReviews(headState(['待终审']));
  const firstReject = startReview('github', 'controller', 'reject-one').json;
  eq('第一轮打回已成功登记', finishReview('github', firstReject, '打回', 10, validMustFix).code, 0);
  resetForge(headState(['待终审']));
  eq('换轮后重用旧会话标识被拦住', startReview('github', 'controller', firstReject.session).json.code, 'REVIEW_SESSION_REUSED');
  const secondReject = startReview('github', 'controller', 'reject-two').json;
  eq('旧会话重放被拦住，新一轮打回仍能登记', [
    finishReview('github', firstReject).json.code, finishReview('github', secondReject, '打回', 10, validMustFix).code,
  ], ['REVIEW_DISPATCH_MISMATCH', 0]);
  resetForge(headState(['待终审']));
  const afterRejects = startReview('github', 'controller', 'after-two-rejects').json;
  eq('两轮不同会话均已打回，删评论后第三轮通过仍触发熔断', [
    afterRejects.round, finishReview('github', afterRejects).json.code,
    actions(tick('controller')).some(({ code }) => code === 'REVIEW_FUSE_REGISTERED'),
    readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
  ], [3, 'REJECT_FUSE_FULL_REVIEW', true, 'OPEN']);
  resetWithReviews(headState(['待终审']));
  resetForge({ ...headState(['待终审']), comments: { [changeNotes(10)]: [[notice(1, '打回第 3 次')]] } });
  eq('无签名的普通评论不会触发打回熔断',
    actions(tick('controller')).find(({ kind }) => kind === 'review-dispatch')?.rejectCount, 0);
  // R14 / repro 01: keep the Forge history and lose the local journal.
  resetWithReviews(headState(['待终审']),
    review(10, 'lost-one', '打回', { commentId: 101 }),
    review(10, 'lost-two', '打回', { round: 2, commentId: 102 }));
  fs.unlinkSync(runFile.replace(/\.json$/, '.reviews.jsonl'));
  const lostPlan = actions(tick('controller')).find(({ kind }) => kind === 'review-dispatch');
  const reused = startReview('github', 'controller', 'lost-one');
  const recoveredDispatch = startReview('github', 'controller', 'fresh-review').json;
  const recoveredVerdict = finishReview('github', recoveredDispatch);
  const blockedMerge = forge(command, fake.env);
  const recoveredStatus = loopctl(['status', '--json', '--req', run.req, '--live'], config, fake.env).json.live;
  eq('丢失登记簿后 status 仍按 Forge 实查显示熔断', recoveredStatus.actionRequired.some(({ code }) => code === 'REJECT_FUSE'), true);
  const recoveredTick = tick('controller');
  eq('复现 01 登记簿丢失后保留两次打回和轮次，拒绝复用会话，第三轮通过仍熔断', [
    lostPlan?.rejectCount, lostPlan?.fullReReview, reused.json.code, recoveredDispatch.round, recoveredVerdict.json.code,
    blockedMerge.json.code, actions(recoveredTick).some(({ code }) => code === 'REVIEW_FUSE_REGISTERED'),
    readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10'].state,
    readJson(fake.env.FAKE_FORGE_STATE).issues[repo + '#7'].body.includes('[待裁决]'),
  ], [2, true, 'REVIEW_SESSION_REUSED', 3, 'REJECT_FUSE_FULL_REVIEW', 'REVIEW_AUTHORIZATION_REQUIRED', true, 'OPEN', true]);

  // R14 / repro 02: a quote and a bare dispatch ID cannot shadow the recorded comment.
  resetWithReviews(headState(['待终审']));
  const quoted = startReview('github', 'controller', 'quoted-reject').json;
  const rejection = finishReview('github', quoted, '打回', 10, validMustFix);
  const quotedState = readJson(fake.env.FAKE_FORGE_STATE);
  const quotedNotes = quotedState.comments[changeNotes(10)][0];
  quotedNotes.push(notice(2001, quotedNotes.at(-1).body.replace(/^/gm, '> ')));
  resetForge(quotedState);
  eq('引用打回评论不重复计数，verdict 已当场标需修改', [
    rejection.json.code, rejection.json.rejectCount,
    workflowLabels(readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10']),
  ], ['REVIEW_REJECTED', 1, ['需修改']]);

  resetWithReviews(headState(['待终审']));
  const interrupted = startReview('github', 'controller', 'interrupted-review').json;
  const interruptedState = readJson(fake.env.FAKE_FORGE_STATE);
  interruptedState.comments[changeNotes(10)][0].push(notice(2002, `提及 liteloop:verdict ${interrupted.dispatchId}`));
  resetForge(interruptedState);
  tick('controller');
  eq('复现 02 他人提及公开派审 ID 后真实终审仍可提交', finishReview('github', interrupted, '打回', 10, validMustFix).code, 0);

  for (const conclusion of ['通过', '打回']) {
    resetWithReviews(headState(['待终审']));
    const unpublished = startReview('github', 'controller', `unpublished-${conclusion}`).json;
    const beforeFailure = readJson(fake.env.FAKE_FORGE_STATE);
    resetForge({ ...beforeFailure, failApi: [changeNotes(10)] });
    const failedPublish = finishReview('github', unpublished, conclusion, 10, [
      '--must-fix', '1. 【P1】保存待发布正文\n入口：POST /api/orders\n证据：src/order.js:20 实测复现',
    ]);
    const afterFailure = readJson(fake.env.FAKE_FORGE_STATE);
    delete afterFailure.failApi;
    resetForge(afterFailure);
    const audit = tick('controller');
    const republishArgs = ['verdict', ...changeArgs('github'), '--republish', '--dispatch-id', unpublished.dispatchId];
    const repeated = forge(republishArgs, fake.env);
    const publishedNotes = readJson(fake.env.FAKE_FORGE_STATE).comments[changeNotes(10)][0];
    eq(`${conclusion}审计发布失败不影响执行，下一次 tick 自动补发，重复补发不再写`, [
      failedPublish.json.auditPending, failedPublish.json.state,
      actions(audit).some(({ code, refs }) => code === 'VERDICT_AUDIT_REPUBLISH' && refs[0].commentId === repeated.json.commentId),
      publishedNotes.filter(({ body }) => body.includes('保存待发布正文')).length,
      fake.calls().filter(({ args }) => args[1] === 'merge').length,
    ], [true, conclusion === '通过' ? 'merged' : 'rejected', true, 1, 0]);
  }

  register(run);
  resetWithReviews(headState(['待合并']), { ...lowChild, waiting: true });
  eq('L2 命令行重试合入台账中实查到的子任务，运行态只登记主台账', forge(command, fake.env).json.merged, true);
  resetWithReviews({ ...approvedChild, prs: { [repo + '#10']: { ...approvedChild.prs[repo + '#10'], labels: ['需求:tick-demo', '待合并'], body: '关联 #999' } } },
    { ...lowChild, waiting: true });
  eq('传入 allowed-issues 也不能替代 Forge 实查集合', forge([...command, '--allowed-issues', '999'], fake.env).json.code, 'ISSUE_REF_NOT_IN_RUN');

  register({ ...run, tier: 'L1', autoMerge: false, issues: { tracking: 7 } });
  resetWithReviews(headState(['待终审']));
  const manualDispatch = startReview('github', 'controller', 'l1-manual').json;
  tick('controller');
  const manual = finishReview('github', manualDispatch);
  eq('L1 低风险 verdict 当场切待人工合并', [
    manual.json.code, workflowLabels(readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10']),
  ], ['AUTO_MERGE_DISABLED', ['风险低', '待合并']]);
  eq('L1 手合首次提醒，退避窗口内不重复提醒', [
    actions(tick('controller')).some(({ code }) => code === 'CONTROLLER_WAITING'), tick('controller').stdout,
  ], [true, '']);
  register({ ...run, tier: 'L1', autoMerge: false, issues: { tracking: 7 } });
  const closedPr = { ...approvedChild.prs[repo + '#10'], state: 'CLOSED' };
  resetForge({ ...approvedChild, prs: { ...approvedChild.prs, [repo + '#11']: closedPr } });
  const liveOverview = loopctl(['status', '--json', '--req', run.req, '--live'], config, fake.env).json.live?.overview;
  eq('L1 实查到未登记 PR 时概览计入 open，排除已关闭未合入的 PR', [
    liveOverview?.source, liveOverview?.totals.mrs, liveOverview?.totals.openMrs, liveOverview?.headline.includes('未合入 MR 1'),
  ], ['forge', 2, 1, true]);
  for (const [tier, key, section] of [['L1', 'tracking', 4], ['L2', 'main', 2]]) {
    register({ ...run, tier, autoMerge: tier === 'L2', issues: { [key]: 7 } });
    resetWithReviews(headState(['待终审']),
      review(10, 'first', '打回', { at: earlier, commentId: 1 }),
      review(10, 'second', '打回', { round: 2, commentId: 2 }));
    const full = startReview('github', 'controller', 'full-' + tier).json;
    const result = finishReview('github', full);
    tick('controller');
    const ledger = readJson(fake.env.FAKE_FORGE_STATE).issues[repo + '#7'].body.split(`## ${section}. `)[1]?.split('\n## ')[0];
    eq(`${tier} 全量重审由 verdict 切待合并，tick 在本人待处理区登记`, [
      ledger?.includes('- [待裁决] acme/loop#10'), result.json.code,
      workflowLabels(readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#10']),
    ], [true, 'REJECT_FUSE_FULL_REVIEW', ['待合并']]);
  }
  const release = 'release';
  write(path.join(config, 'projects', 'release.yaml'), [
    'forge: github', 'defaultTier: L2', 'hubRepo:', '  name: loop', '  repo: acme/loop',
    '  branch: main', 'linkedRepos:', '  - name: web', '    repo: acme/web', `    branch: ${release}`,
    'verification:', '  mode: local-test', '  skipReason: fixture release baseline',
  ].join('\n'));
  const setUp = loopctl(['init', '--req', 'release-baseline', '--project', 'release', '--branch', release,
    '--overrides', '{"autoMerge":true}'], config, fake.env);
  eq('R6/01 关联仓自定义主干作为需求基线时运行态强制关闭自动合并', [
    setUp.json.run.autoMerge, readJson(setUp.json.runPath).autoMerge, setUp.json.confirmSheet[5],
  ], [false, false, '6. 合并方式：全部人工合并（基线是受保护分支）']);
  register({ ...run, repos: [...run.repos, { repo: 'acme/web', branch: release }], branch: release, baselineBranch: release });
  const protectedFacts = headState(['待终审']);
  protectedFacts.prs[repo + '#10'].baseRefName = release;
  resetWithReviews(protectedFacts, review(10, 'protected-first', '打回', { commentId: 1 }),
    review(10, 'protected-second', '打回', { round: 2, commentId: 2 }));
  const risky = startReview('github', 'controller', 'protected-review').json;
  const protectedResult = finishReview('github', risky, '通过', 10, ['--risk', reviewFlags[5].replace('contract=0', 'contract=1')]);
  // The linked repo can also contain unrelated changes, so keep the fixture scoped to the current PR.
  tick('controller');
  const resultFacts = readJson(fake.env.FAKE_FORGE_STATE);
  eq('R6/01 旧运行态即使还写着开启，执行门禁也拒绝向自定义主干合入', [
    protectedResult.json.code, resultFacts.prs[repo + '#10'].state,
  ], ['ENV_BRANCH_FORBIDDEN', 'OPEN']);
  eq('R6/04 基线为保护分支时仍标高风险并作熔断人工裁决登记', [
    workflowLabels(resultFacts.prs[repo + '#10']), resultFacts.issues[repo + '#7'].body.includes('[待裁决]'),
  ], [['风险高', '待合并'], true]);
  register({ ...squad, slot: '主研发' });
  const original = {
    issues: {
      [repo + '#5']: issue(masterBody),
      [repo + '#6']: issue(personal.replace('controller-a', 'controller-b')),
      [repo + '#7']: issue(personal),
      [repo + '#15']: issue('已完成业务', 'CLOSED'),
    },
    prs: {
      [repo + '#8']: withLabels('待终审', '槽位A'),
      [repo + '#9']: withLabels('终审中', '槽位A'),
      [repo + '#10']: withLabels('终审中', '槽位A'),
      [repo + '#11']: withLabels('终审中', '槽位A'),
      [repo + '#12']: withLabels('终审中', '槽位A'),
      [repo + '#13']: { ...withLabels('槽位B'), body: '关联 #6\nDepends-On: #10' },
    },
  };
  Object.assign(original.prs[repo + '#10'], { body: '关联 #7\nDepends-On: #29' });
  original.prs[repo + '#29'] = { ...meta, baseRefName: 'main' };
  resetWithReviews(original,
    review(8, 'history-a', '打回', { at: earlier, commentId: 1 }),
    review(8, 'history-b', '打回', { round: 2, commentId: 2 }),
    review(9, 'replaced', null, { at: earlier }),
    review(10, 'reviewer-a', null),
    review(11, 'first', '打回', { at: earlier, commentId: 2 }),
    review(11, 'second', '打回', { round: 2, commentId: 4 }),
    review(11, 'reviewer-b', null, { round: 3 }),
    review(12, 'reviewer-c', null));
  const verdictFor = (id, session, round = 1, flags = []) => finishReview('github',
    { dispatchId: `fixture-${id}-${session}`, nonce: 'fixture', round, session }, '通过', id, flags);
  const routed = [verdictFor(10, 'reviewer-a'), verdictFor(11, 'reviewer-b', 3),
    verdictFor(12, 'reviewer-c', 1, ['--risk', reviewFlags[5].replace('contract=0', 'contract=1')])];
  eq('L3 verdict 区分依赖未合、熔断和高风险', routed.map(({ json }) => json.code),
    ['DEPENDS_ON_UNMERGED', 'REJECT_FUSE_FULL_REVIEW', 'HIGH_RISK_MANUAL']);
  const l3Waiting = readJson(fake.env.FAKE_FORGE_STATE);
  l3Waiting.prs[repo + '#29'].state = 'MERGED';
  resetForge(l3Waiting);
  const preview = tick('dispatch', now, false);
  ok('调度预览列出全量重审和待重试项且不写入', actions(preview).some((item) => item.kind === 'review-dispatch' && item.fullReReview)
    && actions(preview).some((item) => item.code === 'AUTO_MERGE_RETRY' && item.needsLlm === false)
    && fake.calls().every((call) => !call.args.includes('POST') && !call.args.includes('edit') && !call.args.includes('merge')));
  eq('大巡检独立出判断动作', kinds(tick('lead-patrol')).includes('patrol-review'), true);
  const dispatched = tick('dispatch');
  eq('L3 调度安排独立派审、重试和写评论', [...new Set(kinds(dispatched))].sort(), ['comment-posted', 'retry-merge', 'review-dispatch']);
  const calls = fake.calls();
  const final = readJson(fake.env.FAKE_FORGE_STATE);
  eq('超时退回待终审，低风险重试合入，高风险和熔断待人工', [9, 10, 11, 12].map((id) =>
    workflowLabels(final.prs[repo + '#' + id]).filter((label) => !label.startsWith('槽位'))),
    [['待终审'], ['风险低'], ['待合并'], ['风险高', '待合并']]);
  eq('只重试本机登记等待的候选且带 head SHA', calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge')
    .map((call) => [call.args[2], call.args.at(-1)]), [['10', meta.headRefOid]]);
  const masterUpdate = calls.findLast((call) => call.args[0] === 'issue' && call.args[1] === 'edit')?.args.at(-1);
  eq('总台账有待裁决时只清掉第 2 节的无占位行', [
    masterUpdate?.split('## 2. ')[1]?.split('## 3. ')[0]?.includes('\n- 无\n'),
    masterUpdate?.split('## 4. ')[1]?.includes('\n- 无\n'),
  ], [false, true]);
  ok('调度仅改总台账事实计数和熔断登记，保留人工风险和事项',
    masterUpdate?.includes('1/1 ｜ PR/MR 已合入 1/6') && masterUpdate.includes('[待裁决] acme/loop#11')
    && masterUpdate.includes('整体风险：人工保留') && masterUpdate.includes('- 人工保留的事项')
    && calls.filter((call) => call.args[0] === 'issue' && call.args[1] === 'edit').every((call) => call.args[2] === '5'));
  ok('总台账分别保留调度和大巡检的最近唤醒', masterUpdate?.includes('调度最近唤醒：05-01 12:00')
    && masterUpdate.includes('大巡检最近唤醒：05-01 12:00'));
  ok('调度评论按分流规则签名，含合入和受影响槽位的通知', calls.filter((call) => call.args.includes('POST'))
    .map((call) => JSON.parse(call.stdin).body.split('\n')[0]).includes('巡检脚本 ｜ 主研发 ｜ LOW_RISK_AUTO_MERGE')
    && calls.some((call) => call.stdin.includes('巡检脚本 ｜ 主研发 ｜ BASELINE_CHANGED')));
  const receiptCodes = loopctl(['status', '--json', '--req', run.req], config, fake.env).json.run.recentTicks.dispatch[0]?.actions
    .map((item) => item.code);
  ok('终审当场分流，调度回执保留合入和总台账同步', ['LOW_RISK_AUTO_MERGE', 'REVIEW_FUSE_REGISTERED', 'MASTER_LEDGER_SYNC']
    .every((code) => receiptCodes?.includes(code)));
  eq('基线变更只向真实依赖的槽位发一次，并附真正的合入 SHA', calls.filter((call) => call.stdin.includes('【基线变更】'))
    .map((call) => [call.args.includes('repos/acme/loop/issues/6/comments'), JSON.parse(call.stdin).body.includes('merge-fixture-sha')]), [[true, true]]);
  register({ ...squad, slot: '主研发', changes: [16, 17, 18, 19, 20].map((id) => ({ repo, id })) });
  resetWithReviews({ issues: original.issues, prs: {
    [repo + '#16']: { ...withLabels('终审中'), body: '关联 #999' },
    [repo + '#17']: { ...withLabels('终审中'), body: '关联 #7\nDepends-On: 其他内容' },
    [repo + '#18']: { ...withLabels('终审中'), body: '关联 #15\nDepends-On: 无\nDepends-On: none\nDepends-On:' },
    [repo + '#19']: { ...withLabels('终审中'), state: 'CLOSED', body: 'Depends-On: 废弃' },
    [repo + '#20']: { ...withLabels('终审中'), headRefName: 'main' },
  } }, ...[16, 17, 18, 20].map((id) => review(id, 'reviewer', null)));
  eq('verdict 区分非法关联、非法依赖、有效关联和主干源分支',
    [16, 17, 18, 20].map((id) => verdictFor(id, 'reviewer').json.code),
    ['ISSUE_REF_NOT_IN_RUN', 'DEPENDS_ON_INVALID', 'LOW_RISK_AUTO_MERGE', 'SOURCE_TRUNK_MANUAL_ONLY']);
  const dispatchState = runFile.replace(/\.json$/, '.tick-state.dispatch.json');
  write(dispatchState, '{坏 JSON');
  const isolated = tick('dispatch');
  ok('坏状态当轮说明并重建，废弃单不阻塞调度',
    actions(isolated).some(({ code }) => code === 'TICK_STATE_RESET') && !kinds(isolated).includes('facts-error')
    && Number.isFinite(readJson(dispatchState).baselineCheckedAt));
  eq('验过的合法子单照常合入，非法单、废弃单和主干单不合入',
    fake.calls().filter((call) => call.args[1] === 'merge').map((call) => call.args[2]), ['18']);

  register({ ...squad, slot: '主研发', changes: [16, 17, 31, 32].map((id) => ({ repo, id })) });
  resetWithReviews({ issues: original.issues, prs: {
    [repo + '#16']: { ...withLabels('终审中'), body: '关联 #7\nDepends-On: #29' },
    [repo + '#17']: { ...withLabels('终审中'), body: '关联 #7\nDepends-On: #28' },
    [repo + '#31']: { ...withLabels('终审中'), body: '关联 #7\nDepends-On: #30' },
    [repo + '#32']: { ...withLabels('终审中'), body: '关联 #7' },
    [repo + '#29']: { ...meta, state: 'MERGED', baseRefName: 'main' },
    [repo + '#28']: { ...meta, state: 'CLOSED', baseRefName: 'main' },
    [repo + '#30']: { ...meta, state: 'MERGED', baseRefName: 'main' },
  }, failView: { 30: 'HTTP 502 upstream unavailable' }, failMerge: { 32: 'HTTP 401 Bad credentials' } },
  ...[16, 17, 31, 32].map((id) => review(id, 'reviewer', null)));
  eq('已合依赖准入、已关闭依赖转人工、临时故障等待、凭据问题转人工',
    [16, 17, 31, 32].map((id) => {
      const { json } = verdictFor(id, 'reviewer');
      return [json.state, json.code];
    }), [['merged', 'LOW_RISK_AUTO_MERGE'], ['manual', 'DEPENDS_ON_UNMERGED'], ['waiting', 'EXEC_FAILED'], ['manual', 'EXEC_FAILED']]);
  const platformRecovers = readJson(fake.env.FAKE_FORGE_STATE);
  resetForge({ ...platformRecovers, failView: {}, failMerge: {} });
  eq('Forge 恢复后 tick 只重试临时故障',
    actions(tick('dispatch')).filter(({ code }) => code === 'LOW_RISK_AUTO_MERGE').map(({ refs }) => refs[0].id), [31]);

  // Repro 05: the source gate runs before any review or fuse decision.
  register({ ...squad, slot: '主研发', changes: [33, 34, 35].map((id) => ({ repo, id })) });
  resetWithReviews({ issues: original.issues, prs: {
    [repo + '#33']: { ...withLabels('终审中'), headRefName: 'test' },
    [repo + '#34']: { ...withLabels('待终审'), headRefName: 'test' },
    [repo + '#35']: { ...withLabels('终审中'), headRefName: 'uat' },
  } }, review(35, 'source-first', '打回', { commentId: 151 }),
    review(35, 'source-second', '打回', { round: 2, commentId: 152 }),
    review(35, 'source-third', '通过', { round: 3, commentId: 153 }));
  const envDispatch = startReview('github', 'dispatch', 'source-review', 34);
  const envTick = tick('dispatch');
  const envState = readJson(fake.env.FAKE_FORGE_STATE);
  eq('复现 05 环境源分支先判需修改，包括待终审和已有全量重审结论', [
    envDispatch.json.code, actions(envTick).some(({ kind }) => kind === 'review-dispatch'),
    [33, 34, 35].map((id) => workflowLabels(envState.prs[repo + '#' + id])),
    actions(envTick).filter(({ code }) => code === 'SOURCE_ENV_BRANCH_FORBIDDEN').length,
  ], ['SOURCE_ENV_BRANCH_FORBIDDEN', false, [['需修改'], ['需修改'], ['需修改']], 3]);

  register({ ...run, protectedEnvBranches: ['staging/*'], changes: [{ repo, id: 33 }] });
  resetWithReviews({ issues: original.issues, prs: {
    [repo + '#33']: { ...withLabels('待终审'), headRefName: 'staging/week', body: '关联 #7' },
  } });
  const controllerReject = tick('controller');
  eq('L2 主控先拒绝配置中的环境源分支，无需派审或读取标签事件', [
    actions(controllerReject).filter(({ kind }) => kind === 'review-dispatch').length,
    workflowLabels(readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#33']),
    fake.calls().some((call) => call.args.some((arg) => arg.includes('/issues/33/events'))),
  ], [0, ['需修改'], false]);

  // Repro 03: tag injection cannot authorize cross-demand writes or unrelated issues.
  const otherRun = { ...run, req: 'other-req', baselineBranch: 'loop/other-req', issues: { main: 7 } };
  const otherPath = path.join(config, 'runs', otherRun.req + '.json');
  write(otherPath, JSON.stringify(otherRun));
  register({ ...squad, slot: '主研发', issues: { ...squad.issues, subIssues: [15] }, slots: ['主研发', 'A', 'B'] });
  resetWithReviews({
    issues: { ...original.issues,
      [repo + '#200']: { ...issue('只由变更单引用'), labels: ['需求:tick-demo'] },
      [repo + '#999']: { ...issue('未获认领'), title: '【小台账】Z-outsider', labels: ['槽位Z', '需求:tick-demo'] },
    },
    prs: {
      [repo + '#88']: { ...meta, labels: ['待终审', '需求:other-req'], baseRefName: otherRun.baselineBranch },
      [repo + '#89']: { ...withLabels('终审中'), body: 'Refs #200' },
      [repo + '#90']: { ...withLabels('待终审'), baseRefName: otherRun.baselineBranch },
    },
  }, review(89, 'only-linked-other-issue', null));
  const foreignRecord = forge(['dispatch-review', '--run', otherPath, '--role', 'controller', '--forge', 'github', '--repo', repo,
    '--id', '88', '--head-sha', meta.headRefOid, '--session', 'other-reviewer'], fake.env).json;
  const injected = readJson(fake.env.FAKE_FORGE_STATE);
  // The second label is added after legitimate dispatch on the other demand.
  injected.prs[repo + '#88'].labels.push('需求:tick-demo');
  fake.reset(injected);
  const unrelatedIssue = verdictFor(89, 'only-linked-other-issue');
  const injectionTick = tick('dispatch');
  const otherTick = loopctl(['tick', '--req', otherRun.req, '--role', 'controller', '--now', now, '--apply'], config, fake.env);
  const otherVerdict = forge(['verdict', '--run', otherPath, '--forge', 'github', '--repo', repo, '--id', '88', ...reviewFlags,
    '--dispatch-id', foreignRecord.dispatchId, '--nonce', foreignRecord.nonce, '--session', 'other-reviewer'], fake.env);
  const injectionState = readJson(fake.env.FAKE_FORGE_STATE);
  const discovery = collectFacts(readJson(runFile), fake.env);
  const observedLabels = Object.fromEntries([88, 89, 90].map((id) => [id, workflowLabels(injectionState.prs[repo + '#' + id])]));
  eq('复现 03 双需求标签两边都报告且不写，错误目标不派审，误标 Issue 不授权合并，未认领槽位不拆', [
    observedLabels, otherVerdict.json.code, unrelatedIssue.json.code,
    actions(injectionTick).filter(({ kind }) => kind === 'membership-notice').map(({ code, refs }) => [code, refs[0].id]).sort(),
    actions(otherTick).filter(({ kind }) => kind === 'membership-notice').map(({ code, refs }) => [code, refs[0].id]),
    discovery.subIssues.map(({ id }) => id), discovery.ledgers.some(({ id }) => id === 999),
    injectionState.prs[repo + '#89'].state,
  ], [{ 88: ['终审中'], 89: ['风险低', '待合并'], 90: ['待终审'] }, 'DEMAND_LABEL_CONFLICT', 'ISSUE_REF_NOT_IN_RUN',
    [['CHANGE_WRONG_TARGET', 90], ['DEMAND_LABEL_CONFLICT', 88], ['UNCLAIMED_SLOT_LEDGER', 999]], [['DEMAND_LABEL_CONFLICT', 88]], [15], false, 'OPEN']);

  register({ ...squad, issues: { ...squad.issues, escalation: 30 }, changes: [] });
  const escalationNotes = `repos/${repo}/issues/30/comments`;
  resetForge({ issues: { ...original.issues, [repo + '#30']: issue('升级台账') },
    comments: { [escalationNotes]: [[notice(1, '主控 ｜ A ｜ ctrl\n升级-A-001 ｜ A ｜ 阻断\n问题：待裁决'),
      notice(2, '主控 ｜ B ｜ ctrl-b\n升级-B-001 ｜ B ｜ 阻断\n问题：已裁决'),
      notice(3, '主研发 ｜ 主研发 ｜ lead\n【裁决】升级-B-001 可以继续')]] } });
  const realBlocker = loopctl(['status', '--json', '--req', run.req, '--live'], config, fake.env).json.live;
  eq('L3 实况概览只统计未裁决的 Forge 阻断升级', [
    realBlocker?.overview.totals.blockingEscalations, realBlocker?.actionRequired.filter((item) => item.code === 'ESCALATION_BLOCKING').map((item) => item.ref),
  ], [1, ['升级-A-001']]);

  register({ ...squad, slot: '主研发', issues: { master: 5 }, changes: [] });
  const reverseRepo = 'acme/linked';
  const archivedPersonal = personal.replace('## 4. 近期完成与挂起\n无', '## 4. 近期完成与挂起\n已完成 #15');
  const progressState = {
    issues: {
      ...original.issues,
      [repo + '#7']: { ...issue(archivedPersonal + '\n关联 acme/linked#2'), title: '【小台账】A-dev-a', labels: ['需求:tick-demo', '槽位A'] },
      [repo + '#15']: { ...original.issues[repo + '#15'], labels: ['需求:tick-demo'] },
      [reverseRepo + '#2']: { ...issue('关联 #7'), labels: ['需求:tick-demo'] },
      [repo + '#200']: { ...issue('关联 #5'), labels: ['需求:other-run'] },
    },
    prs: {
      [repo + '#87']: { ...meta, labels: ['终审中'], body: '提及台账 #5' },
      [repo + '#88']: { ...meta, labels: ['终审中'], body: '关联 #200' },
    },
  };
  const withReverse = { ...readJson(runFile), repos: [...squad.repos, { repo: reverseRepo, branch: 'main' }] };
  register(withReverse);
  resetWithReviews(progressState, review(88, 'other-run-review', '通过', { commentId: 2, waiting: true }));
  const members = collectFacts(withReverse, fake.env);
  eq('基线与双向文本提及均不能纳入其他需求，保留显式标记的成员',
    [members.subIssues.map(({ repo, id, state }) => [repo, id, state]), members.changes.map(({ id }) => id)],
    [[[repo, 15, 'closed'], [reverseRepo, 2, 'open']], []]);
  const foreign = forge(['change-merge', '--forge', 'github', '--repo', repo, '--id', '88', '--target', baseline,
    '--head-sha', meta.headRefOid, '--run', runFile], fake.env);
  eq('只有基线和外需求 Issue 引用、缺少本需求标签的 PR 无法合入', [foreign.json.code, readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#88'].state],
    ['CHANGE_NOT_IN_RUN', 'OPEN']);
  tick('dispatch');
  const currentMaster = () => readJson(fake.env.FAKE_FORGE_STATE).issues[repo + '#5'].body;
  includes('总台账统计只包含成员子 Issue', currentMaster(), 'Issue 已完成 1/2');
  resetForge({ issues: { ...original.issues, [repo + '#5']: issue(currentMaster()), [repo + '#7']: issue(personal) } });
  const narrower = tick('dispatch');
  includes('采集范围收窄时仍保留总台账已完成进度', currentMaster(), 'Issue 已完成 1/2');
  const warning = actions(narrower).find((item) => item.code === 'MASTER_PROGRESS_RETAINED');
  ok('保留旧进度有去重说明', warning?.kind === 'comment-posted' && warning?.dedupKey);
  eq('同一份收窄证据重跑不重复评论', actions(tick('dispatch')).filter((item) => item.code === 'MASTER_PROGRESS_RETAINED'), []);
  const mixedLedgers = { ...progressState.issues,
    [repo + '#5']: issue(masterBody.replace('| #6 |', '| #300 |')),
    [repo + '#6']: { ...original.issues[repo + '#6'], title: '【小台账】B-dev-b', labels: ['需求:tick-demo', '槽位B'] } };
  register({ ...squad, changes: [] });
  resetForge({ issues: mixedLedgers });
  const personalTeardown = loopctl(['teardown', '--req', run.req], config, fake.env);
  eq('协作者拆架只读和安排关闭本人小台账，无视总台账备注和他人标签', [
    personalTeardown.json.closingComments?.map(({ key, issue }) => [key, issue.id]),
    fake.calls().filter(({ args }) => args[1] === 'view' && args[0] === 'issue').map(({ args }) => args[2]),
  ], [[['slot:A', 7]], ['5', '7', '15']]);
  const waiting = personal.replace('状态：未开始', '状态：待终审');
  register({ ...squad, issues: { master: 5, 'slot:A': 7 }, changes: [8, 9].map((id) => ({ repo, id })) });
  const waitingState = { issues: { ...original.issues, [repo + '#7']: issue(waiting) },
    prs: { [repo + '#8']: withLabels('需修改', '槽位A'), [repo + '#9']: withLabels('待终审', '槽位A') } };
  resetForge(waitingState);
  ok('待终审时名下 PR 变为需修改也唤醒主控', actions(tick('controller')).some((item) => item.code === 'PR_NEEDS_CHANGES'));
  eq('主控仍空闲且 PR 需修改，下一轮也继续做', actions(tick('controller', '2024-05-01T04:30:00Z'))
    .some(({ code }) => code === 'PR_NEEDS_CHANGES'), true);
  resetForge({ ...waitingState, prs: { ...waitingState.prs, [repo + '#8']: { ...withLabels('槽位A'), state: 'MERGED', mergedAt: earlier } } });
  eq('仍有一单在排队时，名下另一单合入后每轮可继续核验', [
    actions(tick('controller', '2024-05-01T05:00:00Z')).filter(({ kind }) => kind === 'controller').map(({ code }) => code),
    actions(tick('controller', '2024-05-01T05:10:00Z')).map(({ code }) => code),
  ], [['PR_MERGED_NEXT_STEP'], ['PR_MERGED_NEXT_STEP']]);
  const reviewed = { ...waitingState, prs: { [repo + '#8']: withLabels('终审中', '槽位A'), [repo + '#9']: withLabels('待终审', '槽位A') } };
  resetWithReviews(reviewed, review(8, 'reviewer', '通过', { commentId: 21 }));
  ok('L3 主控收到名下 PR 的终审结论待办', actions(tick('controller', '2024-05-01T05:30:00Z')).some((item) => item.code === 'NEW_REVIEW_VERDICT'));
  eq('同一终审结论未处理，仍可推进', actions(tick('controller', '2024-05-01T06:00:00Z'))
    .some(({ code }) => code === 'NEW_REVIEW_VERDICT'), true);

  register({ ...squad, issues: { master: 5, 'slot:A': 7, escalation: 30, subIssues: [15, 16] } });
  const closedOut = waiting.replace('## 4. 近期完成与挂起\n无', `## 4. 近期完成与挂起\n已完成 ${repo}#8`);
  const slotFacts = {
    issues: { [repo + '#5']: issue(masterBody), [repo + '#7']: issue(closedOut), [repo + '#30']: issue('升级台账'),
      [repo + '#15']: { ...issue('接口'), labels: ['槽位A'] }, [repo + '#16']: { ...issue('前端'), labels: ['槽位B'] } },
    prs: { [repo + '#60']: { ...withLabels('槽位B', '需修改'), body: '完成 #16，联调 #15' } },
  };
  resetWithReviews(slotFacts);
  const controllerCodes = (date) => actions(tick('controller', date)).filter(({ kind }) => kind === 'controller').map(({ code }) => code);
  eq('R5/07 B 槽位 PR 即使引用 A 的 Issue 也不会让 A 处理', controllerCodes('2024-05-01T06:05:00Z'), []);
  slotFacts.issues[repo + '#15'].labels.push('bug');
  resetWithReviews(slotFacts);
  eq('R5/05 L3 等待终审也可推进自己未指派的缺陷', actions(tick('controller', '2024-05-01T06:10:00Z'))
    .find(({ code }) => code === 'SELF_IDLE_START')?.refs.map(({ id }) => id), [15]);
  slotFacts.issues[repo + '#15'].state = 'CLOSED';
  slotFacts.comments = { [escalationNotes]: [[notice(9010, '主研发 ｜ 主研发 ｜ lead\n【裁决】升级-A-001 可以执行')]] };
  resetWithReviews(slotFacts);
  eq('本人槽位裁决和本人台账普通意见可继续处理', controllerCodes('2024-05-01T06:15:00Z'), ['UNREPLIED_COMMENT']);
  slotFacts.comments[ledgerNotes] = [[notice(9011, '同一 Forge 账号的用户补充了验收条件')]];
  slotFacts.prs[repo + '#8'] = { ...withLabels('槽位A'), state: 'MERGED', mergedAt: earlier };
  slotFacts.comments[changeNotes(8)] = [[notice(9012, '验收同学补充了回归结果')]];
  resetWithReviews(slotFacts);
  eq('普通外部意见也带稳定的回执待办引用', actions(tick('controller', '2024-05-01T06:35:00Z'))
    .find(({ code }) => code === 'UNREPLIED_COMMENT')?.refs.map(({ commentId }) => commentId).sort(), [9010, 9011, 9012]);
  const synced = readJson(fake.env.FAKE_FORGE_STATE);
  const reply = (parent) => notice(parent + 100, `主控 ｜ A ｜ controller-a\n已执行\n<!-- liteloop:reply-to=${parent} -->`);
  for (const [endpoint, id] of [[escalationNotes, 9010], [ledgerNotes, 9011], [changeNotes(8), 9012]]) {
    synced.comments[endpoint][0].push(reply(id));
  }
  synced.issues[repo + '#15'].labels = ['槽位A'];
  synced.prs[repo + '#8'].body = 'Closes #15';
  synced.issues[repo + '#5'].body = masterBody.replace('Issue 已完成 0/0', 'Issue 已完成 1/2')
    .replace('| B | dev-b | 测试', '| B | dev-b | 验收');
  resetWithReviews(synced);
  eq('评论已回执，其他槽位的进度更新不唤醒', controllerCodes('2024-05-01T06:45:00Z'), []);

  const nightState = {
    issues: { [repo + '#7']: issue(personal) },
    prs: { [repo + '#8']: { ...withLabels(), updatedAt: earlier } },
  };
  register({ ...run, changes: [{ repo, id: 8 }], thresholds: { mrIdleWarnHours: 1 } });
  resetForge(nightState);
  const nightTick = tick('patrol', '2024-05-02T15:30:00Z');
  const nightWrites = fake.calls().filter(({ args }) => args.includes('POST') || args[1] === 'edit');
  eq('夜间压单只更新心跳，没有评论或汇报', [
    kinds(nightTick).filter((kind) => kind === 'comment-posted' || kind === 'user-report'),
    nightWrites.map(({ args }) => [args[0], args[1]]),
  ], [[], [['issue', 'edit']]]);
  const morningTick = tick('patrol', '2024-05-03T01:30:00Z');
  const secondMorning = tick('patrol', '2024-05-03T02:00:00Z');
  eq('次日首轮补写压单评论、补报一次，第二轮不重复', [
    actions(morningTick).some(({ kind, code }) => kind === 'comment-posted' && code === 'MR_IDLE_WARN'),
    actions(morningTick).filter(({ kind, refs }) => kind === 'user-report' && refs.some(({ code }) => code === 'MR_IDLE_WARN')).length,
    actions(secondMorning).filter(({ kind, refs, code }) => code === 'MR_IDLE_WARN' || (kind === 'user-report' && refs.some((ref) => ref.code === 'MR_IDLE_WARN'))),
  ], [true, 1, []]);
  const repeatedIdle = actions(tick('patrol', '2024-05-03T05:30:00Z'));
  eq('R5/13 压单未解决时，达到确认时限再次提醒，Forge 评论仍只发一次', [
    repeatedIdle.some(({ kind, refs }) => kind === 'user-report' && refs.some(({ code }) => code === 'MR_IDLE_WARN')),
    repeatedIdle.some(({ kind, code }) => kind === 'comment-posted' && code === 'MR_IDLE_WARN'),
  ], [true, false]);

  register({ ...squad, slot: '主研发', issues: { master: 5, 'slot:A': 7 }, changes: [], thresholds: { p3SilentMaxHours: 4 } });
  resetWithReviews({ issues: { [repo + '#5']: issue(masterBody.replace('当前阶段：P3', '当前阶段：P3 ｜ 阶段开始：05-01 09:00')),
    [repo + '#7']: issue(personal) } });
  eq('R5/13 P3 无 PR、Issue 或升级串时从阶段开始算静默', actions(tick('lead-patrol', '2024-05-01T08:00:00Z'))
    .some(({ code, refs }) => code === 'P3_SILENT' || refs.some((ref) => ref?.code === 'P3_SILENT')), true);

  register({ ...run, thresholds: { confirmTimeoutHours: 1 } });
  const awaiting = personal.replace('- 无', '- [待确认] 请确认拆分');
  resetForge({ issues: { [repo + '#7']: issue(awaiting) } });
  const reportKinds = (date) => kinds(tick('patrol', date)).filter((item) => ['user-report', 'patrol-review'].includes(item));
  eq('非工作时段不弹巡检判断和本人事项', reportKinds('2024-05-02T00:30:00Z'), []);
  eq('进入工作时段仍收到非工作时段积累的巡检变化与待办', reportKinds('2024-05-02T01:00:00Z'), ['patrol-review', 'user-report']);
  eq('同一待办未达间隔不重复报告', reportKinds('2024-05-02T01:30:00Z'), []);
  eq('到确认超时后提醒一次', reportKinds('2024-05-02T02:00:00Z'), ['user-report']);
  eq('按配置间隔再次提醒，间隔内保持安静', [
    reportKinds('2024-05-02T02:30:00Z'), reportKinds('2024-05-02T03:00:00Z'),
  ], [[], ['user-report']]);

  resetForge({ issues: { [repo + '#7']: issue(personal.replace('05-01 12:00', '2024-05-02T18:00:00+08:00')) } });
  write(runFile.replace(/\.json$/, '.tick-state.controller.json'), JSON.stringify({
    owner: 'controller-a', lastWake: '2024-05-02T15:30:00+08:00',
  }));
  ok('较晚的 Forge 心跳优先于本机旧记录，不报失联',
    actions(tick('patrol', '2024-05-02T10:30:00Z')).every((item) => item.code !== 'CONTROLLER_DISCONNECTED'));



}

function scenarioDrillRegressions(tmp) {
  group('实战演练回归');
  const config = path.join(tmp, 'config');
  const fake = makeFakeForge(path.join(tmp, 'forge'));
  const repo = 'acme/drill';
  const now = '2024-05-01T04:00:00Z';
  const tick = (req, role, ...args) => loopctl(['tick', '--req', req, '--role', role, '--now', now, '--apply', ...args], config, fake.env);
  const runFile = (req) => path.join(config, 'runs', req + '.json');
  const issue = (body, fields = {}) => ({ body, labels: [], state: 'OPEN', updatedAt: now, ...fields });
  const actions = (result) => result.json.runs?.[0].actions ?? [];
  const run = { req: 'squad', tier: 'L3', slot: 'A', user: 'dev-a', forge: 'github',
    hubRepo: { repo }, repos: [{ repo, branch: 'main' }], baselineBranch: 'loop/squad',
    issues: { master: 18, 'slot:A': 25 }, controller: { sessionId: 'member-a' } };
  write(runFile(run.req), JSON.stringify(run));
  const masterNotes = `repos/${repo}/issues/18/comments`;
  const personal = '## 1. 基本信息\n主控：第 1 任 ｜ member-a\n本轮：空闲\n最近唤醒：05-01 12:00\n';
  const slotLedger = (slot) => issue(personal, { title: `【小台账】${slot}-显示名`, labels: ['需求:squad', '槽位' + slot] });
  const registeredSquad = withSlotBindings({ issues: {
    [repo + '#18']: issue('## 1. 整体状态\n## 3. 各开发者\n| 主研发 | 负责人 | 开发 | 无 | #19 |\n| A | 成员 A | 开发 | 无 | #25 |',
      { author: { login: 'lead-dev' } }),
    [repo + '#19']: slotLedger('主研发'),
    [repo + '#25']: slotLedger('A'),
    [repo + '#26']: slotLedger('B'),
  } }, masterNotes, slotBinding(1001, 'A', 'dev-a', 'member-a', now));
  fake.reset(registeredSquad);
  const snapshots = loopctl(['status', '--req', run.req, '--live', '--json'], config, fake.env).json.live?.forgeFacts;
  eq('R28 无绑定评论的主研发按总台账作者识别', [
    snapshots?.slotClaims.find(({ slot }) => slot === '主研发')?.user,
    snapshots?.ledgers.find(({ key }) => key === 'slot:主研发')?.id,
  ], ['lead-dev', 19]);
  const memberRound = tick(run.req, 'controller');
  eq('R28 协作者空闲无关待办时安静退出', [
    memberRound.code, memberRound.stdout === '', memberRound.stderr,
    actions(memberRound).map(({ code, refs }) => [code, refs[0].id]),
  ], [0, true, '', []]);
  eq('R28 小巡检不提醒其他未认领槽位', actions(tick(run.req, 'patrol'))
    .filter(({ code }) => code === 'UNCLAIMED_SLOT_LEDGER').map(({ refs }) => refs[0].id), []);
  fake.reset({ ...registeredSquad, comments: {} });
  eq('R28 本槽位未认领仍提醒', actions(tick(run.req, 'controller'))
    .filter(({ code }) => code === 'UNCLAIMED_SLOT_LEDGER').map(({ refs }) => refs[0].id), [25]);

  setupConfig(tmp, { 'drill.yaml': simpleProject({ forge: 'github', tier: 'L2', name: 'drill', repo, repoPath: tmp }) });
  const handoffReq = 'handoff';
  const initialized = loopctl(['init', '--req', handoffReq, '--project', 'drill', '--session', 'old-controller',
    '--issue-map', '{"main":"#14","story1":"#15"}'], config, fake.env);
  const controllerDescription = (result) => result.json.scheduledTasks?.find(({ role }) => role === 'controller')?.description;
  ok('R29 初始化的主控唤醒命令绑定任务会话', controllerDescription(initialized)?.includes('--session old-controller'));
  const beforeHandoff = [
    '## 1. 基本信息', '阶段：P3 ｜ 状态：未开始', '主控：第 1 任 ｜ old-controller',
    '本轮：空闲', '最近唤醒：05-01 11:55', '## 2. 需本人处理', '- 无',
  ].join('\n');
  fake.reset({ issues: { [repo + '#14']: issue(beforeHandoff), [repo + '#15']: issue('待推进') } });
  const afterHandoff = beforeHandoff.replace('第 1 任 ｜ old-controller', '第 2 任 ｜ new-controller');
  forge(['issue-update', '--forge', 'github', '--repo', repo, '--id', '14', '--body', afterHandoff,
    '--handoff', '--expect-owner', 'new-controller', '--config-dir', config], fake.env);
  const ledgerBody = () => readJson(fake.env.FAKE_FORGE_STATE).issues[repo + '#14'].body;
  const localFiles = () => fs.readdirSync(path.dirname(runFile(handoffReq))).filter((name) => name.startsWith(handoffReq)).sort();
  const stale = tick(handoffReq, 'controller', '--session', 'old-controller');
  eq('R29 旧主控唤醒只收到删除任务的指令，台账和本机记录保持原样', [
    actions(stale).map(({ code }) => code), actions(stale)[0]?.reason?.includes('第 2 任接替') ?? false,
    actions(stale)[0]?.reason?.includes('删除本会话的主控定时任务') ?? false,
    ledgerBody() === afterHandoff, localFiles(),
  ], [['SUPERSEDED'], true, true, true, ['handoff.json']]);
  const current = tick(handoffReq, 'controller', '--session', 'new-controller');
  eq('R29 现任主控照常刷新心跳并收到可推进事项', [
    actions(current).find(({ code }) => code === 'SELF_IDLE_START')?.sessionId,
    ledgerBody() !== afterHandoff,
  ], ['new-controller', true]);
  const resume = (...extra) => loopctl(['init', '--req', handoffReq, '--resume', ...extra], config, fake.env);
  const wrongOwner = resume('--session', 'old-controller');
  const resumed = resume('--session', 'new-controller');
  eq('R29 接任后从已有命令读取绑定新会话的任务描述', [
    wrongOwner.json.code, resumed.code, controllerDescription(resumed)?.includes('--session new-controller'),
    controllerDescription(resume())?.includes('--session new-controller'),
  ], ['OWNER_CHANGED', 0, true, true]);

  const merged = {
    state: 'MERGED', headRefOid: 'a'.repeat(40), baseRefName: 'loop/handoff', headRefName: 'dev/feature',
    body: '关联 #15', updatedAt: now, createdAt: now, mergedAt: now,
    labels: ['需求:handoff', '待终审', '终审中', '待合并', '需修改', '风险高', '自定义'],
  };
  fake.reset({ issues: { [repo + '#14']: issue(afterHandoff), [repo + '#15']: issue('已完成', { state: 'CLOSED' }) },
    prs: { [repo + '#16']: merged } });
  const labelsOf = (id) => readJson(fake.env.FAKE_FORGE_STATE).prs[repo + '#' + id].labels;
  const commentWrites = () => fake.calls().filter(({ args }) => args.includes('POST')).length;
  const cleanup = tick(handoffReq, 'controller');
  eq('R30 主控摘除人工合入 PR 的四种审查标签，不唤醒模型或发评论', [
    labelsOf(16), actions(cleanup).filter(({ needsLlm }) => needsLlm).length, commentWrites(),
  ], [['需求:handoff', '风险高', '自定义'], 0, 0]);

  write(runFile(run.req), JSON.stringify({ ...run, slot: '主研发', user: 'lead-dev',
    issues: { master: 18, 'slot:主研发': 19 } }));
  fake.reset({ ...registeredSquad, prs: { [repo + '#27']: {
    ...merged, baseRefName: run.baselineBranch, labels: ['需求:squad', '待合并', '风险低'],
  } } });
  const dispatchCleanup = tick(run.req, 'dispatch');
  eq('R30 L3 调度摘除已合入 PR 的待合并标签，不唤醒模型或发评论', [
    labelsOf(27), actions(dispatchCleanup).filter(({ needsLlm }) => needsLlm).length, commentWrites(),
  ], [['需求:squad', '风险低'], 0, 0]);

  const isoLedger = afterHandoff.replace('05-01 11:55', '2024-05-01T11:55:30+08:00');
  fake.reset({ issues: { [repo + '#14']: issue(isoLedger), [repo + '#15']: issue('已完成', { state: 'CLOSED' }) } });
  const normalizedWake = tick(handoffReq, 'controller');
  eq('R31 台账已有 ISO 心跳时按 MM-DD HH:mm 刷新并安静退出', [
    ledgerBody().match(/^最近唤醒：(.*)$/m)?.[1], normalizedWake.code, normalizedWake.stdout,
  ], ['05-01 12:00', 0, '']);
}

function scenarioTickComments(tmp) {
  group('11. 巡检机械评论去重、归属证明与模型提醒');
  const config = path.join(tmp, 'config');
  const fake = makeFakeForge(path.join(tmp, 'forge'));
  const req = 'mechanical';
  const repo = 'acme/loop';
  const baseline = 'loop/mechanical';
  const now = '2024-05-01T04:00:00Z';
  const runFile = path.join(config, 'runs', req + '.json');
  const tick = (role, apply = true) => loopctl(['tick', '--req', req, '--role', role, '--now', now, ...(apply ? ['--apply'] : [])], config, fake.env);
  const actions = (result) => result.json.runs?.[0].actions ?? [];
  const note = (id, body) => ({ id, body, created_at: now, user: { login: 'dev-a' }, author: { username: 'dev-a' } });
  const issue = (body) => ({ body, state: 'OPEN', updatedAt: now, labels: [] });
  const personal = '## 1. 基本信息\n主控：第 1 任 ｜ dev-a-c\n阶段：P2 ｜ 基于契约：v1\n本轮：空闲\n最近唤醒：05-01 12:00\n';
  const master = [
    '## 1. 整体状态', '当前阶段：P2', '## 2. 待主研发处理', '- 无', '## 3. 各开发者',
    '| A | dev-a | 开发 | 无 | #7 |', '## 4. 契约与归属', '契约版本：v2',
    '文件归属表 → #16', '', '## 5. 阶段节点', 'P2 进行中',
  ].join('\n');
  const ownership = ['| 文件路径 | 归属槽位 | 热点 |', '| --- | --- | --- |', '| src/shared.js | B | 否 |', '| src/hot.js | A | 是 |'].join('\n');
  const run = {
    req, tier: 'L3', slot: 'A', user: 'dev-a', forge: 'github', hubRepo: { repo }, repos: [{ repo, branch: 'main' }], baselineBranch: baseline,
    issues: { master: 6, 'slot:A': 7 }, changes: [8, 9, 10].map((id) => ({ repo, id })), controller: { sessionId: 'dev-a-c' },
  };
  write(runFile, JSON.stringify(run));
  const change = { state: 'OPEN', headRefOid: 'aabbcc123456', baseRefName: baseline, headRefName: 'dev/change', updatedAt: now, createdAt: now, labels: ['槽位A', '需求:mechanical'], body: '关联 #7' };
  fake.reset(withSlotBindings({
    issues: { [repo + '#6']: issue(master), [repo + '#7']: issue(personal), [repo + '#16']: issue(ownership) },
    prs: {
      [repo + '#8']: change,
      [repo + '#9']: { ...change, state: 'MERGED', headRefName: 'test', mergedBy: { login: 'dev-a' } },
      [repo + '#10']: { ...change, state: 'MERGED', baseRefName: 'main', mergedBy: { login: 'human' } },
    },
    changeFiles: {
      ['repos/' + repo + '/pulls/8/files']: [
        { filename: 'src/shared.js', status: 'modified', patch: '@@ -1,3 +1,3 @@\n old\n-replace\n+new\n last' },
        { filename: 'src/hot.js', status: 'modified', patch: '@@ -1,2 +1,3 @@\n old\n last\n+末尾追加' },
      ],
    },
    comments: {
      ['repos/' + repo + '/issues/9/comments']: [[note(90, '主研发调度 ｜ 主研发 ｜ old-dispatch\n终审通过｜风险低｜自动合并')]],
      ['repos/' + repo + '/issues/10/comments']: [[note(91, '主研发调度 ｜ 主研发 ｜ old-dispatch\n终审通过｜风险低｜自动合并')]],
    },
  }, 'repos/acme/loop/issues/6/comments', slotBinding(8001, 'A', 'dev-a', 'dev-a-c')));
  const posts = () => fake.calls().filter((call) => call.args.includes('POST'));
  const preview = tick('patrol', false);
  eq('巡检预览列出机械问题但不写评论', [actions(preview).filter((item) => item.planned === 'comment').map((item) => item.code).sort(), posts().length],
    [['CONTRACT_LAG', 'LEDGER_STRUCTURE', 'OWNED_LINES_CHANGED'], 0]);
  ok('归属佐证从总台账所指的真实 Forge Issue 正文读取', fake.calls().some((call) => call.args[0] === 'issue' && call.args[2] === '16'));
  const first = tick('patrol');
  eq('首轮巡检为破节、契约落后、改他人已有行各写一条', actions(first).filter((item) => item.kind === 'comment-posted').map((item) => [item.code, item.needsLlm]).sort(), [
    ['CONTRACT_LAG', false], ['LEDGER_STRUCTURE', false], ['OWNED_LINES_CHANGED', false],
  ]);
  ok('专用签名和去重键齐全，末尾追加不触发', posts().every((call) => /^巡检脚本 ｜ A ｜ (?:CONTRACT_LAG|LEDGER_STRUCTURE|OWNED_LINES_CHANGED)\n【纠偏】/.test(JSON.parse(call.stdin).body)
    && /<!-- liteloop:key=patrol:acme\/loop#\d+:[\da-f]+ -->/.test(JSON.parse(call.stdin).body))
    && posts().some((call) => call.stdin.includes('src/shared.js') && !call.stdin.includes('src/hot.js')));
  ok('机械评论正文首句来自登记表', posts().every((call) => {
    const [signature, summary] = JSON.parse(call.stdin).body.split('\n');
    const code = signature.split(' ｜ ').at(-1);
    return summary === `【纠偏】${describeAction({ code })}。`;
  }));
  eq('第二次小巡检不会重复写同一机械提醒', [posts().length, actions(tick('patrol')).filter((item) => item.kind === 'comment-posted').length, posts().length], [3, 0, 3]);
  const lead = tick('lead-patrol');
  eq('大巡检根据已记录的调度合并和 Forge 实况纠偏，不归责人工合并', actions(lead)
    .filter((item) => item.code === 'DISPATCH_UNAUTHORIZED_MERGE').map((item) => item.refs[0].id), [9]);
  const written = posts().length;
  eq('第二次大巡检也不重复发评论', [actions(tick('lead-patrol')).filter((item) => item.kind === 'comment-posted').length, posts().length], [0, written]);
  const status = loopctl(['status', '--json', '--req', req, '--live'], config, fake.env).json;
  eq('status 展示本机脚本回执和 Forge 现存评论，带评论 ID 与签名', [
    status.run.scriptComments.length, status.live.scriptComments.length,
    status.live.scriptComments.every((item) => item.commentId && item.signature.startsWith('巡检脚本 ｜ ')),
  ], [written, written, true]);
  const same = loopctl(['preview-init', '--req', 'model-warning', '--project', 'model', '--tier', 'L3', '--overrides',
    JSON.stringify({ forge: 'github', hubRepo: repo, roleModels: { controller: 'codex/gpt-6.2-sol', patrol: 'openai/gpt-5', leadPatrol: 'anthropic/claude-opus' } })], config);
  eq('同厂商只提醒对应巡检角色，确认单照常生成', [same.code, same.json.warnings.filter((item) => item.includes('同为')).map((item) => item.slice(0, 3))], [0, ['小巡检']]);
}

function scenarioTeardownMisoperations(tmp) {
  group('拆架核实需求成员、裁决和 worktree');
  const config = path.join(tmp, 'config');
  const fake = makeFakeForge(path.join(tmp, 'forge'));
  const repo = 'acme/teardown';
  const req = 'misoperations';
  const at = '2024-05-01T01:00:00Z';
  const baselineBranch = 'loop/misoperations';
  const file = path.join(config, 'runs', req + '.json');
  const issue = (body, labels = [`需求:${req}`]) => ({ body, labels, state: 'OPEN', updatedAt: at });
  const change = { state: 'OPEN', labels: [`需求:${req}`], baseRefName: baselineBranch,
    headRefName: 'dev/example', headRefOid: 'b'.repeat(40), updatedAt: at, body: '关联 #7' };
  const masterBody = '## 1. 整体状态\n当前阶段：P2\n## 2. 待主研发处理\n- 无\n## 3. 各开发者\n| A | 显示名 | 开发 | 无 | #8 |\n';
  const masterNotes = `repos/${repo}/issues/5/comments`;
  const run = { req, tier: 'L3', forge: 'github', slot: '主研发', user: 'lead', hubRepo: { repo },
    repos: [{ repo, branch: 'main' }], baselineBranch, slots: ['主研发', 'A'], issues: { master: 5, 'slot:主研发': 7 } };
  const state = withSlotBindings({ issues: {
    [repo + '#5']: issue(masterBody), [repo + '#7']: issue('本人台账'),
    [repo + '#8']: { ...issue('协作者台账', [`需求:${req}`, '槽位A']), title: '【小台账】A-显示名' },
  } }, masterNotes, slotBinding(100, 'A', 'dev-a', 'session-old', at));
  const save = (payload = run) => write(file, JSON.stringify(payload));
  const teardown = (...args) => loopctl(['teardown', '--req', req, ...args], config, fake.env);
  save();
  fake.reset(state);
  eq('R5/04 确认认领人按 Forge 登录名，小台账标题可用显示名', teardown().json.closingComments?.map(({ issue }) => issue.id), [5, 7, 8]);
  const ambiguous = structuredClone(state);
  ambiguous.issues[repo + '#5'].labels.push('需求:other');
  ambiguous.issues[repo + '#7'].state = 'CLOSED';
  ambiguous.prs = { [repo + '#10']: { ...change, labels: [...change.labels, '需求:other'] } };
  ambiguous.comments[masterNotes][0].push({
    id: 101, user: { login: 'dev-a' }, created_at: '2024-05-01T02:00:00Z',
    body: `主控 ｜ A ｜ session-new\n【配置变更】撤回绑定：槽位A｜原评论链接 https://github.com/${repo}/issues/5#issuecomment-100`,
  });
  fake.reset(ambiguous);
  const rejected = teardown('--finalize', '--results', '{"receipts":{"A":{"unclaimed":true}}}');
  eq('R5/02 双需求标签的总台账与 PR、取消绑定但仍打开的小台账均阻止归档', [
    rejected.json.status, rejected.json.blocked?.map(({ id }) => id).sort((a, b) => a - b), fs.existsSync(file),
  ], ['blocked', [5, 8, 10], true]);

  const l2 = { ...run, tier: 'L2', issues: { main: 7 }, slots: undefined };
  save(l2);
  fake.reset({ issues: { [repo + '#7']: issue('主台账') }, prs: { [repo + '#10']: { ...change, baseRefName: 'loop/other' } } });
  const status = loopctl(['status', '--req', req], config, fake.env);
  const wrongTarget = teardown();
  eq('R5/03 成员 PR 目标写错时 status 给出正确基线，拆架列为未结', [
    status.stdout.includes('目标分支为 loop/other，请改为需求基线 loop/misoperations'),
    wrongTarget.json.blocked?.map(({ kind, id }) => [kind, id]),
  ], [true, [['change', 10]]]);

  save({ ...run, issues: { master: 5, escalation: 6 }, slots: ['主研发', 'A', 'fe-1'] });
  fake.reset({ issues: { [repo + '#5']: issue(masterBody), [repo + '#6']: issue('升级台账') },
    comments: { [`repos/${repo}/issues/6/comments`]: [[
      { id: 110, created_at: at, body: '主控 ｜ A ｜ a\n升级-A-001 ｜ A ｜ 阻断\n问题：字段可否为空' },
      { id: 111, created_at: at, body: '主控 ｜ fe-1 ｜ f\n升级-fe-1-001 ｜ fe-1 ｜ 阻断\n问题：统一字段名' },
    ]] },
  });
  const reply = (id, body) => forge(['reply', '--forge', 'github', '--kind', 'issue', '--repo', repo, '--id', '6',
    '--reply-to', String(id), '--body', `主研发 ｜ 主研发 ｜ lead\n【裁决】${body}`], fake.env);
  eq('R5/09 阻断未裁决时拒绝拆架', teardown().json.blocked?.map(({ ref }) => ref), ['升级-A-001', '升级-fe-1-001']);
  reply(110, '字段可空，槽位 A 执行');
  reply(111, '升级-fe-1-001：统一字段名');
  const largePatrol = loopctl(['tick', '--req', req, '--role', 'lead-patrol', '--apply', '--now', '2024-05-01T08:00:00Z'],
    config, fake.env);
  eq('R5/09 reply 关联原评论和带连字符的槽位都解除阻断', [
    teardown().json.status, largePatrol.json.runs?.[0]?.actions?.some(({ code, refs }) =>
      code === 'BLOCK_ESCALATE' || refs.some((ref) => ref?.code === 'BLOCK_ESCALATE')),
  ], ['planned', false]);

  const worktree = path.join(tmp, 'temporary-worktree');
  fs.mkdirSync(worktree);
  git(['init', '-q', '-b', 'main'], worktree);
  write(path.join(worktree, 'code.txt'), 'first version\n');
  const initial = commitFixture(worktree, 'main', 'initial');
  write(path.join(worktree, 'code.txt'), 'cleaned up\n');
  save({ ...l2, worktrees: [worktree] });
  const worktreeFacts = { issues: { [repo + '#7']: issue('主台账') } };
  fake.reset(worktreeFacts);
  const dirty = teardown().json.worktrees?.[0]?.dirty;
  commitFixture(worktree, 'main', 'finish local work', initial);
  const clean = teardown().json.worktrees?.[0]?.dirty;
  worktreeFacts.issues[repo + '#7'].state = 'CLOSED';
  fake.reset(worktreeFacts);
  fs.rmSync(worktree, { recursive: true, force: true });
  const archived = teardown('--finalize', '--results', JSON.stringify({ worktrees: { [worktree]: { removed: true } } }));
  eq('R5/10 重新实查 worktree 清洁后，删除并归档不要求丢弃改动回执', [dirty, clean, archived.json.status], [true, false, 'archived']);
}

function scenarioOutbox(tmp) {
  group('12. 出站队列确认、时段、送达去重、失败与日报');
  const config = path.join(tmp, 'config');
  const lark = path.join(tmp, 'fake-lark.mjs');
  const larkLog = path.join(tmp, 'lark-calls.jsonl');
  write(lark, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_LARK_FAIL === 'true') {
  console.error(JSON.stringify({ ok: false, error: { code: 'fixture-denied' } }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, data: { message_id: 'om_fixture' } }));
`);
  fs.chmodSync(lark, 0o755);
  write(larkLog, '');
  const sends = () => fs.readFileSync(larkLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const env = { LARK_CLI_BIN: lark, FAKE_LARK_LOG: larkLog };
  const save = (run) => write(path.join(config, 'runs', run.req + '.json'), JSON.stringify(run));
  const queue = (run) => readJson(path.join(config, 'runs', run.req + '.outbox.json'));
  const early = '2024-05-01T00:00:00Z';
  const morning = '2024-05-01T02:15:00Z';
  const late = '2024-05-01T15:00:00Z';
  const repo = 'acme/outbox';
  const groupRun = {
    req: 'notify-team', tier: 'L3', forge: 'github', hubRepo: { repo }, repos: [{ repo, branch: 'main' }], baselineBranch: 'loop/notice',
    user: 'lead', notify: { feishuGroupChatId: 'oc_demo_group', externalMentionWindow: '10:00-18:00' },
  };
  save(groupRun);
  const notify = (verb, args, at = morning, fail = false) =>
    loopctl(['notify', verb, ...args, '--now', at], config, { ...env, FAKE_LARK_FAIL: String(fail) });
  const enqueue = (run, kind, key, at = morning, extra = []) =>
    notify('enqueue', ['--req', run.req, '--kind', kind, '--dedup', key, '--text', '测试消息', ...extra], at).json;
  const flush = (run, at, fail) => notify('flush', ['--req', run.req], at, fail).json.runs?.[0]?.actions ?? [];
  const first = enqueue(groupRun, 'alert', 'alert:scope:delay', early);
  eq('群消息入队计算外部时段 notBefore，入队不发送', [first.event.status, first.event.notBefore, sends().length],
    ['pending', '2024-05-01T10:00:00+08:00', 0]);
  const duplicate = enqueue(groupRun, 'alert', 'alert:scope:delay');
  eq('未送达同键可继续投递，保留原事件和原时间窗', [duplicate.duplicate, duplicate.event.id, duplicate.event.notBefore, queue(groupRun).length],
    [false, first.event.id, first.event.notBefore, 1]);
  eq('到 notBefore 前 flush 不调用 lark-cli', [flush(groupRun, early), sends().length], [[], 0]);
  eq('到 notBefore 后错过推送窗则顺延次日，夜间不调用 lark-cli',
    [flush(groupRun, late), queue(groupRun)[0].notBefore, sends().length], [[], '2024-05-02T10:00:00+08:00', 0]);
  const delivered = flush(groupRun, '2024-05-02T02:00:00Z');
  eq('进入窗口后使用 bot 群发送并持久化成功回执', [
    delivered.map((action) => [action.kind, action.needsLlm]), queue(groupRun)[0].messageId, sends()[0]?.slice(0, 6),
  ], [[['notify-sent', false]], 'om_fixture', ['im', '+messages-send', '--as', 'bot', '--chat-id', 'oc_demo_group']]);
  const moved = { ...groupRun, notify: { ...groupRun.notify, feishuGroupChatId: 'oc_other_group' } };
  save(moved);
  eq('改群后旧事项去重且不重发', [enqueue(moved, 'alert', 'alert:scope:delay').duplicate, flush(moved, morning), sends().length], [true, [], 1]);
  save(groupRun);

  const contract = enqueue(groupRun, 'contract-sync', 'contract:v2');
  eq('契约同步未显式写确认参数仍进入 awaiting-confirm，flush 只报待确认', [
    contract.event.status, flush(groupRun, morning).map((action) => action.kind), sends().length,
  ], ['awaiting-confirm', ['notify-awaiting-confirm'], 1]);
  const confirmation = notify('confirm', ['--req', groupRun.req, '--id', contract.event.id]);
  eq('契约确认更新为 pending 且不直接发，随后 flush 出队', [
    confirmation.json.event.status, sends().length, flush(groupRun, morning).map((action) => action.kind), sends().length,
  ], ['pending', 1, ['notify-sent'], 2]);
  eq('带 confirm-required 的普通提醒同样等待确认', enqueue(groupRun, 'alert', 'manual', morning, ['--confirm-required']).event.status,
    'awaiting-confirm');

  const privateRun = { ...groupRun, req: 'notify-private', tier: 'L2', user: 'dev', notify: { memberOpenIds: { dev: 'ou_demo_dev' } } };
  save(privateRun);
  const l2Daily = enqueue(privateRun, 'daily', 'daily:2024-05-01');
  eq('L2 日报入队即时解释档位限制，不创建出站队列', [
    l2Daily.code, l2Daily.message, fs.existsSync(path.join(config, 'runs', privateRun.req + '.outbox.json')),
  ], ['NOTIFY_KIND_UNAVAILABLE', '日报仅 L3 大巡检可投递', false]);
  enqueue(privateRun, 'alert', 'alert:retry');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = flush(privateRun, morning, true);
    eq(`第 ${attempt} 次失败保留回执状态并累计次数`, [queue(privateRun)[0].status, queue(privateRun)[0].attempts,
      queue(privateRun)[0].lastError.includes('fixture-denied'), result.map((action) => action.kind)],
    ['failed', attempt, true, attempt === 3 ? ['user-report'] : []]);
  }
  const privateSends = sends().slice(2);
  eq('三次 bot 私信使用同一平台幂等键，第四次 flush 只汇报', [
    privateSends.map((call) => call.slice(0, 6)), new Set(privateSends.map((call) => call[call.indexOf('--idempotency-key') + 1])).size,
    flush(privateRun, morning).map((action) => action.kind), sends().length,
  ], [Array.from({ length: 3 }, () => ['im', '+messages-send', '--as', 'bot', '--user-id', 'ou_demo_dev']), 1, ['user-report'], 5]);

  const mute = { ...groupRun, req: 'mute', notify: { ...groupRun.notify, externalNotifyDisabled: true } };
  save(mute);
  eq('外部静默直接 suppressed，仍保留队列记录', [enqueue(mute, 'alert', 'alert:muted').event.status, flush(mute, morning), sends().length],
    ['suppressed', [], 5]);
  const pending = { ...groupRun, req: 'pending-mute' };
  save(pending);
  enqueue(pending, 'alert', 'alert:before-mute');
  save({ ...pending, notify: mute.notify });
  eq('静默暂停已经入队的提醒，保留待发送状态', [flush(pending, morning), queue(pending)[0].status, sends().length], [[], 'pending', 5]);
  eq('flush --all 处理活动需求，不重发 terminal 和成功事件', [
    notify('flush', ['--all']).json.runs.map((run) => run.req).sort(), sends().length,
  ], [['mute', 'notify-private', 'notify-team', 'pending-mute'], 5]);

  const daily = { ...groupRun, req: 'daily', issues: { master: 5, 'slot:主研发': 7, subIssues: [8] },
    notify: { ...groupRun.notify, dailyReportEnabled: true, dailyReportTime: '10:00' }, controller: { sessionId: 'c-lead' } };
  save(daily);
  const fake = makeFakeForge(path.join(tmp, 'forge'));
  const issue = (body, extra = {}) => ({ body, state: 'OPEN', labels: [], updatedAt: morning, ...extra });
  const master = '## 1. 整体状态\n当前阶段：P2\n整体进度：Issue 已完成 0/1 ｜ PR/MR 已合入 0/0\n## 2. 待主研发处理\n- [待裁决] 变更一\n- [待裁决] 变更二\n## 3. 各开发者\n| 主研发 | lead | 测试 | 无 | #7 |\n## 4. 契约与归属\n契约版本：v1\n## 5. 阶段节点\nP2 进行中\n';
  const slot = '## 1. 基本信息\n主控：第 1 任 ｜ c-lead\n阶段：P2 ｜ 基于契约：v1\n本轮：空闲\n最近唤醒：05-01 10:15\n## 2. 需本人处理\n无\n## 3. 当前进行中\n无\n## 4. 近期完成与挂起\n无\n## 5. 流程提醒\n无';
  fake.reset({ issues: { [repo + '#5']: issue(master), [repo + '#7']: issue(slot), [repo + '#8']: issue('验证入口', { title: '开发登录页', assignees: [{ login: 'lead' }] }) } });
  const tick = (role, at, apply = true) => loopctl(['tick', '--req', daily.req, '--role', role, '--now', at, ...(apply ? ['--apply'] : [])], config, { ...env, ...fake.env });
  const exists = () => fs.existsSync(path.join(config, 'runs', daily.req + '.outbox.json'));
  const before = '2024-05-01T01:40:00Z';
  tick('lead-patrol', before);
  tick('patrol', morning);
  tick('dispatch', morning);
  tick('lead-patrol', morning, false);
  eq('日报时间前、非大巡检角色及只读预览均不入队', [exists(), sends().length], [false, 5]);
  const report = tick('lead-patrol', morning);
  const reportActions = report.json.runs?.[0].actions ?? [];
  const payload = JSON.parse(sends().at(-1)[sends().at(-1).indexOf('--content') + 1]).zh_cn.content[0];
  eq('大巡检到点用事实生成日报、群 @ 全员、记录送达', [
    reportActions.some((action) => action.kind === 'notify-sent'), queue(daily).map((item) => [item.dedupKey, item.status]), payload[0],
  ], [true, [['daily:2024-05-01', 'sent']], { tag: 'at', user_id: 'all' }]);
  ok('日报区分子任务、真实合入及复测，列出业务标题与负责人',
    payload[1].text.includes('已关闭子任务 0/1') && payload[1].text.includes('已合入需求基线 0 项')
    && payload[1].text.includes('有明确复测通过记录的子任务 0 项') && payload[1].text.includes('lead · 开发登录页'));
  includes('日报统计两项待裁决', payload[1].text, '待裁决 2 项');
  tick('lead-patrol', morning);
  eq('同一日重复唤醒不重建日报、不重发', [queue(daily).length, sends().length], [1, 6]);
  const status = loopctl(['status', '--json'], config);
  eq('活动需求列表不会把 tick-state 或出站队列当作需求', status.json.activeRuns?.map((item) => item.req).sort(),
    ['daily', 'mute', 'notify-private', 'notify-team', 'pending-mute']);
  save(pending);
  save({ ...mute, notify: groupRun.notify });
  eq('恢复后只补发静默前的待发提醒，曾抑制的事项重新出现时才单独入队',
    [flush(pending, morning).map((item) => item.kind), flush(mute, morning), enqueue(mute, 'alert', 'alert:muted').event.status,
      flush(mute, morning).map((item) => item.kind), queue(mute).map(({ status }) => status)],
    [['notify-sent'], [], 'pending', ['notify-sent'], ['suppressed', 'sent']]);
  const unbound = { ...groupRun, req: 'unbound', notify: {} };
  save(unbound);
  const unsent = enqueue(unbound, 'contract-sync', 'contract:after-bind');
  enqueue(unbound, 'daily', 'daily:after-bind');
  const attached = { ...unbound, notify: moved.notify };
  save(attached);
  eq('未绑群入队的契约等待确认，日报按新群投递',
    [flush(attached, morning).map((item) => item.kind), sends().at(-1)?.[5]], [['notify-awaiting-confirm', 'notify-sent'], 'oc_other_group']);
  notify('confirm', ['--req', attached.req, '--id', unsent.event.id]);
  save({ ...attached, notify: groupRun.notify });
  eq('确认后的契约换群后只向当前目标投递，成功才去重',
    [flush(attached, morning).map((item) => item.kind), sends().at(-1)?.[5], enqueue(attached, 'contract-sync', 'contract:after-bind').duplicate],
    [['notify-sent'], 'oc_demo_group', true]);

  const backlog = { ...groupRun, req: 'backlog', notify: { externalNotifyDisabled: true } };
  save(backlog);
  const days = ['2024-05-01T02:15:00Z', '2024-05-02T02:15:00Z', '2024-05-03T02:15:00Z'];
  for (const at of days) {
    enqueue(backlog, 'alert', `alert:${at.slice(0, 10)}`, at);
    enqueue(backlog, 'daily', `daily:${at.slice(0, 10)}`, at);
  }
  enqueue(backlog, 'daily', 'daily:newest', days.at(-1), ['--text', '当天最新进度']);
  const durable = enqueue(backlog, 'alert', 'alert:confirm', days[0], ['--confirm-required']).event;
  const durableContract = enqueue(backlog, 'contract-sync', 'contract:confirmed', days[0]).event;
  for (const { id } of [durable, durableContract]) notify('confirm', ['--req', backlog.req, '--id', id]);
  eq('静默期间确认的事项保留，外部消息仍不发送', [
    flush(backlog, days.at(-1)), queue(backlog).filter((event) => [durable.id, durableContract.id].includes(event.id))
      .map(({ status, expiresAt }) => [status, expiresAt]),
  ], [[], [['pending', null], ['pending', null]]]);
  const beforeResume = sends().length;
  save({ ...backlog, notify: groupRun.notify });
  const resume = flush(backlog, days.at(-1));
  const resumedQueue = queue(backlog);
  eq('绑群并取消静默后仅发当天最新日报、两条已确认事项', [
    sends().slice(beforeResume).length, resume.map(({ dedupKey }) => dedupKey),
    resumedQueue.filter(({ status }) => status === 'suppressed').map(({ dedupKey }) => dedupKey),
  ], [3, ['daily:newest', 'alert:confirm', 'contract:confirmed'],
    ['alert:2024-05-01', 'daily:2024-05-01', 'alert:2024-05-02', 'daily:2024-05-02', 'alert:2024-05-03', 'daily:2024-05-03']]);
  ok('当天补发采用最新日报正文', sends().slice(beforeResume)[0].some((arg) => arg.includes('当天最新进度')));
  const expirationRun = { ...groupRun, req: 'expire-alert' };
  save(expirationRun);
  const expiring = enqueue(expirationRun, 'alert', 'alert:expire', '2024-05-01T01:00:45Z');
  eq('普通提醒默认 24 个工作小时后到期', expiring.event.expiresAt, '2024-05-03T05:00:45.000Z');
  eq('过期提醒不补发，队列保留已抑制状态', [
    flush(expirationRun, '2024-05-03T05:00:45Z'), queue(expirationRun)[0].status,
  ], [[], 'suppressed']);
  const noTarget = { ...groupRun, req: 'no-target', notify: {} };
  save(noTarget);
  eq('无投递目标时入队的普通提醒立即 suppressed', enqueue(noTarget, 'alert', 'alert:unbound').event.status, 'suppressed');
  save({ ...noTarget, notify: groupRun.notify });
  eq('绑群后不补发原本无投递目标的普通提醒', flush(noTarget, morning), []);

  // Repro 07: a suppressed active alert can be sent, and a resolved overnight finding cannot.
  const patrolFixture = { ...groupRun, thresholds: { blockEscalateHours: 1, mrIdleEscalateHours: 1 },
    workHours: { start: '09:00', end: '19:00', timezone: 'Asia/Shanghai' }, issues: { master: 5, escalation: 6 },
    notify: { ...groupRun.notify, externalMentionWindow: '09:00-19:00', memberOpenIds: { lead: 'ou_lead', 'dev-a': 'ou_dev_a' } } };
  const nowBlocked = '2024-05-01T01:00:00Z';
  const blockerState = {
    issues: { [repo + '#5']: issue(master), [repo + '#6']: issue('升级台账') },
    comments: { [`repos/${repo}/issues/6/comments`]: [[{
      id: 9001, created_at: nowBlocked, user: { login: 'dev-a' }, body: '主控 ｜ A ｜ controller-a\n升级-A-001 ｜ A ｜ 阻断\n问题：数据库锁冲突',
    }]] },
  };
  const patrol = (run, at) => loopctl(['tick', '--role', 'lead-patrol', '--req', run.req, '--now', at, '--apply'], config, { ...env, ...fake.env });
  const reportOnBlocker = (result) => (result.json.runs?.[0]?.actions ?? [])
    .filter(({ kind, refs }) => kind === 'user-report' && refs.some(({ code }) => code === 'BLOCK_ESCALATE')).length;
  const muteBlocker = { ...patrolFixture, req: 'mute-blocker', notify: { ...patrolFixture.notify, externalNotifyDisabled: true } };
  save(muteBlocker);
  fake.reset(blockerState);
  const beforeBlockerResume = sends().length;
  patrol(muteBlocker, morning);
  const suppressed = queue(muteBlocker)[0];
  const unmutedBlocker = { ...muteBlocker, notify: patrolFixture.notify };
  save(unmutedBlocker);
  patrol(unmutedBlocker, '2024-05-01T02:30:00Z');
  patrol(unmutedBlocker, '2024-05-01T03:00:00Z');
  const resumedEvents = queue(unmutedBlocker);
  eq('复现 07 静默恢复后仍成立的阻断重建一次并投递一次', [
    suppressed?.status, resumedEvents.map(({ status }) => status), new Set(resumedEvents.map(({ id }) => id)).size,
    sends().length - beforeBlockerResume,
  ], ['suppressed', ['suppressed', 'sent'], 2, 1]);

  const nightRun = { ...patrolFixture, req: 'night-patrol' };
  save(nightRun);
  fake.reset({
    ...blockerState,
    prs: { [repo + '#10']: {
      state: 'OPEN', baseRefName: nightRun.baselineBranch, headRefName: 'dev/a', headRefOid: 'f'.repeat(40),
      body: 'Refs #5', labels: ['需求:night-patrol'], author: { login: 'dev-a' }, createdAt: nowBlocked, updatedAt: nowBlocked,
    } },
  });
  const nightStart = sends().length;
  patrol(nightRun, '2024-05-01T15:30:00Z');
  patrol(nightRun, '2024-05-01T16:00:00Z');
  const queuedAtNight = queue(nightRun).map(({ text }) => text);
  const resolvedBeforeWork = readJson(fake.env.FAKE_FORGE_STATE);
  resolvedBeforeWork.prs[repo + '#10'].state = 'MERGED';
  fake.reset(resolvedBeforeWork);
  const firstMorning = patrol(nightRun, '2024-05-02T01:00:00Z');
  const nextMorning = patrol(nightRun, '2024-05-02T01:15:00Z');
  eq('复现 07 连续两轮夜间巡检后仍在的阻断次日只补报一次', [
    reportOnBlocker(firstMorning), reportOnBlocker(nextMorning),
  ], [1, 0]);
  eq('复现 07 非紧急压单夜里不入队，已合入的压单次日没有飞书或 Forge 提醒', [
    queuedAtNight.length, queuedAtNight.every((text) => text.includes('升级-A-001')),
    sends().slice(nightStart).length, sends().slice(nightStart).every((args) => args.join(' ').includes('升级-A-001')),
    (readJson(fake.env.FAKE_FORGE_STATE).comments?.[`repos/${repo}/issues/10/comments`] ?? []).flat().length,
  ], [1, true, 1, true, 0]);

  for (const trigger of ['定时巡检', '主动发送']) {
    const delayed = { ...patrolFixture, req: trigger === '定时巡检' ? 'resolved-queued-tick' : 'resolved-queued-flush',
      thresholds: { ...patrolFixture.thresholds, externalMentionWindow: '11:00-19:00' } };
    const delayedFacts = structuredClone(blockerState);
    delayedFacts.prs = { [repo + '#10']: {
      state: 'OPEN', baseRefName: delayed.baselineBranch, headRefName: 'dev/a', headRefOid: 'f'.repeat(40),
      body: 'Refs #5', labels: [`需求:${delayed.req}`], author: { login: 'dev-a' }, createdAt: nowBlocked, updatedAt: nowBlocked,
    } };
    save(delayed);
    fake.reset(delayedFacts);
    const beforeQueue = sends().length;
    patrol(delayed, '2024-05-01T02:15:00Z');
    const queued = queue(delayed).map(({ status }) => status);
    delayedFacts.prs[repo + '#10'].state = 'MERGED';
    delayedFacts.comments[`repos/${repo}/issues/6/comments`][0].push({
      id: 9002, created_at: '2024-05-01T02:30:00Z', body: '主研发 ｜ 主研发 ｜ lead\n【裁决】升级-A-001：同意',
    });
    fake.reset(delayedFacts);
    const due = '2024-05-01T03:15:00Z';
    const flushed = trigger === '定时巡检' ? patrol(delayed, due)
      : loopctl(['notify', 'flush', '--req', delayed.req, '--now', due], config, { ...env, ...fake.env });
    eq(`R5/11 ${trigger}发送前核实已入队事项，已解决就不发`, [
      queued, flushed.code, queue(delayed).map(({ status }) => status), sends().length - beforeQueue,
    ], [['pending', 'pending'], 0, ['suppressed', 'suppressed'], 0]);
  }

}

function scenarioNotifyBinding(tmp) {
  group('13. 飞书群绑定、静默和台账配置变更');
  const config = path.join(tmp, 'config');
  const lark = path.join(tmp, 'fake-lark.mjs');
  const larkLog = path.join(tmp, 'lark-calls.jsonl');
  write(lark, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
fs.appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(args) + '\\n');
if (value('--as') !== 'bot') process.exit(1);
const output = (data) => console.log(JSON.stringify({ ok: true, identity: 'bot', data }));
if (args[1] === '+chat-search') {
  const name = value('--query');
  const second = args.includes('--page-token');
  output({ chats: [{ name, chat_id: second ? 'oc_group_two' : 'oc_group_one' }],
    has_more: name === '同名群' && !second, page_token: 'search-next' });
} else if (args[1] === 'chat.members') {
  if (value('--chat-id') === 'oc_outside') {
    console.error(JSON.stringify({ ok: false, error: { type: 'api_error', code: 232011 } }));
    process.exit(1);
  }
  if (value('--member-id-type') !== 'open_id') process.exit(1);
  const member = (name, member_id) => ({ name, member_id, member_id_type: 'open_id' });
  const second = args.includes('--page-token');
  output(second ? { items: [member('李四', 'ou_li_two'), member('张三', 'ou_zhang')], has_more: false }
    : { items: [member('李四', 'ou_li_one')], has_more: true, page_token: 'members-next' });
} else if (args[1] === 'chats') {
  output({ name: '演练群', chat_mode: 'group', chat_status: 'normal', external: false });
} else if (args[1] === '+messages-send') {
  output({ message_id: 'om_fixture' });
} else process.exit(1);
`);
  fs.chmodSync(lark, 0o755);
  const fake = makeFakeForge(path.join(tmp, 'forge'));
  const env = { ...fake.env, LARK_CLI_BIN: lark, FAKE_LARK_LOG: larkLog };
  const now = '2024-05-01T02:15:00Z';
  const repo = 'acme/loop';
  const run = {
    req: 'bind-demo', project: 'sandbox', tier: 'L2', user: 'zhang', forge: 'github', hubRepo: { repo }, issues: { main: 7 },
    participants: [{ user: 'zhang', name: '张三' }, { user: 'li', name: '李四' }, { user: 'wang', name: '王五' }],
    notify: { dailyReportEnabled: false, feishuUserOpenId: 'ou_private' },
  };
  const file = path.join(config, 'runs', run.req + '.json');
  const project = path.join(config, 'projects', run.project + '.yaml');
  const initialProject = '# 沙箱说明\nforge: github\nhubRepo: acme/loop\nnotify:\n  dailyReportTime: "10:00"\n# 保留说明\ndefaultTier: L3\n';
  write(file, JSON.stringify(run));
  write(project, initialProject);
  write(path.join(config, 'me.json'), JSON.stringify({ notify: { feishuGroupChatId: 'oc_old', memberOpenIds: { retired: 'ou_retired' } } }));
  const state = { issues: { [repo + '#7']: { body: '## 1. 基本信息', state: 'OPEN', updatedAt: now, labels: [] } } };
  fake.reset(state);
  const notify = (sub, ...args) => loopctl(['notify', sub, '--req', run.req, '--now', now, ...args], config, env);
  const bind = (chat, ...args) => notify('bind', '--chat', chat, ...args);
  const comments = () => fake.calls().filter((call) => call.args.includes('POST')).map((call) => JSON.parse(call.stdin).body);
  const two = bind('同名群');
  eq('同名群跨页列出候选 ID，不写配置或评论', [
    two.json.code, two.json.candidates?.map((item) => item.chatId), readJson(file).notify, comments(),
  ], ['LARK_CHAT_AMBIGUOUS', ['oc_group_one', 'oc_group_two'], run.notify, []]);
  const outside = bind('oc_outside');
  ok('指定群 ID 仍核对同一个 bot 在群内，失败解释怎么加机器人', outside.json.code === 'LARK_BOT_NOT_IN_CHAT'
    && outside.json.message.includes('群设置') && comments().length === 0 && readJson(file).notify.feishuGroupChatId === undefined);
  const bound = bind('演练群');
  eq('默认绑定当前需求，跨页核实姓名，只保存唯一匹配者', [
    bound.code, bound.json.scope, bound.json.matchedCount, bound.json.unmatchedMembers?.map((item) => [item.user, item.reason]),
    readJson(file).notify, fs.readFileSync(project, 'utf8'),
  ], [0, 'run', 1, [['li', '同名，无法唯一匹配'], ['wang', '群成员中未找到同名用户']],
    { ...run.notify, feishuGroupChatId: 'oc_group_one', memberOpenIds: { zhang: 'ou_zhang' } }, initialProject]);
  ok('台账配置变更评论含脚本签名、变更范围和去重标识，不公开成员 ID',
    comments()[0]?.startsWith('巡检脚本 ｜ 主研发 ｜ NOTIFY_BIND\n【配置变更】')
    && comments()[0].includes('仅本次需求') && comments()[0].includes('liteloop:key=notify-config:') && !comments()[0].includes('ou_'));
  eq('重复绑定同一结果不会重复写台账，非法范围拒绝', [
    bind('oc_group_one').json.changed, comments().length, bind('oc_group_one', '--scope', 'other').json.code,
  ], [false, 1, 'INVALID_NOTIFY_SCOPE']);

  const projectBound = bind('oc_group_two', '--scope', 'project');
  const resolved = () => loopctl(['config-resolve', '--project', run.project], config, env).json.notify;
  eq('工程档案生效为新需求默认，保留 YAML 相邻内容，当前需求群不变', [
    projectBound.json.scope, resolved().feishuGroupChatId, resolved().memberOpenIds, resolved().dailyReportTime,
    readJson(file).notify.feishuGroupChatId, fs.readFileSync(project, 'utf8').includes('# 保留说明\ndefaultTier: L3'),
  ], ['project', 'oc_group_two', { zhang: 'ou_zhang' }, '10:00', 'oc_group_one', true]);
  eq('解绑定工程群后不会继承更低层的旧群和成员', [
    notify('unbind', '--scope', 'project').code, resolved().feishuGroupChatId, resolved().memberOpenIds, readJson(file).notify.feishuGroupChatId,
  ], [0, null, {}, 'oc_group_one']);

  const queueAlert = (key) => notify('enqueue', '--kind', 'alert', '--dedup', key, '--text', '提醒');
  const sendArgs = () => fs.readFileSync(larkLog, 'utf8').trim().split('\n').map(JSON.parse).filter((args) => args[1] === '+messages-send');
  const beforeMute = queueAlert('alert:before-mute');
  const muted = notify('mute');
  const unmuted = notify('unmute');
  const resumed = notify('flush');
  eq('L2 绑定后可发群，恢复时投递静默前已入队的事件', [
    beforeMute.json.event?.audience.chatId, muted.json.muted, unmuted.json.muted, resumed.json.runs?.[0].actions.map((item) => item.kind), sendArgs().length,
  ], ['oc_group_one', true, false, ['notify-sent'], 1]);
  queueAlert('alert:after-unmute');
  eq('恢复后新提醒走绑定群，解除绑定后仍可走原个人私信', [
    notify('flush').json.runs?.[0].actions[0]?.kind, sendArgs()[0]?.slice(0, 6),
    notify('unbind').json.chatId, queueAlert('alert:private').json.event?.audience.userId,
  ], ['notify-sent', ['im', '+messages-send', '--as', 'bot', '--chat-id', 'oc_group_one'], null, 'ou_private']);
  eq('所有有效配置变更都有台账评论，project 范围明确写后续需求', [
    comments().length, comments().filter((body) => body.includes('工程默认值，后续需求使用')).length,
    comments().every((body) => /^巡检脚本 ｜ 主研发 ｜ NOTIFY_(?:BIND|UNBIND|MUTE|UNMUTE)\n【配置变更】/.test(body)),
  ], [6, 2, true]);

  fake.reset({ ...state, failApi: ['repos/' + repo + '/issues/7/comments?per_page=100'] });
  const beforeAuditFailure = readJson(file).notify;
  eq('台账评论无法核对时不写入绑定配置', [bind('oc_group_one').json.code, readJson(file).notify], ['EXEC_FAILED', beforeAuditFailure]);

  fake.reset({ issues: { ...state.issues, [repo + '#5']: { ...state.issues[repo + '#7'], body: '## 1. 整体状态' } } });
  write(file, JSON.stringify({ ...run, tier: 'L3', slot: 'A', issues: { master: 5, 'slot:A': 7 } }));
  const l3Bound = bind('oc_group_one', '--scope', 'run');
  eq('L3 本次需求的群绑定只在总台账留配置变更', [
    l3Bound.json.ledger?.id, fake.calls().filter((call) => call.args.includes('POST'))
      .map((call) => call.args.find((arg) => arg.endsWith('/comments'))),
  ], ['5', [`repos/${repo}/issues/5/comments`]]);
  const squad = { req: 'l3-notify', project: 'sandbox', tier: 'L3', slot: '主研发', user: 'lead', forge: 'github',
    hubRepo: { repo }, repos: [{ repo, branch: 'main' }], baselineBranch: 'loop/l3-notify',
    issues: { master: 5 }, thresholds: { mrIdleEscalateHours: 1 } };
  const masterNotes = `repos/${repo}/issues/5/comments`;
  const old = '2024-05-01T01:00:00Z';
  const squadIssue = { state: 'OPEN', labels: ['需求:l3-notify'], updatedAt: old };
  const squadFacts = withSlotBindings({
    issues: {
      [repo + '#5']: { ...squadIssue, body: '## 1. 整体状态\n当前阶段：P2\n## 3. 各开发者\n| A | 张三 | 开发 | 无 | #8 |' },
      [repo + '#8']: { ...squadIssue, labels: [...squadIssue.labels, '槽位A'], title: '【小台账】A-张三', body: '## 1. 基本信息\n本轮：空闲\n' },
    },
    prs: { [repo + '#50']: { ...squadIssue, labels: [...squadIssue.labels, '槽位A'], title: '待送审的协作者变更',
      headRefOid: 'a'.repeat(40), headRefName: 'dev/member', baseRefName: squad.baselineBranch,
      body: '关联 #8', createdAt: old, author: { login: 'zhang' } } },
  }, masterNotes, slotBinding(8100, 'A', 'zhang', 'slot-a', old));
  write(path.join(config, 'runs', squad.req + '.json'), JSON.stringify(squad));
  fake.reset(squadFacts);
  const sentBefore = sendArgs().length;
  const squadBind = loopctl(['notify', 'bind', '--req', squad.req, '--chat', 'oc_group_one'], config, env);
  loopctl(['tick', '--req', squad.req, '--role', 'lead-patrol', '--apply', '--now', '2024-05-01T05:00:00Z'], config, env);
  eq('R5/12 群绑定从 Forge 认领获取协作者，压单提醒发给正确成员', [
    squadBind.json.matchedCount, sendArgs().length - sentBefore, sendArgs().at(-1)?.some((arg) => arg.includes('ou_zhang')),
  ], [1, 1, true]);

}

/* ================================================================== */
/* 主流程                                                                */
/* ================================================================== */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-lite-loop-test-'));
let crashed = null;
try {
  checkActionMessages();
  await scenario1(path.join(tmp, 's1'));
  scenario2(path.join(tmp, 's2'));
  scenario3(path.join(tmp, 's3'));
  scenario4(path.join(tmp, 's4'));
  scenario5(path.join(tmp, 's5'));
  scenario6(path.join(tmp, 's6'));
  scenario7(path.join(tmp, 's7'));
  scenarioHumanStatus(path.join(tmp, 'status'));
  scenario8(path.join(tmp, 's8'));
  scenarioRunFacts(path.join(tmp, 's9'));
  scenarioTick(path.join(tmp, 's10'));
  scenarioDrillRegressions(path.join(tmp, 'drill-regressions'));
  scenarioTickComments(path.join(tmp, 's11'));
  scenarioTeardownMisoperations(path.join(tmp, 'teardown-misoperations'));
  scenarioOutbox(path.join(tmp, 's12'));
  scenarioNotifyBinding(path.join(tmp, 's13'));
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
