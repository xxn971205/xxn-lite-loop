#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const SYNC_SRC = path.join(REPO_ROOT, 'scripts', 'sync-mirrors.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xxn-v22-u3-'));
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}\n${err?.stack ?? err}`);
  }
}

function makeFixtureRoot() {
  const dir = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.copyFileSync(SYNC_SRC, path.join(dir, 'scripts', 'sync-mirrors.mjs'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Fixture Skill\n', 'utf8');
  return dir;
}

function runCheck(rootDir) {
  return spawnSync(process.execPath, [path.join(rootDir, 'scripts', 'sync-mirrors.mjs'), '--check'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

try {
  test('rejects enterprise tenant feishu.cn domains while allowing open.feishu.cn and www.feishu.cn', () => {
    const dir = makeFixtureRoot();
    const doc = path.join(dir, 'references', 'doc.md');
    const allowedUrls = [
      `https://${['open', 'feishu', 'cn'].join('.')}/document/server-docs`,
      `https://${['www', 'feishu', 'cn'].join('.')}/hc/zh-cn`,
      `https://${['feishu', 'cn'].join('.')}`,
    ].join('\n');
    fs.writeFileSync(doc, allowedUrls, 'utf8');
    const okRes = runCheck(dir);
    assert.equal(okRes.status, 0, `expected exit 0 for allowed domains, got ${okRes.status}: ${okRes.stderr}`);

    for (const subdomain of ['acme-corp', 'open-corp', 'sub.acme']) {
      const tenantHost = [subdomain, 'feishu', 'cn'].join('.');
      fs.writeFileSync(doc, `https://${tenantHost}/docx/abc\n`, 'utf8');
      const badRes = runCheck(dir);
      assert.equal(badRes.status, 2, `expected exit 2 for ${tenantHost}, got ${badRes.status}`);
      assert.match(badRes.stderr, /feishu_tenant_domain/, badRes.stderr);
    }
  });

  test('skips .audit and flags private words passed through XXN_SECRET_PATTERNS_FILE', () => {
    const dir = makeFixtureRoot();
    const word = ['Fixture', 'Company', 'Keyword'].join('');
    const patterns = path.join(TMP, `patterns-${path.basename(dir)}.txt`);
    fs.writeFileSync(patterns, `# private words\n${word}\n`, 'utf8');
    fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit', 'notes.md'), `${word} https://${['acme', 'feishu', 'cn'].join('.')}\n`, 'utf8');
    const env = { ...process.env, XXN_SECRET_PATTERNS_FILE: patterns };
    const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts', 'sync-mirrors.mjs'), '--check'], { cwd: dir, encoding: 'utf8', env });

    const clean = run();
    assert.equal(clean.status, 0, `expected exit 0 when only .audit holds words: ${clean.stderr}`);

    fs.writeFileSync(path.join(dir, 'references', 'leak.md'), `contains ${word.toLowerCase()} here\n`, 'utf8');
    const hit = run();
    assert.equal(hit.status, 2, `expected exit 2 when a private word leaks, got ${hit.status}`);
    assert.match(hit.stderr, /extra_pattern_line_2/, hit.stderr);
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`TOTAL PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed ? 1 : 0;
