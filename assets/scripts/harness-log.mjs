// assets/scripts/harness-log.mjs
//
// The session log's library: where a repository's log lives on this
// machine, whether it is enabled, how it is configured, which harness a
// session ran under, and how an event is written and read back.
//
// Installed beside the other hook scripts and called by a hook on every tool
// use, so it imports only Node built-ins and sibling files, never spawns a
// child process (the git common directory is found by reading files, not by
// running git), its read paths never throw, and an event write reports an
// I/O failure in its result instead of throwing.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { maskText, safeSessionId } from './harness-redact.mjs';

export const GATES_PATH = '.claude/kh-harness/gates.json';
export const LOCAL_GATES_FILE = 'gates.local.json';

const ENABLED_FILE = 'enabled.json';
const CONFIG_FILE = 'config.json';

const DEFAULT_CONFIG = Object.freeze({ contentRetentionDays: 90, inlineCapBytes: 65536, autodraft: false });

/** The per-machine directory every repository's log lives under. */
export function dataRoot() {
  const override = process.env.KH_DATA_DIR;
  return override && override.length > 0 ? override : join(homedir(), '.claude', 'kh-harness');
}

/**
 * The path's real, absolute spelling. `realpathSync.native` because git
 * records real paths in a worktree's `gitdir` file while a caller may hold a
 * link or, on win32, an 8.3 short name (`C:\Users\DREAMB~1`), and both must
 * key the same; a path that does not exist keeps its resolved spelling.
 */
function normalisedPath(path) {
  let real = resolve(path);
  try {
    real = realpathSync.native(real);
  } catch {
    // absent or unreadable: the resolved spelling is the best there is
  }
  const forward = real.replace(/\\/g, '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

function readTrimmed(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/** The nearest `.git` entry at or above `start`, with its stat, or null. */
function nearestDotGit(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    try {
      return { dotGit, st: statSync(dotGit) };
    } catch {
      // nothing here: look one level up
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The git common directory of the repository holding `root`, or null when
 * no `.git` entry exists at or above it, or the nearest one cannot be
 * followed. The search walks upward because a hook's project directory may
 * be a sub-directory of the repository. A `.git` directory is its own common
 * directory; a `.git` file (a linked worktree or a submodule) names its git
 * directory on a `gitdir:` line, and that directory's `commondir` file, when
 * present, names the common one. Both may be relative to the directory
 * holding them.
 */
function gitCommonDir(root) {
  const found = nearestDotGit(root);
  if (found === null) return null;
  const { dotGit, st } = found;
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  const m = /^gitdir:\s*(.+)$/m.exec(readTrimmed(dotGit) ?? '');
  if (!m) return null;
  const gitDir = resolve(dirname(dotGit), m[1].trim());
  const common = readTrimmed(join(gitDir, 'commondir'));
  return common ? resolve(gitDir, common) : gitDir;
}

/** First 16 hex of SHA-256 over the git common directory (the root itself
 * outside git), so every worktree of one repository shares one log. */
export function repoKey(root) {
  const keyed = normalisedPath(gitCommonDir(root) ?? root);
  return createHash('sha256').update(keyed, 'utf8').digest('hex').slice(0, 16);
}

export function repoDataDir(root) {
  return join(dataRoot(), repoKey(root));
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, absent: error?.code === 'ENOENT' };
  }
}

/** True only when this machine's owner enabled the log for this repository;
 * an absent or unreadable record means disabled. */
export function isEnabled(root) {
  const read = readJson(join(repoDataDir(root), ENABLED_FILE));
  return read.ok && read.value !== null && typeof read.value === 'object' && read.value.enabled === true;
}

export function setEnabled(root, enabled) {
  const dir = repoDataDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ENABLED_FILE), JSON.stringify({ enabled: enabled === true }) + '\n', 'utf8');
}

const isPositiveInteger = v => Number.isSafeInteger(v) && v > 0;

const CONFIG_FIELDS = {
  contentRetentionDays: isPositiveInteger,
  inlineCapBytes: isPositiveInteger,
  autodraft: v => typeof v === 'boolean',
};

/**
 * The repository's log configuration on this machine. An absent file is the
 * defaults. A file that cannot be read, is not a JSON object, or holds an
 * invalid value for a known field is the defaults in full, flagged
 * `configUnreadable`, so a typo is reported rather than half-applied.
 * Unknown fields are ignored.
 */
export function readConfig(root) {
  const read = readJson(join(repoDataDir(root), CONFIG_FILE));
  if (!read.ok) return read.absent ? { ...DEFAULT_CONFIG } : { ...DEFAULT_CONFIG, configUnreadable: true };
  const raw = read.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CONFIG, configUnreadable: true };
  const config = { ...DEFAULT_CONFIG };
  for (const [field, valid] of Object.entries(CONFIG_FIELDS)) {
    if (!Object.hasOwn(raw, field)) continue;
    if (!valid(raw[field])) return { ...DEFAULT_CONFIG, configUnreadable: true };
    config[field] = raw[field];
  }
  return config;
}

