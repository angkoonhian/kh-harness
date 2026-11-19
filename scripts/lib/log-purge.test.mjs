// scripts/lib/log-purge.test.mjs
//
// `log purge`, through the command. Every test runs against the temporary
// KH_DATA_DIR `log-fixtures.mjs` sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isEnabled, repoDataDir, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { DATA_ROOT, project, runLog, snapshot, tempDir, writeSession } from './log-fixtures.mjs';

test('purge without --yes removes nothing', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  const before = snapshot(repoDataDir(root));
  const r = runLog(root, 'purge');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(repoDataDir(root)));
  assert.match(r.stdout, /sessions/);
  assert.match(r.stdout, /--yes/);
  assert.deepEqual(snapshot(repoDataDir(root)), before);
  assert.equal(isEnabled(root), true);
});

test('purge --yes removes the repository\'s data directory and nothing else', () => {
  const root = project();
  const other = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  setEnabled(other, true);
  writeSession(other, 's1');
  writeFileSync(join(DATA_ROOT, 'beside.txt'), 'kept');
  const otherBefore = snapshot(repoDataDir(other));
  const r = runLog(root, 'purge', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(repoDataDir(root)), false);
  assert.equal(isEnabled(root), false);
  assert.equal(existsSync(DATA_ROOT), true);
  assert.equal(readFileSync(join(DATA_ROOT, 'beside.txt'), 'utf8'), 'kept');
  assert.deepEqual(snapshot(repoDataDir(other)), otherBefore);
  assert.equal(existsSync(root), true, 'the repository itself is untouched');
});

test('purge --yes with no log has nothing to remove', () => {
  const root = project();
  const r = runLog(root, 'purge', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to purge/i);
  assert.equal(existsSync(repoDataDir(root)), false);
});

test('purge refuses a data directory that is a link, and leaves its target', () => {
  const root = project();
  const elsewhere = tempDir('hk-log-elsewhere-');
  writeFileSync(join(elsewhere, 'keep.txt'), 'kept');
  mkdirSync(DATA_ROOT, { recursive: true });
  symlinkSync(elsewhere, repoDataDir(root), 'junction');
  assert.equal(lstatSync(repoDataDir(root)).isSymbolicLink(), true);
  for (const args of [['purge'], ['purge', '--yes']]) {
    const r = runLog(root, ...args);
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stderr, /link/);
  }
  assert.deepEqual(snapshot(elsewhere), { 'keep.txt': Buffer.from('kept').toString('base64') }, 'nothing is written through the link');
  assert.equal(existsSync(repoDataDir(root)), true);
});

test('a link inside the data directory is removed as a link and its target survives', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  const elsewhere = tempDir('hk-log-elsewhere-');
  writeFileSync(join(elsewhere, 'keep.txt'), 'kept');
  symlinkSync(elsewhere, join(repoDataDir(root), 'linked'), 'junction');
  const r = runLog(root, 'purge', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(repoDataDir(root)), false);
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'kept');
});
