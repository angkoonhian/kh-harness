// scripts/lib/loop-watch.test.mjs
//
// Pinned against the hooks reference, https://code.claude.com/docs/en/hooks,
// read on 2026-11-19, section "PostToolUseFailure":
//   - it "Runs when a tool that started executing fails", matches on tool
//     name, and receives "the same `tool_name` and `tool_input` fields as
//     PostToolUse, along with error information as top-level fields": `error`
//     ("String describing what went wrong. The format depends on the tool
//     that failed"), optional `is_interrupt` and `duration_ms`; the example
//     payload is `PAYLOAD_EXAMPLE` below, verbatim but for the elided paths;
//   - "Key your hook on `tool_name`, `is_interrupt`, and the `Exit code N`
//     first line; treat the rest of the string as display text", and Claude
//     Code may middle-truncate long strings — so the signature takes only the
//     first non-empty line of the error;
//   - decision control: `hookSpecificOutput.additionalContext`, "String added
//     to Claude's context alongside the error", with `hookEventName:
//     "PostToolUseFailure"`. `systemMessage` is a field every event accepts
//     ("Warning message shown to the user"); this event's section does not
//     say it discards it;
//   - an exit-0 hook's stderr is never shown to Claude, and plain stdout is
//     added as context only on UserPromptSubmit, UserPromptExpansion,
//     SessionStart and PostModelSwitch — so the warning goes out as JSON;
//   - common input fields: "When a subagent calls a tool, tool events ...
//     fire the same configured hooks as in the main conversation, and the
//     input carries the `agent_id` and `agent_type` common input fields that
//     identify the subagent"; `agent_id` is the "Unique identifier for the
//     subagent or in-process teammate the hook fires in".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { markerPath } from '../../assets/scripts/harness-redact.mjs';
import { APPLY, DETECT, UNINSTALL, git, run, settings } from './lifecycle-fixtures.mjs';
import { LOOP_WATCH_PATH } from './propose.mjs';
import { DETECT_REPORT_PATH } from './report.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const HOOK = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'loop-watch.mjs');
const FORBID_SPAWN = resolve(import.meta.dirname, 'session-log-forbid-spawn.cjs');
const WARNING = 'The same call has failed 3 times in a row with the same error. Stop repeating it and change approach.';
const WARNING_OUTPUT = JSON.stringify({
  systemMessage: WARNING,
  hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: WARNING },
}) + '\n';

