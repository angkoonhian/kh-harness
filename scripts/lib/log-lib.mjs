// scripts/lib/log-lib.mjs
//
// What the `log` command reads and does: whether the session-log hook is
// registered, what the log holds and whether it can be trusted, the
// maintenance run, and removal. Nothing here returns or renders a logged
// event's content: only counts, times, sizes, session ids and the kit's own
// file names leave this module.
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  BLOBS_DIR, dataRoot, isEnabled, parsedObject, readConfig, readEvents, repoDataDir, sessionFileName, SESSIONS_DIR, setEnabled,
} from '../../assets/scripts/harness-log.mjs';
import {
  applyRetention, CLAIMED_SUFFIX, contentFieldsOf, SEAL_IDLE_MS, SEAL_TEMP_SUFFIX, sealClosedSessions, untrustedBecause, verifyIndex,
} from '../../assets/scripts/harness-seal.mjs';
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

// The index lock is breakable once it is 10 minutes old, so each of the two
// locked steps stops well inside that; what is left is done by a later run.
const MAINTAIN_BUDGET_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const timeOf = v => (typeof v === 'string' ? Date.parse(v) : Number.NaN);

/** The entry at `path` without following a link, or null when absent; any
 * other failure throws. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const dataDirExists = root => {
  try {
    return lstatOrNull(repoDataDir(root)) !== null;
  } catch {
    return true;
  }
};

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
function diskUsage(dir) {
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

const sessionsDir = root => join(repoDataDir(root), SESSIONS_DIR);

/** The names in the sessions directory; none when it is absent or cannot
 * be listed. */
function sessionNames(root) {
  try {
    return readdirSync(sessionsDir(root));
  } catch {
    return [];
  }
}

/** Ids of sessions whose events sit, wholly or partly, in a claimed or
 * temporary file, which `readEvents` does not read. */
