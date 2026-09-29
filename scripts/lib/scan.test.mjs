import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listFiles, readIfPresent, existsAny } from './scan.mjs';

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-scan-'));
  writeFileSync(join(d, 'package.json'), '{}');
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'index.ts'), 'export const a = 1;');
  mkdirSync(join(d, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'left-pad', 'index.js'), '//');
  // Initialize as git repo for nested detection tests
  try {
    execFileSync('git', ['init', d], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  } catch {
    // If git init fails, continue anyway
  }
  return d;
}

test('lists repo files as posix-relative paths', () => {
  const { files } = listFiles(fixture());
  assert.ok(files.includes('package.json'));
  assert.ok(files.includes('src/index.ts'));
});

test('excludes node_modules', () => {
  const { files } = listFiles(fixture());
  assert.equal(files.some(f => f.startsWith('node_modules/')), false);
});

test('reports its source', () => {
  const { source } = listFiles(fixture());
  assert.ok(source === 'git' || source === 'walk');
});

test('readIfPresent returns null for a missing file', () => {
  assert.equal(readIfPresent(fixture(), 'nope.txt'), null);
});

test('readIfPresent returns contents for a present file', () => {
  assert.equal(readIfPresent(fixture(), 'package.json'), '{}');
});

test('existsAny returns the first hit, else null', () => {
  const d = fixture();
  assert.equal(existsAny(d, ['missing.txt', 'package.json']), 'package.json');
  assert.equal(existsAny(d, ['a', 'b']), null);
});

test('a fixture with a nested repository is reported as nested-repo', () => {
  const d = fixture();
  const nested = join(d, 'nested-repo');
  mkdirSync(nested);
  // Create a git repo inside
  try {
    execFileSync('git', ['init', nested], { stdio: 'ignore' });
  } catch {
    // git init may fail in test env; skip this test gracefully
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'nested-repo'));
});

test('a repository with no nesting returns empty nested array', () => {
  const { nested } = listFiles(fixture());
  assert.equal(Array.isArray(nested), true);
  assert.equal(nested.length, 0);
});

test('nested repository under fully-untracked parent is found (no tracked sibling)', () => {
  const d = fixture();
  const vendor = join(d, 'vendor');
  const toolA = join(vendor, 'toolA');
  mkdirSync(toolA, { recursive: true });
  // Create a git repo inside with no tracked sibling under vendor/
  try {
    execFileSync('git', ['init', toolA], { stdio: 'ignore' });
  } catch {
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'vendor/toolA'));
});

test('nested repository with tracked sibling under parent is found (regression)', () => {
  const d = fixture();
  const vendor = join(d, 'vendor');
  const toolA = join(vendor, 'toolA');
  mkdirSync(toolA, { recursive: true });
  // Add tracked sibling
  writeFileSync(join(vendor, 'NOTE.md'), '# Vendor');
  // Create a git repo inside
  try {
    execFileSync('git', ['init', toolA], { stdio: 'ignore' });
  } catch {
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'vendor/toolA'));
});

test('nested repository three levels down is found', () => {
  const d = fixture();
  const deep = join(d, 'a', 'b', 'c', 'repo');
  mkdirSync(deep, { recursive: true });
  try {
    execFileSync('git', ['init', deep], { stdio: 'ignore' });
  } catch {
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'a/b/c/repo'));
});

test('files array contains no trailing-slash entries when nested repositories are present', () => {
  const d = fixture();
  const nested = join(d, 'nested-repo');
  mkdirSync(nested);
  try {
    execFileSync('git', ['init', nested], { stdio: 'ignore' });
  } catch {
    return;
  }
  const { files } = listFiles(d);
  assert.equal(files.some(f => f.endsWith('/')), false);
});

test('gitignored directory containing a nested repository is reported', () => {
  const d = fixture();
  const ignored = join(d, 'backend-old');
  mkdirSync(ignored);
  writeFileSync(join(d, '.gitignore'), 'backend-old\n');
  try {
    execFileSync('git', ['init', ignored], { stdio: 'ignore' });
  } catch {
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'backend-old'));
});

test('nested repository inside a gitignored parent one level down is reported', () => {
  const d = fixture();
  const ignored = join(d, 'vendor');
  const nested = join(ignored, 'toolA');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(d, '.gitignore'), 'vendor\n');
  try {
    execFileSync('git', ['init', nested], { stdio: 'ignore' });
  } catch {
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'vendor/toolA'));
});

test('bare repository is reported and its plumbing files do not appear in files array', () => {
  const d = fixture();
  const bare = join(d, 'bare-repo');
  mkdirSync(bare);
  // Create bare repo structure: HEAD, objects, refs
  writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(bare, 'objects'));
  mkdirSync(join(bare, 'refs'));

  const { files, nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'bare-repo'));
  // Verify no bare-repo files leaked into files array
  assert.equal(files.some(f => f.startsWith('bare-repo/')), false);
});

