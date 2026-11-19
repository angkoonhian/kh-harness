// scripts/lib/learn-land.mjs
//
// Promotion into the repository, and its undoing. A learning the owner, or
// the owner's policy, approved on this machine (`active-local`) is landed:
// its entry goes into `docs/harness/LEARNED.md` and its gate, at the action
// that approval recorded, into `.claude/kh-harness/gates.json`, both
// kit-owned, so it binds everyone who has the repository once the change is
// committed. A revert takes exactly that one entry and gate out again and
// returns the learning to `active-local`: it takes the rule out of the
// repository and leaves the approval on this machine standing.
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
//   revert  1. the learning's gate written back into the local gate set
//           2. gates.json, then LEARNED.md
//           3. the manifest, without the learning's record
//           4. ledger `reverted`, then the learning file  (writeTransition)
//
// So a committed gate never stands without its registry entry: a land stops
// with at most an entry approving a gate not yet written, and a revert with
// at most an entry left for a gate already gone, each of which `detect`'s
// P5.integrity reports as failing. The local gate is removed only once the
// committed gate is in force, and written back before it leaves: the repair
// in `learn-lib.mjs` keeps a landed learning's local gate while the
// committed file does not hold it as approved. A stop before the ledger
// entry leaves the learning in its old status with the repository already
// changed and recorded, and the same command run again finds every file
// already as it would write it and finishes; a stop between the ledger
// entry and the learning file is a ledger mismatch, which `listLearnings`
// reports; a file written but not yet recorded in the manifest no longer
// matches it, and the next run names it.
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
  unrecordedReason, writeTransition,
} from './learn-lib.mjs';
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
function committedGateOf(learning, held) {
  const { id, ...rest } = learning.gate;
  return { id, ...rest, action: held.action };
}

/** `{ learning, held }`, the learning `id` the ledger vouches for, its
 * recorded state as `held`, when its status is `status`; else `{ error }`. */
function vouched(state, id, status, what) {
  const found = learningIn(state, id);
  if (found.error) return refused(found.error);
  const { learning } = found;
  const unrecorded = unrecordedReason(learning, state.view);
  if (unrecorded !== null) return refused(unrecorded);
  if (learning.status !== status) return refused(`${id} is ${learning.status}; ${what}`);
  return { learning, held: state.recorded.get(id) };
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
 * What landing `id` writes, from `state` and `manifest`: `{ learning, held,
 * proposals, record }`, the proposals in write order, or `{ error,
 * exitCode }`.
 */
function landing(root, state, manifest, id) {
  const found = vouched(state, id, 'active-local', 'only a learning promoted on this machine is landed');
  if (found.error) return found;
  const { learning, held } = found;
  const gate = committedGateOf(learning, held);
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
    learning, held,
    record: { id, gateSha256: sha256 },
    proposals: [
      fileProposal(LEARNED_PATH, upserted.text, `land learning ${id}: its entry, approving the gate's content`),
      fileProposal(GATES_PATH, file.text, `land learning ${id}: its gate, at ${gate.action} as approved`),
    ],
  };
}

/**
 * What reverting `id` writes, from `state` and `manifest`: `{ learning,
 * held, proposals }`, the proposals in write order, or `{ error, exitCode }`.
 * Only the learning's own gate and entry are taken out: one under its id
 * with other content is refused, and one already gone is nothing to remove.
 */
