// scripts/lib/learn-lib.mjs
//
// A learning's life up to its silent trial: a model drafts one small gate
// for a recurring failure, this module validates the draft, replays the
// gate against the recorded sessions and, when the replay passes, puts it in
// this machine's local gate set with action `observe`, where it logs what it
// would have done and changes nothing.
//
// A draft is untrusted, model-written input: every field is checked before
// anything is stored, and an error is fixed text naming the field and the
// rule broken, never the value. Everything this module writes goes to the
// repository's per-machine data directory; it reads the repository and
// never writes inside it.
//
// Every transition is written ledger first, then the learning, then the
// local gate set, so an interrupted step leaves a ledger entry with less in
// force than it says, never a gate in force that the ledger does not record.
// `listLearnings` reports what an interrupted step left disagreeing, and the
// next `runTrial` repairs the local gate set. No exported function throws.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { GATE_LIMITS, gateSha256, validateGate } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, harnessIdentity, LOCAL_GATES_FILE, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { maskText, stripUnsafe } from '../../assets/scripts/harness-redact.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { FAILURES_PATH, parseFailures } from './failures-evidence.mjs';
import { LOCKED, withFileLock } from './file-lock.mjs';
import { appendLedger, readLedger } from './ledger.mjs';
import { FAILURE_EVENT, findRecurrences, sessionIds, SUCCESS_EVENT, TOOL_FIELD } from './recurrence.mjs';
import { replayGate } from './replay.mjs';
import { readIfPresent } from './scan.mjs';

const STATUSES = new Set(['candidate', 'rejected', 'trial', 'active-local', 'landed', 'suspended', 'retired']);

// The actions a learning's gate may carry in each status. A status absent
// here allows none, so a learning file in it does not read back.
const GATE_ACTIONS = Object.freeze({
  candidate: Object.freeze(['observe']),
  rejected: Object.freeze(['observe']),
  trial: Object.freeze(['observe']),
});

/** The actions a learning's gate may carry while the learning is in
 * `status`; none for a status this module does not hold gates in. */
export function gateActionsFor(status) {
  return Object.hasOwn(GATE_ACTIONS, status) ? GATE_ACTIONS[status] : [];
}

// The status each ledger kind leaves a learning in; a kind absent here, such
// as `wrong`, changes no status.
const STATUS_AFTER = Object.freeze({ proposed: 'candidate', replayed: 'candidate', trial: 'trial', rejected: 'rejected' });

// A learning in one of these no longer stands for its signature, so a new
// draft for the signature may be made.
const SETTLED = new Set(['rejected', 'retired']);

// The statuses whose gate lives in the local gate set.
const LOCAL_GATE_STATUSES = new Set(['trial', 'active-local']);

const LEARNINGS_DIR = 'learnings';
// The highest id ever assigned on this machine for this repository, so the
// number of a rejected or removed learning is never assigned again.
const ID_COUNTER_FILE = 'learning-ids.json';
const LOCK_FILE = 'learnings.lock';

const FIRING_EVENT = 'gate_firing';

const TITLE_MAX = 120;
const WHY_MAX = 300;
const ID_NUMBER_MAX = 999_999_999;

const ID = /^L([1-9][0-9]{0,8})$/;
const LEARNING_FILE = /^(L[1-9][0-9]{0,8})\.json$/;
const SIGNATURE = /^[0-9a-f]{16}$/;
const LINE_BREAK = /[\n\p{Zl}\p{Zp}]/u;
const DRAFT_KEYS = new Set(['signature', 'title', 'why', 'gate']);

const ID_ERROR = 'id: must be L followed by 1 to 9 digits, without a leading zero';

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = v => typeof v === 'string';
const isId = v => isString(v) && ID.test(v);
const idNumber = id => Number(ID.exec(id)[1]);
const byIdNumber = (a, b) => idNumber(a) - idNumber(b);
const codeOf = error => (isString(error?.code) ? error.code : 'unknown');

const learningsDir = root => join(repoDataDir(root), LEARNINGS_DIR);
const learningPath = (root, id) => join(learningsDir(root), `${id}.json`);
const localGatesPath = root => join(repoDataDir(root), LOCAL_GATES_FILE);

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

/** What an exported function returns when something it reads before taking
 * the lock cannot be read. */
const readFailure = error => ({ error: `what this step reads could not be read (${codeOf(error)}); nothing was written` });

