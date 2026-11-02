// scripts/lib/git-info.test.mjs
//
// Audit Tier 1, finding 3 (docs/2026-11-02-audit-findings.md). `gitInfo`
// used `rev-parse --abbrev-ref HEAD`, which fails on a repository with no
// commits, and reported that failure — and every OTHER failure, git not
// installed included — as "not a repository". `apply`'s two safety gates are
// conditional on `isRepo`, so an unborn `main` and a broken git both waived
// them. These pin the replacement contract: an unborn branch is a branch, a
// non-repository is a non-repository, and a git that cannot answer is an
// ERROR the caller must see rather than a clean bill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitInfo, defaultBranches } from './git-info.mjs';

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const dir = () => mkdtempSync(join(tmpdir(), 'hk-git-'));

function repoWithCommit() {
  const d = dir();
  execFileSync('git', ['init', '-q', '--initial-branch=feature/x', d]);
  writeFileSync(join(d, 'a.txt'), 'a\n');
  git(d, 'add', 'a.txt');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

/** An environment in which `git` cannot be found. Built without ANY
 * path-like key rather than by overriding `PATH`, because on Windows
 * `process.env` may spell it `Path`, and a child env block holding both
 * `Path=…` and `PATH=` is ambiguous. */
export function envWithoutGit() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  env.PATH = '';
  return env;
}

test('gitInfo on a repository with no commits reports the unborn branch, not "not a repository"', () => {
  const d = dir();
  execFileSync('git', ['init', '-q', '--initial-branch=main', d]);
  assert.deepEqual(gitInfo(d), { isRepo: true, branch: 'main', error: null });
});

test('gitInfo on a committed branch reports it', () => {
  assert.deepEqual(gitInfo(repoWithCommit()), { isRepo: true, branch: 'feature/x', error: null });
});

test('gitInfo on a detached HEAD reports branch null', () => {
  const d = repoWithCommit();
  git(d, 'checkout', '-q', '--detach');
  assert.deepEqual(gitInfo(d), { isRepo: true, branch: null, error: null });
});

test('gitInfo outside any repository is isRepo false with no error', () => {
  assert.deepEqual(gitInfo(dir()), { isRepo: false, branch: null, error: null });
});

test('gitInfo when git cannot run reports an error, never "not a repository"', () => {
  const info = gitInfo(repoWithCommit(), { env: envWithoutGit() });
  assert.equal(info.isRepo, false);
  assert.equal(info.branch, null);
  assert.match(info.error ?? '', /git/i, 'the error must say git could not be consulted');
});

test('defaultBranches always includes main and master, plus init.defaultBranch and the branch origin/HEAD points at', () => {
  const plain = repoWithCommit();
  assert.ok(defaultBranches(plain).includes('main'));
  assert.ok(defaultBranches(plain).includes('master'));

  const configured = repoWithCommit();
  git(configured, 'config', 'init.defaultBranch', 'trunk');
  git(configured, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const branches = defaultBranches(configured);
  assert.ok(branches.includes('trunk'), `init.defaultBranch: ${branches}`);
  assert.ok(branches.includes('develop'), `origin/HEAD: ${branches}`);
  assert.equal(new Set(branches).size, branches.length, 'no duplicates');
});

test('defaultBranches outside a repository, or when git cannot run, still names main and master', () => {
  assert.deepEqual(defaultBranches(dir()), ['main', 'master']);
  assert.deepEqual(defaultBranches(repoWithCommit(), { env: envWithoutGit() }), ['main', 'master']);
});
