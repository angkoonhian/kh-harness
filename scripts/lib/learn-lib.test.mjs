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
  call, draftFor, drafted, editLearning, FIX, FIX_GATE, git, kinds, labelFailures, learningFile, localGates, localGatesPath, log, logClean, logFiring,
  loggedRepo, logMistakes, logReadMistakes, mistake, mtimes, read, READ_GATE, repo, signatureOf, stoppedAfterLedger, storedLearning, success, trialRepo,
  WATCH_GATE, withoutProseHashes, writeLocalGates,
} from './learn-fixtures.mjs';
import { draftLearning, failed, gateActionsFor, learningStats, listLearnings, proseSha256Of, refused, runTrial } from './learn-lib.mjs';
import { approveLearning, demoteLearning, retireLearning, tick } from './learn-promote.mjs';
import { appendLedger, readLedger, verifyLedger } from './ledger.mjs';
import { findRecurrences } from './recurrence.mjs';
import { MAX_DOCUMENT_BYTES } from './scan.mjs';
import { requireInteractive } from './tty.mjs';

// What `requireInteractive` returns at a person's terminal.
const AT_TERMINAL = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} });

/** What `listLearnings` reports beside the learnings when nothing is amiss. */
const NOTHING_AMISS = {
  gatesToRepair: [], unapprovedGates: [], citationsGone: [], idCollisions: [], ledgerMismatch: [], lagging: [], proseUnrecorded: [],
  ledgerIntact: true, unreadable: [], approvals: [],
};

const REDRAFT_ONLY = earlier => refused(`signature: an earlier learning for this recurrence did not hold: ${earlier}; a new draft for it is the owner's decision, as \`learn --help\` documents`);

test('an error carries the exit code the command ends with: 3 for a refusal, 2 for what could not be done', () => {
  assert.deepEqual(refused('no'), { error: 'no', exitCode: 3 });
  assert.deepEqual(failed('no'), { error: 'no', exitCode: 2 });
});

/** Holds the lock file at `path` as a live writer other than this one. */
function holdLock(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'another-writer' }));
  return () => rmSync(path, { force: true });
}

test('a learning gate warns or blocks only once promoted, on this machine or in the repository, and observes otherwise', () => {
  for (const status of ['candidate', 'rejected', 'trial', 'suspended', 'retired']) assert.deepEqual(gateActionsFor(status), ['observe']);
  for (const status of ['active-local', 'landed']) assert.deepEqual(gateActionsFor(status), ['warn', 'block']);
  for (const status of ['reverted', 'unknown', 'constructor']) assert.deepEqual(gateActionsFor(status), []);
});

test('a draft for an unknown signature is refused', () => {
  const root = loggedRepo();
  const result = draftLearning(root, draftFor(root, { signature: '0123456789abcdef' }));
  assert.deepEqual(result, failed('signature: not the signature of a current recurrence'));
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
    [{ title: secretish.repeat(9) }, 'title: must be at most 120 characters, each < and > counting as four'],
    [{ title: `${'a'.repeat(117)}<` }, 'title: must be at most 120 characters, each < and > counting as four'],
    [{ why: 7 }, 'why: must be a string'],
    [{ why: secretish.repeat(21) }, 'why: must be at most 300 characters, each < and > counting as four'],
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
    assert.deepEqual(result, failed(error), JSON.stringify(over));
    assert.ok(!result.error.includes(secretish) && !result.error.includes(credential));
  }
  assert.deepEqual(draftLearning(root, null), failed('draft: must be an object'));
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
  assert.equal(entry.proseSha256, proseSha256Of(learning), 'the title, why and evidence are bound with the draft');
  assert.deepEqual(listLearnings(root), { learnings: [learning], ...NOTHING_AMISS });
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
  labelFailures(root);
  const learning = drafted(root);
  assert.equal(learning.external, true);
  assert.equal(learning.evidence.external, true);
});

test('a second draft for a signature is refused while the first is live', () => {
  const root = loggedRepo();
  drafted(root);
  assert.deepEqual(draftLearning(root, draftFor(root)), refused('signature: learning L1 already covers this signature'));
  assert.deepEqual(kinds(root), ['L1:proposed']);
});

/** A repository whose Bash recurrence had L1 drafted and rejected by its
 * replay. */
