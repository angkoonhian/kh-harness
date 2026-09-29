import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles, readIfPresent, existsAny } from './scan.mjs';

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-scan-'));
  writeFileSync(join(d, 'package.json'), '{}');
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'index.ts'), 'export const a = 1;');
  mkdirSync(join(d, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'left-pad', 'index.js'), '//');
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
