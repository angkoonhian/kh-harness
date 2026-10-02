import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles } from './scan.mjs';
import { detectStack } from './detect-stack.mjs';

function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function repo() { return mkdtempSync(join(tmpdir(), 'hk-stack-')); }
function run(d) { return detectStack(d, listFiles(d).files); }

test('single npm package with scripts', () => {
  const d = repo();
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest', build: 'tsc' } }));
  write(d, 'package-lock.json', '{}');
  const s = run(d);
  assert.equal(s.packageManager, 'npm');
  assert.equal(s.isWorkspace, false);
  assert.equal(s.packages.length, 1);
  assert.equal(s.packages[0].name, 'app');
  // Script NAMES are recorded; bodies are deliberately not carried through.
  assert.deepEqual(s.packages[0].scripts, ['build', 'test']);
});

test('pnpm workspace finds member packages', () => {
  const d = repo();
  write(d, 'package.json', JSON.stringify({ name: 'root', private: true }));
  write(d, 'pnpm-lock.yaml', '');
  write(d, 'pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  write(d, 'packages/api/package.json', JSON.stringify({ name: '@x/api', scripts: { test: 'jest' } }));
  write(d, 'packages/web/package.json', JSON.stringify({ name: '@x/web', scripts: {} }));
  const s = run(d);
  assert.equal(s.packageManager, 'pnpm');
  assert.equal(s.isWorkspace, true);
  const names = s.packages.map(p => p.name).sort();
  assert.deepEqual(names, ['@x/api', '@x/web', 'root']);
});

// Coordinator finding (Major): Bun has written the TEXT `bun.lock` by
// default since 1.2 — verified against Bun 1.4.2 — while `bun.lockb`
// (binary) is the legacy format from 1.1 and earlier. Detection keyed to
// `bun.lockb` alone missed every current-Bun repository entirely.
test('bun via bun.lock (the default lockfile name since Bun 1.2)', () => {
  const d = repo();
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'node test.js' } }));
  write(d, 'bun.lock', '{\n  "lockfileVersion": 1,\n}\n');
  const s = run(d);
  assert.equal(s.packageManager, 'bun');
});

test('bun via the legacy bun.lockb binary lockfile', () => {
  const d = repo();
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'node test.js' } }));
  write(d, 'bun.lockb', '');
  const s = run(d);
  assert.equal(s.packageManager, 'bun');
});

test('npm workspaces array is recognised', () => {
  const d = repo();
  write(d, 'package.json', JSON.stringify({ name: 'root', workspaces: ['apps/*'] }));
  write(d, 'package-lock.json', '{}');
  write(d, 'apps/one/package.json', JSON.stringify({ name: 'one' }));
  const s = run(d);
  assert.equal(s.isWorkspace, true);
  assert.equal(s.packages.length, 2);
});

test('python via pyproject and uv lock', () => {
  const d = repo();
  write(d, 'pyproject.toml', '[project]\nname = "svc"\n');
  write(d, 'uv.lock', '');
  const s = run(d);
  assert.ok(s.languages.includes('python'));
  assert.equal(s.packageManager, 'uv');
});

// A pip-only repository (requirements.txt, no pyproject.toml) must still get
// a package entry — otherwise `stack.packages.length` stays 0, python's own
// `confidence()` returns 0 (it requires packages.length > 0), profile
// selection falls back to `generic`, and every phase-1/2 python-specific
// check (P1.bootstrap included) reports `n/a` even though the install
// command (`pip install -r requirements.txt`) is plainly derivable from
// requirements.txt's own presence. This was a real defect: a prior ruling's
// verbatim install-command list omitted pip, and this is the detection-level
// half of what made it invisible even once pip was added back.
test('python via requirements.txt alone (no pyproject.toml) still yields a package', () => {
  const d = repo();
  write(d, 'requirements.txt', 'requests==2.31.0\n');
  write(d, 'app.py', 'print("hi")\n');
  const s = run(d);
  assert.ok(s.languages.includes('python'));
  assert.equal(s.packageManager, 'pip');
  assert.equal(s.packages.length, 1, 'a pip-only repo must still get a package entry, or profile selection falls back to generic');
  assert.equal(s.packages[0].dir, '.');
});

test('typescript is detected from tsconfig', () => {
  const d = repo();
  write(d, 'package.json', '{}');
  write(d, 'tsconfig.json', '{}');
  const s = run(d);
  assert.ok(s.languages.includes('typescript'));
});

test('malformed package.json does not throw', () => {
  const d = repo();
  write(d, 'package.json', '{ this is not json');
  assert.doesNotThrow(() => run(d));
});

test('CI configs are collected', () => {
  const d = repo();
  write(d, 'package.json', '{}');
  write(d, '.github/workflows/ci.yml', 'name: ci');
  const s = run(d);
  assert.deepEqual(s.ci, ['.github/workflows/ci.yml']);
});

test('double-star workspace pattern finds nested packages', () => {
  const d = repo();
  write(d, 'package.json', JSON.stringify({ name: 'root', workspaces: ['apps/**'] }));
  write(d, 'package-lock.json', '{}');
  write(d, 'apps/group/one/package.json', JSON.stringify({ name: 'nested' }));
  const s = run(d);
  assert.equal(s.isWorkspace, true);
  assert.ok(s.packages.some(p => p.name === 'nested'));
});

test('single-star workspace pattern does not find nested packages', () => {
  const d = repo();
  write(d, 'package.json', JSON.stringify({ name: 'root', workspaces: ['apps/*'] }));
  write(d, 'package-lock.json', '{}');
  write(d, 'apps/group/one/package.json', JSON.stringify({ name: 'nested' }));
  const s = run(d);
  assert.equal(s.packages.length, 1);
  assert.ok(!s.packages.some(p => p.name === 'nested'));
});
