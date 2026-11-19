// scripts/lib/learn-promote.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, set by learn-fixtures.mjs,
// so nothing here reads or writes the real `~/.claude/kh-harness`. The
// gate hook is run as a child process, so what a promotion or demotion puts
// in force is checked against the hook that enforces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { FAILURES_PATH } from './failures-evidence.mjs';
import {
  call, drafted, editLearning, FIX, git, HARNESS, kinds, localGates, localGatesPath, log, logClean, logFiring, loggedRepo, logMistakes,
  logReadMistakes, MISTAKE, mtimes, READ_GATE, repo, success, trialRepo, useId, WATCH_GATE, writeLocalGates,
} from './learn-fixtures.mjs';
import { learningStats, listLearnings, runTrial } from './learn-lib.mjs';
import { approveLearning, demoteLearning, markWrong, retireLearning, setPolicy, tick } from './learn-promote.mjs';
import { appendLedger, readLedger, verifyLedger } from './ledger.mjs';
import { readPolicy, writePolicy } from './policy.mjs';
import { SUCCESS_EVENT } from './recurrence.mjs';
import { MIN_CLEAN_CALLS } from './replay.mjs';
import { requireInteractive } from './tty.mjs';

// What `requireInteractive` returns at a person's terminal and inside Claude Code.
const AT_TERMINAL = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} });
const NOT_AT_TERMINAL = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CLAUDECODE: '1' } });
const POLICY = { minTrialFirings: 2, minTrialSessions: 2, maxAction: 'warn' };
const HOOK = join(import.meta.dirname, '..', '..', 'assets', 'scripts', 'tool-gate.mjs');

/** A repository whose Bash learning L1 the owner promoted to `action`. */
function promotedRepo(action, options) {
  const { root, learning } = trialRepo(options);
  const approved = approveLearning(root, 'L1', { sha256: learning.sha256, action, interactive: AT_TERMINAL });
  assert.equal(approved.ok, true, approved.error);
  return { root, learning, gate: { ...learning.gate, action } };
}

/** Records a firing of `gate` in `sessionId` and returns its reference. */
function fired(root, sessionId, gate) {
  const toolUseId = useId('fired');
  logFiring(root, sessionId, gate, toolUseId);
  const line = readEvents(root, sessionId).events.findIndex(e => e.type === 'gate_firing' && e.tool_use_id === toolUseId) + 1;
  assert.ok(line > 0);
  return { sessionId, line };
}

/** What the gate hook makes of a Bash call of `command` on this machine. */
function hookOn(root, command) {
  const payload = { hook_event_name: 'PreToolUse', session_id: useId('hook'), tool_use_id: useId('use'), tool_name: 'Bash', tool_input: { command } };
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout === '' ? null : JSON.parse(result.stdout);
}

const denied = output => output?.hookSpecificOutput?.permissionDecision === 'deny';
const statusOf = (root, id = 'L1') => listLearnings(root).learnings.find(l => l.id === id)?.status;
const markRaw = (root, learning, firing) =>
  appendLedger(root, { kind: 'wrong', learningId: learning.id, contentSha256: learning.sha256, evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: 'owner', firing });
const commitFile = (root, path, text) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `add ${path}`);
};
const repoStatus = root => git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored');

/** Sets `policy` as the owner would at a terminal and returns its hash. */
function ownerPolicy(root, policy) {
  const set = setPolicy(root, policy, { interactive: AT_TERMINAL });
  assert.equal(set.ok, true, set.error);
  return set.sha256;
}

const NO_TERMINAL = what => ({ error: `${what} needs a person at an interactive terminal outside Claude Code; nothing was written` });

test('approval is refused without an interactive terminal', () => {
  const { root, learning } = trialRepo();
  const before = readFileSync(localGatesPath(root), 'utf8');
  for (const interactive of [NOT_AT_TERMINAL, undefined, null, { ok: 'true' }, { ok: 1 }, [true], { reason: 'none' }]) {
    assert.deepEqual(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'block', interactive }), NO_TERMINAL('approval'), JSON.stringify(interactive));
  }
  assert.deepEqual(approveLearning(root, 'L1'), NO_TERMINAL('approval'));
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);
  assert.equal(readFileSync(localGatesPath(root), 'utf8'), before);
  assert.equal(statusOf(root), 'trial');
  assert.equal(denied(hookOn(root, MISTAKE)), false);
});

