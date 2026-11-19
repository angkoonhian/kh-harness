// scripts/lib/session-log.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR and HK_MARKER_DIR, so
// nothing here reads or writes the real `~/.claude/kh-harness` or the shared
// marker directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalJson, readEvents, repoDataDir, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { CONTENT_FIELDS, KEPT_FIELDS, SEAL_IDLE_MS, verifyIndex } from '../../assets/scripts/harness-seal.mjs';
import { stripAnsi } from '../../assets/scripts/harness-redact.mjs';
import { LOGGED_EVENTS, toLogEvent } from '../../assets/scripts/session-log.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const HOOK = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'session-log.mjs');
const FORBID_SPAWN = resolve(import.meta.dirname, 'session-log-forbid-spawn.cjs');
const PROBES = resolve(import.meta.dirname, 'session-log-probes.cjs');

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

sandboxMarkerDir();
process.env.KH_DATA_DIR = tempDir('hk-slog-data-');

/** A project root that is its own repository, so the key never depends on
 * what lies above the temp directory. */
function project() {
  const d = tempDir('hk-slog-repo-');
  mkdirSync(join(d, '.git'));
  return d;
}

function enabledProject() {
  const root = project();
  setEnabled(root, true);
  return root;
}

function runHook(root, stdin, { nodeArgs = [], env = {} } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, HOOK], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
}

