// assets/scripts/harness-seal.mjs
//
// Sealing, the index and retention for the session log. A session's events
// are appended to `s-<id>.jsonl` while it runs. Sealing a session idle for
// `SEAL_IDLE_MS` first renames that file to `s-<id>.jsonl.sealing`, so an
// event a hook appends meanwhile starts a new plain file instead of being
// lost, then writes the earlier compressed events plus the claimed ones to
// `s-<id>.jsonl.gz.tmp`, appends the index line naming that content's hash,
// removes the claimed file and renames the temporary file into place.
// `readEvents` reads neither the claimed nor the temporary file, so no state
// shows an event twice, and a temporary file whose content matches the
// session's latest index line is the record that the steps after the index
// append still have to be done. A crash in the middle of an index append
// leaves a torn line, which `verifyIndex` reports as a break.
//
// Two windows are left open. A hook that opened the plain file just before
// it was claimed and writes just after the sealer read it loses that line.
// A blob no session references, over a day old and stored again by an
// append in the instant before the blob sweep, can be removed under that
// append, since storing keeps an existing blob file and its old age.
//
// Run only at session start, so it is a module of its own and the hook on
// every tool call never parses it. Installed beside the other hook scripts:
// it imports only Node built-ins and sibling files and never spawns a child
// process.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { BLOBS_DIR, canonicalJson, parsedObject, readConfig, repoDataDir, sessionFileName, SESSIONS_DIR } from './harness-log.mjs';
import { safeSessionId } from './harness-redact.mjs';

/** Appended to a session's file name (`sessionFileName`): the file its
 * unsealed events are claimed into while they are sealed, and the
 * compressed file being written before it is renamed into place. */
export const CLAIMED_SUFFIX = '.sealing';
export const SEAL_TEMP_SUFFIX = '.gz.tmp';

/** A session's plain file is sealed only once it has gone this long without
 * an append, so a session still running in another terminal or worktree is
 * neither claimed from under it nor sealed again on every session start. */
export const SEAL_IDLE_MS = 10 * 60_000;

/**
 * The fields, by event type, that carry text from the payload rather than
 * structure: what retention removes. Every other field the hook writes is
 * an identifier, a path, a name from a fixed set, a hash, a size, a time or
 * a flag, and is kept.
 */
export const CONTENT_FIELDS = Object.freeze({
  UserPromptSubmit: Object.freeze(['prompt']),
  PermissionDenied: Object.freeze(['reason']),
  PostToolUse: Object.freeze(['input', 'output']),
  PostToolUseFailure: Object.freeze(['input', 'output', 'firstErrorLine']),
  StopFailure: Object.freeze(['error', 'errorDetails']),
});

const sha256Hex = data => createHash('sha256').update(data).digest('hex');
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const INDEX_FILE = 'index.jsonl';
const LOCK_FILE = 'index.jsonl.lock';
const DAY_MS = 86_400_000;
const NEWLINE = 0x0a;

// A lock is broken once its owner has exited, or once it is
// `LOCK_MAX_AGE_MS` old whatever its owner, since no run outlasts its time
// budget by that much and a reused pid must not stop sealing for good. A
// lock with no readable owner is broken once it is `LOCK_STALE_MS` old: its
// owner leaves it ownerless only between creating it and writing to it.
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_AGE_MS = 10 * 60_000;

// The suffixes after a session's file name that name its plain file and its
// sealed one; `CLAIMED_SUFFIX` and `SEAL_TEMP_SUFFIX` name the other two.
const PLAIN = '';
const SEALED = '.gz';
const SESSION_ENTRY = new RegExp(
  `^s-([^.]+)\\.jsonl(${[SEALED, CLAIMED_SUFFIX, SEAL_TEMP_SUFFIX].map(s => s.replace(/\./g, '\\.')).join('|')})?$`);

const isSha256 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isTimestampOrNull = v => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