function sessionsBeingSealed(root) {
  const ids = new Set();
  for (const name of sessionNames(root)) {
    for (const suffix of [CLAIMED_SUFFIX, SEAL_TEMP_SUFFIX]) {
      const id = name.startsWith('s-') && name.endsWith(`.jsonl${suffix}`) ? name.slice(2, -`.jsonl${suffix}`.length) : null;
      if (id !== null && sessionFileName(id) === `s-${id}.jsonl`) ids.add(id);
    }
  }
  return ids.size;
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

/** How many of the `altered` sessions, which retention leaves in place
 * because they do not match the index, still hold content older than
 * `cutoff`. A sealed file that cannot be read is judged by its modification
 * time, since what it holds cannot be told. */
function unverifiedPastRetention(root, altered, cutoff) {
  let count = 0;
  for (const id of altered) {
    const path = join(sessionsDir(root), `${sessionFileName(id)}.gz`);
    let state;
    try {
      state = sealedContentState(gunzipSync(readFileSync(path)));
    } catch {
      try {
        if (statSync(path).mtimeMs < cutoff) count++;
      } catch {
        // gone since it was checked
      }
      continue;
    }
    const last = Number.isNaN(state.last) ? statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Number.NaN : state.last;
    if (state.holdsContent && last < cutoff) count++;
  }
  return count;
}

/**
 * What this repository's log on this machine holds and whether it can be
 * trusted, from reads alone: nothing is written, not even the sweep's
 * verification record. `index` is `verifyIndex`'s result; `blobSweep` says
 * whether the next sweep would remove nothing, and why, judged from it.
 */
export function logStatus(root) {
  const location = repoDataDir(root);
  const exists = dataDirExists(root);
  const config = readConfig(root);
  const hook = hookRegistration(root);
  let ids = [];
  let sessionsUnlistable = false;
  try {
    ids = sessionIds(root);
  } catch {
    sessionsUnlistable = true;
  }
  const read = readSessions(root, ids);
  const index = verifyIndex(root);
  const untrusted = untrustedBecause(index);
  const usage = exists ? diskUsage(location) : { bytes: 0, unreadable: 0 };
  return {
    enabled: isEnabled(root),
    exists,
    location,
    bytes: usage.bytes,
    unreadableEntries: usage.unreadable,
    sessions: ids.length,
    sessionsUnlistable,
    sessionsBeingSealed: sessionsBeingSealed(root),
    firstTs: read.firstTs,
    lastTs: read.lastTs,
    index,
    ledger: verifyLedger(root),
    unparseableLines: read.unparseableLines,
    unreadableSessions: read.unreadableSessions,
    hookRegistered: hook.registered,
    settingsProblem: hook.problem,
    retentionDays: config.contentRetentionDays,
    configUnreadable: config.configUnreadable === true,
    contentPastRetentionUnverified: unverifiedPastRetention(root, index.sessionsAltered, Date.now() - config.contentRetentionDays * DAY_MS),
    blobSweep: { skipped: untrusted !== null, reason: untrusted },
    transcripts: { ...summariseTranscripts(read.transcriptPaths), sessionsWithoutTranscript: read.withoutTranscript },
    blindSpots: [...BLIND_SPOTS],
  };
}

const formatBytes = n => {
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

function indexLines(index) {
  const lines = [];
  if (index.intact) {
    lines.push('index: intact; the chain is unbroken and every sealed session matches it');
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
  return lines;
}

const indent = lines => lines.map(l => `  ${l}`);

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
      s.sessionsUnlistable ? 'sessions: the sessions directory could not be listed' : `sessions: ${s.sessions}${range}`,
      hookLine(s.hookRegistered, s.settingsProblem),
    ]));
    out.push('', 'INTEGRITY');
    out.push(...indent([
      ...indexLines(s.index),
      s.ledger.intact ? 'ledger: intact' : `ledger: broken at line ${s.ledger.brokenAt}`,
      `unparseable lines: ${s.unparseableLines}`,
      `unreadable sessions: ${s.unreadableSessions}`,
      ...(s.sessionsBeingSealed > 0 ? [`being sealed: ${s.sessionsBeingSealed} sessions have events in a claimed or temporary file, not read here`] : []),
    ]));
    out.push('', 'RETENTION');
    out.push(...indent([
      `content is kept ${s.retentionDays} days; structure is kept until the log is purged`,
      ...(s.configUnreadable ? ['config.json beside the log could not be read, so the defaults are in force'] : []),
      `content past the period, kept because it could not be verified: ${s.contentPastRetentionUnverified} sessions`,
      s.blobSweep.skipped ? `blob sweep: skipped, because ${s.blobSweep.reason}` : 'blob sweep: not blocked; the index accounts for every sealed session',
    ]));
    const t = s.transcripts;
    out.push('', 'TRANSCRIPTS');
    out.push(...indent([
      `checked: ${t.checked}, not checked: ${t.notChecked}, interrupts found: ${t.interrupts}`,
      `sessions with no transcript recorded: ${t.sessionsWithoutTranscript}`,
      ...(t.unknownLineTypes.length > 0 ? [`unknown line types: ${t.unknownLineTypes.join(', ')}`] : []),
      'a transcript still being written can end in a half-written line, and one since moved or deleted cannot be read;',
      'either reads as not checked, which is not damage',
    ]));
  }
  out.push('', 'WHAT HOOKS CANNOT SEE');
  out.push(...indent(s.blindSpots));
  out.push('  the transcripts that could be checked fill in the interrupts only');
  return out.join('\n');
}

/** The command line for `args`, the path quoted when it holds a space. */
export const logCommand = (root, ...args) => `node scripts/log.mjs ${/\s/.test(root) ? `"${root}"` : root} ${args.join(' ')}`;

