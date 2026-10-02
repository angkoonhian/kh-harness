import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
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

// Reproduces harness-redact.mjs's own userTag()/rootTag()/markerPath()
// formula (ruling 10: a per-user directory, plus a hash of the repository
// root, plus the session id). Duplicated here deliberately — this is the
// EXACT path an unsanitized session_id would be concatenated into if
// safeSessionId's check were ever bypassed, so the SECURITY tests below
// can assert directly against it rather than against the OLD, simpler
// shape (`<tmpdir>/harness-kit-stop-<session_id>`) that no longer matches
// what production actually builds.
function realUserTag() {
  try {
    const id = typeof process.getuid === 'function' ? String(process.getuid()) : userInfo().username;
    return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}
function naivePathFor(sessionId, root, namespace = 'stop') {
  const rootHash = createHash('sha256').update(resolve(root), 'utf8').digest('hex').slice(0, 16);
  return join(tmpdir(), `harness-kit-stop-${realUserTag()}`, `${rootHash}-${namespace}-${sessionId}`);
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
function failingRepo() {
  const d = mkdtempSync(join(tmpdir(), 'hk-stop-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { typecheck: 'node verify.cjs' } }));
  writeFileSync(
    join(d, 'verify.cjs'),
    "console.error('typecheck: ' + require('fs').readFileSync('problem.txt', 'utf8').trim()); process.exit(1);\n",
  );
  return d;
}

/** Overwrites just the distinguishing text, in the SAME repository —
 * matching real usage, where a session stays scoped to one project
 * directory for its whole lifetime. The marker is now additionally keyed
 * on a hash of the repository root (ruling 10: a pre-seeded marker must
 * not cross repositories either), so unlike the old per-call `mkdtempSync`
 * fixture this replaced, varying the ROOT between calls would give each
 * one its own marker and defeat the very session-scoped cap these tests
 * exist to pin. */
function setProblem(d, message) {
  writeFileSync(join(d, 'problem.txt'), message);
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
  // The platform DOES document its own 8-consecutive-block guard (see
  // verify-touched.mjs's header comment) — this is pinning OUR OWN
  // stricter, signature-keyed bound, which exists independently of it.
  assert.equal(r2.code, 0, 'the signature-keyed bound must not loop on an identical failure');
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

// --- Findings 3+4: a timeout blocks ONCE, records itself, and kills the --
// --- whole process tree (not merely the shell) ----------------------------
//
// Superseded behaviour, deliberately: an earlier version silently exited 0
// on every timeout, paying the full bound every turn forever and reporting
// nothing. A verification that cannot finish in time is itself a real
// failure Claude should be told about once — then the session remembers
// it and skips re-running the command at all, rather than paying the bound
// again just to reach the same conclusion.

test('TIMEOUT: the FIRST timeout blocks once with an explicit message naming the bound', () => {
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: early\'); setInterval(() => {}, 1000)"' });
  const r = run(d, payload(), { HK_VERIFY_TIMEOUT_MS: '300', HK_VERIFY_KILL_GRACE_MS: '500' });
  assert.equal(r.code, 2, 'a timeout is a real failure and must be told to Claude, once');
  assert.match(r.stderr, /did not finish within/i);
  assert.match(r.stderr, /typecheck/i);
});

test('TIMEOUT: a second Stop in the same session SKIPS re-running the command entirely', () => {
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: early\'); setInterval(() => {}, 1000)"' });
  const s = sid();
  const extraEnv = { HK_VERIFY_TIMEOUT_MS: '300', HK_VERIFY_KILL_GRACE_MS: '500' };
  const r1 = run(d, payload({ session_id: s }), extraEnv);
  assert.equal(r1.code, 2, 'sanity: the first call really did block on the timeout');

  const start = Date.now();
  const r2 = run(d, payload({ session_id: s }), extraEnv);
  const elapsed = Date.now() - start;
  assert.equal(r2.code, 0, 'a session that already established a timeout must not block again');
  assert.ok(
    elapsed < 300,
    `the second call must skip spawning the command, not pay the 300ms bound again (took ${elapsed}ms)`,
  );
});

/**
 * Review hygiene correction: mutating killTree (proven separately, see
 * the report's Finding 4 mutation) leaves a REAL orphaned process pair on
 * the machine running this suite — found by hand, once, via
 * `Win32_Process`. A test that can leak a process must own cleaning it
 * up itself, in a teardown that runs whether the test passed, failed, or
 * threw — precisely because the failure mode (killTree regressing) is
 * the one moment this test cannot trust verify-touched.mjs's own kill to
 * have worked. The canary writes ITS OWN pid and its grandchild's pid to
 * a file BEFORE doing anything else, so the teardown below can find and
 * force-kill both directly — independent of, and never relying on,
 * whatever the hook under test did or didn't manage to kill.
 */
test('ORPHAN CANARY: a timeout kills the whole process tree, not just the shell', async () => {
  // The old `spawnSync({ timeout })` implementation killed only the
  // SHELL — with `shell: true`, whatever the shell went on to run (a
  // `tsc`/test-runner grandchild) survived, one orphan per turn, forever.
  // This proves the new kill tears down the grandchild too: the canary
  // writes an incrementing heartbeat to a file every 50ms; if it is still
  // alive a moment after the hook returns, the heartbeat keeps advancing.
  const d = repo({});
  const heartbeat = join(d, 'heartbeat.txt');
  const pidsFile = join(d, 'pids.txt');
  writeFileSync(
    join(d, 'canary.cjs'),
    [
      "const { spawn } = require('child_process');",
      `const heartbeatPath = ${JSON.stringify(heartbeat)};`,
      `const pidsPath = ${JSON.stringify(pidsFile)};`,
      "const grandchild = spawn(process.execPath, ['-e', 'let n=0; setInterval(() => { n++; require(\"fs\").writeFileSync(process.argv[1], String(n)); }, 50);', heartbeatPath], { stdio: 'ignore' });",
      // Written FIRST, before anything else, so the teardown below can
      // find both pids even if the test assertions fail partway through.
      "require('fs').writeFileSync(pidsPath, process.pid + '\\n' + grandchild.pid + '\\n');",
      "console.error('typecheck: launched canary');",
      'setInterval(() => {}, 1000);', // the parent itself also hangs, simulating a slow tsc
    ].join('\n'),
  );
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { typecheck: 'node canary.cjs' } }));

  try {
    const r = run(d, payload(), { HK_VERIFY_TIMEOUT_MS: '300', HK_VERIFY_KILL_GRACE_MS: '500' });
    assert.equal(r.code, 2, 'sanity: the timeout path actually ran');

    await new Promise(res => setTimeout(res, 400));
    const afterKill = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
    assert.ok(afterKill !== null, 'sanity: the canary grandchild actually started and wrote at least one heartbeat');
    await new Promise(res => setTimeout(res, 400));
    const later = readFileSync(heartbeat, 'utf8');
    assert.equal(afterKill, later, 'the heartbeat must stop advancing — no grandchild survived the timeout kill');
  } finally {
    // Teardown: ALWAYS runs — pass, fail, or throw. Reads the pids file
    // fresh here rather than trusting any variable set inside `try`,
    // specifically so a throw partway through the try block still leaves
    // this able to find and kill what was spawned.
    let pids = [];
    try {
      if (existsSync(pidsFile)) {
        pids = readFileSync(pidsFile, 'utf8').split(/\s+/).map(s => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
      }
    } catch {
      // best-effort — a teardown that itself throws must never mask the
      // test's own result
    }
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch {
        // already gone, or never started — nothing left to clean up
      }
    }
  }
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
  const naive = naivePathFor(id, d);
  const r = run(d, payload({ session_id: id }));
  assert.equal(r.code, 0, 'an unsanitizable session_id must never block');
  assert.equal(existsSync(naive), false, 'must never write at the unsanitized ../-relative path');
});