function serialiseSorted(value) {
  if (Array.isArray(value)) return `[${value.map(serialiseSorted).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${serialiseSorted(value[k])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * JSON with object keys sorted recursively and no whitespace, so equal
 * values hash equally whatever order their keys were written in. Keys are
 * sorted as strings, so `"10"` precedes `"9"`; arrays keep their order.
 * `value` is first passed through `JSON.stringify`'s own rules (`toJSON`,
 * dropped `undefined`), and must therefore be JSON-serialisable.
 */
export function canonicalJson(value) {
  return serialiseSorted(JSON.parse(JSON.stringify(value)));
}

const MANIFEST_PATH = '.claude/kh-harness.manifest.json';
const UNREADABLE = 'unreadable';

// `base` identifies the harness machinery: the installed hook scripts and the
// settings patches that register them. The manifest also records documents
// the owner writes into (RULES.md, HANDOFF.md) and the learned files, which
// `learned` covers; none of those is machinery.
const BASE_PREFIX = '.claude/scripts/';

const sha256Hex = data => createHash('sha256').update(data).digest('hex');

/** CRLF to LF on the raw bytes; latin1 maps each byte to one code unit, so
 * nothing else changes and a lone CR stays. */
function lfNormalised(buf) {
  return buf.includes(0x0d) ? Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : buf;
}

/** A relative path that resolves inside `root`; on win32 a drive-relative
 * `C:x` resolves elsewhere and `relative` then returns an absolute path. */
function isInside(root, path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) return false;
  const rel = relative(resolve(root), resolve(root, path));
  return rel.length > 0 && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

/** The manifest when it reads as the kit's schema, null when absent, and
 * `UNREADABLE` otherwise. Every file path must stay inside the repository,
 * since each one is read. */
function readInstalledManifest(root) {
  const read = readJson(join(root, MANIFEST_PATH));
  if (!read.ok) return read.absent ? null : UNREADABLE;
  const m = read.value;
  if (m === null || typeof m !== 'object' || m.schema !== 1 || !Array.isArray(m.files)) return UNREADABLE;
  if (m.settingsPatches !== undefined && !(Array.isArray(m.settingsPatches) && m.settingsPatches.every(isPlainObject))) return UNREADABLE;
  if (!m.files.every(f => isPlainObject(f) && isInside(root, f.path))) return UNREADABLE;
  return m;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function fileDigest(path) {
  try {
    return sha256Hex(lfNormalised(readFileSync(path)));
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : UNREADABLE;
  }
}

function baseHash(root, manifest) {
  const files = manifest.files
    .map(f => f.path)
    .filter(path => path.replace(/\\/g, '/').startsWith(BASE_PREFIX))
    .sort()
    .map(path => [path, fileDigest(join(root, path))]);
  // `appliedAt` is when, not what: re-running `apply` must not move `base`.
  const settingsPatches = (manifest.settingsPatches ?? []).map(({ appliedAt: _appliedAt, ...patch }) => patch);
  return sha256Hex(canonicalJson({ files, settingsPatches }));
}

/** `id:sha256` for each gate in the file (`id:suspended` for a suspension),
 * nothing when the file is absent, and the one entry `UNREADABLE` when it is
 * not `{ schema: 1, gates: [...] }` of objects with string ids, so damage
 * changes the hash. */
function gatePairs(path) {
  const read = readJson(path);
  if (!read.ok) return read.absent ? [] : [UNREADABLE];
  const file = read.value;
  if (!isPlainObject(file) || file.schema !== 1 || !Array.isArray(file.gates)) return [UNREADABLE];
  if (!file.gates.every(g => isPlainObject(g) && typeof g.id === 'string')) return [UNREADABLE];
  return file.gates.map(({ action: _action, ...gate }) =>
    `${gate.id}:${gate.suspended === true ? 'suspended' : sha256Hex(canonicalJson(gate))}`);
}

/**
 * Which harness a session ran under. `base` covers the kit's machinery: the
 * bytes on disk of each manifest-recorded hook script (so a hand edit
 * shows), LF-normalised so a CRLF checkout does not, plus the settings
 * patches. `learned` covers the gates in force, committed and local, each
 * by the hash of its content without its `action`. A document, whoever
 * wrote it, changes neither.
 */
export function harnessIdentity(root) {
  const manifest = readInstalledManifest(root);
  const usable = manifest !== null && manifest !== UNREADABLE;
  const base = usable ? baseHash(root, manifest) : manifest ?? 'none';
  const kitVersion = usable && typeof manifest.kitVersion === 'string' ? manifest.kitVersion : null;
  const pairs = [...gatePairs(join(root, GATES_PATH)), ...gatePairs(join(repoDataDir(root), LOCAL_GATES_FILE))].sort();
  return { base, learned: sha256Hex(canonicalJson(pairs)), kitVersion };
}

export const LOG_SCHEMA = 1;

const SESSIONS_DIR = 'sessions';
const BLOBS_DIR = 'blobs';

/** `key` masked, made unique among `used` by a `#2`, `#3`… suffix when the
 * mask makes it equal to a key already kept, so no value is lost. */
function maskedKey(key, used) {
  const masked = maskText(key);
  let unique = masked;
  for (let n = 2; used.has(unique); n++) unique = `${masked}#${n}`;
  used.add(unique);
  return unique;
}

/**
 * A copy of a JSON value with every object key masked and every string leaf
 * masked and then passed to `onString`. Built with `Object.fromEntries`, so
 * a `__proto__` key stays an ordinary property.
 */
function scrubWith(value, onString) {
  if (typeof value === 'string') return onString(maskText(value));
  if (Array.isArray(value)) return value.map(v => scrubWith(v, onString));
  if (value !== null && typeof value === 'object') {
    const used = new Set();
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskedKey(k, used), scrubWith(v, onString)]));
  }
  return value;
}