test('approval with a stale hash is refused', () => {
  const { root, learning } = trialRepo();
  const stale = gateSha256({ ...learning.gate, message: 'An older message.' });
  assert.deepEqual(approveLearning(root, 'L1', { sha256: stale, action: 'block', interactive: AT_TERMINAL }),
    { error: "L1: the hash approved is not the learning's content; show it again and approve the hash it shows" });
  for (const sha256 of [undefined, 'abc', learning.sha256.toUpperCase()]) {
    assert.deepEqual(approveLearning(root, 'L1', { sha256, action: 'block', interactive: AT_TERMINAL }), { error: 'sha256: must be 64 lowercase hex characters' });
  }
  for (const action of ['observe', 'deny', undefined]) {
    assert.deepEqual(approveLearning(root, 'L1', { sha256: learning.sha256, action, interactive: AT_TERMINAL }), { error: 'action: must be warn or block' });
  }
  assert.deepEqual(approveLearning(root, '../L1', { sha256: learning.sha256, action: 'block', interactive: AT_TERMINAL }),
    { error: 'id: must be L followed by 1 to 9 digits, without a leading zero' });
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);
  assert.equal(statusOf(root), 'trial');
});

test('an approved trial blocks on this machine, and the ledger names the owner and the action', () => {
  const root = loggedRepo();
  const learning = drafted(root);
  assert.deepEqual(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'block', interactive: AT_TERMINAL }),
    { error: 'L1 is candidate; only a learning on trial is approved' });
  assert.equal(runTrial(root, 'L1').status, 'trial');
  const before = repoStatus(root);

  assert.deepEqual(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'block', interactive: AT_TERMINAL }),
    { ok: true, id: 'L1', action: 'block', repairedGates: [] });
  const blocking = { ...learning.gate, action: 'block' };
  assert.deepEqual(localGates(root).gates, [blocking]);
  const listed = listLearnings(root);
  assert.equal(listed.learnings[0].status, 'active-local');
  assert.deepEqual(listed.learnings[0].gate, blocking);
  assert.deepEqual(listed.ledgerMismatch, []);
  assert.deepEqual(listed.gatesToRepair, []);
  assert.deepEqual(listed.unapprovedGates, []);
  const promoted = readLedger(root).at(-1);
  assert.equal(promoted.kind, 'promoted');
  assert.equal(promoted.approvedBy, 'owner');
  assert.equal(promoted.action, 'block');
  assert.equal(promoted.contentSha256, learning.sha256);
  assert.deepEqual(listed.approvals, [{ id: 'L1', sha256: learning.sha256, action: 'block', approvedBy: 'owner', ts: promoted.ts }]);
  assert.equal(verifyLedger(root).intact, true);

  const output = hookOn(root, MISTAKE);
  assert.ok(denied(output));
  assert.equal(output.hookSpecificOutput.permissionDecisionReason, `kh-harness gate L1: ${WATCH_GATE.message}`);
  assert.equal(denied(hookOn(root, FIX)), false);
  assert.deepEqual(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'warn', interactive: AT_TERMINAL }),
    { error: 'L1 is active-local; only a learning on trial is approved' });
  assert.equal(repoStatus(root), before);
});

test('a learning file or gate entry edited from warn to block loses its gate', () => {
  const { root, learning } = promotedRepo('warn');
  const blocking = { ...learning.gate, action: 'block' };
  writeLocalGates(root, [blocking]);
  const listed = listLearnings(root);
  assert.deepEqual(listed.unapprovedGates, ['L1'], 'the owner approved warn, not block');
  assert.deepEqual(listed.gatesToRepair, ['L1']);
  assert.deepEqual(tick(root).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, [{ ...learning.gate, action: 'warn' }], 'restored at the approved action');

  editLearning(root, 'L1', { gate: blocking });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1']);
  assert.deepEqual(learningStats(root, 'L1'), { error: "L1: the ledger records another action for this learning's gate" });
  tick(root);
  assert.deepEqual(localGates(root).gates, [], 'a file that claims more than the ledger grants gets no gate');
});

test('a gate written into the local set without an approval is listed, and tick removes it and says so', () => {
  const { root, learning } = trialRepo();
  writeLocalGates(root, [{ ...learning.gate, action: 'block' }, { ...READ_GATE, id: 'L50', action: 'warn' }, { id: 'L51', suspended: true }]);
  assert.ok(denied(hookOn(root, MISTAKE)), 'fixture: the hook enforces what the file holds');
  const listed = listLearnings(root);
  assert.deepEqual(listed.unapprovedGates, ['L1', 'L50']);
  assert.deepEqual(listed.approvals, []);
  const ticked = tick(root);
  assert.deepEqual(ticked.unapprovedRemoved, ['L1', 'L50']);
  assert.deepEqual(ticked.repairedGates, ['L1', 'L50', 'L51'], 'a suspension the ledger does not account for goes too');
  assert.deepEqual(localGates(root).gates, [learning.gate], 'the trial gate is restored at observe');
  assert.equal(denied(hookOn(root, MISTAKE)), false);
  assert.deepEqual(listLearnings(root).unapprovedGates, []);
});

