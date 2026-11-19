// assets/scripts/harness-log.mjs
//
// The session log's library: where a repository's log lives on this
// machine, whether it is enabled, how it is configured, which harness a
// session ran under, how an event is written and read back, and how a closed
// session is sealed into the index and its content expired.
//
// Installed beside the other hook scripts and called by a hook on every tool
// use, so it imports only Node built-ins and sibling files, never spawns a
// child process (the git common directory is found by reading files, not by
// running git), its read paths never throw, and an event write reports an
// I/O failure in its result instead of throwing.
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { maskText, safeSessionId, SCRUB_MARK } from './harness-redact.mjs';

/** What a scrubbed event holds in place of every value the scrub hid, by the
 * mask or by a credential-named key or flag. */
export { SCRUB_MARK };

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

/** `masked` made unique among `used` by a `#2`, `#3`… suffix when it equals
 * a key already kept, so no value is lost. */
function uniqueKey(masked, used) {
  let unique = masked;
  for (let n = 2; used.has(unique); n++) unique = `${masked}#${n}`;
  used.add(unique);
  return unique;
}

// The keyed credential shapes recognise a secret by what precedes it, which
// a key or the previous argument holds apart from the value. Whether that
// context names a credential is decided from the context alone: a fixed
// sentinel stands in for the value, so a value's own first characters (`=`,
// `,`, a newline) cannot steer the answer. The sentinel is plain
// alphanumerics, long enough for the bearer shape's 20-character floor, and
// it is hidden when the mask removes it. A key is probed as an assignment,
// which every keyed shape accepts. An array element is probed after the
// words before it as an argument list (`Authorization: x`, `Bearer x`), and
// after the one element before it as a flag (`--password=x`); only the one
// element, since `=` joined to a hidden value would extend that value.
const SENTINEL = 'khSentinelValue0123456789abcdef';
const hidesSentinel = probe => !maskText(probe).includes(SENTINEL);
const namesCredential = key => hidesSentinel(`${key}=${SENTINEL}`);
const flagsCredential = (words, last) => hidesSentinel(`${words} ${SENTINEL}`) || hidesSentinel(`${last}=${SENTINEL}`);

const isScalar = v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** An array's copy. A scalar after a credential flag is `SCRUB_MARK`, and the
 * words before it plus that element, each masked on its own, stay the
 * context for the next element, so `Authorization: Bearer <token>` hides
 * the token too. */
function scrubArray(values, onString) {
  let words = null;
  let last = null;
  return values.map(v => {
    if (!isScalar(v)) {
      words = last = null;
      return scrubWith(v, onString);
    }
    const text = maskText(String(v));
    if (words !== null && flagsCredential(words, last)) {
      words = `${words} ${text}`;
      last = text;
      return onString(SCRUB_MARK);
    }
    words = last = typeof v === 'string' ? text : null;
    return typeof v === 'string' ? onString(text) : v;
  });
}

/**
 * A copy of a JSON value with every object key masked and every string leaf
 * masked and then passed to `onString`. A scalar under a credential-named
 * key, or after a credential flag in an array, becomes `SCRUB_MARK` whole. Built
 * with `Object.fromEntries`, so a `__proto__` key stays an ordinary property.
 */
function scrubWith(value, onString) {
  if (typeof value === 'string') return onString(maskText(value));
  if (Array.isArray(value)) return scrubArray(value, onString);
  if (value !== null && typeof value === 'object') {
    const used = new Set();
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      const key = maskText(k);
      const unique = uniqueKey(key, used);
      if (!isScalar(v)) return [unique, scrubWith(v, onString)];
      if (namesCredential(key)) return [unique, onString(SCRUB_MARK)];
      return [unique, typeof v === 'string' ? onString(maskText(v)) : v];
    }));
  }
  return value;
}

/** A deep copy of the JSON value `value` with `maskText` applied to every
 * object key and every string leaf, and every scalar under a
 * credential-named key or after a credential flag replaced by `SCRUB_MARK`. */
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

