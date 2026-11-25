// scripts/lib/hook-merge-lifecycle.test.mjs — an install made before the
// entry scripts, with two kit hooks registered separately on each tool-call
// event, moved to one entry script per event by `apply`, end to end through
// the real CLIs on a real installed repository.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyProposals, SETTINGS_PATH } from './apply-lib.mjs';
import { EXECUTION_DISCLOSURE } from './cli.mjs';
import { detectExposures } from './detect-exposure.mjs';
import { detectHarness } from './detect-harness.mjs';
import { detectStack } from './detect-stack.mjs';
import { buildGaps } from './gap-model.mjs';
import { gitInfo } from './git-info.mjs';
import { ENTRY_SCRIPTS, execEntry } from './hook-evidence.mjs';
import { APPLY, DETECT, LOG, UNINSTALL, fixtureWithLint, git, kitAt, manifestOf, run, runEveryRegisteredHook, runResult, sandboxDataDir, separateRegistrations, settings } from './lifecycle-fixtures.mjs';
import { emptyManifest, KIT_VERSION, MANIFEST_PATH, readManifestResult, replaceFile, writeManifest } from './manifest.mjs';
import { selectProfile } from './profiles/index.mjs';
import { buildProposals, DISPATCH_FAILURE_PATH, DISPATCH_POST_PATH, DISPATCH_PRE_PATH, GENERATORS, SESSION_LOG_PATH } from './propose.mjs';
import { DETECT_REPORT_PATH } from './report.mjs';
import { listFiles } from './scan.mjs';
import { buildMatcherEntry, hookEntrySha256, matcherEntrySha256 } from './settings-merge.mjs';
import { harnessIdentity } from '../../assets/scripts/harness-log.mjs';
import { LOGGED_EVENTS } from '../../assets/scripts/session-log.mjs';

sandboxDataDir();

const KIT_BEFORE_MERGE = 'eead407';
const old = kitAt(KIT_BEFORE_MERGE);
const skip = old === null ? `commit ${KIT_BEFORE_MERGE} is not in this checkout (a shallow clone); fetch the full history to run this` : false;

const commit = (d, message) => {
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
};
/** What every hook on `event` that runs a script under `.claude/scripts/`
 * runs. */
const kitEntriesOn = (d, event) => (settings(d).hooks?.[event] ?? []).flatMap(m => m.hooks ?? []).map(h => h.args?.[0] ?? h.command).filter(a => a.includes('.claude/scripts/'));
const checkOf = (d, id) => JSON.parse(run(DETECT, d, '--json')).checks.find(c => c.id === id);
const writeJson = (d, rel, value) => writeFileSync(join(d, rel), JSON.stringify(value, null, 2) + '\n');
const kitScriptsOnDisk = d => (existsSync(join(d, '.claude/scripts')) ? readdirSync(join(d, '.claude/scripts')) : []);

/** A committed install in the layout the kit wrote before the entry
 * scripts, and the settings file as it was before the install. */
function installedSeparately() {
  const d = fixtureWithLint();
  const original = readFileSync(join(d, SETTINGS_PATH), 'utf8');
  run(APPLY, d, '--yes');
  separateRegistrations(d);
  commit(d, 'install kh-harness with separate registrations');
  return { d, original };
}

/** Asserts each tool-call event of `d` runs its entry script and nothing
 * else of the kit's. */
function assertMerged(d) {
  for (const [event, { path }] of Object.entries(ENTRY_SCRIPTS)) assert.deepEqual(kitEntriesOn(d, event), [`\${CLAUDE_PROJECT_DIR}/${path}`], event);
}

/** Asserts the manifest records exactly the entry script on each tool-call
 * event of `d`. */
function assertRecordsMerged(d) {
  for (const [event, { path }] of Object.entries(ENTRY_SCRIPTS)) {
    assert.deepEqual(manifestOf(d).settingsPatches.filter(p => p.event === event).map(p => p.entrySha256), [hookEntrySha256(execEntry(path))], event);
  }
}

