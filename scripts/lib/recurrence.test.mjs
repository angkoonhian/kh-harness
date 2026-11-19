// scripts/lib/recurrence.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { appendEvent, repoDataDir, sessionFileName } from '../../assets/scripts/harness-log.mjs';
import { toLogEvent } from '../../assets/scripts/session-log.mjs';
import { failureSignature, FAILURE_EVENT, findRecurrences, listSessions, normaliseError, sessionIds, SUCCESS_EVENT } from './recurrence.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-rec-data-');

const HARNESS = { type: 'harness', base: 'base-one', learned: 'learned-one', model: 'model-one' };

const failure = (sessionId, over = {}) => ({
  type: FAILURE_EVENT,
  tool: 'Bash',
  inputHash: 'input-one',
  firstErrorLine: 'Error: tests failed',
  session_id: sessionId,
  tool_use_id: `${sessionId}-use`,
  ...over,
});

function log(root, sessionId, ...events) {
  for (const event of events) assert.deepEqual(appendEvent(root, sessionId, event), { written: true });
}

const sessionsDir = root => join(repoDataDir(root), 'sessions');

test('the event type names match the hook events they stand for', () => {
  assert.equal(FAILURE_EVENT, 'PostToolUseFailure');
  assert.equal(SUCCESS_EVENT, 'PostToolUse');
});

test('the same failure in two sessions under one harness recurs', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', HARNESS, { type: SUCCESS_EVENT, tool: 'Read', inputHash: 'x' }, failure('two'));
  const result = findRecurrences(root);
  assert.equal(result.sessionsRead, 2);
  assert.equal(result.sessionsUnreadable, 0);
  assert.equal(result.linesUnparseable, 0);
  assert.equal(result.failuresUnattributed, 0);
  assert.equal(result.recurrences.length, 1);
  const [r] = result.recurrences;
  assert.equal(r.signature, failureSignature(failure('one'), root));
  assert.match(r.signature, /^[0-9a-f]{16}$/);
  assert.equal(r.tool, 'Bash');
  assert.equal(r.errorLine, 'Error: tests failed');
  assert.deepEqual(r.sessions, ['one', 'two']);
  assert.equal(r.count, 2);
  assert.equal(r.base, 'base-one');
  assert.equal(r.model, 'model-one');
  assert.equal(r.external, false);
  assert.ok(r.firstTs <= r.lastTs);
  assert.ok(!Number.isNaN(Date.parse(r.firstTs)));
  assert.deepEqual(r.exampleEventRefs, [{ sessionId: 'one', line: 2 }, { sessionId: 'two', line: 3 }]);
});

test('the same failure twice in one session does not', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'), failure('one'));
  log(root, 'two', HARNESS, failure('two', { tool: 'Edit' }));
  assert.deepEqual(findRecurrences(root).recurrences, []);
});

test('the same failure under two base hashes does not', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', { ...HARNESS, base: 'base-two' }, failure('two'));
  assert.deepEqual(findRecurrences(root).recurrences, []);
});

test('a different model does not combine', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', { ...HARNESS, model: 'model-two' }, failure('two'));
  assert.deepEqual(findRecurrences(root).recurrences, []);
});

test('a failure is attributed to the harness in force when it happened', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'), { ...HARNESS, base: 'base-two' });
  log(root, 'two', { ...HARNESS, base: 'base-two' }, failure('two'), HARNESS, failure('two'));
  const { recurrences } = findRecurrences(root);
  assert.equal(recurrences.length, 1);
  assert.equal(recurrences[0].base, 'base-one');
  assert.deepEqual(recurrences[0].sessions, ['one', 'two']);
  assert.equal(recurrences[0].count, 2);
  assert.deepEqual(recurrences[0].exampleEventRefs, [{ sessionId: 'one', line: 2 }, { sessionId: 'two', line: 4 }]);
});

test('a learned-set change does not split a recurrence', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', { ...HARNESS, learned: 'learned-two' }, failure('two'));
  assert.equal(findRecurrences(root).recurrences.length, 1);
});

