// scripts/lib/lifecycle-kill.test.mjs — an `apply --yes` killed at either
// side of the one settings write, on a first install and on an upgrade from
// the 0.1.0 kit this repository's history holds. The state a kill leaves is
// made by the code `apply` runs: `applyProposals` is called as `apply.mjs`
// calls it, stopped at the settings write or before the last manifest write,
// and the CLIs are then run on what is on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import { applyProposals, SETTINGS_PATH } from './apply-lib.mjs';
import { detectExposures } from './detect-exposure.mjs';
import { detectHarness } from './detect-harness.mjs';
import { detectStack } from './detect-stack.mjs';
import { buildGaps } from './gap-model.mjs';
import { gitInfo } from './git-info.mjs';
import { APPLY, DETECT, fixture, git, kitAt, run, runEveryRegisteredHook, runResult, sandboxDataDir, settings, UNINSTALL } from './lifecycle-fixtures.mjs';
import { emptyManifest, KIT_VERSION, MANIFEST_PATH, readManifestResult, replaceFile, sha256, writeManifest } from './manifest.mjs';
import { planUninstall, runUninstall } from './uninstall-lib.mjs';
import { selectProfile } from './profiles/index.mjs';
import { buildProposals, CONTRACT_FILES, GENERATORS, installedScriptProposal, installedScriptStatus, kitContractText } from './propose.mjs';
import { listFiles } from './scan.mjs';

sandboxDataDir();

const KIT_0_1_0 = '681189d';
const old = kitAt(KIT_0_1_0);
const skipUpgrade = old === null ? `commit ${KIT_0_1_0} is not in this checkout (a shallow clone); fetch the full history to run this` : false;

/** The proposals `apply.mjs` builds for `root`, and the manifest it builds
 * them against. */
function proposalsFor(root) {
  const manifestResult = readManifestResult(root);
  assert.notEqual(manifestResult.state, 'corrupt');
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

/**
 * Leaves `root` as an `apply --yes` killed at `point` leaves it:
 * `before-settings`, after the manifest that records the staged patches is
 * on disk and before the settings file is replaced; `after-settings`, after
 * the settings file is replaced and before the manifest is written again.
 */
function killApplyAt(root, point) {
  const { manifest, proposals } = proposalsFor(root);
  assert.ok(proposals.some(p => p.kind !== 'file'), 'fixture: the run patches the settings file');
  const manifestPath = join(root, MANIFEST_PATH);
  let onDiskAtKill = null;
  const result = applyProposals({
    root, proposals, manifest, kitVersion: KIT_VERSION,
    persistManifest: staged => writeManifest(root, staged),
    replaceSettings: (path, text) => {
      if (point === 'before-settings') {
        onDiskAtKill = readFileSync(manifestPath);
        throw new Error(KILLED);
      }
      replaceFile(path, text);
    },
  });
  if (point === 'before-settings') {
    assert.deepEqual(result.failed.map(f => f.error), [`failed to write ${SETTINGS_PATH}: ${KILLED}`]);
    // The process is gone at the throw: the manifest is as it was then.
    writeFileSync(manifestPath, onDiskAtKill);
  } else {
    assert.deepEqual(result.failed, []);
  }
}

const copies = [];
after(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
});
/** A copy of the repository `d`, so two recoveries start from one state. */
function copyOf(d) {
  const copy = mkdtempSync(join(tmpdir(), 'hk-kill-copy-'));
  copies.push(copy);
  cpSync(d, copy, { recursive: true });
  return copy;
}

const kitScriptsOnDisk = d => (existsSync(join(d, '.claude/scripts')) ? readdirSync(join(d, '.claude/scripts')) : []);
const kitEntries = d => Object.values(settings(d).hooks ?? {}).flat().flatMap(m => m.hooks ?? []).map(h => h.args?.[0] ?? h.command).filter(s => s.includes('.claude/scripts/'));
const kitDenyRules = d => (settings(d).permissions?.deny ?? []).filter(rule => rule.includes('kh-harness') || rule.includes('learn.mjs') || rule.includes('log.mjs') || rule.includes('.claude/scripts'));

/** `uninstall --yes` on the killed state takes out everything the kit put
 * in the repository, and leaves no record. */
function assertUninstallRecovers(d) {
  const result = runResult(UNINSTALL, d, '--yes');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(kitScriptsOnDisk(d), [], 'no kit script is left');
  assert.deepEqual(kitEntries(d), [], 'no kit hook entry is left registered');
  assert.deepEqual(kitDenyRules(d), [], 'no kit deny rule is left');
  assert.equal(existsSync(join(d, MANIFEST_PATH)), false, 'the manifest is removed');
  assert.deepEqual(settings(d).permissions?.deny, ['Edit(secrets/**)'], "the owner's own rule is as it was");
}