/**
 * Runs `fn` holding the lock every update to a learning, the id counter and
 * the local gate set is made under, and returns its result. `fn` gets
 * `write`, through which every write goes. Never throws: a lock that could
 * not be taken, or a failure inside `fn`, is returned as `{ error }` saying
 * whether anything was written.
 */
function withLearningsLock(root, fn) {
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
  const ids = names.map(name => LEARNING_FILE.exec(name)?.[1]).filter(isString).sort(byIdNumber);
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
const entryId = entry => (isPlainObject(entry) && isString(entry.id) ? entry.id : null);

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

const keepsLocalGate = learning => LOCAL_GATE_STATUSES.has(learning.status);

/**
 * The local gate entries as `learnings` require them, and the ids whose
 * entries that changes. A gate entry stays only when its learning keeps a
 * local gate, its content hash is the learning's, its action is one the
 * learning's status allows, and no earlier entry has its id; a learning
 * that keeps a local gate and has no entry left gets its own gate. A
 * suspension, an entry with no id, and a gate whose learning file cannot be
 * read are kept as they are.
 */
function repairedGates(gates, learnings, unreadable) {
  const byId = new Map(learnings.map(l => [l.id, l]));
  const unknown = new Set(unreadable);
  const kept = [];
  const present = new Set();
  const changed = new Set();
  for (const entry of gates) {
    const id = entryId(entry);
    if (!isGateEntry(entry) || unknown.has(id)) {
      kept.push(entry);
      if (id !== null) present.add(id);
      continue;
    }
    const learning = byId.get(id);
    const sound = learning !== undefined && keepsLocalGate(learning) && !present.has(id)
      && gateSha256(entry) === learning.sha256 && gateActionsFor(learning.status).includes(entry.action);
    if (sound) {
      kept.push(entry);
      present.add(id);
    } else {
      changed.add(id);
    }
  }
  for (const learning of learnings) {
    if (!keepsLocalGate(learning) || present.has(learning.id)) continue;
    kept.push(learning.gate);
    changed.add(learning.id);
  }
  return { gates: kept, changed: [...changed].sort(byIdNumber) };
}

/** The ids of the readable learnings whose status is not the one their last
 * status-changing ledger entry left them in, a learning with no such entry
 * among them. */
function ledgerMismatches(learnings, ledger) {
  const last = new Map();
  for (const entry of ledger) {
    if (Object.hasOwn(STATUS_AFTER, entry?.kind)) last.set(entry.learningId, STATUS_AFTER[entry.kind]);
  }
  return learnings.filter(l => last.get(l.id) !== l.status).map(l => l.id);
}

const gateFileIds = file => file.gates.map(entryId).filter(isId);

/** `{ ids }` in the committed gate file, none when it is absent, or
 * `{ error }` when it exists and cannot be read as a gate file. */
function committedGateIds(root) {
  let text;
  try {
    text = readFileSync(join(root, GATES_PATH), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ids: [] };
    return { error: 'the committed gate file cannot be read, so no id that avoids its ids can be assigned' };
  }
  let file = null;
  try {
    file = JSON.parse(text);
  } catch {
    // not JSON: refused below
  }
  if (!isPlainObject(file) || !Array.isArray(file.gates)) return { error: 'the committed gate file cannot be read, so no id that avoids its ids can be assigned' };
  return { ids: gateFileIds(file) };
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
function nextId(root, learningIds) {
  const counter = readCounter(root);
  if (counter === null) return { error: 'the learning id counter cannot be read, so no id that was never used can be assigned' };
  const committed = committedGateIds(root);
  if (committed.error) return committed;
  let ledgerIds;
  try {
    ledgerIds = readLedger(root).map(e => e?.learningId).filter(isId);
  } catch {
    return { error: 'the ledger cannot be read, so no id that was never used can be assigned' };
  }
  const local = readLocalGates(root);
  const used = [...learningIds, ...committed.ids, ...ledgerIds, ...(local.file ? gateFileIds(local.file) : [])].map(idNumber);
  const highest = Math.max(counter, ...used);
  if (highest >= ID_NUMBER_MAX) return { error: 'no learning id is left to assign' };
  return { id: `L${highest + 1}`, number: highest + 1 };
}

/** The ledger entry `kind` for `learning` under `identity`, the harness the
 * event happened under. */
const ledgerEntry = (learning, kind, identity, detail) => ({
  kind,
  learningId: learning.id,
  contentSha256: learning.sha256,
  evidence: learning.evidence,
  base: identity.base,
  learned: identity.learned,
  approvedBy: null,
  detail,
});

/**
 * Validates a model-written draft, `{ signature, title, why, gate }` with
 * the gate lacking `id` and `action`, and stores it as a candidate under
 * the next id, recording `proposed` in the ledger. `signature` must be a
 * current recurrence's, and the gate's tool that recurrence's tool; `title`
 * and `why` are stored stripped of what cannot be seen and masked, while a
 * gate string holding a credential or an invisible character refuses the
 * draft. At most one learning that is neither rejected nor retired stands
 * for a signature, and a learning file that does not read back may be one,
 * so it refuses every draft until it is mended or removed. Returns
 * `{ learning }`, or `{ error }`.
 */
export function draftLearning(root, draft) {
  try {
    return draftUnguarded(root, draft);
  } catch (error) {
    return readFailure(error);
  }
}

function draftUnguarded(root, draft) {
  if (!isPlainObject(draft)) return { error: 'draft: must be an object' };
  if (Object.keys(draft).some(k => !DRAFT_KEYS.has(k))) return { error: 'draft: may have only the keys signature, title, why and gate' };
  const { signature } = draft;
  if (!isString(signature) || !SIGNATURE.test(signature)) return { error: 'signature: must be 16 lowercase hex characters' };
  const title = proseField('title', draft.title, TITLE_MAX);
  if (title.error) return title;
  const why = proseField('why', draft.why, WHY_MAX);
  if (why.error) return why;
  const drafted = draftedGate(draft.gate);
  if (drafted.error) return drafted;
  const recurrence = currentRecurrence(root, r => r.signature === signature);
  if (recurrence === undefined) return { error: 'signature: not the signature of a current recurrence' };
  if (drafted.gate.tool !== recurrence.tool) return { error: "gate: tool must be the recurrence's tool" };
  const failureId = failureIdFor(root, signature);

  return withLearningsLock(root, write => {
    const { learnings, unreadable } = readLearnings(root);
    if (unreadable.length > 0) return { error: `learning ${unreadable[0]} does not read back as a learning, and may cover this signature; mend or remove its file first` };
    const standing = learnings.find(l => l.signature === signature && !SETTLED.has(l.status));
    if (standing !== undefined) return { error: `signature: learning ${standing.id} already covers this signature` };
    const next = nextId(root, learnings.map(l => l.id));
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
    write(() => appendLedger(root, ledgerEntry(learning, 'proposed', harnessIdentity(root))));
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
 * Under the same lock the local gate set is brought into line with the
 * learnings, as `listLearnings` reports under `gatesToRepair`; the ids it
 * changed, beyond adding this learning's gate on a pass, are
 * `repairedGates`. A local
 * gate file that is not a gate file is left as it is, which refuses a pass
 * and skips the repair otherwise. Returns `{ replay, status, repairedGates }`,
 * or `{ error }`.
 */
export function runTrial(root, id) {
  try {
    return runTrialUnguarded(root, id);
  } catch (error) {
    return readFailure(error);
  }
}

function runTrialUnguarded(root, id) {
  if (!isId(id)) return { error: ID_ERROR };
  const read = readLearning(root, id);
  if (read.missing) return { error: `${id}: no such learning` };
  if (read.unreadable) return { error: `${id}: the learning file does not read back as a learning` };
  const { learning } = read;
  if (learning.status !== 'candidate') return { error: `${id} is ${learning.status}; only a candidate is replayed` };
  const { signature, harness } = learning;
  const recurrence = currentRecurrence(root, r => r.signature === signature && r.base === harness.base && r.model === harness.model);
  if (recurrence === undefined) return { error: `${id}: its signature is no longer a current recurrence under the harness and model it was drafted for` };
  const replay = replayGate(root, learning.gate, recurrence);
  const status = replay.verdict === 'pass' ? 'trial' : replay.verdict === 'fail' ? 'rejected' : 'candidate';
  const failureId = failureIdFor(root, signature);

  return withLearningsLock(root, write => {
    const current = readLearning(root, id).learning;
    if (current?.status !== 'candidate' || current.sha256 !== learning.sha256) return { error: `${id} changed while it was replayed; nothing was written` };
    const updated = {
      ...current,
      failureId,
      status,
      gate: { ...current.gate, action: 'observe' },
      external: current.external || recurrence.external,
      evidence: evidenceOf(recurrence),
      replay,
    };
    const local = readLocalGates(root);
    if (local.unreadable && status === 'trial') return { error: 'the local gate file is not a gate file; nothing was written' };
    const { learnings, unreadable } = readLearnings(root);
    let repaired = [];
    let gates = null;
    if (local.file) {
      repaired = repairedGates(local.file.gates, learnings, unreadable).changed;
      const after = repairedGates(local.file.gates, learnings.map(l => (l.id === id ? updated : l)), unreadable);
      if (after.gates.filter(isGateEntry).length > GATE_LIMITS.gatesMax) return { error: `the local gate set would hold more than ${GATE_LIMITS.gatesMax} gates; nothing was written` };
      if (after.changed.length > 0) gates = after.gates;
    }
    // Both entries precede the writes, so they name the harness in force
    // before this step: the learned set without this learning's gate.
    const identity = harnessIdentity(root);
    write(() => appendLedger(root, ledgerEntry(updated, 'replayed', identity, `${replay.verdict}: ${replay.reason}`)));
    if (status !== 'candidate') write(() => appendLedger(root, ledgerEntry(updated, status, identity)));
    write(() => writeJson(learningPath(root, id), updated));
    if (gates !== null) write(() => writeJson(localGatesPath(root), { ...local.file, gates }));
    return { replay, status, repairedGates: repaired };
  });
}

/**
 * Every learning on this machine for the repository, in id order:
 * `{ learnings, gatesToRepair, ledgerMismatch, unreadable }`.
 * `gatesToRepair` are the ids whose local gate entries the next `runTrial`
 * removes, replaces or restores: a gate whose learning is missing or does
 * not keep a local gate, whose content differs from its learning's, whose
 * action its learning's status does not allow, or whose id appears twice,
 * and a learning that keeps a local gate and has none; null when the local
 * gate file cannot be read. `ledgerMismatch` are the ids whose status is not
 * the one their last status-changing ledger entry records, null when the
 * ledger cannot be read; `unreadable` the ids whose learning file does not
 * read back as a learning. `{ error }` when the learnings cannot be listed.
 */
export function listLearnings(root) {
  try {
    const { learnings, unreadable } = readLearnings(root);
    const local = readLocalGates(root);
    const gatesToRepair = local.file ? repairedGates(local.file.gates, learnings, unreadable).changed : null;
    let ledgerMismatch;
    try {
      ledgerMismatch = ledgerMismatches(learnings, readLedger(root));
    } catch {
      ledgerMismatch = null;
    }
    return { learnings, gatesToRepair, ledgerMismatch, unreadable };
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * What the session log records of a learning's gate: `firings`, the
 * `gate_firing` events for its id and content; `sessions`, how many sessions
 * hold one; `rerouted`, the firings after which the next call of the gate's
 * tool in that session, the fired call itself excepted, succeeded; and
 * `wrong`, the ledger's `wrong` entries for the learning. A firing whose
 * call carries no tool use id is never counted as rerouted, since the fired
 * call cannot then be told from the next. `sessionsUnreadable` counts the
 * sessions that could not be read in full, whose counts are what did parse.
 * Returns `{ error }` for an id that names no learning, or when the log or
 * the ledger cannot be read.
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
  const { sha256 } = read.learning;
  let firings = 0;
  let rerouted = 0;
  let sessionsUnreadable = 0;
  const sessions = new Set();
  for (const sessionId of sessionIds(root)) {
    const { events, unreadable } = readEvents(root, sessionId);
    if (unreadable) sessionsUnreadable++;
    let awaiting = [];
    for (const event of events) {
      if (event.type === FIRING_EVENT && event.gateId === id && event.gateSha256 === sha256) {
        firings++;
        sessions.add(sessionId);
        if (isString(event.tool_use_id)) awaiting.push({ tool: event.tool, toolUseId: event.tool_use_id });
      } else if (event.type === SUCCESS_EVENT || event.type === FAILURE_EVENT) {
        const isNext = f => f.tool === event[TOOL_FIELD] && f.toolUseId !== event.tool_use_id;
        if (event.type === SUCCESS_EVENT) rerouted += awaiting.filter(isNext).length;
        awaiting = awaiting.filter(f => !isNext(f));
      }
    }
  }
  let ledger;
  try {
    ledger = readLedger(root);
  } catch {
    return { error: 'the ledger cannot be read, so the wrong marks cannot be counted' };
  }
  const wrong = ledger.filter(e => e?.kind === 'wrong' && e.learningId === id).length;
  return { firings, sessions: sessions.size, rerouted, wrong, sessionsUnreadable };
}
