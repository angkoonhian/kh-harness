// assets/scripts/harness-log.mjs
//
// The session log's library: where a repository's log lives on this
// machine, whether it is enabled, and how it is configured.
//
// Installed beside the other hook scripts and called by a hook on every tool
// use, so it imports only Node built-ins and sibling files, never spawns a
// child process (the git common directory is found by reading files, not by
// running git), and its read paths never throw.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
