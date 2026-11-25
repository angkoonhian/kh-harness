// assets/scripts/harness-extensions.mjs
//
// The PreToolUse extensions another plugin registers: reading
// `.claude/kh-harness/extensions.json`, judging each module it lists by its
// path and its hash, and, in the PreToolUse entry script, running each one
// that passes before the kit's own gate (`extensionsHalf`).
//
// The file and the modules are the repository's, so a pull request can plant
// them. Every byte is read within a bound; a field is accepted only in a
// fixed character set, since `id`, `version` and `module` are printed into
// hook output and into the committed report; a problem is fixed text that
// quotes nothing from the file; the file must be the repository's own, so
// `.claude/kh-harness` may not be a link, and a `.claude` that is one blocks
// only when an extensions file is reached through it (a `.claude` kept in a
// dotfiles directory is otherwise no concern of this module); and a module
// is judged only where its real path
// lies under the repository's real `.claude/` and outside its
// `.claude/scripts/`. Installed beside the other hook scripts, so it imports
// only Node built-ins and sibling files.
//
// A module that passes is run from the very bytes that were hashed, so it is
// one self-contained file: it may import Node built-ins and nothing else.
// Each runs on its own copy of the payload, with standard output and
// standard error silenced and `process.exit` made to throw, and whatever goes
// wrong with it is its entry's `onFailure`: the call is blocked, or the
// person is told once per session that the extension checks nothing. What
// reaches the model is fixed text, an entry's `id`, and a block message after
// it is cleaned.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { lfNormalised, lfSha256 } from './harness-log.mjs';
import { escapeDelimiters, markerPath, maskText, projectRoot, safeSessionId, stripUnsafe } from './harness-redact.mjs';

/** SHA-256 hex of a module's bytes with each CRLF made LF, the hash an
 * extension's entry records. */
export { lfSha256 as moduleSha256 };

export const EXTENSIONS_PATH = '.claude/kh-harness/extensions.json';

/** `moduleMaxBytes` bounds a module file as it is on disk, before its line
 * endings are normalised. */
/** `loadMaxMs` bounds how long a module may take to load: a top-level
 * await that never settles would otherwise leave the event loop empty,
 * which ends the entry script's run before the gate. */
export const EXTENSION_LIMITS = Object.freeze({ fileMaxBytes: 65536, entriesMax: 8, moduleMaxBytes: 1024 * 1024, messageMax: 300, loadMaxMs: 1000 });

const NOT_A_DIRECTORY = '.claude or .claude/kh-harness is a link or not a directory';
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

/** True when something is at `path`, following every link on the way;
 * false when nothing is, or a component of it is not a directory. Throws
 * what else the file system throws. */
