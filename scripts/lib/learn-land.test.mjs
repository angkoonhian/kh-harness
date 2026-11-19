// scripts/lib/learn-land.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, set by learn-fixtures.mjs,
// and a throwaway repository under the OS temp directory, so nothing here
// reads or writes the real `~/.claude/kh-harness`. What a land or a revert
// puts in force is checked against the gate hook itself, run as a child
// process, and what it leaves in the repository against `detect --json`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, parseRules, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';
import { GATE_FILE_MAX_BYTES } from '../../assets/scripts/tool-gate.mjs';
import { committedText } from './apply-lib.mjs';
import { integrityEvidence } from './integrity-evidence.mjs';
import {
  call, drafted, editLearning, git, HARNESS, kinds, localGates, localGatesPath, log, logFiring, logReadMistakes, MISTAKE, mtimes, READ_GATE,
  trialRepo, useId,
} from './learn-fixtures.mjs';
import { landLearning, planLand, revertLearning } from './learn-land.mjs';
import { listLearnings, runTrial } from './learn-lib.mjs';
import { approveLearning, demoteLearning, markWrong, retireLearning, setPolicy, tick } from './learn-promote.mjs';
import { appendLedger, readLedger } from './ledger.mjs';
import { APPLY, DETECT, run, UNINSTALL } from './lifecycle-fixtures.mjs';
import { MANIFEST_PATH, readManifestResult, sha256 } from './manifest.mjs';
import { SUCCESS_EVENT } from './recurrence.mjs';
import { MIN_CLEAN_CALLS } from './replay.mjs';
import { requireInteractive } from './tty.mjs';

const AT_TERMINAL = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} });
const NOT_AT_TERMINAL = requireInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CLAUDECODE: '1' } });
const HOOK = join(import.meta.dirname, '..', '..', 'assets', 'scripts', 'tool-gate.mjs');
const YES = { yes: true, interactive: AT_TERMINAL };

/** A repository on a feature branch whose Bash learning L1 the owner
 * promoted to `action` on this machine. */
function activeRepo({ action = 'block', featureBranch = true } = {}) {
  const { root, learning } = trialRepo();
  if (featureBranch) git(root, 'checkout', '-q', '-b', 'harness/learned');
  const approved = approveLearning(root, 'L1', { sha256: learning.sha256, action, interactive: AT_TERMINAL });
  assert.equal(approved.ok, true, approved.error);
  return { root, learning, gate: { ...learning.gate, action } };
}

/** Adds the Read learning L2, promoted to `action`. */
function addReadLearning(root, action = 'warn') {
  logReadMistakes(root);
  for (const id of ['clean-read-0', 'clean-read-1']) {
    log(root, id, HARNESS, ...Array.from({ length: MIN_CLEAN_CALLS / 2 }, (_, i) => call(SUCCESS_EVENT, id, 'Read', { file_path: `src/f-${i}.mjs` })));
  }
  const learning = drafted(root, { gate: READ_GATE });
  assert.equal(runTrial(root, learning.id).status, 'trial');
  assert.equal(approveLearning(root, learning.id, { sha256: learning.sha256, action, interactive: AT_TERMINAL }).ok, true);
  return { learning, gate: { ...learning.gate, action } };
}

/** What the gate hook makes of a Bash call of `command` on this machine. */
function hookOn(root, command) {
  const payload = { hook_event_name: 'PreToolUse', session_id: useId('hook'), tool_use_id: useId('use'), tool_name: 'Bash', tool_input: { command } };
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout === '' ? null : JSON.parse(result.stdout);
}
const blocks = (root, command = MISTAKE) => hookOn(root, command)?.hookSpecificOutput?.permissionDecision === 'deny';

const text = (root, rel) => readFileSync(join(root, rel), 'utf8');
const committedFile = root => JSON.parse(text(root, GATES_PATH));
const manifest = root => readManifestResult(root).manifest;
const statusOf = (root, id = 'L1') => listLearnings(root).learnings.find(l => l.id === id)?.status;
const integrity = root => JSON.parse(run(DETECT, root, '--json')).checks.find(c => c.id === 'P5.integrity');
const repoStatus = root => git(root, 'status', '--porcelain', '--untracked-files=all');
const commitAll = root => {
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'land');
};
/** The section `parseRules` reads as `id` in the registry text, as it is in
 * the file. */
const sectionOf = (registry, id) => {
  const start = registry.indexOf(`## ${id} — `);
  assert.ok(start >= 0, `no entry ${id}`);
  const next = registry.indexOf('\n## ', start + 1);
  return registry.slice(start, next === -1 ? registry.length : next + 1);
};

/** Holds the lock file at `path` as a live writer other than this one. */
function holdLock(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'another-writer' }));
  return () => rmSync(path, { force: true });
}

test('land without --yes prints the diff and writes nothing', () => {
  const { root, gate } = activeRepo();
  const before = { files: mtimes(root), local: readFileSync(localGatesPath(root), 'utf8'), ledger: kinds(root) };

  const dry = landLearning(root, 'L1', {});
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.refusals, []);
  assert.deepEqual(dry.proposals.map(p => [p.kind, p.path]), [['file', LEARNED_PATH], ['file', GATES_PATH]]);
  assert.deepEqual(planLand(root, 'L1'), { proposals: dry.proposals });
  const [registry, gates] = dry.diffs;
  assert.match(registry.diff, /^\+## L1 — Tests run once, never in watch mode$/m);
  assert.match(registry.diff, new RegExp(`^\\+- approved-sha256: ${gateSha256(gate)}$`, 'm'));
  assert.match(gates.diff, /^\+ {6}"action": "block"$/m);
  assert.deepEqual(JSON.parse(dry.proposals[1].contents).gates, [gate]);

  assert.deepEqual(mtimes(root), before.files, 'nothing in the repository was touched');
  assert.equal(readFileSync(localGatesPath(root), 'utf8'), before.local);
  assert.deepEqual(kinds(root), before.ledger);
  assert.equal(statusOf(root), 'active-local');
});

test('land --yes on the default branch exits 3', () => {
  const { root } = activeRepo({ featureBranch: false });
  const before = { files: mtimes(root), local: readFileSync(localGatesPath(root), 'utf8'), ledger: kinds(root) };
  const branch = git(root, 'branch', '--show-current').trim();

  const result = landLearning(root, 'L1', YES);
  assert.equal(result.exitCode, 3);
  assert.match(result.error, new RegExp(`refusing to land on the default branch "${branch}"`));
  assert.match(result.error, /--allow-default-branch/);
  assert.match(landLearning(root, 'L1', {}).refusals[0], /refusing to land on the default branch/, 'the dry run says what --yes would refuse');
  assert.deepEqual(mtimes(root), before.files);
  assert.equal(readFileSync(localGatesPath(root), 'utf8'), before.local);
  assert.deepEqual(kinds(root), before.ledger);

  writeFileSync(join(root, 'README.md'), '# app, edited\n');
  const dirty = landLearning(root, 'L1', { ...YES, allowDefaultBranch: true });
  assert.equal(dirty.exitCode, 3);
  assert.match(dirty.error, /refusing to land with uncommitted changes to tracked files/);
  assert.equal(existsSync(join(root, GATES_PATH)), false);

  assert.equal(landLearning(root, 'L1', { ...YES, allowDefaultBranch: true, allowDirty: true }).ok, true, 'both waivers, as apply takes them');
});

