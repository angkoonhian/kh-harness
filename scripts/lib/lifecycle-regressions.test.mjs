// scripts/lib/lifecycle-regressions.test.mjs — regressions pinned by review
// findings (gitignored .claude/, forged manifests, F2, F9, Task 9b).
// See lifecycle.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256, emptyManifest } from './manifest.mjs';
import { GENERATORS } from './propose.mjs';
import { DETECT, APPLY, UNINSTALL, git, run, settings, manifestOf, fixture, workspaceFixture, freshFixtureNoClaudeDir, linesAfter } from './lifecycle-fixtures.mjs';

test('a repository that gitignores .claude/ still recognises its own hook as declared after apply (Task 8b Major)', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-gitignore-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  writeFileSync(join(d, '.gitignore'), '.claude/\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, '.claude/scripts/session-brief.mjs')), 'the script is genuinely written to disk');

  const after = JSON.parse(run(DETECT, d, '--json'));
  // Fixture sanity: .claude/ really is invisible to the scan the OLD
  // (defective) code relied on — otherwise this test could pass for a
  // reason unrelated to the fix.
  assert.equal(after.harness.claudeDir.hookEvents.SessionStart[0], null,
    'fixture sanity: the scan-list resolution must genuinely fail to see our own script here');

  const c = after.checks.find(x => x.id === 'P4.sessionbrief');
  assert.equal(c.state, 'declared', 'our own hook must be recognised even though .claude/ is gitignored');
  assert.equal(c.proposal, null);

  // And it must not re-propose on every subsequent run either (the exact
  // "re-proposes on every run" symptom the coordinator described).
  //
  // Whole-branch review, F2: this used to read `run(APPLY, d)`, which
  // structurally CANNOT exhibit the symptom — `propose.mjs` never
  // re-proposes a file already in the manifest, so `apply` says "already
  // satisfies" whatever `detect` reports. Run verbatim against the
  // repository that actually had the defect, this assertion passed. The
  // symptom lives in DETECT's output, so that is what it reads now, and
  // both commands are asserted so a future divergence between them is a
  // failure rather than a thing a reader has to notice.
  const second = JSON.parse(run(DETECT, d, '--json'));
  const stillProposing = second.checks.filter(c => c.proposal && c.id in GENERATORS).map(c => c.id);
  assert.deepEqual(stillProposing, [],
    `detect must stop proposing anything apply can write: ${JSON.stringify(stillProposing)}`);
  assert.match(run(APPLY, d), /no proposals|already satisfies/i);
});

// Whole-branch review, F2 — the missing fixture, and the reason the defect
// survived 647 passing tests: WORKSPACE was tested (LOAD-BEARING-2) and
// gitignored-`.claude/` was tested (immediately above, on a single-package
// fixture where P1.pathrules is not decidable at all), and the defect lived
// only in their INTERSECTION. `P1.pathrules` answered presence from the scan
// list, so on this repository shape `detect` said `absent → scaffold
// .claude/rules/` on every run forever while `apply`, a second later on the
// same tree, said "already satisfies every applicable step" — two commands
// of one tool contradicting each other about the same repository.
test('F2: a WORKSPACE that gitignores .claude/ — detect and apply agree about P1.pathrules after apply', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-ws-gitignore-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'app', workspaces: ['packages/*'], scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' },
  }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  writeFileSync(join(d, '.gitignore'), '.claude/\n');
  mkdirSync(join(d, 'packages/api'), { recursive: true });
  writeFileSync(join(d, 'packages/api/package.json'), JSON.stringify({ name: '@app/api', scripts: {} }));
  writeFileSync(join(d, 'packages/api/index.ts'), 'export const ok = true;\n');
  mkdirSync(join(d, 'packages/web'), { recursive: true });
  writeFileSync(join(d, 'packages/web/package.json'), JSON.stringify({ name: '@app/web', scripts: {} }));
  writeFileSync(join(d, 'packages/web/index.ts'), 'export const ok = true;\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  // Stage 1: genuinely absent, and genuinely proposed.
  const before = JSON.parse(run(DETECT, d, '--json'));
  const pr0 = before.checks.find(c => c.id === 'P1.pathrules');
  assert.equal(pr0.state, 'absent', 'fixture sanity: a two-package workspace with no rules yet');
  assert.ok(pr0.proposal);

  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, '.claude/rules/packages-api.md')), 'the scaffold is genuinely written to disk');
  assert.ok(existsSync(join(d, '.claude/rules/packages-web.md')));

  // Fixture sanity: `.claude/` really is invisible to the scan list, which
  // is what made the old scan-list read permanently empty here. Without
  // this, the test could pass for a reason unrelated to the fix.
  const after = JSON.parse(run(DETECT, d, '--json'));
  assert.deepEqual(after.harness.claudeDir.hooks, [],
    'fixture sanity: .claude/ must be invisible to the file scan for this test to mean anything');

  const pr1 = after.checks.find(c => c.id === 'P1.pathrules');
  assert.equal(pr1.state, 'declared', 'detect must see the rule files apply just wrote');
  assert.equal(pr1.proposal, null, 'an unsatisfiable proposal must never be printed again');
  // Counted and disclosed, never named — the files are gitignored.
  assert.equal(pr1.evidence.length, 1);
  assert.match(pr1.evidence[0], /2 rule files under \.claude\/rules\//);
  assert.equal(pr1.evidence[0].includes('packages-api'), false);

  // The whole point: the two commands now say the same thing about every
  // capability apply is able to write.
  const stillProposing = after.checks.filter(c => c.proposal && c.id in GENERATORS).map(c => c.id);
  assert.deepEqual(stillProposing, [],
    `detect must stop proposing anything apply can write: ${JSON.stringify(stillProposing)}`);
  assert.match(run(APPLY, d), /no actions|already satisfies/i);
});

