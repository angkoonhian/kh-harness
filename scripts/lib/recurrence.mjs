// scripts/lib/recurrence.mjs
//
// Recurrence detection: from a repository's per-machine session log, the
// failures that recur across sessions under one kit harness and model.
// Plain code computes it; no model is involved. Each recurrence is a
// candidate for a mechanical check, never a verdict.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { keyedWorkTree, readEvents } from '../../assets/scripts/harness-log.mjs';
import { CLAIMED_SUFFIX, listSessionFiles, PLAIN_SUFFIX, SEAL_TEMP_SUFFIX, SEALED_SUFFIX } from '../../assets/scripts/harness-seal.mjs';

export const FAILURE_EVENT = 'PostToolUseFailure';
export const SUCCESS_EVENT = 'PostToolUse';

/** The field a logged tool event names its tool in; the logging hook writes
 * the payload's `tool_name` there. */
export const TOOL_FIELD = 'tool';

// The status the logging hook gives a call the user interrupted.
const INTERRUPTED = 'interrupted';

const HARNESS_EVENT = 'harness';
export const EXTERNAL_EVENT = 'external_content';
const UNREADABLE_BASE = 'unreadable';
const MAX_EXAMPLE_REFS = 3;

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// A run with no letter is a number, which becomes `#` whatever its length,
// so a count that grows past eight digits does not change its token.
const HEX = /(?<![0-9A-Za-z])(?=\d*[a-f])[0-9a-f]{8,}(?![0-9A-Za-z])/gi;
const DIGITS = /\d+/g;
const PATH_TAIL = /^[\\/][^\s'"`<>|:*?,;()[\]{}]*/;

const isString = v => typeof v === 'string';
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spellings of `root` an error line may carry: as resolved and, when
 * it differs, as the filesystem names it, longest first. */
function rootSpellings(root) {
  const resolved = resolve(root);
  const spellings = new Set([resolved]);
  try {
    spellings.add(realpathSync.native(resolved));
  } catch {
    // absent or unreadable: the resolved spelling is the only one
  }
  return [...spellings].map(s => s.replace(/\\/g, '/')).sort((a, b) => b.length - a.length);
}

// One pattern per root: a log is read event by event, and building a
// pattern asks the file system for the root's real spelling.
const rootPatterns = new Map();

/** `root`, in any of its spellings and with either separator, where it is
 * not part of a longer path; case-insensitive on win32. */
function rootPattern(root) {
  if (!rootPatterns.has(root)) {
    const alternatives = rootSpellings(root).map(s => escapeRegExp(s).replace(/\//g, '[\\\\/]'));
    rootPatterns.set(root, new RegExp(`(?<![\\w.-])(?:${alternatives.join('|')})(?![\\w.-])`, process.platform === 'win32' ? 'gi' : 'g'));
  }
  const pattern = rootPatterns.get(root);
  pattern.lastIndex = 0;
  return pattern;
}

function relativiseRoot(line, root) {
  const pattern = rootPattern(root);
  let out = '';
  let from = 0;
  for (let m = pattern.exec(line); m !== null; m = pattern.exec(line)) {
    const tail = PATH_TAIL.exec(line.slice(pattern.lastIndex));
    const relative = tail === null ? '' : tail[0].slice(1).replace(/\\/g, '/');
    out += line.slice(from, m.index) + (relative.length > 0 ? relative : '.');
    from = pattern.lastIndex + (tail === null ? 0 : tail[0].length);
    pattern.lastIndex = from;
  }
  return out + line.slice(from);
}

/**
 * `line` with what varies between occurrences of one failure removed: ANSI
 * escapes stripped, paths under `root` made repository-relative with `/`
 * separators, hex runs of eight or more characters (with at least one
 * letter) replaced by `…`, and every remaining digit run by `#`.
 */
export function normaliseError(line, root) {
  return relativiseRoot(line.replace(ANSI, ''), root).replace(HEX, '…').replace(DIGITS, '#');
}

// One answer per reader root, since it is asked for every event.
const keyedWorkTrees = new Map();

/**
 * The root a failure's error line is made relative to. It is the project
 * root the logging hook recorded with the failure; for a failure recorded
 * without one, the work tree the log's key stands for (`keyedWorkTree`).
 * Neither depends on the directory the reader was run from, so every
 * worktree of a repository gives one failure one signature. The limit: a
 * failure recorded without its root, in a repository whose common
 * directory is not a `.git` directory, is still made relative to `root`.
 */
function rootOf(event, root) {
  if (isString(event.root) && event.root.length > 0) return event.root;
  if (!keyedWorkTrees.has(root)) keyedWorkTrees.set(root, keyedWorkTree(root));
  return keyedWorkTrees.get(root);
}

/** Whether `event` records a tool call that failed; one the user
 * interrupted did not fail. */
const isFailure = event => event !== null && typeof event === 'object' && event.type === FAILURE_EVENT && event.status !== INTERRUPTED;

/**
 * The first 16 hex of SHA-256 over a failure's tool name, input hash and
 * normalised first error line, or null for any event that is not a failure
 * carrying all three as strings. An interrupted call is not a failure. The
 * error line is normalised against `rootOf(event, root)`, `root` being
 * where the reader was pointed.
 */
export function failureSignature(event, root) {
  if (!isFailure(event)) return null;
  const { [TOOL_FIELD]: tool, inputHash, firstErrorLine } = event;
  if (!isString(tool) || !isString(inputHash) || !isString(firstErrorLine)) return null;
  const key = JSON.stringify([tool, inputHash, normaliseError(firstErrorLine, rootOf(event, root))]);
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Every session with a file in the repository's sessions directory, sorted
 * by id: `{ id, sealed, unsealed, beingSealed }`. `sealed` and `unsealed`
 * say which of the two files `readEvents` reads it has; `beingSealed` says
 * it has a claimed or temporary file, whose events no reader sees until a
 * maintenance run finishes sealing them. A session whose only file is one
 * of those is listed all the same, so no report leaves it out unsaid. A
 * missing directory holds none. Throws when the directory exists and cannot
 * be listed. The kit's reports all list sessions through this.
 */
export function listSessions(root) {
  return [...listSessionFiles(root)]
    .map(([id, kinds]) => ({
      id,
      sealed: kinds.has(SEALED_SUFFIX),
      unsealed: kinds.has(PLAIN_SUFFIX),
      beingSealed: kinds.has(CLAIMED_SUFFIX) || kinds.has(SEAL_TEMP_SUFFIX),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The id of every session `listSessions` lists, in its order. */
export const sessionIds = root => listSessions(root).map(session => session.id);

/**
 * The `{ base, model }` a `harness` event attributes later failures to, or
 * null when it does not identify one. `harnessIdentity` reports `'none'`
 * for a repository with no kit harness, a known state that groups like any
 * hash, and `'unreadable'` when the manifest could not be read, which
 * identifies nothing.
 */
function identityOf(event) {
  const { base, model } = event;
  if (!isString(base) || base.length === 0 || base === UNREADABLE_BASE) return null;
  if (!isString(model) || model.length === 0) return null;
  return { base, model };
}

/**
 * The failures that recur in at least `minSessions` distinct sessions of
 * one group, a group being the `base` and `model` of the most recent
 * `harness` event before each failure. A failure with no such event, or
 * whose latest one does not identify a harness and model, is never
 * evidence of recurrence: it is left out of every group and counted in
 * `failuresUnattributed`. So is a failure that records no tool, first error
 * line or input hash, which has no signature: `failuresWithoutSignature`
 * counts those among them. A call the user interrupted is not a failure and
 * is counted in `callsInterrupted` alone. Returns `{ recurrences,
 * sessionsRead, sessionsUnreadable, sessionsBeingSealed, sessionsOverLimit,
 * linesUnparseable, failuresUnattributed, failuresWithoutSignature,
 * callsInterrupted }`: every session listed is read
 * and counted in `sessionsRead`, and one with a file that could not be read
 * is also counted in `sessionsUnreadable` while what it did yield is still
 * used. `sessionsBeingSealed` counts the sessions with events in a claimed
 * or temporary file, which were not read, and `sessionsOverLimit` names the
 * ones with a file larger than is read, which are among the unreadable.
 *
 * A recurrence is `subagent` when any of its failures carries an agent id:
 * a sub-agent's events record no model of their own, so the group's model
 * is then the session's and may not be the one that failed.
 *
 * Recurrences come most sessions first, then most occurrences, then by
 * signature. An example reference names the first occurrence in each of the
 * first sessions, by the event's 1-based position in what `readEvents`
 * returns for that session. Throws only when the sessions directory exists
 * and cannot be listed, since nothing could then be said about what it holds.
 */
export function findRecurrences(root, { minSessions = 2 } = {}) {
  if (!Number.isSafeInteger(minSessions) || minSessions < 1) throw new RangeError('minSessions must be a positive integer');
  const sessions = listSessions(root);
  const groups = new Map();
  let sessionsUnreadable = 0;
  const sessionsOverLimit = [];
  let linesUnparseable = 0;
  let failuresUnattributed = 0;
  let failuresWithoutSignature = 0;
  let callsInterrupted = 0;
  for (const { id: sessionId } of sessions) {
    const { events, unparseable, unreadable, overLimit } = readEvents(root, sessionId);
    if (unreadable) sessionsUnreadable++;
    if (overLimit) sessionsOverLimit.push(sessionId);
    linesUnparseable += unparseable;
    const external = events.some(e => e.type === EXTERNAL_EVENT);
    let identity = null;
    events.forEach((event, index) => {
      if (event.type === HARNESS_EVENT) {
        identity = identityOf(event);
        return;
      }
      if (event.type === FAILURE_EVENT && event.status === INTERRUPTED) callsInterrupted++;
      if (!isFailure(event)) return;
      const signature = failureSignature(event, root);
      if (signature === null) {
        failuresWithoutSignature++;
        failuresUnattributed++;
        return;
      }
      if (identity === null) {
        failuresUnattributed++;
        return;
      }
      const { base, model } = identity;
      const key = JSON.stringify([base, model, signature]);
      let entry = groups.get(key);
      if (entry === undefined) {
        entry = { signature, tool: event[TOOL_FIELD], errorLine: normaliseError(event.firstErrorLine, rootOf(event, root)), base, model, sessions: new Map(), count: 0, external: false, subagent: false, firstTs: null, lastTs: null };
        groups.set(key, entry);
      }
      entry.count++;
      entry.external ||= external;
      entry.subagent ||= isString(event.agent_id);
      if (!entry.sessions.has(sessionId)) entry.sessions.set(sessionId, index + 1);
      if (isString(event.ts)) {
        if (entry.firstTs === null || event.ts < entry.firstTs) entry.firstTs = event.ts;
        if (entry.lastTs === null || event.ts > entry.lastTs) entry.lastTs = event.ts;
      }
    });
  }
  const recurrences = [...groups.values()]
    .filter(entry => entry.sessions.size >= minSessions)
    .map(({ sessions, ...entry }) => ({
      ...entry,
      sessions: [...sessions.keys()],
      exampleEventRefs: [...sessions].slice(0, MAX_EXAMPLE_REFS).map(([sessionId, line]) => ({ sessionId, line })),
    }))
    .sort((a, b) => b.sessions.length - a.sessions.length || b.count - a.count || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
  return {
    recurrences,
    sessionsRead: sessions.length,
    sessionsUnreadable,
    sessionsBeingSealed: sessions.filter(session => session.beingSealed).length,
    sessionsOverLimit,
    linesUnparseable,
    failuresUnattributed,
    failuresWithoutSignature,
    callsInterrupted,
  };
}