test('a trial learning cannot be landed', () => {
  const { root, learning } = trialRepo();
  git(root, 'checkout', '-q', '-b', 'harness/learned');
  const before = mtimes(root);
  for (const options of [{}, YES]) {
    assert.deepEqual(landLearning(root, 'L1', options), { error: 'L1 is trial; only a learning promoted on this machine is landed', exitCode: 3 });
  }
  assert.deepEqual(planLand(root, 'L1'), { error: 'L1 is trial; only a learning promoted on this machine is landed', exitCode: 3 });
  assert.deepEqual(landLearning(root, 'L9', YES), { error: 'L9: no such learning', exitCode: 3 });
  assert.deepEqual(landLearning(root, '../L1', YES), { error: 'id: must be L followed by 1 to 9 digits, without a leading zero', exitCode: 3 });
  assert.deepEqual(revertLearning(root, 'L1', YES), { error: 'L1 is trial; only a learning landed or suspended on this machine, or one this machine landed that has left its gate, registry entry or manifest record in this repository, is reverted', exitCode: 3 });
  assert.deepEqual(mtimes(root), before);

  assert.equal(approveLearning(root, 'L1', { sha256: learning.sha256, action: 'block', interactive: AT_TERMINAL }).ok, true);
  const edited = { ...learning.gate, action: 'block', message: 'Edited after the approval.' };
  editLearning(root, 'L1', { gate: edited, sha256: gateSha256(edited) });
  const mismatch = landLearning(root, 'L1', YES);
  assert.equal(mismatch.exitCode, 3);
  assert.equal(mismatch.error, 'L1: the ledger records other content for this learning', 'gate text that is no longer the approved hash is refused');
  assert.deepEqual(mtimes(root), before);
});

test('landing puts the gate in the repository at its approved action and takes it out of the local set', () => {
  const { root, learning, gate } = activeRepo();
  const landed = landLearning(root, 'L1', YES);
  assert.deepEqual(landed, { ok: true, id: 'L1', status: 'landed', action: 'block', written: [LEARNED_PATH, GATES_PATH], repairedGates: [] });

  const file = committedFile(root);
  assert.equal(file.schema, 1);
  assert.match(file.generatedBy, /^Generated by kh-harness \S+\. kh-harness manages this file: a hand edit makes kh-harness stop updating it and keep it on uninstall\.$/);
  assert.deepEqual(file.gates, [gate]);
  const registry = text(root, LEARNED_PATH);
  assert.match(registry, /a hand edit makes kh-harness stop updating it/);
  const [rule] = parseRules(registry).rules;
  assert.deepEqual([rule.id, rule.origin, rule.enforcedBy, rule.pointer, rule.approvedSha256], ['L1', 'learned', 'hook', GATES_PATH, gateSha256(gate)]);
  assert.equal(existsSync(join(root, RULES_PATH)), false, 'the owner\'s registry is never written');

  assert.deepEqual(localGates(root).gates, [], 'the committed gate is in force, so the local one goes');
  assert.ok(blocks(root), 'and the hook still blocks, from the committed file');
  const listed = listLearnings(root);
  assert.equal(listed.learnings[0].status, 'landed');
  assert.deepEqual(listed.learnings[0].gate, gate);
  assert.deepEqual([listed.ledgerMismatch, listed.gatesToRepair, listed.unapprovedGates], [[], [], []]);
  const entry = readLedger(root).at(-1);
  assert.deepEqual([entry.kind, entry.action, entry.approvedBy, entry.contentSha256], ['landed', 'block', 'owner', learning.sha256]);

  assert.deepEqual(tick(root).repairedGates, [], 'the repair neither restores nor reports the local gate');
  assert.deepEqual(localGates(root).gates, []);
  assert.deepEqual(landLearning(root, 'L1', YES), { error: 'L1 is landed; only a learning promoted on this machine is landed', exitCode: 3 });
});

test('the manifest records each learning', () => {
  const { root, gate } = activeRepo();
  const read = addReadLearning(root);
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.equal(landLearning(root, 'L2', YES).ok, true);
  assert.deepEqual(manifest(root).learnings, [{ id: 'L1', gateSha256: gateSha256(gate) }, { id: 'L2', gateSha256: gateSha256(read.gate) }]);
  assert.deepEqual(committedFile(root).gates, [gate, read.gate], 'gates in id order');
  assert.deepEqual(manifest(root).files.map(f => f.path), [LEARNED_PATH, GATES_PATH]);
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);

  const raw = JSON.parse(text(root, MANIFEST_PATH));
  for (const learnings of [{}, [{ id: 'L1' }], [{ id: 'L1', gateSha256: 'abc' }], [{ id: 'x', gateSha256: gateSha256(gate) }], [{ id: 'L1', gateSha256: gateSha256(gate), extra: 1 }]]) {
    writeFileSync(join(root, MANIFEST_PATH), JSON.stringify({ ...raw, learnings }));
    assert.equal(readManifestResult(root).state, 'corrupt', JSON.stringify(learnings));
    const refused = revertLearning(root, 'L1', YES);
    assert.equal(refused.exitCode, 3);
    assert.match(refused.error, /could not be read as a valid kh-harness manifest/);
  }
});

test('landing two learnings then reverting the first leaves the second byte-identical', () => {
  const { root, gate } = activeRepo();
  const read = addReadLearning(root);
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  assert.equal(landLearning(root, 'L2', YES).ok, true);
  commitAll(root);
  const second = { section: sectionOf(text(root, LEARNED_PATH), 'L2'), gate: JSON.stringify(committedFile(root).gates[1], null, 2) };

  const dry = revertLearning(root, 'L1', {});
  assert.deepEqual(dry.proposals.map(p => p.path), [GATES_PATH, LEARNED_PATH], 'the gate leaves before its entry');
  const reverted = revertLearning(root, 'L1', YES);
  assert.deepEqual(reverted, { ok: true, id: 'L1', status: 'active-local', action: 'block', written: [GATES_PATH, LEARNED_PATH], notes: [], repairedGates: [] });

  assert.equal(sectionOf(text(root, LEARNED_PATH), 'L2'), second.section);
  assert.equal(JSON.stringify(committedFile(root).gates[0], null, 2), second.gate);
  assert.deepEqual(committedFile(root).gates, [read.gate]);
  assert.deepEqual(parseRules(text(root, LEARNED_PATH)).rules.map(r => r.id), ['L2']);
  assert.deepEqual(manifest(root).learnings, [{ id: 'L2', gateSha256: gateSha256(read.gate) }]);
  assert.deepEqual(git(root, 'diff', '--name-only').trim().split('\n').sort(), [GATES_PATH, MANIFEST_PATH, LEARNED_PATH].sort());

  assert.equal(statusOf(root), 'active-local', 'reverting takes the rule out of the repository, not the approval');
  assert.deepEqual(localGates(root).gates, [gate], 'its local gate is back at the approved action');
  assert.ok(blocks(root));
  assert.equal(statusOf(root, 'L2'), 'landed');
  const entry = readLedger(root).at(-1);
  assert.deepEqual([entry.kind, entry.learningId, entry.action, entry.approvedBy], ['reverted', 'L1', 'block', 'owner']);
  assert.deepEqual(listLearnings(root).unapprovedGates, []);
  assert.deepEqual(tick(root).repairedGates, []);

  assert.equal(landLearning(root, 'L1', YES).ok, true, 'a reverted learning can be landed again');
  assert.deepEqual(committedFile(root).gates, [gate, read.gate]);
});

test('a LEARNED.md or gates.json edited by hand stops land and revert, which name it and write nothing', () => {
  for (const rel of [LEARNED_PATH, GATES_PATH]) {
    const { root } = activeRepo();
    addReadLearning(root);
    assert.equal(landLearning(root, 'L1', YES).ok, true);
    writeFileSync(join(root, rel), text(root, rel).concat('\n'));
    const before = { files: mtimes(root), ledger: kinds(root) };
    const modified = `${rel} no longer matches what kh-harness last wrote (a hand edit, a deletion, or a write that stopped before the manifest recorded it), so kh-harness no longer updates it; restore it from git and run again`;
    for (const step of [() => landLearning(root, 'L2', YES), () => landLearning(root, 'L2', {})]) {
      assert.deepEqual(step(), { error: modified, exitCode: 3 }, rel);
    }
    assert.deepEqual(revertLearning(root, 'L1', YES), {
      error: `${modified}; or, if it is to stay as it is, take L1 out of it by hand and run the revert again, which then finds nothing of L1 in it and goes on`, exitCode: 3,
    }, rel);
    assert.deepEqual(mtimes(root), before.files);
    assert.deepEqual(kinds(root), before.ledger);
  }

  const { root } = activeRepo();
  mkdirSync(join(root, 'docs/harness'), { recursive: true });
  writeFileSync(join(root, LEARNED_PATH), '# Someone else\'s learned rules\n');
  assert.deepEqual(landLearning(root, 'L1', YES), {
    error: `${LEARNED_PATH} exists and the manifest does not record kh-harness writing it, so kh-harness does not write it; move it aside and run again`, exitCode: 3,
  });
  assert.equal(existsSync(join(root, GATES_PATH)), false);
});

