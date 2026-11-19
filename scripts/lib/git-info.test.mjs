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
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git as kitGit, gitInfo, defaultBranches } from './git-info.mjs';
import { listFiles } from './scan.mjs';
import { detectHarness } from './detect-harness.mjs';
import { writeGateRefusals } from './apply-lib.mjs';
import { buildGaps } from './gap-model.mjs';
import { selectProfile } from './profiles/index.mjs';

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

// --- Every kit-side git call is one wrapper's -------------------------------

test('no kit file but git-info.mjs starts git', () => {
  const lib = new URL('./', import.meta.url);
  const sources = [
    ...readdirSync(lib).filter(n => n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !n.endsWith('-fixtures.mjs')).map(n => new URL(n, lib)),
    ...readdirSync(new URL('../', lib)).filter(n => n.endsWith('.mjs')).map(n => new URL(`../${n}`, lib)),
  ];
  assert.ok(sources.length > 30, 'fixture sanity: the kit\'s sources were found');
  const starters = sources.filter(url => /(?:execFileSync|execFile|spawnSync|spawn)\(\s*'git'/.test(readFileSync(url, 'utf8'))).map(url => url.pathname.split('/').pop());
  assert.deepEqual(starters, ['git-info.mjs']);
});

/** Runs `fn` with GIT_DIR and GIT_WORK_TREE pointing git at `other`, as a
 * git hook's environment or a stray export would. */
function withGitPointedAt(other, fn) {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(other, '.git');
  process.env.GIT_WORK_TREE = other;
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** A second repository, on another branch, with a remote and an uncommitted
 * change to a tracked file: everything a redirected call would report. */
function otherRepo() {
  const d = dir();
  execFileSync('git', ['init', '-q', '--initial-branch=main', d]);
  writeFileSync(join(d, 'theirs.txt'), 'theirs\n');
  git(d, 'add', 'theirs.txt');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  git(d, 'remote', 'add', 'upstream', 'https://example.invalid/other.git');
  writeFileSync(join(d, 'theirs.txt'), 'changed\n');
  return d;
}

test('with GIT_DIR pointing elsewhere, every kit git call still reads the repository it was given', () => {
  const mine = repoWithCommit();
  withGitPointedAt(otherRepo(), () => {
    assert.equal(kitGit(mine, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/x');
    assert.deepEqual(gitInfo(mine), { isRepo: true, branch: 'feature/x', error: null });
    assert.deepEqual(listFiles(mine).files, ['a.txt'], 'the scan lists this repository\'s files');
    assert.deepEqual(detectHarness(mine, ['a.txt']).remotes, [], 'and its remotes, of which it has none');
    const refusals = writeGateRefusals({ root: mine, git: gitInfo(mine), manifestResult: { state: 'missing', manifest: null }, allowDefaultBranch: false, allowDirty: false, verb: 'apply' });
    assert.deepEqual(refusals, [], 'the dirty-tree gate reads this repository, which is clean and on a feature branch');
  });
});

test('a directory git finds as a repository only through GIT_DIR is an error, never "not a repository"', () => {
  const plain = dir();
  withGitPointedAt(otherRepo(), () => {
    const info = gitInfo(plain);
    assert.equal(info.isRepo, false);
    assert.match(info.error ?? '', /GIT_DIR/, 'the gates must not be waived in silence');
  });
  assert.deepEqual(gitInfo(plain), { isRepo: false, branch: null, error: null }, 'without the variable it is simply not a repository');
});

// --- A git that cannot list remotes is not a repository without remotes -----

test('when git cannot list the remotes, the harness says so and holds none; outside a repository there is nothing to say', () => {
  const d = repoWithCommit();
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/mine.git');
  assert.deepEqual(detectHarness(d, ['a.txt']).remotes, [{ name: 'origin', hasCredential: false }]);
  assert.equal(detectHarness(d, ['a.txt']).remotesError, null);

  const blind = detectHarness(d, ['a.txt'], { env: envWithoutGit() });
  assert.deepEqual(blind.remotes, []);
  assert.equal(blind.remotesError, 'git is not installed or not on PATH');

  const plain = detectHarness(dir(), []);
  assert.deepEqual([plain.remotes, plain.remotesError], [[], null]);
});

test('P4.remote does not propose adding a remote when git could not say whether there is one, and P0.security says the remotes were not checked', () => {
  const d = repoWithCommit();
  const stack = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
  const checksFor = harness => buildGaps({ stack, harness, exposures: [], profile: selectProfile(stack), git: { branch: 'feature/x', isRepo: true }, files: ['a.txt'] });
  const blind = checksFor(detectHarness(d, ['a.txt'], { env: envWithoutGit() }));
  const remote = blind.find(c => c.id === 'P4.remote');
  assert.equal(remote.state, 'absent');
  assert.equal(remote.proposal, null);
  assert.deepEqual(remote.evidence, ['git could not list this repository\'s remotes (git is not installed or not on PATH), so it is not known whether it has one']);
  assert.ok(blind.find(c => c.id === 'P0.security').evidence.includes('remote URLs were not checked for a token: git could not list the remotes (git is not installed or not on PATH)'));

  const seen = checksFor(detectHarness(d, ['a.txt']));
  assert.equal(seen.find(c => c.id === 'P4.remote').proposal, 'add a git remote so the harness is backed up off this machine');
  assert.ok(!seen.find(c => c.id === 'P0.security').evidence.some(e => e.includes('remote URLs')));
});