function rejectedRepo() {
  const root = loggedRepo();
  assert.equal(runTrial(root, drafted(root, { gate: FIX_GATE }).id).status, 'rejected');
  return root;
}

test('a second draft for a signature whose learning the replay rejected is refused and writes nothing', () => {
  const root = rejectedRepo();
  const before = mtimes(repoDataDir(root));
  const ledgerBefore = readLedger(root);
  assert.deepEqual(draftLearning(root, draftFor(root)), REDRAFT_ONLY('L1 (drafted for this signature, rejected by the replay)'));
  assert.deepEqual(mtimes(repoDataDir(root)), before);
  assert.deepEqual(readLedger(root), ledgerBefore);
  assert.equal(existsSync(learningFile(root, 'L2')), false);
});

test('with redraft the second draft is accepted, and its proposed entry says it is a redraft', () => {
  const root = rejectedRepo();
  const result = draftLearning(root, draftFor(root), { redraft: true });
  assert.equal(result.learning?.id, 'L2', result.error);
  const proposed = readLedger(root).filter(e => e.kind === 'proposed');
  assert.deepEqual(proposed.map(e => [e.learningId, e.detail]), [['L1', undefined], ['L2', 'a redraft; earlier: L1 (drafted for this signature, rejected by the replay)']]);
  assert.equal(runTrial(root, 'L2').status, 'trial');
});

test('redraft changes nothing for a signature no learning was rejected for', () => {
  const root = loggedRepo();
  assert.equal(draftLearning(root, draftFor(root), { redraft: true }).learning?.id, 'L1');
  assert.equal(readLedger(root).find(e => e.kind === 'proposed').detail, undefined);
});

/** A rejected Bash L1 beside a Read recurrence, with `kinds` written as the
 * failure taxonomy: each `[title, tools]`, `tools` naming the recurrences
 * the kind labels. */
function siblingRepo(kinds) {
  const root = loggedRepo();
  logReadMistakes(root);
  assert.equal(runTrial(root, drafted(root, { gate: FIX_GATE }).id).status, 'rejected');
  const body = kinds.map(([title, tools], i) => `## F${i + 3} — ${title}\n- signatures: ${tools.map(t => signatureOf(root, t)).join(', ')}\n`).join('\n');
  mkdirSync(join(root, 'docs', 'harness'), { recursive: true });
  writeFileSync(join(root, FAILURES_PATH), `# Failures\n\n${body}`);
  return root;
}

const readDraft = root => draftFor(root, { gate: READ_GATE });

test('a draft for a sibling signature of a rejected learning\'s failure kind is refused without redraft', () => {
  const root = siblingRepo([['Tests run in watch mode', ['Bash', 'Read']]]);
  assert.deepEqual(draftLearning(root, readDraft(root)), REDRAFT_ONLY('L1 (drafted for another signature of failure kind F3, rejected by the replay)'));
  assert.equal(draftLearning(root, readDraft(root), { redraft: true }).learning?.id, 'L2');
  assert.equal(readLedger(root).filter(e => e.kind === 'proposed').at(-1).detail, 'a redraft; earlier: L1 (drafted for another signature of failure kind F3, rejected by the replay)');
});

test('a rejection under another failure kind leaves a recurrence draftable', () => {
  const apart = siblingRepo([['Tests run in watch mode', ['Bash']], ['A file read that does not exist', ['Read']]]);
  assert.equal(draftLearning(apart, readDraft(apart)).learning?.id, 'L2');
});

const UNLABELLED = refused(`signature: no failure kind in ${FAILURES_PATH} lists this signature, and only the owner names a failure: `
  + 'a learning is drafted once the owner has added it there, as `- signatures: <signature>` under a `## F<n> — <kind of failure>` heading');

test('a draft for a signature no failure kind lists is refused, naming the taxonomy, and stores nothing', () => {
  const absent = loggedRepo({ label: false });
  const other = loggedRepo({ label: false, files: { [FAILURES_PATH]: '## F1 — something else\n- signatures: 0123456789abcdef\n' } });
  for (const root of [absent, other]) {
    assert.deepEqual(draftLearning(root, draftFor(root)), UNLABELLED);
    assert.deepEqual(draftLearning(root, draftFor(root), { redraft: true }), UNLABELLED, 'a redraft is no way round it');
    assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
    assert.deepEqual(readLedger(root), []);
  }
  labelFailures(absent);
  assert.equal(drafted(absent).failureId, 'F1', 'once the owner has named it, it is drafted');
});