test('a land stopped by a failed gate-file write is reported as failing, and the next land finishes it', () => {
  const { root } = activeRepo();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/kh-harness'), 'a file where the gate directory goes\n');

  const stopped = landLearning(root, 'L1', YES);
  assert.equal(stopped.exitCode, 2);
  assert.match(stopped.error, new RegExp(`^${GATES_PATH} could not be written \\(.+\\); what was written before it is recorded in ${MANIFEST_PATH}, and running again finishes the step$`));
  assert.equal(statusOf(root), 'active-local', 'no ledger entry for a land the repository does not hold');
  assert.deepEqual(kinds(root).at(-1), 'L1:promoted');
  assert.ok(blocks(root), 'the local gate stays in force');
  assert.deepEqual(manifest(root).files.map(f => f.path), [LEARNED_PATH], 'what was written is recorded');
  assert.equal(manifest(root).learnings, undefined, 'and the learning is not');
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems,
    [`L1 in ${LEARNED_PATH}: approved, but no gate in ${GATES_PATH} has its approved-sha256`], 'an entry with no gate is never reported as fine');

  rmSync(join(root, '.claude/kh-harness'));
  const finished = landLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(finished.written, [GATES_PATH], 'the registry entry already written is left as it is');
  assert.equal(statusOf(root), 'landed');
  assert.deepEqual(localGates(root).gates, []);
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
});

test('a land stopped before its ledger entry leaves the gate committed and in force, and the next land finishes it', () => {
  const { root, gate } = activeRepo();
  const release = holdLock(join(repoDataDir(root), 'ledger.jsonl.lock'));
  let stopped;
  try {
    stopped = landLearning(root, 'L1', YES);
  } finally {
    release();
  }
  assert.equal(stopped.exitCode, 2);
  assert.equal(stopped.error, 'L1: the repository change is written, and recording landed on this machine did not finish (it stopped partway (ELOCKED)); run the same command again to finish it');
  assert.deepEqual(committedFile(root).gates, [gate]);
  assert.deepEqual(manifest(root).learnings, [{ id: 'L1', gateSha256: gateSha256(gate) }]);
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
  assert.equal(statusOf(root), 'active-local');
  assert.deepEqual(localGates(root).gates, [gate], 'the local gate is not removed before the ledger records the land');
  assert.ok(blocks(root));
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);

  const finished = landLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(finished.written, [], 'the repository already holds what the land writes');
  assert.equal(statusOf(root), 'landed');
  assert.deepEqual(localGates(root).gates, []);
  assert.ok(blocks(root));
});

test('a land stopped between its ledger entry and the learning file is finished by the next land', () => {
  const { root, learning, gate } = activeRepo();
  withLedgerHeld(root, () => landLearning(root, 'L1', YES));
  const last = readLedger(root).at(-1);
  appendLedger(root, { kind: 'landed', learningId: 'L1', contentSha256: learning.sha256, evidence: last.evidence, base: last.base, learned: last.learned, approvedBy: 'owner', action: gate.action });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1'], 'the learning file still says active-local');

  const finished = landLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(readLedger(root).filter(e => e.learningId === 'L1').map(e => e.kind).filter(k => k === 'landed'), ['landed'], 'no second entry');
  assert.equal(statusOf(root), 'landed');
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
  assert.deepEqual(localGates(root).gates, []);
  assert.ok(blocks(root));
});

test('a revert stopped before its ledger entry keeps the gate in force on this machine, and the next revert finishes it', () => {
  const { root, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  const release = holdLock(join(repoDataDir(root), 'ledger.jsonl.lock'));
  let stopped;
  try {
    stopped = revertLearning(root, 'L1', YES);
  } finally {
    release();
  }
  assert.equal(stopped.exitCode, 2);
  assert.match(stopped.error, /recording reverted on this machine did not finish/);
  assert.deepEqual(committedFile(root).gates, []);
  assert.equal(statusOf(root), 'landed');
  assert.deepEqual(localGates(root).gates, [gate], 'written back before the committed gate left');
  assert.ok(blocks(root));
  assert.deepEqual(listLearnings(root).gatesToRepair, [], 'a landed learning whose committed gate is gone keeps its local gate');
  assert.deepEqual(manifest(root).learnings, [{ id: 'L1', gateSha256: gateSha256(gate) }], 'the record stays as the trace the next revert finishes from');
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems,
    [`landed learning L1 in ${MANIFEST_PATH}: no gate in ${GATES_PATH} has its id and hash`], 'the unfinished revert is reported, not fine');

  const finished = revertLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(finished.written, []);
  assert.equal(statusOf(root), 'active-local');
  assert.deepEqual(localGates(root).gates, [gate]);
  assert.deepEqual(manifest(root).learnings, []);
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
});

/** Discards the uncommitted files a land wrote, as `git clean` would. */
function discardLand(root) {
  for (const rel of [GATES_PATH, LEARNED_PATH, MANIFEST_PATH]) rmSync(join(root, rel), { force: true });
}

test('a landed learning whose uncommitted land was discarded is reverted to this machine alone, writing nothing', () => {
  const { root, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  discardLand(root);
  const landAgain = landLearning(root, 'L1', YES);
  assert.deepEqual([landAgain.error, landAgain.exitCode], ['L1 is landed; only a learning promoted on this machine is landed', 3]);
  assert.deepEqual(landAgain.repairedGates, ['L1'], 'the repair already holds its gate here, the committed one being gone');
  const before = { status: repoStatus(root), files: snapshot(root) };

  const dry = revertLearning(root, 'L1', {});
  assert.deepEqual(dry.proposals, []);
  assert.deepEqual(dry.notes, ['nothing in this checkout holds L1, so reverting it writes no file and changes it on this machine only: it is active-local again, its local gate at block; if another branch holds the landing, the gate is still committed there']);
  const reverted = revertLearning(root, 'L1', YES);
  assert.deepEqual(reverted, { ok: true, id: 'L1', status: 'active-local', action: 'block', written: [], notes: dry.notes, repairedGates: [] });
  assert.equal(repoStatus(root), before.status);
  assert.deepEqual(snapshot(root), before.files, 'no repository write, not even a manifest');
  assert.equal(statusOf(root), 'active-local');
  assert.deepEqual(localGates(root).gates, [gate]);
  assert.deepEqual(readLedger(root).at(-1).kind, 'reverted');
  assert.equal(landLearning(root, 'L1', YES).ok, true, 'and it can be landed again');
});

test('a suspended learning with no trace in this checkout is reverted to retired, writing nothing', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.equal(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'suspended');
  discardLand(root);
  const files = snapshot(root);
  assert.match(revertLearning(root, 'L1', {}).notes[0], /^nothing in this checkout holds L1, so reverting it writes no file and changes it on this machine only: it is retired; if another branch holds the landing, the gate is still committed there, and there it binds this machine again, since its suspension goes with this revert$/);
  const reverted = revertLearning(root, 'L1', YES);
  assert.equal(reverted.ok, true, reverted.error);
  assert.equal(reverted.status, 'retired');
  assert.deepEqual(snapshot(root), files);
  assert.deepEqual(readLedger(root).slice(-2).map(e => e.kind), ['reverted', 'retired']);
});

