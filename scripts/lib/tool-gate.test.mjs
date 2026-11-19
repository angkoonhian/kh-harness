// scripts/lib/tool-gate.test.mjs
//
// Pinned against the hooks reference, https://code.claude.com/docs/en/hooks,
// read on 2026-11-19, section "PreToolUse":
//   - "In addition to the common input fields, PreToolUse hooks receive
//     `tool_name`, `tool_input`, and `tool_use_id`"; the common fields
//     include `session_id`, `cwd`, `permission_mode` and `hook_event_name`.
//     `PAYLOAD_EXAMPLE` below is the page's example input, verbatim but for
//     the elided paths;
//   - decision control is `hookSpecificOutput` with `hookEventName:
//     "PreToolUse"`. `permissionDecision: "deny"` "prevents the tool call",
//     and its `permissionDecisionReason` is "shown to Claude"; the page's
//     example is `{ hookSpecificOutput: { hookEventName: "PreToolUse",
//     permissionDecision: "deny", permissionDecisionReason: "..." } }`;
//   - `permissionDecision: "allow"` "skips the permission prompt", so a warn
//     gate sets no decision at all: "Exit code 0 with no output means the
//     hook has no decision to report, so the tool call continues through the
//     normal permission flow";
//   - `additionalContext` is a "String added to Claude's context alongside
//     the tool result";
//   - `systemMessage` is a common output field: "Warning message shown to the
//     user". The PreToolUse section does not say it discards it.
//
// Pinned against the permissions reference,
// https://code.claude.com/docs/en/permissions, read on 2026-11-19, "How path
// patterns match": a `/path` pattern is a "Path relative to the settings
// source", and a rule defined in "Project settings at `.claude/settings.json`"
// resolves to "<primary working directory>/path"; "`Edit(/src/**)` and
// `Edit(src/components/**)` match only at their anchored location". A bare
// `path` is relative to the current directory, and as a deny rule matches at
// any depth. "Claude Code checks file permissions against `Edit(path)` and
// `Read(path)` rules": `Write` is covered by `Edit(...)`.
//
// Every test runs against a temporary KH_DATA_DIR and HK_MARKER_DIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { GATE_LIMITS, gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH as LOG_GATES_PATH, LOCAL_GATES_FILE as LOG_LOCAL_GATES_FILE, readEvents, repoDataDir, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { GATES_PATH, LOCAL_GATES_FILE } from '../../assets/scripts/tool-gate.mjs';
import { APPLY, DETECT, UNINSTALL, git, run, settings } from './lifecycle-fixtures.mjs';
import { HARNESS_GATES_PATH, HARNESS_LOG_PATH, REDACT_PATH, TOOL_GATE_PATH, toolGateDenyRules } from './propose.mjs';
import { DETECT_REPORT_PATH } from './report.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const HOOK = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'tool-gate.mjs');
const FORBID_SPAWN = resolve(import.meta.dirname, 'session-log-forbid-spawn.cjs');

const PAYLOAD_EXAMPLE = {
  session_id: 'abc123',
  transcript_path: '/home/user/.claude/projects/.../transcript.jsonl',
  cwd: '/home/user/my-project',
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: {
    command: 'npm test',
    description: 'Run test suite',
    timeout: 120000,
    run_in_background: false,
  },
  tool_use_id: 'toolu_01ABC123...',
};

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
process.env.KH_DATA_DIR = tempDir('hk-gate-data-');

/** A project root that is its own repository, so its data directory never
 * depends on what lies above the temp directory. */
function project({ enabled = true } = {}) {
  const d = tempDir('hk-gate-repo-');
  mkdirSync(join(d, '.git'));
  if (enabled) setEnabled(d, true);
  return d;
}

const gate = (id, o = {}) => ({
  id, tool: 'Bash', field: 'command', match: { kind: 'token', value: 'rm -rf' }, action: 'observe',
  message: 'Move files to the trash folder instead of deleting them.', ...o,
});
const gateFile = gates => JSON.stringify({ schema: 1, gates });

