// scripts/lib/learn-promote.mjs
//
// A learning's life past its silent trial. Only a step taken from an
// interactive terminal outside Claude Code, which is how the owner's own
// terminal looks to the check in `tty.mjs`, or a promotion policy set from
// one, moves a learning's gate on to `warn` or `block` on this machine;
// wrong marks, a demotion or a retirement take it back. `tick` runs the
// rules unattended.
//
// The policy file, like every file in the data directory, can be written by
// anything running as this user, so a policy promotes only while its hash is
// the one the ledger recorded when the owner set it.
//
// Every step goes through `learn-lib.mjs`: the ledger is the authority for
// what a learning's gate may do, each step first rolls lagging learning
// files forward and repairs the local gate set to what the ledger grants,
// and each transition is written ledger first. Everything this module
// writes goes to the repository's per-machine data directory; it reads the
// repository and never writes inside it. No exported function throws, and
// every error carries its exit code, as `learn-lib.mjs` assigns them.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH, harnessIdentity, LAST_TICK_FILE, readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { safeSessionId } from '../../assets/scripts/harness-redact.mjs';
import { indexLineCount } from '../../assets/scripts/harness-seal.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { FAILURES_PATH, failuresNotRead, readFailures } from './failures-evidence.mjs';
import { FIRING_EVENT, gateStats, wrongSinceGrant } from './gate-stats.mjs';
import {
  citationsGone, citesGone, codeOf, failed, fileless, FILELESS_KEPT, gateActionsFor, ID_ERROR, idCollisions, isId, isPlainObject, learningIn,
  ledgerEntry, proseUnrecorded, readFailure, readState, recordedIn, recordedState, refuse, refused, repairedStep, repairLocalGates,
  retiredWhenFileless, rewriteLocalGates, rollLearningsForward, SETTLED, unapprovedGateIds, unrecordedReason, withLearningsLock, writeTransition, wrongMarkedFor,
} from './learn-lib.mjs';
import { appendLedger, isSha256 } from './ledger.mjs';
import { checkedPolicy, policyAllows, readPolicy, removePolicy, writePolicy } from './policy.mjs';
import { EXTERNAL_EVENT, findRecurrences } from './recurrence.mjs';
import { TERMINAL_CHECK } from './tty.mjs';

// The actions a promotion may grant: those a learning promoted on this
// machine may carry.
const PROMOTED_ACTIONS = gateActionsFor('active-local');

// A promoted or landed learning marked wrong this many times since its last
// promotion or landing goes back to `observe` on this machine.
const WRONG_MARKS_TO_DEMOTE = 2;

// The statuses whose gate warns or blocks, and so may be demoted.
const DEMOTABLE = new Set(['active-local', 'landed']);

// The statuses of a learning whose gate the repository may still hold.
const COMMITTED_STATUSES = new Set(['landed', 'suspended']);

// The event a session carries once a tool call in it read outside content,
// as the logging hook writes it.

const optionsOf = value => (isPlainObject(value) ? value : {});

/** True only for what `requireInteractive` returns when its check passes;
 * anything else, a missing value among them, is a refusal. */
export const isInteractive = value => isPlainObject(value) && value.ok === true;

/** The refusal of a step that was not run from where the terminal check
 * passes. */
export const needsTerminal = what => refused(`${what} runs only from ${TERMINAL_CHECK}; nothing was written`);