// Sealing. A session's events are appended to `s-<id>.jsonl` while it runs.
// Sealing a closed session first renames that file to `s-<id>.jsonl.sealing`,
// so an event a hook appends meanwhile starts a new plain file instead of
// being lost, then writes the earlier compressed events plus the claimed ones
// to `s-<id>.jsonl.gz.tmp`, appends the index line naming that content's
// hash, removes the claimed file and renames the temporary file into place.
// `readEvents` reads neither the claimed nor the temporary file, so no state
// shows an event twice, and a temporary file whose content matches the
// session's latest index line is the record that the steps after the index
// append still have to be done.

const INDEX_FILE = 'index.jsonl';
const LOCK_FILE = 'index.jsonl.lock';
const DAY_MS = 86_400_000;
const NEWLINE = 0x0a;
const CONTENT_FIELDS = ['input', 'output', 'prompt'];

// A lock records its owner's pid and is broken only once that process has
// exited. A lock with no readable owner is broken only once it is this old:
// its owner leaves it ownerless only between creating it and writing to it.
const LOCK_STALE_MS = 30_000;

const SESSION_ENTRY = /^s-([^.]+)\.jsonl(\.gz|\.sealing|\.gz\.tmp)?$/;
const PLAIN = '';
const SEALED = '.gz';
const CLAIMED = '.sealing';
const TEMP = '.gz.tmp';

const isSha256 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isTimestampOrNull = v => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

const INDEX_FIELDS = {
  sessionId: v => typeof v === 'string' && safeSessionId(v) === v,
  sha256: isSha256,
  events: v => Number.isSafeInteger(v) && v >= 0,
  firstTs: isTimestampOrNull,
  lastTs: isTimestampOrNull,
  external: v => typeof v === 'boolean',
  blobs: v => Array.isArray(v) && v.every(isSha256),
  prev: v => v === null || isSha256(v),
};

/** True for an index line's record: every field valid, and nothing else
 * but `contentExpired: true`. */
function isIndexRecord(v) {
  if (!isPlainObject(v)) return false;
  if (!Object.keys(v).every(k => Object.hasOwn(INDEX_FIELDS, k) || k === 'contentExpired')) return false;
  if (v.contentExpired !== undefined && v.contentExpired !== true) return false;
  return Object.entries(INDEX_FIELDS).every(([field, valid]) => valid(v[field]));
}

/** Each line's bytes without its newline; an unterminated last line is
 * kept. */
function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
    lines.push(buf.subarray(start, nl));
    start = nl + 1;
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

const indexPath = root => join(repoDataDir(root), INDEX_FILE);

/**
 * The index's lines, each with its bytes and its record (null for a line
 * that is not one), the latest record per session, and whether the last
 * line lacks its newline. Null when the index exists but cannot be read.
 */
function readIndex(root) {
  let buf;
  try {
    buf = readFileSync(indexPath(root));
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
    buf = Buffer.alloc(0);
  }
  const lines = splitLines(buf).map(bytes => {
    const record = parsedObject(bytes.toString('utf8'));
    return { bytes, record: isIndexRecord(record) ? record : null };
  });
  const latest = new Map();
  for (const { record } of lines) if (record !== null) latest.set(record.sessionId, record);
  return { lines, latest, torn: buf.length > 0 && buf.at(-1) !== NEWLINE, appendFailed: false };
}

/** Appends `record` to the index chained to the last line, and records it as
 * its session's latest. A failed append sets `appendFailed`, since a line
 * may have been torn and the in-memory chain is then no longer the file's. */
function appendIndexLine(root, index, record) {
  const full = { ...record, prev: index.lines.length === 0 ? null : sha256Hex(index.lines.at(-1).bytes) };
  const line = canonicalJson(full);
  index.appendFailed = true;
  appendFileSync(indexPath(root), `${index.torn ? '\n' : ''}${line}\n`, { encoding: 'utf8', mode: 0o600 });
  index.appendFailed = false;
  index.torn = false;
  index.lines.push({ bytes: Buffer.from(line, 'utf8'), record: full });
  index.latest.set(record.sessionId, full);
}

/** Each session found in the sessions directory, by id in sorted order, with
 * the set of its files present: `PLAIN`, `SEALED`, `CLAIMED`, `TEMP`. */
