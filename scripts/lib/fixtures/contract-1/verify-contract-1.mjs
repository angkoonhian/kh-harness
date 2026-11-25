// Checks that the kh-harness install in a repository honours contract 1,
// and that a plugin's own extension is in place to run before every tool
// call, before the plugin relies on either. Node built-ins only; it loads no
// file of the repository's. `checkContract1(root, extension)` takes the
// entry the plugin wrote for its extension, `{ id, version, module, sha256,
// onFailure }`, and returns `{ problems, warnings }`: one sentence per
// failed check, and one per risk the caller should show. Rely on the gate
// only when `problems` is empty.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

const CONTRACT_PATH = '.claude/kh-harness/contract.json';
const EXTENSIONS_PATH = '.claude/kh-harness/extensions.json';
const ENTRY_SCRIPT = '.claude/scripts/dispatch-pre-tool.mjs';
const ENTRY_ARG = '${CLAUDE_PROJECT_DIR}/.claude/scripts/dispatch-pre-tool.mjs';
const LISTED_PATH = /^\.claude\/scripts\/[A-Za-z0-9._-]+\.mjs$/;
const ENTRY_KEYS = ['id', 'version', 'module', 'sha256', 'onFailure'];
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const MODULE = /^\.claude\/[A-Za-z0-9._/-]+\.mjs$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MiB = 1024 * 1024;
const FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** SHA-256 hex of `bytes` with each CRLF made LF, in one pass. */
export function lfSha256(bytes) {
  const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(lf).digest('hex');
}