/**
 * Promotes a learning on trial to `warn` or `block` on this machine, as the
 * owner approved it at a terminal: `options` is `{ sha256, action,
 * interactive }`, where `interactive` is what `requireInteractive` returned
 * and `sha256` the content hash the owner was shown, which must still be
 * the learning's. The ledger gets `promoted` with `approvedBy: 'owner'` and
 * the action, and the local gate takes that action. The command prints the
 * learning before it calls this, so the entry also records the hash of its
 * title, why and evidence where no earlier entry did. Returns `{ ok: true,
 * id, action, repairedGates }`, or `{ error, exitCode }`.
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
  if (!isId(id)) return refuse(root, failed(ID_ERROR));
  if (!PROMOTED_ACTIONS.includes(action)) return refuse(root, failed('action: must be warn or block'));
  if (!isSha256(sha256)) return refuse(root, failed('sha256: must be 64 lowercase hex characters'));
  return repairedStep(root, write => {
    const state = readState(root);
    const found = learningIn(state, id);
    if (found.error) return found;
    const { learning } = found;
    if (learning.sha256 !== sha256) return refused(`${id}: the hash approved is not the learning's content; show it again and approve the hash it shows`);
    const unrecorded = unrecordedReason(learning, state.view);
    if (unrecorded !== null) return refused(unrecorded);
    if (learning.status !== 'trial') return refused(`${id} is ${learning.status}; only a learning on trial is approved`);
    const written = promote(root, write, state, learning, { action, approvedBy: 'owner', bindsProse: true });
    return written.error === undefined ? { ok: true, id, action } : written;
  });
}

/** Records `promoted` for a learning on trial and gives its local gate
 * `action`. */
function promote(root, write, state, learning, { action, approvedBy, detail, bindsProse }) {
  const updated = { ...learning, status: 'active-local', gate: { ...learning.gate, action } };
  return writeTransition(root, write, state, { updated, entries: [{ kind: 'promoted', approvedBy, action, detail, bindsProse }] });
}

/** Whether the gate the hook loads from the committed file under this
 * learning's id, as `state` read it, is this learning's gate, its content
 * hash the learning's. A local entry weaker than a committed gate does not
 * replace it, so only a suspension takes a committed gate out of force on
 * this machine; an entry that merely reuses the id, or a rejected duplicate
 * of it, is not one the hook applies as this learning's gate. */
const isCommitted = (state, learning) => state.committed.some(g => g.id === learning.id && gateSha256(g) === learning.sha256);

/**
 * Takes a promoted or landed learning's gate back to `observe` on this
 * machine. A gate only this machine holds is rewritten at `observe` and the
 * learning returns to `trial`, recorded as `demoted`; a committed gate is
 * suspended here, its local suspension written with the `suspended` entry
 * that accounts for it, and the learning is `suspended`: nothing in this
 * module lifts a suspension, and nothing here changes the repository; only a
 * revert (`learn-land.mjs`) ends it, taking the gate out of the repository
 * and retiring the learning. A landed learning is always suspended, even on
 * a checkout that lacks its committed gate, since the repository still
 * holds that gate. `approvedBy` names the owner who asked, null when the
 * demotion rule decided. Returns `{ status }`, or `{ error, exitCode }`.
 */
function demote(root, write, state, learning, approvedBy) {
  const committed = learning.status === 'landed' || isCommitted(state, learning);
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
 * Marks one gate firing wrong, as the owner judged it at a terminal:
 * `firingRef` is `{ sessionId, line }`, `line` the 1-based index into the
 * events `readEvents(root, sessionId)` returns, which must be a
 * `gate_firing` of a learning's gate as the ledger records it; `options` is
 * `{ interactive }`, what `requireInteractive` returned. The ledger gets a
 * `wrong` entry carrying the reference, and a firing is marked once. The
 * mark that brings a promoted or landed learning to two since its last
 * promotion or landing demotes it, as `demoteLearning` does but by the
 * rule. Returns `{ ok: true, id, wrong, status, repairedGates }`, `wrong`
 * the marks since then and `status` the learning's after the mark, or
 * `{ error, exitCode }`.
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
  if (!isFiringRef(ref)) return refuse(root, failed('firing: must be { sessionId, line } with a session id and a line number of at least 1'));
  const { sessionId, line } = ref;
  const event = readEvents(root, sessionId).events[line - 1];
  if (!isPlainObject(event) || event.type !== FIRING_EVENT || !isId(event.gateId)) {
    return refuse(root, failed('firing: no gate firing is recorded at that line of that session'));
  }
  return repairedStep(root, write => {
    const state = readState(root);
    const found = learningIn(state, event.gateId);
    if (found.error) return found;
    const { learning } = found;
    if (event.gateSha256 !== learning.sha256) return refused(`firing: it is of other content than learning ${learning.id}'s gate`);
    const unrecorded = unrecordedReason(learning, state.view);
    if (unrecorded !== null) return refused(unrecorded);
    if (state.view.entries.some(e => e?.kind === 'wrong' && e.firing?.sessionId === sessionId && e.firing?.line === line)) {
      return refused('firing: it is already marked wrong');
    }
    write(() => appendLedger(root, ledgerEntry(learning, harnessIdentity(root), { kind: 'wrong', approvedBy: 'owner', firing: { sessionId, line } })));
    const marked = readState(root);
    const wrong = wrongSinceGrant(marked.view.entries, learning.id);
    if (wrong < WRONG_MARKS_TO_DEMOTE || !DEMOTABLE.has(learning.status)) return { ok: true, id: learning.id, wrong, status: learning.status };
    const demoted = demote(root, write, marked, learning, null);
    if (demoted.error) return failed(`${learning.id}: the mark was recorded, and the demotion it calls for was not; tick retries it (${demoted.error})`);
    return { ok: true, id: learning.id, wrong, status: demoted.status };
  });
}

