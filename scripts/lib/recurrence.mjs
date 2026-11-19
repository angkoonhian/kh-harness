// scripts/lib/recurrence.mjs
//
// Recurrence detection: from a repository's per-machine session log, the
// failures that recur across sessions under one kit harness and model.
// Plain code computes it; no model is involved. Each recurrence is a
// candidate for a mechanical check, never a verdict.
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readEvents, repoDataDir, sessionFileName } from '../../assets/scripts/harness-log.mjs';

export const FAILURE_EVENT = 'PostToolUseFailure';
export const SUCCESS_EVENT = 'PostToolUse';

/** The field a logged tool event names its tool in; the logging hook writes
 * the payload's `tool_name` there. */
export const TOOL_FIELD = 'tool';

const HARNESS_EVENT = 'harness';
const EXTERNAL_EVENT = 'external_content';
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

/** `root`, in any of its spellings and with either separator, where it is
 * not part of a longer path; case-insensitive on win32. */
function rootPattern(root) {
  const alternatives = rootSpellings(root).map(s => escapeRegExp(s).replace(/\//g, '[\\\\/]'));
  return new RegExp(`(?<![\\w.-])(?:${alternatives.join('|')})(?![\\w.-])`, process.platform === 'win32' ? 'gi' : 'g');
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

/**
 * The first 16 hex of SHA-256 over a failure's tool name, input hash and
 * normalised first error line, or null for any event that is not a failure
 * carrying all three as strings.
 */
export function failureSignature(event, root) {
  if (event === null || typeof event !== 'object' || event.type !== FAILURE_EVENT) return null;
  const { [TOOL_FIELD]: tool, inputHash, firstErrorLine } = event;
  if (!isString(tool) || !isString(inputHash) || !isString(firstErrorLine)) return null;
  const key = JSON.stringify([tool, inputHash, normaliseError(firstErrorLine, root)]);
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/** Every session id with a file in `dir`, plain or compressed, once each and
 * sorted; a missing directory holds none. */
function sessionIds(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const ids = new Set();
  for (const name of names) {
    const m = /^s-(.+)\.jsonl(?:\.gz)?$/.exec(name);
    if (m !== null && sessionFileName(m[1]) === `s-${m[1]}.jsonl`) ids.add(m[1]);
  }
  return [...ids].sort();
}

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
 * `failuresUnattributed`. Returns `{ recurrences, sessionsRead,
 * sessionsUnreadable, linesUnparseable, failuresUnattributed }`: every
 * session listed is read and counted in `sessionsRead`, and one with a file
 * that could not be read is also counted in `sessionsUnreadable` while what
 * it did yield is still used.
 *
 * Recurrences come most sessions first, then most occurrences, then by
 * signature. An example reference names the first occurrence in each of the
 * first sessions, by the event's 1-based position in what `readEvents`
 * returns for that session. Throws only when the sessions directory exists
 * and cannot be listed, since nothing could then be said about what it holds.
 */
export function findRecurrences(root, { minSessions = 2 } = {}) {
  if (!Number.isSafeInteger(minSessions) || minSessions < 1) throw new RangeError('minSessions must be a positive integer');
  const ids = sessionIds(join(repoDataDir(root), 'sessions'));
  const groups = new Map();
  let sessionsUnreadable = 0;
  let linesUnparseable = 0;
  let failuresUnattributed = 0;
  for (const sessionId of ids) {
    const { events, unparseable, unreadable } = readEvents(root, sessionId);
    if (unreadable) sessionsUnreadable++;
    linesUnparseable += unparseable;
    const external = events.some(e => e.type === EXTERNAL_EVENT);
    let identity = null;
    events.forEach((event, index) => {
      if (event.type === HARNESS_EVENT) {
        identity = identityOf(event);
        return;
      }
      const signature = failureSignature(event, root);
      if (signature === null) return;
      if (identity === null) {
        failuresUnattributed++;
        return;
      }
      const { base, model } = identity;
      const key = JSON.stringify([base, model, signature]);
      let entry = groups.get(key);
      if (entry === undefined) {
        entry = { signature, tool: event[TOOL_FIELD], errorLine: normaliseError(event.firstErrorLine, root), base, model, sessions: new Map(), count: 0, external: false, firstTs: null, lastTs: null };
        groups.set(key, entry);
      }
      entry.count++;
      entry.external ||= external;
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
  return { recurrences, sessionsRead: ids.length, sessionsUnreadable, linesUnparseable, failuresUnattributed };
}
