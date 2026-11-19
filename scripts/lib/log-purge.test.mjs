// scripts/lib/log-purge.test.mjs
//
// `log purge`. The plan and every refusal run through the command; the
// removal itself runs through the library with the terminal check's result
// passed in, since a child process of the suite has no terminal and the
// command then refuses. Every test runs against the temporary KH_DATA_DIR
// `log-fixtures.mjs` sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isEnabled, LOCAL_GATES_FILE, repoDataDir, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { LOG_USAGE } from './cli.mjs';
import { DATA_DIR_LOCKS, LOCKED } from './file-lock.mjs';
import { ledgerEntry, withLearningsLock } from './learn-lib.mjs';
import { appendLedger } from './ledger.mjs';
import { DATA_ROOT, project, runLog, snapshot, tempDir, writeSession } from './log-fixtures.mjs';
import { DataDirRefused } from './log-lib.mjs';
import { purgeLog, purgeTarget, PURGE_NEEDS_TERMINAL } from './log-purge.mjs';
import { requireInteractive } from './tty.mjs';

const AT_TERMINAL = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} });
const IN_CLAUDE_CODE = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CLAUDECODE: '1' } });

/** A repository with an enabled log holding a session and the files the
 * learning loop keeps beside it. */
function loggedProject() {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  const dir = repoDataDir(root);
  mkdirSync(join(dir, 'learnings'));
  writeFileSync(join(dir, 'learnings', 'L1.json'), '{}');
  writeFileSync(join(dir, 'ledger.jsonl'), '');
  writeFileSync(join(dir, 'policy.json'), '{}');
  writeFileSync(join(dir, LOCAL_GATES_FILE), '{"schema":1,"gates":[]}');
  return root;
}

test('purge without --yes removes nothing, needs no terminal, and says what removing the directory switches off', () => {
  const root = loggedProject();
  const before = snapshot(repoDataDir(root));
  const r = runLog(root, 'purge');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(repoDataDir(root)));
  assert.match(r.stdout, /sessions/);
  assert.match(r.stdout, /the learning ledger, every learning, the promotion policy and this machine's gate file/);
  assert.match(r.stdout, /switches off every gate promoted on this machine and every local suspension of a committed gate/);
  assert.match(r.stdout, /--yes/);
  assert.match(r.stdout, /needs an interactive terminal outside Claude Code/);
  assert.deepEqual(snapshot(repoDataDir(root)), before);
  assert.equal(isEnabled(root), true);
});

test('purge --yes run without a terminal is refused with exit 3 and removes nothing', () => {
  const root = loggedProject();
  const before = snapshot(repoDataDir(root));
  const r = runLog(root, 'purge', '--yes');
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stderr, /^kh-harness: purge --yes refused: standard input is not an interactive terminal; it needs an interactive terminal outside Claude Code, and nothing was removed\.$/m);
  assert.doesNotMatch(r.stderr, /a person/);
  assert.deepEqual(snapshot(repoDataDir(root)), before);
  assert.equal(isEnabled(root), true);
});

test('the library refuses too when the terminal check did not pass, whatever calls it', () => {
  const root = loggedProject();
  const before = snapshot(repoDataDir(root));
  for (const interactive of [IN_CLAUDE_CODE, undefined, { ok: 'yes' }]) {
    assert.deepEqual(purgeLog(root, purgeTarget(root), { interactive }), { removed: false, reason: PURGE_NEEDS_TERMINAL });
  }
  assert.match(PURGE_NEEDS_TERMINAL, /needs an interactive terminal outside Claude Code/);
  assert.deepEqual(snapshot(repoDataDir(root)), before);
});

test('at a terminal, purge removes the repository\'s data directory and nothing else', () => {
  const root = loggedProject();
  const other = project();
  setEnabled(other, true);
  writeSession(other, 's1');
  writeFileSync(join(DATA_ROOT, 'beside.txt'), 'kept');
  const otherBefore = snapshot(repoDataDir(other));
  assert.deepEqual(purgeLog(root, purgeTarget(root), { interactive: AT_TERMINAL }), { removed: true });
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
  assert.throws(() => purgeLog(root, { state: 'ok', dir: repoDataDir(root) }, { interactive: AT_TERMINAL }), DataDirRefused);
  assert.deepEqual(snapshot(elsewhere), { 'keep.txt': Buffer.from('kept').toString('base64') }, 'nothing is written through the link');
  assert.equal(existsSync(repoDataDir(root)), true);
});

