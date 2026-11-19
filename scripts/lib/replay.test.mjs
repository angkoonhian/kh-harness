// scripts/lib/replay.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`. Tool events are built by the
// logging hook's own `toLogEvent`, so the fields replayed are the fields the
// hook records.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvent, repoDataDir, sessionFileName } from '../../assets/scripts/harness-log.mjs';
import { toLogEvent } from '../../assets/scripts/session-log.mjs';
import { FAILURE_EVENT, findRecurrences, SUCCESS_EVENT } from './recurrence.mjs';
import { replayGate } from './replay.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-replay-data-');

const HARNESS = { type: 'harness', base: 'base-one', learned: 'learned-one', model: 'model-one' };

const MISTAKE = 'npm test --watch';
const FIX = 'npm test';
const WATCH_ERROR = 'Error: watch mode needs a terminal';

let useCounter = 0;

/** A tool event as the logging hook records it. */
function call(type, sessionId, toolName, toolInput, over = {}) {
  const outcome = type === FAILURE_EVENT ? { error: WATCH_ERROR } : { tool_response: 'done' };
  const event = toLogEvent({ hook_event_name: type, session_id: sessionId, tool_use_id: `use-${++useCounter}`, tool_name: toolName, tool_input: toolInput, ...outcome });
  return { ...event, ...over };
}

const bash = (type, sessionId, command, over) => call(type, sessionId, 'Bash', { command }, over);
const mistake = (sessionId, over) => bash(FAILURE_EVENT, sessionId, MISTAKE, over);
const success = (sessionId, command, over) => bash(SUCCESS_EVENT, sessionId, command, over);
const read = sessionId => call(SUCCESS_EVENT, sessionId, 'Read', { file_path: 'src/a.mjs' });

function log(root, sessionId, ...events) {
  for (const event of events) assert.deepEqual(appendEvent(root, sessionId, event), { written: true });
}

const gate = (kind, value, over = {}) => ({
  id: 'L1',
  tool: 'Bash',
  field: 'command',
  match: { kind, value },
  action: 'observe',
  message: 'Run the tests once; watch mode needs a terminal.',
  ...over,
});

const WATCH_GATE = gate('token', '--watch');

function theRecurrence(root) {
  const { recurrences } = findRecurrences(root);
  assert.equal(recurrences.length, 1);
  return recurrences[0];
}

/** Two sessions that hit the mistake, one fixed by the plain command and one
 * that moved on to another tool, and one clean session. */
function standardLog() {
  const root = tempDir('hk-replay-repo-');
  log(root, 'one', HARNESS, mistake('one'), success('one', FIX));
  log(root, 'two', HARNESS, mistake('two'), read('two'));
  log(root, 'three', HARNESS, success('three', 'npm run lint'), read('three'));
  return root;
}

test('a gate matching the mistakes and not the fixes passes', () => {
  const root = standardLog();
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'pass', result.reason);
  assert.deepEqual(result.differential, { firedOnMistakes: 2, mistakes: 2, firedOnSuccessors: 0 });
  assert.deepEqual(result.falsePositives, { fired: 0, callsChecked: 2, sessionsChecked: 1 });
  assert.equal(result.contentMissing, 0);
  assert.equal(result.sessionsUnreadable, 0);
  assert.equal(result.linesUnparseable, 0);
  assert.match(result.reason, /all 2 mistakes/);
  assert.match(result.reason, /none of 1 successful call/);
  assert.match(result.reason, /none of 2 calls in 1 session/);
});

test('a gate that also matches the fix fails and says so', () => {
  const root = standardLog();
  const result = replayGate(root, gate('literal', FIX), theRecurrence(root));
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.differential, { firedOnMistakes: 2, mistakes: 2, firedOnSuccessors: 1 });
  assert.match(result.reason, /differential check failed/);
  assert.match(result.reason, /fired on 1 of 1 successful call that followed the mistakes/);
  assert.doesNotMatch(result.reason, /false-positive check failed/);
  assert.ok(!result.reason.includes(FIX), 'the reason never quotes a tool input');
});