test('SECURITY: a multi-level ../../ escape in session_id never creates a marker outside the temp directory', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const id = '../../../../hk-canary-' + sid();
  const naive = naivePathFor(id, d);
  const r = run(d, payload({ session_id: id }));
  assert.equal(r.code, 0);
  assert.equal(existsSync(naive), false, 'must never escape the temp directory via multiple ../ segments');
});

test('SECURITY: an absolute-path session_id never creates a marker at the naive path', () => {
  const d = repo({ typecheck: 'node -e "process.exit(1)"' });
  const id = process.platform === 'win32' ? ('C:\\Windows\\hk-canary-' + sid()) : ('/etc/hk-canary-' + sid());
  const naive = naivePathFor(id, d);
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
  // See failingRepo/setProblem's comments: the `typecheck` command is
  // IDENTICAL across both calls, in the SAME repository (matching real
  // usage — a session stays scoped to one project) — only problem.txt's
  // content differs between them, so redaction (which strips fragments of
  // the command string) cannot be what makes r1's and r2's reported text
  // differ, and the marker's root-hash component (ruling 10) stays stable.
  const d = failingRepo();
  setProblem(d, 'problem-A');
  const r1 = run(d, payload({ session_id: s }));
  assert.equal(r1.code, 2, 'sanity: the first distinct failure blocks');
  assert.match(r1.stderr, /problem-A/, 'sanity: the distinguishing text actually survives redaction and reaches stderr');
  setProblem(d, 'problem-B');
  const r2 = run(d, payload({ session_id: s }));
  assert.equal(r2.code, 2, 'a genuinely different failure must still block, even though this session already blocked once');
  assert.match(r2.stderr, /problem-B/, 'sanity: the SECOND failure\'s own distinguishing text survives too — this is a real block, not a fluke');
});

