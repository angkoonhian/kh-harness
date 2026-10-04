// scripts/lib/cli.test.mjs
//
// Whole-branch review, F5 and F10. F10 is three entry points with three
// argument conventions, the odd one out being the command that deletes
// files; F5 is that none of the three had a `--help` while the only document
// written for a user said the tool "cannot yet apply anything".
//
// Both halves are tested here: the shared parser directly, and each real CLI
// through a real process — because `--help` that is not reachable from the
// command line is not help.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseArgv, wantsHelp, APPLY_USAGE, DETECT_USAGE, UNINSTALL_USAGE, EXECUTION_DISCLOSURE, EXIT_CODES,
} from './cli.mjs';

const DETECT = resolve(import.meta.dirname, '..', 'detect.mjs');
const APPLY = resolve(import.meta.dirname, '..', 'apply.mjs');
const UNINSTALL = resolve(import.meta.dirname, '..', 'uninstall.mjs');
const README = resolve(import.meta.dirname, '..', '..', 'README.md');
const cli = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

// --- the shared parser ----------------------------------------------------

test('parseArgv splits flags from the first non-flag argument, in either order', () => {
  const known = new Set(['--yes']);
  for (const argv of [['--yes', '/repo'], ['/repo', '--yes']]) {
    const r = parseArgv(argv, known);
    assert.equal(r.target, '/repo', `order must not matter: ${JSON.stringify(argv)}`);
    assert.ok(r.flags.has('--yes'));
    assert.deepEqual(r.unknown, []);
  }
});

test('parseArgv reports an unknown flag rather than ignoring it', () => {
  assert.deepEqual(parseArgv(['/repo', '--yse'], new Set(['--yes'])).unknown, ['--yse']);
});

test('parseArgv returns target null when none was given, leaving the default to the caller', () => {
  // detect/apply default to the cwd; uninstall refuses, because there is no
  // safe default for a command that removes files.
  assert.equal(parseArgv(['--yes'], new Set(['--yes'])).target, null);
});

test('wantsHelp accepts both spellings, in one place, so they cannot diverge per command', () => {
  assert.equal(wantsHelp(['--help']), true);
  assert.equal(wantsHelp(['-h']), true);
  assert.equal(wantsHelp(['/repo']), false);
});

// --- F10: `uninstall` had no flag parsing at all ---------------------------

test('F10: `uninstall --yes <path>` is understood — it used to say "repository not found: --yes"', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-cli-uninst-'));
  const r = cli(UNINSTALL, '--yes', d);
  assert.equal(r.status, 3, 'no manifest here, so a refusal (3) — never "repository not found" (2)');
  assert.equal(r.stderr.includes('repository not found'), false, r.stderr);
  assert.match(r.stderr + r.stdout, /no manifest found/);
});

test('F10: `uninstall` warns about a mistyped flag, like the two commands that already did', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-cli-uninst-'));
  const r = cli(UNINSTALL, d, '--yse');
  assert.match(r.stderr, /unknown flag/i);
  assert.match(r.stderr, /--yse/);
});

test('F10: a missing path is still a refusal, not a crash, and points at --help', () => {
  const r = cli(UNINSTALL);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
  assert.match(r.stderr, /--help/);
});

// --- F5: `--help` on all three, reachable from the command line -----------

for (const [name, script, usage] of [
  ['detect', DETECT, DETECT_USAGE],
  ['apply', APPLY, APPLY_USAGE],
  ['uninstall', UNINSTALL, UNINSTALL_USAGE],
]) {
  test(`F5: \`${name} --help\` prints its usage on stdout and exits 0, writing nothing`, () => {
    for (const flag of ['--help', '-h']) {
      const r = cli(script, flag);
      assert.equal(r.status, 0, `${name} ${flag}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), usage.trim());
      assert.equal(r.stderr, '', 'help is not a warning');
    }
  });

  test(`F5: \`${name} --help\` names every flag that command accepts, and the exit codes`, () => {
    const r = cli(script, '--help');
    assert.ok(r.stdout.includes(EXIT_CODES), 'the exit-code contract is part of every command\'s help');
    // Every flag the command actually honours must be discoverable: the
    // review's point is that a user who cannot find out `--allow-dirty`
    // exists reaches for `--yes` on a dirty tree and does not understand
    // the refusal.
    const declared = readFileSync(script, 'utf8')
      .match(/const KNOWN_FLAGS = new Set\(\[([^\]]*)\]\)/)[1]
      .match(/'(--?[\w-]+)'/g).map(s => s.replaceAll("'", ''))
      .filter(f => f !== '--help' && f !== '-h');
    assert.ok(declared.length > 0, 'fixture sanity: the flag list must have been found');
    for (const flag of declared) {
      assert.ok(r.stdout.includes(flag), `${name} --help does not mention ${flag}`);
    }
  });
}

test('F5: apply\'s help discloses, in so many words, that this repository\'s own scripts will be executed', () => {
  const out = cli(APPLY, '--help').stdout;
  assert.ok(out.includes(EXECUTION_DISCLOSURE), 'the shared disclosure must be present verbatim');
  assert.match(out, /lint/);
  assert.match(out, /typecheck/);
  assert.match(out, /AUTOMATICALLY/);
});

// --- F5: the README said the tool cannot do what two of three plans built --

test('F5: the README documents apply and uninstall, and no longer claims detection only', () => {
  const readme = readFileSync(README, 'utf8');
  assert.ok(readme.includes('scripts/apply.mjs'), 'apply.mjs is the point of the work and was mentioned nowhere');
  assert.ok(readme.includes('scripts/uninstall.mjs'));
  assert.equal(/cannot yet apply anything/.test(readme), false, 'the one document written for a user must not be false');
});

test('F5: the README documents every flag the three CLIs accept', () => {
  const readme = readFileSync(README, 'utf8');
  for (const script of [DETECT, APPLY, UNINSTALL]) {
    const declared = readFileSync(script, 'utf8')
      .match(/const KNOWN_FLAGS = new Set\(\[([^\]]*)\]\)/)[1]
      .match(/'(--?[\w-]+)'/g).map(s => s.replaceAll("'", ''))
      .filter(f => f !== '-h');
    for (const flag of declared) assert.ok(readme.includes(flag), `README does not document ${flag}`);
  }
});

test('F5: the README discloses that installing the hooks executes this repository\'s own scripts', () => {
  const readme = readFileSync(README, 'utf8');
  // The review's §3 point: "the worst thing a hostile repository can make
  // this tool do is the thing it is designed to do, and nothing durable says
  // so." This is the durable place.
  assert.match(readme, /lint/);
  assert.match(readme, /typecheck/);
  assert.match(readme, /automatic/i);
  assert.ok(readme.includes('.claude/kh-harness.manifest.json'), 'the manifest is part of the contract a user must know');
});