test('two sessions whose harness could not be read do not recur together', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', { ...HARNESS, base: 'unreadable' }, failure('one'));
  log(root, 'two', { ...HARNESS, base: 'unreadable' }, failure('two'));
  log(root, 'three', { ...HARNESS, base: 7 }, failure('three'));
  log(root, 'four', { type: 'harness', learned: 'learned-one', model: 'model-one' }, failure('four'));
  const result = findRecurrences(root);
  assert.deepEqual(result.recurrences, []);
  assert.equal(result.failuresUnattributed, 4);
});

test('two sessions with no recorded model do not recur together', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', { type: 'harness', base: 'base-one', learned: 'learned-one' }, failure('one'));
  log(root, 'two', { ...HARNESS, model: '' }, failure('two'));
  log(root, 'three', { ...HARNESS, model: 3 }, failure('three'));
  const result = findRecurrences(root);
  assert.deepEqual(result.recurrences, []);
  assert.equal(result.failuresUnattributed, 3);
});

test('two sessions with no kit harness installed and the same model do recur', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', { ...HARNESS, base: 'none' }, failure('one'));
  log(root, 'two', { ...HARNESS, base: 'none' }, failure('two'));
  log(root, 'three', HARNESS, failure('three'));
  const { recurrences, failuresUnattributed } = findRecurrences(root);
  assert.equal(recurrences.length, 1);
  assert.equal(recurrences[0].base, 'none');
  assert.deepEqual(recurrences[0].sessions, ['one', 'two']);
  assert.equal(failuresUnattributed, 0);
});

test('unattributed failures are counted', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', failure('one'), HARNESS, failure('one'), { ...HARNESS, base: 'unreadable' }, failure('one'), failure('one'));
  log(root, 'two', failure('two'), HARNESS, failure('two'), { type: SUCCESS_EVENT, tool: 'Read', inputHash: 'x' });
  const result = findRecurrences(root);
  assert.equal(result.failuresUnattributed, 4);
  assert.equal(result.recurrences.length, 1);
  assert.equal(result.recurrences[0].count, 2);
  assert.deepEqual(result.recurrences[0].exampleEventRefs, [{ sessionId: 'one', line: 3 }, { sessionId: 'two', line: 3 }]);
});

test('a recurrence with any external session is marked external', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', HARNESS, failure('two'), { type: 'external_content' });
  const { recurrences } = findRecurrences(root);
  assert.equal(recurrences.length, 1);
  assert.equal(recurrences[0].external, true);
});

test('an external_content event before the failure marks the recurrence external', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', { type: 'external_content' }, HARNESS, failure('two'));
  const { recurrences } = findRecurrences(root);
  assert.equal(recurrences.length, 1);
  assert.equal(recurrences[0].external, true);
});

test('a recurrence with no external session is not marked external', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', HARNESS, failure('two'));
  log(root, 'three', HARNESS, { type: 'external_content' });
  assert.equal(findRecurrences(root).recurrences[0].external, false);
});

test('line numbers in the error do not split a signature', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one', { firstErrorLine: 'SyntaxError at line 12, column 3' }));
  log(root, 'two', HARNESS, failure('two', { firstErrorLine: 'SyntaxError at line 418, column 27' }));
  const { recurrences } = findRecurrences(root);
  assert.equal(recurrences.length, 1);
  assert.equal(recurrences[0].errorLine, 'SyntaxError at line #, column #');
});

test('minSessions raises the threshold', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', HARNESS, failure('two'));
  assert.equal(findRecurrences(root, { minSessions: 3 }).recurrences.length, 0);
  log(root, 'three', HARNESS, failure('three'));
  assert.equal(findRecurrences(root, { minSessions: 3 }).recurrences.length, 1);
  assert.throws(() => findRecurrences(root, { minSessions: 0 }), RangeError);
  assert.throws(() => findRecurrences(root, { minSessions: 1.5 }), RangeError);
});

test('example references are at most three, one per session', () => {
  const root = tempDir('hk-rec-repo-');
  for (const id of ['a', 'b', 'c', 'd']) log(root, id, HARNESS, failure(id), failure(id));
  const [r] = findRecurrences(root).recurrences;
  assert.equal(r.count, 8);
  assert.deepEqual(r.exampleEventRefs, [{ sessionId: 'a', line: 2 }, { sessionId: 'b', line: 2 }, { sessionId: 'c', line: 2 }]);
});

