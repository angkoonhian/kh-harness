// scripts/lib/gate-stats.mjs
//
// What the session log and the ledger record of each gate: how it fired,
// what followed its warnings and blocks, and how often its learning was
// marked wrong. `log report` shows it per gate id and `learn-lib.mjs` per
// learning, both from this one computation. Reads only.
import { GATE_ACTIONS, GATE_ID } from '../../assets/scripts/harness-gates.mjs';
import { readEvents } from '../../assets/scripts/harness-log.mjs';
import { ABOVE_OBSERVE, isSha256 } from './ledger.mjs';
import { FAILURE_EVENT, listSessions, SUCCESS_EVENT, TOOL_FIELD } from './recurrence.mjs';

export const FIRING_EVENT = 'gate_firing';

/** What `rerouted` counts, in the words every reader shows it in. */
export const REROUTED_MEANS = 'rerouted: after a warn or block firing, the next call of the same tool by the same agent in that session, started after the firing, succeeded; a firing whose call has no tool use id is not counted';

// The logged events that say a call started, and that it was refused before
// it ran.
const START_EVENT = 'PreToolUse';
const DENIED_EVENT = 'PermissionDenied';
const OUTCOME_EVENTS = new Set([SUCCESS_EVENT, FAILURE_EVENT, DENIED_EVENT]);

/** The agent an event belongs to: a sub-agent's id, or null for the main
 * agent, whose events carry none. */
const agentOf = event => (isString(event.agent_id) ? event.agent_id : null);

const isString = v => typeof v === 'string';
const isWellFormedFiring = e => isString(e.gateId) && GATE_ID.test(e.gateId) && GATE_ACTIONS.includes(e.action) && isString(e.tool);

// The kinds after which a learning's wrong marks count afresh: a promotion,
// and a landing, which is the owner's approval of its gate for the
// repository. A revert grants nothing new, so it does not restart the
// count: the marks since the landing still stand against the approval that
// a revert leaves on this machine.
const RECOUNT_KINDS = new Set(['promoted', 'landed']);

/** `{ sinceGrant, total }` per learning id with a `RECOUNT_KINDS` or
 * `wrong` entry: the wrong marks since its last promotion or landing, or
 * ever when it had neither, and in all. */
function wrongMarksById(entries) {
  const marks = new Map();
  for (const entry of entries) {
    const id = entry?.learningId;
    if (!isString(id) || !GATE_ID.test(id) || (!RECOUNT_KINDS.has(entry.kind) && entry.kind !== 'wrong')) continue;
    if (!marks.has(id)) marks.set(id, { sinceGrant: 0, total: 0 });
    const m = marks.get(id);
    if (RECOUNT_KINDS.has(entry.kind)) {
      m.sinceGrant = 0;
    } else {
      m.sinceGrant++;
      m.total++;
    }
  }
  return marks;
}

/** How many times the learning `id` was marked wrong since its last
 * promotion or landing, or ever when it had neither. */
export const wrongSinceGrant = (entries, id) => wrongMarksById(entries).get(id)?.sinceGrant ?? 0;

const blank = () => ({ fired: Object.fromEntries(GATE_ACTIONS.map(a => [a, 0])), sessions: new Set(), rerouted: 0, gateSha256s: new Set(), places: [] });

