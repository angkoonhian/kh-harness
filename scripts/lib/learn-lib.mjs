// scripts/lib/learn-lib.mjs
//
// A learning's life on this machine. A model drafts one small gate for a
// recurring failure; this module validates the draft, replays the gate
// against the recorded sessions and, when the replay passes, puts it in this
// machine's local gate set with action `observe`, where it logs what it would
// have done and changes nothing. What moves it past `observe`, and back, is
// `learn-promote.mjs`; the tables that decide what each status allows, and
// the repair that holds the local gate set to them, are here, since both
// halves depend on them.
//
// A draft is untrusted, model-written input: every field is checked before
// anything is stored, and an error is fixed text naming the field and the
// rule broken, never the value. Everything this module writes goes to the
// repository's per-machine data directory; it reads the repository and
// never writes inside it.
//
// The ledger, not a learning's file, is the authority for its status and for
// the action its gate may carry: the file is covered by no hash. Every
// transition is written ledger first, then the learning, then the local gate
// set, so an interrupted step leaves a ledger entry with less in force than
// it says, never a gate in force that the ledger does not record.
//
// The gate hook enforces whatever the local gate set holds, and anything
// running as this user can write it. So every step that writes, refused or
// not, first brings the set into line with what the ledger grants and
// reports the ids it changed as `repairedGates`: a gate the ledger does not
// grant is removed even while the ledger is broken, and one it grants is
// restored only while it is intact. "Nothing was written" in an error speaks
// of the step, never of that repair. No exported function throws.
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { GATE_LIMITS, gateSha256, validateGate } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, harnessIdentity, LOCAL_GATES_FILE, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { maskText, stripUnsafe } from '../../assets/scripts/harness-redact.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { FAILURES_PATH, parseFailures } from './failures-evidence.mjs';
import { LOCKED, withFileLock } from './file-lock.mjs';
import { appendLedger, isApprover, readLedger, verifyLedger } from './ledger.mjs';
import { FAILURE_EVENT, findRecurrences, sessionIds, SUCCESS_EVENT, TOOL_FIELD } from './recurrence.mjs';
import { replayGate } from './replay.mjs';
import { readIfPresent } from './scan.mjs';

const STATUSES = new Set(['candidate', 'rejected', 'trial', 'active-local', 'landed', 'suspended', 'retired']);

// The actions a learning's gate may carry in each status; one whose gate is
// in force nowhere keeps it at `observe`. A status absent here allows none,
// so a learning file in it does not read back.
const GATE_ACTIONS = Object.freeze({
  candidate: Object.freeze(['observe']),
  rejected: Object.freeze(['observe']),
  trial: Object.freeze(['observe']),
  'active-local': Object.freeze(['warn', 'block']),
  suspended: Object.freeze(['observe']),
  retired: Object.freeze(['observe']),
});

/** The actions a learning's gate may carry while the learning is in
 * `status`; none for a status this module does not hold gates in. */
export function gateActionsFor(status) {
  return Object.hasOwn(GATE_ACTIONS, status) ? GATE_ACTIONS[status] : [];
}

// The status each ledger kind leaves a learning in; a kind absent here, such
// as `wrong`, changes no status. No kind leads out of `suspended` or
// `retired`: both are terminal.
const STATUS_AFTER = Object.freeze({
  proposed: 'candidate',
  replayed: 'candidate',
  trial: 'trial',
  rejected: 'rejected',
  promoted: 'active-local',
  demoted: 'trial',
  suspended: 'suspended',
  retired: 'retired',
});

// A learning in one of these no longer stands for its signature, so a new
// draft for the signature may be made.
export const SETTLED = new Set(['rejected', 'retired']);

// The statuses whose gate lives in the local gate set.
const LOCAL_GATE_STATUSES = new Set(['trial', 'active-local']);

// The statuses whose learning a local suspension of its committed gate
// stands for.
const SUSPENDING = new Set(['suspended', 'retired']);

const ABOVE_OBSERVE = new Set(['warn', 'block']);

const LEARNINGS_DIR = 'learnings';
// The highest id ever assigned on this machine for this repository, so the
// number of a rejected or removed learning is never assigned again.
const ID_COUNTER_FILE = 'learning-ids.json';
const LOCK_FILE = 'learnings.lock';

export const FIRING_EVENT = 'gate_firing';

const TITLE_MAX = 120;
const WHY_MAX = 300;
const ID_NUMBER_MAX = 999_999_999;

const ID = /^L([1-9][0-9]{0,8})$/;
const LEARNING_FILE = /^(L[1-9][0-9]{0,8})\.json$/;
const SIGNATURE = /^[0-9a-f]{16}$/;
const LINE_BREAK = /[\n\p{Zl}\p{Zp}]/u;
const DRAFT_KEYS = new Set(['signature', 'title', 'why', 'gate']);

export const ID_ERROR = 'id: must be L followed by 1 to 9 digits, without a leading zero';

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = v => typeof v === 'string';
export const isId = v => isString(v) && ID.test(v);
const idNumber = id => Number(ID.exec(id)[1]);
const codeOf = error => (isString(error?.code) ? error.code : 'unknown');

