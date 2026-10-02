// scripts/lib/detect-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectExposures, UNREADABLE_KIND } from './detect-exposure.mjs';
import { buildGaps } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';

const CLI = resolve(import.meta.dirname, '..', 'detect.mjs');

function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function bare() {
  const d = mkdtempSync(join(tmpdir(), 'hk-cli-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  write(d, 'package-lock.json', '{}');
  write(d, 'tsconfig.json', '{}');
  write(d, 'src/index.ts', 'export const a = 1;');
  return d;
}
function harnessed() {
  const d = bare();
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' } }));
  write(d, 'CLAUDE.md', 'rule\n');
  write(d, 'docs/ARCHITECTURE.md', '# arch\n');
  write(d, 'docs/harness/recon.md', '# recon\n');
  write(d, 'HANDOFF.md', '# handoff\n');
  write(d, 'scripts/bootstrap.sh', '#!/bin/sh\n');
  // P2.protected requires at least one entry under permissions.deny — an empty
  // settings.json is indistinguishable from "no deny rules" and must NOT be
  // treated as protection. Task 8b: it also requires that entry to actually
  // be OUR OWN derived rule, not merely any rule — this fixture's only real
  // protected-path evidence is package-lock.json (from bare()), so the deny
  // rule here is the literal `Edit(*-lock.json)` that protectedPathCandidates
  // would derive for it; an unrelated rule (e.g. `Edit(migrations/**)`, which
  // this fixture has no migrations/ for) would correctly leave P2.protected
  // `absent` + a new proposal, breaking this test's own "no proposals" point.
  // Hooks are credited from this registry, not from filenames under
  // .claude/scripts/ — a script nothing registers does nothing.
  write(d, '.claude/settings.json', JSON.stringify({
    permissions: { deny: ['Edit(*-lock.json)'] },
    hooks: {
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node .claude/scripts/lint-touched.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node .claude/scripts/verify-touched.mjs' }] }],
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node .claude/scripts/session-brief.mjs' }] }],
    },
  }));
  write(d, '.claude/rules/api.md', '#');
  write(d, '.claude/scripts/lint-touched.mjs', '//');
  write(d, '.claude/scripts/verify-touched.mjs', '//');
  write(d, '.claude/scripts/session-brief.mjs', '//');
  // P4.remote is satisfied by having a remote at all; the URL is never contacted.
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  return d;
}
const cli = (d, ...args) => execFileSync(process.execPath, [CLI, d, ...args], { encoding: 'utf8' });

test('writes detect.json into the target repo', () => {
  const d = bare();
  cli(d);
  assert.ok(existsSync(join(d, 'docs', 'harness', 'detect.json')));
  const r = JSON.parse(readFileSync(join(d, 'docs', 'harness', 'detect.json'), 'utf8'));
  assert.equal(r.schema, 1);
  assert.equal(r.profile, 'typescript-single');
});

test('writes NOTHING else', () => {
  const d = bare();
  // Must COMMIT, not just stage: `git add -A` leaves every file as "A " in
  // porcelain output, which would swamp the assertion.
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'add', '-A']);
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  cli(d);
  // --untracked-files=all: without it, git collapses a wholly-new directory
  // like "docs/" into a single porcelain line instead of listing the file
  // inside it, which would make this assertion compare against the wrong
  // granularity rather than the actual path written.
  const status = execFileSync('git', ['-C', d, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  const touched = status.split('\n').map(s => s.slice(3).trim()).filter(Boolean);
  assert.deepEqual(touched, ['docs/harness/detect.json'], `unexpected writes: ${touched}`);
});

test('prints a summary with proposals for a bare repo', () => {
  const out = cli(bare());
  assert.ok(/proposal/.test(out));
  assert.ok(/P1.bootstrap/.test(out));
});

test('LOAD-BEARING: a harnessed repo gets no proposals', () => {
  const out = cli(harnessed());
  assert.match(out, /no proposals/i);
});

test('--json emits the report', () => {
  const r = JSON.parse(cli(bare(), '--json'));
  assert.equal(r.schema, 1);
  assert.ok(Array.isArray(r.checks));
});

test('an empty repo falls back to the generic profile and does not crash', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-empty-'));
  write(d, 'README.md', '# x\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.profile, 'generic');
  assert.ok(r.checks.some(c => c.state === 'n/a'));
});

// END-TO-END, through the REAL detection path (detectStack -> selectProfile
// -> buildGaps), not a hand-built check object. Pins the coordinator's
// finding directly: a generic repository with nothing to install reports
// P1.bootstrap as `n/a` — not `absent` + `decidable: false`, which an
// earlier plan draft specified but which this implementation deliberately
// supersedes (see gap-model.mjs's own comment at the point this state is
// set). If this is ever "fixed" back toward the plan's framing, this test
// fails.
test('END-TO-END: a generic repo with nothing to install reports P1.bootstrap as n/a, with no proposal', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-generic-bootstrap-'));
  write(d, 'README.md', '# nothing to detect here — no package manager, no language\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.profile, 'generic');
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'n/a', 'a repository with nothing to install correctly reports n/a, not absent');
  assert.equal(c.proposal, null);
  assert.match(cli(d), /P1\.bootstrap\s+n\/a/, 'the human summary must mark it n/a');
});

// END-TO-END pip case, companion to the test above: a repository that DOES
// have evidence (requirements.txt) must NOT fall into the same n/a bucket.
// This is the defect the coordinator found: an earlier ruling's verbatim
// install-command list omitted pip, which (combined with detect-stack.mjs
// never giving a pip-only repo a package entry) made this report n/a
// instead of a proposal, even though pip install -r requirements.txt is
// plainly derivable from requirements.txt's own presence.
test('END-TO-END: a pip repo with requirements.txt reports P1.bootstrap as absent, with a proposal', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-pip-'));
  write(d, 'requirements.txt', 'requests==2.31.0\n');
  write(d, 'app.py', 'print("hi")\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.stack.packageManager, 'pip');
  assert.notEqual(r.profile, 'generic', 'a pip-only repo must select the python profile, not fall back to generic');
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal, 'requirements.txt is evidence — this must be proposed, not asked about');
  assert.match(cli(d), /P1\.bootstrap/);
});

