// scripts/lib/learn-cli.mjs
//
// The `learn` command's argument handling, its read-only views and the text
// it prints. Nothing here writes or changes a learning: the steps that do
// are called from `scripts/learn.mjs` alone, each by its own handler.
//
// What may be printed is ids, hashes, counts, statuses, times and a gate's
// own fields. A learning's title, why and gate were written by a model from
// log content, and every learning file can be edited by anything running as
// this user, so each string read from one is printed only as JSON with every
// code point outside printable ASCII written as `\u{…}`: nothing invisible
// can hide in what a person is about to approve. Of the session log only
// what `log report` prints is printed, by `log report`'s own helpers.
import { readFileSync } from 'node:fs';

import { REROUTED_MEANS } from './gate-stats.mjs';
import { ID_ERROR, isId, learningIn, learningStats, readState, standingFor, unrecordedReason } from './learn-lib.mjs';
import { recordedPolicySha256 } from './learn-promote.mjs';
import { readLedger, verifyLedger } from './ledger.mjs';
import { buildLogReport, NOT_READ, noLogLine, readCountLines, recurrenceSection } from './log-report.mjs';
import { readPolicy } from './policy.mjs';

// What each subcommand takes: its positional arguments, the flags it owns
// and which of those it requires.
const SPECS = Object.freeze({
  candidates: { args: [], flags: ['--json'] },
  draft: { args: [], flags: ['--from'], required: ['--from'] },
  replay: { args: ['<id>'], flags: [] },
  list: { args: [], flags: ['--json'] },
  show: { args: ['<id>'], flags: ['--json'] },
  approve: { args: ['<id>'], flags: ['--sha256', '--action'], required: ['--sha256', '--action'] },
  wrong: { args: ['<session>:<line>'], flags: [] },
  demote: { args: ['<id>'], flags: [] },
  retire: { args: ['<id>'], flags: [] },
  tick: { args: [], flags: ['--json'] },
  'policy show': { args: [], flags: ['--json'] },
  'policy set': { args: [], flags: ['--min-firings', '--min-sessions', '--max-action'], required: ['--min-firings', '--min-sessions', '--max-action'] },
  'policy clear': { args: [], flags: [] },
});

export const LEARN_SUBCOMMANDS = Object.freeze(Object.keys(SPECS));

/** The subcommands that approve a gate or weaken one, which run only for a
 * person at an interactive terminal. */
export const TERMINAL_ONLY = Object.freeze(['approve', 'wrong', 'demote', 'retire', 'policy set', 'policy clear']);

/** The subcommands that write to this machine's data directory. */
export const WRITES = new Set(['draft', 'replay', 'tick', ...TERMINAL_ONLY]);

const VALUE_FLAGS = new Set(LEARN_SUBCOMMANDS.flatMap(name => SPECS[name].flags).filter(f => f !== '--json'));
const BOOLEAN_FLAGS = new Set(['--json', '--help']);

const DRAFT_MAX_BYTES = 65_536;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const codeOf = error => (typeof error?.code === 'string' ? error.code : 'unknown error');

/**
 * Splits argv into positionals, the value of each flag that takes one,
 * boolean flags, unknown flags, and what is wrong with the flags given: a
 * value flag with no value after it, or one given twice.
 */
export function parseLearnArgv(argv) {
  const positionals = [];
  const values = new Map();
  const flags = new Set();
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        problems.push(`${arg} needs a value`);
        continue;
      }
      i++;
      if (values.has(arg)) problems.push(`${arg} is given more than once`);
      else values.set(arg, value);
    } else {
      flags.add(arg);
    }
  }
  return { positionals, values, flags, problems, unknown: [...flags].filter(f => !BOOLEAN_FLAGS.has(f)) };
}

/** The subcommand name the positionals after the path spell, `policy`'s
 * two words joined, and the positionals after it. */
function nameOf(positionals) {
  const [, first, second] = positionals;
  if (first === 'policy') return { name: second === undefined ? 'policy' : `policy ${second}`, rest: positionals.slice(3) };
  return { name: first, rest: positionals.slice(2) };
}

/** The subcommand `--help` was asked about, or null for the whole usage. */
export function helpName(positionals) {
  const { name } = nameOf(positionals);
  return Object.hasOwn(SPECS, name ?? '') ? name : null;
}

/**
 * What the command line asks for: `{ target, name, args, values, json,
 * ignored }`, `ignored` the flags given that this subcommand does not own,
 * or `{ error }`.
 */
