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
import { appendEvent, GATES_PATH, harnessIdentity, LOCAL_GATES_FILE, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { toLogEvent } from '../../assets/scripts/session-log.mjs';
import { FAILURES_PATH } from './failures-evidence.mjs';
import { draftLearning, gateActionsFor, learningStats, listLearnings, recordedStatus, runTrial } from './learn-lib.mjs';
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

/** A second recurrence, of the Read tool, in two more sessions. */
function logReadMistakes(root) {
  for (const id of ['three', 'four']) log(root, id, HARNESS, call(FAILURE_EVENT, id, 'Read', { file_path: 'missing.txt' }));
}

function signatureOf(root, tool = 'Bash') {
  const found = findRecurrences(root).recurrences.filter(r => r.tool === tool);
  assert.equal(found.length, 1);
  return found[0].signature;
}

const WATCH_GATE = { tool: 'Bash', field: 'command', match: { kind: 'token', value: '--watch' }, message: 'Run the tests once; watch mode needs a terminal.' };
const FIX_GATE = { ...WATCH_GATE, match: { kind: 'literal', value: FIX } };
const READ_GATE = { tool: 'Read', field: 'file_path', match: { kind: 'literal', value: 'missing.txt' }, message: 'That file does not exist.' };

const draftFor = (root, over = {}) => ({
  signature: signatureOf(root, (over.gate ?? WATCH_GATE).tool),
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

const learningFile = (root, id) => join(repoDataDir(root), 'learnings', `${id}.json`);
const localGatesPath = root => join(repoDataDir(root), LOCAL_GATES_FILE);
const localGates = root => JSON.parse(readFileSync(localGatesPath(root), 'utf8'));
const writeLocalGates = (root, gates) => {
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(localGatesPath(root), JSON.stringify({ schema: 1, gates }));
};
const kinds = root => readLedger(root).map(e => `${e.learningId}:${e.kind}`);

function drafted(root, over) {
  const result = draftLearning(root, draftFor(root, over));
  assert.ok(result.learning, result.error);
  return result.learning;
}

/** Holds the lock file at `path` as a live writer other than this one. */
function holdLock(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'another-writer' }));
  return () => rmSync(path, { force: true });
}

test('a learning gate carries observe only while it is a candidate, rejected or on trial', () => {
  for (const status of ['candidate', 'rejected', 'trial']) assert.deepEqual(gateActionsFor(status), ['observe']);
  for (const status of ['active-local', 'landed', 'suspended', 'retired', 'unknown']) assert.deepEqual(gateActionsFor(status), []);
});

test('the recorded status is the last status-changing ledger entry for that id and content', () => {
  const sha = 'a'.repeat(64);
  const entry = (kind, over = {}) => ({ kind, learningId: 'L1', contentSha256: sha, ...over });
  assert.equal(recordedStatus([], 'L1', sha), null);
  assert.equal(recordedStatus([entry('proposed')], 'L1', sha), 'candidate');
  assert.equal(recordedStatus([entry('proposed'), entry('replayed'), entry('trial'), entry('wrong')], 'L1', sha), 'trial');
  assert.equal(recordedStatus([entry('proposed'), entry('rejected', { contentSha256: 'b'.repeat(64) })], 'L1', sha), 'candidate');
  assert.equal(recordedStatus([entry('rejected', { learningId: 'L2' })], 'L1', sha), null);
});

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
  const credential = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('');
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
    [{ gate: { ...WATCH_GATE, message: `Never paste ${credential}.` } }, 'gate: message must not contain a credential'],
    [{ gate: { ...WATCH_GATE, match: { kind: 'literal', value: ['--tok', 'en=', secretish].join('') } } }, 'gate: match.value must not contain a credential'],
    [{ gate: { ...WATCH_GATE, match: { kind: 'literal', value: `--wa​tch` } } }, 'gate: match.value must not contain control or invisible characters'],
    [{ gate: { ...WATCH_GATE, field: credential } }, 'gate: field must not contain a credential'],
    [{ gate: { ...WATCH_GATE, tool: `Ba​sh` } }, 'gate: tool must not contain control or invisible characters'],
    [{ gate: { ...WATCH_GATE, cites: [`docs/${credential}.md`] } }, 'gate: cites must not contain a credential'],
    [{ extra: secretish }, 'draft: may have only the keys signature, title, why and gate'],
  ];
  for (const [over, error] of cases) {
    const result = draftLearning(root, { ...draftFor(root), ...over });
    assert.deepEqual(result, { error }, JSON.stringify(over));
    assert.ok(!result.error.includes(secretish) && !result.error.includes(credential));
  }
  assert.deepEqual(draftLearning(root, null), { error: 'draft: must be an object' });
  assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
  assert.deepEqual(readLedger(root), []);
});

