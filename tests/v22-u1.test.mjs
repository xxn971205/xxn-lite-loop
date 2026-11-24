#!/usr/bin/env node
/**
 * v2.2 U1 tests: teardown.metrics recorded from local journals on teardown --finalize.
 *
 * Run directly: node tests/v22-u1.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPCTL = path.join(ROOT, 'scripts', 'loopctl.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-v22-u1-'));

const LOW_RISK = {
  contract: false, hotFile: false, migration: false,
  switchDefault: false, signature: false, foundation: false,
};

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeFakeGh(dir) {
  const bin = path.join(dir, 'bin');
  const stateFile = path.join(dir, 'state.json');
  const gh = path.join(bin, 'gh');
  write(gh, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/issues?')) {
    process.stdout.write(JSON.stringify(state.list ?? []));
    process.exit(0);
  }
  if (endpoint.includes('/comments')) {
    process.stdout.write(JSON.stringify([]));
    process.exit(0);
  }
  if (endpoint.includes('/branches/')) {
    process.stdout.write(JSON.stringify({ commit: { sha: '${'a'.repeat(40)}' } }));
    process.exit(0);
  }
}
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: Number(args[2]),
    title: '【追踪】test',
    body: '## 1. 基本信息\\n主控：第 1 任 ｜ s1 ｜ local\\n本轮：空闲',
    state: state.issueState ?? 'OPEN',
    labels: [],
    updatedAt: '2026-11-23T00:00:00Z',
    url: 'https://github.com/acme/demo/issues/' + args[2],
  }));
  process.exit(0);
}
process.stderr.write('unexpected gh args: ' + JSON.stringify(args));
process.exit(1);
`);
  fs.chmodSync(gh, 0o755);
  return {
    setState(data) { write(stateFile, JSON.stringify(data)); },
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile },
  };
}

function runLoopctl(args, configDir, env = process.env) {
  const res = spawnSync(process.execPath, [LOOPCTL, ...args, '--config-dir', configDir], {
    encoding: 'utf8',
    env,
  });
  let json = null;
  if (res.stdout.trim()) json = JSON.parse(res.stdout);
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function seedRun(configDir, req) {
  const runPath = path.join(configDir, 'runs', `${req}.json`);
  write(runPath, JSON.stringify({
    req,
    title: `测试 ${req}`,
    tier: 'L1',
    user: 'tester',
    forge: 'github',
    hubRepo: { name: 'demo', repo: 'acme/demo', branch: 'main' },
    repos: [{ name: 'demo', repo: 'acme/demo', branch: 'main' }],
    baselineBranch: 'main',
    autoMerge: false,
    issues: { tracking: { id: 7 } },
    ledgers: [{ key: 'tracking', repo: 'acme/demo', issue: { id: 7 } }],
    controller: { sessionId: 's1' },
    scheduledTasks: [],
    worktrees: [],
    status: 'active',
  }, null, 2));
  return runPath;
}

const failures = [];
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`FAIL: ${name}\n  ${err.stack ?? err.message}`);
  }
}

try {
  const fake = makeFakeGh(path.join(TMP, 'gh'));
  const configDir = path.join(TMP, 'config');

  test('teardown --finalize writes teardown.metrics from review-journal and tick history', () => {
    const req = 'with-journals';
    const runPath = seedRun(configDir, req);
    const sha1 = '1'.repeat(40);
    const sha2 = '2'.repeat(40);
    const sha3 = '3'.repeat(40);

    const reviewRows = [
      // PR #10: 2 rejects + 1 pass fused (also mixed repo casing)
      { type: 'dispatch', dispatchId: 'd1', pr: { repo: 'acme/demo', id: 10 }, round: 1, headSha: sha1, session: 'r1', nonce: 'n1', at: '2026-11-23T01:00:00Z' },
      { type: 'verdict', dispatchId: 'd1', conclusion: '打回', risk: LOW_RISK },
      { type: 'dispatch', dispatchId: 'd2', pr: { repo: 'ACME/DEMO', id: 10 }, round: 2, headSha: sha2, session: 'r2', nonce: 'n2', at: '2026-11-23T02:00:00Z' },
      { type: 'verdict', dispatchId: 'd2', conclusion: '打回', risk: LOW_RISK },
      { type: 'dispatch', dispatchId: 'd3', pr: { repo: 'acme/demo', id: 10 }, round: 3, headSha: sha3, session: 'r3', nonce: 'n3', at: '2026-11-23T03:00:00Z' },
      { type: 'verdict', dispatchId: 'd3', conclusion: '通过', risk: LOW_RISK },
      { type: 'merge-result', dispatchId: 'd3', state: 'manual', code: 'REJECT_FUSE_FULL_REVIEW' },
      // PR #11: fused twice (once via reasonCodes, once via code) -> must count as 1 fused change
      { type: 'dispatch', dispatchId: 'd4', pr: { repo: 'acme/demo', id: 11 }, round: 3, headSha: sha1, session: 'r4', nonce: 'n4', at: '2026-11-23T04:00:00Z' },
      { type: 'verdict', dispatchId: 'd4', conclusion: '通过', risk: { ...LOW_RISK, contract: true } },
      { type: 'merge-result', dispatchId: 'd4', state: 'manual', code: 'HIGH_RISK_MANUAL', reasonCodes: ['HIGH_RISK_MANUAL', 'REJECT_FUSE_FULL_REVIEW'] },
      { type: 'dispatch', dispatchId: 'd5', pr: { repo: 'acme/demo', id: 11 }, round: 4, headSha: sha2, session: 'r5', nonce: 'n5', at: '2026-11-23T05:00:00Z' },
      { type: 'verdict', dispatchId: 'd5', conclusion: '通过', risk: LOW_RISK },
      { type: 'merge-result', dispatchId: 'd5', state: 'manual', code: 'REJECT_FUSE_FULL_REVIEW' },
      // PR #12: clean pass + merged
      { type: 'dispatch', dispatchId: 'd6', pr: { repo: 'acme/demo', id: 12 }, round: 1, headSha: sha1, session: 'r6', nonce: 'n6', at: '2026-11-23T06:00:00Z' },
      { type: 'verdict', dispatchId: 'd6', conclusion: '通过', risk: LOW_RISK },
      { type: 'merge-result', dispatchId: 'd6', state: 'merged', code: 'LOW_RISK_AUTO_MERGE' },
    ];
    write(runPath.replace(/\.json$/, '.reviews.jsonl'), reviewRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const tickRows = [
      // Dry-run planned timeout must NOT count as emitted
      { at: '2026-11-23T01:30:00Z', role: 'dispatch', apply: false, result: 'actions', actions: [{ kind: 'review-dispatch', code: 'REVIEW_TIMEOUT' }] },
      // Two actual emitted REVIEW_TIMEOUT comments
      { at: '2026-11-23T02:30:00Z', role: 'dispatch', apply: true, result: 'actions', actions: [{ kind: 'comment-posted', code: 'REVIEW_TIMEOUT' }] },
      { at: '2026-11-23T03:30:00Z', role: 'controller', apply: true, result: 'actions', actions: [{ kind: 'comment-posted', code: 'REVIEW_TIMEOUT' }] },
      // Other comment must not count
      { at: '2026-11-23T04:30:00Z', role: 'patrol', apply: true, result: 'actions', actions: [{ kind: 'comment-posted', code: 'LEDGER_BLOAT' }] },
    ];
    write(runPath.replace(/\.json$/, '.ticks.jsonl'), tickRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    fake.setState({ issueState: 'OPEN' });
    const plan = runLoopctl(['teardown', '--req', req], configDir, fake.env);
    assert.equal(plan.code, 0, plan.stderr);

    fake.setState({ issueState: 'CLOSED' });
    const fin = runLoopctl(['teardown', '--req', req, '--finalize', '--results', '{}'], configDir, fake.env);
    assert.equal(fin.code, 0, fin.stderr);

    const expected = { changes: 3, rejects: 2, fuses: 2, timeouts: 2, grades: { p0: 0, p1: 0, p2: 0 } };
    const archive = JSON.parse(fs.readFileSync(fin.json.archivePath, 'utf8'));
    assert.deepEqual(archive.teardown.metrics, expected);
    assert.deepEqual(fin.json.metrics, expected);

    const again = runLoopctl(['teardown', '--req', req], configDir, fake.env);
    assert.equal(again.code, 0);
    assert.equal(again.json.alreadyArchived, true);
    assert.deepEqual(again.json.metrics, expected);
  });

  test('teardown --finalize writes null timeouts when the local tick journal is absent', () => {
    const req = 'no-journals';
    seedRun(configDir, req);

    fake.setState({ issueState: 'OPEN' });
    assert.equal(runLoopctl(['teardown', '--req', req], configDir, fake.env).code, 0);

    fake.setState({ issueState: 'CLOSED' });
    const fin = runLoopctl(['teardown', '--req', req, '--finalize', '--results', '{}'], configDir, fake.env);
    assert.equal(fin.code, 0, fin.stderr);

    const archive = JSON.parse(fs.readFileSync(fin.json.archivePath, 'utf8'));
    assert.deepEqual(archive.teardown.metrics, { changes: 0, rejects: 0, fuses: 0, timeouts: null, grades: { p0: 0, p1: 0, p2: 0 } });
  });

  test('teardown --finalize writes zero timeouts when the tick journal has no emitted timeouts', () => {
    const req = 'no-timeouts';
    const runPath = seedRun(configDir, req);
    const tickRow = { at: '2026-11-23T01:30:00Z', role: 'controller', apply: true, result: 'quiet', actions: [] };
    write(runPath.replace(/\.json$/, '.ticks.jsonl'), JSON.stringify(tickRow) + '\n');

    fake.setState({ issueState: 'OPEN' });
    assert.equal(runLoopctl(['teardown', '--req', req], configDir, fake.env).code, 0);
    fake.setState({ issueState: 'CLOSED' });
    const fin = runLoopctl(['teardown', '--req', req, '--finalize', '--results', '{}'], configDir, fake.env);
    assert.equal(fin.code, 0, fin.stdout);
    assert.equal(fin.json.metrics.timeouts, 0);
  });

  test('teardown --finalize writes null metrics without failing when journals are damaged', () => {
    const req = 'damaged-journals';
    const runPath = seedRun(configDir, req);
    write(runPath.replace(/\.json$/, '.reviews.jsonl'), '{not-valid-json\n');
    write(runPath.replace(/\.json$/, '.ticks.jsonl'), '{not-valid-json\n');

    fake.setState({ issueState: 'OPEN' });
    assert.equal(runLoopctl(['teardown', '--req', req], configDir, fake.env).code, 0);

    fake.setState({ issueState: 'CLOSED' });
    const fin = runLoopctl(['teardown', '--req', req, '--finalize', '--results', '{}'], configDir, fake.env);
    assert.equal(fin.code, 0, fin.stderr);

    const archive = JSON.parse(fs.readFileSync(fin.json.archivePath, 'utf8'));
    assert.deepEqual(archive.teardown.metrics, { changes: null, rejects: null, fuses: null, timeouts: null, grades: null });
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`TOTAL PASS ${passed} / FAIL ${failures.length}`);
process.exit(failures.length ? 1 : 0);
