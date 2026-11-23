import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readReviews } from '../scripts/lib/review-journal.mjs';

const repo = 'acme/loop';
const req = 'u5';
const baseline = `loop/${req}`;
const memberLabel = `需求:${req}`;
const now = '2024-05-01T04:00:00Z';
const lowRisk = 'contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0';

const fakeGh = `#!/usr/bin/env node\n` + String.raw`
import fs from 'node:fs';
const file = process.env.U5_FORGE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const [kind, cmd, id] = args;
const { issue, pr, comments } = state;
const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const reply = (value) => { console.log(JSON.stringify(value)); process.exit(0); };
const fail = (reason) => { console.error(reason); process.exit(1); };
function post(body) {
  const note = { body, id: comments.length + 1, created_at: pr.updatedAt };
  comments.push(note);
  save();
  reply(note);
}

if (kind === 'api') {
  const endpoint = args.find((arg) => arg.startsWith('repos/'))?.split('?')[0] ?? '';
  if (endpoint.endsWith('/issues')) reply([{ ...pr, number: 2, pull_request: {} }]);
  if (endpoint.endsWith('/issues/1/comments')) reply([]);
  if (endpoint.endsWith('/issues/2/comments')) {
    if (flag('--method') === 'POST') post(JSON.parse(fs.readFileSync(0, 'utf8')).body);
    reply(comments);
  }
  if (endpoint.endsWith('/events')) reply([]);
}
if (kind === 'issue' && id === '1') {
  if (cmd === 'edit') { issue.body = flag('--body'); save(); }
  reply(issue);
}
if (kind === 'pr' && id === '2') {
  if (cmd === 'view') reply(pr);
  if (cmd === 'comment') post(flag('--body'));
  if (cmd === 'edit') {
    const remove = flag('--remove-label').split(',');
    const add = flag('--add-label').split(',').filter(Boolean);
    pr.labels = [...pr.labels.filter((label) => !remove.includes(label)), ...add];
    save();
    reply(pr);
  }
  if (cmd === 'merge') {
    state.mergeCalls += 1;
    if (!state.queueMerge) {
      pr.state = 'MERGED';
      pr.mergeCommit = { oid: 'f'.repeat(40) };
      pr.mergedAt = pr.updatedAt;
      pr.mergedBy = { login: 'dev' };
    }
    save();
    reply({ merged: true });
  }
}
fail('unexpected gh command: ' + args.join(' '));
`;

function binPath(script) {
  return fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url));
}

