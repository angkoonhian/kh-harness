// scripts/lib/extensions-half.test.mjs
//
// The extensions half of the PreToolUse entry script: each module
// .claude/kh-harness/extensions.json lists is loaded from the bytes its hash
// approved and run before the gate, and every way that can fail is that
// entry's `onFailure`. Each test of what a call is told runs the entry
// script as a child process on a payload sent on standard input, and checks
// its standard output, standard error and exit code.
//
// Pinned against the hooks reference, https://code.claude.com/docs/en/hooks,
// read on 2026-11-25, for the output a block is:
//   - section "How a hook resolves", whose example prints
//     `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
//     and says "Claude Code reads the JSON decision, blocks the tool call,
//     and shows Claude the reason";
//   - section "PreToolUse decision control": "`"deny"` prevents the tool
//     call" and, for `permissionDecisionReason`, "For `"deny"`, shown to
//     Claude";
//   - section "JSON output", for `systemMessage`: "Warning message shown to
//     the user";
//   - section "Exit code 0": "Exit 0 means success, and is the intended exit
//     code when you print JSON for structured control", and stdout counts
//     as JSON output "only when you print one JSON object, on one line or
//     several, with nothing around it but whitespace".
// So a block is that deny object on one line with exit 0, a notice for the
// person is `systemMessage`, and a stray write to stdout would lose the
// block.
//
// Every test runs against a temporary KH_DATA_DIR and HK_MARKER_DIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EXTENSIONS_PATH, moduleSha256 } from '../../assets/scripts/harness-extensions.mjs';
import { readEvents, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { GATES_PATH } from '../../assets/scripts/tool-gate.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const ASSETS = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts');
const ENTRY = join(ASSETS, 'dispatch-pre-tool.mjs');

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
process.env.KH_DATA_DIR = tempDir('hk-exthalf-data-');

const writeAt = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const project = () => { const root = tempDir('hk-exthalf-repo-'); mkdirSync(join(root, '.git')); return root; };
const writeExtensions = (root, value) => writeAt(join(root, EXTENSIONS_PATH), typeof value === 'string' ? value : JSON.stringify(value));
/** Writes `.claude/ext/<id>.mjs` holding `source` and returns its entry. */
function extension(root, id, source, o = {}) {
  const module = `.claude/ext/${id}.mjs`;
  writeAt(join(root, module), source);
  return { id, version: '1.0.0', module, sha256: moduleSha256(Buffer.from(source)), onFailure: 'block', ...o };
}
/** A project whose extensions file lists `entries`, each built by
 * `extension(root, …)`. */
function withExtensions(build) {
  const root = project();
  writeExtensions(root, build(root));
  return root;
}
/** Commits one block gate on the Bash command token `rm -rf`. */
function commitGate(root) {
  writeAt(join(root, GATES_PATH), JSON.stringify({ schema: 1, gates: [{
    id: 'L1', tool: 'Bash', field: 'command', match: { kind: 'token', value: 'rm -rf' }, action: 'block',
    message: 'Move files to the trash folder instead of deleting them.',
  }] }));
}
const GATE_LINE = 'kh-harness gate L1: Move files to the trash folder instead of deleting them.';

/** Every installed script in a directory of its own, with each name in
 * `replaced` holding that text instead, or absent when it is null. */
function installed(replaced) {
  const dir = tempDir('hk-exthalf-scripts-');
  for (const name of readdirSync(ASSETS)) copyFileSync(join(ASSETS, name), join(dir, name));
  for (const [name, text] of Object.entries(replaced)) {
    if (text === null) rmSync(join(dir, name));
    else writeFileSync(join(dir, name), text);
  }
  return dir;
}

const call = (session, o = {}) => ({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1', ...o });
const rmCall = session => call(session, { tool_input: { command: 'rm -rf build' } });

/** The entry script's standard output, parsed, or null when it wrote
 * nothing; asserts exit 0, empty stderr, and that what it wrote is one line. */
function runEntry(root, stdin, { script = ENTRY, env = {}, nodeArgs = [] } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, script], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `exit status; signal ${r.signal}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  if (r.stdout === '') return null;
  assert.equal(r.stdout.trimEnd().split('\n').length, 1, `one line: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

const denial = text => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } });
const block = message => `export const preToolUse = () => ({ decision: 'block', message: ${JSON.stringify(message)} });\n`;
const ALLOW = "export const preToolUse = () => ({ decision: 'allow' });\n";
const FAIL_BLOCK = (id, reason) => `kh-harness extension ${id}: ${reason}, so this call is blocked (onFailure: block). Reinstall the plugin that registered it, or remove its entry from .claude/kh-harness/extensions.json outside this session.`;
const FAIL_ALLOW = (id, reason) => `kh-harness extension ${id}: ${reason}, so it checks no call (onFailure: allow).`;
const UNUSABLE = (file, problem) => `kh-harness: .claude/scripts/${file} ${problem} while .claude/kh-harness/extensions.json exists, so every tool call is blocked. Run kh-harness apply --yes, or remove the extensions file, outside this session.`;
const LOADER_MISSING = UNUSABLE('harness-extensions.mjs', 'is missing or cannot be loaded');
const OLDER = 'is older than this entry script and lacks what it needs';

