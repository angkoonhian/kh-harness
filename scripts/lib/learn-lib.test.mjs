// scripts/lib/learn-lib.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, set by learn-fixtures.mjs,
// so nothing here reads or writes the real `~/.claude/kh-harness`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, harnessIdentity, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { FAILURES_PATH } from './failures-evidence.mjs';
import {
  call, draftFor, drafted, editLearning, FIX, FIX_GATE, git, kinds, learningFile, localGates, localGatesPath, log, logClean, logFiring, loggedRepo,
  logMistakes, logReadMistakes, mistake, mtimes, read, READ_GATE, repo, signatureOf, success, trialRepo, WATCH_GATE, writeLocalGates,
} from './learn-fixtures.mjs';
import { draftLearning, gateActionsFor, learningStats, listLearnings, recordedStatus, runTrial } from './learn-lib.mjs';
import { appendLedger, readLedger, verifyLedger } from './ledger.mjs';
import { findRecurrences } from './recurrence.mjs';

/** Holds the lock file at `path` as a live writer other than this one. */
function holdLock(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'another-writer' }));
  return () => rmSync(path, { force: true });
}

test('a learning gate warns or blocks only once promoted on this machine, and observes otherwise', () => {
  for (const status of ['candidate', 'rejected', 'trial', 'suspended', 'retired']) assert.deepEqual(gateActionsFor(status), ['observe']);
  assert.deepEqual(gateActionsFor('active-local'), ['warn', 'block']);
  for (const status of ['landed', 'unknown', 'constructor']) assert.deepEqual(gateActionsFor(status), []);
});

test('the recorded status is the last status-changing ledger entry for that id, and only under the learning\'s content', () => {
  const sha = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const entry = (kind, over = {}) => ({ kind, learningId: 'L1', contentSha256: sha, ...over });
  assert.equal(recordedStatus([], 'L1', sha), null);
  assert.equal(recordedStatus([entry('proposed')], 'L1', sha), 'candidate');
  assert.equal(recordedStatus([entry('proposed'), entry('replayed'), entry('trial'), entry('wrong')], 'L1', sha), 'trial');
  const promoted = entry('promoted', { action: 'warn', approvedBy: 'owner' });
  assert.equal(recordedStatus([entry('trial'), promoted], 'L1', sha), 'active-local');
  assert.equal(recordedStatus([entry('trial'), promoted, entry('demoted')], 'L1', sha), 'trial');
  assert.equal(recordedStatus([entry('trial'), entry('suspended')], 'L1', sha), 'suspended');
  assert.equal(recordedStatus([entry('trial'), entry('retired')], 'L1', sha), 'retired');
  assert.equal(recordedStatus([entry('proposed'), entry('rejected', { contentSha256: other })], 'L1', sha), null,
    'an older entry under the matching hash does not win over a newer one under another');
  assert.equal(recordedStatus([entry('proposed'), entry('rejected', { contentSha256: other })], 'L1', other), 'rejected');
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
  assert.deepEqual(listLearnings(root), { learnings: [learning], gatesToRepair: [], unapprovedGates: [], citationsGone: [], ledgerMismatch: [], ledgerIntact: true, unreadable: [], approvals: [] });
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
    assert.deepEqual(listLearnings(root), { learnings: [], gatesToRepair: [], unapprovedGates: [], citationsGone: [], ledgerMismatch: [], ledgerIntact: true, unreadable: ['L1'], approvals: [] });
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
  const rejected = () => {
    const learning = drafted(root, { gate: FIX_GATE });
    assert.equal(runTrial(root, learning.id).status, 'rejected');
    return learning.id;
  };
  assert.equal(rejected(), 'L1');
  assert.equal(rejected(), 'L2');
  rmSync(learningFile(root, 'L2'));
  rmSync(learningFile(root, 'L1'));
  assert.equal(rejected(), 'L3', 'a removed learning keeps its number');
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
  // learning at all and a suspension the ledger does not account for.
  const suspension = { id: 'L40', suspended: true };
  const stray = { ...WATCH_GATE, id: 'L41', action: 'observe' };
  writeLocalGates(root, [suspension, { ...learning.gate }, stray]);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1', 'L40', 'L41']);

  const result = runTrial(root, learning.id);
  assert.deepEqual(result.repairedGates, ['L1', 'L40', 'L41']);
  assert.equal(result.status, 'trial');
  assert.deepEqual(localGates(root).gates, [learning.gate]);
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
  const other = draftLearning(root, draftFor(root, { gate: READ_GATE }));
  assert.deepEqual(other.repairedGates, ['L1'], 'a draft repairs the set too');
  assert.deepEqual(localGates(root).gates.filter(g => g.id === 'L1'), [gate]);
  assert.deepEqual(runTrial(root, other.learning.id).repairedGates, []);

  writeLocalGates(root, []);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1'], 'a trial learning with no gate in the set');
});

test('a learning whose status disagrees with its last ledger entry is reported', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  // As a step leaves it when it stops after its ledger entry.
  appendLedger(root, { kind: 'trial', learningId: 'L1', contentSha256: learning.sha256, evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: null });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1']);
  appendLedger(root, { kind: 'wrong', learningId: 'L1', contentSha256: learning.sha256, evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: 'owner', firing: { sessionId: 'one', line: 1 } });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1'], 'a kind that changes no status is not the last word');
  writeFileSync(learningFile(root, 'L1'), JSON.stringify({ ...learning, status: 'trial' }));
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
  rmSync(learningFile(root, 'L1'));
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1'], 'a ledger entry with no learning file');
});

