// scripts/lib/log-maintain.test.mjs
//
// `log maintain`, through the command. Every test runs against the
// temporary KH_DATA_DIR `log-fixtures.mjs` sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { repoDataDir, setEnabled, storeBlob } from '../../assets/scripts/harness-log.mjs';
import { SEAL_IDLE_MS } from '../../assets/scripts/harness-seal.mjs';
import {
  CANARY, DATA_ROOT, DAY_MS, MINUTE_MS, project, runLog, sealAll, sealedFile, sessionFile, snapshot, statusJson, tempDir, touchAgo, writeSession,
} from './log-fixtures.mjs';

test('maintain refuses a data directory that is a link, and writes nothing through it', () => {
  const root = project();
  const elsewhere = tempDir('hk-log-elsewhere-');
  mkdirSync(join(elsewhere, 'sessions'));
  writeFileSync(join(elsewhere, 'enabled.json'), JSON.stringify({ enabled: true }));
  writeFileSync(join(elsewhere, 'sessions', 's-foreign.jsonl'), '{"type":"Stop"}\n');
  touchAgo(join(elsewhere, 'sessions', 's-foreign.jsonl'), SEAL_IDLE_MS + MINUTE_MS);
  mkdirSync(DATA_ROOT, { recursive: true });
  symlinkSync(elsewhere, repoDataDir(root), 'junction');
  const before = snapshot(elsewhere);
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stderr, /link/);
  assert.deepEqual(snapshot(elsewhere), before);
});

test('maintain seals and sweeps what the hook would, and says what it did', () => {
  const root = project();
  setEnabled(root, true);
  writeFileSync(join(repoDataDir(root), 'config.json'), JSON.stringify({ contentRetentionDays: 1 }));
  writeSession(root, 'old');
  touchAgo(sessionFile(root, 'old'), SEAL_IDLE_MS + MINUTE_MS);
  writeSession(root, 'live');
  const blob = storeBlob(root, 'unreferenced');
  touchAgo(join(repoDataDir(root), 'blobs', `${blob.sha256}.gz`), 2 * DAY_MS);
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sessions sealed: 1/);
  assert.match(r.stdout, /blobs removed: 1/);
  assert.match(r.stdout, /content expired: 0/, 'the events are newer than the period');
  assert.doesNotMatch(r.stdout, /sealing did not run/);
  assert.equal(existsSync(sealedFile(root, 'old')), true);
  assert.equal(existsSync(sessionFile(root, 'live')), true, 'a session written in the last ten minutes is left');
  assert.equal(existsSync(join(repoDataDir(root), 'blobs', `${blob.sha256}.gz`)), false);
});

test('maintain expires content older than the retention period', () => {
  const root = project();
  setEnabled(root, true);
  const old = new Date(Date.now() - 100 * DAY_MS).toISOString();
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  writeFileSync(sessionFile(root, 'aged'), `${JSON.stringify({ schema: 1, ts: old, pid: 1, type: 'UserPromptSubmit', prompt: CANARY })}\n`);
  touchAgo(sessionFile(root, 'aged'), SEAL_IDLE_MS + MINUTE_MS);
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sessions sealed: 1/);
  assert.match(r.stdout, /content expired: 1 sessions/);
  assert.equal(r.stdout.includes(CANARY), false);
  assert.equal(statusJson(root).index.intact, true);
});

test('maintain says why the blob sweep was skipped', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 'edited');
  sealAll(root);
  writeFileSync(sealedFile(root, 'edited'), gzipSync(Buffer.from('{"type":"Stop"}\n')));
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 2, 'a step that could not run is not a clean exit');
  assert.match(r.stdout, /blob sweep skipped: sealed sessions do not match the index \(altered: edited\)/);
});

test('maintain says when sealing did not run because another process holds the lock', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 'waiting');
  touchAgo(sessionFile(root, 'waiting'), SEAL_IDLE_MS + MINUTE_MS);
  // Owned by this test process, which is alive, and fresh: not breakable.
  writeFileSync(join(repoDataDir(root), 'index.jsonl.lock'), JSON.stringify({ pid: process.pid, token: 'held' }));
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /sealing did not run: the index lock could not be taken/);
  assert.match(r.stdout, /sessions sealed: 0/);
  assert.match(r.stdout, /content was not expired, because retention did not run: the index lock could not be taken/);
  assert.doesNotMatch(r.stdout, /content expired: 0 sessions/, 'a step that did not run expired nothing it can count');
});

test('maintain says when sealing did not run because the index could not be read', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 'waiting');
  touchAgo(sessionFile(root, 'waiting'), SEAL_IDLE_MS + MINUTE_MS);
  mkdirSync(join(repoDataDir(root), 'index.jsonl'));
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /sealing did not run: the index could not be read/);
  assert.match(r.stdout, /blob sweep skipped: the index could not be read/);
});

test('maintain seals and expires on a disabled log, so what was recorded does not outlive its period', () => {
  const root = project();
  const old = new Date(Date.now() - 100 * DAY_MS).toISOString();
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  writeFileSync(sessionFile(root, 'aged'), `${JSON.stringify({ schema: 1, ts: old, pid: 1, type: 'UserPromptSubmit', prompt: CANARY })}\n`);
  touchAgo(sessionFile(root, 'aged'), SEAL_IDLE_MS + MINUTE_MS);
  assert.equal(statusJson(root).enabled, false);
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sessions sealed: 1/);
  assert.match(r.stdout, /content expired: 1 sessions/);
  assert.equal(statusJson(root).contentPastRetention.sessions, 0);
  assert.equal(statusJson(root).enabled, false, 'maintaining does not turn the log on');
});

test('maintain with no log on this machine says so and writes nothing', () => {
  const root = project();
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No log for this repository on this machine; nothing to maintain/);
  assert.equal(existsSync(repoDataDir(root)), false);
});