// Whole-branch review, F2, second half: `under(files, '.claude/rules/')`
// passed no suffix, so ANY file under `.claude/rules/` credited the
// capability. Claude Code reads only `.md` there.
test('F2: a stray non-markdown file under .claude/rules/ does not credit P1.pathrules', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-rules-stray-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', workspaces: ['packages/*'], scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, 'packages/api'), { recursive: true });
  writeFileSync(join(d, 'packages/api/package.json'), JSON.stringify({ name: '@app/api', scripts: {} }));
  writeFileSync(join(d, 'packages/api/index.ts'), 'export const ok = true;\n');
  mkdirSync(join(d, '.claude/rules'), { recursive: true });
  writeFileSync(join(d, '.claude/rules/.gitkeep'), '');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const c = JSON.parse(run(DETECT, d, '--json')).checks.find(x => x.id === 'P1.pathrules');
  assert.equal(c.state, 'absent', 'a .gitkeep is not a rule Claude Code will ever read');
  assert.ok(c.proposal);
});

// Coordinator finding (CRITICAL): a forged manifest entry
// {"path":"CLAUDE.md","sha256":<the file's real hash>} made `classify`
// return `ours-unmodified` for the user's own, hand-written CLAUDE.md —
// the hash check only proves content matches what the manifest CLAIMS,
// never that kh-harness wrote it — and uninstall deleted it. The
// manifest is a file in the repository; anyone with write access
// (a contributor, a dependency's postinstall script, a crafted repo, or
// an agent mid-session) can add an entry like this. CLAUDE.md is inside
// apply-lib.mjs's write allowlist, so that gate does not help. Two
// independent fixes guard this now (see uninstall-lib.mjs's own comment
// on `isGeneratorProducible` and `carriesOurStamp` for why both are kept):
// CLAUDE.md is never a path any generator produces (P1.instructions is
// prompt-gated), AND even if it were, the user's own file does not carry
// the `Generated by kh-harness` stamp every real generator writes.
test('a forged manifest entry for CLAUDE.md does not delete it — kept, with a reason (Task 8b CRITICAL finding)', () => {
  const d = fixture();
  // The user's own, real, hand-written CLAUDE.md — never written by this
  // tool, and never proposed by any generator (P1.instructions has none).
  writeFileSync(join(d, 'CLAUDE.md'), '# My own instructions\nDo not touch this file.\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add my own CLAUDE.md');

  // The forgery: the file's own REAL hash, recorded as if kh-harness had
  // written it — exactly what an attacker with repository write access
  // (or a buggy, unrelated tool) could produce without needing to touch
  // CLAUDE.md's content at all.
  const realHash = sha256(readFileSync(join(d, 'CLAUDE.md')));
  const manifest = emptyManifest('0.1.0');
  manifest.files.push({ path: 'CLAUDE.md', sha256: realHash, step: 6, writtenAt: new Date().toISOString() });
  writeFileSync(join(d, '.claude/kh-harness.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const out = run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, 'CLAUDE.md')), true, 'CLAUDE.md must survive a forged manifest entry');
  assert.equal(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), '# My own instructions\nDo not touch this file.\n',
    'byte-for-byte untouched, not merely "still exists"');
  assert.doesNotMatch(out, /Removed:[^]*CLAUDE\.md/, 'must never be listed under Removed:');
  assert.match(out, /CLAUDE\.md/, 'the user must be told it was considered and kept');
  assert.match(out, /outside-allowlist|not-generator-producible/, 'and told why — a structural reason: this path is on no allowlist and is never one any generator writes');
});

// Coordinator finding (Major — a false `declared` introduced by the
// finding-1 fix above): the manifest+existsSync branch used to gate on
// `scripts.length > 0` — the event being OCCUPIED by anything — not on
// whether the occupant could plausibly be ours. A user who REPLACES our
// hook entry with their own, unrelated one (which resolves to a real,
// different, tracked file) gets a POSITIVE answer that it is not ours —
// yet our old script file is still sitting on disk (apply never cleans it
// up on its own) and the manifest still records the old install, so the
// old gate fired anyway. Through the real CLI, exactly as asked.
test('a user who replaces our hook with their own is told it is absent again, not falsely declared (Task 8b false-declared finding)', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, '.claude/scripts/session-brief.mjs')), 'our script is genuinely on disk');
  assert.equal(settings(d).hooks.SessionStart.length, 1);

  // The user replaces OUR hook entry with their own, unrelated automation
  // — a real, tracked file, not a typo or a gitignored one.
  writeFileSync(join(d, 'tools-their-replacement.mjs'), '// the user\'s own replacement\n');
  const s = settings(d);
  s.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'node tools-their-replacement.mjs' }] }];
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'the user swaps in their own SessionStart hook');

  const r = JSON.parse(run(DETECT, d, '--json'));
  // Fixture sanity: the replacement really does resolve to a real path —
  // this must be a POSITIVE identification of someone else's hook, not an
  // unresolvable one, or this test would not isolate the regression.
  assert.equal(r.harness.claudeDir.hookEvents.SessionStart[0], 'tools-their-replacement.mjs');

  const c = r.checks.find(x => x.id === 'P4.sessionbrief');
  assert.equal(c.state, 'absent', 'a hook that positively resolves to someone else\'s script must never be credited as ours');
  assert.ok(c.proposal, 'apply must re-propose, not stay silent because the event looks occupied');
  assert.ok(c.evidence.some(e => e.includes('tools-their-replacement.mjs')));
});


// --- Task 9b, finding 7: "proposals" must not count two different things
// under the same word in the same workflow.

test('apply names its own count "actions" and discloses the capability-gap count detect would report, rather than reusing "proposals" for both (Task 9b finding 7)', () => {
  const d = fixture();
  const detected = JSON.parse(run(DETECT, d, '--json'));
  const gapCount = detected.checks.filter(c => c.proposal).length;

  const out = run(APPLY, d);
  assert.doesNotMatch(out, /\d+ proposals? for/, 'apply must not reuse the word "proposals" for its own, larger count');
  assert.match(out, /\d+ actions? to close/, 'apply must name its own count differently');
  assert.match(out, new RegExp(`${gapCount} capability gap`), 'the gap count named here must be the SAME number detect itself reports');
});

// --- Whole-branch review, F9 ----------------------------------------------
//
// `apply` runs `listFiles`, `detectStack`, `detectHarness`, `detectExposures`
// and `buildGaps` — the same work `detect` does — and printed only proposals
// and diffs. So a user who runs `apply --yes` without first running `detect`
// was never told about a live token THIS RUN had just found, the nested
// repositories it did not descend into, or any of the questions it could not
// answer. Through the real CLI, and on the DRY RUN path too, since that is
// the one a cautious user reaches for first.
test('F9: apply discloses the credential finding, the nested repository and the question count it computed', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-f9-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  mkdirSync(join(d, 'src'), { recursive: true });
  // A token this run genuinely finds, in a file the scan genuinely lists.
  // Assembled, not written — see this file's header on concern 5.
  const LEAKED_PAT = 'ghp_' + '0123456789abcdefghij0123456789';
  writeFileSync(join(d, 'src/creds.ts'), `export const T = "${LEAKED_PAT}";\n`);
  // A nested repository the scan genuinely declines to descend into, found
  // through the gitignored-directory sweep (gitignoring a vendor tree is
  // also what keeps `git add -A` from refusing an embedded repository).
  writeFileSync(join(d, '.gitignore'), 'vendor/\n');
  mkdirSync(join(d, 'vendor/libx'), { recursive: true });
  execFileSync('git', ['init', '-q', join(d, 'vendor/libx')]);
  writeFileSync(join(d, 'vendor/libx/a.txt'), 'hi\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const dry = run(APPLY, d);

  // 1. The credential sweep it performed and used to discard.
  assert.match(dry, /same Phase-0 credential sweep/);
  assert.match(dry, /token-in-repo-file at src\/creds\.ts/);
  assert.equal(dry.includes(LEAKED_PAT), false, 'the VALUE is still never printed');

  // 2. The nested repository. `detect`'s own comment calls this disclosure
  //    load-bearing because "a report that omits it makes a partial scan
  //    look complete" — which is at least as true of a run about to write.
  assert.match(dry, /vendor\/libx/);
  assert.match(dry, /NOT scanned/);

  // 3. The questions, derived by the same function detect uses, printed
  //    inline (audit Tier 4, finding 20: a pointer to detect sent the user
  //    to another command for a sentence apply already held).
  assert.match(dry, /questions? this run could not answer:/);
  assert.match(dry, /^  - /m);

  // And it still does its actual job afterwards.
  assert.match(dry, /Dry run — nothing written/);

  // The same disclosure reaches the --yes path, which is the one that writes.
  assert.match(run(APPLY, d, '--yes'), /token-in-repo-file at src\/creds\.ts/);
});

test('F9: apply says nothing extra about a clean repository', () => {
  const d = fixture();
  const out = run(APPLY, d);
  assert.equal(out.includes('credential sweep'), false, 'no finding, no sentence');
  assert.equal(out.includes('NOT scanned'), false);
});