/** A deep copy of `value` with `maskText` applied to every object key and
 * every string leaf. `value` must be acyclic. */
export function scrubValue(value) {
  return scrubWith(value, s => s);
}

/** Puts `data` at `path` unless something is already there. The bytes go to
 * a temporary sibling first and are renamed into place, so a reader or a
 * concurrent writer never finds a partial file at `path`. */
function placeOnce(path, data) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    if (!existsSync(path)) throw error;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // a leftover temporary file is never read as a blob
    }
  }
}

/** Stores already-scrubbed `text`; null when it could not be stored. */
function writeBlob(root, text) {
  const data = Buffer.from(text, 'utf8');
  const sha256 = sha256Hex(data);
  try {
    placeOnce(join(repoDataDir(root), BLOBS_DIR, `${sha256}.gz`), gzipSync(data));
    return { sha256, bytes: data.length };
  } catch {
    return null;
  }
}

/**
 * Stores `maskText(text)` gzipped at `<repoDataDir>/blobs/<sha256>.gz`,
 * keyed by the SHA-256 of the masked text's UTF-8 bytes, and returns that
 * hash and the byte count. A blob already present is left untouched. Null
 * when the blob could not be stored; never throws.
 */
export function storeBlob(root, text) {
  return writeBlob(root, maskText(text));
}

