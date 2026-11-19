#!/usr/bin/env node
// PostToolUseFailure hook: tells Claude when the same call has failed the
// same way three times in a row, so it changes approach instead of
// repeating it.
//
// A failure's signature is a SHA-256 over the tool name, the canonical JSON
// of the tool input and the first non-empty line of the error. A failure's
// count is how many failures in a row, ending with it, carried its
// signature, so a failure with a different signature starts a new count at
// 1. Counts are kept per session and per agent: a sub-agent's failures
// arrive with its `agent_id` and are counted apart from the main agent's and
// every other sub-agent's.
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
// extending it. The marker is never shortened: it grows by 98 bytes per
// failure of the session's agent, and only its tail, at most MAX_READ_BYTES,
// is ever read back.
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
import { closeSync, constants, fstatSync, readSync, writeFileSync, writeSync } from 'node:fs';

// The shared asset beside this hook can be older than the hook: `apply`
// leaves a hand-edited copy in place, and a static import of a name that
// copy lacks would fail at link time with exit 1 on every failed call. Its
// shape is probed instead. A failure payload beside a stale or missing one
// gets one line naming the fix, shown to the person, with exit 0: once per
// session when the copy still has the marker helpers, on every failure when
// it does not. The asset cannot hold this text: it is the file that may be
// missing.
const NEEDED = ['canonicalJson', 'markerPath', 'openMarker', 'projectRoot', 'safeSessionId', 'stripAnsi'];
const MARKING = ['markerPath', 'projectRoot', 'safeSessionId'];
const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared asset; if apply reports it kept/modified, run `uninstall --yes` and then `apply --yes`.';
let asset = {};
let assetProblem = null;
try {
  asset = await import('./harness-redact.mjs');
  if (NEEDED.some(name => !(name in asset))) assetProblem = 'is older than this hook and lacks what it needs';
} catch {
  assetProblem = 'is missing or cannot be loaded';
}
const { canonicalJson, markerPath, openMarker, projectRoot, safeSessionId, stripAnsi } = asset;

const WARN_AT = 3;
const WARNING = 'The same call has failed 3 times in a row with the same error. Stop repeating it and change approach.';

const NONCE_BYTES = 16;
const RECORD = /^[0-9a-f]{64} [0-9a-f]{32}$/;
// The bytes read from the end of the marker at first, about forty records,
// doubled until they hold this run's record and the WARN_AT records before
// it, the whole file, or MAX_READ_BYTES.
const TAIL_BYTES = 4096;
// About 670 records: far more runs than ever append after one run of one
// agent before it reads, while a read stays one small buffer however long
// the session.
const MAX_READ_BYTES = 64 * 1024;

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

/** How many identical signatures end at `record` in the marker open as `fd`,
 * counted up to WARN_AT + 1, or 0 when `record` and the WARN_AT records
 * before it are not all within the last MAX_READ_BYTES. */
function runEndingAt(fd, record) {
  const signature = record.slice(0, record.indexOf(' '));
  const size = fstatSync(fd).size;
  for (let span = TAIL_BYTES; ; span = Math.min(span * 2, MAX_READ_BYTES)) {
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
    if (start === 0 || span === MAX_READ_BYTES) return 0;
  }
}

/** Whether `sentence` is to be told in the session `rawSessionId` names:
 * true the first time, through a marker created exclusively, and every time
 * when the shared copy lacks the marker helpers or no marker can be made.
 * tool-gate.mjs keeps its own copy: the only module both hooks could share
 * is harness-redact.mjs, the copy this notice is about. */
function firstTelling(rawSessionId, sentence) {
  if (MARKING.some(name => !(name in asset))) return true;
  const sessionId = safeSessionId(rawSessionId);
  const tag = createHash('sha256').update(sentence, 'utf8').digest('hex').slice(0, 16);
  const path = sessionId === null ? null : markerPath(projectRoot(), sessionId, `loop-watch-notice-${tag}`);
  if (path === null) return true;
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
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
  if (assetProblem !== null) {
    const sentence = `kh-harness loop-watch: .claude/scripts/harness-redact.mjs ${assetProblem}, so repeated failures are not counted — ${REMEDY}`;
    if (firstTelling(payload.session_id, sentence)) process.stdout.write(JSON.stringify({ systemMessage: sentence }) + '\n');
    return;
  }
  const sessionId = safeSessionId(payload.session_id);
  const agent = agentKey(payload.agent_id);
  if (sessionId === null || agent === null) return;
  const base = markerPath(projectRoot(), sessionId, 'loop-watch');
  if (base === null) return;
  const record = `${signatureOf(toolName, toolInput, error)} ${randomBytes(NONCE_BYTES).toString('hex')}`;
  const fd = openMarker(`${base}.${agent}`, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT);
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