/** `apply --yes` on the killed state completes the install: nothing is left
 * for it to propose, every registered hook runs, and `uninstall` then
 * removes all of it. */
function assertApplyRecovers(d) {
  const applied = runResult(APPLY, d, '--yes', '--allow-dirty');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const checks = JSON.parse(run(DETECT, d, '--json')).checks;
  assert.deepEqual(checks.filter(c => c.proposal && c.id in GENERATORS).map(c => c.id), [], 'nothing is left to propose');
  assert.match(run(APPLY, d), /no actions/);
  assert.ok(kitEntries(d).length > 0, 'the hooks are registered');
  for (const h of runEveryRegisteredHook(d)) assert.notEqual(h.status, 1, `${h.script} on ${h.event}: ${h.stderr}`);
  assertUninstallRecovers(d);
}

/** A repository holding a committed install by the 0.1.0 kit. */
function installedAt010() {
  const d = fixture();
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest', lint: 'node -e 0' } }));
  writeFileSync(join(d, 'index.js'), 'export const ok = true;\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a lint script');
  run(old.apply, d, '--yes');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'install kh-harness 0.1.0');
  return d;
}

for (const point of ['before-settings', 'after-settings']) {
  test(`a first install killed ${point} is one uninstall removes and apply completes`, () => {
    const d = fixture();
    killApplyAt(d, point);
    assert.ok(kitScriptsOnDisk(d).length > 0, 'fixture: the kill left kit scripts on disk');
    assert.equal(kitEntries(d).length > 0, point === 'after-settings', 'fixture: the settings file is replaced only after the kill point');
    assertApplyRecovers(copyOf(d));
    assertUninstallRecovers(d);
  });

  test(`an upgrade from 0.1.0 killed ${point} is one uninstall removes and apply completes`, { skip: skipUpgrade }, () => {
    const d = installedAt010();
    const before = kitEntries(d).length;
    assert.ok(before > 0, 'fixture: the 0.1.0 kit registered hooks');
    killApplyAt(d, point);
    assert.equal(kitEntries(d).length > before, point === 'after-settings', 'fixture: the new entries are in the file only after the kill point');
    assertApplyRecovers(copyOf(d));
    assertUninstallRecovers(d);
  });
}

// --- The contract file and the files it speaks for --------------------------
//
// A kill is a process that is gone: from the write it dies at on, no file
// is written or removed. `fs` is patched where the libraries call it.

const CONTRACT_FILE = '.claude/kh-harness/contract.json';
const ENTRY = '.claude/scripts/dispatch-pre-tool.mjs';

/** Kills the run at the first write `dies(path)` answers true for: before
 * it when `at` is true, just after it otherwise. Every write after the kill
 * throws, and so must the caller's settings and manifest writes. */
function killWritesAt(t, dies, at) {
  const write = fs.writeFileSync;
  let dead = false;
  const restore = () => { fs.writeFileSync = write; syncBuiltinESMExports(); };
  t.after(restore);
  fs.writeFileSync = (path, ...rest) => {
    if (dead || (at && dies(String(path)))) {
      dead = true;
      throw new Error(KILLED);
    }
    const written = write(path, ...rest);
    if (dies(String(path))) dead = true;
    return written;
  };
  syncBuiltinESMExports();
  return { isDead: () => dead, restore };
}

/** An install by this kit made before the contract file existed, whose
 * entry script another kit version wrote. */
function installedBeforeContract() {
  const d = fixture();
  run(APPLY, d, '--yes');
  const m = readManifestResult(d).manifest;
  rmSync(join(d, CONTRACT_FILE));
  m.files = m.files.filter(f => f.path !== CONTRACT_FILE);
  const older = installedScriptProposal(ENTRY, '0.1.9').contents;
  writeFileSync(join(d, ENTRY), older);
  m.files.find(f => f.path === ENTRY).sha256 = sha256(older);
  writeManifest(d, m);
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'an install before the contract file');
  return d;
}

/** True when every file the contract speaks for holds what this kit
 * installs there. */
const contractFilesCurrent = d => CONTRACT_FILES.every(path => installedScriptStatus(d, path, KIT_VERSION) === 'current');