test('a newer status entry under another hash makes the learning a mismatch, whatever older entries say', () => {
  const { root, trial } = trialAndCandidate();
  appendLedger(root, { kind: 'rejected', learningId: 'L1', contentSha256: '0'.repeat(64), evidence: trial.evidence, base: 'b', learned: 'l', approvedBy: null });
  const listed = listLearnings(root);
  assert.deepEqual(listed.ledgerMismatch, ['L1']);
  assert.deepEqual(listed.gatesToRepair, ['L1']);
  assert.deepEqual(learningStats(root, 'L1'), { error: 'L1: the ledger records other content for this learning' });
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
  editLearning(root, 'L1', { status: 'landed', gate: blocking });
  writeLocalGates(root, [blocking]);
  const listed = listLearnings(root);
  assert.deepEqual(listed.unreadable, ['L1']);
  assert.deepEqual(listed.gatesToRepair, ['L1']);
  runTrial(root, candidate.id);
  assert.deepEqual(localGates(root).gates, [], 'never kept, never restored');
});

test('a learning file edited to active-local with a block gate, with no promotion in the ledger, yields no gate', () => {
  const { root, trial, candidate } = trialAndCandidate();
  const blocking = { ...trial.gate, action: 'block' };
  editLearning(root, 'L1', { status: 'active-local', gate: blocking });
  writeLocalGates(root, [blocking]);
  const listed = listLearnings(root);
  assert.deepEqual(listed.unreadable, []);
  assert.deepEqual(listed.ledgerMismatch, ['L1']);
  assert.deepEqual(listed.gatesToRepair, ['L1']);
  assert.deepEqual(listed.unapprovedGates, ['L1']);
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
  assert.deepEqual(listLearnings(root), { learnings: [], gatesToRepair: [], unapprovedGates: [], citationsGone: [], ledgerMismatch: [], ledgerIntact: true, unreadable: ['L1'], approvals: [] });
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


test('stats count firings across sessions', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  runTrial(root, learning.id);
  const { gate } = learning;
  const blocking = { ...gate, action: 'block' };
  // Blocked, the call itself failed, and the next Bash call succeeded.
  logFiring(root, 'later-a', blocking, 'a-1');
  log(root, 'later-a', mistake('later-a', 'a-1'), read('later-a'), success('later-a', FIX));
  // Blocked twice; after the second, the next Bash call failed again.
  logFiring(root, 'later-b', blocking, 'b-1');
  log(root, 'later-b', mistake('later-b', 'b-1'));
  logFiring(root, 'later-b', blocking, 'b-2');
  log(root, 'later-b', mistake('later-b', 'b-2'), mistake('later-b'));
  // Observed, and the next Bash call succeeded: nothing was rerouted.
  logFiring(root, 'later-d', gate, 'd-1');
  log(root, 'later-d', success('later-d', FIX));
  // Warned, and the next Bash call succeeded.
  logFiring(root, 'later-e', { ...gate, action: 'warn' }, 'e-1');
  log(root, 'later-e', success('later-e', FIX));
  // Neither another gate's firing nor a firing of other content counts.
  logFiring(root, 'later-c', { ...gate, id: 'L99' }, 'c-1');
  logFiring(root, 'later-c', gate, 'c-2', { gateSha256: '0'.repeat(64) });

  const evidence = learning.evidence;
  const mark = (learningId, line) => appendLedger(root, { kind: 'wrong', learningId, contentSha256: learning.sha256, evidence, base: 'b', learned: 'l', approvedBy: 'owner', firing: { sessionId: 'later-a', line } });
  mark('L1', 1);
  mark('L2', 2);
  assert.deepEqual(learningStats(root, 'L1'), { firings: 5, sessions: 4, rerouted: 2, wrong: 1, sessionsUnreadable: 0 });
});

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

test('a deleted learning file does not let a second draft for its signature through', () => {
  const { root } = trialRepo();
  rmSync(learningFile(root, 'L1'));
  assert.deepEqual(draftLearning(root, draftFor(root)),
    { error: 'signature: learning L1 already covers this signature', repairedGates: ['L1'] }, 'the gate of a learning with no file goes too');
  assert.deepEqual(draftLearning(root, draftFor(root)), { error: 'signature: learning L1 already covers this signature' });

  const rejected = loggedRepo();
  assert.equal(runTrial(rejected, drafted(rejected, { gate: FIX_GATE }).id).status, 'rejected');
  rmSync(learningFile(rejected, 'L1'));
  assert.equal(drafted(rejected).id, 'L2', 'a rejected learning does not stand for its signature, file or none');
});

test('a local entry with no usable id is dropped and reported by its place in the file', () => {
  const { root, learning } = trialRepo();
  writeLocalGates(root, [{ ...WATCH_GATE, action: 'block' }, 'block everything', learning.gate, { id: 7, suspended: true }]);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['entry 1', 'entry 2', 'entry 4']);
  assert.deepEqual(runTrial(root, 'L9'), { error: 'L9: no such learning', repairedGates: ['entry 1', 'entry 2', 'entry 4'] });
  assert.deepEqual(localGates(root).gates, [learning.gate]);
});
