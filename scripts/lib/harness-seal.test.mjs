// scripts/lib/harness-seal.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { appendEvent, readEvents, repoDataDir, sessionFileName } from '../../assets/scripts/harness-log.mjs';
import {
  applyRetention, CLAIMED_SUFFIX, indexLineCount, SEAL_IDLE_MS, SEAL_TEMP_SUFFIX, sealClosedSessions, sessionsSealedSince, untrustedBecause, verifyIndex,
} from '../../assets/scripts/harness-seal.mjs';
import { FAILURE_EVENT, failureSignature } from './recurrence.mjs';

const HARNESS_SEAL_URL = new URL('../../assets/scripts/harness-seal.mjs', import.meta.url).href;

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-seal-data-');

const sessionFile = (root, sessionId) => join(repoDataDir(root), 'sessions', sessionFileName(sessionId));
const blobFile = (root, sha256) => join(repoDataDir(root), 'blobs', `${sha256}.gz`);
const sha256Of = text => createHash('sha256').update(text, 'utf8').digest('hex');

/** Puts a blob holding `text` in the blob store, named as the hook names
 * one, with no event referencing it; returns its hash. */
function orphanBlob(root, text) {
  mkdirSync(join(repoDataDir(root), 'blobs'), { recursive: true });
  writeFileSync(blobFile(root, sha256Of(text)), gzipSync(text));
  return sha256Of(text);
}

const writeConfig = (root, config) => {
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'config.json'), JSON.stringify(config));
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const dataFile = (root, name) => join(repoDataDir(root), name);
const indexLines = root => readFileSync(dataFile(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rawIndexLines = root => readFileSync(dataFile(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
const sealedFile = (root, sessionId) => `${sessionFile(root, sessionId)}.gz`;
const claimedFile = (root, sessionId) => `${sessionFile(root, sessionId)}${CLAIMED_SUFFIX}`;
const tempFile = (root, sessionId) => `${sessionFile(root, sessionId)}${SEAL_TEMP_SUFFIX}`;
const eventsOf = (root, sessionId) => readEvents(root, sessionId).events;
const sha256OfBytes = bytes => createHash('sha256').update(bytes).digest('hex');

/** A clock reading by which every file written so far has been idle past
 * the sealing threshold. */
const idleNow = () => Date.now() + SEAL_IDLE_MS + MINUTE_MS;

/** `sealClosedSessions` at `idleNow()` unless the test says otherwise.
 * That clock runs eleven minutes ahead, which also makes a lock taken now
 * look old enough to break, so a concurrent test must not use it. */
const seal = (root, options = {}) => sealClosedSessions(root, { now: idleNow(), ...options });

/** Sets a file's modification time to `msAgo` before the real clock. */
const touchAgo = (path, msAgo) => {
  const at = new Date(Date.now() - msAgo);
  utimesSync(path, at, at);
};

/** A session of `count` tool results, each with input and output. */
function writeSession(root, sessionId, count = 2) {
  for (let i = 0; i < count; i++) {
    const r = appendEvent(root, sessionId, { type: 'PostToolUse', tool: 'Bash', inputHash: `h${i}`, status: 'ok', input: { command: `c${i}` }, output: `o${i}` });
    assert.equal(r.written, true);
  }
}

const INTACT = { intact: true, brokenAt: null, sessionsMissing: [], sessionsAltered: [], sessionsPending: [], unreadable: false, tornTail: false };
const LOCKED = 'the index lock could not be taken';
const SWEPT = { skipped: false, reason: null };

test('the claimed and temporary file suffixes are exported for later readers', () => {
  assert.equal(`${sessionFileName('x')}${CLAIMED_SUFFIX}`, 's-x.jsonl.sealing');
  assert.equal(`${sessionFileName('x')}${SEAL_TEMP_SUFFIX}`, 's-x.jsonl.gz.tmp');
  assert.equal(SEAL_IDLE_MS, 10 * MINUTE_MS);
});

test('a closed session is compressed and indexed', () => {
  const root = tempDir('hk-log-seal-');
  writeSession(root, 'closed-1', 3);
  writeSession(root, 'current-1', 1);
  const plainBytes = readFileSync(sessionFile(root, 'closed-1'));
  const before = eventsOf(root, 'closed-1');

  assert.deepEqual(seal(root, { currentSessionId: 'current-1' }), { sealed: ['closed-1'], lockLost: false, notRun: null, stopped: null });

  assert.equal(existsSync(sessionFile(root, 'closed-1')), false);
  assert.deepEqual(gunzipSync(readFileSync(sealedFile(root, 'closed-1'))), plainBytes);
  assert.equal(existsSync(sessionFile(root, 'current-1')), true, 'the current session is not sealed');
  assert.equal(existsSync(sealedFile(root, 'current-1')), false);
  assert.deepEqual(eventsOf(root, 'closed-1'), before);
  const [line, ...rest] = indexLines(root);
  assert.deepEqual(rest, []);
  assert.deepEqual(line, {
    sessionId: 'closed-1',
    sha256: sha256OfBytes(plainBytes),
    events: 3,
    firstTs: before[0].ts,
    lastTs: before[2].ts,
    external: false,
    blobs: [],
    prev: null,
  });
  assert.deepEqual(verifyIndex(root), INTACT);
  assert.deepEqual(seal(root, { currentSessionId: 'current-1' }), { sealed: [], lockLost: false, notRun: null, stopped: null }, 'a sealed session is not sealed again');
  assert.equal(indexLines(root).length, 1);
});

test('a session written to two minutes ago is left unsealed', () => {
  const root = tempDir('hk-log-recent-');
  writeSession(root, 'recent');
  touchAgo(sessionFile(root, 'recent'), 2 * MINUTE_MS);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [], lockLost: false, notRun: null, stopped: null });
  assert.equal(existsSync(sessionFile(root, 'recent')), true);
  assert.equal(existsSync(dataFile(root, 'index.jsonl')), false);
});

test('the same session is sealed once it has been idle past the threshold', () => {
  const root = tempDir('hk-log-idle-');
  writeSession(root, 'idle');
  touchAgo(sessionFile(root, 'idle'), 2 * MINUTE_MS);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [], lockLost: false, notRun: null, stopped: null });
  touchAgo(sessionFile(root, 'idle'), SEAL_IDLE_MS + MINUTE_MS);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: ['idle'], lockLost: false, notRun: null, stopped: null });
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('each index line chains to the one before it', () => {
  const root = tempDir('hk-log-chain-');
  for (const id of ['a', 'b', 'c']) writeSession(root, id);
  seal(root);
  const raw = rawIndexLines(root);
  assert.equal(raw.length, 3);
  assert.equal(JSON.parse(raw[0]).prev, null);
  for (let i = 1; i < raw.length; i++) assert.equal(JSON.parse(raw[i]).prev, sha256Of(raw[i - 1]));
});