test('a revert is still refused for a trace under the same id at another hash', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  const raw = JSON.parse(text(root, MANIFEST_PATH));
  writeFileSync(join(root, MANIFEST_PATH), JSON.stringify({ ...raw, learnings: [{ id: 'L1', gateSha256: 'f'.repeat(64) }] }, null, 2) + '\n');
  assert.deepEqual(revertLearning(root, 'L1', YES), { error: `${MANIFEST_PATH} records another learning L1, which is not this learning's to remove`, exitCode: 3 });
});

test('a revert of an interrupted land names the land that finishes it', () => {
  const { root, learning, gate } = activeRepo();
  withLedgerHeld(root, () => landLearning(root, 'L1', YES));
  const last = readLedger(root).at(-1);
  appendLedger(root, { kind: 'landed', learningId: 'L1', contentSha256: learning.sha256, evidence: last.evidence, base: last.base, learned: last.learned, approvedBy: 'owner', action: gate.action });
  assert.deepEqual(revertLearning(root, 'L1', YES).error, 'L1: a land of it stopped before its learning file was written; running land for L1 again finishes it');
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.equal(statusOf(root), 'landed');
});

test('a manifest record left by a revert is removed by the next revert after the learning was retired or demoted', () => {
  for (const after of ['retire', 'demote']) {
    const { root, gate } = activeRepo();
    assert.equal(landLearning(root, 'L1', YES).ok, true);
    assert.equal(revertLearning(root, 'L1', YES).ok, true);
    const raw = JSON.parse(text(root, MANIFEST_PATH));
    writeFileSync(join(root, MANIFEST_PATH), JSON.stringify({ ...raw, learnings: [{ id: 'L1', gateSha256: gateSha256(gate) }] }, null, 2) + '\n');
    const step = after === 'retire' ? retireLearning : demoteLearning;
    assert.equal(step(root, 'L1', { interactive: AT_TERMINAL }).ok, true, after);
    const status = statusOf(root);
    assert.equal(status, after === 'retire' ? 'retired' : 'trial');
    assert.ok(integrityEvidence(root, manifest(root)).problems.length > 0, 'the stranded record is reported');
    const kindsBefore = kinds(root);

    const finished = revertLearning(root, 'L1', YES);
    assert.equal(finished.ok, true, `${after}: ${finished.error}`);
    assert.deepEqual(manifest(root).learnings, []);
    assert.deepEqual(kinds(root), kindsBefore, 'nothing more is recorded');
    assert.equal(statusOf(root), status, 'the status it reached is kept');
    assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
  }
});

test('retiring a suspended learning whose gate is still committed is refused, and reverting a learning already retired so takes the gate out', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  assert.equal(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'suspended');
  assert.deepEqual(retireLearning(root, 'L1', { interactive: AT_TERMINAL }), {
    error: `L1: its gate is still in ${GATES_PATH}, binding everyone who has the repository; reverting L1 takes it out of the repository and retires it`,
  });

  // A learning retired so before the refusal existed.
  const last = readLedger(root).at(-1);
  appendLedger(root, { kind: 'retired', learningId: 'L1', contentSha256: last.contentSha256, evidence: last.evidence, base: last.base, learned: last.learned, approvedBy: 'owner' });
  editLearning(root, 'L1', { status: 'retired' });
  assert.equal(statusOf(root), 'retired');
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
  assert.equal(revertLearning(root, 'L1', { yes: true }).exitCode, 3, 'terminal-only');

  const reverted = revertLearning(root, 'L1', YES);
  assert.deepEqual(reverted, { ok: true, id: 'L1', status: 'retired', action: 'observe', written: [GATES_PATH, LEARNED_PATH], notes: [], repairedGates: [] });
  assert.deepEqual(committedFile(root).gates, []);
  assert.deepEqual(manifest(root).learnings, []);
  assert.deepEqual(readLedger(root).slice(-2).map(e => [e.kind, e.approvedBy]), [['reverted', 'owner'], ['retired', 'owner']]);
  assert.equal(statusOf(root), 'retired');
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
});

test('retiring a landed learning whose gate is still committed is refused, naming the revert', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.deepEqual(retireLearning(root, 'L1', { interactive: AT_TERMINAL }), {
    error: `L1: its gate is still in ${GATES_PATH}, binding everyone who has the repository; reverting L1 takes it out of the repository, and it can be retired after that`,
  });
  assert.equal(revertLearning(root, 'L1', YES).ok, true);
  assert.equal(retireLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'retired');
});

test('a land killed between a file write and the manifest is finished by the next land', () => {
  // A first land: the file is on disk and the manifest does not record it.
  const first = activeRepo();
  const [registry] = planLand(first.root, 'L1').proposals;
  mkdirSync(join(first.root, 'docs/harness'), { recursive: true });
  writeFileSync(join(first.root, LEARNED_PATH), registry.contents);
  const landedFirst = landLearning(first.root, 'L1', YES);
  assert.equal(landedFirst.ok, true, landedFirst.error);
  assert.deepEqual(landedFirst.written, [GATES_PATH]);
  assert.deepEqual(manifest(first.root).files.map(f => f.path).sort(), [GATES_PATH, LEARNED_PATH].sort());
  assert.deepEqual(integrityEvidence(first.root, manifest(first.root)).problems, []);

  // A second land: both files are recorded, and the new one is written ahead of its record.
  const { root } = activeRepo();
  addReadLearning(root);
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  for (const proposal of planLand(root, 'L2').proposals) writeFileSync(join(root, proposal.path), proposal.contents);
  const landed = landLearning(root, 'L2', YES);
  assert.equal(landed.ok, true, landed.error);
  assert.deepEqual(landed.written, []);
  assert.deepEqual(manifest(root).learnings.map(l => l.id), ['L1', 'L2']);
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);

  writeFileSync(join(root, LEARNED_PATH), text(root, LEARNED_PATH) + 'A hand edit.\n');
  assert.deepEqual(revertLearning(root, 'L2', YES), {
    error: `${LEARNED_PATH} no longer matches what kh-harness last wrote (a hand edit, a deletion, or a write that stopped before the manifest recorded it), so kh-harness no longer updates it; restore it from git and run again; `
      + 'or, if it is to stay as it is, take L2 out of it by hand and run the revert again, which then finds nothing of L2 in it and goes on', exitCode: 3,
  }, 'any other difference is still refused, as before');
});

test('a revert killed between a file write and the manifest is finished by the next revert', () => {
  const { root } = activeRepo();
  addReadLearning(root);
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.equal(landLearning(root, 'L2', YES).ok, true);
  const second = sectionOf(text(root, LEARNED_PATH), 'L2');
  for (const proposal of revertLearning(root, 'L1', {}).proposals) writeFileSync(join(root, proposal.path), proposal.contents);
  const reverted = revertLearning(root, 'L1', YES);
  assert.equal(reverted.ok, true, reverted.error);
  assert.deepEqual(reverted.written, []);
  assert.equal(statusOf(root), 'active-local');
  assert.deepEqual(manifest(root).learnings.map(l => l.id), ['L2']);
  assert.equal(sectionOf(text(root, LEARNED_PATH), 'L2'), second);
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
});

