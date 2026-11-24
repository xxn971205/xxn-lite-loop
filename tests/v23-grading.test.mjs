import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendReview, readReviews } from '../scripts/lib/review-journal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGE = path.join(ROOT, 'scripts', 'forge.mjs');
const LOOPCTL = path.join(ROOT, 'scripts', 'loopctl.mjs');
const REPO = 'acme/loop';
const HEAD_SHA = 'a'.repeat(40);
const BASELINE = 'loop/v23-demo';
const RISK_LOW_FLAG = 'contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0';
const LOW_RISK = {
  contract: false, hotFile: false, migration: false,
  switchDefault: false, signature: false, foundation: false,
};

const BASE_ENV = { ...process.env };
for (const key of ['GITLAB_HOST', 'GH_HOST', 'GH_BIN', 'GLAB_BIN', 'GIT_BIN', 'XXN_LITE_LOOP_CONFIG_DIR']) {
  delete BASE_ENV[key];
}

const FAKE_GH = `#!/usr/bin/env node
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
  if (/^repos\\/[^/]+\\/[^/]+\\/issues\\/\\d+\\/comments$/.test(p)) {
    if (opt.method === 'POST') {
      if (state.failVerdictPost && p.endsWith('/10/comments') && JSON.parse(stdin).body.includes('liteloop:verdict')) {
        fail('HTTP 503 verdict publish');
      }
      const notes = (state.comments[p] ??= []);
      const note = { id: notes.length + 100, body: JSON.parse(stdin).body, created_at: '2026-11-24T04:00:00Z' };
      notes.push(note);
      save();
      reply(note);
    }
    if (state.failReads && p.endsWith('/10/comments')) fail('HTTP 503 fixture');
    reply(state.comments[p] ?? []);
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/issues$/.test(p)) {
    reply([
      ...Object.entries(state.issues).map(([k, v]) => ({ ...v, number: Number(k.split('#')[1]) })),
      ...Object.entries(state.prs).map(([k, v]) => ({ ...v, number: Number(k.split('#')[1]), pull_request: {} })),
    ]);
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/branches\\//.test(p)) {
    reply({ commit: { sha: '${HEAD_SHA}' } });
  }
  fail('unknown api ' + p);
}
if (args[0] === 'issue' && ['view', 'edit'].includes(args[1])) {
  const issue = state.issues[repoArg() + '#' + args[2]];
  if (!issue) fail('not found');
  if (args[1] === 'edit' && args.includes('--body')) {
    issue.body = args[args.indexOf('--body') + 1];
    save();
  }
  reply(issue);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = state.prs[repoArg() + '#' + args[2]];
  if (!pr) fail('not found');
  reply(pr);
}
if (args[0] === 'pr' && args[1] === 'edit') {
  if (state.failLabelEdit && args[2] === '10') fail('HTTP 503 label update');
  const pr = state.prs[repoArg() + '#' + args[2]];
  if (!pr) fail('not found');
  const remove = args.includes('--remove-label') ? args[args.indexOf('--remove-label') + 1].split(',') : [];
  const add = args.includes('--add-label') ? args[args.indexOf('--add-label') + 1].split(',') : [];
  pr.labels = [...pr.labels.filter((l) => !remove.includes(l.name ?? l)), ...add.map((name) => ({ name }))];
  save();
  reply(pr);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const pr = state.prs[repoArg() + '#' + args[2]];
  if (!pr) fail('not found');
  pr.state = 'MERGED';
  pr.mergeCommit = { oid: 'merge-sha' };
  save();
  process.exit(0);
}
fail('unknown ' + args.join(' '));
`;

function createFixture(t, { autoMerge = true, thresholds } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-v23-grading-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ghBin = path.join(dir, 'fake-gh.mjs');
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'calls.jsonl');
  const configDir = path.join(dir, 'config');
  const req = 'v23-demo';
  const runPath = path.join(configDir, 'runs', `${req}.json`);
  const journalPath = path.join(configDir, 'runs', `${req}.reviews.jsonl`);
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  fs.writeFileSync(ghBin, FAKE_GH, 'utf8');
  fs.chmodSync(ghBin, 0o755);

  const run = {
    req,
    title: 'v2.3 终审分级测试',
    tier: 'L2',
    user: 'tester',
    forge: 'github',
    autoMerge,
    baselineBranch: BASELINE,
    hubRepo: { name: 'loop', repo: REPO, branch: 'main' },
    repos: [{ name: 'loop', repo: REPO, branch: 'main' }],
    issues: { main: 7, subIssues: [15] },
    ledgers: [{ key: 'main', repo: REPO, issue: { id: 7 } }],
    controller: { sessionId: 'ctrl-1' },
    scheduledTasks: [],
    worktrees: [],
    status: 'active',
    ...(thresholds ? { thresholds } : {}),
  };
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf8');

  const noteKey = `repos/${REPO}/issues/10/comments`;
  const initialState = {
    issues: {
      [`${REPO}#7`]: {
        number: 7,
        title: '【追踪】v23-demo',
        state: 'OPEN',
        body: '## 1. 当前状态\n主控：第 1 任 ｜ ctrl-1\n本轮：空闲\n## 3. 当前进行中\n办理 #15\n',
        labels: [{ name: `需求:${req}` }],
        updatedAt: '2026-11-24T00:00:00Z',
        url: `https://github.com/${REPO}/issues/7`,
      },
      [`${REPO}#15`]: {
        number: 15,
        title: '子任务',
        state: 'OPEN',
        body: '子任务',
        labels: [{ name: `需求:${req}` }],
        updatedAt: '2026-11-24T00:00:00Z',
        url: `https://github.com/${REPO}/issues/15`,
      },
    },
    prs: {
      [`${REPO}#10`]: {
        state: 'OPEN',
        isDraft: false,
        headRefOid: HEAD_SHA,
        headRefName: 'feat/v23',
        baseRefName: BASELINE,
        body: '关联 #15',
        updatedAt: '2026-11-24T04:00:00Z',
        labels: [{ name: '待终审' }, { name: `需求:${req}` }],
      },
    },
    comments: {},
  };
  fs.writeFileSync(stateFile, JSON.stringify(initialState), 'utf8');
  fs.writeFileSync(logFile, '', 'utf8');

  const env = {
    ...BASE_ENV,
    GH_BIN: ghBin,
    FAKE_FORGE_STATE: stateFile,
    FAKE_FORGE_LOG: logFile,
    XXN_LITE_LOOP_CONFIG_DIR: configDir,
  };

  const runCli = (script, args) => {
    const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
    let json = {};
    try { json = JSON.parse(res.stdout); } catch {}
    return { code: res.status, json, stdout: res.stdout, stderr: res.stderr };
  };

  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s), 'utf8');
  const readCalls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const clearCalls = () => fs.writeFileSync(logFile, '', 'utf8');
  const readJournal = () => fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const labels = () => readState().prs[`${REPO}#10`].labels.map((l) => l.name ?? l);
  const comments = () => readState().comments[noteKey] ?? [];

  const requeue = () => {
    const s = readState();
    s.prs[`${REPO}#10`].labels = [{ name: '待终审' }, { name: `需求:${req}` }];
    writeState(s);
  };

  const dispatch = (session) => {
    const res = runCli(FORGE, [
      'dispatch-review', '--run', runPath, '--role', 'controller',
      '--forge', 'github', '--repo', REPO, '--id', '10',
      '--head-sha', HEAD_SHA, '--session', session,
    ]);
    assert.equal(res.code, 0, `dispatch-review failed: ${res.stdout}`);
    clearCalls();
    return res.json;
  };

  const verdict = (disp, conclusion, extra = []) => runCli(FORGE, [
    'verdict', '--run', runPath, '--forge', 'github', '--repo', REPO, '--id', '10',
    '--dispatch-id', disp.dispatchId, '--nonce', disp.nonce,
    '--round', String(disp.round), '--conclusion', conclusion,
    '--risk', RISK_LOW_FLAG, '--head-sha', HEAD_SHA, '--session', disp.session,
    ...extra,
  ]);

  const loopctl = (args) => runCli(LOOPCTL, [...args, '--config-dir', configDir]);
  const tickDispatch = (apply = false) => {
    const res = loopctl(['tick', '--req', req, '--role', 'controller', '--now', '2026-11-24T05:00:00Z', ...(apply ? ['--apply'] : [])]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const actions = res.json.runs?.[0]?.actions ?? [];
    const action = actions.find((item) => item.kind === 'review-dispatch' && item.code === 'dispatch');
    assert.ok(action, `missing review-dispatch action: ${JSON.stringify(actions)}`);
    return action;
  };
  const snapshot = () => ({
    journal: fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : '',
    comments: comments(),
    labels: labels(),
  });

  return {
    req, runPath, journalPath, configDir, noteKey,
    readState, writeState, readCalls, clearCalls, readJournal, labels, comments,
    requeue, dispatch, verdict, loopctl, tickDispatch, snapshot,
  };
}