test('CAP: a fourth distinct failure in the same session does not block — the 3-block cap is reached', () => {
  const s = sid();
  // Same shape as the test above: one repository, one `typecheck` command,
  // byte-identical across every call — only problem.txt varies.
  const d = failingRepo();
  setProblem(d, 'problem-A');
  const r1 = run(d, payload({ session_id: s }));
  setProblem(d, 'problem-B');
  const r2 = run(d, payload({ session_id: s }));
  setProblem(d, 'problem-C');
  const r3 = run(d, payload({ session_id: s }));
  // Sanity: the fixture genuinely crosses the cap threshold (3 DISTINCT
  // blocks, each reporting ITS OWN distinguishing text) before asserting
  // anything about what happens once it does — otherwise this test could
  // pass whether or not the cap exists at all.
  assert.deepEqual([r1.code, r2.code, r3.code], [2, 2, 2], 'three distinct failures must each block, reaching the cap');
  assert.match(r1.stderr, /problem-A/);
  assert.match(r2.stderr, /problem-B/);
  assert.match(r3.stderr, /problem-C/);

  setProblem(d, 'problem-D');
  const r4 = run(d, payload({ session_id: s }));
  assert.equal(r4.code, 0, 'a fourth distinct failure must not block once the session has already blocked 3 times');
});

// --- Finding 1: never block with an empty report body ---------------------
//
// Layer 1 redaction can remove EVERY line of output when the entire thing
// is made of fragments of the command itself — measured for real against
// `npm init -y`'s own default `scripts.test`
// (`"echo \"Error: no test specified\" && exit 1"`): "specified" is an
// 8+ character fragment of that command, so the only output line is
// dropped entirely. The fixture below reproduces that exact shape.

test('EMPTY BODY: a failure whose entire output is removed by redaction still blocks, with an explicit substitute message', () => {
  const d = repo({ test: 'echo "Error: no test specified" && exit 1' });
  const r = run(d, payload());
  assert.equal(r.code, 2, 'the failure is real and must still reach Claude — silently exiting 0 would hide it');
  assert.match(r.stderr, /could not be shown/i, 'the substitute message must say the output could not be shown');
  assert.match(r.stderr, /test/i, 'it must name which script to run manually');
  assert.doesNotMatch(r.stderr, /^harness-kit: the repository's "test" script failed:\s*$/m,
    'must never be a bare header with nothing after it');
});

test('EMPTY BODY: sanity — the npm-init-default fixture really is reduced to nothing by redaction', () => {
  // Proves the fixture actually crosses into the empty-body branch before
  // trusting the test above: without this, a fixture that merely LOOKS
  // like the npm-init default but happens to survive redaction would pass
  // for the wrong reason (the same "fixture never reaches the branch under
  // test" shape this project has hit three times before).
  const d = repo({ test: 'echo "Error: no test specified" && exit 1' });
  const r = run(d, payload());
  const body = r.stderr.replace(/^harness-kit:.*\n?/m, '').trim();
  assert.ok(
    !/no test specified/i.test(body) || body.length === 0 || /could not be shown/i.test(r.stderr),
    'sanity: this fixture must genuinely hit the empty-body path, not merely resemble it',
  );
});

// --- Finding 2: a marker write failure must fail OPEN, never unbounded ----

