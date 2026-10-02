// scripts/lib/lifecycle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DETECT = resolve(import.meta.dirname, '..', 'detect.mjs');
const APPLY = resolve(import.meta.dirname, '..', 'apply.mjs');
const UNINSTALL = resolve(import.meta.dirname, '..', 'uninstall.mjs');

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const run = (script, d, ...a) => execFileSync(process.execPath, [script, d, ...a], { encoding: 'utf8' });
const settings = d => JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  // The user's own setting, which must survive every stage.
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }, null, 2));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');   // not a default branch
  // P4.remote must already be satisfied — this test's stage-4 assertion
  // sweeps every P4.* check, not just the two apply actually writes, and
  // apply.mjs has no generator for P4.remote (adding a remote is not
  // something the tool can do on a user's behalf). Without one, that check
  // would stay 'absent' with a proposal forever, for a reason unrelated to
  // what this test is about.
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

test('LOAD-BEARING: detect -> apply -> no-op -> user edit -> drift -> uninstall', () => {
  const d = fixture();

  // 1. detect reports both continuity capabilities absent
  const before = JSON.parse(run(DETECT, d, '--json'));
  const idState = id => before.checks.find(c => c.id === id).state;
  assert.equal(idState('P4.handoff'), 'absent');
  assert.equal(idState('P4.sessionbrief'), 'absent');

  // 2. apply without --yes is a dry run: it shows and writes nothing
  const dry = run(APPLY, d);
  assert.match(dry, /HANDOFF\.md/);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'the default must never write');

  // 3. apply --yes writes both files and registers the hook
  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, 'HANDOFF.md')));
  assert.ok(existsSync(join(d, '.claude/scripts/session-brief.mjs')));
  assert.equal(settings(d).hooks.SessionStart.length, 1);
  assert.deepEqual(settings(d).permissions, { deny: ['Edit(secrets/**)'] }, 'their settings survive apply');

  // 4. THE CLOSED LOOP: what we wrote, we now recognise as present
  const after = JSON.parse(run(DETECT, d, '--json'));
  const afterState = id => after.checks.find(c => c.id === id).state;
  assert.equal(afterState('P4.handoff'), 'declared');
  assert.equal(afterState('P4.sessionbrief'), 'declared');
  assert.equal(after.checks.filter(c => c.id.startsWith('P4.') && c.proposal).length, 0);

  // apply just patched the tracked .claude/settings.json without committing
  // it — exactly what a real user does next: review the diff, then commit.
  // (HANDOFF.md and the session-brief script are new, untracked files;
  // `commit -a` only stages modifications to files already tracked, so they
  // are deliberately left alone here — the point of this commit is only to
  // clear the one pre-existing tracked file apply touched.)
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-a', '-q', '-m', 'accept harness-kit settings patch');

  // 5. applying again changes nothing
  const handoffHash = readFileSync(join(d, 'HANDOFF.md'), 'utf8');
  run(APPLY, d, '--yes');
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), handoffHash);
  assert.equal(settings(d).hooks.SessionStart.length, 1, 'no duplicate hook');

  // 6. the user edits what we wrote
  writeFileSync(join(d, 'HANDOFF.md'), '# My own handoff\nMid-refactor.\n');

  // 7. apply reports the drift and leaves the edit alone
  const drift = run(APPLY, d, '--yes');
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), '# My own handoff\nMid-refactor.\n');
  assert.match(drift, /HANDOFF\.md/);
  assert.match(drift, /modified|kept|skipped/i, 'drift must be reported, not silent');

  // 8. uninstall removes what is untouched, keeps the edit, reverts the hook
  const out = run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, '.claude/scripts/session-brief.mjs')), false);
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), '# My own handoff\nMid-refactor.\n');
  assert.match(out, /HANDOFF\.md/, 'must say what it left behind');
  assert.equal(settings(d).hooks, undefined, 'our hook is gone');

  // 9. the user's own settings are byte-identical to where they started
  assert.deepEqual(settings(d).permissions, { deny: ['Edit(secrets/**)'] });
});