function listSessions(root) {
  let names;
  try {
    names = readdirSync(join(repoDataDir(root), SESSIONS_DIR));
  } catch {
    return new Map();
  }
  const sessions = new Map();
  for (const name of names.sort()) {
    const m = SESSION_ENTRY.exec(name);
    if (m === null || safeSessionId(m[1]) !== m[1]) continue;
    if (!sessions.has(m[1])) sessions.set(m[1], new Set());
    sessions.get(m[1]).add(m[2] ?? PLAIN);
  }
  return sessions;
}

const sessionFile = (root, sessionId, kind) => `${sessionPath(root, sessionFileName(sessionId))}${kind}`;

/** The uncompressed bytes of a gzip file, or null when it is absent; any
 * other failure, a file that is not gzip included, throws. */
function readCompressed(path) {
  try {
    return gunzipSync(readFileSync(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether `bytes` (null for no sealed file) is what the session's latest
 * index line names. */
const matchesIndex = (bytes, latest) =>
  latest === undefined ? bytes === null : bytes !== null && sha256Hex(bytes) === latest.sha256;

/** Every blob hash a `{ blob, truncated: true }` reference in `value`
 * names, added to `into`. */
function collectBlobs(value, into) {
  if (Array.isArray(value)) {
    for (const v of value) collectBlobs(v, into);
  } else if (isPlainObject(value)) {
    if (value.truncated === true && isSha256(value.blob)) into.add(value.blob);
    for (const v of Object.values(value)) collectBlobs(v, into);
  }
}

function blobsIn(bytes, into) {
  for (const line of splitLines(bytes)) collectBlobs(parsedObject(line.toString('utf8')), into);
}

/** The index record for a session holding `bytes`. `events` counts the lines
 * that parse; `firstTs` and `lastTs` are the earliest and latest event times,
 * null when no event has one. */
function sealRecord(sessionId, bytes) {
  let events = 0;
  let firstTs = null;
  let lastTs = null;
  let external = false;
  const blobs = new Set();
  for (const line of splitLines(bytes)) {
    const event = parsedObject(line.toString('utf8'));
    if (event === null) continue;
    events++;
    if (event.type === 'external_content') external = true;
    collectBlobs(event, blobs);
    if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts))) continue;
    if (firstTs === null || Date.parse(event.ts) < Date.parse(firstTs)) firstTs = event.ts;
    if (lastTs === null || Date.parse(event.ts) > Date.parse(lastTs)) lastTs = event.ts;
  }
  return { sessionId, sha256: sha256Hex(bytes), events, firstTs, lastTs, external, blobs: [...blobs].sort() };
}

function writeTemp(path, bytes) {
  rmSync(path, { force: true });
  writeFileSync(path, gzipSync(bytes), { flag: 'wx', mode: 0o600 });
}

/**
 * Finishes or discards each temporary file an interrupted run left. One
 * whose content is the session's latest index line was indexed, so any
 * claimed file it was built from is removed and it is renamed into place;
 * any other was never indexed and is removed. `sessions` is updated to
 * match; a file that cannot be finished keeps its `TEMP` entry, and its
 * session is left alone until a later run.
 */
function recoverInterrupted(root, sessions, index) {
  for (const [sessionId, kinds] of sessions) {
    if (!kinds.has(TEMP)) continue;
    const temp = sessionFile(root, sessionId, TEMP);
    try {
      const latest = index.latest.get(sessionId);
      if (latest !== undefined && sha256Hex(gunzipSync(readFileSync(temp))) === latest.sha256) {
        rmSync(sessionFile(root, sessionId, CLAIMED), { force: true });
        kinds.delete(CLAIMED);
        renameSync(temp, sessionFile(root, sessionId, SEALED));
        kinds.add(SEALED);
      } else {
        rmSync(temp, { force: true });
      }
      kinds.delete(TEMP);
    } catch {
      // left for a later run
    }
  }
}

/** `sealed` followed by `claimed`, with a newline between when the sealed
 * content's last line lacks one. */
function joined(sealed, claimed) {
  if (sealed === null || sealed.length === 0) return claimed;
  return sealed.at(-1) === NEWLINE ? Buffer.concat([sealed, claimed]) : Buffer.concat([sealed, Buffer.from('\n'), claimed]);
}

/**
 * Seals one session's unsealed events and says whether it did. A session
 * whose sealed file does not match its latest index line is left alone, so
 * `verifyIndex` keeps reporting it instead of the damage being sealed over.
 * A claimed file an interrupted run left is sealed before the plain file,
 * which then waits for a later run.
 */
function sealSession(root, sessionId, kinds, index) {
  if (kinds.has(TEMP) || !(kinds.has(PLAIN) || kinds.has(CLAIMED))) return false;
  const sealedPath = sessionFile(root, sessionId, SEALED);
  const claimedPath = sessionFile(root, sessionId, CLAIMED);
  const tempPath = sessionFile(root, sessionId, TEMP);
  const sealed = readCompressed(sealedPath);
  if (!matchesIndex(sealed, index.latest.get(sessionId))) return false;
  if (!kinds.has(CLAIMED)) {
    renameSync(sessionFile(root, sessionId, PLAIN), claimedPath);
    kinds.delete(PLAIN);
    kinds.add(CLAIMED);
  }
  const claimed = readFileSync(claimedPath);
  if (claimed.length === 0) {
    rmSync(claimedPath, { force: true });
    kinds.delete(CLAIMED);
    return false;
  }
  const content = joined(sealed, claimed);
  writeTemp(tempPath, content);
  appendIndexLine(root, index, sealRecord(sessionId, content));
  rmSync(claimedPath, { force: true });
  kinds.delete(CLAIMED);
  renameSync(tempPath, sealedPath);
  kinds.add(SEALED);
  return true;
}

/** Whether a process with this pid exists; EPERM means it does, owned by
 * another user. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function readLock(path) {
  try {
    const bytes = readFileSync(path);
    return { bytes, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

function lockOwner(bytes) {
  const owner = parsedObject(bytes.toString('utf8'));
  return owner !== null && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && owner.token.length > 0
    ? owner
    : null;
}

function isBreakable(lock, now) {
  const owner = lockOwner(lock.bytes);
  return owner !== null ? !isAlive(owner.pid) : now - lock.mtimeMs > LOCK_STALE_MS;
}

function unlinkQuietly(path) {
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates `path` exclusively, owned by this process, and returns the
 * owner's token; null when it cannot. */
function createLock(path) {
  const token = randomBytes(16).toString('hex');
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    return null;
  }
  let written = false;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    written = true;
  } catch {
    // an ownerless lock is removed below
  } finally {
    closeSync(fd);
    if (!written) unlinkQuietly(path);
  }
  return written ? token : null;
}