test('recurrences are ordered by session count, then count, then signature', () => {
  const root = tempDir('hk-rec-repo-');
  for (const id of ['a', 'b', 'c']) log(root, id, HARNESS, failure(id, { firstErrorLine: 'wide' }));
  log(root, 'a', failure('a', { firstErrorLine: 'deep' }), failure('a', { firstErrorLine: 'deep' }));
  log(root, 'b', HARNESS, failure('b', { firstErrorLine: 'deep' }), failure('b', { firstErrorLine: 'deep' }));
  for (const id of ['a', 'b']) log(root, id, HARNESS, failure(id, { firstErrorLine: 'narrow' }));
  const lines = findRecurrences(root).recurrences.map(r => r.errorLine);
  assert.deepEqual(lines, ['wide', 'deep', 'narrow']);
});

test('a compressed session is read once, with its plain continuation', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  const plain = join(sessionsDir(root), sessionFileName('one'));
  writeFileSync(`${plain}.gz`, gzipSync(readFileSync(plain)));
  rmSync(plain);
  log(root, 'one', failure('one'));
  log(root, 'two', HARNESS, failure('two'));
  const result = findRecurrences(root);
  assert.equal(result.sessionsRead, 2);
  assert.deepEqual(result.recurrences[0].sessions, ['one', 'two']);
  assert.equal(result.recurrences[0].count, 3);
});

test('unparseable lines and unreadable files are counted, and what parsed is used', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', HARNESS, failure('two'));
  const two = join(sessionsDir(root), sessionFileName('two'));
  writeFileSync(two, readFileSync(two, 'utf8') + 'not json\n{"half":\n');
  writeFileSync(`${two}.gz`, 'not gzip');
  writeFileSync(join(sessionsDir(root), 'notes.txt'), 'not a session\n');
  mkdirSync(join(sessionsDir(root), 's-dir.jsonl'));
  const result = findRecurrences(root);
  assert.equal(result.sessionsRead, 3);
  assert.equal(result.sessionsUnreadable, 2);
  assert.equal(result.linesUnparseable, 2);
  assert.deepEqual(result.recurrences[0].sessions, ['one', 'two']);
});

test('one unreadable session is counted among the sessions read', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', HARNESS, failure('two'));
  log(root, 'three', HARNESS, failure('three'));
  writeFileSync(join(sessionsDir(root), `${sessionFileName('three')}.gz`), 'not gzip');
  const result = findRecurrences(root);
  assert.equal(result.sessionsRead, 3);
  assert.equal(result.sessionsUnreadable, 1);
  assert.equal(result.linesUnparseable, 0);
  assert.deepEqual(result.recurrences[0].sessions, ['one', 'three', 'two']);
});

test('a repository with no log has read nothing', () => {
  assert.deepEqual(findRecurrences(tempDir('hk-rec-repo-')), {
    recurrences: [],
    sessionsRead: 0,
    sessionsUnreadable: 0,
    sessionsBeingSealed: 0,
    sessionsOverLimit: [],
    linesUnparseable: 0,
    failuresUnattributed: 0,
  });
});

test('a session whose only file is a claimed or temporary one is listed and counted, not silently left out', () => {
  const root = tempDir('hk-rec-repo-');
  for (const id of ['one', 'two', 'three']) log(root, id, HARNESS, failure(id));
  const three = join(sessionsDir(root), sessionFileName('three'));
  renameSync(three, `${three}.sealing`);
  writeFileSync(join(sessionsDir(root), 's-four.jsonl.gz.tmp'), gzipSync('{"type":"Stop"}\n'));
  writeFileSync(join(sessionsDir(root), 's-two.jsonl.sealing'), '{"type":"Stop"}\n');

  assert.deepEqual(sessionIds(root), ['four', 'one', 'three', 'two']);
  assert.deepEqual(listSessions(root), [
    { id: 'four', sealed: false, unsealed: false, beingSealed: true },
    { id: 'one', sealed: false, unsealed: true, beingSealed: false },
    { id: 'three', sealed: false, unsealed: false, beingSealed: true },
    { id: 'two', sealed: false, unsealed: true, beingSealed: true },
  ]);
  const result = findRecurrences(root);
  assert.equal(result.sessionsRead, 4);
  assert.equal(result.sessionsBeingSealed, 3, 'each holds events this read did not see');
  assert.deepEqual(result.recurrences.map(r => r.sessions), [['one', 'two']]);
});