/** Makes a link at `link` to `target`, or skips the test where this platform
 * cannot make one without elevation. Returns whether the link was made. */
function linkOrSkip(t, target, link, type) {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch (e) {
    t.skip(`this platform cannot create the link without elevation: ${e.message}`);
    return false;
  }
}

// --- What a call is told ----------------------------------------------------

test('with no extensions file the entry says nothing', () => {
  assert.equal(runEntry(project(), call('none-1')), null);
});

test('an extension that allows says nothing', () => {
  assert.equal(runEntry(withExtensions(root => [extension(root, 'a', ALLOW)]), call('allow-1')), null);
});

test('an extension that blocks denies the call with its id and message', () => {
  const root = withExtensions(r => [extension(r, 'guard', block('Use the commit command.'))]);
  assert.deepEqual(runEntry(root, call('block-1')), denial('kh-harness extension guard: Use the commit command.'));
});

test('every extension runs, and each block is one line in file order', () => {
  const root = withExtensions(r => [extension(r, 'a', block('A.')), extension(r, 'b', ALLOW), extension(r, 'c', block('C.'))]);
  assert.deepEqual(runEntry(root, call('order-1')), denial('kh-harness extension a: A.\nkh-harness extension c: C.'));
});

test('the extension is given the payload Claude Code sent', () => {
  const source = 'export const preToolUse = p => ({ decision: \'block\', message: `${p.hook_event_name} ${p.tool_name} ${p.tool_input.command}` });\n';
  const root = withExtensions(r => [extension(r, 'echo', source)]);
  assert.deepEqual(runEntry(root, call('payload-1')), denial('kh-harness extension echo: PreToolUse Bash npm test'));
});

test('an event other than PreToolUse, or a payload with no tool name, runs no extension', () => {
  const root = withExtensions(r => [extension(r, 'a', block('A.'))]);
  const { tool_name: _toolName, ...nameless } = call('event-2');
  for (const payload of [call('event-1', { hook_event_name: 'PostToolUse' }), nameless]) {
    assert.doesNotMatch(JSON.stringify(runEntry(root, payload)), /permissionDecision/);
  }
});

test('a module may import a Node built-in', () => {
  const source = "import { basename } from 'node:path';\nexport const preToolUse = () => ({ decision: 'block', message: basename('/a/b.txt') });\n";
  assert.deepEqual(runEntry(withExtensions(r => [extension(r, 'a', source)]), call('builtin-1')), denial('kh-harness extension a: b.txt'));
});

// --- Every failure is the entry's onFailure ----------------------------------

const LOAD = 'its module could not be loaded';
const THREW = 'its preToolUse threw';
const RESULT = 'its preToolUse returned neither an allow nor a block with a usable message';
const fn = body => `export const preToolUse = ${body};\n`;

