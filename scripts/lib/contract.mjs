// scripts/lib/contract.mjs
//
// The contract number another plugin reads before it installs into a
// repository: `.claude/kh-harness/contract.json`, written by `apply` only
// beside the installed files whose behaviour the number promises
// (`CONTRACT_FILES` in propose.mjs). The number says what those files do when
// they run, never whether anything registers them.
//
// The file is read as the extensions loader reads its own: it must be a file
// of the repository itself, so a link at it, at `.claude/kh-harness`, or at a
// `.claude` through which it is reached is no contract number.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { STAMP_MARKER } from './render.mjs';

export const CONTRACT = 1;
export const CONTRACT_PATH = '.claude/kh-harness/contract.json';

const MAX_BYTES = 65536;
// As harness-extensions.mjs opens its file: without O_NONBLOCK a FIFO waits
// for a writer, and without O_NOFOLLOW a file swapped for a link after its
// lstat is followed. Neither flag exists on win32.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** The contract file this kit writes. The version is followed by a space so
 * `stampVersion` reads it. */
export function contractFileText(kitVersion) {
  return JSON.stringify({
    contract: CONTRACT,
    generatedBy: `${STAMP_MARKER} ${kitVersion} (the contract number another plugin reads). Do not edit: kh-harness stops updating an edited copy and keeps it on uninstall.`,
  }, null, 2) + '\n';
}

const isLinkError = error => error?.code === 'ELOOP' || error?.code === 'EMLINK';

/** The `lstat` of `path`, or null when nothing is there. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The bytes of the regular file at `path` read from one descriptor, or
 * null when it is not a regular file or holds more than `MAX_BYTES`. */
function readWithin(path) {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.allocUnsafe(MAX_BYTES + 1);
    let length = 0;
    for (let n; length < buf.length && (n = readSync(fd, buf, length, buf.length - length, null)) > 0;) length += n;
    return length > MAX_BYTES ? null : buf.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** True when something is at `path`, following links. */
function reached(path) {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

const UNREADABLE = Object.freeze({ state: 'unreadable' });
const throughLink = link => ({ state: 'unreadable', link });

/** What the contract file under `root` says: `absent`; `ok` with its
 * `contract`, an integer of 1 or more; or `unreadable`, with `link`, the
 * path that is a link, when it is reached through one. Never throws. */
export function contractEvidence(root) {
  try {
    const claude = lstatOrNull(join(root, '.claude'));
    if (claude === null) return { state: 'absent' };
    if (claude.isSymbolicLink()) return reached(join(root, CONTRACT_PATH)) ? throughLink('.claude') : { state: 'absent' };
    if (!claude.isDirectory()) return UNREADABLE;
    const dir = lstatOrNull(join(root, '.claude/kh-harness'));
    if (dir === null) return { state: 'absent' };
    if (dir.isSymbolicLink()) return throughLink('.claude/kh-harness');
    if (!dir.isDirectory()) return UNREADABLE;
    const path = join(root, CONTRACT_PATH);
    const file = lstatOrNull(path);
    if (file === null) return { state: 'absent' };
    if (file.isSymbolicLink()) return throughLink(CONTRACT_PATH);
    let bytes;
    try {
      bytes = readWithin(path);
    } catch (error) {
      return isLinkError(error) ? throughLink(CONTRACT_PATH) : UNREADABLE;
    }
    if (bytes === null) return UNREADABLE;
    const value = JSON.parse(bytes.toString('utf8'));
    const ok = value !== null && typeof value === 'object' && !Array.isArray(value) && Number.isInteger(value.contract) && value.contract >= 1;
    return ok ? { state: 'ok', contract: value.contract } : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}