test('a draft is refused while the taxonomy cannot be read or is larger than is read, and says the file was not read', () => {
  const unreadable = loggedRepo({ label: false });
  mkdirSync(join(unreadable, FAILURES_PATH), { recursive: true });
  const over = loggedRepo({ label: false });
  labelFailures(over);
  writeFileSync(join(over, FAILURES_PATH), `${readFileSync(join(over, FAILURES_PATH), 'utf8')}<!-- ${'x'.repeat(MAX_DOCUMENT_BYTES)} -->\n`);
  const notRead = why => refused(`signature: ${FAILURES_PATH} ${why}, so whether a failure kind lists this signature is not known; nothing was drafted`);
  for (const [root, why] of [[unreadable, 'exists but could not be read'], [over, `is larger than the ${MAX_DOCUMENT_BYTES} bytes kh-harness reads of a file`]]) {
    assert.deepEqual(draftLearning(root, draftFor(root)), notRead(why));
    assert.deepEqual(draftLearning(root, draftFor(root), { redraft: true }), notRead(why));
    assert.equal(existsSync(join(repoDataDir(root), 'learnings')), false);
    assert.deepEqual(readLedger(root), []);
  }
});

test('a learning the owner retired bars a plain draft for its recurrence; a live candidate still covers it', () => {
  const { root, learning } = trialRepo();
  assert.equal(retireLearning(root, learning.id, { interactive: AT_TERMINAL }).status, 'retired');
  assert.deepEqual(draftLearning(root, draftFor(root)), REDRAFT_ONLY('L1 (drafted for this signature, retired by the owner)'));
  assert.deepEqual(kinds(root).at(-1), 'L1:retired', 'the refused draft wrote nothing');
  assert.equal(draftLearning(root, draftFor(root), { redraft: true }).learning?.id, 'L2');
  assert.equal(readLedger(root).at(-1).detail, 'a redraft; earlier: L1 (drafted for this signature, retired by the owner)');
  assert.deepEqual(draftLearning(root, draftFor(root), { redraft: true }), refused('signature: learning L2 already covers this signature'),
    'redraft does not get past a live candidate');
});

test('a trial that tick retired because its cited paths are gone leaves its recurrence draftable without redraft', () => {
  const { root } = trialRepo({ files: { 'docs/watch.md': '# watch\n' }, cites: ['docs/watch.md'] });
  rmSync(join(root, 'docs/watch.md'));
  assert.deepEqual(tick(root).retired, ['L1']);
  assert.equal(draftLearning(root, draftFor(root)).learning?.id, 'L2', 'nothing was held against it');
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
  assert.deepEqual(runTrial(root, learning.id), refused('L1 is rejected; only a candidate is replayed'));
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
  assert.deepEqual(runTrial(root, learning.id), refused('L1 is trial; only a candidate is replayed'));
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);
});

test('a learning file edited to another action does not read back, and its gate never goes live', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  for (const action of ['block', 'warn']) {
    writeFileSync(learningFile(root, 'L1'), JSON.stringify({ ...learning, gate: { ...learning.gate, action } }));
    assert.deepEqual(listLearnings(root), { learnings: [], ...NOTHING_AMISS, unreadable: ['L1'] });
    assert.deepEqual(runTrial(root, 'L1'), failed('L1: the learning file does not read back as a learning'));
    assert.deepEqual(learningStats(root, 'L1'), failed('L1: the learning file does not read back as a learning'));
  }
  assert.equal(existsSync(localGatesPath(root)), false);
  assert.deepEqual(kinds(root), ['L1:proposed']);
});

test('an id that is malformed or names no learning is refused', () => {
  const root = loggedRepo();
  for (const id of ['../L1', 'L0', 'l1', 42]) {
    assert.deepEqual(runTrial(root, id), failed('id: must be L followed by 1 to 9 digits, without a leading zero'));
    assert.deepEqual(learningStats(root, id), failed('id: must be L followed by 1 to 9 digits, without a leading zero'));
  }
  assert.deepEqual(runTrial(root, 'L9'), failed('L9: no such learning'));
  assert.deepEqual(learningStats(root, 'L9'), failed('L9: no such learning'));
});