function parseVerdictMeta(body) {
  const m = /^<!-- liteloop:verdict ([^\r\n]+?) -->$/m.exec(body);
  assert.ok(m, `missing liteloop:verdict metadata in:\n${body}`);
  return JSON.parse(m[1]);
}

test('AC1：打回时必改项缺等级，报 MUST_FIX_GRADE_MISSING，且标签不变、不发评论、不写日志', (t) => {
  const f = createFixture(t);
  const disp = f.dispatch('rev-no-grade');
  const journalBefore = f.readJournal().length;
  const commentsBefore = f.comments().length;
  const labelsBefore = f.labels();

  const res = f.verdict(disp, '打回', [
    '--must-fix', '1. 订单提交空列表返回 500\n   入口：POST /api/orders\n   证据：src/order.ts:42 直接读 items[0]',
  ]);

  assert.equal(res.code, 2, res.stdout);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, 'MUST_FIX_GRADE_MISSING');
  assert.deepEqual(f.labels(), labelsBefore);
  assert.equal(f.readCalls().length, 0);
  assert.equal(f.comments().length, commentsBefore);
  assert.equal(f.readJournal().length, journalBefore);
});

test('AC2：第 1、2 轮打回时必改项含 P2 可正常打回，且等级归一与分级统计正确', (t) => {
  const f = createFixture(t);

  // 第 1 轮：使用 P2：写法，应归一成【P2】并正常打回
  const d1 = f.dispatch('rev-r1');
  const r1 = f.verdict(d1, '打回', [
    '--must-fix', '1. P2：列表页空态提示文案不清\n   入口：订单列表页 GET /orders\n   证据：src/orders/list.tsx:18 返回空 div',
  ]);
  assert.equal(r1.code, 0, r1.stdout);
  assert.equal(r1.json.code, 'REVIEW_REJECTED');
  assert.deepEqual(f.labels(), [`需求:${f.req}`, '需修改']);
  const body1 = f.comments().at(-1).body;
  assert.match(body1, /结论：打回（第 1 轮）\n问题分级：P0 0 · P1 0 · P2 1\n/);
  assert.match(body1, /1\. 【P2】列表页空态提示文案不清/);
  assert.match(body1, /遗留建议：\n无\n/);
  assert.deepEqual(parseVerdictMeta(body1).grades, { p0: 0, p1: 0, p2: 1 });
  assert.deepEqual(readReviews(f.runPath)[0].verdict.grades, { p0: 0, p1: 0, p2: 1 });

  // 第 2 轮：必改项含 P1 + P2，同时附带 1 条 P2 遗留建议
  f.requeue();
  const d2 = f.dispatch('rev-r2');
  const r2 = f.verdict(d2, '打回', [
    '--must-fix', [
      '1. 【P1】取消订单未释放库存',
      '   入口：POST /api/orders/:id/cancel',
      '   证据：src/order/cancel.ts:18 未调用 release',
      '2. P2: 重复校验逻辑可抽取',
      '   入口：POST /api/orders',
      '   证据：src/order/create.ts:20 与 update.ts:15 重复',
    ].join('\n'),
    '--remaining', '1. P2：补充错误日志上下文\n   入口：POST /api/orders\n   证据：src/order/create.ts:55 仅打印 err.message',
  ]);
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(r2.json.code, 'REVIEW_REJECTED');
  assert.deepEqual(f.labels(), [`需求:${f.req}`, '需修改']);
  const body2 = f.comments().at(-1).body;
  assert.match(body2, /结论：打回（第 2 轮）\n问题分级：P0 0 · P1 1 · P2 2\n/);
  assert.match(body2, /2\. 【P2】重复校验逻辑可抽取/);
  assert.match(body2, /遗留建议：\n1\. 【P2】补充错误日志上下文/);
  assert.deepEqual(parseVerdictMeta(body2).grades, { p0: 0, p1: 1, p2: 2 });
  assert.deepEqual(readReviews(f.runPath)[1].verdict.grades, { p0: 0, p1: 1, p2: 2 });
});

test('AC3：熔断后（已打回 2 次）打回含 P2 报 MUST_FIX_P2_AFTER_FUSE，改为仅 P0/P1 后同一派审可正常打回', (t) => {
  const f = createFixture(t);

  for (const session of ['rev-f1', 'rev-f2']) {
    const d = f.dispatch(session);
    const r = f.verdict(d, '打回', [
      '--must-fix', '1. 【P1】主链路校验缺失\n   入口：POST /api/orders\n   证据：src/order.ts:10 未校验数量',
    ]);
    assert.equal(r.code, 0, r.stdout);
    f.requeue();
  }

  // 第 3 轮（已累计打回 2 次，达到熔断阈值）：含 P2 的打回必须被拒
  const d3 = f.dispatch('rev-f3');
  const journalBefore = f.readJournal().length;
  const commentsBefore = f.comments().length;
  const labelsBefore = f.labels();

  const blocked = f.verdict(d3, '打回', [
    '--must-fix', [
      '1. 【P0】提交空数组导致服务崩溃',
      '   入口：POST /api/orders',
      '   证据：src/order.ts:42 读取 items[0] 抛 TypeError',
      '2. 【P2】注释措辞略含糊',
      '   入口：POST /api/orders',
      '   证据：src/order.ts:5 注释未更新',
    ].join('\n'),
  ]);
  assert.equal(blocked.code, 2, blocked.stdout);
  assert.equal(blocked.json.ok, false);
  assert.equal(blocked.json.code, 'MUST_FIX_P2_AFTER_FUSE');
  assert.match(blocked.json.message, /--remaining/);
  assert.deepEqual(f.labels(), labelsBefore);
  assert.equal(f.comments().length, commentsBefore);
  assert.equal(f.readJournal().length, journalBefore);

  // 同样内容把 P2 挪到 --remaining，必改项仅保留 P0、P1，使用同一派审正常打回
  const ok = f.verdict(d3, '打回', [
    '--must-fix', [
      '1. 【P0】提交空数组导致服务崩溃',
      '   入口：POST /api/orders',
      '   证据：src/order.ts:42 读取 items[0] 抛 TypeError',
      '2. 【P1】取消订单漏释放库存',
      '   入口：POST /api/orders/:id/cancel',
      '   证据：src/order/cancel.ts:18 缺少 release',
    ].join('\n'),
    '--remaining', '1. 【P2】注释措辞略含糊\n   入口：POST /api/orders\n   证据：src/order.ts:5 注释未更新',
  ]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.json.code, 'REVIEW_REJECTED');
  assert.deepEqual(f.labels(), [`需求:${f.req}`, '需修改']);
  const body3 = f.comments().at(-1).body;
  assert.match(body3, /结论：打回（第 3 轮）\n问题分级：P0 1 · P1 1 · P2 1\n/);
  assert.deepEqual(parseVerdictMeta(body3).grades, { p0: 1, p1: 1, p2: 1 });
});

