// scripts/lib/learn-promote.mjs
//
// A learning's life past its silent trial. Only a person at an interactive
// terminal, or a promotion policy that person set at a terminal, moves a
// learning's gate on to `warn` or `block` on this machine; wrong marks, a
// demotion or a retirement take it back. `tick` runs the rules unattended.
//
// The policy file, like every file in the data directory, can be written by
// anything running as this user, so a policy promotes only while its hash is
// the one the ledger recorded when the owner set it.
//
// Every step goes through `learn-lib.mjs`: the ledger is the authority for
// what a learning's gate may do, each step first repairs the local gate set
// to what the ledger grants, and each transition is written ledger first.
// Everything this module writes goes to the repository's per-machine data
// directory; it reads the repository and never writes inside it. No
// exported function throws.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { harnessIdentity, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { safeSessionId } from '../../assets/scripts/harness-redact.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { FIRING_EVENT, gateStats, wrongSinceGrant } from './gate-stats.mjs';
import {
  citationsGone, citesGone, committedGates, gateActionsFor, ID_ERROR, isId, learningIn, ledgerEntry,
  readFailure, readState, recordedIn, refuse, repairedStep, repairLocalGates, rewriteLocalGates, SETTLED, unapprovedGateIds,
  unrecordedReason, withLearningsLock, writeTransition,
} from './learn-lib.mjs';
import { appendLedger } from './ledger.mjs';
import { checkedPolicy, policyAllows, readPolicy, removePolicy, writePolicy } from './policy.mjs';

// The actions a promotion may grant: those a learning promoted on this
// machine may carry.
const PROMOTED_ACTIONS = gateActionsFor('active-local');

// A promoted or landed learning marked wrong this many times since its last
// promotion or landing goes back to `observe` on this machine.
const WRONG_MARKS_TO_DEMOTE = 2;

// The statuses whose gate warns or blocks, and so may be demoted.
const DEMOTABLE = new Set(['active-local', 'landed']);

const LAST_TICK_FILE = 'last-tick.json';

const SHA256 = /^[0-9a-f]{64}$/;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = v => typeof v === 'string';
const optionsOf = value => (isPlainObject(value) ? value : {});
const codeOf = error => (isString(error?.code) ? error.code : 'unknown');

/** True only for what `requireInteractive` returns for a person at an
 * interactive terminal; anything else, a missing value among them, is a
 * refusal. */
export const isInteractive = value => isPlainObject(value) && value.ok === true;
export const needsTerminal = what => `${what} needs a person at an interactive terminal outside Claude Code; nothing was written`;

/**
 * Promotes a learning on trial to `warn` or `block` on this machine, as the
 * person at the terminal approved: `options` is `{ sha256, action,
 * interactive }`, where `interactive` is what `requireInteractive` returned
 * and `sha256` the content hash the person was shown, which must still be
 * the learning's. The ledger gets `promoted` with `approvedBy: 'owner'` and
 * the action, and the local gate takes that action. Returns `{ ok: true,
 * id, action, repairedGates }`, or `{ error }`.
 */