/** Turns the log on and returns what `renderEnable` states. */
export function enableLog(root) {
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
 * this repository has no log on this machine. */
export function disableLog(root) {
  if (!dataDirExists(root)) return false;
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

function blobNames(root) {
  try {
    return readdirSync(join(repoDataDir(root), BLOBS_DIR));
  } catch {
    return [];
  }
}

/** Sessions still holding unsealed events after a run: those appended to
 * within the idle threshold, which sealing leaves by design, and the rest. */
function unsealedAfter(root, now) {
  let recent = 0;
  let other = 0;
  for (const name of sessionNames(root)) {
    const id = name.startsWith('s-') && name.endsWith('.jsonl') ? name.slice(2, -'.jsonl'.length) : null;
    if (id === null || sessionFileName(id) !== name) continue;
    try {
      if (now - statSync(join(sessionsDir(root), name)).mtimeMs < SEAL_IDLE_MS) recent++;
      else other++;
    } catch {
      // sealed since it was listed
    }
  }
  return { recent, other };
}

/**
 * Seals closed sessions and applies retention, as the hook does at session
 * start, with a budget of minutes rather than milliseconds, and says what was
 * done and what was left.
 */
export function maintainLog(root) {
  const started = performance.now();
  const blobsBefore = blobNames(root);
  const seal = sealClosedSessions(root, { budgetMs: MAINTAIN_BUDGET_MS });
  const retention = applyRetention(root, { budgetMs: MAINTAIN_BUDGET_MS - (performance.now() - started) });
  const blobsAfter = new Set(blobNames(root));
  return {
    sealed: seal.sealed.length,
    contentRemoved: retention.contentRemoved,
    contentUnverifiable: retention.contentUnverifiable,
    blobsRemoved: blobsBefore.filter(name => !blobsAfter.has(name)).length,
    blobSweep: retention.blobSweep,
    lockLost: seal.lockLost || retention.lockLost,
    timeLimitReached: performance.now() - started >= MAINTAIN_BUDGET_MS,
    unsealed: unsealedAfter(root, Date.now()),
  };
}

export function renderMaintain(r) {
  const out = [
    `sessions sealed: ${r.sealed}`,
    `content expired: ${r.contentRemoved} sessions`,
    `blobs removed: ${r.blobsRemoved}`,
  ];
  if (r.blobSweep.skipped) out.push(`blob sweep skipped: ${r.blobSweep.reason}`);
  if (r.contentUnverifiable > 0) out.push(`content past the period left in place, because it could not be verified: ${r.contentUnverifiable} sessions`);
  if (r.unsealed.recent > 0) out.push(`not sealed: ${r.unsealed.recent} sessions appended to in the last ${SEAL_IDLE_MS / 60_000} minutes, which may still be running`);
  if (r.unsealed.other > 0) out.push(`not sealed: ${r.unsealed.other} other sessions; \`status\` says whether the index explains why`);
  if (r.timeLimitReached) out.push(`the ${MAINTAIN_BUDGET_MS / 60_000}-minute limit was reached; run maintain again to continue`);
  if (r.lockLost) out.push('the index lock was broken by another process during the run, which then stopped');
  return out.join('\n');
}

/**
 * Whether this repository's data directory may be removed: `'absent'`,
 * `'refused'` with the reason, or `'ok'` with its size and top-level
 * entries. It must be a directory, not a link, whose real path is directly
 * inside the data root's real path and is not the data root itself.
 */
export function purgeTarget(root) {
  const dir = repoDataDir(root);
  const refused = reason => ({ state: 'refused', dir, reason });
  let st;
  try {
    st = lstatOrNull(dir);
  } catch (error) {
    return refused(`it cannot be examined (${error?.code ?? 'unknown error'})`);
  }
  if (st === null) return { state: 'absent', dir };
  if (st.isSymbolicLink()) return refused('it is a link, and removing a link would not remove what it points at');
  if (!st.isDirectory()) return refused('it is not a directory');
  let realDir;
  let realRoot;
  try {
    realDir = realpathSync.native(dir);
    realRoot = realpathSync.native(dataRoot());
  } catch (error) {
    return refused(`its real location cannot be resolved (${error?.code ?? 'unknown error'})`);
  }
  const rel = relative(realRoot, realDir);
  if (rel === '') return refused(`it is the data root ${realRoot} itself`);
  if (isAbsolute(rel) || rel.startsWith('..') || /[\\/]/.test(rel)) return refused(`it is not directly inside the data root ${realRoot}`);
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return refused(`it cannot be listed (${error?.code ?? 'unknown error'})`);
  }
  const entries = names.map(e => ({
    name: e.isDirectory() ? `${e.name}/` : e.name,
    bytes: e.isDirectory() ? diskUsage(join(dir, e.name)).bytes : lstatSync(join(dir, e.name), { throwIfNoEntry: false })?.size ?? 0,
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
  let sessions = 0;
  try {
    sessions = sessionIds(root).length;
  } catch {
    // listed below as part of `sessions/`
  }
  return { state: 'ok', dir, usage: diskUsage(dir), entries, sessions };
}

export function renderPurgePlan(root, target) {
  const size = target.usage.unreadable > 0 ? `${formatBytes(target.usage.bytes)} at least` : formatBytes(target.usage.bytes);
  return [
    `Would remove ${target.dir} (${size}, ${target.sessions} sessions):`,
    ...target.entries.map(e => `  ${e.name}  ${formatBytes(e.bytes)}`),
    'This is everything the kit keeps for this repository on this machine; nothing else is touched.',
    '',
    `Run with --yes to remove it:  ${logCommand(root, 'purge', '--yes')}`,
  ].join('\n');
}

/** Disables the log, so no hook writes into the directory meanwhile, then
 * removes the directory `purgeTarget` cleared. Throws what the removal
 * throws. */
export function purgeLog(root, target) {
  setEnabled(root, false);
  rmSync(target.dir, { recursive: true });
}
