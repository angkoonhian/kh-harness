// scripts/lib/replay.mjs
//
// Replay: whether a drafted gate fires on the recorded mistakes it was
// written for and on nothing else. This script decides; the model that
// drafted the gate is never asked. Two checks run over this machine's
// session log. The differential check: the gate fires on every failing call
// bearing the recurrence's signature in the recurrence's sessions, and on
// none of the successful calls of the same tool that followed them. The
// false-positive check: the gate fires on no call of its own tool in any
// session that holds no failure with that signature, and enough such calls
// were replayed for that silence to mean something.
//
// The log is scrubbed before it is written, so a credential in a recorded
// input reads as `SCRUB_MARK`, and the gate is replayed against that
// scrubbed text: where the inspected field held a scrubbed value, the gate
// can behave differently on the live input. A call whose content the log no
// longer holds, expired by retention or moved to a blob over the inline cap,
// is counted as not replayable and never guessed at. A reason is built from
// counts and fixed text only, never from a tool input.
import { GATE_LIMITS, matchGate, validateGate } from '../../assets/scripts/harness-gates.mjs';
import { readEvents, SCRUB_MARK } from '../../assets/scripts/harness-log.mjs';
import { FAILURE_EVENT, failureSignature, listSessions, SUCCESS_EVENT, TOOL_FIELD } from './recurrence.mjs';

/** The least clean evidence a `pass` needs: calls of the gate's own tool
 * whose inspected field was replayed, across at least this many sessions
 * holding no failure of the signature. */
export const MIN_CLEAN_CALLS = 20;
export const MIN_CLEAN_SESSIONS = 2;

// The fields of a logged tool event this module reads, beside `type` and
// `TOOL_FIELD`: the scrubbed tool input, and the mark retention leaves on an
// event whose content it removed.
const INPUT_FIELD = 'input';
const EXPIRED_FIELD = 'contentExpired';

const TOOL_CALL_EVENTS = new Set([SUCCESS_EVENT, FAILURE_EVENT]);

// What replaying one call can come to. Only `FIRED` and `SILENT` mean the
// gate's pattern was tested against a string; `ABSENT` (the inspected field
// is missing or not a string) and `OTHER_TOOL` are decided by the call's
// shape alone, and `MISSING` by what the log no longer holds.
const FIRED = 'fired';
const SILENT = 'silent';
const MISSING = 'missing';
const ABSENT = 'absent';
const OTHER_TOOL = 'otherTool';

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The reference `appendEvent` leaves in place of a string over the inline
 * cap. */
const isBlobRef = v => isPlainObject(v) && v.truncated === true && Object.hasOwn(v, 'blob') && Object.hasOwn(v, 'bytes');

/** The value at the dotted `field` of `input` as `matchGate` resolves it, or
 * `MISSING` when the input or any value on the way is a blob reference, since
 * the gate's verdict on the real text cannot then be known. */
