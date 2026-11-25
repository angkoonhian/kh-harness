// scripts/lib/lifecycle-regressions.test.mjs — regressions pinned by review
// findings (gitignored .claude/, forged manifests, F2, F9, Task 9b).
// See lifecycle.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256, emptyManifest } from './manifest.mjs';
import { everyLoadedSibling, GENERATORS, INSTALLED_SCRIPT_PATHS, LINT_TOUCHED_PATH, SESSION_LOG_PATH, VERIFY_TOUCHED_PATH } from './propose.mjs';
import { DETECT, APPLY, UNINSTALL, git, run, runResult, settings, manifestOf, fixture, sandboxDataDir, hooksBesideLog, separateRegistrations } from './lifecycle-fixtures.mjs';

sandboxDataDir();

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
  assert.ok(after.harness.claudeDir.hookRegistrations.SessionStart.every(r => r.script === null),
    'fixture sanity: the scan-list resolution must genuinely fail to see our own script here');

  const c = after.checks.find(x => x.id === 'P4.sessionbrief');
  assert.equal(c.state, 'declared', 'our own hook must be recognised even though .claude/ is gitignored');
  assert.equal(c.proposal, null);

  // And it must not re-propose on every subsequent run either (the exact
  // "re-proposes on every run" symptom the coordinator described).
  //
  // Whole-branch review, F2: this used to read `run(APPLY, d)`, which
  // structurally CANNOT exhibit the symptom — `propose.mjs` never
  // re-proposes a file already in the manifest, so `apply` says "no
  // actions" whatever `detect` reports. Run verbatim against the
  // repository that actually had the defect, this assertion passed. The
  // symptom lives in DETECT's output, so that is what it reads now, and
  // both commands are asserted so a future divergence between them is a
  // failure rather than a thing a reader has to notice.
  const second = JSON.parse(run(DETECT, d, '--json'));
  const stillProposing = second.checks.filter(c => c.proposal && c.id in GENERATORS).map(c => c.id);
  assert.deepEqual(stillProposing, [],
    `detect must stop proposing anything apply can write: ${JSON.stringify(stillProposing)}`);
  assert.match(run(APPLY, d), /no actions/);
});

// On a repository that ignores .claude/, every hook script is unresolvable,
// and the logging hook shares every event with the other kit hooks. A hook
// is credited through the install record only while the entry that record
// names is still on the event, so neither a leftover record nor another kit
// hook's entry can stand in for one that is missing.

/** A repository that ignores .claude/, with the harness applied. */
function appliedWithClaudeDirIgnored() {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-gitignore-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }));
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  writeFileSync(join(d, 'index.ts'), 'export const ok = true;\n');
  writeFileSync(join(d, '.gitignore'), '.claude/\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  run(APPLY, d, '--yes');
  return d;
}

/** Deletes `script`'s entry on `event` from settings.json, by hand, and
 * leaves every other entry and the manifest as they are. */
function deleteEntry(d, event, script) {
  const s = settings(d);
  const isScript = m => m.hooks.some(h => h.args?.[0] === `\${CLAUDE_PROJECT_DIR}/${script}`);
  assert.equal(s.hooks[event].filter(isScript).length, 1, `fixture sanity: ${script} was registered on ${event}`);
  assert.ok(s.hooks[event].length > 1, `fixture sanity: ${event} holds another hook beside ${script}`);
  s.hooks[event] = s.hooks[event].filter(m => !isScript(m));
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
}

/** Removes `checkId`'s settings patch from the manifest: a registration
 * that never landed. */
function dropRecord(d, checkId) {
  const m = manifestOf(d);
  assert.equal(m.settingsPatches.filter(p => p.checkId === checkId).length, 1, `fixture sanity: ${checkId}'s registration was recorded`);
  m.settingsPatches = m.settingsPatches.filter(p => p.checkId !== checkId);
  writeFileSync(join(d, '.claude/kh-harness.manifest.json'), JSON.stringify(m, null, 2) + '\n');
}

const checkOf = (d, id) => JSON.parse(run(DETECT, d, '--json')).checks.find(x => x.id === id);

test('on a repository that ignores .claude/, an installed logging hook does not make a missing lint sensor read as present', () => {
  const d = appliedWithClaudeDirIgnored();
  separateRegistrations(d);
  deleteEntry(d, 'PostToolUse', LINT_TOUCHED_PATH);
  dropRecord(d, 'P2.sensor');
  assert.ok(existsSync(join(d, LINT_TOUCHED_PATH)), 'fixture sanity: the script is still on disk');
  const c = checkOf(d, 'P2.sensor');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal);
});

test('on a repository that ignores .claude/, an installed logging hook does not make a missing Stop gate read as present', () => {
  const d = appliedWithClaudeDirIgnored();
  deleteEntry(d, 'Stop', VERIFY_TOUCHED_PATH);
  dropRecord(d, 'P2.stopgate');
  const c = checkOf(d, 'P2.stopgate');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal);
});