test('a draft is stored as a candidate with its evidence and recorded as proposed', () => {
  const root = loggedRepo();
  const signature = signatureOf(root);
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
  assert.deepEqual(JSON.parse(readFileSync(learningFile(root, 'L1'), 'utf8')), learning);
  const [entry] = readLedger(root);
  assert.equal(entry.kind, 'proposed');
  assert.equal(entry.learningId, 'L1');
  assert.equal(entry.contentSha256, learning.sha256);
  assert.deepEqual(entry.evidence, learning.evidence);
  assert.equal(entry.approvedBy, null);
  assert.deepEqual(listLearnings(root), { learnings: [learning], gatesToRepair: [], ledgerMismatch: [], ledgerIntact: true, unreadable: [] });
});

test('a title and why are stripped of what cannot be seen and masked before they are stored', () => {
  const root = loggedRepo();
  const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('');
  const learning = drafted(root, { title: `Never​ paste ${token}`, why: `The ‮agent pasted ${token} into a command.` });
  assert.equal(learning.title, 'Never paste ***');
  assert.equal(learning.why, 'The agent pasted *** into a command.');
  assert.ok(!readFileSync(learningFile(root, 'L1'), 'utf8').includes(token));
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
  const identityBefore = harnessIdentity(root);
  const result = runTrial(root, learning.id);
  assert.equal(result.replay.verdict, 'pass', result.replay.reason);
  assert.equal(result.status, 'trial');
  assert.deepEqual(result.repairedGates, []);
  assert.deepEqual(localGates(root), { schema: 1, gates: [{ ...WATCH_GATE, id: 'L1', action: 'observe' }] });
  const [stored] = listLearnings(root).learnings;
  assert.equal(stored.status, 'trial');
  assert.deepEqual(stored.replay, result.replay);
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);
  const [, replayed, trial] = readLedger(root);
  assert.equal(replayed.detail, `pass: ${result.replay.reason}`);
  assert.equal(replayed.learned, identityBefore.learned, 'written before the gate, the entries name the set without it');
  assert.equal(trial.learned, identityBefore.learned);
  assert.notEqual(harnessIdentity(root).learned, identityBefore.learned);
  assert.equal(verifyLedger(root).intact, true);
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), before);
});

