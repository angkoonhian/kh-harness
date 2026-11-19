// scripts/lib/learn-lib.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`. Tool events are built by the
// logging hook's own `toLogEvent`, so the fields replayed are the fields the
// hook records.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { appendEvent, GATES_PATH, LOCAL_GATES_FILE, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { toLogEvent } from '../../assets/scripts/session-log.mjs';
import { FAILURES_PATH } from './failures-evidence.mjs';
import { draftLearning, learningStats, listLearnings, runTrial } from './learn-lib.mjs';
import { appendLedger, readLedger, verifyLedger } from './ledger.mjs';
import { FAILURE_EVENT, findRecurrences, SUCCESS_EVENT } from './recurrence.mjs';
import { MIN_CLEAN_CALLS, MIN_CLEAN_SESSIONS } from './replay.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-learn-data-');

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** A repository with one commit, holding `files` (path to text). */
function repo(files = {}) {
  const d = tempDir('hk-learn-repo-');
  execFileSync('git', ['init', '-q', d]);
  writeFileSync(join(d, 'README.md'), '# app\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(d, path, '..'), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

const HARNESS = { type: 'harness', base: 'base-one', learned: 'learned-one', model: 'model-one' };

const MISTAKE = 'npm test --watch';
const FIX = 'npm test';
const WATCH_ERROR = 'Error: watch mode needs a terminal';

let useCounter = 0;

/** A tool event as the logging hook records it. */
function call(type, sessionId, toolName, toolInput, toolUseId = `use-${++useCounter}`) {
  const outcome = type === FAILURE_EVENT ? { error: WATCH_ERROR } : { tool_response: 'done' };
  return toLogEvent({ hook_event_name: type, session_id: sessionId, tool_use_id: toolUseId, tool_name: toolName, tool_input: toolInput, ...outcome });
}

const mistake = (sessionId, toolUseId) => call(FAILURE_EVENT, sessionId, 'Bash', { command: MISTAKE }, toolUseId);
const success = (sessionId, command, toolUseId) => call(SUCCESS_EVENT, sessionId, 'Bash', { command }, toolUseId);
const read = sessionId => call(SUCCESS_EVENT, sessionId, 'Read', { file_path: 'src/a.mjs' });

function log(root, sessionId, ...events) {
  for (const event of events) assert.deepEqual(appendEvent(root, sessionId, event), { written: true });
}

/** Two sessions that hit the mistake, one fixed by the plain command. */
function logMistakes(root) {
  log(root, 'one', HARNESS, mistake('one'), success('one', FIX));
  log(root, 'two', HARNESS, mistake('two'), read('two'));
}

/** Just enough clean history for a replay to pass. */
function logClean(root) {
  const ids = Array.from({ length: MIN_CLEAN_SESSIONS }, (_, i) => `clean-${i}`);
  const perSession = Math.ceil(MIN_CLEAN_CALLS / ids.length);
  for (const id of ids) log(root, id, HARNESS, ...Array.from({ length: perSession }, (_, i) => success(id, `npm run task-${i}`)));
}

function theSignature(root) {
  const { recurrences } = findRecurrences(root);
  assert.equal(recurrences.length, 1);
  return recurrences[0].signature;
}

const WATCH_GATE = { tool: 'Bash', field: 'command', match: { kind: 'token', value: '--watch' }, message: 'Run the tests once; watch mode needs a terminal.' };

const draftFor = (root, over = {}) => ({
  signature: theSignature(root),
  title: 'Tests run once, never in watch mode',
  why: 'Watch mode waits for a terminal that an agent session does not have.',
  gate: WATCH_GATE,
  ...over,
});

/** A repository whose log holds the mistakes and, unless `clean` is false,
 * enough clean history for a pass. */
function loggedRepo({ clean = true, files } = {}) {
  const root = repo(files);
  logMistakes(root);
  if (clean) logClean(root);
  return root;
}

const localGatesPath = root => join(repoDataDir(root), LOCAL_GATES_FILE);
const localGates = root => JSON.parse(readFileSync(localGatesPath(root), 'utf8'));
const kinds = root => readLedger(root).map(e => `${e.learningId}:${e.kind}`);

function drafted(root, over) {
  const result = draftLearning(root, draftFor(root, over));
  assert.ok(result.learning, result.error);
  return result.learning;
}

test('a draft for an unknown signature is refused', () => {
  const root = loggedRepo();
  const result = draftLearning(root, draftFor(root, { signature: '0123456789abcdef' }));
  assert.deepEqual(result, { error: 'signature: not the signature of a current recurrence' });
  assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
  assert.deepEqual(readLedger(root), []);
});

test('a draft is validated in full before anything is stored, and an error never quotes the draft', () => {
  const root = loggedRepo();
  const secretish = 'zzqq-value-zzqq';
  const cases = [
    [{ signature: 42 }, 'signature: must be 16 lowercase hex characters'],
    [{ title: `two\n${secretish}` }, 'title: must be a single line'],
    [{ title: '  ​ ' }, 'title: must not be empty'],
    [{ title: secretish.repeat(9) }, 'title: must be at most 120 characters'],
    [{ why: 7 }, 'why: must be a string'],
    [{ why: secretish.repeat(21) }, 'why: must be at most 300 characters'],
    [{ gate: { ...WATCH_GATE, id: 'L5' } }, 'gate: must not carry id or action; both are assigned'],
    [{ gate: { ...WATCH_GATE, action: 'block' } }, 'gate: must not carry id or action; both are assigned'],
    [{ gate: { ...WATCH_GATE, match: { kind: 'regex', value: secretish } } }, 'gate: match.kind must be literal, token or glob'],
    [{ gate: { ...WATCH_GATE, tool: 'Shell' } }, "gate: tool must be the recurrence's tool"],
    [{ gate: [secretish] }, 'gate: must be an object'],
    [{ extra: secretish }, 'draft: may have only the keys signature, title, why and gate'],
  ];
  for (const [over, error] of cases) {
    const result = draftLearning(root, draftFor(root, over));
    assert.deepEqual(result, { error }, JSON.stringify(over));
    assert.ok(!result.error.includes(secretish));
  }
  assert.deepEqual(draftLearning(root, null), { error: 'draft: must be an object' });
  assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
  assert.deepEqual(readLedger(root), []);
});

test('a draft is stored as a candidate with its evidence and recorded as proposed', () => {
  const root = loggedRepo();
  const signature = theSignature(root);
  mkdirSync(join(root, 'docs/harness'), { recursive: true });
  writeFileSync(join(root, FAILURES_PATH), `## F1 — watch mode\n- signatures: ${signature}\n`);
  const learning = drafted(root);
  const { recurrences: [recurrence] } = findRecurrences(root);
  const gate = { ...WATCH_GATE, id: 'L1', action: 'observe' };
  assert.deepEqual(learning, {
    id: 'L1',
    signature,
    failureId: 'F1',
    title: 'Tests run once, never in watch mode',
    why: 'Watch mode waits for a terminal that an agent session does not have.',
    gate,
    sha256: gateSha256(gate),
    status: 'candidate',
    external: false,
    evidence: { signature, sessions: 2, firstTs: recurrence.firstTs, lastTs: recurrence.lastTs, external: false },
    harness: { base: 'base-one', model: 'model-one' },
    replay: null,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(repoDataDir(root), 'learnings', 'L1.json'), 'utf8')), learning);
  const [entry] = readLedger(root);
  assert.equal(entry.kind, 'proposed');
  assert.equal(entry.learningId, 'L1');
  assert.equal(entry.contentSha256, learning.sha256);
  assert.deepEqual(entry.evidence, learning.evidence);
  assert.equal(entry.approvedBy, null);
  assert.deepEqual(listLearnings(root), { learnings: [learning], orphanGates: [], unreadable: [] });
});

test('a title and why are stripped of what cannot be seen and masked before they are stored', () => {
  const root = loggedRepo();
  const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('');
  const learning = drafted(root, { title: `Never​ paste ${token}`, why: `The ‮agent pasted ${token} into a command.` });
  assert.equal(learning.title, 'Never paste ***');
  assert.equal(learning.why, 'The agent pasted *** into a command.');
  assert.ok(!readFileSync(join(repoDataDir(root), 'learnings', 'L1.json'), 'utf8').includes(token));
});

test('a learning from a recurrence with outside content is marked external', () => {
  const root = repo();
  logMistakes(root);
  log(root, 'one', { type: 'external_content', session_id: 'one', tool: 'WebFetch' });
  const learning = drafted(root);
  assert.equal(learning.external, true);
  assert.equal(learning.evidence.external, true);
});

test('a second draft for a signature is refused while the first is live', () => {
  const root = loggedRepo();
  drafted(root);
  assert.deepEqual(draftLearning(root, draftFor(root)), { error: 'signature: learning L1 already covers this signature' });
  assert.deepEqual(kinds(root), ['L1:proposed']);
});

test('a passing draft becomes an observe gate in the local set and nothing in the repository changes', () => {
  const root = loggedRepo();
  const before = git(root, 'status', '--porcelain', '--untracked-files=all');
  const learning = drafted(root);
  const result = runTrial(root, learning.id);
  assert.equal(result.replay.verdict, 'pass', result.replay.reason);
  assert.equal(result.status, 'trial');
  assert.deepEqual(result.repairedGates, []);
  assert.deepEqual(localGates(root), { schema: 1, gates: [{ ...WATCH_GATE, id: 'L1', action: 'observe' }] });
  const [stored] = listLearnings(root).learnings;
  assert.equal(stored.status, 'trial');
  assert.deepEqual(stored.replay, result.replay);
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);
  const replayed = readLedger(root)[1];
  assert.equal(replayed.detail, `pass: ${result.replay.reason}`);
  const trial = readLedger(root)[2];
  assert.notEqual(trial.learned, replayed.learned, 'the trial entry names the learned set with the new gate in it');
  assert.equal(verifyLedger(root).intact, true);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), before);
});