const INDEX_FIELDS = {
  sessionId: v => typeof v === 'string' && safeSessionId(v) === v,
  sha256: isSha256,
  events: v => Number.isSafeInteger(v) && v >= 0,
  firstTs: isTimestampOrNull,
  lastTs: isTimestampOrNull,
  external: v => typeof v === 'boolean',
  blobs: v => Array.isArray(v) && v.every(isSha256),
  prev: v => v === null || isSha256(v),
};

/** True for an index line's record: every field valid, and nothing else
 * but `contentExpired: true`. */
function isIndexRecord(v) {
  if (!isPlainObject(v)) return false;
  if (!Object.keys(v).every(k => Object.hasOwn(INDEX_FIELDS, k) || k === 'contentExpired')) return false;
  if (v.contentExpired !== undefined && v.contentExpired !== true) return false;
  return Object.entries(INDEX_FIELDS).every(([field, valid]) => valid(v[field]));
}

/** Each line's bytes without its newline; an unterminated last line is
 * kept. */
function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
    lines.push(buf.subarray(start, nl));
    start = nl + 1;
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

const indexPath = root => join(repoDataDir(root), INDEX_FILE);

/**
 * The index's lines, each with its bytes and its record (null for a line
 * that is not one), the latest record per session, and whether the last
 * line lacks its newline. Null when the index exists but cannot be read.
 */
function readIndex(root) {
  let buf;
  try {
    buf = readFileSync(indexPath(root));
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
    buf = Buffer.alloc(0);
  }
  const lines = splitLines(buf).map(bytes => {
    const record = parsedObject(bytes.toString('utf8'));
    return { bytes, record: isIndexRecord(record) ? record : null };
  });
  const latest = new Map();
  for (const { record } of lines) if (record !== null) latest.set(record.sessionId, record);
  return { lines, latest, torn: buf.length > 0 && buf.at(-1) !== NEWLINE, appendFailed: false };
}

/** Appends `record` to the index chained to the last line, and records it as
 * its session's latest. A failed append sets `appendFailed`, since a line
 * may have been torn and the in-memory chain is then no longer the file's. */
function appendIndexLine(root, index, record) {
  const full = { ...record, prev: index.lines.length === 0 ? null : sha256Hex(index.lines.at(-1).bytes) };
  const line = canonicalJson(full);
  index.appendFailed = true;
  appendFileSync(indexPath(root), `${index.torn ? '\n' : ''}${line}\n`, { encoding: 'utf8', mode: 0o600 });
  index.appendFailed = false;
  index.torn = false;
  index.lines.push({ bytes: Buffer.from(line, 'utf8'), record: full });
  index.latest.set(record.sessionId, full);
}

/** Each session found in the sessions directory, by id in sorted order, with
 * the set of its files present, named by their suffixes. */
function listSessions(root) {
  let names;
  try {
    names = readdirSync(join(repoDataDir(root), SESSIONS_DIR));
  } catch {
    return new Map();
  }
  const sessions = new Map();
  for (const name of names.sort()) {
    const m = SESSION_ENTRY.exec(name);
    if (m === null || safeSessionId(m[1]) !== m[1]) continue;
    if (!sessions.has(m[1])) sessions.set(m[1], new Set());
    sessions.get(m[1]).add(m[2] ?? PLAIN);
  }
  return sessions;
}

const sessionFile = (root, sessionId, kind) => `${join(repoDataDir(root), SESSIONS_DIR, sessionFileName(sessionId))}${kind}`;

/** The uncompressed bytes of a gzip file, or null when it is absent; any
 * other failure, a file that is not gzip included, throws. */
