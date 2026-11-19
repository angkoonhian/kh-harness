// scripts/lib/learn-land.mjs
//
// Promotion into the repository, and its undoing. A learning the owner, or
// the owner's policy, approved on this machine (`active-local`) is landed:
// its entry goes into `docs/harness/LEARNED.md` and its gate, at the action
// that approval recorded, into `.claude/kh-harness/gates.json`, both
// kit-owned, so it binds everyone who has the repository once the change is
// committed. A revert takes exactly that one entry and gate out again and
// returns the learning to `active-local`: it takes the rule out of the
// repository and leaves the approval on this machine standing. A landed
// learning judged wrong and suspended on this machine can be reverted too:
// its gate leaves the repository, where it still binds everyone else, and
// the learning ends `retired`, its local gate not restored. A revert runs
// while any trace of the learning is left in the repository (its gate at the
// recorded hash, its registry entry, or its manifest record), removes
// whatever is left, and is refused only when nothing is.
//
// A gate in the repository binds other people's agents, so landing and
// reverting take a person at an interactive terminal, as approval does: a
// policy promotes only on this machine. The landing is the owner's approval
// of the gate for the repository, so `landed` and `reverted` record
// `approvedBy: 'owner'` whoever promoted the learning here. Only the write
// needs the terminal: `planLand` and a dry run show the diff to anyone.
//
// Every repository write goes through `apply`'s path: proposals that
// `renderDiff` shows and `applyProposals` writes, inside the write allowlist
// and containment; a dry run unless `yes`; the same default-branch and
// dirty-tree refusals, with the same waivers (`writeGateRefusals`); and a
// file `classify` does not call `ours-unmodified`, which a hand edit makes
// it, is named and nothing is written. `docs/harness/RULES.md` is never
// written. The manifest records each landed learning as `{ id, gateSha256 }`.
//
// The ledger is the authority for the learning's status, as everywhere in
// the loop, and its entry precedes the learning's state change. The order of
// one step is fixed so that a stop at any point leaves a state the next run
// finishes or reports:
//
//   land    1. LEARNED.md, then gates.json      (applyProposals, in order)
//           2. the manifest: the files' hashes and the learning's record
//           3. ledger `landed`, then the learning file, then the local gate
//              set without the learning's entry  (writeTransition)
//   revert  1. a landed learning's gate written back into the local gate set
//           2. gates.json, then LEARNED.md
//           3. the manifest: the files' hashes, the learning's record kept
//           4. ledger `reverted` (and `retired`, for a suspended learning),
//              then the learning file  (writeTransition)
//           5. the manifest without the learning's record
//
// So a committed gate never stands without its registry entry: a land stops
// with at most an entry approving a gate not yet written, and a revert with
// at most an entry left for a gate already gone, each of which `detect`'s
// P5.integrity reports as failing. The local gate is removed only once the
// committed gate is in force, and written back before it leaves: the repair
// in `learn-lib.mjs` keeps a landed learning's local gate while the
// committed file does not hold it as approved.
//
// A stop anywhere is finished by the same command run again. A land stopped
// before its ledger entry finds every file already as it would write it. A
// revert keeps the manifest record until its ledger entries are written, so
// until then a trace is always left for the next revert to find; and a
// revert whose ledger entries are written in part or whole, its learning
// file or the record not yet, is recognised from the ledger's last entries
// for the learning (`revertStage`), which the next revert completes. A file
// written but not yet recorded in the manifest no longer matches it, and the
// next run names it.
//
// The repair runs only when a `learn` command or `tick` does. So after a
// branch switch to a checkout without the committed gate, or once an
// uncommitted land is discarded, the learning stays `landed` and its gate is
// enforced nowhere until the next `learn` command or `tick` writes its local
// gate back.
//
// No exported function throws. A refusal carries `exitCode: 3` and a
// failure `exitCode: 2`, the CLI contract's codes.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GATE_LIMITS, gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, harnessIdentity } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, parseRules } from '../../assets/scripts/harness-redact.mjs';
import { GATE_FILE_MAX_BYTES } from '../../assets/scripts/tool-gate.mjs';
import { applyProposals, renderDiff, writeGateRefusals } from './apply-lib.mjs';
import { gitInfo } from './git-info.mjs';
import {
  committedGates, holdLocalGate, ID_ERROR, isId, learningIn, planTransition, readFailure, readState, refuse, repairedStep,
  statusEntriesFor, unrecordedReason, writeTransition,
} from './learn-lib.mjs';
import { isInteractive, needsTerminal } from './learn-promote.mjs';
import { ACTION_KINDS } from './ledger.mjs';
import { removeLearnedEntry, upsertLearnedEntry } from './learned-registry.mjs';
import { classify, emptyManifest, MANIFEST_PATH, readManifestResult, writeManifest } from './manifest.mjs';
import { TOOL_GATE_STEP } from './propose.mjs';
import { render, STAMP_MARKER } from './render.mjs';