function assertSilentSuccess(result) {
  assert.equal(result.status, 0, `exit status; stderr: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}

const events = (root, sessionId) => readEvents(root, sessionId).events;

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

const toolPayload = (hookEventName, sessionId, extra = {}) => ({
  session_id: sessionId,
  prompt_id: 'prompt-1',
  cwd: '/work',
  hook_event_name: hookEventName,
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run test suite' },
  tool_use_id: 'toolu_01',
  ...extra,
});

// Read in full from https://code.claude.com/docs/en/hooks on 2026-11-19.
// Every documented event that carries session activity. Not registered:
// PreModelSwitch (a hook on it delays a switch that PostModelSwitch records
// once made), PostToolBatch (repeats each PostToolUse), and the events that
// describe the environment or the display rather than the session's work.
const PINNED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'InstructionsLoaded',
  'PreCompact',
  'PostCompact',
  'PostModelSwitch',
  'SessionEnd',
];

test('LOGGED_EVENTS equals the pinned list', () => {
  assert.deepEqual([...LOGGED_EVENTS].sort(), [...PINNED_EVENTS].sort());
  assert.ok(Object.isFrozen(LOGGED_EVENTS));
});

test('every logged event maps to one line typed by its event name', () => {
  for (const name of LOGGED_EVENTS) {
    const event = toLogEvent({ session_id: 's1', cwd: '/work', hook_event_name: name });
    assert.equal(event?.type, name);
    assert.equal(event.session_id, 's1');
    assert.equal(event.cwd, '/work');
  }
});

test('with the log disabled the hook writes nothing and exits 0', () => {
  const root = project();
  const dataDir = tempDir('hk-slog-off-');
  const markers = tempDir('hk-slog-off-markers-');
  const result = runHook(root, toolPayload('PostToolUse', 'off-1', { tool_name: 'mcp__srv__get', tool_response: 'x' }), {
    env: { KH_DATA_DIR: dataDir, HK_MARKER_DIR: markers },
  });
  assertSilentSuccess(result);
  assert.deepEqual(readdirSync(dataDir), []);
  assert.deepEqual(readdirSync(markers), []);
});

/** The payload fields the hook read, recorded by the probe preload. */
function fieldsRead(root, payload) {
  const probe = join(tempDir('hk-slog-probe-'), 'reads');
  assertSilentSuccess(runHook(root, payload, { nodeArgs: ['--require', PROBES], env: { KH_PAYLOAD_PROBE: probe } }));
  return existsSync(probe) ? new Set(readFileSync(probe, 'utf8').split('\n').filter(Boolean)) : new Set();
}

test('with the log disabled the hook does not read the tool response', () => {
  const payload = toolPayload('PostToolUse', 'probe-1', { tool_response: { stdout: 'x' } });
  assert.deepEqual([...fieldsRead(project(), payload)].sort(), ['hook_event_name', 'session_id']);
  // The probe sees the reads an enabled hook makes, so its silence above is
  // evidence rather than a probe that never ran.
  const enabled = fieldsRead(enabledProject(), payload);
  assert.ok(enabled.has('tool_response') && enabled.has('tool_input'), [...enabled].join(','));
});

test('an unwritable data directory exits 0 with no output', () => {
  const root = enabledProject();
  // A file where the sessions directory belongs makes the append fail.
  writeFileSync(join(repoDataDir(root), 'sessions'), '');
  const result = runHook(root, toolPayload('PostToolUse', 'unwritable-1', { tool_response: 'ok' }));
  assertSilentSuccess(result);
  assert.deepEqual(events(root, 'unwritable-1'), []);
});

test('an unknown event name exits 0 and writes nothing', () => {
  const root = enabledProject();
  for (const name of ['NotAnEvent', 'Notification', 'constructor', '__proto__']) {
    assert.equal(toLogEvent({ session_id: 'unknown-1', hook_event_name: name }), null, name);
    assertSilentSuccess(runHook(root, { session_id: 'unknown-1', hook_event_name: name }));
  }
  assert.equal(existsSync(join(repoDataDir(root), 'sessions')), false);
});

test('unparseable stdin exits 0 and writes nothing', () => {
  const root = enabledProject();
  for (const stdin of ['', '{not json', '[]', 'null', '"SessionStart"']) {
    assertSilentSuccess(runHook(root, stdin));
  }
  assert.equal(existsSync(join(repoDataDir(root), 'sessions')), false);
});

test('a payload whose session id cannot name a file writes nothing', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, toolPayload('PreToolUse', '../escape')));
  assert.equal(existsSync(join(repoDataDir(root), 'sessions')), false);
});

test('a tool use before it runs records the tool, the input hash and the input size', () => {
  const root = enabledProject();
  const payload = toolPayload('PreToolUse', 'pre-1');
  assertSilentSuccess(runHook(root, payload));
  const [event] = events(root, 'pre-1');
  const canonical = canonicalJson(payload.tool_input);
  assert.equal(event.type, 'PreToolUse');
  assert.equal(event.tool, 'Bash');
  assert.equal(event.inputHash, sha256(canonical));
  assert.equal(event.inputBytes, Buffer.byteLength(canonical, 'utf8'));
  assert.equal(event.session_id, 'pre-1');
  assert.equal(event.prompt_id, 'prompt-1');
  assert.equal(event.tool_use_id, 'toolu_01');
  assert.equal(event.input, undefined);
});

test('the input hash does not depend on key order', () => {
  const a = toLogEvent(toolPayload('PreToolUse', 's', { tool_input: { a: 1, b: { c: 2, d: 3 } } }));
  const b = toLogEvent(toolPayload('PreToolUse', 's', { tool_input: { b: { d: 3, c: 2 }, a: 1 } }));
  assert.equal(a.inputHash, b.inputHash);
});

test('a successful tool use records status, duration, sizes, input and output', () => {
  const root = enabledProject();
  const payload = toolPayload('PostToolUse', 'post-1', { tool_response: { stdout: 'all passed', stderr: '' }, duration_ms: 812 });
  assertSilentSuccess(runHook(root, payload));
  const [event] = events(root, 'post-1');
  assert.equal(event.type, 'PostToolUse');
  assert.equal(event.status, 'ok');
  assert.equal(event.durationMs, 812);
  assert.equal(event.inputHash, sha256(canonicalJson(payload.tool_input)));
  assert.deepEqual(event.input, payload.tool_input);
  assert.deepEqual(event.output, payload.tool_response);
  assert.equal(event.outputBytes, Buffer.byteLength(JSON.stringify(payload.tool_response), 'utf8'));
  assert.equal(event.firstErrorLine, undefined);
});

test('a tool failure records the first error line and status', () => {
  const root = enabledProject();
  const error = '\u001b[31m\n   \nExit code 1\u001b[0m\nError: Cannot find module \'express\'';
  assertSilentSuccess(runHook(root, toolPayload('PostToolUseFailure', 'fail-1', { error, is_interrupt: false, duration_ms: 4187 })));
  const [event] = events(root, 'fail-1');
  assert.equal(event.type, 'PostToolUseFailure');
  assert.equal(event.status, 'error');
  assert.equal(event.firstErrorLine, 'Exit code 1');
  assert.equal(event.durationMs, 4187);
  assert.equal(event.output, stripAnsi(error));
  assert.equal(event.outputBytes, Buffer.byteLength(error, 'utf8'));

  const interrupted = toLogEvent(toolPayload('PostToolUseFailure', 's', { error: 'aborted', is_interrupt: true }));
  assert.equal(interrupted.status, 'interrupted');
});

test('the first error line is cut to 300 characters', () => {
  const event = toLogEvent(toolPayload('PostToolUseFailure', 's', { error: `\n${'é'.repeat(400)}\nsecond` }));
  assert.equal(event.firstErrorLine, 'é'.repeat(300));
});

test('a failure with no error text records no error line', () => {
  const event = toLogEvent(toolPayload('PostToolUseFailure', 's', { error: '\n \n' }));
  assert.equal(event.status, 'error');
  assert.equal(event.firstErrorLine, undefined);

  // The documented failure payload carries `error`, not `tool_response`.
  const undocumented = toLogEvent(toolPayload('PostToolUseFailure', 's', { tool_response: 'Exit code 1' }));
  assert.equal(undocumented.firstErrorLine, undefined);
  assert.equal(undocumented.output, undefined);
});

test('a credential in tool input or output is masked in the stored line', () => {
  const root = enabledProject();
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const payload = toolPayload('PostToolUse', 'secret-1', {
    tool_input: { command: `curl -H "x" https://example.test?t=${token}` },
    tool_response: { stdout: `token ${token}` },
  });
  assertSilentSuccess(runHook(root, payload));
  const [event] = events(root, 'secret-1');
  assert.doesNotMatch(JSON.stringify(event), new RegExp(token));
  // The hash is of what was run, so the same call hashes the same whether or
  // not it carried a secret the scrub recognised.
  assert.equal(event.inputHash, sha256(canonicalJson(payload.tool_input)));
});

