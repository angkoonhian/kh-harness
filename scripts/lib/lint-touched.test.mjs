import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'lint-touched.mjs');

function run(cwd, payload) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK], {
      cwd, input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function repo(script = 'exit 0') {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: script } }));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  return d;
}

test('says nothing and exits 0 when the linter is clean', () => {
  const d = repo('node -e "process.exit(0)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '', 'a clean run must be silent');
});

test('reports on STDERR and exits 2 when the linter fails', () => {
  const d = repo('node -e "console.error(\'src/a.ts:1 no-unused-vars\'); process.exit(1)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 2, 'exit 2 is how Claude is told');
  assert.match(r.stderr, /no-unused-vars/, 'the linter output must reach stderr');
  assert.equal(r.stdout.trim(), '', 'stdout is invisible to Claude and must not be used');
});

test('ignores a tool with no file path', () => {
  const d = repo();
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '');
});

test('ignores a file the linter does not cover', () => {
  const d = repo('node -e "process.exit(1)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'README.md' } });
  assert.equal(r.code, 0, 'a markdown file is not the linter\'s business');
});

test('exits 0 and stays silent when the payload is malformed', () => {
  const d = repo();
  const r = run(d, 'not-json-at-all');
  assert.equal(r.code, 0, 'a broken payload must never disrupt the session');
});

test('exits 0 when no lint script exists', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 0);
});

// --- Ruling 1: attribution — report only what mentions the edited file ----
//
// `scripts.lint` is commonly something like `eslint .`, so appending the
// touched file to it (`eslint . src/a.ts`) usually still lints the WHOLE
// project. A lint script that fails for reasons unrelated to the file
// Claude just touched must never be reported as if the edit caused it —
// that trains Claude to chase pre-existing failures it did not create.
test('ATTRIBUTION: a lint failure naming only a different file is silent and exits 0', () => {
  const d = repo('node -e "console.error(\'src/other.ts:3 some-other-problem\'); process.exit(1)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 0, 'the failure never mentions the edited file, so it must not be reported');
  assert.equal(r.stderr.trim(), '', 'nothing attributable to the edit was found');
});

test('ATTRIBUTION: a lint failure naming the edited file by its basename alone still reports', () => {
  const d = repo('node -e "console.error(\'1:1 error  no-unused-vars  a.ts\'); process.exit(1)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no-unused-vars/);
});

// --- Ruling 2: never echo the command, and bound what is reported --------
//
// `scripts.lint`'s own BODY can carry a credential (this project's own
// history: a `sentry-cli --auth-token ...` script leaked twice). The hook
// must report only the linter's own captured output — never the command
// string, the spawn arguments, or process.env — even when the spawn itself
// fails outright.
test('NEVER-ECHO: a token-shaped literal in the lint command itself never appears in stdout or stderr', () => {
  const token = 'sk-live-FAKE1234567890TOKENVALUE';
  const script = `node -e "console.error('src/a.ts:1 broke'); process.exit(1)" -- --auth-token=${token}`;
  const d = repo(script);
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 2, 'the failure does mention the edited file, so it is reported');
  assert.doesNotMatch(r.stdout, new RegExp(token), 'the command string must never be echoed');
  assert.doesNotMatch(r.stderr, new RegExp(token), 'the command string must never be echoed');
});

test('NEVER-ECHO: a lint command that cannot even be spawned exits 0 without naming the command', () => {
  // scripts.lint names a binary that cannot possibly exist on PATH, and
  // the "binary" name itself carries a token-shaped literal — if the spawn
  // failure path ever echoed the command for diagnostics, this would leak.
  const token = 'sk-live-SPAWNFAIL0000000000';
  const d = repo(`this-binary-does-not-exist-${token}`);
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 0, 'a spawn failure is never reported as a lint failure');
  assert.doesNotMatch(r.stdout, new RegExp(token));
  assert.doesNotMatch(r.stderr, new RegExp(token));
});

// --- Ruling 3: extension coverage is decided by the owning manifest -------

test('EXTENSIONS: a .py file with no pyproject.toml ancestor is not covered and exits 0', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.py'), 'x = 1\n');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.py' } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '');
});

test('EXTENSIONS: a .mjs file is covered by the same package.json owner as .ts', () => {
  const d = repo('node -e "console.error(\'src/a.mjs:1 bad\'); process.exit(1)"');
  writeFileSync(join(d, 'src', 'a.mjs'), 'export const a = 1;\n');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.mjs' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /bad/);
});

test('ignores a nested package whose own package.json has no lint script, even if the repo root has one', () => {
  const d = repo('node -e "process.exit(1)"');
  mkdirSync(join(d, 'packages', 'api'), { recursive: true });
  writeFileSync(join(d, 'packages', 'api', 'package.json'), JSON.stringify({ name: 'api', scripts: {} }));
  writeFileSync(join(d, 'packages', 'api', 'b.ts'), 'export const b = 1;\n');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'packages/api/b.ts' } });
  assert.equal(r.code, 0, 'the NEAREST package.json owns the file, and it has no lint script');
});
