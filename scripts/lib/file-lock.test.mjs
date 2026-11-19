// scripts/lib/file-lock.test.mjs
//
// The lock's breaking and waiting rules are exercised through the ledger in
// ledger.test.mjs; these pin what a caller of the helper relies on itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { LOCK_LOST, LOCKED, withFileLock } from './file-lock.mjs';

const made = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-file-lock-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A clock that moves a second on every reading. */
const steppingClock = () => {
  let t = 0;
  return () => (t += 1000);
};

test('a lock held by a live writer for the whole wait throws with code LOCKED', () => {
  const lockPath = join(tempDir(), 'x.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'another-writer' }));
  let ran = false;
  assert.throws(() => withFileLock(lockPath, { name: 'thing', now: steppingClock() }, () => { ran = true; }),
    error => error.code === LOCKED && /^thing is locked: /.test(error.message));
  assert.equal(ran, false);
  assert.equal(readFileSync(lockPath, 'utf8'), JSON.stringify({ pid: process.pid, token: 'another-writer' }));
});

test('a lock taken away throws with code LOCK_LOST at the next check', () => {
  const lockPath = join(tempDir(), 'x.lock');
  assert.throws(() => withFileLock(lockPath, { name: 'thing' }, assertHeld => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'another-writer' }));
    assertHeld();
  }), error => error.code === LOCK_LOST && /^thing lock lost: /.test(error.message));
  assert.ok(existsSync(lockPath), 'the other writer\'s lock is left in place');
});

test('the lock is released when the step throws, and the result is returned otherwise', () => {
  const lockPath = join(tempDir(), 'x.lock');
  assert.throws(() => withFileLock(lockPath, { name: 'thing' }, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lockPath), false);
  assert.equal(withFileLock(lockPath, { name: 'thing' }, () => 42), 42);
  assert.equal(existsSync(lockPath), false);
});

test('an atomic write replaces the file whole and leaves no temporary file', () => {
  const dir = tempDir();
  const path = join(dir, 'f.json');
  writeFileAtomic(path, 'one\n');
  writeFileAtomic(path, 'two\n');
  assert.equal(readFileSync(path, 'utf8'), 'two\n');
  assert.deepEqual(readdirSync(dir), ['f.json']);
});

test('an atomic write that cannot rename throws and leaves the target and directory as they were', () => {
  const dir = tempDir();
  const target = join(dir, 'f.json');
  mkdirSync(join(target, 'inside'), { recursive: true });
  assert.throws(() => writeFileAtomic(target, 'text'));
  assert.deepEqual(readdirSync(dir), ['f.json']);
  assert.deepEqual(readdirSync(target), ['inside']);
});