test('AC4：熔断后只剩 P2 给「通过」并带遗留建议，结论登记且仍交人裁决（REJECT_FUSE_FULL_REVIEW）', (t) => {
  const f = createFixture(t, { autoMerge: true });

  for (const session of ['rev-p1', 'rev-p2']) {
    const d = f.dispatch(session);
    const r = f.verdict(d, '打回', [
      '--must-fix', '1. 【P1】缺少边界校验\n   入口：POST /api/orders\n   证据：src/order.ts:12 允许负数量',
    ]);
    assert.equal(r.code, 0, r.stdout);
    f.requeue();
  }

  const d3 = f.dispatch('rev-p3');
  const res = f.verdict(d3, '通过', [
    '--remaining', '1. P2：命名可进一步贴合领域术语\n   入口：GET /api/orders\n   证据：src/order/query.ts:8 函数名过泛',
  ]);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.conclusion, '通过');
  assert.equal(res.json.state, 'manual');
  assert.equal(res.json.code, 'REJECT_FUSE_FULL_REVIEW');
  assert.equal(f.readState().prs[`${REPO}#10`].state, 'OPEN');
  assert.deepEqual(f.labels(), [`需求:${f.req}`, '待合并']);

  const verdictNote = f.comments().find((n) => n.body.includes('<!-- liteloop:verdict ') && n.body.includes(d3.dispatchId));
  assert.ok(verdictNote, '应发布终审审计评论');
  assert.match(verdictNote.body, /结论：通过（第 3 轮）\n问题分级：P0 0 · P1 0 · P2 1\n/);
  assert.match(verdictNote.body, /遗留建议：\n1\. 【P2】命名可进一步贴合领域术语/);
  assert.deepEqual(parseVerdictMeta(verdictNote.body).grades, { p0: 0, p1: 0, p2: 1 });
});

test('AC5：遗留建议中出现 P0 或 P1，报 REMAINING_GRADE_TOO_HIGH，且不产生副作用', (t) => {
  const f = createFixture(t);
  const d1 = f.dispatch('rev-rem-p0');
  const journalBefore = f.readJournal().length;
  const commentsBefore = f.comments().length;
  const labelsBefore = f.labels();

  const resP0 = f.verdict(d1, '通过', [
    '--remaining', '1. 【P0】支付回调跳过签名校验\n   入口：POST /webhook/pay\n   证据：src/pay.ts:30 直接返回 true',
  ]);
  assert.equal(resP0.code, 2, resP0.stdout);
  assert.equal(resP0.json.ok, false);
  assert.equal(resP0.json.code, 'REMAINING_GRADE_TOO_HIGH');
  assert.deepEqual(f.labels(), labelsBefore);
  assert.equal(f.readCalls().length, 0);
  assert.equal(f.comments().length, commentsBefore);
  assert.equal(f.readJournal().length, journalBefore);

  const resP1 = f.verdict(d1, '打回', [
    '--must-fix', '1. 【P1】主流程缺陷\n   入口：POST /api/orders\n   证据：src/order.ts:11',
    '--remaining', '1. P1：另一处必填参数未校验\n   入口：POST /api/orders\n   证据：src/order.ts:22',
  ]);
  assert.equal(resP1.code, 2, resP1.stdout);
  assert.equal(resP1.json.code, 'REMAINING_GRADE_TOO_HIGH');
  assert.equal(f.readCalls().length, 0);
  assert.equal(f.readJournal().length, journalBefore);
});

test('AC6：归档时 teardown.metrics.grades 汇总准确且完结评论含分级合计；旧日志无 grades 时按 0 计', (t) => {
  // 场景 1：混合新旧日志（含 P0/P1/P2 以及一条无 grades 字段的旧记录）
  const f1 = createFixture(t);
  appendReview(f1.runPath, {
    type: 'dispatch', dispatchId: 'd-old', pr: { repo: REPO, id: 10 }, round: 1,
    headSha: HEAD_SHA, session: 'r-old', nonce: 'n-old', at: '2026-11-24T01:00:00Z',
  });
  appendReview(f1.runPath, { type: 'verdict', dispatchId: 'd-old', conclusion: '打回', risk: LOW_RISK });
  appendReview(f1.runPath, {
    type: 'dispatch', dispatchId: 'd-new-1', pr: { repo: REPO, id: 10 }, round: 2,
    headSha: HEAD_SHA, session: 'r-new-1', nonce: 'n-new-1', at: '2026-11-24T02:00:00Z',
  });
  appendReview(f1.runPath, {
    type: 'verdict', dispatchId: 'd-new-1', conclusion: '打回', risk: LOW_RISK,
    grades: { p0: 1, p1: 2, p2: 1 },
  });
  appendReview(f1.runPath, {
    type: 'dispatch', dispatchId: 'd-new-2', pr: { repo: REPO, id: 10 }, round: 3,
    headSha: HEAD_SHA, session: 'r-new-2', nonce: 'n-new-2', at: '2026-11-24T03:00:00Z',
  });
  appendReview(f1.runPath, {
    type: 'verdict', dispatchId: 'd-new-2', conclusion: '通过', risk: LOW_RISK,
    grades: { p0: 0, p1: 0, p2: 2 },
  });
  appendReview(f1.runPath, {
    type: 'merge-result', dispatchId: 'd-new-2', state: 'manual', code: 'REJECT_FUSE_FULL_REVIEW',
  });

  const s1Open = f1.readState();
  s1Open.prs[`${REPO}#10`].state = 'MERGED';
  s1Open.issues[`${REPO}#15`].state = 'CLOSED';
  f1.writeState(s1Open);
  const plan1 = f1.loopctl(['teardown', '--req', f1.req]);
  assert.equal(plan1.code, 0, plan1.stdout + plan1.stderr);
  assert.match(plan1.json.closingComments[0].body, /终审记录：1 个变更单 \/ 累计打回 2 次 \/ 分级合计 P0 1 · P1 2 · P2 3/);

  const s1 = f1.readState();
  s1.issues[`${REPO}#7`].state = 'CLOSED';
  f1.writeState(s1);
  const fin1 = f1.loopctl(['teardown', '--req', f1.req, '--finalize', '--results', '{}']);
  assert.equal(fin1.code, 0, fin1.stdout + fin1.stderr);
  assert.deepEqual(fin1.json.metrics, {
    changes: 1, rejects: 2, fuses: 1, timeouts: null,
    grades: { p0: 1, p1: 2, p2: 3 },
  });
  const archived1 = JSON.parse(fs.readFileSync(fin1.json.archivePath, 'utf8'));
  assert.deepEqual(archived1.teardown.metrics, fin1.json.metrics);

  // 场景 2：全是无 grades 字段的旧日志，按 0 计不报错
  const f2 = createFixture(t);
  appendReview(f2.runPath, {
    type: 'dispatch', dispatchId: 'legacy-1', pr: { repo: REPO, id: 10 }, round: 1,
    headSha: HEAD_SHA, session: 'legacy-r1', nonce: 'n1', at: '2026-11-24T01:00:00Z',
  });
  appendReview(f2.runPath, { type: 'verdict', dispatchId: 'legacy-1', conclusion: '打回', risk: LOW_RISK });
  const s2Open = f2.readState();
  s2Open.prs[`${REPO}#10`].state = 'MERGED';
  s2Open.issues[`${REPO}#15`].state = 'CLOSED';
  f2.writeState(s2Open);
  const plan2 = f2.loopctl(['teardown', '--req', f2.req]);
  assert.equal(plan2.code, 0, plan2.stdout + plan2.stderr);
  assert.match(plan2.json.closingComments[0].body, /分级合计 P0 0 · P1 0 · P2 0/);

  const s2 = f2.readState();
  s2.issues[`${REPO}#7`].state = 'CLOSED';
  f2.writeState(s2);
  const fin2 = f2.loopctl(['teardown', '--req', f2.req, '--finalize', '--results', '{}']);
  assert.equal(fin2.code, 0, fin2.stdout + fin2.stderr);
  assert.deepEqual(fin2.json.metrics.grades, { p0: 0, p1: 0, p2: 0 });
});