function reached(path) {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    if (error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The extensions file under `root`: `absent`, `malformed` with a fixed
 * `problem`, or `ok` with its entries in order. One bad entry, or two with
 * one id or one module, makes the whole file malformed. `root` itself may be
 * reached through a link, and so may `.claude` when no extensions file is
 * reached through it; `.claude/kh-harness` may not. Never throws. */
export function readExtensions(root) {
  try {
    const claude = lstatOrNull(join(root, '.claude'));
    if (claude === null) return { state: 'absent' };
    if (claude.isSymbolicLink()) {
      return reached(join(root, EXTENSIONS_PATH)) ? malformed('.claude is a link, and an extensions file must be a file of the repository itself') : { state: 'absent' };
    }
    if (!claude.isDirectory()) return malformed(NOT_A_DIRECTORY);
    const khHarness = lstatOrNull(join(root, '.claude/kh-harness'));
    if (khHarness === null) return { state: 'absent' };
    if (!khHarness.isDirectory()) return malformed(NOT_A_DIRECTORY);
    const path = join(root, EXTENSIONS_PATH);
    const st = lstatOrNull(path);
    if (st === null) return { state: 'absent' };
    if (!st.isFile()) return malformed('it is not a regular file');
    const bytes = readFileWithin(path, EXTENSION_LIMITS.fileMaxBytes);
    if (bytes === NOT_A_FILE) return malformed('it is not a regular file');
    if (bytes === TOO_LARGE) return malformed(`it is larger than ${EXTENSION_LIMITS.fileMaxBytes} bytes`);
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

const NOT_A_FILE = Symbol('not a regular file');
const TOO_LARGE = Symbol('too large');

/** The bytes of the regular file at `path`, read from one descriptor so the
 * file measured is the file read, and a link at its last component is not
 * followed where the platform can refuse one; `NOT_A_FILE` or `TOO_LARGE`
 * (more than `maxBytes`) otherwise. Throws what the file system throws. */
function readFileWithin(path, maxBytes) {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) return NOT_A_FILE;
    const buf = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    for (let n; length < buf.length && (n = readSync(fd, buf, length, buf.length - length, null)) > 0;) length += n;
    return length > maxBytes ? TOO_LARGE : Buffer.from(buf.subarray(0, length));
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
    if (!Buffer.isBuffer(raw)) return { state: 'unreadable' };
    // Normalised once and hashed plain: a second pass would turn CR CR LF
    // into LF, handing on bytes other than the ones the hash approved.
    const bytes = lfNormalised(raw);
    return createHash('sha256').update(bytes).digest('hex') === entry.sha256 ? { state: 'matches', path: real, bytes } : { state: 'differs' };
  } catch {
    return { state: 'unreadable' };
  }
}

// --- Running the extensions -------------------------------------------------

const REASONS = Object.freeze({
  missing: 'its module file is missing',
  differs: 'its module file does not match the sha256 recorded for it',
  outside: 'its module is not a file under .claude/ in this repository',
  unreadable: 'its module file could not be read',
  load: 'its module could not be loaded',
  noExport: 'its module exports no preToolUse function',
  threw: 'its preToolUse threw',
  result: 'its preToolUse returned neither an allow nor a block with a usable message',
});

const LINE_BREAK_ALL = /[\r\n\p{Zl}\p{Zp}]+/gu;

const blockText = (id, message) => `kh-harness extension ${id}: ${message}`;
const failBlockText = (id, reason) => `kh-harness extension ${id}: ${reason}, so this call is blocked (onFailure: block). Reinstall the plugin that registered it, or remove its entry from .claude/kh-harness/extensions.json outside this session.`;
const failAllowText = (id, reason) => `kh-harness extension ${id}: ${reason}, so it checks no call (onFailure: allow).`;
const malformedText = problem => `kh-harness: .claude/kh-harness/extensions.json cannot be used (${problem}), so every tool call is blocked. Repair or remove the file outside this session.`;

const isToolCall = payload => payload !== null && typeof payload === 'object' && !Array.isArray(payload)
  && payload.hook_event_name === 'PreToolUse' && typeof payload.tool_name === 'string';

/** The half result for `blocks` and `notices`, built from strings alone so
 * it always serialises, or null when there is neither. */
function halfResult({ blocks, notices }) {
  if (blocks.length === 0 && notices.length === 0) return null;
  const json = {};
  if (notices.length > 0) json.systemMessage = notices.join(' ');
  if (blocks.length > 0) json.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: blocks.join('\n') };
  return { json, stderr: '', exitCode: 0 };
}

/** A block message as the model is shown it: stripped of what a reader
 * cannot see, on one line, unable to open or close a delimited block, and
 * masked; null when nothing is left. */
function cleanMessage(message) {
  const cleaned = maskText(escapeDelimiters(stripUnsafe(message).replace(LINE_BREAK_ALL, ' ')), { floors: 'sweep' }).trim();
  return cleaned === '' ? null : cleaned;
}

/** `{ kind: 'allow' }` or `{ kind: 'block', message }` for a result that is
 * exactly `{ decision: 'allow' }` or `{ decision: 'block', message }` with a
 * usable message, else null. Reads the result, so it may throw. */
function judged(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result) || Object.getPrototypeOf(result) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(result);
  const { decision, message } = result;
  if (keys.length === 1 && keys[0] === 'decision' && decision === 'allow') return { kind: 'allow' };
  if (keys.length !== 2 || !keys.includes('decision') || !keys.includes('message') || decision !== 'block') return null;
  if (typeof message !== 'string' || message.length === 0 || message.length > EXTENSION_LIMITS.messageMax) return null;
  const cleaned = cleanMessage(message);
  return cleaned === null ? null : { kind: 'block', message: cleaned };
}