function runScript(script, args, env) {
  const res = spawnSync(process.execPath, [binPath(script), ...args], { env, encoding: 'utf8' });
  const text = (res.stdout || res.stderr || '').trim();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function fixture(t, {
  verification = { mode: 'local-test', commands: { loop: 'node test.mjs' } },
  repoCommand = undefined,
  thresholds = {},
  conflict = false,
  badLineage = false,
  missingRepoPath = false,
  prOverrides = {},
  prepareRepo = () => {},
  testScript = 'import fs from "node:fs";\nif (!fs.existsSync("base-advance.txt") || !fs.existsSync("feature.txt")) process.exit(2);\nconsole.log("TRIAL_OK");\n',
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-loop-u5-'));
  const trialTmp = path.join(dir, 'tmp');
  fs.mkdirSync(trialTmp);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const pusher = path.join(dir, 'pusher');
  const gitEnv = {
    ...process.env,
    TMPDIR: trialTmp,
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
  const env = { ...gitEnv };

  fs.mkdirSync(pusher);
  git(pusher, 'init', '-q', '-b', baseline);
  git(pusher, 'config', 'user.name', 'Fixture');
  git(pusher, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(pusher, 'shared.txt'), 'initial\n');
  fs.writeFileSync(path.join(pusher, 'test.mjs'), testScript);
  prepareRepo(pusher);
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-qm', 'initial baseline');
  const earlySha = git(pusher, 'rev-parse', 'HEAD');

  if (badLineage) {
    // Advance baseline so baselineStartSha is AFTER candidate's fork point.
    fs.writeFileSync(path.join(pusher, 'later.txt'), 'later\n');
    git(pusher, 'add', '.');
    git(pusher, 'commit', '-qm', 'later baseline start');
  }
  const baselineStartSha = git(pusher, 'rev-parse', 'HEAD');

  // Create candidate branch (from earlySha when testing badLineage, else baselineStartSha).
  git(pusher, 'switch', '-qc', 'dev/candidate', badLineage ? earlySha : baselineStartSha);
  fs.writeFileSync(path.join(pusher, 'feature.txt'), 'from candidate\n');
  if (conflict) fs.writeFileSync(path.join(pusher, 'shared.txt'), 'candidate version\n');
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-qm', 'candidate change');
  const headSha = git(pusher, 'rev-parse', 'HEAD');

  // Advance baseline on origin to simulate another merged PR landing before this merge.
  git(pusher, 'switch', '-q', baseline);
  fs.writeFileSync(path.join(pusher, 'base-advance.txt'), 'from baseline\n');
  if (conflict) fs.writeFileSync(path.join(pusher, 'shared.txt'), 'baseline version\n');
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-qm', 'baseline advance');
  const latestBaseSha = git(pusher, 'rev-parse', 'HEAD');

  git(dir, 'clone', '-q', '--bare', pusher, origin);
  git(dir, 'clone', '-q', origin, work);
  git(work, 'config', 'user.name', 'Developer');
  git(work, 'config', 'user.email', 'dev@example.test');
  // Put developer's main checkout on a separate dirty branch so we can prove trial never touches it.
  git(work, 'switch', '-qc', 'dev/wip', baselineStartSha);
  const devHeadBefore = git(work, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(work, 'wip-untracked.txt'), 'do not touch\n');

  const runs = path.join(dir, 'runs');
  fs.mkdirSync(runs);
  const runPath = path.join(runs, `${req}.json`);
  const statePath = path.join(dir, 'forge.json');
  const ghPath = path.join(dir, 'gh.mjs');
  fs.writeFileSync(ghPath, fakeGh, { mode: 0o755 });
  Object.assign(env, {
    GH_BIN: ghPath,
    GH_HOST: 'github.com',
    GIT_BIN: 'git',
    XXN_LITE_LOOP_CONFIG_DIR: dir,
    U5_FORGE_STATE: statePath,
  });

  const repoEntry = {
    name: 'loop',
    repo,
    branch: 'main',
    path: missingRepoPath ? path.join(dir, 'does-not-exist') : work,
    baselineStartSha,
    ...(repoCommand !== undefined ? { verificationCommand: repoCommand } : {}),
  };
  fs.writeFileSync(runPath, JSON.stringify({
    req,
    tier: 'L2',
    forge: 'github',
    user: 'dev',
    baselineBranch: baseline,
    autoMerge: true,
    verification,
    thresholds,
    hubRepo: repoEntry,
    repos: [repoEntry],
    issues: { main: 1 },
    changes: [{ repo, id: 2 }],
  }));

  const ledgerBody = '## 1. 基本信息\n阶段：P3 ｜ 状态：未开始\n主控：第 1 任 ｜ controller ｜ local\n本轮：空闲\n最近唤醒：05-01 12:00\n';
  fs.writeFileSync(statePath, JSON.stringify({
    issue: { state: 'OPEN', labels: [], body: ledgerBody, updatedAt: now },
    pr: {
      state: 'OPEN',
      labels: [memberLabel, '待终审'],
      body: 'Refs #1',
      updatedAt: now,
      headRefOid: headSha,
      baseRefName: baseline,
      headRefName: 'dev/candidate',
      ...prOverrides,
    },
    comments: [],
    mergeCalls: 0,
  }));

  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const update = (edit) => {
    const state = readState();
    edit(state);
    fs.writeFileSync(statePath, JSON.stringify(state));
  };
  const forge = (subcommand, ...args) => {
    const res = runScript('forge', [
      subcommand, '--run', runPath, '--forge', 'github',
      '--repo', repo, '--id', '2', '--head-sha', headSha, '--session', 'reviewer', ...args,
    ], env);
    assert.equal(res.status, 0, `forge ${subcommand} failed: ${res.stdout}\n${res.stderr}`);
    return res.json;
  };
  const review = forge('dispatch-review', '--role', 'controller');

  function assertCleanWorktreesAndDevCheckout() {
    if (!missingRepoPath) {
      const wt = git(work, 'worktree', 'list', '--porcelain');
      const count = wt.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length;
      assert.equal(count, 1, `expected only main worktree, got:\n${wt}`);
      assert.equal(git(work, 'branch', '--show-current'), 'dev/wip');
      assert.equal(git(work, 'rev-parse', 'HEAD'), devHeadBefore);
      assert.equal(fs.readFileSync(path.join(work, 'wip-untracked.txt'), 'utf8'), 'do not touch\n');
    }
    const leftovers = fs.readdirSync(trialTmp).filter((name) => name.startsWith('liteloop-trial-'));
    assert.deepEqual(leftovers, [], `temp trial worktree dirs leaked: ${leftovers.join(', ')}`);
  }

  return {
    dir, env, git, origin, work, pusher, update,
    runPath,
    headSha,
    latestBaseSha,
    readState,
    assertCleanWorktreesAndDevCheckout,
    verdict: (risk = lowRisk) => forge('verdict', '--dispatch-id', review.dispatchId, '--nonce', review.nonce,
      '--round', String(review.round), '--conclusion', '通过', '--risk', risk),
    tick: () => {
      const res = runScript('loopctl', ['tick', '--req', req, '--role', 'controller', '--apply', '--now', now], env);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      return res.json.runs?.[0]?.actions ?? [];
    },
  };
}

function assertPr(f, { state = 'OPEN', labels, mergeCalls = 0 }) {
  const s = f.readState();
  assert.deepEqual(
    { state: s.pr.state, labels: [...s.pr.labels].sort(), mergeCalls: s.mergeCalls },
    { state, labels: [memberLabel, ...labels].sort(), mergeCalls },
  );
}

test('试合通过 → 合入并记录 merge-result.trial 与合并评论', (t) => {
  const f = fixture(t);
  const result = f.verdict();
  assert.deepEqual([result.state, result.code, result.merged], ['merged', 'LOW_RISK_AUTO_MERGE', true]);
  assertPr(f, { state: 'MERGED', labels: ['风险低'], mergeCalls: 1 });

  const dispatch = readReviews(f.runPath).at(-1);
  assert.equal(dispatch.merge.state, 'merged');
  assert.equal(dispatch.merge.trial.baseSha, f.latestBaseSha);
  assert.equal(dispatch.merge.trial.headSha, f.headSha);
  assert.equal(dispatch.merge.trial.command, 'node test.mjs');
  assert.equal(dispatch.merge.trial.exitCode, 0);
  assert.equal(typeof dispatch.merge.trial.durationMs, 'number');

  const mergeComment = f.readState().comments.at(-1).body;
  assert.match(mergeComment, new RegExp(`合并前试合：node test\\.mjs 通过（base ${f.latestBaseSha.slice(0, 8)}）`));
  f.assertCleanWorktreesAndDevCheckout();
});

test('B1：继承的 Git 仓库环境变量不能改动另一个开发检出', (t) => {
  const f = fixture(t, {
    testScript: 'import { execFileSync } from "node:child_process";\n'
      + 'import fs from "node:fs";\n'
      + 'if (execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() !== fs.realpathSync(".")) process.exit(2);\n'
      + 'if (!fs.existsSync("feature.txt")) process.exit(3);\n'
      + 'execFileSync("git", ["branch", "trial-only"]);\n',
  });
  f.git(f.pusher, 'remote', 'add', 'origin', f.origin);
  fs.appendFileSync(path.join(f.pusher, 'shared.txt'), 'unfinished work\n');
  const inspect = () => [f.pusher, f.work].map((dir) => [
    f.git(dir, 'branch', '--show-current'),
    f.git(dir, 'for-each-ref', 'refs/heads'),
    f.git(dir, 'status', '--porcelain=v1'),
    f.git(dir, 'diff', 'HEAD'),
    fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
  ]);
  const before = inspect();
  const gitDir = path.join(f.pusher, '.git');
  Object.assign(f.env, {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: f.pusher,
    GIT_INDEX_FILE: path.join(gitDir, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects'),
    GIT_COMMON_DIR: gitDir,
  });
  const result = f.verdict();
  assert.deepEqual(inspect(), before);
  assert.equal(result.state, 'merged', result.message);
  assertPr(f, { state: 'MERGED', labels: ['风险低'], mergeCalls: 1 });
  f.assertCleanWorktreesAndDevCheckout();
});

test('Q2：试合只合并已核对 SHA，并保留其他 worktree 的挂载记录', (t) => {
  const f = fixture(t);
  const stale = path.join(f.dir, 'other-worktree');
  f.git(f.work, 'config', 'gc.worktreePruneExpire', 'now');
  f.git(f.work, 'worktree', 'add', '--detach', stale, f.latestBaseSha);
  fs.rmSync(stale, { recursive: true });
  const shim = path.join(f.dir, 'git-shim');
  fs.writeFileSync(shim, `#!/bin/sh
if [ "$1" = "-C" ]; then cd "$2" || exit; shift 2; fi
git "$@" || exit
if [ "$1" = "rev-list" ] && [ "$2" = "--merges" ]; then
  git update-ref refs/remotes/origin/dev/candidate "${f.latestBaseSha}"
fi
`, { mode: 0o755 });
  f.env.GIT_BIN = shim;
  const result = f.verdict();
  assert.deepEqual([result.state, result.trial?.headSha], ['merged', f.headSha]);
  assert.ok(f.git(f.work, 'worktree', 'list', '--porcelain').includes('/other-worktree'));
});

test('B2：试合期间远端基线前移 → 等待，tick 重新试合新基线后才合并', (t) => {
  const f = fixture(t, {
    testScript: `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
fs.appendFileSync(process.env.TRIAL_RUNS, fs.existsSync('new-base.txt') ? 'new\\n' : 'old\\n');
execFileSync('git', ['-C', process.env.TRIAL_PUSHER, 'push', process.env.TRIAL_ORIGIN,
  'base-after-trial:refs/heads/${baseline}']);`,
  });
  f.git(f.pusher, 'switch', '-qc', 'base-after-trial');
  fs.writeFileSync(path.join(f.pusher, 'new-base.txt'), 'new baseline\n');
  f.git(f.pusher, 'add', 'new-base.txt');
  f.git(f.pusher, 'commit', '-qm', 'move remote baseline');
  const newBaseSha = f.git(f.pusher, 'rev-parse', 'HEAD');
  const runs = path.join(f.dir, 'trial-runs');
  Object.assign(f.env, { TRIAL_PUSHER: f.pusher, TRIAL_ORIGIN: f.origin, TRIAL_RUNS: runs });
  const result = f.verdict();
  assert.equal(f.git(f.origin, 'rev-parse', baseline), newBaseSha);
  assert.deepEqual([result.state, result.code], ['waiting', 'TRIAL_BASE_MOVED']);
  assertPr(f, { labels: ['风险低', '待合并'] });
  assert.equal(fs.readFileSync(runs, 'utf8'), 'old\n');

  assert.ok(f.tick().some(({ kind, code }) => kind === 'retry-merge' && code === 'LOW_RISK_AUTO_MERGE'));
  assertPr(f, { state: 'MERGED', labels: ['风险低'], mergeCalls: 1 });
  assert.equal(fs.readFileSync(runs, 'utf8'), 'old\nnew\n');
  assert.equal(readReviews(f.runPath).at(-1).merge.trial.baseSha, newBaseSha);
  f.assertCleanWorktreesAndDevCheckout();
});

test('Q3：平台入队后，等待日志与最终合入评论保留同一份试合证据', (t) => {
  const f = fixture(t);
  f.update((s) => { s.queueMerge = true; });
  const result = f.verdict();
  assert.equal(result.code, 'MERGE_NOT_CONFIRMED');
  assertPr(f, { labels: ['风险低', '待合并'], mergeCalls: 1 });
  const { trial } = readReviews(f.runPath).at(-1).merge;
  assert.equal(trial?.baseSha, f.latestBaseSha);
  assert.equal(trial.headSha, f.headSha);
  assert.equal(result.state, 'waiting');
  f.update(({ pr }) => { pr.state = 'MERGED'; });
  assert.ok(f.tick().some(({ code }) => code === 'LOW_RISK_AUTO_MERGE'));
  assertPr(f, { state: 'MERGED', labels: ['风险低'], mergeCalls: 1 });
  assert.deepEqual(readReviews(f.runPath).at(-1).merge.trial, trial);
  assert.match(f.readState().comments.at(-1).body, /合并前试合：node test\.mjs 通过/);
  f.assertCleanWorktreesAndDevCheckout();
});

test('试合命令失败 → 不合并、挂需修改并附输出末 40 行', (t) => {
  const failingScript = [
    'for (let i = 1; i <= 50; i += 1) console.log(`LINE_${i}`);',
    'process.exit(1);',
  ].join('\n');
  const f = fixture(t, { testScript: failingScript });
  const result = f.verdict();
  assert.deepEqual([result.state, result.code], ['manual', 'TRIAL_TEST_FAILED']);
  assertPr(f, { labels: ['需修改'], mergeCalls: 0 });
  assert.match(result.message, /LINE_50/);
  assert.match(result.message, /LINE_11/);
  assert.doesNotMatch(result.message, /\bLINE_10\b/);

  const comment = f.readState().comments.at(-1).body;
  assert.match(comment, /TRIAL_TEST_FAILED/);
  assert.match(comment, /LINE_50/);
  assert.doesNotMatch(comment, /\bLINE_10\b/);

  f.tick();
  assertPr(f, { labels: ['需修改'], mergeCalls: 0 });
  f.assertCleanWorktreesAndDevCheckout();
});

test('试合冲突 → 不合并并挂需修改', (t) => {
  const f = fixture(t, { conflict: true });
  const result = f.verdict();
  assert.deepEqual([result.state, result.code], ['manual', 'TRIAL_MERGE_CONFLICT']);
  assertPr(f, { labels: ['需修改'], mergeCalls: 0 });
  f.tick();
  assertPr(f, { labels: ['需修改'], mergeCalls: 0 });
  f.assertCleanWorktreesAndDevCheckout();
});

test('试合命令无法启动 → TRIAL_ENV_ERROR 交人、不挂需修改', (t) => {
  const f = fixture(t, {
    verification: { mode: 'local-test', commands: { loop: 'liteloop_nonexistent_cmd_987654 --check' } },
  });
  const result = f.verdict();
  assert.deepEqual([result.state, result.code], ['manual', 'TRIAL_ENV_ERROR']);
  assertPr(f, { labels: ['风险低', '待合并'], mergeCalls: 0 });
  f.tick();
  assertPr(f, { labels: ['风险低', '待合并'], mergeCalls: 0 });
  f.assertCleanWorktreesAndDevCheckout();
});

test('试合命令超时 → TRIAL_ENV_ERROR 交人、不挂需修改并清理 worktree', (t) => {
  const f = fixture(t, {
    verification: { mode: 'local-test', commands: { loop: 'node -e "setTimeout(() => {}, 10000)"' } },
    thresholds: { trialMergeTimeoutMinutes: 0.005 },
  });
  const result = f.verdict();
  assert.deepEqual([result.state, result.code], ['manual', 'TRIAL_ENV_ERROR']);
  assertPr(f, { labels: ['风险低', '待合并'], mergeCalls: 0 });
  f.assertCleanWorktreesAndDevCheckout();
});

for (const { name, end, code } of [
  { name: '超时', end: 'sleep 30', code: 'TRIAL_ENV_ERROR' },
  { name: '成功返回', end: ':', code: 'LOW_RISK_AUTO_MERGE' },
]) {
  test(`I1：试合${name}后后台后代已退出`, (t) => {
    const f = fixture(t, {
      repoCommand: `sh -c 'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$TRIAL_PID"'; ${end}`,
      thresholds: { trialMergeTimeoutMinutes: 0.005 },
    });
    f.env.TRIAL_PID = path.join(f.dir, 'trial-pid');
    const result = f.verdict();
    const pid = Number(fs.readFileSync(f.env.TRIAL_PID, 'utf8'));
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; } });
    assert.equal(result.code, code);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    f.assertCleanWorktreesAndDevCheckout();
  });
}

test('I2：工程档案的 npm 示例在全新试合检出里安装依赖后验证', (t) => {
  const doc = fs.readFileSync(new URL('../references/lifecycle.md', import.meta.url), 'utf8');
  const command = /^    demo: (.+)$/m.exec(doc)?.[1];
  assert.ok(command);
  const f = fixture(t, {
    repoCommand: command,
    prepareRepo(dir) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'trial-demo', version: '1.0.0', dependencies: { 'trial-fixture': 'file:./trial-fixture' },
        scripts: { test: 'node --input-type=module -e "import \'trial-fixture\'"' },
      }));
      fs.mkdirSync(path.join(dir, 'trial-fixture'));
      fs.writeFileSync(path.join(dir, 'trial-fixture', 'package.json'), '{"name":"trial-fixture","version":"1.0.0","main":"index.js"}');
      fs.writeFileSync(path.join(dir, 'trial-fixture', 'index.js'), 'module.exports = true;');
      execFileSync('npm', ['install', '--package-lock-only', '--offline', '--no-audit', '--ignore-scripts'], {
        cwd: dir, env: { ...process.env, npm_config_cache: path.join(path.dirname(dir), 'npm-cache') },
      });
    },
  });
  Object.assign(f.env, { npm_config_offline: 'true', npm_config_cache: path.join(f.dir, 'npm-cache') });
  assert.equal(f.verdict().code, 'LOW_RISK_AUTO_MERGE');
  assert.equal(fs.existsSync(path.join(f.work, 'node_modules')), false);
  f.assertCleanWorktreesAndDevCheckout();
});