/** Removes the lock only while it is still the one `token` owns. */
function releaseLock(path, token) {
  const lock = readLock(path);
  if (lock !== null && lockOwner(lock.bytes)?.token === token) unlinkQuietly(path);
}

function removeIfUnchanged(path, judged, now) {
  const again = readLock(path);
  return again !== null && again.bytes.equals(judged.bytes) && isBreakable(again, now) && unlinkQuietly(path);
}

/** Removes the lock when it is breakable, and says whether it did. Breakers
 * take a second lock beside it, so of two that judged one lock breakable
 * only one removes it, and never the lock a third has taken since. */
function breakLock(path, now) {
  const judged = readLock(path);
  if (judged === null || !isBreakable(judged, now)) return false;
  const mutexPath = `${path}.break`;
  const token = createLock(mutexPath);
  if (token === null) {
    const holder = readLock(mutexPath);
    if (holder !== null) removeIfUnchanged(mutexPath, holder, now);
    return false;
  }
  try {
    return removeIfUnchanged(path, judged, now);
  } finally {
    releaseLock(mutexPath, token);
  }
}

/** Runs `fn` holding the index lock; does nothing when another live process
 * holds it or the repository has no data directory. */
function withIndexLock(root, now, fn) {
  const path = join(repoDataDir(root), LOCK_FILE);
  let token = createLock(path);
  if (token === null && breakLock(path, now)) token = createLock(path);
  if (token === null) return;
  try {
    fn();
  } finally {
    releaseLock(path, token);
  }
}

const defaultClock = () => performance.now();

/** A check that is true until `budgetMs` of `clock` time has passed since
 * it was made. */
function budget(clock, budgetMs) {
  const started = clock();
  return () => clock() - started < budgetMs;
}