test('MARKER WRITE FAILURE: an unwritable marker never blocks, even across repeated calls in the same session', () => {
  const s = sid();
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: trouble\'); process.exit(1)"' });
  // Occupy the exact marker path with a DIRECTORY, so writeFileSync fails
  // with EISDIR — the real-world trigger this mirrors (a read-only /tmp,
  // a quota'd mount, a pre-existing file owned by another user).
  // `s` is a SAFE session id (from sid()), so the naive and real formulas
  // agree here — sanitization is a no-op for already-valid input.
  const markerFile = naivePathFor(s, d);
  mkdirSync(markerFile, { recursive: true });

  const r1 = run(d, payload({ session_id: s }));
  const r2 = run(d, payload({ session_id: s }));
  const r3 = run(d, payload({ session_id: s }));
  assert.deepEqual(
    [r1.code, r2.code, r3.code], [0, 0, 0],
    'losing the ability to write the marker must mean losing the block, never an unbounded one',
  );
});

// --- Finding 6: the documented platform field must be honoured ------------

test('stop_hook_active: true never blocks, even against a genuine, otherwise-blockable failure', () => {
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: real failure\'); process.exit(1)"' });
  const r = run(d, payload({ stop_hook_active: true }));
  assert.equal(r.code, 0, 'the documented platform mechanism must be honoured, not overridden by our own cap');
  assert.equal(r.stderr.trim(), '', 'nothing is reported either — the platform is already handling this turn');
});

test('stop_hook_active: false (or absent) behaves exactly as before — a real failure still blocks', () => {
  const d = repo({ typecheck: 'node -e "console.error(\'typecheck: real failure\'); process.exit(1)"' });
  const r = run(d, payload({ stop_hook_active: false }));
  assert.equal(r.code, 2);
});

// --- Finding 9: the report is bounded by bytes, not only by line count ----

test('BYTE BOUND: a single very long line does not reach stderr in full', () => {
  // The 50 000-byte payload lives in a FILE the script reads, not in the
  // command string itself — Windows' cmd.exe has an ~8191-character
  // command-line limit, so embedding it directly would fail to spawn at
  // all rather than exercise the byte bound this test is actually about.
  const HUGE = 'x'.repeat(50_000);
  const d = repo({ typecheck: 'node bigline.cjs' });
  writeFileSync(join(d, 'big.txt'), HUGE);
  writeFileSync(
    join(d, 'bigline.cjs'),
    "console.error('typecheck: ' + require('fs').readFileSync('big.txt', 'utf8')); process.exit(1);\n",
  );
  const r = run(d, payload());
  assert.equal(r.code, 2);
  assert.ok(
    Buffer.byteLength(r.stderr, 'utf8') < 50_000,
    `a 50000-byte single line must be truncated, not written whole (got ${Buffer.byteLength(r.stderr, 'utf8')} bytes)`,
  );
  assert.match(r.stderr, /truncated/i);
});

// --- Finding 10: the marker is keyed on the repository root too -----------

test('ROOT ISOLATION: the SAME session_id AND the SAME failure in two different repositories never share a marker', () => {
  // Review correction: the original fixture gave A and B DIFFERENT failure
  // text, so a signature MISMATCH alone would explain r2 blocking,
  // regardless of whether the marker path was root-isolated at all — the
  // test would stay green even with rootTag deleted entirely. Giving both
  // repositories the IDENTICAL command removes that confound: if rootTag
  // were ever removed, both calls would read/write the SAME marker (same
  // user, same session, same namespace, same — now unvarying — signature),
  // and r2 would see `lastSignature === signature` and wrongly dedupe to
  // exit 0, exactly like the LOAD-BEARING same-session test does on
  // purpose. Only genuine root isolation makes r2 block here.
  const s = sid();
  const SAME_FAILURE = 'node -e "console.error(\'typecheck: trouble\'); process.exit(1)"';
  const dA = repo({ typecheck: SAME_FAILURE });
  const dB = repo({ typecheck: SAME_FAILURE });
  const r1 = run(dA, payload({ session_id: s }));
  assert.equal(r1.code, 2, 'sanity: repo A blocks on its own first failure');
  assert.match(r1.stderr, /trouble/, 'sanity: the failure text actually reaches stderr');
  const r2 = run(dB, payload({ session_id: s }));
  assert.equal(r2.code, 2,
    'repo B, despite an IDENTICAL failure signature and a SHARED session_id, must still get its own independent block');
});
