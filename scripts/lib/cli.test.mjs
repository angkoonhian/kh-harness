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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseArgv, wantsHelp, APPLY_USAGE, DETECT_USAGE, UNINSTALL_USAGE, EXECUTION_DISCLOSURE, EXIT_CODES,
} from './cli.mjs';
import { sandboxDataDir } from './lifecycle-fixtures.mjs';
import { ENTRY_SCRIPTS } from './hook-evidence.mjs';
import { GENERATORS, GENERATOR_SCRIPT_PATHS } from './propose.mjs';
import { LOGGED_EVENTS } from '../../assets/scripts/session-log.mjs';

sandboxDataDir();

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

test('the guide names the three entry scripts, the core and the merge check wherever it counts the kit\'s scripts or lists its checks', () => {
  const how = readFileSync(resolve(import.meta.dirname, '..', '..', 'docs/guide/how-it-works.md'), 'utf8');
  for (const name of ['dispatch-pre-tool.mjs', 'dispatch-post-tool.mjs', 'dispatch-tool-failure.mjs', 'harness-dispatch.mjs', 'P0.hookmerge']) assert.ok(how.includes(name), name);
  assert.match(how, /7 hook scripts, 3 entry scripts and 5 modules/);
  assert.doesNotMatch(how, /states no order between them/);
  assert.match(readFileSync(README, 'utf8'), /dispatch-pre-tool\.mjs/);
});

test('the execution disclosure names the UserPromptSubmit re-injection hook and says it executes nothing', () => {
  assert.match(EXECUTION_DISCLOSURE, /UserPromptSubmit/);
  // The disclosure wraps at ~75 columns, so "executes" and "nothing" may sit
  // on different lines — \s+ tolerates the reflow (same lesson as
  // skill-prompts.test.mjs's cross-file sweep).
  assert.match(EXECUTION_DISCLOSURE, /UserPromptSubmit[\s\S]{0,400}executes\s+nothing/i);
  assert.match(EXECUTION_DISCLOSURE, /1500\s+bytes/);
});

test('the execution disclosure says the gate hook runs before every tool call, can block one, and has no gate until one is learned and promoted', () => {
  assert.match(EXECUTION_DISCLOSURE, /PreToolUse[\s\S]{0,80}before\s+every\s+tool\s+call/);
  assert.match(EXECUTION_DISCLOSURE, /BLOCK\s+the\s+call\s+when\s+a\s+gate\s+with\s+action\s+`block`\s+matches/);
  assert.match(EXECUTION_DISCLOSURE, /no\s+gate\s+exists\s+until\s+one\s+is\s+learned\s+and\s+promoted/);
});

// --- The disclosure covers every hook apply installs ------------------------

const disclosed = EXECUTION_DISCLOSURE.replace(/\s+/g, ' ');

test('the execution disclosure names every event a hook generator registers on, and how many hook scripts there are', () => {
  const stack = { packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: ['lint', 'typecheck'] }], languages: ['typescript'], isWorkspace: false, packageManager: null, ci: [] };
  const fresh = { claudeDir: {}, rulesRegistry: { count: 1, injectable: 1 } };
  // An install whose logging hook is on every event gets the other hooks of
  // the tool-call events by themselves, so between them the two harnesses
  // reach every script a generator can register.
  const loggedEverywhere = { ...fresh, claudeDir: { hookRegistrations: Object.fromEntries(LOGGED_EVENTS.map(e => [e, [{ script: '.claude/scripts/session-log.mjs', matcher: null }]])) } };
  const events = new Set();
  const scripts = new Set();
  for (const harness of [fresh, loggedEverywhere]) {
    for (const [id, generate] of Object.entries(GENERATORS)) {
      if (id === 'P0.kitskew') continue;
      for (const p of generate({ kitVersion: '0.2.0', stack, harness, files: [], checks: [], check: { evidence: [] }, manifest: null })) {
        if (p.kind !== 'settings-hook') continue;
        events.add(p.event);
        scripts.add(p.entry.args[0]);
      }
    }
  }
  assert.ok(events.size >= LOGGED_EVENTS.length, 'fixture sanity: the generators registered their hooks');
  for (const event of events) assert.ok(disclosed.includes(event), `the disclosure does not name ${event}`);
  assert.deepEqual([...scripts].map(s => s.split('/').pop()).sort(), GENERATOR_SCRIPT_PATHS.map(s => s.split('/').pop()).sort());
  assert.equal(GENERATOR_SCRIPT_PATHS.length - Object.keys(ENTRY_SCRIPTS).length, 7, 'the disclosure says seven; a hook script added changes that sentence and gets its own entry');
  assert.match(disclosed, /registers up to seven hook scripts/);
  assert.match(disclosed, /three entry scripts/);
  assert.doesNotMatch(disclosed, /the two process hooks/);
});

