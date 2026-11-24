import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RISK_RULES, appendReview } from '../scripts/lib/review-journal.mjs';

const repo = 'acme/drill';
const req = 'drill';
const baseline = `loop/${req}`;
const label = `需求:${req}`;
const now = '2026-05-01T04:00:00Z';
const headSha = 'a'.repeat(40);
const mergeSha = 'b'.repeat(40);
const prUrl = `https://github.com/${repo}/pull/24`;
const lowRisk = 'contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0';

const fakeGh = '#!/usr/bin/env node\n' + String.raw`
import fs from 'node:fs';
const statePath = process.env.DRILL_FORGE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const [kind, cmd, id] = args;
const flag = (name) => args[args.indexOf(name) + 1];
const reply = (value) => { console.log(JSON.stringify(value)); process.exit(0); };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (kind === 'issue' && cmd === 'view' && state.issues[id]) reply(state.issues[id]);
if (kind === 'pr' && cmd === 'view' && id === '24') reply(state.pr);
if (kind === 'pr' && cmd === 'view' && state.prs?.[id]) reply(state.prs[id]);
if (kind === 'pr' && id === '24' && cmd === 'edit') {
  const remove = args.includes('--remove-label') ? flag('--remove-label').split(',') : [];
  const add = args.includes('--add-label') ? flag('--add-label').split(',') : [];
  state.pr.labels = [...state.pr.labels.filter((label) => !remove.includes(label)), ...add];
  save();
  reply(state.pr);
}
if (kind === 'pr' && id === '24' && cmd === 'merge') {
  state.mergeAttempted = true;
  save();
}
if (kind === 'api') {
  const endpoint = args.find((arg) => arg.startsWith('repos/'))?.split('?')[0];
  if (Object.hasOwn(state.branches ?? {}, endpoint)) reply(state.branches[endpoint]);
  if (endpoint?.endsWith('/issues')) reply([{ ...state.pr, number: 24, pull_request: {} }]);
  if (endpoint?.endsWith('/comments')) {
    const notes = (state.comments ??= {})[endpoint] ??= [];
    if (flag('--method') === 'POST') {
      const note = { ...JSON.parse(fs.readFileSync(0, 'utf8')), id: notes.length + 1, created_at: state.pr.updatedAt };
      notes.push(note);
      save();
      reply(note);
    }
    reply(notes);
  }
}
throw new Error('unexpected gh command: ' + process.argv.slice(2).join(' '));
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-loop-drill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runPath = path.join(dir, 'runs', `${req}.json`);
  const statePath = path.join(dir, 'forge.json');
  const ghPath = path.join(dir, 'gh.mjs');
  const env = { ...process.env, GH_BIN: ghPath, GH_HOST: 'github.com', XXN_LITE_LOOP_CONFIG_DIR: dir, DRILL_FORGE_STATE: statePath };
  fs.mkdirSync(path.dirname(runPath));
  fs.writeFileSync(ghPath, fakeGh, { mode: 0o755 });
  const run = {
    req, tier: 'L2', forge: 'github', user: 'dev', baselineBranch: baseline, autoMerge: true,
    hubRepo: { repo }, repos: [{ repo, branch: 'main' }],
    issues: { main: 20, subIssues: [21, 22] }, changes: [{ repo, id: 24 }],
  };
  const issue = (state, body = '业务子 Issue') => ({ state, body, labels: [label], updatedAt: now });
  const state = {
    issues: {
      20: issue('OPEN', '## 1. 现状\n阶段：P3 ｜ 状态：待合并\n主控：第 1 任 ｜ controller ｜ local\n本轮：空闲\n最近唤醒：05-01 12:00\n## 4. 近期完成与挂起\n无'),
      21: issue('CLOSED'),
      22: issue('OPEN'),
    },
    pr: {
      state: 'MERGED', labels: [label], body: 'Closes #22', updatedAt: now, url: prUrl,
      headRefOid: headSha, baseRefName: baseline, headRefName: 'dev/candidate', mergeCommit: { oid: mergeSha },
    },
  };
  const saveForge = () => fs.writeFileSync(statePath, JSON.stringify(state));
  const save = () => {
    fs.writeFileSync(runPath, JSON.stringify(run));
    saveForge();
  };
  const cli = (script, ...args) => {
    const bin = fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url));
    const stdout = execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
    return stdout.trim() ? JSON.parse(stdout) : {};
  };
  const tick = () => {
    save();
    const { runs } = cli('loopctl', 'tick', '--req', req, '--role', 'controller', '--now', now);
    const actions = runs?.[0].actions ?? [];
    assert.ok(!actions.some(({ kind }) => kind === 'facts-error'), JSON.stringify(actions));
    return actions;
  };
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return { dir, env, run, runPath, state, save, saveForge, readState, cli, tick };
}

test('D1 已合入 PR 仍有业务子 Issue 未关时提醒主控', async (t) => {
  const f = fixture(t);
  const merged = () => f.tick().find(({ code }) => code === 'PR_MERGED_NEXT_STEP');
  const taskKey = `pr-merged:${repo}#24@${mergeSha}`;
  await t.test('正文同时引用已关闭和未关闭的业务子 Issue', () => {
    f.state.pr.body = 'Closes #22\n联调时参考 #21';
    assert.deepEqual(merged()?.taskKeys, [taskKey]);
  });
  await t.test('第 4 节挂起条目有 PR 链接', () => {
    f.state.pr.body = 'Closes #22';
    f.state.issues[20].body += `\n- 挂起：${prUrl}`;
    assert.deepEqual(merged()?.taskKeys, [taskKey]);
  });
  await t.test('关联的业务子 Issue 已全关', () => {
    f.state.issues[20].body = f.state.issues[20].body.split('\n- 挂起：')[0];
    f.state.issues[22].state = 'CLOSED';
    f.state.pr.body = 'Closes #22\n联调时参考 #21';
    assert.equal(merged(), undefined);
  });
});