test('ids are never reused after a rejection', () => {
  const root = loggedRepo();
  const rejected = options => {
    const learning = drafted(root, { gate: FIX_GATE }, options);
    assert.equal(runTrial(root, learning.id).status, 'rejected');
    return learning.id;
  };
  assert.equal(rejected(), 'L1');
  assert.equal(rejected({ redraft: true }), 'L2');
  rmSync(learningFile(root, 'L2'));
  rmSync(learningFile(root, 'L1'));
  assert.equal(rejected({ redraft: true }), 'L3', 'a removed learning keeps its number');
  rmSync(learningFile(root, 'L3'));
  rmSync(join(repoDataDir(root), 'learning-ids.json'));
  assert.equal(drafted(root, undefined, { redraft: true }).id, 'L4', 'the ledger keeps the number when the counter is lost');
});

test('ids start above the highest id in the committed gate file', () => {
  const committed = { schema: 1, gates: [{ ...WATCH_GATE, id: 'L7', action: 'warn' }, { id: 'L3', suspended: true }] };
  const root = loggedRepo({ files: { [GATES_PATH]: JSON.stringify(committed) } });
  assert.equal(drafted(root).id, 'L8');
});

test('a committed gate file that exists and cannot be read assigns no id', () => {
  const error = failed('the committed gate file cannot be read, so no id that avoids its ids can be assigned');
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
  appendLedger(root, { kind: 'trial', learningId: 'L1', contentSha256: learning.sha256, proseSha256: proseSha256Of(learning), evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: null });
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
  assert.deepEqual(learningStats(root, 'L1'), refused('L1: the ledger records other content for this learning'));
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


test('a learning file edited from rejected to trial gets no gate, is reported, and is put back as the ledger records it', () => {
  const { root, rejected, candidate } = rejectedAndCandidate();
  editLearning(root, 'L1', { status: 'trial' });
  const listed = listLearnings(root);
  assert.deepEqual(listed.ledgerMismatch, ['L1']);
  assert.deepEqual(listed.lagging, ['L1']);
  assert.deepEqual(listed.gatesToRepair, []);
  assert.deepEqual(learningStats(root, 'L1'), refused('L1: the ledger does not record the status trial for this learning'));
  const replayed = runTrial(root, candidate.id);
  assert.ok(replayed.replay);
  assert.deepEqual(replayed.rolledForward, ['L1']);
  assert.equal(storedLearning(root, 'L1').status, 'rejected');
  assert.ok(!existsSync(localGatesPath(root)) || !localGates(root).gates.some(g => g.id === rejected.id));
  // Edited to candidate, it is still not replayed: the ledger says rejected.
  editLearning(root, 'L1', { status: 'candidate' });
  assert.deepEqual(runTrial(root, 'L1'), { ...refused('L1 is rejected; only a candidate is replayed'), rolledForward: ['L1'] });
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
  assert.deepEqual(runTrial(root, candidate.id), refused(why('L2')));
  assert.deepEqual(learningStats(root, 'L1'), refused(why('L1')));
  assert.deepEqual(localGates(root).gates, []);
});

test('a trial the ledger records is still restored when its gate entry is missing', () => {
  const { root, trial, candidate } = trialAndCandidate();
  writeLocalGates(root, []);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1']);
  assert.deepEqual(runTrial(root, candidate.id).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, [trial.gate]);
});

test('a learning file edited to a status no ledger kind leads to, with a block gate, yields no gate', () => {
  const { root, trial, candidate } = trialAndCandidate();
  const blocking = { ...trial.gate, action: 'block' };
  editLearning(root, 'L1', { status: 'reverted', gate: blocking });
  writeLocalGates(root, [blocking]);
  const listed = listLearnings(root);
  assert.deepEqual(listed.unreadable, ['L1']);
  assert.deepEqual(listed.gatesToRepair, ['L1']);
  runTrial(root, candidate.id);
  assert.deepEqual(localGates(root).gates, [], 'never kept, never restored');
});

for (const status of ['landed', 'active-local']) {
  test(`a learning file edited to ${status} with a block gate, with nothing of it in the ledger, never blocks: the file and its gate go back to the trial the ledger records`, () => {
    const { root, trial, candidate } = trialAndCandidate();
    const blocking = { ...trial.gate, action: 'block' };
    editLearning(root, 'L1', { status, gate: blocking });
    writeLocalGates(root, [blocking]);
    const listed = listLearnings(root);
    assert.deepEqual(listed.unreadable, []);
    assert.deepEqual(listed.ledgerMismatch, ['L1']);
    assert.deepEqual(listed.lagging, ['L1']);
    assert.deepEqual(listed.gatesToRepair, ['L1']);
    assert.deepEqual(listed.unapprovedGates, ['L1']);
    const replayed = runTrial(root, candidate.id);
    assert.deepEqual(replayed.rolledForward, ['L1']);
    assert.deepEqual(replayed.repairedGates, ['L1']);
    assert.deepEqual([storedLearning(root, 'L1').status, storedLearning(root, 'L1').gate.action], ['trial', 'observe']);
    assert.deepEqual(localGates(root).gates.filter(g => g.id === 'L1'), [trial.gate], 'the block entry is gone; the trial gate observes');
    assert.deepEqual(listLearnings(root).ledgerMismatch, []);
  });
}

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
  assert.deepEqual(runTrial(root, learning.id), refused('the local gate file is not a gate file; nothing was written'));
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
  assert.deepEqual(listLearnings(root), { learnings: [], ...NOTHING_AMISS, unreadable: ['L1'] });
  assert.deepEqual(runTrial(root, 'L1'), failed('L1: the learning file does not read back as a learning'));
  assert.deepEqual(draftLearning(root, draftFor(root, { gate: READ_GATE })),
    refused('learning L1 does not read back as a learning, and may cover this signature; mend or remove its file first'));
});