test('a gate that fires in an unrelated clean session fails with the count', () => {
  const root = standardLog();
  log(root, 'four', HARNESS, success('four', `${MISTAKE} --ci`), success('four', 'git status'), read('four'));
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.falsePositives, { fired: 1, callsChecked: 5, sessionsChecked: 2 });
  assert.equal(result.differential.firedOnSuccessors, 0);
  assert.match(result.reason, /false-positive check failed: the gate fired on 1 of 5 calls in 2 sessions/);
  assert.doesNotMatch(result.reason, /differential check failed/);
  assert.ok(!result.reason.includes('--watch'), 'the reason never quotes a tool input');
});

test('a gate that misses one mistake fails', () => {
  // The signature hashes the raw input, so mistakes under one signature are
  // recorded with different inputs only when the log was written
  // differently; each recorded call is still judged on what it holds.
  const root = tempDir('hk-replay-repo-');
  log(root, 'one', HARNESS, mistake('one'), success('one', FIX));
  log(root, 'two', HARNESS, mistake('two', { input: { command: 'npm test -w' } }));
  log(root, 'three', HARNESS, read('three'));
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.differential, { firedOnMistakes: 1, mistakes: 2, firedOnSuccessors: 0 });
  assert.match(result.reason, /differential check failed: the gate fired on 1 of 2 replayable mistakes/);
});

test('a gate for another tool fires on no mistake and fails', () => {
  const root = standardLog();
  const result = replayGate(root, gate('token', '--watch', { tool: 'Shell' }), theRecurrence(root));
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.differential, { firedOnMistakes: 0, mistakes: 2, firedOnSuccessors: 0 });
});

const expired = event => {
  const { input: _input, output: _output, ...rest } = event;
  return { ...rest, contentExpired: true };
};

test('expired content yields not-checkable, never pass', () => {
  const root = tempDir('hk-replay-repo-');
  log(root, 'one', HARNESS, expired(mistake('one')), success('one', FIX));
  log(root, 'two', HARNESS, expired(mistake('two')));
  log(root, 'three', HARNESS, read('three'));
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'not-checkable');
  assert.deepEqual(result.differential, { firedOnMistakes: 0, mistakes: 2, firedOnSuccessors: 0 });
  assert.equal(result.contentMissing, 2);
  assert.match(result.reason, /no recorded mistake could be replayed/);
});

test('mistakes that fired are not enough when others could not be replayed', () => {
  const root = tempDir('hk-replay-repo-');
  log(root, 'one', HARNESS, mistake('one'), success('one', FIX));
  log(root, 'two', HARNESS, expired(mistake('two')));
  log(root, 'three', HARNESS, read('three'));
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'not-checkable');
  assert.deepEqual(result.differential, { firedOnMistakes: 1, mistakes: 2, firedOnSuccessors: 0 });
  assert.equal(result.contentMissing, 1);
  assert.match(result.reason, /1 of 2 mistakes could not be replayed/);
});

test('a successor whose content is gone makes the differential not checkable', () => {
  const root = tempDir('hk-replay-repo-');
  log(root, 'one', HARNESS, mistake('one'), expired(success('one', FIX)));
  log(root, 'two', HARNESS, mistake('two'));
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'not-checkable');
  assert.equal(result.contentMissing, 1);
  assert.match(result.reason, /1 of 1 successful call that followed the mistakes could not be replayed/);
});

test('a field moved to a blob over the inline cap is content missing', () => {
  const root = tempDir('hk-replay-repo-');
  const blobbed = { command: { blob: 'a'.repeat(64), bytes: 70000, truncated: true } };
  log(root, 'one', HARNESS, mistake('one', { input: blobbed }), success('one', FIX));
  log(root, 'two', HARNESS, mistake('two', { input: blobbed }));
  log(root, 'three', HARNESS, success('three', 'ls', { input: blobbed }), read('three'));
  const nested = replayGate(root, gate('literal', 'aaaa', { field: 'command.blob' }), theRecurrence(root));
  assert.equal(nested.verdict, 'not-checkable');
  assert.equal(nested.differential.firedOnMistakes, 0);
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'not-checkable');
  assert.equal(result.contentMissing, 3);
  assert.deepEqual(result.falsePositives, { fired: 0, callsChecked: 1, sessionsChecked: 1 });
});