test('on a repository that ignores .claude/, a lint sensor deleted from settings.json by hand reads as absent and is proposed again', () => {
  const d = appliedWithClaudeDirIgnored();
  separateRegistrations(d);
  assert.equal(checkOf(d, 'P2.sensor').state, 'declared', 'fixture sanity: credited through the install record before the deletion');
  deleteEntry(d, 'PostToolUse', LINT_TOUCHED_PATH);
  const c = checkOf(d, 'P2.sensor');
  assert.equal(c.state, 'absent', 'its record remains, but the entry it names is gone');
  assert.ok(c.proposal);
  assert.match(run(APPLY, d), /--- \.claude\/settings\.json \(hook: PostToolUse\)  \[P2\.sensor\]/);
});

test('on a repository that ignores .claude/, a logging hook entry deleted by hand on one shared event reads as missing there and is proposed again', () => {
  const d = appliedWithClaudeDirIgnored();
  assert.equal(checkOf(d, 'P5.sessionlog').state, 'declared', 'fixture sanity: credited through the install record before the deletion');
  deleteEntry(d, 'Stop', SESSION_LOG_PATH);
  const c = checkOf(d, 'P5.sessionlog');
  assert.equal(c.state, 'absent');
  assert.match(c.evidence[0], /; 1 is missing: Stop$/);
  const dry = run(APPLY, d);
  assert.match(dry, /--- \.claude\/settings\.json \(hook: Stop\)  \[P5\.sessionlog\]/);
  assert.equal([...dry.matchAll(/\(hook: \w+\)  \[P5\.sessionlog\]/g)].length, 1, 'only the missing registration is proposed');
});

