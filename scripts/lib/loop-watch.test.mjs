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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { markerPath } from '../../assets/scripts/harness-redact.mjs';
import { APPLY, DETECT, UNINSTALL, git, run, settings, sandboxDataDir, hooksBesideLog } from './lifecycle-fixtures.mjs';
import { treeSnapshot } from './log-fixtures.mjs';
import { LOOP_WATCH_PATH } from './propose.mjs';
import { DETECT_REPORT_PATH } from './report.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const HOOK = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'loop-watch.mjs');
const FORBID_SPAWN = resolve(import.meta.dirname, 'session-log-forbid-spawn.cjs');
const WARNING = 'The same call has failed with the same error 3 times, with no different failure between them. Stop repeating it and change approach.';
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
sandboxDataDir();

const failure = (session, o = {}) => ({ ...PAYLOAD_EXAMPLE, session_id: session, ...o });
/** The marker for one agent of one session, as the hook names it. */
const markerOf = (root, session, agent = 'main') => `${markerPath(root, session, 'loop-watch')}.${agent}`;
const RECORD = /^([0-9a-f]{64}) [0-9a-f]{32}$/;
/** How many records with the last record's signature end the marker. */
function countOf(root, session, agent) {
  const signatures = readFileSync(markerOf(root, session, agent), 'utf8').split('\n').map(line => RECORD.exec(line)?.[1] ?? null);
  const last = signatures.at(-1);
  let count = 0;
  while (last !== null && signatures.at(-1 - count) === last) count++;
  return count;
}

