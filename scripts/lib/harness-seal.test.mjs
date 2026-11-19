// scripts/lib/harness-seal.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { appendEvent, readEvents, repoDataDir, sessionFileName, storeBlob } from '../../assets/scripts/harness-log.mjs';
import {
  applyRetention, CLAIMED_SUFFIX, SEAL_IDLE_MS, SEAL_TEMP_SUFFIX, sealClosedSessions, verifyIndex,
} from '../../assets/scripts/harness-seal.mjs';

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

/** `sealClosedSessions` at `idleNow()` unless the test says otherwise. */
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

const INTACT = { intact: true, brokenAt: null, sessionsMissing: [], sessionsAltered: [], sessionsPending: [] };
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

  assert.deepEqual(seal(root, { currentSessionId: 'current-1' }), { sealed: ['closed-1'] });

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
  assert.deepEqual(seal(root, { currentSessionId: 'current-1' }), { sealed: [] }, 'a sealed session is not sealed again');
  assert.equal(indexLines(root).length, 1);
});

test('a session written to two minutes ago is left unsealed', () => {
  const root = tempDir('hk-log-recent-');
  writeSession(root, 'recent');
  touchAgo(sessionFile(root, 'recent'), 2 * MINUTE_MS);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [] });
  assert.equal(existsSync(sessionFile(root, 'recent')), true);
  assert.equal(existsSync(dataFile(root, 'index.jsonl')), false);
});

test('the same session is sealed once it has been idle past the threshold', () => {
  const root = tempDir('hk-log-idle-');
  writeSession(root, 'idle');
  touchAgo(sessionFile(root, 'idle'), 2 * MINUTE_MS);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [] });
  touchAgo(sessionFile(root, 'idle'), SEAL_IDLE_MS + MINUTE_MS);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: ['idle'] });
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
  assert.deepEqual(seal(root), { sealed: [] }, 'an altered session is not sealed over');
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
  assert.deepEqual(sealClosedSessions(root, { isAlive: alive }), { sealed: [] });
  const retention = applyRetention(root, { isAlive: alive });
  assert.deepEqual(retention, { contentRemoved: 0, contentUnverifiable: 0, blobSweep: { skipped: true, reason: 'another process holds the index lock' } });
  assert.equal(readFileSync(lock, 'utf8'), owner, 'only its owner releases a lock');

  assert.deepEqual(sealClosedSessions(root, { isAlive: () => false }), { sealed: ['locked'] });
  assert.equal(existsSync(lock), false);
});

test('a lock ten minutes old is broken whatever its owner', () => {
  const { root, lock } = lockedRepo('hk-log-lock-age-', JSON.stringify({ pid: 4242, token: 'stuck' }));
  const alive = () => true;
  assert.deepEqual(sealClosedSessions(root, { now: Date.now() + 9 * MINUTE_MS, isAlive: alive }), { sealed: [] });
  assert.deepEqual(sealClosedSessions(root, { now: Date.now() + 11 * MINUTE_MS, isAlive: alive }), { sealed: ['locked'] });
  assert.equal(existsSync(lock), false);
});

test('a lock with no owner is broken only once it is stale', () => {
  const { root } = lockedRepo('hk-log-ownerless-', '');
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [] });
  assert.deepEqual(sealClosedSessions(root, { now: Date.now() + MINUTE_MS }), { sealed: ['locked'] });
});

test('sealing stops when the budget is spent and resumes on the next run', () => {
  const root = tempDir('hk-log-budget-');
  const ids = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'];
  for (const id of ids) writeSession(root, id);
  let t = 0;
  const clock = () => (t += 10);
  const first = seal(root, { budgetMs: 25, clock }).sealed;
  assert.ok(first.length > 0 && first.length < ids.length, `sealed ${first.length} of ${ids.length}`);
  assert.deepEqual(seal(root, { budgetMs: 0 }), { sealed: [] }, 'no budget, no work');
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

  assert.deepEqual(seal(root), { sealed: ['late'] });
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
  assert.deepEqual(seal(root), { sealed: ['busy'] });
  assert.deepEqual(eventsOf(root, 'busy').map(e => e.type), ['PostToolUse', 'PostToolUse', 'Stop']);
  assert.deepEqual(seal(root), { sealed: ['busy'] });
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

  assert.deepEqual(seal(root), { sealed: [] }, 'the interrupted seal is finished, not repeated');
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
  assert.deepEqual(seal(root), { sealed: ['early'] });
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

  assert.deepEqual(applyRetention(root, { now: Date.now() + 6 * DAY_MS }), { contentRemoved: 0, contentUnverifiable: 0, blobSweep: SWEPT }, 'content inside the period is kept');
  assert.equal(eventsOf(root, 'old')[0].prompt, 'fix the parser');

  assert.deepEqual(applyRetention(root, { now: Date.now() + 8 * DAY_MS }), { contentRemoved: 1, contentUnverifiable: 0, blobSweep: SWEPT });
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
  assert.deepEqual([failure.tool, failure.status, failure.contentExpired], ['Bash', 'error', true]);
  for (const f of ['firstErrorLine', 'input', 'output']) assert.equal(Object.hasOwn(failure, f), false, f);
  assert.deepEqual([denied.tool, Object.hasOwn(denied, 'reason')], ['Bash', false]);
  assert.deepEqual([Object.hasOwn(stopFailure, 'error'), Object.hasOwn(stopFailure, 'errorDetails')], [false, false]);
  assert.equal(end.reason, 'other', 'a session end reason is one of a fixed set, not free text');
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
  const orphan = storeBlob(root, 'z'.repeat(4096)).sha256;
  writeFileSync(join(repoDataDir(root), 'blobs', `${orphan}.gz.123.abc.tmp`), '');

  assert.deepEqual(applyRetention(root, {}).blobSweep, SWEPT);
  assert.equal(existsSync(blobFile(root, orphan)), true, 'a blob under a day old may belong to an event still being written');

  applyRetention(root, { now: Date.now() + 2 * DAY_MS });
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'blobs')), [`${kept}.gz`], 'an unsealed session\'s blob is kept');

  seal(root);
  applyRetention(root, { now: Date.now() + 2 * DAY_MS });
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'blobs')), [`${kept}.gz`], 'a sealed session\'s blob is kept');
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

  writeFileSync(dataFile(root, 'index.jsonl'), `${raw[0]}\n{"torn\n${raw[1]}\n`);
  assert.deepEqual(applyRetention(root, {}).blobSweep, { skipped: true, reason: 'the index chain is broken at line 2' });
  assert.equal(existsSync(blobFile(root, blob)), true);
});