test('the result states how many calls and sessions were checked', () => {
  const root = standardLog();
  // Not tool calls: never checked.
  log(root, 'four', HARNESS, call('PreToolUse', 'four', 'Bash', { command: 'ls' }), { type: 'UserPromptSubmit', prompt: 'hi' });
  // A call of the gate's tool with no content is not checked; one of another
  // tool is decided by its name.
  log(root, 'five', HARNESS, expired(success('five', 'ls')), expired(read('five')));
  // A session holding the signature outside the recurrence is neither.
  log(root, 'six', { ...HARNESS, model: 'model-two' }, mistake('six'), success('six', 'ls'));
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'pass', result.reason);
  assert.deepEqual(result.falsePositives, { fired: 0, callsChecked: 3, sessionsChecked: 2 });
  assert.equal(result.contentMissing, 1);
  assert.match(result.reason, /none of 3 calls in 2 sessions/);
});

test('an unreadable session in the recurrence makes the verdict not-checkable', () => {
  const root = standardLog();
  const sessions = join(repoDataDir(root), 'sessions');
  writeFileSync(join(sessions, `${sessionFileName('two')}.gz`), 'not gzip');
  const three = join(sessions, sessionFileName('three'));
  writeFileSync(three, readFileSync(three, 'utf8') + 'not json\n');
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'not-checkable');
  assert.deepEqual(result.differential, { firedOnMistakes: 2, mistakes: 2, firedOnSuccessors: 0 });
  assert.equal(result.sessionsUnreadable, 1);
  assert.equal(result.linesUnparseable, 1);
  assert.match(result.reason, /1 of the recurrence's 2 sessions could not be read in full/);
  assert.match(result.reason, /1 session could not be read in full and 1 line could not be parsed/);
});

test('a recurrence session that no longer holds the mistake makes the verdict not-checkable', () => {
  const root = standardLog();
  const recurrence = theRecurrence(root);
  rmSync(join(repoDataDir(root), 'sessions', sessionFileName('two')));
  const result = replayGate(root, WATCH_GATE, recurrence);
  assert.equal(result.verdict, 'not-checkable');
  assert.equal(result.differential.mistakes, 1);
  assert.match(result.reason, /1 of the recurrence's 2 sessions no longer holds a failure with its signature/);
});

test('a replayed input holding the scrub mark is named as a limit', () => {
  const root = tempDir('hk-replay-repo-');
  const scrubbed = { input: { command: 'npm test --watch --token ***' } };
  log(root, 'one', HARNESS, mistake('one', scrubbed), success('one', FIX));
  log(root, 'two', HARNESS, mistake('two', scrubbed));
  log(root, 'three', HARNESS, read('three'));
  const result = replayGate(root, WATCH_GATE, theRecurrence(root));
  assert.equal(result.verdict, 'pass', result.reason);
  assert.match(result.reason, /2 replayed inputs hold \*\*\*, where the log's scrub hid a value; the gate was replayed against the scrubbed text/);
  assert.doesNotMatch(replayGate(standardLog(), WATCH_GATE, theRecurrence(standardLog())).reason, /scrub/);
});

test('a gate that is not well formed is not replayed', () => {
  const root = standardLog();
  const result = replayGate(root, { ...WATCH_GATE, match: { kind: 'regex', value: '--watch' } }, theRecurrence(root));
  assert.equal(result.verdict, 'fail');
  assert.equal(result.reason, 'the gate was not replayed: match.kind must be literal, token or glob');
  assert.deepEqual(result.differential, { firedOnMistakes: 0, mistakes: 0, firedOnSuccessors: 0 });
  assert.deepEqual(result.falsePositives, { fired: 0, callsChecked: 0, sessionsChecked: 0 });
});

test('a fix shared by two mistakes is one successor', () => {
  const root = tempDir('hk-replay-repo-');
  log(root, 'one', HARNESS, mistake('one'), mistake('one'), success('one', FIX), success('one', FIX));
  log(root, 'two', HARNESS, mistake('two'));
  const result = replayGate(root, gate('literal', FIX), theRecurrence(root));
  assert.deepEqual(result.differential, { firedOnMistakes: 3, mistakes: 3, firedOnSuccessors: 1 });
});