test('M1：升级说明指向存量 local-test 档案的两个补配项', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /local-test.*verification\.commands.*verification\.skipReason.*MISSING_VERIFICATION/);
});

test('未配命令带 skipReason → 直接合并并在评论写明未试合原因', (t) => {
  const f = fixture(t, {
    verification: { mode: 'local-test', commands: {}, skipReason: '纯文档改动，无需跑测试' },
  });
  const result = f.verdict();
  assert.deepEqual([result.state, result.code, result.merged], ['merged', 'LOW_RISK_AUTO_MERGE', true]);
  assertPr(f, { state: 'MERGED', labels: ['风险低'], mergeCalls: 1 });
  const dispatch = readReviews(f.runPath).at(-1);
  assert.equal(dispatch.merge.trial, undefined);
  const mergeComment = f.readState().comments.at(-1).body;
  assert.match(mergeComment, /未做合并前试合：纯文档改动，无需跑测试/);
  f.assertCleanWorktreesAndDevCheckout();
});

test('mode 不是 local-test → 不试合并在评论写明 mode 说明', (t) => {
  const f = fixture(t, {
    verification: { mode: 'isolated-build', commands: { loop: 'node -e "process.exit(1)"' } },
  });
  const result = f.verdict();
  assert.deepEqual([result.state, result.code, result.merged], ['merged', 'LOW_RISK_AUTO_MERGE', true]);
  assertPr(f, { state: 'MERGED', labels: ['风险低'], mergeCalls: 1 });
  const mergeComment = f.readState().comments.at(-1).body;
  assert.match(mergeComment, /未做合并前试合：mode=isolated-build/);
  f.assertCleanWorktreesAndDevCheckout();
});