// Coordinator finding (Major): Bun has written `bun.lock` (text) by
// default since 1.2, not `bun.lockb` (binary, the legacy format) —
// verified against a real Bun 1.4.2 install. Detection keyed to
// `bun.lockb` alone silently produced NO proposal at all for every
// current-Bun repository. This is the real CLI, through a repository a
// default `bun install` on a modern Bun actually produces.
test('END-TO-END: a bun.lock repo (Bun 1.2+ default) reports P1.bootstrap as absent, with a proposal', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-bun-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { build: 'true', test: 'true' } }));
  write(d, 'bun.lock', '{\n  "lockfileVersion": 1,\n}\n');
  write(d, 'src/index.js', 'export const a = 1;\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.stack.packageManager, 'bun');
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal, 'bun.lock is evidence — this must be proposed, not asked about or silently dropped');
});

// Companion to the pip case above: a python repo with NO requirements.txt
// (and no pyproject.toml) has no evidence for any install form at all, and
// must stay n/a — exactly like the fully generic case, not a guess.
test('END-TO-END: a python repo with no requirements.txt and no pyproject.toml still reports P1.bootstrap as n/a', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-py-no-evidence-'));
  write(d, 'app.py', 'print("hi")\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.stack.packageManager, null);
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'n/a', 'no lockfile evidence at all, so this stays n/a rather than asking or guessing');
  assert.equal(c.proposal, null);
});

// Coordinator finding (Minor, now fixed): a config-only repository — a
// tracked package.json with a devDependency and build/test scripts, a
// tracked package-lock.json, plus config.json and README.md, but no
// .js/.ts source file — has empty `languages()`, so `typescriptSingle`'s
// confidence is 0 and the profile falls back to `generic`. Before the fix
// this reported P1.bootstrap `n/a` even though `npm ci` is plainly
// derivable from the tracked lockfile; `n/a` was not a lie, but it was a
// missed proposal.
test('END-TO-END: a config-only repo with a tracked lockfile but no source files still gets a bootstrap proposal, not n/a', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-config-only-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', devDependencies: { eslint: '9.0.0' }, scripts: { build: 'true', test: 'true' } }));
  write(d, 'package-lock.json', '{}');
  write(d, 'config.json', '{}');
  write(d, 'README.md', '# x\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.profile, 'generic', 'fixture sanity: confidence genuinely falls below 0.5 here (no .js/.ts source)');
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal, 'npm ci is derivable from the tracked lockfile alone, even on a generic profile');
});

// Major, caught by a later coordinator review: a pyproject-only Python repo
// (pyproject.toml, no requirements.txt, no poetry.lock/uv.lock) SELECTS the
// python profile (packages.length > 0 via the pyproject.toml fallback in
// detect-stack.mjs), so step 5 IS applicable — this is NOT the n/a case
// above. Before the fix, P1.bootstrap's check ignored the stack entirely
// and reported `absent` + a proposal regardless, while propose.mjs's
// generator (correctly, looking at real evidence) produced no file at all:
// `detect` advertised "create scripts/bootstrap.sh from template", `apply`
// silently wrote nothing. The true answer is the third case: a bootstrap
// script applies, but detection cannot derive the install step, so this
// must be `absent` + `decidable: false` + a question — never a proposal.
test('END-TO-END: a pyproject-only python repo (no requirements.txt, no lockfile) is absent + decidable:false + a question, never a proposal', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-pyproject-only-'));
  write(d, 'pyproject.toml', '[project]\nname = "svc"\n');
  write(d, 'app.py', 'print("hi")\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.profile, 'python', 'pyproject.toml alone selects the python profile, not generic');
  assert.equal(r.stack.packageManager, null, 'no lockfile backs any package manager here');
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null, 'a bootstrap proposal here would be a lie — apply could not fulfil it');
  assert.ok(c.question, 'the missing fact must be asked, not silently dropped');
  assert.match(c.question, /install/i);
  assert.ok(r.couldNotDerive.some(q => /install/i.test(q)), 'the question must be routed to couldNotDerive');
  assert.equal(/create scripts\/bootstrap\.sh/.test(cli(d)), false, 'the human summary must not propose a script detection cannot derive');
});