test('a failing draft is recorded as rejected and writes no gate', () => {
  const root = loggedRepo();
  const learning = drafted(root, { gate: FIX_GATE });
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

test('a learning file edited to another action does not read back, and its gate never goes live', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  for (const action of ['block', 'warn']) {
    writeFileSync(learningFile(root, 'L1'), JSON.stringify({ ...learning, gate: { ...learning.gate, action } }));
    assert.deepEqual(listLearnings(root), { learnings: [], gatesToRepair: [], ledgerMismatch: [], ledgerIntact: true, unreadable: ['L1'] });
    assert.deepEqual(runTrial(root, 'L1'), { error: 'L1: the learning file does not read back as a learning' });
    assert.deepEqual(learningStats(root, 'L1'), { error: 'L1: the learning file does not read back as a learning' });
  }
  assert.equal(existsSync(localGatesPath(root)), false);
  assert.deepEqual(kinds(root), ['L1:proposed']);
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
  const first = drafted(root, { gate: FIX_GATE });
  assert.equal(runTrial(root, first.id).status, 'rejected');
  assert.equal(drafted(root).id, 'L2');
  rmSync(learningFile(root, 'L2'));
  rmSync(learningFile(root, 'L1'));
  assert.equal(drafted(root).id, 'L3', 'a removed learning keeps its number');
  rmSync(learningFile(root, 'L3'));
  rmSync(join(repoDataDir(root), 'learning-ids.json'));
  assert.equal(drafted(root).id, 'L4', 'the ledger keeps the number when the counter is lost');
});

test('ids start above the highest id in the committed gate file', () => {
  const committed = { schema: 1, gates: [{ ...WATCH_GATE, id: 'L7', action: 'warn' }, { id: 'L3', suspended: true }] };
  const root = loggedRepo({ files: { [GATES_PATH]: JSON.stringify(committed) } });
  assert.equal(drafted(root).id, 'L8');
});

test('a committed gate file that exists and cannot be read assigns no id', () => {
  const error = { error: 'the committed gate file cannot be read, so no id that avoids its ids can be assigned' };
  const notJson = loggedRepo({ files: { [GATES_PATH]: '{ not json' } });
  assert.deepEqual(draftLearning(notJson, draftFor(notJson)), error);
  const directory = loggedRepo({ files: { [`${GATES_PATH}/keep`]: 'x' } });
  assert.deepEqual(draftLearning(directory, draftFor(directory)), error);
  for (const root of [notJson, directory]) {
    assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
    assert.deepEqual(readLedger(root), []);
  }
});

test('a gate left in the local set without its learning on trial is reported and repaired', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  // A gate the step after its write never reached, beside one with no
  // learning at all.
  const suspension = { id: 'L40', suspended: true };
  const stray = { ...WATCH_GATE, id: 'L41', action: 'observe' };
  writeLocalGates(root, [suspension, { ...learning.gate }, stray]);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1', 'L41']);

  const result = runTrial(root, learning.id);
  assert.deepEqual(result.repairedGates, ['L1', 'L41']);
  assert.equal(result.status, 'trial');
  assert.deepEqual(localGates(root).gates, [suspension, learning.gate]);
  assert.deepEqual(listLearnings(root).gatesToRepair, []);
});

test('a local gate whose action, content or id disagrees with its trial learning is replaced by the learning\'s own', () => {
  const root = loggedRepo();
  logReadMistakes(root);
  const trial = drafted(root);
  assert.equal(runTrial(root, trial.id).status, 'trial');
  const { gate } = trial;
  writeLocalGates(root, [{ ...gate, action: 'block' }, { ...gate, match: { kind: 'literal', value: 'npm' } }, gate, gate]);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1']);
  const other = drafted(root, { gate: READ_GATE });
  assert.deepEqual(runTrial(root, other.id).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates.filter(g => g.id === 'L1'), [gate]);

  writeLocalGates(root, []);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1'], 'a trial learning with no gate in the set');
});

test('a learning whose status disagrees with its last ledger entry is reported', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  // As a step leaves it when it stops after its ledger entry.
  appendLedger(root, { kind: 'trial', learningId: 'L1', contentSha256: learning.sha256, evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: null });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1']);
  appendLedger(root, { kind: 'wrong', learningId: 'L1', contentSha256: learning.sha256, evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: 'owner' });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1'], 'a kind that changes no status is not the last word');
  writeFileSync(learningFile(root, 'L1'), JSON.stringify({ ...learning, status: 'trial' }));
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
  rmSync(learningFile(root, 'L1'));
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1'], 'a ledger entry with no learning file');
});

/** A rejected L1 for the Bash recurrence and a candidate L2 for the Read
 * one, whose replay runs the repair. */
function rejectedAndCandidate() {
  const root = loggedRepo();
  logReadMistakes(root);
  const rejected = drafted(root, { gate: FIX_GATE });
  assert.equal(runTrial(root, rejected.id).status, 'rejected');
  const candidate = drafted(root, { gate: READ_GATE });
  return { root, rejected, candidate };
}

