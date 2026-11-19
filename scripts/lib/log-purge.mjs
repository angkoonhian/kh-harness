// scripts/lib/log-purge.mjs
//
// `log purge`: what removing this repository's data directory would remove,
// and the removal. Only that one directory is ever removed, and only while
// `checkDataDir` clears it; the check is repeated immediately before each
// write and before the removal, so a directory swapped for a link after the
// plan is refused rather than followed.
//
// The directory holds more than the log: the learning ledger, the
// learnings, the promotion policy and this machine's gate file. Removing it
// switches off every gate promoted on this machine and every local
// suspension of a committed gate, so the removal runs only with the result
// of the terminal check `requireInteractive` makes, as the `learn` steps
// that weaken a gate do, and holding the locks those files are written
// under.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { underIndexLock } from '../../assets/scripts/harness-seal.mjs';
import { DATA_DIR_LOCKS, LOCKED, withFileLock } from './file-lock.mjs';
import { assertDataDirSafe, checkDataDir, diskUsage, formatBytes, logCommand, recordEnabled } from './log-lib.mjs';
import { sessionIds } from './recurrence.mjs';
import { TERMINAL_CHECK } from './tty.mjs';

/** Why the library removed nothing when the terminal check did not pass. */
export const PURGE_NEEDS_TERMINAL = `purge --yes runs only from ${TERMINAL_CHECK}; nothing was removed`;

/** The one line the command ends with when `interactive`, what
 * `requireInteractive` returned, did not pass. */
export const purgeTerminalRefusal = interactive => `purge --yes refused: ${interactive.reason}; it runs only from ${TERMINAL_CHECK}, and nothing was removed.`;

/** What else the directory holds, and what removing it does. */
export const PURGE_ALSO_REMOVES = "Besides the session log, the directory holds the learning ledger, every learning, the promotion policy and this machine's gate file: removing it switches off every gate promoted on this machine and every local suspension of a committed gate. Gates landed in the repository stay.";

const sizeOf = path => {
  try {
    return lstatSync(path).size;
  } catch {
    return null;
  }
};

/**
 * `checkDataDir`'s verdict and, when it is `'ok'`, what the directory holds:
 * its size, its top-level entries with theirs (null when an entry cannot be
 * read) and its session count (null when the sessions cannot be listed).
 * Never throws.
 */
export function purgeTarget(root) {
  const check = checkDataDir(root);
  if (check.state !== 'ok') return check;
  let names;
  try {
    names = readdirSync(check.dir, { withFileTypes: true });
  } catch (error) {
    return { state: 'refused', dir: check.dir, reason: `it cannot be listed (${error?.code ?? 'unknown error'})` };
  }
  const entries = names.map(e => {
    const path = join(check.dir, e.name);
    return e.isDirectory() ? { name: `${e.name}/`, bytes: diskUsage(path).bytes } : { name: e.name, bytes: sizeOf(path) };
  }).sort((a, b) => (a.name < b.name ? -1 : 1));
  let sessions = null;
  try {
    sessions = sessionIds(root).length;
  } catch {
    // shown as not counted
  }
  return { state: 'ok', dir: check.dir, usage: diskUsage(check.dir), entries, sessions };
}

export function renderPurgePlan(root, target) {
  const size = target.usage.unreadable > 0 ? `${formatBytes(target.usage.bytes)} at least` : formatBytes(target.usage.bytes);
  const sessions = target.sessions === null ? 'sessions not counted' : `${target.sessions} sessions`;
  return [
    `Would remove ${target.dir} (${size}, ${sessions}):`,
    ...target.entries.map(e => `  ${e.name}  ${e.bytes === null ? 'size unreadable' : formatBytes(e.bytes)}`),
    'This is everything the kit keeps for this repository on this machine; nothing else is touched.',
    PURGE_ALSO_REMOVES,
    '',
    `Run with --yes to remove it, which runs only from ${TERMINAL_CHECK}:  ${logCommand(root, 'purge', '--yes')}`,
  ].join('\n');
}

// A hook that read the log as enabled just before the purge can still append
// one event after the removal, recreating the directory. The removal is
// followed by this many looks, a pause before each, and whatever reappeared
// is removed again.
const SETTLE_LOOKS = 3;
const SETTLE_PAUSE_MS = 50;
const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTLE_PAUSE_MS);

/** Removes the directory, then what a late hook write put back. */
function removeAndSettle(root, dir, pause) {
  rmSync(dir, { recursive: true });
  for (let look = 0; look < SETTLE_LOOKS; look++) {
    pause();
    if (checkDataDir(root).state === 'absent') continue;
    assertDataDirSafe(root);
    rmSync(dir, { recursive: true });
  }
}

/** Runs `fn` holding the data directory's three locks, or returns the name
 * of the first one another process held for the whole wait. */
function underDataDirLocks(root, dir, now, fn) {
  let held = 'learnings';
  try {
    return withFileLock(join(dir, DATA_DIR_LOCKS.learnings), { name: 'learnings', now }, () => {
      held = 'ledger';
      return withFileLock(join(dir, DATA_DIR_LOCKS.ledger), { name: 'ledger', now }, () => {
        let result;
        const outcome = underIndexLock(root, () => { result = fn(); });
        return outcome === 'ran' ? result : { lockedBy: 'index' };
      });
    });
  } catch (error) {
    if (error?.code === LOCKED) return { lockedBy: held };
    throw error;
  }
}

/**
 * Removes the repository's data directory: `{ removed: true }`, or
 * `{ removed: false, reason }` when nothing was removed. `interactive` is
 * what `requireInteractive` returned, and anything but its pass is a
 * refusal. The removal holds the learnings, ledger and index locks, so no
 * `learn` step or sealing run is part-way through a write; it first
 * disables the log, so no hook starts a write into the directory, and a
 * link inside the directory is removed as a link. Throws `DataDirRefused`
 * when the directory is no longer safe at any step, and otherwise what the
 * removal throws. `now` is the clock for the lock waits and `pause` what
 * waits between the looks after the removal.
 */
export function purgeLog(root, target, { interactive, now = Date.now, pause = sleep } = {}) {
  if (interactive?.ok !== true) return { removed: false, reason: PURGE_NEEDS_TERMINAL };
  assertDataDirSafe(root);
  const done = underDataDirLocks(root, target.dir, now, () => {
    assertDataDirSafe(root);
    recordEnabled(root, false);
    assertDataDirSafe(root);
    removeAndSettle(root, target.dir, pause);
    return { removed: true };
  });
  return done.lockedBy === undefined ? done : { removed: false, reason: `another process holds the ${done.lockedBy} lock; nothing was removed` };
}
