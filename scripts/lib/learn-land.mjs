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
// the learning ends `retired`, its local gate not restored. A revert removes
// whatever trace of the learning is left in the repository (its gate at the
// recorded hash, its registry entry, its manifest record). A landed or
// suspended learning with no trace in this checkout, as after an
// uncommitted land was discarded, is still reverted, on this machine only:
// no file is written, and the dry run and the result say so. A learning that
// has since moved on, retired or demoted, is reverted only to remove a trace
// it left; a trace under its id at another hash is refused, never removed.
// For a revert, a learned file that is absent, or holds nothing of the
// learning, is accepted as it is; a hand-edited one is never written, and
// while it still holds the learning the revert says that taking it out by
// hand lets the revert go on.
//
// The working tree is not the only witness. Whenever a revert finds the
// learning's gate absent from the working tree's gate file, however many
// other traces are left, it reads the gate file in the commit HEAD names
// (`committedText`). That state is not wrong in itself: it follows every
// revert until the owner commits, and a revert that stopped part-way. But
// when the commit holds the gate at the learning's hash, the gate is still
// committed for everyone, so the revert goes on and its notes say first, in
// the dry run and the result alike, that this run did not remove the gate,
// that it was already gone, that the commit still holds it and does until
// its removal is committed, and that `git status` shows the files; for a
// learning the revert retires, also that restoring the file from the commit
// puts the gate back in force on this machine, its suspension being gone.
// With no trace in this checkout as well, one note says both. When the
// commit cannot be read, or holds a gate file larger than the gate hook
// loads, the notes say so and why. A revert that removes the gate from the
// working tree itself needs no such note.
//
// A gate in the repository binds other people's agents, so landing and
// reverting pass the terminal check (`tty.mjs`), as approval does: a policy
// promotes only on this machine. The landing is the owner's approval of the
// gate for the repository, so `landed` and `reverted` record
// `approvedBy: 'owner'` whoever promoted the learning here. Only the write
// needs the terminal: a dry run shows the diff to anyone. The write shows
// it too, made under the lock from the very proposals it then writes, so
// what the owner reads on the run that writes is what was written. A
// landing also records the hash of the learning's title, why and evidence
// where no earlier ledger entry did, since its diff shows them.
//
// The registry entry a landing writes approves the gate twice over: its
// content, by hash, and its action, by name (`learned-registry.mjs`). An
// entry landed before the kit wrote the action has none; no step here
// rewrites another learning's entry, so it stays as it is until its own
// learning is reverted and landed again, and `detect` reports it meanwhile.
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
//           2. gates.json, then LEARNED.md, when either holds a trace
//           3. the manifest: the files' hashes, the learning's record kept
//           4. ledger `reverted` (and `retired`, for a suspended learning or
//              one retired with its gate still committed), then the
//              learning file  (writeTransition)
//           5. the manifest without the learning's record, when it had one
//
// So a committed gate never stands without its registry entry: a land stops
// with at most an entry approving a gate not yet written, and a revert with
// at most an entry left for a gate already gone, each of which `detect`'s
// P5.integrity reports as failing. The local gate is removed only once the
// committed gate is in force, and written back before it leaves: the repair
// in `learn-lib.mjs` keeps a landed learning's local gate while the
// committed file does not hold it as approved.
//
// A stop anywhere is finished by the same command run again:
//
//   - A file written and not yet recorded in the manifest (a process killed
//     between the two) is recognised when it is exactly what this step makes
//     from the file the manifest records, or from no file where it records
//     none (`ownedFile`); the step then goes on from the recorded file and
//     records the one on disk. Any other difference is a hand edit, refused.
//   - A land stopped before its ledger entry finds every file already as it
//     would write it; one stopped between its `landed` entry and the
//     learning file is recognised from the ledger (`landStage`), and a
//     revert of it says that the land run again finishes it.
//   - A revert keeps the manifest record until its ledger entries are
//     written, so until then a trace is always left for the next revert to
//     find. One whose ledger entries are written in part or whole, its
//     learning file not yet, is recognised from the ledger's last entries
//     for the learning (`revertStage`): `reverted` alone after a landed,
//     suspended or retired learning's last entry, or `reverted` and
//     `retired` after a suspended one's, and only what is missing is
//     written. A record left once every entry is
//     written is removed by the next revert whatever the learning's status
//     has become since, the ledger holding a `reverted` for its content
//     after its last `landed`.
//   - Retiring a landed or suspended learning whose gate is still committed
//     is refused (`learn-promote.mjs`), since retiring writes no file; one
//     retired so before that refusal is reverted, recorded `reverted` and
//     `retired` again, and its gate taken out.
//
// The repair runs only when a `learn` command or `tick` does. So after a
// branch switch to a checkout without the committed gate, or once an
// uncommitted land is discarded, the learning stays `landed` and its gate is
// enforced nowhere until the next `learn` command or `tick` writes its local
// gate back; a revert then returns it to `active-local` on this machine.
//
// No exported function throws. Every error carries its exit code, given by
// `refused` (3) or `failed` (2) as `learn-lib.mjs` assigns them.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GATE_LIMITS, gateSha256, parseGates } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, harnessIdentity } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, parseRules } from '../../assets/scripts/harness-redact.mjs';
import { GATE_FILE_MAX_BYTES } from '../../assets/scripts/tool-gate.mjs';
import { applyProposals, committedText, renderDiff, writeGateRefusals } from './apply-lib.mjs';
import { gitInfo } from './git-info.mjs';
import {
  codeOf, failed, holdLocalGate, ID_ERROR, isId, isPlainObject, learningIn, planTransition, readFailure, readState, refuse, refused,
  repairedStep, statusEntriesFor, unrecordedReason, writeTransition,
} from './learn-lib.mjs';
import { isInteractive, needsTerminal } from './learn-promote.mjs';
import { ACTION_KINDS } from './ledger.mjs';
import { removeLearnedEntry, renderLearnedEntry, upsertLearnedEntry } from './learned-registry.mjs';
import { classify, emptyManifest, KIT_VERSION, MANIFEST_PATH, readManifestResult, sha256, writeManifest } from './manifest.mjs';
import { TOOL_GATE_STEP } from './propose.mjs';
import { render, STAMP_MARKER } from './render.mjs';