/** A Bash learning L1 on trial and a Read candidate L2, whose replay runs
 * the repair. */
function trialAndCandidate() {
  const root = loggedRepo();
  logReadMistakes(root);
  const trial = drafted(root);
  assert.equal(runTrial(root, trial.id).status, 'trial');
  const candidate = drafted(root, { gate: READ_GATE });
  return { root, trial, candidate };
}

const editLearning = (root, id, over) =>
  writeFileSync(learningFile(root, id), JSON.stringify({ ...JSON.parse(readFileSync(learningFile(root, id), 'utf8')), ...over }));

test('a learning file edited from rejected to trial gets no gate, and is reported as a ledger mismatch', () => {
  const { root, rejected, candidate } = rejectedAndCandidate();
  editLearning(root, 'L1', { status: 'trial' });
  const listed = listLearnings(root);
  assert.deepEqual(listed.ledgerMismatch, ['L1']);
  assert.deepEqual(listed.gatesToRepair, []);
  assert.deepEqual(learningStats(root, 'L1'), { error: 'L1: the ledger does not record the status trial for this learning' });
  assert.ok(runTrial(root, candidate.id).replay);
  assert.ok(!existsSync(localGatesPath(root)) || !localGates(root).gates.some(g => g.id === rejected.id));
  // Edited back to candidate, it is still not replayed: the ledger says rejected.
  editLearning(root, 'L1', { status: 'candidate' });
  assert.deepEqual(runTrial(root, 'L1'), { error: 'L1: the ledger does not record the status candidate for this learning' });
});

test("deleting and re-creating a rejected learning's gate entry does not survive the repair", () => {
  const { root, rejected, candidate } = rejectedAndCandidate();
  writeLocalGates(root, [rejected.gate]);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1']);
  assert.deepEqual(runTrial(root, candidate.id).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, []);
});

test('with an unreadable ledger no gate is restored and the result says why', () => {
  const { root, candidate } = trialAndCandidate();
  writeLocalGates(root, []);
  writeFileSync(join(repoDataDir(root), 'ledger.jsonl'), 'not json\n', { flag: 'a' });
  const listed = listLearnings(root);
  assert.equal(listed.ledgerIntact, false);
  assert.deepEqual(listed.ledgerMismatch, ['L1', 'L2']);
  assert.deepEqual(listed.gatesToRepair, []);
  const why = id => `${id}: the ledger cannot be read or its chain is broken, so it does not record this learning's status`;
  assert.deepEqual(runTrial(root, candidate.id), { error: why('L2') });
  assert.deepEqual(learningStats(root, 'L1'), { error: why('L1') });
  assert.deepEqual(localGates(root).gates, []);
});

test('a trial the ledger records is still restored when its gate entry is missing', () => {
  const { root, trial, candidate } = trialAndCandidate();
  writeLocalGates(root, []);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1']);
  assert.deepEqual(runTrial(root, candidate.id).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, [trial.gate]);
});

test('a learning file edited to a status the table does not know, with a block gate, yields no gate', () => {
  const { root, trial, candidate } = trialAndCandidate();
  const blocking = { ...trial.gate, action: 'block' };
  editLearning(root, 'L1', { status: 'active-local', gate: blocking });
  writeLocalGates(root, [blocking]);
  const listed = listLearnings(root);
  assert.deepEqual(listed.unreadable, ['L1']);
  assert.deepEqual(listed.gatesToRepair, ['L1']);
  runTrial(root, candidate.id);
  assert.deepEqual(localGates(root).gates, [], 'never kept, never restored');
});

test('a gate whose learning file cannot be read is kept only at observe, and always reported', () => {
  const { root, trial, candidate } = trialAndCandidate();
  writeFileSync(learningFile(root, 'L1'), '{ damaged');
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1']);
  assert.deepEqual(runTrial(root, candidate.id).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, [trial.gate], 'an observe gate is kept while its file cannot be judged');
});