test('边界补充：非熔断通过带 P2 遗留建议不阻塞自动合入；遗留建议缺等级或入口证据被拒；版本号与用法同步', (t) => {
  const f = createFixture(t, { autoMerge: true });
  const d1 = f.dispatch('rev-edge');

  const noGrade = f.verdict(d1, '通过', [
    '--remaining', '1. 仅写建议没标等级\n   入口：GET /api/orders\n   证据：src/order.ts:10',
  ]);
  assert.equal(noGrade.code, 2, noGrade.stdout);
  assert.equal(noGrade.json.code, 'MUST_FIX_GRADE_MISSING');

  const noEvidence = f.verdict(d1, '通过', [
    '--remaining', '1. 【P2】缺少证据\n   入口：GET /api/orders',
  ]);
  assert.equal(noEvidence.code, 2, noEvidence.stdout);
  assert.equal(noEvidence.json.code, 'MUST_FIX_INCOMPLETE');

  const passWithRem = f.verdict(d1, '通过', [
    '--remaining', '1. P2: 后续可抽取公共格式化函数\n   入口：GET /api/orders\n   证据：src/order.ts:60 重复拼接日期',
  ]);
  assert.equal(passWithRem.code, 0, passWithRem.stdout);
  assert.equal(passWithRem.json.state, 'merged');
  assert.equal(passWithRem.json.code, 'LOW_RISK_AUTO_MERGE');
  assert.deepEqual(passWithRem.json.grades, { p0: 0, p1: 0, p2: 1 });

  const forgeHelp = spawnSync(process.execPath, [FORGE, '--help'], { encoding: 'utf8', env: BASE_ENV });
  const forgeUsage = JSON.parse(forgeHelp.stdout);
  assert.equal(forgeUsage.version, '1.4.0');
  assert.ok(forgeUsage.commands.some((line) => line.startsWith('verdict ') && line.includes('--remaining')));

  const loopHelp = spawnSync(process.execPath, [LOOPCTL, '--help'], { encoding: 'utf8', env: BASE_ENV });
  assert.equal(JSON.parse(loopHelp.stdout).version, '2.3.0');
});

test('回归 1A：派审后恢复前轮旧 Forge 评论，本轮仍按派审时口径放行 P2 打回', (t) => {
  const f = createFixture(t);
  const p1 = '1. 【P1】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现';
  const p2 = '1. 【P2】列表空态文案不清\n   入口：GET /orders\n   证据：list.ts:18 统一返回空态';

  const d1 = f.dispatch('r1');
  assert.equal(f.verdict(d1, '打回', ['--must-fix', p1]).json.code, 'REVIEW_REJECTED');
  f.requeue();

  const state = f.readState();
  state.comments[f.noteKey].push({
    id: 888,
    created_at: '2026-11-24T04:05:00Z',
    body: `主控 ｜ A ｜ ctrl-1\n已派终审：第 2 轮 ｜ 会话标识：historical-r2 ｜ head SHA：${HEAD_SHA} ｜ 派审 ID：remote-2`,
  });
  f.writeState(state);

  const plan = f.tickDispatch();
  const d2 = f.dispatch('new-reviewer');
  const persistedRejects = readReviews(f.runPath).at(-1).rejectDispatchIds.length;
  assert.deepEqual([plan.rejectCount, plan.fullReReview], [1, false]);
  assert.deepEqual([d2.rejectCount, d2.fullReReview, persistedRejects], [1, false, 1]);

  // 派审完成后才在 Forge 上恢复一条前轮旧打回评论；本轮收窄必须仍按派审登记口径（1 次，未熔断）判定
  const restored = f.readState();
  restored.comments[f.noteKey].push({
    id: 903,
    created_at: '2026-11-24T04:40:00Z',
    body: `终审 ｜ A ｜ historical-r2\n结论：打回（第 2 轮）\n<!-- liteloop:verdict ${JSON.stringify({
      dispatchId: 'remote-2', round: 2, conclusion: '打回', risk: LOW_RISK, headSha: HEAD_SHA, session: 'historical-r2',
    })} -->`,
  });
  f.writeState(restored);

  const res = f.verdict(d2, '打回', ['--must-fix', p2]);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.json.code, 'REVIEW_REJECTED');
});

test('回归 1B：上一轮结论待补发时，tick 派审动作、派审登记与结论收窄三处口径一致', (t) => {
  const f = createFixture(t);
  const p1 = '1. 【P1】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现';
  const p2 = '1. 【P2】列表空态文案不清\n   入口：GET /orders\n   证据：list.ts:18 统一返回空态';

  const s0 = f.readState();
  s0.comments[f.noteKey] = [{
    id: 888,
    created_at: '2026-11-24T04:05:00Z',
    body: `主控 ｜ A ｜ ctrl-1\n已派终审：第 1 轮 ｜ 会话标识：historical-r1 ｜ head SHA：${HEAD_SHA} ｜ 派审 ID：remote-old`,
  }];
  f.writeState(s0);

  const d1 = f.dispatch('local-audit-pending');
  const s1 = f.readState();
  s1.failVerdictPost = true;
  s1.comments[f.noteKey].push({
    id: 902,
    created_at: '2026-11-24T04:10:00Z',
    body: `终审 ｜ A ｜ historical-r1\n结论：打回（第 1 轮）\n<!-- liteloop:verdict ${JSON.stringify({
      dispatchId: 'remote-old', round: 1, conclusion: '打回', risk: LOW_RISK, headSha: HEAD_SHA, session: 'historical-r1',
    })} -->`,
  });
  f.writeState(s1);

  const r1 = f.verdict(d1, '打回', ['--must-fix', p1]);
  assert.equal(r1.code, 0, r1.stdout);
  assert.equal(r1.json.auditPending, true);
  assert.equal(r1.json.rejectCount, 2);

  f.requeue();
  const plan = f.tickDispatch();
  const d2 = f.dispatch('planned-fused');
  const recorded = readReviews(f.runPath).at(-1).rejectDispatchIds.length;
  const before = f.snapshot();
  const blocked = f.verdict(d2, '打回', ['--must-fix', p2]);

  assert.deepEqual([plan.rejectCount, plan.fullReReview], [2, true]);
  assert.deepEqual([d2.rejectCount, d2.fullReReview, recorded], [2, true, 2]);
  assert.equal(blocked.code, 2, blocked.stdout);
  assert.equal(blocked.json.code, 'MUST_FIX_P2_AFTER_FUSE');
  assert.equal(blocked.json.rejectCount, 2);
  assert.deepEqual(f.snapshot(), before);
});

test('回归 2：「通过」附带 P0 必改项报 PASS_WITH_MUST_FIX 且零副作用，填「无」仍可通过', (t) => {
  const f = createFixture(t, { autoMerge: true });
  const d = f.dispatch('pass-with-p0');
  const before = f.snapshot();

  const res = f.verdict(d, '通过', [
    '--must-fix', '1. 【P0】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现',
  ]);
  assert.equal(res.code, 2, res.stdout);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, 'PASS_WITH_MUST_FIX');
  assert.match(res.json.message, /--remaining/);
  assert.equal(f.readCalls().length, 0);
  assert.equal(f.readState().prs[`${REPO}#10`].state, 'OPEN');
  assert.deepEqual(f.snapshot(), before);

  const ok = f.verdict(d, '通过', ['--must-fix', '无']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.json.code, 'LOW_RISK_AUTO_MERGE');
});

test('回归 3：归一化仅替换等级标记与明确分隔符，完整保留正文负号与 Markdown 符号', (t) => {
  const f = createFixture(t);
  const d = f.dispatch('preserve-body');
  const mustFix = [
    '1. 【P1】-1 被错误当作有效库存',
    '   入口：POST /orders',
    '   证据：create.ts:18 复现',
    '2. P1：**空列表返回 500**',
    '   入口：POST /orders',
    '   证据：create.ts:25 复现',
    '3. **P0**：-0.5 金额被截断为 0',
    '   入口：POST /pay',
    '   证据：pay.ts:12 复现',
  ].join('\n');

  const res = f.verdict(d, '打回', ['--must-fix', mustFix]);
  assert.equal(res.code, 0, res.stdout);
  const body = f.comments().at(-1).body;
  assert.ok(body.includes('1. 【P1】-1 被错误当作有效库存'), body);
  assert.ok(body.includes('2. 【P1】**空列表返回 500**'), body);
  assert.ok(body.includes('3. 【P0】-0.5 金额被截断为 0'), body);
});

