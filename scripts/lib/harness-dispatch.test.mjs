// scripts/lib/harness-dispatch.test.mjs
//
// The shared core and the three entry scripts. `combine` and `runHalves`
// are pure and are called here; every other test runs an entry script as a
// child, and compares it with a direct run of the hook it stands in for on a
// twin project, each side in a session of its own.
//
// Pinned against the hooks reference, https://code.claude.com/docs/en/hooks,
// read on 2026-11-25, for what an entry script writes when a half exits 2
// (the two exit-2 tests below):
//   - section "Exit code output", the row for a "JSON object that passes
//     schema validation" under "Exit 2": "Blocking error. Claude Code still
//     reads the fields, but a `PreToolUse` call stays blocked even if you
//     return `"allow"` or `continue: false`";
//   - section "Exit code 2": "Other JSON that passes schema validation:
//     Claude Code still reads the JSON output fields.";
//   - section "Exit code 2 behavior per event": "`PostToolUse` | No | Shows
//     stderr to Claude; the tool already ran" and "`PostToolUseFailure` | No
//     | Shows stderr to Claude; the tool already failed".
// So with exit code 2 the combined JSON is still written to standard output
// and every half's standard error is written unchanged.
//
// Every test runs against a temporary KH_DATA_DIR and HK_MARKER_DIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { readEvents, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { combine, runHalves } from '../../assets/scripts/harness-dispatch.mjs';
import { GATES_PATH } from '../../assets/scripts/tool-gate.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const ASSETS = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts');
const GATE = join(ASSETS, 'tool-gate.mjs');
const LINT = join(ASSETS, 'lint-touched.mjs');
const FORBID_SPAWN = join(import.meta.dirname, 'session-log-forbid-spawn.cjs');
const ENTRY_SCRIPTS = ['dispatch-pre-tool.mjs', 'dispatch-post-tool.mjs', 'dispatch-tool-failure.mjs'];

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
process.env.KH_DATA_DIR = tempDir('hk-dispatch-data-');

/** A project root that is its own repository, with the session log
 * enabled. */
function project() {
  const d = tempDir('hk-dispatch-repo-');
  mkdirSync(join(d, '.git'));
  setEnabled(d, true);
  return d;
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

function repo(script) {
  const d = project();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: script } }));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  return d;
}
const failingRepo = () => repo('node -e "console.error(\'src/a.ts:1 no-unused-vars\'); process.exit(1)"');
const markingRepo = () => repo('node -e "require(\'fs\').writeFileSync(\'lint-ran\', \'x\')"');

/** Every installed script in a directory of its own, with each name in
 * `replaced` holding that text instead, or absent when it is null. */
function installed(replaced) {
  const dir = tempDir('hk-dispatch-scripts-');
  for (const name of readdirSync(ASSETS)) copyFileSync(join(ASSETS, name), join(dir, name));
  for (const [name, text] of Object.entries(replaced)) {
    if (text === null) rmSync(join(dir, name));
    else writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** Runs the entry script `name` from `dir` on `payload`, a string sent as it
 * is or an object sent as JSON. */
function runEntry(name, root, payload, { nodeArgs = [], env = {}, dir = ASSETS } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, join(dir, name)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function direct(script, root, payload) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const call = (session, command) => ({
  session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command, description: 'Run a command' }, tool_use_id: 'toolu_01',
});

const edit = (filePath, session) => ({
  session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit',
  tool_input: { file_path: filePath }, tool_use_id: 'toolu_01',
});

const failure = session => ({
  session_id: session, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
  tool_input: { command: 'npm test' }, error: 'Exit code 1', tool_use_id: 'toolu_01',
});

const WARNING = 'The same call has failed with the same error 3 times, with no different failure between them. Stop repeating it and change approach.';
const WARNING_OUTPUT = JSON.stringify({
  systemMessage: WARNING,
  hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: WARNING },
}) + '\n';

test('combine keeps a single half\'s output byte for byte', () => {
  for (const json of [
    { systemMessage: 'n' },
    { systemMessage: 'n', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } },
    { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'c' } },
  ]) {
    assert.equal(JSON.stringify(combine('PreToolUse', [{ json, stderr: '', exitCode: 0 }]).json), JSON.stringify(json));
  }
});

test('a denial from any half wins on PreToolUse, with the reasons in running order', () => {
  const deny = reason => ({ json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }, stderr: '', exitCode: 0 });
  const warn = { json: { systemMessage: 's', hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'c' } }, stderr: '', exitCode: 0 };
  assert.deepEqual(combine('PreToolUse', [deny('a'), warn, deny('b')]), {
    json: { systemMessage: 's', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'a\nb', additionalContext: 'c' } },
    stderr: '', exitCode: 0,
  });
  assert.equal(combine('PostToolUse', [deny('a')]).json, null, 'a denial means nothing on another event');
});