function writeAt(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const writeCommitted = (root, text) => writeAt(join(root, GATES_PATH), text);
const writeLocal = (root, text) => writeAt(join(repoDataDir(root), LOCAL_GATES_FILE), text);

const call = (session, command, o = {}) => ({ ...PAYLOAD_EXAMPLE, session_id: session, tool_input: { ...PAYLOAD_EXAMPLE.tool_input, command }, ...o });

/** The hook's stdout, parsed, or null when it printed nothing. */
function runHook(root, stdin, { nodeArgs = [], env = {}, script = HOOK } = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, script], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  assert.equal(result.status, 0, `exit status; stderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  return result.stdout === '' ? null : JSON.parse(result.stdout);
}

const firings = (root, session) => readEvents(root, session).events.filter(e => e.type === 'gate_firing');

const denial = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const context = text => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });

test('the hook re-exports the gate file locations from harness-log.mjs', () => {
  assert.equal(GATES_PATH, '.claude/kh-harness/gates.json');
  assert.equal(LOCAL_GATES_FILE, 'gates.local.json');
  assert.equal(GATES_PATH, LOG_GATES_PATH);
  assert.equal(LOCAL_GATES_FILE, LOG_LOCAL_GATES_FILE);
});

test('an observe gate records a firing and prints nothing', () => {
  const root = project();
  const g = gate('L1');
  writeCommitted(root, gateFile([g]));
  assert.equal(runHook(root, call('observe-1', 'rm -rf build')), null);
  const [firing, ...rest] = firings(root, 'observe-1');
  assert.deepEqual(rest, []);
  assert.equal(firing.gateId, 'L1');
  assert.equal(firing.gateSha256, gateSha256(g));
  assert.equal(firing.action, 'observe');
  assert.equal(firing.tool, 'Bash');
  assert.equal(firing.tool_use_id, PAYLOAD_EXAMPLE.tool_use_id);
  assert.equal(firing.session_id, 'observe-1');

  assert.equal(runHook(root, call('observe-1', 'npm test')), null);
  assert.equal(firings(root, 'observe-1').length, 1, 'a call no gate matches records nothing');
});

test('an observe gate with the session log disabled does nothing at all', () => {
  const root = project({ enabled: false });
  writeCommitted(root, gateFile([gate('L1')]));
  assert.equal(runHook(root, call('observe-off-1', 'rm -rf build')), null);
  assert.equal(existsSync(repoDataDir(root)), false, 'nothing is written on this machine');
});

test('a block gate denies with its message', () => {
  const root = project();
  writeCommitted(root, gateFile([gate('L4', { action: 'block' })]));
  assert.deepEqual(runHook(root, call('block-1', 'rm -rf build')),
    denial('kh-harness gate L4: Move files to the trash folder instead of deleting them.'));
  assert.deepEqual(firings(root, 'block-1').map(f => [f.gateId, f.action]), [['L4', 'block']]);
});

test('a warn gate allows and adds the message', () => {
  const root = project();
  writeCommitted(root, gateFile([gate('L2', { action: 'warn' })]));
  const output = runHook(root, call('warn-1', 'rm -rf build'));
  assert.deepEqual(output, context('kh-harness gate L2: Move files to the trash folder instead of deleting them.'));
  assert.equal('permissionDecision' in output.hookSpecificOutput, false, 'the normal permission flow still decides');
  assert.deepEqual(firings(root, 'warn-1').map(f => [f.gateId, f.action]), [['L2', 'warn']]);
});

test('warn and block act with the session log disabled', () => {
  const root = project({ enabled: false });
  writeCommitted(root, gateFile([gate('L1', { action: 'warn' }), gate('L2', { action: 'block', tool: 'Write', field: 'file_path', match: { kind: 'glob', value: '*.lock' } })]));
  assert.deepEqual(runHook(root, call('off-1', 'rm -rf build')), context('kh-harness gate L1: Move files to the trash folder instead of deleting them.'));
  assert.deepEqual(runHook(root, { ...PAYLOAD_EXAMPLE, session_id: 'off-1', tool_name: 'Write', tool_input: { file_path: 'yarn.lock', content: '' } }),
    denial('kh-harness gate L2: Move files to the trash folder instead of deleting them.'));
  assert.equal(existsSync(repoDataDir(root)), false);
});

test('a local suspension disables a committed gate', () => {
  const root = project();
  writeCommitted(root, gateFile([gate('L1', { action: 'block' }), gate('L2', { action: 'warn', match: { kind: 'literal', value: 'build' } })]));
  writeLocal(root, gateFile([{ id: 'L1', suspended: true }]));
  assert.deepEqual(runHook(root, call('suspend-1', 'rm -rf build')), context('kh-harness gate L2: Move files to the trash folder instead of deleting them.'),
    'the suspended gate is skipped and the next one that matches acts');
  assert.deepEqual(firings(root, 'suspend-1').map(f => f.gateId), ['L2']);
});

test('a local gate replaces the committed gate with the same id', () => {
  const root = project();
  writeCommitted(root, gateFile([gate('L1', { action: 'block' })]));
  const local = gate('L1', { action: 'warn', message: 'This machine only warns.' });
  writeLocal(root, gateFile([local]));
  assert.deepEqual(runHook(root, call('replace-1', 'rm -rf build')), context('kh-harness gate L1: This machine only warns.'));
  assert.deepEqual(firings(root, 'replace-1').map(f => f.gateSha256), [gateSha256(local)]);
});

test('gates are tried in ascending order of their number and only the first that matches acts', () => {
  const root = project();
  writeCommitted(root, gateFile([gate('L10', { action: 'block', message: 'ten' }), gate('L9', { action: 'warn', message: 'nine' })]));
  writeLocal(root, gateFile([gate('L3', { tool: 'Read', field: 'file_path', message: 'three' })]));
  assert.deepEqual(runHook(root, call('order-1', 'rm -rf build')), context('kh-harness gate L9: nine'), 'L9 comes before L10');
  assert.deepEqual(firings(root, 'order-1').map(f => f.gateId), ['L9'], 'one firing per call');
});

test('a missing gate file is silent', () => {
  const root = project();
  assert.equal(runHook(root, call('missing-1', 'rm -rf build')), null);
  writeLocal(root, gateFile([gate('L1', { action: 'warn' })]));
  assert.deepEqual(runHook(root, call('missing-1', 'rm -rf build')), context('kh-harness gate L1: Move files to the trash folder instead of deleting them.'),
    'a local file applies without a committed one');
});

const NOT_PARSED = 'kh-harness: the committed gate file .claude/kh-harness/gates.json could not be parsed, so none of its gates apply.';
const NOT_READ = "kh-harness: this machine's gate file gates.local.json could not be read, so none of its gates apply.";

test('an unreadable or malformed gate file allows the call and emits one notice per session', () => {
  const root = project();
  writeCommitted(root, '{ "schema": 1, "gates": [ { "id": "L1", "message": "<<copied from the file>>"');
  // A directory where the file belongs cannot be read on any platform.
  mkdirSync(join(repoDataDir(root), LOCAL_GATES_FILE), { recursive: true });

  const first = runHook(root, call('damaged-1', 'rm -rf build'));
  assert.deepEqual(first, { systemMessage: `${NOT_PARSED} ${NOT_READ.slice('kh-harness: '.length)}` });
  assert.equal(JSON.stringify(first).includes('copied from the file'), false, 'nothing from the file is shown');
  assert.equal(runHook(root, call('damaged-1', 'rm -rf build')), null, 'once per session');
  assert.deepEqual(runHook(root, call('damaged-2', 'npm test')), first, 'a new session is told again');
});

test('a damaged file leaves the other file\'s gates in force', () => {
  const root = project();
  writeCommitted(root, 'not json');
  writeLocal(root, gateFile([gate('L1', { action: 'block' })]));
  assert.deepEqual(runHook(root, call('damaged-3', 'rm -rf build')), {
    systemMessage: NOT_PARSED,
    ...denial('kh-harness gate L1: Move files to the trash folder instead of deleting them.'),
  });
});

test('a rejected gate is skipped and the rest still apply', () => {
  const root = project();
  writeCommitted(root, gateFile([
    gate('L1', { action: 'block', message: 'a hand edit added <b>markup</b>' }),
    gate('L2', { action: 'block', match: { kind: 'regex', value: 'rm.*' } }),
    gate('L3', { action: 'warn' }),
  ]));
  const output = runHook(root, call('rejected-1', 'rm -rf build'));
  assert.deepEqual(output, {
    systemMessage: 'kh-harness: 2 entries in the committed gate file .claude/kh-harness/gates.json were rejected and do not apply; its other gates do.',
    ...context('kh-harness gate L3: Move files to the trash folder instead of deleting them.'),
  });
  assert.equal(JSON.stringify(output).includes('markup'), false);
  assert.deepEqual(runHook(root, call('rejected-1', 'rm -rf build')), context('kh-harness gate L3: Move files to the trash folder instead of deleting them.'));

  const one = project();
  writeLocal(one, gateFile([gate('L1'), { id: 'L2', suspended: false }]));
  assert.deepEqual(runHook(one, call('rejected-2', 'npm test')), {
    systemMessage: "kh-harness: 1 entry in this machine's gate file gates.local.json was rejected and does not apply; its other gates do.",
  });
});

test('unparseable stdin, another event and a payload without a tool name are nothing to do', () => {
  const root = project();
  writeCommitted(root, gateFile([gate('L1', { action: 'block' })]));
  assert.equal(runHook(root, 'not json'), null);
  assert.equal(runHook(root, ''), null);
  assert.equal(runHook(root, call('other-1', 'rm -rf build', { hook_event_name: 'PostToolUse' })), null);
  const { tool_name: _toolName, ...noTool } = call('other-1', 'rm -rf build');
  assert.equal(runHook(root, noTool), null);
});

test('an unsafe session id still gates the call and records nothing', () => {
  const root = project();
  writeCommitted(root, gateFile([gate('L1', { action: 'block' })]));
  assert.deepEqual(runHook(root, call('../escape', 'rm -rf build')), denial('kh-harness gate L1: Move files to the trash folder instead of deleting them.'));
  assert.equal(existsSync(join(repoDataDir(root), 'sessions')), false);
});

test('the hook never spawns a child process', () => {
  const root = project();
  writeCommitted(root, 'not json');
  writeLocal(root, gateFile([gate('L1'), gate('L2', { action: 'warn', match: { kind: 'literal', value: 'build' } })]));
  const trap = join(tempDir('hk-gate-trap-'), 'calls');
  const options = { nodeArgs: ['--require', FORBID_SPAWN], env: { KH_SPAWN_TRAP: trap } };
  assert.deepEqual(runHook(root, call('nospawn-1', 'rm -rf build'), options), { systemMessage: NOT_PARSED });
  assert.deepEqual(runHook(root, call('nospawn-1', 'make build'), options), context('kh-harness gate L2: Move files to the trash folder instead of deleting them.'));
  assert.equal(existsSync(trap), false);
  assert.deepEqual(firings(root, 'nospawn-1').map(f => f.gateId), ['L1', 'L2']);
});

test('the deny rules are anchored to the project root', () => {
  assert.deepEqual(toolGateDenyRules(), [
    'Edit(/.claude/scripts/**)',
    'Edit(/.claude/kh-harness/**)',
    'Edit(/.claude/kh-harness.manifest.json)',
    'Edit(/docs/harness/LEARNED.md)',
  ]);
  for (const rule of toolGateDenyRules()) assert.match(rule, /^Edit\(\/[^/]/, `${rule}: one leading slash anchors at the project root; two would be absolute`);
});

// Measured on the development machine (win32, Node 24) on 2026-11-19, on a
// quiet machine, with `GATE_LIMITS.gatesMax` gates of which none matches and
// an input field of `GATE_LIMITS.inputMax` characters: the hook's median was
// 102 to 118 ms against 62 to 73 ms for a bare `node -e 0`, so it adds about
// 40 to 45 ms. The budget bounds what the hook adds over a bare start,
// measured in interleaved runs that share the same load.
const ADDED_LATENCY_BUDGET_MS = 100;

const timed = fn => {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

const medianOf = times => {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

test('median wall time over 20 runs is under the budget recorded in the test', () => {
  const root = project();
  const kinds = ['literal', 'token', 'glob'];
  const gates = Array.from({ length: GATE_LIMITS.gatesMax }, (_, i) =>
    gate(`L${i + 1}`, { action: 'block', match: { kind: kinds[i % 3], value: kinds[i % 3] === 'glob' ? `a*q${i}` : `aq${i}` } }));
  writeCommitted(root, gateFile(gates));
  const stdin = JSON.stringify(call('latency-1', 'a'.repeat(GATE_LIMITS.inputMax)));
  const hookTimes = [];
  const bareTimes = [];
  for (let i = 0; i < 20; i++) {
    hookTimes.push(timed(() => assert.equal(runHook(root, stdin), null)));
    bareTimes.push(timed(() => {
      const r = spawnSync(process.execPath, ['-e', '0'], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
      assert.equal(r.status, 0);
    }));
  }
  const hook = medianOf(hookTimes);
  const bare = medianOf(bareTimes);
  assert.ok(hook - bare <= ADDED_LATENCY_BUDGET_MS,
    `hook median ${hook.toFixed(1)} ms, bare node median ${bare.toFixed(1)} ms, budget for the difference ${ADDED_LATENCY_BUDGET_MS} ms`);
});

const USER_DENY = 'Edit(secrets/**)';

/** A committed repository on a feature branch with one deny rule of the
 * user's own. */
function lifecycleRepo() {
  const d = tempDir('hk-gate-life-');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app' }));
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: [USER_DENY] } }, null, 2) + '\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

test('apply installs the gate hook and uninstall then leaves git status clean', () => {
  const d = lifecycleRepo();
  const before = JSON.parse(run(DETECT, d, '--json')).checks.find(c => c.id === 'P5.toolgate');
  assert.equal(before.state, 'absent');
  assert.equal(before.decidable, true);

  run(APPLY, d, '--yes');
  for (const path of [TOOL_GATE_PATH, HARNESS_GATES_PATH, HARNESS_LOG_PATH, REDACT_PATH]) assert.ok(existsSync(join(d, path)), path);
  assert.deepEqual(settings(d).hooks.PreToolUse, [{ hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${TOOL_GATE_PATH}`] }] }]);
  const installed = JSON.parse(run(DETECT, d, '--json')).checks.find(c => c.id === 'P5.toolgate');
  assert.equal(installed.state, 'declared');

  writeCommitted(d, gateFile([gate('L1', { action: 'block' })]));
  assert.deepEqual(runHook(d, call('installed-1', 'rm -rf build'), { script: join(d, TOOL_GATE_PATH) }),
    denial('kh-harness gate L1: Move files to the trash folder instead of deleting them.'),
    'the installed copy runs beside its installed modules');
  rmSync(join(d, '.claude/kh-harness'), { recursive: true });

  run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, TOOL_GATE_PATH)), false);
  // detect's own report is written by every detect run, not by apply, so
  // uninstall does not own it.
  const status = execFileSync('git', ['-C', d, 'status', '--porcelain', '--untracked-files=all', '--', '.', `:!${DETECT_REPORT_PATH}`], { encoding: 'utf8' });
  assert.equal(status.trim(), '', `git status must be clean after the full cycle; got:\n${status}`);
});

test('the protected-surface deny rules are reverted by uninstall', () => {
  const d = lifecycleRepo();
  run(APPLY, d, '--yes');
  assert.deepEqual(settings(d).permissions.deny, [USER_DENY, ...toolGateDenyRules()]);
  run(UNINSTALL, d, '--yes');
  assert.deepEqual(settings(d).permissions.deny, [USER_DENY], 'the user\'s own rule stays');
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), JSON.stringify({ permissions: { deny: [USER_DENY] } }, null, 2) + '\n');
});