test('apply on an install with separate registrations proposes exactly one replacement per tool-call event, and a second apply proposes nothing', () => {
  const { d } = installedSeparately();
  const merge = checkOf(d, 'P0.hookmerge');
  assert.equal(merge.state, 'absent');
  assert.deepEqual(merge.evidence, Object.keys(ENTRY_SCRIPTS).map(event => `${event}: 2 kh-harness hooks are registered separately, one process each`));

  const dry = run(APPLY, d);
  assert.match(dry, /^kh-harness: 3 actions to close 1 capability gap /m);
  for (const event of Object.keys(ENTRY_SCRIPTS)) assert.ok(dry.includes(`--- .claude/settings.json (hook: ${event}, replacing 2 registrations)  [P0.hookmerge]`), event);
  assert.match(dry, /^-\s+"\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/scripts\/tool-gate\.mjs"$/m);
  assert.match(dry, /^\+\s+"\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/scripts\/dispatch-pre-tool\.mjs"$/m);
  assert.ok(dry.includes(EXECUTION_DISCLOSURE), 'the dry run says what the hooks it registers do');
  assert.ok(dry.indexOf(EXECUTION_DISCLOSURE) < dry.indexOf('\n--- '), 'before the first proposal, not after every diff');

  const out = run(APPLY, d, '--yes');
  for (const event of Object.keys(ENTRY_SCRIPTS)) assert.ok(out.includes(`patched    .claude/settings.json (${event}; 2 separate registrations removed)`), event);
  assertMerged(d);
  assert.equal(manifestOf(d).settingsPatches.filter(p => Object.hasOwn(ENTRY_SCRIPTS, p.event)).length, 3);
  for (const h of runEveryRegisteredHook(d)) assert.notEqual(h.status, 1, `${h.script} on ${h.event}: ${h.stderr}`);
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  const merged = checkOf(d, 'P0.hookmerge');
  assert.equal(merged.state, 'declared');
  assert.deepEqual(merged.evidence, Object.entries(ENTRY_SCRIPTS).map(([event, { path }]) => `${event}: one process — ${path} runs its hooks`));
});

test('log status on a migrated install still reports all sixteen events', () => {
  const { d } = installedSeparately();
  run(APPLY, d, '--yes');
  assert.equal(LOGGED_EVENTS.length, 16);
  assert.deepEqual(JSON.parse(run(LOG, d, 'status', '--json')).hookEvents, { registered: 16, logged: 16 });
});