test('with exit code 2 the JSON is kept and every half\'s stderr is left as it was', () => {
  const notice = { json: { systemMessage: 'n', hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'c' } }, stderr: '', exitCode: 0 };
  const report = { json: null, stderr: 'report\n', exitCode: 2 };
  assert.deepEqual(combine('PostToolUse', [notice, report]), { json: notice.json, stderr: 'report\n', exitCode: 2 });
  assert.deepEqual(combine('PostToolUse', [report]), { json: null, stderr: 'report\n', exitCode: 2 });
  assert.deepEqual(combine('PostToolUse', []), { json: null, stderr: '', exitCode: 0 });
});

test('a half that throws yields nothing and the halves after it still run', async () => {
  const ok = name => ({ name, run: () => ({ json: { systemMessage: name }, stderr: '', exitCode: 0 }) });
  const results = await runHalves({}, [ok('a'), { name: 'b', run: () => { throw new Error('x'); } }, { name: 'c', run: async () => null }, ok('d')]);
  assert.deepEqual(results.map(r => r.json.systemMessage), ['a', 'd']);
});

test('a half that returns anything but a half result yields nothing', async () => {
  const returning = value => ({ name: 'x', run: () => value });
  const malformed = [
    {}, 'text', [], { json: {}, stderr: '' }, { json: {}, stderr: '', exitCode: 1 }, { json: {}, stderr: '', exitCode: Number.NaN },
    { json: 'n', stderr: '', exitCode: 0 }, { json: [], stderr: '', exitCode: 0 }, { json: null, stderr: null, exitCode: 0 },
  ];
  const ok = { json: null, stderr: 'kept\n', exitCode: 2 };
  assert.deepEqual(await runHalves({}, [...malformed.map(returning), returning(ok)]), [ok]);
});

test('an entry script beside a half that returns a malformed result exits 0 and the other half still runs', () => {
  const root = project();
  const dir = installed({ 'loop-watch.mjs': 'export function loopHalf() { return { json: { systemMessage: \'n\' }, stderr: \'\' }; }\n' });
  const r = runEntry('dispatch-tool-failure.mjs', root, failure('bad-1'), { dir });
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: '', stderr: '' });
  assert.equal(readEvents(root, 'bad-1').events.length, 1, 'the log half still recorded the failure');
});

test('dispatch-pre-tool.mjs prints the denial tool-gate.mjs prints and records what both hooks record', () => {
  const rootA = gatedProject();
  const rootB = gatedProject();
  const merged = runEntry('dispatch-pre-tool.mjs', rootA, call('pre-1', 'rm -rf build'));
  const single = direct(GATE, rootB, call('pre-1', 'rm -rf build'));
  assert.equal(JSON.parse(single.stdout).hookSpecificOutput.permissionDecision, 'deny', 'fixture sanity: the gate blocks');
  assert.deepEqual({ status: merged.status, stdout: merged.stdout, stderr: merged.stderr }, { status: 0, stdout: single.stdout, stderr: '' });
  assert.deepEqual(readEvents(rootA, 'pre-1').events.map(e => e.type).sort(), ['PreToolUse', 'gate_firing']);
});

test('dispatch-post-tool.mjs gives the lint report on stderr with exit 2, as lint-touched.mjs does, and logs the event', () => {
  const repoA = failingRepo();
  const repoB = failingRepo();
  const merged = runEntry('dispatch-post-tool.mjs', repoA, edit('src/a.ts', 'post-1'));
  const single = direct(LINT, repoB, edit('src/a.ts', 'post-1'));
  assert.match(single.stderr, /no-unused-vars/, 'fixture sanity: the linter reports');
  assert.deepEqual({ status: merged.status, stdout: merged.stdout, stderr: merged.stderr }, { status: 2, stdout: '', stderr: single.stderr });
  assert.deepEqual(readEvents(repoA, 'post-1').events.map(e => e.type), ['PostToolUse']);
});