const LEARNED_TEMPLATE = new URL('../../assets/templates/LEARNED.md.tmpl', import.meta.url);

// The capability a committed gate belongs to: the gate hook's.
const CHECK_ID = 'P5.toolgate';

// The gate file's own line saying who manages it, as the registry's
// template says it.
const GENERATED_BY = `${STAMP_MARKER} ${KIT_VERSION}. kh-harness manages this file: a hand edit makes kh-harness stop updating it and keep it on uninstall.`;

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

/** `result`, an error met before the lock is taken, as the step returns
 * it: on the `--yes` path after the repair every step that writes owes
 * (`refuse`), and as it is on a dry run, which writes nothing anywhere, the
 * data directory included. */
const beforeLock = (root, options, result) => (options.yes === true ? refuse(root, result) : result);

/** `{ gates }`, the committed file's gates as `state` read them, none for a
 * file not yet written, or `{ error }` when the gate hook would not load
 * every entry the file's `text` holds: a rewrite would drop what it does
 * not load. */
function committedEntries(state, text) {
  if (text === null) return { gates: [] };
  const gates = state.committed;
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

const modifiedRefusal = rel => `${rel} no longer matches what kh-harness last wrote (a hand edit, a deletion, or a write that stopped before the manifest recorded it), so kh-harness no longer updates it; restore it from git and run again`;
const unrecordedRefusal = rel => `${rel} exists and the manifest does not record kh-harness writing it, so kh-harness does not write it; move it aside and run again`;

/**
 * The kit-owned file `rel` for a step to build on: `{ text, adopt }`, `text`
 * the LF text the manifest records, null when the file is absent and
 * unrecorded, and `adopt`, when not null, the manifest entry the step must
 * record for the file as it is on disk; or `{ error }` naming the file when
 * the kit may not write it.
 *
 * A file on disk the manifest does not match may be this very step's own
 * write, left by a run stopped between writing it and writing the manifest.
 * `step.forward(text)` is the file this step makes from the recorded `text`
 * (null for no file), and `step.candidates(current)` the texts the recorded
 * file may have been, given the file on disk. When one of them is the
 * recorded file, by the manifest's hash, or is no file where the manifest
 * records none, and the step makes exactly the file on disk from it, the
 * step goes on from it. Any other difference is refused, so a hand edit is
 * never built on.
 */
function ownedFile(root, manifest, rel, step) {
  const state = classify(root, manifest, rel);
  const abs = join(root, rel);
  if (state === 'ours-unmodified') return { text: readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'), adopt: null };
  if (state === 'theirs' && !isPresent(abs)) return { text: null, adopt: null };
  const refusal = { error: state === 'ours-modified' ? modifiedRefusal(rel) : unrecordedRefusal(rel) };
  let raw;
  try {
    raw = readFileSync(abs);
  } catch {
    return refusal;
  }
  const current = raw.toString('utf8');
  const recordedSha256 = (manifest.files ?? []).find(f => f.path === rel)?.sha256;
  for (const candidate of step.candidates(current)) {
    const isRecorded = candidate === null ? state === 'theirs' : state === 'ours-modified' && sha256(candidate) === recordedSha256;
    if (isRecorded && step.forward(candidate) === current) return { text: candidate, adopt: { path: rel, sha256: sha256(raw) } };
  }
  return refusal;
}

/** The gates a gate file's text holds, none for no file. */
const gatesIn = text => (text === null ? [] : parseGates(text).gates);

/** The gates to build on in the gate file `file` (`ownedFile`'s shape): the
 * file's own, read as the gate hook reads it from disk, or the recorded
 * text's, for a file adopted from a stopped run; `{ error }` when the hook
 * would not load every entry the file on disk holds. */
const baseGates = (state, file) => (file.adopt !== null ? { gates: gatesIn(file.text) } : committedEntries(state, file.text));

/** The manifest with `adopted` (`ownedFile`'s `adopt`s) recorded. */
function withAdopted(manifest, adopted) {
  const files = [...(manifest.files ?? [])];
  for (const { path, sha256: hash } of adopted) {
    const at = files.findIndex(f => f.path === path);
    if (at === -1) files.push({ path, sha256: hash, step: TOOL_GATE_STEP, writtenAt: new Date().toISOString() });
    else files[at] = { ...files[at], sha256: hash };
  }
  return { ...manifest, files };
}

const templateText = () => render(readFileSync(LEARNED_TEMPLATE, 'utf8'), { kitVersion: KIT_VERSION });
const textOr = result => (typeof result?.text === 'string' ? result.text : null);

/** What a land does to the registry, as `ownedFile` takes it: it adds
 * `entry`. Before a stopped land's write, the registry was the file on disk
 * without the entry, or, when the entry went at the end, that without the
 * blank line before it; or no file at all. */
const registryLand = entry => ({
  forward: text => textOr(upsertLearnedEntry(text ?? templateText(), entry)),
  candidates: current => {
    const removed = removeLearnedEntry(current, entry.id);
    if (removed.error || !removed.removed) return [null];
    return [null, removed.text, removed.text.endsWith('\n\n') ? removed.text.slice(0, -1) : removed.text];
  },
});

/** What a revert does to the registry: it removes `entry`'s section. Before
 * a stopped revert's write, the section stood before one of the file's
 * level-2 headings, or at its end, as a landing writes it now or as one
 * wrote it before entries named their action. */
const registryRevert = entry => ({
  forward: text => (text === null ? null : textOr(removeLearnedEntry(text, entry.id))),
  candidates: current => {
    const starts = [...current.matchAll(/^## /gm)].map(m => m.index);
    return [entry, { ...entry, approvedAction: undefined }].map(e => textOr(renderLearnedEntry(e))).filter(section => section !== null)
      .flatMap(section => [...starts.map(at => current.slice(0, at) + section + '\n' + current.slice(at)), current + section, current + '\n' + section]);
  },
});

/** What a land does to the gate file: it holds `gate`. Before a stopped
 * land's write, it held the same gates without it, or there was no file. */
const gateFileLand = gate => ({
  forward: text => textOr(gateFileText([...gatesIn(text).filter(g => g.id !== gate.id), gate])),
  candidates: current => [null, textOr(gateFileText(gatesIn(current).filter(g => g.id !== gate.id)))],
});

/** What a revert does to the gate file: it drops `gate`. Before a stopped
 * revert's write, it held the same gates and `gate`. */
const gateFileRevert = gate => ({
  forward: text => (text === null ? null : textOr(gateFileText(gatesIn(text).filter(g => g.id !== gate.id)))),
  candidates: current => [textOr(gateFileText([...gatesIn(current).filter(g => g.id !== gate.id), gate]))],
});

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
  if (learning.status === 'active-local' && unrecorded === null) return { updated, entries: [{ ...ownerEntry('landed', action), bindsProse: true }], action };
  if (learning.status === 'active-local' && state.view.intact && ledgerEndsWith(state, learning, ['landed'])) return { updated, entries: [], action };
  if (unrecorded !== null) return refused(unrecorded);
  return refused(`${learning.id} is ${learning.status}; ${LAND_REFUSAL}`);
}

const REVERT_REFUSAL = 'only a learning landed or suspended on this machine, or one this machine landed that has left its gate, registry entry or manifest record in this repository, is reverted';

/**
 * Where reverting `learning` stands: `{ updated, entries, action,
 * holdsLocal, alone }`, or `{ error, exitCode }`. `traced` is whether any
 * trace of it is left in this checkout: its gate at its content hash, its
 * registry entry, or its manifest record.
 *
 * A learning the ledger vouches for as `landed` is reverted afresh to
 * `active-local`, recorded `reverted` (`holdsLocal`: its local gate is
 * written back first); one vouched for as `suspended`, judged wrong here,
 * to `retired`, recorded `reverted` and then `retired`. Either goes ahead
 * with no trace left (`alone`), as after a land that was never committed
 * and was discarded: nothing in this checkout is written, and the change is
 * to this machine only.
 *
 * Otherwise the ledger's last entries for it say how far a revert got: its
 * `reverted` written and the learning file not yet, or a suspended or
 * retired learning's `reverted` written and `retired` not yet, and the rest
 * is written. A learning that is neither landed nor suspended any more, with a
 * trace left, has the trace removed: with no new entry when a `reverted`
 * for its content follows its last `landed`, whatever status it reached
 * since; and recorded `reverted` then `retired` when it was retired
 * without one, so it stays retired. A land stopped before its learning file
 * is refused, naming the land that finishes it.
 */
function revertStage(state, learning, traced) {
  const { id, status } = learning;
  const unrecorded = unrecordedReason(learning, state.view);
  const action = approvedAction(state, learning);
  const toActive = { ...learning, status: 'active-local', gate: { ...learning.gate, action } };
  const toRetired = { ...learning, status: 'retired', gate: { ...learning.gate, action: 'observe' } };
  const reverted = ownerEntry('reverted', action);
  const retired = { kind: 'retired', approvedBy: 'owner' };
  const ends = kinds => state.view.intact && ledgerEndsWith(state, learning, kinds);
  const stage = (updated, entries, more = {}) => ({ updated, entries, action: updated.gate.action, holdsLocal: false, alone: false, ...more });
  const own = statusEntriesFor(state.view.entries, id).filter(e => e.contentSha256 === learning.sha256);
  const lastLanded = own.findLastIndex(e => e.kind === 'landed');
  const revertedSinceLanding = lastLanded !== -1 && own.slice(lastLanded + 1).some(e => e.kind === 'reverted');

  if (unrecorded === null && status === 'landed') return stage(toActive, [reverted], { holdsLocal: true, alone: !traced });
  if (unrecorded === null && status === 'suspended') return stage(toRetired, [reverted, retired], { alone: !traced });
  if (status === 'landed' && ends(['landed', 'reverted'])) return stage(toActive, []);
  if (status === 'suspended' && ends(['suspended', 'reverted'])) return stage(toRetired, [retired]);
  if (status === 'suspended' && ends(['suspended', 'reverted', 'retired'])) return stage(toRetired, []);
  if (status === 'retired' && ends(['retired', 'reverted'])) return stage(learning, [retired]);
  if (status === 'active-local' && ends(['landed'])) {
    return refused(`${id}: a land of it stopped before its learning file was written; running \`learn land ${id} --yes\` again at a terminal finishes it`);
  }
  if (unrecorded !== null) return refused(unrecorded);
  if (traced && revertedSinceLanding) return stage(learning, []);
  if (traced && status === 'retired' && lastLanded !== -1) return stage(learning, [reverted, retired]);
  return refused(`${id} is ${status}; ${REVERT_REFUSAL}`);
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

/** The registry entry the repository holds for `learning`, approving the
 * gate whose content hash is `approvedSha256` at `approvedAction`. */
const learnedEntry = (learning, approvedSha256, approvedAction) => ({
  id: learning.id, title: learning.title, why: learning.why, enforcedBy: 'hook', pointer: GATES_PATH,
  evidenceSummary: { ...learning.evidence, external: learning.external || learning.evidence.external },
  approvedSha256, approvedAction,
});

/**
 * What landing `id` writes, from `state` and `manifest`: `{ learning,
 * proposals, record, transition, adopted }`, the proposals in write order,
 * `transition` the learning's change as `writeTransition` takes it and
 * `adopted` the files a stopped run of this land left for the manifest to
 * record (`ownedFile`), or `{ error, exitCode }`.
 */
function landing(root, state, manifest, id) {
  const found = learningIn(state, id);
  if (found.error) return found;
  const { learning } = found;
  const transition = landStage(state, learning);
  if (transition.error) return transition;
  const gate = committedGateOf(learning, transition.action);
  const approvedSha256 = gateSha256(gate);
  const entry = learnedEntry(learning, approvedSha256, gate.action);

  const learned = ownedFile(root, manifest, LEARNED_PATH, registryLand(entry));
  if (learned.error) return refused(learned.error);
  const gates = ownedFile(root, manifest, GATES_PATH, gateFileLand(gate));
  if (gates.error) return refused(gates.error);
  const committed = baseGates(state, gates);
  if (committed.error) return refused(committed.error);

  const existing = committed.gates.find(g => g.id === id);
  if (existing !== undefined && (gateSha256(existing) !== approvedSha256 || existing.action !== gate.action)) {
    return refused(`${GATES_PATH} already holds another gate ${id}, so ${id} is not landed over it`);
  }
  const file = gateFileText(existing === undefined ? [...committed.gates, gate] : committed.gates);
  if (file.error) return refused(file.error);
  const upserted = upsertLearnedEntry(learned.text ?? templateText(), entry);
  if (upserted.error) return refused(upserted.error);

  return {
    learning,
    record: { id, gateSha256: approvedSha256 },
    transition,
    adopted: [learned.adopt, gates.adopt].filter(a => a !== null),
    proposals: [
      fileProposal(LEARNED_PATH, upserted.text, `land learning ${id}: its entry, approving the gate's content at ${gate.action}`),
      fileProposal(GATES_PATH, file.text, `land learning ${id}: its gate, at ${gate.action} as approved`),
    ],
  };
}

/**
 * What reverting `id` writes, from `state` and `manifest`: `{ learning,
 * proposals, transition, adopted, record, notes }`, as `landing` returns
 * them, `record` whether the manifest still records the learning and
 * `notes` what the step does besides the diffs, or `{ error, exitCode }`.
 * Whatever trace of the learning is left (its gate at its content hash, its
 * registry entry, its manifest record) is removed; whether the revert goes
 * ahead is `revertStage`'s to say, and a learning no revert can take is
 * refused before any file is read. A gate, entry or record under its id
 * that is not this learning's is refused, never removed.
 *
 * A learned file the kit may not write any more, a hand edit for one, is
 * left alone when it holds nothing under the learning's id; one that does
 * is refused, saying that taking the learning out of it by hand lets the
 * revert go on. Whenever the working tree's gate file does not hold the
 * learning's gate, whatever other trace is left, the commit HEAD names is
 * read too (`committedText`): a gate there at the learning's hash is still
 * committed for everyone, so the notes say first that this run did not
 * remove it, it was already gone, and that it stays committed until its
 * removal is; a commit that cannot be read is noted with the reason.
 */
function reverting(root, state, manifest, id) {
  const found = learningIn(state, id);
  if (found.error) return found;
  const { learning } = found;
  const early = revertStage(state, learning, true);
  if (early.error) return early;
  const gateOf = committedGateOf(learning, approvedAction(state, learning));

  const gates = revertFile(root, manifest, GATES_PATH, gateFileRevert(gateOf), text => holdsGateId(text, id), id);
  if (gates.error) return refused(gates.error);
  const learned = revertFile(root, manifest, LEARNED_PATH, registryRevert(learnedEntry(learning, learning.sha256, gateOf.action)),
    text => parseRules(text).rules.some(r => r.id === id), id);
  if (learned.error) return refused(learned.error);
  const committed = baseGates(state, gates);
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

  const transition = revertStage(state, learning, gate !== undefined || rule !== undefined || record !== undefined);
  if (transition.error) return transition;
  const isOurs = g => g.id === id && gateSha256(g) === learning.sha256;
  const head = state.committed.some(isOurs) ? null : committedText(root, GATES_PATH, GATE_FILE_MAX_BYTES);
  const notes = revertNotes(id, transition, head, isOurs);

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
  return { learning, proposals, transition, adopted: [gates.adopt, learned.adopt].filter(a => a !== null), record: record !== undefined, notes };
}

/** Whether a gate file's text has an entry under `id`; text that is not a
 * gate file may, as far as anyone can tell. */
function holdsGateId(text, id) {
  try {
    const file = JSON.parse(text);
    return !isPlainObject(file) || !Array.isArray(file.gates) || file.gates.some(e => !isPlainObject(e) || e.id === id);
  } catch {
    return true;
  }
}

/**
 * A learned file for a revert, as `ownedFile` reads it; or, when the kit
 * may not write it and it holds nothing under `id` (`holdsId`), or it is
 * gone, no file to touch, since there is nothing of the learning in it to
 * take out. A file that does hold something under `id` is refused, saying
 * what lets the revert go on.
 */
function revertFile(root, manifest, rel, step, holdsId, id) {
  const file = ownedFile(root, manifest, rel, step);
  if (!file.error) return file;
  let text;
  try {
    text = readFileSync(join(root, rel), 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? { text: null, adopt: null } : file;
  }
  if (!holdsId(text)) return { text: null, adopt: null };
  return { error: `${file.error}; or, if it is to stay as it is, take ${id} out of it by hand and run \`learn revert ${id} --yes\` again, which then finds nothing of ${id} in it and goes on` };
}

/**
 * What a revert tells the owner besides its diffs, given the gate file at
 * HEAD (`committedText`'s answer) when the working tree's gate file had
 * already lost the learning's gate, or `null` when it had not, and so this
 * run removes the gate itself and needs no note. Each note is true of the
 * state it is shown in, and one note covers both facts where a revert with
 * no trace in this checkout meets a commit still holding the gate.
 */
function revertNotes(id, transition, head, isOurs) {
  if (head === null) return [];
  const retiring = transition.updated.status === 'retired';
  const outcome = retiring ? 'it is retired' : `it is active-local again, its local gate at ${transition.action}`;
  const alone = `nothing in this checkout holds ${id}, so reverting it writes no file and changes it on this machine only: ${outcome}`;
  const backInForce = retiring ? ', and there it binds this machine again, since its suspension goes with this revert' : '';
  const committedHere = head.text !== undefined && gatesIn(head.text).some(isOurs);
  if (committedHere) {
    const stillCommitted = `this run does not remove ${id}'s gate from the working tree: it was already gone from ${GATES_PATH}; `
      + 'the commit this branch is on still holds it, and the gate stays committed for everyone until that removal is committed; git status shows the files concerned'
      + (retiring ? `; restoring ${GATES_PATH} from that commit puts the gate back in force on this machine too, since its suspension goes with this revert` : '');
    return [transition.alone ? `${alone}. ${stillCommitted[0].toUpperCase()}${stillCommitted.slice(1)}` : stillCommitted];
  }
  const notes = [];
  if (head.tooLarge) notes.push(`whether the commit this branch is on still holds ${id}'s gate could not be checked (the committed ${GATES_PATH} is larger than the gate hook loads)`);
  if (head.unknown !== undefined) notes.push(`whether the commit this branch is on still holds ${id}'s gate could not be checked (${head.unknown})`);
  if (transition.alone) notes.push(`${alone}; if another branch holds the landing, the gate is still committed there${backInForce}`);
  return notes;
}

/** Each of `proposals` with its diff against the repository as it is now:
 * what a dry run shows, and what the write shows of the same proposals
 * before it writes them. */
const diffsOf = (root, proposals) => proposals.map(p => ({ path: p.path, reason: p.reason, diff: renderDiff(root, p) }));

/** The dry run: each proposal with its diff against the repository, what
 * `yes` would refuse, and `notes`, what else the step would do. Writes
 * nothing. */
const preview = (root, proposals, refusals, notes) => ({ dryRun: true, proposals, diffs: diffsOf(root, proposals), refusals, notes });

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

/**
 * Lands the learning `id`, which must be `active-local` as the ledger
 * records it, with an approver: its entry and its gate, at the action that
 * approval recorded, go into the repository, the manifest records `{ id,
 * gateSha256 }`, the ledger gets `landed` with `approvedBy: 'owner'` and
 * that action, and the learning's local gate goes, since the committed one
 * is then in force. `options` is `{ yes, interactive, allowDirty,
 * allowDefaultBranch }`. Without `yes`, writes nothing and returns `{
 * dryRun: true, proposals, diffs, refusals, notes }`, `refusals` what `yes`
 * would meet and `notes` what else the step would do. With it,
 * `interactive` must be what `requireInteractive` returned where its check
 * passes, or nothing is written; returns `{ ok: true, id, status, action,
 * written, proposals, diffs, repairedGates }`, `proposals` what was written
 * and `diffs` their diffs against the repository as it was just before, or
 * `{ error, exitCode }`.
 */
export function landLearning(root, id, options) {
  try {
    return landUnguarded(root, id, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function landUnguarded(root, id, options) {
  if (!isId(id)) return beforeLock(root, options, failed(ID_ERROR));
  const base = manifestToBuildOn(root);
  if (base.error) return beforeLock(root, options, base);
  const refusals = gateRefusalsFor(root, base.result, options, 'land');
  if (options.yes !== true) {
    const planned = landing(root, readState(root), base.manifest, id);
    return planned.error ? planned : preview(root, planned.proposals, refusals, []);
  }
  if (!isInteractive(options.interactive)) return refuse(root, needsTerminal('landing'));
  if (refusals.length > 0) return { ...refuse(root, refused(refusals.join(' '))), refusals };

  return repairedStep(root, write => {
    const state = readState(root);
    const manifest = manifestToBuildOn(root);
    if (manifest.error) return manifest;
    const planned = landing(root, state, manifest.manifest, id);
    if (planned.error) return planned;
    const { record, transition } = planned;
    const identity = harnessIdentity(root);
    const ready = planTransition(state, { ...transition, identity });
    if (ready.error) return ready;

    const diffs = diffsOf(root, planned.proposals);
    const learnings = [...(manifest.manifest.learnings ?? []).filter(l => l.id !== id), record];
    const repository = writeRepository(root, write, withAdopted(manifest.manifest, planned.adopted), planned.proposals, learnings);
    if (repository.error) return repository;
    const recorded = recordStep(root, write, transition, identity);
    if (recorded.error) return recorded;
    return { ok: true, id, status: transition.updated.status, action: transition.action, written: repository.written, proposals: planned.proposals, diffs };
  });
}

/**
 * Reverts the learning `id`: exactly its gate and its entry leave the
 * repository and its record the manifest, whichever of them is left. A
 * landed learning is `active-local` again, its local gate at the approved
 * action written back before the committed one leaves, and the ledger gets
 * `reverted` with `approvedBy: 'owner'` and that action. A learning
 * suspended on this machine ends `retired` with no local gate, the ledger
 * getting `reverted` and then `retired`, both the owner's. Either with no
 * trace in this checkout writes no file, and `notes` say so; whenever the
 * working tree had already lost the gate, they also say whether the commit
 * HEAD names still holds it, as `reverting` reads it. A learning that
 * moved on since its landing has the trace it left removed. A revert that
 * stopped partway is finished, as `revertStage` recognises it. `options`
 * and the results are as `landLearning`'s; success is `{ ok: true, id,
 * status, action, written, proposals, diffs, notes, repairedGates }`,
 * `action` the one its gate now carries and `notes` the dry run's.
 */
export function revertLearning(root, id, options) {
  try {
    return revertUnguarded(root, id, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function revertUnguarded(root, id, options) {
  if (!isId(id)) return beforeLock(root, options, failed(ID_ERROR));
  const base = manifestToBuildOn(root);
  if (base.error) return beforeLock(root, options, base);
  const refusals = gateRefusalsFor(root, base.result, options, 'revert');
  if (options.yes !== true) {
    const planned = reverting(root, readState(root), base.manifest, id);
    return planned.error ? planned : preview(root, planned.proposals, refusals, planned.notes);
  }
  if (!isInteractive(options.interactive)) return refuse(root, needsTerminal('a revert'));
  if (refusals.length > 0) return { ...refuse(root, refused(refusals.join(' '))), refusals };

  return repairedStep(root, write => {
    const state = readState(root);
    const manifest = manifestToBuildOn(root);
    if (manifest.error) return manifest;
    const planned = reverting(root, state, manifest.manifest, id);
    if (planned.error) return planned;
    const { transition } = planned;
    const identity = harnessIdentity(root);
    const ready = planTransition(state, { ...transition, identity });
    if (ready.error) return ready;

    const diffs = diffsOf(root, planned.proposals);
    if (transition.holdsLocal) holdLocalGate(root, write, state, id);
    // The record stays until the ledger entries are written: it is the trace
    // the next revert finishes from if this one stops before them. With no
    // file to change, nothing in the repository is written here at all.
    let current = manifest.manifest;
    let written = [];
    if (planned.proposals.length > 0) {
      const repository = writeRepository(root, write, withAdopted(current, planned.adopted), planned.proposals, current.learnings);
      if (repository.error) return repository;
      current = repository.manifest;
      written = repository.written;
    }
    const recorded = recordStep(root, write, transition, identity);
    if (recorded.error) return recorded;
    if (planned.record) {
      const next = { ...current, learnings: current.learnings.filter(l => l.id !== id) };
      try {
        write(() => writeManifest(root, next));
      } catch (error) {
        return failed(`${id}: its revert is recorded, and ${MANIFEST_PATH} could not drop its record (${codeOf(error)}); run the same command again to finish it`);
      }
    }
    return { ok: true, id, status: transition.updated.status, action: transition.action, written, proposals: planned.proposals, diffs, notes: planned.notes };
  });
}
