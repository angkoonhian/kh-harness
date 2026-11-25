import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest, KIT_VERSION, MANIFEST_PATH, readManifest, replaceFile, sha256, writeManifest } from './manifest.mjs';
import { assertAllowed, applyProposals, diffRenderer, renderDiff, isAllowedDirectory, isCanonicalJson, isWellFormedHooks, detectIndent, ALLOWED_PREFIXES, settingsReformattedNote, unusableSettingsReason } from './apply-lib.mjs';
import { APPLY, fixture, git, manifestOf, run, runEveryRegisteredHook, runResult, sandboxDataDir, separateRegistrations, settings as readSettings, UNINSTALL } from './lifecycle-fixtures.mjs';
import { execEntry } from './hook-evidence.mjs';
import { DISPATCH_PRE_PATH, SESSION_LOG_PATH, TOOL_GATE_PATH } from './propose.mjs';
import { hookEntrySha256, matcherEntrySha256, SETTINGS_PATH } from './settings-merge.mjs';

sandboxDataDir();

const repo = () => mkdtempSync(join(tmpdir(), 'hk-apply-'));

// Coordinator ruling (post-review, concern 5): credential-SHAPED fixtures are
// ASSEMBLED AT RUNTIME, never committed as literals. kh-harness's own
// `P0.security` scans tracked files for exactly these patterns, so a literal
// here makes the tool fail its own check — and a security tool that cannot be
// pointed at itself is asking for trust it has not demonstrated. The fix is
// NOT a suppression mechanism (that weakens the guard); the fixtures exist to
// exercise the detector at runtime, so they do not need to exist on disk.
// Each value below is split so that no single source literal matches a
// shape in CREDENTIAL_SHAPES (assets/scripts/harness-redact.mjs), while the
// joined runtime value is byte-identical to what the test needs.
const fileProposal = (o = {}) => ({ kind: 'file', path: 'HANDOFF.md', step: 16, contents: 'hello\n', checkId: 'P4.handoff', reason: 'r', ...o });

test('the allowlist admits the kit\'s own paths', () => {
  for (const p of ['HANDOFF.md', 'docs/ARCHITECTURE.md', 'docs/INTENT.md', 'docs/harness/x.json', '.claude/settings.json', 'scripts/bootstrap.sh']) {
    assert.doesNotThrow(() => assertAllowed(p), p);
  }
});

test('the allowlist REFUSES anything else', () => {
  for (const p of ['src/index.ts', 'package.json', '../escape.md', '/etc/passwd', 'docs/README.md', '.git/config', 'CLAUDE.md']) {
    assert.throws(() => assertAllowed(p), /not allowed/i, p);
  }
});

// --- Coordinator round 2, finding 2 ("the one I care most about"):
// uninstall-lib.mjs's directory-removal allowlist must be the SAME
// allowlist `assertAllowed` reads for writes, not a second,
// independently-maintained list that can silently diverge from it.

test('isAllowedDirectory admits the bare directories a real write would create', () => {
  for (const dir of ['.claude', 'scripts', 'docs/harness', '.claude/scripts', '.claude/rules', 'docs']) {
    assert.equal(isAllowedDirectory(dir), true, dir);
  }
});

test('isAllowedDirectory refuses a directory no write is ever allowed under', () => {
  for (const dir of ['src', 'node_modules', '.git', 'vendor']) {
    assert.equal(isAllowedDirectory(dir), false, dir);
  }
});

test('MUTATION: assertAllowed and isAllowedDirectory read the SAME allowlist — a path added to it is recognised by both, or neither', () => {
  const probe = 'tmp-shared-allowlist-probe';
  // Sanity: neither function accepts this made-up prefix YET.
  assert.throws(() => assertAllowed(`${probe}/file.txt`));
  assert.equal(isAllowedDirectory(probe), false);

  ALLOWED_PREFIXES.push(`${probe}/`);
  try {
    // If these two functions read two independent lists, this mutation
    // would only ever affect one of them. Both must change together,
    // because both read the one array this test just mutated.
    assert.doesNotThrow(() => assertAllowed(`${probe}/file.txt`), 'assertAllowed must see the mutation');
    assert.equal(isAllowedDirectory(probe), true, 'isAllowedDirectory must see the SAME mutation');
  } finally {
    ALLOWED_PREFIXES.pop(); // restore — other tests in this process must not see the probe entry
  }

  // Reverted: both refuse it again.
  assert.throws(() => assertAllowed(`${probe}/file.txt`));
  assert.equal(isAllowedDirectory(probe), false);
});

test('settingsReformattedNote names the behaviour and accepts the caller\'s own verb clause', () => {
  const applying = settingsReformattedNote('applying the patch above');
  const reverting = settingsReformattedNote('reverting the patch(es) above');
  assert.match(applying, /applying the patch above/);
  assert.match(reverting, /reverting the patch\(es\) above/);
  // Tier 4 final review, Important 3: the writers keep the file's
  // indentation and trailing newline since finding 22, so the note may no
  // longer claim an unconditional two-space rewrite.
  assert.doesNotMatch(applying, /always rewrites|JSON\.stringify|null, 2/);
  assert.match(applying, /indentation and the trailing newline are kept/);
  assert.match(applying, /key order and inline spacing are normalised/);
  // Same sentence otherwise — only the verb clause differs.
  assert.equal(
    applying.replace('applying the patch above', 'X'),
    reverting.replace('reverting the patch(es) above', 'X'),
  );
});

test('writes a proposed file and records it in the manifest', () => {
  const d = repo();
  const { manifest } = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'hello\n');
  assert.equal(manifest.files[0].sha256, sha256('hello\n'));
});

test('REFUSES to overwrite a file it did not write', () => {
  const d = repo();
  writeFileSync(join(d, 'HANDOFF.md'), 'user content\n');
  const r = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'user content\n', 'must not overwrite');
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 1);
});

// Ruling: scripts/bootstrap.sh is the one path in this task most likely to
// already be load-bearing in a real repository. Do not rely on the generic
// "REFUSES to overwrite a file it did not write" test above to cover this
// path by implication — pin it with its own explicit fixture, so a future
// change narrowing that generic mechanism cannot silently stop protecting
// THIS path without a test failing by name.
test('REFUSES to overwrite the user\'s OWN scripts/bootstrap.sh', () => {
  const d = repo();
  mkdirSync(join(d, 'scripts'), { recursive: true });
  const usersOwn = '#!/usr/bin/env bash\necho "the user\'s own, load-bearing bootstrap"\n';
  writeFileSync(join(d, 'scripts/bootstrap.sh'), usersOwn);
  const proposal = fileProposal({ path: 'scripts/bootstrap.sh', step: 5, checkId: 'P1.bootstrap', contents: '#!/usr/bin/env bash\nnpm ci\n' });
  const r = applyProposals({ root: d, proposals: [proposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'scripts/bootstrap.sh'), 'utf8'), usersOwn, 'the user\'s own bootstrap script must survive byte-for-byte');
  assert.equal(r.written.length, 0, 'nothing may be written when the target is theirs');
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].path, 'scripts/bootstrap.sh');
  assert.equal(r.skipped[0].why, 'theirs');
});

// Coordinator finding (Minor), then corrected again — the ninth instance
// of this project's "a test cannot observe what it asserts" pattern. The
// generated bootstrap script has a shebang and is meant to be executed
// directly, yet `writeFileSync` with no `mode` leaves it at the platform
// default (typically 0644, not executable) — a shebang on a non-executable
// file is decorative. The fix (apply-lib.mjs's `writeFileDeep`) calls
// `chmod` explicitly, after the write, whenever `proposal.mode` is set —
// not merely passed as `writeFileSync`'s own `mode` option, which Node
// only honours when the file is actually CREATED, not when re-writing an
// existing one.
//
// The FIRST version of this test asserted real POSIX mode bits on win32
// too, via a weaker fallback ("the file remains readable after chmodSync")
// — which PASSED whether or not the chmod fix existed at all, because
// Windows' `chmodSync` genuinely has no execute-bit effect `stat().mode`
// can report (confirmed empirically: `chmodSync(p, 0o755)` followed by
// `stat` on this machine still reports `0o666`). Deleting the ENTIRE fix —
// the `chmod` parameter, the call, all of it — left that test and its
// companion green, 35/35, on the platform this project is developed on. A
// test that cannot observe its subject must not report success.
//
// Split into two tests instead: a platform-independent one that pins the
// actual production CALL (via the injected `chmod`, following the same
// pattern as `verify.mjs`'s injectable `run`), and a POSIX-only one that
// asserts the real bits and is explicitly SKIPPED — with a stated reason,
// not silently absent — on win32.
test('chmod is called with the proposal\'s mode — platform-independent, pins the production line directly', () => {
  const d = repo();
  const calls = [];
  const chmod = (p, m) => calls.push([p, m]);
  const p = fileProposal({ path: 'scripts/bootstrap.sh', step: 5, checkId: 'P1.bootstrap', contents: '#!/usr/bin/env bash\nnpm ci\n', mode: 0o755 });
  const { written } = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0', chmod });
  assert.equal(written.length, 1);
  assert.deepEqual(calls, [[join(d, 'scripts/bootstrap.sh'), 0o755]],
    'the production chmod call must fire with exactly this path and mode, on every platform — deleting the fix leaves this empty');
});