function reverting(root, state, manifest, id) {
  const found = vouched(state, id, 'landed', 'only a landed learning is reverted');
  if (found.error) return found;
  const { learning, held } = found;

  const gates = ownedText(root, manifest, GATES_PATH);
  if (gates.error) return refused(gates.error);
  const learned = ownedText(root, manifest, LEARNED_PATH);
  if (learned.error) return refused(learned.error);
  const committed = committedEntries(root, gates.text);
  if (committed.error) return refused(committed.error);

  const proposals = [];
  const existing = committed.gates.find(g => g.id === id);
  if (existing !== undefined && gateSha256(existing) !== learning.sha256) {
    return refused(`${GATES_PATH} holds another gate ${id}, which is not this learning's to remove`);
  }
  if (gates.text !== null) {
    const file = gateFileText(committed.gates.filter(g => g.id !== id));
    if (file.error) return refused(file.error);
    proposals.push(fileProposal(GATES_PATH, file.text, `revert learning ${id}: remove its gate`));
  }
  if (learned.text !== null) {
    const rule = parseRules(learned.text).rules.find(r => r.id === id);
    if (rule !== undefined && rule.approvedSha256 !== learning.sha256) {
      return refused(`${LEARNED_PATH} holds another entry ${id}, which is not this learning's to remove`);
    }
    const removed = removeLearnedEntry(learned.text, id);
    if (removed.error) return refused(removed.error);
    proposals.push(fileProposal(LEARNED_PATH, removed.text, `revert learning ${id}: remove its entry`));
  }
  return { learning, held, proposals };
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
 * `write`, the learnings lock's. Returns `{ written }`, or `{ error,
 * exitCode }`: a batch that stopped partway is still recorded, so the
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
  return { written: result.written.map(w => w.path) };
}

/** The refusals `yes` meets, from `writeGateRefusals`. */
function gateRefusalsFor(root, manifestResult, { allowDefaultBranch, allowDirty }, verb) {
  return writeGateRefusals({ root, git: gitInfo(root), manifestResult, allowDefaultBranch: allowDefaultBranch === true, allowDirty: allowDirty === true, verb });
}

/** Records the step's ledger entry and the learning's new state once the
 * repository is written, through `writeTransition`; `{ error, exitCode }`
 * when that stops, saying the repository change stands. */
function recordStep(root, write, { learning, held, status, kind, identity }) {
  const updated = { ...learning, status };
  const entries = [{ kind, approvedBy: held.approvedBy, action: held.action }];
  let written;
  try {
    written = writeTransition(root, write, readState(root), { updated, entries, identity });
  } catch (error) {
    written = { error: `it stopped partway (${codeOf(error)})` };
  }
  if (written.error === undefined) return {};
  return failed(`${learning.id}: the repository change is written and recorded, and recording ${kind} on this machine did not finish (${written.error}); run the same command again to finish it, and if listLearnings reports a ledger mismatch for ${learning.id}, the ledger entry was written and the learning file was not`);
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
 * gateSha256 }`, the ledger gets `landed` carrying the approval on, and the
 * learning's local gate goes, since the committed one is then in force.
 * `options` is `{ yes, allowDirty, allowDefaultBranch }`. Without `yes`,
 * writes nothing and returns `{ dryRun: true, proposals, diffs, refusals }`,
 * `refusals` what `yes` would meet. With it, returns `{ ok: true, id,
 * status, action, written, repairedGates }`, or `{ error, exitCode }`.
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
  if (refusals.length > 0) return { ...refuse(root, refusals.join(' ')), exitCode: REFUSED, refusals };

  return repairedStep(root, write => {
    const state = readState(root);
    const manifest = manifestToBuildOn(root);
    if (manifest.error) return manifest;
    const planned = landing(root, state, manifest.manifest, id);
    if (planned.error) return planned;
    const { learning, held, record } = planned;
    const identity = harnessIdentity(root);
    const updated = { ...learning, status: 'landed' };
    const ready = planTransition(state, { updated, entries: [{ kind: 'landed', approvedBy: held.approvedBy, action: held.action }], identity });
    if (ready.error) return refused(ready.error);

    const learnings = [...(manifest.manifest.learnings ?? []).filter(l => l.id !== id), record];
    const repository = writeRepository(root, write, manifest.manifest, planned.proposals, learnings);
    if (repository.error) return repository;
    const recorded = recordStep(root, write, { learning, held, status: 'landed', kind: 'landed', identity });
    if (recorded.error) return recorded;
    return { ok: true, id, status: 'landed', action: held.action, written: repository.written };
  });
}

/**
 * Reverts the landed learning `id`: exactly its gate and its entry leave
 * the repository and its record the manifest, the ledger gets `reverted`
 * carrying the approval on, and the learning is `active-local` again with
 * its local gate at the approved action, written back before the committed
 * one leaves. `options` and the results are as `landLearning`'s; success
 * is `{ ok: true, id, status, action, written, repairedGates }`.
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
  if (refusals.length > 0) return { ...refuse(root, refusals.join(' ')), exitCode: REFUSED, refusals };

  return repairedStep(root, write => {
    const state = readState(root);
    const manifest = manifestToBuildOn(root);
    if (manifest.error) return manifest;
    const planned = reverting(root, state, manifest.manifest, id);
    if (planned.error) return planned;
    const { learning, held } = planned;
    const identity = harnessIdentity(root);
    const updated = { ...learning, status: 'active-local' };
    const ready = planTransition(state, { updated, entries: [{ kind: 'reverted', approvedBy: held.approvedBy, action: held.action }], identity });
    if (ready.error) return refused(ready.error);

    holdLocalGate(root, write, state, id);
    const learnings = (manifest.manifest.learnings ?? []).filter(l => l.id !== id);
    const repository = writeRepository(root, write, manifest.manifest, planned.proposals, learnings);
    if (repository.error) return repository;
    const recorded = recordStep(root, write, { learning, held, status: 'active-local', kind: 'reverted', identity });
    if (recorded.error) return recorded;
    return { ok: true, id, status: 'active-local', action: held.action, written: repository.written };
  });
}