test('a lint report and the log hook\'s notice in one run give the notice on stdout and the report on stderr, with exit 2', () => {
  const dir = installed({ 'harness-log.mjs': null });
  const repoA = failingRepo();
  const repoB = failingRepo();
  const notice = direct(join(dir, 'session-log.mjs'), repoA, edit('src/a.ts', 'both-1'));
  const report = direct(LINT, repoB, edit('src/a.ts', 'both-2'));
  assert.match(notice.stdout, /^\{"systemMessage":"kh-harness session-log: /, 'fixture sanity: the log hook gives a notice');
  assert.match(report.stderr, /no-unused-vars/, 'fixture sanity: the linter reports');
  const merged = runEntry('dispatch-post-tool.mjs', repoA, edit('src/a.ts', 'both-3'), { dir });
  assert.deepEqual(merged, { status: 2, stdout: notice.stdout + '\n', stderr: report.stderr });
});

test('dispatch-post-tool.mjs does not lint for a tool that is not an edit, whatever its input names', () => {
  const repo = markingRepo();
  for (const tool of ['Bash', 'Read']) {
    const r = runEntry('dispatch-post-tool.mjs', repo, { ...edit('src/a.ts', `post-${tool}`), tool_name: tool });
    assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, { status: 0, stdout: '', stderr: '' });
    assert.equal(readEvents(repo, `post-${tool}`).events.length, 1);
  }
  assert.equal(existsSync(join(repo, 'lint-ran')), false);
  runEntry('dispatch-post-tool.mjs', repo, edit('src/a.ts', 'post-Edit'));
  assert.equal(existsSync(join(repo, 'lint-ran')), true, 'fixture sanity: an edit runs the linter');
});

test('dispatch-tool-failure.mjs warns at the third identical failure as loop-watch.mjs does, and logs each', () => {
  const root = project();
  const outputs = [1, 2, 3].map(() => runEntry('dispatch-tool-failure.mjs', root, failure('fail-1')).stdout);
  assert.deepEqual(outputs, ['', '', WARNING_OUTPUT]);
  assert.equal(readEvents(root, 'fail-1').events.filter(e => e.type === 'PostToolUseFailure').length, 3);
});

test('a notice session-log.mjs writes with no newline is the same JSON, with a newline, when dispatched', () => {
  const root = project();
  const dir = installed({ 'harness-log.mjs': null });
  const single = direct(join(dir, 'session-log.mjs'), root, failure('nl-1'));
  const merged = runEntry('dispatch-tool-failure.mjs', root, failure('nl-2'), { dir });
  assert.match(single.stdout, /^\{"systemMessage":"kh-harness session-log: /, 'fixture sanity: the log hook gives a notice');
  assert.equal(merged.stdout, single.stdout + '\n');
});

test('one half throwing does not stop the other', () => {
  const throwing = name => `export function ${name}() { throw new Error('boom'); }\n`;
  const root = project();
  const noGate = installed({ 'tool-gate.mjs': throwing('gateHalf') });
  assert.deepEqual(runEntry('dispatch-pre-tool.mjs', root, call('iso-1', 'rm -rf build'), { dir: noGate }).stdout, '');
  assert.equal(readEvents(root, 'iso-1').events.length, 1, 'the log half still recorded the call');
  const gatedRoot = gatedProject();
  const noLog = installed({ 'session-log.mjs': throwing('logHalf') });
  const denied = runEntry('dispatch-pre-tool.mjs', gatedRoot, call('iso-2', 'rm -rf build'), { dir: noLog });
  assert.equal(denied.stderr, '');
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny', 'the gate still denied');
});

test('an entry script beside a missing or older half or core exits 0 with one fixed notice', () => {
  const root = project();
  const older = runEntry('dispatch-pre-tool.mjs', root, call('skew-1', 'ls'), { dir: installed({ 'tool-gate.mjs': 'export {};\n' }) });
  assert.equal(older.status, 0);
  assert.equal(older.stderr, '');
  assert.match(JSON.parse(older.stdout).systemMessage, /^kh-harness dispatch: \.claude\/scripts\/tool-gate\.mjs is older than its entry script and lacks what it needs, so the gate hook did not run on this event — re-run `node scripts\/apply\.mjs <repo> --yes`/);
  assert.equal(readEvents(root, 'skew-1').events.length, 1);
  const missing = runEntry('dispatch-pre-tool.mjs', root, call('skew-3', 'ls'), { dir: installed({ 'tool-gate.mjs': null }) });
  assert.match(JSON.parse(missing.stdout).systemMessage, /^kh-harness dispatch: \.claude\/scripts\/tool-gate\.mjs is missing or cannot be loaded, so the gate hook did not run on this event — /);
  for (const [core, problem] of [[null, 'is missing or cannot be loaded'], ['export {};\n', 'is older than this entry script and lacks what it needs']]) {
    const r = runEntry('dispatch-tool-failure.mjs', root, failure('skew-2'), { dir: installed({ 'harness-dispatch.mjs': core }) });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['systemMessage']);
    assert.ok(JSON.parse(r.stdout).systemMessage.startsWith(`kh-harness dispatch-tool-failure: .claude/scripts/harness-dispatch.mjs ${problem}, so no kh-harness hook ran on PostToolUseFailure — `));
  }
});

test('standard input that is not a JSON object is nothing to do', () => {
  const root = project();
  for (const name of ENTRY_SCRIPTS) {
    for (const input of ['', 'not json', '[1]', 'null']) {
      assert.deepEqual(runEntry(name, root, input), { status: 0, stdout: '', stderr: '' }, `${name} on ${JSON.stringify(input)}`);
    }
  }
});

test('the PreToolUse and PostToolUseFailure entry scripts never spawn a child process', () => {
  const root = gatedProject();
  const trap = join(tempDir('hk-dispatch-trap-'), 'calls');
  const options = { nodeArgs: ['--require', FORBID_SPAWN], env: { KH_SPAWN_TRAP: trap } };
  const denied = runEntry('dispatch-pre-tool.mjs', root, call('nospawn-1', 'rm -rf build'), options);
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const outputs = [1, 2, 3].map(() => runEntry('dispatch-tool-failure.mjs', root, failure('nospawn-2'), options));
  assert.deepEqual(outputs.map(r => r.status), [0, 0, 0]);
  assert.deepEqual(outputs.map(r => r.stdout), ['', '', WARNING_OUTPUT]);
  assert.equal(existsSync(trap), false);
});
