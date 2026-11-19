// scripts/lib/atomic-write.mjs
//
// Replacing a file in the per-machine data directory so that a reader, or a
// writer in another process, finds the old file or the new one and never a
// partial one.
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** Writes `text` to a new temporary file beside `path`, whose directory must
 * exist, and renames it over `path`. On any failure the temporary file is
 * removed, `path` is as it was, and the error is thrown. */
export function writeFileAtomic(path, text) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