// --- Task 8b, through the real CLI: a Makefile only counts for
// P1.bootstrap when it declares a setup-shaped target. Confirmed live by
// the coordinator: a Makefile with only a `build:` target used to report
// `declared` with evidence `["Makefile"]` — a repository with a
// build-only Makefile was told bootstrap was handled. These three pin the
// exact repository shapes verified by hand before this task existed.

test('END-TO-END (Task 8b): a build-only Makefile does NOT satisfy P1.bootstrap — it still proposes, naming the Makefile', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-makefile-buildonly-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  write(d, 'package-lock.json', '{}');
  write(d, 'src/index.ts', 'export const a = 1;\n');
  write(d, 'Makefile', 'build:\n\ttsc\n\ntest:\n\tjest\n');
  const r = JSON.parse(cli(d, '--json'));
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'absent', 'the exact live defect: this used to be declared from the Makefile\'s mere existence');
  assert.ok(c.proposal, 'npm ci is derivable from the tracked lockfile; the proposal is not suppressed');
  assert.match(c.evidence.join(' '), /Makefile exists but declares no setup-shaped target/);
  assert.match(cli(d), /create scripts\/bootstrap\.sh/, 'the human summary must offer the proposal, not defer to the Makefile');
});

test('END-TO-END (Task 8b): a Makefile with a setup: target DOES satisfy P1.bootstrap, naming the target', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-makefile-setup-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  write(d, 'package-lock.json', '{}');
  write(d, 'src/index.ts', 'export const a = 1;\n');
  write(d, 'Makefile', 'build:\n\ttsc\n\nsetup:\n\tnpm ci\n');
  const r = JSON.parse(cli(d, '--json'));
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'declared');
  assert.equal(c.proposal, null);
  assert.match(c.evidence.join(' '), /setup/);
  assert.equal(/create scripts\/bootstrap\.sh/.test(cli(d)), false, 'a real setup-shaped target must not also be proposed a duplicate');
});

test('END-TO-END (Task 8b): no Makefile at all still proposes, exactly as before this fix', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-no-makefile-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  write(d, 'package-lock.json', '{}');
  write(d, 'src/index.ts', 'export const a = 1;\n');
  const r = JSON.parse(cli(d, '--json'));
  const c = r.checks.find(x => x.id === 'P1.bootstrap');
  assert.equal(c.state, 'absent');
  assert.ok(c.proposal);
  assert.doesNotMatch(c.evidence.join(' '), /Makefile/, 'there is no Makefile here to name');
});

// --- Task 5b, through the real CLI: P2.sensor/P2.stopgate/P2.protected
// must each now either deliver what they advertise or advertise nothing.
// These pin the exact two repository shapes verified by hand before this
// task existed (see this task's brief): a pip-only Python repo, and a
// lockfile-less JS/TS repo with no lint/typecheck/test script. Both used
// to report all three checks as `absent` + a PROPOSAL, none of which
// `apply` could deliver.

test('END-TO-END (Task 5b): a pip-only repo asks about lint/verify commands instead of proposing hooks apply cannot deliver', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-pip-coherence-'));
  write(d, 'requirements.txt', 'requests==2.31.0\n');
  write(d, 'app.py', 'print("hi")\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.stack.packageManager, 'pip');

  const sensor = r.checks.find(c => c.id === 'P2.sensor');
  assert.equal(sensor.state, 'absent');
  assert.equal(sensor.decidable, false, 'detect-stack.mjs has no Python script-name convention, so this must ask, not propose');
  assert.equal(sensor.proposal, null);
  assert.match(sensor.question, /lint/i);

  const stopgate = r.checks.find(c => c.id === 'P2.stopgate');
  assert.equal(stopgate.state, 'absent');
  assert.equal(stopgate.decidable, false);
  assert.equal(stopgate.proposal, null);
  assert.match(stopgate.question, /verif|typecheck|test/i);

  // Coordinator correction: requirements.txt alone is a HAND-EDITED
  // manifest, not a lockfile — python.mjs's `protectedGlobs()` entry for
  // it is now gated on a requirements*.in source also existing (pip-tools
  // compiled output), which this fixture has none of. So P2.protected
  // correctly reaches n/a here too, not a proposal — see
  // protected-evidence.mjs and the companion test below, which adds
  // requirements.in and shows the proposal become real.
  const protectedCheck = r.checks.find(c => c.id === 'P2.protected');
  assert.equal(protectedCheck.state, 'n/a', 'a hand-edited requirements.txt with no .in source is not a lockfile');
  assert.equal(protectedCheck.proposal, null);
  assert.equal(protectedCheck.question, null);

  assert.ok(r.couldNotDerive.some(q => /lint/i.test(q)), 'the sensor question must be routed to couldNotDerive');
  assert.ok(r.couldNotDerive.some(q => /verif|typecheck|test/i.test(q)), 'the stop-gate question must be routed to couldNotDerive');
});