test('a session that fetched outside content is indexed as external', () => {
  const root = tempDir('hk-log-external-');
  writeSession(root, 'inside');
  writeSession(root, 'outside');
  appendEvent(root, 'outside', { type: 'external_content', tool: 'WebFetch' });
  seal(root);
  assert.deepEqual(Object.fromEntries(indexLines(root).map(l => [l.sessionId, l.external])), { inside: false, outside: true });
});

test('editing a sealed session is reported as altered', () => {
  const root = tempDir('hk-log-altered-');
  writeSession(root, 'kept');
  writeSession(root, 'edited');
  seal(root);
  const content = gunzipSync(readFileSync(sealedFile(root, 'edited'))).toString('utf8');
  writeFileSync(sealedFile(root, 'edited'), gzipSync(content.replace('"c0"', '"c9"')));
  assert.deepEqual(verifyIndex(root), { ...INTACT, intact: false, sessionsAltered: ['edited'] });

  rmSync(sealedFile(root, 'kept'));
  assert.deepEqual(verifyIndex(root).sessionsMissing, ['kept']);

  appendEvent(root, 'edited', { type: 'Stop' });
  assert.deepEqual(seal(root), { sealed: [], lockLost: false, notRun: null, stopped: null }, 'an altered session is not sealed over');
  assert.deepEqual(verifyIndex(root).sessionsAltered, ['edited']);
  assert.deepEqual(eventsOf(root, 'edited').map(e => e.type), ['PostToolUse', 'PostToolUse', 'Stop'], 'its unsealed events stay readable');
});

test('a sealed file with no index line is reported as altered', () => {
  const root = tempDir('hk-log-unindexed-');
  writeSession(root, 'planted');
  writeFileSync(sealedFile(root, 'planted'), gzipSync(readFileSync(sessionFile(root, 'planted'))));
  rmSync(sessionFile(root, 'planted'));
  assert.deepEqual(verifyIndex(root), { ...INTACT, intact: false, sessionsAltered: ['planted'] });
});

test('deleting an index line is reported as a break at that position', () => {
  const root = tempDir('hk-log-break-');
  for (const id of ['a', 'b', 'c', 'd']) writeSession(root, id);
  seal(root);
  const raw = rawIndexLines(root);
  writeFileSync(dataFile(root, 'index.jsonl'), [raw[0], raw[2], raw[3]].map(l => `${l}\n`).join(''));
  const result = verifyIndex(root);
  assert.equal(result.intact, false);
  assert.equal(result.brokenAt, 2);
  assert.deepEqual(result.sessionsAltered, ['b'], 'the session the deleted line named has no index line');

  writeFileSync(dataFile(root, 'index.jsonl'), raw.slice(1).map(l => `${l}\n`).join(''));
  assert.equal(verifyIndex(root).brokenAt, 1, 'a first line with a prev is a break at line 1');
});

test('an index line that does not parse is a break at that position and never throws', () => {
  const root = tempDir('hk-log-garbled-');
  for (const id of ['a', 'b', 'c']) writeSession(root, id);
  seal(root);
  const raw = rawIndexLines(root);
  for (const garbled of ['{"sessionId": trunc', '[]', JSON.stringify({ ...JSON.parse(raw[1]), extra: 1 })]) {
    writeFileSync(dataFile(root, 'index.jsonl'), [raw[0], garbled, raw[2]].map(l => `${l}\n`).join(''));
    assert.equal(verifyIndex(root).brokenAt, 2, garbled);
  }
  assert.deepEqual(verifyIndex(tempDir('hk-log-noindex-')), INTACT, 'no log at all is intact');
});

test('an index that exists but cannot be read is unreadable, not a broken chain, and nothing is sealed', () => {
  const root = tempDir('hk-log-unreadable-index-');
  writeSession(root, 'u-1');
  // A directory where the index belongs cannot be read as a file anywhere.
  mkdirSync(dataFile(root, 'index.jsonl'));
  const check = verifyIndex(root);
  assert.deepEqual(check, { ...INTACT, intact: false, unreadable: true });
  assert.equal(untrustedBecause(check), 'the index could not be read');
  assert.deepEqual(seal(root), { sealed: [], lockLost: false, notRun: 'the index could not be read', stopped: null });
  assert.equal(applyRetention(root).blobSweep.reason, 'the index could not be read');
  assert.equal(applyRetention(root).notRun, 'the index could not be read', 'retention says it did not run, not that it expired nothing');
});

