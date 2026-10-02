import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';

const HOOK = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'lint-touched.mjs');

function run(cwd, payload, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK], {
      cwd, input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...extraEnv },
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

/** A standalone "foreign" package the hook must never adopt: its own
 * package.json names a lint script that, if ever run, drops a marker file
 * — the decisive signal, since a swallowed run still looks "clean" by
 * output/exit-code assertions alone. */
function foreignRepo(markerName) {
  const outside = mkdtempSync(join(tmpdir(), 'hk-outside-'));
  writeFileSync(join(outside, 'package.json'), JSON.stringify({
    name: 'foreign',
    scripts: { lint: `node -e "require('fs').writeFileSync('${markerName}','x'); process.exit(1)"` },
  }));
  mkdirSync(join(outside, 'src'), { recursive: true });
  writeFileSync(join(outside, 'src', 'x.ts'), 'export const x = 1;\n');
  return outside;
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

test('TIMEOUT: a run that emits an attributable line and THEN hangs is still not reported', () => {
  // HK_LINT_TIMEOUT_MS lets the test exercise the real timeout branch in
  // milliseconds rather than waiting out the production 30s bound.
  //
  // LOAD-BEARING SHAPE: the attributable line is written FIRST, SYNCHRONOUSLY
  // — before the process hangs — not after a delay. A script that sleeps
  // and only then writes (as an earlier version of this test did) produces
  // no output at all before the kill, so the assertions below would pass
  // whether or not the timeout/signal guard in the hook actually ran: the
  // attribution filter finds nothing either way, and the test cannot tell
  // the two apart. Emitting first makes the guard's absence observable —
  // without it, this line would be reported as a lint failure.
  const d = repo('node -e "console.error(\'src/a.ts:1 early-finding\'); setTimeout(() => process.exit(1), 4000)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, { HK_LINT_TIMEOUT_MS: '200' });
  assert.equal(r.code, 0, 'a timeout is not a lint failure, even when there was something to attribute');
  assert.equal(r.stderr.trim(), '', 'nothing from a timed-out run is ever reported');
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

test('NEVER-ECHO: a token survives in no output even when the lint run times out (the third path)', () => {
  // The normal failure path (above) and the spawn-failure path (above) are
  // two of the three places output could reach stderr; the timeout path is
  // the third. The token lives in the command's own (non-flag-shaped, via
  // `--`) arguments so node's own CLI parser does not reject it outright.
  const token = 'sk-live-TIMEOUTLEAK0000001';
  const d = repo(`node -e "setTimeout(() => { console.error('src/a.ts late'); process.exit(1); }, 4000)" -- --token=${token}`);
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, { HK_LINT_TIMEOUT_MS: '200' });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, new RegExp(token));
  assert.doesNotMatch(r.stderr, new RegExp(token));
});

// Critical finding: a shell echoes the WHOLE failing command line on its own
// syntax error (confirmed for sh/bash; cmd.exe does not). Because the hook
// appends the file path to that command, the echoed line ALSO mentions the
// edited file — so the attribution filter above is exactly what lets it
// through; redaction (dropping any surviving line that contains the raw
// command) is what has to stop it. This does not depend on actually
// triggering a real shell parse error (cmd.exe vs sh/bash echo differently,
// and the hook's shell choice is platform-determined, not something a test
// can select) — it reproduces the leaked line directly, byte for byte, as
// `fullCommand` is computed by the SAME formula the hook uses, and proves
// redaction removes it even though mentionsFile would otherwise pass it.
test('CRITICAL: a line reproducing the raw lint command is redacted, even though it mentions the edited file', () => {
  const token = 'sk-live-ECHOLEAK0001REAL';
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');

  const lintScript = `node echo-shell-line.cjs ${token}`;
  const quotedPath = process.platform === 'win32' ? '"src/a.ts"' : "'src/a.ts'";
  // == exactly what the hook's own fullCommand will be (lintScript + ' ' +
  // quoteArg('src/a.ts')), reproduced here because the test, not the
  // wrapper's argv, is what must control this value precisely.
  const echoedLine = `${lintScript} ${quotedPath}`;
  writeFileSync(join(d, 'echo-shell-line.cjs'), `process.stderr.write(${JSON.stringify(echoedLine)} + '\\n'); process.exit(1);\n`);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: lintScript } }));

  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 0, 'the only surviving line IS the raw command, so nothing attributable remains after redaction');
  assert.equal(r.stderr.trim(), '');
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

