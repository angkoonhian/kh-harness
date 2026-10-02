import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'verify-touched.mjs');

// Unlike lint-touched.mjs, this hook can exit 0 while STILL writing to
// stderr (the "already reported"/"cap reached" dedupe messages) — so,
// unlike lint-touched.test.mjs's own run() helper, this one cannot rely on
// execFileSync's success path (which returns only stdout and discards
// stderr entirely when the child exits 0). spawnSync captures both streams
// unconditionally, regardless of exit code.
function run(cwd, payload, extraEnv = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    cwd, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...extraEnv },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A fresh session id per test, so marker files left behind by one test
 * (in the real OS temp directory, which is never cleaned up between test
 * runs) can never be mistaken for state from another test or from a
 * previous run of this suite. */
let counter = 0;
function sid() {
  counter += 1;
  return `hk-test-session-${process.pid}-${Date.now()}-${counter}`;
}

function naivePathFor(sessionId) {
  return join(tmpdir(), `harness-kit-stop-${sessionId}`);
}

function repo(scripts = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hk-stop-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts }));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  return d;
}

/**
 * For the signature/cap tests below, the distinguishing failure text is
 * read from a FILE at runtime, never embedded in the `typecheck` command
 * string itself — the `typecheck` script is byte-for-byte IDENTICAL across
 * every fixture this builds. This is deliberate: layer 1's redaction
 * (dropCommandFragments, in harness-redact.mjs) drops any output line
 * containing a fragment of the command it was given, so a fixture whose
 * failure text is a command-line argument can have that text silently
 * stripped before the signature is ever computed over it — two genuinely
 * different failures would both reduce to the same near-empty redacted
 * output, and a test built that way would stay green even if signature
 * comparison were deleted entirely (verified separately: this project has
 * now hit that exact confound four times). Reading the text from a file
 * the identical script opens at runtime means the command string never
 * varies, so redaction can never be what makes two fixtures look alike.
 */
function failingRepoWithMessage(message) {
  const d = mkdtempSync(join(tmpdir(), 'hk-stop-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { typecheck: 'node verify.cjs' } }));
  writeFileSync(join(d, 'problem.txt'), message);
  writeFileSync(
    join(d, 'verify.cjs'),
    "console.error('typecheck: ' + require('fs').readFileSync('problem.txt', 'utf8').trim()); process.exit(1);\n",
  );
  return d;
}

const payload = (overrides = {}) => ({ hook_event_name: 'Stop', session_id: sid(), tool_calls_in_turn: [], ...overrides });

// --- Brief's required behaviour --------------------------------------------

test('exits 0 silently when verification passes', () => {
  const d = repo({ typecheck: 'node -e "process.exit(0)"' });
  const r = run(d, payload());
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '');
});

test('blocks once with exit 2 and the reason on stderr when verification fails', () => {
  const d = repo({ typecheck: 'node -e "console.error(\'oops\'); process.exit(1)"' });
  const r = run(d, payload());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /typecheck/i);
  assert.match(r.stderr, /oops/);
  assert.equal(r.stdout.trim(), '', 'stdout is invisible to Claude and must not be used');
});

test('the report is prefixed by which command failed (test fallback)', () => {
  const d = repo({ test: 'node -e "console.error(\'boom\'); process.exit(1)"' });
  const r = run(d, payload());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /test/i);
  assert.match(r.stderr, /boom/);
});

test('LOAD-BEARING: a second Stop in the same session does NOT block', () => {
  const s = sid();
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: same problem\'); process.exit(1)"' });
  const r1 = run(d, payload({ session_id: s }));
  assert.equal(r1.code, 2, 'sanity: the first call actually blocks');
  const r2 = run(d, payload({ session_id: s }));
  assert.equal(r2.code, 0, 'no documented platform guard exists, so the asset must not loop');
  assert.match(r2.stderr, /already/i, 'it still says why it is letting go');
});

test('a different session blocks independently', () => {
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: trouble\'); process.exit(1)"' });
  const s1 = sid();
  const s2 = sid();
  run(d, payload({ session_id: s1 }));                      // s1: blocks
  run(d, payload({ session_id: s1 }));                      // s1: already reported, gives up
  const r2 = run(d, payload({ session_id: s2 }));
  assert.equal(r2.code, 2, 'a different session must block independently of s1 having already given up');
});

