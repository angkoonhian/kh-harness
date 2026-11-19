// scripts/lib/log-lib.mjs
//
// The `log` command's reads: whether the session-log hook is registered,
// whether this repository's data directory is safe to write, what the log
// holds and whether it can be trusted, and turning the log on and off.
// Nothing here returns or renders a logged event's content or any string
// read from a transcript: only counts, times, sizes, session ids and the
// kit's own file names leave this module.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  dataRoot, isEnabled, parsedObject, readConfig, readEvents, repoDataDir, sessionFileName, SESSIONS_DIR, setEnabled,
} from '../../assets/scripts/harness-log.mjs';
import { CLAIMED_SUFFIX, contentFieldsOf, SEAL_TEMP_SUFFIX, untrustedBecause, verifyIndex } from '../../assets/scripts/harness-seal.mjs';
import { verifyLedger } from './ledger.mjs';
import { readJsonFile } from './read-json.mjs';
import { sessionIds } from './recurrence.mjs';
import { hookPathTokens } from './settings-merge.mjs';
import { summariseTranscripts } from './transcript-reader.mjs';

/** The hook script that writes the log, as a hook entry names it. */
export const SESSION_LOG_SCRIPT = '.claude/scripts/session-log.mjs';

const SETTINGS_PATH = '.claude/settings.json';

/** What no hook observes, whatever the log holds. */
export const BLIND_SPOTS = Object.freeze(['user interrupts', 'cancelled tools', 'permission denials outside auto mode']);

const DAY_MS = 86_400_000;
const PLAIN_SUFFIX = '.jsonl';
const SEALED_SUFFIX = '.jsonl.gz';

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

/**
 * Whether `.claude/settings.json` registers a hook that runs
 * `SESSION_LOG_SCRIPT`, on any event, in exec or shell form. `registered` is
 * null when the file is present but cannot be read, and `problem` says why.
 */
export function hookRegistration(root) {
  const read = readJsonFile(join(root, SETTINGS_PATH));
  if (read.state === 'absent') return { registered: false, problem: null };
  if (read.state === 'unreadable') return { registered: null, problem: `${SETTINGS_PATH} ${read.reason}` };
  const hooks = isPlainObject(read.value) ? read.value.hooks : undefined;
  if (!isPlainObject(hooks)) return { registered: false, problem: null };
  const runsScript = entry => hookPathTokens(entry).includes(SESSION_LOG_SCRIPT);
  const registered = Object.values(hooks).some(matchers => Array.isArray(matchers)
    && matchers.some(m => Array.isArray(m?.hooks) && m.hooks.some(runsScript)));
  return { registered, problem: null };
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

/** The names in the sessions directory; none when it is absent or cannot
 * be listed. */
export function sessionNames(root) {
  try {
    return readdirSync(sessionsDir(root));
  } catch {
    return [];
  }
}

/** The session id a file name in the sessions directory names with
 * `suffix`, or null. */
export function idWithSuffix(name, suffix) {
  if (!name.startsWith('s-') || !name.endsWith(suffix)) return null;
  const id = name.slice(2, -suffix.length);
  return sessionFileName(id) === `s-${id}${PLAIN_SUFFIX}` ? id : null;
}

const idsWithSuffix = (names, suffixes) => {
  const ids = new Set();
  for (const name of names) {
    for (const suffix of suffixes) {
      const id = idWithSuffix(name, suffix);
      if (id !== null) ids.add(id);
    }
  }
  return [...ids].sort();
};

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

/** What reading every session's events finds: its date range, the lines and
 * sessions that could not be read, and each session's transcript path. */
function readSessions(root, ids) {
  let first = Number.NaN;
  let last = Number.NaN;
  let unparseableLines = 0;
  let unreadableSessions = 0;
  let withoutTranscript = 0;
  const transcriptPaths = new Set();
  for (const id of ids) {
    const { events, unparseable, unreadable } = readEvents(root, id);
    unparseableLines += unparseable;
    if (unreadable) unreadableSessions++;
    let hasTranscript = false;
    for (const event of events) {
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
  }
  const iso = t => (Number.isNaN(t) ? null : new Date(t).toISOString());
  return { firstTs: iso(first), lastTs: iso(last), unparseableLines, unreadableSessions, withoutTranscript, transcriptPaths: [...transcriptPaths] };
}

/** Coverage from the transcripts the sessions name. Strings read from a
 * transcript never leave this function: unknown line types are counted. */
function transcriptCoverage(paths, withoutTranscript) {
  const readable = paths.filter(isReadableTranscript);
  const { checked, notChecked, interrupts, unknownLineTypes } = summariseTranscripts(readable);
  return { checked, notChecked, interrupts, unknownLineTypes: unknownLineTypes.length, skipped: paths.length - readable.length, sessionsWithoutTranscript: withoutTranscript };
}

/** Whether a sealed session's content still holds a field retention would
 * remove, and when its last event was; a line that does not parse may hold
 * content, so it counts as content. */
function sealedContentState(bytes) {
  let holdsContent = false;
  let last = Number.NaN;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.length === 0) continue;
    const event = parsedObject(line);
    if (event === null) {
      holdsContent = true;
      continue;
    }
    if (contentFieldsOf(event.type).some(f => Object.hasOwn(event, f))) holdsContent = true;
    const at = timeOf(event.ts);
    if (!(at <= last)) last = at;
  }
  return { holdsContent, last };
}

