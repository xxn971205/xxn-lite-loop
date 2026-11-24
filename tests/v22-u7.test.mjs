#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPCTL = path.join(ROOT, 'scripts', 'loopctl.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-lite-loop-v22-u7-'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, detail: err?.stack ?? String(err) });
  }
}

function runLoopctl(args, configDir, env = {}) {
  const res = spawnSync(process.execPath, [LOOPCTL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_HOST: '', GITLAB_HOST: '', XXN_LITE_LOOP_CONFIG_DIR: configDir, ...env },
    timeout: 20_000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* plain text output */ }
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json };
}

function git(cwd, args) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function setupGitWithRemote(baseDir, branch = 'loop/demo-req') {
  const bare = path.join(baseDir, 'origin.git');
  const work = path.join(baseDir, 'work');
  const other = path.join(baseDir, 'other');
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '--bare']);
  git(baseDir, ['clone', bare, work]);
  git(work, ['checkout', '-b', branch]);
  fs.writeFileSync(path.join(work, 'a.txt'), 'v1\n');
  git(work, ['add', 'a.txt']);
  git(work, ['commit', '-m', 'init']);
  git(work, ['push', '-u', 'origin', branch]);
  const initialSha = git(work, ['rev-parse', 'HEAD']);

  // Push a newer commit from a second clone so `work` only sees it if `brief` runs `git fetch`.
  git(baseDir, ['clone', bare, other]);
  git(other, ['checkout', branch]);
  fs.writeFileSync(path.join(other, 'a.txt'), 'v2\n');
  git(other, ['add', 'a.txt']);
  git(other, ['commit', '-m', 'remote advance']);
  git(other, ['push', 'origin', branch]);
  const remoteSha = git(other, ['rev-parse', 'HEAD']);
  assert.notEqual(remoteSha, initialSha);
  return { work, initialSha, remoteSha };
}

function snapshotDir(dir) {
  const out = {};
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) walk(full);
      else out[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function writeRun(configDir, slug, overrides = {}) {
  const runPath = path.join(configDir, 'runs', `${slug}.json`);
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  const run = {
    schema: 2,
    version: '2.0.0',
    req: slug,
    project: 'demo',
    tier: 'L2',
    stage: 'P3',
    forge: 'github',
    hostname: null,
    gitlabHost: null,
    branch: 'loop/demo-req',
    baselineBranch: 'loop/demo-req',
    hubRepo: { name: 'demo', repo: 'acme/demo', path: null, branch: 'main', role: 'hub' },
    repos: [{ name: 'demo', repo: 'acme/demo', path: null, branch: 'main', role: 'hub' }],
    roleModels: {
      controller: 'anthropic/claude-opus-4-6',
      planner: 'google/gemini-4-neon',
      coder: 'google/gemini-4-neon',
      coderEscalation: 'anthropic/claude-sonnet-4-6',
      selfReviewer: 'openai/gpt-6.2-sol',
      finalReviewer: 'openai/gpt-6.2-sol',
      acceptor: 'anthropic/claude-opus-4-6',
      patrol: 'google/gemini-4-hydrogen',
    },
    ...overrides,
  };
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2));
  return runPath;
}