function readCompressed(path) {
  try {
    return gunzipSync(readFileSync(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether `bytes` (null for no sealed file) is what the session's latest
 * index line names. */
const matchesIndex = (bytes, latest) =>
  latest === undefined ? bytes === null : bytes !== null && sha256Hex(bytes) === latest.sha256;

/** Every blob hash a `{ blob, truncated: true }` reference in `value`
 * names, added to `into`. */
function collectBlobs(value, into) {
  if (Array.isArray(value)) {
    for (const v of value) collectBlobs(v, into);
  } else if (isPlainObject(value)) {
    if (value.truncated === true && isSha256(value.blob)) into.add(value.blob);
    for (const v of Object.values(value)) collectBlobs(v, into);
  }
}

function blobsIn(bytes, into) {
  for (const line of splitLines(bytes)) collectBlobs(parsedObject(line.toString('utf8')), into);
}

/** The index record for a session holding `bytes`. `events` counts the lines
 * that parse; `firstTs` and `lastTs` are the earliest and latest event times,
 * null when no event has one. */
function sealRecord(sessionId, bytes) {
  let events = 0;
  let firstTs = null;
  let lastTs = null;
  let external = false;
  const blobs = new Set();
  for (const line of splitLines(bytes)) {
    const event = parsedObject(line.toString('utf8'));
    if (event === null) continue;
    events++;
    if (event.type === 'external_content') external = true;
    collectBlobs(event, blobs);
    if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts))) continue;
    if (firstTs === null || Date.parse(event.ts) < Date.parse(firstTs)) firstTs = event.ts;
    if (lastTs === null || Date.parse(event.ts) > Date.parse(lastTs)) lastTs = event.ts;
  }
  return { sessionId, sha256: sha256Hex(bytes), events, firstTs, lastTs, external, blobs: [...blobs].sort() };
}

function writeTemp(path, bytes) {
  rmSync(path, { force: true });
  writeFileSync(path, gzipSync(bytes), { flag: 'wx', mode: 0o600 });
}

/** Whether the session's temporary file holds what its latest index line
 * names; false when either is absent or the file cannot be read. */
function tempMatchesIndex(root, sessionId, latest) {
  if (latest === undefined) return false;
  try {
    return sha256Hex(gunzipSync(readFileSync(sessionFile(root, sessionId, SEAL_TEMP_SUFFIX)))) === latest.sha256;
  } catch {
    return false;
  }
}

/**
 * Finishes or discards each temporary file an interrupted run left. One
 * whose content is the session's latest index line was indexed, so any
 * claimed file it was built from is removed and it is renamed into place;
 * any other was never indexed and is removed. `sessions` is updated to
 * match; a file that cannot be finished keeps its entry, and its session is
 * left alone until a later run.
 */
function recoverInterrupted(root, sessions, index) {
  for (const [sessionId, kinds] of sessions) {
    if (!kinds.has(SEAL_TEMP_SUFFIX)) continue;
    const temp = sessionFile(root, sessionId, SEAL_TEMP_SUFFIX);
    try {
      if (tempMatchesIndex(root, sessionId, index.latest.get(sessionId))) {
        rmSync(sessionFile(root, sessionId, CLAIMED_SUFFIX), { force: true });
        kinds.delete(CLAIMED_SUFFIX);
        renameSync(temp, sessionFile(root, sessionId, SEALED));
        kinds.add(SEALED);
      } else {
        rmSync(temp, { force: true });
      }
      kinds.delete(SEAL_TEMP_SUFFIX);
    } catch {
      // left for a later run
    }
  }
}

/** `sealed` followed by `claimed`, with a newline between when the sealed
 * content's last line lacks one. */
function joined(sealed, claimed) {
  if (sealed === null || sealed.length === 0) return claimed;
  return sealed.at(-1) === NEWLINE ? Buffer.concat([sealed, claimed]) : Buffer.concat([sealed, Buffer.from('\n'), claimed]);
}

/**
 * Seals one session's unsealed events and says whether it did. A plain file
 * appended to within `SEAL_IDLE_MS` of `now` is left for a later run. A
 * session whose sealed file does not match its latest index line is left
 * alone, so `verifyIndex` keeps reporting it instead of the damage being
 * sealed over. A claimed file an interrupted run left is sealed before the
 * plain file, which then waits for a later run.
 */
function sealSession(root, sessionId, kinds, index, now) {
  if (kinds.has(SEAL_TEMP_SUFFIX) || !(kinds.has(PLAIN) || kinds.has(CLAIMED_SUFFIX))) return false;
  const plainPath = sessionFile(root, sessionId, PLAIN);
  const sealedPath = sessionFile(root, sessionId, SEALED);
  const claimedPath = sessionFile(root, sessionId, CLAIMED_SUFFIX);
  const tempPath = sessionFile(root, sessionId, SEAL_TEMP_SUFFIX);
  if (!kinds.has(CLAIMED_SUFFIX) && now - statSync(plainPath).mtimeMs < SEAL_IDLE_MS) return false;
  const sealed = readCompressed(sealedPath);
  if (!matchesIndex(sealed, index.latest.get(sessionId))) return false;
  if (!kinds.has(CLAIMED_SUFFIX)) {
    renameSync(plainPath, claimedPath);
    kinds.delete(PLAIN);
    kinds.add(CLAIMED_SUFFIX);
  }
  const claimed = readFileSync(claimedPath);
  if (claimed.length === 0) {
    rmSync(claimedPath, { force: true });
    kinds.delete(CLAIMED_SUFFIX);
    return false;
  }
  const content = joined(sealed, claimed);
  writeTemp(tempPath, content);
  appendIndexLine(root, index, sealRecord(sessionId, content));
  rmSync(claimedPath, { force: true });
  kinds.delete(CLAIMED_SUFFIX);
  renameSync(tempPath, sealedPath);
  kinds.add(SEALED);
  return true;
}

/** Whether a process with this pid exists; EPERM means it does, owned by
 * another user. */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function readLock(path) {
  try {
    const bytes = readFileSync(path);
    return { bytes, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function lockOwner(bytes) {
  const owner = parsedObject(bytes.toString('utf8'));
  return owner !== null && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && owner.token.length > 0
    ? owner
    : null;
}

function isBreakable(lock, { now, isAlive }) {
  const age = now - lock.mtimeMs;
  if (age > LOCK_MAX_AGE_MS) return true;
  const owner = lockOwner(lock.bytes);
  return owner !== null ? !isAlive(owner.pid) : age > LOCK_STALE_MS;
}

function unlinkQuietly(path) {
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates `path` exclusively, owned by this process, and returns the
 * owner's token; null when it cannot. */
function createLock(path) {
  const token = randomBytes(16).toString('hex');
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    return null;
  }
  let written = false;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    written = true;
  } catch {
    // an ownerless lock is removed below
  } finally {
    closeSync(fd);
    if (!written) unlinkQuietly(path);
  }
  return written ? token : null;
}

/** Removes the lock only while it is still the one `token` owns. */
function releaseLock(path, token) {
  const lock = readLock(path);
  if (lock !== null && lockOwner(lock.bytes)?.token === token) unlinkQuietly(path);
}

function removeIfUnchanged(path, judged, judge) {
  const again = readLock(path);
  return again !== null && again.bytes.equals(judged.bytes) && isBreakable(again, judge) && unlinkQuietly(path);
}

/** Removes the lock when it is breakable, and says whether it did. Breakers
 * take a second lock beside it, so of two that judged one lock breakable
 * only one removes it, and never the lock a third has taken since. */
function breakLock(path, judge) {
  const judged = readLock(path);
  if (judged === null || !isBreakable(judged, judge)) return false;
  const mutexPath = `${path}.break`;
  const token = createLock(mutexPath);
  if (token === null) {
    const holder = readLock(mutexPath);
    if (holder !== null) removeIfUnchanged(mutexPath, holder, judge);
    return false;
  }
  try {
    return removeIfUnchanged(path, judged, judge);
  } finally {
    releaseLock(mutexPath, token);
  }
}

/** Runs `fn` holding the index lock and says whether it ran; it does not
 * while another live process holds the lock or the repository has no data
 * directory. `judge` is `{ now, isAlive }`, what a lock's breakability is
 * judged by. */
function withIndexLock(root, judge, fn) {
  const path = join(repoDataDir(root), LOCK_FILE);
  let token = createLock(path);
  if (token === null && breakLock(path, judge)) token = createLock(path);
  if (token === null) return false;
  try {
    fn();
  } finally {
    releaseLock(path, token);
  }
  return true;
}

const defaultClock = () => performance.now();

/** A check that is true until `budgetMs` of `clock` time has passed since
 * it was made. */
function budget(clock, budgetMs) {
  const started = clock();
  return () => clock() - started < budgetMs;
}

/**
 * Seals every session but `currentSessionId` that has events not yet sealed
 * and no append within `SEAL_IDLE_MS` of `now`: compresses them after any
 * sealed before, and appends to `<repoDataDir>/index.jsonl` a line naming
 * the SHA-256 of the whole uncompressed content, its event count, first and
 * last event times, whether it fetched outside content (`external`), the
 * blobs it references, and `prev`, the SHA-256 of the index line before. An
 * event appended after its session was sealed is sealed again with the rest
 * on a later run.
 *
 * Runs under an exclusive lock and does nothing while another process holds
 * it. Stops before the next session once `budgetMs` of `clock` time has
 * passed; the rest are sealed on a later call. `now` is milliseconds since
 * the epoch; `isAlive(pid)` says whether a lock's owner still runs. Never
 * throws.
 */
export function sealClosedSessions(root, {
  now = Date.now(), currentSessionId, budgetMs = Infinity, clock = defaultClock, isAlive = processIsAlive,
} = {}) {
  const sealed = [];
  const withinBudget = budget(clock, budgetMs);
  try {
    withIndexLock(root, { now, isAlive }, () => {
      const index = readIndex(root);
      if (index === null) return;
      const sessions = listSessions(root);
      recoverInterrupted(root, sessions, index);
      for (const [sessionId, kinds] of sessions) {
        if (sessionId === currentSessionId) continue;
        if (!withinBudget()) return;
        try {
          if (sealSession(root, sessionId, kinds, index, now)) sealed.push(sessionId);
        } catch {
          // this session is left for a later run
        }
        if (index.appendFailed) return;
      }
    });
  } catch {
    // nothing more is sealed this run
  }
  return { sealed };
}

/** `bytes` with each event's `CONTENT_FIELDS` removed and `contentExpired:
 * true` set on each event that lost one. A line that does not parse cannot
 * be expired field by field, so it is dropped. `removed` says whether
 * anything changed; unchanged lines keep their bytes. */
function withoutContent(bytes) {
  const lines = [];
  let removed = false;
  for (const line of splitLines(bytes)) {
    const event = parsedObject(line.toString('utf8'));
    if (event === null) {
      removed = true;
      continue;
    }
    const fields = Object.hasOwn(CONTENT_FIELDS, event.type) ? CONTENT_FIELDS[event.type] : [];
    const present = fields.filter(f => Object.hasOwn(event, f));
    if (present.length === 0) {
      lines.push(line, Buffer.from('\n'));
      continue;
    }
    for (const f of present) delete event[f];
    lines.push(Buffer.from(`${JSON.stringify({ ...event, contentExpired: true })}\n`, 'utf8'));
    removed = true;
  }
  return { content: removed ? Buffer.concat(lines) : bytes, removed };
}

/** Expires one indexed session's sealed content: `'removed'` when content
 * was removed, `'unchanged'` when there was none, `'unverifiable'` when the
 * sealed file does not match the index line and is left in place, and
 * `'absent'` when there is no sealed file. The new index line carries
 * `contentExpired: true`, so the session is not read again until a later
 * seal adds events to it. */
function expireSession(root, sessionId, index) {
  const sealedPath = sessionFile(root, sessionId, SEALED);
  const tempPath = sessionFile(root, sessionId, SEAL_TEMP_SUFFIX);
  let sealed;
  try {
    sealed = readCompressed(sealedPath);
  } catch {
    return 'unverifiable';
  }
  if (sealed === null) return 'absent';
  if (!matchesIndex(sealed, index.latest.get(sessionId))) return 'unverifiable';
  const { content, removed } = withoutContent(sealed);
  if (removed) writeTemp(tempPath, content);
  appendIndexLine(root, index, { ...sealRecord(sessionId, content), contentExpired: true });
  if (removed) renameSync(tempPath, sealedPath);
  return removed ? 'removed' : 'unchanged';
}

/** Every blob some session references: the latest index line's list for
 * each indexed session, which the caller has verified its sealed content
 * matches, and a read of every unsealed session file. */
function referencedBlobs(root, sessions, index) {
  const referenced = new Set();
  for (const [sessionId, kinds] of sessions) {
    for (const sha256 of index.latest.get(sessionId)?.blobs ?? []) referenced.add(sha256);
    for (const kind of [PLAIN, CLAIMED_SUFFIX]) {
      if (kinds.has(kind)) blobsIn(readFileSync(sessionFile(root, sessionId, kind)), referenced);
    }
  }
  return referenced;
}

/** Removes every file in the blob store that no session references and that
 * is over a day old by `now`; the age floor spares a blob whose event has
 * not been appended yet. */
function removeUnreferencedBlobs(root, sessions, index, now) {
  const referenced = referencedBlobs(root, sessions, index);
  const dir = join(repoDataDir(root), BLOBS_DIR);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^([0-9a-f]{64})\.gz$/.exec(name);
    if (m !== null && referenced.has(m[1])) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > DAY_MS) rmSync(join(dir, name));
    } catch {
      // left for a later run
    }
  }
}