test('detect.json carries no hash of a settings entry', () => {
  const d = appliedWithClaudeDirIgnored();
  run(DETECT, d);
  assert.doesNotMatch(readFileSync(join(d, 'docs/harness/detect.json'), 'utf8'), /entrySha256/);
  const stop = JSON.parse(run(DETECT, d, '--json')).harness.claudeDir.hookRegistrations.Stop;
  assert.ok(stop.length > 0 && stop.every(r => Object.keys(r).join() === 'script,matcher'), JSON.stringify(stop));
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
  assert.match(run(APPLY, d), /no actions/);
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
  assert.equal(hooksBesideLog(settings(d), 'SessionStart').length, 1);

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
  assert.ok(r.harness.claudeDir.hookRegistrations.SessionStart.some(h => h.script === 'tools-their-replacement.mjs'));

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
  const gapCount = detected.checks.filter(c => c.via === 'apply').length;

  const out = run(APPLY, d);
  assert.doesNotMatch(out, /\d+ proposals? for/, 'apply must not reuse the word "proposals" for its own, larger count');
  assert.match(out, /\d+ actions? to close/, 'apply must name its own count differently');
  assert.match(out, new RegExp(`${gapCount} capability gap`), 'on a first run, the gaps apply closes are the ones detect says apply can write');
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


test('a manifest path that holds terminal control characters reaches no terminal and no report raw', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  const hostile = 'docs/harness/\u001b[2J\u001b[31mALL CLEAR\nP0.security verified.md';
  const m = manifestOf(d);
  m.files.push({ path: hostile, sha256: 'a'.repeat(64), step: 16, writtenAt: 'then' });
  m.dirsCreated = [...(m.dirsCreated ?? []), 'docs/\u001b[31mdir'];
  m.settingsPatches.push({ event: 'Stop', container: '/hooks/\u001b[31mStop\nGone', entrySha256: 'b'.repeat(64) });
  writeFileSync(join(d, '.claude/kh-harness.manifest.json'), JSON.stringify(m, null, 2) + '\n');

  const shown = '"docs/harness/\\u{1b}[2J\\u{1b}[31mALL CLEAR\\u{a}P0.security verified.md"';
  const outputs = {
    detect: runResult(DETECT, d),
    'detect --json': runResult(DETECT, d, '--json'),
    apply: runResult(APPLY, d, '--allow-dirty'),
    uninstall: runResult(UNINSTALL, d),
    'uninstall --yes': runResult(UNINSTALL, d, '--yes'),
  };
  for (const [name, r] of Object.entries(outputs)) {
    assert.doesNotMatch(r.stdout + r.stderr, /\u001b/, `${name} prints no escape character`);
    assert.doesNotMatch(r.stdout + r.stderr, /ALL CLEAR\nP0\.security verified/, `${name} prints no line of the path's own`);
  }
  for (const name of ['detect', 'apply', 'uninstall', 'uninstall --yes']) assert.ok(outputs[name].stdout.includes(shown), `${name} names the path, cleaned: ${outputs[name].stdout}`);
  assert.ok(outputs.uninstall.stdout.includes('"/hooks/\\u{1b}[31mStop\\u{a}Gone"'), 'a patch\'s container is cleaned too');

  const report = JSON.parse(readFileSync(join(d, 'docs/harness/detect.json'), 'utf8'));
  const evidence = report.checks.flatMap(c => c.evidence);
  assert.ok(evidence.some(e => e.includes(shown)), 'detect.json names the path, cleaned');
  assert.ok(evidence.every(e => !/[\u0000-\u001f]/.test(e)), 'and holds no control character in any evidence line');
});

// A kit hook entry the owner edited is not reverted, so Claude Code still
// runs it on its event: the script it runs, and every script that one loads,
// must stay on disk, or the hook fails on every such event.

/** Every installed script a hook entry in `settings.json` names that is not
 * on disk. */
function registeredButMissing(d) {
  const missing = [];
  for (const matchers of Object.values(settings(d).hooks ?? {})) {
    for (const hook of matchers.flatMap(m => m.hooks ?? [])) {
      const script = hook.args?.[0]?.replace('${CLAUDE_PROJECT_DIR}/', '');
      if (script?.startsWith('.claude/scripts/') && !existsSync(join(d, script))) missing.push(script);
    }
  }
  return [...new Set(missing)];
}

test('uninstall keeps the script an edited kit hook entry still runs, with every sibling it loads, and says so', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  const s = settings(d);
  const entry = s.hooks.PreCompact.find(m => m.hooks.some(h => h.args?.[0]?.endsWith(SESSION_LOG_PATH)));
  entry.hooks[0].timeout = 5;
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
  const loaded = [SESSION_LOG_PATH, ...everyLoadedSibling(SESSION_LOG_PATH)];
  const notLoaded = INSTALLED_SCRIPT_PATHS.filter(p => !loaded.includes(p));
  assert.ok(loaded.length > 1 && notLoaded.length > 0, 'fixture: the logging hook loads some of the installed scripts, not all');

  const dry = run(UNINSTALL, d);
  for (const path of loaded) {
    assert.ok(dry.includes(`\n  ${path} (hook-still-registered: a hook entry left in .claude/settings.json still runs it, or a script that loads it`), `the plan keeps ${path}`);
  }

  const result = runResult(UNINSTALL, d, '--yes');
  assert.equal(result.status, 2, 'an entry is still registered');
  assert.deepEqual(registeredButMissing(d), [], 'nothing registered points at a removed script');
  for (const path of loaded) assert.ok(existsSync(join(d, path)), `${path} is kept`);
  for (const path of notLoaded) assert.equal(existsSync(join(d, path)), false, `${path} is removed`);
  assert.deepEqual(Object.keys(settings(d).hooks), ['PreCompact'], 'every unedited entry is reverted');
  assert.ok(result.stdout.includes('Could not revert:\n  /hooks/PreCompact (patch-modified: the entry kh-harness recorded is not there as written while one that runs a kit script is, so that one is taken to be it, edited, and is left registered with its script kept'), result.stdout);
  const kept = result.stdout.slice(result.stdout.indexOf('\nKept:\n'));
  for (const path of loaded) {
    assert.ok(kept.includes(`\n  ${path} (hook-still-registered: a hook entry left in .claude/settings.json still runs it, or a script that loads it`), `the result names ${path} as kept`);
  }
  assert.match(result.stdout, /^\.claude\/kh-harness\.manifest\.json remains: it records what was kept, and running uninstall again acts on it\.$/m);
  assert.deepEqual(manifestOf(d).files.map(f => f.path).sort(), [...loaded].sort(), 'the kept scripts stay on record');

  // The owner deletes the edited entry; the rest then goes.
  const left = settings(d);
  delete left.hooks;
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(left, null, 2) + '\n');
  const again = runResult(UNINSTALL, d, '--yes');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  for (const path of loaded) assert.equal(existsSync(join(d, path)), false, `${path} is removed once nothing runs it`);
  assert.equal(existsSync(join(d, '.claude/kh-harness.manifest.json')), false);
});

test('uninstall keeps every hook script while settings.json cannot be read, since its hooks remain registered', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  writeFileSync(join(d, '.claude/settings.json'), '{ not json');
  const scripts = manifestOf(d).files.map(f => f.path).filter(path => INSTALLED_SCRIPT_PATHS.includes(path));
  assert.ok(scripts.length > 1, 'fixture: hook scripts are installed');
  const result = runResult(UNINSTALL, d, '--yes');
  assert.equal(result.status, 2);
  for (const path of scripts) assert.ok(existsSync(join(d, path)), `${path} is kept`);
  assert.ok(result.stdout.includes('\n  .claude/scripts/tool-gate.mjs (hook-still-registered: .claude/settings.json could not be read, so a hook entry in it may still run it'), result.stdout);
});