for (const { name, opts, code, labels } of [
  { name: 'MERGE_CONFLICT 挂需修改', opts: { prOverrides: { mergeable: 'CONFLICTING' } }, code: 'MERGE_CONFLICT', labels: ['需修改'] },
  { name: 'MISSING_ISSUE_REF 挂需修改', opts: { prOverrides: { body: 'no issue ref here' } }, code: 'MISSING_ISSUE_REF', labels: ['需修改'] },
  { name: 'SOURCE_LINEAGE_INVALID 挂需修改', opts: { badLineage: true }, code: 'SOURCE_LINEAGE_INVALID', labels: ['需修改'] },
  { name: 'SOURCE_BRANCH_MISSING 维持交人', opts: { prOverrides: { headRefName: '' } }, code: 'SOURCE_BRANCH_MISSING', labels: ['风险低', '待合并'] },
  { name: 'SOURCE_LINEAGE_UNKNOWN 维持交人', opts: { missingRepoPath: true }, code: 'SOURCE_LINEAGE_UNKNOWN', labels: ['风险低', '待合并'] },
]) {
  test(`现有门禁码：${name}`, (t) => {
    const f = fixture(t, opts);
    const result = f.verdict();
    assert.deepEqual([result.state, result.code], ['manual', code]);
    assertPr(f, { labels, mergeCalls: 0 });
    f.assertCleanWorktreesAndDevCheckout();
  });
}

