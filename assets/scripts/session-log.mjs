#!/usr/bin/env node
// assets/scripts/session-log.mjs
//
// Registered for every event in `LOGGED_EVENTS`: records each one as a line
// in this machine's session log, once the log is enabled for the repository.
//
// It must never change what Claude Code does: whatever happens it exits 0
// and writes nothing to stderr. On several of the logged events
// (SessionStart, UserPromptSubmit, PreCompact and PostModelSwitch) plain
// stdout reaches the model or the compaction summary, so the hook writes
// stdout only as one JSON object, for the two notices below. It runs on
// every tool call, so it spawns no child process, and with the log disabled,
// the default, it reads only the event name and the session id. Scrubbing,
// the inline cap and the envelope fields are `appendEvent`'s, so the hook
// hands it raw payload fields.
//
// A session start also seals the repository's other sessions and expires
// old content, within a time budget. With `autodraft` set in the log's
// configuration, the start of a new session then tells the model, as
// SessionStart `additionalContext`, how many sessions were sealed since the
// last `learn tick`, when that is any; the notice is fixed text and that
// count, and nothing read from the log.
//
// A sibling module that is missing or too old to provide what this hook
// uses means nothing is recorded, or, for the sealing module, that nothing
// is sealed or expired. The person (never the model) is told in one fixed
// `systemMessage`, once per session. When the copy of harness-redact.mjs
// beside the hook lacks the once-per-session marker helpers, only a session
// start says it, since this hook runs on every event.
//
// Only what the payload reports as having happened is recorded. The agent's
// own text (`last_assistant_message`, a compaction summary) is a claim, not
// an observation, and is never copied.
import { createHash } from 'node:crypto';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported in dependency order, so a missing module is named rather than the
// module that imports it.
const SIBLINGS = [
  ['./harness-redact.mjs', ['canonicalJson', 'markerPath', 'maskText', 'projectRoot', 'readJSONMarker', 'safeSessionId', 'writeJSONMarker']],
  ['./harness-log.mjs', ['appendEvent', 'harnessIdentity', 'isEnabled', 'LAST_TICK_FILE', 'parsedObject', 'readConfig', 'readSmallFile', 'repoDataDir']],
];
// Loaded at a session start only, so no other event parses it.
const SEAL_SIBLING = ['./harness-seal.mjs', ['applyRetention', 'sealClosedSessions', 'sessionsSealedSince']];
const MARKING = ['markerPath', 'projectRoot', 'safeSessionId'];

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

/** The sibling's module and null, or null and what is wrong with it. */
async function loadSibling([specifier, names]) {
  const shown = `.claude/scripts/${specifier.slice(2)}`;
  let module;
  try {
    module = await import(specifier);
  } catch {
    return { module: null, problem: `${shown} is missing or cannot be loaded` };
  }
  const older = names.some(name => !(name in module));
  return { module, problem: older ? `${shown} is older than this hook and lacks what it needs` : null };
}

/** The exports this hook uses, each from the first sibling that has it, and
 * `problem` naming the first sibling that could not provide all of its own;
 * the ones after that are not imported. A sibling that is too old still
 * gives the names it has, so a session can be marked as told. */
async function loadSiblings() {
  const loaded = {};
  for (const sibling of SIBLINGS) {
    const { module, problem } = await loadSibling(sibling);
    for (const name of sibling[1]) if (module !== null && name in module) loaded[name] = module[name];
    if (problem !== null) return { loaded, problem };
  }
  return { loaded, problem: null };
}

const siblings = await loadSiblings();
const {
  appendEvent, harnessIdentity, isEnabled, LAST_TICK_FILE, parsedObject, readConfig, readSmallFile, repoDataDir,
  canonicalJson, markerPath, maskText, projectRoot, readJSONMarker, safeSessionId, writeJSONMarker,
} = siblings.loaded;
const canMark = MARKING.every(name => name in siblings.loaded);

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

/** The first non-blank line of `text`, masked and then cut to
 * `MAX_ERROR_LINE_CHARS` code points, so the cut never leaves the start of a
 * credential that the mask would have hidden whole; undefined when there is
 * no such line. The whole text is masked, since a private key is recognised
 * by the lines around it, and `maskText` keeps the line count and removes
 * colour. */
function firstErrorLine(text) {
  if (typeof text !== 'string') return undefined;
  const line = maskText(text).split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0);
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
  // The project root, so a reader in another worktree of the repository
  // makes the error line's paths relative to the root they were printed
  // under, not to its own.
  PostToolUseFailure: p => ({ ...toolResult(p, failureStatus(p), p.error), root: projectRoot() }),
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

// The wall-clock time a session start may spend sealing earlier sessions and
// expiring old content; what is left over is done on a later session start.
const MAINTENANCE_BUDGET_MS = 150;

