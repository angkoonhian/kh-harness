// scripts/lib/file-lock.mjs
//
// A lock across processes on this machine: a file created exclusively that
// holds its writer's `{ pid, token }`. Only the writer holding the token
// removes it, and another writer breaks it only when its pid is not alive.
// Used by the kit's CLI for the files in the per-machine data directory that
// two sessions may update at once.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

// A lock records its writer's pid, and a lock whose writer is alive is
// never broken. A lock without a readable owner is broken only once it is
// this old: a writer holds the lock for milliseconds, and leaves it ownerless
// only between creating it and writing its owner.
export const LOCK_STALE_MS = 30_000;

const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 5;
// On win32 a lock file another process is deleting refuses a new `wx` open
// with EPERM, not EEXIST, until the delete completes.
const LOCK_CONTENDED = new Set(['EEXIST', 'EPERM', 'EBUSY']);

const utf8 = new TextDecoder('utf-8', { fatal: true });

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = v => typeof v === 'string' && v.length > 0;

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const isLockOwner = v => isPlainObject(v) && Number.isSafeInteger(v.pid) && v.pid > 0 && isNonEmptyString(v.token);

/** Whether a process with this pid exists; EPERM means it does, owned by
 * another user. */
export function isProcessAlive(pid) {
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
  return owner !== null ? !isAlive(owner.pid) : at - lock.mtimeMs > LOCK_STALE_MS;
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
 * Removes the lock when it is breakable, and says whether it did. Breakers
 * are serialised by a second lock beside it, so of two writers that judged
 * one lock breakable only one removes it, and the other then finds different
 * bytes. The second lock is broken by the same rule.
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
 * Runs `fn` holding the lock file `lockPath`, whose directory must exist.
 * `fn` gets a check to call immediately before each write, which throws when
 * the lock is no longer this writer's. `name` names what is locked in the
 * errors thrown; `now` is the clock for the wait and the age of an ownerless
 * lock; `isAlive` says whether a lock's writer is still running.
 */
export function withFileLock(lockPath, { name, now = Date.now, isAlive = isProcessAlive }, fn) {
  const deadline = now() + LOCK_WAIT_MS;
  let token;
  for (;;) {
    try {
      token = createLock(lockPath);
      break;
    } catch (error) {
      if (!LOCK_CONTENDED.has(error?.code)) throw error;
      if (error.code === 'EEXIST' && breakLock(lockPath, now(), isAlive)) continue;
      if (now() >= deadline) throw new Error(`${name} is locked: ${lockPath} has been held for over ${LOCK_WAIT_MS} ms (last error ${error.code})`);
      pause(LOCK_RETRY_MS);
    }
  }
  const assertHeld = () => {
    if (!holdsLock(lockPath, token)) throw new Error(`${name} lock lost: ${lockPath} is no longer this writer's; nothing was written`);
  };
  try {
    return fn(assertHeld);
  } finally {
    releaseLock(lockPath, token);
  }
}