/** How many of the sealed sessions `ids`, which retention leaves in place
 * because they cannot be verified, still hold content older than `cutoff`.
 * A sealed file that cannot be read is judged by its modification time,
 * since what it holds cannot be told. */
function unverifiedPastRetention(root, ids, cutoff) {
  let count = 0;
  for (const id of ids) {
    const path = join(sessionsDir(root), `${sessionFileName(id)}.gz`);
    const mtimeMs = () => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Number.NaN;
    let state;
    try {
      state = sealedContentState(gunzipSync(readFileSync(path)));
    } catch {
      try {
        if (mtimeMs() < cutoff) count++;
      } catch {
        // unreadable even to stat: its age cannot be told
      }
      continue;
    }
    const last = Number.isNaN(state.last) ? mtimeMs() : state.last;
    if (state.holdsContent && last < cutoff) count++;
  }
  return count;
}

/**
 * What this repository's log on this machine holds and whether it can be
 * trusted, from reads alone: nothing is written, not even the sweep's
 * verification record. `index` is `verifyIndex`'s result, which covers
 * `sealedSessions` and not the events of the `unsealedSessions`;
 * `blobSweep` says whether the next sweep would remove nothing, and why.
 * When the sessions directory cannot be listed, every count read from it is
 * null.
 */