test('exits 0 and stays silent on a malformed payload', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const r = run(d, 'not-json-at-all');
  assert.equal(r.code, 0, 'a broken payload must never disrupt the session');
  assert.equal(r.stderr.trim(), '');
});

test('exits 0 when no verify script exists', () => {
  const d = repo({ build: 'node -e "process.exit(1)"' }); // neither typecheck nor test
  const r = run(d, payload());
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '');
});

test('exits 0 when there is no package.json at all', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-stop-'));
  const r = run(d, payload());
  assert.equal(r.code, 0);
});

test('exits 0 when package.json cannot be parsed', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-stop-'));
  writeFileSync(join(d, 'package.json'), '{ this is not valid json');
  const r = run(d, payload());
  assert.equal(r.code, 0);
});

test("writes its marker outside the repository", () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  run(d, payload());
  const stray = readdirSync(d).filter(f => !['package.json', 'src'].includes(f));
  assert.deepEqual(stray, [], "the hook must not litter the user's repository");
});

// --- Command selection: typecheck wins, test is the fallback --------------

test('prefers typecheck over test when both exist', () => {
  const d = repo({
    typecheck: 'node -e "console.error(\'TYPECHECK-RAN\'); process.exit(1)"',
    test: 'node -e "console.error(\'TEST-RAN\'); process.exit(1)"',
  });
  const r = run(d, payload());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /TYPECHECK-RAN/);
  assert.doesNotMatch(r.stderr, /TEST-RAN/, 'test must never run when typecheck exists');
});

test('falls back to the test script when no typecheck script exists', () => {
  const d = repo({ test: 'node -e "console.error(\'TEST-RAN\'); process.exit(1)"' });
  const r = run(d, payload());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /TEST-RAN/);
});

// --- Bounded spawn: timeout is never reported as a failure ----------------

test('TIMEOUT: a run that emits output and then hangs is not reported and does not block', () => {
  // LOAD-BEARING SHAPE (mirrors lint-touched.test.mjs's identical test):
  // the output is written FIRST, synchronously, before the process hangs —
  // otherwise this test could not tell "the timeout guard worked" apart
  // from "there was nothing to report either way".
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: early\'); setTimeout(() => process.exit(1), 4000)"' });
  const r = run(d, payload(), { HK_VERIFY_TIMEOUT_MS: '200' });
  assert.equal(r.code, 0, 'a timeout is not a verification failure, even when there was something to report');
  assert.equal(r.stderr.trim(), '');
});

// --- Ruling 3: the shared redaction chokepoint (harness-redact.mjs) -------
//
// A nonexistent binary is covered by the CREDENTIAL MATRIX test below
// ('nonexistent binary'): on both cmd.exe and POSIX shells, "command not
// found" is reported THROUGH the shell's own exit code and stderr, not via
// a Node-level spawn() error — so whether it ends up blocking is a
// legitimate verification failure, same as any other broken command; what
// must never happen, regardless of exit code, is the token leaking, which
// the matrix test below asserts directly.

test('CREDENTIAL MATRIX: a token in the verify command leaks in none of four failure modes', () => {
  const TOKEN = 'sk-live-VERIFYLEAK00001';
  const variants = {
    'syntax error (unbalanced quote)': `node -e "console.log('x` + `  --token=${TOKEN}`,
    'nonexistent binary': `definitely-not-a-real-binary-xyz --token=${TOKEN}`,
    'typecheck fails naming a problem': `node -e "console.error('typecheck: oops'); process.exit(1)" --token=${TOKEN}`,
    'timeout': `node -e "console.error('typecheck: slow'); setTimeout(()=>{},9999)" --token=${TOKEN}`,
  };
  for (const [label, script] of Object.entries(variants)) {
    const d = repo({ typecheck: script });
    const r = run(d, payload(), { HK_VERIFY_TIMEOUT_MS: '400' });
    const hits = (r.stdout + r.stderr).split(TOKEN).length - 1;
    assert.equal(hits, 0, `[${label}] token leaked (exit=${r.code}): ${JSON.stringify(r.stderr)}`);
  }
});

test('MASK: a credential-shaped value in a genuine diagnostic is masked, not dropped', () => {
  const d = repo({
    typecheck: 'node -e "console.error([\'typecheck\',\'leaked\',\'sk-live-DIAGLEAK0001\'].join(String.fromCharCode(32))); process.exit(1)"',
  });
  const r = run(d, payload());
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stderr, /sk-live-DIAGLEAK0001/, 'the credential value itself must not reach stderr');
  assert.match(r.stderr, /\*\*\*/, 'masked, not silently vanished');
  assert.match(r.stderr, /leaked/, 'the surrounding diagnostic text survives');
});

