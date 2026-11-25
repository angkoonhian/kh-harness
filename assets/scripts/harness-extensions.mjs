// assets/scripts/harness-extensions.mjs
//
// The PreToolUse extensions another plugin registers: reading
// `.claude/kh-harness/extensions.json` and judging each module it lists by
// its path and its hash, without loading it.
//
// The file and the modules are the repository's, so a pull request can plant
// them. Every byte is read within a bound; a field is accepted only in a
// fixed character set, since `id`, `version` and `module` are printed into
// hook output and into the committed report; a problem is fixed text that
// quotes nothing from the file; no directory between the repository root and
// the file may be a link; and a module is judged only where its real path
// lies under the repository's real `.claude/` and outside its
// `.claude/scripts/`. Installed beside the other hook scripts, so it imports
// only Node built-ins and sibling files.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { lfNormalised, lfSha256, OVER_LIMIT, readBounded } from './harness-log.mjs';

/** SHA-256 hex of a module's bytes with each CRLF made LF, the hash an
 * extension's entry records. */
export { lfSha256 as moduleSha256 };

export const EXTENSIONS_PATH = '.claude/kh-harness/extensions.json';

/** `moduleMaxBytes` bounds a module file as it is on disk, before its line
 * endings are normalised. */
export const EXTENSION_LIMITS = Object.freeze({ fileMaxBytes: 65536, entriesMax: 8, moduleMaxBytes: 1024 * 1024, messageMax: 300 });

const PARENT_DIRS = ['.claude', '.claude/kh-harness'];
const SCRIPTS_DIR = '.claude/scripts';
const ENTRY_KEYS = ['id', 'version', 'module', 'sha256', 'onFailure'];
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const MODULE = /^\.claude\/[A-Za-z0-9._/-]+\.mjs$/;
const MODULE_MAX = 200;
const SHA256 = /^[0-9a-f]{64}$/;
const ON_FAILURE = new Set(['block', 'allow']);
// Without O_NONBLOCK, opening a FIFO waits for a writer; without
// O_NOFOLLOW, a final component swapped for a link after `realpath` is
// followed. Neither flag exists on win32, which has neither hazard.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

const malformed = problem => ({ state: 'malformed', problem });

// A segment ending in `.` or a space is one win32 strips, so the file run
// would not be the one printed. Case is folded wherever two module paths are
// compared, since a case-insensitive file system names one file both ways.
const isModulePath = m => typeof m === 'string' && m.length <= MODULE_MAX && MODULE.test(m)
  && m.split('/').every(segment => segment !== '' && !segment.endsWith('.') && !segment.endsWith(' '));

const isUnderScripts = m => m.toLowerCase().startsWith(`${SCRIPTS_DIR}/`);

function isEntry(e) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return false;
  const keys = Object.keys(e);
  if (keys.length !== ENTRY_KEYS.length || !ENTRY_KEYS.every(k => keys.includes(k))) return false;
  return typeof e.id === 'string' && ID.test(e.id)
    && typeof e.version === 'string' && VERSION.test(e.version)
    && isModulePath(e.module)
    && typeof e.sha256 === 'string' && SHA256.test(e.sha256)
    && ON_FAILURE.has(e.onFailure);
}

const hasDuplicate = values => new Set(values).size !== values.length;

/** The `lstat` of `path`, or null when nothing is there. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** The extensions file under `root`: `absent`, `malformed` with a fixed
 * `problem`, or `ok` with its entries in order. One bad entry, or two with
 * one id or one module, makes the whole file malformed. `root` itself may be
 * reached through a link; `.claude` and `.claude/kh-harness` may not. Never
 * throws. */
export function readExtensions(root) {
  try {
    for (const dir of PARENT_DIRS) {
      const st = lstatOrNull(join(root, dir));
      if (st === null) return { state: 'absent' };
      if (!st.isDirectory()) return malformed('.claude or .claude/kh-harness is a link or not a directory');
    }
    const path = join(root, EXTENSIONS_PATH);
    const st = lstatOrNull(path);
    if (st === null) return { state: 'absent' };
    if (!st.isFile()) return malformed('it is not a regular file');
    let bytes;
    try {
      bytes = readBounded(path, EXTENSION_LIMITS.fileMaxBytes);
    } catch (error) {
      if (error?.code === OVER_LIMIT) return malformed(`it is larger than ${EXTENSION_LIMITS.fileMaxBytes} bytes`);
      throw error;
    }
    let list;
    try {
      list = JSON.parse(bytes.toString('utf8'));
    } catch {
      return malformed('it is not JSON');
    }
    if (!Array.isArray(list)) return malformed('it is not a JSON array');
    if (list.length > EXTENSION_LIMITS.entriesMax) return malformed(`it lists more than ${EXTENSION_LIMITS.entriesMax} extensions`);
    if (hasDuplicate(list.flatMap(e => typeof e?.id === 'string' ? [e.id] : []))) return malformed('two entries share an id');
    if (hasDuplicate(list.flatMap(e => typeof e?.module === 'string' ? [e.module.toLowerCase()] : []))) return malformed('two entries share a module');
    const bad = list.findIndex(e => !isEntry(e));
    if (bad !== -1) return malformed(`entry ${bad + 1} is not an extension entry as docs/CONTRACT.md describes one`);
    const scripts = list.findIndex(e => isUnderScripts(e.module));
    if (scripts !== -1) return malformed(`entry ${scripts + 1} names a module under .claude/scripts/, where the kit keeps its own hooks`);
    return { state: 'ok', entries: list.map(({ id, version, module, sha256, onFailure }) => ({ id, version, module, sha256, onFailure })) };
  } catch {
    return malformed('it could not be read');
  }
}

/** The bytes of the regular file at `path`, read from one descriptor so the
 * file measured is the file read; null when it is not a regular file or
 * holds more than `maxBytes`. Throws what the file system throws. */
function readFileWithin(path, maxBytes) {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    for (let n; length < buf.length && (n = readSync(fd, buf, length, buf.length - length, null)) > 0;) length += n;
    return length > maxBytes ? null : Buffer.from(buf.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

const isUnder = (path, dir) => path.startsWith(dir + sep);

/** The real path of `dir` under `realRoot`, or null when there is none. */
function realDir(realRoot, dir) {
  try {
    return realpathSync.native(join(realRoot, dir));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** How the module `entry` names under `root` stands, decided in this order:
 * `missing` when nothing resolves at its path, or `unreadable` when the path
 * cannot be resolved for another reason; `outside` when the real `.claude/`
 * is not in the repository, or the module's real path is not under it or is
 * under the real `.claude/scripts/`; `unreadable` when it is not a regular
 * file of at most `moduleMaxBytes`; then `matches`, with its real absolute
 * path and the LF-normalised bytes that were hashed, or `differs`. Never
 * throws. */
export function moduleState(root, entry) {
  try {
    let real;
    try {
      real = realpathSync.native(join(root, entry.module));
    } catch (error) {
      return { state: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
    const realRoot = realpathSync.native(root);
    const base = realDir(realRoot, '.claude');
    const scripts = realDir(realRoot, SCRIPTS_DIR);
    if (base === null || !isUnder(base, realRoot) || !isUnder(real, base) || (scripts !== null && isUnder(real, scripts))) return { state: 'outside' };
    const raw = readFileWithin(real, EXTENSION_LIMITS.moduleMaxBytes);
    if (raw === null) return { state: 'unreadable' };
    const bytes = lfNormalised(raw);
    return lfSha256(bytes) === entry.sha256 ? { state: 'matches', path: real, bytes } : { state: 'differs' };
  } catch {
    return { state: 'unreadable' };
  }
}