function inspectedValue(input, field) {
  let value = input;
  for (const segment of field.split('.')) {
    if (isBlobRef(value)) return MISSING;
    if (!isPlainObject(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return isBlobRef(value) ? MISSING : value;
}

/** What `gate` does on one logged tool call: `{ outcome, scrubbed }`, where
 * `outcome` is one of the outcomes above and `scrubbed` says whether the
 * inspected field holds `SCRUB_MARK`. */
function replayCall(gate, event) {
  const tool = event[TOOL_FIELD];
  if (tool !== gate.tool) return { outcome: OTHER_TOOL, scrubbed: false };
  if (event[EXPIRED_FIELD] === true || !Object.hasOwn(event, INPUT_FIELD)) return { outcome: MISSING, scrubbed: false };
  const input = event[INPUT_FIELD];
  const value = inspectedValue(input, gate.field);
  if (value === MISSING) return { outcome: MISSING, scrubbed: false };
  if (typeof value !== 'string') return { outcome: ABSENT, scrubbed: false };
  const scrubbed = value.slice(0, GATE_LIMITS.inputMax).includes(SCRUB_MARK);
  return { outcome: matchGate(gate, tool, input) ? FIRED : SILENT, scrubbed };
}

/** Counts of each outcome over a set of calls. */
const newTally = () => ({ calls: 0, [FIRED]: 0, [SILENT]: 0, [MISSING]: 0, [ABSENT]: 0, [OTHER_TOOL]: 0 });

function count(tally, replayed, totals) {
  tally.calls++;
  tally[replayed.outcome]++;
  if (replayed.scrubbed) totals.scrubbed++;
}

/** The calls whose inspected string the gate's pattern was tested against. */
const tested = tally => tally[FIRED] + tally[SILENT];

/** The calls whose outcome is known, tested or decided by their shape. */
const decided = tally => tally.calls - tally[MISSING];

/** Replays the session's mistakes and, for each, the next successful call of
 * its tool; a call that follows several mistakes is one successor.
 * `signatures[i]` is the signature of `events[i]`. */
function replayDifferential(gate, events, signatures, signature, totals) {
  const awaiting = new Set();
  events.forEach((event, i) => {
    if (signatures[i] === signature) {
      count(totals.mistakes, replayCall(gate, event), totals);
      awaiting.add(event[TOOL_FIELD]);
    } else if (event.type === SUCCESS_EVENT && awaiting.has(event[TOOL_FIELD])) {
      count(totals.successors, replayCall(gate, event), totals);
      awaiting.delete(event[TOOL_FIELD]);
    }
  });
}

/** Replays every call of the gate's own tool in a session that holds no
 * mistake; a call of another tool says nothing about the gate and is not
 * counted. The session counts as checked when the pattern was tested
 * against at least one of its calls. */
function replayClean(gate, events, totals) {
  const before = tested(totals.clean);
  for (const event of events) {
    if (TOOL_CALL_EVENTS.has(event.type) && event[TOOL_FIELD] === gate.tool) count(totals.clean, replayCall(gate, event), totals);
  }
  if (tested(totals.clean) > before) totals.cleanSessions++;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The gate's tool is named by this fixed phrase, never by the gate's own
// `tool` text, which a model drafted.
const ownToolCalls = n => plural(n, "call of the gate's tool", "calls of the gate's tool");

/** The verdict and its reason. A firing beyond the mistakes, or a mistake
 * the gate cannot catch, fails whatever else could not be read, since more
 * reading cannot undo it; otherwise anything either check could not see
 * leaves the gate unchecked. */
function judge(totals) {
  const { mistakes, successors, clean } = totals;
  const failures = [];
  const differentialProblems = [];
  if (mistakes[OTHER_TOOL] > 0) {
    differentialProblems.push(`the gate is for another tool than ${mistakes[OTHER_TOOL]} of ${plural(mistakes.calls, 'recorded mistake')}`);
  }
  if (mistakes[ABSENT] > 0) {
    const verb = mistakes[ABSENT] === 1 ? 'does' : 'do';
    differentialProblems.push(`the gate inspects a field that ${mistakes[ABSENT]} of ${plural(mistakes.calls, 'recorded mistake')} ${verb} not carry as text`);
  }
  if (mistakes[FIRED] < tested(mistakes)) {
    differentialProblems.push(`the gate fired on ${mistakes[FIRED]} of ${plural(tested(mistakes), 'replayable mistake')}`);
  }
  if (successors[FIRED] > 0) {
    differentialProblems.push(`the gate fired on ${successors[FIRED]} of ${plural(decided(successors), 'successful call')} that followed the mistakes`);
  }
  if (differentialProblems.length > 0) failures.push(`differential check failed: ${differentialProblems.join(' and ')}`);
  if (clean[FIRED] > 0) {
    failures.push(`false-positive check failed: the gate fired on ${clean[FIRED]} of ${ownToolCalls(tested(clean))} in ${plural(totals.cleanSessions, 'session')} with no failure of this signature`);
  }
  if (failures.length > 0) return { verdict: 'fail', reason: failures.join('; ') };

  const unchecked = [];
  const sessions = totals.recurrenceSessions;
  if (totals.recurrenceUnreadable > 0) unchecked.push(`${totals.recurrenceUnreadable} of the recurrence's ${plural(sessions, 'session')} could not be read in full`);
  if (totals.recurrenceWithoutMistake > 0) {
    const verb = totals.recurrenceWithoutMistake === 1 ? 'holds' : 'hold';
    unchecked.push(`${totals.recurrenceWithoutMistake} of the recurrence's ${plural(sessions, 'session')} no longer ${verb} a failure with its signature`);
  }
  if (tested(mistakes) === 0) {
    unchecked.push(`no recorded mistake could be replayed (${plural(mistakes.calls, 'mistake')} found, ${mistakes[MISSING]} without content)`);
  } else if (mistakes[MISSING] > 0) {
    unchecked.push(`${mistakes[MISSING]} of ${plural(mistakes.calls, 'mistake')} could not be replayed`);
  }
  if (successors[MISSING] > 0) {
    unchecked.push(`${successors[MISSING]} of ${plural(successors.calls, 'successful call')} that followed the mistakes could not be replayed`);
  }
  if (tested(clean) < MIN_CLEAN_CALLS || totals.cleanSessions < MIN_CLEAN_SESSIONS) {
    unchecked.push(`too little clean evidence: ${ownToolCalls(tested(clean))} replayed in ${plural(totals.cleanSessions, 'session')} with no failure of this signature, where at least ${MIN_CLEAN_CALLS} calls in ${MIN_CLEAN_SESSIONS} sessions are required`);
  }
  if (unchecked.length > 0) return { verdict: 'not-checkable', reason: `not checkable: ${unchecked.join('; ')}` };

  return {
    verdict: 'pass',
    reason: `the gate fired on all ${plural(mistakes.calls, 'mistake')}, on none of ${plural(successors.calls, 'successful call')} that followed them, and on none of ${ownToolCalls(tested(clean))} in ${plural(totals.cleanSessions, 'session')} with no failure of this signature`,
  };
}

/** What the reason adds about the limits of what was read and replayed. */
function limits(totals) {
  const notes = [];
  const { clean } = totals;
  if (clean[MISSING] > 0) {
    const verb = clean[MISSING] === 1 ? 'was' : 'were';
    notes.push(`${ownToolCalls(clean[MISSING])} in sessions with no failure of this signature could not be replayed and ${verb} not counted as checked`);
  }
  if (clean[ABSENT] > 0) {
    const one = clean[ABSENT] === 1;
    notes.push(`${ownToolCalls(clean[ABSENT])} in sessions with no failure of this signature ${one ? 'lacks' : 'lack'} the inspected field as text and ${one ? 'was' : 'were'} not counted as checked`);
  }
  if (totals.sessionsOutsideRecurrence > 0) {
    const one = totals.sessionsOutsideRecurrence === 1;
    notes.push(`${plural(totals.sessionsOutsideRecurrence, 'session')} outside the recurrence ${one ? 'holds' : 'hold'} a failure of this signature and ${one ? 'was' : 'were'} left out of both checks`);
  }
  if (totals.scrubbed > 0) {
    const verb = totals.scrubbed === 1 ? 'holds' : 'hold';
    notes.push(`${plural(totals.scrubbed, 'replayed input')} ${verb} ${SCRUB_MARK} in the inspected field, where the log's scrub hid a value; the gate was replayed against the scrubbed text`);
  }
  if (totals.sessionsUnreadable > 0 || totals.linesUnparseable > 0) {
    notes.push(`${plural(totals.sessionsUnreadable, 'session')} could not be read in full and ${plural(totals.linesUnparseable, 'line')} could not be parsed; what did parse was used`);
  }
  if (totals.sessionsBeingSealed > 0) {
    const verb = totals.sessionsBeingSealed === 1 ? 'has' : 'have';
    notes.push(`${plural(totals.sessionsBeingSealed, 'session')} ${verb} events in a claimed or temporary file, which are not read until a maintenance run finishes sealing them`);
  }
  return notes;
}

function result(totals, verdict, reason) {
  const { mistakes, successors, clean } = totals;
  return {
    differential: { firedOnMistakes: mistakes[FIRED], mistakes: mistakes.calls, firedOnSuccessors: successors[FIRED] },
    falsePositives: {
      fired: clean[FIRED],
      callsChecked: tested(clean),
      sessionsChecked: totals.cleanSessions,
      notReplayable: clean[MISSING],
      fieldAbsent: clean[ABSENT],
    },
    contentMissing: mistakes[MISSING] + successors[MISSING] + clean[MISSING],
    sessionsOutsideRecurrence: totals.sessionsOutsideRecurrence,
    sessionsUnreadable: totals.sessionsUnreadable,
    sessionsBeingSealed: totals.sessionsBeingSealed,
    linesUnparseable: totals.linesUnparseable,
    verdict,
    reason,
  };
}

/**
 * Replays `gate` against this machine's session log for `recurrence`, as
 * `findRecurrences` returns it. Mistakes are the failures bearing the
 * recurrence's signature in its sessions; each one's successor is the next
 * successful call of its tool in that session. For false positives, every
 * call of the gate's own tool in a session holding no failure of that
 * signature is replayed. A call counts as replayed only when its inspected
 * field is a string the gate's pattern was tested against: `callsChecked`
 * counts those, `sessionsChecked` the sessions contributing at least one,
 * `notReplayable` the calls whose content the log no longer holds, and
 * `fieldAbsent` those whose inspected field is missing or not a string. A
 * session holding the signature outside the recurrence is left out of both
 * checks and counted in `sessionsOutsideRecurrence`.
 *
 * `pass` requires at least one replayable mistake; the gate firing on every
 * mistake and on no successor or clean call; every mistake, successor and
 * recurrence session readable; and at least `MIN_CLEAN_CALLS` clean calls
 * replayed across at least `MIN_CLEAN_SESSIONS` sessions. Any firing beyond
 * the mistakes, a replayable mistake missed, or a mistake the gate cannot
 * catch (of another tool, or lacking the inspected field as a string) is
 * `fail`; a successor lacking the field is one the gate did not fire on.
 * Anything else short of a pass is `not-checkable`. A gate that is not well
 * formed is `fail` without being replayed. A session that could not be read
 * in full, or has lines that do not parse, is still used for what did parse
 * and counted in `sessionsUnreadable` and `linesUnparseable`. A session with
 * events in a claimed or temporary file is counted in `sessionsBeingSealed`,
 * and when it is one of the recurrence's it was not read in full. Throws
 * only when the sessions directory exists and cannot be listed.
 */
export function replayGate(root, gate, recurrence) {
  const totals = {
    mistakes: newTally(),
    successors: newTally(),
    clean: newTally(),
    cleanSessions: 0,
    scrubbed: 0,
    recurrenceSessions: 0,
    recurrenceUnreadable: 0,
    recurrenceWithoutMistake: 0,
    sessionsOutsideRecurrence: 0,
    sessionsUnreadable: 0,
    sessionsBeingSealed: 0,
    linesUnparseable: 0,
  };
  const valid = validateGate(gate);
  if (!valid.ok) return result(totals, 'fail', `the gate was not replayed: ${valid.reason}`);

  const { signature } = recurrence;
  const mistakeSessions = new Set(recurrence.sessions);
  totals.recurrenceSessions = mistakeSessions.size;
  const listed = listSessions(root);
  const beingSealed = new Set(listed.filter(session => session.beingSealed).map(session => session.id));
  totals.sessionsBeingSealed = beingSealed.size;
  for (const sessionId of new Set([...listed.map(session => session.id), ...mistakeSessions])) {
    const { events, unparseable, unreadable } = readEvents(root, sessionId);
    if (unreadable) totals.sessionsUnreadable++;
    totals.linesUnparseable += unparseable;
    const signatures = events.map(e => failureSignature(e, root));
    const holdsMistake = signatures.includes(signature);
    if (mistakeSessions.has(sessionId)) {
      if (unreadable || beingSealed.has(sessionId)) totals.recurrenceUnreadable++;
      if (!holdsMistake) totals.recurrenceWithoutMistake++;
      replayDifferential(gate, events, signatures, signature, totals);
    } else if (holdsMistake) {
      totals.sessionsOutsideRecurrence++;
    } else {
      replayClean(gate, events, totals);
    }
  }
  const { verdict, reason } = judge(totals);
  return result(totals, verdict, [reason, ...limits(totals)].join('. '));
}