test('the execution disclosure says the prompt hook reads the learned registry as well as the owner\'s', () => {
  assert.match(disclosed, /UserPromptSubmit \(per prompt\) reads docs\/harness\/RULES\.md and docs\/harness\/LEARNED\.md/);
});

test('the execution disclosure says what the loop-warning hook reads, keeps and adds, and that it executes nothing', () => {
  const entry = /PostToolUseFailure \(per failed call\) (.*?) (?=PreToolUse \(per tool call\))/.exec(disclosed)?.[1] ?? '';
  assert.match(entry, /the failed call's tool name, its input and the first line of its error/);
  assert.match(entry, /keeps only a hash of them/);
  assert.match(entry, /way three times with no different failure\s+between them/);
  assert.doesNotMatch(entry, /in a row/, 'a success between two of the failures is not seen, so the count is not of failures in a row');
  assert.match(entry, /prints nothing of the call/);
  assert.match(entry, /executes nothing/);
});

test('the execution disclosure says which hooks run this repository\'s scripts and that the others run none', () => {
  assert.match(disclosed, /Two of them run THIS REPOSITORY'S OWN SCRIPTS AUTOMATICALLY/);
  assert.match(disclosed, /The other five run nothing of this repository's/);
  assert.match(disclosed, /SessionStart \(per session\) reads HANDOFF\.md \(or docs\/HANDOFF\.md\)/);
});

test('the execution disclosure names the terminal check for what it checks', () => {
  assert.match(disclosed, /behind their own check for an interactive terminal outside Claude Code/);
  assert.doesNotMatch(disclosed, /a person at a terminal/);
});

// --- One repository per run -------------------------------------------------

for (const [name, script] of [['detect', DETECT], ['apply', APPLY], ['uninstall', UNINSTALL]]) {
  test(`${name} refuses a second path with exit 2, naming it, and touches neither repository`, () => {
    const first = mkdtempSync(join(tmpdir(), 'hk-cli-a-'));
    const second = mkdtempSync(join(tmpdir(), 'hk-cli-b-'));
    const r = name === 'detect' ? cli(script, first, second) : cli(script, first, second, '--yes');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`^kh-harness: unexpected argument\\(s\\): .*hk-cli-b-.*\\nusage: ${name} <repo-path>`));
    assert.equal(r.stdout, '');
    for (const d of [first, second]) assert.deepEqual(readdirSync(d), [], 'nothing was written');
  });
}

// --- What a dry run is refused for, said as it is ---------------------------

test('apply refuses a manifest it cannot read with exit 3, dry run or not, and its usage says so', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-cli-corrupt-'));
  mkdirSync(join(d, '.claude'));
  writeFileSync(join(d, '.claude/kh-harness.manifest.json'), '{not json');
  for (const flags of [[], ['--yes', '--allow-dirty', '--allow-default-branch']]) {
    const r = cli(APPLY, d, ...flags);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /could not be read as a valid kh-harness manifest/);
  }
  const usage = APPLY_USAGE.replace(/\s+/g, ' ');
  assert.doesNotMatch(usage, /a dry run is never refused/);
  assert.match(usage, /Both gates apply to --yes only: a dry run prints a `note:` for what --yes would refuse, and exits 0\./);
  assert.match(usage, /A manifest that is there and cannot be read is refused \(3\) with or without --yes/);
});

test('each command\'s usage says which of the shared exit codes it uses, and for what', () => {
  const flat = text => text.replace(/\s+/g, ' ');
  assert.match(flat(EXIT_CODES), /2 could not act \(.*\) 3 refused to act \(/);
  assert.match(flat(DETECT_USAGE), /detect refuses nothing, so it never exits 3\./);
  const uninstall = flat(UNINSTALL_USAGE);
  for (const cause of ['a removal that failed', 'a file that changed after the plan was made', 'a recorded path it refused to remove', 'a settings patch it could not revert', 'a manifest it could not update or remove']) {
    assert.ok(uninstall.includes(cause), `uninstall's usage does not list "${cause}" under exit 2`);
  }
  assert.match(uninstall, /Here 3 is no manifest, or one that cannot be read, with or without --yes\./);
  assert.match(flat(APPLY_USAGE), /Here 3 is --yes on the default branch/);
});

test('--help needs no entry among a command\'s known flags: it is answered before they are read', () => {
  for (const script of [DETECT, APPLY, UNINSTALL]) {
    const known = readFileSync(script, 'utf8').match(/const KNOWN_FLAGS = new Set\(\[([^\]]*)\]\)/)[1];
    assert.doesNotMatch(known, /'--help'|'-h'/);
    for (const flag of ['--help', '-h']) assert.equal(cli(script, flag).stderr, '', 'and is not warned about as unknown');
  }
});

test('the execution disclosure says log purge --yes is denied with the learn subcommands, and why', () => {
  assert.match(disclosed, /deny rules for running the `learn` subcommands that approve or weaken a gate, and `log purge --yes`, which removes them with this machine's ledger/);
});
