#!/usr/bin/env node
// assets/scripts/session-log.mjs
//
// Registered for every event in `LOGGED_EVENTS`: records each one as a line
// in this machine's session log, once the log is enabled for the repository.
//
// It must never change what Claude Code does: whatever happens it exits 0
// and writes nothing to stdout or stderr. On several of the logged events
// (SessionStart, UserPromptSubmit, PreCompact and PostModelSwitch) plain
// stdout reaches the model or the compaction summary, so the hook writes no
// stdout on any event. It runs on every tool call, so it spawns no child
// process, and with the log disabled, the default, it reads only the event
// name and the session id. Scrubbing, the inline cap and the envelope fields
// are `appendEvent`'s, so the hook hands it raw payload fields.
//
// Only what the payload reports as having happened is recorded. The agent's
// own text (`last_assistant_message`, a compaction summary) is a claim, not
// an observation, and is never copied.
import { createHash } from 'node:crypto';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { appendEvent, canonicalJson, harnessIdentity, isEnabled } from './harness-log.mjs';
import { markerPath, projectRoot, readJSONMarker, safeSessionId, stripAnsi, writeJSONMarker } from './harness-redact.mjs';

const IDENTITY_FIELDS = ['session_id', 'prompt_id', 'tool_use_id', 'agent_id', 'cwd'];

const MAX_ERROR_LINE_CHARS = 300;

/** The payload fields named in `rename` that are present, under their new
 * names. */
function carried(payload, rename) {
  return Object.fromEntries(Object.entries(rename)
    .filter(([from]) => payload[from] !== undefined)
    .map(([from, to]) => [to, payload[from]]));
}

const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');

const textOf = value => (typeof value === 'string' ? value : JSON.stringify(value));

/** The tool and its input as hashed and measured: the canonical JSON of the
 * raw input, so the hash names the call whatever the scrub later hides. */
function toolCall(payload) {
  const canonical = canonicalJson(payload.tool_input ?? null);
  return { tool: payload.tool_name, inputHash: sha256Hex(canonical), inputBytes: Buffer.byteLength(canonical, 'utf8') };
}

/** The first non-blank line of `text` without colour, cut to
 * `MAX_ERROR_LINE_CHARS` code points; undefined when there is none. */
function firstErrorLine(text) {
  if (typeof text !== 'string') return undefined;
  const line = stripAnsi(text).split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0);
  return line === undefined ? undefined : [...line].slice(0, MAX_ERROR_LINE_CHARS).join('');
}

function toolResult(payload, status, output) {
  const event = { ...toolCall(payload), status };
  if (status !== 'ok') {
    const line = firstErrorLine(output);
    if (line !== undefined) event.firstErrorLine = line;
  }
  if (Number.isFinite(payload.duration_ms)) event.durationMs = payload.duration_ms;
  if (output !== undefined) event.outputBytes = Buffer.byteLength(textOf(output), 'utf8');
  return { ...event, input: payload.tool_input, output };
}

function failureStatus(payload) {
  return payload.is_interrupt === true ? 'interrupted' : 'error';
}

const FIELDS_BY_EVENT = {
  SessionStart: p => carried(p, { source: 'source', transcript_path: 'transcriptPath' }),
  UserPromptSubmit: p => carried(p, { prompt: 'prompt' }),
  PreToolUse: toolCall,
  PermissionRequest: toolCall,
  PermissionDenied: p => ({ ...toolCall(p), ...carried(p, { reason: 'reason' }) }),
  PostToolUse: p => toolResult(p, 'ok', p.tool_response),
  PostToolUseFailure: p => toolResult(p, failureStatus(p), p.error),
  SubagentStart: p => carried(p, { agent_type: 'agentType' }),
  SubagentStop: p => carried(p, { agent_type: 'agentType', stop_hook_active: 'stopHookActive' }),
  Stop: p => carried(p, { stop_hook_active: 'stopHookActive' }),
  StopFailure: p => carried(p, { error: 'error', error_details: 'errorDetails' }),
  InstructionsLoaded: p => carried(p, { file_path: 'path', load_reason: 'reason', memory_type: 'memoryType' }),
  PreCompact: p => carried(p, { trigger: 'trigger' }),
  PostCompact: p => carried(p, { trigger: 'trigger' }),
  PostModelSwitch: p => carried(p, { from_model: 'fromModel', to_model: 'toModel', source: 'source' }),
  SessionEnd: p => carried(p, { reason: 'reason' }),
};

/** The hook event names this script records, as documented in the hooks
 * reference. */
