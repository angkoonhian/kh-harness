// scripts/lib/log-report.mjs
//
// The `log report` subcommand: the failures that recur across this
// repository's sessions, grouped by the harness and model they recurred
// under, with the failure kind that labels each; how each gate fired and
// what followed; and every count of what could not be read. Of the log's
// content only a recurrence's normalised first error line, its tool name and
// its harness and model leave this module, each cleaned by `shown`. No tool
// input or output, prompt, or path taken from an event is returned or
// rendered.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { GATE_ACTIONS, GATE_ID } from '../../assets/scripts/harness-gates.mjs';
import { readEvents, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { escapeDelimiters, stripUnsafe } from '../../assets/scripts/harness-redact.mjs';
import { FAILURES_PATH, parseFailures } from './failures-evidence.mjs';
import { readLedger, verifyLedger } from './ledger.mjs';
import { checkDataDir } from './log-lib.mjs';
import { FAILURE_EVENT, findRecurrences, sessionIds, SUCCESS_EVENT, TOOL_FIELD } from './recurrence.mjs';
import { readIfPresent } from './scan.mjs';

export const GATE_FIRING_EVENT = 'gate_firing';

/** What `rerouted` counts, stated in the report itself. */
export const REROUTED_MEANS = 'rerouted: after a block firing, the next call of the same tool in that session succeeded';

/** The sentence every report ends with. */
export const NOT_CLAIMED = 'This report counts recurrences and gate firings in the sessions read; it does not show that outcomes improved.';

const MAX_SHOWN_CHARS = 200;
const WRONG_KIND = 'wrong';
const SHA256 = /^[0-9a-f]{64}$/;

const isString = v => typeof v === 'string';

/** Text from the log as it may be shown: what a reader cannot see removed,
 * every whitespace run one space, the first `MAX_SHOWN_CHARS` code points,
 * then `<` and `>` escaped so it can close no delimited block it is placed
 * in. */
const shown = text => escapeDelimiters([...stripUnsafe(text).replace(/\s+/g, ' ').trim()].slice(0, MAX_SHOWN_CHARS).join(''));

/** A timestamp from the log in the kit's own spelling, or null when it is
 * not one. */
const isoOrNull = ts => (isString(ts) && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : null);

/** Whether the taxonomy is `absent`, `unreadable` or `read`, and the
 * failure kinds it names. */
function readTaxonomy(root) {
  if (!existsSync(join(root, FAILURES_PATH))) return { state: 'absent', kinds: [] };
  const text = readIfPresent(root, FAILURES_PATH);
  return text === null ? { state: 'unreadable', kinds: [] } : { state: 'read', kinds: parseFailures(text) };
}

/** The recurrence as the report shows it: its log-sourced text cleaned, its
 * times re-spelled, and the ids of the failure kinds that list its
 * signature, or null when the taxonomy could not be read. */
function shownRecurrence(r, taxonomy) {
  return {
    signature: r.signature,
    tool: shown(r.tool),
    errorLine: shown(r.errorLine),
    sessions: r.sessions,
    count: r.count,
    external: r.external,
    firstTs: isoOrNull(r.firstTs),
    lastTs: isoOrNull(r.lastTs),
    exampleEventRefs: r.exampleEventRefs,
    failureKinds: taxonomy.state === 'unreadable' ? null : taxonomy.kinds.filter(k => k.signatures.includes(r.signature)).map(k => k.id),
  };
}

/** One group per harness and model, in the order of their first
 * recurrence, since recurrences are found within a group and never across. */
function groupRecurrences(recurrences, taxonomy) {
  const groups = new Map();
  for (const r of recurrences) {
    const key = JSON.stringify([r.base, r.model]);
    if (!groups.has(key)) groups.set(key, { base: shown(r.base), model: shown(r.model), recurrences: [] });
    groups.get(key).recurrences.push(shownRecurrence(r, taxonomy));
  }
  return [...groups.values()];
}

const isFiring = e => e.type === GATE_FIRING_EVENT;
const isWellFormedFiring = e => isString(e.gateId) && GATE_ID.test(e.gateId) && GATE_ACTIONS.includes(e.action) && isString(e.tool);

/** Whether, after the block firing at `from`, the next call of the same tool
 * succeeded. A later block firing of that tool is that next call, denied;
 * an outcome bearing the firing's own `tool_use_id` is the blocked call's,
 * not the next one's. */
function nextCallSucceeded(events, from) {
  const firing = events[from];
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e[TOOL_FIELD] !== firing.tool) continue;
    if (isFiring(e) && e.action === 'block' && isWellFormedFiring(e)) return false;
    if (e.type !== SUCCESS_EVENT && e.type !== FAILURE_EVENT) continue;
    if (isString(firing.tool_use_id) && e.tool_use_id === firing.tool_use_id) continue;
    return e.type === SUCCESS_EVENT;
  }
  return false;
}

