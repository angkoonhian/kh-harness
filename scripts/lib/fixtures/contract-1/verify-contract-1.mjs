// Checks that the kh-harness install in a repository honours contract 1
// before a plugin relies on it. Node built-ins only; it loads no file of
// the repository's. `contract1Problems(root)` returns [] when every check
// passes, and otherwise one sentence per failed check.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT_PATH = '.claude/kh-harness/contract.json';
const ENTRY_SCRIPT = '.claude/scripts/dispatch-pre-tool.mjs';
const ENTRY_ARG = '${CLAUDE_PROJECT_DIR}/.claude/scripts/dispatch-pre-tool.mjs';
const LISTED_PATH = /^\.claude\/scripts\/[A-Za-z0-9._-]+\.mjs$/;
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

/** The bytes of the regular file `rel` under `root`, at most `maxBytes`,
 * read from one descriptor that does not follow a link at the file; null
 * for anything else. */
function readFile(root, rel, maxBytes) {
  const path = join(root, rel);
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

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** True when `.claude/settings.json` registers the PreToolUse entry script
 * for every tool call, in the form kh-harness writes. */
function entryScriptRegistered(root) {
  const bytes = readFile(root, '.claude/settings.json', 1024 * 1024);
  let settings;
  try {
    settings = JSON.parse(bytes.toString('utf8'));
  } catch {
    return false;
  }
  const elements = settings?.hooks?.PreToolUse;
  return Array.isArray(elements) && elements.some(element => isObject(element)
    && (element.matcher === undefined || element.matcher === '' || element.matcher === '*')
    && Array.isArray(element.hooks) && element.hooks.some(hook => isObject(hook)
      && hook.type === 'command' && hook.command === 'node'
      && Array.isArray(hook.args) && hook.args.length === 1 && hook.args[0] === ENTRY_ARG));
}

export function contract1Problems(root) {
  for (const dir of ['.claude', '.claude/kh-harness', '.claude/scripts']) {
    if (!isRealDirectory(join(root, dir))) return [`${dir} is missing, a link, or not a directory`];
  }
  const bytes = readFile(root, CONTRACT_PATH, 65536);
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
    const installed = readFile(root, path, 4 * 1024 * 1024);
    if (installed === null || lfSha256(installed) !== sha256) problems.push(`${path} is not the file contract 1 speaks for`);
  }
  if (!entryScriptRegistered(root)) problems.push(`.claude/settings.json does not register ${ENTRY_SCRIPT} on PreToolUse for every tool call`);
  return problems;
}