test('a proposal with mode: 0o755 actually gets real POSIX permission bits (skipped, with a reason, on win32)', (t) => {
  if (process.platform === 'win32') {
    t.skip(
      'Windows has no execute-bit concept Node\'s stat().mode can report — ' +
      'chmodSync(path, 0o755) followed by stat() still reports 0o666 on this ' +
      'machine (confirmed empirically), so this assertion is UNOBSERVABLE here, ' +
      'not merely unexercised. The call-level test above pins the production ' +
      'line on every platform, including this one.',
    );
    return;
  }
  const d = repo();
  const p = fileProposal({ path: 'scripts/bootstrap.sh', step: 5, checkId: 'P1.bootstrap', contents: '#!/usr/bin/env bash\nnpm ci\n', mode: 0o755 });
  const { written } = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(written.length, 1);
  const mode = statSync(join(d, 'scripts/bootstrap.sh')).mode & 0o777;
  assert.equal(mode, 0o755, `expected mode 0o755, got 0o${mode.toString(8)}`);
});

test('a proposal with no mode specified never calls chmod at all', () => {
  const d = repo();
  const calls = [];
  const chmod = (p, m) => calls.push([p, m]);
  const { written } = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0', chmod });
  assert.equal(written.length, 1);
  assert.deepEqual(calls, [], 'no mode on the proposal means chmod must never be called at all');
});

test('REFUSES to overwrite a file the user edited after we wrote it', () => {
  const d = repo();
  const m = emptyManifest('0.2.0');
  const r1 = applyProposals({ root: d, proposals: [fileProposal()], manifest: m, kitVersion: '0.2.0' });
  writeFileSync(join(d, 'HANDOFF.md'), 'edited by user\n');
  const r2 = applyProposals({ root: d, proposals: [fileProposal({ contents: 'new\n' })], manifest: r1.manifest, kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'edited by user\n');
  assert.equal(r2.skipped[0].why, 'ours-modified');
});

test('a settings-hook proposal merges and records a hash-identified patch', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const p = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const { manifest } = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions, { deny: ['Edit(x)'] }, 'unrelated settings survive');
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.match(manifest.settingsPatches[0].entrySha256, /^[0-9a-f]{64}$/);
});

test('a settings-hook proposal carrying a matcher (the per-edit sensor, on PostToolUse) writes it to settings.json', () => {
  const d = repo();
  const p = {
    kind: 'settings-hook', event: 'PostToolUse', step: 9, matcher: 'Write|Edit',
    entry: { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' },
    checkId: 'P2.sensor', reason: 'r',
  };
  applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.hooks.PostToolUse[0], { matcher: 'Write|Edit', hooks: [p.entry] });
});

// Minor 10: renderDiff's preview and applyProposals's actual write build the
// matcherEntry independently unless both go through buildMatcherEntry — a
// preview that lies about what apply will write is worse than no preview.
// This parses the `+` lines BACK out of the rendered diff and asserts they
// deep-equal what actually landed on disk, so the two cannot silently drift.
test('the settings-hook preview and the actual write agree on the matcherEntry shape', () => {
  const d = repo();
  const p = {
    kind: 'settings-hook', event: 'PostToolUse', step: 9, matcher: 'Write|Edit',
    entry: { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' },
    checkId: 'P2.sensor', reason: 'r',
  };
  const diff = renderDiff(d, p);
  const addedJson = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++')) // exclude the `+++ b/...` diff header
    .map(l => l.slice(1))
    .join('\n');
  const previewed = JSON.parse(addedJson);

  applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const written = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks.PostToolUse[0];

  assert.deepEqual(previewed, written, 'the preview must describe EXACTLY what apply writes');
});

test('applying twice is a no-op', () => {
  const d = repo();
  const r1 = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const r2 = applyProposals({ root: d, proposals: [fileProposal()], manifest: r1.manifest, kitVersion: '0.2.0' });
  assert.equal(r2.written.length, 0);
  assert.equal(r1.manifest.files.length, 1);
  // A do-nothing implementation also satisfies written.length === 0; pin the
  // actual file content down so a regression that stops writing altogether
  // (rather than genuinely detecting a no-op) cannot pass silently.
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'hello\n', 'file must be byte-identical after the second apply');
  assert.equal(r2.skipped.some(s => s.path === 'HANDOFF.md' && s.why === 'unchanged'), true, 'idempotence is reported, not silent');
});

test('renderDiff shows added lines for a new file', () => {
  const diff = renderDiff(repo(), fileProposal());
  assert.match(diff, /^\+hello$/m);
});

test('a proposal targeting a disallowed path throws before anything is written', () => {
  const d = repo();
  assert.throws(() => applyProposals({ root: d, proposals: [fileProposal({ path: 'src/evil.ts' })], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(join(d, 'src/evil.ts')), false);
});

// --- Fix round 1 -----------------------------------------------------------

test('the input manifest is not mutated, including nested arrays', () => {
  const d = repo();
  const original = emptyManifest('0.2.0');
  original.files.push({ path: 'OTHER.md', sha256: sha256('x'), step: 1, writtenAt: 'then' });
  const originalFilesRef = original.files;
  const { manifest } = applyProposals({ root: d, proposals: [fileProposal()], manifest: original, kitVersion: '0.2.0' });
  assert.notEqual(manifest.files, originalFilesRef, 'the returned files array must be a new array, not the same reference');
  assert.equal(original.files.length, 1, 'a shallow {...manifest} clone would leak the push below into this array too');
  assert.equal(manifest.files.length, 2);
});

test('pre-write validation is order-independent: a disallowed second entry blocks the whole batch', () => {
  const d = repo();
  const proposals = [fileProposal(), fileProposal({ path: 'src/evil.ts', checkId: 'x' })];
  assert.throws(() => applyProposals({ root: d, proposals, manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'the valid first entry must not be written either');
});

test('an unparseable settings.json is left untouched and reported, not destroyed', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const original = '{ "permissions": { "deny": ["Edit(x)"], }, }'; // trailing commas — invalid JSON
  writeFileSync(join(d, '.claude/settings.json'), original);
  const p = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const r = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), original, 'must not touch an unparseable settings file');
  assert.equal(r.patched.length, 0);
  assert.equal(r.skipped[0].why, 'unparseable');
  assert.equal(r.manifest.settingsPatches.length, 0, 'no patch may be recorded for a write that did not happen');
});

test('a settings.json holding a JSON array is treated like unparseable — nothing written, nothing recorded', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), '[]');
  const p = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const r = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), '[]');
  assert.equal(r.patched.length, 0);
  assert.equal(r.skipped[0].why, 'unparseable');
  assert.equal(r.manifest.settingsPatches.length, 0);
});

test('a mid-batch write failure stops processing but returns normally with everything written so far recorded', () => {
  const d = repo();
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, 'docs/harness'), 'a plain file sitting where a directory needs to go\n');
  const p1 = fileProposal(); // HANDOFF.md — should succeed
  const p2 = { kind: 'file', path: 'docs/harness/x.json', step: 1, contents: '{}\n', checkId: 'x', reason: 'r' };
  const r = applyProposals({ root: d, proposals: [p1, p2], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'hello\n', 'the proposal before the failure must still be written');
  assert.equal(r.written.length, 1);
  assert.equal(r.written[0].path, 'HANDOFF.md');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].path, /docs.harness/);
  assert.ok(r.failed[0].error.length > 0);
  assert.equal(r.manifest.files.length, 1, 'the manifest returned must record exactly what was actually written');
});

// --- C2: the settings preview must not print the user's settings ---------

const SECRET_SETTINGS = {
  env: { DEPLOY_TOKEN: 'glpat-SECRET-IN-ENV' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: "curl -H 'PRIVATE-TOKEN: ghp_SECRET_IN_HOOK' https://example.invalid" }] }],
  },
  permissions: { deny: ['Edit(secrets/**)'] },
};
const hookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };

test('C2: a settings-hook preview never prints the user\'s own settings', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(SECRET_SETTINGS, null, 2));

  const diff = renderDiff(d, hookProposal);
  assert.doesNotMatch(diff, /SECRET-IN-ENV/, 'a credential in env must never reach the preview');
  assert.doesNotMatch(diff, /SECRET_IN_HOOK/, 'a token in an unrelated hook command must never reach the preview');
  assert.doesNotMatch(diff, /DEPLOY_TOKEN|permissions|Edit\(secrets/, 'no part of the user\'s settings belongs in a one-entry preview');

  // Still a useful preview: it shows exactly what will be added, and where.
  assert.match(diff, /^\+\s*"command": "node x\.mjs"$/m, 'the entry that will actually be added must be shown');
  assert.match(diff, /hooks\.SessionStart/, 'and the preview must say where it goes');
});

test('C2: a settings-hook preview with a matcher shows the matcher, still without the user\'s own settings', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(SECRET_SETTINGS, null, 2));

  const p = {
    kind: 'settings-hook', event: 'PostToolUse', step: 9, matcher: 'Write|Edit',
    entry: { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' },
    checkId: 'P2.sensor', reason: 'r',
  };
  const diff = renderDiff(d, p);
  assert.doesNotMatch(diff, /SECRET-IN-ENV|SECRET_IN_HOOK/, 'no part of the user\'s settings belongs in this preview either');
  assert.match(diff, /"matcher": "Write\|Edit"/, 'the matcher being added is shown');
  assert.match(diff, /hooks\.PostToolUse/);
});

test('C2: a secret in an existing entry under the same event is not shown either', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `node theirs.mjs ${['--token', 'ghp_SECRET_SAME_EVENT'].join('=')}` }] }],
    },
  }, null, 2));

  const diff = renderDiff(d, hookProposal);
  assert.doesNotMatch(diff, /SECRET_SAME_EVENT/, 'diffing the whole hooks[event] subtree would still leak');
  assert.match(diff, /1 existing hooks\.SessionStart entry/, 'the preview must still say it is appending, not replacing');
});

test('a pre-existing directory junction cannot route a write outside the repository', () => {
  const d = repo();
  const outside = mkdtempSync(join(tmpdir(), 'hk-outside-'));
  symlinkSync(outside, join(d, 'docs'), 'junction');
  const p = { kind: 'file', path: 'docs/harness/evil.md', step: 1, contents: 'x', checkId: 'x', reason: 'r' };
  assert.throws(() => applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(join(outside, 'harness')), false, 'nothing may be written through the junction');
});

test('a dangling symlink sitting at the target itself is refused, not silently followed', () => {
  const d = repo();
  const outside = join(mkdtempSync(join(tmpdir(), 'hk-outside2-')), 'does-not-exist.md');
  symlinkSync(outside, join(d, 'HANDOFF.md'), 'file');
  assert.throws(() => applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(outside), false, 'the dangling target must not have been created');
});

// --- Task 2: settings-deny proposals apply additively ----------------------

const denyProposal = (globs = ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)']) =>
  ({ kind: 'settings-deny', step: 11, globs, checkId: 'P2.protected', reason: 'r' });

test('a settings-deny proposal merges and records a hash-identified patch', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ env: { KEEP: '1' } }));
  const { manifest, patched } = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.deny, ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)']);
  assert.deepEqual(s.env, { KEEP: '1' }, 'unrelated settings survive');
  assert.equal(patched.length, 1);
  assert.equal(manifest.settingsPatches[0].container, '/permissions/deny');
  assert.match(manifest.settingsPatches[0].entrySha256, /^[0-9a-f]{64}$/);
});

test('a settings-deny proposal whose rules are all already present is reported unchanged, not rewritten', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const before = JSON.stringify({ permissions: { deny: ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)'] } }, null, 2);
  writeFileSync(join(d, '.claude/settings.json'), before);
  const { skipped, patched, manifest } = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), before, 'file must be byte-identical — nothing to add');
  assert.equal(patched.length, 0);
  assert.equal(skipped.some(s => s.path === '.claude/settings.json' && s.why === 'unchanged'), true);
  assert.equal(manifest.settingsPatches.length, 0, 'no patch may be recorded when nothing was added');
});