test('END-TO-END (Task 5b): a pip-tools repo (requirements.in AND requirements.txt) proposes and delivers the literal deny rule', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-pip-tools-'));
  write(d, 'requirements.in', 'requests\n');
  write(d, 'requirements.txt', 'requests==2.31.0\n');
  write(d, 'app.py', 'print("hi")\n');
  const r = JSON.parse(cli(d, '--json'));

  const protectedCheck = r.checks.find(c => c.id === 'P2.protected');
  assert.equal(protectedCheck.state, 'absent');
  assert.equal(protectedCheck.decidable, true);
  assert.ok(protectedCheck.proposal, 'requirements.in is real evidence that requirements.txt is compiled output');

  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'checkout', '-q', '-b', 'chore/harness']);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  execFileSync('git', ['-C', d, 'add', '-A']);
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  const APPLY = resolve(import.meta.dirname, '..', 'apply.mjs');
  const out = execFileSync(process.execPath, [APPLY, d, '--yes'], { encoding: 'utf8' });
  assert.match(out, /Edit\(requirements\.txt\)/, 'the deny rule is actually delivered, not just advertised — as the literal filename');
  const settings = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes('Edit(requirements.txt)'));
});

// Coordinator correction, round 2: proves the per-file discrimination
// through the real CLI, end to end — requirements.txt (paired with
// requirements.in) is protected; requirements-dev.txt (no
// requirements-dev.in of its own) is not, and no wildcard form sweeps it
// in regardless.
test('END-TO-END (Task 5b): requirements.in + requirements.txt + requirements-dev.txt protects only requirements.txt, by its own literal name', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-pip-tools-discrim-'));
  write(d, 'requirements.in', 'requests\n');
  write(d, 'requirements.txt', 'requests==2.31.0\n');
  write(d, 'requirements-dev.txt', 'pytest\n');
  write(d, 'app.py', 'print("hi")\n');
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'checkout', '-q', '-b', 'chore/harness']);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  execFileSync('git', ['-C', d, 'add', '-A']);
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  const APPLY = resolve(import.meta.dirname, '..', 'apply.mjs');
  const out = execFileSync(process.execPath, [APPLY, d, '--yes'], { encoding: 'utf8' });
  assert.match(out, /Edit\(requirements\.txt\)/);
  assert.doesNotMatch(out, /Edit\(requirements-dev\.txt\)/);
  assert.doesNotMatch(out, /requirements\*/, 'no wildcard form may appear anywhere in the preview');

  const settings = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.deny, ['Edit(requirements.txt)'],
    `the deny list must name exactly the paired file, verbatim; got ${JSON.stringify(settings.permissions.deny)}`);
});

test('END-TO-END (Task 5b): a lockfile-less JS/TS repo with no lint/typecheck/test script asks or reports n/a, never an undeliverable proposal', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-js-coherence-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { build: 'tsc' } }));
  write(d, 'src/index.ts', 'export const a = 1;\n');
  write(d, 'tsconfig.json', '{}');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.stack.packageManager, null, 'fixture sanity: genuinely no tracked lockfile');

  const sensor = r.checks.find(c => c.id === 'P2.sensor');
  assert.equal(sensor.state, 'absent');
  assert.equal(sensor.decidable, false);
  assert.equal(sensor.proposal, null);
  assert.match(sensor.question, /lint/i);

  const stopgate = r.checks.find(c => c.id === 'P2.stopgate');
  assert.equal(stopgate.state, 'absent');
  assert.equal(stopgate.decidable, false);
  assert.equal(stopgate.proposal, null);
  assert.match(stopgate.question, /verif|typecheck|test/i);

  const protectedCheck = r.checks.find(c => c.id === 'P2.protected');
  assert.equal(protectedCheck.state, 'n/a', 'no lockfile, no build output, no migrations — nothing here to protect');
  assert.equal(protectedCheck.proposal, null);
  assert.equal(protectedCheck.question, null, 'do not ask about protected paths that do not exist');
});

// A package.json script body is repository-derived text that routinely holds a
// hardcoded token (`sentry-cli --auth-token …`). The report records that a
// script exists, never what it says. This asserts the value never reaches
// stdout nor the one file the tool writes.
test('SECURITY: a package.json script body never reaches stdout or detect.json', () => {
  const d = bare();
  const MARKER = 'hk-marker-' + 'Z'.repeat(24);
  write(d, 'package.json', JSON.stringify({
    name: 'app',
    scripts: { test: 'vitest', deploy: `sentry-cli --auth-token ${MARKER} releases new` },
  }));

  const stdout = cli(d, '--json');
  assert.equal(stdout.includes(MARKER), false, 'script body leaked to stdout');

  const onDisk = readFileSync(join(d, 'docs', 'harness', 'detect.json'), 'utf8');
  assert.equal(onDisk.includes(MARKER), false, 'script body leaked into detect.json');

  // The report must still know the script is there — the fix removes the value,
  // not the observation.
  const r = JSON.parse(stdout);
  assert.ok(r.stack.packages[0].scripts.includes('deploy'), 'script presence must survive');

  // And the human-readable summary path must be clean too.
  const summary = cli(d);
  assert.equal(summary.includes(MARKER), false, 'script body leaked to the summary');
});

