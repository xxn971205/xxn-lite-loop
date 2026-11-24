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
      const notes = (state.comments[p] ??= []);
      const note = { id: notes.length + 100, body: JSON.parse(stdin).body, created_at: '2026-11-24T04:00:00Z' };
      notes.push(note);
      save();
      reply(note);
    }
    reply(state.comments[p] ?? []);
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/issues$/.test(p)) {
    reply(Object.entries(state.issues).map(([k, v]) => ({ ...v, number: Number(k.split('#')[1]) })));
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/branches\\//.test(p)) {
    reply({ commit: { sha: '${HEAD_SHA}' } });
  }
  fail('unknown api ' + p);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const issue = state.issues[repoArg() + '#' + args[2]];
  if (!issue) fail('not found');
  reply(issue);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = state.prs[repoArg() + '#' + args[2]];
  if (!pr) fail('not found');
  reply(pr);
}
if (args[0] === 'pr' && args[1] === 'edit') {
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
        body: '## 1. 当前状态\n主控：第 1 任 ｜ ctrl-1\n## 3. 当前进行中\n办理 #15\n',
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

  return {
    req, runPath, journalPath, configDir,
    readState, writeState, readCalls, clearCalls, readJournal, labels, comments,
    requeue, dispatch, verdict, loopctl,
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