test('STOPGATE: apply installs verify-touched.mjs, the shared redaction asset, and a matcher-less Stop hook; uninstall removes all three', () => {
  // fixture() declares a `test` script and no existing Stop hook, so
  // P2.stopgate is absent and decidable — and, unlike the LOAD-BEARING test
  // above, this fixture has no `lint` script, so P2.sensor never fires.
  // That isolates this test to P2.stopgate's OWN responsibility for
  // installing (and, on uninstall, removing) the shared redaction asset —
  // see task-4 ruling 3: a shared module that apply installs but uninstall
  // leaves behind is a defect in its own right, not merely untested.
  const d = fixture();

  const before = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(before.checks.find(c => c.id === 'P2.stopgate').state, 'absent');

  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, '.claude/scripts/verify-touched.mjs')), 'the Stop gate script is installed');
  assert.ok(existsSync(join(d, '.claude/scripts/harness-redact.mjs')), 'the shared redaction asset is installed');
  const stopHooks = settings(d).hooks.Stop;
  assert.equal(stopHooks.length, 1);
  assert.equal(stopHooks[0].matcher, undefined, 'the Stop entry takes no matcher');
  assert.equal(stopHooks[0].hooks[0].command, 'node .claude/scripts/verify-touched.mjs');

  const after = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(after.checks.find(c => c.id === 'P2.stopgate').state, 'declared');

  run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, '.claude/scripts/verify-touched.mjs')), false, 'the Stop gate script is removed');
  assert.equal(existsSync(join(d, '.claude/scripts/harness-redact.mjs')), false,
    'the shared redaction asset is removed too, not left behind — the install/uninstall asymmetry this ruling exists to prevent');
  assert.equal(settings(d).hooks, undefined, 'the Stop hook is reverted');
});

test('C2: a secret anywhere in settings.json reaches no part of a dry run\'s output', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  // A credential in `env`, and a token inside a hook command for an event
  // this run has no business touching. detect-exposure already treats both
  // of these shapes as credential carriers.
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    env: { DEPLOY_TOKEN: 'glpat-SECRET-IN-ENV' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: "curl -H 'PRIVATE-TOKEN: ghp_SECRET_IN_HOOK' https://x.invalid" }] }],
    },
    permissions: { deny: ['Edit(secrets/**)'] },
  }, null, 2));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  // The default, with no --yes: the run a user gets without asking for one.
  const out = run(APPLY, d);
  assert.match(out, /SessionStart/, 'the settings proposal must still be previewed');
  assert.doesNotMatch(out, /SECRET-IN-ENV/, 'a credential in env must not reach stdout');
  assert.doesNotMatch(out, /SECRET_IN_HOOK/, 'a token in an unrelated hook command must not reach stdout');
});

test('C3: a manifest that cannot be written exits 2 with a readable message, never a stack trace', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  // No `test`/`typecheck` script here (deliberately): Task 4's P2.stopgate
  // generator would otherwise find evidence for a Stop-gate proposal and,
  // sorting before P4.handoff by step number (10 < 16), hit the
  // `.claude`-is-a-file write failure FIRST — before HANDOFF.md is ever
  // attempted — which is exactly the ordering this fixture must NOT have
  // (see the lockfile comment immediately below, which already documents
  // the same hazard for P2.protected).
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  // No lockfile here (deliberately, unlike the other fixtures in this file):
  // Task 2's P2.protected check would find evidence for a deny-rule
  // proposal and, sorting before P4.handoff by step number, hit the
  // `.claude`-is-a-file write failure FIRST — stopping the batch before
  // HANDOFF.md below is ever attempted. This test is about the
  // manifest-write failure path, not about which proposal happens to sort
  // first, so the fixture carries no protected path to propose over.
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  // `.claude` as a plain file. Every write beneath it fails, including the
  // `mkdirSync` inside writeManifest — the one write in the tool that must
  // not fail silently, because a file on disk with no manifest entry is a
  // file `uninstall` can never remove.
  writeFileSync(join(d, '.claude'), 'a plain file sitting where a directory needs to go\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  let err;
  try { run(APPLY, d, '--yes'); } catch (e) { err = e; }
  assert.ok(err, 'apply must not report success when it could not record what it wrote');
  assert.equal(err.status, 2, 'the CLI contract is exit 0, 2 or 3 — never 1, never a raw throw');

  const out = String(err.stdout ?? '') + String(err.stderr ?? '');
  // The cause (`EEXIST ... mkdir '<path>'`) belongs in the message. The Node
  // frames around it do not.
  assert.doesNotMatch(out, /node:internal\/|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /harness-kit\.manifest\.json/, 'the message must name the file it could not write');

  // The proposal that landed before the failure is on disk and untracked;
  // saying so is the difference between a recoverable repository and a trap.
  assert.equal(existsSync(join(d, 'HANDOFF.md')), true);
  assert.match(out, /HANDOFF\.md/, 'must name what is on disk but untracked');
});