test('a learnings lock held by another writer returns an error and writes nothing', () => {
  const root = loggedRepo();
  const release = holdLock(join(repoDataDir(root), 'learnings.lock'));
  try {
    assert.deepEqual(draftLearning(root, draftFor(root)), failed('another process holds the learnings lock; nothing was written'));
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
    assert.deepEqual(draftLearning(root, draftFor(root)),
      failed('the step stopped partway (ELOCKED); the same command run again, or `tick`, brings what it left into line with the ledger'));
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
  const { places, ...counts } = learningStats(root, 'L1');
  assert.deepEqual(counts, { firings: 5, sessions: 4, rerouted: 2, wrong: 1, wrongTotal: 1, sessionsUnreadable: 0, sessionsBeingSealed: 0 });
  // Where each counted firing is, as a wrong mark names it, oldest first;
  // only L1's own mark counts for it.
  assert.deepEqual(places.map(({ ts, ...place }) => place), [
    { sessionId: 'later-a', line: 1, action: 'block', markedWrong: true },
    { sessionId: 'later-b', line: 1, action: 'block', markedWrong: false },
    { sessionId: 'later-b', line: 3, action: 'block', markedWrong: false },
    { sessionId: 'later-d', line: 1, action: 'observe', markedWrong: false },
    { sessionId: 'later-e', line: 1, action: 'warn', markedWrong: false },
  ]);
  assert.ok(places.every(p => !Number.isNaN(Date.parse(p.ts))));
});

test('a learning\'s firings are ordered by when they were recorded, not by session id', () => {
  const { root, learning } = trialRepo();
  logFiring(root, 'zz-first', learning.gate, 'z-1');
  // An event's time is the millisecond it was appended: the next firing is
  // appended in a later one.
  for (const start = Date.now(); Date.now() === start;);
  logFiring(root, 'aa-second', learning.gate, 'a-1');
  assert.deepEqual(learningStats(root, 'L1').places.map(p => p.sessionId), ['zz-first', 'aa-second']);
});

test('nothing in this module writes inside the repository', () => {
  const root = loggedRepo({ clean: false, files: { [GATES_PATH]: JSON.stringify({ schema: 1, gates: [] }), [FAILURES_PATH]: '# Failures\n' } });
  const status = git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored');
  const before = mtimes(root);

  const failing = drafted(root, { gate: FIX_GATE });
  assert.equal(runTrial(root, failing.id).status, 'rejected');
  const passing = drafted(root, undefined, { redraft: true });
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

test('a deleted learning file does not let a second draft for its signature through until tick has recorded it retired', () => {
  const { root } = trialRepo();
  rmSync(learningFile(root, 'L1'));
  const covered = refused('signature: learning L1 already covers this signature; its learning file is gone, and `tick` records it retired, after which this recurrence can be drafted');
  assert.deepEqual(draftLearning(root, draftFor(root)), { ...covered, repairedGates: ['L1'] }, 'the gate of a learning with no file goes too');
  assert.deepEqual(draftLearning(root, draftFor(root)), covered);
  assert.deepEqual(tick(root).retiredFileGone, ['L1']);
  assert.equal(draftLearning(root, draftFor(root)).learning?.id, 'L2', 'nothing was held against L1, so no redraft is asked for');

  const rejected = loggedRepo();
  assert.equal(runTrial(rejected, drafted(rejected, { gate: FIX_GATE }).id).status, 'rejected');
  rmSync(learningFile(rejected, 'L1'));
  assert.equal(draftLearning(rejected, draftFor(rejected), { redraft: true }).learning?.id, 'L2', 'a rejected learning does not stand for its signature, file or none');
});

test('a local entry with no usable id is dropped and reported by its place in the file', () => {
  const { root, learning } = trialRepo();
  writeLocalGates(root, [{ ...WATCH_GATE, action: 'block' }, 'block everything', learning.gate, { id: 7, suspended: true }]);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['entry 1', 'entry 2', 'entry 4']);
  assert.deepEqual(runTrial(root, 'L9'), { ...failed('L9: no such learning'), repairedGates: ['entry 1', 'entry 2', 'entry 4'] });
  assert.deepEqual(localGates(root).gates, [learning.gate]);
});

// --- the title, why and evidence are what the ledger vouches for too ---------

test('every status entry records the hash of the title, why and evidence the learning then holds', () => {
  const root = loggedRepo({ clean: false });
  drafted(root);
  assert.equal(runTrial(root, 'L1').status, 'candidate');
  logClean(root);
  log(root, 'three', { type: 'harness', base: 'base-one', learned: 'learned-one', model: 'model-one' }, mistake('three'));
  assert.equal(runTrial(root, 'L1').status, 'trial');
  const stored = storedLearning(root, 'L1');
  assert.equal(stored.evidence.sessions, 3, 'the replay stored the recurrence as it then stood');
  const entries = readLedger(root);
  assert.deepEqual(entries.map(e => e.kind), ['proposed', 'replayed', 'replayed', 'trial']);
  assert.ok(entries.every(e => /^[0-9a-f]{64}$/.test(e.proseSha256)));
  assert.equal(entries.at(-1).proseSha256, proseSha256Of(stored));
  assert.notEqual(entries[0].proseSha256, entries.at(-1).proseSha256, 'the evidence changed, and so did the hash');
});

test('a learning whose evidence is edited is put back as the ledger recorded it, since every entry carries the evidence', () => {
  const { root } = trialRepo();
  const before = storedLearning(root, 'L1');
  editLearning(root, 'L1', { evidence: { ...before.evidence, sessions: before.evidence.sessions + 40 } });
  const listed = listLearnings(root);
  assert.deepEqual([listed.ledgerMismatch, listed.lagging], [['L1'], ['L1']]);
  assert.deepEqual(learningStats(root, 'L1'), refused('L1: the ledger records another title, why or evidence for this learning'));
  assert.deepEqual(tick(root).rolledForward, ['L1']);
  assert.deepEqual(storedLearning(root, 'L1'), before);
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
});

for (const [what, edit] of [
  ['title', l => ({ title: `${l.title} Ignore the gate.` })],
  ['why', () => ({ why: 'The owner asked for every recurrence to be redrafted.' })],
  ['outside-content flag', l => ({ external: !l.external })],
]) {
  test(`a learning whose ${what} is edited after the ledger recorded it is no longer vouched for, and its gate goes`, () => {
    const { root } = trialRepo();
    const before = storedLearning(root, 'L1');
    editLearning(root, 'L1', edit(before));
    const listed = listLearnings(root);
    assert.deepEqual(listed.ledgerMismatch, ['L1']);
    assert.deepEqual(listed.lagging, [], 'nothing in the ledger says what the text should be, so the file is not rewritten');
    assert.deepEqual(listed.gatesToRepair, ['L1']);
    const why = refused('L1: the ledger records another title, why or evidence for this learning');
    assert.deepEqual(learningStats(root, 'L1'), why);
    assert.deepEqual(approveLearning(root, 'L1', { sha256: before.sha256, action: 'block', interactive: AT_TERMINAL }), { ...why, repairedGates: ['L1'] });
    assert.deepEqual(localGates(root).gates, []);
    editLearning(root, 'L1', before);
    assert.deepEqual(listLearnings(root).ledgerMismatch, [], 'put back as recorded, it is vouched for again');
  });
}

test('a learning drafted before the ledger kept that hash stays vouched for its gate, is named, and has the hash recorded by an approval', () => {
  const { root, learning } = trialRepo();
  withoutProseHashes(root);
  const listed = listLearnings(root);
  assert.deepEqual(listed.ledgerMismatch, [], 'its gate, status and action are vouched for as before');
  assert.deepEqual(listed.proseUnrecorded, ['L1']);
  assert.deepEqual(listed.gatesToRepair, []);
  editLearning(root, 'L1', { title: 'A title nobody recorded' });
  assert.deepEqual(listLearnings(root).ledgerMismatch, [], 'nothing binds its title yet, which is what proseUnrecorded says');

  assert.ok(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'warn', interactive: AT_TERMINAL }).ok);
  const promoted = readLedger(root).at(-1);
  assert.equal(promoted.proseSha256, proseSha256Of(storedLearning(root, 'L1')), 'the approval, which prints the learning, records the hash');
  assert.deepEqual(listLearnings(root).proseUnrecorded, []);
  editLearning(root, 'L1', { title: 'Changed after the approval' });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1']);
});