test('a revert whose manifest record was left once everything else was recorded is finished by the next revert', () => {
  const { root, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.equal(revertLearning(root, 'L1', YES).ok, true);
  // As a revert stopped before its last write leaves it.
  const raw = JSON.parse(text(root, MANIFEST_PATH));
  writeFileSync(join(root, MANIFEST_PATH), JSON.stringify({ ...raw, learnings: [{ id: 'L1', gateSha256: gateSha256(gate) }] }, null, 2) + '\n');
  const before = kinds(root);
  const finished = revertLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(manifest(root).learnings, []);
  assert.deepEqual(kinds(root), before, 'nothing more is recorded');
  assert.deepEqual(revertLearning(root, 'L1', YES), { error: 'L1 is active-local; only a learning landed or suspended on this machine, or one this machine landed that has left its gate, registry entry or manifest record in this repository, is reverted', exitCode: 3 });
});

test('a landed learning keeps its gate on a checkout that lacks the committed one', () => {
  const { root, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  const main = git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').find(b => b && b !== 'harness/learned');
  git(root, 'checkout', '-q', main);
  assert.equal(existsSync(join(root, GATES_PATH)), false);
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1']);
  assert.deepEqual(tick(root).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, [gate]);
  assert.ok(blocks(root));

  git(root, 'checkout', '-q', 'harness/learned');
  assert.deepEqual(tick(root).repairedGates, ['L1'], 'back where the committed gate is, the local one goes again');
  assert.deepEqual(localGates(root).gates, []);
  assert.ok(blocks(root));
});

test('apply then land then uninstall leaves git status clean', () => {
  const { root } = activeRepo();
  run(APPLY, root, '--yes');
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.ok(manifest(root).files.some(f => f.path === GATES_PATH));
  run(UNINSTALL, root, '--yes');
  assert.equal(repoStatus(root), '');
});

test('detect reports P5.integrity declared after a land and after a revert', () => {
  const { root } = activeRepo();
  run(APPLY, root, '--yes');
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  const landed = integrity(root);
  assert.equal(landed.state, 'declared', JSON.stringify(landed.evidence));
  assert.ok(landed.evidence.includes(`${GATES_PATH}: 1 gate, each approved in ${LEARNED_PATH}`));
  assert.ok(landed.evidence.includes(`1 landed learning recorded in ${MANIFEST_PATH}, each matched by its gate`));

  assert.equal(revertLearning(root, 'L1', YES).ok, true);
  const reverted = integrity(root);
  assert.equal(reverted.state, 'declared', JSON.stringify(reverted.evidence));
  assert.ok(reverted.evidence.includes(`${GATES_PATH}: 0 gates, each approved in ${LEARNED_PATH}`));
});

test('the local gate keeps the approved action even when the committed gate is edited weaker', () => {
  const { root, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  const file = committedFile(root);
  writeFileSync(join(root, GATES_PATH), JSON.stringify({ ...file, gates: [{ ...gate, action: 'observe' }] }, null, 2) + '\n');
  assert.equal(blocks(root), false, 'fixture: the committed gate no longer blocks');
  assert.deepEqual(tick(root).repairedGates, ['L1']);
  assert.deepEqual(localGates(root).gates, [gate]);
  assert.ok(blocks(root));
});

/** Every file under `dir`, by relative path, with its content. */
function snapshot(dir) {
  return Object.fromEntries(Object.keys(mtimes(dir)).map(rel => [rel, readFileSync(join(dir, rel), 'utf8')]));
}
const NO_TERMINAL = what => ({ error: `${what} needs a person at an interactive terminal outside Claude Code; nothing was written`, exitCode: 3 });
const WITHOUT_TERMINAL = [undefined, null, NOT_AT_TERMINAL, { ok: 'true' }, { ok: 1 }, [true]];

test('landing without an interactive terminal is refused and writes nothing', () => {
  const { root } = activeRepo();
  const before = { status: repoStatus(root), files: snapshot(root), data: snapshot(repoDataDir(root)) };
  for (const interactive of WITHOUT_TERMINAL) {
    assert.deepEqual(landLearning(root, 'L1', { yes: true, interactive }), NO_TERMINAL('landing'), JSON.stringify(interactive));
  }
  assert.deepEqual(landLearning(root, 'L1', { yes: true }), NO_TERMINAL('landing'));
  assert.equal(repoStatus(root), before.status);
  assert.deepEqual(snapshot(root), before.files);
  assert.deepEqual(snapshot(repoDataDir(root)), before.data);
  assert.equal(statusOf(root), 'active-local');
});

test('reverting without an interactive terminal is refused and writes nothing', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  const before = { status: repoStatus(root), files: snapshot(root), data: snapshot(repoDataDir(root)) };
  for (const interactive of WITHOUT_TERMINAL) {
    assert.deepEqual(revertLearning(root, 'L1', { yes: true, interactive }), NO_TERMINAL('a revert'), JSON.stringify(interactive));
  }
  assert.equal(repoStatus(root), before.status);
  assert.deepEqual(snapshot(root), before.files);
  assert.deepEqual(snapshot(repoDataDir(root)), before.data);
  assert.equal(statusOf(root), 'landed');
});

test('a dry run needs no terminal', () => {
  const { root } = activeRepo();
  const dry = landLearning(root, 'L1', { interactive: NOT_AT_TERMINAL });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.proposals, planLand(root, 'L1').proposals);
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  assert.equal(revertLearning(root, 'L1', {}).dryRun, true);
});

test('a policy-promoted learning can be landed by the owner at a terminal, and the ledger records the owner', () => {
  const { root, learning } = trialRepo();
  git(root, 'checkout', '-q', '-b', 'harness/learned');
  const set = setPolicy(root, { minTrialFirings: 2, minTrialSessions: 2, maxAction: 'warn' }, { interactive: AT_TERMINAL });
  assert.equal(set.ok, true, set.error);
  for (const sessionId of ['fire-a', 'fire-b']) logFiring(root, sessionId, learning.gate, useId('fired'));
  assert.deepEqual(tick(root).promoted, ['L1']);
  assert.equal(readLedger(root).at(-1).approvedBy, `policy:${set.sha256}`);

  assert.deepEqual(landLearning(root, 'L1', { yes: true }), NO_TERMINAL('landing'), 'the policy promotes here; the owner lands');
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  const landed = readLedger(root).at(-1);
  assert.deepEqual([landed.kind, landed.approvedBy, landed.action], ['landed', 'owner', 'warn']);
  assert.deepEqual(committedFile(root).gates, [{ ...learning.gate, action: 'warn' }]);
  assert.equal(revertLearning(root, 'L1', YES).ok, true);
  const reverted = readLedger(root).at(-1);
  assert.deepEqual([reverted.kind, reverted.approvedBy, reverted.action], ['reverted', 'owner', 'warn']);
  assert.deepEqual(localGates(root).gates, [{ ...learning.gate, action: 'warn' }]);
});

/** Records a firing of `gate` in `sessionId` and returns its reference. */
function fired(root, sessionId, gate) {
  const toolUseId = useId('fired');
  logFiring(root, sessionId, gate, toolUseId);
  return { sessionId, line: readEvents(root, sessionId).events.findIndex(e => e.type === 'gate_firing' && e.tool_use_id === toolUseId) + 1 };
}

test('two wrong marks on a landed learning suspend it on this machine and leave the repository untouched', () => {
  const { root, gate } = activeRepo();
  const before = fired(root, 'fire-before', gate);
  assert.equal(markWrong(root, before, { interactive: AT_TERMINAL }).wrong, 1);
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  const repository = { status: repoStatus(root), files: snapshot(root) };

  const first = markWrong(root, fired(root, 'fire-a', gate), { interactive: AT_TERMINAL });
  assert.deepEqual([first.wrong, first.status], [1, 'landed'], 'marks count afresh from the landing');
  const second = markWrong(root, fired(root, 'fire-b', gate), { interactive: AT_TERMINAL });
  assert.deepEqual([second.wrong, second.status], [2, 'suspended']);
  assert.deepEqual(localGates(root).gates, [{ id: 'L1', suspended: true }]);
  assert.equal(blocks(root), false, 'the committed gate is suspended on this machine');
  assert.equal(readLedger(root).at(-1).kind, 'suspended');
  assert.equal(repoStatus(root), repository.status);
  assert.deepEqual(snapshot(root), repository.files);
});

test('tick suspends a landed learning marked wrong twice', () => {
  const { root, learning, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  for (const sessionId of ['fire-a', 'fire-b']) {
    // Marked as a stopped `markWrong` would leave it: recorded, not yet acted on.
    const firing = fired(root, sessionId, gate);
    appendLedger(root, { kind: 'wrong', learningId: 'L1', contentSha256: learning.sha256, evidence: learning.evidence, base: 'b', learned: 'l', approvedBy: 'owner', firing });
  }
  const files = snapshot(root);
  assert.deepEqual(tick(root).suspended, ['L1']);
  assert.equal(statusOf(root), 'suspended');
  assert.deepEqual(snapshot(root), files);
});

test('demoteLearning at a terminal suspends a landed learning', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  const files = snapshot(root);
  assert.deepEqual(demoteLearning(root, 'L1', { interactive: NOT_AT_TERMINAL }), { error: 'a demotion needs a person at an interactive terminal outside Claude Code; nothing was written' });
  assert.deepEqual(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }), { ok: true, id: 'L1', status: 'suspended', repairedGates: [] });
  assert.deepEqual(localGates(root).gates, [{ id: 'L1', suspended: true }]);
  assert.equal(blocks(root), false);
  assert.deepEqual(snapshot(root), files, 'a suspension never changes the repository');
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
});