test('a refused call still removes a gate the ledger does not grant', () => {
  const { root, learning } = trialRepo();
  writeLocalGates(root, [{ ...learning.gate, action: 'block' }]);
  assert.deepEqual(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'block', interactive: NOT_AT_TERMINAL }),
    { ...NO_TERMINAL('approval'), repairedGates: ['L1'] });
  assert.deepEqual(localGates(root).gates, [learning.gate]);
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);

  writeLocalGates(root, [{ ...learning.gate, action: 'block' }]);
  assert.deepEqual(runTrial(root, 'L9'), { error: 'L9: no such learning', repairedGates: ['L1'] });
  assert.deepEqual(localGates(root).gates, [learning.gate]);
});

test('with a broken ledger every learned local gate is removed, and tick promotes nothing and says so', () => {
  const { root } = promotedRepo('block');
  ownerPolicy(root, POLICY);
  writeFileSync(join(repoDataDir(root), 'ledger.jsonl'), 'not json\n', { flag: 'a' });
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1']);
  assert.deepEqual(tick(root, { now: () => Date.parse('2026-11-19T12:00:00.000Z') }), {
    promoted: [], demoted: [], retired: [], suspended: [], citationsGone: [],
    unapprovedRemoved: ['L1'], repairedGates: ['L1'], gateFileRewritten: false, ledgerIntact: false, policy: 'ok', policyUnrecorded: false,
    errors: ['the ledger cannot be read or its chain is broken, so nothing was retired, demoted or promoted'],
  });
  assert.deepEqual(localGates(root).gates, []);
  assert.equal(denied(hookOn(root, MISTAKE)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(repoDataDir(root), 'last-tick.json'), 'utf8')), { ts: '2026-11-19T12:00:00.000Z' });
});

test('with no policy, tick promotes nothing', () => {
  const { root, learning } = trialRepo();
  for (const s of ['fire-a', 'fire-b', 'fire-c']) fired(root, s, learning.gate);
  assert.deepEqual(tick(root), {
    promoted: [], demoted: [], retired: [], suspended: [], citationsGone: [],
    unapprovedRemoved: [], repairedGates: [], gateFileRewritten: false, ledgerIntact: true, policy: 'absent', policyUnrecorded: false, errors: [],
  });
  assert.equal(statusOf(root), 'trial');
  assert.deepEqual(localGates(root).gates, [learning.gate]);

  writeFileSync(join(repoDataDir(root), 'policy.json'), '{ "maxAction": "block" }');
  assert.equal(tick(root).policy, 'unreadable');
  assert.equal(statusOf(root), 'trial', 'an unreadable policy promotes nothing');
  assert.deepEqual(kinds(root), ['L1:proposed', 'L1:replayed', 'L1:trial']);
});

test('under a policy, a qualifying trial is promoted and the ledger names the policy hash', () => {
  const { root, learning } = trialRepo();
  const sha = ownerPolicy(root, POLICY);
  fired(root, 'fire-a', learning.gate);
  assert.deepEqual(tick(root).promoted, [], 'one firing in one session is short of the policy');
  fired(root, 'fire-b', learning.gate);
  assert.deepEqual(tick(root).promoted, ['L1']);
  assert.deepEqual(localGates(root).gates, [{ ...learning.gate, action: 'warn' }], "promoted to the policy's maxAction and no further");
  assert.equal(statusOf(root), 'active-local');
  const promoted = readLedger(root).at(-1);
  assert.equal(promoted.kind, 'promoted');
  assert.equal(promoted.approvedBy, `policy:${sha}`);
  assert.equal(sha, readPolicy(root).sha256);
  assert.equal(promoted.action, 'warn');
  assert.deepEqual(listLearnings(root).approvals.map(a => a.approvedBy), [`policy:${sha}`]);
  assert.equal(hookOn(root, MISTAKE).hookSpecificOutput.additionalContext, `kh-harness gate L1: ${WATCH_GATE.message}`);
  assert.deepEqual(tick(root).promoted, [], 'promoted once');
});

