// scripts/lib/atomic-write.mjs
//
// The kit's one way of replacing a file so that a reader, or a writer in
// another process, finds the old file or the new one and never a partial
// one: in the per-machine data directory and in a repository alike. The
// installed scripts cannot import it and keep their own (harness-log.mjs).
import { randomBytes } from 'node:crypto';
import { readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The temporary files this module leaves beside `path` when a run is
 * killed between its write and its rename. */
const staleSiblings = path => {
  const ours = new RegExp(`^${escapeRegExp(basename(path))}\\.\\d+\\.[0-9a-f]{12}\\.tmp$`);
  return readdirSync(dirname(path)).filter(name => ours.test(name));
};

/**
 * Writes `text` to a new temporary file beside `path`, whose directory must
 * exist, and renames it over `path`. On any failure the temporary file is
 * removed, `path` is as it was, and the error is thrown.
 *
 * `clearStale` first removes every temporary file an earlier, killed run
 * left for this path, which nothing else would. It is for a file only one
 * process writes at a time: a concurrent writer's temporary file bears the
 * same form of name and would be removed under it.
 */
export function writeFileAtomic(path, text, { clearStale = false } = {}) {
  if (clearStale) for (const name of staleSiblings(path)) rmSync(join(dirname(path), name), { force: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
