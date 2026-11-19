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
// Parallel tool calls run overlapping instances of this hook, so the
// read-increment-write happens under a lock file beside the marker, and the
// new state is written to a temporary file and renamed over the marker. A
// lock not taken within LOCK_WAIT_MS means nothing is counted this time: a
// missed count is better than a wrong warning.
//
// The warning is one fixed sentence, emitted exactly at the third identical
// failure and not again for the same run, decided only from the state this
// process wrote under the lock. Nothing from the tool input or the error is
// printed, and only the signature is stored. A marker that cannot be written
// means no warning, since the count it would report cannot be trusted.
//
// Runs on every failed tool call, so it never spawns a child process. Always
// exits 0: unparseable stdin, a payload without a tool name, an error or a
// usable session id, an unusable agent id, and any internal failure are all
// nothing to do.
import { createHash } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { markerPath, projectRoot, readJSONMarker, safeSessionId, stripAnsi } from './harness-redact.mjs';

const WARN_AT = 3;
const WARNING = 'The same call has failed 3 times in a row with the same error. Stop repeating it and change approach.';

const LOCK_WAIT_MS = 200;
const LOCK_RETRY_MS = 5;
// Older than any hold of this lock can last, so its holder has died.
const LOCK_STALE_MS = 10_000;

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
 * hold a `.`, which separates it from the session id and the lock and
 * temporary suffixes in the marker's file name. */
function agentKey(agentId) {
  if (agentId === undefined) return 'main';
  const safe = safeSessionId(agentId);
  return safe === null ? null : `agent-${safe}`;
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Creates `lockPath` exclusively, waiting up to LOCK_WAIT_MS and removing a
 * stale lock once; true when this process holds it. */
function takeLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') return false;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      // released between the open and the stat: try again
    }
    if (Date.now() >= deadline) return false;
    pause(LOCK_RETRY_MS);
  }
}

/** Replaces the marker by rename, so a reader sees the old state or the new
 * one, whole; true when the new state is in place. `tmpPath` is free to
 * reuse because only the lock holder writes it, and `wx` never follows a
 * link planted there. */
function replaceMarker(path, tmpPath, state) {
  try {
    rmSync(tmpPath, { force: true });
    writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
    renameSync(tmpPath, path);
    return true;
  } catch {
    try { rmSync(tmpPath, { force: true }); } catch { /* the failed write is what matters */ }
    return false;
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
  const path = `${base}.${agent}`;
  const lockPath = `${path}.lock`;

  const signature = signatureOf(toolName, toolInput, error);
  if (!takeLock(lockPath)) return;
  let count;
  try {
    const last = readJSONMarker(path, {});
    const previous = last.signature === signature && Number.isSafeInteger(last.count) && last.count > 0 ? last.count : 0;
    count = previous + 1;
    if (!replaceMarker(path, `${path}.tmp`, { signature, count })) return;
  } finally {
    // A lock left behind goes stale and is removed by a later run.
    try { rmSync(lockPath, { force: true }); } catch { /* the state is already written */ }
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