test('a prompt submission records the prompt text', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, { session_id: 'prompt-s', hook_event_name: 'UserPromptSubmit', prompt: 'fix the parser' }));
  const [event] = events(root, 'prompt-s');
  assert.equal(event.type, 'UserPromptSubmit');
  assert.equal(event.prompt, 'fix the parser');
});

test('instruction loading records the path and the reason', () => {
  const event = toLogEvent({
    session_id: 's', hook_event_name: 'InstructionsLoaded',
    file_path: '/work/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start',
  });
  assert.equal(event.path, '/work/CLAUDE.md');
  assert.equal(event.reason, 'session_start');
  assert.equal(event.memoryType, 'Project');
});

test('session start writes the event and then a harness line with the model', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, { session_id: 'start-1', cwd: '/work', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }));
  const [start, harness, ...rest] = events(root, 'start-1');
  assert.equal(start.type, 'SessionStart');
  assert.equal(start.source, 'startup');
  assert.equal(harness.type, 'harness');
  assert.equal(harness.session_id, 'start-1');
  assert.equal(harness.base, 'none');
  assert.match(harness.learned, /^[0-9a-f]{64}$/);
  assert.equal(harness.kitVersion, null);
  assert.equal(harness.model, 'claude-opus-5');
  assert.deepEqual(rest, []);

  assertSilentSuccess(runHook(root, { session_id: 'start-2', hook_event_name: 'SessionStart', source: 'clear' }));
  assert.equal(Object.hasOwn(events(root, 'start-2')[1], 'model'), false);
});

test('session start records the transcript path', () => {
  const root = enabledProject();
  const transcript = '/home/u/.claude/projects/p/start-t.jsonl';
  assertSilentSuccess(runHook(root, { session_id: 'start-t', hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript }));
  assert.equal(events(root, 'start-t')[0].transcriptPath, transcript);
  assert.equal(Object.hasOwn(toLogEvent({ session_id: 's', hook_event_name: 'SessionStart' }), 'transcriptPath'), false);
});

const harnessLines = (root, sessionId) => events(root, sessionId).filter(e => e.type === 'harness');