// Major finding: the appended path used to be root-relative (`filePath`),
// while the linter actually runs with `cwd: ownerDir`. For a monorepo
// package with its OWN lint script, that path does not exist relative to
// where the linter runs, so a perfectly clean file gets a bogus "not
// found" failure blamed on the edit — exactly the misreport ruling 1 was
// meant to prevent, just via a different mechanism (a path bug, not a
// scoping one). `file_path` here is root-relative, which is the shape
// every one of the brief's own six tests supplies, and production: a
// relative `tool_input.file_path` is always root-relative, never
// re-anchored to whichever package happens to own it.
test('a nested package with its OWN lint script is linted correctly, not misreported as "not found"', () => {
  const d = repo(); // root lint script is irrelevant here; never invoked
  mkdirSync(join(d, 'packages', 'api'), { recursive: true });
  writeFileSync(join(d, 'packages', 'api', 'package.json'), JSON.stringify({
    name: 'api',
    // Fails if (and only if) the path it was handed does not resolve
    // relative to its own cwd — exactly the bug this test pins.
    scripts: { lint: 'node -e "if (!require(\'fs\').existsSync(process.argv[1])) { console.error(\'b.ts: path does not resolve from ownerDir\'); process.exit(1); } process.exit(0);"' },
  }));
  writeFileSync(join(d, 'packages', 'api', 'b.ts'), 'export const b = 1;\n');

  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'packages/api/b.ts' } });
  assert.equal(r.code, 0, 'the file genuinely exists and is clean; the path handed to the linter must resolve from ownerDir');
  assert.equal(r.stderr.trim(), '');
});

// --- CONTAINMENT: the project root is a boundary, not a suggestion -------
//
// findAncestorWith's bound used to be raw string equality (`dir === root`),
// which can silently fail to fire — for an out-of-root absolute file_path
// (no malicious input needed: Claude Code can legitimately edit a file
// outside CLAUDE_PROJECT_DIR), for a `../`-escaping relative one (`.` and
// `/` are both in SAFE_RELATIVE_PATH, so the character allowlist alone
// does not stop this), and for a drive-letter case difference on an
// otherwise in-root file (`resolve('c:/a') !== resolve('C:/a')` on win32).
// Each of these must never cause a foreign package.json to be found, read,
// or have its lint script run — the marker-file technique is decisive here
// too, since a swallowed escape still looks "clean" by exit code alone.

test('CONTAINMENT: an out-of-root absolute file_path never runs a foreign lint script', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-')); // the project root — no package.json of its own
  const outside = foreignRepo('OUTSIDE-MARKER-1.txt');
  const marker = join(outside, 'OUTSIDE-MARKER-1.txt');

  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(outside, 'src', 'x.ts') } });
  assert.equal(r.code, 0, 'a file outside CLAUDE_PROJECT_DIR must never be linted');
  assert.equal(existsSync(marker), false, 'the foreign lint script must never run');
});

test('CONTAINMENT: a ../-escaping relative file_path never runs a foreign lint script', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-')); // the project root — no package.json of its own
  const outside = foreignRepo('OUTSIDE-MARKER-2.txt');
  const marker = join(outside, 'OUTSIDE-MARKER-2.txt');

  // `d` and `outside` are independent sibling tmpdirs, so this is a genuine
  // `../`-relative escape from the project root to a directory it does not
  // own — not a contrived string, the actual relative path between them.
  const escapingPath = relative(d, join(outside, 'src', 'x.ts')).split(sep).join('/');
  assert.match(escapingPath, /^\.\.\//, 'sanity: this really is a ../-escaping path');

  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: escapingPath } });
  assert.equal(r.code, 0, 'a ../-escaping file_path must never be linted');
  assert.equal(existsSync(marker), false, 'the foreign lint script must never run via a ../ escape');
});

test('CONTAINMENT: a drive-letter case difference on an in-root file does not escape the root', { skip: process.platform !== 'win32' }, () => {
  // The project root deliberately has NO package.json of its own: without
  // a correct, case-insensitive bound, the walk blows straight past it and
  // adopts the foreign one below instead.
  const base = mkdtempSync(join(tmpdir(), 'hk-base-'));
  const d = join(base, 'repo');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'y.ts'), 'export const y = 1;\n');
  const marker = join(base, 'OUTSIDE-MARKER-3.txt');
  writeFileSync(join(base, 'package.json'), JSON.stringify({
    name: 'foreign',
    scripts: { lint: `node -e "require('fs').writeFileSync('OUTSIDE-MARKER-3.txt','x'); process.exit(1)"` },
  }));

  const inRootPath = join(d, 'src', 'y.ts');
  const flipped = inRootPath.replace(/^([A-Za-z]):/, (_, letter) =>
    (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()) + ':');
  assert.notEqual(flipped, inRootPath, 'sanity: the drive letter really did flip case');

  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: flipped } });
  assert.equal(r.code, 0, 'a case-differing drive letter on an in-root file must not be treated as out-of-root');
  assert.equal(existsSync(marker), false, 'the foreign ancestor package.json must never run');
});

