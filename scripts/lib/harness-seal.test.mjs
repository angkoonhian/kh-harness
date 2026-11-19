// scripts/lib/harness-seal.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { appendEvent, readEvents, repoDataDir, sessionFileName, storeBlob } from '../../assets/scripts/harness-log.mjs';
import { applyRetention, CLAIMED_SUFFIX, SEAL_TEMP_SUFFIX, sealClosedSessions, verifyIndex } from '../../assets/scripts/harness-seal.mjs';

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

test('the claimed and temporary file suffixes are exported for later readers', () => {
  assert.equal(`${sessionFileName('x')}${CLAIMED_SUFFIX}`, 's-x.jsonl.sealing');
  assert.equal(`${sessionFileName('x')}${SEAL_TEMP_SUFFIX}`, 's-x.jsonl.gz.tmp');
});

const DAY_MS = 86_400_000;
const dataFile = (root, name) => join(repoDataDir(root), name);
const indexLines = root => readFileSync(dataFile(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rawIndexLines = root => readFileSync(dataFile(root, 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
const sealedFile = (root, sessionId) => `${sessionFile(root, sessionId)}.gz`;
const claimedFile = (root, sessionId) => `${sessionFile(root, sessionId)}${CLAIMED_SUFFIX}`;
const tempFile = (root, sessionId) => `${sessionFile(root, sessionId)}${SEAL_TEMP_SUFFIX}`;
const eventsOf = (root, sessionId) => readEvents(root, sessionId).events;
const sha256OfBytes = bytes => createHash('sha256').update(bytes).digest('hex');

/** A session of `count` tool results, each with input and output. */
function writeSession(root, sessionId, count = 2) {
  for (let i = 0; i < count; i++) {
    const r = appendEvent(root, sessionId, { type: 'PostToolUse', tool: 'Bash', inputHash: `h${i}`, status: 'ok', input: { command: `c${i}` }, output: `o${i}` });
    assert.equal(r.written, true);
  }
}

const INTACT = { intact: true, brokenAt: null, sessionsMissing: [], sessionsAltered: [] };

test('a closed session is compressed and indexed', () => {
  const root = tempDir('hk-log-seal-');
  writeSession(root, 'closed-1', 3);
  writeSession(root, 'current-1', 1);
  const plainBytes = readFileSync(sessionFile(root, 'closed-1'));
  const before = eventsOf(root, 'closed-1');

  assert.deepEqual(sealClosedSessions(root, { currentSessionId: 'current-1' }), { sealed: ['closed-1'] });

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
  assert.deepEqual(sealClosedSessions(root, { currentSessionId: 'current-1' }), { sealed: [] }, 'a sealed session is not sealed again');
  assert.equal(indexLines(root).length, 1);
});

test('each index line chains to the one before it', () => {
  const root = tempDir('hk-log-chain-');
  for (const id of ['a', 'b', 'c']) writeSession(root, id);
  sealClosedSessions(root, {});
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
  sealClosedSessions(root, {});
  assert.deepEqual(Object.fromEntries(indexLines(root).map(l => [l.sessionId, l.external])), { inside: false, outside: true });
});

test('editing a sealed session is reported as altered', () => {
  const root = tempDir('hk-log-altered-');
  writeSession(root, 'kept');
  writeSession(root, 'edited');
  sealClosedSessions(root, {});
  const content = gunzipSync(readFileSync(sealedFile(root, 'edited'))).toString('utf8');
  writeFileSync(sealedFile(root, 'edited'), gzipSync(content.replace('"c0"', '"c9"')));
  assert.deepEqual(verifyIndex(root), { intact: false, brokenAt: null, sessionsMissing: [], sessionsAltered: ['edited'] });

  rmSync(sealedFile(root, 'kept'));
  assert.deepEqual(verifyIndex(root).sessionsMissing, ['kept']);

  appendEvent(root, 'edited', { type: 'Stop' });
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [] }, 'an altered session is not sealed over');
  assert.deepEqual(verifyIndex(root).sessionsAltered, ['edited']);
  assert.deepEqual(eventsOf(root, 'edited').map(e => e.type), ['PostToolUse', 'PostToolUse', 'Stop'], 'its unsealed events stay readable');
});

test('a sealed file with no index line is reported as altered', () => {
  const root = tempDir('hk-log-unindexed-');
  writeSession(root, 'planted');
  writeFileSync(sealedFile(root, 'planted'), gzipSync(readFileSync(sessionFile(root, 'planted'))));
  rmSync(sessionFile(root, 'planted'));
  assert.deepEqual(verifyIndex(root), { intact: false, brokenAt: null, sessionsMissing: [], sessionsAltered: ['planted'] });
});

test('deleting an index line is reported as a break at that position', () => {
  const root = tempDir('hk-log-break-');
  for (const id of ['a', 'b', 'c', 'd']) writeSession(root, id);
  sealClosedSessions(root, {});
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
  sealClosedSessions(root, {});
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
  for (const id of ids) writeSession(root, id, 5);
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

test('a lock held by a live process means skip, and one left by an exited process is broken', () => {
  const root = tempDir('hk-log-lock-');
  writeSession(root, 'locked');
  const lock = dataFile(root, 'index.jsonl.lock');
  const held = JSON.stringify({ pid: process.pid, token: 'other' });
  writeFileSync(lock, held);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [] });
  assert.deepEqual(applyRetention(root, { now: Date.now() + 365 * DAY_MS }), { contentRemoved: 0 });
  assert.equal(readFileSync(lock, 'utf8'), held, 'only its owner releases a lock');

  const exited = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(lock, JSON.stringify({ pid: exited, token: 'gone' }));
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: ['locked'] });
  assert.equal(existsSync(lock), false);
});