/** A repository on a feature branch, with `apply` run, whose Bash learning
 * L1 was landed, committed, and then suspended on this machine. */
function suspendedLandedRepo() {
  const { root, gate } = activeRepo();
  run(APPLY, root, '--yes');
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  assert.equal(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'suspended');
  return { root, gate };
}

test('a suspended landed learning can be reverted at a terminal: its gate leaves the repository and it ends retired with no local gate', () => {
  const { root } = suspendedLandedRepo();
  const dry = revertLearning(root, 'L1', {});
  assert.deepEqual(dry.proposals.map(p => p.path), [GATES_PATH, LEARNED_PATH]);

  const reverted = revertLearning(root, 'L1', YES);
  assert.deepEqual(reverted, { ok: true, id: 'L1', status: 'retired', action: 'observe', written: [GATES_PATH, LEARNED_PATH], notes: [], repairedGates: [] });
  assert.deepEqual(committedFile(root).gates, []);
  assert.deepEqual(parseRules(text(root, LEARNED_PATH)).rules, []);
  assert.deepEqual(manifest(root).learnings, []);
  assert.equal(statusOf(root), 'retired');
  assert.deepEqual(localGates(root).gates, [], 'the suspension goes with the committed gate, and no local gate comes back');
  assert.equal(blocks(root), false);
  const [revertEntry, retireEntry] = readLedger(root).slice(-2);
  assert.deepEqual([revertEntry.kind, revertEntry.approvedBy, revertEntry.action], ['reverted', 'owner', 'block']);
  assert.deepEqual([retireEntry.kind, retireEntry.approvedBy], ['retired', 'owner']);
  assert.deepEqual([listLearnings(root).ledgerMismatch, listLearnings(root).gatesToRepair], [[], []]);
  assert.deepEqual(tick(root).repairedGates, []);
  assert.deepEqual(revertLearning(root, 'L1', YES), { error: 'L1 is retired; only a learning landed or suspended on this machine, or one this machine landed that has left its gate, registry entry or manifest record in this repository, is reverted', exitCode: 3 });

  const integrityAfter = integrity(root);
  assert.equal(integrityAfter.state, 'declared', JSON.stringify(integrityAfter.evidence));
});

test('P5.integrity is declared afterwards', () => {
  const { root } = suspendedLandedRepo();
  assert.equal(integrity(root).state, 'declared', 'suspended here, still committed and approved');
  assert.equal(revertLearning(root, 'L1', YES).ok, true);
  const after = integrity(root);
  assert.equal(after.state, 'declared', JSON.stringify(after.evidence));
  assert.ok(after.evidence.includes(`${GATES_PATH}: 0 gates, each approved in ${LEARNED_PATH}`));
});

test('reverting a suspended learning without a terminal is refused and writes nothing', () => {
  const { root } = suspendedLandedRepo();
  const before = { status: repoStatus(root), files: snapshot(root), data: snapshot(repoDataDir(root)) };
  for (const interactive of WITHOUT_TERMINAL) {
    assert.deepEqual(revertLearning(root, 'L1', { yes: true, interactive }), NO_TERMINAL('a revert'), JSON.stringify(interactive));
  }
  assert.equal(repoStatus(root), before.status);
  assert.deepEqual(snapshot(root), before.files);
  assert.deepEqual(snapshot(repoDataDir(root)), before.data);
  assert.equal(statusOf(root), 'suspended');
});

/** Asserts a suspended learning's revert is finished: nothing of it left in
 * the repository, retired with no local gate, and P5.integrity clean. */
function assertRevertedAndRetired(root) {
  assert.deepEqual(committedFile(root).gates, []);
  assert.deepEqual(parseRules(text(root, LEARNED_PATH)).rules, []);
  assert.deepEqual(manifest(root).learnings, []);
  assert.equal(statusOf(root), 'retired');
  assert.deepEqual(localGates(root).gates, []);
  assert.deepEqual(readLedger(root).filter(e => e.learningId === 'L1').slice(-2).map(e => [e.kind, e.approvedBy]), [['reverted', 'owner'], ['retired', 'owner']]);
  assert.deepEqual(listLearnings(root).ledgerMismatch, []);
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
}

/** Runs `step` with the ledger lock held by another writer. */
function withLedgerHeld(root, step) {
  const release = holdLock(join(repoDataDir(root), 'ledger.jsonl.lock'));
  try {
    return step();
  } finally {
    release();
  }
}

test('a suspended learning\'s revert stopped before its ledger entries is reported, and the next revert finishes it', () => {
  const { root } = suspendedLandedRepo();
  const stopped = withLedgerHeld(root, () => revertLearning(root, 'L1', YES));
  assert.equal(stopped.exitCode, 2);
  assert.equal(stopped.error, 'L1: the repository change is written, and recording reverted and retired on this machine did not finish (it stopped partway (ELOCKED)); run the same command again to finish it');
  assert.deepEqual(committedFile(root).gates, [], 'the gate is out of the repository');
  assert.equal(statusOf(root), 'suspended');
  assert.equal(integrityEvidence(root, manifest(root)).problems.length, 1, 'the record left behind is reported');

  const finished = revertLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(finished.written, []);
  assertRevertedAndRetired(root);
});

test('a suspended learning\'s revert stopped between gates.json and LEARNED.md is finished by the next revert', { skip: process.getuid?.() === 0 && 'a read-only file does not stop root' }, () => {
  const { root } = suspendedLandedRepo();
  chmodSync(join(root, LEARNED_PATH), 0o444);
  let stopped;
  try {
    stopped = revertLearning(root, 'L1', YES);
  } finally {
    chmodSync(join(root, LEARNED_PATH), 0o644);
  }
  assert.equal(stopped.exitCode, 2);
  assert.match(stopped.error, new RegExp(`^${LEARNED_PATH} could not be written \\(.+\\); what was written before it is recorded in ${MANIFEST_PATH}, and running again finishes the step$`));
  assert.deepEqual(committedFile(root).gates, [], 'the gate is gone');
  assert.deepEqual(parseRules(text(root, LEARNED_PATH)).rules.map(r => r.id), ['L1'], 'its entry is left');
  assert.equal(manifest(root).learnings.length, 1, 'and its record');
  assert.equal(statusOf(root), 'suspended');
  assert.ok(integrityEvidence(root, manifest(root)).problems.length > 0, 'what is left is reported, never fine');

  const finished = revertLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(finished.written, [LEARNED_PATH]);
  assert.deepEqual(finished.notes, [STILL_COMMITTED_RETIRING], 'the gate file this revert wrote before it stopped leaves the commit holding the gate');
  assertRevertedAndRetired(root);
});