test('a settings-deny proposal adds only the genuinely new rules when some already exist', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(prisma/migrations/**)'] } }));
  const { manifest } = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.deny, ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)'], 'no duplicate of the pre-existing rule');
  assert.deepEqual(manifest.settingsPatches[0].rules, ['Edit(pnpm-lock.yaml)']);
});

test('an unparseable settings.json is left untouched when a settings-deny proposal targets it', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const original = '{ "permissions": { "deny": ["Edit(x)"], }, }'; // trailing commas — invalid JSON
  writeFileSync(join(d, '.claude/settings.json'), original);
  const r = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), original, 'must not touch an unparseable settings file');
  assert.equal(r.patched.length, 0);
  assert.equal(r.skipped[0].why, 'unparseable');
  assert.equal(r.manifest.settingsPatches.length, 0, 'no patch may be recorded for a write that did not happen');
});

// --- the settings-deny preview must not print the user's own settings -----

const denySecretProposal = { kind: 'settings-deny', step: 11, globs: ['Edit(prisma/migrations/**)'], checkId: 'P2.protected', reason: 'r' };

test('a settings-deny preview never prints the user\'s own settings', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(SECRET_SETTINGS, null, 2));

  const diff = renderDiff(d, denySecretProposal);
  assert.doesNotMatch(diff, /SECRET-IN-ENV/, 'a credential in env must never reach the preview');
  assert.doesNotMatch(diff, /SECRET_IN_HOOK/, 'a token in an unrelated hook command must never reach the preview');
  assert.doesNotMatch(diff, /DEPLOY_TOKEN|Edit\(secrets/, 'no part of the user\'s settings belongs in a one-rule preview');

  // Still a useful preview: it shows exactly what will be added, and where.
  assert.match(diff, /^\+"Edit\(prisma\/migrations\/\*\*\)"$/m, 'the rule that will actually be added must be shown');
  assert.match(diff, /permissions\.deny/, 'and the preview must say where it goes');
});

test('a secret in an existing deny rule under the same container is not shown either', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    permissions: { deny: [`Bash(curl --header "${['Author', 'ization'].join('')}: ${['Bearer', 'ghp_SECRET_SAME_CONTAINER'].join(' ')}":*)`] },
  }, null, 2));

  const diff = renderDiff(d, denySecretProposal);
  assert.doesNotMatch(diff, /SECRET_SAME_CONTAINER/, 'diffing the whole permissions.deny array would still leak');
  assert.match(diff, /1 existing permissions\.deny entr/, 'the preview must still say it is appending, not replacing');
});

// --- the preview shows nothing when every proposed rule is already present
// (not reachable through the CLI — gap-model.mjs flips P2.protected to
// `declared` once any deny rule exists, so renderDiff is never called on
// this shape in practice; this documents the defensively-redundant branch
// directly, by calling renderDiff itself, the way the brief's "report
// unchanged" exception already covers apply-side at the library level) ---

test('the settings-deny preview shows nothing to add when every proposed rule is already present', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(prisma/migrations/**)'] } }));
  const diff = renderDiff(d, denySecretProposal); // proposes exactly Edit(prisma/migrations/**), already present
  assert.match(diff, /every proposed rule is already present — nothing would be added/);
  assert.doesNotMatch(diff, /^\+"/m, 'nothing may be shown as being added when nothing is new');
});

// --- a malformed permissions.deny must never crash the dry run -----------
//
// Before this fix, readSettingsResult validated only the top-level JSON
// shape; `renderSettingsDenyDiff` then called `addDenyRules` unguarded,
// which assumes `permissions.deny` is already an array (`.push(...)`,
// `new Set(...)`). Any settings.json with a non-array `permissions.deny`,
// or a non-object `permissions`, crashed `renderDiff` with a raw
// TypeError — reachable from `apply.mjs`'s DEFAULT (no --yes) path, in
// violation of the stated exit 0/2/3 contract. Fixed by extending
// readSettingsResult itself to refuse these shapes exactly like
// unparseable JSON, so both renderDiff and applyProposals route through
// the existing 'could not be parsed' / 'unparseable' paths with no new
// error handling needed at either call site.

const MALFORMED_DENY_SHAPES = [
  ['deny is a string', { permissions: { deny: 'Edit(secrets/**)' } }],
  ['deny is an object', { permissions: { deny: { 0: 'Edit(secrets/**)' } } }],
  ['deny is a number', { permissions: { deny: 3 } }],
  ['permissions is a string', { permissions: 'nope' }],
];

test('renderDiff never throws on a malformed permissions.deny — reports it like unparseable JSON instead', () => {
  for (const [label, shape] of MALFORMED_DENY_SHAPES) {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(shape));
    assert.doesNotThrow(() => renderDiff(d, denySecretProposal), label);
    const diff = renderDiff(d, denySecretProposal);
    assert.match(diff, /could not be parsed as a JSON object/, `${label}: must report the same way as unparseable JSON`);
  }
});

test('applyProposals never throws on a malformed permissions.deny — skips it as unparseable, writes nothing', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const original = JSON.stringify({ permissions: { deny: 'Edit(secrets/**)' } });
  writeFileSync(join(d, '.claude/settings.json'), original);
  const r = applyProposals({ root: d, proposals: [denySecretProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), original, 'must not touch a settings.json it cannot safely merge into');
  assert.equal(r.patched.length, 0);
  assert.equal(r.failed.length, 0, 'this is a refusal, not a write failure');
  assert.equal(r.skipped[0].why, 'unparseable');
});

// --- Audit Tier 2, finding 7: a malformed `hooks` block crashed --yes after
// --- the dry run had promised success ----------------------------------------
//
// `readSettingsResult` validated `permissions` but not `hooks`, so
// `{"hooks":{"Stop":{…}}}` reached `addHookEntry`'s `.push` and threw a
// TypeError — exit 2 after a dry run that showed a clean diff. The same
// discipline as the malformed-deny shapes above: refuse at the one read,
// and both callers route through the paths they already have.

const MALFORMED_HOOKS_SHAPES = [
  ['hooks is an array', { hooks: [] }],
  ['an event is an object, not an array', { hooks: { Stop: {} } }],
  ['a matcher entry is a string', { hooks: { Stop: ['node x.mjs'] } }],
  ['a matcher entry\'s hooks is an object', { hooks: { Stop: [{ hooks: {} }] }, permissions: { deny: [] } }],
];
const stopHookProposal = { kind: 'settings-hook', event: 'Stop', step: 10, entry: { type: 'command', command: 'node verify.mjs' }, checkId: 'P2.stopgate', reason: 'r' };

test('isWellFormedHooks accepts the shapes Claude Code documents and nothing else', () => {
  for (const ok of [undefined, {}, { Stop: [] }, { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, { PostToolUse: [{ matcher: 'Edit', hooks: [] }] }, { Stop: [{ matcher: 'x' }] }]) {
    assert.equal(isWellFormedHooks(ok), true, JSON.stringify(ok));
  }
  for (const [label, shape] of MALFORMED_HOOKS_SHAPES) assert.equal(isWellFormedHooks(shape.hooks), false, label);
  assert.equal(isWellFormedHooks(null), false);
  assert.equal(isWellFormedHooks('hooks'), false);
});

test('renderDiff never throws on a malformed hooks block — reports it like unparseable JSON instead', () => {
  for (const [label, shape] of MALFORMED_HOOKS_SHAPES) {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(shape));
    assert.doesNotThrow(() => renderDiff(d, stopHookProposal), label);
    assert.match(renderDiff(d, stopHookProposal), /could not be parsed as a JSON object/, `${label}: the dry run must say what --yes will say`);
  }
});

test('applyProposals never throws on a malformed hooks block — skips it as unparseable, writes nothing', () => {
  for (const [label, shape] of MALFORMED_HOOKS_SHAPES) {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    const original = JSON.stringify(shape);
    writeFileSync(join(d, '.claude/settings.json'), original);
    let r;
    assert.doesNotThrow(() => { r = applyProposals({ root: d, proposals: [stopHookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }); }, label);
    assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), original, `${label}: must not touch a settings.json it cannot safely merge into`);
    assert.equal(r.patched.length, 0, label);
    assert.equal(r.skipped[0]?.why, 'unparseable', label);
  }
});

// --- Audit Tier 2, finding 8 (second half): the manifest's kitVersion never
// --- moved off the version that first created it -----------------------------
test('applyProposals records the kit version that wrote', () => {
  const d = repo();
  const r = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.1.0'), kitVersion: '0.2.0' });
  assert.equal(r.written.length, 1, 'fixture sanity: something was written');
  assert.equal(r.manifest.kitVersion, '0.2.0', 'a 0.2.0 file on disk under a 0.1.0 manifest is a false record');
});

test('a run that writes nothing leaves the recorded kit version alone', () => {
  const d = repo();
  const r = applyProposals({ root: d, proposals: [], manifest: emptyManifest('0.1.0'), kitVersion: '0.2.0' });
  assert.equal(r.manifest.kitVersion, '0.1.0');
});

// Tier 2 final review, Minor 8: the matcher travels from the proposal into the
// dedupe — guarded here through applyProposals, not only in settings-merge.
test('a settings-hook proposal with a matcher is written alongside the same command registered under a different matcher', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/scripts/lint-touched.mjs' }] }] },
  }));
  const p = {
    kind: 'settings-hook', event: 'PostToolUse', step: 9, matcher: 'Write|Edit',
    entry: { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' }, checkId: 'P2.sensor', reason: 'r',
  };
  const r = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(r.patched.length, 1, 'under Bash it never fires on an edit, so ours is a different hook');
  assert.equal(r.skipped.length, 0);
});

// --- Audit Tier 3, finding 19: the preview of a verbatim asset copy is one line
const assetCopy = (o = {}) => ({
  kind: 'file', path: '.claude/scripts/lint-touched.mjs', step: 9, checkId: 'P2.sensor', reason: 'r',
  assetSource: 'scripts/lint-touched.mjs', contents: '#!/usr/bin/env node\n// stamp\nline one\nline two\n', ...o,
});

test('renderDiff summarises a NEW file that is a verbatim copy of a shipped asset in one line', () => {
  const diff = renderDiff(repo(), assetCopy());
  assert.match(diff, /^\+4 lines — a verbatim copy of assets\/scripts\/lint-touched\.mjs/, diff);
  assert.doesNotMatch(diff, /\+\+\+ b\//, 'no diff body: the reader can open the asset');
  assert.match(diff, /nothing of yours is changed/);
});

test('renderDiff shows the full diff for an UPDATE of a shipped asset', () => {
  const d = repo();
  mkdirSync(join(d, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(d, '.claude/scripts/lint-touched.mjs'), '#!/usr/bin/env node\n// stamp\nline one\n');
  const diff = renderDiff(d, assetCopy());
  assert.match(diff, /\+\+\+ b\/\.claude\/scripts\/lint-touched\.mjs/, 'what changes in an installed file must be shown');
  assert.match(diff, /^\+line two$/m);
});

test('renderDiff shows the full diff for a new file that is not an asset copy', () => {
  const diff = renderDiff(repo(), fileProposal());
  assert.match(diff, /\+\+\+ b\/HANDOFF\.md/);
});

// --- Audit Tier 4, finding 22: settings.json kept its indentation -----------
//
// Both writers stringified with two spaces, so a four-space (or tabbed) file
// came back re-indented throughout — the one change the tool promised not to
// make. The indentation is read from the file and written back with it.
test('detectIndent reads two spaces, four spaces and a tab, and defaults to two', () => {
  assert.equal(detectIndent('{\n  "a": 1\n}'), '  ');
  assert.equal(detectIndent('{\n    "a": 1\n}'), '    ');
  assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
  assert.equal(detectIndent('{"a":1}'), '  ', 'a compact file gets the conventional two');
  assert.equal(detectIndent(null), '  ', 'a file being created gets the conventional two');
});

test('a four-space settings.json is patched with four spaces', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }, null, 4) + '\n');
  applyProposals({ root: d, proposals: [hookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const after = readFileSync(join(d, '.claude/settings.json'), 'utf8');
  assert.match(after, /^    "permissions"/m, 'the user\'s own indentation is kept');
  assert.doesNotMatch(after, /^  "/m, 'nothing is re-indented to two spaces');
  assert.deepEqual(JSON.parse(after).permissions.deny, ['Edit(secrets/**)']);
});

test('isCanonicalJson accepts a four-space file as canonical, so no reformat note is printed for it', () => {
  const four = JSON.stringify({ a: { b: 1 } }, null, 4) + '\n';
  assert.equal(isCanonicalJson(four), true);
  assert.equal(isCanonicalJson(JSON.stringify({ a: { b: 1 } }, null, '\t') + '\n'), true);
  assert.equal(isCanonicalJson('{"a": {"b": 1}}\n'), false, 'inline spacing is still a reformat');
});

// --- Audit Tier 4, finding 27: apply never writes CLAUDE.md ----------------
//
// The redirect of a CLAUDE.md proposal to docs/harness/CLAUDE.proposed.md
// was unreachable: no generator has ever proposed CLAUDE.md (P1.instructions
// is a prompt, and the SKILL writes the .proposed file itself). Dead code
// documented as live is a false sentence; the path leaves the allowlist
// instead, so a future generator cannot write it without a deliberate change.
test('assertAllowed refuses CLAUDE.md — apply never writes it', () => {
  assert.throws(() => assertAllowed('CLAUDE.md'), /not allowed/i);
  const d = repo();
  writeFileSync(join(d, 'CLAUDE.md'), '# hand-tuned notes\nkeep me\n');
  const p = { kind: 'file', path: 'CLAUDE.md', step: 1, contents: '# generated\n', checkId: 'P1.instructions', reason: 'r' };
  assert.throws(() => applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), '# hand-tuned notes\nkeep me\n');
  assert.equal(existsSync(join(d, 'docs/harness/CLAUDE.proposed.md')), false, 'nothing is redirected anywhere either');
});

// --- Whole-branch review, F7: one canonical-form predicate, not two ------
//
// `apply.mjs`'s `alreadyCanonical` and `uninstall-lib.mjs`'s `wasCanonical`
// asked the same question, and had drifted: only the second used
// `matchingNewline`, which was added on this branch precisely so the tool
// stops appending a trailing newline to a file that had none. So a
// settings.json already in exactly the form this tool writes, minus that one
// byte, was misclassified as non-canonical and `apply` printed "was
// reformatted … whitespace/indentation may now differ throughout the file"
// over a diff that reformatted nothing. The comment on the correct copy
// claimed it "mirrors apply.mjs's own alreadyCanonical"; it corrected it.

test('F7: a settings.json in this tool\'s own form but WITHOUT a trailing newline is canonical', () => {
  const raw = JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }, null, 2);
  assert.equal(raw.endsWith('\n'), false, 'fixture sanity: JSON.stringify never ends in a newline');
  assert.equal(isCanonicalJson(raw), true,
    'this is byte-for-byte what the tool writes for a file that had no trailing newline — nothing would be reformatted');
});

test('F7: the same content WITH a trailing newline is canonical too', () => {
  const raw = JSON.stringify({ a: 1 }, null, 2) + '\n';
  assert.equal(isCanonicalJson(raw), true);
});

test('F7: genuinely non-canonical formatting is still reported as such', () => {
  for (const raw of [
    '{"a":1}',                            // compact
    // A four-space file is canonical since audit Tier 4 (the writer keeps
    // the file's own indentation); an INCONSISTENT indent is what cannot be.
    JSON.stringify({ a: { b: 1 } }, null, 4).replace('\n    "a"', '\n   "a"'),
    JSON.stringify({ a: 1 }, null, 2) + '\n\n', // extra blank line
  ]) {
    assert.equal(isCanonicalJson(raw), false, `must be non-canonical: ${JSON.stringify(raw)}`);
  }
});

test('F7: an absent, unreadable or unparseable file reports canonical — there is nothing to reformat', () => {
  assert.equal(isCanonicalJson(null), true, 'absent');
  assert.equal(isCanonicalJson('{ not json'), true, 'unparseable never reaches a settings write');
});

// Phase 3: docs/INTENT.md is written by the SKILL, not by apply (there is no
// generator — propose.test.mjs pins that), exactly like docs/ARCHITECTURE.md.
// It is on the allowlist anyway, for the same reason ARCHITECTURE.md is: a
// future generator must not be refused by accident, and the allowlist is
// the single statement of "paths this kit may ever write".
test('docs/INTENT.md is on the write allowlist, like docs/ARCHITECTURE.md', () => {
  assert.doesNotThrow(() => assertAllowed('docs/INTENT.md'));
  // And nothing else under docs/ is admitted by that addition.
  assert.throws(() => assertAllowed('docs/INTENT.txt'), /not allowed/i);
  assert.throws(() => assertAllowed('docs/intent/INTENT.md'), /not allowed/i);
});

// --- a present but unparseable settings.json is its own state -------------

const sessionHookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };

test('a settings.json with a BOM is read, patched, and keeps its BOM', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const original = '\uFEFF' + JSON.stringify({ permissions: { deny: ['Edit(x)'] } }, null, 2) + '\n';
  writeFileSync(join(d, '.claude/settings.json'), original, 'utf8');
  assert.equal(isCanonicalJson(original), true, 'a BOM the writer keeps is not a reformat');
  const r = applyProposals({ root: d, proposals: [sessionHookProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(r.patched.length, 1, JSON.stringify(r.skipped));
  const after = readFileSync(join(d, '.claude/settings.json'), 'utf8');
  assert.equal(after.slice(0, 2), '\uFEFF{', 'exactly one BOM, kept');
  const s = JSON.parse(after.slice(1));
  assert.deepEqual(s.permissions.deny, ['Edit(x)']);
  assert.equal(s.hooks.SessionStart.length, 1);
});

test('unusableSettingsReason names why a settings.json cannot be patched, and is null when it can', () => {
  const at = text => {
    const d = repo();
    if (text !== null) {
      mkdirSync(join(d, '.claude'), { recursive: true });
      writeFileSync(join(d, '.claude/settings.json'), text);
    }
    return unusableSettingsReason(d);
  };
  assert.equal(at(null), null, 'absent is patchable: it is created');
  assert.equal(at('{}'), null);
  assert.equal(at('{ ,'), 'is not valid JSON');
  assert.equal(at('[]'), 'is not a JSON object');
  assert.equal(at('{"permissions":"x"}'), 'has a `permissions` that is not an object');
  assert.equal(at('{"permissions":{"deny":3}}'), 'has a `permissions.deny` that is not an array');
  assert.equal(at('{"hooks":{"Stop":{}}}'), 'has a `hooks` block that is not the shape Claude Code documents');
});

test('the dry-run preview of a patch to an unparseable settings.json says --yes writes nothing at all', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), '{ ,');
  const diff = renderDiff(d, sessionHookProposal);
  assert.match(diff, /could not be parsed as a JSON object: it is not valid JSON/);
  assert.match(diff, /--yes writes nothing at all/);
});

test('apply --yes with unreadable settings writes no hook script and exits 2', () => {
  const d = fixture();
  const broken = '{ "permissions": { "deny": ["Edit(secrets/**)"] }, }';
  writeFileSync(join(d, '.claude/settings.json'), broken);
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'break settings');

  const dry = spawnSync(process.execPath, [APPLY, d], { encoding: 'utf8' });
  assert.equal(dry.status, 0, `a dry run writes nothing, so it has nothing to fail: ${dry.stderr}`);
  assert.match(dry.stdout, /--yes writes nothing at all/);

  const r = spawnSync(process.execPath, [APPLY, d, '--yes'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /\.claude\/settings\.json is not valid JSON/);
  assert.equal(existsSync(join(d, '.claude/scripts')), false, 'no hook script may be installed that cannot be registered');
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'nothing else is written either');
  assert.equal(existsSync(join(d, '.claude/kh-harness.manifest.json')), false);
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), broken);
});

// --- A hook is registered only beside the bytes this kit writes -------------

const hookRequiring = requiresFiles => ({
  kind: 'settings-hook', event: 'Stop', step: 10, checkId: 'P2.stopgate', reason: 'r', requiresFiles,
  entry: { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/scripts/x.mjs'] },
});

test('a hook whose required file is missing is not registered, and the skip names the file', () => {
  const d = repo();
  const r = applyProposals({ root: d, proposals: [hookRequiring([{ path: '.claude/scripts/x.mjs', sha256: sha256('x\n') }])], manifest: null, kitVersion: '0.2.0' });
  assert.deepEqual(r.patched, []);
  assert.deepEqual(r.skipped.map(s => s.why), ['missing-dependency: .claude/scripts/x.mjs']);
  assert.equal(existsSync(join(d, '.claude/settings.json')), false);
});

test('a hook whose required file holds another kit version\'s bytes is not registered, and the skip names the file', () => {
  const d = repo();
  mkdirSync(join(d, '.claude/scripts'), { recursive: true });
  writeFileSync(join(d, '.claude/scripts/x.mjs'), 'x\n');
  writeFileSync(join(d, '.claude/scripts/lib.mjs'), 'export const OLD = 1;\n');
  const requires = [{ path: '.claude/scripts/x.mjs', sha256: sha256('x\n') }, { path: '.claude/scripts/lib.mjs', sha256: sha256('export const NEW = 1;\n') }];
  const r = applyProposals({ root: d, proposals: [hookRequiring(requires)], manifest: null, kitVersion: '0.2.0' });
  assert.deepEqual(r.patched, []);
  assert.deepEqual(r.skipped.map(s => s.why), ['dependency-not-this-kit-version: .claude/scripts/lib.mjs']);
  assert.equal(existsSync(join(d, '.claude/settings.json')), false);
});

test('a hook whose required files hold this kit\'s bytes, CRLF or LF, is registered', () => {
  const d = repo();
  mkdirSync(join(d, '.claude/scripts'), { recursive: true });
  writeFileSync(join(d, '.claude/scripts/x.mjs'), 'a\r\nb\r\n');
  const r = applyProposals({ root: d, proposals: [hookRequiring([{ path: '.claude/scripts/x.mjs', sha256: sha256('a\nb\n') }])], manifest: null, kitVersion: '0.2.0' });
  assert.deepEqual(r.patched.map(p => p.event), ['Stop']);
});

// --- The settings patches of one run are one write --------------------------

const batchHook = event => ({ kind: 'settings-hook', event, step: 31, checkId: 'P5.sessionlog', reason: 'r', entry: { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/scripts/session-log.mjs'] } });
const batchDeny = globs => ({ kind: 'settings-deny', step: 30, checkId: 'P5.toolgate', reason: 'r', globs });
const OWNERS_SETTINGS = JSON.stringify({ env: { KEEP: 'me' }, permissions: { deny: ['Edit(secrets/**)'] } }, null, 2) + '\n';

function repoWithSettings() {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), OWNERS_SETTINGS);
  return d;
}

test('every settings patch of a run reaches .claude/settings.json in one write, and each is recorded', () => {
  const d = repoWithSettings();
  let writes = 0;
  const counted = (path, text) => { writes += 1; writeFileSync(path, text); };
  const proposals = [batchHook('SessionStart'), batchDeny(['Edit(a)']), batchHook('Stop'), batchDeny(['Edit(b)'])];
  const r = applyProposals({ root: d, proposals, manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0', replaceSettings: counted });
  assert.equal(writes, 1);
  assert.deepEqual(r.patched.map(p => p.event), ['SessionStart', 'permissions.deny', 'Stop', 'permissions.deny']);
  assert.deepEqual(r.manifest.settingsPatches.map(p => p.container), ['/hooks/SessionStart', '/permissions/deny', '/hooks/Stop', '/permissions/deny']);
  const after = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(after.env, { KEEP: 'me' });
  assert.deepEqual(after.permissions.deny, ['Edit(secrets/**)', 'Edit(a)', 'Edit(b)']);
  assert.deepEqual(Object.keys(after.hooks), ['SessionStart', 'Stop']);
});

test('a settings write that dies midway leaves the owner\'s file as it was, and the manifest records no patch the file does not hold', () => {
  const d = repoWithSettings();
  // What a kill partway through the write leaves: part of the new text in
  // the temporary file, and the file itself not yet replaced.
  const dies = (path, text) => {
    writeFileSync(`${path}.tmp-1`, text.slice(0, Math.floor(text.length / 2)));
    throw new Error('ENOSPC: no space left on device');
  };
  const proposals = [fileProposal(), batchHook('SessionStart'), batchDeny(['Edit(a)']), batchHook('Stop')];
  const r = applyProposals({ root: d, proposals, manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0', replaceSettings: dies });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), OWNERS_SETTINGS, 'byte for byte the old content');
  assert.deepEqual(r.manifest.settingsPatches, [], 'nothing reached the file, so nothing is recorded');
  assert.deepEqual(r.patched, []);
  assert.deepEqual(r.failed.map(f => f.path), ['.claude/settings.json']);
  assert.match(r.failed[0].error, /failed to write \.claude\/settings\.json: ENOSPC/);
  assert.deepEqual(r.manifest.files.map(f => f.path), ['HANDOFF.md'], 'the file written before it is recorded');
});

test('the manifest holding the staged patch records is written before the settings file is replaced', () => {
  const d = repoWithSettings();
  const order = [];
  let staged = null;
  const r = applyProposals({
    root: d, proposals: [fileProposal(), batchHook('SessionStart'), batchDeny(['Edit(a)'])], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0',
    persistManifest: manifest => { order.push('manifest'); staged = structuredClone(manifest); },
    replaceSettings: (path, text) => { order.push('settings'); writeFileSync(path, text); },
  });
  assert.deepEqual(order, ['manifest', 'settings']);
  assert.deepEqual(staged.settingsPatches, r.manifest.settingsPatches, 'every patch about to be written is on record first');
  assert.deepEqual(staged.files.map(f => f.path), ['HANDOFF.md'], 'with every file written so far');
});

test('a manifest that cannot be written before the settings file leaves that file as it was and records no patch', () => {
  const d = repoWithSettings();
  let settingsWrites = 0;
  const r = applyProposals({
    root: d, proposals: [batchHook('Stop')], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0',
    persistManifest: () => { throw new Error('EROFS: read-only file system'); },
    replaceSettings: () => { settingsWrites += 1; },
  });
  assert.equal(settingsWrites, 0);
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), OWNERS_SETTINGS);
  assert.deepEqual([r.manifest.settingsPatches, r.patched], [[], []]);
  assert.deepEqual(r.failed.map(f => f.path), ['.claude/kh-harness.manifest.json']);
  assert.match(r.failed[0].error, /^failed to record the settings patches in \.claude\/kh-harness\.manifest\.json, so \.claude\/settings\.json was not written: EROFS/);
});

test('a patch staged again replaces the record a killed run left for it, so each entry has one record', () => {
  const d = repoWithSettings();
  // The record a run killed before the settings write leaves: the patches
  // recorded, the settings file as it was.
  let killed = null;
  applyProposals({
    root: d, proposals: [batchHook('Stop'), batchDeny(['Edit(a)'])], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0',
    persistManifest: manifest => { killed = structuredClone(manifest); },
    replaceSettings: () => { throw new Error('killed'); },
  });
  assert.equal(killed.settingsPatches.length, 2);
  const again = applyProposals({ root: d, proposals: [batchHook('Stop'), batchDeny(['Edit(a)'])], manifest: killed, kitVersion: '0.2.0' });
  assert.deepEqual(again.manifest.settingsPatches.map(p => p.container), ['/hooks/Stop', '/permissions/deny']);
});

test('after a run the file holds every entry the manifest records and no kit entry it does not', () => {
  const d = repoWithSettings();
  const proposals = [batchHook('SessionStart'), batchHook('Stop'), batchDeny(['Edit(a)', 'Edit(b)'])];
  const r = applyProposals({ root: d, proposals, manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const text = readFileSync(join(d, '.claude/settings.json'), 'utf8');
  const after = JSON.parse(text);
  assert.ok(text.endsWith('}\n'), 'the complete new content');
  const hookRecords = r.manifest.settingsPatches.filter(p => p.container.startsWith('/hooks/'));
  const kitEntries = Object.values(after.hooks).flat().filter(m => m.hooks.some(h => h.args?.[0]?.endsWith('session-log.mjs')));
  assert.equal(kitEntries.length, hookRecords.length);
  for (const p of hookRecords) assert.equal(after.hooks[p.event].length, 1, p.event);
  const denyRecord = r.manifest.settingsPatches.find(p => p.container === '/permissions/deny');
  assert.deepEqual(denyRecord.rules, ['Edit(a)', 'Edit(b)']);
  assert.deepEqual(after.permissions.deny.filter(rule => rule !== 'Edit(secrets/**)'), denyRecord.rules);
  assert.deepEqual(readdirSync(join(d, '.claude')).sort(), ['settings.json'], 'and no temporary file');
});

test('a file write that fails still leaves the settings patches staged before it written and recorded', () => {
  const d = repoWithSettings();
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, 'docs/harness'), 'a plain file where a directory must go\n');
  const blocked = { kind: 'file', path: 'docs/harness/x.json', step: 1, contents: '{}\n', checkId: 'x', reason: 'r' };
  const r = applyProposals({ root: d, proposals: [batchHook('SessionStart'), blocked, batchHook('Stop')], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.deepEqual(r.patched.map(p => p.event), ['SessionStart'], 'nothing after the failure is attempted');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks), ['SessionStart']);
  assert.deepEqual(r.manifest.settingsPatches.map(p => p.event), ['SessionStart']);
  assert.equal(r.failed.length, 1);
});

test('a settings file the run creates is recorded as created only once it is written', () => {
  const d = repo();
  const refuses = () => { throw new Error('EACCES: permission denied'); };
  const failed = applyProposals({ root: d, proposals: [batchHook('Stop')], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0', replaceSettings: refuses });
  assert.equal(failed.manifest.settingsCreated, undefined);
  const ok = applyProposals({ root: d, proposals: [batchHook('Stop')], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(ok.manifest.settingsCreated, true);
});

// --- A dry run's previews count what the previews before them add -----------

test('the second deny preview of one dry run counts the rules the first would add', () => {
  const d = repoWithSettings();
  const preview = diffRenderer(d);
  assert.match(preview(batchDeny(['Edit(a)', 'Edit(b)'])), /appended after 1 existing permissions\.deny entry,/);
  const second = preview(batchDeny(['Edit(b)', 'Edit(c)']));
  assert.match(second, /appended after 3 existing permissions\.deny entries,/);
  assert.deepEqual(second.split('\n').filter(l => l.startsWith('+"')), ['+"Edit(c)"'], 'and does not offer again a rule the first adds');
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), OWNERS_SETTINGS, 'a preview writes nothing');
});

test('the second hook preview on one event counts the entry the first would add', () => {
  const d = repoWithSettings();
  const preview = diffRenderer(d);
  assert.doesNotMatch(preview(batchHook('Stop')), /appended after/);
  assert.match(preview({ ...batchHook('Stop'), matcher: 'Bash' }), /appended after 1 existing hooks\.Stop entry,/);
  assert.doesNotMatch(renderDiff(d, batchHook('Stop')), /appended after/, 'a preview on its own starts from the file');
});

// --- A replacement swaps the registrations apply recorded for another -------

const gate = { hooks: [execEntry(TOOL_GATE_PATH)] };
const log = { hooks: [execEntry(SESSION_LOG_PATH)] };
const theirs = { hooks: [{ type: 'command', command: 'node my-own.mjs' }] };
const ENTRY_BYTES = 'the entry script\n';
const replace = {
  kind: 'settings-hook-replace', event: 'PreToolUse', step: 30, checkId: 'P0.hookmerge', reason: 'r',
  entry: execEntry(DISPATCH_PRE_PATH),
  remove: [matcherEntrySha256(gate), matcherEntrySha256(log)],
  requiresFiles: [{ path: DISPATCH_PRE_PATH, sha256: sha256(ENTRY_BYTES) }],
};
const kitRecord = (script, step, checkId) => ({
  event: 'PreToolUse', container: '/hooks/PreToolUse', entrySha256: hookEntrySha256(execEntry(script)), step, checkId, appliedAt: '2026-11-01T00:00:00.000Z',
});

/** A repository whose settings hold the two kit hooks on PreToolUse
 * separately, with one of the owner's between them, and the entry script
 * on disk; and the manifest recording the two kit patches. */
function separatelyRegistered() {
  const d = repo();
  mkdirSync(join(d, '.claude/scripts'), { recursive: true });
  writeFileSync(join(d, DISPATCH_PRE_PATH), ENTRY_BYTES);
  writeFileSync(join(d, SETTINGS_PATH), JSON.stringify({ hooks: { PreToolUse: [gate, theirs, log] } }, null, 2) + '\n');
  const manifest = { ...emptyManifest('0.2.0'), settingsPatches: [kitRecord(TOOL_GATE_PATH, 30, 'P5.toolgate'), kitRecord(SESSION_LOG_PATH, 31, 'P5.sessionlog')] };
  return { d, manifest };
}

test('a replacement removes the recorded registrations, adds the entry script and swaps the records', () => {
  const { d, manifest } = separatelyRegistered();
  const r = applyProposals({ root: d, proposals: [replace], manifest, kitVersion: '0.2.0' });
  assert.deepEqual(readSettings(d).hooks.PreToolUse, [theirs, { hooks: [execEntry(DISPATCH_PRE_PATH)] }]);
  assert.deepEqual(r.patched, [{ event: 'PreToolUse', step: 30, checkId: 'P0.hookmerge', replaced: 2 }]);
  assert.deepEqual(r.manifest.settingsPatches.map(p => p.entrySha256), [hookEntrySha256(execEntry(DISPATCH_PRE_PATH))]);
  assert.deepEqual(Object.keys(r.manifest.settingsPatches[0]), ['event', 'container', 'entrySha256', 'step', 'checkId', 'appliedAt']);
});

test('the manifest written before the settings file still records the registrations about to be removed', () => {
  const { d, manifest } = separatelyRegistered();
  let persisted;
  applyProposals({ root: d, proposals: [replace], manifest, kitVersion: '0.2.0', persistManifest: m => { persisted = structuredClone(m); } });
  assert.equal(persisted.settingsPatches.length, 3);
});

test('a settings write that fails during a replacement leaves the manifest\'s records as they were', () => {
  const { d, manifest } = separatelyRegistered();
  const r = applyProposals({ root: d, proposals: [replace], manifest, kitVersion: '0.2.0', replaceSettings: () => { throw new Error('disk full'); } });
  assert.deepEqual(r.manifest.settingsPatches, manifest.settingsPatches);
  assert.equal(r.failed.length, 1);
  assert.deepEqual(readSettings(d).hooks.PreToolUse, [gate, theirs, log]);
});

test('a replacement is skipped whole when a registration it names is not there as recorded, is already made, or lacks a file', () => {
  const skippedWhole = (d, manifest, why) => {
    const before = readFileSync(join(d, SETTINGS_PATH), 'utf8');
    const r = applyProposals({ root: d, proposals: [replace], manifest, kitVersion: '0.2.0' });
    assert.deepEqual(r.patched, []);
    assert.equal(r.skipped.length, 1);
    assert.deepEqual({ ...r.skipped[0], why: why(r.skipped[0].why) }, { path: SETTINGS_PATH, why: true, checkId: 'P0.hookmerge' });
    assert.equal(readFileSync(join(d, SETTINGS_PATH), 'utf8'), before, 'the file is unchanged');
    assert.deepEqual(r.manifest.settingsPatches, manifest.settingsPatches, 'the manifest is unchanged');
  };

  const edited = separatelyRegistered();
  writeFileSync(join(edited.d, SETTINGS_PATH), JSON.stringify({ hooks: { PreToolUse: [gate, theirs, { hooks: [{ ...execEntry(SESSION_LOG_PATH), timeout: 5 }] }] } }, null, 2) + '\n');
  skippedWhole(edited.d, edited.manifest, why => why === 'registration-changed');

  const made = separatelyRegistered();
  writeFileSync(join(made.d, SETTINGS_PATH), JSON.stringify({ hooks: { PreToolUse: [gate, theirs, log, { hooks: [execEntry(DISPATCH_PRE_PATH)] }] } }, null, 2) + '\n');
  skippedWhole(made.d, made.manifest, why => why === 'unchanged');

  const lacking = separatelyRegistered();
  rmSync(join(lacking.d, DISPATCH_PRE_PATH));
  skippedWhole(lacking.d, lacking.manifest, why => why.startsWith('missing-dependency: '));
});

test('the preview of a replacement shows the elements removed and the one added, and nothing else of the file', () => {
  const { d, manifest } = separatelyRegistered();
  assert.equal(renderDiff(d, replace, manifest), [
    '--- a/.claude/settings.json', '+++ b/.claude/settings.json', '@@ hooks.PreToolUse @@',
    ...JSON.stringify(gate, null, 2).split('\n').map(l => `-${l}`),
    ...JSON.stringify(log, null, 2).split('\n').map(l => `-${l}`),
    ...JSON.stringify({ hooks: [execEntry(DISPATCH_PRE_PATH)] }, null, 2).split('\n').map(l => `+${l}`),
    '(1 other hooks.PreToolUse entry is left unchanged and not shown)',
    '(nothing else in .claude/settings.json is changed, or shown — it is yours, and it may hold credentials)',
  ].join('\n'));
  assert.doesNotMatch(renderDiff(d, replace, manifest), /my-own/);
});

test('the preview of a replacement whose registrations are not there as recorded says it would be skipped', () => {
  const { d, manifest } = separatelyRegistered();
  writeFileSync(join(d, SETTINGS_PATH), JSON.stringify({ hooks: { PreToolUse: [gate, theirs] } }, null, 2) + '\n');
  assert.equal(renderDiff(d, replace, manifest), [
    '--- a/.claude/settings.json', '+++ b/.claude/settings.json', '@@ hooks.PreToolUse @@',
    '(a registration kh-harness recorded on hooks.PreToolUse is no longer there as written — this replacement would be skipped)',
    '(nothing else in .claude/settings.json is changed, or shown — it is yours, and it may hold credentials)',
  ].join('\n'));
});

test('a replacement with no other entry on its event says nothing of other entries, and a later preview sees what it leaves', () => {
  const { d, manifest } = separatelyRegistered();
  writeFileSync(join(d, SETTINGS_PATH), JSON.stringify({ hooks: { PreToolUse: [log, gate] } }, null, 2) + '\n');
  const preview = diffRenderer(d, manifest);
  assert.doesNotMatch(preview(replace), /other hooks\.PreToolUse/);
  const later = { kind: 'settings-hook', event: 'PreToolUse', step: 31, checkId: 'x', reason: 'r', entry: { type: 'command', command: 'node', args: ['x.mjs'] } };
  assert.match(preview(later), /appended after 1 existing hooks\.PreToolUse entry,/);
});

/** Applies `proposal` to `d` and asserts it is skipped for `why`, with the
 * settings file and the manifest as they were, and that its preview prints
 * nothing of the owner's element. */
function refusedWhole(d, manifest, proposal, why) {
  const before = readFileSync(join(d, SETTINGS_PATH), 'utf8');
  const preview = renderDiff(d, proposal, manifest);
  assert.doesNotMatch(preview, /my-own/, 'the preview prints nothing of the owner\'s element');
  const r = applyProposals({ root: d, proposals: [proposal], manifest, kitVersion: '0.2.0' });
  assert.deepEqual(r.patched, []);
  assert.deepEqual(r.skipped, [{ path: SETTINGS_PATH, why, checkId: 'P0.hookmerge' }]);
  assert.equal(readFileSync(join(d, SETTINGS_PATH), 'utf8'), before, 'the file is byte for byte as it was');
  assert.deepEqual(r.manifest, manifest, 'the manifest is as it was');
  return preview;
}

test('a replacement naming an element the manifest does not record is skipped, and its preview prints nothing of it', () => {
  const { d, manifest } = separatelyRegistered();
  const preview = refusedWhole(d, manifest, { ...replace, remove: [matcherEntrySha256(theirs)] }, 'not-recorded');
  assert.equal(preview, [
    '--- a/.claude/settings.json', '+++ b/.claude/settings.json', '@@ hooks.PreToolUse @@',
    '(this replacement names a registration on hooks.PreToolUse that kh-harness did not record writing — it would be skipped)',
    '(nothing else in .claude/settings.json is changed, or shown — it is yours, and it may hold credentials)',
  ].join('\n'));
});

test('a replacement naming a recorded hash whose element runs no kit script is skipped, and its preview prints nothing of it', () => {
  const { d, manifest } = separatelyRegistered();
  const forged = { ...manifest, settingsPatches: [...manifest.settingsPatches, { ...kitRecord(TOOL_GATE_PATH, 30, 'P5.toolgate'), entrySha256: matcherEntrySha256(theirs) }] };
  refusedWhole(d, forged, { ...replace, remove: [matcherEntrySha256(gate), matcherEntrySha256(theirs)] }, 'not-recorded');
});

test('a replacement whose recorded element was edited to run the owner\'s script is skipped, and its preview prints nothing of it', () => {
  const { d, manifest } = separatelyRegistered();
  writeFileSync(join(d, SETTINGS_PATH), JSON.stringify({ hooks: { PreToolUse: [gate, { hooks: [{ type: 'command', command: 'node', args: ['my-own.mjs'] }] }] } }, null, 2) + '\n');
  refusedWhole(d, manifest, replace, 'registration-changed');
});

test('an entry added in the run after a replacement took out an element of the same hash keeps its record', () => {
  const { d, manifest } = separatelyRegistered();
  const readd = { kind: 'settings-hook', event: 'PreToolUse', step: 31, checkId: 'P5.sessionlog', reason: 'r', entry: execEntry(SESSION_LOG_PATH) };
  const r = applyProposals({ root: d, proposals: [replace, readd], manifest, kitVersion: '0.2.0' });
  assert.deepEqual(readSettings(d).hooks.PreToolUse, [theirs, { hooks: [execEntry(DISPATCH_PRE_PATH)] }, log]);
  assert.deepEqual(r.manifest.settingsPatches.map(p => p.entrySha256), [hookEntrySha256(execEntry(DISPATCH_PRE_PATH)), matcherEntrySha256(log)]);
});

test('an unknown proposal kind still throws before anything is written', () => {
  const { d, manifest } = separatelyRegistered();
  const before = readFileSync(join(d, SETTINGS_PATH), 'utf8');
  assert.throws(() => applyProposals({ root: d, proposals: [{ ...replace, kind: 'settings-hook-remove' }], manifest, kitVersion: '0.2.0' }), /unknown proposal kind/);
  assert.equal(readFileSync(join(d, SETTINGS_PATH), 'utf8'), before);
});

// --- A replacement killed at either side of the settings write --------------

/** An installed repository whose tool-call events hold the old separate
 * registrations, and the proposal that replaces PreToolUse's with the entry
 * script the install wrote, as `apply.mjs` would apply it. */
function installedSeparately() {
  const d = fixture();
  run(APPLY, d, '--yes');
  separateRegistrations(d);
  const recorded = manifestOf(d).settingsPatches.filter(p => p.event === 'PreToolUse').map(p => p.entrySha256);
  assert.equal(recorded.length, 2, 'fixture: two separate registrations recorded on PreToolUse');
  const proposal = {
    ...replace, remove: recorded,
    requiresFiles: [DISPATCH_PRE_PATH, TOOL_GATE_PATH, SESSION_LOG_PATH].map(path => ({ path, sha256: sha256(readFileSync(join(d, path), 'utf8')) })),
  };
  return { d, proposal };
}

const KILLED = 'the run was killed here';
const kitEntryScripts = d => Object.values(readSettings(d).hooks ?? {}).flat().flatMap(m => m.hooks ?? []).map(h => h.args?.[0] ?? h.command).filter(s => s.includes('.claude/scripts/'));

for (const point of ['before-settings', 'after-settings']) {
  test(`a replacement killed ${point} leaves every kit entry in the file recorded, and one uninstall removes the install`, () => {
    const { d, proposal } = installedSeparately();
    const manifestPath = join(d, MANIFEST_PATH);
    let onDiskAtKill = null;
    const r = applyProposals({
      root: d, proposals: [proposal], manifest: manifestOf(d), kitVersion: KIT_VERSION,
      persistManifest: staged => writeManifest(d, staged),
      replaceSettings: (path, text) => {
        if (point === 'after-settings') replaceFile(path, text);
        onDiskAtKill = readFileSync(manifestPath);
        throw new Error(KILLED);
      },
    });
    assert.deepEqual(r.failed.map(f => f.error), [`failed to write ${SETTINGS_PATH}: ${KILLED}`]);
    // The process is gone at the throw: the manifest is as it was then.
    writeFileSync(manifestPath, onDiskAtKill);

    const recorded = new Set(manifestOf(d).settingsPatches.map(p => p.entrySha256));
    const elements = Object.values(readSettings(d).hooks).flat().filter(m => m.hooks?.some(h => h.args?.[0]?.includes('.claude/scripts/')));
    for (const m of elements) assert.ok(recorded.has(matcherEntrySha256(m)), `${JSON.stringify(m)} is recorded`);
    const entryOnPre = readSettings(d).hooks.PreToolUse.some(m => matcherEntrySha256(m) === hookEntrySha256(execEntry(DISPATCH_PRE_PATH)));
    assert.equal(entryOnPre, point === 'after-settings', 'fixture: the entry script is in the file only after the kill point');
    for (const h of runEveryRegisteredHook(d)) assert.notEqual(h.status, 1, `${h.script} on ${h.event}: ${h.stderr}`);

    // The next apply, on a copy so uninstall below starts from the killed state.
    const again = mkdtempSync(join(tmpdir(), 'hk-apply-again-'));
    cpSync(d, again, { recursive: true });
    const killedSettings = readFileSync(join(again, SETTINGS_PATH), 'utf8');
    const next = applyProposals({ root: again, proposals: [proposal], manifest: manifestOf(again), kitVersion: KIT_VERSION });
    const dispatchSha = hookEntrySha256(execEntry(DISPATCH_PRE_PATH));
    const preRecords = next.manifest.settingsPatches.filter(p => p.event === 'PreToolUse').map(p => p.entrySha256).sort();
    if (point === 'before-settings') {
      assert.deepEqual(next.patched, [{ event: 'PreToolUse', step: 30, checkId: 'P0.hookmerge', replaced: 2 }], 'the next apply completes the replacement');
      assert.deepEqual(readSettings(again).hooks.PreToolUse.map(matcherEntrySha256), [dispatchSha]);
      assert.deepEqual(preRecords, [dispatchSha], 'one record, of the entry script; the records of the removed registrations are gone');
    } else {
      assert.deepEqual([next.patched, next.skipped], [[], [{ path: SETTINGS_PATH, why: 'unchanged', checkId: 'P0.hookmerge' }]]);
      assert.equal(readFileSync(join(again, SETTINGS_PATH), 'utf8'), killedSettings, 'the file is unchanged');
      assert.deepEqual(preRecords, [...proposal.remove, dispatchSha].sort(),
        'the records of the two removed registrations stay, with no entry in the file, beside the entry script\'s');
    }
    rmSync(again, { recursive: true, force: true });

    const uninstalled = runResult(UNINSTALL, d, '--yes');
    assert.equal(uninstalled.status, 0, uninstalled.stdout + uninstalled.stderr);
    assert.deepEqual(kitEntryScripts(d), [], 'no kit hook entry is left registered');
    assert.equal(existsSync(manifestPath), false, 'the manifest is removed');
    assert.deepEqual(readSettings(d).permissions?.deny, ['Edit(secrets/**)'], "the owner's own rule is as it was");
  });
}
