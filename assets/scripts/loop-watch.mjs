#!/usr/bin/env node
// PostToolUseFailure hook: tells Claude when the same call has failed the
// same way three times in a row, so it changes approach instead of
// repeating it.
//
// A failure's signature is a SHA-256 over the tool name, the canonical JSON
// of the tool input and the first non-empty line of the error. The marker
// keeps, per session and per agent, the last signature and how many
// consecutive failures carried it; a failure with a different signature
// starts a new count at 1. A sub-agent's failures arrive with its `agent_id`
// and are counted apart from the main agent's and every other sub-agent's.
// The hook is registered only on the failure event, so a success between two
// identical failures is not seen and does not reset the count.
//
// Parallel tool calls run overlapping instances of this hook, and a run may
// be descheduled for longer than any wait it could afford, so no run reads a
// count and writes it back, and none waits for another. Each appends one
// record, its signature and a nonce of its own, to the marker in a single
// write to a file opened for appending, then reads the marker back and finds
// its own record. Its count is the run of identical signatures that ends at
// that record, which no later append can change: every failure is counted,
// and of any number of overlapping runs exactly one sees itself as the
// third.
//
// Each record begins with its newline, so it never joins a line the file
// already held, and a line that is not a whole record ends a run rather than
// extending it. The marker grows by one record per failure of the session's
// agent; only its tail is read.
//
// The warning is one fixed sentence, emitted exactly at the third identical
// failure and not again for the same run. Nothing from the tool input or the
// error is printed, and only the signature is stored. A record that cannot
// be written or found again means no warning, since the count it would
// report cannot be trusted.
//
// Runs on every failed tool call, so it never spawns a child process. Always
// exits 0: unparseable stdin, a payload without a tool name, an error or a
// usable session id, an unusable agent id, and any internal failure are all
// nothing to do.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { markerPath, projectRoot, safeSessionId, stripAnsi } from './harness-redact.mjs';

const WARN_AT = 3;
const WARNING = 'The same call has failed 3 times in a row with the same error. Stop repeating it and change approach.';

const NONCE_BYTES = 16;
const RECORD = /^[0-9a-f]{64} [0-9a-f]{32}$/;
// The bytes read from the end of the marker at first, doubled until they
// hold this run's record and the WARN_AT records before it, or the whole
// file: forty records, so more is read only when dozens of runs appended
// after this one.
const TAIL_BYTES = 4096;

// A hard ceiling on how long reading stdin may block; see lint-touched.mjs's
// STDIN_TIMEOUT_MS for why the read is asynchronous.
const STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000;

function readStdin(timeoutMs) {
  return new Promise(resolve => {
    let data = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => finish(data));
      process.stdin.on('error', () => finish(data));
    } catch {
      finish('');
    }
  });
}

/** JSON with object keys sorted recursively and no whitespace, for a value
 * that came from `JSON.parse`. Kept here rather than imported from
 * harness-log.mjs: the only sibling the kit installs beside this hook is
 * harness-redact.mjs. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function firstLine(text) {
  return stripAnsi(text).split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? '';
}

function signatureOf(toolName, toolInput, error) {
  const framed = JSON.stringify([toolName, canonicalJson(toolInput ?? null), firstLine(error)]);
  return createHash('sha256').update(framed, 'utf8').digest('hex');
}

/** `main` for the main agent, `agent-<id>` for a sub-agent, or null when
 * the payload's `agent_id` is not safe to put in a path. Neither form can
 * hold a `.`, which separates it from the session id in the marker's file
 * name. */
function agentKey(agentId) {
  if (agentId === undefined) return 'main';
  const safe = safeSessionId(agentId);
  return safe === null ? null : `agent-${safe}`;
}

/** Opens the marker to append to and read, creating it, never through a link
 * planted at its path: O_NOFOLLOW where the platform defines it (POSIX);
 * elsewhere an lstat first. Null when a link is there. */
function openMarker(path) {
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT;
  if (constants.O_NOFOLLOW !== undefined) return openSync(path, flags | constants.O_NOFOLLOW);
  let st = null;
  try { st = lstatSync(path); } catch { /* absent: the open creates it */ }
  return st?.isSymbolicLink() ? null : openSync(path, flags);
}

/** How many identical signatures end at `record` in the marker open as `fd`,
 * counted up to WARN_AT + 1, or 0 when `record` is not there. */
function runEndingAt(fd, record) {
  const signature = record.slice(0, record.indexOf(' '));
  const size = fstatSync(fd).size;
  for (let span = TAIL_BYTES; ; span *= 2) {
    const start = Math.max(0, size - span);
    const tail = Buffer.alloc(size - start);
    const read = readSync(fd, tail, 0, tail.length, start);
    const lines = tail.subarray(0, read).toString('latin1').split('\n');
    // A tail that starts inside the file may start inside a line.
    if (start > 0) lines.shift();
    const at = lines.indexOf(record);
    if (at !== -1 && (at >= WARN_AT || start === 0)) {
      let count = 1;
      while (count <= WARN_AT && at - count >= 0 && RECORD.test(lines[at - count]) && lines[at - count].startsWith(`${signature} `)) count++;
      return count;
    }
    if (start === 0) return 0;
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object') return;
  const { tool_name: toolName, tool_input: toolInput, error } = payload;
  if (typeof toolName !== 'string' || typeof error !== 'string') return;
  const sessionId = safeSessionId(payload.session_id);
  const agent = agentKey(payload.agent_id);
  if (sessionId === null || agent === null) return;
  const base = markerPath(projectRoot(), sessionId, 'loop-watch');
  if (base === null) return;
  const record = `${signatureOf(toolName, toolInput, error)} ${randomBytes(NONCE_BYTES).toString('hex')}`;
  const fd = openMarker(`${base}.${agent}`);
  if (fd === null) return;
  let count;
  try {
    const line = Buffer.from(`\n${record}`, 'latin1');
    if (writeSync(fd, line) !== line.length) return;
    count = runEndingAt(fd, record);
  } finally {
    closeSync(fd);
  }
  if (count !== WARN_AT) return;
  process.stdout.write(JSON.stringify({
    systemMessage: WARNING,
    hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: WARNING },
  }) + '\n');
}

(async () => {
  try {
    await main();
  } catch {
    // never throw — a hook that breaks a session is worse than none
  }
  process.exit(0);
})();