const KIT_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const LEARNED_TEMPLATE = new URL('../../assets/templates/LEARNED.md.tmpl', import.meta.url);

// The capability a committed gate belongs to: the gate hook's.
const CHECK_ID = 'P5.toolgate';

const REFUSED = 3;
const FAILED = 2;

// The gate file's own line saying who manages it, as the registry's
// template says it.
const GENERATED_BY = `${STAMP_MARKER} ${KIT_VERSION}. kh-harness manages this file: a hand edit makes kh-harness stop updating it and keep it on uninstall.`;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const codeOf = error => (typeof error?.code === 'string' ? error.code : 'unknown');
const optionsOf = value => (isPlainObject(value) ? value : {});
const gateNumber = id => Number(id.slice(1));

/** Whether anything, a link that leads nowhere included, is at `path`. */
function isPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const refused = error => ({ error, exitCode: REFUSED });
const failed = error => ({ error, exitCode: FAILED });
/** A result of the learnings lock or the repair with no code of its own
 * could not act. */
const withCode = result => (result.error !== undefined && result.exitCode === undefined ? { ...result, exitCode: FAILED } : result);

/**
 * `{ text }`, the kit-owned file `rel` as LF text for a change to build on,
 * or `{ text: null }` when it is absent and unrecorded; `{ error }` naming
 * it when the kit may not write it: one the manifest records whose bytes no
 * longer match, or one present that the manifest does not record.
 */