test('a failed index append stops the run and says so', { skip: process.getuid?.() === 0 }, () => {
  const root = tempDir('hk-log-append-fails-');
  writeSession(root, 'first');
  seal(root);
  writeSession(root, 'second');
  writeConfig(root, { contentRetentionDays: 1 });
  chmodSync(dataFile(root, 'index.jsonl'), 0o444);
  try {
    assert.deepEqual(seal(root), { sealed: [], lockLost: false, notRun: null, stopped: 'an index append failed' });
    const retention = applyRetention(root, { now: Date.now() + 3 * DAY_MS });
    assert.equal(retention.stopped, 'an index append failed');
    assert.equal(retention.contentRemoved, 0);
  } finally {
    chmodSync(dataFile(root, 'index.jsonl'), 0o644);
  }
  assert.deepEqual(seal(root).sealed, ['second'], 'a later run seals the session from its claimed events');
  assert.equal(eventsOf(root, 'second').length, 2);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('two simultaneous sealers index each session once', async () => {
  const root = tempDir('hk-log-race-');
  const ids = Array.from({ length: 12 }, (_, i) => `race-${String(i).padStart(2, '0')}`);
  for (const id of ids) {
    writeSession(root, id, 5);
    touchAgo(sessionFile(root, id), SEAL_IDLE_MS + MINUTE_MS);
  }
  // The real clock, so the lock each sealer takes is as young as it is.
  const script = `
    import { sealClosedSessions } from ${JSON.stringify(HARNESS_SEAL_URL)};
    process.stdout.write(JSON.stringify(sealClosedSessions(process.argv[1], {}).sealed));`;
  const runs = Array.from({ length: 6 }, () => new Promise(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', chunk => { stdout += chunk; });
    p.stderr.on('data', chunk => { stderr += chunk; });
    p.on('error', error => resolve({ code: null, stdout, stderr: String(error) }));
    p.on('close', code => resolve({ code, stdout, stderr }));
  }));
  const results = await Promise.all(runs);
  assert.deepEqual(results.filter(r => r.code !== 0 || r.stderr !== ''), []);
  const sealedBy = [...results.flatMap(r => JSON.parse(r.stdout)), ...sealClosedSessions(root, {}).sealed];
  assert.deepEqual(sealedBy.sort(), ids, 'each session was sealed by exactly one sealer');
  assert.deepEqual(indexLines(root).map(l => l.sessionId).sort(), ids);
  assert.deepEqual(verifyIndex(root), INTACT);
  for (const id of ids) assert.equal(eventsOf(root, id).length, 5, id);
  assert.equal(existsSync(dataFile(root, 'index.jsonl.lock')), false, 'the lock is released');
});

/** A repository with one idle session and the index lock held by `owner`. */
function lockedRepo(prefix, owner) {
  const root = tempDir(prefix);
  writeSession(root, 'locked');
  touchAgo(sessionFile(root, 'locked'), SEAL_IDLE_MS + MINUTE_MS);
  const lock = dataFile(root, 'index.jsonl.lock');
  writeFileSync(lock, owner);
  return { root, lock };
}

test('a lock held by a live process means skip, and one whose owner has exited is broken', () => {
  const owner = JSON.stringify({ pid: 4242, token: 'other' });
  const { root, lock } = lockedRepo('hk-log-lock-', owner);
  const alive = pid => pid === 4242;
  assert.deepEqual(sealClosedSessions(root, { isAlive: alive }), { sealed: [], lockLost: false, notRun: LOCKED, stopped: null });
  const retention = applyRetention(root, { isAlive: alive });
  assert.deepEqual(retention, { contentRemoved: 0, contentUnverifiable: 0, blobSweep: { skipped: true, reason: 'the index lock could not be taken' }, lockLost: false, notRun: 'the index lock could not be taken', stopped: null });
  assert.equal(readFileSync(lock, 'utf8'), owner, 'only its owner releases a lock');

  assert.deepEqual(sealClosedSessions(root, { isAlive: () => false }), { sealed: ['locked'], lockLost: false, notRun: null, stopped: null });
  assert.equal(existsSync(lock), false);
});

test('a lock ten minutes old is broken whatever its owner', () => {
  const { root, lock } = lockedRepo('hk-log-lock-age-', JSON.stringify({ pid: 4242, token: 'stuck' }));
  const alive = () => true;
  assert.deepEqual(sealClosedSessions(root, { now: Date.now() + 9 * MINUTE_MS, isAlive: alive }), { sealed: [], lockLost: false, notRun: LOCKED, stopped: null });
  assert.deepEqual(sealClosedSessions(root, { now: Date.now() + 11 * MINUTE_MS, isAlive: alive }), { sealed: ['locked'], lockLost: false, notRun: null, stopped: null });
  assert.equal(existsSync(lock), false);
});

test('a lock with no owner is broken only once it is stale', () => {
  const { root } = lockedRepo('hk-log-ownerless-', '');
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [], lockLost: false, notRun: LOCKED, stopped: null });
  assert.deepEqual(sealClosedSessions(root, { now: Date.now() + MINUTE_MS }), { sealed: ['locked'], lockLost: false, notRun: null, stopped: null });
});