test('a step that shows the owner nothing leaves an older learning\'s title, why and evidence unrecorded', () => {
  const { root, learning } = trialRepo();
  assert.ok(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'warn', interactive: AT_TERMINAL }).ok);
  withoutProseHashes(root);
  assert.ok(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).ok);
  assert.equal(readLedger(root).at(-1).proseSha256, undefined);
  assert.deepEqual(listLearnings(root).proseUnrecorded, ['L1']);
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
});

test('a last entry without the hash, after one that recorded it, vouches for nothing', () => {
  const { root, learning } = trialRepo();
  appendLedger(root, { kind: 'promoted', learningId: 'L1', contentSha256: learning.sha256, evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: 'owner', action: 'block' });
  editLearning(root, 'L1', { status: 'active-local', gate: { ...learning.gate, action: 'block' } });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1']);
  assert.deepEqual(listLearnings(root).lagging, []);
  assert.deepEqual(learningStats(root, 'L1'), refused("L1: the ledger's last entry for this learning records no hash of its title, why and evidence, though an earlier one does"));
});

// --- a step stopped between its ledger entry and the learning file -----------

test('a replay stopped after it recorded a pass is finished by the same command: the file and the gate follow the ledger', () => {
  const root = loggedRepo();
  drafted(root);
  const { result, written } = stoppedAfterLedger(root, 'L1', () => runTrial(root, 'L1'));
  assert.equal(result.status, 'trial');
  assert.equal(storedLearning(root, 'L1').status, 'candidate', 'fixture: the file is as the stopped step left it');
  assert.equal(existsSync(localGatesPath(root)), false);
  const listed = listLearnings(root);
  assert.deepEqual([listed.ledgerMismatch, listed.lagging, listed.gatesToRepair], [['L1'], ['L1'], []]);

  assert.deepEqual(runTrial(root, 'L1'), { ...refused('L1 is trial; only a candidate is replayed'), repairedGates: ['L1'], rolledForward: ['L1'] });
  const stored = storedLearning(root, 'L1');
  assert.deepEqual({ ...stored, replay: null }, { ...written, replay: null });
  assert.deepEqual(stored.replay, { verdict: 'pass', reason: written.replay.reason }, "the verdict and reason are the ledger's; the counts behind them were in no entry");
  assert.deepEqual(localGates(root).gates, [written.gate]);
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial'], 'no second entry');
  const after = listLearnings(root);
  assert.deepEqual([after.ledgerMismatch, after.lagging, after.gatesToRepair], [[], [], []]);
});

