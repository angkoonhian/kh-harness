// scripts/lib/lifecycle-gates.test.mjs — apply's two refusals, drift, the
// dry run and --yes output, through the real CLIs. See lifecycle.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DETECT, APPLY, git, run, settings, fixture, workspaceFixture } from './lifecycle-fixtures.mjs';

// --- Audit Tier 3, finding 11: hooks are registered in exec form ---------------
test('after apply --yes every registered hook is exec form with a ${CLAUDE_PROJECT_DIR}-rooted path, and detect reports it declared', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  const s = settings(d);
  const ours = Object.values(s.hooks).flat().flatMap(m => m.hooks).filter(h => JSON.stringify(h).includes('.claude/scripts/'));
  assert.ok(ours.length >= 2, `fixture sanity: our hooks are registered: ${JSON.stringify(s.hooks)}`);
  for (const h of ours) {
    assert.equal(h.command, 'node', 'the executable, spawned with no shell');
    assert.match(h.args?.[0] ?? '', /^\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/scripts\/[a-z-]+\.mjs$/, JSON.stringify(h));
  }
  const after = JSON.parse(run(DETECT, d, '--json'));
  for (const id of ['P2.stopgate', 'P4.sessionbrief']) {
    assert.equal(after.checks.find(c => c.id === id).state, 'declared', id);
  }
});

test('a user\'s shell-form registration of our script is declared and not re-proposed', () => {
  const d = fixture();
  mkdirSync(join(d, '.claude', 'scripts'), { recursive: true });
  writeFileSync(join(d, '.claude', 'scripts', 'verify-touched.mjs'), '// theirs, by hand\n');
  writeFileSync(join(d, '.claude', 'scripts', 'harness-redact.mjs'), '//\n');
  const s = settings(d);
  s.hooks = { Stop: [{ hooks: [{ type: 'command', command: 'node .claude/scripts/verify-touched.mjs' }] }] };
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'their registration');
  const report = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(report.checks.find(c => c.id === 'P2.stopgate').state, 'declared', 'their shell-form registration is ours, recognised');
  const dry = run(APPLY, d);
  assert.doesNotMatch(dry, /\(hook: Stop\)/, 'and no second registration is proposed');
});