// A hook command's ARGUMENTS are where secrets live, and one of the two files
// hookEvents reads — .claude/settings.local.json — is gitignored and sits on
// the credential scanner's always-probe list precisely because it holds
// machine-local secrets. Masking against a pattern list only narrows the leak:
// it depends on that list being complete, and this project fixed I1 because it
// was not. Only omission closes it.
test('SECURITY: a hook command argument never reaches stdout, the summary or detect.json', () => {
  const d = bare();
  // Deliberately unlike any known token format, so no pattern can match it.
  const UNKNOWN = 'wobbegong-marker-7391-quenelle';
  // And one that a pattern DOES match, which must also be absent — for the new
  // reason (nothing is echoed) rather than the old one (it was masked).
  const KNOWN = 'glpat-' + 'B'.repeat(20);
  write(d, 'tools/inject.js', '//');
  write(d, '.claude/settings.json', JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `node tools/inject.js --token ${UNKNOWN}` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `curl -H "PRIVATE-TOKEN: ${KNOWN}" https://example.invalid` }] }],
    },
  }));

  const json = cli(d, '--json');
  const summary = cli(d);
  const onDisk = readFileSync(join(d, 'docs', 'harness', 'detect.json'), 'utf8');

  for (const [label, secret] of [['unrecognised', UNKNOWN], ['pattern-matching', KNOWN]]) {
    assert.equal(json.includes(secret), false, `${label} secret leaked to stdout`);
    assert.equal(summary.includes(secret), false, `${label} secret leaked to the summary`);
    assert.equal(onDisk.includes(secret), false, `${label} secret leaked into detect.json`);
  }

  // Task 8b: `tools/inject.js` is not harness-kit's own session-brief
  // script, so this hook must NOT be credited as ours — but the resolved
  // path is still safe to name (it carries no secret; the command's
  // ARGUMENTS are what this test is actually about), so the evidence still
  // says what was found, just as a reason the proposal is still live.
  const c = JSON.parse(json).checks.find(x => x.id === 'P4.sessionbrief');
  assert.equal(c.state, 'absent', 'an unrelated SessionStart hook is not ours');
  assert.ok(c.proposal);
  assert.ok(c.evidence.some(e => e.includes('tools/inject.js')), `got ${JSON.stringify(c.evidence)}`);
});

// D2, superseded by Task 8b: this used to assert `declared` for all three
// checks below, from a command living OUTSIDE .claude/scripts/ — the exact
// defect Task 8b fixes. The half of D2 that still holds: hook credit comes
// from the settings.json REGISTRY, keyed by resolved path, never from the
// file list under .claude/scripts/ (`r.harness.claudeDir.hooks` stays `[]`
// below, proving that). What no longer holds: a command living outside
// .claude/scripts/ can never BE ours — every script this tool generates is
// written there — so it is resolved and named in evidence, but credited as
// someone else's, with the proposal still live.
test('a hook registered in settings.json but living outside .claude/scripts/ is resolved and named, but never credited as ours', () => {
  // Built from bare(), so .claude/scripts/ is genuinely empty: the file list
  // cannot be what credits these hooks.
  const d = bare();
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' } }));
  write(d, 'CLAUDE.md', 'rule\n');
  write(d, 'docs/ARCHITECTURE.md', '# arch\n');
  write(d, 'docs/harness/recon.md', '# recon\n');
  write(d, 'HANDOFF.md', '# handoff\n');
  write(d, 'scripts/bootstrap.sh', '#!/bin/sh\n');
  write(d, '.claude/rules/api.md', '#');
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  write(d, 'docs/agent-context/inject.js', '//');
  write(d, 'tools/lint.js', '//');
  write(d, 'tools/verify.js', '//');
  write(d, '.claude/settings.json', JSON.stringify({
    permissions: { deny: ['Edit(migrations/**)'] },
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'node docs/agent-context/inject.js' }] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node tools/lint.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node tools/verify.js' }] }],
    },
  }));

  const r = JSON.parse(cli(d, '--json'));
  assert.deepEqual(r.harness.claudeDir.hooks, [],
    'fixture assumes nothing lives under .claude/scripts/');

  for (const [id, cmd] of [['P2.sensor', 'tools/lint.js'], ['P2.stopgate', 'tools/verify.js'], ['P4.sessionbrief', 'docs/agent-context/inject.js']]) {
    const c = r.checks.find(x => x.id === id);
    assert.equal(c.state, 'absent', `${id}'s hook is resolved from the registry, but it is not ours`);
    assert.ok(c.proposal, `${id} must still be proposed — their hook says nothing about ours`);
    assert.ok(c.evidence.some(e => e.includes(cmd)), `${id} evidence must name the registered command; got ${JSON.stringify(c.evidence)}`);
  }

  // This fixture's only deny rule (`Edit(migrations/**)`) has no
  // migrations/ to back it, and does not match this fixture's real
  // protected-path evidence (package-lock.json, from bare()) either — so
  // P2.protected is absent + proposed too, naming the unrelated rule.
  const protectedCheck = r.checks.find(x => x.id === 'P2.protected');
  assert.equal(protectedCheck.state, 'absent');
  assert.ok(protectedCheck.proposal);
  assert.ok(protectedCheck.evidence.some(e => e.includes('Edit(migrations/**)')));

  // Four proposals now, where there used to be none — the defect, inverted.
  assert.doesNotMatch(cli(d), /no proposals/i);
  assert.match(cli(d), /4 proposals/i);
});