test('a suspended learning\'s revert stopped between its two ledger entries is finished by the next revert', () => {
  const { root, gate } = suspendedLandedRepo();
  // The repository part runs, then the entries stop; `reverted` is then
  // appended as the stopped run's first append would have been.
  withLedgerHeld(root, () => revertLearning(root, 'L1', YES));
  const last = readLedger(root).at(-1);
  appendLedger(root, { kind: 'reverted', learningId: 'L1', contentSha256: last.contentSha256, evidence: last.evidence, base: last.base, learned: last.learned, approvedBy: 'owner', action: gate.action });
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1'], 'the learning file still says suspended');
  assert.equal(retireLearning(root, 'L1', { interactive: AT_TERMINAL }).error, 'L1: the ledger does not record the status suspended for this learning', 'retiring does not finish it');

  const finished = revertLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(readLedger(root).filter(e => e.learningId === 'L1').slice(-3).map(e => e.kind), ['suspended', 'reverted', 'retired'], 'only the missing entry is added');
  assertRevertedAndRetired(root);
});

/** Appends, as the owner, the ledger entries of `kinds` for L1, each as a
 * stopped land or revert would have appended it, the approved action named
 * on the kinds that carry one. */
function appendAsStopped(root, learning, action, ...kindsToAppend) {
  const last = readLedger(root).filter(e => e.learningId === 'L1').at(-1);
  for (const kind of kindsToAppend) {
    appendLedger(root, {
      kind, learningId: 'L1', contentSha256: learning.sha256, evidence: last.evidence, base: last.base, learned: last.learned, approvedBy: 'owner',
      ...(kind === 'retired' ? {} : { action }),
    });
  }
}

/** L1 landed, committed, suspended here and then retired by a hand-written
 * ledger entry, as an older kit let it be, its gate still committed. */
function retiredWithGateRepo() {
  const { root, learning, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  assert.equal(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'suspended');
  appendAsStopped(root, learning, gate.action, 'retired');
  editLearning(root, 'L1', { status: 'retired' });
  assert.equal(statusOf(root), 'retired');
  return { root, learning, gate };
}

test('a revert of a retired learning stopped between its two ledger entries is finished by the next revert', () => {
  const { root, learning, gate } = retiredWithGateRepo();
  appendAsStopped(root, learning, gate.action, 'reverted');
  assert.deepEqual(listLearnings(root).ledgerMismatch, ['L1'], 'the learning file says retired, the ledger active-local');
  const finished = revertLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(readLedger(root).filter(e => e.learningId === 'L1').slice(-3).map(e => e.kind), ['retired', 'reverted', 'retired'], 'only the missing retired is added');
  assert.deepEqual(committedFile(root).gates, []);
  assertRevertedAndRetired(root);
});

test('every revert path stopped after its ledger entries and before the learning file is finished by the next revert', () => {
  // A landed learning: `reverted` written, the learning file still landed.
  const landed = activeRepo();
  assert.equal(landLearning(landed.root, 'L1', YES).ok, true);
  appendAsStopped(landed.root, landed.learning, landed.gate.action, 'reverted');
  assert.deepEqual(listLearnings(landed.root).ledgerMismatch, ['L1']);
  const finishedLanded = revertLearning(landed.root, 'L1', YES);
  assert.equal(finishedLanded.ok, true, finishedLanded.error);
  assert.equal(statusOf(landed.root), 'active-local');
  assert.deepEqual(localGates(landed.root).gates, [landed.gate]);
  assert.deepEqual(readLedger(landed.root).filter(e => e.learningId === 'L1').map(e => e.kind).filter(k => k === 'reverted'), ['reverted'], 'no second entry');
  assert.deepEqual([committedFile(landed.root).gates, manifest(landed.root).learnings], [[], []]);

  // A suspended learning: `reverted` and `retired` written, the file still suspended.
  const suspended = suspendedLandedRepo();
  const learning = JSON.parse(readFileSync(join(repoDataDir(suspended.root), 'learnings', 'L1.json'), 'utf8'));
  appendAsStopped(suspended.root, learning, suspended.gate.action, 'reverted', 'retired');
  const finishedSuspended = revertLearning(suspended.root, 'L1', YES);
  assert.equal(finishedSuspended.ok, true, finishedSuspended.error);
  assert.deepEqual(readLedger(suspended.root).filter(e => e.learningId === 'L1').slice(-3).map(e => e.kind), ['suspended', 'reverted', 'retired']);
  assertRevertedAndRetired(suspended.root);

  // A retired learning: `reverted` and `retired` written, the record and files not yet.
  const retired = retiredWithGateRepo();
  appendAsStopped(retired.root, retired.learning, retired.gate.action, 'reverted', 'retired');
  const before = kinds(retired.root);
  const finishedRetired = revertLearning(retired.root, 'L1', YES);
  assert.equal(finishedRetired.ok, true, finishedRetired.error);
  assert.deepEqual(kinds(retired.root), before, 'its entries are all written, so none is added');
  assertRevertedAndRetired(retired.root);
});

/** Removes L1 from the working tree as an agent could: the gate and the
 * entry taken out, and the manifest's hashes and learnings rewritten to
 * match, so no trace of L1 is left in the working tree. */
function removeByHand(root) {
  const proposals = revertLearning(root, 'L1', {}).proposals;
  for (const proposal of proposals) writeFileSync(join(root, proposal.path), proposal.contents);
  const raw = JSON.parse(text(root, MANIFEST_PATH));
  const files = raw.files.map(f => {
    const proposal = proposals.find(p => p.path === f.path);
    return proposal === undefined ? f : { ...f, sha256: sha256(proposal.contents) };
  });
  writeFileSync(join(root, MANIFEST_PATH), JSON.stringify({ ...raw, files, learnings: [] }, null, 2) + '\n');
}

const STILL_COMMITTED = 'this run does not remove L1\'s gate from the working tree: it was already gone from .claude/kh-harness/gates.json; '
  + 'the commit this branch is on still holds it, and the gate stays committed for everyone until that removal is committed; git status shows the files concerned';
// The same, for a learning the revert leaves retired: its suspension goes.
const STILL_COMMITTED_RETIRING = `${STILL_COMMITTED}; restoring .claude/kh-harness/gates.json from that commit puts the gate back in force on this machine too, `
  + 'since its suspension goes with this revert';
const ALONE = 'nothing in this checkout holds L1, so reverting it writes no file and changes it on this machine only: it is active-local again, its local gate at block; '
  + 'if another branch holds the landing, the gate is still committed there';
// One note for both facts: no trace in this checkout, and the commit still holding the gate.
const ALONE_STILL_COMMITTED = 'nothing in this checkout holds L1, so reverting it writes no file and changes it on this machine only: it is active-local again, its local gate at block. '
  + `T${STILL_COMMITTED.slice(1)}`;

test('a gate removed from the working tree with the manifest rewritten to match is reverted with the note that the commit still holds it', () => {
  const { root, gate } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  removeByHand(root);
  assert.deepEqual(revertLearning(root, 'L1', {}).notes, [ALONE_STILL_COMMITTED]);
  const reverted = revertLearning(root, 'L1', YES);
  assert.equal(reverted.ok, true, reverted.error);
  assert.deepEqual(reverted.written, []);
  assert.deepEqual(reverted.notes, [ALONE_STILL_COMMITTED], 'the real run carries the dry run\'s notes');
  assert.deepEqual(localGates(root).gates, [gate]);
  assert.equal(statusOf(root), 'active-local');
});

test('the gate files deleted with the manifest untouched are reverted with the note, dry and real; once the deletion is committed there is none', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  for (const rel of [GATES_PATH, LEARNED_PATH]) rmSync(join(root, rel));
  assert.deepEqual(revertLearning(root, 'L1', {}).notes, [STILL_COMMITTED], 'the manifest record is a trace, so the revert is not alone');
  const reverted = revertLearning(root, 'L1', YES);
  assert.equal(reverted.ok, true, reverted.error);
  assert.deepEqual([reverted.written, reverted.notes], [[], [STILL_COMMITTED]]);
  assert.deepEqual(manifest(root).learnings, []);

  const again = activeRepo();
  assert.equal(landLearning(again.root, 'L1', YES).ok, true);
  commitAll(again.root);
  for (const rel of [GATES_PATH, LEARNED_PATH]) rmSync(join(again.root, rel));
  commitAll(again.root);
  const afterCommit = revertLearning(again.root, 'L1', YES);
  assert.equal(afterCommit.ok, true, afterCommit.error);
  assert.deepEqual(afterCommit.notes, [], 'the commit no longer holds the gate, and the record is left to remove');
});