test('a learning with external evidence is never promoted by policy', () => {
  const root = repo();
  logMistakes(root);
  log(root, 'one', { type: 'external_content', session_id: 'one', tool: 'WebFetch' });
  logClean(root);
  const learning = drafted(root);
  assert.equal(learning.external, true);
  assert.equal(runTrial(root, 'L1').status, 'trial');
  ownerPolicy(root, { ...POLICY, minTrialFirings: 1, minTrialSessions: 1 });
  for (const s of ['fire-a', 'fire-b', 'fire-c']) fired(root, s, learning.gate);
  assert.deepEqual(tick(root).promoted, []);
  assert.equal(statusOf(root), 'trial');
  assert.ok(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'warn', interactive: AT_TERMINAL }).ok, 'the owner still may');
});

test('a trial marked wrong is not promoted by policy, and a demoted one is promoted again only by the owner', () => {
  const { root, learning } = trialRepo();
  ownerPolicy(root, POLICY);
  const ref = fired(root, 'fire-a', learning.gate);
  fired(root, 'fire-b', learning.gate);
  assert.equal(markWrong(root, ref, { interactive: AT_TERMINAL }).status, 'trial');
  assert.deepEqual(tick(root).promoted, []);

  const other = promotedRepo('warn');
  assert.ok(demoteLearning(other.root, 'L1', { interactive: AT_TERMINAL }).ok);
  ownerPolicy(other.root, POLICY);
  for (const s of ['fire-a', 'fire-b', 'fire-c']) fired(other.root, s, other.learning.gate);
  assert.deepEqual(tick(other.root).promoted, []);
  assert.equal(statusOf(other.root), 'trial');
});

test('two wrong marks demote', () => {
  const { root, learning, gate } = promotedRepo('block');
  const first = fired(root, 'fire-a', gate);
  const second = fired(root, 'fire-b', gate);
  assert.deepEqual(markWrong(root, first, { interactive: AT_TERMINAL }), { ok: true, id: 'L1', wrong: 1, status: 'active-local', repairedGates: [] });
  assert.ok(denied(hookOn(root, MISTAKE)), 'one mark leaves the gate in force');
  assert.deepEqual(markWrong(root, second, { interactive: AT_TERMINAL }), { ok: true, id: 'L1', wrong: 2, status: 'trial', repairedGates: [] });
  assert.deepEqual(localGates(root).gates, [learning.gate]);
  assert.equal(statusOf(root), 'trial');
  assert.equal(denied(hookOn(root, MISTAKE)), false);
  assert.deepEqual(kinds(root).slice(-4), ['L1:promoted', 'L1:wrong', 'L1:wrong', 'L1:demoted']);
  const marks = readLedger(root).filter(e => e.kind === 'wrong');
  assert.deepEqual(marks.map(e => e.firing), [first, second]);
  assert.deepEqual(marks.map(e => e.approvedBy), ['owner', 'owner']);
  assert.equal(readLedger(root).at(-1).approvedBy, null, 'the rule demoted it, not a person');
  assert.equal(learningStats(root, 'L1').wrong, 2);

  assert.ok(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'warn', interactive: AT_TERMINAL }).ok);
  assert.equal(learningStats(root, 'L1').wrong, 0, 'marks count from the last promotion');
  assert.deepEqual(tick(root).demoted, []);
});

test('tick demotes a learning whose second wrong mark did not demote it', () => {
  const { root, learning, gate } = promotedRepo('block');
  for (const ref of [fired(root, 'fire-a', gate), fired(root, 'fire-b', gate)]) markRaw(root, learning, ref);
  assert.equal(statusOf(root), 'active-local');
  assert.deepEqual(tick(root).demoted, ['L1']);
  assert.equal(statusOf(root), 'trial');
  assert.deepEqual(localGates(root).gates, [learning.gate]);
});