test('a model switch writes a harness line with the new model', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, { session_id: 'switch-1', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5' }));
  assertSilentSuccess(runHook(root, { session_id: 'switch-1', hook_event_name: 'PostModelSwitch', from_model: 'claude-sonnet-5', to_model: 'claude-opus-5', source: 'command' }));
  const [first, second] = harnessLines(root, 'switch-1');
  assert.equal(first.model, 'claude-sonnet-5');
  assert.equal(second.model, 'claude-opus-5');
  assert.equal(second.base, first.base);
  assert.equal(second.learned, first.learned);
  assert.equal(second.kitVersion, first.kitVersion);
  assert.deepEqual(events(root, 'switch-1').map(e => e.type), ['SessionStart', 'harness', 'PostModelSwitch', 'harness']);
});

test('a prompt with nothing changed writes no harness line', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, { session_id: 'same-1', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }));
  assertSilentSuccess(runHook(root, { session_id: 'same-1', hook_event_name: 'UserPromptSubmit', prompt: 'one' }));
  assertSilentSuccess(runHook(root, { session_id: 'same-1', hook_event_name: 'UserPromptSubmit', prompt: 'two' }));
  assert.deepEqual(events(root, 'same-1').map(e => e.type), ['SessionStart', 'harness', 'UserPromptSubmit', 'UserPromptSubmit']);
});

test('a prompt after an installed hook script changes writes a new harness line', () => {
  const root = enabledProject();
  const script = join(root, '.claude', 'scripts', 'lint-touched.mjs');
  mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
  writeFileSync(script, '// v1\n');
  writeFileSync(join(root, '.claude', 'kh-harness.manifest.json'), JSON.stringify({
    schema: 1, kitVersion: '0.1.0', files: [{ path: '.claude/scripts/lint-touched.mjs' }],
  }));
  assertSilentSuccess(runHook(root, { session_id: 'moved-1', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }));
  writeFileSync(script, '// v2, edited by hand\n');
  assertSilentSuccess(runHook(root, { session_id: 'moved-1', hook_event_name: 'UserPromptSubmit', prompt: 'go on' }));
  const [before, later] = harnessLines(root, 'moved-1');
  assert.notEqual(later.base, before.base);
  assert.equal(later.model, 'claude-opus-5', 'the last known model carries over');
  assert.equal(later.kitVersion, '0.1.0');
  assert.deepEqual(events(root, 'moved-1').map(e => e.type), ['SessionStart', 'harness', 'UserPromptSubmit', 'harness']);
});

test('a prompt in a session with no harness line yet writes one, without a model', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, { session_id: 'late-1', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));
  const [line] = harnessLines(root, 'late-1');
  assert.equal(line.base, 'none');
  assert.equal(Object.hasOwn(line, 'model'), false);
});

test('session end writes one marker line and nothing else', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, { session_id: 'end-1', cwd: '/work', hook_event_name: 'SessionEnd', reason: 'other' }));
  const lines = events(root, 'end-1');
  assert.equal(lines.length, 1);
  const { schema: _schema, ts: _ts, pid: _pid, ...fields } = lines[0];
  assert.deepEqual(fields, { type: 'SessionEnd', session_id: 'end-1', cwd: '/work', reason: 'other' });
});

test('a model switch records both models', () => {
  const event = toLogEvent({ session_id: 's', hook_event_name: 'PostModelSwitch', from_model: 'claude-sonnet-5', to_model: 'claude-opus-5', source: 'auto' });
  assert.equal(event.fromModel, 'claude-sonnet-5');
  assert.equal(event.toModel, 'claude-opus-5');
  assert.equal(event.source, 'auto');
});

test('the agent\'s own account of its work is never logged', () => {
  const claim = 'All tests pass and the task is done.';
  for (const name of ['Stop', 'SubagentStop', 'StopFailure', 'PostCompact']) {
    const event = toLogEvent({
      session_id: 's', hook_event_name: name, agent_id: 'a1', agent_type: 'Explore',
      last_assistant_message: claim, compact_summary: claim, stop_hook_active: false,
    });
    assert.doesNotMatch(JSON.stringify(event), /tests pass/, name);
  }
});

