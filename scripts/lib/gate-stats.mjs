// scripts/lib/gate-stats.mjs
//
// What the session log and the ledger record of each gate: how it fired,
// what followed its warnings and blocks, and how often its learning was
// marked wrong. `log report` shows it per gate id and `learn-lib.mjs` per
// learning, both from this one computation. Reads only.
import { GATE_ACTIONS, GATE_ID } from '../../assets/scripts/harness-gates.mjs';
import { readEvents } from '../../assets/scripts/harness-log.mjs';
import { FAILURE_EVENT, sessionIds, SUCCESS_EVENT, TOOL_FIELD } from './recurrence.mjs';

export const FIRING_EVENT = 'gate_firing';

/** What `rerouted` counts, in the words every reader shows it in. */
export const REROUTED_MEANS = 'rerouted: after a warn or block firing, the next call of the same tool in that session succeeded; a firing whose call has no tool use id is not counted';

const ABOVE_OBSERVE = new Set(['warn', 'block']);
const SHA256 = /^[0-9a-f]{64}$/;

const isString = v => typeof v === 'string';
const isWellFormedFiring = e => isString(e.gateId) && GATE_ID.test(e.gateId) && GATE_ACTIONS.includes(e.action) && isString(e.tool);

/** `{ sincePromotion, total }` per learning id with a `promoted` or `wrong`
 * entry: the wrong marks since its last promotion, or ever when it was never
 * promoted, and in all. */
function wrongMarksById(entries) {
  const marks = new Map();
  for (const entry of entries) {
    const id = entry?.learningId;
    if (!isString(id) || !GATE_ID.test(id) || (entry.kind !== 'promoted' && entry.kind !== 'wrong')) continue;
    if (!marks.has(id)) marks.set(id, { sincePromotion: 0, total: 0 });
    const m = marks.get(id);
    if (entry.kind === 'promoted') {
      m.sincePromotion = 0;
    } else {
      m.sincePromotion++;
      m.total++;
    }
  }
  return marks;
}

/** How many times the learning `id` was marked wrong since its last
 * promotion, or ever when it was never promoted. */
export const wrongSincePromotion = (entries, id) => wrongMarksById(entries).get(id)?.sincePromotion ?? 0;

const blank = () => ({ fired: Object.fromEntries(GATE_ACTIONS.map(a => [a, 0])), sessions: new Set(), rerouted: 0, gateSha256s: new Set() });

/**
 * What the session log and `ledgerEntries` record of each gate:
 * `{ gates, sessionsRead, sessionsUnreadable, firingsMalformed }`, `gates`
 * mapping each gate id to `{ fired, firings, sessions, rerouted,
 * gateSha256s, wrong }`. `fired` counts its firings per action and
 * `firings` all of them; `sessions` is how many sessions hold one;
 * `gateSha256s` the content hashes it fired under; `wrong` is
 * `{ sincePromotion, total }`, as `wrongSincePromotion` counts the first, or
 * null when `ledgerEntries` is null because the ledger cannot vouch for
 * what it holds.
 *
 * A firing counts when its gate id, action and tool are ones a gate can
 * have; any other is counted in `firingsMalformed` alone. With `contents`, a
 * map from gate id to content hash, a firing counts only for an id it holds
 * and under that content, and exactly those ids are returned; without it,
 * every gate id that fired or was marked wrong is.
 *
 * `rerouted` counts, as `REROUTED_MEANS` says, the `warn` and `block`
 * firings after which the next call of the gate's tool in that session
 * succeeded. The fired call's own outcome, which bears its tool use id, is
 * not that next call; a later `block` firing of the tool on another call is
 * that call, denied. An `observe` firing told nobody anything, so it is
 * never counted. `sessionsUnreadable` counts the sessions that could not be
 * read in full, whose counts are what did parse. Throws when the sessions
 * directory cannot be listed.
 */
export function gateStats(root, ledgerEntries, contents = null) {
  const byGate = new Map(contents === null ? [] : [...contents.keys()].map(id => [id, blank()]));
  const ids = sessionIds(root);
  let sessionsUnreadable = 0;
  let firingsMalformed = 0;
  for (const sessionId of ids) {
    const { events, unreadable } = readEvents(root, sessionId);
    if (unreadable) sessionsUnreadable++;
    let awaiting = [];
    for (const event of events) {
      if (event.type === FIRING_EVENT) {
        if (!isWellFormedFiring(event)) {
          firingsMalformed++;
          continue;
        }
        if (event.action === 'block') awaiting = awaiting.filter(f => f.tool !== event.tool || f.toolUseId === event.tool_use_id);
        if (contents !== null && (!contents.has(event.gateId) || contents.get(event.gateId) !== event.gateSha256)) continue;
        if (!byGate.has(event.gateId)) byGate.set(event.gateId, blank());
        const g = byGate.get(event.gateId);
        g.fired[event.action]++;
        g.sessions.add(sessionId);
        if (isString(event.gateSha256) && SHA256.test(event.gateSha256)) g.gateSha256s.add(event.gateSha256);
        if (ABOVE_OBSERVE.has(event.action) && isString(event.tool_use_id)) awaiting.push({ g, tool: event.tool, toolUseId: event.tool_use_id });
      } else if (event.type === SUCCESS_EVENT || event.type === FAILURE_EVENT) {
        const isNext = f => f.tool === event[TOOL_FIELD] && f.toolUseId !== event.tool_use_id;
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
    wrong: marks === null ? null : (marks.get(id) ?? { sincePromotion: 0, total: 0 }),
  }]));
  return { gates, sessionsRead: ids.length, sessionsUnreadable, firingsMalformed };
}