test("a firing is marked wrong once, and only a recorded firing of a learning's gate can be", () => {
  const { root, gate } = promotedRepo('block');
  const ref = fired(root, 'fire-a', gate);
  log(root, 'fire-a', success('fire-a', FIX));
  const ok = { interactive: AT_TERMINAL };
  assert.deepEqual(markWrong(root, ref, { interactive: NOT_AT_TERMINAL }), NO_TERMINAL('a wrong mark'));
  assert.deepEqual(markWrong(root, ref), NO_TERMINAL('a wrong mark'));
  const malformed = { error: 'firing: must be { sessionId, line } with a session id and a line number of at least 1' };
  for (const bad of [null, 'fire-a:1', {}, { sessionId: 'fire-a' }, { sessionId: 'fire-a', line: 0 }, { sessionId: '../fire-a', line: 1 }, { sessionId: 'fire-a', line: '2' }]) {
    assert.deepEqual(markWrong(root, bad, ok), malformed, JSON.stringify(bad));
  }
  const none = { error: 'firing: no gate firing is recorded at that line of that session' };
  assert.deepEqual(markWrong(root, { ...ref, line: ref.line + 1 }, ok), none, 'a tool call, not a firing');
  assert.deepEqual(markWrong(root, { ...ref, line: 999 }, ok), none);
  assert.deepEqual(markWrong(root, { sessionId: 'no-such-session', line: 1 }, ok), none);
  assert.deepEqual(markWrong(root, fired(root, 'fire-b', { ...gate, id: 'L77' }), ok), { error: 'L77: no such learning' });
  assert.deepEqual(markWrong(root, fired(root, 'fire-c', { ...gate, message: 'Another message.' }), ok),
    { error: "firing: it is of other content than learning L1's gate" });
  assert.equal(markWrong(root, ref, ok).ok, true);
  assert.deepEqual(markWrong(root, ref, ok), { error: 'firing: it is already marked wrong' });
  assert.equal(readLedger(root).filter(e => e.kind === 'wrong').length, 1);
});

test('a committed gate marked wrong twice is suspended on this machine', () => {
  const { root, gate } = promotedRepo('block');
  // As landing the learning would commit it.
  const committed = JSON.stringify({ schema: 1, gates: [gate] });
  commitFile(root, GATES_PATH, committed);
  const before = repoStatus(root);
  const first = fired(root, 'fire-a', gate);
  const second = fired(root, 'fire-b', gate);
  assert.equal(markWrong(root, first, { interactive: AT_TERMINAL }).status, 'active-local');
  assert.equal(markWrong(root, second, { interactive: AT_TERMINAL }).status, 'suspended');
  assert.deepEqual(localGates(root).gates, [{ id: 'L1', suspended: true }]);
  assert.equal(statusOf(root), 'suspended');
  assert.equal(kinds(root).at(-1), 'L1:suspended');
  const output = hookOn(root, MISTAKE);
  assert.equal(denied(output), false, 'the committed gate no longer blocks here');
  assert.match(output.systemMessage, /suspended on this machine/);
  assert.deepEqual(tick(root).repairedGates, [], 'a suspension the ledger records survives the repair');
  assert.deepEqual(localGates(root).gates, [{ id: 'L1', suspended: true }]);
  assert.equal(repoStatus(root), before);
  assert.equal(readFileSync(join(root, GATES_PATH), 'utf8'), committed);
});

test('tick suspends a committed gate that meets the demotion rule', () => {
  const { root, learning, gate } = promotedRepo('block');
  commitFile(root, GATES_PATH, JSON.stringify({ schema: 1, gates: [gate] }));
  for (const ref of [fired(root, 'fire-a', gate), fired(root, 'fire-b', gate)]) markRaw(root, learning, ref);
  const ticked = tick(root);
  assert.deepEqual(ticked.suspended, ['L1']);
  assert.deepEqual(ticked.demoted, []);
  assert.deepEqual(localGates(root).gates, [{ id: 'L1', suspended: true }]);
});

test('a trial whose cited paths are all gone is retired by tick', () => {
  const files = { 'docs/watch.md': '# watch\n', 'docs/other.md': '# other\n' };
  const { root } = trialRepo({ files, cites: ['docs/watch.md', 'docs/other.md'] });
  rmSync(join(root, 'docs/watch.md'));
  assert.deepEqual(tick(root).retired, [], 'one cited path still exists');
  rmSync(join(root, 'docs/other.md'));
  assert.deepEqual(tick(root).retired, ['L1']);
  assert.equal(statusOf(root), 'retired');
  assert.deepEqual(localGates(root).gates, []);
  assert.equal(kinds(root).at(-1), 'L1:retired');
  assert.equal(readLedger(root).at(-1).approvedBy, null);
  assert.deepEqual(tick(root).retired, [], 'retired once');
  assert.equal(drafted(root).id, 'L2', 'a retired learning no longer stands for its signature');

  const uncited = trialRepo();
  assert.deepEqual(tick(uncited.root).retired, [], 'a learning that cites nothing is never retired this way');
  assert.equal(statusOf(uncited.root), 'trial');
});