test('a revert that removes the gate itself carries no note', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  const reverted = revertLearning(root, 'L1', YES);
  assert.deepEqual([reverted.written, reverted.notes], [[GATES_PATH, LEARNED_PATH], []]);
});

test('a path named like a revision in the working tree does not stop the commit being read', { skip: process.platform === 'win32' && 'a file name cannot hold a colon on Windows' }, () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  mkdirSync(join(root, `HEAD:${GATES_PATH}`, '..'), { recursive: true });
  writeFileSync(join(root, `HEAD:${GATES_PATH}`), '{ "schema": 1, "gates": [] }\n');
  removeByHand(root);
  assert.deepEqual(revertLearning(root, 'L1', {}).notes, [ALONE_STILL_COMMITTED]);
});

test('outside git a revert with no trace goes on, saying the commit could not be checked', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  discardLand(root);
  const data = repoDataDir(root);
  rmSync(join(root, '.git'), { recursive: true, force: true });
  cpSync(data, repoDataDir(root), { recursive: true });
  const notes = ['whether the commit this branch is on still holds L1\'s gate could not be checked (it is not a git repository)', ALONE];
  // git's messages are read in the C locale whatever the owner's is.
  const locale = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
  Object.assign(process.env, { LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' });
  try {
    assert.deepEqual(revertLearning(root, 'L1', {}).notes, notes);
  } finally {
    for (const [name, value] of Object.entries(locale)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const reverted = revertLearning(root, 'L1', YES);
  assert.equal(reverted.ok, true, reverted.error);
  assert.deepEqual(reverted.notes, notes, 'the real run carries the dry run\'s notes');
});

test('the commit read is the one at the repository, whatever GIT_DIR says', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  removeByHand(root);
  const other = activeRepo();
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.root, '.git');
  try {
    const read = committedText(root, GATES_PATH, GATE_FILE_MAX_BYTES);
    assert.equal(typeof read.text, 'string', 'GIT_DIR, naming a repository whose commit has no gate file, is cleared for the read');
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

test('a committed gate file larger than the gate hook loads is noted as such', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  writeFileSync(join(root, GATES_PATH), text(root, GATES_PATH) + ' '.repeat(GATE_FILE_MAX_BYTES + 1));
  commitAll(root);
  for (const rel of [GATES_PATH, LEARNED_PATH]) rmSync(join(root, rel));
  assert.deepEqual(committedText(root, GATES_PATH, GATE_FILE_MAX_BYTES), { tooLarge: true });
  assert.deepEqual(revertLearning(root, 'L1', {}).notes,
    [`whether the commit this branch is on still holds L1's gate could not be checked (the committed ${GATES_PATH} is larger than the gate hook loads)`]);
});

test('a symbolic link committed at the gate file path is not read as the gate file', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  // The link is put in the commit with plumbing, so no file system link is needed.
  const target = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'elsewhere.json', encoding: 'utf8' }).trim();
  git(root, 'update-index', '--cacheinfo', `120000,${target},${GATES_PATH}`);
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'link');
  assert.deepEqual(committedText(root, GATES_PATH, GATE_FILE_MAX_BYTES), { unknown: `the commit holds something other than a regular file at ${GATES_PATH}` });
  for (const rel of [GATES_PATH, LEARNED_PATH]) rmSync(join(root, rel));
  assert.deepEqual(revertLearning(root, 'L1', {}).notes,
    [`whether the commit this branch is on still holds L1's gate could not be checked (the commit holds something other than a regular file at ${GATES_PATH})`]);
});

test('a suspended learning with no trace while the commit holds its gate gets one note that covers both facts', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  assert.equal(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'suspended');
  removeByHand(root);
  assert.deepEqual(revertLearning(root, 'L1', {}).notes, [
    'nothing in this checkout holds L1, so reverting it writes no file and changes it on this machine only: it is retired. '
      + `T${STILL_COMMITTED_RETIRING.slice(1)}`,
  ]);
});

test('on a branch with no commit yet the note says so', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  discardLand(root);
  git(root, 'checkout', '-q', '--orphan', 'harness/empty');
  git(root, 'rm', '-rq', '--cached', '.');
  assert.deepEqual(revertLearning(root, 'L1', {}).notes, ['whether the commit this branch is on still holds L1\'s gate could not be checked (the branch has no commit yet)', ALONE]);
});

test('a hand-edited gate file names the hand removal that lets a revert go on, and that sequence works', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  commitAll(root);
  assert.equal(demoteLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'suspended');
  const edited = text(root, GATES_PATH).replace('"schema": 1', '"schema": 1 ');
  writeFileSync(join(root, GATES_PATH), edited);
  assert.match(retireLearning(root, 'L1', { interactive: AT_TERMINAL }).error, /reverting L1 takes it out of the repository and retires it$/);
  const refusal = revertLearning(root, 'L1', YES);
  assert.equal(refusal.exitCode, 3);
  assert.match(refusal.error, /^\.claude\/kh-harness\/gates\.json no longer matches what kh-harness last wrote .*restore it from git and run again; or, if it is to stay as it is, take L1 out of it by hand and run the revert again, which then finds nothing of L1 in it and goes on$/);

  const handFile = JSON.parse(edited);
  writeFileSync(join(root, GATES_PATH), JSON.stringify({ ...handFile, gates: handFile.gates.filter(g => g.id !== 'L1') }, null, 4) + '\n');
  const handText = text(root, GATES_PATH);
  assert.deepEqual(revertLearning(root, 'L1', {}).notes, [STILL_COMMITTED_RETIRING]);
  const reverted = revertLearning(root, 'L1', YES);
  assert.equal(reverted.ok, true, reverted.error);
  assert.deepEqual(reverted.written, [LEARNED_PATH], 'the hand-edited file is never written');
  assert.deepEqual(reverted.notes, [STILL_COMMITTED_RETIRING], 'the commit still holds the gate until the hand edit is committed');
  assert.equal(text(root, GATES_PATH), handText);
  assert.equal(statusOf(root), 'retired');
  assert.deepEqual(parseRules(text(root, LEARNED_PATH)).rules, []);
  assert.deepEqual(manifest(root).learnings, []);
});

test('a learning no revert can take is refused on its status before any file', () => {
  const { root } = activeRepo();
  assert.equal(landLearning(root, 'L1', YES).ok, true);
  writeFileSync(join(root, LEARNED_PATH), text(root, LEARNED_PATH) + 'A hand edit.\n');
  logReadMistakes(root);
  for (const id of ['clean-read-0', 'clean-read-1']) {
    log(root, id, HARNESS, ...Array.from({ length: MIN_CLEAN_CALLS / 2 }, (_, i) => call(SUCCESS_EVENT, id, 'Read', { file_path: `src/f-${i}.mjs` })));
  }
  const trial = drafted(root, { gate: READ_GATE });
  assert.equal(runTrial(root, trial.id).status, 'trial');
  assert.deepEqual(revertLearning(root, 'L2', YES), {
    error: 'L2 is trial; only a learning landed or suspended on this machine, or one this machine landed that has left its gate, registry entry or manifest record in this repository, is reverted',
    exitCode: 3,
  });
});