function approvedFixture(t, { baselineBranch = baseline, polluted = false, command = 'true', autoMerge = true } = {}) {
  const f = fixture(t);
  const work = path.join(f.dir, 'git');
  const origin = path.join(f.dir, 'origin.git');
  fs.mkdirSync(work);
  Object.assign(f.env, { GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_BIN: 'git' });
  const git = (...args) => execFileSync('git', args, { cwd: work, env: f.env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', baselineBranch);
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('commit', '-qm', 'baseline', '--allow-empty');
  const baseSha = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'dev/candidate');
  git('commit', '-qm', 'candidate', '--allow-empty');
  if (polluted) {
    git('switch', '-qc', 'test', baselineBranch);
    git('commit', '-qm', 'environment', '--allow-empty');
    git('switch', '-q', 'dev/candidate');
    git('merge', '-q', '--no-ff', '--no-edit', 'test');
  }
  git('clone', '-q', '--bare', work, origin);
  git('remote', 'add', 'origin', origin);
  Object.assign(f.state.pr, { state: 'OPEN', labels: [label, '待终审'], baseRefName: baselineBranch, headRefOid: git('rev-parse', 'HEAD') });
  Object.assign(f.run.repos[0], { path: work, baselineStartSha: baseSha });
  Object.assign(f.run, { baselineBranch, autoMerge, verification: { mode: 'local-test', commands: { [repo]: command } } });
  const forge = (subcommand, ...args) => f.cli('forge', subcommand, '--run', f.runPath, '--forge', 'github',
    '--repo', repo, '--id', '24', '--head-sha', f.state.pr.headRefOid, '--session', 'reviewer', ...args);
  const verdict = (risk = 'contract=1,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0') => {
    f.save();
    const review = forge('dispatch-review', '--role', 'controller');
    return forge('verdict', '--dispatch-id', review.dispatchId, '--nonce', review.nonce,
      '--round', String(review.round), '--conclusion', '通过', '--risk', risk);
  };
  return { ...f, baseSha, verdict };
}

for (const { name, options, code, labels } of [
  { name: '候选含 merge commit', options: { polluted: true }, code: 'SOURCE_CONTAINS_MERGE_COMMITS', labels: ['需修改'] },
  { name: '试合测试失败', options: { command: 'false' }, code: 'TRIAL_TEST_FAILED', labels: ['需修改'] },
  { name: '试合通过', options: { command: 'true' }, code: 'HIGH_RISK_MANUAL', labels: ['风险高', '待合并'] },
]) {
  test(`D2 高风险先过门禁和试合：${name}`, (t) => {
    const f = approvedFixture(t, options);
    const result = f.verdict();
    const state = f.readState();
    assert.equal(result.code, code);
    assert.deepEqual(state.pr.labels.sort(), [label, ...labels].sort());
    assert.equal(state.mergeAttempted, undefined);
    const body = state.comments[`repos/${repo}/issues/24/comments`].at(-1).body;
    if (code === 'HIGH_RISK_MANUAL') {
      assert.ok(body.includes(`合并前试合：true 通过（base ${f.baseSha.slice(0, 8)}）`), body);
      assert.match(body, /基线.*前移.*人工合入前/);
    } else {
      assert.doesNotMatch(body, /请人工确认合入/);
    }
  });
}

test('D2 高风险等待前置依赖时保留「风险高」', (t) => {
  const f = approvedFixture(t);
  f.state.pr.body = `${f.state.pr.body ?? ''}\nDepends-On: #23`;
  f.state.prs = { 23: { number: 23, state: 'OPEN', baseRefName: baseline, headRefName: 'dev/first', headRefOid: 'c'.repeat(40), body: '' } };
  const result = f.verdict();
  assert.equal(result.code, 'DEPENDS_ON_UNMERGED');
  assert.deepEqual(f.readState().pr.labels.sort(), [label, '风险高', '待合并'].sort());
});

test('D2 关闭自动合并时，人工交接说明跳过试合的原因', (t) => {
  const f = approvedFixture(t, { command: null, autoMerge: false });
  const result = f.verdict(lowRisk);
  assert.equal(result.code, 'AUTO_MERGE_DISABLED');
  const state = f.readState();
  assert.equal(state.mergeAttempted, undefined);
  assert.match(state.comments[`repos/${repo}/issues/24/comments`].at(-1).body, /未做合并前试合：未配置验证命令/);
});

for (const { name, options, code, labels } of [
  { name: '试合通过', options: {}, code: 'ENV_BRANCH_FORBIDDEN', labels: ['风险低', '待合并'] },
  { name: '试合测试失败', options: { command: 'false' }, code: 'TRIAL_TEST_FAILED', labels: ['需修改'] },
  { name: '候选含 merge commit', options: { polluted: true }, code: 'SOURCE_CONTAINS_MERGE_COMMITS', labels: ['需修改'] },
]) {
  test(`D7 L1 受保护基线先过门禁和试合：${name}`, (t) => {
    const f = approvedFixture(t, { baselineBranch: 'main', autoMerge: false, ...options });
    Object.assign(f.run, { tier: 'L1', issues: { tracking: 20 } });
    f.state.pr.body = 'Refs #20';
    const result = f.verdict(lowRisk);
    const state = f.readState();
    assert.equal(result.code, code);
    assert.deepEqual(state.pr.labels.sort(), [label, ...labels].sort());
    assert.equal(state.mergeAttempted, undefined);
    if (code === 'ENV_BRANCH_FORBIDDEN') {
      const body = state.comments[`repos/${repo}/issues/24/comments`].at(-1).body;
      assert.ok(body.includes(`合并前试合：true 通过（base ${f.baseSha.slice(0, 8)}）`), body);
      assert.match(body, /基线.*前移.*人工合入前/);
    }
  });
}

test('D7 dry-run 仍拒绝受保护基线，报错中的受保护分支去重', (t) => {
  const f = fixture(t);
  f.run.baselineBranch = 'main';
  f.save();
  assert.throws(() => f.cli('forge', 'change-merge', '--run', f.runPath, '--forge', 'github',
    '--repo', repo, '--id', '24', '--target', 'main', '--head-sha', headSha, '--dry-run'), (error) => {
    assert.equal(error.status, 2);
    const { code, message } = JSON.parse(error.stdout);
    assert.equal(code, 'ENV_BRANCH_FORBIDDEN');
    assert.match(message, /（main, master, test, uat）/);
    return true;
  });
});

test('D3 文档与血统检查都要求保留原候选分支和变更单', (t) => {
  const f = approvedFixture(t, { polluted: true });
  const result = f.verdict();
  assert.equal(result.code, 'SOURCE_CONTAINS_MERGE_COMMITS');
  const doc = fs.readFileSync(new URL('../references/review-and-dispatch.md', import.meta.url), 'utf8');
  const guidance = doc.split('\n').find((line) => line.includes('源分支包含相对基线新增的 merge commit'));
  for (const text of [guidance, result.message]) {
    assert.match(text, /原候选分支.*rebase.*--force-with-lease.*原 PR\/MR/);
    assert.doesNotMatch(text, /拉新分支/);
  }
});

test('D4 用户待确认或待裁决时仍补验当前远端基线', async (t) => {
  const f = fixture(t);
  const branch = `repos/${repo}/branches/${encodeURIComponent(baseline)}`;
  f.run.acceptance = { enabled: true };
  f.state.issues[22].state = 'CLOSED';
  f.state.pr.body = 'Closes #21 and #22';
  f.state.branches = { [branch]: { commit: { sha: mergeSha } } };
  f.save();
  const acceptance = f.cli('forge', 'acceptance', '--run', f.runPath, '--conclusion', '通过',
    '--report', '旧基线通过', '--model', 'fixture/acceptor', '--session', 'acceptor');
  assert.equal(acceptance.baselineSha, mergeSha);
  f.state.comments = f.readState().comments;
  const advancedSha = 'c'.repeat(40);
  f.state.branches[branch].commit.sha = advancedSha;
  const ledger = f.state.issues[20].body;
  for (const [status, expected] of [['待确认', advancedSha], ['待裁决', advancedSha], ['暂停', undefined], ['已归档', undefined]]) {
    await t.test(status, () => {
      f.state.issues[20].body = ledger.replace('状态：待合并', `状态：${status}`);
      const dispatch = f.tick().find(({ kind }) => kind === 'acceptance-dispatch');
      assert.equal(dispatch?.baselineSha, expected);
    });
  }
});

for (const [rules, expected] of [[[], '无'], [['提交前本人先看', '不得跳过终审'], '提交前本人先看']]) {
  test(`D5 初始台账可选确认点为「${expected}」，并列终审和验收模型`, (t) => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.dir, 'projects'));
    fs.writeFileSync(path.join(f.dir, 'projects', 'demo.json'), JSON.stringify({
      forge: 'github', defaultTier: 'L2', hubRepo: { name: 'demo', repo, branch: 'main' },
      verification: { mode: 'local-test', skipReason: 'fixture' },
    }));
    fs.writeFileSync(path.join(f.dir, 'me.json'), JSON.stringify({
      user: 'dev', rules, roleModels: { finalReviewer: 'fixture/final-model', acceptor: 'fixture/accept-model' },
    }));
    const init = f.cli('loopctl', 'init', '--req', req, '--project', 'demo', '--session', 'controller');
    assert.deepEqual(init.run.rules.effective, rules);
    const { body } = init.ledgers.find(({ key }) => key === 'main');
    const point = /可选确认点：([^｜]+)｜/.exec(body)?.[1].trim();
    assert.equal(point, expected);
    assert.match(body, /终审 fixture\/final-model/);
    assert.match(body, /验收 fixture\/accept-model/);
  });
}