// Minor 12: a `..` segment is rejected OUTRIGHT, before any resolution —
// not only via the containment check above. This path resolves back to a
// perfectly in-root file (`src/../src/a.ts` === `src/a.ts`), so the
// containment check alone would allow it; the explicit segment check is a
// second, independent reason it is still refused, pinned separately so a
// regression in one guard does not silently hide behind the other.
test('CONTAINMENT: a file_path with a .. segment is rejected outright, even when it resolves back in-root', () => {
  // The lint script DOES fail and DOES produce attributable output (it
  // would pass mentionsFile via the basename alone) — the point of this
  // test is that the hook must refuse the path before ever reaching that
  // point at all, which `isContained` alone would not do here (the path
  // resolves to a perfectly in-root file).
  const d = repo('node -e "console.error(\'src/a.ts:1 problem\'); process.exit(1)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/../src/a.ts' } });
  assert.equal(r.code, 0, 'a literal .. segment is refused regardless of where it resolves');
  assert.equal(r.stderr.trim(), '');
});

// --- SECURITY: tool_input.file_path is attacker-shaped and goes straight --
// into a shell command. existsSync is only ever used to locate the OWNING
// package.json (never to validate the edited path itself), so the edited
// path is never required to exist — nothing filesystem-side stops a hostile
// string from reaching the shell. These use the marker-file technique
// (create a file as a side effect of injected shell code) because a shell
// that silently swallows the injected command would still look "clean" by
// output/exit-code assertions alone.
test('INJECTION: a file_path containing a double-quote cannot break out and run shell code', () => {
  const d = repo('node -e "process.exit(0)"');
  const marker = join(d, 'INJECTION-MARKER-1.txt');
  // Matches the exact shape that broke a naive win32 quoteArg: `\"` is not
  // an escape to cmd.exe, so a hand-quoted "..." string terminates early
  // and whatever follows runs as its own command.
  const maliciousPath = 'a".ts & echo PWNED > INJECTION-MARKER-1.txt & echo "x.ts';
  run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: maliciousPath } });
  assert.equal(existsSync(marker), false, 'the shell must never execute content smuggled in via the file path');
});

test('INJECTION: a file_path containing ; & $() ` cannot execute shell commands', () => {
  const d = repo('node -e "process.exit(0)"');
  const marker = join(d, 'INJECTION-MARKER-2.txt');
  const maliciousPath = 'b; touch INJECTION-MARKER-2.txt; echo `touch m3.txt` $(touch m4.txt) &.ts';
  run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: maliciousPath } });
  assert.equal(existsSync(marker), false, 'the shell must never execute content smuggled in via the file path');
  assert.equal(existsSync(join(d, 'm3.txt')), false);
  assert.equal(existsSync(join(d, 'm4.txt')), false);
});

test('a non-allowlisted file_path (contains a space) still lints via the unmodified script and reports correctly', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  // The script already mentions the odd path in its own output — simulating
  // a real linter that scanned the whole project and found this file, the
  // same way it would with or without the path appended to the command.
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'app',
    scripts: { lint: 'node -e "console.error(\'weird path.ts:1 problem\'); process.exit(1)"' },
  }));
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'weird path.ts' } });
  assert.equal(r.code, 2, 'the fallback (unmodified script) still runs and still reports, attributed correctly');
  assert.match(r.stderr, /problem/);
});

// --- Major: an auto-fixing scripts.lint rewrites the file under Claude ----
//
// `scripts.lint` is commonly `eslint . --fix` / `biome check --write` /
// `ruff check --fix`. Those exit 0 after rewriting the very file Claude
// just wrote — silently, from the hook's point of view, unless it notices.
// This is not a new capability relative to `npm run lint`; the defect
// would be staying quiet about it.
test('MUTATION: an auto-fixing lint script that rewrites the file is reported, not silently exit-0', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1\n'); // no trailing semicolon
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'app',
    // Simulates `eslint --fix`: rewrites the file, then exits 0 — the
    // linter considers this a SUCCESS, which is exactly the trap.
    scripts: { lint: 'node -e "require(\'fs\').writeFileSync(process.argv[1], require(\'fs\').readFileSync(process.argv[1],\'utf8\') + \'// fixed\\n\'); process.exit(0);"' },
  }));

  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 2, 'Claude must be told its file changed underneath it, even though the linter itself exited 0');
  assert.match(r.stderr, /src\/a\.ts/, 'the report must name the file that changed');
  const onDisk = readFileSync(join(d, 'src', 'a.ts'), 'utf8');
  assert.match(onDisk, /fixed/, 'sanity: the file really was rewritten by the lint script, not by the hook');
});

