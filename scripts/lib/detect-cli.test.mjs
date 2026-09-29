// scripts/lib/detect-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  // treated as protection.
  // Hooks are credited from this registry, not from filenames under
  // .claude/scripts/ — a script nothing registers does nothing.
  write(d, '.claude/settings.json', JSON.stringify({
    permissions: { deny: ['Edit(migrations/**)'] },
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

// D2: a real repository registers its session brief outside .claude/scripts/.
// Judged by filename it is invisible, and the tool proposes installing a
// session brief to a repository that already has a working one.
test('a hook registered in settings.json but living outside .claude/scripts/ is credited', () => {
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
    assert.equal(c.state, 'declared', `${id} should be credited from the registry`);
    assert.equal(c.proposal, null);
    assert.ok(c.evidence.some(e => e.includes(cmd)), `${id} evidence must name the registered command; got ${JSON.stringify(c.evidence)}`);
  }
  assert.match(cli(d), /no proposals/i);
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