test('a link inside the data directory is removed as a link and its target survives', () => {
  const root = loggedProject();
  const elsewhere = tempDir('hk-log-elsewhere-');
  writeFileSync(join(elsewhere, 'keep.txt'), 'kept');
  symlinkSync(elsewhere, join(repoDataDir(root), 'linked'), 'junction');
  assert.deepEqual(purgeLog(root, purgeTarget(root), { interactive: AT_TERMINAL }), { removed: true });
  assert.equal(existsSync(repoDataDir(root)), false);
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'kept');
});

/** A clock that passes the lock wait in two readings. */
const impatient = () => {
  let t = 0;
  return () => (t += 6000);
};
const heldBy = pid => JSON.stringify({ pid, token: 'held-by-a-test' });

test('the lock names purge takes are the ones the ledger and the learnings are written under', () => {
  const root = loggedProject();
  const dir = repoDataDir(root);
  assert.equal(withLearningsLock(root, () => existsSync(join(dir, DATA_DIR_LOCKS.learnings))), true);
  writeFileSync(join(dir, DATA_DIR_LOCKS.ledger), heldBy(process.pid));
  const learning = { id: 'L1', sha256: 'a'.repeat(64), evidence: { signature: 'f'.repeat(16), sessions: 2, firstTs: '2026-11-01T10:00:00.000Z', lastTs: '2026-11-02T10:00:00.000Z', external: false } };
  const entry = ledgerEntry(learning, { base: 'b'.repeat(64), learned: 'l'.repeat(64) }, { kind: 'promoted', approvedBy: 'owner', action: 'warn' });
  assert.throws(() => appendLedger(root, entry, { now: impatient() }), { code: LOCKED });
});

test('purge waits for each of the data directory\'s locks, and removes nothing while another process holds one', () => {
  for (const lock of [DATA_DIR_LOCKS.learnings, DATA_DIR_LOCKS.ledger, 'index.jsonl.lock']) {
    const root = loggedProject();
    writeFileSync(join(repoDataDir(root), lock), heldBy(process.pid));
    const before = snapshot(repoDataDir(root));
    const result = purgeLog(root, purgeTarget(root), { interactive: AT_TERMINAL, now: impatient() });
    assert.equal(result.removed, false, lock);
    assert.match(result.reason, /another process holds the (learnings|ledger|index) lock; nothing was removed/, lock);
    assert.deepEqual(snapshot(repoDataDir(root)), before, lock);
    assert.equal(isEnabled(root), true, 'the log is not even disabled');
  }
});

test('an event a hook wrote just after the removal is removed too', () => {
  const root = loggedProject();
  const late = join(repoDataDir(root), 'sessions', 's-late.jsonl');
  let pauses = 0;
  const pause = () => {
    // As a hook that read the log as enabled before the purge began.
    if (pauses++ === 0) {
      mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
      writeFileSync(late, '{"type":"Stop"}\n');
    }
  };
  assert.deepEqual(purgeLog(root, purgeTarget(root), { interactive: AT_TERMINAL, pause }), { removed: true });
  assert.ok(pauses >= 2, 'it looks again after removing what reappeared');
  assert.equal(existsSync(repoDataDir(root)), false);
});

test('the usage text says everything purge removes and that --yes needs a terminal', () => {
  const usage = LOG_USAGE.replace(/\s+/g, ' ');
  assert.match(usage, /the learning ledger, every learning, the promotion policy and this machine's gate file/);
  assert.match(usage, /switches off every gate promoted on this machine and every local suspension of a committed gate/);
  assert.match(usage, /--yes needs an interactive terminal outside Claude Code; anywhere else it refuses \(3\) and removes nothing/);
  assert.doesNotMatch(usage, /and nothing else, which also disables the log/);
});