test('sealing stops when the budget is spent and resumes on the next run', () => {
  const root = tempDir('hk-log-budget-');
  const ids = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'];
  for (const id of ids) writeSession(root, id);
  let t = 0;
  const clock = () => (t += 10);
  const first = seal(root, { budgetMs: 25, clock }).sealed;
  assert.ok(first.length > 0 && first.length < ids.length, `sealed ${first.length} of ${ids.length}`);
  assert.deepEqual(seal(root, { budgetMs: 0 }), { sealed: [], lockLost: false, notRun: null, stopped: null }, 'no budget, no work');
  const second = seal(root).sealed;
  assert.deepEqual([...first, ...second], ids);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('an event that arrives after sealing is sealed on the next run and no event is read twice', () => {
  const root = tempDir('hk-log-late-');
  writeSession(root, 'late', 2);
  seal(root);
  appendEvent(root, 'late', { type: 'SessionEnd', reason: 'other' });
  assert.deepEqual(eventsOf(root, 'late').map(e => e.type), ['PostToolUse', 'PostToolUse', 'SessionEnd']);
  assert.deepEqual(verifyIndex(root), INTACT, 'events not yet sealed are not a break');

  assert.deepEqual(seal(root), { sealed: ['late'], lockLost: false, notRun: null, stopped: null });
  assert.equal(existsSync(sessionFile(root, 'late')), false);
  assert.deepEqual(eventsOf(root, 'late').map(e => e.type), ['PostToolUse', 'PostToolUse', 'SessionEnd']);
  assert.deepEqual(indexLines(root).map(l => [l.sessionId, l.events]), [['late', 2], ['late', 3]]);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('an event appended while its session is being sealed starts a new plain file', () => {
  const root = tempDir('hk-log-claim-');
  writeSession(root, 'busy', 2);
  // The state just after the plain file was claimed: a hook's append now
  // creates a new plain file rather than one the sealer is about to remove.
  renameSync(sessionFile(root, 'busy'), claimedFile(root, 'busy'));
  appendEvent(root, 'busy', { type: 'Stop' });
  assert.deepEqual(seal(root), { sealed: ['busy'], lockLost: false, notRun: null, stopped: null });
  assert.deepEqual(eventsOf(root, 'busy').map(e => e.type), ['PostToolUse', 'PostToolUse', 'Stop']);
  assert.deepEqual(seal(root), { sealed: ['busy'], lockLost: false, notRun: null, stopped: null });
  assert.deepEqual(eventsOf(root, 'busy').map(e => e.type), ['PostToolUse', 'PostToolUse', 'Stop']);
  assert.deepEqual(indexLines(root).map(l => l.events), [2, 3]);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('a crash between writing the compressed file and removing the plain one is recovered without duplicating events', () => {
  const root = tempDir('hk-log-crash-');
  writeSession(root, 'crash', 2);
  seal(root);
  const firstSeal = readFileSync(sealedFile(root, 'crash'));
  appendEvent(root, 'crash', { type: 'SessionEnd', reason: 'other' });
  const late = readFileSync(sessionFile(root, 'crash'));
  seal(root);
  // The state a crash leaves once the continuation's index line is appended:
  // the whole content is in the temporary file, the claimed events are still
  // on disk and the earlier sealed file is still in place.
  renameSync(sealedFile(root, 'crash'), tempFile(root, 'crash'));
  writeFileSync(sealedFile(root, 'crash'), firstSeal);
  writeFileSync(claimedFile(root, 'crash'), late);
  assert.deepEqual(eventsOf(root, 'crash').map(e => e.type), ['PostToolUse', 'PostToolUse'], 'no state shows an event twice');
  assert.deepEqual(verifyIndex(root), { ...INTACT, sessionsPending: ['crash'] });

  assert.deepEqual(seal(root), { sealed: [], lockLost: false, notRun: null, stopped: null }, 'the interrupted seal is finished, not repeated');
  assert.deepEqual(eventsOf(root, 'crash').map(e => e.type), ['PostToolUse', 'PostToolUse', 'SessionEnd']);
  assert.equal(existsSync(claimedFile(root, 'crash')), false);
  assert.equal(existsSync(tempFile(root, 'crash')), false);
  assert.equal(indexLines(root).length, 2);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('a crash before the index line was written leaves the session to be sealed again', () => {
  const root = tempDir('hk-log-crash-early-');
  writeSession(root, 'early', 2);
  renameSync(sessionFile(root, 'early'), claimedFile(root, 'early'));
  writeFileSync(tempFile(root, 'early'), gzipSync('half-written'));
  assert.deepEqual(seal(root), { sealed: ['early'], lockLost: false, notRun: null, stopped: null });
  assert.deepEqual(eventsOf(root, 'early').map(e => e.output), ['o0', 'o1']);
  assert.equal(existsSync(tempFile(root, 'early')), false);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('content older than the retention period is removed and structure kept', () => {
  const root = tempDir('hk-log-retention-');
  writeConfig(root, { contentRetentionDays: 7, inlineCapBytes: 1024 });
  appendEvent(root, 'old', { type: 'UserPromptSubmit', prompt: 'fix the parser' });
  appendEvent(root, 'old', { type: 'PostToolUse', tool: 'Bash', inputHash: 'h', status: 'ok', outputBytes: 4096, input: { command: 'cat big' }, output: 'y'.repeat(4096) });
  appendEvent(root, 'old', { type: 'Stop', stopHookActive: false });
  const [, withBlob] = eventsOf(root, 'old');
  assert.equal(withBlob.output.truncated, true);
  assert.equal(existsSync(blobFile(root, withBlob.output.blob)), true);
  seal(root);
  assert.deepEqual(indexLines(root)[0].blobs, [withBlob.output.blob]);

  assert.deepEqual(applyRetention(root, { now: Date.now() + 6 * DAY_MS }), { contentRemoved: 0, contentUnverifiable: 0, blobSweep: SWEPT, lockLost: false, notRun: null, stopped: null }, 'content inside the period is kept');
  assert.equal(eventsOf(root, 'old')[0].prompt, 'fix the parser');

  assert.deepEqual(applyRetention(root, { now: Date.now() + 8 * DAY_MS }), { contentRemoved: 1, contentUnverifiable: 0, blobSweep: SWEPT, lockLost: false, notRun: null, stopped: null });
  const [prompt, tool, stop] = eventsOf(root, 'old');
  assert.equal(Object.hasOwn(prompt, 'prompt'), false);
  assert.equal(Object.hasOwn(tool, 'input'), false);
  assert.equal(Object.hasOwn(tool, 'output'), false);
  assert.equal(prompt.contentExpired, true);
  assert.equal(tool.contentExpired, true);
  assert.deepEqual([prompt.type, tool.type, tool.tool, tool.inputHash, tool.status, tool.outputBytes], ['UserPromptSubmit', 'PostToolUse', 'Bash', 'h', 'ok', 4096]);
  assert.equal(tool.ts, withBlob.ts);
  assert.equal(Object.hasOwn(stop, 'contentExpired'), false, 'an event that held no content is unchanged');
  assert.equal(existsSync(blobFile(root, withBlob.output.blob)), false, 'a blob only expired content referenced is removed');
  assert.equal(applyRetention(root, { now: Date.now() + 9 * DAY_MS }).contentRemoved, 0, 'expired content is not expired again');
});

test('retention removes every free-text field the hook writes and keeps the rest', () => {
  const root = tempDir('hk-log-retention-text-');
  appendEvent(root, 'texts', { type: 'PostToolUseFailure', tool: 'Bash', status: 'error', firstErrorLine: 'Exit code 1', input: { command: 'x' }, output: 'Exit code 1' });
  appendEvent(root, 'texts', { type: 'PermissionDenied', tool: 'Bash', reason: 'the classifier refused it' });
  appendEvent(root, 'texts', { type: 'StopFailure', error: 'rate_limit', errorDetails: 'try again in 5 minutes' });
  appendEvent(root, 'texts', { type: 'SessionEnd', reason: 'other' });
  seal(root);
  assert.equal(applyRetention(root, { now: Date.now() + 91 * DAY_MS }).contentRemoved, 1);
  const [failure, denied, stopFailure, end] = eventsOf(root, 'texts');
  assert.deepEqual([failure.tool, failure.status, failure.firstErrorLine, failure.contentExpired], ['Bash', 'error', 'Exit code 1', true]);
  for (const f of ['input', 'output']) assert.equal(Object.hasOwn(failure, f), false, f);
  assert.deepEqual([denied.tool, Object.hasOwn(denied, 'reason')], ['Bash', false]);
  assert.deepEqual([Object.hasOwn(stopFailure, 'error'), Object.hasOwn(stopFailure, 'errorDetails')], [false, false]);
  assert.equal(end.reason, 'other', 'a session end reason is one of a fixed set, not free text');
});

test('an expired failure still yields the same failure signature', () => {
  const root = tempDir('hk-log-retention-signature-');
  const failure = {
    type: FAILURE_EVENT, tool: 'Bash', inputHash: 'a'.repeat(64), status: 'error', durationMs: 4187, outputBytes: 2048,
    firstErrorLine: "Error: Cannot find module 'express'", input: { command: 'npm start' }, output: 'x'.repeat(2048),
  };
  appendEvent(root, 'failed', failure);
  seal(root);
  const before = eventsOf(root, 'failed');
  assert.equal(applyRetention(root, { now: Date.now() + 91 * DAY_MS }).contentRemoved, 1);
  const after = eventsOf(root, 'failed');
  const kept = ['type', 'tool', 'inputHash', 'status', 'durationMs', 'outputBytes', 'firstErrorLine', 'ts', 'pid', 'schema'];
  for (const [i, event] of after.entries()) {
    assert.equal(event.contentExpired, true);
    assert.equal(Object.hasOwn(event, 'input') || Object.hasOwn(event, 'output'), false);
    for (const field of kept) assert.equal(JSON.stringify(event[field]), JSON.stringify(before[i][field]), field);
  }
  assert.equal(after.length, 1);
  const signature = failureSignature(before[0], root);
  assert.match(signature, /^[0-9a-f]{16}$/);
  assert.equal(failureSignature(after[0], root), signature);
});

test('content that cannot be verified is left in place and counted', () => {
  const root = tempDir('hk-log-retention-unverifiable-');
  writeSession(root, 'edited');
  writeSession(root, 'fine');
  seal(root);
  const content = gunzipSync(readFileSync(sealedFile(root, 'edited'))).toString('utf8');
  writeFileSync(sealedFile(root, 'edited'), gzipSync(content.replace('"c0"', '"c9"')));
  writeSession(root, 'planted');
  writeFileSync(sealedFile(root, 'planted'), gzipSync(readFileSync(sessionFile(root, 'planted'))));
  rmSync(sessionFile(root, 'planted'));

  const result = applyRetention(root, { now: Date.now() + 91 * DAY_MS });
  assert.equal(result.contentRemoved, 1);
  assert.equal(result.contentUnverifiable, 2);
  assert.equal(eventsOf(root, 'edited')[0].input.command, 'c9', 'unverified content is not rewritten');
  assert.equal(eventsOf(root, 'planted')[0].input.command, 'c0');
  assert.equal(applyRetention(root, { now: Date.now() + 5 * DAY_MS }).contentUnverifiable, 0, 'only sessions past the period are counted');
});

test('a retention rewrite is itself recorded so the index stays intact', () => {
  const root = tempDir('hk-log-retention-index-');
  writeSession(root, 'aged', 2);
  writeSession(root, 'other', 1);
  seal(root);
  applyRetention(root, { now: Date.now() + 91 * DAY_MS });
  const lines = indexLines(root);
  assert.deepEqual(lines.map(l => [l.sessionId, l.contentExpired === true]), [['aged', false], ['other', false], ['aged', true], ['other', true]]);
  assert.equal(lines[2].events, 2);
  assert.equal(lines[2].firstTs, lines[0].firstTs);
  assert.notEqual(lines[2].sha256, lines[0].sha256);
  assert.equal(lines[2].sha256, sha256OfBytes(gunzipSync(readFileSync(sealedFile(root, 'aged')))));
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('the sessions sealed since an index position are counted once each, and a retention rewrite is not a seal', () => {
  const root = tempDir('hk-seal-since-');
  assert.equal(indexLineCount(root), 0, 'no index is an empty one');
  assert.equal(sessionsSealedSince(root, 0), 0);
  writeSession(root, 'first', 1);
  seal(root);
  const atTick = indexLineCount(root);
  assert.equal(atTick, 1);
  writeSession(root, 'second', 1);
  writeSession(root, 'third', 1);
  seal(root);
  writeSession(root, 'second', 1);
  seal(root);
  assert.deepEqual(indexLines(root).map(l => l.sessionId), ['first', 'second', 'third', 'second']);
  assert.equal(sessionsSealedSince(root, atTick), 2, 'a session sealed twice since is one session');
  assert.equal(sessionsSealedSince(root, 0), 3);
  const beforeRetention = indexLineCount(root);
  applyRetention(root, { now: Date.now() + 91 * DAY_MS });
  assert.ok(indexLineCount(root) > beforeRetention, 'retention appended its own lines');
  assert.equal(sessionsSealedSince(root, beforeRetention), 0);
  assert.equal(sessionsSealedSince(root, indexLineCount(root) + 5), 3, 'a position past the end means the index was replaced, so every session counts');
});

test('an index that cannot be read has no line count and no sessions sealed', () => {
  const root = tempDir('hk-seal-since-unreadable-');
  mkdirSync(dataFile(root, 'index.jsonl'), { recursive: true });
  assert.equal(indexLineCount(root), null);
  assert.equal(sessionsSealedSince(root, 0), 0);
});

/** Runs `fn` with the read limit on a log file lowered to `bytes`. */
function withReadLimit(bytes, fn) {
  process.env.KH_LOG_MAX_FILE_BYTES = String(bytes);
  try {
    return fn();
  } finally {
    delete process.env.KH_LOG_MAX_FILE_BYTES;
  }
}

test('an index over the read limit is unreadable, and nothing is sealed against it', () => {
  const root = tempDir('hk-seal-index-overlimit-');
  for (const id of ['a', 'b', 'c']) writeSession(root, id);
  seal(root, { currentSessionId: 'c' });
  withReadLimit(statSync(dataFile(root, 'index.jsonl')).size - 1, () => {
    assert.equal(verifyIndex(root).unreadable, true);
    assert.equal(indexLineCount(root), null);
    assert.deepEqual(seal(root), { sealed: [], lockLost: false, notRun: 'the index could not be read', stopped: null });
  });
  assert.deepEqual(seal(root).sealed, ['c'], 'fixture sanity: under the real limit the run seals');
});

test('a session over the read limit is left unsealed, and the sweep keeps every blob because its references are not known', () => {
  const root = tempDir('hk-seal-session-overlimit-');
  writeConfig(root, { inlineCapBytes: 1024 });
  writeSession(root, 'small', 1);
  appendEvent(root, 'big', { type: 'PostToolUse', output: 'b'.repeat(4096), pad: 'p'.repeat(900) });
  for (let i = 0; i < 4; i++) appendEvent(root, 'big', { type: 'PostToolUse', pad: 'p'.repeat(900) });
  const blob = eventsOf(root, 'big')[0].output.blob;
  touchAgo(blobFile(root, blob), 2 * DAY_MS);
  withReadLimit(2000, () => {
    assert.deepEqual(seal(root).sealed, ['small']);
    assert.deepEqual(applyRetention(root, {}).blobSweep, {
      skipped: true, reason: 'a session with events not yet sealed could not be read, so the blobs it references are not known',
    });
  });
  assert.equal(existsSync(blobFile(root, blob)), true);
  assert.equal(existsSync(sessionFile(root, 'big')), true, 'its events stay where they are');
});

test('a session larger on disk than the caller\'s bound is left unclaimed for a caller with a larger one', () => {
  const root = tempDir('hk-seal-session-bound-');
  writeSession(root, 'small', 1);
  writeSession(root, 'large', 12);
  const bound = statSync(sessionFile(root, 'small')).size + 50;
  assert.deepEqual(seal(root, { maxSessionBytes: bound }).sealed, ['small']);
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'sessions')).sort(), ['s-large.jsonl', 's-small.jsonl.gz']);
  assert.equal(eventsOf(root, 'large').length, 12, 'its events are still read');
  assert.deepEqual(seal(root).sealed, ['large']);
});

test('retention leaves a sealed session larger on disk than the caller\'s bound for a caller with a larger one', () => {
  const root = tempDir('hk-retention-session-bound-');
  writeSession(root, 'large', 12);
  seal(root);
  const later = Date.now() + 100 * DAY_MS;
  const size = statSync(sealedFile(root, 'large')).size;
  assert.equal(applyRetention(root, { now: later, maxSessionBytes: size - 1 }).contentRemoved, 0);
  assert.equal(Object.hasOwn(eventsOf(root, 'large')[0], 'output'), true);
  assert.equal(applyRetention(root, { now: later }).contentRemoved, 1);
});

test('a crash during a retention rewrite is pending and finished on the next run', () => {
  const root = tempDir('hk-log-retention-crash-');
  writeSession(root, 'aged', 2);
  seal(root);
  const original = readFileSync(sealedFile(root, 'aged'));
  applyRetention(root, { now: Date.now() + 91 * DAY_MS });
  // The state a crash leaves once the rewrite's index line is appended.
  renameSync(sealedFile(root, 'aged'), tempFile(root, 'aged'));
  writeFileSync(sealedFile(root, 'aged'), original);
  assert.deepEqual(verifyIndex(root), { ...INTACT, sessionsPending: ['aged'] });
  seal(root);
  assert.deepEqual(verifyIndex(root), INTACT);
  assert.equal(Object.hasOwn(eventsOf(root, 'aged')[0], 'output'), false);
});

test('a blob no event references is removed once it is a day old', () => {
  const root = tempDir('hk-log-orphan-');
  writeConfig(root, { inlineCapBytes: 1024 });
  appendEvent(root, 'kept', { type: 'PostToolUse', output: 'k'.repeat(4096) });
  const kept = eventsOf(root, 'kept')[0].output.blob;
  const orphan = orphanBlob(root, 'z'.repeat(4096));
  writeFileSync(join(repoDataDir(root), 'blobs', `${orphan}.gz.123.0a1b2c3d4e5f.tmp`), '');

  assert.deepEqual(applyRetention(root, {}).blobSweep, SWEPT);
  assert.equal(existsSync(blobFile(root, orphan)), true, 'a blob under a day old may belong to an event still being written');

  applyRetention(root, { now: Date.now() + 2 * DAY_MS });
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'blobs')), [`${kept}.gz`], 'an unsealed session\'s blob is kept');

  seal(root);
  applyRetention(root, { now: Date.now() + 2 * DAY_MS });
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'blobs')), [`${kept}.gz`], 'a sealed session\'s blob is kept');
});

/** Makes `path` a link to the directory `target`: a junction on win32,
 * which needs no privilege, and a symbolic link elsewhere. */
const linkDirectory = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

test('the sweep removes only the kit\'s own blob and temporary names', () => {
  const root = tempDir('hk-log-sweep-names-');
  writeSession(root, 'named', 1);
  const blobs = join(repoDataDir(root), 'blobs');
  mkdirSync(blobs, { recursive: true });
  const orphan = 'ab'.repeat(32);
  const foreign = ['thesis.docx', `${orphan}.gz.bak`, 'notes.gz', `${orphan}.gz.tmp`];
  const own = [`${orphan}.gz`, `${orphan}.gz.4321.0a1b2c3d4e5f.tmp`];
  for (const name of [...foreign, ...own]) {
    writeFileSync(join(blobs, name), 'x');
    touchAgo(join(blobs, name), 3 * DAY_MS);
  }
  assert.deepEqual(applyRetention(root, {}).blobSweep, SWEPT);
  assert.deepEqual(readdirSync(blobs).sort(), [...foreign].sort(), 'only an unreferenced blob and a blob write\'s leftover are the kit\'s to remove');
});

test('a blob store that is a link is not swept, and what it points at is untouched', () => {
  const root = tempDir('hk-log-sweep-link-');
  writeSession(root, 'linked', 1);
  const elsewhere = tempDir('hk-log-elsewhere-');
  const victim = join(elsewhere, `${'cd'.repeat(32)}.gz`);
  writeFileSync(victim, 'not ours');
  touchAgo(victim, 3 * DAY_MS);
  linkDirectory(elsewhere, join(repoDataDir(root), 'blobs'));
  assert.deepEqual(applyRetention(root, {}).blobSweep, { skipped: true, reason: 'the blob store is a link' });
  assert.equal(existsSync(victim), true);
});

test('nothing is sealed or expired through a sessions directory or a log directory that is a link', () => {
  for (const linked of ['sessions', 'log']) {
    const root = tempDir('hk-log-seal-link-');
    const elsewhere = tempDir('hk-log-elsewhere-');
    if (linked === 'sessions') {
      mkdirSync(repoDataDir(root), { recursive: true });
      linkDirectory(elsewhere, join(repoDataDir(root), 'sessions'));
    } else {
      mkdirSync(join(elsewhere, 'sessions'));
      linkDirectory(elsewhere, repoDataDir(root));
    }
    const plain = join(elsewhere, linked === 'sessions' ? '' : 'sessions', 's-foreign.jsonl');
    writeFileSync(plain, '{"type":"Stop"}\n');
    const before = readdirSync(elsewhere).sort();
    const reason = `the ${linked === 'sessions' ? 'sessions directory' : 'log directory'} is a link`;
    assert.deepEqual(seal(root), { sealed: [], lockLost: false, notRun: reason, stopped: null }, linked);
    assert.deepEqual(applyRetention(root, {}).blobSweep, { skipped: true, reason }, linked);
    assert.equal(existsSync(plain), true, 'the foreign file is not claimed');
    assert.deepEqual(readdirSync(elsewhere).sort(), before, 'no lock, index or record is written through the link');
  }
});

test('a lost index line does not let the sweep remove a blob sealed content still references', () => {
  const root = tempDir('hk-log-sweep-guard-');
  writeConfig(root, { inlineCapBytes: 1024 });
  writeSession(root, 'two-seals', 1);
  seal(root);
  appendEvent(root, 'two-seals', { type: 'PostToolUse', output: 'b'.repeat(4096) });
  const blob = eventsOf(root, 'two-seals')[1].output.blob;
  seal(root);
  const raw = rawIndexLines(root);
  assert.deepEqual(indexLines(root).map(l => l.blobs), [[], [blob]]);
  writeFileSync(dataFile(root, 'index.jsonl'), `${raw[0]}\n`);
  touchAgo(blobFile(root, blob), 2 * DAY_MS);

  const result = applyRetention(root, {});
  assert.deepEqual(result.blobSweep, { skipped: true, reason: 'sealed sessions do not match the index (altered: two-seals)' });
  assert.equal(existsSync(blobFile(root, blob)), true);

});

test('a chain broken in the middle does not stop the sweep while every sealed file matches its latest line', () => {
  const root = tempDir('hk-log-sweep-break-');
  writeConfig(root, { inlineCapBytes: 1024 });
  writeSession(root, 'first', 1);
  seal(root);
  appendEvent(root, 'second', { type: 'PostToolUse', output: 'b'.repeat(4096) });
  const referenced = eventsOf(root, 'second')[0].output.blob;
  seal(root);
  const raw = rawIndexLines(root);
  writeFileSync(dataFile(root, 'index.jsonl'), `${raw[0]}\n{"torn\n${raw[1]}\n`);
  const orphan = 'ef'.repeat(32);
  writeFileSync(blobFile(root, orphan), 'x');
  for (const sha of [referenced, orphan]) touchAgo(blobFile(root, sha), 2 * DAY_MS);

  const check = verifyIndex(root);
  assert.equal(check.brokenAt, 2);
  assert.equal(check.intact, false, 'the break is still reported');
  assert.equal(untrustedBecause(check), null, 'each session\'s latest line still names every blob its sealed content references');
  assert.deepEqual(applyRetention(root, {}).blobSweep, SWEPT);
  assert.equal(existsSync(blobFile(root, referenced)), true);
  assert.equal(existsSync(blobFile(root, orphan)), false, 'blob content is expired again');
});

test('an unfinished last index line is not a break, and is dropped under the lock before the next append', () => {
  const root = tempDir('hk-log-torn-');
  for (const id of ['a', 'b']) writeSession(root, id);
  seal(root);
  const whole = readFileSync(dataFile(root, 'index.jsonl'), 'utf8');
  writeFileSync(dataFile(root, 'index.jsonl'), `${whole}{"sessionId":"c","sha`);
  assert.deepEqual(verifyIndex(root), { ...INTACT, tornTail: true }, 'an interrupted append damaged nothing that was sealed');
  assert.equal(indexLineCount(root), 2);
  assert.equal(readFileSync(dataFile(root, 'index.jsonl'), 'utf8').endsWith('"sha'), true, 'a read removes nothing');

  writeSession(root, 'c');
  assert.deepEqual(seal(root).sealed, ['c']);
  const lines = rawIndexLines(root);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => JSON.parse(l).sessionId), ['a', 'b', 'c']);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('retention drops an unfinished last index line too, when nothing is left to seal', () => {
  const root = tempDir('hk-log-torn-retention-');
  writeSession(root, 'a');
  seal(root);
  const whole = readFileSync(dataFile(root, 'index.jsonl'), 'utf8');
  writeFileSync(dataFile(root, 'index.jsonl'), `${whole}{"sessionId":"a","sh`);
  assert.deepEqual(applyRetention(root, {}).blobSweep, SWEPT);
  assert.equal(readFileSync(dataFile(root, 'index.jsonl'), 'utf8'), whole);
});

test('a seal interrupted inside its index append, the line complete but unterminated, is done again', () => {
  const root = tempDir('hk-log-torn-complete-');
  writeSession(root, 'a');
  writeSession(root, 'b', 3);
  seal(root);
  // As a crash one byte before the end of b's append leaves it: the line
  // without its newline, the claimed events and the compressed file not yet
  // renamed into place.
  const content = gunzipSync(readFileSync(sealedFile(root, 'b')));
  renameSync(sealedFile(root, 'b'), tempFile(root, 'b'));
  writeFileSync(claimedFile(root, 'b'), content);
  const whole = readFileSync(dataFile(root, 'index.jsonl'), 'utf8');
  writeFileSync(dataFile(root, 'index.jsonl'), whole.slice(0, -1));

  assert.deepEqual(seal(root).sealed, ['b'], 'its step never completed, so the session is sealed again from its claimed events');
  assert.deepEqual(verifyIndex(root), INTACT);
  assert.equal(eventsOf(root, 'b').length, 3, 'no event is lost or doubled');
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'sessions')).sort(), ['s-a.jsonl.gz', 's-b.jsonl.gz']);
});