/** The `wrong` marks per learning id, or null when the ledger's chain cannot
 * vouch for what it holds. */
function wrongMarks(root, ledger) {
  if (!ledger.intact) return null;
  const marks = new Map();
  for (const entry of readLedger(root)) {
    if (entry.kind === WRONG_KIND && GATE_ID.test(entry.learningId)) marks.set(entry.learningId, (marks.get(entry.learningId) ?? 0) + 1);
  }
  return marks;
}

const idNumber = id => Number(id.slice(1));

/** How every gate fired in `ids`, per action, how many of its blocks were
 * rerouted, and how many times its learning was marked wrong. A gate marked
 * wrong that never fired in the sessions read is listed with no firings. */
function gateFirings(root, ids, ledger) {
  const byGate = new Map();
  const gate = id => {
    if (!byGate.has(id)) byGate.set(id, { fired: Object.fromEntries(GATE_ACTIONS.map(a => [a, 0])), rerouted: 0, gateSha256s: new Set() });
    return byGate.get(id);
  };
  let sessionsUnreadable = 0;
  let firingsMalformed = 0;
  for (const id of ids) {
    const { events, unreadable } = readEvents(root, id);
    if (unreadable) sessionsUnreadable++;
    events.forEach((e, index) => {
      if (!isFiring(e)) return;
      if (!isWellFormedFiring(e)) {
        firingsMalformed++;
        return;
      }
      const g = gate(e.gateId);
      g.fired[e.action]++;
      if (isString(e.gateSha256) && SHA256.test(e.gateSha256)) g.gateSha256s.add(e.gateSha256);
      if (e.action === 'block' && nextCallSucceeded(events, index)) g.rerouted++;
    });
  }
  const marks = wrongMarks(root, ledger);
  for (const id of marks?.keys() ?? []) gate(id);
  const firings = [...byGate]
    .sort(([a], [b]) => idNumber(a) - idNumber(b))
    .map(([gateId, g]) => ({ gateId, fired: g.fired, rerouted: g.rerouted, markedWrong: marks === null ? null : (marks.get(gateId) ?? 0), gateSha256s: [...g.gateSha256s].sort() }));
  return { sessionsRead: ids.length, sessionsUnreadable, firingsMalformed, reroutedMeans: REROUTED_MEANS, firings };
}

/**
 * What the log says keeps going wrong and how the gates fired, with every
 * count of what was read and what could not be. Reads only. When the
 * sessions directory cannot be listed, every count read from it, the groups
 * and the gates are null.
 */
export function buildLogReport(root) {
  const location = repoDataDir(root);
  const exists = checkDataDir(root).state !== 'absent';
  const taxonomy = readTaxonomy(root);
  const ledger = verifyLedger(root);
  const report = {
    location,
    exists,
    sessionsUnlistable: false,
    sessionsRead: null,
    sessionsUnreadable: null,
    linesUnparseable: null,
    failuresUnattributed: null,
    groups: null,
    taxonomy: { path: FAILURES_PATH, state: taxonomy.state },
    gates: null,
    ledger,
    notClaimed: NOT_CLAIMED,
  };
  let found;
  let ids;
  try {
    found = findRecurrences(root);
    ids = sessionIds(root);
  } catch {
    return { ...report, sessionsUnlistable: true };
  }
  const { recurrences, sessionsRead, sessionsUnreadable, linesUnparseable, failuresUnattributed } = found;
  return {
    ...report,
    sessionsRead,
    sessionsUnreadable,
    linesUnparseable,
    failuresUnattributed,
    groups: groupRecurrences(recurrences, taxonomy),
    gates: gateFirings(root, ids, ledger),
  };
}

