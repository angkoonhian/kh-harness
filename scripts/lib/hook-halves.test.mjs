// scripts/lib/hook-halves.test.mjs
//
// Each of the four tool-call hooks exports a half: a function that takes the
// parsed payload and returns what the script, run directly, would write and
// exit with. These tests compare each half with a direct run of its script
// on a twin project, and pin that importing a script neither reads standard
// input nor exits (see half-fixtures.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { readEvents, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { GATES_PATH } from '../../assets/scripts/tool-gate.mjs';
import { runHalf } from './half-fixtures.mjs';
import { SENSOR_MATCHER } from './propose.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const ASSETS = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts');
const GATE = join(ASSETS, 'tool-gate.mjs');
const LOG = join(ASSETS, 'session-log.mjs');
const LINT = join(ASSETS, 'lint-touched.mjs');
const LOOP = join(ASSETS, 'loop-watch.mjs');

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
process.env.KH_DATA_DIR = tempDir('hk-halves-data-');

/** A project root that is its own repository, so its data directory never
 * depends on what lies above the temp directory. */
function project() {
  const d = tempDir('hk-halves-repo-');
  mkdirSync(join(d, '.git'));
  return d;
}

function direct(script, root, payload) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function gatedProject() {
  const root = project();
  const path = join(root, GATES_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 1, gates: [{
    id: 'L1', tool: 'Bash', field: 'command', match: { kind: 'token', value: 'rm -rf' }, action: 'block',
    message: 'Move files to the trash folder instead of deleting them.',
  }] }));
  return root;
}

const call = (session, command) => ({
  session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command, description: 'Run a command' }, tool_use_id: 'toolu_01',
});

const toolPayload = (hookEventName, sessionId) => ({
  session_id: sessionId, prompt_id: 'prompt-1', cwd: '/work', hook_event_name: hookEventName,
  tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run test suite' }, tool_use_id: 'toolu_01',
});

function repo(script) {
  const d = project();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: script } }));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  return d;
}
const failingRepo = () => repo('node -e "console.error(\'src/a.ts:1 no-unused-vars\'); process.exit(1)"');

const edit = (session, filePath) => ({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: filePath } });

const WARNING = 'The same call has failed with the same error 3 times, with no different failure between them. Stop repeating it and change approach.';
const WARNING_OUTPUT = JSON.stringify({
  systemMessage: WARNING,
  hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: WARNING },
}) + '\n';

const failure = session => ({
  session_id: session, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
  tool_input: { command: 'npm test' }, error: 'Exit code 1',
});

test('gateHalf returns what tool-gate.mjs prints, and null for another event', () => {
  const rootA = gatedProject();
  const rootB = gatedProject();
  const half = runHalf(GATE, 'gateHalf', rootA, call('half-gate-1', 'rm -rf build'));
  const run = direct(GATE, rootB, call('half-gate-2', 'rm -rf build'));
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny', 'the gate blocks');
  assert.deepEqual(half, { json: JSON.parse(run.stdout), stderr: '', exitCode: 0 });
  assert.equal(run.stdout, JSON.stringify(half.json) + '\n');
  assert.equal(runHalf(GATE, 'gateHalf', rootA, { ...call('half-gate-3', 'rm -rf build'), hook_event_name: 'PostToolUse' }), null);
});

test('logHalf records the event and returns null on a tool-call event', () => {
  const root = project();
  setEnabled(root, true);
  assert.equal(runHalf(LOG, 'logHalf', root, toolPayload('PreToolUse', 'half-log-1')), null);
  assert.deepEqual(readEvents(root, 'half-log-1').events.map(e => e.type), ['PreToolUse']);
  assert.equal(runHalf(LOG, 'logHalf', root, { session_id: 'half-log-1', hook_event_name: 'NotLogged' }), null);
  assert.deepEqual(readEvents(root, 'half-log-1').events.map(e => e.type), ['PreToolUse'], 'an event that is not logged is not recorded');
});