test('a lint script that leaves the file untouched and exits 0 is still silent (no false positive from the mutation check)', () => {
  const d = repo('node -e "process.exit(0)"');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '');
});

// --- Minor 6: the .py/pyproject.toml branch must be observable, not dead -
//
// Forcing `null` for every .py file (regardless of PY_EXTENSIONS) made this
// branch unreachable machinery: emptying PY_EXTENSIONS entirely left every
// test green, because nothing ever executed either way. readPyLintScript
// gives it something to actually do — scanning pyproject.toml's own
// `[tool.poetry.scripts]` / `[scripts]` table for a `lint` entry, the
// closest real analogue to package.json's `scripts.lint` — so a real
// pyproject.toml-owned file now has an observable code path.
test('PYTHON: a pyproject.toml [tool.poetry.scripts] lint entry is read and run against a .py file', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.py'), 'x = 1\n');
  // No embedded quotes in the TOML value — readPyLintScript is an
  // intentionally narrow line scanner, not a TOML parser, and does not
  // implement TOML's own escape sequences; a wrapper script keeps the
  // fixture inside what it actually supports.
  writeFileSync(join(d, 'pylint.cjs'), "console.error('src/a.py:1 bad'); process.exit(1);\n");
  writeFileSync(join(d, 'pyproject.toml'), [
    '[project]',
    'name = "app"',
    '',
    '[tool.poetry.scripts]',
    'lint = "node pylint.cjs"',
  ].join('\n'));

  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.py' } });
  assert.equal(r.code, 2, 'a real pyproject.toml lint entry must actually run, not be forced to null');
  assert.match(r.stderr, /bad/);
});

test('PYTHON: a pyproject.toml with no [tool.poetry.scripts] or [scripts] table exits 0', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.py'), 'x = 1\n');
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "app"\n');
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.py' } });
  assert.equal(r.code, 0);
});

// --- Minor 7: output above spawnSync's default 1MB maxBuffer -------------
test('BUFFER: lint output larger than the default 1MB maxBuffer is still reported, not silently discarded', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  // Each line mentions src/a.ts (so it survives attribution) and the whole
  // block comfortably exceeds Node's 1MB spawnSync default.
  const script = 'node -e "for (let i = 0; i < 20000; i++) console.error(\'src/a.ts:\' + i + \' padding-padding-padding-padding\'); process.exit(1);"';
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: script } }));
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 2, 'output exceeding the 1MB default must still be reported, bounded by MAX_REPORT_LINES, not discarded entirely');
  assert.notEqual(r.stderr.trim(), '');
});

// --- Minor 8: MAX_REPORT_LINES truncation is pinned -----------------------
test('BOUND: more than 60 attributable lines are truncated with a notice, not dumped in full', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-sensor-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  const script = 'node -e "for (let i = 0; i < 80; i++) console.error(\'src/a.ts:\' + i + \' problem\'); process.exit(1);"';
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: script } }));
  const r = run(d, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(r.code, 2);
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.ok(lines.length <= 61, `expected at most 60 lines plus a truncation notice, got ${lines.length}`);
  assert.match(r.stderr, /truncated: 20 more line\(s\)/);
});

// --- Minor 11: reading stdin is bounded, not an unbounded readFileSync(0) -
//
// PostToolUse always supplies and closes stdin promptly, so this is
// theoretical in production — but "never hang" is this file's own
// invariant, and HK_STDIN_TIMEOUT_MS lets this test prove it holds even
// when the caller never closes stdin at all, rather than taking it on
// faith. Uses `spawn` (not `execFileSync`) specifically so the test can
// leave stdin open deliberately.
test('STDIN: a caller that never closes stdin still gets exit 0 within the bound, not a hang', async () => {
  const d = repo();
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: d,
      env: { ...process.env, CLAUDE_PROJECT_DIR: d, HK_STDIN_TIMEOUT_MS: '200' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error('the hook did not exit within the stdin bound — it hung'));
    }, 5000);
    child.on('exit', code => {
      clearTimeout(deadline);
      try {
        assert.equal(code, 0, 'a never-closed stdin must still end in exit 0, not a hang or a crash');
        resolvePromise();
      } catch (e) {
        reject(e);
      }
    });
    // Write a partial, incomplete payload and deliberately never end()
    // the stream — stdin stays open exactly as it would if a caller never
    // closed it.
    child.stdin.write('{"hook_event_name":"PostToolUse"');
  });
});
