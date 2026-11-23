#!/usr/bin/env node
/**
 * Independent v2 acceptance exercises. All repositories, fake platform state,
 * home/config directories and hook settings live under one os.tmpdir() tree.
 * The command guard is invoked with shell-command text; those commands are
 * never executed. Only local fixture git operations are executed for real.
 *
 * node tests/simulate-v2-guards-and-hooks.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOP = path.join(ROOT, 'scripts', 'loopctl.mjs');
const FORGE = path.join(ROOT, 'scripts', 'forge.mjs');
const HOOK = path.join(ROOT, 'hooks', 'guard-command.mjs');
const INSTALL = path.join(ROOT, 'hooks', 'install-hooks.mjs');
const SYNC = path.join(ROOT, 'scripts', 'sync-mirrors.mjs');
const INSTALL_SH = path.join(ROOT, 'install.sh');
const SOURCE_FILES = [LOOP, FORGE, path.join(ROOT, 'scripts', 'guard.mjs'),
  path.join(ROOT, 'scripts', 'lib', 'common.mjs'), HOOK, INSTALL, SYNC, INSTALL_SH];
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const initialHashes = Object.fromEntries(SOURCE_FILES.map((file) => [path.relative(ROOT, file), sha256(file)]));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-loop-v2-accept-'));
const BIN = path.join(TMP, 'bin');
const HOME_DIR = path.join(TMP, 'home');
const CONFIG = path.join(TMP, 'config');
const ACTIVE = path.join(TMP, 'repos', 'active');
const OUTSIDE = path.join(TMP, 'repos', 'outside');
const ARCHIVED = path.join(TMP, 'repos', 'archived');
const FAKE_STATE = path.join(TMP, 'forge', 'state.json');
const FAKE_LOG = path.join(TMP, 'forge', 'calls.jsonl');
const failures = [];
const groups = [];
let current;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function writeJson(file, data) { write(file, `${JSON.stringify(data, null, 2)}\n`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function group(name) { current = { name, pass: 0, fail: 0 }; groups.push(current); }
function check(name, fn) {
  try {
    fn();
    current.pass += 1;
  } catch (error) {
    current.fail += 1;
    failures.push({ group: current.name, name, detail: error?.message ?? String(error) });
  }
}
function describe(result) {
  return `exit=${result.status} stdout=${JSON.stringify((result.stdout ?? '').trim())} stderr=${JSON.stringify((result.stderr ?? '').trim())}${result.error ? ` error=${result.error.message}` : ''}`;
}
function requireExit(result, status = 0) { assert.equal(result.status, status, describe(result)); }
function requireJson(result) {
  try { return JSON.parse(result.stdout); } catch { throw new Error(`invalid JSON: ${describe(result)}`); }
}
function snapshotTree(dir) {
  const rows = [];
  function visit(file, relative) {
    const st = fs.lstatSync(file, { bigint: true });
    if (st.isDirectory()) {
      rows.push([relative, 'dir', String(st.mtimeNs), String(st.ctimeNs)]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    } else {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      rows.push([relative, 'file', String(st.size), String(st.mtimeNs), String(st.ctimeNs), hash]);
    }
  }
  if (fs.existsSync(dir)) visit(dir, '.');
  return rows;
}

const ENV = {
  HOME: HOME_DIR,
  XDG_CONFIG_HOME: path.join(HOME_DIR, '.config'),
  XDG_CACHE_HOME: path.join(HOME_DIR, '.cache'),
  TMPDIR: path.join(TMP, 'tmp'),
  PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
  LANG: 'C.UTF-8',
  XXN_LITE_LOOP_CONFIG_DIR: CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(TMP, 'empty-gitconfig'),
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_TERMINAL_PROMPT: '0',
  FAKE_FORGE_STATE: FAKE_STATE,
  FAKE_FORGE_LOG: FAKE_LOG,
  GH_BIN: path.join(BIN, 'gh'),
  GLAB_BIN: path.join(BIN, 'glab'),
};

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? TMP,
    env: { ...ENV, ...(options.env ?? {}) },
    input: options.input,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
function cli(script, args, options) { return execute(process.execPath, [script, ...args], options); }
function loop(args, config = CONFIG, options) { return cli(LOOP, [...args, '--config-dir', config], options); }
function guard(command, cwd = ACTIVE, options = {}) {
  return cli(HOOK, ['--cmd', command, '--cwd', cwd, '--config-dir', CONFIG, '--json'], options);
}
function guardPayload(payload, target, cwd = OUTSIDE) {
  return cli(HOOK, [...(target ? ['--client', target] : []), '--config-dir', CONFIG], { cwd, input: JSON.stringify(payload) });
}
function git(args, cwd = TMP) {
  const result = execute('git', ['-c', 'user.name=Loop Test', '-c', 'user.email=loop@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd });
  requireExit(result);
  return result.stdout;
}
function quoted(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

const FAKE_FORGE = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_FORGE_STATE;
const log = process.env.FAKE_FORGE_LOG;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'auth' && args[1] === 'status') {
  if (state.captureAuth) fs.appendFileSync(log, JSON.stringify({ args }) + '\\n');
  console.log('authenticated fixture');
  process.exit(0);
}
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(log, JSON.stringify({ args, stdin, parent: process.ppid }) + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const endpoint = args.at(-1);
if (args[0] === 'api' && /^(?:repos|projects)\\/.*\\/(?:branches|protected_branches)\\b/.test(endpoint)) {
  const fallback = {
    'repos/example/demo/branches?per_page=100': { body: [{ name: 'feature_demo' }] },
    'repos/example/demo/branches/feature_demo/protection': { body: {} },
  };
  const fixture = (state.branchApi ?? fallback)[endpoint];
  const status = fixture?.status ?? (fixture ? 200 : 404);
  if (args.includes('--include') && !fixture?.stderrOnly) console.log('HTTP/2 ' + status + '\\r\\n');
  if (fixture?.body) console.log(JSON.stringify(fixture.body));
  if (status >= 400) console.error('forge: ' + (fixture?.message ?? 'fixture error') + ' (HTTP ' + status + ')');
  process.exit(status < 400 ? 0 : 1);
}
if (args[0] === 'pr' && (args[1] === 'view' || args[1] === 'merge')) {
  if (args[1] === 'merge') {
    state.pr.state = 'MERGED';
    save();
  }
  console.log(JSON.stringify(state.pr));
  process.exit(0);
}
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : null;
if (state.mergeFacts && args[0] === 'api') {
  console.log('[]');
  process.exit(0);
}
const read = (args[0] === 'api' && method === 'GET') || (args[0] === 'issue' && args[1] === 'view');
const update = (args[0] === 'api' && method === 'PUT') || (args[0] === 'issue' && args[1] === 'edit');
if (read) {
  if (state.delayRead) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.delayRead);
  const oldBody = state.body;
  if (state.swapAfterRead) {
    state.body = state.nextBody;
    state.swapAfterRead = false;
    state.events.push('new-owner-wrote-after-read');
    save();
  }
  console.log(JSON.stringify({ body: oldBody, description: oldBody,
    ...(state.mergeFacts ? { state: 'OPEN', labels: [], updatedAt: '2024-05-01T04:00:00Z' } : {}) }));
  process.exit(0);
}
if (update) {
  const body = args[0] === 'api'
    ? JSON.parse(stdin || '{}').description
    : args.includes('--body') ? args[args.indexOf('--body') + 1] : undefined;
  state.body = state.swapAfterWrite ? state.nextBody : body ?? state.body;
  state.writes += 1;
  state.events.push('old-owner-wrote');
  save();
  console.log(JSON.stringify({ body, description: body }));
  process.exit(0);
}
console.error('unexpected fake forge command: ' + args.join(' '));
process.exit(1);
`;

function resetForge(body, extra = {}) {
  writeJson(FAKE_STATE, { body, writes: 0, events: [], ...extra });
  write(FAKE_LOG, '');
}
function forgeCalls() {
  return fs.readFileSync(FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

try {
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(ENV.TMPDIR, { recursive: true });
  write(ENV.GIT_CONFIG_GLOBAL, '');
  fs.symlinkSync(process.execPath, path.join(BIN, 'node'));
  for (const name of ['gh', 'glab']) {
    write(path.join(BIN, name), FAKE_FORGE);
    fs.chmodSync(path.join(BIN, name), 0o755);
  }
  resetForge('');
  for (const dir of [ACTIVE, OUTSIDE, ARCHIVED]) {
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'feature_demo', dir]);
    write(path.join(dir, 'README.md'), 'isolated fixture\n');
    git(['add', 'README.md'], dir);
    git(['commit', '-q', '-m', 'fixture'], dir);
  }
  const bare = path.join(TMP, 'repos', 'remote.git');
  git(['init', '-q', '--bare', bare]);
  git(['remote', 'add', 'origin', bare], ACTIVE);
  const project = {
    forge: 'github',
    hubRepo: { name: 'demo', repo: 'example/demo', path: ACTIVE, branch: 'feature_demo' },
    verification: { commands: {}, skipReason: 'fixture' },
    protectedEnvBranches: ['release/*', '/^feature_\\d+_uat$/'],
  };
  writeJson(path.join(CONFIG, 'me.json'), { user: 'fixture-user' });
  writeJson(path.join(CONFIG, 'projects', 'demo.json'), project);
  const hookRun = loop(['init', '--req', 'active', '--project', 'demo', '--tier', 'L2', '--branch', 'feature_demo', '--session', 'owner-hook']);
  requireExit(hookRun);
  assert.ok(requireJson(hookRun).run.protectedEnvBranches.includes('release/*'), describe(hookRun));
  assert.ok(requireJson(hookRun).run.protectedEnvBranches.includes('/^feature_\\d+_uat$/'), describe(hookRun));
  writeJson(path.join(CONFIG, 'runs', 'archive', 'archived.json'), {
    req: 'archived', status: 'archived', repos: [{ path: ARCHIVED }],
  });
  writeJson(path.join(CONFIG, 'runs', 'archived-status.json'), {
    req: 'archived-status', status: 'archived', repos: [{ path: ARCHIVED }],
  });

  group('1. normal commands: no false positives');
  const normalCommands = [
    'git status', 'git status --short', 'git status --porcelain', 'git diff', 'git diff --cached',
    'git diff main...feature_demo', 'git log', 'git log --oneline -5', 'git fetch', 'git fetch origin',
    'git pull', 'git pull --rebase origin feature_demo', 'git checkout -b feat/sub1', 'git checkout feature_demo',
    'git switch -c feat/sub2', 'git switch feature_demo', 'git branch -a', 'git branch --list',
    'git add .', 'git commit -m "fix glab mr merge and git push origin main"',
    'git rebase origin/feature_demo', 'git rebase --continue', 'git stash', 'git stash pop',
    'git cherry-pick deadbeef', 'git worktree add ../feature-wt feat/sub1',
    'git push origin feat/sub1', 'git push -u origin feat/sub1', 'git push origin --tags',
    'git push -f origin feat/sub1', 'git push --force-with-lease origin feat/sub1',
    'git push --delete origin feat/old', 'git push origin feature_demo:feat/sub1',
    'git push origin refs/tags/v1.0', 'git push --dry-run origin main',
    'git merge origin/main', 'git merge origin/master', 'git merge --abort',
    'rtk git status', 'rtk bypass git log', 'echo "git push origin main"', 'rg "gh pr merge" README.md',
    'glab mr view 1', 'glab mr list', 'glab mr create --title demo', 'glab mr note 1 --message hi',
    'glab mr merge --help', 'gh pr view 1', 'gh pr list', 'gh pr comment 1 --body hi',
    'gh pr merge --help', 'git reflog', 'git show HEAD', 'git remote -v', 'git tag -l',
    'git branch -vv', 'printf "%s" "glab mr merge 12"',
    'git push origin tag main', 'git push origin tag test refs/tags/uat', 'git push --repo=origin tag main',
    'cat <<EOF\ngit push origin main\nEOF',
    "git commit -F - <<'EOF'\ngh pr merge 8\nEOF",
    'cat <<-EOF\n\tgit merge uat\n\tEOF',
    'cat <<ONE <<TWO\ngit push origin main\nONE\ngh pr merge 8\nTWO',
    'git status # ; git push origin main',
    'gh api repos/example/demo/pulls/18/merge',
    'gh api --method GET repos/example/demo/pulls/18/merge',
    "gh api -X POST repos/example/demo/issues --raw-field 'body=/pulls/18/merge'",
  ];
  for (const command of normalCommands) check(command, () => {
    const result = guard(command);
    requireExit(result);
    const data = requireJson(result);
    assert.equal(data.decision, 'allow', describe(result));
    assert.notEqual(data.code, 'ALLOW_GUARD_ERROR', describe(result));
  });
  for (const [name, cwd] of [['inactive repository', OUTSIDE], ['archived repository', ARCHIVED]]) {
    check(`${name}: git push origin main`, () => {
      const result = guard('git push origin main', cwd);
      requireExit(result);
      assert.equal(requireJson(result).code, 'ALLOW_OUTSIDE_LOOP', describe(result));
    });
  }
  check('explicit bypass', () => {
    const result = guard('git push origin main', ACTIVE, { env: { DEV_LOOP_HOOK_BYPASS: '1' } });
    requireExit(result);
    assert.equal(requireJson(result).code, 'ALLOW_BYPASS', describe(result));
  });
  check('git -C outside repository is allowed', () => {
    const result = guard(`git -C ${quoted(OUTSIDE)} push origin main`);
    requireExit(result);
    assert.equal(requireJson(result).decision, 'allow', describe(result));
  });

  group('2. dangerous commands: block and explain');
  const dangerousCommands = [
    'git push origin main', 'git push origin master', 'git push origin test', 'git push origin uat',
    'git push origin HEAD:main', 'git push origin refs/heads/test', 'git push -f origin main',
    'git push --delete origin main', 'git push --all', 'git push --mirror',
    'git push origin :refs/heads/main', 'git push origin +feature_demo:test',
    'git push --force-with-lease origin test', 'git push origin HEAD:refs/heads/uat',
    'git push origin feature_demo:refs/heads/main', 'git push origin main feature_demo',
    'rtk git push origin test', 'rtk bypass git push origin uat',
    'git push origin release/2026.11', 'git push origin feature_123_uat',
    'git merge test', 'git merge origin/uat', 'git merge origin/test', 'git merge uat',
    'git merge release/2026.11', 'glab mr merge 12', 'gh pr merge 9',
    'glab -R example/demo mr merge 12', 'gh -R example/demo pr merge 9',
    `cd ${quoted(ACTIVE)} && git push origin main`, `git -C ${quoted(ACTIVE)} push origin test`,
    'git push origin tag main test', 'git push --repo origin main', 'git push origin HEAD:heads/test', 'git merge heads/uat',
    'cat <<EOF\ngit status\nEOF\ngit push origin main',
    'git status # ignored\ngit merge test',
    'env -u VARIABLE git push origin main', 'sudo -u root -- git push origin test',
    'bash -lc "git push origin test"', "zsh -c 'sh -c \"git merge test\"'",
    'gh api -XPUT repos/example/demo/pulls/9/merge',
    'glab api --method=PUT projects/example%2Fdemo/merge_requests/12/merge',
    'glab api /projects/example%2Fdemo/merge_requests/12/merge --field sha=fixture',
  ];
  function assertBlocked(result) {
    requireExit(result, 2);
    const data = requireJson(result);
    assert.equal(data.decision, 'block', describe(result));
    assert.match(data.reason, /原因[：:]/, describe(result));
    assert.match(data.reason, /建议[：:]/, describe(result));
    assert.match(data.reason, /人工|forge\.mjs|需求分支/, describe(result));
  }
  for (const command of dangerousCommands) check(command, () => assertBlocked(guard(command)));
  check('a project custom trunk is protected from pushes', () => {
    const result = guard('git push origin feature_demo');
    assertBlocked(result);
    assert.equal(requireJson(result).code, 'PUSH_PROTECTED_BRANCH');
  });
  check('argumentless merge checks the configured upstream', () => {
    git(['update-ref', 'refs/remotes/origin/test', 'HEAD'], ACTIVE);
    git(['branch', '--set-upstream-to=origin/test', 'feature_demo'], ACTIVE);
    try {
      for (const command of ['git merge', 'git merge --ff-only', 'git merge @{u}']) {
        const result = guard(command);
        assertBlocked(result);
        assert.equal(requireJson(result).code, 'MERGE_PROTECTED_ENV');
      }
    } finally {
      git(['branch', '--unset-upstream', 'feature_demo'], ACTIVE);
      git(['update-ref', '-d', 'refs/remotes/origin/test'], ACTIVE);
    }
    requireExit(guard('git merge'));
  });
  check('legacy invalid branch rules block guarded writes and leave other commands alone', () => {
    const file = path.join(CONFIG, 'runs', 'active.json');
    const run = readJson(file);
    writeJson(file, { ...run, protectedEnvBranches: [...run.protectedEnvBranches, '/test/g'] });
    try {
      for (const command of ['git push origin feature_demo', 'git push origin main', 'git merge origin/feature_demo', 'git merge', 'gh pr merge 9']) {
        const result = guard(command);
        requireExit(result, 2);
        assert.equal(requireJson(result).code, 'INVALID_BRANCH_PATTERN', describe(result));
        assert.match(requireJson(result).reason, /doctor/, describe(result));
      }
      for (const command of ['git status', 'git push --dry-run origin main', 'git push origin --tags', 'git merge --abort', 'gh pr view 9']) {
        const result = guard(command);
        requireExit(result);
        assert.equal(requireJson(result).code, 'ALLOW_IN_LOOP', describe(result));
      }
    } finally {
      writeJson(file, run);
    }
  });
  for (const command of [`cd ${quoted(ACTIVE)} && git push origin main`, `git -C ${quoted(ACTIVE)} push origin test`]) {
    check(`from outside: ${command}`, () => assertBlocked(guard(command, OUTSIDE)));
  }
  check('returning to active repository after cd outside still blocks push', () => {
    const command = `cd ${quoted(OUTSIDE)} && cd ${quoted(ACTIVE)} && git push origin main`;
    assertBlocked(guard(command));
  });
  check('joined git -C works from outside', () => assertBlocked(guard(`git -C${quoted(ACTIVE)} push origin test`, OUTSIDE)));
  check('git-dir in the active repo works from outside', () => {
    assertBlocked(guard(`git --git-dir=${quoted(path.join(ACTIVE, '.git'))} push origin main`, OUTSIDE));
  });
  check('git-dir outside the active repo takes precedence over cwd', () => {
    const result = guard(`git --git-dir ${quoted(path.join(OUTSIDE, '.git'))} push origin main`);
    requireExit(result);
    assert.equal(requireJson(result).decision, 'allow', describe(result));
  });
  check('env -C sets the directory for a nested shell', () => {
    assertBlocked(guard(`env -u UNUSED -C ${quoted(ACTIVE)} bash -lc 'git push origin main'`, OUTSIDE));
  });
  check('leaving a subshell restores the active outer directory', () => {
    assertBlocked(guard(`(cd ${quoted(OUTSIDE)} && git push origin main); git push origin test`));
  });
  check('nested subshell cannot change the outer inactive directory', () => {
    const result = guard(`((cd ${quoted(ACTIVE)} && git status)); git push origin main`, OUTSIDE);
    requireExit(result);
    assert.equal(requireJson(result).code, 'ALLOW_OUTSIDE_LOOP', describe(result));
  });
  check('cd - returns to active repository', () => {
    assertBlocked(guard(`cd ${quoted(OUTSIDE)} && cd - && git push origin main`));
  });
  check('Git worktree maps through .git and commondir to the active main repository', () => {
    const linked = path.join(TMP, 'T3 mirror 工作树');
    git(['worktree', 'add', '-q', '-b', 'linked-feature', linked], ACTIVE);
    assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
    assertBlocked(guard('git push origin main', linked));
    assertBlocked(guard(`git -C ${quoted(linked)} merge test`, OUTSIDE));
  });
  check('an unregistered nested Git repo keeps its own guard context', () => {
    const nested = path.join(ACTIVE, 'independent');
    git(['init', '-q', '-b', 'feature_demo', nested]);
    const result = guard('git push origin main', nested);
    requireExit(result);
    assert.equal(requireJson(result).code, 'ALLOW_OUTSIDE_LOOP', describe(result));
  });
  check('merge from this repo custom production branch is allowed', () => {
    const file = path.join(CONFIG, 'runs', 'stable.json');
    writeJson(file, { req: 'stable', repos: [{ path: OUTSIDE, branch: 'release/stable' }], protectedEnvBranches: ['release/*'] });
    try {
      const result = guard('git merge origin/release/stable', OUTSIDE);
      requireExit(result);
      assert.equal(requireJson(result).decision, 'allow', describe(result));
      assertBlocked(guard('git merge origin/release/other', OUTSIDE));
    } finally {
      fs.rmSync(file);
    }
  });
  git(['branch', 'main'], ACTIVE);
  git(['switch', '-q', 'main'], ACTIVE);
  check('bare git push while checked out on main', () => assertBlocked(guard('git push')));
  git(['switch', '-q', 'feature_demo'], ACTIVE);
  const hookPayloads = [
    ['claude', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: ACTIVE }],
    ['codex', { toolName: 'shell', toolInput: { command: 'git push origin test', workingDirectory: ACTIVE } }],
  ];
  for (const [target, payload] of hookPayloads) check(`${target} PreToolUse stdin`, () => {
    const result = guardPayload(payload, target);
    assertBlocked(result);
    assert.equal(requireJson(result).hookSpecificOutput.permissionDecision, 'deny', describe(result));
  });

  function assertAntigravity(result, decision) {
    requireExit(result);
    const data = requireJson(result);
    if (decision === 'allow') assert.deepEqual(data, { decision });
    else {
      assert.deepEqual(Object.keys(data).sort(), ['decision', 'reason']);
      assert.equal(data.decision, decision, describe(result));
      assert.match(data.reason, /人工|forge\.mjs|需求分支/, describe(result));
    }
    assert.equal(result.stderr, '');
  }
  for (const [name, payload, client] of [
    ['tool name', { tool_name: 'run_command', tool_input: { CommandLine: 'git push origin uat' }, cwd: ACTIVE }],
    ['Cwd', { tool_input: { CommandLine: 'git push origin uat', Cwd: ACTIVE } }],
    ['explicit client', { toolCall: { arguments: JSON.stringify({ CommandLine: 'git push origin uat', workingDirectory: ACTIVE }) } }, 'antigravity'],
  ]) check(`Antigravity detects ${name} and denies with exit 0`, () => {
    assertAntigravity(guardPayload(payload, client), 'deny');
  });
  check('Antigravity emits explicit allow for a normal command', () => {
    assertAntigravity(guardPayload({ tool_name: 'run_command', tool_input: { CommandLine: 'git status', Cwd: ACTIVE } }), 'allow');
    assertAntigravity(guardPayload({ tool_input: { CommandLine: 'git status', Cwd: '' } }), 'allow');
  });

  group('3. ledger, doctor, transitions, owner, status and patrol');
  const ledgers = {};
  for (const tier of ['L1', 'L2', 'L3']) {
    const result = loop(['init', '--req', `init-${tier.toLowerCase()}`, '--project', 'demo', '--tier', tier,
      '--branch', 'feature_demo', '--session', `owner-${tier}`]);
    check(`${tier} real init`, () => {
      requireExit(result);
      assert.equal(requireJson(result).ok, true, describe(result));
    });
    ledgers[tier] = result.status === 0 ? requireJson(result).ledgers : [];
    const kinds = tier === 'L1' ? ['tracking'] : tier === 'L2' ? ['main'] : ['master', 'slot'];
    for (const kind of kinds) check(`${tier} init ${kind} ledger passes lint`, () => {
      const ledger = ledgers[tier].find((item) => item.kind === kind);
      assert.ok(ledger, `init did not produce ${kind}`);
      const args = ['ledger-lint', '--tier', tier, '--body', ledger.body];
      if (kind === 'master') args.push('--kind', 'master');
      const lint = loop(args);
      requireExit(lint);
      assert.equal(requireJson(lint).ok, true, describe(lint));
    });
  }
  const personal = ledgers.L2.find((item) => item.kind === 'main')?.body ?? '';
  for (const [name, body, expected] of [
    ['L2 above 80 lines', `${personal}\n${'padding\n'.repeat(81)}`, 'LINE_LIMIT_EXCEEDED'],
    ['missing section', personal.replace(/^## 5\..*$/m, '## Removed'), 'MISSING_SECTION'],
    ['illegal state', personal.replace('状态：未开始', '状态：乱写'), 'INVALID_STATE'],
    ['code fence', `${personal}\n\`\`\`js\nconst x = 1\n\`\`\`\n`, 'CODE_FENCE_FORBIDDEN'],
  ]) check(`ledger lint rejects ${name}`, () => {
    const result = loop(['ledger-lint', '--tier', 'L2', '--body', body]);
    requireExit(result, 2);
    const data = requireJson(result);
    assert.equal(data.ok, false, describe(result));
    assert.ok(data.issues.some((issue) => issue.code === expected), describe(result));
  });
  for (const [tier, kind] of [['L1', 'tracking'], ['L3', 'slot'], ['L3', 'master']]) {
    check(`${tier} ${kind} detects its line limit`, () => {
      const original = ledgers[tier].find((item) => item.kind === kind)?.body ?? '';
      const args = ['ledger-lint', '--tier', tier, '--body', `${original}\n${'padding\n'.repeat(tier === 'L1' ? 101 : 81)}`];
      if (kind === 'master') args.push('--kind', 'master');
      const result = loop(args);
      requireExit(result, 2);
      assert.ok(requireJson(result).issues.some((issue) => issue.code === 'LINE_LIMIT_EXCEEDED'), describe(result));
    });
  }

  function doctor(config, extra = [], options = {}) {
    const result = loop(['doctor', '--cwd', ACTIVE, ...extra], config, options);
    requireExit(result);
    return requireJson(result);
  }
  function doctorCheck(data, id) { return data.checks.find((item) => item.id === id); }
  check('doctor healthy environment is PASS', () => {
    const data = doctor(CONFIG, ['--project', 'demo']);
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.ok(data.checks.every((item) => item.status === 'PASS'), JSON.stringify(data));
    assert.ok(data.supportedTiers.includes('L1'), JSON.stringify(data));
    assert.match(doctorCheck(data, 'forge-branch-protection').detail, /feature_demo 已保护/);
  });
  check('doctor GitHub checks only existing exact branches, including names with slashes', () => {
    const config = path.join(TMP, 'doctor-github-branches');
    writeJson(path.join(config, 'me.json'), { user: 'fixture-user' });
    writeJson(path.join(config, 'projects', 'demo.json'), { ...project, protectedEnvBranches: [...project.protectedEnvBranches, 'release/current'] });
    const root = 'repos/example/demo/branches';
    resetForge('', { branchApi: {
      [root + '?per_page=100']: { body: [{ name: 'feature_demo' }, { name: 'release/current' }, { name: 'release/old' }, { name: 'feature_123_uat' }] },
      [root + '/feature_demo/protection']: { body: {} },
      [root + '/release%2Fcurrent/protection']: { status: 404, stderrOnly: true },
    } });
    const data = doctor(config);
    const item = doctorCheck(data, 'forge-branch-protection');
    assert.equal(item.status, 'WARN', JSON.stringify(data));
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.deepEqual(data.supportedTiers, ['L1', 'L2', 'L3']);
    assert.match(item.detail, /feature_demo 已保护/);
    assert.match(item.detail, /release\/current .*HTTP 404/);
    assert.match(item.fix, /gh api --method PUT 'repos\/example\/demo\/branches\/release%2Fcurrent\/protection' --input branch-protection\.json/);
    assert.deepEqual(forgeCalls().map((call) => call.args.at(-1)), [root + '?per_page=100', root + '/feature_demo/protection', root + '/release%2Fcurrent/protection']);
  });
  for (const [name, fixture, detail] of [
    ['HTTP 403', { status: 403 }, /HTTP 403/],
    ['plan restriction', { status: 404, message: 'Upgrade to GitHub Pro or make this repository public to enable this feature' }, /仓库套餐不支持/],
  ]) {
    check('doctor GitHub ' + name + ' recommends the Hook without blocking', () => {
      const root = 'repos/example/demo/branches';
      resetForge('', { branchApi: { [root + '?per_page=100']: { body: [{ name: 'feature_demo' }] }, [root + '/feature_demo/protection']: fixture } });
      const data = doctor(CONFIG, ['--project', 'demo']);
      const item = doctorCheck(data, 'forge-branch-protection');
      assert.equal(item.status, 'WARN');
      assert.equal(data.ok, true);
      assert.match(item.detail, detail);
      assert.match(item.fix, /hooks\/install-hooks\.mjs/);
      assert.doesNotMatch(item.fix, /--method PUT/);
    });
  }
  check('doctor GitHub Enterprise uses the project hostname for auth and branch protection', () => {
    const config = path.join(TMP, 'doctor-ghe');
    const hostname = 'github.example.test';
    writeJson(path.join(config, 'me.json'), { user: 'fixture-user' });
    writeJson(path.join(config, 'projects', 'demo.json'), { ...project, hostname });
    resetForge('', { captureAuth: true });
    const data = doctor(config);
    assert.equal(doctorCheck(data, 'forge-branch-protection').status, 'PASS');
    assert.deepEqual(forgeCalls().map((call) => call.args.slice(0, call.args[0] === 'auth' ? 4 : 3)), [
      ['auth', 'status', '--hostname', hostname], ['api', '--hostname', hostname], ['api', '--hostname', hostname],
    ]);
  });
  check('doctor GitLab reads actual branches and paginated protection on the configured instance', () => {
    const config = path.join(TMP, 'doctor-gitlab-branches');
    const hostname = 'gitlab.example.test';
    const repo = 'org/team/demo';
    writeJson(path.join(config, 'me.json'), { user: 'fixture-user' });
    writeJson(path.join(config, 'projects', 'demo.json'), {
      ...project, forge: 'gitlab', gitlabHost: hostname, hubRepo: { ...project.hubRepo, repo },
      protectedEnvBranches: ['release/*', 'release/current'],
    });
    const root = 'projects/org%2Fteam%2Fdemo';
    const branches = root + '/repository/branches?per_page=100';
    const rules = root + '/protected_branches?per_page=100';
    resetForge('', { branchApi: {
      [branches]: { body: [{ name: 'feature_demo' }, { name: 'release/current' }, { name: 'release/old' }] },
      [rules]: { body: Array.from({ length: 100 }, (_, i) => ({ name: 'rule-' + i })) },
      [rules + '&page=2']: { body: [{ name: 'release/*' }] },
    } });
    const data = doctor(config);
    const item = doctorCheck(data, 'forge-branch-protection');
    assert.equal(item.status, 'WARN');
    assert.equal(data.ok, true);
    assert.match(item.detail, /feature_demo 未保护/);
    assert.match(item.detail, /release\/current 已保护/);
    assert.doesNotMatch(item.detail, /release\/old/);
    assert.match(item.fix, /--method POST 'projects\/org%2Fteam%2Fdemo\/protected_branches' --raw-field 'name=feature_demo'/);
    assert.deepEqual(forgeCalls().map((call) => call.args), [branches, rules, rules + '&page=2'].map((endpoint) => ['api', '--hostname', hostname, endpoint]));
  });
  check('doctor reports a remote branch listing failure as unknown', () => {
    const root = 'repos/example/demo/branches';
    resetForge('', { branchApi: { [root + '?per_page=100']: { status: 403 } } });
    const data = doctor(CONFIG, ['--project', 'demo']);
    const item = doctorCheck(data, 'forge-branch-protection');
    assert.equal(item.status, 'WARN');
    assert.match(item.detail, /无法读取.*HTTP 403/);
    assert.deepEqual(forgeCalls().map((call) => call.args.at(-1)), [root + '?per_page=100']);
    resetForge('');
  });
  const uninitialized = path.join(TMP, 'uninitialized-config');
  check('doctor uninitialized is WARN and permits L1', () => {
    const data = doctor(uninitialized);
    assert.equal(doctorCheck(data, 'config').status, 'WARN', JSON.stringify(data));
    assert.ok(data.supportedTiers.includes('L1'), JSON.stringify(data));
  });
  const notifyConfig = path.join(TMP, 'notify-config');
  writeJson(path.join(notifyConfig, 'me.json'), { user: 'fixture-user' });
  writeJson(path.join(notifyConfig, 'projects', 'demo.json'), { ...project, notify: { feishuGroupChatId: 'oc_fixture' } });
  check('missing optional lark-cli is WARN and permits L1', () => {
    const data = doctor(notifyConfig, ['--project', 'demo']);
    assert.equal(doctorCheck(data, 'notify-lark').status, 'WARN', JSON.stringify(data));
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.deepEqual(data.supportedTiers, ['L1', 'L2', 'L3'], JSON.stringify(data));
    assert.equal(data.externalNotifyAvailable, false, JSON.stringify(data));
  });
  check('doctor chooses the cwd project among multiple profiles and skips assignment tokens', () => {
    const config = path.join(TMP, 'multi-doctor');
    writeJson(path.join(config, 'me.json'), { user: 'fixture-user' });
    writeJson(path.join(config, 'projects', 'first.json'), { ...project, forge: 'gitlab', hubRepo: { ...project.hubRepo, path: OUTSIDE } });
    writeJson(path.join(config, 'projects', 'second.json'), { ...project, verification: { commands: { demo: 'CI=1 NOTE="two words" node --version' } } });
    const data = doctor(config);
    assert.equal(doctorCheck(data, 'config').status, 'PASS', JSON.stringify(data));
    assert.match(doctorCheck(data, 'config').detail, /second\.json/);
    assert.equal(doctorCheck(data, 'verification-command').status, 'PASS', JSON.stringify(data));
    assert.match(doctorCheck(data, 'verification-command').detail, /node/);
  });
  const shim = path.join(TMP, 'node18.cjs');
  write(shim, "Object.defineProperty(process, 'version', { value: 'v18.20.0' });\n");
  const nodeVersions = path.resolve(path.dirname(process.execPath), '../..');
  const oldNode = (fs.existsSync(nodeVersions) ? fs.readdirSync(nodeVersions) : [])
    .map((name) => ({ name, major: Number(/^v(\d+)\./.exec(name)?.[1] ?? 0) }))
    .filter((item) => item.major > 0 && item.major < 20)
    .sort((a, b) => b.major - a.major)
    .map((item) => path.join(nodeVersions, item.name, 'bin', 'node'))
    .find((file) => fs.existsSync(file));
  check(`Node version below 20 is BLOCK (${oldNode ? 'real older Node executable' : 'version injected in isolated process'})`, () => {
    const args = [LOOP, 'doctor', '--cwd', ACTIVE, '--project', 'demo', '--config-dir', CONFIG];
    const result = oldNode ? execute(oldNode, args) : execute(process.execPath, ['--require', shim, ...args]);
    requireExit(result);
    const data = requireJson(result);
    assert.equal(doctorCheck(data, 'node-version').status, 'BLOCK', JSON.stringify(data));
    assert.deepEqual(data.supportedTiers, [], JSON.stringify(data));
  });
  const badConfig = path.join(TMP, 'bad-config');
  write(path.join(badConfig, 'me.yaml'), 'user: [unclosed\n');
  writeJson(path.join(badConfig, 'projects', 'demo.json'), project);
  check('invalid YAML is BLOCK with parse reason', () => {
    const data = doctor(badConfig, ['--project', 'demo']);
    assert.equal(doctorCheck(data, 'config').status, 'BLOCK', JSON.stringify(data));
    assert.match(doctorCheck(data, 'config').detail, /INVALID_CONFIG|解析/, JSON.stringify(data));
  });

  const oldBody = '## 1. 基本信息\n主控：第 1 任 ｜ old-session ｜ local\n旧主控';
  const newBody = '## 1. 基本信息\n主控：第 2 任 ｜ new-session ｜ local\n新主控';
  const updatedBody = `${oldBody}\n已更新`;
  function issueUpdateArgs(forge, args) {
    return ['issue-update', '--forge', forge, '--repo', 'example/demo', '--id', '12', '--body', updatedBody, '--config-dir', CONFIG, ...args];
  }
  function issueUpdate(forge, args = []) {
    return cli(FORGE, issueUpdateArgs(forge, args));
  }
  for (const forge of ['gitlab', 'github']) {
    check(`${forge} matching owner reads then writes`, () => {
      resetForge(oldBody);
      const result = issueUpdate(forge, ['--expect-owner', 'old-session']);
      requireExit(result);
      assert.equal(requireJson(result).ownerCheck.matched, true, describe(result));
      assert.equal(readJson(FAKE_STATE).body, updatedBody);
      assert.equal(readJson(FAKE_STATE).writes, 1);
      assert.equal(fs.readdirSync(path.join(CONFIG, 'locks')).length, 0);
    });
    check(`${forge} changed owner rejects without write`, () => {
      resetForge(newBody);
      const result = issueUpdate(forge, ['--expect-owner', 'old-session']);
      requireExit(result, 2);
      assert.equal(requireJson(result).code, 'OWNER_CHANGED', describe(result));
      assert.equal(readJson(FAKE_STATE).body, newBody);
      assert.equal(readJson(FAKE_STATE).writes, 0);
      assert.equal(forgeCalls().length, 1);
    });
    check(`${forge} handoff verifies the new owner after skipping the old owner check`, () => {
      resetForge(oldBody);
      const result = issueUpdate(forge, ['--expect-owner', 'new-session', '--handoff', '--body', newBody]);
      requireExit(result);
      assert.equal(requireJson(result).ownerCheck.mode, 'handoff-skip', describe(result));
      assert.equal(readJson(FAKE_STATE).body, newBody);
      assert.equal(readJson(FAKE_STATE).writes, 1);
    });
    check(`${forge} no expect-owner remains compatible`, () => {
      resetForge(newBody);
      const result = issueUpdate(forge);
      requireExit(result);
      assert.equal(readJson(FAKE_STATE).writes, 1);
      assert.equal(forgeCalls().length, 1);
    });
    check(`${forge} owner change between GET and write must not be overwritten`, () => {
      resetForge(oldBody, { swapAfterRead: true, nextBody: newBody });
      const result = issueUpdate(forge, ['--expect-owner', 'old-session']);
      requireExit(result, 2);
      assert.equal(requireJson(result).code, 'OWNER_CHANGED', describe(result));
      const state = readJson(FAKE_STATE);
      assert.equal(state.body, newBody, `new owner was overwritten: ${describe(result)} state=${JSON.stringify(state)} calls=${JSON.stringify(forgeCalls())}`);
      assert.equal(state.writes, 0, JSON.stringify(state));
    });
    for (const [name, body, code] of [
      ['owner line exists only in section 2', '## 1. 整体状态\n运行中\n## 2. 记录\n主控：第 1 任 ｜ old-session', 'OWNER_MISSING'],
      ['two owners are in section 1', `${oldBody}\n主控：第 2 任 ｜ new-session\n## 2. 记录`, 'OWNER_AMBIGUOUS'],
      ['an incidental sentence is not an owner line', '## 1. 整体状态\n过去记录主控：第 1 任 ｜ old-session', 'OWNER_MISSING'],
    ]) check(`${forge} refuses invalid ledger ownership: ${name}`, () => {
      resetForge(body);
      const result = issueUpdate(forge, ['--expect-owner', 'old-session']);
      requireExit(result, 2);
      assert.equal(requireJson(result).code, code, describe(result));
      assert.equal(readJson(FAKE_STATE).writes, 0);
    });
    check(`${forge} section 2 history does not override a valid owner`, () => {
      resetForge(`${oldBody}\n## 2. 历史\n主控：第 9 任 ｜ previous-session`);
      requireExit(issueUpdate(forge, ['--expect-owner', 'old-session']));
      assert.equal(readJson(FAKE_STATE).writes, 1);
    });
    check(`${forge} detects an owner change after the write and propagates exit 2`, () => {
      resetForge(oldBody, { swapAfterWrite: true, nextBody: newBody });
      const result = issueUpdate(forge, ['--expect-owner', 'old-session']);
      requireExit(result, 2);
      assert.equal(requireJson(result).code, 'OWNER_CONFLICT_POST_WRITE', describe(result));
      assert.equal(readJson(FAKE_STATE).body, newBody);
      assert.equal(readJson(FAKE_STATE).writes, 1);
    });
    check(`${forge} guarded update cannot remove or replace the owner line`, () => {
      resetForge(oldBody);
      const result = issueUpdate(forge, ['--expect-owner', 'old-session', '--body', newBody]);
      requireExit(result, 2);
      assert.equal(requireJson(result).code, 'OWNER_UPDATE_MISMATCH', describe(result));
      assert.equal(readJson(FAKE_STATE).writes, 0);
    });
  }


  resetForge(oldBody, { delayRead: 100 });
  const concurrent = await Promise.all(['one', 'two'].map((suffix) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORGE, ...issueUpdateArgs('github', [
      '--expect-owner', 'old-session', '--body', `${oldBody}\n${suffix}`,
    ])], { cwd: TMP, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  })));
  check('local concurrent issue writers run reads and writes serially and both complete', () => {
    concurrent.forEach((result) => requireExit(result));
    assert.equal(readJson(FAKE_STATE).writes, 2);
    const calls = forgeCalls().map((call) => call.parent);
    assert.equal(new Set(calls).size, 2);
    assert.equal(calls.filter((pid, i) => i > 0 && pid !== calls[i - 1]).length, 1, JSON.stringify(calls));
    assert.deepEqual(fs.readdirSync(path.join(CONFIG, 'locks')), []);
  });
  check('forge blocks automatic merge into the configured production trunk', () => {
    const file = path.join(TMP, 'trunk-run.json');
    writeJson(file, { repos: [{ repo: 'example/demo', branch: 'release/stable' }], baselineBranch: 'release/stable' });
    const result = cli(FORGE, ['change-merge', '--forge', 'github', '--repo', 'example/demo', '--id', '13',
      '--target', 'release/stable', '--head-sha', 'fixture-sha', '--run', file, '--dry-run']);
    requireExit(result, 2);
    assert.equal(requireJson(result).code, 'ENV_BRANCH_FORBIDDEN', describe(result));
  });
  for (const [name, fields, expected] of [
    ['subIssues', { issues: { main: { id: 12 }, subIssues: [{ id: 41 }] } }, null],
    ['demandIssues', { issues: { main: { id: 12 } }, demandIssues: [41] }, null],
    ['unrelated issue with only a ledger in the run', { issues: { main: { id: 12 } } }, 'ISSUE_REF_NOT_IN_RUN'],
  ]) check(`forge issue reference allowlist: ${name}`, () => {
    const file = path.join(TMP, 'issue-refs-run.json');
    const headSha = 'a'.repeat(40);
    writeJson(file, { req: 'demo', forge: 'github', autoMerge: true, repos: [{ repo: 'example/demo' }], baselineBranch: 'loop/demo', ...fields });
    write(file.replace(/\.json$/, '.reviews.jsonl'), [
      { type: 'dispatch', dispatchId: 'fixture', headSha, session: 'reviewer', nonce: 'fixture',
        round: 1, at: '2024-05-01T04:00:00Z', pr: { repo: 'example/demo', id: 13 } },
      { type: 'verdict', dispatchId: 'fixture', conclusion: '通过',
        risk: { contract: false, hotFile: false, migration: false, switchDefault: false, signature: false, foundation: false } },
      { type: 'merge-result', dispatchId: 'fixture', state: 'waiting', code: 'DEPENDS_ON_UNMERGED', rejectCount: 0 },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    resetForge('', { mergeFacts: true, pr: { baseRefName: 'loop/demo', headRefName: 'feat/demo', headRefOid: headSha, body: 'Refs #41', state: 'OPEN', labels: ['需求:demo', '待合并'] } });
    const result = cli(FORGE, ['change-merge', '--forge', 'github', '--repo', 'example/demo', '--id', '13',
      '--target', 'loop/demo', '--head-sha', headSha, '--run', file]);
    requireExit(result, expected ? 2 : 0);
    const data = requireJson(result);
    if (expected) assert.equal(data.code, expected, JSON.stringify(data));
    else assert.equal(data.merged, true, JSON.stringify(data));
  });

  const live = {
    slots: [{ slot: 'green', owner: 'g' }, { slot: 'yellow', owner: 'y' }, { slot: 'red', owner: 'r' }],
    mrs: [{ repo: 'example/demo', id: 7, state: 'OPEN', labels: ['槽位yellow', { name: '待终审' }] }],
    escalations: [{ id: 'urgent', slot: 'red', blocking: true, resolved: false }],
  };
  const statusResult = loop(['status', '--json', '--req', 'init-l3', '--live', '--live-input', JSON.stringify(live)]);
  check('live status places red actions first and nextPrompt follows', () => {
    requireExit(statusResult);
    const data = requireJson(statusResult).live;
    assert.equal(data.actionRequired[0].level, 'red', JSON.stringify(data));
    assert.ok(data.actionRequired.some((item) => item.level === 'yellow'), JSON.stringify(data));
    assert.ok(data.nextPrompt.includes(data.actionRequired[0].text), JSON.stringify(data));
  });
  check('live slot lights are ordered red, yellow, green', () => {
    requireExit(statusResult);
    const data = requireJson(statusResult).live;
    assert.deepEqual(data.slotHealth.map((item) => item.level), ['red', 'yellow', 'green'], JSON.stringify(data.slotHealth));
  });
  check('live req selects the exact active demand and rejects a conflicting explicit req', () => {
    const args = ['--live-input', JSON.stringify({ ...live, req: 'init-l3' })];
    const result = loop(['status', '--json', ...args]);
    requireExit(result);
    const data = requireJson(result);
    assert.ok(data.activeRuns.length > 1);
    assert.equal(data.live.overview.req, 'init-l3');
    assert.equal(data.live.overview.tier, 'L3');
    const conflict = loop(['status', '--json', '--req', 'init-l2', ...args]);
    requireExit(conflict, 2);
    assert.equal(requireJson(conflict).code, 'LIVE_REQ_CONFLICT');
  });
  check('bare live status uses Forge membership and ignores stale changes and blockers in run.json', () => {
    const file = path.join(CONFIG, 'runs', 'init-l3.json');
    const original = fs.readFileSync(file, 'utf8');
    writeJson(file, {
      ...JSON.parse(original),
      changes: [{ repo: 'example/demo', id: 7, state: 'OPEN', labels: ['槽位A', { name: '需修改' }] }],
      blockers: [{ id: 'still-blocking', slot: 'B' }, { id: 'closed', closed: true }],
    });
    try {
      const result = loop(['status', '--json', '--req', 'init-l3', '--live']);
      requireExit(result);
      const data = requireJson(result).live;
      assert.equal(data.overview.source, 'forge');
      assert.equal(data.overview.totals.needsChanges, 0);
      assert.equal(data.overview.totals.blockingEscalations, 0);
      assert.ok(!data.actionRequired.some(({ ref }) => ref === 'still-blocking'));
    } finally {
      write(file, original);
    }
  });
  check('config protects a regex with a comma followed by another branch rule', () => {
    const loaded = loop(['config-resolve', '--project', 'demo', '--overrides', JSON.stringify({ protectedEnvBranches: '/^rel_\\d{1,2}$/,staging' })]);
    requireExit(loaded);
    assert.deepEqual(requireJson(loaded).protectedEnvBranches.slice(-2), ['/^rel_\\d{1,2}$/', 'staging']);
  });
  check('config-resolve and init reject invalid rules before creating a run', () => {
    for (const rule of ['/(unclosed/', '/^release/g', '/no-delimiter']) {
      const overrides = JSON.stringify({ protectedEnvBranches: [rule] });
      for (const args of [['config-resolve'], ['init', '--req', 'bad-pattern', '--branch', 'feature_demo']]) {
        const result = loop([...args, '--project', 'demo', '--overrides', overrides]);
        requireExit(result, 2);
        assert.equal(requireJson(result).code, 'INVALID_BRANCH_PATTERN', describe(result));
        assert.equal(requireJson(result).pattern, rule);
      }
    }
    assert.equal(fs.existsSync(path.join(CONFIG, 'runs', 'bad-pattern.json')), false);
  });
  const l3Personal = ledgers.L3.find((item) => item.kind === 'slot')?.body ?? '';

  check('lint handles section 5 anchor and trailing newline counting', () => {
    const body = l3Personal.replace('流程提醒与规则引用', '流程提醒').trimEnd();
    const maxLines = body.split('\n').length;
    const lint = loop(['ledger-lint', '--tier', 'L3', '--body', `${body}\n`, '--max-lines', String(maxLines)]);
    requireExit(lint);
    assert.equal(requireJson(lint).lineCount, maxLines);
    const double = loop(['ledger-lint', '--tier', 'L3', '--body', `${body}\n\n`, '--max-lines', String(maxLines)]);
    requireExit(double, 2);
    assert.equal(requireJson(double).lineCount, maxLines + 1);
  });

  group('5. hook installation, idempotence and uninstall');
  const initial = {
    permissions: { allow: ['Read'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: 'rtk hook --existing' },
        { type: 'command', command: 'node other-tool/guard-command.mjs' },
      ] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk after' }] }],
    },
  };
  for (const [target, suffix] of [['claude', '.claude/settings.json'], ['codex', '.codex/hooks.json'], ['antigravity', '.agents/hooks.json']]) {
    const scope = path.join(TMP, 'hook-install', target);
    const file = path.join(scope, suffix);
    writeJson(file, initial);
    const args = ['--target', target, '--scope', 'project', '--cwd', scope, '--config-dir', CONFIG];
    const clientKey = target === 'antigravity' ? 'xxn-lite-loop:guard-command' : 'hooks';
    const first = cli(INSTALL, args);
    check(`${target} install preserves existing rtk hook`, () => {
      requireExit(first);
      assert.equal(requireJson(first).ok, true, describe(first));
      const data = readJson(file);
      assert.deepEqual(data.hooks.PreToolUse[0], initial.hooks.PreToolUse[0]);
      assert.deepEqual(data.hooks.PostToolUse, initial.hooks.PostToolUse);
      const owned = data[clientKey].PreToolUse.filter((entry) => entry.hooks?.some((hook) => hook.command?.endsWith(' # xxn-lite-loop:guard-command')));
      assert.equal(owned.length, 1);
      assert.equal(owned[0].matcher, target === 'antigravity' ? 'run_command' : 'Bash');
    });
    check(`${target} installed hook actually blocks protected push`, () => {
      const data = readJson(file);
      const command = data[clientKey].PreToolUse.flatMap((entry) => entry.hooks ?? []).find((hook) => hook.command?.includes('xxn-lite-loop:guard-command'))?.command;
      assert.ok(command, JSON.stringify(data));
      const result = execute('/bin/sh', ['-c', command], { cwd: ACTIVE, input: JSON.stringify({ tool_input: { command: 'git push origin main' }, cwd: ACTIVE }) });
      if (target === 'antigravity') assertAntigravity(result, 'deny');
      else assertBlocked(result);
    });
    check(`${target} repeated install is byte-for-byte idempotent`, () => {
      const before = fs.readFileSync(file, 'utf8');
      const result = cli(INSTALL, args);
      requireExit(result);
      assert.equal(requireJson(result).targets[0].changed, false, describe(result));
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });
    check(`${target} uninstall preserves complete original settings`, () => {
      const result = cli(INSTALL, [...args, '--uninstall']);
      requireExit(result);
      assert.deepEqual(readJson(file), initial);
    });
    check(`${target} invalid JSON is not overwritten`, () => {
      const bad = path.join(scope, 'invalid.json');
      const original = '{ "hooks": [broken';
      write(bad, original);
      const result = cli(INSTALL, ['--target', target, '--file', bad]);
      requireExit(result, 2);
      assert.equal(requireJson(result).code, 'INVALID_JSON', describe(result));
      assert.equal(fs.readFileSync(bad, 'utf8'), original);
      assert.equal(fs.existsSync(`${bad}.xxn-lite-loop.bak`), false);
    });
  }
  check('default installs all detected clients, including user-scope Antigravity', () => {
    for (const folder of ['.claude', '.codex', '.gemini/config']) fs.mkdirSync(path.join(HOME_DIR, folder), { recursive: true });
    const result = cli(INSTALL, ['--config-dir', CONFIG]);
    requireExit(result);
    assert.deepEqual(requireJson(result).targets.map((target) => target.target), ['claude', 'codex', 'antigravity']);
    const config = readJson(path.join(HOME_DIR, '.gemini', 'config', 'hooks.json'));
    assert.equal(config['xxn-lite-loop:guard-command'].PreToolUse[0].matcher, 'run_command');
  });
  check('a hook installed from an extracted package runs after extraction is removed', () => {
    const packageRoot = path.join(TMP, 'extract folder');
    const installed = path.join(TMP, "installed user's skill");
    write(path.join(packageRoot, 'install.sh'), fs.readFileSync(INSTALL_SH));
    fs.cpSync(path.join(ROOT, 'hooks'), path.join(packageRoot, 'hooks'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(packageRoot, 'scripts'), { recursive: true });
    const result = execute('/bin/bash', [path.join(packageRoot, 'install.sh'), '--target', installed, '--with-hooks', '--hook-target', 'antigravity']);
    requireExit(result);
    fs.rmSync(packageRoot, { recursive: true });
    const config = readJson(path.join(HOME_DIR, '.gemini', 'config', 'hooks.json'));
    const command = config['xxn-lite-loop:guard-command'].PreToolUse[0].hooks[0].command;
    const payload = { tool_name: 'run_command', tool_input: { CommandLine: 'git push origin main', Cwd: ACTIVE } };
    assertAntigravity(execute('/bin/sh', ['-c', command], { cwd: OUTSIDE, input: JSON.stringify(payload) }), 'deny');
  });

  group('6. hook installer argument validation');
  const argScope = path.join(TMP, 'hook-args');
  const argFile = path.join(argScope, 'settings.json');
  writeJson(argFile, initial);
  const argScopeBefore = snapshotTree(argScope);
  const homeBefore = snapshotTree(HOME_DIR);
  check('unknown flag --status exits 1 with a structured error and usage', () => {
    const result = cli(INSTALL, ['--target', 'claude', '--file', argFile, '--status']);
    requireExit(result, 1);
    const data = requireJson(result);
    assert.equal(data.ok, false, describe(result));
    assert.equal(data.code, 'UNKNOWN_ARG', describe(result));
    assert.match(data.message, /未知参数：--status/);
    assert.ok(Array.isArray(data.usage) && data.usage.length > 0, JSON.stringify(data));
    assert.ok(data.usage.some((line) => line.includes('install-hooks.mjs')), JSON.stringify(data.usage));
  });
  check('unknown flag never rewrites the target file or leaves a backup', () => {
    assert.deepEqual(snapshotTree(argScope), argScopeBefore);
  });
  check('unknown flag alone exits 1 without touching user-scope settings', () => {
    const result = cli(INSTALL, ['--status']);
    requireExit(result, 1);
    assert.equal(requireJson(result).code, 'UNKNOWN_ARG', describe(result));
  });
  check('unknown flag leaves every user-scope settings file byte-identical', () => {
    assert.deepEqual(snapshotTree(HOME_DIR), homeBefore);
  });
  for (const flag of ['--help', '-h']) check(`${flag} still prints usage and exits 0`, () => {
    const result = cli(INSTALL, [flag]);
    requireExit(result);
    const data = requireJson(result);
    assert.equal(data.ok, true, describe(result));
    assert.ok(data.usage.some((line) => line.includes('--uninstall')), JSON.stringify(data));
  });

  group('7. three-layer collaboration rules');
  const rulesConfig = path.join(TMP, 'rules-config');
  const rulesProject = {
    forge: 'github',
    hubRepo: { name: 'demo', repo: 'example/demo', path: ACTIVE, branch: 'feature_demo' },
    verification: { commands: {}, skipReason: 'fixture' },
  };
  function resolveRules(config, extra = []) {
    const result = loop(['config-resolve', '--project', 'demo', ...extra], config);
    requireExit(result);
    return requireJson(result);
  }
  writeJson(path.join(rulesConfig, 'me.json'), {
    user: 'fixture-user', rules: [' 提交前先对账 ', '提交前先对账', '有疑问先问再动手', '   '],
  });
  writeJson(path.join(rulesConfig, 'projects', 'demo.json'), { ...rulesProject, rules: ['跨仓改动先发升级串'] });
  check('three layers merge in personal, project, temp order after trim and dedupe', () => {
    const data = resolveRules(rulesConfig, ['--overrides', JSON.stringify({ rules: ['临时：今天只做只读对账'] })]);
    assert.deepEqual(data.rules.personal, ['提交前先对账', '有疑问先问再动手']);
    assert.deepEqual(data.rules.project, ['跨仓改动先发升级串']);
    assert.deepEqual(data.rules.temp, ['临时：今天只做只读对账']);
    assert.deepEqual(data.rules.effective, ['提交前先对账', '有疑问先问再动手', '跨仓改动先发升级串', '临时：今天只做只读对账']);
    assert.deepEqual(data.rules.blocked, []);
    assert.deepEqual(data.warnings, []);
  });
  const emptyRulesConfig = path.join(TMP, 'rules-empty');
  writeJson(path.join(emptyRulesConfig, 'me.json'), { user: 'fixture-user' });
  writeJson(path.join(emptyRulesConfig, 'projects', 'demo.json'), rulesProject);
  check('unconfigured rules stay empty arrays with zero warnings', () => {
    const data = resolveRules(emptyRulesConfig);
    assert.deepEqual(data.rules, { personal: [], project: [], temp: [], effective: [], blocked: [] });
    assert.deepEqual(data.warnings, []);
  });
  check('a single string rule becomes one item with a reminder', () => {
    const data = resolveRules(rulesConfig, ['--overrides', JSON.stringify({ rules: '单条规矩也要收' })]);
    assert.deepEqual(data.rules.temp, ['单条规矩也要收']);
    assert.equal(data.warnings.filter((item) => /单条字符串/.test(item)).length, 1, JSON.stringify(data.warnings));
  });
  const crowdedConfig = path.join(TMP, 'rules-crowded');
  const longRule = '这一条故意写得很长'.repeat(9);
  const sixShort = ['规矩一', '规矩二', '规矩三', '规矩四', '规矩五', '规矩六'];
  writeJson(path.join(crowdedConfig, 'me.json'), { user: 'fixture-user', rules: [...sixShort, longRule] });
  writeJson(path.join(crowdedConfig, 'projects', 'demo.json'), {
    ...rulesProject, rules: ['工程一', '工程二', '工程三', '工程四', '工程五', '工程六'],
  });
  check('per-layer cap, 80-character hint and total cap warn without truncating', () => {
    const data = resolveRules(crowdedConfig);
    const text = data.warnings.join('\n');
    assert.match(text, /「me\.yaml」配了 7 条，超过每层 5 条上限/);
    assert.match(text, /「工程组档案」配了 6 条，超过每层 5 条上限/);
    assert.match(text, new RegExp(`有 ${longRule.length} 字，超过单条 80 字建议`));
    assert.match(text, /三层合计生效 13 条，超过 10 条上限/);
    assert.equal(data.rules.personal.length, 7, JSON.stringify(data.rules.personal));
    assert.equal(data.rules.project.length, 6);
    assert.equal(data.rules.effective.length, 13);
    for (const rule of [...sixShort, longRule, '工程一', '工程六']) assert.ok(data.rules.effective.includes(rule), rule);
  });
  check('coding-style words get a scope reminder instead of being dropped', () => {
    const data = resolveRules(rulesConfig, ['--overrides', JSON.stringify({ rules: ['变量一律用驼峰命名', '提交前跑一遍 ESLint'] })]);
    const hits = data.warnings.filter((item) => /AGENTS\.md/.test(item));
    assert.equal(hits.length, 2, JSON.stringify(data.warnings));
    assert.match(hits[0], /编码规范建议放到仓库 AGENTS\.md，Loop rules 只收协作与风控规矩/);
    assert.deepEqual(data.rules.temp, ['变量一律用驼峰命名', '提交前跑一遍 ESLint']);
  });
  const gateConfig = path.join(TMP, 'rules-gate');
  writeJson(path.join(gateConfig, 'me.json'), {
    user: 'fixture-user',
    rules: ['免终审直接合', '调低风险判定', '提交前本人先看', '不得跳过终审，契约变更必须走升级串'],
  });
  writeJson(path.join(gateConfig, 'projects', 'demo.json'), rulesProject);
  check('L3 personal rules that bypass public gates are blocked and leave effective', () => {
    const data = resolveRules(gateConfig, ['--tier', 'L3']);
    assert.deepEqual(data.rules.blocked.map((item) => item.rule), ['免终审直接合', '调低风险判定']);
    assert.deepEqual(data.rules.blocked.map((item) => item.code), ['BYPASS_FINAL_REVIEW', 'DOWNGRADE_RISK']);
    assert.equal(data.rules.personal.length, 4, JSON.stringify(data.rules.personal));
    assert.deepEqual(data.rules.effective, ['提交前本人先看', '不得跳过终审，契约变更必须走升级串']);
    const text = data.warnings.join('\n');
    assert.match(text, /L3 个人规矩「免终审直接合」试图绕过公共门禁/);
    assert.match(text, /已拦下不生效/);
  });
  check('stricter personal rules still pass the L3 gate', () => {
    const data = resolveRules(gateConfig, ['--tier', 'L3']);
    assert.ok(data.rules.effective.includes('不得跳过终审，契约变更必须走升级串'));
    assert.ok(data.rules.effective.includes('提交前本人先看'));
  });
  check('the same personal rules are not blocked below L3', () => {
    const data = resolveRules(gateConfig, ['--tier', 'L2']);
    assert.deepEqual(data.rules.blocked, []);
    assert.equal(data.rules.effective.length, 4);
    assert.ok(!data.warnings.some((item) => /绕过公共门禁/.test(item)), JSON.stringify(data.warnings));
  });
  check('confirm sheet appends one compact rules line only when rules are effective', () => {
    const withRules = loop(['preview-init', '--req', 'rules-preview', '--project', 'demo', '--tier', 'L2',
      '--branch', 'loop/rules', '--overrides', JSON.stringify({ rules: ['临时：今天只做只读对账'] })], rulesConfig);
    requireExit(withRules);
    const sheet = requireJson(withRules).confirmSheet;
    assert.equal(sheet.length, 7, JSON.stringify(sheet));
    assert.equal(sheet[6], '协作规矩：生效 4 条（个人 2 / 工程 1 / 临时 1）');
    const without = loop(['preview-init', '--req', 'rules-preview', '--project', 'demo', '--tier', 'L2', '--branch', 'loop/rules'], emptyRulesConfig);
    requireExit(without);
    assert.equal(requireJson(without).confirmSheet.length, 6);
  });
  check('init persists rules through buildRunSpec', () => {
    const result = loop(['init', '--req', 'rules-run', '--project', 'demo', '--tier', 'L2',
      '--branch', 'feature_demo', '--session', 'rules-owner'], rulesConfig);
    requireExit(result);
    const data = requireJson(result);
    assert.deepEqual(data.run.rules.effective, ['提交前先对账', '有疑问先问再动手', '跨仓改动先发升级串']);
    assert.equal(data.confirmSheet.length, 7, JSON.stringify(data.confirmSheet));
  });
  check('L2 to L3 upgrade re-applies the public gate to persisted rules', () => {
    const created = loop(['init', '--req', 'gate-run', '--project', 'demo', '--tier', 'L2',
      '--branch', 'feature_demo', '--session', 'gate-owner'], gateConfig);
    requireExit(created);
    assert.equal(requireJson(created).run.rules.effective.length, 4, describe(created));
    const upgraded = loop(['upgrade', '--req', 'gate-run', '--to', 'L3'], gateConfig);
    requireExit(upgraded);
    const data = requireJson(upgraded);
    assert.equal(data.phase, 'planned', describe(upgraded));
    assert.deepEqual(data.nextRun.rules.blocked.map((item) => item.rule), ['免终审直接合', '调低风险判定']);
    assert.deepEqual(data.nextRun.rules.effective, ['提交前本人先看', '不得跳过终审，契约变更必须走升级串']);
  });
  check('doctor surfaces rules guardrail warnings on the config check', () => {
    const data = doctor(crowdedConfig, ['--project', 'demo']);
    const item = doctorCheck(data, 'config');
    assert.equal(item.status, 'WARN', JSON.stringify(data));
    assert.match(item.detail, /协作规矩：/);
    assert.match(item.fix, /每层 ≤5 条/);
    assert.equal(data.ok, true, JSON.stringify(data));
  });
  check('doctor keeps config PASS when rules are clean', () => {
    const data = doctor(rulesConfig, ['--project', 'demo']);
    const item = doctorCheck(data, 'config');
    assert.equal(item.status, 'PASS', JSON.stringify(data));
    assert.doesNotMatch(item.detail, /协作规矩/);
  });
  check('doctor surfaces blocked L3 personal rules', () => {
    const l3Config = path.join(TMP, 'rules-gate-l3');
    writeJson(path.join(l3Config, 'me.json'), { user: 'fixture-user', defaultTier: 'L3', rules: ['免终审直接合', '提交前本人先看'] });
    writeJson(path.join(l3Config, 'projects', 'demo.json'), rulesProject);
    const data = doctor(l3Config, ['--project', 'demo']);
    const item = doctorCheck(data, 'config');
    assert.equal(item.status, 'WARN', JSON.stringify(data));
    assert.match(item.detail, /L3 个人规矩已拦下 1 条/);
    assert.equal(data.ok, true, JSON.stringify(data));
  });

  group('8. public distribution checks');
  const distribution = path.join(TMP, '分发 root with spaces');
  const sync = path.join(distribution, 'scripts', 'sync-mirrors.mjs');
  const archive = path.join(TMP, 'starter.zip');
  const mirror = path.join(TMP, 'mirror');
  const runSync = (args, options) => cli(sync, args, options);
  write(sync, fs.readFileSync(SYNC));
  write(path.join(distribution, 'install.sh'), fs.readFileSync(INSTALL_SH));
  write(path.join(distribution, 'SKILL.md'), '# Synthetic distribution fixture\n');
  check('check, pack and mirror support paths with spaces and Chinese', () => {
    requireExit(runSync(['--check']));
    requireExit(runSync(['--mirror', mirror]));
    assert.ok(fs.existsSync(path.join(mirror, 'scripts', 'sync-mirrors.mjs')));
    requireExit(runSync(['--pack', archive]));
    const listing = execute('unzip', ['-Z1', archive]);
    requireExit(listing);
    assert.match(listing.stdout, /starter-pack\/一键安装\.sh|starter-pack\/install\.sh/);
    assert.match(listing.stdout, /starter-pack\/SKILL\.md/);
    assert.doesNotMatch(listing.stdout, /scripts\/sync-mirrors\.mjs/);
  });
  check('check scans the synchronizer itself while a pack excludes it', () => {
    const token = 'ghp_' + 'x'.repeat(27);
    const original = fs.readFileSync(sync, 'utf8');
    try {
      fs.appendFileSync(sync, `\n// ${token}\n`);
      const result = runSync(['--check']);
      requireExit(result, 2);
      assert.match(result.stderr, /access_token/);
      assert.doesNotMatch(result.stderr, new RegExp(token));
      requireExit(runSync(['--pack', archive]));
    } finally {
      write(sync, original);
    }
  });
  check('pack scans every included file, with an external private pattern passed by flag or env', () => {
    const list = path.join(TMP, 'private-patterns.txt');
    const marker = 'FixturePrivateWordForDistribution';
    const file = path.join(distribution, 'references', 'nested.md');
    write(list, `# private fixture\n\n^${marker}$\n`);
    write(file, marker);
    const originalArchive = sha256(archive);
    try {
      for (const [args, options] of [
        [['--extra-patterns-file', list], {}],
        [[], { env: { XXN_SECRET_PATTERNS_FILE: list } }],
      ]) {
        const result = runSync(['--pack', archive, ...args], options);
        requireExit(result, 2);
        assert.match(result.stderr, /extra_pattern_line_3/);
        assert.doesNotMatch(result.stderr, new RegExp(marker));
        assert.equal(sha256(archive), originalArchive);
      }
      for (const [name, value] of [
        ['feishu_user_id', 'ou_' + 'a'.repeat(24)],
        ['feishu_chat_id', 'oc_' + 'a'.repeat(27)],
        ['personal_abs_path', '/' + 'home' + '/fixture-user/project'],
        ['access_token', 'glpat-' + 'x'.repeat(20)],
      ]) {
        write(file, value);
        const result = runSync(['--pack', archive]);
        requireExit(result, 2);
        assert.ok(result.stderr.includes(name), describe(result));
        assert.ok(!result.stderr.includes(value), describe(result));
      }
    } finally {
      fs.rmSync(file);
    }
  });
  check('mirror rejects equal, parent, child and symlink alias before changing the source', () => {
    const alias = path.join(TMP, 'source-alias');
    fs.symlinkSync(distribution, alias);
    const child = path.join(distribution, 'missing-child');
    const before = snapshotTree(distribution);
    for (const target of [distribution, TMP, child, alias, path.join(alias, 'missing-child')]) {
      const result = runSync(['--mirror', target]);
      requireExit(result, 2);
      assert.match(result.stderr, /相同或互相嵌套/, describe(result));
      assert.deepEqual(snapshotTree(distribution), before);
    }
  });

  group('source stability');
  check('tested scripts did not change during the run', () => {
    const after = Object.fromEntries(SOURCE_FILES.map((file) => [path.relative(ROOT, file), sha256(file)]));
    assert.deepEqual(after, initialHashes);
  });
} catch (error) {
  if (!current) group('fixture setup');
  current.fail += 1;
  failures.push({ group: current.name, name: 'unexpected harness error', detail: error?.stack ?? String(error) });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

for (const item of groups) console.log(`${item.name}: PASS ${item.pass} / FAIL ${item.fail}`);
for (const failure of failures) console.log(`FAIL ${failure.group} :: ${failure.name}\n  ${failure.detail}`);
const passed = groups.reduce((sum, item) => sum + item.pass, 0);
const failed = groups.reduce((sum, item) => sum + item.fail, 0);
console.log(`TOTAL PASS ${passed} / FAIL ${failed}`);
console.log(`SOURCE SHA256 ${JSON.stringify(initialHashes)}`);
console.log(`Temporary tree removed: ${!fs.existsSync(TMP)}`);
process.exitCode = failed ? 1 : 0;