test('loopctl config-resolve / preview-init / init 校验 verification 与确认单第 3 行', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-loop-u5-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const env = { ...process.env, XXN_LITE_LOOP_CONFIG_DIR: dir };

  const writeProj = (slug, data) => fs.writeFileSync(path.join(dir, 'projects', `${slug}.json`), JSON.stringify(data));

  // 1. local-test with neither commands nor skipReason -> init fails with MISSING_VERIFICATION
  writeProj('no-verify', {
    forge: 'github',
    defaultTier: 'L2',
    hubRepo: { name: 'demo', repo: 'acme/demo', path: '/tmp/demo', branch: 'main' },
    verification: { mode: 'local-test', commands: {} },
  });
  const resolved = runScript('loopctl', ['config-resolve', '--project', 'no-verify'], env);
  assert.equal(resolved.status, 0);
  assert.equal(resolved.json.thresholds.trialMergeTimeoutMinutes, 15);

  const badInit = runScript('loopctl', ['init', '--req', 'r-bad', '--project', 'no-verify'], env);
  assert.notEqual(badInit.status, 0);
  assert.equal(badInit.json?.code, 'MISSING_VERIFICATION');

  // 2. local-test with skipReason -> init succeeds & confirmSheet[2] shows 不试合（原因：...）
  const skipInit = runScript('loopctl', [
    'init', '--req', 'r-skip', '--project', 'no-verify',
    '--overrides', JSON.stringify({ verification: { skipReason: '暂无自动化测试' } }),
  ], env);
  assert.equal(skipInit.status, 0, skipInit.stderr || skipInit.stdout);
  assert.match(skipInit.json.confirmSheet[2], /不试合（原因：暂无自动化测试）/);

  // 3. local-test with command matched by repo path -> init succeeds & confirmSheet[2] shows command
  writeProj('by-path', {
    forge: 'github',
    defaultTier: 'L2',
    hubRepo: { name: 'demo', repo: 'acme/demo', path: '/work/custom-path', branch: 'main' },
    verification: { mode: 'local-test', commands: { '/work/custom-path': 'npm run verify' } },
  });
  const pathInit = runScript('loopctl', ['init', '--req', 'r-path', '--project', 'by-path'], env);
  assert.equal(pathInit.status, 0, pathInit.stderr || pathInit.stdout);
  assert.equal(pathInit.json.run.repos[0].verificationCommand, 'npm run verify');
  assert.match(pathInit.json.confirmSheet[2], /npm run verify/);

  // 4. isolated-build without commands or skipReason -> init succeeds & confirmSheet[2] shows 不试合
  writeProj('iso', {
    forge: 'github',
    defaultTier: 'L2',
    hubRepo: { name: 'demo', repo: 'acme/demo', path: '/tmp/demo', branch: 'main' },
    verification: { mode: 'isolated-build', commands: {} },
  });
  const isoInit = runScript('loopctl', ['init', '--req', 'r-iso', '--project', 'iso'], env);
  assert.equal(isoInit.status, 0, isoInit.stderr || isoInit.stdout);
  assert.match(isoInit.json.confirmSheet[2], /不试合（原因：mode=isolated-build）/);

  // 5. multi-repo under local-test where one linked repo lacks command & no skipReason -> MISSING_VERIFICATION
  writeProj('multi-missing', {
    forge: 'github',
    defaultTier: 'L2',
    hubRepo: { name: 'hub', repo: 'acme/hub', path: '/tmp/hub', branch: 'main' },
    linkedRepos: [{ name: 'web', repo: 'acme/web', path: '/tmp/web', branch: 'main' }],
    verification: { mode: 'local-test', commands: { hub: 'npm test' } },
  });
  const multiBad = runScript('loopctl', ['init', '--req', 'r-multi', '--project', 'multi-missing'], env);
  assert.notEqual(multiBad.status, 0);
  assert.equal(multiBad.json?.code, 'MISSING_VERIFICATION');
  assert.deepEqual(multiBad.json?.repos, ['web']);
});