// [name, source or a change made after the entry was hashed, reason]
const FAILURES = [
  ['the module file is deleted', (root, e) => rmSync(join(root, e.module)), 'its module file is missing'],
  ['the module is changed after it was recorded', (root, e) => appendFileSync(join(root, e.module), '\n// changed\n'), 'its module file does not match the sha256 recorded for it'],
  ['the module is a link to a file outside the repository', (root, e, t) => {
    const outside = join(tempDir('hk-exthalf-outside-'), 'a.mjs');
    writeFileSync(outside, ALLOW);
    rmSync(join(root, e.module));
    return linkOrSkip(t, outside, join(root, e.module), 'file');
  }, 'its module is not a file under .claude/ in this repository'],
  ['the module path is a directory', (root, e) => { rmSync(join(root, e.module)); mkdirSync(join(root, e.module)); }, 'its module file could not be read'],
  ['the module throws as it loads', "throw new Error('secret-from-import');\n", LOAD],
  ['the module imports a sibling file', "import { x } from './sibling.mjs';\nexport const preToolUse = () => ({ decision: 'allow', x });\n", LOAD],
  ['the module imports a package', "import x from 'left-pad';\nexport const preToolUse = () => ({ decision: 'allow', x });\n", LOAD],
  ['the module calls process.exit as it loads', `process.exit(0);\n${ALLOW}`, LOAD],
  ['the module awaits a promise that never settles as it loads', `await new Promise(() => {});\n${ALLOW}`, LOAD],
  ['the module is not JavaScript', 'export const = ;\n', LOAD],
  ['the module exports no preToolUse', 'export const other = 1;\n', 'its module exports no preToolUse function'],
  ['preToolUse is not a function', "export const preToolUse = 'allow';\n", 'its module exports no preToolUse function'],
  ['preToolUse throws', fn("() => { throw new Error('secret-from-call'); }"), THREW],
  ['preToolUse calls process.exit', fn('() => { process.exit(0); }'), THREW],
  ['the result has a getter that throws', fn("() => ({ get decision() { throw new Error('secret-from-getter'); } })"), THREW],
  ['preToolUse returns undefined', fn('() => undefined'), RESULT],
  ['preToolUse returns a string', fn("() => 'allow'"), RESULT],
  ['preToolUse returns another decision', fn("() => ({ decision: 'deny' })"), RESULT],
  ['an allow carries another key', fn("() => ({ decision: 'allow', extra: 1 })"), RESULT],
  ['an allow carries a symbol key', fn("() => ({ decision: 'allow', [Symbol('x')]: 1 })"), RESULT],
  ['a block has no message', fn("() => ({ decision: 'block' })"), RESULT],
  ['a block message is not a string', fn("() => ({ decision: 'block', message: 5 })"), RESULT],
  ['a block message is a BigInt', fn("() => ({ decision: 'block', message: 5n })"), RESULT],
  ['a block message is empty', fn("() => ({ decision: 'block', message: '' })"), RESULT],
  ['a block message is only what cleaning removes', fn("() => ({ decision: 'block', message: '\\u200b\\u001b[0m\\n ' })"), RESULT],
  ['a block message is over 300 characters', fn(`() => ({ decision: 'block', message: '${'x'.repeat(301)}' })`), RESULT],
  ['a block message is 300 characters that escaping makes 1200', fn(`() => ({ decision: 'block', message: '${'<'.repeat(300)}' })`), RESULT],
  ['a block message is over 300 characters only once escaped', fn(`() => ({ decision: 'block', message: '${'x'.repeat(299)}<' })`), RESULT],
  ['preToolUse returns a promise', fn("async () => ({ decision: 'block', message: 'm' })"), RESULT],
  ['preToolUse returns a rejected promise', fn("() => Promise.reject(new Error('secret-from-promise'))"), RESULT],
  ['REVIEW FOCUS R-D: preToolUse returns an object with a circular reference', fn("() => { const r = { decision: 'allow' }; r.self = r; return r; }"), RESULT],
];

/** A project whose one extension, `a`, fails as `change` says. Returns null
 * when the change could not be made here. */
function failing(t, change, onFailure) {
  const root = project();
  const e = extension(root, 'a', typeof change === 'string' ? change : ALLOW, { onFailure });
  if (typeof change === 'function' && change(root, e, t) === false) return null;
  writeExtensions(root, [e]);
  return root;
}

test('each failure with onFailure block denies the call with fixed text', async (t) => {
  for (const [name, change, reason] of FAILURES) {
    await t.test(name, (st) => {
      const root = failing(st, change, 'block');
      if (root === null) return;
      const out = runEntry(root, call(`fail-block-${FAILURES.findIndex(f => f[0] === name)}`));
      assert.deepEqual(out, denial(FAIL_BLOCK('a', reason)));
      assert.ok(!JSON.stringify(out).includes('secret-'), 'nothing the extension said is shown');
    });
  }
});

test('each failure with onFailure allow lets the call run and says so once per session', async (t) => {
  for (const [name, change, reason] of FAILURES) {
    await t.test(name, (st) => {
      const root = failing(st, change, 'allow');
      if (root === null) return;
      const session = `fail-allow-${FAILURES.findIndex(f => f[0] === name)}`;
      assert.deepEqual(runEntry(root, call(session)), { systemMessage: FAIL_ALLOW('a', reason) });
      assert.equal(runEntry(root, call(session)), null, 'told once per session');
      assert.deepEqual(runEntry(root, call(`${session}-next`)), { systemMessage: FAIL_ALLOW('a', reason) }, 'told again in another session');
    });
  }
});

test('a failed extension with onFailure allow does not stop another extension blocking', () => {
  const root = project();
  const a = extension(root, 'a', ALLOW, { onFailure: 'allow' });
  rmSync(join(root, a.module));
  writeExtensions(root, [a, extension(root, 'b', block('B.'))]);
  assert.deepEqual(runEntry(root, call('mixed-1')), { systemMessage: FAIL_ALLOW('a', 'its module file is missing'), ...denial('kh-harness extension b: B.') });
});