/** True when `path` is a directory and not a link. */
function isRealDirectory(path) {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when nothing at all is at `path`. */
function isAbsent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

/** The bytes of the regular file at `path`, at most `maxBytes`, read from
 * one descriptor that does not follow a link at the file; null for anything
 * else. */
function readFile(path, maxBytes) {
  let fd;
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    fd = openSync(path, FLAGS);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (let n; length < buf.length && (n = readSync(fd, buf, length, buf.length - length, null)) > 0;) length += n;
    return length > maxBytes ? null : buf.subarray(0, length);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The JSON value of the file at `path`, or undefined when it cannot be
 * read or parsed. */
function readJson(path, maxBytes) {
  try {
    return JSON.parse(readFile(path, maxBytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactly = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

/** True when `settings` registers the PreToolUse entry script exactly as
 * `apply` writes it, on every tool call: an element of `hooks.PreToolUse`
 * with no key but `matcher` and `hooks`, a `matcher` that is absent, `""`
 * or `"*"`, and a hook object of exactly `type`, `command` and `args`. Any
 * other key on the hook (`async`, `timeout`, `if`, `onFailure`, …) can stop
 * it blocking, or running, on some call. */
function entryScriptRegistered(settings) {
  const elements = settings?.hooks?.PreToolUse;
  return Array.isArray(elements) && elements.some(element => isObject(element)
    && Object.keys(element).every(k => k === 'matcher' || k === 'hooks')
    && (element.matcher === undefined || element.matcher === '' || element.matcher === '*')
    && Array.isArray(element.hooks) && element.hooks.some(hook => hasExactly(hook, ['type', 'command', 'args'])
      && hook.type === 'command' && hook.command === 'node'
      && Array.isArray(hook.args) && hook.args.length === 1 && hook.args[0] === ENTRY_ARG));
}

const isEntry = e => hasExactly(e, ENTRY_KEYS)
  && typeof e.id === 'string' && ID.test(e.id)
  && typeof e.version === 'string' && VERSION.test(e.version)
  && typeof e.module === 'string' && e.module.length <= 200 && MODULE.test(e.module)
  && e.module.split('/').every(segment => segment !== '' && !segment.endsWith('.') && !segment.endsWith(' '))
  && !e.module.toLowerCase().startsWith('.claude/scripts/')
  && typeof e.sha256 === 'string' && SHA256.test(e.sha256)
  && (e.onFailure === 'block' || e.onFailure === 'allow');

/** True when `list` is an extensions file kh-harness reads as `ok`. */
function isExtensionsFile(list) {
  if (!Array.isArray(list) || list.length > 8 || !list.every(isEntry)) return false;
  const ids = list.map(e => e.id);
  const modules = list.map(e => e.module.toLowerCase());
  return new Set(ids).size === ids.length && new Set(modules).size === modules.length;
}

const isUnder = (path, dir) => path.startsWith(dir + sep);

/** True when the module `rel` names is a regular file under the
 * repository's real `.claude/`, outside its real `.claude/scripts/`, of at
 * most 1 MiB, whose bytes hash to `sha256`. */
function moduleMatches(root, rel, sha256) {
  try {
    const realRoot = realpathSync.native(root);
    const claude = realpathSync.native(join(realRoot, '.claude'));
    const scripts = realpathSync.native(join(realRoot, '.claude/scripts'));
    const real = realpathSync.native(join(realRoot, rel));
    if (!isUnder(claude, realRoot) || !isUnder(real, claude) || isUnder(real, scripts)) return false;
    const bytes = readFile(real, MiB);
    return bytes !== null && lfSha256(bytes) === sha256;
  } catch {
    return false;
  }
}

function contractProblems(root) {
  const bytes = readFile(join(root, CONTRACT_PATH), 65536);
  if (bytes === null) return [`${CONTRACT_PATH} is missing, a link, not a regular file, or larger than 65536 bytes`];
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return [`${CONTRACT_PATH} is not JSON`];
  }
  // Written by kh-harness as JSON.stringify(value, null, 2) and a newline;
  // anything else, such as a repeated key, is not a file it wrote.
  if (!isObject(file) || `${JSON.stringify(file, null, 2)}\n` !== text) return [`${CONTRACT_PATH} is not in the form kh-harness writes`];
  if (file.contract !== 1) return [`${CONTRACT_PATH} does not say contract 1`];
  if (!isObject(file.files) || !Object.hasOwn(file.files, ENTRY_SCRIPT)) return [`${CONTRACT_PATH} does not list ${ENTRY_SCRIPT}`];
  const problems = [];
  for (const [path, sha256] of Object.entries(file.files)) {
    if (!LISTED_PATH.test(path)) {
      problems.push(`${CONTRACT_PATH} lists a path that is not an installed script`);
      continue;
    }
    const installed = readFile(join(root, path), 4 * MiB);
    if (installed === null || lfSha256(installed) !== sha256) problems.push(`${path} is not the file contract 1 speaks for`);
  }
  return problems;
}

function settingsProblems(root) {
  const problems = [];
  const settings = readJson(join(root, '.claude/settings.json'), MiB);
  const localPath = join(root, '.claude/settings.local.json');
  const local = isAbsent(localPath) ? {} : readJson(localPath, MiB);
  if (!isObject(settings)) problems.push('.claude/settings.json could not be read');
  if (!isObject(local)) problems.push('.claude/settings.local.json could not be read');
  if (settings?.disableAllHooks === true) problems.push('.claude/settings.json sets disableAllHooks');
  if (local?.disableAllHooks === true) problems.push('.claude/settings.local.json sets disableAllHooks');
  if (isObject(settings) && !entryScriptRegistered(settings)) problems.push(`.claude/settings.json does not register ${ENTRY_SCRIPT} on PreToolUse for every tool call, as apply writes it`);
  return problems;
}

function extensionProblems(root, extension) {
  const bytes = readFile(join(root, EXTENSIONS_PATH), 65536);
  if (bytes === null) return [`${EXTENSIONS_PATH} is missing, a link, not a regular file, or larger than 65536 bytes`];
  let list;
  try {
    list = JSON.parse(bytes.toString('utf8'));
  } catch {
    list = undefined;
  }
  if (!isExtensionsFile(list)) return [`${EXTENSIONS_PATH} is not an extensions file as contract 1 describes one, so every tool call is blocked`];
  const listed = list.find(e => e.id === extension.id);
  if (listed === undefined || ENTRY_KEYS.some(k => listed[k] !== extension[k])) return [`${EXTENSIONS_PATH} does not list the extension ${extension.id} as expected`];
  return moduleMatches(root, listed.module, listed.sha256) ? [] : [`the module of ${listed.id} does not hash to its recorded sha256`];
}

export function checkContract1(root, extension) {
  for (const dir of ['.claude', '.claude/kh-harness', '.claude/scripts']) {
    if (!isRealDirectory(join(root, dir))) return { problems: [`${dir} is missing, a link, or not a directory`], warnings: [] };
  }
  const problems = [...contractProblems(root), ...settingsProblems(root), ...extensionProblems(root, extension)];
  const warnings = extension.onFailure === 'allow'
    ? [`the extension ${extension.id} has onFailure "allow": if its module is missing or differs, its gate is off and only the person is told, once per session`]
    : [];
  return { problems, warnings };
}
