// scripts/lib/ledger.mjs
//
// The learning ledger: one line per event in a learning's life, appended
// to `ledger.jsonl` in the repository's per-machine data directory and
// hash-chained, each line carrying the SHA-256 of the line before it. It is
// never committed, so no merge can break the chain. Only the kit's CLI
// writes it.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, repoDataDir } from '../../assets/scripts/harness-log.mjs';

export const LEDGER_KINDS = Object.freeze(['proposed', 'replayed', 'rejected', 'trial', 'promoted', 'demoted', 'suspended', 'retired', 'landed', 'reverted', 'wrong']);

// A lock records its writer's pid, and a lock whose writer is alive is
// never broken. A lock without a readable owner is broken only once it is
// this old: a writer holds the lock for milliseconds, and leaves it ownerless
// only between creating it and writing its owner.
export const LEDGER_LOCK_STALE_MS = 30_000;

const LEDGER_FILE = 'ledger.jsonl';
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 5;
// On win32 a lock file another process is deleting refuses a new `wx` open
// with EPERM, not EEXIST, until the delete completes.
const LOCK_CONTENDED = new Set(['EEXIST', 'EPERM', 'EBUSY']);

const NEWLINE = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = v => typeof v === 'string' && v.length > 0;
const isTimestamp = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isSha256 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

// Evidence references what was seen, never what was said: a signature id,
// counts and a time span. Any other key is refused, so no excerpt can ride
// along.
const EVIDENCE_FIELDS = {
  signature: isNonEmptyString,
  sessions: v => Number.isSafeInteger(v) && v >= 0,
  firstTs: isTimestamp,
  lastTs: isTimestamp,
  external: v => typeof v === 'boolean',
};

const ENTRY_FIELDS = {
  kind: v => LEDGER_KINDS.includes(v),
  learningId: isNonEmptyString,
  contentSha256: isSha256,
  base: isNonEmptyString,
  learned: isNonEmptyString,
  approvedBy: v => v === null || v === 'owner' || (typeof v === 'string' && v.startsWith('policy:') && v.length > 'policy:'.length),
};

const STORED_FIELDS = {
  ...ENTRY_FIELDS,
  ts: isTimestamp,
  prev: v => v === null || isSha256(v),
};

function evidenceProblem(evidence) {
  if (!isPlainObject(evidence)) return 'evidence is not an object';
  for (const key of Object.keys(evidence)) {
    if (!Object.hasOwn(EVIDENCE_FIELDS, key)) return `evidence has unknown field "${key}"`;
  }
  for (const [field, valid] of Object.entries(EVIDENCE_FIELDS)) {
    if (!valid(evidence[field])) return `evidence.${field} is missing or invalid`;
  }
  return null;
}

/** Why `value` is not an entry under `fields` plus `evidence` and an
 * optional string `detail`, or null when it is one. */
function entryProblem(value, fields) {
  if (!isPlainObject(value)) return 'entry is not an object';
  for (const key of Object.keys(value)) {
    if (key !== 'evidence' && key !== 'detail' && !Object.hasOwn(fields, key)) return `unknown field "${key}"`;
  }
  for (const [field, valid] of Object.entries(fields)) {
    if (!valid(value[field])) return `${field} is missing or invalid`;
  }
  if (value.detail !== undefined && typeof value.detail !== 'string') return 'detail is not a string';
  return evidenceProblem(value.evidence);
}

const ledgerPath = root => join(repoDataDir(root), LEDGER_FILE);

/** The ledger's bytes, or null when the file is absent; any other read
 * failure throws. */