/** A scrubbed string leaf, or the reference that replaces it when it is
 * over the cap. `blob` is null when the content could not be stored, so a
 * reference never names a blob that does not exist. */
function inlineOrBlob(root, scrubbed, capBytes) {
  const bytes = Buffer.byteLength(scrubbed, 'utf8');
  if (bytes <= capBytes) return scrubbed;
  return { blob: writeBlob(root, scrubbed)?.sha256 ?? null, bytes, truncated: true };
}

/**
 * The file a session's events are appended to, or null for an id
 * `safeSessionId` refuses. The `s-` prefix keeps an id such as `CON` or
 * `COM1` from naming a win32 device.
 */
export function sessionFileName(sessionId) {
  const id = safeSessionId(sessionId);
  return id === null ? null : `s-${id}.jsonl`;
}

const sessionPath = (root, name) => join(repoDataDir(root), SESSIONS_DIR, name);

/**
 * Appends one event to `<repoDataDir>/sessions/<sessionFileName>` and
 * returns `{ written: true }`, or `{ written: false, reason }` when nothing
 * was written; never throws.
 *
 * The event is first reduced to JSON values, then every key and string
 * leaf is masked as `scrubValue` masks them, and only then is a leaf over
 * `inlineCapBytes` moved to a blob, so a credential is never split by the
 * cap before it can be recognised. `schema`, `ts` and `pid` are the
 * writer's, replacing any the event carries.
 *
 * Hooks running at once append to the same file, so the whole line,
 * newline included, goes out in one write to a file opened for appending.
 */
export function appendEvent(root, sessionId, event) {
  const name = sessionFileName(sessionId);
  if (name === null) return { written: false, reason: 'unsafe session id' };
  if (!isPlainObject(event)) return { written: false, reason: 'event is not an object' };
  let body;
  try {
    body = JSON.parse(JSON.stringify(event));
  } catch {
    return { written: false, reason: 'event is not serialisable' };
  }
  try {
    const capBytes = readConfig(root).inlineCapBytes;
    const capped = scrubWith(body, s => inlineOrBlob(root, s, capBytes));
    const { schema: _schema, ts: _ts, pid: _pid, ...fields } = capped;
    const line = JSON.stringify({ schema: LOG_SCHEMA, ts: new Date().toISOString(), pid: process.pid, ...fields }) + '\n';
    const path = sessionPath(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    return { written: true };
  } catch (error) {
    return { written: false, reason: `write failed: ${error?.code ?? 'unknown'}` };
  }
}

function parsedObject(line) {
  try {
    const value = JSON.parse(line);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Every event recorded for a session: the compressed `.jsonl.gz`, which
 * holds the earlier events, then the `.jsonl`. A line that is not a JSON
 * object is counted in `unparseable`; a file present but unreadable or not
 * gzip sets `unreadable`, and what the other file holds is still returned.
 * An unsafe session id reads nothing. Never throws.
 */
export function readEvents(root, sessionId) {
  const result = { events: [], unparseable: 0, unreadable: false };
  const name = sessionFileName(sessionId);
  if (name === null) return result;
  let plain;
  try {
    plain = sessionPath(root, name);
  } catch {
    return { ...result, unreadable: true };
  }
  for (const [path, decode] of [[`${plain}.gz`, gunzipSync], [plain, buf => buf]]) {
    let lines;
    try {
      lines = decode(readFileSync(path)).toString('utf8').split('\n');
    } catch (error) {
      if (error?.code !== 'ENOENT') result.unreadable = true;
      continue;
    }
    // The writer ends every line with a newline, so the empty string after
    // the last one is not a line.
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      const event = parsedObject(line);
      if (event === null) result.unparseable++;
      else result.events.push(event);
    }
  }
  return result;
}
