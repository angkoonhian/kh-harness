#!/usr/bin/env node
// PostToolUseFailure hook: tells Claude when the same call has failed the
// same way three times in a row, so it changes approach instead of
// repeating it.
//
// A failure's signature is a SHA-256 over the tool name, the canonical JSON
// of the tool input and the first non-empty line of the error. The marker
// keeps, per session, the last signature and how many consecutive failures
// carried it; a failure with a different signature starts a new count at 1.
// The hook is registered only on the failure event, so a success between two
// identical failures is not seen and does not reset the count.
//
// The warning is one fixed sentence, emitted exactly at the third identical
// failure and not again for the same run. Nothing from the tool input or the
// error is printed, and only the signature is stored. A marker that cannot be
// written means no warning, since the count it would report cannot be
// trusted.
//
// Runs on every failed tool call, so it never spawns a child process. Always
// exits 0: unparseable stdin, a payload without a tool name, an error or a
// usable session id, and any internal failure are all nothing to do.
import { createHash } from 'node:crypto';
import { markerPath, projectRoot, readJSONMarker, safeSessionId, stripAnsi, writeJSONMarker } from './harness-redact.mjs';

const WARN_AT = 3;
const WARNING = 'The same call has failed 3 times in a row with the same error. Stop repeating it and change approach.';

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
  if (sessionId === null) return;
  const path = markerPath(projectRoot(), sessionId, 'loop-watch');
  if (path === null) return;

  const signature = signatureOf(toolName, toolInput, error);
  const last = readJSONMarker(path, {});
  const previous = last.signature === signature && Number.isSafeInteger(last.count) && last.count > 0 ? last.count : 0;
  const count = previous + 1;
  if (!writeJSONMarker(path, { signature, count })) return;
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