test('a failing draft is recorded as rejected and writes no gate', () => {
  const root = loggedRepo();
  const learning = drafted(root, { gate: { ...WATCH_GATE, match: { kind: 'literal', value: FIX } } });
  const result = runTrial(root, learning.id);
  assert.equal(result.replay.verdict, 'fail');
  assert.equal(result.status, 'rejected');
  assert.equal(existsSync(localGatesPath(root)), false);
  assert.equal(listLearnings(root).learnings[0].status, 'rejected');
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:rejected']);
  assert.deepEqual(runTrial(root, learning.id), { error: 'L1 is rejected; only a candidate is replayed' });
});

test('a not-checkable draft stays a candidate and writes no gate', () => {
  const root = loggedRepo({ clean: false });
  const learning = drafted(root);
  const result = runTrial(root, learning.id);
  assert.equal(result.replay.verdict, 'not-checkable');
  assert.equal(result.status, 'candidate');
  assert.equal(existsSync(localGatesPath(root)), false);
  assert.deepEqual(listLearnings(root).learnings[0].replay, result.replay);
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed']);
  assert.equal(readLedger(root)[1].detail, `not-checkable: ${result.replay.reason}`);
});

test('a not-checkable candidate can be replayed again and then passes', () => {
  const root = loggedRepo({ clean: false });
  const learning = drafted(root);
  assert.equal(runTrial(root, learning.id).status, 'candidate');
  logClean(root);
  const again = runTrial(root, learning.id);
  assert.equal(again.replay.verdict, 'pass', again.replay.reason);
  assert.equal(again.status, 'trial');
  assert.deepEqual(localGates(root).gates.map(g => g.id), ['L1']);
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:replayed', 'L1:trial']);
});

