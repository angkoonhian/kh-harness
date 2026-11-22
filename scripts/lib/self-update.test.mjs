import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { UPDATE_INTERVAL_MS, readUpdateState, selfUpdate, updateNotice, updateStatePath } from './self-update.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const NUDGE = join(ROOT, 'scripts', 'session-nudge.mjs');

const tempDir = () => mkdtempSync(join(tmpdir(), 'hk-update-'));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', stdio: 'pipe',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).trim();
const head = dir => git(dir, 'rev-parse', 'HEAD');

/** A bare origin with one commit on master, a clone standing in for the
 * plugin folder, and a second clone to publish new commits from. */
function setup() {
  const base = tempDir();
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '--bare', '-b', 'master', origin);
  git(base, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'push', '-q', 'origin', 'HEAD:master');
  const plugin = join(base, 'plugin');
  git(base, 'clone', '-q', origin, plugin);
  const publish = (file = 'a.txt', text = `${Math.random()}\n`) => {
    writeFileSync(join(seed, file), text);
    git(seed, 'add', file);
    git(seed, 'commit', '-q', '-m', 'more');
    git(seed, 'push', '-q', 'origin', 'HEAD:master');
    return head(seed);
  };
  return { base, origin, plugin, publish };
}

test('a plugin checkout behind its upstream is fast-forwarded to it, and the update is recorded', () => {
  const { plugin, publish } = setup();
  const before = head(plugin);
  const after = publish();
  const result = selfUpdate(plugin);
  assert.equal(result.outcome, 'updated');
  assert.equal(head(plugin), after);
  const state = readUpdateState(plugin);
  assert.equal(state.outcome, 'updated');
  assert.equal(state.from, before);
  assert.equal(state.to, after);
});

test('a checkout already at its upstream is left alone and recorded as current', () => {
  const { plugin } = setup();
  const before = head(plugin);
  assert.equal(selfUpdate(plugin).outcome, 'current');
  assert.equal(head(plugin), before);
});

test('a checkout with commits of its own and nothing new upstream is current, not diverged', () => {
  const { plugin } = setup();
  writeFileSync(join(plugin, 'b.txt'), 'mine\n');
  git(plugin, 'add', 'b.txt');
  git(plugin, 'commit', '-q', '-m', 'local');
  assert.equal(selfUpdate(plugin).outcome, 'current');
});

test('a checkout that has diverged from its upstream is not touched', () => {
  const { plugin, publish } = setup();
  writeFileSync(join(plugin, 'b.txt'), 'mine\n');
  git(plugin, 'add', 'b.txt');
  git(plugin, 'commit', '-q', '-m', 'local');
  const before = head(plugin);
  publish();
  const result = selfUpdate(plugin);
  assert.equal(result.outcome, 'diverged');
  assert.match(result.detail, /1 commit.*not on .*origin\/master/);
  assert.equal(head(plugin), before, 'never merges or rebases the owner\'s own commits');
});

test('a tracked change in the checkout stops the update; an untracked file does not', () => {
  const { plugin, publish } = setup();
  publish();
  writeFileSync(join(plugin, 'a.txt'), 'edited\n');
  const before = head(plugin);
  assert.equal(selfUpdate(plugin).outcome, 'dirty');
  assert.equal(head(plugin), before);
  assert.equal(readFileSync(join(plugin, 'a.txt'), 'utf8'), 'edited\n', 'the owner\'s edit is untouched');

  const clean = setup();
  const after = clean.publish();
  writeFileSync(join(clean.plugin, 'notes.json'), '{}');
  assert.equal(selfUpdate(clean.plugin).outcome, 'updated');
  assert.equal(head(clean.plugin), after);
});

test('a detached HEAD or a branch with no upstream is skipped', () => {
  const { plugin } = setup();
  git(plugin, 'switch', '-q', '--detach');
  assert.equal(selfUpdate(plugin, { now: () => 0 }).outcome, 'skipped');
  git(plugin, 'switch', '-q', '-c', 'loose');
  assert.equal(selfUpdate(plugin, { now: () => UPDATE_INTERVAL_MS }).outcome, 'skipped');
});