test('an MCP tool marks the session external once', () => {
  const root = enabledProject();
  const mcp = toolPayload('PostToolUse', 'ext-1', { tool_name: 'mcp__docs__search', tool_input: { q: 'x' }, tool_response: 'r' });
  assertSilentSuccess(runHook(root, mcp));
  assertSilentSuccess(runHook(root, mcp));
  assertSilentSuccess(runHook(root, toolPayload('PostToolUseFailure', 'ext-1', { tool_name: 'WebFetch', tool_input: { url: 'https://example.test' }, error: 'timeout' })));
  const external = events(root, 'ext-1').filter(e => e.type === 'external_content');
  assert.equal(external.length, 1);
  assert.equal(external[0].session_id, 'ext-1');
  assert.equal(external[0].tool, 'mcp__docs__search');

  assertSilentSuccess(runHook(root, toolPayload('PostToolUse', 'ext-2', { tool_name: 'WebSearch', tool_input: { query: 'x' }, tool_response: [] })));
  assert.equal(events(root, 'ext-2').filter(e => e.type === 'external_content').length, 1);

  assertSilentSuccess(runHook(root, toolPayload('PostToolUse', 'ext-3', { tool_name: 'Read', tool_input: { file_path: '/work/a' }, tool_response: 'a' })));
  assert.equal(events(root, 'ext-3').filter(e => e.type === 'external_content').length, 0);
});

test('an outside-content flag that fails to write is retried on the next call', () => {
  const root = enabledProject();
  const mcp = toolPayload('PostToolUse', 'ext-retry', { tool_name: 'mcp__docs__search', tool_input: { q: 'x' }, tool_response: 'r' });
  const failing = { nodeArgs: ['--require', PROBES], env: { KH_FAIL_APPEND_MATCHING: '"type":"external_content"' } };
  assertSilentSuccess(runHook(root, mcp, failing));
  assert.deepEqual(events(root, 'ext-retry').map(e => e.type), ['PostToolUse']);
  assertSilentSuccess(runHook(root, mcp));
  assertSilentSuccess(runHook(root, mcp));
  assert.deepEqual(events(root, 'ext-retry').map(e => e.type), ['PostToolUse', 'PostToolUse', 'external_content', 'PostToolUse']);
});

