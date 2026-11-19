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
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { GATE_LIMITS, gateSha256, validateGate } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, harnessIdentity, LOCAL_GATES_FILE, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { maskText, stripUnsafe } from '../../assets/scripts/harness-redact.mjs';
import { FAILURES_PATH, parseFailures } from './failures-evidence.mjs';
import { withFileLock } from './file-lock.mjs';
import { appendLedger, readLedger } from './ledger.mjs';
import { FAILURE_EVENT, findRecurrences, sessionIds, SUCCESS_EVENT, TOOL_FIELD } from './recurrence.mjs';
import { replayGate } from './replay.mjs';
import { readIfPresent } from './scan.mjs';

const STATUSES = new Set(['candidate', 'rejected', 'trial', 'active-local', 'landed', 'suspended', 'retired']);

// A learning in one of these no longer stands for its signature, so a new
// draft for the signature may be made.
const SETTLED = new Set(['rejected', 'retired']);

// The statuses whose gate lives in the local gate set; a local gate whose
// learning is in none of them is left over from an interrupted step.
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
const idNumber = id => Number(ID.exec(id)[1]);
const byIdNumber = (a, b) => idNumber(a) - idNumber(b);

const learningsDir = root => join(repoDataDir(root), LEARNINGS_DIR);
const learningPath = (root, id) => join(learningsDir(root), `${id}.json`);
const localGatesPath = root => join(repoDataDir(root), LOCAL_GATES_FILE);

/** Writes `value` as JSON beside `path` and renames it over `path`, so a
 * reader finds the old file or the new one, never a partial one. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Runs `fn` holding the lock every update to a learning, the id counter
 * and the local gate set is made under. */
function withLearningsLock(root, fn) {
  const dir = repoDataDir(root);
  mkdirSync(dir, { recursive: true });
  return withFileLock(join(dir, LOCK_FILE), { name: 'learnings' }, fn);
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
  return valid.ok ? { gate } : { error: `gate: ${valid.reason}` };
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
  return validateGate(value.gate).ok && value.gate.id === id && value.sha256 === gateSha256(value.gate);
}

/** `{ learning }`, `{ missing: true }` or `{ unreadable: true }`. */
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
 * second the ids whose file does not read back as a learning. */
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

/** `{ file }`, an empty gate file when there is none, or `{ unreadable:
 * true }` when the file is not `{ schema: 1, gates: [...] }`. Entries are
 * kept as written, whatever `parseGates` would make of them. */
function readGateFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
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

const gateFileIds = file => file.gates.filter(e => isPlainObject(e) && isString(e.id) && ID.test(e.id)).map(e => e.id);

/** The ids of the gates in `file` whose learning is missing or not in a
 * status that keeps a local gate. A gate whose learning file cannot be read
 * is not judged. */