// --- Audit Tier 3, finding 19: the dry run is where the diffs are -------------
test('the dry run shows shipped assets as one line each and the real diff for everything else', () => {
  const dry = run(APPLY, fixture());
  assert.match(dry, /^\+\d+ lines — a verbatim copy of assets\/scripts\/verify-touched\.mjs/m, dry.slice(0, 2000));
  assert.doesNotMatch(dry, /^\+#!\/usr\/bin\/env node$/m, 'no hook script is printed line by line');
  assert.match(dry, /\+\+\+ b\/HANDOFF\.md/, 'a template-rendered file still shows its full diff');
  assert.match(dry, /Dry run — nothing written/);
});

test('apply --yes prints labels and reasons, no file diffs, and still the settings patches', () => {
  const out = run(APPLY, fixture(), '--yes');
  assert.match(out, /^--- \.claude\/scripts\/verify-touched\.mjs  \[P2\.stopgate\]$/m, 'each action is still named');
  assert.doesNotMatch(out, /\+\+\+ b\/HANDOFF\.md/, 'file diffs were for the dry run; --yes reports what it wrote');
  assert.doesNotMatch(out, /verbatim copy of assets/, 'nor the one-line summaries');
  assert.match(out, /\+\+\+ b\/\.claude\/settings\.json/, 'a settings patch is a few lines and the most security-relevant write: still shown');
  assert.match(out, /^wrote      HANDOFF\.md$/m);
});

// --- Audit Tier 4, finding 20: apply holds the questions; it prints them -----
test('apply prints the questions it could not answer inline, not a pointer to detect', () => {
  const dry = run(APPLY, fixture());
  assert.match(dry, /question(s)? this run could not answer:\n/, 'the questions follow on the next lines');
  assert.match(dry, /^  - .+\?$/m, 'each question is a line of its own');
  assert.doesNotMatch(dry, /node scripts\/detect\.mjs/, 'the user is not sent to another command to read a sentence apply already holds');
});

// --- Audit Tier 4, finding 21: the report the kit writes tripped the gate ----
test('a tracked, re-generated docs/harness/detect.json does not trip the dirty-tree gate', () => {
  const d = fixture();
  run(DETECT, d);
  git(d, 'add', 'docs/harness/detect.json');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'commit the report');
  run(DETECT, d); // generatedAt changes: the tracked report is now modified
  const status = execFileSync('git', ['-C', d, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  assert.match(status, /docs\/harness\/detect\.json/, 'fixture sanity: the second detect really did dirty the tracked report');
  assert.doesNotThrow(() => run(APPLY, d, '--yes'), 'the report is the kit\'s own write, like the manifest');
});

test('apply on win32 prints the execute-bit hint after writing bootstrap.sh', (t) => {
  if (process.platform !== 'win32') { t.skip('the hint is for Windows, where chmod is a no-op'); return; }
  const d = workspaceFixture();
  const out = run(APPLY, d, '--yes');
  assert.match(out, /^wrote      scripts\/bootstrap\.sh$/m, 'fixture sanity: the bootstrap script was written');
  assert.match(out, /note: Windows cannot record the execute bit — run `git update-index --chmod=\+x scripts\/bootstrap\.sh` before committing/);
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

// --- Task 9b, finding 3: the dirty gate must ignore apply's own writes ---
//
// `fixture()` commits a tracked `.claude/settings.json` BEFORE the first
// apply, so apply's own patch to it (P2.stopgate's Stop hook, P4.sessionbrief's
// SessionStart hook) dirties a file git already tracks — exactly the shape
// that used to force every second run into `--allow-dirty`.

test('apply\'s own settings patch does not trip the dirty-tree gate on the next run (Task 9b finding 3)', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  // Fixture sanity: the first apply really did dirty the pre-existing
  // TRACKED settings file — otherwise this test would pass for a reason
  // unrelated to the fix (nothing for the gate to have ignored).
  const status = execFileSync('git', ['-C', d, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  assert.match(status, /\.claude\/settings\.json/, 'fixture sanity: our own apply must have dirtied the tracked settings file');
  assert.doesNotThrow(() => run(APPLY, d, '--yes'), 'a second apply must not need --allow-dirty just to see its own prior write');
});

test('a repository dirty from something unrelated still refuses, even once our own paths are excluded (Task 9b finding 3)', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  // An edit to a tracked file apply never touches.
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app-edited-by-someone-else', scripts: { test: 'vitest' } }));
  assert.throws(
    () => run(APPLY, d, '--yes'),
    e => e.status === 3,
    'an unrelated dirty file must still gate the run',
  );
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
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const out = run(APPLY, d); // no --yes: the default dry run
  assert.doesNotMatch(out, /node:internal\/|TypeError|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /could not be parsed as a JSON object/, 'the malformed deny must be reported the same way as unparseable JSON');
});

// Coordinator finding (Minor): apply re-serialises the whole settings.json
// (at its own indentation) — a user whose file was NOT already in that
// canonical form gets everything else in it reformatted too, not just
// the patch being applied. Disclosed, not fixed (ruled against format
// preservation — see task-8b-report.md, finding 7). These pin both
// directions: the note appears when it is true, and does not appear
// (false alarm) when the file was already canonical.

test('apply discloses when applying a patch reformats the rest of settings.json', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest', lint: 'eslint .' } }));
  mkdirSync(join(d, '.claude'), { recursive: true });
  // Compact, single-line JSON — not the canonical form apply itself
  // writes, so applying the sensor's hook patch will reformat
  // this unrelated `permissions` block too, not just add the new hook.
  writeFileSync(join(d, '.claude/settings.json'), '{"permissions":{"deny":["Edit(secrets/**)"]}}');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const out = run(APPLY, d, '--yes');
  assert.match(out, /was re-serialised while applying the patch/, 'the user must be told, not left to discover a diff full of lines they did not change');
  assert.deepEqual(settings(d).permissions, { deny: ['Edit(secrets/**)'] }, 'the content itself is genuinely unchanged — only its formatting is');
});

test('apply does NOT disclose a reformat when settings.json was already in the canonical form', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest', lint: 'eslint .' } }));
  mkdirSync(join(d, '.claude'), { recursive: true });
  // Already exactly the form apply itself would write — applying the
  // sensor's hook patch adds one entry and changes nothing else.
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }, null, 2) + '\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const out = run(APPLY, d, '--yes');
  assert.doesNotMatch(out, /was re-serialised/, 'no false alarm when nothing but the patch itself changed');
});

// Coordinator finding (Major): `commandScript` (detect-harness.mjs)
// resolves a hook's script only against the scan list (listFiles — git
// ls-files -co --exclude-standard), so a repository that gitignores
// `.claude/` makes OUR OWN hook's script permanently unresolvable there —
// detect used to report the harness just installed as absent, and not
// ours, forever, re-proposing on every single run. Plenty of people
// gitignore `.claude/`. Through the real CLI, exactly as asked: apply
// installs with `.claude/` gitignored, then detect must recognise it as
// `declared`, not `absent`.
