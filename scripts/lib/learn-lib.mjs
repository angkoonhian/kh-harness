// scripts/lib/learn-lib.mjs
//
// A learning's life on this machine. A model drafts one small gate for a
// recurring failure; this module validates the draft, replays the gate
// against the recorded sessions and, when the replay passes, puts it in this
// machine's local gate set with action `observe`, where it logs what it would
// have done and changes nothing. What moves it past `observe`, and back, is
// `learn-promote.mjs`, and what lands it in the repository and takes it out
// again is `learn-land.mjs`; the tables that decide what each status
// allows, and the repair that holds the local gate set to them, are here,
// since every one of them depends on them.
//
// A draft is untrusted, model-written input: every field is checked before
// anything is stored, and an error is fixed text naming the field and the
// rule broken, never the value. Everything this module writes goes to the
// repository's per-machine data directory; it reads the repository and
// never writes inside it.
//
// The ledger, not a learning's file, is the authority for its status, for
// the action its gate may carry, and for its content. Two hashes bind the
// content: `contentSha256`, of the gate, and `proseSha256`, of the title,
// the why, the evidence and the outside-content flag (`proseSha256Of`),
// which a landing writes into the repository. Every status-changing entry
// carries both, and a learning whose file differs from either is not
// vouched for (`unrecordedReason`).
//
// A learning drafted before the ledger recorded the second hash has none in
// its entries. Its gate, status and action are vouched for as before, so it
// keeps working on this machine, but its title, why and evidence are not:
// `list` and `show` say so, and a policy does not promote it. The hash is
// recorded by the first step on it at which the owner, at a terminal, is
// shown that text by the same run: an approval, which prints the learning,
// or a landing, which prints the diff it writes. Every other step leaves it
// as it was.
//
// Every transition is written ledger first, then the learning, then the
// local gate set, so an interrupted step leaves a ledger entry with less in
// force than it says, never a gate in force that the ledger does not
// record. A learning file left behind its ledger entry is rolled forward
// (`laggingLearnings`): when the file's gate is the one the last status
// entry names, its status, action and evidence are rewritten from that
// entry, with an action above `observe` only where the entry names an
// approver. `landed` and `reverted` are left to `learn-land.mjs`, whose own
// command finishes them, since they are half of a change to the repository.
// An id the ledger names that has no file at all is settled by `tick`
// (`learn-promote.mjs`), which records it retired.
//
// The gate hook enforces whatever the local gate set holds, and anything
// running as this user can write it. So every step that writes, refused or
// not, first rolls lagging learning files forward and brings the set into
// line with what the ledger grants, and reports the ids it changed as
// `rolledForward` and `repairedGates`: a gate the ledger does not grant is
// removed even while the ledger is broken, and one it grants is restored
// only while it is intact. "Nothing was written" in an error speaks of the
// step, never of that repair.
//
// Ids are assigned per machine, each above every id this machine has seen.
// A landing pulled from another machine can therefore hold an id a local
// learning already has. Nothing renumbers: `idCollisions` finds them, and
// `list` and `tick` report them with what to do.
//
// No exported function throws. Every `{ error }` carries the exit code the
// command ends with, as `scripts/lib/cli.mjs` `EXIT_CODES` defines them,
// given by `refused` or `failed` and nowhere else:
//
//   3, refused to act: no terminal; a learning in the wrong status for the
//      step; a learning the ledger does not vouch for, a broken ledger
//      among the reasons; a hash that is not the one shown; a signature a
//      learning already stands for, or one that needs a redraft or a label;
//      a firing already marked, or of other content; a local gate file that
//      is not a gate file, or a gate set that is full; a learning file that
//      does not read back and may cover the signature drafted.
//   2, could not act: an argument or a draft that is malformed; an id, a
//      signature or a firing that names nothing; anything that could not be
//      read, locked or written, or that stopped partway.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { GATE_ID, GATE_LIMITS, gateSha256, validateGate } from '../../assets/scripts/harness-gates.mjs';
import { canonicalJson, GATES_PATH, harnessIdentity, LOCAL_GATES_FILE, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { maskText, stripUnsafe } from '../../assets/scripts/harness-redact.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { FAILURES_PATH, parseFailures } from './failures-evidence.mjs';
import { LOCKED, withFileLock } from './file-lock.mjs';
import { gateStats } from './gate-stats.mjs';
import { readCommittedGateFile } from './integrity-evidence.mjs';
import { registryLine, SIGNATURE, TITLE_MAX, WHY_MAX } from './learned-registry.mjs';
import { ACTION_KINDS, appendLedger, isApprover, readLedgerView } from './ledger.mjs';
import { findRecurrences } from './recurrence.mjs';
import { replayGate } from './replay.mjs';
import { readIfPresent } from './scan.mjs';

/** An error the step refused to act on, and one it could not act on, each
 * with the exit code the command ends with. */
export const refused = error => ({ error, exitCode: 3 });
export const failed = error => ({ error, exitCode: 2 });

const STATUSES = new Set(['candidate', 'rejected', 'trial', 'active-local', 'landed', 'suspended', 'retired']);

// The actions a learning's gate may carry in each status; one whose gate is
// in force nowhere keeps it at `observe`. A status absent here allows none,
// so a learning file in it does not read back.
const GATE_ACTIONS = Object.freeze({
  candidate: Object.freeze(['observe']),
  rejected: Object.freeze(['observe']),
  trial: Object.freeze(['observe']),
  'active-local': Object.freeze(['warn', 'block']),
  landed: Object.freeze(['warn', 'block']),
  suspended: Object.freeze(['observe']),
  retired: Object.freeze(['observe']),
});

/** The actions a learning's gate may carry while the learning is in
 * `status`; none for a status this module does not hold gates in. */
export function gateActionsFor(status) {
  return Object.hasOwn(GATE_ACTIONS, status) ? GATE_ACTIONS[status] : [];
}

// The status each ledger kind leaves a learning in; a kind absent here, such
// as `wrong`, changes no status. Nothing leads out of `retired`, which is
// terminal. A revert takes a learning's gate out of the repository and not
// its approval, so it returns to `active-local`; the one way out of
// `suspended` is a revert, which `learn-land.mjs` follows at once with
// `retired`, since the learning was judged wrong here.
const STATUS_AFTER = Object.freeze({
  proposed: 'candidate',
  replayed: 'candidate',
  trial: 'trial',
  rejected: 'rejected',
  promoted: 'active-local',
  demoted: 'trial',
  landed: 'landed',
  reverted: 'active-local',
  suspended: 'suspended',
  retired: 'retired',
});

// A learning in one of these no longer stands for its signature, so a new
// draft for the signature may be made: only as a redraft where `earlierFor`
// finds it ended in a way that speaks against one.
export const SETTLED = new Set(['rejected', 'retired']);

// The statuses whose gate lives in the local gate set. A `landed` learning's
// gate lives there too while the committed file does not hold it as
// approved: see `keepsLocalGate`.
const LOCAL_GATE_STATUSES = new Set(['trial', 'active-local']);

// The actions above `observe`: those a promoted learning's gate may carry.
const ABOVE_OBSERVE = new Set(GATE_ACTIONS['active-local']);

// The ledger kinds `learn-land.mjs` finishes itself when its step stopped
// after them: each is half of a change to the repository, so the roll
// forward leaves a learning whose last entry is one of them alone.
const FINISHED_BY_OWN_COMMAND = new Set(['landed', 'reverted']);

const LEARNINGS_DIR = 'learnings';
// The highest id ever assigned on this machine for this repository, so the
// number of a rejected or removed learning is never assigned again.
const ID_COUNTER_FILE = 'learning-ids.json';
const LOCK_FILE = 'learnings.lock';

const ID_NUMBER_MAX = 999_999_999;

const LEARNING_FILE_SUFFIX = '.json';
const LINE_BREAK = /[\n\p{Zl}\p{Zp}]/u;
const DRAFT_KEYS = new Set(['signature', 'title', 'why', 'gate']);
const REPLAYED_DETAIL = /^(pass|fail|not-checkable): (.*)$/s;

export const ID_ERROR = 'id: must be L followed by 1 to 9 digits, without a leading zero';

export const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = v => typeof v === 'string';
/** Whether `v` is a learning id: the gate hook's own pattern for a gate id. */
export const isId = v => isString(v) && GATE_ID.test(v);
const idNumber = id => Number(id.slice(1));
/** The code of a caught error, for an error line. */
export const codeOf = error => (isString(error?.code) ? error.code : 'unknown');

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
export const readFailure = error => failed(`what this step reads could not be read (${codeOf(error)}); nothing was written`);

/**
 * Runs `fn` holding the lock every update to a learning, the id counter and
 * the local gate set is made under, and returns its result. `fn` gets
 * `write`, through which every write goes. Never throws: a lock that could
 * not be taken, or a failure inside `fn`, is returned as `failed` saying
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
      return failed(code === LOCKED ? 'another process holds the learnings lock; nothing was written' : `the learnings lock could not be taken (${code}); nothing was written`);
    }
    if (!wrote) return failed(`the step failed (${code}); nothing was written`);
    return failed(`the step stopped partway (${code}); the same command run again, or \`tick\`, brings what it left into line with the ledger`);
  }
}

/** `{ text }`, the value stripped, trimmed and masked, or `{ error }`. Its
 * rules are checked on what a reader would see, before masking, except its
 * length: that is counted as the learned registry counts the line it writes
 * (`registryLine`), so a text accepted here is never too long to land. */
function proseField(field, value, max) {
  if (!isString(value)) return { error: `${field}: must be a string` };
  const text = stripUnsafe(value).trim();
  if (LINE_BREAK.test(text)) return { error: `${field}: must be a single line` };
  if (text.length === 0) return { error: `${field}: must not be empty` };
  const stored = maskText(text);
  if (registryLine(stored).length > max) return { error: `${field}: must be at most ${max} characters, each < and > counting as four` };
  return { text: stored };
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

/** The SHA-256 of what the ledger vouches for of a learning beside its
 * gate: its title, its why, its evidence and whether a session behind it
 * read outside content, as canonical JSON. */
export function proseSha256Of({ title, why, external, evidence }) {
  return createHash('sha256').update(canonicalJson({ title, why, external, evidence }), 'utf8').digest('hex');
}

/** The failure kinds `docs/harness/FAILURES.md` names, none when it is
 * absent or cannot be read. */
export const failureKinds = root => parseFailures(readIfPresent(root, FAILURES_PATH));

/** The id of the failure kind in `kinds` that lists `signature`, or null. */
const failureIdIn = (kinds, signature) => kinds.find(k => k.signatures.includes(signature))?.id ?? null;

/** The id of the failure kind in the repository's taxonomy that lists
 * `signature`, or null. */
const failureIdFor = (root, signature) => failureIdIn(failureKinds(root), signature);

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
  const ids = names.filter(name => name.endsWith(LEARNING_FILE_SUFFIX)).map(name => name.slice(0, -LEARNING_FILE_SUFFIX.length)).filter(isId).sort(idOrder);
  const learnings = [];
  const unreadable = [];
  for (const id of ids) {
    const read = readLearning(root, id);
    if (read.learning) learnings.push(read.learning);
    else if (read.unreadable) unreadable.push(id);
  }
  return { learnings, unreadable };
}

const isGateEntry = entry => isPlainObject(entry) && isString(entry.id) && !Object.hasOwn(entry, 'suspended');
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

/** Exactly the gates the gate hook loads from the committed gate file: what
 * `parseGates` accepts, so the first entry with an id and never a rejected
 * duplicate; none when the file is absent, larger than the hook reads,
 * unreadable or not a gate file, since the hook then applies none of them.
 * Anything that asks what the committed file holds asks this, through the
 * one bounded read the integrity check makes too. */
export const committedGates = root => readCommittedGateFile(root).parsed?.gates ?? [];

/** `{ ids }`, every learning id an entry of the committed gate file carries,
 * rejected entries included, so no id assigned can collide with one a later
 * edit makes valid; none when the file is absent; `{ unreadable: true }`
 * when it exists and cannot be read as a gate file. */
function committedIdsInUse(root) {
  let text;
  try {
    text = readFileSync(join(root, GATES_PATH), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ids: [] };
    return { unreadable: true };
  }
  let file = null;
  try {
    file = JSON.parse(text);
  } catch {
    // not JSON: refused below
  }
  return isPlainObject(file) && Array.isArray(file.gates) ? { ids: learningIdsIn(file.gates) } : { unreadable: true };
}

/**
 * The state the last status-changing ledger entry for `id` leaves the
 * learning in, whatever content hash that entry names, or null when there
 * is none: `{ status, kind, contentSha256, proseSha256, proseDropped,
 * evidence, action, approvedBy }`. `proseSha256` is undefined for an entry
 * that records none, and `proseDropped` says an earlier status entry for
 * the id did record one, which no step of the kit leaves behind; `evidence`
 * is the entry's, in a learning file's key order. `action` is the one the
 * entry grants, the action an `ACTION_KINDS` entry records and otherwise
 * `observe`; `approvedBy` is null unless the entry names an approver
 * `isApprover` accepts.
 */
export function recordedState(ledger, id) {
  let state = null;
  let proseEver = false;
  for (const entry of ledger) {
    if (entry?.learningId !== id || !Object.hasOwn(STATUS_AFTER, entry.kind)) continue;
    const { signature, sessions, firstTs, lastTs, external } = entry.evidence;
    proseEver ||= entry.proseSha256 !== undefined;
    state = {
      status: STATUS_AFTER[entry.kind],
      kind: entry.kind,
      contentSha256: entry.contentSha256,
      proseSha256: entry.proseSha256,
      proseDropped: proseEver && entry.proseSha256 === undefined,
      evidence: { signature, sessions, firstTs, lastTs, external },
      action: ACTION_KINDS.includes(entry.kind) ? entry.action : 'observe',
      approvedBy: isApprover(entry.approvedBy) ? entry.approvedBy : null,
    };
  }
  return state;
}

/** The status-changing ledger entries for `id`, in ledger order: the
 * evidence for where a step on the learning stopped. */
export const statusEntriesFor = (ledger, id) => ledger.filter(e => e?.learningId === id && Object.hasOwn(STATUS_AFTER, e.kind));

/** The actions a recorded state lets a learning's gate carry: the one its
 * entry granted, when its status allows that action, and above `observe`
 * only when the entry names who approved it. */
const recordedActions = state =>
  gateActionsFor(state.status).includes(state.action) && (state.action === 'observe' || state.approvedBy !== null) ? [state.action] : [];

/** Why the ledger does not vouch for `learning` as its file holds it, or
 * null when it does: its last status-changing entry must name the
 * learning's gate, its title, why and evidence where the entry records
 * their hash, and its status, and grant its gate's action. */
export function unrecordedReason(learning, view) {
  const { id, status } = learning;
  if (!view.intact) return `${id}: the ledger cannot be read or its chain is broken, so it does not record this learning's status`;
  const state = recordedState(view.entries, id);
  if (state === null) return `${id}: the ledger does not record the status ${status} for this learning`;
  if (state.contentSha256 !== learning.sha256) return `${id}: the ledger records other content for this learning`;
  if (state.proseDropped) return `${id}: the ledger's last entry for this learning records no hash of its title, why and evidence, though an earlier one does`;
  if (state.proseSha256 !== undefined && state.proseSha256 !== proseSha256Of(learning)) return `${id}: the ledger records another title, why or evidence for this learning`;
  if (state.status !== status) return `${id}: the ledger does not record the status ${status} for this learning`;
  if (!recordedActions(state).includes(learning.gate.action)) return `${id}: the ledger records another action for this learning's gate`;
  return null;
}

/** Whether the ledger's last status entry for `id` records no hash of the
 * learning's title, why and evidence: one drafted before the ledger did. */
export const proseUnrecorded = (entries, id) => recordedState(entries, id)?.proseSha256 === undefined;

/** The replay a learning file should hold given the ledger: the file's own
 * when the last `replayed` entry for its gate says the same, or there is
 * none; otherwise that entry's verdict and reason, the rest of a replay's
 * record being in no ledger entry. */
function recordedReplay(entries, learning) {
  const detail = entries.findLast(e => e?.learningId === learning.id && e.kind === 'replayed' && e.contentSha256 === learning.sha256)?.detail;
  const m = isString(detail) ? REPLAYED_DETAIL.exec(detail) : null;
  if (m === null) return learning.replay;
  const [, verdict, reason] = m;
  return learning.replay?.verdict === verdict && learning.replay.reason === reason ? learning.replay : { verdict, reason };
}

/**
 * The learnings in `state` whose file a step left behind its ledger entry,
 * each as the file should read: the ledger is intact, the file's gate is the
 * one the last status entry names, and that entry's status, action and
 * evidence, with the replay the ledger records, make a learning the ledger
 * vouches for. An action above `observe` is taken only from an entry that
 * names an approver. A learning whose last entry `learn-land.mjs` finishes
 * itself is left to it.
 */
function laggingLearnings(state) {
  if (!state.view.intact) return [];
  const out = [];
  for (const learning of state.learnings) {
    if (state.recorded.has(learning.id)) continue;
    const held = recordedState(state.view.entries, learning.id);
    if (held === null || held.contentSha256 !== learning.sha256 || FINISHED_BY_OWN_COMMAND.has(held.kind)) continue;
    const [action] = recordedActions(held);
    if (action === undefined) continue;
    const updated = {
      ...learning,
      status: held.status,
      gate: { ...learning.gate, action },
      external: learning.external || held.evidence.external,
      evidence: held.evidence,
      replay: recordedReplay(state.view.entries, learning),
    };
    if (unrecordedReason(updated, state.view) === null) out.push(updated);
  }
  return out;
}

/** Rolls every lagging learning file forward to what the ledger records,
 * under the lock, and returns the ids rewritten. */
export function rollLearningsForward(root, write) {
  const lagging = laggingLearnings(readState(root));
  for (const updated of lagging) write(() => writeJson(learningPath(root, updated.id), updated));
  return lagging.map(l => l.id);
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
 * ledger, the learnings it vouches for, the local gate file and the
 * committed one. Throws when the learnings directory cannot be listed. */
export function readState(root) {
  const { learnings, unreadable } = readLearnings(root);
  const view = readLedgerView(root);
  return {
    learnings, unreadable, view,
    recorded: recordedLearnings(learnings, view),
    local: readLocalGates(root),
    committed: committedGates(root),
  };
}

/** The learnings in `state` the ledger vouches for. */
export const recordedIn = state => state.learnings.filter(l => state.recorded.has(l.id));

/**
 * The local gate entries as the ledger in `state` (`readState`'s shape)
 * requires them: `{ gates, changed, modified }`, where `changed` are the
 * ids to report and `modified` whether `gates` differs from the entries
 * given. With the ledger broken it records nothing, so every learned gate
 * and every suspension goes and none is restored.
 *
 * Nothing stays unless the ledger accounts for it. A gate entry stays only
 * when its learning is recorded in a state that keeps a local gate
 * (`keepsLocalGate`), its content hash is the learning's, its action is the
 * one the recorded state grants, and no earlier entry has its id. A suspension, exactly `{ id,
 * suspended: true }`, stays only when `suspensionStands` and no earlier
 * entry has its id: any other would switch off the gate it shadows unseen.
 * A recorded learning in a state that keeps a local gate with no entry left
 * gets its own gate, and a suspension that stands with no entry left is
 * written again. A gate whose learning file cannot be read stays only at
 * `observe`, and is reported either way. An entry with no usable id is
 * dropped and reported by its 1-based place in the file, as `entry <n>`.
 */
function repairedGates(gates, state) {
  const { learnings, unreadable, recorded } = state;
  const learningById = new Map(learnings.map(l => [l.id, l]));
  const unknown = new Set(unreadable);
  const kept = [];
  const present = new Set();
  const changed = new Set();
  let modified = false;
  for (const [index, entry] of gates.entries()) {
    const id = entryId(entry);
    if (!isGateEntry(entry)) {
      if (isSuspension(entry) && !present.has(id) && suspensionStands(state, id)) {
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
    const held = recorded.get(id);
    const sound = learning !== undefined && held !== undefined && keepsLocalGate(state, learning, held) && !present.has(id)
      && gateSha256(entry) === learning.sha256 && recordedActions(held).includes(entry.action);
    if (sound) {
      kept.push(entry);
      present.add(id);
    } else {
      changed.add(id);
      modified = true;
    }
  }
  for (const learning of learnings) {
    const held = recorded.get(learning.id);
    if (held === undefined || !keepsLocalGate(state, learning, held) || present.has(learning.id)) continue;
    kept.push(learning.gate);
    changed.add(learning.id);
    modified = true;
  }
  for (const id of new Set(state.view.entries.map(e => e?.learningId).filter(isId))) {
    if (present.has(id) || !suspensionStands(state, id)) continue;
    kept.push({ id, suspended: true });
    present.add(id);
    changed.add(id);
    modified = true;
  }
  return { gates: kept, changed: [...changed].sort(idOrder), modified };
}

/**
 * Whether the recorded learning `learning`, its ledger state `held`, keeps
 * its gate in the local set: in a status that does, or `landed` while the
 * gate the hook loads from the committed file under its id, as
 * `committedGates` reads it, is not its gate at the approved action. The
 * hook lets a local entry replace a committed one only when it is the same
 * rule and not weaker, so once the committed gate is in force as approved a
 * local entry adds nothing. Without it, as on a checkout that lacks the
 * committed gate or after a revert stopped between the repository write and
 * its ledger entry, the approval still stands here, through the local gate.
 */
function keepsLocalGate(state, learning, held) {
  if (LOCAL_GATE_STATUSES.has(held.status)) return true;
  if (held.status !== 'landed') return false;
  const committed = state.committed.find(g => g.id === learning.id);
  return committed === undefined || gateSha256(committed) !== learning.sha256 || committed.action !== held.action;
}

/**
 * Whether a local suspension of `id` is one the ledger accounts for: the
 * ledger's last status entry for it is `suspended`, and the gate the hook
 * loads from the committed file under that id, as `committedGates` reads
 * it, has the content hash that entry names: the gate the suspension was
 * written to switch off. The hook switches off by id, so a suspension of a
 * gate that was only ever local, of a committed gate whose content has since
 * changed, or of one a different gate with the same id now precedes,
 * switches off something the ledger never recorded as suspended.
 */
function suspensionStands(state, id) {
  const last = recordedState(state.view.entries, id);
  if (last?.status !== 'suspended') return false;
  return state.committed.some(g => g.id === id && gateSha256(g) === last.contentSha256);
}

/** Every ledger entry that granted an action above `observe`: who approved
 * which content of which learning, at which action, and when. */
const approvalsIn = entries => entries
  .filter(e => e?.kind === 'promoted' && isApprover(e.approvedBy) && ABOVE_OBSERVE.has(e.action))
  .map(e => ({ id: e.learningId, sha256: e.contentSha256, action: e.action, approvedBy: e.approvedBy, ts: e.ts }));

/** The ids of the local gate entries above `observe` that the approval in
 * force for their learning does not grant: the last status-changing ledger
 * entry for the id must be an `ACTION_KINDS` entry, by an approver, of the
 * entry's content at the entry's action: a promotion, or a landing or revert
 * that carries one on. An approval the learning has since lost grants
 * nothing. The repair removes each of these, since an entry above `observe`
 * stays only on such an entry. */
export function unapprovedGateIds(gates, ledgerEntries) {
  const ids = new Set();
  for (const entry of gates) {
    if (!isGateEntry(entry) || !ABOVE_OBSERVE.has(entry.action)) continue;
    const state = recordedState(ledgerEntries, entry.id);
    const approved = state !== null && ACTION_KINDS.includes(state.kind) && state.approvedBy !== null
      && state.contentSha256 === gateSha256(entry) && state.action === entry.action;
    if (!approved) ids.add(entry.id);
  }
  return [...ids].sort(idOrder);
}

/** Brings the local gate set into line with what the ledger grants, under
 * the lock, and returns the ids changed. A local gate file that is not a
 * gate file is left as it is. */
export function repairLocalGates(root, write) {
  const state = readState(root);
  const { local } = state;
  if (!local.file) return [];
  const repair = repairedGates(local.file.gates, state);
  if (repair.modified) write(() => writeJson(localGatesPath(root), { ...local.file, gates: repair.gates }));
  return repair.changed;
}

/** Writes the local gate set as the repair keeps it once the committed file
 * no longer holds the gate `id`, `state` being `readState` under the lock:
 * a landed learning's gate is then back in the set, so a step about to take
 * that gate out of the repository calls this first and the approval is never
 * out of force on this machine. A local gate file that is not a gate file
 * is left as it is. */
export function holdLocalGate(root, write, state, id) {
  if (!state.local.file) return;
  const repair = repairedGates(state.local.file.gates, { ...state, committed: state.committed.filter(g => g.id !== id) });
  if (repair.modified) write(() => writeJson(localGatesPath(root), { ...state.local.file, gates: repair.gates }));
}

/** Writes the local gate file afresh as exactly the gates and suspensions
 * the ledger in `state`, taken under the lock, accounts for, over a file
 * that is not a gate file; returns the ids of the entries it holds. The
 * ledger must be intact, or it accounts for nothing and the file would be
 * emptied for no reason. Throws when the file cannot be written. */
export function rewriteLocalGates(root, write, state) {
  const rebuilt = repairedGates([], state);
  write(() => writeJson(localGatesPath(root), { schema: 1, gates: rebuilt.gates }));
  return rebuilt.changed;
}

const union = (a = [], b = []) => [...new Set([...a, ...b])].sort(idOrder);

/** `result` with what a repair changed added to what it already reports:
 * the gate ids as `repairedGates`, always on success and on an error only
 * when there are any, and the learning files rolled forward as
 * `rolledForward`, only when there are any. */
export function withRepairs(result, { repairedGates, rolledForward }) {
  const gates = union(result.repairedGates, repairedGates);
  const rolled = union(result.rolledForward, rolledForward);
  return {
    ...result,
    ...(result.error === undefined || gates.length > 0 ? { repairedGates: gates } : {}),
    ...(rolled.length > 0 ? { rolledForward: rolled } : {}),
  };
}

/**
 * Runs `step(write)` under the learnings lock once lagging learning files
 * are rolled forward and the local gate set is repaired, and returns its
 * result with what that changed, as `withRepairs` adds it.
 */
export function repairedStep(root, step) {
  return withLearningsLock(root, write => {
    const rolledForward = rollLearningsForward(root, write);
    const repairedGates = repairLocalGates(root, write);
    return withRepairs(step(write), { repairedGates, rolledForward });
  });
}

/** `refusal`, a result met before the lock was taken, once the repair the
 * call owes has run; a repair that cannot run leaves it as it is. */
export function refuse(root, refusal) {
  const result = repairedStep(root, () => refusal);
  return result.error === refusal.error ? result : refusal;
}

/** The ids the ledger and the learning files disagree about: each readable
 * learning the ledger does not vouch for, and each id the ledger names that
 * has no learning file. */
function ledgerMismatches(state) {
  const unrecorded = state.learnings.filter(l => !state.recorded.has(l.id)).map(l => l.id);
  return [...unrecorded, ...fileless(state)].sort(idOrder);
}

/** `{ learning }` for the readable learning `id` in `state`, or an error:
 * the id names nothing that can be read. */
export function learningIn(state, id) {
  if (state.unreadable.includes(id)) return failed(`${id}: the learning file does not read back as a learning`);
  const learning = state.learnings.find(l => l.id === id);
  return learning === undefined ? failed(`${id}: no such learning`) : { learning };
}

/** The learning ids the ledger in `state` names that have no learning file,
 * readable or not, in id order. */
export function fileless(state) {
  const files = new Set([...state.learnings.map(l => l.id), ...state.unreadable]);
  return [...new Set(state.view.entries.map(e => e?.learningId).filter(id => isId(id) && !files.has(id)))].sort(idOrder);
}

/**
 * The id of a learning that stands for `signature`, or null: one whose file
 * or ledger entries name the signature, unless the ledger's last word on it
 * is a settled status and its file, if one is left, agrees.
 */
export function standingFor(state, signature) {
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

/**
 * Every learning the ledger in `state` ties to `signature`, in id order:
 * `{ id, kind: null }` for one whose ledger entries name the signature
 * itself, and `{ id, kind: { id, title } }` for one that names another
 * signature which a failure kind in `kinds` labels together with this one.
 * With no kinds, as when the taxonomy cannot be read, only the signature
 * itself counts.
 */
function tiedTo(state, signature, kinds) {
  const signatures = new Map();
  for (const e of state.view.entries) {
    if (!isId(e?.learningId) || !isString(e.evidence?.signature)) continue;
    if (!signatures.has(e.learningId)) signatures.set(e.learningId, new Set());
    signatures.get(e.learningId).add(e.evidence.signature);
  }
  const siblingKinds = kinds.filter(k => k.signatures.includes(signature));
  const out = [];
  for (const id of [...signatures.keys()].sort(idOrder)) {
    const cited = signatures.get(id);
    if (cited.has(signature)) out.push({ id, kind: null });
    else {
      const kind = siblingKinds.find(k => k.signatures.some(s => cited.has(s)));
      if (kind !== undefined) out.push({ id, kind: { id: kind.id, title: kind.title } });
    }
  }
  return out;
}

/** How a learning ended that speaks against drafting its recurrence again,
 * in the words an error and a listing give it. */
export const ENDINGS = Object.freeze({
  rejected: 'rejected by the replay',
  wrong: 'retired after a wrong mark',
  suspended: 'retired after its gate was suspended',
  owner: 'retired by the owner',
});

/** The key in `ENDINGS` for how the learning `id` ended, or null when it
 * has not ended, or ended retired with nothing against it: by `tick`, its
 * cited paths or its file gone, never marked wrong or suspended. */
function endingOf(entries, id) {
  const last = recordedState(entries, id);
  if (last?.status === 'rejected') return 'rejected';
  if (last?.status !== 'retired') return null;
  const own = entries.filter(e => e?.learningId === id);
  if (own.some(e => e.kind === 'wrong')) return 'wrong';
  if (own.some(e => e.kind === 'suspended')) return 'suspended';
  return last.approvedBy === 'owner' ? 'owner' : null;
}

/**
 * The learnings tied to `signature` (`tiedTo`) that ended in a way that
 * bars a plain draft for it, in id order, each `{ id, kind, ended }` with
 * `ended` a key of `ENDINGS`: rejected by its replay, or retired after a
 * wrong mark, after a suspension, or by the owner. A draft after any of
 * them is a redraft, the owner's decision.
 */
export function earlierFor(state, signature, kinds) {
  return tiedTo(state, signature, kinds)
    .map(tie => ({ ...tie, ended: endingOf(state.view.entries, tie.id) }))
    .filter(tie => tie.ended !== null);
}

/** The ids of the learnings tied to `signature` (`tiedTo`), other than
 * `except`, that the ledger records a wrong mark for, in id order. */
export function wrongMarkedFor(state, signature, kinds, except) {
  const marked = new Set(state.view.entries.filter(e => e?.kind === 'wrong').map(e => e.learningId));
  return tiedTo(state, signature, kinds).map(tie => tie.id).filter(id => id !== except && marked.has(id));
}

/** The learnings `earlierFor` returns, as kit text: each id, what it was
 * drafted for, this signature or another of the failure kind that ties it
 * to this one, and how it ended. */
const earlierText = earlier => earlier
  .map(e => `${e.id} (drafted for ${e.kind === null ? 'this signature' : `another signature of failure kind ${e.kind.id}`}, ${ENDINGS[e.ended]})`).join(', ');

/** The ids of the learnings in `state` that are neither rejected nor
 * retired and whose id the committed gate file holds for another gate, in
 * id order. The gate hook applies the committed gate under that id and
 * ignores the local one, and a landing over it is refused. */
export function idCollisions(state) {
  const committed = new Map(state.committed.map(g => [g.id, gateSha256(g)]));
  return state.learnings.filter(l => !SETTLED.has(l.status) && committed.has(l.id) && committed.get(l.id) !== l.sha256).map(l => l.id);
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
  if (counter === null) return failed('the learning id counter cannot be read, so no id that was never used can be assigned');
  const committed = committedIdsInUse(root);
  if (committed.unreadable) return failed('the committed gate file cannot be read, so no id that avoids its ids can be assigned');
  const used = [
    ...state.learnings.map(l => l.id),
    ...committed.ids,
    ...state.view.entries.map(e => e?.learningId).filter(isId),
    ...(state.local.file ? learningIdsIn(state.local.file.gates) : []),
  ].map(idNumber);
  const highest = Math.max(counter, ...used);
  if (highest >= ID_NUMBER_MAX) return failed('no learning id is left to assign');
  return { id: `L${highest + 1}`, number: highest + 1 };
}

/** The ledger entry `kind` for `learning` under `identity`, the harness the
 * event happened under. `approvedBy` names who decided the step, null when
 * a rule did; `action` and `firing` are carried by the kinds that require
 * them. With `prose`, the entry also records the hash of the learning's
 * title, why and evidence, which a status-changing entry does for every
 * learning the ledger already vouches for in full. */
export const ledgerEntry = (learning, identity, { kind, approvedBy = null, action, firing, detail }, prose = false) => ({
  kind,
  learningId: learning.id,
  contentSha256: learning.sha256,
  proseSha256: prose ? proseSha256Of(learning) : undefined,
  evidence: learning.evidence,
  base: identity.base,
  learned: identity.learned,
  approvedBy,
  action,
  firing,
  detail,
});

/**
 * What `writeTransition` would write for one change to a learning, writing
 * nothing: `{ records, gates }`, the ledger entries built from `entries`
 * under `identity` and the local gate entries as the ledger will then
 * account for them (null when they stay as they are), or `{ error }` when
 * the local gate file, which the change needs, is not a gate file, or when
 * the set would grow past its limit. A step that must not start a change it
 * cannot finish asks this before its first write.
 *
 * The entries record the hash of the learning's title, why and evidence
 * when its last status entry does, or when one of `entries` is marked
 * `bindsProse`: a step by the owner at a terminal whose run prints that
 * text. Any other step on a learning drafted before the ledger recorded the
 * hash leaves it unrecorded.
 */
export function planTransition(state, { updated, entries, identity }) {
  const prose = !proseUnrecorded(state.view.entries, updated.id) || entries.some(spec => spec.bindsProse === true);
  const records = entries.map(spec => ledgerEntry(updated, identity, spec, prose));
  const entriesAfter = [...state.view.entries, ...records];
  const held = recordedState(entriesAfter, updated.id);
  const after = {
    ...state,
    learnings: state.learnings.map(l => (l.id === updated.id ? updated : l)),
    recorded: new Map(state.recorded).set(updated.id, held),
    view: { ...state.view, entries: entriesAfter },
  };
  if (!state.local.file) {
    if (updated.status === 'suspended' || keepsLocalGate(after, updated, held)) return refused('the local gate file is not a gate file; nothing was written');
    return { records, gates: null };
  }
  const before = state.local.file.gates;
  const repair = repairedGates(before, after);
  const count = list => list.filter(isGateEntry).length;
  if (count(repair.gates) > GATE_LIMITS.gatesMax && count(repair.gates) > count(before)) {
    return refused(`the local gate set would hold more than ${GATE_LIMITS.gatesMax} gates; nothing was written`);
  }
  return { records, gates: repair.modified ? repair.gates : null };
}

/**
 * Writes one change to a learning under the lock: its ledger entries, built
 * from `entries`, then the learning as `updated`, then the local gate set as
 * the ledger will then account for it: a `suspended` entry for a committed
 * gate brings its local suspension with it. `state` is `readState` taken
 * under the same lock. `identity` is the harness the entries name, by
 * default the one in force now: every entry precedes this call's writes, so
 * it is the harness before the step, and a step that wrote elsewhere first
 * passes the one it took before those writes. Returns `{}`, or `{ error }`
 * with nothing written, as `planTransition` decides.
 */
export function writeTransition(root, write, state, { updated, entries, identity = harnessIdentity(root) }) {
  const planned = planTransition(state, { updated, entries, identity });
  if (planned.error) return planned;
  for (const record of planned.records) write(() => appendLedger(root, record));
  write(() => writeJson(learningPath(root, updated.id), updated));
  if (planned.gates !== null) write(() => writeJson(localGatesPath(root), { ...state.local.file, gates: planned.gates }));
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
 * draft until it is mended or removed. The signature must be one a failure
 * kind in `docs/harness/FAILURES.md` lists: only the owner names a failure,
 * and nothing is drafted for one nobody named. A recurrence an earlier
 * learning ended against (`earlierFor`), by its signature or by another
 * signature its failure kind labels, is drafted again only with `redraft`,
 * and its `proposed` entry then names those learnings. Returns `{ learning,
 * repairedGates }`, or `{ error, exitCode }`.
 */
export function draftLearning(root, draft, { redraft = false } = {}) {
  try {
    return draftUnguarded(root, draft, redraft === true);
  } catch (error) {
    return readFailure(error);
  }
}

function draftUnguarded(root, draft, redraft) {
  const malformed = error => refuse(root, failed(error));
  if (!isPlainObject(draft)) return malformed('draft: must be an object');
  if (Object.keys(draft).some(k => !DRAFT_KEYS.has(k))) return malformed('draft: may have only the keys signature, title, why and gate');
  const { signature } = draft;
  if (!isString(signature) || !SIGNATURE.test(signature)) return malformed('signature: must be 16 lowercase hex characters');
  const title = proseField('title', draft.title, TITLE_MAX);
  if (title.error) return malformed(title.error);
  const why = proseField('why', draft.why, WHY_MAX);
  if (why.error) return malformed(why.error);
  const drafted = draftedGate(draft.gate);
  if (drafted.error) return malformed(drafted.error);
  const recurrence = currentRecurrence(root, r => r.signature === signature);
  if (recurrence === undefined) return malformed('signature: not the signature of a current recurrence');
  if (drafted.gate.tool !== recurrence.tool) return malformed("gate: tool must be the recurrence's tool");
  const kinds = failureKinds(root);
  const failureId = failureIdIn(kinds, signature);
  if (failureId === null) {
    return refuse(root, refused(`signature: no failure kind in ${FAILURES_PATH} lists this signature, and only the owner names a failure: `
      + 'a learning is drafted once the owner has added it there, as `- signatures: <signature>` under a `## F<n> — <kind of failure>` heading'));
  }

  return repairedStep(root, write => {
    const state = readState(root);
    if (state.unreadable.length > 0) return refused(`learning ${state.unreadable[0]} does not read back as a learning, and may cover this signature; mend or remove its file first`);
    if (!state.view.intact) return refused('the ledger cannot be read or its chain is broken, so no learning can be told settled and no id never used can be assigned');
    const standing = standingFor(state, signature);
    if (standing !== null) {
      const gone = fileless(state).includes(standing) ? '; its learning file is gone, and `tick` records it retired, after which this recurrence can be drafted' : '';
      return refused(`signature: learning ${standing} already covers this signature${gone}`);
    }
    const earlier = earlierFor(state, signature, kinds);
    if (earlier.length > 0 && !redraft) {
      return refused(`signature: an earlier learning for this recurrence did not hold: ${earlierText(earlier)}; a new draft for it is the owner's decision, as \`learn --help\` documents`);
    }
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
    const detail = earlier.length > 0 ? `a redraft; earlier: ${earlierText(earlier)}` : undefined;
    write(() => appendLedger(root, ledgerEntry(learning, harnessIdentity(root), { kind: 'proposed', detail }, true)));
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
 * that is not a gate file is left as it is, which refuses a pass. The
 * repair runs before the learning is read, so a replay whose last run
 * stopped after its ledger entry finds the learning as that entry left it.
 * Returns `{ replay, status, repairedGates }`, or `{ error, exitCode }`.
 */
export function runTrial(root, id) {
  try {
    return runTrialUnguarded(root, id);
  } catch (error) {
    return readFailure(error);
  }
}

function runTrialUnguarded(root, id) {
  if (!isId(id)) return refuse(root, failed(ID_ERROR));
  const ready = repairedStep(root, () => {
    const state = readState(root);
    const found = learningIn(state, id);
    if (found.error) return found;
    const { learning } = found;
    if (learning.status !== 'candidate') return refused(`${id} is ${learning.status}; only a candidate is replayed`);
    const unrecorded = unrecordedReason(learning, state.view);
    return unrecorded === null ? { learning } : refused(unrecorded);
  });
  if (ready.error) return ready;
  const { learning } = ready;
  const { signature, harness } = learning;
  const recurrence = currentRecurrence(root, r => r.signature === signature && r.base === harness.base && r.model === harness.model);
  if (recurrence === undefined) {
    return withRepairs(refused(`${id}: its signature is no longer a current recurrence under the harness and model it was drafted for`), ready);
  }
  const replay = replayGate(root, learning.gate, recurrence);
  const status = replay.verdict === 'pass' ? 'trial' : replay.verdict === 'fail' ? 'rejected' : 'candidate';
  const failureId = failureIdFor(root, signature);

  const done = repairedStep(root, write => {
    const state = readState(root);
    const current = state.learnings.find(l => l.id === id);
    if (current?.status !== 'candidate' || current.sha256 !== learning.sha256) return failed(`${id} changed while it was replayed; nothing was written`);
    const unrecordedNow = unrecordedReason(current, state.view);
    if (unrecordedNow !== null) return refused(unrecordedNow);
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
  return withRepairs(done, ready);
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

/** The ids of the learnings in `state` the ledger vouches for that are
 * promoted on this machine (`active-local`) and every path of whose `cites`
 * is gone; a landed learning is not reported. Anything running as this user
 * can delete a file, so no rule retires an enforcing gate for this; it
 * stays in force until the owner retires it at a terminal. */
export function citationsGone(root, state) {
  return recordedIn(state).filter(l => l.status === 'active-local' && citesGone(root, l)).map(l => l.id);
}

/**
 * Every learning on this machine for the repository, in id order:
 * `{ learnings, gatesToRepair, unapprovedGates, citationsGone, idCollisions,
 * ledgerMismatch, lagging, proseUnrecorded, ledgerIntact, unreadable,
 * approvals }`. The ledger, not a learning's file, is the authority for its
 * status. `gatesToRepair` are the ids whose local gate entries the next
 * step that writes removes, replaces or restores, and every gate whose
 * learning file cannot be read; `unapprovedGates` the ids of the local gate
 * entries above `observe` that no approval in the ledger grants, which that
 * step removes; both null when the local gate file cannot be read.
 * `citationsGone` are the learnings promoted on this machine whose cited
 * paths are all gone, as `citationsGone` finds them, and `idCollisions`
 * those whose id the committed gate file holds for another gate
 * (`idCollisions`). `ledgerMismatch` are the ids of the learnings the
 * ledger does not vouch for (all of them when `ledgerIntact` is false, since
 * the ledger then records nothing) and the ids the ledger names with no
 * learning file; `lagging`, those of them whose file the next step that
 * writes rolls forward to the ledger; `proseUnrecorded`, the learnings the
 * ledger vouches for without a hash of their title, why and evidence;
 * `unreadable` the ids whose learning file does not read back as a
 * learning; `approvals` every promotion in the ledger, as `{ id, sha256,
 * action, approvedBy, ts }`. An error when the learnings cannot be listed.
 */
export function listLearnings(root) {
  try {
    const state = readState(root);
    const { learnings, unreadable, view, local } = state;
    return {
      learnings,
      gatesToRepair: local.file ? repairedGates(local.file.gates, state).changed : null,
      unapprovedGates: local.file ? unapprovedGateIds(local.file.gates, view.entries) : null,
      citationsGone: citationsGone(root, state),
      idCollisions: idCollisions(state),
      ledgerMismatch: ledgerMismatches(state),
      lagging: laggingLearnings(state).map(l => l.id),
      proseUnrecorded: recordedIn(state).filter(l => proseUnrecorded(view.entries, l.id)).map(l => l.id),
      ledgerIntact: view.intact,
      unreadable,
      approvals: approvalsIn(view.entries),
    };
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * What the session log and the ledger record of a learning's gate, as
 * `gateStats` counts them for its id and content, which is how `log report`
 * counts them too: `firings`, the well-formed `gate_firing` events for it;
 * `sessions`, how many sessions hold one; `rerouted`, the `warn` and `block`
 * firings after which the next call of the gate's tool in that session
 * succeeded; `wrong`, the firings marked wrong since its last promotion or
 * landing, or ever when it had neither; `wrongTotal`, those marked wrong in all;
 * `sessionsUnreadable`; and `places`, where each of those firings is, oldest
 * first: `{ sessionId, line, action, ts, markedWrong }`, `sessionId` and
 * `line` as a wrong mark names the firing and `markedWrong` whether the
 * ledger records a mark of it for this learning. Reads only. Returns
 * `{ error }` for an id that names no learning, for a learning the ledger
 * does not vouch for, or when the log cannot be read.
 */
export function learningStats(root, id) {
  try {
    return learningStatsUnguarded(root, id);
  } catch (error) {
    return readFailure(error);
  }
}

function learningStatsUnguarded(root, id) {
  if (!isId(id)) return failed(ID_ERROR);
  const read = readLearning(root, id);
  if (read.missing) return failed(`${id}: no such learning`);
  if (read.unreadable) return failed(`${id}: the learning file does not read back as a learning`);
  const view = readLedgerView(root);
  const unrecorded = unrecordedReason(read.learning, view);
  if (unrecorded !== null) return refused(unrecorded);
  const { gates, sessionsUnreadable } = gateStats(root, view.entries, new Map([[id, read.learning.sha256]]), { places: true });
  const { firings, sessions, rerouted, places, wrong } = gates.get(id);
  const marked = new Set(view.entries
    .filter(e => e?.kind === 'wrong' && e.learningId === id && isPlainObject(e.firing))
    .map(e => placeKey(e.firing)));
  return {
    firings, sessions, rerouted, wrong: wrong.sinceGrant, wrongTotal: wrong.total, sessionsUnreadable,
    places: places.toSorted(byTime).map(p => ({ ...p, markedWrong: marked.has(placeKey(p)) })),
  };
}

const placeKey = ({ sessionId, line }) => JSON.stringify([sessionId, line]);
// Oldest first, a firing with no time before every other; `toSorted` is
// stable, so firings of one time keep the order they were read in.
const byTime = (a, b) => ((a.ts ?? '') < (b.ts ?? '') ? -1 : (a.ts ?? '') > (b.ts ?? '') ? 1 : 0);