function orphanGateIds(file, learnings, unreadable) {
  const status = new Map(learnings.map(l => [l.id, l.status]));
  const unknown = new Set(unreadable);
  const ids = file.gates.filter(isGateEntry).map(e => e.id).filter(id => !unknown.has(id) && !LOCAL_GATE_STATUSES.has(status.get(id)));
  return [...new Set(ids)];
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

/** `{ id }`, one more than the highest number this machine ever assigned for
 * the repository, held by a learning file, or used in the committed or the
 * local gate file; or `{ error }`. Called under the lock, before the counter
 * is advanced. */
function nextId(root, ids) {
  const counter = readCounter(root);
  if (counter === null) return { error: 'the learning id counter cannot be read, so no id that was never used can be assigned' };
  const committedText = readIfPresent(root, GATES_PATH);
  let committed = [];
  if (committedText !== null) {
    let file;
    try {
      file = JSON.parse(committedText);
    } catch {
      file = null;
    }
    if (!isPlainObject(file) || !Array.isArray(file.gates)) return { error: 'the committed gate file cannot be read, so no id that avoids its ids can be assigned' };
    committed = gateFileIds(file);
  }
  const local = readGateFile(localGatesPath(root));
  const used = [...ids, ...committed, ...(local.file ? gateFileIds(local.file) : [])].map(idNumber);
  const highest = Math.max(counter, ...used);
  if (highest >= ID_NUMBER_MAX) return { error: 'no learning id is left to assign' };
  return { id: `L${highest + 1}`, number: highest + 1 };
}

/** Appends `kind` for `learning` to the ledger under `identity`, the
 * harness the event happened under. */
function record(root, learning, kind, identity, detail) {
  const { base, learned } = identity;
  appendLedger(root, { kind, learningId: learning.id, contentSha256: learning.sha256, evidence: learning.evidence, base, learned, approvedBy: null, detail });
}

/**
 * Validates a model-written draft, `{ signature, title, why, gate }` with
 * the gate lacking `id` and `action`, and stores it as a candidate under
 * the next id, recording `proposed` in the ledger. `signature` must be a
 * current recurrence's, and the gate's tool that recurrence's tool; `title`
 * and `why` are stored stripped of what cannot be seen and masked. At most
 * one learning that is neither rejected nor retired stands for a signature.
 * Returns `{ learning }`, or `{ error }` with nothing stored.
 */
export function draftLearning(root, draft) {
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

  return withLearningsLock(root, assertHeld => {
    const { learnings, unreadable } = readLearnings(root);
    const standing = learnings.find(l => l.signature === signature && !SETTLED.has(l.status));
    if (standing !== undefined) return { error: `signature: learning ${standing.id} already covers this signature` };
    const next = nextId(root, [...learnings.map(l => l.id), ...unreadable]);
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
    assertHeld();
    writeJsonAtomic(join(repoDataDir(root), ID_COUNTER_FILE), { highest: next.number });
    assertHeld();
    writeJsonAtomic(learningPath(root, learning.id), learning);
    record(root, learning, 'proposed', harnessIdentity(root));
    return { learning };
  });
}

/**
 * Replays a candidate's gate against its recurrence as it now stands, and
 * acts on the verdict. `pass`: the gate goes into the local gate set with
 * action `observe` and the learning to `trial`; the ledger gets `replayed`
 * then `trial`. `fail`: the learning is `rejected`; `replayed` then
 * `rejected`. `not-checkable`: it stays a candidate, to be replayed again
 * once more history exists; `replayed` alone. The latest replay, evidence
 * and failure kind are stored on the learning either way, and `replayed`
 * carries the verdict and reason in its detail. A learning once marked
 * external stays so.
 *
 * First, under the same lock, every gate in the local set whose learning is
 * missing or not in a status that keeps a local gate is removed; their ids
 * are `repairedGates`. A local gate file that is not a gate file is left
 * as it is, which refuses a pass and skips the repair otherwise. Returns
 * `{ replay, status, repairedGates }`, or `{ error }` with nothing written.
 */
export function runTrial(root, id) {
  if (!isString(id) || !ID.test(id)) return { error: ID_ERROR };
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

  return withLearningsLock(root, assertHeld => {
    const current = readLearning(root, id).learning;
    if (current?.status !== 'candidate' || current.sha256 !== learning.sha256) return { error: `${id} changed while it was replayed; nothing was written` };
    const local = readGateFile(localGatesPath(root));
    if (local.unreadable && status === 'trial') return { error: 'the local gate file is not a gate file; nothing was written' };
    // The replay ran under the learned set as it was before this gate joined it.
    const replayedUnder = harnessIdentity(root);
    let repairedGates = [];
    if (local.file) {
      const { learnings, unreadable } = readLearnings(root);
      repairedGates = orphanGateIds(local.file, learnings, unreadable).sort(byIdNumber);
      const repaired = new Set(repairedGates);
      const gates = local.file.gates.filter(e => !(isGateEntry(e) && repaired.has(e.id)));
      if (status === 'trial') {
        if (gates.filter(isGateEntry).length >= GATE_LIMITS.gatesMax) return { error: `the local gate set already holds ${GATE_LIMITS.gatesMax} gates; nothing was written` };
        gates.push(current.gate);
      }
      if (repairedGates.length > 0 || status === 'trial') {
        assertHeld();
        writeJsonAtomic(localGatesPath(root), { ...local.file, gates });
      }
    }
    const updated = {
      ...current,
      failureId,
      status,
      external: current.external || recurrence.external,
      evidence: evidenceOf(recurrence),
      replay,
    };
    assertHeld();
    writeJsonAtomic(learningPath(root, id), updated);
    record(root, updated, 'replayed', replayedUnder, `${replay.verdict}: ${replay.reason}`);
    if (status !== 'candidate') record(root, updated, status, harnessIdentity(root));
    return { replay, status, repairedGates };
  });
}

/**
 * Every learning on this machine for the repository, in id order:
 * `{ learnings, orphanGates, unreadable }`. `orphanGates` are the ids of the
 * gates in the local set whose learning is missing or not in a status that
 * keeps a local gate, which the next `runTrial` removes, or null when the
 * local gate file cannot be read; `unreadable` the ids whose learning file
 * does not read back as a learning.
 */
export function listLearnings(root) {
  const { learnings, unreadable } = readLearnings(root);
  const local = readGateFile(localGatesPath(root));
  const orphanGates = local.file ? orphanGateIds(local.file, learnings, unreadable).sort(byIdNumber) : null;
  return { learnings, orphanGates, unreadable };
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
 * Returns `{ error }` for an id that names no learning.
 */
export function learningStats(root, id) {
  if (!isString(id) || !ID.test(id)) return { error: ID_ERROR };
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
  const wrong = readLedger(root).filter(e => e.kind === 'wrong' && e.learningId === id).length;
  return { firings, sessions: sessions.size, rerouted, wrong, sessionsUnreadable };
}