/** A `gunzip` that counts its calls. */
function countingGunzip() {
  const gunzip = bytes => {
    gunzip.calls++;
    return gunzipSync(bytes);
  };
  gunzip.calls = 0;
  return gunzip;
}

/** A repository with `ids` sealed, one session each. */
function sealedRepo(prefix, ids) {
  const root = tempDir(prefix);
  for (const id of ids) writeSession(root, id);
  seal(root);
  return root;
}

test('a second run within budget does not decompress a session verified by the first', () => {
  const root = sealedRepo('hk-log-cache-', ['c-1', 'c-2', 'c-3']);
  const first = countingGunzip();
  assert.deepEqual(applyRetention(root, { gunzip: first }).blobSweep, SWEPT);
  assert.equal(first.calls, 3, 'the first run hashes every sealed session');
  const second = countingGunzip();
  assert.deepEqual(applyRetention(root, { gunzip: second }).blobSweep, SWEPT);
  assert.equal(second.calls, 0);
});

test('successive budget-limited runs converge and the sweep then removes an unreferenced blob', () => {
  const root = sealedRepo('hk-log-converge-', ['v-1', 'v-2', 'v-3', 'v-4', 'v-5']);
  const orphan = orphanBlob(root, 'z'.repeat(4096));
  touchAgo(blobFile(root, orphan), 2 * DAY_MS);
  let t = 0;
  const clock = () => (t += 10);
  const sweeps = [];
  for (let run = 0; run < 10 && (sweeps.length === 0 || sweeps.at(-1).skipped); run++) {
    sweeps.push(applyRetention(root, { budgetMs: 25, clock }).blobSweep);
  }
  assert.deepEqual(sweeps.at(0), { skipped: true, reason: 'the time budget was spent' }, 'one run cannot verify every session');
  assert.deepEqual(sweeps.at(-1), SWEPT, `converged after ${sweeps.length} runs`);
  assert.equal(existsSync(blobFile(root, orphan)), false);
});