test('a candidate that is already on trial is not replayed again', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  runTrial(root, learning.id);
  assert.deepEqual(runTrial(root, learning.id), { error: 'L1 is trial; only a candidate is replayed' });
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);
});

test('an id that is malformed or names no learning is refused', () => {
  const root = loggedRepo();
  for (const id of ['../L1', 'L0', 'l1', 42]) {
    assert.deepEqual(runTrial(root, id), { error: 'id: must be L followed by 1 to 9 digits, without a leading zero' });
    assert.deepEqual(learningStats(root, id), { error: 'id: must be L followed by 1 to 9 digits, without a leading zero' });
  }
  assert.deepEqual(runTrial(root, 'L9'), { error: 'L9: no such learning' });
  assert.deepEqual(learningStats(root, 'L9'), { error: 'L9: no such learning' });
});

test('ids are never reused after a rejection', () => {
  const root = loggedRepo();
  const first = drafted(root, { gate: { ...WATCH_GATE, match: { kind: 'literal', value: FIX } } });
  assert.equal(runTrial(root, first.id).status, 'rejected');
  const second = drafted(root);
  assert.equal(second.id, 'L2');
  rmSync(join(repoDataDir(root), 'learnings', 'L2.json'));
  rmSync(join(repoDataDir(root), 'learnings', 'L1.json'));
  assert.equal(drafted(root).id, 'L3', 'a removed learning keeps its number');
});

test('ids start above the highest id in the committed gate file', () => {
  const committed = { schema: 1, gates: [{ ...WATCH_GATE, id: 'L7', action: 'warn' }, { id: 'L3', suspended: true }] };
  const root = loggedRepo({ files: { [GATES_PATH]: JSON.stringify(committed) } });
  assert.equal(drafted(root).id, 'L8');
});

test('a committed gate file that cannot be read assigns no id', () => {
  const root = loggedRepo({ files: { [GATES_PATH]: '{ not json' } });
  assert.deepEqual(draftLearning(root, draftFor(root)), { error: 'the committed gate file cannot be read, so no id that avoids its ids can be assigned' });
  assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
});