test('a blocking learning whose cited paths are all gone stays in force and is reported', () => {
  const { root, gate } = promotedRepo('block', { files: { 'docs/watch.md': '# watch\n' }, cites: ['docs/watch.md'] });
  assert.deepEqual(listLearnings(root).citationsGone, []);
  rmSync(join(root, 'docs/watch.md'));
  assert.deepEqual(listLearnings(root).citationsGone, ['L1']);
  const ticked = tick(root);
  assert.deepEqual(ticked.retired, []);
  assert.deepEqual(ticked.citationsGone, ['L1']);
  assert.equal(statusOf(root), 'active-local');
  assert.deepEqual(localGates(root).gates, [gate]);
  assert.ok(denied(hookOn(root, MISTAKE)), 'deleting a file does not switch off an enforcing gate');

  assert.deepEqual(retireLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'retired', 'the owner may retire it');
  assert.deepEqual(listLearnings(root).citationsGone, []);
  assert.deepEqual(tick(root).citationsGone, []);
});

test('demotion and retirement by hand need a person at a terminal', () => {
  const { root } = promotedRepo('block');
  assert.deepEqual(demoteLearning(root, 'L1', { interactive: NOT_AT_TERMINAL }), NO_TERMINAL('a demotion'));
  assert.deepEqual(demoteLearning(root, 'L1'), NO_TERMINAL('a demotion'));
  assert.deepEqual(retireLearning(root, 'L1', {}), NO_TERMINAL('a retirement'));
  assert.equal(statusOf(root), 'active-local');

  assert.deepEqual(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }), { ok: true, id: 'L1', status: 'trial', repairedGates: [] });
  assert.equal(readLedger(root).at(-1).approvedBy, 'owner');
  assert.deepEqual(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }), { error: 'L1 is trial; only a learning promoted on this machine is demoted' });
  assert.deepEqual(retireLearning(root, 'L1', { interactive: AT_TERMINAL }), { ok: true, id: 'L1', status: 'retired', repairedGates: [] });
  assert.deepEqual(localGates(root).gates, []);
  assert.deepEqual(retireLearning(root, 'L1', { interactive: AT_TERMINAL }), { error: 'L1 is retired; a rejected or retired learning is not retired again' });
  assert.deepEqual(kinds(root).slice(-3), ['L1:promoted', 'L1:demoted', 'L1:retired']);
});

test('a learning the ledger does not record is never changed', () => {
  const { root, learning } = promotedRepo('block');
  ownerPolicy(root, POLICY);
  editLearning(root, 'L1', { status: 'trial', gate: learning.gate });
  for (const s of ['fire-a', 'fire-b']) fired(root, s, learning.gate);
  const entries = readLedger(root).length;
  const ticked = tick(root);
  assert.deepEqual([ticked.promoted, ticked.demoted, ticked.retired, ticked.suspended], [[], [], [], []]);
  assert.deepEqual(ticked.repairedGates, ['L1'], 'its block gate goes');
  assert.deepEqual(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'warn', interactive: AT_TERMINAL }),
    { error: 'L1: the ledger does not record the status trial for this learning' });
  assert.equal(readLedger(root).length, entries);
  assert.deepEqual(localGates(root).gates, []);
});

test('a local gate entry whose id is not a learning id is reported and removed, not a failure', () => {
  const { root, learning } = trialRepo();
  writeLocalGates(root, [{ ...learning.gate, id: 'gate-x', action: 'block' }, learning.gate]);
  const listed = listLearnings(root);
  assert.deepEqual(listed.gatesToRepair, ['gate-x']);
  assert.deepEqual(listed.unapprovedGates, ['gate-x']);
  assert.deepEqual(tick(root).unapprovedRemoved, ['gate-x']);
  assert.deepEqual(localGates(root).gates, [learning.gate]);
});

test('nothing in this module writes inside the repository', () => {
  const { root, learning } = trialRepo({ files: { [GATES_PATH]: JSON.stringify({ schema: 1, gates: [] }), [FAILURES_PATH]: '# Failures\n' } });
  const before = repoStatus(root);
  const times = mtimes(root);

  assert.ok(approveLearning(root, learning.id, { sha256: learning.sha256, action: 'block', interactive: AT_TERMINAL }).ok);
  assert.ok(markWrong(root, fired(root, 'fire-a', { ...learning.gate, action: 'block' }), { interactive: AT_TERMINAL }).ok);
  assert.ok(demoteLearning(root, learning.id, { interactive: AT_TERMINAL }).ok);
  assert.ok(retireLearning(root, learning.id, { interactive: AT_TERMINAL }).ok);
  assert.equal(tick(root).ledgerIntact, true);

  assert.equal(repoStatus(root), before);
  assert.deepEqual(mtimes(root), times);
});