/** Learning ids by number, then any other id, as a hand-written gate entry
 * may carry, by its text. */
function idOrder(a, b) {
  if (isId(a) && isId(b)) return idNumber(a) - idNumber(b);
  if (isId(a) !== isId(b)) return isId(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const learningsDir = root => join(repoDataDir(root), LEARNINGS_DIR);
const learningPath = (root, id) => join(learningsDir(root), `${id}.json`);
const localGatesPath = root => join(repoDataDir(root), LOCAL_GATES_FILE);

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

/** What an exported function returns when something it reads before taking
 * the lock cannot be read. */
export const readFailure = error => ({ error: `what this step reads could not be read (${codeOf(error)}); nothing was written` });

/**
 * Runs `fn` holding the lock every update to a learning, the id counter and
 * the local gate set is made under, and returns its result. `fn` gets
 * `write`, through which every write goes. Never throws: a lock that could
 * not be taken, or a failure inside `fn`, is returned as `{ error }` saying
 * whether anything was written.
 */
export function withLearningsLock(root, fn) {
  let entered = false;
  let wrote = false;
  try {
    const dir = repoDataDir(root);
    mkdirSync(dir, { recursive: true });
    return withFileLock(join(dir, LOCK_FILE), { name: 'learnings' }, assertHeld => {
      entered = true;
      return fn(action => {
        assertHeld();
        action();
        wrote = true;
      });
    });
  } catch (error) {
    const code = codeOf(error);
    if (!entered) {
      return { error: code === LOCKED ? 'another process holds the learnings lock; nothing was written' : `the learnings lock could not be taken (${code}); nothing was written` };
    }
    if (!wrote) return { error: `the step failed (${code}); nothing was written` };
    return { error: `the step stopped partway (${code}); listLearnings reports what it left disagreeing` };
  }
}

/** `{ text }`, the value stripped, trimmed and masked, or `{ error }`. Its
 * rules are checked on what a reader would see, before masking. */
function proseField(field, value, max) {
  if (!isString(value)) return { error: `${field}: must be a string` };
  const text = stripUnsafe(value).trim();
  if (LINE_BREAK.test(text)) return { error: `${field}: must be a single line` };
  if (text.length === 0) return { error: `${field}: must not be empty` };
  if (text.length > max) return { error: `${field}: must be at most ${max} characters` };
  return { text: maskText(text) };
}

/** The gate's model-written strings, by the name an error gives each. A
 * gate is stored and later shown to the model as written, and masking
 * `match.value` would change what it matches, so a credential in any of
 * them refuses the draft. */
const gateStrings = gate => [
  ['tool', gate.tool],
  ['field', gate.field],
  ['match.value', gate.match.value],
  ['message', gate.message],
  ...(gate.cites ?? []).map(cite => ['cites', cite]),
];

/** `{ gate }`, a JSON copy of the drafted gate without id and action, or
 * `{ error }`. The copy is what is validated and stored. */
function draftedGate(value) {
  if (!isPlainObject(value)) return { error: 'gate: must be an object' };
  let gate;
  try {
    gate = JSON.parse(JSON.stringify(value));
  } catch {
    return { error: 'gate: must be JSON' };
  }
  if (Object.hasOwn(gate, 'id') || Object.hasOwn(gate, 'action')) return { error: 'gate: must not carry id or action; both are assigned' };
  // The id is a placeholder of the right form; the one assigned later is too.
  const valid = validateGate({ ...gate, id: 'L1', action: 'observe' });
  if (!valid.ok) return { error: `gate: ${valid.reason}` };
  for (const [name, text] of gateStrings(gate)) {
    if (stripUnsafe(text) !== text) return { error: `gate: ${name} must not contain control or invisible characters` };
    if (maskText(text) !== text) return { error: `gate: ${name} must not contain a credential` };
  }
  return { gate };
}

/** The first current recurrence `matches` accepts that has a time span,
 * which its ledger evidence needs. */
function currentRecurrence(root, matches) {
  return findRecurrences(root).recurrences.find(r => matches(r) && isString(r.firstTs) && isString(r.lastTs));
}

const evidenceOf = recurrence => ({
  signature: recurrence.signature,
  sessions: recurrence.sessions.length,
  firstTs: recurrence.firstTs,
  lastTs: recurrence.lastTs,
  external: recurrence.external,
});

/** The id of the failure kind in the repository's taxonomy that lists
 * `signature`, or null. */
function failureIdFor(root, signature) {
  return parseFailures(readIfPresent(root, FAILURES_PATH)).find(k => k.signatures.includes(signature))?.id ?? null;
}

function isLearning(value, id) {
  if (!isPlainObject(value) || value.id !== id || !STATUSES.has(value.status)) return false;
  if (!isString(value.signature) || !SIGNATURE.test(value.signature)) return false;
  if (!isString(value.title) || !isString(value.why) || typeof value.external !== 'boolean') return false;
  if (value.failureId !== null && !isString(value.failureId)) return false;
  if (!isPlainObject(value.evidence) || value.evidence.signature !== value.signature) return false;
  if (!isPlainObject(value.harness) || !isString(value.harness.base) || !isString(value.harness.model)) return false;
  if (value.replay !== null && !isPlainObject(value.replay)) return false;
  if (!validateGate(value.gate).ok || value.gate.id !== id || value.sha256 !== gateSha256(value.gate)) return false;
  return gateActionsFor(value.status).includes(value.gate.action);
}

/** `{ learning }`, `{ missing: true }` or `{ unreadable: true }`; the last
 * for a file that does not read back as a learning, a gate whose action its
 * status does not allow among them. */
function readLearning(root, id) {
  let text;
  try {
    text = readFileSync(learningPath(root, id), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    return { unreadable: true };
  }
  try {
    const value = JSON.parse(text);
    return isLearning(value, id) ? { learning: value } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

/** Every learning file, in id order: `{ learnings, unreadable }`, the
 * second the ids whose file does not read back as a learning. Throws when
 * the directory exists and cannot be listed. */
function readLearnings(root) {
  let names;
  try {
    names = readdirSync(learningsDir(root));
  } catch (error) {
    if (error?.code === 'ENOENT') return { learnings: [], unreadable: [] };
    throw error;
  }
  const ids = names.map(name => LEARNING_FILE.exec(name)?.[1]).filter(isString).sort(idOrder);
  const learnings = [];
  const unreadable = [];
  for (const id of ids) {
    const read = readLearning(root, id);
    if (read.learning) learnings.push(read.learning);
    else if (read.unreadable) unreadable.push(id);
  }
  return { learnings, unreadable };
}

export const isGateEntry = entry => isPlainObject(entry) && isString(entry.id) && !Object.hasOwn(entry, 'suspended');
/** Exactly `{ id, suspended: true }` with a learning id, the only shape a
 * local suspension is written in. */
const isSuspension = entry => isPlainObject(entry) && Object.keys(entry).length === 2 && isId(entry.id) && entry.suspended === true;
const entryId = entry => (isPlainObject(entry) && isString(entry.id) ? entry.id : null);
const learningIdsIn = entries => entries.map(entryId).filter(isId);

/** `{ file }`, an empty gate file when there is none, or `{ unreadable:
 * true }` when the file is not `{ schema: 1, gates: [...] }`. Entries are
 * kept as written, whatever `parseGates` would make of them. */
function readLocalGates(root) {
  let text;
  try {
    text = readFileSync(localGatesPath(root), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { file: { schema: 1, gates: [] } };
    return { unreadable: true };
  }
  try {
    const file = JSON.parse(text);
    return isPlainObject(file) && file.schema === 1 && Array.isArray(file.gates) ? { file } : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

/** `{ gates }`, the committed gate file's entries, none when it is absent,
 * or `{ unreadable: true }` when it exists and cannot be read as a gate
 * file. */
export function readCommittedGates(root) {
  let text;
  try {
    text = readFileSync(join(root, GATES_PATH), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { gates: [] };
    return { unreadable: true };
  }
  let file = null;
  try {
    file = JSON.parse(text);
  } catch {
    // not JSON: refused below
  }
  return isPlainObject(file) && Array.isArray(file.gates) ? { gates: file.gates } : { unreadable: true };
}

/**
 * The state the last status-changing ledger entry for `id` leaves the
 * learning in, whatever content hash that entry names, or null when there
 * is none: `{ status, kind, contentSha256, action, approvedBy }`. `action`
 * is the one the entry grants, a promotion's recorded action and otherwise
 * `observe`; `approvedBy` is null unless the entry names an approver
 * `isApprover` accepts.
 */
function recordedState(ledger, id) {
  let state = null;
  for (const entry of ledger) {
    if (entry?.learningId !== id || !Object.hasOwn(STATUS_AFTER, entry.kind)) continue;
    state = {
      status: STATUS_AFTER[entry.kind],
      kind: entry.kind,
      contentSha256: entry.contentSha256,
      action: entry.kind === 'promoted' ? entry.action : 'observe',
      approvedBy: isApprover(entry.approvedBy) ? entry.approvedBy : null,
    };
  }
  return state;
}

/** The status the ledger records for the learning `id` with this content:
 * the one its last status-changing entry for `id` leaves it in, or null when
 * there is none or that entry names other content. A learning's file says
 * what its status is; only this says what it may be trusted to be. */
export function recordedStatus(ledgerEntries, id, contentSha256) {
  const state = recordedState(ledgerEntries, id);
  return state !== null && state.contentSha256 === contentSha256 ? state.status : null;
}

/** The actions a recorded state lets a learning's gate carry: the one its
 * entry granted, when its status allows that action, and above `observe`
 * only when the entry names who approved it. */
const recordedActions = state =>
  gateActionsFor(state.status).includes(state.action) && (state.action === 'observe' || state.approvedBy !== null) ? [state.action] : [];

/** `{ intact, entries }`: the ledger's entries when its chain is intact,
 * else none. */
function readLedgerView(root) {
  if (!verifyLedger(root).intact) return { intact: false, entries: [] };
  return { intact: true, entries: readLedger(root) };
}

/** Why the ledger does not vouch for `learning` as its file holds it, or
 * null when it does: its last status-changing entry must name the
 * learning's content and status, and grant its gate's action. */
export function unrecordedReason(learning, view) {
  const { id, status } = learning;
  if (!view.intact) return `${id}: the ledger cannot be read or its chain is broken, so it does not record this learning's status`;
  const state = recordedState(view.entries, id);
  if (state === null) return `${id}: the ledger does not record the status ${status} for this learning`;
  if (state.contentSha256 !== learning.sha256) return `${id}: the ledger records other content for this learning`;
  if (state.status !== status) return `${id}: the ledger does not record the status ${status} for this learning`;
  if (!recordedActions(state).includes(learning.gate.action)) return `${id}: the ledger records another action for this learning's gate`;
  return null;
}

/** Each readable learning the ledger vouches for, by id, with its recorded
 * state; a learning missing from it is a ledger mismatch. */
function recordedLearnings(learnings, view) {
  const recorded = new Map();
  for (const learning of learnings) {
    if (unrecordedReason(learning, view) === null) recorded.set(learning.id, recordedState(view.entries, learning.id));
  }
  return recorded;
}

/** Everything a step decides from, read afresh: the learning files, the
 * ledger, the learnings it vouches for and the local gate file. Throws when
 * the learnings directory cannot be listed. */
export function readState(root) {
  const { learnings, unreadable } = readLearnings(root);
  const view = readLedgerView(root);
  return { learnings, unreadable, view, recorded: recordedLearnings(learnings, view), local: readLocalGates(root) };
}

/** The learnings in `state` the ledger vouches for. */
export const recordedIn = state => state.learnings.filter(l => state.recorded.has(l.id));

/**
 * The local gate entries as the learnings the ledger vouches for require
 * them: `{ gates, changed, modified }`, where `changed` are the ids to
 * report and `modified` whether `gates` differs from the entries given.
 * `recorded` maps the id of each learning the ledger vouches for to its
 * recorded state; with the ledger broken it is empty, so every learned gate
 * goes and none is restored. `entries` are the ledger's entries, none when
 * it is broken.
 *
 * Nothing stays unless the ledger accounts for it. A gate entry stays only
 * when its learning is recorded in a status that keeps a local gate, its
 * content hash is the learning's, its action is the one the recorded state
 * grants, and no earlier entry has its id. A suspension, exactly `{ id,
 * suspended: true }`, stays only when the ledger's last status entry for
 * its id is `suspended` or `retired` and no earlier entry has its id: any
 * other would switch off the gate it shadows unseen. A recorded learning in
 * a status that keeps a local gate with no entry left gets its own gate. A
 * gate whose learning file cannot be read stays only at `observe`, and is
 * reported either way. An entry with no usable id is dropped and reported
 * by its 1-based place in the file, as `entry <n>`.
 */
function repairedGates(gates, learnings, unreadable, recorded, entries) {
  const learningById = new Map(learnings.map(l => [l.id, l]));
  const unknown = new Set(unreadable);
  const kept = [];
  const present = new Set();
  const changed = new Set();
  let modified = false;
  for (const [index, entry] of gates.entries()) {
    const id = entryId(entry);
    if (!isGateEntry(entry)) {
      if (isSuspension(entry) && !present.has(id) && SUSPENDING.has(recordedState(entries, id)?.status)) {
        kept.push(entry);
        present.add(id);
      } else {
        changed.add(id ?? `entry ${index + 1}`);
        modified = true;
      }
      continue;
    }
    if (unknown.has(id)) {
      changed.add(id);
      if (entry.action === 'observe' && !present.has(id)) {
        kept.push(entry);
        present.add(id);
      } else {
        modified = true;
      }
      continue;
    }
    const learning = learningById.get(id);
    const state = recorded.get(id);
    const sound = learning !== undefined && state !== undefined && LOCAL_GATE_STATUSES.has(state.status) && !present.has(id)
      && gateSha256(entry) === learning.sha256 && recordedActions(state).includes(entry.action);
    if (sound) {
      kept.push(entry);
      present.add(id);
    } else {
      changed.add(id);
      modified = true;
    }
  }
  for (const learning of learnings) {
    const state = recorded.get(learning.id);
    if (state === undefined || !LOCAL_GATE_STATUSES.has(state.status) || present.has(learning.id)) continue;
    kept.push(learning.gate);
    changed.add(learning.id);
    modified = true;
  }
  return { gates: kept, changed: [...changed].sort(idOrder), modified };
}

/** Every ledger entry that granted an action above `observe`: who approved
 * which content of which learning, at which action, and when. */
const approvalsIn = entries => entries
  .filter(e => e?.kind === 'promoted' && isApprover(e.approvedBy) && ABOVE_OBSERVE.has(e.action))
  .map(e => ({ id: e.learningId, sha256: e.contentSha256, action: e.action, approvedBy: e.approvedBy, ts: e.ts }));

/** The ids of the local gate entries above `observe` that the approval in
 * force for their learning does not grant: the last status-changing ledger
 * entry for the id must be a promotion, by an approver, of the entry's
 * content at the entry's action. An approval the learning has since lost
 * grants nothing. The repair removes each of these, since an entry above
 * `observe` stays only on such a promotion. */
export function unapprovedGateIds(gates, ledgerEntries) {
  const ids = new Set();
  for (const entry of gates) {
    if (!isGateEntry(entry) || !ABOVE_OBSERVE.has(entry.action)) continue;
    const state = recordedState(ledgerEntries, entry.id);
    const approved = state !== null && state.kind === 'promoted' && state.approvedBy !== null
      && state.contentSha256 === gateSha256(entry) && state.action === entry.action;
    if (!approved) ids.add(entry.id);
  }
  return [...ids].sort(idOrder);
}

/** Brings the local gate set into line with what the ledger grants, under
 * the lock, and returns the ids changed. A local gate file that is not a
 * gate file is left as it is. */
export function repairLocalGates(root, write) {
  const { learnings, unreadable, recorded, local, view } = readState(root);
  if (!local.file) return [];
  const repair = repairedGates(local.file.gates, learnings, unreadable, recorded, view.entries);
  if (repair.modified) write(() => writeJson(localGatesPath(root), { ...local.file, gates: repair.gates }));
  return repair.changed;
}

/** Writes the local gate file afresh as exactly the gates the ledger in
 * `state`, taken under the lock, grants, over a file that is not a gate
 * file; returns the ids of the gates it holds. The ledger must be intact,
 * or it grants nothing and the file would be emptied for no reason. */
export function rewriteLocalGates(root, write, state) {
  const rebuilt = repairedGates([], state.learnings, state.unreadable, state.recorded, state.view.entries);
  write(() => writeJson(localGatesPath(root), { schema: 1, gates: rebuilt.gates }));
  return rebuilt.changed;
}

/**
 * Runs `step(write)` under the learnings lock once the local gate set is
 * repaired, and returns its result with the ids the repair changed as
 * `repairedGates`: always on success, on a refusal only when there are any.
 */
export function repairedStep(root, step) {
  return withLearningsLock(root, write => {
    const repaired = repairLocalGates(root, write);
    const result = step(write);
    return result.error !== undefined && repaired.length === 0 ? result : { ...result, repairedGates: repaired };
  });
}

/** `{ error }` for a call refused before the lock was taken, once the
 * repair the call owes has run; a repair that cannot run leaves the
 * refusal as it is. */
export function refuse(root, error) {
  const result = repairedStep(root, () => ({ error }));
  return result.error === error ? result : { error };
}

/** The ids the ledger and the learning files disagree about: each readable
 * learning the ledger does not vouch for, and each id the ledger names that
 * has no learning file. */
function ledgerMismatches(learnings, unreadable, view, recorded) {
  const files = new Set([...learnings.map(l => l.id), ...unreadable]);
  const unrecorded = learnings.filter(l => !recorded.has(l.id)).map(l => l.id);
  const orphaned = new Set(view.entries.map(e => e?.learningId).filter(id => isId(id) && !files.has(id)));
  return [...unrecorded, ...orphaned].sort(idOrder);
}

/** `{ learning }` for the readable learning `id` in `state`, or `{ error }`. */
export function learningIn(state, id) {
  if (state.unreadable.includes(id)) return { error: `${id}: the learning file does not read back as a learning` };
  const learning = state.learnings.find(l => l.id === id);
  return learning === undefined ? { error: `${id}: no such learning` } : { learning };
}

/**
 * The id of a learning that stands for `signature`, or null: one whose file
 * or ledger entries name the signature, unless the ledger's last word on it
 * is a settled status and its file, if one is left, agrees.
 */
function standingFor(state, signature) {
  const files = new Map(state.learnings.map(l => [l.id, l]));
  const ids = new Set([...files.keys(), ...state.view.entries.map(e => e?.learningId).filter(isId)]);
  for (const id of [...ids].sort(idOrder)) {
    const file = files.get(id);
    const named = file?.signature === signature || state.view.entries.some(e => e?.learningId === id && e.evidence?.signature === signature);
    if (!named) continue;
    const last = recordedState(state.view.entries, id);
    const settled = last !== null && SETTLED.has(last.status) && (file === undefined || state.recorded.has(id));
    if (!settled) return id;
  }
  return null;
}

function readCounter(root) {
  let text;
  try {
    text = readFileSync(join(repoDataDir(root), ID_COUNTER_FILE), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    return null;
  }
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) && Number.isSafeInteger(value.highest) && value.highest >= 0 ? value.highest : null;
  } catch {
    return null;
  }
}

/** `{ id, number }`, one more than the highest number the id counter, a
 * learning file, the ledger, or the committed or local gate file holds; or
 * `{ error }`. Called under the lock, before the counter is advanced. */
function nextId(root, state) {
  const counter = readCounter(root);
  if (counter === null) return { error: 'the learning id counter cannot be read, so no id that was never used can be assigned' };
  const committed = readCommittedGates(root);
  if (committed.unreadable) return { error: 'the committed gate file cannot be read, so no id that avoids its ids can be assigned' };
  const used = [
    ...state.learnings.map(l => l.id),
    ...learningIdsIn(committed.gates),
    ...state.view.entries.map(e => e?.learningId).filter(isId),
    ...(state.local.file ? learningIdsIn(state.local.file.gates) : []),
  ].map(idNumber);
  const highest = Math.max(counter, ...used);
  if (highest >= ID_NUMBER_MAX) return { error: 'no learning id is left to assign' };
  return { id: `L${highest + 1}`, number: highest + 1 };
}

/** The ledger entry `kind` for `learning` under `identity`, the harness the
 * event happened under. `approvedBy` names who decided the step, null when
 * a rule did; `action` and `firing` are carried by the kinds that require
 * them. */
export const ledgerEntry = (learning, identity, { kind, approvedBy = null, action, firing, detail }) => ({
  kind,
  learningId: learning.id,
  contentSha256: learning.sha256,
  evidence: learning.evidence,
  base: identity.base,
  learned: identity.learned,
  approvedBy,
  action,
  firing,
  detail,
});

/**
 * Writes one change to a learning under the lock: its ledger entries, built
 * from `entries`, then the learning as `updated`, then the local gate set as
 * the ledger will then grant it, with a local suspension of the learning's
 * committed gate when `suspend`. `state` is `readState` taken under the same
 * lock. Returns `{}`, or `{ error }` with nothing written when the local
 * gate file, which the change needs, is not a gate file, or when the set
 * would grow past its limit.
 */
export function writeTransition(root, write, state, { updated, entries, suspend = false }) {
  // Every entry precedes the writes, so each names the harness in force
  // before this step.
  const identity = harnessIdentity(root);
  const records = entries.map(spec => ledgerEntry(updated, identity, spec));
  const recordedAfter = new Map(state.recorded).set(updated.id, recordedState([...state.view.entries, ...records], updated.id));
  const learningsAfter = state.learnings.map(l => (l.id === updated.id ? updated : l));
  let gates = null;
  if (state.local.file) {
    const before = state.local.file.gates;
    const repair = repairedGates(before, learningsAfter, state.unreadable, recordedAfter, [...state.view.entries, ...records]);
    const suspension = suspend && !repair.gates.some(e => entryId(e) === updated.id) ? [{ id: updated.id, suspended: true }] : [];
    const after = [...repair.gates, ...suspension];
    const count = list => list.filter(isGateEntry).length;
    if (count(after) > GATE_LIMITS.gatesMax && count(after) > count(before)) {
      return { error: `the local gate set would hold more than ${GATE_LIMITS.gatesMax} gates; nothing was written` };
    }
    if (repair.modified || suspension.length > 0) gates = after;
  } else if (suspend || LOCAL_GATE_STATUSES.has(updated.status)) {
    return { error: 'the local gate file is not a gate file; nothing was written' };
  }
  for (const record of records) write(() => appendLedger(root, record));
  write(() => writeJson(learningPath(root, updated.id), updated));
  if (gates !== null) write(() => writeJson(localGatesPath(root), { ...state.local.file, gates }));
  return {};
}

/**
 * Validates a model-written draft, `{ signature, title, why, gate }` with
 * the gate lacking `id` and `action`, and stores it as a candidate under
 * the next id, recording `proposed` in the ledger. `signature` must be a
 * current recurrence's, and the gate's tool that recurrence's tool; `title`
 * and `why` are stored stripped of what cannot be seen and masked, while a
 * gate string holding a credential or an invisible character refuses the
 * draft. At most one learning that is neither rejected nor retired stands
 * for a signature, by its file or, once the file is gone, by the ledger; a
 * learning file that does not read back may be one, so it refuses every
 * draft until it is mended or removed. Returns `{ learning, repairedGates }`,
 * or `{ error }`.
 */
export function draftLearning(root, draft) {
  try {
    return draftUnguarded(root, draft);
  } catch (error) {
    return readFailure(error);
  }
}

function draftUnguarded(root, draft) {
  if (!isPlainObject(draft)) return refuse(root, 'draft: must be an object');
  if (Object.keys(draft).some(k => !DRAFT_KEYS.has(k))) return refuse(root, 'draft: may have only the keys signature, title, why and gate');
  const { signature } = draft;
  if (!isString(signature) || !SIGNATURE.test(signature)) return refuse(root, 'signature: must be 16 lowercase hex characters');
  const title = proseField('title', draft.title, TITLE_MAX);
  if (title.error) return refuse(root, title.error);
  const why = proseField('why', draft.why, WHY_MAX);
  if (why.error) return refuse(root, why.error);
  const drafted = draftedGate(draft.gate);
  if (drafted.error) return refuse(root, drafted.error);
  const recurrence = currentRecurrence(root, r => r.signature === signature);
  if (recurrence === undefined) return refuse(root, 'signature: not the signature of a current recurrence');
  if (drafted.gate.tool !== recurrence.tool) return refuse(root, "gate: tool must be the recurrence's tool");
  const failureId = failureIdFor(root, signature);

  return repairedStep(root, write => {
    const state = readState(root);
    if (state.unreadable.length > 0) return { error: `learning ${state.unreadable[0]} does not read back as a learning, and may cover this signature; mend or remove its file first` };
    if (!state.view.intact) return { error: 'the ledger cannot be read or its chain is broken, so no learning can be told settled and no id never used can be assigned' };
    const standing = standingFor(state, signature);
    if (standing !== null) return { error: `signature: learning ${standing} already covers this signature` };
    const next = nextId(root, state);
    if (next.error) return next;
    const gate = { ...drafted.gate, id: next.id, action: 'observe' };
    const learning = {
      id: next.id,
      signature,
      failureId,
      title: title.text,
      why: why.text,
      gate,
      sha256: gateSha256(gate),
      status: 'candidate',
      external: recurrence.external,
      evidence: evidenceOf(recurrence),
      harness: { base: recurrence.base, model: recurrence.model },
      replay: null,
    };
    write(() => writeJson(join(repoDataDir(root), ID_COUNTER_FILE), { highest: next.number }));
    write(() => appendLedger(root, ledgerEntry(learning, harnessIdentity(root), { kind: 'proposed' })));
    write(() => writeJson(learningPath(root, learning.id), learning));
    return { learning };
  });
}

/**
 * Replays a candidate's gate against its recurrence as it now stands, and
 * acts on the verdict. `pass`: the learning goes to `trial` and its gate,
 * with action `observe`, into the local gate set; the ledger gets
 * `replayed` then `trial`. `fail`: the learning is `rejected`; `replayed`
 * then `rejected`. `not-checkable`: it stays a candidate, to be replayed
 * again once more history exists; `replayed` alone. The latest replay,
 * evidence and failure kind are stored on the learning either way, and
 * `replayed` carries the verdict and reason in its detail. A learning once
 * marked external stays so.
 *
 * A learning the ledger does not vouch for is refused. A local gate file
 * that is not a gate file is left as it is, which refuses a pass. Returns
 * `{ replay, status, repairedGates }`, or `{ error }`.
 */
export function runTrial(root, id) {
  try {
    return runTrialUnguarded(root, id);
  } catch (error) {
    return readFailure(error);
  }
}

function runTrialUnguarded(root, id) {
  if (!isId(id)) return refuse(root, ID_ERROR);
  const read = readLearning(root, id);
  if (read.missing) return refuse(root, `${id}: no such learning`);
  if (read.unreadable) return refuse(root, `${id}: the learning file does not read back as a learning`);
  const { learning } = read;
  if (learning.status !== 'candidate') return refuse(root, `${id} is ${learning.status}; only a candidate is replayed`);
  const unrecorded = unrecordedReason(learning, readLedgerView(root));
  if (unrecorded !== null) return refuse(root, unrecorded);
  const { signature, harness } = learning;
  const recurrence = currentRecurrence(root, r => r.signature === signature && r.base === harness.base && r.model === harness.model);
  if (recurrence === undefined) return refuse(root, `${id}: its signature is no longer a current recurrence under the harness and model it was drafted for`);
  const replay = replayGate(root, learning.gate, recurrence);
  const status = replay.verdict === 'pass' ? 'trial' : replay.verdict === 'fail' ? 'rejected' : 'candidate';
  const failureId = failureIdFor(root, signature);

  return repairedStep(root, write => {
    const state = readState(root);
    const current = state.learnings.find(l => l.id === id);
    if (current?.status !== 'candidate' || current.sha256 !== learning.sha256) return { error: `${id} changed while it was replayed; nothing was written` };
    const unrecordedNow = unrecordedReason(current, state.view);
    if (unrecordedNow !== null) return { error: unrecordedNow };
    const updated = {
      ...current,
      failureId,
      status,
      gate: { ...current.gate, action: 'observe' },
      external: current.external || recurrence.external,
      evidence: evidenceOf(recurrence),
      replay,
    };
    const entries = [{ kind: 'replayed', detail: `${replay.verdict}: ${replay.reason}` }, ...(status === 'candidate' ? [] : [{ kind: status }])];
    const written = writeTransition(root, write, state, { updated, entries });
    return written.error === undefined ? { replay, status } : written;
  });
}

/** How many times the learning `id` was marked wrong since its last
 * promotion, or ever when it was never promoted. */
export function wrongSincePromotion(entries, id) {
  let wrong = 0;
  for (const entry of entries) {
    if (entry?.learningId !== id) continue;
    if (entry.kind === 'promoted') wrong = 0;
    else if (entry.kind === 'wrong') wrong++;
  }
  return wrong;
}

/** True when the path at `path` does not exist; one that cannot be checked
 * for another reason counts as existing. */
function isGone(path) {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  }
}

/** True when the learning's gate cites at least one path and none of them
 * exists in the repository any more. */
export function citesGone(root, learning) {
  const cites = learning.gate.cites ?? [];
  return cites.length > 0 && cites.every(cite => isGone(join(root, cite)));
}

/** The ids of the learnings in `state` the ledger vouches for whose gate
 * warns or blocks and every path of whose `cites` is gone. Anything running
 * as this user can delete a file, so no rule retires an enforcing gate for
 * this; it stays in force until the owner retires it at a terminal. */
export function citationsGone(root, state) {
  return recordedIn(state).filter(l => l.status === 'active-local' && citesGone(root, l)).map(l => l.id);
}

/**
 * Every learning on this machine for the repository, in id order:
 * `{ learnings, gatesToRepair, unapprovedGates, citationsGone,
 * ledgerMismatch, ledgerIntact, unreadable, approvals }`. The ledger, not a learning's
 * file, is the authority for its status. `gatesToRepair` are the ids whose
 * local gate entries the next step that writes removes, replaces or
 * restores, and every gate whose learning file cannot be read;
 * `unapprovedGates` the ids of the local gate entries above `observe` that
 * no approval in the ledger grants, which that step removes; both null when
 * the local gate file cannot be read. `citationsGone` are the enforcing
 * learnings whose cited paths are all gone, as `citationsGone` finds them.
 * `ledgerMismatch` are the ids of the
 * learnings the ledger does not vouch for (all of them when `ledgerIntact`
 * is false, since the ledger then records nothing) and the ids the ledger
 * names with no learning file; `unreadable` the ids whose learning file
 * does not read back as a learning; `approvals` every promotion in the
 * ledger, as `{ id, sha256, action, approvedBy, ts }`. `{ error }` when the
 * learnings cannot be listed.
 */
export function listLearnings(root) {
  try {
    const state = readState(root);
    const { learnings, unreadable, view, recorded, local } = state;
    return {
      learnings,
      gatesToRepair: local.file ? repairedGates(local.file.gates, learnings, unreadable, recorded, view.entries).changed : null,
      unapprovedGates: local.file ? unapprovedGateIds(local.file.gates, view.entries) : null,
      citationsGone: citationsGone(root, state),
      ledgerMismatch: ledgerMismatches(learnings, unreadable, view, recorded),
      ledgerIntact: view.intact,
      unreadable,
      approvals: approvalsIn(view.entries),
    };
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * What the session log records of each of `learnings`' gates:
 * `{ stats, sessionsUnreadable }`, `stats` mapping each id to `{ firings,
 * sessions, rerouted }`. A firing counts when it names the learning's id and
 * content. `rerouted` counts the `warn` and `block` firings after which the
 * next call of the gate's tool in that session, the fired call itself
 * excepted, succeeded; an `observe` firing told nobody anything, so it is
 * never counted, nor is a firing whose call carries no tool use id, since
 * the fired call cannot then be told from the next.
 * `sessionsUnreadable` counts the sessions that could not be read in full,
 * whose counts are what did parse.
 */
export function logStats(root, learnings) {
  const counts = new Map(learnings.map(l => [l.id, { sha256: l.sha256, firings: 0, rerouted: 0, sessions: new Set() }]));
  let sessionsUnreadable = 0;
  for (const sessionId of sessionIds(root)) {
    const { events, unreadable } = readEvents(root, sessionId);
    if (unreadable) sessionsUnreadable++;
    let awaiting = [];
    for (const event of events) {
      const counted = event.type === FIRING_EVENT ? counts.get(event.gateId) : undefined;
      if (counted !== undefined && event.gateSha256 === counted.sha256) {
        counted.firings++;
        counted.sessions.add(sessionId);
        if (ABOVE_OBSERVE.has(event.action) && isString(event.tool_use_id)) awaiting.push({ counted, tool: event.tool, toolUseId: event.tool_use_id });
      } else if (event.type === SUCCESS_EVENT || event.type === FAILURE_EVENT) {
        const isNext = f => f.tool === event[TOOL_FIELD] && f.toolUseId !== event.tool_use_id;
        if (event.type === SUCCESS_EVENT) for (const f of awaiting) if (isNext(f)) f.counted.rerouted++;
        awaiting = awaiting.filter(f => !isNext(f));
      }
    }
  }
  const stats = new Map([...counts].map(([id, c]) => [id, { firings: c.firings, sessions: c.sessions.size, rerouted: c.rerouted }]));
  return { stats, sessionsUnreadable };
}

/**
 * What the session log and the ledger record of a learning's gate:
 * `firings`, the `gate_firing` events for its id and content; `sessions`,
 * how many sessions hold one; `rerouted`, the `warn` and `block` firings
 * after which the next call of the gate's tool in that session succeeded,
 * as `logStats` counts them; `wrong`, the firings marked wrong since its last
 * promotion; and `sessionsUnreadable`. Returns `{ error }` for an id that
 * names no learning, for a learning the ledger does not vouch for, or when
 * the log cannot be read.
 */
export function learningStats(root, id) {
  try {
    return learningStatsUnguarded(root, id);
  } catch (error) {
    return readFailure(error);
  }
}

function learningStatsUnguarded(root, id) {
  if (!isId(id)) return { error: ID_ERROR };
  const read = readLearning(root, id);
  if (read.missing) return { error: `${id}: no such learning` };
  if (read.unreadable) return { error: `${id}: the learning file does not read back as a learning` };
  const view = readLedgerView(root);
  const unrecorded = unrecordedReason(read.learning, view);
  if (unrecorded !== null) return { error: unrecorded };
  const { stats, sessionsUnreadable } = logStats(root, [read.learning]);
  return { ...stats.get(id), wrong: wrongSincePromotion(view.entries, id), sessionsUnreadable };
}