export function logStatus(root) {
  const location = repoDataDir(root);
  const exists = checkDataDir(root).state !== 'absent';
  const config = readConfig(root);
  const hook = hookRegistration(root);
  let ids = null;
  try {
    ids = sessionIds(root);
  } catch {
    // reported as not read
  }
  const listed = ids !== null;
  const names = listed ? sessionNames(root) : [];
  const sealedIds = idsWithSuffix(names, [SEALED_SUFFIX]);
  const read = readSessions(root, ids ?? []);
  const index = verifyIndex(root);
  const untrusted = untrustedBecause(index);
  const usage = exists ? diskUsage(location) : { bytes: 0, unreadable: 0 };
  const cutoff = Date.now() - config.contentRetentionDays * DAY_MS;
  const whenListed = value => (listed ? value : null);
  return {
    enabled: isEnabled(root),
    exists,
    location,
    bytes: usage.bytes,
    unreadableEntries: usage.unreadable,
    sessions: whenListed(ids?.length),
    sessionsUnlistable: !listed,
    sealedSessions: whenListed(sealedIds.length),
    unsealedSessions: whenListed(idsWithSuffix(names, [PLAIN_SUFFIX]).length),
    sessionsBeingSealed: whenListed(idsWithSuffix(names, [`${PLAIN_SUFFIX}${CLAIMED_SUFFIX}`, `${PLAIN_SUFFIX}${SEAL_TEMP_SUFFIX}`]).length),
    firstTs: read.firstTs,
    lastTs: read.lastTs,
    index,
    ledger: verifyLedger(root),
    unparseableLines: whenListed(read.unparseableLines),
    unreadableSessions: whenListed(read.unreadableSessions),
    hookRegistered: hook.registered,
    settingsProblem: hook.problem,
    retentionDays: config.contentRetentionDays,
    configUnreadable: config.configUnreadable === true,
    contentPastRetentionUnverified: index.unreadable
      ? whenListed(unverifiedPastRetention(root, sealedIds, cutoff))
      : unverifiedPastRetention(root, index.sessionsAltered, cutoff),
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

function hookLine(registered, problem) {
  if (registered === true) return `the hook is registered in ${SETTINGS_PATH}`;
  if (registered === false) return `the hook is not registered in ${SETTINGS_PATH}`;
  return `${problem}: whether the hook is registered could not be told`;
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

/** The status as text for a person. */
export function renderStatus(s) {
  const out = [];
  if (!s.exists) {
    out.push(`No log for this repository on this machine: ${s.location} does not exist.`);
    out.push(...indent([hookLine(s.hookRegistered, s.settingsProblem)]));
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
      hookLine(s.hookRegistered, s.settingsProblem),
    ]));
    out.push('', 'INTEGRITY');
    out.push(...indent([
      ...indexLines(s),
      s.ledger.intact ? 'ledger: intact' : `ledger: broken at line ${s.ledger.brokenAt}`,
      `unparseable lines: ${countOf(s.unparseableLines)}`,
      `unreadable sessions: ${countOf(s.unreadableSessions)}`,
      ...(s.sessionsBeingSealed > 0 ? [`being sealed: ${s.sessionsBeingSealed} sessions have events in a claimed or temporary file, not read here`] : []),
    ]));
    out.push('', 'RETENTION');
    out.push(...indent([
      `content is kept ${s.retentionDays} days; structure is kept until the log is purged`,
      ...(s.configUnreadable ? ['config.json beside the log could not be read, so the defaults are in force'] : []),
      `content past the period, kept because it could not be verified: ${s.contentPastRetentionUnverified === null ? NOT_READ : `${s.contentPastRetentionUnverified} sessions`}`,
      s.blobSweep.skipped
        ? `blob sweep: blocked, so content held in blobs is not being expired: ${s.blobSweep.reason}`
        : 'blob sweep: not blocked; every sealed session matches its latest index line',
    ]));
    out.push('', 'TRANSCRIPTS');
    out.push(...indent(transcriptLines(s.transcripts)));
  }
  out.push('', 'WHAT HOOKS CANNOT SEE');
  out.push(...indent(s.blindSpots));
  out.push('  the transcripts that could be checked fill in the interrupts only');
  return out.join('\n');
}

/** The command line for `args`, the path quoted when it holds a space. */
export const logCommand = (root, ...args) => `node scripts/log.mjs ${/\s/.test(root) ? `"${root}"` : root} ${args.join(' ')}`;

/** Turns the log on and returns what `renderEnable` states. Throws
 * `DataDirRefused`, writing nothing, when the data directory exists and is
 * not safe to write. */
export function enableLog(root) {
  assertDataDirSafe(root, { absentOk: true });
  setEnabled(root, true);
  return { root, location: repoDataDir(root), hook: hookRegistration(root), config: readConfig(root) };
}

/** The disclosure `enable` prints, in its own output. */
export function renderEnable({ root, location, hook, config }) {
  let hookState = `${hook.problem}, so whether the hook is registered could not be told.`;
  if (hook.registered === true) hookState = `The hook is registered in ${SETTINGS_PATH}: recording starts with its next event.`;
  if (hook.registered === false) hookState = `The hook is not registered in ${SETTINGS_PATH} yet: nothing is recorded until \`apply\` installs it.`;
  return [
    `The session log is enabled for ${root} on this machine.`,
    `  kept at: ${location}`,
    '',
    "Once the session-log hook is installed, it records every tool call's input and output for this repository on this machine, with each prompt and session event.",
    hookState,
    '',
    'Credentials are masked before anything is written, on a best-effort basis: some may be missed, so treat the log as able to hold a secret.',
    `Content (prompts, tool input and output) is kept for ${config.contentRetentionDays} days and then removed; structure is kept until the log is purged: which tools ran, when, their sizes, hashes and first error lines.`,
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
  setEnabled(root, false);
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