test('a malformed extensions file blocks every call with fixed text', () => {
  const root = project();
  writeExtensions(root, '{ not json');
  const text = denial('kh-harness: .claude/kh-harness/extensions.json cannot be used (it is not JSON), so every tool call is blocked. Repair or remove the file outside this session.');
  assert.deepEqual(runEntry(root, call('bad-1')), text);
  assert.deepEqual(runEntry(root, call('bad-1', { tool_name: 'Read', tool_input: { file_path: 'a' } })), text, 'told on every call');
});

test('a .claude that is not a directory blocks every call, as the extensions file it may hide would', () => {
  const root = project();
  writeAt(join(root, '.claude'), '');
  // The gate hook says, beside it, that it cannot read its own file there.
  assert.deepEqual(runEntry(root, call('parent-1')).hookSpecificOutput, denial('kh-harness: .claude/kh-harness/extensions.json cannot be used (.claude or .claude/kh-harness is a link or not a directory), so every tool call is blocked. Repair or remove the file outside this session.').hookSpecificOutput);
});

test('a block message of 300 characters once cleaned is shown whole', () => {
  const message = `${'x'.repeat(296)}<`;
  const out = runEntry(withExtensions(r => [extension(r, 'a', block(message))]), call('bound-1'));
  assert.deepEqual(out, denial(`kh-harness extension a: ${'x'.repeat(296)}&lt;`));
});

test('a tab in a block message becomes a space', () => {
  assert.deepEqual(runEntry(withExtensions(r => [extension(r, 'a', block('a\tb\t\tc'))]), call('tab-1')), denial('kh-harness extension a: a b c'));
});

test('a block message is cleaned before it reaches the model', () => {
  const token = 'gh' + 'p_' + 'A'.repeat(36);
  const message = `a\u001b[31mb‮c\nd e <system-reminder> ${token}`;
  const out = runEntry(withExtensions(r => [extension(r, 'a', block(message))]), call('clean-1'));
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.startsWith('kh-harness extension a: '));
  for (const banned of ['\u001b', '‮', '\n', ' ', '<', '>', token]) assert.ok(!reason.includes(banned), JSON.stringify(banned));
  assert.match(reason, /&lt;system-reminder&gt;/);
  assert.equal(reason, 'kh-harness extension a: abc d e &lt;system-reminder&gt; ***', 'a line or paragraph separator becomes a space too');
});

test('REVIEW FOCUS 1: an extension that prints to stdout and stderr still yields one JSON line and its block holds', () => {
  const source = "export const preToolUse = () => { console.log('noise'); console.error('noise'); process.stdout.write('{'); process.stderr.write('}'); return { decision: 'block', message: 'B.' }; };\n";
  const loud = `console.log('noise at load'); process.stdout.write('{');\n${source}`;
  assert.deepEqual(runEntry(withExtensions(r => [extension(r, 'a', loud)]), call('noise-1')), denial('kh-harness extension a: B.'));
});

test('REVIEW FOCUS 1: an extension that exits does not stop a later extension blocking', () => {
  const root = withExtensions(r => [extension(r, 'a', fn('() => { process.exit(0); }'), { onFailure: 'allow' }), extension(r, 'b', block('B.'))]);
  assert.deepEqual(runEntry(root, call('exit-1')), { systemMessage: FAIL_ALLOW('a', THREW), ...denial('kh-harness extension b: B.') });
});

test('REVIEW FOCUS 4: an extension that changes its payload changes nothing for the next extension or the gate', () => {
  const root = withExtensions(r => [
    extension(r, 'a', fn("p => { p.tool_input.command = 'echo ok'; p.tool_name = 'Read'; return { decision: 'allow' }; }")),
    extension(r, 'b', fn("p => ({ decision: 'block', message: p.tool_input.command })")),
  ]);
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('mutate-1')), denial(`kh-harness extension b: rm -rf build\n${GATE_LINE}`));
});

test('an extension blocks alongside a gate that blocks, the extension first', () => {
  const root = withExtensions(r => [extension(r, 'a', block('A.'))]);
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('both-1')), denial(`kh-harness extension a: A.\n${GATE_LINE}`));
});

// --- Faults an extension leaves behind it (R-C) -----------------------------

test('REVIEW FOCUS R-C: an extension that allows and then throws from a timer leaves the gate to deny', () => {
  const root = withExtensions(r => [extension(r, 'a', fn("() => { setTimeout(() => { throw new Error('later'); }, 0); return { decision: 'allow' }; }"))]);
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('timer-1')), denial(GATE_LINE));
});

test('REVIEW FOCUS R-C: an extension that allows and leaves a rejection unhandled leaves the gate to deny', () => {
  const root = withExtensions(r => [extension(r, 'a', fn("() => { Promise.reject(new Error('later')); return { decision: 'allow' }; }"))]);
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('reject-1')), denial(GATE_LINE));
});