test('tick writes nothing inside the repository', () => {
  const files = { [GATES_PATH]: JSON.stringify({ schema: 1, gates: [] }), [FAILURES_PATH]: '# Failures\n', 'docs/harness/RULES.md': '# Rules\n', 'docs/watch.md': '# watch\n' };
  const { root, learning } = trialRepo({ files, cites: ['docs/watch.md'] });
  logReadMistakes(root);
  for (const id of ['clean-read-0', 'clean-read-1']) {
    log(root, id, HARNESS, ...Array.from({ length: MIN_CLEAN_CALLS / 2 }, (_, i) => call(SUCCESS_EVENT, id, 'Read', { file_path: `src/f-${i}.mjs` })));
  }
  const other = drafted(root, { gate: READ_GATE });
  assert.equal(runTrial(root, other.id).status, 'trial');
  ownerPolicy(root, { ...POLICY, maxAction: 'block' });
  for (const s of ['fire-a', 'fire-b']) fired(root, s, other.gate);
  writeLocalGates(root, [learning.gate, other.gate, { ...READ_GATE, id: 'L60', action: 'block' }]);
  rmSync(join(root, 'docs/watch.md'));
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'drop the cited file');
  const before = repoStatus(root);
  const times = mtimes(root);

  const ticked = tick(root, { now: () => Date.parse('2026-11-19T08:00:00.000Z') });
  assert.deepEqual(ticked.retired, ['L1']);
  assert.deepEqual(ticked.promoted, ['L2']);
  assert.deepEqual(ticked.unapprovedRemoved, ['L60']);
  assert.deepEqual(localGates(root).gates, [{ ...other.gate, action: 'block' }]);
  assert.deepEqual(JSON.parse(readFileSync(join(repoDataDir(root), 'last-tick.json'), 'utf8')), { ts: '2026-11-19T08:00:00.000Z' });

  assert.equal(repoStatus(root), before);
  assert.deepEqual(mtimes(root), times);
});

/** A repository with an external Bash learning L1 on trial. */
function externalTrialRepo() {
  const root = repo();
  logMistakes(root);
  log(root, 'one', { type: 'external_content', session_id: 'one', tool: 'WebFetch' });
  logClean(root);
  const learning = drafted(root);
  assert.equal(learning.external, true);
  assert.equal(runTrial(root, 'L1').status, 'trial');
  return { root, learning };
}

test('an external learning whose file is edited to say otherwise is still never promoted by policy', () => {
  const { root, learning } = externalTrialRepo();
  editLearning(root, 'L1', { external: false, evidence: { ...learning.evidence, external: false } });
  assert.deepEqual(listLearnings(root).ledgerMismatch, [], 'the edit leaves a learning the ledger still vouches for');
  ownerPolicy(root, { ...POLICY, minTrialFirings: 1, minTrialSessions: 1 });
  for (const s of ['fire-a', 'fire-b', 'fire-c']) fired(root, s, learning.gate);
  assert.deepEqual(tick(root).promoted, []);
  assert.equal(statusOf(root), 'trial');
});

test('a hand-written suspension placed before an approved gate does not switch it off unseen', () => {
  const { root, gate } = promotedRepo('block');
  writeLocalGates(root, [{ id: 'L1', suspended: true }, gate]);
  const listed = listLearnings(root);
  assert.equal(listed.learnings[0].status, 'active-local');
  assert.deepEqual(listed.gatesToRepair, ['L1'], 'the suspension is reported');
  assert.deepEqual(tick(root).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, [gate]);
  assert.ok(denied(hookOn(root, MISTAKE)), 'the approved gate is in force again');
  assert.deepEqual(listLearnings(root).gatesToRepair, []);
});

test('a policy file written without a ledger record promotes nothing and tick says so', () => {
  const { root, learning } = trialRepo();
  writePolicy(root, POLICY);
  for (const s of ['fire-a', 'fire-b']) fired(root, s, learning.gate);
  const ticked = tick(root);
  assert.equal(ticked.policy, 'ok');
  assert.equal(ticked.policyUnrecorded, true);
  assert.deepEqual(ticked.promoted, []);
  assert.equal(statusOf(root), 'trial');
});