// --- Ruling 1: session_id must never reach a path unsanitized -------------

test('SECURITY: a single ../ in session_id never creates a marker at the naive (unsanitized) path', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const id = '../hk-canary-' + sid();
  const naive = naivePathFor(id);
  const r = run(d, payload({ session_id: id }));
  assert.equal(r.code, 0, 'an unsanitizable session_id must never block');
  assert.equal(existsSync(naive), false, 'must never write at the unsanitized ../-relative path');
});

test('SECURITY: a multi-level ../../ escape in session_id never creates a marker outside the temp directory', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const id = '../../../../hk-canary-' + sid();
  const naive = naivePathFor(id);
  const r = run(d, payload({ session_id: id }));
  assert.equal(r.code, 0);
  assert.equal(existsSync(naive), false, 'must never escape the temp directory via multiple ../ segments');
});

test('SECURITY: an absolute-path session_id never creates a marker at the naive path', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const id = process.platform === 'win32' ? ('C:\\Windows\\hk-canary-' + sid()) : ('/etc/hk-canary-' + sid());
  const naive = naivePathFor(id);
  const r = run(d, payload({ session_id: id }));
  assert.equal(r.code, 0);
  assert.equal(existsSync(naive), false);
});

test('SECURITY: a session_id containing a NUL byte never throws and never blocks', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const id = 'abc' + String.fromCharCode(0) + 'def';
  const r = run(d, payload({ session_id: id }));
  assert.equal(r.code, 0, 'a NUL-byte session_id must never crash the hook into some other exit code');
});

test('SECURITY: an empty session_id never blocks', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const r = run(d, payload({ session_id: '' }));
  assert.equal(r.code, 0);
});

test('SECURITY: a missing session_id never blocks', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const { session_id, ...rest } = payload();
  const r = run(d, rest);
  assert.equal(r.code, 0);
});

// --- Ruling 2: bound the block on the FAILURE, not the session ------------

test('a different failure in the same session still blocks', () => {
  const s = sid();
  // See failingRepoWithMessage's comment: the `typecheck` command is
  // IDENTICAL for dA and dB — only problem.txt's content differs — so
  // redaction (which strips fragments of the command string) cannot be
  // what makes r1's and r2's reported text differ.
  const dA = failingRepoWithMessage('problem-A');
  const dB = failingRepoWithMessage('problem-B');
  const r1 = run(dA, payload({ session_id: s }));
  assert.equal(r1.code, 2, 'sanity: the first distinct failure blocks');
  assert.match(r1.stderr, /problem-A/, 'sanity: the distinguishing text actually survives redaction and reaches stderr');
  const r2 = run(dB, payload({ session_id: s }));
  assert.equal(r2.code, 2, 'a genuinely different failure must still block, even though this session already blocked once');
  assert.match(r2.stderr, /problem-B/, 'sanity: the SECOND failure\'s own distinguishing text survives too — this is a real block, not a fluke');
});

test('CAP: a fourth distinct failure in the same session does not block — the 3-block cap is reached', () => {
  const s = sid();
  // Same shape as the test above: `failingRepoWithMessage` runs the exact
  // same `node verify.cjs` command every time, varying only problem.txt.
  const r1 = run(failingRepoWithMessage('problem-A'), payload({ session_id: s }));
  const r2 = run(failingRepoWithMessage('problem-B'), payload({ session_id: s }));
  const r3 = run(failingRepoWithMessage('problem-C'), payload({ session_id: s }));
  // Sanity: the fixture genuinely crosses the cap threshold (3 DISTINCT
  // blocks, each reporting ITS OWN distinguishing text) before asserting
  // anything about what happens once it does — otherwise this test could
  // pass whether or not the cap exists at all.
  assert.deepEqual([r1.code, r2.code, r3.code], [2, 2, 2], 'three distinct failures must each block, reaching the cap');
  assert.match(r1.stderr, /problem-A/);
  assert.match(r2.stderr, /problem-B/);
  assert.match(r3.stderr, /problem-C/);

  const r4 = run(failingRepoWithMessage('problem-D'), payload({ session_id: s }));
  assert.equal(r4.code, 0, 'a fourth distinct failure must not block once the session has already blocked 3 times');
});