const PAYLOAD_EXAMPLE = {
  session_id: 'abc123',
  transcript_path: '/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd: '/Users/...',
  permission_mode: 'default',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: {
    command: 'npm test',
    description: 'Run test suite',
  },
  tool_use_id: 'toolu_01ABC123...',
  error: "Exit code 1\nError: Cannot find module 'express'",
  is_interrupt: false,
  duration_ms: 4187,
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

const failure = (session, o = {}) => ({ ...PAYLOAD_EXAMPLE, session_id: session, ...o });
/** The marker for one agent of one session, as the hook names it. */
const markerOf = (root, session, agent = 'main') => `${markerPath(root, session, 'loop-watch')}.${agent}`;
const countOf = (root, session, agent) => JSON.parse(readFileSync(markerOf(root, session, agent), 'utf8')).count;

function runHook(root, stdin, { nodeArgs = [], env = {} } = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, HOOK], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  assert.equal(result.status, 0, `exit status; stderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('three identical consecutive failures warn once', () => {
  const root = tempDir('hk-loop-');
  assert.equal(runHook(root, failure('three-1')), '');
  assert.equal(runHook(root, failure('three-1')), '');
  assert.equal(runHook(root, failure('three-1')), WARNING_OUTPUT);
});

test('a different failure between them resets the count', () => {
  const root = tempDir('hk-loop-');
  const other = failure('reset-1', { error: 'Exit code 2\nsomething else' });
  for (const payload of [failure('reset-1'), failure('reset-1'), other, failure('reset-1'), failure('reset-1')]) {
    assert.equal(runHook(root, payload), '');
  }
  assert.equal(runHook(root, failure('reset-1')), WARNING_OUTPUT, 'the third identical failure after the reset warns');
});

test('the fourth identical failure does not warn again', () => {
  const root = tempDir('hk-loop-');
  const outputs = Array.from({ length: 6 }, () => runHook(root, failure('fourth-1')));
  assert.deepEqual(outputs, ['', '', WARNING_OUTPUT, '', '', '']);
});

test('the warning text contains nothing from the tool output', () => {
  const root = tempDir('hk-loop-');
  const payload = failure('nothing-1', {
    tool_input: { command: 'deploy --target=zebra-quokka-7731' },
    error: 'Exit code 1\nmarmoset-lantern-0042 refused the connection',
  });
  let out = '';
  for (let i = 0; i < 3; i++) out += runHook(root, payload);
  assert.equal(out, WARNING_OUTPUT);
  for (const fragment of ['zebra', 'quokka', '7731', 'marmoset', 'lantern', '0042', 'deploy', 'Exit code', 'Bash']) {
    assert.equal(out.includes(fragment), false, `the warning must not carry ${fragment}`);
  }
  const marker = readFileSync(markerOf(root, 'nothing-1'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(marker)).sort(), ['count', 'signature']);
  for (const fragment of ['zebra', 'marmoset', 'deploy', 'Exit code']) {
    assert.equal(marker.includes(fragment), false, `the marker must not store ${fragment}`);
  }
});

test('the signature is the tool, the input in any key order, and the first non-empty line of the error after colour is stripped', () => {
  const root = tempDir('hk-loop-');
  const a = failure('sig-1', { tool_input: { command: 'npm test', description: 'Run test suite' }, error: 'Exit code 1\nfirst run output' });
  const b = failure('sig-1', { tool_input: { description: 'Run test suite', command: 'npm test' }, error: '\n  \n\u001b[31mExit code 1\u001b[0m\r\ndifferent later output' });
  assert.equal(runHook(root, a), '');
  assert.equal(runHook(root, b), '');
  assert.equal(runHook(root, a), WARNING_OUTPUT, 'reordered keys, colour, blank leading lines and later lines do not change the signature');

  for (const [name, change] of [
    ['another tool', { tool_name: 'PowerShell' }],
    ['another input', { tool_input: { command: 'npm test -- --watch', description: 'Run test suite' } }],
    ['another first line', { error: 'Exit code 2\nfirst run output' }],
  ]) {
    const session = `sig-${name.replace(/ /g, '-')}`;
    const base = failure(session, { error: 'Exit code 1\nfirst run output' });
    assert.equal(runHook(root, base), '');
    assert.equal(runHook(root, base), '');
    assert.equal(runHook(root, { ...base, ...change }), '', `${name} is a different failure`);
  }
});

test('counts are kept per session', () => {
  const root = tempDir('hk-loop-');
  assert.equal(runHook(root, failure('session-a')), '');
  assert.equal(runHook(root, failure('session-a')), '');
  assert.equal(runHook(root, failure('session-b')), '', 'another session starts its own count');
  assert.equal(runHook(root, failure('session-a')), WARNING_OUTPUT);
});

test('unparseable stdin, a non-object payload, a payload without a tool name, an error or a usable session id is nothing to do', () => {
  const root = tempDir('hk-loop-');
  for (const stdin of ['', 'not json', '[1,2]', '"text"', 'null']) {
    for (let i = 0; i < 3; i++) assert.equal(runHook(root, stdin), '', JSON.stringify(stdin));
  }
  for (const payload of [
    failure('missing-1', { tool_name: undefined }),
    failure('missing-2', { error: undefined }),
    failure('missing-3', { error: { message: 'not a string' } }),
    failure(undefined),
    failure('../escape'),
    failure('missing-4', { agent_id: '../escape' }),
    failure('missing-5', { agent_id: 42 }),
  ]) {
    for (let i = 0; i < 3; i++) assert.equal(runHook(root, payload), '', JSON.stringify(payload));
  }
});

test('a marker that cannot be written means no warning', () => {
  const root = tempDir('hk-loop-');
  const payload = failure('unwritable-1');
  assert.equal(runHook(root, payload), '');
  assert.equal(runHook(root, payload), '');
  // A directory where the hook writes its temporary file makes the write
  // fail on every platform and for every account.
  const path = markerOf(root, 'unwritable-1');
  mkdirSync(`${path}.tmp`);
  assert.equal(runHook(root, payload), '', 'a count that could not be recorded is not reported');
  assert.equal(countOf(root, 'unwritable-1'), 2, 'the marker keeps the last state that was written');
  assert.equal(existsSync(`${path}.lock`), false, 'the lock is released after a failed write');
  rmSync(`${path}.tmp`, { recursive: true });
  assert.equal(runHook(root, payload), WARNING_OUTPUT, 'the next recorded third failure warns');
});

test('ten hook processes for the same failure at once warn exactly once', async () => {
  const root = tempDir('hk-loop-');
  const input = JSON.stringify(failure('parallel-1'));
  const runs = Array.from({ length: 10 }, () => new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', status => resolveRun({ status, stdout, stderr }));
    child.stdin.end(input);
  }));
  const results = await Promise.all(runs);
  for (const r of results) {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  }
  assert.equal(results.filter(r => r.stdout === WARNING_OUTPUT).length, 1, 'exactly one warning');
  assert.equal(results.filter(r => r.stdout === '').length, 9);
  assert.equal(countOf(root, 'parallel-1'), 10, 'every run was counted');
});

test('a sub-agent\'s different failure does not reset the main agent\'s run', () => {
  const root = tempDir('hk-loop-');
  const subAgent = failure('agents-1', { agent_id: 'a1b2c3', agent_type: 'Explore', error: 'Exit code 7\nsomething else' });
  assert.equal(runHook(root, failure('agents-1')), '');
  assert.equal(runHook(root, failure('agents-1')), '');
  assert.equal(runHook(root, subAgent), '');
  assert.equal(runHook(root, failure('agents-1')), WARNING_OUTPUT, 'the main agent\'s third identical failure warns');
  assert.equal(countOf(root, 'agents-1', 'agent-a1b2c3'), 1, 'the sub-agent keeps its own count');

  const sameAsMain = failure('agents-1', { agent_id: 'd4e5f6' });
  assert.equal(runHook(root, sameAsMain), '');
  assert.equal(runHook(root, sameAsMain), '');
  assert.equal(countOf(root, 'agents-1'), 3, 'a sub-agent\'s identical failure does not advance the main agent\'s run');
  assert.equal(runHook(root, sameAsMain), WARNING_OUTPUT, 'and its own third warns');
});

test('a held lock makes the hook do nothing and exit 0', () => {
  const root = tempDir('hk-loop-');
  const payload = failure('locked-1');
  assert.equal(runHook(root, payload), '');
  assert.equal(runHook(root, payload), '');
  const lock = `${markerOf(root, 'locked-1')}.lock`;
  writeFileSync(lock, '');
  assert.equal(runHook(root, payload), '', 'no warning while another run holds the lock');
  assert.equal(countOf(root, 'locked-1'), 2, 'nothing was counted');
  assert.equal(existsSync(lock), true, 'a lock another run holds is left alone');
  rmSync(lock);
  assert.equal(runHook(root, payload), WARNING_OUTPUT);
});

test('a stale lock is removed', () => {
  const root = tempDir('hk-loop-');
  const payload = failure('stale-1');
  assert.equal(runHook(root, payload), '');
  assert.equal(runHook(root, payload), '');
  const lock = `${markerOf(root, 'stale-1')}.lock`;
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 11_000);
  utimesSync(lock, old, old);
  assert.equal(runHook(root, payload), WARNING_OUTPUT, 'a lock older than 10 seconds does not block the count');
  assert.equal(existsSync(lock), false);
  assert.equal(countOf(root, 'stale-1'), 3);
});

test('the hook never spawns a child process', () => {
  const root = tempDir('hk-loop-');
  const trap = join(tempDir('hk-loop-trap-'), 'calls');
  const options = { nodeArgs: ['--require', FORBID_SPAWN], env: { KH_SPAWN_TRAP: trap } };
  const outputs = Array.from({ length: 3 }, () => runHook(root, failure('nospawn-1'), options));
  assert.deepEqual(outputs, ['', '', WARNING_OUTPUT]);
  assert.equal(existsSync(trap), false);
});

test('apply installs the loop warning and uninstall then leaves git status clean', () => {
  const d = tempDir('hk-loop-life-');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app' }));
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }, null, 2) + '\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const before = JSON.parse(run(DETECT, d, '--json')).checks.find(c => c.id === 'P2.loopwatch');
  assert.equal(before.state, 'absent');
  assert.equal(before.decidable, true);

  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, LOOP_WATCH_PATH)));
  assert.ok(existsSync(join(d, '.claude/scripts/harness-redact.mjs')));
  assert.deepEqual(settings(d).hooks.PostToolUseFailure, [{ hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${LOOP_WATCH_PATH}`] }] }]);
  const installed = JSON.parse(run(DETECT, d, '--json')).checks.find(c => c.id === 'P2.loopwatch');
  assert.equal(installed.state, 'declared');

  const outputs = Array.from({ length: 3 }, () => {
    const result = spawnSync(process.execPath, [join(d, LOOP_WATCH_PATH)], {
      input: JSON.stringify(failure('installed-1')), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
  assert.deepEqual(outputs, ['', '', WARNING_OUTPUT], 'the installed copy runs beside the installed shared module');

  run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, LOOP_WATCH_PATH)), false);
  // detect's own report is written by every detect run, not by apply, so
  // uninstall does not own it.
  const status = execFileSync('git', ['-C', d, 'status', '--porcelain', '--untracked-files=all', '--', '.', `:!${DETECT_REPORT_PATH}`], { encoding: 'utf8' });
  assert.equal(status.trim(), '', `git status must be clean after the full cycle; got:\n${status}`);
});
