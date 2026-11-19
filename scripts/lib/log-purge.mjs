// scripts/lib/log-purge.mjs
//
// `log purge`: what removing this repository's data directory would remove,
// and the removal. Only that one directory is ever removed, and only while
// `checkDataDir` clears it; the check is repeated immediately before each
// write and before the removal, so a directory swapped for a link after the
// plan is refused rather than followed.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { sessionIds } from './recurrence.mjs';
import { assertDataDirSafe, checkDataDir, diskUsage, formatBytes, logCommand, recordEnabled } from './log-lib.mjs';

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
    '',
    `Run with --yes to remove it:  ${logCommand(root, 'purge', '--yes')}`,
  ].join('\n');
}

/** Disables the log, so no hook writes into the directory meanwhile, then
 * removes it; a link inside it is removed as a link. Throws
 * `DataDirRefused` when the directory is no longer safe at either step, and
 * otherwise what the removal throws. */
export function purgeLog(root, target) {
  assertDataDirSafe(root);
  recordEnabled(root, false);
  assertDataDirSafe(root);
  rmSync(target.dir, { recursive: true });
}