/**
 * Seals every session but `currentSessionId` that has events not yet
 * sealed: compresses them after any sealed before, and appends to
 * `<repoDataDir>/index.jsonl` a line naming the SHA-256 of the whole
 * uncompressed content, its event count, first and last event times,
 * whether it fetched outside content (`external`), the blobs it references,
 * and `prev`, the SHA-256 of the index line before. An event appended after
 * its session was sealed is sealed again with the rest on a later run.
 *
 * Runs under an exclusive lock and does nothing while another process holds
 * it. Stops before the next session once `budgetMs` of `clock` time has
 * passed; the rest are sealed on a later call. `now` (milliseconds since the
 * epoch) judges the age of an ownerless lock. Never throws.
 */
export function sealClosedSessions(root, { now = Date.now(), currentSessionId, budgetMs = Infinity, clock = defaultClock } = {}) {
  const sealed = [];
  const withinBudget = budget(clock, budgetMs);
  try {
    withIndexLock(root, now, () => {
      const index = readIndex(root);
      if (index === null) return;
      const sessions = listSessions(root);
      recoverInterrupted(root, sessions, index);
      for (const [sessionId, kinds] of sessions) {
        if (sessionId === currentSessionId) continue;
        if (!withinBudget()) return;
        try {
          if (sealSession(root, sessionId, kinds, index)) sealed.push(sessionId);
        } catch {
          // this session is left for a later run
        }
        if (index.appendFailed) return;
      }
    });
  } catch {
    // nothing more is sealed this run
  }
  return { sealed };
}

/** `bytes` with `input`, `output` and `prompt` removed from every event and
 * `contentExpired: true` set on each event that lost one. A line that does
 * not parse cannot be expired field by field, so it is dropped. `removed`
 * says whether anything changed; unchanged lines keep their bytes. */
function withoutContent(bytes) {
  const lines = [];
  let removed = false;
  for (const line of splitLines(bytes)) {
    const event = parsedObject(line.toString('utf8'));
    if (event === null) {
      removed = true;
      continue;
    }
    const present = CONTENT_FIELDS.filter(f => Object.hasOwn(event, f));
    if (present.length === 0) {
      lines.push(line, Buffer.from('\n'));
      continue;
    }
    for (const f of present) delete event[f];
    lines.push(Buffer.from(`${JSON.stringify({ ...event, contentExpired: true })}\n`, 'utf8'));
    removed = true;
  }
  return { content: removed ? Buffer.concat(lines) : bytes, removed };
}

/** Expires one sealed session's content and says whether anything was
 * removed. The new index line carries `contentExpired: true`, so the session
 * is not read again until a later seal adds events to it. */
function expireSession(root, sessionId, index) {
  const sealedPath = sessionFile(root, sessionId, SEALED);
  const tempPath = sessionFile(root, sessionId, TEMP);
  const sealed = readCompressed(sealedPath);
  if (sealed === null || !matchesIndex(sealed, index.latest.get(sessionId))) return false;
  const { content, removed } = withoutContent(sealed);
  if (removed) writeTemp(tempPath, content);
  appendIndexLine(root, index, { ...sealRecord(sessionId, content), contentExpired: true });
  if (removed) renameSync(tempPath, sealedPath);
  return removed;
}

/** Every blob some session references: the latest index line's list for an
 * indexed session's sealed content, and a read of every other session
 * file. */
function referencedBlobs(root, sessions, index) {
  const referenced = new Set();
  for (const [sessionId, kinds] of sessions) {
    const latest = index.latest.get(sessionId);
    if (latest !== undefined) {
      for (const sha256 of latest.blobs) referenced.add(sha256);
    } else if (kinds.has(SEALED)) {
      blobsIn(readCompressed(sessionFile(root, sessionId, SEALED)) ?? Buffer.alloc(0), referenced);
    }
    for (const kind of [PLAIN, CLAIMED]) {
      if (kinds.has(kind)) blobsIn(readFileSync(sessionFile(root, sessionId, kind)), referenced);
    }
  }
  return referenced;
}

/** Removes every file in the blob store that no session references and that
 * is over a day old by `now`; the age floor spares a blob whose event has
 * not been appended yet. */