test('D6 完结评论与归档从本地终审日志统计变更单和打回', (t) => {
  const f = fixture(t);
  f.run.review = { round: 1, rejectCount: 0 };
  f.state.issues[22].state = 'CLOSED';
  f.save();
  const risk = Object.fromEntries(RISK_RULES.map(({ key }) => [key, false]));
  for (const [round, conclusion] of [[1, '打回'], [2, '通过']]) {
    const dispatchId = `review-${round}`;
    appendReview(f.runPath, { type: 'dispatch', dispatchId, pr: { repo, id: 24 }, headSha, round,
      session: dispatchId, nonce: 'fixture', at: now });
    appendReview(f.runPath, { type: 'verdict', dispatchId, conclusion, risk });
  }
  const plan = f.cli('loopctl', 'teardown', '--req', req);
  assert.equal(plan.status, 'planned');
  assert.match(plan.closingComments[0].body, /终审记录：1 个变更单 \/ 累计打回 1 次/);
  f.state.issues[20].state = 'CLOSED';
  f.saveForge();
  const result = f.cli('loopctl', 'teardown', '--req', req, '--finalize', '--results', '{}');
  assert.equal(result.status, 'archived');
  assert.deepEqual([result.metrics.changes, result.metrics.rejects], [1, 1]);
});

test('高风险合并结果评论只说明一次人工合入，并保留试合结果', (t) => {
  const f = approvedFixture(t);
  assert.equal(f.verdict().code, 'HIGH_RISK_MANUAL');
  const body = f.readState().comments[`repos/${repo}/issues/24/comments`].at(-1).body;
  assert.equal([...body.matchAll(/终审判为高风险/g)].length, 1, body);
  assert.doesNotMatch(body, /请人工处理/);
  assert.ok(body.includes(`合并前试合：true 通过（base ${f.baseSha.slice(0, 8)}）`), body);
});

test('status 在没有进行中的需求时正常输出', (t) => {
  const f = fixture(t);
  const bin = fileURLToPath(new URL('../scripts/loopctl.mjs', import.meta.url));
  for (const extra of [[], ['--live']]) {
    const stdout = execFileSync(process.execPath, [bin, 'status', ...extra], { env: f.env, encoding: 'utf8' });
    assert.match(stdout, /当前没有进行中的需求|本机尚未完成初始配置/, stdout);
  }
});