// D1: a real repository keeps 456 lines under docs/wiki/ and names it in
// CLAUDE.md as "project structure, the source of truth". Judged by three
// filenames it has no architecture document.
test('a repository whose instruction file points at its documentation is credited', () => {
  const d = bare();
  write(d, 'CLAUDE.md', 'Project structure, the source of truth: `docs/wiki/`.\nConventions: @docs/agent-context/CONVENTIONS.md\n');
  write(d, 'docs/wiki/README.md', '# wiki\n');
  write(d, 'docs/wiki/services.md', '# services\n');
  write(d, 'docs/agent-context/CONVENTIONS.md', '# conventions\n');

  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.harness.architecture, null, 'fixture assumes no canonical path exists');
  const c = r.checks.find(x => x.id === 'P1.architecture');
  assert.equal(c.state, 'declared');
  assert.equal(c.proposal, null, 'must not propose writing a document the repository already has');
  assert.ok(c.evidence.some(e => e.includes('docs/wiki/README.md')));
  assert.equal(/architecture prompt/.test(cli(d)), false, 'the summary must not propose one either');
});

test('an undecidable architecture check proposes nothing and asks instead', () => {
  const d = bare();
  // Documentation exists, but nothing in the repository points at it and no
  // canonical name matches. Three filenames is not an enumeration of the space.
  write(d, 'docs/wiki/README.md', '# wiki\n');
  write(d, 'docs/wiki/services.md', '# services\n');

  const r = JSON.parse(cli(d, '--json'));
  const c = r.checks.find(x => x.id === 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.equal(c.proposal, null, 'an undecidable absent must never propose');
  assert.ok(r.couldNotDerive.some(q => /architecture document/.test(q) && /docs\/wiki\/README\.md/.test(q)),
    `the question must be routed to couldNotDerive; got ${JSON.stringify(r.couldNotDerive)}`);

  const summary = cli(d);
  assert.equal(/run the architecture prompt/.test(summary), false);
  assert.match(summary, /Could not derive/);
  assert.match(summary, /Is one of these the architecture document\?/);
});

// Coordinator finding (round 2): projectDocs' wide net for .txt files is
// correct — restricting it by extension would be exactly the assumption
// its own comment already rejects — but requirements.txt/constraints.txt
// are Python DEPENDENCY MANIFESTS, not documentation (this codebase
// already treats requirements.txt this way: see gap-model.mjs's
// P1.bootstrap comment and protected-evidence.mjs's
// pairedRequirementsFiles, both keyed on the same pip naming convention).
// Before the fix, a repository whose only .txt file was requirements.txt
// got asked "the repository holds 1 documentation file (requirements.txt)
// — is one of these the architecture document?", which asserted something
// never measured: nothing confirmed requirements.txt IS documentation.
test('END-TO-END: a repository whose only .txt file is requirements.txt gets no documentation-shaped architecture question', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-reqtxt-only-'));
  write(d, 'requirements.txt', 'flask==3.0\n');
  write(d, 'app.py', 'print("hi")\n');
  const r = JSON.parse(cli(d, '--json'));
  // Fixture sanity: detect-stack.mjs only adds this package entry when
  // `files.includes('requirements.txt')`, so this proves requirements.txt
  // was actually seen by detection — without it, "no question" below would
  // be true for the wrong reason (an irrelevant or empty fixture).
  assert.ok(r.stack.packages.some(p => p.manifestPath === 'requirements.txt'), 'fixture sanity: requirements.txt must actually be detected');
  assert.deepEqual(r.harness.projectDocs, [], 'requirements.txt must not be classified as a documentation-shaped file');
  const c = r.checks.find(x => x.id === 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true, 'no documentation-shaped file exists, so this really is the empty case');
  assert.ok(c.proposal, 'the honest answer is a proposal to write one — not a question about requirements.txt');
  assert.equal(r.couldNotDerive.some(q => /documentation-shaped name/.test(q)), false);
});

test('END-TO-END: a repository with a real NOTES.txt (plus requirements.txt) still gets the documentation-shaped architecture question, naming only NOTES.txt', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-notestxt-'));
  write(d, 'requirements.txt', 'flask==3.0\n');
  write(d, 'NOTES.txt', 'Design notes for this service.\n');
  write(d, 'app.py', 'print("hi")\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.ok(r.stack.packages.some(p => p.manifestPath === 'requirements.txt'), 'fixture sanity: requirements.txt must actually be detected');
  assert.deepEqual(r.harness.projectDocs, ['NOTES.txt'], 'NOTES.txt is real documentation-shaped evidence; requirements.txt is excluded from the same list');
  const c = r.checks.find(x => x.id === 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, false);
  assert.ok(c.question, 'a genuine documentation-shaped file still prompts the question');
  assert.match(c.question, /1 file with a documentation-shaped name/);
  assert.match(c.question, /NOTES\.txt/);
  assert.equal(/requirements\.txt/.test(c.question), false, 'requirements.txt must never appear in the documentation-shaped listing');
});