/** Why the index cannot be trusted to name every blob sealed content
 * references, or null when it can. */
function untrustedBecause(check) {
  if (check.brokenAt !== null) return `the index chain is broken at line ${check.brokenAt}`;
  const parts = [];
  if (check.sessionsAltered.length > 0) parts.push(`altered: ${check.sessionsAltered.join(', ')}`);
  if (check.sessionsMissing.length > 0) parts.push(`missing: ${check.sessionsMissing.join(', ')}`);
  return parts.length > 0 ? `sealed sessions do not match the index (${parts.join('; ')})` : null;
}

/**
 * Expires the content of every indexed session whose last event is older
 * than `contentRetentionDays` by `now` (milliseconds since the epoch): each
 * event loses its `CONTENT_FIELDS` and is marked `contentExpired: true`,
 * everything else is kept, and an index line recording the rewrite is
 * appended. Then removes the blobs no session references that are over a
 * day old.
 *
 * Returns `contentRemoved`, the number of sessions that lost content this
 * run (sessions, not events); `contentUnverifiable`, the number of sessions
 * past the period whose sealed content was left in place because it has no
 * index line or does not match it; and `blobSweep`, `{ skipped, reason }`.
 * The sweep removes nothing unless `verifyIndex` would find the chain
 * unbroken and no sealed session altered or missing, since only then does
 * the index name every blob sealed content references.
 *
 * Runs under the index lock and does nothing while another process holds
 * it. A session with events being sealed is left for a later run, as is
 * everything once `budgetMs` of `clock` time has passed. `isAlive(pid)`
 * says whether a lock's owner still runs. Never throws.
 */