const NOT_READ = 'not read, because the sessions directory could not be listed';
const indent = lines => lines.map(l => `  ${l}`);
const times = n => (n === 1 ? '1 time' : `${n} times`);
const sessionsWord = n => (n === 1 ? '1 session' : `${n} sessions`);

function kindLine(kinds, taxonomyState) {
  if (kinds === null) return `failure kind: not read, because ${FAILURES_PATH} could not be read`;
  if (kinds.length > 0) return `failure kind: ${kinds.join(', ')}`;
  return taxonomyState === 'absent' ? `failure kind: unlabelled; there is no ${FAILURES_PATH}` : 'failure kind: unlabelled';
}

function recurrenceLines(r, taxonomyState) {
  const span = r.firstTs === null ? '' : `, from ${r.firstTs} to ${r.lastTs}`;
  return [
    `${r.signature}  ${r.tool}: in ${sessionsWord(r.sessions.length)}, ${times(r.count)}${span}`,
    ...indent([
      `error: ${r.errorLine}`,
      kindLine(r.failureKinds, taxonomyState),
      ...(r.external ? ['a contributing session read outside content (web or MCP)'] : []),
      `examples: ${r.exampleEventRefs.map(ref => `${ref.sessionId} event ${ref.line}`).join(', ')}`,
    ]),
  ];
}

function recurrenceSection(report) {
  const out = ['RECURRENCES (the same failure in two or more sessions under one harness and model)'];
  if (report.groups.length === 0) return [...out, '  none found'];
  for (const g of report.groups) {
    out.push(`  harness ${g.base}, model ${g.model}`);
    for (const r of g.recurrences) out.push(...indent(indent(recurrenceLines(r, report.taxonomy.state))));
  }
  return out;
}

function markedWrongText(n, ledger) {
  return n === null ? `not read, because the ledger's chain is broken at line ${ledger.brokenAt}` : String(n);
}

function gateSection(gates, ledger) {
  const out = [`GATE FIRINGS (from ${sessionsWord(gates.sessionsRead)} read; of them unreadable, in whole or part: ${gates.sessionsUnreadable})`];
  out.push(`  ${gates.reroutedMeans}`);
  if (gates.firings.length === 0) out.push('  no gate fired');
  for (const g of gates.firings) {
    const total = GATE_ACTIONS.reduce((n, a) => n + g.fired[a], 0);
    const actions = GATE_ACTIONS.map(a => `${a} ${g.fired[a]}`).join(', ');
    const rerouted = g.fired.block > 0 ? `; rerouted after ${g.rerouted} of ${g.fired.block} blocks` : '';
    const contents = g.gateSha256s.length > 1 ? `; fired under ${g.gateSha256s.length} different rule contents` : '';
    out.push(`  ${g.gateId}: fired ${times(total)} (${actions})${rerouted}; marked wrong: ${markedWrongText(g.markedWrong, ledger)}${contents}`);
  }
  if (gates.firingsMalformed > 0) out.push(`  firing events not counted, because their gate id or action is not one a gate can have: ${gates.firingsMalformed}`);
  return out;
}

/** The report as text for a person. */
export function renderReport(report) {
  const out = [];
  if (!report.exists) {
    out.push(`No log for this repository on this machine: ${report.location} does not exist, so nothing was read.`);
  } else if (report.sessionsUnlistable) {
    out.push('LOG REPORT', ...indent([`location: ${report.location}`, `sessions: ${NOT_READ}`, `recurrences and gate firings: ${NOT_READ}`]));
  } else {
    out.push('LOG REPORT', ...indent([
      `location: ${report.location}`,
      `sessions read: ${report.sessionsRead}; of them unreadable, in whole or part: ${report.sessionsUnreadable}; unparseable lines: ${report.linesUnparseable}`,
      `failures left out, because no harness and model was recorded before them: ${report.failuresUnattributed}`,
    ]));
    out.push('', ...recurrenceSection(report));
    out.push('', ...gateSection(report.gates, report.ledger));
  }
  out.push('', report.notClaimed);
  return out.join('\n');
}