test('a policy set at a terminal promotes a qualifying trial', () => {
  const { root, learning } = trialRepo();
  const set = setPolicy(root, POLICY, { interactive: AT_TERMINAL });
  assert.deepEqual(set, { ok: true, sha256: readPolicy(root).sha256, repairedGates: [] });
  const entry = readLedger(root).at(-1);
  assert.deepEqual([entry.kind, entry.policySha256, entry.approvedBy], ['policy', set.sha256, 'owner']);
  assert.equal(verifyLedger(root).intact, true);
  for (const s of ['fire-a', 'fire-b']) fired(root, s, learning.gate);
  const ticked = tick(root);
  assert.equal(ticked.policyUnrecorded, false);
  assert.deepEqual(ticked.promoted, ['L1']);
  assert.equal(readLedger(root).at(-1).approvedBy, `policy:${set.sha256}`);
});

test('editing the policy file after it was set stops promotion until it is set again', () => {
  const { root, learning } = trialRepo();
  ownerPolicy(root, { ...POLICY, minTrialFirings: 50 });
  for (const s of ['fire-a', 'fire-b']) fired(root, s, learning.gate);
  writePolicy(root, POLICY);
  const ticked = tick(root);
  assert.equal(ticked.policyUnrecorded, true);
  assert.deepEqual(ticked.promoted, [], 'a more lenient file nobody set promotes nothing');
  ownerPolicy(root, POLICY);
  assert.deepEqual(tick(root).promoted, ['L1']);
});

test('setPolicy without an interactive terminal is refused and writes nothing', () => {
  const { root } = trialRepo();
  const entries = readLedger(root).length;
  for (const interactive of [NOT_AT_TERMINAL, undefined, { ok: 'yes' }]) {
    assert.deepEqual(setPolicy(root, POLICY, { interactive }), NO_TERMINAL('setting a policy'));
  }
  assert.deepEqual(setPolicy(root, POLICY), NO_TERMINAL('setting a policy'));
  assert.deepEqual(setPolicy(root, { ...POLICY, maxAction: 'observe' }, { interactive: AT_TERMINAL }), { error: "policy: maxAction must be 'warn' or 'block'" });
  assert.deepEqual(readPolicy(root), { state: 'absent' });
  assert.equal(readLedger(root).length, entries);

  writeFileSync(join(repoDataDir(root), 'ledger.jsonl'), 'not json\n', { flag: 'a' });
  assert.equal(setPolicy(root, POLICY, { interactive: AT_TERMINAL }).error,
    'the ledger cannot be read or its chain is broken, so the policy cannot be recorded; nothing was written');
  assert.deepEqual(readPolicy(root), { state: 'absent' });
});

test('a gate entry is judged against the approval in force, not one its learning has since lost', () => {
  const { root, learning } = promotedRepo('warn');
  assert.ok(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).ok);
  writeLocalGates(root, [{ ...learning.gate, action: 'warn' }]);
  assert.deepEqual(listLearnings(root).unapprovedGates, ['L1'], 'the warn approval was withdrawn by the demotion');
  assert.deepEqual(tick(root).unapprovedRemoved, ['L1']);
  assert.deepEqual(localGates(root).gates, [learning.gate]);
});

test('a committed entry that only reuses a learning\'s id does not make its demotion a suspension', () => {
  const { root, gate } = promotedRepo('block');
  commitFile(root, GATES_PATH, JSON.stringify({ schema: 1, gates: [{ ...READ_GATE, id: 'L1', action: 'warn' }] }));
  for (const s of ['fire-a', 'fire-b']) assert.ok(markWrong(root, fired(root, s, gate), { interactive: AT_TERMINAL }).ok);
  assert.equal(statusOf(root), 'trial');
  assert.equal(kinds(root).at(-1), 'L1:demoted');
});

test('a local gate file that is not a gate file is rebuilt by tick from an intact ledger, and left with a broken one', () => {
  const { root, gate } = promotedRepo('block');
  writeFileSync(localGatesPath(root), '{ not a gate file');
  const ticked = tick(root);
  assert.equal(ticked.gateFileRewritten, true);
  assert.deepEqual(ticked.repairedGates, ['L1']);
  assert.deepEqual(localGates(root), { schema: 1, gates: [gate] });
  assert.ok(denied(hookOn(root, MISTAKE)));

  writeFileSync(localGatesPath(root), '{ not a gate file');
  writeFileSync(join(repoDataDir(root), 'ledger.jsonl'), 'not json\n', { flag: 'a' });
  const broken = tick(root);
  assert.equal(broken.gateFileRewritten, false);
  assert.ok(broken.errors.includes('the local gate file is not a gate file, and with the ledger broken it cannot be rebuilt; it was left as it is'));
  assert.equal(readFileSync(localGatesPath(root), 'utf8'), '{ not a gate file');
});