export function applyRetention(root, { now = Date.now(), budgetMs = Infinity, clock = defaultClock, isAlive = processIsAlive } = {}) {
  let contentRemoved = 0;
  let contentUnverifiable = 0;
  let blobSweep = { skipped: true, reason: 'the run stopped before the sweep' };
  const withinBudget = budget(clock, budgetMs);
  const skip = reason => { blobSweep = { skipped: true, reason }; };
  try {
    const cutoff = now - readConfig(root).contentRetentionDays * DAY_MS;
    const ran = withIndexLock(root, { now, isAlive }, () => {
      const index = readIndex(root);
      if (index === null) return skip('the index could not be read');
      const sessions = listSessions(root);
      recoverInterrupted(root, sessions, index);
      for (const [sessionId, kinds] of sessions) {
        if (!kinds.has(SEALED) || kinds.has(CLAIMED_SUFFIX) || kinds.has(SEAL_TEMP_SUFFIX)) continue;
        const latest = index.latest.get(sessionId);
        if (latest === undefined) {
          try {
            if (statSync(sessionFile(root, sessionId, SEALED)).mtimeMs < cutoff) contentUnverifiable++;
          } catch {
            // gone since it was listed
          }
          continue;
        }
        if (latest.contentExpired === true || latest.lastTs === null || !(Date.parse(latest.lastTs) < cutoff)) continue;
        if (!withinBudget()) return skip('the time budget was spent');
        try {
          const outcome = expireSession(root, sessionId, index);
          if (outcome === 'removed') contentRemoved++;
          if (outcome === 'unverifiable') contentUnverifiable++;
        } catch {
          // this session is left for a later run
        }
        if (index.appendFailed) return skip('an index append failed');
      }
      const check = checkIndex(root, withinBudget);
      if (check === null) return skip('the time budget was spent');
      const untrusted = untrustedBecause(check.result);
      if (untrusted !== null) return skip(untrusted);
      removeUnreferencedBlobs(root, check.sessions, check.index, now);
      blobSweep = { skipped: false, reason: null };
    });
    if (!ran) skip('another process holds the index lock');
  } catch {
    // nothing more is expired this run
  }
  return { contentRemoved, contentUnverifiable, blobSweep };
}