export const LOGGED_EVENTS = Object.freeze(Object.keys(FIELDS_BY_EVENT));

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The log line for one hook payload: `type` is the event name, then the
 * identity fields the payload carries as strings, then the event's own
 * fields. Null for a payload that is not an object or an event not in
 * `LOGGED_EVENTS`.
 */
export function toLogEvent(payload) {
  if (!isPlainObject(payload)) return null;
  const type = payload.hook_event_name;
  if (!isLoggedEvent(type)) return null;
  return { type, ...identityOf(payload), ...FIELDS_BY_EVENT[type](payload) };
}

const isLoggedEvent = name => typeof name === 'string' && Object.hasOwn(FIELDS_BY_EVENT, name);

function identityOf(payload) {
  return Object.fromEntries(IDENTITY_FIELDS.filter(f => typeof payload[f] === 'string').map(f => [f, payload[f]]));
}

const EXTERNAL_TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);

const fetchesOutsideContent = tool =>
  typeof tool === 'string' && (tool === 'WebFetch' || tool === 'WebSearch' || tool.startsWith('mcp__'));

/**
 * Writes the session's `external_content` line unless an earlier call
 * already did. The once-only marker is an exclusive create, which never
 * follows a planted link and lets one of several parallel hooks win. A
 * repeated flag is harmless and a missing one is not, so a marker that
 * cannot be made still lets the line be written, and a marker this call made
 * is removed again when the line could not be written, so the next call
 * retries.
 */
function recordExternal(root, sessionId, payload, tool) {
  const path = markerPath(root, sessionId, 'session-log-external');
  let created = false;
  if (path !== null) {
    try {
      writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
      created = true;
    } catch (error) {
      if (error?.code === 'EEXIST') return;
    }
  }
  const { written } = appendEvent(root, sessionId, { type: 'external_content', ...identityOf(payload), tool });
  if (written || !created) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // a marker left in place costs this session its flag; nothing else reads it
  }
}

// Where each event that can carry the session's model carries it.
const MODEL_FIELD = { SessionStart: 'model', PostModelSwitch: 'to_model' };

// SessionStart and PostModelSwitch always write a `harness` line; a prompt
// writes one only when the identity or the model has moved since the last.
const HARNESS_EVENTS = new Set(['SessionStart', 'PostModelSwitch', 'UserPromptSubmit']);

const HARNESS_FIELDS = ['base', 'learned', 'kitVersion', 'model'];

/**
 * Writes a `harness` line when this event calls for one, and remembers what
 * it wrote in a per-session marker. The marker is a separate file from the
 * external-content one, which must stay an exclusive create to be once only.
 * An unreadable marker reads as no previous line, so the cost of losing it
 * is one repeated `harness` line.
 */
function recordHarness(root, sessionId, payload) {
  const path = markerPath(root, sessionId, 'session-log-harness');
  const last = path === null ? null : readJSONMarker(path, null);
  const field = MODEL_FIELD[payload.hook_event_name];
  const carriedModel = field === undefined ? undefined : payload[field];
  const lastModel = typeof last?.model === 'string' ? last.model : undefined;
  const model = typeof carriedModel === 'string' ? carriedModel : lastModel;
  const current = { ...harnessIdentity(root), ...(model === undefined ? {} : { model }) };
  const unchanged = last !== null && HARNESS_FIELDS.every(f => last[f] === current[f]);
  if (payload.hook_event_name === 'UserPromptSubmit' && unchanged) return;
  const { written } = appendEvent(root, sessionId, { type: 'harness', ...identityOf(payload), ...current });
  if (written && path !== null) writeJSONMarker(path, current);
}

function record(payload) {
  if (!isPlainObject(payload) || !isLoggedEvent(payload.hook_event_name)) return;
  const sessionId = safeSessionId(payload.session_id);
  if (sessionId === null) return;
  const root = projectRoot();
  if (!isEnabled(root)) return;
  const event = toLogEvent(payload);
  const { written } = appendEvent(root, sessionId, event);
  if (!written) return;
  if (HARNESS_EVENTS.has(event.type)) recordHarness(root, sessionId, payload);
  if (EXTERNAL_TOOL_EVENTS.has(event.type) && fetchesOutsideContent(event.tool)) recordExternal(root, sessionId, payload, event.tool);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  record(payload);
}

/** True when this file is the process's entry point rather than an import.
 * Both sides are resolved to their real spelling, since the command line may
 * name the script through a link or a win32 short name. */
function isEntryPoint() {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    await main();
  } catch {
    // a failure to record must not reach Claude Code
  }
  process.exitCode = 0;
}