test('a full local gate set does not stop a failing replay from being recorded', () => {
  const root = loggedRepo();
  const learning = drafted(root, { gate: FIX_GATE });
  // A gate whose learning file cannot be read stays at observe, so the set stays full.
  const full = Array.from({ length: 100 }, (_, i) => ({ ...WATCH_GATE, id: `L${i + 100}`, action: 'observe' }));
  for (const gate of full) writeFileSync(learningFile(root, gate.id), '{ damaged');
  writeLocalGates(root, full);
  assert.equal(runTrial(root, learning.id).status, 'rejected');
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:rejected']);
  assert.equal(localGates(root).gates.length, 100);
});

test('a local gate file that is not a gate file is never overwritten', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  writeFileSync(localGatesPath(root), '[1, 2');
  assert.deepEqual(runTrial(root, learning.id), { error: 'the local gate file is not a gate file; nothing was written' });
  assert.equal(readFileSync(localGatesPath(root), 'utf8'), '[1, 2');
  assert.equal(listLearnings(root).learnings[0].status, 'candidate');
  assert.equal(listLearnings(root).gatesToRepair, null, 'an unreadable local gate file is not reported as needing no repair');
  assert.deepEqual(kinds(root), ['L1:proposed']);
});

test('a learning file that does not read back is reported, not used, and blocks new drafts', () => {
  const root = loggedRepo();
  logReadMistakes(root);
  const learning = drafted(root);
  writeFileSync(learningFile(root, 'L1'), JSON.stringify({ ...learning, gate: { ...learning.gate, match: { kind: 'literal', value: 'npm' } } }));
  assert.deepEqual(listLearnings(root), { learnings: [], gatesToRepair: [], ledgerMismatch: [], ledgerIntact: true, unreadable: ['L1'] });
  assert.deepEqual(runTrial(root, 'L1'), { error: 'L1: the learning file does not read back as a learning' });
  assert.deepEqual(draftLearning(root, draftFor(root, { gate: READ_GATE })),
    { error: 'learning L1 does not read back as a learning, and may cover this signature; mend or remove its file first' });
});

test('a learnings lock held by another writer returns an error and writes nothing', () => {
  const root = loggedRepo();
  const release = holdLock(join(repoDataDir(root), 'learnings.lock'));
  try {
    assert.deepEqual(draftLearning(root, draftFor(root)), { error: 'another process holds the learnings lock; nothing was written' });
  } finally {
    release();
  }
  assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
  assert.deepEqual(readLedger(root), []);
});

test('a ledger that cannot be appended stops the step before the learning is stored', () => {
  const root = loggedRepo();
  const release = holdLock(join(repoDataDir(root), 'ledger.jsonl.lock'));
  try {
    assert.deepEqual(draftLearning(root, draftFor(root)), { error: 'the step stopped partway (ELOCKED); listLearnings reports what it left disagreeing' });
  } finally {
    release();
  }
  assert.equal(existsSync(learningFile(root, 'L1')), false, 'no state without its ledger entry');
  assert.equal(drafted(root).id, 'L2', 'the id the stopped step took is not assigned again');
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
  const root = loggedRepo({ clean: false, files: { [GATES_PATH]: JSON.stringify({ schema: 1, gates: [] }), [FAILURES_PATH]: '# Failures\n' } });
  const status = git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored');
  const before = mtimes(root);

  const failing = drafted(root, { gate: FIX_GATE });
  assert.equal(runTrial(root, failing.id).status, 'rejected');
  const passing = drafted(root);
  assert.equal(runTrial(root, passing.id).status, 'candidate', 'not checkable without clean history');
  writeLocalGates(root, [{ ...WATCH_GATE, id: 'L41', action: 'observe' }]);
  logClean(root);
  const trial = runTrial(root, passing.id);
  assert.equal(trial.status, 'trial');
  assert.deepEqual(trial.repairedGates, ['L41']);
  assert.ok(draftLearning(root, draftFor(root)).error);
  listLearnings(root);
  learningStats(root, passing.id);
  gateActionsFor('trial');

  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored'), status);
  assert.deepEqual(mtimes(root), before);
});