test('C3b: with a lockfile present (the common real case), the settings-deny write fails FIRST and nothing is written at all — still exits 2 cleanly', () => {
  // Review finding: C3 above deliberately omits a lockfile so HANDOFF.md
  // (a 'file' proposal) lands before the failure, pinning "partial work is
  // reported". But virtually every real repository has a lockfile, which
  // makes P2.protected's settings-deny proposal the FIRST one attempted
  // (it sorts before P4.handoff by step number) — and that is the one that
  // fails here, so NOTHING is ever written. C3's "partial work" coverage
  // is real but now sits in the less common ordering; this test restores
  // coverage of the common ordering without reverting C3's fixture.
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  // No `test`/`typecheck` script (deliberately, same reason as C3 above):
  // Task 4's P2.stopgate sorts BEFORE P2.protected (step 10 < 11), and this
  // test is specifically about P2.protected's settings-deny write being the
  // first failure — a Stop-gate proposal here would shadow it by failing
  // first instead.
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  writeFileSync(join(d, '.claude'), 'a plain file sitting where a directory needs to go\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  let err;
  try { run(APPLY, d, '--yes'); } catch (e) { err = e; }
  assert.ok(err, 'apply must not report success when it could not record what it wrote');
  assert.equal(err.status, 2, 'the CLI contract is exit 0, 2 or 3 — never 1, never a raw throw');

  const out = String(err.stdout ?? '') + String(err.stderr ?? '');
  assert.doesNotMatch(out, /node:internal\/|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /\.claude[\\/]settings\.json/, 'the message must name the settings write that failed first in this ordering');

  // Nothing after the first failed write is ever attempted — the opposite
  // half of C3's "partial work" case, and the one real repos actually hit.
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'nothing written when the first proposal in the batch fails');
});

test('I3: a deleted settings file lets uninstall finish, clear the manifest, and exit 0', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  assert.equal(settings(d).hooks.SessionStart.length, 1);
  assert.equal(existsSync(join(d, '.claude/harness-kit.manifest.json')), true);

  // The user deletes their own settings file. No hook remains registered.
  rmSync(join(d, '.claude/settings.json'));

  const out = run(UNINSTALL, d, '--yes');               // throws on any non-zero exit
  assert.match(out, /absent/i, 'the reason must be stated, and distinguishable from unreadable');
  assert.doesNotMatch(out, /could not be read/i, 'there is no read failure here to report');
  assert.equal(existsSync(join(d, '.claude/harness-kit.manifest.json')), false,
    'the manifest must be cleared, or uninstall is impossible on every future run, forever');
});

test('I7: uninstall with no argument exits 2, never 1', () => {
  let err;
  try { execFileSync(process.execPath, [UNINSTALL], { encoding: 'utf8' }); } catch (e) { err = e; }
  assert.ok(err, 'a missing argument is still a refusal to act');
  assert.equal(err.status, 2, 'the CLI contract is exit 0, 2 or 3 — 1 means "the process crashed"');
  assert.match(String(err.stderr ?? ''), /usage/i, 'and it must say how to call it');
});

test('apply refuses on a default branch unless told otherwise', () => {
  const d = fixture();
  git(d, 'checkout', '-q', '-b', 'master');
  assert.throws(
    () => run(APPLY, d, '--yes'),
    e => e.status === 3 && /--allow-default-branch/.test(String(e.stderr ?? e.stdout)),
  );
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false);
  assert.doesNotThrow(() => run(APPLY, d, '--yes', '--allow-default-branch'));
});

test('apply refuses on a dirty working tree unless told otherwise', () => {
  const d = fixture();
  writeFileSync(join(d, 'package.json'), '{"name":"edited"}');
  assert.throws(() => run(APPLY, d, '--yes'), e => e.status === 3);
  assert.doesNotThrow(() => run(APPLY, d, '--yes', '--allow-dirty'));
});

test('C4: a malformed permissions.deny does not crash the DEFAULT (dry-run) apply path', () => {
  // Reproduces the exact live crash the review found: before the
  // readSettingsResult fix, `renderSettingsDenyDiff` called `addDenyRules`
  // unguarded on `permissions.deny`, so a dry run against a settings.json
  // with a non-array deny crashed with a raw TypeError and exit 1 — on the
  // DEFAULT path (no flag needed), which is the one a cautious user
  // reaches for first.
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: 'Edit(secrets/**)' } }));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const out = run(APPLY, d); // no --yes: the default dry run
  assert.doesNotMatch(out, /node:internal\/|TypeError|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /could not be parsed as a JSON object/, 'the malformed deny must be reported the same way as unparseable JSON');
});
