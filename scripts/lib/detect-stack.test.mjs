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