// The budget is checked between sessions and a session is read whole, so a
// session start touches no session larger than this on disk; `log maintain`
// seals and expires those.
const MAINTENANCE_MAX_SESSION_BYTES = 2 * 1024 * 1024;

/** Seals the other sessions and expires old content, through the sealing
 * module `seal`. */
function maintain(seal, root, currentSessionId) {
  const started = performance.now();
  const maxSessionBytes = MAINTENANCE_MAX_SESSION_BYTES;
  seal.sealClosedSessions(root, { currentSessionId, budgetMs: MAINTENANCE_BUDGET_MS, maxSessionBytes });
  seal.applyRetention(root, { budgetMs: MAINTENANCE_BUDGET_MS - (performance.now() - started), maxSessionBytes });
}

/** The seal index position `learn tick` recorded when it last ran; 0, so
 * that every sealed session counts, when it never ran or its record cannot
 * be read. */
function indexLinesAtLastTick(root) {
  let text;
  try {
    text = readSmallFile(join(repoDataDir(root), LAST_TICK_FILE));
  } catch {
    return 0;
  }
  const lines = parsedObject(text)?.indexLines;
  return Number.isSafeInteger(lines) && lines >= 0 ? lines : 0;
}

/** The notice for the model, or null: a fixed sentence holding only the
 * count, since it reaches the model's context. */
function learnNotice(seal, root) {
  if (!readConfig(root).autodraft) return null;
  const count = seal.sessionsSealedSince(root, indexLinesAtLastTick(root));
  if (count === 0) return null;
  return `kh-harness: ${count} sealed sessions since the last learn tick. The harness-learn skill can review them.`;
}

// Only a new session is told: a resumed, cleared, compacted or forked one
// continues a conversation that may already hold the notice.
const NOTICE_SOURCE = 'startup';

/**
 * True when this session has not been told `sentence` yet. The marker is an
 * exclusive create, so one of several parallel hooks wins. A marker that
 * cannot be made means the sentence is given anyway: a repeated notice costs
 * less than a problem nobody hears about. tool-gate.mjs and loop-watch.mjs
 * keep their own copies: the only module the three could share is
 * harness-redact.mjs, the one a notice may be about.
 */
function firstTelling(root, sessionId, sentence) {
  const tag = createHash('sha256').update(sentence, 'utf8').digest('hex').slice(0, 16);
  const path = markerPath(root, sessionId, `session-log-notice-${tag}`);
  if (path === null) return true;
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

/** Maintenance at a session start: `{ context, notice }`, the learn notice
 * for the model and the sentence for the person when the sealing module
 * cannot do its work, each null when there is none. */
async function sessionStart(root, currentSessionId, source) {
  const { module: seal, problem } = await loadSibling(SEAL_SIBLING);
  if (problem !== null) {
    const sentence = `kh-harness session-log: ${problem}, so sessions are not sealed and old content is not expired — ${REMEDY}`;
    return { context: null, notice: firstTelling(root, currentSessionId, sentence) ? sentence : null };
  }
  maintain(seal, root, currentSessionId);
  return { context: source === NOTICE_SOURCE ? learnNotice(seal, root) : null, notice: null };
}

const NOTHING = Object.freeze({ context: null, notice: null });

/** Records the payload; returns `{ context, notice }` as `sessionStart`
 * does. */
async function record(payload) {
  const sessionId = safeSessionId(payload.session_id);
  if (sessionId === null) return NOTHING;
  const root = projectRoot();
  if (!isEnabled(root)) return NOTHING;
  const event = toLogEvent(payload);
  const { written } = appendEvent(root, sessionId, event);
  if (!written) return NOTHING;
  if (HARNESS_EVENTS.has(event.type)) recordHarness(root, sessionId, payload);
  if (EXTERNAL_TOOL_EVENTS.has(event.type) && fetchesOutsideContent(event.tool)) recordExternal(root, sessionId, payload, event.tool);
  return event.type === 'SessionStart' ? sessionStart(root, sessionId, payload.source) : NOTHING;
}

/** The sentence for the person when a sibling this hook needs on every
 * event could not be used, or null when this session was already told or
 * cannot be told once only. */
function siblingNotice(payload) {
  const sentence = `kh-harness session-log: ${siblings.problem}, so nothing is recorded — ${REMEDY}`;
  if (!canMark) return payload.hook_event_name === 'SessionStart' ? sentence : null;
  const sessionId = safeSessionId(payload.session_id);
  if (sessionId === null) return null;
  return firstTelling(projectRoot(), sessionId, sentence) ? sentence : null;
}

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

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return;
  }
  if (!isPlainObject(payload) || !isLoggedEvent(payload.hook_event_name)) return;
  const { context, notice } = siblings.problem === null ? await record(payload) : { context: null, notice: siblingNotice(payload) };
  const output = {};
  if (notice !== null) output.systemMessage = notice;
  if (context !== null) output.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context };
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
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
  // Not `exitCode`: a stdin the caller never closed would keep the process.
  process.exit(0);
}