function runHook(root, stdin, { nodeArgs = [], env = {}, script = HOOK } = {}) {
  const result = spawnSync(process.execPath, [...nodeArgs, script], {
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

test('the hook writes nothing inside the project, warning or not', () => {
  const root = tempDir('hk-loop-');
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.mjs'), 'export const app = 1;\n');
  const before = treeSnapshot(root);
  const outputs = Array.from({ length: 4 }, () => runHook(root, failure('inside-1')));
  assert.deepEqual(outputs, ['', '', WARNING_OUTPUT, ''], 'the hook counted and warned');
  assert.deepEqual(treeSnapshot(root), before, 'every file and directory in the project, files by their bytes, is as it was');
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
  assert.match(marker, /^(\n[0-9a-f]{64} [0-9a-f]{32}){3}$/, 'one record per failure, each a signature and a nonce');
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
  // A directory at the marker's path makes the write fail on every platform
  // and for every account.
  const path = markerOf(root, 'unwritable-1');
  renameSync(path, `${path}.aside`);
  mkdirSync(path);
  assert.equal(runHook(root, payload), '', 'a count that could not be recorded is not reported');
  rmSync(path, { recursive: true });
  renameSync(`${path}.aside`, path);
  assert.equal(countOf(root, 'unwritable-1'), 2, 'nothing was recorded for the run that could not write');
  assert.equal(runHook(root, payload), WARNING_OUTPUT, 'the next recorded third failure warns');
});

test('a link planted at the marker\'s path is never written through', (t) => {
  const root = tempDir('hk-loop-');
  const victim = join(tempDir('hk-loop-victim-'), 'victim.txt');
  writeFileSync(victim, 'not the hook\'s to write\n');
  const path = markerOf(root, 'linked-1');
  try {
    symlinkSync(victim, path, 'file');
  } catch (e) {
    t.skip(`this platform cannot create the link without elevation: ${e.message}`);
    return;
  }
  for (let i = 0; i < 3; i++) assert.equal(runHook(root, failure('linked-1')), '', 'nothing is counted through the link');
  assert.equal(readFileSync(victim, 'utf8'), 'not the hook\'s to write\n');
});

test('a line that is not a record, such as an earlier version\'s marker, ends a run', () => {
  const root = tempDir('hk-loop-');
  const payload = failure('foreign-1');
  assert.equal(runHook(root, payload), '');
  assert.equal(runHook(root, payload), '');
  const path = markerOf(root, 'foreign-1');
  const signature = readFileSync(path, 'utf8').split('\n')[1].split(' ')[0];
  writeFileSync(path, JSON.stringify({ signature, count: 2 }));
  assert.equal(runHook(root, payload), '', 'the old marker\'s count is not taken up');
  assert.equal(runHook(root, payload), '');
  assert.equal(runHook(root, payload), WARNING_OUTPUT, 'three records after the foreign line are a run of three');
  assert.equal(readFileSync(path, 'utf8').split('\n')[0], JSON.stringify({ signature, count: 2 }), 'no record joined the line before it');
});

// Every record is 98 bytes: its newline, 64 hex of signature, a space and 32
// hex of nonce. The hook first reads the last 4096 bytes (about 41 records)
// and reads back at most 64 KiB (about 668).
const RECORD_BYTES = 98;
const OTHER_SIGNATURE = 'b'.repeat(64);
/** `n` records of `signature` in the marker's format. */
const recordsOf = (signature, n) => Array.from({ length: n }, (_, i) => `\n${signature} ${i.toString(16).padStart(32, '0')}`).join('');

/** A preload that, right after the hook's own append, appends `count` records
 * of OTHER_SIGNATURE through the same descriptor: the records of runs that
 * appended between this run's write and its read. */
function appendAfterPreload(count) {
  const preload = join(tempDir('hk-loop-preload-'), 'append-after.mjs');
  writeFileSync(preload, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const real = fs.writeSync;',
    'let done = false;',
    'fs.writeSync = (fd, ...rest) => {',
    '  const written = real(fd, ...rest);',
    '  if (!done) {',
    '    done = true;',
    `    real(fd, Buffer.from(${JSON.stringify(recordsOf(OTHER_SIGNATURE, count))}, 'latin1'));`,
    '  }',
    '  return written;',
    '};',
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  return ['--import', pathToFileURL(preload).href];
}

test('a marker longer than the first read still counts the run at its end', () => {
  const root = tempDir('hk-loop-');
  const payload = failure('long-1');
  const path = markerOf(root, 'long-1');
  writeFileSync(path, recordsOf(OTHER_SIGNATURE, 50));
  assert.ok(50 * RECORD_BYTES > 4096, 'fixture sanity: the marker is longer than the first read');
  assert.deepEqual([runHook(root, payload), runHook(root, payload), runHook(root, payload)], ['', '', WARNING_OUTPUT]);
});

test('a run whose record dozens of later runs have followed still finds it and the records before it', () => {
  // 40 later records put this run's record first in the first read, with
  // the records before it out of view; 45 put it out of the first read.
  for (const later of [40, 45]) {
    const root = tempDir('hk-loop-');
    const payload = failure(`later-${later}`);
    assert.equal(runHook(root, payload), '');
    assert.equal(runHook(root, payload), '');
    assert.equal(runHook(root, payload, { nodeArgs: appendAfterPreload(later) }), WARNING_OUTPUT, `${later} records after it`);
    assert.equal(readFileSync(markerOf(root, `later-${later}`), 'utf8').length, (3 + later) * RECORD_BYTES, 'fixture sanity: the later records landed after this run\'s');
  }
});

test('the read back is capped: a record further than 64 KiB from the end is not looked for, and nothing is said', () => {
  const root = tempDir('hk-loop-');
  const payload = failure('capped-1');
  assert.equal(runHook(root, payload), '');
  assert.equal(runHook(root, payload), '');
  const later = Math.ceil(64 * 1024 / RECORD_BYTES);
  assert.equal(runHook(root, payload, { nodeArgs: appendAfterPreload(later) }), '', 'the third failure is not found within the cap, so no warning');

  // A marker far larger than the cap costs nothing when the run is at its end.
  const big = tempDir('hk-loop-');
  writeFileSync(markerOf(big, 'capped-2'), recordsOf(OTHER_SIGNATURE, 2000));
  const again = failure('capped-2');
  assert.deepEqual([runHook(big, again), runHook(big, again), runHook(big, again)], ['', '', WARNING_OUTPUT]);
});

/** A copy of the hook in its own directory beside a harness-redact.mjs
 * holding `asset`, or none when it is null. */
function installedCopy(asset) {
  const dir = tempDir('hk-loop-copy-');
  writeFileSync(join(dir, 'loop-watch.mjs'), readFileSync(HOOK, 'utf8'));
  if (asset !== null) writeFileSync(join(dir, 'harness-redact.mjs'), asset);
  return join(dir, 'loop-watch.mjs');
}

const ASSET_REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared asset; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';
const assetNotice = problem => JSON.stringify({ systemMessage: `kh-harness loop-watch: .claude/scripts/harness-redact.mjs ${problem}, so repeated failures are not counted — ${ASSET_REMEDY}` }) + '\n';
const OLDER = assetNotice('is older than this hook and lacks what it needs');
const MISSING = assetNotice('is missing or cannot be loaded');
const REAL_ASSET = pathToFileURL(resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'harness-redact.mjs')).href;

test('an older harness-redact.mjs is named once per session, and unparseable stdin still says nothing', () => {
  const root = tempDir('hk-loop-');
  // Every name the hook needs but `openMarker`: the marker helpers remain.
  const older = installedCopy(`export { markerPath, projectRoot, safeSessionId, stripAnsi } from '${REAL_ASSET}';\n`);
  const outputs = Array.from({ length: 3 }, () => runHook(root, failure('stale-1'), { script: older }));
  assert.deepEqual(outputs, [OLDER, '', ''], 'told on the first failure of the session only');
  assert.equal(runHook(root, failure('stale-2'), { script: older }), OLDER, 'a new session is told');
  for (const stdin of ['', 'not json', '[1,2]', JSON.stringify(failure('stale-3', { tool_name: undefined }))]) {
    assert.equal(runHook(root, stdin, { script: older }), '', `nothing to do for ${JSON.stringify(stdin)}`);
  }
});

test('a harness-redact.mjs too old to have the marker helpers, or none at all, is named on every failure', () => {
  const root = tempDir('hk-loop-');
  for (const [script, notice] of [[installedCopy(`export { stripAnsi } from '${REAL_ASSET}';\n`), OLDER], [installedCopy(null), MISSING]]) {
    assert.deepEqual(Array.from({ length: 3 }, () => runHook(root, failure('stale-4'), { script })), [notice, notice, notice]);
    assert.equal(runHook(root, 'not json', { script }), '', 'unparseable stdin is nothing to do');
  }
  const whole = installedCopy(readFileSync(resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'harness-redact.mjs'), 'utf8'));
  assert.equal(runHook(root, failure('stale-5'), { script: whole }), '', 'fixture sanity: the copy works beside the current asset');
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
  assert.deepEqual(hooksBesideLog(settings(d), 'PostToolUseFailure'), [{ hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${LOOP_WATCH_PATH}`] }] }]);
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
