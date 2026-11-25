// assets/scripts/harness-extensions.mjs
//
// The PreToolUse extensions another plugin registers: reading
// `.claude/kh-harness/extensions.json` and judging each module it lists by
// its path and its hash, without loading it.
//
// The file and the modules are the repository's, so a pull request can plant
// them. Every byte is read through `readBounded`; a field is accepted only in
// a fixed character set, since `id`, `version` and `module` are printed into
// hook output and into the committed report; a problem is fixed text that
// quotes nothing from the file; and a module is judged only where its real
// path lies under the repository's real `.claude/`. Installed beside the
// other hook scripts, so it imports only Node built-ins and sibling files.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { OVER_LIMIT, readBounded } from './harness-log.mjs';

export const EXTENSIONS_PATH = '.claude/kh-harness/extensions.json';

export const EXTENSION_LIMITS = Object.freeze({ fileMaxBytes: 65536, entriesMax: 8, moduleMaxBytes: 1024 * 1024, messageMax: 300 });

const ENTRY_KEYS = ['id', 'version', 'module', 'sha256', 'onFailure'];
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const MODULE = /^\.claude\/[A-Za-z0-9._/-]+\.mjs$/;
const MODULE_MAX = 200;
const SHA256 = /^[0-9a-f]{64}$/;
const ON_FAILURE = new Set(['block', 'allow']);

const malformed = problem => ({ state: 'malformed', problem });

/** SHA-256 hex of `bytes` with each CRLF made LF, so a checkout that turned
 * line endings to CRLF hashes as the extension's author recorded. latin1
 * maps each byte to one code unit, so nothing else changes and a lone CR
 * stays. */
export function moduleSha256(bytes) {
  const lf = bytes.includes(0x0d) ? Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : bytes;
  return createHash('sha256').update(lf).digest('hex');
}

const isModulePath = m => typeof m === 'string' && m.length <= MODULE_MAX && MODULE.test(m)
  && m.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');

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

/** The extensions file under `root`: `absent`, `malformed` with a fixed
 * `problem`, or `ok` with its entries in order. One bad entry, or two with
 * one id, makes the whole file malformed. Never throws. */
export function readExtensions(root) {
  try {
    const path = join(root, EXTENSIONS_PATH);
    let st;
    try {
      st = lstatSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'absent' };
      throw error;
    }
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
    const ids = list.flatMap(e => typeof e?.id === 'string' ? [e.id] : []);
    if (new Set(ids).size !== ids.length) return malformed('two entries share an id');
    const bad = list.findIndex(e => !isEntry(e));
    if (bad !== -1) return malformed(`entry ${bad + 1} is not an extension entry as docs/CONTRACT.md describes one`);
    return { state: 'ok', entries: list.map(({ id, version, module, sha256, onFailure }) => ({ id, version, module, sha256, onFailure })) };
  } catch {
    return malformed('it could not be read');
  }
}

/** How the module `entry` names under `root` stands: `matches` with its real
 * absolute path, `differs`, `missing`, `outside` (its real path, or the real
 * `.claude/`, is not where the entry says) or `unreadable`. The checks run in
 * that order, so a module both outside and changed reports `outside`. Never
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
    const base = realpathSync.native(join(realRoot, '.claude')) + sep;
    if (!base.startsWith(realRoot + sep) || !real.startsWith(base)) return { state: 'outside' };
    const bytes = readBounded(real, EXTENSION_LIMITS.moduleMaxBytes);
    return moduleSha256(bytes) === entry.sha256 ? { state: 'matches', path: real } : { state: 'differs' };
  } catch {
    return { state: 'unreadable' };
  }
}
