// scripts/lib/log-lib.mjs
//
// The `log` command's reads: whether the session-log hook is registered,
// whether this repository's data directory is safe to write, what the log
// holds and whether it can be trusted, and turning the log on and off.
// Nothing here returns or renders a logged event's content or any string
// read from a transcript: only counts, times, sizes, session ids and the
// kit's own file names leave this module.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import {
  dataRoot, isEnabled, LINK_REFUSED, readConfig, readEvents, repoDataDir, sessionFileName, SESSIONS_DIR, setEnabled,
} from '../../assets/scripts/harness-log.mjs';
import { contentFieldsOf, SEALED_SUFFIX, untrustedBecause, verifyIndex } from '../../assets/scripts/harness-seal.mjs';
import { LOGGED_EVENTS } from '../../assets/scripts/session-log.mjs';
import { readLedger, verifyLedger } from './ledger.mjs';
import { readJsonFile } from './read-json.mjs';
import { listSessions } from './recurrence.mjs';
import { hookPathTokens } from './settings-merge.mjs';
import { summariseTranscripts } from './transcript-reader.mjs';

/** The hook script that writes the log, as a hook entry names it. */
export const SESSION_LOG_SCRIPT = '.claude/scripts/session-log.mjs';

const SETTINGS_PATH = '.claude/settings.json';

/** What no hook observes, whatever the log holds. An interrupt while a tool
 * runs is not among them: the failure event carries it, and the hook
 * records the call as interrupted. */
export const BLIND_SPOTS = Object.freeze([
  'an interrupt between tool calls (one while a tool runs is recorded, as an interrupted call)',
  'cancelled tools',
  'permission denials outside auto mode',
]);

const DAY_MS = 86_400_000;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const timeOf = v => (typeof v === 'string' ? Date.parse(v) : Number.NaN);
const codeOf = error => error?.code ?? 'unknown error';

/** Thrown when the data directory stops being safe to write between the
 * plan and the write; the CLI refuses (exit 3). */
export class DataDirRefused extends Error {}

/**
 * Whether this repository's data directory may be written or removed:
 * `'absent'`, `'refused'` with the reason, or `'ok'`. It must be a
 * directory, not a link, whose real path is directly inside the data
 * root's real path and is not the data root itself. Never throws.
 */
export function checkDataDir(root) {
  const dir = repoDataDir(root);
  const refused = reason => ({ state: 'refused', dir, reason });
  let st;
  try {
    st = lstatSync(dir);
  } catch (error) {
    return error?.code === 'ENOENT' ? { state: 'absent', dir } : refused(`it cannot be examined (${codeOf(error)})`);
  }
  if (st.isSymbolicLink()) return refused('it is a link, so a write or removal would act on what it points at');
  if (!st.isDirectory()) return refused('it is not a directory');
  let realDir;
  let realRoot;
  try {
    realDir = realpathSync.native(dir);
    realRoot = realpathSync.native(dataRoot());
  } catch (error) {
    return refused(`its real location cannot be resolved (${codeOf(error)})`);
  }
  const rel = relative(realRoot, realDir);
  if (rel === '') return refused(`it is the data root ${realRoot} itself`);
  if (isAbsolute(rel) || rel.startsWith('..') || /[\\/]/.test(rel)) return refused(`it is not directly inside the data root ${realRoot}`);
  return { state: 'ok', dir };
}

/** Throws `DataDirRefused` unless the data directory is safe to write now,
 * or absent when `absentOk`. */
export function assertDataDirSafe(root, { absentOk = false } = {}) {
  const check = checkDataDir(root);
  if (check.state === 'ok' || (absentOk && check.state === 'absent')) return;
  throw new DataDirRefused(`refusing to write to ${check.dir}: ${check.state === 'absent' ? 'it no longer exists' : check.reason}`);
}

/** Records whether the log is enabled. Throws `DataDirRefused`, writing
 * nothing, when the data directory or the record itself is a link. */
