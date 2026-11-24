#!/usr/bin/env node
/**
 * v22-u6.test.mjs — U6 终审打回必须写入口与证据行为测试。
 *
 * 运行：node tests/v22-u6.test.mjs
 * 退出码：0 = 全部 PASS，1 = 有 FAIL。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FORGE = path.join(ROOT, 'scripts', 'forge.mjs');
const REPO = 'acme/loop';
const HEAD_SHA = 'a'.repeat(40);
const BASELINE = 'loop/u6-demo';
const RISK_LOW = 'contract=0,hotFile=0,migration=0,switchDefault=0,signature=0,foundation=0';

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
      const note = { id: notes.length + 100, body: JSON.parse(stdin).body, created_at: '2026-05-01T04:00:00Z' };
      notes.push(note);
      save();
      reply(note);
    }
    reply(state.comments[p] ?? []);
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/issues$/.test(p)) {
    reply(Object.entries(state.issues).map(([k, v]) => ({ ...v, number: Number(k.split('#')[1]) })));
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

function runForge(args, env) {
  const res = spawnSync(process.execPath, [FORGE, ...args], {
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env },
  });
  let json = {};
  try { json = JSON.parse(res.stdout); } catch {}
  return { code: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-lite-loop-u6-'));
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

try {
  const ghBin = path.join(tmpDir, 'fake-gh.mjs');
  const stateFile = path.join(tmpDir, 'state.json');
  const logFile = path.join(tmpDir, 'calls.jsonl');
  const runPath = path.join(tmpDir, 'u6-demo.json');
  const journalPath = path.join(tmpDir, 'u6-demo.reviews.jsonl');

  fs.writeFileSync(ghBin, FAKE_GH, 'utf8');
  fs.chmodSync(ghBin, 0o755);

  const env = { GH_BIN: ghBin, FAKE_FORGE_STATE: stateFile, FAKE_FORGE_LOG: logFile };
  const run = {
    req: 'u6-demo',
    tier: 'L2',
    forge: 'github',
    autoMerge: false,
    baselineBranch: BASELINE,
    hubRepo: { name: 'loop', repo: REPO, branch: 'main' },
    repos: [{ name: 'loop', repo: REPO, branch: 'main' }],
    issues: { main: 7, subIssues: [15] },
    controller: { sessionId: 'ctrl-1' },
  };
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2), 'utf8');

  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const readCalls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const readJournal = () => fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const labelList = (pr) => pr.labels.map((l) => l.name ?? l);
  const noteKey = `repos/${REPO}/issues/10/comments`;

  function setupDispatched(session) {
    if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
    const state = {
      issues: {
        [`${REPO}#7`]: {
          body: '## 1. 当前状态\n主控：第 1 任 ｜ ctrl-1\n## 3. 当前进行中\n办理 #15\n',
          labels: [`需求:${run.req}`],
        },
        [`${REPO}#15`]: { body: '子任务', labels: [`需求:${run.req}`] },
      },
      prs: {
        [`${REPO}#10`]: {
          state: 'OPEN',
          isDraft: false,
          headRefOid: HEAD_SHA,
          headRefName: 'feat/u6',
          baseRefName: BASELINE,
          body: '关联 #15',
          labels: [{ name: '待终审' }, { name: `需求:${run.req}` }],
        },
      },
      comments: {},
    };
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
    fs.writeFileSync(logFile, '', 'utf8');
    const disp = runForge([
      'dispatch-review', '--run', runPath, '--role', 'controller',
      '--forge', 'github', '--repo', REPO, '--id', '10',
      '--head-sha', HEAD_SHA, '--session', session,
    ], env);
    assert.equal(disp.code, 0, `dispatch-review failed: ${disp.stdout}`);
    // Clear call log after dispatch so verdict side-effects are isolated.
    fs.writeFileSync(logFile, '', 'utf8');
    return disp.json;
  }

  function callVerdict(dispatch, conclusion, extra = []) {
    return runForge([
      'verdict', '--run', runPath, '--forge', 'github', '--repo', REPO, '--id', '10',
      '--dispatch-id', dispatch.dispatchId, '--nonce', dispatch.nonce,
      '--round', String(dispatch.round), '--conclusion', conclusion,
      '--risk', RISK_LOW, '--head-sha', HEAD_SHA, '--session', dispatch.session,
      ...extra,
    ], env);
  }

  function assertNoSideEffects(beforeJournalCount, beforeCommentCount) {
    assert.equal(readCalls().length, 0, '校验失败不应产生任何 Forge 调用');
    assert.deepEqual(labelList(readState().prs[`${REPO}#10`]), [`需求:${run.req}`, '终审中'], '标签不应被修改');
    assert.equal((readState().comments[noteKey] ?? []).length, beforeCommentCount, '不应发布评论');
    assert.equal(readJournal().length, beforeJournalCount, '不应写入本地评审日志');
  }

  test('打回缺少 --must-fix 被拒且不发评论、不改标签、不写日志', () => {
    const disp = setupDispatched('rev-missing');
    const journalBefore = readJournal().length;
    const commentsBefore = (readState().comments[noteKey] ?? []).length;
    const res = callVerdict(disp, '打回');
    assert.equal(res.code, 2);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'MISSING_FLAG');
    assert.match(res.json.message, /--must-fix/);
    assertNoSideEffects(journalBefore, commentsBefore);
  });

  test('打回缺「入口：」报 MUST_FIX_INCOMPLETE 并列出缺项条目', () => {
    const disp = setupDispatched('rev-no-entry');
    const journalBefore = readJournal().length;
    const commentsBefore = (readState().comments[noteKey] ?? []).length;
    const res = callVerdict(disp, '打回', [
      '--must-fix', '1. 订单未校验空数组\n   证据：src/order.ts:42 直接读 items[0]',
    ]);
    assert.equal(res.code, 2);
    assert.equal(res.json.code, 'MUST_FIX_INCOMPLETE');
    assert.deepEqual(res.json.incomplete, [
      { index: 1, item: '1. 订单未校验空数组', missing: ['入口：'] },
    ]);
    assert.match(res.json.message, /入口：/);
    assert.match(res.json.message, /订单未校验空数组/);
    assertNoSideEffects(journalBefore, commentsBefore);
  });

  test('打回缺「证据：」报 MUST_FIX_INCOMPLETE 并列出缺项条目', () => {
    const disp = setupDispatched('rev-no-evidence');
    const journalBefore = readJournal().length;
    const commentsBefore = (readState().comments[noteKey] ?? []).length;
    const res = callVerdict(disp, '打回', [
      '--must-fix', '1. 取消订单未释放库存\n   入口：POST /api/orders/:id/cancel',
    ]);
    assert.equal(res.code, 2);
    assert.equal(res.json.code, 'MUST_FIX_INCOMPLETE');
    assert.deepEqual(res.json.incomplete, [
      { index: 1, item: '1. 取消订单未释放库存', missing: ['证据：'] },
    ]);
    assert.match(res.json.message, /证据：/);
    assertNoSideEffects(journalBefore, commentsBefore);
  });

  test('多条编号必改项中仅列出缺项条目，不误报完整条目', () => {
    const disp = setupDispatched('rev-partial');
    const journalBefore = readJournal().length;
    const commentsBefore = (readState().comments[noteKey] ?? []).length;
    const mustFix = [
      '1. 空商品提交 500',
      '   入口：POST /api/orders',
      '   证据：src/order.ts:42 未判空',
      '2. 取消未释放库存',
      '   入口：POST /api/orders/:id/cancel',
      '3. 重复扣减风险',
    ].join('\n');
    const res = callVerdict(disp, '打回', ['--must-fix', mustFix]);
    assert.equal(res.code, 2);
    assert.equal(res.json.code, 'MUST_FIX_INCOMPLETE');
    assert.deepEqual(res.json.incomplete, [
      { index: 2, item: '2. 取消未释放库存', missing: ['证据：'] },
      { index: 3, item: '3. 重复扣减风险', missing: ['入口：', '证据：'] },
    ]);
    assert.doesNotMatch(res.json.message, /空商品提交 500/);
    assertNoSideEffects(journalBefore, commentsBefore);
  });

  test('「- 」列表切分，缩进子项不被误切，缺项条目被准确报出', () => {
    const disp = setupDispatched('rev-bullets');
    const journalBefore = readJournal().length;
    const commentsBefore = (readState().comments[noteKey] ?? []).length;
    const mustFix = [
      '- 空商品提交 500',
      '  - 入口：POST /api/orders',
      '  - 证据：src/order.ts:42 未判空',
      '- 取消未释放库存',
      '  - 证据：src/cancel.ts:18 缺少 release 调用',
    ].join('\n');
    const res = callVerdict(disp, '打回', ['--must-fix', mustFix]);
    assert.equal(res.code, 2);
    assert.equal(res.json.code, 'MUST_FIX_INCOMPLETE');
    assert.deepEqual(res.json.incomplete, [
      { index: 2, item: '- 取消未释放库存', missing: ['入口：'] },
    ]);
    assertNoSideEffects(journalBefore, commentsBefore);
  });

  test('只写空的「入口：」或「证据：」占位符也被拒收', () => {
    const disp = setupDispatched('rev-empty-field');
    const journalBefore = readJournal().length;
    const commentsBefore = (readState().comments[noteKey] ?? []).length;
    const res = callVerdict(disp, '打回', [
      '--must-fix', '1. 占位测试\n   入口：\n   证据：src/a.ts:10',
    ]);
    assert.equal(res.code, 2);
    assert.equal(res.json.code, 'MUST_FIX_INCOMPLETE');
    assert.deepEqual(res.json.incomplete, [
      { index: 1, item: '1. 占位测试', missing: ['入口：'] },
    ]);
    assertNoSideEffects(journalBefore, commentsBefore);
  });

  test('加粗的空入口与空证据都被拒收，且不发评论、不改标签、不写日志', () => {
    const disp = setupDispatched('rev-bold-empty');
    const journalBefore = readJournal().length;
    const commentsBefore = (readState().comments[noteKey] ?? []).length;
    const res = callVerdict(disp, '打回', ['--must-fix', [
      '1. 占位入口', '   **入口：**', '   **证据：** src/a.ts:10',
      '2. 占位证据', '   __入口__：下单页', '   __证据：__',
    ].join('\n')]);
    assert.equal(res.code, 2, res.stdout);
    assert.equal(res.json.code, 'MUST_FIX_INCOMPLETE');
    assert.deepEqual(res.json.incomplete, [
      { index: 1, item: '1. 占位入口', missing: ['入口：'] },
      { index: 2, item: '2. 占位证据', missing: ['证据：'] },
    ]);
    assertNoSideEffects(journalBefore, commentsBefore);
  });

  test('完整多条编号打回正常发布评论、切需修改并写入本地日志', () => {
    const disp = setupDispatched('rev-valid-numbered');
    const mustFix = [
      '1. 【P0】订单提交空商品列表时返回 500，期望返回 400',
      '   入口：下单页点击「提交」→ POST /api/orders',
      '   证据：src/order/create.ts:42 直接读 body.items[0].sku 未判空',
      '2. 【P1】取消订单后库存未回滚',
      '   入口：订单详情点击「取消订单」→ POST /api/orders/:id/cancel',
      '   证据：src/order/cancel.ts:18 未调用 inventoryService.release',
    ].join('\n');
    const res = callVerdict(disp, '打回', ['--must-fix', mustFix]);
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.conclusion, '打回');
    assert.equal(res.json.state, 'rejected');
    assert.equal(res.json.code, 'REVIEW_REJECTED');
    assert.deepEqual(labelList(readState().prs[`${REPO}#10`]), [`需求:${run.req}`, '需修改']);
    const notes = readState().comments[noteKey] ?? [];
    assert.equal(notes.length, 2);
    assert.match(notes[1].body, /入口：下单页点击「提交」/);
    assert.match(notes[1].body, /证据：src\/order\/cancel\.ts:18/);
    assert.equal(readJournal().filter((r) => r.type === 'verdict').length, 1);
  });

  test('完整「- 」单行内联打回（含半角冒号）正常发布', () => {
    const disp = setupDispatched('rev-valid-bullets');
    const mustFix = [
      '- 【P0】空值未校验。入口: POST /api/orders；证据: src/order.ts:42 抛出 TypeError',
      '- P1：缺幂等键。**入口：**支付回调 /webhook/pay；__证据__：src/pay.ts:88 重复扣款',
    ].join('\n');
    const res = callVerdict(disp, '打回', ['--must-fix', mustFix]);
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.json.code, 'REVIEW_REJECTED');
    assert.deepEqual(labelList(readState().prs[`${REPO}#10`]), [`需求:${run.req}`, '需修改']);
  });

  test('「通过」省略 --must-fix 或带普通文本均不受影响', () => {
    const disp1 = setupDispatched('rev-pass-plain');
    const res1 = callVerdict(disp1, '通过');
    assert.equal(res1.code, 0, res1.stdout);
    assert.equal(res1.json.ok, true);
    assert.equal(res1.json.conclusion, '通过');
    assert.match((readState().comments[noteKey] ?? [])[1]?.body ?? '', /必改项：\n无\n/);

    const disp2 = setupDispatched('rev-pass-with-note');
    const res2 = callVerdict(disp2, '通过', ['--must-fix', '无阻断项，仅留线索']);
    assert.equal(res2.code, 0, res2.stdout);
    assert.equal(res2.json.ok, true);
    assert.equal(res2.json.conclusion, '通过');
    assert.match((readState().comments[noteKey] ?? [])[1]?.body ?? '', /必改项：\n无阻断项，仅留线索\n/);
  });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\nU6 SUMMARY: PASS ${passed} / FAIL ${failed}`);
process.exit(failed > 0 ? 1 : 0);