/**
 * Demotes a learning promoted on this machine or landed, as the owner asked
 * at a terminal: its gate goes back to `observe` and it returns to `trial`,
 * or, when its gate is committed, that gate is suspended on this machine
 * and it is `suspended` until a revert takes the gate out of the repository
 * and retires it. Demotion weakens a gate, so it passes the terminal check,
 * like approval: `options` is `{ interactive }`. Returns `{ ok: true, id,
 * status, repairedGates }`, or `{ error, exitCode }`.
 */
export function demoteLearning(root, id, options) {
  try {
    return byHand(root, id, optionsOf(options), 'a demotion', (write, state, learning) => {
      if (!DEMOTABLE.has(learning.status)) return refused(`${id} is ${learning.status}; only a learning promoted on this machine or landed is demoted`);
      return demote(root, write, state, learning, 'owner');
    });
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * Retires a learning that is neither rejected nor retired, as the owner
 * asked at a terminal: its local gate goes, as `retire` says, and it no
 * longer stands for its signature. Retirement is terminal, and it takes a
 * gate out of force, so it passes the terminal check: `options` is
 * `{ interactive }`. A landed or suspended learning whose gate is still in
 * the committed file is refused: retiring touches no file, so its gate
 * would stay in the repository binding everyone, and a revert is what takes
 * it out. Returns `{ ok: true, id, status, repairedGates }`, or `{ error,
 * exitCode }`.
 */
export function retireLearning(root, id, options) {
  try {
    return byHand(root, id, optionsOf(options), 'a retirement', (write, state, learning) => {
      if (SETTLED.has(learning.status)) return refused(`${id} is ${learning.status}; a rejected or retired learning is not retired again`);
      if (COMMITTED_STATUSES.has(learning.status) && isCommitted(state, learning)) {
        const after = learning.status === 'suspended' ? ' and retires it' : ', and it can be retired after that';
        return refused(`${id}: its gate is still in ${GATES_PATH}, binding everyone who has the repository; \`learn revert ${id} --yes\` at a terminal takes it out of the repository${after}`);
      }
      const written = retire(root, write, state, learning, { approvedBy: 'owner' });
      return written.error === undefined ? { status: 'retired' } : written;
    });
  } catch (error) {
    return readFailure(error);
  }
}

/** `{ learning }` for the learning `id` the ledger vouches for in `state`,
 * or the error saying why there is none. */
function vouchedLearning(state, id) {
  const found = learningIn(state, id);
  if (found.error) return found;
  const unrecorded = unrecordedReason(found.learning, state.view);
  return unrecorded === null ? found : refused(unrecorded);
}

/** A step the owner asked for at a terminal on the learning `id`, which the
 * ledger must vouch for; `change` returns `{ status }` or an error. */
function byHand(root, id, { interactive }, what, change) {
  if (!isInteractive(interactive)) return refuse(root, needsTerminal(what));
  if (!isId(id)) return refuse(root, failed(ID_ERROR));
  return repairedStep(root, write => {
    const state = readState(root);
    const found = vouchedLearning(state, id);
    if (found.error) return found;
    const changed = change(write, state, found.learning);
    return changed.error === undefined ? { ok: true, id, status: changed.status } : changed;
  });
}

/**
 * Sets the repository's promotion policy on this machine, as the owner
 * asked at a terminal: `policy` is `{ minTrialFirings, minTrialSessions,
 * maxAction }` and `options` is `{ interactive }`, what
 * `requireInteractive` returned. The ledger gets a `policy` entry carrying
 * the policy's hash with `approvedBy: 'owner'`, then the policy file is
 * written; `tick` promotes under a policy only while the file's hash is the
 * last one recorded. Returns `{ ok: true, sha256, repairedGates }`, or
 * `{ error, exitCode }`.
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
  if (checked.reason !== undefined) return refuse(root, failed(`policy: ${checked.reason}`));
  return repairedStep(root, write => {
    if (!readState(root).view.intact) return refused('the ledger cannot be read or its chain is broken, so the policy cannot be recorded; nothing was written');
    const { base, learned } = harnessIdentity(root);
    write(() => appendLedger(root, { kind: 'policy', policySha256: checked.sha256, base, learned, approvedBy: 'owner' }));
    write(() => writePolicy(root, checked.policy));
    return { ok: true, sha256: checked.sha256 };
  });
}

/**
 * Withdraws the repository's promotion policy on this machine, as the owner
 * asked at a terminal: `options` is `{ interactive }`. The ledger gets a
 * `policy` entry with `policySha256: null` and `approvedBy: 'owner'`, then
 * the policy file is removed if there is one. From then on no policy is in
 * force, whatever file appears, until one is set again; a withdrawal is
 * recorded even when no policy was ever set. Returns `{ ok: true,
 * policyFileRemoved, repairedGates }`, or `{ error, exitCode }`. A file
 * that cannot be removed once the withdrawal is recorded does not undo it:
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
    if (!readState(root).view.intact) return refused('the ledger cannot be read or its chain is broken, so the withdrawal cannot be recorded; nothing was written');
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
 * The deterministic part of the loop, run unattended. In order:
 *
 *   - the roll forward of each learning file a step left behind its ledger
 *     entry (`rolledForward`);
 *   - a `retired` entry for each id the ledger names that has no learning
 *     file, is not settled, is last recorded at `observe` and has no entry
 *     naming an approver (`retiredFileGone`), so its recurrence can be
 *     drafted again; any other fileless id is left as the ledger has it, and
 *     `errors` says that restoring the file is what settles it;
 *   - the gate repair, which removes every local gate the ledger does not
 *     grant, the ones nobody approved among them (`unapprovedRemoved`);
 *   - retirement of each learning on trial every path of whose `cites` is
 *     gone (one citing nothing is never retired this way);
 *   - demotion of each promoted or landed learning marked wrong twice since
 *     its last promotion or landing, suspending a committed gate on this
 *     machine (`suspended`) and otherwise returning it to `trial`
 *     (`demoted`);
 *   - under a readable policy the owner set, promotion as
 *     `promoteUnderPolicy` decides, with `heldBack` naming each trial it
 *     passes over for a reason the owner can act on; a policy file whose
 *     hash the ledger did not record as the one in force promotes nothing,
 *     and `policyUnrecorded` and a line in `errors` say so.
 *
 * A learning whose gate warns or blocks is never retired here, since
 * deleting a file must not switch off an enforcing gate: when its cited
 * paths are all gone it is reported in `citationsGone` and stays in force
 * until the owner retires it at a terminal. `idCollisions` are the
 * learnings whose id the committed gate file holds for another gate, which
 * nothing here resolves. A local gate file that is not a gate file is
 * rewritten as the gates the ledger grants (`gateFileRewritten`) while the
 * ledger is intact, and left as it is otherwise; a rewrite that fails is
 * reported in `errors` and the rest of the run goes on. Writes
 * `last-tick.json` at the end as `{ ts, indexLines }`: `ts` from `now`, and
 * how many lines the seal index held when the run began, left out when the
 * index could not be read.
 *
 * Changes only learnings the ledger vouches for or names without a file,
 * and only in the data directory; never a rule in `docs/harness/RULES.md`
 * or any file in the repository. With the ledger broken it does the
 * removals and nothing else. Returns `{ promoted, demoted, retired,
 * suspended, retiredFileGone, rolledForward, heldBack, citationsGone,
 * idCollisions, unapprovedRemoved, repairedGates, gateFileRewritten,
 * ledgerIntact, policy, policyUnrecorded, errors }`, `policy` the policy
 * file's state and `errors` what could not be done, or `{ error, exitCode }`.
 */
export function tick(root, options) {
  try {
    return tickUnguarded(root, optionsOf(options));
  } catch (error) {
    return readFailure(error);
  }
}

function tickUnguarded(root, { now = Date.now }) {
  // Taken before the run, so a session sealed during it is counted as new
  // by the session-start notice rather than missed.
  const indexLines = indexLineCount(root);
  return withLearningsLock(root, write => {
    const rolledForward = rollLearningsForward(root, write);
    const before = readState(root);
    const intact = before.view.intact;
    const policy = readPolicy(root);
    const result = {
      promoted: [], demoted: [], retired: [], suspended: [], retiredFileGone: [], rolledForward, heldBack: [], citationsGone: [], idCollisions: [],
      unapprovedRemoved: before.local.file ? unapprovedGateIds(before.local.file.gates, before.view.entries) : [],
      repairedGates: [], gateFileRewritten: false,
      ledgerIntact: intact, policy: policy.state, policyUnrecorded: false, errors: [],
    };
    if (intact) retireFileless(root, write, before, result);
    if (!before.local.unreadable) {
      result.repairedGates = repairLocalGates(root, write);
    } else if (!intact) {
      result.errors.push('the local gate file is not a gate file, and with the ledger broken it cannot be rebuilt; it was left as it is');
    } else {
      try {
        result.repairedGates = rewriteLocalGates(root, write, readState(root));
        result.gateFileRewritten = true;
      } catch (error) {
        result.errors.push(`the local gate file is not a gate file and could not be rewritten (${codeOf(error)}); it was left as it is`);
      }
    }
    if (intact) applyRules(root, write, policy, result);
    else result.errors.push('the ledger cannot be read or its chain is broken, so nothing was retired, demoted or promoted');
    const after = readState(root);
    result.citationsGone = citationsGone(root, after);
    result.idCollisions = idCollisions(after);
    const dir = repoDataDir(root);
    write(() => {
      mkdirSync(dir, { recursive: true });
      const record = { ts: new Date(now()).toISOString(), ...(indexLines === null ? {} : { indexLines }) };
      writeFileAtomic(join(dir, LAST_TICK_FILE), JSON.stringify(record, null, 2) + '\n');
    });
    return result;
  });
}

/**
 * Records `retired` for each id the ledger in `state` names that has no
 * learning file, is not settled, and `retiredWhenFileless`: a draft stopped
 * before it wrote its file, or a candidate or trial nobody approved, which
 * nothing else can move and which would stand for its signature for good.
 * Any other fileless id keeps its ledger entries, so the file put back is
 * the learning it was: a `retired` entry is terminal, would lift a
 * suspension, and would let the recurrence be drafted and promoted again as
 * though nobody had judged it.
 */
function retireFileless(root, write, state, result) {
  const { base, learned } = harnessIdentity(root);
  for (const id of fileless(state)) {
    const last = recordedState(state.view.entries, id);
    if (last === null || SETTLED.has(last.status)) continue;
    if (!retiredWhenFileless(state.view.entries, id)) {
      result.errors.push(`${id}: its learning file is gone, and ${FILELESS_KEPT} it, so it was not recorded retired; restoring the file is what lets a step change it again`);
      continue;
    }
    const { contentSha256, proseSha256, evidence } = last;
    try {
      write(() => appendLedger(root, { kind: 'retired', learningId: id, contentSha256, proseSha256, evidence, base, learned, approvedBy: null, detail: 'its learning file is gone' }));
      result.retiredFileGone.push(id);
    } catch (error) {
      result.errors.push(`${id}: its learning file is gone, and it could not be recorded retired (${codeOf(error)})`);
    }
  }
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

/** Whether the session `sessionId` is flagged as holding outside content. */
const readOutside = (root, sessionId) => readEvents(root, sessionId).events.some(e => e.type === EXTERNAL_EVENT);

/**
 * Promotes, to the policy's `maxAction` and recorded with `approvedBy:
 * 'policy:<sha256>'`, each learning on trial that `policyAllows` given its
 * firings, sessions, wrong marks and whether its evidence holds outside
 * content. Only a learning fresh from replay qualifies, one whose last
 * status entry is `trial`: a learning demoted back to trial is promoted
 * again only by the owner, so a demotion the owner asked for is not undone
 * by the next tick.
 *
 * Outside content is judged as of this run. A learning is external when its
 * file says so, any ledger entry for it does, or its recurrence as the log
 * now holds it includes a flagged session, one that joined after the draft
 * among them. A firing in a flagged session is not counted, toward the
 * firings or the sessions: what the gate fired on there may have been
 * steered by what was read.
 *
 * Two kinds of trial are passed over whatever they count, and named in
 * `result.heldBack`: one whose signature or failure kind an earlier
 * learning was marked wrong for, since the same gate redrafted under a new
 * id starts with no marks of its own; and one whose title, why and evidence
 * the ledger records no hash of, which only the owner's approval binds.
 */
function promoteUnderPolicy(root, write, policy, result, apply) {
  const state = readState(root);
  const { entries } = state.view;
  const trials = recordedIn(state).filter(l => l.status === 'trial' && state.recorded.get(l.id).kind === 'trial');
  if (trials.length === 0) return;
  const taxonomy = readFailures(root);
  const notRead = failuresNotRead(taxonomy.state);
  if (notRead !== null) {
    for (const { id } of trials) result.heldBack.push({ id, reason: `${FAILURES_PATH} ${notRead}, so whether an earlier learning for its failure kind was marked wrong is not known` });
    return;
  }
  const { kinds } = taxonomy;
  const { recurrences } = findRecurrences(root);
  const { gates } = gateStats(root, entries, new Map(trials.map(l => [l.id, l.sha256])), { places: true });
  const flagged = new Map();
  const isFlagged = sessionId => {
    if (!flagged.has(sessionId)) flagged.set(sessionId, readOutside(root, sessionId));
    return flagged.get(sessionId);
  };
  for (const learning of trials) {
    const wrongBefore = wrongMarkedFor(state, learning.signature, kinds, learning.id);
    if (wrongBefore.length > 0) {
      result.heldBack.push({ id: learning.id, reason: `an earlier learning for its recurrence or failure kind was marked wrong: ${wrongBefore.join(', ')}` });
      continue;
    }
    if (proseUnrecorded(entries, learning.id)) {
      result.heldBack.push({ id: learning.id, reason: 'the ledger records no hash of its title, why and evidence, which an approval at a terminal does' });
      continue;
    }
    const { places, wrong } = gates.get(learning.id);
    const counted = places.filter(p => !isFlagged(p.sessionId));
    const firings = counted.length;
    const sessions = new Set(counted.map(p => p.sessionId)).size;
    const external = learning.external || learning.evidence.external
      || entries.some(e => e?.learningId === learning.id && e.evidence?.external === true)
      || recurrences.some(r => r.signature === learning.signature && r.external);
    if (!policyAllows(policy.policy, { firings, sessions, wrong: wrong.sinceGrant, external })) continue;
    const promotion = { action: policy.policy.maxAction, approvedBy: `policy:${policy.sha256}`, detail: `${firings} firings in ${sessions} sessions` };
    apply(learning, (s, l) => promote(root, write, s, l, promotion), () => result.promoted.push(learning.id));
  }
}