test('REVIEW FOCUS R-C: an extension that blocks and then throws asynchronously still blocks', () => {
  for (const [session, body] of [
    ['async-block-1', "() => { setTimeout(() => { throw new Error('later'); }, 0); return { decision: 'block', message: 'B.' }; }"],
    ['async-block-2', "() => { Promise.reject(new Error('later')); return { decision: 'block', message: 'B.' }; }"],
    ['async-block-3', "() => { queueMicrotask(() => { throw new Error('later'); }); return { decision: 'block', message: 'B.' }; }"],
  ]) {
    const root = withExtensions(r => [extension(r, 'a', fn(body))]);
    commitGate(root);
    assert.deepEqual(runEntry(root, rmCall(session)), denial(`kh-harness extension a: B.\n${GATE_LINE}`), session);
  }
});

test('REVIEW FOCUS R-C: an extension that leaves a promise that never settles, or a timer that repeats, still lets the output out and the process exit', () => {
  for (const [session, body] of [
    ['hang-1', "() => { new Promise(() => {}).then(() => {}); return { decision: 'block', message: 'B.' }; }"],
    ['hang-2', "() => { setInterval(() => {}, 1000); return { decision: 'block', message: 'B.' }; }"],
  ]) {
    const root = withExtensions(r => [extension(r, 'a', fn(body))]);
    commitGate(root);
    assert.deepEqual(runEntry(root, rmCall(session)), denial(`kh-harness extension a: B.\n${GATE_LINE}`), session);
  }
});

test('REVIEW FOCUS R-C: a module that never finishes loading is its onFailure, and the gate still runs', () => {
  const root = withExtensions(r => [extension(r, 'a', `await new Promise(() => {});\n${ALLOW}`)]);
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('tla-1')), denial(`${FAIL_BLOCK('a', LOAD)}\n${GATE_LINE}`));
});

test('REVIEW FOCUS R-C: a gate half that faults and never settles, beside an extension that blocked and left an interval, still delivers the block by the run deadline', () => {
  const gate = "export function gateHalf() {\n  setTimeout(() => { throw new Error('boom'); }, 0);\n  return new Promise(() => {});\n}\n";
  const script = join(installed({ 'tool-gate.mjs': gate }), 'dispatch-pre-tool.mjs');
  const root = withExtensions(r => [extension(r, 'a', fn("() => { setInterval(() => {}, 1000); return { decision: 'block', message: 'B.' }; }"))]);
  const started = Date.now();
  assert.deepEqual(runEntry(root, rmCall('deadline-1'), { script, env: { HK_RUN_DEADLINE_MS: '1500' } }), denial('kh-harness extension a: B.'));
  const took = Date.now() - started;
  assert.ok(took >= 1400 && took < 15_000, `written at the deadline: ${took} ms`);
});

// --- Output an extension makes after it returned ------------------------------

test('a console.log an extension leaves for later cannot corrupt the one JSON line', () => {
  const root = withExtensions(r => [extension(r, 'a', fn("() => { Promise.resolve().then(() => Promise.resolve()).then(() => console.log('junk')); setTimeout(() => console.log('junk'), 0); return { decision: 'allow' }; }"))]);
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('late-out-1')), denial(GATE_LINE));
});

test('a write to stderr an extension leaves for later leaves stderr empty', () => {
  const root = withExtensions(r => [extension(r, 'a', fn("() => { const later = n => n === 0 ? Promise.resolve() : Promise.resolve().then(() => later(n - 1)); later(5).then(() => { process.stderr.write('junk'); console.error('junk'); }); setTimeout(() => process.stderr.write('junk'), 0); return { decision: 'block', message: 'B.' }; }"))]);
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('late-err-1')), denial(`kh-harness extension a: B.\n${GATE_LINE}`));
});

test('standard output is replaced only once an extension has run, and then for the rest of the process', () => {
  const trap = join(tempDir('hk-exthalf-trap-'), 'replaced');
  const preload = `data:text/javascript,${encodeURIComponent(`import { writeFileSync } from 'node:fs';\nprocess.on('exit', () => writeFileSync(${JSON.stringify(trap)}, JSON.stringify([Object.hasOwn(process.stdout, 'write'), Object.hasOwn(process.stderr, 'write')])));\n`)}`;
  const replaced = (root, session) => {
    runEntry(root, call(session), { nodeArgs: ['--import', preload] });
    return JSON.parse(fs.readFileSync(trap, 'utf8'));
  };
  assert.deepEqual(replaced(project(), 'replace-1'), [false, false], 'no extensions file');
  const bad = project();
  writeExtensions(bad, 'x');
  assert.deepEqual(replaced(bad, 'replace-2'), [false, false], 'a malformed file');
  const gone = project();
  const e = extension(gone, 'a', ALLOW, { onFailure: 'allow' });
  rmSync(join(gone, e.module));
  writeExtensions(gone, [e]);
  assert.deepEqual(replaced(gone, 'replace-3'), [false, false], 'a module that is missing runs nothing');
  assert.deepEqual(replaced(withExtensions(r => [extension(r, 'a', ALLOW)]), 'replace-4'), [true, true], 'an extension ran');
});