export function approveLearning(root, id, options) {
  try {
    return approveUnguarded(root, id, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function approveUnguarded(root, id, { sha256, action, interactive }) {
  if (!isInteractive(interactive)) return refuse(root, needsTerminal('approval'));
  if (!isId(id)) return refuse(root, ID_ERROR);
  if (!PROMOTED_ACTIONS.includes(action)) return refuse(root, 'action: must be warn or block');
  if (!isString(sha256) || !SHA256.test(sha256)) return refuse(root, 'sha256: must be 64 lowercase hex characters');
  return repairedStep(root, write => {
    const state = readState(root);
    const found = learningIn(state, id);
    if (found.error) return found;
    const { learning } = found;
    if (learning.sha256 !== sha256) return { error: `${id}: the hash approved is not the learning's content; show it again and approve the hash it shows` };
    const unrecorded = unrecordedReason(learning, state.view);
    if (unrecorded !== null) return { error: unrecorded };
    if (learning.status !== 'trial') return { error: `${id} is ${learning.status}; only a learning on trial is approved` };
    const written = promote(root, write, state, learning, { action, approvedBy: 'owner' });
    return written.error === undefined ? { ok: true, id, action } : written;
  });
}

/** Records `promoted` for a learning on trial and gives its local gate
 * `action`. */
function promote(root, write, state, learning, { action, approvedBy, detail }) {
  const updated = { ...learning, status: 'active-local', gate: { ...learning.gate, action } };
  return writeTransition(root, write, state, { updated, entries: [{ kind: 'promoted', approvedBy, action, detail }] });
}

/** Whether the gate the hook loads from the committed file under this
 * learning's id, as `committedGates` reads it, is this learning's gate, its
 * content hash the learning's. A local entry weaker than a committed gate
 * does not replace it, so only a suspension takes a committed gate out of
 * force on this machine; an entry that merely reuses the id, or a rejected
 * duplicate of it, is not one the hook applies as this learning's gate. */
const isCommitted = (root, learning) => committedGates(root).some(g => g.id === learning.id && gateSha256(g) === learning.sha256);

/**
 * Takes a promoted or landed learning's gate back to `observe` on this
 * machine. A gate only this machine holds is rewritten at `observe` and the
 * learning returns to `trial`, recorded as `demoted`; a committed gate is
 * suspended here, its local suspension written with the `suspended` entry
 * that accounts for it, and the learning is `suspended`: nothing in this
 * module lifts a suspension, and nothing here changes the repository; only a
 * revert (`learn-land.mjs`) ends it, taking the gate out of the repository
 * and retiring the learning. A landed learning is always suspended, even on a checkout
 * that lacks its committed gate, since the repository still holds that
 * gate. `approvedBy` names the person who asked, null when the demotion rule
 * decided. Returns `{ status }`, or `{ error }`.
 */
function demote(root, write, state, learning, approvedBy) {
  const committed = learning.status === 'landed' || isCommitted(root, learning);
  const status = committed ? 'suspended' : 'trial';
  const updated = { ...learning, status, gate: { ...learning.gate, action: 'observe' } };
  const written = writeTransition(root, write, state, { updated, entries: [{ kind: committed ? 'suspended' : 'demoted', approvedBy }] });
  return written.error === undefined ? { status } : written;
}

/** Retires a learning: its local gate goes and the ledger gets `retired`.
 * A local suspension stands only for a `suspended` learning, so a committed
 * gate of a retired one is in force here again: retiring never touches the
 * repository, and only reverting the learning while it is landed or
 * suspended (`learn-land.mjs`) takes its gate out. Retirement is terminal:
 * nothing revives a retired learning. */
function retire(root, write, state, learning, { approvedBy, detail }) {
  const updated = { ...learning, status: 'retired', gate: { ...learning.gate, action: 'observe' } };
  return writeTransition(root, write, state, { updated, entries: [{ kind: 'retired', approvedBy, detail }] });
}

const isFiringRef = ref => isPlainObject(ref) && safeSessionId(ref.sessionId) === ref.sessionId && Number.isSafeInteger(ref.line) && ref.line >= 1;

/**
 * Marks one gate firing wrong, as the person at the terminal judged it:
 * `firingRef` is `{ sessionId, line }`, `line` the 1-based index into the
 * events `readEvents(root, sessionId)` returns, which must be a
 * `gate_firing` of a learning's gate as the ledger records it; `options` is
 * `{ interactive }`, what `requireInteractive` returned. The ledger gets a
 * `wrong` entry carrying the reference, and a firing is marked once. The
 * mark that brings a promoted or landed learning to two since its last
 * promotion or landing demotes it, as `demoteLearning` does but by the
 * rule. Returns `{ ok: true, id, wrong, status, repairedGates }`, `wrong`
 * the marks since then and `status` the learning's after the mark, or
 * `{ error }`.
 */
export function markWrong(root, firingRef, options) {
  try {
    return markWrongUnguarded(root, firingRef, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function markWrongUnguarded(root, ref, { interactive }) {
  if (!isInteractive(interactive)) return refuse(root, needsTerminal('a wrong mark'));
  if (!isFiringRef(ref)) return refuse(root, 'firing: must be { sessionId, line } with a session id and a line number of at least 1');
  const { sessionId, line } = ref;
  const event = readEvents(root, sessionId).events[line - 1];
  if (!isPlainObject(event) || event.type !== FIRING_EVENT || !isId(event.gateId)) return refuse(root, 'firing: no gate firing is recorded at that line of that session');
  return repairedStep(root, write => {
    const state = readState(root);
    const found = learningIn(state, event.gateId);
    if (found.error) return found;
    const { learning } = found;
    if (event.gateSha256 !== learning.sha256) return { error: `firing: it is of other content than learning ${learning.id}'s gate` };
    const unrecorded = unrecordedReason(learning, state.view);
    if (unrecorded !== null) return { error: unrecorded };
    if (state.view.entries.some(e => e?.kind === 'wrong' && e.firing?.sessionId === sessionId && e.firing?.line === line)) {
      return { error: 'firing: it is already marked wrong' };
    }
    write(() => appendLedger(root, ledgerEntry(learning, harnessIdentity(root), { kind: 'wrong', approvedBy: 'owner', firing: { sessionId, line } })));
    const marked = readState(root);
    const wrong = wrongSinceGrant(marked.view.entries, learning.id);
    if (wrong < WRONG_MARKS_TO_DEMOTE || !DEMOTABLE.has(learning.status)) return { ok: true, id: learning.id, wrong, status: learning.status };
    const demoted = demote(root, write, marked, learning, null);
    if (demoted.error) return { error: `${learning.id}: the mark was recorded, and the demotion it calls for was not; tick retries it (${demoted.error})` };
    return { ok: true, id: learning.id, wrong, status: demoted.status };
  });
}

/**
 * Demotes a learning promoted on this machine or landed, as the person at
 * the terminal asked: its gate goes back to `observe` and it returns to
 * `trial`, or, when its gate is committed, that gate is suspended on this
 * machine and it is `suspended` until a revert takes the gate out of the
 * repository and retires it. Demotion weakens a
 * gate, so it takes a person at a terminal, like approval: `options` is
 * `{ interactive }`. Returns `{ ok: true, id, status, repairedGates }`, or
 * `{ error }`.
 */
export function demoteLearning(root, id, options) {
  try {
    return byHand(root, id, optionsOf(options), 'a demotion', (write, state, learning) => {
      if (!DEMOTABLE.has(learning.status)) return { error: `${id} is ${learning.status}; only a learning promoted on this machine or landed is demoted` };
      return demote(root, write, state, learning, 'owner');
    });
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * Retires a learning that is neither rejected nor retired, as the person at
 * the terminal asked: its local gate goes, as `retire` says, and it no
 * longer stands for its signature. Retirement is terminal, and it takes a
 * gate out of force, so it takes a person at a terminal: `options` is
 * `{ interactive }`. Returns `{ ok: true, id, status, repairedGates }`, or
 * `{ error }`.
 */
export function retireLearning(root, id, options) {
  try {
    return byHand(root, id, optionsOf(options), 'a retirement', (write, state, learning) => {
      if (SETTLED.has(learning.status)) return { error: `${id} is ${learning.status}; a rejected or retired learning is not retired again` };
      const written = retire(root, write, state, learning, { approvedBy: 'owner' });
      return written.error === undefined ? { status: 'retired' } : written;
    });
  } catch (error) {
    return readFailure(error);
  }
}

/** `{ learning }` for the learning `id` the ledger vouches for in `state`,
 * or `{ error }` saying why there is none. */
function vouchedLearning(state, id) {
  const found = learningIn(state, id);
  if (found.error) return found;
  const unrecorded = unrecordedReason(found.learning, state.view);
  return unrecorded === null ? found : { error: unrecorded };
}

/** A step a person asked for at the terminal on the learning `id`, which
 * the ledger must vouch for; `change` returns `{ status }` or `{ error }`. */
function byHand(root, id, { interactive }, what, change) {
  if (!isInteractive(interactive)) return refuse(root, needsTerminal(what));
  if (!isId(id)) return refuse(root, ID_ERROR);
  return repairedStep(root, write => {
    const state = readState(root);
    const found = vouchedLearning(state, id);
    if (found.error) return found;
    const changed = change(write, state, found.learning);
    return changed.error === undefined ? { ok: true, id, status: changed.status } : changed;
  });
}

/**
 * Sets the repository's promotion policy on this machine, as the person at
 * the terminal asked: `policy` is `{ minTrialFirings, minTrialSessions,
 * maxAction }` and `options` is `{ interactive }`, what
 * `requireInteractive` returned. The ledger gets a `policy` entry carrying
 * the policy's hash with `approvedBy: 'owner'`, then the policy file is
 * written; `tick` promotes under a policy only while the file's hash is the
 * last one recorded. Returns `{ ok: true, sha256, repairedGates }`, or
 * `{ error }`.
 */
export function setPolicy(root, policy, options) {
  try {
    return setPolicyUnguarded(root, policy, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function setPolicyUnguarded(root, raw, { interactive }) {
  if (!isInteractive(interactive)) return refuse(root, needsTerminal('setting a policy'));
  const checked = checkedPolicy(raw);
  if (checked.reason !== undefined) return refuse(root, `policy: ${checked.reason}`);
  return repairedStep(root, write => {
    if (!readState(root).view.intact) return { error: 'the ledger cannot be read or its chain is broken, so the policy cannot be recorded; nothing was written' };
    const { base, learned } = harnessIdentity(root);
    write(() => appendLedger(root, { kind: 'policy', policySha256: checked.sha256, base, learned, approvedBy: 'owner' }));
    write(() => writePolicy(root, checked.policy));
    return { ok: true, sha256: checked.sha256 };
  });
}

/**
 * Withdraws the repository's promotion policy on this machine, as the
 * person at the terminal asked: `options` is `{ interactive }`. The ledger
 * gets a `policy` entry with `policySha256: null` and `approvedBy:
 * 'owner'`, then the policy file is removed if there is one. From then on
 * no policy is in force, whatever file appears, until one is set again; a
 * withdrawal is recorded even when no policy was ever set. Returns `{ ok:
 * true, policyFileRemoved, repairedGates }`, or `{ error }`. A file that
 * cannot be removed once the withdrawal is recorded does not undo it:
 * `policyFileRemoved` is then false and `note` says the withdrawal is in
 * force and the file promotes nothing.
 */
export function clearPolicy(root, options) {
  try {
    return clearPolicyUnguarded(root, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function clearPolicyUnguarded(root, { interactive }) {
  if (!isInteractive(interactive)) return refuse(root, needsTerminal('withdrawing a policy'));
  return repairedStep(root, write => {
    if (!readState(root).view.intact) return { error: 'the ledger cannot be read or its chain is broken, so the withdrawal cannot be recorded; nothing was written' };
    const { base, learned } = harnessIdentity(root);
    write(() => appendLedger(root, { kind: 'policy', policySha256: null, base, learned, approvedBy: 'owner' }));
    try {
      write(() => removePolicy(root));
    } catch (error) {
      const note = `the withdrawal is recorded and in force, so the policy file promotes nothing, but it could not be removed (${codeOf(error)})`;
      return { ok: true, policyFileRemoved: false, note };
    }
    return { ok: true, policyFileRemoved: true };
  });
}

/** The hash of the policy in force, from the ledger's last `policy` entry:
 * null when none was ever set or the last was withdrawn. */
export function recordedPolicySha256(entries) {
  let sha256 = null;
  for (const entry of entries) if (entry?.kind === 'policy') sha256 = entry.policySha256;
  return sha256;
}

/**
 * The deterministic part of the loop, run unattended. In order: the gate
 * repair, which removes every local gate the ledger does not grant, the
 * ones nobody approved among them (`unapprovedRemoved`); retirement of each
 * learning on trial every path of whose `cites` is gone (one citing nothing
 * is never retired this way); demotion of each promoted or landed learning
 * marked wrong twice since its last promotion or landing, suspending a
 * committed gate on this machine (`suspended`) and otherwise returning it to
 * `trial` (`demoted`); and,
 * under a readable policy the owner set, promotion as
 * `promoteUnderPolicy` decides; a policy file whose hash the ledger did not
 * record as the one in force promotes nothing, and `policyUnrecorded` and a
 * line in `errors` say so. A
 * learning whose gate warns or blocks is never retired here, since deleting
 * a file must not switch off an enforcing gate: when its cited paths are all
 * gone it is reported in `citationsGone` and stays in force until the owner
 * retires it at a terminal. A local gate file that is not a gate file is
 * rewritten as the gates the ledger grants (`gateFileRewritten`) while the
 * ledger is intact, and left as it is otherwise; a rewrite that fails is
 * reported in `errors` and the rest of the run goes on. Writes
 * `last-tick.json` as `{ ts }` from `now` at the end.
 *
 * Changes only learnings the ledger vouches for, and only in the data
 * directory; never a rule in `docs/harness/RULES.md` or any file in the
 * repository. With the ledger broken it does the removals and nothing else.
 * Returns `{ promoted, demoted, retired, suspended, citationsGone,
 * unapprovedRemoved, repairedGates, gateFileRewritten, ledgerIntact, policy,
 * policyUnrecorded, errors }`, `policy` the policy file's state and
 * `errors` what could not be done, or `{ error }`.
 */
export function tick(root, options) {
  try {
    return tickUnguarded(root, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function tickUnguarded(root, { now = Date.now }) {
  return withLearningsLock(root, write => {
    const before = readState(root);
    const intact = before.view.intact;
    const policy = readPolicy(root);
    const result = {
      promoted: [], demoted: [], retired: [], suspended: [], citationsGone: [],
      unapprovedRemoved: before.local.file ? unapprovedGateIds(before.local.file.gates, before.view.entries) : [],
      repairedGates: [], gateFileRewritten: false,
      ledgerIntact: intact, policy: policy.state, policyUnrecorded: false, errors: [],
    };
    if (!before.local.unreadable) {
      result.repairedGates = repairLocalGates(root, write);
    } else if (!intact) {
      result.errors.push('the local gate file is not a gate file, and with the ledger broken it cannot be rebuilt; it was left as it is');
    } else {
      try {
        result.repairedGates = rewriteLocalGates(root, write, before);
        result.gateFileRewritten = true;
      } catch (error) {
        result.errors.push(`the local gate file is not a gate file and could not be rewritten (${codeOf(error)}); it was left as it is`);
      }
    }
    if (intact) applyRules(root, write, policy, result);
    else result.errors.push('the ledger cannot be read or its chain is broken, so nothing was retired, demoted or promoted');
    result.citationsGone = citationsGone(root, readState(root));
    const dir = repoDataDir(root);
    write(() => {
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(join(dir, LAST_TICK_FILE), JSON.stringify({ ts: new Date(now()).toISOString() }, null, 2) + '\n');
    });
    return result;
  });
}

/** Retirement, demotion and promotion under `policy`, in that order, each
 * over the learnings the ledger vouches for once the one before is done;
 * what each did, or could not do, goes into `result`. */
function applyRules(root, write, policy, result) {
  const apply = (learning, change, onDone) => {
    const done = change(readState(root), learning);
    if (done.error) result.errors.push(`${learning.id}: ${done.error}`);
    else onDone(done);
  };

  for (const learning of recordedIn(readState(root))) {
    if (learning.status !== 'trial' || !citesGone(root, learning)) continue;
    apply(learning, (state, l) => retire(root, write, state, l, { detail: 'every path it cites is gone' }), () => result.retired.push(learning.id));
  }

  const marked = readState(root);
  for (const learning of recordedIn(marked)) {
    if (!DEMOTABLE.has(learning.status) || wrongSinceGrant(marked.view.entries, learning.id) < WRONG_MARKS_TO_DEMOTE) continue;
    apply(learning, (state, l) => demote(root, write, state, l, null), done => (done.status === 'suspended' ? result.suspended : result.demoted).push(learning.id));
  }

  if (policy.state === 'unreadable') result.errors.push(`the policy cannot be used (${policy.reason}), so nothing was promoted`);
  if (policy.state !== 'ok') return;
  if (policy.sha256 !== recordedPolicySha256(readState(root).view.entries)) {
    result.policyUnrecorded = true;
    result.errors.push('the policy file is not the policy in force, which only setting it at a terminal records, so nothing was promoted');
    return;
  }
  promoteUnderPolicy(root, write, policy, result, apply);
}

/**
 * Promotes, to the policy's `maxAction` and recorded with `approvedBy:
 * 'policy:<sha256>'`, each learning on trial that `policyAllows` given its
 * firings, sessions, wrong marks and whether its evidence holds outside
 * content. A learning is external when its file says so or any ledger entry
 * for it does: the file is covered by no hash, and the draft's `proposed`
 * entry already carries the flag. Only a learning fresh from replay
 * qualifies, one whose last
 * status entry is `trial`: a learning demoted back to trial is promoted
 * again only by the owner, so a demotion the owner asked for is not undone
 * by the next tick.
 */
function promoteUnderPolicy(root, write, policy, result, apply) {
  const state = readState(root);
  const trials = recordedIn(state).filter(l => l.status === 'trial' && state.recorded.get(l.id).kind === 'trial');
  const { gates } = gateStats(root, state.view.entries, new Map(trials.map(l => [l.id, l.sha256])));
  for (const learning of trials) {
    const { firings, sessions, wrong } = gates.get(learning.id);
    const external = learning.external || learning.evidence.external
      || state.view.entries.some(e => e?.learningId === learning.id && e.evidence?.external === true);
    const evidence = { firings, sessions, wrong: wrong.sinceGrant, external };
    if (!policyAllows(policy.policy, evidence)) continue;
    const promotion = { action: policy.policy.maxAction, approvedBy: `policy:${policy.sha256}`, detail: `${firings} firings in ${sessions} sessions` };
    apply(learning, (s, l) => promote(root, write, s, l, promotion), () => result.promoted.push(learning.id));
  }
}
