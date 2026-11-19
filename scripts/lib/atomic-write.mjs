// scripts/lib/atomic-write.mjs
//
// How the kit replaces a file in the per-machine data directory so that a
// reader, or a writer in another process, finds the old file or the new one
// and never a partial one. The installed scripts cannot import it and keep
// their own (harness-log.mjs).
//
// A repository file is replaced by `replaceFile` in manifest.mjs instead,
// which differs on purpose: it writes through a link at the path, keeps the
// file's mode and refuses a read-only target, where this replaces whatever
// is at the path and so never writes through a link.
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Writes `text` to a new temporary file beside `path`, whose directory must
 * exist, and renames it over `path`. The temporary name is unique to the
 * call, so two processes may write the same path at once. On any failure
 * the temporary file is removed, `path` is as it was, and the error is
 * thrown.
 */
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