function removeUnreferencedBlobs(root, sessions, index, now) {
  const referenced = referencedBlobs(root, sessions, index);
  const dir = join(repoDataDir(root), BLOBS_DIR);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^([0-9a-f]{64})\.gz$/.exec(name);
    if (m !== null && referenced.has(m[1])) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > DAY_MS) rmSync(join(dir, name));
    } catch {
      // left for a later run
    }
  }
}

/**
 * Expires the content of every sealed session whose last event is older
 * than `contentRetentionDays` by `now` (milliseconds since the epoch): each
 * event loses its `input`, `output` and `prompt` and is marked
 * `contentExpired: true`, everything else is kept, and an index line
 * recording the rewrite is appended. Then removes the blobs no session
 * references that are over a day old. Returns how many sessions lost
 * content.
 *
 * Runs under the index lock and does nothing while another process holds
 * it. A session with events being sealed is left for a later run, as is
 * everything once `budgetMs` of `clock` time has passed; the blob sweep runs
 * only within the budget. Never throws.
 */
export function applyRetention(root, { now = Date.now(), budgetMs = Infinity, clock = defaultClock } = {}) {
  let contentRemoved = 0;
  const withinBudget = budget(clock, budgetMs);
  try {
    const cutoff = now - readConfig(root).contentRetentionDays * DAY_MS;
    withIndexLock(root, now, () => {
      const index = readIndex(root);
      if (index === null) return;
      const sessions = listSessions(root);
      recoverInterrupted(root, sessions, index);
      for (const [sessionId, kinds] of sessions) {
        const latest = index.latest.get(sessionId);
        if (latest === undefined || latest.contentExpired === true || latest.lastTs === null || !(Date.parse(latest.lastTs) < cutoff)) continue;
        if (!kinds.has(SEALED) || kinds.has(CLAIMED) || kinds.has(TEMP)) continue;
        if (!withinBudget()) return;
        try {
          if (expireSession(root, sessionId, index)) contentRemoved++;
        } catch {
          // this session is left for a later run
        }
        if (index.appendFailed) return;
      }
      if (withinBudget()) removeUnreferencedBlobs(root, sessions, index, now);
    });
  } catch {
    // nothing more is expired this run
  }
  return { contentRemoved };
}

/**
 * Whether the index and the sealed sessions are as sealed. `brokenAt` is
 * the 1-based number of the first index line that is not an index record,
 * whose `prev` is not the SHA-256 of the line before it, or, as the first
 * line, has a `prev`; deleting a line therefore breaks the chain at that
 * line's position. Each session's sealed file must match its latest index
 * line: one whose sealed file is absent is in `sessionsMissing`, and one
 * whose file differs, cannot be read, or has no index line is in
 * `sessionsAltered`. `intact` is true only when none of these is found.
 * Events not yet sealed are not checked. Never throws.
 */
export function verifyIndex(root) {
  const sessionsMissing = [];
  const sessionsAltered = [];
  const index = readIndex(root);
  if (index === null) return { intact: false, brokenAt: 1, sessionsMissing, sessionsAltered };
  let brokenAt = null;
  for (let i = 0; i < index.lines.length && brokenAt === null; i++) {
    const { record } = index.lines[i];
    const expected = i === 0 ? null : sha256Hex(index.lines[i - 1].bytes);
    if (record === null || record.prev !== expected) brokenAt = i + 1;
  }
  const sessions = listSessions(root);
  for (const sessionId of [...new Set([...index.latest.keys(), ...sessions.keys()])].sort()) {
    const latest = index.latest.get(sessionId);
    const hasSealed = sessions.get(sessionId)?.has(SEALED) === true;
    if (latest === undefined) {
      if (hasSealed) sessionsAltered.push(sessionId);
      continue;
    }
    if (!hasSealed) {
      sessionsMissing.push(sessionId);
      continue;
    }
    try {
      if (!matchesIndex(readCompressed(sessionFile(root, sessionId, SEALED)), latest)) sessionsAltered.push(sessionId);
    } catch {
      sessionsAltered.push(sessionId);
    }
  }
  const intact = brokenAt === null && sessionsMissing.length === 0 && sessionsAltered.length === 0;
  return { intact, brokenAt, sessionsMissing, sessionsAltered };
}