test('session-log.mjs run directly still writes its notice with no trailing newline', () => {
  const dir = tempDir('hk-halves-scripts-');
  for (const name of readdirSync(ASSETS)) copyFileSync(join(ASSETS, name), join(dir, name));
  rmSync(join(dir, 'harness-log.mjs'));
  const root = project();
  const run = direct(join(dir, 'session-log.mjs'), root, toolPayload('PreToolUse', 'half-log-2'));
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  assert.deepEqual(Object.keys(JSON.parse(run.stdout)), ['systemMessage']);
  assert.equal(run.stdout.endsWith('\n'), false);
  const half = runHalf(join(dir, 'session-log.mjs'), 'logHalf', root, toolPayload('PreToolUse', 'half-log-3'));
  assert.deepEqual(Object.keys(half), ['json', 'stderr', 'exitCode']);
  assert.equal(half.stderr, '');
  assert.equal(half.exitCode, 0);
  assert.equal(JSON.stringify(half.json), run.stdout);
});

test('lintHalf returns the report as stderr with exit code 2, exactly as lint-touched.mjs writes it', () => {
  const repoA = failingRepo();
  const repoB = failingRepo();
  const half = runHalf(LINT, 'lintHalf', repoA, edit('half-lint-1', 'src/a.ts'));
  const run = direct(LINT, repoB, edit('half-lint-2', 'src/a.ts'));
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /no-unused-vars/);
  assert.deepEqual(half, { json: null, stderr: run.stderr, exitCode: 2 });
});

test('lintHalf runs for each tool SENSOR_MATCHER names and for no other tool or event; run directly the script still tests neither', () => {
  for (const tool of SENSOR_MATCHER.split('|')) {
    assert.equal(runHalf(LINT, 'lintHalf', failingRepo(), { ...edit(`half-lint-${tool}`, 'src/a.ts'), tool_name: tool }).exitCode, 2, tool);
  }
  const read = session => ({ ...edit(session, 'src/a.ts'), tool_name: 'Read' });
  assert.equal(runHalf(LINT, 'lintHalf', failingRepo(), read('half-lint-3')), null);
  assert.equal(runHalf(LINT, 'lintHalf', failingRepo(), { ...edit('half-lint-4', 'src/a.ts'), hook_event_name: 'PreToolUse' }), null);
  assert.equal(direct(LINT, failingRepo(), read('half-lint-5')).status, 2, 'the direct run is as it was');
});

test('lintHalf returns the not-confirmed-clean notice as JSON with exit code 0', () => {
  const half = runHalf(LINT, 'lintHalf', repo('node -e "process.exit(1)"'), edit('half-lint-6', 'src/a.ts'));
  assert.equal(half.exitCode, 0);
  assert.equal(half.stderr, '');
  assert.deepEqual(Object.keys(half.json), ['systemMessage', 'hookSpecificOutput']);
  assert.equal(half.json.hookSpecificOutput.additionalContext, half.json.systemMessage);
  const run = direct(LINT, repo('node -e "process.exit(1)"'), edit('half-lint-7', 'src/a.ts'));
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, JSON.stringify(half.json) + '\n');
});

test('loopHalf warns at the third identical failure as loop-watch.mjs does, and refuses another event', () => {
  const rootA = project();
  const rootB = project();
  const halves = [1, 2, 3].map(() => runHalf(LOOP, 'loopHalf', rootA, failure('half-loop-1')));
  assert.deepEqual(halves, [null, null, { json: JSON.parse(WARNING_OUTPUT), stderr: '', exitCode: 0 }]);
  const other = { ...failure('half-loop-2'), hook_event_name: 'PostToolUse' };
  assert.deepEqual([1, 2, 3].map(() => runHalf(LOOP, 'loopHalf', rootA, other)), [null, null, null]);
  assert.deepEqual([1, 2, 3].map(() => direct(LOOP, rootB, other).stdout), ['', '', WARNING_OUTPUT], 'the direct run is as it was');
});
