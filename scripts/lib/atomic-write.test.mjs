// scripts/lib/atomic-write.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('a link at the path is replaced by the file, and what it pointed at is not written', t => {
  const dir = tempDir();
  const elsewhere = join(dir, 'elsewhere.json');
  const path = join(dir, 'record.json');
  writeFileSync(elsewhere, 'theirs\n');
  try {
    symlinkSync(elsewhere, path, 'file');
  } catch (error) {
    t.skip(`this account cannot create a file link (${error.code})`);
    return;
  }
  writeFileAtomic(path, 'new\n');
  assert.equal(lstatSync(path).isSymbolicLink(), false);
  assert.equal(readFileSync(path, 'utf8'), 'new\n');
  assert.equal(readFileSync(elsewhere, 'utf8'), 'theirs\n');
});