test('a session over the read limit is named, and counted as unreadable', () => {
  const root = tempDir('hk-rec-repo-');
  log(root, 'one', HARNESS, failure('one'));
  log(root, 'two', HARNESS, failure('two'));
  log(root, 'big', HARNESS, failure('big'), { type: 'Stop', pad: 'x'.repeat(4000) });
  process.env.KH_LOG_MAX_FILE_BYTES = '2000';
  try {
    const result = findRecurrences(root);
    assert.deepEqual(result.sessionsOverLimit, ['big']);
    assert.equal(result.sessionsUnreadable, 1);
    assert.deepEqual(result.recurrences.map(r => r.sessions), [['one', 'two']]);
  } finally {
    delete process.env.KH_LOG_MAX_FILE_BYTES;
  }
});

const ROOT = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
const POSIX_ROOT = ROOT.replace(/\\/g, '/');

test('normaliseError strips ANSI, numbers, repository paths and hex', () => {
  assert.equal(normaliseError('\u001b[31mError\u001b[0m: \u001b]8;;x\u0007boom\u001b]8;;\u0007', ROOT), 'Error: boom');
  assert.equal(normaliseError(`at ${POSIX_ROOT}/src/a.mjs:12:3`, ROOT), 'at src/a.mjs:#:#');
  assert.equal(normaliseError(`cwd ${POSIX_ROOT} failed`, ROOT), 'cwd . failed');
  assert.equal(normaliseError(`at ${POSIX_ROOT}-other/a.mjs`, ROOT), `at ${POSIX_ROOT}-other/a.mjs`);
  assert.equal(normaliseError('commit 3fa9c2d1e0 and id_77aa8b9c0d not found', ROOT), 'commit … and id_… not found');
  assert.equal(normaliseError('wrote 123 of 12345678 bytes', ROOT), 'wrote # of # bytes');
  assert.equal(normaliseError('deadbeef cafe', ROOT), '… cafe');
});

test('normaliseError matches a win32 root in either separator and any letter case', { skip: process.platform !== 'win32' }, () => {
  assert.equal(normaliseError('at C:\\work\\repo\\src\\a.mjs:12:3', ROOT), 'at src/a.mjs:#:#');
  assert.equal(normaliseError('at c:/WORK/Repo/a.mjs', ROOT), 'at a.mjs');
});

test('a failure as the logging hook records it has a signature', () => {
  const event = toLogEvent({
    hook_event_name: FAILURE_EVENT,
    session_id: 'one',
    tool_use_id: 'use-one',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    error: 'Error: tests failed\nmore',
  });
  assert.match(failureSignature(event, ROOT), /^[0-9a-f]{16}$/);
  assert.equal(failureSignature(event, ROOT), failureSignature(failure('one', { inputHash: event.inputHash }), ROOT));
});

test('failureSignature is null for anything but a failure', () => {
  const event = failure('one');
  assert.equal(failureSignature({ ...event, type: SUCCESS_EVENT }, ROOT), null);
  assert.equal(failureSignature({ ...event, tool: undefined }, ROOT), null);
  assert.equal(failureSignature({ ...event, firstErrorLine: 7 }, ROOT), null);
  assert.equal(failureSignature(null, ROOT), null);
  assert.notEqual(failureSignature(event, ROOT), failureSignature({ ...event, inputHash: 'input-two' }, ROOT));
  assert.notEqual(failureSignature(event, ROOT), failureSignature({ ...event, tool: 'Edit' }, ROOT));
  assert.equal(
    failureSignature({ ...event, firstErrorLine: `${POSIX_ROOT}/a.mjs:1` }, ROOT),
    failureSignature({ ...event, firstErrorLine: 'a.mjs:22' }, ROOT),
  );
});