function ownedText(root, manifest, rel) {
  const state = classify(root, manifest, rel);
  if (state === 'ours-modified') {
    return { error: `${rel} no longer matches what kh-harness last wrote (a hand edit, a deletion, or a write that stopped before the manifest recorded it), so kh-harness no longer updates it; restore it from git and run again` };
  }
  if (state === 'theirs') {
    if (!isPresent(join(root, rel))) return { text: null };
    return { error: `${rel} exists and the manifest does not record kh-harness writing it, so kh-harness does not write it; move it aside and run again` };
  }
  return { text: readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n') };
}

/** `{ gates }`, the committed file's gates, none for a file not yet
 * written, or `{ error }` when the gate hook would not load every entry it
 * holds: a rewrite would drop what it does not load. */
function committedEntries(root, text) {
  if (text === null) return { gates: [] };
  const gates = committedGates(root);
  let file = null;
  try {
    file = JSON.parse(text);
  } catch {
    // not JSON: refused below
  }
  if (!isPlainObject(file) || !Array.isArray(file.gates) || file.gates.length !== gates.length) {
    return { error: `${GATES_PATH} holds an entry the gate hook does not load, so kh-harness does not rewrite it; restore it from git and run again` };
  }
  return { gates };
}

/** The gate file's text holding `gates`, in id order, or `{ error }` when
 * the gate hook would not load it whole. */
function gateFileText(gates) {
  if (gates.length > GATE_LIMITS.gatesMax) return { error: `${GATES_PATH} would hold more than ${GATE_LIMITS.gatesMax} gates, which the gate hook does not load` };
  const sorted = [...gates].sort((a, b) => gateNumber(a.id) - gateNumber(b.id));
  const text = JSON.stringify({ schema: 1, generatedBy: GENERATED_BY, gates: sorted }, null, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') > GATE_FILE_MAX_BYTES) return { error: `${GATES_PATH} would be larger than ${GATE_FILE_MAX_BYTES} bytes, which the gate hook does not load` };
  return { text };
}

const fileProposal = (path, contents, reason) => ({ kind: 'file', path, contents, step: TOOL_GATE_STEP, checkId: CHECK_ID, reason });

/** The learning's gate as the repository holds it: its content, with the
 * action its approval recorded. */
function committedGateOf(learning, action) {
  const { id, ...rest } = learning.gate;
  return { id, ...rest, action };
}

/** Whether the last status-changing ledger entries for `learning` are of
 * `kinds`, in order, each naming its content. */
function ledgerEndsWith(state, learning, kinds) {
  const tail = statusEntriesFor(state.view.entries, learning.id).slice(-kinds.length);
  return tail.length === kinds.length && tail.every((e, i) => e.kind === kinds[i] && e.contentSha256 === learning.sha256);
}

/** The action the learning's last approval granted, as the ledger records
 * it for its content. */
const approvedAction = (state, learning) =>
  statusEntriesFor(state.view.entries, learning.id).filter(e => ACTION_KINDS.includes(e.kind) && e.contentSha256 === learning.sha256).at(-1)?.action;

const LAND_REFUSAL = 'only a learning promoted on this machine is landed';

/**
 * Where landing `learning` stands: `{ updated, entries, action }`, the
 * change `writeTransition` makes and the action the committed gate takes,
 * or `{ error, exitCode }`. A learning the ledger vouches for as
 * `active-local` is landed afresh. One whose file is still `active-local`
 * while the ledger's last entry for it is already its `landed` is a land
 * stopped between that entry and the learning file, finished without
 * another entry.
 */
function landStage(state, learning) {
  const unrecorded = unrecordedReason(learning, state.view);
  const action = approvedAction(state, learning);
  const updated = { ...learning, status: 'landed' };
  if (learning.status === 'active-local' && unrecorded === null) return { updated, entries: [ownerEntry('landed', action)], action };
  if (learning.status === 'active-local' && state.view.intact && ledgerEndsWith(state, learning, ['landed'])) return { updated, entries: [], action };
  if (unrecorded !== null) return refused(unrecorded);
  return refused(`${learning.id} is ${learning.status}; ${LAND_REFUSAL}`);
}

const REVERT_REFUSAL = 'only a landed learning, or one suspended on this machine, is reverted';

/**
 * Where reverting `learning` stands: `{ updated, entries, action, fresh,
 * complete, holdsLocal }`, or `{ error, exitCode }`.
 *
 * A learning the ledger vouches for as `landed` is reverted afresh to
 * `active-local`, recorded `reverted` (`holdsLocal`: its local gate is
 * written back first); one vouched for as `suspended`, judged wrong here,
 * to `retired`, recorded `reverted` and then `retired`. Both are `fresh`.
 *
 * Otherwise the ledger's last entries for it say how far a revert got. Its
 * `reverted` written and the learning file not yet, or a suspended
 * learning's `reverted` written and `retired` not yet: the rest of the
 * entries and the learning file are written. Every entry and the learning
 * file written (`complete`): only what is left in the repository, the
 * manifest record at least, is removed.
 */
function revertStage(state, learning) {
  const unrecorded = unrecordedReason(learning, state.view);
  const action = approvedAction(state, learning);
  const toActive = { ...learning, status: 'active-local', gate: { ...learning.gate, action } };
  const toRetired = { ...learning, status: 'retired', gate: { ...learning.gate, action: 'observe' } };
  const reverted = ownerEntry('reverted', action);
  const retired = { kind: 'retired', approvedBy: 'owner' };
  const ends = kinds => state.view.intact && ledgerEndsWith(state, learning, kinds);
  const stage = (updated, entries, more = {}) => ({ updated, entries, action: updated.gate.action, fresh: false, complete: false, holdsLocal: false, ...more });

  if (unrecorded === null && learning.status === 'landed') return stage(toActive, [reverted], { fresh: true, holdsLocal: true });
  if (unrecorded === null && learning.status === 'suspended') return stage(toRetired, [reverted, retired], { fresh: true });
  if (learning.status === 'landed' && ends(['landed', 'reverted'])) return stage(toActive, []);
  if (learning.status === 'suspended' && ends(['suspended', 'reverted'])) return stage(toRetired, [retired]);
  if (learning.status === 'suspended' && ends(['suspended', 'reverted', 'retired'])) return stage(toRetired, []);
  if (unrecorded !== null) return refused(unrecorded);
  if (learning.status === 'active-local' && ends(['landed', 'reverted'])) return stage(learning, [], { complete: true });
  if (learning.status === 'retired' && ends(['suspended', 'reverted', 'retired'])) return stage(learning, [], { complete: true });
  return refused(`${learning.id} is ${learning.status}; ${REVERT_REFUSAL}`);
}

/** `{ manifest }` to build on: the one on disk, an empty one when there is
 * none, or `{ error }` for one that cannot be read, which a write would
 * replace and so lose the record of everything installed. */
function manifestToBuildOn(root) {
  const result = readManifestResult(root);
  if (result.state === 'corrupt') {
    return refused(`${MANIFEST_PATH} exists but could not be read as a valid kh-harness manifest, so nothing is written; restore it from git and run again`);
  }
  return { manifest: result.manifest ?? emptyManifest(KIT_VERSION), result };
}

/**
 * What landing `id` writes, from `state` and `manifest`: `{ learning,
 * proposals, record, transition }`, the proposals in write order and
 * `transition` the learning's change as `writeTransition` takes it, or `{
 * error, exitCode }`.
 */
function landing(root, state, manifest, id) {
  const found = learningIn(state, id);
  if (found.error) return refused(found.error);
  const { learning } = found;
  const transition = landStage(state, learning);
  if (transition.error) return transition;
  const gate = committedGateOf(learning, transition.action);
  const sha256 = gateSha256(gate);

  const learned = ownedText(root, manifest, LEARNED_PATH);
  if (learned.error) return refused(learned.error);
  const gates = ownedText(root, manifest, GATES_PATH);
  if (gates.error) return refused(gates.error);
  const committed = committedEntries(root, gates.text);
  if (committed.error) return refused(committed.error);

  const existing = committed.gates.find(g => g.id === id);
  if (existing !== undefined && (gateSha256(existing) !== sha256 || existing.action !== gate.action)) {
    return refused(`${GATES_PATH} already holds another gate ${id}, so ${id} is not landed over it`);
  }
  const file = gateFileText(existing === undefined ? [...committed.gates, gate] : committed.gates);
  if (file.error) return refused(file.error);

  const entry = {
    id, title: learning.title, why: learning.why, enforcedBy: 'hook', pointer: GATES_PATH,
    evidenceSummary: { ...learning.evidence, external: learning.external || learning.evidence.external },
    approvedSha256: sha256,
  };
  const base = learned.text ?? render(readFileSync(LEARNED_TEMPLATE, 'utf8'), { kitVersion: KIT_VERSION });
  const upserted = upsertLearnedEntry(base, entry);
  if (upserted.error) return refused(upserted.error);

  return {
    learning,
    record: { id, gateSha256: sha256 },
    transition,
    proposals: [
      fileProposal(LEARNED_PATH, upserted.text, `land learning ${id}: its entry, approving the gate's content`),
      fileProposal(GATES_PATH, file.text, `land learning ${id}: its gate, at ${gate.action} as approved`),
    ],
  };
}

/**
 * What reverting `id` writes, from `state` and `manifest`: `{ learning,
 * proposals, transition, record }`, as `landing` returns them, `record`
 * whether the manifest still records the learning, or `{ error, exitCode }`.
 *
 * A revert runs while any trace of the learning is left in the repository
 * (its gate at its content hash, its registry entry, or its manifest
 * record) and removes whatever is left; with none, it is refused, unless a
 * revert stopped after removing all of it still has ledger entries or the
 * learning file to write (`revertStage`). A gate, entry or record under its
 * id that is not this learning's is refused, never removed.
 */
function reverting(root, state, manifest, id) {
  const found = learningIn(state, id);
  if (found.error) return refused(found.error);
  const { learning } = found;
  const transition = revertStage(state, learning);
  if (transition.error) return transition;

  const gates = ownedText(root, manifest, GATES_PATH);
  if (gates.error) return refused(gates.error);
  const learned = ownedText(root, manifest, LEARNED_PATH);
  if (learned.error) return refused(learned.error);
  const committed = committedEntries(root, gates.text);
  if (committed.error) return refused(committed.error);

  const gate = committed.gates.find(g => g.id === id);
  if (gate !== undefined && gateSha256(gate) !== learning.sha256) {
    return refused(`${GATES_PATH} holds another gate ${id}, which is not this learning's to remove`);
  }
  const rule = learned.text === null ? undefined : parseRules(learned.text).rules.find(r => r.id === id);
  if (rule !== undefined && rule.approvedSha256 !== learning.sha256) {
    return refused(`${LEARNED_PATH} holds another entry ${id}, which is not this learning's to remove`);
  }
  const record = (manifest.learnings ?? []).find(l => l.id === id);
  if (record !== undefined && record.gateSha256 !== learning.sha256) {
    return refused(`${MANIFEST_PATH} records another learning ${id}, which is not this learning's to remove`);
  }

  if (gate === undefined && rule === undefined && record === undefined) {
    if (transition.fresh) {
      return refused(`${id} has no gate, registry entry or manifest record in this repository, so there is nothing to revert here; run the revert on a checkout that holds them`);
    }
    if (transition.complete) return refused(`${id} is ${learning.status}; ${REVERT_REFUSAL}`);
  }

  const proposals = [];
  if (gate !== undefined) {
    const file = gateFileText(committed.gates.filter(g => g.id !== id));
    if (file.error) return refused(file.error);
    proposals.push(fileProposal(GATES_PATH, file.text, `revert learning ${id}: remove its gate`));
  }
  if (rule !== undefined) {
    const removed = removeLearnedEntry(learned.text, id);
    if (removed.error) return refused(removed.error);
    proposals.push(fileProposal(LEARNED_PATH, removed.text, `revert learning ${id}: remove its entry`));
  }
  return { learning, proposals, transition, record: record !== undefined };
}

/** The dry run: each proposal with its diff against the repository, and
 * what `yes` would refuse. Writes nothing. */
const preview = (root, proposals, refusals) => ({
  dryRun: true,
  proposals,
  diffs: proposals.map(p => ({ path: p.path, reason: p.reason, diff: renderDiff(root, p) })),
  refusals,
});

/**
 * Writes `proposals` through `applyProposals` and the manifest after them,
 * `learnings` being the manifest's landed learnings afterwards; through
 * `write`, the learnings lock's. Returns `{ written, manifest }`, the
 * manifest as written, or `{ error, exitCode }`: a batch that stopped
 * partway is still recorded, so the
 * manifest describes what is on disk, and its learnings are left as they
 * were. A refusal of the allowlist or containment, or a lock no longer
 * held, stops it before any write.
 */
function writeRepository(root, write, manifest, proposals, learnings) {
  let result;
  try {
    write(() => {
      result = applyProposals({ root, proposals, manifest, kitVersion: KIT_VERSION });
    });
  } catch (error) {
    // Only the lock lost or `applyProposals`'s first pass throws, both
    // before any write.
    return failed(`nothing was written to the repository: ${error?.message ?? codeOf(error)}`);
  }
  const stopped = result.failed[0] ?? result.skipped.find(s => s.why !== 'unchanged');
  const next = stopped === undefined ? { ...result.manifest, learnings } : result.manifest;
  try {
    write(() => writeManifest(root, next));
  } catch (error) {
    const written = result.written.map(w => w.path);
    return failed(`${MANIFEST_PATH} could not record what was written (${codeOf(error)})${written.length ? `; on disk and not recorded: ${written.join(', ')}` : ''}`);
  }
  if (stopped !== undefined) {
    const why = result.failed[0]?.error ?? `it is ${stopped.why}`;
    return failed(`${stopped.path} could not be written (${why}); what was written before it is recorded in ${MANIFEST_PATH}, and running again finishes the step`);
  }
  return { written: result.written.map(w => w.path), manifest: next };
}

/** The refusals `yes` meets, from `writeGateRefusals`. */
function gateRefusalsFor(root, manifestResult, { allowDefaultBranch, allowDirty }, verb) {
  return writeGateRefusals({ root, git: gitInfo(root), manifestResult, allowDefaultBranch: allowDefaultBranch === true, allowDirty: allowDirty === true, verb });
}

/** A land's or a revert's ledger entry: the owner decided it at the
 * terminal, and it names the gate's action in the repository. */
const ownerEntry = (kind, action) => ({ kind, approvedBy: 'owner', action });

/** Records the step's ledger entries and the learning's new state once the
 * repository is written, through `writeTransition`; `{ error, exitCode }`
 * when that stops, saying the repository change stands. */
function recordStep(root, write, { updated, entries }, identity) {
  let written;
  try {
    written = writeTransition(root, write, readState(root), { updated, entries, identity });
  } catch (error) {
    written = { error: `it stopped partway (${codeOf(error)})` };
  }
  if (written.error === undefined) return {};
  const what = entries.length > 0 ? `recording ${entries.map(e => e.kind).join(' and ')}` : 'writing the learning file';
  return failed(`${updated.id}: the repository change is written, and ${what} on this machine did not finish (${written.error}); run the same command again to finish it`);
}

/** `{ proposals }`, what landing `id` would write, or `{ error, exitCode }`.
 * Reads only. */
export function planLand(root, id) {
  try {
    if (!isId(id)) return refused(ID_ERROR);
    const base = manifestToBuildOn(root);
    if (base.error) return base;
    const planned = landing(root, readState(root), base.manifest, id);
    return planned.error ? planned : { proposals: planned.proposals };
  } catch (error) {
    return withCode(readFailure(error));
  }
}

/**
 * Lands the learning `id`, which must be `active-local` as the ledger
 * records it, with an approver: its entry and its gate, at the action that
 * approval recorded, go into the repository, the manifest records `{ id,
 * gateSha256 }`, the ledger gets `landed` with `approvedBy: 'owner'` and
 * that action, and the learning's local gate goes, since the committed one
 * is then in force. `options` is `{ yes, interactive, allowDirty,
 * allowDefaultBranch }`. Without `yes`, writes nothing and returns `{
 * dryRun: true, proposals, diffs, refusals }`, `refusals` what `yes` would
 * meet. With it, `interactive` must be what `requireInteractive` returned
 * for a person at a terminal, or nothing is written; returns `{ ok: true,
 * id, status, action, written, repairedGates }`, or `{ error, exitCode }`.
 */
export function landLearning(root, id, options) {
  try {
    return withCode(landUnguarded(root, id, optionsOf(options)));
  } catch (error) {
    return withCode(readFailure(error));
  }
}

function landUnguarded(root, id, options) {
  if (!isId(id)) return { ...refuse(root, ID_ERROR), exitCode: REFUSED };
  const base = manifestToBuildOn(root);
  if (base.error) return { ...refuse(root, base.error), exitCode: REFUSED };
  const refusals = gateRefusalsFor(root, base.result, options, 'land');
  if (options.yes !== true) {
    const planned = landing(root, readState(root), base.manifest, id);
    return planned.error ? planned : preview(root, planned.proposals, refusals);
  }
  if (!isInteractive(options.interactive)) return { ...refuse(root, needsTerminal('landing')), exitCode: REFUSED };
  if (refusals.length > 0) return { ...refuse(root, refusals.join(' ')), exitCode: REFUSED, refusals };

  return repairedStep(root, write => {
    const state = readState(root);
    const manifest = manifestToBuildOn(root);
    if (manifest.error) return manifest;
    const planned = landing(root, state, manifest.manifest, id);
    if (planned.error) return planned;
    const { record, transition } = planned;
    const identity = harnessIdentity(root);
    const ready = planTransition(state, { ...transition, identity });
    if (ready.error) return refused(ready.error);

    const learnings = [...(manifest.manifest.learnings ?? []).filter(l => l.id !== id), record];
    const repository = writeRepository(root, write, manifest.manifest, planned.proposals, learnings);
    if (repository.error) return repository;
    const recorded = recordStep(root, write, transition, identity);
    if (recorded.error) return recorded;
    return { ok: true, id, status: transition.updated.status, action: transition.action, written: repository.written };
  });
}

/**
 * Reverts the learning `id`: exactly its gate and its entry leave the
 * repository and its record the manifest, whichever of them is left. A
 * landed learning is `active-local` again, its local gate at the approved
 * action written back before the committed one leaves, and the ledger gets
 * `reverted` with `approvedBy: 'owner'` and that action. A learning
 * suspended on this machine ends `retired` with no local gate, the ledger
 * getting `reverted` and then `retired`, both the owner's. A revert that
 * stopped partway is finished, as `revertStage` recognises it. `options`
 * and the results are as `landLearning`'s; success is `{ ok: true, id,
 * status, action, written, repairedGates }`, `action` the one its gate now
 * carries.
 */
export function revertLearning(root, id, options) {
  try {
    return withCode(revertUnguarded(root, id, optionsOf(options)));
  } catch (error) {
    return withCode(readFailure(error));
  }
}

function revertUnguarded(root, id, options) {
  if (!isId(id)) return { ...refuse(root, ID_ERROR), exitCode: REFUSED };
  const base = manifestToBuildOn(root);
  if (base.error) return { ...refuse(root, base.error), exitCode: REFUSED };
  const refusals = gateRefusalsFor(root, base.result, options, 'revert');
  if (options.yes !== true) {
    const planned = reverting(root, readState(root), base.manifest, id);
    return planned.error ? planned : preview(root, planned.proposals, refusals);
  }
  if (!isInteractive(options.interactive)) return { ...refuse(root, needsTerminal('a revert')), exitCode: REFUSED };
  if (refusals.length > 0) return { ...refuse(root, refusals.join(' ')), exitCode: REFUSED, refusals };

  return repairedStep(root, write => {
    const state = readState(root);
    const manifest = manifestToBuildOn(root);
    if (manifest.error) return manifest;
    const planned = reverting(root, state, manifest.manifest, id);
    if (planned.error) return planned;
    const { transition } = planned;
    const identity = harnessIdentity(root);
    const ready = planTransition(state, { ...transition, identity });
    if (ready.error) return refused(ready.error);

    if (transition.holdsLocal) holdLocalGate(root, write, state, id);
    // The record stays until the ledger entries are written: it is the trace
    // the next revert finishes from if this one stops before them.
    const repository = writeRepository(root, write, manifest.manifest, planned.proposals, manifest.manifest.learnings);
    if (repository.error) return repository;
    const recorded = recordStep(root, write, transition, identity);
    if (recorded.error) return recorded;
    if (planned.record) {
      const next = { ...repository.manifest, learnings: repository.manifest.learnings.filter(l => l.id !== id) };
      try {
        write(() => writeManifest(root, next));
      } catch (error) {
        return failed(`${id}: its revert is recorded, and ${MANIFEST_PATH} could not drop its record (${codeOf(error)}); run the same command again to finish it`);
      }
    }
    return { ok: true, id, status: transition.updated.status, action: transition.action, written: repository.written };
  });
}