test('回归 4：必改项与遗留建议含归一后重复条目报 DUPLICATE_REVIEW_ITEM 且零副作用', (t) => {
  const f = createFixture(t);
  const d = f.dispatch('dup-finding');
  const before = f.snapshot();

  const res = f.verdict(d, '打回', [
    '--must-fix', [
      '1. 【P1】下单数量未校验',
      '   入口：POST /orders',
      '   证据：create.ts:10 复现',
      '2. 【P2】列表空态文案不清',
      '   入口：GET /orders',
      '   证据：list.ts:18 统一渲染暂无数据',
    ].join('\n'),
    '--remaining', '1. P2：列表空态文案不清\n   入口：GET /orders\n   证据：list.ts:18 统一渲染暂无数据',
  ]);

  assert.equal(res.code, 2, res.stdout);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, 'DUPLICATE_REVIEW_ITEM');
  assert.match(res.json.message, /只保留一处/);
  assert.equal(f.readCalls().length, 0);
  assert.deepEqual(f.snapshot(), before);
});

test('E2E：GitHub L2 三轮派审（P2→P1→tick 全量重审→熔断拒 P2→同派审改通过交人）并拆架归档', (t) => {
  const f = createFixture(t, { autoMerge: true });
  const p2 = '1. 【P2】列表空态文案不清\n   入口：GET /orders\n   证据：list.ts:18 空态不区分原因';
  const p1 = '1. 【P1】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现';

  // 第 1 轮：打回，含 P2
  const plan1 = f.tickDispatch(true);
  assert.deepEqual([plan1.rejectCount, plan1.fullReReview], [0, false]);
  const d1 = f.dispatch('e2e-r1');
  assert.equal(d1.round, 1);
  const r1 = f.verdict(d1, '打回', ['--must-fix', p2]);
  assert.equal(r1.code, 0, r1.stdout);
  assert.equal(r1.json.code, 'REVIEW_REJECTED');
  f.requeue();

  // 第 2 轮：打回，含 P1
  const plan2 = f.tickDispatch(true);
  assert.deepEqual([plan2.rejectCount, plan2.fullReReview], [1, false]);
  const d2 = f.dispatch('e2e-r2');
  assert.equal(d2.round, 2);
  const r2 = f.verdict(d2, '打回', ['--must-fix', p1]);
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(r2.json.code, 'REVIEW_REJECTED');
  f.requeue();

  // 第 3 轮：真实 tick --apply 产出 fullReReview: true，按此动作派审
  const plan3 = f.tickDispatch(true);
  assert.deepEqual([plan3.rejectCount, plan3.fullReReview], [2, true]);
  const d3 = f.dispatch('e2e-r3');
  assert.deepEqual([d3.round, d3.rejectCount, d3.fullReReview], [3, 2, true]);

  // 提交含 P2 的打回被拒，且零副作用
  const before = f.snapshot();
  const blocked = f.verdict(d3, '打回', ['--must-fix', p2]);
  assert.equal(blocked.code, 2, blocked.stdout);
  assert.equal(blocked.json.code, 'MUST_FIX_P2_AFTER_FUSE');
  assert.deepEqual(f.snapshot(), before);
  assert.ok(f.readCalls().every(({ args }) => !args.includes('POST') && args[1] !== 'edit' && args[1] !== 'merge'));

  // 同一派审改「通过」，P2 放进遗留建议，交人裁决
  const passed = f.verdict(d3, '通过', ['--remaining', p2]);
  assert.equal(passed.code, 0, passed.stdout);
  assert.equal(passed.json.state, 'manual');
  assert.equal(passed.json.code, 'REJECT_FUSE_FULL_REVIEW');
  assert.equal(f.readState().prs[`${REPO}#10`].state, 'OPEN');
  assert.deepEqual(f.labels(), [`需求:${f.req}`, '待合并']);
  const note3 = f.comments().findLast((n) => n.body.includes('liteloop:verdict'));
  assert.deepEqual(parseVerdictMeta(note3.body).grades, { p0: 0, p1: 0, p2: 1 });

  // 人工合入后用同一份运行日志拆架归档，验证 metrics.grades = {p0:0, p1:1, p2:2}
  const sDone = f.readState();
  sDone.prs[`${REPO}#10`].state = 'MERGED';
  sDone.issues[`${REPO}#15`].state = 'CLOSED';
  f.writeState(sDone);
  const tdPlan = f.loopctl(['teardown', '--req', f.req]);
  assert.equal(tdPlan.code, 0, tdPlan.stdout + tdPlan.stderr);
  assert.match(tdPlan.json.closingComments[0].body, /分级合计 P0 0 · P1 1 · P2 2/);

  const sClosed = f.readState();
  sClosed.issues[`${REPO}#7`].state = 'CLOSED';
  f.writeState(sClosed);
  const tdFinal = f.loopctl(['teardown', '--req', f.req, '--finalize', '--results', '{}']);
  assert.equal(tdFinal.code, 0, tdFinal.stdout + tdFinal.stderr);
  assert.deepEqual(tdFinal.json.metrics.grades, { p0: 0, p1: 1, p2: 2 });
  const archived = JSON.parse(fs.readFileSync(tdFinal.json.archivePath, 'utf8'));
  assert.deepEqual(archived.teardown.metrics.grades, { p0: 0, p1: 1, p2: 2 });
});

test('回归 R2-1：单张 PR 评论读取 503 只暂停该单派审，不阻塞本机结论补发与同需求其他 PR 派审', (t) => {
  const p1 = '1. 【P1】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现';

  // 场景 A：#10 有待补发结论并重入待终审，#10 评论 GET 503 而 POST 与 #11 正常
  const f = createFixture(t);
  const d1 = f.dispatch('r2-outage-10');
  const sFail = f.readState();
  sFail.failVerdictPost = true;
  f.writeState(sFail);
  const rej = f.verdict(d1, '打回', ['--must-fix', p1]);
  assert.equal(rej.code, 0, rej.stdout);
  assert.equal(rej.json.auditPending, true);

  f.requeue();
  const sOutage = f.readState();
  sOutage.failVerdictPost = false;
  sOutage.failReads = true;
  sOutage.prs[`${REPO}#11`] = { ...sOutage.prs[`${REPO}#10`], headRefName: 'feat/other' };
  f.writeState(sOutage);

  const tickRes = f.loopctl(['tick', '--req', f.req, '--role', 'controller', '--now', '2026-11-24T05:00:00Z', '--apply']);
  assert.equal(tickRes.code, 0, tickRes.stdout + tickRes.stderr);
  const actions = tickRes.json.runs?.[0]?.actions ?? [];
  assert.ok(readReviews(f.runPath).at(-1).commentId, '应照常补发 #10 的本机结论');
  assert.ok(actions.some((a) => a.code === 'VERDICT_AUDIT_REPUBLISH' && a.refs?.[0]?.id === 10), JSON.stringify(actions));
  assert.ok(actions.some((a) => a.kind === 'review-dispatch' && a.code === 'dispatch' && a.refs?.[0]?.id === 11), '应照常为 #11 生成派审');
  assert.ok(!actions.some((a) => a.kind === 'review-dispatch' && a.code === 'dispatch' && a.refs?.[0]?.id === 10), '应暂停 #10 的派审');
  assert.ok(actions.some((a) => a.kind === 'facts-error' && a.code === 'EXEC_FAILED'), JSON.stringify(actions));

  // 场景 B：#10 仍挂「终审中」且评论 GET 503 时，本机结论补发与标签修正均不受阻
  const f2 = createFixture(t);
  const d2 = f2.dispatch('r2-in-review-10');
  const s2Fail = f2.readState();
  s2Fail.failVerdictPost = true;
  s2Fail.failLabelEdit = true;
  f2.writeState(s2Fail);
  const rej2 = f2.verdict(d2, '打回', ['--must-fix', p1]);
  assert.ok(readReviews(f2.runPath).at(-1).verdict);
  assert.ok(f2.labels().includes('终审中'));

  const s2Outage = f2.readState();
  s2Outage.failVerdictPost = false;
  s2Outage.failLabelEdit = false;
  s2Outage.failReads = true;
  f2.writeState(s2Outage);
  const tickRes2 = f2.loopctl(['tick', '--req', f2.req, '--role', 'controller', '--now', '2026-11-24T05:00:00Z', '--apply']);
  assert.equal(tickRes2.code, 0, tickRes2.stdout + tickRes2.stderr);
  assert.ok(readReviews(f2.runPath).at(-1).commentId, '终审中状态也应完成本机结论补发');

  const s2Recover = f2.readState();
  s2Recover.failReads = false;
  f2.writeState(s2Recover);
  const tickRes2Recover = f2.loopctl(['tick', '--req', f2.req, '--role', 'controller', '--now', '2026-11-24T05:05:00Z', '--apply']);
  assert.equal(tickRes2Recover.code, 0, tickRes2Recover.stdout + tickRes2Recover.stderr);
  assert.ok(f2.labels().includes('需修改'), 'GET 恢复后应切回需修改');
});

