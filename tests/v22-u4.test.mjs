import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RISK_RULES, appendReview, readReviews } from '../scripts/lib/review-journal.mjs';

const repo = 'acme/loop';
const req = 'u4';
const baseline = `loop/${req}`;
const memberLabel = `需求:${req}`;
const now = '2024-05-01T04:00:00Z';
const lowRisk = 'contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0';

const fakeGh = `#!/usr/bin/env node\n` + String.raw`
import fs from 'node:fs';
const file = process.env.U4_FORGE_STATE;
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
  if (endpoint.endsWith('/issues')) {
    if (state.issueListError) fail(state.issueListError);
    reply([{ ...pr, number: 2, pull_request: {} }]);
  }
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
    if (state.labelError) fail('HTTP 503 label update unavailable');
    const remove = flag('--remove-label').split(',');
    const add = flag('--add-label').split(',').filter(Boolean);
    pr.labels = [...pr.labels.filter((label) => !remove.includes(label)), ...add];
    save();
    reply(pr);
  }
  if (cmd === 'merge') {
    state.mergeCalls += 1;
    save();
    fail('HTTP 403 Forbidden');
  }
}
fail('unexpected gh command: ' + args.join(' '));
`;

function fixture(t, { polluted = true, autoMerge = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-loop-u4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, 'git');
  fs.mkdirSync(work);
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', baseline);
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('commit', '-qm', 'baseline', '--allow-empty');
  const baselineStartSha = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'test');
  git('commit', '-qm', 'test environment change', '--allow-empty');
  git('switch', '-qc', 'dev/candidate', baseline);
  git('commit', '-qm', 'candidate change', '--allow-empty');
  if (polluted) git('merge', '-q', '--no-ff', '--no-edit', 'test');
  const headSha = git('rev-parse', 'HEAD');
  const origin = path.join(dir, 'origin.git');
  git('clone', '-q', '--bare', work, origin);
  git('remote', 'add', 'origin', origin);

  const runs = path.join(dir, 'runs');
  fs.mkdirSync(runs);
  const runPath = path.join(runs, `${req}.json`);
  const statePath = path.join(dir, 'forge.json');
  const ghPath = path.join(dir, 'gh.mjs');
  fs.writeFileSync(ghPath, fakeGh, { mode: 0o755 });
  Object.assign(env, { GH_BIN: ghPath, GH_HOST: 'github.com', GIT_BIN: 'git', XXN_LITE_LOOP_CONFIG_DIR: dir, U4_FORGE_STATE: statePath });
  fs.writeFileSync(runPath, JSON.stringify({
    req, tier: 'L2', forge: 'github', user: 'dev', baselineBranch: baseline, autoMerge,
    hubRepo: { repo }, repos: [{ repo, branch: 'main', path: work, baselineStartSha }],
    issues: { main: 1 }, changes: [{ repo, id: 2 }],
  }));
  const ledgerBody = '## 1. 基本信息\n阶段：P3 ｜ 状态：未开始\n主控：第 1 任 ｜ controller ｜ local\n本轮：空闲\n最近唤醒：05-01 12:00\n';
  fs.writeFileSync(statePath, JSON.stringify({
    issue: { state: 'OPEN', labels: [], body: ledgerBody, updatedAt: now },
    pr: { state: 'OPEN', labels: [memberLabel, '待终审'], body: 'Refs #1', updatedAt: now,
      headRefOid: headSha, baseRefName: baseline, headRefName: 'dev/candidate' },
    comments: [], mergeCalls: 0,
  }));
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const update = (edit) => {
    const state = readState();
    edit(state);
    fs.writeFileSync(statePath, JSON.stringify(state));
  };
  function run(script, ...args) {
    const bin = fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url));
    const stdout = execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
    return stdout.trim() ? JSON.parse(stdout) : {};
  }
  const forge = (subcommand, ...args) => run('forge', subcommand, '--run', runPath, '--forge', 'github',
    '--repo', repo, '--id', '2', '--head-sha', headSha, '--session', 'reviewer', ...args);
  const review = forge('dispatch-review', '--role', 'controller');
  return {
    update, readState, baselineStartSha, runPath,
    verdict: (risk = lowRisk) => forge('verdict', '--dispatch-id', review.dispatchId, '--nonce', review.nonce,
      '--round', String(review.round), '--conclusion', '通过', '--risk', risk),
    tick: () => run('loopctl', 'tick', '--req', req, '--role', 'controller', '--apply', '--now', now).runs?.[0].actions ?? [],
  };
}

function assertOpen(fixture, labels, mergeCalls = 0) {
  const state = fixture.readState();
  assert.deepEqual({ state: state.pr.state, labels: state.pr.labels.sort(), mergeCalls: state.mergeCalls },
    { state: 'OPEN', labels: [memberLabel, ...labels].sort(), mergeCalls });
}