test('a replay stopped after it recorded a fail is finished too, and the recurrence then needs a redraft', () => {
  const root = loggedRepo();
  drafted(root, { gate: FIX_GATE });
  const { written } = stoppedAfterLedger(root, 'L1', () => runTrial(root, 'L1'));
  assert.equal(written.status, 'rejected');
  assert.deepEqual(draftLearning(root, draftFor(root)), { ...REDRAFT_ONLY('L1 (drafted for this signature, rejected by the replay)'), rolledForward: ['L1'] });
  assert.equal(storedLearning(root, 'L1').status, 'rejected');
  assert.equal(draftLearning(root, draftFor(root), { redraft: true }).learning?.id, 'L2');
});

test('a replay stopped after it recorded not-checkable keeps its candidate, with the evidence the ledger recorded', () => {
  const root = loggedRepo({ clean: false });
  drafted(root);
  log(root, 'three', { type: 'harness', base: 'base-one', learned: 'learned-one', model: 'model-one' }, mistake('three'));
  const { written } = stoppedAfterLedger(root, 'L1', () => runTrial(root, 'L1'));
  assert.equal(written.status, 'candidate');
  assert.equal(storedLearning(root, 'L1').evidence.sessions, 2, 'fixture: the file holds the evidence of the draft');
  assert.deepEqual(listLearnings(root).lagging, ['L1']);
  logClean(root);
  const again = runTrial(root, 'L1');
  assert.equal(again.status, 'trial', again.error);
  assert.deepEqual(again.rolledForward, ['L1']);
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:replayed', 'L1:trial']);
});