/**
 * What the session log and `ledgerEntries` record of each gate:
 * `{ gates, sessionsRead, sessionsUnreadable, sessionsBeingSealed,
 * firingsMalformed }`, `gates`
 * mapping each gate id to `{ fired, firings, sessions, rerouted,
 * gateSha256s, wrong }`, and `places` too when `places` is true. `fired`
 * counts its firings per action and `firings` all of them; `sessions` is
 * how many sessions hold one; `gateSha256s` the content hashes it fired
 * under; `wrong` is `{ sinceGrant, total }`, as `wrongSinceGrant` counts
 * the first, or null when `ledgerEntries` is null because the ledger cannot
 * vouch for what it holds; and `places` is where each of its firings is,
 * `{ sessionId, line, action, ts }` in the order read, `line` the firing's
 * 1-based position in what `readEvents` returns for the session, which is
 * how a wrong mark names it, and `ts` its time or null.
 *
 * A firing counts when its gate id, action and tool are ones a gate can
 * have; any other is counted in `firingsMalformed` alone. With `contents`, a
 * map from gate id to content hash, a firing counts only for an id it holds
 * and under that content, and exactly those ids are returned; without it,
 * every gate id that fired or was marked wrong is.
 *
 * `rerouted` counts, as `REROUTED_MEANS` says, the `warn` and `block`
 * firings after which the next call of the gate's tool by the same agent in
 * that session succeeded. The fired call's own outcome, which bears its tool
 * use id, is not that next call; nor is a call of another agent, or one
 * whose start the log records before the firing, which was already running.
 * A later `block` firing of the tool on another call is that call, denied,
 * and so is a call a permission denial refused. A call whose start the log
 * does not record is taken to have started after the firing. An `observe`
 * firing told nobody anything, so it is never counted. `sessionsUnreadable` counts the sessions that could not be
 * read in full, whose counts are what did parse, and `sessionsBeingSealed`
 * those with events in a claimed or temporary file, whose firings there are
 * not counted. Throws when the sessions directory cannot be listed.
 */
export function gateStats(root, ledgerEntries, contents = null, { places = false } = {}) {
  const byGate = new Map(contents === null ? [] : [...contents.keys()].map(id => [id, blank()]));
  const sessions = listSessions(root);
  let sessionsUnreadable = 0;
  let firingsMalformed = 0;
  for (const { id: sessionId } of sessions) {
    const { events, unreadable } = readEvents(root, sessionId);
    if (unreadable) sessionsUnreadable++;
    let awaiting = [];
    const startedAt = new Map();
    for (const [index, event] of events.entries()) {
      if (event.type === START_EVENT) {
        if (isString(event.tool_use_id) && !startedAt.has(event.tool_use_id)) startedAt.set(event.tool_use_id, index);
      } else if (event.type === FIRING_EVENT) {
        if (!isWellFormedFiring(event)) {
          firingsMalformed++;
          continue;
        }
        if (event.action === 'block') {
          awaiting = awaiting.filter(f => f.tool !== event.tool || f.agent !== agentOf(event) || f.toolUseId === event.tool_use_id);
        }
        if (contents !== null && (!contents.has(event.gateId) || contents.get(event.gateId) !== event.gateSha256)) continue;
        if (!byGate.has(event.gateId)) byGate.set(event.gateId, blank());
        const g = byGate.get(event.gateId);
        g.fired[event.action]++;
        g.sessions.add(sessionId);
        if (places) g.places.push({ sessionId, line: index + 1, action: event.action, ts: isString(event.ts) ? event.ts : null });
        if (isSha256(event.gateSha256)) g.gateSha256s.add(event.gateSha256);
        if (ABOVE_OBSERVE.includes(event.action) && isString(event.tool_use_id)) {
          awaiting.push({ g, tool: event.tool, agent: agentOf(event), toolUseId: event.tool_use_id, at: index });
        }
      } else if (OUTCOME_EVENTS.has(event.type)) {
        const isNext = f => f.tool === event[TOOL_FIELD] && f.agent === agentOf(event) && f.toolUseId !== event.tool_use_id
          && !(startedAt.get(event.tool_use_id) < f.at);
        if (event.type === SUCCESS_EVENT) for (const f of awaiting) if (isNext(f)) f.g.rerouted++;
        awaiting = awaiting.filter(f => !isNext(f));
      }
    }
  }
  const marks = ledgerEntries === null ? null : wrongMarksById(ledgerEntries);
  if (contents === null) for (const [id, m] of marks ?? []) if (m.total > 0 && !byGate.has(id)) byGate.set(id, blank());
  const gates = new Map([...byGate].map(([id, g]) => [id, {
    fired: g.fired,
    firings: GATE_ACTIONS.reduce((n, a) => n + g.fired[a], 0),
    sessions: g.sessions.size,
    rerouted: g.rerouted,
    gateSha256s: [...g.gateSha256s].sort(),
    wrong: marks === null ? null : (marks.get(id) ?? { sinceGrant: 0, total: 0 }),
    ...(places ? { places: g.places } : {}),
  }]));
  return { gates, sessionsRead: sessions.length, sessionsUnreadable, sessionsBeingSealed: sessions.filter(session => session.beingSealed).length, firingsMalformed };
}
