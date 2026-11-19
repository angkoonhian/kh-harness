// scripts/lib/learn-land.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, set by learn-fixtures.mjs,
// and a throwaway repository under the OS temp directory, so nothing here
// reads or writes the real `~/.claude/kh-harness`. What a land or a revert
// puts in force is checked against the gate hook itself, run as a child
// process, and what it leaves in the repository against `detect --json`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, parseRules, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';
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
import { MANIFEST_PATH, readManifestResult } from './manifest.mjs';
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
  assert.deepEqual(revertLearning(root, 'L1', YES), { error: 'L1 is trial; only a landed learning, or one suspended on this machine, is reverted', exitCode: 3 });
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
  assert.deepEqual(reverted, { ok: true, id: 'L1', status: 'active-local', action: 'block', written: [GATES_PATH, LEARNED_PATH], repairedGates: [] });

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
    writeFileSync(join(root, rel), text(root, rel).replace('L1', 'L1 ').concat('\n'));
    const before = { files: mtimes(root), ledger: kinds(root) };
    for (const step of [() => landLearning(root, 'L2', YES), () => landLearning(root, 'L2', {}), () => revertLearning(root, 'L1', YES)]) {
      const result = step();
      assert.equal(result.exitCode, 3, rel);
      assert.equal(result.error, `${rel} no longer matches what kh-harness last wrote (a hand edit, a deletion, or a write that stopped before the manifest recorded it), so kh-harness no longer updates it; restore it from git and run again`);
    }
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
  assert.match(stopped.error, /^L1: the repository change is written and recorded, and recording landed on this machine did not finish \(it stopped partway \(ELOCKED\)\); run the same command again to finish it/);
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
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);

  const finished = revertLearning(root, 'L1', YES);
  assert.equal(finished.ok, true, finished.error);
  assert.deepEqual(finished.written, []);
  assert.equal(statusOf(root), 'active-local');
  assert.deepEqual(localGates(root).gates, [gate]);
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
  assert.deepEqual(reverted, { ok: true, id: 'L1', status: 'retired', action: 'observe', written: [GATES_PATH, LEARNED_PATH], repairedGates: [] });
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
  assert.deepEqual(revertLearning(root, 'L1', YES), { error: 'L1 is retired; only a landed learning, or one suspended on this machine, is reverted', exitCode: 3 });

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

test('a suspended learning\'s revert stopped before its ledger entries is reported, and retiring it finishes the step', () => {
  const { root } = suspendedLandedRepo();
  const release = holdLock(join(repoDataDir(root), 'ledger.jsonl.lock'));
  let stopped;
  try {
    stopped = revertLearning(root, 'L1', YES);
  } finally {
    release();
  }
  assert.equal(stopped.exitCode, 2);
  assert.match(stopped.error, /recording reverted and retired on this machine did not finish .*; retiring L1 at a terminal finishes it/);
  assert.deepEqual(committedFile(root).gates, [], 'the gate is out of the repository');
  assert.deepEqual(integrityEvidence(root, manifest(root)).problems, []);
  assert.equal(statusOf(root), 'suspended');
  assert.deepEqual(listLearnings(root).gatesToRepair, ['L1'], 'the suspension no longer stands, and the next step removes it');
  assert.deepEqual(revertLearning(root, 'L1', YES), {
    error: `L1 is suspended and ${GATES_PATH} does not hold its gate, so there is nothing to revert; if a revert stopped before recording it, retiring L1 at a terminal finishes it`,
    exitCode: 3, repairedGates: ['L1'],
  });
  assert.equal(retireLearning(root, 'L1', { interactive: AT_TERMINAL }).status, 'retired');
  assert.deepEqual(localGates(root).gates, []);
});