test('回归 R2-2：tick 与 dispatch-review 之间旧结论补发到达，brief 采用 dispatch-review 的熔断口径', (t) => {
  const prior = createFixture(t);
  const current = createFixture(t);
  const p1 = '1. 【P1】校验缺失\n   入口：POST /orders\n   证据：create.ts:18 复现';
  const p2 = '1. 【P2】文案优化\n   入口：GET /orders\n   证据：list.ts:18 复现';

  const d1 = prior.dispatch('old-r1');
  assert.equal(prior.verdict(d1, '打回', ['--must-fix', p1]).json.code, 'REVIEW_REJECTED');
  prior.requeue();

  const d2 = prior.dispatch('old-r2');
  const sPrior = prior.readState();
  sPrior.failVerdictPost = true;
  prior.writeState(sPrior);
  assert.equal(prior.verdict(d2, '打回', ['--must-fix', p1]).json.auditPending, true);
  prior.requeue();

  // 新机器此时只能看到第 1 轮评论，tick 输出 rejectCount=1, fullReReview=false
  current.writeState(prior.readState());
  const plan = current.tickDispatch(true);
  assert.deepEqual([plan.rejectCount, plan.fullReReview], [1, false]);

  // 在 tick 与 dispatch-review 之间，旧机器补发第 2 轮结论到 Forge
  const sRecover = prior.readState();
  sRecover.failVerdictPost = false;
  prior.writeState(sRecover);
  const pub = spawnSync(process.execPath, [
    FORGE, 'verdict', '--republish', '--run', prior.runPath,
    '--forge', 'github', '--repo', REPO, '--id', '10', '--dispatch-id', d2.dispatchId,
  ], { encoding: 'utf8', env: { ...BASE_ENV, GH_BIN: path.join(path.dirname(prior.configDir), 'fake-gh.mjs'), FAKE_FORGE_STATE: path.join(path.dirname(prior.configDir), 'state.json'), FAKE_FORGE_LOG: path.join(path.dirname(prior.configDir), 'calls.jsonl') } });
  assert.equal(pub.status, 0, pub.stdout + pub.stderr);
  current.writeState(prior.readState());

  // dispatch-review 返回 2, true；随后生成的 finalReviewer brief 必须使用 dispatch-review 的口径
  const d3 = current.dispatch('new-r3');
  assert.deepEqual([d3.rejectCount, d3.fullReReview], [2, true]);

  const brief = current.loopctl(['brief', '--run', current.runPath, '--role', 'finalReviewer', '--issue', '#15', '--change', '10']);
  assert.equal(brief.code, 0, brief.stdout + brief.stderr);
  assert.match(brief.stdout, /已打回 2 次/);
  assert.match(brief.stdout, /已熔断/);
  assert.match(brief.stdout, /fullReReview=true/);
  assert.match(brief.stdout, /--remaining/);

  const blocked = current.verdict(d3, '打回', ['--must-fix', p2]);
  assert.equal(blocked.code, 2, blocked.stdout);
  assert.equal(blocked.json.code, 'MUST_FIX_P2_AFTER_FUSE');
});

test('回归 R2-3：闭合等级标记后紧跟的正文冒号保持原样，裸写等级后的冒号仍作分隔符', (t) => {
  const f = createFixture(t);
  const d = f.dispatch('r2-colon');
  const mustFix = [
    '1. 【P1】:focus-visible 未生效，键盘导航看不到焦点',
    '   入口：订单页按 Tab 聚焦提交按钮',
    '   证据：src/order.css:23，Tab 聚焦后仍没有边框',
    '2. [P1]:hover 样式被覆盖',
    '   入口：鼠标悬停提交按钮',
    '   证据：src/order.css:40 权重不足',
    '3. P1: :focus-visible 仍被覆盖',
    '   入口：键盘聚焦按钮',
    '   证据：src/order.css:50 复现',
  ].join('\n');

  const res = f.verdict(d, '打回', ['--must-fix', mustFix]);
  assert.equal(res.code, 0, res.stdout);
  const body = f.comments().at(-1).body;
  assert.ok(body.includes('1. 【P1】:focus-visible 未生效，键盘导航看不到焦点'), body);
  assert.ok(body.includes('2. 【P1】:hover 样式被覆盖'), body);
  assert.ok(body.includes('3. 【P1】:focus-visible 仍被覆盖'), body);
});

test('回归 R2-4：入口/证据标签换了 Markdown 强调样式仍判重复并拒收，内容不同时不受影响', (t) => {
  const f = createFixture(t);
  const d = f.dispatch('r2-md-dup');
  const before = f.snapshot();
  const base = '1. 【P2】列表空态文案不清\n   入口：GET /orders\n   证据：list.ts:18 空态不区分原因';
  const styled = '1. P2：列表空态文案不清\n   **入口：**GET /orders\n   __证据__：list.ts:18 空态不区分原因';

  const dup = f.verdict(d, '打回', ['--must-fix', base, '--remaining', styled]);
  assert.equal(dup.code, 2, dup.stdout);
  assert.equal(dup.json.code, 'DUPLICATE_REVIEW_ITEM');
  assert.equal(f.readCalls().length, 0);
  assert.deepEqual(f.snapshot(), before);

  const different = '1. 【P2】详情页空态文案不清\n   入口：GET /orders/:id\n   证据：detail.ts:22 空态不区分原因';
  const distinct = f.verdict(d, '打回', ['--must-fix', base, '--remaining', different]);
  assert.equal(distinct.code, 0, distinct.stdout);
  assert.deepEqual(distinct.json.grades, { p0: 0, p1: 0, p2: 2 });
});

test('回归 R2-5：「通过」传入空白 --must-fix（空串/空格/换行）视同「无」正常登记，「打回」仍拒收', (t) => {
  for (const [label, blank] of [['empty', ''], ['space', '   '], ['newline', '\n  \n']]) {
    const f = createFixture(t, { autoMerge: false });
    const d = f.dispatch(`pass-blank-${label}`);
    const rej = f.verdict(d, '打回', ['--must-fix', blank]);
    assert.equal(rej.code, 2, rej.stdout);
    assert.equal(rej.json.code, 'MISSING_FLAG');

    const ok = f.verdict(d, '通过', ['--must-fix', blank]);
    assert.equal(ok.code, 0, `${label}: ${ok.stdout}`);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.conclusion, '通过');
    const verdictNote = f.comments().findLast((n) => n.body.includes('liteloop:verdict'));
    assert.match(verdictNote.body, /必改项：\n无\n/);
  }
});