function ledgerBytes(root) {
  try {
    return readFileSync(ledgerPath(root));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
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

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const isLockOwner = v => isPlainObject(v) && Number.isSafeInteger(v.pid) && v.pid > 0 && isNonEmptyString(v.token);

/** Whether a process with this pid exists; EPERM means it does, owned by
 * another user. */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/** The lock file's bytes and modification time, or null when it cannot be
 * read. The stat follows the read, so a file replaced in between is judged
 * by the newer, younger mtime. */
function readLock(path) {
  try {
    const bytes = readFileSync(path);
    return { bytes, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function lockOwner(bytes) {
  try {
    const owner = JSON.parse(utf8.decode(bytes));
    return isLockOwner(owner) ? owner : null;
  } catch {
    return null;
  }
}

function isBreakable(lock, at, isAlive) {
  const owner = lockOwner(lock.bytes);
  return owner !== null ? !isAlive(owner.pid) : at - lock.mtimeMs > LEDGER_LOCK_STALE_MS;
}

/** Creates `path` exclusively with this writer as its owner and returns the
 * owner's token; contention throws the `wx` open's error. */
function createLock(path) {
  const token = randomUUID();
  const fd = openSync(path, 'wx');
  let written = false;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    written = true;
  } finally {
    closeSync(fd);
    if (!written) unlinkQuietly(path);
  }
  return token;
}

function unlinkQuietly(path) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

const holdsLock = (path, token) => {
  const lock = readLock(path);
  return lock !== null && lockOwner(lock.bytes)?.token === token;
};

/** Removes the lock only while it is still this writer's; never throws. */
function releaseLock(path, token) {
  if (holdsLock(path, token)) unlinkQuietly(path);
}

/** Removes `path` when it still holds the bytes judged breakable and is
 * still breakable now, and says whether it did. */
function removeIfUnchanged(path, judged, at, isAlive) {
  const again = readLock(path);
  if (again === null || !again.bytes.equals(judged.bytes) || !isBreakable(again, at, isAlive)) return false;
  return unlinkQuietly(path);
}

/**
 * Removes the ledger lock when it is breakable, and says whether it did.
 * Breakers are serialised by a second lock beside it, so of two writers
 * that judged one lock breakable only one removes it, and the other then
 * finds different bytes. The second lock is broken by the same rule.
 */
function breakLock(lockPath, at, isAlive) {
  const judged = readLock(lockPath);
  if (judged === null || !isBreakable(judged, at, isAlive)) return false;
  const mutexPath = `${lockPath}.break`;
  let token;
  try {
    token = createLock(mutexPath);
  } catch (error) {
    if (!LOCK_CONTENDED.has(error?.code)) throw error;
    const holder = readLock(mutexPath);
    if (holder !== null && isBreakable(holder, at, isAlive)) removeIfUnchanged(mutexPath, holder, at, isAlive);
    return false;
  }
  try {
    return removeIfUnchanged(lockPath, judged, at, isAlive);
  } finally {
    releaseLock(mutexPath, token);
  }
}

/**
 * Runs `fn` holding the ledger's lock file, so a read of the last line and
 * the append that chains to it are one step across processes. `fn` gets a
 * check to call immediately before it writes, which throws when the lock is
 * no longer this writer's.
 */
function withLock(dir, { now, isAlive }, fn) {
  const lockPath = join(dir, `${LEDGER_FILE}.lock`);
  const deadline = now() + LOCK_WAIT_MS;
  let token;
  for (;;) {
    try {
      token = createLock(lockPath);
      break;
    } catch (error) {
      if (!LOCK_CONTENDED.has(error?.code)) throw error;
      if (error.code === 'EEXIST' && breakLock(lockPath, now(), isAlive)) continue;
      if (now() >= deadline) throw new Error(`ledger is locked: ${lockPath} has been held for over ${LOCK_WAIT_MS} ms (last error ${error.code})`);
      pause(LOCK_RETRY_MS);
    }
  }
  const assertHeld = () => {
    if (!holdsLock(lockPath, token)) throw new Error(`ledger lock lost: ${lockPath} is no longer this writer's; nothing was written`);
  };
  try {
    return fn(assertHeld);
  } finally {
    releaseLock(lockPath, token);
  }
}

/**
 * Appends one event to the ledger, adding `ts` (now) and `prev` (the
 * SHA-256 of the previous line's bytes, null for the first line). Throws,
 * writing nothing, when the entry is not the ledger's schema; the caller
 * supplies neither `ts` nor `prev`. `now` is the clock for `ts`, the lock
 * wait and the age of an ownerless lock; `isAlive` says whether a lock's
 * writer is still running.
 */
export function appendLedger(root, entry, { now = Date.now, isAlive = defaultIsAlive } = {}) {
  const problem = entryProblem(entry, ENTRY_FIELDS);
  if (problem !== null) throw new Error(`ledger entry refused: ${problem}`);
  const { kind, learningId, contentSha256, evidence, base, learned, approvedBy, detail } = entry;
  const { signature, sessions, firstTs, lastTs, external } = evidence;
  const dir = repoDataDir(root);
  mkdirSync(dir, { recursive: true });
  withLock(dir, { now, isAlive }, assertHeld => {
    const buf = ledgerBytes(root) ?? Buffer.alloc(0);
    const lines = splitLines(buf);
    const prev = lines.length === 0 ? null : sha256Hex(lines.at(-1));
    const record = {
      kind, learningId, contentSha256,
      evidence: { signature, sessions, firstTs, lastTs, external },
      base, learned, approvedBy, detail,
      ts: new Date(now()).toISOString(),
      prev,
    };
    // A torn last line stays a line of its own, which `verifyLedger` reports.
    const torn = buf.length > 0 && buf.at(-1) !== NEWLINE;
    assertHeld();
    appendFileSync(ledgerPath(root), `${torn ? '\n' : ''}${canonicalJson(record)}\n`, 'utf8');
  });
}

/** Every ledger entry in order, without checking the chain; `verifyLedger`
 * does that. An absent ledger is empty; a line that does not parse throws. */
export function readLedger(root) {
  const buf = ledgerBytes(root);
  return (buf === null ? [] : splitLines(buf)).map((line, i) => {
    try {
      return JSON.parse(utf8.decode(line));
    } catch {
      throw new Error(`ledger line ${i + 1} does not parse`);
    }
  });
}

/**
 * Whether the ledger is one unbroken chain. `brokenAt` is the 1-based number
 * of the first line the chain cannot vouch for: one that is unreadable, does
 * not parse or is not the schema; the first line when its `prev` is not
 * null; or a line whose successor's `prev` is not its hash. An edit to the
 * last line leaves no successor to catch it. A ledger that cannot be read
 * at all is broken at line 1. Never throws.
 */
export function verifyLedger(root) {
  let buf;
  try {
    buf = ledgerBytes(root);
  } catch {
    return { intact: false, brokenAt: 1 };
  }
  const lines = buf === null ? [] : splitLines(buf);
  for (let i = 0; i < lines.length; i++) {
    let parsed;
    try {
      parsed = JSON.parse(utf8.decode(lines[i]));
    } catch {
      return { intact: false, brokenAt: i + 1 };
    }
    if (entryProblem(parsed, STORED_FIELDS) !== null) return { intact: false, brokenAt: i + 1 };
    if (i === 0 && parsed.prev !== null) return { intact: false, brokenAt: 1 };
    if (i > 0 && parsed.prev !== sha256Hex(lines[i - 1])) return { intact: false, brokenAt: i };
  }
  return { intact: true, brokenAt: null };
}