/** `verifyIndex`'s result, with the index and sessions it was computed
 * from; null when the index cannot be read or `withinBudget` turns false
 * before every sealed file is checked. */
function checkIndex(root, withinBudget) {
  const sessionsMissing = [];
  const sessionsAltered = [];
  const sessionsPending = [];
  const index = readIndex(root);
  if (index === null) return null;
  let brokenAt = null;
  for (let i = 0; i < index.lines.length && brokenAt === null; i++) {
    const { record } = index.lines[i];
    const expected = i === 0 ? null : sha256Hex(index.lines[i - 1].bytes);
    if (record === null || record.prev !== expected) brokenAt = i + 1;
  }
  const sessions = listSessions(root);
  for (const sessionId of [...new Set([...index.latest.keys(), ...sessions.keys()])].sort()) {
    const latest = index.latest.get(sessionId);
    const kinds = sessions.get(sessionId) ?? new Set();
    if (latest === undefined) {
      if (kinds.has(SEALED)) sessionsAltered.push(sessionId);
      continue;
    }
    if (!withinBudget()) return null;
    let matches = false;
    try {
      matches = matchesIndex(readCompressed(sessionFile(root, sessionId, SEALED)), latest);
    } catch {
      // unreadable: judged below as not matching
    }
    if (matches) continue;
    if (kinds.has(SEAL_TEMP_SUFFIX) && tempMatchesIndex(root, sessionId, latest)) sessionsPending.push(sessionId);
    else if (kinds.has(SEALED)) sessionsAltered.push(sessionId);
    else sessionsMissing.push(sessionId);
  }
  const intact = brokenAt === null && sessionsMissing.length === 0 && sessionsAltered.length === 0;
  return { result: { intact, brokenAt, sessionsMissing, sessionsAltered, sessionsPending }, index, sessions };
}

/**
 * Whether the index and the sealed sessions are as sealed. `brokenAt` is
 * the 1-based number of the first index line that is not an index record,
 * whose `prev` is not the SHA-256 of the line before it, or, as the first
 * line, has a `prev`; deleting a line therefore breaks the chain at that
 * line's position, and so does a line torn by a crash. Each session's
 * sealed file must match its latest index line. A session whose sealed file
 * does not, but whose temporary file does, is in `sessionsPending`: an
 * interrupted seal or rewrite the next run finishes. Otherwise one whose
 * sealed file is absent is in `sessionsMissing`, and one whose file
 * differs, cannot be read, or has no index line is in `sessionsAltered`.
 * `intact` is true only when the chain is unbroken and no session is
 * missing or altered. Events not yet sealed are not checked. Never throws.
 */
export function verifyIndex(root) {
  return checkIndex(root, () => true)?.result
    ?? { intact: false, brokenAt: 1, sessionsMissing: [], sessionsAltered: [], sessionsPending: [] };
}