for (const [point, dies, at] of [
  ['at the entry script\'s update', path => path.endsWith(join('.claude', 'scripts', 'dispatch-pre-tool.mjs')), true],
  ['at the contract file\'s write', path => path.endsWith(join('.claude', 'kh-harness', 'contract.json')), true],
  ['just after the contract file\'s write', path => path.endsWith(join('.claude', 'kh-harness', 'contract.json')), false],
]) {
  test(`an update killed ${point} never leaves the contract file beside an entry script that is not this kit's, and apply completes it`, (t) => {
    const d = installedBeforeContract();
    assert.equal(installedScriptStatus(d, ENTRY, KIT_VERSION), 'other-version', 'fixture: the entry script is another kit version\'s');
    const { manifest, proposals } = proposalsFor(d);
    assert.ok(proposals.some(p => p.path === CONTRACT_FILE) && proposals.some(p => p.path === ENTRY), 'fixture: the run writes both');
    assert.ok(proposals.findIndex(p => p.path === CONTRACT_FILE) < proposals.findIndex(p => p.path === ENTRY), 'fixture: the contract file is proposed first');
    const manifestPath = join(d, MANIFEST_PATH);
    const onDisk = readFileSync(manifestPath);
    const kill = killWritesAt(t, dies, at);
    applyProposals({ root: d, proposals, manifest, kitVersion: KIT_VERSION, persistManifest: () => { throw new Error(KILLED); }, replaceSettings: () => { throw new Error(KILLED); } });
    kill.restore();
    assert.ok(kill.isDead(), 'fixture: the run was killed');
    writeFileSync(manifestPath, onDisk);

    const contractOnDisk = existsSync(join(d, CONTRACT_FILE));
    assert.equal(contractOnDisk, point === 'just after the contract file\'s write');
    if (contractOnDisk) assert.ok(contractFilesCurrent(d), 'the contract file is on disk only beside the files it speaks for');
    else assert.equal(installedScriptStatus(d, ENTRY, KIT_VERSION), point === 'at the entry script\'s update' ? 'other-version' : 'current');

    const applied = runResult(APPLY, d, '--yes', '--allow-dirty');
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.equal(readFileSync(join(d, CONTRACT_FILE), 'utf8'), kitContractText(KIT_VERSION));
    assert.ok(contractFilesCurrent(d));
    assert.ok(readManifestResult(d).manifest.files.some(f => f.path === CONTRACT_FILE), 'the contract file is recorded, so uninstall removes it');
    assert.equal(uninstallOrder(t, d)[0], CONTRACT_FILE);
    assert.equal(existsSync(join(d, CONTRACT_FILE)), false);
  });
}

test('an update that is not killed ends with the contract file beside the entry script this kit installs', () => {
  const d = installedBeforeContract();
  const applied = runResult(APPLY, d, '--yes', '--allow-dirty');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.ok(applied.stdout.trimEnd().split('\n').filter(l => l.startsWith('wrote')).at(-1).endsWith(CONTRACT_FILE), applied.stdout);
  assert.equal(readFileSync(join(d, CONTRACT_FILE), 'utf8'), kitContractText(KIT_VERSION));
  assert.ok(contractFilesCurrent(d));
});

/** The repository paths an uninstall of `d` removes, in the order it
 * removes them. */
function uninstallOrder(t, d) {
  const rm = fs.rmSync;
  const order = [];
  const restore = () => { fs.rmSync = rm; syncBuiltinESMExports(); };
  t.after(restore);
  fs.rmSync = (path, ...rest) => {
    order.push(String(path).slice(d.length + 1).split('\\').join('/'));
    return rm(path, ...rest);
  };
  syncBuiltinESMExports();
  const manifest = readManifestResult(d).manifest;
  runUninstall({ root: d, manifest, plan: planUninstall({ root: d, manifest }) });
  restore();
  return order;
}

test('uninstall removes the contract file before any script, so a kill midway never leaves it beside a missing one', (t) => {
  const d = fixture();
  run(APPLY, d, '--yes');
  const rm = fs.rmSync;
  const order = [];
  let dead = false;
  t.after(() => { fs.rmSync = rm; syncBuiltinESMExports(); });
  fs.rmSync = (path, ...rest) => {
    const rel = String(path).slice(d.length + 1).split('\\').join('/');
    if (!dead && rel.startsWith('.claude/scripts/')) dead = true;
    order.push(rel);
    if (dead) throw new Error(KILLED);
    return rm(path, ...rest);
  };
  syncBuiltinESMExports();
  const manifest = readManifestResult(d).manifest;
  runUninstall({ root: d, manifest, plan: planUninstall({ root: d, manifest }) });
  fs.rmSync = rm;
  syncBuiltinESMExports();
  assert.equal(order[0], CONTRACT_FILE);
  assert.equal(existsSync(join(d, CONTRACT_FILE)), false);
  assert.ok(existsSync(join(d, ENTRY)), 'the kill left the scripts');
});