export function resolveCommand({ positionals, values, flags, problems }) {
  const target = positionals[0];
  const { name, rest } = nameOf(positionals);
  if (target === undefined || name === undefined) return { error: 'a repository path and a subcommand are required' };
  if (!Object.hasOwn(SPECS, name)) {
    return { error: name.startsWith('policy') ? `unknown subcommand: ${name} (policy takes show, set or clear)` : `unknown subcommand: ${name}` };
  }
  const spec = SPECS[name];
  if (rest.length < spec.args.length) return { error: `${name} needs ${spec.args.join(' ')}` };
  if (rest.length > spec.args.length) return { error: `unexpected argument(s): ${rest.join(' ')}` };
  if (problems.length > 0) return { error: problems.join('; ') };
  const missing = (spec.required ?? []).filter(f => !values.has(f));
  if (missing.length > 0) return { error: `${name} needs ${missing.map(f => `${f} <value>`).join(' ')}` };
  const given = [...values.keys(), ...[...flags].filter(f => f === '--json')];
  return {
    target, name, args: rest, values,
    json: flags.has('--json') && spec.flags.includes('--json'),
    ignored: given.filter(f => !spec.flags.includes(f)).map(f => ({ flag: f, owners: LEARN_SUBCOMMANDS.filter(n => SPECS[n].flags.includes(f)) })),
  };
}

/** `{ sessionId, line }` from `<session>:<line>`, or null when it is not
 * that shape; the library checks the session id. */
export function parseFiringRef(text) {
  const at = text.lastIndexOf(':');
  if (at <= 0 || !/^[1-9][0-9]*$/.test(text.slice(at + 1))) return null;
  return { sessionId: text.slice(0, at), line: Number(text.slice(at + 1)) };
}

/** The policy the flags of `policy set` spell; the library checks it. */
export function policyFrom(values) {
  const count = v => (/^[0-9]+$/.test(v) ? Number(v) : v);
  return { minTrialFirings: count(values.get('--min-firings')), minTrialSessions: count(values.get('--min-sessions')), maxAction: values.get('--max-action') };
}

// --- What may be printed ----------------------------------------------------

/** `text` with every code point outside printable ASCII written as
 * `\u{…}`. */
export const showCodePoints = text => text.replace(/[^\x20-\x7e]/gu, c => `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`);

/** A value as JSON on one line, every code point outside printable ASCII
 * written as `\u{…}`. */
export const visible = value => showCodePoints(JSON.stringify(value) ?? 'null');

/** `value` as JSON for `--json`: valid JSON that parses back to `value`,
 * with every character outside printable ASCII escaped. Line breaks outside
 * strings are formatting; inside one JSON already escapes them. */
export const asciiJson = value => JSON.stringify(value, null, 2).replace(/[^\n\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const plain = v => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : visible(v));
const VERDICTS = new Set(['pass', 'fail', 'not-checkable']);
const verdict = v => (VERDICTS.has(v) ? v : visible(v));
const time = v => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : visible(v));
const ids = list => (list.length === 0 ? 'none' : list.map(id => (/^[A-Za-z0-9 ]+$/.test(id) ? id : visible(id))).join(', '));
const indent = lines => lines.map(l => `  ${l}`);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const repairedNote = result => (result.repairedGates?.length > 0 ? `the local gate set was first brought into line with the ledger: ${ids(result.repairedGates)}` : null);

/** The one line a step the library refused or could not finish ends with. */
export function failureLine(name, result) {
  const repaired = repairedNote(result);
  return `${name}: ${showCodePoints(result.error)}${repaired === null ? '' : `; ${repaired}`}`;
}

/** The one line a terminal-only subcommand ends with when no person is at
 * an interactive terminal; `result` is the library's refusal. */
export function terminalRefusal(name, interactive, result) {
  const repaired = repairedNote(result);
  return `${name} refused: ${interactive.reason}; it needs a person at an interactive terminal outside Claude Code, and ${repaired === null ? 'nothing was changed' : repaired}.`;
}

const withRepairs = (result, lines) => {
  const repaired = repairedNote(result);
  return [...lines, ...(repaired === null ? [] : [repaired])].join('\n');
};

// --- candidates -------------------------------------------------------------

/**
 * `log report`'s view of the log, its groups narrowed to the recurrences no
 * learning stands for, with whether the ledger could be read and which
 * learning files do not read back, since either can hide a learning that
 * stands.
 */
export function candidatesView(root) {
  const report = buildLogReport(root);
  const state = readState(root);
  const unclaimed = r => standingFor(state, r.signature) === null;
  const groups = report.groups === null ? null
    : report.groups.map(g => ({ ...g, recurrences: g.recurrences.filter(unclaimed) })).filter(g => g.recurrences.length > 0);
  const { gates, ledger, notClaimed, ...read } = report;
  return { ...read, groups, ledgerIntact: state.view.intact, learningsUnreadable: state.unreadable };
}