export function recordEnabled(root, enabled) {
  try {
    setEnabled(root, enabled);
  } catch (error) {
    if (error?.code === LINK_REFUSED) throw new DataDirRefused(`refusing to write to ${repoDataDir(root)}: ${error.message}`);
    throw error;
  }
}

/**
 * On how many of the events the logging hook records
 * `.claude/settings.json` registers a hook that runs `SESSION_LOG_SCRIPT`,
 * in exec or shell form: `{ registered, events, problem }`. `events` is
 * `{ registered, logged }`, the count and the number of `LOGGED_EVENTS`;
 * `registered` is true only when they are equal, since an event the hook is
 * not registered on is not recorded. Both are null when the file is present
 * but cannot be read, and `problem` says why. Which matcher each
 * registration carries is `detect`'s to judge.
 */
export function hookRegistration(root) {
  const none = { registered: false, events: { registered: 0, logged: LOGGED_EVENTS.length }, problem: null };
  const read = readJsonFile(join(root, SETTINGS_PATH));
  if (read.state === 'absent') return none;
  if (read.state === 'unreadable') return { registered: null, events: null, problem: `${SETTINGS_PATH} ${read.reason}` };
  const hooks = isPlainObject(read.value) ? read.value.hooks : undefined;
  if (!isPlainObject(hooks)) return none;
  const runsScript = entry => hookPathTokens(entry).includes(SESSION_LOG_SCRIPT);
  const count = LOGGED_EVENTS.filter(event => Array.isArray(hooks[event])
    && hooks[event].some(m => Array.isArray(m?.hooks) && m.hooks.some(runsScript))).length;
  return { registered: count === LOGGED_EVENTS.length, events: { registered: count, logged: LOGGED_EVENTS.length }, problem: null };
}

/** The bytes of every file under `dir`, each link counted as itself and
 * never followed, and how many entries could not be read. */
export function diskUsage(dir) {
  let bytes = 0;
  let unreadable = 0;
  const walk = path => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      unreadable++;
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        bytes += lstatSync(full).size;
      } catch {
        unreadable++;
      }
    }
  };
  walk(dir);
  return { bytes, unreadable };
}

export const sessionsDir = root => join(repoDataDir(root), SESSIONS_DIR);

/** Only a transcript path that is absolute and names a regular file is
 * read: the path comes from the log, which anyone with this user's access
 * can edit, and a device or pipe would block the read. */