test('终审通过但候选混入 test 的 merge commit 时标需修改', (t) => {
  const f = fixture(t);
  f.update(({ pr }) => pr.labels.push('风险低', '待合并'));
  const result = f.verdict();
  assert.equal(result.code, 'SOURCE_CONTAINS_MERGE_COMMITS');
  assertOpen(f, ['需修改']);
  f.tick();
  assertOpen(f, ['需修改']);
});

test('临时 Forge 故障恢复后，tick 重试发现污染就停止等待', (t) => {
  const f = fixture(t);
  f.update((state) => { state.issueListError = 'HTTP 503 service unavailable'; });
  const waiting = f.verdict();
  assert.deepEqual([waiting.state, waiting.code], ['waiting', 'FORGE_FACTS_UNAVAILABLE']);
  assertOpen(f, ['风险低', '待合并']);
  f.update((state) => { delete state.issueListError; });
  assert.ok(f.tick().some(({ kind, code }) => kind === 'retry-merge' && code === 'SOURCE_CONTAINS_MERGE_COMMITS'));
  assertOpen(f, ['需修改']);
  assert.ok(f.tick().every(({ kind }) => kind !== 'retry-merge'));
});

test('tick 按同一候选的门禁结果补写失败的标签并修正旧待合并标签', (t) => {
  const f = fixture(t);
  f.update((state) => { state.labelError = true; });
  const result = f.verdict();
  assert.equal(result.code, 'SOURCE_CONTAINS_MERGE_COMMITS');
  assert.ok(result.followupError);
  assertOpen(f, ['终审中']);
  f.update((state) => { delete state.labelError; });
  assert.ok(f.tick().every(({ code }) => code !== 'REVIEW_AUTHORIZATION_REQUIRED'));
  assertOpen(f, ['需修改']);
  f.update(({ pr }) => { pr.labels = [memberLabel, '风险低', '待合并']; });
  f.tick();
  assertOpen(f, ['需修改']);
  f.update(({ pr }) => { pr.headRefOid = f.baselineStartSha; pr.labels = [memberLabel, '终审中']; });
  assert.ok(f.tick().some(({ code }) => code === 'REVIEW_TIMEOUT'));
  assertOpen(f, ['待终审']);
  assert.ok(f.tick().some(({ kind, code }) => kind === 'review-dispatch' && code === 'dispatch'));
});

const highRisk = lowRisk.replace('contract=0', 'contract=1');

test('C1/Q9：同时命中高风险与熔断，verdict 和 tick 补写都挂风险高、待合并', (t) => {
  const f = fixture(t, { polluted: false });
  const { headSha } = readReviews(f.runPath).at(-1);
  const risk = Object.fromEntries(RISK_RULES.map(({ key }) => [key, false]));
  f.update(({ comments }) => {
    for (const round of [1, 2]) {
      const verdict = { dispatchId: `rejected-${round}`, round, conclusion: '打回', risk, headSha, session: `old-review-${round}` };
      comments.push({ id: 100 + round, body: `<!-- liteloop:verdict ${JSON.stringify(verdict)} -->`, created_at: now });
    }
  });
  const result = f.verdict(highRisk);
  assert.equal(result.code, 'REJECT_FUSE_FULL_REVIEW');
  assert.deepEqual(readReviews(f.runPath).at(-1).merge.reasonCodes, ['REJECT_FUSE_FULL_REVIEW', 'HIGH_RISK_MANUAL']);
  assertOpen(f, ['风险高', '待合并']);
  f.update(({ pr }) => { pr.labels = [memberLabel, '终审中']; });
  f.tick();
  assertOpen(f, ['风险高', '待合并']);
});

test('C1/Q9：补写旧登记时，次要原因里的需修改优先于高风险', (t) => {
  const f = fixture(t);
  const { dispatchId } = readReviews(f.runPath).at(-1);
  const risk = Object.fromEntries(RISK_RULES.map(({ key }) => [key, key === 'contract']));
  appendReview(f.runPath, { type: 'verdict', dispatchId, conclusion: '通过', risk });
  appendReview(f.runPath, { type: 'merge-result', dispatchId, state: 'manual', code: 'HIGH_RISK_MANUAL',
    reasonCodes: ['HIGH_RISK_MANUAL', 'SOURCE_CONTAINS_MERGE_COMMITS'] });
  f.tick();
  assertOpen(f, ['需修改']);
});

for (const { code, autoMerge, labels, risk, mergeCalls } of [
  { code: 'EXEC_FAILED', labels: ['风险低', '待合并'], mergeCalls: 1 },
  { code: 'AUTO_MERGE_DISABLED', autoMerge: false, labels: ['风险低', '待合并'] },
  { code: 'HIGH_RISK_MANUAL', labels: ['风险高', '待合并'], risk: highRisk },
]) {
  test(`${code} 维持人工合并标签`, (t) => {
    const f = fixture(t, { polluted: false, autoMerge });
    const result = f.verdict(risk);
    assert.deepEqual([result.state, result.code], ['manual', code]);
    assertOpen(f, labels, mergeCalls);
    f.tick();
    assertOpen(f, labels, mergeCalls);
  });
}