test('uninstall after the migration leaves no entry script and no registration behind', () => {
  const { d, original } = installedSeparately();
  const base = git(d, 'rev-parse', 'HEAD~1').trim();
  run(APPLY, d, '--yes');
  run(UNINSTALL, d, '--yes');
  assert.deepEqual(kitScriptsOnDisk(d), []);
  assert.equal(readFileSync(join(d, SETTINGS_PATH), 'utf8'), original);
  const changed = [...git(d, 'diff', '--name-only', base).split('\n'), ...git(d, 'ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean);
  assert.deepEqual(changed.filter(path => path !== DETECT_REPORT_PATH), [], 'nothing differs from the repository before the install');
});

test('an event with one registration changed by the owner is left alone, and the others are migrated', () => {
  const { d } = installedSeparately();
  const s = settings(d);
  const gate = s.hooks.PreToolUse.find(m => m.hooks[0].args[0].endsWith('/tool-gate.mjs'));
  gate.hooks[0].timeout = 5;
  writeJson(d, SETTINGS_PATH, s);
  commit(d, 'the gate hook times out');

  const dry = run(APPLY, d);
  assert.equal(dry.includes('(hook: PreToolUse'), false);
  run(APPLY, d, '--yes');
  assert.equal(settings(d).hooks.PreToolUse.length, 2, 'both separate registrations are still there');
  assert.deepEqual(kitEntriesOn(d, 'PostToolUse'), [`\${CLAUDE_PROJECT_DIR}/${DISPATCH_POST_PATH}`]);
  assert.deepEqual(kitEntriesOn(d, 'PostToolUseFailure'), [`\${CLAUDE_PROJECT_DIR}/${DISPATCH_FAILURE_PATH}`]);
  const merge = checkOf(d, 'P0.hookmerge');
  assert.equal(merge.state, 'declared');
  assert.ok(merge.evidence.includes('PreToolUse: left on separate registrations — a registration of .claude/scripts/tool-gate.mjs is not as kh-harness recorded it'), JSON.stringify(merge.evidence));
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
});

test('an event from which the owner removed one hook is not merged; its own check proposes that hook again, separately', () => {
  const { d } = installedSeparately();
  const s = settings(d);
  s.hooks.PostToolUseFailure = s.hooks.PostToolUseFailure.filter(m => !m.hooks[0].args[0].endsWith('/session-log.mjs'));
  writeJson(d, SETTINGS_PATH, s);
  commit(d, 'no logging on failures');

  const dry = run(APPLY, d);
  assert.ok(dry.includes('--- .claude/settings.json (hook: PostToolUseFailure)  [P5.sessionlog]'), dry);
  assert.equal(dry.includes('(hook: PostToolUseFailure, replacing'), false);
  assert.ok(checkOf(d, 'P0.hookmerge').evidence.includes('PostToolUseFailure: left on separate registrations — a registration kh-harness recorded on PostToolUseFailure is no longer there'));
});

test('an event holding the entry script beside its hooks registered separately is left with the entry script alone', () => {
  const { d } = installedSeparately();
  const s = settings(d);
  s.hooks.PreToolUse.push(buildMatcherEntry(execEntry(DISPATCH_PRE_PATH)));
  writeJson(d, SETTINGS_PATH, s);
  const m = manifestOf(d);
  m.settingsPatches.push({ event: 'PreToolUse', container: '/hooks/PreToolUse', entrySha256: hookEntrySha256(execEntry(DISPATCH_PRE_PATH)), step: 30, checkId: 'P5.toolgate', appliedAt: '2026-11-01T00:00:00.000Z' });
  writeJson(d, MANIFEST_PATH, m);
  commit(d, 'the entry script beside the separate registrations');

  assert.ok(checkOf(d, 'P0.hookmerge').evidence.includes(`PreToolUse: ${DISPATCH_PRE_PATH} runs its hooks, and some of them are also registered by themselves, so those run twice`));
  assert.ok(run(APPLY, d).includes('--- .claude/settings.json (hook: PreToolUse, replacing 3 registrations)  [P0.hookmerge]'));
  const out = run(APPLY, d, '--yes');
  assert.ok(out.includes('patched    .claude/settings.json (PreToolUse; 2 separate registrations removed)'), out);
  assertMerged(d);
  assert.deepEqual(manifestOf(d).settingsPatches.filter(p => p.event === 'PreToolUse').map(p => p.entrySha256), [hookEntrySha256(execEntry(DISPATCH_PRE_PATH))]);
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
});

test('the harness identity does not move across an apply that has nothing to do', () => {
  const { d } = installedSeparately();
  run(APPLY, d, '--yes');
  const before = harnessIdentity(d).base;
  assert.match(run(APPLY, d, '--yes', '--allow-dirty'), /no actions/);
  assert.equal(harnessIdentity(d).base, before);
});

// --- A migration killed at either side of its settings write ---------------

/** The proposals `apply.mjs` builds for `root`, and the manifest it builds
 * them against. */
function proposalsFor(root) {
  const manifestResult = readManifestResult(root);
  const manifest = manifestResult.manifest ?? emptyManifest(KIT_VERSION);
  const { files, unreadableDirs } = listFiles(root);
  const stack = detectStack(root, files);
  const harness = detectHarness(root, files);
  harness.reconPresent = files.includes('docs/harness/recon.md');
  const exposures = detectExposures(root, files, harness, unreadableDirs);
  const checks = buildGaps({ stack, harness, exposures, profile: selectProfile(stack), git: gitInfo(root), files, root, manifest: manifestResult.manifest, kitVersion: KIT_VERSION });
  return { manifest, proposals: buildProposals({ checks, manifest, kitVersion: KIT_VERSION, harness, root, stack, files }) };
}

const KILLED = 'the run was killed here';

/** Leaves `root` as the migrating `apply --yes` killed at `point` leaves it,
 * with the manifest as it was on disk at the kill. */
function killMigrationAt(root, point) {
  const { manifest, proposals } = proposalsFor(root);
  assert.deepEqual(proposals.map(p => p.kind), ['settings-hook-replace', 'settings-hook-replace', 'settings-hook-replace'], 'fixture: the run is the migration');
  const manifestPath = join(root, MANIFEST_PATH);
  let onDiskAtKill = null;
  const result = applyProposals({
    root, proposals, manifest, kitVersion: KIT_VERSION,
    persistManifest: staged => writeManifest(root, staged),
    replaceSettings: (path, text) => {
      if (point === 'after-settings') replaceFile(path, text);
      onDiskAtKill = readFileSync(manifestPath);
      throw new Error(KILLED);
    },
  });
  assert.deepEqual(result.failed.map(f => f.error), [`failed to write ${SETTINGS_PATH}: ${KILLED}`]);
  writeFileSync(manifestPath, onDiskAtKill);
}

const copies = [];
after(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
});
function copyOf(d) {
  const copy = mkdtempSync(join(tmpdir(), 'hk-merge-copy-'));
  copies.push(copy);
  cpSync(d, copy, { recursive: true });
  return copy;
}

/** `uninstall --yes` takes out every kit script, entry and the manifest. */
function assertUninstallRecovers(d) {
  const result = runResult(UNINSTALL, d, '--yes');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(kitScriptsOnDisk(d), [], 'no kit script is left');
  assert.deepEqual(Object.keys(settings(d).hooks ?? {}).flatMap(event => kitEntriesOn(d, event)), [], 'no kit hook entry is left registered');
  assert.equal(existsSync(join(d, MANIFEST_PATH)), false, 'the manifest is removed');
}

test('a migration killed before its settings write is finished by the next apply, and uninstall removes everything either way', () => {
  const { d } = installedSeparately();
  killMigrationAt(d, 'before-settings');
  assert.equal(kitEntriesOn(d, 'PreToolUse').length, 2, 'fixture: the settings file is as it was');

  assertUninstallRecovers(copyOf(d));

  const resumed = copyOf(d);
  const out = run(APPLY, resumed, '--yes', '--allow-dirty');
  for (const event of Object.keys(ENTRY_SCRIPTS)) assert.ok(out.includes(`patched    .claude/settings.json (${event}; 2 separate registrations removed)`), event);
  assertMerged(resumed);
  assert.match(run(APPLY, resumed, '--allow-dirty'), /no actions/);
  assertUninstallRecovers(resumed);
});

test('a migration killed after its settings write reads as merged though the records of the removed registrations remain, and uninstall removes everything', () => {
  const { d } = installedSeparately();
  killMigrationAt(d, 'after-settings');
  assertMerged(d);
  assert.equal(manifestOf(d).settingsPatches.filter(p => Object.hasOwn(ENTRY_SCRIPTS, p.event)).length, 9, 'fixture: six records of removed registrations beside the three entry scripts\'');
  const merge = checkOf(d, 'P0.hookmerge');
  assert.equal(merge.state, 'declared');
  assert.deepEqual(merge.evidence, Object.entries(ENTRY_SCRIPTS).map(([event, { path }]) => `${event}: one process — ${path} runs its hooks`));
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  assertUninstallRecovers(d);
});

test('an install made by the kit at eead407 is merged by one apply', { skip }, () => {
  const d = fixtureWithLint();
  run(old.apply, d, '--yes');
  commit(d, `install kh-harness at ${KIT_BEFORE_MERGE}`);
  assert.deepEqual(kitEntriesOn(d, 'PreToolUse'), [`\${CLAUDE_PROJECT_DIR}/${SESSION_LOG_PATH}`, '${CLAUDE_PROJECT_DIR}/.claude/scripts/tool-gate.mjs'], 'fixture: the old layout');
  run(APPLY, d, '--yes');
  assertMerged(d);
  const checks = JSON.parse(run(DETECT, d, '--json')).checks;
  assert.deepEqual(checks.filter(c => c.proposal && c.id in GENERATORS).map(c => c.id), [], 'nothing is left to propose');
  assertRecordsMerged(d);
  for (const h of runEveryRegisteredHook(d)) assert.notEqual(h.status, 1, `${h.script} on ${h.event}: ${h.stderr}`);
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  assertUninstallRecovers(d);
});

// --- Forms a real install may have -------------------------------------------

/** Rewrites every kit hook on the tool-call events of `d` into the shell
 * form the kit wrote before the exec form, with the manifest's records of
 * them to match. */
function toShellForm(d) {
  const s = settings(d);
  const m = manifestOf(d);
  for (const event of Object.keys(ENTRY_SCRIPTS)) {
    s.hooks[event] = s.hooks[event].map(element => {
      const script = element.hooks[0].args[0].replace('${CLAUDE_PROJECT_DIR}/', '');
      const shell = { ...element, hooks: [{ type: 'command', command: `node ${script}` }] };
      const record = m.settingsPatches.find(p => p.event === event && p.entrySha256 === matcherEntrySha256(element));
      record.entrySha256 = matcherEntrySha256(shell);
      return shell;
    });
  }
  // Written as apply writes it, keeping whether the file ended in a newline.
  const ending = readFileSync(join(d, SETTINGS_PATH), 'utf8').endsWith('\n') ? '\n' : '';
  writeFileSync(join(d, SETTINGS_PATH), JSON.stringify(s, null, 2) + ending);
  writeJson(d, MANIFEST_PATH, m);
}

test('an install whose separate registrations are in the shell form is migrated, with one record per event', () => {
  const { d, original } = installedSeparately();
  toShellForm(d);
  commit(d, 'the shell form');
  assert.deepEqual(kitEntriesOn(d, 'PreToolUse'), [`node ${SESSION_LOG_PATH}`, 'node .claude/scripts/tool-gate.mjs'], 'fixture: the shell form');
  const out = run(APPLY, d, '--yes');
  for (const event of Object.keys(ENTRY_SCRIPTS)) assert.ok(out.includes(`patched    .claude/settings.json (${event}; 2 separate registrations removed)`), event);
  assertMerged(d);
  assertRecordsMerged(d);
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  run(UNINSTALL, d, '--yes');
  assert.equal(readFileSync(join(d, SETTINGS_PATH), 'utf8'), original);
});

test('a repository that ignores .claude/ is migrated through the install record', () => {
  const d = fixtureWithLint();
  writeFileSync(join(d, '.gitignore'), '.claude/\n');
  git(d, 'rm', '-q', '--cached', SETTINGS_PATH);
  commit(d, 'ignore .claude/');
  run(APPLY, d, '--yes');
  separateRegistrations(d);
  commit(d, 'install kh-harness with separate registrations');
  assert.equal(git(d, 'ls-files', '.claude').trim(), '', 'fixture: nothing under .claude/ is tracked');
  const merge = checkOf(d, 'P0.hookmerge');
  assert.equal(merge.state, 'absent', JSON.stringify(merge.evidence));
  const out = run(APPLY, d, '--yes');
  for (const event of Object.keys(ENTRY_SCRIPTS)) assert.ok(out.includes(`patched    .claude/settings.json (${event}; 2 separate registrations removed)`), event);
  assertMerged(d);
  assertRecordsMerged(d);
  assert.equal(checkOf(d, 'P0.hookmerge').state, 'declared');
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  assertUninstallRecovers(d);
});

test('a kit registration moved into .claude/settings.local.json leaves its event alone, and apply then has nothing to do', () => {
  const { d } = installedSeparately();
  const s = settings(d);
  const log = s.hooks.PreToolUse.find(m => m.hooks[0].args[0].endsWith('/session-log.mjs'));
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter(m => m !== log);
  writeJson(d, SETTINGS_PATH, s);
  writeJson(d, '.claude/settings.local.json', { hooks: { PreToolUse: [log] } });
  commit(d, 'the logging hook on PreToolUse is local');

  const merge = checkOf(d, 'P0.hookmerge');
  assert.ok(merge.evidence.includes('PreToolUse: left on separate registrations — a registration kh-harness recorded on PreToolUse is no longer there'), JSON.stringify(merge.evidence));
  assert.equal(run(APPLY, d).includes('(hook: PreToolUse'), false);
  run(APPLY, d, '--yes');
  assert.match(run(APPLY, d, '--allow-dirty'), /no actions/);
  assert.equal(readFileSync(join(d, DETECT_REPORT_PATH), 'utf8').includes('settingsFile'), false, 'which file a registration is in is not written to the committed report');
});