// --- The loader and the core (R-A) ------------------------------------------

test('without harness-extensions.mjs and without an extensions file the entry still applies its gates', () => {
  const root = project();
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('noloader-1'), { script: join(installed({ 'harness-extensions.mjs': null }), 'dispatch-pre-tool.mjs') }), denial(GATE_LINE));
});

test('without harness-extensions.mjs and with an extensions file every call is blocked with fixed text, and the gate still runs', () => {
  const root = withExtensions(r => [extension(r, 'a', ALLOW)]);
  const script = join(installed({ 'harness-extensions.mjs': null }), 'dispatch-pre-tool.mjs');
  assert.deepEqual(runEntry(root, call('noloader-2'), { script }), denial(LOADER_MISSING));
  commitGate(root);
  assert.deepEqual(runEntry(root, rmCall('noloader-3'), { script }), denial(`${LOADER_MISSING}\n${GATE_LINE}`));
});

test('a harness-extensions.mjs without extensionsHalf, beside an extensions file, blocks every call', () => {
  const root = withExtensions(r => [extension(r, 'a', ALLOW)]);
  const script = join(installed({ 'harness-extensions.mjs': 'export const readExtensions = () => ({ state: \'absent\' });\n' }), 'dispatch-pre-tool.mjs');
  assert.deepEqual(runEntry(root, call('oldloader-1'), { script }), denial(UNUSABLE('harness-extensions.mjs', OLDER)));
});

test('a harness-log.mjs lacking what harness-extensions.mjs imports, beside an extensions file, blocks every call and leaves the gate running', async () => {
  const log = await import('../../assets/scripts/harness-log.mjs');
  for (const missing of ['lfNormalised', 'lfSha256']) {
    const dir = installed({});
    fs.renameSync(join(dir, 'harness-log.mjs'), join(dir, 'whole-harness-log.mjs'));
    writeFileSync(join(dir, 'harness-log.mjs'), `export { ${Object.keys(log).filter(n => n !== missing).join(', ')} } from './whole-harness-log.mjs';\n`);
    const root = withExtensions(r => [extension(r, 'a', ALLOW)]);
    commitGate(root);
    assert.deepEqual(runEntry(root, rmCall(`oldlog-${missing}`), { script: join(dir, 'dispatch-pre-tool.mjs') }), denial(`${LOADER_MISSING}\n${GATE_LINE}`), missing);
  }
});

test('a harness-dispatch.mjs that is missing or older, beside an extensions file, blocks every call with fixed text', () => {
  for (const [core, problem] of [[null, 'is missing or cannot be loaded'], ['export {};\n', OLDER]]) {
    const script = join(installed({ 'harness-dispatch.mjs': core }), 'dispatch-pre-tool.mjs');
    const root = withExtensions(r => [extension(r, 'a', ALLOW)]);
    assert.deepEqual(runEntry(root, call('nocore-1'), { script }), denial(UNUSABLE('harness-dispatch.mjs', problem)), String(core));
    const plain = runEntry(project(), call('nocore-2'), { script });
    assert.deepEqual(Object.keys(plain), ['systemMessage'], 'with no extensions file it is the notice it was');
    assert.match(plain.systemMessage, /^kh-harness dispatch-pre-tool: \.claude\/scripts\/harness-dispatch\.mjs /);
  }
});