test('a lock with no owner is broken only once it is stale', () => {
  const root = tempDir('hk-log-ownerless-');
  writeSession(root, 'waiting');
  writeFileSync(dataFile(root, 'index.jsonl.lock'), '');
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [] });
  assert.deepEqual(sealClosedSessions(root, { now: Date.now() + 60_000 }), { sealed: ['waiting'] });
});

test('sealing stops when the budget is spent and resumes on the next run', () => {
  const root = tempDir('hk-log-budget-');
  const ids = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'];
  for (const id of ids) writeSession(root, id);
  let t = 0;
  const clock = () => (t += 10);
  const first = sealClosedSessions(root, { budgetMs: 25, clock }).sealed;
  assert.ok(first.length > 0 && first.length < ids.length, `sealed ${first.length} of ${ids.length}`);
  assert.deepEqual(sealClosedSessions(root, { budgetMs: 0 }), { sealed: [] }, 'no budget, no work');
  const second = sealClosedSessions(root, {}).sealed;
  assert.deepEqual([...first, ...second], ids);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('an event that arrives after sealing is sealed on the next run and no event is read twice', () => {
  const root = tempDir('hk-log-late-');
  writeSession(root, 'late', 2);
  sealClosedSessions(root, {});
  appendEvent(root, 'late', { type: 'SessionEnd', reason: 'other' });
  assert.deepEqual(eventsOf(root, 'late').map(e => e.type), ['PostToolUse', 'PostToolUse', 'SessionEnd']);
  assert.deepEqual(verifyIndex(root), INTACT, 'events not yet sealed are not a break');

  assert.deepEqual(sealClosedSessions(root, {}), { sealed: ['late'] });
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
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: ['busy'] });
  assert.deepEqual(eventsOf(root, 'busy').map(e => e.type), ['PostToolUse', 'PostToolUse', 'Stop']);
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: ['busy'] });
  assert.deepEqual(eventsOf(root, 'busy').map(e => e.type), ['PostToolUse', 'PostToolUse', 'Stop']);
  assert.deepEqual(indexLines(root).map(l => l.events), [2, 3]);
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('a crash between writing the compressed file and removing the plain one is recovered without duplicating events', () => {
  const root = tempDir('hk-log-crash-');
  writeSession(root, 'crash', 2);
  sealClosedSessions(root, {});
  const firstSeal = readFileSync(sealedFile(root, 'crash'));
  appendEvent(root, 'crash', { type: 'SessionEnd', reason: 'other' });
  const late = readFileSync(sessionFile(root, 'crash'));
  sealClosedSessions(root, {});
  // The state a crash leaves once the continuation's index line is appended:
  // the whole content is in the temporary file, the claimed events are still
  // on disk and the earlier sealed file is still in place.
  renameSync(sealedFile(root, 'crash'), tempFile(root, 'crash'));
  writeFileSync(sealedFile(root, 'crash'), firstSeal);
  writeFileSync(claimedFile(root, 'crash'), late);
  assert.deepEqual(eventsOf(root, 'crash').map(e => e.type), ['PostToolUse', 'PostToolUse'], 'no state shows an event twice');

  assert.deepEqual(sealClosedSessions(root, {}), { sealed: [] }, 'the interrupted seal is finished, not repeated');
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
  assert.deepEqual(sealClosedSessions(root, {}), { sealed: ['early'] });
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
  sealClosedSessions(root, {});
  assert.deepEqual(indexLines(root)[0].blobs, [withBlob.output.blob]);

  assert.deepEqual(applyRetention(root, { now: Date.now() + 6 * DAY_MS }), { contentRemoved: 0 }, 'content inside the period is kept');
  assert.equal(eventsOf(root, 'old')[0].prompt, 'fix the parser');

  assert.deepEqual(applyRetention(root, { now: Date.now() + 8 * DAY_MS }), { contentRemoved: 1 });
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
  assert.deepEqual(applyRetention(root, { now: Date.now() + 9 * DAY_MS }), { contentRemoved: 0 }, 'expired content is not expired again');
});