export function renderCandidates(view) {
  if (!view.exists) return noLogLine(view);
  if (view.sessionsUnlistable) return ['CANDIDATES', ...indent([`location: ${view.location}`, `sessions: ${NOT_READ}`])].join('\n');
  const notes = [
    ...(view.ledgerIntact ? [] : ['the ledger cannot be read or its chain is broken, so a learning only the ledger still names is not seen here, and draft refuses until it is mended']),
    ...(view.learningsUnreadable.length > 0 ? [`learning files that do not read back, which may stand for any of these: ${ids(view.learningsUnreadable)}; draft refuses until each is mended or removed`] : []),
  ];
  return [
    'CANDIDATES',
    ...indent([...readCountLines(view), ...notes]),
    '',
    ...recurrenceSection(view, 'RECURRENCES NO LEARNING STANDS FOR (each may be drafted)'),
  ].join('\n');
}

// --- draft ------------------------------------------------------------------

/** `{ draft }`, the JSON object in the file at `path`, or `{ error }`, which
 * names the path and never the file's content. */
export function readDraft(path) {
  const named = showCodePoints(path);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { error: `the draft file ${named} could not be read (${codeOf(error)}); nothing was written` };
  }
  if (bytes.length > DRAFT_MAX_BYTES) return { error: `the draft file ${named} is larger than ${DRAFT_MAX_BYTES} bytes; nothing was written` };
  let draft;
  try {
    draft = JSON.parse(utf8.decode(bytes));
  } catch {
    return { error: `the draft file ${named} is not valid JSON in UTF-8; nothing was written` };
  }
  if (!isPlainObject(draft)) return { error: `the draft file ${named} is not a JSON object; nothing was written` };
  return { draft };
}

const STATUS_AFTER_REPLAY = {
  trial: () => "status: trial; its gate is in this machine's local gate set at observe, where it blocks nothing. Show it, then approve it at a terminal, to promote it",
  rejected: () => 'status: rejected; its gate is not used, and the recurrence may be drafted again',
  candidate: id => `status: candidate; it stays one: run \`replay ${id}\` once the log holds more history`,
};

/** A replay's verdict and the status it left the learning `id` in. */
const replayLines = (id, trial) => [`replay: ${trial.replay.verdict}: ${visible(trial.replay.reason)}`, STATUS_AFTER_REPLAY[trial.status](id)];

/** Each stage of a draft: the candidate stored, then the replay's verdict
 * and the status it left, or nothing more when the replay could not run. */
export function renderDraft(drafted, trial) {
  const { learning } = drafted;
  const lines = [`draft: stored as ${learning.id}, a candidate; gate sha256 ${learning.sha256}`];
  if (trial.error !== undefined) return withRepairs(drafted, lines);
  lines.push(...replayLines(learning.id, trial));
  return withRepairs({ repairedGates: [...(drafted.repairedGates ?? []), ...(trial.repairedGates ?? [])] }, lines);
}

/** What replaying the candidate `id` again came to. */
export const renderReplay = (id, trial) => withRepairs(trial, replayLines(id, trial));

// --- list -------------------------------------------------------------------

/** What `list` shows of `listLearnings`' result: everything it reports
 * beside the learnings, and each learning without the harness it was
 * drafted under. */
export function listView(listed) {
  const mismatch = new Set(listed.ledgerMismatch);
  const { learnings, ...beside } = listed;
  return {
    ...beside,
    learnings: learnings.map(l => ({
      id: l.id, status: l.status, vouched: !mismatch.has(l.id), action: l.gate.action, sha256: l.sha256,
      signature: l.signature, failureId: l.failureId, external: l.external, title: l.title, why: l.why,
      replayVerdict: l.replay?.verdict ?? null,
    })),
  };
}