test('a draft stopped before it wrote its learning file is recorded retired by tick, and the recurrence is drafted again', () => {
  const root = loggedRepo();
  const { written } = stoppedAfterLedger(root, 'L1', () => draftLearning(root, draftFor(root)));
  assert.equal(written.status, 'candidate');
  assert.equal(existsSync(learningFile(root, 'L1')), false, 'fixture: the ledger says proposed and there is no file');
  assert.deepEqual(runTrial(root, 'L1'), failed('L1: no such learning'));
  assert.match(draftLearning(root, draftFor(root)).error, /learning L1 already covers this signature; its learning file is gone, and `tick` records it retired/);
  const ticked = tick(root);
  assert.deepEqual([ticked.retiredFileGone, ticked.errors], [['L1'], []]);
  const retired = readLedger(root).at(-1);
  assert.deepEqual([retired.kind, retired.learningId, retired.approvedBy, retired.detail], ['retired', 'L1', null, 'its learning file is gone']);
  assert.deepEqual(tick(root).retiredFileGone, [], 'once');
  assert.equal(draftLearning(root, draftFor(root)).learning?.id, 'L2');
});

// --- an id a pulled landing took ---------------------------------------------

test('a learning whose id the committed gate file holds for another gate is reported, and one it holds as its own is not', () => {
  const { root, learning } = trialRepo();
  assert.deepEqual(listLearnings(root).idCollisions, []);
  const pulled = { ...READ_GATE, id: 'L1', action: 'block' };
  mkdirSync(join(root, GATES_PATH, '..'), { recursive: true });
  writeFileSync(join(root, GATES_PATH), JSON.stringify({ schema: 1, gates: [pulled] }));
  assert.deepEqual(listLearnings(root).idCollisions, ['L1']);
  assert.deepEqual(tick(root).idCollisions, ['L1']);
  writeFileSync(join(root, GATES_PATH), JSON.stringify({ schema: 1, gates: [{ ...learning.gate, action: 'warn' }] }));
  assert.deepEqual(listLearnings(root).idCollisions, [], 'the same gate under the same id is no collision');
  writeFileSync(join(root, GATES_PATH), JSON.stringify({ schema: 1, gates: [pulled] }));
  assert.ok(retireLearning(root, 'L1', { interactive: AT_TERMINAL }).ok, 'the way out the report names');
  assert.deepEqual(listLearnings(root).idCollisions, [], 'a retired learning no longer competes for the id');
});