/** Runs `fn` with standard output and standard error writing nothing and
 * `process.exit` throwing, and puts all three back however it ends. */
async function quietly(fn) {
  const { stdout, stderr } = process;
  const saved = [stdout.write, stderr.write, process.exit];
  stdout.write = () => true;
  stderr.write = () => true;
  process.exit = () => { throw new Error('an extension called process.exit'); };
  try {
    return await fn();
  } finally {
    [stdout.write, stderr.write, process.exit] = saved;
  }
}

/** The module whose source is `bytes`, imported from those bytes alone, or
 * null when it cannot be loaded within `loadMaxMs`. The bound's timer keeps
 * the process alive while the module loads, which is what lets a load that
 * never settles end in a failure rather than the run's end, and is cleared
 * before this returns, however the load ends. */
async function loadFrom(bytes) {
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(resolve, EXTENSION_LIMITS.loadMaxMs, null); });
  const loading = import(`data:text/javascript;base64,${bytes.toString('base64')}`).catch(() => null);
  try {
    return await Promise.race([loading, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the extension `entry` decides on `payload`: `{ kind: 'allow' }`,
 * `{ kind: 'block', message }`, or `{ kind: 'failed', reason }`. Never
 * throws. */
async function runExtension(root, entry, payload) {
  const state = moduleState(root, entry);
  if (state.state !== 'matches') return { kind: 'failed', reason: REASONS[state.state] };
  return quietly(async () => {
    const module = await loadFrom(state.bytes);
    if (module === null) return { kind: 'failed', reason: REASONS.load };
    let preToolUse;
    try {
      preToolUse = module.preToolUse;
    } catch {
      return { kind: 'failed', reason: REASONS.load };
    }
    if (typeof preToolUse !== 'function') return { kind: 'failed', reason: REASONS.noExport };
    try {
      return judged(preToolUse(structuredClone(payload))) ?? { kind: 'failed', reason: REASONS.result };
    } catch {
      return { kind: 'failed', reason: REASONS.threw };
    }
  });
}

/** True when this session has not been told `sentence` yet; see
 * tool-gate.mjs's `firstTelling`, whose marker this follows. */
function firstTelling(root, sessionId, sentence) {
  const tag = createHash('sha256').update(sentence, 'utf8').digest('hex').slice(0, 16);
  const path = sessionId === null ? null : markerPath(root, sessionId, `extensions-notice-${tag}`);
  if (path === null) return true;
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

async function runAll(payload) {
  if (!isToolCall(payload)) return null;
  const root = projectRoot();
  const file = readExtensions(root);
  if (file.state === 'absent') return null;
  if (file.state === 'malformed') return halfResult({ blocks: [malformedText(file.problem)], notices: [] });
  const blocks = [];
  const notices = [];
  for (const entry of file.entries) {
    const outcome = await runExtension(root, entry, payload);
    if (outcome.kind === 'block') blocks.push(blockText(entry.id, outcome.message));
    else if (outcome.kind === 'failed' && entry.onFailure === 'block') blocks.push(failBlockText(entry.id, outcome.reason));
    else if (outcome.kind === 'failed') notices.push(failAllowText(entry.id, outcome.reason));
  }
  const sessionId = safeSessionId(payload.session_id);
  return halfResult({ blocks, notices: notices.filter(sentence => firstTelling(root, sessionId, sentence)) });
}

/** The PreToolUse half that runs every extension the repository's
 * extensions file lists, in file order, each on its own copy of `payload`,
 * and returns a deny naming each that blocked or failed with `onFailure:
 * 'block'`, a notice for each that failed with `onFailure: 'allow'` and has
 * not been told this session, or null. A malformed file blocks the call.
 * Never throws: anything unforeseen blocks the call too, since an
 * extensions file is there to be applied. */
export async function extensionsHalf(payload) {
  try {
    return await runAll(payload);
  } catch {
    return halfResult({ blocks: [malformedText('it could not be applied to this call')], notices: [] });
  }
}