test('a sealed file edited after it was cached, with a different size or time, is hashed again and reported altered', () => {
  const root = sealedRepo('hk-log-cache-edit-', ['e-1', 'e-2']);
  applyRetention(root, {});
  const content = gunzipSync(readFileSync(sealedFile(root, 'e-1'))).toString('utf8');
  writeFileSync(sealedFile(root, 'e-1'), gzipSync(content.replace('"c0"', '"an edited command"')));
  const gunzip = countingGunzip();
  assert.deepEqual(applyRetention(root, { gunzip }).blobSweep, { skipped: true, reason: 'sealed sessions do not match the index (altered: e-1)' });
  assert.equal(gunzip.calls, 1, 'only the changed file is read');
  assert.deepEqual(verifyIndex(root).sessionsAltered, ['e-1']);
});

test('verifyIndex ignores the cache', () => {
  const root = sealedRepo('hk-log-cache-ignored-', ['i-1']);
  applyRetention(root, {});
  const content = gunzipSync(readFileSync(sealedFile(root, 'i-1'))).toString('utf8');
  writeFileSync(sealedFile(root, 'i-1'), gzipSync(content.replace('"c0"', '"c9"')));
  // A record that vouches for the edited file, as one preserving its size
  // and time would leave it.
  const cache = JSON.parse(readFileSync(dataFile(root, 'verified.json'), 'utf8'));
  const st = statSync(sealedFile(root, 'i-1'));
  cache.sessions['i-1'] = { ...cache.sessions['i-1'], size: st.size, mtimeMs: st.mtimeMs };
  writeFileSync(dataFile(root, 'verified.json'), JSON.stringify(cache));
  assert.deepEqual(applyRetention(root, {}).blobSweep, SWEPT, 'the sweep trusts its record');
  assert.deepEqual(verifyIndex(root), { ...INTACT, intact: false, sessionsAltered: ['i-1'] });
});

