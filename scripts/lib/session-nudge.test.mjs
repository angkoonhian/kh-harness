import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { KIT_VERSION, emptyManifest } from './manifest.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'session-nudge.mjs');

// The hook is run the way Claude Code runs it: from the plugin, with the
// project named by CLAUDE_PROJECT_DIR. The working directory is set to the
// project as well, so a test also passes if the variable were ignored only
// where the two agree; the tests that pin the variable set them apart.
const run = (dir, env = {}) => execFileSync(process.execPath, [SCRIPT], {
  cwd: dir, encoding: 'utf8', input: '{}',
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, KH_HARNESS_NUDGE: '', ...env },
});

const tempDir = () => mkdtempSync(join(tmpdir(), 'hk-nudge-'));
const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
const repo = () => { const d = tempDir(); gitIn(d, 'init', '-q'); return d; };
const install = (dir, kitVersion) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'kh-harness.manifest.json'), JSON.stringify(emptyManifest(kitVersion)));
};
const nextMinor = v => v.replace(/^(\d+)\.(\d+)\.\d+$/, (_, a, b) => `${a}.${Number(b) + 1}.0`);

test('a repository without the kit is named as such, with the skill to offer and how to silence it', () => {
  const out = run(repo());
  assert.match(out, /no kh-harness harness/);
  assert.match(out, /\/kh-harness:harness-init/, 'the notice names the skill by its plugin-qualified name');
  // The skill writes files and hooks into the repository, so the notice
  // must leave the install to the user's yes, never to Claude's initiative.
  assert.match(out, /only if the user agrees/);
  assert.match(out, /git config kh-harness\.nudge off/);
  assert.match(out, /KH_HARNESS_NUDGE=off/);
});

test('a repository whose harness is at this kit version gets no output at all', () => {
  const d = repo();
  install(d, KIT_VERSION);
  // Silence, not a reassurance line: the repository's own session-brief hook
  // already speaks at session start, and two hooks saying "all is well"
  // spend the context window on nothing.
  assert.equal(run(d), '');
});

test('a repository whose harness is older than the plugin is told both versions and offered the upgrade', () => {
  const d = repo();
  install(d, '0.0.1');
  const out = run(d);
  assert.match(out, /0\.0\.1/);
  assert.ok(out.includes(KIT_VERSION), 'names the version the plugin would install');
  assert.match(out, /\/kh-harness:harness-init/);
  assert.match(out, /only if the user agrees/);
});

test('a repository whose harness is newer than the plugin is told to update the plugin, not the repository', () => {
  const d = repo();
  const newer = nextMinor(KIT_VERSION);
  install(d, newer);
  const out = run(d);
  assert.ok(out.includes(newer));
  assert.match(out, /plugin is older/);
  // Offering harness-init here would propose writing the older kit's files
  // over the newer one's.
  assert.doesNotMatch(out, /harness-init/);
});

test('a manifest that cannot be read is reported, pointing at detect rather than at an install', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'));
  writeFileSync(join(d, '.claude', 'kh-harness.manifest.json'), '{ not json');
  const out = run(d);
  assert.match(out, /cannot be read/);
  assert.match(out, /detect/);
  assert.doesNotMatch(out, /no kh-harness harness/, 'a corrupt manifest is not a missing one');
});

test('a folder that is not a git repository gets no output', () => {
  // The kit installs only into repositories, so a session in a home folder
  // or a scratch directory has nothing to be offered.
  assert.equal(run(tempDir()), '');
});

test('the kit is found at the repository top when the session starts in a subfolder', () => {
  const d = repo();
  install(d, KIT_VERSION);
  const sub = join(d, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  assert.equal(run(sub), '', 'an installed repository opened from a subfolder is still installed');
});

test('the project is the one CLAUDE_PROJECT_DIR names, not the working directory', () => {
  const installed = repo();
  install(installed, KIT_VERSION);
  const out = execFileSync(process.execPath, [SCRIPT], {
    cwd: repo(), encoding: 'utf8', input: '{}',
    env: { ...process.env, CLAUDE_PROJECT_DIR: installed, KH_HARNESS_NUDGE: '' },
  });
  assert.equal(out, '');
});

test('git config kh-harness.nudge off silences the notice for that repository only', () => {
  const quiet = repo();
  gitIn(quiet, 'config', 'kh-harness.nudge', 'off');
  assert.equal(run(quiet), '');
  assert.match(run(repo()), /no kh-harness harness/, 'another repository is still told');
});

test('KH_HARNESS_NUDGE=off silences every notice, including an outdated harness', () => {
  assert.equal(run(repo(), { KH_HARNESS_NUDGE: 'off' }), '');
  const d = repo();
  install(d, '0.0.1');
  assert.equal(run(d, { KH_HARNESS_NUDGE: 'off' }), '');
});

test('the kit\'s own repository is not offered the kit', () => {
  assert.equal(run(ROOT), '');
});

test('the plugin ships exactly one hook: this SessionStart notice, run through node with the plugin root', () => {
  const { hooks } = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks), ['SessionStart'],
    'any other event would fire beside the hook apply installs for it, with no per-plugin way to stop it');
  const [group] = hooks.SessionStart;
  assert.equal(hooks.SessionStart.length, 1);
  assert.equal(group.hooks.length, 1);
  const [hook] = group.hooks;
  assert.equal(hook.type, 'command');
  assert.equal(hook.command, 'node');
  assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/session-nudge.mjs']);
  assert.ok(Number.isInteger(hook.timeout) && hook.timeout > 0 && hook.timeout <= 15);
});