test('an upstream that cannot be reached is recorded as a failed fetch, without waiting for a password', () => {
  const { plugin } = setup();
  git(plugin, 'remote', 'set-url', 'origin', join(tempDir(), 'gone.git'));
  const result = selfUpdate(plugin);
  assert.equal(result.outcome, 'fetch-failed');
  assert.ok(result.detail.length > 0);
});

test('a second attempt within the interval does not fetch again', () => {
  const { plugin, publish } = setup();
  let now = 1_000_000;
  assert.equal(selfUpdate(plugin, { now: () => now }).outcome, 'current');
  const after = publish();
  now += UPDATE_INTERVAL_MS - 1;
  assert.equal(selfUpdate(plugin, { now: () => now }).outcome, 'throttled');
  assert.notEqual(head(plugin), after);
  now += 1;
  assert.equal(selfUpdate(plugin, { now: () => now }).outcome, 'updated');
  assert.equal(head(plugin), after);
});

test('a plugin that is not a git checkout of its own, such as a cached copy, is skipped and nothing is written', () => {
  const plain = tempDir();
  assert.equal(selfUpdate(plain).outcome, 'not-a-checkout');
  const { plugin } = setup();
  const sub = join(plugin, 'sub');
  mkdirSync(sub);
  assert.equal(selfUpdate(sub).outcome, 'not-a-checkout', 'a folder inside some other repository is not the plugin\'s checkout');
  assert.equal(existsSync(join(plugin, '.git', 'kh-harness-self-update.json')), false);
});

test('the notice reports an update once, and a failure once until it changes', () => {
  const { plugin, publish } = setup();
  publish();
  selfUpdate(plugin);
  const first = updateNotice(plugin);
  assert.match(first, /updated itself/);
  assert.equal(updateNotice(plugin), null, 'the same update is not reported twice');

  git(plugin, 'remote', 'set-url', 'origin', join(tempDir(), 'gone.git'));
  let now = Date.now() + UPDATE_INTERVAL_MS;
  selfUpdate(plugin, { now: () => now });
  assert.match(updateNotice(plugin), /could not update itself/);
  assert.equal(updateNotice(plugin), null);
  now += UPDATE_INTERVAL_MS;
  selfUpdate(plugin, { now: () => now });
  assert.equal(updateNotice(plugin), null, 'the same failure again is not reported again');
});

test('outcomes with nothing to say produce no notice', () => {
  const { plugin } = setup();
  selfUpdate(plugin);
  assert.equal(updateNotice(plugin), null);
  assert.equal(updateNotice(tempDir()), null, 'no checkout, no state, no notice');
});

test('the session-start hook starts the update in the background without waiting for it', async () => {
  const { plugin, publish } = setup();
  const after = publish();
  const project = tempDir();
  const started = Date.now();
  execFileSync(process.execPath, [NUDGE], {
    cwd: project, encoding: 'utf8', input: '{}',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: plugin, KH_HARNESS_NUDGE: '', KH_HARNESS_AUTO_UPDATE: '' },
  });
  const deadline = started + 30_000;
  // The record is written after the fast-forward, so it is what is waited on.
  while (readUpdateState(plugin)?.outcome !== 'updated' && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.equal(readUpdateState(plugin)?.outcome, 'updated');
  assert.equal(head(plugin), after);
});

test('KH_HARNESS_AUTO_UPDATE=off stops the hook from starting an update', async () => {
  const { plugin, publish } = setup();
  const before = head(plugin);
  publish();
  const project = tempDir();
  execFileSync(process.execPath, [NUDGE], {
    cwd: project, encoding: 'utf8', input: '{}',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: plugin, KH_HARNESS_NUDGE: '', KH_HARNESS_AUTO_UPDATE: 'off' },
  });
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(head(plugin), before);
  assert.equal(existsSync(updateStatePath(plugin)), false);
});