test('an unreadable cache means every sealed session is hashed again', () => {
  const root = sealedRepo('hk-log-cache-bad-', ['u-1', 'u-2']);
  applyRetention(root, {});
  writeFileSync(dataFile(root, 'verified.json'), '{not json');
  const gunzip = countingGunzip();
  assert.deepEqual(applyRetention(root, { gunzip }).blobSweep, SWEPT);
  assert.equal(gunzip.calls, 2);
});

test('an edited sealed file beside a matching temporary file is reported altered and is not overwritten', () => {
  const root = tempDir('hk-log-pending-edit-');
  writeSession(root, 'p-1', 2);
  seal(root);
  appendEvent(root, 'p-1', { type: 'SessionEnd', reason: 'other' });
  seal(root);
  // The temporary file matches the latest line, but the file in place holds
  // neither the earlier content nor nothing.
  renameSync(sealedFile(root, 'p-1'), tempFile(root, 'p-1'));
  const edited = gzipSync('{"type":"PostToolUse","input":{"command":"edited"}}\n');
  writeFileSync(sealedFile(root, 'p-1'), edited);
  assert.deepEqual(verifyIndex(root), { ...INTACT, intact: false, sessionsAltered: ['p-1'] });
  seal(root);
  applyRetention(root, { now: Date.now() + 91 * DAY_MS });
  assert.deepEqual(readFileSync(sealedFile(root, 'p-1')), edited, 'recovery did not rename over it');
  assert.equal(existsSync(tempFile(root, 'p-1')), true);
  assert.deepEqual(verifyIndex(root).sessionsAltered, ['p-1']);
});

