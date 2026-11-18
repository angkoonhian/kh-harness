// scripts/lib/harness-log.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalJson,
  dataRoot,
  GATES_PATH,
  isEnabled,
  LOCAL_GATES_FILE,
  readConfig,
  repoDataDir,
  repoKey,
  setEnabled,
} from '../../assets/scripts/harness-log.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-log-data-');

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function gitRepo() {
  const d = tempDir('hk-log-repo-');
  execFileSync('git', ['init', '-q', d]);
  writeFileSync(join(d, 'a.txt'), 'a\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

test('two worktrees of one repository map to one key', () => {
  const main = gitRepo();
  const wt = join(tempDir('hk-log-wt-'), 'wt');
  git(main, 'worktree', 'add', '-q', wt);
  assert.match(repoKey(main), /^[0-9a-f]{16}$/);
  assert.equal(repoKey(wt), repoKey(main));
  assert.equal(repoDataDir(wt), repoDataDir(main));
});

test('different repositories map to different keys', () => {
  assert.notEqual(repoKey(gitRepo()), repoKey(gitRepo()));
});

test('a .git file whose git directory has no commondir keys on that git directory', () => {
  const gitDir = join(tempDir('hk-log-gitdir-'), 'modules', 'sub');
  mkdirSync(gitDir, { recursive: true });
  const a = tempDir('hk-log-sub-a-');
  const b = tempDir('hk-log-sub-b-');
  writeFileSync(join(a, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(b, '.git'), `gitdir: ${gitDir}\n`);
  assert.equal(repoKey(a), repoKey(b));
  assert.notEqual(repoKey(a), repoKey(tempDir('hk-log-plain-')));
});

test('a path differing only in case or separator maps to the same key on win32', { skip: process.platform !== 'win32' }, () => {
  const plain = tempDir('hk-log-case-');
  const variant = p => p.toUpperCase().replace(/\\/g, '/');
  assert.equal(repoKey(variant(plain)), repoKey(plain));
  const repo = gitRepo();
  assert.equal(repoKey(variant(repo)), repoKey(repo));
});

test('a non-git directory gets a key', () => {
  const d = tempDir('hk-log-nogit-');
  assert.match(repoKey(d), /^[0-9a-f]{16}$/);
  assert.equal(repoKey(d), repoKey(d));
  assert.notEqual(repoKey(d), repoKey(tempDir('hk-log-nogit-')));
});

test('a malformed .git file is treated as a non-git directory', () => {
  const d = tempDir('hk-log-badgit-');
  writeFileSync(join(d, '.git'), 'not a gitdir line\n');
  assert.match(repoKey(d), /^[0-9a-f]{16}$/);
});

test('nothing is enabled by default', () => {
  const d = gitRepo();
  assert.equal(isEnabled(d), false);
  assert.equal(existsSync(repoDataDir(d)), false, 'asking writes nothing');
  setEnabled(d, true);
  assert.equal(isEnabled(d), true);
  assert.ok(existsSync(join(repoDataDir(d), 'enabled.json')));
  setEnabled(d, false);
  assert.equal(isEnabled(d), false);
});

test('an unreadable enabled.json means disabled', () => {
  const d = tempDir('hk-log-badflag-');
  mkdirSync(repoDataDir(d), { recursive: true });
  writeFileSync(join(repoDataDir(d), 'enabled.json'), '{ not json');
  assert.equal(isEnabled(d), false);
});

test('KH_DATA_DIR overrides the location', () => {
  const previous = process.env.KH_DATA_DIR;
  const override = tempDir('hk-log-override-');
  process.env.KH_DATA_DIR = override;
  try {
    const d = gitRepo();
    assert.equal(dataRoot(), override);
    assert.equal(repoDataDir(d), join(override, repoKey(d)));
    setEnabled(d, true);
    assert.ok(existsSync(join(override, repoKey(d), 'enabled.json')));
  } finally {
    process.env.KH_DATA_DIR = previous;
  }
});

test('with no config file the defaults apply', () => {
  assert.deepEqual(readConfig(tempDir('hk-log-cfg-')), { contentRetentionDays: 90, inlineCapBytes: 65536, autodraft: false });
});

test('a valid config overrides the defaults it names', () => {
  const d = tempDir('hk-log-cfg-');
  mkdirSync(repoDataDir(d), { recursive: true });
  writeFileSync(join(repoDataDir(d), 'config.json'), JSON.stringify({ contentRetentionDays: 30, autodraft: true }));
  assert.deepEqual(readConfig(d), { contentRetentionDays: 30, inlineCapBytes: 65536, autodraft: true });
});

test('an unreadable config yields the defaults and says so', () => {
  const d = tempDir('hk-log-cfg-');
  mkdirSync(repoDataDir(d), { recursive: true });
  const defaults = { contentRetentionDays: 90, inlineCapBytes: 65536, autodraft: false, configUnreadable: true };
  for (const body of ['{ not json', '[]', 'null', JSON.stringify({ contentRetentionDays: -1 }), JSON.stringify({ inlineCapBytes: '64k' }), JSON.stringify({ autodraft: 'yes' })]) {
    writeFileSync(join(repoDataDir(d), 'config.json'), body);
    assert.deepEqual(readConfig(d), defaults, body);
  }
});

test('the gate locations are exported for later readers', () => {
  assert.equal(GATES_PATH, '.claude/kh-harness/gates.json');
  assert.equal(LOCAL_GATES_FILE, 'gates.local.json');
});

test('canonicalJson: key order does not change the output', () => {
  assert.equal(canonicalJson({ b: 1, a: 2, 10: 3, 9: 4 }), canonicalJson({ 9: 4, a: 2, 10: 3, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2, 10: 3, 9: 4 }), '{"10":3,"9":4,"a":2,"b":1}');
});

test('canonicalJson: arrays keep their order', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('canonicalJson: nested objects are sorted', () => {
  assert.equal(
    canonicalJson({ z: { y: [{ b: 'x', a: null }], x: true }, a: 'q' }),
    '{"a":"q","z":{"x":true,"y":[{"a":null,"b":"x"}]}}',
  );
});
