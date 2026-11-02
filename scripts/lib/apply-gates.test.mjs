// scripts/lib/apply-gates.test.mjs
//
// `apply`'s two refusals — default branch, dirty tree — exist so a user can
// `git diff` exactly what this tool did. Audit Tier 1, finding 3
// (docs/2026-11-02-audit-findings.md): both could be bypassed without
// anyone asking. A repository with no commits yet read as "not a repository"
// and was written to on `main` with no refusal; the branch gate knew only
// `main` and `master`; and any git error (not installed, "dubious ownership")
// waived both. Finding 5: the DRY RUN was refused too, before it showed
// anything, although the README promised a dry run writes nothing.
//
// The gate tests that predate this file live in lifecycle.test.mjs; these
// are the cases it did not cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envWithoutGit } from './git-info.test.mjs';

const APPLY = resolve(import.meta.dirname, '..', 'apply.mjs');
const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Runs apply and returns `{ code, stdout, stderr }` whatever the exit —
 * spawnSync, because execFileSync's success path discards stderr, and the
 * both-waivers test below asserts on stderr of a run that exits 0. */
function apply(d, args = [], env = process.env) {
  const r = spawnSync(process.execPath, [APPLY, d, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A repository that has something to propose (HANDOFF.md, at least) on
 * the given branch, with one commit so the branch is born. */
function repoOn(branch) {
  const d = mkdtempSync(join(tmpdir(), 'hk-gates-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  execFileSync('git', ['init', '-q', `--initial-branch=${branch}`, d]);
  git(d, 'add', 'package.json');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

test('apply --yes refuses on a repository with no commits whose unborn branch is a default branch', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-gates-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  execFileSync('git', ['init', '-q', '--initial-branch=main', d]);
  const r = apply(d, ['--yes']);
  assert.equal(r.code, 3, `an unborn main is still main: ${JSON.stringify(r)}`);
  assert.match(r.stderr, /default branch "main"/);
  assert.match(r.stderr, /--allow-default-branch/);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'nothing may be written on a refusal');
});

test('apply --yes refuses on the branch init.defaultBranch names', () => {
  const d = repoOn('trunk');
  git(d, 'config', 'init.defaultBranch', 'trunk');
  const r = apply(d, ['--yes']);
  assert.equal(r.code, 3, JSON.stringify(r));
  assert.match(r.stderr, /default branch "trunk"/);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false);
});

test('apply --yes refuses on the branch origin/HEAD points at', () => {
  const d = repoOn('develop');
  git(d, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const r = apply(d, ['--yes']);
  assert.equal(r.code, 3, JSON.stringify(r));
  assert.match(r.stderr, /default branch "develop"/);
});

test('a feature branch is not refused when init.defaultBranch names something else', () => {
  const d = repoOn('feat/x');
  git(d, 'config', 'init.defaultBranch', 'trunk');
  const r = apply(d, ['--yes']);
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.equal(existsSync(join(d, 'HANDOFF.md')), true);
});

test('a dry run on the default branch is not refused and notes what --yes would do', () => {
  const d = repoOn('main');
  const r = apply(d);
  assert.equal(r.code, 0, `a dry run writes nothing, so there is nothing to refuse: ${JSON.stringify(r)}`);
  assert.match(r.stdout, /--- HANDOFF\.md/, 'the proposals are shown');
  assert.match(r.stdout, /note: .*--yes.*default branch "main"/, 'and the user learns now, not after reading the diffs, that --yes would refuse');
  assert.match(r.stdout, /Dry run — nothing written/);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false);
});

test('a dry run on a dirty tree is not refused and notes it', () => {
  const d = repoOn('feat/x');
  writeFileSync(join(d, 'package.json'), '{"name":"edited"}');
  const r = apply(d);
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.match(r.stdout, /note: .*--yes.*uncommitted changes/);
});

test('a dry run on a clean feature branch prints no gate note', () => {
  const r = apply(repoOn('feat/x'));
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /^note: /m);
});

test('apply --yes refuses, naming both waivers, when git cannot run', () => {
  const d = repoOn('feat/x');
  const r = apply(d, ['--yes'], envWithoutGit());
  assert.equal(r.code, 3, `a git that cannot answer is not a clean bill: ${JSON.stringify(r)}`);
  assert.match(r.stderr, /git/i);
  assert.match(r.stderr, /--allow-default-branch/);
  assert.match(r.stderr, /--allow-dirty/);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false);
});

test('apply --yes with both waivers proceeds when git cannot run, and still says so', () => {
  const d = repoOn('feat/x');
  const r = apply(d, ['--yes', '--allow-default-branch', '--allow-dirty'], envWithoutGit());
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.equal(existsSync(join(d, 'HANDOFF.md')), true);
  // Final review, Minor 10 re-graded: with git unavailable the checks run as
  // for a non-repository (P4.remote may propose "add a remote"), and the
  // user must be told why — detect already says it on stderr.
  assert.match(r.stderr, /git/i, 'the waived gates must not make the git failure silent');
});

test('a dry run when git cannot run is not refused and says the gates could not be checked', () => {
  const d = repoOn('feat/x');
  const r = apply(d, [], envWithoutGit());
  assert.equal(r.code, 0, JSON.stringify(r));
  assert.match(r.stdout, /note: .*git/i);
});