test('with the core missing, the entry blocks wherever the loader would find the extensions file malformed or present, and nowhere else', async (t) => {
  const script = join(installed({ 'harness-dispatch.mjs': null }), 'dispatch-pre-tool.mjs');
  const blocked = denial(UNUSABLE('harness-dispatch.mjs', 'is missing or cannot be loaded'));
  const rows = [
    ['no .claude', () => {}, false],
    ['.claude with no kh-harness', root => mkdirSync(join(root, '.claude')), false],
    ['.claude/kh-harness with no extensions file', root => mkdirSync(join(root, '.claude/kh-harness'), { recursive: true }), false],
    ['an extensions file', root => writeExtensions(root, '[]'), true],
    ['an extensions file that is not JSON', root => writeExtensions(root, 'x'), true],
    ['a directory at the extensions path', root => mkdirSync(join(root, EXTENSIONS_PATH), { recursive: true }), true],
    ['.claude a file', root => writeAt(join(root, '.claude'), ''), true],
    ['.claude/kh-harness a file', root => writeAt(join(root, '.claude/kh-harness'), ''), true],
    ['.claude/kh-harness a dangling link', (root, st) => { mkdirSync(join(root, '.claude')); return linkOrSkip(st, join(root, 'gone'), join(root, '.claude/kh-harness'), 'junction'); }, true],
    ['.claude a link to an empty directory', (root, st) => linkOrSkip(st, tempDir('hk-exthalf-outside-'), join(root, '.claude'), 'junction'), false],
    ['.claude a dangling link', (root, st) => linkOrSkip(st, join(root, 'gone'), join(root, '.claude'), 'junction'), false],
    ['.claude a link that loops on itself', (root, st) => linkOrSkip(st, join(root, '.claude'), join(root, '.claude'), 'dir'), false],
    ['.claude a link through which an extensions file is reached', (root, st) => {
      const outside = tempDir('hk-exthalf-outside-');
      writeAt(join(outside, 'kh-harness/extensions.json'), '[]');
      return linkOrSkip(st, outside, join(root, '.claude'), 'junction');
    }, true],
    ['.claude a link through which a file sits where kh-harness would be', (root, st) => {
      const outside = tempDir('hk-exthalf-outside-');
      writeAt(join(outside, 'kh-harness'), '');
      return linkOrSkip(st, outside, join(root, '.claude'), 'junction');
    }, false],
  ];
  for (const [name, setUp, blocks] of rows) {
    await t.test(name, async (st) => {
      const root = project();
      if (setUp(root, st) === false) return;
      const out = runEntry(root, call('layout-1'), { script });
      if (blocks) assert.deepEqual(out, blocked);
      else assert.deepEqual(Object.keys(out), ['systemMessage']);
      // The loader agrees on whether there is anything to run.
      const { readExtensions } = await import('../../assets/scripts/harness-extensions.mjs');
      assert.equal(readExtensions(root).state !== 'absent', blocks, 'readExtensions agrees');
    });
  }
});

/** A project whose `.claude` is a link to a directory elsewhere holding
 * the installed scripts and a block gate, as a dotfiles setup keeps it.
 * Returns null when the link cannot be made here. */
function linkedClaude(t) {
  const root = project();
  const dotfiles = tempDir('hk-exthalf-dotfiles-');
  mkdirSync(join(dotfiles, 'scripts'));
  for (const name of readdirSync(ASSETS)) copyFileSync(join(ASSETS, name), join(dotfiles, 'scripts', name));
  if (!linkOrSkip(t, dotfiles, join(root, '.claude'), 'junction')) return null;
  commitGate(root);
  setEnabled(root, true);
  return { root, script: join(root, '.claude', 'scripts', 'dispatch-pre-tool.mjs') };
}

test('a .claude that is a link holding the installed scripts and no extensions file blocks nothing: the gate and the log run as they do without one', (t) => {
  const linked = linkedClaude(t);
  if (linked === null) return;
  const { root, script } = linked;
  assert.equal(runEntry(root, call('linked-1'), { script }), null, 'a call no gate matches is let through, with nothing said');
  assert.deepEqual(runEntry(root, rmCall('linked-2'), { script }), denial(GATE_LINE), 'the gate still applies');
  assert.equal(readEvents(root, 'linked-1').events.length, 1, 'the log still records the call');
});

test('a .claude that is a link through which an extensions file is reached blocks every call with fixed text', (t) => {
  const linked = linkedClaude(t);
  if (linked === null) return;
  const { root, script } = linked;
  writeExtensions(root, [extension(root, 'a', ALLOW)]);
  const out = runEntry(root, call('linked-3'), { script });
  assert.deepEqual(out.hookSpecificOutput, denial('kh-harness: .claude/kh-harness/extensions.json cannot be used (.claude is a link, and an extensions file must be a file of the repository itself), so every tool call is blocked. Repair or remove the file outside this session.').hookSpecificOutput);
  assert.deepEqual(runEntry(root, rmCall('linked-4'), { script }).hookSpecificOutput.permissionDecisionReason.split('\n').at(-1), GATE_LINE, 'the gate runs beside the block');
});

// --- extensionsHalf itself ---------------------------------------------------
//
// Each runs `extensionsHalf` in a child process of its own: the half
// silences this process's standard output while an extension runs, and the
// test runner reports to its parent through that stream.

const LOADER_URL = pathToFileURL(join(ASSETS, 'harness-extensions.mjs')).href;

/** Runs `script`, an ES module body in which `extensionsHalf`,
 * `EXTENSION_LIMITS` and `args` (the JSON `args` given) are bound, in a
 * child whose project is `root`, and returns the JSON value it hands to
 * `done(value)`. */