/** The temporary files in the sessions directory. */
const tempFiles = root => readdirSync(join(repoDataDir(root), 'sessions')).filter(n => n.endsWith(SEAL_TEMP_SUFFIX));

test('a run whose lock is replaced part-way stops before its next write', () => {
  const root = tempDir('hk-log-lock-lost-');
  for (const id of ['l-1', 'l-2', 'l-3']) {
    writeSession(root, id);
    touchAgo(sessionFile(root, id), SEAL_IDLE_MS + MINUTE_MS);
  }
  // A claim an interrupted run left, so the first write sealing `l-2` makes
  // is its temporary file.
  renameSync(sessionFile(root, 'l-2'), claimedFile(root, 'l-2'));
  const lock = dataFile(root, 'index.jsonl.lock');
  const usurper = JSON.stringify({ pid: process.pid, token: 'usurper' });
  const theirs = gzipSync('the new holder\'s content\n');
  // Called once to start the budget and once before each session: the third
  // call comes after the first session is finished, and the new holder then
  // takes the lock and starts its own temporary file for `l-2`.
  let calls = 0;
  const clock = () => {
    if (++calls === 3) {
      writeFileSync(lock, usurper);
      writeFileSync(tempFile(root, 'l-2'), theirs);
    }
    return 0;
  };
  assert.deepEqual(sealClosedSessions(root, { clock }), { sealed: ['l-1'], lockLost: true, notRun: null, stopped: null });
  assert.equal(indexLines(root).length, 1);
  assert.deepEqual(readFileSync(tempFile(root, 'l-2')), theirs, 'the new holder\'s temporary file is untouched');
  assert.deepEqual(tempFiles(root), ['s-l-2.jsonl.gz.tmp'], 'no temporary file of this run is left');
  assert.equal(existsSync(claimedFile(root, 'l-2')), true, 'the claim is kept for a later run');
  assert.equal(existsSync(sessionFile(root, 'l-3')), true, 'the next session was not claimed');
  assert.equal(readFileSync(lock, 'utf8'), usurper, 'the new holder\'s lock is left in place');

  rmSync(lock);
  rmSync(tempFile(root, 'l-2'));
  seal(root);
  calls = 0;
  const retention = applyRetention(root, { now: Date.now() + 91 * DAY_MS, clock });
  assert.deepEqual(retention, { contentRemoved: 1, contentUnverifiable: 0, blobSweep: { skipped: true, reason: 'the index lock was lost' }, lockLost: true, notRun: null, stopped: null });
  assert.deepEqual(indexLines(root).map(l => [l.sessionId, l.contentExpired === true]), [
    ['l-1', false], ['l-2', false], ['l-3', false], ['l-1', true],
  ], 'the first session was expired before the lock was replaced, and nothing after');
  assert.equal(eventsOf(root, 'l-2')[0].input.command, 'c0');
  assert.deepEqual(readFileSync(tempFile(root, 'l-2')), theirs, 'the new holder\'s temporary file is untouched');
  assert.deepEqual(tempFiles(root), ['s-l-2.jsonl.gz.tmp'], 'no temporary file of this run is left');
  rmSync(lock);
  rmSync(tempFile(root, 'l-2'));
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('an unchanged cache is not rewritten', () => {
  const root = sealedRepo('hk-log-cache-unchanged-', ['n-1', 'n-2']);
  applyRetention(root, {});
  const cache = dataFile(root, 'verified.json');
  touchAgo(cache, DAY_MS);
  const before = statSync(cache).mtimeMs;
  assert.deepEqual(applyRetention(root, {}).blobSweep, SWEPT);
  assert.equal(statSync(cache).mtimeMs, before);
});

test('writing the cache removes a temporary file a crashed run left', () => {
  const root = sealedRepo('hk-log-cache-leftover-', ['t-1']);
  writeFileSync(dataFile(root, 'verified.json.4242.abcdef.tmp'), '{"half');
  writeFileSync(dataFile(root, 'verified.json.bak'), 'not ours to remove');
  applyRetention(root, {});
  const names = readdirSync(repoDataDir(root));
  assert.equal(names.includes('verified.json.4242.abcdef.tmp'), false);
  assert.deepEqual(names.filter(n => n.startsWith('verified.json')).sort(), ['verified.json', 'verified.json.bak']);
});

test('an event of a type the classification does not know loses its input, output and prompt', () => {
  const root = tempDir('hk-log-unknown-type-');
  appendEvent(root, 'novel', { type: 'SomethingNew', input: { a: 1 }, output: 'o', prompt: 'p', tool: 'Bash', detail: 'kept' });
  seal(root);
  assert.equal(applyRetention(root, { now: Date.now() + 91 * DAY_MS }).contentRemoved, 1);
  const [event] = eventsOf(root, 'novel');
  assert.deepEqual([event.tool, event.detail, event.contentExpired], ['Bash', 'kept', true]);
  for (const f of ['input', 'output', 'prompt']) assert.equal(Object.hasOwn(event, f), false, f);
});