test('回归 R3-1A：前轮结论待补发、本轮已登记且评论 GET 503 时，仍补发前轮结论并为 #11 派审', (t) => {
  const f = createFixture(t);
  const p1 = '1. 【P1】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现';

  // 第 1 轮结论落本机但未发布（commentId 为空）
  const d1 = f.dispatch('r3-prev-pending');
  const s1 = f.readState();
  s1.failVerdictPost = true;
  f.writeState(s1);
  assert.equal(f.verdict(d1, '打回', ['--must-fix', p1]).json.auditPending, true);

  // 第 2 轮结论已发布（latest 有 commentId，但前轮 d1 仍缺 commentId）
  f.requeue();
  const s2 = f.readState();
  s2.failVerdictPost = false;
  f.writeState(s2);
  const d2 = f.dispatch('r3-curr-published');
  const r2 = f.verdict(d2, '打回', ['--must-fix', p1]);
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(r2.json.auditPending, false);
  assert.equal(readReviews(f.runPath)[0].commentId, undefined);
  assert.ok(readReviews(f.runPath)[1].commentId);

  // #10 重入待终审且评论 GET 503，同时同需求 #11 待终审
  f.requeue();
  const sOutage = f.readState();
  sOutage.failReads = true;
  sOutage.prs[`${REPO}#11`] = { ...sOutage.prs[`${REPO}#10`], headRefName: 'feat/other-r3' };
  f.writeState(sOutage);

  const tickRes = f.loopctl(['tick', '--req', f.req, '--role', 'controller', '--now', '2026-11-24T05:00:00Z', '--apply']);
  assert.equal(tickRes.code, 0, tickRes.stdout + tickRes.stderr);
  const actions = tickRes.json.runs?.[0]?.actions ?? [];
  assert.ok(readReviews(f.runPath)[0].commentId, '应照常补发前轮 d1 的未发布结论');
  assert.ok(actions.some((a) => a.code === 'VERDICT_AUDIT_REPUBLISH' && a.refs?.[0]?.id === 10), JSON.stringify(actions));
  assert.ok(actions.some((a) => a.kind === 'review-dispatch' && a.code === 'dispatch' && a.refs?.[0]?.id === 11), '应照常为 #11 派审');
  assert.ok(!actions.some((a) => a.kind === 'review-dispatch' && a.code === 'dispatch' && a.refs?.[0]?.id === 10), '应暂停 #10 的派审');
  assert.ok(actions.some((a) => a.kind === 'facts-error' && a.code === 'EXEC_FAILED'), JSON.stringify(actions));
});

test('回归 R3-1B：存在未发布本机结论且评论 GET 正常时，评论 201 照常产生 UNREPLIED_COMMENT 提醒', (t) => {
  const f = createFixture(t);
  const p1 = '1. 【P1】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现';

  const d1 = f.dispatch('r3-unreplied');
  const s1 = f.readState();
  s1.failVerdictPost = true;
  f.writeState(s1);
  assert.equal(f.verdict(d1, '打回', ['--must-fix', p1]).json.auditPending, true);

  f.requeue();
  const s2 = f.readState();
  s2.failVerdictPost = false;
  s2.comments[f.noteKey].push({
    id: 201,
    created_at: '2026-11-24T04:30:00Z',
    user: { login: 'peer-dev' },
    body: '提交者 ｜ 主研发 ｜ peer-dev\n【纠偏】请核查库存边界逻辑',
  });
  f.writeState(s2);

  const tickRes = f.loopctl(['tick', '--req', f.req, '--role', 'controller', '--now', '2026-11-24T05:00:00Z', '--apply']);
  assert.equal(tickRes.code, 0, tickRes.stdout + tickRes.stderr);
  const actions = tickRes.json.runs?.[0]?.actions ?? [];
  assert.ok(readReviews(f.runPath)[0].commentId, '应补发本机结论');
  const unreplied = actions.find((a) => a.code === 'UNREPLIED_COMMENT');
  assert.ok(unreplied, `应产生 UNREPLIED_COMMENT，实际动作：${JSON.stringify(actions)}`);
  assert.ok(unreplied.refs.some((r) => r.id === 10 && r.commentId === 201), JSON.stringify(unreplied));
});

test('回归 R3-2：熔断前 brief 终审口径按打回次数区分范围且明确 P0/P1/P2 均可打回', (t) => {
  const f = createFixture(t);
  const p2 = '1. 【P2】文案待优化\n   入口：GET /orders\n   证据：list.ts:18 复现';

  const d1 = f.dispatch('r3-brief-r1');
  const b1 = f.loopctl(['brief', '--run', f.runPath, '--role', 'finalReviewer', '--issue', '#15', '--change', '10']);
  assert.equal(b1.code, 0, b1.stdout + b1.stderr);
  assert.match(b1.stdout, /尚未打回（第 1 次派审/);
  assert.match(b1.stdout, /全单深审/);
  assert.match(b1.stdout, /P0\/P1\/P2 均可打回/);

  assert.equal(f.verdict(d1, '打回', ['--must-fix', p2]).code, 0);
  f.requeue();
  f.dispatch('r3-brief-r2');
  const b2 = f.loopctl(['brief', '--run', f.runPath, '--role', 'finalReviewer', '--issue', '#15', '--change', '10']);
  assert.equal(b2.code, 0, b2.stdout + b2.stderr);
  assert.match(b2.stdout, /已打回 1 次、未熔断/);
  assert.match(b2.stdout, /核上轮必改项与直接影响面/);
  assert.match(b2.stdout, /P0\/P1\/P2 均可打回/);
  assert.match(b2.stdout, /问题尽量一次挖透/);
  assert.doesNotMatch(b2.stdout, /首轮|第 2 轮|普通复审|仅允许就 P0\/P1 打回/);
});