function isReadableTranscript(path) {
  if (!isAbsolute(path)) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** The kinds of session `status` counts as holding content past the
 * retention period, by what stands between the content and its removal. */
const PAST_RETENTION_REASONS = Object.freeze(['notSealed', 'awaitingMaintenance', 'unverifiable', 'unreadable']);

/** The newest modification time among a session's sealed and plain files,
 * or NaN when neither can be examined. */
function newestFileTime(root, id) {
  const plain = join(sessionsDir(root), sessionFileName(id));
  const times = [plain, `${plain}${SEALED_SUFFIX}`].map(path => {
    try {
      return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Number.NaN;
    } catch {
      return Number.NaN;
    }
  }).filter(t => !Number.isNaN(t));
  return times.length === 0 ? Number.NaN : Math.max(...times);
}

/**
 * Where a session stands against the retention period: one of
 * `PAST_RETENTION_REASONS` when it holds content and its last event is
 * older than `cutoff`, `'withoutTime'` when it holds content and no event of
 * it carries a time, so that retention never judges it past the period, and
 * null otherwise. A session that could not be read in full is judged by its
 * newest file's age, since what it holds cannot be told; a line that does
 * not parse may hold content, so it counts as content. `isUnverifiable`
 * says whether a sealed file is one retention leaves in place.
 */
function retentionStanding(root, session, { events, unparseable, unreadable }, cutoff, isUnverifiable) {
  if (unreadable) return newestFileTime(root, session.id) < cutoff ? 'unreadable' : null;
  const holdsContent = unparseable > 0 || events.some(event => contentFieldsOf(event.type).some(f => Object.hasOwn(event, f)));
  if (!holdsContent) return null;
  let last = Number.NaN;
  for (const event of events) {
    const at = timeOf(event.ts);
    if (!Number.isNaN(at) && !(at <= last)) last = at;
  }
  if (Number.isNaN(last)) return 'withoutTime';
  if (!(last < cutoff)) return null;
  if (session.sealed && isUnverifiable(session.id)) return 'unverifiable';
  return session.unsealed ? 'notSealed' : 'awaitingMaintenance';
}

/** What reading every session's events finds: its date range, the lines and
 * sessions that could not be read, the sessions larger than is read, each
 * session's transcript path, and how many sessions stand where against the
 * retention period (`retentionStanding`). */
function readSessions(root, sessions, cutoff, isUnverifiable) {
  let first = Number.NaN;
  let last = Number.NaN;
  let unparseableLines = 0;
  let unreadableSessions = 0;
  let withoutTranscript = 0;
  let contentWithoutTime = 0;
  const overLimit = [];
  const transcriptPaths = new Set();
  const pastRetention = Object.fromEntries(PAST_RETENTION_REASONS.map(reason => [reason, 0]));
  for (const session of sessions) {
    const read = readEvents(root, session.id);
    unparseableLines += read.unparseable;
    if (read.unreadable) unreadableSessions++;
    if (read.overLimit) overLimit.push(session.id);
    let hasTranscript = false;
    for (const event of read.events) {
      const at = timeOf(event.ts);
      if (!Number.isNaN(at)) {
        if (!(at >= first)) first = at;
        if (!(at <= last)) last = at;
      }
      if (event.type === 'SessionStart' && typeof event.transcriptPath === 'string' && event.transcriptPath.length > 0) {
        transcriptPaths.add(event.transcriptPath);
        hasTranscript = true;
      }
    }
    if (!hasTranscript) withoutTranscript++;
    const standing = retentionStanding(root, session, read, cutoff, isUnverifiable);
    if (standing === 'withoutTime') contentWithoutTime++;
    else if (standing !== null) pastRetention[standing]++;
  }
  const iso = t => (Number.isNaN(t) ? null : new Date(t).toISOString());
  return {
    firstTs: iso(first),
    lastTs: iso(last),
    unparseableLines,
    unreadableSessions,
    overLimit,
    withoutTranscript,
    transcriptPaths: [...transcriptPaths],
    contentPastRetention: { sessions: PAST_RETENTION_REASONS.reduce((n, reason) => n + pastRetention[reason], 0), ...pastRetention },
    contentWithoutTime,
  };
}

/** Coverage from the transcripts the sessions name. Strings read from a
 * transcript never leave this function: unknown line types are counted. */
function transcriptCoverage(paths, withoutTranscript) {
  const readable = paths.filter(isReadableTranscript);
  const { checked, notChecked, interrupts, unknownLineTypes } = summariseTranscripts(readable);
  return { checked, notChecked, interrupts, unknownLineTypes: unknownLineTypes.length, skipped: paths.length - readable.length, sessionsWithoutTranscript: withoutTranscript };
}

/**
 * What this repository's log on this machine holds and whether it can be
 * trusted, from reads alone: nothing is written, not even the sweep's
 * verification record. `index` is `verifyIndex`'s result, which covers
 * `sealedSessions` and not the events of the `unsealedSessions`;
 * `blobSweep` says whether the next sweep would remove nothing, and why;
 * `contentPastRetention` counts the sessions that hold content though their
 * last event is older than the retention period, in all and by what stands
 * in the way, and `contentWithoutTime` those whose content never expires
 * because no event of theirs carries a time. When the sessions directory
 * cannot be listed, every count read from it is null.
 */
export function logStatus(root) {
  const location = repoDataDir(root);
  const exists = checkDataDir(root).state !== 'absent';
  const config = readConfig(root);
  const hook = hookRegistration(root);
  let sessions = null;
  try {
    sessions = listSessions(root);
  } catch {
    // reported as not read
  }
  const listed = sessions !== null;
  const index = verifyIndex(root);
  const untrusted = untrustedBecause(index);
  const altered = new Set(index.sessionsAltered);
  const cutoff = Date.now() - config.contentRetentionDays * DAY_MS;
  const read = readSessions(root, sessions ?? [], cutoff, id => index.unreadable || altered.has(id));
  const usage = exists ? diskUsage(location) : { bytes: 0, unreadable: 0 };
  const ledger = verifyLedger(root);
  const whenListed = value => (listed ? value : null);
  return {
    enabled: isEnabled(root),
    exists,
    location,
    bytes: usage.bytes,
    unreadableEntries: usage.unreadable,
    sessions: whenListed(sessions?.length),
    sessionsUnlistable: !listed,
    sealedSessions: whenListed(sessions?.filter(session => session.sealed).length),
    unsealedSessions: whenListed(sessions?.filter(session => session.unsealed).length),
    sessionsBeingSealed: whenListed(sessions?.filter(session => session.beingSealed).length),
    sessionsOverLimit: whenListed(read.overLimit),
    firstTs: read.firstTs,
    lastTs: read.lastTs,
    index,
    ledger,
    ledgerEntries: ledger.intact ? readLedger(root).length : null,
    unparseableLines: whenListed(read.unparseableLines),
    unreadableSessions: whenListed(read.unreadableSessions),
    hookRegistered: hook.registered,
    hookEvents: hook.events,
    settingsProblem: hook.problem,
    retentionDays: config.contentRetentionDays,
    configUnreadable: config.configUnreadable === true,
    contentPastRetention: whenListed(read.contentPastRetention),
    contentWithoutTime: whenListed(read.contentWithoutTime),
    blobSweep: { skipped: untrusted !== null, reason: untrusted },
    transcripts: whenListed(transcriptCoverage(read.transcriptPaths, read.withoutTranscript)),
    blindSpots: [...BLIND_SPOTS],
  };
}

export const formatBytes = n => {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024;
  return `${value.toFixed(1)} ${units[unit]} (${n} bytes)`;
};

/** Where the hook is registered, as a clause: on all the logged events, on
 * some, on none, or not known. */
function hookClause(events, problem) {
  if (events === null) return `${problem}: whether the hook is registered could not be told`;
  if (events.registered === 0) return `the hook is not registered in ${SETTINGS_PATH}`;
  const on = events.registered === events.logged ? `all ${events.logged}` : `${events.registered} of the ${events.logged}`;
  return `the hook is registered on ${on} logged events in ${SETTINGS_PATH}`;
}

function ledgerLine(s) {
  if (!s.ledger.intact) return `ledger: broken at line ${s.ledger.brokenAt}`;
  return s.ledgerEntries === 0 ? 'ledger: no entry yet, so there is no chain to check' : `ledger: intact; the chain of its ${s.ledgerEntries} entries is unbroken`;
}

function indexLines(s) {
  const { index } = s;
  if (index.unreadable) return ['index: could not be read, so no sealed session was verified'];
  if (s.sessionsUnlistable) {
    const chain = index.brokenAt === null ? 'its chain is unbroken' : `its chain is broken at line ${index.brokenAt}`;
    return [`index: ${chain}, but the sessions directory could not be listed, so no sealed session was verified`];
  }
  const lines = [];
  if (index.intact) {
    const unsealed = s.unsealedSessions > 0 ? `; events not yet sealed, in ${s.unsealedSessions} sessions, are not checked` : '';
    lines.push(s.sealedSessions === 0
      ? `index: intact, but no session is sealed yet, so nothing has been verified${unsealed}`
      : `index: intact; the chain is unbroken and each of the ${s.sealedSessions} sealed sessions matches it${unsealed}`);
  } else {
    lines.push('index: not intact');
    if (index.brokenAt !== null) lines.push(`  chain broken at line ${index.brokenAt}`);
    if (index.sessionsAltered.length > 0) lines.push(`  altered: ${index.sessionsAltered.join(', ')}`);
    if (index.sessionsMissing.length > 0) lines.push(`  missing: ${index.sessionsMissing.join(', ')}`);
  }
  if (index.sessionsPending.length > 0) {
    lines.push(`pending: ${index.sessionsPending.join(', ')}`);
    lines.push('  a seal stopped after writing its index line; the next maintenance run finishes it, and it is not damage');
  }
  if (index.tornTail) lines.push('the index ends in an unfinished line, left by an interrupted append; the next maintenance run removes it, and it is not damage');
  return lines;
}

const indent = lines => lines.map(l => `  ${l}`);
const NOT_READ = 'not read, because the sessions directory could not be listed';
const countOf = n => (n === null ? NOT_READ : String(n));

function transcriptLines(t) {
  if (t === null) return [`transcripts: ${NOT_READ}`];
  return [
    `checked: ${t.checked}, not checked: ${t.notChecked}, interrupts found: ${t.interrupts}`,
    `sessions with no transcript recorded: ${t.sessionsWithoutTranscript}`,
    ...(t.skipped > 0 ? [`paths skipped, not absolute or not a regular file: ${t.skipped}`] : []),
    ...(t.unknownLineTypes > 0 ? [`unknown line types seen: ${t.unknownLineTypes}`] : []),
    'a transcript still being written can end in a half-written line, and one since moved or deleted cannot be read;',
    'either reads as not checked, which is not damage',
  ];
}

const PAST_RETENTION_TEXT = {
  notSealed: 'not yet sealed, which `maintain` seals and then expires',
  awaitingMaintenance: 'sealed, waiting for a session start or `maintain`',
  unverifiable: 'kept, because the sealed file does not match the index or the index cannot be read',
  unreadable: "unreadable, judged by the file's age",
};

function pastRetentionLines(s) {
  const past = s.contentPastRetention;
  if (past === null) return [`sessions holding content past the period: ${NOT_READ}`];
  return [
    `sessions holding content past the period: ${past.sessions}`,
    ...PAST_RETENTION_REASONS.filter(reason => past[reason] > 0).map(reason => `  ${PAST_RETENTION_TEXT[reason]}: ${past[reason]}`),
    ...(s.contentWithoutTime > 0 ? [`sessions holding content whose events carry no time, which never expire: ${s.contentWithoutTime}`] : []),
  ];
}

/** The status as text for a person. */
export function renderStatus(s) {
  const out = [];
  if (!s.exists) {
    out.push(`No log for this repository on this machine: ${s.location} does not exist.`);
    out.push(...indent([hookClause(s.hookEvents, s.settingsProblem)]));
  } else {
    out.push('SESSION LOG');
    const size = s.unreadableEntries > 0 ? `${formatBytes(s.bytes)} at least; ${s.unreadableEntries} entries could not be read` : formatBytes(s.bytes);
    const range = s.firstTs === null ? '' : `, from ${s.firstTs} to ${s.lastTs}`;
    out.push(...indent([
      `enabled: ${s.enabled ? 'yes' : 'no'}`,
      `location: ${s.location}`,
      `size on disk: ${size}`,
      s.sessionsUnlistable
        ? `sessions: ${NOT_READ}`
        : `sessions: ${s.sessions}${range}; sealed: ${s.sealedSessions}, with events not yet sealed: ${s.unsealedSessions}`,
      hookClause(s.hookEvents, s.settingsProblem),
    ]));
    out.push('', 'INTEGRITY');
    out.push(...indent([
      ...indexLines(s),
      ledgerLine(s),
      `unparseable lines: ${countOf(s.unparseableLines)}`,
      `unreadable sessions: ${countOf(s.unreadableSessions)}`,
      ...(s.sessionsBeingSealed > 0 ? [`being sealed: ${s.sessionsBeingSealed} sessions have events in a claimed or temporary file, not read here`] : []),
      ...(s.sessionsOverLimit?.length > 0 ? [`sessions larger than this command reads, counted as unreadable and not sealed or expired: ${s.sessionsOverLimit.join(', ')}`] : []),
    ]));
    out.push('', 'RETENTION');
    out.push(...indent([
      `content is removed once a session's last event is ${s.retentionDays} days old: at a session start while the log is enabled, or by \`maintain\`, and only from a session that is sealed and matches the index; structure is kept until the log is purged`,
      ...(s.enabled ? [] : ['the log is disabled, so no session start seals or expires anything; `maintain` still does']),
      ...(s.configUnreadable ? ['config.json beside the log could not be read, so the defaults are in force'] : []),
      ...pastRetentionLines(s),
      s.blobSweep.skipped
        ? `blob sweep: blocked, so content held in blobs is not being expired: ${s.blobSweep.reason}`
        : 'blob sweep: not blocked; every sealed session matches its latest index line',
    ]));
    out.push('', 'TRANSCRIPTS');
    out.push(...indent(transcriptLines(s.transcripts)));
  }
  out.push('', 'WHAT HOOKS CANNOT SEE');
  out.push(...indent(s.blindSpots));
  out.push('  the transcripts that could be checked count interrupts of both kinds, and nothing else listed here');
  return out.join('\n');
}

/** The command line for `args`, the path quoted when it holds a space. */
export const logCommand = (root, ...args) => `node scripts/log.mjs ${/\s/.test(root) ? `"${root}"` : root} ${args.join(' ')}`;

/** Turns the log on and returns what `renderEnable` states. Throws
 * `DataDirRefused`, writing nothing, when the data directory exists and is
 * not safe to write. */
export function enableLog(root) {
  assertDataDirSafe(root, { absentOk: true });
  recordEnabled(root, true);
  return { root, location: repoDataDir(root), hook: hookRegistration(root), config: readConfig(root) };
}

/** The disclosure `enable` prints, in its own output. */
export function renderEnable({ root, location, hook, config }) {
  const clause = hookClause(hook.events, hook.problem);
  const sentence = `${clause[0].toUpperCase()}${clause.slice(1)}`;
  let hookState = `${sentence}.`;
  if (hook.registered === true) hookState = `${sentence}: recording starts with the next event.`;
  else if (hook.events?.registered > 0) hookState = `${sentence}: only those are recorded until \`apply\` registers the rest.`;
  else if (hook.events !== null) hookState = `${sentence} yet: nothing is recorded until \`apply\` installs it.`;
  return [
    `The session log is enabled for ${root} on this machine.`,
    `  kept at: ${location}`,
    '',
    "Once the session-log hook is installed, it records every tool call's input and output for this repository on this machine, with each prompt and session event.",
    hookState,
    '',
    'Credentials are masked before anything is written, on a best-effort basis: some may be missed, so treat the log as able to hold a secret.',
    `Content (prompts, tool input and output) is removed once a session's last event is ${config.contentRetentionDays} days old, but only from a session that has been sealed and still matches the index, and only when a session starts while the log is enabled or \`maintain\` is run; \`status\` counts the sessions past the period and says why. Structure is kept until the log is purged: which tools ran, when, their sizes, hashes and first error lines.`,
    ...(config.configUnreadable ? ['config.json beside the log could not be read, so the defaults are in force.'] : []),
    '',
    `To turn it off:  ${logCommand(root, 'disable')}`,
    `To delete it:    ${logCommand(root, 'purge', '--yes')}`,
  ].join('\n');
}

/** Turns the log off, keeping what it holds; false, writing nothing, when
 * this repository has no log on this machine. Throws `DataDirRefused`,
 * writing nothing, when the directory is not safe to write. */
export function disableLog(root) {
  if (checkDataDir(root).state === 'absent') return false;
  assertDataDirSafe(root);
  recordEnabled(root, false);
  return true;
}

export function renderDisable(root, disabled) {
  if (!disabled) return 'No log for this repository on this machine; nothing to disable.';
  return [
    `The session log is disabled for ${root} on this machine; nothing more is recorded.`,
    `What it holds is kept at ${repoDataDir(root)}.`,
    `To delete it:  ${logCommand(root, 'purge', '--yes')}`,
  ].join('\n');
}
