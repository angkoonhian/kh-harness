// scripts/lib/atomic-write.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';

const made = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-atomic-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

test('the file is replaced whole and no temporary file is left', () => {
  const dir = tempDir();
  const path = join(dir, 'record.json');
  writeFileSync(path, 'old');
  writeFileAtomic(path, 'new\n');
  assert.equal(readFileSync(path, 'utf8'), 'new\n');
  assert.deepEqual(readdirSync(dir), ['record.json']);
});

test('a failed write leaves the file as it was, removes its temporary file and throws', () => {
  const dir = tempDir();
  const path = join(dir, 'record.json');
  // A directory at the path cannot be renamed over by a file.
  mkdirSync(path);
  writeFileSync(join(path, 'inside.txt'), 'kept');
  assert.throws(() => writeFileAtomic(path, 'new\n'));
  assert.deepEqual(readdirSync(dir), ['record.json']);
  assert.equal(readFileSync(join(path, 'inside.txt'), 'utf8'), 'kept');
});

test('with clearStale, the temporary files a killed run left for this path are removed, and nothing else', () => {
  const dir = tempDir();
  const path = join(dir, 'record.json');
  const stale = ['record.json.4321.0a1b2c3d4e5f.tmp', 'record.json.7.ffffffffffff.tmp'];
  const others = ['record.json.bak', 'other.json.4321.0a1b2c3d4e5f.tmp', 'record.json.tmp', 'xrecord.json.1.0a1b2c3d4e5f.tmp'];
  for (const name of [...stale, ...others]) writeFileSync(join(dir, name), 'x');

  writeFileAtomic(path, 'kept\n');
  assert.deepEqual(readdirSync(dir).sort(), ['record.json', ...stale, ...others].sort(), 'by default a sibling may be another writer\'s, so none is touched');

  writeFileAtomic(path, 'new\n', { clearStale: true });
  assert.deepEqual(readdirSync(dir).sort(), ['record.json', ...others].sort());
  assert.equal(readFileSync(path, 'utf8'), 'new\n');
});