// Coordinator finding (round 3, test quality): the reachable shape of the
// Python advice dedupe — one real, auto-detectable Python package whose
// own pyproject.toml carries both a ruff and a mypy table — had nothing
// covering it before this fix; only a hand-built multi-package stack
// (gap-model.test.mjs, which detect-stack.mjs cannot actually produce for
// Python) exercised the dedupe at all. This test drives the REAL CLI.
test('END-TO-END: a Python repo with both ruff and mypy config derives two advice lines, with the shared explanation only once', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-py-dedupe-'));
  write(d, 'pyproject.toml', '[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n');
  write(d, 'app.py', 'x = 1\n');
  const r = JSON.parse(cli(d, '--json'));
  const c = r.checks.find(x => x.id === 'P2.scripts');
  const derivedLines = c.advice.filter(a => /->/.test(a));
  assert.equal(derivedLines.length, 2, `fixture sanity: expected 2 derived lines, got ${JSON.stringify(c.advice)}`);
  assert.ok(derivedLines.some(a => a.includes('ruff check .')));
  assert.ok(derivedLines.some(a => a.includes('mypy .')));
  assert.equal(c.advice.filter(a => /no standard script table/.test(a)).length, 1, 'the shared explanation must appear exactly once in the real report');
  const summary = cli(d);
  assert.equal((summary.match(/no standard script table/g) || []).length, 1, 'and exactly once in the rendered summary text, not once per line');
});

test('a repository with no documentation at all is still proposed one', () => {
  const r = JSON.parse(cli(bare(), '--json'));
  const c = r.checks.find(x => x.id === 'P1.architecture');
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true, 'the space really is empty here');
  assert.ok(c.proposal);
});

// detect.mjs:41-43 is the sole line connecting --verify to report.verification,
// and nothing touched it. It is also the only path that executes the target
// repository's own commands, so it is the last place to leave untested.
test('--verify populates report.verification; without it there is none', () => {
  const d = bare();
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'node -e process.exit(0)' } }));

  const without = JSON.parse(cli(d, '--json'));
  assert.equal('verification' in without, false, 'no command may run without --verify');

  const withFlag = JSON.parse(cli(d, '--verify', '--json'));
  assert.ok(Array.isArray(withFlag.verification), 'report.verification must be present');
  const t = withFlag.verification.find(v => v.kind === 'test');
  assert.ok(t, `the discovered test command must be recorded; got ${JSON.stringify(withFlag.verification)}`);
  assert.equal(t.pkg, 'app');
  assert.equal(t.command, 'npm run test');
  assert.equal(typeof t.exitCode, 'number');
  assert.equal(typeof t.durationMs, 'number');
  // install mutates the tree and is never run.
  assert.equal(withFlag.verification.some(v => v.kind === 'install'), false);
}, { timeout: 120000 });

// `--verfiy` used to be a silent no-op: the user is told the tool verified
// nothing only by its absence from the output.
test('an unknown flag warns on stderr, never on stdout, and the run continues', () => {
  const d = bare();
  const r = spawnSync(process.execPath, [CLI, d, '--verfiy', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'an unknown flag is a warning, not a failure');
  assert.equal(JSON.parse(r.stdout).schema, 1, 'stdout must stay parseable JSON');
  assert.equal(r.stdout.includes('--verfiy'), false, 'the warning must not land on stdout');
  assert.match(r.stderr, /unknown flag/i);
  assert.match(r.stderr, /--verfiy/);
});

test('a missing target exits 2', () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, join(tmpdir(), 'does-not-exist-hk')], { encoding: 'utf8', stdio: 'pipe' }),
    e => e.status === 2,
  );
});

// --- Whole-branch review, F1 -----------------------------------------------
//
// Accented, CJK and emoji filenames are ordinary. Without `-z`,
// `git ls-files` C-quotes every one of them, `statSync` on that literal threw
// ENOENT, the credential scanner skipped the file with no record anywhere,
// and this is what the user was told about a repository holding a live
// token:
//
//     [x] P0.security        verified
//           no credential patterns matched
//
// Driven through the real CLI, with a real git repository and a real
// plaintext token, because that is the surface the sentence is printed on.
// Reverting `-z` in scan.mjs's `gitPaths` must fail this test by name.
test('F1 SECURITY: a plaintext token in a file with a non-ASCII name is found, and P0.security is never verified', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'hk-cli-nonascii-'));
  // Escapes, not literal bytes — this test file is itself tracked source.
  const NAME = 'src/配置.ts';
  const TOKEN = 'ghp_' + '0123456789abcdefghij'.repeat(1).slice(0, 20) + '0123456789';
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  write(d, NAME, `export const GITHUB_TOKEN = "${TOKEN}";\n`);
  try {
    execFileSync('git', ['init', '-q', d], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'commit', '-qm', 'init'], { stdio: 'ignore' });
  } catch (e) {
    t.skip(`git is unavailable, so git's own path quoting cannot be exercised: ${e.message}`);
    return;
  }

  const report = JSON.parse(cli(d, '--json'));
  if (report.harness.remotes === undefined) assert.fail('unexpected report shape');

  const security = report.checks.find(c => c.id === 'P0.security');
  assert.equal(security.state, 'failing', 'a repository holding a plaintext token must never report a clean sweep');

  const hit = report.exposures.find(e => e.kind === 'token-in-tracked-file');
  assert.ok(hit, `expected a token-in-tracked-file finding, got ${JSON.stringify(report.exposures)}`);
  assert.equal(hit.location, NAME, 'the finding must name the real path, not a C-quoted literal');

  // The value itself is never printed — the pre-existing guarantee must hold
  // for this path too, not only for ASCII ones.
  const summary = cli(d);
  assert.equal(summary.includes(TOKEN), false, 'the token value must never reach the summary');
  assert.ok(summary.includes(NAME), 'the location must reach the summary');

  // ...and the stack is detected, so the profile does not silently fall back
  // to `generic` and report every stack-specific capability as n/a.
  assert.ok(report.stack.languages.includes('typescript'), 'a .ts file whose name is non-ASCII is still a .ts file');
  assert.match(report.profile, /^typescript/, 'the profile must be the TypeScript one, not the generic fallback');
});

