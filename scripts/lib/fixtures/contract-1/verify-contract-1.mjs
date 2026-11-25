// Checks that the kh-harness install in a repository honours contract 1,
// and that a plugin's own extension is in place to run before every tool
// call, before the plugin relies on either. Node built-ins only.
// `checkContract1(root, extension)` takes the repository root and the entry
// the plugin wrote for its extension, an object of exactly
// `{ id, version, module, sha256, onFailure }`, and returns
// `{ problems, warnings }`: one sentence per failed check, and one per risk.
// It loads no file of the repository's. `probeContract1(root, extension,
// payload)` then runs the installed entry script on `payload`, a hook input
// the extension blocks, and returns `{ problems }`; it runs the repository's
// code. A gate that must hold is relied on only when all three lists are
// empty.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

const CONTRACT_PATH = '.claude/kh-harness/contract.json';
const EXTENSIONS_PATH = '.claude/kh-harness/extensions.json';
const ENTRY_SCRIPT = '.claude/scripts/dispatch-pre-tool.mjs';
// Contract 1 always lists these: the entry script, the core and the loader.
const ALWAYS_LISTED = [ENTRY_SCRIPT, '.claude/scripts/harness-dispatch.mjs', '.claude/scripts/harness-extensions.mjs'];
const ENTRY_ARG = '${CLAUDE_PROJECT_DIR}/.claude/scripts/dispatch-pre-tool.mjs';
const LISTED_PATH = /^\.claude\/scripts\/[A-Za-z0-9._-]+\.mjs$/;
const ENTRY_KEYS = ['id', 'version', 'module', 'sha256', 'onFailure'];
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const MODULE = /^\.claude\/[A-Za-z0-9._/-]+\.mjs$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MiB = 1024 * 1024;
// A project setting's `env` reaches every hook process. These change what
// the kit's hooks do, or which script and repository the hook runs.
const HOOK_ENV = /^(HK_|KH_)|^(NODE_OPTIONS|PATH|CLAUDE_PROJECT_DIR)$/;
const PROBE_TIMEOUT_MS = 30_000;
const NOT_AN_ENTRY = 'the extension given is not an entry { id, version, module, sha256, onFailure } as contract 1 describes one';
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
  if (!isObject(file) || `${JSON.stringify(file, null, 2)}\n` !== text) {
    return [`${CONTRACT_PATH} is not in the form kh-harness writes`];
  }
  if (file.contract !== 1) return [`${CONTRACT_PATH} does not say contract 1`];
  if (!isObject(file.files)) return [`${CONTRACT_PATH} lists no files`];
  const unlisted = ALWAYS_LISTED.filter(path => !Object.hasOwn(file.files, path));
  if (unlisted.length > 0) return [`${CONTRACT_PATH} does not list ${unlisted.join(', ')}`];
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
  // Claude Code was seen to turn every hook off for disableAllHooks `true`
  // and for the string "true"; any other value but false is refused too,
  // since how Claude Code reads it was not seen.
  for (const [name, value] of [['.claude/settings.json', settings], ['.claude/settings.local.json', local]]) {
    if (isObject(value) && Object.hasOwn(value, 'disableAllHooks') && value.disableAllHooks !== false) {
      problems.push(`${name} sets disableAllHooks to a value other than false`);
    }
    // Compared in upper case: on win32 a variable's name has no case.
    if (isObject(value) && isObject(value.env) && Object.keys(value.env).some(key => HOOK_ENV.test(key.toUpperCase()))) {
      problems.push(`${name} sets, under env, a variable that changes what the kit's hooks do (HK_*, KH_*, NODE_OPTIONS, PATH or CLAUDE_PROJECT_DIR)`);
    }
  }
  if (isObject(settings) && !entryScriptRegistered(settings)) {
    problems.push(`.claude/settings.json does not register ${ENTRY_SCRIPT} on PreToolUse for every tool call, as apply writes it`);
  }
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
  if (!isExtensionsFile(list)) {
    return [`${EXTENSIONS_PATH} is not an extensions file as contract 1 describes one, so every tool call is blocked`];
  }
  const listed = list.find(e => e.id === extension.id);
  if (listed === undefined || ENTRY_KEYS.some(k => listed[k] !== extension[k])) {
    return [`${EXTENSIONS_PATH} does not list the extension ${extension.id} as expected`];
  }
  if (!moduleMatches(root, listed.module, listed.sha256)) return [`the module of ${listed.id} does not hash to its recorded sha256`];
  return [];
}

export function checkContract1(root, extension) {
  if (!isEntry(extension)) {
    return { problems: [NOT_AN_ENTRY], warnings: [] };
  }
  for (const dir of ['.claude', '.claude/kh-harness', '.claude/scripts']) {
    if (!isRealDirectory(join(root, dir))) {
      return { problems: [`${dir} is missing, a link, or not a directory`], warnings: [] };
    }
  }
  const problems = [...contractProblems(root), ...settingsProblems(root), ...extensionProblems(root, extension)];
  const warnings = extension.onFailure === 'allow'
    ? [`the extension ${extension.id} has onFailure "allow": if its module is missing or differs, its gate is off and only the person is told, once per session`]
    : [];
  return { problems, warnings };
}

/** The `env` of the project's two settings files, the local one last, as
 * strings; what cannot be read gives nothing. */
function projectEnv(root) {
  const env = {};
  for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
    const value = readJson(join(root, name), MiB);
    if (isObject(value) && isObject(value.env)) {
      for (const [key, v] of Object.entries(value.env)) env[key] = String(v);
    }
  }
  return env;
}

/** Runs the installed entry script as Claude Code runs it, from `root`, with
 * the project settings' `env` over this process's environment and
 * `CLAUDE_PROJECT_DIR` set to `root`, on `payload`: a hook input the
 * extension `extension` must block. Requires exit 0 and one JSON object
 * denying the call with a line from that extension. It runs the repository's
 * code, and shows only what the install does at this moment. */
export function probeContract1(root, extension, payload) {
  if (!isEntry(extension)) return { problems: [NOT_AN_ENTRY] };
  const r = spawnSync(process.execPath, [join(root, ENTRY_SCRIPT)], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...projectEnv(root), CLAUDE_PROJECT_DIR: root },
    timeout: PROBE_TIMEOUT_MS,
  });
  if (r.error?.code === 'ETIMEDOUT') return { problems: [`the installed entry script did not finish within ${PROBE_TIMEOUT_MS / 1000} seconds`] };
  if (r.error !== undefined || r.signal !== null) return { problems: ['the installed entry script could not be run to its end'] };
  if (r.status !== 0) return { problems: ['the installed entry script exited with a code other than 0'] };
  let output;
  try {
    output = JSON.parse(r.stdout);
  } catch {
    output = undefined;
  }
  const decision = isObject(output) ? output.hookSpecificOutput : undefined;
  const denied = isObject(decision) && decision.hookEventName === 'PreToolUse' && decision.permissionDecision === 'deny'
    && typeof decision.permissionDecisionReason === 'string'
    && decision.permissionDecisionReason.split('\n').some(line => line.startsWith(`kh-harness extension ${extension.id}: `));
  return { problems: denied ? [] : [`the installed entry script did not print the deny contract 1 describes for the extension ${extension.id}`] };
}