test('回归 R3-3：去重兼容不同列表符号（1./- ）与续行缩进及加粗标签，内容不同时不误判', (t) => {
  const f = createFixture(t);
  const d = f.dispatch('r3-list-indent-dup');
  const before = f.snapshot();

  const numbered = [
    '1. 【P2】列表空态文案不清',
    '   入口：GET /orders',
    '   证据：list.ts:18 空态不区分原因',
  ].join('\n');
  const bulleted = [
    '- 【P2】列表空态文案不清',
    '  **入口：**GET /orders',
    '  **证据：**list.ts:18 空态不区分原因',
  ].join('\n');

  const dup = f.verdict(d, '打回', ['--must-fix', numbered, '--remaining', bulleted]);
  assert.equal(dup.code, 2, dup.stdout);
  assert.equal(dup.json.code, 'DUPLICATE_REVIEW_ITEM');
  assert.equal(f.readCalls().length, 0);
  assert.deepEqual(f.snapshot(), before);

  const other = [
    '- 【P2】列表筛选重置按钮无提示',
    '  **入口：**GET /orders?reset=1',
    '  **证据：**list.ts:44 点击后无反馈',
  ].join('\n');
  const ok = f.verdict(d, '打回', ['--must-fix', numbered, '--remaining', other]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual(ok.json.grades, { p0: 0, p1: 0, p2: 2 });
});

test('回归 R3-4：--remaining 或 --must-fix 写了参数但缺值报 MISSING_FLAG 且 PR 保持 OPEN', (t) => {
  const f = createFixture(t, { autoMerge: true });
  const d = f.dispatch('r3-dangling-flag');
  const before = f.snapshot();

  const noRemVal = f.verdict(d, '通过', ['--remaining']);
  assert.equal(noRemVal.code, 2, noRemVal.stdout);
  assert.equal(noRemVal.json.code, 'MISSING_FLAG');
  assert.equal(f.readState().prs[`${REPO}#10`].state, 'OPEN');
  assert.equal(f.readCalls().length, 0);
  assert.deepEqual(f.snapshot(), before);

  const noMfVal = f.verdict(d, '通过', ['--must-fix']);
  assert.equal(noMfVal.code, 2, noMfVal.stdout);
  assert.equal(noMfVal.json.code, 'MISSING_FLAG');
  assert.equal(f.readState().prs[`${REPO}#10`].state, 'OPEN');
  assert.equal(f.readCalls().length, 0);
  assert.deepEqual(f.snapshot(), before);

  // 显式传空白字符串的 --remaining 仍按「无」处理
  const blankRem = f.verdict(d, '通过', ['--remaining', '  \n ']);
  assert.equal(blankRem.code, 0, blankRem.stdout);
  assert.equal(blankRem.json.code, 'LOW_RISK_AUTO_MERGE');
  const note = f.comments().findLast((n) => n.body.includes('liteloop:verdict'));
  assert.match(note.body, /遗留建议：\n无\n/);
});

test('回归 R3-5：同一列表内部（--must-fix 与 --remaining 各自）重复条目报 DUPLICATE_REVIEW_ITEM 且零副作用', (t) => {
  const f = createFixture(t, { autoMerge: false });
  const d = f.dispatch('r3-intra-list-dup');
  const before = f.snapshot();

  const dupList = [
    '- 【P2】列表空态文案不清',
    '   入口：GET /orders',
    '   证据：list.ts:18 空态不区分原因',
    '- 【P2】列表空态文案不清',
    '   **入口：**GET /orders',
    '   **证据：**list.ts:18 空态不区分原因',
  ].join('\n');

  const inMustFix = f.verdict(d, '打回', ['--must-fix', dupList]);
  assert.equal(inMustFix.code, 2, inMustFix.stdout);
  assert.equal(inMustFix.json.code, 'DUPLICATE_REVIEW_ITEM');
  assert.match(inMustFix.json.message, /第 1 条与第 2 条/);
  assert.equal(f.readCalls().length, 0);
  assert.deepEqual(f.snapshot(), before);

  const inRemaining = f.verdict(d, '通过', ['--remaining', dupList]);
  assert.equal(inRemaining.code, 2, inRemaining.stdout);
  assert.equal(inRemaining.json.code, 'DUPLICATE_REVIEW_ITEM');
  assert.match(inRemaining.json.message, /第 1 条与第 2 条/);
  assert.equal(f.readCalls().length, 0);
  assert.deepEqual(f.snapshot(), before);

  // 内容不同的两条在同列表内正常通过
  const distinctList = [
    '- 【P2】列表空态文案不清',
    '   入口：GET /orders',
    '   证据：list.ts:18 空态不区分原因',
    '- 【P2】分页总数未格式化',
    '   **入口：**GET /orders?page=2',
    '   **证据：**list.ts:52 直接拼原始数字',
  ].join('\n');
  const ok = f.verdict(d, '通过', ['--remaining', distinctList]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.deepEqual(ok.json.grades, { p0: 0, p1: 0, p2: 2 });
});

test('回归 R4-1：单张 PR 评论 503 时仍写盘保存其他 PR 提醒节奏，且保留失败单的评论相关状态', (t) => {
  const f = createFixture(t);
  const p1 = '1. 【P1】负数库存校验错误\n   入口：POST /orders\n   证据：create.ts:18 复现';

  // #10 有待补发结论并重入待终审
  const d1 = f.dispatch('r4-state-10');
  const s1 = f.readState();
  s1.failVerdictPost = true;
  f.writeState(s1);
  assert.equal(f.verdict(d1, '打回', ['--must-fix', p1]).json.auditPending, true);
  f.requeue();

  // 预置上一轮 tick-state 中 #10 的评论相关状态
  const tickStatePath = f.runPath.replace(/\.json$/, '.tick-state.controller.json');
  const priorCommentReminder = { sentAt: Date.parse('2026-11-24T04:10:00Z') };
  const priorChangeCommentState = { maxCommentId: 201, documents: ['https://docs.example.test/spec'] };
  fs.writeFileSync(tickStatePath, JSON.stringify({
    owner: 'ctrl-1',
    lastWake: '2026-11-24T12:10:00+08:00',
    controllerReminders: {
      [`reply-comment:${REPO}#10@change:201`]: priorCommentReminder,
    },
    changes: {
      [`${REPO}#10`]: priorChangeCommentState,
    },
  }));

  // 05:00：#10 评论 GET 返回 503；#11 挂「待合并」触发 CONTROLLER_WAITING；#12 挂「待终审」正常派审
  const sOutage = f.readState();
  sOutage.failVerdictPost = false;
  sOutage.failReads = true;
  sOutage.prs[`${REPO}#11`] = {
    ...sOutage.prs[`${REPO}#10`],
    headRefName: 'feat/waiting-11',
    labels: [{ name: '待合并' }, { name: `需求:${f.req}` }],
  };
  sOutage.prs[`${REPO}#12`] = {
    ...sOutage.prs[`${REPO}#10`],
    headRefName: 'feat/queued-12',
    labels: [{ name: '待终审' }, { name: `需求:${f.req}` }],
  };
  f.writeState(sOutage);

  const tick1 = f.loopctl(['tick', '--req', f.req, '--role', 'controller', '--now', '2026-11-24T05:00:00Z', '--apply']);
  assert.equal(tick1.code, 0, tick1.stdout + tick1.stderr);
  const actions1 = tick1.json.runs?.[0]?.actions ?? [];
  assert.ok(readReviews(f.runPath)[0].commentId, '05:00 应成功补发 #10 结论');
  assert.ok(actions1.some((a) => a.kind === 'review-dispatch' && a.code === 'dispatch' && a.refs?.[0]?.id === 12), '05:00 应为 #12 派审');
  const wait1 = actions1.find((a) => a.code === 'CONTROLLER_WAITING');
  assert.ok(wait1?.refs?.some((r) => r.id === 11), `05:00 应首次提醒 #11：${JSON.stringify(actions1)}`);

  // 断言 05:00 已写盘保存 #11 提醒时间，且 #10 原评论相关状态既未推进也未清掉
  const savedAfterTick1 = JSON.parse(fs.readFileSync(tickStatePath, 'utf8'));
  assert.equal(savedAfterTick1.controllerReminders[`pending-merge:${REPO}#11@${HEAD_SHA}`]?.sentAt, Date.parse('2026-11-24T05:00:00Z'));
  assert.deepEqual(savedAfterTick1.controllerReminders[`reply-comment:${REPO}#10@change:201`], priorCommentReminder);
  assert.deepEqual(savedAfterTick1.changes[`${REPO}#10`], priorChangeCommentState);

  // 05:05 评论 GET 恢复，距离 05:00 不足 2 工作小时，#11 不得重复出现在 CONTROLLER_WAITING
  const sRecover = f.readState();
  sRecover.failReads = false;
  f.writeState(sRecover);
  const tick2 = f.loopctl(['tick', '--req', f.req, '--role', 'controller', '--now', '2026-11-24T05:05:00Z', '--apply']);
  assert.equal(tick2.code, 0, tick2.stdout + tick2.stderr);
  const actions2 = tick2.json.runs?.[0]?.actions ?? [];
  const wait2 = actions2.find((a) => a.code === 'CONTROLLER_WAITING');
  assert.ok(!wait2?.refs?.some((r) => r.id === 11), `05:05 不应重复提醒 #11：${JSON.stringify(actions2)}`);
  assert.ok(actions2.some((a) => a.kind === 'review-dispatch' && a.code === 'dispatch' && a.refs?.[0]?.id === 10), '05:05 恢复后应为 #10 派审');
});

test('回归 R4-2：首轮超时重派（round=2, rejectCount=0）brief 写全单深审且不按轮次计数；打回 1 次后写核上轮必改项', (t) => {
  const f = createFixture(t);
  const p1 = '1. 【P1】校验缺失\n   入口：POST /orders\n   证据：create.ts:18 复现';

  // 第 1 次派审超时（未落结论），退回待终审后第 2 次派审：round=2, rejectCount=0
  const d1 = f.dispatch('r4-timeout-1');
  assert.equal(d1.round, 1);
  f.requeue();
  const d2 = f.dispatch('r4-timeout-2');
  assert.equal(d2.round, 2);
  assert.equal(d2.rejectCount, 0);

  const bAfterTimeout = f.loopctl(['brief', '--run', f.runPath, '--role', 'finalReviewer', '--issue', '#15', '--change', '10']);
  assert.equal(bAfterTimeout.code, 0, bAfterTimeout.stdout + bAfterTimeout.stderr);
  assert.match(bAfterTimeout.stdout, /尚未打回（第 2 次派审/);
  assert.match(bAfterTimeout.stdout, /全单深审/);
  assert.match(bAfterTimeout.stdout, /P0\/P1\/P2 均可打回/);
  assert.doesNotMatch(bAfterTimeout.stdout, /首轮|第 2 轮/);

  // 打回 1 次后再派审：round=3, rejectCount=1
  assert.equal(f.verdict(d2, '打回', ['--must-fix', p1]).code, 0);
  f.requeue();
  const d3 = f.dispatch('r4-after-reject-1');
  assert.equal(d3.round, 3);
  assert.equal(d3.rejectCount, 1);

  const bAfterReject = f.loopctl(['brief', '--run', f.runPath, '--role', 'finalReviewer', '--issue', '#15', '--change', '10']);
  assert.equal(bAfterReject.code, 0, bAfterReject.stdout + bAfterReject.stderr);
  assert.match(bAfterReject.stdout, /已打回 1 次、未熔断/);
  assert.match(bAfterReject.stdout, /核上轮必改项/);
  assert.match(bAfterReject.stdout, /P0\/P1\/P2 均可打回/);
  assert.doesNotMatch(bAfterReject.stdout, /首轮|第 2 轮/);
});