// The other half of F1, and the half that outlives the quoting fix: whatever
// the reason a file named by the scan cannot be read, it is REPORTED, and
// P0.security does not say `verified` over it. Silence on an unexamined file
// is the defect; the quoting was only one way to produce it.
test('F1 SECURITY: a file the scan named but cannot read is reported, and P0.security is not verified', () => {
  const d = bare();
  // A path git will list (via -o, untracked) that does not resolve: a
  // dangling symlink is the portable way to make `statSync` fail on a file
  // the scan genuinely named. Where symlinks need elevation, fall back to
  // naming the path directly to detectExposures, which is the same code
  // path the CLI takes.
  const files = ['src/index.ts', 'src/vanished.ts'];
  const exposures = detectExposures(d, files, { remotes: [] });
  const unreadable = exposures.filter(e => e.kind === UNREADABLE_KIND);
  assert.equal(unreadable.length, 1, `expected exactly one unreadable record, got ${JSON.stringify(exposures)}`);
  assert.equal(unreadable[0].location, 'src/vanished.ts');
  assert.match(unreadable[0].reason, /ENOENT/, 'the reason must say what actually went wrong');

  const checks = buildGaps({
    stack: { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] },
    harness: { instructions: { path: null, lines: 0 }, agentsMd: null, reconPresent: false,
      claudeDir: { settings: false, localSettings: false, denyRules: 0, denyRuleList: [], hooks: [], hookEvents: {}, agents: [], skills: [], commands: [], rules: [] },
      otherEditors: [], architecture: null, docPointers: [], projectDocs: [], handoff: null, bootstrap: null, gitattributes: false, remotes: [] },
    exposures, profile: selectProfile({ languages: [], packages: [] }),
    git: { isRepo: true, branch: 'feat/x' }, files, root: d,
  });
  const security = checks.find(c => c.id === 'P0.security');
  assert.equal(security.state, 'failing', 'an unexamined file must never be reported as a clean sweep');
  assert.match(security.evidence.join('\n'), /INCOMPLETE/);
});

// --- Coordinator ruling (post-review, concern 1) --------------------------
//
// The end of the chain glob.test.mjs pins at the unit level: a hostile or
// broken `package.json` supplies a `workspaces` entry containing JSON's own
// `\u0000` escape, which parses to a real NUL. Before the boundary refusal that
// pattern became `.*` and matched EVERY package.json in the tree, so every
// one of them was detected as a workspace member — repository-controlled
// data producing a glob that matches everything.
//
// The NUL is built with `String.fromCharCode(0)`, never typed, for the same
// reason glob.test.mjs's own guard exists.
test('CONCERN 1: a workspaces entry containing a NUL matches no package, and is reported as a question', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-cli-nulglob-'));
  const NUL = String.fromCharCode(0);
  write(d, 'package.json', JSON.stringify({
    name: 'app',
    // Entry 0 is the hostile one; entry 1 is legitimate and must still work,
    // so the refusal is proven to be per-pattern rather than per-repository.
    workspaces: [NUL, 'packages/*'],
    scripts: { test: 'vitest' },
  }));
  write(d, 'package-lock.json', '{}');
  write(d, 'tsconfig.json', '{}');
  write(d, 'packages/api/package.json', JSON.stringify({ name: '@app/api', scripts: {} }));
  write(d, 'packages/api/index.ts', 'export const ok = true;');
  // A manifest NO legitimate pattern reaches. Before the fix the NUL glob
  // matched it; after, only `packages/*` is interpreted, and it does not.
  write(d, 'vendor/sneaky/package.json', JSON.stringify({ name: 'sneaky', scripts: {} }));

  const r = JSON.parse(cli(d, '--json'));

  // 1. Refused, by index, never by value.
  assert.deepEqual(r.stack.rejectedWorkspacePatterns, [0]);

  // 2. The refusal matched nothing: the legitimate member is present, the
  //    one only the NUL glob could have reached is not.
  const dirs = r.stack.packages.map(p => p.dir).sort();
  assert.deepEqual(dirs, ['.', 'packages/api'],
    `a refused glob must match no package, got ${JSON.stringify(dirs)}`);

  // 3. Reported, not absorbed — and the value is never printed.
  const question = r.couldNotDerive.find(q => /workspace pattern/.test(q));
  assert.ok(question, `the refusal must reach couldNotDerive: ${JSON.stringify(r.couldNotDerive)}`);
  assert.match(question, /index 0/);
  assert.match(question, /NUL/);
  const summary = cli(d);
  assert.match(summary, /workspace pattern/);
  assert.equal(summary.includes(NUL), false, 'the control character must never reach the output');
  assert.equal(JSON.stringify(r).includes(NUL), false, 'nor detect.json');
});