test('a gate left in the local set without its learning on trial is reported and repaired', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  // A write of the gate that outlived the step after it.
  const suspension = { id: 'L40', suspended: true };
  const stray = { ...WATCH_GATE, id: 'L41', action: 'observe' };
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(localGatesPath(root), JSON.stringify({ schema: 1, gates: [suspension, { ...learning.gate }, stray] }));
  assert.deepEqual(listLearnings(root).orphanGates, ['L1', 'L41']);

  const result = runTrial(root, learning.id);
  assert.deepEqual(result.repairedGates, ['L1', 'L41']);
  assert.equal(result.status, 'trial');
  assert.deepEqual(localGates(root).gates, [suspension, learning.gate]);
  assert.deepEqual(listLearnings(root).orphanGates, []);
});

test('a local gate file that is not a gate file is never overwritten', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(localGatesPath(root), '[1, 2');
  assert.deepEqual(runTrial(root, learning.id), { error: 'the local gate file is not a gate file; nothing was written' });
  assert.equal(readFileSync(localGatesPath(root), 'utf8'), '[1, 2');
  assert.equal(listLearnings(root).learnings[0].status, 'candidate');
  assert.equal(listLearnings(root).orphanGates, null, 'an unreadable local gate file is not reported as holding no orphan');
  assert.deepEqual(kinds(root), ['L1:proposed']);
});

test('a learning file that does not read back as a learning is reported, not used', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  const path = join(repoDataDir(root), 'learnings', 'L1.json');
  writeFileSync(path, JSON.stringify({ ...learning, gate: { ...learning.gate, match: { kind: 'literal', value: 'npm' } } }));
  assert.deepEqual(listLearnings(root), { learnings: [], orphanGates: [], unreadable: ['L1'] });
  assert.deepEqual(runTrial(root, 'L1'), { error: 'L1: the learning file does not read back as a learning' });
});

function logFiring(root, sessionId, gate, toolUseId, over = {}) {
  log(root, sessionId, { type: 'gate_firing', gateId: gate.id, gateSha256: gateSha256(gate), action: gate.action, tool: gate.tool, tool_use_id: toolUseId, session_id: sessionId, ...over });
}

test('stats count firings across sessions', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  runTrial(root, learning.id);
  const { gate } = learning;
  // Fired, the call itself failed, and the next Bash call succeeded.
  logFiring(root, 'later-a', gate, 'a-1');
  log(root, 'later-a', mistake('later-a', 'a-1'), read('later-a'), success('later-a', FIX));
  // Fired twice; after the second, the next Bash call failed again.
  logFiring(root, 'later-b', gate, 'b-1');
  log(root, 'later-b', mistake('later-b', 'b-1'));
  logFiring(root, 'later-b', gate, 'b-2');
  log(root, 'later-b', mistake('later-b', 'b-2'), mistake('later-b'));
  // Neither another gate's firing nor a firing of other content counts.
  logFiring(root, 'later-c', { ...gate, id: 'L99' }, 'c-1');
  logFiring(root, 'later-c', gate, 'c-2', { gateSha256: '0'.repeat(64) });

  const evidence = learning.evidence;
  appendLedger(root, { kind: 'wrong', learningId: 'L1', contentSha256: learning.sha256, evidence, base: 'b', learned: 'l', approvedBy: 'owner' });
  appendLedger(root, { kind: 'wrong', learningId: 'L2', contentSha256: learning.sha256, evidence, base: 'b', learned: 'l', approvedBy: 'owner' });
  assert.deepEqual(learningStats(root, 'L1'), { firings: 3, sessions: 2, rerouted: 1, wrong: 1, sessionsUnreadable: 0 });
});

/** Every file under `dir` outside `.git`, with its modification time. */
function mtimes(dir) {
  const out = {};
  const walk = d => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') walk(path);
      } else {
        out[relative(dir, path)] = statSync(path).mtimeMs;
      }
    }
  };
  walk(dir);
  return out;
}

test('nothing in this module writes inside the repository', () => {
  const root = loggedRepo({ files: { [GATES_PATH]: JSON.stringify({ schema: 1, gates: [] }), [FAILURES_PATH]: '# Failures\n' } });
  const status = git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored');
  const before = mtimes(root);
  const passing = drafted(root);
  runTrial(root, passing.id);
  const failing = draftLearning(root, draftFor(root));
  assert.ok(failing.error);
  listLearnings(root);
  learningStats(root, passing.id);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored'), status);
  assert.deepEqual(mtimes(root), before);
});