function inChild(root, script, args = null) {
  const source = `import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { extensionsHalf, EXTENSION_LIMITS } from ${JSON.stringify(LOADER_URL)};\nconst args = ${JSON.stringify(args)};\nconst done = value => fs.writeSync(1, JSON.stringify(value));\n${script}\n`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root }, timeout: 30_000,
  });
  assert.equal(r.status, 0, `child exit ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
  return JSON.parse(r.stdout);
}

test('REVIEW FOCUS R-B: process.exit is restored after an extension, whatever it did, and stdout and stderr stay silenced', () => {
  const bodies = ["() => { throw new Error('x'); }", '() => { process.exit(3); }', "() => ({ decision: 'allow' })", "() => ({ decision: 'block', message: 'B.' })"];
  const sources = [...bodies.map(fn), "throw new Error('x');\n", `await new Promise(() => {});\n${ALLOW}`];
  for (const [i, source] of sources.entries()) {
    const root = withExtensions(r => [extension(r, 'a', source)]);
    const state = inChild(root, `
      const before = [process.stdout.write, process.stderr.write, process.exit];
      await extensionsHalf(args);
      done({ exit: process.exit === before[2], out: process.stdout.write === before[0], err: process.stderr.write === before[1], silent: process.stdout.write('x') === true && process.stderr.write('x') === true });`, call(`restore-${i}`));
    assert.deepEqual(state, { exit: true, out: false, err: false, silent: true }, source);
  }
});

test('REVIEW FOCUS R-B: extensionsHalf never throws, and a payload it cannot read is refused', () => {
  const root = withExtensions(r => [extension(r, 'a', ALLOW)]);
  const out = inChild(root, `
    const hostile = new Proxy({}, { get() { throw new Error('secret-from-payload'); } });
    done([await extensionsHalf(null), await extensionsHalf('x'), await extensionsHalf(hostile)]);`);
  assert.deepEqual(out, [null, null, { json: denial('kh-harness: .claude/kh-harness/extensions.json cannot be used (it could not be applied to this call), so every tool call is blocked. Repair or remove the file outside this session.'), stderr: '', exitCode: 0 }]);
});

test('REVIEW FOCUS R-D: every result the half returns survives JSON.stringify', () => {
  const root = withExtensions(r => [
    extension(r, 'a', fn("() => { const r = { decision: 'block', message: 'm' }; r.self = r; return r; }"), { onFailure: 'allow' }),
    extension(r, 'b', fn("() => ({ decision: 'block', message: 'B.' })")),
  ]);
  assert.deepEqual(inChild(root, 'done(await extensionsHalf(args));', call('rd-1')), { json: { systemMessage: FAIL_ALLOW('a', RESULT), ...denial('kh-harness extension b: B.') }, stderr: '', exitCode: 0 });
});

test('the load bound is EXTENSION_LIMITS.loadMaxMs, and leaves no timer behind whether the module loads or never finishes loading', () => {
  const timed = `
    const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    const before = timers();
    const started = Date.now();
    const out = await extensionsHalf(args);
    done({ out, waited: Date.now() - started, left: timers() - before, bound: EXTENSION_LIMITS.loadMaxMs });`;
  const quick = inChild(withExtensions(r => [extension(r, 'a', ALLOW)]), timed, call('timer-load-1'));
  assert.equal(quick.bound, 1000);
  assert.deepEqual([quick.out, quick.left], [null, 0], 'after a module that loads');
  assert.ok(quick.waited < quick.bound, 'a module that loads is not held to the bound');
  const hung = inChild(withExtensions(r => [extension(r, 'a', `await new Promise(() => {});\n${ALLOW}`)]), timed, call('timer-load-2'));
  assert.deepEqual([hung.out.json, hung.left], [denial(FAIL_BLOCK('a', LOAD)), 0], 'after a module that never finishes loading');
  assert.ok(hung.waited >= hung.bound - 50, `the bound was waited for: ${hung.waited} ms`);
});

test('the module that runs is the bytes whose hash was approved, even when the file is swapped after it was read', () => {
  const root = project();
  const e = extension(root, 'a', block('approved'));
  writeExtensions(root, [e]);
  // The swap happens just after the module's bytes are read, as a writer
  // racing the hook would make it: the second descriptor closed is the
  // module's, the first the extensions file's.
  const out = inChild(root, `
    const close = fs.closeSync;
    let closed = 0;
    fs.closeSync = fd => {
      close(fd);
      if (++closed === 2) fs.writeFileSync(args.path, args.swapped);
    };
    syncBuiltinESMExports();
    const result = await extensionsHalf(args.call);
    done({ closed, result, onDisk: fs.readFileSync(args.path, 'utf8') });`, { path: join(root, e.module), swapped: block('swapped'), call: call('swap-1') });
  assert.ok(out.closed >= 2, 'fixture sanity: the module was read');
  assert.equal(out.onDisk, block('swapped'), 'fixture sanity: the file was swapped');
  assert.deepEqual(out.result.json, denial('kh-harness extension a: approved'));
});