test('a retention rewrite is itself recorded so the index stays intact', () => {
  const root = tempDir('hk-log-retention-index-');
  writeSession(root, 'aged', 2);
  writeSession(root, 'other', 1);
  sealClosedSessions(root, {});
  applyRetention(root, { now: Date.now() + 91 * DAY_MS });
  const lines = indexLines(root);
  assert.deepEqual(lines.map(l => [l.sessionId, l.contentExpired === true]), [['aged', false], ['other', false], ['aged', true], ['other', true]]);
  assert.equal(lines[2].events, 2);
  assert.equal(lines[2].firstTs, lines[0].firstTs);
  assert.notEqual(lines[2].sha256, lines[0].sha256);
  assert.equal(lines[2].sha256, sha256OfBytes(gunzipSync(readFileSync(sealedFile(root, 'aged')))));
  assert.deepEqual(verifyIndex(root), INTACT);
});

test('a crash during a retention rewrite is finished on the next run', () => {
  const root = tempDir('hk-log-retention-crash-');
  writeSession(root, 'aged', 2);
  sealClosedSessions(root, {});
  const original = readFileSync(sealedFile(root, 'aged'));
  applyRetention(root, { now: Date.now() + 91 * DAY_MS });
  // The state a crash leaves once the rewrite's index line is appended.
  renameSync(sealedFile(root, 'aged'), tempFile(root, 'aged'));
  writeFileSync(sealedFile(root, 'aged'), original);
  assert.deepEqual(verifyIndex(root).sessionsAltered, ['aged']);
  sealClosedSessions(root, {});
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

  applyRetention(root, {});
  assert.equal(existsSync(blobFile(root, orphan)), true, 'a blob under a day old may belong to an event still being written');

  applyRetention(root, { now: Date.now() + 2 * DAY_MS });
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'blobs')), [`${kept}.gz`], 'an unsealed session\'s blob is kept');

  sealClosedSessions(root, {});
  applyRetention(root, { now: Date.now() + 2 * DAY_MS });
  assert.deepEqual(readdirSync(join(repoDataDir(root), 'blobs')), [`${kept}.gz`], 'a sealed session\'s blob is kept');
});