function writeReviewJournal(runPath, rows) {
  const journalPath = runPath.replace(/\.json$/, '.reviews.jsonl');
  fs.writeFileSync(journalPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const FULL_RISK = { contract: false, hotFile: false, migration: false, switchDefault: false, signature: false, foundation: false };

try {
  const cfgDir = path.join(TMP, 'cfg');
  const gitBase = path.join(TMP, 'git-fixture');
  fs.mkdirSync(gitBase, { recursive: true });
  const { work: repoWork, remoteSha } = setupGitWithRemote(gitBase, 'loop/demo-req');
  const runPath = writeRun(cfgDir, 'demo-req', {
    hubRepo: { name: 'demo', repo: 'acme/demo', path: repoWork, branch: 'main', role: 'hub' },
    repos: [{ name: 'demo', repo: 'acme/demo', path: repoWork, branch: 'main', role: 'hub' }],
  });

  const expectedRolesPath = path.join(ROOT, 'references', 'roles.md');

  check('first line points to absolute roles.md#<anchor> for all 5 roles', () => {
    const cases = [
      ['planner', 'planner'],
      ['coder', 'coder'],
      ['selfReviewer', 'self-reviewer'],
      ['finalReviewer', 'final-reviewer'],
      ['acceptor', 'acceptor'],
    ];
    for (const [role, anchor] of cases) {
      const res = runLoopctl(['brief', '--run', runPath, '--role', role, '--issue', '#42'], cfgDir);
      assert.equal(res.code, 0, `${role} failed: ${res.stdout} ${res.stderr}`);
      const lines = res.stdout.trim().split('\n');
      assert.equal(lines[0], `开工前先读 ${expectedRolesPath}#${anchor}`);
    }
  });

  check('brief fetches origin and prints demand, sub-issue link, repo, baseline, remote SHA, and project norms line', () => {
    const before = snapshotDir(cfgDir);
    const res = runLoopctl(['brief', '--run', runPath, '--role', 'coder', '--issue', '#42'], cfgDir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(res.stdout.includes('demo-req'), res.stdout);
    assert.ok(res.stdout.includes('https://github.com/acme/demo/issues/42'), res.stdout);
    assert.ok(res.stdout.includes('acme/demo'), res.stdout);
    assert.ok(res.stdout.includes('loop/demo-req'), res.stdout);
    assert.ok(res.stdout.includes(remoteSha), `expected fetched remote SHA ${remoteSha}, got:\n${res.stdout}`);
    assert.ok(res.stdout.includes('google/gemini-4-neon'), res.stdout);
    assert.ok(res.stdout.includes('项目有工程规范（AGENTS.md、CLAUDE.md、CONTRIBUTING 等）时以项目规范为准'), res.stdout);
    // Fetch updates remote refs. The run and configuration files stay byte-identical.
    assert.deepEqual(snapshotDir(cfgDir), before);
  });

  check('brief prints 未取到 when baseline SHA cannot be fetched without erroring', () => {
    const missingRun = writeRun(cfgDir, 'missing-repo', {
      hubRepo: { name: 'demo', repo: 'acme/demo', path: path.join(TMP, 'does-not-exist'), branch: 'main', role: 'hub' },
      repos: [{ name: 'demo', repo: 'acme/demo', path: path.join(TMP, 'does-not-exist'), branch: 'main', role: 'hub' }],
    });
    const res = runLoopctl(['brief', '--run', missingRun, '--role', 'planner', '--issue', 'https://github.com/acme/demo/issues/9'], cfgDir);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(res.stdout.includes('https://github.com/acme/demo/issues/9'), res.stdout);
    assert.ok(res.stdout.includes('未取到'), res.stdout);
  });

  check('coder escalates to coderEscalation after 1 reject in local review journal, with reason', () => {
    const escRun = writeRun(cfgDir, 'esc-req');
    writeReviewJournal(escRun, [
      {
        type: 'dispatch',
        dispatchId: 'd-1',
        pr: { repo: 'acme/demo', id: 7 },
        headSha: 'a'.repeat(40),
        round: 1,
        session: 'rev-1',
        nonce: 'n-1',
        at: '2026-11-23T10:00:00Z',
      },
      {
        type: 'verdict',
        dispatchId: 'd-1',
        conclusion: '打回',
        risk: FULL_RISK,
      },
    ]);

    // Rejected PR #7 -> escalates
    for (const changeArg of ['7', '#7', '!7', 'acme/demo#7', 'https://github.com/acme/demo/pull/7']) {
      const res = runLoopctl(['brief', '--run', escRun, '--role', 'coder', '--issue', '#42', '--change', changeArg], cfgDir);
      assert.equal(res.code, 0, `change=${changeArg}: ${res.stdout}`);
      assert.ok(res.stdout.includes('anthropic/claude-sonnet-4-6'), res.stdout);
      assert.ok(res.stdout.includes('打回 1 次') || res.stdout.includes('已打回 1 次'), res.stdout);
    }

    // Unrejected PR #8 -> stays on coder model
    const otherRes = runLoopctl(['brief', '--run', escRun, '--role', 'coder', '--issue', '#42', '--change', '8'], cfgDir);
    assert.equal(otherRes.code, 0, otherRes.stdout);
    assert.ok(otherRes.stdout.includes('google/gemini-4-neon'), otherRes.stdout);
    assert.ok(!otherRes.stdout.includes('anthropic/claude-sonnet-4-6'), otherRes.stdout);
  });

  check('coder falls back to roleModels.coder when rejected but coderEscalation is not configured', () => {
    const noEscRun = writeRun(cfgDir, 'no-esc-req', {
      roleModels: {
        controller: 'anthropic/claude-opus-4-6',
        coder: 'google/gemini-4-neon',
        finalReviewer: 'openai/gpt-6.2-sol',
      },
    });
    writeReviewJournal(noEscRun, [
      {
        type: 'dispatch',
        dispatchId: 'd-1',
        pr: { repo: 'acme/demo', id: 7 },
        headSha: 'a'.repeat(40),
        round: 1,
        session: 'rev-1',
        nonce: 'n-1',
        at: '2026-11-23T10:00:00Z',
      },
      { type: 'verdict', dispatchId: 'd-1', conclusion: '打回', risk: FULL_RISK },
    ]);
    const res = runLoopctl(['brief', '--run', noEscRun, '--role', 'coder', '--issue', '#42', '--change', '7'], cfgDir);
    assert.equal(res.code, 0, res.stdout);
    assert.ok(res.stdout.includes('google/gemini-4-neon'), res.stdout);
  });

  check('selfReviewer, finalReviewer, and acceptor fail with SAME_MODEL_AS_CODER when matching coder', () => {
    const sameRun = writeRun(cfgDir, 'same-model', {
      roleModels: {
        controller: 'anthropic/claude-opus-4-6',
        planner: 'google/gemini-4-neon',
        coder: 'google/gemini-4-neon',
        selfReviewer: 'google/gemini-4-neon',
        finalReviewer: ' Google/Gemini-4-Neon ',
        acceptor: 'google/gemini-4-neon',
      },
    });
    for (const role of ['selfReviewer', 'finalReviewer', 'acceptor']) {
      const res = runLoopctl(['brief', '--run', sameRun, '--role', role, '--issue', '#42'], cfgDir);
      assert.notEqual(res.code, 0, `${role} should fail`);
      assert.equal(res.json?.code, 'SAME_MODEL_AS_CODER', `${role}: ${res.stdout}`);
    }
    // planner is allowed to share coder model
    const plannerRes = runLoopctl(['brief', '--run', sameRun, '--role', 'planner', '--issue', '#42'], cfgDir);
    assert.equal(plannerRes.code, 0, plannerRes.stdout);
  });

  check('reviewers matching coderEscalation fail only when change escalated; acceptor always fails', () => {
    const escConflictRun = writeRun(cfgDir, 'esc-conflict', {
      roleModels: {
        controller: 'anthropic/claude-opus-4-6',
        coder: 'google/gemini-4-neon',
        coderEscalation: 'openai/gpt-6.2-sol',
        selfReviewer: 'openai/gpt-6.2-sol',
        finalReviewer: 'openai/gpt-6.2-sol',
        acceptor: 'openai/gpt-6.2-sol',
      },
    });
    writeReviewJournal(escConflictRun, [
      {
        type: 'dispatch',
        dispatchId: 'd-1',
        pr: { repo: 'acme/demo', id: 15 },
        headSha: 'b'.repeat(40),
        round: 1,
        session: 'rev-1',
        nonce: 'n-1',
        at: '2026-11-23T10:00:00Z',
      },
      { type: 'verdict', dispatchId: 'd-1', conclusion: '打回', risk: FULL_RISK },
    ]);

    // Exit acceptance covers the whole requirement, so it must differ from both coder and coderEscalation.
    const acceptorRes = runLoopctl(['brief', '--run', escConflictRun, '--role', 'acceptor', '--issue', '#42'], cfgDir);
    assert.equal(acceptorRes.json?.code, 'SAME_MODEL_AS_CODER', `acceptor: ${acceptorRes.stdout}`);

    // Unrejected PR #16 -> allowed because coder did not escalate
    for (const role of ['selfReviewer', 'finalReviewer']) {
      const okRes = runLoopctl(['brief', '--run', escConflictRun, '--role', role, '--issue', '#42', '--change', '16'], cfgDir);
      assert.equal(okRes.code, 0, `${role} on unrejected PR should pass: ${okRes.stdout}`);
    }

    // Rejected PR #15 -> escalated, so matching coderEscalation must fail
    for (const role of ['selfReviewer', 'finalReviewer', 'acceptor']) {
      const badRes = runLoopctl(['brief', '--run', escConflictRun, '--role', role, '--issue', '#42', '--change', '15'], cfgDir);
      assert.notEqual(badRes.code, 0, `${role} on escalated PR should fail`);
      assert.equal(badRes.json?.code, 'SAME_MODEL_AS_CODER', `${role}: ${badRes.stdout}`);
    }
  });

  check('unconfigured models print 未配置 without erroring', () => {
    const emptyModelsRun = writeRun(cfgDir, 'empty-models', { roleModels: {} });
    for (const role of ['planner', 'coder', 'selfReviewer', 'finalReviewer', 'acceptor']) {
      const res = runLoopctl(['brief', '--run', emptyModelsRun, '--role', role, '--issue', '#1'], cfgDir);
      assert.equal(res.code, 0, `${role}: ${res.stdout}`);
      assert.ok(res.stdout.includes('未配置'), res.stdout);
    }
  });

  check('invalid role and missing required flags fail clearly', () => {
    const badRole = runLoopctl(['brief', '--run', runPath, '--role', 'patrol', '--issue', '#1'], cfgDir);
    assert.notEqual(badRole.code, 0);
    assert.equal(badRole.json?.code, 'INVALID_ROLE', badRole.stdout);

    const noIssue = runLoopctl(['brief', '--run', runPath, '--role', 'coder'], cfgDir);
    assert.notEqual(noIssue.code, 0);
    assert.equal(noIssue.json?.code, 'MISSING_FLAG', noIssue.stdout);
  });

  check('linked GitLab issue uses its registered repository and GITLAB_HOST', () => {
    const glRun = writeRun(cfgDir, 'gl-multi', {
      forge: 'gitlab',
      gitlabHost: null,
      hubRepo: { name: 'core', repo: 'team/core', path: null, branch: 'main', role: 'hub' },
      repos: [
        { name: 'core', repo: 'team/core', path: null, branch: 'main', role: 'hub' },
        { name: 'web', repo: 'team/web', path: repoWork, branch: 'main', role: 'linked' },
      ],
      issues: { subIssues: [{ repo: 'team/web', id: 19 }] },
    });
    writeReviewJournal(glRun, [
      {
        type: 'dispatch',
        dispatchId: 'd-web-1',
        pr: { repo: 'team/web', id: 21 },
        headSha: 'c'.repeat(40),
        round: 1,
        session: 'rev-web-1',
        nonce: 'n-web-1',
        at: '2026-11-23T10:00:00Z',
        rejectDispatchIds: ['d-web-0'],
      },
    ]);
    for (const issue of ['19', 'team/web#19', 'https://git.example.org/team/web/-/issues/19']) {
      const res = runLoopctl(['brief', '--run', glRun, '--role', 'coder', '--issue', issue, '--change', 'https://git.example.org/team/web/-/merge_requests/21'], cfgDir, { GITLAB_HOST: 'git.example.org' });
      assert.equal(res.code, 0, res.stdout);
      assert.ok(res.stdout.includes('https://git.example.org/team/web/-/issues/19'), res.stdout);
      assert.ok(res.stdout.includes('仓库：team/web'), res.stdout);
      assert.ok(res.stdout.includes(remoteSha), res.stdout);
      assert.ok(res.stdout.includes('anthropic/claude-sonnet-4-6'), res.stdout);
    }
  });

  check('brief rejects colliding bare references and scopes model choice to the qualified change', () => {
    const multi = writeRun(cfgDir, 'collisions', {
      repos: [{ repo: 'acme/demo' }, { repo: 'acme/web' }],
      issues: { subIssues: [{ repo: 'acme/demo', id: 19 }, { repo: 'acme/web', id: 19 }] },
      changes: [{ repo: 'acme/demo', id: 21 }, { repo: 'acme/web', id: 21 }],
    });
    writeReviewJournal(multi, [{
      type: 'dispatch', dispatchId: 'web-1', pr: { repo: 'acme/web', id: 21 },
      headSha: 'c'.repeat(40), round: 1, session: 'rev-web', nonce: 'nonce',
      at: '2026-11-23T10:00:00Z', rejectDispatchIds: ['web-0'],
    }]);
    const brief = ['brief', '--run', multi, '--role', 'coder'];
    assert.equal(runLoopctl([...brief, '--issue', '19'], cfgDir).json?.code, 'AMBIGUOUS_REF');
    assert.equal(runLoopctl([...brief, '--issue', 'acme/web#19', '--change', '21'], cfgDir).json?.code, 'AMBIGUOUS_REF');
    const qualified = runLoopctl([...brief, '--issue', 'acme/web#19', '--change', 'acme/demo#21'], cfgDir, { GH_HOST: 'github.acme.test' });
    assert.equal(qualified.code, 0, qualified.stdout);
    assert.match(qualified.stdout, /https:\/\/github\.acme\.test\/acme\/web\/issues\/19/);
    assert.match(qualified.stdout, /模型：google\/gemini-4-neon/);
  });

  check('brief requires a run JSON path', () => {
    const res = runLoopctl(['brief', '--run', 'demo-req', '--role', 'coder', '--issue', '19'], cfgDir);
    assert.equal(res.json?.code, 'INVALID_RUN', res.stdout);
  });

  check('preview-init confirmSheet line 4 includes coderEscalation and acceptor', () => {
    const previewCfg = path.join(TMP, 'preview-cfg');
    fs.mkdirSync(path.join(previewCfg, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(previewCfg, 'me.yaml'), [
      'user: demo-user',
      'roleModels:',
      '  controller: anthropic/claude-opus-4-6',
      '  coder: google/gemini-4-neon',
      '  coderEscalation: anthropic/claude-sonnet-4-6',
      '  selfReviewer: openai/gpt-6.2-sol',
      '  finalReviewer: openai/gpt-6.2-sol',
      '  acceptor: anthropic/claude-opus-4-6',
      '  patrol: google/gemini-4-hydrogen',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(previewCfg, 'projects', 'demo.yaml'), [
      'forge: github',
      'defaultTier: L2',
      'hubRepo:',
      '  name: demo',
      '  repo: acme/demo',
      '  branch: main',
    ].join('\n') + '\n');

    const res = runLoopctl(['preview-init', '--req', 'demo-req', '--project', 'demo'], previewCfg);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const line4 = res.json?.confirmSheet?.[3] ?? '';
    assert.ok(line4.includes('开发升档=anthropic/claude-sonnet-4-6'), `line 4 missing coderEscalation: ${line4}`);
    assert.ok(line4.includes('验收=anthropic/claude-opus-4-6'), `line 4 missing acceptor: ${line4}`);
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f.name}\n${f.detail}\n`);
  console.error(`TOTAL PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
console.log(`TOTAL PASS ${passed} / FAIL 0`);