export function renderList(view) {
  const out = [];
  if (!view.ledgerIntact) {
    out.push('The ledger cannot be read or its chain is broken: it vouches for no status below, and the next step that writes removes every learned gate from the local gate set. `log status` says where the chain breaks.', '');
  }
  out.push('LEARNINGS');
  if (view.learnings.length === 0) out.push('  none');
  for (const l of view.learnings) {
    out.push(`  ${l.id}  ${l.status}  ${l.action}  sha256 ${l.sha256}${l.vouched ? '' : '  (the ledger does not vouch for this)'}`);
    out.push(`      title: ${visible(l.title)}`);
    out.push(`      replay: ${l.replayVerdict === null ? 'not yet' : verdict(l.replayVerdict)}`);
  }
  out.push('', 'LEDGER', ...indent([
    `learnings and ledger entries that disagree: ${ids(view.ledgerMismatch)}`,
    `learning files that do not read back as a learning: ${ids(view.unreadable)}`,
    `approvals: ${view.approvals.length === 0 ? 'none' : ''}`.trimEnd(),
    ...view.approvals.map(a => `  ${a.id} sha256 ${a.sha256} at ${a.action}, approved by ${a.approvedBy} at ${time(a.ts)}`),
  ]));
  out.push('', 'LOCAL GATES', ...indent(view.gatesToRepair === null
    ? ['the local gate file is not a gate file, so its entries could not be checked; tick rewrites it while the ledger is intact']
    : [
      `entries the next step that writes removes, replaces or restores: ${ids(view.gatesToRepair)}`,
      `entries above observe that no approval grants: ${ids(view.unapprovedGates)}`,
    ]));
  out.push(`  enforcing learnings whose cited paths are all gone, in force until retired at a terminal: ${ids(view.citationsGone)}`);
  return out.join('\n');
}

// --- show -------------------------------------------------------------------

/**
 * One learning as `show` and `approve` print it, read afresh: its gate and
 * hash, whether the ledger vouches for it and why not, its replay and its
 * stats; or `{ error }`. Reads only.
 */
export function showView(root, id) {
  if (!isId(id)) return { error: ID_ERROR };
  const state = readState(root);
  const found = learningIn(state, id);
  if (found.error) return found;
  const { learning } = found;
  const unvouched = unrecordedReason(learning, state.view);
  const stats = learningStats(root, id);
  return {
    id, status: learning.status, vouched: unvouched === null, unvouchedBecause: unvouched,
    title: learning.title, why: learning.why, signature: learning.signature, failureId: learning.failureId,
    external: learning.external, evidence: learning.evidence,
    gate: learning.gate, gateSha256: learning.sha256, replay: learning.replay,
    stats: stats.error === undefined ? stats : null, statsError: stats.error ?? null,
  };
}

function statsLine(view) {
  if (view.stats === null) return `stats: not available: ${showCodePoints(view.statsError)}`;
  const s = view.stats;
  const unreadable = s.sessionsUnreadable > 0 ? `; sessions read only in part: ${s.sessionsUnreadable}` : '';
  return `stats: fired ${plural(s.firings, 'time')} in ${plural(s.sessions, 'session')}; rerouted: ${s.rerouted}; marked wrong: ${s.wrong} since the last promotion, ${s.wrongTotal} in all${unreadable}`;
}

export function renderShow(view) {
  const e = isPlainObject(view.evidence) ? view.evidence : {};
  const gate = JSON.stringify(view.gate, null, 2).split('\n').map(l => `    ${showCodePoints(l)}`);
  return [
    `LEARNING ${view.id}`,
    ...indent([
      `status: ${view.status}; ${view.vouched ? 'the ledger vouches for it' : `the ledger does not vouch for it: ${showCodePoints(view.unvouchedBecause)}`}`,
      `title: ${visible(view.title)}`,
      `why: ${visible(view.why)}`,
      `signature: ${view.signature}; failure kind: ${view.failureId === null ? 'none' : visible(view.failureId)}`,
      `evidence: in ${plain(e.sessions)} sessions, from ${time(e.firstTs)} to ${time(e.lastTs)}${view.external ? '; a contributing session read outside content (web or MCP)' : ''}`,
      `gateSha256: ${view.gateSha256}`,
      'gate, as JSON with every code point outside printable ASCII written as \\u{...}:',
    ]),
    ...gate,
    ...indent([
      view.replay === null ? 'replay: not yet' : `replay: ${verdict(view.replay.verdict)}: ${visible(view.replay.reason)}`,
      statsLine(view),
      ...(view.stats === null ? [] : [`  ${REROUTED_MEANS}`]),
    ]),
  ].join('\n');
}

// --- the steps a person takes at a terminal -----------------------------------

export const renderApproved = (result, sha256) => withRepairs(result, [
  `${result.id} approved at ${result.action} on this machine; the ledger records the owner's approval of sha256 ${sha256}.`,
]);

export const renderWrong = (result, ref) => withRepairs(result, [
  `firing ${ref.sessionId}:${ref.line} of ${result.id} marked wrong: ${result.wrong} since its last promotion; ${result.id} is ${result.status}.`,
]);