test('the spawn trap records a child process', () => {
  const trap = join(tempDir('hk-slog-trap-'), 'calls');
  const result = spawnSync(process.execPath, ['--require', FORBID_SPAWN, '-e', 'try { require("node:child_process").spawnSync("x"); } catch {}'], {
    encoding: 'utf8', env: { ...process.env, KH_SPAWN_TRAP: trap },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(trap), true);
});

test('the hook never spawns a child process', () => {
  const root = enabledProject();
  const trap = join(tempDir('hk-slog-trap-'), 'calls');
  const options = { nodeArgs: ['--require', FORBID_SPAWN], env: { KH_SPAWN_TRAP: trap } };
  const payloads = [
    { session_id: 'nospawn-1', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' },
    { session_id: 'nospawn-1', hook_event_name: 'UserPromptSubmit', prompt: 'go' },
    toolPayload('PreToolUse', 'nospawn-1'),
    toolPayload('PostToolUse', 'nospawn-1', { tool_name: 'mcp__srv__get', tool_response: 'x' }),
    toolPayload('PostToolUseFailure', 'nospawn-1', { error: 'Exit code 1' }),
    { session_id: 'nospawn-1', hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5', to_model: 'claude-sonnet-5', source: 'auto' },
    { session_id: 'nospawn-1', hook_event_name: 'SessionEnd', reason: 'other' },
  ];
  for (const payload of payloads) assertSilentSuccess(runHook(root, payload, options));
  assert.equal(existsSync(trap), false);
  assert.deepEqual(events(root, 'nospawn-1').map(e => e.type), [
    'SessionStart', 'harness', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'external_content',
    'PostToolUseFailure', 'PostModelSwitch', 'harness', 'SessionEnd',
  ]);
});

/** A payload that answers every field the hook reads with `value`, so each
 * handler writes every field it can. */
const everyField = (name, value) =>
  new Proxy({}, { get: (_, key) => (key === 'hook_event_name' ? name : typeof key === 'symbol' ? undefined : value) });

/** The fields the classification gives an event type, content and kept. */
function classified(type) {
  const content = CONTENT_FIELDS[type] ?? [];
  for (const field of content) assert.equal(KEPT_FIELDS[type].includes(field), false, `${type}.${field} is both`);
  return [...new Set([...KEPT_FIELDS[type], ...content])].sort();
}

const ENVELOPE = new Set(['schema', 'ts', 'pid']);

test('every field the hook writes is classified as content or kept', () => {
  assert.deepEqual(Object.keys(KEPT_FIELDS).sort(), [...LOGGED_EVENTS, 'external_content', 'harness'].sort());
  for (const type of Object.keys(CONTENT_FIELDS)) assert.ok(Object.hasOwn(KEPT_FIELDS, type), type);
  for (const name of LOGGED_EVENTS) {
    const written = new Set(['text', 7].flatMap(value => Object.keys(toLogEvent(everyField(name, value)))));
    assert.deepEqual([...written].sort(), classified(name), name);
  }
});

test('the harness and outside-content lines the hook writes are classified too', () => {
  const root = enabledProject();
  const identity = { prompt_id: 'prompt-1', tool_use_id: 'toolu_01', agent_id: 'agent-1', cwd: '/work' };
  assertSilentSuccess(runHook(root, { session_id: 'writers-1', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5', ...identity }));
  assertSilentSuccess(runHook(root, toolPayload('PostToolUse', 'writers-1', { tool_name: 'mcp__srv__get', tool_response: 'x', ...identity })));
  for (const type of ['harness', 'external_content']) {
    const [line] = events(root, 'writers-1').filter(e => e.type === type);
    assert.deepEqual(Object.keys(line).filter(k => !ENVELOPE.has(k)).sort(), classified(type), type);
  }
});

const sessionsDir = root => join(repoDataDir(root), 'sessions');

/** Makes a session's plain file look idle past the sealing threshold. */
const idle = (root, sessionId) => {
  const at = new Date(Date.now() - SEAL_IDLE_MS - 60_000);
  utimesSync(join(sessionsDir(root), `s-${sessionId}.jsonl`), at, at);
};

test('a session start seals the other sessions, silently and without spawning', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, toolPayload('PostToolUse', 'earlier-1', { tool_response: 'ok' })));
  assertSilentSuccess(runHook(root, { session_id: 'earlier-1', hook_event_name: 'SessionEnd', reason: 'other' }));
  idle(root, 'earlier-1');
  const trap = join(tempDir('hk-slog-trap-'), 'calls');
  assertSilentSuccess(runHook(root, { session_id: 'next-1', hook_event_name: 'SessionStart', source: 'startup' }, {
    nodeArgs: ['--require', FORBID_SPAWN], env: { KH_SPAWN_TRAP: trap },
  }));
  assert.equal(existsSync(trap), false);
  assert.deepEqual(readdirSync(sessionsDir(root)).sort(), ['s-earlier-1.jsonl.gz', 's-next-1.jsonl']);
  assert.deepEqual(events(root, 'earlier-1').map(e => e.type), ['PostToolUse', 'SessionEnd']);
  const index = readFileSync(join(repoDataDir(root), 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(index.map(l => l.sessionId), ['earlier-1']);
  assert.deepEqual(verifyIndex(root), { intact: true, brokenAt: null, sessionsMissing: [], sessionsAltered: [], sessionsPending: [], unreadable: false });
});

test('with the log disabled a session start seals nothing', () => {
  const root = enabledProject();
  assertSilentSuccess(runHook(root, toolPayload('PostToolUse', 'off-earlier', { tool_response: 'ok' })));
  idle(root, 'off-earlier');
  setEnabled(root, false);
  assertSilentSuccess(runHook(root, { session_id: 'off-next', hook_event_name: 'SessionStart', source: 'startup' }));
  assert.deepEqual(readdirSync(sessionsDir(root)), ['s-off-earlier.jsonl']);
  assert.equal(existsSync(join(repoDataDir(root), 'index.jsonl')), false);
});

const ASSETS = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts');
const HOOK_MODULES = ['session-log.mjs', 'harness-log.mjs', 'harness-redact.mjs'];

/** A copy of the hook and its siblings as they are installed. With
 * `sealLoads` set, the sealing module is copied too and appends a line to
 * that file when it is loaded; without it, the sealing module is absent. */
function installedHook({ sealLoads } = {}) {
  const dir = tempDir('hk-slog-installed-');
  for (const name of HOOK_MODULES) writeFileSync(join(dir, name), readFileSync(join(ASSETS, name)));
  if (sealLoads !== undefined) {
    const recordLoad = `import { appendFileSync as recordLoad } from 'node:fs';\nrecordLoad(${JSON.stringify(sealLoads)}, 'loaded\\n');\n`;
    writeFileSync(join(dir, 'harness-seal.mjs'), recordLoad + readFileSync(join(ASSETS, 'harness-seal.mjs'), 'utf8'));
  }
  return join(dir, 'session-log.mjs');
}

function runInstalled(hook, root, payload) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
}

test('only a session start loads the sealing module', () => {
  const root = enabledProject();
  const loads = join(tempDir('hk-slog-loads-'), 'loads');
  const hook = installedHook({ sealLoads: loads });
  const others = [
    { session_id: 'lazy-1', hook_event_name: 'UserPromptSubmit', prompt: 'go' },
    toolPayload('PreToolUse', 'lazy-1'),
    toolPayload('PostToolUse', 'lazy-1', { tool_name: 'mcp__srv__get', tool_response: 'x' }),
    toolPayload('PostToolUseFailure', 'lazy-1', { error: 'Exit code 1' }),
    { session_id: 'lazy-1', hook_event_name: 'SessionEnd', reason: 'other' },
  ];
  for (const payload of others) assertSilentSuccess(runInstalled(hook, root, payload));
  assert.equal(existsSync(loads), false);
  idle(root, 'lazy-1');

  assertSilentSuccess(runInstalled(hook, root, { session_id: 'lazy-2', hook_event_name: 'SessionStart', source: 'startup' }));
  assert.equal(readFileSync(loads, 'utf8'), 'loaded\n');
  assert.deepEqual(readdirSync(sessionsDir(root)).sort(), ['s-lazy-1.jsonl.gz', 's-lazy-2.jsonl']);
});

test('a session start with the sealing module missing records the event and does nothing more', () => {
  const root = enabledProject();
  const hook = installedHook();
  assertSilentSuccess(runInstalled(hook, root, toolPayload('PostToolUse', 'nomod-1', { tool_response: 'ok' })));
  idle(root, 'nomod-1');
  assertSilentSuccess(runInstalled(hook, root, { session_id: 'nomod-2', hook_event_name: 'SessionStart', source: 'startup' }));
  assert.deepEqual(readdirSync(sessionsDir(root)).sort(), ['s-nomod-1.jsonl', 's-nomod-2.jsonl']);
  assert.deepEqual(events(root, 'nomod-2').map(e => e.type), ['SessionStart', 'harness']);
  assert.equal(existsSync(join(repoDataDir(root), 'index.jsonl')), false);
});

// Measured on the development machine (win32, Node 24) on 2026-11-19, on a
// quiet machine: the hook's median was about 85 ms for a tool result and 88
// ms for a prompt, against about 58 ms for a bare `node -e 0`, so it adds
// about 30 ms. Node start-up alone varied from 55 to 115 ms with machine
// load, so the budget bounds what the hook adds over a bare start, measured
// in interleaved runs that share the same load.
const ADDED_LATENCY_BUDGET_MS = 100;

const timed = run => {
  const start = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

const medianOf = times => {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

test('median wall time over 20 runs is under the budget recorded in the test', () => {
  const root = enabledProject();
  const payload = toolPayload('PostToolUse', 'latency-1', { tool_response: { stdout: 'x'.repeat(4096) }, duration_ms: 10 });
  const stdin = JSON.stringify(payload);
  const hookTimes = [];
  const bareTimes = [];
  for (let i = 0; i < 20; i++) {
    hookTimes.push(timed(() => assertSilentSuccess(runHook(root, stdin))));
    bareTimes.push(timed(() => assertSilentSuccess(spawnSync(process.execPath, ['-e', '0'], {
      input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    }))));
  }
  const hook = medianOf(hookTimes);
  const bare = medianOf(bareTimes);
  assert.ok(hook - bare <= ADDED_LATENCY_BUDGET_MS,
    `hook median ${hook.toFixed(1)} ms, bare node median ${bare.toFixed(1)} ms, budget for the difference ${ADDED_LATENCY_BUDGET_MS} ms`);
  assert.equal(events(root, 'latency-1').length, 20);
});