export const renderDemoted = result => withRepairs(result, [result.status === 'suspended'
  ? `${result.id} suspended: its committed gate is switched off on this machine, and a suspension is final.`
  : `${result.id} demoted: back to trial, its gate at observe on this machine.`]);

export const renderRetired = result => withRepairs(result, [
  `${result.id} retired: its local gate is gone, and it no longer stands for its recurrence.`,
]);

export const renderPolicySet = (result, policy) => withRepairs(result, [
  `policy set: sha256 ${result.sha256}, recorded in the ledger as the policy in force.`,
  `tick now promotes each fresh trial with at least ${plural(policy.minTrialFirings, 'firing')} in ${plural(policy.minTrialSessions, 'session')}, none marked wrong and none read from outside content, up to ${policy.maxAction}, on this machine only.`,
]);

export const renderPolicyCleared = result => withRepairs(result, [
  'policy withdrawn, and recorded in the ledger: tick promotes nothing until a policy is set again.',
  ...(result.policyFileRemoved ? [] : [showCodePoints(result.note)]),
]);

// --- policy show --------------------------------------------------------------

/** The policy file, the policy the ledger records as in force, and whether
 * they are the same, which is when `tick` promotes under it. Reads only. */
export function policyView(root) {
  const file = readPolicy(root);
  const ledgerIntact = verifyLedger(root).intact;
  const entries = ledgerIntact ? readLedger(root) : [];
  const recordedSha256 = recordedPolicySha256(entries);
  let recorded = 'unknown';
  if (ledgerIntact) recorded = !entries.some(e => e?.kind === 'policy') ? 'never-set' : recordedSha256 === null ? 'withdrawn' : 'set';
  return { file, ledgerIntact, recorded, recordedSha256, inForce: ledgerIntact && file.state === 'ok' && file.sha256 === recordedSha256 };
}

function policyFileLine({ file }) {
  if (file.state === 'absent') return 'file: no policy file';
  if (file.state === 'unreadable') return `file: cannot be used: ${showCodePoints(file.reason)}`;
  const p = file.policy;
  return `file: at least ${plural(p.minTrialFirings, 'trial firing')} in ${plural(p.minTrialSessions, 'session')}, up to ${p.maxAction}; sha256 ${file.sha256}`;
}

const RECORDED_LINES = {
  unknown: 'ledger: cannot be read or its chain is broken, so it vouches for no policy',
  'never-set': 'ledger: records no policy',
  withdrawn: 'ledger: records the policy as withdrawn',
};

function policyTickLine(view) {
  const { file } = view;
  if (view.inForce) {
    const p = file.policy;
    return `tick promotes each fresh trial with at least ${plural(p.minTrialFirings, 'firing')} in ${plural(p.minTrialSessions, 'session')}, none marked wrong and none read from outside content, up to ${p.maxAction}, on this machine only`;
  }
  if (!view.ledgerIntact) return 'tick promotes nothing, since the ledger cannot vouch for a policy';
  if (file.state === 'ok') return 'the file is not the policy in force, which only policy set at a terminal records, so tick promotes nothing';
  return 'tick promotes nothing';
}

export function renderPolicy(view) {
  return ['POLICY', ...indent([
    policyFileLine(view),
    view.recorded === 'set' ? `ledger: records sha256 ${view.recordedSha256} as the policy in force` : RECORDED_LINES[view.recorded],
    policyTickLine(view),
  ])].join('\n');
}

// --- tick ---------------------------------------------------------------------

export function renderTick(result) {
  return [
    'TICK',
    ...indent([
      `promoted: ${ids(result.promoted)}`,
      `demoted, back to trial with the gate at observe: ${ids(result.demoted)}`,
      `suspended, a committed gate switched off on this machine: ${ids(result.suspended)}`,
      `retired, every cited path gone: ${ids(result.retired)}`,
      `local gates no approval granted, removed: ${ids(result.unapprovedRemoved)}`,
      `local gate entries brought into line with the ledger: ${ids(result.repairedGates)}`,
      `local gate file rewritten, as it was not a gate file: ${result.gateFileRewritten ? 'yes' : 'no'}`,
      `enforcing learnings whose cited paths are all gone, in force until retired at a terminal: ${ids(result.citationsGone)}`,
      `ledger: ${result.ledgerIntact ? 'intact' : 'cannot be read or its chain is broken'}`,
      `policy: ${result.policy}; the policy file is not the one in force: ${result.policyUnrecorded ? 'yes' : 'no'}`,
    ]),
    'NOT DONE',
    ...indent(result.errors.length === 0 ? ['nothing'] : result.errors.map(showCodePoints)),
  ].join('\n');
}
